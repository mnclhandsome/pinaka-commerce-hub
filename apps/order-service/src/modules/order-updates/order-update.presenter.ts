import { Inject, Injectable } from '@nestjs/common';
import { OrderResponsePresenter } from '../../responses/order-response.presenter';
import type { OrderGraph } from './order-update.types';

@Injectable()
export class OrderUpdatePresenter {
  constructor(
    @Inject(OrderResponsePresenter)
    private readonly responses: OrderResponsePresenter,
  ) {}

  present(graph: OrderGraph) {
    const stored = { ...((graph.order.requestPayload || {}) as Record<string, unknown>) };
    const storeOrder = graph.storeOrder;
    delete stored.date_modified;
    delete stored.date_modified_gmt;
    const request = {
      ...stored,
      status: storeOrder?.status || String(graph.order.orderStatus || '').toLowerCase(),
      currency: storeOrder?.currency || stored.currency,
      discount_total: storeOrder?.discountTotal ?? graph.order.discountAmount,
      total: storeOrder?.total ?? graph.order.totalAmount,
      total_tax: storeOrder?.taxTotal ?? graph.order.taxAmount,
      cart_tax: storeOrder?.taxTotal ?? stored.cart_tax,
      line_items: storeOrder?.lineItems ?? stored.line_items,
      coupon_lines: storeOrder?.couponLines ?? stored.coupon_lines,
      fee_lines: storeOrder?.feeLines ?? stored.fee_lines,
      tax_lines: storeOrder?.taxLines ?? stored.tax_lines,
    };
    return this.responses.present(this.responses.profileFor(request), {
      result: {
        order: graph.order,
        items: graph.items,
        storeOrder,
        duplicate: false,
      },
      request,
    });
  }
}
