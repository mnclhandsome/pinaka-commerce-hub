import { BadGatewayException, BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { postgresConnectionOptions } from '@pinaka-delivery-hub/database';
import { CouponInputDto } from './coupon.dto';
import { CouponSyncStatus, StoreCouponEntity } from './store-coupon.entity';

type WooCoupon = Record<string, any> & { id: number; code: string };
type Connection = { merchantId: string; storeId: string; storeUrl: string; consumerKey?: string; consumerSecret?: string; bearerToken?: string; webhookSecret?: string };

@Injectable()
export class CouponService implements OnModuleInit {
  private dataSource?: DataSource;
  private repo?: Repository<StoreCouponEntity>;
  private readonly webhookRegistrations = new Map<string, Promise<void>>();

  async onModuleInit() {
    try {
      this.dataSource = new DataSource({ ...postgresConnectionOptions([StoreCouponEntity]), synchronize: true });
      await this.dataSource.initialize();
      this.repo = this.dataSource.getRepository(StoreCouponEntity);
    } catch (error: any) {
      console.error(`[Merchant Service Coupons] Database initialization failed: ${error.message}`);
    }
  }

  async create(input: CouponInputDto, publicBaseUrl = '') {
    const repo = this.repository();
    await this.validateOwner(input.merchantId, input.storeId);
    await this.validateProductReferences(input.storeId, input.productIds, input.excludedProductIds, input.requiredProductIds);
    if (await repo.findOne({ where: { storeId: input.storeId, code: this.code(input.code) } })) {
      throw new ConflictException('Coupon code already exists for this store');
    }
    const coupon = repo.create({ ...this.fromInput(input), syncStatus: CouponSyncStatus.PENDING, source: 'PCH' });
    if (input.requiredProductIds !== undefined) {
      coupon.woocommercePayload = { meta_data: this.withRequiredProductMeta([], input.requiredProductIds) };
    }
    await repo.save(coupon);
    const synchronized = await this.push(coupon);
    await this.ensureCouponWebhooks(input.storeId, publicBaseUrl).catch(error => {
      console.warn(`[Merchant Service Coupons] Webhook registration skipped: ${error.message}`);
    });
    return synchronized;
  }

  async update(id: string, input: CouponInputDto) {
    const coupon = await this.get(id);
    if (coupon.merchantId !== input.merchantId || coupon.storeId !== input.storeId) {
      throw new BadRequestException('A coupon cannot be moved to another merchant or store');
    }
    await this.validateProductReferences(input.storeId, input.productIds, input.excludedProductIds, input.requiredProductIds);
    const duplicate = await this.repository().findOne({ where: { storeId: input.storeId, code: this.code(input.code) } });
    if (duplicate && duplicate.id !== id) throw new ConflictException('Coupon code already exists for this store');
    Object.assign(coupon, this.fromInput(input), { syncStatus: CouponSyncStatus.PENDING, syncError: null, source: 'PCH', deletedAt: null });
    if (input.requiredProductIds !== undefined) {
      coupon.woocommercePayload = {
        ...(coupon.woocommercePayload || {}),
        meta_data: this.withRequiredProductMeta(coupon.woocommercePayload?.meta_data, input.requiredProductIds),
      };
    }
    await this.repository().save(coupon);
    return this.push(coupon);
  }

  async get(id: string) {
    const coupon = await this.repository().findOne({ where: { id } });
    if (!coupon) throw new NotFoundException(`Coupon '${id}' was not found`);
    return coupon;
  }

  async list(merchantId: string, storeId: string, page = 1, perPage = 25, includeDeleted = false) {
    await this.validateOwner(merchantId, storeId);
    page = Math.max(1, page); perPage = Math.min(100, Math.max(1, perPage));
    const qb = this.repository().createQueryBuilder('coupon')
      .where('coupon.merchant_id = :merchantId AND coupon.store_id = :storeId', { merchantId, storeId });
    if (!includeDeleted) qb.andWhere('coupon.deleted_at IS NULL');
    const [coupons, total] = await qb.orderBy('coupon.updated_at', 'DESC').skip((page - 1) * perPage).take(perPage).getManyAndCount();
    return { coupons, total, page, perPage };
  }

  async remove(id: string) {
    const coupon = await this.get(id);
    if (coupon.syncStatus === CouponSyncStatus.DELETED) return coupon;
    coupon.deletedAt ||= new Date();
    coupon.syncStatus = CouponSyncStatus.PENDING;
    await this.repository().save(coupon);
    try {
      if (coupon.woocommerceCouponId) await this.request(coupon.storeId, `coupons/${coupon.woocommerceCouponId}?force=true`, 'DELETE');
      return this.markDeleted(coupon);
    } catch (error: any) {
      if (error.wooStatus === 404) return this.markDeleted(coupon);
      return this.fail(coupon, error);
    }
  }

  async retry(id: string) {
    const coupon = await this.get(id);
    if (coupon.syncStatus !== CouponSyncStatus.FAILED) throw new BadRequestException('Only failed synchronizations can be retried');
    if (coupon.deletedAt) {
      try {
        if (coupon.woocommerceCouponId) await this.request(coupon.storeId, `coupons/${coupon.woocommerceCouponId}?force=true`, 'DELETE');
        return this.markDeleted(coupon);
      } catch (error: any) {
        if (error.wooStatus === 404) return this.markDeleted(coupon);
        return this.fail(coupon, error);
      }
    }
    return this.push(coupon);
  }

  async synchronize(storeId: string, merchantId?: string) {
    const connection = await this.connection(storeId);
    if (merchantId && merchantId !== connection.merchantId) throw new BadRequestException('Store does not belong to the supplied merchant');
    const summary = { created: 0, updated: 0, skipped: 0, failed: 0 };
    for (let page = 1; ; page++) {
      const batch = await this.request(storeId, `coupons?per_page=100&page=${page}`, 'GET') as WooCoupon[];
      for (const remote of batch) {
        try {
          const result = await this.upsertRemote(connection.merchantId, storeId, remote, true);
          summary[result]++;
        } catch { summary.failed++; }
      }
      if (batch.length < 100) break;
    }
    return { storeId, merchantId: connection.merchantId, ...summary, synchronizedAt: new Date().toISOString() };
  }

  async webhook(storeId: string, topic: string, remote: WooCoupon, signature: string, rawBody: Buffer) {
    const connection = await this.connection(storeId);
    if (!connection.webhookSecret || !this.validSignature(rawBody, signature, connection.webhookSecret)) {
      throw new UnauthorizedException('Invalid WooCommerce webhook signature');
    }
    if (!remote?.id) throw new BadRequestException('WooCommerce coupon ID is required');
    const event = String(topic || '').toLowerCase();
    if (event === 'coupon.deleted') {
      const coupon = await this.byWooId(storeId, remote.id);
      return coupon ? this.markDeleted(coupon, 'WOOCOMMERCE') : { skipped: true };
    }
    if (!['coupon.created', 'coupon.updated'].includes(event)) return { skipped: true };
    return this.upsertRemote(connection.merchantId, storeId, remote);
  }

  private async push(coupon: StoreCouponEntity) {
    try {
      if (!coupon.woocommerceCouponId) {
        const matches = await this.request(coupon.storeId, `coupons?code=${encodeURIComponent(coupon.code)}&per_page=100`, 'GET') as WooCoupon[];
        const exact = matches.find(item => this.code(item.code) === coupon.code);
        if (exact) coupon.woocommerceCouponId = String(exact.id);
      }
      const remote = await this.request(coupon.storeId, coupon.woocommerceCouponId ? `coupons/${coupon.woocommerceCouponId}` : 'coupons', coupon.woocommerceCouponId ? 'PUT' : 'POST', this.toWoo(coupon)) as WooCoupon;
      Object.assign(coupon, this.fromWoo(remote), { woocommerceCouponId: String(remote.id), syncStatus: CouponSyncStatus.SYNCED, syncError: null, lastSyncAt: new Date(), source: 'PCH' });
      return this.repository().save(coupon);
    } catch (error) { return this.fail(coupon, error); }
  }

  private async ensureCouponWebhooks(storeId: string, publicBaseUrl: string) {
    const running = this.webhookRegistrations.get(storeId);
    if (running) return running;
    const registration = this.registerCouponWebhooks(storeId, publicBaseUrl)
      .finally(() => this.webhookRegistrations.delete(storeId));
    this.webhookRegistrations.set(storeId, registration);
    return registration;
  }

  private async registerCouponWebhooks(storeId: string, requestBaseUrl: string) {
    if (!this.dataSource) throw new Error('Coupon database is unavailable');
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    const lockKey = `coupon-webhooks:${storeId}`;
    await runner.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    try {
      await this.registerCouponWebhooksLocked(storeId, requestBaseUrl);
    } finally {
      await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      await runner.release();
    }
  }

  private async registerCouponWebhooksLocked(storeId: string, requestBaseUrl: string) {
    const publicBaseUrl = String(process.env.COUPON_WEBHOOK_BASE_URL || requestBaseUrl || '').trim().replace(/\/+$/, '');
    if (!publicBaseUrl) throw new Error('Public merchant-service URL is unavailable');
    const callback = `${publicBaseUrl}/connector/api/v1/coupons/webhook?storeId=${encodeURIComponent(storeId)}`;
    const callbackHost = new URL(callback).hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1'].includes(callbackHost)) {
      throw new Error('WooCommerce cannot deliver webhooks to localhost; call the API through its public URL');
    }
    const connection = await this.connection(storeId);
    if (!connection.webhookSecret) throw new Error('Webhook secret is unavailable');
    const existing: Array<Record<string, any>> = [];
    for (let page = 1; ; page++) {
      const batch = await this.request(storeId, `webhooks?per_page=100&page=${page}`, 'GET') as Array<Record<string, any>>;
      existing.push(...batch);
      if (batch.length < 100) break;
    }
    for (const topic of ['coupon.created', 'coupon.updated', 'coupon.deleted']) {
      const found = existing.find(hook => String(hook.topic).toLowerCase() === topic && this.sameDeliveryUrl(hook.delivery_url, callback));
      if (found) {
        // WooCommerce never returns the stored secret. Refresh it on every
        // idempotent registration pass so a deployment/key change cannot leave
        // an active-looking webhook that fails PCH signature validation.
        await this.request(storeId, `webhooks/${found.id}`, 'PUT', {
          name: `PCH ${topic}`,
          topic,
          delivery_url: callback,
          secret: connection.webhookSecret,
          status: 'active',
        });
      } else if (!found) {
        await this.request(storeId, 'webhooks', 'POST', {
          name: `PCH ${topic}`,
          topic,
          delivery_url: callback,
          secret: connection.webhookSecret,
          status: 'active',
        });
      }
    }
  }

  private sameDeliveryUrl(left: unknown, right: string): boolean {
    try {
      const normalize = (value: string) => {
        const url = new URL(value);
        url.pathname = url.pathname.replace(/\/+$/, '');
        url.hash = '';
        return url.toString();
      };
      return normalize(String(left || '')) === normalize(right);
    } catch { return false; }
  }

  private async upsertRemote(merchantId: string, storeId: string, remote: WooCoupon, force = false): Promise<'created' | 'updated' | 'skipped'> {
    let coupon = await this.byWooId(storeId, remote.id);
    if (!coupon) coupon = await this.repository().findOne({ where: { storeId, code: this.code(remote.code) } });
    const modified = this.remoteDate(remote.date_modified_gmt || remote.date_modified);
    if (coupon?.woocommerceDateModified && modified && modified <= coupon.woocommerceDateModified) {
      // Webhooks must never overwrite newer state. Reconciliation may refresh a
      // legacy/missing JSON payload, but should skip an identical remote record.
      if (!force || this.samePayload(coupon.woocommercePayload, remote)) return 'skipped';
    }
    const outcome = coupon ? 'updated' : 'created';
    coupon ||= this.repository().create({ merchantId, storeId });
    Object.assign(coupon, this.fromWoo(remote), { merchantId, storeId, woocommerceCouponId: String(remote.id), syncStatus: CouponSyncStatus.SYNCED, syncError: null, lastSyncAt: new Date(), source: 'WOOCOMMERCE', deletedAt: null });
    await this.repository().save(coupon);
    return outcome;
  }

  private async markDeleted(coupon: StoreCouponEntity, source: 'PCH' | 'WOOCOMMERCE' = 'PCH') {
    Object.assign(coupon, { deletedAt: coupon.deletedAt || new Date(), syncStatus: CouponSyncStatus.DELETED, syncError: null, lastSyncAt: new Date(), source });
    return this.repository().save(coupon);
  }

  private async fail(coupon: StoreCouponEntity, error: any): Promise<never> {
    Object.assign(coupon, { syncStatus: CouponSyncStatus.FAILED, syncAttempts: (coupon.syncAttempts || 0) + 1, syncError: error?.message || 'Synchronization failed', lastSyncAt: new Date() });
    await this.repository().save(coupon);
    throw error;
  }

  private async request(storeId: string, path: string, method: string, body?: object) {
    const connection = await this.connection(storeId);
    let response: any;
    try {
      const authorization = connection.bearerToken
        ? `Bearer ${connection.bearerToken}`
        : `Basic ${Buffer.from(`${connection.consumerKey}:${connection.consumerSecret}`).toString('base64')}`;
      response = await (globalThis as any).fetch(`${connection.storeUrl.replace(/\/+$/, '')}/wp-json/wc/v3/${path}`, {
        method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error: any) { throw new BadGatewayException(`WooCommerce request failed: ${error.message}`); }
    const text = await response.text(); let data: any;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) { const error: any = new BadGatewayException(data?.message || `WooCommerce returned HTTP ${response.status}`); error.wooStatus = response.status; throw error; }
    return data;
  }

  private async connection(storeId: string): Promise<Connection> {
    let rows: Connection[] = [];
    try {
      rows = await this.repository().manager.query(
        `SELECT "merchantId", "storeId", "storeUrl", "consumerKey", "consumerSecret", "webhookSecret"
           FROM public.woocommerce_connections WHERE "storeId" = $1 AND "syncStatus" = 'ACTIVE' LIMIT 1`, [storeId]);
    } catch (error: any) {
      if (error?.driverError?.code !== '42P01' && error?.code !== '42P01') throw error;
    }
    if (rows.length) {
      if (!rows[0].storeUrl || !rows[0].consumerKey || !rows[0].consumerSecret) throw new BadRequestException('WooCommerce credentials are incomplete');
      return rows[0];
    }

    const websiteRows = await this.repository().manager.query(
      `SELECT "merchantId", "storeId", "wordpressUrl", "encryptedJwt", status
         FROM public.website_connections WHERE "storeId" = $1 AND status = 'CONNECTED' LIMIT 1`, [storeId]);
    if (!websiteRows.length) throw new NotFoundException(`No active WooCommerce or WordPress connection for store '${storeId}'`);
    return {
      merchantId: websiteRows[0].merchantId,
      storeId: websiteRows[0].storeId,
      storeUrl: websiteRows[0].wordpressUrl,
      bearerToken: this.decryptWebsiteToken(websiteRows[0].encryptedJwt),
      webhookSecret: this.websiteWebhookSecret(storeId),
    };
  }

  private websiteWebhookSecret(storeId: string): string {
    const key = process.env.STORE_CONFIG_ENCRYPTION_KEY || process.env.AUTH_JWT_SECRET || 'pdh-local-development-secret-change-me';
    return crypto.createHmac('sha256', key).update(`woocommerce-coupon-webhooks:${storeId}`).digest('base64url');
  }

  private decryptWebsiteToken(value: string): string {
    const savedToken = String(value || '').trim();
    if (savedToken.split('.').length === 3 && savedToken.startsWith('ey')) return savedToken;
    const [version, ivPart, ciphertextPart, tagPart] = savedToken.split(':');
    if (version !== 'v1' || !ivPart || !ciphertextPart || !tagPart) {
      throw new BadRequestException('The saved WordPress JWT is invalid; reconnect the store website');
    }
    const configuredKey = process.env.STORE_CONFIG_ENCRYPTION_KEY;
    const key = configuredKey
      ? Buffer.from(configuredKey, 'base64')
      : crypto.createHash('sha256').update(process.env.AUTH_JWT_SECRET || 'pdh-local-development-secret-change-me').digest();
    if (key.length !== 32) throw new BadRequestException('Store connector encryption key is invalid');
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new BadRequestException('The saved WordPress JWT cannot be decrypted; reconnect the store website');
    }
  }

  private async validateOwner(merchantId: string, storeId: string) {
    const rows = await this.repository().manager.query('SELECT 1 FROM public.stores WHERE id = $1::uuid AND merchant_id = $2::uuid AND COALESCE(is_deleted, false) = false', [storeId, merchantId]);
    if (!rows.length) throw new BadRequestException('Store does not belong to the supplied merchant');
  }

  private async validateProductReferences(storeId: string, productIds?: number[], excludedProductIds?: number[], requiredProductIds?: number[]) {
    const requested = [...new Set([...(productIds || []), ...(excludedProductIds || []), ...(requiredProductIds || [])].map(Number))];
    if (!requested.length) return;
    if (requested.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      throw new BadRequestException('Coupon productIds and excludedProductIds must contain positive numeric product IDs');
    }
    const rows = await this.repository().manager.query(
      `SELECT DISTINCT (product->>'id')::bigint AS id
         FROM public.store_products AS catalog
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(catalog.payload) = 'array' THEN catalog.payload ELSE '[]'::jsonb END
         ) AS product
        WHERE catalog.store_id = $1::uuid
          AND COALESCE(catalog.is_deleted, false) = false
          AND product->>'id' ~ '^[0-9]+$'
          AND (product->>'id')::bigint = ANY($2::bigint[])`,
      [storeId, requested],
    );
    const found = new Set(rows.map((row: { id: string | number }) => Number(row.id)));
    const missing = requested.filter(id => !found.has(id));
    if (missing.length) {
      throw new BadRequestException(`Coupon products are not present in store_products for this store: ${missing.join(', ')}`);
    }
  }

  private fromInput(i: CouponInputDto): Partial<StoreCouponEntity> {
    const expiry = i.dateExpires ? new Date(i.dateExpires) : null;
    if (expiry && Number.isNaN(expiry.getTime())) throw new BadRequestException('dateExpires must be a valid date');
    return { merchantId: i.merchantId, storeId: i.storeId, code: this.code(i.code), amount: i.amount, discountType: i.discountType, description: i.description || '', dateExpires: expiry, individualUse: !!i.individualUse, productIds: i.productIds || [], excludedProductIds: i.excludedProductIds || [], usageLimit: i.usageLimit ?? null, usageLimitPerUser: i.usageLimitPerUser ?? null, limitUsageToXItems: i.limitUsageToXItems ?? null, freeShipping: !!i.freeShipping, productCategories: i.productCategories || [], excludedProductCategories: i.excludedProductCategories || [], excludeSaleItems: !!i.excludeSaleItems, minimumAmount: i.minimumAmount || '0', maximumAmount: i.maximumAmount || '0', emailRestrictions: i.emailRestrictions || [] };
  }

  private fromWoo(w: WooCoupon): Partial<StoreCouponEntity> {
    return { code: this.code(w.code), amount: String(w.amount || '0'), discountType: w.discount_type || 'fixed_cart', description: w.description || '', dateExpires: this.remoteDate(w.date_expires_gmt || w.date_expires), individualUse: !!w.individual_use, productIds: this.numberIds(w.product_ids), excludedProductIds: this.numberIds(w.excluded_product_ids), usageLimit: w.usage_limit ?? null, usageLimitPerUser: w.usage_limit_per_user ?? null, limitUsageToXItems: w.limit_usage_to_x_items ?? null, usageCount: w.usage_count || 0, freeShipping: !!w.free_shipping, productCategories: this.numberIds(w.product_categories), excludedProductCategories: this.numberIds(w.excluded_product_categories), excludeSaleItems: !!w.exclude_sale_items, minimumAmount: String(w.minimum_amount || '0'), maximumAmount: String(w.maximum_amount || '0'), emailRestrictions: w.email_restrictions || [], usedBy: (w.used_by || []).map(String), woocommercePayload: w, woocommerceDateCreated: this.remoteDate(w.date_created_gmt || w.date_created), woocommerceDateModified: this.remoteDate(w.date_modified_gmt || w.date_modified) };
  }

  private toWoo(c: StoreCouponEntity) { return { code: c.code, amount: String(c.amount), discount_type: c.discountType, description: c.description, date_expires: c.dateExpires?.toISOString() || null, individual_use: c.individualUse, product_ids: c.productIds, excluded_product_ids: c.excludedProductIds, usage_limit: c.usageLimit, usage_limit_per_user: c.usageLimitPerUser, limit_usage_to_x_items: c.limitUsageToXItems, free_shipping: c.freeShipping, product_categories: c.productCategories, excluded_product_categories: c.excludedProductCategories, exclude_sale_items: c.excludeSaleItems, minimum_amount: String(c.minimumAmount), maximum_amount: String(c.maximumAmount), email_restrictions: c.emailRestrictions, meta_data: Array.isArray(c.woocommercePayload?.meta_data) ? c.woocommercePayload.meta_data : [] }; }
  private byWooId(storeId: string, id: number) { return this.repository().findOne({ where: { storeId, woocommerceCouponId: String(id) } }); }
  private code(value: string) { return String(value || '').trim().toLowerCase(); }
  private remoteDate(value: any) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date : null; }
  private numberIds(value: unknown): number[] {
    if (Array.isArray(value)) return [...new Set(value.map(Number).filter(Number.isFinite))];
    if (value && typeof value === 'object') return [...new Set(Object.values(value as Record<string, unknown>).map(Number).filter(Number.isFinite))];
    const text = String(value || '').trim();
    if (!text) return [];
    try { const parsed = JSON.parse(text); if (parsed !== text) return this.numberIds(parsed); } catch {}
    const serializedStrings = [...text.matchAll(/s:\d+:"(\d+)"/g)].map(match => Number(match[1]));
    if (serializedStrings.length) return [...new Set(serializedStrings)];
    return [...new Set((text.match(/\d+/g) || []).map(Number).filter(Number.isFinite))];
  }
  private withRequiredProductMeta(value: unknown, requiredProductIds: number[]): Array<Record<string, unknown>> {
    const keys = new Set(['required_product_ids', '_required_product_ids']);
    const metadata = Array.isArray(value)
      ? value.filter((item: any) => item && typeof item === 'object' && !keys.has(String(item.key))).map((item: any) => ({ ...item }))
      : [];
    const ids = this.numberIds(requiredProductIds);
    metadata.push({ key: 'required_product_ids', value: ids });
    metadata.push({ key: '_required_product_ids', value: ids.map(String) });
    return metadata;
  }
  private samePayload(current: unknown, remote: unknown): boolean {
    if (!current) return false;
    try { return JSON.stringify(this.canonicalJson(current)) === JSON.stringify(this.canonicalJson(remote)); } catch { return false; }
  }
  private canonicalJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => this.canonicalJson(item));
    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
        result[key] = this.canonicalJson((value as Record<string, unknown>)[key]);
        return result;
      }, {});
    }
    return value;
  }
  private validSignature(body: Buffer, signature: string, secret: string) { if (!signature) return false; const expected = Buffer.from(crypto.createHmac('sha256', secret).update(body).digest('base64')); const supplied = Buffer.from(signature); return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied); }
  private repository() { if (!this.repo) throw new ServiceUnavailableException('Coupon database is unavailable'); return this.repo; }
}
