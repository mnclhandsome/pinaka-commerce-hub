import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class SafeDenominationDto {
  @Type(() => Number) @IsNumber() @Min(0) denom!: number;
  @Type(() => Number) @IsInt() @Min(0) tube_count!: number;
  @Type(() => Number) @IsInt() @Min(0) cell_count!: number;
  @Type(() => Number) @IsNumber() @Min(0) total!: number;
}

export class CreateSafeDto {
  @IsString() shift_id!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SafeDenominationDto)
  safe_denom!: SafeDenominationDto[];
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) coins_total?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) total_amount?: number;
}

export class SafeDropDenominationDto {
  @Type(() => Number) @IsNumber() @Min(0) denom!: number;
  @Type(() => Number) @IsInt() @Min(0) denom_count!: number;
  @Type(() => Number) @IsNumber() @Min(0) total!: number;
}

export class CreateSafeDropDto {
  @IsString() shift_id!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SafeDropDenominationDto)
  safe_drop_denom!: SafeDropDenominationDto[];
  @Type(() => Number) @IsNumber() @Min(0) total_cash!: number;
  @Type(() => Number) @IsInt() @Min(0) total_notes!: number;
}

export class SafeTransactionsQueryDto {
  @IsOptional() @IsString() shift_id?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}
