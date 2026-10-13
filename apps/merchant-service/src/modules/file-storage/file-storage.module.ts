import { Global, Module } from '@nestjs/common';
import { FileStorageService } from './file-storage.service';

/** Cross-cutting disk storage. Import once from AppModule; every feature can inject it. */
@Global()
@Module({
  providers: [FileStorageService],
  exports: [FileStorageService],
})
export class FileStorageModule {}
