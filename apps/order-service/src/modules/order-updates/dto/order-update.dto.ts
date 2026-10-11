import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class TaxOverrideDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  rate!: number;

  @IsOptional()
  @IsBoolean()
  prices_include_tax?: boolean;

  @IsOptional()
  @IsBoolean()
  pricesIncludeTax?: boolean;

  @IsOptional()
  @IsIn(['item-price', 'subtotal', 'total'])
  calculation?: 'item-price' | 'subtotal' | 'total';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

export class ApplyCouponDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;

  @ValidateIf((dto: ApplyCouponDto) => dto.discount_type !== undefined)
  @IsIn(['percent', 'fixed_cart', 'fixed_product'])
  discount_type?: 'percent' | 'fixed_cart' | 'fixed_product';

  @ValidateIf((dto: ApplyCouponDto) => dto.discountType !== undefined)
  @IsIn(['percent', 'fixed_cart', 'fixed_product'])
  discountType?: 'percent' | 'fixed_cart' | 'fixed_product';

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  amount!: number;

  @IsOptional()
  @IsArray()
  product_ids?: Array<string | number>;

  @IsOptional()
  @IsArray()
  productIds?: Array<string | number>;

  @IsOptional()
  @IsBoolean()
  include_fees?: boolean;

  @IsOptional()
  @IsBoolean()
  includeFees?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => TaxOverrideDto)
  tax?: TaxOverrideDto;
}

export class ApplyDiscountDto {
  @ValidateIf((dto: ApplyDiscountDto) => dto.type !== undefined)
  @IsIn(['fixed', 'percent', 'fixed_cart'])
  type?: 'fixed' | 'percent' | 'fixed_cart';

  @ValidateIf((dto: ApplyDiscountDto) => dto.discount_type !== undefined)
  @IsIn(['fixed', 'percent', 'fixed_cart'])
  discount_type?: 'fixed' | 'percent' | 'fixed_cart';

  @ValidateIf((dto: ApplyDiscountDto) => dto.discountType !== undefined)
  @IsIn(['fixed', 'percent', 'fixed_cart'])
  discountType?: 'fixed' | 'percent' | 'fixed_cart';

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reason?: string;

  @IsOptional()
  @IsBoolean()
  include_fees?: boolean;

  @IsOptional()
  @IsBoolean()
  includeFees?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => TaxOverrideDto)
  tax?: TaxOverrideDto;
}

export class AddOrderLineDto {
  @IsOptional()
  product_id?: string | number;

  @IsOptional()
  productId?: string | number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  productName?: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  quantity!: number;

  @Type(() => Number)
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  unit_price?: number;

  @Type(() => Number)
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  unitPrice?: number;

  @Type(() => Number)
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  price?: number;

  @Type(() => Number)
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  subtotal?: number;

  @Type(() => Number)
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  total?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @IsOptional()
  variation_id?: string | number;

  @IsOptional()
  @IsArray()
  meta_data?: Array<{ key?: string; value?: unknown }>;

  @IsOptional()
  @IsObject()
  product_data?: Record<string, unknown>;
}

export class AddOrderItemsDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AddOrderLineDto)
  line_items?: AddOrderLineDto[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AddOrderLineDto)
  lineItems?: AddOrderLineDto[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AddOrderLineDto)
  items?: AddOrderLineDto[];

  @IsOptional()
  @IsBoolean()
  include_fees?: boolean;

  @IsOptional()
  @IsBoolean()
  includeFees?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => TaxOverrideDto)
  tax?: TaxOverrideDto;
}

export class UpdateOrderCouponLineDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;
}

export class UpdateOrderDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateOrderCouponLineDto)
  coupon_lines?: UpdateOrderCouponLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;
}

export class CancelOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  changed_by?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  changedBy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
