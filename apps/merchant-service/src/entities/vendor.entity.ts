import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Audited, AuditColumns, RecordStatus, VendorType } from './commerce-enums';
import { StoreTypeEntity } from './store-type.entity';

export { RecordStatus as VendorStatus, VendorType } from './commerce-enums';

@Entity('vendors')
@Audited()
export class VendorEntity extends AuditColumns {
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', nullable: true, default: () => 'NULL' })
  override updatedAt!: Date;

  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'vendor_code', type: 'varchar', length: 50, unique: true })
  vendorCode!: string;

  @Column({ name: 'vendor_name', type: 'varchar', length: 150 })
  vendorName!: string;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null;

  @Column({ name: 'vendor_type', type: 'enum', enum: VendorType, enumName: 'vendor_type' })
  vendorType!: VendorType;

  @Column({ name: 'store_type_id', type: 'uuid', nullable: true })
  storeTypeId?: string | null;

  @ManyToOne(() => StoreTypeEntity, { nullable: true })
  @JoinColumn({ name: 'store_type_id' })
  storeType?: StoreTypeEntity;

  @Column({ name: 'contact_person', type: 'varchar', length: 150, nullable: true })
  contactPerson?: string | null;

  @Column({ name: 'phone', type: 'varchar', length: 30, nullable: true })
  phone?: string | null;

  @Column({ name: 'email', type: 'varchar', length: 150, nullable: true })
  email?: string | null;

  @Column({ name: 'product_category', type: 'varchar', length: 150, nullable: true })
  productCategory?: string | null;

  @Column({ name: 'address_line1', type: 'varchar', length: 255, nullable: true })
  addressLine1?: string | null;

  @Column({ name: 'address_line2', type: 'varchar', length: 255, nullable: true })
  addressLine2?: string | null;

  @Column({ name: 'city', type: 'varchar', length: 100, nullable: true })
  city?: string | null;

  @Column({ name: 'state', type: 'varchar', length: 50, nullable: true })
  state?: string | null;

  @Column({ name: 'zip_code', type: 'varchar', length: 20, nullable: true })
  zipCode?: string | null;

  @Column({ name: 'country', type: 'varchar', length: 100, nullable: true })
  country?: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: RecordStatus,
    enumName: 'record_status',
    default: RecordStatus.ACTIVE,
  })
  status!: RecordStatus;
}
