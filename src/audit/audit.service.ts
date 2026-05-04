import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';

export type AuditEventType =
  | 'DEVICE_REGISTERED'
  | 'DEVICE_REVOKED'
  | 'TOKEN_ISSUED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'ONLINE_PAYMENT_SUBMITTED'
  | 'ONLINE_PAYMENT_SETTLED'
  | 'ONLINE_PAYMENT_REJECTED'
  | 'OFFLINE_SYNC_RECEIVED'
  | 'OFFLINE_SETTLED'
  | 'OFFLINE_REJECTED'
  | 'DOUBLE_SPEND_DETECTED'
  | 'FRAUD_REVIEW_TRIGGERED'
  | 'FRAUD_BLOCK';

export interface AuditEventPayload {
  eventType: AuditEventType;
  userId?: string;
  deviceId?: string;
  transactionId?: string;
  tokenId?: string;
  payload?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(event: AuditEventPayload): Promise<void> {
    try {
      await this.prisma.offlineAuditEvent.create({
        data: {
          auditEventId: uuidv4(),
          eventType: event.eventType,
          userId: event.userId,
          deviceId: event.deviceId,
          transactionId: event.transactionId,
          tokenId: event.tokenId,
          payload: event.payload as any,
        },
      });
    } catch (err) {
      // Audit must never crash the main flow
      this.logger.error(`Failed to write audit event type=${event.eventType}: ${err}`);
    }
  }
}
