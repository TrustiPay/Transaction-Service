import { Module } from '@nestjs/common';
import { LEDGER_SERVICE } from './ledger.interface';
import { StubLedgerService } from './stub-ledger.service';

@Module({
  providers: [
    {
      provide: LEDGER_SERVICE,
      useClass: StubLedgerService,
    },
  ],
  exports: [LEDGER_SERVICE],
})
export class LedgerModule {}
