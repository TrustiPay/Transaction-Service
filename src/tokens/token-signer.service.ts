import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface TokenPayloadToSign {
  tokenId: string;
  ownerUserId: string;
  ownerDeviceId: string;
  amountMinor: number;
  currency: string;
  issuedAt: string;
  expiresAt: string;
  issuerKeyId: string;
  nonce: string;
  protocolVersion: string;
}

export interface SignedToken extends TokenPayloadToSign {
  serverSignature: string;
  canonicalBytes: Buffer;
}

/**
 * Signs offline token payloads using the server's ECDSA P-256 private key.
 * Key material is loaded from a file path (never from env directly) to avoid exposure.
 */
@Injectable()
export class TokenSignerService implements OnModuleInit {
  private readonly logger = new Logger(TokenSignerService.name);
  private privateKey: crypto.KeyObject | null = null;
  private publicKeyPem: string = '';
  readonly keyId: string;
  readonly algorithm = 'ECDSA_P256';

  constructor(private readonly config: ConfigService) {
    this.keyId = this.config.get<string>('SERVER_SIGNING_KEY_ID', 'server-key-dev');
  }

  onModuleInit() {
    const keyPath = this.config.get<string>('SERVER_SIGNING_PRIVATE_KEY_PATH');

    if (keyPath && fs.existsSync(keyPath)) {
      const pem = fs.readFileSync(keyPath, 'utf8');
      this.privateKey = crypto.createPrivateKey(pem);
      this.publicKeyPem = crypto.createPublicKey(this.privateKey).export({ type: 'spki', format: 'pem' }) as string;
      this.logger.log(`Server signing key loaded keyId=${this.keyId} from ${keyPath}`);
    } else {
      // Dev mode — generate ephemeral key (not safe for production)
      this.logger.warn('SERVER_SIGNING_PRIVATE_KEY_PATH not set. Generating ephemeral dev key. DO NOT use in production.');
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      this.privateKey = privateKey;
      this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    }
  }

  sign(payload: TokenPayloadToSign): SignedToken {
    if (!this.privateKey) throw new Error('Server signing key not initialized');

    const canonical = this.canonicalize(payload as unknown as Record<string, unknown>);
    const canonicalBytes = Buffer.from(canonical, 'utf8');

    const sign = crypto.createSign('SHA256');
    sign.update(canonicalBytes);
    const signatureBuffer = sign.sign(this.privateKey);
    const serverSignature = signatureBuffer.toString('base64url');

    return { ...payload, serverSignature, canonicalBytes };
  }

  verify(canonicalBytes: Buffer, signatureBase64url: string): boolean {
    try {
      const publicKey = crypto.createPublicKey(this.publicKeyPem);
      const verify = crypto.createVerify('SHA256');
      verify.update(canonicalBytes);
      return verify.verify(publicKey, Buffer.from(signatureBase64url, 'base64url'));
    } catch {
      return false;
    }
  }

  getPublicKeyBase64(): string {
    return Buffer.from(this.publicKeyPem).toString('base64');
  }

  /** Deterministic canonical JSON — keys sorted alphabetically */
  private canonicalize(obj: Record<string, unknown>): string {
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => {
      const v = obj[k];
      const vStr = typeof v === 'object' ? this.canonicalize(v as Record<string, unknown>) : JSON.stringify(v);
      return `${JSON.stringify(k)}:${vStr}`;
    });
    return `{${parts.join(',')}}`;
  }
}
