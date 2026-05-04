import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TokenSignerService } from './token-signer.service';
import { TokenRequestDto, VALID_DENOMINATIONS } from './dto/token-request.dto';
import { UserContext } from '../common/decorators/user-context.decorator';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly signer: TokenSignerService,
    private readonly config: ConfigService,
  ) {}

  async requestTokens(dto: TokenRequestDto, user: UserContext) {
    // --- Feature flag check ---
    const offlineEnabled = this.config.get<string>('OFFLINE_PAYMENTS_ENABLED', 'false') === 'true';
    if (!offlineEnabled) {
      throw new ForbiddenException({ errorCode: 'OFFLINE_DISABLED', message: 'Offline payments are not enabled.', retryable: false });
    }

    // --- Risk limit checks ---
    await this.assertRiskLimits(dto, user);

    // --- Build denominations ---
    const denominations = this.buildDenominations(dto.requestedAmountMinor, dto.preferredDenominations);
    const totalMinor = denominations.reduce((a, b) => a + b, 0);

    const expiryDays = this.config.get<number>('OFFLINE_TOKEN_EXPIRY_DAYS', 7);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + expiryDays * 86400_000);

    // --- Sign and persist each token ---
    const tokens: object[] = [];

    for (const denom of denominations) {
      const tokenId = `tok_${uuidv4().replace(/-/g, '')}`;
      const nonce = crypto.randomBytes(32).toString('base64url');

      const payload = {
        tokenId,
        ownerUserId: user.userId,
        ownerDeviceId: dto.deviceId,
        amountMinor: denom,
        currency: dto.currency,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        issuerKeyId: this.signer.keyId,
        nonce,
        protocolVersion: '1.0',
      };

      const signed = this.signer.sign(payload);

      await this.prisma.offlineToken.create({
        data: {
          tokenId,
          ownerUserId: user.userId,
          ownerDeviceId: dto.deviceId,
          amountMinor: BigInt(denom),
          currency: dto.currency,
          status: 'ISSUED',
          issuedAt,
          expiresAt,
          serverKeyId: this.signer.keyId,
          tokenPayloadCanonical: signed.canonicalBytes as any,
          serverSignature: signed.serverSignature,
        },
      });

      await this.audit.record({
        eventType: 'TOKEN_ISSUED',
        userId: user.userId,
        deviceId: dto.deviceId,
        tokenId,
        payload: { amountMinor: denom, expiresAt: expiresAt.toISOString() },
      });

      tokens.push({
        tokenId,
        amountMinor: denom,
        currency: dto.currency,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        serverKeyId: this.signer.keyId,
        serverSignature: signed.serverSignature,
        nonce,
        protocolVersion: '1.0',
      });
    }

    this.logger.log(`Issued ${tokens.length} tokens totalMinor=${totalMinor} userId=${user.userId}`);

    return {
      reservedAmountMinor: totalMinor,
      expiresAt: expiresAt.toISOString(),
      tokens,
    };
  }

  async getServerKeys() {
    const keys = await this.prisma.serverSigningKey.findMany({
      where: { status: 'ACTIVE' },
    });

    // Also expose the ephemeral signer key from TokenSignerService if no DB keys
    const signerKey = {
      serverKeyId: this.signer.keyId,
      algorithm: this.signer.algorithm,
      publicKey: this.signer.getPublicKeyBase64(),
      status: 'ACTIVE',
    };

    return { keys: keys.length > 0 ? keys : [signerKey], serverTime: new Date().toISOString() };
  }

  private async assertRiskLimits(dto: TokenRequestDto, user: UserContext) {
    const maxWallet = this.config.get<number>('OFFLINE_MAX_WALLET_MINOR', 500000);
    const maxTxn = this.config.get<number>('OFFLINE_MAX_TXN_MINOR', 100000);
    const requiredSyncHours = this.config.get<number>('OFFLINE_REQUIRED_SYNC_HOURS', 48);

    if (dto.requestedAmountMinor > maxTxn) {
      throw new BadRequestException({
        errorCode: 'TOKEN_ISSUANCE_LIMIT_EXCEEDED',
        message: `Requested amount exceeds max single request limit of ${maxTxn} minor units.`,
        retryable: false,
      });
    }

    // Verify device is ACTIVE
    const activeKey = await this.prisma.deviceKey.findFirst({
      where: { userId: user.userId, deviceId: dto.deviceId, status: 'ACTIVE' },
    });
    if (!activeKey) {
      throw new BadRequestException({
        errorCode: 'DEVICE_NOT_REGISTERED',
        message: 'Device is not registered or not active.',
        retryable: false,
      });
    }

    // Check total ISSUED tokens don't exceed offline wallet cap
    const issuedTokens = await this.prisma.offlineToken.aggregate({
      where: { ownerUserId: user.userId, status: 'ISSUED' },
      _sum: { amountMinor: true },
    });
    const currentReserved = Number(issuedTokens._sum.amountMinor ?? 0);
    if (currentReserved + dto.requestedAmountMinor > maxWallet) {
      throw new BadRequestException({
        errorCode: 'TOKEN_ISSUANCE_LIMIT_EXCEEDED',
        message: `Offline wallet limit of ${maxWallet} minor units would be exceeded.`,
        retryable: false,
      });
    }

    // Check no unresolved double-spend disputes
    const disputes = await this.prisma.offlineTransaction.count({
      where: { senderUserId: user.userId, status: 'DISPUTED' },
    });
    if (disputes > 0) {
      throw new ForbiddenException({
        errorCode: 'UNRESOLVED_DISPUTE',
        message: 'Account has unresolved offline transaction disputes. Offline token issuance is suspended.',
        retryable: false,
      });
    }
  }

  /** Splits requested amount into valid denominations, largest first */
  private buildDenominations(requestedMinor: number, preferred?: number[]): number[] {
    const denominations = [...VALID_DENOMINATIONS].sort((a, b) => b - a);
    const result: number[] = [];
    let remaining = requestedMinor;

    for (const denom of denominations) {
      while (remaining >= denom) {
        result.push(denom);
        remaining -= denom;
      }
    }

    // If there's remainder, round up to smallest denomination or discard
    if (remaining > 0 && denominations.length > 0) {
      const smallest = denominations[denominations.length - 1];
      result.push(smallest);
    }

    return result;
  }
}
