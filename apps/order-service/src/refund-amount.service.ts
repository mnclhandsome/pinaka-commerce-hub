import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { OrderRepository } from './order.repository';

export interface RefundAmountRequest {
  order_id?: unknown;
  refund_type?: unknown;
  items?: unknown;
}

@Injectable()
export class RefundAmountService {
  constructor(@Inject(OrderRepository) private readonly orders: OrderRepository) {}

  async calculate(body: RefundAmountRequest, merchantId: string, storeId: string) {
    const clientOrderId = String(body?.order_id ?? '').trim();
    if (!clientOrderId) throw this.error('invalid_order', 'Invalid order ID');
    const refundType = String(body?.refund_type || 'Full').trim().toLowerCase();
    if (!['full', 'partial'].includes(refundType)) {
      throw this.error('invalid_refund_type', 'Invalid Refund Type. valid Refund Types are [Full, Partial]');
    }
    const items = Array.isArray(body?.items) ? body.items as any[] : [];
    if (refundType === 'partial' && items.length === 0) {
      throw this.error('no_items', 'Please select items');
    }

    const context = await this.orders.getRefundAmountContext(clientOrderId, merchantId, storeId);
    if (!context) throw this.error('invalid_order', 'Invalid order ID');
    if (!context.order) throw new NotFoundException({ error: 'Order not found' });

    let total = 0;
    let methods: Array<{ method: string; amount: number }> = [];
    if (refundType === 'partial') {
      const selected = items.map((item) => this.selectedLine(context, item));
      const discounted = selected.filter((line) => this.discounted(line, context.discountPayload));
      if (discounted.length) {
        const names = [...new Set(discounted.map((line) => String(line.name || 'Item')))];
        throw this.error('discounted_items_found', `Refund not allowed. Discount applied to: ${names.join(', ')}`);
      }
      total = items.reduce((sum, item) => {
        const amount = Number(item?.order_item_amount);
        if (!Number.isFinite(amount) || amount < 0) throw this.error('invalid_item', 'Invalid refund item');
        return sum + amount;
      }, 0);
    } else {
      const paymentRows = context.payments.filter((payment: any) => payment.entry_type === 'payment' && !payment.is_void);
      const orderTotal = Number(context.storeOrder?.total ?? context.order.totalAmount ?? 0);
      const storedPayments = this.storedPayments(context.storeOrder?.payments);
      const fallbackPayments = paymentRows.length
        ? paymentRows
        : storedPayments.length
          ? storedPayments
          : [{
              payment_method: context.storeOrder?.paymentMethod || context.order.paymentMethod || 'cash',
              amount: orderTotal,
            }];
      const totals = new Map<string, number>();
      fallbackPayments.forEach((payment: any) => {
        const amount = Number(payment.amount ?? payment.payment_amount ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) return;
        const method = this.methodName(payment.payment_method || payment.method || 'Cash');
        totals.set(method, (totals.get(method) || 0) + amount);
      });
      methods = [...totals.entries()].map(([method, amount]) => ({ method, amount: this.round(amount) }));
      const refunded = context.payments
        .filter((payment: any) => payment.entry_type === 'refund' && !payment.is_void)
        .reduce((sum: number, payment: any) => sum + Number(payment.amount || 0), 0);
      total = Math.max(0, orderTotal - refunded);
    }

    const numericOrderNumber = Number(String(context.order.orderNumber || '').replace(/\D/g, ''));
    return {
      success: true,
      message: 'Refund amount calculated successfully',
      order_id: Number.isSafeInteger(numericOrderNumber) && numericOrderNumber > 0
        ? numericOrderNumber
        : context.order.id,
      methods,
      total: this.round(total),
    };
  }

  private selectedLine(context: any, item: any): any {
    const requestedId = String(item?.order_item_id ?? '').trim();
    if (!requestedId) throw this.error('invalid_item', 'Invalid refund item');
    const storedLines = Array.isArray(context.storeOrder?.lineItems) ? context.storeOrder.lineItems : [];
    const line = storedLines.find((candidate: any) => String(candidate?.id ?? '') === requestedId)
      || context.items.find((candidate: any) => String(candidate?.id ?? '') === requestedId);
    if (!line) throw this.error('invalid_item', 'Invalid refund item');
    return line;
  }

  private discounted(line: any, payload: Record<string, unknown>): boolean {
    const metadata = Array.isArray(line?.meta_data) ? line.meta_data : (Array.isArray(line?.modifiers) ? line.modifiers : []);
    if (metadata.some((entry: any) => entry?.key === '_pos_discount_rule_id' && String(entry.value || '').trim())) return true;
    const productId = String(line?.variation_id || line?.product_id || line?.productId || '');
    const mixMatch = Array.isArray((payload as any)?.mix_match) ? (payload as any).mix_match : [];
    return mixMatch.some((rule: any) => {
      const ids = [rule?.product_id, rule?.parent_product_id, rule?._mix_match_parent_product_id]
        .concat(rule?.product_ids || [], rule?.child_product_ids || [], rule?._mix_match_child_product_ids || [])
        .map(String);
      return ids.includes(productId);
    });
  }

  private storedPayments(value: unknown): any[] { return Array.isArray(value) ? value : []; }
  private methodName(value: unknown): string {
    const method = String(value || 'Cash').trim().toLowerCase();
    return method ? method.charAt(0).toUpperCase() + method.slice(1) : 'Cash';
  }
  private round(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100; }
  private error(code: string, message: string): BadRequestException {
    return new BadRequestException({ code, message, data: { status: 400 } });
  }
}
