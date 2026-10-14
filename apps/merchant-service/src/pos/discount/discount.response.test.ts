import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { DiscountController } from './discount.controller';
import { DiscountService } from './discount.service';
import { AllExceptionsFilter } from '../../common/all-exceptions.filter';
import { WordPressResponseException } from './wordpress-response.exception';

const types = ['auto', 'mix_match', 'multipack'] as const;
const originalFetch = globalThis.fetch;

function serviceWithConnection() {
  const service = new DiscountService({} as any);
  (service as any).requireWordPressConnection = async () => ({
    storeId: 'store-1', wordpressUrl: 'https://shop.example', wordpressJwt: 'test-jwt',
  });
  return service;
}

function respond(body: unknown, status = 200) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => { globalThis.fetch = originalFetch; });

test('list returns the WordPress grouped data and pagination wrapper unchanged', async () => {
  const wordpressResponse = {
    data: {
      auto: [{ id: 1, code: 'AUTO', discount_type: 'percent', coupon_amount: '10', type: 'auto' }],
      mix_match: [{ id: 2, code: 'MIX', discount_type: 'fixed_item', coupon_amount: '5', type: 'mix_match' }],
      multipack: [{ id: 3, code: 'PACK-3', coupon_amount: 2, qty: '3', type: 'multipack' }],
    },
    pagination: { page: 2, per_page: 10, total: 12, total_pages: 2, has_more: false },
  };
  respond(wordpressResponse);
  const result = await serviceWithConnection().list('store-1', 'OWNER', { page: '2', per_page: '10', search: 'sale' });
  assert.deepEqual(result, wordpressResponse);
});

test('discount rules projection remains the WordPress top-level array', async () => {
  const sourceResponse = [{ ruleId: 'AUTO_41', ruleType: 'auto', productIds: [8], bundlePrice: 10, requiredQty: 0, active: true }];
  respond(sourceResponse);
  assert.deepEqual(await serviceWithConnection().listRules('store-1', 'OWNER'), sourceResponse);
});

test('order apply and remove return their own WordPress response bodies unchanged', async () => {
  const service = serviceWithConnection();
  const applyResponse = { success: true, message: 'Discount applied to order.', discount_code: 'SAVE10', discount_amount: '$1.00', order_id: 123 };
  respond(applyResponse);
  assert.deepEqual(await service.applyToOrder('store-1', '123', { discount_code: 'SAVE10' }, 'OWNER'), applyResponse);

  const removeResponse = { id: 123, status: 'pending', line_items: [], fee_lines: [] };
  respond(removeResponse);
  assert.deepEqual(await service.removeFromOrder('store-1', '123', { discount_code: 'SAVE10' }, 'OWNER'), removeResponse);
});

test('by-ids product helper preserves the WordPress data wrapper for empty and populated results', async () => {
  const service = serviceWithConnection();
  for (const sourceResponse of [{ data: [] }, { data: [{ id: 8, name: 'Item' }] }]) {
    respond(sourceResponse);
    assert.deepEqual(await service.productsByIds('store-1', { ids: sourceResponse.data.map((item: any) => item.id) }, 'OWNER'), sourceResponse);
  }
});

