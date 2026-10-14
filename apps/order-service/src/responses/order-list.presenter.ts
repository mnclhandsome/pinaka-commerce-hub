import { BadRequestException, Injectable } from '@nestjs/common';
import type { OrderEntity } from '../entities/order.entity';
import { PaymentStatus } from '../entities/order.entity';
import type { OrderItemEntity } from '../entities/order-item.entity';
import type { StoreOrderEntity } from '../entities/store-order.entity';

export interface OrderListRequest {
  page?: string;
  perPage?: string;
  status?: string;
  createdVia?: string;
  storeId?: string;
}

@Injectable()
export class OrderListPresenter {
  criteria(request: OrderListRequest) {
    const page = this.pageNumber(request.page, 1, 'page');
    const perPage = this.pageNumber(request.perPage, 10, 'per_page');
    if (perPage > 100) throw new BadRequestException('per_page cannot be greater than 100');
    return {
      storeId: request.storeId?.trim() || undefined,
      page,
      perPage,
      statuses: this.statuses(request.status),
      createdVia: request.createdVia?.trim() || undefined,
    };
  }

  present(
    page: number,
    perPage: number,
    total: number,
    rows: Array<{
      order: OrderEntity;
      storeOrder: StoreOrderEntity | null;
      items: OrderItemEntity[];
      products: Map<string, unknown>;
    }>,
  ) {
    return {
      order_total_count: total,
      page,
      per_page: perPage,
      orders_data: rows.map((row) => this.orderRow(row)),
    };
  }

  private orderRow(row: {
    order: OrderEntity;
    storeOrder: StoreOrderEntity | null;
    items: OrderItemEntity[];
    products: Map<string, unknown>;
  }) {
    const { order, storeOrder } = row;
    const request = (order.requestPayload || {}) as Record<string, unknown>;
    const timeZone = storeOrder?.timezone || 'UTC';
    const currency = String(storeOrder?.currency || request.currency || 'USD').toUpperCase();
    const status = this.displayStatus(storeOrder?.status || this.statusFromOrder(order));
    const paid = order.paymentStatus === PaymentStatus.PAID || Boolean(storeOrder?.setPaid) || Boolean(request.date_paid);
    const paidAt = this.paidStamp(request, order.createdAt, timeZone, paid);
    const orderNumber = Number(String(order.orderNumber || '').replace(/\D/g, ''));
    const total = this.money(storeOrder?.total ?? order.totalAmount);
    const totalNumber = Number(total);
    const lineItems = this.lineItems(storeOrder?.lineItems, row.items, order.storeId, row.products);
    return {
      id: this.clientOrderId(order, storeOrder),
      woo_order_id: Number.isSafeInteger(orderNumber) && orderNumber > 0 ? orderNumber : null,
      status,
      date_created: this.listDate(order.createdAt, timeZone),
      date_modified: this.listDate(order.updatedAt, timeZone),
      total,
      discount_total: this.money(storeOrder?.discountTotal ?? order.discountAmount),
      discount_tax: this.taxText(request.discount_tax),
      total_tax: this.taxText(storeOrder?.taxTotal ?? request.total_tax ?? order.taxAmount),
      created_via: String(request.created_via || this.metaValue(order, 'order_created_via') || 'rest-api'),
      author: String(storeOrder?.placedBy || this.metaValue(order, 'pos_placed_by') || ''),
      currency,
      currency_symbol: this.currencySymbol(currency),
      date_completed: request.date_completed
        ? String(request.date_completed)
        : (status === 'Completed' ? paidAt : null),
      date_paid: request.date_paid ? String(request.date_paid) : paidAt,
      coupon_lines: Array.isArray(storeOrder?.couponLines) ? storeOrder.couponLines : [],
      line_items: lineItems,
      fee_lines: Array.isArray(storeOrder?.feeLines) ? storeOrder.feeLines : [],
      tax_lines: Array.isArray(storeOrder?.taxLines) ? storeOrder.taxLines : [],
      refund_order_total: totalNumber,
      refund_total: 0,
      net_payment: totalNumber,
    };
  }

  private lineItems(
    stored: unknown[] | undefined,
    items: OrderItemEntity[],
    storeId: string,
    products: Map<string, unknown>,
  ) {
    const lines = Array.isArray(stored) && stored.length
      ? stored
      : items.map((item) => ({
          id: item.id,
          name: item.productName,
          product_id: item.productId,
          quantity: item.quantity,
          subtotal: item.totalPrice,
          total: item.totalPrice,
          meta_data: item.modifiers || [],
        }));
    return lines.map((line, index) => this.lineItem(line, items[index], storeId, products));
  }

