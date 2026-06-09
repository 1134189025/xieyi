import { createHash } from 'node:crypto';
import { prisma } from '../db.ts';
import { AppError } from '../middleware/error-handler.ts';
import { decrypt, encrypt } from '../utils/crypto.ts';
import {
  getOutsourcedActivationCodeSettingSummary,
  importOutsourcedActivationCodes,
} from './outsourced-activation-code.service.ts';

const CHATGPT_PROXY_POOL_KEY = 'chatgpt_proxy_pool';
const STRIPE_PROXY_POOL_KEY = 'stripe_proxy_pool';
const AUTO_PAYMENT_DETECTION_SETTING_KEY = 'auto_payment_detection_enabled';
const MAINTENANCE_MODE_SETTING_KEY = 'maintenance_mode_enabled';
const PAYMENT_PROCESSING_HANDLER_KEY = 'payment_processing_handler';
const OUTSOURCED_BUYER_API_BASE_URL_KEY = 'outsourced_buyer_api_base_url';
const OUTSOURCED_ACTIVATION_CODE_POOL_KEY = 'outsourced_activation_code_pool';
const DEFAULT_OUTSOURCED_BUYER_API_BASE_URL = 'https://scan.amazo.indevs.in';
const PROXY_COOLDOWN_FAILURES = 3;
const PROXY_COOLDOWN_MS = 10 * 60 * 1000;

export type ProxyPoolName = 'chatgpt' | 'stripe';
export type PaymentHandler = 'LOCAL_WORKER' | 'OUTSOURCED_BUYER_API';

export interface ProxyPoolSettingView {
  enabled: boolean;
  proxies: ProxySettingView[];
}

export interface ProxySettingView {
  id: string;
  host: string;
  port: number;
  username: string;
  maskedProxy: string;
  consecutiveFailures?: number;
  coolingDownUntil?: string | null;
  healthy?: boolean;
}

export interface ProxySettingsView {
  chatGpt: ProxyPoolSettingView;
  stripe: ProxyPoolSettingView;
}

export interface AutoPaymentDetectionSettingView {
  enabled: boolean;
}

export interface MaintenanceModeSettingView {
  enabled: boolean;
}

export interface PaymentProcessingSettingView {
  handler: PaymentHandler;
  outsourcedBuyerApiBaseUrl: string;
  outsourcedActivationCodeCount: number;
  outsourcedActivationCodePreview: string[];
}

export interface PaymentProcessingConfig {
  handler: PaymentHandler;
  outsourcedBuyerApiBaseUrl: string;
  outsourcedActivationCodes: string[];
}

export interface NormalizedProxyInput extends ProxySettingView {
  proxyUrl: string;
}

export interface SelectedProxy extends NormalizedProxyInput {
  proxyUrl: string;
}

export interface ProxyPoolHealthSummary {
  chatGpt: ProxyPoolHealthGroup;
  stripe: ProxyPoolHealthGroup;
}

export interface ProxyPoolHealthGroup {
  total: number;
  healthy: number;
  coolingDown: number;
}

interface ProxyHealthState {
  consecutiveFailures: number;
  coolingDownUntil: string | null;
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
  return {
    id: proxyId(host, port, username),
    proxyUrl,
    host,
    port,
    username,
    maskedProxy: `http://${encodeURIComponent(username)}:****@${host}:${port}`,
  };
}

export function normalizeProxyPoolInput(input: string): NormalizedProxyInput[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeProxyInput);
}

export async function getProxySetting(): Promise<ProxySettingsView> {
  const [chatGpt, stripe] = await Promise.all([
    getProxyPoolSetting('chatgpt'),
    getProxyPoolSetting('stripe'),
  ]);
  return { chatGpt, stripe };
}

export async function updateProxySetting(input: {
  chatGptProxyPool?: string | null;
  stripeProxyPool?: string | null;
}): Promise<ProxySettingsView> {
  const updates: Promise<unknown>[] = [];

  if ('chatGptProxyPool' in input) {
    updates.push(saveProxyPoolSetting('chatgpt', input.chatGptProxyPool ?? ''));
  }
  if ('stripeProxyPool' in input) {
    updates.push(saveProxyPoolSetting('stripe', input.stripeProxyPool ?? ''));
  }

  await Promise.all(updates);
  return getProxySetting();
}

export async function selectHealthyProxy(poolName: ProxyPoolName): Promise<SelectedProxy | null> {
  const proxies = await getProxyPoolUrls(poolName);
  if (proxies.length === 0) return null;

  const healthByProxyId = await getProxyHealthMap(poolName);
  const now = Date.now();
  const healthyProxy = proxies.find((proxy) => {
    const health = healthByProxyId.get(proxy.id);
    if (!health?.coolingDownUntil) return true;
    return Date.parse(health.coolingDownUntil) <= now;
  });

  if (!healthyProxy) {
    throw new AppError(503, '暂无可用代理，请稍后重试', 'NO_HEALTHY_PROXY');
  }

  return healthyProxy;
}

