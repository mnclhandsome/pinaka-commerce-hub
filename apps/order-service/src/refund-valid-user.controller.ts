import { Body, Controller, Headers, HttpCode, HttpException, HttpStatus, Post } from '@nestjs/common';

@Controller([
  'api/v1/orders',
  'connector/api/v1/orders',
  'pinaka-pos/v1/orders',
  'wp-json/pinaka-pos/v1/orders',
])
export class RefundValidUserController {
  @Post('refund-valid-user')
  @HttpCode(HttpStatus.OK)
  async validate(
    @Body() body: any,
    @Headers('authorization') authorization?: string,
    @Headers('x-merchant-id') merchantId?: string,
    @Headers('x-store-id') storeId?: string,
  ) {
    try {
      const response = await fetch('http://127.0.0.1:3003/connector/api/v1/orders/refund-valid-user', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { authorization } : {}),
          ...(merchantId ? { 'x-merchant-id': merchantId } : {}),
          ...(storeId ? { 'x-store-id': storeId } : {}),
        },
        body: JSON.stringify(body || {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new HttpException(data, response.status);
      }
      return data;
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { success: false, message: err?.message || 'Failed to connect to authentication service' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
