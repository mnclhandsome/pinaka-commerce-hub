import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('pos_safe_drop_tubes')
@Index('pos_safe_drop_tubes_parent_idx', ['safeDropId', 'sortOrder'])
export class PosSafeDropTubeEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'safe_drop_id', type: 'uuid' })
  safeDropId!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  amount!: string;

  @Column({ type: 'integer' })
  quantity!: number;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
