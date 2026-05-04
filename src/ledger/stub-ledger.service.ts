import { Injectable, Logger } from '@nestjs/common';
import {
  ILedgerService,
  DebitOnlinePaymentParams,
  CreditOnlinePaymentParams,
  ReserveOfflineBalanceParams,
  SettleOfflineTransactionParams,
  ReleaseExpiredReservationParams,
} from './ledger.interface';

/**
 * No-op ledger implementation. Logs every call so behavior is visible in dev.
 * Replace by changing the provider in LedgerModule once the central ledger service exists.
 */
@Injectable()
export class StubLedgerService implements ILedgerService {
  private readonly logger = new Logger(StubLedgerService.name);

  async debitOnlinePayment(params: DebitOnlinePaymentParams): Promise<void> {
    this.logger.log(
      `[STUB] DEBIT_ONLINE sender=${params.senderUserId} amount=${params.amountMinor} txn=${params.transactionId}`,
    );
  }

  async creditOnlinePayment(params: CreditOnlinePaymentParams): Promise<void> {
    this.logger.log(
      `[STUB] CREDIT_ONLINE receiver=${params.receiverUserId} amount=${params.amountMinor} txn=${params.transactionId}`,
    );
  }

  async reserveOfflineBalance(params: ReserveOfflineBalanceParams): Promise<void> {
    this.logger.log(
      `[STUB] RESERVE_OFFLINE user=${params.userId} amount=${params.amountMinor} tokens=[${params.tokenIds.join(',')}]`,
    );
  }

  async settleOfflineTransaction(params: SettleOfflineTransactionParams): Promise<void> {
    this.logger.log(
      `[STUB] SETTLE_OFFLINE sender=${params.senderUserId} receiver=${params.receiverUserId} amount=${params.amountMinor} txn=${params.transactionId}`,
    );
  }

  async releaseExpiredReservation(params: ReleaseExpiredReservationParams): Promise<void> {
    this.logger.log(
      `[STUB] RELEASE_EXPIRED user=${params.userId} amount=${params.amountMinor} tokens=[${params.tokenIds.join(',')}]`,
    );
  }
}
