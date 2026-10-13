import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum OrderType {
  IN_STORE_POS = 'IN_STORE_POS',
  ONLINE_DELIVERY = 'ONLINE_DELIVERY',
  ONLINE_WEB = 'ONLINE_WEB',
  DINE_IN = 'DINE_IN',
}

export enum PaymentMethod {
  CASH = 'CASH',
  CARD = 'CARD',
  UPI = 'UPI',
  STORE_CREDIT = 'STORE_CREDIT',
}

export enum PaymentStatus {
  PAID = 'PAID',
  PENDING = 'PENDING',
  REFUNDED = 'REFUNDED',
}

export enum OrderStatus {
  CREATED = 'CREATED',
  CONFIRMED = 'CONFIRMED',
  IN_PREPARATION = 'IN_PREPARATION',
  READY_FOR_DISPATCH = 'READY_FOR_DISPATCH',
  DISPATCHED = 'DISPATCHED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

@Entity('orders')
export class OrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'order_number', type: 'varchar', length: 100 })
  orderNumber!: string;

  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @Column({ name: 'store_id', type: 'uuid' })
  storeId!: string;

  @Column({ name: 'shift_id', type: 'varchar', length: 100, nullable: true })
  shiftId?: string;

  @Column({ name: 'local_shift_id', type: 'varchar', length: 100, nullable: true })
  localShiftId?: string;

  @Column({ name: 'client_order_id', type: 'varchar', length: 150, nullable: true })
  clientOrderId?: string;

  @Column({ type: 'boolean', default: false })
  offline!: boolean;

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata?: Array<{ key: string; value: unknown }>;

  @Column({ name: 'request_payload', type: 'jsonb', nullable: true })
  requestPayload?: Record<string, unknown>;

  @Column({ name: 'customer_name', type: 'varchar', length: 150, default: 'Walk-in Customer' })
  customerName!: string;

  @Column({ name: 'customer_phone', type: 'varchar', length: 50, nullable: true })
  customerPhone?: string;

  @Column({ name: 'order_type', type: 'varchar', length: 50, default: OrderType.IN_STORE_POS })
  orderType!: OrderType;

  @Column({ name: 'payment_method', type: 'varchar', length: 50, default: PaymentMethod.CASH })
  paymentMethod!: PaymentMethod;

  @Column({ name: 'payment_status', type: 'varchar', length: 50, default: PaymentStatus.PAID })
  paymentStatus!: PaymentStatus;

  @Column({ name: 'subtotal', type: 'decimal', precision: 10, scale: 2 })
  subtotal!: number;

  @Column({ name: 'tax_amount', type: 'decimal', precision: 10, scale: 2, default: 0.00 })
  taxAmount!: number;

  @Column({ name: 'discount_amount', type: 'decimal', precision: 10, scale: 2, default: 0.00 })
  discountAmount!: number;

  @Column({ name: 'tip_amount', type: 'decimal', precision: 10, scale: 2, default: 0.00 })
  tipAmount!: number;

  @Column({ name: 'total_amount', type: 'decimal', precision: 10, scale: 2 })
  totalAmount!: number;

  @Column({ name: 'order_status', type: 'varchar', length: 50, default: OrderStatus.CREATED })
  orderStatus!: OrderStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
