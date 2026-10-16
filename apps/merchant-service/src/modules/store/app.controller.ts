import { storeSetup } from '../master/store-setup/store-setup';
import { ValidationPipe, Inject, Controller, Get, Post, Put, Patch, Delete, Param, Body, Query, Req, NotFoundException, BadRequestException, ConflictException, InternalServerErrorException, ForbiddenException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Public } from '@pinaka-delivery-hub/auth';
import { MerchantRepository } from '../merchant/merchant.repository';
import { BusinessType, RetailSubCategory, KycStatus, MerchantStatus } from '../../entities/merchant.entity';
import { PlanCode } from '../../entities/subscription.entity';
import { CreateStoreDto, CreateStoresDto, UpdateStoreDto } from './store.dto';
import { SaveStoreEmployeesDto, AssignStoreEmployeeLoginPinDto, StoreEmployeeAssignmentDto, UpdateStoreEmployeeAssignmentDto } from '../master/store-setup/store-setup.dto';
import { WebsiteConnectionEntity } from '../../entities/website-connection.entity';


@Controller(['api/v1', 'connector/api/v1'])
export class AppController {
  constructor(@Inject(MerchantRepository) private readonly merchantRepository: MerchantRepository) {}
  private toBusinessType(value?: string): BusinessType {
    return value?.toUpperCase() === 'RESTAURANT' ? BusinessType.RESTAURANT : BusinessType.RETAIL;
  }

  private toPlanCode(value?: string): PlanCode {
    return (value?.trim().toUpperCase() || '') as PlanCode;
  }

  private async requireMasterPlan(code: string) {
    const plan = await this.merchantRepository.getSubscriptionPlan(this.toPlanCode(code));
    if (!plan || plan.status !== 'ACTIVE') throw new BadRequestException('Select an active subscription master plan');
  }

  private toBillingCycle(value?: string): 'MONTHLY' | 'ANNUAL' | 'FREE_TRIAL' {
    if (value?.toUpperCase() === 'ANNUAL') return 'ANNUAL';
    if (value?.toUpperCase() === 'FREE TRIAL') return 'FREE_TRIAL';
    return 'MONTHLY';
  }

  private validateWizardPayload(body: any) {
    const required = ['merchantId', 'businessName', 'legalBusinessName', 'businessType', 'country', 'state', 'firstName', 'lastName', 'email', 'phone', 'plan'];
    const missing = required.filter((field) => !String(body[field] ?? '').trim());
    if (!Array.isArray(body.stores) || body.stores.length === 0) missing.push('stores');
    (Array.isArray(body.stores) ? body.stores : []).forEach((store: any, index: number) => {
      ['name', 'id', 'url', 'address', 'city', 'state', 'zip'].forEach((field) => {
        if (!String(store?.[field] ?? '').trim()) missing.push(`stores[${index}].${field}`);
      });
    }); 
    if (missing.length) throw new BadRequestException(`Missing required fields: ${missing.join(', ')}`);
  }

  private merchantFields(body: any) {
    return {
      id: body.merchantId,
      businessName: body.businessName.trim(),
      legalBusinessName: body.legalBusinessName.trim(),
      businessType: this.toBusinessType(body.businessType),
      retailSubCategory: body.retailSubCategory?.toUpperCase() || (body.businessType?.toUpperCase() === 'GROCERY' ? RetailSubCategory.GROCERY : body.businessType?.toUpperCase() === 'CONVENIENCE' ? RetailSubCategory.CONVENIENCE : undefined),
      ownerName: `${body.firstName.trim()} ${body.lastName.trim()}`,
      firstName: body.firstName.trim(),
      lastName: body.lastName.trim(),
      email: body.email.trim().toLowerCase(),
      phone: body.phone.trim(),
      alternatePhone: body.alternatePhone?.trim() || undefined,
      jobTitle: body.jobTitle?.trim() || undefined,
      billingContact: body.billingContact !== false,
      taxId: body.taxId?.trim() || undefined,
      country: body.country.trim(),
      state: body.state.trim(),
      city: body.city?.trim() || undefined,
      postalCode: body.postalCode?.trim() || undefined,
      businessAddress: body.businessAddress?.trim() || undefined,
      status: MerchantStatus.ACTIVE,
      onboardingStep: 'COMPLETED',
    };
  }

  private async saveWizardStores(merchantId: string, stores: any[], country: string, editing = false) {
    return Promise.all(stores.map(async (store) => {
      const fields = {
      id: store.id.trim(),
      storeName: store.name.trim(),
      storeCode: store.id.trim(),
      baseUrl: store.url?.trim(),
      storeWebsiteUrl: store.url?.trim(),
      storeEmail: store.email?.trim(),
      phone: store.phone?.trim() || '',
      storeType: store.type?.trim().toUpperCase() || 'RETAIL',
      address: { street: store.address.trim(), city: store.city.trim(), state: store.state.trim(), zipCode: store.zip.trim(), country },
      currency: store.currency?.trim().toUpperCase() || 'USD',
      timezone: store.timezone?.trim() || 'UTC',
      status: store.status?.trim().toUpperCase() || 'ACTIVE',
    };
      const existing = editing ? await this.merchantRepository.getStoreById(fields.id) : null;
      const saved = existing
        ? await this.merchantRepository.updateStore(fields.id, fields)
        : await this.merchantRepository.createStore(merchantId, fields);
      if (saved && store.employees) await this.attachStoreEmployees(merchantId, saved.id, store.employees);
      return saved;
    }));
  }

