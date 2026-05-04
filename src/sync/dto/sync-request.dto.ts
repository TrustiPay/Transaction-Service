import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  IsOptional,
  IsISO8601,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PendingTransactionDto {
  @IsString()
  @IsNotEmpty()
  transactionId: string;

  @IsString()
  @IsOptional()
  paymentRequest?: string;

  @IsString()
  @IsNotEmpty()
  paymentOffer: string;

  @IsString()
  @IsNotEmpty()
  paymentReceipt: string;

  @IsString()
  @IsOptional()
  @IsIn(['QR', 'BLE', 'WIFI_DIRECT', 'NFC', 'NFC_BOOTSTRAP_BLE', 'NFC_BOOTSTRAP_WIFI_DIRECT', 'UNKNOWN'])
  transportType?: string;

  @IsISO8601()
  @IsOptional()
  createdAtDevice?: string;

  @IsArray()
  @IsString({ each: true })
  spentTokenIds: string[];

  @IsString()
  @IsNotEmpty()
  senderUserId: string;

  @IsString()
  @IsNotEmpty()
  receiverUserId: string;

  @IsString()
  @IsNotEmpty()
  senderDeviceId: string;

  @IsString()
  @IsNotEmpty()
  receiverDeviceId: string;

  @IsString()
  @IsNotEmpty()
  amountMinor: string;

  @IsString()
  @IsNotEmpty()
  currency: string;
}

export class SyncRequestDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @IsString()
  @IsOptional()
  lastSyncCursor?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PendingTransactionDto)
  pendingTransactions: PendingTransactionDto[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  spentTokenIds?: string[];

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}
