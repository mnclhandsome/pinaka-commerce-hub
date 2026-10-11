import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { nextDiscountCode } from '../../../calculations/order-update.calculations';
import type { DiscountCommand, OrderGraph, OrderMutationDraft } from '../order-update.types';
import { OrderCouponService } from './order-coupon.service';
import { OrderUpdatePolicy } from './order-update.policy';

@Injectable()
export class OrderDiscountService {
  constructor(
    @Inject(OrderUpdatePolicy) private readonly policy: OrderUpdatePolicy,
    @Inject(OrderCouponService) private readonly coupons: OrderCouponService,
  ) {}

  apply(graph: OrderGraph, command: DiscountCommand): OrderMutationDraft {
    this.policy.assertMutable(graph);
    const store = this.policy.requireStoreOrder(graph);
    if (command.amount <= 0) {
      throw new BadRequestException('Discount amount must be greater than zero');
    }
    if (command.type === 'percent' && command.amount > 100) {
      throw new BadRequestException('Percent discount must be between 0 and 100');
    }
    const couponLines = Array.isArray(store.couponLines) ? store.couponLines : [];
    return this.coupons.apply(graph, {
      code: nextDiscountCode(couponLines),
      discountType: command.type === 'percent' ? 'percent' : 'fixed_cart',
      amount: command.amount,
      productIds: [],
      includeFees: command.includeFees,
      tax: command.tax,
      reason: command.reason,
    });
  }
}
