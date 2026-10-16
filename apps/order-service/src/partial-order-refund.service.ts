import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { OrderRepository } from './order.repository';

export interface PartialOrderRefundRequest {
  order_id?: unknown;
  reason?: unknown;
  items_reusable?: unknown;
  items?: unknown;
}

@Injectable()
export class PartialOrderRefundService {
  constructor(@Inject(OrderRepository) private readonly orders: OrderRepository) {}

  async refund(body: PartialOrderRefundRequest, scope: { merchantId: string; storeId: string; performedBy: string }) {
    const clientOrderId = String(body?.order_id ?? '').trim();
    if (!clientOrderId) throw this.error('invalid_order_id', 'Invalid Order Id');
    const reason = String(body?.reason ?? '').trim();
    if (!reason) throw this.error('invalid_reason', 'Please provide refund reason');
    if (!Array.isArray(body?.items) || body.items.length === 0) throw this.error('no_items', 'Please select items');
    const items = body.items.map((item: any) => {
      const orderItemId = String(item?.order_item_id ?? '').trim();
      const quantity = Number(item?.qty);
      const refundableAmount = Number(item?.refundable_amount);
      if (!orderItemId || !Number.isInteger(quantity) || quantity <= 0) throw this.error('invalid_item', 'Invalid refund item');
      if (!Number.isFinite(refundableAmount) || refundableAmount <= 0) {
        throw this.error('invalid_line_amount', 'Refund amount must be greater than zero');
      }
      return { orderItemId, quantity, refundableAmount };
    });
    const restock = String(body?.items_reusable ?? 'no').trim().toLowerCase() === 'yes';
    const result = await this.orders.createPartialOrderRefund({
      clientOrderId, merchantId: scope.merchantId, storeId: scope.storeId,
      reason, restock, performedBy: scope.performedBy, items,
    });
    if (result.kind === 'missing') throw this.error('invalid_order_id', 'Invalid Order Id');
    if (result.kind === 'already_refunded') throw this.error('order_already_refunded', 'This order has already been fully refunded.');
    if (result.kind === 'invalid_item') throw this.error('invalid_item', 'Invalid refund item');
    if (result.kind === 'qty_error') {
      throw this.error('qty_error', `Refund quantity exceeds remaining quantity. Remaining: ${result.remainingQuantity}`);
    }
    if (result.kind === 'invalid_amount') throw this.error('invalid_amount', 'Refund amount must be greater than zero');
    if (result.kind === 'exceeds_remaining') throw this.error('exceeds_remaining', 'Refund amount exceeds remaining refundable amount');
    const numericOrderNumber = Number(result.orderNumber.replace(/\D/g, ''));
    return {
      success: true,
      order_id: Number.isSafeInteger(numericOrderNumber) && numericOrderNumber > 0 ? numericOrderNumber : result.orderId,
      refunded_amount: result.refundedAmount.toFixed(2),
      order_status: 'partial-refund',
      restock,
      refund_id: result.refundId,
    };
  }

  private error(code: string, message: string): BadRequestException {
    return new BadRequestException({ code, message, data: { status: 400 } });
  }
}
