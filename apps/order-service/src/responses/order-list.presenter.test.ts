import assert from 'node:assert/strict';
import test from 'node:test';
import { OrderListPresenter } from './order-list.presenter';

function row(status: string) {
  return {
    order: {
      id: '8c0ca90d-4af1-4489-b962-7c73d225e1aa',
      orderNumber: '2626',
      clientOrderId: '262860561',
      orderStatus: status === 'refunded' ? 'REFUNDED' : 'PARTIAL_REFUND',
      paymentStatus: 'PAID',
      totalAmount: 63.8,
      discountAmount: 0,
      taxAmount: 4.86,
      storeId: 'store-1',
      createdAt: new Date('2026-10-13T01:58:46Z'),
      updatedAt: new Date('2026-10-16T06:32:48Z'),
      requestPayload: {},
      metadata: [],
    },
    storeOrder: {
      status,
      total: 63.8,
      lineItems: [
        { id: 'ITEM-8c0ca90d-4af1-4489-b962-7c73d225e1aa-1', name: 'Coors Light', quantity: 1, total: '15.98' },
        { id: 'ITEM-8c0ca90d-4af1-4489-b962-7c73d225e1aa-2', name: 'Bigsip 4', quantity: 1, total: '3.99' },
      ],
    },
    items: [],
    products: new Map(),
    refunds: [{
      amount: '15.98',
      metadata: {
        line_items: [{ order_item_id: 'ITEM-8c0ca90d-4af1-4489-b962-7c73d225e1aa-1', quantity: 1 }],
      },
    }],
  } as any;
}

test('total-orders marks only partially refunded lines and reports refund totals', () => {
  const result = new OrderListPresenter().present(1, 10, 1, [row('partial-refund')]);
  const order = result.orders_data[0];
  assert.equal(order.line_items[0].is_refund_item, true);
  assert.equal(order.line_items[1].is_refund_item, false);
  assert.equal(order.refund_total, 15.98);
  assert.equal(order.net_payment, 47.82);
});

test('total-orders does not mark individual lines on a fully refunded order', () => {
  const result = new OrderListPresenter().present(1, 10, 1, [row('refunded')]);
  assert.equal(result.orders_data[0].line_items[0].is_refund_item, false);
});
