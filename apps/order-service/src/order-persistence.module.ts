import { Module } from '@nestjs/common';
import { OrderRepository } from './order.repository';

@Module({
  providers: [OrderRepository],
  exports: [OrderRepository],
})
export class OrderPersistenceModule {}
