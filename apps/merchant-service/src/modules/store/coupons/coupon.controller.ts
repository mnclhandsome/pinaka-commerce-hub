import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { CouponInputDto, CouponSyncDto } from './coupon.dto';
import { CouponService } from './coupon.service';
import { Public } from '@pinaka-delivery-hub/auth';

@Controller(['api/v1/coupons', 'connector/api/v1/coupons'])
export class CouponController {
  constructor(@Inject(CouponService) private readonly coupons: CouponService) {}
  @Post() async create(@Body() body: CouponInputDto, @Req() request: any) { return { success: true, coupon: await this.coupons.create(body, this.publicBaseUrl(request)) }; }
  @Get() async list(@Query() query: any) { return { success: true, ...(await this.coupons.list(query.merchantId, query.storeId, Number(query.page || 1), Number(query.perPage || query.per_page || 25), query.includeDeleted === 'true')) }; }
  @Post('sync') async sync(@Body() body: CouponSyncDto) { return { success: true, ...(await this.coupons.synchronize(body.storeId, body.merchantId)) }; }
  @Public()
  @Post('webhook') async webhook(@Query('storeId') storeId: string, @Headers('x-wc-webhook-topic') topic: string, @Headers('x-wc-webhook-signature') signature: string, @Body() body: any, @Req() request: any) { return { success: true, result: await this.coupons.webhook(storeId, topic, body, signature, request.rawBody || Buffer.alloc(0)) }; }
  @Post(':id/retry-sync') async retry(@Param('id') id: string) { return { success: true, coupon: await this.coupons.retry(id) }; }
  @Get(':id') async get(@Param('id') id: string) { return { success: true, coupon: await this.coupons.get(id) }; }
  @Put(':id') async update(@Param('id') id: string, @Body() body: CouponInputDto) { return { success: true, coupon: await this.coupons.update(id, body) }; }
  @Delete(':id') async remove(@Param('id') id: string) { return { success: true, coupon: await this.coupons.remove(id) }; }
  private publicBaseUrl(request: any): string {
    const protocol = String(request.headers?.['x-forwarded-proto'] || request.protocol || 'http').split(',')[0].trim();
    const host = String(request.headers?.['x-forwarded-host'] || request.headers?.host || '').split(',')[0].trim();
    return host ? `${protocol}://${host}`.replace(/\/+$/, '') : '';
  }
}
