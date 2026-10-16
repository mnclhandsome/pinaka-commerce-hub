import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PosAuthService } from './pos-auth.service';

function serviceWith(candidate: Record<string, unknown>, sessionEmployeeId = 'employee-1') {
  const service = new PosAuthService(
    { verify: async (pin: string, hash: string) => hash === `hash:${pin}` } as any,
    {} as any,
    {} as any,
  );
  (service as any).authorizeStoreCatalog = async () => ({
    employeeId: sessionEmployeeId,
    merchant: { id: 'cb1f2437-a9e9-4a2b-b044-caf7cdfac180' },
    store: { id: '2ad68afe-8203-44bf-9bad-c3b5ec01bfb0' },
    merchantIds: [],
    storeIds: [],
    dataSource: { query: async () => [candidate] },
  });
  return service;
}

test('refund validation accepts the active employee six-digit PIN', async () => {
  const service = serviceWith({ id: 'employee-1', storePin: '123456' });
  assert.deepEqual(
    await service.validateRefundUser('123456', 'Bearer token', 'merchant', 'store'),
    { success: true, message: 'User verified successfully' },
  );
});

test('refund validation rejects a PIN belonging to a different employee', async () => {
  const service = serviceWith({ id: 'employee-2', employeePinHash: 'hash:123456' });
  await assert.rejects(
    service.validateRefundUser('123456', 'Bearer token', 'merchant', 'store'),
    ForbiddenException,
  );
});

test('refund validation returns the Woo-compatible invalid PIN errors', async () => {
  const service = serviceWith({ id: 'employee-1', storePin: '123456' });
  await assert.rejects(
    service.validateRefundUser('1234', 'Bearer token', 'merchant', 'store'),
    (error: unknown) => error instanceof BadRequestException
      && (error.getResponse() as any).code === 'invalid_pin_format',
  );
  await assert.rejects(
    service.validateRefundUser('', 'Bearer token', 'merchant', 'store'),
    (error: unknown) => error instanceof BadRequestException
      && (error.getResponse() as any).code === 'invalid_pin',
  );
});