  private async attachStoreEmployees(merchantId: string, storeId: string, employees?: StoreEmployeeAssignmentDto[]) {
    if (!employees?.length) return null;
    await this.merchantRepository.saveStoreEmployees(merchantId, storeId, employees);
    return this.merchantRepository.listStoreEmployees(merchantId, storeId);
  }


  async createMerchantFromWizard(@Body() body: any) {
    this.validateWizardPayload(body);
    await this.requireMasterPlan(body.plan);
    const existing = await this.merchantRepository.getMerchantById(body.merchantId);
    if (existing.merchant) throw new ConflictException(`Merchant ID '${body.merchantId}' already exists`);

    const merchant = await this.merchantRepository.createMerchant(this.merchantFields(body));
    const stores = await this.saveWizardStores(merchant.id, body.stores, body.country);
    const subscription = await this.merchantRepository.createOrUpdateSubscription(merchant.id, {
      planCode: this.toPlanCode(body.plan),
      billingCycle: this.toBillingCycle(body.billingCycle),
      trialDays: Number(body.trialPeriod) || 0,
    });
    await this.merchantRepository.recordAuditLog('MERCHANT_ONBOARDING_COMPLETED', merchant.id, undefined, merchant.email, { storeCount: stores.length, plan: subscription.planCode });
    return { success: true, message: 'Merchant created successfully', merchant, stores, subscription };
  }


  async updateMerchantFromWizard(@Param('id') id: string, @Body() body: any) {
    this.validateWizardPayload({ ...body, merchantId: id });
    await this.requireMasterPlan(body.plan);
    const current = await this.merchantRepository.getMerchantById(id);
    if (!current.merchant) throw new NotFoundException('Merchant not found');
    const ids = body.stores.map((store: any) => store.id.trim());
    if (new Set(ids).size !== ids.length) throw new ConflictException('Each store must have a unique ID');
    for (const storeId of ids) {
      const store = await this.merchantRepository.getStoreById(storeId);
      if (store && !(await this.merchantRepository.storeMatchesMerchant(store, id))) throw new ConflictException('Store belongs to another merchant');
    }
    const merchant = await this.merchantRepository.updateMerchant(id, this.merchantFields({ ...body, merchantId: id }));
    if (!merchant) throw new NotFoundException(`Merchant with ID '${id}' not found`);
    const subscription = await this.merchantRepository.createOrUpdateSubscription(id, {
      planCode: this.toPlanCode(body.plan), billingCycle: this.toBillingCycle(body.billingCycle), trialDays: Number(body.trialPeriod) || 0,
    });
    const stores = await this.saveWizardStores(id, body.stores, body.country, true);
    return { success: true, message: 'Merchant updated successfully', merchant, stores, subscription };
  }

