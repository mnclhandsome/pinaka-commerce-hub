import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { postgresConnectionOptions } from '@pinaka-delivery-hub/database';
import { isISO8601 } from 'class-validator';
import { Relationship } from './relationships.config';

export type RelationshipOperation =
  | 'list'
  | 'get'
  | 'create'
  | 'replace'
  | 'patch'
  | 'delete';

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

@Injectable()
export class RelationshipsRepository implements OnModuleInit, OnModuleDestroy {
  private db!: DataSource;
  async onModuleInit() {
    this.db = new DataSource({
      ...postgresConnectionOptions([]),
      synchronize: false,
    });
    await this.db.initialize();
  }
  async onModuleDestroy() {
    if (this.db?.isInitialized) await this.db.destroy();
  }

  private id(value: unknown, label: string, uuid = false): string {
    // PostgreSQL accepts canonical UUIDs without RFC version/variant bits. Existing
    // master seeds (for example b1111111-0000-0000-0000-000000000003) use that format.
    const canonicalUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 100 ||
      (uuid && !canonicalUuid.test(value))
    ) {
      throw new BadRequestException(
        `${label} must be ${uuid ? 'a UUID' : 'a non-empty ID of at most 100 characters'}`,
      );
    }
    return value;
  }

  private fields(
    config: Relationship,
    body: unknown,
    operation: RelationshipOperation,
  ): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Provide a JSON object');
    const values = { ...body } as Record<string, unknown>;
    if (config.name === 'StoreTypeFeatures' && 'order' in values) {
      if ('displayOrder' in values && values.displayOrder !== values.order) {
        throw new BadRequestException(
          'Supply either order or displayOrder, not conflicting values',
        );
      }
      values.displayOrder = values.order;
      delete values.order;
    }
    const allowed = [
      ...Object.keys(config.fields),
      ...(operation === 'create' ? [config.childKey] : []),
    ];
    if (Object.keys(values).some((key) => !allowed.includes(key)))
      throw new BadRequestException('Unknown or immutable field');
    if (operation === 'patch' && !Object.keys(values).length)
      throw new BadRequestException('Provide at least one field to update');
    const result: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(config.fields)) {
      if (!(key in values)) {
        if (operation !== 'patch') result[key] = field.default;
        continue;
      }
      const value = values[key];
      if (value === null && field.nullable) {
        result[key] = null;
        continue;
      }
      let valid = false;
      switch (field.kind) {
        case 'boolean':
          valid = typeof value === 'boolean';
          break;
        case 'integer':
          valid =
            typeof value === 'number' &&
            Number.isInteger(value) &&
            value >= 0 &&
            value <= 2147483647;
          break;
        case 'string':
          valid = typeof value === 'string' && value.length <= 100;
          break;
        case 'object':
          valid =
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value);
          break;
        case 'date':
          valid =
            typeof value === 'string' &&
            isISO8601(value, { strict: true }) &&
            /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value);
          break;
        case 'status':
          valid =
            typeof value === 'string' &&
            ['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(value);
          break;
      }
      if (!valid) throw new BadRequestException(`Invalid ${key}`);
      result[key] = value;
    }
    return result;
  }

  private dates(values: Record<string, any>) {
    for (const [start, end, allowEqual] of [
      ['effectiveFrom', 'effectiveUntil', false],
      ['activatedAt', 'deactivatedAt', true],
    ] as const) {
      if (values[start] && values[end]) {
        const a = new Date(values[start]).getTime(),
          b = new Date(values[end]).getTime();
        if (b < a || (!allowEqual && b === a))
          throw new BadRequestException(`${end} must be after ${start}`);
      }
    }
  }

  private projection(config: Relationship) {
    return [
      'id',
      `${quoteIdent(config.parentColumn)} AS ${quoteIdent(config.parentParam)}`,
      `${quoteIdent(config.childColumn)} AS ${quoteIdent(config.childKey)}`,
      ...(config.tenantColumn
        ? [
            `${quoteIdent(config.tenantField || 'merchantId')} AS ${quoteIdent('merchantId')}`,
          ]
        : []),
      ...(config.name === 'EmployeeStoreRoles'
        ? [`${quoteIdent('store_id')} AS ${quoteIdent('storeId')}`]
        : []),
      ...(config.name === 'EmployeeStores'
        ? ['(login_pin_hash IS NOT NULL) AS "hasLoginPin"']
        : []),
      ...([
        'StoreTypeFeatures',
        'FeatureStoreTypes',
        'StoreTypeRoleTemplates',
        'RoleTemplateStoreTypes',
      ].includes(config.name)
        ? [
            `${quoteIdent('is_deleted')} AS ${quoteIdent('isDeleted')}`,
            `${quoteIdent('created_by')} AS ${quoteIdent('createdBy')}`,
            `${quoteIdent('updated_by')} AS ${quoteIdent('updatedBy')}`,
          ]
        : []),
      ...Object.entries(config.fields).map(
        ([key, field]) => `${quoteIdent(field.column)} AS ${quoteIdent(key)}`,
      ),
      `${quoteIdent(config.createdColumn || 'createdAt')} AS ${quoteIdent('createdAt')}`,
      ...(config.timestamps
        ? [
            `${quoteIdent(config.updatedColumn || 'updatedAt')} AS ${quoteIdent('updatedAt')}`,
          ]
        : []),
    ].join(', ');
  }

  private hashStoreLoginPin(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{6}$/.test(value)) {
      throw new BadRequestException('loginPin must be a 6-digit PIN');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    return `${salt}:${crypto.scryptSync(value, salt, 32).toString('hex')}`;
  }

  private takeStoreLoginPin(
    body: unknown,
    required: boolean,
  ): { body: unknown; loginPinHash?: string; loginPin?: string } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      if (required)
        throw new BadRequestException(
          'loginPin is required for a store employee assignment',
        );
      return { body };
    }
    const payload = { ...(body as Record<string, unknown>) };
    if (!('loginPin' in payload)) {
      if (required)
        throw new BadRequestException(
          'loginPin is required for a store employee assignment',
        );
      return { body: payload };
    }
    const loginPin = payload.loginPin as string;
    const loginPinHash = this.hashStoreLoginPin(loginPin);
    delete payload.loginPin;
    return { body: payload, loginPinHash, loginPin };
  }

  async execute(
    config: Relationship,
    operation: RelationshipOperation,
    params: Record<string, string>,
    child?: string,
    body?: unknown,
    auditUserId?: string,
  ) {
    const parent = this.id(
      params[config.parentParam],
      config.parentParam,
      config.parentUuid,
    );
    const merchant = config.ownerColumn
      ? await this.resolveRelationshipMerchant(
          config,
          parent,
          params.merchantId,
        )
      : undefined;
    let fields: Record<string, unknown> = {};
    if (
      config.name === 'EmployeeStores' &&
      ['create', 'replace', 'patch'].includes(operation)
    ) {
      const extracted = this.takeStoreLoginPin(body, false);
      body = extracted.body;
      if (extracted.loginPinHash)
        fields.__loginPinHash = extracted.loginPinHash;
      if (extracted.loginPin !== undefined)
        fields.__loginPin = extracted.loginPin;
    }
    const hasRemainingPatchFields =
      body && typeof body === 'object' && !Array.isArray(body)
        ? Object.keys(body as Record<string, unknown>).length > 0
        : false;
    if (
      ['create', 'replace', 'patch'].includes(operation) &&
      (operation !== 'patch' ||
        hasRemainingPatchFields ||
        !fields.__loginPinHash)
    )
      fields = { ...fields, ...this.fields(config, body, operation) };
    if (config.name === 'RolePermissions' && fields.storeId) {
      fields.storeId = this.id(String(fields.storeId), 'storeId');
    } else if (config.name === 'RolePermissions') {
      delete fields.storeId;
    }
    if (operation === 'create')
      child = this.id(
        (body as Record<string, unknown>)[config.childKey],
        config.childKey,
        config.childUuid,
      );
    else if (operation !== 'list')
      child = this.id(child, config.childKey, config.childUuid);
    if (config.name === 'EmployeeStores' && child)
      child = await this.resolveStoreUuid(child, merchant!);
    try {
      return await this.db.transaction(async (manager) =>
        this.perform(
          manager,
          config,
          operation,
          parent,
          merchant,
          child,
          fields,
          auditUserId,
        ),
      );
    } catch (error: any) {
      this.rethrow(error);
    }
  }

  async createBulk(
    config: Relationship,
    params: Record<string, string>,
    body: unknown,
    auditUserId?: string,
  ) {
    if (config.name === 'RoleTemplatePermissions')
      return this.syncRoleTemplatePermissions(config, params, body);
    if (config.name === 'RoleTemplateStoreTypes')
      return this.saveRoleTemplateStoreTypes(config, params, body, auditUserId);
    const parent = this.id(
      params[config.parentParam],
      config.parentParam,
      config.parentUuid,
    );
    const merchant = config.ownerColumn
      ? await this.resolveRelationshipMerchant(
          config,
          parent,
          params.merchantId,
        )
      : undefined;
    const { items, skipExisting } = this.bulkItems(config, body);
    if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
      throw new BadRequestException(
        'items must contain between 1 and 100 mappings',
      );
    }
    const seen = new Set<string>();
    const prepared = items.map((item) => {
      let payload: unknown = item;
      const fields: Record<string, unknown> = {};
      if (config.name === 'EmployeeStores') {
        const extracted = this.takeStoreLoginPin(item, false);
        payload = extracted.body;
        if (extracted.loginPinHash)
          fields.__loginPinHash = extracted.loginPinHash;
        if (extracted.loginPin !== undefined)
          fields.__loginPin = extracted.loginPin;
      }
      Object.assign(fields, this.fields(config, payload, 'create'));
      if (config.name === 'RolePermissions' && fields.storeId)
        fields.storeId = this.id(String(fields.storeId), 'storeId');
      else if (config.name === 'RolePermissions') delete fields.storeId;
      const child = this.id(
        item[config.childKey],
        config.childKey,
        config.childUuid,
      );
      const normalized = config.childUuid ? child.toLowerCase() : child;
      if (seen.has(normalized))
        throw new BadRequestException(`Duplicate ${config.childKey} in items`);
      seen.add(normalized);
      return { child, fields };
    });
    try {
      return await this.db.transaction(async (manager) => {
        const projection = this.projection(config);
        const supportsReactivation = [
          'StoreTypeFeatures',
          'FeatureStoreTypes',
          'StoreTypeRoleTemplates',
          'RoleTemplateStoreTypes',
        ].includes(config.name);
        const resolved = [];
        for (const item of prepared) {
          if (config.name === 'EmployeeStores')
            item.child = await this.resolveStoreUuid(item.child, merchant!);
          if (skipExisting) {
            const existing = await manager.query(
              `SELECT ${projection} FROM public.${config.table} WHERE ${quoteIdent(config.parentColumn)} = $1 AND ${quoteIdent(config.childColumn)} = $2`,
              [parent, item.child],
            );
            if (
              existing.length &&
              !(supportsReactivation && existing[0].isDeleted)
            ) {
              resolved.push(existing[0]);
              continue;
            }
          }
          const result = await this.perform(
            manager,
            config,
            'create',
            parent,
            merchant,
            item.child,
            item.fields,
            auditUserId,
          );
          resolved.push(result.item);
        }
        return {
          success: true,
          count: resolved.length,
          items: await this.withChildDetails(manager, config, resolved),
        };
      });
    } catch (error: any) {
      this.rethrow(error);
    }
  }

  async replaceBulk(
    config: Relationship,
    params: Record<string, string>,
    body: unknown,
  ) {
    if (config.name === 'RoleTemplatePermissions')
      return this.syncRoleTemplatePermissions(config, params, body);
    if (config.name === 'RoleTemplateStoreTypes')
      return this.saveRoleTemplateStoreTypes(config, params, body);
    const parent = this.id(
      params[config.parentParam],
      config.parentParam,
      config.parentUuid,
    );
    const merchant = config.ownerColumn
      ? await this.resolveMerchantCode(params.merchantId)
      : undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Provide a JSON object');
    const payload = body as Record<string, unknown>;
    const idAlias = `${config.childKey}s`;
    const ids = payload[idAlias] ?? payload.ids;
    if (!Array.isArray(ids) || ids.length > 100)
      throw new BadRequestException(
        `${idAlias} must contain at most 100 mappings`,
      );
    const allowed = new Set([idAlias, 'ids', 'defaultAllowed']);
    if (Object.keys(payload).some((key) => !allowed.has(key)))
      throw new BadRequestException(`Provide { ${idAlias}: [...] }`);
    const defaults = this.bulkDefaults(config, payload);
    const seen = new Set<string>();
    const children = ids.map((id) => {
      const child = this.id(id, config.childKey, config.childUuid);
      const normalized = config.childUuid ? child.toLowerCase() : child;
      if (seen.has(normalized))
        throw new BadRequestException(
          `Duplicate ${config.childKey} in ${idAlias}`,
        );
      seen.add(normalized);
      return child;
    });
    try {
      return await this.db.transaction(async (manager) => {
        const existing = await manager.query(
          `SELECT ${quoteIdent(config.childColumn)} AS id FROM public.${config.table} WHERE ${quoteIdent(config.parentColumn)} = $1`,
          [parent],
        );
        for (const row of existing) {
          const current = String(row.id);
          if (!seen.has(config.childUuid ? current.toLowerCase() : current)) {
            await this.perform(
              manager,
              config,
              'delete',
              parent,
              merchant,
              current,
              {},
            );
          }
        }
        const items = [];
        for (const child of children) {
          const current = await manager.query(
            `SELECT 1 FROM public.${config.table} WHERE ${quoteIdent(config.parentColumn)} = $1 AND ${quoteIdent(config.childColumn)} = $2`,
            [parent, child],
          );
          const result = await this.perform(
            manager,
            config,
            current.length ? 'replace' : 'create',
            parent,
            merchant,
            child,
            defaults,
          );
          items.push(result.item);
        }
        return { success: true, count: items.length, items };
      });
    } catch (error: any) {
      this.rethrow(error);
    }
  }

  async syncRoleTemplatePermissions(
    config: Relationship,
    params: Record<string, string>,
    body: unknown,
  ) {
    const parent = this.id(
      params[config.parentParam],
      config.parentParam,
      config.parentUuid,
    );
    const parsed = this.roleTemplatePermissionSelections(config, body);
    try {
      return await this.db.transaction(async (manager) => {
        const owners = await manager.query(
          'SELECT id FROM public.role_templates WHERE id = $1 FOR SHARE',
          [parent],
        );
        if (!owners.length)
          throw new NotFoundException(
            'Parent not found in the requested scope',
          );
        if (parsed.remove) {
          if (parsed.removeFeatureIds.length) {
            await manager.query(
              `DELETE FROM public.role_template_permissions rtp
               USING public.permissions p
               WHERE rtp.${quoteIdent(config.parentColumn)} = $1
                 AND rtp.${quoteIdent(config.childColumn)} = p.id
                 AND p.feature_id = ANY($2::uuid[])`,
              [parent, parsed.removeFeatureIds],
            );
          }
          const remaining = await manager.query(
            `SELECT ${this.projection(config)} FROM public.${config.table}
             WHERE ${quoteIdent(config.parentColumn)} = $1
             ORDER BY ${quoteIdent(config.createdColumn || 'createdAt')}, id`,
            [parent],
          );
          return {
            success: true,
            count: remaining.length,
            items: await this.withChildDetails(manager, config, remaining),
          };
        }

        // The feature catalog is stored in feature_permissions, while the
        // employee/role permission tables still reference public.permissions.
        // Frontend selections use the feature_permissions UUIDs, so mirror
        // those catalog rows into the legacy table before applying grants.
        const featurePermissionIds = parsed.selected.map((item) => item.child);
        const featurePermissions = await manager.query(
          `SELECT id, feature_id AS "featureId", permission_code AS "permissionCode",
                  name, description, status
           FROM public.feature_permissions
           WHERE feature_id = ANY($1::uuid[]) OR id = ANY($2::uuid[])`,
          [parsed.featureIds, featurePermissionIds],
        );
        const permissionIdMap = new Map<string, string>();
        for (const permission of featurePermissions as {
          id: string;
          featureId: string;
          permissionCode: string;
          name: string;
          description: string;
          status: string;
        }[]) {
          const matching = await manager.query(
            `SELECT id FROM public.permissions
             WHERE id = $1 OR (feature_id = $2 AND
               (permission_key = $3 OR lower(btrim(name)) = lower(btrim($4))))
             ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END
             LIMIT 1`,
            [permission.id, permission.featureId, permission.permissionCode, permission.name],
          );
          let legacyPermissionId = matching[0]?.id as string | undefined;
          if (!legacyPermissionId) {
            const inserted = await manager.query(
              `INSERT INTO public.permissions
                 (id, feature_id, permission_key, name, description, status)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT DO NOTHING
               RETURNING id`,
              [permission.id, permission.featureId, permission.permissionCode,
                permission.name, permission.description ?? '', permission.status ?? 'ACTIVE'],
            );
            legacyPermissionId = inserted[0]?.id as string | undefined;
          }
          if (!legacyPermissionId) {
            const conflict = await manager.query(
              `SELECT id FROM public.permissions
               WHERE feature_id = $1 AND
                 (permission_key = $2 OR lower(btrim(name)) = lower(btrim($3)))
               ORDER BY CASE WHEN permission_key = $2 THEN 0 ELSE 1 END
               LIMIT 1`,
              [permission.featureId, permission.permissionCode, permission.name],
            );
            legacyPermissionId = conflict[0]?.id as string | undefined;
          }
          if (legacyPermissionId) {
            permissionIdMap.set(String(permission.id).toLowerCase(), legacyPermissionId);
          }
        }

        const catalog = await manager.query(
          `SELECT DISTINCT p.id
           FROM public.store_type_role_templates mapping
           JOIN public.store_type_features stf ON stf.store_type_id = mapping.store_type_id
           JOIN public.permissions p ON p.feature_id = stf.feature_id
           WHERE mapping.role_template_id = $1
             AND mapping.is_deleted = false`,
          [parent],
        );
        const allowed = new Map<string, boolean>();
        for (const row of catalog)
          allowed.set(String(row.id).toLowerCase(), false);
        if (parsed.featureIds.length) {
          const featurePermissions = await manager.query(
            'SELECT id FROM public.permissions WHERE feature_id = ANY($1::uuid[])',
            [parsed.featureIds],
          );
          for (const row of featurePermissions)
            allowed.set(String(row.id).toLowerCase(), false);
        }
        for (const item of parsed.selected) {
          const permissionId = permissionIdMap.get(item.child.toLowerCase()) || item.child;
          allowed.set(permissionId.toLowerCase(), item.defaultAllowed);
        }
        await manager.query(
          `DELETE FROM public.role_template_permissions WHERE ${quoteIdent(config.parentColumn)} = $1`,
          [parent],
        );
        if (!allowed.size) return { success: true, count: 0, items: [] };
        const items: Record<string, unknown>[] = [];
        for (const [permissionId, defaultAllowed] of allowed) {
          const child =
            parsed.selected.find(
              (item) => item.child.toLowerCase() === permissionId,
            )?.child || permissionId;
          const result = await this.perform(
            manager,
            config,
            'create',
            parent,
            undefined,
            child,
            { defaultAllowed },
          );
          items.push(result.item);
        }
        return {
          success: true,
          count: items.length,
          items: await this.withChildDetails(manager, config, items),
        };
      });
    } catch (error: any) {
      this.rethrow(error);
    }
  }

  async saveRoleTemplateStoreTypes(
    config: Relationship,
    params: Record<string, string>,
    body: unknown,
    auditUserId?: string,
  ) {
    const parent = this.id(
      params[config.parentParam],
      config.parentParam,
      config.parentUuid,
    );
    const { selected, replace } = this.roleTemplateStoreTypeSelections(
      config,
      body,
    );
    try {
      return await this.db.transaction(async (manager) => {
        const owners = await manager.query(
          'SELECT id FROM public.role_templates WHERE id = $1 FOR SHARE',
          [parent],
        );
        if (!owners.length)
          throw new NotFoundException(
            'Parent not found in the requested scope',
          );
        const existing = await manager.query(
          `SELECT ${quoteIdent(config.childColumn)} AS id FROM public.${config.table}
           WHERE ${quoteIdent(config.parentColumn)} = $1 AND is_deleted = false`,
          [parent],
        );
        const selectedIds = new Set(
          selected.map((item) => item.child.toLowerCase()),
        );
        if (replace) {
          for (const row of existing) {
            const current = String(row.id);
            if (!selectedIds.has(current.toLowerCase())) {
              await this.perform(
                manager,
                config,
                'delete',
                parent,
                undefined,
                current,
                {},
                auditUserId,
              );
            }
          }
        }
        for (const item of selected) {
          const current = await manager.query(
            `SELECT 1 FROM public.${config.table}
             WHERE ${quoteIdent(config.parentColumn)} = $1
               AND ${quoteIdent(config.childColumn)} = $2
               AND is_deleted = false`,
            [parent, item.child],
          );
          await this.perform(
            manager,
            config,
            current.length ? 'replace' : 'create',
            parent,
            undefined,
            item.child,
            item.fields,
            auditUserId,
          );
        }
        if (replace) {
          await manager.query(
            `DELETE FROM public.role_template_permissions rtp
             WHERE rtp.role_template_id = $1
               AND NOT EXISTS (
                 SELECT 1
                 FROM public.store_type_role_templates mapping
                 JOIN public.store_type_features stf ON stf.store_type_id = mapping.store_type_id
                 JOIN public.permissions p ON p.feature_id = stf.feature_id
                 WHERE mapping.role_template_id = rtp.role_template_id
                   AND mapping.is_deleted = false
                   AND p.id = rtp.permission_id
               )`,
            [parent],
          );
        }
        const items = await manager.query(
          `SELECT ${this.projection(config)} FROM public.${config.table}
           WHERE ${quoteIdent(config.parentColumn)} = $1 AND is_deleted = false
           ORDER BY ${quoteIdent(config.createdColumn || 'createdAt')}, id`,
          [parent],
        );
        return {
          success: true,
          count: items.length,
          items: await this.withChildDetails(manager, config, items),
        };
      });
    } catch (error: any) {
      this.rethrow(error);
    }
  }

  private roleTemplateStoreTypeSelections(
    config: Relationship,
    body: unknown,
  ): {
    selected: { child: string; fields: Record<string, unknown> }[];
    replace: boolean;
  } {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Provide a JSON object');
    const payload = body as Record<string, unknown>;
    const idAlias = `${config.childKey}s`;
    const hasItems = 'items' in payload;
    const hasIds = idAlias in payload || 'ids' in payload;
    if (payload.replace !== undefined && typeof payload.replace !== 'boolean') {
      throw new BadRequestException('Invalid replace');
    }
    const replace = payload.replace === true;
    if (hasItems && hasIds)
      throw new BadRequestException(
        `Supply either items or ${idAlias}, not both`,
      );
    if (!hasItems && !hasIds)
      throw new BadRequestException(`Provide { ${idAlias}: [...] }`);
    if (hasIds) {
      const allowed = new Set([
        idAlias,
        'ids',
        'skipExisting',
        'status',
        'replace',
      ]);
      if (Object.keys(payload).some((key) => !allowed.has(key)))
        throw new BadRequestException(`Provide { ${idAlias}: [...] }`);
      const ids = payload[idAlias] ?? payload.ids;
      if (!Array.isArray(ids) || ids.length > 100)
        throw new BadRequestException(
          `${idAlias} must contain at most 100 mappings`,
        );
      const fields = this.fields(
        config,
        {
          status: payload.status ?? 'ACTIVE',
        },
        'create',
      );
      const seen = new Set<string>();
      return {
        replace,
        selected: ids.map((id) => {
          const child = this.id(id, config.childKey, config.childUuid);
          const normalized = child.toLowerCase();
          if (seen.has(normalized))
            throw new BadRequestException(
              `Duplicate ${config.childKey} in ${idAlias}`,
            );
          seen.add(normalized);
          return { child, fields };
        }),
      };
    }
    if (
      Object.keys(payload).some((key) => key !== 'items' && key !== 'replace')
    ) {
      throw new BadRequestException('Provide { items: [...] }');
    }
    const items = payload.items;
    if (!Array.isArray(items) || items.length > 100)
      throw new BadRequestException('items must contain at most 100 mappings');
    const seen = new Set<string>();
    return {
      replace,
      selected: items.map((item) => {
        const fields = this.fields(config, item, 'create');
        const child = this.id(
          (item as Record<string, unknown>)[config.childKey],
          config.childKey,
          config.childUuid,
        );
        const normalized = child.toLowerCase();
        if (seen.has(normalized))
          throw new BadRequestException(
            `Duplicate ${config.childKey} in items`,
          );
        seen.add(normalized);
        return { child, fields };
      }),
    };
  }

  private roleTemplatePermissionSelections(
    config: Relationship,
    body: unknown,
  ): {
    selected: { child: string; defaultAllowed: boolean }[];
    featureIds: string[];
    removeFeatureIds: string[];
    remove: boolean;
  } {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Provide a JSON object');
    const payload = body as Record<string, unknown>;
    const idAlias = `${config.childKey}s`;
    const allowed = new Set([
      'items',
      idAlias,
      'ids',
      'defaultAllowed',
      'skipExisting',
      'featureIds',
      'removeFeatureIds',
    ]);
    if (Object.keys(payload).some((key) => !allowed.has(key))) {
      throw new BadRequestException(
        'Provide { items: [...] }, { permissionIds, featureIds }, or { removeFeatureIds }',
      );
    }
    const hasItems = 'items' in payload;
    const hasIds = idAlias in payload || 'ids' in payload;
    const hasFeatures = 'featureIds' in payload;
    const hasRemove = 'removeFeatureIds' in payload;
    if (hasRemove && (hasItems || hasIds || hasFeatures)) {
      throw new BadRequestException('Supply removeFeatureIds by itself');
    }
    if (hasItems && (hasIds || hasFeatures)) {
      throw new BadRequestException(
        `Supply either items or ${idAlias}/featureIds, not both`,
      );
    }
    if (!hasItems && !hasIds && !hasFeatures && !hasRemove) {
      throw new BadRequestException(
        'Provide { items: [...] }, { permissionIds, featureIds }, or { removeFeatureIds }',
      );
    }
    if (hasRemove) {
      return {
        selected: [],
        featureIds: [],
        removeFeatureIds: this.uuidArray(payload.removeFeatureIds, 'featureId'),
        remove: true,
      };
    }
    if (hasItems) {
      const items = payload.items;
      if (!Array.isArray(items) || items.length > 100)
        throw new BadRequestException(
          'items must contain at most 100 mappings',
        );
      const seen = new Set<string>();
      const selected = items.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
          throw new BadRequestException('Each item must be an object');
        const row = item as Record<string, unknown>;
        const child = this.id(
          row[config.childKey],
          config.childKey,
          config.childUuid,
        );
        const normalized = child.toLowerCase();
        if (seen.has(normalized))
          throw new BadRequestException(
            `Duplicate ${config.childKey} in items`,
          );
        seen.add(normalized);
        if (
          row.defaultAllowed !== undefined &&
          typeof row.defaultAllowed !== 'boolean'
        ) {
          throw new BadRequestException('Invalid defaultAllowed');
        }
        return { child, defaultAllowed: row.defaultAllowed !== false };
      });
      return { selected, featureIds: [], removeFeatureIds: [], remove: false };
    }
    const defaultAllowed = payload.defaultAllowed !== false;
    return {
      selected: hasIds
        ? this.uuidArray(payload[idAlias] ?? payload.ids, config.childKey).map(
            (child) => ({ child, defaultAllowed }),
          )
        : [],
      featureIds: hasFeatures
        ? this.uuidArray(payload.featureIds, 'featureId')
        : [],
      removeFeatureIds: [],
      remove: false,
    };
  }

  private uuidArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length > 100)
      throw new BadRequestException(
        `${label}s must contain at most 100 mappings`,
      );
    const seen = new Set<string>();
    return value.map((id) => {
      const child = this.id(id, label, true);
      const normalized = child.toLowerCase();
      if (seen.has(normalized))
        throw new BadRequestException(`Duplicate ${label} in ${label}s`);
      seen.add(normalized);
      return child;
    });
  }
  async listRoleTemplateAccess(
    roleTemplateId: string,
    query: Record<string, string | string[] | undefined> = {},
  ) {
    const parent = this.id(roleTemplateId, 'roleTemplateId', true);

    try {
      return await this.db.transaction(async (manager) => {
        const owners = await manager.query(
          'SELECT id FROM public.role_templates WHERE id = $1',
          [parent],
        );

        if (!owners.length) {
          throw new NotFoundException(
            'Parent not found in the requested scope',
          );
        }

        const assigned = await manager.query(
          `SELECT ${quoteIdent('store_type_id')} AS ${quoteIdent('storeTypeId')}
         FROM public.store_type_role_templates
         WHERE ${quoteIdent('role_template_id')} = $1`,
          [parent],
        );

        const assignedIds = assigned.map((row: { storeTypeId: string }) =>
          String(row.storeTypeId).toLowerCase(),
        );

        const requested = this.requestedStoreTypeIds(query);
        const storeTypeIds = requested || assignedIds;

        const featureRows = storeTypeIds.length
          ? await manager.query(
              `SELECT
               f.id,
               f.name,
               f.description,
               f.status,
               COALESCE(to_jsonb(f)->>'feature_key', to_jsonb(f)->>'feature_code') AS "featureKey",
               to_jsonb(f)->>'feature_type' AS "featureType",
               ARRAY_AGG(DISTINCT stf.store_type_id) AS "storeTypeIds"
             FROM public.store_type_features stf
             JOIN public.features f ON f.id = stf.feature_id
             WHERE stf.store_type_id = ANY($1::uuid[])
             GROUP BY
               f.id,
               f.name,
               f.description,
               f.status
             ORDER BY f.name, f.id`,
              [storeTypeIds],
            )
          : [];

        const featureIds = featureRows.map((row: { id: string }) => row.id);

        const permissions = featureIds.length
          ? await manager.query(
              `SELECT
               p.id,
               p.name,
               p.description,
               p.status,
               COALESCE(
                 to_jsonb(p)->>'permissionKey',
                 to_jsonb(p)->>'permission_key'
               ) AS "permissionKey",
               COALESCE(
                 to_jsonb(p)->>'featureId',
                 to_jsonb(p)->>'feature_id'
               ) AS "featureId"
             FROM public.permissions p
             WHERE p.feature_id = ANY($1::uuid[])
             ORDER BY p.name, p.id`,
              [featureIds],
            )
          : [];

        const grants = await manager.query(
          `SELECT
           id,
           permission_id AS "permissionId",
           default_allowed AS "defaultAllowed"
         FROM public.role_template_permissions
         WHERE role_template_id = $1`,
          [parent],
        );

        /**
         * Create a lookup map so we don't repeatedly call grants.find().
         */
        const grantByPermission = new Map<
          string,
          {
            permissionId: string;
            id: string;
            defaultAllowed: boolean;
          }
        >(
          grants.map(
            (row: {
              permissionId: string;
              id: string;
              defaultAllowed: boolean;
            }) => [String(row.permissionId).toLowerCase(), row],
          ),
        );

        const search = Array.isArray(query.search)
          ? query.search[0]?.trim().toLowerCase()
          : query.search?.trim().toLowerCase();

        const status = Array.isArray(query.status)
          ? query.status[0]?.trim().toUpperCase()
          : query.status?.trim().toUpperCase();

        const features = featureRows
          .map((feature: Record<string, any>) => {
            const nested = permissions
              .filter(
                (permission: Record<string, any>) =>
                  String(permission.featureId).toLowerCase() ===
                  String(feature.id).toLowerCase(),
              )
              .filter(
                (permission: Record<string, any>) =>
                  !status ||
                  status === 'ALL STATUSES' ||
                  String(permission.status).toUpperCase() === status,
              )
              .map((permission: Record<string, any>) => {
                const grant = grantByPermission.get(
                  String(permission.id).toLowerCase(),
                );

                return {
                  ...permission,
                  mapped: Boolean(grant),
                  checked: grant?.defaultAllowed === true,
                  mappingId: grant?.id ?? null,
                  defaultAllowed: grant?.defaultAllowed ?? false,
                };
              })
              .filter(
                (permission: Record<string, any>) =>
                  !search ||
                  [
                    permission.name,
                    permission.permissionKey,
                    permission.description,
                  ].some((value) =>
                    String(value ?? '')
                      .toLowerCase()
                      .includes(search),
                  ),
              );

            const selectedCount = nested.filter(
              (permission: Record<string, any>) => permission.checked,
            ).length;
            const mapped = nested.some(
              (permission: Record<string, any>) => permission.mapped,
            );

            return {
              ...feature,
              mapped,
              checked: mapped,
              enabled: mapped,
              permissionCount: nested.length,
              selectedCount,
              permissions: nested,
            };
          })
          .filter((feature: Record<string, any>) => {
            if (
              search &&
              !feature.permissions.length &&
              ![feature.name, feature.featureKey, feature.description].some(
                (value) =>
                  String(value ?? '')
                    .toLowerCase()
                    .includes(search),
              )
            ) {
              return false;
            }

            if (!status || status === 'ALL STATUSES') {
              return true;
            }

            return (
              String(feature.status).toUpperCase() === status ||
              feature.permissions.length > 0
            );
          });

        const mappedOnly =
          (Array.isArray(query.mappedOnly)
            ? query.mappedOnly[0]
            : query.mappedOnly
          )
            ?.trim()
            .toLowerCase() === 'true';

        const visible = mappedOnly
          ? features.filter((feature: Record<string, any>) => feature.mapped)
          : features;

        const selectedCount = visible.reduce(
          (total: number, feature: Record<string, any>) =>
            total + feature.selectedCount,
          0,
        );

        return {
          success: true,
          count: visible.length,
          selectedCount,
          storeTypeIds,
          features: visible,
        };
      });
    } catch (error: any) {
      this.rethrow(error);
    }
  }
  private requestedStoreTypeIds(
    query: Record<string, string | string[] | undefined>,
  ): string[] | null {
    const values = [query.storeTypeIds, query.storeTypeId].flatMap((value) => {
      if (Array.isArray(value)) return value;
      return value ? [value] : [];
    });
    const ids = values
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim())
      .filter(Boolean);
    if (!ids.length) return null;
    return [
      ...new Set(
        ids.map((value) => this.id(value, 'storeTypeId', true).toLowerCase()),
      ),
    ];
  }

  private bulkDefaults(
    config: Relationship,
    payload: Record<string, unknown> = {},
  ) {
    if (config.name === 'PlanEntitlements') return { enabled: true };
    if (config.name === 'RoleTemplatePermissions')
      return { defaultAllowed: payload.defaultAllowed !== false };
    if (['StoreTypeFeatures', 'FeatureStoreTypes'].includes(config.name)) {
      return { required: false, status: 'ACTIVE' };
    }
    if (
      ['StoreTypeRoleTemplates', 'RoleTemplateStoreTypes'].includes(config.name)
    ) {
      return { status: 'ACTIVE' };
    }
    return {};
  }

  private bulkItems(
    config: Relationship,
    body: unknown,
  ): { items: Record<string, unknown>[]; skipExisting: boolean } {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Provide { items: [...] }');
    const payload = body as Record<string, unknown>;
    const idAlias = `${config.childKey}s`;
    const hasItems = 'items' in payload;
    const hasIds = idAlias in payload || 'ids' in payload;
    if (hasItems && hasIds)
      throw new BadRequestException(
        `Supply either items or ${idAlias}, not both`,
      );
    if (hasIds) {
      const allowed = new Set([
        idAlias,
        'ids',
        'skipExisting',
        ...(config.name === 'RoleTemplatePermissions'
          ? ['defaultAllowed']
          : []),
      ]);
      if (Object.keys(payload).some((key) => !allowed.has(key))) {
        throw new BadRequestException(`Provide { ${idAlias}: [...] }`);
      }
      const ids = payload[idAlias] ?? payload.ids;
      if (!Array.isArray(ids))
        throw new BadRequestException(`${idAlias} must be an array`);
      const defaults = this.bulkDefaults(config, payload);
      return {
        skipExisting: payload.skipExisting !== false,
        items: ids.map((id) =>
          typeof id === 'string' ? { [config.childKey]: id, ...defaults } : id,
        ),
      };
    }
    if (
      Object.keys(payload).some(
        (key) => !['items', 'skipExisting'].includes(key),
      )
    ) {
      throw new BadRequestException(
        'Provide { items: [...], skipExisting?: boolean }',
      );
    }
    if (
      payload.skipExisting !== undefined &&
      typeof payload.skipExisting !== 'boolean'
    ) {
      throw new BadRequestException('skipExisting must be a boolean');
    }
    return {
      items: payload.items as Record<string, unknown>[],
      skipExisting: payload.skipExisting === true,
    };
  }

  private async withChildDetails(
    manager: EntityManager,
    config: Relationship,
    items: Record<string, any>[],
  ) {
    if (!items.length) return items;
    if (config.name === 'StoreTypeFeatures') {
      const rows = await manager.query(
        `SELECT id, name, status,
           COALESCE(to_jsonb(f)->>'feature_key', to_jsonb(f)->>'feature_code') AS "featureKey",
           NULL::text AS category
         FROM public.features f WHERE id = ANY($1::uuid[])`,
        [items.map((item) => item.featureId)],
      );
      const byId = new Map(
        rows.map((row: Record<string, any>) => [
          String(row.id).toLowerCase(),
          row,
        ]),
      );
      return items.map((item) => {
        const feature: Record<string, any> =
          byId.get(String(item.featureId).toLowerCase()) || {};
        return {
          ...item,
          name: feature.name,
          featureKey: feature.featureKey,
          category: feature.category,
          featureStatus: feature.status,
        };
      });
    }
    if (config.name === 'FeatureStoreTypes') {
      const rows = await manager.query(
        `SELECT id, name, description, status,
           COALESCE(to_jsonb(s)->>'storeTypeCode', to_jsonb(s)->>'store_type_code') AS "storeTypeCode"
         FROM public.store_types s WHERE id = ANY($1::uuid[])`,
        [items.map((item) => item.storeTypeId)],
      );
      const byId = new Map(
        rows.map((row: Record<string, any>) => [
          String(row.id).toLowerCase(),
          row,
        ]),
      );
      return items.map((item) => {
        const storeType: Record<string, any> =
          byId.get(String(item.storeTypeId).toLowerCase()) || {};
        return {
          ...item,
          name: storeType.name,
          description: storeType.description,
          storeTypeCode: storeType.storeTypeCode,
          storeTypeStatus: storeType.status,
        };
      });
    }
    if (config.name === 'StoreTypeRoleTemplates') {
      const rows = await manager.query(
        `SELECT id, name, status,
           COALESCE(to_jsonb(t)->>'roleCode', to_jsonb(t)->>'role_code') AS "roleCode",
           COALESCE(to_jsonb(t)->>'scopeType', to_jsonb(t)->>'scope_type') AS "scopeType"
         FROM public.role_templates t WHERE id = ANY($1::uuid[])`,
        [items.map((item) => item.roleTemplateId)],
      );
      const byId = new Map(
        rows.map((row: Record<string, any>) => [
          String(row.id).toLowerCase(),
          row,
        ]),
      );
      return items.map((item) => {
        const template: Record<string, any> =
          byId.get(String(item.roleTemplateId).toLowerCase()) || {};
        return {
          ...item,
          name: template.name,
          roleCode: template.roleCode,
          scopeType: template.scopeType,
          templateStatus: template.status,
        };
      });
    }
    if (config.name === 'RoleTemplateStoreTypes') {
      const rows = await manager.query(
        `SELECT id, name, description, status,
           COALESCE(to_jsonb(s)->>'storeTypeCode', to_jsonb(s)->>'store_type_code') AS "storeTypeCode"
         FROM public.store_types s WHERE id = ANY($1::uuid[])`,
        [items.map((item) => item.storeTypeId)],
      );
      const byId = new Map(
        rows.map((row: Record<string, any>) => [
          String(row.id).toLowerCase(),
          row,
        ]),
      );
      return items.map((item) => {
        const storeType: Record<string, any> =
          byId.get(String(item.storeTypeId).toLowerCase()) || {};
        return {
          ...item,
          name: storeType.name,
          description: storeType.description,
          storeTypeCode: storeType.storeTypeCode,
          storeTypeStatus: storeType.status,
        };
      });
    }
    if (config.name === 'RoleTemplatePermissions') {
      const rows = await manager.query(
        `SELECT id, name, description, status,
           COALESCE(to_jsonb(p)->>'permissionKey', to_jsonb(p)->>'permission_key') AS "permissionKey",
           COALESCE(to_jsonb(p)->>'featureId', to_jsonb(p)->>'feature_id') AS "featureId"
         FROM public.permissions p WHERE id = ANY($1::uuid[])`,
        [items.map((item) => item.permissionId)],
      );
      const byId = new Map(
        rows.map((row: Record<string, any>) => [
          String(row.id).toLowerCase(),
          row,
        ]),
      );
      return items.map((item) => {
        const permission: Record<string, any> =
          byId.get(String(item.permissionId).toLowerCase()) || {};
        return {
          ...item,
          name: permission.name,
          description: permission.description,
          permissionKey: permission.permissionKey,
          featureId: permission.featureId,
          permissionStatus: permission.status,
        };
      });
    }
    return items;
  }

  private rethrow(error: any): never {
    const code = error.driverError?.code || error.code;
    if (
      (error.driverError?.constraint || error.constraint) ===
      'pch_employee_one_primary_store'
    ) {
      throw new ConflictException(
        'Employee already has a primary store. Clear isPrimary on the old assignment first.',
      );
    }
    if (code === '23505')
      throw new ConflictException('This relationship already exists');
    if (code === '23503')
      throw new ConflictException(
        'Invalid parent relationship or record is in use',
      );
    if (['23514', '22007', '22008', '22001', '22P02'].includes(code))
      throw new BadRequestException('Invalid relationship values');
    if (['42P01', '42703'].includes(code))
      throw new ServiceUnavailableException(
        'Relationship schema is not installed; apply migration 03',
      );
    throw error;
  }

  private async perform(
    manager: EntityManager,
    config: Relationship,
    operation: RelationshipOperation,
    parent: string,
    merchant: string | undefined,
    child: string | undefined,
    fields: Record<string, unknown>,
    auditUserId?: string,
  ) {
    const merchantUuid =
      merchant && ['EmployeeStores', 'EmployeeStoreRoles'].includes(config.name)
        ? await this.resolveMerchantUuid(merchant)
        : undefined;
    const parentOwner = ['EmployeeStores', 'EmployeeStoreRoles'].includes(
      config.name,
    )
      ? merchantUuid
      : merchant;
    const owners = await manager.query(
      `SELECT id FROM public.${config.parentTable} WHERE id = $1${config.ownerColumn ? ` AND ${quoteIdent(config.ownerColumn)} = $2` : ''} FOR SHARE`,
      config.ownerColumn ? [parent, parentOwner] : [parent],
    );
    if (!owners.length)
      throw new NotFoundException('Parent not found in the requested scope');
    const projection = this.projection(config);
    const softDeleteStoreTypeMapping = [
      'StoreTypeFeatures',
      'FeatureStoreTypes',
      'StoreTypeRoleTemplates',
      'RoleTemplateStoreTypes',
    ].includes(config.name);
    if (
      softDeleteStoreTypeMapping &&
      ['create', 'replace', 'patch', 'delete'].includes(operation) &&
      !auditUserId
    ) {
      throw new UnauthorizedException('Authenticated user id is required');
    }
    if (operation === 'list') {
      const items = await manager.query(
        `SELECT ${projection} FROM public.${config.table}
         WHERE ${quoteIdent(config.parentColumn)} = $1${softDeleteStoreTypeMapping ? ' AND is_deleted = false' : ''}
         ORDER BY ${quoteIdent(config.createdColumn || 'createdAt')}, id`,
        [parent],
      );
      return {
        success: true,
        count: items.length,
        items: await this.withChildDetails(manager, config, items),
      };
    }
    if (operation === 'create') {
      let tenantValue = merchantUuid || merchant;
      if (config.name === 'RolePermissions') {
        tenantValue = await this.resolveMerchantUuid(merchant!);
        if (fields.storeId) {
          fields.storeId = await this.resolveStoreUuid(
            String(fields.storeId),
            merchant!,
          );
        }
      }
      let childOwner = config.childOwnerColumn || 'merchantId';
      if (config.name === 'EmployeeStores') childOwner = 'merchant_id';
      const scopeChild =
        config.tenantColumn && config.name !== 'RolePermissions';
      const childOwnerValue =
        config.name === 'EmployeeStores' ? merchantUuid : merchant;
      const children = await manager.query(
        `SELECT id FROM public.${config.childTable} WHERE id = $1${scopeChild ? ` AND ${quoteIdent(childOwner)} = $2` : ''} FOR SHARE`,
        scopeChild ? [child, childOwnerValue] : [child],
      );
      if (!children.length)
        throw new NotFoundException(
          'Related record not found in the requested scope',
        );
      if (softDeleteStoreTypeMapping) {
        const [previous] = await manager.query(
          `SELECT id, is_deleted AS "isDeleted"
           FROM public.${config.table}
           WHERE ${quoteIdent(config.parentColumn)} = $1
             AND ${quoteIdent(config.childColumn)} = $2
           ORDER BY is_deleted ASC, created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [parent, child],
        );
        if (previous && !previous.isDeleted) {
          throw new ConflictException('This relationship already exists');
        }
        if (previous?.isDeleted) {
          const status = fields.status ?? 'ACTIVE';
          const updateResult = await manager.query(
            `UPDATE public.${config.table}
             SET status = $2,
                 is_deleted = false,
                 created_by = COALESCE(created_by, $3),
                 updated_by = $3,
                 updated_at = clock_timestamp()
             WHERE id = $1 AND is_deleted = true
             RETURNING ${projection}`,
            [previous.id, status, auditUserId],
          );
          const reactivatedRows = Array.isArray(updateResult[0])
            ? updateResult[0]
            : updateResult;
          const reactivated = reactivatedRows[0];
          await this.syncStoreFeatureToPlans(
            manager,
            config,
            parent,
            child!,
            'create',
            { ...fields, ...reactivated },
          );
          return { success: true, item: reactivated, reactivated: true };
        }
      }
      this.dates(fields);
      const loginPinHash = fields.__loginPinHash;
      const loginPin = fields.__loginPin;
      delete fields.__loginPinHash;
      delete fields.__loginPin;
      const entries = Object.entries(fields);
      const assignmentStore =
        config.name === 'EmployeeStoreRoles'
          ? (
              await manager.query(
                'SELECT store_id FROM public.employee_stores WHERE id=$1',
                [parent],
              )
            )[0]?.store_id
          : undefined;
      const columns = [
        config.parentColumn,
        config.childColumn,
        ...(config.tenantColumn ? [config.tenantField || 'merchantId'] : []),
        ...(config.name === 'EmployeeStoreRoles' ? ['store_id'] : []),
        ...(config.name === 'EmployeeStores' && loginPinHash
          ? ['login_pin_hash', 'login_pin']
          : []),
        ...(softDeleteStoreTypeMapping ? ['is_deleted'] : []),
        ...(softDeleteStoreTypeMapping ? ['created_by', 'updated_by'] : []),
        ...entries.map(([key]) => config.fields[key].column),
      ].map(quoteIdent);
      const values = [
        parent,
        child,
        ...(config.tenantColumn ? [tenantValue] : []),
        ...(config.name === 'EmployeeStoreRoles' ? [assignmentStore] : []),
        ...(config.name === 'EmployeeStores' && loginPinHash
          ? [loginPinHash, loginPin]
          : []),
        ...(softDeleteStoreTypeMapping ? [false] : []),
        ...(softDeleteStoreTypeMapping ? [auditUserId, null] : []),
        ...entries.map(([, value]) => value),
      ];
      const [item] = await manager.query(
        `INSERT INTO public.${config.table} (${columns.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${projection}`,
        values,
      );
      await this.syncStoreFeatureToPlans(
        manager,
        config,
        parent,
        child!,
        'create',
        { ...fields, ...item },
      );
      return { success: true, item };
    }
    const where = `${quoteIdent(config.parentColumn)} = $1 AND ${quoteIdent(config.childColumn)} = $2${softDeleteStoreTypeMapping ? ' AND is_deleted = false' : ''}`;
    const [existing] = await manager.query(
      `SELECT ${projection} FROM public.${config.table} WHERE ${where} FOR UPDATE`,
      [parent, child],
    );
    if (!existing) throw new NotFoundException('Relationship not found');
    if (operation === 'get') return { success: true, item: existing };
    if (operation === 'delete') {
      if (softDeleteStoreTypeMapping) {
        await manager.query(
          `UPDATE public.${config.table}
           SET status = 'INACTIVE', is_deleted = true, updated_by = $3, updated_at = clock_timestamp()
           WHERE ${where}`,
          [parent, child, auditUserId],
        );
      } else {
        await manager.query(
          `DELETE FROM public.${config.table} WHERE ${where}`,
          [parent, child],
        );
      }
      await this.syncStoreFeatureToPlans(
        manager,
        config,
        parent,
        child!,
        'delete',
        existing,
      );
      return {
        success: true,
        message: softDeleteStoreTypeMapping
          ? 'Relationship soft-deleted'
          : 'Relationship removed',
        ...(softDeleteStoreTypeMapping
          ? { status: 'INACTIVE', isDeleted: true }
          : {}),
      };
    }
    this.dates({ ...existing, ...fields });
    const loginPinHash = fields.__loginPinHash;
    const loginPin = fields.__loginPin;
    delete fields.__loginPinHash;
    delete fields.__loginPin;
    const entries = Object.entries(fields);
    const assignments = entries.map(
      ([key], i) => `${quoteIdent(config.fields[key].column)} = $${i + 3}`,
    );
    if (softDeleteStoreTypeMapping)
      assignments.push(`${quoteIdent('updated_by')} = $${entries.length + 3}`);
    if (loginPinHash) {
      assignments.push(
        `${quoteIdent('login_pin_hash')} = $${entries.length + (softDeleteStoreTypeMapping ? 4 : 3)}`,
      );
      assignments.push(
        `${quoteIdent('login_pin')} = $${entries.length + (softDeleteStoreTypeMapping ? 5 : 4)}`,
      );
    }
    if (config.timestamps)
      assignments.push(
        `${quoteIdent(config.updatedColumn || 'updatedAt')} = clock_timestamp()`,
      );
    // TypeORM's PostgreSQL driver returns [rows, affectedCount] for UPDATE.
    const [rows] = await manager.query(
      `UPDATE public.${config.table} SET ${assignments.join(', ')} WHERE ${where} RETURNING ${projection}`,
      [
        parent,
        child,
        ...entries.map(([, value]) => value),
        ...(softDeleteStoreTypeMapping ? [auditUserId] : []),
        ...(loginPinHash ? [loginPinHash, loginPin] : []),
      ],
    );
    await this.syncStoreFeatureToPlans(
      manager,
      config,
      parent,
      child!,
      'update',
      { ...existing, ...fields, ...rows[0] },
    );
    return { success: true, item: rows[0] };
  }

  /**
   * Plans for a store type keep their own feature list. A store-type feature
   * assignment is the source: create adds it, update copies enabled/config,
   * and delete removes it from those plans.
   */
  private async syncStoreFeatureToPlans(
    manager: EntityManager,
    config: Relationship,
    parent: string,
    child: string,
    operation: 'create' | 'update' | 'delete',
    state: Record<string, unknown>,
  ) {
    const target =
      config.name === 'StoreTypeFeatures'
        ? { storeTypeId: parent, featureId: child }
        : config.name === 'FeatureStoreTypes'
          ? { storeTypeId: child, featureId: parent }
          : null;
    if (!target) return;

    const [storeType] = await manager.query(
      `SELECT id::text AS id, name,
              COALESCE(to_jsonb(s)->>'storeTypeCode', to_jsonb(s)->>'store_type_code', '') AS code
       FROM public.store_types s WHERE id = $1::uuid`,
      [target.storeTypeId],
    );
    const [feature] = await manager.query(
      `SELECT id::text AS id, name,
              COALESCE(to_jsonb(f)->>'feature_key', to_jsonb(f)->>'feature_code', '') AS key
       FROM public.features f WHERE id = $1::uuid`,
      [target.featureId],
    );
    if (!storeType || !feature) return;

    const plans = await manager.query(
      `SELECT id, included_features AS "includedFeatures"
       FROM public.plans
       WHERE store_type_id = $1::uuid AND is_deleted = false`,
      [target.storeTypeId],
    );
    const aliases = [feature.id, feature.name, feature.key]
      .map((value: unknown) =>
        String(value || '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
    const enabled = operation !== 'delete' && state.status !== 'INACTIVE';

    for (const plan of plans) {
      const current = Array.isArray(plan.includedFeatures)
        ? plan.includedFeatures.map((item: unknown) => String(item))
        : [];
      const present = current.some((item: string) =>
        aliases.includes(item.trim().toLowerCase()),
      );
      const next = !enabled
        ? current.filter(
            (item: string) => !aliases.includes(item.trim().toLowerCase()),
          )
        : present
          ? current
          : [...current, String(feature.id)];
      if (
        next.length !== current.length ||
        next.some((item: string, index: number) => item !== current[index])
      ) {
        await manager.query(
          `UPDATE public.plans SET included_features = $2::text[], updated_at = clock_timestamp() WHERE id = $1`,
          [plan.id, next],
        );
      }
    }
  }

  private async resolveMerchantCode(identifier: string): Promise<string> {
    this.id(identifier, 'merchantId');
    const rows = await this.db.query(
      'SELECT "merchantId" AS id FROM public.merchants WHERE "merchantId"=$1 OR "merchantCode"=$1 OR id::text=$1 LIMIT 1',
      [identifier],
    );
    if (!rows.length) throw new NotFoundException('Merchant not found');
    return rows[0].id;
  }

  private async resolveRelationshipMerchant(
    config: Relationship,
    parent: string,
    identifier?: string,
  ): Promise<string> {
    if (identifier) return this.resolveMerchantCode(identifier);
    let rows: Array<{ id: string }> = [];
    if (config.name === 'EmployeeStores') {
      rows = await this.db.query(
        `SELECT m."merchantId" AS id FROM public.employees e
         JOIN public.merchants m ON m.id=e.merchant_id WHERE e.id=$1::uuid LIMIT 1`,
        [parent],
      );
    } else if (config.name === 'EmployeeStoreRoles') {
      rows = await this.db.query(
        `SELECT m."merchantId" AS id FROM public.employee_stores es
         JOIN public.merchants m ON m.id=es.merchant_id WHERE es.id=$1::uuid LIMIT 1`,
        [parent],
      );
    }
    if (!rows.length) throw new NotFoundException('Parent not found');
    return rows[0].id;
  }

  private async resolveMerchantUuid(identifier: string): Promise<string> {
    const rows = await this.db.query(
      'SELECT m.id FROM public.merchants m WHERE m."merchantId"=$1 OR m."merchantCode"=$1 OR m.id::text=$1 ORDER BY m."createdAt" ASC NULLS LAST, m.id LIMIT 1',
      [identifier],
    );
    if (!rows.length) throw new NotFoundException('Merchant not found');
    return rows[0].id;
  }

  private async resolveStoreUuid(
    identifier: string,
    merchant: string,
  ): Promise<string> {
    const merchantId = await this.resolveMerchantUuid(merchant);
    const rows = await this.db.query(
      `SELECT id FROM public.stores WHERE (store_code=$1 OR id::text=$1)
       AND merchant_id=$2::uuid LIMIT 1`,
      [identifier, merchantId],
    );
    if (!rows.length)
      throw new NotFoundException('Store not found for this merchant');
    return rows[0].id;
  }
}
