import { Body, Controller, Get, Inject, Param, Post, Put, Req, ValidationPipe } from '@nestjs/common';
import { RequireAuth } from '../../modules/shared/session-auth.guard';
import { SavePosSafeDropDto } from './pos-safe-drop.dto';
import { PosSafeDropService } from './pos-safe-drop.service';

const validate = new ValidationPipe({
  expectedType: SavePosSafeDropDto,
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

@Controller([
  'api/v1/stores/:storeId/pos/safe-drop',
  'connector/api/v1/stores/:storeId/pos/safe-drop',
  'stores/:storeId/pos/safe-drop',
])
export class PosSafeDropController {
  constructor(@Inject(PosSafeDropService) private readonly safeDrop: PosSafeDropService) {}

  @Get()
  get(@Param('storeId') storeId: string) {
    return this.safeDrop.get(storeId);
  }

  @Get('status')
  @RequireAuth()
  getStatus(
    @Param('storeId') storeId: string,
    @Req() request: { user?: { id?: string; accountId?: string; merchantId?: string; storeId?: string } },
  ) {
    return this.safeDrop.getStatus(storeId, request.user);
  }

  @Post()
  create(@Param('storeId') storeId: string, @Body(validate) body: SavePosSafeDropDto) {
    return this.safeDrop.create(storeId, body);
  }

  @Put()
  update(@Param('storeId') storeId: string, @Body(validate) body: SavePosSafeDropDto) {
    return this.safeDrop.update(storeId, body);
  }
}
