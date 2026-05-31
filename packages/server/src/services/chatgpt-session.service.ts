import { ProxyAgent } from 'undici';
import { AppError } from '../middleware/error-handler.ts';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const CHECKOUT_PAYLOAD = {
  entry_point: 'all_plans_pricing_modal',
  plan_name: 'chatgptplusplan',
  billing_details: { country: 'BR', currency: 'BRL' },
  promo_campaign: {
    promo_campaign_id: 'plus-1-month-free',
    is_coupon_from_query_param: false,
  },
  checkout_ui_mode: 'redirect',
};

const DEFAULT_TIMEOUT_MS = 30_000;
const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';
const SESSION_UNRECOGNIZED_MESSAGE =
  '无法识别 ChatGPT Session，请粘贴完整 session JSON、accessToken 或 session cookie';
const SESSION_FAILED_MESSAGE = '无法验证 ChatGPT Session，请稍后重试';
const CHECKOUT_FAILED_MESSAGE = '无法创建 ChatGPT 结算链接，请稍后重试';
const UPSTREAM_TIMEOUT_MESSAGE = '外部服务请求超时，请稍后重试';

export interface UpstreamRetryOptions {
  attempts: number;
  backoffMs?: number[];
}

export interface UpstreamRequestOptions {
  timeoutMs?: number;
  proxyUrl?: string | null;
  retry?: UpstreamRetryOptions;
}

export type ChatGptSessionCredential =
  | { kind: 'access_token'; accessToken: string }
  | { kind: 'session_token'; sessionToken: string };

export function isAccessToken(session: string): boolean {
  return isCompactJwt(session.trim());
}

export function parseChatGptSessionInput(input: string): ChatGptSessionCredential {
  const sessionInput = input.trim();
  if (!sessionInput) throw unrecognizedSessionError();

  const jsonCredential = parseJsonSessionCredential(sessionInput);
  if (jsonCredential) return jsonCredential;

  const cookieSessionToken = extractSessionCookie(sessionInput);
  if (cookieSessionToken) {
    return { kind: 'session_token', sessionToken: cookieSessionToken };
  }

  if (isCompactJwt(sessionInput)) {
    return { kind: 'access_token', accessToken: sessionInput };
  }

  if (isCompactJwe(sessionInput) || isBareSessionToken(sessionInput)) {
    return { kind: 'session_token', sessionToken: sessionInput };
  }

  throw unrecognizedSessionError();
}

