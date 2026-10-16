import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RefundAmountService } from './refund-amount.service';

const baseContext = {
  order: { id: 'order-uuid', orderNumber: '17517', totalAmount: 18.42 },
  items: [],
  history: [],
  storeOrder: {
    total: 18.42,
    lineItems: [{ id: 30486, name: 'Honey royal', product_id: 3849, meta_data: [] }],
    payments: [],
  },
  payments: [
    { entry_type: 'payment', payment_method: 'cash', amount: '12.00', is_void: false },
    { entry_type: 'payment', payment_method: 'card', amount: '6.42', is_void: false },
    { entry_type: 'refund', payment_method: 'cash', amount: '2.00', is_void: false },
  ],
  discountPayload: {},
};

function service(context: any = baseContext) {
  return new RefundAmountService({ getRefundAmountContext: async () => context } as any);
}

test('full refund returns payment method totals and subtracts prior refunds', async () => {
  const result = await service().calculate(
    { order_id: '262881247', refund_type: 'Full' },
    'cb1f2437-a9e9-4a2b-b044-caf7cdfac180',
    '2ad68afe-8203-44bf-9bad-c3b5ec01bfb0',
  );
  assert.equal(result.order_id, 17517);
  assert.deepEqual(result.methods, [
    { method: 'Cash', amount: 12 },
    { method: 'Card', amount: 6.42 },
  ]);
  assert.equal(result.total, 16.42);
});

test('partial refund uses selected amounts', async () => {
  const result = await service().calculate(
    { order_id: '262881247', refund_type: 'Partial', items: [{ order_item_id: 30486, order_item_amount: 6.99 }] },
    'cb1f2437-a9e9-4a2b-b044-caf7cdfac180',
    '2ad68afe-8203-44bf-9bad-c3b5ec01bfb0',
  );
  assert.deepEqual(result.methods, []);
  assert.equal(result.total, 6.99);
});

test('partial refund rejects discounted items', async () => {
  const context: any = structuredClone(baseContext);
  context.storeOrder.lineItems[0].meta_data = [{ key: '_pos_discount_rule_id', value: 'AUTO_4889' }];
  await assert.rejects(
    service(context).calculate(
      { order_id: '262881247', refund_type: 'Partial', items: [{ order_item_id: 30486, order_item_amount: 6.99 }] },
      'cb1f2437-a9e9-4a2b-b044-caf7cdfac180',
      '2ad68afe-8203-44bf-9bad-c3b5ec01bfb0',
    ),
    (error: unknown) => error instanceof BadRequestException
      && (error.getResponse() as any).code === 'discounted_items_found',
  );
});

test('full refund falls back to the order payment method for legacy orders', async () => {
  const context: any = structuredClone(baseContext);
  context.payments = [];
  context.storeOrder.payments = [];
  context.storeOrder.paymentMethod = 'cash';
  const result = await service(context).calculate(
    { order_id: '262881247', refund_type: 'Full' },
    'cb1f2437-a9e9-4a2b-b044-caf7cdfac180',
    '2ad68afe-8203-44bf-9bad-c3b5ec01bfb0',
  );
  assert.deepEqual(result.methods, [{ method: 'Cash', amount: 18.42 }]);
});

test('invalid order uses the Woo WP_Error response shape', async () => {
  const refunds = service(null);
  await assert.rejects(
    refunds.calculate(
      { order_id: 'missing', refund_type: 'Full' },
      'cb1f2437-a9e9-4a2b-b044-caf7cdfac180',
      '2ad68afe-8203-44bf-9bad-c3b5ec01bfb0',
    ),
    (error: unknown) => error instanceof BadRequestException
      && error.getStatus() === 400
      && JSON.stringify(error.getResponse()) === JSON.stringify({
        code: 'invalid_order',
        message: 'Invalid order ID',
        data: { status: 400 },
      }),
  );
});
