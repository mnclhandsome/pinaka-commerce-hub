import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
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
  constructor(@Inject(MerchantRepository) private readonly merchants: MerchantRepository) {}

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
         AND (m.id::text = $2 OR m."merchantId" = $2 OR m."merchantCode" = $2)
         AND (s.id::text = $3 OR s.store_code = $3 OR lower(s.store_name) = lower($3))
       LIMIT 1`,
      [employeeCode.trim(), merchantIdentifier.trim(), storeIdentifier.trim()],
    );
    return rows[0] ?? null;
  }

  async hasActiveStoreAssignment(employeeId: string, storeId: string): Promise<boolean> {
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
      return await this.db.transaction(async manager => {
        const locked = await manager.query(
          'SELECT id FROM public.employees WHERE id = $1::uuid FOR UPDATE',
          [employee.id],
        );
        if (!locked.length) {
          throw new NotFoundException({ success: false, message: 'Employee record is no longer available' });
        }

        const open = await manager.query(
          `SELECT id FROM public.pos_employee_attendance
           WHERE "employeeId" = $1::uuid AND "clockOut" IS NULL LIMIT 1`,
          [employee.id],
        );
        if (open.length) {
          throw new ConflictException({ success: false, message: 'Employee already has an open attendance session' });
        }

        const rows = await manager.query(
          `INSERT INTO public.pos_employee_attendance
             ("merchantId", "storeId", "employeeId", "employeeCode", "employeeName", "clockIn", status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, clock_timestamp(), 'PRESENT')
           RETURNING id::text AS id, "clockIn", "clockOut", status`,
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
        throw new ConflictException({ success: false, message: 'Employee already has an open attendance session' });
      }
      throw error;
    }
  }

  async clockOut(employee: PosAttendanceEmployee) {
    return this.db.transaction(async manager => {
      const locked = await manager.query(
        'SELECT id FROM public.employees WHERE id = $1::uuid FOR UPDATE',
        [employee.id],
      );
      if (!locked.length) {
        throw new NotFoundException({ success: false, message: 'Employee record is no longer available' });
      }

      const open = await manager.query(
        `SELECT id::text AS id, "clockIn"
         FROM public.pos_employee_attendance
         WHERE "employeeId" = $1::uuid
           AND "merchantId" = $2::uuid
           AND "storeId" = $3::uuid
           AND "clockOut" IS NULL
         ORDER BY "clockIn" DESC LIMIT 1 FOR UPDATE`,
        [employee.id, employee.merchantId, employee.storeId],
      );
      if (!open.length) {
        throw new NotFoundException({ success: false, message: 'No open attendance session was found' });
      }
      if (new Date(open[0].clockIn).getTime() > Date.now()) {
        throw new ConflictException({ success: false, message: 'Clock-out cannot precede clock-in' });
      }

      const updated = await manager.query(
        `UPDATE public.pos_employee_attendance
         SET "clockOut" = clock_timestamp(), status = 'COMPLETED', "updatedAt" = now()
         WHERE id = $1::uuid AND "clockOut" IS NULL
           AND "clockIn" <= clock_timestamp()
         RETURNING id::text AS id, "clockIn", "clockOut", status`,
        [open[0].id],
      );
      if (!updated.length) {
        throw new ConflictException({ success: false, message: 'Clock-out could not be recorded' });
      }
      return updated[0];
    });
  }

  async findOpenForEmployee(identity: PosAttendanceIdentity) {
    const rows = await this.db.query(
      `SELECT id::text AS id, "employeeCode", "employeeName", "clockIn", "clockOut", status
       FROM public.pos_employee_attendance
       WHERE "employeeId" = $1::uuid
         AND "merchantId" = $2::uuid
         AND "storeId" = $3::uuid
         AND "clockOut" IS NULL
       ORDER BY "clockIn" DESC LIMIT 1`,
      [identity.employeeId, identity.merchantId, identity.storeId],
    );
    return rows[0] ?? null;
  }

  async listForEmployee(identity: PosAttendanceIdentity, filters: PosAttendanceListFilters) {
    const values: unknown[] = [identity.merchantId, identity.storeId, identity.employeeId];
    const where = [
      '"merchantId"::text = $1',
      '"storeId"::text = $2',
      '"employeeId"::text = $3',
    ];
    if (filters.employeeCode) {
      values.push(filters.employeeCode.trim());
      where.push(`"employeeCode" = $${values.length}`);
    }
    if (filters.date) {
      values.push(filters.date);
      where.push(`"clockIn" >= $${values.length}::date AND "clockIn" < ($${values.length}::date + interval '1 day')`);
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
              "employeeCode",
              "employeeName",
              "clockIn",
              "clockOut",
              status,
              "createdAt",
              "updatedAt"
       FROM public.pos_employee_attendance
       WHERE ${whereSql}
       ORDER BY "clockIn" DESC
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
