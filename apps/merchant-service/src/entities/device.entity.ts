import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Audited, AuditColumns, RecordStatus } from './commerce-enums';
import { MerchantEntity } from './merchant.entity';

@Entity('devices')
@Audited()
export class DeviceEntity extends AuditColumns {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'device_code', type: 'varchar', length: 100, unique: true })
  deviceCode!: string;

  @Column({ name: 'device_id', type: 'text', nullable: true })
  deviceId?: string | null;

  @Column({ name: 'device_active_code', type: 'varchar', length: 100, nullable: true })
  deviceActiveCode?: string | null;

  @Column({ name: 'authorization_code', type: 'varchar', length: 100, nullable: true })
  authorizationCode?: string | null;

  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity)
  @JoinColumn({ name: 'merchant_id', referencedColumnName: 'id' })
  merchant?: MerchantEntity;

  @Column({ name: 'merchant_name', type: 'varchar', length: 255 })
  merchantName!: string;

  @Column({ name: 'serial_number', type: 'varchar', length: 100, nullable: true })
  serialNumber?: string | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes?: string | null;

  @Column({ name: 'device_name', type: 'varchar', length: 255 })
  deviceName!: string;

  @Column({ name: 'device_type', type: 'varchar', length: 100 })
  deviceType!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: RecordStatus,
    enumName: 'record_status',
    default: RecordStatus.ACTIVE,
  })
  status!: RecordStatus;
}
