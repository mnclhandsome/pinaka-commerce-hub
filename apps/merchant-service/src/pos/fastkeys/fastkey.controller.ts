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
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { RequireAuth } from '../../modules/shared/session-auth.guard';
import {
  AddFastkeyProductsDto,
  CreateFastkeyDto,
  DeleteFastkeyProductDto,
  UpdateFastkeyDto,
} from './fastkey.dto';
import { FastkeyService } from './fastkey.service';

type AuthenticatedRequest = {
  protocol?: string;
  headers?: Record<string, string | string[] | undefined>;
  user?: { id?: string };
  get(name: string): string | undefined;
};

type UploadedFastkeyImage = { buffer: Buffer; mimetype: string };

const fastkeyImageDirectory = join(process.cwd(), 'uploads', 'fastkeys');
mkdirSync(fastkeyImageDirectory, { recursive: true });
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
    const origin = this.requestOrigin(request);
    let imagePath: string | undefined;
    try {
      if (file) {
        imagePath = await this.saveImage(file);
        dto.fastkey_image = `${origin}${imagePath}`;
      }
      return await this.service.create(dto, request.user?.id, origin);
    } catch (error) {
      if (imagePath) await this.removeImage(imagePath);
      throw error;
    }
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
    const origin = this.requestOrigin(request);
    let imagePath: string | undefined;
    try {
      if (file) {
        imagePath = await this.saveImage(file);
        dto.fastkey_image = `${origin}${imagePath}`;
      }
      const result = await this.service.update(dto, request.user?.id, origin);
      if (imagePath && result.previousImage) {
        await this.removeImage(result.previousImage);
      }
      return result.response;
    } catch (error) {
      if (imagePath) await this.removeImage(imagePath);
      throw error;
    }
  }

  @Get(['get-by-user', 'get-by-uesr', 'get_by_user'])
  @RequireAuth()
  getByUser(@Req() request: AuthenticatedRequest) {
    return this.service.getByUser(
      request.user?.id,
      this.requestOrigin(request),
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
    );
  }

  @Get(['delete-fastkey/:fastkey_id', 'delete-fastkey'])
  @RequireAuth()
  deleteFastkey(
    @Param('fastkey_id') fastkeyId: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.delete(fastkeyId, request.user?.id);
  }

  @Post(['delete-product', 'delete_product'])
  @HttpCode(200)
  @RequireAuth()
  deleteProduct(
    @Body() dto: DeleteFastkeyProductDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.deleteProduct(dto, request.user?.id);
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

  private async saveImage(file: UploadedFastkeyImage): Promise<string> {
    const extension =
      file.mimetype === 'image/png'
        ? '.png'
        : file.mimetype === 'image/webp'
          ? '.webp'
          : '.jpg';
    const filename = `${randomUUID()}${extension}`;
    await writeFile(join(fastkeyImageDirectory, filename), file.buffer);
    return `/uploads/fastkeys/${filename}`;
  }

  private async removeImage(imagePath: string): Promise<void> {
    let pathname = imagePath;
    try {
      if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
        pathname = new URL(imagePath).pathname;
      }
    } catch {
      return;
    }
    if (!pathname.startsWith('/uploads/fastkeys/')) return;
    const filename = basename(pathname);
    if (filename === 'no-image.png' || filename === 'no-image-2.png') return;
    await unlink(join(fastkeyImageDirectory, filename)).catch(() => undefined);
  }
}
