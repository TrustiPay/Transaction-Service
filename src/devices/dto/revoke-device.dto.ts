import { IsString, IsNotEmpty, IsIn, IsOptional } from 'class-validator';

export class RevokeDeviceDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @IsString()
  @IsIn(['LOST', 'COMPROMISED', 'REPLACED', 'USER_REQUEST'])
  reason: string;

  @IsString()
  @IsOptional()
  notes?: string;
}
