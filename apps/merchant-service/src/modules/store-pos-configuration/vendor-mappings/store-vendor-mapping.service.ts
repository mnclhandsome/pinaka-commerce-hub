import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { MerchantRepository } from '../../merchant/merchant.repository';
import { CreateStoreVendorMappingDto } from './dto/create-store-vendor-mapping.dto';
import { StoreVendorMappingRepository } from './store-vendor-mapping.repository';

@Injectable()
export class StoreVendorMappingService {
  constructor(
    @Inject(StoreVendorMappingRepository) private readonly mappings: StoreVendorMappingRepository,
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
  ) {}

  async list(storeKey: string) {
    const store = await this.merchants.getStoreById(storeKey);
    if (!store) throw new NotFoundException('Store not found');
    const vendors = await this.mappings.listForStore(store.id, store.merchantId);
    return { success: true, count: vendors.length, assignedCount: vendors.filter((v: any) => v.assigned).length, vendors };
  }

  async map(dto: CreateStoreVendorMappingDto) {
    const store = await this.merchants.getStoreById(dto.store_id);
    if (!store) throw new NotFoundException('Store not found');
    const [vendor] = await this.merchants.requireDataSource().query(
      `SELECT id FROM public.vendors WHERE id = $1::uuid AND is_deleted = false AND status = 'ACTIVE' LIMIT 1`,
      [dto.vendor_id],
    );
    if (!vendor) throw new NotFoundException('Active vendor not found');
    const merchantUuid = await this.merchants.resolveMerchantUuid(store.merchantId);
    if (!merchantUuid) throw new NotFoundException('Store merchant not found');
    const eligible = await this.merchants.requireDataSource().query(
      `SELECT id FROM public.merchant_vendors WHERE merchant_id = $1::uuid AND vendor_id = $2::uuid AND status = 'ACTIVE' LIMIT 1`,
      [merchantUuid, vendor.id],
    );
    if (!eligible.length) throw new ConflictException('Vendor must be mapped to the store merchant first');
    const existing = await this.mappings.findAssigned(store.id, merchantUuid, vendor.id);
    if (existing.length) throw new ConflictException('Vendor is already mapped to this store');
    return this.mappings.create(store.id, merchantUuid, vendor.id);
  }

  async unmap(id: string) {
    const mapping = await this.mappings.deactivate(id);
    if (!mapping) throw new NotFoundException('Active store-vendor mapping not found');
    return mapping;
  }

  async unmapByStoreAndVendor(storeId: string, vendorId: string) {
    const store = await this.merchants.getStoreById(storeId);
    if (!store) throw new NotFoundException('Store not found');
    const mapping = await this.mappings.deactivateByStoreAndVendor(store.id, vendorId);
    if (!mapping) throw new NotFoundException('Active store-vendor mapping not found');
    return mapping;
  }
}
