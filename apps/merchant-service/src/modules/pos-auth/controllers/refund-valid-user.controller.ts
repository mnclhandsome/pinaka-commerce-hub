import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { Public } from '@pinaka-delivery-hub/auth';
import { PosAuthService } from '../services/pos-auth.service';

@Public()
@Controller([
  'api/v1/orders',
  'connector/api/v1/orders',
  'pinaka-pos/v1/orders',
  'wp-json/pinaka-pos/v1/orders',
])
export class RefundValidUserController {
  constructor(@Inject(PosAuthService) private readonly auth: PosAuthService) {}

  @Post('refund-valid-user')
  @HttpCode(HttpStatus.OK)
  validate(
    @Body() body: { employee_pin?: unknown },
    @Headers('authorization') authorization?: string,
    @Headers('x-merchant-id') merchantId?: string,
    @Headers('x-store-id') storeId?: string,
  ) {
    return this.auth.validateRefundUser(
      body?.employee_pin,
      headerValue(authorization),
      headerValue(merchantId),
      headerValue(storeId),
    );
  }
}

function headerValue(value?: string | string[]): string {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').trim();
}
