import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { moneyAmount } from '../../../calculations/order-update.calculations';
import { OrderRepository } from '../../../order.repository';
import type { AddOrderItemsDto, ApplyCouponDto, ApplyDiscountDto, CancelOrderDto } from '../dto/order-update.dto';
import { cancelFromDto, couponFromDto, discountFromDto, itemsFromDto } from '../order-update.normalize';
import { OrderUpdatePresenter } from '../order-update.presenter';
import type { OrderGraph, OrderMutationDraft } from '../order-update.types';
import { OrderCancellationService } from './order-cancellation.service';
import { OrderCouponService } from './order-coupon.service';
import { OrderDiscountService } from './order-discount.service';
import { OrderItemService } from './order-item.service';
import { OrderLineMapper } from './order-line.mapper';

@Injectable()
export class OrderUpdateService {
  constructor(
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(OrderCouponService) private readonly coupons: OrderCouponService,
    @Inject(OrderDiscountService) private readonly discounts: OrderDiscountService,
    @Inject(OrderItemService) private readonly items: OrderItemService,
    @Inject(OrderCancellationService) private readonly cancellation: OrderCancellationService,
    @Inject(OrderLineMapper) private readonly lines: OrderLineMapper,
    @Inject(OrderUpdatePresenter) private readonly presenter: OrderUpdatePresenter,
  ) {}

  async applyCoupon(orderId: string, dto: ApplyCouponDto) {
    const graph = await this.load(orderId);
    const command = couponFromDto(dto);
    const draft = this.coupons.apply(graph, command);
    const saved = await this.persist(graph, draft);
    return this.presenter.present({
      action: 'coupon_applied',
      message: `Coupon ${command.code} applied`,
      graph: saved,
      totals: draft.totals,
      appliedDiscount: draft.appliedDiscount,
    });
  }

  async applyDiscount(orderId: string, dto: ApplyDiscountDto) {
    const graph = await this.load(orderId);
    const draft = this.discounts.apply(graph, discountFromDto(dto));
    const saved = await this.persist(graph, draft);
    return this.presenter.present({
      action: 'discount_applied',
      message: 'Discount applied',
      graph: saved,
      totals: draft.totals,
      appliedDiscount: draft.appliedDiscount,
    });
  }

  async addItems(orderId: string, dto: AddOrderItemsDto) {
    const graph = await this.load(orderId);
    const command = itemsFromDto(dto);
    const draft = this.items.add(graph, command);
    const saved = await this.persist(graph, draft);
    const count = command.items.length;
    return this.presenter.present({
      action: 'items_added',
      message: count === 1 ? '1 item added' : `${count} items added`,
      graph: saved,
      totals: draft.totals,
    });
  }

  async cancel(orderId: string, dto: CancelOrderDto = {}) {
    const graph = await this.load(orderId);
    const draft = this.cancellation.cancel(graph, cancelFromDto(dto));
    const saved = await this.persist(graph, draft);
    return this.presenter.present({
      action: 'cancelled',
      message: `Order ${graph.order.orderNumber} cancelled`,
      graph: saved,
    });
  }

  private async load(orderId: string): Promise<OrderGraph> {
    const graph = await this.orders.getOrderById(orderId);
    if (!graph) throw new NotFoundException(`Order '${orderId}' not found`);
    return graph;
  }

  private async persist(graph: OrderGraph, draft: OrderMutationDraft): Promise<OrderGraph> {
    const order = graph.order;
    const fromStatus = String(order.orderStatus);
    const tip = Number(order.tipAmount || 0);
    const tipAmount = Number.isFinite(tip) ? tip : 0;
    if (draft.orderStatus) order.orderStatus = draft.orderStatus;
    if (draft.totals) {
      order.subtotal = moneyAmount(draft.totals.subtotal);
      order.discountAmount = moneyAmount(draft.totals.discountTotal);
      order.taxAmount = moneyAmount(draft.totals.taxTotal);
      order.totalAmount = moneyAmount(draft.totals.total + tipAmount);
    }
    order.updatedAt = new Date();

    const storeOrder = graph.storeOrder;
    if (storeOrder) {
      if (draft.lineItems) storeOrder.lineItems = draft.lineItems;
      if (draft.couponLines) storeOrder.couponLines = draft.couponLines;
      if (draft.feeLines) storeOrder.feeLines = draft.feeLines;
      if (draft.taxLines) storeOrder.taxLines = draft.taxLines;
      if (draft.totals) {
        storeOrder.subtotal = moneyAmount(draft.totals.subtotal);
        storeOrder.discountTotal = moneyAmount(draft.totals.discountTotal);
        storeOrder.feeTotal = moneyAmount(draft.totals.feeTotal);
        storeOrder.taxTotal = moneyAmount(draft.totals.taxTotal);
        storeOrder.total = moneyAmount(draft.totals.total + tipAmount);
      }
      if (draft.storeStatus) storeOrder.status = draft.storeStatus;
      storeOrder.updatedAt = new Date();
    }

    const items = draft.replaceItems && draft.lineItems
      ? this.lines.toEntities(order.id, draft.lineItems)
      : graph.items;
    const saved = await this.orders.saveOrderMutation({
      order,
      items,
      storeOrder,
      replaceItems: Boolean(draft.replaceItems),
      history: draft.history
        ? {
            fromStatus,
            toStatus: String(order.orderStatus),
            changedBy: draft.history.changedBy,
            reason: draft.history.reason,
          }
        : undefined,
    });
    return saved;
  }
}
