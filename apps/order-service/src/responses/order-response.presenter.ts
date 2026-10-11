import { Injectable } from '@nestjs/common';
import { PaymentStatus } from '../entities/order.entity';

export type OrderResponseProfile = 'woocommerce' | 'pch';

export interface OrderResponseContext {
  result: {
    order: any;
    items: any[];
    storeOrder?: { id?: string; currency?: string; timezone?: string } | null;
    duplicate: boolean;
  };
  request: any;
}

@Injectable()
export class OrderResponsePresenter {
  profileFor(request: any): OrderResponseProfile {
    const metadata = Array.isArray(request?.meta_data) ? request.meta_data : [];
    const createdVia = String(
      metadata.find((entry: any) => entry?.key === 'order_created_via')?.value
      || request?.created_via
      || '',
    );
    switch (createdVia) {
      case 'pinaka_pos':
      case 'rest-api':
      case 'pch-rest-api':
        return 'woocommerce';
      default:
        return Array.isArray(request?.line_items) ? 'woocommerce' : 'pch';
    }
  }

  present(profile: OrderResponseProfile, context: OrderResponseContext) {
    switch (profile) {
      case 'woocommerce':
        return this.toWooCommerce(context);
      case 'pch':
        return this.toPch(context);
      default:
        return this.toPch(context);
    }
  }

  private toPch(context: OrderResponseContext) {
    const { result } = context;
    return {
      success: true,
      message: result.duplicate
        ? `Order ${result.order.orderNumber} was already synced.`
        : `Order ${result.order.orderNumber} created successfully!`,
      duplicate: result.duplicate,
      storeOrderId: result.storeOrder?.id ?? null,
      orderId: result.order.id,
      orderNumber: result.order.orderNumber,
      order: result.order,
      items: result.items,
    };
  }

  private toWooCommerce(context: OrderResponseContext) {
    const { result, request } = context;
    const { order, items } = result;
    const createdAt = new Date(order.createdAt);
    const updatedAt = new Date(order.updatedAt);
    const timeZone = result.storeOrder?.timezone || 'UTC';
    const currency = String(request.currency || result.storeOrder?.currency || 'USD');
    const status = String(request.status || order.orderStatus || '').toLowerCase();
    const paid = order.paymentStatus === PaymentStatus.PAID || Boolean(request.date_paid);
    const localCreated = request.date_created || this.formatWooDate(createdAt, timeZone);
    const localModified = request.date_modified || this.formatWooDate(updatedAt, timeZone);
    const gmtCreated = request.date_created_gmt || this.formatWooDate(createdAt, 'UTC');
    const gmtModified = request.date_modified_gmt || this.formatWooDate(updatedAt, 'UTC');
    const completedAt = this.completedAt(status, request.date_completed, localCreated);
    const paidAt = this.paidAt(paid, request.date_paid, localCreated);
    const lineItems = this.lineItems(items, request.line_items);
    const basePath = `/api/v1/orders/${order.id}`;

    return {
      id: order.id,
      parent_id: request.parent_id || 0,
      status,
      currency,
      version: request.version || '11.2.0',
      prices_include_tax: Boolean(request.prices_include_tax),
      date_created: localCreated,
      date_modified: localModified,
      discount_total: this.money(request.discount_total ?? order.discountAmount),
      discount_tax: this.money(request.discount_tax),
      shipping_total: this.money(request.shipping_total),
      shipping_tax: this.money(request.shipping_tax),
      cart_tax: this.money(request.cart_tax),
      total: this.money(request.total ?? order.totalAmount),
      total_tax: this.money(request.total_tax ?? order.taxAmount),
      customer_id: request.customer_id || 0,
      order_key: request.order_key || `wc_order_${order.id}`,
      billing: this.billing(request.billing),
      shipping: this.shipping(request.shipping),
      payment_method: request.payment_method || String(order.paymentMethod || 'cash').toLowerCase(),
      payment_method_title: request.payment_method_title || order.paymentMethod || '',
      transaction_id: request.transaction_id || '',
      customer_ip_address: request.customer_ip_address || '',
      customer_user_agent: request.customer_user_agent || '',
      created_via: request.created_via || 'rest-api',
      customer_note: request.customer_note || '',
      date_completed: completedAt,
      date_paid: paidAt,
      cart_hash: request.cart_hash || '',
      number: String(request.number || order.orderNumber || '').replace(/^#/, ''),
      meta_data: this.metaData(order.metadata),
      line_items: lineItems,
      tax_lines: this.taxLines(request.tax_lines),
      shipping_lines: Array.isArray(request.shipping_lines) ? request.shipping_lines : [],
      fee_lines: this.feeLines(request.fee_lines),
      coupon_lines: Array.isArray(request.coupon_lines) ? request.coupon_lines : [],
      refunds: Array.isArray(request.refunds) ? request.refunds : [],
      payment_url: request.payment_url || '',
      is_editable: this.isEditable(status),
      needs_payment: !paid,
      needs_processing: this.needsProcessing(status, lineItems),
      date_created_gmt: gmtCreated,
      date_modified_gmt: gmtModified,
      date_completed_gmt: completedAt ? (request.date_completed_gmt || this.formatWooDate(updatedAt, 'UTC')) : null,
      date_paid_gmt: paidAt ? (request.date_paid_gmt || gmtCreated) : null,
      currency_symbol: request.currency_symbol || this.currencySymbol(currency),
      duplicate: result.duplicate,
      store_order_id: result.storeOrder?.id ?? null,
      _links: {
        self: [{ href: basePath, targetHints: { allow: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] } }],
        collection: [{ href: '/api/v1/orders' }],
        email_templates: [{ embeddable: true, href: `${basePath}/actions/email_templates` }],
      },
    };
  }

