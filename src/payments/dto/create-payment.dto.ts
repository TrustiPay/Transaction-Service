import { IsString, IsNotEmpty, IsNumber, Min, IsISO8601, IsIn, IsOptional } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  @IsNotEmpty()
  receiverUserId: string;

  @IsNumber()
  @Min(1)
  amountMinor: number;

  @IsString()
  @IsIn(['LKR'])
  currency: string;

  @IsString()
  @IsNotEmpty()
  deviceId: string;

  /** SHA-256 hex of the canonical request body, computed by the client */
  @IsString()
  @IsNotEmpty()
  requestHash: string;

  /** Client-side ISO8601 timestamp — must be within ±5 min of server time */
  @IsISO8601()
  timestamp: string;

  @IsString()
  @IsOptional()
  networkType?: string;

  @IsString()
  @IsOptional()
  senderBank?: string;
}
