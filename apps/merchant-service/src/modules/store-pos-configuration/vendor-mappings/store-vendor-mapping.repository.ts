import { Inject, Injectable } from '@nestjs/common';
import { MerchantRepository } from '../../merchant/merchant.repository';

@Injectable()
export class StoreVendorMappingRepository {
  constructor(@Inject(MerchantRepository) private readonly merchants: MerchantRepository) {}

  async listForStore(storeId: string, merchantId: string) {
    return this.merchants.requireDataSource().query(
      `SELECT v.id AS vendor_id, v.vendor_code, v.vendor_name, v.vendor_type,
              v.contact_person, v.phone, v.email, v.product_category,
              (vs.id IS NOT NULL AND vs.is_mapped = true AND vs.status = 'ACTIVE') AS assigned,
              COALESCE(vs.is_mapped, false) AS is_mapped,
              vs.id AS mapping_id, vs.status AS mapping_status
       FROM public.merchant_vendors mv
       JOIN public.vendors v ON v.id = mv.vendor_id
       LEFT JOIN public.vendor_stores vs
         ON vs.vendor_id = v.id AND vs.store_id = $2::uuid AND vs.merchant_id = $1::uuid
       WHERE mv.merchant_id = $1::uuid AND mv.status = 'ACTIVE'
         AND v.is_deleted = false AND v.status = 'ACTIVE'
       ORDER BY assigned DESC, v.vendor_name ASC, v.id ASC`,
      [merchantId, storeId],
    );
  }

  async findAssigned(storeId: string, merchantId: string, vendorId?: string) {
    return this.merchants.requireDataSource().query(
      `SELECT id, merchant_id, vendor_id, store_id, status, created_at, updated_at
       FROM public.vendor_stores
       WHERE store_id = $1::uuid AND merchant_id = $2::uuid AND status = 'ACTIVE' AND is_mapped = true
         AND ($3::uuid IS NULL OR vendor_id = $3::uuid)
       ORDER BY created_at DESC`,
      [storeId, merchantId, vendorId ?? null],
    );
  }

  async create(storeId: string, merchantId: string, vendorId: string) {
    const [mapping] = await this.merchants.requireDataSource().query(
      `INSERT INTO public.vendor_stores (store_id, merchant_id, vendor_id, status, is_mapped)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE', true)
       ON CONFLICT (vendor_id, store_id) DO UPDATE
         SET merchant_id = EXCLUDED.merchant_id, status = 'ACTIVE', is_mapped = true, updated_at = now()
       RETURNING id, merchant_id, vendor_id, store_id, status, is_mapped, created_at, updated_at`,
      [storeId, merchantId, vendorId],
    );
    return mapping;
  }

  async deactivate(id: string) {
    const [mapping] = await this.merchants.requireDataSource().query(
      `UPDATE public.vendor_stores SET status = 'INACTIVE', is_mapped = false, updated_at = now()
       WHERE id = $1::uuid AND status = 'ACTIVE' AND is_mapped = true
       RETURNING id, merchant_id, vendor_id, store_id, status, is_mapped, created_at, updated_at`,
      [id],
    );
    return mapping ?? null;
  }

  async deactivateByStoreAndVendor(storeId: string, vendorId: string) {
    const [mapping] = await this.merchants.requireDataSource().query(
      `UPDATE public.vendor_stores SET status = 'INACTIVE', is_mapped = false, updated_at = now()
       WHERE store_id = $1::uuid AND vendor_id = $2::uuid AND status = 'ACTIVE' AND is_mapped = true
       RETURNING id, merchant_id, vendor_id, store_id, status, is_mapped, created_at, updated_at`,
      [storeId, vendorId],
    );
    return mapping ?? null;
  }
}
