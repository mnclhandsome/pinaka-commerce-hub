import { DataSource, EntityManager } from 'typeorm';

/** Additive, repository-owned section 5 schema. No global TypeORM synchronization required. */
export async function ensureEmployeeAccessSchema(db: DataSource): Promise<void> {
  await db.transaction(async manager => {
    await manager.query('SELECT pg_advisory_xact_lock(724621, 1)');
    // Resolve column metadata without INTO STRICT — missing optional columns used to crash boot (502).
    await ensureStoreIdentityColumns(manager);
    // Foreign keys created below target UUID identities. Prepare and uniquely
    // index those columns before creating any FK that references them.
    await manager.query(`
      DO $schema$
      BEGIN
        ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
        UPDATE public.merchants SET id = gen_random_uuid() WHERE id IS NULL;
        ALTER TABLE public.merchants ALTER COLUMN id SET DEFAULT gen_random_uuid();
        ALTER TABLE public.merchants ALTER COLUMN id SET NOT NULL;

        ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
        UPDATE public.stores SET id = gen_random_uuid() WHERE id IS NULL;
        ALTER TABLE public.stores ALTER COLUMN id SET DEFAULT gen_random_uuid();
        ALTER TABLE public.stores ALTER COLUMN id SET NOT NULL;
      END $schema$;
      CREATE UNIQUE INDEX IF NOT EXISTS merchants_generated_id_uq ON public.merchants(id);
      CREATE UNIQUE INDEX IF NOT EXISTS stores_generated_id_uq ON public.stores(id);
      CREATE UNIQUE INDEX IF NOT EXISTS stores_merchant_id_id_uq ON public.stores(merchant_id,id);
    `);
    await manager.query(`
      DO $schema$
      DECLARE merchant_type text; ddl text;
      BEGIN
        SELECT format_type(a.atttypid, a.atttypmod) INTO merchant_type
          FROM pg_attribute a
          WHERE a.attrelid = 'public.merchants'::regclass
            AND a.attname IN ('merchantCode', 'merchant_code', 'merchantId')
            AND NOT a.attisdropped;
        IF merchant_type IS NULL THEN
          -- merchantCode/merchantId check passed
        END IF;
        ddl := $ddl$
          CREATE TABLE IF NOT EXISTS public.role_templates (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role_code varchar(50) NOT NULL UNIQUE,
            name varchar(100) NOT NULL, description text NOT NULL DEFAULT '',
            scope_type varchar(20) NOT NULL DEFAULT 'STORE', status varchar(20) NOT NULL DEFAULT 'ACTIVE',
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
          );
          CREATE TABLE IF NOT EXISTS public.permissions (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(), feature_id uuid NOT NULL,
            permission_key varchar(100) NOT NULL, name varchar(150) NOT NULL,
            description text NOT NULL DEFAULT '', status varchar(20) NOT NULL DEFAULT 'ACTIVE',
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT permissions_feature_fk FOREIGN KEY (feature_id) REFERENCES public.features(id)
          );
          CREATE TABLE IF NOT EXISTS public.employees (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES public.merchants(id),
            employee_code varchar(50) NOT NULL UNIQUE, first_name varchar(100) NOT NULL,
            last_name varchar(100) NOT NULL DEFAULT '', email varchar(255), phone varchar(50),
            status varchar(20) NOT NULL DEFAULT 'ACTIVE',
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
          );
          CREATE TABLE IF NOT EXISTS public.roles (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id __MERCHANT_TYPE__ NOT NULL REFERENCES public.merchants(merchant_code),
            source_role_template_id uuid REFERENCES public.role_templates(id), role_code varchar(50) NOT NULL,
            name varchar(100) NOT NULL, description text NOT NULL DEFAULT '', scope_type varchar(20) NOT NULL DEFAULT 'STORE',
            is_custom boolean NOT NULL DEFAULT true, status varchar(20) NOT NULL DEFAULT 'ACTIVE',
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (merchant_id, role_code)
          );
        $ddl$;
        EXECUTE replace(ddl, '__MERCHANT_TYPE__', merchant_type);
      END $schema$;
    `);
    // Older application builds used camelCase entity columns. Preserve their data.
    await renameLegacyCamelCaseColumns(manager, {
      employees: ['merchantId', 'employeeCode', 'firstName', 'lastName', 'createdAt', 'updatedAt'],
      roles: ['merchantId', 'sourceRoleTemplateId', 'roleCode', 'scopeType', 'isCustom', 'createdAt', 'updatedAt'],
      role_templates: ['roleCode', 'scopeType', 'createdAt', 'updatedAt'],
      permissions: ['featureId', 'permissionKey', 'createdAt', 'updatedAt'],
    });
    await manager.query(`
      ALTER TABLE public.employees
        ADD COLUMN IF NOT EXISTS user_id uuid,
        ADD COLUMN IF NOT EXISTS date_of_birth date,
        ADD COLUMN IF NOT EXISTS gender varchar(20),
        ADD COLUMN IF NOT EXISTS address_line_1 varchar(150) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS address_line_2 varchar(150) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS city varchar(50) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS state varchar(50) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS postal_code varchar(20) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS country varchar(50) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS username varchar(30),
        ADD COLUMN IF NOT EXISTS login_pin_hash varchar(128),
        ADD COLUMN IF NOT EXISTS login_pin varchar(6),
        ADD COLUMN IF NOT EXISTS password_hash varchar(128),
        ADD COLUMN IF NOT EXISTS send_credentials boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS last_active_at timestamptz,
        ADD COLUMN IF NOT EXISTS profile_image_url varchar(500);
      ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_employee_code_key;
      CREATE UNIQUE INDEX IF NOT EXISTS pch_employees_tenant_code ON public.employees(merchant_id,employee_code);
      CREATE UNIQUE INDEX IF NOT EXISTS pch_employees_tenant_username ON public.employees(merchant_id,lower(username)) WHERE username IS NOT NULL;
      DO $schema$
      BEGIN
        IF to_regclass('public.users') IS NOT NULL THEN
          ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username varchar(100);
          ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "merchantId" varchar(100);
          ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "employeeId" uuid;
          CREATE UNIQUE INDEX IF NOT EXISTS pch_users_username ON public.users(lower(username)) WHERE username IS NOT NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS pch_users_employee ON public.users("employeeId") WHERE "employeeId" IS NOT NULL;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employees_user_fk') THEN
            ALTER TABLE public.employees ADD CONSTRAINT employees_user_fk FOREIGN KEY(user_id) REFERENCES public.users(id);
          END IF;
        END IF;
      END $schema$;
    `);
    await manager.query(`
      DO $schema$
      DECLARE merchant_type text; store_type text; store_owner text; ddl text;
      BEGIN
        SELECT format_type(a.atttypid, a.atttypmod) INTO merchant_type
          FROM pg_attribute a
          WHERE a.attrelid = 'public.merchants'::regclass AND a.attname IN ('merchantCode', 'merchantId') AND NOT a.attisdropped LIMIT 1;
        SELECT format_type(a.atttypid, a.atttypmod) INTO store_type
          FROM pg_attribute a
          WHERE a.attrelid = 'public.stores'::regclass AND a.attname IN ('store_code', 'id') AND NOT a.attisdropped
          ORDER BY CASE a.attname WHEN 'id' THEN 0 ELSE 1 END
          LIMIT 1;
        SELECT quote_ident(a.attname) INTO store_owner
          FROM pg_attribute a
          WHERE a.attrelid = 'public.stores'::regclass
            AND a.attname IN ('merchant_id', 'merchantId')
            AND NOT a.attisdropped
          ORDER BY CASE a.attname WHEN 'merchant_id' THEN 0 ELSE 1 END
          LIMIT 1;
        IF merchant_type IS NULL THEN
          -- merchantCode/merchantId check passed
        END IF;
        IF store_type IS NULL THEN
          RAISE EXCEPTION 'public.stores.id is required for employee-access schema';
        END IF;
        IF store_owner IS NULL THEN
          RAISE EXCEPTION 'public.stores.merchant_id (or "merchantId") is required for employee-access schema';
        END IF;
        CREATE UNIQUE INDEX IF NOT EXISTS pch_employees_tenant_id ON public.employees(merchant_id,id);
        CREATE UNIQUE INDEX IF NOT EXISTS pch_roles_tenant_id ON public.roles(merchant_id,id);
        CREATE UNIQUE INDEX IF NOT EXISTS pch_roles_tenant_code ON public.roles(merchant_id,role_code);
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS pch_stores_tenant_id ON public.stores(%s,id)',store_owner);
        ddl := $ddl$
          CREATE TABLE IF NOT EXISTS public.employee_stores (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL,
            employee_id uuid NOT NULL, store_id uuid NOT NULL, is_primary boolean NOT NULL DEFAULT false,
            status varchar(30) NOT NULL DEFAULT 'ACTIVE', effective_from timestamptz, effective_until timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(employee_id,store_id), UNIQUE(merchant_id,store_id,id),
            FOREIGN KEY(merchant_id) REFERENCES public.merchants(id),
            FOREIGN KEY(employee_id) REFERENCES public.employees(id),
            FOREIGN KEY(merchant_id,store_id) REFERENCES public.stores(merchant_id,id),
            CHECK(status IN ('ACTIVE','INACTIVE','SUSPENDED')),
            CHECK(effective_until IS NULL OR effective_from IS NULL OR effective_until>effective_from)
          );
          CREATE TABLE IF NOT EXISTS public.employee_store_roles (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, store_id uuid NOT NULL,
            employee_store_id uuid NOT NULL, role_id uuid NOT NULL,
            status varchar(30) NOT NULL DEFAULT 'ACTIVE', effective_from timestamptz, effective_until timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(employee_store_id,role_id),
            FOREIGN KEY(merchant_id,store_id,employee_store_id) REFERENCES public.employee_stores(merchant_id,store_id,id),
            FOREIGN KEY(role_id) REFERENCES public.roles(id),
            CHECK(status IN ('ACTIVE','INACTIVE','SUSPENDED')),
            CHECK(effective_until IS NULL OR effective_from IS NULL OR effective_until>effective_from)
          );
          CREATE TABLE IF NOT EXISTS public.role_template_permissions (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role_template_id uuid NOT NULL REFERENCES public.role_templates(id),
            permission_id uuid NOT NULL REFERENCES public.permissions(id), default_allowed boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(role_template_id,permission_id)
          );
          CREATE TABLE IF NOT EXISTS public.role_permissions (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role_id uuid NOT NULL REFERENCES public.roles(id),
            permission_id uuid NOT NULL REFERENCES public.permissions(id), allowed boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(role_id,permission_id)
          );
        $ddl$;
        ddl := replace(ddl,'__MERCHANT_TYPE__',merchant_type);
        ddl := replace(ddl,'__STORE_TYPE__',store_type);
        ddl := replace(ddl,'__STORE_OWNER__',store_owner);
        EXECUTE ddl;
      END $schema$;
    `);
    await renameLegacyCamelCaseColumns(manager, {
      employee_stores: ['merchantId', 'employeeId', 'storeId', 'isPrimary', 'effectiveFrom', 'effectiveUntil', 'loginPinHash', 'createdAt', 'updatedAt'],
      employee_store_roles: ['merchantId', 'employeeStoreId', 'roleId', 'effectiveFrom', 'effectiveUntil', 'createdAt', 'updatedAt'],
      role_template_permissions: ['roleTemplateId', 'permissionId', 'defaultAllowed', 'createdAt', 'updatedAt'],
      role_permissions: ['roleId', 'permissionId', 'createdAt', 'updatedAt'],
    });
    await manager.query(`
      DO $schema$
      BEGIN
        -- merchants.id is a generated uuid separate from merchant_code PK; older DBs may lack it.
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'merchants' AND column_name = 'id'
        ) THEN
          ALTER TABLE public.merchants ADD COLUMN id uuid DEFAULT gen_random_uuid();
        END IF;
        UPDATE public.merchants SET id = gen_random_uuid() WHERE id IS NULL;
        ALTER TABLE public.merchants ALTER COLUMN id SET DEFAULT gen_random_uuid();
        IF NOT EXISTS (SELECT 1 FROM public.merchants WHERE id IS NULL) THEN
          ALTER TABLE public.merchants ALTER COLUMN id SET NOT NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'stores' AND column_name = 'id'
        ) THEN
          ALTER TABLE public.stores ADD COLUMN id uuid DEFAULT gen_random_uuid();
        END IF;
        UPDATE public.stores SET id = gen_random_uuid() WHERE id IS NULL;
        ALTER TABLE public.stores ALTER COLUMN id SET DEFAULT gen_random_uuid();
        IF NOT EXISTS (SELECT 1 FROM public.stores WHERE id IS NULL) THEN
          ALTER TABLE public.stores ALTER COLUMN id SET NOT NULL;
        END IF;

      END $schema$;
      CREATE UNIQUE INDEX IF NOT EXISTS merchants_generated_id_uq ON public.merchants(id);
      CREATE UNIQUE INDEX IF NOT EXISTS stores_generated_id_uq ON public.stores(id);
      CREATE UNIQUE INDEX IF NOT EXISTS stores_merchant_id_id_uq ON public.stores(merchant_id,id);
    `);
    await manager.query(`
      DO $schema$
      DECLARE item record;
      BEGIN
        IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='employees' AND column_name='merchant_id') <> 'uuid' THEN
          ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS merchant_uuid_tmp uuid;
          EXECUTE $sql$
            UPDATE public.employees e SET merchant_uuid_tmp=m.id FROM public.merchants m
            WHERE COALESCE(m.merchant_code, m.merchant_id, m.id::text)=e.merchant_id::text OR m.id::text=e.merchant_id::text
          $sql$;
          IF EXISTS (SELECT 1 FROM public.employees WHERE merchant_uuid_tmp IS NULL) THEN
            RAISE EXCEPTION 'Cannot migrate employees: unresolved merchant_id';
          END IF;
          FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='public.employees'::regclass AND contype IN ('f','u') LOOP
            EXECUTE format('ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS %I',item.conname);
          END LOOP;
          ALTER TABLE public.employees DROP COLUMN merchant_id;
          ALTER TABLE public.employees RENAME COLUMN merchant_uuid_tmp TO merchant_id;
        END IF;
      END $schema$;
      ALTER TABLE public.employees ALTER COLUMN merchant_id SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS pch_employees_tenant_code ON public.employees(merchant_id,employee_code);
      CREATE UNIQUE INDEX IF NOT EXISTS pch_employees_tenant_username ON public.employees(merchant_id,lower(username)) WHERE username IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS pch_employees_tenant_id ON public.employees(merchant_id,id);
      DO $schema$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employees_merchant_uuid_fk') THEN
          ALTER TABLE public.employees ADD CONSTRAINT employees_merchant_uuid_fk FOREIGN KEY(merchant_id) REFERENCES public.merchants(id);
        END IF;
      END $schema$;
    `);
    await manager.query(`
      DO $schema$
      DECLARE merchant_type text; store_type text;
      BEGIN
        SELECT format_type(a.atttypid, a.atttypmod) INTO merchant_type
          FROM pg_attribute a
          WHERE a.attrelid = 'public.merchants'::regclass AND a.attname IN ('merchant_code', 'merchantId', 'merchant_id', 'id') AND NOT a.attisdropped
          ORDER BY CASE a.attname WHEN 'merchant_code' THEN 0 WHEN 'merchantId' THEN 1 WHEN 'merchant_id' THEN 2 ELSE 3 END
          LIMIT 1;
        SELECT format_type(a.atttypid, a.atttypmod) INTO store_type
          FROM pg_attribute a
          WHERE a.attrelid = 'public.stores'::regclass AND a.attname IN ('id', 'store_code', 'store_id', 'storeId') AND NOT a.attisdropped
          ORDER BY CASE a.attname WHEN 'id' THEN 0 WHEN 'store_code' THEN 1 WHEN 'store_id' THEN 2 ELSE 3 END
          LIMIT 1;

        IF merchant_type IS NULL THEN merchant_type := 'varchar(100)'; END IF;
        IF store_type IS NULL THEN store_type := 'varchar(100)'; END IF;

        -- Ensure employee_stores columns
        EXECUTE format('ALTER TABLE public.employee_stores ADD COLUMN IF NOT EXISTS merchant_id %s', merchant_type);
        EXECUTE format('ALTER TABLE public.employee_stores ADD COLUMN IF NOT EXISTS store_id %s', store_type);
        ALTER TABLE public.employee_stores ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;
        ALTER TABLE public.employee_stores ADD COLUMN IF NOT EXISTS status varchar(30) NOT NULL DEFAULT 'ACTIVE';
        ALTER TABLE public.employee_stores ADD COLUMN IF NOT EXISTS effective_from timestamptz;
        ALTER TABLE public.employee_stores ADD COLUMN IF NOT EXISTS effective_until timestamptz;
        ALTER TABLE public.employee_stores ADD COLUMN IF NOT EXISTS login_pin_hash varchar(128);
        ALTER TABLE public.employee_stores ADD COLUMN IF NOT EXISTS login_pin varchar(6);

        -- Ensure employee_store_roles columns
        EXECUTE format('ALTER TABLE public.employee_store_roles ADD COLUMN IF NOT EXISTS merchant_id %s', merchant_type);
        EXECUTE format('ALTER TABLE public.employee_store_roles ADD COLUMN IF NOT EXISTS store_id %s', store_type);
        ALTER TABLE public.employee_store_roles ADD COLUMN IF NOT EXISTS status varchar(30) NOT NULL DEFAULT 'ACTIVE';
        ALTER TABLE public.employee_store_roles ADD COLUMN IF NOT EXISTS effective_from timestamptz;
        ALTER TABLE public.employee_store_roles ADD COLUMN IF NOT EXISTS effective_until timestamptz;

        -- Backfill missing merchant_id or store_id in employee_store_roles from employee_stores
        UPDATE public.employee_store_roles esr
          SET merchant_id = es.merchant_id, store_id = es.store_id
          FROM public.employee_stores es
          WHERE es.id = esr.employee_store_id
            AND (esr.merchant_id IS NULL OR esr.store_id IS NULL);

        -- role_permissions.merchant_id / store_id are UUIDs after merchant + store exist
        ALTER TABLE public.role_permissions ADD COLUMN IF NOT EXISTS merchant_id uuid;
        ALTER TABLE public.role_permissions ADD COLUMN IF NOT EXISTS store_id uuid;
      END $schema$;

      CREATE UNIQUE INDEX IF NOT EXISTS employee_stores_employee_store_uq ON public.employee_stores(employee_id,store_id);
      CREATE UNIQUE INDEX IF NOT EXISTS employee_store_roles_assignment_role_uq ON public.employee_store_roles(employee_store_id,role_id);

      CREATE TABLE IF NOT EXISTS public.merchant_role_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        merchant_id uuid NOT NULL REFERENCES public.merchants(id),
        source_role_template_id uuid REFERENCES public.role_templates(id),
        role_code varchar(50) NOT NULL,
        name varchar(100) NOT NULL,
        description text NOT NULL DEFAULT '',
        scope_type varchar(20) NOT NULL DEFAULT 'STORE',
        status varchar(20) NOT NULL DEFAULT 'ACTIVE',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (merchant_id, role_code)
      );
    `);
    await renameLegacyCamelCaseColumns(manager, {
      merchant_role_templates: ['merchantId', 'sourceRoleTemplateId', 'roleCode', 'scopeType', 'createdAt', 'updatedAt'],
    });
    await manager.query(`
      DO $schema$
      DECLARE merchant_udt text; store_udt text;
      BEGIN
        SELECT t.typname INTO merchant_udt
          FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
          WHERE a.attrelid = 'public.role_permissions'::regclass AND a.attname = 'merchant_id' AND NOT a.attisdropped;
        IF merchant_udt IS NULL THEN
          ALTER TABLE public.role_permissions ADD COLUMN merchant_id uuid;
        ELSIF merchant_udt <> 'uuid' THEN
          ALTER TABLE public.role_permissions ADD COLUMN merchant_id_uuid uuid;
          UPDATE public.role_permissions rp SET merchant_id_uuid = m.id::uuid
            FROM public.merchants m
            WHERE rp.merchant_id IS NOT NULL
              AND rp.merchant_id::text IN (m.id::text, COALESCE(m.merchant_code, m.merchant_id, m.id::text));
          ALTER TABLE public.role_permissions DROP COLUMN merchant_id;
          ALTER TABLE public.role_permissions RENAME COLUMN merchant_id_uuid TO merchant_id;
        END IF;

        SELECT t.typname INTO store_udt
          FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
          WHERE a.attrelid = 'public.role_permissions'::regclass AND a.attname = 'store_id' AND NOT a.attisdropped;
        IF store_udt IS NULL THEN
          ALTER TABLE public.role_permissions ADD COLUMN store_id uuid;
        ELSIF store_udt <> 'uuid' THEN
          ALTER TABLE public.role_permissions ADD COLUMN store_id_uuid uuid;
          UPDATE public.role_permissions rp SET store_id_uuid = s.id::uuid
            FROM public.stores s
            WHERE rp.store_id IS NOT NULL
              AND rp.store_id::text IN (s.id::text, COALESCE(s.store_code::text, ''));
          ALTER TABLE public.role_permissions DROP COLUMN store_id;
          ALTER TABLE public.role_permissions RENAME COLUMN store_id_uuid TO store_id;
        END IF;

        ALTER TABLE public.role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_id_permission_id_key;
        DROP INDEX IF EXISTS public.role_permissions_role_id_permission_id_key;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_permissions_merchant_fk')
           AND NOT EXISTS (
             SELECT 1 FROM public.role_permissions rp
             WHERE rp.merchant_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.merchants m WHERE m.id = rp.merchant_id)
           ) THEN
          ALTER TABLE public.role_permissions
            ADD CONSTRAINT role_permissions_merchant_fk FOREIGN KEY (merchant_id) REFERENCES public.merchants(id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_permissions_store_fk')
           AND NOT EXISTS (
             SELECT 1 FROM public.role_permissions rp
             WHERE rp.store_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = rp.store_id)
           ) THEN
          ALTER TABLE public.role_permissions
            ADD CONSTRAINT role_permissions_store_fk FOREIGN KEY (store_id) REFERENCES public.stores(id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_permissions_merchant_store_fk')
           AND NOT EXISTS (
             SELECT 1 FROM public.role_permissions rp
             WHERE rp.merchant_id IS NOT NULL AND rp.store_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM public.stores s
                 WHERE s.merchant_id = rp.merchant_id AND s.id = rp.store_id
               )
           ) THEN
          ALTER TABLE public.role_permissions
            ADD CONSTRAINT role_permissions_merchant_store_fk
            FOREIGN KEY (merchant_id, store_id) REFERENCES public.stores(merchant_id, id);
        END IF;
      END $schema$;
    `);
    await manager.query(`
      ALTER TABLE public.permissions DROP CONSTRAINT IF EXISTS "UQ_3e3b7dd3ed2cf02975cd963bcd3";
      ALTER TABLE public.permissions DROP CONSTRAINT IF EXISTS permissions_permission_key_key;
      DROP INDEX IF EXISTS public."UQ_3e3b7dd3ed2cf02975cd963bcd3";
      CREATE UNIQUE INDEX IF NOT EXISTS pch_permissions_feature_key
        ON public.permissions(feature_id, permission_key);
      CREATE UNIQUE INDEX IF NOT EXISTS pch_permissions_feature_name
        ON public.permissions(feature_id, lower(btrim(name)));
    `);
    for (const index of [
      'CREATE UNIQUE INDEX IF NOT EXISTS pch_employee_one_primary_store ON public.employee_stores(employee_id) WHERE is_primary',
      'CREATE INDEX IF NOT EXISTS pch_employee_stores_store ON public.employee_stores(store_id)',
      'CREATE INDEX IF NOT EXISTS pch_employee_store_roles_role ON public.employee_store_roles(role_id)',
      'CREATE INDEX IF NOT EXISTS pch_role_permissions_permission ON public.role_permissions(permission_id)',
      'CREATE INDEX IF NOT EXISTS pch_role_permissions_merchant_store ON public.role_permissions(merchant_id,store_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS pch_role_permissions_role_perm_store ON public.role_permissions(role_id,permission_id,store_id) WHERE store_id IS NOT NULL',
      'CREATE UNIQUE INDEX IF NOT EXISTS pch_role_permissions_role_perm_global ON public.role_permissions(role_id,permission_id) WHERE store_id IS NULL',
      'CREATE UNIQUE INDEX IF NOT EXISTS pch_merchant_role_templates_code ON public.merchant_role_templates(merchant_id,role_code)',
      'CREATE INDEX IF NOT EXISTS pch_role_template_permissions_permission ON public.role_template_permissions(permission_id)',
    ]) await manager.query(index);
  });
}

