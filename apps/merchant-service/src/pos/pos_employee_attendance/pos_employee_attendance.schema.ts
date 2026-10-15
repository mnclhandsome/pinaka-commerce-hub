import { DataSource } from 'typeorm';

/** Attendance snapshots linked to the existing POS employee, merchant, and store records. */
export async function ensurePosEmployeeAttendanceSchema(db: DataSource): Promise<void> {
  await db.transaction(async manager => {
    await manager.query('SELECT pg_advisory_xact_lock(724621, 54)');

    // 1. Create table with snake_case columns if not exists
    await manager.query(`
      CREATE TABLE IF NOT EXISTS public.pos_employee_attendance (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
        store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
        employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
        employee_code varchar(50) NOT NULL,
        employee_name varchar(201) NOT NULL,
        clock_in timestamptz NOT NULL DEFAULT clock_timestamp(),
        clock_out timestamptz,
        status varchar(20) NOT NULL DEFAULT 'PRESENT',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // 2. Automatically migrate legacy camelCase columns to snake_case if present
    const columnRenames: [string, string][] = [
      ['merchantId', 'merchant_id'],
      ['storeId', 'store_id'],
      ['employeeId', 'employee_id'],
      ['employeeCode', 'employee_code'],
      ['employeeName', 'employee_name'],
      ['clockIn', 'clock_in'],
      ['clockOut', 'clock_out'],
      ['createdAt', 'created_at'],
      ['updatedAt', 'updated_at'],
    ];

    for (const [camelCol, snakeCol] of columnRenames) {
      const hasCamel = await manager.query(
        `SELECT 1 FROM information_schema.columns 
         WHERE table_schema = 'public' 
           AND table_name = 'pos_employee_attendance' 
           AND column_name = $1`,
        [camelCol],
      );

      const hasSnake = await manager.query(
        `SELECT 1 FROM information_schema.columns 
         WHERE table_schema = 'public' 
           AND table_name = 'pos_employee_attendance' 
           AND column_name = $1`,
        [snakeCol],
      );

      if (hasCamel.length > 0 && hasSnake.length === 0) {
        await manager.query(
          `ALTER TABLE public.pos_employee_attendance RENAME COLUMN "${camelCol}" TO ${snakeCol}`,
        );
      } else if (hasCamel.length > 0 && hasSnake.length > 0) {
        await manager.query(
          `UPDATE public.pos_employee_attendance 
           SET ${snakeCol} = "${camelCol}" 
           WHERE ${snakeCol} IS NULL AND "${camelCol}" IS NOT NULL`,
        );
        await manager.query(
          `ALTER TABLE public.pos_employee_attendance DROP COLUMN IF EXISTS "${camelCol}"`,
        );
      }
    }

    // 3. Ensure constraints use snake_case columns
    await manager.query(`
      ALTER TABLE public.pos_employee_attendance 
        DROP CONSTRAINT IF EXISTS pos_employee_attendance_status_chk,
        DROP CONSTRAINT IF EXISTS pos_employee_attendance_clock_range_chk,
        DROP CONSTRAINT IF EXISTS pos_employee_attendance_status_clock_chk
    `);

    // Legacy completed shifts have the same meaning as CLOCK_OUT.
    await manager.query(`
      UPDATE public.pos_employee_attendance SET status = 'CLOCK_OUT'
      WHERE status = 'COMPLETED' AND clock_out IS NOT NULL
    `);

    await manager.query(`
      ALTER TABLE public.pos_employee_attendance
        ADD CONSTRAINT pos_employee_attendance_status_chk
          CHECK (status IN ('PRESENT', 'CLOCK_OUT', 'INCOMPLETE')),
        ADD CONSTRAINT pos_employee_attendance_clock_range_chk
          CHECK (clock_out IS NULL OR clock_out >= clock_in),
        ADD CONSTRAINT pos_employee_attendance_status_clock_chk
          CHECK (
            (clock_out IS NULL AND status IN ('PRESENT', 'INCOMPLETE'))
            OR
            (clock_out IS NOT NULL AND status = 'CLOCK_OUT')
          )
    `);

    // 4. Ensure indexes use snake_case columns
    await manager.query(`
      DROP INDEX IF EXISTS public.pos_employee_attendance_one_open_idx;
      DROP INDEX IF EXISTS public.pos_employee_attendance_store_clock_in_idx;
      DROP INDEX IF EXISTS public.pos_employee_attendance_employee_clock_in_idx;
    `);

    await manager.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS pos_employee_attendance_one_open_idx
      ON public.pos_employee_attendance (employee_id)
      WHERE clock_out IS NULL
    `);
    await manager.query(`
      CREATE INDEX IF NOT EXISTS pos_employee_attendance_store_clock_in_idx
      ON public.pos_employee_attendance (merchant_id, store_id, clock_in DESC)
    `);
    await manager.query(`
      CREATE INDEX IF NOT EXISTS pos_employee_attendance_employee_clock_in_idx
      ON public.pos_employee_attendance (employee_id, clock_in DESC)
    `);
  });
}
