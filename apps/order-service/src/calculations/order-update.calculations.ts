import {
  fromMinor,
  isMerchandiseLine,
  toMinor,
  type PosFeeLine,
  type PosLineItem,
} from './store-order.calculations';

export { isMerchandiseLine };

export type CouponDiscountType = 'percent' | 'fixed_cart' | 'fixed_product';

export type OrderLine = PosLineItem & {
  product_data?: unknown;
  sku?: string;
  price?: number | string;
  variation_id?: number | string;
  productId?: string;
  productName?: string;
  unit_price?: number | string;
  unitPrice?: number | string;
};

export interface CouponSpec {
  code: string;
  discountType: CouponDiscountType;
  amount: number;
  productIds?: string[];
  excludedProductIds?: string[];
}

export interface AddedLineInput {
  product_id?: string;
  productId?: string;
  name?: string;
  productName?: string;
  quantity?: number | string;
  unit_price?: number | string;
  unitPrice?: number | string;
  price?: number | string;
  subtotal?: number | string;
  total?: number | string;
  sku?: string;
  variation_id?: string | number;
  meta_data?: Array<{ key?: string; value?: unknown }>;
  product_data?: unknown;
}

export class OrderCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderCalculationError';
  }
}

export function moneyAmount(value: unknown, places = 2): number {
  return fromMinor(toMinor(value, places), places);
}

/**
 * Discount-named and negative fee lines stay on the order, but they are not added
 * into the total unless the caller explicitly includes every fee line.
 */
export function selectFeeLines(
  feeLines: PosFeeLine[] = [],
  includeFees?: boolean,
  places = 2,
): PosFeeLine[] {
  if (includeFees === true) return feeLines;
  if (includeFees === false) return [];
  return feeLines.filter((fee) => {
    const name = String(fee?.name || '').toLowerCase();
    if (name.includes('discount')) return false;
    return toMinor(fee?.total ?? 0, places) > 0;
  });
}

export function normalizeAddedLine(item: AddedLineInput, places = 2): OrderLine {
  const productId = String(item.product_id ?? item.productId ?? '').trim();
  if (!productId) throw new OrderCalculationError('Each item needs a product id');
  const quantity = Number(item.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new OrderCalculationError('Each item needs a quantity greater than zero');
  }
  const unit = item.unit_price ?? item.unitPrice ?? item.price;
  const hasPrice = unit !== undefined || item.subtotal !== undefined || item.total !== undefined;
  if (!hasPrice) {
    throw new OrderCalculationError(`Item '${productId}' needs a price, subtotal, or total`);
  }
  const subtotal = item.subtotal !== undefined
    ? moneyAmount(item.subtotal, places)
    : unit !== undefined
      ? moneyAmount(Number(unit) * quantity, places)
      : moneyAmount(item.total, places);
  const total = item.total !== undefined ? moneyAmount(item.total, places) : subtotal;
  if (toMinor(total, places) > toMinor(subtotal, places)) {
    throw new OrderCalculationError(`Item '${productId}' total cannot exceed its subtotal`);
  }
  const line: OrderLine = {
    product_id: productId,
    name: String(item.name || item.productName || 'Sales Item'),
    quantity,
    subtotal: subtotal.toFixed(places),
    total: total.toFixed(places),
    meta_data: Array.isArray(item.meta_data) ? item.meta_data : [],
  };
  if (item.sku) line.sku = item.sku;
  if (item.variation_id !== undefined) line.variation_id = item.variation_id;
  if (item.product_data !== undefined) line.product_data = item.product_data;
  return line;
}

const COUPON_BASE_KEY = '_pos_coupon_base';

/** Restore the line total from before coupons so a later coupon replaces, rather than stacks on, the previous one. */
export function withCouponBase(line: OrderLine, places = 2): OrderLine {
  const meta = Array.isArray(line.meta_data) ? line.meta_data.map((entry) => ({ ...entry })) : [];
  const existing = meta.find((entry) => entry?.key === COUPON_BASE_KEY);
  const base = existing
    ? moneyAmount(existing.value, places).toFixed(places)
    : moneyAmount(line.total ?? line.subtotal ?? 0, places).toFixed(places);
  if (!existing) meta.push({ key: COUPON_BASE_KEY, value: base });
  return { ...line, total: base, meta_data: meta };
}

