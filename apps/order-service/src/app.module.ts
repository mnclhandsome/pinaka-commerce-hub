import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { OrderUpdatesModule } from './modules/order-updates/order-updates.module';
import { OrderPersistenceModule } from './order-persistence.module';
import { OrderListPresenter } from './responses/order-list.presenter';
import { OrderResponsePresenter } from './responses/order-response.presenter';

@Module({
  imports: [OrderPersistenceModule, OrderUpdatesModule],
  controllers: [AppController],
  providers: [OrderResponsePresenter, OrderListPresenter],
})
export class AppModule {}
