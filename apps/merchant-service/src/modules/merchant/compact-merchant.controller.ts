import { EmployeeResponseInterceptor } from '../employee/workforce-validation.pipe';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { Public } from '@pinaka-delivery-hub/auth';
import { COUNTRIES, nationalPhone } from './countries';
import {
  MerchantCrudService,
  withPlanLicenseCounts,
} from './merchant-crud.service';
import { SubscriptionPlanChangeController } from '../master/plans/subscription-plan-change.controller';
import { MerchantRepository } from './merchant.repository';
import { FileStorageService } from '../file-storage/file-storage.service';

const fields = [
  'merchantName',
  'merchantEmail',
  'merchantPhoneNumber',
  'businessName',
  'businessDisplayName',
  'firstName',
  'lastName',
  'alternatePhone',
  'taxId',
  'storeTypeId',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'pinCode',
  'country',
  'planId',
  'billingCycle',
  'startDate',
  'renewalDate',
  'agreementPrice',
  'roleIds',
  'tax',
  'totalDueToday',
  'paymentMethod',
  'autoRenew',
  'createdBy',
] as const;
const required = [
  'merchantName',
  'merchantEmail',
  'merchantPhoneNumber',
  'businessName',
  'businessDisplayName',
  'addressLine1',
  'city',
  'state',
  'pinCode',
  'country',
  'planId',
  'billingCycle',
  'startDate',
  'renewalDate',
  'agreementPrice',
] as const;
const removed = [
  'initialStatus',
  'roleIds',
  'merchantCode',
  'merchantId',
] as const;
type Input = Record<string, unknown>;
type ActorRequest = { user?: { id?: string } };
const actorUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorId(input: Input, sessionUserId?: string): string | null {
  const raw = input.createdBy ?? input.created_by ?? sessionUserId;
  if (raw == null || raw === '') return null;
  const value = String(raw).trim();
  if (!actorUuid.test(value))
    throw new BadRequestException('createdBy must be a UUID');
  return value;
}

@Controller(['api/v1/merchants', 'connector/api/v1/merchants', 'merchants'])
export class CompactMerchantController {
  constructor(
    @Inject(MerchantRepository) private readonly repository: MerchantRepository,
    @Inject(FileStorageService) private readonly files: FileStorageService,
  ) {}

  private get db() {
    return this.repository.requireDataSource();
  }

