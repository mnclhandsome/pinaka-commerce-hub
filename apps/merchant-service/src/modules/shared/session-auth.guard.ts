import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { extractBearerToken, IS_PUBLIC_ROUTE, verifyAccessToken } from '@pinaka-delivery-hub/auth';
import { MerchantRepository } from '../merchant/merchant.repository';

export const REQUIRE_AUTH_ROUTE = 'requireAuthRoute';
export const RequireAuth = () => SetMetadata(REQUIRE_AUTH_ROUTE, true);

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers?: { authorization?: string }; user?: unknown }>();
    const requiresAuth = this.reflector?.getAllAndOverride<boolean>(REQUIRE_AUTH_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (process.env.SKIP_AUTH === 'true') {
      if (request.headers?.authorization) {
        try {
          const payload = verifyAccessToken(extractBearerToken(request.headers.authorization));
          request.user = {
            id: payload.sub,
            accountId: payload.accountId,
            email: payload.email,
            role: payload.role,
            sessionId: payload.jti,
          };
          return true;
        } catch {
          // Authentication is optional only while the explicit local bypass is enabled.
        }
      }
      request.user = {
        id: '11111111-1111-4111-8111-111111111111',
        accountId: '11111111-1111-4111-8111-111111111111',
        email: 'admin@pinaka.com',
        role: 'OWNER',
        sessionId: 'session-skip-auth',
      };
      return true;
    }
    const isPublic = this.reflector?.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic && !requiresAuth) return true;
    const token = extractBearerToken(request.headers?.authorization);
    const payload = verifyAccessToken(token);
    const session = await this.merchants.touchSession(payload.jti!, token);
    if (!session) throw new UnauthorizedException('Session is not active. Please log in again.');
    const scopedPayload = payload as typeof payload & {
      merchantId?: string;
      storeId?: string;
    };
    request.user = {
      id: payload.sub,
      accountId: payload.accountId ?? session.accountId,
      email: payload.email ?? session.email,
      role: (payload as typeof payload & { roleCode?: string; roleName?: string }).roleName
        ?? (payload as typeof payload & { roleCode?: string }).roleCode
        ?? payload.role
        ?? session.role,
      merchantId: payload.merchantId,
      storeId: payload.storeId,
      deviceId: payload.deviceId,
      sessionId: session.id,
      merchantId: scopedPayload.merchantId ?? session.merchantId,
      storeId: scopedPayload.storeId ?? session.storeId,
    };
    return true;
  }
}

export function requireOwnerRole(role?: string): void {
  if (role !== 'OWNER') {
    throw new ForbiddenException('Only owners may manage website connectors');
  }
}
