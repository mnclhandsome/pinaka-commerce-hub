import { Inject, Injectable } from '@nestjs/common';
import { MerchantRepository } from '../merchant/merchant.repository';
import { DeviceEntity } from '../../entities/device.entity';
import { DeviceRepository } from './device.repository';

@Injectable()
export class DeviceService {
  constructor(
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
    @Inject(DeviceRepository) private readonly mappings: DeviceRepository,
  ) {}

  findDeviceMerchant(idOrUuid: string) { return this.merchants.findDeviceMerchant(idOrUuid); }
  async findAvailableDevicesByMerchant(merchantUuid: string) {
    const merchant = await this.merchants.findDeviceMerchant(merchantUuid);
    if (!merchant) return null;
    return this.mappings.findAvailableDevicesByMerchant(merchant.id);
  }
  createDevice(data: Parameters<DeviceRepository['createDeviceWithMerchantMapping']>[0]) {
    return this.mappings.createDeviceWithMerchantMapping(data);
  }
  async queryDevices(filters: Parameters<MerchantRepository['queryDevices']>[0]) {
    if (!filters.merchantId) return this.merchants.queryDevices(filters);
    const merchant = await this.merchants.findDeviceMerchant(filters.merchantId);
    if (!merchant) return { devices: [], total: 0, summary: {} };
    return this.mappings.queryDevicesByMerchant({ ...filters, merchantId: merchant.id });
  }
  listDevices() { return this.merchants.listDevices(); }
  getAllMerchants() { return this.merchants.getAllMerchants(); }
  listDevicesByMerchantId(merchantId: string) { return this.mappings.findDevicesByMerchant(merchantId); }
  getDevice(id: string) { return this.merchants.getDevice(id); }
  async updateDevice(id: string, fields: Partial<DeviceEntity>) {
    const updated = await this.merchants.updateDevice(id, fields);
    if (fields.merchantId && fields.updatedBy) {
      await this.mappings.updateMerchantForDevice(id, fields.merchantId, fields.updatedBy);
    }
    return updated;
  }
  deleteDevice(id: string, actorId: string) { return this.merchants.deleteDevice(id, actorId); }

}
