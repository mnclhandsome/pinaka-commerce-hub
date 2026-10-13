import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';

export type StoredFileScope = {
  merchantName: string;
  storeName?: string;
};

/**
 * Files live on disk under uploads/{MerchantName}/{StoreName}/{filename}.
 * Merchant and store folder names are the display names with spaces removed.
 * The database stores the public URL only. Express serves that URL from main.ts.
 */
@Injectable()
export class FileStorageService {
  private readonly root = resolve(
    process.env.MERCHANT_UPLOAD_ROOT?.trim() || join(process.cwd(), 'uploads'),
  );

  /** "Fresh Mart" becomes "FreshMart". Unsafe path characters are stripped. */
  folderName(name: string): string {
    let cleaned = String(name ?? '')
      .normalize('NFKC')
      .replace(/\s+/g, '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/^\.+/, '')
      .replace(/\.+$/, '')
      .slice(0, 80);
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
      cleaned = `${cleaned}_`;
    }
    if (!cleaned) {
      throw new BadRequestException(
        'Folder name is empty after removing spaces and unsafe characters',
      );
    }
    return cleaned;
  }

  isDataImage(value: string | null | undefined): boolean {
    return (
      typeof value === 'string' &&
      /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(value.trim())
    );
  }

  /** True when the URL points at a file inside this merchant or store directory. */
  isWithinDirectory(url: string | null | undefined, scope: StoredFileScope): boolean {
    const relative = this.publicUrlToRelative(url);
    if (!relative) return false;
    try {
      return (
        relative.startsWith(this.scopePrefix(scope)) &&
        this.resolveInsideRoot(relative) !== null
      );
    } catch {
      return false;
    }
  }

  async ensureMerchantFolder(merchantName: string): Promise<string> {
    const merchantFolder = this.folderName(merchantName);
    const directory = this.resolveInsideRoot(merchantFolder);
    if (!directory) throw new BadRequestException('Invalid merchant folder name');
    await mkdir(directory, { recursive: true });
    return merchantFolder;
  }

  async ensureStoreFolder(
    merchantName: string,
    storeName: string,
  ): Promise<{ merchantFolder: string; storeFolder: string }> {
    const merchantFolder = await this.ensureMerchantFolder(merchantName);
    const storeFolder = this.folderName(storeName);
    const directory = this.resolveInsideRoot(`${merchantFolder}/${storeFolder}`);
    if (!directory) throw new BadRequestException('Invalid store folder name');
    await mkdir(directory, { recursive: true });
    return { merchantFolder, storeFolder };
  }

  async renameMerchantFolder(fromName: string, toName: string): Promise<void> {
    const from = this.folderName(fromName);
    const to = this.folderName(toName);
    if (from === to) {
      await this.ensureMerchantFolder(toName);
      return;
    }
    await this.moveDirectory(from, to);
  }

  async renameStoreFolder(
    merchantName: string,
    fromStoreName: string,
    toStoreName: string,
  ): Promise<void> {
    const merchantFolder = await this.ensureMerchantFolder(merchantName);
    const from = this.folderName(fromStoreName);
    const to = this.folderName(toStoreName);
    if (from === to) {
      await this.ensureStoreFolder(merchantName, toStoreName);
      return;
    }
    await this.moveDirectory(
      `${merchantFolder}/${from}`,
      `${merchantFolder}/${to}`,
    );
  }

  async saveMerchantFile(input: {
    merchantName: string;
    filename: string;
    buffer: Buffer;
    mimeType?: string;
  }): Promise<{ url: string; filename: string }> {
    this.assertBuffer(input.buffer);
    const merchantFolder = await this.ensureMerchantFolder(input.merchantName);
    const directory = this.resolveInsideRoot(merchantFolder);
    if (!directory) throw new BadRequestException('Invalid merchant folder name');
    const filename = await this.allocateName(
      directory,
      this.fileName(input.filename, this.extensionForMime(input.mimeType)),
    );
    await writeFile(join(directory, filename), input.buffer);
    return { filename, url: this.publicUrl([merchantFolder, filename]) };
  }

  async saveStoreFile(input: {
    merchantName: string;
    storeName: string;
    filename: string;
    buffer: Buffer;
    mimeType?: string;
  }): Promise<{ url: string; filename: string }> {
    this.assertBuffer(input.buffer);
    const { merchantFolder, storeFolder } = await this.ensureStoreFolder(
      input.merchantName,
      input.storeName,
    );
    const directory = this.resolveInsideRoot(`${merchantFolder}/${storeFolder}`);
    if (!directory) throw new BadRequestException('Invalid store folder name');
    const filename = await this.allocateName(
      directory,
      this.fileName(input.filename, this.extensionForMime(input.mimeType)),
    );
    await writeFile(join(directory, filename), input.buffer);
    return {
      filename,
      url: this.publicUrl([merchantFolder, storeFolder, filename]),
    };
  }

  /**
   * Accepts a data URL or a URL already stored for this store.
   * Returns the public URL that should be persisted instead of the file bytes.
   */
  async storeImageData(input: {
    merchantName: string;
    storeName: string;
    imageName: string;
    imageData: string;
  }): Promise<string> {
    const scope = {
      merchantName: input.merchantName,
      storeName: input.storeName,
    };
    if (this.isWithinDirectory(input.imageData, scope)) {
      return this.normalizePublicUrl(input.imageData);
    }
    const decoded = this.decodeDataImage(input.imageData);
    const saved = await this.saveStoreFile({
      merchantName: input.merchantName,
      storeName: input.storeName,
      filename: this.fileName(input.imageName, decoded.extension),
      buffer: decoded.buffer,
    });
    return saved.url;
  }

