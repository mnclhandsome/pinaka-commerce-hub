export interface PosLineItem {
  product_id?: number | string;
  name?: string;
  quantity?: number | string;
  subtotal?: number | string;
  total?: number | string;
  meta_data?: Array<{ key?: string; value?: unknown }>;
}

export interface PosFeeLine {
  name?: string;
  total?: number | string;
  tax_status?: string;
}

export interface PosTaxLine {
  rate_code?: string;
  label?: string;
  rate_percent?: number;
  tax_total?: number | string;
  shipping_tax_total?: number | string;
}

export interface PosPayment {
  method?: string;
  amount?: number | string;
  status?: string;
}

export type TaxCalculationMode = 'item-price' | 'subtotal' | 'total';

export interface TaxCalculationInput {
  lineItems?: PosLineItem[];
  feeLines?: PosFeeLine[];
  rate: number;
  pricesIncludeTax?: boolean;
  calculation?: TaxCalculationMode;
  decimalPlaces?: number;
  label?: string;
}

export interface StoreOrderCalculationInput {
  lineItems?: PosLineItem[];
  feeLines?: PosFeeLine[];
  taxLines?: PosTaxLine[];
  payments?: PosPayment[];
  /** When omitted, line totals stay as sent. */
  discountAmount?: number;
  /** When omitted, tax_lines stay as sent (an empty array stays empty). */
  tax?: Omit<TaxCalculationInput, 'lineItems' | 'feeLines'>;
  /** When omitted, fee lines are not included in the total. */
  includeFees?: boolean;
  /** When omitted, payments stay as an empty contribution to the total. */
  includePayments?: boolean;
  /** When omitted, the cashback tier fee is not looked up. */
  includeCashbackFee?: boolean;
  cashbackAmount?: number;
  shippingTotal?: number;
  decimalPlaces?: number;
}

export interface StoreOrderTotals {
  subtotal: number;
  discountTotal: number;
  lineTotal: number;
  feeTotal: number;
  taxTotal: number;
  shippingTotal: number;
  total: number;
}

const NON_MERCHANDISE = new Set(['cashback', 'payout']);

export function isMerchandiseLine(line: PosLineItem): boolean {
  return !NON_MERCHANDISE.has(String(line?.name || '').trim().toLowerCase());
}

export function toMinor(value: unknown, places = 2): number {
  const factor = 10 ** places;
  const numeric = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * factor);
}

export function fromMinor(minor: number, places = 2): number {
  return Math.round(minor) / 10 ** places;
}

export function sumLineSubtotals(lineItems: PosLineItem[] = [], places = 2): number {
  const minor = lineItems.reduce(
    (sum, line) => sum + toMinor(line?.subtotal ?? line?.total ?? 0, places),
    0,
  );
  return fromMinor(minor, places);
}

export function sumLineTotals(lineItems: PosLineItem[] = [], places = 2): number {
  const minor = lineItems.reduce(
    (sum, line) => sum + toMinor(line?.total ?? line?.subtotal ?? 0, places),
    0,
  );
  return fromMinor(minor, places);
}

/**
 * Spreads a fixed amount across merchandise lines by subtotal.
 * The last merchandise line takes the remainder. Cashback and Payout lines are unchanged.
 */
export function allocateFixedDiscount(
  lineItems: PosLineItem[] = [],
  amount: number,
  places = 2,
): PosLineItem[] {
  const discount = Math.max(0, toMinor(amount, places));
  const merchandise = lineItems
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => isMerchandiseLine(line));
  const base = merchandise.reduce(
    (sum, { line }) => sum + Math.max(0, toMinor(line.subtotal ?? line.total ?? 0, places)),
    0,
  );
  if (!discount || !base) return lineItems.map((line) => ({ ...line }));

  let allocated = 0;
  const reductions = new Map<number, number>();
  merchandise.forEach(({ line, index }, position) => {
    const subtotal = Math.max(0, toMinor(line.subtotal ?? line.total ?? 0, places));
    const isLast = position === merchandise.length - 1;
    const share = isLast ? Math.max(0, discount - allocated) : Math.round((discount * subtotal) / base);
    const reduction = Math.min(subtotal, share);
    allocated += reduction;
    reductions.set(index, reduction);
  });

  return lineItems.map((line, index) => {
    const reduction = reductions.get(index);
    if (reduction == null) return { ...line };
    const subtotal = Math.max(0, toMinor(line.subtotal ?? line.total ?? 0, places));
    return { ...line, total: fromMinor(subtotal - reduction, places).toFixed(places) };
  });
}

export function calculateFeeTotal(feeLines: PosFeeLine[] = [], places = 2): number {
  const minor = feeLines.reduce((sum, fee) => sum + toMinor(fee?.total ?? 0, places), 0);
  return fromMinor(minor, places);
}

export function sumPayments(payments: PosPayment[] = [], places = 2): number {
  const minor = payments.reduce((sum, payment) => sum + toMinor(payment?.amount ?? 0, places), 0);
  return fromMinor(minor, places);
}

