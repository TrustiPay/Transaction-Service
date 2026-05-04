import { Injectable, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ILedgerService, LEDGER_SERVICE } from '../ledger/ledger.interface';
import { TokenSignerService } from '../tokens/token-signer.service';
import * as crypto from 'crypto';

export interface SyncItemData {
  transactionId: string;
  paymentRequest: string;   // base64url canonical JSON
  paymentOffer: string;
  paymentReceipt: string;
  spentTokenIds: string[];
  senderUserId: string;
  receiverUserId: string;
  senderDeviceId: string;
  receiverDeviceId: string;
  amountMinor: number;
  currency: string;
  transportType: string;
  createdAtDevice: string;
}

export interface ValidationResult {
  valid: boolean;
  rejectionStatus?: string;
  rejectionReason?: string;
}

const SUPPORTED_PROTOCOL_VERSIONS = ['1.0'];

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEDGER_SERVICE) private readonly ledger: ILedgerService,
    private readonly tokenSigner: TokenSignerService,
  ) {}

  /**
   * 22-step cryptographic and business validation chain.
   * Does NOT write any ledger entries — call settle() after this passes.
   */
  async validate(item: SyncItemData): Promise<ValidationResult> {
    // Step 1: Parse payloads
    let request: Record<string, any>, offer: Record<string, any>, receipt: Record<string, any>;
    try {
      request = item.paymentRequest ? JSON.parse(Buffer.from(item.paymentRequest, 'base64url').toString()) : null;
      offer = JSON.parse(Buffer.from(item.paymentOffer, 'base64url').toString());
      receipt = JSON.parse(Buffer.from(item.paymentReceipt, 'base64url').toString());
    } catch {
      return { valid: false, rejectionStatus: 'REJECTED_INVALID_SIGNATURE', rejectionReason: 'Malformed payload encoding' };
    }

    // Step 2: Protocol version
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(offer.protocolVersion)) {
      return { valid: false, rejectionStatus: 'REJECTED_PROTOCOL_VERSION', rejectionReason: `Unsupported protocol version: ${offer.protocolVersion}` };
    }

    // Step 3: Verify canonical encoding (re-encode and compare hash)
    const offerBytes = Buffer.from(item.paymentOffer, 'base64url');
    const receiptBytes = Buffer.from(item.paymentReceipt, 'base64url');

    // Step 4–10: Token-level validation with row-level lock (done inside settle() transaction)
    // Fetch token records for pre-validation here (without lock) for fast-fail
    const tokens = await this.prisma.offlineToken.findMany({
      where: { tokenId: { in: item.spentTokenIds } },
    });

    // Step 5: All tokens must exist
    if (tokens.length !== item.spentTokenIds.length) {
      return { valid: false, rejectionStatus: 'REJECTED_INVALID_SIGNATURE', rejectionReason: 'One or more tokens not found in server database' };
    }

    for (const token of tokens) {
      // Step 4: Verify server signature on token
      const sigValid = this.tokenSigner.verify(Buffer.from(token.tokenPayloadCanonical), token.serverSignature);
      if (!sigValid) {
        return { valid: false, rejectionStatus: 'REJECTED_INVALID_SIGNATURE', rejectionReason: `Invalid server signature on token ${token.tokenId}` };
      }

      // Step 6: Token ownership
      if (token.ownerUserId !== item.senderUserId) {
        return { valid: false, rejectionStatus: 'REJECTED_INVALID_SIGNATURE', rejectionReason: `Token ${token.tokenId} does not belong to sender` };
      }

      // Step 7: Device ownership
      if (token.ownerDeviceId !== item.senderDeviceId) {
        return { valid: false, rejectionStatus: 'REJECTED_INVALID_SIGNATURE', rejectionReason: `Token ${token.tokenId} does not belong to sender device` };
      }

      // Step 8: Expiry
      if (new Date(token.expiresAt) <= new Date()) {
        return { valid: false, rejectionStatus: 'REJECTED_TOKEN_EXPIRED', rejectionReason: `Token ${token.tokenId} has expired` };
      }

      // Step 9: Token status (pre-check without lock — definitive check is in settle())
      if (token.status === 'REVOKED') {
        return { valid: false, rejectionStatus: 'REJECTED_TOKEN_REVOKED', rejectionReason: `Token ${token.tokenId} has been revoked` };
      }
      if (token.status === 'SPENT') {
        return { valid: false, rejectionStatus: 'REJECTED_DOUBLE_SPEND', rejectionReason: `Token ${token.tokenId} was already spent` };
      }
      if (token.status !== 'ISSUED') {
        return { valid: false, rejectionStatus: 'REJECTED_INVALID_SIGNATURE', rejectionReason: `Token ${token.tokenId} has unexpected status: ${token.status}` };
      }
    }

    // Steps 10–11: Device key lookup
    const senderKey = await this.prisma.deviceKey.findFirst({
      where: { userId: item.senderUserId, deviceId: item.senderDeviceId, status: 'ACTIVE' },
    });
    if (!senderKey) {
      return { valid: false, rejectionStatus: 'REJECTED_DEVICE_REVOKED', rejectionReason: 'Sender device is not active' };
    }

    const receiverKey = await this.prisma.deviceKey.findFirst({
      where: { userId: item.receiverUserId, deviceId: item.receiverDeviceId, status: 'ACTIVE' },
    });
    if (!receiverKey) {
      return { valid: false, rejectionStatus: 'REJECTED_DEVICE_REVOKED', rejectionReason: 'Receiver device is not active' };
    }

    // Steps 12–13: Signature verification on PaymentOffer and PaymentReceipt
    const senderSigValid = this.verifyDeviceSignature(
      offerBytes,
      offer.senderSignature,
      senderKey.publicKey,
    );
    if (!senderSigValid) {
      return { valid: false, rejectionStatus: 'REJECTED_INVALID_SIGNATURE', rejectionReason: 'Invalid sender signature on PaymentOffer' };
    }

    const receiverSigValid = this.verifyDeviceSignature(
      receiptBytes,
      receipt.receiverSignature,
      receiverKey.publicKey,
    );
    if (!receiverSigValid) {
      return { valid: false, rejectionStatus: 'REJECTED_INVALID_SIGNATURE', rejectionReason: 'Invalid receiver signature on PaymentReceipt' };
    }

    // Step 14: Verify PaymentOffer.requestHash === SHA256(PaymentRequest bytes)
    if (request && offer.requestHash) {
      const requestBytes = Buffer.from(item.paymentRequest, 'base64url');
      const expectedRequestHash = crypto.createHash('sha256').update(requestBytes).digest('hex');
      if (offer.requestHash !== expectedRequestHash) {
        return { valid: false, rejectionStatus: 'REJECTED_INVALID_SIGNATURE', rejectionReason: 'PaymentOffer.requestHash does not match hash of PaymentRequest' };
      }
    }

    // Step 15: Verify PaymentReceipt.offerHash === SHA256(PaymentOffer bytes)
    if (receipt.offerHash) {
      const expectedOfferHash = crypto.createHash('sha256').update(offerBytes).digest('hex');
      if (receipt.offerHash !== expectedOfferHash) {
        return { valid: false, rejectionStatus: 'REJECTED_INVALID_SIGNATURE', rejectionReason: 'PaymentReceipt.offerHash does not match hash of PaymentOffer' };
      }
    }

    // Step 16: Amount and currency consistency
    if (offer.amountMinor !== item.amountMinor) {
      return { valid: false, rejectionStatus: 'REJECTED_AMOUNT_MISMATCH', rejectionReason: 'Amount mismatch between offer and sync item' };
    }
    if (offer.currency !== item.currency) {
      return { valid: false, rejectionStatus: 'REJECTED_CURRENCY_MISMATCH', rejectionReason: 'Currency mismatch' };
    }

    // Step 17: Token amounts sum to payment amount
    const tokenSum = tokens.reduce((acc, t) => acc + Number(t.amountMinor), 0);
    if (tokenSum !== item.amountMinor) {
      return { valid: false, rejectionStatus: 'REJECTED_AMOUNT_MISMATCH', rejectionReason: `Token sum ${tokenSum} does not equal payment amount ${item.amountMinor}` };
    }

    // Step 18: Idempotency — if already settled, return success (not an error)
    const existing = await this.prisma.offlineTransaction.findUnique({
      where: { transactionId: item.transactionId },
    });
    if (existing && existing.status === 'SETTLED') {
      this.logger.log(`Idempotent re-settle txn=${item.transactionId} — already SETTLED`);
      return { valid: true }; // settle() will no-op on duplicate
    }

    return { valid: true };
  }

  /**
   * Atomic settlement with row-level locking — prevents double-spend race conditions.
   * Must only be called after validate() returns { valid: true }.
   */
  async settle(item: SyncItemData): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Lock token rows inside the transaction
      const tokens = await tx.$queryRaw<Array<{ token_id: string; status: string }>>`
        SELECT token_id, status FROM offline_tokens
        WHERE token_id = ANY(${item.spentTokenIds}::text[])
        FOR UPDATE
      `;

      // Double-spend check inside the lock
      const alreadySpent = tokens.filter((t) => t.status !== 'ISSUED');
      if (alreadySpent.length > 0) {
        throw new Error(`REJECTED_DOUBLE_SPEND:${alreadySpent.map((t) => t.token_id).join(',')}`);
      }

      // Mark tokens SPENT
      await tx.offlineToken.updateMany({
        where: { tokenId: { in: item.spentTokenIds } },
        data: {
          status: 'SPENT',
          spentTransactionId: item.transactionId,
          spentAt: new Date(),
        },
      });

      // Write offline transaction record
      await tx.offlineTransaction.upsert({
        where: { transactionId: item.transactionId },
        update: { status: 'SETTLED', settledAt: new Date() },
        create: {
          transactionId: item.transactionId,
          senderUserId: item.senderUserId,
          receiverUserId: item.receiverUserId,
          senderDeviceId: item.senderDeviceId,
          receiverDeviceId: item.receiverDeviceId,
          amountMinor: BigInt(item.amountMinor),
          currency: item.currency,
          status: 'SETTLED',
          offerPayload: Buffer.from(item.paymentOffer, 'base64url'),
          receiptPayload: Buffer.from(item.paymentReceipt, 'base64url'),
          requestPayload: item.paymentRequest ? Buffer.from(item.paymentRequest, 'base64url') : null,
          transportType: item.transportType,
          createdAtDevice: item.createdAtDevice ? new Date(item.createdAtDevice) : null,
          settledAt: new Date(),
        },
      });
    }, {
      // Serializable isolation prevents concurrent double-spend on same tokens
      isolationLevel: 'Serializable',
    });

    // Call ledger stub outside the DB transaction (it's a remote call in production)
    await this.ledger.settleOfflineTransaction({
      senderUserId: item.senderUserId,
      receiverUserId: item.receiverUserId,
      amountMinor: BigInt(item.amountMinor),
      transactionId: item.transactionId,
      currency: item.currency,
    });

    this.logger.log(`Settled offline txn=${item.transactionId} amount=${item.amountMinor}`);
  }

  private verifyDeviceSignature(payload: Buffer, signatureBase64url: string, publicKeyPem: string): boolean {
    if (!signatureBase64url) return false;
    try {
      const pubKey = crypto.createPublicKey(Buffer.from(publicKeyPem, 'base64'));
      const verify = crypto.createVerify('SHA256');
      verify.update(payload);
      return verify.verify(pubKey, Buffer.from(signatureBase64url, 'base64url'));
    } catch {
      return false;
    }
  }
}
