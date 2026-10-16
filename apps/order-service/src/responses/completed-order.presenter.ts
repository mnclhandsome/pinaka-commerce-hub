import { BadRequestException, Injectable } from '@nestjs/common';
import type { OrderEntity } from '../entities/order.entity';
import type { OrderItemEntity } from '../entities/order-item.entity';
import type { StoreOrderEntity } from '../entities/store-order.entity';

export interface CompletedOrderListRequest {
  page?: string;
  perPage?: string;
  author?: string;
  after?: string;
  before?: string;
  createdVia?: string;
  merchantId?: string;
  storeId?: string;
}

type CompletedOrderRow = {
  order: OrderEntity;
  storeOrder: StoreOrderEntity | null;
  items: OrderItemEntity[];
  products: Map<string, unknown>;
};

@Injectable()
export class CompletedOrderPresenter {
  criteria(request: CompletedOrderListRequest) {
    const merchantId = request.merchantId?.trim();
    const storeId = request.storeId?.trim();
    if (!merchantId) throw new BadRequestException('x-merchant-id header is required');
    if (!storeId) throw new BadRequestException('x-store-id header is required');
    const page = this.positiveInteger(request.page, 1, 'page');
    const perPage = this.positiveInteger(request.perPage, 100, 'per_page');
    if (perPage > 100) throw new BadRequestException('per_page cannot be greater than 100');
    const after = this.dateBoundary(request.after, false, 'after');
    const before = this.dateBoundary(request.before, true, 'before');
    if (after && before && after > before) {
      throw new BadRequestException('after must be earlier than or equal to before');
    }
    return {
      page,
      perPage,
      merchantId,
      storeId,
      statuses: ['completed'],
      createdVia: request.createdVia?.trim() || undefined,
      author: request.author?.trim() || undefined,
      after,
      before,
      orderBy: 'modified' as const,
    };
  }

  present(page: number, perPage: number, total: number, rows: CompletedOrderRow[]) {
    return {
      order_total_count: total,
      page,
      per_page: perPage,
      orders_data: rows.map((row) => this.order(row)),
    };
  }

  private order({ order, storeOrder, items, products }: CompletedOrderRow) {
    const request = (order.requestPayload || {}) as Record<string, any>;
    const timezone = storeOrder?.timezone || 'UTC';
    const currency = String(storeOrder?.currency || request.currency || 'USD').toUpperCase();
    const payments = Array.isArray(storeOrder?.payments)
      ? storeOrder.payments
      : (Array.isArray(request.payments) ? request.payments : []);
    const id = this.orderId(order);
    const clientOrderId = this.clientOrderId(order, storeOrder) ?? id;
    const total = this.money(storeOrder?.total ?? order.totalAmount);
    const itemsTax = this.decimal(storeOrder?.taxTotal ?? request.total_tax ?? order.taxAmount);
    const orderDiscount = Number(this.metaValue(order, '_order_discount') || 0);
    const amount = this.money(Math.max(0, Number(total) - Number(itemsTax) - orderDiscount));
    const createdVia = String(request.created_via || this.metaValue(order, 'order_created_via') || 'rest-api');
    const lineItems = this.lineItems(storeOrder?.lineItems, items, order.storeId, products);
    return {
      id,
      order_id: clientOrderId,
      status: 'completed',
      date: this.localDate(order.createdAt, timezone),
      date_modified: this.localDate(order.updatedAt, timezone),
      currency,
      amount,
      items_tax: itemsTax,
      total,
      transaction_id: payments.map((payment: any) => payment?.transaction_id ?? payment?.payment_id ?? payment?.id)
        .filter((value: unknown) => value !== undefined && value !== null && value !== '').join(','),
      payment_method: String(storeOrder?.paymentMethod || request.payment_method || order.paymentMethod || '').toLowerCase(),
      discount: Number(storeOrder?.discountTotal ?? order.discountAmount ?? 0) || 0,
      order_type: String(request.order_type || this.metaValue(order, '_order_type') || (createdVia === 'rest-api' ? 'Shop Order' : createdVia)),
      author: String(storeOrder?.placedBy || this.metaValue(order, '_wc_order_created_by') || this.metaValue(order, 'pos_placed_by') || request.author || ''),
      currency_symbol: String(request.currency_symbol || this.currencySymbol(currency)),
      date_completed: request.date_completed || this.isoDate(order.updatedAt),
      date_paid: request.date_paid || this.isoDate(order.createdAt),
      number: String(id),
      coupon_lines: Array.isArray(storeOrder?.couponLines) ? storeOrder.couponLines : (request.coupon_lines || []),
      line_items: lineItems,
      fee_lines: Array.isArray(storeOrder?.feeLines) ? storeOrder.feeLines : (request.fee_lines || []),
      payments,
    };
  }

