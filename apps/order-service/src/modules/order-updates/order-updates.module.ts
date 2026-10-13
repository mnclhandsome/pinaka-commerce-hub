import { Module } from '@nestjs/common';
import { OrderPersistenceModule } from '../../order-persistence.module';
import { OrderResponsePresenter } from '../../responses/order-response.presenter';
import { OrderUpdatePresenter } from './order-update.presenter';
import { OrderUpdatesController } from './order-updates.controller';
import { OrderCancellationService } from './services/order-cancellation.service';
import { OrderCouponCatalog } from './services/order-coupon.catalog';
import { OrderCouponService } from './services/order-coupon.service';
import { OrderDiscountService } from './services/order-discount.service';
import { OrderItemService } from './services/order-item.service';
import { OrderLineMapper } from './services/order-line.mapper';
import { OrderTotalsService } from './services/order-totals.service';
import { OrderUpdatePolicy } from './services/order-update.policy';
import { OrderUpdateService } from './services/order-update.service';

@Module({
  imports: [OrderPersistenceModule],
  controllers: [OrderUpdatesController],
  providers: [
    OrderUpdatePolicy,
    OrderLineMapper,
    OrderTotalsService,
    OrderCouponCatalog,
    OrderCouponService,
    OrderDiscountService,
    OrderItemService,
    OrderCancellationService,
    OrderUpdateService,
    OrderResponsePresenter,
    OrderUpdatePresenter,
  ],
  exports: [OrderUpdatePresenter],
})
export class OrderUpdatesModule {}
