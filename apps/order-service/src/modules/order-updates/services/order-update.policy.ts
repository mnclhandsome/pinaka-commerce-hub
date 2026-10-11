import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { StoreOrderEntity } from '../../../entities/store-order.entity';
import type { OrderGraph } from '../order-update.types';

@Injectable()
export class OrderUpdatePolicy {
  assertMutable(graph: OrderGraph): void {
    if (this.isCancelled(graph)) {
      throw new ConflictException('Cancelled orders cannot be changed');
    }
    if (this.isCompleted(graph)) {
      throw new ConflictException('Completed orders cannot be changed');
    }
  }

  assertCancellable(graph: OrderGraph): void {
    if (this.isCancelled(graph)) {
      throw new ConflictException('Order is already cancelled');
    }
  }

  requireStoreOrder(graph: OrderGraph): StoreOrderEntity {
    if (!graph.storeOrder) {
      throw new BadRequestException('Store order details are missing for this order');
    }
    return graph.storeOrder;
  }

  private isCancelled(graph: OrderGraph): boolean {
    return this.statuses(graph).some((status) => status === 'CANCELLED' || status === 'CANCELED');
  }

  private isCompleted(graph: OrderGraph): boolean {
    return this.statuses(graph).some((status) => status === 'COMPLETED');
  }

  private statuses(graph: OrderGraph): string[] {
    return [graph.order.orderStatus, graph.storeOrder?.status || '']
      .filter((status) => status)
      .map((status) => String(status).toUpperCase());
  }
}