export async function recordProxyFailure(poolName: ProxyPoolName, proxyIdValue: string | null, error: unknown): Promise<void> {
  if (!proxyIdValue || !shouldCountProxyFailure(error)) return;

  const key = proxyHealthKey(poolName, proxyIdValue);
  const current = await readProxyHealth(key);
  const consecutiveFailures = current.consecutiveFailures + 1;
  const coolingDownUntil = consecutiveFailures >= PROXY_COOLDOWN_FAILURES
    ? new Date(Date.now() + PROXY_COOLDOWN_MS).toISOString()
    : null;

  await saveProxyHealth(key, { consecutiveFailures, coolingDownUntil });
}

export async function recordProxySuccess(poolName: ProxyPoolName, proxyIdValue: string | null): Promise<void> {
  if (!proxyIdValue) return;
  await saveProxyHealth(proxyHealthKey(poolName, proxyIdValue), {
    consecutiveFailures: 0,
    coolingDownUntil: null,
  });
}

export function shouldCountProxyFailure(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (
    code === 'CHATGPT_SESSION_UNRECOGNIZED' ||
    code === 'ACCOUNT_NOT_ELIGIBLE' ||
    code === 'INVALID_CODE' ||
    code === 'NO_HEALTHY_PROXY'
  ) {
    return false;
  }
  if (code === 'UPSTREAM_TIMEOUT') return true;
  if (error instanceof TypeError) return true;

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && (statusCode === 408 || statusCode === 429 || statusCode >= 500);
}

export async function getProxyPoolHealthSummary(): Promise<ProxyPoolHealthSummary> {
  const [chatGpt, stripe] = await Promise.all([
    summarizeProxyPoolHealth('chatgpt'),
    summarizeProxyPoolHealth('stripe'),
  ]);
  return { chatGpt, stripe };
}

export async function getAutoPaymentDetectionSetting(): Promise<AutoPaymentDetectionSettingView> {
  const setting = await prisma.systemSetting.findUnique({ where: { key: AUTO_PAYMENT_DETECTION_SETTING_KEY } });
  return { enabled: setting?.value !== 'false' };
}

export async function updateAutoPaymentDetectionSetting(enabled: boolean): Promise<AutoPaymentDetectionSettingView> {
  await prisma.systemSetting.upsert({
    where: { key: AUTO_PAYMENT_DETECTION_SETTING_KEY },
    create: { key: AUTO_PAYMENT_DETECTION_SETTING_KEY, value: String(enabled) },
    update: { value: String(enabled) },
  });
  return { enabled };
}

export async function getMaintenanceModeSetting(): Promise<MaintenanceModeSettingView> {
  const setting = await prisma.systemSetting.findUnique({ where: { key: MAINTENANCE_MODE_SETTING_KEY } });
  return { enabled: setting?.value === 'true' };
}

export async function updateMaintenanceModeSetting(enabled: boolean): Promise<MaintenanceModeSettingView> {
  await prisma.systemSetting.upsert({
    where: { key: MAINTENANCE_MODE_SETTING_KEY },
    create: { key: MAINTENANCE_MODE_SETTING_KEY, value: String(enabled) },
    update: { value: String(enabled) },
  });
  return { enabled };
}

export async function getPaymentProcessingSetting(): Promise<PaymentProcessingSettingView> {
  const config = await getPaymentProcessingConfig();
  const activationCodeSummary = await getOutsourcedActivationCodeSettingSummary();
  return paymentProcessingView(config, activationCodeSummary);
}

export async function getPaymentProcessingConfig(): Promise<PaymentProcessingConfig> {
  await migrateLegacyOutsourcedActivationCodePool();
  const [handlerRow, baseUrlRow] = await Promise.all([
    prisma.systemSetting.findUnique({ where: { key: PAYMENT_PROCESSING_HANDLER_KEY } }),
    prisma.systemSetting.findUnique({ where: { key: OUTSOURCED_BUYER_API_BASE_URL_KEY } }),
  ]);

  return {
    handler: normalizePaymentHandler(handlerRow?.value),
    outsourcedBuyerApiBaseUrl: normalizeOutsourcedBuyerApiBaseUrl(
      baseUrlRow?.value || DEFAULT_OUTSOURCED_BUYER_API_BASE_URL,
    ),
    outsourcedActivationCodes: [],
  };
}

