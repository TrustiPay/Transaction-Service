export class PaymentStatusDto {
  transactionId: string;
  status: string;
  amountMinor: number;
  currency: string;
  createdAt: string;
  settledAt?: string;
  rejectionReason?: string;
  fraudDecision?: string;
}
