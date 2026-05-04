import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SyncRequestDto } from './dto/sync-request.dto';
import { UserContext } from '../common/decorators/user-context.decorator';
import { OFFLINE_TXN_QUEUE, SETTLE_OFFLINE_TRANSACTION } from '../queues/constants';
import { OfflineSettlementJobData } from '../queues/offline-transaction.processor';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectQueue(OFFLINE_TXN_QUEUE) private readonly offlineQueue: Queue,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async processBatch(dto: SyncRequestDto, user: UserContext) {
    const syncBatchId = uuidv4();
    const serverTime = new Date().toISOString();
    const syncCursor = `cursor_${Date.now()}`;

    // Pre-create offline transaction records so status is queryable immediately
    const enqueued: string[] = [];

    for (const pending of dto.pendingTransactions) {
      // Check if already processed (idempotent re-sync)
      const existing = await this.prisma.offlineTransaction.findUnique({
        where: { transactionId: pending.transactionId },
      });

      if (existing) {
        enqueued.push(pending.transactionId); // will be returned in settlementResults
        continue;
      }

      // Create placeholder record
      await this.prisma.offlineTransaction.create({
        data: {
          transactionId: pending.transactionId,
          senderUserId: pending.senderUserId,
          receiverUserId: pending.receiverUserId,
          senderDeviceId: pending.senderDeviceId,
          receiverDeviceId: pending.receiverDeviceId,
          amountMinor: BigInt(pending.amountMinor),
          currency: pending.currency,
          status: 'PENDING' as any,
          offerPayload: Buffer.from(pending.paymentOffer, 'base64url'),
          receiptPayload: Buffer.from(pending.paymentReceipt, 'base64url'),
          requestPayload: pending.paymentRequest ? Buffer.from(pending.paymentRequest, 'base64url') : null,
          transportType: pending.transportType ?? 'UNKNOWN',
          createdAtDevice: pending.createdAtDevice ? new Date(pending.createdAtDevice) : null,
        },
      });

      const jobData: OfflineSettlementJobData = {
        syncBatchId,
        transactionId: pending.transactionId,
        paymentRequest: pending.paymentRequest ?? '',
        paymentOffer: pending.paymentOffer,
        paymentReceipt: pending.paymentReceipt,
        transportType: pending.transportType ?? 'UNKNOWN',
        createdAtDevice: pending.createdAtDevice ?? new Date().toISOString(),
        spentTokenIds: pending.spentTokenIds,
        senderUserId: pending.senderUserId,
        receiverUserId: pending.receiverUserId,
        senderDeviceId: pending.senderDeviceId,
        receiverDeviceId: pending.receiverDeviceId,
        amountMinor: Number(pending.amountMinor),
        currency: pending.currency,
        phoneNumber: user.phoneNumber ?? '',
      };

      await this.offlineQueue.add(SETTLE_OFFLINE_TRANSACTION, jobData, {
        jobId: `offline-${pending.transactionId}`,
      });

      enqueued.push(pending.transactionId);
    }

    await this.audit.record({
      eventType: 'OFFLINE_SYNC_RECEIVED',
      userId: user.userId,
      deviceId: dto.deviceId,
      payload: { batchId: syncBatchId, count: dto.pendingTransactions.length },
    });

    this.logger.log(`Sync batch received batchId=${syncBatchId} count=${dto.pendingTransactions.length} userId=${user.userId}`);

    // Fetch revocations to return to app
    const revokedDevices = await this.prisma.deviceKey.findMany({
      where: { userId: user.userId, status: { in: ['REVOKED', 'LOST'] } },
      select: { deviceId: true },
    });

    const revokedTokenIds = await this.prisma.offlineToken.findMany({
      where: { ownerUserId: user.userId, status: { in: ['REVOKED'] } },
      select: { tokenId: true },
    });

    // Return accepted transaction IDs with PROCESSING status
    const settlementResults = enqueued.map((id) => ({
      transactionId: id,
      status: 'PROCESSING',
      acceptedAt: serverTime,
    }));

    return {
      serverTime,
      syncCursor,
      settlementResults,
      rejected: [],
      disputed: [],
      revokedTokenIds: revokedTokenIds.map((t) => t.tokenId),
      revokedDeviceIds: [...new Set(revokedDevices.map((d) => d.deviceId))],
      newOfflineTokens: [],
    };
  }

  async getSettlementStatus(transactionId: string, userId: string) {
    const txn = await this.prisma.offlineTransaction.findUnique({
      where: { transactionId },
    });

    if (!txn || txn.senderUserId !== userId && txn.receiverUserId !== userId) {
      return { transactionId, status: 'NOT_FOUND' };
    }

    return {
      transactionId,
      status: txn.status,
      settledAt: txn.settledAt?.toISOString(),
      rejectionReason: txn.rejectionReason,
    };
  }
}
