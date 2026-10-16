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

test('list supports a type query while preserving the source list pagination', async () => {
  const source = {
    data: { auto: [{ id: 1 }], mix_match: [{ id: 2 }], multipack: [{ id: 3 }] },
    pagination: { page: 1, per_page: 10, total: 3, total_pages: 1, has_more: false },
  };
  const service = serviceWithConnection();
  (service as any).wordpressRequest = async () => source;
  (service as any).saveDiscount = async () => undefined;
  assert.deepEqual(await service.list('store-1', 'OWNER', { type: 'mix_match' }), {
    data: source.data.mix_match,
    pagination: source.pagination,
  });
});

test('list requests 100 records by default and allows explicit pagination overrides', async () => {
  const service = serviceWithConnection();
  const queries: Record<string, string>[] = [];
  (service as any).wordpressRequest = async (_connection: unknown, _path: string, _method: string, _body: unknown, query: Record<string, string>) => {
    queries.push(query);
    return { data: {} };
  };
  await service.list('store-1', 'OWNER');
  await service.list('store-1', 'OWNER', { page: '2', per_page: '25' });
  assert.deepEqual(queries, [
    { page: '1', per_page: '100' },
    { page: '2', per_page: '25' },
  ]);
});

test('get by ID reads only the requested type from the existing store_discounts payload', async () => {
  const service = serviceWithConnection();
  (service as any).readDiscountPayload = async () => ({
    auto: [{ id: 41, code: 'AUTO' }],
    mix_match: [{ id: 41, code: 'MIX' }],
    multipack: [],
  });
  assert.deepEqual(await service.getById('store-1', 'mix_match', '41', 'OWNER'), { id: 41, code: 'MIX' });
  await assert.rejects(service.getById('store-1', 'multipack', '41', 'OWNER'), (error: any) => error.getStatus() === 404);
  await assert.rejects(service.getById('store-1', 'coupon', '41', 'OWNER'), (error: any) => error.getStatus() === 400);
});

test('discount rules are projected from store_discounts in the WooCommerce rule shape', async () => {
  const service = serviceWithConnection();
  (service as any).merchants = { getStoreById: async () => ({ id: 'store-1' }) };
  (service as any).readDiscountPayload = async () => ({
    auto: [{
      id: 17533, product_id: 17274, coupon_amount: '15', discount_type: 'fixed_cart',
      start_date: '2026-10-18', expiry_date: '2026-10-21', minimum_amount: '5', maximum_amount: '50',
    }],
    mix_match: [{
      id: 17534, product_id: 17274, discount_product_ids: [17284, 17270],
      coupon_amount: '2', discount_type: 'fixed_item',
    }],
    multipack: [{
      id: 0, product_id: 4556, qty: '3', discount: '10%',
      start_date: '2026-10-01', expiry_date: '2026-12-31',
    }],
  });
  assert.deepEqual(await service.listRules('store-1', 'OWNER'), [
    {
      ruleId: 'AUTO_17533', ruleType: 'auto', productIds: [17274], bundlePrice: 15, requiredQty: 0,
      bundlePriceType: 'price', startDate: '2026-10-18', endDate: '2026-10-21',
      minimumAmount: '5', maximumAmount: '50', active: true,
    },
    {
      ruleId: 'MM_17534', ruleType: 'mixmatch', productIds: [17284, 17270], requiredProductIds: 17274,
      requiredQty: 0, bundlePrice: 2, bundlePriceType: 'price', active: true,
    },
    {
      ruleId: 'MP_0', ruleType: 'multipack', productIds: [4556], requiredQty: 3, bundlePrice: 10,
      bundlePriceType: 'percentage', startDate: '2026-10-01', endDate: '2026-12-31', active: true,
    },
  ]);
  assert.deepEqual(
    (await service.listRules('store-1', 'OWNER', '17284')).map((rule: { ruleId: string }) => rule.ruleId),
    ['MM_17534'],
  );
  assert.equal((await service.listRules('store-1', 'Cashier', undefined, 'store-1')).length, 3);
  await assert.rejects(
    () => service.listRules('store-1', 'Cashier', undefined, 'store-2'),
    (error: { getStatus?: () => number; message?: string }) => error.getStatus?.() === 403 && /signed-in store/.test(error.message || ''),
  );
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
    if (type === 'multipack') (service as any).fetchWordPressDiscounts = async () => [];
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
    const result = await service.create('store-1', {
      type, code: 'Test', amount: 10,
      ...(type === 'multipack' ? { product_id: 123, qty: 3 } : {}),
    }, 'OWNER');
    assert.deepEqual(result, type === 'multipack' ? { ...sourceResponse, id: 5 } : sourceResponse);
    assert.equal((service as any).saved.id, type === 'multipack' ? 5 : 41);
  });

  test(`${type} update preserves the WordPress response contract`, async () => {
    const sourceResponse = type === 'multipack'
      ? { success: true, message: 'Multipack discount updated successfully.', discount_id: 41 }
      : { success: true, message: 'Discount updated successfully.', discount_id: 41 };
    respond(sourceResponse);
    const service = serviceWithConnection();
    (service as any).findStoredDiscount = async () => ({
      id: 41, pchId: '41', wordpressId: '41', type, amount: 10,
      ...(type === 'multipack' ? { product_id: 123, qty: 3 } : {}),
    });
    let saved: unknown[] = [];
    (service as any).saveDiscount = async (...args: unknown[]) => { saved = args; };
    const result = await service.update('store-1', type, '41', { amount: 12 }, 'OWNER');
    assert.deepEqual(result, sourceResponse);
    assert.equal(saved[0], 'store-1');
    assert.equal(saved[1], type);
    assert.equal(saved[3], '41');
    assert.equal((saved[2] as any).amount, 12);
    assert.equal((saved[2] as any).wordpressId, '41');
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
  (service as any).fetchWordPressDiscounts = async () => [];
  const sourceResponse = { success: true, message: 'Multipack discount saved successfully.' };
  let calls = 0;
  (service as any).wordpressRequest = async (_connection: unknown, path: string) => {
    calls++;
    if (path.endsWith('get-all-discounts-for-admin')) throw new Error('list unavailable');
    return sourceResponse;
  };
  const result = await service.create('store-1', { type: 'multipack', product_id: 123, code: 'Pack', amount: 2, qty: 3 }, 'OWNER');
  assert.deepEqual(result, sourceResponse);
  assert.equal(calls, 2);
});

