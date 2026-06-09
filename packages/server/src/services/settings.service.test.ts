import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  systemSetting: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
};

const encrypt = vi.fn((plaintext: string) => `encrypted:${plaintext}`);
const decrypt = vi.fn((ciphertext: string) => ciphertext.replace(/^encrypted:/, ''));
const getOutsourcedActivationCodeSettingSummary = vi.fn();
const importOutsourcedActivationCodes = vi.fn();

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('../utils/crypto.ts', () => ({ encrypt, decrypt }));
vi.mock('./outsourced-activation-code.service.ts', () => ({
  getOutsourcedActivationCodeSettingSummary,
  importOutsourcedActivationCodes,
}));

const {
  getAutoPaymentDetectionSetting,
  getMaintenanceModeSetting,
  getPaymentProcessingConfig,
  getPaymentProcessingSetting,
  getProxySetting,
  normalizeProxyInput,
  normalizeProxyPoolInput,
  recordProxyFailure,
  recordProxySuccess,
  selectHealthyProxy,
  shouldCountProxyFailure,
  updateAutoPaymentDetectionSetting,
  updateMaintenanceModeSetting,
  updatePaymentProcessingSetting,
  updateProxySetting,
} = await import('./settings.service.ts');

describe('settings.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    prisma.systemSetting.findMany.mockResolvedValue([]);
    getOutsourcedActivationCodeSettingSummary.mockResolvedValue({ count: 0, preview: [] });
    importOutsourcedActivationCodes.mockResolvedValue({ importedCount: 0, duplicateCount: 0, totalInputCount: 0 });
  });

  it('normalizes one proxy line into a safe HTTP proxy URL', () => {
    expect(normalizeProxyInput('host.test:8080:user name:p@ss')).toEqual({
      id: expect.any(String),
      proxyUrl: 'http://user%20name:p%40ss@host.test:8080',
      host: 'host.test',
      port: 8080,
      username: 'user name',
      maskedProxy: 'http://user%20name:****@host.test:8080',
    });
  });

  it('normalizes multiline ChatGPT and Stripe proxy pools', () => {
    expect(normalizeProxyPoolInput(`
      chat.example:10000:chat-user:chat-pass
      stripe.example:10001:stripe-user:stripe-pass
    `)).toHaveLength(2);
  });

  it('saves and reads separate ChatGPT and Stripe proxy pools without exposing passwords', async () => {
    prisma.systemSetting.upsert.mockResolvedValue({});
    prisma.systemSetting.findUnique.mockImplementation(({ where }: { where: { key: string } }) => {
      if (where.key === 'chatgpt_proxy_pool') {
        return Promise.resolve({
          key: where.key,
          value: 'encrypted:http://chat-user:chat-pass@chat.example:10000',
        });
      }
      if (where.key === 'stripe_proxy_pool') {
        return Promise.resolve({
          key: where.key,
          value: 'encrypted:http://stripe-user:stripe-pass@stripe.example:10001',
        });
      }
      return Promise.resolve(null);
    });

    await expect(updateProxySetting({
      chatGptProxyPool: 'chat.example:10000:chat-user:chat-pass',
      stripeProxyPool: 'stripe.example:10001:stripe-user:stripe-pass',
    })).resolves.toMatchObject({
      chatGpt: { enabled: true, proxies: [{ host: 'chat.example', username: 'chat-user' }] },
      stripe: { enabled: true, proxies: [{ host: 'stripe.example', username: 'stripe-user' }] },
    });

    const setting = await getProxySetting();

    expect(setting.chatGpt.proxies[0].maskedProxy).toBe('http://chat-user:****@chat.example:10000');
    expect(setting.stripe.proxies[0].maskedProxy).toBe('http://stripe-user:****@stripe.example:10001');
    expect(JSON.stringify(setting)).not.toContain('chat-pass');
    expect(JSON.stringify(setting)).not.toContain('stripe-pass');
  });

  it('selects a healthy proxy and skips cooled down entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    prisma.systemSetting.findUnique.mockResolvedValue({
      key: 'stripe_proxy_pool',
      value: [
        'encrypted:http://cool:user@cool.example:10000',
        'encrypted:http://ok:user@ok.example:10001',
      ].join('\n'),
    });
    const cooledProxyId = normalizeProxyInput('cool.example:10000:cool:user').id;
    prisma.systemSetting.findMany.mockResolvedValue([{
      key: `proxy_health:stripe:${cooledProxyId}`,
      value: JSON.stringify({
        consecutiveFailures: 3,
        coolingDownUntil: '2026-06-01T00:09:00.000Z',
      }),
    }]);

    await expect(selectHealthyProxy('stripe')).resolves.toMatchObject({
      host: 'ok.example',
      proxyUrl: 'http://ok:user@ok.example:10001',
    });
  });

  it('cools a proxy down for 10 minutes after three consecutive failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    prisma.systemSetting.findUnique.mockResolvedValue({
      key: 'proxy_health:chatgpt:proxy-1',
      value: JSON.stringify({ consecutiveFailures: 2, coolingDownUntil: null }),
    });
    prisma.systemSetting.upsert.mockResolvedValue({});

    await recordProxyFailure('chatgpt', 'proxy-1', Object.assign(new Error('timeout'), { code: 'UPSTREAM_TIMEOUT' }));

    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'proxy_health:chatgpt:proxy-1' },
      create: {
        key: 'proxy_health:chatgpt:proxy-1',
        value: JSON.stringify({
          consecutiveFailures: 3,
          coolingDownUntil: '2026-06-01T00:10:00.000Z',
        }),
      },
      update: {
        value: JSON.stringify({
          consecutiveFailures: 3,
          coolingDownUntil: '2026-06-01T00:10:00.000Z',
        }),
      },
    });
  });

  it('clears proxy failure counters after a successful request', async () => {
    prisma.systemSetting.upsert.mockResolvedValue({});

    await recordProxySuccess('stripe', 'proxy-1');

    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'proxy_health:stripe:proxy-1' },
      create: {
        key: 'proxy_health:stripe:proxy-1',
        value: JSON.stringify({ consecutiveFailures: 0, coolingDownUntil: null }),
      },
      update: {
        value: JSON.stringify({ consecutiveFailures: 0, coolingDownUntil: null }),
      },
    });
  });

  it('only counts retryable network, timeout, 408, 429 and 5xx errors as proxy failures', () => {
    expect(shouldCountProxyFailure(Object.assign(new Error('timeout'), { code: 'UPSTREAM_TIMEOUT' }))).toBe(true);
    expect(shouldCountProxyFailure(Object.assign(new Error('rate limited'), { statusCode: 429 }))).toBe(true);
    expect(shouldCountProxyFailure(Object.assign(new Error('bad session'), { code: 'CHATGPT_SESSION_UNRECOGNIZED' }))).toBe(false);
    expect(shouldCountProxyFailure(Object.assign(new Error('not eligible'), { code: 'ACCOUNT_NOT_ELIGIBLE' }))).toBe(false);
  });

  it('maintenance mode defaults to disabled and can be updated by admin', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue(null);
    await expect(getMaintenanceModeSetting()).resolves.toEqual({ enabled: false });

    prisma.systemSetting.upsert.mockResolvedValue({});
    await expect(updateMaintenanceModeSetting(true)).resolves.toEqual({ enabled: true });
  });

  it('auto payment detection setting keeps the previous default enabled behavior', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue(null);
    await expect(getAutoPaymentDetectionSetting()).resolves.toEqual({ enabled: true });

    prisma.systemSetting.upsert.mockResolvedValue({});
    await expect(updateAutoPaymentDetectionSetting(false)).resolves.toEqual({ enabled: false });
  });

  it('imports outsourced activation codes into the managed code table when legacy payload is submitted', async () => {
    prisma.systemSetting.upsert.mockResolvedValue({});
    prisma.systemSetting.deleteMany.mockResolvedValue({ count: 1 });
    getOutsourcedActivationCodeSettingSummary.mockResolvedValue({
      count: 2,
      preview: ['DP-F...ODE', 'DP-S...ODE'],
    });
    prisma.systemSetting.findUnique.mockImplementation(({ where }: { where: { key: string } }) => {
      if (where.key === 'payment_processing_handler') {
        return Promise.resolve({ key: where.key, value: 'OUTSOURCED_BUYER_API' });
      }
      if (where.key === 'outsourced_buyer_api_base_url') {
        return Promise.resolve({ key: where.key, value: 'https://scan.amazo.indevs.in' });
      }
      if (where.key === 'outsourced_activation_code_pool') {
        return Promise.resolve({
          key: where.key,
          value: 'encrypted:DP-FIRST-CODE\nencrypted:DP-SECOND-CODE',
        });
      }
      return Promise.resolve(null);
    });

    await expect(updatePaymentProcessingSetting({
      handler: 'OUTSOURCED_BUYER_API',
      outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in/buyer/',
      outsourcedActivationCodePool: 'DP-FIRST-CODE\nDP-SECOND-CODE',
    })).resolves.toEqual({
      handler: 'OUTSOURCED_BUYER_API',
      outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
      outsourcedActivationCodeCount: 2,
      outsourcedActivationCodePreview: ['DP-F...ODE', 'DP-S...ODE'],
    });

    expect(importOutsourcedActivationCodes).toHaveBeenCalledWith({
      codesText: 'DP-FIRST-CODE\nDP-SECOND-CODE',
      batchLabel: 'settings-import',
    });
    expect(JSON.stringify(await getPaymentProcessingSetting())).not.toContain('DP-FIRST-CODE');
    await expect(getPaymentProcessingConfig()).resolves.toEqual({
      handler: 'OUTSOURCED_BUYER_API',
      outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
      outsourcedActivationCodes: [],
    });
  });

  it('migrates legacy outsourced activation code pool when payment processing config is read', async () => {
    prisma.systemSetting.deleteMany.mockResolvedValue({ count: 1 });
    prisma.systemSetting.findUnique.mockImplementation(({ where }: { where: { key: string } }) => {
      if (where.key === 'payment_processing_handler') {
        return Promise.resolve({ key: where.key, value: 'OUTSOURCED_BUYER_API' });
      }
      if (where.key === 'outsourced_buyer_api_base_url') {
        return Promise.resolve({ key: where.key, value: 'https://scan.amazo.indevs.in' });
      }
      if (where.key === 'outsourced_activation_code_pool') {
        return Promise.resolve({
          key: where.key,
          value: 'encrypted:DP-LEGACY-CODE\nencrypted:DP-LEGACY-TWO',
        });
      }
      return Promise.resolve(null);
    });

    await expect(getPaymentProcessingConfig()).resolves.toEqual({
      handler: 'OUTSOURCED_BUYER_API',
      outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
      outsourcedActivationCodes: [],
    });

    expect(importOutsourcedActivationCodes).toHaveBeenCalledWith({
      codesText: 'DP-LEGACY-CODE\nDP-LEGACY-TWO',
      batchLabel: 'legacy-outsourced-import',
    });
    expect(prisma.systemSetting.deleteMany).toHaveBeenCalledWith({
      where: { key: 'outsourced_activation_code_pool' },
    });
  });

  it('rejects outsourced payment mode when no managed activation code is available', async () => {
    prisma.systemSetting.upsert.mockResolvedValue({});
    getOutsourcedActivationCodeSettingSummary.mockResolvedValue({ count: 0, preview: [] });

    await expect(updatePaymentProcessingSetting({
      handler: 'OUTSOURCED_BUYER_API',
      outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'OUTSOURCED_CODE_REQUIRED',
    });

    expect(prisma.systemSetting.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'payment_processing_handler' } }),
    );
  });

  it('uses managed outsourced activation code summary when admin saves handler without a pool field', async () => {
    prisma.systemSetting.upsert.mockResolvedValue({});
    getOutsourcedActivationCodeSettingSummary.mockResolvedValue({
      count: 1,
      preview: ['DP-F...ODE'],
    });
    prisma.systemSetting.findUnique.mockImplementation(({ where }: { where: { key: string } }) => {
      if (where.key === 'payment_processing_handler') {
        return Promise.resolve({ key: where.key, value: 'OUTSOURCED_BUYER_API' });
      }
      if (where.key === 'outsourced_buyer_api_base_url') {
        return Promise.resolve({ key: where.key, value: 'https://scan.amazo.indevs.in' });
      }
      return Promise.resolve(null);
    });

    await expect(updatePaymentProcessingSetting({
      handler: 'LOCAL_WORKER',
      outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
    })).resolves.toEqual({
      handler: 'LOCAL_WORKER',
      outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
      outsourcedActivationCodeCount: 1,
      outsourcedActivationCodePreview: ['DP-F...ODE'],
    });

    expect(prisma.systemSetting.deleteMany).not.toHaveBeenCalledWith({
      where: { key: 'outsourced_activation_code_pool' },
    });
    expect(importOutsourcedActivationCodes).not.toHaveBeenCalled();
  });

  it('defaults payment processing to local worker mode', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue(null);

    await expect(getPaymentProcessingSetting()).resolves.toEqual({
      handler: 'LOCAL_WORKER',
      outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
      outsourcedActivationCodeCount: 0,
      outsourcedActivationCodePreview: [],
    });
  });
});
