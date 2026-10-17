import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { MerchantStoreLoginDto } from '../dto/merchant-store-login.dto';
import { PosLoginDto } from '../dto/pos-login.dto';
import { PinService } from './pin.service';
import { PosSessionService } from './pos-session.service';
import { MerchantRepository } from '../../merchant/merchant.repository';

export interface DeviceContext {
  deviceId: string;
  merchantId: string;
  storeId: string;
  registerId: string;
  status: string;
}

@Injectable()
export class PosAuthService {
  constructor(
    @Inject(PinService) private readonly pinService: PinService,
    @Inject(PosSessionService) private readonly posSessionService: PosSessionService,
    @Inject(MerchantRepository) private readonly merchantRepository: MerchantRepository,
  ) {}

  /**
   * API 1: Merchant & Store Login / Information Lookup Service
   * Public auth route - No Bearer token required in request
   */
  async merchantStoreLogin(dto: MerchantStoreLoginDto) {
    const rawMerchant = (
      dto?.merchantIdentifier ||
      dto?.merchantId ||
      dto?.merchantCode ||
      dto?.email ||
      ''
    ).trim();

    const rawStore = (
      dto?.storeId ||
      dto?.storeCode ||
      dto?.storeName ||
      ''
    ).trim();

    if (!rawMerchant) {
      throw new BadRequestException('Merchant identifier (merchantId, code, or email) is required');
    }

    const dataSource = this.merchantRepository.requireDataSource();
    const merchants: any[] = await dataSource.query(
      `SELECT id, 
              merchant_code AS "merchantCode", 
              merchant_id AS "merchantId", 
              "business_display_name" AS "businessDisplayName", 
              "first_name" AS "firstName", "last_name" AS "lastName", email, phone, status 
       FROM public.merchants 
       WHERE (lower(email) = lower($1) OR "merchant_code" = $1 OR merchant_code = $1 OR "merchant_id" = $1 OR merchant_id = $1 OR id::text = $1 OR lower("business_display_name") = lower($1)) 
       LIMIT 1`,
      [rawMerchant],
    );

    const merchant = merchants[0];
    if (!merchant) {
      throw new UnauthorizedException('Invalid merchant credentials');
    }

    if (merchant.status && (String(merchant.status).toUpperCase() === 'INACTIVE' || String(merchant.status).toUpperCase() === 'SUSPENDED')) {
      throw new ForbiddenException('Merchant account is inactive or suspended');
    }

    let store: any = null;
    if (rawStore) {
      const stores: any[] = await dataSource.query(
        `SELECT id, "store_code" AS "storeCode", 
                "store_name" AS "storeName", 
                "store_website_url" AS "storeWebsiteUrl", "address_line1" AS "addressLine1", 
                city, state, country, "operational_status" AS "operationalStatus", status, "website_connector"
         FROM public.stores 
         WHERE (merchant_id::text = $1 OR merchant_id IN (SELECT id FROM public.merchants WHERE id::text = $1 OR "merchant_id" = $1 OR merchant_id = $1 OR "merchant_code" = $1 OR merchant_code = $1))
           AND (id::text = $2 OR lower(store_code) = lower($2) OR lower(store_name) = lower($2))
         LIMIT 1`,
        [String(merchant.id), rawStore],
      );
      store = stores[0];
    }

    if (!store) {
      const stores: any[] = await dataSource.query(
        `SELECT id, "store_code" AS "storeCode", 
                "store_name" AS "storeName", 
                "store_website_url" AS "storeWebsiteUrl", "address_line1" AS "addressLine1", 
                city, state, country, "operational_status" AS "operationalStatus", status, "website_connector"
         FROM public.stores 
         WHERE (merchant_id::text = $1 OR merchant_id IN (SELECT id FROM public.merchants WHERE id::text = $1 OR "merchant_id" = $1 OR merchant_id = $1 OR "merchant_code" = $1 OR merchant_code = $1))
           AND (status IS NULL OR UPPER(status::text) <> 'INACTIVE')
         ORDER BY created_at ASC
         LIMIT 1`,
        [String(merchant.id)],
      );
      store = stores[0];
    }

    if (!store) {
      throw new NotFoundException(`Store '${rawStore || 'default'}' not found for this merchant`);
    }

    if (store.status && String(store.status).toUpperCase() === 'INACTIVE') {
      throw new ForbiddenException('Store is currently inactive');
    }

    const storeUrl = store.storeWebsiteUrl ||
      store.website_connector?.wordpressUrl ||
      `https://${(store.storeCode || 'store').toLowerCase()}.${(merchant.merchantCode || 'merchant').toLowerCase()}.pch.com`;

    return {
      success: true,
      message: 'Merchant and Store authenticated successfully',
      data: {
        merchant: {
          id: merchant.id,
          merchantCode: merchant.merchantCode,
          merchantId: merchant.merchantId,
          businessDisplayName: merchant.businessDisplayName || `${merchant.firstName || ''} ${merchant.lastName || ''}`.trim(),
          email: merchant.email,
          phone: merchant.phone,
          status: merchant.status,
        },
        store: {
          id: store.id,
          storeCode: store.storeCode,
          storeName: store.storeName,
          storeWebsiteUrl: storeUrl,
          addressLine1: store.addressLine1,
          city: store.city,
          state: store.state,
          country: store.country,
          operationalStatus: store.operationalStatus,
          status: store.status,
        },
        storeUrl,
      },
    };
  }

