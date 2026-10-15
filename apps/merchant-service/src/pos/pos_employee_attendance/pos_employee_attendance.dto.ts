import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class PosEmployeeAttendanceClockDto {
  @IsOptional()
  @IsString()
  @Length(1, 50)
  employeeCode?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  employee_code?: string;

  @IsString()
  @Length(4, 8)
  pin!: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  merchantId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  merchant_id?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  storeId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  store_id?: string;

  get resolvedEmployeeCode(): string {
    return (this.employeeCode || this.employee_code || '').trim();
  }

  get resolvedMerchantId(): string {
    return (this.merchantId || this.merchant_id || '').trim();
  }

  get resolvedStoreId(): string {
    return (this.storeId || this.store_id || '').trim();
  }
}

export class PosEmployeeAttendanceQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  merchantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  merchant_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  storeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  store_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  employeeCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  employee_code?: string;

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsIn(['PRESENT', 'CLOCK_OUT', 'INCOMPLETE'])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  get resolvedMerchantId(): string | undefined {
    return this.merchantId || this.merchant_id;
  }

  get resolvedStoreId(): string | undefined {
    return this.storeId || this.store_id;
  }

  get resolvedEmployeeCode(): string | undefined {
    return this.employeeCode || this.employee_code;
  }
}
