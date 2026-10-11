import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AddOrderItemsDto, ApplyCouponDto, ApplyDiscountDto, CancelOrderDto } from './dto/order-update.dto';
import { OrderUpdateService } from './services/order-update.service';

@Controller(['api/v1/orders', 'connector/api/v1/orders'])
export class OrderUpdatesController {
  constructor(@Inject(OrderUpdateService) private readonly updates: OrderUpdateService) {}

  @Post(':id/coupons')
  @HttpCode(200)
  applyCoupon(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ApplyCouponDto,
  ) {
    return this.updates.applyCoupon(id, body);
  }

  @Post(':id/discounts')
  @HttpCode(200)
  applyDiscount(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ApplyDiscountDto,
  ) {
    return this.updates.applyDiscount(id, body);
  }

  @Post(':id/items')
  @HttpCode(200)
  addItems(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AddOrderItemsDto,
  ) {
    return this.updates.addItems(id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CancelOrderDto,
  ) {
    return this.updates.cancel(id, body);
  }
}
