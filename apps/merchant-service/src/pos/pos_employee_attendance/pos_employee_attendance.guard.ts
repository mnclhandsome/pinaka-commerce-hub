import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  extractBearerToken,
  verifyAccessToken,
} from '@pinaka-delivery-hub/auth';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';
import { PosAttendanceIdentity } from './pos_employee_attendance.repository';

type AttendanceTokenPayload = ReturnType<typeof verifyAccessToken> & {
  sub: string;
  jti?: string;
  role?: string;
  roleId?: string;
  merchantId?: string;
  storeId?: string;
  accountId?: string;
};

export interface PosEmployeeAttendanceRequest {
  headers?: { authorization?: string };
  query?: Record<string, string | string[] | undefined>;
  params?: Record<string, string | undefined>;
  posEmployee?: PosAttendanceIdentity;
}

const sessionRequired = {
  success: false,
  message: 'A valid admin or POS employee session is required',
} as const;

function queryValue(
  query: PosEmployeeAttendanceRequest['query'],
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = query?.[key];
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
  }
  return '';
}

@Injectable()
export class PosEmployeeAttendanceGuard implements CanActivate {
  constructor(
    @Inject(MerchantRepository)
    private readonly merchants: MerchantRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<PosEmployeeAttendanceRequest>();

    let token: string;
    let payload: AttendanceTokenPayload;

    try {
      token = extractBearerToken(request.headers?.authorization);
      payload = verifyAccessToken(token) as AttendanceTokenPayload;
    } catch {
      throw new UnauthorizedException(sessionRequired);
    }

    // 1. Try POS employee authentication first.
    const posIdentity = await this.resolvePosEmployee(token, payload);

    if (posIdentity) {
      request.posEmployee = posIdentity;
      return true;
    }

    // 2. Fall back to an authenticated PCH admin session.
    if (!payload.jti) {
      throw new UnauthorizedException(sessionRequired);
    }

    let adminSession: any;

    try {
      adminSession = await this.merchants.touchSession(payload.jti, token);
    } catch {
      throw new UnauthorizedException(sessionRequired);
    }

    if (!adminSession) {
      throw new UnauthorizedException(sessionRequired);
    }

    // Do not treat an admin as a POS employee for /attendance/me.
    const url = context
      .switchToHttp()
      .getRequest<{ route?: { path?: string } }>();
    const routePath = url.route?.path ?? '';

    if (routePath.endsWith('/me')) {
      throw new ForbiddenException({
        success: false,
        message: 'The attendance/me endpoint requires a POS employee session',
      });
    }

    const merchantId =
      queryValue(request.query, 'merchantId', 'merchant_id') ||
      payload.merchantId ||
      '';

    const storeId =
      queryValue(request.query, 'storeId', 'store_id') || payload.storeId || '';

    if (!merchantId || !storeId) {
      throw new ForbiddenException({
        success: false,
        message:
          'merchantId and storeId are required for admin attendance access',
      });
    }

    // IMPORTANT:
    // Implement this check using your real account-to-merchant/store
    // authorization tables before enabling admin attendance access.
    const authorized = await this.isAdminAuthorizedForStore(
      adminSession,
      payload,
      merchantId,
      storeId,
    );

    if (!authorized) {
      throw new ForbiddenException({
        success: false,
        message: 'You are not authorized to access attendance for this store',
      });
    }

    request.posEmployee = {
      employeeId: '',
      employeeCode: '',
      merchantId,
      storeId,
      roleId: payload.roleId ?? '',
    };

    return true;
  }

  private async resolvePosEmployee(
    token: string,
    payload: AttendanceTokenPayload,
  ): Promise<PosAttendanceIdentity | null> {
    if (!payload.sub || !payload.merchantId || !payload.storeId) {
      return null;
    }

    const sessions = await this.merchants.requireDataSource().query(
      `SELECT
          es.employee_id::text AS "employeeId",
          es.merchant_id::text AS "merchantId",
          es.store_id::text AS "storeId",
          e.employee_code AS "employeeCode"
       FROM public.employee_sessions es
       JOIN public.employees e ON e.id = es.employee_id
       WHERE es.access_token = $1
         AND es.employee_id::text = $2
         AND upper(es.status) = 'ACTIVE'
         AND e.status::text = 'ACTIVE'
       LIMIT 1`,
      [token, payload.sub],
    );

    const session = sessions[0];

    if (
      !session ||
      session.merchantId !== payload.merchantId ||
      session.storeId !== payload.storeId
    ) {
      return null;
    }

    return {
      employeeId: session.employeeId,
      employeeCode: session.employeeCode,
      merchantId: session.merchantId,
      storeId: session.storeId,
      roleId: payload.roleId ?? '',
    };
  }

  private async isAdminAuthorizedForStore(
    adminSession: any,
    payload: AttendanceTokenPayload,
    merchantId: string,
    storeId: string,
  ): Promise<boolean> {
    const userId = String(adminSession?.userId || payload.sub || '').trim();
    const sessionEmail = String(adminSession?.email || payload.email || '').trim();
    const sessionRole = String(adminSession?.role || payload.role || '').trim().toUpperCase();
    if ((!userId && !sessionEmail) || !merchantId || !storeId) return false;

    try {
      const matches = await this.merchants.requireDataSource().query(
        `SELECT 1
         FROM public.merchants AS m
         JOIN public.stores AS s
           ON s.merchant_id = m.id AND s.id::text = $3
         LEFT JOIN public.users AS u
           ON u.id::text = $1 OR lower(u.email) = lower($4)
         WHERE (m.id::text = $2 OR m.merchant_code = $2 OR m.merchant_id = $2)
           AND u.status = 'ACTIVE'
           AND (
             (upper(u.role) IN ('OWNER', 'MANAGER') AND
               u."merchantId" IN (m.id::text, m.merchant_code, m.merchant_id))
             OR (m.created_by::text = u.id::text AND upper(u.role) IN ('OWNER', 'MANAGER'))
             OR (upper(u.role) = 'OWNER' AND lower(u.email) = lower(m.email))
             OR (upper($5) = 'OWNER' AND lower($4) = lower(m.email))
           )
         LIMIT 1`,
        [userId, merchantId, storeId, sessionEmail, sessionRole],
      );
      return matches.length > 0;
    } catch {
      return false;
    }
  }
}
