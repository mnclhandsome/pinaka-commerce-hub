import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Disk layout for merchant files.
 *
 *   uploads/{MerchantName}/{StoreName}/
 *
 * "Fresh Mart" + store "Main Street" becomes uploads/FreshMart/MainStreet.
 * Nest serves that directory at /uploads/ (see main.ts).
 */
@Injectable()
export class FileStorageService implements OnModuleInit {
  private readonly logger = new Logger(FileStorageService.name);
  readonly root =
    process.env.MERCHANT_UPLOAD_ROOT?.trim() || join(process.cwd(), 'uploads');

  async onModuleInit(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    this.logger.log(`Merchant file root: ${this.root}`);
  }

  folderName(value: string): string {
    const cleaned = String(value ?? '')
      .replace(/\s+/g, '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/^\.+/, '');
    if (!cleaned || cleaned === '.' || cleaned === '..') {
      throw new BadRequestException('A folder name is required');
    }
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)
      ? `${cleaned}_`
      : cleaned;
  }

  async ensureMerchantFolder(merchantName: string): Promise<string> {
    const path = join(this.root, this.folderName(merchantName));
    await mkdir(path, { recursive: true });
    this.logger.log(`Merchant folder ready: ${path}`);
    return path;
  }

  async ensureStoreFolder(
    merchantName: string,
    storeName: string,
  ): Promise<string> {
    const path = join(
      this.root,
      this.folderName(merchantName),
      this.folderName(storeName),
    );
    await mkdir(path, { recursive: true });
    this.logger.log(`Store folder ready: ${path}`);
    return path;
  }
}
