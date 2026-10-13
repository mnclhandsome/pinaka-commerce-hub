import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { OrderRepository } from './order.repository';

@Controller(['api/v1/stores', 'connector/api/v1/stores'])
export class StorePosPaymentsController {
  constructor(@Inject(OrderRepository) private readonly orders: OrderRepository) {}

  @Get(':storeId/pos/payment-records')
  async listForStore(@Param('storeId', new ParseUUIDPipe()) storeId: string) {
    const payments = await this.orders.getStorePosPayments(storeId);
    return { success: true, storeId, count: payments.length, payments };
  }
}
