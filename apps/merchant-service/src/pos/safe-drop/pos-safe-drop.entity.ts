import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('pos_safe_drop_settings')
@Index('pos_safe_drop_settings_store_uq', ['storeId'], { unique: true })
export class PosSafeDropEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'store_id', type: 'varchar', length: 100 })
  storeId!: string;

  @Column({ name: 'merchant_id', type: 'varchar', length: 100 })
  merchantId!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ name: 'primary_safe', type: 'varchar', length: 100, default: '' })
  primarySafe!: string;

  @Column({ name: 'drop_enabled', type: 'boolean', default: false })
  dropEnabled!: boolean;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  threshold!: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  minimum!: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  maximum!: string | null;

  @Column({ name: 'manager_approval', type: 'boolean', default: true })
  managerApproval!: boolean;

  @Column({ name: 'cashier_initiated', type: 'boolean', default: true })
  cashierInitiated!: boolean;

  @Column({ name: 'reason_required', type: 'boolean', default: true })
  reasonRequired!: boolean;

  @Column({ name: 'tube_size', type: 'integer', nullable: true })
  tubeSize!: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
