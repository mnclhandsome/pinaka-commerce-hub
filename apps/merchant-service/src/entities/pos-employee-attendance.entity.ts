import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MerchantEntity } from './merchant.entity';
import { StoreEntity } from './store.entity';
import { EmployeeEntity } from './employee.entity';

@Entity('pos_employee_attendance')
@Index('pos_employee_attendance_store_clock_in_idx', ['merchantId', 'storeId', 'clockIn'])
@Index('pos_employee_attendance_employee_clock_in_idx', ['employeeId', 'clockIn'])
export class PosEmployeeAttendanceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** References merchants.id */
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity)
  @JoinColumn({ name: 'merchant_id', referencedColumnName: 'id' })
  merchant?: MerchantEntity;

  /** References stores.id */
  @Column({ name: 'store_id', type: 'uuid' })
  storeId!: string;

  @ManyToOne(() => StoreEntity)
  @JoinColumn({ name: 'store_id', referencedColumnName: 'id' })
  store?: StoreEntity;

  /** References employees.id */
  @Column({ name: 'employee_id', type: 'uuid' })
  employeeId!: string;

  @ManyToOne(() => EmployeeEntity)
  @JoinColumn({ name: 'employee_id', referencedColumnName: 'id' })
  employee?: EmployeeEntity;

  @Column({ name: 'employee_code', type: 'varchar', length: 50 })
  employeeCode!: string;

  @Column({ name: 'employee_name', type: 'varchar', length: 201 })
  employeeName!: string;

  @CreateDateColumn({ name: 'clock_in', type: 'timestamptz' })
  clockIn!: Date;

  @Column({ name: 'clock_out', type: 'timestamptz', nullable: true })
  clockOut?: Date | null;

  @Column({ name: 'status', type: 'varchar', length: 20, default: 'PRESENT' })
  status!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
