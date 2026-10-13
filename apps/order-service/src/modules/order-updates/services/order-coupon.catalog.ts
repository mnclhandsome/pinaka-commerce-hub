import { BadRequestException, Injectable } from '@nestjs/common';
import type { CouponSpec } from '../../../calculations/order-update.calculations';

@Injectable()
export class OrderCouponCatalog {
  resolve(code: string): CouponSpec {
    const key = code.trim().toLowerCase();
    const coupon = this.defined().find((entry) => entry.code.toLowerCase() === key);
    if (!coupon) throw new BadRequestException(`Coupon '${code}' was not found`);
    return { ...coupon, productIds: [] };
  }

  private defined(): CouponSpec[] {
    return [
      { code: '2024', discountType: 'percent', amount: 10 },
      { code: '2025', discountType: 'fixed_cart', amount: 10 },
    ];
  }
}
