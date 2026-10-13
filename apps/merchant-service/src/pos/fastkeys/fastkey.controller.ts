import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RequireAuth } from '../../modules/shared/session-auth.guard';
import {
  AddFastkeyProductsDto,
  CreateFastkeyDto,
  DeleteFastkeyProductDto,
  UpdateFastkeyDto,
} from './fastkey.dto';
import { FastkeyService, UploadedBinary } from './fastkey.service';

type AuthenticatedRequest = {
  protocol?: string;
  headers?: Record<string, string | string[] | undefined>;
  user?: { id?: string; storeId?: string };
  get(name: string): string | undefined;
};

type UploadedFastkeyImage = UploadedBinary;

const { memoryStorage } = require('multer');
const fastkeyImageUpload = FileInterceptor('fastkey_image', {
  storage: memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (
    _request: unknown,
    file: { mimetype: string },
    callback: (error: Error | null, accept: boolean) => void,
  ) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'].includes(
      file.mimetype,
    );
    callback(
      allowed
        ? null
        : new BadRequestException('Fast Key image must be JPG, PNG, or WebP'),
      allowed,
    );
  },
});

@Controller([
  'api/v1/fastkeys',
  'connector/api/v1/fastkeys',
  'api/v1/pos/fastkeys',
  'connector/api/v1/pos/fastkeys',
  'fastkeys',
  'wp-json/pinaka-pos/v1/fastkeys',
  'wordpress/wp-json/pinaka-pos/v1/fastkeys',
])
export class FastkeyController {
  constructor(
    @Inject(FastkeyService)
    private readonly service: FastkeyService,
  ) {}

  @Post(['create', 'fastkeys/create'])
  @HttpCode(201)
  @RequireAuth()
  @UseInterceptors(fastkeyImageUpload)
  async create(
    @Body() dto: CreateFastkeyDto,
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file?: UploadedFastkeyImage,
  ) {
    return this.service.create(
      dto,
      request.user?.id,
      this.requestOrigin(request),
      file,
      request.user?.storeId,
    );
  }

  @Post(['update-fastkey', 'update', 'update-fastkeys'])
  @HttpCode(200)
  @RequireAuth()
  @UseInterceptors(fastkeyImageUpload)
  async update(
    @Body() dto: UpdateFastkeyDto,
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file?: UploadedFastkeyImage,
  ) {
    const result = await this.service.update(
      dto,
      request.user?.id,
      this.requestOrigin(request),
      file,
      request.user?.storeId,
    );
    return result.response;
  }

  @Get(['get-by-user', 'get-by-uesr', 'get_by_user'])
  @RequireAuth()
  getByUser(@Req() request: AuthenticatedRequest) {
    return this.service.getByUser(
      request.user?.id,
      this.requestOrigin(request),
      request.user?.storeId,
    );
  }

  @Get('get-all-fastkeys-images')
  @RequireAuth()
  getAllFastkeyImages(@Req() request: AuthenticatedRequest) {
    return this.service.getAllFastkeyImages(
      request.user?.id,
      this.requestOrigin(request),
    );
  }

  @Get(['get-by-fastkey-id/:fastkey_id', 'get-by-fastkey-id'])
  @RequireAuth()
  getByFastkeyId(
    @Param('fastkey_id') fastkeyId: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.getByFastkeyId(
      fastkeyId,
      request.user?.id,
      this.requestOrigin(request),
      request.user?.storeId,
    );
  }

  @Get(['delete-fastkey/:fastkey_id', 'delete-fastkey'])
  @RequireAuth()
  deleteFastkey(
    @Param('fastkey_id') fastkeyId: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.delete(fastkeyId, request.user?.id, request.user?.storeId);
  }

  @Post(['delete-product', 'delete_product'])
  @HttpCode(200)
  @RequireAuth()
  deleteProduct(
    @Body() dto: DeleteFastkeyProductDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.deleteProduct(dto, request.user?.id, request.user?.storeId);
  }

  @Post(['add-products', 'add_products', 'fastkeys/add-products'])
  @HttpCode(200)
  @RequireAuth()
  addProducts(
    @Body() dto: AddFastkeyProductsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.addProducts(
      dto,
      request.user?.id,
      this.requestOrigin(request),
      request.user?.storeId,
    );
  }

  @Post([
    'update-fastkey-products',
    'update/fastkey-products',
    'update_fastkey_products',
  ])
  @HttpCode(200)
  @RequireAuth()
  updateProducts(
    @Body() dto: AddFastkeyProductsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.updateProducts(
      dto,
      request.user?.id,
      this.requestOrigin(request),
      request.user?.storeId,
    );
  }

  private requestOrigin(request: AuthenticatedRequest): string {
    const forwardedProto = request.headers?.['x-forwarded-proto'];
    const protocol = Array.isArray(forwardedProto)
      ? forwardedProto[0]
      : forwardedProto?.split(',')[0]?.trim() || request.protocol || 'http';
    const forwardedHost = request.headers?.['x-forwarded-host'];
    const host =
      (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ||
      request.get('host') ||
      'localhost:3003';
    return `${protocol}://${host}`;
  }
}
