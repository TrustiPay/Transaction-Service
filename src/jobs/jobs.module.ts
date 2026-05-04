import { Module } from '@nestjs/common';
import { TokenExpiryJob } from './token-expiry.job';
import { PrismaService } from '../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [AuditModule, LedgerModule],
  providers: [TokenExpiryJob, PrismaService],
})
export class JobsModule {}
