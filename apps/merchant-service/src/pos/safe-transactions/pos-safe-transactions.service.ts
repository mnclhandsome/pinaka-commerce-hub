import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';
import {
  CreateSafeDto,
  CreateSafeDropDto,
  SafeTransactionsQueryDto,
} from './pos-safe-transactions.dto';
import { PosSafeTransactionEntity } from './pos-safe-transaction.entity';
import { PosSafeDropTransactionEntity } from './pos-safe-drop-transaction.entity';

type Actor = {
  id?: string;
  accountId?: string;
  merchantId?: string;
  storeId?: string;
} | undefined;

@Injectable()
export class PosSafeTransactionsService implements OnModuleInit {
  constructor(
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
  ) {}

  async onModuleInit() {
    const db = this.merchants.requireDataSource();
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.pos_safe_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), store_id uuid NOT NULL,
        merchant_id uuid NOT NULL, shift_id varchar(100) NOT NULL,
        title varchar(255) NOT NULL, safe_data jsonb NOT NULL, created_by varchar(100) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS public.pos_safe_drop_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), store_id uuid NOT NULL,
        merchant_id uuid NOT NULL, shift_id varchar(100) NOT NULL,
        title varchar(255) NOT NULL, safe_data jsonb NOT NULL, created_by varchar(100) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'pos_safe_transactions'
             AND column_name = 'coins_total'
        ) AND EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'pos_safe_transactions'
             AND column_name = 'total_amount'
        ) THEN
          UPDATE public.pos_safe_transactions
             SET safe_data = jsonb_build_object(
               'shift_id', shift_id,
               'safe_denom', safe_data,
               'coins_total', COALESCE(coins_total, 0),
               'total_amount', COALESCE(total_amount, 0)
             )
           WHERE jsonb_typeof(safe_data) = 'array';
        END IF;
      END $$;
      ALTER TABLE public.pos_safe_transactions
        DROP COLUMN IF EXISTS coins_total,
        DROP COLUMN IF EXISTS total_amount;
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'pos_safe_drop_transactions'
             AND column_name = 'safe_drop_data'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'pos_safe_drop_transactions'
             AND column_name = 'safe_data'
        ) THEN
          ALTER TABLE public.pos_safe_drop_transactions RENAME COLUMN safe_drop_data TO safe_data;
        END IF;
      END $$;
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'pos_safe_drop_transactions'
             AND column_name = 'total_amount'
        ) AND EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'pos_safe_drop_transactions'
             AND column_name = 'total_notes'
        ) THEN
          UPDATE public.pos_safe_drop_transactions
             SET safe_data = jsonb_build_object(
               'shift_id', shift_id,
               'safe_drop_denom', safe_data,
               'total_cash', COALESCE(total_amount, 0),
               'total_notes', COALESCE(total_notes, 0)
             )
           WHERE jsonb_typeof(safe_data) = 'array';
        END IF;
      END $$;
      ALTER TABLE public.pos_safe_drop_transactions
        DROP COLUMN IF EXISTS total_amount,
        DROP COLUMN IF EXISTS total_notes;
      ALTER TABLE public.pos_safe_drop_transactions
        DROP COLUMN IF EXISTS safe_drop_data;
      CREATE INDEX IF NOT EXISTS pos_safe_transactions_store_shift_created_idx
        ON public.pos_safe_transactions (store_id, shift_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS pos_safe_drop_transactions_store_shift_created_idx
        ON public.pos_safe_drop_transactions (store_id, shift_id, created_at DESC);
      DO $$ BEGIN
        IF to_regclass('public.pos_shifts') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          WHERE c.conrelid = 'public.pos_shifts'::regclass
            AND c.contype IN ('p', 'u')
            AND (
              SELECT array_agg(a.attname::text ORDER BY key_column.ordinality)
              FROM unnest(c.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_column.attnum
            ) = ARRAY['id']::text[]
        ) THEN
          CREATE UNIQUE INDEX IF NOT EXISTS pos_shifts_id_uq ON public.pos_shifts (id);
        END IF;
        IF to_regclass('public.pos_shifts') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'pos_safe_transactions_shift_fk'
        ) THEN
          ALTER TABLE public.pos_safe_transactions ADD CONSTRAINT pos_safe_transactions_shift_fk
            FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON DELETE RESTRICT;
        END IF;
        IF to_regclass('public.pos_shifts') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'pos_safe_drop_transactions_shift_fk'
        ) THEN
          ALTER TABLE public.pos_safe_drop_transactions ADD CONSTRAINT pos_safe_drop_transactions_shift_fk
            FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON DELETE RESTRICT;
        END IF;
        IF to_regclass('public.stores') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'pos_safe_transactions_store_fk'
        ) THEN
          ALTER TABLE public.pos_safe_transactions ADD CONSTRAINT pos_safe_transactions_store_fk
            FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;
        END IF;
        IF to_regclass('public.merchants') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'pos_safe_transactions_merchant_fk'
        ) THEN
          ALTER TABLE public.pos_safe_transactions ADD CONSTRAINT pos_safe_transactions_merchant_fk
            FOREIGN KEY (merchant_id) REFERENCES public.merchants(id) ON DELETE RESTRICT;
        END IF;
        IF to_regclass('public.stores') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'pos_safe_drop_transactions_store_fk'
        ) THEN
          ALTER TABLE public.pos_safe_drop_transactions ADD CONSTRAINT pos_safe_drop_transactions_store_fk
            FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;
        END IF;
        IF to_regclass('public.merchants') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'pos_safe_drop_transactions_merchant_fk'
        ) THEN
          ALTER TABLE public.pos_safe_drop_transactions ADD CONSTRAINT pos_safe_drop_transactions_merchant_fk
            FOREIGN KEY (merchant_id) REFERENCES public.merchants(id) ON DELETE RESTRICT;
        END IF;
      END $$;
    `);
  }

  async createSafe(storeId: string, body: CreateSafeDto, actor: Actor) {
    const { store, actorId } = await this.requireScope(storeId, actor);
    const safeData = body.safe_denom
      .filter((item) => Number(item.denom) > 0)
      .map((item) => ({
        denom: Number(item.denom),
        tube_count: Number(item.tube_count),
        cell_count: Number(item.cell_count),
        total: Number(item.total),
      }));
    if (!safeData.length)
      throw new BadRequestException(
        'At least one positive safe denomination is required',
      );
    const id = await this.merchants
      .requireDataSource()
      .transaction(async (manager) => {
        const shift = await this.requireShift(
          manager,
          body.shift_id,
          store.id,
          store.merchantId,
        );
        const first = await this.employeeName(actorId);
        const title = `Safe - ${first} - ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
        const safePayload = {
          shift_id: body.shift_id,
          safe_denom: safeData,
          coins_total: Number(body.coins_total ?? 0),
          total_amount: Number(body.total_amount ?? 0),
        };
        const result = await manager.query(
          `INSERT INTO public.pos_safe_transactions (store_id, merchant_id, shift_id, title, safe_data, created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id, created_at`,
          [
            store.id,
            store.merchantId,
            shift.id,
            title,
            JSON.stringify(safePayload),
            actorId,
          ],
        );
        return result[0];
      });
    return {
      message: 'Safe created successfully',
      post_id: id.id,
      data: safeData,
    };
  }

  async createSafeDrop(storeId: string, body: CreateSafeDropDto, actor: Actor) {
    const { store, actorId } = await this.requireScope(storeId, actor);
    const safeDropData = body.safe_drop_denom
      .filter((item) => Number(item.denom) > 0 && Number(item.denom_count) > 0)
      .map((item) => ({
        denom: Number(item.denom),
        denom_count: Number(item.denom_count),
        total: Number(item.total),
      }));
    if (!safeDropData.length)
      throw new BadRequestException(
        'At least one positive safe drop denomination and count are required',
      );
    const saved = await this.merchants
      .requireDataSource()
      .transaction(async (manager) => {
        const shift = await this.requireShift(
          manager,
          body.shift_id,
          store.id,
          store.merchantId,
        );
        const first = await this.employeeName(actorId);
        const title = `Safe Drop - Shift ${shift.id} - ${first}`;
        const safeData = {
          shift_id: body.shift_id,
          safe_drop_denom: safeDropData,
          total_cash: Number(body.total_cash),
          total_notes: Number(body.total_notes),
        };
        const result = await manager.query(
          `INSERT INTO public.pos_safe_drop_transactions (store_id, merchant_id, shift_id, title, safe_data, created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id, created_at`,
          [
            store.id,
            store.merchantId,
            shift.id,
            title,
            JSON.stringify(safeData),
            actorId,
          ],
        );
        await manager.query(
          `UPDATE public.pos_shifts SET total_safe_drops = COALESCE(total_safe_drops, 0) + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [body.total_cash, shift.id],
        );
        return result[0];
      });
    const creator = await this.employeeName(actorId);
    return {
      message: 'Safe Drop created successfully',
      safe_drop_id: saved.id,
      safe_data: {
        shift_id: body.shift_id,
        safe_drop_denom: safeDropData,
        total_cash: Number(body.total_cash),
        total_notes: Number(body.total_notes),
      },
      shift_id: body.shift_id,
      created_by: creator,
      created_at: saved.created_at,
    };
  }

  getSafes(storeId: string, query: SafeTransactionsQueryDto, actor: Actor) {
    return this.list(
      PosSafeTransactionEntity,
      'safe',
      storeId,
      query,
      actor,
      (row) => ({
        safe_id: row.id,
        title: row.title,
        created_at: row.created_at,
        safe_data: row.safe_data,
        shift_id: row.shift_id,
        created_by: row.created_by,
      }),
    );
  }

  getSafeDrops(storeId: string, query: SafeTransactionsQueryDto, actor: Actor) {
    return this.list(
      PosSafeDropTransactionEntity,
      'drop',
      storeId,
      query,
      actor,
      (row) => ({
        safe_drop_id: row.id,
        title: row.title,
        created_at: row.created_at,
        safe_data: row.safe_data,
        shift_id: row.shift_id,
        created_by: row.created_by,
      }),
    );
  }

  private async list<
    T extends PosSafeTransactionEntity | PosSafeDropTransactionEntity,
  >(
    entity: new () => T,
    kind: 'safe' | 'drop',
    storeId: string,
    query: SafeTransactionsQueryDto,
    actor: Actor,
    present: (row: T) => Record<string, unknown>,
  ) {
    const { store } = await this.requireScope(storeId, actor);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const repository = this.merchants.requireDataSource().getRepository(entity);
    const qb = repository
      .createQueryBuilder(kind)
      .where(`${kind}.store_id = :store_id`, { store_id: store.id })
      .andWhere(`${kind}.merchant_id = :merchant_id`, {
        merchant_id: store.merchantId,
      });
    if (query.shift_id)
      qb.andWhere(`${kind}.shift_id = :shift_id`, { shift_id: query.shift_id });
    if (query.username) {
      const employees = await this.merchants
        .requireDataSource()
        .query(
          `SELECT id::text AS id, user_id::text AS user_id FROM public.employees WHERE lower(username) = lower($1) AND merchant_id::text = $2 LIMIT 1`,
          [query.username, store.merchantId],
        );
      if (!employees.length) return { count: 0, page, limit, data: [] };
      const ids = [employees[0].id, employees[0].user_id].filter(Boolean);
      qb.andWhere(`${kind}.created_by IN (:...creatorIds)`, {
        creatorIds: ids,
      });
    }
    const [rows, count] = await qb
      .orderBy(`${kind}.created_at`, 'DESC')
      .addOrderBy(`${kind}.id`, 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { count, page, limit, data: rows.map(present) };
  }

  private async requireScope(storeId: string, actor: Actor) {
    if (!actor?.id)
      throw new ForbiddenException('Authenticated user is required');
    const store = await this.merchants.getStoreById(storeId);
    if (!store) throw new NotFoundException('Store not found');
    // accountId is an accounts.id UUID, not merchants.id. For POS tokens,
    // also validate the signed merchant/store scope and employee session
    // mapping loaded by SessionAuthGuard.
    const merchant = await this.merchants.requireDataSource().query(
      `SELECT 1
         FROM public.merchants m
        WHERE m.id::text = $1
          AND (
            EXISTS (
              SELECT 1
                FROM public.users u
               WHERE u.id::text = $3
                 AND u."accountId"::text = $2
                 AND (
                   lower(u.email) = lower(m.email)
                   OR COALESCE(to_jsonb(u)->>'merchantId', to_jsonb(u)->>'merchant_id') = ANY(ARRAY[
                     m.id::text,
                     NULLIF(to_jsonb(m)->>'merchantId', ''),
                     NULLIF(to_jsonb(m)->>'merchantCode', ''),
                     NULLIF(to_jsonb(m)->>'merchant_id', ''),
                     NULLIF(to_jsonb(m)->>'merchant_code', '')
                   ])
                 )
            )
            OR NULLIF(to_jsonb(m)->>'created_by', '') = $3
            OR EXISTS (
              SELECT 1
                FROM public.employees e
               WHERE e.merchant_id::text = m.id::text
                 AND (e.id::text = $3 OR e.user_id::text = $3)
            )
          )
          AND (
            $4::text IS NULL
            OR EXISTS (
              SELECT 1 FROM public.stores s
               WHERE s.id::text = $5
                 AND s.merchant_id::text = m.id::text
                 AND $4::text IN (s.id::text, COALESCE(to_jsonb(s)->>'store_code', to_jsonb(s)->>'storeCode'))
            )
          )
          AND (
            $6::text IS NULL
            OR $6::text = ANY(ARRAY[
              m.id::text,
              NULLIF(to_jsonb(m)->>'merchantId', ''),
              NULLIF(to_jsonb(m)->>'merchantCode', ''),
              NULLIF(to_jsonb(m)->>'merchant_id', ''),
              NULLIF(to_jsonb(m)->>'merchant_code', '')
            ])
          )
        LIMIT 1`,
      [store.merchantId, actor.accountId ?? null, actor.id, actor.storeId ?? null, store.id, actor.merchantId ?? null],
    );
    if (!merchant.length)
      throw new ForbiddenException(
        'Store does not belong to the authenticated merchant',
      );
    return { store, actorId: actor.id };
  }

  private async requireShift(
    manager: { query: (sql: string, values?: unknown[]) => Promise<any[]> },
    shiftId: string,
    storeId: string,
    merchantId: string,
  ) {
    const rows = await manager.query(
      `SELECT id, store_id, merchant_id FROM public.pos_shifts WHERE id = $1 FOR UPDATE`,
      [shiftId],
    );
    const shift = rows[0];
    if (!shift) throw new NotFoundException('POS shift not found');
    if (shift.store_id !== storeId || shift.merchant_id !== merchantId)
      throw new ForbiddenException(
        'POS shift does not belong to this store and merchant',
      );
    return shift as { id: string };
  }

  private async employeeName(actorId: string) {
    const rows = await this.merchants
      .requireDataSource()
      .query(
        `SELECT concat_ws(' ', first_name, last_name) AS name FROM public.employees WHERE id::text = $1 OR user_id::text = $1 LIMIT 1`,
        [actorId],
      );
    return String(rows[0]?.name || actorId);
  }
}
