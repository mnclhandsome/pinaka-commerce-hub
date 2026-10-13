import { DataSource } from 'typeorm';

export async function ensureStorePosPaymentsSchema(db: DataSource): Promise<void> {
  await db.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock(724621, 53)');
    await manager.query(`
      DO $enum$
      BEGIN
        CREATE TYPE public.store_pos_payment_type AS ENUM (
          'pos_payment',
          'vendor_payment'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END
      $enum$
    `);
    await manager.query(`
      CREATE TABLE IF NOT EXISTS public.store_pos_payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
        merchant_id uuid NOT NULL,
        store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
        local_id varchar(150),
        client_order_id varchar(150),
        device_id varchar(150),
        shift_id varchar(150),
        user_id varchar(150),
        payment_type public.store_pos_payment_type NOT NULL,
        payment_method varchar(100) NOT NULL,
        payment_method_title varchar(150),
        amount numeric(12, 2) NOT NULL CHECK (amount >= 0),
        order_total numeric(12, 2) NOT NULL CHECK (order_total >= 0),
        remaining numeric(12, 2) NOT NULL DEFAULT 0 CHECK (remaining >= 0),
        currency varchar(3),
        status varchar(50) NOT NULL DEFAULT 'completed',
        entry_type varchar(20) NOT NULL DEFAULT 'payment'
          CHECK (entry_type IN ('payment', 'refund', 'void')),
        parent_payment_id uuid REFERENCES public.store_pos_payments(id),
        is_void boolean NOT NULL DEFAULT false,
        provider varchar(100),
        provider_transaction_id varchar(255),
        provider_response jsonb,
        payment_at timestamptz NOT NULL DEFAULT now(),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      )
    `);
    await manager.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS store_pos_payments_sync_uidx
      ON public.store_pos_payments (store_id, order_id, device_id, local_id)
      WHERE local_id IS NOT NULL AND deleted_at IS NULL
    `);
    await manager.query(`
      CREATE INDEX IF NOT EXISTS store_pos_payments_store_time_idx
      ON public.store_pos_payments (merchant_id, store_id, payment_at DESC)
      WHERE deleted_at IS NULL
    `);
    await manager.query(`
      CREATE INDEX IF NOT EXISTS store_pos_payments_order_idx
      ON public.store_pos_payments (order_id)
      WHERE deleted_at IS NULL
    `);
    await manager.query(`
      CREATE INDEX IF NOT EXISTS store_pos_payments_shift_idx
      ON public.store_pos_payments (store_id, shift_id, payment_at DESC)
      WHERE deleted_at IS NULL
    `);
  });
}
