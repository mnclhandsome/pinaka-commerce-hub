import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('pos_safe_drop_transactions')
@Index('pos_safe_drop_transactions_store_shift_created_idx', [
  'store_id',
  'shift_id',
  'created_at',
])
export class PosSafeDropTransactionEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'store_id', type: 'uuid' }) store_id!: string;
  @Column({ name: 'merchant_id', type: 'uuid' }) merchant_id!: string;
  @Column({ name: 'shift_id', type: 'varchar', length: 100 }) shift_id!: string;
  @Column({ type: 'varchar', length: 255 }) title!: string;
  @Column({ name: 'safe_data', type: 'jsonb' })
  safe_data!: Record<string, unknown>;
  @Column({ name: 'created_by', type: 'varchar', length: 100 })
  created_by!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;
}
