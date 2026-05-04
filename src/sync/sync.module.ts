import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { OFFLINE_TXN_QUEUE } from '../queues/constants';

@Module({
  imports: [
    BullModule.registerQueue({ name: OFFLINE_TXN_QUEUE }),
    AuditModule,
  ],
  controllers: [SyncController],
  providers: [SyncService, PrismaService],
})
export class SyncModule {}
