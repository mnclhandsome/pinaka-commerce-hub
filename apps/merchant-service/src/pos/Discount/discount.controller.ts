import { Controller, Inject, Param, Post, Req } from '@nestjs/common';
import { RequireAuth } from '../../modules/shared/session-auth.guard';
import { DiscountService } from './discount.service';

@Controller(['api/v1/stores', 'connector/api/v1/stores'])
@RequireAuth()
export class DiscountController {
  constructor(@Inject(DiscountService) private readonly discounts: DiscountService) {}

  @Post(':storeId/catalog/sync/discounts')
  sync(@Param('storeId') storeId: string, @Req() request: { user?: { role?: string } }) {
    return this.discounts.sync(storeId, request.user?.role);
  }
}