  @Post('ids/:kind')
  async allocateId(@Param('kind') kind: string) {
    if (kind !== 'merchant' && kind !== 'store') throw new BadRequestException('Unknown ID type');
    return { id: await this.merchantRepository.allocateId(kind) };
  }

  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'merchant-service',
      version: '2.0.0 (PCH Module 1)',
      timestamp: new Date().toISOString(),
    };
  }

  // --- Step-by-Step Onboarding Endpoints ---

  @Post('onboarding/step1-business')
  async step1Business(@Body() body: { businessName: string; businessType?: BusinessType; retailSubCategory?: RetailSubCategory; ownerName: string; email: string; phone: string }) {
    if (!body.businessName || !body.email || !body.ownerName) {
      throw new BadRequestException('businessName, email, and ownerName are required');
    }
    const merchant = await this.merchantRepository.createMerchant({
      businessName: body.businessName,
      businessType: body.businessType || BusinessType.RETAIL,
      retailSubCategory: body.retailSubCategory,
      ownerName: body.ownerName,
      email: body.email,
      phone: body.phone,
      onboardingStep: 'STEP2_STORE',
    });
    return { success: true, step: 1, merchantId: merchant.id, merchant };
  }

  @Post('onboarding/step2-store')
  async step2Store(@Body() body: { merchantId: string; storeName: string; storeCode?: string; storeType?: string; address?: any; currency?: string; taxRate?: number }) {
    if (!body.merchantId || !body.storeName) {
      throw new BadRequestException('merchantId and storeName are required');
    }
    const store = await this.merchantRepository.createStore(body.merchantId, body);
    return { success: true, step: 2, storeId: store.id, activationPin: store.activationPin, store };
  }

  @Post('onboarding/step3-plan')
  async step3Plan(@Body() body: { merchantId: string; planCode: PlanCode; billingCycle?: 'MONTHLY' | 'ANNUAL' }) {
    if (!body.merchantId || !body.planCode) {
      throw new BadRequestException('merchantId and planCode are required');
    }
    const sub = await this.merchantRepository.createOrUpdateSubscription(body.merchantId, body);
    return { success: true, step: 3, subscriptionId: sub.id, entitlements: sub.entitlements, subscription: sub };
  }

  // --- All-in-One Complete Wizard Submission ---
  @Post('onboarding/complete')
  async completeOnboarding(@Body() body: any) {
    const merchant = await this.merchantRepository.createMerchant({
      businessName: body.businessName || 'Fresh Mart Organics LLC',
      businessType: body.businessType || BusinessType.RETAIL,
      retailSubCategory: body.retailSubCategory || (body.businessType === BusinessType.RETAIL ? RetailSubCategory.GROCERY : undefined),
      ownerName: body.ownerName || 'Alex Johnson',
      email: body.email || 'alex@freshmart.com',
      phone: body.phone || '+1 (555) 234-5678',
      taxId: body.taxId || '12-3456789',
      kycStatus: KycStatus.VERIFIED,
      status: MerchantStatus.ACTIVE,
      onboardingStep: 'COMPLETED',
    });

    const store = await this.merchantRepository.createStore(merchant.id, {
      storeName: body.storeName || `${merchant.businessName} - Main Store`,
      storeCode: body.storeCode || 'STR-MAIN-01',
      storeType: body.businessType || 'GROCERY',
      address: body.address || { street: '123 Main St', city: 'Austin', state: 'TX', zipCode: '78701', country: 'USA' },
      taxRate: body.taxRate || 8.25,
    });

    const subscription = await this.merchantRepository.createOrUpdateSubscription(merchant.id, {
      planCode: body.planCode || PlanCode.PRO,
    });

    return {
      success: true,
      message: 'Merchant onboarding completed successfully. Store is active!',
      merchant,
      store,
      subscription,
      terminalPairingPin: store.activationPin,
    };
  }

  // --- Flutter POS Activation by 6-Digit PIN ---
  @Public()
  @Post('stores/activate-terminal')
  async activateTerminal(@Body('activationPin') activationPin: string) {
    if (!activationPin || activationPin.trim().length !== 6) {
      throw new BadRequestException('A valid 6-digit activation PIN is required');
    }
    const result = await this.merchantRepository.activateTerminalByPin(activationPin.trim());
    if (!result.success) {
      throw new NotFoundException(result.message);
    }
    return {
      success: true,
      message: 'Terminal paired successfully with store!',
      store: result.store,
      entitlements: result.entitlements,
      sessionToken: `jwt_session_${Date.now()}_token`,
    };
  }

  /**
   * Website Connection tab: save WordPress URL and JWT (screenshot Save JWT Token).
   * Path matches production `/connector/api/v1/stores/:storeId/connector`.
   */
  @Put('stores/:storeId/connector')
  async saveWebsiteConnector(
    @Param('storeId') storeId: string,
    @Body() body: { wordpressUrl?: string; wordpressJwt?: string; merchantId?: string },
    @Req() request: { user?: { role?: string } },
  ) {
    this.requireOwnerRole(request.user?.role);
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    const existing = await this.merchantRepository.getWebsiteConnection(storeId);
    const wordpressUrl = this.validateWordPressUrl(body.wordpressUrl);
    const replacementJwt = body.wordpressJwt?.trim();
    if (!replacementJwt && !existing?.encryptedJwt) {
      throw new BadRequestException('wordpressJwt is required');
    }
    const wordpressJwt = replacementJwt
      ? replacementJwt
      : this.decryptConnectorSecret(existing!.encryptedJwt);

    const test = await this.pingWordPress(wordpressUrl, wordpressJwt);
    const connection = await this.merchantRepository.saveWebsiteConnection({
      storeId: store.id,
      merchantId: store.merchantId,
      wordpressUrl,
      encryptedJwt: replacementJwt
        ? this.encryptConnectorSecret(replacementJwt)
        : existing!.encryptedJwt,
      status: test.ok ? 'CONNECTED' : 'NOT_CONNECTED',
      lastTestedAt: new Date(),
      lastTestMessage: test.message,
    });
    await this.merchantRepository.recordAuditLog(
      'STORE_WEBSITE_CONNECTOR_UPDATED',
      store.merchantId,
      store.id,
      'merchant',
      { provider: 'WORDPRESS', wordpressUrl, status: connection.status },
    );
    return {
      success: true,
      message: test.ok ? 'Website connected. JWT token saved.' : 'JWT saved, but the WordPress site could not be verified.',
      storeId: store.id,
      merchantId: store.merchantId,
      connector: this.toPublicConnector(connection),
    };
  }

  @Post('stores/:storeId/connector/test')
  async testWebsiteConnector(
    @Param('storeId') storeId: string,
    @Body() body: { wordpressUrl?: string; wordpressJwt?: string },
    @Req() request: { user?: { role?: string } },
  ) {
    this.requireOwnerRole(request.user?.role);
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    const existing = await this.merchantRepository.getWebsiteConnection(storeId);
    const wordpressUrl = this.validateWordPressUrl(body.wordpressUrl || existing?.wordpressUrl);
    const wordpressJwt = body.wordpressJwt?.trim();
    if (!wordpressJwt) throw new BadRequestException('wordpressJwt is required to test the connection');
    const test = await this.pingWordPress(wordpressUrl, wordpressJwt);
    return {
      success: test.ok,
      status: test.ok ? 'CONNECTED' : 'NOT_CONNECTED',
      message: test.message,
      wordpressUrl,
    };
  }

  @Get('stores/:storeId/connector')
  async getWebsiteConnector(
    @Param('storeId') storeId: string,
    @Req() request: { user?: { role?: string } },
  ) {
    this.requireOwnerRole(request.user?.role);
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    const connection = await this.merchantRepository.getWebsiteConnection(storeId);
    return {
      success: true,
      storeId,
      storeName: store.storeName,
      connector: this.toPublicConnector(connection),
    };
  }

  @Post('stores/:storeId/catalog/sync')
  async syncStoreCatalogFromWebsite(
    @Param('storeId') storeId: string,
    @Req() request: { user?: { role?: string } },
  ) {
    this.requireOwnerRole(request.user?.role);
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    const connector = await this.merchantRepository.getWebsiteConnector(storeId);
    if (!connector?.encryptedJwt || !connector.wordpressUrl) {
      throw new BadRequestException('Connect the WordPress site before syncing the catalog');
    }
    const catalog = await this.syncStoreCatalog(
      store.merchantId,
      store.id,
      connector.wordpressUrl,
      this.decryptConnectorSecret(connector.encryptedJwt),
    );
    return {
      success: true,
      message: 'Store catalog synced from WordPress.',
      storeId: store.id,
      merchantId: store.merchantId,
      catalog,
    };
  }

  @Post('stores/:storeId/catalog/sync/products')
  async syncStoreProductsFromWebsite(
    @Param('storeId') storeId: string,
    @Req() request: { user?: { role?: string } },
  ) {
    const connection = await this.requireWordPressConnection(storeId, request.user?.role);
    const count = await this.merchantRepository.syncStoreProductsFromWordPress(connection);
    return {
      success: true,
      message: `Synced ${count} products.`,
      storeId: connection.storeId,
      productCount: count,
    };
  }

  @Post('stores/:storeId/catalog/sync/categories')
  async syncStoreCategoriesFromWebsite(
    @Param('storeId') storeId: string,
    @Req() request: { user?: { role?: string } },
  ) {
    const connection = await this.requireWordPressConnection(storeId, request.user?.role);
    const count = await this.merchantRepository.syncStoreCategoriesFromWordPress(connection);
    return {
      success: true,
      message: `Synced ${count} categories.`,
      storeId: connection.storeId,
      categoryCount: count,
    };
  }

  @Post('stores/:storeId/catalog/sync/attributes')
  async syncStoreAttributesFromWebsite(
    @Param('storeId') storeId: string,
    @Req() request: { user?: { role?: string } },
  ) {
    const connection = await this.requireWordPressConnection(storeId, request.user?.role);
    const count = await this.merchantRepository.syncStoreAttributesFromWordPress(connection);
    return {
      success: true,
      message: `Synced ${count} attributes.`,
      storeId: connection.storeId,
      attributeCount: count,
    };
  }

  @Post('stores/:storeId/catalog/sync/tags')
  async syncStoreTagsFromWebsite(
    @Param('storeId') storeId: string,
    @Req() request: { user?: { role?: string } },
  ) {
    const connection = await this.requireWordPressConnection(storeId, request.user?.role);
    const count = await this.merchantRepository.syncStoreTagsFromWordPress(connection);
    return {
      success: true,
      message: `Synced ${count} tags.`,
      storeId: connection.storeId,
      tagCount: count,
    };
  }

  @Get('stores/:storeId/catalog/products/sku/:sku')
  async getStoreProductBySku(
    @Param('storeId') storeId: string,
    @Param('sku') sku: string,
  ) {
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    return this.merchantRepository.findStoreProductBySku(store.id, sku);
  }

  @Get('stores/:storeId/catalog/products/:sku')
  getStoreProduct(
    @Param('storeId') storeId: string,
    @Param('sku') sku: string,
  ) {
    return this.getStoreProductBySku(storeId, sku);
  }

  @Get('stores/:storeId/catalog')
  async getStoreCatalog(@Param('storeId') storeId: string) {
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    const catalog = await this.merchantRepository.getStoreCatalog(storeId);
    return {
      success: true,
      storeId: store.id,
      merchantId: store.merchantId,
      categoryCount: catalog.categories.length,
      productCount: catalog.products.length,
      categories: catalog.categories,
      products: catalog.products,
    };
  }

  @Get('store/:storeId/store-categories')
  async getSavedStoreCategories(@Param('storeId') storeId: string) {
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    const payload = await this.merchantRepository.getStoreCategoriesByStoreId(store.id);
    return payload;
  }

  @Get('stores/:storeId/catalog/taxonomies')
  async getStoreCatalogTaxonomies(@Param('storeId') storeId: string) {
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    return {
      success: true,
      storeId: store.id,
      merchantId: store.merchantId,
      ...(await this.merchantRepository.getStoreCatalogTaxonomiesByStoreId(store.id)),
    };
  }

  @Get('store/:storeId/products/search')
  async searchStoreProducts(
    @Param('storeId') storeId: string,
    @Query('search') search?: string,
  ) {
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    return this.merchantRepository.searchStoreProducts(store.id, search ?? '');
  }

  @Get('store/:storeId/products/:productId/variations')
  async getStoreProductVariations(
    @Param('storeId') storeId: string,
    @Param('productId') productId: string,
  ) {
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    const variations = await this.merchantRepository.getStoreProductVariations(store.id, productId);
    if (!Array.isArray(variations) || variations.length === 0) return variations;

    const variationIds = variations
      .map((variation) =>
        variation && typeof variation === 'object'
          ? String((variation as Record<string, unknown>).id ?? '')
          : '',
      )
      .filter((id) => /^\d+$/.test(id));
    if (variationIds.length === 0) return variations;

    const imageRows: Array<{ variation_id: string; image: unknown }> =
      await this.merchantRepository.requireDataSource().query(
        `
        SELECT product.item->>'id' AS variation_id,
               product.item->'image' AS image
        FROM public.store_products AS catalog
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(catalog.payload) = 'array' THEN catalog.payload
            ELSE '[]'::jsonb
          END
        ) AS product(item)
        WHERE catalog.store_id = $1::uuid
          AND COALESCE(catalog.is_deleted, false) = false
          AND product.item->>'id' = ANY($2::text[])
        `,
        [store.id, variationIds],
      );
    const imagesByVariationId = new Map(
      imageRows.map((row) => [String(row.variation_id), row.image]),
    );

    return variations.map((variation) => {
      if (!variation || typeof variation !== 'object' || Array.isArray(variation)) return variation;
      const record = variation as Record<string, unknown>;
      const existingImages = Array.isArray(record.images) ? record.images : [];
      const storedImage = imagesByVariationId.get(String(record.id ?? ''));
      const image = storedImage ?? record.image ?? existingImages[0] ?? null;
      const images = image === null
        ? []
        : [image && typeof image === 'object' ? image : { src: image }];
      return {
        ...record,
        image,
        images,
      };
    });
  }

  @Get('store/:storeId/store-categories/:categoryId/products')
  async getStoreProductsByCategory(
    @Param('storeId') storeId: string,
    @Param('categoryId') categoryId: string,
  ) {
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    return this.merchantRepository.getStoreProductsByCategoryId(store.id, categoryId);
  }

  @Get('stores/:storeId/configuration')
  async getStoreConfiguration(@Param('storeId') storeId: string) {
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    const connection = await this.merchantRepository.getWebsiteConnection(storeId);
    return {
      success: true,
      store,
      websiteConnection: this.toPublicConnector(connection),
    };
  }

  // --- Standard CRUD ---
  @Post(['stores', 'merchants/:merchantId/stores'])
  async createStore(
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: CreateStoreDto })) body: CreateStoreDto,
    @Req() request: { user?: { id?: string } },
    @Param('merchantId') merchantId?: string,
  ) {
    const bodyMerchantId = body.merchant_id || body.merchantId;
    if (merchantId && bodyMerchantId && merchantId !== bodyMerchantId) {
      throw new BadRequestException('Merchant ID in the URL must match the request body');
    }
    const ownerId = merchantId || bodyMerchantId;
    if (!ownerId) throw new BadRequestException('merchant_id is required');
    const { merchant } = await this.merchantRepository.getMerchantById(ownerId);
    if (!merchant) throw new NotFoundException(`Merchant '${ownerId}' not found`);
    const storeKey = body.store_code || body.store_id || body.storeId;
    if (storeKey && await this.merchantRepository.getStoreById(storeKey)) {
      throw new ConflictException(`Store ID '${storeKey}' already exists. Choose a different Store ID.`);
    }
    const fields = { ...this.storeCreationFields(body, merchant.country), createdBy: request.user?.id ?? null };
    if (!fields.storeName) throw new BadRequestException('name is required');
    const store = await this.merchantRepository.createStore(ownerId, fields);
    await this.merchantRepository.saveStoreFeaturesAndRolePermissions(store, body.features || [], body.rolePermissions || []);
    const employees = await this.attachStoreEmployees(ownerId, store.id, body.employees);
    return { success: true, store: this.toStoreResponse(store), ...(employees ? { employees, count: employees.length } : {}) };
  }

  private toStoreResponse(store: Record<string, any>) {
    const url = store.storeWebsiteUrl ?? null;
    const email = store.storeEmail ?? null;
    return {
      ...store,
      store_code: store.storeCode,
      store_name: store.storeName,
      store_email: email,
      email,
      storeEmail: email,
      store_website_url: url,
      url,
      storeWebsiteUrl: url,
    };
  }

  private storeCreationFields(body: CreateStoreDto, country?: string) {
    const timezones: Record<string, string> = {
      Kolkata: 'Asia/Kolkata', 'Central Time (CT)': 'America/Chicago',
      'Eastern Time (ET)': 'America/New_York', 'Pacific Time (PT)': 'America/Los_Angeles',
    };
    const storeKey = body.store_code || body.store_id || body.storeId;
    const storeType = body.store_type_id || body.storeTypeId || body.type;
    const street = String(body.address_line1 || body.address || '').trim();
    return {
      id: storeKey,
      storeCode: storeKey,
      storeName: String(body.name || body.store_name || body.storeName || '').trim(),
      storeTypeId: storeType,
      storeType: storeType?.trim(),
      phone: body.phone?.trim() || '',
      email: (body.store_email || body.email)?.trim(),
      storeEmail: (body.store_email || body.email)?.trim(),
      baseUrl: (body.store_website_url || body.url)?.trim(),
      storeWebsiteUrl: (body.store_website_url || body.url)?.trim(),
      currency: body.currency,
      status: body.status,
      timezone: timezones[body.timezone || ''] || body.timezone || 'UTC',
      activationPin: body.activation_pin || body.activationPin,
      operationalStatus: body.operational_status,
      onboardingSetup: storeSetup(body),
      addressLine1: street || undefined,
      addressLine2: body.address_line2 || body.addressLine2,
      postalCode: body.postal_code || body.zip,
      city: body.city,
      state: body.state,
      country: body.country || country,
      address: {
        street,
        addressLine2: body.address_line2 || body.addressLine2,
        city: String(body.city || '').trim(),
        state: String(body.state || '').trim(),
        zipCode: String(body.postal_code || body.zip || '').trim(),
        country: body.country || country || '',
      },
    };
  }

  @Post('merchants/:merchantId/stores/bulk')
  async createStoresBatch(@Param('merchantId') merchantId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: CreateStoresDto })) body: CreateStoresDto, @Req() request: { user?: { id?: string } }) {
    if (body.stores.some(s => {
      const owner = s.merchant_id || s.merchantId;
      return Boolean(owner) && owner !== merchantId;
    })) {
      throw new BadRequestException('All stores must belong to the merchant in the URL');
    }
    const { merchant } = await this.merchantRepository.getMerchantById(merchantId);
    if (!merchant) throw new NotFoundException('Merchant not found');
    const stores = await this.merchantRepository.createStoresBatch(merchantId,
      body.stores.map(s => ({ ...this.storeCreationFields(s, merchant.country), createdBy: request.user?.id ?? null })));
    for (const [index, store] of stores.entries()) {
      await this.attachStoreEmployees(merchantId, store.id, body.stores[index].employees);
    }
    return { success: true, count: stores.length, stores };
  }

  @Get(['stores', 'merchants/:merchantId/stores'])
  async listStores(@Param('merchantId') merchantId?: string) {
    const resolvedMerchantId = merchantId ? await this.merchantRepository.resolveMerchantId(merchantId) : undefined;
    if (merchantId && !resolvedMerchantId) throw new NotFoundException('Merchant not found');
    const [stores, merchants] = await Promise.all([
      this.merchantRepository.listStores(resolvedMerchantId || undefined),
      this.merchantRepository.getAllMerchants(),
    ]);
    const names = new Map<string, string>();
    for (const merchant of merchants) {
      const label = merchant.businessName || merchant.merchantId || merchant.id;
      names.set(merchant.id, label);
      if (merchant.merchantId) names.set(merchant.merchantId, label);
    }
    if (resolvedMerchantId && !names.has(resolvedMerchantId)) throw new NotFoundException('Merchant not found');
    // Listing deliberately excludes activation PINs and channel credentials.
    const rows = stores.map(s => ({
      ...this.toStoreResponse(s),
      id: s.id, storeCode: s.storeCode || s.id, merchantId: s.merchantId, merchantName: names.get(s.merchantId) || s.merchantId,
      storeName: s.storeName, storeType: s.storeTypeId,
      address: [s.addressLine1, s.addressLine2, s.city, s.state, s.postalCode, s.country].filter(Boolean).join(', '),
      city: s.city, state: s.state,
      status: s.status, currency: s.currency, timezone: s.timezone,
      createdAt: s.createdAt, updatedAt: s.updatedAt,
      deviceCount: null, lastSyncAt: null,
    }));
    return { success: true, count: rows.length, stores: rows };
  }

  @Get('merchants/:merchantId/stores/:storeId/role-permissions')
  async listStoreRolePermissions(@Param('merchantId') merchantId: string, @Param('storeId') storeId: string) {
    const rolePermissions = await this.merchantRepository.listStoreWizardRolePermissions(merchantId, storeId);
    return { success: true, count: rolePermissions.length, rolePermissions };
  }

  @Get('merchants/:merchantId/stores/:storeId/employees')
  async listStoreEmployees(@Param('merchantId') merchantId: string, @Param('storeId') storeId: string) {
    const employees = await this.merchantRepository.listStoreEmployees(merchantId, storeId);
    return { success: true, count: employees.length, employees };
  }

  @Get('merchants/:merchantId/stores/:storeId/employees/assignment-screen')
  async getStoreEmployeeAssignmentScreen(
    @Param('merchantId') merchantId: string,
    @Param('storeId') storeId: string,
  ) {
    const employees = await this.merchantRepository.listStoreEmployees(merchantId, storeId);
    return { success: true, count: employees.length, employees };
  }

  @Put('merchants/:merchantId/stores/:storeId/employees')
  async saveStoreEmployees(
    @Param('merchantId') merchantId: string,
    @Param('storeId') storeId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: SaveStoreEmployeesDto })) body: SaveStoreEmployeesDto,
  ) {
    await this.merchantRepository.saveStoreEmployees(merchantId, storeId, body.employees || []);
    const employees = await this.merchantRepository.listStoreEmployees(merchantId, storeId);
    return { success: true, count: employees.length, employees };
  }

  @Put('merchants/:merchantId/stores/:storeId/employees/:employeeId/login-pin')
  @Patch('merchants/:merchantId/stores/:storeId/employees/:employeeId/login-pin')
  async assignStoreEmployeeLoginPin(
    @Param('merchantId') merchantId: string,
    @Param('storeId') storeId: string,
    @Param('employeeId') employeeId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: AssignStoreEmployeeLoginPinDto })) body: AssignStoreEmployeeLoginPinDto,
  ) {
    const employee = await this.merchantRepository.assignStoreEmployeeLoginPin(merchantId, storeId, employeeId, body.loginPin);
    return { success: true, message: 'Employee login PIN assigned', employee };
  }

  @Patch('merchants/:merchantId/stores/:storeId/employees/:employeeId')
  async updateStoreEmployeeAssignment(
    @Param('merchantId') merchantId: string,
    @Param('storeId') storeId: string,
    @Param('employeeId') employeeId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: UpdateStoreEmployeeAssignmentDto })) body: UpdateStoreEmployeeAssignmentDto,
  ) {
    if (body.role_template_id === undefined && body.login_pin === undefined)
      throw new BadRequestException('Provide role_template_id, login_pin, or both');
    const employee = await this.merchantRepository.updateStoreEmployeeAssignment(
      merchantId,
      storeId,
      employeeId,
      body,
    );
    return { success: true, message: 'Employee store assignment updated', employee };
  }

  @Get(['stores/:storeId', 'merchants/:merchantId/stores/:storeId'])
  async getStore(@Param('storeId') storeId: string, @Param('merchantId') merchantId?: string) {
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store || (merchantId && !(await this.merchantRepository.storeMatchesMerchant(store, merchantId)))) throw new NotFoundException(`Store '${storeId}' not found`);
    const connection = await this.merchantRepository.getWebsiteConnection(storeId);
    const setup = store.onboardingSetup || {};
    let rolePermissions: Array<Record<string, unknown>> = Array.isArray(setup.rolePermissions) ? setup.rolePermissions : [];
    try {
      const rows = await this.merchantRepository.listStoreWizardRolePermissions(store.merchantId, store.id);
      if (rows.length) rolePermissions = this.groupWizardRolePermissions(rows);
    } catch {
      rolePermissions = Array.isArray(setup.rolePermissions) ? setup.rolePermissions : [];
    }
    return {
      success: true,
      store: {
        ...this.toStoreResponse(store),
        hours: Array.isArray(setup.hours) ? setup.hours : [],
        features: Array.isArray(setup.features) ? setup.features : [],
        rolePermissions,
      },
      websiteConnection: this.toPublicConnector(connection),
    };
  }

  private groupWizardRolePermissions(rows: Array<Record<string, unknown>>) {
    const actions = ['View', 'Create', 'Edit', 'Delete'];
    const roles = new Map<string, { roleTemplateId: string | null; name: string; permissions: Record<string, Record<string, boolean>> }>();
    for (const row of rows) {
      const roleTemplateId = row.roleTemplateId ? String(row.roleTemplateId) : '';
      const name = String(row.roleName || '');
      const key = roleTemplateId || name;
      if (!key) continue;
      if (!roles.has(key)) roles.set(key, { roleTemplateId: roleTemplateId || null, name, permissions: {} });
      const action = String(row.permissionAction || '');
      const featureName = String(row.featureName || '');
      if (!featureName || !actions.includes(action)) continue;
      const role = roles.get(key)!;
      if (!role.permissions[featureName]) role.permissions[featureName] = { View: false, Create: false, Edit: false, Delete: false };
      const allowed = row.allowed;
      role.permissions[featureName][action] = allowed === true || allowed === 'true' || allowed === 't';
    }
    return [...roles.values()];
  }

  @Put(['stores/:storeId', 'merchants/:merchantId/stores/:storeId'])
  async updateStore(@Param('storeId') storeId: string, @Body(new ValidationPipe({ transform: true, whitelist: true, expectedType: UpdateStoreDto })) body: UpdateStoreDto,
    @Param('merchantId') merchantId?: string) {
    const existing = await this.merchantRepository.getStoreById(storeId);
    if (!existing || (merchantId && !(await this.merchantRepository.storeMatchesMerchant(existing, merchantId)))) {
      throw new NotFoundException(`Store '${storeId}' not found`);
    }
    const requestedMerchant = body.merchant_id || body.merchantId;
    const requestedStore = body.store_code || body.storeId;
    if (requestedMerchant && !(await this.merchantRepository.storeMatchesMerchant(existing, requestedMerchant))) {
      throw new BadRequestException('Merchant and store ID cannot be changed');
    }
    if (
      requestedStore &&
      requestedStore !== storeId &&
      requestedStore !== existing.id &&
      requestedStore !== existing.storeCode
    ) {
      throw new BadRequestException('Merchant and store ID cannot be changed');
    }
    const storeType = body.store_type_id || body.type;
    const street = body.address_line1 || body.address;
    const store = await this.merchantRepository.updateStore(storeId, {
      storeName: (body.name || body.store_name || body.storeName || existing.storeName).trim(),
      storeTypeId: storeType ? await this.merchantRepository.resolveStoreTypeId({ storeTypeId: storeType, storeType }) : existing.storeTypeId,
      phone: body.phone?.trim() ?? existing.phone,
      storeEmail: body.store_email === undefined && body.email === undefined
        ? existing.storeEmail
        : ((body.store_email || body.email || '').trim().toLowerCase() || null),
      storeWebsiteUrl: (body.store_website_url ?? body.url)?.trim() ?? existing.storeWebsiteUrl,
      currency: body.currency ?? existing.currency,
      status: body.status ?? existing.status,
      timezone: body.timezone ?? existing.timezone,
      activationPin: body.activation_pin ?? existing.activationPin,
      operationalStatus: body.operational_status ?? existing.operationalStatus,
      onboardingSetup: storeSetup(body, existing.onboardingSetup),
      addressLine1: street?.trim() ?? existing.addressLine1,
      addressLine2: (body.address_line2 || body.addressLine2)?.trim() ?? existing.addressLine2,
      city: body.city?.trim() ?? existing.city,
      state: body.state?.trim() ?? existing.state,
      postalCode: (body.postal_code || body.zip)?.trim() ?? existing.postalCode,
      country: body.country ?? existing.country,
    });
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    await this.merchantRepository.saveStoreFeaturesAndRolePermissions(store, body.features || [], body.rolePermissions || []);
    const employees = await this.attachStoreEmployees(body.merchantId || merchantId, store.id, body.employees);
    return {
      success: true,
      store: this.toStoreResponse(store),
      ...(employees ? { employees, count: employees.length } : {}),
    };
  }

  @Delete(['stores/:storeId', 'merchants/:merchantId/stores/:storeId'])
  async deleteStore(@Param('storeId') storeId: string, @Param('merchantId') merchantId?: string) {
    const existing = await this.merchantRepository.getStoreById(storeId);
    if (!existing || (merchantId && !(await this.merchantRepository.storeMatchesMerchant(existing, merchantId)))) {
      throw new NotFoundException(`Store '${storeId}' not found`);
    }
    const deleted = await this.merchantRepository.deleteStore(storeId);
    if (!deleted) throw new NotFoundException(`Store '${storeId}' not found`);
    return {
      success: true,
      message: `Store '${storeId}' deleted successfully`,
      storeId,
      deletedAt: deleted.deletedAt,
      isDeleted: deleted.isDeleted,
    };
  }

  async getAllMerchants() {
    const list = await this.merchantRepository.getAllMerchants();
    const [stores, subscriptions] = await Promise.all([this.merchantRepository.listStores(), this.merchantRepository.listSubscriptions()]);
    const merchants = list.map(merchant => ({ ...merchant,
      storeCount: stores.filter(store => store.merchantId === merchant.merchantId || store.merchantId === merchant.id || store.merchantUuid === merchant.id).length,
      subscription: subscriptions.find(subscription => subscription.merchantId === merchant.id) || null,
    }));
    return { success: true, count: merchants.length, merchants };
  }

  async getMerchantById(@Param('id') id: string) {
    const result = await this.merchantRepository.getMerchantById(id);
    if (!result.merchant) {
      throw new NotFoundException(`Merchant with ID '${id}' not found`);
    }
    return { success: true, ...result };
  }

  private toPublicConnector(connection: WebsiteConnectionEntity | null) {
    if (!connection) {
      return {
        status: 'NOT_CONNECTED' as const,
        provider: 'WORDPRESS',
        wordpressUrl: '',
        wordpressJwtConfigured: false,
      };
    }
    return {
      status: connection.status,
      provider: connection.provider,
      wordpressUrl: connection.wordpressUrl,
      wordpressJwtConfigured: Boolean(connection.encryptedJwt),
      lastTestedAt: connection.lastTestedAt,
      lastTestMessage: connection.lastTestMessage,
      updatedAt: connection.updatedAt,
    };
  }

  private requireOwnerRole(role?: string): void {
    if (process.env.SKIP_AUTH === 'true') return;
    if (role !== 'OWNER') throw new ForbiddenException('Only owners may manage website connectors');
  }

  private async pingWordPress(wordpressUrl: string, wordpressJwt: string): Promise<{ ok: boolean; message: string }> {
    const headers = { Accept: 'application/json', Authorization: `Bearer ${wordpressJwt}` };
    const baseUrl = wordpressUrl.replace(/\/+$/, '');
    try {
      const response = await fetch(`${baseUrl}/wp-json/wp/v2/users/me`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) return { ok: true, message: 'WordPress JWT verified successfully.' };
      // WooCommerce bearer tokens may be valid for the REST API while lacking
      // permission to use WordPress's users/me endpoint. Validate them against
      // the same WooCommerce Coupons API used by the coupon integration.
      const wooResponse = await fetch(`${baseUrl}/wp-json/wc/v3/coupons?per_page=1`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (wooResponse.ok) return { ok: true, message: 'WooCommerce bearer token verified successfully.' };
      return {
        ok: false,
        message: `WordPress JWT check returned HTTP ${response.status}; WooCommerce Coupons API check returned HTTP ${wooResponse.status}. Check the site URL and token.`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Could not verify the WordPress or WooCommerce token: ${message}` };
    }
  }

  private validateWordPressUrl(value?: string): string {
    if (!value?.trim()) throw new BadRequestException('wordpressUrl is required');
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:') throw new Error('not https');
      return url.toString().replace(/\/$/, '');
    } catch {
      throw new BadRequestException('wordpressUrl must be a valid HTTPS URL');
    }
  }

  private connectorEncryptionKey(): Buffer {
    const keyValue = process.env.STORE_CONFIG_ENCRYPTION_KEY;
    const key = keyValue
      ? Buffer.from(keyValue, 'base64')
      : createHash('sha256').update(process.env.AUTH_JWT_SECRET || 'pdh-local-development-secret-change-me').digest();
    if (key.length !== 32) {
      throw new InternalServerErrorException('STORE_CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
    return key;
  }

  private encryptConnectorSecret(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.connectorEncryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64url')}:${ciphertext.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}`;
  }

  private decryptConnectorSecret(value: string): string {
    const [version, ivPart, ciphertextPart, tagPart] = value.split(':');
    if (version !== 'v1' || !ivPart || !ciphertextPart || !tagPart) {
      throw new BadRequestException(
        'The saved WordPress JWT is no longer valid. Edit the website connection and save the JWT token again.',
      );
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.connectorEncryptionKey(),
        Buffer.from(ivPart, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new BadRequestException(
        'The saved WordPress JWT was encrypted with a different server key. Edit the website connection and save the JWT token again.',
      );
    }
  }

  private async requireWordPressConnection(storeId: string, role?: string) {
    this.requireOwnerRole(role);
    const store = await this.merchantRepository.getStoreById(storeId);
    if (!store) throw new NotFoundException(`Store '${storeId}' not found`);
    const connector = await this.merchantRepository.getWebsiteConnection(store.id)
      || await this.merchantRepository.getWebsiteConnection(storeId);
    if (!connector?.encryptedJwt || !connector.wordpressUrl) {
      throw new BadRequestException('Connect the WordPress site before syncing the catalog');
    }
    if (connector.status !== 'CONNECTED') {
      throw new BadRequestException('Validate the WordPress connection before syncing.');
    }
    return {
      merchantId: store.merchantId,
      storeId: store.id,
      wordpressUrl: connector.wordpressUrl,
      wordpressJwt: this.decryptConnectorSecret(connector.encryptedJwt),
    };
  }

  private async syncStoreCatalog(
    merchantId: string,
    storeId: string,
    wordpressUrl: string,
    wordpressJwt: string,
  ) {
    try {
      return await this.merchantRepository.syncStoreCatalogFromWordPress({
        merchantId,
        storeId,
        wordpressUrl,
        wordpressJwt,
      });
    } catch (error: unknown) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Could not sync WordPress catalog: ${message}`);
    }
  }
}
