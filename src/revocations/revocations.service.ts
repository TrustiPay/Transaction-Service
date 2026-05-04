import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RevocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getRevocations(sinceCursor?: string) {
    const since = sinceCursor ? new Date(Number(sinceCursor.replace('cursor_', ''))) : new Date(0);
    const serverTime = new Date();
    const revocationCursor = `cursor_${serverTime.getTime()}`;

    const revokedDeviceKeys = await this.prisma.deviceKey.findMany({
      where: {
        status: { in: ['REVOKED', 'LOST', 'REPLACED'] },
        revokedAt: { gte: since },
      },
      select: { deviceId: true, publicKeyId: true },
    });

    const revokedTokens = await this.prisma.offlineToken.findMany({
      where: {
        status: 'REVOKED',
        spentAt: { gte: since },
      },
      select: { tokenId: true },
    });

    const retiredServerKeys = await this.prisma.serverSigningKey.findMany({
      where: {
        status: { in: ['RETIRED', 'REVOKED'] },
        retiredAt: { gte: since },
      },
      select: { serverKeyId: true },
    });

    return {
      serverTime: serverTime.toISOString(),
      revocationCursor,
      revokedDeviceIds: [...new Set(revokedDeviceKeys.map((k) => k.deviceId))],
      revokedPublicKeyIds: revokedDeviceKeys.map((k) => k.publicKeyId),
      revokedTokenIds: revokedTokens.map((t) => t.tokenId),
      retiredServerKeyIds: retiredServerKeys.map((k) => k.serverKeyId),
    };
  }
}
