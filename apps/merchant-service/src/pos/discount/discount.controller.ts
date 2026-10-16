import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { RequireAuth } from '../../modules/shared/session-auth.guard';
import { DiscountService } from './discount.service';

@Controller(['api/v1/stores', 'connector/api/v1/stores'])
@RequireAuth()
export class DiscountController {
  constructor(@Inject(DiscountService) private readonly discounts: DiscountService) {}

  private assertStoreAccess(storeId: string, user?: { role?: string; storeId?: string }) {
    const role = String(user?.role ?? '').trim().toUpperCase();
    if (['ADMIN', 'ADMINISTRATOR', 'MERCHANT_ADMIN'].includes(role) && user?.storeId !== storeId) {
      throw new ForbiddenException('Store administrators can access discounts only for their assigned store');
    }
  }

  @Post(':storeId/catalog/sync/discounts')
  sync(@Param('storeId') storeId: string, @Req() request: { user?: { role?: string; storeId?: string } }) {
    this.assertStoreAccess(storeId, request.user);
    return this.discounts.sync(storeId, request.user?.role);
  }

  @Get(':storeId/discounts')
  @HttpCode(200)
  list(@Param('storeId') storeId: string, @Query() query: Record<string, string>, @Req() request: { user?: { role?: string; storeId?: string } }) {
    this.assertStoreAccess(storeId, request.user);
    return this.discounts.list(storeId, request.user?.role, query);
  }

  @Get(':storeId/discounts/auto')
  @HttpCode(200)
  listAuto(@Param('storeId') storeId: string, @Query() query: Record<string, string>, @Req() request: { user?: { role?: string; storeId?: string } }) {
    this.assertStoreAccess(storeId, request.user);
    return this.discounts.listByType(storeId, 'auto', request.user?.role, query);
  }

  @Get(':storeId/discounts/mix_match')
  @HttpCode(200)
  listMixMatch(@Param('storeId') storeId: string, @Query() query: Record<string, string>, @Req() request: { user?: { role?: string; storeId?: string } }) {
    this.assertStoreAccess(storeId, request.user);
    return this.discounts.listByType(storeId, 'mix_match', request.user?.role, query);
  }

  @Get(':storeId/discounts/multipack')
  @HttpCode(200)
  listMultipack(@Param('storeId') storeId: string, @Query() query: Record<string, string>, @Req() request: { user?: { role?: string; storeId?: string } }) {
    this.assertStoreAccess(storeId, request.user);
    return this.discounts.listByType(storeId, 'multipack', request.user?.role, query);
  }

  @Get(':storeId/discounts/:type/:id')
  @HttpCode(200)
  getById(@Param('storeId') storeId: string, @Param('type') type: string, @Param('id') id: string,
    @Req() request: { user?: { role?: string; storeId?: string } }) {
    this.assertStoreAccess(storeId, request.user);
    return this.discounts.getById(storeId, type, id, request.user?.role);
  }

  @Get(':storeId/discount-rules')
  @HttpCode(200)
  listRules(
    @Param('storeId') storeId: string,
    @Query('product_id') productId: string | undefined,
    @Req() request: { user?: { role?: string; storeId?: string } },
  ) {
    return this.discounts.listRules(storeId, request.user?.role, productId, request.user?.storeId);
  }

  @Post(':storeId/discounts/apply/:orderId')
  @HttpCode(200)
  applyToOrder(@Param('storeId') storeId: string, @Param('orderId') orderId: string, @Body() body: Record<string, unknown>, @Req() request: { user?: { role?: string; storeId?: string } }) {
    this.assertStoreAccess(storeId, request.user);
    return this.discounts.applyToOrder(storeId, orderId, body, request.user?.role);
  }

  @Post(':storeId/discounts/remove/:orderId')
  @HttpCode(200)
  removeFromOrder(@Param('storeId') storeId: string, @Param('orderId') orderId: string, @Body() body: Record<string, unknown>, @Req() request: { user?: { role?: string; storeId?: string } }) {
    this.assertStoreAccess(storeId, request.user);
    return this.discounts.removeFromOrder(storeId, orderId, body, request.user?.role);
  }

  @Post(':storeId/discounts/by-ids')
  @HttpCode(200)
  productsByIds(@Param('storeId') storeId: string, @Body() body: Record<string, unknown>, @Req() request: { user?: { role?: string; storeId?: string } }) {
    this.assertStoreAccess(storeId, request.user);
    return this.discounts.productsByIds(storeId, body, request.user?.role);
  }

  @Post(':storeId/discounts')
  @HttpCode(201)
  create(@Param('storeId') storeId: string, @Body() body: Record<string, any>, @Req() request: { user?: { role?: string; storeId?: string } }) {
    this.assertStoreAccess(storeId, request.user);
    return this.discounts.create(storeId, body, request.user?.role);
  }

  @Put(':storeId/discounts/:type/:id')
  @HttpCode(200)
  update(@Param('storeId') storeId: string, @Param('type') type: string, @Param('id') id: string, @Body() body: Record<string, any>, @Req() request: { user?: { role?: string; storeId?: string } }) {
    this.assertStoreAccess(storeId, request.user);
    return this.discounts.update(storeId, type, id, body, request.user?.role);
  }

  @Delete(':storeId/discounts/:type/:id')
  @HttpCode(200)
  remove(@Param('storeId') storeId: string, @Param('type') type: string, @Param('id') id: string, @Req() request: { user?: { role?: string; storeId?: string } }) {
    this.assertStoreAccess(storeId, request.user);
    return this.discounts.remove(storeId, type, id, request.user?.role);
  }
}
