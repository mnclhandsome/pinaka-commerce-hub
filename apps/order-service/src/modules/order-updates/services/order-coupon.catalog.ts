import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  isMerchandiseLine,
  moneyAmount,
  type CouponDiscountType,
  type CouponSpec,
  type OrderLine,
} from '../../../calculations/order-update.calculations';
import { OrderRepository } from '../../../order.repository';

export interface CouponLookup {
  storeId: string;
  code: string;
  lines: OrderLine[];
  email?: string;
  couponCount: number;
}

@Injectable()
export class OrderCouponCatalog {
  constructor(@Inject(OrderRepository) private readonly orders: OrderRepository) {}

  async resolve(lookup: CouponLookup): Promise<CouponSpec> {
    const code = lookup.code.trim();
    if (!code) throw new BadRequestException('Coupon code is required');
    const row = await this.orders.findStoreCoupon(lookup.storeId, code);
    if (!row) throw new BadRequestException(`Coupon '${code}' was not found`);

    const savedCode = String(row.code || code);
    const discountType = this.discountType(savedCode, row.discount_type);
    const amount = Number(row.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException(`Coupon '${savedCode}' has no discount amount`);
    }
    if (discountType === 'percent' && amount > 100) {
      throw new BadRequestException(`Coupon '${savedCode}' percent must be between 0 and 100`);
    }
    this.assertActive(savedCode, row);
    this.assertCustomer(savedCode, row, lookup);
    this.assertSpend(savedCode, row, lookup.lines);
    if (row.individual_use === true && lookup.couponCount > 1) {
      throw new BadRequestException(`Coupon '${savedCode}' cannot be combined with other coupons`);
    }

    const productIds = this.ids(row.product_ids);
    const excludedProductIds = this.excludedIds(row, lookup.lines);
    if (!this.hasEligibleLine(lookup.lines, productIds, excludedProductIds)) {
      throw new BadRequestException(`Coupon '${savedCode}' does not apply to the items in this order`);
    }
    return {
      code: savedCode,
      discountType,
      amount,
      productIds,
      excludedProductIds,
    };
  }

  private assertActive(code: string, row: Record<string, unknown>): void {
    if (row.date_expires && new Date(String(row.date_expires)).getTime() <= Date.now()) {
      throw new BadRequestException(`Coupon '${code}' has expired`);
    }
    const limit = this.optionalNumber(row.usage_limit);
    if (limit !== undefined && Number(row.usage_count || 0) >= limit) {
      throw new BadRequestException(`Coupon '${code}' has reached its usage limit`);
    }
  }

  private assertCustomer(code: string, row: Record<string, unknown>, lookup: CouponLookup): void {
    const allowed = this.texts(row.email_restrictions).map((email) => email.toLowerCase());
    const email = String(lookup.email || '').trim().toLowerCase();
    if (allowed.length && !allowed.includes(email)) {
      throw new BadRequestException(`Coupon '${code}' is not valid for this customer`);
    }
    const perUser = this.optionalNumber(row.usage_limit_per_user);
    if (perUser !== undefined && email) {
      const used = this.texts(row.used_by).filter((entry) => entry.toLowerCase() === email).length;
      if (used >= perUser) throw new BadRequestException(`Coupon '${code}' has already been used by this customer`);
    }
  }

  private assertSpend(code: string, row: Record<string, unknown>, lines: OrderLine[]): void {
    const cart = lines
      .filter((line) => isMerchandiseLine(line))
      .reduce((sum, line) => sum + moneyAmount(line.total ?? line.subtotal), 0);
    const minimum = Number(row.minimum_amount || 0);
    const maximum = Number(row.maximum_amount || 0);
    if (minimum > 0 && cart + 0.0001 < minimum) {
      throw new BadRequestException(`Coupon '${code}' requires a minimum of ${minimum.toFixed(2)}`);
    }
    if (maximum > 0 && cart - 0.0001 > maximum) {
      throw new BadRequestException(`Coupon '${code}' is limited to orders of ${maximum.toFixed(2)} or less`);
    }
  }

  private hasEligibleLine(lines: OrderLine[], productIds: string[], excludedProductIds: string[]): boolean {
    return lines.some((line) => {
      if (!isMerchandiseLine(line)) return false;
      const productId = String(line.product_id ?? line.productId ?? '');
      if (excludedProductIds.includes(productId)) return false;
      if (productIds.length && !productIds.includes(productId)) return false;
      return moneyAmount(line.total ?? line.subtotal) > 0;
    });
  }

  private excludedIds(row: Record<string, unknown>, lines: OrderLine[]): string[] {
    const excluded = new Set(this.ids(row.excluded_product_ids));
    if (row.exclude_sale_items === true) {
      lines.forEach((line) => {
        const product = (line as { product_data?: { on_sale?: boolean } }).product_data;
        if (product?.on_sale === true) excluded.add(String(line.product_id ?? line.productId ?? ''));
      });
    }
    return [...excluded].filter(Boolean);
  }

  private discountType(code: string, value: unknown): CouponDiscountType {
    const type = String(value || '').trim().toLowerCase();
    if (type === 'percent') return 'percent';
    if (type === 'fixed_product' || type === 'fixed_item') return 'fixed_product';
    if (type === 'fixed_cart' || type === 'fixed') return 'fixed_cart';
    throw new BadRequestException(`Coupon '${code}' has an unsupported discount type`);
  }

  private ids(value: unknown): string[] {
    return this.list(value).map((entry) => String(entry)).filter(Boolean);
  }

  private texts(value: unknown): string[] {
    return this.list(value).map((entry) => String(entry).trim()).filter(Boolean);
  }

  private list(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  private optionalNumber(value: unknown): number | undefined {
    if (value === null || value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
