import { DataSource } from 'typeorm';

type Row = Record<string, any>;
type Kind = 'plan' | 'subscription' | 'merchant' | 'storeType';
const aliases: Record<Kind, string[]> = {
  plan:['planId','plan_id'], subscription:['subscriptionId','subscription_id'],
  merchant:['merchantId','merchant_id'], storeType:['storeTypeId','store_type_id'],
};
const kinds = Object.keys(aliases) as Kind[];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = (value: string) => uuid.test(value) ? value.toLowerCase() : value;
const isRecord = (value: unknown): value is Row => !!value && typeof value==='object' && !Array.isArray(value) && !(value instanceof Date);

/** Request-local batched lookups. Added relations have a bounded shape, never cycles. */
export class MerchantResponseRelations {
  constructor(private readonly db: Pick<DataSource,'query'>) {}

  async expand(payload: unknown): Promise<unknown> {
    try {
      const wanted = Object.fromEntries(kinds.map(kind=>[kind,new Set<string>()])) as Record<Kind,Set<string>>;
      const records = Object.fromEntries(kinds.map(kind=>[kind,new Map<string,Row>()])) as Record<Kind,Map<string,Row>>;
      const reference = (row: Row, kind: Kind) => {
        const name=aliases[kind].find(alias=>Object.prototype.hasOwnProperty.call(row,alias));
        return name===undefined ? undefined : row[name];
      };
      const collectRow = (row: Row, selected: Kind[]=kinds) => {
        for (const kind of selected) {
          const value=reference(row,kind);
          if (typeof value==='string' && value) wanted[kind].add(key(value));
        }
      };
      const scan = (value: unknown) => {
        if (Array.isArray(value)) {value.forEach(scan);return;}
        if (!isRecord(value)) return;
        collectRow(value);
        Object.values(value).forEach(scan);
      };
      scan(payload);

      if (wanted.subscription.size) {
        try {
          const rows = await this.db.query(`SELECT s.*,to_char(s."startDate",'YYYY-MM-DD') AS "startDate",
            to_char(s."renewalDate",'YYYY-MM-DD') AS "renewalDate",to_char(s."trialEndDate",'YYYY-MM-DD') AS "trialEndDate"
            FROM public.subscriptions s WHERE s.id=ANY($1::text[])`,[[...wanted.subscription]]);
          for (const row of rows) {records.subscription.set(key(row.id || row.subscriptionId),row);collectRow(row);}
        } catch {}
      }
      if (wanted.merchant.size) {
        try {
          const rows = await this.db.query(`SELECT requested.ref AS lookup,m.* FROM unnest($1::text[]) requested(ref)
            CROSS JOIN LATERAL (
              SELECT mer.*
              FROM public.merchants mer
              WHERE mer.merchant_id=requested.ref OR mer.id::text=requested.ref OR mer.merchant_code=requested.ref
              ORDER BY CASE WHEN COALESCE(mer.status,'ACTIVE')='ACTIVE' THEN 0 ELSE 1 END,
                COALESCE(mer."createdDate", now()) DESC
              LIMIT 1
            ) m`,[[...wanted.merchant]]);
          for (const {lookup,...row} of rows) {records.merchant.set(key(lookup),row);collectRow(row,['plan','storeType']);}
        } catch {}
      }
      await Promise.all((['plan','storeType'] as const).map(async kind=>{
        try {
          const ids=[...wanted[kind]].filter(value=>uuid.test(value));
          if (!ids.length) return;
          const table=kind==='plan'?'plans':'store_types';
          const rows=await this.db.query(`SELECT * FROM public.${table} WHERE id=ANY($1::uuid[])`,[ids]);
          for (const row of rows) records[kind].set(key(row.id),row);
        } catch {}
      }));

      const storeTypeByText = new Map<string, Row>();
      const rememberStoreType = (row: Row) => {
        records.storeType.set(key(String(row.id)), row);
        for (const name of ['storeTypeCode', 'store_type_code', 'name']) {
          const value = row[name];
          if (typeof value === 'string' && value.trim()) storeTypeByText.set(value.trim().toLowerCase(), row);
        }
      };
      for (const row of records.storeType.values()) rememberStoreType(row);
      const textRefs = new Set<string>();
      const collectTextRef = (row: Row) => {
        for (const name of ['store_type', 'storeType', 'storeTypeName', 'store_type_name', 'storeTypeCode', 'store_type_code']) {
          const value = row[name];
          if (typeof value === 'string' && value.trim() && !uuid.test(value.trim())) textRefs.add(value.trim().toLowerCase());
        }
      };
      const collectTextRefs = (value: unknown) => {
        if (Array.isArray(value)) { value.forEach(collectTextRefs); return; }
        if (!isRecord(value)) return;
        collectTextRef(value);
        Object.values(value).forEach(collectTextRefs);
      };
      collectTextRefs(payload);
      for (const row of records.plan.values()) collectTextRef(row);
      if (textRefs.size) {
        try {
          const rows = await this.db.query(`SELECT * FROM public.store_types st
            WHERE lower(COALESCE(to_jsonb(st)->>'storeTypeCode', to_jsonb(st)->>'store_type_code', '')) = ANY($1::text[])
               OR lower(COALESCE(st.name, '')) = ANY($1::text[])`, [[...textRefs]]);
          for (const row of rows) rememberStoreType(row);
        } catch {}
      }
      const storeTypeFrom = (...rows: Array<Row | null | undefined>): Row | null => {
        for (const row of rows) {
          if (!row) continue;
          for (const name of ['storeTypeId', 'store_type_id', 'store_type', 'storeType', 'storeTypeName', 'store_type_name', 'storeTypeCode', 'store_type_code']) {
            const value = row[name];
            if (typeof value !== 'string' || !value.trim()) continue;
            const match = records.storeType.get(key(value)) || storeTypeByText.get(value.trim().toLowerCase());
            if (match) return match;
          }
        }
        return null;
      };

      const lookup = (kind: Kind, value: unknown): Row | null => typeof value==='string' ? records[kind].get(key(value)) || null : null;
      const isSubscriptionRow = (row: Row) =>
        ('subscriptionCode' in row || 'subscription_code' in row || 'subscriptionId' in row)
        && ('billingCycle' in row || 'billing_cycle' in row)
        && !('ownerName' in row && 'businessName' in row);
      const isStoreTypeMasterRow = (row: Row) =>
        ('storeTypeCode' in row || 'store_type_code' in row)
        && 'name' in row
        && !('storeTypeId' in row || 'store_type_id' in row);
      const attachPlanStoreType = (plan: Row | null, fallback: Row | null) => {
        if (!plan || isRecord(plan.storeType)) return plan;
        const storeType = storeTypeFrom(plan) || fallback;
        return storeType ? { ...plan, storeType, storeTypeId: plan.storeTypeId || storeType.id } : plan;
      };
      const withStoreType = (row: Row, plan: Row | null): Row => {
        const storeType = isRecord(row.storeType) ? row.storeType : storeTypeFrom(row, plan);
        const nextPlan = attachPlanStoreType(plan, storeType);
        return {
          ...row,
          plan: nextPlan,
          storeType: storeType || row.storeType || null,
          storeTypeId: row.storeTypeId || storeType?.id || null,
        };
      };
      const merchantDetails = (row: Row | null): Row | null => {
        if (!row) return row;
        return withStoreType(row, lookup('plan', reference(row, 'plan')));
      };
      const subscriptionDetails = (row: Row | null): Row | null => {
        if (!row) return row;
        const plan = lookup('plan', reference(row, 'plan'));
        const details = { ...withStoreType(row, plan), merchant: merchantDetails(lookup('merchant', reference(row, 'merchant'))) };
        return details;
      };
      const visit = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(visit);
        if (!isRecord(value)) return value;
        const result: Row = Object.fromEntries(Object.entries(value).map(([name,child])=>[name,visit(child)]));
        for (const kind of kinds) {
          if (!aliases[kind].some(alias=>Object.prototype.hasOwnProperty.call(value,alias))) continue;
          if (isRecord(result[kind])) continue;
          if (kind==='merchant' && isSubscriptionRow(value)) continue;
          if (kind==='merchant' && ('merchantCode' in value || ('ownerName' in value && 'businessName' in value))) continue;
          if (kind==='subscription' && value.id===reference(value,kind) && isSubscriptionRow(value)) continue;
          const related=lookup(kind,reference(value,kind));
          const details=kind==='merchant'?merchantDetails(related):kind==='subscription'?subscriptionDetails(related):related;
          const name=kind==='storeType' && result.storeType!==undefined && result.storeType!==null && !isRecord(result.storeType)
            ? 'storeTypeDetails' : kind;
          result[name]=isRecord(result[name]) ? {...details,...result[name]} : details;
        }
        const plan = isRecord(result.plan) ? result.plan : null;
        const storeType = isStoreTypeMasterRow(result)
          ? null
          : isRecord(result.storeType) ? result.storeType : storeTypeFrom(result, plan);
        if (storeType) {
          result.storeType = storeType;
          if (!result.storeTypeId) result.storeTypeId = storeType.id;
          if (plan) result.plan = attachPlanStoreType(plan, null);
        }
        return result;
      };
      return visit(payload);
    } catch {
      return payload;
    }
  }
}