export async function resolveAccessToken(
  session: string | ChatGptSessionCredential,
  requestOptions: number | UpstreamRequestOptions = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const credential = typeof session === 'string' ? parseChatGptSessionInput(session) : session;
  if (credential.kind === 'access_token') {
    return credential.accessToken;
  }
  const options = normalizeRequestOptions(requestOptions);

  const response = await fetchWithTimeout('https://chatgpt.com/api/auth/session', {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${credential.sessionToken}`,
      'user-agent': USER_AGENT,
    },
  }, options);

  if (!response.ok) {
    throw new AppError(502, SESSION_FAILED_MESSAGE, 'CHATGPT_SESSION_FAILED');
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.accessToken !== 'string' || !data.accessToken) {
    throw new AppError(502, SESSION_FAILED_MESSAGE, 'CHATGPT_SESSION_FAILED');
  }

  return data.accessToken;
}

function parseJsonSessionCredential(input: string): ChatGptSessionCredential | null {
  if (!input.startsWith('{')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw unrecognizedSessionError();
  }

  if (!isRecord(parsed)) throw unrecognizedSessionError();

  const accessToken = readNonEmptyString(parsed.accessToken);
  if (accessToken && isCompactJwt(accessToken)) {
    return { kind: 'access_token', accessToken };
  }

  const sessionToken = readNonEmptyString(parsed.sessionToken);
  if (sessionToken && (isCompactJwe(sessionToken) || isBareSessionToken(sessionToken))) {
    return { kind: 'session_token', sessionToken };
  }

  throw unrecognizedSessionError();
}

function extractSessionCookie(input: string): string | null {
  const cookieHeader = input.replace(/^cookie:\s*/i, '');
  for (const cookiePart of cookieHeader.split(';')) {
    const separatorIndex = cookiePart.indexOf('=');
    if (separatorIndex === -1) continue;

    const name = cookiePart.slice(0, separatorIndex).trim();
    if (name !== SESSION_COOKIE_NAME) continue;

    const value = cookiePart.slice(separatorIndex + 1).trim();
    return value ? safeDecodeURIComponent(value) : null;
  }

  return null;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isCompactJwt(value: string): boolean {
  const parts = value.split('.');
  return value.startsWith('eyJ') && parts.length === 3 && parts.every((part) => part.length > 0);
}

function isCompactJwe(value: string): boolean {
  const parts = value.split('.');
  return (
    value.startsWith('eyJ') &&
    parts.length === 5 &&
    parts[0].length > 0 &&
    parts[2].length > 0 &&
    parts[3].length > 0 &&
    parts[4].length > 0
  );
}

function isBareSessionToken(value: string): boolean {
  return value.length >= 20 && !/[\s{};]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function unrecognizedSessionError(): AppError {
  return new AppError(400, SESSION_UNRECOGNIZED_MESSAGE, 'CHATGPT_SESSION_UNRECOGNIZED');
}

export async function createCheckoutUrl(
  accessToken: string,
  requestOptions: number | UpstreamRequestOptions = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const options = normalizeRequestOptions(requestOptions);
  const response = await fetchWithTimeout('https://chatgpt.com/backend-api/payments/checkout', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify(CHECKOUT_PAYLOAD),
  }, options);

  if (!response.ok) {
    throw new AppError(502, CHECKOUT_FAILED_MESSAGE, 'CHATGPT_CHECKOUT_FAILED');
  }

  const data = (await response.json()) as Record<string, unknown>;
  const url = data.url ?? data.checkout_url ?? data.redirect_url;
  if (typeof url !== 'string' || !url) {
    throw new AppError(502, CHECKOUT_FAILED_MESSAGE, 'CHATGPT_CHECKOUT_FAILED');
  }

  return url;
}

type RequestInitWithDispatcher = RequestInit & { dispatcher?: unknown };

function normalizeRequestOptions(options: number | UpstreamRequestOptions): Required<UpstreamRequestOptions> {
  if (typeof options === 'number') {
    return {
      timeoutMs: options,
      proxyUrl: null,
      retry: { attempts: 1, backoffMs: [500, 1500, 3000] },
    };
  }

  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    proxyUrl: options.proxyUrl ?? null,
    retry: {
      attempts: Math.max(1, options.retry?.attempts ?? 1),
      backoffMs: options.retry?.backoffMs ?? [500, 1500, 3000],
    },
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, options: Required<UpstreamRequestOptions>): Promise<Response> {
  const proxyAgent = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : null;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.retry.attempts; attempt += 1) {
    try {
      const response = await fetchOnce(url, init, options.timeoutMs, proxyAgent);
      if (!response.ok && isRetryableHttpStatus(response.status) && attempt < options.retry.attempts) {
        await response.text().catch(() => '');
        logRetry('ChatGPT', url, attempt, options.retry.attempts, proxyAgent !== null, response.status);
        await delay(options.retry.backoffMs?.[attempt - 1] ?? options.retry.backoffMs?.at(-1) ?? 0);
        continue;
      }
      return response;
    } catch (error) {
      lastError = normalizeFetchError(error);
      if (!isRetryableFetchError(lastError) || attempt >= options.retry.attempts) {
        throw lastError;
      }
      logRetry('ChatGPT', url, attempt, options.retry.attempts, proxyAgent !== null);
      await delay(options.retry.backoffMs?.[attempt - 1] ?? options.retry.backoffMs?.at(-1) ?? 0);
    }
  }

  throw lastError instanceof Error ? lastError : new AppError(502, CHECKOUT_FAILED_MESSAGE, 'CHATGPT_CHECKOUT_FAILED');
}

async function fetchOnce(url: string, init: RequestInit, timeoutMs: number, proxyAgent: ProxyAgent | null): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestInit: RequestInitWithDispatcher = { ...init, signal: controller.signal };
    if (proxyAgent) requestInit.dispatcher = proxyAgent;
    return await fetch(url, requestInit);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeFetchError(error: unknown): unknown {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AppError(504, UPSTREAM_TIMEOUT_MESSAGE, 'UPSTREAM_TIMEOUT');
  }
  return error;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'UPSTREAM_TIMEOUT';
  return error instanceof TypeError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logRetry(service: string, url: string, attempt: number, attempts: number, proxyEnabled: boolean, status?: number): void {
  const host = new URL(url).hostname;
  console.warn(
    `${service} request retry ${attempt}/${attempts} host=${host} proxy=${proxyEnabled ? 'enabled' : 'disabled'}${
      status ? ` status=${status}` : ''
    }`,
  );
}
