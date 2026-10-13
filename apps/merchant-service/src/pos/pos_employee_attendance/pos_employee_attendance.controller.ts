import {
  Body,
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Public } from '@pinaka-delivery-hub/auth';
import { PosEmployeeAttendanceClockDto, PosEmployeeAttendanceQueryDto } from './pos_employee_attendance.dto';
import { PosEmployeeAttendanceGuard } from './pos_employee_attendance.guard';
import type { PosEmployeeAttendanceRequest } from './pos_employee_attendance.guard';
import { PosEmployeeAttendanceService } from './pos_employee_attendance.service';

const clockValidation = new ValidationPipe({
  expectedType: PosEmployeeAttendanceClockDto,
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: () => new BadRequestException({ success: false, message: 'Invalid attendance request' }),
});

const queryValidation = new ValidationPipe({
  expectedType: PosEmployeeAttendanceQueryDto,
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: () => new BadRequestException({ success: false, message: 'Invalid attendance filters' }),
});

@Controller(['api/v1/attendance', 'connector/api/v1/attendance', 'attendance'])
@Public()
export class PosEmployeeAttendanceController {
  constructor(
    @Inject(PosEmployeeAttendanceService)
    private readonly attendance: PosEmployeeAttendanceService,
  ) {}

  @Post('clock-in')
  @HttpCode(HttpStatus.OK)
  clockIn(@Body(clockValidation) dto: PosEmployeeAttendanceClockDto) {
    return this.attendance.clockIn(dto);
  }

  @Post('clock-out')
  @HttpCode(HttpStatus.OK)
  clockOut(@Body(clockValidation) dto: PosEmployeeAttendanceClockDto) {
    return this.attendance.clockOut(dto);
  }

  @Get()
  @UseGuards(PosEmployeeAttendanceGuard)
  list(
    @Req() request: PosEmployeeAttendanceRequest,
    @Query(queryValidation) filters: PosEmployeeAttendanceQueryDto,
  ) {
    return this.attendance.list(request.posEmployee!, filters);
  }

  @Get('me')
  @UseGuards(PosEmployeeAttendanceGuard)
  current(@Req() request: PosEmployeeAttendanceRequest) {
    return this.attendance.current(request.posEmployee!);
  }
}
