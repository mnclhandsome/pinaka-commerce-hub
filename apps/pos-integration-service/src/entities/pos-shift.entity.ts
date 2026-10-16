import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum ShiftStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

export interface DrawerDenomination {
  denomination: number;
  denom_count: number;
}

export interface TubeDenomination {
  denomination: number;
  tube_count: number;
  cell_count: number;
  total: number;
}

export interface ShiftDenominationData {
  drawer_denominations?: DrawerDenomination[];
  drawer_total_amount?: number;
  tube_denominations?: TubeDenomination[];
  tube_total_amount?: number;
  total_amount?: number;
}

export interface ShiftCloseData {
  closed_by_device_id?: string;
  total_orders?: number;
  total_order_sale_amount?: number;
  total_cashback?: number;
  total_payouts?: number;
  total_ebt_sales?: number;
  total_pay_later?: number;
  total_refunds?: number;
  total_cancelled_orders?: number;
  total_void_items?: number;
}

@Entity('pos_shifts')
export class PosShiftEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  id!: string; // e.g. "SHIFT-8001"

  @Column({ name: 'merchant_id', type: 'varchar', length: 100 })
  merchantId!: string;

  @Column({ name: 'store_id', type: 'varchar', length: 100 })
  storeId!: string;

  @Column({ name: 'register_id', type: 'uuid', nullable: true })
  registerId?: string;

  @Column({ name: 'device_id', type: 'varchar', length: 100 })
  terminalId!: string; // Sunmi Serial # / Device ID

  @Column({ name: 'opening_device_id', type: 'uuid', nullable: true })
  openingDeviceId?: string;

  @Column({ name: 'opened_by_employee_id', type: 'uuid', nullable: true })
  openedByEmployeeId?: string;

  @Column({ name: 'closed_by_employee_id', type: 'uuid', nullable: true })
  closedByEmployeeId?: string;

  @Column({ name: 'closed_by_device_id', type: 'varchar', length: 100, nullable: true })
  closed_by_device_id?: string;

  @Column({ name: 'shift_number', type: 'varchar', length: 100, nullable: true })
  shiftNumber?: string;

  @Column({ name: 'cashier_name', type: 'varchar', length: 150 })
  cashierName!: string;

  @Column({ name: 'opening_cash', type: 'decimal', precision: 10, scale: 2, default: 200.00 })
  openingCash!: number; // Starting Cash Float

  @Column({ name: 'total_cash_sales', type: 'decimal', precision: 10, scale: 2, default: 0.00 })
  totalCashSales!: number;

  @Column({ name: 'total_card_sales', type: 'decimal', precision: 10, scale: 2, default: 0.00 })
  totalCardSales!: number;

  @Column({ name: 'total_safe_drops', type: 'decimal', precision: 10, scale: 2, default: 0.00 })
  totalSafeDrops!: number;

  @Column({ name: 'total_paid_outs', type: 'decimal', precision: 10, scale: 2, default: 0.00 })
  totalPaidOuts!: number;

  @Column({ name: 'total_orders', type: 'integer', default: 0 })
  total_orders!: number;

  @Column({ name: 'total_order_sale_amount', type: 'decimal', precision: 12, scale: 2, default: 0.00 })
  total_order_sale_amount!: number;

  @Column({ name: 'total_cashback', type: 'decimal', precision: 10, scale: 2, default: 0.00 })
  total_cashback!: number;

  @Column({ name: 'total_payouts', type: 'decimal', precision: 10, scale: 2, default: 0.00 })
  total_payouts!: number;

  @Column({ name: 'total_ebt_sales', type: 'decimal', precision: 10, scale: 2, default: 0.00 })
  total_ebt_sales!: number; // Paid by EBT

  @Column({ name: 'total_pay_later', type: 'decimal', precision: 10, scale: 2, default: 0.00 })
  total_pay_later!: number;

  @Column({ name: 'total_refunds', type: 'decimal', precision: 10, scale: 2, default: 0.00 })
  total_refunds!: number;

  @Column({ name: 'total_cancelled_orders', type: 'integer', default: 0 })
  total_cancelled_orders!: number;

  @Column({ name: 'total_void_items', type: 'integer', default: 0 })
  total_void_items!: number;

  @Column({ name: 'drawer_denominations', type: 'jsonb', nullable: true })
  drawer_denominations?: DrawerDenomination[];

  @Column({ name: 'drawer_total_amount', type: 'decimal', precision: 12, scale: 2, nullable: true })
  drawer_total_amount?: number;

  @Column({ name: 'tube_denominations', type: 'jsonb', nullable: true })
  tube_denominations?: TubeDenomination[];

  @Column({ name: 'tube_total_amount', type: 'decimal', precision: 12, scale: 2, nullable: true })
  tube_total_amount?: number;

  @Column({ name: 'total_amount', type: 'decimal', precision: 12, scale: 2, nullable: true })
  total_amount?: number;

  @Column({ name: 'closing_cash_actual', type: 'decimal', precision: 10, scale: 2, nullable: true })
  closingCashActual?: number;

  @Column({ name: 'expected_cash_in_drawer', type: 'decimal', precision: 10, scale: 2, nullable: true })
  expectedCashInDrawer?: number;

  @Column({ name: 'declared_cash', type: 'decimal', precision: 10, scale: 2, nullable: true })
  declaredCash?: number;

  @Column({ name: 'cash_difference', type: 'decimal', precision: 10, scale: 2, nullable: true })
  cashDifference?: number;

  @Column({ name: 'discrepancy', type: 'decimal', precision: 10, scale: 2, nullable: true })
  discrepancy?: number; // Over / Short

  @Column({ name: 'opening_note', type: 'text', nullable: true })
  openingNote?: string;

  @Column({ name: 'closing_note', type: 'text', nullable: true })
  closingNote?: string;

  @Column({ name: 'status', type: 'varchar', length: 50, default: ShiftStatus.OPEN })
  status!: ShiftStatus;

  @Column({ name: 'opened_at', type: 'timestamptz' })
  openedAt!: Date;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
