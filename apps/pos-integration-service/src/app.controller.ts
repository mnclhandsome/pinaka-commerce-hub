import { Inject, Controller, Get, Post, Put, Body, Param, Query, NotFoundException, BadRequestException } from '@nestjs/common';
import { PosRepository } from './pos.repository';
import { PosConfigRepository } from './pos-config.repository';
import { FastkeyItem } from './pos-config.entity';
import { MovementType } from './entities/cash-movement.entity';
import { ShiftDenominationData } from './entities/pos-shift.entity';

const SHIFT_REQUEST_ALIASES = [
  ['merchant_id', 'merchantId'],
  ['store_id', 'storeId'],
  ['terminal_id', 'terminalId'],
  ['device_id', 'terminalId'],
  ['deviceId', 'terminalId'],
  ['register_id', 'registerId'],
  ['cashier_name', 'cashierName'],
  ['opening_cash', 'openingCash'],
  ['shift_id', 'shiftId'],
  ['movement_type', 'movementType'],
  ['performed_by', 'performedBy'],
  ['closing_cash_actual', 'closingCashActual'],
  ['opened_by_employee_id', 'openedByEmployeeId'],
  ['closed_by_employee_id', 'closedByEmployeeId'],
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeShiftRequest<T extends object>(input: T): T {
  const request = { ...input } as T & Record<string, unknown>;
  for (const [snakeName, camelName] of SHIFT_REQUEST_ALIASES) {
    if (!(snakeName in request)) continue;
    if (camelName in request && !Object.is(request[snakeName], request[camelName])) {
      throw new BadRequestException(`Conflicting values for ${snakeName} and ${camelName}`);
    }
    Object.assign(request, { [camelName]: request[snakeName] });
    delete request[snakeName];
  }
  return request;
}

type OpenShiftRequest = ShiftDenominationData & {
  merchantId?: string;
  merchant_id?: string;
  storeId?: string;
  store_id?: string;
  terminalId?: string;
  terminal_id?: string;
  deviceId?: string;
  device_id?: string;
  registerId?: string;
  register_id?: string;
  cashierName?: string;
  cashier_name?: string;
  openingCash?: number;
  opening_cash?: number;
  openedByEmployeeId?: string;
  opened_by_employee_id?: string;
};


@Controller('api/v1/pos')
export class AppController {
  constructor(
    @Inject(PosRepository) private readonly posRepository: PosRepository,
    @Inject(PosConfigRepository) private readonly posConfigRepository: PosConfigRepository,
  ) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'pos-integration-service',
      version: '2.0.0 (PCH Module 5)',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('stores/:storeId/fastkeys')
  async getFastkeys(@Param('storeId') storeId: string) {
    const config = await this.posConfigRepository.getStoreConfig(storeId);
    return {
      success: true,
      storeId,
      fastkeys: config.fastkeys || [],
      version: config.version,
    };
  }

  @Put('stores/:storeId/fastkeys')
  async saveFastkeys(
    @Param('storeId') storeId: string,
    @Body('fastkeys') fastkeys: FastkeyItem[],
  ) {
    if (!Array.isArray(fastkeys)) {
      throw new BadRequestException('fastkeys must be an array');
    }
    const config = await this.posConfigRepository.updateFastkeys(storeId, fastkeys);
    return {
      success: true,
      message: 'Fast Keys saved successfully',
      storeId,
      fastkeys: config.fastkeys,
      version: config.version,
    };
  }

  // --- 1. Terminal Session Pairing & Entitlement Validation ---
  @Post('activate')
  async activateTerminal(@Body('activationPin') pin: string) {
    if (!pin || pin.trim().length !== 6) {
      throw new BadRequestException('A valid 6-digit terminal activation PIN is required');
    }
    return {
      success: true,
      message: 'Sunmi POS Terminal Paired Successfully!',
      sessionToken: `jwt_pos_${Date.now()}_${pin}`,
      store: {
        id: 'STR-5001',
        merchantId: 'MCH-1001',
        storeName: 'Fresh Mart - Downtown Branch',
        storeType: 'GROCERY',
        currency: 'USD',
        taxRate: 8.25,
      },
      entitlements: ['POS', 'BARCODE_SCANNING', 'UBER_EATS', 'DOORDASH', 'PAYROLL', 'LOYALTY'],
    };
  }

  // --- 2. Open Cashier Shift ---
  @Post(['shifts', 'shifts/open'])
  async openShift(@Body() request: OpenShiftRequest) {
    const body = normalizeShiftRequest(request);
    if (!body?.merchantId?.trim() || !body.storeId?.trim() || !body.cashierName?.trim()) {
      throw new BadRequestException('merchantId, storeId, and cashierName are required');
    }
    const openingCash = body.openingCash === undefined ? 200 : Number(body.openingCash);
    if (!Number.isFinite(openingCash) || openingCash < 0) {
      throw new BadRequestException('openingCash must be a non-negative number');
    }
    if (body.registerId && !UUID_PATTERN.test(body.registerId)) {
      throw new BadRequestException('registerId must be a valid UUID');
    }
    const openedByEmployeeId = body.openedByEmployeeId?.trim() || undefined;
    if (openedByEmployeeId && !UUID_PATTERN.test(openedByEmployeeId)) {
      throw new BadRequestException('openedByEmployeeId must be a valid UUID');
    }
    if (body.drawer_denominations !== undefined && (
      !Array.isArray(body.drawer_denominations) ||
      body.drawer_denominations.some(item =>
        !item ||
        !Number.isFinite(item.denomination) || item.denomination <= 0 ||
        !Number.isInteger(item.denom_count) || item.denom_count < 0,
      )
    )) {
      throw new BadRequestException('drawer_denominations must contain positive denominations and non-negative integer denom_count values');
    }
    if (body.tube_denominations !== undefined && (
      !Array.isArray(body.tube_denominations) ||
      body.tube_denominations.some(item =>
        !item ||
        !Number.isFinite(item.denomination) || item.denomination <= 0 ||
        !Number.isInteger(item.tube_count) || item.tube_count < 0 ||
        !Number.isInteger(item.cell_count) || item.cell_count < 0 ||
        !Number.isFinite(item.total) || item.total < 0,
      )
    )) {
      throw new BadRequestException('tube_denominations must contain positive denominations and non-negative tube_count, cell_count, and total values');
    }
    for (const [field, amount] of [
      ['drawer_total_amount', body.drawer_total_amount],
      ['tube_total_amount', body.tube_total_amount],
      ['total_amount', body.total_amount],
    ] as const) {
      if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
        throw new BadRequestException(`${field} must be a non-negative number`);
      }
    }
    const shift = await this.posRepository.openShift(
      body.merchantId.trim(),
      body.storeId.trim(),
      body.terminalId?.trim() || 'SUNMI-D3-01',
      body.cashierName.trim(),
      openingCash,
      body.registerId,
      {
        drawer_denominations: body.drawer_denominations,
        drawer_total_amount: body.drawer_total_amount,
        tube_denominations: body.tube_denominations,
        tube_total_amount: body.tube_total_amount,
        total_amount: body.total_amount,
      },
      openedByEmployeeId,
    );
    return {
      success: true,
      message: 'Shift created and opened successfully',
      shiftId: shift.id,
      shift,
    };
  }

  // --- 3. Record Safe Drop / Paid Out ---
  @Post('shifts/cash-movement')
  async recordCashMovement(@Body() request: {
    shiftId?: string;
    shift_id?: string;
    storeId?: string;
    store_id?: string;
    movementType?: MovementType;
    movement_type?: MovementType;
    amount: number;
    performedBy?: string;
    performed_by?: string;
    reason?: string;
  }) {
    const body = normalizeShiftRequest(request);
    if (!body.shiftId || !body.storeId || !body.amount) {
      throw new BadRequestException('shiftId, storeId, and amount are required');
    }
    const movement = await this.posRepository.recordCashMovement(body.shiftId, body.storeId, body.movementType || MovementType.SAFE_DROP, body.amount, body.performedBy || 'Manager', body.reason);
    return {
      success: true,
      message: `Cash movement '${movement.movementType}' recorded successfully!`,
      cashMovement: movement,
    };
  }

  // --- 4. Close Shift & Generate Z-Report ---
  @Post('shifts/close')
  async closeShift(@Body() request: {
    shiftId?: string;
    shift_id?: string;
    closingCashActual?: number;
    closing_cash_actual?: number;
    closedByEmployeeId?: string;
    closed_by_employee_id?: string;
    closed_by_device_id?: string;
    total_orders?: number;
    total_order_sale_amount?: number;
    total_cashback?: number;
    total_payouts?: number;
    total_ebt_sales?: number;
    total_pay_later?: number;
    total_refunds?: number;
    total_cancelled_orders?: number;
    total_void_items?: number;
  }) {
    const body = normalizeShiftRequest(request);
    if (!body.shiftId || body.closingCashActual === undefined) {
      throw new BadRequestException('shiftId and closingCashActual are required');
    }
    const closedByEmployeeId = body.closedByEmployeeId?.trim() || undefined;
    if (closedByEmployeeId && !UUID_PATTERN.test(closedByEmployeeId)) {
      throw new BadRequestException('closedByEmployeeId must be a valid UUID');
    }
    for (const [field, count] of [
      ['total_orders', body.total_orders],
      ['total_cancelled_orders', body.total_cancelled_orders],
      ['total_void_items', body.total_void_items],
    ] as const) {
      if (count !== undefined && (!Number.isInteger(count) || count < 0)) {
        throw new BadRequestException(`${field} must be a non-negative integer`);
      }
    }
    for (const [field, amount] of [
      ['total_order_sale_amount', body.total_order_sale_amount],
      ['total_cashback', body.total_cashback],
      ['total_payouts', body.total_payouts],
      ['total_ebt_sales', body.total_ebt_sales],
      ['total_pay_later', body.total_pay_later],
      ['total_refunds', body.total_refunds],
    ] as const) {
      if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
        throw new BadRequestException(`${field} must be a non-negative number`);
      }
    }
    const result = await this.posRepository.closeShift(body.shiftId, Number(body.closingCashActual), closedByEmployeeId, {
      closed_by_device_id: body.closed_by_device_id?.trim() || undefined,
      total_orders: body.total_orders,
      total_order_sale_amount: body.total_order_sale_amount,
      total_cashback: body.total_cashback,
      total_payouts: body.total_payouts,
      total_ebt_sales: body.total_ebt_sales,
      total_pay_later: body.total_pay_later,
      total_refunds: body.total_refunds,
      total_cancelled_orders: body.total_cancelled_orders,
      total_void_items: body.total_void_items,
    });
    if (!result.success) {
      throw new NotFoundException(result.message);
    }
    return {
      success: true,
      message: 'Shift closed successfully! Z-Report generated for thermal printing.',
      shift: result.shift,
      reportType: 'Z_REPORT',
    };
  }

  @Get('shifts/active')
  async getActiveShift(@Query() query: { storeId?: string; store_id?: string }) {
    const { storeId } = normalizeShiftRequest(query);
    const shifts = await this.posRepository.getActiveShifts(storeId || 'STR-5001');
    return {
      success: true,
      storeId: storeId || 'STR-5001',
      count: shifts.length,
      shifts,
    };
  }

  @Get('shifts/employee/:employeeId')
  async getShiftsByEmployee(
    @Param('employeeId') employeeId: string,
    @Query() query: { storeId?: string; store_id?: string },
  ) {
    const id = employeeId.trim();
    if (!UUID_PATTERN.test(id)) {
      throw new BadRequestException('employeeId must be a valid UUID');
    }
    const { storeId } = normalizeShiftRequest(query);
    const shifts = await this.posRepository.getShiftsByEmployee(id, storeId?.trim() || undefined);
    return { success: true, employeeId: id, count: shifts.length, shifts };
  }
  @Get('stores/:store_id/shifts')
  async getShiftsByStore(@Param('store_id') store_id: string) {
    const storeId = store_id.trim();
    if (!storeId) throw new BadRequestException('store_id is required');
    const shifts = await this.posRepository.getShiftsByStore(storeId);
    return { success: true, store_id: storeId, count: shifts.length, shifts };
  }

  @Get('stores/:store_id/shifts/:shift_id')
  async getShift(
    @Param('store_id') store_id: string,
    @Param('shift_id') shift_id: string,
  ) {
    const shift = await this.posRepository.getShiftWithSafeTransactions(shift_id, store_id);
    if (!shift) throw new NotFoundException('POS shift not found');
    return { success: true, shift };
  }
}
