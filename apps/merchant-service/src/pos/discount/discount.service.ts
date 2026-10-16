import { DataSource, EntityManager } from 'typeorm';
import { createMissingTables } from '@pinaka-delivery-hub/database';
import { StoreDiscountEntity } from '../../entities/store-discount.entity';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, InternalServerErrorException, NotFoundException, OnModuleInit } from '@nestjs/common';
import { createDecipheriv, createHash } from 'node:crypto';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';
import { mapDiscountRules } from './discount-rule.model';
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
      // Existing installations may predate the entity's unique declaration. Snapshot upserts
      // require one row per store, which is the established store_discounts data model.
      await source.query(`CREATE UNIQUE INDEX IF NOT EXISTS store_discounts_store_id_uq
        ON public.store_discounts (store_id)`);
      // Keep the queryable per-discount mirror used by discount management screens.
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
      // Populate the mirror from existing snapshots without removing or truncating data.
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
    const { type, ...wordpressQuery } = query;
    const response = await this.wordpressRequest(connection, 'custom-discount/get-all-discounts-for-admin', 'GET', undefined, {
      page: '1',
      per_page: '100',
      ...wordpressQuery,
    });
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
    if (!type) return response;
    const group = this.discountGroup(type);
    return {
      data: Array.isArray(response?.data?.[group]) ? response.data[group] : [],
      ...(response?.pagination ? { pagination: response.pagination } : {}),
    };
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
    const payload = await this.readDiscountPayload(storeId);
    const record = (payload[group] ?? []).find((item: any) => this.discountMatchesId(item, id));
    if (!record) throw new NotFoundException(`Discount '${id}' not found for type '${group}'`);
    return record;
  }

  async listRules(storeId: string, role?: string, productId?: string, sessionStoreId?: string) {
    this.assertDiscountRulesReader(role, storeId, sessionStoreId);
    const store = await this.merchants.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    const payload = await this.readDiscountPayload(store.id);
    return mapDiscountRules(payload, productId);
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
    this.validateCreateInput(group, input);
    await this.assertDiscountIsUnique(connection, group, input);
    if (group === 'multipack') await this.assertMultipackRuleIsUnique(connection, input);
    const body = this.toWordPressPayload({ ...input, type: group });
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
    // The original Multipack create response has no ID. Resolve it from the existing list API
    // and add the ID to PCH's response as well as retaining the local mapping.
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
      const record = this.canonicalizeRequestRecord({
        ...(sourceRecord ? this.canonicalizeWordPressRecord(sourceRecord) : {}),
        ...input,
        ...body,
      });
      Object.assign(record, { id: wordpressId, pchId: String(wordpressId), syncStatus: 'SYNCED' });
      await this.saveDiscount(connection.storeId, group, record);
    }
    return group === 'multipack' && wordpressId !== undefined && wordpressId !== null
      ? { ...response, id: wordpressId }
      : response;
  }

  async update(storeId: string, type: string, id: string, input: Record<string, any>, role?: string) {
    const connection = await this.requireWordPressConnection(storeId, role);
    const group = this.discountGroup(type);
    const previous = await this.findStoredDiscount(connection.storeId, group, id);
    const wordpressId = previous.wordpressId ?? previous.id;
    const merged = { ...previous, ...input, type: group };
    if (input.product_id !== undefined && input.main_product_id === undefined) merged.main_product_id = input.product_id;
    if (input.main_product_id !== undefined && input.product_id === undefined) merged.product_id = input.main_product_id;
    if (input.product_ids !== undefined && input.discount_product_ids === undefined) merged.discount_product_ids = input.product_ids;
    if (input.discount_product_ids !== undefined && input.product_ids === undefined) merged.product_ids = input.discount_product_ids;
    if (input.required_product_ids !== undefined && input.required_products === undefined) merged.required_products = input.required_product_ids;
    if (input.required_products !== undefined && input.required_product_ids === undefined) merged.required_product_ids = input.required_products;
    if (input.required_product_id !== undefined && input.required_product_ids === undefined && input.required_products === undefined) {
      merged.required_product_ids = [input.required_product_id];
      merged.required_products = [input.required_product_id];
    }
    if (group === 'mix_match') {
      const requiredIds = this.requiredProductIds(merged);
      if (requiredIds !== undefined) {
        if (requiredIds.length !== 1) throw new BadRequestException('Mix-and-match discounts require exactly one required product');
        merged.product_id = requiredIds[0];
        merged.main_product_id = requiredIds[0];
      }
    }
    if (input.quantity !== undefined && input.qty === undefined) merged.qty = input.quantity;
    if (input.required_quantity !== undefined && input.qty === undefined && input.quantity === undefined) merged.qty = input.required_quantity;
    this.validateCreateInput(group, merged);
    await this.assertDiscountIsUnique(connection, group, merged, String(wordpressId));
    if (group === 'multipack') await this.assertMultipackRuleIsUnique(connection, merged, String(wordpressId));
    const body = { ...this.toWordPressPayload(merged), discount_id: Number(wordpressId) };
    const response = await this.wordpressRequest(connection, 'custom-discount/update-discount', 'POST', body);
    const sourceRecord = await this.fetchWordPressDiscount(connection, group, wordpressId);
    const baseRecord = sourceRecord
      ? this.canonicalizeWordPressRecord(sourceRecord)
      : previous;
    const record = this.canonicalizeRequestRecord({ ...baseRecord, ...merged, ...this.toWordPressPayload(merged) });
    Object.assign(record, {
      id: wordpressId,
      wordpressId: String(wordpressId),
      pchId: String(previous.pchId ?? id),
      syncStatus: 'SYNCED',
    });
    // saveDiscount writes store_discounts and discounts in one transaction.
    // Surface a local write failure instead of reporting a complete update.
    await this.saveDiscount(connection.storeId, group, record, id);
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

  private validateCreateInput(group: 'auto' | 'mix_match' | 'multipack', input: Record<string, any>) {
    if (group !== 'multipack' && !this.discountName(input)?.trim()) {
      throw new BadRequestException('code is required');
    }
    if (group === 'mix_match') {
      const requiredIds = this.requiredProductIds(input);
      if (requiredIds !== undefined && requiredIds.length !== 1) {
        throw new BadRequestException('Mix-and-match discounts require exactly one required product');
      }
      if (requiredIds?.length === 1 && input.product_id === undefined && input.main_product_id === undefined) {
        input.product_id = requiredIds[0];
      }
    }
    if (group === 'multipack') {
      const productId = input.product_id ?? input.main_product_id;
      const quantity = input.qty ?? input.quantity ?? input.required_quantity;
      if (!this.isPositiveInteger(productId)) throw new BadRequestException('product_id must be a positive integer for multipack discounts');
      if (!this.isPositiveInteger(quantity)) throw new BadRequestException('qty must be a positive integer for multipack discounts');
    }
  }

  private isPositiveInteger(value: unknown) {
    const number = Number(value);
    return value !== undefined && value !== null && String(value).trim() !== '' && Number.isInteger(number) && number > 0;
  }

  private toWordPressPayload(input: Record<string, any>) {
    const type = this.discountGroup(input.type);
    const commonFields = ['discount_type', 'amount', 'date_starts', 'date_expires'];
    const typeFields: Record<typeof type, string[]> = {
      auto: ['code', 'minimum_amount', 'maximum_amount', 'min_qty', 'max_qty', 'product_ids', 'usage_limit',
        'product_id', 'pinaka_discount_auto_apply'],
      mix_match: ['code', 'minimum_amount', 'maximum_amount', 'min_qty', 'max_qty', 'usage_limit',
        'product_id', 'main_product_id', 'discount_product_ids', 'required_product_ids', 'required_product_id', 'required_products'],
      multipack: ['code', 'usage_limit', 'product_id', 'main_product_id', 'qty', 'quantity', 'required_quantity'],
    };
    const allowed = [...commonFields, ...typeFields[type]];
    const output: Record<string, any> = { type };
    for (const key of allowed) if (input[key] !== undefined) output[key] = input[key];
    const mainProductId = input.main_product_id ?? input.product_id;
    if (mainProductId !== undefined) {
      // Keep both names for the custom WordPress endpoint and the admin table,
      // which may read the main product from main_product_id.
      output.product_id = mainProductId;
      output.main_product_id = mainProductId;
    }
    if (type === 'mix_match') {
      const productIds = this.discountProductIds(input);
      if (productIds !== undefined) output.discount_product_ids = productIds;
    }
    const requiredProductIds = type === 'mix_match' ? this.requiredProductIds(input) : undefined;
    if (requiredProductIds !== undefined) {
      output.required_product_ids = requiredProductIds;
      output.required_products = requiredProductIds;
      // The reference mix-and-match API persists its required/trigger product as product_id.
      if (output.type === 'mix_match' && requiredProductIds.length === 1 && output.product_id === undefined) {
        output.product_id = requiredProductIds[0];
        output.main_product_id = requiredProductIds[0];
      }
    }
    const quantity = type === 'multipack' ? input.qty ?? input.quantity ?? input.required_quantity : undefined;
    if (quantity !== undefined) {
      const numericQuantity = Number(quantity);
      if (!Number.isInteger(numericQuantity) || numericQuantity < 1) {
        throw new BadRequestException('qty must be a positive integer');
      }
      output.qty = numericQuantity;
      output.quantity = numericQuantity;
    }
    const dateStarts = input.date_starts ?? input.date_start ?? input.start_date ?? input.startDate;
    const dateExpires = input.date_expires ?? input.date_expire ?? input.expiry_date ?? input.expiryDate;
    if (dateStarts !== undefined) output.date_starts = dateStarts;
    if (dateExpires !== undefined) output.date_expires = dateExpires;
    return output;
  }

  private discountProductIds(input: Record<string, any>): Array<string | number> | undefined {
    const candidates = ['discount_product_ids', 'product_ids'];
    const supplied = candidates
      .filter(key => input[key] !== undefined)
      .map(key => ({ key, value: input[key] }));
    if (!supplied.length && input.product_id !== undefined) supplied.push({ key: 'product_id', value: input.product_id });
    if (!supplied.length) return undefined;

    const normalized = supplied.map(({ key, value }) => {
      if (key === 'product_id' && !Array.isArray(value)) return [value];
      if (!Array.isArray(value)) throw new BadRequestException(`${key} must be an array of product IDs`);
      return value;
    });
    const productIds = normalized[0];
    const ids = productIds.map(value => {
      if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
        throw new BadRequestException('Product IDs must be non-empty strings or numbers');
      }
      return String(value).trim();
    });
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Duplicate product IDs are not allowed');
    }

    // Requests may include equivalent aliases. Reject conflicting aliases rather than
    // silently choosing a different product set than the caller intended.
    for (const aliasIds of normalized.slice(1)) {
      const next = aliasIds.map(value => String(value).trim());
      if (new Set(next).size !== next.length) {
        throw new BadRequestException('Duplicate product IDs are not allowed');
      }
      if (next.length !== ids.length || next.some((value, index) => value !== ids[index])) {
        throw new BadRequestException('product_id, product_ids, and discount_product_ids must contain the same product IDs');
      }
    }
    return productIds;
  }

  private requiredProductIds(input: Record<string, any>): Array<string | number> | undefined {
    const supplied = ['required_product_ids', 'required_products']
      .filter(key => input[key] !== undefined)
      .map(key => ({ key, value: input[key] }));
    if (!supplied.length && input.required_product_id !== undefined) {
      supplied.push({ key: 'required_product_id', value: input.required_product_id });
    }
    if (!supplied.length) return undefined;
    const lists = supplied.map(({ key, value }) => {
      const values = key === 'required_product_id' && !Array.isArray(value) ? [value] : value;
      if (!Array.isArray(values)) throw new BadRequestException(`${key} must be an array of product IDs`);
      return values;
    });
    const ids = lists[0].map(value => {
      if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
        throw new BadRequestException('Required product IDs must be non-empty strings or numbers');
      }
      return String(value).trim();
    });
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Duplicate required product IDs are not allowed');
    for (const values of lists.slice(1)) {
      const aliasIds = values.map(value => String(value).trim());
      if (new Set(aliasIds).size !== aliasIds.length) throw new BadRequestException('Duplicate required product IDs are not allowed');
      if (aliasIds.length !== ids.length || aliasIds.some((value, index) => value !== ids[index])) {
        throw new BadRequestException('required_product_ids and required_products must contain the same product IDs');
      }
    }
    return lists[0];
  }

  private async assertDiscountIsUnique(
    connection: { wordpressUrl: string; wordpressJwt: string },
    group: string,
    input: Record<string, any>,
    excludedId?: string,
  ) {
    // Multipack has no name/code in the reference API; its unique key is product + qty.
    if (group === 'multipack') return;
    const name = this.discountName(input);
    if (!name?.trim()) throw new BadRequestException('code is required');
    const normalizedName = this.normalizeDiscountName(name);
    const records = await this.fetchWordPressDiscounts(connection, group);
    const duplicate = records.find(record => {
      const existingName = this.discountName(record);
      return existingName !== undefined && this.normalizeDiscountName(existingName) === normalizedName
        && (excludedId === undefined || !this.discountMatchesId(record, excludedId));
    });
    if (duplicate) throw new ConflictException(`A ${group} discount named '${name}' already exists`);
  }

  private normalizeDiscountName(value: string) {
    return value.trim().normalize('NFKC').toLocaleLowerCase();
  }

  private async assertMultipackRuleIsUnique(
    connection: { wordpressUrl: string; wordpressJwt: string },
    input: Record<string, any>,
    excludedId?: string,
  ) {
    const ids: unknown[] = [input.product_id ?? input.main_product_id ?? input.productId];
    const quantity = Number(input.qty ?? input.quantity ?? input.required_quantity);
    if (!this.isPositiveInteger(ids[0]) || !Number.isInteger(quantity) || quantity < 1) {
      throw new BadRequestException('Multipack discounts require a product_id and positive integer qty');
    }
    const records = await this.fetchWordPressDiscounts(connection, 'multipack');
    for (const productId of ids) {
      const duplicate = records.find(record =>
        String(record.product_id ?? record.productId ?? '') === String(productId)
        && Number(record.qty ?? record.quantity ?? record.required_quantity) === quantity
        && (excludedId === undefined || !this.discountMatchesId(record, excludedId)),
      );
      if (duplicate) throw new ConflictException(`A multipack discount already exists for product '${productId}' and quantity ${quantity}`);
    }
  }

  private discountName(record: Record<string, any>): string | undefined {
    const name = record.code ?? record.discount_code ?? record.discount_name ?? record.discountName ?? record.name ?? record.title;
    return typeof name === 'string' ? name : undefined;
  }

  private async fetchWordPressDiscounts(
    connection: { wordpressUrl: string; wordpressJwt: string },
    group: string,
  ): Promise<Record<string, any>[]> {
    const records: Record<string, any>[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.wordpressRequest(
        connection,
        'custom-discount/get-all-discounts-for-admin',
        'GET',
        undefined,
        { page: String(page), per_page: '100' },
      );
      const pageRecords = response?.data?.[group];
      if (Array.isArray(pageRecords)) records.push(...pageRecords.filter((record: any) => record && typeof record === 'object'));
      const hasMore = response?.pagination?.has_more === true;
      if (!hasMore && (!Array.isArray(pageRecords) || pageRecords.length < 100)) return records;
    }
    throw new BadRequestException(`Discount pagination limit reached while validating ${group} discounts`);
  }

  private canonicalizeWordPressRecord(record: Record<string, any>) {
    const canonical = { ...record };
    if (canonical.start_date === undefined) {
      canonical.start_date = canonical.date_starts ?? canonical.date_start ?? canonical.startDate;
    }
    if (canonical.expiry_date === undefined) {
      canonical.expiry_date = canonical.date_expires ?? canonical.date_expire ?? canonical.expiryDate;
    }
    // In the reference mix-and-match API the required/trigger product is persisted
    // as product_id, while the discounted products use discount_product_ids.
    if (canonical.type === 'mix_match' && canonical.required_product_ids === undefined && canonical.product_id !== undefined) {
      canonical.required_product_ids = [canonical.product_id];
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
    const discount = (payload[group] ?? []).find((item: any) => this.discountMatchesId(item, id));
    return discount ?? { id: Number(id), wordpressId: Number(id) };
  }

  private discountMatchesId(record: Record<string, any>, id: string) {
    return [record.id, record.pchId, record.wordpressId]
      .some(candidate => candidate !== undefined && candidate !== null && String(candidate) === id);
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
      const index = replaceId ? records.findIndex((item: any) => this.discountMatchesId(item, replaceId)) : -1;
      if (index >= 0) records[index] = record; else records.push(record);
      payload[group] = records;
      await this.writeDiscountSnapshot(manager, storeId, payload);
    });
  }

  private async removeDiscount(storeId: string, group: string, id: string) {
    await this.merchants.requireDataSource().transaction(async manager => {
      const [row] = await manager.query('SELECT payload FROM public.store_discounts WHERE store_id=$1::uuid AND COALESCE(is_deleted,false)=false FOR UPDATE', [storeId]);
      const payload = row?.payload ?? { auto: [], mix_match: [], multipack: [] };
      const record = (payload[group] ?? []).find((item: any) => this.discountMatchesId(item, id));
      const wordpressId = record?.wordpressId ?? record?.id ?? id;
      await manager.query(`UPDATE public.discounts SET is_deleted=true,updated_at=now()
        WHERE store_id=$1::uuid AND discount_type=$2 AND discount_id=$3`, [storeId, group, String(wordpressId)]);
      payload[group] = (payload[group] ?? []).filter((item: any) => !this.discountMatchesId(item, id));
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
      const body: any = await response.json().catch(() => ({}));
      if (!response.ok) throw new WordPressResponseException(body, response.status);
      if (!body || !body.data || typeof body.data !== 'object') throw new BadRequestException('Invalid WordPress discounts response');
      for (const group of Object.keys(payload)) {
        const discounts = body.data[group] ?? [];
        if (!Array.isArray(discounts)) throw new BadRequestException('Invalid WordPress discount group: ' + group);
        for (const discount of discounts) {
          if (!discount || typeof discount !== 'object' || discount.id === undefined) throw new BadRequestException('Invalid WordPress discount record');
          const key = group + ':' + discount.id;
          if (seen.has(key)) continue;
          seen.add(key);
          // Mirror all discounts from WooCommerce. A discount can reference products
          // that are not present in the local product snapshot; filtering those here
          // makes sync and get-all disagree with the source and silently loses rules.
          payload[group].push(discount);
        }
      }
      const pageHasRecords = ['auto', 'mix_match', 'multipack'].some(group =>
        Array.isArray(body.data[group]) && body.data[group].length > 0,
      );
      if (body.pagination?.has_more === true) continue;
      // Some plugin versions omit pagination when every group is empty.
      if (!pageHasRecords || body.pagination?.has_more === false) {
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

  private assertDiscountRulesReader(role: string | undefined, storeId: string, sessionStoreId?: string) {
    if (process.env.SKIP_AUTH === 'true') return;
    const normalizedRole = String(role ?? '').trim().toUpperCase();
    if (['OWNER', 'ADMIN', 'ADMINISTRATOR', 'MERCHANT_ADMIN'].includes(normalizedRole)) {
      if (['ADMIN', 'ADMINISTRATOR', 'MERCHANT_ADMIN'].includes(normalizedRole) && sessionStoreId && sessionStoreId !== storeId) {
        throw new ForbiddenException('Store administrators can access discounts only for their assigned store');
      }
      return;
    }
    if (sessionStoreId && sessionStoreId === storeId) return;
    throw new ForbiddenException('Discount rules can be read only for the signed-in store');
  }

}
