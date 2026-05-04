import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { RevokeDeviceDto } from './dto/revoke-device.dto';
import { UserContext } from '../common/decorators/user-context.decorator';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async registerDevice(dto: RegisterDeviceDto, user: UserContext) {
    const publicKeyId = `devkey_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    const existing = await this.prisma.deviceKey.findFirst({
      where: { userId: user.userId, deviceId: dto.deviceId, status: 'ACTIVE' },
    });

    if (existing) {
      // Idempotent re-registration: return existing record
      return {
        deviceId: dto.deviceId,
        publicKeyId: existing.publicKeyId,
        status: existing.status,
        serverTime: new Date().toISOString(),
      };
    }

    // Retire any old keys for the same device before registering a new one
    await this.prisma.deviceKey.updateMany({
      where: { userId: user.userId, deviceId: dto.deviceId, status: { in: ['ACTIVE', 'PENDING'] } },
      data: { status: 'REPLACED', revokedAt: new Date() },
    });

    const deviceKey = await this.prisma.deviceKey.create({
      data: {
        publicKeyId,
        userId: user.userId,
        deviceId: dto.deviceId,
        publicKey: dto.publicSigningKey,
        algorithm: dto.keyAlgorithm,
        status: 'ACTIVE',
      },
    });

    await this.audit.record({
      eventType: 'DEVICE_REGISTERED',
      userId: user.userId,
      deviceId: dto.deviceId,
      payload: { publicKeyId, algorithm: dto.keyAlgorithm, platform: dto.platform },
    });

    this.logger.log(`Device registered userId=${user.userId} deviceId=${dto.deviceId} keyId=${publicKeyId}`);

    return {
      deviceId: dto.deviceId,
      publicKeyId: deviceKey.publicKeyId,
      status: deviceKey.status,
      serverTime: new Date().toISOString(),
    };
  }

  async revokeDevice(dto: RevokeDeviceDto, user: UserContext) {
    const keys = await this.prisma.deviceKey.findMany({
      where: { userId: user.userId, deviceId: dto.deviceId, status: { in: ['ACTIVE', 'PENDING'] } },
    });

    if (keys.length === 0) {
      throw new NotFoundException({
        errorCode: 'DEVICE_NOT_REGISTERED',
        message: 'No active device found with that deviceId for this user.',
        retryable: false,
      });
    }

    const revokeStatus = dto.reason === 'LOST' ? 'LOST' : dto.reason === 'REPLACED' ? 'REPLACED' : 'REVOKED';

    await this.prisma.deviceKey.updateMany({
      where: { userId: user.userId, deviceId: dto.deviceId },
      data: { status: revokeStatus, revokedAt: new Date() },
    });

    await this.audit.record({
      eventType: 'DEVICE_REVOKED',
      userId: user.userId,
      deviceId: dto.deviceId,
      payload: { reason: dto.reason, notes: dto.notes, revokeStatus },
    });

    this.logger.log(`Device revoked userId=${user.userId} deviceId=${dto.deviceId} reason=${dto.reason}`);
    return { deviceId: dto.deviceId, status: revokeStatus, serverTime: new Date().toISOString() };
  }

  async getActiveKey(publicKeyId: string) {
    const key = await this.prisma.deviceKey.findUnique({ where: { publicKeyId } });
    if (!key || key.status !== 'ACTIVE') return null;
    return key;
  }
}
