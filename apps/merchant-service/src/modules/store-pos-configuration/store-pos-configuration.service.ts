import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { MerchantRepository } from '../merchant/merchant.repository';
import { StorePosConfigurationEntity } from '../../entities/store-pos-configuration.entity';
import { CreateStorePosConfigurationDto } from './dto/create-store-pos-configuration.dto';
import { UpdateStorePosConfigurationDto } from './dto/update-store-pos-configuration.dto';
import { CashBackSettingsResponse, mapCashbackSettings } from './cashback-settings.model';

@Injectable()
export class StorePosConfigurationsService {
  constructor(@Inject(MerchantRepository) private readonly merchants: MerchantRepository) {}

  private repository(): Repository<StorePosConfigurationEntity> {
    return this.merchants.requireDataSource().getRepository(StorePosConfigurationEntity);
  }

  /** Accepts a store UUID or a store code such as STORE-001. */
  private async storeUuid(storeKey: string): Promise<string> {
    const store = await this.merchants.getStoreById(storeKey);
    if (!store) throw new NotFoundException(`Store "${storeKey}" not found`);
    return store.id;
  }

  /**
   * Create a new POS configuration.
   */
  async create(
    dto: CreateStorePosConfigurationDto,
    actorId?: string,
  ): Promise<StorePosConfigurationEntity> {
    const storeId = await this.storeUuid(dto.storeId);
    const existing = await this.repository().findOne({
      where: {
        storeId,
        configurationName: dto.configurationName,
      },
    });

    if (existing) {
      throw new ConflictException(
        `Configuration "${dto.configurationName}" already exists for this store.`,
      );
    }

    const actor = dto.createdBy || actorId || null;
    const configuration = this.repository().create({
      storeId,
      configurationName: dto.configurationName,
      configurationValue: dto.configurationValue,
      createdBy: actor,
      updatedBy: actor,
    });

    return this.repository().save(configuration);
  }

  /**
   * Get all configurations for a store.
   */
  async findByStoreId(
    storeId: string,
  ): Promise<StorePosConfigurationEntity[]> {
    const resolvedStoreId = await this.storeUuid(storeId);
    return this.repository().find({
      where: {
        storeId: resolvedStoreId,
      },
      order: {
        configurationName: 'ASC',
      },
    });
  }

  /**
   * Get one configuration by store ID and configuration name.
   */
  async findOne(
    storeId: string,
    configurationName: string,
  ): Promise<StorePosConfigurationEntity> {
    const resolvedStoreId = await this.storeUuid(storeId);
    const configuration = await this.repository().findOne({
      where: {
        storeId: resolvedStoreId,
        configurationName,
      },
    });

    if (!configuration) {
      throw new NotFoundException(
        `Configuration "${configurationName}" not found for store "${storeId}".`,
      );
    }

    return configuration;
  }

  /**
   * POS cashback reads the stored row and returns the cash_back_service model.
   * Every other configuration name keeps the stored row.
   */
  async findPresented(
    storeId: string,
    configurationName: string,
  ): Promise<StorePosConfigurationEntity | CashBackSettingsResponse> {
    const configuration = await this.findOne(storeId, configurationName);
    if (configurationName === 'cashback_settings') {
      return mapCashbackSettings(configuration.configurationValue);
    }
    return configuration;
  }

  /**
   * Get only configuration JSON by store ID and name.
   */
  async getConfigurationValue(
    storeId: string,
    configurationName: string,
  ): Promise<Record<string, unknown>> {
    const configuration = await this.findOne(
      storeId,
      configurationName,
    );

    return configuration.configurationValue;
  }

  /**
   * Update an existing configuration.
   */
  async update(
    storeId: string,
    configurationName: string,
    dto: UpdateStorePosConfigurationDto,
    actorId?: string,
  ): Promise<StorePosConfigurationEntity> {
    const configuration = await this.findOne(
      storeId,
      configurationName,
    );

    if (
      dto.configurationName &&
      dto.configurationName !== configurationName
    ) {
      const duplicate = await this.repository().findOne({
        where: {
          storeId: configuration.storeId,
          configurationName: dto.configurationName,
        },
      });

      if (duplicate) {
        throw new ConflictException(
          `Configuration "${dto.configurationName}" already exists for this store.`,
        );
      }

      configuration.configurationName = dto.configurationName;
    }

    if (dto.configurationValue !== undefined) {
      configuration.configurationValue = dto.configurationValue;
    }

    const actor = dto.updatedBy || actorId;
    if (actor) configuration.updatedBy = actor;

    return this.repository().save(configuration);
  }