export function applyCoupon(
  lineItems: OrderLine[],
  coupon: CouponSpec,
  places = 2,
  onlyIndexes?: ReadonlySet<number>,
): { lineItems: OrderLine[]; discount: number } {
  const include = (line: OrderLine, index: number) => {
    if (onlyIndexes && !onlyIndexes.has(index)) return false;
    if (!isMerchandiseLine(line)) return false;
    const productId = String(line.product_id ?? line.productId ?? '');
    if (coupon.excludedProductIds?.some((id) => id === productId)) return false;
    if (coupon.productIds?.length) return coupon.productIds.some((id) => id === productId);
    return true;
  };

  if (coupon.discountType === 'percent') {
    return applyPercentDiscount(lineItems, coupon.amount, places, include);
  }
  if (coupon.discountType === 'fixed_product') {
    return applyFixedProductDiscount(lineItems, coupon.amount, places, include);
  }
  return applyAmountToCurrentTotals(lineItems, coupon.amount, places, include);
}

export function replayCouponsOnLines(
  lineItems: OrderLine[],
  couponLines: unknown[],
  onlyIndexes: ReadonlySet<number>,
  places = 2,
): { lineItems: OrderLine[]; couponLines: unknown[] } {
  let nextLines = lineItems;
  let nextCoupons = couponLines;
  couponLines.forEach((line) => {
    const coupon = couponSpecFromLine(line);
    if (!coupon || coupon.discountType === 'fixed_cart' || coupon.amount <= 0) return;
    const applied = applyCoupon(nextLines, coupon, places, onlyIndexes);
    if (applied.discount <= 0) return;
    nextLines = applied.lineItems;
    nextCoupons = addCouponDiscount(nextCoupons, coupon.code, applied.discount, places);
  });
  return { lineItems: nextLines, couponLines: nextCoupons };
}

export function couponSpecFromLine(line: unknown): CouponSpec | null {
  if (!line || typeof line !== 'object') return null;
  const record = line as { code?: unknown; meta_data?: Array<{ key?: string; value?: unknown }> };
  const meta = Array.isArray(record.meta_data) ? record.meta_data : [];
  const read = (key: string) => meta.find((entry) => entry?.key === key)?.value;
  const discountType = read('discount_type');
  if (discountType !== 'percent' && discountType !== 'fixed_cart' && discountType !== 'fixed_product') {
    return null;
  }
  const productIds = read('product_ids');
  const excludedProductIds = read('excluded_product_ids');
  return {
    code: String(record.code || ''),
    discountType,
    amount: Number(read('amount') || 0),
    productIds: Array.isArray(productIds) ? productIds.map((id) => String(id)) : [],
    excludedProductIds: Array.isArray(excludedProductIds) ? excludedProductIds.map((id) => String(id)) : [],
  };
}

export function buildCouponLine(
  coupon: CouponSpec,
  discount: number,
  places = 2,
  reason?: string,
): Record<string, unknown> {
  const metaData: Array<{ key: string; value: unknown }> = [
    { key: 'discount_type', value: coupon.discountType },
    { key: 'amount', value: String(coupon.amount) },
    { key: 'product_ids', value: coupon.productIds || [] },
    { key: 'excluded_product_ids', value: coupon.excludedProductIds || [] },
  ];
  if (reason) metaData.push({ key: 'reason', value: reason });
  return {
    code: coupon.code,
    discount: moneyAmount(discount, places).toFixed(places),
    discount_tax: moneyAmount(0, places).toFixed(places),
    meta_data: metaData,
  };
}

export function addCouponDiscount(
  couponLines: unknown[],
  code: string,
  extra: number,
  places = 2,
): unknown[] {
  const target = code.trim().toLowerCase();
  return couponLines.map((line) => {
    if (!line || typeof line !== 'object') return line;
    const record = line as { code?: unknown; discount?: unknown };
    if (String(record.code || '').trim().toLowerCase() !== target) return line;
    const next = fromMinor(toMinor(record.discount ?? 0, places) + toMinor(extra, places), places);
    return { ...record, discount: next.toFixed(places) };
  });
}

export function nextDiscountCode(couponLines: unknown[] = []): string {
  const used = new Set(
    couponLines
      .filter((line): line is { code?: unknown } => Boolean(line) && typeof line === 'object')
      .map((line) => String(line.code || '').trim().toLowerCase()),
  );
  let code = 'pos-discount';
  let sequence = 1;
  while (used.has(code)) {
    sequence += 1;
    code = `pos-discount-${sequence}`;
  }
  return code;
}

