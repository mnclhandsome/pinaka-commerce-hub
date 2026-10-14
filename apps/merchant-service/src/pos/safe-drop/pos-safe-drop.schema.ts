import { DataSource } from 'typeorm';

/** One safe-and-drop row per store, with tube and drop denominations in their own tables. */
export async function ensurePosSafeDropSchema(db: DataSource): Promise<void> {
  await db.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock(724621, 51)');
    await manager.query(`
      DO $$
      DECLARE column_map RECORD; column_exists boolean; conflicting_values boolean;
      BEGIN
        FOR column_map IN SELECT * FROM (VALUES
          ('pos_safe_drop_settings', 'storeId', 'store_id'),
          ('pos_safe_drop_settings', 'merchantId', 'merchant_id'),
          ('pos_safe_drop_settings', 'primarySafe', 'primary_safe'),
          ('pos_safe_drop_settings', 'dropEnabled', 'drop_enabled'),
          ('pos_safe_drop_settings', 'managerApproval', 'manager_approval'),
          ('pos_safe_drop_settings', 'cashierInitiated', 'cashier_initiated'),
          ('pos_safe_drop_settings', 'reasonRequired', 'reason_required'),
          ('pos_safe_drop_settings', 'tubeSize', 'tube_size'),
          ('pos_safe_drop_settings', 'createdAt', 'created_at'),
          ('pos_safe_drop_settings', 'updatedAt', 'updated_at'),
          ('pos_safe_drop_tubes', 'safeDropId', 'safe_drop_id'),
          ('pos_safe_drop_tubes', 'sortOrder', 'sort_order'),
          ('pos_safe_drop_tubes', 'createdAt', 'created_at'),
          ('pos_safe_drop_tubes', 'updatedAt', 'updated_at'),
          ('pos_safe_drop_denominations', 'safeDropId', 'safe_drop_id'),
          ('pos_safe_drop_denominations', 'imageName', 'image_name'),
          ('pos_safe_drop_denominations', 'imageData', 'image_data'),
          ('pos_safe_drop_denominations', 'sortOrder', 'sort_order'),
          ('pos_safe_drop_denominations', 'createdAt', 'created_at'),
          ('pos_safe_drop_denominations', 'updatedAt', 'updated_at')
        ) AS columns_to_rename(table_name, legacy_name, snake_name)
        LOOP
          IF to_regclass('public.' || quote_ident(column_map.table_name)) IS NULL THEN CONTINUE; END IF;
          SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
            AND table_name=column_map.table_name AND column_name=column_map.legacy_name) INTO column_exists;
          IF NOT column_exists THEN CONTINUE; END IF;
          SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
            AND table_name=column_map.table_name AND column_name=column_map.snake_name) INTO column_exists;
          IF column_exists THEN
            EXECUTE format(
              'SELECT EXISTS (SELECT 1 FROM public.%I WHERE %I IS NOT NULL AND %I IS NOT NULL AND %I::text IS DISTINCT FROM %I::text)',
              column_map.table_name, column_map.snake_name, column_map.legacy_name,
              column_map.snake_name, column_map.legacy_name
            ) INTO conflicting_values;
            IF conflicting_values THEN
              RAISE EXCEPTION 'Cannot migrate %.%: conflicting values in % and %',
                column_map.table_name, column_map.snake_name, column_map.snake_name, column_map.legacy_name;
            END IF;
            EXECUTE format('UPDATE public.%I SET %I = COALESCE(%I, %I)',
              column_map.table_name, column_map.snake_name, column_map.snake_name, column_map.legacy_name);
            EXECUTE format('ALTER TABLE public.%I DROP COLUMN %I', column_map.table_name, column_map.legacy_name);
          ELSE
            EXECUTE format('ALTER TABLE public.%I RENAME COLUMN %I TO %I',
              column_map.table_name, column_map.legacy_name, column_map.snake_name);
          END IF;
        END LOOP;
      END $$;
    `);
    await manager.query(`
      CREATE TABLE IF NOT EXISTS public.pos_safe_drop_settings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id varchar(100) NOT NULL,
        merchant_id varchar(100) NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        primary_safe varchar(100) NOT NULL DEFAULT '',
        drop_enabled boolean NOT NULL DEFAULT false,
        threshold numeric(12,2), minimum numeric(12,2), maximum numeric(12,2),
        manager_approval boolean NOT NULL DEFAULT true,
        cashier_initiated boolean NOT NULL DEFAULT true,
        reason_required boolean NOT NULL DEFAULT true,
        tube_size integer,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT pos_safe_drop_settings_store_uq UNIQUE (store_id),
        CONSTRAINT pos_safe_drop_settings_threshold_chk CHECK (threshold IS NULL OR threshold > 0),
        CONSTRAINT pos_safe_drop_settings_minimum_chk CHECK (minimum IS NULL OR minimum > 0),
        CONSTRAINT pos_safe_drop_settings_maximum_chk CHECK (maximum IS NULL OR maximum > 0),
        CONSTRAINT pos_safe_drop_settings_tube_chk CHECK (tube_size IS NULL OR tube_size > 0)
      )
    `);
    // Older installations may have created this table without a primary key. PostgreSQL
    // requires the referenced id column to be unique before the child-table foreign keys
    // can be installed.
    await manager.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          WHERE c.conrelid = 'public.pos_safe_drop_settings'::regclass
            AND c.contype IN ('p', 'u')
            AND (
              SELECT array_agg(a.attname::text ORDER BY key_column.ordinality)
              FROM unnest(c.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_column.attnum
            ) = ARRAY['id']::text[]
        ) THEN
          CREATE UNIQUE INDEX IF NOT EXISTS pos_safe_drop_settings_id_uq
            ON public.pos_safe_drop_settings (id);
        END IF;
      END $$;
    `);
    await manager.query(`
      CREATE TABLE IF NOT EXISTS public.pos_safe_drop_tubes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        safe_drop_id uuid NOT NULL REFERENCES public.pos_safe_drop_settings(id) ON DELETE CASCADE,
        amount numeric(12,2) NOT NULL, quantity integer NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT pos_safe_drop_tubes_amount_chk CHECK (amount > 0),
        CONSTRAINT pos_safe_drop_tubes_quantity_chk CHECK (quantity > 0)
      )
    `);
    await manager.query(`
      CREATE TABLE IF NOT EXISTS public.pos_safe_drop_denominations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        safe_drop_id uuid NOT NULL REFERENCES public.pos_safe_drop_settings(id) ON DELETE CASCADE,
        amount numeric(12,2) NOT NULL,
        image_name varchar(255) NOT NULL, image_data text NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT pos_safe_drop_denominations_amount_chk CHECK (amount > 0),
        CONSTRAINT pos_safe_drop_denominations_image_chk CHECK (BTRIM(image_data) <> '')
      )
    `);
    await manager.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS pos_safe_drop_settings_id_uidx
      ON public.pos_safe_drop_settings (id)
    `);
    await manager.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE contype = 'f'
            AND conrelid = 'public.pos_safe_drop_tubes'::regclass
            AND confrelid = 'public.pos_safe_drop_settings'::regclass
        ) THEN
          ALTER TABLE public.pos_safe_drop_tubes ADD CONSTRAINT pos_safe_drop_tubes_settings_fk
            FOREIGN KEY (safe_drop_id) REFERENCES public.pos_safe_drop_settings(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE contype = 'f'
            AND conrelid = 'public.pos_safe_drop_denominations'::regclass
            AND confrelid = 'public.pos_safe_drop_settings'::regclass
        ) THEN
          ALTER TABLE public.pos_safe_drop_denominations ADD CONSTRAINT pos_safe_drop_denominations_settings_fk
            FOREIGN KEY (safe_drop_id) REFERENCES public.pos_safe_drop_settings(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);
    await manager.query(`
      CREATE INDEX IF NOT EXISTS pos_safe_drop_tubes_parent_idx
      ON public.pos_safe_drop_tubes (safe_drop_id, sort_order)
    `);
    await manager.query(`
      CREATE INDEX IF NOT EXISTS pos_safe_drop_denominations_parent_idx
      ON public.pos_safe_drop_denominations (safe_drop_id, sort_order)
    `);
  });
}
