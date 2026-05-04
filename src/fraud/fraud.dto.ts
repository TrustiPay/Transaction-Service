/** Fields the fraud detection FastAPI /score endpoint expects */
export interface FraudScoreRequest {
  tx_id: string;
  sender_id: string;
  receiver_id: string;
  timestamp: string;
  amount: number;
  transaction_type: string;
  oldbal_sender: number;
  newbal_sender: number;
  oldbal_receiver: number;
  newbal_receiver: number;
  sender_bank: string;
  receiver_bank: string;
  sender_home_province: string;
  device_type: string;
  network_type: string;
  phone_number: string;
  location_changed: number;
  device_changed: number;
  new_device_flag: number;
  is_merchant_receiver: number;
}

export interface FraudScoreResponse {
  action: string;       // 'ALLOW' | 'REVIEW' | 'BLOCK'
  score: number;
  case_id?: number;
  reason?: string;
}

/** Internal params passed into FraudService.score() */
export interface ScoreParams {
  txId: string;
  senderUserId: string;
  receiverUserId: string;
  amountMinor: number;
  currency: string;
  transactionType: string;
  deviceType: string;
  networkType: string;
  phoneNumber: string;
  senderBank: string;
  locationChanged?: boolean;
  deviceChanged?: boolean;
  newDevice?: boolean;
  isMerchantReceiver?: boolean;
}
