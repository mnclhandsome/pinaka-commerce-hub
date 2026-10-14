import { groupFeaturesByCategory } from '../master/common/master-list';
import { MerchantOnboardingDto } from './onboarding.dto';
import { storeSetup } from '../master/store-setup/store-setup';
import { withPlanLicenseCounts } from './merchant-crud.service';
import * as crypto from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FeatureEntity, FeatureStatus } from '../../entities/feature.entity';
import {
  PermissionEntity,
  PermissionStatus,
} from '../../entities/permission.entity';
import {
  RoleTemplateEntity,
  RoleTemplateStatus,
  RoleScopeType,
} from '../../entities/role-template.entity';
import {
  PlanEntity,
  PlanStatus,
  PlanBillingModel,
  PlanBillingCycle,
} from '../../entities/plan.entity';
import { RoleEntity, RoleStatus } from '../../entities/role.entity';
import { MerchantRoleTemplateEntity } from '../../entities/merchant-role-template.entity';
import {
  CreateMerchantRoleTemplateDto,
  UpdateMerchantRoleTemplateDto,
} from '../master/role-templates/merchant-role-template.dto';
import { CreateStoreRolePermissionDto } from '../master/permissions/role-permission.dto';
import { EmployeeEntity, EmployeeStatus } from '../../entities/employee.entity';
import {
  CreateFeatureDto,
  UpdateFeatureDto,
} from '../master/feature/feature.dto';
import {
  CreatePermissionDto,
  UpdatePermissionDto,
} from '../master/permissions/permission.dto';
import {
  CreateRoleTemplateDto,
  UpdateRoleTemplateDto,
} from '../master/role-templates/role-template.dto';
import { CreatePlanDto, UpdatePlanDto } from '../master/plans/plan.dto';
import {
  CreateRoleDto,
  UpdateRoleDto,
} from '../master/role-templates/role.dto';
import { CreateEmployeeDto, UpdateEmployeeDto } from '../employee/employee.dto';
import {
  StoreTypeEntity,
  StoreTypeStatus,
} from '../../entities/store-type.entity';
import {
  CreateStoreTypeDto,
  UpdateStoreTypeDto,
} from '../master/store-setup/store-type.dto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Redis from 'ioredis';
import {
  connectPostgres,
  createMissingTables,
} from '@pinaka-delivery-hub/database';
import { SessionEntity } from '@pinaka-delivery-hub/auth';
import {
  MerchantEntity,
  BusinessType,
  RetailSubCategory,
  MerchantStatus,
  KycStatus,
} from '../../entities/merchant.entity';
import {
  StoreEntity,
  StoreStatus,
  OperationalStatus,
  StoreWebsiteConnectorConfig,
} from '../../entities/store.entity';
import {
  SubscriptionEntity,
  PlanCode,
  SubscriptionStatus,
  BillingCycle,
} from '../../entities/subscription.entity';
import { OnboardingAuditEntity } from '../../entities/onboarding-audit.entity';
import { SubscriptionPlanEntity } from '../../entities/subscription-plan.entity';
import { WebsiteConnectionEntity } from '../../entities/website-connection.entity';
import { CategoryEntity } from '../../entities/category.entity';
import { ProductEntity } from '../../entities/product.entity';
import { DeviceEntity } from '../../entities/device.entity';
import { MerchantDeviceEntity } from '../../entities/merchant-device.entity';
import { VendorEntity } from '../../entities/vendor.entity';
import { TendorEntity } from '../../entities/tendor.entity';
import { FeaturePermissionEntity } from '../../entities/feature-permission.entity';
import { PermissionType, RecordStatus } from '../../entities/commerce-enums';
import { RoleTemplatePermissionEntity } from '../../entities/role-template-permission.entity';
import { StoreTypeFeatureEntity } from '../../entities/store-type-feature.entity';
import { StoreTypeRoleTemplateEntity } from '../../entities/store-type-role-template.entity';
import { StoreRoleFeatureEntity } from '../../entities/store-role-feature.entity';
import { MerchantVendorEntity } from '../../entities/merchant-vendor.entity';
import { MerchantTendorEntity } from '../../entities/merchant-tendor.entity';
import { ensureVendorSchema } from '../vendor/vendor.schema';
import { ensureStoreAccessSchema } from '../master/store-setup/store-access.schema';
import { ensureStoreRoleTemplateSchema } from '../master/store-setup/store-role-template.schema';
import { ensureEmployeeStoreSchema } from '../store/employee-store.schema';
import { PosCurrencyTaxEntity } from '../../pos/currency-tax/pos-currency-tax.entity';
import { PosTaxClassEntity } from '../../pos/currency-tax/pos-tax-class.entity';
import { PosServiceChargeEntity } from '../../pos/service-charges/pos-service-charge.entity';
import { PosServiceChargeTierEntity } from '../../pos/service-charges/pos-service-charge-tier.entity';
import { PosCashbackEntity } from '../../pos/cashback/pos-cashback.entity';
import { PosCashbackTierEntity } from '../../pos/cashback/pos-cashback-tier.entity';
import { PosOpeningBalanceEntity } from '../../pos/opening-balance/pos-opening-balance.entity';
import { PosCashDenominationEntity } from '../../pos/cash-denominations/pos-cash-denomination.entity';
import { PosCashDenominationItemEntity } from '../../pos/cash-denominations/pos-cash-denomination-item.entity';
import { PosCashRegisterSettingsEntity } from '../../pos/cash-registers/pos-cash-register-settings.entity';
import { PosCashRegisterEntity } from '../../pos/cash-registers/pos-cash-register.entity';
import { PosSafeDropEntity } from '../../pos/safe-drop/pos-safe-drop.entity';
import { PosSafeDropTubeEntity } from '../../pos/safe-drop/pos-safe-drop-tube.entity';
import { PosSafeDropDenominationEntity } from '../../pos/safe-drop/pos-safe-drop-denomination.entity';
import { ensurePosSafeDropSchema } from '../../pos/safe-drop/pos-safe-drop.schema';
import { PosSafeTransactionEntity } from '../../pos/safe-transactions/pos-safe-transaction.entity';
import { PosSafeDropTransactionEntity } from '../../pos/safe-transactions/pos-safe-drop-transaction.entity';
import { PosCardPaymentEntity } from '../../pos/card-payments/pos-card-payment.entity';
import { PosTerminalMappingSettingsEntity } from '../../pos/terminal-mappings/pos-terminal-mapping-settings.entity';
import { PosTerminalMappingEntity } from '../../pos/terminal-mappings/pos-terminal-mapping.entity';
import { StoreEmployeeFastkeyEntity } from '../../pos/fastkeys/store-employee-fastkey.entity';
import { ensureStoreDevicesSchema } from '../store-pos-configuration/device-mappings/store-devices.schema';
import { ensureVendorStoreSchema } from '../dynamic-query/vendor-store.schema';
import { ensureStorePosConfigurationSchema } from '../store-pos-configuration/store-pos-configuration.schema';
import { StorePosConfigurationEntity } from '../../entities/store-pos-configuration.entity';
import { PosEmployeeAttendanceEntity } from '../../entities/pos-employee-attendance.entity';
import { ensureMerchantDevicesSchema } from '../device/device.schema';
import { FileStorageService } from '../file-storage/file-storage.service';

interface WordPressProductNode {
  id?: number;
  name?: string;
  price?: string | number;
  image?: string | null;
  tags?: unknown[];
  [key: string]: unknown;
}

interface WordPressCategoryNode {
  id?: number;
  name?: string;
  slug?: string;
  parent?: number;
  description?: string;
  count?: number;
  image?: string | null;
  pos_tax_class?: string;
  pos_tax_percent?: string;
  products?: WordPressProductNode[];
  children?: WordPressCategoryNode[];
}

interface StoreProductTaxConfiguration {
  currency: string;
  decimalPlaces: number;
  taxEnabled: boolean;
  defaultTaxRate: number | null;
  taxCalculation: string;
  taxClasses: Array<{ name: string; rate: number }>;
}

/** `required` is optional on older mapping rows. */
const mappingRequired = `COALESCE((to_jsonb(mapping)->>'required')::boolean, false)`;

@Injectable()
export class MerchantRepository implements OnModuleInit {
  constructor(
    @Optional()
    @Inject(FileStorageService)
    private readonly files?: FileStorageService,
  ) {}

