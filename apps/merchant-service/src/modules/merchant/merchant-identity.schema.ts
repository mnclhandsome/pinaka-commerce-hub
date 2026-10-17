import { DataSource } from 'typeorm';

export async function ensureMerchantIdentitySchema(db: DataSource): Promise<void> {
  try {
    await db.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(724621, 31)');

      await manager.query('ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS merchant_code varchar(100)');
      await manager.query('ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS merchant_id varchar(100)');

      await manager.query('UPDATE public.merchants SET merchant_id = COALESCE(merchant_id, merchant_code, \'MER-\' || id::text) WHERE merchant_id IS NULL');
      await manager.query('UPDATE public.merchants SET merchant_code = COALESCE(merchant_code, merchant_id, \'MER-\' || id::text) WHERE merchant_code IS NULL');

      try {
        await manager.query('CREATE INDEX IF NOT EXISTS merchants_identity_idx ON public.merchants(merchant_id)');
      } catch {}
    });
  } catch (error) {
    console.warn('ensureMerchantIdentitySchema notice:', error);
  }
}
