import { DataSource, EntityManager } from 'typeorm';
import { createMissingTables } from '@pinaka-delivery-hub/database';
import { StoreDiscountEntity } from '../../entities/store-discount.entity';
import { BadRequestException, ForbiddenException, Inject, Injectable, InternalServerErrorException, NotFoundException, OnModuleInit } from '@nestjs/common';
import { createDecipheriv, createHash } from 'node:crypto';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';
import { WordPressResponseException } from './wordpress-response.exception';

@Injectable()
export class DiscountService implements OnModuleInit {
  private polling = false;
  constructor(@Inject(MerchantRepository) private readonly merchants: MerchantRepository) {}

  async onModuleInit(): Promise<void> {
    const source = new DataSource({
      ...this.merchants.requireDataSource().options,
      entities: [StoreDiscountEntity],
      synchronize: false,
      migrationsRun: false,
    });
    await source.initialize();
    try {
      await createMissingTables(source);
      // Older databases may have the table without the unique index declared by the entity.
      // Discount writes use ON CONFLICT (store_id), which requires this index.
      await source.query(`CREATE UNIQUE INDEX IF NOT EXISTS store_discounts_store_id_uq
        ON public.store_discounts (store_id)`);
      await source.query(`
        CREATE TABLE IF NOT EXISTS public.discounts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          store_id uuid NOT NULL,
          discount_type varchar(30) NOT NULL CHECK (discount_type IN ('auto', 'mix_match', 'multipack')),
          discount_id varchar(100) NOT NULL,
          payload jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          is_deleted boolean NOT NULL DEFAULT false,
          CONSTRAINT discounts_store_type_external_id_uq UNIQUE (store_id, discount_type, discount_id)
        )
      `);
      await source.query(`CREATE UNIQUE INDEX IF NOT EXISTS discounts_store_type_external_id_uq
        ON public.discounts (store_id, discount_type, discount_id)`);
      // Backfill records already cached in store_discounts so both tables start aligned.
      await source.query(`
        INSERT INTO public.discounts (store_id, discount_type, discount_id, payload)
        SELECT DISTINCT ON (sd.store_id, group_row.key, COALESCE(item.value->>'wordpressId', item.value->>'id', item.value->>'pchId'))
          sd.store_id, group_row.key, COALESCE(item.value->>'wordpressId', item.value->>'id', item.value->>'pchId'), item.value
        FROM public.store_discounts sd
        CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(sd.payload)='object' THEN sd.payload ELSE '{}'::jsonb END) group_row(key, value)
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(group_row.value)='array' THEN group_row.value ELSE '[]'::jsonb END) item(value)
        WHERE COALESCE(sd.is_deleted, false)=false
          AND group_row.key IN ('auto', 'mix_match', 'multipack')
          AND COALESCE(item.value->>'wordpressId', item.value->>'id', item.value->>'pchId') IS NOT NULL
        ORDER BY sd.store_id, group_row.key, COALESCE(item.value->>'wordpressId', item.value->>'id', item.value->>'pchId')
        ON CONFLICT (store_id, discount_type, discount_id) DO UPDATE
          SET payload=EXCLUDED.payload, updated_at=now(), is_deleted=false
      `);
    } finally {
      await source.destroy();
    }
    setTimeout(() => void this.pollConnectedStores(), 30_000);
    setInterval(() => void this.pollConnectedStores(), 5 * 60_000);
  }

  private async pollConnectedStores() {
    if (this.polling) return;
    this.polling = true;
    try {
      const rows = await this.merchants.requireDataSource().query(
        `SELECT "storeId", "wordpressUrl", "encryptedJwt" FROM public.website_connections WHERE status='CONNECTED'`,
      );
      for (const row of rows) {
        try {
          if (!row.wordpressUrl || !row.encryptedJwt) continue;
          await this.syncStoreDiscountsFromWordPress({
            storeId: row.storeId,
            wordpressUrl: row.wordpressUrl,
            wordpressJwt: this.decryptConnectorSecret(row.encryptedJwt),
          });
        } catch (error: any) {
          // The next scheduled poll retries transient failures; never log connection secrets.
          console.warn(`[Discount sync] Store ${row.storeId} pull failed: ${error?.message ?? 'unknown error'}`);
        }
      }
    } catch (error: any) {
      console.warn(`[Discount sync] Polling failed: ${error?.message ?? 'unknown error'}`);
    } finally {
      this.polling = false;
    }
  }