  private lineItem(
    line: any,
    fallback: OrderItemEntity | undefined,
    storeId: string,
    products: Map<string, unknown>,
  ) {
    const productId = Number(line?.product_id ?? line?.productId ?? fallback?.productId);
    const productKey = String(line?.product_id ?? line?.productId ?? fallback?.productId ?? '');
    return {
      id: line?.id ?? fallback?.id ?? null,
      name: String(line?.name ?? line?.productName ?? fallback?.productName ?? ''),
      product_id: Number.isSafeInteger(productId) ? productId : (line?.product_id ?? line?.productId ?? fallback?.productId ?? null),
      variation_id: Number(line?.variation_id || 0),
      quantity: Number(line?.quantity ?? fallback?.quantity ?? 0),
      tax_class: String(line?.tax_class || ''),
      subtotal: line?.subtotal !== undefined ? String(line.subtotal) : this.money(fallback?.totalPrice),
      subtotal_tax: line?.subtotal_tax !== undefined ? String(line.subtotal_tax) : '0',
      total: line?.total !== undefined ? String(line.total) : this.money(fallback?.totalPrice),
      total_tax: line?.total_tax !== undefined ? String(line.total_tax) : '0',
      taxes: line?.taxes ?? [],
      meta_data: Array.isArray(line?.meta_data)
        ? line.meta_data
        : (Array.isArray(fallback?.modifiers) ? fallback.modifiers : []),
      is_refund_item: Boolean(line?.is_refund_item),
      product_data: line?.product_data ?? products.get(`${storeId}:${productKey}`) ?? null,
    };
  }

  private statuses(value?: string): string[] {
    if (!value?.trim()) return [];
    return value.split(',').map((status) => {
      const normalized = status.trim().toLowerCase().replace(/\s+/g, '-');
      return normalized === 'canceled' ? 'cancelled' : normalized;
    }).filter(Boolean);
  }

  private pageNumber(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException(`${name} must be a whole number greater than 0`);
    }
    return parsed;
  }

  private statusFromOrder(order: OrderEntity): string {
    switch (String(order.orderStatus).toUpperCase()) {
      case 'CANCELLED':
        return 'cancelled';
      case 'COMPLETED':
        return 'completed';
      case 'REFUNDED':
        return 'refunded';
      default:
        return 'processing';
    }
  }

  private displayStatus(status: string): string {
    const normalized = status.trim().toLowerCase();
    switch (normalized) {
      case 'on-hold':
      case 'onhold':
        return 'On-hold';
      case 'cancelled':
        return 'Cancelled';
      default:
        return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Processing';
    }
  }

  private clientOrderId(order: OrderEntity, storeOrder: StoreOrderEntity | null): string | number | null {
    const request = (order.requestPayload || {}) as { meta_data?: Array<{ key?: string; value?: unknown }> };
    const fromPayload = Array.isArray(request.meta_data)
      ? request.meta_data.find((entry) => entry?.key === '_pos_client_order_id')?.value
      : undefined;
    const raw = storeOrder?.clientOrderId || order.clientOrderId || this.metaValue(order, '_pos_client_order_id') || fromPayload;
    const value = String(raw ?? '').trim();
    if (!value) return null;
    if (/^\d+$/.test(value) && !value.startsWith('0') && Number.isSafeInteger(Number(value))) {
      return Number(value);
    }
    return value;
  }

  private metaValue(order: OrderEntity, key: string): string {
    const metadata = Array.isArray(order.metadata) ? order.metadata : [];
    const value = metadata.find((entry) => entry?.key === key)?.value;
    return value === undefined || value === null ? '' : String(value);
  }

  private paidStamp(request: Record<string, unknown>, createdAt: Date, timeZone: string, paid: boolean): string | null {
    if (!paid) return null;
    if (request.date_paid) return String(request.date_paid);
    return `${this.listDate(createdAt, timeZone).replace(' ', 'T')}.000000`;
  }

  private money(value: unknown): string {
    return Number(value || 0).toFixed(2);
  }

  private taxText(value: unknown): string {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount) || amount === 0) return '0';
    return amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  private currencySymbol(currency: string): string {
    switch (currency.toUpperCase()) {
      case 'EUR':
        return '€';
      case 'GBP':
        return '£';
      case 'INR':
        return '₹';
      default:
        return '$';
    }
  }

  private listDate(value: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(value));
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value || '00';
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
  }
}
