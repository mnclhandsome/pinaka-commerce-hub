import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  ValidationPipe,
} from '@nestjs/common';
import { PosEmployeeAttendanceQueryDto } from './pos_employee_attendance.dto';
import { PosEmployeeAttendanceService } from './pos_employee_attendance.service';

const queryValidation = new ValidationPipe({
  expectedType: PosEmployeeAttendanceQueryDto,
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: () =>
    new BadRequestException({ success: false, message: 'Invalid attendance filters' }),
});

@Controller([
  'api/v1/merchants/:merchantId/stores/:storeId/attendance',
  'connector/api/v1/merchants/:merchantId/stores/:storeId/attendance',
])
export class StoreEmployeeAttendanceController {
  constructor(
    @Inject(PosEmployeeAttendanceService)
    private readonly attendance: PosEmployeeAttendanceService,
  ) {}

  @Get()
  list(
    @Param('merchantId') merchantId: string,
    @Param('storeId') storeId: string,
    @Query(queryValidation) filters: PosEmployeeAttendanceQueryDto,
  ) {
    return this.attendance.list(
      {
        employeeId: '',
        employeeCode: '',
        merchantId: merchantId.trim(),
        storeId: storeId.trim(),
        roleId: '',
      },
      filters,
    );
  }
}