  /** Deletes a file only when it sits inside the caller's merchant or store directory. */
  async removeStoredFile(
    url: string | null | undefined,
    scope: StoredFileScope,
  ): Promise<void> {
    const relative = this.publicUrlToRelative(url);
    if (!relative || !this.isWithinDirectory(url, scope)) return;
    await this.deleteFile(relative);
  }

  /** Deletes a previously issued upload URL. Refuses paths that escape the upload root. */
  async removeUpload(url: string | null | undefined): Promise<void> {
    const relative = this.publicUrlToRelative(url);
    if (!relative) return;
    const name = basename(relative);
    if (name === 'no-image.png' || name === 'no-image-2.png') return;
    await this.deleteFile(relative);
  }

  private async moveDirectory(fromRelative: string, toRelative: string): Promise<void> {
    const source = this.resolveInsideRoot(fromRelative);
    const target = this.resolveInsideRoot(toRelative);
    if (!source || !target) throw new BadRequestException('Invalid folder name');
    await mkdir(this.root, { recursive: true });
    if (!existsSync(source)) {
      await mkdir(target, { recursive: true });
      return;
    }
    if (existsSync(target)) {
      throw new ConflictException(`A folder named ${basename(target)} already exists`);
    }
    await rename(source, target);
  }

  private async deleteFile(relative: string): Promise<void> {
    const absolute = this.resolveInsideRoot(relative);
    if (!absolute) return;
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) return;
    await unlink(absolute).catch(() => undefined);
  }

  private scopePrefix(scope: StoredFileScope): string {
    const merchantFolder = this.folderName(scope.merchantName);
    if (!scope.storeName) return `${merchantFolder}/`;
    return `${merchantFolder}/${this.folderName(scope.storeName)}/`;
  }

  private assertBuffer(buffer: Buffer): void {
    if (!buffer?.length || buffer.length > 5 * 1024 * 1024) {
      throw new BadRequestException('File must be non-empty and at most 5 MB');
    }
  }

  private decodeDataImage(imageData: string): { buffer: Buffer; extension: string } {
    const match =
      /^data:image\/(png|jpeg|jpg|webp);base64,([a-z0-9+/=\r\n]+)$/i.exec(
        String(imageData ?? '').trim(),
      );
    if (!match) {
      throw new BadRequestException(
        'Image must be a PNG, JPG, or WEBP data URL or an existing upload URL for this store',
      );
    }
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!buffer.length || buffer.length > 2 * 1024 * 1024) {
      throw new BadRequestException('Image must be a non-empty file of at most 2 MB');
    }
    const kind = match[1].toLowerCase();
    const extension = kind === 'png' ? '.png' : kind === 'webp' ? '.webp' : '.jpg';
    return { buffer, extension };
  }

  private fileName(original: string, extension: string): string {
    const cleaned = basename(original || 'file')
      .replace(/\s+/g, '')
      .replace(/[^A-Za-z0-9._-]/g, '')
      .replace(/^\.+/, '')
      .slice(0, 120);
    const stem = cleaned || 'file';
    if (/\.(png|jpe?g|webp|gif|pdf|txt|csv)$/i.test(stem)) return stem;
    return `${stem}${extension || ''}`;
  }

  private extensionForMime(mimeType?: string): string {
    if (mimeType === 'image/png') return '.png';
    if (mimeType === 'image/webp') return '.webp';
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return '.jpg';
    if (mimeType === 'application/pdf') return '.pdf';
    return '';
  }

  private async allocateName(directory: string, filename: string): Promise<string> {
    if (!existsSync(join(directory, filename))) return filename;
    const extension = extname(filename);
    const stem = basename(filename, extension);
    return `${stem}-${randomUUID().slice(0, 8)}${extension}`;
  }

  private publicUrl(segments: string[]): string {
    const path = `/uploads/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
    const base = process.env.PUBLIC_FILE_BASE_URL?.trim().replace(/\/$/, '');
    return base ? `${base}${path}` : path;
  }

  private normalizePublicUrl(url: string): string {
    const relative = this.publicUrlToRelative(url);
    if (!relative) return url;
    return this.publicUrl(relative.split('/'));
  }

  private publicUrlToRelative(url: string | null | undefined): string | null {
    if (!url || typeof url !== 'string') return null;
    let pathname = url.trim();
    try {
      if (pathname.startsWith('http://') || pathname.startsWith('https://')) {
        pathname = new URL(pathname).pathname;
      }
    } catch {
      return null;
    }
    if (!pathname.startsWith('/uploads/')) return null;
    const relative = pathname
      .slice('/uploads/'.length)
      .split('/')
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })
      .join('/');
    if (!relative || relative.includes('\0')) return null;
    return relative;
  }

  private resolveInsideRoot(relative: string): string | null {
    const parts = relative.replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || parts.some((part) => part === '.' || part === '..')) return null;
    const absolute = resolve(this.root, ...parts);
    const root = resolve(this.root);
    const prefix = root.endsWith(sep) ? root : root + sep;
    const left = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    const right = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
    if (left !== (process.platform === 'win32' ? root.toLowerCase() : root) && !left.startsWith(right)) {
      return null;
    }
    return absolute;
  }
}