  /**
   * Create or update configuration.
   *
   * This is useful for the frontend configuration screen.
   */
  async upsert(
    dto: CreateStorePosConfigurationDto,
    actorId?: string,
  ): Promise<StorePosConfigurationEntity> {
    const storeId = await this.storeUuid(dto.storeId);
    const existing = await this.repository().findOne({
      where: {
        storeId,
        configurationName: dto.configurationName,
      },
    });
    const actor = dto.createdBy || actorId || null;

    if (existing) {
      existing.configurationValue = dto.configurationValue;
      if (actor) existing.updatedBy = actor;

      return this.repository().save(existing);
    }

    const configuration = this.repository().create({
      storeId,
      configurationName: dto.configurationName,
      configurationValue: dto.configurationValue,
      createdBy: actor,
      updatedBy: actor,
    });

    return this.repository().save(configuration);
  }

  /**
   * Delete configuration.
   */
  async remove(
    storeId: string,
    configurationName: string,
  ): Promise<void> {
    const configuration = await this.findOne(
      storeId,
      configurationName,
    );

    await this.repository().remove(configuration);
  }

  
  
  
  async getStoreInfo(storeId: string): Promise<Record<string, unknown>> {
    const resolvedStoreId = await this.storeUuid(storeId);
    const configurations = await this.repository().find({
      where: { storeId: resolvedStoreId },
    });
    const configByName = new Map(
      configurations.map((row) => [row.configurationName, this.asObject(row.configurationValue)]),
    );
    const taxesConfig = configByName.get('currency_taxes') ?? null;
    const cashConfig = configByName.get('cash_denominations') ?? null;
    const safeConfig = configByName.get('safe_and_safe_drop') ?? null;
    const registerConfig = configByName.get('cash_register_settings') ?? null;

    const storeRows = await this.optionalRows(
      `SELECT store_website_url, store_name, address_line1, city, state, country, postal_code, phone
       FROM public.stores
       WHERE id = $1::uuid
       LIMIT 1`,
      [resolvedStoreId],
    );
    const store = storeRows[0] ?? {};

    const taxes = this.taxList(taxesConfig);
    const currency = this.textOrNull(taxesConfig?.currency);
    const currencySymbol = this.textOrNull(taxesConfig?.currencySymbol);
    const [notesDenom, coinDenom] = await this.cashDenominations(resolvedStoreId, cashConfig);
    const safe = await this.safeDrop(resolvedStoreId, safeConfig, currencySymbol);
    const roles = await this.storeRoles(resolvedStoreId);
    const vendors = await this.storeVendors(resolvedStoreId);
    const vendorPaymentTypes = await this.storeTenderNames(resolvedStoreId);
    const employees = await this.storeEmployees(resolvedStoreId);

    return {
      base_url: this.textOrNull(store.store_website_url),
      currency,
      currencySymbol,
      taxes,
      roles,
      store_details: {
        name: this.textOrNull(store.store_name),
        address: this.textOrNull(store.address_line1),
        city: this.textOrNull(store.city),
        state: this.textOrNull(store.state),
        country: this.textOrNull(store.country),
        zip_code: this.textOrNull(store.postal_code),
        phone_number: this.textOrNull(store.phone),
      },
      notes_denom: notesDenom,
      coin_denom: coinDenom,
      safe_denom: safe.denominations,
      tubes_denom: safe.tubes,
      max_tubes_count: safe.maxTubesCount,
      safe_drop_amount: safe.safeDropAmount,
      drawer_amount: await this.drawerAmount(resolvedStoreId, registerConfig),
      vendors,
      vendor_payment_types: vendorPaymentTypes,
      employees,
      order_types: [
        { slug: 'rest-api', name: 'Shop Order' },
        { slug: 'doordash', name: 'Takeaway Order' },
        { slug: 'uber-eats', name: 'Uber Eats Order' },
        { slug: 'online', name: 'Online Order' },
      ],
    };
  }

  private taxList(taxesConfig: Record<string, unknown> | null): Array<{ slug: string; name: string }> {
    const taxClasses = taxesConfig?.taxClasses;
    if (!Array.isArray(taxClasses)) return [];
    return taxClasses.flatMap((tax) => {
      const name = this.textOrNull((tax as { name?: unknown })?.name);
      const slug = name ? name.toLowerCase().replace(/\s+/g, '_') : null;
      return name && slug ? [{ slug, name }] : [];
    });
  }

  private async storeRoles(storeId: string): Promise<Array<{ slug: string | null; name: string | null }>> {
    const rows = await this.optionalRows(
      `SELECT rt.role_code AS slug, rt.name AS name
       FROM public.store_role_templates srt
       JOIN public.role_templates rt ON rt.id = srt.role_template_id
       WHERE srt.store_id = $1::uuid
         AND COALESCE(srt.enabled, true) = true
         AND upper(COALESCE(srt.status, 'ACTIVE')) <> 'INACTIVE'
       ORDER BY rt.name ASC`,
      [storeId],
    );
    return rows.map((row) => ({
      slug: this.slug(row.slug ?? row.name),
      name: this.textOrNull(row.name),
    }));
  }

