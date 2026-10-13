import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, ILike, Repository } from 'typeorm';
import { MerchantRepository } from '../merchant/merchant.repository';
import { VendorEntity, VendorStatus, VendorType } from '../../entities/vendor.entity';
import { CreateVendorDto, UpdateVendorDto } from './vendor.dto';

const optionalText = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

@Injectable()
export class VendorRepository {
  private repo?: Repository<VendorEntity>;

  constructor(@Inject(MerchantRepository) private readonly merchants: MerchantRepository) {}

  private store() {
    this.repo ??= this.merchants.requireDataSource().getRepository(VendorEntity);
    return this.repo;
  }

  private assertOrganizerContact(vendorType: VendorType, contactPerson?: string | null) {
    if (vendorType === VendorType.ORGANIZER && !contactPerson?.trim()) {
      throw new BadRequestException('contactPerson is mandatory when vendorType is ORGANIZER');
    }
  }

  private async generateNextVendorCode(manager: EntityManager): Promise<string> {
    const rows: Array<{ nextNumber: string }> = await manager.query(`
      SELECT (COALESCE(MAX(SUBSTRING(vendor_code FROM '^VND_([0-9]+)$')::bigint), 0) + 1)::text AS "nextNumber"
      FROM public.vendors
      WHERE vendor_code ~ '^VND_[0-9]+$'
    `);
    return `VND_${rows[0].nextNumber.padStart(5, '0')}`;
  }

  private async assertUniqueEmail(email: string | null | undefined, repository: Repository<VendorEntity>, excludeId?: string): Promise<void> {
    const normalizedEmail = optionalText(email)?.toLowerCase();
    if (!normalizedEmail) return;

    const query = repository.createQueryBuilder('vendor').where('vendor.isDeleted = false').andWhere('LOWER(BTRIM(vendor.email)) = :email', {
      email: normalizedEmail,
    });
    if (excludeId) query.andWhere('vendor.id != :excludeId', { excludeId });

    if (await query.getExists()) {
      throw new ConflictException(`Vendor email '${normalizedEmail}' already exists`);
    }
  }

  private uniqueConflict(error: any, vendorCode?: string | null): ConflictException {
    const detail = String(error?.detail || error?.driverError?.detail || '').toLowerCase();
    const constraint = String(error?.constraint || error?.driverError?.constraint || '').toLowerCase();
    if (detail.includes('(email)') || constraint.includes('email')) {
      return new ConflictException('Vendor email already exists');
    }
    if (detail.includes('(vendor_code)') || constraint.includes('vendor_code')) {
      return new ConflictException(`Vendor code '${vendorCode || 'provided'}' already exists`);
    }
    return new ConflictException('Vendor email or code already exists');
  }

  async list(
    query: {
      vendorType?: string;
      status?: string;
      search?: string;
      isDeleted?: boolean;
    } = {},
  ): Promise<VendorEntity[]> {
    const where: Record<string, unknown> = {
      isDeleted: query.isDeleted ?? false,
    };
    if (query.vendorType) where.vendorType = query.vendorType;
    if (query.status) where.status = query.status;
    if (query.search?.trim()) {
      const search = ILike(`%${query.search.trim()}%`);
      return this.store().find({
        where: [
          { ...where, vendorName: search },
          { ...where, vendorCode: search },
          { ...where, contactPerson: search },
          { ...where, productCategory: search },
        ],
        order: { vendorName: 'ASC', id: 'ASC' },
      });
    }
    return this.store().find({
      where,
      order: { vendorName: 'ASC', id: 'ASC' },
    });
  }

  async getById(id: string, isDeleted = false): Promise<VendorEntity> {
    const vendor = await this.store().findOne({ where: { id, isDeleted } });
    if (!vendor) throw new NotFoundException(`Vendor '${id}' not found`);
    return vendor;
  }

