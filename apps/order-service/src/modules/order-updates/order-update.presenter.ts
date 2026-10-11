import { Injectable } from '@nestjs/common';
import { moneyAmount } from '../../calculations/order-update.calculations';
import type { StoreOrderTotals } from '../../calculations/store-order.calculations';
import type { OrderGraph, OrderUpdateAction } from './order-update.types';

@Injectable()
export class OrderUpdatePresenter {
  present(input: {
    action: OrderUpdateAction;
    message: string;
    graph: OrderGraph;
    totals?: StoreOrderTotals;
    appliedDiscount?: number;
  }) {
    const { graph } = input;
    const tip = Number(graph.order.tipAmount || 0);
    const tipAmount = Number.isFinite(tip) ? tip : 0;
    const storedTotal = input.totals
      ? moneyAmount(input.totals.total + tipAmount)
      : moneyAmount(graph.storeOrder?.total ?? graph.order.totalAmount);
    const body: Record<string, unknown> = {
      success: true,
      action: input.action,
      message: input.message,
      orderId: graph.order.id,
      orderNumber: graph.order.orderNumber,
      storeOrderId: graph.storeOrder?.id ?? null,
      status: graph.storeOrder?.status || String(graph.order.orderStatus).toLowerCase(),
      currency: graph.storeOrder?.currency || 'USD',
      totals: input.totals
        ? {
            subtotal: moneyAmount(input.totals.subtotal),
            discount_total: moneyAmount(input.totals.discountTotal),
            fee_total: moneyAmount(input.totals.feeTotal),
            tax_total: moneyAmount(input.totals.taxTotal),
            shipping_total: moneyAmount(input.totals.shippingTotal),
            total: storedTotal,
          }
        : {
            subtotal: moneyAmount(graph.storeOrder?.subtotal ?? graph.order.subtotal),
            discount_total: moneyAmount(graph.storeOrder?.discountTotal ?? graph.order.discountAmount),
            fee_total: moneyAmount(graph.storeOrder?.feeTotal ?? 0),
            tax_total: moneyAmount(graph.storeOrder?.taxTotal ?? graph.order.taxAmount),
            shipping_total: 0,
            total: storedTotal,
          },
      line_items: graph.storeOrder?.lineItems ?? [],
      coupon_lines: graph.storeOrder?.couponLines ?? [],
      fee_lines: graph.storeOrder?.feeLines ?? [],
      tax_lines: graph.storeOrder?.taxLines ?? [],
      items: graph.items,
      order: graph.order,
    };
    if (input.appliedDiscount !== undefined) {
      body.applied_discount = moneyAmount(input.appliedDiscount);
    }
    return body;
  }
}
