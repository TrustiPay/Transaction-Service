import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { FraudScoreRequest, FraudScoreResponse, ScoreParams } from './fraud.dto';

export enum FraudDecision {
  ALLOW = 'ALLOW',
  REVIEW = 'REVIEW',
  BLOCK = 'BLOCK',
}

export interface FraudResult {
  action: FraudDecision;
  score: number;
  caseId?: number;
  reason?: string;
}

@Injectable()
export class FraudService {
  private readonly logger = new Logger(FraudService.name);
  private readonly fraudUrl: string;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.fraudUrl = this.config.get<string>('FRAUD_DETECTION_URL', 'http://localhost:8000');
  }

  async score(params: ScoreParams): Promise<FraudResult> {
    const body = this.mapToFraudRequest(params);

    try {
      const response = await firstValueFrom(
        this.http.post<FraudScoreResponse>(`${this.fraudUrl}/score`, body, {
          timeout: 10_000,
        }),
      );

      const data = response.data;
      const action = this.parseDecision(data.action);

      this.logger.log(
        `Fraud score txn=${params.txId} action=${action} score=${data.score.toFixed(4)}`,
      );

      return { action, score: data.score, caseId: data.case_id, reason: data.reason };
    } catch (err: any) {
      // If fraud service is unreachable, fail open with ALLOW and log prominently.
      // In production this should page on-call — for now we log and allow.
      this.logger.error(
        `Fraud service unreachable for txn=${params.txId}: ${err?.message ?? err}. Failing open with ALLOW.`,
      );
      return { action: FraudDecision.ALLOW, score: 0, reason: 'FRAUD_SERVICE_UNAVAILABLE' };
    }
  }

  /** Maps internal ScoreParams to the fraud API's expected Transaction schema */
  private mapToFraudRequest(params: ScoreParams): FraudScoreRequest {
    const amountMajor = params.amountMinor / 100;
    return {
      tx_id: params.txId,
      sender_id: params.senderUserId,
      receiver_id: params.receiverUserId,
      timestamp: new Date().toISOString(),
      amount: amountMajor,
      transaction_type: params.transactionType,
      // Balance fields unknown until ledger exists — defaults to 0
      oldbal_sender: 0,
      newbal_sender: -amountMajor,
      oldbal_receiver: 0,
      newbal_receiver: amountMajor,
      sender_bank: params.senderBank ?? 'TRUSTIPAY',
      receiver_bank: 'TRUSTIPAY',
      sender_home_province: 'UNKNOWN',
      device_type: params.deviceType ?? 'UNKNOWN',
      network_type: params.networkType ?? 'UNKNOWN',
      phone_number: params.phoneNumber ?? '',
      location_changed: params.locationChanged ? 1 : 0,
      device_changed: params.deviceChanged ? 1 : 0,
      new_device_flag: params.newDevice ? 1 : 0,
      is_merchant_receiver: params.isMerchantReceiver ? 1 : 0,
    };
  }

  private parseDecision(raw: string): FraudDecision {
    const upper = (raw ?? '').toUpperCase();
    if (upper === FraudDecision.BLOCK) return FraudDecision.BLOCK;
    if (upper === FraudDecision.REVIEW) return FraudDecision.REVIEW;
    return FraudDecision.ALLOW;
  }
}
