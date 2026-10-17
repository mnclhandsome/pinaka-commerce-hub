import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';
import { ensurePosEmployeeAttendanceSchema } from './pos_employee_attendance.schema';

export interface PosAttendanceEmployee {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  loginPinHash: string | null;
  merchantId: string;
  storeId: string;
  storeName: string;
}

export interface PosAttendanceIdentity {
  employeeId: string;
  employeeCode: string;
  merchantId: string;
  storeId: string;
  roleId: string;
}

export interface PosAttendanceListFilters {
  employeeCode?: string;
  date?: string;
  status?: string;
  page: number;
  limit: number;
}

@Injectable()
export class PosEmployeeAttendanceRepository {
  constructor(
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
  ) {}

  private get db() {
    return this.merchants.requireDataSource();
  }

  async ensureSchema(): Promise<void> {
    await ensurePosEmployeeAttendanceSchema(this.db);
  }

  async findActiveEmployee(
    employeeCode: string,
    merchantIdentifier: string,
    storeIdentifier: string,
  ): Promise<PosAttendanceEmployee | null> {
    const rows = await this.db.query(
      `SELECT e.id::text AS id,
              e.employee_code AS "employeeCode",
              e.first_name AS "firstName",
              e.last_name AS "lastName",
              COALESCE(es.login_pin_hash, e.login_pin_hash) AS "loginPinHash",
              m.id::text AS "merchantId",
              s.id::text AS "storeId",
              s.store_name AS "storeName"
       FROM public.employees e
       JOIN public.merchants m ON m.id = e.merchant_id
       JOIN public.stores s ON s.merchant_id = m.id
       LEFT JOIN public.employee_stores es
         ON es.employee_id = e.id
        AND es.store_id = s.id
        AND upper(es.status) = 'ACTIVE'
       WHERE e.employee_code = $1
         AND e.status::text = 'ACTIVE'
         AND m.status = 'ACTIVE'
         AND s.status = 'ACTIVE'
         AND (m.id::text = $2 OR m.merchant_id = $2 OR m.merchant_code = $2)
         AND (s.id::text = $3 OR s.store_code = $3 OR lower(s.store_name) = lower($3))
       LIMIT 1`,
      [employeeCode.trim(), merchantIdentifier.trim(), storeIdentifier.trim()],
    );
    return rows[0] ?? null;
  }

  async hasActiveStoreAssignment(
    employeeId: string,
    storeId: string,
  ): Promise<boolean> {
    const tables = await this.db.query(
      `SELECT to_regclass('public.employee_stores') IS NOT NULL AS "hasEmployeeStores",
              to_regclass('public.employee_store_assignments') IS NOT NULL AS "hasAssignments"`,
    );
    const membershipQueries: string[] = [];
    if (tables[0]?.hasEmployeeStores) {
      membershipQueries.push(`
        SELECT 1 FROM public.employee_stores
        WHERE employee_id::text = $1 AND store_id::text = $2 AND upper(status) = 'ACTIVE'
      `);
    }
    if (tables[0]?.hasAssignments) {
      membershipQueries.push(`
        SELECT 1 FROM public.employee_store_assignments
        WHERE employee_id::text = $1 AND store_id::text = $2 AND upper(status) = 'ACTIVE'
      `);
    }
    if (!membershipQueries.length) return false;
    const rows = await this.db.query(
      `SELECT EXISTS (${membershipQueries.join(' UNION ALL ')}) AS assigned`,
      [employeeId, storeId],
    );
    return rows[0]?.assigned === true;
  }

