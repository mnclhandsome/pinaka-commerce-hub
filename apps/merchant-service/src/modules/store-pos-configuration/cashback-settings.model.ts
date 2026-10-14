export interface CashbackTierModel {
  from: number | null;
  to: number | null;
  fee: number | null;
}

export interface CashBackServiceModel {
  enabled: number | null;
  max_cashback: number | null;
  tiers: CashbackTierModel[];
}

export interface CashBackSettingsResponse {
  cash_back_service: CashBackServiceModel;
}

export function mapCashbackSettings(value: unknown): CashBackSettingsResponse {
  const source = asRecord(value);
  const tiers = Array.isArray(source.tiers) ? source.tiers : [];
  return {
    cash_back_service: {
      enabled: enabledFlag(source.enabled),
      max_cashback: numberOrNull(source.maxCashback ?? source.max_cashback),
      tiers: tiers.map((tier) => {
        const row = asRecord(tier);
        return {
          from: numberOrNull(row.from),
          to: numberOrNull(row.to),
          fee: numberOrNull(row.fee),
        };
      }),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function enabledFlag(value: unknown): number | null {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}
