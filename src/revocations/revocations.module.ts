import { Module } from '@nestjs/common';
import { RevocationsController } from './revocations.controller';
import { RevocationsService } from './revocations.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [RevocationsController],
  providers: [RevocationsService, PrismaService],
})
export class RevocationsModule {}