  private validate(input: Input, create: boolean): Input {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Provide a merchant object');
    if (input.ein !== undefined) {
      if (input.taxId !== undefined && input.taxId !== input.ein)
        throw new BadRequestException('Supply either ein or taxId, not conflicting values');
      input.taxId = input.ein;
      delete input.ein;
    }
    if (input.legalBusinessName !== undefined) {
      if (
        input.businessName !== undefined &&
        input.businessName !== input.legalBusinessName
      )
        throw new BadRequestException(
          'Supply either legalBusinessName or businessName, not conflicting values',
        );
      input.businessName = input.legalBusinessName;
      delete input.legalBusinessName;
    }
    delete input.storeTypeId;
    const allowed = new Set<string>(fields);
    const blocked = removed.filter((key) =>
      Object.prototype.hasOwnProperty.call(input, key),
    );
    if (blocked.length)
      throw new BadRequestException(
        `Remove these fields: ${blocked.join(', ')}`,
      );
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length)
      throw new BadRequestException(`Unknown fields: ${unknown.join(', ')}`);
    if (create) {
      const missing = required.filter(
        (key) =>
          input[key] === undefined || input[key] === null || input[key] === '',
      );
      if (missing.length)
        throw new BadRequestException(
          `Missing required fields: ${missing.join(', ')}`,
        );
    }
    if (
      input.merchantEmail !== undefined &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.merchantEmail))
    )
      throw new BadRequestException('Invalid merchantEmail');
    for (const key of ['startDate', 'renewalDate'])
      if (input[key] !== undefined) {
        const value = String(input[key]);
        const date = new Date(`${value}T00:00:00Z`);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(date.getTime()) ||
          date.toISOString().slice(0, 10) !== value
        )
          throw new BadRequestException(
            `${key} must be a valid YYYY-MM-DD date`,
          );
      }
    if (
      input.startDate &&
      input.renewalDate &&
      String(input.renewalDate) <= String(input.startDate)
    )
      throw new BadRequestException('renewalDate must be after startDate');
    for (const key of ['agreementPrice', 'tax', 'totalDueToday'])
      if (
        input[key] !== undefined &&
        (input[key] === null ||
          !Number.isFinite(Number(input[key])) ||
          Number(input[key]) < 0)
      )
        throw new BadRequestException(`${key} must be a non-negative number`);
    if (
      input.billingCycle !== undefined &&
      !['MONTHLY', 'QUARTERLY', 'ANNUAL'].includes(String(input.billingCycle))
    )
      throw new BadRequestException('Invalid billingCycle');
    for (const key of required)
      if (
        key !== 'planId' &&
        key !== 'agreementPrice' &&
        key !== 'startDate' &&
        key !== 'renewalDate' &&
        input[key] !== undefined &&
        (typeof input[key] !== 'string' || !String(input[key]).trim())
      )
        throw new BadRequestException(`${key} must be a non-empty string`);
    return input;
  }

  private async getRecord(id: string) {
    try {
      const rows = await this.db.query(
        `SELECT row_to_json(m) AS merchant, row_to_json(mp) AS plan, row_to_json(s) AS subscription,
                (SELECT COUNT(*)::int FROM public.stores store
                 WHERE store.merchant_id = m.id
                   AND COALESCE(store.is_deleted, false) = false) AS store_count
         FROM public.merchants m
         LEFT JOIN LATERAL (
           SELECT sub.*, row_to_json(sp) AS plan
           FROM public.subscriptions sub
           LEFT JOIN public.plans sp
             ON sp.id::text = COALESCE(to_jsonb(sub)->>'plan_id', to_jsonb(sub)->>'planId')
           WHERE COALESCE(to_jsonb(sub)->>'merchantId', to_jsonb(sub)->>'merchant_id')
                   IN (
                     COALESCE(to_jsonb(m)->>'merchantId', to_jsonb(m)->>'merchantCode', m.id::text),
                     m.id::text
                   )
             AND COALESCE(to_jsonb(sub)->>'status', 'ACTIVE') = 'ACTIVE'
           ORDER BY COALESCE(
             (to_jsonb(sub)->>'created_at')::timestamptz,
             (to_jsonb(sub)->>'createdAt')::timestamptz,
             now()
           ) DESC
           LIMIT 1
         ) s ON true
         LEFT JOIN public.plans mp
           ON mp.id::text = COALESCE(to_jsonb(m)->>'planId', to_jsonb(m)->>'plan_id')
         WHERE (
             COALESCE(to_jsonb(m)->>'merchantId', to_jsonb(m)->>'merchantCode', m.id::text) = $1
             OR m.id::text = $1
           )
           `,
        [id],
      );
      if (rows.length) return this.showMerchantCode(rows[0]);
    } catch (error: unknown) {
      console.error(
        '[CompactMerchantController.getRecord]',
        error instanceof Error ? error.message : String(error),
      );
    }
    const [row] = await this.db.query(
      `SELECT row_to_json(m) AS merchant FROM public.merchants m
       WHERE COALESCE(to_jsonb(m)->>'merchantId', to_jsonb(m)->>'merchantCode', m.id::text) = $1
          OR m.id::text = $1
       LIMIT 1`,
      [id],
    );
    if (!row) throw new NotFoundException('Merchant not found');
    return this.showMerchantCode(row);
  }

  private dateOnly(value: unknown) {
    if (value == null || value === '') return null;
    if (typeof value === 'string') return value.slice(0, 10);
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      const month = String(value.getMonth() + 1).padStart(2, '0');
      const day = String(value.getDate()).padStart(2, '0');
      return `${value.getFullYear()}-${month}-${day}`;
    }
    return value;
  }

  private merchantCodeValue(row: Input) {
    return (
      [row?.merchantId, row?.merchantCode, row?.merchant_code].find((value) =>
        /^MER-\d+$/i.test(String(value || '')),
      ) || null
    );
  }

  private showMerchantCode<T extends Input>(record: T): T {
    // Keep the assigned-store count as an explicit part of the merchant API
    // contract. PostgreSQL returns the COUNT alias as `store_count`, while
    // other query paths/drivers may expose the camelCase equivalent.
    const rawStoreCount = record?.store_count ?? record?.storeCount;
    const numericStoreCount = Number(rawStoreCount);
    (record as Input).store_count = Number.isFinite(numericStoreCount)
      ? numericStoreCount
      : 0;

    const merchant = record?.merchant;
    if (merchant && typeof merchant === 'object' && !Array.isArray(merchant)) {
      const code = this.merchantCodeValue(merchant as Input);
      if (code) (merchant as Input).merchant_code = code;
      const values = merchant as Input;
      if (values.ein == null) values.ein = values.taxId ?? values.tax_id ?? null;
    }
    const subscription = record?.subscription;
    if (
      subscription &&
      typeof subscription === 'object' &&
      !Array.isArray(subscription)
    ) {
      const nested = subscription as Input;
      const plan = (
        nested.plan && typeof nested.plan === 'object'
          ? nested.plan
          : record?.plan
      ) as Input | undefined;
      withPlanLicenseCounts(nested, plan);
    }
    return record;
  }

  private present(row: Input) {
    const merchant: Input = {
      id: row.id,
      merchant_code: this.merchantCodeValue(row),
      merchantId: row.merchantId || null,
      status: row.status || 'ACTIVE',
      createdAt: row.createdAt || row.createdDate || row.created_at || null,
    };
    for (const key of fields) {
      let value =
        row[key] ??
        (key === 'merchantEmail' ? row.email : undefined) ??
        (key === 'merchantPhoneNumber' ? row.phone : undefined) ??
        (key === 'pinCode' ? row.postalCode : undefined);
      if (key === 'startDate' || key === 'renewalDate')
        value = this.dateOnly(value);
      merchant[key] =
        key === 'agreementPrice' || key === 'tax' || key === 'totalDueToday'
          ? value == null || value === ''
            ? null
            : Number(value)
          : (value ?? null);
    }
    return merchant;
  }

  protected async nextMerchantId(manager: {
    query: (sql: string, params?: unknown[]) => Promise<any[]>;
  }) {
    await manager.query(`SELECT pg_advisory_xact_lock(842001)`);
    const numbered = await manager.query(
      `SELECT "merchantId" AS code FROM public.merchants WHERE "merchantId" ~ '^MER-[0-9]+$'`,
    );
    let max = 0;
    for (const row of numbered) {
      const value = Number(String(row.code).slice(4));
      if (Number.isFinite(value) && value > max) max = value;
    }
    const pending = await manager.query(
      `SELECT id::text AS id FROM public.merchants
       WHERE COALESCE("merchantId", '') !~ '^MER-[0-9]+$'
       ORDER BY COALESCE((to_jsonb(merchants)->>'createdDate')::timestamptz, (to_jsonb(merchants)->>'created_at')::timestamptz, (to_jsonb(merchants)->>'createdAt')::timestamptz, now()), id`,
    );
    for (const row of pending) {
      max += 1;
      const code = `MER-${String(max).padStart(4, '0')}`;
      await manager.query(
        `UPDATE public.merchants SET "merchantId"=$1, "merchantCode"=CASE WHEN "merchantCode" IS NULL OR "merchantCode" !~ '^MER-[0-9]+$' THEN $1 ELSE "merchantCode" END WHERE id::text=$2`,
        [code, row.id],
      );
    }
    max += 1;
    return `MER-${String(max).padStart(4, '0')}`;
  }

  @Post('create-merchant')
  async createFromOnboarding(
    @Body() body: Record<string, any>,
    @Req() request: ActorRequest,
  ) {
    const merchant =
      body?.merchant && typeof body.merchant === 'object' ? body.merchant : {};
    const subscription =
      body?.subscription && typeof body.subscription === 'object'
        ? body.subscription
        : {};
    const flat: Input = { ...body };
    delete flat.merchant;
    delete flat.subscription;
    delete flat.stores;
    delete flat.planDetails;
    const mapped: Input = {
      ...flat,
      merchantName: flat.merchantName ?? merchant.merchantName ?? merchant.name,
      merchantEmail:
        flat.merchantEmail ?? merchant.merchantEmail ?? merchant.email,
      merchantPhoneNumber:
        flat.merchantPhoneNumber ??
        merchant.merchantPhoneNumber ??
        merchant.phone,
      businessName:
        flat.businessName ?? merchant.businessName ?? merchant.business,
      businessDisplayName:
        flat.businessDisplayName ??
        merchant.businessDisplayName ??
        merchant.display,
      addressLine1: flat.addressLine1 ?? merchant.addressLine1,
      addressLine2: flat.addressLine2 ?? merchant.addressLine2,
      city: flat.city ?? merchant.city,
      state: flat.state ?? merchant.state,
      pinCode: flat.pinCode ?? merchant.pinCode ?? merchant.postal,
      country: flat.country ?? merchant.country,
      planId: flat.planId ?? subscription.planId,
      storeTypeId:
        flat.storeTypeId ?? merchant.storeTypeId ?? subscription.storeTypeId,
      billingCycle: flat.billingCycle ?? subscription.billingCycle,
      startDate: flat.startDate ?? subscription.startDate,
      renewalDate: flat.renewalDate ?? subscription.renewalDate,
      agreementPrice: flat.agreementPrice ?? subscription.agreementPrice,
      tax: flat.tax ?? merchant.tax,
      totalDueToday: flat.totalDueToday ?? merchant.totalDueToday,
      paymentMethod: flat.paymentMethod ?? merchant.paymentMethod,
    };
    for (const key of Object.keys(mapped))
      if (mapped[key] === undefined) delete mapped[key];
    return this.create(mapped, request);
  }

  @Post()
  async create(@Body() body: Input, @Req() request?: ActorRequest) {
    const requestedStoreTypeId = storeTypeIdFromPlan(body);
    const input = this.validate(body, true);
    const createdBy = actorId(input, request?.user?.id);
    let savedId = '';
    try {
      await this.db.transaction(async (manager) => {
        const merchantColsResult = await manager.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='merchants'`,
        );
        const availMerchantCols = new Set(
          merchantColsResult.map((r: any) => r.column_name),
        );
        const merchantData: Record<string, any> = {};
        const setCol = (col: string, val: any) => {
          if (availMerchantCols.has(col)) merchantData[col] = val;
        };
        const rowId = randomUUID();
        savedId = rowId;
        const merchantKey = `MCH-${rowId.slice(0, 8).toUpperCase()}`;
        const merchantBusinessId = `MID-${rowId.slice(0, 8).toUpperCase()}`;
        setCol('id', rowId);
        setCol('merchant_code', merchantKey);
        setCol('merchantCode', merchantKey);
        setCol('merchant_id', merchantBusinessId);
        setCol('merchantId', merchantBusinessId);
        setCol('businessName', input.businessName);
        const nameParts = String(input.merchantName || '')
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const firstName = String(input.firstName || nameParts[0] || '').trim();
        const lastName = String(
          input.lastName || nameParts.slice(1).join(' ') || '',
        ).trim();
        setCol(
          'business_display_name',
          input.businessDisplayName || input.businessName,
        );
        setCol(
          'businessDisplayName',
          input.businessDisplayName || input.businessName,
        );
        setCol('first_name', firstName || null);
        setCol('last_name', lastName || null);
        setCol(
          'alternate_phone',
          input.alternatePhone ? String(input.alternatePhone) : null,
        );
        setCol('tax_id', input.taxId ? String(input.taxId) : null);
        setCol('onboarding_step', 'COMPLETED');
        setCol('is_deleted', false);
        setCol('address_line1', input.addressLine1);
        setCol('address_line2', input.addressLine2 ?? null);
        setCol('postal_code', input.pinCode);
        setCol('legalBusinessName', input.businessName);
        setCol('merchantName', input.merchantName);
        setCol('ownerName', input.merchantName);
        setCol('name', input.merchantName);
        setCol('merchantEmail', input.merchantEmail);
        setCol('email', input.merchantEmail);
        setCol('merchantPhoneNumber', input.merchantPhoneNumber);
        setCol('phone', input.merchantPhoneNumber);
        setCol('addressLine1', input.addressLine1);
        setCol('addressLine2', input.addressLine2 ?? null);
        setCol('businessAddress', input.addressLine1);
        setCol('city', input.city);
        setCol('state', input.state);
        setCol('pinCode', input.pinCode);
        setCol('postalCode', input.pinCode);
        setCol('country', input.country);
        setCol('planId', input.planId);
        setCol('storeTypeId', requestedStoreTypeId);
        setCol('billingCycle', input.billingCycle);
        setCol('startDate', input.startDate);
        setCol('renewalDate', input.renewalDate);
        setCol('agreementPrice', input.agreementPrice);
        setCol('tax', input.tax);
        setCol('totalDueToday', input.totalDueToday);
        setCol('paymentMethod', input.paymentMethod);
        setCol('roleIds', JSON.stringify(input.roleIds || []));
        setCol('status', 'ACTIVE');
        if (createdBy) {
          setCol('created_by', createdBy);

          setCol('createdBy', createdBy);

        }
        setCol('createdDate', new Date());
        setCol('updatedDate', null);
        setCol('updatedAt', null);
        setCol('updated_by', null);
        setCol('updatedBy', null);
        setCol('created_at', new Date());
        setCol('updated_at', null);
        if (availMerchantCols.has('merchantCode') && !merchantData.merchantCode)
          setCol('merchantCode', rowId);

        const mCols = Object.keys(merchantData);
        const mPlaceholders = mCols.map((_, i) => `$${i + 1}`).join(',');
        const mColList = mCols.map((c) => `"${c}"`).join(',');
        const inserted = await manager.query(
          `INSERT INTO public.merchants (${mColList}) VALUES (${mPlaceholders}) RETURNING *`,
          Object.values(merchantData),
        );
        savedId = String(inserted[0]?.id || inserted[0]?.merchantId || rowId);

        const subColsResult = await manager.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='subscriptions'`,
        );
        const availSubCols = new Set(
          subColsResult.map((r: any) => r.column_name),
        );

        const subId = `SUB-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const subData: Record<string, any> = {};
        const setSubCol = (col: string, val: any) => {
          if (availSubCols.has(col)) subData[col] = val;
        };

        const storeTypeName = await storeTypeNameForPlan(
          manager,
          String(input.planId),
        );
        const [plan] = await manager.query(
          `SELECT * FROM public.plans WHERE id::text=$1`,
          [String(input.planId)],
        );
        const planName =
          plan?.name || plan?.planName || plan?.plan_name || 'Plan';
        const entitlements = JSON.stringify(
          plan?.included_features ||
            plan?.includedFeatures ||
            plan?.entitlements ||
            [],
        );
        setSubCol('id', subId);
        setSubCol('subscription_code', subId);
        setSubCol('merchant_id', rowId);
        setSubCol('plan_id', input.planId);
        setSubCol('billing_cycle', input.billingCycle);
        setSubCol('start_date', input.startDate);
        setSubCol('renewal_date', input.renewalDate);
        setSubCol('price', input.agreementPrice ?? 0);
        setSubCol('auto_renew', input.autoRenew !== false);
        setSubCol('is_deleted', false);
        if (createdBy) {
          setSubCol('created_by', createdBy);
          setSubCol('updated_by', createdBy);
        }
        setSubCol('status', 'ACTIVE');
        setSubCol('created_at', new Date());
        setSubCol('updated_at', new Date());

        const sCols = Object.keys(subData);
        const sPlaceholders = sCols.map((_, i) => `$${i + 1}`).join(',');
        const sColList = sCols.map((c) => `"${c}"`).join(',');
        await manager.query(
          `INSERT INTO public.subscriptions (${sColList}) VALUES (${sPlaceholders})`,
          Object.values(subData),
        );
      });
    } catch (error: any) {
      if ((error.driverError?.code || error.code) === '23505') {
        const constraint = error.driverError?.constraint || error.constraint;
        if (
          constraint === 'uq_merchants_merchant_email' ||
          constraint === 'merchants_one_active_email_uq'
        )
          throw new ConflictException('Merchant email already exists');
        if (
          constraint === 'PK_4fd312ef25f8e05ad47bfe7ed25' ||
          constraint === 'merchants_pkey'
        )
          throw new ConflictException('Merchant ID already exists');
        throw new ConflictException(
          'Merchant conflicts with an existing record',
        );
      }
      throw error;
    }
    await this.files.ensureMerchantFolder(
      String(
        input.businessDisplayName ||
          input.businessName ||
          input.merchantName ||
          'merchant',
      ),
    );
    return { success: true, ...(await this.getRecord(savedId)) };
  }

  @Get()
  async list() {
    try {
      const rows = await this.db.query(
        `SELECT row_to_json(m) AS merchant, row_to_json(mp) AS plan, row_to_json(s) AS subscription,
                (SELECT COUNT(*)::int FROM public.stores store
                 WHERE store.merchant_id = m.id
                   AND COALESCE(store.is_deleted, false) = false) AS store_count
         FROM public.merchants m
         LEFT JOIN LATERAL (
           SELECT sub.*, row_to_json(sp) AS plan
           FROM public.subscriptions sub
           LEFT JOIN public.plans sp
             ON sp.id::text = COALESCE(to_jsonb(sub)->>'plan_id', to_jsonb(sub)->>'planId')
           WHERE COALESCE(to_jsonb(sub)->>'merchantId', to_jsonb(sub)->>'merchant_id')
                   IN (
                     COALESCE(to_jsonb(m)->>'merchantId', to_jsonb(m)->>'merchantCode', m.id::text),
                     m.id::text
                   )
             AND COALESCE(to_jsonb(sub)->>'status', 'ACTIVE') = 'ACTIVE'
           ORDER BY COALESCE(
             (to_jsonb(sub)->>'created_at')::timestamptz,
             (to_jsonb(sub)->>'createdAt')::timestamptz,
             now()
           ) DESC
           LIMIT 1
         ) s ON true
         LEFT JOIN public.plans mp
           ON mp.id::text = COALESCE(to_jsonb(m)->>'planId', to_jsonb(m)->>'plan_id')
         ORDER BY COALESCE(
           (to_jsonb(m)->>'createdDate')::timestamptz,
           (to_jsonb(m)->>'created_at')::timestamptz,
           (to_jsonb(m)->>'createdAt')::timestamptz,
           now()
         ) DESC`,
      );
      return {
        success: true,
        count: rows.length,
        merchants: rows.map((row: Input) => this.showMerchantCode(row)),
      };
    } catch (error: unknown) {
      console.error(
        '[CompactMerchantController.list]',
        error instanceof Error ? error.message : String(error),
      );
      try {
        const rows = await this.db.query(
          `SELECT row_to_json(m) AS merchant,
                  (SELECT COUNT(*)::int FROM public.stores store
                   WHERE store.merchant_id = m.id
                     AND COALESCE(store.is_deleted, false) = false) AS store_count
           FROM public.merchants m
           ORDER BY COALESCE(
             (to_jsonb(m)->>'createdDate')::timestamptz,
             (to_jsonb(m)->>'created_at')::timestamptz,
             (to_jsonb(m)->>'createdAt')::timestamptz,
             now()
           ) DESC`,
        );
        return {
          success: true,
          count: rows.length,
          merchants: rows.map((row: Input) => this.showMerchantCode(row)),
        };
      } catch (fallbackError: unknown) {
        console.error(
          '[CompactMerchantController.list.fallback]',
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError),
        );
        const rows = await this.db.query(
          `SELECT row_to_json(m) AS merchant,
                  (SELECT COUNT(*)::int FROM public.stores store
                   WHERE store.merchant_id = m.id
                     AND COALESCE(store.is_deleted, false) = false) AS store_count
           FROM public.merchants m`,
        );
        return {
          success: true,
          count: rows.length,
          merchants: rows.map((row: Input) => this.showMerchantCode(row)),
        };
      }
    }
  }

  @Public()
  @Get('countries')
  countries() {
    return { success: true, count: COUNTRIES.length, countries: COUNTRIES };
  }

  @Get('subscriptions')
  subscriptions(
    @Query('merchantId') merchantId?: string,
    @Query('status') status?: string,
  ) {
    return new MerchantCrudService(this.db).listSubscriptions(
      merchantId,
      status?.trim() || undefined,
    );
  }

  @Get('subscriptions/active')
  activeSubscriptions(@Query('merchantId') merchantId?: string) {
    return new MerchantCrudService(this.db).listSubscriptions(
      merchantId,
      'ACTIVE',
    );
  }

  @Get('subscriptions/:subscriptionId')
  subscription(@Param('subscriptionId') subscriptionId: string) {
    return new MerchantCrudService(this.db).getSubscription(subscriptionId);
  }

  @Post('subscriptions/subscription-plan-changes')
  subscriptionPlanChange(@Body() body: Input) {
    const merchantId = String(body.merchantId || '').trim();
    if (!merchantId) throw new BadRequestException('merchantId is required');
    const billingCycle = String(body.billingCycle || 'MONTHLY').toUpperCase() === 'YEARLY'
      ? 'ANNUAL'
      : body.billingCycle;
    const changes: Input = { ...body, billingCycle };
    delete changes.merchantId;
    return this.update(merchantId, changes, false);
  }

  @Get(':id/store-types')
  async storeTypes(@Param('id') id: string) {
    const [merchant] = await this.db.query(
      `SELECT m.id::text AS id FROM public.merchants m
       WHERE m.id::text = $1 OR m."merchantId" = $1 OR m."merchantCode" = $1
       ORDER BY m."createdAt" ASC NULLS LAST, m.id
       LIMIT 1`,
      [id],
    );
    if (!merchant) throw new NotFoundException('Merchant not found');

    const storeTypes = await this.db.query(
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
      [merchant.id],
    );
    return { success: true, count: storeTypes.length, storeTypes };
  }

  // Register the reserved employees path before the merchant identifier route.
  @Get('employees')
  @UseInterceptors(EmployeeResponseInterceptor)
  async listEmployees(@Query('status') status?: string) {
    const employees = await this.repository.listEmployees(undefined, status);
    const statistics = await this.repository.employeeStatistics(undefined);
    return { success: true, count: employees.length, statistics, employees };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const record = await this.getRecord(id);
    const merchant = record.merchant;
    if (merchant && typeof merchant === 'object') {
      merchant.phone = nationalPhone(merchant.phone, merchant.country);
      merchant.merchantPhoneNumber = nationalPhone(
        merchant.merchantPhoneNumber ?? merchant.phone,
        merchant.country,
      );
    }
    return { success: true, ...record };
  }

  @Get(':id/history')
  async history(@Param('id') id: string) {
    const current = await this.getRecord(id);
    const rows = await this.db.query(
      `SELECT * FROM public.merchants WHERE id::text=$1 OR "merchantId"=$1 OR "merchantCode"=$1`,
      [id],
    );
    return {
      success: true,
      merchant: current.merchant,
      subscription: current.subscription,
      subscriptions: current.merchant.subscriptions || [],
      paymentHistory: current.merchant.paymentHistory || [],
      count: rows.length,
      merchants: rows.map((row: Input) => this.present(row)),
    };
  }

  @Put(':id')
  async replace(
    @Param('id') id: string,
    @Body() body: Input,
    @Req() request: ActorRequest,
  ) {
    return this.update(id, body, true, request);
  }

  @Patch(':id')
  async patch(
    @Param('id') id: string,
    @Body() body: Input,
    @Req() request: ActorRequest,
  ) {
    return this.update(id, body, false, request);
  }

  private async update(
    id: string,
    body: Input,
    replace: boolean,
    request?: ActorRequest,
  ) {
    const requestedStoreTypeId = storeTypeIdFromPlan(body);
    const input = this.validate(body, false);
    const createdBy = actorId(input, request?.user?.id);
    if (createdBy) input.createdBy = createdBy;
    if (!Object.keys(input).length)
      throw new BadRequestException('Provide at least one field');
    if (replace) {
      const missing = required.filter((key) => input[key] === undefined);
      if (missing.length)
        throw new BadRequestException(
          `Missing required fields: ${missing.join(', ')}`,
        );
    }
    try {
      await this.db.transaction(async (manager) => {
        const [existing] = await manager.query(
          `SELECT * FROM public.merchants m
         WHERE (COALESCE(to_jsonb(m)->>'merchantId', to_jsonb(m)->>'merchantCode', m.id::text) = $1 OR m.id::text = $1)
           AND COALESCE(to_jsonb(m)->>'status', 'ACTIVE') = 'ACTIVE'
         FOR UPDATE`,
          [id],
        );
        if (!existing) throw new NotFoundException('Merchant not found');

        const merchantColsResult = await manager.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='merchants'`,
        );
        const availMerchantCols = new Set(
          merchantColsResult.map((r: any) => r.column_name),
        );
        const assignments: string[] = [];
        const values: unknown[] = [];
        const setCol = (col: string, val: unknown) => {
          if (!availMerchantCols.has(col)) return;
          values.push(val);
          assignments.push(`"${col}" = $${values.length}`);
        };

        setCol('businessName', input.businessName ?? existing.businessName);
        setCol(
          'businessDisplayName',
          input.businessDisplayName ?? existing.businessDisplayName,
        );
        setCol(
          'legalBusinessName',
          input.businessName ??
            existing.legalBusinessName ??
            existing.businessName,
        );
        setCol('merchantName', input.merchantName ?? existing.merchantName);
        setCol(
          'ownerName',
          input.merchantName ?? existing.ownerName ?? existing.merchantName,
        );
        setCol(
          'merchantEmail',
          input.merchantEmail ?? existing.merchantEmail ?? existing.email,
        );
        setCol(
          'email',
          input.merchantEmail ?? existing.email ?? existing.merchantEmail,
        );
        setCol('first_name', input.firstName ?? existing.first_name);
        setCol('last_name', input.lastName ?? existing.last_name);
        setCol(
          'alternate_phone',
          input.alternatePhone !== undefined
            ? input.alternatePhone
              ? String(input.alternatePhone)
              : null
            : existing.alternate_phone,
        );
        setCol(
          'tax_id',
          input.taxId !== undefined
            ? input.taxId
              ? String(input.taxId)
              : null
            : existing.tax_id,
        );
        setCol(
          'business_display_name',
          input.businessDisplayName ??
            existing.business_display_name ??
            existing.businessDisplayName,
        );
        setCol(
          'address_line1',
          input.addressLine1 ?? existing.address_line1 ?? existing.addressLine1,
        );
        setCol(
          'address_line2',
          input.addressLine2 ?? existing.address_line2 ?? existing.addressLine2,
        );
        setCol(
          'postal_code',
          input.pinCode ?? existing.postal_code ?? existing.pinCode,
        );
        setCol(
          'merchantPhoneNumber',
          input.merchantPhoneNumber ??
            existing.merchantPhoneNumber ??
            existing.phone,
        );
        setCol(
          'phone',
          input.merchantPhoneNumber ??
            existing.phone ??
            existing.merchantPhoneNumber,
        );
        setCol('addressLine1', input.addressLine1 ?? existing.addressLine1);
        setCol('addressLine2', input.addressLine2 ?? existing.addressLine2);
        setCol(
          'businessAddress',
          [
            input.addressLine1 ?? existing.addressLine1,
            input.addressLine2 ?? existing.addressLine2,
          ]
            .filter(Boolean)
            .join(', ') || existing.businessAddress,
        );
        setCol('city', input.city ?? existing.city);
        setCol('state', input.state ?? existing.state);
        setCol('pinCode', input.pinCode ?? existing.pinCode);
        setCol(
          'postalCode',
          input.pinCode ?? existing.postalCode ?? existing.pinCode,
        );
        setCol('country', input.country ?? existing.country);
        if (input.planId !== undefined) {
          const currentPlanId =
            existing.planId ||
            (await this.repository.merchantActivePlanId(
              String(existing.merchantId || existing.id || id),
            ));
          await this.repository.assertSameStoreTypePlan(
            currentPlanId,
            String(input.planId),
          );
        }
        setCol('planId', input.planId ?? existing.planId);
        if (requestedStoreTypeId) setCol('storeTypeId', requestedStoreTypeId);
        setCol('billingCycle', input.billingCycle ?? existing.billingCycle);
        setCol('startDate', input.startDate ?? existing.startDate);
        setCol('renewalDate', input.renewalDate ?? existing.renewalDate);
        setCol(
          'agreementPrice',
          input.agreementPrice ?? existing.agreementPrice,
        );
        setCol('tax', input.tax ?? existing.tax);
        setCol('totalDueToday', input.totalDueToday ?? existing.totalDueToday);
        setCol('paymentMethod', input.paymentMethod ?? existing.paymentMethod);
        setCol('status', 'ACTIVE');
        if (createdBy) {
          setCol('updated_by', createdBy);
          setCol('updatedBy', createdBy);
          if (!existing.created_by && !existing.createdBy) {
            setCol('created_by', createdBy);
            setCol('createdBy', createdBy);
          }
        }
        setCol('updatedDate', new Date());
        setCol('updatedAt', new Date());
        setCol('updated_at', new Date());
        if (!assignments.length)
          throw new BadRequestException(
            'No merchant columns available to update',
          );
        values.push(existing.id);
        await manager.query(
          `UPDATE public.merchants SET ${assignments.join(', ')} WHERE id = $${values.length}`,
          values,
        );
        if (input.planId !== undefined) {
          if (requestedStoreTypeId) input.storeTypeId = requestedStoreTypeId;
          await this.saveSubscription(
            manager,
            String(existing.id),
            input,
          );
        }
      });
    } catch (error: any) {
      if ((error.driverError?.code || error.code) === '23505')
        throw new ConflictException('Merchant email already exists');
      throw error;
    }
    return { success: true, ...(await this.getRecord(id)) };
  }

  protected async saveSubscriptionVersion(
    manager: { query: (sql: string, params?: unknown[]) => Promise<any[]> },
    id: string,
    existing: Input,
    input: Input,
    planId: string,
  ) {
    const merchantKeys = [
      ...new Set(
        [
          id,
          existing.id,
          existing.merchantId,
          existing.merchantCode,
          existing.merchant_code,
        ]
          .filter((value) => value != null && value !== '')
          .map(String),
      ),
    ];
    const [current] = await manager.query(
      `SELECT * FROM public.subscriptions s
       WHERE (
         COALESCE(to_jsonb(s)->>'merchantId', '') = ANY($1::text[])
         OR COALESCE(to_jsonb(s)->>'merchant_id', '') = ANY($1::text[])
       )
         AND COALESCE(to_jsonb(s)->>'status', 'ACTIVE') = 'ACTIVE'
       ORDER BY COALESCE((to_jsonb(s)->>'created_at')::timestamptz, (to_jsonb(s)->>'createdAt')::timestamptz, now()) DESC
       LIMIT 1`,
      [merchantKeys],
    );
    const nextCycle = String(
      input.billingCycle ??
        existing.billingCycle ??
        current?.billingCycle ??
        current?.billing_cycle ??
        '',
    );
    const nextStart = String(
      input.startDate ?? this.dateOnly(existing.startDate) ?? '',
    );
    const nextRenewal = String(
      input.renewalDate ?? this.dateOnly(existing.renewalDate) ?? '',
    );
    const nextPrice = Number(
      input.agreementPrice ?? existing.agreementPrice ?? current?.price ?? 0,
    );
    const unchanged =
      current &&
      String(current.planId || current.plan_id || '') === planId &&
      String(current.billingCycle || current.billing_cycle || '') ===
        nextCycle &&
      String(this.dateOnly(current.startDate || current.start_date) || '') ===
        nextStart &&
      String(
        this.dateOnly(current.renewalDate || current.renewal_date) || '',
      ) === nextRenewal &&
      Number(current.price ?? current.agreementPrice ?? 0) === nextPrice;
    if (unchanged) return;

    const [plan] = await manager.query(
      `SELECT * FROM public.plans WHERE id::text=$1`,
      [planId],
    );
    if (!plan) throw new BadRequestException('Select an active planId');
    const subCols = new Set(
      (
        await manager.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='subscriptions'`,
        )
      ).map((row: { column_name: string }) => row.column_name),
    );
    const merchantKey = String(
      current?.merchantId ||
        current?.merchant_id ||
        existing.merchantId ||
        existing.merchant_code ||
        id,
    );
    const planName = plan.name || plan.planName || plan.plan_name || 'Plan';
    const storeTypeName = await storeTypeNameForPlan(manager, planId);
    const subData: Record<string, unknown> = {};
    const setSubCol = (col: string, val: unknown) => {
      if (subCols.has(col)) subData[col] = val;
    };
    if (!current?.id) {
      const subId = `SUB-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      setSubCol('id', subId);
      setSubCol('subscriptionId', subId);
      setSubCol('subscription_code', subId);
      setSubCol('subscriptionCode', subId);
      setSubCol('createdAt', new Date());
      setSubCol('created_at', new Date());
    }
    setSubCol('merchantId', merchantKey);
    setSubCol('merchant_id', existing.id);
    setSubCol('plan_id', planId);
    setSubCol('planId', planId);
    setSubCol('planName', planName);
    setSubCol('plan_name', planName);
    const planCode = plan.planCode || plan.plan_code || plan.code;
    if (planCode) {
      setSubCol('planCode', planCode);
      setSubCol('plan_code', planCode);
    }
    setSubCol(
      'maxStoresAllowed',
      plan.included_stores ?? plan.includedStores ?? plan.maxStoresAllowed ?? 0,
    );
    setSubCol(
      'licensedStoreCount',
      plan.included_stores ?? plan.includedStores ?? 0,
    );
    setSubCol(
      'licensedDeviceCount',
      plan.included_terminals ?? plan.includedTerminals ?? 0,
    );
    setSubCol('trialDays', plan.trialDays ?? plan.trial_days ?? 0);
    setSubCol('createdAt', new Date());
    setSubCol('updatedAt', new Date());
    setSubCol('storeTypeName', storeTypeName);
    setSubCol('store_type_name', storeTypeName);
    setSubCol(
      'entitlements',
      JSON.stringify(
        plan.included_features ||
          plan.includedFeatures ||
          plan.entitlements ||
          [],
      ),
    );
    setSubCol('billing_cycle', nextCycle);
    setSubCol('billingCycle', nextCycle);
    setSubCol('start_date', nextStart);
    setSubCol('startDate', nextStart);
    setSubCol('renewal_date', nextRenewal);
    setSubCol('renewalDate', nextRenewal);
    setSubCol('agreement_price', nextPrice);
    setSubCol('agreementPrice', nextPrice);
    setSubCol('price', nextPrice);
    setSubCol('auto_renew', input.autoRenew !== false);
    setSubCol('is_deleted', false);
    if (input.createdBy) {
      setSubCol('updated_by', input.createdBy);
      setSubCol('updatedBy', input.createdBy);
      if (!current?.created_by && !current?.createdBy) {
        setSubCol('created_by', input.createdBy);
        setSubCol('createdBy', input.createdBy);
      }
    }
    setSubCol('currency', 'USD');
    setSubCol('status', 'ACTIVE');
    setSubCol('updatedAt', new Date());
    setSubCol('updated_at', new Date());
    const columns = Object.keys(subData);
    if (current?.id) {
      const keys = columns.filter(
        (column) =>
          ![
            'id',
            'subscriptionId',
            'subscription_code',
            'subscriptionCode',
            'createdAt',
            'created_at',
          ].includes(column),
      );
      await manager.query(
        `UPDATE public.subscriptions SET ${keys.map((column, index) => `"${column}"=$${index + 2}`).join(',')} WHERE id=$1`,
        [current.id, ...keys.map((column) => subData[column])],
      );
      return;
    }
    await manager.query(
      `INSERT INTO public.subscriptions (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`,
      Object.values(subData),
    );
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status?: string },
    @Req() request: ActorRequest,
  ) {
    if (!body || !['ACTIVE', 'INACTIVE'].includes(String(body.status))) {
      throw new BadRequestException('status must be ACTIVE or INACTIVE');
    }
    const updatedBy = actorId({}, request?.user?.id);
    let targetRowId = '';
    let targetMerchantId = '';
    await this.db.transaction(async (manager) => {
      const [target] = await manager.query(
        `SELECT m.id,
                COALESCE(to_jsonb(m)->>'merchantId', to_jsonb(m)->>'merchantCode', m.id::text) AS "merchantId"
         FROM public.merchants m
         WHERE m.id::text = $1
            OR COALESCE(to_jsonb(m)->>'merchantId', '') = $1
            OR COALESCE(to_jsonb(m)->>'merchantCode', '') = $1
         ORDER BY CASE WHEN m.id::text = $1 THEN 0 ELSE 1 END,
                  COALESCE(
                    (to_jsonb(m)->>'updatedAt')::timestamptz,
                    (to_jsonb(m)->>'updated_at')::timestamptz,
                    (to_jsonb(m)->>'createdAt')::timestamptz,
                    (to_jsonb(m)->>'createdDate')::timestamptz,
                    (to_jsonb(m)->>'created_at')::timestamptz,
                    '-infinity'::timestamptz
                  ) DESC
         LIMIT 1
         FOR UPDATE`,
        [id],
      );
      if (!target) throw new NotFoundException('Merchant not found');
      targetRowId = target.id;
      targetMerchantId = target.merchantId;
      if (body.status === 'ACTIVE') {
        await manager.query(
          `UPDATE public.merchants m SET status='INACTIVE'
           WHERE COALESCE(to_jsonb(m)->>'merchantId', to_jsonb(m)->>'merchantCode', m.id::text) = $1
             AND COALESCE(to_jsonb(m)->>'status', 'ACTIVE') = 'ACTIVE'
             AND m.id <> $2`,
          [target.merchantId, target.id],
        );
      }
      await manager.query(
        `UPDATE public.merchants
         SET status=$2,
             is_deleted=$3,
             updated_by=COALESCE($4::uuid, updated_by),
             updated_at=clock_timestamp()
         WHERE id=$1`,
        [target.id, body.status, body.status === 'INACTIVE', updatedBy],
      );
      if (body.status === 'INACTIVE') {
        await manager.query(
          `UPDATE public.subscriptions
           SET status='INACTIVE',
               updated_by=COALESCE($2::uuid, updated_by),
               updated_at=clock_timestamp()
           WHERE merchant_id IN (
             SELECT related.id
             FROM public.merchants related
             WHERE COALESCE(to_jsonb(related)->>'merchantId', to_jsonb(related)->>'merchantCode', related.id::text)=$1
           )
             AND status='ACTIVE'
             AND COALESCE(is_deleted, false)=false`,
          [target.merchantId, updatedBy],
        );
      } else {
        await manager.query(
          `UPDATE public.subscriptions
           SET status='INACTIVE',
               updated_by=COALESCE($2::uuid, updated_by),
               updated_at=clock_timestamp()
           WHERE merchant_id IN (
             SELECT related.id
             FROM public.merchants related
             WHERE COALESCE(to_jsonb(related)->>'merchantId', to_jsonb(related)->>'merchantCode', related.id::text)=$1
           )
             AND status='ACTIVE'
             AND COALESCE(is_deleted, false)=false`,
          [target.merchantId, updatedBy],
        );
        await manager.query(
          `UPDATE public.subscriptions
           SET status='ACTIVE',
               updated_by=COALESCE($2::uuid, updated_by),
               updated_at=clock_timestamp()
           WHERE id=(
             SELECT id
             FROM public.subscriptions
             WHERE merchant_id IN (
               SELECT related.id
               FROM public.merchants related
               WHERE COALESCE(to_jsonb(related)->>'merchantId', to_jsonb(related)->>'merchantCode', related.id::text)=$1
             )
               AND COALESCE(is_deleted, false)=false
             ORDER BY created_at DESC NULLS LAST, id DESC
             LIMIT 1
           )`,
          [target.merchantId, updatedBy],
        );
      }
    });
    return {
      success: true,
      id: targetRowId,
      merchantId: targetMerchantId,
      status: body.status,
      is_deleted: body.status === 'INACTIVE',
    };
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() request: ActorRequest) {
    const updatedBy = actorId({}, request?.user?.id);
    try {
      let merchantId = id;
      let rowId = '';
      await this.db.transaction(async (manager) => {
        const [merchant] = await manager.query(
          `SELECT m.id,
                  COALESCE(to_jsonb(m)->>'merchantId', to_jsonb(m)->>'merchantCode', m.id::text) AS "merchantId"
           FROM public.merchants m
           WHERE m.id::text=$1
              OR COALESCE(to_jsonb(m)->>'merchantId', '')=$1
              OR COALESCE(to_jsonb(m)->>'merchantCode', '')=$1
           ORDER BY CASE WHEN m.id::text=$1 THEN 0 ELSE 1 END
           LIMIT 1
           FOR UPDATE`,
          [id],
        );
        if (!merchant) throw new NotFoundException('Merchant not found');
        merchantId = merchant.merchantId;
        rowId = merchant.id;
        await manager.query(
          `UPDATE public.merchants
           SET status='INACTIVE',
               is_deleted=true,
               updated_by=COALESCE($2::uuid, updated_by),
               updated_at=clock_timestamp()
           WHERE id=$1`,
          [merchant.id, updatedBy],
        );
        await manager.query(
          `UPDATE public.subscriptions
           SET status='INACTIVE',
               updated_by=COALESCE($2::uuid, updated_by),
               updated_at=clock_timestamp()
           WHERE merchant_id=$1 AND status='ACTIVE'`,
          [merchant.id, updatedBy],
        );
      });
      return {
        success: true,
        id: rowId,
        merchantId,
        status: 'INACTIVE',
        is_deleted: true,
      };
    } catch (error: any) {
      if ((error.driverError?.code || error.code) === '23503')
        throw new ConflictException('Merchant is referenced by other records');
      throw error;
    }
  }

  private async saveSubscription(
    manager: { query: (sql: string, params?: unknown[]) => Promise<any[]> },
    merchantId: string,
    input: Input,
  ) {
    const [planRow] = await manager.query(
      `SELECT to_jsonb(p) AS plan FROM public.plans p WHERE p.id::text=$1`,
      [String(input.planId)],
    );
    const plan = planRow?.plan || {};
    const price =
      input.agreementPrice ?? plan.basePrice ?? plan.base_price ?? 0;
    const fields: Record<string, unknown> = {
      merchant_id: merchantId,
      plan_id: input.planId,
      billing_cycle: input.billingCycle ?? plan.billing_cycle ?? 'MONTHLY',
      start_date: input.startDate ?? null,
      renewal_date: input.renewalDate ?? null,
      price,
      auto_renew: input.autoRenew !== false,
      status: 'ACTIVE',
      is_deleted: false,
      updated_at: new Date(),
    };
    const columns = new Set(
      (
        await manager.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='subscriptions'`,
        )
      ).map((row: { column_name: string }) => row.column_name),
    );
    const [current] = await manager.query(
      `SELECT id, plan_id FROM public.subscriptions WHERE merchant_id=$1 AND status='ACTIVE' ORDER BY created_at DESC NULLS LAST LIMIT 1`,
      [merchantId],
    );
    const planChanged =
      !current?.id || String(current.plan_id || '') !== String(input.planId);
    if (current?.id && planChanged) {
      await manager.query(
        `UPDATE public.subscriptions SET status='INACTIVE', updated_at=now() WHERE merchant_id=$1 AND status='ACTIVE'`,
        [merchantId],
      );
    }
    if (!current?.id || planChanged) {
      const subId = `SUB-${randomUUID()}`;
      const now = new Date();
      const insert = {
        id: subId,
        subscription_code: subId,
        ...fields,
        created_at: now,
      };
      const keys = Object.keys(insert).filter(
        (key) => columns.has(key) && insert[key as keyof typeof insert] != null,
      );
      await manager.query(
        `INSERT INTO public.subscriptions (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')})`,
        keys.map((key) => insert[key as keyof typeof insert]),
      );
      return;
    }
    const keys = Object.keys(fields).filter(
      (key) => columns.has(key) && fields[key] != null,
    );
    await manager.query(
      `UPDATE public.subscriptions SET ${keys.map((key, index) => `"${key}"=$${index + 2}`).join(',')} WHERE id=$1`,
      [current.id, ...keys.map((key) => fields[key])],
    );
  }
}

