import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { extractBearerToken, verifyAccessToken } from '@pinaka-delivery-hub/auth';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';
import { PosAttendanceIdentity } from './pos_employee_attendance.repository';

export interface PosEmployeeAttendanceRequest {
  headers?: { authorization?: string };
  posEmployee?: PosAttendanceIdentity;
}

@Injectable()
export class PosEmployeeAttendanceGuard implements CanActivate {
  constructor(@Inject(MerchantRepository) private readonly merchants: MerchantRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PosEmployeeAttendanceRequest>();
    let token: string;
    let payload: ReturnType<typeof verifyAccessToken> & {
      merchantId?: string;
      storeId?: string;
      roleId?: string;
    };
    try {
      token = extractBearerToken(request.headers?.authorization);
      payload = verifyAccessToken(token) as typeof payload;
    } catch {
      throw new UnauthorizedException({
        success: false,
        message: 'A valid POS employee session is required',
      });
    }
    if (!payload.merchantId || !payload.storeId) {
      throw new UnauthorizedException({ success: false, message: 'A valid POS employee session is required' });
    }

    const sessions = await this.merchants.requireDataSource().query(
      `SELECT es.employee_id::text AS "employeeId",
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
    if (!session || session.merchantId !== payload.merchantId || session.storeId !== payload.storeId) {
      throw new UnauthorizedException({ success: false, message: 'POS employee session is not active' });
    }

    request.posEmployee = {
      employeeId: session.employeeId,
      employeeCode: session.employeeCode,
      merchantId: session.merchantId,
      storeId: session.storeId,
      roleId: payload.roleId ?? '',
    };
    return true;
  }
}
