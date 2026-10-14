import { DataSource, type DataSourceOptions } from 'typeorm';

export const DEFAULT_POSTGRES_DB = 'pinaka_commerce_hub_new';

export function postgresConnectionOptions(
  entities: DataSourceOptions['entities'],
): DataSourceOptions {
  const synchronize = process.env.TYPEORM_SYNCHRONIZE !== 'false';
  const shared = {
    type: 'postgres' as const,
    entities,
    synchronize,
    logging: process.env.TYPEORM_LOGGING === 'true',
  };

  const databaseUrl = process.env.DATABASE_URL?.trim();
  const useDiscrete =
    Boolean(process.env.POSTGRES_HOST || process.env.POSTGRES_DB || process.env.POSTGRES_USER);

  if (databaseUrl && !useDiscrete) {
    return { ...shared, url: databaseUrl };
  }

  return {
    ...shared,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT) || 5432,
    username: process.env.POSTGRES_USER || 'pdh_user',
    password: process.env.POSTGRES_PASSWORD || 'pdh_password',
    database: process.env.POSTGRES_DB || DEFAULT_POSTGRES_DB,
  };
}

function describeTarget(options: DataSourceOptions): string {
  if ('url' in options && options.url) return options.url.replace(/:[^:@/]+@/, ':****@');
  const opts = options as any;
  return `${opts.host || "localhost"}:${opts.port || 5432}/${opts.database || "pinaka_commerce_hub"}`;
}

const LEGACY_COLUMN_RENAMES: Array<{ table: string; from: string; to: string }> = [
  { table: 'stores', from: 'merchant_id', to: 'merchantId' },
  { table: 'stores', from: 'store_type_id', to: 'storeType' },
  { table: 'stores', from: 'store_code', to: 'storeCode' },
  { table: 'stores', from: 'name', to: 'storeName' },
  { table: 'stores', from: 'woocommerce_store_id', to: 'woocommerceStoreId' },
  { table: 'stores', from: 'created_at', to: 'createdAt' },
  { table: 'stores', from: 'updated_at', to: 'updatedAt' },
  { table: 'plans', from: 'plan_code', to: 'planCode' },
  { table: 'plans', from: 'billing_model', to: 'billingModel' },
  { table: 'plans', from: 'base_price', to: 'basePrice' },
  { table: 'plans', from: 'billing_cycle', to: 'billingCycle' },
  { table: 'plans', from: 'created_at', to: 'createdAt' },
  { table: 'plans', from: 'updated_at', to: 'updatedAt' },
  { table: 'features', from: 'created_at', to: 'createdAt' },
  { table: 'features', from: 'updated_at', to: 'updatedAt' },
  { table: 'store_types', from: 'store_type_code', to: 'storeTypeCode' },
  { table: 'store_types', from: 'created_at', to: 'createdAt' },
  { table: 'store_types', from: 'updated_at', to: 'updatedAt' },
  { table: 'inventory_items', from: 'store_id', to: 'storeId' },
  { table: 'inventory_items', from: 'product_id', to: 'productId' },
  { table: 'inventory_items', from: 'product_name', to: 'productName' },
  { table: 'inventory_items', from: 'merchant_id', to: 'merchantId' },
  { table: 'inventory_adjustments', from: 'store_id', to: 'storeId' },
  { table: 'inventory_adjustments', from: 'product_id', to: 'productId' },
];