for (const type of types) {
  test(`${type} create preserves the WordPress response contract`, async () => {
    const sourceResponse = type === 'multipack'
      ? { success: true, message: 'Multipack discount saved successfully.' }
      : { success: true, message: 'Discount created successfully.', discount_id: 41 };
    const service = serviceWithConnection();
    (service as any).saveDiscount = async (_store: string, _group: string, record: any) => { (service as any).saved = record; };
    if (type === 'multipack') {
      let listCalls = 0;
      globalThis.fetch = async () => {
        listCalls++;
        const data = { multipack: listCalls === 1 ? [{ id: 4 }] : [{ id: 4 }, { id: 5 }] };
        return new Response(JSON.stringify({ data }), { status: 200 });
      };
      const originalRequest = (service as any).wordpressRequest.bind(service);
      (service as any).wordpressRequest = async (...args: any[]) => {
        if (args[1] === 'custom-discount/create-discount') return sourceResponse;
        return originalRequest(...args);
      };
    } else {
      respond(sourceResponse, 201);
    }
    const result = await service.create('store-1', { type, code: 'Test', amount: 10 }, 'OWNER');
    assert.deepEqual(result, sourceResponse);
    assert.equal((service as any).saved.id, type === 'multipack' ? 5 : 41);
  });

  test(`${type} update preserves the WordPress response contract`, async () => {
    const sourceResponse = type === 'multipack'
      ? { success: true, message: 'Multipack discount updated successfully.', discount_id: 41 }
      : { success: true, message: 'Discount updated successfully.', discount_id: 41 };
    respond(sourceResponse);
    const service = serviceWithConnection();
    (service as any).findStoredDiscount = async () => ({ id: 41, pchId: '41', type });
    (service as any).saveDiscount = async () => undefined;
    const result = await service.update('store-1', type, '41', { amount: 12 }, 'OWNER');
    assert.deepEqual(result, sourceResponse);
  });

  test(`${type} delete preserves the WordPress response contract`, async () => {
    const sourceResponse = type === 'multipack'
      ? { success: true, message: 'Discount deleted successfully.', id: 41, type: 'multipack' }
      : { success: true, message: 'Discount deleted successfully', id: 41, type: type === 'auto' ? 'discounts' : 'mix_match_discounts' };
    respond(sourceResponse);
    const service = serviceWithConnection();
    (service as any).findStoredDiscount = async () => ({ id: 41, pchId: '41' });
    (service as any).removeDiscount = async () => undefined;
    const result = await service.remove('store-1', type, '41', 'OWNER');
    assert.deepEqual(result, sourceResponse);
  });
}

test('Multipack used-rule deletion retains WordPress success:false response and HTTP 200', async () => {
  const sourceResponse = {
    success: false,
    message: 'This multipack discount has already been used and cannot be deleted.',
    id: 41,
    type: 'multipack',
  };
  respond(sourceResponse);
  const service = serviceWithConnection();
  (service as any).findStoredDiscount = async () => ({ id: 41, pchId: '41' });
  (service as any).removeDiscount = async () => assert.fail('failed WordPress deletion must keep local mapping');
  assert.deepEqual(await service.remove('store-1', 'multipack', '41', 'OWNER'), sourceResponse);
});

test('Multipack create keeps its original success body when internal ID lookup is unavailable', async () => {
  const service = serviceWithConnection();
  const sourceResponse = { success: true, message: 'Multipack discount saved successfully.' };
  let calls = 0;
  (service as any).wordpressRequest = async (_connection: unknown, path: string) => {
    calls++;
    if (path.endsWith('get-all-discounts-for-admin')) throw new Error('list unavailable');
    return sourceResponse;
  };
  const result = await service.create('store-1', { type: 'multipack', code: 'Pack', amount: 2, qty: 3 }, 'OWNER');
  assert.deepEqual(result, sourceResponse);
  assert.equal(calls, 2);
});

test('WordPress error response body and status are propagated unchanged', async () => {
  const sourceError = { success: false, message: 'A multipack discount already exists for this product and quantity.' };
  respond(sourceError, 409);
  const service = serviceWithConnection();
  (service as any).findStoredDiscount = async () => ({ id: 41, pchId: '41' });
  await assert.rejects(
    service.update('store-1', 'multipack', '41', { amount: 4 }, 'OWNER'),
    (error: any) => error instanceof WordPressResponseException && error instanceof HttpException && error.getStatus() === 409 && assert.deepEqual(error.getResponse(), sourceError) === undefined,
  );
});

test('global PCH exception filter does not decorate a WordPress error response', () => {
  const sourceError = { code: 'duplicate_rule', message: 'A multipack discount already exists.', data: { status: 409 } };
  let actualBody: unknown;
  let actualStatus = 0;
  const adapter = { reply: (_response: unknown, body: unknown, status: number) => { actualBody = body; actualStatus = status; } };
  const host = { switchToHttp: () => ({ getResponse: () => ({}) }) };
  const filter = new AllExceptionsFilter({ httpAdapter: adapter } as any);
  filter.catch(new WordPressResponseException(sourceError, 409), host as any);
  assert.deepEqual(actualBody, sourceError);
  assert.equal(actualStatus, 409);
});

test('PCH route status codes match the WordPress CRUD statuses', () => {
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, DiscountController.prototype.list), 200);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, DiscountController.prototype.create), 201);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, DiscountController.prototype.update), 200);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, DiscountController.prototype.remove), 200);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, DiscountController.prototype.listRules), 200);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, DiscountController.prototype.applyToOrder), 200);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, DiscountController.prototype.removeFromOrder), 200);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, DiscountController.prototype.productsByIds), 200);
});
