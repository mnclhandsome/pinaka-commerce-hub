import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateFastkeyDto {
  @IsOptional()
  @IsString()
  fastkey_title?: string;

  @IsOptional()
  @IsString()
  fastkey_index?: string;

  @IsOptional()
  @IsString()
  fastkey_image?: string;
}

export class UpdateFastkeyDto {
  @IsOptional()
  @IsString()
  @IsUUID()
  fastkey_id?: string;

  @IsOptional()
  @IsString()
  fastkey_title?: string;

  @IsOptional()
  @IsString()
  fastkey_index?: string;

  @IsOptional()
  @IsString()
  fastkey_image?: string;
}

export class FastkeyProductDto {
  @IsString()
  product_id!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  sl_number!: number;
}

export class AddFastkeyProductsDto {
  @IsOptional()
  @IsString()
  @IsUUID()
  fastkey_id?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FastkeyProductDto)
  products?: FastkeyProductDto[];
}

export class DeleteFastkeyProductDto {
  @IsOptional()
  @IsString()
  @IsUUID()
  fastkey_id?: string;

  @IsOptional()
  @IsString()
  product_id?: string;
}
