import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';
import { FileStorageService } from '../../modules/file-storage/file-storage.service';
import { PosSafeDropEntity } from './pos-safe-drop.entity';
import { PosSafeDropTubeEntity } from './pos-safe-drop-tube.entity';
import { PosSafeDropDenominationEntity } from './pos-safe-drop-denomination.entity';
import { PosSafeDropDenominationDto, SavePosSafeDropDto } from './pos-safe-drop.dto';

type ImageScope = { merchantName: string; storeName: string };

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
  constructor(
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
    @Inject(FileStorageService) private readonly files: FileStorageService,
  ) {}

  async get(storeId: string): Promise<{ success: true; safeDrop: PosSafeDropRecord }> {
    const store = await this.requireStore(storeId);
    const record = await this.findByStore(store.id);
    if (!record) throw new NotFoundException('Safe and safe drop settings are not configured for this store');
    return { success: true, safeDrop: await this.withChildren(record) };
  }

  async create(storeId: string, body: SavePosSafeDropDto) {
    const store = await this.requireStore(storeId);
    const scope = await this.imageScope(store);
    this.assertRules(body, scope);
    if (await this.findByStore(store.id)) {
      throw new ConflictException('Safe and safe drop settings already exist for this store');
    }
    return { success: true, safeDrop: await this.write(store, scope, body, null) };
  }

  async update(storeId: string, body: SavePosSafeDropDto) {
    const store = await this.requireStore(storeId);
    const scope = await this.imageScope(store);
    this.assertRules(body, scope);
    const current = await this.findByStore(store.id);
    if (!current) throw new NotFoundException('Safe and safe drop settings are not configured for this store');
    return { success: true, safeDrop: await this.write(store, scope, body, current.id) };
  }

  private async requireStore(storeId: string) {
    const store = await this.merchants.getStoreById(storeId);
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  private assertRules(body: SavePosSafeDropDto, scope: ImageScope) {
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
    const accepted = (value: string) =>
      this.files.isDataImage(value) || this.files.isWithinDirectory(value, scope);
    if ((body.drops || []).some(item => !accepted(item.imageData || ''))) {
      throw new BadRequestException('Each safe-drop image must be a PNG, JPG, or WEBP data URL or an upload URL for this store');
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
    store: { id: string; merchantId: string; storeName: string },
    scope: ImageScope,
    body: SavePosSafeDropDto,
    existingId: string | null,
  ): Promise<PosSafeDropRecord> {
    const previous = existingId ? await this.findDrops(existingId) : [];
    const written: string[] = [];
    const drops: PosSafeDropDenominationDto[] = [];
    for (const item of body.drops || []) {
      const created = this.files.isDataImage(item.imageData);
      const imageData = await this.files.storeImageData({
        merchantName: scope.merchantName,
        storeName: scope.storeName,
        imageName: item.imageName,
        imageData: item.imageData,
      });
      if (created) written.push(imageData);
      drops.push({ ...item, imageData });
    }
    try {
      const db = this.merchants.requireDataSource();
      const record = await db.transaction(async manager => {
        const settings = manager.getRepository(PosSafeDropEntity);
        const tubes = manager.getRepository(PosSafeDropTubeEntity);
        const dropRepo = manager.getRepository(PosSafeDropDenominationEntity);
        const fields = {
          storeId: store.id,
          merchantId: store.merchantId,
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
        await dropRepo.delete({ safeDropId: row.id });
        const savedTubes = (body.tubes || []).length
          ? await tubes.save(body.tubes.map((item, index) => tubes.create({
              ...(item.id ? { id: item.id } : {}),
              safeDropId: row.id,
              amount: String(item.amount),
              quantity: item.quantity,
              sortOrder: index,
            })))
          : [];
        const savedDrops = drops.length
          ? await dropRepo.save(drops.map((item, index) => dropRepo.create({
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
      const kept = new Set(drops.map(item => item.imageData));
      for (const item of previous) {
        if (!kept.has(item.imageData)) await this.files.removeStoredFile(item.imageData, scope);
      }
      return record;
    } catch (error) {
      for (const url of written) await this.files.removeStoredFile(url, scope);
      throw error;
    }
  }

  private async imageScope(store: { merchantId: string; storeName: string }): Promise<ImageScope> {
    const { merchant } = await this.merchants.getMerchantById(store.merchantId);
    if (!merchant) throw new NotFoundException('Merchant not found');
    return {
      merchantName: merchant.businessDisplayName || merchant.merchantCode || merchant.merchantId || 'merchant',
      storeName: store.storeName || 'store',
    };
  }

  private async findDrops(safeDropId: string) {
    return this.merchants.requireDataSource().getRepository(PosSafeDropDenominationEntity).find({
      where: { safeDropId },
      order: { sortOrder: 'ASC' },
    });
  }

  private async withChildren(record: PosSafeDropEntity): Promise<PosSafeDropRecord> {
    const db = this.merchants.requireDataSource();
    const tubes = await db.getRepository(PosSafeDropTubeEntity).find({
      where: { safeDropId: record.id },
      order: { sortOrder: 'ASC' },
    });
    const drops = await this.findDrops(record.id);
    await this.materializeImages(record, drops);
    return this.present(record, tubes, drops);
  }

  private async materializeImages(
    record: PosSafeDropEntity,
    drops: PosSafeDropDenominationEntity[],
  ) {
    const pending = drops.filter(item => this.files.isDataImage(item.imageData));
    if (!pending.length) return;
    const store = await this.requireStore(record.storeId);
    const scope = await this.imageScope(store);
    for (const item of pending) {
      item.imageData = await this.files.storeImageData({
        merchantName: scope.merchantName,
        storeName: scope.storeName,
        imageName: item.imageName,
        imageData: item.imageData,
      });
    }
    await this.merchants.requireDataSource().getRepository(PosSafeDropDenominationEntity).save(pending);
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
