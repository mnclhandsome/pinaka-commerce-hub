import { BadRequestException, Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { extractBearerToken, verifyAccessToken } from '@pch/auth';
import { RefundAmountService, type RefundAmountRequest } from './refund-amount.service';

@Controller([
  'api/v1/orders',
  'connector/api/v1/orders',
  'pinaka-pos/v1/orders',
  'wp-json/pinaka-pos/v1/orders',
])
export class RefundAmountController {
  constructor(@Inject(RefundAmountService) private readonly refunds: RefundAmountService) {}

  @Post('get-amt-by-paymethod')
  @HttpCode(HttpStatus.OK)
  calculate(
    @Body() body: RefundAmountRequest,
    @Headers('authorization') authorization?: string,
    @Headers('x-merchant-id') merchantId?: string,
    @Headers('x-store-id') storeId?: string,
  ) {
    verifyAccessToken(extractBearerToken(authorization));
    const merchant = String(merchantId || '').trim();
    const store = String(storeId || '').trim();
    if (!merchant) throw new BadRequestException('x-merchant-id header is required');
    if (!store) throw new BadRequestException('x-store-id header is required');
    return this.refunds.calculate(body, merchant, store);
  }
}
