import { prisma } from '../db.ts';
import { AppError } from '../middleware/error-handler.ts';
import { decrypt, encrypt } from '../utils/crypto.ts';

const PROXY_SETTING_KEY = 'http_proxy';

export interface ProxySettingView {
  enabled: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  maskedProxy: string | null;
}

export interface NormalizedProxyInput {
  proxyUrl: string;
  host: string;
  port: number;
  username: string;
}

export function normalizeProxyInput(input: string): NormalizedProxyInput {
  const trimmed = input.trim();
  const parts = trimmed.split(':');
  if (parts.length !== 4 || parts.some((part) => part.trim() === '')) {
    throw new AppError(400, '代理格式应为 host:port:username:password', 'PROXY_INVALID');
  }

  const [host, portText, username, password] = parts.map((part) => part.trim());
  if (!isValidProxyHost(host)) {
    throw new AppError(400, '代理 host 格式不正确', 'PROXY_INVALID');
  }

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(400, '代理端口必须是 1 到 65535 的数字', 'PROXY_INVALID');
  }

  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  return { proxyUrl, host, port, username };
}

export async function getConfiguredProxyUrl(): Promise<string | null> {
  const setting = await prisma.systemSetting.findUnique({ where: { key: PROXY_SETTING_KEY } });
  return setting ? decrypt(setting.value) : null;
}

export async function getProxySetting(): Promise<ProxySettingView> {
  const proxyUrl = await getConfiguredProxyUrl();
  return proxyUrl ? toProxySettingView(proxyUrl) : disabledProxySetting();
}

export async function updateProxySetting(proxy: string | null): Promise<ProxySettingView> {
  if (!proxy?.trim()) {
    await prisma.systemSetting.deleteMany({ where: { key: PROXY_SETTING_KEY } });
    return disabledProxySetting();
  }

  const normalized = normalizeProxyInput(proxy);
  const encryptedProxyUrl = encrypt(normalized.proxyUrl);
  await prisma.systemSetting.upsert({
    where: { key: PROXY_SETTING_KEY },
    create: { key: PROXY_SETTING_KEY, value: encryptedProxyUrl },
    update: { value: encryptedProxyUrl },
  });

  return toProxySettingView(normalized.proxyUrl);
}

function isValidProxyHost(host: string): boolean {
  if (host.length > 253) return false;
  return host.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function toProxySettingView(proxyUrl: string): ProxySettingView {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new AppError(500, '代理配置读取失败', 'PROXY_CONFIG_INVALID');
  }

  const port = Number(parsed.port);
  return {
    enabled: true,
    host: parsed.hostname,
    port,
    username: decodeURIComponent(parsed.username),
    maskedProxy: `${parsed.protocol}//${parsed.username}:****@${parsed.hostname}:${parsed.port}`,
  };
}

function disabledProxySetting(): ProxySettingView {
  return {
    enabled: false,
    host: null,
    port: null,
    username: null,
    maskedProxy: null,
  };
}
