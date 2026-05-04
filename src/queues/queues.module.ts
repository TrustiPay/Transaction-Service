import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { ONLINE_TXN_QUEUE, OFFLINE_TXN_QUEUE } from './constants';
import { OnlineTransactionProcessor } from './online-transaction.processor';
import { OfflineTransactionProcessor } from './offline-transaction.processor';
import { PrismaService } from '../prisma/prisma.service';
import { FraudModule } from '../fraud/fraud.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AuditModule } from '../audit/audit.module';
import { SettlementModule } from '../settlement/settlement.module';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('REDIS_URL', 'redis://localhost:6379'),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: ONLINE_TXN_QUEUE },
      { name: OFFLINE_TXN_QUEUE },
    ),
    FraudModule,
    LedgerModule,
    AuditModule,
    SettlementModule,
  ],
  providers: [OnlineTransactionProcessor, OfflineTransactionProcessor, PrismaService],
  exports: [BullModule],
})
export class QueuesModule {}
