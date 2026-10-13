import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post, Query, UsePipes, ValidationPipe } from '@nestjs/common';
import { RequireAuth } from '../../shared/session-auth.guard';
import { CreateStoreVendorMappingDto } from './dto/create-store-vendor-mapping.dto';
import { StoreVendorMappingService } from './store-vendor-mapping.service';

@Controller('api/v1/store-vendor-mappings')
export class StoreVendorMappingController {
  constructor(@Inject(StoreVendorMappingService) private readonly service: StoreVendorMappingService) {}

  @Get()
  list(@Query('store_id') storeId?: string) {
    if (!storeId?.trim()) throw new BadRequestException('store_id query parameter is required');
    return this.service.list(storeId.trim());
  }

  @Post()
  @RequireAuth()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  async map(@Body() dto: CreateStoreVendorMappingDto) {
    return { success: true, message: 'Vendor mapped to store', mapping: await this.service.map(dto) };
  }

  @Delete(':id')
  @RequireAuth()
  async unmap(@Param('id', new ParseUUIDPipe()) id: string) {
    return { success: true, message: 'Vendor unmapped from store', mapping: await this.service.unmap(id) };
  }

  @Delete()
  @RequireAuth()
  async unmapByStoreAndVendor(
    @Query('store_id', new ParseUUIDPipe()) storeId: string,
    @Query('vendor_id', new ParseUUIDPipe()) vendorId: string,
  ) {
    return {
      success: true,
      message: 'Vendor unmapped from store',
      mapping: await this.service.unmapByStoreAndVendor(storeId, vendorId),
    };
  }
}
