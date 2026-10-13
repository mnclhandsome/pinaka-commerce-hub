import { EmployeeValidationPipe, EmployeeResponseInterceptor } from './workforce-validation.pipe';
import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, Patch, Post, Put, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { RelationshipOwnerGuard, RelationshipRequest, relationshipUserId } from '../shared/relationships.controller';
import { MerchantRepository } from '../merchant/merchant.repository';
import { CreateEmployeeDto, UpdateEmployeeDto } from './employee.dto';

const employeeImageDirectory = join(process.cwd(), 'uploads', 'employees');
mkdirSync(employeeImageDirectory, { recursive: true });
const { memoryStorage } = require('multer');
const employeeImageUpload = FileInterceptor('image', {
  storage: memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_request: unknown, file: { mimetype: string }, callback: (error: Error | null, accept: boolean) => void) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    callback(allowed ? null : new BadRequestException('Profile image must be JPG, PNG, or WebP'), allowed);
  },
});

type UploadedEmployeeImage = { buffer: Buffer; mimetype: string };

@UseInterceptors(EmployeeResponseInterceptor)
@UseGuards(RelationshipOwnerGuard)
@Controller(['api/v1/merchants/employees', 'api/v1/employees', 'connector/api/v1/employees'])
export class EmployeeController {
  constructor(@Inject(MerchantRepository) private readonly repository: MerchantRepository) {}

  @Get()
  async list(@Query('status') status?: string) {
    const employees = await this.repository.listEmployees(undefined, status);
    const statistics = await this.repository.employeeStatistics(undefined);
    return { success: true, count: employees.length, statistics, employees };
  }

  @Get(':idOrCode')
  async get(@Param('idOrCode') idOrCode: string) {
    const employee = await this.repository.getEmployeeDetails(undefined, idOrCode);
    if (!employee) throw new NotFoundException(`Employee '${idOrCode}' not found`);
    return { success: true, employee };
  }

  @Post()
  @UseInterceptors(employeeImageUpload)
  async create(@Body(new EmployeeValidationPipe({ expectedType: CreateEmployeeDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: CreateEmployeeDto | Record<string, any>, @Req() request: RelationshipRequest, @UploadedFile() file?: UploadedEmployeeImage) {
    let imageUrl: string | undefined;
    let saved = false;
    try {
      if (!body.merchantId) throw new BadRequestException('merchantId is required');
      const merchantUuid = await this.requireMerchantId(body.merchantId);
      body.merchantId = merchantUuid;
      body.createdBy = relationshipUserId(request);
      if (file) { imageUrl = await this.saveImage(file); body.profileImageUrl = imageUrl; }
      const created = await this.repository.createEmployee(body as CreateEmployeeDto);
      saved = true;
      const employee = await this.repository.getEmployeeDetails(merchantUuid, created.id);
      return { success: true, message: 'Employee workforce record created successfully', employee };
    } catch (error) {
      if (!saved && imageUrl) await this.removeLocalImage(imageUrl);
      throw error;
    }
  }

  @Put(':idOrCode')
  @UseInterceptors(employeeImageUpload)
  async update(@Param('idOrCode') idOrCode: string, @Body(new EmployeeValidationPipe({ expectedType: UpdateEmployeeDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: UpdateEmployeeDto | Record<string, any>, @Req() request: RelationshipRequest, @UploadedFile() file?: UploadedEmployeeImage) {
    let imageUrl: string | undefined;
    let saved = false;
    try {

      body.updatedBy = relationshipUserId(request);
      const current = await this.repository.getEmployeeDetails(undefined, idOrCode);
      if (!current) throw new NotFoundException(`Employee '${idOrCode}' not found`);
      if (file) { imageUrl = await this.saveImage(file); body.profileImageUrl = imageUrl; }
      const updated = await this.repository.updateEmployee(undefined, idOrCode, body as UpdateEmployeeDto);
      if (!updated) throw new NotFoundException(`Employee '${idOrCode}' not found`);
      saved = true;
      if (body.profileImageUrl !== undefined && body.profileImageUrl !== current.profileImageUrl) await this.removeLocalImage(current.profileImageUrl);
      const employee = await this.repository.getEmployeeDetails(updated.merchantId, updated.id);
      return { success: true, message: 'Employee record updated successfully', employee };
    } catch (error) {
      if (!saved && imageUrl) await this.removeLocalImage(imageUrl);
      throw error;
    }
  }

  @Patch(':idOrCode')
  @UseInterceptors(employeeImageUpload)
  patch(@Param('idOrCode') idOrCode: string, @Body(new EmployeeValidationPipe({ expectedType: UpdateEmployeeDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: UpdateEmployeeDto | Record<string, any>, @Req() request: RelationshipRequest, @UploadedFile() file?: UploadedEmployeeImage) {
    return this.update(idOrCode, body, request, file);
  }

  private async saveImage(file: UploadedEmployeeImage): Promise<string> {
    const extension = file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg';
    const filename = `${randomUUID()}${extension}`;
    await writeFile(join(employeeImageDirectory, filename), file.buffer);
    return `/uploads/employees/${filename}`;
  }

  @Delete(':idOrCode')
  async delete(@Param('idOrCode') idOrCode: string, @Req() request: RelationshipRequest) {
    const deleted = await this.repository.deleteEmployee(undefined, idOrCode, relationshipUserId(request));
    if (!deleted) throw new NotFoundException(`Employee '${idOrCode}' not found`);
    return { success: true, message: 'Employee record soft-deleted successfully' };
  }

  private async requireMerchantId(identifier: string): Promise<string> {
    const id = await this.repository.resolveMerchantUuid(identifier);
    if (!id) throw new NotFoundException(`Merchant '${identifier}' not found`);
    return id;
  }

  private async removeLocalImage(value: unknown): Promise<void> {
    if (typeof value !== 'string' || !value.startsWith('/uploads/employees/')) return;
    await unlink(join(employeeImageDirectory, basename(value))).catch(() => undefined);
  }
}
