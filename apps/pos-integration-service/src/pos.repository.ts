import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import Redis from 'ioredis';
import { connectPostgres, createMissingTables } from '@pinaka-delivery-hub/database';
import { PosShiftEntity, ShiftDenominationData, ShiftStatus } from './entities/pos-shift.entity';
import { CashMovementEntity, MovementType } from './entities/cash-movement.entity';

async function ensurePosShiftSnakeCaseSchema(dataSource: DataSource): Promise<void> {
  try {
    // 1. Create table if not exists with all snake_case columns
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS public.pos_shifts (
        id VARCHAR(100) PRIMARY KEY,
        merchant_id VARCHAR(100) NOT NULL,
        store_id VARCHAR(100) NOT NULL,
        register_id UUID,
        device_id VARCHAR(100) NOT NULL,
        opening_device_id UUID,
        opened_by_employee_id UUID,
        closed_by_employee_id UUID,
        shift_number VARCHAR(100),
        cashier_name VARCHAR(150) NOT NULL,
        opening_cash DECIMAL(10,2) DEFAULT 200.00,
        total_cash_sales DECIMAL(10,2) DEFAULT 0.00,
        total_card_sales DECIMAL(10,2) DEFAULT 0.00,
        total_safe_drops DECIMAL(10,2) DEFAULT 0.00,
        total_paid_outs DECIMAL(10,2) DEFAULT 0.00,
        drawer_denominations JSONB,
        drawer_total_amount DECIMAL(12,2),
        tube_denominations JSONB,
        tube_total_amount DECIMAL(12,2),
        total_amount DECIMAL(12,2),
        closing_cash_actual DECIMAL(10,2),
        expected_cash_in_drawer DECIMAL(10,2),
        declared_cash DECIMAL(10,2),
        cash_difference DECIMAL(10,2),
        discrepancy DECIMAL(10,2),
        opening_note TEXT,
        closing_note TEXT,
        status VARCHAR(50) DEFAULT 'OPEN',
        opened_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Add any missing snake_case columns to existing pos_shifts table
    await dataSource.query(`
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS merchant_id VARCHAR(100);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS store_id VARCHAR(100);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS register_id UUID;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS device_id VARCHAR(100);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS opening_device_id UUID;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS opened_by_employee_id UUID;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS closed_by_employee_id UUID;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS shift_number VARCHAR(100);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS cashier_name VARCHAR(150);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS opening_cash DECIMAL(10,2) DEFAULT 200.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_cash_sales DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_card_sales DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_safe_drops DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_paid_outs DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS drawer_denominations JSONB;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS drawer_total_amount DECIMAL(12,2);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS tube_denominations JSONB;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS tube_total_amount DECIMAL(12,2);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_amount DECIMAL(12,2);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS closing_cash_actual DECIMAL(10,2);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS expected_cash_in_drawer DECIMAL(10,2);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS declared_cash DECIMAL(10,2);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS cash_difference DECIMAL(10,2);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS discrepancy DECIMAL(10,2);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS opening_note TEXT;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS closing_note TEXT;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'OPEN';
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
    `);

    // 3. Migrate legacy camelCase column values to snake_case column values and drop legacy columns
    await dataSource.query(`
      DO $$
      DECLARE
        col RECORD;
      BEGIN
        FOR col IN
          SELECT legacy_col, snake_col FROM (VALUES
            ('merchantId', 'merchant_id'),
            ('storeId', 'store_id'),
            ('registerId', 'register_id'),
            ('terminalId', 'device_id'),
            ('terminal_id', 'device_id'),
            ('openingDeviceId', 'opening_device_id'),
            ('openedByEmployeeId', 'opened_by_employee_id'),
            ('closedByEmployeeId', 'closed_by_employee_id'),
            ('shiftNumber', 'shift_number'),
            ('cashierName', 'cashier_name'),
            ('openingCash', 'opening_cash'),
            ('totalCashSales', 'total_cash_sales'),
            ('totalCardSales', 'total_card_sales'),
            ('totalSafeDrops', 'total_safe_drops'),
            ('totalPaidOuts', 'total_paid_outs'),
            ('closingCashActual', 'closing_cash_actual'),
            ('expectedCashInDrawer', 'expected_cash_in_drawer'),
            ('declaredCash', 'declared_cash'),
            ('cashDifference', 'cash_difference'),
            ('openingNote', 'opening_note'),
            ('closingNote', 'closing_note'),
            ('openedAt', 'opened_at'),
            ('closedAt', 'closed_at'),
            ('createdAt', 'created_at'),
            ('updatedAt', 'updated_at')
          ) AS t(legacy_col, snake_col)
        LOOP
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' AND table_name = 'pos_shifts' AND column_name = col.legacy_col
          ) THEN
            EXECUTE format('UPDATE public.pos_shifts SET %I = %I WHERE %I IS NULL AND %I IS NOT NULL', col.snake_col, col.legacy_col, col.snake_col, col.legacy_col);
            IF col.legacy_col <> col.snake_col THEN
              EXECUTE format('ALTER TABLE public.pos_shifts DROP COLUMN IF EXISTS %I', col.legacy_col);
            END IF;
          END IF;
        END LOOP;
      END $$;
    `);

    // 4. Ensure cash_movements table with snake_case columns and drop legacy camelCase columns
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS public.cash_movements (
        id VARCHAR(100) PRIMARY KEY,
        shift_id VARCHAR(100) NOT NULL,
        store_id VARCHAR(100) NOT NULL,
        movement_type VARCHAR(50) DEFAULT 'SAFE_DROP',
        amount DECIMAL(10,2) NOT NULL,
        performed_by VARCHAR(255) NOT NULL,
        reason VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE public.cash_movements ADD COLUMN IF NOT EXISTS shift_id VARCHAR(100);
      ALTER TABLE public.cash_movements ADD COLUMN IF NOT EXISTS store_id VARCHAR(100);
      ALTER TABLE public.cash_movements ADD COLUMN IF NOT EXISTS movement_type VARCHAR(50) DEFAULT 'SAFE_DROP';
      ALTER TABLE public.cash_movements ADD COLUMN IF NOT EXISTS performed_by VARCHAR(255);
      ALTER TABLE public.cash_movements ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_movements' AND column_name = 'shiftId') THEN
          UPDATE public.cash_movements SET shift_id = "shiftId" WHERE shift_id IS NULL AND "shiftId" IS NOT NULL;
          ALTER TABLE public.cash_movements DROP COLUMN IF EXISTS "shiftId";
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_movements' AND column_name = 'storeId') THEN
          UPDATE public.cash_movements SET store_id = "storeId" WHERE store_id IS NULL AND "storeId" IS NOT NULL;
          ALTER TABLE public.cash_movements DROP COLUMN IF EXISTS "storeId";
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_movements' AND column_name = 'movementType') THEN
          UPDATE public.cash_movements SET movement_type = "movementType" WHERE movement_type IS NULL AND "movementType" IS NOT NULL;
          ALTER TABLE public.cash_movements DROP COLUMN IF EXISTS "movementType";
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_movements' AND column_name = 'performedBy') THEN
          UPDATE public.cash_movements SET performed_by = "performedBy" WHERE performed_by IS NULL AND "performedBy" IS NOT NULL;
          ALTER TABLE public.cash_movements DROP COLUMN IF EXISTS "performedBy";
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_movements' AND column_name = 'createdAt') THEN
          UPDATE public.cash_movements SET created_at = "createdAt" WHERE created_at IS NULL AND "createdAt" IS NOT NULL;
          ALTER TABLE public.cash_movements DROP COLUMN IF EXISTS "createdAt";
        END IF;
      END $$;
    `);
  } catch (err: any) {
    console.error('⚠️ [pos_shifts schema alignment error]:', err.message);
  }
}

@Injectable()
export class PosRepository implements OnModuleInit {
  private dataSource?: DataSource;
  private shiftRepo?: Repository<PosShiftEntity>;
  private movementRepo?: Repository<CashMovementEntity>;
  private redisClient?: Redis;
  private isDbConnected = false;
  private isRedisConnected = false;

  private inMemoryShifts: PosShiftEntity[] = [];
  private inMemoryMovements: CashMovementEntity[] = [];

  async onModuleInit() {
    this.dataSource = await connectPostgres('POS Integration DB', [
      PosShiftEntity,
      CashMovementEntity,
    ], { synchronize: false });
    await createMissingTables(this.dataSource);
    await ensurePosShiftSnakeCaseSchema(this.dataSource);
    await this.ensureSafeTransactionShiftConstraints();
    this.shiftRepo = this.dataSource.getRepository(PosShiftEntity);
    this.movementRepo = this.dataSource.getRepository(CashMovementEntity);
    this.isDbConnected = true;

    try {
      this.redisClient = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
      await this.redisClient.connect();
      this.isRedisConnected = true;
      console.log('⚡ [POS Integration Redis] Connected to Redis Container');
    } catch (err: any) {
      console.log(`⚠️ [POS Integration Redis] Offline (${err.message}).`);
      this.isRedisConnected = false;
    }
  }

  private async ensureSafeTransactionShiftConstraints() {
    await this.dataSource?.query(`
      DO $$ BEGIN
        IF to_regclass('public.pos_safe_transactions') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'pos_safe_transactions_shift_fk'
        ) THEN
          ALTER TABLE public.pos_safe_transactions ADD CONSTRAINT pos_safe_transactions_shift_fk
            FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON DELETE RESTRICT;
        END IF;
        IF to_regclass('public.pos_safe_drop_transactions') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'pos_safe_drop_transactions_shift_fk'
        ) THEN
          ALTER TABLE public.pos_safe_drop_transactions ADD CONSTRAINT pos_safe_drop_transactions_shift_fk
            FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON DELETE RESTRICT;
        END IF;
      END $$;
    `);
  }

  // --- Open Cashier Shift ---
  async openShift(
    merchantId: string,
    storeId: string,
    terminalId: string,
    cashierName: string,
    openingCash: number,
    registerId?: string,
    denominationData: ShiftDenominationData = {},
    openedByEmployeeId?: string,
  ): Promise<PosShiftEntity> {
    const shift: PosShiftEntity = {
      id: `SHIFT-${randomUUID()}`,
      merchantId,
      storeId,
      registerId,
      openedByEmployeeId,
      terminalId: terminalId || 'SUNMI-D3-01',
      cashierName: cashierName || 'Cashier',
      openingCash: Number(openingCash),
      totalCashSales: 0.00,
      totalCardSales: 0.00,
      totalSafeDrops: 0.00,
      totalPaidOuts: 0.00,
      ...denominationData,
      status: ShiftStatus.OPEN,
      openedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (this.isDbConnected && this.shiftRepo) {
      const entity = this.shiftRepo.create(shift);
      const saved = await this.shiftRepo.save(entity);
      await this.cacheActiveShift(storeId, saved);
      return saved;
    } else {
      this.inMemoryShifts.unshift(shift);
      await this.cacheActiveShift(storeId, shift);
      return shift;
    }
  }

  // --- Record Safe Drop / Cash Movement ---
  async recordCashMovement(shiftId: string, storeId: string, movementType: MovementType, amount: number, performedBy: string, reason?: string): Promise<CashMovementEntity> {
    const movement: CashMovementEntity = {
      id: `CSH-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      shiftId,
      storeId,
      movementType,
      amount: Number(amount),
      performedBy: performedBy || 'Manager',
      reason: reason || 'Cash Drawer Management',
      createdAt: new Date(),
    };

    if (this.isDbConnected && this.movementRepo && this.shiftRepo) {
      const entity = this.movementRepo.create(movement);
      const saved = await this.movementRepo.save(entity);

      const shift = await this.shiftRepo.findOne({ where: { id: shiftId } });
      if (shift) {
        if (movementType === MovementType.SAFE_DROP) shift.totalSafeDrops = Number(shift.totalSafeDrops) + Number(amount);
        if (movementType === MovementType.PAID_OUT) shift.totalPaidOuts = Number(shift.totalPaidOuts) + Number(amount);
        await this.shiftRepo.save(shift);
        await this.cacheActiveShift(storeId, shift);
      }
      return saved;
    } else {
      this.inMemoryMovements.unshift(movement);
      const shift = this.inMemoryShifts.find((s) => s.id === shiftId);
      if (shift) {
        if (movementType === MovementType.SAFE_DROP) shift.totalSafeDrops = Number(shift.totalSafeDrops) + Number(amount);
        if (movementType === MovementType.PAID_OUT) shift.totalPaidOuts = Number(shift.totalPaidOuts) + Number(amount);
      }
      return movement;
    }
  }

  // --- Close Shift & Generate Z-Report ---
  async closeShift(shiftId: string, closingCashActual: number, closedByEmployeeId?: string): Promise<{ success: boolean; shift?: PosShiftEntity; message?: string }> {
    let shift: PosShiftEntity | null = null;

    if (this.isDbConnected && this.shiftRepo) {
      shift = await this.shiftRepo.findOne({ where: { id: shiftId } });
      if (shift) {
        const sales = (await this.getSalesByShift([shift.id])).get(shift.id);
        if (sales) {
          shift.totalCashSales = sales.cash;
          shift.totalCardSales = sales.card;
        }
        const expected = Number(shift.openingCash) + Number(shift.totalCashSales) - Number(shift.totalSafeDrops) - Number(shift.totalPaidOuts);
        shift.closingCashActual = Number(closingCashActual);
        shift.expectedCashInDrawer = expected;
        shift.discrepancy = Number(closingCashActual) - expected;
        shift.status = ShiftStatus.CLOSED;
        shift.closedAt = new Date();
        if (closedByEmployeeId) shift.closedByEmployeeId = closedByEmployeeId;
        shift = await this.shiftRepo.save(shift);
      }
    } else {
      shift = this.inMemoryShifts.find((s) => s.id === shiftId) || null;
      if (shift) {
        const expected = Number(shift.openingCash) + Number(shift.totalCashSales) - Number(shift.totalSafeDrops) - Number(shift.totalPaidOuts);
        shift.closingCashActual = Number(closingCashActual);
        shift.expectedCashInDrawer = expected;
        shift.discrepancy = Number(closingCashActual) - expected;
        shift.status = ShiftStatus.CLOSED;
        shift.closedAt = new Date();
        if (closedByEmployeeId) shift.closedByEmployeeId = closedByEmployeeId;
      }
    }

    if (!shift) {
      return { success: false, message: `Shift '${shiftId}' not found` };
    }

    return { success: true, shift };
  }

  async getActiveShifts(storeId: string): Promise<PosShiftEntity[]> {
    if (this.isDbConnected && this.shiftRepo) {
      return await this.shiftRepo.find({
        where: { storeId, status: ShiftStatus.OPEN },
        order: { openedAt: 'DESC', createdAt: 'DESC' },
      });
    }
    return this.inMemoryShifts
      .filter((shift) => shift.storeId === storeId && shift.status === ShiftStatus.OPEN)
      .sort((left, right) => right.openedAt.getTime() - left.openedAt.getTime());
  }

  async getShiftsByEmployee(employeeId: string, storeId?: string): Promise<PosShiftEntity[]> {
    if (this.isDbConnected && this.shiftRepo) {
      const shifts = await this.shiftRepo.find({
        where: { openedByEmployeeId: employeeId, ...(storeId ? { storeId } : {}) },
        order: { openedAt: 'DESC', createdAt: 'DESC' },
      });
      return this.withOrderSales(shifts);
    }
    return this.inMemoryShifts
      .filter((shift) => shift.openedByEmployeeId === employeeId && (!storeId || shift.storeId === storeId))
      .sort((left, right) => right.openedAt.getTime() - left.openedAt.getTime());
  }

  // Cash/card sales per shift from store_orders (order-service, same database),
  // matched on the PCH shift id the POS app sends in order meta_data.shift_id.
  // Split tenders come from meta_data._pos_payments; otherwise the order's
  // payment_method decides. Anything that is not cash counts as card.
  private async getSalesByShift(shiftIds: string[]): Promise<Map<string, { cash: number; card: number }>> {
    const sales = new Map<string, { cash: number; card: number }>();
    if (!this.dataSource || shiftIds.length === 0) return sales;
    try {
      const rows: Array<{ shift_id: string; cash: string; card: string }> = await this.dataSource.query(
        `WITH shift_orders AS (
           SELECT so.shift_id, so.total, lower(coalesce(so.payment_method, '')) AS method,
                  (SELECT e->'value'
                     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(so.meta_data) = 'array' THEN so.meta_data ELSE '[]'::jsonb END) e
                    WHERE e->>'key' = '_pos_payments' LIMIT 1) AS split
             FROM public.store_orders so
            WHERE so.shift_id = ANY($1)
              AND lower(so.status) IN ('completed', 'processing')
              AND NOT so.pay_later
         ),
         tenders AS (
           SELECT shift_id, lower(coalesce(p->>'method', '')) AS method, (p->>'amount')::numeric AS amount
             FROM shift_orders,
                  jsonb_array_elements(CASE WHEN jsonb_typeof(split) = 'array' THEN split ELSE '[]'::jsonb END) p
            WHERE lower(coalesce(p->>'status', 'completed')) = 'completed'
           UNION ALL
           SELECT shift_id, method, total
             FROM shift_orders
            WHERE jsonb_array_length(CASE WHEN jsonb_typeof(split) = 'array' THEN split ELSE '[]'::jsonb END) = 0
         )
         SELECT shift_id,
                coalesce(sum(amount) FILTER (WHERE method = 'cash'), 0) AS cash,
                coalesce(sum(amount) FILTER (WHERE method <> 'cash'), 0) AS card
           FROM tenders
          GROUP BY shift_id`,
        [shiftIds],
      );
      for (const row of rows) {
        sales.set(row.shift_id, { cash: Number(row.cash), card: Number(row.card) });
      }
    } catch (error) {
      console.error('[POS] Could not total shift sales from store_orders:', error);
    }
    return sales;
  }

  // Fills sales from orders and recomputes expected cash / over-short for closed shifts.
  private async withOrderSales(shifts: PosShiftEntity[]): Promise<PosShiftEntity[]> {
    const sales = await this.getSalesByShift(shifts.map((shift) => shift.id));
    for (const shift of shifts) {
      const totals = sales.get(shift.id);
      if (!totals) continue;
      shift.totalCashSales = totals.cash;
      shift.totalCardSales = totals.card;
      if (shift.closingCashActual !== null && shift.closingCashActual !== undefined) {
        const expected = Number(shift.openingCash) + totals.cash - Number(shift.totalSafeDrops) - Number(shift.totalPaidOuts);
        shift.expectedCashInDrawer = expected;
        shift.discrepancy = Number(shift.closingCashActual) - expected;
      }
    }
    return shifts;
  }

  async getShiftWithSafeTransactions(shiftId: string, storeId: string) {
    const found = await this.shiftRepo?.findOne({ where: { id: shiftId, storeId } });
    if (!found) return null;
    const [shift] = await this.withOrderSales([found]);
    const safes = await this.dataSource!.query(
      `SELECT id AS safe_id, title, created_at, safe_data, shift_id, created_by
       FROM public.pos_safe_transactions WHERE shift_id = $1 ORDER BY created_at DESC, id DESC`,
      [shiftId],
    );
    const safe_drops = await this.dataSource!.query(
      `SELECT id AS safe_drop_id, title, created_at, safe_data, shift_id, created_by
       FROM public.pos_safe_drop_transactions WHERE shift_id = $1 ORDER BY created_at DESC, id DESC`,
      [shiftId],
    );
    return {
      id: shift.id,
      merchant_id: shift.merchantId,
      store_id: shift.storeId,
      register_id: shift.registerId,
      device_id: shift.terminalId,
      opening_device_id: shift.openingDeviceId,
      opened_by_employee_id: shift.openedByEmployeeId,
      closed_by_employee_id: shift.closedByEmployeeId,
      shift_number: shift.shiftNumber,
      cashier_name: shift.cashierName,
      opening_cash: shift.openingCash,
      total_cash_sales: shift.totalCashSales,
      total_card_sales: shift.totalCardSales,
      total_safe_drops: shift.totalSafeDrops,
      total_paid_outs: shift.totalPaidOuts,
      drawer_denominations: shift.drawer_denominations,
      drawer_total_amount: shift.drawer_total_amount,
      tube_denominations: shift.tube_denominations,
      tube_total_amount: shift.tube_total_amount,
      total_amount: shift.total_amount,
      closing_cash_actual: shift.closingCashActual,
      expected_cash_in_drawer: shift.expectedCashInDrawer,
      declared_cash: shift.declaredCash,
      cash_difference: shift.cashDifference,
      discrepancy: shift.discrepancy,
      opening_note: shift.openingNote,
      closing_note: shift.closingNote,
      status: shift.status,
      opened_at: shift.openedAt,
      closed_at: shift.closedAt,
      created_at: shift.createdAt,
      updated_at: shift.updatedAt,
      safes,
      safe_drops,
    };
  }

  private async cacheActiveShift(storeId: string, shift: PosShiftEntity) {
    if (this.isRedisConnected && this.redisClient) {
      try {
        await this.redisClient.set(`shift:${storeId}`, JSON.stringify(shift), 'EX', 86400);
      } catch {}
    }
  }
}
