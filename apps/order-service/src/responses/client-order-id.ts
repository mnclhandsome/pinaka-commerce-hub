import type { OrderEntity } from '../entities/order.entity';
import type { StoreOrderEntity } from '../entities/store-order.entity';

export function clientOrderIdValue(
  order: OrderEntity,
  storeOrder?: StoreOrderEntity | null,
): string | number | null {
  const request = (order.requestPayload || {}) as { meta_data?: Array<{ key?: string; value?: unknown }> };
  const metadata = Array.isArray(order.metadata) ? order.metadata : [];
  const fromMetadata = metadata.find((entry) => entry?.key === '_pos_client_order_id')?.value;
  const fromPayload = Array.isArray(request.meta_data)
    ? request.meta_data.find((entry) => entry?.key === '_pos_client_order_id')?.value
    : undefined;
  const raw = storeOrder?.clientOrderId || order.clientOrderId || fromMetadata || fromPayload;
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (/^\d+$/.test(value) && !value.startsWith('0') && Number.isSafeInteger(Number(value))) {
    return Number(value);
  }
  return value;
}
