import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { moneyAmount, withCouponBase } from '../../../calculations/order-update.calculations';
import { OrderRepository } from '../../../order.repository';
import type { AddOrderItemsDto, ApplyCouponDto, ApplyDiscountDto, CancelOrderDto, UpdateOrderDto } from '../dto/order-update.dto';
import { cancelFromDto, couponFromDto, discountFromDto, itemsFromDto } from '../order-update.normalize';
import { OrderUpdatePresenter } from '../order-update.presenter';
import { OrderStatus } from '../../../entities/order.entity';
import type { OrderGraph, OrderMutationDraft } from '../order-update.types';
import { OrderCancellationService } from './order-cancellation.service';
import { OrderCouponCatalog } from './order-coupon.catalog';
import { OrderCouponService } from './order-coupon.service';
import { OrderDiscountService } from './order-discount.service';
import { OrderItemService } from './order-item.service';
import { OrderLineMapper } from './order-line.mapper';

@Injectable()
export class OrderUpdateService {
  constructor(
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(OrderCouponService) private readonly coupons: OrderCouponService,
    @Inject(OrderCouponCatalog) private readonly couponCatalog: OrderCouponCatalog,
    @Inject(OrderDiscountService) private readonly discounts: OrderDiscountService,
    @Inject(OrderItemService) private readonly items: OrderItemService,
    @Inject(OrderCancellationService) private readonly cancellation: OrderCancellationService,
    @Inject(OrderLineMapper) private readonly lines: OrderLineMapper,
    @Inject(OrderUpdatePresenter) private readonly presenter: OrderUpdatePresenter,
  ) {}

  async update(orderId: string, dto: UpdateOrderDto) {
    const hasCoupons = dto.coupon_lines !== undefined;
    const hasStatus = dto.status !== undefined && dto.status.trim() !== '';
    if (!hasCoupons && !hasStatus) {
      throw new BadRequestException('coupon_lines or status is required');
    }
    let graph = await this.load(orderId);
    if (hasCoupons) {
      const lines = this.lines.fromGraph(graph).map((line) => withCouponBase(line));
      const requested = dto.coupon_lines || [];
      const coupons = await Promise.all(requested.map((line) => this.couponCatalog.resolve({
        storeId: graph.order.storeId,
        code: line.code,
        lines,
        email: this.billingEmail(graph),
        couponCount: requested.length,
      })));
      graph = await this.persist(graph, this.coupons.sync(graph, coupons));
    }
    if (hasStatus) {
      graph = await this.persist(graph, this.statusChange(graph, String(dto.status)));
    }
    return this.presenter.present(graph);
  }

  private statusChange(graph: OrderGraph, requested: string): OrderMutationDraft {
    const status = requested.trim().toLowerCase();
    if (status === 'cancelled' || status === 'canceled') {
      return this.cancellation.cancel(graph, cancelFromDto({}));
    }
    const allowed = new Set(['pending', 'processing', 'on-hold', 'completed', 'refunded', 'failed']);
    if (!allowed.has(status)) {
      throw new BadRequestException('status must be pending, processing, on-hold, completed, cancelled, refunded, or failed');
    }
    return {
      orderStatus: status === 'completed' ? OrderStatus.COMPLETED : OrderStatus.CREATED,
      storeStatus: status,
      replaceItems: false,
      history: {
        changedBy: 'POS',
        reason: `Status updated to ${status}`.slice(0, 255),
      },
    };
  }

  async applyCoupon(orderId: string, dto: ApplyCouponDto) {
    const graph = await this.load(orderId);
    const command = couponFromDto(dto);
    const draft = this.coupons.apply(graph, command);
    const saved = await this.persist(graph, draft);
    return this.presenter.present(saved);
  }

  async applyDiscount(orderId: string, dto: ApplyDiscountDto) {
    const graph = await this.load(orderId);
    const draft = this.discounts.apply(graph, discountFromDto(dto));
    const saved = await this.persist(graph, draft);
    return this.presenter.present(saved);
  }

  async addItems(orderId: string, dto: AddOrderItemsDto) {
    const graph = await this.load(orderId);
    const command = itemsFromDto(dto);
    const draft = this.items.add(graph, command);
    const saved = await this.persist(graph, draft);
    return this.presenter.present(saved);
  }

  async cancel(orderId: string, dto: CancelOrderDto = {}) {
    const graph = await this.load(orderId);
    const draft = this.cancellation.cancel(graph, cancelFromDto(dto));
    const saved = await this.persist(graph, draft);
    return this.presenter.present(saved);
  }

  private billingEmail(graph: OrderGraph): string | undefined {
    const payload = graph.order.requestPayload as { billing?: { email?: string } } | null;
    const email = payload?.billing?.email;
    return typeof email === 'string' && email.trim() ? email.trim() : undefined;
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
