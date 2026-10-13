import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('pos_safe_drop_denominations')
@Index('pos_safe_drop_denominations_parent_idx', ['safeDropId', 'sortOrder'])
export class PosSafeDropDenominationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'safe_drop_id', type: 'uuid' })
  safeDropId!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  amount!: string;

  @Column({ name: 'image_name', type: 'varchar', length: 255 })
  imageName!: string;

  @Column({ name: 'image_data', type: 'text' })
  imageData!: string;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
