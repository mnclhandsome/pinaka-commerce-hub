import { DataSource } from 'typeorm';
import { createMissingTables } from '@pinaka-delivery-hub/database';
import { StoreDiscountEntity } from '../../entities/store-discount.entity';
import { BadRequestException, ForbiddenException, Inject, Injectable, InternalServerErrorException, NotFoundException, OnModuleInit } from '@nestjs/common';
import { createDecipheriv, createHash } from 'node:crypto';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';

@Injectable()
export class DiscountService implements OnModuleInit {
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
    } finally {
      await source.destroy();
    }
  }

  async sync(storeId: string, role?: string) {
    const connection = await this.requireWordPressConnection(storeId, role);
    const result = await this.syncStoreDiscountsFromWordPress(connection);
    return { success: true, storeId: connection.storeId, ...result };
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
    await this.merchants.requireDataSource().query(`
      INSERT INTO public.store_discounts (store_id,payload) VALUES ($1::uuid,$2::jsonb)
      ON CONFLICT (store_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now(),is_deleted=false
    `, [params.storeId, JSON.stringify(payload)]);
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
    if (process.env.SKIP_AUTH !== 'true' && role !== 'OWNER') throw new ForbiddenException('Only owners can manage website connections');
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

}
