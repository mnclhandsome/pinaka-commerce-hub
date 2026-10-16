import { Controller, Get, Headers, Inject, Query } from '@nestjs/common';
import { extractBearerToken, verifyAccessToken } from '@pch/auth';
import { OrderRepository } from './order.repository';
import { CompletedOrderPresenter } from './responses/completed-order.presenter';

@Controller([
  'api/v1/orders',
  'connector/api/v1/orders',
  'pinaka-pos/v1/orders',
  'wp-json/pinaka-pos/v1/orders',
])
export class CompletedOrdersController {
  constructor(
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(CompletedOrderPresenter) private readonly presenter: CompletedOrderPresenter,
  ) {}

  @Get('completed-orders')
  async list(
    @Headers('authorization') authorization?: string,
    @Headers('x-merchant-id') merchantHeader?: string,
    @Headers('x-store-id') storeHeader?: string,
    @Query('page') page?: string,
    @Query('per_page') perPage?: string,
    @Query('author') author?: string,
    @Query('after') after?: string,
    @Query('before') before?: string,
    @Query('created_via') createdVia?: string,
  ) {
    verifyAccessToken(extractBearerToken(authorization));
    const criteria = this.presenter.criteria({
      page,
      perPage,
      author,
      after,
      before,
      createdVia,
      merchantId: merchantHeader,
      storeId: storeHeader,
    });
    const result = await this.orders.listOrders(criteria);
    return this.presenter.present(criteria.page, criteria.perPage, result.total, result.orders);
  }
}
