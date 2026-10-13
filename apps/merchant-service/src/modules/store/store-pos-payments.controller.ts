import {
  Controller,
  Get,
  Inject,
  Param,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { RequireAuth } from '../shared/session-auth.guard';
import { MerchantRepository } from '../merchant/merchant.repository';

@Controller(['api/v1/stores', 'connector/api/v1/stores'])
@RequireAuth()
export class StorePosPaymentsController {
  constructor(
    @Inject(MerchantRepository)
    private readonly merchants: MerchantRepository,
  ) {}

  @Get(':storeId/pos/payment-records')
  listForStore(
    @Param('storeId') storeId: string,
    @Req() request: { user?: { merchantId?: string } },
  ) {
    const merchantId = request.user?.merchantId;
    if (!merchantId) throw new UnauthorizedException('Merchant context is required');
    return this.merchants.getStorePosPaymentsForMerchant(merchantId, storeId);
  }
}
