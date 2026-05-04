import { IsString, IsNotEmpty, IsIn, IsOptional } from 'class-validator';

export class RegisterDeviceDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @IsString()
  @IsOptional()
  deviceName?: string;

  /** Base64url-encoded public key */
  @IsString()
  @IsNotEmpty()
  publicSigningKey: string;

  @IsString()
  @IsIn(['ECDSA_P256', 'ED25519'])
  keyAlgorithm: string;

  @IsString()
  @IsOptional()
  appVersion?: string;

  @IsString()
  @IsIn(['ANDROID', 'IOS'])
  platform: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}
