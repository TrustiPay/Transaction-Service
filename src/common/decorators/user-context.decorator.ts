import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface UserContext {
  userId: string;
  deviceId?: string;
  phoneNumber?: string;
  scopes?: string[];
}

/**
 * Extracts user identity forwarded by the API gateway after JWT validation.
 * The gateway sets X-User-Id, X-Device-Id headers on authenticated requests.
 */
export const UserCtx = createParamDecorator((_data: unknown, ctx: ExecutionContext): UserContext => {
  const req = ctx.switchToHttp().getRequest();
  return {
    userId: req.headers['x-user-id'] || req.user?.sub || 'unknown',
    deviceId: req.headers['x-device-id'],
    phoneNumber: req.headers['x-phone-number'],
  };
});
