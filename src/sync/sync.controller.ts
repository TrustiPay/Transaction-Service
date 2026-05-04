import { Controller, Post, Get, Body, Param, Headers, UseInterceptors } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncRequestDto } from './dto/sync-request.dto';
import { UserCtx, UserContext } from '../common/decorators/user-context.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Controller('offline')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('sync')
  @UseInterceptors(IdempotencyInterceptor)
  processBatch(@Body() dto: SyncRequestDto, @UserCtx() user: UserContext) {
    return this.sync.processBatch(dto, user);
  }

  @Get('sync/status/:transactionId')
  getStatus(
    @Param('transactionId') transactionId: string,
    @UserCtx() user: UserContext,
  ) {
    return this.sync.getSettlementStatus(transactionId, user.userId);
  }
}
