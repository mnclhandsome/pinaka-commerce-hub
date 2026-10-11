import { BadRequestException } from '@nestjs/common';
import type { AddedLineInput } from '../../calculations/order-update.calculations';
import type {
  AddOrderItemsDto,
  AddOrderLineDto,
  ApplyCouponDto,
  ApplyDiscountDto,
  CancelOrderDto,
  TaxOverrideDto,
} from './dto/order-update.dto';
import type { AddItemsCommand, CancelOrderCommand, CouponCommand, DiscountCommand, TaxCommand } from './order-update.types';

const COUPON_TYPES = new Set(['percent', 'fixed_cart', 'fixed_product']);
const DISCOUNT_TYPES = new Set(['fixed', 'percent', 'fixed_cart']);

export function couponFromDto(dto: ApplyCouponDto): CouponCommand {
  const discountType = dto.discount_type ?? dto.discountType;
  if (!discountType || !COUPON_TYPES.has(discountType)) {
    throw new BadRequestException('discount_type must be percent, fixed_cart, or fixed_product');
  }
  return {
    code: dto.code.trim(),
    discountType,
    amount: Number(dto.amount),
    productIds: idList(dto.product_ids ?? dto.productIds),
    includeFees: dto.include_fees ?? dto.includeFees,
    tax: taxFromDto(dto.tax),
  };
}

export function discountFromDto(dto: ApplyDiscountDto): DiscountCommand {
  const raw = dto.type ?? dto.discount_type ?? dto.discountType;
  if (!raw || !DISCOUNT_TYPES.has(raw)) {
    throw new BadRequestException('type must be fixed or percent');
  }
  const type: DiscountCommand['type'] = raw === 'percent' ? 'percent' : 'fixed';
  return {
    type,
    amount: Number(dto.amount),
    reason: dto.reason,
    includeFees: dto.include_fees ?? dto.includeFees,
    tax: taxFromDto(dto.tax),
  };
}

export function itemsFromDto(dto: AddOrderItemsDto): AddItemsCommand {
  const lines = dto.line_items ?? dto.lineItems ?? dto.items;
  if (!lines?.length) {
    throw new BadRequestException('line_items must contain at least 1 item');
  }
  return {
    items: lines.map(lineFromDto),
    includeFees: dto.include_fees ?? dto.includeFees,
    tax: taxFromDto(dto.tax),
  };
}

export function cancelFromDto(dto?: CancelOrderDto): CancelOrderCommand {
  return {
    changedBy: (dto?.changed_by ?? dto?.changedBy ?? 'Manager').trim() || 'Manager',
    reason: (dto?.reason ?? 'Customer Requested Cancellation').trim() || 'Customer Requested Cancellation',
  };
}

function lineFromDto(line: AddOrderLineDto): AddedLineInput {
  return {
    product_id: asId(line.product_id) ?? asId(line.productId),
    name: line.name ?? line.productName,
    quantity: line.quantity,
    unit_price: line.unit_price ?? line.unitPrice ?? line.price,
    subtotal: line.subtotal,
    total: line.total,
    sku: line.sku,
    variation_id: line.variation_id,
    meta_data: line.meta_data,
    product_data: line.product_data,
  };
}

function taxFromDto(tax?: TaxOverrideDto): TaxCommand | undefined {
  if (!tax) return undefined;
  return {
    rate: Number(tax.rate),
    pricesIncludeTax: Boolean(tax.prices_include_tax ?? tax.pricesIncludeTax),
    calculation: tax.calculation,
    label: tax.label,
  };
}

function idList(values?: Array<string | number>): string[] {
  return (values || []).map((value) => asId(value)).filter((value): value is string => Boolean(value));
}

function asId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new BadRequestException('product_id must be a string or number');
}
