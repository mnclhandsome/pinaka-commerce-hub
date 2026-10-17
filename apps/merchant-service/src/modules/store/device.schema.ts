import { DataSource } from 'typeorm';

/** Align public.devices with DeviceEntity / device APIs (legacy rows used storeId + details jsonb). */
export async function ensureDeviceSchema(db: DataSource): Promise<void> {
  await db.transaction(async manager => {
    await manager.query('SELECT pg_advisory_xact_lock(724621, 44)');
    await manager.query(`
      CREATE TABLE IF NOT EXISTS public.devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "merchantId" varchar(100) NOT NULL,
        "merchantName" varchar(255) NOT NULL DEFAULT '',
        "device_code" varchar(100) NOT NULL,
        "serialNumber" varchar(100) NOT NULL,
        "deviceType" varchar(100) NOT NULL DEFAULT 'Other',
        status varchar(20) NOT NULL DEFAULT 'Active',
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);

    await manager.query(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS device_code varchar(100)`);
    await manager.query(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS status varchar(20) DEFAULT 'Active'`);
    await manager.query(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS "storeId" varchar(100)`);
    await manager.query(`ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS details jsonb DEFAULT '{}'::jsonb`);

    await manager.query(`
      DO $body$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='devices' AND column_name='storeId' AND is_nullable='NO'
        ) THEN
          ALTER TABLE public.devices ALTER COLUMN "storeId" DROP NOT NULL;
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='devices' AND column_name='details' AND is_nullable='NO'
        ) THEN
          ALTER TABLE public.devices ALTER COLUMN details DROP NOT NULL;
          ALTER TABLE public.devices ALTER COLUMN details SET DEFAULT '{}'::jsonb;
        END IF;
      END
      $body$
    `);

    await manager.query(`UPDATE public.devices SET details = COALESCE(details, '{}'::jsonb) WHERE details IS NULL`);
    await manager.query(`
      UPDATE public.devices SET
        "deviceName" = COALESCE(NULLIF(BTRIM("deviceName"), ''), NULLIF(details->>'deviceName', ''), NULLIF(details->>'name', ''), 'Unnamed device'),
        device_code = COALESCE(NULLIF(BTRIM(device_code), ''), NULLIF(details->>'deviceCode', ''), NULLIF(details->>'code', ''), 'DEV-' || REPLACE(id::text, '-', '')),
        "deviceType" = COALESCE(NULLIF(BTRIM("deviceType"), ''), NULLIF(details->>'deviceType', ''), NULLIF(details->>'type', ''), 'Other'),
        "merchantName" = COALESCE(NULLIF(BTRIM("merchantName"), ''), NULLIF(details->>'merchantName', ''), "merchantId"),
        status = COALESCE(NULLIF(BTRIM(status), ''), NULLIF(details->>'status', ''), 'Active')
      WHERE "deviceName" IS NULL OR device_code IS NULL OR "deviceType" IS NULL OR "merchantName" IS NULL OR status IS NULL
         OR BTRIM(COALESCE("deviceName", '')) = '' OR BTRIM(COALESCE(device_code, '')) = ''
    `);

    await manager.query(`UPDATE public.devices SET "deviceName" = COALESCE(NULLIF(BTRIM("deviceName"), ''), 'Unnamed device') WHERE "deviceName" IS NULL OR BTRIM("deviceName") = ''`);
    await manager.query(`ALTER TABLE public.devices ALTER COLUMN "deviceName" SET NOT NULL`);
    await manager.query(`UPDATE public.devices SET device_code = COALESCE(NULLIF(BTRIM(device_code), ''), 'DEV-' || REPLACE(id::text, '-', '')) WHERE device_code IS NULL OR BTRIM(device_code) = ''`);
    await manager.query(`ALTER TABLE public.devices ALTER COLUMN device_code SET NOT NULL`);
    await manager.query(`UPDATE public.devices SET "deviceType" = COALESCE(NULLIF(BTRIM("deviceType"), ''), 'Other') WHERE "deviceType" IS NULL OR BTRIM("deviceType") = ''`);
    await manager.query(`ALTER TABLE public.devices ALTER COLUMN "deviceType" SET NOT NULL`);
    await manager.query(`UPDATE public.devices SET "merchantName" = COALESCE(NULLIF(BTRIM("merchantName"), ''), "merchantId") WHERE "merchantName" IS NULL OR BTRIM("merchantName") = ''`);
    await manager.query(`ALTER TABLE public.devices ALTER COLUMN "merchantName" SET NOT NULL`);
    await manager.query(`UPDATE public.devices SET status = COALESCE(NULLIF(BTRIM(status), ''), 'Active') WHERE status IS NULL OR BTRIM(status) = ''`);
    await manager.query(`ALTER TABLE public.devices ALTER COLUMN status SET NOT NULL`);
    await manager.query(`UPDATE public.devices SET "createdAt" = COALESCE("createdAt", now()) WHERE "createdAt" IS NULL`);
    await manager.query(`ALTER TABLE public.devices ALTER COLUMN "createdAt" SET NOT NULL`);
    await manager.query(`ALTER TABLE public.devices ALTER COLUMN "merchantId" SET NOT NULL`);
    await manager.query(`ALTER TABLE public.devices ALTER COLUMN "serialNumber" SET NOT NULL`);

    await manager.query(`CREATE UNIQUE INDEX IF NOT EXISTS devices_device_code_uq ON public.devices (device_code)`);
    await manager.query(`CREATE UNIQUE INDEX IF NOT EXISTS devices_serial_number_uq ON public.devices ("serialNumber")`);
    await manager.query(`CREATE INDEX IF NOT EXISTS devices_merchant_id_idx ON public.devices ("merchantId")`);
  });
}
