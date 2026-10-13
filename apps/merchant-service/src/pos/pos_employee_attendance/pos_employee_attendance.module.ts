import { Module } from '@nestjs/common';
import { MerchantModule } from '../../modules/merchant/merchant.module';
import { PinService } from '../../modules/pos-auth/services/pin.service';
import { PosEmployeeAttendanceController } from './pos_employee_attendance.controller';
import { PosEmployeeAttendanceGuard } from './pos_employee_attendance.guard';
import { PosEmployeeAttendanceRepository } from './pos_employee_attendance.repository';
import { PosEmployeeAttendanceService } from './pos_employee_attendance.service';

@Module({
  imports: [MerchantModule],
  controllers: [PosEmployeeAttendanceController],
  providers: [
    PosEmployeeAttendanceRepository,
    PosEmployeeAttendanceService,
    PosEmployeeAttendanceGuard,
    PinService,
  ],
})
export class PosEmployeeAttendanceModule {}
