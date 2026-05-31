import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  systemSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
};

const encrypt = vi.fn((plaintext: string) => `encrypted:${plaintext}`);
const decrypt = vi.fn((ciphertext: string) => ciphertext.replace(/^encrypted:/, ''));

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('../utils/crypto.ts', () => ({ encrypt, decrypt }));

const {
  getConfiguredProxyUrl,
  getProxySetting,
  normalizeProxyInput,
  updateProxySetting,
} = await import('./settings.service.ts');

describe('settings.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('把 host:port:username:password 代理转换成 HTTP proxy URL', () => {
    expect(normalizeProxyInput('host.test:8080:user name:p@ss')).toEqual({
      proxyUrl: 'http://user%20name:p%40ss@host.test:8080',
      host: 'host.test',
      port: 8080,
      username: 'user name',
    });
  });

  it('拒绝非法代理端口和缺字段格式', () => {
    expect(() => normalizeProxyInput('host.test:bad:user:pass')).toThrowError(/代理端口/);
    expect(() => normalizeProxyInput('host.test:8080:user')).toThrowError(/代理格式/);
  });

  it('拒绝可能改变 URL 语义的非法 host', () => {
    expect(() => normalizeProxyInput('proxy.example/path:8080:user:pass')).toThrowError(/host/);
    expect(() => normalizeProxyInput('proxy.example@evil.test:8080:user:pass')).toThrowError(/host/);
  });

  it('保存代理配置并读取脱敏信息', async () => {
    prisma.systemSetting.upsert.mockResolvedValue({});
    prisma.systemSetting.findUnique.mockResolvedValue({
      key: 'http_proxy',
      value: 'encrypted:http://proxy-user-zone-custom-region-JP-session-demo-sessTime-5-sessAuto-1:proxy-pass@proxy.example:10000',
    });

    await expect(
      updateProxySetting('proxy.example:10000:proxy-user-zone-custom-region-JP-session-demo-sessTime-5-sessAuto-1:proxy-pass'),
    ).resolves.toMatchObject({ enabled: true, host: 'proxy.example', port: 10000 });

    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'http_proxy' },
      create: {
        key: 'http_proxy',
        value: 'encrypted:http://proxy-user-zone-custom-region-JP-session-demo-sessTime-5-sessAuto-1:proxy-pass@proxy.example:10000',
      },
      update: {
        value: 'encrypted:http://proxy-user-zone-custom-region-JP-session-demo-sessTime-5-sessAuto-1:proxy-pass@proxy.example:10000',
      },
    });

    await expect(getProxySetting()).resolves.toEqual({
      enabled: true,
      host: 'proxy.example',
      port: 10000,
      username: 'proxy-user-zone-custom-region-JP-session-demo-sessTime-5-sessAuto-1',
      maskedProxy: 'http://proxy-user-zone-custom-region-JP-session-demo-sessTime-5-sessAuto-1:****@proxy.example:10000',
    });
  });

  it('清空代理配置并返回禁用状态', async () => {
    prisma.systemSetting.deleteMany.mockResolvedValue({ count: 1 });

    await expect(updateProxySetting(null)).resolves.toEqual({
      enabled: false,
      host: null,
      port: null,
      username: null,
      maskedProxy: null,
    });

    expect(prisma.systemSetting.deleteMany).toHaveBeenCalledWith({ where: { key: 'http_proxy' } });
  });

  it('内部读取只返回完整代理 URL，不把密码暴露给后台响应', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({
      key: 'http_proxy',
      value: 'encrypted:http://user:secret@proxy.example:10000',
    });

    await expect(getConfiguredProxyUrl()).resolves.toBe('http://user:secret@proxy.example:10000');
    await expect(getProxySetting()).resolves.toMatchObject({
      maskedProxy: 'http://user:****@proxy.example:10000',
    });
  });
});
