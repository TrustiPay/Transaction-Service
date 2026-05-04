import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Validates X-Internal-Service header sent by the API gateway on internal calls.
 * Only applied to endpoints that should not be publicly reachable directly.
 */
@Injectable()
export class InternalGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const secret = this.config.get<string>('INTERNAL_SERVICE_SECRET');
    if (!secret) return true; // No secret configured — dev mode, skip check
    const header = req.headers['x-internal-service'];
    if (header !== secret) {
      throw new UnauthorizedException('Missing or invalid X-Internal-Service header');
    }
    return true;
  }
}
