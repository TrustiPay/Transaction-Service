import { Controller, Post, Get, Body, UseInterceptors } from '@nestjs/common';
import { TokensService } from './tokens.service';
import { TokenRequestDto } from './dto/token-request.dto';
import { UserCtx, UserContext } from '../common/decorators/user-context.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Controller('offline')
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Post('tokens/request')
  @UseInterceptors(IdempotencyInterceptor)
  requestTokens(@Body() dto: TokenRequestDto, @UserCtx() user: UserContext) {
    return this.tokens.requestTokens(dto, user);
  }

  @Post('tokens/refresh')
  @UseInterceptors(IdempotencyInterceptor)
  refreshTokens(@Body() dto: TokenRequestDto, @UserCtx() user: UserContext) {
    return this.tokens.requestTokens(dto, user);
  }

  @Get('server-keys')
  getServerKeys() {
    return this.tokens.getServerKeys();
  }

  @Get('limits')
  getLimits() {
    return {
      maxOfflineWalletMinor: 500000,
      maxTransactionMinor: 100000,
      tokenExpiryDays: 7,
      maxUnsyncedTransactions: 20,
      requiredSyncHours: 48,
      currency: 'LKR',
    };
  }
}
