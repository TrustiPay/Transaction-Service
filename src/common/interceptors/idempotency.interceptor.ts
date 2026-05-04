import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';
import * as crypto from 'crypto';

const IDEMPOTENCY_TTL_HOURS = 24;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const req = context.switchToHttp().getRequest();
    const idempotencyKey = req.headers['idempotency-key'] as string;

    if (!idempotencyKey) return next.handle();

    const userId = req.headers['x-user-id'] as string | undefined;
    const endpoint = `${req.method}:${req.path}`;
    const bodyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(req.body || {}))
      .digest('hex');

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { idempotencyKey },
    });

    if (existing) {
      if (existing.requestHash !== bodyHash) {
        throw new ConflictException({
          errorCode: 'IDEMPOTENCY_CONFLICT',
          message: 'Idempotency key already used with a different request body.',
          retryable: false,
        });
      }
      this.logger.debug(`Idempotency cache hit for key=${idempotencyKey}`);
      return of(existing.responseBody);
    }

    return next.handle().pipe(
      tap(async (responseBody) => {
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + IDEMPOTENCY_TTL_HOURS);

        await this.prisma.idempotencyKey.upsert({
          where: { idempotencyKey },
          update: {},
          create: {
            idempotencyKey,
            userId,
            endpoint,
            requestHash: bodyHash,
            responseBody,
            expiresAt,
          },
        });
      }),
    );
  }
}
