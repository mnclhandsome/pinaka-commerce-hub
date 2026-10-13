import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';
import { PosCashDenominationEntity } from './pos-cash-denomination.entity';
import { PosCashDenominationItemEntity } from './pos-cash-denomination-item.entity';
import { PosCashDenominationItemDto, SavePosCashDenominationDto } from './pos-cash-denomination.dto';

const imagePattern = /^data:image\/(png|jpeg|jpg|webp);base64,/i;

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
  constructor(@Inject(MerchantRepository) private readonly merchants: MerchantRepository) {}

  async get(storeId: string): Promise<{ success: true; cashDenominations: PosCashDenominationRecord }> {
    const store = await this.requireStore(storeId);
    const record = await this.findByStore(store.id);
    if (!record) throw new NotFoundException('Cash denominations are not configured for this store');
    return { success: true, cashDenominations: await this.withItems(record) };
  }

  async create(storeId: string, body: SavePosCashDenominationDto) {
    const store = await this.requireStore(storeId);
    this.assertImages(body);
    if (await this.findByStore(store.id)) {
      throw new ConflictException('Cash denominations already exist for this store');
    }
    return { success: true, cashDenominations: await this.write(store.id, store.merchantId, body, null) };
  }

  async update(storeId: string, body: SavePosCashDenominationDto) {
    const store = await this.requireStore(storeId);
    this.assertImages(body);
    const current = await this.findByStore(store.id);
    if (!current) throw new NotFoundException('Cash denominations are not configured for this store');
    return { success: true, cashDenominations: await this.write(store.id, store.merchantId, body, current.id) };
  }

  private async requireStore(storeId: string) {
    const store = await this.merchants.getStoreById(storeId);
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  private assertImages(body: SavePosCashDenominationDto) {
    const items = [...(body.cashDenominations || []), ...(body.coinDenominations || [])];
    if (items.some(item => !imagePattern.test(item.imageData || ''))) {
      throw new BadRequestException('Each denomination image must be a PNG, JPG, or WEBP data URL');
    }
  }

  private repo() {
    return this.merchants.requireDataSource().getRepository(PosCashDenominationEntity);
  }

  private async findByStore(storeId: string) {
    return this.repo().findOne({ where: { storeId } });
  }

  private async write(
    storeId: string,
    merchantId: string,
    body: SavePosCashDenominationDto,
    existingId: string | null,
  ): Promise<PosCashDenominationRecord> {
    const db = this.merchants.requireDataSource();
    return db.transaction(async manager => {
      const settings = manager.getRepository(PosCashDenominationEntity);
      const items = manager.getRepository(PosCashDenominationItemEntity);
      const row = existingId
        ? await settings.save({ id: existingId, storeId, merchantId })
        : await settings.save(settings.create({ storeId, merchantId }));

      await items.delete({ denominationId: row.id });
      const rows = [
        ...this.itemRows(row.id, 'cash', body.cashDenominations || []),
        ...this.itemRows(row.id, 'coin', body.coinDenominations || []),
      ];
      const saved = rows.length ? await items.save(rows.map(item => items.create(item))) : [];
      return this.present(row, saved);
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
    const items = await this.merchants.requireDataSource().getRepository(PosCashDenominationItemEntity).find({
      where: { denominationId: record.id },
      order: { sortOrder: 'ASC' },
    });
    return this.present(record, items);
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
