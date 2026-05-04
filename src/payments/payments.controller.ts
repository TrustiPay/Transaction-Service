import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  UseInterceptors,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UserCtx, UserContext } from '../common/decorators/user-context.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(IdempotencyInterceptor)
  async submitPayment(
    @Body() dto: CreatePaymentDto,
    @UserCtx() user: UserContext,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        errorCode: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key header is required for payment requests.',
        retryable: false,
      });
    }
    return this.payments.submitPayment(dto, user, idempotencyKey);
  }

  @Get(':transactionId')
  async getStatus(
    @Param('transactionId') transactionId: string,
    @UserCtx() user: UserContext,
  ) {
    return this.payments.getStatus(transactionId, user.userId);
  }
}
