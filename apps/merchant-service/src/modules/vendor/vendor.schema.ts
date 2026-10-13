import { DataSource } from 'typeorm';

const quoteIdent = (value: string) => `"${value.replace(/"/g, '""')}"`;

const legacyColumns: Record<string, { names: string[]; kind: 'text' | 'uuid' | 'timestamp' | 'boolean' }> = {
  vendor_code: { names: ['vendorCode'], kind: 'text' },
  vendor_name: { names: ['vendorName', 'name'], kind: 'text' },
  vendor_type: { names: ['vendorType'], kind: 'text' },
  store_type_id: { names: ['storeTypeId'], kind: 'uuid' },
  contact_person: { names: ['contactPerson'], kind: 'text' },
  product_category: { names: ['productCategory'], kind: 'text' },
  address_line1: { names: ['addressLine1', 'address'], kind: 'text' },
  address_line2: { names: ['addressLine2'], kind: 'text' },
  zip_code: { names: ['zipCode'], kind: 'text' },
  created_by: { names: ['createdBy'], kind: 'uuid' },
  created_at: { names: ['createdAt'], kind: 'timestamp' },
  is_deleted: { names: ['isDeleted'], kind: 'boolean' },
  deleted_at: { names: ['deletedAt'], kind: 'timestamp' },
};

export async function ensureVendorSchema(dataSource: DataSource): Promise<void> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await runner.query('SELECT pg_advisory_xact_lock(724621, 42)');
    await runner.query(`
      ALTER TABLE public.vendors
        ADD COLUMN IF NOT EXISTS vendor_code varchar(50),
        ADD COLUMN IF NOT EXISTS vendor_name varchar(150),
        ADD COLUMN IF NOT EXISTS vendor_type varchar(50),
        ADD COLUMN IF NOT EXISTS store_type_id uuid,
        ADD COLUMN IF NOT EXISTS contact_person varchar(150),
        ADD COLUMN IF NOT EXISTS phone varchar(30),
        ADD COLUMN IF NOT EXISTS email varchar(150),
        ADD COLUMN IF NOT EXISTS product_category varchar(150),
        ADD COLUMN IF NOT EXISTS address_line1 varchar(255),
        ADD COLUMN IF NOT EXISTS address_line2 varchar(255),
        ADD COLUMN IF NOT EXISTS city varchar(100),
        ADD COLUMN IF NOT EXISTS state varchar(50),
        ADD COLUMN IF NOT EXISTS zip_code varchar(20),
        ADD COLUMN IF NOT EXISTS country varchar(100),
        ADD COLUMN IF NOT EXISTS status varchar(20),
        ADD COLUMN IF NOT EXISTS created_by uuid,
        ADD COLUMN IF NOT EXISTS updated_by uuid,
        ADD COLUMN IF NOT EXISTS created_at timestamptz,
        ADD COLUMN IF NOT EXISTS updated_at timestamptz,
        ADD COLUMN IF NOT EXISTS is_deleted boolean,
        ADD COLUMN IF NOT EXISTS deleted_at timestamptz
    `);

    const columns = await runner.query(
      `SELECT column_name, data_type, udt_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'vendors'`,
    ) as Array<{ column_name: string; data_type: string; udt_name: string }>;
    const byName = new Map(columns.map(column => [column.column_name, column]));

    for (const [targetName, mapping] of Object.entries(legacyColumns)) {
      const target = byName.get(targetName);
      if (!target) continue;
      const sourceName = mapping.names.find(name => byName.has(name));
      if (!sourceName) continue;

      const source = quoteIdent(sourceName);
      const targetIdent = quoteIdent(targetName);
      let value: string;
      if (mapping.kind === 'uuid') {
        value = `CASE WHEN ${source}::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ${source}::text::uuid END`;
      } else if (mapping.kind === 'timestamp') {
        value = `NULLIF(${source}::text, '')::timestamptz`;
      } else if (mapping.kind === 'boolean') {
        value = `CASE WHEN lower(${source}::text) IN ('true', 't', '1', 'yes') THEN true WHEN lower(${source}::text) IN ('false', 'f', '0', 'no') THEN false END`;
      } else {
        value = `NULLIF(${source}::text, '')::${quoteIdent(target.udt_name)}`;
      }
      await runner.query(
        `UPDATE public.vendors SET ${targetIdent} = COALESCE(${targetIdent}, ${value}) WHERE ${targetIdent} IS NULL AND ${source} IS NOT NULL`,
      );
    }

    await runner.query(`
      UPDATE public.vendors
      SET vendor_code = COALESCE(NULLIF(vendor_code, ''), 'VEN-' || replace(id::text, '-', '')),
          vendor_name = COALESCE(NULLIF(vendor_name, ''), 'Vendor ' || left(id::text, 8)),
          vendor_type = COALESCE(vendor_type, 'SUPPLIER'),
          status = COALESCE(status, 'ACTIVE'),
          created_at = COALESCE(created_at, now()),
          is_deleted = COALESCE(is_deleted, false),
          deleted_at = CASE
            WHEN is_deleted OR deleted_at IS NOT NULL THEN COALESCE(deleted_at, updated_at, created_at, now())
            ELSE NULL
          END
    `);
    await runner.query(`
      ALTER TABLE public.vendors
        ALTER COLUMN vendor_code SET NOT NULL,
        ALTER COLUMN vendor_name SET NOT NULL,
        ALTER COLUMN vendor_type SET NOT NULL,
        ALTER COLUMN status SET DEFAULT 'ACTIVE',
        ALTER COLUMN status SET NOT NULL,
        ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
        ALTER COLUMN created_at SET NOT NULL,
        ALTER COLUMN updated_at DROP DEFAULT,
        ALTER COLUMN updated_at DROP NOT NULL,
        ALTER COLUMN updated_by DROP DEFAULT,
        ALTER COLUMN updated_by DROP NOT NULL,
        ALTER COLUMN is_deleted SET DEFAULT false,
        ALTER COLUMN is_deleted SET NOT NULL
    `);
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}