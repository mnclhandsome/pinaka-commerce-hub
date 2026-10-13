import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { PinService } from '../../modules/pos-auth/services/pin.service';
import {
  PosAttendanceIdentity,
  PosEmployeeAttendanceRepository,
} from './pos_employee_attendance.repository';
import {
  PosEmployeeAttendanceClockDto,
  PosEmployeeAttendanceQueryDto,
} from './pos_employee_attendance.dto';

@Injectable()
export class PosEmployeeAttendanceService implements OnModuleInit {
  constructor(
    @Inject(PosEmployeeAttendanceRepository)
    private readonly attendance: PosEmployeeAttendanceRepository,
    @Inject(PinService) private readonly pins: PinService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.attendance.ensureSchema();
  }

  async clockIn(dto: PosEmployeeAttendanceClockDto) {
    const employee = await this.authenticate(dto);
    const record = await this.attendance.clockIn(employee);
    return {
      success: true,
      message: 'Clock-in successful',
      employee: {
        employeeCode: employee.employeeCode,
        employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
      },
      attendance: record,
    };
  }

  async clockOut(dto: PosEmployeeAttendanceClockDto) {
    const employee = await this.authenticate(dto);
    const record = await this.attendance.clockOut(employee);
    return {
      success: true,
      message: 'Clock-out successful',
      employee: {
        employeeCode: employee.employeeCode,
        employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
      },
      attendance: record,
    };
  }

  async list(identity: PosAttendanceIdentity, filters: PosEmployeeAttendanceQueryDto) {
    if (filters.merchantId && filters.merchantId !== identity.merchantId) {
      throw new ForbiddenException({ success: false, message: 'Attendance access is limited to the authenticated merchant' });
    }
    if (filters.storeId && filters.storeId !== identity.storeId) {
      throw new ForbiddenException({ success: false, message: 'Attendance access is limited to the authenticated store' });
    }
    if (filters.employeeCode && filters.employeeCode !== identity.employeeCode) {
      throw new ForbiddenException({ success: false, message: 'Attendance access is limited to the authenticated employee' });
    }
    return {
      success: true,
      ...(await this.attendance.listForEmployee(identity, filters)),
    };
  }

  async current(identity: PosAttendanceIdentity) {
    const attendance = await this.attendance.findOpenForEmployee(identity);
    return {
      success: true,
      employee: { employeeCode: identity.employeeCode },
      currentAttendance: attendance,
    };
  }

  private async authenticate(dto: PosEmployeeAttendanceClockDto) {
    const employee = await this.attendance.findActiveEmployee(
      dto.employeeCode,
      dto.merchantId,
      dto.storeId,
    );
    if (!employee || !(await this.attendance.hasActiveStoreAssignment(employee.id, employee.storeId))) {
      throw new UnauthorizedException({
        success: false,
        message: 'Invalid employee credentials or merchant/store assignment',
      });
    }

    const hash = employee.loginPinHash?.trim();
    if (!hash) {
      throw new UnauthorizedException({
        success: false,
        message: 'Invalid employee credentials or merchant/store assignment',
      });
    }
    let validPin = false;
    try {
      // Keep attendance PIN validation aligned with POS login: employee-store
      // PINs take precedence, and PinService supports the existing hash formats
      // as well as legacy plain-text PINs.
      validPin = await this.pins.verify(dto.pin.trim(), hash);
    } catch {
      validPin = false;
    }
    if (!validPin) {
      throw new UnauthorizedException({
        success: false,
        message: 'Invalid employee credentials or merchant/store assignment',
      });
    }
    if (!employee.firstName.trim()) {
      throw new BadRequestException({ success: false, message: 'Employee name is not configured' });
    }
    return employee;
  }
}
