import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { FullOrderRefundService } from './full-order-refund.service';

const scope = {
  merchantId: 'cb1f2437-a9e9-4a2b-b044-caf7cdfac180',
  storeId: '2ad68afe-8203-44bf-9bad-c3b5ec01bfb0',
  performedBy: 'employee-11',
};

function service(result: any) {
  return new FullOrderRefundService({ createFullOrderRefund: async () => result } as any);
}

test('full refund returns the Woo-compatible success response', async () => {
  const refunds = service({
    kind: 'created',
    orderId: '93a2367d-7b2a-42c7-8da8-4262dc92acde',
    orderNumber: '17517',
    paymentMethod: 'cash',
    refundedAmount: 18.42,
    refundId: '0dc0d0f4-fbbc-48b9-b939-cc0240ff985b',
  });
  assert.deepEqual(await refunds.refund({
    order_id: 262881247,
    amount: 20.42,
    reason: 'items are damaged',
    items_reusable: 'no',
  }, scope), {
    success: true,
    order_id: '17517',
    payment_method: 'Cash',
    refunded_amount: '18.42',
    order_status: 'refunded',
    restock: false,
    refund_id: '0dc0d0f4-fbbc-48b9-b939-cc0240ff985b',
  });
});

test('full refund rejects an already refunded order in WP_Error shape', async () => {
  await assert.rejects(
    service({ kind: 'already_refunded' }).refund({
      order_id: 262881247,
      amount: 18.42,
      reason: 'items are damaged',
    }, scope),
    (error: unknown) => error instanceof BadRequestException
      && JSON.stringify(error.getResponse()) === JSON.stringify({
        code: 'order_already_refunded',
        message: 'This order has already been fully refunded.',
        data: { status: 400 },
      }),
  );
});

test('full refund validates amount and reason before persistence', async () => {
  const refunds = service({ kind: 'created' });
  await assert.rejects(
    refunds.refund({ order_id: 262881247, amount: 0, reason: 'damaged' }, scope),
    (error: unknown) => error instanceof BadRequestException
      && (error.getResponse() as any).code === 'invalid_refund_amt',
  );
  await assert.rejects(
    refunds.refund({ order_id: 262881247, amount: 10, reason: '' }, scope),
    (error: unknown) => error instanceof BadRequestException
      && (error.getResponse() as any).code === 'invalid_reason',
  );
});
