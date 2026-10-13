import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { OrderUpdatesModule } from './modules/order-updates/order-updates.module';
import { OrderPersistenceModule } from './order-persistence.module';
import { OrderListPresenter } from './responses/order-list.presenter';
import { OrderResponsePresenter } from './responses/order-response.presenter';
import { StorePosPaymentsController } from './store-pos-payments.controller';

@Module({
  imports: [OrderPersistenceModule, OrderUpdatesModule],
  controllers: [AppController, StorePosPaymentsController],
  providers: [OrderResponsePresenter, OrderListPresenter],
})
export class AppModule {}
