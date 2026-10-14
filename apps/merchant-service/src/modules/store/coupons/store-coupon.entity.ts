import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

export enum CouponSyncStatus { PENDING = 'PENDING', SYNCED = 'SYNCED', FAILED = 'FAILED', DELETED = 'DELETED' }

@Entity('store_coupons')
@Unique('uq_store_coupons_store_wc_id', ['storeId', 'woocommerceCouponId'])
@Unique('uq_store_coupons_store_code', ['storeId', 'code'])
export class StoreCouponEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'merchant_id', type: 'uuid' }) merchantId!: string;
  @Column({ name: 'store_id', type: 'uuid' }) storeId!: string;
  @Column({ name: 'woocommerce_coupon_id', type: 'bigint', nullable: true }) woocommerceCouponId?: string | null;
  @Column({ type: 'varchar', length: 255 }) code!: string;
  @Column({ type: 'numeric', precision: 18, scale: 6, default: 0 }) amount!: string;
  @Column({ name: 'discount_type', type: 'varchar', length: 50, default: 'fixed_cart' }) discountType!: string;
  @Column({ type: 'text', default: '' }) description!: string;
  @Column({ name: 'date_expires', type: 'timestamptz', nullable: true }) dateExpires?: Date | null;
  @Column({ name: 'individual_use', type: 'boolean', default: false }) individualUse!: boolean;
  @Column({ name: 'product_ids', type: 'jsonb', default: () => "'[]'::jsonb" }) productIds!: number[];
  @Column({ name: 'excluded_product_ids', type: 'jsonb', default: () => "'[]'::jsonb" }) excludedProductIds!: number[];
  @Column({ name: 'usage_limit', type: 'integer', nullable: true }) usageLimit?: number | null;
  @Column({ name: 'usage_limit_per_user', type: 'integer', nullable: true }) usageLimitPerUser?: number | null;
  @Column({ name: 'limit_usage_to_x_items', type: 'integer', nullable: true }) limitUsageToXItems?: number | null;
  @Column({ name: 'usage_count', type: 'integer', default: 0 }) usageCount!: number;
  @Column({ name: 'free_shipping', type: 'boolean', default: false }) freeShipping!: boolean;
  @Column({ name: 'product_categories', type: 'jsonb', default: () => "'[]'::jsonb" }) productCategories!: number[];
  @Column({ name: 'excluded_product_categories', type: 'jsonb', default: () => "'[]'::jsonb" }) excludedProductCategories!: number[];
  @Column({ name: 'exclude_sale_items', type: 'boolean', default: false }) excludeSaleItems!: boolean;
  @Column({ name: 'minimum_amount', type: 'numeric', precision: 18, scale: 6, default: 0 }) minimumAmount!: string;
  @Column({ name: 'maximum_amount', type: 'numeric', precision: 18, scale: 6, default: 0 }) maximumAmount!: string;
  @Column({ name: 'email_restrictions', type: 'jsonb', default: () => "'[]'::jsonb" }) emailRestrictions!: string[];
  @Column({ name: 'used_by', type: 'jsonb', default: () => "'[]'::jsonb" }) usedBy!: string[];
  @Column({ name: 'woocommerce_payload', type: 'jsonb', nullable: true }) woocommercePayload?: Record<string, unknown> | null;
  @Column({ name: 'woocommerce_date_created', type: 'timestamptz', nullable: true }) woocommerceDateCreated?: Date | null;
  @Column({ name: 'woocommerce_date_modified', type: 'timestamptz', nullable: true }) woocommerceDateModified?: Date | null;
  @Column({ name: 'sync_status', type: 'varchar', length: 20, default: CouponSyncStatus.PENDING }) syncStatus!: CouponSyncStatus;
  @Column({ name: 'sync_error', type: 'text', nullable: true }) syncError?: string | null;
  @Column({ name: 'sync_attempts', type: 'integer', default: 0 }) syncAttempts!: number;
  @Column({ name: 'last_sync_at', type: 'timestamptz', nullable: true }) lastSyncAt?: Date | null;
  @Column({ name: 'source', type: 'varchar', length: 20, default: 'PCH' }) source!: 'PCH' | 'WOOCOMMERCE';
  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt?: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}
