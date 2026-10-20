import 'dotenv/config';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',
  /** Runtime connection (non-owner role so RLS applies). */
  databaseUrl: req('DATABASE_URL', 'postgres://leadvolt_app:leadvolt_app@localhost:5432/leadvolt'),
  /** Owner connection used only by migrations. */
  migrationUrl: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://leadvolt:leadvolt@localhost:5432/leadvolt',
  jwtSecret: req('JWT_SECRET', 'dev-only-change-me-dev-only-change-me'),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:4000',
  whatsapp: {
    verifyToken: process.env.WA_VERIFY_TOKEN ?? '',
    appSecret: process.env.WA_APP_SECRET ?? '',
    accessToken: process.env.WA_ACCESS_TOKEN ?? '',
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID ?? '',
  },
  workers: {
    enabled: process.env.WORKERS_ENABLED !== 'false',
    slaIntervalMs: Number(process.env.SLA_INTERVAL_MS ?? 30_000),
  },
};