  async create(dto: CreateVendorDto, actorId: string): Promise<VendorEntity> {
    this.assertOrganizerContact(dto.vendorType, dto.contactPerson);
    const email = optionalText(dto.email)?.toLowerCase();
    let vendorCode = optionalText(dto.vendorCode);
    try {
      return await this.merchants.requireDataSource().transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(724621, 43)');
        const repository = manager.getRepository(VendorEntity);
        await this.assertUniqueEmail(email, repository);
        vendorCode ??= await this.generateNextVendorCode(manager);
        const entity = repository.create({
          vendorName: dto.vendorName.trim(),
          vendorType: dto.vendorType,
          vendorCode,
          createdBy: actorId,
          updatedBy: null,
          updatedAt: null as unknown as Date,
          contactPerson: optionalText(dto.contactPerson),
          phone: optionalText(dto.phone),
          email,
          productCategory: optionalText(dto.productCategory),
          addressLine1: optionalText(dto.addressLine1),
          addressLine2: optionalText(dto.addressLine2),
          city: optionalText(dto.city),
          state: optionalText(dto.state),
          zipCode: optionalText(dto.zipCode),
          country: optionalText(dto.country),
          status: dto.status || VendorStatus.ACTIVE,
        });
        await repository.insert(entity);
        return repository.findOneByOrFail({ id: entity.id });
      });
    } catch (error: any) {
      if (error?.code === '23505' || error?.driverError?.code === '23505') {
        throw this.uniqueConflict(error, vendorCode);
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateVendorDto, actorId: string): Promise<VendorEntity> {
    try {
      return await this.merchants.requireDataSource().transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(724621, 43)');
        const repository = manager.getRepository(VendorEntity);
        const existing = await repository.findOne({
          where: { id, isDeleted: false },
        });
        if (!existing) throw new NotFoundException(`Vendor '${id}' not found`);

        if (dto.email !== undefined) {
          const email = optionalText(dto.email)?.toLowerCase();
          await this.assertUniqueEmail(email, repository, id);
          existing.email = email ?? null;
        }
        if (dto.vendorName !== undefined) existing.vendorName = dto.vendorName.trim();
        if (dto.vendorType !== undefined) existing.vendorType = dto.vendorType;
        if (dto.vendorCode !== undefined) {
          const vendorCode = optionalText(dto.vendorCode);
          if (vendorCode) existing.vendorCode = vendorCode;
        }
        if (dto.contactPerson !== undefined) existing.contactPerson = optionalText(dto.contactPerson);
        if (dto.phone !== undefined) existing.phone = optionalText(dto.phone);
        if (dto.productCategory !== undefined) existing.productCategory = optionalText(dto.productCategory);
        if (dto.addressLine1 !== undefined) existing.addressLine1 = optionalText(dto.addressLine1);
        if (dto.addressLine2 !== undefined) existing.addressLine2 = optionalText(dto.addressLine2);
        if (dto.city !== undefined) existing.city = optionalText(dto.city);
        if (dto.state !== undefined) existing.state = optionalText(dto.state);
        if (dto.zipCode !== undefined) existing.zipCode = optionalText(dto.zipCode);
        if (dto.country !== undefined) existing.country = optionalText(dto.country);
        if (dto.status !== undefined) existing.status = dto.status;
        existing.updatedBy = actorId;
        this.assertOrganizerContact(existing.vendorType, existing.contactPerson);
        return repository.save(existing);
      });
    } catch (error: any) {
      if (error?.code === '23505' || error?.driverError?.code === '23505') {
        throw this.uniqueConflict(error, dto.vendorCode);
      }
      throw error;
    }
  }

  async remove(id: string, actorId: string): Promise<void> {
    await this.getById(id);
    const deletedAt = new Date();
    await this.store().update({ id, isDeleted: false }, { isDeleted: true, deletedAt, updatedAt: deletedAt, updatedBy: actorId });
  }

  private async requireMerchantUuid(merchantId: string): Promise<string> {
    const uuid = await this.merchants.resolveMerchantUuid(merchantId);
    if (!uuid) throw new NotFoundException(`Merchant '${merchantId}' not found`);
    return uuid;
  }

  async listMerchantVendors(merchantId: string, query: { search?: string; vendorType?: string; status?: string } = {}): Promise<any[]> {
    const merchantUuid = await this.requireMerchantUuid(merchantId);
    const db = this.merchants.requireDataSource();
    const params: unknown[] = [merchantUuid];
    let sql = `
      SELECT v.*, mv.status AS "assignmentStatus", mv.id AS "assignmentId", true AS assigned,
             (SELECT COUNT(DISTINCT vs.store_id)::int
              FROM public.vendor_stores vs
              WHERE vs.vendor_id = v.id
                AND vs.merchant_id = mv.merchant_id
                AND vs.status = 'ACTIVE'
                AND vs.is_mapped = true) AS "assignedStoreCount"
      FROM public.merchant_vendors mv
      JOIN public.vendors v ON v.id = mv.vendor_id
      WHERE mv.merchant_id = $1
        AND mv.status = 'ACTIVE'
        AND v.is_deleted = false
    `;
    if (query.status) {
      params.push(query.status);
      sql += ` AND v.status = $${params.length}`;
    }
    if (query.vendorType) {
      params.push(query.vendorType);
      sql += ` AND v.vendor_type = $${params.length}`;
    }
    if (query.search?.trim()) {
      params.push(`%${query.search.trim()}%`);
      const i = params.length;
      sql += ` AND (
        v.vendor_name ILIKE $${i}
        OR COALESCE(v.vendor_code, '') ILIKE $${i}
        OR COALESCE(v.contact_person, '') ILIKE $${i}
        OR COALESCE(v.product_category, '') ILIKE $${i}
      )`;
    }
    sql += ` ORDER BY v.vendor_name ASC, v.id ASC`;
    return db.query(sql, params);
  }

  async listAllVendorsWithAssignment(merchantId: string, query: { search?: string; vendorType?: string; status?: string } = {}): Promise<any[]> {
    const merchantUuid = await this.requireMerchantUuid(merchantId);
    const db = this.merchants.requireDataSource();
    const params: unknown[] = [merchantUuid];
    let sql = `
      SELECT v.*,
             CASE WHEN mv.id IS NOT NULL AND mv.status = 'ACTIVE' THEN true ELSE false END AS assigned,
             mv.status AS "assignmentStatus",
             mv.id AS "assignmentId"
      FROM public.vendors v
      LEFT JOIN public.merchant_vendors mv
        ON mv.vendor_id = v.id AND mv.merchant_id = $1
      WHERE v.is_deleted = false
    `;
    if (query.status) {
      params.push(query.status);
      sql += ` AND v.status = $${params.length}`;
    } else {
      sql += ` AND v.status = 'ACTIVE'`;
    }
    if (query.vendorType) {
      params.push(query.vendorType);
      sql += ` AND v.vendor_type = $${params.length}`;
    }
    if (query.search?.trim()) {
      params.push(`%${query.search.trim()}%`);
      const i = params.length;
      sql += ` AND (
        v.vendor_name ILIKE $${i}
        OR COALESCE(v.vendor_code, '') ILIKE $${i}
        OR COALESCE(v.contact_person, '') ILIKE $${i}
        OR COALESCE(v.product_category, '') ILIKE $${i}
      )`;
    }
    sql += ` ORDER BY assigned DESC, v.vendor_name ASC, v.id ASC`;
    return db.query(sql, params);
  }

  async addMerchantVendors(merchantId: string, vendorIds: string[]): Promise<{ count: number; vendorIds: string[] }> {
    const merchantUuid = await this.requireMerchantUuid(merchantId);
    const db = this.merchants.requireDataSource();
    const uniqueIds = [...new Set(vendorIds.map(String))];
    if (!uniqueIds.length) throw new BadRequestException('vendorIds is required');

    const found = await db.query(`SELECT id FROM public.vendors WHERE id = ANY($1::uuid[]) AND is_deleted = false`, [uniqueIds]);
    if (found.length !== uniqueIds.length) {
      throw new NotFoundException('One or more vendors were not found');
    }

    await db.query(
      `INSERT INTO public.merchant_vendors (merchant_id, vendor_id, status)
       SELECT $1::uuid, x.vendor_id, 'ACTIVE'
       FROM unnest($2::uuid[]) AS x(vendor_id)
       ON CONFLICT (merchant_id, vendor_id) DO UPDATE
         SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP`,
      [merchantUuid, uniqueIds],
    );
    return { count: uniqueIds.length, vendorIds: uniqueIds };
  }

  async removeMerchantVendor(merchantId: string, vendorId: string): Promise<void> {
    const merchantUuid = await this.requireMerchantUuid(merchantId);
    const db = this.merchants.requireDataSource();
    const result = await db.query(
      `DELETE FROM public.merchant_vendors
       WHERE merchant_id = $1::uuid AND vendor_id = $2::uuid
       RETURNING id`,
      [merchantUuid, vendorId],
    );
    if (!result.length) throw new NotFoundException('Merchant vendor mapping not found');
  }
}
