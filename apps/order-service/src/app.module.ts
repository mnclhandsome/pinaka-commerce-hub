import { RefundValidUserController } from './refund-valid-user.controller';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { OrderUpdatesModule } from './modules/order-updates/order-updates.module';
import { OrderPersistenceModule } from './order-persistence.module';
import { OrderListPresenter } from './responses/order-list.presenter';
import { OrderResponsePresenter } from './responses/order-response.presenter';
import { StorePosPaymentsController } from './store-pos-payments.controller';
import { CompletedOrdersController } from './completed-orders.controller';
import { CompletedOrderPresenter } from './responses/completed-order.presenter';
import { RefundAmountController } from './refund-amount.controller';
import { RefundAmountService } from './refund-amount.service';
import { FullOrderRefundController } from './full-order-refund.controller';
import { FullOrderRefundService } from './full-order-refund.service';
import { PartialOrderRefundController } from './partial-order-refund.controller';
import { PartialOrderRefundService } from './partial-order-refund.service';

@Module({
  imports: [OrderPersistenceModule, OrderUpdatesModule],
  // Register fixed order paths before AppController's dynamic GET /:id route.
  controllers: [CompletedOrdersController, RefundValidUserController, RefundAmountController, FullOrderRefundController, PartialOrderRefundController, AppController, StorePosPaymentsController],
  providers: [OrderResponsePresenter, OrderListPresenter, CompletedOrderPresenter, RefundAmountService, FullOrderRefundService, PartialOrderRefundService],
})
export class AppModule {}