  async clockIn(employee: PosAttendanceEmployee) {
    try {
      return await this.db.transaction(async (manager) => {
        const locked = await manager.query(
          'SELECT id FROM public.employees WHERE id = $1::uuid FOR UPDATE',
          [employee.id],
        );
        if (!locked.length) {
          throw new NotFoundException({
            success: false,
            message: 'Employee record is no longer available',
          });
        }

        const open = await manager.query(
          `SELECT id FROM public.pos_employee_attendance
           WHERE employee_id = $1::uuid AND clock_out IS NULL LIMIT 1`,
          [employee.id],
        );
        if (open.length) {
          throw new ConflictException({
            success: false,
            message: 'Employee already has an open attendance session',
          });
        }

        const rows = await manager.query(
          `INSERT INTO public.pos_employee_attendance
             (merchant_id, store_id, employee_id, employee_code, employee_name, clock_in, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, clock_timestamp(), 'PRESENT')
           RETURNING id::text AS id,
                     merchant_id AS "merchantId",
                     store_id AS "storeId",
                     employee_id AS "employeeId",
                     employee_code AS "employeeCode",
                     employee_name AS "employeeName",
                     clock_in AS "clockIn",
                     clock_out AS "clockOut",
                     created_at AS "createdAt",
                     updated_at AS "updatedAt",
                     merchant_id,
                     store_id,
                     employee_id,
                     employee_code,
                     employee_name,
                     clock_in,
                     clock_out,
                     status,
                     created_at,
                     updated_at`,
          [
            employee.merchantId,
            employee.storeId,
            employee.id,
            employee.employeeCode,
            `${employee.firstName} ${employee.lastName}`.trim(),
          ],
        );
        return rows[0];
      });
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException({
          success: false,
          message: 'Employee already has an open attendance session',
        });
      }
      throw error;
    }
  }

  async clockOut(employee: PosAttendanceEmployee) {
    return this.db.transaction(async (manager) => {
      const locked = await manager.query(
        'SELECT id FROM public.employees WHERE id = $1::uuid FOR UPDATE',
        [employee.id],
      );
      if (!locked.length) {
        throw new NotFoundException({
          success: false,
          message: 'Employee record is no longer available',
        });
      }

      const open = await manager.query(
        `SELECT id::text AS id, clock_in AS "clockIn", clock_in
         FROM public.pos_employee_attendance
         WHERE employee_id = $1::uuid
           AND merchant_id = $2::uuid
           AND store_id = $3::uuid
           AND clock_out IS NULL
         ORDER BY clock_in DESC LIMIT 1 FOR UPDATE`,
        [employee.id, employee.merchantId, employee.storeId],
      );
      if (!open.length) {
        throw new NotFoundException({
          success: false,
          message: 'No open attendance session was found',
        });
      }
      if (new Date(open[0].clockIn).getTime() > Date.now()) {
        throw new ConflictException({
          success: false,
          message: 'Clock-out cannot precede clock-in',
        });
      }

      const updated = await manager.query(
        `UPDATE public.pos_employee_attendance
         SET clock_out = clock_timestamp(), status = 'CLOCK_OUT', updated_at = now()
         WHERE id = $1::uuid AND clock_out IS NULL
           AND clock_in <= clock_timestamp()
         RETURNING id::text AS id,
                   merchant_id AS "merchantId",
                   store_id AS "storeId",
                   employee_id AS "employeeId",
                   employee_code AS "employeeCode",
                   employee_name AS "employeeName",
                   clock_in AS "clockIn",
                   clock_out AS "clockOut",
                   created_at AS "createdAt",
                   updated_at AS "updatedAt",
                   merchant_id,
                   store_id,
                   employee_id,
                   employee_code,
                   employee_name,
                   clock_in,
                   clock_out,
                   status,
                   created_at,
                   updated_at`,
        [open[0].id],
      );
      if (!updated.length) {
        throw new ConflictException({
          success: false,
          message: 'Clock-out could not be recorded',
        });
      }
      return updated[0];
    });
  }

  async findOpenForEmployee(identity: PosAttendanceIdentity) {
    const rows = await this.db.query(
      `SELECT id::text AS id,
              merchant_id AS "merchantId",
              store_id AS "storeId",
              employee_id AS "employeeId",
              employee_code AS "employeeCode",
              employee_name AS "employeeName",
              clock_in AS "clockIn",
              clock_out AS "clockOut",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              merchant_id,
              store_id,
              employee_id,
              employee_code,
              employee_name,
              clock_in,
              clock_out,
              status,
              created_at,
              updated_at
       FROM public.pos_employee_attendance
       WHERE employee_id = $1::uuid
         AND merchant_id = $2::uuid
         AND store_id = $3::uuid
         AND clock_out IS NULL
       ORDER BY clock_in DESC LIMIT 1`,
      [identity.employeeId, identity.merchantId, identity.storeId],
    );
    return rows[0] ?? null;
  }

  async listForEmployee(
    identity: Pick<PosAttendanceIdentity, 'merchantId' | 'storeId'>,
    filters: PosAttendanceListFilters,
  ) {
    return this.listForStore(identity, filters);
  }

  async findById(identity: PosAttendanceIdentity, attendanceId: string) {
    const rows = await this.db.query(
      `SELECT id::text AS id,
              merchant_id AS "merchantId",
              store_id AS "storeId",
              employee_id AS "employeeId",
              employee_code AS "employeeCode",
              employee_name AS "employeeName",
              clock_in AS "clockIn",
              clock_out AS "clockOut",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              status
       FROM public.pos_employee_attendance
       WHERE id = $1::uuid
         AND merchant_id = $2::uuid
         AND store_id = $3::uuid
       LIMIT 1`,
      [attendanceId, identity.merchantId, identity.storeId],
    );

    if (!rows.length) {
      throw new NotFoundException({
        success: false,
        message: 'Attendance record not found for this store',
      });
    }

    return rows[0];
  }

  async listForStore(
    identity: Pick<PosAttendanceIdentity, 'merchantId' | 'storeId'>,
    filters: PosAttendanceListFilters,
  ) {
    const values: unknown[] = [identity.merchantId, identity.storeId];

    const where = ['merchant_id::text = $1', 'store_id::text = $2'];

    if (filters.employeeCode) {
      values.push(filters.employeeCode.trim());
      where.push(`employee_code = $${values.length}`);
    }
    if (filters.date) {
      values.push(filters.date);
      where.push(
        `clock_in >= $${values.length}::date AND clock_in < ($${values.length}::date + interval '1 day')`,
      );
    }
    if (filters.status) {
      values.push(filters.status);
      where.push(`status = $${values.length}`);
    }

    const whereSql = where.join(' AND ');
    const countRows = await this.db.query(
      `SELECT count(*)::int AS total FROM public.pos_employee_attendance WHERE ${whereSql}`,
      values,
    );
    values.push(filters.limit, (filters.page - 1) * filters.limit);
    const rows = await this.db.query(
      `SELECT id::text AS id,
              merchant_id AS "merchantId",
              store_id AS "storeId",
              employee_id AS "employeeId",
              employee_code AS "employeeCode",
              employee_name AS "employeeName",
              clock_in AS "clockIn",
              clock_out AS "clockOut",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              merchant_id,
              store_id,
              employee_id,
              employee_code,
              employee_name,
              clock_in,
              clock_out,
              status,
              created_at,
              updated_at
       FROM public.pos_employee_attendance
       WHERE ${whereSql}
       ORDER BY clock_in DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const total = Number(countRows[0]?.total ?? 0);
    return {
      records: rows,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  }
}
