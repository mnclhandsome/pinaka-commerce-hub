import { BadRequestException, ConflictException, Injectable, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
import Redis from 'ioredis';
import { postgresConnectionOptions } from '@pinaka-delivery-hub/database';
import { OrderEntity, OrderType, PaymentMethod, PaymentStatus, OrderStatus } from './entities/order.entity';
import { OrderItemEntity } from './entities/order-item.entity';
import { OrderStatusHistoryEntity } from './entities/order-status-history.entity';
import { StoreOrderEntity } from './entities/store-order.entity';
import { ensureStorePosPaymentsSchema } from './schemas/store-pos-payments.schema';
import {
  calculateStoreOrder,
  type StoreOrderCalculationInput,
  sumLineSubtotals,
  sumLineTotals,
} from './calculations/store-order.calculations';

@Injectable()
export class OrderRepository implements OnModuleInit {
  private dataSource?: DataSource;
  private orderRepo?: Repository<OrderEntity>;
  private itemRepo?: Repository<OrderItemEntity>;
  private historyRepo?: Repository<OrderStatusHistoryEntity>;
  private storeOrderRepo?: Repository<StoreOrderEntity>;
  private redisClient?: Redis;
  private isDbConnected = false;
  private isRedisConnected = false;

  private inMemoryOrders: OrderEntity[] = [];
  private inMemoryItems: OrderItemEntity[] = [];
  private inMemoryHistory: OrderStatusHistoryEntity[] = [];

  async onModuleInit() {
    try {
      await this.migrateLegacyOrderIdsBeforeOrm();
      await this.migrateOrderColumnsToSnakeCase();
      this.dataSource = new DataSource({
        ...postgresConnectionOptions([OrderEntity, OrderItemEntity, OrderStatusHistoryEntity, StoreOrderEntity]),
        synchronize: false,
      });
      await this.dataSource.initialize();
      await this.ensureOrderUuidSchema();
      await this.ensurePosOrderColumns();
      await this.ensureStoreOrdersTable();
      await ensureStorePosPaymentsSchema(this.dataSource);
      this.orderRepo = this.dataSource.getRepository(OrderEntity);
      this.itemRepo = this.dataSource.getRepository(OrderItemEntity);
      this.historyRepo = this.dataSource.getRepository(OrderStatusHistoryEntity);
      this.storeOrderRepo = this.dataSource.getRepository(StoreOrderEntity);
      this.isDbConnected = true;
    } catch (err: any) {
      console.log(`⚠️ [Order Service DB] Offline (${err.message}). Using in-memory store fallback.`);
      this.isDbConnected = false;
    }

    try {
      this.redisClient = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
        lazyConnect: true,
        connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 3000,
        maxRetriesPerRequest: 1,
        // Do not hold Nest's startup open retrying an unavailable optional cache.
        retryStrategy: () => null,
      });
      const redisConnectTimeoutMs = Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 3000;
      let redisConnectTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.redisClient.connect(),
          new Promise<never>((_, reject) => {
            redisConnectTimer = setTimeout(
              () => reject(new Error(`Redis connection timed out after ${redisConnectTimeoutMs}ms`)),
              redisConnectTimeoutMs,
            );
          }),
        ]);
      } finally {
        if (redisConnectTimer) clearTimeout(redisConnectTimer);
      }
      this.isRedisConnected = true;
      console.log('⚡ [Order Service Redis] Connected to Redis Container');
    } catch (err: any) {
      this.redisClient?.disconnect();
      console.log(`⚠️ [Order Service Redis] Offline (${err.message}).`);
      this.isRedisConnected = false;
    }
  }

  async calculate(input: StoreOrderCalculationInput = {}, storeId?: string) {
    const result = calculateStoreOrder(input);
    if (!input.includeCashbackFee) return { ...result, cashbackFee: 0 };
    const cashbackLine = (input.lineItems || []).find(
      (line) => String(line?.name || '').trim().toLowerCase() === 'cashback',
    );
    const amount = input.cashbackAmount ?? Math.abs(Number(cashbackLine?.total || 0));
    const cashbackFee = await this.cashbackFeeForAmount(storeId || '', amount);
    return { ...result, cashbackFee };
  }

  async createOrder(orderData: any): Promise<{ order: OrderEntity; items: OrderItemEntity[]; storeOrder: StoreOrderEntity | null; duplicate: boolean }> {
    if (!this.isDbConnected || !this.dataSource || !this.orderRepo || !this.itemRepo) {
      throw new ServiceUnavailableException('Order database is unavailable; the order was not saved');
    }
    const sourcePayload = JSON.parse(JSON.stringify(orderData.requestPayload || {}));
    if (this.isDbConnected && this.dataSource) {
      const stores = await this.dataSource.query(
        `SELECT id, merchant_id, currency, timezone
         FROM public.stores
         WHERE id = $1::uuid AND COALESCE(is_deleted, false) = false
         LIMIT 1`,
        [orderData.storeId],
      );
      if (!stores.length) {
        throw new BadRequestException(`Store '${orderData.storeId}' was not found`);
      }
      orderData.merchantId = orderData.merchantId || stores[0].merchant_id;
      orderData.currency = stores[0].currency || 'USD';
      orderData.timezone = stores[0].timezone || 'UTC';
    }
    await this.enrichWooCommerceCreateOrder(orderData, sourcePayload);
    const clientOrderId = String(orderData.clientOrderId || '').trim() || undefined;
    if (clientOrderId) await this.rejectDuplicateClientOrder(orderData.storeId, clientOrderId);
    const id = randomUUID();
    const orderNumber = `#${Math.floor(1000 + Math.random() * 9000)}`;

    let subtotal = 0;
    const items: OrderItemEntity[] = (orderData.items || []).map((i: any, idx: number) => {
      const lineTotal = i.totalPrice !== undefined
        ? Number(i.totalPrice)
        : Number(i.quantity || 1) * Number(i.unitPrice || 0);
      subtotal += lineTotal;
      return {
        id: `ITEM-${id}-${idx + 1}`,
        orderId: id,
        productId: i.productId || `PROD-${idx + 1}`,
        productName: i.productName || 'Sales Item',
        quantity: Number(i.quantity || 1),
        unitPrice: Number(i.unitPrice || 0),
        totalPrice: lineTotal,
        modifiers: i.modifiers || [],
      };
    });

    subtotal = orderData.subtotal !== undefined ? Number(orderData.subtotal) : subtotal;
    const taxAmount = orderData.taxAmount !== undefined ? Number(orderData.taxAmount) : Math.round(subtotal * 0.0825 * 100) / 100;
    const discountAmount = Number(orderData.discountAmount || 0);
    const tipAmount = Number(orderData.tipAmount || 0);
    const totalAmount = orderData.totalAmount !== undefined
      ? Number(orderData.totalAmount)
      : subtotal + taxAmount - discountAmount + tipAmount;

    const order: OrderEntity = {
      id,
      orderNumber,
      merchantId: orderData.merchantId || 'MCH-1001',
      storeId: orderData.storeId || 'STR-5001',
      shiftId: orderData.shiftId || 'SHIFT-8001',
      localShiftId: orderData.localShiftId,
      clientOrderId,
      offline: Boolean(orderData.offline),
      metadata: Array.isArray(orderData.metadata) ? orderData.metadata : [],
      requestPayload: orderData.requestPayload,
      customerName: orderData.customerName || 'Walk-in Customer',
      customerPhone: orderData.customerPhone || '',
      orderType: orderData.orderType || OrderType.IN_STORE_POS,
      paymentMethod: orderData.paymentMethod || PaymentMethod.CASH,
      paymentStatus: orderData.paymentStatus || PaymentStatus.PAID,
      subtotal,
      taxAmount,
      discountAmount,
      tipAmount,
      totalAmount,
      orderStatus: orderData.orderStatus || OrderStatus.CREATED,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const storeOrder = this.buildStoreOrder(id, orderData, sourcePayload);
    if (this.isDbConnected && this.orderRepo && this.itemRepo && this.dataSource) {
      let savedOrder: OrderEntity;
      let savedStoreOrder: StoreOrderEntity;
      try {
        const saved = await this.dataSource.transaction(async manager => {
          const orderRepository = manager.getRepository(OrderEntity);
          const itemRepository = manager.getRepository(OrderItemEntity);
          const historyRepository = manager.getRepository(OrderStatusHistoryEntity);
          const storeOrderRepository = manager.getRepository(StoreOrderEntity);
          const paymentRows = this.buildStorePosPaymentRows(id, order, orderData, sourcePayload, storeOrder);
          const persistedOrder = await orderRepository.save(orderRepository.create(order));
          await itemRepository.save(items.map(item => itemRepository.create(item)));
          await historyRepository.save(historyRepository.create({
            id: `HST-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            orderId: id,
            fromStatus: 'NONE',
            toStatus: order.orderStatus,
            changedBy: 'POS System',
            reason: 'Initial Order Creation',
            createdAt: new Date(),
          }));
          const persistedStoreOrder = await storeOrderRepository.save(storeOrderRepository.create(storeOrder));
          if (paymentRows.length) {
            await manager.query(
              `INSERT INTO public.store_pos_payments (
                 order_id, merchant_id, store_id, local_id, client_order_id, device_id,
                 shift_id, user_id, payment_type, payment_method, payment_method_title,
                 amount, order_total, remaining, currency, status, entry_type, provider,
                 provider_transaction_id, provider_response, payment_at, metadata, raw_payload
               ) VALUES ${paymentRows.map((_, index) => {
                 const offset = index * 23;
                 return `(${Array.from({ length: 23 }, (_value, column) => `$${offset + column + 1}`).join(', ')})`;
               }).join(', ')}
               ON CONFLICT (store_id, order_id, device_id, local_id)
                 WHERE local_id IS NOT NULL AND deleted_at IS NULL
               DO NOTHING`,
              paymentRows.flat(),
            );
          }
          return { persistedOrder, persistedStoreOrder };
        });
        savedOrder = saved.persistedOrder;
        savedStoreOrder = saved.persistedStoreOrder;
      } catch (error: unknown) {
        if (error instanceof QueryFailedError && (error as any).driverError?.code === '22P02') {
          throw new BadRequestException(
            'Invalid UUID identifier. Send shift_id as the UUID value returned by pos_shifts.',
          );
        }
        if (error instanceof QueryFailedError && (error as any).driverError?.code === '23505' && clientOrderId) {
          throw new ConflictException(`An order with client order ID '${clientOrderId}' already exists`);
        }
        throw error;
      }
      await this.cacheOrder(savedOrder);
      console.log(`🛍️ [Order Created] Order ${savedOrder.orderNumber} ($${savedOrder.totalAmount}) created for Store ${savedOrder.storeId}`);
      return { order: savedOrder, items, storeOrder: savedStoreOrder, duplicate: false };
    } else {
      this.inMemoryOrders.unshift(order);
      this.inMemoryItems.push(...items);
      await this.recordStatusChange(id, 'NONE', order.orderStatus, 'POS System', 'Initial Order Creation');
      await this.cacheOrder(order);
      console.log(`🛍️ [Order Created (InMemory)] Order ${order.orderNumber} ($${order.totalAmount}) created for Store ${order.storeId}`);
      return { order, items, storeOrder, duplicate: false };
    }
  }

  private async rejectDuplicateClientOrder(storeId: string, clientOrderId: string): Promise<void> {
    const existing = this.isDbConnected && this.orderRepo
      ? await this.orderRepo.findOne({ where: { storeId, clientOrderId } })
      : this.inMemoryOrders.find(order => order.storeId === storeId && order.clientOrderId === clientOrderId);
    if (existing) {
      throw new ConflictException(`An order with client order ID '${clientOrderId}' already exists`);
    }
  }

  private buildStoreOrder(orderId: string, orderData: any, sourcePayload: any): StoreOrderEntity {
    const metadata = Array.isArray(sourcePayload?.meta_data)
      ? sourcePayload.meta_data
      : (Array.isArray(orderData.metadata) ? orderData.metadata : []);
    const posPayments = metadata.find((entry: any) => entry?.key === '_pos_payments')?.value;
    const metaText = (key: string) => {
      const value = metadata.find((entry: any) => entry?.key === key)?.value;
      if (value === undefined || value === null || value === '') return undefined;
      return String(value);
    };
    const lineItems = Array.isArray(sourcePayload?.line_items)
      ? sourcePayload.line_items
      : (orderData.items || []).map((item: any) => ({
          product_id: item.productId,
          name: item.productName,
          quantity: item.quantity,
          subtotal: item.totalPrice,
          total: item.totalPrice,
          meta_data: item.modifiers || [],
        }));
    const payLaterUserId = metaText('_pay_later_user_id');
    return {
      id: randomUUID(),
      orderId,
      merchantId: orderData.merchantId,
      storeId: orderData.storeId,
      clientOrderId: metaText('_pos_client_order_id') || orderData.clientOrderId || undefined,
      deviceId: metaText('pos_device_id'),
      placedBy: metaText('pos_placed_by'),
      shiftId: metaText('shift_id') || orderData.shiftId || undefined,
      currency: String(orderData.currency || 'USD').toUpperCase(),
      timezone: String(orderData.timezone || 'UTC'),
      paymentMethod: sourcePayload?.payment_method || undefined,
      paymentMethodTitle: sourcePayload?.payment_method_title || undefined,
      setPaid: Boolean(sourcePayload?.set_paid),
      status: String(sourcePayload?.status || orderData.orderStatus || 'processing').toLowerCase(),
      payLater: Boolean(metadata.find((entry: any) => entry?.key === '_pay_later')?.value),
      payLaterUserId,
      subtotal: sumLineSubtotals(lineItems),
      discountTotal: Number(sourcePayload?.discount_total ?? orderData.discountAmount ?? 0),
      feeTotal: (Array.isArray(sourcePayload?.fee_lines) ? sourcePayload.fee_lines : [])
        .reduce((sum: number, fee: any) => sum + Number(fee?.total || 0), 0),
      taxTotal: Number(sourcePayload?.total_tax ?? orderData.taxAmount ?? 0),
      total: Number(sourcePayload?.total ?? orderData.totalAmount ?? sumLineTotals(lineItems)),
      lineItems,
      feeLines: Array.isArray(sourcePayload?.fee_lines) ? sourcePayload.fee_lines : [],
      couponLines: Array.isArray(sourcePayload?.coupon_lines) ? sourcePayload.coupon_lines : [],
      taxLines: Array.isArray(sourcePayload?.tax_lines) ? sourcePayload.tax_lines : [],
      payments: Array.isArray(sourcePayload?.payments)
        ? sourcePayload.payments
        : Array.isArray(orderData.payments) ? orderData.payments
          : Array.isArray(posPayments) ? posPayments : [],
      metaData: metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private buildStorePosPaymentRows(
    orderId: string,
    order: OrderEntity,
    orderData: any,
    sourcePayload: any,
    storeOrder: StoreOrderEntity,
  ): any[][] {
    const submittedPayments = Array.isArray(sourcePayload?.payments)
      ? sourcePayload.payments
      : Array.isArray(orderData?.payments) ? orderData.payments
        : (() => {
            const metadata = Array.isArray(sourcePayload?.meta_data)
              ? sourcePayload.meta_data
              : Array.isArray(orderData?.metadata) ? orderData.metadata : [];
            const value = metadata.find((entry: any) => entry?.key === '_pos_payments')?.value;
            return Array.isArray(value) ? value : [];
          })();
    const payments = submittedPayments.length
      ? submittedPayments
      : [{
          method: sourcePayload?.payment_method || orderData?.paymentMethod || order.paymentMethod,
          method_title: sourcePayload?.payment_method_title || orderData?.paymentMethodTitle,
          amount: sourcePayload?.amount_paid ?? sourcePayload?.total ?? orderData?.totalAmount ?? order.totalAmount,
          status: sourcePayload?.set_paid === false ? 'pending' : 'completed',
          transaction_id: sourcePayload?.transaction_id ?? sourcePayload?.transactionId,
          provider: sourcePayload?.provider,
        }];

    const orderTotal = Number(order.totalAmount || 0);
    const normalizedAmounts = payments.map((payment: any) => Number(
      payment?.amount ?? payment?.total ?? payment?.value ?? 0,
    ));
    return payments.map((payment: any, index: number) => {
      const amount = normalizedAmounts[index];
      const method = String(payment?.payment_method ?? payment?.paymentMethod ?? payment?.method ??
        sourcePayload?.payment_method ?? order.paymentMethod ?? 'cash');
      const paymentAtValue = payment?.payment_at ?? payment?.paymentAt ?? payment?.created_at ?? payment?.createdAt;
      const paymentAt = paymentAtValue && !Number.isNaN(Date.parse(String(paymentAtValue)))
        ? new Date(String(paymentAtValue))
        : new Date();
      const localId = payment?.local_id ?? payment?.localId ?? payment?.id ?? null;
      const calculatedRemaining = Math.max(0, orderTotal - normalizedAmounts
        .slice(0, index + 1)
        .reduce((sum: number, value: number) => sum + (Number.isFinite(value) ? value : 0), 0));
      const remaining = Number(payment?.remaining ?? calculatedRemaining);
      const rawPayload = payment && typeof payment === 'object' ? payment : { value: payment };
      const metadata = payment?.metadata && typeof payment.metadata === 'object'
        ? payment.metadata
        : {};

      return [
        orderId,
        order.merchantId,
        order.storeId,
        localId == null ? null : String(localId),
        payment?.client_order_id ?? payment?.clientOrderId ?? storeOrder.clientOrderId ?? null,
        payment?.device_id ?? payment?.deviceId ?? storeOrder.deviceId ?? null,
        payment?.shift_id ?? payment?.shiftId ?? storeOrder.shiftId ?? null,
        payment?.user_id ?? payment?.userId ?? payment?.cashier_id ?? payment?.cashierId ?? storeOrder.placedBy ?? null,
        payment?.payment_type ?? payment?.paymentType ?? 'pos_payment',
        method,
        payment?.payment_method_title ?? payment?.paymentMethodTitle ?? payment?.method_title ?? payment?.methodTitle ??
          sourcePayload?.payment_method_title ?? orderData?.paymentMethodTitle ?? storeOrder.paymentMethodTitle ?? null,
        Number.isFinite(amount) ? amount : 0,
        orderTotal,
        Number.isFinite(remaining) ? Math.max(0, remaining) : calculatedRemaining,
        payment?.currency ?? orderData?.currency ?? null,
        payment?.status ?? (orderData?.paymentStatus === PaymentStatus.PENDING ? 'pending' : 'completed'),
        payment?.entry_type ?? payment?.entryType ?? 'payment',
        payment?.provider ?? null,
        payment?.provider_transaction_id ?? payment?.providerTransactionId ?? payment?.transaction_id ?? payment?.transactionId ?? null,
        payment?.provider_response == null && payment?.providerResponse == null
          ? null
          : JSON.stringify(payment.provider_response ?? payment.providerResponse),
        paymentAt.toISOString(),
        JSON.stringify(metadata),
        JSON.stringify(rawPayload),
      ];
    });
  }

  /**
   * WooCommerce normally resolves a product id into its price and tax rules before
   * creating an order. The compatibility endpoint must do the same because POS
   * clients commonly send only product_id and quantity.
   */
  private async enrichWooCommerceCreateOrder(orderData: any, sourcePayload: any): Promise<void> {
    const lines = Array.isArray(sourcePayload?.line_items) ? sourcePayload.line_items : null;
    if (!lines || !this.dataSource || !orderData.storeId) return;

    const productIds = [...new Set(lines
      .map((line: any) => String(line?.product_id ?? '').trim())
      .filter(Boolean))];
    if (!productIds.length) return;

    const productRows: Array<{ id?: string; product?: Record<string, unknown> }> = await this.dataSource.query(
      `SELECT product->>'id' AS id, product
         FROM public.store_products AS catalog
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(catalog.payload) = 'array' THEN catalog.payload
             WHEN jsonb_typeof(catalog.payload->'products') = 'array' THEN catalog.payload->'products'
             ELSE '[]'::jsonb
           END
         ) AS product
        WHERE catalog.store_id = $1::uuid
          AND COALESCE(catalog.is_deleted, false) = false
          AND product->>'id' = ANY($2::text[])`,
      [orderData.storeId, productIds],
    );
    const products = new Map(productRows.map((row) => [String(row.id), row.product || {}]));
    const unresolved = lines.filter((line: any) => {
      const id = String(line?.product_id ?? '').trim();
      const hasAmount = line?.total !== undefined || line?.subtotal !== undefined || line?.unitPrice !== undefined;
      return id && !products.has(id) && !hasAmount;
    });
    if (unresolved.length) {
      const ids = unresolved.map((line: any) => String(line.product_id)).join(', ');
      throw new BadRequestException(
        `Products ${ids} were not found in the store catalog. Sync the store products or send line subtotal/total explicitly.`,
      );
    }

    let taxSetting: any = null;
    let taxClasses: Array<{ name: string; rate: number | string }> = [];
    try {
      const configurations: Array<{ configuration_value?: Record<string, any> }> = await this.dataSource.query(
        `SELECT configuration_value
           FROM public.store_pos_configurations
          WHERE store_id = $1::uuid
            AND configuration_name = 'currency_taxes'
          LIMIT 1`,
        [orderData.storeId],
      );
      const configured = configurations[0]?.configuration_value;
      if (configured && typeof configured === 'object') {
        taxSetting = configured;
        taxClasses = Array.isArray(configured.taxClasses) ? configured.taxClasses : [];
      }
    } catch (error: unknown) {
      const code = error && typeof error === 'object'
        ? (error as { driverError?: { code?: string } }).driverError?.code
        : undefined;
      if (code !== '42P01' && code !== '42703') throw error;
    }

    // Backward compatibility for stores that still use the dedicated tax endpoint.
    if (!taxSetting) {
      try {
        const settings = await this.dataSource.query(
          `SELECT id, "taxEnabled", "defaultTaxRate", "taxCalculation", "decimalPlaces"
             FROM public.pos_currency_tax_settings
            WHERE "storeId" = $1
            LIMIT 1`,
          [orderData.storeId],
        );
        taxSetting = settings[0] || null;
        if (taxSetting?.id) {
          taxClasses = await this.dataSource.query(
            `SELECT name, rate FROM public.pos_tax_classes WHERE "currencyTaxId" = $1 ORDER BY "sortOrder" ASC`,
            [taxSetting.id],
          );
        }
      } catch (error: unknown) {
        const code = error && typeof error === 'object'
          ? (error as { driverError?: { code?: string } }).driverError?.code
          : undefined;
        if (code !== '42P01' && code !== '42703') throw error;
      }
    }

    const places = Number(taxSetting?.decimalPlaces ?? 2);
    const factor = 10 ** places;
    const taxClassKey = (value: unknown) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    const classRates = new Map(taxClasses.map((entry) => [taxClassKey(entry.name), Number(entry.rate || 0)]));
    const defaultRate = taxSetting?.taxEnabled === false ? 0 : Number(taxSetting?.defaultTaxRate || 0);
    const explicitTax = sourcePayload.total_tax !== undefined || (Array.isArray(sourcePayload.tax_lines) && sourcePayload.tax_lines.length > 0);
    const taxGroups = new Map<number, number>();
    let normalizedCustomItem = false;

    lines.forEach((line: any) => {
      const customNormalization = this.normalizeCustomItemQuantity(line, places);
      normalizedCustomItem ||= customNormalization.applied;
      const product = products.get(String(line?.product_id ?? '').trim());
      if (!product) {
        if (String(line?.type || '').trim().toLowerCase() !== 'custom') return;
        const taxClass = taxClassKey(line.tax_class);
        const rate = taxClass ? (classRates.get(taxClass) ?? defaultRate) : defaultRate;
        const existingTax = Number(line.total_tax);
        if (Number.isFinite(existingTax)) {
          if (customNormalization.applied) {
            // WooCommerce line amounts and taxes are quantity-extended values. The POS
            // custom-item contract supplies unit values, so extend them exactly once here.
            const previousSubtotalTax = Number(line.subtotal_tax ?? existingTax);
            const subtotalTax = previousSubtotalTax * customNormalization.quantity;
            const totalTax = existingTax * customNormalization.quantity;
            line.subtotal_tax = subtotalTax.toFixed(places);
            line.total_tax = totalTax.toFixed(places);
            line.taxes = rate > 0 ? [{ id: rate, total: line.total_tax, subtotal: line.subtotal_tax }] : [];
            const taxDeltaMinor = Math.round((totalTax - existingTax) * factor);
            if (taxDeltaMinor) taxGroups.set(rate, (taxGroups.get(rate) || 0) + taxDeltaMinor);
          }
          return;
        }
        const subtotalMinor = Math.round(Number(line.subtotal || 0) * factor);
        const totalMinor = Math.round(Number(line.total || 0) * factor);
        const subtotalTaxMinor = rate > 0 ? Math.round(subtotalMinor * rate / 100) : 0;
        const totalTaxMinor = rate > 0 ? Math.round(totalMinor * rate / 100) : 0;
        line.subtotal_tax = (subtotalTaxMinor / factor).toFixed(places);
        line.total_tax = (totalTaxMinor / factor).toFixed(places);
        line.taxes = totalTaxMinor ? [{ id: rate, total: line.total_tax, subtotal: line.subtotal_tax }] : [];
        if (totalTaxMinor) taxGroups.set(rate, (taxGroups.get(rate) || 0) + totalTaxMinor);
        return;
      }
      const quantity = Number(line.quantity || 1);
      const price = Number(product.price ?? product.sale_price ?? product.regular_price ?? 0);
      if (line.name === undefined) line.name = String(product.name || 'Sales Item');
      if (line.subtotal === undefined) line.subtotal = (price * quantity).toFixed(places);
      if (line.total === undefined) line.total = String(line.subtotal);
      if (line.tax_class === undefined) line.tax_class = String(product.tax_class || '');

      if (explicitTax) return;
      const taxable = String(product.tax_status || '').toLowerCase() === 'taxable';
      const taxClass = taxClassKey(product.tax_class);
      const rate = taxable ? (taxClass ? (classRates.get(taxClass) ?? defaultRate) : defaultRate) : 0;
      const taxableMinor = Math.round(Number(line.total || 0) * factor);
      const taxMinor = rate > 0 ? Math.round(taxableMinor * rate / 100) : 0;
      line.subtotal_tax = (taxMinor / factor).toFixed(places);
      line.total_tax = (taxMinor / factor).toFixed(places);
      line.taxes = taxMinor ? [{ id: rate, total: line.total_tax, subtotal: line.subtotal_tax }] : [];
      if (taxMinor) taxGroups.set(rate, (taxGroups.get(rate) || 0) + taxMinor);
    });

    if (!explicitTax) {
      sourcePayload.tax_lines = [...taxGroups.entries()].map(([rate, minor], index) => ({
        id: index + 1,
        rate_code: `POS-TAX-${index + 1}`,
        rate_id: index + 1,
        label: 'Tax',
        compound: false,
        tax_total: (minor / factor).toFixed(places),
        shipping_tax_total: (0).toFixed(places),
        rate_percent: rate,
        meta_data: [],
      }));
      sourcePayload.total_tax = ([...taxGroups.values()].reduce((sum, minor) => sum + minor, 0) / factor).toFixed(places);
      sourcePayload.cart_tax = sourcePayload.total_tax;
    } else if (taxGroups.size) {
      const addedTax = [...taxGroups.values()].reduce((sum, minor) => sum + minor, 0) / factor;
      sourcePayload.total_tax = (Number(sourcePayload.total_tax || 0) + addedTax).toFixed(places);
      sourcePayload.cart_tax = sourcePayload.total_tax;
      const existingTaxLines = Array.isArray(sourcePayload.tax_lines) ? sourcePayload.tax_lines : [];
      taxGroups.forEach((minor, rate) => {
        const amount = minor / factor;
        const matching = existingTaxLines.find((line: any) => Number(line?.rate_percent) === rate);
        if (matching) {
          matching.tax_total = (Number(matching.tax_total || 0) + amount).toFixed(places);
        } else {
          const id = existingTaxLines.length + 1;
          existingTaxLines.push({
            id,
            rate_code: `POS-TAX-${id}`,
            rate_id: id,
            label: 'Tax',
            compound: false,
            tax_total: amount.toFixed(places),
            shipping_tax_total: (0).toFixed(places),
            rate_percent: rate,
            meta_data: [],
          });
        }
      });
      sourcePayload.tax_lines = existingTaxLines;
    }

    const subtotal = lines.reduce((sum: number, line: any) => sum + Number(line.subtotal ?? line.total ?? 0), 0);
    const lineTotal = lines.reduce((sum: number, line: any) => sum + Number(line.total ?? line.subtotal ?? 0), 0);
    const feeTotal = (Array.isArray(sourcePayload.fee_lines) ? sourcePayload.fee_lines : [])
      .reduce((sum: number, fee: any) => sum + Number(fee?.total || 0), 0);
    const taxTotal = Number(sourcePayload.total_tax || 0);
    const shippingTotal = Number(sourcePayload.shipping_total || 0);
    if (sourcePayload.subtotal === undefined || normalizedCustomItem) sourcePayload.subtotal = subtotal.toFixed(places);
    if (sourcePayload.total === undefined || normalizedCustomItem) {
      sourcePayload.total = (lineTotal + feeTotal + taxTotal + shippingTotal).toFixed(places);
    }

    orderData.items = lines.map((line: any) => {
      const quantity = Number(line.quantity || 1);
      const total = Number(line.total ?? line.subtotal ?? 0);
      return {
        productId: String(line.product_id ?? ''),
        productName: line.name || 'Sales Item',
        quantity,
        unitPrice: quantity ? Number(line.subtotal ?? total) / quantity : 0,
        totalPrice: total,
        modifiers: Array.isArray(line.meta_data) ? line.meta_data : [],
      };
    });
    orderData.subtotal = subtotal;
    orderData.taxAmount = taxTotal;
    orderData.totalAmount = Number(sourcePayload.total);
    orderData.requestPayload = sourcePayload;
  }

  private async findStoreOrder(orderId: string): Promise<StoreOrderEntity | null> {
    if (!this.storeOrderRepo) return null;
    return this.storeOrderRepo.findOne({ where: { orderId } });
  }

  private async cashbackFeeForAmount(storeId: string, amount: number): Promise<number> {
    if (!this.dataSource || amount <= 0) return 0;
    try {
      const rows = await this.dataSource.query(
        `SELECT t.fee
           FROM public.pos_cashback_settings s
           JOIN public.pos_cashback_tiers t ON t."cashbackId" = s.id
          WHERE s."storeId" = $1
            AND s.enabled = true
            AND ($2::numeric <= COALESCE(NULLIF(s."maxCashback", 0), $2::numeric))
            AND $2::numeric BETWEEN t."fromAmount" AND t."toAmount"
          ORDER BY t."sortOrder" ASC
          LIMIT 1`,
        [storeId, amount],
      );
      return Number(rows[0]?.fee || 0);
    } catch {
      return 0;
    }
  }

  private async migrateLegacyOrderIdsBeforeOrm(): Promise<void> {
    const migrationDataSource = new DataSource({
      ...postgresConnectionOptions([]),
      synchronize: false,
      logging: false,
    });
    await migrationDataSource.initialize();
    try {
      await migrationDataSource.transaction(async manager => {
        await manager.query('SELECT pg_advisory_xact_lock(724621, 72)');
        const table = await manager.query(
          `SELECT to_regclass('public.orders') AS orders_table`,
        );
        if (!table[0]?.orders_table) return;
        const type = await manager.query(
          `SELECT data_type
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'id'`,
        );
        if (type[0]?.data_type === 'uuid') return;
        await manager.query(`
          CREATE TEMP TABLE order_uuid_migration (
            old_id varchar PRIMARY KEY,
            new_id uuid NOT NULL DEFAULT gen_random_uuid()
          ) ON COMMIT DROP
        `);
        await manager.query(`
          INSERT INTO order_uuid_migration (old_id)
          SELECT id FROM public.orders
          ON CONFLICT DO NOTHING
        `);
        await manager.query(`
          UPDATE public.order_line_items AS item
          SET "orderId" = mapping.new_id::text
          FROM order_uuid_migration AS mapping
          WHERE item."orderId" = mapping.old_id
        `);
        await manager.query(`
          UPDATE public.order_status_history AS history
          SET "orderId" = mapping.new_id::text
          FROM order_uuid_migration AS mapping
          WHERE history."orderId" = mapping.old_id
        `);
        await manager.query(`
          UPDATE public.orders AS orders
          SET id = mapping.new_id::text
          FROM order_uuid_migration AS mapping
          WHERE orders.id = mapping.old_id
        `);
        await manager.query(`
          ALTER TABLE public.orders
            ALTER COLUMN id TYPE uuid USING id::uuid,
            ALTER COLUMN id SET DEFAULT gen_random_uuid()
        `);
        await manager.query(`
          ALTER TABLE public.order_line_items
            ALTER COLUMN "orderId" TYPE uuid USING "orderId"::uuid
        `);
        await manager.query(`
          ALTER TABLE public.order_status_history
            ALTER COLUMN "orderId" TYPE uuid USING "orderId"::uuid
        `);
      });
    } finally {
      await migrationDataSource.destroy();
    }
  }

  private async migrateOrderColumnsToSnakeCase(): Promise<void> {
    const migrationDataSource = new DataSource({
      ...postgresConnectionOptions([]),
      synchronize: false,
      logging: false,
    });
    await migrationDataSource.initialize();
    try {
      await migrationDataSource.transaction(async manager => {
        await manager.query('SELECT pg_advisory_xact_lock(724621, 73)');
        const tables = await manager.query(`SELECT to_regclass('public.orders') AS orders_table`);
        if (!tables[0]?.orders_table) return;
        const renames: Array<[string, string, string]> = [
          ['orders', 'orderNumber', 'order_number'],
          ['orders', 'merchantId', 'merchant_id'],
          ['orders', 'storeId', 'store_id'],
          ['orders', 'shiftId', 'shift_id'],
          ['orders', 'localShiftId', 'local_shift_id'],
          ['orders', 'clientOrderId', 'client_order_id'],
          ['orders', 'requestPayload', 'request_payload'],
          ['orders', 'customerName', 'customer_name'],
          ['orders', 'customerPhone', 'customer_phone'],
          ['orders', 'orderType', 'order_type'],
          ['orders', 'paymentMethod', 'payment_method'],
          ['orders', 'paymentStatus', 'payment_status'],
          ['orders', 'taxAmount', 'tax_amount'],
          ['orders', 'discountAmount', 'discount_amount'],
          ['orders', 'tipAmount', 'tip_amount'],
          ['orders', 'totalAmount', 'total_amount'],
          ['orders', 'orderStatus', 'order_status'],
          ['orders', 'createdAt', 'created_at'],
          ['orders', 'updatedAt', 'updated_at'],
          ['order_line_items', 'orderId', 'order_id'],
          ['order_line_items', 'productId', 'product_id'],
          ['order_line_items', 'productName', 'product_name'],
          ['order_line_items', 'unitPrice', 'unit_price'],
          ['order_line_items', 'totalPrice', 'total_price'],
          ['order_status_history', 'orderId', 'order_id'],
          ['order_status_history', 'fromStatus', 'from_status'],
          ['order_status_history', 'toStatus', 'to_status'],
          ['order_status_history', 'changedBy', 'changed_by'],
          ['order_status_history', 'createdAt', 'created_at'],
        ];
        for (const [table, oldName, newName] of renames) {
          await manager.query(`
            DO $$ BEGIN
              IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name='${oldName}')
                 AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name='${newName}') THEN
                ALTER TABLE public."${table}" RENAME COLUMN "${oldName}" TO "${newName}";
              END IF;
            END $$
          `);
        }
        await manager.query(`
          DO $$ BEGIN
            IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='merchant_id') <> 'uuid' THEN
              ALTER TABLE public.orders ALTER COLUMN merchant_id TYPE uuid USING merchant_id::uuid;
            END IF;
            IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='store_id') <> 'uuid' THEN
              ALTER TABLE public.orders ALTER COLUMN store_id TYPE uuid USING store_id::uuid;
            END IF;
            IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='shift_id') <> 'character varying' THEN
              ALTER TABLE public.orders ALTER COLUMN shift_id DROP DEFAULT;
              ALTER TABLE public.orders ALTER COLUMN shift_id TYPE varchar(100) USING shift_id::text;
            END IF;
            IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='created_at') = 'timestamp without time zone' THEN
              ALTER TABLE public.orders ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
            END IF;
            IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='updated_at') = 'timestamp without time zone' THEN
              ALTER TABLE public.orders ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
            END IF;
            IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='order_status_history' AND column_name='created_at') = 'timestamp without time zone' THEN
              ALTER TABLE public.order_status_history ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
            END IF;
          END $$
        `);
      });
    } finally {
      await migrationDataSource.destroy();
    }
  }

  private async ensureStoreOrdersTable(): Promise<void> {
    if (!this.dataSource) return;
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS public.store_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id uuid NOT NULL,
        merchant_id uuid NOT NULL,
        store_id uuid NOT NULL,
        client_order_id varchar(150),
        device_id varchar(150),
        placed_by varchar(100),
        shift_id varchar(100),
        currency varchar(10) NOT NULL DEFAULT 'USD',
        timezone varchar(100) NOT NULL DEFAULT 'UTC',
        payment_method varchar(50),
        payment_method_title varchar(150),
        set_paid boolean NOT NULL DEFAULT false,
        status varchar(50) NOT NULL DEFAULT 'processing',
        pay_later boolean NOT NULL DEFAULT false,
        pay_later_user_id varchar(100),
        subtotal numeric(12,2) NOT NULL DEFAULT 0,
        discount_total numeric(12,2) NOT NULL DEFAULT 0,
        fee_total numeric(12,2) NOT NULL DEFAULT 0,
        tax_total numeric(12,2) NOT NULL DEFAULT 0,
        total numeric(12,2) NOT NULL DEFAULT 0,
        line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
        fee_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
        coupon_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
        tax_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
        payments jsonb NOT NULL DEFAULT '[]'::jsonb,
        meta_data jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.ensureClientOrderUniqueIndex(
      'store_orders_store_client_order_idx',
      'store_orders_store_client_order_uidx',
      'public.store_orders (store_id, client_order_id)',
    );
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS store_orders_order_id_idx
      ON public.store_orders (order_id)
    `);
  }

  private async ensurePosOrderColumns(): Promise<void> {
    if (!this.dataSource) return;
    await this.dataSource.query(`
      ALTER TABLE public.orders
        ADD COLUMN IF NOT EXISTS local_shift_id varchar(100),
        ADD COLUMN IF NOT EXISTS client_order_id varchar(150),
        ADD COLUMN IF NOT EXISTS offline boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS metadata jsonb,
        ADD COLUMN IF NOT EXISTS request_payload jsonb
    `);
    await this.ensureClientOrderUniqueIndex(
      'orders_store_client_order_id_idx',
      'orders_store_client_order_id_uidx',
      'public.orders (store_id, client_order_id)',
    );
  }

  private async ensureClientOrderUniqueIndex(plainName: string, uniqueName: string, target: string): Promise<void> {
    if (!this.dataSource) return;
    try {
      await this.dataSource.query(`DROP INDEX IF EXISTS public.${plainName}`);
      await this.dataSource.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ${uniqueName}
        ON ${target}
        WHERE client_order_id IS NOT NULL
      `);
    } catch (error) {
      console.error(`Unique client order index ${uniqueName} was not created`, error);
      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS ${plainName}
        ON ${target}
      `);
    }
  }

  private async ensureOrderUuidSchema(): Promise<void> {
    if (!this.dataSource) return;
    const columns = await this.dataSource.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'orders' AND column_name = 'id')
           OR (table_name IN ('order_line_items', 'order_status_history') AND column_name = 'order_id'))`,
    );
    if (columns.length && columns.every((column: { data_type: string }) => column.data_type === 'uuid')) {
      return;
    }
    await this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(724621, 72)');
      await manager.query(`
        CREATE TEMP TABLE order_uuid_migration (
          old_id varchar PRIMARY KEY,
          new_id uuid NOT NULL DEFAULT gen_random_uuid()
        ) ON COMMIT DROP
      `);
      await manager.query(`
        INSERT INTO order_uuid_migration (old_id)
        SELECT id FROM public.orders
        WHERE id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ON CONFLICT DO NOTHING
      `);
      await manager.query(`
        UPDATE public.order_line_items AS item
        SET "orderId" = mapping.new_id::text
        FROM order_uuid_migration AS mapping
        WHERE item."orderId" = mapping.old_id
      `);
      await manager.query(`
        UPDATE public.order_status_history AS history
        SET "orderId" = mapping.new_id::text
        FROM order_uuid_migration AS mapping
        WHERE history."orderId" = mapping.old_id
      `);
      await manager.query(`
        UPDATE public.orders AS orders
        SET id = mapping.new_id::text
        FROM order_uuid_migration AS mapping
        WHERE orders.id = mapping.old_id
      `);
      await manager.query(`
        ALTER TABLE public.orders
          ALTER COLUMN id TYPE uuid USING id::uuid,
          ALTER COLUMN id SET DEFAULT gen_random_uuid()
      `);
      await manager.query(`
        ALTER TABLE public.order_line_items
          ALTER COLUMN "orderId" TYPE uuid USING "orderId"::uuid
      `);
      await manager.query(`
        ALTER TABLE public.order_status_history
          ALTER COLUMN "orderId" TYPE uuid USING "orderId"::uuid
      `);
    });
  }

  async updateOrderStatus(orderId: string, toStatus: OrderStatus, changedBy: string, reason?: string): Promise<OrderEntity | null> {
    let order: OrderEntity | null = null;

    if (this.isDbConnected && this.orderRepo) {
      order = await this.orderRepo.findOne({ where: { id: orderId } });
      if (order) {
        const fromStatus = order.orderStatus;
        order.orderStatus = toStatus;
        order = await this.orderRepo.save(order);
        await this.recordStatusChange(orderId, fromStatus, toStatus, changedBy, reason);
      }
    } else {
      order = this.inMemoryOrders.find(o => o.id === orderId) || null;
      if (order) {
        const fromStatus = order.orderStatus;
        order.orderStatus = toStatus;
        await this.recordStatusChange(orderId, fromStatus, toStatus, changedBy, reason);
      }
    }

    if (order) {
      await this.cacheOrder(order);
      console.log(`🔄 [Order State Machine] Order #${orderId} transition: ${order.orderStatus} (by ${changedBy})`);
    }

    return order;
  }

  async saveOrderMutation(input: {
    order: OrderEntity;
    items: OrderItemEntity[];
    storeOrder: StoreOrderEntity | null;
    replaceItems: boolean;
    history?: { fromStatus: string; toStatus: string; changedBy: string; reason?: string };
  }): Promise<{ order: OrderEntity; items: OrderItemEntity[]; storeOrder: StoreOrderEntity | null }> {
    if (!this.isDbConnected || !this.dataSource) {
      throw new ServiceUnavailableException('Order database is unavailable; the order was not updated');
    }
    const saved = await this.dataSource.transaction(async manager => {
      const orderRepository = manager.getRepository(OrderEntity);
      const itemRepository = manager.getRepository(OrderItemEntity);
      const historyRepository = manager.getRepository(OrderStatusHistoryEntity);
      const storeOrderRepository = manager.getRepository(StoreOrderEntity);
      const persistedOrder = await orderRepository.save(orderRepository.create({ ...input.order }));
      let persistedItems = input.items;
      if (input.replaceItems) {
        await itemRepository.delete({ orderId: input.order.id });
        persistedItems = input.items.length
          ? await itemRepository.save(input.items.map(item => itemRepository.create(item)))
          : [];
      }
      const persistedStoreOrder = input.storeOrder
        ? await storeOrderRepository.save(storeOrderRepository.create({ ...input.storeOrder }))
        : null;
      if (input.history) {
        await historyRepository.save(historyRepository.create({
          id: `HST-${randomUUID()}`,
          orderId: input.order.id,
          fromStatus: input.history.fromStatus,
          toStatus: input.history.toStatus,
          changedBy: input.history.changedBy || 'POS System',
          reason: input.history.reason || 'Order update',
          createdAt: new Date(),
        }));
      }
      return { order: persistedOrder, items: persistedItems, storeOrder: persistedStoreOrder };
    });
    await this.cacheOrder(saved.order);
    return saved;
  }

  async listOrders(criteria: {
    storeId?: string;
    page: number;
    perPage: number;
    statuses: string[];
    createdVia?: string;
  }): Promise<{
    total: number;
    orders: Array<{
      order: OrderEntity;
      storeOrder: StoreOrderEntity | null;
      items: OrderItemEntity[];
      products: Map<string, unknown>;
    }>;
  }> {
    if (!this.isDbConnected || !this.dataSource || !this.orderRepo) {
      throw new ServiceUnavailableException('Order database is unavailable');
    }
    const statuses = criteria.statuses.length ? criteria.statuses : null;
    const createdVia = criteria.createdVia?.trim().toLowerCase() || null;
    const storeId = criteria.storeId || null;
    const params: unknown[] = [storeId, statuses, createdVia];
    const where = `
      FROM public.orders AS sale
      LEFT JOIN public.store_orders AS store_sale ON store_sale.order_id = sale.id
      WHERE ($1::uuid IS NULL OR sale.store_id = $1::uuid)
        AND (
          $2::text[] IS NULL
          OR (
            CASE
              WHEN NULLIF(store_sale.status, '') IS NOT NULL THEN lower(store_sale.status)
              WHEN upper(sale.order_status) = 'CANCELLED' THEN 'cancelled'
              WHEN upper(sale.order_status) = 'COMPLETED' THEN 'completed'
              WHEN upper(sale.order_status) = 'REFUNDED' THEN 'refunded'
              ELSE 'processing'
            END
          ) = ANY($2::text[])
        )
        AND (
          $3::text IS NULL
          OR lower(COALESCE(
            NULLIF(sale.request_payload->>'created_via', ''),
            NULLIF((
              SELECT entry->>'value'
              FROM jsonb_array_elements(COALESCE(sale.metadata, '[]'::jsonb)) AS entry
              WHERE entry->>'key' IN ('order_created_via', 'created_via')
              LIMIT 1
            ), ''),
            'rest-api'
          )) = $3
        )
    `;
    let countRows: Array<{ total?: number }>;
    let idRows: Array<{ id: string }>;
    try {
      countRows = await this.dataSource.query(`SELECT COUNT(*)::int AS total ${where}`, params);
      idRows = await this.dataSource.query(
        `SELECT sale.id ${where} ORDER BY sale.created_at DESC LIMIT $4 OFFSET $5`,
        [...params, criteria.perPage, (criteria.page - 1) * criteria.perPage],
      );
    } catch (error: unknown) {
      if (error instanceof QueryFailedError && (error as { driverError?: { code?: string } }).driverError?.code === '22P02') {
        throw new BadRequestException('storeId must be a UUID');
      }
      throw error;
    }
    const total = Number(countRows[0]?.total || 0);
    const ids = idRows.map((row) => row.id);
    if (!ids.length) return { total, orders: [] };
    const orders = await this.orderRepo.find({ where: { id: In(ids) } });
    const storeOrders = this.storeOrderRepo
      ? await this.storeOrderRepo.find({ where: { orderId: In(ids) } })
      : [];
    const items = this.itemRepo
      ? await this.itemRepo.find({ where: { orderId: In(ids) } })
      : [];
    const ordersById = new Map(orders.map((order) => [order.id, order]));
    const storeOrdersById = new Map(storeOrders.map((storeOrder) => [storeOrder.orderId, storeOrder]));
    const rows = ids.flatMap((id) => {
      const order = ordersById.get(id);
      if (!order) return [];
      return [{
        order,
        storeOrder: storeOrdersById.get(id) ?? null,
        items: items.filter((item) => item.orderId === id),
      }];
    });
    await this.enrichCustomItemTaxesForListing(rows);
    const products = await this.catalogProducts(rows);
    return { total, orders: rows.map((row) => ({ ...row, products })) };
  }

  /**
   * Older/external POS orders can persist custom lines without WooCommerce tax
   * fields. Enrich only the total-orders read model from the line's category;
   * never rewrite the historical order or alter catalog-product taxation.
   */
  private async enrichCustomItemTaxesForListing(
    rows: Array<{ order: OrderEntity; storeOrder: StoreOrderEntity | null; items: OrderItemEntity[] }>,
  ): Promise<void> {
    if (!this.dataSource) return;
    const storeIds = [...new Set(rows.map((row) => row.order.storeId).filter(Boolean))];
    if (!storeIds.length) return;

    const categories: Array<{
      store_id?: string;
      id?: string;
      wordpress_id?: string;
      slug?: string;
      name?: string;
      rate?: string;
    }> = await this.dataSource.query(
      `SELECT COALESCE(to_jsonb(category)->>'storeId', to_jsonb(category)->>'store_id') AS store_id,
              COALESCE(to_jsonb(category)->>'id', '') AS id,
              COALESCE(to_jsonb(category)->>'wordpressId', to_jsonb(category)->>'wordpress_id', '') AS wordpress_id,
              COALESCE(to_jsonb(category)->>'slug', '') AS slug,
              COALESCE(to_jsonb(category)->>'name', '') AS name,
              COALESCE(to_jsonb(category)->>'posTaxPercent', to_jsonb(category)->>'pos_tax_percent') AS rate
         FROM public.categories AS category
        WHERE COALESCE(to_jsonb(category)->>'storeId', to_jsonb(category)->>'store_id') = ANY($1::text[])`,
      [storeIds],
    );
    const rates = new Map<string, number>();
    categories.forEach((category) => {
      const rate = Number(category.rate);
      if (!category.store_id || !Number.isFinite(rate)) return;
      [category.id, category.wordpress_id, category.slug, category.name]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
        .forEach((key) => rates.set(`${category.store_id}:${key}`, rate));
    });

    rows.forEach(({ order, storeOrder }) => {
      if (!storeOrder || !Array.isArray(storeOrder.lineItems)) return;
      let enriched = false;
      let addedLineSubtotal = 0;
      let addedLineTotal = 0;
      const taxDeltaByRate = new Map<number, number>();
      storeOrder.lineItems.forEach((rawLine) => {
        const line = rawLine as any;
        if (String(line?.type || '').trim().toLowerCase() !== 'custom') return;
        const previousSubtotal = Number(line.subtotal ?? line.total ?? 0);
        const previousTotal = Number(line.total ?? line.subtotal ?? 0);
        const existingTax = Number(line?.total_tax ?? 0);
        this.normalizeCustomItemQuantity(line, 2);

        const categoryReference = line.category_id
          ?? line.categoryId
          ?? line.category?.id
          ?? line.categories?.[0]?.id
          ?? line.category_slug
          ?? line.categorySlug
          ?? line.category?.slug
          ?? line.category_name
          ?? line.categoryName
          ?? line.category?.name
          ?? line.tax_class
          ?? 'custom-product';
        const categoryKey = String(categoryReference).trim().toLowerCase();
        const rate = rates.get(`${order.storeId}:${categoryKey}`)
          ?? rates.get(`${order.storeId}:custom-product`);
        if (rate === undefined) return;

        const subtotal = Number(line.subtotal ?? line.total ?? 0);
        const total = Number(line.total ?? line.subtotal ?? 0);
        if (!Number.isFinite(subtotal) || !Number.isFinite(total)) return;
        const subtotalTax = Math.round(subtotal * rate) / 100;
        const totalTax = Math.round(total * rate) / 100;
        line.subtotal_tax = subtotalTax.toFixed(2);
        line.total_tax = totalTax.toFixed(2);
        line.taxes = [{ id: rate, total: line.total_tax, subtotal: line.subtotal_tax }];
        addedLineSubtotal += subtotal - (Number.isFinite(previousSubtotal) ? previousSubtotal : 0);
        addedLineTotal += total - (Number.isFinite(previousTotal) ? previousTotal : 0);
        taxDeltaByRate.set(
          rate,
          (taxDeltaByRate.get(rate) || 0) + totalTax - (Number.isFinite(existingTax) ? existingTax : 0),
        );
        enriched = true;
      });
      if (!enriched) return;
      const existingTaxLines = Array.isArray(storeOrder.taxLines)
        ? storeOrder.taxLines.map((line) => ({ ...(line as Record<string, unknown>) }))
        : [];
      taxDeltaByRate.forEach((amount, rate) => {
        const matchingLine = existingTaxLines.find(
          (line) => Number(line.rate_percent) === rate,
        );
        if (matchingLine) {
          const currentAmount = Number(matchingLine.tax_total ?? 0);
          matchingLine.tax_total = ((Number.isFinite(currentAmount) ? currentAmount : 0) + amount).toFixed(2);
          return;
        }
        const id = existingTaxLines.length + 1;
        existingTaxLines.push({
          id,
          rate_code: `POS-TAX-${id}`,
          rate_id: id,
          label: 'Tax',
          compound: false,
          tax_total: amount.toFixed(2),
          shipping_tax_total: '0.00',
          rate_percent: rate,
          meta_data: [],
        });
      });
      const storedTaxTotal = Number(storeOrder.taxTotal ?? 0);
      const addedTaxTotal = [...taxDeltaByRate.values()].reduce((sum, amount) => sum + amount, 0);
      storeOrder.taxTotal = (Number.isFinite(storedTaxTotal) ? storedTaxTotal : 0) + addedTaxTotal;
      const storedSubtotal = Number(storeOrder.subtotal ?? 0);
      storeOrder.subtotal = (Number.isFinite(storedSubtotal) ? storedSubtotal : 0) + addedLineSubtotal;
      const storedOrderTotal = Number(storeOrder.total ?? 0);
      storeOrder.total = (Number.isFinite(storedOrderTotal) ? storedOrderTotal : 0) + addedLineTotal + addedTaxTotal;
      storeOrder.taxLines = existingTaxLines;
    });
  }

  private normalizeCustomItemQuantity(
    line: any,
    places: number,
  ): { applied: boolean; quantity: number } {
    if (String(line?.type || '').trim().toLowerCase() !== 'custom') {
      return { applied: false, quantity: 1 };
    }
    const quantity = Number(line.quantity || 1);
    if (!Number.isFinite(quantity) || quantity <= 1 || line._pch_quantity_applied === true) {
      return { applied: false, quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1 };
    }
    // Persist WooCommerce-compatible line totals while retaining the original unit
    // price and a marker that prevents total-orders from multiplying them again.
    const unitSubtotal = Number(line.subtotal ?? line.total ?? line.unit_price ?? line.unitPrice ?? 0);
    const unitTotal = Number(line.total ?? line.subtotal ?? line.unit_price ?? line.unitPrice ?? 0);
    if (!Number.isFinite(unitSubtotal) || !Number.isFinite(unitTotal)) {
      return { applied: false, quantity };
    }
    line.unit_price = Number(line.unit_price ?? line.unitPrice ?? unitSubtotal).toFixed(places);
    line.subtotal = (unitSubtotal * quantity).toFixed(places);
    line.total = (unitTotal * quantity).toFixed(places);
    line._pch_quantity_applied = true;
    return { applied: true, quantity };
  }

  private async catalogProducts(
    rows: Array<{ order: OrderEntity; storeOrder: StoreOrderEntity | null; items: OrderItemEntity[] }>,
  ): Promise<Map<string, unknown>> {
    const products = new Map<string, unknown>();
    if (!this.dataSource) return products;
    const idsByStore = new Map<string, Set<string>>();
    rows.forEach((row) => {
      const ids = idsByStore.get(row.order.storeId) ?? new Set<string>();
      const lines = Array.isArray(row.storeOrder?.lineItems) && row.storeOrder.lineItems.length
        ? row.storeOrder.lineItems
        : row.items;
      lines.forEach((line) => {
        const record = line as { product_id?: unknown; productId?: unknown };
        const productId = String(record?.product_id ?? record?.productId ?? '').trim();
        if (productId) ids.add(productId);
      });
      if (ids.size) idsByStore.set(row.order.storeId, ids);
    });
    for (const [storeId, ids] of idsByStore) {
      let found: Array<{ id?: string; product?: unknown }> = [];
      try {
        found = await this.dataSource.query(
          `SELECT product->>'id' AS id, product
           FROM public.store_products AS catalog
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(catalog.payload) = 'array' THEN catalog.payload
               WHEN jsonb_typeof(catalog.payload->'products') = 'array' THEN catalog.payload->'products'
               ELSE '[]'::jsonb
             END
           ) AS product
           WHERE catalog.store_id = $1::uuid
             AND COALESCE(catalog.is_deleted, false) = false
             AND product->>'id' = ANY($2::text[])`,
          [storeId, [...ids]],
        );
      } catch (error: unknown) {
        const code = error && typeof error === 'object'
          ? (error as { driverError?: { code?: string } }).driverError?.code
          : undefined;
        if (code === '42P01' || code === '42703' || code === '22P02') continue;
        throw error;
      }
      found.forEach((row) => {
        if (row.id && row.product) products.set(`${storeId}:${row.id}`, row.product);
      });
    }
    return products;
  }

  async findStoreCoupon(storeId: string, code: string): Promise<Record<string, unknown> | null> {
    const normalized = String(code || '').trim();
    if (!this.dataSource || !normalized) return null;
    try {
      const rows = await this.dataSource.query(
        `SELECT code, amount, discount_type, date_expires, individual_use,
                product_ids, excluded_product_ids, usage_limit, usage_count,
                usage_limit_per_user, minimum_amount, maximum_amount,
                email_restrictions, used_by, exclude_sale_items
         FROM public.store_coupons
         WHERE store_id = $1::uuid
           AND lower(code) = lower($2)
           AND deleted_at IS NULL
           AND sync_status <> 'DELETED'
         LIMIT 1`,
        [storeId, normalized],
      );
      return rows[0] ?? null;
    } catch (error: unknown) {
      const postgresCode = error instanceof QueryFailedError
        ? (error as { driverError?: { code?: string } }).driverError?.code
        : undefined;
      if (postgresCode === '42P01' || postgresCode === '42703') return null;
      if (postgresCode === '22P02') throw new BadRequestException('storeId must be a UUID');
      throw error;
    }
  }

  async getOrderDetails(id: string, storeId?: string) {
    const key = String(id || '').trim();
    if (!key) return null;
    if (!this.isDbConnected || !this.orderRepo || !this.itemRepo) {
      throw new ServiceUnavailableException('Order database is unavailable');
    }
    const scopedStore = storeId?.trim() || undefined;
    if (this.isUuid(key)) {
      const byId = await this.getOrderById(key);
      if (byId && (!scopedStore || byId.order.storeId === scopedStore)) {
        return { order: byId.order, items: byId.items, storeOrder: byId.storeOrder };
      }
    }
    let matches: OrderEntity[] = [];
    try {
      matches = await this.orderRepo.find({
        where: scopedStore
          ? { clientOrderId: key, storeId: scopedStore }
          : { clientOrderId: key },
        order: { createdAt: 'DESC' },
        take: 1,
      });
    } catch (error: unknown) {
      if (error instanceof QueryFailedError && (error as { driverError?: { code?: string } }).driverError?.code === '22P02') {
        throw new BadRequestException('storeId must be a UUID');
      }
      throw error;
    }
    const match = matches[0];
    if (!match) return null;
    const graph = await this.getOrderById(match.id);
    if (!graph) return null;
    return { order: graph.order, items: graph.items, storeOrder: graph.storeOrder };
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  async getOrdersByStore(storeId: string): Promise<OrderEntity[]> {
    if (this.isDbConnected && this.orderRepo) {
      return this.orderRepo.find({ where: { storeId }, order: { createdAt: 'DESC' } });
    }
    return this.inMemoryOrders.filter(o => o.storeId === storeId);
  }

  async getStorePosPayments(storeId: string) {
    if (!this.isDbConnected || !this.dataSource) {
      throw new ServiceUnavailableException('Order database is unavailable');
    }

    try {
      return await this.dataSource.query(
        `SELECT
         payment.id,
         payment.order_id,
         order_record.order_number,
         payment.merchant_id,
         payment.store_id,
         payment.local_id,
         payment.client_order_id,
         payment.device_id,
         payment.shift_id,
         COALESCE(
           payment.user_id,
           store_sale.placed_by,
           payment.metadata->>'pos_placed_by',
           (
             SELECT item->>'value'
             FROM jsonb_array_elements(COALESCE(store_sale.meta_data, '[]'::jsonb)) AS item
             WHERE item->>'key' = 'pos_placed_by'
             LIMIT 1
           )
         ) AS user_id,
         payment.payment_type,
         payment.payment_method,
         COALESCE(payment.payment_method_title, store_sale.payment_method_title) AS payment_method_title,
         payment.amount,
         payment.order_total,
         payment.remaining,
         payment.currency,
         payment.status,
         payment.entry_type,
         payment.provider,
         payment.provider_transaction_id,
         payment.payment_at
       FROM public.store_pos_payments AS payment
       LEFT JOIN public.orders AS order_record ON order_record.id = payment.order_id
       LEFT JOIN public.store_orders AS store_sale ON store_sale.order_id = payment.order_id
       WHERE payment.store_id = $1::uuid
         AND payment.deleted_at IS NULL
       ORDER BY payment.payment_at DESC, payment.created_at DESC`,
        [storeId],
      );
    } catch (error) {
      console.error('[Order Service] Failed to list store POS payments', {
        storeId,
        error,
      });
      throw error;
    }
  }

  async getOrderById(orderId: string): Promise<{ order: OrderEntity; items: OrderItemEntity[]; history: OrderStatusHistoryEntity[]; storeOrder: StoreOrderEntity | null } | null> {
    if (this.isDbConnected && this.orderRepo && this.itemRepo && this.historyRepo) {
      const order = await this.orderRepo.findOne({ where: { id: orderId } });
      if (!order) return null;
      const items = await this.itemRepo.find({ where: { orderId } });
      const history = await this.historyRepo.find({ where: { orderId }, order: { createdAt: 'ASC' } });
      const storeOrder = await this.findStoreOrder(orderId);
      return { order, items, history, storeOrder };
    } else {
      const order = this.inMemoryOrders.find(o => o.id === orderId);
      if (!order) return null;
      const items = this.inMemoryItems.filter(i => i.orderId === orderId);
      const history = this.inMemoryHistory.filter(h => h.orderId === orderId);
      return { order, items, history, storeOrder: null };
    }
  }

  private async recordStatusChange(orderId: string, fromStatus: string, toStatus: string, changedBy: string, reason?: string) {
    const entry: OrderStatusHistoryEntity = {
      id: `HST-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      orderId,
      fromStatus,
      toStatus,
      changedBy: changedBy || 'POS System',
      reason: reason || 'State Machine Transition',
      createdAt: new Date(),
    };
    if (this.isDbConnected && this.historyRepo) {
      await this.historyRepo.save(this.historyRepo.create(entry));
    } else {
      this.inMemoryHistory.push(entry);
    }
  }

  private async cacheOrder(order: OrderEntity) {
    if (this.isRedisConnected && this.redisClient) {
      try {
        await this.redisClient.set(`order:${order.id}`, JSON.stringify(order), 'EX', 86400);
      } catch {}
    }
  }
}
