import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

type Input = Record<string, any>;
const merchantFields = ['merchantId','ownerName','email','phone','businessName','legalBusinessName','businessType','retailSubCategory','firstName','lastName','alternatePhone','jobTitle','billingContact','taxId','country','state','city','postalCode','businessAddress','status',
  'merchantName','businessDisplayName','addressLine1','addressLine2','planId','billingCycle','startDate','renewalDate','agreementPrice','tax','totalDueToday','paymentMethod','roleIds'];
const subscriptionFields = ['planId','billingCycle','startDate','renewalDate','price','status'];
const snakeColumns: Record<string, string> = {
  merchantId: 'merchant_id',
  businessName: 'business_display_name',
  businessDisplayName: 'business_display_name',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  postalCode: 'postal_code',
  firstName: 'first_name',
  lastName: 'last_name',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  createdDate: 'created_at',
};
const quote = (key: string) => `"${snakeColumns[key] ?? key}"`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const licenseCount = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Overlay plan included_stores / included_terminals onto subscription list/detail rows. */
export function withPlanLicenseCounts(row: Input, plan?: Input | null): Input {
  const stores = licenseCount(plan?.includedStores ?? plan?.included_stores ?? row.includedStores ?? row.included_stores ?? row.maxStoresAllowed ?? row.licensedStoreCount);
  const devices = licenseCount(plan?.includedTerminals ?? plan?.included_terminals ?? row.includedTerminals ?? row.included_terminals ?? row.licensedDeviceCount);
  row.includedStores = stores;
  row.includedTerminals = devices;
  row.included_stores = stores;
  row.included_terminals = devices;
  row.storeCount = stores;
  row.deviceCount = devices;
  row.stores = stores;
  row.devices = devices;
  row.maxStoresAllowed = stores;
  row.licensedStoreCount = stores;
  row.licensedDeviceCount = devices;
  return row;
}

/** SQL uses the installed schema, never a schema inferred from request names. */
export class MerchantCrudService {
  constructor(private readonly db: DataSource) {}

  private presentSubscription(row: Input): Input {
    const plan = row.plan_details
      ? {
          id: row.plan_details.id,
          planCode: row.plan_details.planCode,
          name: row.plan_details.name,
          description: row.plan_details.description,
          basePrice: Number(row.plan_details.basePrice),
          currency: row.plan_details.currency,
          billingCycle: row.plan_details.billingCycle,
          storeTypeId: row.plan_details.storeTypeId,
          includedStores: Number(row.plan_details.includedStores || 0),
          includedTerminals: Number(row.plan_details.includedTerminals || 0),
          includedEmployees: Number(row.plan_details.includedEmployees || 0),
          includedFeatures: row.plan_details.includedFeatures || [],
          trialPeriod: Number(row.plan_details.trialPeriod || 0),
        }
      : null;

    return {
      id: row.id,
      subscriptionCode: row.subscription_code ?? row.subscriptionCode ?? row.id,
      merchantId: row.merchant_code ?? row.merchant_id ?? row.merchantId ?? null,
      merchantName: row.merchant_name ?? null,
      status: row.status,
      billingCycle: row.billing_cycle ?? row.billingCycle ?? null,
      price: row.price == null ? null : Number(row.price),
      autoRenew: row.auto_renew ?? row.autoRenew ?? false,
      startDate: row.start_date ?? row.startDate ?? null,
      renewalDate: row.renewal_date ?? row.renewalDate ?? null,
      trialEndDate: row.trial_end_date ?? row.trialEndDate ?? null,
      plan,
      storeType: row.plan_store_type || null,
    };
  }

