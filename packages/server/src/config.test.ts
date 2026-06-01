import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const validEnv = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/pix_payment',
  JWT_SECRET: '0123456789abcdef0123456789abcdef',
  SESSION_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'a-strong-admin-password',
  PORT: '3000',
  CORS_ORIGIN: 'http://localhost:5173',
  REDIS_URL: 'redis://127.0.0.1:6379',
  PIX_WORKER_CONCURRENCY: '5',
  CREATE_ORDER_RATE_LIMIT_PER_MIN: '30',
};

describe('loadConfig', () => {
  it('拒绝缺失的必填配置', () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: '' })).toThrow(/JWT_SECRET/);
  });

  it('拒绝默认或过弱的管理员密码', () => {
    expect(() => loadConfig({ ...validEnv, ADMIN_PASSWORD: 'admin123' })).toThrow(/ADMIN_PASSWORD/);
  });

  it('拒绝非法 session 加密密钥', () => {
    expect(() => loadConfig({ ...validEnv, SESSION_ENCRYPTION_KEY: 'not-hex' })).toThrow(
      /SESSION_ENCRYPTION_KEY/,
    );
  });

  it('解析有效配置', () => {
    expect(loadConfig(validEnv)).toMatchObject({
      databaseUrl: validEnv.DATABASE_URL,
      jwtSecret: validEnv.JWT_SECRET,
      sessionEncryptionKey: validEnv.SESSION_ENCRYPTION_KEY,
      adminUsername: validEnv.ADMIN_USERNAME,
      adminPassword: validEnv.ADMIN_PASSWORD,
      corsOrigin: validEnv.CORS_ORIGIN,
      redisUrl: validEnv.REDIS_URL,
      pixWorkerConcurrency: 5,
      createOrderRateLimitPerMin: 30,
      port: 3000,
    });
  });
});
