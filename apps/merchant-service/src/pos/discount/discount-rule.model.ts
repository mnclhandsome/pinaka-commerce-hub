export interface DiscountRule {
  ruleId: string;
  ruleType: 'auto' | 'mixmatch' | 'multipack';
  productIds: number[];
  bundlePrice: number;
  requiredQty: number;
  bundlePriceType: 'price' | 'percentage';
  active: boolean;
  startDate?: string;
  endDate?: string;
  minimumAmount?: string | number;
  maximumAmount?: string | number;
  requiredProductIds?: number;
}

export function mapDiscountRules(payload: unknown, productId?: string): DiscountRule[] {
  const source = asRecord(payload);
  const rules: DiscountRule[] = [
    ...asList(source.auto).map(mapAutoRule),
    ...asList(source.mix_match).map(mapMixMatchRule),
    ...asList(source.multipack).map((record, index) => mapMultipackRule(record, index)),
  ];
  const filter = Number(productId);
  if (!productId || !Number.isInteger(filter) || filter <= 0) return rules;
  return rules.filter(rule =>
    rule.productIds.includes(filter) || rule.requiredProductIds === filter,
  );
}

function mapAutoRule(record: Record<string, unknown>): DiscountRule {
  return {
    ruleId: `AUTO_${ruleKey(record)}`,
    ruleType: 'auto',
    productIds: productIds(record.product_id ?? record.product_label),
    bundlePrice: amount(record.coupon_amount ?? record.amount ?? record.discount),
    requiredQty: 0,
    bundlePriceType: record.discount_type === 'fixed_cart' || record.discount_type === 'price' ? 'price' : 'percentage',
    startDate: text(record.start_date ?? record.startDate ?? record.date_starts),
    endDate: text(record.expiry_date ?? record.end_date ?? record.endDate ?? record.date_expires),
    minimumAmount: record.minimum_amount ?? record.minimumAmount ?? '',
    maximumAmount: record.maximum_amount ?? record.maximumAmount ?? '',
    active: record.active !== false,
  };
}

function mapMixMatchRule(record: Record<string, unknown>): DiscountRule {
  const required = firstId(record.required_product_ids ?? record.required_products ?? record.required_product_id ?? record.product_id);
  return {
    ruleId: `MM_${ruleKey(record)}`,
    ruleType: 'mixmatch',
    productIds: productIds(record.discount_product_ids ?? record.product_ids),
    requiredProductIds: required,
    requiredQty: 0,
    bundlePrice: amount(record.coupon_amount ?? record.amount ?? record.discount),
    bundlePriceType: record.discount_type === 'fixed_item' || record.discount_type === 'price' ? 'price' : 'percentage',
    active: record.active !== false,
  };
}

function mapMultipackRule(record: Record<string, unknown>, index: number): DiscountRule {
  const rawDiscount = String(record.discount ?? record.coupon_amount ?? record.amount ?? '');
  const discountType = String(record.discount_type ?? '').toLowerCase();
  const percentage = rawDiscount.includes('%') || discountType === 'percent' || discountType === 'percentage';
  return {
    ruleId: `MP_${record.id ?? record.wordpressId ?? index}`,
    ruleType: 'multipack',
    productIds: productIds(record.product_id ?? record.main_product_id),
    requiredQty: wholeNumber(record.qty ?? record.quantity ?? record.required_quantity),
    bundlePrice: amount(rawDiscount),
    bundlePriceType: percentage ? 'percentage' : 'price',
    startDate: text(record.start_date ?? record.startDate ?? record.date_starts),
    endDate: text(record.expiry_date ?? record.end_date ?? record.endDate ?? record.date_expires),
    active: record.active !== false,
  };
}

function ruleKey(record: Record<string, unknown>): string | number {
  const id = record.id ?? record.wordpressId ?? record.pchId;
  return typeof id === 'string' || typeof id === 'number' ? id : '';
}

function productIds(value: unknown): number[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  return values.map(item => Number(item)).filter(item => Number.isInteger(item) && item > 0);
}

function firstId(value: unknown): number {
  return productIds(value)[0] ?? 0;
}

function amount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function wholeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}
