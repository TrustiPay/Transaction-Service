import { IsString, IsNotEmpty, IsNumber, Min, Max, IsArray, IsIn, ArrayMaxSize, IsOptional } from 'class-validator';

/** Valid offline token denominations in minor units (LKR) */
export const VALID_DENOMINATIONS = [1000, 2000, 5000, 10000, 50000, 100000];

export class TokenRequestDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @IsNumber()
  @Min(100)
  @Max(500000) // LKR 5,000 max offline wallet
  requestedAmountMinor: number;

  @IsString()
  @IsIn(['LKR'])
  currency: string;

  @IsArray()
  @ArrayMaxSize(6)
  @IsOptional()
  preferredDenominations?: number[];

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}
