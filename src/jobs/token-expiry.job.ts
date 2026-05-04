import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ILedgerService, LEDGER_SERVICE } from '../ledger/ledger.interface';

@Injectable()
export class TokenExpiryJob {
  private readonly logger = new Logger(TokenExpiryJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(LEDGER_SERVICE) private readonly ledger: ILedgerService,
  ) {}

  /** Runs every hour — finds ISSUED tokens past expiresAt and releases reserved balance */
  @Cron(CronExpression.EVERY_HOUR)
  async expireUnusedTokens() {
    const expiredTokens = await this.prisma.offlineToken.findMany({
      where: {
        status: 'ISSUED',
        expiresAt: { lt: new Date() },
      },
      take: 500, // Process in batches to avoid memory pressure
    });

    if (expiredTokens.length === 0) return;

    this.logger.log(`Expiring ${expiredTokens.length} unused offline tokens`);

    for (const token of expiredTokens) {
      await this.prisma.offlineToken.update({
        where: { tokenId: token.tokenId },
        data: { status: 'EXPIRED' },
      });

      await this.ledger.releaseExpiredReservation({
        userId: token.ownerUserId,
        amountMinor: token.amountMinor,
        tokenIds: [token.tokenId],
      });

      await this.audit.record({
        eventType: 'TOKEN_EXPIRED',
        userId: token.ownerUserId,
        deviceId: token.ownerDeviceId,
        tokenId: token.tokenId,
        payload: { amountMinor: Number(token.amountMinor), expiresAt: token.expiresAt.toISOString() },
      });
    }

    this.logger.log(`Token expiry complete — expired ${expiredTokens.length} tokens`);
  }

  /** Runs daily at 2am — removes old idempotency records */
  @Cron('0 2 * * *')
  async cleanupIdempotencyKeys() {
    const result = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (result.count > 0) {
      this.logger.log(`Idempotency cleanup: deleted ${result.count} expired keys`);
    }
  }
}
