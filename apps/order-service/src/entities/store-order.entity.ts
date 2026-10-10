import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('store_orders')
export class StoreOrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @Column({ name: 'store_id', type: 'uuid' })
  storeId!: string;

  @Column({ name: 'client_order_id', type: 'varchar', length: 150, nullable: true })
  clientOrderId?: string;

  @Column({ name: 'device_id', type: 'varchar', length: 150, nullable: true })
  deviceId?: string;

  @Column({ name: 'placed_by', type: 'varchar', length: 100, nullable: true })
  placedBy?: string;

  @Column({ name: 'shift_id', type: 'varchar', length: 100, nullable: true })
  shiftId?: string;

  @Column({ type: 'varchar', length: 10, default: 'USD' })
  currency!: string;

  @Column({ type: 'varchar', length: 100, default: 'UTC' })
  timezone!: string;

  @Column({ name: 'payment_method', type: 'varchar', length: 50, nullable: true })
  paymentMethod?: string;

  @Column({ name: 'payment_method_title', type: 'varchar', length: 150, nullable: true })
  paymentMethodTitle?: string;

  @Column({ name: 'set_paid', type: 'boolean', default: false })
  setPaid!: boolean;

  @Column({ type: 'varchar', length: 50, default: 'processing' })
  status!: string;

  @Column({ name: 'pay_later', type: 'boolean', default: false })
  payLater!: boolean;

  @Column({ name: 'pay_later_user_id', type: 'varchar', length: 100, nullable: true })
  payLaterUserId?: string;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  subtotal!: number;

  @Column({ name: 'discount_total', type: 'decimal', precision: 12, scale: 2, default: 0 })
  discountTotal!: number;

  @Column({ name: 'fee_total', type: 'decimal', precision: 12, scale: 2, default: 0 })
  feeTotal!: number;

  @Column({ name: 'tax_total', type: 'decimal', precision: 12, scale: 2, default: 0 })
  taxTotal!: number;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  total!: number;

  @Column({ name: 'line_items', type: 'jsonb', default: () => "'[]'" })
  lineItems!: unknown[];

  @Column({ name: 'fee_lines', type: 'jsonb', default: () => "'[]'" })
  feeLines!: unknown[];

  @Column({ name: 'coupon_lines', type: 'jsonb', default: () => "'[]'" })
  couponLines!: unknown[];

  @Column({ name: 'tax_lines', type: 'jsonb', default: () => "'[]'" })
  taxLines!: unknown[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  payments!: unknown[];

  @Column({ name: 'meta_data', type: 'jsonb', default: () => "'[]'" })
  metaData!: unknown[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
