import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { OFFLINE_TXN_QUEUE, SETTLE_OFFLINE_TRANSACTION } from './constants';
import { FraudService, FraudDecision } from '../fraud/fraud.service';
import { ILedgerService, LEDGER_SERVICE } from '../ledger/ledger.interface';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettlementService } from '../settlement/settlement.service';

export interface OfflineSettlementJobData {
  syncBatchId: string;
  transactionId: string;
  paymentRequest: string;
  paymentOffer: string;
  paymentReceipt: string;
  transportType: string;
  createdAtDevice: string;
  spentTokenIds: string[];
  senderUserId: string;
  receiverUserId: string;
  senderDeviceId: string;
  receiverDeviceId: string;
  amountMinor: number;
  currency: string;
  phoneNumber: string;
}

@Processor(OFFLINE_TXN_QUEUE)
export class OfflineTransactionProcessor extends WorkerHost {
  private readonly logger = new Logger(OfflineTransactionProcessor.name);

  constructor(
    private readonly settlement: SettlementService,
    private readonly fraud: FraudService,
    @Inject(LEDGER_SERVICE) private readonly ledger: ILedgerService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<OfflineSettlementJobData>): Promise<void> {
    if (job.name !== SETTLE_OFFLINE_TRANSACTION) return;

    const data = job.data;
    this.logger.log(`Processing offline settlement txn=${data.transactionId}`);

    // --- Layer 4: Cryptographic + token validation (22-step chain) ---
    const validationResult = await this.settlement.validate(data);

    if (!validationResult.valid) {
      await this.prisma.offlineTransaction.update({
        where: { transactionId: data.transactionId },
        data: {
          status: validationResult.rejectionStatus,
          rejectionReason: validationResult.rejectionReason,
        },
      });
      await this.audit.record({
        eventType: 'OFFLINE_REJECTED',
        userId: data.senderUserId,
        transactionId: data.transactionId,
        payload: { reason: validationResult.rejectionReason, status: validationResult.rejectionStatus },
      });
      this.logger.warn(
        `Offline txn rejected txn=${data.transactionId} reason=${validationResult.rejectionStatus}`,
      );
      return;
    }

    // --- Layer 3: Fraud detection ---
    const fraudResult = await this.fraud.score({
      txId: data.transactionId,
      senderUserId: data.senderUserId,
      receiverUserId: data.receiverUserId,
      amountMinor: data.amountMinor,
      currency: data.currency,
      transactionType: `OFFLINE_${data.transportType}`,
      deviceType: 'ANDROID',
      networkType: 'OFFLINE',
      phoneNumber: data.phoneNumber,
      senderBank: 'TRUSTIPAY',
    });

    if (fraudResult.action === FraudDecision.BLOCK) {
      await this.prisma.offlineTransaction.update({
        where: { transactionId: data.transactionId },
        data: { status: 'REJECTED_FRAUD_BLOCK', rejectionReason: 'FRAUD_BLOCK' },
      });
      await this.audit.record({
        eventType: 'FRAUD_BLOCK',
        userId: data.senderUserId,
        transactionId: data.transactionId,
        payload: { score: fraudResult.score, caseId: fraudResult.caseId },
      });
      return;
    }

    if (fraudResult.action === FraudDecision.REVIEW) {
      // Offline transactions go to admin review — do not block synchronously
      await this.prisma.offlineTransaction.update({
        where: { transactionId: data.transactionId },
        data: { status: 'FRAUD_REVIEW' },
      });
      await this.audit.record({
        eventType: 'FRAUD_REVIEW_TRIGGERED',
        userId: data.senderUserId,
        transactionId: data.transactionId,
        payload: { score: fraudResult.score, caseId: fraudResult.caseId },
      });
      this.logger.log(`Offline txn in FRAUD_REVIEW txn=${data.transactionId}`);
      return;
    }

    // --- Atomic settlement (double-spend locked) ---
    await this.settlement.settle(data);

    await this.audit.record({
      eventType: 'OFFLINE_SETTLED',
      userId: data.senderUserId,
      transactionId: data.transactionId,
      payload: { amountMinor: data.amountMinor, receiverUserId: data.receiverUserId, transport: data.transportType },
    });

    this.logger.log(`Offline txn SETTLED txn=${data.transactionId}`);
  }
}