  /**
   * API 2: Employee PIN Login Service (POS Authentication)
   * Public endpoint - No Bearer token required in request
   * Supports 6-digit PIN login with automatic employee resolution across
   * public.employee_stores and public.employees tables.
   */
  async loginEmployee(param1: PosLoginDto | any, param2?: DeviceContext | any) {
    let dto: PosLoginDto = param1 || {};
    let deviceCtx: DeviceContext = param2 || (param1 as any)?.device || {};

    if (param1 && typeof param1 === 'object' && ('pin' in param1 || 'employeeCode' in param1)) {
      dto = param1;
      deviceCtx = param2 || (param1 as any).device || {};
    } else if (param2 && typeof param2 === 'object' && ('pin' in param2 || 'employeeCode' in param2)) {
      dto = param2;
      deviceCtx = param1 || {};
    }

    const pin = dto?.pin ? String(dto.pin).trim() : '';
    if (!pin) {
      throw new UnauthorizedException('PIN is required for POS login');
    }

    const rawEmployeeCode = dto?.employeeCode ? String(dto.employeeCode).trim() : undefined;
    const bodySerial = dto?.device_serial_number || 
                       dto?.device_serialnumber || 
                       (dto as any)?.['device_serial number'] || 
                       dto?.serialNumber;

    const bodyDeviceId = dto?.deviceServiceNumber || dto?.deviceCode || dto?.deviceId || dto?.deviceService || (dto as any)?.device?.id;
    const bodyMerchantId = (dto as any)?.merchantId || (dto as any)?.merchantCode || (dto as any)?.merchant?.id;
    const bodyStoreId = (dto as any)?.storeId || (dto as any)?.storeCode || (dto as any)?.store?.id;
    const bodyRegisterId = (dto as any)?.registerId || (dto as any)?.device?.registerId;

    let deviceId = bodyDeviceId || deviceCtx.deviceId;
    let targetMerchantId = bodyMerchantId || deviceCtx.merchantId;
    let targetStoreId = bodyStoreId || deviceCtx.storeId;
    const registerId = bodyRegisterId || deviceCtx.registerId || 'REG-01';

    let employee: any = null;
    let store: any = null;
    let merchant: any = null;
    let matchedRole: string = 'CASHIER';
    let matchedRoleName: string = 'Cashier';
    let matchedRoleId: string = 'ROLE001';

    const dataSource = this.merchantRepository.requireDataSource();

      // If serial number is passed, resolve device
      if (bodySerial && !deviceId) {
        const matchingDevices = await dataSource.query(
          `SELECT id, "device_code" AS "deviceCode", "merchant_id" AS "merchantId" 
           FROM public.devices 
           WHERE ("serial_number" = $1 OR "device_code" = $1 OR id::text = $1)
           LIMIT 1`,
          [String(bodySerial).trim()],
        );
        if (matchingDevices[0]) {
          deviceId = matchingDevices[0].id || matchingDevices[0].deviceCode;
          if (!targetMerchantId && matchingDevices[0].merchantId) {
            targetMerchantId = matchingDevices[0].merchantId;
          }
        }
      }

      // 1. Resolve Target Merchant if specified
      if (targetMerchantId) {
        const merchants = await dataSource.query(
          `SELECT id, 
                  merchant_code AS "merchantCode", 
                  merchant_id AS "merchantId", 
                  "business_display_name" AS "businessDisplayName", 
                  "first_name" AS "firstName", "last_name" AS "lastName", email, phone, status 
           FROM public.merchants 
           WHERE (id::text = $1 OR "merchant_id" = $1 OR merchant_id = $1 OR "merchant_code" = $1 OR merchant_code = $1 OR lower(email) = lower($1))
           LIMIT 1`,
          [String(targetMerchantId).trim()],
        );
        merchant = merchants[0];
        if (merchant) {
          targetMerchantId = merchant.id;
          if (merchant.status && (String(merchant.status).toUpperCase() === 'INACTIVE' || String(merchant.status).toUpperCase() === 'SUSPENDED')) {
            throw new ForbiddenException('Merchant account is inactive or suspended');
          }
        }
      }

      // 2. Resolve Target Store if specified
      if (targetStoreId) {
        let storeWhere = `(id::text = $1 OR lower(store_code) = lower($1) OR lower(store_name) = lower($1))`;
        let storeParams: any[] = [String(targetStoreId).trim()];
        if (targetMerchantId) {
          storeParams.push(String(targetMerchantId));
          storeWhere += ` AND (merchant_id::text = $2 OR merchant_id IN (SELECT id FROM public.merchants WHERE id::text = $2 OR "merchant_id" = $2 OR merchant_id = $2 OR "merchant_code" = $2 OR merchant_code = $2))`;
        }
        const stores = await dataSource.query(
          `SELECT id, "store_code" AS "storeCode", 
                  "store_name" AS "storeName", 
                  "store_website_url" AS "storeWebsiteUrl", status, merchant_id AS "merchantId"
           FROM public.stores 
           WHERE ${storeWhere}
           LIMIT 1`,
          storeParams,
        );
        store = stores[0];
        if (store) {
          targetStoreId = store.id;
          if (!targetMerchantId && store.merchantId) {
            targetMerchantId = store.merchantId;
          }
        }
      }

      if (!store?.id) {
        throw new NotFoundException('Store not found for this merchant');
      }

      // 3. Match the PIN against this store's employee_stores and employees tables
      const queryParams: any[] = [String(store.id)];
      let candidateQuery = `
        SELECT
          e.id,
          e.employee_code AS "employeeCode",
          e.first_name AS "firstName",
          e.last_name AS "lastName",
          e.status,
          COALESCE(e.merchant_id, es.merchant_id) AS "merchantId",
          es.store_id AS "assignedStoreId",
          COALESCE(es.login_pin_hash, e.login_pin_hash) AS "storePinHash",
          e.login_pin_hash AS "empPinHash",
          role.role_id AS "roleId",
          role.role_code AS "roleCode",
          role.role_name AS "roleName"
        FROM public.employee_stores es
        JOIN public.employees e ON e.id = es.employee_id
        LEFT JOIN LATERAL (
          SELECT esr.role_id, COALESCE(rt.role_code, legacy_role.role_code) AS role_code,
            COALESCE(rt.name, legacy_role.name) AS role_name
          FROM public.employee_store_roles esr
          LEFT JOIN public.role_templates rt ON rt.id = esr.role_id
          LEFT JOIN public.roles legacy_role ON legacy_role.id = esr.role_id
          WHERE esr.employee_store_id = es.id
            AND (esr.status IS NULL OR UPPER(esr.status::text) <> 'INACTIVE')
          ORDER BY esr.created_at ASC
          LIMIT 1
        ) role ON true
        WHERE es.store_id = $1::uuid
          AND (e.status IS NULL OR UPPER(e.status::text) <> 'INACTIVE')
          AND (es.status IS NULL OR UPPER(es.status::text) <> 'INACTIVE')
          AND (es.login_pin_hash IS NOT NULL OR e.login_pin_hash IS NOT NULL)
      `;
      if (targetMerchantId) {
        queryParams.push(String(targetMerchantId));
        candidateQuery += ` AND (e.merchant_id::text = $${queryParams.length} OR es.merchant_id::text = $${queryParams.length} OR e.merchant_id IN (SELECT id FROM public.merchants WHERE id::text = $${queryParams.length} OR "merchant_id" = $${queryParams.length} OR merchant_id = $${queryParams.length} OR "merchant_code" = $${queryParams.length} OR merchant_code = $${queryParams.length}))`;
      }
      if (rawEmployeeCode) {
        queryParams.push(rawEmployeeCode);
        candidateQuery += ` AND e.employee_code = $${queryParams.length}`;
      }
      candidateQuery += ` ORDER BY es.is_primary DESC, e.created_at ASC`;

      let candidates = await dataSource.query(candidateQuery, queryParams);

      // If no store-assigned employee matched, search all active employees for this merchant
      if (!candidates || candidates.length === 0) {
        const merchantParams: any[] = [String(store.id)];
        let merchantEmpQuery = `
          SELECT
            e.id,
            e.employee_code AS "employeeCode",
            e.first_name AS "firstName",
            e.last_name AS "lastName",
            e.status,
            e.merchant_id AS "merchantId",
            $1::uuid AS "assignedStoreId",
            e.login_pin_hash AS "storePinHash",
            e.login_pin_hash AS "empPinHash",
            NULL AS "roleId",
            'CASHIER' AS "roleCode",
            'Cashier' AS "roleName"
          FROM public.employees e
          WHERE (e.status IS NULL OR UPPER(e.status::text) <> 'INACTIVE')
            AND e.login_pin_hash IS NOT NULL
        `;
        if (targetMerchantId) {
          merchantParams.push(String(targetMerchantId));
          merchantEmpQuery += ` AND (e.merchant_id::text = $${merchantParams.length} OR e.merchant_id IN (SELECT id FROM public.merchants WHERE id::text = $${merchantParams.length} OR "merchant_id" = $${merchantParams.length} OR merchant_id = $${merchantParams.length} OR "merchant_code" = $${merchantParams.length} OR merchant_code = $${merchantParams.length}))`;
        }
        if (rawEmployeeCode) {
          merchantParams.push(rawEmployeeCode);
          merchantEmpQuery += ` AND e.employee_code = $${merchantParams.length}`;
        }
        merchantEmpQuery += ` ORDER BY e.created_at ASC`;
        candidates = await dataSource.query(merchantEmpQuery, merchantParams);
      }

      for (const cand of candidates) {
        const hashes = [cand.storePinHash, cand.empPinHash].filter(Boolean);
        let matched = false;
        for (const h of hashes) {
          if (await this.pinService.verify(pin, h)) {
            matched = true;
            break;
          }
        }
        if (!matched && (cand.storePinHash === pin || cand.empPinHash === pin)) {
          matched = true;
        }
        if (!matched) continue;

        employee = {
          id: cand.id,
          employeeCode: cand.employeeCode,
          firstName: cand.firstName,
          lastName: cand.lastName,
          merchantId: cand.merchantId,
          status: cand.status,
          assignedStoreId: cand.assignedStoreId,
          roleId: cand.roleId,
          roleCode: cand.roleCode,
          roleName: cand.roleName,
        };
        if (cand.roleCode || cand.roleName || cand.roleId) {
          matchedRole = cand.roleCode || cand.roleName || 'CASHIER';
          matchedRoleName = cand.roleName || cand.roleCode || 'Cashier';
          matchedRoleId = cand.roleId || 'ROLE001';
        }
        break;
      }

      if (!employee) {
        throw new UnauthorizedException('Invalid PIN for this merchant and store');
      }

      // 4. Resolve final merchant details if needed
      if (!merchant && targetMerchantId) {
        const merchants = await dataSource.query(
          `SELECT id, 
                  merchant_code AS "merchantCode", 
                  merchant_id AS "merchantId", 
                  "business_display_name" AS "businessDisplayName", 
                  "first_name" AS "firstName", "last_name" AS "lastName", email, phone, status 
           FROM public.merchants 
           WHERE (id::text = $1 OR "merchant_id" = $1 OR merchant_id = $1 OR "merchant_code" = $1 OR merchant_code = $1)
           LIMIT 1`,
          [String(targetMerchantId)],
        );
        merchant = merchants[0];
      }

      // 5. Resolve final store details if needed
      if (!store) {
        const finalMerchant = targetMerchantId || merchant?.id || employee.merchantId;
        const stores = await dataSource.query(
          `SELECT id, "store_code" AS "storeCode", 
                  "store_name" AS "storeName", 
                  "store_website_url" AS "storeWebsiteUrl", status, merchant_id AS "merchantId"
           FROM public.stores 
           WHERE (merchant_id::text = $1 OR merchant_id IN (SELECT id FROM public.merchants WHERE id::text = $1 OR "merchant_id" = $1 OR merchant_id = $1 OR "merchant_code" = $1 OR merchant_code = $1)) 
             AND (status IS NULL OR UPPER(status::text) <> 'INACTIVE')
           ORDER BY created_at ASC
           LIMIT 1`,
          [String(finalMerchant)],
        );
        store = stores[0];
      }

    const activeMerchantId = targetMerchantId || store?.merchantId || employee?.merchantId || 'ce7e95a3-5dd3-4063-af03-251825c9a2d9';
    const activeStoreId = store?.id || targetStoreId || '5066038f-0e26-40f5-a4bf-44a1bdd300ac';
    const activeDeviceId = deviceId || deviceCtx.deviceId || 'DEV-99881';

    const session = await this.posSessionService.createSession({
      employeeId: employee.id,
      merchantId: activeMerchantId,
      storeId: activeStoreId,
      deviceId: activeDeviceId,
      registerId: registerId,
      roleId: matchedRoleId,
      roleCode: matchedRole,
      roleName: matchedRoleName,
    });

    // Save session into employee_sessions table
    try {
      const dataSource = this.merchantRepository.requireDataSource();
      await dataSource.query(`
        CREATE TABLE IF NOT EXISTS public.employee_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          employee_id UUID NOT NULL,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          store_id UUID,
          merchant_id UUID,
          device_id VARCHAR(100),
          session_created_at TIMESTAMPTZ DEFAULT NOW(),
          session_updated_at TIMESTAMPTZ DEFAULT NOW(),
          status VARCHAR(20) DEFAULT 'Active'
        );
        ALTER TABLE public.employee_sessions ADD COLUMN IF NOT EXISTS "access_token" TEXT;
        ALTER TABLE public.employee_sessions ADD COLUMN IF NOT EXISTS "refresh_token" TEXT;
        ALTER TABLE public.employee_sessions ADD COLUMN IF NOT EXISTS "session_created_at" TIMESTAMPTZ DEFAULT NOW();
        ALTER TABLE public.employee_sessions ADD COLUMN IF NOT EXISTS "session_updated_at" TIMESTAMPTZ DEFAULT NOW();
        ALTER TABLE public.employee_sessions ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) DEFAULT 'Active';
      `);

      if (employee?.id) {
        await dataSource.query(
          `INSERT INTO public.employee_sessions 
           (employee_id, access_token, refresh_token, store_id, merchant_id, device_id, session_created_at, session_updated_at, status)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), 'Active')`,
          [
            String(employee.id),
            session.accessToken,
            session.refreshToken,
            activeStoreId ? String(activeStoreId) : null,
            activeMerchantId ? String(activeMerchantId) : null,
            activeDeviceId ? String(activeDeviceId) : null,
          ]
        );
      }
    } catch (saveErr) {}

    const storeUrl = store?.storeWebsiteUrl ||
      `https://${(store?.storeCode || 'store').toLowerCase()}.${(merchant?.merchantCode || 'merchant').toLowerCase()}.pch.com`;

    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      employee: {
        id: employee.id,
        employeeCode: employee.employeeCode,
        firstName: employee.firstName,
        lastName: employee.lastName,
      },
      store: store ? {
        id: store.id,
        storeCode: store.storeCode,
        storeName: store.storeName,
        storeWebsiteUrl: storeUrl,
      } : null,
      device: {
        id: activeDeviceId,
        registerId: registerId,
      },
      role: {
        id: matchedRoleId,
        code: matchedRole,
      },
    };
  }

  /**
   * Store products for the merchant and store named in the request headers.
   * The POS login access token is checked before any catalog data is read.
   */
  async getStoreProducts(
    authorization?: string,
    merchantHeader?: string,
    storeHeader?: string,
  ) {
    const scope = await this.authorizeStoreCatalog(authorization, merchantHeader, storeHeader);
    const products = await this.queryStoreProducts(scope);
    return {
      success: true,
      merchantId: scope.merchant.id,
      storeId: scope.store.id,
      productCount: products.length,
      products,
    };
  }

  async getStoreCategoriesAndProducts(
    authorization?: string,
    merchantHeader?: string,
    storeHeader?: string,
  ) {
    const scope = await this.authorizeStoreCatalog(authorization, merchantHeader, storeHeader);
    try {
      const rows = await scope.dataSource.query(
        `SELECT store_categories_products
         FROM public.store_products
         WHERE store_id = $1::uuid
           AND COALESCE(is_deleted, false) = false
         LIMIT 1`,
        [scope.store.id],
      );
      return rows[0]?.store_categories_products ?? null;
    } catch (error) {
      if (this.postgresCode(error) === '42P01' || this.postgresCode(error) === '42703') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Verifies that a refund-authorizing PIN belongs to the employee represented
   * by the active POS session. This mirrors the WordPress refund-valid-user
   * contract while retaining PCH merchant/store isolation.
   */
  async validateRefundUser(
    employeePin: unknown,
    authorization?: string,
    merchantHeader?: string,
    storeHeader?: string,
  ) {
    const pin = String(employeePin ?? '').trim();
    if (!/^\d{6}$/.test(pin)) {
      throw new BadRequestException({
        success: false,
        statusCode: 400,
        code: pin ? 'invalid_pin_format' : 'invalid_pin',
        message: pin ? 'PIN must be exactly 6 digits.' : 'Invalid PIN or user not found.',
        data: {},
      });
    }

    const scope = await this.authorizeStoreCatalog(authorization, merchantHeader, storeHeader);
    const candidates = await scope.dataSource.query(
      `SELECT e.id::text AS id,
              COALESCE(es.login_pin_hash, e.login_pin_hash) AS "storePinHash",
              e.login_pin_hash AS "employeePinHash",
              COALESCE(es.login_pin, e.login_pin) AS "storePin",
              e.login_pin AS "employeePin"
         FROM public.employee_stores AS es
         JOIN public.employees AS e ON e.id = es.employee_id
        WHERE es.store_id = $1::uuid
          AND (e.merchant_id = $2::uuid OR es.merchant_id = $2::uuid)
          AND (e.status IS NULL OR upper(e.status::text) <> 'INACTIVE')
          AND (es.status IS NULL OR upper(es.status::text) <> 'INACTIVE')
          AND (
            es.login_pin_hash IS NOT NULL OR e.login_pin_hash IS NOT NULL
            OR es.login_pin IS NOT NULL OR e.login_pin IS NOT NULL
          )`,
      [scope.store.id, scope.merchant.id],
    );

    let matchedEmployeeId: string | undefined;
    for (const candidate of candidates) {
      const plainPins = [candidate.storePin, candidate.employeePin]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      const hashes = [candidate.storePinHash, candidate.employeePinHash].filter(Boolean);
      let matched = plainPins.includes(pin);
      for (const hash of hashes) {
        if (!matched && await this.pinService.verify(pin, hash)) matched = true;
      }
      if (matched) {
        matchedEmployeeId = String(candidate.id);
        break;
      }
    }

    if (!matchedEmployeeId) {
      throw new BadRequestException({
        success: false,
        statusCode: 400,
        code: 'invalid_pin',
        message: 'Invalid PIN or user not found.',
        data: {},
      });
    }
    if (matchedEmployeeId !== scope.employeeId) {
      throw new ForbiddenException({
        success: false,
        statusCode: 403,
        code: 'unauthorized_user',
        message: 'You are not authorized to access this resource.',
        data: {},
      });
    }
    return { success: true, message: 'User verified successfully' };
  }

  

  /**
   * Store categories for the merchant and store named in the request headers.
   * The POS login access token is checked before any catalog data is read.
   */
  async getStoreCategories(
    authorization?: string,
    merchantHeader?: string,
    storeHeader?: string,
  ) {
    const scope = await this.authorizeStoreCatalog(authorization, merchantHeader, storeHeader);
    const categories = await this.queryStoreCategories(scope);
    return {
      success: true,
      merchantId: scope.merchant.id,
      storeId: scope.store.id,
      categoryCount: categories.length,
      categories,
    };
  }

  /**
   * Distinct product tags for the merchant and store named in the request headers.
   * The POS login access token is checked before any catalog data is read.
   */
  async getStoreTags(
    authorization?: string,
    merchantHeader?: string,
    storeHeader?: string,
  ) {
    const scope = await this.authorizeStoreCatalog(authorization, merchantHeader, storeHeader);
    const products = await this.queryStoreProducts(scope);
    const tags = this.collectTags(products);
    return {
      success: true,
      merchantId: scope.merchant.id,
      storeId: scope.store.id,
      tagCount: tags.length,
      tags,
    };
  }

  /**
   * All rows in store_pos_configurations for the store on the login token.
   */
  async getStorePosConfigurations(
    authorization?: string,
    merchantHeader?: string,
    storeHeader?: string,
  ) {
    const scope = await this.authorizeStoreCatalog(authorization, merchantHeader, storeHeader);
    let configurations: Array<Record<string, unknown>> = [];
    try {
      configurations = await scope.dataSource.query(
        `SELECT id::text AS id,
                store_id::text AS "storeId",
                configuration_name AS "configurationName",
                configuration_value AS "configurationValue",
                created_by::text AS "createdBy",
                updated_by::text AS "updatedBy",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
         FROM public.store_pos_configurations
         WHERE store_id = $1::uuid
         ORDER BY configuration_name ASC, id ASC`,
        [scope.store.id],
      );
    } catch (error) {
      if (this.postgresCode(error) !== '42P01') throw error;
    }
    return {
      success: true,
      merchantId: scope.merchant.id,
      storeId: scope.store.id,
      count: configurations.length,
      configurations,
    };
  }

  /**
   * Products, categories, and tags for one store.
   * The POS login access token is checked before any catalog data is read.
   */
  async getStoreCatalog(
    authorization?: string,
    merchantHeader?: string,
    storeHeader?: string,
  ) {
    const scope = await this.authorizeStoreCatalog(authorization, merchantHeader, storeHeader);
    const [products, categories] = await Promise.all([
      this.queryStoreProducts(scope),
      this.queryStoreCategories(scope),
    ]);
    const tags = this.collectTags(products);
    return {
      success: true,
      merchantId: scope.merchant.id,
      storeId: scope.store.id,
      productCount: products.length,
      categoryCount: categories.length,
      tagCount: tags.length,
      products,
      categories,
      tags,
    };
  }

  private async authorizeStoreCatalog(
    authorization: string | undefined,
    merchantHeader: string | undefined,
    storeHeader: string | undefined,
  ): Promise<CatalogScope> {
    const token = this.extractBearerToken(authorization);
    const payload = this.posSessionService.verifyAccessToken(token);

    const dataSource = this.merchantRepository.requireDataSource();
    let session: EmployeeSessionRow | undefined;
    try {
      const rows = await dataSource.query(
        `SELECT id::text AS id,
                employee_id::text AS employee_id,
                store_id::text AS store_id,
                merchant_id::text AS merchant_id,
                status
         FROM public.employee_sessions
         WHERE access_token = $1
           AND lower(COALESCE(status, '')) = 'active'
         ORDER BY session_created_at DESC NULLS LAST
         LIMIT 1`,
        [token],
      );
      session = rows[0];
    } catch (error) {
      if (this.postgresCode(error) === '42P01') {
        throw new UnauthorizedException('Session is not active. Please log in again.');
      }
      throw error;
    }
    if (!session || session.employee_id !== String(payload.sub)) {
      throw new UnauthorizedException('Session is not active. Please log in again.');
    }

    const merchantKey = String(merchantHeader || '').trim();
    const storeKey = String(storeHeader || '').trim();
    if (!merchantKey) {
      throw new BadRequestException('x-merchant-id header is required');
    }
    if (!storeKey) {
      throw new BadRequestException('x-store-id header is required');
    }

    const merchants = await dataSource.query(
      `SELECT id::text AS id, merchant_code AS "merchantCode", merchant_id AS "merchantId", status
       FROM public.merchants
       WHERE id::text = $1
          OR merchant_id::text = $1
          OR merchant_code = $1
          OR lower(email) = lower($1)
       LIMIT 1`,
      [merchantKey],
    );
    const merchant = merchants[0] as MerchantScopeRow | undefined;
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }
    if (merchant.status && merchant.status !== 'ACTIVE') {
      throw new ForbiddenException('Merchant account is inactive or suspended');
    }

    const stores = await dataSource.query(
      `SELECT id::text AS id,
              store_code AS "storeCode",
              store_name AS "storeName",
              merchant_id::text AS "merchantId",
              status
       FROM public.stores
       WHERE (id::text = $1 OR store_code = $1 OR lower(store_name) = lower($1))
         AND (
           merchant_id::text = $2
           OR merchant_id IN (
             SELECT id FROM public.merchants
             WHERE id::text = $2 OR merchant_id::text = $2 OR merchant_code = $2
           )
         )
       LIMIT 1`,
      [storeKey, merchant.id],
    );
    const store = stores[0] as StoreScopeRow | undefined;
    if (!store) {
      throw new NotFoundException('Store not found for this merchant');
    }
    if (store.status && store.status !== 'ACTIVE') {
      throw new ForbiddenException('Store is currently inactive');
    }

    const merchantIds = this.identityKeys(merchant.id, merchant.merchantId, merchant.merchantCode);
    const storeIds = this.identityKeys(store.id, store.storeCode);
    this.assertTokenMatchesStore(payload, session, merchantIds, storeIds);

    return { dataSource, merchant, store, merchantIds, storeIds, employeeId: session.employee_id };
  }

  private assertTokenMatchesStore(
    payload: { merchantId?: string; storeId?: string },
    session: EmployeeSessionRow,
    merchantIds: string[],
    storeIds: string[],
  ): void {
    const tokenMerchant = String(payload.merchantId || '').trim();
    const tokenStore = String(payload.storeId || '').trim();
    const sessionMerchant = String(session.merchant_id || '').trim();
    const sessionStore = String(session.store_id || '').trim();

    const merchantOk =
      this.keyIn(sessionMerchant, merchantIds) &&
      (!tokenMerchant || this.keyIn(tokenMerchant, merchantIds));
    const storeOk =
      this.keyIn(sessionStore, storeIds) &&
      (!tokenStore || this.keyIn(tokenStore, storeIds));

    if (!merchantOk || !storeOk) {
      throw new ForbiddenException('Login token is not valid for this merchant and store');
    }
  }

  private async queryStoreProducts(scope: CatalogScope): Promise<CatalogProduct[]> {
    const rows = await this.queryCatalog(
      scope,
      `SELECT store_id::text AS store_id, payload
         FROM public.store_products
        WHERE store_id::text = ANY($2::text[])
          AND COALESCE(is_deleted, false) = false`,
    );
    return rows.flatMap((row) => {
      const products = Array.isArray(row.payload) ? row.payload : [];
      return products.map((value: Record<string, any>) => {
        const categories = Array.isArray(value?.categories) ? value.categories : [];
        const first = categories[0] || {};
        const images = Array.isArray(value?.images) ? value.images : [];
        return {
          id: String(value?.id ?? ''),
          merchantId: String(scope.merchant.id || ''),
          storeId: String(row.store_id || ''),
          categoryId: first?.id != null ? String(first.id) : null,
          wordpressId: value?.id ?? null,
          wordpressCategoryId: first?.id ?? null,
          name: String(value?.name || ''),
          price: value?.price ?? null,
          image: images[0]?.src ?? value?.image ?? null,
          tags: Array.isArray(value?.tags) ? value.tags : [],
          payload: value ?? {},
        };
      });
    });
  }

  private async queryStoreCategories(scope: CatalogScope): Promise<CatalogCategory[]> {
    const rows = await this.queryCatalog(
      scope,
      `SELECT store_id::text AS store_id, payload
         FROM public.store_categories
        WHERE store_id::text = ANY($2::text[])
          AND COALESCE(is_deleted, false) = false`,
    );
    return rows.flatMap((row) => {
      const categories = Array.isArray(row.payload) ? row.payload : [];
      return categories.map((value: Record<string, any>) => ({
        id: String(value?.id ?? value?.wordpressId ?? ''),
        merchantId: String(scope.merchant.id || ''),
        storeId: String(row.store_id || value?.storeId || ''),
        wordpressId: value?.id ?? value?.wordpressId ?? null,
        parentWordpressId: Number(value?.parent ?? value?.parentWordpressId ?? 0),
        name: String(value?.name || ''),
        slug: String(value?.slug || ''),
        description: String(value?.description || ''),
        productCount: Number(value?.count ?? value?.productCount ?? 0),
        image: value?.image?.src ?? value?.image ?? null,
        posTaxClass: String(value?.pos_tax_class ?? value?.posTaxClass ?? ''),
        posTaxPercent: String(value?.pos_tax_percent ?? value?.posTaxPercent ?? ''),
        payload: value?.payload ?? value ?? {},
      }));
    });
  }

  private async queryCatalog(scope: CatalogScope, sql: string): Promise<Array<Record<string, any>>> {
    try {
      return await scope.dataSource.query(sql, [scope.merchantIds, scope.storeIds]);
    } catch (error) {
      if (this.postgresCode(error) === '42P01') {
        throw new NotFoundException('Store catalog has not been synced');
      }
      throw error;
    }
  }

  private collectTags(products: CatalogProduct[]): unknown[] {
    const seen = new Set<string>();
    const tags: unknown[] = [];
    const add = (value: unknown) => {
      const list = Array.isArray(value) ? value : [];
      for (const tag of list) {
        const key = typeof tag === 'string'
          ? tag.trim().toLowerCase()
          : JSON.stringify(tag);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        tags.push(typeof tag === 'string' ? tag.trim() : tag);
      }
    };
    for (const product of products) {
      add(product.tags);
      const payload = product.payload;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        add((payload as { tags?: unknown }).tags);
      }
    }
    tags.sort((left, right) => this.tagLabel(left).localeCompare(this.tagLabel(right)));
    return tags;
  }

  private tagLabel(tag: unknown): string {
    if (typeof tag === 'string') return tag;
    if (tag && typeof tag === 'object') {
      const record = tag as { name?: unknown; slug?: unknown; id?: unknown };
      return String(record.name || record.slug || record.id || '');
    }
    return '';
  }

  private extractBearerToken(authorization?: string): string {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!token) {
      throw new UnauthorizedException('Bearer token is required');
    }
    return token;
  }

  private identityKeys(...values: Array<string | null | undefined>): string[] {
    return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
  }

  private keyIn(value: string, keys: string[]): boolean {
    if (!value) return false;
    const normalized = value.toLowerCase();
    return keys.some((key) => key.toLowerCase() === normalized);
  }

  private postgresCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const record = error as { code?: string; driverError?: { code?: string } };
    return record.code || record.driverError?.code;
  }
}

