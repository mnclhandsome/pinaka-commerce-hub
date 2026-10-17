import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { StoreTypeStatus } from '../../../entities/store-type.entity';
import { MerchantRepository } from '../../merchant/merchant.repository';
import { CreateStoreTypeDto, UpdateStoreTypeDto } from './store-type.dto';

@Injectable()
export class StoreTypeRepository {
  private cachedCols: string[] | null = null;

  constructor(
    @Inject(MerchantRepository)
    private readonly merchants: MerchantRepository,
  ) {}

  private async ensureTable(): Promise<string[]> {
    if (this.cachedCols && this.cachedCols.length > 0) {
      return this.cachedCols;
    }
    const ds = this.merchants.requireDataSource();
    const safeExec = async (sql: string) => {
      try {
        await ds.query(sql);
      } catch {
        // ignore
      }
    };

    await safeExec(`
      CREATE TABLE IF NOT EXISTS public.store_types (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_type_code VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ
      )
    `);
    await safeExec(`DROP TRIGGER IF EXISTS store_types_legacy_cols ON public.store_types CASCADE`);
    await safeExec(`DROP TRIGGER IF EXISTS sync_store_types_legacy_cols ON public.store_types CASCADE`);
    await safeExec(`DROP FUNCTION IF EXISTS public.sync_store_types_legacy_cols() CASCADE`);
    await safeExec(`ALTER TABLE public.store_types ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE`);
    await safeExec(`ALTER TABLE public.store_types ADD COLUMN IF NOT EXISTS created_by UUID`);
    await safeExec(`ALTER TABLE public.store_types ADD COLUMN IF NOT EXISTS updated_by UUID`);
    await ds.query(`
      ALTER TABLE public.store_types ALTER COLUMN updated_at DROP NOT NULL;
      ALTER TABLE public.store_types ALTER COLUMN updated_at DROP DEFAULT;
      ALTER TABLE public.store_types ALTER COLUMN updated_by DROP NOT NULL;
      ALTER TABLE public.store_types ALTER COLUMN updated_by DROP DEFAULT;
    `);

    try {
      const colRes = await ds.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'store_types'"
      );
      const columns = (colRes || []).map((r: any) => String(r.column_name));
      this.cachedCols = columns;
      return columns;
    } catch {
      return ['id', 'store_type_code', 'name', 'description', 'status', 'created_at', 'updated_at'];
    }
  }

  private quote(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  private getProjection(cols: string[]): { projection: string; codeDbCol: string; createdDbCol: string; updatedDbCol: string; hasIsDeleted: boolean; hasCreatedBy: boolean; hasUpdatedBy: boolean } {
    const codeDbCol = cols.find(c => ['store_type_code', 'storetypecode', 'code'].includes(c.toLowerCase())) || 'store_type_code';
    const createdDbCol = cols.find(c => ['created_at', 'createdat'].includes(c.toLowerCase())) || 'created_at';
    const updatedDbCol = cols.find(c => ['updated_at', 'updatedat'].includes(c.toLowerCase())) || 'updated_at';
    const hasIsDeleted = cols.some(c => c.toLowerCase() === 'is_deleted');
    const hasCreatedBy = cols.some(c => c.toLowerCase() === 'created_by');
    const hasUpdatedBy = cols.some(c => c.toLowerCase() === 'updated_by');

    const projection = [
      'id',
      `${this.quote(codeDbCol)} AS "storeTypeCode"`,
      `${this.quote(codeDbCol)} AS "code"`,
      'name',
      'description',
      'status',
      `${this.quote(createdDbCol)}::text AS "createdAt"`,
      `${this.quote(createdDbCol)}::text AS "created_at"`,
      `${this.quote(updatedDbCol)}::text AS "updatedAt"`,
      `${this.quote(updatedDbCol)}::text AS "updated_at"`,
      ...(hasCreatedBy ? ['created_by AS "createdBy"', 'created_by'] : []),
      ...(hasUpdatedBy ? ['updated_by AS "updatedBy"', 'updated_by'] : []),
      ...(hasIsDeleted ? ['is_deleted AS "isDeleted"', 'is_deleted'] : []),
    ].join(', ');

    return { projection, codeDbCol, createdDbCol, updatedDbCol, hasIsDeleted, hasCreatedBy, hasUpdatedBy };
  }

  async list(status?: string): Promise<any[]> {
    const ds = this.merchants.requireDataSource();
    const cols = await this.ensureTable();
    const { projection } = this.getProjection(cols);

    let where = '1=1';
    const params: any[] = [];
    if (status) {
      params.push(status.toUpperCase());
      where += ` AND UPPER(status) = $${params.length}`;
    }

    return ds.query(
      `SELECT ${projection} FROM public.store_types WHERE ${where} ORDER BY name ASC, id ASC`,
      params,
    );
  }

  async previewNextCode(): Promise<string> {
    const ds = this.merchants.requireDataSource();
    try {
      const rows = await ds.query(
        `SELECT COUNT(*)::int + 1 AS next_value FROM public.store_types`,
      );
      const nextValue = Number(rows[0]?.next_value || 1);
      return `STT_${String(nextValue).padStart(5, '0')}`;
    } catch {
      return `STT_00001`;
    }
  }

  async findByIdOrCode(idOrCode: string): Promise<any | null> {
    if (!idOrCode?.trim()) return null;
    const ds = this.merchants.requireDataSource();
    const cols = await this.ensureTable();
    const { projection, codeDbCol } = this.getProjection(cols);

    const val = idOrCode.trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
    // Include soft-deleted rows so an INACTIVE store type can be reactivated.
    const deletedClause = '';

    if (isUuid) {
      const rows = await ds.query(
        `SELECT ${projection} FROM public.store_types WHERE id = $1${deletedClause} LIMIT 1`,
        [val],
      );
      if (rows[0]) return rows[0];
    }

    const rows = await ds.query(
      `SELECT ${projection} FROM public.store_types WHERE (UPPER(${this.quote(codeDbCol)}) = UPPER($1) OR UPPER(name) = UPPER($1))${deletedClause} LIMIT 1`,
      [val],
    );
    return rows[0] || null;
  }

  async findByName(name: string): Promise<any | null> {
    if (!name?.trim()) return null;
    const ds = this.merchants.requireDataSource();
    const cols = await this.ensureTable();
    const { projection, hasIsDeleted } = this.getProjection(cols);

    let where = `LOWER(TRIM(name)) = LOWER(TRIM($1))`;
    if (hasIsDeleted) {
      where += ` AND (is_deleted = false OR is_deleted IS NULL)`;
    }
    const rows = await ds.query(
      `SELECT ${projection} FROM public.store_types WHERE ${where} LIMIT 1`,
      [name.trim()],
    );
    return rows[0] || null;
  }

  async create(
    dto: CreateStoreTypeDto,
    loginUserId?: string | null,
  ): Promise<any> {
    const duplicate = await this.findByName(dto.name);
    if (duplicate) {
      throw new ConflictException(
        `Store type name '${dto.name.trim()}' already exists`,
      );
    }
    const ds = this.merchants.requireDataSource();
    const cols = await this.ensureTable();
    const { projection, codeDbCol, createdDbCol, updatedDbCol, hasIsDeleted, hasCreatedBy, hasUpdatedBy } = this.getProjection(cols);

    const newId = crypto.randomUUID();
    const rawCode = (dto as any).code || (dto as any).storeTypeCode || dto.storeTypeCode;
    const code = (rawCode && String(rawCode).trim())
      ? String(rawCode).trim().toUpperCase()
      : await this.previewNextCode();
    const name = dto.name.trim();
    const description = dto.description?.trim() || '';
    const status = String(dto.status || StoreTypeStatus.ACTIVE).toUpperCase();

    const insertData: Record<string, unknown> = {
      id: newId,
      [codeDbCol]: code,
      name,
      description,
      status,
      [createdDbCol]: new Date(),
      [updatedDbCol]: null,
    };
    if (hasIsDeleted) insertData['is_deleted'] = status === StoreTypeStatus.INACTIVE;
    if (hasCreatedBy && loginUserId) insertData['created_by'] = loginUserId;
    if (hasUpdatedBy) insertData['updated_by'] = null;

    const alternateCodeCol = cols.find(c => c !== codeDbCol && ['store_type_code', 'storetypecode', 'code'].includes(c.toLowerCase()));
    if (alternateCodeCol) {
      insertData[alternateCodeCol] = code;
    }

    const insertKeys = Object.keys(insertData);
    const insertValues = Object.values(insertData);
    const placeholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');

    try {
      const rows = await ds.query(
        `INSERT INTO public.store_types (${insertKeys.map(k => this.quote(k)).join(', ')}) VALUES (${placeholders}) RETURNING ${projection}`,
        insertValues,
      );
      return rows[0];
    } catch (error: any) {
      console.error('[StoreTypeRepository.create Error]:', error);
      const errCode = error.driverError?.code || error.code;
      if (errCode === '23505') {
        throw new ConflictException(`Store type with code '${code}' or name '${name}' already exists`);
      }
      throw new BadRequestException('Store type save failed: ' + (error.driverError?.message || error.message || String(error)));
    }
  }

  async update(
    idOrCode: string,
    dto: UpdateStoreTypeDto,
    loginUserId?: string | null,
  ): Promise<any | null> {
    const existing = await this.findByIdOrCode(idOrCode);
    if (!existing) return null;

    if (dto.name !== undefined && dto.name.trim() !== '') {
      const duplicate = await this.findByName(dto.name);
      if (duplicate && duplicate.id !== existing.id) {
        throw new ConflictException(
          `Store type name '${dto.name.trim()}' already exists`,
        );
      }
    }

    const ds = this.merchants.requireDataSource();
    const cols = await this.ensureTable();
    const { projection, codeDbCol, updatedDbCol, hasIsDeleted, hasUpdatedBy } = this.getProjection(cols);

    const setClauses: string[] = [];
    const setValues: unknown[] = [existing.id];
    let idx = 2;

    if (dto.name !== undefined) {
      setClauses.push(`name = $${idx++}`);
      setValues.push(dto.name.trim());
    }
    if (dto.description !== undefined) {
      setClauses.push(`description = $${idx++}`);
      setValues.push(dto.description.trim());
    }
    if (dto.status !== undefined) {
      const status = String(dto.status).trim().toUpperCase();
      setClauses.push(`status = $${idx++}`);
      setValues.push(status);
      if (hasIsDeleted) {
        setClauses.push(`is_deleted = $${idx++}`);
        setValues.push(status === StoreTypeStatus.INACTIVE);
      }
    }
    if (dto.storeTypeCode !== undefined || dto.code !== undefined) {
      setClauses.push(`${this.quote(codeDbCol)} = $${idx++}`);
      setValues.push(String(dto.storeTypeCode || dto.code).trim().toUpperCase());
    }
    if (hasUpdatedBy && loginUserId) {
      setClauses.push(`updated_by = $${idx++}`);
      setValues.push(loginUserId);
    }
    setClauses.push(`${this.quote(updatedDbCol)} = clock_timestamp()`);

    try {
      const rows = await ds.query(
        `UPDATE public.store_types SET ${setClauses.join(', ')} WHERE id = $1 RETURNING ${projection}`,
        setValues,
      );
      return rows[0] || null;
    } catch (error: any) {
      console.error('[StoreTypeRepository.update Error]:', error);
      const errCode = error.driverError?.code || error.code;
      if (errCode === '23505') {
        throw new ConflictException(`Store type name already exists`);
      }
      throw new BadRequestException('Store type update failed: ' + (error.driverError?.message || error.message || String(error)));
    }
  }

  async deactivate(idOrCode: string, loginUserId?: string | null): Promise<any | null> {
    const existing = await this.findByIdOrCode(idOrCode);
    if (!existing) return null;

    const ds = this.merchants.requireDataSource();
    const cols = await this.ensureTable();
    const { projection, updatedDbCol, hasIsDeleted, hasUpdatedBy } = this.getProjection(cols);
    const updates = [
      `status = 'INACTIVE'`,
      ...(hasIsDeleted ? ['is_deleted = true'] : []),
      `${this.quote(updatedDbCol)} = clock_timestamp()`,
    ];
    const values: unknown[] = [existing.id];
    if (hasUpdatedBy && loginUserId) {
      values.push(loginUserId);
      updates.push(`updated_by = $${values.length}`);
    }
    const rows = await ds.query(
      `UPDATE public.store_types SET ${updates.join(', ')} WHERE id = $1 RETURNING ${projection}`,
      values,
    );
    return rows[0] || null;
  }
}
