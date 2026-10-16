import { BadRequestException, Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { extractBearerToken, verifyAccessToken } from '@pch/auth';
import { PartialOrderRefundService, type PartialOrderRefundRequest } from './partial-order-refund.service';

@Controller([
  'api/v1/orders',
  'connector/api/v1/orders',
  'pinaka-pos/v1/orders',
  'wp-json/pinaka-pos/v1/orders',
])
export class PartialOrderRefundController {
  constructor(@Inject(PartialOrderRefundService) private readonly refunds: PartialOrderRefundService) {}

  @Post('partial-order-refund')
  @HttpCode(HttpStatus.OK)
  refund(
    @Body() body: PartialOrderRefundRequest,
    @Headers('authorization') authorization?: string,
    @Headers('x-merchant-id') merchantId?: string,
    @Headers('x-store-id') storeId?: string,
  ) {
    const token = verifyAccessToken(extractBearerToken(authorization));
    const merchant = String(merchantId || '').trim();
    const store = String(storeId || '').trim();
    if (!merchant) throw new BadRequestException('x-merchant-id header is required');
    if (!store) throw new BadRequestException('x-store-id header is required');
    return this.refunds.refund(body, { merchantId: merchant, storeId: store, performedBy: token.sub });
  }
}
