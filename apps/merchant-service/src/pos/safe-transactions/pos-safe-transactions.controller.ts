import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { RequireAuth } from '../../modules/shared/session-auth.guard';
import {
  CreateSafeDto,
  CreateSafeDropDto,
  SafeTransactionsQueryDto,
} from './pos-safe-transactions.dto';
import { PosSafeTransactionsService } from './pos-safe-transactions.service';

type AuthenticatedRequest = {
  user?: {
    id?: string;
    accountId?: string;
    merchantId?: string;
    storeId?: string;
  };
};
const validate = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

@Controller([
  'api/v1/stores/:store_id/pos',
  'connector/api/v1/stores/:store_id/pos',
  'stores/:store_id/pos',
])
@RequireAuth()
@UsePipes(validate)
export class PosSafeTransactionsController {
  constructor(
    @Inject(PosSafeTransactionsService)
    private readonly transactions: PosSafeTransactionsService,
  ) {}

  @Post('safes/create-safe')
  @HttpCode(201)
  createSafe(
    @Param('store_id') store_id: string,
    @Body() body: CreateSafeDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.transactions.createSafe(store_id, body, request.user);
  }

  @Post('safe-drops/create-safe-drop')
  @HttpCode(201)
  createSafeDrop(
    @Param('store_id') store_id: string,
    @Body() body: CreateSafeDropDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.transactions.createSafeDrop(store_id, body, request.user);
  }

  @Get('safes/get-all-safes')
  getSafes(
    @Param('store_id') store_id: string,
    @Query() query: SafeTransactionsQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.transactions.getSafes(store_id, query, request.user);
  }

  @Get('safe-drops/get-all-safe-drops')
  getSafeDrops(
    @Param('store_id') store_id: string,
    @Query() query: SafeTransactionsQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.transactions.getSafeDrops(store_id, query, request.user);
  }
}
