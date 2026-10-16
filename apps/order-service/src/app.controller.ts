import { Controller, Get, Post, Patch, Body, Param, Query, Headers, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { OrderRepository } from './order.repository';
import { OrderStatus, OrderType, PaymentMethod, PaymentStatus } from './entities/order.entity';
import type { StoreOrderCalculationInput } from './calculations/store-order.calculations';
import { OrderUpdatePresenter } from './modules/order-updates/order-update.presenter';
import { OrderListPresenter } from './responses/order-list.presenter';
import { OrderResponsePresenter } from './responses/order-response.presenter';

@Controller(['api/v1/orders', 'connector/api/v1/orders'])
export class AppController {
  constructor(
    @Inject(OrderRepository)
    private readonly orderRepository: OrderRepository,
    @Inject(OrderResponsePresenter)
    private readonly responses: OrderResponsePresenter,
    @Inject(OrderListPresenter)
    private readonly orderLists: OrderListPresenter,
    @Inject(OrderUpdatePresenter)
    private readonly orderDetails: OrderUpdatePresenter,
  ) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'order-service',
      version: '2.0.0 (PCH Module 7)',
      timestamp: new Date().toISOString(),
    };
  }

  @Post('calculations')
  calculate(
    @Body() body: any,
    @Headers('x-store-id') storeHeader?: string,
  ) {
    const input: StoreOrderCalculationInput = {
      lineItems: body?.lineItems ?? body?.line_items ?? [],
      feeLines: body?.feeLines ?? body?.fee_lines ?? [],
      taxLines: body?.taxLines ?? body?.tax_lines ?? [],
      payments: Array.isArray(body?.payments) ? body.payments : [],
      discountAmount: body?.discountAmount,
      tax: body?.tax,
      includeFees: Boolean(body?.includeFees),
      includePayments: Boolean(body?.includePayments),
      includeCashbackFee: Boolean(body?.includeCashbackFee),
      cashbackAmount: body?.cashbackAmount,
      shippingTotal: body?.shippingTotal ?? body?.shipping_total,
      decimalPlaces: body?.decimalPlaces,
    };
    return this.orderRepository.calculate(input, storeHeader || body?.storeId || body?.store_id);
  }

  // --- 1. Create New Order (POS / Web / Online Delivery) ---
  @Post()
  async createOrder(
    @Body() body: any,
    @Headers('x-store-id') storeHeader?: string,
    @Headers('x-merchant-id') merchantHeader?: string,
  ) {
    const normalized = this.normalizeCreateOrder(body, storeHeader, merchantHeader);
    if (!normalized.storeId || !normalized.items.length) {
      throw new BadRequestException('storeId and at least 1 item are required to create an order');
    }
    const result = await this.orderRepository.createOrder(normalized);
    const request = result.order.requestPayload || body;
    return this.responses.present(this.responses.profileFor(request), { result, request });
  }

  // --- 2. Get All Orders for Store ---
  @Get()
  async getOrders(@Query('storeId') storeId: string) {
    const targetStore = storeId || 'STR-5001';
    const orders = await this.orderRepository.getOrdersByStore(targetStore);
    return {
      success: true,
      storeId: targetStore,
      count: orders.length,
      orders,
    };
  }

  @Get('total-orders')
  async listTotalOrders(
    @Query('page') page?: string,
    @Query('per_page') perPage?: string,
    @Query('status') status?: string,
    @Query('created_via') createdVia?: string,
    @Query('storeId') storeId?: string,
    @Query('store_id') storeIdSnake?: string,
    @Headers('x-store-id') storeHeader?: string,
  ) {
    const criteria = this.orderLists.criteria({
      page,
      perPage,
      status,
      createdVia,
      storeId: storeHeader || storeId || storeIdSnake,
    });
    const listed = await this.orderRepository.listOrders(criteria);
    return this.orderLists.present(criteria.page, criteria.perPage, listed.total, listed.orders);
  }

  // --- 3. Get Single Order Detail with Items & State History ---
  @Get(':id')
  async getOrderById(
    @Param('id') id: string,
    @Headers('x-store-id') storeHeader?: string,
    @Query('storeId') storeId?: string,
    @Query('store_id') storeIdSnake?: string,
  ) {
    if (['completed-orders', 'full-order-refund', 'partial-order-refund', 'get-amt-by-paymethod', 'refund-valid-user', 'health', 'calculations'].includes(id)) {
      throw new NotFoundException(`Endpoint '${id}' not found`);
    }
    const data = await this.orderRepository.getOrderDetails(id, storeHeader || storeId || storeIdSnake);
    if (!data) throw new NotFoundException(`Order '${id}' not found`);
    return this.orderDetails.present(data);
  }

  // --- 4. Update Order Status (State Machine Transition) ---
  @Patch(':id/status')
  async updateStatus(@Param('id') id: string, @Body() body: { status: OrderStatus; changedBy?: string; reason?: string }) {
    if (!body.status) {
      throw new BadRequestException('target status is required');
    }
    const updated = await this.orderRepository.updateOrderStatus(id, body.status, body.changedBy || 'Cashier', body.reason);
    if (!updated) {
      throw new NotFoundException(`Order '${id}' not found`);
    }
    return {
      success: true,
      message: `Order #${id} status updated to '${updated.orderStatus}'`,
      order: updated,
    };
  }

  private normalizeCreateOrder(body: any, storeHeader?: string, merchantHeader?: string) {
    const metadata = Array.isArray(body?.meta_data) ? body.meta_data : [];
    const metaValue = (key: string) => metadata.find((entry: any) => entry?.key === key)?.value;
    const sourceItems = Array.isArray(body?.line_items) ? body.line_items : body?.items;
    const items = Array.isArray(sourceItems) ? sourceItems.map((item: any) => {
      const quantity = Number(item.quantity || 1);
      const lineTotal = Number(item.total ?? item.subtotal ?? item.totalPrice ?? 0);
      return {
        productId: String(item.product_id ?? item.productId ?? ''),
        productName: item.name || item.productName || 'Sales Item',
        quantity,
        unitPrice: item.unitPrice !== undefined ? Number(item.unitPrice) : lineTotal / quantity,
        totalPrice: lineTotal,
        modifiers: Array.isArray(item.meta_data) ? item.meta_data : item.modifiers || [],
      };
    }) : [];
    const lineSubtotal = items.reduce(
      (sum: number, item: any) => sum + Number(item.quantity) * Number(item.unitPrice),
      0,
    );
    const status = String(body?.status || '').toUpperCase();
    const method = String(body?.payment_method || body?.paymentMethod || 'CASH').toUpperCase();
    return {
      ...body,
      storeId: storeHeader || body?.storeId || body?.store_id,
      merchantId: merchantHeader || body?.merchantId || body?.merchant_id,
      shiftId: String(body?.shift_id ?? body?.shiftId ?? metaValue('shift_id') ?? '').trim() || undefined,
      localShiftId: String(body?.local_shift_id ?? body?.localShiftId ?? metaValue('local_shift_id') ?? ''),
      clientOrderId: String(metaValue('_pos_client_order_id') ?? body?.clientOrderId ?? ''),
      offline: Boolean(body?.offline ?? metaValue('offline') ?? metaValue('is_offline')),
      metadata,
      requestPayload: body,
      source: Array.isArray(body?.line_items) ? 'WORDPRESS_COMPATIBLE' : 'PCH',
      items,
      subtotal: body?.subtotal !== undefined ? Number(body.subtotal) : lineSubtotal,
      taxAmount: Number(body?.taxAmount ?? metaValue('_pos_order_tax') ?? 0),
      discountAmount: Number(body?.discountAmount ?? 0),
      tipAmount: Number(body?.tipAmount ?? 0),
      totalAmount: body?.total !== undefined ? Number(body.total) : undefined,
      customerName: body?.customerName || 'Walk-in Customer',
      customerPhone: body?.customerPhone || '',
      orderType: body?.orderType || OrderType.IN_STORE_POS,
      paymentMethod: method.includes('CARD') ? PaymentMethod.CARD
        : method.includes('UPI') ? PaymentMethod.UPI
          : method.includes('CREDIT') ? PaymentMethod.STORE_CREDIT
            : PaymentMethod.CASH,
      paymentStatus: body?.set_paid === false ? PaymentStatus.PENDING : PaymentStatus.PAID,
      orderStatus: Object.values(OrderStatus).includes(status as OrderStatus)
        ? status as OrderStatus
        : OrderStatus.CREATED,
    };
  }
}