export function applyPercentDiscount(
  lineItems: OrderLine[],
  percent: number,
  places = 2,
  include: (line: OrderLine, index: number) => boolean = (line) => isMerchandiseLine(line),
): { lineItems: OrderLine[]; discount: number } {
  if (percent <= 0) {
    return { lineItems: lineItems.map((line) => withSubtotal(line, places)), discount: 0 };
  }
  const basisPoints = Math.round(percent * 100);
  let discountMinor = 0;
  const next = lineItems.map((line, index) => {
    const prepared = withSubtotal(line, places);
    if (!include(prepared, index)) return prepared;
    const current = lineTotalMinor(prepared, places);
    const reduction = Math.min(current, Math.round((current * basisPoints) / 10000));
    discountMinor += reduction;
    return { ...prepared, total: fromMinor(current - reduction, places).toFixed(places) };
  });
  return { lineItems: next, discount: fromMinor(discountMinor, places) };
}

export function applyAmountToCurrentTotals(
  lineItems: OrderLine[],
  amount: number,
  places = 2,
  include: (line: OrderLine, index: number) => boolean = (line) => isMerchandiseLine(line),
): { lineItems: OrderLine[]; discount: number } {
  const prepared = lineItems.map((line) => withSubtotal(line, places));
  const eligible = prepared
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => include(line, index));
  const requested = Math.max(0, toMinor(amount, places));
  const base = eligible.reduce((sum, { line }) => sum + lineTotalMinor(line, places), 0);
  const discount = Math.min(requested, base);
  if (!discount || !base) return { lineItems: prepared, discount: 0 };

  let allocated = 0;
  const reductions = new Map<number, number>();
  eligible.forEach(({ line, index }, position) => {
    const current = lineTotalMinor(line, places);
    const isLast = position === eligible.length - 1;
    const share = isLast
      ? Math.max(0, discount - allocated)
      : Math.round((discount * current) / base);
    const reduction = Math.min(current, share);
    allocated += reduction;
    reductions.set(index, reduction);
  });

  let remainder = discount - allocated;
  if (remainder > 0) {
    for (const { line, index } of eligible) {
      if (remainder <= 0) break;
      const room = lineTotalMinor(line, places) - (reductions.get(index) || 0);
      if (room <= 0) continue;
      const extra = Math.min(room, remainder);
      reductions.set(index, (reductions.get(index) || 0) + extra);
      remainder -= extra;
    }
  }

  const next = prepared.map((line, index) => {
    const reduction = reductions.get(index) || 0;
    if (!reduction) return line;
    const current = lineTotalMinor(line, places);
    return { ...line, total: fromMinor(current - reduction, places).toFixed(places) };
  });
  return { lineItems: next, discount: fromMinor(discount - remainder, places) };
}

function applyFixedProductDiscount(
  lineItems: OrderLine[],
  amount: number,
  places = 2,
  include: (line: OrderLine, index: number) => boolean,
): { lineItems: OrderLine[]; discount: number } {
  let discountMinor = 0;
  const next = lineItems.map((line, index) => {
    const prepared = withSubtotal(line, places);
    if (!include(prepared, index)) return prepared;
    const current = lineTotalMinor(prepared, places);
    const quantity = Math.max(0, Number(prepared.quantity || 1));
    const requested = toMinor(Number(amount) * (Number.isFinite(quantity) && quantity > 0 ? quantity : 1), places);
    const reduction = Math.min(current, Math.max(0, requested));
    discountMinor += reduction;
    return { ...prepared, total: fromMinor(current - reduction, places).toFixed(places) };
  });
  return { lineItems: next, discount: fromMinor(discountMinor, places) };
}

function withSubtotal(line: OrderLine, places: number): OrderLine {
  if (line.subtotal !== undefined && line.subtotal !== null && String(line.subtotal) !== '') return line;
  return { ...line, subtotal: fromMinor(lineTotalMinor(line, places), places).toFixed(places) };
}

function lineTotalMinor(line: OrderLine, places: number): number {
  return Math.max(0, toMinor(line.total ?? line.subtotal ?? 0, places));
}