export async function updatePaymentProcessingSetting(input: {
  handler: PaymentHandler;
  outsourcedBuyerApiBaseUrl?: string | null;
  outsourcedActivationCodePool?: string | null;
}): Promise<PaymentProcessingSettingView> {
  const handler = normalizePaymentHandler(input.handler);
  const outsourcedBuyerApiBaseUrl = normalizeOutsourcedBuyerApiBaseUrl(
    input.outsourcedBuyerApiBaseUrl || DEFAULT_OUTSOURCED_BUYER_API_BASE_URL,
  );
  const shouldUpdateActivationCodePool = Object.prototype.hasOwnProperty.call(
    input,
    'outsourcedActivationCodePool',
  );
  const activationCodes = shouldUpdateActivationCodePool
    ? normalizeActivationCodePool(input.outsourcedActivationCodePool ?? '')
    : null;

  if (activationCodes && activationCodes.length > 0) {
    await importOutsourcedActivationCodes({
      codesText: activationCodes.join('\n'),
      batchLabel: 'settings-import',
    });
  }
  if (shouldUpdateActivationCodePool) {
    await prisma.systemSetting.deleteMany({ where: { key: OUTSOURCED_ACTIVATION_CODE_POOL_KEY } });
  }

  const activationCodeSummary = await getOutsourcedActivationCodeSettingSummary();
  if (handler === 'OUTSOURCED_BUYER_API' && activationCodeSummary.count <= 0) {
    throw new AppError(400, '请先导入外包兑换码，再开启外包自动支付', 'OUTSOURCED_CODE_REQUIRED');
  }

  await Promise.all([
    prisma.systemSetting.upsert({
      where: { key: PAYMENT_PROCESSING_HANDLER_KEY },
      create: { key: PAYMENT_PROCESSING_HANDLER_KEY, value: handler },
      update: { value: handler },
    }),
    prisma.systemSetting.upsert({
      where: { key: OUTSOURCED_BUYER_API_BASE_URL_KEY },
      create: { key: OUTSOURCED_BUYER_API_BASE_URL_KEY, value: outsourcedBuyerApiBaseUrl },
      update: { value: outsourcedBuyerApiBaseUrl },
    }),
  ]);

  return paymentProcessingView({
    handler,
    outsourcedBuyerApiBaseUrl,
    outsourcedActivationCodes: [],
  }, activationCodeSummary);
}

async function getProxyPoolSetting(poolName: ProxyPoolName): Promise<ProxyPoolSettingView> {
  const proxies = await getProxyPoolUrls(poolName);
  const healthByProxyId = await getProxyHealthMap(poolName);
  const now = Date.now();
  return {
    enabled: proxies.length > 0,
    proxies: proxies.map((proxy) => {
      const health = healthByProxyId.get(proxy.id) ?? defaultProxyHealth();
      const coolingDown = health.coolingDownUntil ? Date.parse(health.coolingDownUntil) > now : false;
      return {
        id: proxy.id,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        maskedProxy: proxy.maskedProxy,
        consecutiveFailures: health.consecutiveFailures,
        coolingDownUntil: health.coolingDownUntil,
        healthy: !coolingDown,
      };
    }),
  };
}

async function saveProxyPoolSetting(poolName: ProxyPoolName, input: string): Promise<void> {
  const key = proxyPoolKey(poolName);
  const proxies = input.trim() ? normalizeProxyPoolInput(input) : [];
  if (proxies.length === 0) {
    await prisma.systemSetting.deleteMany({ where: { key } });
    return;
  }

  const encryptedProxyUrls = proxies.map((proxy) => encrypt(proxy.proxyUrl)).join('\n');
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: encryptedProxyUrls },
    update: { value: encryptedProxyUrls },
  });
}

async function getProxyPoolUrls(poolName: ProxyPoolName): Promise<NormalizedProxyInput[]> {
  const setting = await prisma.systemSetting.findUnique({ where: { key: proxyPoolKey(poolName) } });
  if (!setting?.value.trim()) return [];

  return setting.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => decrypt(line))
    .map(normalizeProxyUrl);
}

function normalizeProxyUrl(proxyUrl: string): NormalizedProxyInput {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new AppError(500, '代理配置读取失败', 'PROXY_CONFIG_INVALID');
  }

  const port = Number(parsed.port);
  const username = decodeURIComponent(parsed.username);
  return {
    id: proxyId(parsed.hostname, port, username),
    proxyUrl,
    host: parsed.hostname,
    port,
    username,
    maskedProxy: `${parsed.protocol}//${parsed.username}:****@${parsed.hostname}:${parsed.port}`,
  };
}