  private validate(input: Input, allowed: string[]) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Provide an object');
    const unknown = Object.keys(input).filter(key => !allowed.includes(key));
    if (unknown.length) throw new BadRequestException(`Unknown fields: ${unknown.join(', ')}`);
    if (!Object.keys(input).length) throw new BadRequestException('Provide at least one field');
    if (input.merchantId !== undefined && (typeof input.merchantId!=='string' || !input.merchantId.trim() || input.merchantId.length>100 || input.merchantId!==input.merchantId.trim())) throw new BadRequestException('merchantId must be a non-empty identifier of at most 100 characters without surrounding whitespace');
    for (const key of ['planId']) if (input[key] !== undefined && !uuid.test(String(input[key]))) throw new BadRequestException(`Invalid ${key}`);
    if (input.roleIds !== undefined && (!Array.isArray(input.roleIds) || input.roleIds.some((id: unknown) => !uuid.test(String(id))))) throw new BadRequestException('roleIds must be UUIDs');
    if (input.email !== undefined && (typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))) throw new BadRequestException('Invalid email');
    for (const key of ['merchantName','businessDisplayName','ownerName','phone','businessName']) if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) throw new BadRequestException(`${key} must be non-empty`);
    for (const key of ['price','agreementPrice','tax','totalDueToday']) if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > (key === 'price' || key === 'agreementPrice' ? 99999999.99 : 9999999999.99))) throw new BadRequestException(`${key} must be a non-negative amount within the supported range`);
    if (input.status !== undefined && !['ACTIVE','INACTIVE','PENDING','SUSPENDED','TRIAL','PAST_DUE','CANCELLED','EXPIRED'].includes(input.status)) throw new BadRequestException('Invalid status');
    if (input.billingCycle !== undefined && !['MONTHLY','QUARTERLY','ANNUAL','FREE_TRIAL'].includes(input.billingCycle)) throw new BadRequestException('Invalid billingCycle');
    for (const key of ['startDate','renewalDate']) if (input[key] !== undefined) {
      const value = input[key]; const date = new Date(`${value}T00:00:00Z`);
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new BadRequestException(`Invalid ${key}`);
    }
  }

  private required(input: Input, keys: string[]) {
    const missing = keys.filter(key => input[key] === undefined || input[key] === null || input[key] === '');
    if (missing.length) throw new BadRequestException(`Missing required fields: ${missing.join(', ')}`);
  }

  private async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    try { return await this.db.transaction(work); }
    catch (error: any) {
      const code = error.driverError?.code || error.code;
      if (code === '23505') throw new ConflictException('Record already exists');
      if (code === '23503') throw new ConflictException('Record is referenced by other records');
      throw error;
    }
  }

  private async identity(manager: Pick<EntityManager,'query'>, code: string): Promise<string> {
    const [row] = await manager.query(`SELECT merchant_id AS code FROM public.merchants
      WHERE merchant_id=$1 OR merchant_code=$1 OR id::text=$1 LIMIT 1`,[code]);
    if (!row) throw new NotFoundException('Merchant not found');
    return row.code;
  }

  private async anchor(manager: Pick<EntityManager,'query'>, merchantId: string) {
    const [row] = await manager.query(`SELECT m.id, m.merchant_code AS "merchantCode" FROM public.merchants m
      WHERE m.merchant_id=$1 ORDER BY m.created_at ASC NULLS LAST,m.id LIMIT 1`,[merchantId]);
    if (!row) throw new NotFoundException('Merchant not found');
    return row;
  }

  private async lockMerchant(manager: EntityManager, code: string) {
    const root = await this.identity(manager,code);
    // Serialize by business identity, independently of any record code.
    await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('merchant:' || $1,0))",[root]);
    const anchor = await this.anchor(manager,root);
    await manager.query('SELECT 1 FROM public.merchants WHERE id=$1 FOR UPDATE',[anchor.id]);
    const [merchant] = await manager.query(`SELECT m.* FROM public.merchants m
      WHERE m.merchant_id=$1 ORDER BY m.created_at DESC NULLS LAST, m.id DESC LIMIT 1 FOR UPDATE`,[root]);
    if (!merchant) throw new NotFoundException('Merchant not found');
    return {merchant,root};
  }

  private async audit(manager: EntityManager, code: string, action: string, details: Input) {
    await manager.query(`INSERT INTO public.onboarding_audit_logs (id,"merchantId",action,"performedBy",details)
      VALUES ($1,$2,$3,'merchant-crud-api',$4)`,[randomUUID(),code,action,JSON.stringify(details)]);
  }

  private async extras(manager: EntityManager, root: string, input: Input) {
    if (input.roleIds !== undefined) {
      const merchant = await this.anchor(manager,root);
      const ids = [...new Set(input.roleIds)] as string[];
      const roles = await manager.query(`SELECT * FROM public.role_templates WHERE id=ANY($1::uuid[]) AND status='ACTIVE'`,[ids]);
      if (roles.length !== ids.length) throw new BadRequestException('Select active roleIds');
      // Reuse the existing merchant-specific role template table; retain customized rows.
      await manager.query(`UPDATE public.merchant_role_templates SET status='INACTIVE',updated_at=now()
        WHERE merchant_id=$1 AND source_role_template_id IS NOT NULL`,[merchant.id]);
      for (const role of roles) {
        const [existing] = await manager.query(`SELECT id FROM public.merchant_role_templates WHERE merchant_id=$1 AND source_role_template_id=$2`,[merchant.id,role.id]);
        if (existing) await manager.query(`UPDATE public.merchant_role_templates SET status='ACTIVE',updated_at=now() WHERE id=$1`,[existing.id]);
        else await manager.query(`INSERT INTO public.merchant_role_templates (id,merchant_id,source_role_template_id,role_code,name,description,scope_type,status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE')`,[randomUUID(),merchant.id,role.id,role.role_code,role.name,role.description,role.scope_type]);
      }
    }
  }

  private merchantInput(input: Input): Input {
    const normalized = {...input};
    if (input.merchantName !== undefined && input.ownerName === undefined) normalized.ownerName=input.merchantName;
    if (input.addressLine1 !== undefined || input.addressLine2 !== undefined) normalized.businessAddress=[input.addressLine1,input.addressLine2].filter(Boolean).join(', ');
    if (input.roleIds !== undefined) normalized.roleIds=[...new Set(input.roleIds)];
    return normalized;
  }

  private values(record: Input, keys: string[]) {
    return keys.map(key=>['roleIds','kycDocuments'].includes(key) ? JSON.stringify(record[key]) : record[key]);
  }

  private async subscriptionRow(manager: Pick<EntityManager,'query'>, id: string) {
    const [row] = await manager.query(`SELECT *,to_char(start_date,'YYYY-MM-DD') AS start_date,
      to_char(renewal_date,'YYYY-MM-DD') AS renewal_date FROM public.subscriptions WHERE id=$1`,[id]);
    return row;
  }

  private subscriptionSnapshot(sub: Input): Input {
    return {planId:sub.plan_id,billingCycle:sub.billing_cycle,startDate:sub.start_date,renewalDate:sub.renewal_date,agreementPrice:Number(sub.price)};
  }

  private async saveMerchantRecord(manager: EntityManager, root: string, current: Input, changes: Input, version: boolean) {
    if (version) {
      await manager.query(`UPDATE public.merchants SET status='INACTIVE',updated_at=clock_timestamp() WHERE merchant_code=$1`,[current.merchant_code ?? current.merchantCode]);
      const next = {...current,...changes,status:'ACTIVE',merchant_code:`MRC-${randomUUID()}`};
      delete next.merchantCode;
      const keys=Object.keys(next).filter(key=>!['id','createdAt','updatedAt'].includes(key));
      await manager.query(`INSERT INTO public.merchants (${keys.map(quote).join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,this.values(next,keys));
      await this.anchor(manager,root);
    } else {
      const keys=merchantFields.filter(key=>changes[key]!==undefined);
      if (keys.length) await manager.query(`UPDATE public.merchants SET ${keys.map((key,i)=>`${quote(key)}=$${i+2}`).join(',')},updated_at=clock_timestamp() WHERE merchant_code=$1`,[current.merchant_code ?? current.merchantCode,...this.values(changes,keys)]);
    }
  }

  private async storeTypeName(manager: EntityManager, plan: Input): Promise<string | null> {
    const ref = plan.store_type_id || plan.storeTypeId || plan.store_type || plan.storeType;
    const value = ref == null ? '' : String(ref).trim();
    if (!value) return null;
    const [storeType] = await manager.query(`SELECT name FROM public.store_types
      WHERE id::text=$1 OR name ILIKE $1
        OR COALESCE(to_jsonb(store_types)->>'storeTypeCode', to_jsonb(store_types)->>'store_type_code', '') ILIKE $1
      LIMIT 1`, [value]);
    return storeType?.name || (/^[0-9a-f-]{36}$/i.test(value) ? null : value);
  }

  private async writeSubscription(manager: EntityManager, code: string, input: Input, current?: Input, forceNew=false) {
    const merged = {...current,...input};
    const planId = merged.planId ?? merged.plan_id;
    this.required({planId},['planId']);
    const currentPlanId = current?.plan_id ?? current?.planId;
    const planChanged = !current || currentPlanId !== planId;
    const [plan] = await manager.query(`SELECT * FROM public.plans WHERE id=$1`,[planId]);
    if (!plan || ((planChanged || forceNew) && plan.status !== 'ACTIVE')) throw new BadRequestException('Select an active planId');
    if (planChanged && currentPlanId) {
      const currentType = await this.storeTypeName(manager, (await manager.query(`SELECT * FROM public.plans WHERE id=$1`,[currentPlanId]))[0] || {});
      const nextType = await this.storeTypeName(manager, plan);
      const currentKey = String(currentType || '').trim().toUpperCase();
      const nextKey = String(nextType || '').trim().toUpperCase();
      if (currentKey && nextKey && currentKey !== 'BOTH' && nextKey !== 'BOTH' && currentKey !== nextKey) {
        throw new BadRequestException(`Plan must stay on the same store type (${currentType}). Other store types cannot be selected.`);
      }
    }
    const start = merged.startDate || merged.start_date || new Date().toISOString().slice(0,10);
    const cycle = merged.billingCycle || merged.billing_cycle || plan.billing_cycle || 'MONTHLY';
    const date = new Date(`${start}T00:00:00Z`);
    const months = cycle === 'ANNUAL' ? 12 : cycle === 'QUARTERLY' ? 3 : 1;
    const end = new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+months,1));
    end.setUTCDate(Math.min(date.getUTCDate(),new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()+1,0)).getUTCDate()));
    const renewal = merged.renewalDate || merged.renewal_date || end.toISOString().slice(0,10);
    if (renewal <= start) throw new BadRequestException('renewalDate must be after startDate');
    const basePrice = plan.base_price ?? 0;
    const fields = {
      plan_id: plan.id,
      billing_cycle: cycle,
      start_date: start,
      renewal_date: renewal,
      price: merged.price ?? Number(basePrice),
      auto_renew: input.autoRenew ?? current?.auto_renew ?? true,
      status: input.status ?? (forceNew ? 'ACTIVE' : current?.status || 'ACTIVE'),
      updated_at: new Date(),
    };
    const isNew = !current || forceNew;
    if (fields.status === 'ACTIVE' && isNew) await manager.query(`UPDATE public.subscriptions SET status='INACTIVE',updated_at=clock_timestamp()
      WHERE merchant_id=$1 AND status='ACTIVE'`,[code]);
    const id = isNew ? `SUB-${randomUUID()}` : current!.id;
    const keys = Object.keys(fields).filter(key => (fields as Record<string, unknown>)[key] != null);
    const values = keys.map(key => (fields as Record<string, unknown>)[key]);
    if (isNew) {
      await manager.query(`INSERT INTO public.subscriptions (id,merchant_id,subscription_code,created_at,${keys.map(quote).join(',')})
        VALUES ($1,$2,$1,clock_timestamp(),${keys.map((_,i)=>`$${i+3}`).join(',')})`,[id,code,...values]);
    }
    else await manager.query(`UPDATE public.subscriptions SET ${keys.map((key,i)=>`${quote(key)}=$${i+2}`).join(',')} WHERE id=$1`,[id,...values]);
    return id;
  }

  async createMerchant(input: Input) {
    this.validate(input,merchantFields);
    if (input.status !== undefined && !['ACTIVE','INACTIVE','PENDING','SUSPENDED'].includes(input.status)) throw new BadRequestException('Invalid merchant status');
    delete input.storeTypeId;
    this.required(input,['merchantName','businessDisplayName','email','phone','businessName','planId']);
    input=this.merchantInput(input);
    const code = `MRC-${randomUUID()}`;
    input.merchantId ??= `MER-${randomUUID()}`;
    await this.transaction(async manager => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('merchant:' || $1,0))",[input.merchantId]);
      if ((await manager.query('SELECT 1 FROM public.merchants WHERE merchant_id=$1 OR merchant_code=$1',[input.merchantId])).length) throw new ConflictException('merchantId already exists');
      const fields = merchantFields.filter(key=>input[key] !== undefined);
      const [merchant] = await manager.query(`INSERT INTO public.merchants (merchant_code,${fields.map(quote).join(',')})
        VALUES ($1,${fields.map((_,i)=>`$${i+2}`).join(',')}) RETURNING *`,[code,...this.values(input,fields)]);
      if (input.status === undefined) await manager.query(`UPDATE public.merchants SET status='ACTIVE' WHERE merchant_code=$1`,[code]);
      const sub = await this.writeSubscription(manager,merchant.id,{...input,price:input.agreementPrice,status:'ACTIVE'});
      await this.saveMerchantRecord(manager,input.merchantId,merchant,this.subscriptionSnapshot(await this.subscriptionRow(manager,sub)),false);
      await this.extras(manager,input.merchantId,input);
      await this.audit(manager,input.merchantId,'MERCHANT_CREATED',{merchant:{...merchant,status:input.status || 'ACTIVE'}});
    });
    return this.getMerchant(code);
  }

  async getMerchant(code: string) {
    const root = await this.identity(this.db,code);
    const [merchant] = await this.db.query(`SELECT m.* FROM public.merchants m
      WHERE m.merchant_id=$1 ORDER BY m.created_at DESC NULLS LAST, m.id DESC LIMIT 1`,[root]);
    if (!merchant) throw new NotFoundException('Merchant not found');
    const subscriptions = await this.listSubscriptions(root);
    return {success:true,merchantId:root,merchant,subscription:subscriptions.subscriptions.find((sub: Input)=>sub.status==='ACTIVE') || null};
  }

  async listMerchants() {
    const codes = await this.db.query('SELECT DISTINCT merchant_id AS "merchantId" FROM public.merchants');
    const merchants = await Promise.all(codes.map((row: Input)=>this.getMerchant(row.merchantId)));
    return {success:true,count:merchants.length,merchants:merchants.map(({success,...row})=>row)};
  }

  async updateMerchant(code: string, input: Input, replace=false) {
    this.validate(input,merchantFields);
    if (input.status !== undefined && !['ACTIVE','INACTIVE','PENDING','SUSPENDED'].includes(input.status)) throw new BadRequestException('Invalid merchant status');
    delete input.storeTypeId;
    if (replace) this.required(input,['merchantName','businessDisplayName','email','phone','businessName','planId']);
    await this.transaction(async manager=>{
      const {merchant,root} = await this.lockMerchant(manager,code);
      if (input.merchantId!==undefined && input.merchantId!==merchant.merchantId) throw new BadRequestException('merchantId cannot be changed');
      const planChanged = input.planId !== undefined && input.planId !== merchant.planId;
      await this.audit(manager,root,planChanged ? 'MERCHANT_PLAN_CHANGED' : 'MERCHANT_UPDATED',{merchant});
      const [current] = await manager.query(`SELECT *,to_char(start_date,'YYYY-MM-DD') AS start_date,to_char(renewal_date,'YYYY-MM-DD') AS renewal_date FROM public.subscriptions WHERE merchant_id=$1 AND status='ACTIVE' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,[merchant.id]);
      const subInput = Object.fromEntries(subscriptionFields.filter(key=>!['status','price'].includes(key) && input[key]!==undefined).map(key=>[key,input[key]]));
      if (input.agreementPrice!==undefined) subInput.price=input.agreementPrice;
      let changes=this.merchantInput(input);
      if (input.addressLine1!==undefined || input.addressLine2!==undefined) changes.businessAddress=[input.addressLine1 ?? merchant.addressLine1,input.addressLine2 ?? merchant.addressLine2].filter(Boolean).join(', ');
      if (Object.keys(subInput).length) {
        const subId = await this.writeSubscription(manager,merchant.id,subInput,current,planChanged);
        changes={...changes,...this.subscriptionSnapshot(await this.subscriptionRow(manager,subId))};
      }
      await this.extras(manager,root,input);
      await this.saveMerchantRecord(manager,root,merchant,changes,planChanged);
    });
    return this.getMerchant(code);
  }

  async history(code: string) {
    const current = await this.getMerchant(code);
    const history = await this.db.query('SELECT * FROM public.onboarding_audit_logs WHERE "merchantId"=$1 ORDER BY "createdAt" DESC',[current.merchantId]);
    const merchants = await this.db.query(`SELECT m.* FROM public.merchants m
      WHERE m.merchant_id=$1 ORDER BY m.created_at DESC NULLS LAST, m.id DESC`,[current.merchantId]);
    return {...current,merchants,history,...await this.listSubscriptions(current.merchantId)};
  }

  async deleteMerchant(code: string) {
    await this.transaction(async manager=>{
      const {root} = await this.lockMerchant(manager,code);
      // Refuse deletion while related business records remain, including tables without FKs.
      if ((await manager.query(`SELECT 1 FROM public.subscriptions WHERE merchant_id=(SELECT id FROM public.merchants WHERE merchant_id=$1 LIMIT 1) LIMIT 1`,[root])).length) {
        throw new ConflictException('Merchant has subscriptions; remove them first');
      }
      if ((await manager.query(`SELECT 1 FROM public.stores WHERE "merchantId"=$1 OR "merchantId" IN
        (SELECT merchant_code FROM public.merchants WHERE merchant_id=$1) LIMIT 1`,[root])).length) throw new ConflictException('Merchant has stores; remove them first');
      await manager.query('DELETE FROM public.merchants WHERE merchant_id=$1',[root]);
    });
    return {success:true,merchantId:code};
  }

  async listSubscriptions(merchantId?: string, status?: string) {
    if (status) this.validate({status},['status']);
    const columns = new Set((await this.db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='subscriptions'`)).map((row: {column_name: string}) => row.column_name));
    const merchantColumn = columns.has('merchant_id') ? 'merchant_id' : columns.has('merchantId') ? '"merchantId"' : '';
    const merchantFilter = merchantColumn === 'merchant_id'
      ? `($1::text IS NULL OR s.merchant_id::text=$1 OR EXISTS (
          SELECT 1 FROM public.merchants filter_merchant
          WHERE filter_merchant.id=s.merchant_id
            AND $1 IN (
              filter_merchant.id::text,
              COALESCE(to_jsonb(filter_merchant)->>'merchant_code', ''),
              COALESCE(to_jsonb(filter_merchant)->>'merchantCode', ''),
              COALESCE(to_jsonb(filter_merchant)->>'merchant_id', ''),
              COALESCE(to_jsonb(filter_merchant)->>'merchantId', '')
            )
        ))`
      : merchantColumn
        ? `($1::text IS NULL OR s.${merchantColumn}::text=$1)`
        : '$1::text IS NULL';
    const filters = [
      merchantFilter,
      columns.has('status') ? `($2::text IS NULL OR s.status::text=$2)` : '$2::text IS NULL',
      columns.has('is_deleted') ? 'COALESCE(s.is_deleted, false)=false' : 'TRUE',
    ];
    const merchantKey = merchantColumn === '"merchantId"' ? 's."merchantId"' : merchantColumn ? `s.${merchantColumn}::text` : 'NULL';
    const planIdCol = columns.has('plan_id') ? 's.plan_id' : columns.has('planId') ? 's."planId"' : '';
    const planJoin = planIdCol ? `LEFT JOIN public.plans p ON p.id::text = ${planIdCol}::text
      LEFT JOIN public.store_types st ON st.id::text = COALESCE(to_jsonb(p)->>'store_type_id', to_jsonb(p)->>'storeTypeId', '')` : '';
    const planColumns = planJoin
      ? new Set((await this.db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='plans'`)).map((row: {column_name: string}) => row.column_name))
      : new Set<string>();
    const planStores = planColumns.has('included_stores')
      ? 'p.included_stores'
      : planColumns.has('stores_limit')
        ? 'p.stores_limit'
        : planColumns.has('includedStores')
          ? 'p."includedStores"'
          : 'NULL';
    const planTerminals = planColumns.has('included_terminals')
      ? 'p.included_terminals'
      : planColumns.has('terminal_limit')
        ? 'p.terminal_limit'
        : planColumns.has('includedTerminals')
          ? 'p."includedTerminals"'
          : 'NULL';
    const planEmployees = planColumns.has('employees_limit')
      ? 'p.employees_limit'
      : planColumns.has('included_employees')
        ? 'p.included_employees'
        : planColumns.has('includedEmployees')
          ? 'p."includedEmployees"'
          : 'NULL';
    const planFeatures = planColumns.has('included_features')
      ? 'p.included_features'
      : planColumns.has('includedFeatures')
        ? 'p."includedFeatures"'
        : "'{}'::text[]";
    const planTrialPeriod = planColumns.has('trial_period')
      ? 'p.trial_period'
      : planColumns.has('trialPeriod')
        ? 'p."trialPeriod"'
        : '0';
    const planSelect = planJoin
      ? `, ${planStores} AS plan_included_stores, ${planTerminals} AS plan_included_terminals,
          jsonb_build_object(
            'id', p.id,
            'planCode', COALESCE(to_jsonb(p)->>'plan_code', to_jsonb(p)->>'planCode', ''),
            'name', p.name,
            'description', COALESCE(p.description, ''),
            'basePrice', COALESCE(to_jsonb(p)->>'base_price', to_jsonb(p)->>'basePrice', '0')::numeric,
            'currency', p.currency,
            'billingCycle', COALESCE(to_jsonb(p)->>'billing_cycle', to_jsonb(p)->>'billingCycle', ''),
            'storeTypeId', NULLIF(COALESCE(to_jsonb(p)->>'store_type_id', to_jsonb(p)->>'storeTypeId', ''), ''),
            'includedStores', COALESCE(${planStores}, 0),
            'includedTerminals', COALESCE(${planTerminals}, 0),
            'includedEmployees', COALESCE(${planEmployees}, 0),
            'includedFeatures', COALESCE(${planFeatures}, '{}'),
            'trialPeriod', COALESCE(${planTrialPeriod}, 0)
          ) AS plan_details,
          CASE WHEN st.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', st.id,
            'code', COALESCE(to_jsonb(st)->>'code', to_jsonb(st)->>'storeTypeCode', to_jsonb(st)->>'store_type_code', ''),
            'name', st.name
          ) END AS plan_store_type`
      : '';
    const createdOrder = columns.has('createdAt')
      ? 's."createdAt"'
      : columns.has('created_at')
        ? 's.created_at'
        : 's.id';
    const subscriptions = await this.db.query(`SELECT s.*, COALESCE((
        SELECT COALESCE(
          to_jsonb(m)->>'merchantId',
          to_jsonb(m)->>'merchant_id',
          to_jsonb(m)->>'merchantCode',
          to_jsonb(m)->>'merchant_code',
          m.id::text
        )
        FROM public.merchants m
        WHERE ${merchantKey} IN (
          to_jsonb(m)->>'merchantId',
          to_jsonb(m)->>'merchant_id',
          to_jsonb(m)->>'merchantCode',
          to_jsonb(m)->>'merchant_code',
          m.id::text
        )
        LIMIT 1
      ), ${merchantKey}) AS merchant_code,
      (
        SELECT COALESCE(
          NULLIF(BTRIM(COALESCE(to_jsonb(m)->>'business_display_name', to_jsonb(m)->>'businessDisplayName', '')), ''),
          NULLIF(BTRIM(CONCAT_WS(' ', to_jsonb(m)->>'first_name', to_jsonb(m)->>'last_name')), ''),
          NULLIF(COALESCE(to_jsonb(m)->>'merchant_code', to_jsonb(m)->>'merchantCode', ''), '')
        )
        FROM public.merchants m
        WHERE ${merchantKey} IN (
          to_jsonb(m)->>'merchantId',
          to_jsonb(m)->>'merchant_id',
          to_jsonb(m)->>'merchantCode',
          to_jsonb(m)->>'merchant_code',
          m.id::text
        )
        LIMIT 1
      ) AS merchant_name${planSelect}
      FROM public.subscriptions s ${planJoin} WHERE ${filters.join(' AND ')}
      ORDER BY ${createdOrder} DESC NULLS LAST`,[merchantId || null,status || null]);
    for (const row of subscriptions) {
      for (const key of ['startDate','renewalDate','start_date','renewal_date']) {
        const value = row[key];
        if (value instanceof Date && Number.isFinite(value.getTime())) {
          const month = String(value.getMonth() + 1).padStart(2, '0');
          const day = String(value.getDate()).padStart(2, '0');
          row[key] = `${value.getFullYear()}-${month}-${day}`;
        }
      }
    }
    const compactSubscriptions = subscriptions.map((row: Input) => this.presentSubscription(row));
    return {success:true,count:compactSubscriptions.length,subscriptions:compactSubscriptions};
  }

  async getSubscription(id: string) {
    const [row] = await this.db.query(`SELECT COALESCE(
      to_jsonb(s)->>'merchant_id',
      to_jsonb(s)->>'merchantId'
    ) AS merchant_id FROM public.subscriptions s
      WHERE id=$1 AND COALESCE(is_deleted, false)=false`,[id]);
    if (!row) throw new NotFoundException('Subscription not found');
    const result = await this.listSubscriptions(row.merchant_id);
    const subscription = result.subscriptions.find((sub: Input)=>sub.id===id);
    if (!subscription) throw new NotFoundException('Subscription not found');
    return {success:true,subscription};
  }

  async saveSubscription(input: Input, id?: string, replace=false) {
    this.validate(input,id ? subscriptionFields : ['merchantId',...subscriptionFields]);
    if (!id) this.required(input,['merchantId','planId']);
    if (replace) this.required(input,['planId','billingCycle','startDate','renewalDate','price','status']);
    const resultId = await this.transaction(async manager=>{
      const [found] = id
        ? await manager.query('SELECT merchant_id FROM public.subscriptions WHERE id=$1',[id])
        : await manager.query(`SELECT id AS merchant_id FROM public.merchants
            WHERE id::text=$1
               OR merchant_code=$1
               OR COALESCE(to_jsonb(merchants)->>'merchant_id', to_jsonb(merchants)->>'merchantId', '')=$1
            LIMIT 1`,[input.merchantId]);
      if (!found) throw new NotFoundException('Subscription not found');
      const merchantId = String(found.merchant_id);
    const [current] = id
      ? await manager.query(`SELECT *,to_char(start_date,'YYYY-MM-DD') AS start_date,to_char(renewal_date,'YYYY-MM-DD') AS renewal_date FROM public.subscriptions WHERE id=$1 FOR UPDATE`,[id])
      : await manager.query(`SELECT *,to_char(start_date,'YYYY-MM-DD') AS start_date,to_char(renewal_date,'YYYY-MM-DD') AS renewal_date FROM public.subscriptions WHERE merchant_id=$1 AND status='ACTIVE' ORDER BY created_at DESC NULLS LAST LIMIT 1 FOR UPDATE`,[merchantId]);
    if (id && !current) throw new NotFoundException('Subscription not found');
      return this.writeSubscription(manager,merchantId,input,current,!current);
    });
    return this.getSubscription(resultId);
  }

  async deleteSubscription(id: string) {
    await this.transaction(async manager=>{
      const [row] = await manager.query('SELECT merchant_id FROM public.subscriptions WHERE id=$1',[id]);
      if (!row) throw new NotFoundException('Subscription not found');
      await manager.query('DELETE FROM public.subscriptions WHERE id=$1',[id]);
    });
    return {success:true,id};
  }
}
