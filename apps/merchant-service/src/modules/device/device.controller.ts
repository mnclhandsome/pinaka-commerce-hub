import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  ValidationPipe,
} from "@nestjs/common";
import { randomInt, randomUUID } from "node:crypto";
import { CreateDeviceDto, UpdateDeviceDto } from "./dto/device.dto";
import { MerchantEntity } from "../../entities/merchant.entity";
import { DeviceEntity } from "../../entities/device.entity";
import { RecordStatus } from "../../entities/commerce-enums";
import { RequireAuth } from "../shared/session-auth.guard";
import { DeviceService } from './device.service';

type AuthenticatedRequest = { user?: { id?: string } };

@Controller(["api/v1/devices", "connector/api/v1/devices", "devices"])
export class DeviceController {
  constructor(@Inject(DeviceService) private readonly service: DeviceService) {}

  @Post()
  @RequireAuth()
  async create(
    @Body(
      new ValidationPipe({
        expectedType: CreateDeviceDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: CreateDeviceDto,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = this.auditUser(request);
    const merchantIdentifier = body.merchant_id || body.merchantId || body.merchant;
    if (!merchantIdentifier) throw new BadRequestException("merchant_id is required");
    const merchant = await this.service.findDeviceMerchant(merchantIdentifier);
    if (!merchant) throw new NotFoundException("Merchant not found");
    const merchantId = merchant.id;
    const deviceName = body.device_name || body.deviceName || "POS Terminal";
    const deviceType = body.device_type || body.deviceType || "POS Terminal";
    const rawSerialNumber = (
      body.serial_number ||
      body.serialNumber ||
      body.device_serial_number ||
      body.deviceSerialNumber ||
      ""
    ).trim();
    const serial_number = rawSerialNumber || null;
    const device = await this.service.createDevice({
      id: randomUUID(),
      deviceId: body.device_id || body.deviceId || null,
      deviceName,
      deviceType,
      merchantId,
      merchantName: merchant.businessDisplayName ?? merchant.id,
      serialNumber: serial_number,
      notes: body.notes || null,
      status: body.status ?? RecordStatus.ACTIVE,
      createdBy: actor,
      updatedBy: actor,
    });
    return {
      success: true,
      device: this.publicDevice(
        device,
      ),
    };
  }

  @Get()
  async list(@Query() query: Record<string, string | undefined>) {
    const page = this.positiveInt(query.page, 1, "page");
    const limit = this.positiveInt(query.limit, 10, "limit");
    if (limit > 100) throw new BadRequestException("limit must not exceed 100");
    const from = this.queryDate(query.from, "from");
    const to = this.queryDate(query.to, "to");
    if (from && to && from >= to)
      throw new BadRequestException("from must be earlier than to");
    const status = query.status?.trim();
    if (
      status &&
      !["active", "inactive", "online", "offline"].includes(
        status.toLowerCase(),
      )
    ) {
      throw new BadRequestException(
        "status must be Active, Inactive, Online, or Offline",
      );
    }
    const result = this.service.queryDevices
      ? await this.service.queryDevices({
          page,
          limit,
          search: query.search?.trim() || undefined,
          merchantId: query.merchant_id,
          deviceType: query.device_type,
          status,
          from,
          to,
        })
      : await this.service.listDevices().then(devices => ({
          devices,
          total: devices.length,
          summary: devices.reduce((counts, device) => {
            const status = String(device.status).toLowerCase();
            counts[status] = (counts[status] ?? 0) + 1;
            return counts;
          }, {} as Record<string, number>),
        }));
    const merchants = await this.service.getAllMerchants();
    const merchantNames = new Map(
      merchants.map((item: MerchantEntity) => [item.id, item.businessName ?? undefined]),
    );
    const response: Record<string, unknown> = {
      count: result.total,
      summary: {
        total_devices: (result.summary.active ?? 0) + (result.summary.inactive ?? 0),
        online_devices: 0,
        offline_devices: result.summary.active ?? 0,
        inactive_devices: result.summary.inactive ?? 0,
      },
      devices: result.devices.map((device: DeviceEntity) =>
        this.publicDevice(
          device,
          merchantNames.get(device.merchantId),
        ),
      ),
    };
    if (query.page !== undefined || query.limit !== undefined) {
      response.pagination = {
        page,
        limit,
        total: result.total,
        total_pages: Math.ceil(result.total / limit),
      };
    }
    return response;
  }

  @Get("merchant/:merchant_id")
  async listByMerchant(@Param("merchant_id") merchantIdentifier: string) {
    const merchant = await this.service.findDeviceMerchant(merchantIdentifier);
    if (!merchant) throw new NotFoundException("Merchant not found");
    const merchantId = merchant.id;
    const devices = await this.service.listDevicesByMerchantId(merchantId);
    return {
      count: devices.length,
      devices: devices.map((device) => this.publicDevice(device, merchant.businessDisplayName ?? merchant.id)),
    };
  }

  @Get("available")
  async listAvailableByMerchant(@Query("merchant_id", new ParseUUIDPipe()) merchantUuid: string) {
    const devices = await this.service.findAvailableDevicesByMerchant(merchantUuid);
    if (!devices) throw new NotFoundException("Merchant not found");
    return {
      count: devices.length,
      devices: devices.map(device => this.publicDevice(device)),
    };
  }

  @Get(":device_id")
  async get(@Param("device_id", new ParseUUIDPipe()) deviceId: string) {
    const device = await this.service.getDevice(deviceId);
    if (!device) throw new NotFoundException("Device not found");
    const merchants = await this.service.getAllMerchants();
    return {
      success: true,
      device: this.publicDevice(
        device,
        merchants.find((item) => item.id === device.merchantId)?.businessName ?? undefined,
      ),
    };
  }

  @Put(":device_id")
  @RequireAuth()
  async update(
    @Param("device_id", new ParseUUIDPipe()) deviceId: string,
    @Body(
      new ValidationPipe({
        expectedType: UpdateDeviceDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: UpdateDeviceDto,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = this.auditUser(request);
    const current = await this.service.getDevice(deviceId);
    if (!current) throw new NotFoundException("Device not found");
    if (!Object.keys(body).length)
      throw new BadRequestException("Provide at least one field to update");
    const requestedMerchantId = body.merchant_id ?? current.merchantId;
    const merchant = await this.service.findDeviceMerchant(requestedMerchantId);
    if (!merchant) throw new NotFoundException("Merchant not found");
    const merchantId = merchant.id;
    const updated = await this.service.updateDevice(deviceId, {
      deviceName: body.device_name ?? current.deviceName,
      deviceType: body.device_type ?? current.deviceType,
      deviceCode: current.deviceCode,
      deviceId: body.device_id ?? current.deviceId,
      serialNumber: body.serial_number ?? current.serialNumber,
      merchantId,
      merchantName: merchant.businessDisplayName ?? merchant.id,
      status: body.status ?? current.status,
      updatedBy: actor,
      updatedAt: new Date(),
    });
    return {
      success: true,
      device: this.publicDevice(
        updated,
      ),
    };
  }

  @Patch(":device_id")
  @RequireAuth()
  patch(
    @Param("device_id", new ParseUUIDPipe()) deviceId: string,
    @Body(
      new ValidationPipe({
        expectedType: UpdateDeviceDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: UpdateDeviceDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.update(deviceId, body, request);
  }

  @Delete(":device_id")
  @RequireAuth()
  async remove(@Param("device_id", new ParseUUIDPipe()) deviceId: string, @Req() request: AuthenticatedRequest) {
    if (!(await this.service.deleteDevice(deviceId, this.auditUser(request))))
      throw new NotFoundException("Device not found");
    return { success: true, message: "Device deleted" };
  }

  private publicDevice(
    device: DeviceEntity,
    merchantName?: string,
  ) {
    return {
      id: device.id,
      device_id: device.deviceId ?? null,
      device_name: device.deviceName,
      device_code: device.deviceCode,
      device_type: device.deviceType,
      status: device.status,
      merchant_id: device.merchantId,
      merchant_name: merchantName || device.merchantName || device.merchantId,
      serial_number: device.serialNumber ?? null,
      device_active_code: device.deviceActiveCode ?? null,
      authorization_code: device.authorizationCode ?? device.deviceActiveCode ?? null,
      activation_code: device.deviceActiveCode ?? null,
      notes: (device as any).notes ?? null,
      created_at: device.createdAt,
      updated_at: device.updatedAt,
      created_by: device.createdBy ?? null,
      updated_by: device.updatedBy ?? null,
      connection_status: device.status === "INACTIVE" ? "Inactive" : "Offline",
      last_seen_at: null,
    };
  }

  private auditUser(request: AuthenticatedRequest): string {
    const id = request.user?.id;
    if (!id) {
      if (process.env.SKIP_AUTH === 'true') {
        return '11111111-1111-4111-8111-111111111111';
      }
      throw new UnauthorizedException("Authenticated user UUID is unavailable");
    }
    return id;
  }

  private positiveInt(
    value: string | undefined,
    fallback: number,
    name: string,
  ): number {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1)
      throw new BadRequestException(`${name} must be a positive integer`);
    return Number(value);
  }

  private queryDate(value: string | undefined, name: string): Date | undefined {
    if (value === undefined) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException(`${name} must be a valid date`);
    return date;
  }
}