  async sync(storeId: string, role?: string) {
    const connection = await this.requireWordPressConnection(storeId, role);
    const result = await this.syncStoreDiscountsFromWordPress(connection);
    return { success: true, storeId: connection.storeId, ...result };
  }

  async list(storeId: string, role?: string, query: Record<string, string> = {}) {
    const connection = await this.requireWordPressConnection(storeId, role);
    const response = await this.wordpressRequest(connection, 'custom-discount/get-all-discounts-for-admin', 'GET', undefined, query);
    for (const group of ['auto', 'mix_match', 'multipack']) {
      const records = response?.data?.[group];
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (record?.id === undefined || record?.id === null) continue;
        await this.persistWithoutChangingResponse(
          () => this.saveDiscount(storeId, group, this.canonicalizeWordPressRecord(record), String(record.id)),
          storeId,
        );
      }
    }
    return response;
  }

  async listByType(storeId: string, type: string, role?: string, query: Record<string, string> = {}) {
    const group = this.discountGroup(type);
    const response = await this.list(storeId, role, query);
    return {
      data: Array.isArray(response?.data?.[group]) ? response.data[group] : [],
      ...(response?.pagination ? { pagination: response.pagination } : {}),
    };
  }

  async getById(storeId: string, type: string, id: string, role?: string) {
    this.requireDiscountRole(role);
    const group = this.discountGroup(type);
    const [row] = await this.merchants.requireDataSource().query(
      `SELECT payload FROM public.discounts
       WHERE store_id=$1::uuid AND discount_type=$2 AND discount_id=$3 AND COALESCE(is_deleted,false)=false`,
      [storeId, group, id],
    );
    if (!row) throw new NotFoundException(`Discount '${id}' not found for type '${group}'`);
    return row.payload;
  }

  async listRules(storeId: string, role?: string) {
    const connection = await this.requireWordPressConnection(storeId, role);
    return this.wordpressRequest(connection, 'assets/discount-rules', 'GET');
  }

  async applyToOrder(storeId: string, orderId: string, body: Record<string, unknown>, role?: string) {
    const connection = await this.requireWordPressConnection(storeId, role);
    return this.wordpressRequest(connection, `custom-discount/apply/${encodeURIComponent(orderId)}`, 'POST', body);
  }

  async removeFromOrder(storeId: string, orderId: string, body: Record<string, unknown>, role?: string) {
    const connection = await this.requireWordPressConnection(storeId, role);
    return this.wordpressRequest(connection, `custom-discount/remove/${encodeURIComponent(orderId)}`, 'POST', body);
  }

  async productsByIds(storeId: string, body: Record<string, unknown>, role?: string) {
    const connection = await this.requireWordPressConnection(storeId, role);
    return this.wordpressRequest(connection, 'custom-discount/by-ids', 'POST', body);
  }

  async create(storeId: string, input: Record<string, any>, role?: string) {
    const connection = await this.requireWordPressConnection(storeId, role);
    const group = this.discountGroup(input.type);
    const body = this.toWordPressPayload(input);
    let previousMultipackIds: Set<string> | undefined;
    if (group === 'multipack') {
      try {
        const before = await this.wordpressRequest(connection, 'custom-discount/get-all-discounts-for-admin', 'GET', undefined, { page: '1', per_page: '100' });
        previousMultipackIds = new Set((before?.data?.multipack ?? []).map((item: any) => String(item.id)));
      } catch (error: any) {
        console.warn(`[Discount sync] Could not snapshot Multipack IDs for store ${connection.storeId}: ${error?.message ?? 'unknown error'}`);
      }
    }
    const response = await this.wordpressRequest(connection, 'custom-discount/create-discount', 'POST', body);
    let wordpressId = response.discount_id ?? response.id;
    // The original Multipack create response intentionally has no ID. Resolve it internally from the
    // existing list API so PCH can keep the mapping without changing WordPress's public response.
    if (wordpressId === undefined && group === 'multipack' && previousMultipackIds) {
      try {
        const after = await this.wordpressRequest(connection, 'custom-discount/get-all-discounts-for-admin', 'GET', undefined, { page: '1', per_page: '100' });
        wordpressId = (after?.data?.multipack ?? []).find((item: any) => !previousMultipackIds!.has(String(item.id)))?.id;
      } catch (error: any) {
        console.warn(`[Discount sync] Could not resolve new Multipack ID for store ${connection.storeId}: ${error?.message ?? 'unknown error'}`);
      }
    }
    if (wordpressId !== undefined && wordpressId !== null) {
      const sourceRecord = await this.fetchWordPressDiscount(connection, group, wordpressId);
      const record = sourceRecord
        ? this.canonicalizeWordPressRecord(sourceRecord)
        : this.canonicalizeRequestRecord(input);
      Object.assign(record, { id: wordpressId, pchId: String(wordpressId), syncStatus: 'SYNCED' });
      await this.persistWithoutChangingResponse(() => this.saveDiscount(connection.storeId, group, record), connection.storeId);
    }
    return response;
  }

  async update(storeId: string, type: string, id: string, input: Record<string, any>, role?: string) {
    const connection = await this.requireWordPressConnection(storeId, role);
    const group = this.discountGroup(type);
    const previous = await this.findStoredDiscount(connection.storeId, group, id);
    const wordpressId = previous.wordpressId ?? previous.id;
    const body = { ...this.toWordPressPayload({ ...previous, ...input, type }), discount_id: Number(wordpressId) };
    const response = await this.wordpressRequest(connection, 'custom-discount/update-discount', 'POST', body);
    const sourceRecord = await this.fetchWordPressDiscount(connection, group, wordpressId);
    const record = sourceRecord
      ? this.canonicalizeWordPressRecord(sourceRecord)
      : this.canonicalizeRequestRecord({ ...previous, ...input });
    Object.assign(record, { id: wordpressId, pchId: id, syncStatus: 'SYNCED' });
    await this.persistWithoutChangingResponse(() => this.saveDiscount(connection.storeId, group, record, id), connection.storeId);
    return response;
  }

  async remove(storeId: string, type: string, id: string, role?: string) {
    const connection = await this.requireWordPressConnection(storeId, role);
    const group = this.discountGroup(type);
    const previous = await this.findStoredDiscount(connection.storeId, group, id);
    const response = await this.wordpressRequest(connection, 'custom-discount/delete-discount', 'POST', {
      id: Number(previous.wordpressId ?? previous.id), type: group,
    });
    if (response.success === true) {
      await this.persistWithoutChangingResponse(() => this.removeDiscount(connection.storeId, group, id), connection.storeId);
    }
    return response;
  }

  private discountGroup(type: string): 'auto' | 'mix_match' | 'multipack' {
    const groups: Record<string, 'auto' | 'mix_match' | 'multipack'> = {
      auto: 'auto', mix_match: 'mix_match', multipack: 'multipack',
    };
    const group = groups[type];
    if (!group) throw new BadRequestException('type must be auto, mix_match, or multipack');
    return group;
  }

  private toWordPressPayload(input: Record<string, any>) {
    const allowed = ['code', 'discount_type', 'amount', 'minimum_amount', 'maximum_amount', 'date_starts',
      'date_expires', 'min_qty', 'max_qty', 'product_ids', 'usage_limit', 'product_id',
      'pinaka_discount_auto_apply', 'discount_product_ids', 'qty'];
    const output: Record<string, any> = { type: this.discountGroup(input.type) };
    for (const key of allowed) if (input[key] !== undefined) output[key] = input[key];
    const dateStarts = input.date_starts ?? input.date_start ?? input.start_date ?? input.startDate;
    const dateExpires = input.date_expires ?? input.date_expire ?? input.expiry_date ?? input.expiryDate;
    if (dateStarts !== undefined) output.date_starts = dateStarts;
    if (dateExpires !== undefined) output.date_expires = dateExpires;
    return output;
  }

  private canonicalizeWordPressRecord(record: Record<string, any>) {
    const canonical = { ...record };
    if (canonical.start_date === undefined) {
      canonical.start_date = canonical.date_starts ?? canonical.date_start ?? canonical.startDate;
    }
    if (canonical.expiry_date === undefined) {
      canonical.expiry_date = canonical.date_expires ?? canonical.date_expire ?? canonical.expiryDate;
    }
    for (const alias of ['date_starts', 'date_start', 'startDate', 'date_expires', 'date_expire', 'expiryDate']) {
      delete canonical[alias];
    }
    return canonical;
  }

  private canonicalizeRequestRecord(record: Record<string, any>) {
    const canonical = { ...record };
    const dateStarts = canonical.date_starts ?? canonical.date_start ?? canonical.start_date ?? canonical.startDate;
    const dateExpires = canonical.date_expires ?? canonical.date_expire ?? canonical.expiry_date ?? canonical.expiryDate;
    if (dateStarts !== undefined) canonical.start_date = dateStarts;
    if (dateExpires !== undefined) canonical.expiry_date = dateExpires;
    for (const alias of ['date_starts', 'date_start', 'startDate', 'date_expires', 'date_expire', 'expiryDate']) {
      delete canonical[alias];
    }
    return canonical;
  }

  private async fetchWordPressDiscount(
    connection: { wordpressUrl: string; wordpressJwt: string },
    group: string,
    id: string | number,
  ): Promise<Record<string, any> | undefined> {
    try {
      for (let page = 1; page <= 100; page++) {
        const response = await this.wordpressRequest(
          connection,
          'custom-discount/get-all-discounts-for-admin',
          'GET',
          undefined,
          { page: String(page), per_page: '100' },
        );
        const records = response?.data?.[group];
        if (Array.isArray(records)) {
          const record = records.find((item: any) => String(item?.id) === String(id));
          if (record) return record;
        }
        const hasMore = response?.pagination?.has_more === true;
        if (!hasMore && (!Array.isArray(records) || records.length < 100)) break;
      }
    } catch {
      // A successful write should still be mirrored locally using the request values
      // if WooCommerce's read-after-write list request is temporarily unavailable.
    }
    return undefined;
  }

  private async wordpressRequest(connection: { wordpressUrl: string; wordpressJwt: string }, path: string, method: string, body?: any, query: Record<string, string> = {}) {
    const url = new URL(`${connection.wordpressUrl.replace(/\/+$/, '')}/wp-json/pinaka-pos/v1/${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method, headers: { Accept: 'application/json', Authorization: `Bearer ${connection.wordpressJwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
    });
    const result: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new WordPressResponseException(result, response.status);
    return result;
  }

  private async findStoredDiscount(storeId: string, group: string, id: string) {
    const payload = await this.readDiscountPayload(storeId);
    const discount = (payload[group] ?? []).find((item: any) => String(item.pchId ?? item.id) === id);
    return discount ?? { id: Number(id), wordpressId: Number(id) };
  }

  private async persistWithoutChangingResponse(operation: () => Promise<void>, storeId: string) {
    try {
      await operation();
    } catch (error: any) {
      // The WooCommerce operation already succeeded. Keep its public response intact;
      // the scheduled pull can rebuild the mapping. Do not include connection credentials in logs.
      console.error(`[Discount sync] Local mapping write failed for store ${storeId}: ${error?.message ?? 'unknown error'}`);
    }
  }

  private async readDiscountPayload(storeId: string) {
    const [row] = await this.merchants.requireDataSource().query(
      'SELECT payload FROM public.store_discounts WHERE store_id=$1::uuid AND COALESCE(is_deleted,false)=false', [storeId]);
    return row?.payload ?? { auto: [], mix_match: [], multipack: [] };
  }

  private async saveDiscount(storeId: string, group: string, record: any, replaceId?: string) {
    await this.merchants.requireDataSource().transaction(async manager => {
      const [row] = await manager.query('SELECT payload FROM public.store_discounts WHERE store_id=$1::uuid AND COALESCE(is_deleted,false)=false FOR UPDATE', [storeId]);
      const payload = row?.payload ?? { auto: [], mix_match: [], multipack: [] };
      const records = Array.isArray(payload[group]) ? payload[group] : [];
      const index = replaceId ? records.findIndex((item: any) => String(item.pchId ?? item.id) === replaceId) : -1;
      if (index >= 0) records[index] = record; else records.push(record);
      payload[group] = records;
      await this.writeDiscountSnapshot(manager, storeId, payload);
    });
  }

  private async removeDiscount(storeId: string, group: string, id: string) {
    await this.merchants.requireDataSource().transaction(async manager => {
      const [row] = await manager.query('SELECT payload FROM public.store_discounts WHERE store_id=$1::uuid AND COALESCE(is_deleted,false)=false FOR UPDATE', [storeId]);
      const payload = row?.payload ?? { auto: [], mix_match: [], multipack: [] };
      payload[group] = (payload[group] ?? []).filter((item: any) => String(item.pchId ?? item.id) !== id);
      await this.writeDiscountSnapshot(manager, storeId, payload);
    });
  }

  private async writeDiscountSnapshot(manager: EntityManager, storeId: string, payload: Record<string, any[]>) {
    const canonicalPayload: Record<string, any[]> = {};
    for (const group of ['auto', 'mix_match', 'multipack']) {
      canonicalPayload[group] = (Array.isArray(payload[group]) ? payload[group] : [])
        .map(record => this.canonicalizeWordPressRecord(record));
    }
    await manager.query(`INSERT INTO public.store_discounts (store_id,payload) VALUES ($1::uuid,$2::jsonb)
      ON CONFLICT (store_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now(),is_deleted=false`, [storeId, JSON.stringify(canonicalPayload)]);
    await manager.query('DELETE FROM public.discounts WHERE store_id=$1::uuid', [storeId]);
    for (const group of ['auto', 'mix_match', 'multipack']) {
      for (const record of canonicalPayload[group]) {
        const discountId = record.wordpressId ?? record.id ?? record.pchId;
        if (discountId === undefined || discountId === null) continue;
        await manager.query(`INSERT INTO public.discounts (store_id,discount_type,discount_id,payload)
          VALUES ($1::uuid,$2,$3,$4::jsonb)
          ON CONFLICT (store_id,discount_type,discount_id) DO UPDATE
          SET payload=EXCLUDED.payload,updated_at=now(),is_deleted=false`,
        [storeId, group, String(discountId), JSON.stringify(record)]);
      }
    }
  }

  async syncStoreDiscountsFromWordPress(params: {
    storeId: string;
    wordpressUrl: string;
    wordpressJwt: string;
  }): Promise<{ discountCount: number; skippedCount: number }> {
    const [table] = await this.merchants.requireDataSource().query("SELECT to_regclass('public.store_products') AS name");
    if (!table?.name) throw new BadRequestException('Sync products for this store before syncing discounts');
    const [saved] = await this.merchants.requireDataSource().query(
      'SELECT payload FROM public.store_products WHERE store_id=$1::uuid AND COALESCE(is_deleted,false)=false',
      [params.storeId],
    );
    if (!saved || !Array.isArray(saved.payload)) {
      throw new BadRequestException('Sync products for this store before syncing discounts');
    }
    const productIds = new Set(saved.payload.map((product: any) => String(product.id)));
    const payload: Record<string, Record<string, unknown>[]> = { auto: [], mix_match: [], multipack: [] };
    const seen = new Set<string>();
    let skippedCount = 0;
    let completed = false;
    for (let page = 1; page <= 1000; page++) {
      const url = new URL(params.wordpressUrl.replace(/\/+$/, '') + '/wp-json/pinaka-pos/v1/custom-discount/get-all-discounts-for-admin');
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', '100');
      const response = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + params.wordpressJwt },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new BadRequestException('WordPress discounts API returned HTTP ' + response.status);
      const body: any = await response.json();
      if (!body || !body.data || typeof body.data !== 'object') throw new BadRequestException('Invalid WordPress discounts response');
      for (const group of Object.keys(payload)) {
        const discounts = body.data[group] ?? [];
        if (!Array.isArray(discounts)) throw new BadRequestException('Invalid WordPress discount group: ' + group);
        for (const discount of discounts) {
          if (!discount || typeof discount !== 'object' || discount.id === undefined) throw new BadRequestException('Invalid WordPress discount record');
          const key = group + ':' + discount.id;
          if (seen.has(key)) continue;
          seen.add(key);
          const children = discount.discount_product_ids ?? [];
          if (!Array.isArray(children)) throw new BadRequestException('Invalid discount product references');
          const references = [discount.product_id, ...children];
          if (!references.every(id => id !== undefined && id !== null && productIds.has(String(id)))) {
            skippedCount++;
            continue;
          }
          payload[group].push(discount);
        }
      }
      // The plugin reports totals only for mix_match; keep paging auto independently.
      const auto = body.data.auto ?? [];
      const mixMatch = body.data.mix_match ?? [];
      if (auto.length === 0 && mixMatch.length === 0 && !body.pagination?.has_more) {
        completed = true;
        break;
      }
    }
    if (!completed) throw new BadRequestException('Discount pagination limit reached; saved discounts were not replaced');
    await this.merchants.requireDataSource().transaction(manager =>
      this.writeDiscountSnapshot(manager, params.storeId, payload));
    return { discountCount: Object.values(payload).reduce((sum, items) => sum + items.length, 0), skippedCount };
  }

  private connectorEncryptionKey(): Buffer {
    const keyValue = process.env.STORE_CONFIG_ENCRYPTION_KEY;
    const key = keyValue
      ? Buffer.from(keyValue, 'base64')
      : createHash('sha256').update(process.env.AUTH_JWT_SECRET || 'pdh-local-development-secret-change-me').digest();
    if (key.length !== 32) {
      throw new InternalServerErrorException('STORE_CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
    return key;
  }

  private decryptConnectorSecret(value: string): string {
    const [version, ivPart, ciphertextPart, tagPart] = value.split(':');
    if (version !== 'v1' || !ivPart || !ciphertextPart || !tagPart) {
      throw new BadRequestException(
        'The saved WordPress JWT is no longer valid. Edit the website connection and save the JWT token again.',
      );
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.connectorEncryptionKey(),
        Buffer.from(ivPart, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new BadRequestException(
        'The saved WordPress JWT was encrypted with a different server key. Edit the website connection and save the JWT token again.',
      );
    }
  }

  private async requireWordPressConnection(storeId: string, role?: string) {
    this.requireDiscountRole(role);
    const store = await this.merchants.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    const connector = await this.merchants.getWebsiteConnection(store.id)
      || await this.merchants.getWebsiteConnection(storeId);
    if (!connector?.encryptedJwt || !connector.wordpressUrl) {
      throw new BadRequestException('Connect the WordPress site before syncing the catalog');
    }
    if (connector.status !== 'CONNECTED') {
      throw new BadRequestException('Validate the WordPress connection before syncing.');
    }
    return {
      merchantId: store.merchantId,
      storeId: store.id,
      wordpressUrl: connector.wordpressUrl,
      wordpressJwt: this.decryptConnectorSecret(connector.encryptedJwt),
    };
  }

  private requireDiscountRole(role?: string) {
    const normalizedRole = String(role ?? '').trim().toUpperCase();
    if (process.env.SKIP_AUTH !== 'true' && !['OWNER', 'ADMIN', 'ADMINISTRATOR', 'MERCHANT_ADMIN'].includes(normalizedRole)) {
      throw new ForbiddenException('Only owners or store administrators can manage website connections');
    }
  }

}
