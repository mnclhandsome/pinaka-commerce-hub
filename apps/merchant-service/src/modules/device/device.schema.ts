import { DataSource } from 'typeorm';

export async function ensureMerchantDevicesSchema(db: DataSource): Promise<void> {
  await db.transaction(async manager => {
    await manager.query('SELECT pg_advisory_xact_lock(724621, 55)');
    // Keep the activation field available before any device list query runs.
    await manager.query('ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS device_active_code varchar(100)');
    await manager.query('ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS authorization_code varchar(100)');
    await manager.query('ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS device_id text');
    await manager.query(`
      UPDATE public.devices 
      SET authorization_code = device_active_code 
      WHERE authorization_code IS NULL AND device_active_code IS NOT NULL
    `);
    await manager.query(`
      UPDATE public.devices 
      SET device_active_code = authorization_code 
      WHERE device_active_code IS NULL AND authorization_code IS NOT NULL
    `);
    await manager.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS devices_device_active_code_uidx
      ON public.devices (device_active_code)
      WHERE device_active_code IS NOT NULL AND device_active_code <> ''
    `);
    await manager.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS devices_authorization_code_uidx
      ON public.devices (authorization_code)
      WHERE authorization_code IS NOT NULL AND authorization_code <> ''
    `);
    await manager.query(`
      CREATE TABLE IF NOT EXISTS public.merchant_devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id uuid NOT NULL,
        merchant_id varchar(100) NOT NULL,
        created_by varchar(100),
        updated_by varchar(100),
        is_deleted boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await manager.query(`
      DO $migration$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='devices') THEN
          BEGIN
            ALTER TABLE public.devices ADD CONSTRAINT pk_devices_id PRIMARY KEY (id);
          EXCEPTION WHEN OTHERS THEN
            NULL;
          END;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.merchant_devices'::regclass
            AND confrelid = 'public.devices'::regclass
            AND contype = 'f'
        ) THEN
          BEGIN
            ALTER TABLE public.merchant_devices
              ADD CONSTRAINT fk_merchant_devices_device_id
              FOREIGN KEY (device_id) REFERENCES public.devices(id);
          EXCEPTION WHEN OTHERS THEN
            NULL;
          END;
        END IF;
      END
      $migration$
    `);
    await manager.query(`
      CREATE INDEX IF NOT EXISTS idx_merchant_devices_merchant_id
      ON public.merchant_devices (merchant_id) WHERE is_deleted = false
    `);
    await manager.query(`
      CREATE INDEX IF NOT EXISTS idx_merchant_devices_device_id
      ON public.merchant_devices (device_id) WHERE is_deleted = false
    `);
    await manager.query(`
      INSERT INTO public.merchant_devices (device_id, merchant_id, created_by, updated_by)
      SELECT d.id,
             COALESCE(NULLIF(to_jsonb(d)->>'merchant_id', ''), NULLIF(to_jsonb(d)->>'merchantId', '')),
             NULLIF(COALESCE(to_jsonb(d)->>'created_by', to_jsonb(d)->>'createdBy'), ''),
             NULLIF(COALESCE(to_jsonb(d)->>'updated_by', to_jsonb(d)->>'updatedBy'), '')
      FROM public.devices d
      WHERE COALESCE(NULLIF(to_jsonb(d)->>'merchant_id', ''), NULLIF(to_jsonb(d)->>'merchantId', '')) IS NOT NULL
        AND COALESCE((to_jsonb(d)->>'is_deleted')::boolean, false) = false
        AND NOT EXISTS (
          SELECT 1 FROM public.merchant_devices md
          WHERE md.device_id = d.id
        )
    `);
  });
}
