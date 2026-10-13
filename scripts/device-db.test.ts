import './load-env';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { DeviceEntity } from '../apps/merchant-service/src/entities/device.entity';
import { MerchantRepository } from '../apps/merchant-service/src/modules/merchant/merchant.repository';

async function main() {
  const db = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL || undefined,
    host: process.env.POSTGRES_HOST || 'localhost', port: Number(process.env.POSTGRES_PORT) || 5432,
    username: process.env.POSTGRES_USER || 'pdh_user', password: process.env.POSTGRES_PASSWORD || 'pdh_password',
    database: process.env.POSTGRES_DB || 'pinaka_commerce_hub', entities: [DeviceEntity], synchronize: false });
  await db.initialize();
  const runner = db.createQueryRunner();
  await runner.startTransaction();
  try {
    const repository = new MerchantRepository();
    Object.assign(repository, { deviceRepo: runner.manager.getRepository(DeviceEntity) });
    const id = randomUUID();
    await repository.createDevice({ id, deviceName: 'Rollback test', deviceCode: `TEST-${id}`,
      deviceType: 'POS Terminal', merchantId: 'MCH-1001', merchantName: 'Test merchant',
      serialNumber: `TEST-${id}`, status: 'Active', createdAt: new Date() });
    const device = (await repository.listDevices()).find((item: DeviceEntity) => item.id === id);
    assert.equal(device?.deviceName, 'Rollback test');
    assert.equal(device?.deviceType, 'POS Terminal');
    await assert.rejects(() => repository.createDevice({ id: randomUUID(), deviceName: 'Duplicate',
      deviceCode: `TEST-DUP-${id}`, deviceType: 'POS Terminal', merchantId: 'MCH-1001',
      merchantName: 'Test merchant', serialNumber: `TEST-${id}`, status: 'Active', createdAt: new Date() }),
      (error: any) => error.getStatus() === 409);
    console.log('PASS: PostgreSQL device persistence without store/details columns and unique serial constraint (rolled back)');
  } finally { await runner.rollbackTransaction(); await runner.release(); await db.destroy(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
