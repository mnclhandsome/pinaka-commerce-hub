import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';

import { StorePosConfigurationsService } from './store-pos-configuration.service';
import { CreateStorePosConfigurationDto } from './dto/create-store-pos-configuration.dto';
import { UpdateStorePosConfigurationDto } from './dto/update-store-pos-configuration.dto';

@Controller([
  'api/v1/store/store-pos-configuration',
  'connector/api/v1/store/store-pos-configuration',
  'store/store-pos-configuration',
])
export class StorePosConfigurationController {
  constructor(
    @Inject(StorePosConfigurationsService)
    private readonly service: StorePosConfigurationsService,
  ) {}

  /**
   * Create a new store POS configuration.
   *
   * POST /api/v1/store/store-pos-configuration
   */
  @Post()
  create(
    @Body() dto: CreateStorePosConfigurationDto,
    @Req() request: { user?: { id?: string } },
  ) {
    return this.service.create(dto, request.user?.id);
  }
  /**
   * Create or update a store POS configuration.
   *
   * PUT /api/v1/store/store-pos-configuration
   */
  @Put()
  upsert(
    @Body() dto: CreateStorePosConfigurationDto,
    @Req() request: { user?: { id?: string } },
  ) {
    return this.service.upsert(dto, request.user?.id);
  }

  /**
   * Get all POS configurations for a store.
   *
   * GET /api/v1/store/store-pos-configuration/:storeId
   */
  @Get(':storeId')
  findByStore(
    @Param('storeId') storeId: string,
  ) {
    return this.service.findByStoreId(storeId);
  }

  /**
   * Get customized POS store configuration.
   *
   * GET /api/v1/store/store-pos-configuration/:storeId/bootstrap
   */
  @Get(':storeId/bootstrap')
  getStoreBootstrap(@Param('storeId') storeId: string) {
    return this.service.getStoreInfo(storeId);
  }
  /**
   * Get a specific POS configuration.
   *
   * GET /api/v1/store/store-pos-configuration/:storeId/:configurationName
   */
  @Get(':storeId/:configurationName')
  findOne(
    @Param('storeId') storeId: string,
    @Param('configurationName') configurationName: string,
  ) {
    return this.service.findPresented(
      storeId,
      configurationName,
    );
  }

  /**
   * Get only the JSON configuration value.
   *
   * GET /api/v1/store/store-pos-configuration/:storeId/:configurationName/value
   */
  @Get(':storeId/:configurationName/value')
  getValue(
    @Param('storeId') storeId: string,
    @Param('configurationName') configurationName: string,
  ) {
    return this.service.getConfigurationValue(
      storeId,
      configurationName,
    );
  }

  /**
   * Update a specific POS configuration.
   *
   * PATCH /api/v1/store/store-pos-configuration/:storeId/:configurationName
   */
  @Patch(':storeId/:configurationName')
  update(
    @Param('storeId') storeId: string,
    @Param('configurationName') configurationName: string,
    @Body() dto: UpdateStorePosConfigurationDto,
    @Req() request: { user?: { id?: string } },
  ) {
    return this.service.update(
      storeId,
      configurationName,
      dto,
      request.user?.id,
    );
  }

  /**
   * Delete a specific POS configuration.
   *
   * DELETE /api/v1/store/store-pos-configuration/:storeId/:configurationName
   */
  @Delete(':storeId/:configurationName')
  async remove(
    @Param('storeId') storeId: string,
    @Param('configurationName') configurationName: string,
  ) {
    await this.service.remove(
      storeId,
      configurationName,
    );

    return {
      success: true,
      message: 'POS configuration deleted successfully',
    };
  } 
}