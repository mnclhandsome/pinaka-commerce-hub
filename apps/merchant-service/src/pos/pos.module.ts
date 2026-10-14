import { DiscountController } from './discount/discount.controller';
import { DiscountService } from './discount/discount.service';
import { Module } from '@nestjs/common';
import { PosCardPaymentController } from './card-payments/pos-card-payment.controller';
import { PosCardPaymentService } from './card-payments/pos-card-payment.service';
import { PosCashbackController } from './cashback/pos-cashback.controller';
import { PosCashbackService } from './cashback/pos-cashback.service';
import { PosCashDenominationController } from './cash-denominations/pos-cash-denomination.controller';
import { PosCashDenominationService } from './cash-denominations/pos-cash-denomination.service';
import { PosCashRegisterController } from './cash-registers/pos-cash-register.controller';
import { PosCashRegisterService } from './cash-registers/pos-cash-register.service';
import { PosCurrencyTaxController } from './currency-tax/pos-currency-tax.controller';
import { PosCurrencyTaxService } from './currency-tax/pos-currency-tax.service';
import { PosOpeningBalanceController } from './opening-balance/pos-opening-balance.controller';
import { PosOpeningBalanceService } from './opening-balance/pos-opening-balance.service';
import { PosSafeDropController } from './safe-drop/pos-safe-drop.controller';
import { PosSafeDropService } from './safe-drop/pos-safe-drop.service';
import { PosServiceChargeController } from './service-charges/pos-service-charge.controller';
import { PosServiceChargeService } from './service-charges/pos-service-charge.service';
import { PosTerminalMappingController } from './terminal-mappings/pos-terminal-mapping.controller';
import { PosTerminalMappingService } from './terminal-mappings/pos-terminal-mapping.service';
import {
  FastkeyController,
  StoreFastkeyImageController,
} from './fastkeys/fastkey.controller';
import { FastkeyService } from './fastkeys/fastkey.service';
import { PosEmployeeAttendanceModule } from './pos_employee_attendance/pos_employee_attendance.module';
import { MerchantModule } from '../modules/merchant/merchant.module';
import { PosSafeTransactionsController } from './safe-transactions/pos-safe-transactions.controller';
import { PosSafeTransactionsService } from './safe-transactions/pos-safe-transactions.service';

@Module({
  imports: [MerchantModule, PosEmployeeAttendanceModule],
  controllers: [
    DiscountController,
    PosCurrencyTaxController,
    PosServiceChargeController,
    PosCashbackController,
    PosOpeningBalanceController,
    PosCashDenominationController,
    PosCashRegisterController,
    PosSafeDropController,
    PosSafeTransactionsController,
    PosCardPaymentController,
    PosTerminalMappingController,
    FastkeyController,
    StoreFastkeyImageController,
  ],
  providers: [
    DiscountService,
    PosCurrencyTaxService,
    PosServiceChargeService,
    PosCashbackService,
    PosOpeningBalanceService,
    PosCashDenominationService,
    PosCashRegisterService,
    PosSafeDropService,
    PosSafeTransactionsService,
    PosCardPaymentService,
    PosTerminalMappingService,
    FastkeyService,
  ],
})
export class PosModule {}
