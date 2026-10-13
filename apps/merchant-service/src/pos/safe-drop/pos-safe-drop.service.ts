import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';
import { PosSafeDropEntity } from './pos-safe-drop.entity';
import { PosSafeDropTubeEntity } from './pos-safe-drop-tube.entity';
import { PosSafeDropDenominationEntity } from './pos-safe-drop-denomination.entity';
import { SavePosSafeDropDto } from './pos-safe-drop.dto';

const imagePattern = /^data:image\/(png|jpeg|jpg|webp);base64,/i;

export interface PosSafeDropRecord {
  id: string;
  storeId: string;
  merchantId: string;
  enabled: boolean;
  primarySafe: string;
  dropEnabled: boolean;
  threshold: number | null;
  minimum: number | null;
  maximum: number | null;
  managerApproval: boolean;
  cashierInitiated: boolean;
  reasonRequired: boolean;
  tubeSize: number | null;
  tubes: Array<{ id: string; amount: number; quantity: number }>;
  drops: Array<{ id: string; amount: number; imageName: string; imageData: string }>;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class PosSafeDropService {
  constructor(@Inject(MerchantRepository) private readonly merchants: MerchantRepository) {}

  async get(storeId: string): Promise<{ success: true; safeDrop: PosSafeDropRecord }> {
    const store = await this.requireStore(storeId);
    const record = await this.findByStore(store.id);
    if (!record) throw new NotFoundException('Safe and safe drop settings are not configured for this store');
    return { success: true, safeDrop: await this.withChildren(record) };
  }

  async create(storeId: string, body: SavePosSafeDropDto) {
    const store = await this.requireStore(storeId);
    this.assertRules(body);
    if (await this.findByStore(store.id)) {
      throw new ConflictException('Safe and safe drop settings already exist for this store');
    }
    return { success: true, safeDrop: await this.write(store.id, store.merchantId, body, null) };
  }

  async update(storeId: string, body: SavePosSafeDropDto) {
    const store = await this.requireStore(storeId);
    this.assertRules(body);
    const current = await this.findByStore(store.id);
    if (!current) throw new NotFoundException('Safe and safe drop settings are not configured for this store');
    return { success: true, safeDrop: await this.write(store.id, store.merchantId, body, current.id) };
  }

  private async requireStore(storeId: string) {
    const store = await this.merchants.getStoreById(storeId);
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  private assertRules(body: SavePosSafeDropDto) {
    if (body.enabled && !body.primarySafe?.trim()) {
      throw new BadRequestException('Enter a primary safe');
    }
    if (body.enabled && body.dropEnabled && Number(body.minimum) > Number(body.maximum)) {
      throw new BadRequestException('Minimum drop must not exceed maximum drop');
    }
    const unique = (values: number[], label: string) => {
      if (new Set(values).size !== values.length) {
        throw new BadRequestException(`${label} amounts must be unique`);
      }
    };
    unique((body.tubes || []).map(item => Number(item.amount)), 'Tube denomination');
    unique((body.drops || []).map(item => Number(item.amount)), 'Safe-drop denomination');
    if ((body.drops || []).some(item => !imagePattern.test(item.imageData || ''))) {
      throw new BadRequestException('Each safe-drop image must be a PNG, JPG, or WEBP data URL');
    }
  }

  private repo() {
    return this.merchants.requireDataSource().getRepository(PosSafeDropEntity);
  }

  private async findByStore(storeId: string) {
    return this.repo().findOne({ where: { storeId } });
  }

  private money(value: number | undefined) {
    const amount = Number(value);
    return !Number.isFinite(amount) || amount <= 0 ? null : String(amount);
  }

  private async write(
    storeId: string,
    merchantId: string,
    body: SavePosSafeDropDto,
    existingId: string | null,
  ): Promise<PosSafeDropRecord> {
    const db = this.merchants.requireDataSource();
    return db.transaction(async manager => {
      const settings = manager.getRepository(PosSafeDropEntity);
      const tubes = manager.getRepository(PosSafeDropTubeEntity);
      const drops = manager.getRepository(PosSafeDropDenominationEntity);
      const fields = {
        storeId,
        merchantId,
        enabled: body.enabled,
        primarySafe: body.primarySafe.trim(),
        dropEnabled: body.enabled && body.dropEnabled,
        threshold: this.money(body.threshold),
        minimum: this.money(body.minimum),
        maximum: this.money(body.maximum),
        managerApproval: body.managerApproval,
        cashierInitiated: body.cashierInitiated,
        reasonRequired: body.reasonRequired,
        tubeSize: body.tubeSize ?? null,
      };
      const row = existingId
        ? await settings.save({ id: existingId, ...fields })
        : await settings.save(settings.create(fields));

      await tubes.delete({ safeDropId: row.id });
      await drops.delete({ safeDropId: row.id });
      const savedTubes = (body.tubes || []).length
        ? await tubes.save(body.tubes.map((item, index) => tubes.create({
            ...(item.id ? { id: item.id } : {}),
            safeDropId: row.id,
            amount: String(item.amount),
            quantity: item.quantity,
            sortOrder: index,
          })))
        : [];
      const savedDrops = (body.drops || []).length
        ? await drops.save(body.drops.map((item, index) => drops.create({
            ...(item.id ? { id: item.id } : {}),
            safeDropId: row.id,
            amount: String(item.amount),
            imageName: item.imageName.trim() || 'denomination',
            imageData: item.imageData,
            sortOrder: index,
          })))
        : [];
      return this.present(row, savedTubes, savedDrops);
    });
  }

  private async withChildren(record: PosSafeDropEntity): Promise<PosSafeDropRecord> {
    const db = this.merchants.requireDataSource();
    const tubes = await db.getRepository(PosSafeDropTubeEntity).find({
      where: { safeDropId: record.id },
      order: { sortOrder: 'ASC' },
    });
    const drops = await db.getRepository(PosSafeDropDenominationEntity).find({
      where: { safeDropId: record.id },
      order: { sortOrder: 'ASC' },
    });
    return this.present(record, tubes, drops);
  }

  private present(
    record: PosSafeDropEntity,
    tubes: PosSafeDropTubeEntity[],
    drops: PosSafeDropDenominationEntity[],
  ): PosSafeDropRecord {
    const amount = (value: string | null) => value === null || value === undefined ? null : Number(value);
    return {
      id: record.id,
      storeId: record.storeId,
      merchantId: record.merchantId,
      enabled: record.enabled,
      primarySafe: record.primarySafe,
      dropEnabled: record.dropEnabled,
      threshold: amount(record.threshold),
      minimum: amount(record.minimum),
      maximum: amount(record.maximum),
      managerApproval: record.managerApproval,
      cashierInitiated: record.cashierInitiated,
      reasonRequired: record.reasonRequired,
      tubeSize: record.tubeSize,
      tubes: tubes.map(item => ({ id: item.id, amount: Number(item.amount), quantity: item.quantity })),
      drops: drops.map(item => ({
        id: item.id,
        amount: Number(item.amount),
        imageName: item.imageName,
        imageData: item.imageData,
      })),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
