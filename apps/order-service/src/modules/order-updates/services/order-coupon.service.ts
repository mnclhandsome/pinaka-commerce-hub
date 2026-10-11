import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  applyCoupon,
  buildCouponLine,
} from '../../../calculations/order-update.calculations';
import type { CouponCommand, OrderGraph, OrderMutationDraft } from '../order-update.types';
import { OrderLineMapper } from './order-line.mapper';
import { OrderTotalsService } from './order-totals.service';
import { OrderUpdatePolicy } from './order-update.policy';

@Injectable()
export class OrderCouponService {
  constructor(
    @Inject(OrderUpdatePolicy) private readonly policy: OrderUpdatePolicy,
    @Inject(OrderLineMapper) private readonly lines: OrderLineMapper,
    @Inject(OrderTotalsService) private readonly totals: OrderTotalsService,
  ) {}

  apply(graph: OrderGraph, command: CouponCommand): OrderMutationDraft {
    this.policy.assertMutable(graph);
    const store = this.policy.requireStoreOrder(graph);
    const code = command.code.trim();
    if (!code) throw new BadRequestException('Coupon code is required');
    if (command.amount <= 0) throw new BadRequestException('Discount amount must be greater than zero');
    if (command.discountType === 'percent' && command.amount > 100) {
      throw new BadRequestException('Percent discount must be between 0 and 100');
    }
    const couponLines = Array.isArray(store.couponLines) ? store.couponLines : [];
    if (this.codeExists(couponLines, code)) {
      throw new ConflictException(`Coupon '${code}' is already applied`);
    }

    const applied = applyCoupon(this.lines.fromGraph(graph), {
      code,
      discountType: command.discountType,
      amount: command.amount,
      productIds: command.productIds,
    });
    if (applied.discount <= 0) {
      throw new BadRequestException('Coupon does not reduce this order');
    }

    const priced = this.totals.priceLines(graph, applied.lineItems, {
      includeFees: command.includeFees,
      tax: command.tax,
    });
    return {
      ...priced,
      couponLines: [
        ...couponLines,
        buildCouponLine({
          code,
          discountType: command.discountType,
          amount: command.amount,
          productIds: command.productIds,
        }, applied.discount, 2, command.reason),
      ],
      replaceItems: true,
      appliedDiscount: applied.discount,
    };
  }

  private codeExists(couponLines: unknown[], code: string): boolean {
    const target = code.trim().toLowerCase();
    return couponLines.some((line) => {
      if (!line || typeof line !== 'object') return false;
      return String((line as { code?: unknown }).code || '').trim().toLowerCase() === target;
    });
  }
}
