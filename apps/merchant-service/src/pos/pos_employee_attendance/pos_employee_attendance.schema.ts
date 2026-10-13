import { DataSource } from 'typeorm';

/** Attendance snapshots linked to the existing POS employee, merchant, and store records. */
export async function ensurePosEmployeeAttendanceSchema(db: DataSource): Promise<void> {
  await db.transaction(async manager => {
    await manager.query('SELECT pg_advisory_xact_lock(724621, 54)');
    await manager.query(`
      CREATE TABLE IF NOT EXISTS public.pos_employee_attendance (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
        "storeId" uuid NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
        "employeeId" uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
        "employeeCode" varchar(50) NOT NULL,
        "employeeName" varchar(201) NOT NULL,
        "clockIn" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "clockOut" timestamptz,
        status varchar(20) NOT NULL DEFAULT 'PRESENT',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pos_employee_attendance_status_chk
          CHECK (status IN ('PRESENT', 'COMPLETED', 'INCOMPLETE')),
        CONSTRAINT pos_employee_attendance_clock_range_chk
          CHECK ("clockOut" IS NULL OR "clockOut" >= "clockIn"),
        CONSTRAINT pos_employee_attendance_status_clock_chk
          CHECK (("clockOut" IS NULL AND status IN ('PRESENT', 'INCOMPLETE'))
              OR ("clockOut" IS NOT NULL AND status = 'COMPLETED'))
      )
    `);
    await manager.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS pos_employee_attendance_one_open_idx
      ON public.pos_employee_attendance ("employeeId")
      WHERE "clockOut" IS NULL
    `);
    await manager.query(`
      CREATE INDEX IF NOT EXISTS pos_employee_attendance_store_clock_in_idx
      ON public.pos_employee_attendance ("merchantId", "storeId", "clockIn" DESC)
    `);
    await manager.query(`
      CREATE INDEX IF NOT EXISTS pos_employee_attendance_employee_clock_in_idx
      ON public.pos_employee_attendance ("employeeId", "clockIn" DESC)
    `);
  });
}