  private async cashDenominations(
    storeId: string,
    config: Record<string, unknown> | null,
  ): Promise<[Array<{ denom: string | null; image: string | null }>, Array<{ denom: string | null; image: string | null }>]> {
    const notes = this.denomList(config?.cashDenominations ?? config?.notes);
    const coins = this.denomList(config?.coinDenominations ?? config?.coins);
    if (notes.length || coins.length) return [notes, coins];

    const rows = await this.optionalRows(
      `SELECT i.kind, i.amount AS denom, i."imageData" AS image
       FROM public.pos_cash_denomination_items i
       JOIN public.pos_cash_denomination_settings s ON s.id = i."denominationId"
       WHERE s."storeId" = $1
       ORDER BY i."sortOrder" ASC, i.amount ASC`,
      [storeId],
    );
    return [
      this.denomList(rows.filter((row) => String(row.kind).toLowerCase() === 'cash')),
      this.denomList(rows.filter((row) => String(row.kind).toLowerCase() === 'coin')),
    ];
  }

  private async safeDrop(
    storeId: string,
    config: Record<string, unknown> | null,
    currencySymbol: string | null,
  ): Promise<{
    denominations: Array<{ denom: string | null; image: string | null }>;
    tubes: Array<{ denom: number | null; tube_limit: number | null; symbol: string | null }>;
    maxTubesCount: string | null;
    safeDropAmount: string | null;
  }> {
    const configDenoms = this.denomList(config?.drops ?? config?.safeDenominations);
    const configTubes = this.tubeList(config?.tubes, currencySymbol);
    if (config || configDenoms.length || configTubes.length) {
      return {
        denominations: configDenoms,
        tubes: configTubes,
        maxTubesCount: this.moneyText(config?.tubeSize),
        safeDropAmount: this.moneyText(config?.threshold),
      };
    }

    const settings = await this.optionalRows(
      `SELECT id, threshold, tube_size AS "tubeSize"
       FROM public.pos_safe_drop_settings
       WHERE store_id = $1
       LIMIT 1`,
      [storeId],
    );
    const setting = settings[0];
    if (!setting?.id) {
      return { denominations: [], tubes: [], maxTubesCount: null, safeDropAmount: null };
    }
    const [denominations, tubes] = await Promise.all([
      this.optionalRows(
        `SELECT amount AS denom, image_data AS image
         FROM public.pos_safe_drop_denominations
         WHERE safe_drop_id = $1::uuid
         ORDER BY sort_order ASC, amount ASC`,
        [setting.id],
      ),
      this.optionalRows(
        `SELECT amount AS denom, quantity AS tube_limit
         FROM public.pos_safe_drop_tubes
         WHERE safe_drop_id = $1::uuid
         ORDER BY sort_order ASC, amount ASC`,
        [setting.id],
      ),
    ]);
    return {
      denominations: this.denomList(denominations),
      tubes: this.tubeList(tubes, currencySymbol),
      maxTubesCount: this.moneyText(setting.tubeSize),
      safeDropAmount: this.moneyText(setting.threshold),
    };
  }

  private async drawerAmount(
    storeId: string,
    config: Record<string, unknown> | null,
  ): Promise<string | null> {
    const registers = Array.isArray(config?.registers) ? config.registers : [];
    const active = registers.find((row) => String((row as { status?: unknown })?.status || '').toLowerCase() === 'active')
      ?? registers[0];
    const configured = this.moneyText((active as { maxCash?: unknown } | undefined)?.maxCash);
    if (configured !== null) return configured;

    const rows = await this.optionalRows(
      `SELECT r."maxCash" AS amount
       FROM public.pos_cash_registers r
       JOIN public.pos_cash_register_settings s ON s.id = r."registerSettingsId"
       WHERE s."storeId" = $1
         AND lower(COALESCE(r.status, 'active')) = 'active'
       ORDER BY r."sortOrder" ASC
       LIMIT 1`,
      [storeId],
    );
    return this.moneyText(rows[0]?.amount);
  }

  private async storeVendors(storeId: string): Promise<Array<{ id: string | null; vendor_name: string | null }>> {
    const rows = await this.optionalRows(
      `SELECT v.id::text AS id, v.vendor_name
       FROM public.merchant_vendors mv
       JOIN public.vendors v ON v.id = mv.vendor_id
       JOIN public.stores s ON s.merchant_id = mv.merchant_id
       WHERE s.id = $1::uuid
         AND upper(COALESCE(mv.status::text, 'ACTIVE')) = 'ACTIVE'
         AND upper(COALESCE(v.status::text, 'ACTIVE')) = 'ACTIVE'
       ORDER BY v.vendor_name ASC`,
      [storeId],
    );
    return rows.map((row) => ({
      id: this.textOrNull(row.id),
      vendor_name: this.textOrNull(row.vendor_name),
    }));
  }

