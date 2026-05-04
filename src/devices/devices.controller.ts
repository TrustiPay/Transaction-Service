import { Controller, Post, Body, UseInterceptors } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { RevokeDeviceDto } from './dto/revoke-device.dto';
import { UserCtx, UserContext } from '../common/decorators/user-context.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Controller('offline/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post('register')
  @UseInterceptors(IdempotencyInterceptor)
  register(@Body() dto: RegisterDeviceDto, @UserCtx() user: UserContext) {
    return this.devices.registerDevice(dto, user);
  }

  @Post('revoke')
  revoke(@Body() dto: RevokeDeviceDto, @UserCtx() user: UserContext) {
    return this.devices.revokeDevice(dto, user);
  }
}
