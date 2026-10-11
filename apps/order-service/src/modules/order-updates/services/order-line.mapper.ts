import { Injectable } from '@nestjs/common';
import { moneyAmount, type OrderLine } from '../../../calculations/order-update.calculations';
import type { OrderItemEntity } from '../../../entities/order-item.entity';
import type { OrderGraph } from '../order-update.types';

@Injectable()
export class OrderLineMapper {
  fromGraph(graph: OrderGraph): OrderLine[] {
    const stored = graph.storeOrder && Array.isArray(graph.storeOrder.lineItems)
      ? graph.storeOrder.lineItems as OrderLine[]
      : [];
    if (stored.length) return stored.map((line) => ({ ...line }));
    return graph.items.map((item) => ({
      product_id: item.productId,
      name: item.productName,
      quantity: Number(item.quantity),
      subtotal: moneyAmount(Number(item.unitPrice) * Number(item.quantity)).toFixed(2),
      total: moneyAmount(item.totalPrice).toFixed(2),
      meta_data: Array.isArray(item.modifiers) ? item.modifiers : [],
    }));
  }

  toEntities(orderId: string, lines: OrderLine[]): OrderItemEntity[] {
    return lines.map((line, index) => {
      const quantity = Number(line.quantity || 1);
      const totalPrice = moneyAmount(line.total ?? line.subtotal ?? 0);
      const subtotal = moneyAmount(line.subtotal ?? line.total ?? 0);
      const unitPrice = quantity > 0 ? moneyAmount(subtotal / quantity) : 0;
      return {
        id: `ITEM-${orderId}-${index + 1}`,
        orderId,
        productId: String(line.product_id ?? line.productId ?? `PROD-${index + 1}`).slice(0, 100),
        productName: String(line.name || line.productName || 'Sales Item').slice(0, 255),
        quantity,
        unitPrice,
        totalPrice,
        modifiers: Array.isArray(line.meta_data) ? line.meta_data : [],
      };
    });
  }
}