  async getSubscribedFeatures(merchantId: string, storeTypeId: string) {
    if (!this.isDbConnected || !this.dataSource?.isInitialized)
      throw new ServiceUnavailableException(
        'Merchant features require PostgreSQL',
      );
    const [merchant] = await this.dataSource.query(
      `SELECT id, "merchantId", "merchantCode" FROM public.merchants
       WHERE id::text=$1 OR "merchantId"=$1 OR "merchantCode"=$1 LIMIT 1`,
      [merchantId],
    );
    if (!merchant) throw new NotFoundException('Merchant not found');
    const [storeType] = await this.dataSource.query(
      `SELECT id, "storeTypeCode", name FROM public.store_types WHERE id::text=$1 LIMIT 1`,
      [storeTypeId],
    );
    if (!storeType) throw new NotFoundException('Store type not found');
    const [subscription] = await this.dataSource.query(
      `SELECT to_jsonb(s) AS data FROM public.subscriptions s
       WHERE COALESCE(to_jsonb(s)->>'merchant_id', to_jsonb(s)->>'merchantId')=ANY($1::text[])
         AND s.status IN ('ACTIVE','TRIAL','TRIALING')
       ORDER BY COALESCE(to_jsonb(s)->>'createdAt', to_jsonb(s)->>'created_at') DESC NULLS LAST`,
      [
        [merchant.id, merchant.merchantId, merchant.merchantCode].filter(
          Boolean,
        ),
      ],
    );
    const active = subscription?.data;
    const subscriptionActive = Boolean(
      active &&
        ['ACTIVE', 'TRIAL', 'TRIALING'].includes(active.status) &&
        !(active.startDate && Date.parse(active.startDate) > Date.now()) &&
        !(
          active.currentPeriodEnd &&
          Date.parse(active.currentPeriodEnd) <= Date.now()
        ) &&
        !(active.cancelledAt && Date.parse(active.cancelledAt) <= Date.now()),
    );
    const planId = subscriptionActive ? active.planId || active.plan_id : null;
    const [plan] = planId
      ? await this.dataSource.query(
          `SELECT id, status, included_features, store_type_id AS store_type FROM public.plans WHERE id::text=$1`,
          [planId],
        )
      : [];
    const activePlan = plan?.status === 'ACTIVE' ? plan : null;
    let featureStoreType = storeType;
    const planStoreTypeRef = activePlan?.store_type
      ? String(activePlan.store_type).trim()
      : '';
    if (planStoreTypeRef) {
      const [planStoreType] = await this.dataSource.query(
        `SELECT id, "storeTypeCode", name FROM public.store_types
         WHERE id::text = $1
            OR lower(COALESCE("storeTypeCode", '')) = lower($1)
            OR lower(COALESCE(name, '')) = lower($1)
         ORDER BY CASE
           WHEN id::text = $1 THEN 0
           WHEN lower(COALESCE("storeTypeCode", '')) = lower($1) THEN 1
           WHEN lower(COALESCE(name, '')) = lower($1) THEN 2
           ELSE 3 END
         LIMIT 1`,
        [planStoreTypeRef],
      );
      if (planStoreType) featureStoreType = planStoreType;
    }
    const tables = await this.dataSource.query(
      `SELECT to_regclass('public.store_type_features') AS store_type_features`,
    );
    const mapped = tables[0]?.store_type_features
      ? await this.dataSource.query(
          `SELECT f.feature_code AS "featureKey", f.id, f.name, f.description, f.feature_type AS "featureType", f.status,
                stf.default_enabled AS "defaultEnabled", stf.required, stf.display_order AS "displayOrder"
         FROM public.store_type_features stf JOIN public.features f ON f.id=stf.feature_id
         WHERE stf.store_type_id=$1 AND f.status='ACTIVE'
         ORDER BY stf.display_order NULLS LAST, f.name`,
          [featureStoreType.id],
        )
      : [];
    const catalog: Array<Record<string, any>> = mapped.length
      ? mapped
      : await this.dataSource.query(
          `SELECT f.feature_code AS "featureKey", f.id, f.name, f.description, f.feature_type AS "featureType", f.status,
              NULL::boolean AS "defaultEnabled", NULL::boolean AS required, NULL::integer AS "displayOrder"
       FROM public.features f
       WHERE f.status='ACTIVE'
       ORDER BY f.name`,
        );
    const tokens: string[] = [];
    const collect = (item: unknown) => {
      if (Array.isArray(item)) {
        item.forEach(collect);
        return;
      }
      if (
        typeof item === 'string' &&
        item.startsWith('{') &&
        item.endsWith('}')
      ) {
        item
          .slice(1, -1)
          .split(',')
          .forEach((entry) => collect(entry.trim().replace(/^"|"$/g, '')));
        return;
      }
      if (item && typeof item === 'object') {
        const row = item as {
          featureId?: string;
          feature_id?: string;
          featureKey?: string;
          feature_key?: string;
          name?: string;
          id?: string;
          enabled?: boolean;
        };
        if (row.enabled === false) return;
        collect(
          row.featureId ||
            row.feature_id ||
            row.featureKey ||
            row.feature_key ||
            row.name ||
            row.id,
        );
        return;
      }
      const value = String(item ?? '').trim();
      if (value) tokens.push(value);
    };
    if (activePlan) collect(activePlan.included_features);
    const uniqueTokens = [...new Set(tokens)];
    const resolved = uniqueTokens.length
      ? await this.dataSource.query(
          `SELECT f.feature_code AS "featureKey", f.id, f.name, f.description, f.feature_type AS "featureType", f.status,
              NULL::boolean AS "defaultEnabled", NULL::boolean AS required, NULL::integer AS "displayOrder"
       FROM public.features f
       WHERE f.status='ACTIVE'
         AND (
           f.id::text = ANY($1::text[])
           OR lower(f.feature_code) = ANY($2::text[])
           OR lower(btrim(f.name)) = ANY($2::text[])
         )`,
          [uniqueTokens, uniqueTokens.map((token) => token.toLowerCase())],
        )
      : [];
    const includedKeys = new Set<string>();
    for (const row of resolved) {
      for (const value of [row.id, row.featureKey, row.name]) {
        if (value) includedKeys.add(String(value).trim().toLowerCase());
      }
    }
    for (const token of uniqueTokens) includedKeys.add(token.toLowerCase());
    const byId = new Map(
      catalog.map((feature) => [String(feature.id).toLowerCase(), feature]),
    );
    for (const row of resolved) {
      const id = String(row.id).toLowerCase();
      if (!byId.has(id)) {
        catalog.push(row);
        byId.set(id, row);
      }
    }
    catalog.sort(
      (left, right) =>
        String(left.category || '').localeCompare(
          String(right.category || ''),
        ) || String(left.name || '').localeCompare(String(right.name || '')),
    );
    const features = catalog.map((feature: any) => {
      const included = [feature.id, feature.featureKey, feature.name].some(
        (value) =>
          value && includedKeys.has(String(value).trim().toLowerCase()),
      );
      return {
        ...feature,
        included,
        planAccess: included ? 'INCLUDED' : 'NOT_INCLUDED',
        enabledForStore: included,
      };
    });
    const categories = groupFeaturesByCategory(features);
    const includedCount = features.filter(
      (feature: any) => feature.included,
    ).length;
    return {
      success: true,
      merchantId: merchant.id,
      storeTypeId: featureStoreType.id,
      subscriptionId: subscriptionActive ? active.id : null,
      planId: activePlan?.id || null,
      count: features.length,
      includedCount,
      notIncludedCount: features.length - includedCount,
      all: { category: 'All', count: features.length, features },
      categories,
    };
  }
  async masterData(
    table: 'store_types' | 'features' | 'role_templates' | 'plans',
    operation: 'list' | 'get' | 'create' | 'update' | 'delete',
    id?: string,
    fields: Record<string, unknown> = {},
  ): Promise<any> {
    if (!this.isDbConnected || !this.dataSource?.isInitialized)
      throw new ServiceUnavailableException('Master data requires PostgreSQL');

    if (table === 'features') {
      let cols: string[] = [];
      try {
        const colRes = await this.dataSource.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'features'",
        );
        cols = (colRes || []).map((r: any) => String(r.column_name));
      } catch {
        // fallback
      }
      if (!cols.length) {
        cols = [
          'id',
          'feature_code',
          'name',
          'description',
          'feature_type',
          'status',
          'created_at',
          'updated_at',
        ];
      }

      const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

      // Resolve actual database column names
      const keyDbCol =
        cols.find((c) =>
          ['feature_key', 'feature_code'].includes(c.toLowerCase()),
        ) || 'feature_code';
      const typeDbCol =
        cols.find((c) => c.toLowerCase() === 'feature_type') || 'feature_type';
      const createdDbCol =
        cols.find((c) =>
          ['created_at', 'createdat'].includes(c.toLowerCase()),
        ) || 'created_at';
      const updatedDbCol =
        cols.find((c) =>
          ['updated_at', 'updatedat'].includes(c.toLowerCase()),
        ) || 'updated_at';
      const createdByDbCol = cols.find((c) =>
        ['created_by', 'createdby'].includes(c.toLowerCase()),
      );
      const updatedByDbCol = cols.find((c) =>
        ['updated_by', 'updatedby'].includes(c.toLowerCase()),
      );

      const projection = [
        'id',
        'name',
        'description',
        'status',
        `${quote(keyDbCol)} AS "feature_code"`,
        `${quote(typeDbCol)} AS "feature_type"`,
        `${quote(createdDbCol)} AS "created_at"`,
        `${quote(updatedDbCol)} AS "updated_at"`,
        `${createdByDbCol ? quote(createdByDbCol) : 'NULL::uuid'} AS "created_by"`,
        `${updatedByDbCol ? quote(updatedByDbCol) : 'NULL::uuid'} AS "updated_by"`,
      ].join(', ');

      if (operation === 'list') {
        return await this.dataSource.query(
          `SELECT ${projection} FROM public.features ORDER BY name, id`,
        );
      } else if (operation === 'get') {
        const rows = await this.dataSource.query(
          `SELECT ${projection} FROM public.features WHERE id = $1`,
          [id],
        );
        if (!rows.length) throw new NotFoundException('Feature not found');
        return rows[0];
      } else if (operation === 'create') {
        const newId = crypto.randomUUID();
        const nameVal = String(fields.name || '').trim();
        const descVal = String(fields.description || '').trim();
        const typeVal = String(
          fields.featureType ?? fields.feature_type ?? fields.type ?? 'TEXT',
        ).trim();
        const statusVal = String(fields.status || 'ACTIVE')
          .trim()
          .toUpperCase();

        const insertData: Record<string, unknown> = {
          id: newId,
          name: nameVal,
          description: descVal,
          status: statusVal,
          [typeDbCol]: typeVal,
          [createdDbCol]: new Date(),
          [updatedDbCol]: null,
        };
        if (createdByDbCol)
          insertData[createdByDbCol] = fields.created_by ?? null;
        if (updatedByDbCol)
          insertData[updatedByDbCol] = null;
        const insertKeys = Object.keys(insertData);
        const insertValues = Object.values(insertData);
        const placeholders = insertValues
          .map((_, i) => '$' + (i + 1))
          .join(', ');

        try {
          const res = await this.dataSource.query(
            `INSERT INTO public.features (${insertKeys.map((k) => quote(k)).join(', ')}) VALUES (${placeholders}) RETURNING ${projection}`,
            insertValues,
          );
          return res[0];
        } catch (error: any) {
          const code = error.driverError?.code || error.code;
          if (code === '23505')
            throw new ConflictException('Feature code already exists');
          if (['23502', '23514', '22P02', '22001', '42703'].includes(code))
            throw new BadRequestException(
              'Feature save failed: ' +
                (error.driverError?.message || error.message),
            );
          throw error;
        }
      } else if (operation === 'update') {
        const setClauses: string[] = [];
        const setValues: unknown[] = [id];
        let idx = 2;

        if (fields.name !== undefined) {
          setClauses.push(`${quote('name')} = $${idx++}`);
          setValues.push(String(fields.name).trim());
        }
        if (fields.description !== undefined) {
          setClauses.push(`${quote('description')} = $${idx++}`);
          setValues.push(String(fields.description).trim());
        }
        if (fields.status !== undefined) {
          setClauses.push(`${quote('status')} = $${idx++}`);
          setValues.push(String(fields.status).trim().toUpperCase());
        }
        if (
          fields.featureType !== undefined ||
          fields.feature_type !== undefined ||
          fields.type !== undefined
        ) {
          const typeVal = String(
            fields.featureType ?? fields.feature_type ?? fields.type,
          ).trim();
          setClauses.push(`${quote(typeDbCol)} = $${idx++}`);
          setValues.push(typeVal);
        }
        setClauses.push(`${quote(updatedDbCol)} = clock_timestamp()`);
        if (updatedByDbCol && fields.updated_by !== undefined) {
          setClauses.push(`${quote(updatedByDbCol)} = $${idx++}`);
          setValues.push(fields.updated_by);
        }

        try {
          const res = await this.dataSource.query(
            `UPDATE public.features SET ${setClauses.join(', ')} WHERE id = $1 RETURNING ${projection}`,
            setValues,
          );
          if (!res.length) throw new NotFoundException('Feature not found');
          return res[0];
        } catch (error: any) {
          const code = error.driverError?.code || error.code;
          if (code === '23505')
            throw new ConflictException('Feature code already exists');
          if (['23502', '23514', '22P02', '22001', '42703'].includes(code))
            throw new BadRequestException(
              'Feature save failed: ' +
                (error.driverError?.message || error.message),
            );
          throw error;
        }
      } else if (operation === 'delete') {
        try {
          const res = await this.dataSource.query(
            `DELETE FROM public.features WHERE id = $1 RETURNING ${projection}`,
            [id],
          );
          if (res.length) return res[0];
        } catch (error: any) {
          const code = error.driverError?.code || error.code;
          if (code === '23503') {
            const res = await this.dataSource.query(
              `UPDATE public.features SET status = 'INACTIVE', ${quote(updatedDbCol)} = clock_timestamp() WHERE id = $1 RETURNING ${projection}`,
              [id],
            );
            return res[0];
          }
          throw error;
        }
        return { id, status: 'INACTIVE' };
      }
    }
    const columns: Record<string, string> = {
      name: 'name',
      description: 'description',
      status: 'status',
      ...{
        store_types: { storeTypeCode: 'storeTypeCode' },
        features: { featureKey: 'feature_code', featureType: 'feature_type' },
        role_templates: { roleCode: 'role_code', scopeType: 'scope_type' },
        plans: {
          planCode: 'planCode',
          billingModel: 'billingModel',
          basePrice: 'basePrice',
          currency: 'currency',
          billingCycle: 'billingCycle',
          storeType: 'store_type',
          includedStores: 'included_stores',
          includedTerminals: 'included_terminals',
          additionalTerminalPrice: 'additional_terminal_price',
          includedEmployees: 'included_employees',
          additionalEmployeePrice: 'additional_employee_price',
          trialPeriod: 'trial_period',
          effectiveFrom: 'effective_from',
          includedFeatures: 'included_features',
        },
      }[table],
    };
    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const createdColumn =
      table === 'role_templates' ? 'created_at' : 'createdAt';
    const updatedColumn =
      table === 'role_templates' ? 'updated_at' : 'updatedAt';
    const projection = [
      'id',
      ...Object.entries(columns).map(
        ([key, column]) => `${quote(column)} AS ${quote(key)}`,
      ),
      `${quote(createdColumn)} AS ${quote('createdAt')}`,
      `${quote(updatedColumn)} AS ${quote('updatedAt')}`,
    ].join(', ');
    const entries = Object.entries(fields).filter(
      ([, value]) => value !== undefined,
    );
    if (entries.some(([key]) => !columns[key]))
      throw new BadRequestException('Unknown master data field');
    if (operation === 'update' && !entries.length)
      throw new BadRequestException('Provide at least one field to update');
    let sql: string;
    let values: unknown[] = [];
    if (operation === 'list')
      sql = `SELECT ${projection} FROM public.${table} ORDER BY ${quote('name')}, id`;
    else if (operation === 'get') {
      sql = `SELECT ${projection} FROM public.${table} WHERE id = $1`;
      values = [id];
    } else if (operation === 'create') {
      values = [crypto.randomUUID(), ...entries.map(([, value]) => value)];
      sql = `INSERT INTO public.${table} (id, ${entries.map(([key]) => quote(columns[key])).join(', ')}) VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING ${projection}`;
    } else if (operation === 'update') {
      values = [id, ...entries.map(([, value]) => value)];
      sql = `UPDATE public.${table} SET ${entries.map(([key], index) => `${quote(columns[key])} = $${index + 2}`).join(', ')}, ${quote(updatedColumn)} = clock_timestamp() WHERE id = $1 RETURNING ${projection}`;
    } else {
      sql = `DELETE FROM public.${table} WHERE id = $1 RETURNING ${projection}`;
      values = [id];
    }
    try {
      const result = await this.dataSource.query(sql, values);
      // TypeORM returns [rows, affectedCount] for UPDATE and DELETE.
      const rows =
        operation === 'update' || operation === 'delete' ? result[0] : result;
      if (operation === 'list') return rows;
      if (!rows.length)
        throw new NotFoundException(
          `${{ store_types: 'Store type', features: 'Feature', role_templates: 'Role template', plans: 'Plan' }[table]} not found`,
        );
      return rows[0];
    } catch (error: any) {
      const code = error.driverError?.code || error.code;
      if (code === '23505')
        throw new ConflictException('Master record code or key already exists');
      if (code === '23503')
        throw new ConflictException(
          'Record is in use. Set status to INACTIVE instead.',
        );
      if (code === '42P01' || code === '42703')
        throw new ServiceUnavailableException(
          'Master data schema is not installed',
        );
      throw error;
    }
  }

  private dataSource!: DataSource;
  private merchantRepo!: Repository<MerchantEntity>;
  private storeRepo!: Repository<StoreEntity>;
  private storeTypeRepo!: Repository<StoreTypeEntity>;
  private featureRepo!: Repository<FeatureEntity>;
  private permissionRepo!: Repository<PermissionEntity>;
  private roleTemplateRepo!: Repository<RoleTemplateEntity>;
  private planMasterRepo!: Repository<PlanEntity>;
  private roleRepo!: Repository<RoleEntity>;
  private merchantRoleTemplateRepo!: Repository<MerchantRoleTemplateEntity>;
  private employeeRepo!: Repository<EmployeeEntity>;
  private subRepo!: Repository<SubscriptionEntity>;
  private planRepo!: Repository<SubscriptionPlanEntity>;
  private auditRepo!: Repository<OnboardingAuditEntity>;
  private websiteConnectionRepo!: Repository<WebsiteConnectionEntity>;
  private categoryRepo!: Repository<CategoryEntity>;
  private productRepo!: Repository<ProductEntity>;
  private sessionRepo!: Repository<SessionEntity>;
  public deviceRepo!: Repository<DeviceEntity>;
  private redisClient?: Redis;
  private isDbConnected = true;
  private isRedisConnected = false;
  private databaseError?: string;

  get databaseStatus(): string {
    return this.isDbConnected
      ? 'connected'
      : `unavailable: ${this.databaseError || 'unknown error'}`;
  }

  requireDataSource(): DataSource {
    if (!this.dataSource?.isInitialized) {
      throw new ServiceUnavailableException('PostgreSQL is unavailable');
    }
    return this.dataSource;
  }

  async onModuleInit() {
    this.dataSource = await connectPostgres(
      'PCH Merchant DB',
      [
        MerchantEntity,
        StoreEntity,
        StoreTypeEntity,
        FeatureEntity,
        PermissionEntity,
        RoleTemplateEntity,
        PlanEntity,
        RoleEntity,
        MerchantRoleTemplateEntity,
        EmployeeEntity,
        SubscriptionEntity,
        OnboardingAuditEntity,
        SubscriptionPlanEntity,
        WebsiteConnectionEntity,
        CategoryEntity,
        ProductEntity,
        DeviceEntity,
        MerchantDeviceEntity,
        PosCurrencyTaxEntity,
        PosTaxClassEntity,
        PosServiceChargeEntity,
        PosServiceChargeTierEntity,
        PosCashbackEntity,
        PosCashbackTierEntity,
        PosOpeningBalanceEntity,
        PosCashDenominationEntity,
        PosCashDenominationItemEntity,
        PosCashRegisterSettingsEntity,
        PosCashRegisterEntity,
        PosSafeDropEntity,
        PosSafeDropTubeEntity,
        PosSafeDropDenominationEntity,
        PosSafeTransactionEntity,
        PosSafeDropTransactionEntity,
        PosCardPaymentEntity,
        PosTerminalMappingSettingsEntity,
        PosTerminalMappingEntity,
        StorePosConfigurationEntity,
        PosEmployeeAttendanceEntity,
        StoreEmployeeFastkeyEntity,
        SessionEntity,
        VendorEntity,
        TendorEntity,
        FeaturePermissionEntity,
        RoleTemplatePermissionEntity,
        StoreTypeFeatureEntity,
        StoreTypeRoleTemplateEntity,
        StoreRoleFeatureEntity,
        MerchantVendorEntity,
        MerchantTendorEntity,
        StoreEmployeeFastkeyEntity,
      ],
      { synchronize: false, legacyQueryColumns: true },
    );
    // Never ALTER existing tables here. Repeated TypeORM synchronize drops and
    // re-adds columns, and PostgreSQL counts those dropped columns until startup
    // dies with "tables can have at most 1600 columns".
    const createdTables = await createMissingTables(this.dataSource);
    await ensurePosSafeDropSchema(this.dataSource);
    if (createdTables.length) {
      console.log(
        `🐘 [PCH Merchant DB] Created missing tables: ${createdTables.join(', ')}`,
      );
    }
    await ensureMerchantDevicesSchema(this.dataSource);
    await ensureStoreDevicesSchema(this.dataSource);
    await ensureVendorStoreSchema(this.dataSource);
    await ensureVendorSchema(this.dataSource);
    await ensureStoreAccessSchema(this.dataSource);
    await ensureStoreRoleTemplateSchema(this.dataSource);
    await ensureEmployeeStoreSchema(this.dataSource);
    await this.migrateEncryptedPinsToPlaintext();
    await this.ensureStoreCategoriesTable();
    // Existing merchant_vendors tables may predate this pairwise key. The
    // mapping endpoint's ON CONFLICT target requires a matching unique index.
    await this.dataSource.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS merchant_vendors_merchant_vendor_uidx
      ON public.merchant_vendors (merchant_id, vendor_id)
    `);

    this.merchantRepo = this.dataSource.getRepository(MerchantEntity);
    this.storeRepo = this.dataSource.getRepository(StoreEntity);
    this.storeTypeRepo = this.dataSource.getRepository(StoreTypeEntity);
    this.featureRepo = this.dataSource.getRepository(FeatureEntity);
    this.permissionRepo = this.dataSource.getRepository(PermissionEntity);
    this.roleTemplateRepo = this.dataSource.getRepository(RoleTemplateEntity);
    this.planMasterRepo = this.dataSource.getRepository(PlanEntity);
    this.roleRepo = this.dataSource.getRepository(RoleEntity);
    this.merchantRoleTemplateRepo = this.dataSource.getRepository(
      MerchantRoleTemplateEntity,
    );
    this.employeeRepo = this.dataSource.getRepository(EmployeeEntity);
    this.subRepo = this.dataSource.getRepository(SubscriptionEntity);
    this.planRepo = this.dataSource.getRepository(SubscriptionPlanEntity);
    this.auditRepo = this.dataSource.getRepository(OnboardingAuditEntity);
    this.websiteConnectionRepo = this.dataSource.getRepository(
      WebsiteConnectionEntity,
    );
    this.categoryRepo = this.dataSource.getRepository(CategoryEntity);
    this.productRepo = this.dataSource.getRepository(ProductEntity);
    this.sessionRepo = this.dataSource.getRepository(SessionEntity);
    this.deviceRepo = this.dataSource.getRepository(DeviceEntity);
    this.isDbConnected = true;

    // 2. Safely seed master reference data once all repos are initialized
    await this.seedAllMasterData();
    await this.seedDefaultCommercialPlans();
    await this.seedDefaultPlans();

    // 3. Redis Connection
    try {
      this.redisClient = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      this.redisClient.on('error', () => {
        this.isRedisConnected = false;
      });
      await this.redisClient.connect();
      this.isRedisConnected = true;
      console.log(
        '⚡ [PCH Merchant Redis] Connected to Redis for <1ms PIN & Entitlement caching',
      );
    } catch (err: any) {
      console.log(`⚠️ [PCH Merchant Redis] Offline (${err.message}).`);
      this.isRedisConnected = false;
    }
  }

  private async seedDefaultPlans() {
    if (!this.planRepo) return;
    const existing = await this.planRepo.count();
    if (existing > 0) return;
    const now = new Date();
    await this.planRepo.save([
      this.planRepo.create({
        planCode: PlanCode.STARTER,
        planName: 'Starter',
        description: 'Single-store starter plan',
        maxStoresAllowed: 1,
        entitlements: ['POS'],
        billingCycle: 'MONTHLY',
        trialDays: 14,
        price: 0,
        currency: 'USD',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      }),
      this.planRepo.create({
        planCode: PlanCode.PRO,
        planName: 'Pro Commerce Plan',
        description: 'Multi-store commerce plan',
        maxStoresAllowed: 3,
        entitlements: [
          'POS',
          'BARCODE_SCANNING',
          'UBER_EATS',
          'DOORDASH',
          'PAYROLL',
          'LOYALTY',
        ],
        billingCycle: 'MONTHLY',
        trialDays: 0,
        price: 99,
        currency: 'USD',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      }),
      this.planRepo.create({
        planCode: PlanCode.ENTERPRISE,
        planName: 'Enterprise',
        description: 'Unlimited stores',
        maxStoresAllowed: 50,
        entitlements: [
          'POS',
          'BARCODE_SCANNING',
          'UBER_EATS',
          'DOORDASH',
          'PAYROLL',
          'LOYALTY',
          'ANALYTICS',
        ],
        billingCycle: 'ANNUAL',
        trialDays: 0,
        price: 999,
        currency: 'USD',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      }),
    ]);
    console.log(
      'âœ… [PCH Seed] Seeded subscription_plans (STARTER, PRO, ENTERPRISE)',
    );
  }

  async recordAuditLog(
    action: string,
    merchantId: string,
    storeId?: string,
    performedBy = 'system',
    details: Record<string, any> = {},
  ): Promise<void> {
    const entry: OnboardingAuditEntity = {
      id: `AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      merchantId,
      storeId,
      action,
      performedBy,
      details,
      createdAt: new Date(),
    };
    await this.auditRepo.save(this.auditRepo.create(entry));
  }

  async allocateId(kind: 'merchant' | 'store'): Promise<string> {
    const prefix = kind === 'merchant' ? 'MER-' : 'STR-';
    const floor = kind === 'merchant' ? 4000 : 50000;
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(734921)');
      await manager.query(
        'CREATE TABLE IF NOT EXISTS public.pch_id_counters (kind text PRIMARY KEY, value bigint NOT NULL)',
      );
      const table = kind === 'merchant' ? 'merchants' : 'stores';
      const [row] = await manager.query(
        'INSERT INTO public.pch_id_counters(kind,value) SELECT $1, GREATEST($2::bigint, COALESCE(MAX(substring(id from $3)::bigint),0))+1 FROM public.' +
          table +
          ' WHERE id ~ $4 ON CONFLICT(kind) DO UPDATE SET value = GREATEST(pch_id_counters.value, EXCLUDED.value-1)+1 RETURNING value',
        [kind, floor, '[0-9]+$', '^' + prefix + '[0-9]+$'],
      );
      return prefix + row.value;
    });
  }

  async saveOnboarding(body: MerchantOnboardingDto, editing: boolean) {
    if (!this.dataSource?.isInitialized)
      throw new ServiceUnavailableException('Onboarding requires PostgreSQL');
    const m = body.merchant;
    const incoming = body.stores || [];
    const storeCodes = incoming.map(
      (store) => store.storeCode || store.storeName,
    );
    if (new Set(storeCodes).size !== storeCodes.length)
      throw new BadRequestException('Store codes must be unique');
    let result;
    try {
      result = await this.dataSource.transaction(async (manager) => {
        const merchants = manager.getRepository(MerchantEntity);
        const stores = manager.getRepository(StoreEntity);
        const subscriptions = manager.getRepository(SubscriptionEntity);
        const existing = await merchants.findOne({
          where: [
            { merchantId: m.merchantId },
            { merchantCode: m.merchantCode || m.merchantId },
          ],
          lock: { mode: 'pessimistic_write' },
        });
        if (editing && !existing)
          throw new NotFoundException('Merchant not found');
        if (!editing && existing)
          throw new ConflictException('Merchant code already exists');
        const rowId =
          existing?.id && this.isUuid(existing.id)
            ? existing.id
            : crypto.randomUUID();
        const merchantCode =
          m.merchantCode || existing?.merchantCode || m.merchantId;
        const merchantBusinessId =
          m.merchantId === merchantCode
            ? `MID-${rowId.slice(0, 8).toUpperCase()}`
            : m.merchantId;
        const merchant = await merchants.save(
          merchants.create({
            ...existing,
            id: rowId,
            merchantCode,
            merchantId: merchantBusinessId,
            businessDisplayName: m.businessDisplayName,
            firstName: m.firstName,
            lastName: m.lastName,
            email: m.email.toLowerCase(),
            phone: m.phone,
            alternatePhone: m.alternatePhone,
            taxId: m.taxId,
            addressLine1: m.addressLine1,
            addressLine2: m.addressLine2,
            postalCode: m.postalCode,
            country: m.country,
            city: m.city,
            state: m.state,
            status: m.status || existing?.status || MerchantStatus.PENDING,
            onboardingStep: incoming.length
              ? 'COMPLETED'
              : m.onboardingStep || existing?.onboardingStep || 'STEP2_STORE',
          }),
        );
        const ownerKeys = new Set([
          merchant.id,
          merchant.merchantId,
          merchant.merchantCode,
        ]);
        if (
          incoming.some(
            (store) => store.merchantId && !ownerKeys.has(store.merchantId),
          )
        ) {
          throw new BadRequestException(
            'All stores must belong to this merchant',
          );
        }
        let subscription = await subscriptions.findOne({
          where: { merchantId: merchant.id },
          order: { createdAt: 'DESC' },
        });
        if (body.subscription) {
          const subId = subscription?.id || `SUB-${crypto.randomUUID()}`;
          subscription = await subscriptions.save(
            subscriptions.create({
              ...subscription,
              id: subId,
              merchantId: merchant.id,
              subscriptionCode:
                body.subscription.subscriptionCode ||
                subscription?.subscriptionCode ||
                subId,
              planId: body.subscription.planId ?? subscription?.planId,
              price: body.subscription.price,
              billingCycle:
                body.subscription.billingCycle ||
                subscription?.billingCycle ||
                BillingCycle.MONTHLY,
              autoRenew:
                body.subscription.autoRenew ?? subscription?.autoRenew ?? true,
              status:
                body.subscription.status ||
                subscription?.status ||
                SubscriptionStatus.PENDING,
              startDate: body.subscription.startDate ?? subscription?.startDate,
              renewalDate:
                body.subscription.renewalDate ?? subscription?.renewalDate,
              trialEndDate:
                body.subscription.trialEndDate ?? subscription?.trialEndDate,
            }),
          );
        }
        if (!subscription && incoming.length)
          throw new BadRequestException(
            'Create a merchant subscription before adding stores',
          );
        for (const item of incoming) {
          const storeId = crypto.randomUUID();
          const type = await this.getStoreTypeByIdOrCode(item.storeTypeId);
          if (!type || type.status !== 'ACTIVE')
            throw new BadRequestException('Select an active store type');
          await stores.save(
            this.buildStore(merchant.id, {
              id: storeId,
              storeTypeId: type.id,
              storeCode:
                item.storeCode || `STR-${storeId.slice(0, 8).toUpperCase()}`,
              storeName: item.storeName,
              phone: item.phone,
              storeEmail: item.storeEmail,
              currency: item.currency || 'USD',
              timezone: item.timezone || 'UTC',
              activationPin: item.activationPin,
              addressLine1: item.addressLine1,
              addressLine2: item.addressLine2,
              city: item.city,
              state: item.state,
              postalCode: item.postalCode,
              country: item.country || m.country,
              status: item.status || StoreStatus.PENDING,
              operationalStatus:
                item.operationalStatus || OperationalStatus.OPEN,
            }),
          );
        }
        const savedStores = await stores.find({
          where: { merchantId: merchant.id, isDeleted: false },
        });
        await manager.getRepository(OnboardingAuditEntity).save({
          id: `AUD-${crypto.randomUUID()}`,
          merchantId: merchant.merchantId,
          action: editing ? 'ONBOARDING_UPDATED' : 'ONBOARDING_CREATED',
          performedBy: 'merchant',
          details: {
            storeCount: savedStores.length,
            subscriptionId: subscription?.id,
          },
        });
        return { merchant, stores: savedStores, subscription };
      });
    } catch (error: any) {
      if ((error.driverError?.code || error.code) === '23505')
        throw new ConflictException(
          'Merchant email, merchant code or store code already exists',
        );
      throw error;
    }
    for (const store of result.stores)
      await this.cacheStorePin(store.activationPin, store);
    if (this.files) {
      const merchantLabel =
        result.merchant.businessDisplayName ||
        result.merchant.merchantCode ||
        result.merchant.merchantId ||
        'merchant';
      await this.files.ensureMerchantFolder(merchantLabel);
      for (const store of result.stores) {
        await this.files.ensureStoreFolder(merchantLabel, store.storeName);
      }
    }
    return result;
  }

  async createMerchant(
    data: Partial<MerchantEntity> & {
      businessName?: string;
      ownerName?: string;
      businessAddress?: string;
    },
  ): Promise<MerchantEntity> {
    const rowId = crypto.randomUUID();
    const requestedCode =
      data.merchantCode ||
      data.merchantId ||
      `MCH-${rowId.slice(0, 8).toUpperCase()}`;
    const merchantId =
      data.merchantId && data.merchantId !== requestedCode
        ? data.merchantId
        : `MID-${rowId.slice(0, 8).toUpperCase()}`;
    const owner = data.ownerName || data.firstName || 'Owner';
    const [firstName, ...rest] = owner.split(' ');
    const saved = await this.merchantRepo.save(
      this.merchantRepo.create({
        id: rowId,
        createdBy: data.createdBy ?? null,
        updatedBy: null,
        updatedAt: null as unknown as Date,
        merchantCode: requestedCode,
        merchantId,
        businessDisplayName:
          data.businessDisplayName ||
          data.businessName ||
          'New Merchant Business',
        firstName: data.firstName || firstName,
        lastName: data.lastName || rest.join(' '),
        email: data.email || `owner_${Date.now()}@pinaka.com`,
        phone: data.phone || '0000000000',
        taxId: data.taxId || null,
        country: data.country,
        state: data.state,
        city: data.city,
        postalCode: data.postalCode,
        addressLine1: data.addressLine1 || data.businessAddress || null,
        alternatePhone: data.alternatePhone,
        status: data.status || MerchantStatus.PENDING,
        onboardingStep: data.onboardingStep || 'STEP1_BUSINESS',
      }),
    );
    await this.recordAuditLog(
      'MERCHANT_CREATED',
      saved.merchantId!,
      undefined,
      saved.email,
      { businessName: saved.businessName },
    );
    await this.files?.ensureMerchantFolder(
      saved.businessDisplayName || saved.merchantCode || saved.merchantId || 'merchant',
    );
    return saved;
  }

  async getAllMerchants(): Promise<MerchantEntity[]> {
    return this.merchantRepo.find({ order: { createdAt: 'DESC' } });
  }

  async updateMerchant(
    id: string,
    data: Partial<MerchantEntity>,
  ): Promise<MerchantEntity | null> {
    const merchant = await this.merchantRepo.findOne({
      where: { merchantId: id },
      order: { createdAt: 'DESC' },
    });
    if (!merchant) return null;
    Object.assign(merchant, data, {
      id: merchant.id,
      merchantId: merchant.merchantId,
      updatedAt: new Date(),
    });
    const saved = await this.merchantRepo.save(merchant);
    await this.recordAuditLog('MERCHANT_UPDATED', id, undefined, saved.email, {
      businessName: saved.businessName,
    });
    return saved;
  }

  async getMerchantById(id: string): Promise<{
    merchant: MerchantEntity | null;
    stores: StoreEntity[];
    subscription: SubscriptionEntity | null;
  }> {
    const merchantId = await this.resolveMerchantId(id);
    const merchant = merchantId
      ? await this.merchantRepo.findOne({
          where: { merchantId },
          order: { createdAt: 'DESC' },
        })
      : null;
    if (!merchant) return { merchant: null, stores: [], subscription: null };
    const stores = await this.listStores(merchant.id);
    const subscription =
      (await this.listSubscriptions(merchant.id))[0] || null;
    return {
      merchant: { ...merchant, id: merchant.merchantId! },
      stores,
      subscription,
    };
  }

  async resolveMerchantId(idOrUuid: string): Promise<string | null> {
    const rows = await this.dataSource.query(
      'SELECT "merchantId" FROM public.merchants WHERE "merchantId"=$1 OR "merchantCode"=$1 OR id::text=$1 LIMIT 1',
      [idOrUuid],
    );
    return rows[0]?.merchantId || null;
  }

  async resolveMerchantUuid(idOrUuid: string): Promise<string | null> {
    const rows = await this.dataSource.query(
      'SELECT m.id FROM public.merchants m WHERE m.merchant_id=$1 OR m.merchant_code=$1 OR m.id::text=$1 ORDER BY CASE WHEN m.id::text=$1 THEN 0 ELSE 1 END, m.created_at, m.id LIMIT 1',
      [idOrUuid],
    );
    return rows[0]?.id || null;
  }

  private async merchantIdentity(idOrUuid: string): Promise<{
    merchantId: string;
    merchantUuid: string;
    aliases: string[];
  } | null> {
    const rows = await this.dataSource.query(
      `SELECT m.merchant_id AS "merchantId", m.merchant_code AS "merchantCode", m.id::text AS uuid
       FROM public.merchants m
       WHERE m.merchant_id=$1 OR m.merchant_code=$1 OR m.id::text=$1
       ORDER BY CASE WHEN m.id::text=$1 THEN 0 ELSE 1 END, m.created_at, m.id
       LIMIT 1`,
      [idOrUuid],
    );
    const row = rows[0];
    if (!row?.merchantId || !row?.uuid) return null;
    const aliases = [
      ...new Set(
        [row.merchantId, row.merchantCode, row.uuid].filter((value: string) =>
          Boolean(value),
        ),
      ),
    ];
    return { merchantId: row.merchantId, merchantUuid: row.uuid, aliases };
  }

  private async merchantFolderLabel(merchantId: string): Promise<string> {
    try {
      const rows = await this.dataSource.query(
        `SELECT to_jsonb(m) AS data
         FROM public.merchants m
         WHERE m.id::text = $1
            OR m.merchant_id = $1
            OR m.merchant_code = $1
         LIMIT 1`,
        [merchantId],
      );
      const data = (rows[0]?.data ?? {}) as Record<string, unknown>;
      return String(
        data.business_display_name ||
          data.businessDisplayName ||
          data.businessName ||
          data.merchantName ||
          data.merchant_code ||
          data.merchantCode ||
          merchantId,
      );
    } catch {
      return merchantId;
    }
  }

  async storeMatchesMerchant(
    store: { merchantId?: string; merchantUuid?: string },
    idOrUuid: string,
  ): Promise<boolean> {
    const identity = await this.merchantIdentity(idOrUuid);
    if (!identity) return false;
    return (
      identity.aliases.includes(String(store.merchantId || '')) ||
      String(store.merchantUuid || '') === identity.merchantUuid
    );
  }

  private isUuid(value?: string | null): value is string {
    return (
      !!value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    );
  }

  private buildStore(
    merchantUuid: string,
    data: Partial<StoreEntity> & {
      address?: {
        street?: string;
        addressLine2?: string;
        city?: string;
        state?: string;
        zipCode?: string;
        country?: string;
      };
    },
  ): StoreEntity {
    const id = this.isUuid(data.id) ? data.id : crypto.randomUUID();
    const address = data.address;
    const storeCode =
      data.storeCode ||
      (!this.isUuid(data.id) && data.id) ||
      `STR-${id.slice(0, 8).toUpperCase()}`;
    return {
      id,
      merchantId: merchantUuid,
      storeTypeId: data.storeTypeId!,
      storeName: data.storeName || 'Store Branch',
      storeCode,
      addressLine1: data.addressLine1 || address?.street || null,
      addressLine2: data.addressLine2 || address?.addressLine2 || null,
      city: data.city || address?.city || null,
      state: data.state || address?.state || null,
      postalCode: data.postalCode || address?.zipCode || null,
      country: data.country || address?.country || null,
      phone: data.phone,
      storeEmail:
        data.storeEmail ||
        (data as { email?: string }).email ||
        null,
      storeWebsiteUrl:
        data.storeWebsiteUrl ||
        (data as { baseUrl?: string }).baseUrl ||
        null,
      currency: data.currency || 'USD',
      timezone: data.timezone || 'UTC',
      activationPin:
        data.activationPin ||
        Math.floor(100000 + Math.random() * 900000).toString(),
      status: data.status || StoreStatus.ACTIVE,
      operationalStatus: data.operationalStatus || OperationalStatus.OPEN,
      onboardingSetup: data.onboardingSetup || {},
      channels: data.channels || [
        {
          platform: 'POS',
          externalStoreId: id,
          apiKey: `key_${id}`,
          enabled: true,
        },
      ],
      isDeleted: false,
      createdAt: new Date(),
      createdBy: data.createdBy ?? null,
      updatedBy: null,
      updatedAt: null as unknown as Date,
    };
  }

  async resolveStoreTypeId(
    data: Partial<StoreEntity> & { storeType?: string },
  ): Promise<string> {
    if (this.isUuid(data.storeTypeId)) return data.storeTypeId;
    const type = await this.getStoreTypeByIdOrCode(
      String(data.storeType || data.storeTypeId || 'RETAIL'),
    );
    if (!type?.id) throw new BadRequestException('storeTypeId is required');
    return type.id;
  }

  async createStore(
    merchantId: string,
    data: Partial<StoreEntity> & { storeType?: string },
  ): Promise<StoreEntity> {
    const identity = await this.merchantIdentity(merchantId);
    if (!identity)
      throw new NotFoundException(`Merchant '${merchantId}' not found`);
    const storeTypeId = await this.resolveStoreTypeId(data);
    const generatedId = this.isUuid(data.id) ? data.id : crypto.randomUUID();
    const storeCode =
      data.storeCode ||
      (!this.isUuid(data.id) && data.id) ||
      (await this.allocateId('store'));
    const store = this.buildStore(identity.merchantUuid, {
      ...data,
      storeTypeId,
      id: generatedId,
      storeCode,
    });
    const { activationPin } = store;
    const entity = this.storeRepo.create(store);
    try {
      await this.storeRepo.insert(entity);
    } catch (error: any) {
      if (error.code === '23505' || error.driverError?.code === '23505') {
        throw new ConflictException(
          'Store ID or store code already exists. Choose a different Store ID.',
        );
      }
      throw error;
    }
    await this.cacheStorePin(activationPin, entity);
    await this.recordAuditLog(
      'STORE_CREATED',
      identity.merchantId,
      entity.id,
      'merchant',
      { storeName: entity.storeName, pin: activationPin },
    );
    await this.files?.ensureStoreFolder(
      await this.merchantFolderLabel(identity.merchantUuid),
      entity.storeName,
    );
    return entity;
  }

  async createStoresBatch(
    merchantId: string,
    data: Partial<StoreEntity>[],
  ): Promise<StoreEntity[]> {
    const identity = await this.merchantIdentity(merchantId);
    if (!identity)
      throw new NotFoundException(`Merchant '${merchantId}' not found`);
    const stores = await Promise.all(
      data.map(async (item) => {
        const storeTypeId = await this.resolveStoreTypeId(item);
        const id = this.isUuid(item.id) ? item.id : crypto.randomUUID();
        const storeCode =
          item.storeCode ||
          (!this.isUuid(item.id) && item.id) ||
          (await this.allocateId('store'));
        return this.buildStore(identity.merchantUuid, {
          ...item,
          storeTypeId,
          id,
          storeCode,
        });
      }),
    );
    if (
      new Set(stores.map((s) => s.id)).size !== stores.length ||
      new Set(stores.map((s) => s.storeCode)).size !== stores.length
    ) {
      throw new ConflictException('Each store must have a unique Store ID.');
    }
    try {
      await this.storeRepo.manager.transaction(async (manager) => {
        await manager.insert(StoreEntity, stores);
      });
    } catch (error: any) {
      if (error.code === '23505' || error.driverError?.code === '23505') {
        throw new ConflictException(
          'A Store ID already exists. No stores were added.',
        );
      }
      throw error;
    }
    for (const store of stores) {
      await this.cacheStorePin(store.activationPin, store);
      await this.recordAuditLog(
        'STORE_CREATED',
        identity.merchantId,
        store.id,
        'merchant',
        { storeName: store.storeName },
      );
      await this.files?.ensureStoreFolder(
        await this.merchantFolderLabel(identity.merchantUuid),
        store.storeName,
      );
    }
    return stores;
  }

  async createOrUpdateStore(
    merchantId: string,
    data: Partial<StoreEntity>,
  ): Promise<StoreEntity> {
    const identity = await this.merchantIdentity(merchantId);
    if (!identity)
      throw new NotFoundException(`Merchant '${merchantId}' not found`);
    if (data.id) {
      const existing = await this.storeRepo.findOne({
        where: { id: data.id, isDeleted: false },
      });
      if (existing) {
        if (!(await this.storeMatchesMerchant(existing, identity.merchantId)))
          throw new Error(`Store ID '${data.id}' belongs to another merchant`);
        Object.assign(existing, data, {
          merchantId: identity.merchantUuid,
          updatedAt: new Date(),
        });
        const saved = await this.storeRepo.save(existing);
        await this.recordAuditLog(
          'STORE_UPDATED',
          identity.merchantId,
          saved.id,
          'merchant',
          { storeName: saved.storeName },
        );
        return saved;
      }
    }
    return this.createStore(identity.merchantId, data);
  }

  async getStoreById(id: string): Promise<StoreEntity | null> {
    if (this.isUuid(id))
      return this.storeRepo.findOne({ where: { id, isDeleted: false } });
    return this.storeRepo.findOne({
      where: { storeCode: id, isDeleted: false },
    });
  }

  async createDevice(data: {
    id: string;
    deviceId?: string;
    deviceName?: string;
    deviceCode?: string;
    deviceType?: string;
    merchantId: string;
    merchantName?: string;
    serialNumber: string;
    status?: string;
    createdAt?: Date;
    createdBy?: string;
    updatedBy?: string;
  }): Promise<DeviceEntity> {
    if (!this.deviceRepo) {
      throw new ServiceUnavailableException('Database not connected');
    }
    const entity = this.deviceRepo.create({
      id: data.id,
      deviceName: data.deviceName || 'Unnamed device',
      deviceCode:
        data.deviceCode ||
        `DEV-${data.id.replace(/-/g, '').slice(0, 12).toUpperCase()}`,
      deviceType: data.deviceType || 'Other',
      merchantId: data.merchantId,
      merchantName: data.merchantName || data.merchantId,
      serialNumber: data.serialNumber,
      deviceActiveCode: (data as any).deviceActiveCode || `PK-${Math.floor(100000 + Math.random() * 900000)}`,
      status: data.status || 'Active',
      createdAt: data.createdAt || new Date(),
      createdBy: data.createdBy,
      updatedBy: data.updatedBy,
    });

    try {
      return await this.deviceRepo.save(entity);
    } catch (error: any) {
      const code = error.driverError?.code || error.code;
      if (code === '23505') {
        throw new ConflictException(
          'Device code or serial number already exists',
        );
      }
      throw error;
    }
  }

  async findDeviceMerchant(merchantUuid: string): Promise<{ id: string; businessDisplayName: string | null } | null> {
    if (!this.deviceRepo) throw new ServiceUnavailableException('Database not connected');
    const rows = await this.dataSource.query(
      `SELECT id::text AS id, business_display_name AS "businessDisplayName"
       FROM public.merchants
       WHERE id = $1::uuid
       LIMIT 1`,
      [merchantUuid],
    );
    return rows[0] || null;
  }

  async getDevice(id: string): Promise<DeviceEntity | null> {
    if (!this.deviceRepo)
      throw new ServiceUnavailableException('Database not connected');
    return this.deviceRepo.findOne({ where: { id } });
  }

  async updateDevice(
    id: string,
    fields: Partial<DeviceEntity>,
  ): Promise<DeviceEntity> {
    if (!this.deviceRepo)
      throw new ServiceUnavailableException('Database not connected');
    try {
      const current = await this.deviceRepo.findOne({ where: { id } });
      if (!current) throw new NotFoundException('Device not found');
      return await this.deviceRepo.save(Object.assign(current, fields));
    } catch (error: any) {
      if (error instanceof NotFoundException) throw error;
      if ((error.driverError?.code || error.code) === '23505') {
        throw new ConflictException(
          'Device code or serial number already exists',
        );
      }
      throw error;
    }
  }

  async deleteDevice(id: string, updatedBy: string): Promise<boolean> {
    if (!this.deviceRepo) throw new ServiceUnavailableException('Database not connected');
    const result = await this.deviceRepo.update(
      { id, isDeleted: false },
      { isDeleted: true, status: RecordStatus.INACTIVE, updatedBy, updatedAt: new Date() },
    );
    return result.affected === 1;
  }

 async queryDevices(filters: {
    page: number; limit: number; search?: string; merchantId?: string;
    deviceType?: string; status?: string; from?: Date; to?: Date;
  }): Promise<{ devices: DeviceEntity[]; total: number; summary: Record<string, number> }> {
    if (!this.deviceRepo) throw new ServiceUnavailableException('Database not connected');
    if (typeof (this.deviceRepo as any).createQueryBuilder !== 'function') {
      const all = await this.deviceRepo.find({ where: { isDeleted: false }, order: { createdAt: 'DESC' } });
      const filtered = all.filter(device =>
        (!filters.merchantId || device.merchantId === filters.merchantId) &&
        (!filters.deviceType || device.deviceType === filters.deviceType) &&
        (!filters.search || [device.deviceName, device.deviceCode, device.serialNumber].some(value => value.toLowerCase().includes(filters.search!.toLowerCase()))) &&
        (!filters.from || device.createdAt >= filters.from) && (!filters.to || device.createdAt < filters.to));
      const devices = filtered.slice((filters.page - 1) * filters.limit, filters.page * filters.limit);
      return { devices, total: filtered.length, summary: {} };
    }
    const query = this.deviceRepo.createQueryBuilder('device').where('device.is_deleted = false');
    if (filters.search) query.andWhere(`(device.device_name ILIKE :search OR device.device_code ILIKE :search OR device.serial_number ILIKE :search)`, { search: `%${filters.search}%` });
    if (filters.merchantId) query.andWhere('device.merchant_id = :merchantId', { merchantId: filters.merchantId });
    if (filters.deviceType) query.andWhere('device.device_type = :deviceType', { deviceType: filters.deviceType });
    if (filters.status?.toLowerCase() === 'active') query.andWhere(`device.status = 'ACTIVE'`);
    if (filters.status?.toLowerCase() === 'inactive') query.andWhere(`device.status = 'INACTIVE'`);
    if (filters.status?.toLowerCase() === 'offline') query.andWhere(`device.status = 'ACTIVE'`);
    if (filters.status?.toLowerCase() === 'online') query.andWhere('1 = 0');
    if (filters.from) query.andWhere('device.created_at >= :from', { from: filters.from });
    if (filters.to) query.andWhere('device.created_at < :to', { to: filters.to });
    const [devices, total] = await query.orderBy('device.created_at', 'DESC')
      .skip((filters.page - 1) * filters.limit).take(filters.limit).getManyAndCount();
    const summaryRows = await this.deviceRepo.createQueryBuilder('device')
      .where('device.is_deleted = false')
      .select('device.status', 'status').addSelect('COUNT(*)', 'count')
      .groupBy('device.status').getRawMany();
    const summary = Object.fromEntries(summaryRows.map((row: any) => [String(row.status).toLowerCase(), Number(row.count)]));
    return { devices, total, summary };
  }

  async listDevices(): Promise<DeviceEntity[]> {
    if (!this.deviceRepo) throw new ServiceUnavailableException('Database not connected');
    return this.deviceRepo.find({ where: { isDeleted: false }, order: { createdAt: 'DESC' } });
  }

  async listDevicesByMerchantId(merchantId: string): Promise<DeviceEntity[]> {
    if (!this.deviceRepo) throw new ServiceUnavailableException('Database not connected');
    return this.deviceRepo.find({ where: { merchantId, isDeleted: false }, order: { createdAt: 'DESC' } });
  }

  async listStores(merchantId?: string): Promise<StoreEntity[]> {
    if (!merchantId) {
      return this.storeRepo.find({
        where: { isDeleted: false },
        order: { createdAt: 'DESC' },
      });
    }
    const identity = await this.merchantIdentity(merchantId);
    if (!identity) return [];
    return this.storeRepo
      .createQueryBuilder('store')
      .where('store.isDeleted = :alive', { alive: false })
      .andWhere('store.merchantId = :merchantUuid', {
        merchantUuid: identity.merchantUuid,
      })
      .orderBy('store.createdAt', 'DESC')
      .getMany();
  }

  async deleteStore(
    id: string,
  ): Promise<{ deletedAt: Date; isDeleted: 1 } | null> {
    const store = await this.getStoreById(id);
    if (!store) return null;
    const deletedAt = new Date();
    const result = await this.storeRepo.update(
      { id: store.id, isDeleted: false },
      { isDeleted: true, updatedAt: deletedAt },
    );
    if (!result.affected) return null;
    await this.recordAuditLog(
      'STORE_DELETED',
      store.merchantId,
      store.id,
      'merchant',
      { storeName: store.storeName },
    );
    return { deletedAt, isDeleted: 1 };
  }

  async updateStore(
    id: string,
    fields: Partial<StoreEntity>,
  ): Promise<StoreEntity | null> {
    const store = await this.getStoreById(id);
    if (!store) return null;
    const { id: _ignoredId, merchantId: _ignoredMerchantId, ...safeFields } =
      fields;
    const updated = {
      ...store,
      ...safeFields,
      id: store.id,
      merchantId: store.merchantId,
      updatedAt: new Date(),
    };
    if (
      !(
        await this.storeRepo.update(store.id, {
          ...safeFields,
          updatedAt: updated.updatedAt,
        })
      ).affected
    )
      return null;
    await this.cacheStorePin(updated.activationPin, updated);
    await this.recordAuditLog(
      'STORE_UPDATED',
      store.merchantId,
      store.id,
      'merchant',
      { storeName: updated.storeName },
    );
    return updated;
  }

  /**
   * Persist wizard feature selections and the role permission matrix.
   * Features previously lived only inside stores.onboardingSetup JSON.
   * Role permissions were omitted from the create payload entirely.
   */
  async saveStoreFeaturesAndRolePermissions(
    store: Pick<StoreEntity, 'id' | 'merchantId'> & {
      uuid?: string;
      merchantUuid?: string;
      storeCode?: string;
    },
    features: string[] = [],
    rolePermissions: Array<Record<string, unknown>> = [],
  ): Promise<void> {
    let storeUuid = store.uuid || (this.isUuid(store.id) ? store.id : undefined);
    let merchantId = store.merchantUuid || store.merchantId;
    if (!this.isUuid(storeUuid) || !this.isUuid(merchantId)) {
      const [row] = await this.dataSource.query(
        `SELECT id, merchant_id AS "merchantId"
         FROM public.stores
         WHERE id::text = $1 OR store_code = $1
         LIMIT 1`,
        [store.id || store.storeCode],
      );
      storeUuid = storeUuid || row?.id;
      merchantId = merchantId || row?.merchantId;
    }
    if (!storeUuid || !merchantId) return;

    const featureNames = [
      ...new Set(
        features.map((name) => String(name || '').trim()).filter(Boolean),
      ),
    ];
    await this.dataSource.query(
      `DELETE FROM public.store_features WHERE store_id = $1::uuid`,
      [storeUuid],
    );
    for (const featureName of featureNames) {
      const [feature] = await this.dataSource.query(
        `SELECT id FROM public.features
         WHERE lower(name) = lower($1)
            OR lower(COALESCE(to_jsonb(features)->>'featureKey', to_jsonb(features)->>'feature_key', '')) = lower($1)
         LIMIT 1`,
        [featureName],
      );
      await this.dataSource.query(
        `INSERT INTO public.store_features
           (merchant_id, store_id, feature_id, feature_name, enabled)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, true)`,
        [
          merchantId,
          storeUuid,
          feature?.id || null,
          featureName,
        ],
      );
    }

    await this.dataSource.query(
      `DELETE FROM public.store_roles_permission WHERE store_id = $1::uuid`,
      [storeUuid],
    );
    const actions = ['View', 'Create', 'Edit', 'Delete'];
    for (const role of rolePermissions) {
      const roleName = String(role.name || role.roleName || '').trim();
      const roleTemplateId = String(
        role.roleTemplateId || role.id || '',
      ).trim();
      if (!roleName) continue;
      const templateId = /^[0-9a-f-]{36}$/i.test(roleTemplateId)
        ? roleTemplateId
        : null;
      const matrix =
        role.permissions && typeof role.permissions === 'object'
          ? (role.permissions as Record<string, Record<string, boolean>>)
          : {};
      const featureKeys = Object.keys(matrix);
      if (!featureKeys.length) {
        await this.dataSource.query(
          `INSERT INTO public.store_roles_permission
             (merchant_id, store_id, role_template_id, role_name, feature_name, permission_action, allowed)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '', 'SELECTED', true)`,
          [merchantId, storeUuid, templateId, roleName],
        );
        continue;
      }
      for (const featureName of featureKeys) {
        const grants = matrix[featureName] || {};
        for (const action of actions) {
          if (grants[action] === undefined) continue;
          await this.dataSource.query(
            `INSERT INTO public.store_roles_permission
               (merchant_id, store_id, role_template_id, role_name, feature_name, permission_action, allowed)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
            [
              merchantId,
              storeUuid,
              templateId,
              roleName,
              featureName,
              action,
              Boolean(grants[action]),
            ],
          );
        }
      }
    }
  }

  async listStoreWizardRolePermissions(
    merchantId: string,
    storeId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const { storeUuid } = await this.requireStoreRecord(merchantId, storeId);
    return this.dataSource.query(
      `SELECT role_template_id AS "roleTemplateId",
              role_name AS "roleName",
              feature_name AS "featureName",
              permission_action AS "permissionAction",
              allowed
       FROM public.store_roles_permission
       WHERE store_id = $1::uuid
       ORDER BY role_name, feature_name, permission_action`,
      [storeUuid],
    );
  }

  async getStorePosPaymentsForMerchant(merchantId: string, storeId: string) {
    const { storeUuid } = await this.requireStoreRecord(merchantId, storeId);
    const payments = await this.dataSource.query(
      `SELECT
         payment.id,
         payment.order_id,
         order_record.order_number,
         payment.merchant_id,
         payment.store_id,
         payment.local_id,
         payment.client_order_id,
         payment.device_id,
         payment.shift_id,
         COALESCE(
           payment.user_id,
           store_sale.placed_by,
           payment.metadata->>'pos_placed_by',
           (
             SELECT item->>'value'
             FROM jsonb_array_elements(COALESCE(store_sale.meta_data, '[]'::jsonb)) AS item
             WHERE item->>'key' = 'pos_placed_by'
             LIMIT 1
           )
         ) AS user_id,
         payment.payment_type,
         payment.payment_method,
         COALESCE(payment.payment_method_title, store_sale.payment_method_title) AS payment_method_title,
         payment.amount,
         payment.order_total,
         payment.remaining,
         payment.currency,
         payment.status,
         payment.entry_type,
         payment.provider,
         payment.provider_transaction_id,
         payment.payment_at
       FROM public.store_pos_payments AS payment
       LEFT JOIN public.orders AS order_record ON order_record.id = payment.order_id
       LEFT JOIN public.store_orders AS store_sale ON store_sale.order_id = payment.order_id
       WHERE payment.store_id = $1::uuid
         AND payment.deleted_at IS NULL
       ORDER BY payment.payment_at DESC, payment.created_at DESC`,
      [storeUuid],
    );
    return { success: true, storeId: storeUuid, count: payments.length, payments };
  }

  async listStoreEmployees(
    merchantId: string,
    storeId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const { merchantUuid, storeUuid } = await this.requireStoreRecord(
      merchantId,
      storeId,
    );
    const rows = await this.dataSource.query(
      `SELECT e.id AS "employeeId",
              e.employee_code AS "employeeCode",
              e.first_name AS "firstName",
              e.last_name AS "lastName",
              e.email,
              e.phone,
              e.status,
              e.profile_image_url AS "profileImageUrl",
              e.username,
              es.id AS "employeeStoreId",
              es.store_id AS "storeId",
              es.status AS "assignmentStatus",
              (COALESCE(es.login_pin_hash, e.login_pin_hash) IS NOT NULL) AS "pinSet",
              COALESCE(es.login_pin, e.login_pin) AS "loginPin",
              r.id AS "roleId",
              r.name AS "roleName",
              r.source_role_template_id AS "roleTemplateId"
       FROM public.employee_stores es
       JOIN public.employees e ON e.id = es.employee_id
       LEFT JOIN LATERAL (
         SELECT r.id, r.name, r.source_role_template_id
         FROM public.employee_store_roles esr
         JOIN public.roles r ON r.id = esr.role_id
         WHERE esr.employee_store_id = es.id AND esr.status = 'ACTIVE'
         ORDER BY esr.created_at ASC
         LIMIT 1
       ) r ON true
       WHERE es.merchant_id = $1
         AND es.store_id = $2
         AND es.status = 'ACTIVE'
         AND e.status = 'ACTIVE'
         AND e.merchant_id = es.merchant_id
       ORDER BY e.first_name ASC, e.last_name ASC`,
      [merchantUuid, storeUuid],
    );
    return rows;
  }

  async saveStoreEmployees(
    merchantId: string,
    storeId: string,
    employees: Array<{
      employee_id: string;
      role_template_id?: string;
      login_pin?: string;
    }> = [],
  ): Promise<void> {
    const { merchantCode, merchantUuid, storeUuid } =
      await this.requireStoreRecord(merchantId, storeId);
    const pins = employees
      .map((item) => item.login_pin)
      .filter((pin): pin is string => Boolean(pin));
    if (new Set(pins).size !== pins.length)
      throw new ConflictException(
        'Each store employee login PIN must be unique',
      );
    const keepIds: string[] = [];
    for (const item of employees) {
      const empIdParam = item.employee_id || (item as any).employeeId;
      const [employee] = await this.dataSource.query(
        `SELECT id, login_pin AS "loginPin",
                login_pin_hash AS "loginPinHash"
         FROM public.employees
         WHERE merchant_id = $2::uuid AND (id::text = $1 OR employee_code = $1)
         LIMIT 1`,
        [empIdParam, merchantUuid],
      );
      if (!employee)
        throw new BadRequestException(
          `Employee '${item.employee_id}' does not belong to this merchant`,
        );
      keepIds.push(employee.id);
      if (item.login_pin)
        await this.assertUniqueStoreLoginPin(
          storeUuid,
          employee.id,
          item.login_pin,
        );
      if (item.login_pin)
        await this.updateEmployeeMasterPin(employee.id, item.login_pin);
      const [existing] = await this.dataSource.query(
        `SELECT id, login_pin_hash AS "loginPinHash",
                login_pin AS "loginPin" FROM public.employee_stores
         WHERE merchant_id = $1 AND employee_id = $2::uuid AND store_id = $3 LIMIT 1`,
        [merchantUuid, employee.id, storeUuid],
      );
      // Assignment-screen requests commonly omit login_pin when assigning an
      // employee that already has a merchant-level PIN. Copy that PIN into the
      // store assignment so employee_stores remains the source used by POS.
      const assignmentPin =
        item.login_pin || employee.loginPin || existing?.loginPin || null;
      if (assignmentPin && !item.login_pin) {
        await this.assertUniqueStoreLoginPin(
          storeUuid,
          employee.id,
          assignmentPin,
        );
      }
      const pinHash = assignmentPin
        ? this.hashEmployeePin(assignmentPin)
        : existing?.loginPinHash || null;
      const pinValue = assignmentPin;
      let assignmentId = existing?.id as string | undefined;
      if (existing) {
        await this.dataSource.query(
          `UPDATE public.employee_stores
           SET login_pin_hash = $2, login_pin = $3,
               status = 'ACTIVE', updated_at = now()
           WHERE id = $1`,
          [existing.id, pinHash, pinValue],
        );
      } else {
        assignmentId = this.returningRow<{ id: string }>(
          await this.dataSource.query(
            `INSERT INTO public.employee_stores
               (merchant_id, employee_id, store_id, is_primary, login_pin_hash, login_pin, status)
           VALUES ($1, $2::uuid, $3, false, $4, $5, 'ACTIVE') RETURNING id`,
            [merchantUuid, employee.id, storeUuid, pinHash, pinValue],
          ),
        ).id;
      }
      if (!assignmentId)
        throw new InternalServerErrorException(
          'Store employee assignment was not saved',
        );
      await this.dataSource.query(
        `DELETE FROM public.employee_store_roles WHERE employee_store_id = $1`,
        [assignmentId],
      );
      if (!item.role_template_id) continue;
      const [role] = await this.dataSource.query(
        `SELECT id FROM public.roles
         WHERE source_role_template_id = $1::uuid AND status = 'ACTIVE' AND merchant_id::text = $2
         LIMIT 1`,
        [item.role_template_id, merchantCode],
      );
      if (!role)
        throw new BadRequestException(
          `Role template '${item.role_template_id}' is not available for this merchant`,
        );
      await this.dataSource.query(
        `INSERT INTO public.employee_store_roles (merchant_id, store_id, employee_store_id, role_id, status)
         VALUES ($1, $2, $3::uuid, $4::uuid, 'ACTIVE')`,
        [merchantUuid, storeUuid, assignmentId, role.id],
      );
    }
    const removeRoles = keepIds.length
      ? `DELETE FROM public.employee_store_roles WHERE employee_store_id IN (
           SELECT id FROM public.employee_stores
           WHERE merchant_id = $1 AND store_id = $2 AND employee_id <> ALL($3::uuid[])
         )`
      : `DELETE FROM public.employee_store_roles WHERE employee_store_id IN (
           SELECT id FROM public.employee_stores WHERE merchant_id = $1 AND store_id = $2
         )`;
    const removeStores = keepIds.length
      ? `DELETE FROM public.employee_stores
         WHERE merchant_id = $1 AND store_id = $2 AND employee_id <> ALL($3::uuid[])`
      : `DELETE FROM public.employee_stores WHERE merchant_id = $1 AND store_id = $2`;
    await this.dataSource.query(
      removeRoles,
      keepIds.length
        ? [merchantUuid, storeUuid, keepIds]
        : [merchantUuid, storeUuid],
    );
    await this.dataSource.query(
      removeStores,
      keepIds.length
        ? [merchantUuid, storeUuid, keepIds]
        : [merchantUuid, storeUuid],
    );
  }

  async assignStoreEmployeeLoginPin(
    merchantId: string,
    storeId: string,
    employeeId: string,
    loginPin: string,
  ) {
    if (!/^\d{6}$/.test(loginPin))
      throw new BadRequestException('loginPin must be a 6-digit string');
    const { merchantUuid, storeUuid } = await this.requireStoreRecord(
      merchantId,
      storeId,
    );
    const [employee] = await this.dataSource.query(
      `SELECT id FROM public.employees WHERE (id::text = $1 OR employee_code = $1) AND merchant_id = $2::uuid LIMIT 1`,
      [employeeId, merchantUuid],
    );
    if (!employee)
      throw new NotFoundException(
        `Employee '${employeeId}' not found for merchant '${merchantId}'`,
      );
    await this.assertUniqueStoreLoginPin(storeUuid, employee.id, loginPin);
    await this.updateEmployeeMasterPin(employee.id, loginPin);
    let assignment = (
      await this.dataSource.query(
        `SELECT id FROM public.employee_stores
       WHERE merchant_id = $1 AND employee_id = $2::uuid AND store_id = $3
       LIMIT 1`,
        [merchantUuid, employee.id, storeUuid],
      )
    )[0];
    if (!assignment) {
      assignment = this.returningRow(
        await this.dataSource.query(
        `INSERT INTO public.employee_stores
           (merchant_id, employee_id, store_id, is_primary, login_pin_hash, login_pin, status)
         VALUES ($1, $2::uuid, $3, false, $4, $5, 'ACTIVE') RETURNING id`,
          [
            merchantUuid,
            employee.id,
            storeUuid,
            this.hashEmployeePin(loginPin),
            loginPin,
          ],
        ),
      );
    } else {
      await this.dataSource.query(
        `UPDATE public.employee_stores
         SET login_pin_hash = $2, login_pin = $3,
             status = 'ACTIVE', updated_at = now()
         WHERE id = $1`,
        [assignment.id, this.hashEmployeePin(loginPin), loginPin],
      );
    }
    const employees = await this.listStoreEmployees(merchantId, storeId);
    return employees.find(
      (row) => String(row.employeeId) === String(employee.id),
    );
  }

  async updateStoreEmployeeAssignment(
    merchantId: string,
    storeId: string,
    employeeId: string,
    fields: { role_template_id?: string; login_pin?: string },
  ) {
    const { merchantCode, merchantUuid, storeUuid } =
      await this.requireStoreRecord(merchantId, storeId);
    const [employee] = await this.dataSource.query(
      `SELECT id FROM public.employees
       WHERE (id::text = $1 OR employee_code = $1) AND merchant_id = $2::uuid
       LIMIT 1`,
      [employeeId, merchantUuid],
    );
    if (!employee)
      throw new NotFoundException(
        `Employee '${employeeId}' not found for merchant '${merchantId}'`,
      );

    let assignment = (
      await this.dataSource.query(
        `SELECT id, login_pin_hash AS "loginPinHash",
                login_pin AS "loginPin" FROM public.employee_stores
         WHERE merchant_id = $1 AND employee_id = $2::uuid AND store_id = $3
         LIMIT 1`,
        [merchantUuid, employee.id, storeUuid],
      )
    )[0];
    if (fields.login_pin !== undefined) {
      if (!/^\d{6}$/.test(fields.login_pin))
        throw new BadRequestException('login_pin must be a 6-digit string');
      await this.assertUniqueStoreLoginPin(
        storeUuid,
        employee.id,
        fields.login_pin,
      );
      await this.updateEmployeeMasterPin(employee.id, fields.login_pin);
    }

    let roleId: string | undefined;
    if (fields.role_template_id !== undefined) {
      const [role] = await this.dataSource.query(
        `SELECT id FROM public.roles
         WHERE source_role_template_id = $1::uuid AND status = 'ACTIVE'
           AND merchant_id::text = $2
         LIMIT 1`,
        [fields.role_template_id, merchantCode],
      );
      if (!role)
        throw new BadRequestException(
          `Role template '${fields.role_template_id}' is not available for this merchant`,
        );
      roleId = role.id;
    }

    const pinHash = fields.login_pin === undefined
      ? assignment?.loginPinHash || null
      : this.hashEmployeePin(fields.login_pin);
    const pinValue = fields.login_pin === undefined
      ? assignment?.loginPin || null
      : fields.login_pin;
    if (!assignment) {
      assignment = this.returningRow(
        await this.dataSource.query(
          `INSERT INTO public.employee_stores
             (merchant_id, employee_id, store_id, is_primary, login_pin_hash, login_pin, status)
           VALUES ($1, $2::uuid, $3, false, $4, $5, 'ACTIVE') RETURNING id`,
          [merchantUuid, employee.id, storeUuid, pinHash, pinValue],
        ),
      );
    } else {
      await this.dataSource.query(
        `UPDATE public.employee_stores
         SET login_pin_hash = $2, login_pin = $3,
             status = 'ACTIVE', updated_at = now()
         WHERE id = $1`,
        [assignment.id, pinHash, pinValue],
      );
    }

    if (roleId) {
      await this.dataSource.query(
        `UPDATE public.employee_store_roles SET status = 'INACTIVE', updated_at = now()
         WHERE employee_store_id = $1::uuid AND status = 'ACTIVE'`,
        [assignment.id],
      );
      await this.dataSource.query(
        `INSERT INTO public.employee_store_roles
           (merchant_id, store_id, employee_store_id, role_id, status)
         VALUES ($1, $2, $3::uuid, $4::uuid, 'ACTIVE')
         ON CONFLICT (employee_store_id, role_id)
         DO UPDATE SET status = 'ACTIVE', updated_at = now()`,
        [merchantUuid, storeUuid, assignment.id, roleId],
      );
    }

    const employees = await this.listStoreEmployees(merchantId, storeId);
    return employees.find(
      (row) => String(row.employeeId) === String(employee.id),
    );
  }

  async saveWebsiteConnector(
    storeId: string,
    connector: StoreWebsiteConnectorConfig,
  ): Promise<StoreEntity | null> {
    const store = await this.storeRepo.findOne({
      where: { id: storeId, isDeleted: false },
    });
    if (!store) return null;
    store.websiteConnector = connector;
    store.updatedAt = new Date();
    return this.storeRepo.save(store);
  }

  async getWebsiteConnector(
    storeId: string,
  ): Promise<StoreWebsiteConnectorConfig | null> {
    const store = await this.storeRepo
      .createQueryBuilder('store')
      .addSelect('store.websiteConnector')
      .where('store.id = :storeId', { storeId })
      .getOne();
    if (store?.websiteConnector) return store.websiteConnector;

    const connection = await this.websiteConnectionRepo.findOneBy({ storeId });
    return connection
      ? {
          provider: 'WORDPRESS',
          wordpressUrl: connection.wordpressUrl,
          encryptedJwt: connection.encryptedJwt,
          updatedAt: connection.updatedAt.toISOString(),
        }
      : null;
  }

  async saveWebsiteConnection(fields: {
    storeId: string;
    merchantId: string;
    wordpressUrl: string;
    encryptedJwt: string;
    status: 'CONNECTED' | 'NOT_CONNECTED';
    lastTestedAt?: Date | null;
    lastTestMessage?: string | null;
  }): Promise<WebsiteConnectionEntity> {
    const existing = await this.websiteConnectionRepo.findOneBy({
      storeId: fields.storeId,
    });
    const entity = existing
      ? Object.assign(existing, fields, { updatedAt: new Date() })
      : this.websiteConnectionRepo.create(fields);
    const saved = await this.websiteConnectionRepo.save(entity);
    await this.saveWebsiteConnector(fields.storeId, {
      provider: 'WORDPRESS',
      wordpressUrl: fields.wordpressUrl,
      encryptedJwt: fields.encryptedJwt,
      updatedAt: saved.updatedAt.toISOString(),
    });
    return saved;
  }

  async getWebsiteConnection(
    storeId: string,
  ): Promise<WebsiteConnectionEntity | null> {
    return this.websiteConnectionRepo.findOneBy({ storeId });
  }

  async touchSession(
    sessionId: string,
    accessToken: string,
  ): Promise<any> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId || '');
    if (!isUuid || sessionId?.startsWith('sess_')) {
      try {
        const empSessions = await this.dataSource.query(
          `SELECT id, employee_id AS "accountId", store_id AS "storeId", merchant_id AS "merchantId", status FROM public.employee_sessions WHERE (id::text = $1 OR access_token = $2) AND status = 'Active' LIMIT 1`,
          [sessionId, accessToken],
        );
        if (empSessions[0]) {
          return {
            id: empSessions[0].id,
            accountId: empSessions[0].accountId,
            storeId: empSessions[0].storeId,
            merchantId: empSessions[0].merchantId,
            email: 'employee@pch.com',
            role: 'CASHIER',
          };
        }
      } catch {
        // Fallback for in-memory POS auth sessions
      }
      return {
        id: sessionId,
        accountId: 'pos_employee',
        email: 'employee@pch.com',
        role: 'CASHIER',
      };
    }
    const accessTokenHash = crypto
      .createHash('sha256')
      .update(accessToken)
      .digest('hex');
    const session = await this.sessionRepo
      .createQueryBuilder('session')
      .addSelect('session.accessTokenHash')
      .where('session.id = :sessionId', { sessionId })
      .getOne();
    if (
      session &&
      !session.revokedAt &&
      session.expiresAt.getTime() > Date.now() &&
      session.accessTokenHash === accessTokenHash
    ) {
      session.lastUsedAt = new Date();
      await this.sessionRepo.update(session.id, {
        lastUsedAt: session.lastUsedAt,
      });
      return session;
    }
    return null;
  }

  async activateTerminalByPin(pin: string): Promise<{
    success: boolean;
    store?: StoreEntity;
    entitlements?: string[];
    message?: string;
  }> {
    if (this.isRedisConnected && this.redisClient) {
      try {
        const cached = await this.redisClient.get(`pin:${pin}`);
        if (cached) {
          const store = JSON.parse(cached) as StoreEntity;
          const activeStore = await this.getStoreById(store.id);
          if (activeStore) {
            const { subscription } = await this.getMerchantById(
              activeStore.merchantId,
            );
            return {
              success: true,
              store: activeStore,
              entitlements: subscription?.plan?.includedFeatures || ['POS'],
            };
          }
          await this.redisClient.del(`pin:${pin}`);
        }
      } catch {}
    }

    const store = await this.storeRepo.findOne({
      where: { activationPin: pin, isDeleted: false },
    });
    if (!store) {
      return {
        success: false,
        message: 'Invalid 6-digit Activation PIN. Terminal pairing failed.',
      };
    }

    const { subscription } = await this.getMerchantById(store.merchantId);
    await this.cacheStorePin(pin, store);
    return {
      success: true,
      store,
      entitlements: subscription?.plan?.includedFeatures || [
        'POS',
        'BARCODE_SCANNING',
      ],
    };
  }

  async createOrUpdateSubscription(
    merchantId: string,
    data: Partial<SubscriptionEntity>,
  ): Promise<SubscriptionEntity> {
    const previous = (await this.listSubscriptions(merchantId)).find((row) =>
      [
        SubscriptionStatus.ACTIVE,
        SubscriptionStatus.TRIAL,
        SubscriptionStatus.PAST_DUE,
      ].includes(row.status),
    );
    const fields = await this.prepareSubscriptionContract(data, previous);
    const sub: SubscriptionEntity = {
      ...previous,
      ...fields,
      id: previous?.id || data.id || `SUB-${crypto.randomUUID()}`,
      merchantId,
      createdAt: previous?.createdAt || new Date(),
      updatedAt: new Date(),
    } as SubscriptionEntity;
    sub.subscriptionCode ||= sub.id;
    const saved = previous
      ? await this.updateSubscription(previous.id, fields)
      : await this.insertSubscription(sub);
    if (!saved) throw new NotFoundException('Subscription not found');
    await this.recordAuditLog(
      'SUBSCRIPTION_UPDATED',
      merchantId,
      undefined,
      'system',
      { planId: saved.planId },
    );
    return saved;
  }

  async listSubscriptions(merchantId?: string): Promise<SubscriptionEntity[]> {
    let owner: string | undefined;
    if (merchantId) {
      const identity = await this.merchantIdentity(merchantId);
      if (!identity) return [];
      owner = identity.merchantUuid;
    }
    const rows = await this.subRepo.find({
      where: owner ? { merchantId: owner } : {},
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    const current = (row: SubscriptionEntity) =>
      [
        SubscriptionStatus.ACTIVE,
        SubscriptionStatus.TRIAL,
        SubscriptionStatus.PAST_DUE,
      ].includes(row.status);
    const sorted = rows.sort((a, b) => Number(current(b)) - Number(current(a)));
    const planIds = [
      ...new Set(
        sorted
          .map((row) => row.planId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (planIds.length && this.dataSource?.isInitialized) {
      const plans = await this.dataSource.query(
        `SELECT p.id::text AS id,
          COALESCE(to_jsonb(p)->>'plan_code', to_jsonb(p)->>'planCode', '') AS plan_code,
          p.name,
          COALESCE(to_jsonb(p)->>'base_price', to_jsonb(p)->>'basePrice', '0')::numeric AS base_price,
          p.currency,
          COALESCE(to_jsonb(p)->>'billing_cycle', to_jsonb(p)->>'billingCycle', '') AS billing_cycle,
          COALESCE(to_jsonb(p)->>'store_type_id', to_jsonb(p)->>'storeTypeId', '') AS store_type_id,
          COALESCE(to_jsonb(p)->>'included_stores', to_jsonb(p)->>'stores_limit', to_jsonb(p)->>'includedStores', '0')::integer AS included_stores,
          COALESCE(to_jsonb(p)->>'included_terminals', to_jsonb(p)->>'terminal_limit', to_jsonb(p)->>'includedTerminals', '0')::integer AS included_terminals,
          CASE WHEN st.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', st.id,
            'code', COALESCE(to_jsonb(st)->>'storeTypeCode', to_jsonb(st)->>'store_type_code', ''),
            'name', st.name
          ) END AS store_type
         FROM public.plans p
         LEFT JOIN public.store_types st
           ON st.id::text = COALESCE(to_jsonb(p)->>'store_type_id', to_jsonb(p)->>'storeTypeId', '')
         WHERE p.id::text = ANY($1::text[])`,
        [planIds],
      );
      const byId = new Map<string, Record<string, any>>(
        plans.map(
          (plan: Record<string, any>) => [String(plan.id), plan] as const,
        ),
      );
      for (const row of sorted) {
        const plan = row.planId ? byId.get(row.planId) : undefined;
        if (plan) {
          (row as any).plan = {
            id: plan.id,
            planCode: plan.plan_code,
            name: plan.name,
            basePrice: Number(plan.base_price),
            currency: plan.currency,
            billingCycle: plan.billing_cycle,
            storeTypeId: plan.store_type_id || null,
            storeType: plan.store_type,
            includedStores: Number(plan.included_stores),
            includedTerminals: Number(plan.included_terminals),
          };
          if (plan.store_type) {
            (row as any).storeTypeId = plan.store_type.id;
            (row as any).storeType = plan.store_type;
          }
        }
        withPlanLicenseCounts(row as Record<string, any>, plan);
      }
    }
    return sorted;
  }

  async getSubscription(id: string): Promise<SubscriptionEntity | null> {
    const subscription = await this.subRepo.findOneBy({ id });
    if (!subscription) return null;
    return (
      (await this.listSubscriptions(subscription.merchantId)).find(
        (row) => row.id === id,
      ) || null
    );
  }

  async insertSubscription(
    subscription: SubscriptionEntity,
  ): Promise<SubscriptionEntity> {
    try {
      await this.subRepo.insert(subscription);
    } catch (error: any) {
      this.subscriptionWriteError(error);
      throw error;
    }
    await this.recordAuditLog(
      'SUBSCRIPTION_CREATED',
      subscription.merchantId,
      undefined,
      'merchant',
      { subscriptionId: subscription.id },
    );
    return (await this.getSubscription(subscription.id))!;
  }

  async updateSubscription(
    id: string,
    fields: Partial<SubscriptionEntity>,
  ): Promise<SubscriptionEntity | null> {
    const existing = await this.getSubscription(id);
    if (!existing) return null;
    const subscription = {
      ...existing,
      ...fields,
      id,
      merchantId: existing.merchantId,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
    };
    try {
      if (
        !(
          await this.subRepo.update(id, {
            ...fields,
            updatedAt: subscription.updatedAt,
          })
        ).affected
      )
        return null;
    } catch (error) {
      this.subscriptionWriteError(error);
      throw error;
    }
    await this.recordAuditLog(
      'SUBSCRIPTION_UPDATED',
      subscription.merchantId,
      undefined,
      'merchant',
      { subscriptionId: id },
    );
    return (await this.getSubscription(id))!;
  }

  async deleteSubscription(id: string): Promise<boolean> {
    const existing = await this.getSubscription(id);
    if (!existing) return false;
    try {
      if (!(await this.subRepo.delete(id)).affected) return false;
    } catch (error) {
      this.subscriptionWriteError(error);
      throw error;
    }
    await this.recordAuditLog(
      'SUBSCRIPTION_DELETED',
      existing.merchantId,
      undefined,
      'merchant',
      { subscriptionId: id },
    );
    return true;
  }

  private subscriptionWriteError(error: any): void {
    const code = error.driverError?.code || error.code;
    if (code === '23505')
      throw new ConflictException(
        'Subscription ID or subscription code already exists',
      );
    if (code === '23503')
      throw new ConflictException(
        'Subscription references an invalid parent or is in use; cancel it to preserve history',
      );
    if (code === '23514')
      throw new BadRequestException(
        'Invalid subscription dates, price or licensed counts',
      );
  }

  async prepareSubscriptionContract(
    input: Record<string, any>,
    existing?: SubscriptionEntity,
  ): Promise<Partial<SubscriptionEntity>> {
    const fields: Record<string, any> = existing
      ? { ...existing }
      : {
          status: SubscriptionStatus.ACTIVE,
          startDate: null,
          renewalDate: null,
          trialEndDate: null,
          licensedStoreCount: null,
          licensedDeviceCount: null,
          trialDays: 0,
          cancelledAt: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
        };
    for (const key of [
      'subscriptionCode',
      'billingCycle',
      'status',
      'price',
      'currency',
      'startDate',
      'renewalDate',
      'trialEndDate',
      'licensedStoreCount',
      'licensedDeviceCount',
      'trialDays',
    ]) {
      if (input[key] !== undefined) fields[key] = input[key];
    }
    const selected =
      input.planId || input.planCode || existing?.planId || existing?.planCode;
    if (!selected)
      throw new BadRequestException('Select an active commercial plan');
    const changingPlan =
      !existing || input.planId !== undefined || input.planCode !== undefined;
    if (changingPlan) {
      const plan = await this.getPlanByIdOrCode(selected);
      if (!plan || plan.status !== 'ACTIVE')
        throw new BadRequestException(
          'Select an active commercial plan from plans',
        );
      if (existing?.planId)
        await this.assertSameStoreTypePlan(existing.planId, plan.id);
      if (input.planId && input.planCode && input.planCode !== plan.planCode)
        throw new BadRequestException(
          'planId and planCode refer to different plans',
        );
      fields.planId = plan.id;
      fields.planCode = plan.planCode;
      fields.planName = plan.name;
      fields.billingCycle = input.billingCycle ?? plan.billingCycle;
      fields.price = input.price ?? Number(plan.basePrice);
      fields.currency = input.currency ?? plan.currency;
      const entitlements = await this.dataSource.query(
        'SELECT f.feature_key, e.enabled, e.limit_value FROM public.plan_entitlements e JOIN public.features f ON f.id=e.feature_id WHERE e.plan_id=$1',
        [plan.id],
      );
      const entitlementLimit = (feature: string) => {
        const value = entitlements.find(
          (row: any) => row.feature_key === feature && row.enabled,
        )?.limit_value;
        return value != null &&
          /^\d+$/.test(value) &&
          Number(value) <= 2147483647
          ? Number(value)
          : null;
      };
      if (input.licensedStoreCount === undefined) {
        const fromPlan = plan.includedStores ?? (plan as any).included_stores;
        fields.licensedStoreCount =
          fromPlan != null ? Number(fromPlan) : entitlementLimit('MAX_STORES');
      }
      if (input.licensedDeviceCount === undefined) {
        const fromPlan =
          plan.includedTerminals ?? (plan as any).included_terminals;
        fields.licensedDeviceCount =
          fromPlan != null ? Number(fromPlan) : entitlementLimit('MAX_DEVICES');
      }
    }
    if (input.maxStoresAllowed !== undefined) {
      if (
        input.licensedStoreCount !== undefined &&
        input.licensedStoreCount !== input.maxStoresAllowed
      )
        throw new BadRequestException('Conflicting store count fields');
      fields.licensedStoreCount = input.maxStoresAllowed;
    }
    for (const [alias, canonical] of [
      ['currentPeriodStart', 'startDate'],
      ['currentPeriodEnd', 'renewalDate'],
    ]) {
      if (input[alias] !== undefined) {
        const date = new Date(input[alias]);
        if (!Number.isFinite(date.getTime()))
          throw new BadRequestException(`Invalid ${alias}`);
        const day = date.toISOString().slice(0, 10);
        if (input[canonical] !== undefined && input[canonical] !== day)
          throw new BadRequestException(
            `Conflicting ${alias} and ${canonical}`,
          );
        fields[canonical] = day;
        fields[alias] = date;
      } else if (input[canonical] !== undefined)
        fields[alias] =
          input[canonical] === null
            ? null
            : new Date(input[canonical] + 'T00:00:00Z');
    }
    if (
      fields.startDate &&
      fields.renewalDate &&
      fields.renewalDate <= fields.startDate
    )
      throw new BadRequestException('renewalDate must be after startDate');
    if (
      fields.startDate &&
      fields.trialEndDate &&
      fields.trialEndDate < fields.startDate
    )
      throw new BadRequestException('trialEndDate cannot precede startDate');
    fields.maxStoresAllowed = fields.licensedStoreCount ?? 0;
    if (fields.status === SubscriptionStatus.CANCELLED)
      fields.cancelledAt = existing?.cancelledAt || new Date();
    else if (existing?.status === SubscriptionStatus.CANCELLED)
      fields.cancelledAt = null;
    for (const key of ['id', 'merchantId', 'createdAt', 'updatedAt'])
      delete fields[key];
    return fields;
  }

  private async cacheStorePin(pin: string, store: StoreEntity): Promise<void> {
    if (this.isRedisConnected && this.redisClient) {
      try {
        await this.redisClient.set(
          `pin:${pin}`,
          JSON.stringify(store),
          'EX',
          86400 * 30,
        );
      } catch {}
    }
  }

  async listSubscriptionPlans(): Promise<SubscriptionPlanEntity[]> {
    return this.planRepo.find({ order: { planCode: 'ASC' } });
  }

  async getSubscriptionPlan(
    planCode: string,
  ): Promise<SubscriptionPlanEntity | null> {
    return this.planRepo.findOneBy({ planCode });
  }

  async createSubscriptionPlan(
    plan: SubscriptionPlanEntity,
  ): Promise<SubscriptionPlanEntity> {
    try {
      await this.planRepo.insert(plan);
    } catch (error: any) {
      if (error.code === '23505' || error.driverError?.code === '23505')
        throw new ConflictException('Plan code already exists');
      throw error;
    }
    return plan;
  }

  async updateSubscriptionPlan(
    planCode: string,
    fields: Partial<SubscriptionPlanEntity>,
  ): Promise<SubscriptionPlanEntity | null> {
    const existing = await this.getSubscriptionPlan(planCode);
    if (!existing) return null;
    const plan = {
      ...existing,
      ...fields,
      planCode,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
    };
    if (
      !(
        await this.planRepo.update(
          { planCode },
          { ...fields, updatedAt: plan.updatedAt },
        )
      ).affected
    )
      return null;
    return plan;
  }

  async deleteSubscriptionPlan(planCode: string): Promise<boolean> {
    if (!(await this.getSubscriptionPlan(planCode))) return false;
    const inUse = await this.subRepo.existsBy({
      planCode: planCode as PlanCode,
    });
    if (inUse)
      throw new ConflictException(
        'Plan is assigned to a merchant. Set its status to INACTIVE instead.',
      );
    return Boolean((await this.planRepo.delete({ planCode })).affected);
  }

  async fetchLiveWordPressCatalog(
    storeUrl?: string,
    jwtToken?: string,
  ): Promise<
    Array<{
      name: string;
      category: string;
      price: number;
      sku: string;
      stock: number;
      description?: string;
    }>
  > {
    const baseUrl = (
      storeUrl || 'https://aascorner.alektasolutions.com'
    ).replace(/\/+$/, '');
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (jwtToken?.trim()) {
      headers['Authorization'] = `Bearer ${jwtToken.trim()}`;
    }

    const items: Array<{
      name: string;
      category: string;
      price: number;
      sku: string;
      stock: number;
      description?: string;
    }> = [];

    try {
      // 1. Fetch Categories API from WooCommerce / WordPress
      let categories: Array<{ id: number; name: string }> = [];
      try {
        const catRes = await (globalThis as any).fetch(
          `${baseUrl}/wp-json/wc/v3/products/categories?page=1&per_page=100&hide_empty=true`,
          { headers },
        );
        if (catRes.ok) {
          const catData = await catRes.json();
          if (Array.isArray(catData)) {
            categories = catData.map((c: any) => ({
              id: c.id,
              name: c.name || 'General',
            }));
          }
        }
      } catch (catErr: any) {
        console.log(`âš ï¸ WordPress Category fetch error: ${catErr.message}`);
      }

      if (categories.length === 0) {
        categories = [
          { id: 44, name: 'Products' },
          { id: 1, name: 'General' },
        ];
      }

      // 2. Fetch Products per Category using custom pinaka-pos API
      for (const cat of categories) {
        try {
          const prodRes = await (globalThis as any).fetch(
            `${baseUrl}/wp-json/pinaka-pos/v1/products-by-category/${cat.id}`,
            { headers },
          );
          if (prodRes.ok) {
            const rawData = await prodRes.json();
            const productList = Array.isArray(rawData)
              ? rawData
              : rawData?.products || rawData?.data || [];

            for (const p of productList) {
              const name = p.name || p.title || p.post_title || 'Unnamed Item';
              const price =
                parseFloat(
                  p.price || p.regular_price || p.sale_price || '0.00',
                ) || 0;
              const sku =
                p.sku ||
                p.id?.toString() ||
                `ITEM-${Math.floor(Math.random() * 10000)}`;
              const stock =
                parseInt(
                  p.stock_quantity || p.stock || p.quantity || '50',
                  10,
                ) || 50;
              const description =
                p.description ||
                p.short_description ||
                `Imported from ${baseUrl}`;

              items.push({
                name,
                category: cat.name || p.category || 'Retail',
                price,
                sku: String(sku),
                stock,
                description,
              });
            }
          }
        } catch (e: any) {
          console.log(
            `âš ï¸ Category ${cat.id} product fetch warning: ${e.message}`,
          );
        }
      }

      // 3. Fallback to WooCommerce standard products API if custom endpoint was empty
      if (items.length === 0) {
        try {
          const directRes = await (globalThis as any).fetch(
            `${baseUrl}/wp-json/wc/v3/products?per_page=100`,
            { headers },
          );
          if (directRes.ok) {
            const rawProds = await directRes.json();
            if (Array.isArray(rawProds)) {
              for (const p of rawProds) {
                items.push({
                  name: p.name || 'Product',
                  category: p.categories?.[0]?.name || 'General',
                  price: parseFloat(p.price || '0') || 0,
                  sku: p.sku || p.id?.toString() || `SKU-WC-${p.id}`,
                  stock: p.stock_quantity || 50,
                  description: p.description || '',
                });
              }
            }
          }
        } catch (dirErr: any) {
          console.log(
            `âš ï¸ WooCommerce direct products fetch warning: ${dirErr.message}`,
          );
        }
      }
    } catch (err: any) {
      console.log(`âš ï¸ WordPress Catalog Ingest Error: ${err.message}`);
    }

    // If WordPress API returns empty or unreachable, return sample products as fallback
    if (items.length === 0) {
      return [
        {
          name: 'Organic Red Apples (1kg)',
          category: 'Produce',
          price: 4.99,
          sku: 'PROD-APP-01',
          stock: 150,
        },
        {
          name: 'Whole Organic Milk (1 Gal)',
          category: 'Dairy',
          price: 5.49,
          sku: 'DAIRY-MLK-01',
          stock: 80,
        },
        {
          name: 'Artisan Sourdough Bread',
          category: 'Bakery',
          price: 6.29,
          sku: 'BAK-BRD-01',
          stock: 45,
        },
        {
          name: 'Avocado Pack (4ct)',
          category: 'Produce',
          price: 3.99,
          sku: 'PROD-AVO-04',
          stock: 120,
        },
        {
          name: 'Greek Yogurt Vanilla 32oz',
          category: 'Dairy',
          price: 4.79,
          sku: 'DAIRY-YOG-01',
          stock: 60,
        },
        {
          name: 'Organic Chicken Breast 1lb',
          category: 'Meat',
          price: 8.99,
          sku: 'MEAT-CHK-01',
          stock: 35,
        },
        {
          name: 'Atlantic Salmon Fillet 1lb',
          category: 'Seafood',
          price: 12.99,
          sku: 'SEA-SLM-01',
          stock: 25,
        },
        {
          name: 'Sparkling Mineral Water 12pk',
          category: 'Beverages',
          price: 7.99,
          sku: 'BEV-WTR-12',
          stock: 90,
        },
        {
          name: 'Organic Extra Virgin Olive Oil',
          category: 'Pantry',
          price: 14.49,
          sku: 'PAN-OIL-01',
          stock: 50,
        },
        {
          name: 'Fair Trade Dark Chocolate Bar',
          category: 'Snacks',
          price: 3.49,
          sku: 'SNK-CHO-01',
          stock: 200,
        },
      ];
    }

    return items;
  }

  async syncStoreCatalogFromWordPress(params: {
    merchantId: string;
    storeId: string;
    wordpressUrl: string;
    wordpressJwt: string;
  }): Promise<{ categoryCount: number; productCount: number; attributeCount: number; tagCount: number }> {
    const productCount = await this.syncStoreProductsFromWordPress(params);
    const categoryCount = await this.syncStoreCategoriesFromWordPress(params);
    const attributeCount = await this.syncStoreAttributesFromWordPress(params);
    const tagCount = await this.syncStoreTagsFromWordPress(params);
    return { categoryCount, productCount, attributeCount, tagCount };
  }

  async syncStoreProductsFromWordPress(params: {
    storeId: string;
    wordpressUrl: string;
    wordpressJwt: string;
  }): Promise<number> {
    const products = await this.fetchWooCollection(
      params.wordpressUrl,
      params.wordpressJwt,
      '/wp-json/wc/v3/products',
      { per_page: '100' },
    );
    const variations: unknown[] = [];
    for (const product of products) {
      const record = product as Record<string, unknown>;
      const id = Number(record.id);
      const variationIds = Array.isArray(record.variations) ? record.variations : [];
      if (record.type !== 'variable' || !Number.isFinite(id) || variationIds.length === 0) continue;
      const children = await this.fetchWooCollection(
        params.wordpressUrl,
        params.wordpressJwt,
        `/wp-json/wc/v3/products/${id}/variations`,
        { per_page: '100' },
      );
      variations.push(...children);
    }
    const merged = new Map<string, unknown>();
    for (const item of [...products, ...variations]) {
      const record = item as Record<string, unknown>;
      if (record?.id === undefined || record?.id === null) continue;
      merged.set(String(record.id), item);
    }
    const payload = [...merged.values()];
    await this.saveStoreProductPayload(params.storeId, payload);
    return payload.length;
  }

  async syncStoreCategoriesFromWordPress(params: {
    storeId: string;
    wordpressUrl: string;
    wordpressJwt: string;
  }): Promise<number> {
    const categories = await this.fetchWooCollection(
      params.wordpressUrl,
      params.wordpressJwt,
      '/wp-json/wc/v3/products/categories',
      { per_page: '100', hide_empty: 'true', parent: '0' },
    );
    await this.saveStoreCategoryColumn(params.storeId, 'payload', categories);
    return categories.length;
  }

  async syncStoreAttributesFromWordPress(params: {
    storeId: string;
    wordpressUrl: string;
    wordpressJwt: string;
  }): Promise<number> {
    const attributes = await this.fetchWooCollection(
      params.wordpressUrl,
      params.wordpressJwt,
      '/wp-json/wc/v3/products/attributes',
      { per_page: '100' },
    );
    await this.saveStoreCategoryColumn(params.storeId, 'attributes', attributes);
    return attributes.length;
  }

  async syncStoreTagsFromWordPress(params: {
    storeId: string;
    wordpressUrl: string;
    wordpressJwt: string;
  }): Promise<number> {
    const tags = await this.fetchWooCollection(
      params.wordpressUrl,
      params.wordpressJwt,
      '/wp-json/wc/v3/products/tags',
      { per_page: '100' },
    );
    await this.saveStoreCategoryColumn(params.storeId, 'tags', tags);
    return tags.length;
  }

  private async fetchWooCollection(
    wordpressUrl: string,
    wordpressJwt: string,
    path: string,
    query: Record<string, string>,
  ): Promise<unknown[]> {
    const baseUrl = wordpressUrl.replace(/\/+$/, '');
    const items: unknown[] = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages && page <= 200) {
      const url = new URL(`${baseUrl}${path}`);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      url.searchParams.set('page', String(page));
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${wordpressJwt}`,
        },
      });
      if (!response.ok) {
        throw new BadRequestException(
          `WordPress API ${path} returned HTTP ${response.status}. Check the site URL and JWT token.`,
        );
      }
      const body = await response.json();
      const pageItems = Array.isArray(body) ? body : [];
      items.push(...pageItems);
      const reportedPages = Number(response.headers.get('x-wp-totalpages'));
      totalPages = Number.isFinite(reportedPages) && reportedPages > 0 ? reportedPages : page;
      if (pageItems.length === 0) break;
      page += 1;
    }
    return items;
  }

  private async fetchWordPressParentCategories(
    wordpressUrl: string,
    wordpressJwt: string,
  ): Promise<unknown[]> {
    const baseUrl = wordpressUrl.replace(/\/+$/, '');
    const categories: unknown[] = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages && page <= 50) {
      const url = new URL(`${baseUrl}/wp-json/wc/v3/products/categories`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', '100');
      url.searchParams.set('hide_empty', 'true');
      url.searchParams.set('parent', '0');
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${wordpressJwt}`,
        },
      });
      if (!response.ok) {
        throw new BadRequestException(
          `WordPress categories API returned HTTP ${response.status}. Check the site URL and JWT token.`,
        );
      }
      const body = await response.json();
      if (Array.isArray(body)) categories.push(...body);
      const reportedPages = Number(response.headers.get('x-wp-totalpages'));
      totalPages = Number.isFinite(reportedPages) && reportedPages > 0 ? reportedPages : page;
      page += 1;
    }
    return categories;
  }

  private async ensureStoreCategoriesTable(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS public.store_categories (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL,
        payload jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_by uuid,
        updated_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        is_deleted boolean NOT NULL DEFAULT false,
        CONSTRAINT store_categories_pkey PRIMARY KEY (id),
        CONSTRAINT store_categories_store_id_fkey FOREIGN KEY (store_id)
          REFERENCES public.stores (id)
      )
    `);
    await this.dataSource.query(`
      ALTER TABLE public.store_categories
      ADD COLUMN IF NOT EXISTS attributes jsonb
    `);
    await this.dataSource.query(`
      ALTER TABLE public.store_categories
      ADD COLUMN IF NOT EXISTS tags jsonb
    `);
    await this.dataSource.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS store_categories_store_id_uidx
      ON public.store_categories (store_id)
    `);
  }

  private async saveStoreProductPayload(
    storeId: string,
    products: unknown[],
  ): Promise<void> {
    await this.ensureStoreProductsStoreIdUniqueIndex();
    await this.dataSource.query(
      `INSERT INTO public.store_products (store_id, payload, updated_at)
       VALUES ($1::uuid, $2::jsonb, now())
       ON CONFLICT (store_id)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), is_deleted = false`,
      [storeId, JSON.stringify(products)],
    );
  }

  private async saveStoreCategoryColumn(
    storeId: string,
    column: 'payload' | 'attributes' | 'tags',
    value: unknown[],
  ): Promise<void> {
    await this.ensureStoreCategoriesTable();
    const json = JSON.stringify(value);
    if (column === 'payload') {
      await this.dataSource.query(
        `INSERT INTO public.store_categories (store_id, payload, updated_at)
         VALUES ($1::uuid, $2::jsonb, now())
         ON CONFLICT (store_id)
         DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), is_deleted = false`,
        [storeId, json],
      );
      return;
    }
    if (column === 'attributes') {
      await this.dataSource.query(
        `INSERT INTO public.store_categories (store_id, attributes, updated_at)
         VALUES ($1::uuid, $2::jsonb, now())
         ON CONFLICT (store_id)
         DO UPDATE SET attributes = EXCLUDED.attributes, updated_at = now(), is_deleted = false`,
        [storeId, json],
      );
      return;
    }
    await this.dataSource.query(
      `INSERT INTO public.store_categories (store_id, tags, updated_at)
       VALUES ($1::uuid, $2::jsonb, now())
       ON CONFLICT (store_id)
       DO UPDATE SET tags = EXCLUDED.tags, updated_at = now(), is_deleted = false`,
      [storeId, json],
    );
  }

  private async saveStoreCategories(
    storeId: string,
    payload: unknown[],
  ): Promise<void> {
    await this.ensureStoreCategoriesTable();
    await this.dataSource.query(
      `INSERT INTO public.store_categories (store_id, payload, updated_at)
       VALUES ($1::uuid, $2::jsonb, now())
       ON CONFLICT (store_id)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), is_deleted = false`,
      [storeId, JSON.stringify(payload)],
    );
  }

  async getStoreCategoriesByStoreId(storeId: string): Promise<unknown> {
    await this.ensureStoreCategoriesTable();
    const rows = await this.dataSource.query(
      `SELECT payload
       FROM public.store_categories
       WHERE store_id = $1::uuid
         AND COALESCE(is_deleted, false) = false
       LIMIT 1`,
      [storeId],
    );
    return rows[0]?.payload ?? null;
  }

  async getStoreCatalogTaxonomiesByStoreId(storeId: string) {
    await this.ensureStoreCategoriesTable();
    const rows = await this.dataSource.query(
      `SELECT payload AS categories, tags, attributes, updated_at
       FROM public.store_categories
       WHERE store_id = $1::uuid
         AND COALESCE(is_deleted, false) = false
       LIMIT 1`,
      [storeId],
    );
    const row = rows[0];
    return {
      categories: Array.isArray(row?.categories) ? row.categories : [],
      tags: Array.isArray(row?.tags) ? row.tags : [],
      attributes: Array.isArray(row?.attributes) ? row.attributes : [],
      updatedAt: row?.updated_at ?? null,
    };
  }

  async findStoreProductBySku(storeId: string, sku: string): Promise<unknown[]> {
    let code = String(sku ?? '').trim();
    try {
      code = decodeURIComponent(code).trim();
    } catch {
      throw new BadRequestException('sku is not valid');
    }
    if (!code) throw new BadRequestException('sku is required');
    let rows: Array<{ product?: unknown }> = [];
    try {
      rows = await this.dataSource.query(
        `SELECT product
         FROM public.store_products AS catalog
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(catalog.payload) = 'array' THEN catalog.payload
             ELSE '[]'::jsonb
           END
         ) AS product
         WHERE catalog.store_id = $1::uuid
           AND COALESCE(catalog.is_deleted, false) = false
           AND product->>'sku' = $2`,
        [storeId, code],
      );
    } catch (error: unknown) {
      const postgresCode = error && typeof error === 'object'
        ? (error as { code?: string; driverError?: { code?: string } }).code
          ?? (error as { driverError?: { code?: string } }).driverError?.code
        : undefined;
      if (postgresCode === '42P01' || postgresCode === '42703') return [];
      throw error;
    }
    return rows
      .map((row) => row.product)
      .filter((product) => product !== undefined && product !== null);
  }

  async searchStoreProducts(
    storeId: string,
    search: string,
  ): Promise<unknown[] | null> {
    const term = String(search ?? '').trim();
    if (!term) return null;
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    let rows: Array<{ products?: unknown }> = [];
    try {
      rows = await this.dataSource.query(
        `SELECT COALESCE(jsonb_agg(match.product), '[]'::jsonb) AS products
         FROM (
           SELECT product
           FROM public.store_products AS catalog
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(catalog.payload) = 'array' THEN catalog.payload
               ELSE '[]'::jsonb
             END
           ) AS product
           WHERE catalog.store_id = $1::uuid
             AND COALESCE(catalog.is_deleted, false) = false
             AND (
               COALESCE(product->>'name', '') ILIKE $2 ESCAPE '\\'
               OR COALESCE(product->>'sku', '') ILIKE $2 ESCAPE '\\'
               OR COALESCE(product->>'slug', '') ILIKE $2 ESCAPE '\\'
             )
           ORDER BY product->>'name'
           LIMIT 50
         ) AS match`,
        [storeId, pattern],
      );
    } catch (error: unknown) {
      const code =
        error && typeof error === 'object'
          ? (error as { code?: string; driverError?: { code?: string } }).code
            ?? (error as { driverError?: { code?: string } }).driverError?.code
          : undefined;
      if (code === '42P01' || code === '42703') return null;
      throw error;
    }
    const products = rows[0]?.products;
    if (!Array.isArray(products) || products.length === 0) return null;
    return products.map((product) =>
      this.presentWooProduct(this.asRecord(product) ?? {}, null),
    );
  }

  async getStoreProductVariations(
    storeId: string,
    productId: string,
  ): Promise<unknown[] | null> {
    const parentId = String(productId ?? '').trim();

    if (!/^\d+$/.test(parentId)) {
      throw new BadRequestException('productId must be a number');
    }

    let rows: Array<{ products?: unknown }> = [];

    try {
      rows = await this.dataSource.query(
        `
        WITH catalog_products AS MATERIALIZED (
          SELECT product.item
          FROM public.store_products AS catalog
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(catalog.payload) = 'array'
                THEN catalog.payload
              ELSE '[]'::jsonb
            END
          ) AS product(item)
          WHERE catalog.store_id = $1::uuid
            AND COALESCE(catalog.is_deleted, false) = false
        ),
        parent_variations AS (
          SELECT variation.id AS variation_id
          FROM catalog_products AS parent
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(parent.item->'variations') = 'array'
                THEN parent.item->'variations'
              ELSE '[]'::jsonb
            END
          ) AS variation(id)
          WHERE parent.item->>'id' = $2
        ),
        matched_products AS (
          SELECT product.item
          FROM catalog_products AS product
          WHERE product.item->>'parent_id' = $2

          UNION

          SELECT child.item
          FROM catalog_products AS child
          INNER JOIN parent_variations AS variation
            ON child.item->>'id' = variation.variation_id
          WHERE child.item->>'id' <> $2
        )
        SELECT COALESCE(
          jsonb_agg(
            matched.item
            ORDER BY
              matched.item->>'menu_order',
              matched.item->>'id'
          ),
          '[]'::jsonb
        ) AS products
        FROM matched_products AS matched
        `,
        [storeId, parentId],
      );
    } catch (error: unknown) {
      const code =
        error && typeof error === 'object'
          ? (
              error as {
                code?: string;
                driverError?: { code?: string };
              }
            ).code ??
            (
              error as {
                driverError?: { code?: string };
              }
            ).driverError?.code
          : undefined;

      if (code === '42P01' || code === '42703') {
        return [];
      }

      throw error;
    }

    const products = rows[0]?.products;

    if (!Array.isArray(products) || products.length === 0) {
      return [];
    }

    return products.map((product) =>
      this.presentWooProduct(this.asRecord(product) ?? {}, null),
    );
  }

  async getStoreProductsByCategoryId(
    storeId: string,
    categoryId: string,
  ): Promise<unknown[] | null> {
    const categoryKey = String(categoryId ?? '').trim();
    if (!/^\d+$/.test(categoryKey)) {
      throw new BadRequestException('categoryId must be a number');
    }
    const [productRows, categoryRows, taxConfiguration] = await Promise.all([
      this.dataSource.query(
        `SELECT COALESCE(jsonb_agg(product), '[]'::jsonb) AS products
         FROM public.store_products AS catalog
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(catalog.payload) = 'array' THEN catalog.payload
             ELSE '[]'::jsonb
           END
         ) AS product
         WHERE catalog.store_id = $1::uuid
           AND COALESCE(catalog.is_deleted, false) = false
           AND (
             product->>'categoryId' = $2
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 CASE
                   WHEN jsonb_typeof(product->'categories') = 'array' THEN product->'categories'
                   ELSE '[]'::jsonb
                 END
               ) AS category
               WHERE category->>'id' = $2
             )
           )`,
        [storeId, categoryKey],
      ),
      this.dataSource.query(
        `SELECT category
         FROM public.store_categories AS catalog
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(catalog.payload) = 'array' THEN catalog.payload
             ELSE '[]'::jsonb
           END
         ) AS category
         WHERE catalog.store_id = $1::uuid
           AND COALESCE(catalog.is_deleted, false) = false
           AND category->>'id' = $2
         LIMIT 1`,
        [storeId, categoryKey],
      ).catch((error: unknown) => {
        const code =
          error && typeof error === 'object'
            ? (error as { code?: string; driverError?: { code?: string } }).code
              ?? (error as { driverError?: { code?: string } }).driverError?.code
            : undefined;
        if (code === '42P01' || code === '42703') return [];
        throw error;
      }),
      this.getStoreProductTaxConfiguration(storeId),
    ]);
    const products = productRows[0]?.products;
    if (!Array.isArray(products) || products.length === 0) return null;
    const category = this.asRecord(categoryRows[0]?.category);
    return products.map((product) =>
      this.presentWooProduct(this.asRecord(product) ?? {}, category, taxConfiguration),
    );
  }

  private presentWooProduct(
    product: Record<string, unknown>,
    category: Record<string, unknown> | null,
    taxConfiguration: StoreProductTaxConfiguration | null = null,
  ): Record<string, unknown> {
    const value = (key: string): unknown =>
      Object.prototype.hasOwnProperty.call(product, key) && product[key] !== undefined
        ? product[key]
        : null;
    const dimensions = this.asRecord(product.dimensions);
    const tax = this.productTax(product, category, taxConfiguration);
    return {
      id: this.numberOrNull(product.id),
      name: value('name'),
      slug: value('slug'),
      permalink: value('permalink'),
      date_created: value('date_created'),
      date_created_gmt: value('date_created_gmt'),
      date_modified: value('date_modified'),
      date_modified_gmt: value('date_modified_gmt'),
      type: value('type'),
      status: value('status'),
      featured: value('featured'),
      catalog_visibility: value('catalog_visibility'),
      description: value('description'),
      short_description: value('short_description'),
      sku: value('sku'),
      price: value('price'),
      regular_price: value('regular_price'),
      sale_price: value('sale_price'),
      date_on_sale_from: value('date_on_sale_from'),
      date_on_sale_from_gmt: value('date_on_sale_from_gmt'),
      date_on_sale_to: value('date_on_sale_to'),
      date_on_sale_to_gmt: value('date_on_sale_to_gmt'),
      on_sale: value('on_sale'),
      purchasable: value('purchasable'),
      total_sales: value('total_sales'),
      virtual: value('virtual'),
      downloadable: value('downloadable'),
      downloads: value('downloads'),
      download_limit: value('download_limit'),
      download_expiry: value('download_expiry'),
      external_url: value('external_url'),
      button_text: value('button_text'),
      tax_status: value('tax_status'),
      tax_class: value('tax_class'),
      tax_applicable: tax.applicable,
      tax_rate: tax.rate,
      tax_amount: tax.amount,
      price_including_tax: tax.priceIncludingTax,
      tax_class_details: tax.taxClass,
      tax_calculation: taxConfiguration?.taxCalculation ?? null,
      currency: taxConfiguration?.currency ?? null,
      manage_stock: value('manage_stock'),
      stock_quantity: value('stock_quantity'),
      backorders: value('backorders'),
      backorders_allowed: value('backorders_allowed'),
      backordered: value('backordered'),
      low_stock_amount: value('low_stock_amount'),
      sold_individually: value('sold_individually'),
      weight: value('weight'),
      dimensions: dimensions
        ? {
            length: dimensions.length ?? null,
            width: dimensions.width ?? null,
            height: dimensions.height ?? null,
          }
        : null,
      shipping_required: value('shipping_required'),
      shipping_taxable: value('shipping_taxable'),
      shipping_class: value('shipping_class'),
      shipping_class_id: value('shipping_class_id'),
      reviews_allowed: value('reviews_allowed'),
      average_rating: value('average_rating'),
      rating_count: value('rating_count'),
      upsell_ids: value('upsell_ids'),
      cross_sell_ids: value('cross_sell_ids'),
      parent_id: value('parent_id'),
      purchase_note: value('purchase_note'),
      categories: this.productCategories(product, category),
      brands: value('brands'),
      tags: value('tags'),
      images: this.productImages(product),
      attributes: value('attributes'),
      default_attributes: value('default_attributes'),
      variations: value('variations'),
      grouped_products: value('grouped_products'),
      menu_order: value('menu_order'),
      price_html: value('price_html'),
      related_ids: value('related_ids'),
      meta_data: value('meta_data'),
      stock_status: value('stock_status'),
      has_options: value('has_options'),
      post_password: value('post_password'),
      global_unique_id: value('global_unique_id'),
      _links: value('_links'),
    };
  }

  private async getStoreProductTaxConfiguration(
    storeId: string,
  ): Promise<StoreProductTaxConfiguration | null> {
    const settings = await this.dataSource.getRepository(PosCurrencyTaxEntity).findOne({ where: { storeId } });
    if (settings) {
      const classes = await this.dataSource.getRepository(PosTaxClassEntity).find({
        where: { currencyTaxId: settings.id },
        order: { sortOrder: 'ASC' },
      });
      return {
        currency: settings.currency,
        decimalPlaces: Number(settings.decimalPlaces),
        taxEnabled: settings.taxEnabled,
        defaultTaxRate: settings.defaultTaxRate === null ? null : Number(settings.defaultTaxRate),
        taxCalculation: settings.taxCalculation,
        taxClasses: classes.map((taxClass) => ({ name: taxClass.name, rate: Number(taxClass.rate) })),
      };
    }

    const legacy = await this.dataSource.getRepository(StorePosConfigurationEntity).findOne({
      where: { storeId, configurationName: 'currency_taxes' },
    });
    if (!legacy) return null;
    const value = legacy.configurationValue;
    const taxClasses = Array.isArray(value.taxClasses)
      ? value.taxClasses.flatMap((item) => {
          const taxClass = this.asRecord(item);
          const name = this.textOrNull(taxClass?.name);
          const rate = this.numberOrNull(taxClass?.rate);
          return name && rate !== null ? [{ name, rate }] : [];
        })
      : [];
    return {
      currency: this.textOrNull(value.currency) ?? 'USD',
      decimalPlaces: this.numberOrNull(value.decimalPlaces) ?? 2,
      taxEnabled: value.taxEnabled !== false,
      defaultTaxRate: this.numberOrNull(value.defaultTaxRate),
      taxCalculation: this.textOrNull(value.taxCalculation) ?? 'item-price',
      taxClasses,
    };
  }

  private productTax(
    product: Record<string, unknown>,
    category: Record<string, unknown> | null,
    configuration: StoreProductTaxConfiguration | null,
  ): {
    applicable: boolean;
    rate: number;
    amount: string | null;
    priceIncludingTax: string | null;
    taxClass: { name: string; rate: number } | null;
  } {
    const price = this.numberOrNull(product.price);
    if (!configuration || !configuration.taxEnabled) {
      return {
        applicable: false,
        rate: 0,
        amount: price === null ? null : this.formatMoney(0, configuration?.decimalPlaces),
        priceIncludingTax: price === null ? null : this.formatMoney(price, configuration?.decimalPlaces),
        taxClass: null,
      };
    }
    const productClass = this.taxClassKey(product.tax_class ?? category?.pos_tax_class ?? category?.posTaxClass);
    const configuredClass = configuration.taxClasses.find(
      (taxClass) => this.taxClassKey(taxClass.name) === productClass,
    );
    const categoryRate = this.numberOrNull(category?.pos_tax_percent ?? category?.posTaxPercent);
    const rate = configuredClass?.rate ?? categoryRate ?? configuration.defaultTaxRate ?? 0;
    const taxClass = {
      name: configuredClass?.name ?? (productClass === 'standard' ? 'Standard' : productClass),
      rate,
    };
    const amount = price === null ? null : price * rate / 100;
    return {
      applicable: true,
      rate,
      amount: amount === null ? null : this.formatMoney(amount, configuration.decimalPlaces),
      priceIncludingTax: price === null || amount === null
        ? null
        : this.formatMoney(price + amount, configuration.decimalPlaces),
      taxClass,
    };
  }

  private taxClassKey(value: unknown): string {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || normalized === 'standard-rate') return 'standard';
    return normalized.replace(/[_\s]+/g, '-').replace(/-rated?$/, '');
  }

  private formatMoney(value: number, decimalPlaces = 2): string {
    const places = Number.isInteger(decimalPlaces) ? Math.min(6, Math.max(0, decimalPlaces)) : 2;
    const factor = 10 ** places;
    return (Math.round((value + Number.EPSILON) * factor) / factor).toFixed(places);
  }

  private productImages(product: Record<string, unknown>): unknown {
    if (Array.isArray(product.images)) return product.images;
    const src = this.textOrNull(product.image);
    if (!src) return null;
    return [{
      id: null,
      date_created: null,
      date_created_gmt: null,
      date_modified: null,
      date_modified_gmt: null,
      src,
      name: null,
      alt: null,
      srcset: null,
      sizes: null,
      thumbnail: null,
    }];
  }

  private productCategories(
    product: Record<string, unknown>,
    category: Record<string, unknown> | null,
  ): Array<Record<string, unknown>> | null {
    if (Array.isArray(product.categories) && product.categories.length > 0) {
      const categories = product.categories
        .map((item) => this.asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((item) => ({
          name: this.textOrNull(item.name),
          slug: this.textOrNull(item.slug),
          id: this.numberOrNull(item.id),
        }));
      return categories.length > 0 ? categories : null;
    }
    const id = this.numberOrNull(category?.id ?? product.categoryId);
    const name = this.textOrNull(category?.name ?? product.categoryName);
    const slug = this.textOrNull(category?.slug);
    if (id === null && name === null && slug === null) return null;
    return [{ name, slug, id }];
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private textOrNull(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text ? text : null;
  }

  private numberOrNull(value: unknown): number | null {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : null;
  }

  private storeProductPayload(
    category: WordPressCategoryNode,
    product: WordPressProductNode,
  ): Record<string, unknown> {
    const record = product as Record<string, unknown>;
    return {
      id: Number(product.id),
      sku: record.sku ?? null,
      name: product.name ?? null,
      tags: Array.isArray(product.tags) ? product.tags : [],
      type: record.type ?? null,
      image: product.image ?? null,
      price: product.price ?? null,
      regular_price: record.regular_price ?? null,
      sale_price: record.sale_price ?? null,
      tax_status: record.tax_status ?? null,
      tax_class: record.tax_class ?? null,
      categoryId: Number(category.id),
      categoryName: category.name ?? null,
      stock_status: record.stock_status ?? null,
      stock_quantity: record.stock_quantity ?? null,
    };
  }

  private async saveStoreCategoriesProducts(
    storeId: string,
    payload: Array<Record<string, unknown>>,
    response: unknown,
  ): Promise<void> {
    await this.ensureStoreProductsStoreIdUniqueIndex();
    await this.dataSource.query(
      `INSERT INTO public.store_products (store_id, payload, store_categories_products, updated_at)
       VALUES ($1::uuid, $2::jsonb, $3::jsonb, now())
       ON CONFLICT (store_id)
       DO UPDATE SET
         payload = EXCLUDED.payload,
         store_categories_products = EXCLUDED.store_categories_products,
         updated_at = now()`,
      [storeId, JSON.stringify(payload), JSON.stringify(response)],
    );
  }

  private async ensureStoreProductsStoreIdUniqueIndex(): Promise<void> {
    await this.dataSource.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS store_products_store_id_uidx
      ON public.store_products (store_id)
    `);
  }

  private async ensureStoreCategoriesProductsColumn(): Promise<void> {
    const db = this.dataSource;
    await db.query(
      `ALTER TABLE public.store_products ADD COLUMN IF NOT EXISTS store_categories_products jsonb`,
    );
    const legacy = await db.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'store_products'
         AND column_name = 'wordpress_response'`,
    );
    if (legacy.length) {
      await db.query(
        `UPDATE public.store_products
         SET store_categories_products = COALESCE(store_categories_products, wordpress_response)`,
      );
      await db.query(
        `ALTER TABLE public.store_products DROP COLUMN wordpress_response`,
      );
    }
    await db.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(724621, 61)');
      const columns = await manager.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'store_products'
         ORDER BY ordinal_position`,
      );
      const names = columns.map(
        (row: { column_name: string }) => row.column_name,
      );
      const payloadIndex = names.indexOf('payload');
      if (
        payloadIndex >= 0 &&
        names[payloadIndex + 1] === 'store_categories_products'
      ) {
        return;
      }
      await manager.query(`
        CREATE TABLE public.store_products__ordered (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          store_id uuid NOT NULL,
          payload jsonb NOT NULL DEFAULT '[]'::jsonb,
          store_categories_products jsonb,
          created_by uuid,
          updated_by uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          is_deleted boolean NOT NULL DEFAULT false
        )
      `);
      await manager.query(`
        INSERT INTO public.store_products__ordered (
          id, store_id, payload, store_categories_products,
          created_by, updated_by, created_at, updated_at, is_deleted
        )
        SELECT id, store_id, payload, store_categories_products,
               created_by, updated_by, created_at, updated_at, is_deleted
        FROM public.store_products
      `);
      await manager.query(`DROP TABLE public.store_products`);
      await manager.query(
        `ALTER TABLE public.store_products__ordered RENAME TO store_products`,
      );
      await manager.query(
        `ALTER TABLE public.store_products RENAME CONSTRAINT store_products__ordered_pkey TO store_products_pkey`,
      );
      await manager.query(`
        ALTER TABLE public.store_products
        ADD CONSTRAINT store_products_store_id_fkey
        FOREIGN KEY (store_id) REFERENCES public.stores (id)
      `);
      await manager.query(`
        CREATE UNIQUE INDEX store_products_store_id_uidx
        ON public.store_products (store_id)
      `);
    });
  }

  async getStoreCatalog(
    storeId: string,
  ): Promise<{ categories: CategoryEntity[]; products: unknown[] }> {
    const categories = await this.categoryRepo.find({
      where: { storeId },
      order: { name: 'ASC' },
    });
    let catalogRows: Array<{ payload?: unknown }> = [];
    try {
      catalogRows = await this.dataSource.query(
        `SELECT payload
         FROM public.store_products
         WHERE store_id = $1::uuid
           AND COALESCE(is_deleted, false) = false
         LIMIT 1`,
        [storeId],
      );
    } catch (error) {
      const postgresCode =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code ?? '')
          : '';
      if (postgresCode !== '42P01') throw error;
    }
    const savedProducts = catalogRows[0]?.payload;
    if (Array.isArray(savedProducts) && savedProducts.length > 0) {
      return {
        categories,
        products: savedProducts.map((value) => {
          const product = this.presentWooProduct(this.asRecord(value) ?? {}, null);
          const productCategories = Array.isArray(product.categories)
            ? product.categories
            : [];
          const firstCategory = this.asRecord(productCategories[0]);
          const images = Array.isArray(product.images) ? product.images : [];
          const firstImage = this.asRecord(images[0]);
          return {
            ...product,
            categoryId: firstCategory?.id ?? '',
            category: firstCategory?.name ?? '',
            image: firstImage?.src ?? null,
          };
        }),
      };
    }

    const products = await this.productRepo.find({
      where: { storeId },
      order: { name: 'ASC' },
    });
    return { categories, products };
  }

  private async fetchWordPressCategoryCatalog(
    wordpressUrl: string,
    wordpressJwt: string,
  ): Promise<{ categories: WordPressCategoryNode[]; response: unknown }> {
    const baseUrl = wordpressUrl.replace(/\/+$/, '');
    const response = await fetch(
      `${baseUrl}/wp-json/wc/v3/products?per_page=20000`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${wordpressJwt}`,
        },
      },
    );
    if (!response.ok) {
      throw new BadRequestException(
        `WordPress catalog API returned HTTP ${response.status}. Check the site URL and JWT token.`,
      );
    }
    const body = (await response.json()) as {
      status?: string;
      category?: WordPressCategoryNode[];
    };
    const roots = Array.isArray(body.category) ? body.category : [];
    if (!roots.length) {
      throw new BadRequestException(
        'WordPress catalog API returned no categories',
      );
    }
    return {
      categories: this.flattenWordPressCategories(roots),
      response: body,
    };
  }

  private flattenWordPressCategories(
    nodes: WordPressCategoryNode[],
  ): WordPressCategoryNode[] {
    const flattened: WordPressCategoryNode[] = [];
    const walk = (items: WordPressCategoryNode[]) => {
      for (const item of items) {
        flattened.push(item);
        if (Array.isArray(item.children) && item.children.length)
          walk(item.children);
      }
    };
    walk(nodes);
    return flattened;
  }

  private async upsertStoreCategory(
    merchantId: string,
    storeId: string,
    node: WordPressCategoryNode,
  ): Promise<CategoryEntity> {
    const wordpressId = Number(node.id);
    const categoryJson = { ...node };
    delete categoryJson.products;
    delete categoryJson.children;
    const fields = {
      merchantId,
      storeId,
      wordpressId,
      parentWordpressId: Number(node.parent || 0),
      name: String(node.name || '').trim() || `Category ${wordpressId}`,
      slug: String(node.slug || ''),
      description: String(node.description || ''),
      productCount: Number(node.count || 0),
      image: node.image ? String(node.image) : null,
      posTaxClass: String(node.pos_tax_class || ''),
      posTaxPercent: String(node.pos_tax_percent || ''),
      payload: categoryJson as Record<string, unknown>,
      updatedAt: new Date(),
    };
    const existing = await this.categoryRepo.findOneBy({
      storeId,
      wordpressId,
    });
    return this.categoryRepo.save(
      existing
        ? Object.assign(existing, fields)
        : this.categoryRepo.create(fields),
    );
  }

  private async upsertStoreProduct(
    merchantId: string,
    storeId: string,
    category: CategoryEntity,
    product: WordPressProductNode,
  ): Promise<ProductEntity> {
    const wordpressId = Number(product.id);
    const priceRaw =
      product.price === undefined ||
      product.price === null ||
      String(product.price).trim() === ''
        ? null
        : String(Number.parseFloat(String(product.price)));
    const fields = {
      merchantId,
      storeId,
      categoryId: category.id,
      wordpressId,
      wordpressCategoryId: category.wordpressId,
      name: String(product.name || '').trim() || `Product ${wordpressId}`,
      price: Number.isFinite(Number(priceRaw)) ? priceRaw : null,
      image: product.image ? String(product.image) : null,
      tags: Array.isArray(product.tags) ? product.tags : [],
      payload: product as Record<string, unknown>,
      updatedAt: new Date(),
    };
    const existing = await this.productRepo.findOneBy({
      storeId,
      wordpressId,
      wordpressCategoryId: category.wordpressId,
    });
    return this.productRepo.save(
      existing
        ? Object.assign(existing, fields)
        : this.productRepo.create(fields),
    );
  }

  // --- Master Reference Data: store_types CRUD Methods ---

  async listStoreTypes(status?: string): Promise<any[]> {
    if (this.dataSource?.isInitialized) {
      const where = status
        ? `WHERE lower(COALESCE(s.status::text, '')) = lower($1)`
        : '';
      const params = status ? [status] : [];
      return await this.dataSource.query(
        `
        SELECT 
          s.id,
          s.name,
          s.description,
          s.status,
          COALESCE(to_jsonb(s)->>'storeTypeCode', to_jsonb(s)->>'store_type_code', to_jsonb(s)->>'code', '') AS "storeTypeCode",
          COALESCE(to_jsonb(s)->>'createdAt', to_jsonb(s)->>'created_at', now()::text) AS "createdAt",
          COALESCE(to_jsonb(s)->>'updatedAt', to_jsonb(s)->>'updated_at', now()::text) AS "updatedAt"
        FROM public.store_types s
        ${where}
        ORDER BY s.name ASC, s.id ASC
      `,
        params,
      );
    }
    if (!this.storeTypeRepo) return [];
    if (status) {
      return this.storeTypeRepo.find({
        where: { status: status.toUpperCase() as StoreTypeStatus },
        order: { name: 'ASC' },
      });
    }
    return this.storeTypeRepo.find({ order: { name: 'ASC' } });
  }

  async getStoreTypeByIdOrCode(idOrCode: string): Promise<any | null> {
    if (this.dataSource?.isInitialized && idOrCode) {
      const trimmed = idOrCode.trim();
      const rows = await this.dataSource.query(
        `
        SELECT 
          s.id,
          s.name,
          s.description,
          s.status,
          COALESCE(to_jsonb(s)->>'storeTypeCode', to_jsonb(s)->>'store_type_code', to_jsonb(s)->>'code', '') AS "storeTypeCode",
          COALESCE(to_jsonb(s)->>'createdAt', to_jsonb(s)->>'created_at', now()::text) AS "createdAt",
          COALESCE(to_jsonb(s)->>'updatedAt', to_jsonb(s)->>'updated_at', now()::text) AS "updatedAt"
        FROM public.store_types s
        WHERE s.id::text = $1
           OR lower(COALESCE(to_jsonb(s)->>'storeTypeCode', to_jsonb(s)->>'store_type_code', to_jsonb(s)->>'code', '')) = lower($1)
           OR lower(s.name) = lower($1)
        LIMIT 1
      `,
        [trimmed],
      );
      if (rows.length) return rows[0];
    }
    if (!this.storeTypeRepo || !idOrCode) return null;
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrCode.trim(),
      );
    if (isUuid) {
      const byId = await this.storeTypeRepo.findOneBy({ id: idOrCode.trim() });
      if (byId) return byId;
    }
    return this.storeTypeRepo.findOneBy({
      storeTypeCode: idOrCode.trim().toUpperCase(),
    });
  }

  async createStoreType(dto: CreateStoreTypeDto): Promise<StoreTypeEntity> {
    if (!this.storeTypeRepo) {
      throw new ServiceUnavailableException('Store types require PostgreSQL');
    }
    const entity = this.storeTypeRepo.create({
      storeTypeCode: dto.storeTypeCode.trim().toUpperCase(),
      name: dto.name.trim(),
      description: dto.description?.trim() || '',
      status: dto.status || StoreTypeStatus.ACTIVE,
    });
    return this.storeTypeRepo.save(entity);
  }

  async updateStoreType(
    idOrCode: string,
    dto: UpdateStoreTypeDto,
  ): Promise<StoreTypeEntity | null> {
    const existing = await this.getStoreTypeByIdOrCode(idOrCode);
    if (!existing) return null;
    if (dto.storeTypeCode !== undefined) {
      const code = dto.storeTypeCode.trim().toUpperCase();
      const duplicate = await this.getStoreTypeByIdOrCode(code);
      if (duplicate && duplicate.id !== existing.id)
        throw new ConflictException(`Store type code '${code}' already exists`);
      existing.storeTypeCode = code;
    }
    if (dto.name !== undefined) existing.name = dto.name.trim();
    if (dto.description !== undefined)
      existing.description = dto.description.trim();
    if (dto.status !== undefined) existing.status = dto.status;
    existing.updatedAt = new Date();
    return this.storeTypeRepo.save(existing);
  }

  async deleteStoreType(idOrCode: string): Promise<boolean> {
    const existing = await this.getStoreTypeByIdOrCode(idOrCode);
    if (!existing) return false;
    existing.status = StoreTypeStatus.INACTIVE;
    existing.updatedAt = new Date();
    await this.storeTypeRepo.save(existing);
    return true;
  }

  // --- Master & Tenant Tables Methods ---

  private async seedAllMasterData(): Promise<void> {
    await this.seedDefaultFeatures();
    await this.seedDefaultRoleTemplates();
    await this.seedDefaultCommercialPlans();
  }

  private async seedDefaultFeatures(): Promise<void> {
    if (!this.featureRepo || !this.permissionRepo) return;
    try {
      if ((await this.featureRepo.count()) === 0) {
        const defaults = [
          {
            id: 'f1111111-0000-0000-0000-000000000001',
            featureCode: 'ORDER_MANAGEMENT',
            name: 'Order Management',
            description: 'Manage in-store POS and online delivery orders',
            featureType: 'BOOLEAN',
            status: FeatureStatus.ACTIVE,
          },
          {
            id: 'f1111111-0000-0000-0000-000000000002',
            featureCode: 'REFUNDS',
            name: 'Refunds & Returns',
            description: 'Process full and partial order refunds',
            featureType: 'BOOLEAN',
            status: FeatureStatus.ACTIVE,
          },
          {
            id: 'f1111111-0000-0000-0000-000000000003',
            featureCode: 'KDS',
            name: 'Kitchen Display System',
            description: 'Live kitchen prep tickets and bump bar tracking',
            featureType: 'BOOLEAN',
            status: FeatureStatus.ACTIVE,
          },
          {
            id: 'f1111111-0000-0000-0000-000000000004',
            featureCode: 'LOYALTY',
            name: 'Loyalty & Rewards',
            description: 'Earn and redeem loyalty points at checkout',
            featureType: 'BOOLEAN',
            status: FeatureStatus.ACTIVE,
          },
          {
            id: 'f1111111-0000-0000-0000-000000000005',
            featureCode: 'SAFE_DROP',
            name: 'Safe Drop & Cash Management',
            description: 'Mid-shift safe drops and drawer reconciliations',
            featureType: 'BOOLEAN',
            status: FeatureStatus.ACTIVE,
          },
          {
            id: 'f1111111-0000-0000-0000-000000000006',
            featureCode: 'INVENTORY',
            name: 'Live Stock Tracking',
            description: 'Real-time multi-location inventory deduction',
            featureType: 'BOOLEAN',
            status: FeatureStatus.ACTIVE,
          },
        ];
        for (const item of defaults) {
          await this.featureRepo.save(this.featureRepo.create(item));
        }

        const permDefaults = [
          {
            id: 'p1111111-0000-0000-0000-000000000001',
            featureId: 'f1111111-0000-0000-0000-000000000001',
            permissionKey: 'ORDERS_CREATE',
            name: 'Create Orders',
            description: 'Create new POS cart and ring items',
            status: PermissionStatus.ACTIVE,
          },
          {
            id: 'p1111111-0000-0000-0000-000000000002',
            featureId: 'f1111111-0000-0000-0000-000000000002',
            permissionKey: 'REFUNDS_PROCESS',
            name: 'Process Refunds',
            description: 'Issue cash or card refunds',
            status: PermissionStatus.ACTIVE,
          },
          {
            id: 'p1111111-0000-0000-0000-000000000003',
            featureId: 'f1111111-0000-0000-0000-000000000003',
            permissionKey: 'KDS_VIEW',
            name: 'View KDS',
            description: 'View kitchen queue and bump tickets',
            status: PermissionStatus.ACTIVE,
          },
          {
            id: 'p1111111-0000-0000-0000-000000000004',
            featureId: 'f1111111-0000-0000-0000-000000000004',
            permissionKey: 'LOYALTY_APPLY',
            name: 'Apply Loyalty Points',
            description: 'Look up customers and apply points',
            status: PermissionStatus.ACTIVE,
          },
          {
            id: 'p1111111-0000-0000-0000-000000000005',
            featureId: 'f1111111-0000-0000-0000-000000000005',
            permissionKey: 'CASH_SAFE_DROP',
            name: 'Perform Safe Drop',
            description: 'Transfer cash from drawer to safe',
            status: PermissionStatus.ACTIVE,
          },
        ];
        for (const perm of permDefaults) {
          await this.permissionRepo.save(this.permissionRepo.create(perm));
        }
      }
    } catch {}
  }

  private async seedDefaultRoleTemplates(): Promise<void> {
    if (!this.roleTemplateRepo) return;
    try {
      if ((await this.roleTemplateRepo.count()) === 0) {
        const defaults = [
          {
            id: 'r1111111-0000-0000-0000-000000000001',
            roleCode: 'CASHIER',
            name: 'POS Cashier',
            description:
              'Point of sale order ringing, payments, and receipt printing',
            scopeType: RoleScopeType.STORE,
            status: RoleTemplateStatus.ACTIVE,
          },
          {
            id: 'r1111111-0000-0000-0000-000000000002',
            roleCode: 'STORE_MANAGER',
            name: 'Store Manager',
            description:
              'Full store operational control, shift closing, safe drops, and refunds',
            scopeType: RoleScopeType.STORE,
            status: RoleTemplateStatus.ACTIVE,
          },
          {
            id: 'r1111111-0000-0000-0000-000000000003',
            roleCode: 'KITCHEN_STAFF',
            name: 'Kitchen Staff',
            description:
              'Kitchen display system viewer and ticket status manager',
            scopeType: RoleScopeType.STORE,
            status: RoleTemplateStatus.ACTIVE,
          },
          {
            id: 'r1111111-0000-0000-0000-000000000004',
            roleCode: 'MERCHANT_ADMIN',
            name: 'Merchant Administrator',
            description:
              'Enterprise tenant owner with full access across all merchant stores',
            scopeType: RoleScopeType.MERCHANT,
            status: RoleTemplateStatus.ACTIVE,
          },
        ];
        for (const item of defaults) {
          await this.roleTemplateRepo.save(this.roleTemplateRepo.create(item));
        }
      }
    } catch {}
  }

  private async seedDefaultCommercialPlans(): Promise<void> {
    if (!this.planMasterRepo) return;
    if (!this.planMasterRepo) return;
    try {
      if ((await this.planMasterRepo.count()) === 0) {
        const defaults = [
          {
            id: 'b1111111-0000-0000-0000-000000000001',
            planCode: 'STARTER',
            name: 'Starter Plan',
            description:
              'Essential cloud POS for single-location small retailers',
            billingModel: PlanBillingModel.FLAT,
            basePrice: 29.0,
            currency: 'USD',
            billingCycle: PlanBillingCycle.MONTHLY,
            status: PlanStatus.ACTIVE,
          },
          {
            id: 'b1111111-0000-0000-0000-000000000002',
            planCode: 'PRO',
            name: 'Professional Plan',
            description:
              'Advanced multi-terminal POS with KDS and delivery aggregator sync',
            billingModel: PlanBillingModel.PER_STORE,
            basePrice: 79.0,
            currency: 'USD',
            billingCycle: PlanBillingCycle.MONTHLY,
            status: PlanStatus.ACTIVE,
          },
          {
            id: 'b1111111-0000-0000-0000-000000000003',
            planCode: 'ENTERPRISE',
            name: 'Enterprise Suite',
            description:
              'Unlimited stores, custom roles, API integrations, and 24/7 SLA',
            billingModel: PlanBillingModel.CUSTOM,
            basePrice: 199.0,
            currency: 'USD',
            billingCycle: PlanBillingCycle.MONTHLY,
            status: PlanStatus.ACTIVE,
          },
        ];
        for (const item of defaults) {
          await this.planMasterRepo.save(this.planMasterRepo.create(item));
        }
      }
    } catch {}
  }

  // --- Features CRUD ---
  async listFeatures(
    status?: string,
    category?: string,
  ): Promise<FeatureEntity[]> {
    if (!this.featureRepo) return [];
    const where: any = {};
    if (status) where.status = status.toUpperCase();
    return this.featureRepo.find({ where, order: { name: 'ASC' } });
  }

  async getFeatureByIdOrKey(idOrKey: string): Promise<FeatureEntity | null> {
    if (!this.featureRepo || !idOrKey) return null;
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrKey.trim(),
      );
    if (isUuid) {
      const byId = await this.featureRepo.findOneBy({ id: idOrKey.trim() });
      if (byId) return byId;
    }
    return this.featureRepo.findOneBy({
      featureCode: idOrKey.trim().toUpperCase(),
    });
  }

  async createFeature(dto: CreateFeatureDto): Promise<FeatureEntity> {
    const entity = this.featureRepo.create({
      featureCode: dto.feature_code.trim().toUpperCase(),
      name: dto.name.trim(),
      description: dto.description?.trim() || '',
      featureType: dto.feature_type,
      status: dto.status || FeatureStatus.ACTIVE,
      updatedBy: null,
      updatedAt: null as unknown as Date,
    });
    await this.featureRepo.insert(entity);
    return this.featureRepo.findOneByOrFail({ id: entity.id });
  }

  async updateFeature(
    idOrKey: string,
    dto: UpdateFeatureDto,
  ): Promise<FeatureEntity | null> {
    const existing = await this.getFeatureByIdOrKey(idOrKey);
    if (!existing) return null;
    if (dto.feature_code !== undefined)
      existing.featureCode = dto.feature_code.trim().toUpperCase();
    if (dto.name !== undefined) existing.name = dto.name.trim();
    if (dto.description !== undefined)
      existing.description = dto.description.trim();
    if (dto.feature_type !== undefined) existing.featureType = dto.feature_type;
    if (dto.status !== undefined) existing.status = dto.status;
    existing.updatedAt = new Date();
    return this.featureRepo.save(existing);
  }

  async deleteFeature(idOrKey: string): Promise<boolean> {
    const existing = await this.getFeatureByIdOrKey(idOrKey);
    if (!existing) return false;
    existing.status = FeatureStatus.INACTIVE;
    existing.updatedAt = new Date();
    await this.featureRepo.save(existing);
    return true;
  }

  // --- Permissions CRUD ---
  async listPermissions(
    featureId?: string,
    status?: string,
  ): Promise<PermissionEntity[]> {
    if (!this.permissionRepo) return [];
    const where: any = {};
    if (featureId) where.featureId = featureId;
    if (status) where.status = status.toUpperCase();
    return this.permissionRepo.find({ where, order: { name: 'ASC' } });
  }

  async getPermissionByIdOrKey(
    idOrKey: string,
    featureId?: string,
  ): Promise<PermissionEntity | null> {
    if (!this.permissionRepo || !idOrKey) return null;
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrKey.trim(),
      );
    if (isUuid) {
      const byId = await this.permissionRepo.findOneBy({ id: idOrKey.trim() });
      if (
        byId &&
        featureId &&
        byId.featureId.toLowerCase() !== featureId.toLowerCase()
      )
        return null;
      if (byId) return byId;
    }
    const key = idOrKey.trim().toUpperCase();
    if (featureId) {
      return this.permissionRepo.findOneBy({ permissionKey: key, featureId });
    }
    const matches = await this.permissionRepo.find({
      where: { permissionKey: key },
      take: 2,
    });
    if (matches.length > 1)
      throw new ConflictException(
        `Permission key '${key}' exists on more than one feature; use the permission UUID`,
      );
    return matches[0] || null;
  }

  private async assertUniquePermissionInFeature(
    featureId: string,
    permissionKey: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const keyRows = await this.dataSource.query(
      `SELECT id FROM public.permissions
       WHERE feature_id = $1 AND permission_key = $2 AND ($3::uuid IS NULL OR id <> $3)
       LIMIT 1`,
      [featureId, permissionKey, excludeId || null],
    );
    if (keyRows.length)
      throw new ConflictException(
        `Permission key '${permissionKey}' already exists for this feature`,
      );
    const nameRows = await this.dataSource.query(
      `SELECT id FROM public.permissions
       WHERE feature_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND ($3::uuid IS NULL OR id <> $3)
       LIMIT 1`,
      [featureId, name, excludeId || null],
    );
    if (nameRows.length)
      throw new ConflictException(
        `Permission name '${name}' already exists for this feature`,
      );
  }

  async createPermission(dto: CreatePermissionDto): Promise<PermissionEntity> {
    let targetFeatureId = dto.featureId;
    const feat = await this.getFeatureByIdOrKey(dto.featureId);
    if (feat) {
      targetFeatureId = feat.id;
    }
    const permissionKey = (dto.permissionKey || dto.key || '')
      .trim()
      .toUpperCase();
    const name = dto.name.trim();
    await this.assertUniquePermissionInFeature(
      targetFeatureId,
      permissionKey,
      name,
    );
    const entity = this.permissionRepo.create({
      featureId: targetFeatureId,
      permissionKey,
      name,
      description: dto.description?.trim() || '',
      status: dto.status || PermissionStatus.ACTIVE,
    });
    return this.savePermission(entity);
  }

  private async savePermission(
    entity: PermissionEntity,
  ): Promise<PermissionEntity> {
    try {
      return await this.permissionRepo.save(entity);
    } catch (error) {
      const databaseError = (
        error as { driverError?: { code?: string; constraint?: string } }
      ).driverError;
      if (
        databaseError?.code === '23503' &&
        databaseError.constraint === 'permissions_feature_fk'
      ) {
        throw new BadRequestException(
          `Feature '${entity.featureId}' does not exist. Use an existing featureId.`,
        );
      }
      if (databaseError?.code === '23505') {
        const constraint = String(databaseError.constraint || '');
        if (constraint.includes('feature_name')) {
          throw new ConflictException(
            `Permission name '${entity.name}' already exists for this feature`,
          );
        }
        throw new ConflictException(
          `Permission key '${entity.permissionKey}' already exists for this feature`,
        );
      }
      throw error;
    }
  }

  async updatePermission(
    idOrKey: string,
    dto: UpdatePermissionDto,
  ): Promise<PermissionEntity | null> {
    const existing = await this.getPermissionByIdOrKey(idOrKey);
    if (!existing) return null;
    const newKey = (dto.permissionKey || dto.key)?.trim();
    if (
      newKey &&
      newKey.toUpperCase() !== existing.permissionKey.toUpperCase()
    ) {
      existing.permissionKey = newKey.toUpperCase();
    }
    if (dto.featureId !== undefined && String(dto.featureId).trim()) {
      const feat = await this.getFeatureByIdOrKey(String(dto.featureId).trim());
      if (feat) {
        existing.featureId = feat.id;
      } else {
        existing.featureId = String(dto.featureId).trim();
      }
    }
    if (dto.name !== undefined) existing.name = dto.name.trim();
    if (dto.description !== undefined)
      existing.description = dto.description.trim();
    if (dto.status !== undefined) existing.status = dto.status;
    existing.updatedAt = new Date();
    await this.assertUniquePermissionInFeature(
      existing.featureId,
      existing.permissionKey,
      existing.name,
      existing.id,
    );
    return this.savePermission(existing);
  }

  async deletePermission(idOrKey: string): Promise<boolean> {
    const existing = await this.getPermissionByIdOrKey(idOrKey);
    if (!existing) return false;
    existing.status = PermissionStatus.INACTIVE;
    existing.updatedAt = new Date();
    await this.permissionRepo.save(existing);
    return true;
  }

  private permissionBulkItems(
    body: unknown,
    extraKeys: string[] = [],
  ): Record<string, unknown>[] {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Provide { items: [...] }');
    const payload = body as Record<string, unknown>;
    if (
      Object.keys(payload).some(
        (key) => key !== 'items' && !extraKeys.includes(key),
      )
    ) {
      throw new BadRequestException('Provide { items: [...] }');
    }
    if (
      !Array.isArray(payload.items) ||
      payload.items.length < 1 ||
      payload.items.length > 100
    ) {
      throw new BadRequestException(
        'items must contain between 1 and 100 permissions',
      );
    }
    if (
      payload.items.some(
        (item) => !item || typeof item !== 'object' || Array.isArray(item),
      )
    ) {
      throw new BadRequestException('Each item must be a JSON object');
    }
    return payload.items as Record<string, unknown>[];
  }

  private permissionText(
    value: unknown,
    field: string,
    max: number,
    required = false,
  ): string | undefined {
    if (value === undefined || value === null) {
      if (required) throw new BadRequestException(`${field} is required`);
      return undefined;
    }
    if (typeof value !== 'string')
      throw new BadRequestException(`Invalid ${field}`);
    const text = value.trim();
    if (!text) {
      if (required) throw new BadRequestException(`${field} is required`);
      return '';
    }
    if (text.length > max) throw new BadRequestException(`Invalid ${field}`);
    return field === 'permissionKey' ? text.toUpperCase() : text;
  }

  private permissionStatusValue(
    value: unknown,
    required = false,
  ): PermissionStatus | undefined {
    if (value === undefined || value === null) {
      if (required) throw new BadRequestException('status is required');
      return undefined;
    }
    if (typeof value !== 'string')
      throw new BadRequestException('Invalid status');
    const status = value.trim().toUpperCase().replace(/\s+/g, '_');
    if (!['ACTIVE', 'INACTIVE'].includes(status))
      throw new BadRequestException('Invalid status');
    return status as PermissionStatus;
  }

  async createFeaturePermissions(
    featureId: string,
    body: unknown,
  ): Promise<{
    success: true;
    count: number;
    permissions: PermissionEntity[];
  }> {
    if (!this.permissionRepo || !this.dataSource?.isInitialized)
      throw new ServiceUnavailableException('Master data requires PostgreSQL');
    await this.masterData('features', 'get', featureId);
    const skipExisting =
      (body as { skipExisting?: unknown })?.skipExisting === true;
    const prepared = this.permissionBulkItems(body, ['skipExisting']).map(
      (item) => {
        const allowed = [
          'permissionKey',
          'name',
          'description',
          'status',
          'featureId',
        ];
        if (Object.keys(item).some((key) => !allowed.includes(key)))
          throw new BadRequestException('Unknown or immutable field');
        if (
          typeof item.featureId === 'string' &&
          item.featureId.toLowerCase() !== featureId.toLowerCase()
        ) {
          throw new BadRequestException(
            'featureId must match the feature in the URL',
          );
        }
        return {
          permissionKey: this.permissionText(
            item.permissionKey,
            'permissionKey',
            100,
            true,
          )!,
          name: this.permissionText(item.name, 'name', 150, true)!,
          description:
            this.permissionText(item.description, 'description', 2000) ?? '',
          status:
            this.permissionStatusValue(item.status) || PermissionStatus.ACTIVE,
        };
      },
    );
    const seen = new Set<string>();
    for (const item of prepared) {
      if (seen.has(item.permissionKey))
        throw new BadRequestException('Duplicate permissionKey in items');
      seen.add(item.permissionKey);
    }
    try {
      return await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(PermissionEntity);
        const permissions: PermissionEntity[] = [];
        for (const item of prepared) {
          const existing = await repo.findOneBy({
            permissionKey: item.permissionKey,
            featureId,
          });
          if (existing) {
            if (skipExisting) continue;
            throw new ConflictException(
              `Permission key '${item.permissionKey}' already exists for this feature`,
            );
          }
          const nameClash = await repo
            .createQueryBuilder('permission')
            .where('permission.featureId = :featureId', { featureId })
            .andWhere('lower(btrim(permission.name)) = lower(btrim(:name))', {
              name: item.name,
            })
            .getOne();
          if (nameClash)
            throw new ConflictException(
              `Permission name '${item.name}' already exists for this feature`,
            );
          permissions.push(
            await repo.save(repo.create({ ...item, featureId })),
          );
        }
        return {
          success: true as const,
          count: permissions.length,
          permissions,
        };
      });
    } catch (error: any) {
      const code = error.driverError?.code || error.code;
      if (code === '23505')
        throw new ConflictException(
          'Permission key or name already exists for this feature',
        );
      if (code === '23503')
        throw new BadRequestException(
          `Feature '${featureId}' does not exist. Use an existing featureId.`,
        );
      throw error;
    }
  }

  async updateFeaturePermissions(
    featureId: string,
    body: unknown,
  ): Promise<{
    success: true;
    count: number;
    permissions: PermissionEntity[];
  }> {
    if (!this.permissionRepo || !this.dataSource?.isInitialized)
      throw new ServiceUnavailableException('Master data requires PostgreSQL');
    await this.masterData('features', 'get', featureId);
    const prepared = this.permissionBulkItems(body).map((item) => {
      const allowed = ['id', 'permissionKey', 'name', 'description', 'status'];
      if (Object.keys(item).some((key) => !allowed.includes(key)))
        throw new BadRequestException('Unknown or immutable field');
      const id = typeof item.id === 'string' ? item.id.trim() : undefined;
      const permissionKey = this.permissionText(
        item.permissionKey,
        'permissionKey',
        100,
      );
      if (!id && !permissionKey)
        throw new BadRequestException('Each item requires id or permissionKey');
      const name = this.permissionText(item.name, 'name', 150);
      const description = this.permissionText(
        item.description,
        'description',
        2000,
      );
      const status = this.permissionStatusValue(item.status);
      if (
        name === undefined &&
        description === undefined &&
        status === undefined
      ) {
        throw new BadRequestException('Provide at least one field to update');
      }
      return { id, permissionKey, name, description, status };
    });
    const seen = new Set<string>();
    for (const item of prepared) {
      const token = (item.id || item.permissionKey)!.toLowerCase();
      if (seen.has(token))
        throw new BadRequestException('Duplicate permission in items');
      seen.add(token);
    }
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(PermissionEntity);
      const permissions: PermissionEntity[] = [];
      for (const item of prepared) {
        const existing = item.id
          ? await repo.findOneBy({ id: item.id })
          : await repo.findOneBy({
              permissionKey: item.permissionKey,
              featureId,
            });
        if (
          !existing ||
          existing.featureId.toLowerCase() !== featureId.toLowerCase()
        ) {
          throw new NotFoundException(
            `Permission '${item.id || item.permissionKey}' not found`,
          );
        }
        if (item.name !== undefined) existing.name = item.name;
        if (item.description !== undefined)
          existing.description = item.description;
        if (item.status !== undefined) existing.status = item.status;
        existing.updatedAt = new Date();
        permissions.push(await repo.save(existing));
      }
      return { success: true as const, count: permissions.length, permissions };
    });
  }

  async listFeaturePermissions(
    featureId: string,
    filters: {
      status?: string;
      search?: string;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<{ permissions: FeaturePermissionEntity[]; total: number }> {
    const feature = await this.getFeatureByIdOrKey(featureId);
    if (!feature)
      throw new NotFoundException(`Feature '${featureId}' not found`);
    const query = this.dataSource
      .getRepository(FeaturePermissionEntity)
      .createQueryBuilder('permission')
      .where('permission.featureId = :featureId', { featureId: feature.id });
    if (filters.status)
      query.andWhere('permission.status = :status', {
        status: filters.status.toUpperCase(),
      });
    if (filters.search?.trim()) {
      query.andWhere(
        '(permission.permissionCode ILIKE :search OR permission.name ILIKE :search OR permission.description ILIKE :search)',
        { search: `%${filters.search.trim()}%` },
      );
    }
    query.orderBy('permission.name', 'ASC');
    if (filters.page !== undefined && filters.limit !== undefined) {
      query.skip((filters.page - 1) * filters.limit).take(filters.limit);
    }
    const [permissions, total] = await query.getManyAndCount();
    return { permissions, total };
  }

  async getFeaturePermissionByIdOrCode(
    idOrCode: string,
    featureId: string,
    includeDeleted = false,
  ): Promise<FeaturePermissionEntity | null> {
    const feature = await this.getFeatureByIdOrKey(featureId);
    if (!feature || !this.dataSource?.isInitialized) return null;
    const repo = this.dataSource.getRepository(FeaturePermissionEntity);
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrCode.trim(),
      );
    if (isUuid) {
      const byId = await repo.findOneBy(
        includeDeleted
          ? { id: idOrCode.trim(), featureId: feature.id }
          : { id: idOrCode.trim(), featureId: feature.id, isDeleted: false },
      );
      if (byId) return byId;
    }
    return repo.findOneBy(
      includeDeleted
        ? {
            permissionCode: idOrCode.trim().toUpperCase(),
            featureId: feature.id,
          }
        : {
            permissionCode: idOrCode.trim().toUpperCase(),
            featureId: feature.id,
            isDeleted: false,
          },
    );
  }

  async createFeaturePermission(input: {
    featureId: string;
    permissionCode?: string;
    permissionType: PermissionType;
    name: string;
    description?: string;
    status?: RecordStatus;
    createdBy?: string;
    updatedBy?: string;
  }): Promise<FeaturePermissionEntity> {
    const feature = await this.getFeatureByIdOrKey(input.featureId);
    if (!feature)
      throw new NotFoundException(`Feature '${input.featureId}' not found`);
    try {
      return await this.dataSource.transaction(async (manager) => {
        // Serialize key assignment so concurrent saves cannot receive the same sequence number.
        await manager.query('SELECT pg_advisory_xact_lock($1)', [741029184]);
        const rows: Array<{ next_number: string }> = await manager.query(
          `SELECT COALESCE(MAX(substring(permission_code FROM '^FPM_([0-9]+)$')::bigint), 0) + 1 AS next_number
           FROM public.feature_permissions
           WHERE permission_code ~ '^FPM_[0-9]+$'`,
        );
        const permissionCode = `FPM_${String(rows[0].next_number).padStart(5, '0')}`;
        const repo = manager.getRepository(FeaturePermissionEntity);
        const permission = repo.create({
          featureId: feature.id,
          permissionCode,
          permissionType: input.permissionType,
          name: input.name.trim(),
          description: input.description?.trim() || '',
          status: input.status || RecordStatus.ACTIVE,
          createdBy: input.createdBy,
          updatedBy: null,
          updatedAt: null as unknown as Date,
          isDeleted:
            (input.status || RecordStatus.ACTIVE) === RecordStatus.INACTIVE,
        });
        await repo.insert(permission);
        return repo.findOneByOrFail({ id: permission.id });
      });
    } catch (error: any) {
      if (error?.driverError?.code === '23505' || error?.code === '23505') {
        throw new ConflictException(
          'Generated permission code or name already exists',
        );
      }
      throw error;
    }
  }

  async updateFeaturePermission(
    idOrCode: string,
    featureId: string,
    fields: Partial<
      Pick<
        FeaturePermissionEntity,
        | 'featureId'
        | 'permissionCode'
        | 'permissionType'
        | 'name'
        | 'description'
        | 'status'
      >
    > & { updatedBy?: string },
    includeDeleted = false,
  ): Promise<FeaturePermissionEntity | null> {
    const existing = await this.getFeaturePermissionByIdOrCode(
      idOrCode,
      featureId,
      includeDeleted,
    );
    if (!existing) return null;
    if (fields.featureId !== undefined) {
      const feature = await this.getFeatureByIdOrKey(fields.featureId);
      if (!feature)
        throw new NotFoundException(`Feature '${fields.featureId}' not found`);
      existing.featureId = feature.id;
    }
    if (fields.permissionCode !== undefined)
      existing.permissionCode = fields.permissionCode.trim().toUpperCase();
    if (fields.permissionType !== undefined)
      existing.permissionType = fields.permissionType;
    if (fields.name !== undefined) existing.name = fields.name.trim();
    if (fields.description !== undefined)
      existing.description = fields.description.trim();
    if (fields.status !== undefined) {
      existing.status = fields.status;
      existing.isDeleted = fields.status === RecordStatus.INACTIVE;
    }
    if (fields.updatedBy !== undefined) existing.updatedBy = fields.updatedBy;
    const repo = this.dataSource.getRepository(FeaturePermissionEntity);
    if (fields.status !== undefined) {
      await this.dataSource.query(
        `UPDATE public.feature_permissions
         SET feature_id = $1,
             permission_code = $2,
             permission_type = $3,
             name = $4,
             description = $5,
             status = $6,
             is_deleted = $7,
             updated_by = $8,
             updated_at = now()
         WHERE id = $9`,
        [
          existing.featureId,
          existing.permissionCode,
          existing.permissionType,
          existing.name,
          existing.description,
          existing.status,
          existing.isDeleted,
          existing.updatedBy ?? null,
          existing.id,
        ],
      );
      return repo.findOneBy({ id: existing.id });
    }
    return repo.save(existing);
  }

  async deleteFeaturePermission(
    idOrCode: string,
    featureId: string,
    updatedBy?: string,
  ): Promise<boolean> {
    return Boolean(
      await this.updateFeaturePermission(idOrCode, featureId, {
        status: RecordStatus.INACTIVE,
        updatedBy,
      }),
    );
  }

  // --- Role Templates CRUD ---
  async listRoleTemplates(
    scopeType?: string,
    status?: string,
  ): Promise<RoleTemplateEntity[]> {
    if (!this.roleTemplateRepo) return [];
    const where: any = {};
    if (scopeType) where.scopeType = scopeType.toUpperCase();
    if (status) where.status = status.toUpperCase();
    return this.roleTemplateRepo.find({ where, order: { name: 'ASC' } });
  }

  async getRoleTemplateByIdOrCode(
    idOrCode: string,
  ): Promise<RoleTemplateEntity | null> {
    if (!this.roleTemplateRepo || !idOrCode) return null;
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrCode.trim(),
      );
    if (isUuid) {
      const byId = await this.roleTemplateRepo.findOneBy({
        id: idOrCode.trim(),
      });
      if (byId) return byId;
    }
    return this.roleTemplateRepo.findOneBy({
      roleCode: idOrCode.trim().toUpperCase(),
    });
  }

  async createRoleTemplate(
    dto: CreateRoleTemplateDto,
  ): Promise<RoleTemplateEntity> {
    const entity = this.roleTemplateRepo.create({
      roleCode: dto.roleCode.trim().toUpperCase(),
      name: dto.name.trim(),
      description: dto.description?.trim() || '',
      scopeType: dto.scopeType || RoleScopeType.STORE,
      status: dto.status || RoleTemplateStatus.ACTIVE,
      updatedBy: null,
      updatedAt: null as unknown as Date,
    });
    await this.roleTemplateRepo.insert(entity);
    return this.roleTemplateRepo.findOneByOrFail({ id: entity.id });
  }

  async updateRoleTemplate(
    idOrCode: string,
    dto: UpdateRoleTemplateDto,
  ): Promise<RoleTemplateEntity | null> {
    const existing = await this.getRoleTemplateByIdOrCode(idOrCode);
    if (!existing) return null;
    if (dto.name !== undefined) existing.name = dto.name.trim();
    if (dto.description !== undefined)
      existing.description = dto.description.trim();
    if (dto.scopeType !== undefined) existing.scopeType = dto.scopeType;
    if (dto.status !== undefined) existing.status = dto.status;
    existing.updatedAt = new Date();
    return this.roleTemplateRepo.save(existing);
  }

  async deleteRoleTemplate(idOrCode: string): Promise<boolean> {
    const existing = await this.getRoleTemplateByIdOrCode(idOrCode);
    if (!existing) return false;
    existing.status = RoleTemplateStatus.INACTIVE;
    existing.updatedAt = new Date();
    await this.roleTemplateRepo.save(existing);
    return true;
  }

  // --- Commercial Plans CRUD ---
  async listPlans(status?: string): Promise<PlanEntity[]> {
    if (!this.planMasterRepo) return [];
    const where: any = {};
    if (status) where.status = status.toUpperCase();
    return this.planMasterRepo.find({ where, order: { basePrice: 'ASC' } });
  }

  async getPlanByIdOrCode(idOrCode: string): Promise<PlanEntity | null> {
    if (!this.planMasterRepo || !idOrCode) return null;
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrCode.trim(),
      );
    if (isUuid) {
      const byId = await this.planMasterRepo.findOneBy({ id: idOrCode.trim() });
      if (byId) return byId;
    }
    return this.planMasterRepo.findOneBy({
      planCode: idOrCode.trim().toUpperCase(),
    });
  }

  async resolvePlanStoreType(
    planId: string,
  ): Promise<{ id: string; storeTypeCode: string; name: string } | null> {
    if (!this.dataSource?.isInitialized || !planId) return null;
    const [row] = await this.dataSource.query(
      `SELECT st.id::text AS id,
              upper(btrim(COALESCE(to_jsonb(st)->>'storeTypeCode', to_jsonb(st)->>'store_type_code', ''))) AS "storeTypeCode",
              st.name
       FROM public.plans p
       LEFT JOIN public.store_types st
         ON st.id::text = NULLIF(btrim(COALESCE(to_jsonb(p)->>'store_type', to_jsonb(p)->>'storeType', to_jsonb(p)->>'storeTypeId', '')), '')
         OR upper(btrim(COALESCE(to_jsonb(st)->>'storeTypeCode', to_jsonb(st)->>'store_type_code', '')))
            = upper(btrim(COALESCE(to_jsonb(p)->>'store_type', to_jsonb(p)->>'storeType', '')))
         OR lower(btrim(st.name)) = lower(btrim(COALESCE(to_jsonb(p)->>'store_type', to_jsonb(p)->>'storeType', '')))
       WHERE p.id::text = $1
       LIMIT 1`,
      [String(planId).trim()],
    );
    if (row?.id || row?.storeTypeCode || row?.name) return row;
    const [plan] = await this.dataSource.query(
      `SELECT btrim(COALESCE(to_jsonb(p)->>'store_type', to_jsonb(p)->>'storeType', '')) AS ref
       FROM public.plans p WHERE p.id::text = $1`,
      [String(planId).trim()],
    );
    const ref = String(plan?.ref || '').trim();
    return ref ? { id: '', storeTypeCode: ref.toUpperCase(), name: ref } : null;
  }

  async merchantActivePlanId(merchantId: string): Promise<string | null> {
    if (!this.dataSource?.isInitialized || !merchantId) return null;
    const [row] = await this.dataSource.query(
      `SELECT COALESCE(
         NULLIF(to_jsonb(s)->>'plan_id', ''),
         NULLIF(to_jsonb(s)->>'planId', ''),
         NULLIF(to_jsonb(m)->>'planId', ''),
         NULLIF(to_jsonb(m)->>'plan_id', '')
       ) AS "planId"
       FROM public.merchants m
       LEFT JOIN LATERAL (
         SELECT sub.*
         FROM public.subscriptions sub
         WHERE COALESCE(to_jsonb(sub)->>'merchantId', to_jsonb(sub)->>'merchant_id')
               IN (
                 COALESCE(to_jsonb(m)->>'merchantId', to_jsonb(m)->>'merchantCode', m.id::text),
                 m.id::text
               )
           AND upper(btrim(COALESCE(to_jsonb(sub)->>'status', 'ACTIVE'))) = 'ACTIVE'
         ORDER BY COALESCE(
           (to_jsonb(sub)->>'created_at')::timestamptz,
           (to_jsonb(sub)->>'createdAt')::timestamptz,
           now()
         ) DESC
         LIMIT 1
       ) s ON true
       WHERE m.id::text = $1 OR m."merchantId" = $1 OR m."merchantCode" = $1
       LIMIT 1`,
      [merchantId],
    );
    return row?.planId ? String(row.planId) : null;
  }

  async assertSameStoreTypePlan(
    currentPlanId: string | null | undefined,
    nextPlanId: string | null | undefined,
  ): Promise<void> {
    const currentId = String(currentPlanId || '').trim();
    const nextId = String(nextPlanId || '').trim();
    if (!currentId || !nextId || currentId === nextId) return;
    const current = await this.resolvePlanStoreType(currentId);
    const next = await this.resolvePlanStoreType(nextId);
    const currentCode = String(current?.storeTypeCode || current?.name || '')
      .trim()
      .toUpperCase();
    const nextCode = String(next?.storeTypeCode || next?.name || '')
      .trim()
      .toUpperCase();
    if (
      !currentCode ||
      !nextCode ||
      currentCode === 'BOTH' ||
      nextCode === 'BOTH'
    )
      return;
    const sameId = Boolean(current?.id && next?.id && current.id === next.id);
    const sameCode = Boolean(
      current?.storeTypeCode &&
        next?.storeTypeCode &&
        current.storeTypeCode === next.storeTypeCode,
    );
    const sameName = Boolean(
      current?.name &&
        next?.name &&
        current.name.trim().toLowerCase() === next.name.trim().toLowerCase(),
    );
    if (sameId || sameCode || sameName) return;
    throw new BadRequestException(
      `Plan must stay on the same store type (${current?.name || current?.storeTypeCode}). Other store types cannot be selected.`,
    );
  }

  async createPlan(dto: CreatePlanDto): Promise<PlanEntity> {
    const entity = this.planMasterRepo.create({
      planCode: dto.planCode.trim().toUpperCase(),
      name: dto.name.trim(),
      description: dto.description?.trim() || '',
      billingModel: dto.billingModel,
      basePrice: dto.basePrice,
      currency: dto.currency.trim().toUpperCase(),
      billingCycle: dto.billingCycle,
      storeType: dto.storeType?.trim().toUpperCase() || null,
      includedStores: dto.includedStores ?? 0,
      includedTerminals: dto.includedTerminals ?? 0,
      additionalTerminalPrice: dto.additionalTerminalPrice ?? 0,
      includedEmployees: dto.includedEmployees ?? 0,
      additionalEmployeePrice: dto.additionalEmployeePrice ?? 0,
      trialPeriod: dto.trialPeriod ?? 0,
      effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : null,
      includedFeatures: dto.includedFeatures ?? [],
      status: dto.status || PlanStatus.ACTIVE,
    });
    return this.planMasterRepo.save(entity);
  }

  async updatePlan(
    idOrCode: string,
    dto: UpdatePlanDto,
  ): Promise<PlanEntity | null> {
    const existing = await this.getPlanByIdOrCode(idOrCode);
    if (!existing) return null;
    if (dto.name !== undefined) existing.name = dto.name.trim();
    if (dto.description !== undefined)
      existing.description = dto.description.trim();
    if (dto.billingModel !== undefined)
      existing.billingModel = dto.billingModel;
    if (dto.basePrice !== undefined) existing.basePrice = dto.basePrice;
    if (dto.currency !== undefined)
      existing.currency = dto.currency.trim().toUpperCase();
    if (dto.billingCycle !== undefined)
      existing.billingCycle = dto.billingCycle;
    if (dto.storeType !== undefined)
      existing.storeType = dto.storeType?.trim().toUpperCase() || null;
    if (dto.includedStores !== undefined)
      existing.includedStores = dto.includedStores;
    if (dto.includedTerminals !== undefined)
      existing.includedTerminals = dto.includedTerminals;
    if (dto.additionalTerminalPrice !== undefined)
      existing.additionalTerminalPrice = dto.additionalTerminalPrice;
    if (dto.includedEmployees !== undefined)
      existing.includedEmployees = dto.includedEmployees;
    if (dto.additionalEmployeePrice !== undefined)
      existing.additionalEmployeePrice = dto.additionalEmployeePrice;
    if (dto.trialPeriod !== undefined) existing.trialPeriod = dto.trialPeriod;
    if (dto.effectiveFrom !== undefined)
      existing.effectiveFrom = dto.effectiveFrom
        ? new Date(dto.effectiveFrom)
        : null;
    if (dto.includedFeatures !== undefined)
      existing.includedFeatures = dto.includedFeatures;
    if (dto.status !== undefined) existing.status = dto.status;
    existing.updatedAt = new Date();
    return this.planMasterRepo.save(existing);
  }

  async deletePlan(idOrCode: string): Promise<boolean> {
    const existing = await this.getPlanByIdOrCode(idOrCode);
    if (!existing) return false;
    existing.status = PlanStatus.INACTIVE;
    existing.updatedAt = new Date();
    await this.planMasterRepo.save(existing);
    return true;
  }

  // --- Roles (Tenant-specific) CRUD ---
  async listRoles(merchantId: string, status?: string): Promise<RoleEntity[]> {
    if (!this.roleRepo) return [];
    const where: any = { merchantId };
    if (status) where.status = status.toUpperCase();
    return this.roleRepo.find({ where, order: { name: 'ASC' } });
  }

  async getRoleByIdOrCode(
    merchantId: string,
    idOrCode: string,
  ): Promise<RoleEntity | null> {
    if (!this.roleRepo || !idOrCode) return null;
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrCode.trim(),
      );
    if (isUuid) {
      const byId = await this.roleRepo.findOneBy({
        merchantId,
        id: idOrCode.trim(),
      });
      if (byId) return byId;
    }
    return this.roleRepo.findOneBy({
      merchantId,
      roleCode: idOrCode.trim().toUpperCase(),
    });
  }

  async createRole(dto: CreateRoleDto): Promise<RoleEntity> {
    if (!(await this.merchantRepo.existsBy({ id: dto.merchantId })))
      throw new NotFoundException('Merchant not found');
    if (
      dto.sourceRoleTemplateId &&
      !(await this.roleTemplateRepo.existsBy({ id: dto.sourceRoleTemplateId }))
    ) {
      throw new BadRequestException('Source role template does not exist');
    }
    const entity = this.roleRepo.create({
      merchantId: dto.merchantId,
      sourceRoleTemplateId: dto.sourceRoleTemplateId || null,
      roleCode: dto.roleCode.trim().toUpperCase(),
      name: dto.name.trim(),
      description: dto.description?.trim() || '',
      scopeType: dto.scopeType || RoleScopeType.STORE,
      isCustom: dto.isCustom !== false,
      status: dto.status || RoleStatus.ACTIVE,
    });
    return this.dataSource.transaction(async (manager) => {
      try {
        const role = await manager.getRepository(RoleEntity).save(entity);
        if (role.sourceRoleTemplateId) {
          const merchantUuid =
            (
              await manager.query(
                'SELECT m.id FROM public.merchants m WHERE m.merchant_id=$1 OR m.merchant_code=$1 OR m.id::text=$1 ORDER BY CASE WHEN m.id::text=$1 THEN 0 ELSE 1 END, m.created_at, m.id LIMIT 1',
                [dto.merchantId],
              )
            )[0]?.id || null;
          await manager.query(
            `INSERT INTO public.role_permissions(role_id,permission_id,allowed,merchant_id)
            SELECT $1,permission_id,default_allowed,$3 FROM public.role_template_permissions WHERE role_template_id=$2`,
            [role.id, role.sourceRoleTemplateId, merchantUuid],
          );
        }
        return role;
      } catch (error: any) {
        if (error.driverError?.code === '23505')
          throw new ConflictException(
            'Role code already exists for this merchant',
          );
        throw error;
      }
    });
  }

  async updateRole(
    merchantId: string,
    idOrCode: string,
    dto: UpdateRoleDto,
  ): Promise<RoleEntity | null> {
    const existing = await this.getRoleByIdOrCode(merchantId, idOrCode);
    if (!existing) return null;
    if (dto.name !== undefined) existing.name = dto.name.trim();
    if (dto.description !== undefined)
      existing.description = dto.description.trim();
    if (dto.scopeType !== undefined) existing.scopeType = dto.scopeType;
    if (dto.isCustom !== undefined) existing.isCustom = dto.isCustom;
    if (dto.status !== undefined) existing.status = dto.status;
    existing.updatedAt = new Date();
    return this.roleRepo.save(existing);
  }

  async deleteRole(merchantId: string, idOrCode: string): Promise<boolean> {
    const existing = await this.getRoleByIdOrCode(merchantId, idOrCode);
    if (!existing) return false;
    existing.status = RoleStatus.INACTIVE;
    existing.updatedAt = new Date();
    await this.roleRepo.save(existing);
    return true;
  }

  private async requireMerchantRecord(
    idOrCode: string,
  ): Promise<{ merchantCode: string; merchantUuid: string }> {
    const rows = await this.dataSource.query(
      `SELECT m.merchant_id AS "merchantCode", m.id AS "merchantUuid"
       FROM public.merchants m WHERE m.merchant_id=$1 OR m.merchant_code=$1 OR m.id::text=$1 ORDER BY CASE WHEN m.id::text=$1 THEN 0 ELSE 1 END, m.created_at, m.id LIMIT 1`,
      [idOrCode],
    );
    if (!rows.length)
      throw new NotFoundException(`Merchant '${idOrCode}' not found`);
    return rows[0];
  }

  private async requireStoreRecord(
    merchantId: string,
    storeId: string,
  ): Promise<{
    merchantCode: string;
    merchantUuid: string;
    storeUuid: string;
  }> {
    const merchant = await this.requireMerchantRecord(merchantId);
    const rows = await this.dataSource.query(
      `SELECT id FROM public.stores WHERE (store_code=$2 OR id::text=$2) AND merchant_id=$1::uuid LIMIT 1`,
      [merchant.merchantUuid, storeId],
    );
    if (!rows.length)
      throw new NotFoundException(
        `Store '${storeId}' not found for merchant '${merchantId}'`,
      );
    return { ...merchant, storeUuid: rows[0].id };
  }

  private async requireMerchantRole(
    merchantId: string,
    roleId: string,
  ): Promise<RoleEntity> {
    const { merchantCode } = await this.requireMerchantRecord(merchantId);
    const role = await this.getRoleByIdOrCode(merchantCode, roleId);
    if (!role)
      throw new NotFoundException(
        `Role '${roleId}' not found for merchant '${merchantId}'`,
      );
    return role;
  }

  private storeRolePermissionProjection = `rp.id, rp.role_id AS "roleId", rp.permission_id AS "permissionId", rp.allowed,
            rp.merchant_id AS "merchantId", rp.store_id AS "storeId",
            p.permission_key AS "permissionKey", p.name AS "permissionName",
            rp.created_at AS "createdAt", rp.updated_at AS "updatedAt"`;

  async listMerchantRoleTemplates(
    merchantId: string,
    status?: string,
  ): Promise<MerchantRoleTemplateEntity[]> {
    if (!this.merchantRoleTemplateRepo) return [];
    const { merchantUuid } = await this.requireMerchantRecord(merchantId);
    const where: Record<string, string> = { merchantId: merchantUuid };
    if (status) where.status = status.toUpperCase();
    return this.merchantRoleTemplateRepo.find({
      where,
      order: { name: 'ASC' },
    });
  }

  /** Resolve active subscription store type(s) for a merchant (id / merchantId / merchantCode). */
  async resolveMerchantSubscriptionStoreTypes(
    merchantId: string,
  ): Promise<Array<{ id: string; name: string; storeTypeCode: string }>> {
    if (!this.isDbConnected || !this.dataSource?.isInitialized) {
      throw new ServiceUnavailableException('PostgreSQL is unavailable');
    }
    const { merchantUuid } = await this.requireMerchantRecord(merchantId);
    return this.dataSource.query(
      `SELECT DISTINCT
         resolved.id,
         resolved.name,
         resolved."storeTypeCode"
       FROM public.merchants m
       JOIN public.subscriptions s
         ON COALESCE(to_jsonb(s)->>'merchant_id', to_jsonb(s)->>'merchantId')
            IN (
              m.id::text,
              COALESCE(NULLIF(to_jsonb(m)->>'merchantId', ''), m.id::text),
              COALESCE(NULLIF(to_jsonb(m)->>'merchantCode', ''), m.id::text)
            )
       LEFT JOIN public.plans p
         ON p.id::text = NULLIF(COALESCE(to_jsonb(s)->>'plan_id', to_jsonb(s)->>'planId'), '')
       JOIN LATERAL (
         SELECT
           st.id::text AS id,
           st.name,
           COALESCE(to_jsonb(st)->>'storeTypeCode', to_jsonb(st)->>'store_type_code', '') AS "storeTypeCode"
         FROM public.store_types st
         WHERE st.id::text = NULLIF(COALESCE(
                 to_jsonb(p)->>'store_type_id',
                 to_jsonb(p)->>'storeTypeId',
                 to_jsonb(s)->>'store_type_id',
                 to_jsonb(s)->>'storeTypeId',
                 CASE
                   WHEN COALESCE(to_jsonb(p)->>'store_type', to_jsonb(p)->>'storeType', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   THEN COALESCE(to_jsonb(p)->>'store_type', to_jsonb(p)->>'storeType')
                 END
               ), '')
            OR NULLIF(lower(COALESCE(to_jsonb(st)->>'storeTypeCode', to_jsonb(st)->>'store_type_code', '')), '')
               = NULLIF(lower(COALESCE(to_jsonb(p)->>'store_type', to_jsonb(p)->>'storeType', '')), '')
            OR NULLIF(lower(st.name), '')
               = NULLIF(lower(COALESCE(
                   to_jsonb(s)->>'storeTypeName',
                   to_jsonb(s)->>'store_type_name',
                   to_jsonb(p)->>'store_type',
                   to_jsonb(p)->>'storeType',
                   ''
                 )), '')
         ORDER BY
           CASE
             WHEN st.id::text = NULLIF(COALESCE(
               to_jsonb(p)->>'store_type_id',
               to_jsonb(p)->>'storeTypeId',
               to_jsonb(s)->>'store_type_id',
               to_jsonb(s)->>'storeTypeId'
             ), '') THEN 0
             WHEN NULLIF(lower(COALESCE(to_jsonb(st)->>'storeTypeCode', to_jsonb(st)->>'store_type_code', '')), '')
                  = NULLIF(lower(COALESCE(to_jsonb(p)->>'store_type', to_jsonb(p)->>'storeType', '')), '') THEN 1
             ELSE 2
           END,
           st.name
         LIMIT 1
       ) resolved ON true
       WHERE m.id::text = $1
         AND upper(btrim(COALESCE(to_jsonb(s)->>'status', ''))) = 'ACTIVE'
       ORDER BY resolved.name ASC`,
      [merchantUuid],
    );
  }

  /**
   * Checkbox catalog for merchant Roles tab:
   * templates mapped to the subscription store type, plus whether each is already saved.
   */
  async listAvailableMerchantRoleTemplates(merchantId: string): Promise<{
    storeTypes: Array<{ id: string; name: string; storeTypeCode: string }>;
    count: number;
    roleTemplates: Record<string, unknown>[];
  }> {
    const storeTypes =
      await this.resolveMerchantSubscriptionStoreTypes(merchantId);
    if (!storeTypes.length) {
      return { storeTypes: [], count: 0, roleTemplates: [] };
    }

    const selected = await this.listMerchantRoleTemplates(merchantId, 'ACTIVE');
    const selectedIds = new Set(
      selected
        .map((row) => row.sourceRoleTemplateId)
        .filter((id): id is string => Boolean(id))
        .map((id) => id.toLowerCase()),
    );

    const byId = new Map<string, Record<string, unknown>>();
    for (const storeType of storeTypes) {
      const templates = await this.listRoleTemplatesForStoreType(storeType.id, {
        status: 'ACTIVE',
      });
      for (const template of templates) {
        const id = String(template.id).toLowerCase();
        if (byId.has(id)) continue;
        byId.set(id, {
          ...template,
          selected: selectedIds.has(id),
          required: Boolean(template.required),
          storeTypeId: storeType.id,
          storeTypeName: storeType.name,
        });
      }
    }

    const roleTemplates = [...byId.values()].sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || '')),
    );
    return { storeTypes, count: roleTemplates.length, roleTemplates };
  }

  /**
   * public.roles has a primary key on id only, so conflict targets cannot be used.
   * Match an existing workforce role by template or role code, then update or insert.
   */
  private async ensureWorkforceRole(
    manager: { query: (sql: string, params?: unknown[]) => Promise<Array<{ id: string }>> },
    merchantCode: string,
    roleTemplateId: string,
    template: {
      roleCode: string;
      name: string;
      description?: string | null;
      scopeType?: string | null;
    },
  ): Promise<void> {
    const [existing] = await manager.query(
      `SELECT id FROM public.roles
       WHERE merchant_id = $1
         AND (source_role_template_id = $2::uuid OR role_code = $3)
       ORDER BY CASE WHEN source_role_template_id = $2::uuid THEN 0 ELSE 1 END, created_at
       LIMIT 1`,
      [merchantCode, roleTemplateId, template.roleCode],
    );
    const values = [
      roleTemplateId,
      template.roleCode,
      template.name,
      template.description || '',
      template.scopeType || 'STORE',
    ];
    if (existing) {
      await manager.query(
        `UPDATE public.roles
         SET source_role_template_id = $2::uuid,
             role_code = $3,
             name = $4,
             description = $5,
             scope_type = $6,
             is_custom = false,
             status = 'ACTIVE',
             updated_at = now()
         WHERE id = $1`,
        [existing.id, ...values],
      );
      return;
    }
    await manager.query(
      `INSERT INTO public.roles
         (merchant_id, source_role_template_id, role_code, name, description, scope_type, is_custom, status)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, false, 'ACTIVE')`,
      [merchantCode, ...values],
    );
  }

  /**
   * Replace merchant role-template selections (checkbox save).
   * Validates against subscription store-type mappings, writes merchant_role_templates,
   * and ensures workforce `roles` rows exist.
   */
  async saveMerchantRoleTemplates(
    merchantId: string,
    body: { roleTemplateIds: string[] },
  ): Promise<MerchantRoleTemplateEntity[]> {
    if (!this.isDbConnected || !this.dataSource?.isInitialized) {
      throw new ServiceUnavailableException('PostgreSQL is unavailable');
    }
    const { merchantCode, merchantUuid } =
      await this.requireMerchantRecord(merchantId);
    const ids = [
      ...new Set(
        (body.roleTemplateIds || [])
          .map((id) => id.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];

    const storeTypes =
      await this.resolveMerchantSubscriptionStoreTypes(merchantId);
    if (!storeTypes.length) {
      throw new BadRequestException(
        'Merchant has no active subscription store type',
      );
    }

    if (ids.length) {
      const storeTypeIds = storeTypes.map((row) => row.id);
      const allowed = await this.dataSource.query(
        `SELECT DISTINCT role_template_id::text AS id
         FROM public.store_type_role_templates
         WHERE store_type_id = ANY($1::uuid[]) AND role_template_id = ANY($2::uuid[])`,
        [storeTypeIds, ids],
      );
      const allowedSet = new Set(
        allowed.map((row: { id: string }) => row.id.toLowerCase()),
      );
      const invalid = ids.filter((id) => !allowedSet.has(id));
      if (invalid.length) {
        throw new BadRequestException(
          `Role template(s) not mapped to this merchant's subscription store type: ${invalid.join(', ')}`,
        );
      }
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE public.merchant_role_templates
         SET status = 'INACTIVE', updated_at = now()
         WHERE merchant_id = $1::uuid AND source_role_template_id IS NOT NULL`,
        [merchantUuid],
      );

      for (const roleTemplateId of ids) {
        const templates = await manager.query(
          `SELECT id, role_code AS "roleCode", name, description, scope_type AS "scopeType", status
           FROM public.role_templates WHERE id = $1::uuid LIMIT 1`,
          [roleTemplateId],
        );
        if (
          !templates[0] ||
          String(templates[0].status).toUpperCase() !== 'ACTIVE'
        ) {
          throw new BadRequestException(
            `Role template '${roleTemplateId}' is missing or inactive`,
          );
        }

        const [existing] = await manager.query(
          `SELECT id FROM public.merchant_role_templates
           WHERE merchant_id = $1::uuid AND source_role_template_id = $2::uuid LIMIT 1`,
          [merchantUuid, roleTemplateId],
        );
        if (existing) {
          await manager.query(
            `UPDATE public.merchant_role_templates
             SET status = 'ACTIVE', role_code = $2, name = $3, description = $4, scope_type = $5, updated_at = now()
             WHERE id = $1`,
            [
              existing.id,
              templates[0].roleCode,
              templates[0].name,
              templates[0].description || '',
              templates[0].scopeType || 'STORE',
            ],
          );
        } else {
          await manager.query(
            `INSERT INTO public.merchant_role_templates
               (id, merchant_id, source_role_template_id, role_code, name, description, scope_type, status)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'ACTIVE')`,
            [
              crypto.randomUUID(),
              merchantUuid,
              roleTemplateId,
              templates[0].roleCode,
              templates[0].name,
              templates[0].description || '',
              templates[0].scopeType || 'STORE',
            ],
          );
        }

        await this.ensureWorkforceRole(manager, merchantCode, roleTemplateId, templates[0]);
      }
    });

    return this.listMerchantRoleTemplates(merchantId, 'ACTIVE');
  }

  /** Master: role templates linked to a store type via store_type_role_templates. */
  async listRoleTemplatesForStoreType(
    storeTypeIdOrCode: string,
    options: { status?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    if (!this.isDbConnected || !this.dataSource?.isInitialized) {
      throw new ServiceUnavailableException('PostgreSQL is unavailable');
    }
    const storeTypes = await this.dataSource.query(
      `SELECT st.id FROM public.store_types st
       WHERE st.id::text=$1
          OR lower(COALESCE(to_jsonb(st)->>'store_type_code',to_jsonb(st)->>'storeTypeCode'))=lower($1)
          OR lower(st.name)=lower($1)
       LIMIT 1`,
      [storeTypeIdOrCode],
    );
    if (!storeTypes[0])
      throw new NotFoundException(
        `Store type '${storeTypeIdOrCode}' not found`,
      );

    const params: unknown[] = [storeTypes[0].id];
    const filters: string[] = ['mapping.store_type_id = $1'];
    if (options.status) {
      params.push(options.status.toUpperCase());
      filters.push(`rt.status = $${params.length}`);
    }

    return this.dataSource.query(
      `SELECT rt.id, rt.role_code AS "roleCode", rt.name, rt.description,
              rt.scope_type AS "scopeType", rt.status,
              mapping.id AS "mappingId",
              ${mappingRequired} AS required,
              COALESCE(to_jsonb(mapping)->>'created_at', to_jsonb(mapping)->>'createdAt') AS "mappedAt"
       FROM public.store_type_role_templates mapping
       JOIN public.role_templates rt ON rt.id = mapping.role_template_id
       WHERE ${filters.join(' AND ')}
       ORDER BY rt.name`,
      params,
    );
  }

  /** Tenant: role templates saved for a merchant store. */
  async listStoreRoleTemplates(
    merchantId: string,
    storeId: string,
  ): Promise<Record<string, unknown>[]> {
    if (!this.isDbConnected || !this.dataSource?.isInitialized) {
      throw new ServiceUnavailableException('PostgreSQL is unavailable');
    }
    const { merchantUuid, storeUuid } = await this.requireStoreRecord(
      merchantId,
      storeId,
    );
    return this.dataSource.query(
      `SELECT srt.id, srt.merchant_id AS "merchantId", srt.store_id AS "storeId",
              srt.role_template_id AS "roleTemplateId", srt.enabled, srt.status,
              rt.role_code AS "roleCode", rt.name, rt.description,
              rt.scope_type AS "scopeType", rt.status AS "roleTemplateStatus",
              srt.created_at AS "createdAt", srt.updated_at AS "updatedAt"
       FROM public.store_role_templates srt
       JOIN public.role_templates rt ON rt.id = srt.role_template_id
       WHERE srt.merchant_id = $1::uuid AND srt.store_id = $2::uuid AND srt.status = 'ACTIVE'
       ORDER BY rt.name`,
      [merchantUuid, storeUuid],
    );
  }

  /**
   * Replace the set of role templates for a merchant store.
   * Each template must be mapped to the store's store type in store_type_role_templates.
   * Also ensures a merchant `roles` row exists (source_role_template_id) for workforce assignment.
   */
  async saveStoreRoleTemplates(
    merchantId: string,
    storeId: string,
    body: { roleTemplateIds: string[]; enabled?: boolean },
  ): Promise<Record<string, unknown>[]> {
    if (!this.isDbConnected || !this.dataSource?.isInitialized) {
      throw new ServiceUnavailableException('PostgreSQL is unavailable');
    }
    const { merchantCode, merchantUuid, storeUuid } =
      await this.requireStoreRecord(merchantId, storeId);
    const enabled = body.enabled !== false;
    const ids = [
      ...new Set(
        (body.roleTemplateIds || []).map((id) => id.trim().toLowerCase()),
      ),
    ];

    const stores = await this.dataSource.query(
      `SELECT COALESCE(to_jsonb(s)->>'store_type_id', to_jsonb(s)->>'storeType') AS "storeType"
       FROM public.stores s WHERE s.id = $1::uuid LIMIT 1`,
      [storeUuid],
    );
    const storeTypeValue = stores[0]?.storeType;
    if (!storeTypeValue)
      throw new BadRequestException('Store does not have a store type');

    const storeTypes = await this.dataSource.query(
      `SELECT st.id FROM public.store_types st
       WHERE st.id::text=$1
          OR lower(COALESCE(to_jsonb(st)->>'store_type_code',to_jsonb(st)->>'storeTypeCode'))=lower($1)
          OR lower(st.name)=lower($1)
       LIMIT 1`,
      [String(storeTypeValue)],
    );
    if (!storeTypes[0])
      throw new BadRequestException(
        `Store type '${storeTypeValue}' is not configured`,
      );
    const storeTypeId = String(storeTypes[0].id);

    if (ids.length) {
      const allowed = await this.dataSource.query(
        `SELECT role_template_id::text AS id
         FROM public.store_type_role_templates
         WHERE store_type_id = $1::uuid AND role_template_id = ANY($2::uuid[])`,
        [storeTypeId, ids],
      );
      const allowedSet = new Set(
        allowed.map((row: { id: string }) => row.id.toLowerCase()),
      );
      const invalid = ids.filter((id) => !allowedSet.has(id));
      if (invalid.length) {
        throw new BadRequestException(
          `Role template(s) not mapped to this store type: ${invalid.join(', ')}`,
        );
      }
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `DELETE FROM public.store_role_templates
         WHERE merchant_id = $1::uuid AND store_id = $2::uuid`,
        [merchantUuid, storeUuid],
      );

      for (const roleTemplateId of ids) {
        const templates = await manager.query(
          `SELECT id, role_code AS "roleCode", name, description, scope_type AS "scopeType", status
           FROM public.role_templates WHERE id = $1::uuid LIMIT 1`,
          [roleTemplateId],
        );
        if (!templates[0] || templates[0].status !== 'ACTIVE') {
          throw new BadRequestException(
            `Role template '${roleTemplateId}' is missing or inactive`,
          );
        }

        await manager.query(
          `INSERT INTO public.store_role_templates
             (merchant_id, store_id, role_template_id, enabled, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
          [merchantUuid, storeUuid, roleTemplateId, enabled],
        );

        await this.ensureWorkforceRole(manager, merchantCode, roleTemplateId, templates[0]);
      }
    });

    return this.listStoreRoleTemplates(merchantId, storeId);
  }

  async getMerchantRoleTemplate(
    merchantId: string,
    idOrCode: string,
  ): Promise<MerchantRoleTemplateEntity | null> {
    if (!this.merchantRoleTemplateRepo || !idOrCode) return null;
    const { merchantUuid } = await this.requireMerchantRecord(merchantId);
    const trimmed = idOrCode.trim();
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        trimmed,
      )
    ) {
      const byId = await this.merchantRoleTemplateRepo.findOneBy({
        merchantId: merchantUuid,
        id: trimmed,
      });
      if (byId) return byId;
    }
    return this.merchantRoleTemplateRepo.findOneBy({
      merchantId: merchantUuid,
      roleCode: trimmed.toUpperCase(),
    });
  }

  async createMerchantRoleTemplate(
    merchantId: string,
    dto: CreateMerchantRoleTemplateDto,
  ): Promise<MerchantRoleTemplateEntity> {
    const { merchantUuid } = await this.requireMerchantRecord(merchantId);
    let source: RoleTemplateEntity | null = null;
    if (dto.sourceRoleTemplateId) {
      source = await this.getRoleTemplateByIdOrCode(dto.sourceRoleTemplateId);
      if (!source)
        throw new BadRequestException('Source role template does not exist');
    }
    const roleCode = (dto.roleCode || source?.roleCode || '')
      .trim()
      .toUpperCase();
    if (!roleCode)
      throw new BadRequestException(
        'roleCode or sourceRoleTemplateId is required',
      );
    const name = (dto.name || source?.name || '').trim();
    if (!name)
      throw new BadRequestException('name or sourceRoleTemplateId is required');
    const existing = await this.merchantRoleTemplateRepo.findOneBy({
      merchantId: merchantUuid,
      roleCode,
    });
    if (existing)
      throw new ConflictException(
        `Role code '${roleCode}' already exists for this merchant`,
      );
    try {
      return await this.merchantRoleTemplateRepo.save(
        this.merchantRoleTemplateRepo.create({
          merchantId: merchantUuid,
          sourceRoleTemplateId: source?.id || null,
          roleCode,
          name,
          description: dto.description?.trim() ?? source?.description ?? '',
          scopeType: dto.scopeType || source?.scopeType || RoleScopeType.STORE,
          status: dto.status || RoleTemplateStatus.ACTIVE,
        }),
      );
    } catch (error: any) {
      if (error.driverError?.code === '23505')
        throw new ConflictException(
          `Role code '${roleCode}' already exists for this merchant`,
        );
      throw error;
    }
  }

  async updateMerchantRoleTemplate(
    merchantId: string,
    idOrCode: string,
    dto: UpdateMerchantRoleTemplateDto,
  ): Promise<MerchantRoleTemplateEntity | null> {
    const existing = await this.getMerchantRoleTemplate(merchantId, idOrCode);
    if (!existing) return null;
    if (dto.name !== undefined) existing.name = dto.name.trim();
    if (dto.description !== undefined)
      existing.description = dto.description.trim();
    if (dto.scopeType !== undefined) existing.scopeType = dto.scopeType;
    if (dto.status !== undefined) existing.status = dto.status;
    existing.updatedAt = new Date();
    return this.merchantRoleTemplateRepo.save(existing);
  }

  async deleteMerchantRoleTemplate(
    merchantId: string,
    idOrCode: string,
  ): Promise<boolean> {
    const existing = await this.getMerchantRoleTemplate(merchantId, idOrCode);
    if (!existing) return false;
    existing.status = RoleTemplateStatus.INACTIVE;
    existing.updatedAt = new Date();
    await this.merchantRoleTemplateRepo.save(existing);
    return true;
  }

  async listStoreRolePermissions(
    merchantId: string,
    storeId: string,
    roleId: string,
  ): Promise<Record<string, unknown>[]> {
    const { merchantUuid, storeUuid } = await this.requireStoreRecord(
      merchantId,
      storeId,
    );
    const role = await this.requireMerchantRole(merchantId, roleId);
    return this.dataSource.query(
      `SELECT ${this.storeRolePermissionProjection}
       FROM public.role_permissions rp JOIN public.permissions p ON p.id=rp.permission_id
       WHERE rp.role_id=$1 AND rp.merchant_id=$2 AND rp.store_id=$3
       ORDER BY p.permission_key`,
      [role.id, merchantUuid, storeUuid],
    );
  }

  async getStoreRolePermission(
    merchantId: string,
    storeId: string,
    roleId: string,
    permissionId: string,
  ): Promise<Record<string, unknown> | null> {
    const { merchantUuid, storeUuid } = await this.requireStoreRecord(
      merchantId,
      storeId,
    );
    const role = await this.requireMerchantRole(merchantId, roleId);
    const permission = await this.getPermissionByIdOrKey(permissionId);
    if (!permission) return null;
    const rows = await this.dataSource.query(
      `SELECT ${this.storeRolePermissionProjection}
       FROM public.role_permissions rp JOIN public.permissions p ON p.id=rp.permission_id
       WHERE rp.role_id=$1 AND rp.permission_id=$2 AND rp.merchant_id=$3 AND rp.store_id=$4`,
      [role.id, permission.id, merchantUuid, storeUuid],
    );
    return rows[0] || null;
  }

  async upsertStoreRolePermission(
    merchantId: string,
    storeId: string,
    roleId: string,
    permissionId: string,
    allowed: boolean,
  ): Promise<Record<string, unknown>> {
    const { merchantUuid, storeUuid } = await this.requireStoreRecord(
      merchantId,
      storeId,
    );
    const role = await this.requireMerchantRole(merchantId, roleId);
    const permission = await this.getPermissionByIdOrKey(permissionId);
    if (!permission)
      throw new NotFoundException(`Permission '${permissionId}' not found`);
    const rows = await this.dataSource.query(
      `INSERT INTO public.role_permissions(role_id,permission_id,allowed,merchant_id,store_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (role_id,permission_id,store_id) WHERE store_id IS NOT NULL
       DO UPDATE SET allowed=EXCLUDED.allowed, merchant_id=EXCLUDED.merchant_id, updated_at=now()
       RETURNING id`,
      [role.id, permission.id, allowed, merchantUuid, storeUuid],
    );
    const [item] = await this.dataSource.query(
      `SELECT ${this.storeRolePermissionProjection}
       FROM public.role_permissions rp JOIN public.permissions p ON p.id=rp.permission_id
       WHERE rp.id=$1`,
      [rows[0].id],
    );
    return item;
  }

  async upsertStoreRolePermissionsBulk(
    merchantId: string,
    storeId: string,
    roleId: string,
    items: CreateStoreRolePermissionDto[],
  ): Promise<Record<string, unknown>[]> {
    const seen = new Set<string>();
    const saved = [];
    for (const item of items) {
      if (seen.has(item.permissionId))
        throw new BadRequestException('Duplicate permissionId in items');
      seen.add(item.permissionId);
      saved.push(
        await this.upsertStoreRolePermission(
          merchantId,
          storeId,
          roleId,
          item.permissionId,
          item.allowed !== false,
        ),
      );
    }
    return saved;
  }

  async deleteStoreRolePermission(
    merchantId: string,
    storeId: string,
    roleId: string,
    permissionId: string,
  ): Promise<boolean> {
    const { merchantUuid, storeUuid } = await this.requireStoreRecord(
      merchantId,
      storeId,
    );
    const role = await this.requireMerchantRole(merchantId, roleId);
    const permission = await this.getPermissionByIdOrKey(permissionId);
    if (!permission) return false;
    const result = await this.dataSource.query(
      `DELETE FROM public.role_permissions
       WHERE role_id=$1 AND permission_id=$2 AND merchant_id=$3 AND store_id=$4
       RETURNING id`,
      [role.id, permission.id, merchantUuid, storeUuid],
    );
    return result.length > 0;
  }

  // --- Employees (Tenant-specific) CRUD ---
  async employeeStatistics(
    merchantId?: string,
  ): Promise<Record<string, unknown>> {
    const [row] = await this.dataSource.query(
      `WITH bounds AS (
         SELECT date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AS month_start,
                (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') - interval '1 month') AT TIME ZONE 'Asia/Kolkata' AS last_month_start,
                (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') + interval '1 month') AT TIME ZONE 'Asia/Kolkata' AS next_month_start
       )
       SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE upper(e.status::text) = 'ACTIVE')::int AS active,
              COUNT(*) FILTER (WHERE upper(e.status::text) = 'INACTIVE')::int AS inactive,
              COUNT(*) FILTER (WHERE e.created_at >= b.month_start AND e.created_at < b.next_month_start)::int AS current_month,
              COUNT(*) FILTER (WHERE e.created_at >= b.last_month_start AND e.created_at < b.month_start)::int AS last_month
       FROM public.employees e CROSS JOIN bounds b
       WHERE ($1::uuid IS NULL OR e.merchant_id = $1::uuid)`,
      [merchantId ?? null],
    );
    const total = Number(row.total);
    const currentMonth = Number(row.current_month);
    const lastMonth = Number(row.last_month);
    const percentage = (count: number) =>
      total ? Math.round((count / total) * 1000) / 10 : 0;
    return {
      total_employees: total,
      active_employees: Number(row.active),
      inactive_employees: Number(row.inactive),
      current_month_added_employees: currentMonth,
      last_month_added_employees: lastMonth,
      active_employees_percentage: percentage(Number(row.active)),
      inactive_employees_percentage: percentage(Number(row.inactive)),
      monthly_growth_percentage: lastMonth
        ? Math.round(((currentMonth - lastMonth) / lastMonth) * 1000) / 10
        : currentMonth
          ? 100
          : 0,
      monthly_growth_direction:
        currentMonth > lastMonth
          ? 'INCREASE'
          : currentMonth < lastMonth
            ? 'DECREASE'
            : 'UNCHANGED',
    };
  }

  async listEmployees(
    merchantId?: string,
    status?: string,
  ): Promise<Record<string, unknown>[]> {
    if (!this.employeeRepo) return [];
    const where: any = {};
    if (merchantId) where.merchantId = merchantId;
    if (status) where.status = status.toUpperCase();
    const employees = await this.employeeRepo.find({
      where,
      order: { firstName: 'ASC' },
    });
    return Promise.all(
      employees.map((employee) => this.employeeDetails(employee)),
    );
  }

  async getEmployeeDetails(
    merchantId: string | undefined,
    idOrCode: string,
  ): Promise<Record<string, unknown> | null> {
    const employee = await this.getEmployeeByIdOrCode(merchantId, idOrCode);
    return employee ? this.employeeDetails(employee) : null;
  }

  private async employeeDetails(
    employee: EmployeeEntity,
  ): Promise<Record<string, unknown>> {
    // Read every table column, including nullable values, without returning credential hashes.
    const [row] = await this.dataSource.query(
      `SELECT to_jsonb(e) - 'login_pin_hash' - 'password_hash' AS details,
              (e.login_pin_hash IS NOT NULL) AS "pinSet"
       FROM public.employees e WHERE e.id=$1::uuid`,
      [employee.id],
    );
    const details = Object.fromEntries(
      Object.entries(row?.details || {}).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        value,
      ]),
    );
    const createdAt = Date.parse(String(details.createdAt ?? ''));
    const updatedAt = Date.parse(String(details.updatedAt ?? ''));
    if (Number.isFinite(createdAt) && Number.isFinite(updatedAt) && updatedAt <= createdAt) {
      delete details.updatedAt;
    }
    const users = employee.userId
      ? await this.dataSource.query(
          'SELECT username FROM public.users WHERE id=$1',
          [employee.userId],
        )
      : [];
    const merchants = await this.dataSource.query(
      `SELECT merchant_code AS "merchantCode", business_display_name AS "merchantName"
       FROM public.merchants WHERE id=$1::uuid`,
      [employee.merchantId],
    );
    const assignmentRows = await this.dataSource.query(
      `SELECT es.store_id::text AS "storeId",
              COALESCE(to_jsonb(s)->>'store_name', to_jsonb(s)->>'storeName', to_jsonb(s)->>'name') AS "storeName",
              es.status AS "assignmentStatus",
              (es.login_pin_hash IS NOT NULL) AS "pinSet",
              es.login_pin AS "loginPin"
       FROM public.employee_stores es
       LEFT JOIN public.stores s ON s.id::text = es.store_id::text
       WHERE es.merchant_id::text = $1::text AND es.employee_id = $2::uuid
       ORDER BY es.created_at ASC`,
      [employee.merchantId, employee.id],
    );
    const storeAssignments = assignmentRows;
    return {
      ...details,
      pinSet: Boolean(row?.pinSet),
      storeAssignments,
      merchantCode: merchants[0]?.merchantCode || null,
      merchantName: merchants[0]?.merchantName || null,
      username: details.username ?? users[0]?.username ?? null,
    };
  }

  async getEmployeeByIdOrCode(
    merchantId: string | undefined,
    idOrCode: string,
  ): Promise<EmployeeEntity | null> {
    if (!this.employeeRepo || !idOrCode) return null;
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrCode.trim(),
      );
    if (isUuid) {
      const byId = await this.employeeRepo.findOneBy(
        merchantId
          ? { merchantId, id: idOrCode.trim() }
          : { id: idOrCode.trim() },
      );
      if (byId) return byId;
    }
    const matches = await this.employeeRepo.find({
      where: merchantId
        ? { merchantId, employeeCode: idOrCode.trim().toUpperCase() }
        : { employeeCode: idOrCode.trim().toUpperCase() },
      take: 2,
    });
    if (matches.length > 1)
      throw new ConflictException(
        `Employee code '${idOrCode}' exists for more than one merchant; use the employee UUID`,
      );
    return matches[0] || null;
  }

  async createEmployee(dto: CreateEmployeeDto): Promise<EmployeeEntity> {
    if (!(await this.merchantRepo.existsBy({ id: dto.merchantId })))
      throw new NotFoundException('Merchant not found');
    try {
      return await this.dataSource.transaction(async (manager) => {
        const employeeRepo = manager.getRepository(EmployeeEntity);
        const email = dto.email.trim().toLowerCase();
        const username = dto.username.trim().toLowerCase();
        const duplicate = await manager.query(
          'SELECT 1 FROM public.users WHERE lower(email)=lower($1) OR lower(username)=lower($2) LIMIT 1',
          [email, username],
        );
        if (duplicate.length)
          throw new ConflictException(
            'Employee email or username already exists',
          );
        const employeeCode = await this.nextEmployeeCode(
          manager,
          dto.merchantId!,
        );
        if (
          await manager
            .getRepository(EmployeeEntity)
            .existsBy({ merchantId: dto.merchantId, employeeCode })
        ) {
          throw new ConflictException(
            `Employee code '${employeeCode}' already exists for this merchant`,
          );
        }
        const employee = await employeeRepo.save(
          employeeRepo.create({
            merchantId: dto.merchantId,
            employeeCode,
            createdBy: dto.createdBy,
            updatedBy: null,
            updatedAt: null as unknown as Date,
            firstName: dto.firstName.trim(),
            lastName: dto.lastName?.trim() || '',
            email,
            profileImageUrl: dto.profileImageUrl?.trim() || null,
            phone: dto.phone?.trim() || null,
            dateOfBirth: dto.dateOfBirth || null,
            gender: dto.gender?.trim() || null,
            addressLine1: dto.addressLine1?.trim() || '',
            addressLine2: dto.addressLine2?.trim() || '',
            city: dto.city?.trim() || '',
            state: dto.state?.trim() || '',
            postalCode: dto.postalCode?.trim() || '',
            country: dto.country?.trim() || '',
            loginPinHash: dto.loginPin
              ? this.hashEmployeePin(dto.loginPin)
              : null,
            loginPin: dto.loginPin || null,
            sendCredentials: dto.sendCredentials ?? true,
            status: dto.status || EmployeeStatus.ACTIVE,
          }),
        );
        const account = await manager.query(
          `SELECT u."accountId" FROM public.merchants m LEFT JOIN public.users u ON lower(u.email)=lower(m.email)
           WHERE m.id=$1::uuid LIMIT 1`,
          [dto.merchantId],
        );
        const [user] = await manager.query(
          `INSERT INTO public.users("accountId","firstName","lastName",email,"phoneNumber",role,"notificationEnabled",status,"passwordHash",username,"merchantId","employeeId")
           VALUES($1,$2,$3,$4,$5,'USER',true,$6,$7,$8,$9,$10) RETURNING id`,
          [
            account[0]?.accountId || null,
            employee.firstName,
            employee.lastName,
            email,
            employee.phone || '',
            employee.status === EmployeeStatus.ACTIVE ? 'ACTIVE' : 'DISABLED',
            this.hashUserPassword(dto.temporaryPassword),
            username,
            dto.merchantId,
            employee.id,
          ],
        );
        employee.userId = user.id;
        await manager.query('UPDATE public.employees SET user_id=$2 WHERE id=$1', [employee.id, user.id]);
        if (dto.storeAssignments) {
          await this.syncEmployeeAssignmentsWithManager(
            manager,
            dto.merchantId!,
            employee.id,
            dto.storeAssignments,
            dto.loginPin,
          );
        }
        return employee;
      });
    } catch (error: any) {
      if (
        error instanceof ConflictException ||
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      )
        throw error;
      if ((error.driverError?.code || error.code) === '23505')
        throw new ConflictException(
          'Employee code, email, or username already exists',
        );
      throw error;
    }
  }

  async updateEmployee(
    merchantId: string | undefined,
    idOrCode: string,
    dto: UpdateEmployeeDto,
  ): Promise<EmployeeEntity | null> {
    const existing = await this.getEmployeeByIdOrCode(merchantId, idOrCode);
    if (!existing) return null;
    if (dto.updatedBy !== undefined) existing.updatedBy = dto.updatedBy;
    if (dto.profileImageUrl !== undefined)
      existing.profileImageUrl = dto.profileImageUrl.trim() || null;
    if (dto.firstName !== undefined) existing.firstName = dto.firstName.trim();
    if (dto.lastName !== undefined) existing.lastName = dto.lastName.trim();
    if (dto.email !== undefined)
      existing.email = dto.email?.trim().toLowerCase() || null;
    if (dto.phone !== undefined) existing.phone = dto.phone?.trim() || null;
    if (dto.dateOfBirth !== undefined)
      existing.dateOfBirth = dto.dateOfBirth || null;
    if (dto.gender !== undefined) existing.gender = dto.gender?.trim() || null;
    if (dto.addressLine1 !== undefined)
      existing.addressLine1 = dto.addressLine1.trim();
    if (dto.addressLine2 !== undefined)
      existing.addressLine2 = dto.addressLine2.trim();
    if (dto.city !== undefined) existing.city = dto.city.trim();
    if (dto.state !== undefined) existing.state = dto.state.trim();
    if (dto.postalCode !== undefined)
      existing.postalCode = dto.postalCode.trim();
    if (dto.country !== undefined) existing.country = dto.country.trim();
    if (dto.username !== undefined)
      existing.username = dto.username.trim().toLowerCase();
    if (dto.loginPin !== undefined)
      existing.loginPinHash = dto.loginPin
        ? this.hashEmployeePin(dto.loginPin)
        : null;
    if (dto.loginPin !== undefined)
      existing.loginPin = dto.loginPin || null;
    if (dto.temporaryPassword !== undefined) existing.passwordHash = null;
    if (dto.sendCredentials !== undefined)
      existing.sendCredentials = dto.sendCredentials;
    if (dto.status !== undefined) {
      existing.status = dto.status;
      if (dto.status === EmployeeStatus.ACTIVE) existing.isDeleted = false;
    }
    existing.updatedAt = new Date();
    return this.dataSource.transaction(async (manager) => {
      const saved = await manager.getRepository(EmployeeEntity).save(existing);
      if (saved.userId) {
        const updates: string[] = [
          '"firstName"=$2',
          '"lastName"=$3',
          '"phoneNumber"=$4',
          'status=$5',
          '"updatedAt"=clock_timestamp()',
        ];
        const values: unknown[] = [
          saved.userId,
          saved.firstName,
          saved.lastName,
          saved.phone || '',
          saved.status === EmployeeStatus.ACTIVE ? 'ACTIVE' : 'DISABLED',
        ];
        if (dto.email !== undefined) {
          values.push(saved.email);
          updates.push(`email=$${values.length}`);
        }
        if (dto.username !== undefined) {
          values.push(dto.username.trim().toLowerCase());
          updates.push(`username=$${values.length}`);
        }
        if (dto.temporaryPassword !== undefined) {
          values.push(this.hashUserPassword(dto.temporaryPassword));
          updates.push(`"passwordHash"=$${values.length}`);
        }
        await manager.query(
          `UPDATE public.users SET ${updates.join(',')} WHERE id=$1`,
          values,
        );
      }
      if (dto.storeAssignments) {
        await this.syncEmployeeAssignmentsWithManager(
          manager,
          saved.merchantId,
          saved.id,
          dto.storeAssignments,
          dto.loginPin,
        );
      } else if (dto.loginPin !== undefined) {
        await this.syncEmployeePinToAssignmentsWithManager(
          manager,
          saved.id,
          dto.loginPin || null,
        );
      }
      return saved;
    });
  }

  async deleteEmployee(
    merchantId: string | undefined,
    idOrCode: string,
    updatedBy?: string,
  ): Promise<boolean> {
    const existing = await this.getEmployeeByIdOrCode(merchantId, idOrCode);
    if (!existing) return false;
    existing.status = EmployeeStatus.INACTIVE;
    existing.isDeleted = true;
    if (updatedBy) existing.updatedBy = updatedBy;
    existing.updatedAt = new Date();
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE public.employees SET is_deleted = true, status = 'INACTIVE',
         updated_by = COALESCE($2::uuid, updated_by), updated_at = clock_timestamp()
         WHERE id = $1::uuid`,
        [existing.id, updatedBy ?? null],
      );
      if (existing.userId)
        await manager.query(
          'UPDATE public.users SET status=\'DISABLED\',"updatedAt"=clock_timestamp() WHERE id=$1',
          [existing.userId],
        );
    });
    return true;
  }

  async updateEmployeeProfileImage(
    merchantId: string | undefined,
    idOrCode: string,
    profileImageUrl: string | null,
  ): Promise<EmployeeEntity | null> {
    const employee = await this.getEmployeeByIdOrCode(merchantId, idOrCode);
    if (!employee) return null;
    employee.profileImageUrl = profileImageUrl;
    employee.updatedAt = new Date();
    return this.employeeRepo.save(employee);
  }

  async listRolesAvailableForStore(
    storeId: string,
    merchantIdentifier?: string,
  ): Promise<Record<string, unknown>[]> {
    const stores = await this.dataSource.query(
      `SELECT s.store_code AS id,s.id AS "storeUuid",s.merchant_id AS "merchantUuid",
              s.merchant_id::text AS "merchantId",
              COALESCE(to_jsonb(s)->>'store_type_id',to_jsonb(s)->>'storeType') AS "storeTypeId"
       FROM public.stores s
       WHERE (s.store_code=$1 OR s.id::text=$1) LIMIT 1`,
      [storeId],
    );
    if (!stores[0]) throw new NotFoundException('Store not found');
    if (
      merchantIdentifier &&
      ![stores[0].merchantId, stores[0].merchantUuid].includes(
        merchantIdentifier,
      )
    ) {
      throw new NotFoundException('Store not found for merchant');
    }
    const merchantId = stores[0].merchantId;
    const storeTypeValue = stores[0].storeTypeId;
    if (!storeTypeValue)
      throw new BadRequestException('Store does not have a store type');
    const storeTypes = await this.dataSource.query(
      `SELECT st.id FROM public.store_types st
       WHERE st.id::text=$1 OR lower(COALESCE(to_jsonb(st)->>'store_type_code',to_jsonb(st)->>'storeTypeCode'))=lower($1) OR lower(st.name)=lower($1)
       LIMIT 1`,
      [String(storeTypeValue)],
    );
    if (!storeTypes[0])
      throw new BadRequestException(
        `Store type '${storeTypeValue}' is not configured`,
      );
    const storeTypeId = String(storeTypes[0].id);
    return this.dataSource.query(
      `SELECT rt.id AS "roleTemplateId",rt.role_code AS "roleCode",rt.name,rt.description,
              r.id AS "roleId",r.status AS "roleStatus",(r.id IS NOT NULL AND r.status='ACTIVE') AS assignable,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'permissionId',rp.permission_id,'permissionKey',p.permission_key,
                'name',p.name,'allowed',rp.allowed) ORDER BY p.name)
                FROM public.role_permissions rp
                JOIN public.permissions p ON p.id=rp.permission_id
                WHERE rp.role_id=r.id AND rp.merchant_id=$3::uuid
                  AND rp.store_id=$4::uuid),'[]'::jsonb) AS permissions
       FROM public.store_type_role_templates mapping
       JOIN public.role_templates rt ON rt.id=mapping.role_template_id AND rt.status='ACTIVE'
       LEFT JOIN public.roles r ON r.merchant_id::text=$1 AND r.source_role_template_id=rt.id
       WHERE mapping.store_type_id::text=$2
       ORDER BY rt.name`,
      [merchantId, storeTypeId, stores[0].merchantUuid, stores[0].storeUuid],
    );
  }

  private async nextEmployeeCode(
    manager: EntityManager,
    _merchantId: string,
  ): Promise<string> {
    // Codes are globally unique; keep the lock until the employee transaction commits.
    await manager.query('SELECT pg_advisory_xact_lock(724621, 43)');
    const [row] = await manager.query(
      `SELECT COALESCE(MAX(CASE WHEN employee_code ~ '^EMP-[0-9]+$' THEN substring(employee_code from 5)::numeric WHEN employee_code ~ '^[0-9]+$' THEN employee_code::numeric END), 0)::text AS last_code
       FROM public.employees WHERE employee_code ~ '^[0-9]+$' OR employee_code ~ '^EMP-[0-9]+$'`,
    );
    return `EMP-${(BigInt(row.last_code) + 1n).toString().padStart(5, '0')}`;
  }

  private hashEmployeePin(value: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    return `${salt}:${crypto.scryptSync(value, salt, 32).toString('hex')}`;
  }

  private async migrateEncryptedPinsToPlaintext(): Promise<void> {
    for (const table of ['employees', 'employee_stores']) {
      const columns = await this.dataSource.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
           AND column_name = 'login_pin_encrypted'`,
        [table],
      );
      if (!columns.length) continue;

      const encryptedRows = await this.dataSource.query(
        `SELECT id, login_pin_encrypted AS value FROM public.${table}
         WHERE login_pin_encrypted IS NOT NULL AND login_pin IS NULL`,
      );
      for (const row of encryptedRows) {
        const loginPin = this.decryptEmployeePin(String(row.value));
        await this.dataSource.query(
          `UPDATE public.${table} SET login_pin = $2 WHERE id = $1 AND login_pin IS NULL`,
          [row.id, loginPin],
        );
      }
      await this.dataSource.query(
        `ALTER TABLE public.${table} DROP COLUMN IF EXISTS login_pin_encrypted`,
      );
    }
  }

  private employeePinEncryptionKey(): Buffer {
    const keyValue = process.env.STORE_CONFIG_ENCRYPTION_KEY;
    const key = keyValue
      ? Buffer.from(keyValue, 'base64')
      : crypto.createHash('sha256').update(
          process.env.AUTH_JWT_SECRET || 'pdh-local-development-secret-change-me',
        ).digest();
    if (key.length !== 32)
      throw new InternalServerErrorException(
        'STORE_CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key',
      );
    return key;
  }

  private decryptEmployeePin(value: string): string {
    const [version, ivPart, ciphertextPart, tagPart] = value.split(':');
    if (version !== 'v1' || !ivPart || !ciphertextPart || !tagPart)
      throw new InternalServerErrorException('Stored employee PIN cannot be decrypted');
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.employeePinEncryptionKey(),
        Buffer.from(ivPart, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new InternalServerErrorException('Stored employee PIN cannot be decrypted');
    }
  }

  private returningRow<T>(result: T[] | [T[], number]): T {
    const rows =
      Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
    const row = (rows as T[])[0];
    if (!row || typeof row !== 'object')
      throw new InternalServerErrorException(
        'Database write did not return a row',
      );
    return row;
  }

  private matchesEmployeePin(pin: string, stored: string): boolean {
    const [salt, digest] = String(stored).split(':');
    if (!salt || !digest) return false;
    const actual = Buffer.from(
      crypto.scryptSync(pin, salt, 32).toString('hex'),
      'hex',
    );
    const expected = Buffer.from(digest, 'hex');
    return (
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected)
    );
  }

  private async updateEmployeeMasterPin(employeeId: string, loginPin: string) {
    await this.dataSource.query(
      `UPDATE public.employees
       SET login_pin = $2, login_pin_hash = $3, updated_at = now()
       WHERE id = $1::uuid`,
      [employeeId, loginPin, this.hashEmployeePin(loginPin)],
    );
  }

  private async assertUniqueStoreLoginPin(
    storeUuid: string,
    employeeId: string,
    pin: string,
  ) {
    const rows = await this.dataSource.query(
      `SELECT es.employee_id AS "employeeId",
              es.login_pin_hash AS hash,
              COALESCE(es.login_pin, e.login_pin) AS pin
       FROM public.employee_stores es
       JOIN public.employees e ON e.id = es.employee_id
       WHERE es.store_id = $1 AND es.employee_id <> $2::uuid
         AND (es.login_pin_hash IS NOT NULL OR es.login_pin IS NOT NULL OR e.login_pin IS NOT NULL)`,
      [storeUuid, employeeId],
    );
    for (const row of rows) {
      if (row.pin === pin || (row.hash && this.matchesEmployeePin(pin, row.hash))) {
        throw new ConflictException(
          'This login PIN is already assigned to another employee in this store',
        );
      }
    }
  }

  private hashUserPassword(value: string): string {
    const salt = crypto.randomBytes(16);
    return `${salt.toString('base64url')}:${crypto.scryptSync(value, salt, 64).toString('base64url')}`;
  }

  private async syncEmployeeAssignmentsWithManager(
    manager: EntityManager,
    merchantId: string,
    employeeId: string,
    assignments?: Array<{ store: string; roles?: string[]; loginPin?: string }>,
    defaultLoginPin?: string,
  ): Promise<void> {
    const merchants = await manager.query(
      'SELECT m.id,m.merchant_id AS "merchantCode" FROM public.merchants m WHERE m.merchant_id=$1 OR m.merchant_code=$1 OR m.id::text=$1 ORDER BY CASE WHEN m.id::text=$1 THEN 0 ELSE 1 END, m.created_at, m.id LIMIT 1',
      [merchantId],
    );
    if (!merchants[0]) throw new NotFoundException('Merchant not found');
    const merchantUuid = merchants[0].id;
    const merchantCode = merchants[0].merchantCode;
    const keepStoreIds: string[] = [];
    if (!assignments) return;
    for (const [index, assignment] of assignments.entries()) {
      const stores = await manager.query(
        `SELECT s.id,COALESCE(to_jsonb(s)->>'store_type_id',to_jsonb(s)->>'storeType') AS "storeType"
           FROM public.stores s
           WHERE s.merchant_id::text=$1
             AND (s.id::text=$2
               OR COALESCE(to_jsonb(s)->>'store_code',to_jsonb(s)->>'storeCode')=$2
               OR lower(COALESCE(to_jsonb(s)->>'store_name',to_jsonb(s)->>'storeName'))=lower($2))
           LIMIT 1`,
        [merchantUuid, assignment.store],
      );
      if (!stores[0])
        throw new BadRequestException(
          `Store '${assignment.store}' does not belong to this merchant`,
        );
      keepStoreIds.push(stores[0].id);
      const existing = await manager.query(
        `SELECT id,login_pin_hash AS "loginPinHash",
                login_pin AS "loginPin" FROM public.employee_stores
           WHERE merchant_id=$1::uuid AND employee_id=$2 AND store_id=$3::uuid LIMIT 1`,
        [merchantUuid, employeeId, stores[0].id],
      );
      const assignedPin = assignment.loginPin ?? defaultLoginPin;
      if (assignedPin)
        await this.assertUniqueStoreLoginPinWithManager(
          manager,
          stores[0].id,
          employeeId,
          assignedPin,
        );
      const pinHash = assignedPin
        ? this.hashEmployeePin(assignedPin)
        : existing[0]?.loginPinHash || null;
      const pinValue = assignedPin ?? existing[0]?.loginPin ?? null;
      if (assignedPin) {
        await manager.query(
          `UPDATE public.employees
           SET login_pin = $2, login_pin_hash = $3, updated_at = now()
           WHERE id = $1::uuid`,
          [employeeId, assignedPin, this.hashEmployeePin(assignedPin)],
        );
      }
      const upserted = existing[0]
        ? await manager.query(
            `UPDATE public.employee_stores
             SET is_primary=$2, login_pin_hash=$3, login_pin=$4, updated_at=now()
             WHERE id=$1 RETURNING id`,
            [existing[0].id, index === 0, pinHash, pinValue],
          )
        : await manager.query(
            `INSERT INTO public.employee_stores
               (merchant_id,employee_id,store_id,is_primary,login_pin_hash,login_pin)
             VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
            [merchantUuid, employeeId, stores[0].id, index === 0, pinHash, pinValue],
          );
      await manager.query(
        'DELETE FROM public.employee_store_roles WHERE merchant_id=$1::uuid AND employee_store_id=$2',
        [merchantUuid, upserted[0].id],
      );
      for (const role of assignment.roles || []) {
        const existingRole = await manager.query(
          `SELECT id FROM public.roles WHERE id=$1::uuid AND merchant_id=$2 AND status='ACTIVE' LIMIT 1`,
          [role, merchantCode],
        );
        if (!existingRole.length) {
          throw new BadRequestException(
            `Role '${role}' does not exist as an active role for this merchant`,
          );
        }
        const roles = await manager.query(
          `SELECT r.id FROM public.roles r
             JOIN public.store_type_role_templates mapping ON mapping.role_template_id=r.source_role_template_id
             JOIN public.store_types st ON st.id=mapping.store_type_id
             WHERE r.merchant_id=$1 AND r.id=$2::uuid AND r.status='ACTIVE'
               AND (st.id::text=$3 OR lower(COALESCE(to_jsonb(st)->>'store_type_code',to_jsonb(st)->>'storeTypeCode'))=lower($3)) LIMIT 1`,
          [merchantCode, role, String(stores[0].storeType)],
        );
        if (!roles[0])
          throw new BadRequestException(
            `Role '${role}' is not available for store '${assignment.store}' and its store type`,
          );
        await manager.query(
          `INSERT INTO public.employee_store_roles(merchant_id,store_id,employee_store_id,role_id) VALUES($1,$2,$3,$4)`,
          [merchantUuid, stores[0].id, upserted[0].id, roles[0].id],
        );
      }
    }
    if (keepStoreIds.length) {
      await manager.query(
        `DELETE FROM public.employee_store_roles WHERE merchant_id=$1::uuid AND employee_store_id IN
           (SELECT id FROM public.employee_stores WHERE merchant_id=$1::uuid AND employee_id=$2 AND store_id <> ALL($3::uuid[]))`,
        [merchantUuid, employeeId, keepStoreIds],
      );
      await manager.query(
        `DELETE FROM public.employee_stores WHERE merchant_id=$1::uuid AND employee_id=$2 AND store_id <> ALL($3::uuid[])`,
        [merchantUuid, employeeId, keepStoreIds],
      );
    }
  }

  private async syncEmployeePinToAssignmentsWithManager(
    manager: EntityManager,
    employeeId: string,
    loginPin: string | null,
  ): Promise<void> {
    const assignments = await manager.query(
      `SELECT id, store_id AS "storeId"
       FROM public.employee_stores
       WHERE employee_id = $1::uuid`,
      [employeeId],
    );
    for (const assignment of assignments) {
      if (loginPin) {
        await this.assertUniqueStoreLoginPinWithManager(
          manager,
          assignment.storeId,
          employeeId,
          loginPin,
        );
      }
      await manager.query(
        `UPDATE public.employee_stores
         SET login_pin = $2, login_pin_hash = $3, updated_at = now()
         WHERE id = $1::uuid`,
        [
          assignment.id,
          loginPin,
          loginPin ? this.hashEmployeePin(loginPin) : null,
        ],
      );
    }
  }

  private async assertUniqueStoreLoginPinWithManager(
    manager: EntityManager,
    storeId: string,
    employeeId: string,
    loginPin: string,
  ): Promise<void> {
    const rows = await manager.query(
      `SELECT es.login_pin_hash AS hash,
              COALESCE(es.login_pin, e.login_pin) AS pin
       FROM public.employee_stores es
       JOIN public.employees e ON e.id = es.employee_id
       WHERE es.store_id = $1::uuid AND es.employee_id <> $2::uuid
         AND (es.login_pin_hash IS NOT NULL OR es.login_pin IS NOT NULL OR e.login_pin IS NOT NULL)`,
      [storeId, employeeId],
    );
    if (rows.some((row: { hash: string | null; pin: string | null }) =>
      row.pin === loginPin || (row.hash && this.matchesEmployeePin(loginPin, row.hash)),
    )) {
      throw new ConflictException(
        'This login PIN is already assigned to another employee in this store',
      );
    }
  }
}