  private lineItems(stored: unknown[] | undefined, items: OrderItemEntity[], storeId: string, products: Map<string, unknown>) {
    const lines: any[] = Array.isArray(stored) && stored.length ? stored : items.map((item) => ({
      id: item.id,
      name: item.productName,
      product_id: item.productId,
      quantity: item.quantity,
      subtotal: item.totalPrice,
      total: item.totalPrice,
      meta_data: item.modifiers || [],
    }));
    return lines.filter((line) => !line?.is_refund_item).map((line, index) => {
      const fallback = items[index];
      const productKey = String(line?.product_id ?? line?.productId ?? fallback?.productId ?? '');
      const product = (line?.product_data ?? products.get(`${storeId}:${productKey}`) ?? {}) as Record<string, any>;
      const discountType = String(this.lineMeta(line, '_pos_discount_type') || '');
      return {
        id: line?.id ?? fallback?.id ?? null,
        name: String(line?.name ?? line?.productName ?? fallback?.productName ?? ''),
        product_id: this.numericId(line?.product_id ?? line?.productId ?? fallback?.productId),
        variation_id: Number(line?.variation_id || 0),
        quantity: Number(line?.quantity ?? fallback?.quantity ?? 0),
        tax_class: String(line?.tax_class || ''),
        subtotal: String(line?.subtotal ?? fallback?.totalPrice ?? '0'),
        subtotal_tax: String(line?.subtotal_tax ?? '0'),
        total: String(line?.total ?? fallback?.totalPrice ?? '0'),
        is_items_has_discount: discountType ? 'Yes' : 'No',
        item_discount_type: this.discountLabel(discountType),
        total_tax: String(line?.total_tax ?? '0'),
        taxes: line?.taxes ?? { total: {}, subtotal: {} },
        image: line?.image ?? { id: product.image?.id ?? product.image_id ?? null, src: product.image?.src ?? product.image_url ?? '' },
        meta_data: Array.isArray(line?.meta_data) ? line.meta_data : (fallback?.modifiers || []),
      };
    });
  }

  private positiveInteger(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new BadRequestException(`${name} must be a whole number greater than 0`);
    return parsed;
  }

  private dateBoundary(value: string | undefined, endOfDay: boolean, name: string): Date | undefined {
    if (!value?.trim()) return undefined;
    const input = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
      : value;
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${name} must be a valid date or ISO-8601 timestamp`);
    return parsed;
  }

  private orderId(order: OrderEntity): string | number {
    const digits = String(order.orderNumber || '').replace(/\D/g, '');
    return digits && Number.isSafeInteger(Number(digits)) ? Number(digits) : order.id;
  }

  private clientOrderId(order: OrderEntity, storeOrder: StoreOrderEntity | null): string | number | null {
    const value = String(storeOrder?.clientOrderId || order.clientOrderId || this.metaValue(order, '_pos_client_order_id') || '').trim();
    if (!value) return null;
    return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value;
  }

  private metaValue(order: OrderEntity, key: string): unknown {
    return (Array.isArray(order.metadata) ? order.metadata : []).find((entry) => entry?.key === key)?.value;
  }

  private lineMeta(line: any, key: string): unknown {
    return (Array.isArray(line?.meta_data) ? line.meta_data : []).find((entry: any) => entry?.key === key)?.value;
  }

  private discountLabel(type: string): string {
    return ({ auto: 'Auto Discount', multipack: 'Multipack Discount', mixmatch: 'Combo Discount' } as Record<string, string>)[type] || '';
  }

  private numericId(value: unknown): string | number | null {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : String(value);
  }

  private money(value: unknown): string { return Number(value || 0).toFixed(2); }
  private decimal(value: unknown): string { return String(value ?? '0'); }
  private isoDate(value: Date): string { return new Date(value).toISOString(); }

  private currencySymbol(currency: string): string {
    return ({ EUR: '€', GBP: '£', INR: '₹', USD: '$' } as Record<string, string>)[currency] || '$';
  }

  private localDate(value: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(value));
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value || '00';
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
  }
}
