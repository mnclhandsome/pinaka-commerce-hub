import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('order_status_history')
export class OrderStatusHistoryEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  id!: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @Column({ name: 'from_status', type: 'varchar', length: 50 })
  fromStatus!: string;

  @Column({ name: 'to_status', type: 'varchar', length: 50 })
  toStatus!: string;

  @Column({ name: 'changed_by', type: 'varchar', length: 150 })
  changedBy!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
