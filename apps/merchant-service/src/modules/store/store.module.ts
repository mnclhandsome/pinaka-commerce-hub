import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { StoreSetupModule } from '../master/store-setup/store-setup.module';
import { MerchantModule } from '../merchant/merchant.module';
import { StorePosPaymentsController } from './store-pos-payments.controller';

@Module({
  imports: [MerchantModule, StoreSetupModule],
  controllers: [AppController, StorePosPaymentsController],
})
export class StoreModule {}
