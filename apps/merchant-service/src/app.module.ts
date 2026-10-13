import { Module } from '@nestjs/common';
import { DynamicQueryModule } from './modules/dynamic-query/dynamic-query.module';
import { EmployeeModule } from './modules/employee/employee.module';
import { MasterModule } from './modules/master/master.module';
import { MerchantModule } from './modules/merchant/merchant.module';
import { PosModule } from './pos/pos.module';
import { RelationshipsModule } from './modules/shared/relationships.module';
import { StoreModule } from './modules/store/store.module';
import { StorePosConfigurationModule } from './modules/store-pos-configuration/store-pos-configuration.module';
import { VendorModule } from './modules/vendor/vendor.module';
import { DeviceModule } from './modules/device/device.module';
import { PosAuthModule } from './modules/pos-auth/pos-auth.module';

/**
 * Application composition root.
 */
@Module({
  imports: [
    MerchantModule,
    StoreModule,
    EmployeeModule,
    VendorModule,
    MasterModule,
    RelationshipsModule,
    DynamicQueryModule,
    PosModule,
    StorePosConfigurationModule,
    DeviceModule,
    PosAuthModule,
  ],
})
export class AppModule {}