test('sync keeps discounts even when their products are absent locally and honors pagination', async () => {
  const service = serviceWithConnection();
  const writes: unknown[][] = [];
  const manager = { query: async (...args: unknown[]) => { writes.push(args); return []; } };
  (service as any).merchants = {
    requireDataSource: () => ({
      query: async (sql: string) => sql.includes('to_regclass')
        ? [{ name: 'store_products' }]
        : [{ payload: [{ id: 123 }] }],
      transaction: async (operation: (manager: unknown) => Promise<unknown>) => operation(manager),
    }),
  };
  let page = 0;
  globalThis.fetch = async () => {
    page++;
    const body = page === 1
      ? { data: {
          multipack: [{ id: 3, product_id: 123, qty: 3, type: 'multipack' }],
          mix_match: [
            { id: 17439, product_id: 123, type: 'mix_match' },
            { id: 17426, product_id: 999, type: 'mix_match' },
          ],
        }, pagination: { has_more: true } }
      : { data: {}, pagination: { has_more: false } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const result = await service.syncStoreDiscountsFromWordPress({
    storeId: 'store-1', wordpressUrl: 'https://shop.example', wordpressJwt: 'test-jwt',
  });
  assert.deepEqual(result, { discountCount: 3, skippedCount: 0 });
  assert.equal(page, 2);
  assert.equal(writes.length, 2);
  assert.match(String(writes[0][0]), /INSERT INTO public\.store_discounts/);
  const savedPayload = JSON.parse(String(writes[0][1]));
  assert.deepEqual(savedPayload.mix_match.map((item: any) => item.id), [17439, 17426]);
  assert.match(String(writes[1][0]), /INSERT INTO public\.discounts/);
});

test('discount sync preserves the WordPress authorization response and status', async () => {
  const service = serviceWithConnection();
  (service as any).merchants = {
    requireDataSource: () => ({
      query: async (sql: string) => sql.includes('to_regclass')
        ? [{ name: 'store_products' }]
        : [{ payload: [{ id: 123 }] }],
    }),
  };
  const sourceError = { code: 'rest_forbidden', message: 'Sorry, you are not allowed to access this resource.', data: { status: 403 } };
  globalThis.fetch = async () => new Response(JSON.stringify(sourceError), {
    status: 403, headers: { 'Content-Type': 'application/json' },
  });
  await assert.rejects(
    service.syncStoreDiscountsFromWordPress({
      storeId: 'store-1', wordpressUrl: 'https://shop.example', wordpressJwt: 'test-jwt',
    }),
    (error: any) => error instanceof WordPressResponseException &&
      error.getStatus() === 403 &&
      assert.deepEqual(error.getResponse(), sourceError) === undefined,
  );
});

test('discount ID matching recognizes either local or WooCommerce IDs', () => {
  const service = serviceWithConnection();
  const record = { id: 17439, pchId: 'pch-9', wordpressId: '17439' };
  assert.equal((service as any).discountMatchesId(record, 'pch-9'), true);
  assert.equal((service as any).discountMatchesId(record, '17439'), true);
  assert.equal((service as any).discountMatchesId(record, 'other'), false);
});

test('auto and mix-match discount names are compared case-insensitively before create', async () => {
  for (const type of ['auto', 'mix_match']) {
    const service = serviceWithConnection();
    (service as any).fetchWordPressDiscounts = async () => [{ id: 8, code: 'Summer Sale' }];
    await assert.rejects(
      (service as any).assertDiscountIsUnique({ wordpressUrl: '', wordpressJwt: '' }, type, { code: '  summer sale  ' }),
      (error: any) => error.getStatus() === 409,
    );
  }
});

test('mix-match required product maps to the reference API trigger product field', () => {
  const service = serviceWithConnection();
  const payload = (service as any).toWordPressPayload({
    type: 'mix_match', required_product_ids: [123], discount_product_ids: [456],
  });
  assert.equal(payload.product_id, 123);
  assert.deepEqual(payload.discount_product_ids, [456]);
  assert.deepEqual((service as any).canonicalizeWordPressRecord({ type: 'mix_match', product_id: 123 }).required_product_ids, [123]);
});

test('multipack quantity aliases are sent as qty and missing values are rejected', () => {
  const service = serviceWithConnection();
  const payload = (service as any).toWordPressPayload({ type: 'multipack', product_id: 123, quantity: '3' });
  assert.equal(payload.qty, 3);
  assert.throws(() => (service as any).validateCreateInput('multipack', { product_id: 123 }), (error: any) => error.getStatus() === 400);
});

test('auto update payload omits the blank qty placeholder returned by the WordPress list API', () => {
  const service = serviceWithConnection();
  const payload = (service as any).toWordPressPayload({
    type: 'auto', code: 'Auto Discount', product_id: 17274, qty: '', amount: 15,
  });
  assert.equal(Object.hasOwn(payload, 'qty'), false);
  assert.equal(payload.product_id, 17274);
});

test('auto update succeeds when the cached WordPress record has qty as an empty placeholder', async () => {
  const service = serviceWithConnection();
  (service as any).findStoredDiscount = async () => ({ id: 17533, code: 'Auto Discount', product_id: 17274, qty: '' });
  (service as any).fetchWordPressDiscounts = async () => [];
  (service as any).fetchWordPressDiscount = async () => undefined;
  (service as any).saveDiscount = async () => undefined;
  let updateBody: any;
  (service as any).wordpressRequest = async (_connection: unknown, path: string, _method: string, body: any) => {
    if (path === 'custom-discount/update-discount') updateBody = body;
    return { success: true, message: 'Discount updated successfully.', discount_id: 17533 };
  };
  await service.update('store-1', 'auto', '17533', {
    code: 'Auto Discount', discount_type: 'percent', amount: 15, product_id: 17274,
    usage_limit: 1, date_starts: '2026-10-18', date_expires: '2026-10-21',
  }, 'OWNER');
  assert.equal(updateBody.type, 'auto');
  assert.equal(Object.hasOwn(updateBody, 'qty'), false);
});

test('multipack duplicate validation uses the saved product and quantity pair', async () => {
  const service = serviceWithConnection();
  (service as any).fetchWordPressDiscounts = async () => [{ id: 17, product_id: 123, qty: '3' }];
  await assert.rejects(
    (service as any).assertMultipackRuleIsUnique({ wordpressUrl: '', wordpressJwt: '' }, { product_id: 123, qty: 3 }),
    (error: any) => error.getStatus() === 409,
  );
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