async function columnExists(dataSource: DataSource, table: string, column: string): Promise<boolean> {
  const rows = await dataSource.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

async function tableExists(dataSource: DataSource, table: string): Promise<boolean> {
  const rows = await dataSource.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows.length > 0;
}

async function databaseHasTables(dataSource: DataSource): Promise<boolean> {
  const rows = await dataSource.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      LIMIT 1`,
  );
  return rows.length > 0;
}

/**
 * PostgreSQL counts dropped columns toward the 1600-column limit.
 * VACUUM FULL rewrites the table and discards those dropped columns.
 * It cannot run inside a transaction.
 */
async function compactDroppedColumns(dataSource: DataSource): Promise<void> {
  const rows: Array<{ table_name: string; total: string; dropped: string }> = await dataSource.query(`
    SELECT c.relname AS table_name,
           count(*) FILTER (WHERE a.attnum > 0)::text AS total,
           count(*) FILTER (WHERE a.attnum > 0 AND a.attisdropped)::text AS dropped
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
     GROUP BY c.relname
    HAVING count(*) FILTER (WHERE a.attnum > 0) >= 1400
  `);
  if (!rows.length) return;
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    for (const row of rows) {
      console.log(`🐘 Compacting public.${row.table_name}: ${row.total} columns, ${row.dropped} dropped, to stay under the 1600-column limit`);
      await runner.query(`VACUUM FULL public.${quoteIdent(row.table_name)}`);
    }
  } finally {
    await runner.release();
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Schema scripts created unique indexes that TypeORM does not own.
 * Dependent foreign keys make a plain DROP INDEX fail, so drop them
 * with CASCADE before synchronize recreates the indexes declared on entities.
 */
async function dropIndexesOutsideEntities(dataSource: DataSource): Promise<void> {
  const tables = [...new Set(dataSource.entityMetadatas.map(metadata => metadata.tableName))];
  if (!tables.length) return;
  const rows: Array<{ table_name: string; index_name: string; constraint_name: string | null }> = await dataSource.query(
    `SELECT DISTINCT ON (c.relname)
            t.relname AS table_name,
            c.relname AS index_name,
            u.conname AS constraint_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_constraint u ON u.conindid = i.indexrelid AND u.contype IN ('u', 'x')
      WHERE n.nspname = 'public'
        AND NOT i.indisprimary
        AND t.relname = ANY($1)
      ORDER BY c.relname, u.conname NULLS LAST`,
    [tables],
  );
  for (const row of rows) {
    if (row.constraint_name) {
      await dataSource.query(
        `ALTER TABLE public.${quoteIdent(row.table_name)} DROP CONSTRAINT IF EXISTS ${quoteIdent(row.constraint_name)} CASCADE`,
      );
    } else {
      await dataSource.query(`DROP INDEX IF EXISTS public.${quoteIdent(row.index_name)} CASCADE`);
    }
  }
}

/** Rename leftover snake_case columns to camelCase before TypeORM synchronize. */
async function alignLegacyCamelCaseColumns(dataSource: DataSource): Promise<void> {
  for (const { table, from, to } of LEGACY_COLUMN_RENAMES) {
    // A connector/order connection must never migrate merchant-owned tables.
    const entity = dataSource.entityMetadatas.find(metadata => metadata.tableName === table);
    if (!entity?.columns.some(column => column.databaseName === to)) continue;
    if (!(await tableExists(dataSource, table))) continue;
    const hasFrom = await columnExists(dataSource, table, from);
    const hasTo = await columnExists(dataSource, table, to);
    if (hasFrom && !hasTo) {
      await dataSource.query(`ALTER TABLE public."${table}" RENAME COLUMN "${from}" TO "${to}"`);
      continue;
    }
    if (hasFrom && hasTo) {
      await dataSource.query(
        `UPDATE public."${table}" SET "${to}" = "${from}" WHERE "${to}" IS NULL AND "${from}" IS NOT NULL`,
      );
    }
  }
}

async function addVarcharColumnIfMissing(
  dataSource: DataSource,
  table: string,
  column: string,
  length = 100,
): Promise<void> {
  if (!(await columnExists(dataSource, table, column))) {
    await dataSource.query(
      `ALTER TABLE public."${table}" ADD COLUMN "${column}" varchar(${length})`,
    );
  }
}

async function addDecimalColumnIfMissing(
  dataSource: DataSource,
  table: string,
  column: string,
): Promise<void> {
  if (!(await columnExists(dataSource, table, column))) {
    await dataSource.query(
      `ALTER TABLE public."${table}" ADD COLUMN "${column}" decimal(10,2) DEFAULT 0`,
    );
  }
  await dataSource.query(
    `UPDATE public."${table}" SET "${column}" = 0 WHERE "${column}" IS NULL`,
  );
}

function columnSqlType(column: { type?: unknown; length?: string | number }): string {
  const type = String(column.type || 'varchar');
  if (type === 'uuid') return 'uuid';
  if (type === 'boolean') return 'boolean';
  if (type === 'int' || type === 'integer' || type === 'smallint') return 'integer';
  if (type === 'bigint') return 'bigint';
  if (type === 'text') return 'text';
  if (type === 'jsonb' || type === 'json') return 'jsonb';
  if (type === 'date') return 'date';
  if (type === 'timestamptz' || type === 'timestamp' || type === 'datetime') return 'timestamptz';
  if (type === 'numeric' || type === 'decimal') return 'numeric';
  if (type === 'enum') return 'varchar(100)';
  const length = Number(column.length) || 255;
  return `varchar(${length})`;
}

const UUID_TEXT = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

/** Old camelCase columns that do not match the entity property name. */
const EXTRA_COLUMN_SOURCES: Record<string, string[]> = {
  feature_code: ['feature_key'],
  role_code: ['roleCode'],
  store_type_code: ['storeTypeCode'],
  plan_code: ['planCode'],
  store_code: ['storeCode'],
  store_name: ['storeName'],
  activation_pin: ['activationPin'],
  merchant_code: ['merchantCode'],
  business_display_name: ['businessDisplayName', 'businessName', 'merchantName'],
  subscription_code: ['subscriptionCode', 'subscriptionId'],
  device_code: ['deviceCode'],
  device_name: ['deviceName'],
  serial_number: ['serialNumber'],
  merchant_name: ['merchantName'],
  device_type: ['deviceType'],
  vendor_code: ['vendorCode'],
  vendor_name: ['vendorName'],
  vendor_type: ['vendorType'],
  tendor_code: ['tendorCode'],
  tendor_name: ['tendorName'],
  permission_code: ['permissionKey', 'permissionCode'],
  permission_key: ['permissionKey'],
  contact_person: ['contactPerson'],
  product_category: ['productCategory'],
  zip_code: ['zipCode'],
  operational_status: ['operationalStatus'],
  billing_cycle: ['billingCycle'],
  billing_model: ['billingModel'],
  base_price: ['basePrice'],
  scope_type: ['scopeType'],
};

async function liveColumnType(dataSource: DataSource, table: string, column: string): Promise<string | null> {
  const rows = await dataSource.query(
    `SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows[0]?.data_type ?? null;
}

async function postgresEnumExists(dataSource: DataSource, enumName: string): Promise<boolean> {
  const rows = await dataSource.query(
    `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typtype = 'e' AND t.typname = $1`,
    [enumName],
  );
  return rows.length > 0;
}

function enumLabels(column: { enum?: unknown }): string[] {
  const value = column.enum;
  if (!value) return [];
  if (Array.isArray(value)) return [...new Set(value.map(String))];
  return [...new Set(Object.values(value).filter((item): item is string => typeof item === 'string'))];
}

/** Copy camelCase values into new required columns before synchronize sets them NOT NULL. */
async function backfillRequiredColumnsBeforeSync(dataSource: DataSource): Promise<void> {
  for (const entity of dataSource.entityMetadatas) {
    const table = entity.tableName;
    if (!(await tableExists(dataSource, table))) continue;
    for (const column of entity.columns) {
      if (column.isNullable || column.isGenerated || column.isCreateDate || column.isUpdateDate) continue;
      if (column.default !== undefined && column.default !== null) continue;
      const target = column.databaseName;
      const source = column.propertyName;
      if (!target || source === target) continue;
      const sources = [source, ...(EXTRA_COLUMN_SOURCES[target] ?? [])].filter(
        (name, index, all) => name !== target && all.indexOf(name) === index,
      );
      const presentSources: string[] = [];
      for (const name of sources) {
        if (await columnExists(dataSource, table, name)) presentSources.push(name);
      }
      const sqlType = columnSqlType(column);
      const rawEnumName = column.enumName || '';
      if (!presentSources.length && (await columnExists(dataSource, table, target))) {
        // Still resolve uuid foreign keys that were stored as business codes.
      } else if (!presentSources.length && sqlType !== 'uuid' && !rawEnumName) {
        continue;
      }
      if (!(await columnExists(dataSource, table, target))) {
        await dataSource.query(
          `ALTER TABLE public.${quoteIdent(table)} ADD COLUMN ${quoteIdent(target)} ${sqlType}`,
        );
      }
      const quotedTable = `public.${quoteIdent(table)}`;
      const quotedTarget = quoteIdent(target);
      const enumReady = rawEnumName ? await postgresEnumExists(dataSource, rawEnumName) : false;
      const liveType = await liveColumnType(dataSource, table, target);
      const quotedEnum = enumReady ? quoteIdent(rawEnumName) : '';
      const assignAsEnum = Boolean(quotedEnum && liveType === 'USER-DEFINED');
      for (const present of presentSources) {
        const quotedSource = quoteIdent(present);
        if (sqlType === 'uuid') {
          await dataSource.query(
            `UPDATE ${quotedTable} SET ${quotedTarget} = ${quotedSource}::uuid WHERE ${quotedTarget} IS NULL AND ${quotedSource}::text ~* '${UUID_TEXT}'`,
          );
        } else if (assignAsEnum) {
          await dataSource.query(
            `UPDATE ${quotedTable} SET ${quotedTarget} = ${quotedSource}::text::${quotedEnum} WHERE ${quotedTarget} IS NULL AND ${quotedSource}::text IN (SELECT e::text FROM unnest(enum_range(NULL::${quotedEnum})) AS e)`,
          );
        } else {
          await dataSource.query(
            `UPDATE ${quotedTable} SET ${quotedTarget} = ${quotedSource} WHERE ${quotedTarget} IS NULL AND ${quotedSource} IS NOT NULL`,
          );
        }
      }
      if (sqlType === 'uuid' && target === 'merchant_id' && (await tableExists(dataSource, 'merchants'))) {
        const liveType = await liveColumnType(dataSource, table, target);
        const merchantKey = (await columnExists(dataSource, 'merchants', 'merchantId'))
          ? 'm."merchantId"'
          : (await columnExists(dataSource, 'merchants', 'merchant_id'))
            ? 'm.merchant_id'
            : '';
        const merchantCode = (await columnExists(dataSource, 'merchants', 'merchantCode'))
          ? 'm."merchantCode"'
          : (await columnExists(dataSource, 'merchants', 'merchant_code'))
            ? 'm.merchant_code'
            : '';
        const matches = [merchantKey, merchantCode, 'm.id::text'].filter(Boolean);
        const codeSources = presentSources.map(name => `row.${quoteIdent(name)}::text`);
        if (matches.length && codeSources.length && liveType !== 'uuid') {
          await dataSource.query(
            `UPDATE ${quotedTable} AS row SET ${quotedTarget} = m.id::text FROM public.merchants m WHERE row.${quotedTarget}::text !~* '${UUID_TEXT}' AND row.${quotedTarget}::text IN (${matches.join(', ')})`,
          );
          for (const codeSource of codeSources) {
            await dataSource.query(
              `UPDATE ${quotedTable} AS row SET ${quotedTarget} = m.id::text FROM public.merchants m WHERE (row.${quotedTarget} IS NULL OR row.${quotedTarget}::text !~* '${UUID_TEXT}') AND ${codeSource} IN (${matches.join(', ')})`,
            );
          }
        } else if (matches.length && codeSources.length) {
          for (const codeSource of codeSources) {
            await dataSource.query(
              `UPDATE ${quotedTable} AS row SET ${quotedTarget} = m.id FROM public.merchants m WHERE row.${quotedTarget} IS NULL AND ${codeSource} IN (${matches.join(', ')})`,
            );
          }
        }
        if (liveType && liveType !== 'uuid') {
          await dataSource.query(
            `UPDATE ${quotedTable} SET ${quotedTarget} = (SELECT id::text FROM public.merchants ORDER BY id LIMIT 1) WHERE ${quotedTarget} IS NULL OR ${quotedTarget}::text !~* '${UUID_TEXT}'`,
          );
          await dataSource.query(
            `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedTarget} TYPE uuid USING ${quotedTarget}::uuid`,
          );
        } else {
          await dataSource.query(
            `UPDATE ${quotedTable} SET ${quotedTarget} = (SELECT id FROM public.merchants ORDER BY id LIMIT 1) WHERE ${quotedTarget} IS NULL`,
          );
        }
      }
      if (sqlType === 'uuid' && target === 'store_type_id' && (await tableExists(dataSource, 'store_types'))) {
        const storeTypeCol = (await columnExists(dataSource, table, 'storeType')) ? '"storeType"' : '';
        if (storeTypeCol) {
          await dataSource.query(
            `UPDATE ${quotedTable} AS row SET store_type_id = st.id FROM public.store_types st WHERE row.store_type_id IS NULL AND (row.${storeTypeCol} = st."storeTypeCode" OR row.${storeTypeCol} = st.name OR row.${storeTypeCol} = st.id::text)`,
          );
        }
        await dataSource.query(
          `UPDATE ${quotedTable} SET store_type_id = (SELECT id FROM public.store_types ORDER BY id LIMIT 1) WHERE store_type_id IS NULL`,
        );
      }
      const uuidFallbackTable: Record<string, string> = {
        feature_id: 'features',
        store_id: 'stores',
        role_template_id: 'role_templates',
        role_id: 'roles',
        vendor_id: 'vendors',
        tendor_id: 'tendors',
        permission_id: 'feature_permissions',
      };
      const fallbackTable = uuidFallbackTable[target];
      if (
        sqlType === 'uuid' &&
        fallbackTable &&
        (await tableExists(dataSource, fallbackTable)) &&
        (await liveColumnType(dataSource, fallbackTable, 'id')) === 'uuid'
      ) {
        await dataSource.query(
          `UPDATE ${quotedTable} SET ${quotedTarget} = (SELECT id FROM public.${quoteIdent(fallbackTable)} ORDER BY id LIMIT 1) WHERE ${quotedTarget} IS NULL`,
        );
      }
      if (rawEnumName && assignAsEnum) {
        await dataSource.query(
          `UPDATE ${quotedTable} SET ${quotedTarget} = (SELECT e FROM unnest(enum_range(NULL::${quotedEnum})) AS e LIMIT 1) WHERE ${quotedTarget} IS NULL`,
        );
      } else if (rawEnumName) {
        const labels = enumLabels(column);
        if (target === 'vendor_type') {
          await dataSource.query(
            `UPDATE ${quotedTable} SET ${quotedTarget} = CASE upper(trim(${quotedTarget}::text))
              WHEN 'SUPPLIER' THEN 'SUPPLIER'
              WHEN 'SUPPLER' THEN 'SUPPLIER'
              WHEN 'ORGANIZER' THEN 'ORGANIZER'
              WHEN 'ORGANISER' THEN 'ORGANIZER'
              ELSE ${quotedTarget}
            END WHERE ${quotedTarget} IS NOT NULL`,
          );
        }
        if (labels.length) {
          await dataSource.query(
            `UPDATE ${quotedTable} AS row SET ${quotedTarget} = label FROM unnest($1::text[]) AS label WHERE upper(trim(row.${quotedTarget}::text)) = upper(label)`,
            [labels],
          );
          await dataSource.query(
            `UPDATE ${quotedTable} SET ${quotedTarget} = $1 WHERE ${quotedTarget} IS NULL OR ${quotedTarget}::text <> ALL($2::text[])`,
            [labels[0], labels],
          );
        }
      } else if (sqlType !== 'uuid') {
        const hasId = await columnExists(dataSource, table, 'id');
        const token = hasId ? `COALESCE(id::text, md5(ctid::text))` : `md5(ctid::text)`;
        const max = Number(column.length);
        const value = Number.isFinite(max) && max > 0 ? `LEFT('L' || ${token}, ${max})` : `'L' || ${token}`;
        await dataSource.query(
          `UPDATE ${quotedTable} SET ${quotedTarget} = ${value} WHERE ${quotedTarget} IS NULL`,
        );
      }
    }
    if (table === 'merchants' && (await columnExists(dataSource, table, 'merchant_code')) && (await columnExists(dataSource, table, 'merchant_id'))) {
      await dataSource.query(
        `UPDATE public.merchants SET merchant_id = merchant_id || '-ID' WHERE merchant_code IS NOT NULL AND merchant_id = merchant_code`,
      );
    }
  }
}

async function dropEntityForeignKeys(dataSource: DataSource): Promise<void> {
  const tables = new Set(dataSource.entityMetadatas.map(entity => entity.tableName));
  const rows: Array<{ table: string; conname: string }> = await dataSource.query(
    `SELECT c.relname AS table, con.conname
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'f' AND n.nspname = 'public'`,
  );
  for (const row of rows) {
    if (!tables.has(row.table)) continue;
    await dataSource.query(
      `ALTER TABLE public.${quoteIdent(row.table)} DROP CONSTRAINT IF EXISTS ${quoteIdent(row.conname)}`,
    );
  }
}

/** Null nullable foreign keys that point nowhere, and point required ones at a real parent row. */
async function clearOrphanForeignKeys(dataSource: DataSource): Promise<void> {
  for (const entity of dataSource.entityMetadatas) {
    const table = entity.tableName;
    if (!(await tableExists(dataSource, table))) continue;
    for (const foreignKey of entity.foreignKeys) {
      const column = foreignKey.columnNames[0];
      const referenced = foreignKey.referencedColumnNames[0];
      const refTable = foreignKey.referencedEntityMetadata?.tableName;
      if (!column || !referenced || !refTable) continue;
      if (!(await columnExists(dataSource, table, column))) continue;
      const quotedTable = `public.${quoteIdent(table)}`;
      const quotedColumn = quoteIdent(column);
      const nullable = entity.columns.find(item => item.databaseName === column)?.isNullable === true;
      const parentReady = (await tableExists(dataSource, refTable)) && (await columnExists(dataSource, refTable, referenced));
      if (!parentReady) {
        if (nullable) {
          await dataSource.query(`UPDATE ${quotedTable} SET ${quotedColumn} = NULL WHERE ${quotedColumn} IS NOT NULL`);
        } else {
          await dataSource.query(`DELETE FROM ${quotedTable}`);
        }
        continue;
      }
      const quotedRef = `public.${quoteIdent(refTable)}`;
      const quotedReferenced = quoteIdent(referenced);
      const parentCount = await dataSource.query(`SELECT COUNT(*)::int AS n FROM ${quotedRef}`);
      if (Number(parentCount[0]?.n ?? 0) === 0) {
        if (nullable) {
          await dataSource.query(`UPDATE ${quotedTable} SET ${quotedColumn} = NULL WHERE ${quotedColumn} IS NOT NULL`);
        } else {
          await dataSource.query(`DELETE FROM ${quotedTable}`);
        }
        continue;
      }
      const missing = `row.${quotedColumn} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${quotedRef} ref WHERE ref.${quotedReferenced}::text = row.${quotedColumn}::text)`;
      if (nullable) {
        await dataSource.query(`UPDATE ${quotedTable} AS row SET ${quotedColumn} = NULL WHERE ${missing}`);
      } else {
        await dataSource.query(
          `UPDATE ${quotedTable} AS row SET ${quotedColumn} = (SELECT ${quotedReferenced} FROM ${quotedRef} ORDER BY ${quotedReferenced} LIMIT 1) WHERE ${missing}`,
        );
      }
    }
  }
}

/** Keep one row per unique value and suffix the rest so synchronize can add the index. */
async function dedupeUniqueColumns(dataSource: DataSource): Promise<void> {
  for (const entity of dataSource.entityMetadatas) {
    const table = entity.tableName;
    if (!(await tableExists(dataSource, table))) continue;
    const uniqueNames = new Set<string>();
    for (const index of entity.indices) {
      if (index.isUnique && index.columns.length === 1) uniqueNames.add(index.columns[0].databaseName);
    }
    for (const unique of entity.uniques) {
      if (unique.columns?.length === 1) uniqueNames.add(unique.columns[0].databaseName);
    }
    for (const column of entity.columns) {
      if (!uniqueNames.has(column.databaseName)) continue;
      const columnType = String(column.type || '');
      if (columnType === 'uuid' || columnType === 'int' || columnType === 'integer' || columnType === 'bigint') continue;
      const target = column.databaseName;
      if (!target || !(await columnExists(dataSource, table, target))) continue;
      const quotedTable = `public.${quoteIdent(table)}`;
      const quotedTarget = quoteIdent(target);
      const max = Number(column.length);
      const suffixed = Number.isFinite(max) && max > 1
        ? `LEFT(row.${quotedTarget}::text, ${max} - char_length('-' || d.rn::text)) || '-' || d.rn::text`
        : `row.${quotedTarget}::text || '-' || d.rn::text`;
      await dataSource.query(
        `UPDATE ${quotedTable} AS row SET ${quotedTarget} = ${suffixed} FROM (
          SELECT ctid, ROW_NUMBER() OVER (PARTITION BY ${quotedTarget} ORDER BY ctid) AS rn
          FROM ${quotedTable}
          WHERE ${quotedTarget} IS NOT NULL
        ) d WHERE row.ctid = d.ctid AND d.rn > 1`,
      );
    }
  }
}

async function backfillOptionalUniqueColumns(dataSource: DataSource): Promise<void> {
  if (await tableExists(dataSource, 'inventory_items')) {
    await addVarcharColumnIfMissing(dataSource, 'inventory_items', 'storeId');
    await addVarcharColumnIfMissing(dataSource, 'inventory_items', 'productId');
    await addVarcharColumnIfMissing(dataSource, 'inventory_items', 'productName', 255);
    // Cast every COALESCE arm to text — Postgres rejects COALESCE(text, uuid).
    const storeFallback = (await columnExists(dataSource, 'inventory_items', 'merchantId'))
      ? `COALESCE(NULLIF("storeId"::text, ''), "merchantId"::text, 'UNKNOWN')`
      : `COALESCE(NULLIF("storeId"::text, ''), 'UNKNOWN')`;
    await dataSource.query(
      `UPDATE public.inventory_items SET "storeId" = ${storeFallback} WHERE "storeId" IS NULL OR "storeId"::text = ''`,
    );
    const productFallback = (await columnExists(dataSource, 'inventory_items', 'ingredientId'))
      ? `COALESCE(NULLIF("productId"::text, ''), "ingredientId"::text, id::text)`
      : `COALESCE(NULLIF("productId"::text, ''), id::text)`;
    await dataSource.query(
      `UPDATE public.inventory_items SET "productId" = ${productFallback} WHERE "productId" IS NULL OR "productId"::text = ''`,
    );
    const nameFallback = (await columnExists(dataSource, 'inventory_items', 'name'))
      ? `COALESCE(NULLIF("productName"::text, ''), name::text, 'Item')`
      : `COALESCE(NULLIF("productName"::text, ''), 'Item')`;
    await dataSource.query(
      `UPDATE public.inventory_items SET "productName" = ${nameFallback} WHERE "productName" IS NULL OR "productName"::text = ''`,
    );
    for (const column of [
      'quantityOnHand',
      'quantityReserved',
      'quantityAvailable',
      'reorderPoint',
      'unitCost',
      'unitPrice',
    ]) {
      await addDecimalColumnIfMissing(dataSource, 'inventory_items', column);
    }
  }

  if (await tableExists(dataSource, 'inventory_adjustments')) {
    await addVarcharColumnIfMissing(dataSource, 'inventory_adjustments', 'storeId');
    await addVarcharColumnIfMissing(dataSource, 'inventory_adjustments', 'productId');
    await dataSource.query(
      `UPDATE public.inventory_adjustments SET "storeId" = COALESCE(NULLIF("storeId"::text, ''), 'UNKNOWN') WHERE "storeId" IS NULL OR "storeId"::text = ''`,
    );
    await dataSource.query(
      `UPDATE public.inventory_adjustments SET "productId" = COALESCE(NULLIF("productId"::text, ''), id::text) WHERE "productId" IS NULL OR "productId"::text = ''`,
    );
  }
}

/**
 * Existing queries still name the pre-schema camelCase columns. Synchronize
 * keeps the entity columns, then these mirrors are recreated so those queries
 * can read and write the same rows.
 */
async function ensureLegacyQueryColumns(dataSource: DataSource): Promise<void> {
  const install = async (table: string, requiredColumn: string, sql: string) => {
    if (!(await tableExists(dataSource, table))) return;
    if (!(await columnExists(dataSource, table, requiredColumn))) return;
    await dataSource.query(sql);
  };

  await install('stores', 'updated_at', `
    ALTER TABLE public.stores ALTER COLUMN updated_at DROP NOT NULL;
    ALTER TABLE public.stores ALTER COLUMN updated_at DROP DEFAULT;
    ALTER TABLE public.stores ALTER COLUMN updated_by DROP NOT NULL;
    ALTER TABLE public.stores ALTER COLUMN updated_by DROP DEFAULT;
    DROP TRIGGER IF EXISTS stores_create_audit ON public.stores;
    DROP FUNCTION IF EXISTS public.clear_store_update_audit_on_insert();
  `);

  await install('tendors', 'updated_at', `
    ALTER TABLE public.tendors ALTER COLUMN updated_at DROP NOT NULL;
    ALTER TABLE public.tendors ALTER COLUMN updated_at DROP DEFAULT;
    ALTER TABLE public.tendors ALTER COLUMN updated_by DROP NOT NULL;
    ALTER TABLE public.tendors ALTER COLUMN updated_by DROP DEFAULT;
  `);

  await install('employees', 'updated_at', `
    ALTER TABLE public.employees ALTER COLUMN updated_at DROP NOT NULL;
    ALTER TABLE public.employees ALTER COLUMN updated_at DROP DEFAULT;
    ALTER TABLE public.employees ALTER COLUMN updated_by DROP NOT NULL;
    ALTER TABLE public.employees ALTER COLUMN updated_by DROP DEFAULT;
  `);

  await install('plans', 'updated_at', `
    ALTER TABLE public.plans ALTER COLUMN updated_at DROP NOT NULL;
    ALTER TABLE public.plans ALTER COLUMN updated_at DROP DEFAULT;
    ALTER TABLE public.plans ALTER COLUMN updated_by DROP NOT NULL;
    ALTER TABLE public.plans ALTER COLUMN updated_by DROP DEFAULT;
  `);

  await install('role_templates', 'updated_at', `
    ALTER TABLE public.role_templates ALTER COLUMN updated_at DROP NOT NULL;
    ALTER TABLE public.role_templates ALTER COLUMN updated_at DROP DEFAULT;
    ALTER TABLE public.role_templates ALTER COLUMN updated_by DROP NOT NULL;
    ALTER TABLE public.role_templates ALTER COLUMN updated_by DROP DEFAULT;
  `);

  await install('feature_permissions', 'updated_at', `
    ALTER TABLE public.feature_permissions ALTER COLUMN updated_at DROP NOT NULL;
    ALTER TABLE public.feature_permissions ALTER COLUMN updated_at DROP DEFAULT;
    ALTER TABLE public.feature_permissions ALTER COLUMN updated_by DROP NOT NULL;
    ALTER TABLE public.feature_permissions ALTER COLUMN updated_by DROP DEFAULT;
  `);

  await install('vendors', 'updated_at', `
    ALTER TABLE public.vendors ALTER COLUMN updated_at DROP NOT NULL;
    ALTER TABLE public.vendors ALTER COLUMN updated_at DROP DEFAULT;
    ALTER TABLE public.vendors ALTER COLUMN updated_by DROP NOT NULL;
    ALTER TABLE public.vendors ALTER COLUMN updated_by DROP DEFAULT;
  `);

  await install('merchants', 'merchant_code', `
    ALTER TABLE public.merchants ALTER COLUMN updated_at DROP NOT NULL;
    ALTER TABLE public.merchants ALTER COLUMN updated_at DROP DEFAULT;
    ALTER TABLE public.merchants ALTER COLUMN updated_by DROP NOT NULL;
    ALTER TABLE public.merchants ALTER COLUMN updated_by DROP DEFAULT;
    ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS "merchantId" varchar(100);
    ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS "merchantCode" varchar(100);
    ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS "businessName" varchar(255);
    ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS "businessDisplayName" varchar(255);
    ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS "addressLine1" text;
    ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS "addressLine2" text;
    ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS "postalCode" varchar(30);
    ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS "firstName" varchar(100);
    ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS "lastName" varchar(100);
    ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS "createdAt" timestamptz;
    ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz;
    ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS "createdDate" timestamptz;
    UPDATE public.merchants SET
      "merchantId" = merchant_id,
      "merchantCode" = merchant_code,
      "businessName" = business_display_name,
      "businessDisplayName" = business_display_name,
      "addressLine1" = address_line1,
      "addressLine2" = address_line2,
      "postalCode" = postal_code,
      "firstName" = first_name,
      "lastName" = last_name,
      "createdAt" = NULLIF(created_at::text, '')::timestamptz,
      "updatedAt" = NULLIF(updated_at::text, '')::timestamptz,
      "createdDate" = NULLIF(created_at::text, '')::timestamptz;
    CREATE OR REPLACE FUNCTION public.sync_merchants_legacy_cols() RETURNS trigger AS $fn$
    BEGIN
      NEW.merchant_code := COALESCE(NULLIF(NEW.merchant_code, ''), NULLIF(NEW."merchantCode", ''), 'MCH-' || left(COALESCE(NEW.id::text, gen_random_uuid()::text), 8));
      NEW."merchantCode" := COALESCE(NULLIF(NEW."merchantCode", ''), NEW.merchant_code);
      NEW.merchant_id := COALESCE(NULLIF(NEW.merchant_id, ''), NULLIF(NEW."merchantId", ''));
      IF NEW.merchant_id IS NULL OR NEW.merchant_id = NEW.merchant_code THEN
        NEW.merchant_id := 'MID-' || left(COALESCE(NEW.id::text, gen_random_uuid()::text), 8);
      END IF;
      NEW."merchantId" := NEW.merchant_id;
      NEW.business_display_name := COALESCE(NEW.business_display_name, NEW."businessDisplayName", NEW."businessName");
      NEW."businessName" := COALESCE(NEW."businessName", NEW.business_display_name);
      NEW."businessDisplayName" := COALESCE(NEW."businessDisplayName", NEW.business_display_name);
      NEW.address_line1 := COALESCE(NEW.address_line1, NEW."addressLine1");
      NEW."addressLine1" := COALESCE(NEW."addressLine1", NEW.address_line1);
      NEW.address_line2 := COALESCE(NEW.address_line2, NEW."addressLine2");
      NEW."addressLine2" := COALESCE(NEW."addressLine2", NEW.address_line2);
      NEW.postal_code := COALESCE(NEW.postal_code, NEW."postalCode");
      NEW."postalCode" := COALESCE(NEW."postalCode", NEW.postal_code);
      NEW.first_name := COALESCE(NEW.first_name, NEW."firstName");
      NEW."firstName" := COALESCE(NEW."firstName", NEW.first_name);
      NEW.last_name := COALESCE(NEW.last_name, NEW."lastName");
      NEW."lastName" := COALESCE(NEW."lastName", NEW.last_name);
      NEW."createdAt" := COALESCE(NEW."createdAt", NULLIF(NEW.created_at::text, '')::timestamptz, now());
      NEW."updatedAt" := COALESCE(NEW."updatedAt", NULLIF(NEW.updated_at::text, '')::timestamptz, now());
      NEW."createdDate" := COALESCE(NEW."createdDate", NULLIF(NEW.created_at::text, '')::timestamptz, now());
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS merchants_legacy_cols ON public.merchants;
    CREATE TRIGGER merchants_legacy_cols BEFORE INSERT OR UPDATE ON public.merchants
      FOR EACH ROW EXECUTE PROCEDURE public.sync_merchants_legacy_cols();
  `);

  await install('features', 'feature_code', `
    ALTER TABLE public.features ALTER COLUMN feature_type TYPE varchar(100);
    DO $drop$
    DECLARE constraint_row record;
    BEGIN
      FOR constraint_row IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.features'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%feature_type%'
      LOOP
        EXECUTE format('ALTER TABLE public.features DROP CONSTRAINT %I', constraint_row.conname);
      END LOOP;
    END;
    $drop$;
    ALTER TABLE public.features DROP COLUMN IF EXISTS category;
    ALTER TABLE public.features DROP COLUMN IF EXISTS feature_category;
    DROP TRIGGER IF EXISTS features_legacy_cols ON public.features;
    DROP FUNCTION IF EXISTS public.sync_features_legacy_cols() CASCADE;
    DO $camel$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='features' AND column_name='featureKey') THEN
        UPDATE public.features SET feature_code = COALESCE(NULLIF(feature_code, ''), NULLIF("featureKey", ''));
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='features' AND column_name='featureType') THEN
        UPDATE public.features SET feature_type = COALESCE(NULLIF(feature_type::text, ''), NULLIF("featureType"::text, ''));
      END IF;
    END;
    $camel$;
    ALTER TABLE public.features DROP COLUMN IF EXISTS "featureKey";
    ALTER TABLE public.features DROP COLUMN IF EXISTS "featureType";
  `);

  const featureAuditAndCodeSql = `
    ALTER TABLE public.features ADD COLUMN IF NOT EXISTS created_by uuid;
    ALTER TABLE public.features ADD COLUMN IF NOT EXISTS updated_by uuid;
    ALTER TABLE public.features ALTER COLUMN updated_at DROP NOT NULL;
    ALTER TABLE public.features ALTER COLUMN updated_at DROP DEFAULT;
    ALTER TABLE public.features ALTER COLUMN updated_by DROP NOT NULL;
    ALTER TABLE public.features ALTER COLUMN updated_by DROP DEFAULT;
    CREATE SEQUENCE IF NOT EXISTS public.features_code_seq START WITH 1;
    CREATE OR REPLACE FUNCTION public.generate_feature_code() RETURNS trigger AS $fn$
    DECLARE
      candidate text;
      duplicate_code boolean;
      key_name text;
    BEGIN
      LOOP
        candidate := 'FTR_' || lpad(nextval('public.features_code_seq')::text, 3, '0');
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.features WHERE %I = $1 AND id IS DISTINCT FROM $2)', TG_ARGV[0])
          INTO duplicate_code USING candidate, NEW.id;
        EXIT WHEN NOT duplicate_code;
      END LOOP;
      FOREACH key_name IN ARRAY string_to_array(TG_ARGV[1], ',') LOOP
        NEW := jsonb_populate_record(NEW, jsonb_build_object(key_name, candidate));
      END LOOP;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
    DO $trigger$
    DECLARE
      key_column text;
      key_columns text;
      max_code bigint;
      sequence_value bigint;
      sequence_called boolean;
    BEGIN
      SELECT column_name INTO key_column
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'features'
        AND lower(column_name) IN ('feature_key', 'feature_code')
      ORDER BY CASE lower(column_name) WHEN 'feature_key' THEN 0 WHEN 'feature_code' THEN 1 ELSE 2 END
      LIMIT 1;
      SELECT string_agg(column_name, ',' ORDER BY CASE lower(column_name) WHEN 'feature_key' THEN 0 ELSE 1 END)
        INTO key_columns
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'features'
        AND lower(column_name) IN ('feature_key', 'feature_code');
      IF key_column IS NOT NULL THEN
        EXECUTE format(
          'SELECT max((substring(%I from ''^FTR_([0-9]+)$''))::bigint) FROM public.features WHERE %I ~ ''^FTR_[0-9]+$''',
          key_column, key_column
        ) INTO max_code;
        SELECT last_value, is_called INTO sequence_value, sequence_called FROM public.features_code_seq;
        IF max_code IS NOT NULL THEN
          PERFORM setval('public.features_code_seq', GREATEST(max_code, sequence_value, 1), true);
        ELSIF sequence_called THEN
          PERFORM setval('public.features_code_seq', sequence_value, true);
        END IF;
        DROP TRIGGER IF EXISTS features_generate_code ON public.features;
        EXECUTE format('CREATE TRIGGER features_generate_code BEFORE INSERT ON public.features FOR EACH ROW EXECUTE FUNCTION public.generate_feature_code(%L, %L)', key_column, key_columns);
      END IF;
    END;
    $trigger$;
  `;
  await install('features', 'feature_code', featureAuditAndCodeSql);
  await install('features', 'feature_key', featureAuditAndCodeSql);

  await install('store_types', 'store_type_code', `
    ALTER TABLE public.store_types ADD COLUMN IF NOT EXISTS "storeTypeCode" varchar(100);
    UPDATE public.store_types SET "storeTypeCode" = store_type_code WHERE "storeTypeCode" IS NULL;
    DROP TRIGGER IF EXISTS store_types_legacy_cols ON public.store_types CASCADE;
    DROP FUNCTION IF EXISTS public.sync_store_types_legacy_cols() CASCADE;
  `);

  await install('subscriptions', 'subscription_code', `
    ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS "merchantId" varchar(100);
    ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS "subscriptionId" varchar(100);
    ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS "subscriptionCode" varchar(100);
    ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS start_date date;
    ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS "startDate" date;
    ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS renewal_date date;
    ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS "renewalDate" date;
    ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS trial_end_date date;
    ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS "trialEndDate" date;
    ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS "createdAt" timestamptz;
    ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz;
    CREATE OR REPLACE FUNCTION public.sync_subscriptions_legacy_cols() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.price IS NULL THEN NEW.price := 0; END IF;
      NEW.subscription_code := COALESCE(NULLIF(NEW.subscription_code, ''), NULLIF(NEW."subscriptionCode", ''), NULLIF(NEW."subscriptionId", ''), NEW.id::text);
      NEW."subscriptionCode" := COALESCE(NULLIF(NEW."subscriptionCode", ''), NEW.subscription_code);
      NEW."subscriptionId" := COALESCE(NULLIF(NEW."subscriptionId", ''), NEW.subscription_code);
      IF NEW.merchant_id IS NULL AND NEW."merchantId" IS NOT NULL THEN
        SELECT m.id::text INTO NEW.merchant_id FROM public.merchants m
         WHERE m.merchant_id = NEW."merchantId" OR m.merchant_code = NEW."merchantId" OR m.id::text = NEW."merchantId"
         LIMIT 1;
      END IF;
      IF NEW.merchant_id IS NOT NULL THEN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'merchants' AND column_name = 'merchant_id'
        ) THEN
          EXECUTE 'SELECT merchant_id FROM public.merchants WHERE id::text = $1 LIMIT 1'
            INTO NEW."merchantId" USING NEW.merchant_id::text;
        ELSIF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'merchants' AND column_name = 'merchantId'
        ) THEN
          EXECUTE 'SELECT "merchantId" FROM public.merchants WHERE id::text = $1 LIMIT 1'
            INTO NEW."merchantId" USING NEW.merchant_id::text;
        END IF;
      END IF;
      NEW.start_date := COALESCE(NEW.start_date, NEW."startDate");
      NEW."startDate" := COALESCE(NEW."startDate", NEW.start_date);
      NEW.renewal_date := COALESCE(NEW.renewal_date, NEW."renewalDate");
      NEW."renewalDate" := COALESCE(NEW."renewalDate", NEW.renewal_date);
      NEW.trial_end_date := COALESCE(NEW.trial_end_date, NEW."trialEndDate");
      NEW."trialEndDate" := COALESCE(NEW."trialEndDate", NEW.trial_end_date);
      NEW."createdAt" := COALESCE(NEW."createdAt", NULLIF(NEW.created_at::text, '')::timestamptz, now());
      NEW."updatedAt" := COALESCE(NEW."updatedAt", NULLIF(NEW.updated_at::text, '')::timestamptz, now());
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS subscriptions_legacy_cols ON public.subscriptions;
    CREATE TRIGGER subscriptions_legacy_cols BEFORE INSERT OR UPDATE ON public.subscriptions
      FOR EACH ROW EXECUTE PROCEDURE public.sync_subscriptions_legacy_cols();
    UPDATE public.subscriptions s SET
      "subscriptionId" = s.subscription_code,
      "subscriptionCode" = s.subscription_code,
      "startDate" = COALESCE(s."startDate", s.start_date),
      "renewalDate" = COALESCE(s."renewalDate", s.renewal_date),
      "trialEndDate" = COALESCE(s."trialEndDate", s.trial_end_date),
      "createdAt" = NULLIF(s.created_at::text, '')::timestamptz,
      "updatedAt" = NULLIF(s.updated_at::text, '')::timestamptz;
    UPDATE public.subscriptions s SET "merchantId" = COALESCE(to_jsonb(m)->>'merchant_id', to_jsonb(m)->>'merchantId')
      FROM public.merchants m WHERE s.merchant_id::text = m.id::text;
  `);

  await install('vendors', 'vendor_code', `
    ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz;
    ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS "vendorName" varchar(150);
    ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS "vendorCode" varchar(50);
    ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS "vendorType" varchar(50);
    ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS "contactPerson" varchar(150);
    ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS "productCategory" varchar(150);
    UPDATE public.vendors SET
      "vendorName" = vendor_name,
      "vendorCode" = vendor_code,
      "vendorType" = vendor_type::text,
      "contactPerson" = contact_person,
      "productCategory" = product_category,
      "deletedAt" = CASE WHEN is_deleted THEN COALESCE("deletedAt", updated_at, now()) ELSE NULL END;
    CREATE OR REPLACE FUNCTION public.sync_vendors_legacy_cols() RETURNS trigger AS $fn$
    DECLARE
      legacy jsonb;
    BEGIN
      legacy := to_jsonb(NEW);
      NEW.vendor_code := COALESCE(NULLIF(NEW.vendor_code, ''), NULLIF(legacy->>'vendorCode', ''));
      NEW.vendor_name := COALESCE(NULLIF(NEW.vendor_name, ''), NULLIF(legacy->>'vendorName', ''));
      NEW.contact_person := COALESCE(NEW.contact_person, legacy->>'contactPerson');
      NEW.product_category := COALESCE(NEW.product_category, legacy->>'productCategory');
      NEW := jsonb_populate_record(NEW, jsonb_build_object(
        'vendorCode', COALESCE(NULLIF(legacy->>'vendorCode', ''), NEW.vendor_code),
        'vendorName', COALESCE(NULLIF(legacy->>'vendorName', ''), NEW.vendor_name),
        'vendorType', COALESCE(NEW.vendor_type::text, legacy->>'vendorType'),
        'contactPerson', COALESCE(legacy->>'contactPerson', NEW.contact_person),
        'productCategory', COALESCE(legacy->>'productCategory', NEW.product_category),
        'deletedAt', CASE WHEN NEW.is_deleted THEN COALESCE(legacy->>'deletedAt', now()::text) ELSE NULL END
      ));
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS vendors_legacy_cols ON public.vendors;
    CREATE TRIGGER vendors_legacy_cols BEFORE INSERT OR UPDATE ON public.vendors
      FOR EACH ROW EXECUTE PROCEDURE public.sync_vendors_legacy_cols();
  `);

  await install('tendors', 'tendor_code', `
    DROP TRIGGER IF EXISTS tendors_legacy_cols ON public.tendors;
    ALTER TABLE public.tendors ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz;
    ALTER TABLE public.tendors ADD COLUMN IF NOT EXISTS "tendorName" varchar(150);
    ALTER TABLE public.tendors ADD COLUMN IF NOT EXISTS "tendorCode" varchar(50);
    UPDATE public.tendors SET
      "tendorName" = tendor_name,
      "tendorCode" = tendor_code,
      "deletedAt" = CASE WHEN is_deleted THEN COALESCE("deletedAt", updated_at, now()) ELSE NULL END;
    CREATE OR REPLACE FUNCTION public.sync_tendors_legacy_cols() RETURNS trigger AS $fn$
    BEGIN
      NEW.tendor_code := COALESCE(NULLIF(NEW.tendor_code, ''), NULLIF(NEW."tendorCode", ''));
      NEW."tendorCode" := COALESCE(NULLIF(NEW."tendorCode", ''), NEW.tendor_code);
      NEW.tendor_name := COALESCE(NULLIF(NEW.tendor_name, ''), NULLIF(NEW."tendorName", ''));
      NEW."tendorName" := COALESCE(NULLIF(NEW."tendorName", ''), NEW.tendor_name);
      NEW."deletedAt" := CASE WHEN NEW.is_deleted THEN COALESCE(NEW."deletedAt", now()) ELSE NULL END;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS tendors_legacy_cols ON public.tendors;
    CREATE TRIGGER tendors_legacy_cols BEFORE INSERT OR UPDATE ON public.tendors
      FOR EACH ROW EXECUTE PROCEDURE public.sync_tendors_legacy_cols();
  `);

  await install('devices', 'device_code', `
    ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS "deviceCode" varchar(100);
    ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS "deviceName" varchar(255);
    ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS "deviceType" varchar(100);
    ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS "serialNumber" varchar(100);
    ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS "merchantName" varchar(255);
    ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS "merchantId" varchar(100);
    ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS "createdAt" timestamptz;
    ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS notes text;
    ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS device_id text;
    ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS authorization_code varchar(100);
    ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS device_active_code varchar(100);
    ALTER TABLE public.devices ALTER COLUMN serial_number DROP NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS devices_authorization_code_uidx ON public.devices (authorization_code) WHERE authorization_code IS NOT NULL AND authorization_code <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS devices_device_active_code_uidx ON public.devices (device_active_code) WHERE device_active_code IS NOT NULL AND device_active_code <> '';
    UPDATE public.devices SET
      "deviceCode" = device_code,
      "deviceName" = device_name,
      "deviceType" = device_type,
      "serialNumber" = serial_number,
      "merchantName" = merchant_name,
      "merchantId" = merchant_id::text,
      "createdAt" = created_at;
    CREATE OR REPLACE FUNCTION public.sync_devices_legacy_cols() RETURNS trigger AS $fn$
    BEGIN
      NEW.device_code := COALESCE(NULLIF(NEW.device_code, ''), NULLIF(NEW."deviceCode", ''));
      NEW."deviceCode" := COALESCE(NULLIF(NEW."deviceCode", ''), NEW.device_code);
      NEW.device_name := COALESCE(NULLIF(NEW.device_name, ''), NULLIF(NEW."deviceName", ''));
      NEW."deviceName" := COALESCE(NULLIF(NEW."deviceName", ''), NEW.device_name);
      NEW.device_type := COALESCE(NULLIF(NEW.device_type, ''), NULLIF(NEW."deviceType", ''));
      NEW."deviceType" := COALESCE(NULLIF(NEW."deviceType", ''), NEW.device_type);
      NEW.serial_number := COALESCE(NULLIF(NEW.serial_number, ''), NULLIF(NEW."serialNumber", ''));
      NEW."serialNumber" := COALESCE(NULLIF(NEW."serialNumber", ''), NEW.serial_number);
      NEW.merchant_name := COALESCE(NULLIF(NEW.merchant_name, ''), NULLIF(NEW."merchantName", ''));
      NEW."merchantName" := COALESCE(NULLIF(NEW."merchantName", ''), NEW.merchant_name);
      NEW."merchantId" := COALESCE(NEW.merchant_id::text, NEW."merchantId");
      NEW."createdAt" := COALESCE(NEW."createdAt", NULLIF(NEW.created_at::text, '')::timestamptz, now());
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS devices_legacy_cols ON public.devices;
    CREATE TRIGGER devices_legacy_cols BEFORE INSERT OR UPDATE ON public.devices
      FOR EACH ROW EXECUTE PROCEDURE public.sync_devices_legacy_cols();
  `);
}

function columnDefaultSql(column: {
  default?: unknown;
  type?: unknown;
  isCreateDate?: boolean;
  isUpdateDate?: boolean;
  isGenerated?: boolean;
  generationStrategy?: string;
}): string | null {
  if (column.isCreateDate || column.isUpdateDate) return 'now()';
  if (column.isGenerated && column.generationStrategy === 'uuid') return 'gen_random_uuid()';
  let value = column.default;
  if (typeof value === 'function') {
    try {
      value = value();
    } catch {
      return null;
    }
  }
  if (value === undefined || value === null) return null;
  const type = typeof column.type === 'string' ? column.type.toLowerCase() : '';
  if ((type === 'json' || type === 'jsonb') && typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::${type}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value).trim();
  if (!text) return `''`;
  if (text.includes('(') || text.startsWith("'") || /^-?\d+(\.\d+)?$/.test(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

function missingColumnSqlType(column: {
  type?: unknown;
  length?: string | number;
  enum?: unknown;
  enumName?: string;
}): string {
  if ((column.type === 'enum' || column.enumName) && column.enumName) return quoteIdent(column.enumName);
  if (column.type === 'timestamp') return 'timestamp';
  return columnSqlType(column);
}

async function ensureEnumTypes(
  dataSource: DataSource,
  columns: Array<{ type?: unknown; enum?: unknown; enumName?: string }>,
): Promise<void> {
  const seen = new Set<string>();
  for (const column of columns) {
    if (!column.enumName || seen.has(column.enumName)) continue;
    const labels = enumLabels(column);
    if (!labels.length) continue;
    seen.add(column.enumName);
    const values = labels.map(label => `'${label.replace(/'/g, "''")}'`).join(', ');
    await dataSource.query(
      `DO $$ BEGIN CREATE TYPE ${quoteIdent(column.enumName)} AS ENUM (${values}); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    );
  }
}

/**
 * Create entity tables that are not in the database yet.
 * Existing tables are never altered. TypeORM synchronize drops and re-adds
 * columns, and PostgreSQL keeps every dropped column until the 1600-column limit.
 */
export async function createMissingTables(dataSource: DataSource): Promise<string[]> {
  const missing = [];
  for (const entity of dataSource.entityMetadatas) {
    if (!(await tableExists(dataSource, entity.tableName))) missing.push(entity);
  }
  if (!missing.length) return [];

  const created: string[] = [];
  for (const entity of missing) {
    const columns = entity.columns.filter(column => !column.isVirtual);
    const uniqueColumns = new Set<string>();
    for (const unique of entity.uniques ?? []) {
      if (unique.columns?.length === 1) uniqueColumns.add(unique.columns[0].databaseName);
    }
    for (const index of entity.indices ?? []) {
      if (index.isUnique && index.columns.length === 1) uniqueColumns.add(index.columns[0].databaseName);
    }
    await ensureEnumTypes(dataSource, columns);
    const definitions = columns.map(column => {
      const parts = [
        quoteIdent(column.databaseName),
        missingColumnSqlType(column),
      ];
      const fallback = columnDefaultSql(column);
      if (fallback) parts.push(`DEFAULT ${fallback}`);
      if (!column.isNullable) parts.push('NOT NULL');
      if (uniqueColumns.has(column.databaseName) && !column.isPrimary) parts.push('UNIQUE');
      return parts.join(' ');
    });
    const primaryKey = columns.filter(column => column.isPrimary).map(column => quoteIdent(column.databaseName));
    if (primaryKey.length) definitions.push(`PRIMARY KEY (${primaryKey.join(', ')})`);
    await dataSource.query(
      `CREATE TABLE IF NOT EXISTS public.${quoteIdent(entity.tableName)} (${definitions.join(', ')})`,
    );
    created.push(entity.tableName);
  }
  return created;
}

function isRetryablePostgresError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|the database system is starting|timeout expired|Connection terminated/i.test(
    message,
  );
}

export async function connectPostgres(
  serviceName: string,
  entities: DataSourceOptions['entities'],
  settings: { synchronize?: boolean; legacyQueryColumns?: boolean } = {},
): Promise<DataSource> {
  const options = { ...postgresConnectionOptions(entities), ...settings };
  const attempts = Number(process.env.POSTGRES_CONNECT_ATTEMPTS) || 20;
  const delayMs = Number(process.env.POSTGRES_CONNECT_RETRY_MS) || 500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const dataSource = new DataSource({ ...options, synchronize: false });
    try {
      await dataSource.initialize();
      if (options.synchronize || settings.legacyQueryColumns) {
        // Repositories initialize concurrently, including across service processes.
        // Keep a dedicated connection so the session lock covers every schema query.
        const schemaLock = dataSource.createQueryRunner();
        await schemaLock.connect();
        try {
          await schemaLock.query('SELECT pg_advisory_lock(724621, 1)');
          try {
            if (options.synchronize) {
              await dropEntityForeignKeys(dataSource);
              await alignLegacyCamelCaseColumns(dataSource);
              await backfillRequiredColumnsBeforeSync(dataSource);
              await dedupeUniqueColumns(dataSource);
              await clearOrphanForeignKeys(dataSource);
              await backfillOptionalUniqueColumns(dataSource);
              await dropIndexesOutsideEntities(dataSource);
              await dataSource.synchronize();
              if (await tableExists(dataSource, 'stores')) {
                await dataSource.query('DROP TRIGGER IF EXISTS pch_store_merchant_uuid_biu ON public.stores');
                await dataSource.query('DROP FUNCTION IF EXISTS public.pch_set_store_merchant_uuid()');
              }
            }
            if (settings.legacyQueryColumns) await ensureLegacyQueryColumns(dataSource);
          } finally {
            await schemaLock.query('SELECT pg_advisory_unlock(724621, 1)');
          }
        } finally {
          await schemaLock.release();
        }
      } else if (settings.legacyQueryColumns) {
        await ensureLegacyQueryColumns(dataSource);
      }
      console.log(`🐘 [${serviceName}] Connected to PostgreSQL ${describeTarget(options)}`);
      return dataSource;
    } catch (error: unknown) {
      lastError = error;
      if (dataSource.isInitialized) await dataSource.destroy().catch(() => undefined);
      if (attempt < attempts && isRetryablePostgresError(error)) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      break;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  const driver = lastError && typeof lastError === 'object' && 'driverError' in lastError
    ? (lastError as { driverError?: { detail?: string; table?: string; column?: string } }).driverError
    : undefined;
  const extra = [driver?.table, driver?.column, driver?.detail].filter(Boolean).join(': ');
  throw new Error(
    `${serviceName} failed to initialize PostgreSQL at ${describeTarget(options)}: ${message}${extra ? ` (${extra})` : ''}`,
  );
}

export interface DatabaseClient {
  connect(): Promise<void>;
}
