import { resolve as resolvePath } from 'node:path';
function env(name: string, def?: string): string {
  const v = process.env[name] ?? def;
  if (v === undefined) throw new Error(`Missing env ${name}`);
  return v;
}

export const config = {
  env: env('NODE_ENV', 'development'),
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: env('DATABASE_URL', 'postgres://operate_app:operate_app@localhost:5432/operate'),
  adminDatabaseUrl: env('DATABASE_ADMIN_URL', 'postgres://postgres@localhost:5432/operate'),
  appRole: env('APP_DB_ROLE', 'operate_app'),
  secret: env('APP_SECRET', 'dev-only-secret-change-me-dev-only-secret'),
  publicUrl: env('PUBLIC_URL', 'http://localhost:5173'),
  sessionHours: Number(env('SESSION_HOURS', '12')),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicBaseUrl: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
  webDist: process.env.WEB_DIST ? resolvePath(process.env.WEB_DIST) : '',
  emailMode: env('EMAIL_MODE', 'log') as 'log' | 'smtp' | 'off',
  runWorkerInProcess: env('RUN_WORKER', 'true') === 'true',
  maxUploadBytes: Number(env('MAX_UPLOAD_BYTES', String(10 * 1024 * 1024))),
  get isProd() {
    return this.env === 'production';
  },
};

if (config.isProd && config.secret.startsWith('dev-only')) {
  throw new Error('APP_SECRET must be set in production');
}
