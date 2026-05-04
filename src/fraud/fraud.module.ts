import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { FraudService } from './fraud.service';

@Module({
  imports: [HttpModule],
  providers: [FraudService],
  exports: [FraudService],
})
export class FraudModule {}
