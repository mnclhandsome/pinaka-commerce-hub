import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('subscription_plans')
export class SubscriptionPlanEntity {
  @PrimaryColumn({ name: 'plan_code', type: 'varchar', length: 50 }) planCode!: string;
  @Column({ type: 'varchar', length: 100 }) planName!: string;
  @Column({ type: 'text', default: '' }) description!: string;
  @Column({ type: 'integer' }) maxStoresAllowed!: number;
  @Column({ type: 'jsonb' }) entitlements!: string[];
  @Column({ type: 'varchar', length: 20 }) billingCycle!: 'MONTHLY' | 'ANNUAL' | 'FREE_TRIAL';
  @Column({ type: 'integer', default: 0 }) trialDays!: number;
  @Column({ type: 'numeric', precision: 10, scale: 2 }) price!: number;
  @Column({ type: 'varchar', length: 3 }) currency!: string;
  @Column({ type: 'varchar', length: 20, default: 'ACTIVE' }) status!: 'ACTIVE' | 'INACTIVE';
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