export function sumPaymentsByMethod(payments: PosPayment[] = [], method: string, places = 2): number {
  const target = method.trim().toLowerCase();
  const matched = payments.filter((payment) => String(payment?.method || '').trim().toLowerCase() === target);
  return sumPayments(matched, places);
}

function isEbtEligible(line: PosLineItem): boolean {
  const meta = Array.isArray(line.meta_data) ? line.meta_data : [];
  const value = meta.find((entry) => entry?.key === '_is_ebt_eligible')?.value;
  return value === 1 || value === '1' || value === true;
}

function taxOn(amountMinor: number, ratePercent: number, pricesIncludeTax: boolean): number {
  if (amountMinor === 0 || ratePercent <= 0) return 0;
  const rate = ratePercent / 100;
  const sign = amountMinor < 0 ? -1 : 1;
  const amount = Math.abs(amountMinor);
  const tax = pricesIncludeTax
    ? Math.round(amount - amount / (1 + rate))
    : Math.round(amount * rate);
  return sign * tax;
}

/** Returns [] when no rate is supplied or the computed tax is zero. */
export function calculateTaxLines(input: TaxCalculationInput): PosTaxLine[] {
  const places = input.decimalPlaces ?? 2;
  const rate = Number(input.rate || 0);
  if (rate <= 0) return [];

  const pricesIncludeTax = Boolean(input.pricesIncludeTax);
  const lineAmounts = (input.lineItems || [])
    .filter((line) => isMerchandiseLine(line) && !isEbtEligible(line))
    .map((line) => Math.max(0, toMinor(line.total ?? line.subtotal ?? 0, places)));
  const feeAmounts = (input.feeLines || [])
    .filter((fee) => String(fee?.tax_status || 'taxable').toLowerCase() !== 'none')
    .map((fee) => toMinor(fee?.total ?? 0, places));

  const mode = input.calculation || 'item-price';
  const taxMinor = mode === 'item-price'
    ? [...lineAmounts, ...feeAmounts].reduce((sum, amount) => sum + taxOn(amount, rate, pricesIncludeTax), 0)
    : taxOn(
      Math.max(0, [...lineAmounts, ...feeAmounts].reduce((sum, amount) => sum + amount, 0)),
      rate,
      pricesIncludeTax,
    );

  if (!taxMinor) return [];
  return [{
    rate_code: 'POS-TAX-1',
    label: input.label || 'Tax',
    rate_percent: rate,
    tax_total: fromMinor(taxMinor, places).toFixed(places),
    shipping_tax_total: fromMinor(0, places).toFixed(places),
  }];
}

/**
 * WooCommerce total: line totals + fees + tax + shipping.
 * Discount is already inside line totals, so it is not subtracted again.
 * Fees, tax, and payments are included only when the caller asks for them.
 */
export function calculateOrderTotal(input: {
  lineItems?: PosLineItem[];
  feeLines?: PosFeeLine[];
  taxLines?: PosTaxLine[];
  shippingTotal?: number;
  decimalPlaces?: number;
}): StoreOrderTotals {
  const places = input.decimalPlaces ?? 2;
  const subtotal = sumLineSubtotals(input.lineItems, places);
  const lineTotal = sumLineTotals(input.lineItems, places);
  const feeTotal = calculateFeeTotal(input.feeLines, places);
  const taxMinor = (input.taxLines || []).reduce(
    (sum, tax) => sum + toMinor(tax?.tax_total ?? 0, places) + toMinor(tax?.shipping_tax_total ?? 0, places),
    0,
  );
  const taxTotal = fromMinor(taxMinor, places);
  const shippingTotal = fromMinor(toMinor(input.shippingTotal ?? 0, places), places);
  const discountTotal = fromMinor(Math.max(0, toMinor(subtotal, places) - toMinor(lineTotal, places)), places);
  const total = fromMinor(
    toMinor(lineTotal, places) + toMinor(feeTotal, places) + taxMinor + toMinor(shippingTotal, places),
    places,
  );
  return { subtotal, discountTotal, lineTotal, feeTotal, taxTotal, shippingTotal, total };
}

export function calculateStoreOrder(input: StoreOrderCalculationInput = {}) {
  const places = input.decimalPlaces ?? input.tax?.decimalPlaces ?? 2;
  const sourceLines = input.lineItems || [];
  const lineItems = input.discountAmount === undefined
    ? sourceLines
    : allocateFixedDiscount(sourceLines, input.discountAmount, places);
  const feeLines = input.feeLines || [];
  const appliedFees = input.includeFees ? feeLines : [];
  const taxLines = input.tax
    ? calculateTaxLines({ ...input.tax, lineItems, feeLines: appliedFees, decimalPlaces: places })
    : (input.taxLines || []);
  const payments = input.includePayments ? (input.payments || []) : [];
  return {
    lineItems,
    feeLines,
    taxLines,
    payments,
    paymentTotal: input.includePayments ? sumPayments(input.payments || [], places) : 0,
    totals: calculateOrderTotal({
      lineItems,
      feeLines: appliedFees,
      taxLines,
      shippingTotal: input.shippingTotal,
      decimalPlaces: places,
    }),
  };
}