function storeTypeIdFromPlan(plan: Input | null | undefined): string | null {
  const value = String(plan?.storeTypeId || plan?.store_type_id || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  )
    ? value
    : null;
}

async function storeTypeNameForPlan(
  manager: { query: (sql: string, params?: unknown[]) => Promise<any[]> },
  planId: string,
): Promise<string | null> {
  const planCols = new Set(
    (
      await manager.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='plans'`,
      )
    ).map((row: { column_name: string }) => row.column_name),
  );
  const source = [
    'store_type_id',
    'storeTypeId',
    'store_type',
    'storeType',
  ].find((column) => planCols.has(column));
  if (!source) return null;
  const [plan] = await manager.query(
    `SELECT "${source}" AS ref FROM public.plans WHERE id::text=$1`,
    [planId],
  );
  const ref = plan?.ref == null ? '' : String(plan.ref).trim();
  if (!ref) return null;
  const [storeType] = await manager.query(
    `SELECT name FROM public.store_types
    WHERE id::text=$1 OR name ILIKE $1
      OR COALESCE(to_jsonb(store_types)->>'storeTypeCode', to_jsonb(store_types)->>'store_type_code', '') ILIKE $1
    LIMIT 1`,
    [ref],
  );
  return storeType?.name || (/^[0-9a-f-]{36}$/i.test(ref) ? null : ref);
}
