import 'dotenv/config';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  sessionEncryptionKey: string;
  adminUsername: string;
  adminPassword: string;
  corsOrigin: string;
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const TEST_DEFAULTS = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/pix_payment_test',
  JWT_SECRET: '0123456789abcdef0123456789abcdef',
  SESSION_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'TestAdminPass-2026',
  CORS_ORIGIN: 'http://localhost:5173',
};

export function loadConfig(
  env: Record<string, string | undefined>,
  options: { allowTestDefaults?: boolean } = {},
): AppConfig {
  const source = options.allowTestDefaults ? { ...TEST_DEFAULTS, ...env } : env;
  const nodeEnv = source.NODE_ENV ?? env.NODE_ENV ?? 'development';

  const databaseUrl = requireEnv(source, 'DATABASE_URL');
  const jwtSecret = requireEnv(source, 'JWT_SECRET');
  const sessionEncryptionKey = requireEnv(source, 'SESSION_ENCRYPTION_KEY');
  const adminUsername = requireEnv(source, 'ADMIN_USERNAME');
  const adminPassword = requireEnv(source, 'ADMIN_PASSWORD');
  const corsOrigin = nodeEnv === 'production'
    ? requireEnv(source, 'CORS_ORIGIN')
    : source.CORS_ORIGIN ?? 'http://localhost:5173';
  const port = Number(source.PORT ?? 3000);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }
  if (jwtSecret.length < 32 || looksLikePlaceholder(jwtSecret)) {
    throw new Error('JWT_SECRET must be a non-placeholder secret with at least 32 characters');
  }
  if (!HEX_64.test(sessionEncryptionKey)) {
    throw new Error('SESSION_ENCRYPTION_KEY must be exactly 64 hex characters');
  }
  if (adminPassword.length < 12 || adminPassword === 'admin123' || adminPassword === adminUsername || looksLikePlaceholder(adminPassword)) {
    throw new Error('ADMIN_PASSWORD must be changed to a strong password');
  }

  return {
    port,
    databaseUrl,
    jwtSecret,
    jwtExpiresIn: '24h',
    sessionEncryptionKey,
    adminUsername,
    adminPassword,
    corsOrigin,
  };
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function looksLikePlaceholder(value: string): boolean {
  return /change[-_ ]?me|your-|replace-|example|placeholder/i.test(value);
}

export const config = process.env.NODE_ENV === 'test'
  ? loadConfig(TEST_DEFAULTS)
  : loadConfig(process.env);
