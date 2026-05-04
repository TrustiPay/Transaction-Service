import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UserContext } from '../common/decorators/user-context.decorator';
import { ONLINE_TXN_QUEUE, PROCESS_ONLINE_PAYMENT } from '../queues/constants';
import { OnlinePaymentJobData } from '../queues/online-transaction.processor';

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectQueue(ONLINE_TXN_QUEUE) private readonly onlineQueue: Queue,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async submitPayment(dto: CreatePaymentDto, user: UserContext, idempotencyKey: string) {
    // --- Layer 2a: Timestamp freshness check ---
    const clientTime = new Date(dto.timestamp).getTime();
    const serverTime = Date.now();
    if (Math.abs(serverTime - clientTime) > MAX_TIMESTAMP_SKEW_MS) {
      throw new BadRequestException({
        errorCode: 'TIMESTAMP_SKEW',
        message: 'Request timestamp is too far from server time. Max skew is 5 minutes.',
        retryable: false,
      });
    }

    // --- Layer 2b: Device ID binding ---
    if (user.deviceId && dto.deviceId !== user.deviceId) {
      throw new BadRequestException({
        errorCode: 'DEVICE_ID_MISMATCH',
        message: 'deviceId in request body does not match authenticated device.',
        retryable: false,
      });
    }

    const transactionId = uuidv4();

    await this.prisma.onlineTransaction.create({
      data: {
        id: transactionId,
        senderUserId: user.userId,
        receiverUserId: dto.receiverUserId,
        senderDeviceId: dto.deviceId,
        amountMinor: BigInt(dto.amountMinor),
        currency: dto.currency,
        status: 'PENDING',
        requestHash: dto.requestHash,
        idempotencyKey,
      },
    });

    const jobData: OnlinePaymentJobData = {
      transactionId,
      senderUserId: user.userId,
      receiverUserId: dto.receiverUserId,
      senderDeviceId: dto.deviceId,
      amountMinor: dto.amountMinor,
      currency: dto.currency,
      deviceType: 'ANDROID',
      networkType: dto.networkType ?? 'UNKNOWN',
      phoneNumber: user.phoneNumber ?? '',
      senderBank: dto.senderBank ?? 'TRUSTIPAY',
      idempotencyKey,
    };

    await this.onlineQueue.add(PROCESS_ONLINE_PAYMENT, jobData, {
      jobId: `online-${transactionId}`,
    });

    await this.audit.record({
      eventType: 'ONLINE_PAYMENT_SUBMITTED',
      userId: user.userId,
      transactionId,
      payload: { amountMinor: dto.amountMinor, receiverUserId: dto.receiverUserId },
    });

    this.logger.log(`Enqueued online payment txn=${transactionId} sender=${user.userId}`);
    return { transactionId, status: 'PENDING' };
  }

  async getStatus(transactionId: string, userId: string) {
    const txn = await this.prisma.onlineTransaction.findUnique({
      where: { id: transactionId },
    });

    if (!txn || txn.senderUserId !== userId) {
      throw new NotFoundException({
        errorCode: 'TRANSACTION_NOT_FOUND',
        message: 'Transaction not found.',
        retryable: false,
      });
    }

    return {
      transactionId: txn.id,
      status: txn.status,
      amountMinor: Number(txn.amountMinor),
      currency: txn.currency,
      createdAt: txn.createdAt.toISOString(),
      settledAt: txn.settledAt?.toISOString(),
      rejectionReason: txn.rejectionReason,
      fraudDecision: txn.fraudDecision,
    };
  }
}
