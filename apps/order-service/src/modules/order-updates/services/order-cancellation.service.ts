import { Inject, Injectable } from '@nestjs/common';
import { OrderStatus } from '../../../entities/order.entity';
import type { CancelOrderCommand, OrderGraph, OrderMutationDraft } from '../order-update.types';
import { OrderUpdatePolicy } from './order-update.policy';

@Injectable()
export class OrderCancellationService {
  constructor(@Inject(OrderUpdatePolicy) private readonly policy: OrderUpdatePolicy) {}

  cancel(graph: OrderGraph, command: CancelOrderCommand): OrderMutationDraft {
    this.policy.assertCancellable(graph);
    return {
      orderStatus: OrderStatus.CANCELLED,
      storeStatus: 'cancelled',
      replaceItems: false,
      history: {
        changedBy: (command.changedBy || 'Manager').slice(0, 150),
        reason: (command.reason || 'Customer Requested Cancellation').slice(0, 255),
      },
    };
  }
}
