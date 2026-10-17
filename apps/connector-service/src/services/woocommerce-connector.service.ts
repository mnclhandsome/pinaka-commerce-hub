import { Injectable, OnModuleInit, BadRequestException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { connectPostgres } from '@pinaka-delivery-hub/database';
import { WooCommerceConnectionEntity } from '../entities/woocommerce-connection.entity';
import { WooCommerceSyncLogEntity } from '../entities/woocommerce-sync-log.entity';

@Injectable()
export class WooCommerceConnectorService implements OnModuleInit {
  private dataSource?: DataSource;
  private connRepo?: Repository<WooCommerceConnectionEntity>;
  private logRepo?: Repository<WooCommerceSyncLogEntity>;
  private isDbConnected = false;

  private inMemoryConns: WooCommerceConnectionEntity[] = [];
  private inMemoryLogs: WooCommerceSyncLogEntity[] = [];

  async onModuleInit() {
    try {
      this.dataSource = await connectPostgres('WooCommerce Connector DB', [
        WooCommerceConnectionEntity,
        WooCommerceSyncLogEntity,
      ]);
      this.connRepo = this.dataSource.getRepository(WooCommerceConnectionEntity);
      this.logRepo = this.dataSource.getRepository(WooCommerceSyncLogEntity);
      this.isDbConnected = true;
      console.log('🛒 [WooCommerce Engine] Initialized and connected to PostgreSQL');
    } catch (err: any) {
      console.warn('⚠️ [WooCommerce Engine DB Warning] ' + err.message);
    }
  }

  // --- Validate HMAC SHA256 Webhook Signature ---
  verifyHmacSignature(rawBody: string, signature: string, secret: string): boolean {
    if (!signature || !secret) return true;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
    return expected === signature;
  }

  // --- Ingest WooCommerce Webhook Dynamically ---
  async ingestWooCommerceWebhook(topic: string, body: any): Promise<WooCommerceSyncLogEntity> {
    const logId = `LOG-WC-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const log: WooCommerceSyncLogEntity = {
      id: logId,
      merchantId: body.merchantId || '',
      storeId: body.storeId || '',
      eventType: topic.toUpperCase(),
      externalId: body.id ? body.id.toString() : `WC-${Date.now()}`,
      status: 'SUCCESS',
      details: `Received WooCommerce event '${topic}' for product/order '${body.name || body.id || 'Item'}'`,
      createdAt: new Date(),
    };

    if (this.isDbConnected && this.logRepo) {
      const entity = this.logRepo.create(log);
      const saved = await this.logRepo.save(entity);
      return saved;
    } else {
      this.inMemoryLogs.unshift(log);
      return log;
    }
  }

  // --- Fetch Live WordPress Catalog from Merchant's Configured Site ---
  async fetchLiveWordPressCatalog(
    storeUrl?: string,
    jwtToken?: string
  ): Promise<Array<{ id: number; name: string; category: string; categoryId: number; price: number; sku: string; stock: number; image?: string; description?: string }>> {
    const baseUrl = String(storeUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      throw new BadRequestException('WordPress Site URL is required.');
    }

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (jwtToken?.trim()) {
      headers['Authorization'] = `Bearer ${jwtToken.trim()}`;
    }

    const items: Array<{ id: number; name: string; category: string; categoryId: number; price: number; sku: string; stock: number; image?: string; description?: string }> = [];

    try {
      // 1. Fetch Categories from WooCommerce REST API
      let categories: Array<{ id: number; name: string }> = [];
      try {
        const catRes = await (globalThis as any).fetch(`${baseUrl}/wp-json/wc/v3/products/categories?page=1&per_page=100&hide_empty=true`, { headers });
        if (catRes.ok) {
          const catData = await catRes.json();
          if (Array.isArray(catData)) {
            categories = catData.map((c: any) => ({ id: c.id, name: c.name || 'General' }));
          }
        }
      } catch (catErr: any) {
        console.log(`⚠️ WordPress Category fetch notice: ${catErr.message}`);
      }

      // 2. Fetch Products per Category using pinaka-pos custom API endpoint
      for (const cat of categories) {
        try {
          const prodRes = await (globalThis as any).fetch(`${baseUrl}/wp-json/pinaka-pos/v1/products-by-category/${cat.id}`, { headers });
          if (prodRes.ok) {
            const rawData = await prodRes.json();
            const productList = Array.isArray(rawData) ? rawData : (rawData?.products || rawData?.data || []);
            
            for (const p of productList) {
              const prodId = parseInt(p.id || p.ID || String(Math.floor(Math.random() * 100000)), 10);
              const name = p.name || p.title || p.post_title || 'Product';
              const price = parseFloat(p.price || p.regular_price || p.sale_price || '0.00') || 0;
              const sku = p.sku || String(prodId);
              const stock = parseInt(p.stock_quantity || p.stock || p.quantity || '50', 10) || 50;
              const description = p.description || p.short_description || `Imported from ${baseUrl}`;
              const image = p.image || p.featured_image || (Array.isArray(p.images) ? p.images[0]?.src : null) || null;
              
              items.push({
                id: prodId,
                name,
                category: cat.name || p.category || 'General',
                categoryId: cat.id,
                price,
                sku: String(sku),
                stock,
                image,
                description,
              });
            }
          }
        } catch (e: any) {
          console.log(`⚠️ Category ${cat.id} product fetch notice: ${e.message}`);
        }
      }

      // 3. Fallback to WooCommerce standard /wp-json/wc/v3/products endpoint if custom route was empty
      if (items.length === 0) {
        try {
          const directRes = await (globalThis as any).fetch(`${baseUrl}/wp-json/wc/v3/products?per_page=100`, { headers });
          if (directRes.ok) {
            const rawProds = await directRes.json();
            if (Array.isArray(rawProds)) {
              for (const p of rawProds) {
                const prodId = parseInt(p.id, 10) || 1;
                const catObj = Array.isArray(p.categories) && p.categories[0] ? p.categories[0] : { id: 1, name: 'General' };
                items.push({
                  id: prodId,
                  name: p.name || 'Product',
                  category: catObj.name || 'General',
                  categoryId: catObj.id || 1,
                  price: parseFloat(p.price || '0') || 0,
                  sku: p.sku || String(prodId),
                  stock: p.stock_quantity || 50,
                  image: Array.isArray(p.images) && p.images[0] ? p.images[0].src : null,
                  description: p.description || '',
                });
              }
            }
          }
        } catch (dirErr: any) {
          console.log(`⚠️ WooCommerce direct products fetch notice: ${dirErr.message}`);
        }
      }
    } catch (err: any) {
      console.log(`⚠️ WordPress Catalog Ingest Error: ${err.message}`);
    }

    return items;
  }

  private async ensureDbConnected(): Promise<boolean> {
    if (this.isDbConnected && this.dataSource?.isInitialized) return true;
    try {
      if (!this.dataSource) {
        this.dataSource = new DataSource({
          type: 'postgres',
          host: process.env.POSTGRES_HOST || 'localhost',
          port: Number(process.env.POSTGRES_PORT) || 5432,
          username: process.env.POSTGRES_USER || 'pdh_user',
          password: process.env.POSTGRES_PASSWORD || 'pdh_password',
          database: process.env.POSTGRES_DB || 'pinaka_commerce_hub_new',
          entities: [WooCommerceConnectionEntity, WooCommerceSyncLogEntity],
          synchronize: true,
        });
      }
      if (!this.dataSource.isInitialized) {
        await this.dataSource.initialize();
      }
      this.isDbConnected = true;
      return true;
    } catch (err: any) {
      console.log(`⚠️ [DB Connection Error] ${err.message}`);
      this.isDbConnected = false;
      return false;
    }
  }

  private async ensureProductTables(): Promise<void> {
    if (!this.dataSource || !this.dataSource.isInitialized) return;
  }

  // --- Dynamic Store Catalog Synchronization & Persistence ---
  async triggerFullCatalogSync(
    storeId: string,
    merchantId?: string,
    storeUrl?: string,
    jwtToken?: string
  ): Promise<{ success: boolean; syncedItemsCount: number; timestamp: string }> {
    const targetStore = storeId;
    const targetMerchant = merchantId || '';
    const cleanUrl = String(storeUrl || '').trim().replace(/\/+$/, '');

    await this.ensureDbConnected();
    await this.ensureProductTables();

    // 1. Dynamically save or update store connection record in DB
    if (this.connRepo && targetStore) {
      try {
        const existing = await this.connRepo.findOne({ where: { storeId: targetStore } });
        if (existing) {
          existing.merchantId = targetMerchant || existing.merchantId;
          existing.storeUrl = cleanUrl || existing.storeUrl;
          existing.syncStatus = 'ACTIVE';
          existing.lastSyncedAt = new Date();
          await this.connRepo.save(existing);
        } else if (cleanUrl) {
          const newConn = this.connRepo.create({
            id: `WC-CONN-${Date.now()}`,
            merchantId: targetMerchant,
            storeId: targetStore,
            storeUrl: cleanUrl,
            autoSyncInventory: true,
            syncStatus: 'ACTIVE',
            lastSyncedAt: new Date(),
          });
          await this.connRepo.save(newConn);
        }
      } catch (connErr: any) {
        console.warn('⚠️ [Connection Record Save Warning] ' + connErr.message);
      }
    }

    let syncedCount = 0;

    // 2. Fetch live data from the dynamic WordPress URL and persist into DB
    if (this.dataSource && this.dataSource.isInitialized && cleanUrl) {
      try {
        const liveProducts = await this.fetchLiveWordPressCatalog(cleanUrl, jwtToken);

        const categories = new Map<number, { id: number; name: string; slug: string }>();
        liveProducts.forEach((item) => {
          const categoryId = item.categoryId || 1;
          categories.set(categoryId, {
            id: categoryId,
            name: item.category,
            slug: String(item.category || '').toLowerCase().replace(/\s+/g, '-'),
          });
        });
        await this.dataSource.query(
          `INSERT INTO public.store_products (store_id, payload, updated_at)
           VALUES ($1::uuid, $2::jsonb, now())
           ON CONFLICT (store_id)
           DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), is_deleted = false`,
          [targetStore, JSON.stringify(liveProducts)],
        );
        await this.dataSource.query(
          `INSERT INTO public.store_categories (store_id, payload, updated_at)
           VALUES ($1::uuid, $2::jsonb, now())
           ON CONFLICT (store_id)
           DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), is_deleted = false`,
          [targetStore, JSON.stringify([...categories.values()])],
        );
        syncedCount = liveProducts.length;
        console.log(`🛒 [WooCommerce Dynamic Ingest] Synced ${syncedCount} items into store_products for Store: ${targetStore}`);
      } catch (err: any) {
        console.log(`⚠️ [Catalog Ingest Exception] ${err.message}`);
      }
    }

    await this.ingestWooCommerceWebhook('TEST_CONNECTION_SYNC', { merchantId: targetMerchant, storeId: targetStore, count: syncedCount });
    return {
      success: true,
      syncedItemsCount: syncedCount,
      timestamp: new Date().toISOString(),
    };
  }

  async getConnection(storeId: string): Promise<WooCommerceConnectionEntity | null> {
    if (this.isDbConnected && this.connRepo) {
      return await this.connRepo.findOne({ where: { storeId } });
    }
    return this.inMemoryConns.find((c) => c.storeId === storeId) || null;
  }
}
