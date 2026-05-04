import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from './config/config.module';
import { PrismaService } from './prisma/prisma.service';
import { QueuesModule } from './queues/queues.module';
import { FraudModule } from './fraud/fraud.module';
import { LedgerModule } from './ledger/ledger.module';
import { AuditModule } from './audit/audit.module';
import { PaymentsModule } from './payments/payments.module';
import { DevicesModule } from './devices/devices.module';
import { TokensModule } from './tokens/tokens.module';
import { SettlementModule } from './settlement/settlement.module';
import { SyncModule } from './sync/sync.module';
import { RevocationsModule } from './revocations/revocations.module';
import { HealthController } from './health.controller';
import { JobsModule } from './jobs/jobs.module';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    TerminusModule,
    HttpModule,
    QueuesModule,
    FraudModule,
    LedgerModule,
    AuditModule,
    PaymentsModule,
    DevicesModule,
    TokensModule,
    SettlementModule,
    SyncModule,
    RevocationsModule,
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}
