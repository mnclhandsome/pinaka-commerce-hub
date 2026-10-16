const { Client } = require('pg');

const databasesToMigrate = [
  process.env.POSTGRES_DB || 'pinaka_commerce_hub_new',
  'pinaka_commerce_hub'
];

// Dedupe databases
const databases = Array.from(new Set(databasesToMigrate));

async function migrateDatabase(dbName) {
  const client = new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT) || 5432,
    user: process.env.POSTGRES_USER || 'pdh_user',
    password: process.env.POSTGRES_PASSWORD || 'pdh_password',
    database: dbName,
  });

  try {
    await client.connect();
    console.log(`\n🔹 Connected to ${dbName}...`);

    // 1. Ensure table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.pos_shifts (
        id VARCHAR(100) PRIMARY KEY,
        merchant_id VARCHAR(100) NOT NULL,
        store_id VARCHAR(100) NOT NULL,
        register_id UUID,
        device_id VARCHAR(100) NOT NULL,
        opening_device_id UUID,
        opened_by_employee_id UUID,
        closed_by_employee_id UUID,
        closed_by_device_id VARCHAR(100),
        shift_number VARCHAR(100),
        cashier_name VARCHAR(150) NOT NULL,
        opening_cash DECIMAL(10,2) DEFAULT 200.00,
        total_cash_sales DECIMAL(10,2) DEFAULT 0.00,
        total_card_sales DECIMAL(10,2) DEFAULT 0.00,
        total_safe_drops DECIMAL(10,2) DEFAULT 0.00,
        total_paid_outs DECIMAL(10,2) DEFAULT 0.00,
        total_orders INTEGER DEFAULT 0,
        total_order_sale_amount DECIMAL(12,2) DEFAULT 0.00,
        total_cashback DECIMAL(10,2) DEFAULT 0.00,
        total_payouts DECIMAL(10,2) DEFAULT 0.00,
        total_ebt_sales DECIMAL(10,2) DEFAULT 0.00,
        total_pay_later DECIMAL(10,2) DEFAULT 0.00,
        total_refunds DECIMAL(10,2) DEFAULT 0.00,
        total_cancelled_orders INTEGER DEFAULT 0,
        total_void_items INTEGER DEFAULT 0,
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

    // 2. Add any missing snake_case columns
    await client.query(`
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS merchant_id VARCHAR(100);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS store_id VARCHAR(100);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS register_id UUID;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS device_id VARCHAR(100);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS opening_device_id UUID;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS opened_by_employee_id UUID;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS closed_by_employee_id UUID;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS closed_by_device_id VARCHAR(100);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS shift_number VARCHAR(100);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS cashier_name VARCHAR(150);
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS opening_cash DECIMAL(10,2) DEFAULT 200.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_cash_sales DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_card_sales DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_safe_drops DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_paid_outs DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_orders INTEGER DEFAULT 0;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_order_sale_amount DECIMAL(12,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_cashback DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_payouts DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_ebt_sales DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_pay_later DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_refunds DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_cancelled_orders INTEGER DEFAULT 0;
      ALTER TABLE public.pos_shifts ADD COLUMN IF NOT EXISTS total_void_items INTEGER DEFAULT 0;
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

    // 3. Migrate and Drop legacy camelCase columns from pos_shifts
    const camelColumns = [
      ['merchantId', 'merchant_id'],
      ['storeId', 'store_id'],
      ['registerId', 'register_id'],
      ['terminalId', 'device_id'],
      ['terminal_id', 'device_id'],
      ['openingDeviceId', 'opening_device_id'],
      ['openedByEmployeeId', 'opened_by_employee_id'],
      ['closedByEmployeeId', 'closed_by_employee_id'],
      ['shiftNumber', 'shift_number'],
      ['cashierName', 'cashier_name'],
      ['openingCash', 'opening_cash'],
      ['totalCashSales', 'total_cash_sales'],
      ['totalCardSales', 'total_card_sales'],
      ['totalSafeDrops', 'total_safe_drops'],
      ['totalPaidOuts', 'total_paid_outs'],
      ['closingCashActual', 'closing_cash_actual'],
      ['expectedCashInDrawer', 'expected_cash_in_drawer'],
      ['declaredCash', 'declared_cash'],
      ['cashDifference', 'cash_difference'],
      ['openingNote', 'opening_note'],
      ['closingNote', 'closing_note'],
      ['openedAt', 'opened_at'],
      ['closedAt', 'closed_at'],
      ['createdAt', 'created_at'],
      ['updatedAt', 'updated_at']
    ];

    for (const [legacyCol, snakeCol] of camelColumns) {
      const check = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pos_shifts' AND column_name = $1`,
        [legacyCol]
      );
      if (check.rows.length > 0) {
        await client.query(`UPDATE public.pos_shifts SET "${snakeCol}" = "${legacyCol}" WHERE "${snakeCol}" IS NULL AND "${legacyCol}" IS NOT NULL`);
        if (legacyCol !== snakeCol) {
          await client.query(`ALTER TABLE public.pos_shifts DROP COLUMN IF EXISTS "${legacyCol}"`);
          console.log(`   Dropped legacy camelCase column: pos_shifts."${legacyCol}"`);
        }
      }
    }

    // 4. Migrate and Drop legacy camelCase columns from cash_movements
    const cashMovementsCamel = [
      ['shiftId', 'shift_id'],
      ['storeId', 'store_id'],
      ['movementType', 'movement_type'],
      ['performedBy', 'performed_by'],
      ['createdAt', 'created_at']
    ];

    await client.query(`
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
    `);

    for (const [legacyCol, snakeCol] of cashMovementsCamel) {
      const check = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_movements' AND column_name = $1`,
        [legacyCol]
      );
      if (check.rows.length > 0) {
        await client.query(`UPDATE public.cash_movements SET "${snakeCol}" = "${legacyCol}" WHERE "${snakeCol}" IS NULL AND "${legacyCol}" IS NOT NULL`);
        await client.query(`ALTER TABLE public.cash_movements DROP COLUMN IF EXISTS "${legacyCol}"`);
        console.log(`   Dropped legacy camelCase column: cash_movements."${legacyCol}"`);
      }
    }

    // 5. Display current columns in pos_shifts
    const columnsRes = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'pos_shifts' 
      ORDER BY ordinal_position
    `);
    console.log(`\n✅ pos_shifts final columns in ${dbName}:`);
    columnsRes.rows.forEach(r => console.log(`   - ${r.column_name} (${r.data_type})`));

    await client.end();
  } catch (err) {
    console.log(`ℹ️ Could not migrate ${dbName} (${err.message})`);
  }
}

async function run() {
  for (const db of databases) {
    await migrateDatabase(db);
  }
  console.log('\n🎉 All database migrations complete!');
}

run();
