import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { AddOrderItemsDto, ApplyCouponDto, ApplyDiscountDto, CancelOrderDto, UpdateOrderDto } from './dto/order-update.dto';
import { OrderUpdateService } from './services/order-update.service';

@Controller(['api/v1/orders', 'connector/api/v1/orders'])
export class OrderUpdatesController {
  constructor(@Inject(OrderUpdateService) private readonly updates: OrderUpdateService) {}

  @Put(':id')
  @HttpCode(200)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateOrderDto,
  ) {
    return this.updates.update(id, body);
  }

  @Patch(':id')
  @HttpCode(200)
  updatePartial(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateOrderDto,
  ) {
    return this.updates.update(id, body);
  }

  @Post(':id')
  @HttpCode(200)
  updateByPost(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateOrderDto,
  ) {
    return this.updates.update(id, body);
  }

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