  private async storeTenderNames(storeId: string): Promise<string[]> {
    const assigned = await this.optionalRows(
      `SELECT DISTINCT t.tendor_name AS name
       FROM public.merchant_tendors mt
       JOIN public.tendors t ON t.id = mt.tendor_id
       JOIN public.stores s ON s.merchant_id = mt.merchant_id
       WHERE s.id = $1::uuid
         AND upper(COALESCE(mt.status::text, 'ACTIVE')) = 'ACTIVE'
         AND upper(COALESCE(t.status::text, 'ACTIVE')) = 'ACTIVE'
       ORDER BY t.tendor_name ASC`,
      [storeId],
    );
    const source = assigned.length
      ? assigned
      : await this.optionalRows(
        `SELECT t.tendor_name AS name
         FROM public.tendors t
         JOIN public.stores s ON s.id = $1::uuid
         WHERE (t.store_type_id = s.store_type_id OR t.store_type_id IS NULL)
           AND upper(COALESCE(t.status::text, 'ACTIVE')) = 'ACTIVE'
         ORDER BY t.tendor_name ASC`,
        [storeId],
      );
    return source
      .map((row) => this.textOrNull(row.name))
      .filter((name): name is string => Boolean(name));
  }

  private async storeEmployees(storeId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.optionalRows(
      `SELECT e.id::text AS id,
              e.employee_code,
              e.username,
              e.email,
              e.first_name,
              e.last_name,
              e.status::text AS status,
              e.created_at
       FROM public.employee_stores es
       JOIN public.employees e ON e.id = es.employee_id
       WHERE es.store_id = $1::uuid
         AND upper(COALESCE(es.status, 'ACTIVE')) <> 'INACTIVE'
         AND upper(COALESCE(e.status::text, 'ACTIVE')) <> 'INACTIVE'
       ORDER BY e.first_name ASC, e.last_name ASC`,
      [storeId],
    );
    return rows.map((row) => {
      const login = this.textOrNull(row.username) || this.textOrNull(row.employee_code);
      const displayName = [row.first_name, row.last_name]
        .map((part) => this.textOrNull(part))
        .filter(Boolean)
        .join(' ') || null;
      return {
        ID: this.textOrNull(row.id),
        user_login: login,
        user_pass: null,
        user_nicename: login ? login.toLowerCase().replace(/\s+/g, '-') : null,
        user_email: this.textOrNull(row.email),
        user_url: null,
        user_registered: row.created_at ?? null,
        user_activation_key: null,
        user_status: this.textOrNull(row.status),
        display_name: displayName,
      };
    });
  }

  private denomList(value: unknown): Array<{ denom: string | null; image: string | null }> {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const row = this.asObject(item);
      if (!row) return [];
      return [{
        denom: this.moneyText(row.denom ?? row.amount),
        image: this.textOrNull(row.image ?? row.imageData ?? row.image_url),
      }];
    });
  }

  private tubeList(
    value: unknown,
    currencySymbol: string | null,
  ): Array<{ denom: number | null; tube_limit: number | null; symbol: string | null }> {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const row = this.asObject(item);
      if (!row) return [];
      const denom = Number(row.denom ?? row.amount);
      const limit = Number(row.tube_limit ?? row.quantity ?? row.tubeLimit);
      return [{
        denom: Number.isFinite(denom) ? denom : null,
        tube_limit: Number.isFinite(limit) ? limit : null,
        symbol: this.textOrNull(row.symbol) ?? currencySymbol,
      }];
    });
  }

  private async optionalRows(sql: string, params: unknown[]): Promise<Array<Record<string, any>>> {
    try {
      return await this.merchants.requireDataSource().query(sql, params);
    } catch (error) {
      const code = (error as { code?: string; driverError?: { code?: string } })?.code
        || (error as { driverError?: { code?: string } })?.driverError?.code;
      if (code === '42P01' || code === '42703') return [];
      throw error;
    }
  }

  private asObject(value: unknown): Record<string, any> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, any>;
  }

  private textOrNull(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text ? text : null;
  }

  private moneyText(value: unknown): string | null {
    const text = this.textOrNull(value);
    if (!text) return null;
    const amount = Number(text);
    if (!Number.isFinite(amount)) return text;
    return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  }

  private slug(value: unknown): string | null {
    const text = this.textOrNull(value);
    if (!text) return null;
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || null;
  }



}