interface EmployeeSessionRow {
  id: string;
  employee_id: string;
  store_id?: string | null;
  merchant_id?: string | null;
  status?: string | null;
}

interface MerchantScopeRow {
  id: string;
  merchantCode?: string | null;
  merchantId?: string | null;
  status?: string | null;
}

interface StoreScopeRow {
  id: string;
  storeCode?: string | null;
  storeName?: string | null;
  merchantId?: string | null;
  status?: string | null;
}

interface CatalogScope {
  dataSource: { query: (sql: string, params?: unknown[]) => Promise<any[]> };
  merchant: MerchantScopeRow;
  store: StoreScopeRow;
  merchantIds: string[];
  storeIds: string[];
  employeeId: string;
}

interface CatalogProduct {
  id: string;
  merchantId: string;
  storeId: string;
  categoryId: string | null;
  wordpressId: number | null;
  wordpressCategoryId: number | null;
  name: string;
  price: string | number | null;
  image: string | null;
  tags: unknown[];
  payload: unknown;
}

interface CatalogCategory {
  id: string;
  merchantId: string;
  storeId: string;
  wordpressId: number | null;
  parentWordpressId: number;
  name: string;
  slug: string;
  description: string;
  productCount: number;
  image: string | null;
  posTaxClass: string;
  posTaxPercent: string;
  payload: unknown;
}
