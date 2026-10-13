import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class StoreHoursDto {
  @IsIn(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']) day!: string;
  @IsIn(['', 'Open', 'Closed', '24 hours']) status!: string;
  @IsOptional() @Matches(/^$|^([01]\d|2[0-3]):[0-5]\d$/) open?: string;
  @IsOptional() @Matches(/^$|^([01]\d|2[0-3]):[0-5]\d$/) close?: string;
  @IsOptional() @Transform(({ value }) => value === '' || value === null || value === undefined ? 0 : Number(value)) @IsInt() @Min(0) @Max(100) shifts?: number;
}

export class StoreEmployeeAssignmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  employee_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  employeeId?: string;

  @IsOptional()
  @IsUUID()
  role_template_id?: string;

  @IsOptional()
  @IsUUID()
  roleTemplateId?: string;

  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'login_pin must be a 6-digit string' })
  login_pin?: string;

  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'loginPin must be a 6-digit string' })
  loginPin?: string;
}

// Setup selections are stored separately from effective permissions/entitlements.
export class StoreSetupDto {
  @IsOptional() @IsString() @MaxLength(100) country?: string;
  @IsOptional() @IsString() @MaxLength(2800000) logo?: string;
  @IsOptional() @IsString() @MaxLength(100) defaultLanguage?: string;
  @IsOptional() @IsString() @MaxLength(100) taxRegion?: string;
  @IsOptional() @IsBoolean() licensed?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => StoreHoursDto) hours?: StoreHoursDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsObject({ each: true }) devices?: Record<string, unknown>[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @MaxLength(100, { each: true }) features?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsObject({ each: true }) roles?: Record<string, unknown>[];
  /** Wizard matrix: { roleTemplateId, name, permissions: { [feature]: { View, Create, Edit, Delete } } } */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsObject({ each: true }) rolePermissions?: Record<string, unknown>[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => StoreEmployeeAssignmentDto)
  employees?: StoreEmployeeAssignmentDto[];
}

export class SaveStoreEmployeesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => StoreEmployeeAssignmentDto)
  employees: StoreEmployeeAssignmentDto[] = [];
}

export class AssignStoreEmployeeLoginPinDto {
  @Matches(/^\d{6}$/, { message: 'loginPin must be a 6-digit string' })
  loginPin!: string;
}

export class UpdateStoreEmployeeAssignmentDto {
  @IsOptional()
  @IsUUID()
  role_template_id?: string;

  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'login_pin must be a 6-digit string' })
  login_pin?: string;
}
