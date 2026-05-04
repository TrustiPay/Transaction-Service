import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { ONLINE_TXN_QUEUE, PROCESS_ONLINE_PAYMENT } from './constants';
import { FraudService, FraudDecision } from '../fraud/fraud.service';
import { ILedgerService, LEDGER_SERVICE } from '../ledger/ledger.interface';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

export interface OnlinePaymentJobData {
  transactionId: string;
  senderUserId: string;
  receiverUserId: string;
  senderDeviceId: string;
  amountMinor: number;
  currency: string;
  deviceType: string;
  networkType: string;
  phoneNumber: string;
  senderBank: string;
  idempotencyKey: string;
}

@Processor(ONLINE_TXN_QUEUE)
export class OnlineTransactionProcessor extends WorkerHost {
  private readonly logger = new Logger(OnlineTransactionProcessor.name);

  constructor(
    private readonly fraud: FraudService,
    @Inject(LEDGER_SERVICE) private readonly ledger: ILedgerService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<OnlinePaymentJobData>): Promise<void> {
    if (job.name !== PROCESS_ONLINE_PAYMENT) return;

    const data = job.data;
    this.logger.log(`Processing online payment txn=${data.transactionId}`);

    await this.prisma.onlineTransaction.update({
      where: { id: data.transactionId },
      data: { status: 'PROCESSING' },
    });

    // --- Layer 3: Fraud detection ---
    const fraudResult = await this.fraud.score({
      txId: data.transactionId,
      senderUserId: data.senderUserId,
      receiverUserId: data.receiverUserId,
      amountMinor: data.amountMinor,
      currency: data.currency,
      transactionType: 'ONLINE',
      deviceType: data.deviceType,
      networkType: data.networkType,
      phoneNumber: data.phoneNumber,
      senderBank: data.senderBank,
    });

    if (fraudResult.action === FraudDecision.BLOCK) {
      await this.prisma.onlineTransaction.update({
        where: { id: data.transactionId },
        data: {
          status: 'REJECTED_FRAUD_BLOCK',
          fraudDecision: 'BLOCK',
          fraudCaseId: String(fraudResult.caseId ?? ''),
          rejectionReason: `Fraud detection blocked: ${fraudResult.reason ?? 'HIGH_RISK'}`,
        },
      });
      await this.audit.record({
        eventType: 'FRAUD_BLOCK',
        userId: data.senderUserId,
        transactionId: data.transactionId,
        payload: { score: fraudResult.score, caseId: fraudResult.caseId },
      });
      this.logger.warn(`Online payment BLOCKED by fraud txn=${data.transactionId}`);
      return;
    }

    if (fraudResult.action === FraudDecision.REVIEW) {
      await this.prisma.onlineTransaction.update({
        where: { id: data.transactionId },
        data: {
          status: 'FRAUD_REVIEW',
          fraudDecision: 'REVIEW',
          fraudCaseId: String(fraudResult.caseId ?? ''),
        },
      });
      await this.audit.record({
        eventType: 'FRAUD_REVIEW_TRIGGERED',
        userId: data.senderUserId,
        transactionId: data.transactionId,
        payload: { score: fraudResult.score, caseId: fraudResult.caseId },
      });
      // OTP polling handled by SettlementStatusPoller (future) or admin resolves case
      this.logger.log(`Online payment in FRAUD_REVIEW txn=${data.transactionId} caseId=${fraudResult.caseId}`);
      return;
    }

    // --- FraudDecision.ALLOW — proceed to ledger ---
    await this.ledger.debitOnlinePayment({
      senderUserId: data.senderUserId,
      amountMinor: BigInt(data.amountMinor),
      transactionId: data.transactionId,
      currency: data.currency,
    });
    await this.ledger.creditOnlinePayment({
      receiverUserId: data.receiverUserId,
      amountMinor: BigInt(data.amountMinor),
      transactionId: data.transactionId,
      currency: data.currency,
    });

    await this.prisma.onlineTransaction.update({
      where: { id: data.transactionId },
      data: {
        status: 'SETTLED',
        fraudDecision: 'ALLOW',
        settledAt: new Date(),
      },
    });

    await this.audit.record({
      eventType: 'ONLINE_PAYMENT_SETTLED',
      userId: data.senderUserId,
      transactionId: data.transactionId,
      payload: { amountMinor: data.amountMinor, receiverUserId: data.receiverUserId },
    });

    this.logger.log(`Online payment SETTLED txn=${data.transactionId}`);
  }
}
