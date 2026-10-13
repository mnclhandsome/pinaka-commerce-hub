import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';

export interface AccessTokenPayload {
  sub: string;
  accountId?: string | null;
  email?: string;
  role?: string;
  type?: string;
  jti?: string;
  iat?: number;
  exp?: number;
}

export function extractBearerToken(authorization?: string): string {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) throw new UnauthorizedException('Bearer token is required');
  return token;
}

export function jwtSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new UnauthorizedException('AUTH_JWT_SECRET is not configured');
  }
  return secret || 'pdh-local-development-secret-change-me';
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const [header, body, signature] = token.split('.');
  if (!header || !body || !signature) {
    throw new UnauthorizedException('Invalid access token');
  }
  const expected = createHmac('sha256', jwtSecret()).update(`${header}.${body}`).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new UnauthorizedException('Invalid access token');
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessTokenPayload;
    if (payload.type !== 'access' || typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Access token has expired');
    }
    if (!payload.sub || !payload.jti) {
      throw new UnauthorizedException('Invalid access token');
    }
    return payload;
  } catch (error: unknown) {
    if (error instanceof UnauthorizedException) throw error;
    throw new UnauthorizedException('Invalid access token');
  }
}
