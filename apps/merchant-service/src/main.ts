import 'reflect-metadata';
import '../../../scripts/load-env';
import { NestFactory } from '@nestjs/core';
import { HttpAdapterHost } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { join } from 'node:path';
import { TracingInterceptor } from '@pinaka-delivery-hub/observability';
import { AppModule } from './app.module';
import { normalizeTendorForm } from './modules/master/tenders/vendor-tendor.form.pipe';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.useBodyParser('json', {
    limit: '3mb',
    verify: (req: { rawBody?: Buffer }, _res: unknown, buffer: Buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
    type: [
      'application/json',
      'application/*+json',
      'application/x-www-form-urlencoded',
    ],
  });
  app.use(
    (
      req: { path?: string; body?: unknown },
      _res: unknown,
      next: () => void,
    ) => {
      const path = String(req.path || '');
      if (
        req.body &&
        typeof req.body === 'object' &&
        !Array.isArray(req.body) &&
        (path.startsWith('/api/v1/tendors') ||
          path.startsWith('/api/v1/tenders'))
      ) {
        req.body = normalizeTendorForm(req.body);
      }
      next();
    },
  );
  app.enableCors({
    origin: (
      process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173'
    )
      .split(',')
      .map((origin) => origin.trim()),
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: '*',
  });
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/' });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));
  app.useGlobalInterceptors(new TracingInterceptor());
  const port = Number(process.env.MERCHANT_SERVICE_PORT || 3003);
  await app.listen(port, '0.0.0.0');
  const pgadminPort = process.env.PGADMIN_PORT || 5050;
  const postgresPort = process.env.POSTGRES_PORT || 5432;
  const postgresDb = process.env.POSTGRES_DB || 'pinaka_commerce_hub_new';
  console.log(`🚀 Merchant Service running on http://localhost:${port}`);
  console.log(`🐘 pgAdmin Dashboard running on http://localhost:${pgadminPort}`);
  console.log(`🗄️ PostgreSQL Database on port ${postgresPort} (Database: ${postgresDb})`);
  console.log(`📱 Device APIs:`);
  console.log(`   - Add Device API:      POST http://localhost:${port}/api/v1/devices`);
  console.log(`   - Activate Device API: POST http://localhost:${port}/api/v1/device-activation/activate`);
}
bootstrap();
