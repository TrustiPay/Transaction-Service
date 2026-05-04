import { Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { TokenSignerService } from './token-signer.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [TokensController],
  providers: [TokensService, TokenSignerService, PrismaService],
  exports: [TokenSignerService],
})
export class TokensModule {}
