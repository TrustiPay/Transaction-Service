export const LEDGER_SERVICE = Symbol('LEDGER_SERVICE');

export interface DebitOnlinePaymentParams {
  senderUserId: string;
  amountMinor: bigint;
  transactionId: string;
  currency: string;
}

export interface CreditOnlinePaymentParams {
  receiverUserId: string;
  amountMinor: bigint;
  transactionId: string;
  currency: string;
}

export interface ReserveOfflineBalanceParams {
  userId: string;
  amountMinor: bigint;
  tokenIds: string[];
}

export interface SettleOfflineTransactionParams {
  senderUserId: string;
  receiverUserId: string;
  amountMinor: bigint;
  transactionId: string;
  currency: string;
}

export interface ReleaseExpiredReservationParams {
  userId: string;
  amountMinor: bigint;
  tokenIds: string[];
}

/**
 * Contract for the central ledger service (implemented externally).
 * The StubLedgerService satisfies this interface until the real ledger is wired in.
 * To swap in the real service: change the provider in LedgerModule only.
 */
export interface ILedgerService {
  debitOnlinePayment(params: DebitOnlinePaymentParams): Promise<void>;
  creditOnlinePayment(params: CreditOnlinePaymentParams): Promise<void>;
  reserveOfflineBalance(params: ReserveOfflineBalanceParams): Promise<void>;
  settleOfflineTransaction(params: SettleOfflineTransactionParams): Promise<void>;
  releaseExpiredReservation(params: ReleaseExpiredReservationParams): Promise<void>;
}