  private completedAt(status: string, requested: unknown, fallback: string): string | null {
    switch (status) {
      case 'completed':
        return String(requested || fallback);
      default:
        return requested ? String(requested) : null;
    }
  }

  private paidAt(paid: boolean, requested: unknown, fallback: string): string | null {
    switch (paid) {
      case true:
        return String(requested || fallback);
      default:
        return requested ? String(requested) : null;
    }
  }

  private isEditable(status: string): boolean {
    switch (status) {
      case 'completed':
      case 'cancelled':
      case 'refunded':
      case 'failed':
        return false;
      default:
        return true;
    }
  }

  private needsProcessing(status: string, lineItems: any[]): boolean {
    switch (status) {
      case 'cancelled':
      case 'refunded':
      case 'failed':
        return false;
      default:
        return lineItems.some((item) => item?.product_data?.virtual !== true);
    }
  }

  private currencySymbol(currency: string): string {
    switch (currency.toUpperCase()) {
      case 'USD':
      case 'CAD':
      case 'AUD':
        return '$';
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

  private lineItems(items: any[], requested: any[] = []) {
    return items.map((item: any, index: number) => {
      const original = requested?.[index] || {};
      const numericProductId = Number(item.productId);
      const meta = Array.isArray(item.modifiers) ? item.modifiers : [];
      return {
        id: original.id ?? item.id,
        name: item.productName,
        product_id: Number.isSafeInteger(numericProductId) ? numericProductId : item.productId,
        variation_id: Number(original.variation_id || 0),
        quantity: Number(item.quantity),
        tax_class: original.tax_class || '',
        subtotal: this.money(original.subtotal ?? item.totalPrice),
        subtotal_tax: this.money(original.subtotal_tax),
        total: this.money(original.total ?? item.totalPrice),
        total_tax: this.money(original.total_tax),
        taxes: Array.isArray(original.taxes) ? original.taxes : [],
        meta_data: meta.map((entry: any, metaIndex: number) => ({
          id: entry.id ?? metaIndex + 1,
          key: entry.key,
          value: entry.value,
          display_key: entry.display_key ?? entry.key,
          display_value: entry.display_value ?? entry.value,
        })),
        sku: original.sku ?? '',
        global_unique_id: original.global_unique_id ?? '',
        price: Number(original.price ?? item.unitPrice),
        image: original.image || { id: '', src: '' },
        parent_name: original.parent_name ?? null,
        product_data: original.product_data ?? null,
      };
    });
  }

  private metaData(metadata: any[]) {
    const entries = Array.isArray(metadata) ? metadata : [];
    return entries.map((entry: any, index: number) => ({
      id: entry.id ?? index + 1,
      key: entry.key,
      value: entry.value,
    }));
  }

  private taxLines(lines: any[]) {
    if (!Array.isArray(lines)) return [];
    return lines.map((line) => ({
      id: line.id,
      rate_code: line.rate_code || '',
      rate_id: line.rate_id ?? 0,
      label: line.label || '',
      compound: Boolean(line.compound),
      tax_total: this.money(line.tax_total),
      shipping_tax_total: this.money(line.shipping_tax_total),
      rate_percent: Number(line.rate_percent || 0),
      meta_data: Array.isArray(line.meta_data) ? line.meta_data : [],
    }));
  }

  private feeLines(lines: any[]) {
    if (!Array.isArray(lines)) return [];
    return lines.map((line) => ({
      id: line.id,
      name: line.name || '',
      tax_class: line.tax_class || '',
      tax_status: line.tax_status || 'none',
      amount: line.amount ?? '',
      total: this.money(line.total),
      total_tax: this.money(line.total_tax),
      taxes: Array.isArray(line.taxes) ? line.taxes : [],
      meta_data: Array.isArray(line.meta_data) ? line.meta_data : [],
    }));
  }

  private billing(value: any = {}) {
    return {
      first_name: value.first_name || '',
      last_name: value.last_name || '',
      company: value.company || '',
      address_1: value.address_1 || '',
      address_2: value.address_2 || '',
      city: value.city || '',
      state: value.state || '',
      postcode: value.postcode || '',
      country: value.country || '',
      email: value.email || '',
      phone: value.phone || '',
    };
  }

  private shipping(value: any = {}) {
    return {
      first_name: value.first_name || '',
      last_name: value.last_name || '',
      company: value.company || '',
      address_1: value.address_1 || '',
      address_2: value.address_2 || '',
      city: value.city || '',
      state: value.state || '',
      postcode: value.postcode || '',
      country: value.country || '',
      phone: value.phone || '',
    };
  }

  private money(value: unknown): string {
    return Number(value || 0).toFixed(2);
  }

  private formatWooDate(value: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(value);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value || '00';
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
  }
}
