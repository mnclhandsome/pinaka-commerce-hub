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
  @IsString()
  @Length(1, 50)
  employeeCode!: string;

  @IsString()
  @Length(4, 8)
  pin!: string;

  @IsString()
  @Length(1, 100)
  merchantId!: string;

  @IsString()
  @Length(1, 100)
  storeId!: string;
}

export class PosEmployeeAttendanceQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  merchantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  storeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  employeeCode?: string;

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsIn(['PRESENT', 'COMPLETED', 'INCOMPLETE'])
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
}
