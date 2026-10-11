import type { AddedLineInput, OrderLine } from '../../calculations/order-update.calculations';
import type { TaxCalculationMode, PosFeeLine, PosTaxLine, StoreOrderTotals } from '../../calculations/store-order.calculations';
import type { OrderEntity, OrderStatus } from '../../entities/order.entity';
import type { OrderItemEntity } from '../../entities/order-item.entity';
import type { StoreOrderEntity } from '../../entities/store-order.entity';

export interface OrderGraph {
  order: OrderEntity;
  items: OrderItemEntity[];
  storeOrder: StoreOrderEntity | null;
}

export interface TaxCommand {
  rate: number;
  pricesIncludeTax?: boolean;
  calculation?: TaxCalculationMode;
  label?: string;
}

export interface CouponCommand {
  code: string;
  discountType: 'percent' | 'fixed_cart' | 'fixed_product';
  amount: number;
  productIds: string[];
  includeFees?: boolean;
  tax?: TaxCommand;
  reason?: string;
}

export interface DiscountCommand {
  type: 'fixed' | 'percent';
  amount: number;
  reason?: string;
  includeFees?: boolean;
  tax?: TaxCommand;
}

export interface AddItemsCommand {
  items: AddedLineInput[];
  includeFees?: boolean;
  tax?: TaxCommand;
}

export interface CancelOrderCommand {
  changedBy: string;
  reason: string;
}

export type OrderUpdateAction = 'coupon_applied' | 'discount_applied' | 'items_added' | 'cancelled';

export interface OrderMutationDraft {
  lineItems?: OrderLine[];
  couponLines?: unknown[];
  feeLines?: PosFeeLine[];
  taxLines?: PosTaxLine[];
  totals?: StoreOrderTotals;
  orderStatus?: OrderStatus;
  storeStatus?: string;
  replaceItems?: boolean;
  appliedDiscount?: number;
  history?: { changedBy: string; reason: string };
}
