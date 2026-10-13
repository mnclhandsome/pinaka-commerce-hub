import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  normalizeAddedLine,
  OrderCalculationError,
  replayCouponsOnLines,
} from '../../../calculations/order-update.calculations';
import type { AddItemsCommand, OrderGraph, OrderMutationDraft } from '../order-update.types';
import { OrderLineMapper } from './order-line.mapper';
import { OrderTotalsService } from './order-totals.service';
import { OrderUpdatePolicy } from './order-update.policy';

@Injectable()
export class OrderItemService {
  constructor(
    @Inject(OrderUpdatePolicy) private readonly policy: OrderUpdatePolicy,
    @Inject(OrderLineMapper) private readonly lines: OrderLineMapper,
    @Inject(OrderTotalsService) private readonly totals: OrderTotalsService,
  ) {}

  add(graph: OrderGraph, command: AddItemsCommand): OrderMutationDraft {
    this.policy.assertMutable(graph);
    const store = this.policy.requireStoreOrder(graph);
    if (!command.items.length) {
      throw new BadRequestException('At least one item is required');
    }
    const existing = this.lines.fromGraph(graph);
    const added = command.items.map((item) => {
      try {
        return normalizeAddedLine(item);
      } catch (error) {
        if (error instanceof OrderCalculationError) throw new BadRequestException(error.message);
        throw error;
      }
    });
    const newIndexes = new Set(added.map((_, index) => existing.length + index));
    const couponLines = Array.isArray(store.couponLines) ? store.couponLines : [];
    const replayed = replayCouponsOnLines([...existing, ...added], couponLines, newIndexes);
    const priced = this.totals.priceLines(graph, replayed.lineItems, {
      includeFees: command.includeFees,
      tax: command.tax,
    });
    return {
      ...priced,
      couponLines: replayed.couponLines,
      replaceItems: true,
    };
  }
}
