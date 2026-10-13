import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MerchantRepository } from '../../modules/merchant/merchant.repository';
import { EmployeeEntity } from '../../entities/employee.entity';
import { StoreEntity } from '../../entities/store.entity';
import {
  AddFastkeyProductsDto,
  CreateFastkeyDto,
  DeleteFastkeyProductDto,
  UpdateFastkeyDto,
} from './fastkey.dto';
import { StoreEmployeeFastkeyEntity } from './store-employee-fastkey.entity';

type FastkeyContext = { employee_id: string; store_id: string };
type StoreProduct = Record<string, unknown> & { id: string | number };

@Injectable()
export class FastkeyService {
  constructor(
    @Inject(MerchantRepository)
    private readonly merchants: MerchantRepository,
  ) {}

  async create(
    dto: CreateFastkeyDto,
    userId: string | undefined,
    origin: string,
  ) {
    const title = String(dto.fastkey_title ?? '').trim();
    if (!title) {
      throw new HttpException({ message: 'Missing required fields' }, 400);
    }

    if (!userId) throw new UnauthorizedException('Authentication is required');

    const fastkeyIndex = this.toWordPressInteger(dto.fastkey_index);
    const image =
      String(dto.fastkey_image ?? '').trim() ||
      process.env.FASTKEY_DEFAULT_IMAGE_URL?.trim() ||
      `${origin}/uploads/fastkeys/no-image-2.png`;
    const db = this.merchants.requireDataSource();
    const context = await this.resolveContext();

    const repository = db.getRepository(StoreEmployeeFastkeyEntity);
    const existing = await repository.find({
      where: {
        storeId: context.store_id,
        employeeId: context.employee_id,
        isDeleted: false,
      },
      select: { id: true, json: true },
    });
    if (
      existing.some(
        (item) =>
          (item.json?.fastkey_title || '').trim().toLocaleLowerCase() ===
          title.toLocaleLowerCase(),
      )
    ) {
      throw new HttpException(
        {
          status: 'error',
          message: 'You already have a Fast Key with this title.',
        },
        409,
      );
    }

    try {
      const saved = await repository.save(
        repository.create({
          storeId: context.store_id,
          employeeId: context.employee_id,
          json: { fastkey_title: title, fastkey_index: fastkeyIndex },
          fastkeyImage: image,
          isDeleted: false,
        }),
      );
      return {
        status: 'success',
        message: 'Fast Key created',
        fastkey_id: saved.id,
        fastkey_title: title,
        fastkey_index: fastkeyIndex,
        fastkey_image: image,
      };
    } catch (error) {
      if (this.postgresCode(error) === '23505') {
        throw new HttpException(
          {
            status: 'error',
            message: 'You already have a Fast Key with this title.',
          },
          409,
        );
      }
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { message: 'Error creating Fast Key', status: 'error' },
        500,
      );
    }
  }

  async getByUser(userId: string | undefined, origin: string) {
    if (!userId) throw new UnauthorizedException('Authentication is required');

    const context = await this.resolveContext();
    const rows = await this.merchants
      .requireDataSource()
      .getRepository(StoreEmployeeFastkeyEntity)
      .find({
        where: {
          employeeId: context.employee_id,
          storeId: context.store_id,
          isDeleted: false,
        },
      });

    const fastkeys = await Promise.all(
      rows
        .sort(
          (left, right) => this.fastkeyIndex(left) - this.fastkeyIndex(right),
        )
        .map(async (row) => {
          const assignments = this.productAssignments(row);
          const products = await this.enhanceProducts(row.storeId, assignments);
          return {
            fastkey_id: row.id,
            fastkey_title: String(row.json?.fastkey_title ?? ''),
            fastkey_image:
              row.fastkeyImage?.trim() ||
              `${origin}/uploads/fastkeys/no-image.png`,
            itemCount: assignments.length,
            user_id: context.employee_id,
            fastkey_index: this.fastkeyIndex(row),
            products,
          };
        }),
    );

    return {
      user_id: context.employee_id,
      message: 'FastKeys retrieved successfully',
      status: 'success',
      fastkeys,
    };
  }

  async getAllFastkeyImages(userId: string | undefined, origin: string) {
    if (!userId) throw new UnauthorizedException('Authentication is required');

    const root = this.fastkeyImageCatalogDirectory();
    const configuredTypes = String(process.env.FASTKEY_IMAGE_TYPES ?? '')
      .split(',')
      .map((type) => type.trim().toUpperCase())
      .filter(Boolean);
    const types = [
      ...new Set(['2D', '3D', 'PNG', 'JPG', 'JPEG', ...configuredTypes]),
    ];
    const data: Record<string, Array<Record<string, unknown>>> = {};
    let imageId = this.fastkeyImageIdStart();

    for (const type of types) {
      const directory = join(root, type);
      if (!existsSync(directory)) continue;

      const entries = await readdir(directory, { withFileTypes: true });
      const images = entries
        .filter(
          (entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name),
        )
        .sort((left, right) =>
          left.name.localeCompare(right.name, undefined, {
            numeric: true,
            sensitivity: 'base',
          }),
        )
        .map((entry) => ({
          id: imageId++,
          name: entry.name,
          url: `${origin}/fastkey-images/${encodeURIComponent(type)}/${encodeURIComponent(entry.name)}`,
          image_type: type,
          isDeleted: false,
        }));

      if (images.length) data[type] = images;
    }

    return {
      success: true,
      message: 'FastKey images fetched successfully',
      data,
    };
  }

  async getByFastkeyId(
    fastkeyId: string | undefined,
    userId: string | undefined,
    origin: string,
  ) {
    if (!userId) throw new UnauthorizedException('Authentication is required');

    const id = String(fastkeyId ?? '').trim();
    if (!id) {
      throw new HttpException(
        { message: 'Fast Key ID is required', status: 'error' },
        400,
      );
    }

    const context = await this.resolveContext();
    const repository = this.merchants
      .requireDataSource()
      .getRepository(StoreEmployeeFastkeyEntity);
    let fastkey: StoreEmployeeFastkeyEntity | null = null;
    try {
      fastkey = await repository.findOne({
        where: { id, isDeleted: false },
      });
    } catch (error) {
      if (this.postgresCode(error) !== '22P02') throw error;
    }

    if (!fastkey) {
      throw new HttpException(
        { message: 'Fast Key not found', status: 'error' },
        404,
      );
    }
    if (
      fastkey.employeeId !== context.employee_id ||
      fastkey.storeId !== context.store_id
    ) {
      throw new HttpException(
        { message: 'Unauthorized access', status: 'error' },
        403,
      );
    }

    const assignments = this.productAssignments(fastkey);
    return {
      fastkey_id: fastkey.id,
      fastkey_title: String(fastkey.json?.fastkey_title ?? ''),
      fastkey_image:
        fastkey.fastkeyImage?.trim() ||
        `${origin}/uploads/fastkeys/no-image.png`,
      fastkey_index: this.fastkeyIndex(fastkey),
      products: await this.enhanceProducts(fastkey.storeId, assignments),
      message: 'FastKey products retrieved successfully',
      status: 'success',
    };
  }

  async delete(fastkeyId: string | undefined, userId: string | undefined) {
    if (!userId) throw new UnauthorizedException('Authentication is required');

    const id = String(fastkeyId ?? '').trim();
    if (!id) {
      throw new HttpException(
        { message: 'FastKey ID is required', status: 'error' },
        400,
      );
    }

    const context = await this.resolveContext();
    const repository = this.merchants
      .requireDataSource()
      .getRepository(StoreEmployeeFastkeyEntity);
    let fastkey: StoreEmployeeFastkeyEntity | null = null;
    try {
      fastkey = await repository.findOne({
        where: { id, isDeleted: false },
      });
    } catch (error) {
      if (this.postgresCode(error) !== '22P02') throw error;
    }

    if (!fastkey) {
      throw new HttpException(
        { message: 'FastKey not found', status: 'error' },
        404,
      );
    }
    if (
      fastkey.employeeId !== context.employee_id ||
      fastkey.storeId !== context.store_id
    ) {
      throw new HttpException(
        { message: 'Unauthorized access', status: 'error' },
        403,
      );
    }

    fastkey.isDeleted = true;
    await repository.save(fastkey);
    return {
      message: 'FastKey deleted successfully',
      status: 'success',
      fastkey_id: fastkey.id,
    };
  }

  async deleteProduct(
    dto: DeleteFastkeyProductDto,
    userId: string | undefined,
  ) {
    if (!userId) throw new UnauthorizedException('Authentication is required');

    const fastkeyId = String(dto.fastkey_id ?? '').trim();
    const productId = String(dto.product_id ?? '').trim();
    if (!fastkeyId || !productId) {
      throw new HttpException(
        {
          status: 'error',
          message: 'Missing fastkey_id or product_id',
        },
        400,
      );
    }

    const context = await this.resolveContext();
    const repository = this.merchants
      .requireDataSource()
      .getRepository(StoreEmployeeFastkeyEntity);
    const fastkey = await repository.findOne({
      where: {
        id: fastkeyId,
        employeeId: context.employee_id,
        storeId: context.store_id,
        isDeleted: false,
      },
    });
    if (!fastkey) {
      throw new HttpException(
        { status: 'error', message: 'Fast Key not found' },
        404,
      );
    }

    const assignments = this.productAssignments(fastkey);
    const updatedProducts = assignments.filter(
      (item) => item.product_id !== productId,
    );
    if (updatedProducts.length === assignments.length) {
      throw new HttpException(
        { status: 'error', message: 'Product not found in fastkey' },
        404,
      );
    }

    fastkey.json = { ...fastkey.json, products: updatedProducts };
    await repository.save(fastkey);
    return {
      status: 'success',
      message: 'Product removed from Fast Key',
      fastkey_id: fastkey.id,
      product_id: productId,
      itemCount: updatedProducts.length,
    };
  }

  async update(
    dto: UpdateFastkeyDto,
    userId: string | undefined,
    origin: string,
  ) {
    if (!userId) throw new UnauthorizedException('Authentication is required');
    if (!dto.fastkey_id) {
      throw new HttpException({ message: 'Missing fastkey_id' }, 400);
    }

    const db = this.merchants.requireDataSource();
    const context = await this.resolveContext();
    const repository = db.getRepository(StoreEmployeeFastkeyEntity);
    const fastkey = await repository.findOne({
      where: { id: dto.fastkey_id, isDeleted: false },
    });
    if (!fastkey) {
      throw new HttpException({ message: 'Fast Key not found' }, 404);
    }
    if (
      fastkey.employeeId !== context.employee_id ||
      fastkey.storeId !== context.store_id
    ) {
      throw new HttpException(
        { message: 'You cannot modify this Fast Key' },
        403,
      );
    }

    const requestedTitle = String(dto.fastkey_title ?? '').trim();
    if (requestedTitle) {
      const scopedFastkeys = await repository.find({
        where: {
          employeeId: context.employee_id,
          storeId: context.store_id,
          isDeleted: false,
        },
        select: { id: true, json: true },
      });
      const normalizedTitle = requestedTitle.toLocaleLowerCase();
      if (
        scopedFastkeys.some(
          (item) =>
            item.id !== fastkey.id &&
            String(item.json?.fastkey_title ?? '')
              .trim()
              .toLocaleLowerCase() === normalizedTitle,
        )
      ) {
        throw new HttpException(
          {
            status: 'error',
            message: 'You already have a Fast Key with this title.',
          },
          409,
        );
      }
    }

    const previousImage = fastkey.fastkeyImage;
    await db.transaction(async (manager) => {
      const transactionalRepository = manager.getRepository(
        StoreEmployeeFastkeyEntity,
      );
      const rows = await transactionalRepository.find({
        where: {
          employeeId: context.employee_id,
          storeId: context.store_id,
          isDeleted: false,
        },
      });
      const current = rows.find((item) => item.id === fastkey.id);
      if (!current) {
        throw new HttpException({ message: 'Fast Key not found' }, 404);
      }

      if (requestedTitle) {
        current.json = { ...current.json, fastkey_title: requestedTitle };
      }
      const requestedImage = String(dto.fastkey_image ?? '').trim();
      if (requestedImage) current.fastkeyImage = requestedImage;

      if (dto.fastkey_index !== undefined) {
        const ordered = rows
          .filter((item) => item.id !== current.id)
          .sort(
            (left, right) =>
              this.fastkeyIndex(left) - this.fastkeyIndex(right) ||
              left.id.localeCompare(right.id),
          );
        const requestedIndex = this.toWordPressInteger(dto.fastkey_index);
        const targetIndex = Math.min(
          Math.max(requestedIndex, 1),
          ordered.length + 1,
        );
        ordered.splice(targetIndex - 1, 0, current);
        ordered.forEach((item, index) => {
          item.json = { ...item.json, fastkey_index: index + 1 };
        });
        await transactionalRepository.save(ordered);
      } else {
        await transactionalRepository.save(current);
      }
    });

    const saved = await repository.findOneOrFail({ where: { id: fastkey.id } });
    return {
      previousImage:
        saved.fastkeyImage !== previousImage ? previousImage : undefined,
      response: {
        status: 'success',
        message: 'Fast Key updated',
        fastkey_id: saved.id,
        fastkey_title: String(saved.json?.fastkey_title ?? ''),
        fastkey_index: this.fastkeyIndex(saved),
        fastkey_image:
          saved.fastkeyImage?.trim() ||
          `${origin}/uploads/fastkeys/no-image.png`,
      },
    };
  }

  async addProducts(
    dto: AddFastkeyProductsDto,
    userId: string | undefined,
    origin: string,
  ) {
    if (!userId) throw new UnauthorizedException('Authentication is required');
    if (
      !dto.fastkey_id ||
      !Array.isArray(dto.products) ||
      !dto.products.length
    ) {
      throw new HttpException(
        { message: 'Missing required fields', status: 'error' },
        400,
      );
    }
    const fastkeyId = dto.fastkey_id;
    const requestedProducts = dto.products;

    const db = this.merchants.requireDataSource();
    const context = await this.resolveContext();
    const fastkeyRepository = db.getRepository(StoreEmployeeFastkeyEntity);
    const fastkey = await fastkeyRepository.findOne({
      where: {
        id: fastkeyId,
        employeeId: context.employee_id,
        storeId: context.store_id,
        isDeleted: false,
      },
    });
    if (!fastkey) {
      throw new HttpException(
        { status: 'error', message: 'Fast Key not found' },
        404,
      );
    }

    const catalogProducts = await this.getStoreProducts(fastkey.storeId);
    const existingProductIds = new Set(
      catalogProducts.map((item) => this.productId(item)),
    );
    const updatedProducts = this.productAssignments(fastkey);
    const assignedProductIds = new Set(
      updatedProducts.map((item) => item.product_id),
    );
    const failedProducts: Array<Record<string, unknown>> = [];
    for (const requested of requestedProducts) {
      const productId = String(requested.product_id).trim();
      if (!existingProductIds.has(productId)) {
        failedProducts.push({
          product_id: productId,
          message: 'Product does not exist',
          status: 'failed',
        });
        continue;
      }
      if (assignedProductIds.has(productId)) {
        failedProducts.push({
          product_id: productId,
          message: 'Product already added to this Fast Key',
          status: 'duplicate',
        });
        continue;
      }
      updatedProducts.push({
        product_id: productId,
        sl_number: requested.sl_number,
      });
      assignedProductIds.add(productId);
    }

    fastkey.json = { ...fastkey.json, products: updatedProducts };
    await fastkeyRepository.save(fastkey);
    const products = await this.enhanceProducts(
      fastkey.storeId,
      updatedProducts,
    );

    return {
      fastkey_id: fastkey.id,
      fastkey_title: String(fastkey.json?.fastkey_title ?? ''),
      fastkey_image:
        fastkey.fastkeyImage?.trim() ||
        `${origin}/uploads/fastkeys/no-image.png`,
      fastkey_index: this.fastkeyIndex(fastkey),
      itemCount: updatedProducts.length,
      message: failedProducts.length
        ? 'Some products failed to add'
        : 'FastKeys updated successfully',
      status: failedProducts.length ? 'partial_success' : 'success',
      products,
      failed_products: failedProducts,
    };
  }

  async updateProducts(
    dto: AddFastkeyProductsDto,
    userId: string | undefined,
    origin: string,
  ) {
    if (!userId) throw new UnauthorizedException('Authentication is required');
    if (
      !dto.fastkey_id ||
      !Array.isArray(dto.products) ||
      !dto.products.length
    ) {
      throw new HttpException(
        { message: 'Missing required fields', status: 'error' },
        400,
      );
    }

    const db = this.merchants.requireDataSource();
    const context = await this.resolveContext();
    const fastkeyRepository = db.getRepository(StoreEmployeeFastkeyEntity);
    const fastkey = await fastkeyRepository.findOne({
      where: {
        id: dto.fastkey_id,
        employeeId: context.employee_id,
        storeId: context.store_id,
        isDeleted: false,
      },
    });
    if (!fastkey) {
      throw new HttpException(
        { status: 'error', message: 'Fast Key not found' },
        404,
      );
    }

    const catalogProducts = await this.getStoreProducts(fastkey.storeId);
    const existingProductIds = new Set(
      catalogProducts.map((item) => this.productId(item)),
    );
    const updatedProducts: Array<{ product_id: string; sl_number: number }> =
      [];
    const failedProducts: Array<Record<string, unknown>> = [];

    for (const requested of dto.products) {
      const productId = String(requested.product_id).trim();
      if (!existingProductIds.has(productId)) {
        failedProducts.push({
          product_id: productId,
          message: 'Product does not exist',
          status: 'failed',
        });
        continue;
      }
      updatedProducts.push({
        product_id: productId,
        sl_number: requested.sl_number,
      });
    }

    fastkey.json = { ...fastkey.json, products: updatedProducts };
    await fastkeyRepository.save(fastkey);
    const products = await this.enhanceProducts(
      fastkey.storeId,
      updatedProducts,
    );

    return {
      fastkey_id: fastkey.id,
      fastkey_title: String(fastkey.json?.fastkey_title ?? ''),
      fastkey_image:
        fastkey.fastkeyImage?.trim() ||
        `${origin}/uploads/fastkeys/no-image.png`,
      fastkey_index: this.fastkeyIndex(fastkey),
      itemCount: updatedProducts.length,
      message: failedProducts.length
        ? 'Some products failed to update'
        : 'FastKeys updated successfully',
      status: failedProducts.length ? 'partial_success' : 'success',
      products,
      failed_products: failedProducts,
    };
  }

  private async resolveContext(): Promise<FastkeyContext> {
    const db = this.merchants.requireDataSource();
    const [employee] = await db.getRepository(EmployeeEntity).find({
      order: { createdAt: 'ASC' },
      select: { id: true },
      take: 1,
    });
    if (!employee) {
      throw new ForbiddenException('No employee record is available');
    }
    const [store] = await db.getRepository(StoreEntity).find({
      order: { createdAt: 'ASC' },
      select: { id: true },
      take: 1,
    });
    if (!store) {
      throw new ForbiddenException('No store record is available');
    }
    return { employee_id: employee.id, store_id: store.id };
  }

  private toWordPressInteger(value: string | undefined): number {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private fastkeyIndex(row: StoreEmployeeFastkeyEntity): number {
    const index = Number(row.json?.fastkey_index);
    return Number.isFinite(index) && index !== 0 ? Math.trunc(index) : 1;
  }

  private productAssignments(
    row: StoreEmployeeFastkeyEntity,
  ): Array<{ product_id: string; sl_number: number }> {
    if (!Array.isArray(row.json?.products)) return [];
    return row.json.products
      .map((item) => ({
        product_id: String(item.product_id ?? '').trim(),
        sl_number: Number(item.sl_number),
      }))
      .filter((item) => item.product_id.length > 0);
  }

  private async enhanceProducts(
    storeId: string,
    assignments: Array<{ product_id: string; sl_number: number }>,
  ): Promise<Array<Record<string, unknown>>> {
    if (!assignments.length) return [];
    const catalogProducts = await this.getStoreProducts(storeId);
    const productsById = new Map(
      catalogProducts.map((item) => [this.productId(item), item]),
    );
    return assignments.flatMap((assignment) => {
      const product = productsById.get(assignment.product_id);
      return product
        ? [this.presentProduct(product, assignment.sl_number)]
        : [];
    });
  }

  private presentProduct(
    product: StoreProduct,
    serialNumber: number,
  ): Record<string, unknown> {
    const type = String(product.type ?? '').toLocaleLowerCase();
    const children = Array.isArray(product.children) ? product.children : [];
    return {
      product_id: this.productId(product),
      name: String(product.name ?? ''),
      price: product.price ?? '',
      image: String(product.image ?? ''),
      category: product.categoryName ? [String(product.categoryName)] : [],
      sl_number: serialNumber,
      sku: String(product.sku ?? ''),
      is_variant: type === 'variation' || product.is_variant === true,
      has_variants:
        product.has_variants === true ||
        (type === 'variable' && children.length > 0),
      tags: Array.isArray(product.tags) ? product.tags : [],
    };
  }

  private async getStoreProducts(storeId: string): Promise<StoreProduct[]> {
    const rows = await this.merchants.requireDataSource().query(
      `SELECT payload
       FROM public.store_products
       WHERE store_id = $1::uuid
         AND COALESCE(is_deleted, false) = false
       ORDER BY updated_at DESC
       LIMIT 1`,
      [storeId],
    );
    const payload = rows[0]?.payload;
    const products = Array.isArray(payload)
      ? payload
      : payload &&
          typeof payload === 'object' &&
          Array.isArray(payload.products)
        ? payload.products
        : [];
    return products.filter((item: unknown): item is StoreProduct =>
      Boolean(
        item &&
          typeof item === 'object' &&
          this.productId(item as Record<string, unknown>),
      ),
    );
  }

  private productId(product: Record<string, unknown>): string {
    return String(
      product.id ??
        product.product_id ??
        product.productId ??
        product.wordpressId ??
        '',
    ).trim();
  }

  private fastkeyImageCatalogDirectory(): string {
    const configured = process.env.FASTKEY_IMAGE_CATALOG_DIR?.trim();
    if (configured) return configured;
    return join(
      process.cwd(),
      'apps',
      'merchant-service',
      'src',
      'pos',
      'fastkeys',
      'fastkey-images',
    );
  }

  private fastkeyImageIdStart(): number {
    const configured = Number.parseInt(
      String(process.env.FASTKEY_IMAGE_ID_START ?? '309'),
      10,
    );
    return Number.isFinite(configured) && configured > 0 ? configured : 309;
  }

  private postgresCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const record = error as { code?: string; driverError?: { code?: string } };
    return record.code ?? record.driverError?.code;
  }
}
