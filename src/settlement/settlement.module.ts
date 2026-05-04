import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerModule } from '../ledger/ledger.module';
import { TokensModule } from '../tokens/tokens.module';

@Module({
  imports: [LedgerModule, TokensModule],
  providers: [SettlementService, PrismaService],
  exports: [SettlementService],
})
export class SettlementModule {}
