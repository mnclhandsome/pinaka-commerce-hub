import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';
import { StorePosConfigurationEntity } from '../../entities/store-pos-configuration.entity';
import { SavePosSafeDropDto } from './pos-safe-drop.dto';

const imagePattern = /^data:image\/(png|jpeg|jpg|webp);base64,/i;

export interface PosSafeDropRecord {
  id: string;
  store_id: string;
  merchant_id: string;
  enabled: boolean;
  primary_safe: string;
  drop_enabled: boolean;
  threshold: number | null;
  minimum: number | null;
  maximum: number | null;
  manager_approval: boolean;
  cashier_initiated: boolean;
  reason_required: boolean;
  tube_size: number | null;
  tubes: Array<{ id: string; amount: number; quantity: number }>;
  drops: Array<{ id: string; amount: number; image_name: string; image_data: string }>;
  created_at: Date;
  updated_at: Date;
}

type AuthenticatedActor = {
  id?: string;
  accountId?: string;
  merchantId?: string;
  storeId?: string;
} | undefined;

@Injectable()
export class PosSafeDropService {
  constructor(@Inject(MerchantRepository) private readonly merchants: MerchantRepository) {}

  async get(storeId: string): Promise<{ success: true; safe_drop: PosSafeDropRecord }> {
    const store = await this.requireStore(storeId);
    const record = await this.findConfiguration(store.id);
    if (!record) throw new NotFoundException('Safe and safe drop settings are not configured for this store');
    return { success: true, safe_drop: this.present(record, store.id, store.merchantId) };
  }

  async getStatus(storeId: string, actor: AuthenticatedActor) {
    if (!actor?.id) throw new ForbiddenException('Authenticated user is required');
    const store = await this.requireStore(storeId);
    if (actor.storeId && actor.storeId !== store.id) {
      throw new ForbiddenException('Store does not belong to the authenticated session');
    }
    if (actor.merchantId && actor.merchantId !== store.merchantId) {
      throw new ForbiddenException('Store does not belong to the authenticated merchant');
    }

    if (!actor.storeId && actor.merchantId !== store.merchantId) {
      const membership = await this.merchants.requireDataSource().query(
        `SELECT 1
           FROM public.merchants m
          WHERE m.id::text = $1
            AND (
              NULLIF(to_jsonb(m)->>'created_by', '') = $2
              OR EXISTS (
                SELECT 1 FROM public.employees e
                 WHERE e.merchant_id::text = m.id::text
                   AND (e.id::text = $2 OR e.user_id::text = $2)
              )
              OR EXISTS (
                SELECT 1 FROM public.users u
                 WHERE u.id::text = $2
                   AND u."accountId"::text = $3
                   AND lower(u.email) = lower(m.email)
              )
            )
          LIMIT 1`,
        [store.merchantId, actor.id, actor.accountId ?? null],
      );
      if (!membership.length) {
        throw new ForbiddenException('Store does not belong to the authenticated merchant');
      }
    }

    const configRow = await this.findConfiguration(store.id);
    const config = configRow?.configurationValue;
    const readFlag = (value: unknown): boolean | null => {
      if (value === true || value === 1 || value === '1' || value === 'true' || value === 'yes') {
        return true;
      }
      if (value === false || value === 0 || value === '0' || value === 'false' || value === 'no') {
        return false;
      }
      return null;
    };
    const configuredFlag = (keys: string[]) => {
      for (const key of keys) {
        if (config?.[key] !== undefined && config[key] !== null) {
          return readFlag(config[key]);
        }
      }
      return null;
    };
    // The PCH configuration screen stores these canonical keys. Keep them
    // ahead of legacy aliases so an old alias cannot mask the saved setting.
    const safeEnabled = configuredFlag(['enabled', 'safe_enabled', 'safeEnabled']);
    const safeDropEnabled = configuredFlag([
      'dropEnabled',
      'safe_drop_enabled',
      'safeDropEnabled',
      'drop_enabled',
    ]);
    return {
      success: true,
      store_id: store.id,
      data: {
        safe_enabled: safeEnabled ?? false,
        safe_drop_enabled: safeDropEnabled ?? false,
      },
    };
  }

