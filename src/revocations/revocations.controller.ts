import { Controller, Get, Query } from '@nestjs/common';
import { RevocationsService } from './revocations.service';

@Controller('offline')
export class RevocationsController {
  constructor(private readonly revocations: RevocationsService) {}

  @Get('revocations')
  getRevocations(@Query('sinceCursor') sinceCursor?: string) {
    return this.revocations.getRevocations(sinceCursor);
  }
}
