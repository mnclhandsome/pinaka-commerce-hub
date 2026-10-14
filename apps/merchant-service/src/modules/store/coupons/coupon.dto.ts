import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CouponInputDto {
  @IsUUID() merchantId!: string;
  @IsUUID() storeId!: string;
  @IsString() @IsNotEmpty() @MaxLength(255) code!: string;
  @IsNumberString() amount!: string;
  @IsIn(['percent', 'fixed_cart', 'fixed_product']) discountType!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() dateExpires?: string | null;
  @IsOptional() @IsBoolean() individualUse?: boolean;
  @IsOptional() @IsArray() productIds?: number[];
  @IsOptional() @IsArray() excludedProductIds?: number[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) usageLimit?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) usageLimitPerUser?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) limitUsageToXItems?: number | null;
  @IsOptional() @IsBoolean() freeShipping?: boolean;
  @IsOptional() @IsArray() productCategories?: number[];
  @IsOptional() @IsArray() excludedProductCategories?: number[];
  @IsOptional() @IsBoolean() excludeSaleItems?: boolean;
  @IsOptional() @IsNumberString() minimumAmount?: string;
  @IsOptional() @IsNumberString() maximumAmount?: string;
  @IsOptional() @IsArray() emailRestrictions?: string[];
  @IsOptional() @IsArray() requiredProductIds?: number[];
}

export class CouponSyncDto {
  @IsUUID() storeId!: string;
  @IsOptional() @IsUUID() merchantId?: string;
}
