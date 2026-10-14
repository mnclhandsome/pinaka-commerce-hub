import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { MerchantRepository } from '../merchant/merchant.repository';
import { DeviceActivationController } from './device-activation.controller';
import { DeviceRepository } from './device.repository';

async function main() {
  const merchantRepository = new MerchantRepository();
  const deviceRecord: Record<string, any> = {
    id: 'device-uuid',
    deviceCode: 'DVC-00001',
    deviceName: 'POS terminal',
    merchantId: 'merchant-uuid',
    deviceActiveCode: 'PK-123456',
    serialNumber: 'SN-UNASSIGNED',
    deviceId: null,
    status: 'ACTIVE',
  };
  const dataSource = {
    transaction: async (callback: (manager: any) => Promise<any>) =>
      callback({
        query: async (sql: string, parameters: unknown[] = []) => {
          if (sql.includes('FROM public.devices')) {
            return parameters[0] === deviceRecord.deviceActiveCode
              ? [{ ...deviceRecord }]
              : [];
          }
          if (sql.includes('FROM public.store_devices')) {
            return [];
          }
          if (sql.includes('FROM public.merchants')) {
            return [
              {
                id: 'merchant-uuid',
                merchantCode: 'MCH-1',
                businessDisplayName: 'Test merchant',
              },
            ];
          }
          if (sql.includes('FROM public.stores')) {
            return [
              {
                id: 'store-uuid',
                storeCode: 'STORE-1',
                storeName: 'Test store',
              },
            ];
          }
          if (sql.includes('UPDATE public.devices')) {
            if (sql.includes('SET device_id')) {
              deviceRecord.deviceId = parameters[0];
              deviceRecord.serialNumber = parameters[1] as string;
            } else if (sql.includes('SET "serialNumber"')) {
              deviceRecord.serialNumber = parameters[0] as string;
            }
            return [];
          }
          throw new Error(`Unexpected transaction query: ${sql}`);
        },
      }),
  };
  Object.assign(merchantRepository, { requireDataSource: () => dataSource });
  const sessions = {
    createSession: async () => ({ accessToken: 'test-token' }),
  };
  const controller = new DeviceActivationController(
    sessions as any,
    merchantRepository,
  );

  const activated = await controller.activate({
    activationCode: 'PK-123456',
    serialNumber: 'SUNMI-D3-ABC123',
  });
  assert.equal(deviceRecord.deviceId, 'SUNMI-D3-ABC123');
  assert.equal(deviceRecord.serialNumber, 'SUNMI-D3-ABC123');
  assert.equal(activated.message, 'Device activated successfully');

  const repeated = await controller.activate({
    activationCode: 'PK-123456',
    serialNumber: 'SUNMI-D3-ABC123',
  });
  assert.equal(repeated.success, true);
  assert.equal(repeated.message, 'This device is already activated');

  deviceRecord.deviceId = null;
  const repairedRepeat = await controller.activate({
    activationCode: 'PK-123456',
    serialNumber: 'SUNMI-D3-ABC123',
  });
  assert.equal(deviceRecord.deviceId, 'SUNMI-D3-ABC123');
  assert.equal(repairedRepeat.message, 'This device is already activated');

  deviceRecord.deviceId = 'OTHER-DEVICE';
  await assert.rejects(
    () =>
      controller.activate({
        activationCode: 'PK-123456',
        serialNumber: 'SUNMI-D3-ABC123',
      }),
    ConflictException,
  );
  deviceRecord.deviceId = 'SUNMI-D3-ABC123';

  await assert.rejects(
    () =>
      controller.activate({
        activationCode: 'not-a-code',
        serialNumber: 'SUNMI-D3-ABC123',
      }),
    BadRequestException,
  );
  await assert.rejects(
    () => controller.activate({ activationCode: 'PK-123456' }),
    BadRequestException,
  );

  const createRepository = new MerchantRepository();
  const transactionDataSource = {
    transaction: async (callback: (manager: any) => Promise<any>) =>
      callback({
        query: async (sql: string) => {
          if (sql.includes('MAX(substring')) return [{ maxCode: null }];
          if (sql.includes('SELECT 1 FROM public.devices')) return [];
          return [];
        },
        getRepository: () => ({
          create: (value: any) => value,
          save: async (value: any) => value,
        }),
      }),
  };
  Object.assign(createRepository, {
    requireDataSource: () => transactionDataSource,
  });
  const deviceRepository = new DeviceRepository(createRepository);
  const created = await deviceRepository.createDeviceWithMerchantMapping({
    id: 'device-uuid-2',
    deviceType: 'POS Terminal',
    merchantId: 'merchant-uuid',
    serialNumber: 'SN-UNASSIGNED-02',
    createdBy: 'user-uuid',
    updatedBy: 'user-uuid',
  });
  assert.match(created.deviceActiveCode || '', /^PK-\d{6}$/);

  console.log(
    'PASS: Device activation persists both identifiers, is idempotent, and creates an activation code',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
