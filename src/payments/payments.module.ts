import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { ONLINE_TXN_QUEUE } from '../queues/constants';

@Module({
  imports: [
    BullModule.registerQueue({ name: ONLINE_TXN_QUEUE }),
    AuditModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, PrismaService],
})
export class PaymentsModule {}
