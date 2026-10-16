import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { OrderRepository } from './order.repository';

export interface FullOrderRefundRequest {
  order_id?: unknown;
  amount?: unknown;
  reason?: unknown;
  items_reusable?: unknown;
}

@Injectable()
export class FullOrderRefundService {
  constructor(@Inject(OrderRepository) private readonly orders: OrderRepository) {}

  async refund(
    body: FullOrderRefundRequest,
    scope: { merchantId: string; storeId: string; performedBy: string },
  ) {
    const clientOrderId = String(body?.order_id ?? '').trim();
    if (!clientOrderId) throw this.error('invalid_order_id', 'Invalid Order Id');
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw this.error('invalid_refund_amt', 'Invalid Refund Amount');
    const reason = String(body?.reason ?? '').trim();
    if (!reason) throw this.error('invalid_reason', 'Please Provide Reason');
    const restock = String(body?.items_reusable ?? 'no').trim().toLowerCase() === 'yes';

    const result = await this.orders.createFullOrderRefund({
      clientOrderId,
      merchantId: scope.merchantId,
      storeId: scope.storeId,
      requestedAmount: amount,
      reason,
      restock,
      performedBy: scope.performedBy,
    });
    if (result.kind === 'missing') throw this.error('invalid_order_id', 'Invalid Order Id');
    if (result.kind === 'already_refunded') {
      throw this.error('order_already_refunded', 'This order has already been fully refunded.');
    }
    const numericOrderNumber = Number(result.orderNumber.replace(/\D/g, ''));
    return {
      success: true,
      order_id: Number.isSafeInteger(numericOrderNumber) && numericOrderNumber > 0
        ? String(numericOrderNumber)
        : result.orderId,
      payment_method: this.methodName(result.paymentMethod),
      refunded_amount: result.refundedAmount.toFixed(2),
      order_status: 'refunded',
      restock,
      refund_id: result.refundId,
    };
  }

  private methodName(value: unknown): string {
    const method = String(value || 'Cash').trim().toLowerCase();
    return method ? method.charAt(0).toUpperCase() + method.slice(1) : 'Cash';
  }

  private error(code: string, message: string): BadRequestException {
    return new BadRequestException({ code, message, data: { status: 400 } });
  }
}
