import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CreateSessionParams {
  employeeId: string;
  merchantId: string;
  storeId: string;
  deviceId: string;
  registerId?: string;
  roleId: string;
  roleCode: string;
  roleName: string;
}

export interface PosAccessTokenPayload {
  sub: string;
  jti: string;
  merchantId?: string;
  storeId?: string;
  deviceId?: string;
  type?: string;
  roleCode?: string;
  roleName?: string;
  exp: number;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret)
    .update(signatureInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${signatureInput}.${signature}`;
}

@Injectable()
export class PosSessionService {
  private get secret(): string {
    return process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || 'pdh-local-development-secret-change-me';
  }

  async createSession(params: CreateSessionParams) {
    const now = Math.floor(Date.now() / 1000);
    const sessionId = `sess_${now}_${Math.random().toString(36).substring(2, 8)}`;

    const accessPayload = {
      sub: params.employeeId,
      jti: sessionId,
      sid: sessionId,
      type: 'access',
      merchantId: params.merchantId,
      storeId: params.storeId,
      deviceId: params.deviceId,
      registerId: params.registerId || 'REG-01',
      roleId: params.roleId,
      roleCode: params.roleCode,
      roleName: params.roleName,
      iat: now,
      exp: now + 12 * 3600,
    };

    const refreshPayload = {
      jti: `ref_${sessionId}`,
      sid: sessionId,
      sub: params.employeeId,
      type: 'refresh',
      iat: now,
      exp: now + 7 * 24 * 3600,
    };

    const accessToken = signJwt(accessPayload, this.secret);
    const refreshToken = signJwt(refreshPayload, this.secret);

    return {
      sessionId,
      accessToken,
      refreshToken,
    };
  }

  verifyAccessToken(token: string): PosAccessTokenPayload {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new UnauthorizedException('Invalid access token');
    }
    const [header, body, signature] = parts;
    const expected = createHmac('sha256', this.secret)
      .update(`${header}.${body}`)
      .digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, 'base64url');
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new UnauthorizedException('Invalid access token');
    }

    let payload: PosAccessTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PosAccessTokenPayload;
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
    if (
      payload.type !== 'access' ||
      typeof payload.exp !== 'number' ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      throw new UnauthorizedException('Access token has expired');
    }
    if (!payload.sub || !payload.jti) {
      throw new UnauthorizedException('Invalid access token');
    }
    return payload;
  }
}
