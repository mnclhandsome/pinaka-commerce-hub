import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

export enum AdjustmentType {
  POS_SALE = 'POS_SALE',
  ONLINE_SALE = 'ONLINE_SALE',
  REPLENISHMENT = 'REPLENISHMENT',
  REFUND_RESTOCK = 'REFUND_RESTOCK',
  DAMAGE = 'DAMAGE',
  TRANSFER = 'TRANSFER',
  MANUAL_CORRECT = 'MANUAL_CORRECT',
}

@Entity('inventory_adjustments')
export class InventoryAdjustmentEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  id!: string;

  @Column({ type: 'varchar', length: 100, default: 'UNKNOWN' })
  storeId!: string;

  @Column({ type: 'varchar', length: 100, default: '' })
  productId!: string;

  @Column({ type: 'varchar', length: 50, default: AdjustmentType.POS_SALE })
  adjustmentType!: AdjustmentType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  quantityChanged!: number; // -1.00 for sale, +50.00 for restock

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  newQuantityAvailable!: number;

  @Column({ type: 'varchar', length: 255 })
  performedBy!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason?: string;

  @CreateDateColumn()
  createdAt!: Date;
}