async function summarizeProxyPoolHealth(poolName: ProxyPoolName): Promise<ProxyPoolHealthGroup> {
  const setting = await getProxyPoolSetting(poolName);
  const healthy = setting.proxies.filter((proxy) => proxy.healthy).length;
  return {
    total: setting.proxies.length,
    healthy,
    coolingDown: setting.proxies.length - healthy,
  };
}

async function getProxyHealthMap(poolName: ProxyPoolName): Promise<Map<string, ProxyHealthState>> {
  const prefix = `proxy_health:${poolName}:`;
  const rows = await prisma.systemSetting.findMany({
    where: { key: { startsWith: prefix } },
  });
  const healthByProxyId = new Map<string, ProxyHealthState>();
  for (const row of rows) {
    healthByProxyId.set(row.key.slice(prefix.length), parseProxyHealth(row.value));
  }
  return healthByProxyId;
}

async function readProxyHealth(key: string): Promise<ProxyHealthState> {
  const setting = await prisma.systemSetting.findUnique({ where: { key } });
  return setting ? parseProxyHealth(setting.value) : defaultProxyHealth();
}

async function saveProxyHealth(key: string, health: ProxyHealthState): Promise<void> {
  const value = JSON.stringify(health);
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

function parseProxyHealth(value: string): ProxyHealthState {
  try {
    const parsed = JSON.parse(value) as Partial<ProxyHealthState>;
    return {
      consecutiveFailures: Number(parsed.consecutiveFailures) || 0,
      coolingDownUntil: typeof parsed.coolingDownUntil === 'string' ? parsed.coolingDownUntil : null,
    };
  } catch {
    return defaultProxyHealth();
  }
}

function defaultProxyHealth(): ProxyHealthState {
  return { consecutiveFailures: 0, coolingDownUntil: null };
}

function normalizePaymentHandler(value: unknown): PaymentHandler {
  return value === 'OUTSOURCED_BUYER_API' ? 'OUTSOURCED_BUYER_API' : 'LOCAL_WORKER';
}

function normalizeOutsourcedBuyerApiBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new AppError(400, '外包 API 地址格式不正确', 'OUTSOURCED_API_URL_INVALID');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(400, '外包 API 地址必须是 http 或 https', 'OUTSOURCED_API_URL_INVALID');
  }

  parsed.hash = '';
  parsed.search = '';
  if (parsed.pathname.replace(/\/+$/, '') === '/buyer') {
    parsed.pathname = '/';
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeActivationCodePool(value: string): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const code = line.trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

function decodeOutsourcedActivationCodePool(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(decrypt)
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
}

async function migrateLegacyOutsourcedActivationCodePool(): Promise<void> {
  const legacySetting = await prisma.systemSetting.findUnique({ where: { key: OUTSOURCED_ACTIVATION_CODE_POOL_KEY } });
  if (!legacySetting?.value.trim()) return;

  const activationCodes = decodeOutsourcedActivationCodePool(legacySetting.value);
  if (activationCodes.length > 0) {
    await importOutsourcedActivationCodes({
      codesText: activationCodes.join('\n'),
      batchLabel: 'legacy-outsourced-import',
    });
  }
  await prisma.systemSetting.deleteMany({ where: { key: OUTSOURCED_ACTIVATION_CODE_POOL_KEY } });
}

function paymentProcessingView(
  config: PaymentProcessingConfig,
  activationCodeSummary?: { count: number; preview: string[] },
): PaymentProcessingSettingView {
  return {
    handler: config.handler,
    outsourcedBuyerApiBaseUrl: config.outsourcedBuyerApiBaseUrl,
    outsourcedActivationCodeCount: activationCodeSummary?.count ?? config.outsourcedActivationCodes.length,
    outsourcedActivationCodePreview: activationCodeSummary?.preview ?? config.outsourcedActivationCodes.map(maskActivationCode),
  };
}

function maskActivationCode(code: string): string {
  if (code.length <= 6) return '****';
  return `${code.slice(0, 4)}...${code.slice(-3)}`;
}

function proxyPoolKey(poolName: ProxyPoolName): string {
  return poolName === 'chatgpt' ? CHATGPT_PROXY_POOL_KEY : STRIPE_PROXY_POOL_KEY;
}

function proxyHealthKey(poolName: ProxyPoolName, proxyIdValue: string): string {
  return `proxy_health:${poolName}:${proxyIdValue}`;
}

function proxyId(host: string, port: number, username: string): string {
  return createHash('sha256').update(`${host}:${port}:${username}`).digest('hex').slice(0, 16);
}

function isValidProxyHost(host: string): boolean {
  if (host.length > 253) return false;
  return host.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
