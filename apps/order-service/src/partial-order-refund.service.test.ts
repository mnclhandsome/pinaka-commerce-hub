import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { PartialOrderRefundService } from './partial-order-refund.service';

const scope = {
  merchantId: 'cb1f2437-a9e9-4a2b-b044-caf7cdfac180',
  storeId: '2ad68afe-8203-44bf-9bad-c3b5ec01bfb0',
  performedBy: 'employee-11',
};

function service(result: any) {
  return new PartialOrderRefundService({ createPartialOrderRefund: async () => result } as any);
}

test('partial refund returns the Woo-compatible response', async () => {
  const result = await service({
    kind: 'created', orderId: 'order-uuid', orderNumber: '4364',
    refundedAmount: 10.77, refundId: '2b0a40c1-4281-44b3-a558-1ab9ba6a8a8d',
  }).refund({
    order_id: 31345,
    reason: 'items are damaged',
    items_reusable: 'yes',
    items: [{ order_item_id: 1481, qty: 1, refundable_amount: 10.77 }],
  }, scope);
  assert.deepEqual(result, {
    success: true,
    order_id: 4364,
    refunded_amount: '10.77',
    order_status: 'partial-refund',
    restock: true,
    refund_id: '2b0a40c1-4281-44b3-a558-1ab9ba6a8a8d',
  });
});

test('partial refund reports the remaining refundable quantity', async () => {
  await assert.rejects(
    service({ kind: 'qty_error', remainingQuantity: 1 }).refund({
      order_id: 31345,
      reason: 'items are damaged',
      items: [{ order_item_id: 1481, qty: 2, refundable_amount: 20 }],
    }, scope),
    (error: unknown) => error instanceof BadRequestException
      && JSON.stringify(error.getResponse()) === JSON.stringify({
        code: 'qty_error',
        message: 'Refund quantity exceeds remaining quantity. Remaining: 1',
        data: { status: 400 },
      }),
  );
});

test('partial refund validates items and line amounts', async () => {
  const refunds = service({ kind: 'created' });
  await assert.rejects(
    refunds.refund({ order_id: 31345, reason: 'damaged', items: [] }, scope),
    (error: unknown) => error instanceof BadRequestException && (error.getResponse() as any).code === 'no_items',
  );
  await assert.rejects(
    refunds.refund({ order_id: 31345, reason: 'damaged', items: [
      { order_item_id: 1481, qty: 1, refundable_amount: 0 },
    ] }, scope),
    (error: unknown) => error instanceof BadRequestException
      && (error.getResponse() as any).code === 'invalid_line_amount',
  );
});