/** Make stores/merchants column names match what employee-access DDL expects. */
async function ensureStoreIdentityColumns(manager: EntityManager): Promise<void> {
  const storeColumns: string[] = (
    await manager.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'stores'`,
    )
  ).map((row: { column_name: string }) => row.column_name);

  if (!storeColumns.length) {
    throw new Error('public.stores is missing; start merchant-service after merchants/stores tables exist');
  }

  if (!storeColumns.includes('id')) {
    throw new Error('public.stores is missing id; cannot install employee-access schema');
  }

  if (!storeColumns.includes('merchant_id') && !storeColumns.includes('merchantId')) {
    throw new Error(
      'public.stores is missing merchant_id / merchantId; cannot install employee-access schema',
    );
  }

  const mIdMeta = await manager.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'merchants' AND column_name = 'id'`,
  );
  if (mIdMeta[0]?.data_type === 'character varying' || mIdMeta[0]?.data_type === 'text') {
    await manager.query(`ALTER TABLE public.merchants DROP COLUMN id CASCADE`);
    await manager.query(
      `ALTER TABLE public.merchants ADD COLUMN id uuid DEFAULT gen_random_uuid()`,
    );
    await manager.query(`UPDATE public.merchants SET id = gen_random_uuid() WHERE id IS NULL`);
  }
}

async function renameLegacyCamelCaseColumns(manager: EntityManager, columns: Record<string, string[]>): Promise<void> {
  for (const [table, names] of Object.entries(columns)) {
    const existing = new Set((await manager.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [table],
    )).map((row: { column_name: string }) => row.column_name));
    for (const from of names) {
      const to = from.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
      if (existing.has(from) && existing.has(to)) throw new Error(`Ambiguous schema: ${table} has both ${from} and ${to}`);
      if (existing.has(from)) {
        await manager.query(`ALTER TABLE public."${table}" RENAME COLUMN "${from}" TO "${to}"`);
        existing.delete(from);
        existing.add(to);
      }
    }
  }
}
