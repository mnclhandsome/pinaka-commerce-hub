import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';
import { FileStorageService } from '../../modules/file-storage/file-storage.service';
import { PosCashDenominationEntity } from './pos-cash-denomination.entity';
import { PosCashDenominationItemEntity } from './pos-cash-denomination-item.entity';
import { PosCashDenominationItemDto, SavePosCashDenominationDto } from './pos-cash-denomination.dto';

export interface PosCashDenominationItem {
  id: string;
  amount: number;
  imageName: string;
  imageData: string;
}

export interface PosCashDenominationRecord {
  id: string;
  storeId: string;
  merchantId: string;
  cashDenominations: PosCashDenominationItem[];
  coinDenominations: PosCashDenominationItem[];
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class PosCashDenominationService {
  constructor(
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
    @Inject(FileStorageService) private readonly files: FileStorageService,
  ) {}

  async get(storeId: string): Promise<{ success: true; cashDenominations: PosCashDenominationRecord }> {
    const store = await this.requireStore(storeId);
    const record = await this.findByStore(store.id);
    if (!record) throw new NotFoundException('Cash denominations are not configured for this store');
    return { success: true, cashDenominations: await this.withItems(record) };
  }

  async create(storeId: string, body: SavePosCashDenominationDto) {
    const store = await this.requireStore(storeId);
    const scope = await this.imageScope(store);
    this.assertImages(body, scope);
    if (await this.findByStore(store.id)) {
      throw new ConflictException('Cash denominations already exist for this store');
    }
    return { success: true, cashDenominations: await this.write(store, scope, body, null) };
  }

  async update(storeId: string, body: SavePosCashDenominationDto) {
    const store = await this.requireStore(storeId);
    const scope = await this.imageScope(store);
    this.assertImages(body, scope);
    const current = await this.findByStore(store.id);
    if (!current) throw new NotFoundException('Cash denominations are not configured for this store');
    return { success: true, cashDenominations: await this.write(store, scope, body, current.id) };
  }

  private async requireStore(storeId: string) {
    const store = await this.merchants.getStoreById(storeId);
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  private assertImages(
    body: SavePosCashDenominationDto,
    scope: { merchantName: string; storeName: string },
  ) {
    const items = [...(body.cashDenominations || []), ...(body.coinDenominations || [])];
    const accepted = (value: string) =>
      this.files.isDataImage(value) ||
      this.files.isWithinDirectory(value, scope);
    if (items.some(item => !accepted(item.imageData || ''))) {
      throw new BadRequestException('Each denomination image must be a PNG, JPG, or WEBP data URL or an upload URL for this store');
    }
  }

  private repo() {
    return this.merchants.requireDataSource().getRepository(PosCashDenominationEntity);
  }

  private async findByStore(storeId: string) {
    return this.repo().findOne({ where: { storeId } });
  }

  private async write(
    store: { id: string; merchantId: string; storeName: string },
    scope: { merchantName: string; storeName: string },
    body: SavePosCashDenominationDto,
    existingId: string | null,
  ): Promise<PosCashDenominationRecord> {
    const previous = existingId ? await this.findItems(existingId) : [];
    const written: string[] = [];
    const cash = await this.persistImages(scope, body.cashDenominations || [], written);
    const coins = await this.persistImages(scope, body.coinDenominations || [], written);
    try {
      const db = this.merchants.requireDataSource();
      const record = await db.transaction(async manager => {
        const settings = manager.getRepository(PosCashDenominationEntity);
        const items = manager.getRepository(PosCashDenominationItemEntity);
        const row = existingId
          ? await settings.save({ id: existingId, storeId: store.id, merchantId: store.merchantId })
          : await settings.save(settings.create({ storeId: store.id, merchantId: store.merchantId }));

        await items.delete({ denominationId: row.id });
        const rows = [
          ...this.itemRows(row.id, 'cash', cash),
          ...this.itemRows(row.id, 'coin', coins),
        ];
        const saved = rows.length ? await items.save(rows.map(item => items.create(item))) : [];
        return this.present(row, saved);
      });
      const kept = new Set([...cash, ...coins].map(item => item.imageData));
      for (const item of previous) {
        if (!kept.has(item.imageData)) await this.files.removeStoredFile(item.imageData, scope);
      }
      return record;
    } catch (error) {
      for (const url of written) await this.files.removeStoredFile(url, scope);
      throw error;
    }
  }

  private async persistImages(
    scope: { merchantName: string; storeName: string },
    list: PosCashDenominationItemDto[],
    written: string[],
  ) {
    const saved: PosCashDenominationItemDto[] = [];
    for (const item of list) {
      const created = this.files.isDataImage(item.imageData);
      const imageData = await this.files.storeImageData({
        merchantName: scope.merchantName,
        storeName: scope.storeName,
        imageName: item.imageName,
        imageData: item.imageData,
      });
      if (created) written.push(imageData);
      saved.push({ ...item, imageData });
    }
    return saved;
  }

  private async imageScope(store: { merchantId: string; storeName: string }) {
    const { merchant } = await this.merchants.getMerchantById(store.merchantId);
    if (!merchant) throw new NotFoundException('Merchant not found');
    return {
      merchantName: merchant.businessDisplayName || merchant.merchantCode || merchant.merchantId || 'merchant',
      storeName: store.storeName || 'store',
    };
  }

  private async findItems(denominationId: string) {
    return this.merchants.requireDataSource().getRepository(PosCashDenominationItemEntity).find({
      where: { denominationId },
      order: { sortOrder: 'ASC' },
    });
  }

  private itemRows(denominationId: string, kind: 'cash' | 'coin', list: PosCashDenominationItemDto[]) {
    return list.map((item, index) => ({
      denominationId,
      kind,
      amount: String(item.amount),
      imageName: item.imageName.trim() || 'denomination',
      imageData: item.imageData,
      sortOrder: index,
    }));
  }

  private async withItems(record: PosCashDenominationEntity): Promise<PosCashDenominationRecord> {
    const items = await this.findItems(record.id);
    await this.materializeImages(record, items);
    return this.present(record, items);
  }

  private async materializeImages(
    record: PosCashDenominationEntity,
    items: PosCashDenominationItemEntity[],
  ) {
    const pending = items.filter(item => this.files.isDataImage(item.imageData));
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
    await this.merchants.requireDataSource().getRepository(PosCashDenominationItemEntity).save(pending);
  }

  private present(record: PosCashDenominationEntity, items: PosCashDenominationItemEntity[]): PosCashDenominationRecord {
    const mapItem = (item: PosCashDenominationItemEntity): PosCashDenominationItem => ({
      id: item.id,
      amount: Number(item.amount),
      imageName: item.imageName,
      imageData: item.imageData,
    });
    return {
      id: record.id,
      storeId: record.storeId,
      merchantId: record.merchantId,
      cashDenominations: items.filter(item => item.kind === 'cash').map(mapItem),
      coinDenominations: items.filter(item => item.kind === 'coin').map(mapItem),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
