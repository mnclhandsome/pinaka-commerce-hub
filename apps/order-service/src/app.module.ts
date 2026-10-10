import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { OrderRepository } from './order.repository';
import { OrderResponsePresenter } from './responses/order-response.presenter';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [OrderRepository, OrderResponsePresenter],
})
export class AppModule {}