  async create(storeId: string, body: SavePosSafeDropDto) {
    const store = await this.requireStore(storeId);
    this.assertRules(body);
    if (await this.findConfiguration(store.id)) {
      throw new ConflictException('Safe and safe drop settings already exist for this store');
    }
    const record = await this.saveConfiguration(store.id, body);
    return { success: true, safe_drop: this.present(record, store.id, store.merchantId) };
  }

  async update(storeId: string, body: SavePosSafeDropDto) {
    const store = await this.requireStore(storeId);
    this.assertRules(body);
    const current = await this.findConfiguration(store.id);
    if (!current) throw new NotFoundException('Safe and safe drop settings are not configured for this store');
    const record = await this.saveConfiguration(store.id, body, current);
    return { success: true, safe_drop: this.present(record, store.id, store.merchantId) };
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

  private configurationRepository() {
    return this.merchants.requireDataSource().getRepository(StorePosConfigurationEntity);
  }

  private findConfiguration(storeId: string) {
    return this.configurationRepository().findOne({
      where: { storeId, configurationName: 'safe_and_safe_drop' },
    });
  }

  private money(value: number | undefined) {
    const amount = Number(value);
    return !Number.isFinite(amount) || amount <= 0 ? null : String(amount);
  }

  private boolean(value: unknown): boolean {
    return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
  }

  private async saveConfiguration(
    storeId: string,
    body: SavePosSafeDropDto,
    existing?: StorePosConfigurationEntity,
  ) {
    const repository = this.configurationRepository();
    const previous = existing?.configurationValue ?? {};
    const configurationValue: Record<string, unknown> = {
      ...previous,
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
      tubes: (body.tubes || []).map(item => ({
        id: item.id ?? randomUUID(),
        amount: Number(item.amount),
        quantity: item.quantity,
      })),
      drops: (body.drops || []).map(item => ({
        id: item.id ?? randomUUID(),
        amount: Number(item.amount),
        imageName: item.imageName.trim() || 'denomination',
        imageData: item.imageData,
      })),
    };
    const configuration = existing ?? repository.create({
      storeId,
      configurationName: 'safe_and_safe_drop',
      configurationValue,
    });
    configuration.configurationValue = configurationValue;
    return repository.save(configuration);
  }

  private present(
    record: StorePosConfigurationEntity,
    storeId: string,
    merchantId: string,
  ): PosSafeDropRecord {
    const value = record.configurationValue ?? {};
    const numberOrNull = (item: unknown) => item === null || item === undefined ? null : Number(item);
    return {
      id: record.id,
      store_id: storeId,
      merchant_id: merchantId,
      enabled: this.boolean(value.enabled ?? value.safe_enabled ?? value.safeEnabled),
      primary_safe: String(value.primarySafe ?? value.primary_safe ?? ''),
      drop_enabled: this.boolean(value.dropEnabled ?? value.safe_drop_enabled ?? value.drop_enabled),
      threshold: numberOrNull(value.threshold),
      minimum: numberOrNull(value.minimum),
      maximum: numberOrNull(value.maximum),
      manager_approval: this.boolean(value.managerApproval ?? value.manager_approval),
      cashier_initiated: this.boolean(value.cashierInitiated ?? value.cashier_initiated),
      reason_required: this.boolean(value.reasonRequired ?? value.reason_required),
      tube_size: numberOrNull(value.tubeSize ?? value.tube_size),
      tubes: Array.isArray(value.tubes) ? value.tubes.map((item: any) => ({
        id: String(item.id ?? randomUUID()),
        amount: Number(item.amount),
        quantity: Number(item.quantity),
      })) : [],
      drops: Array.isArray(value.drops) ? value.drops.map((item: any) => ({
        id: String(item.id ?? randomUUID()),
        amount: Number(item.amount),
        image_name: String(item.imageName ?? item.image_name ?? ''),
        image_data: String(item.imageData ?? item.image_data ?? ''),
      })) : [],
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }
}
