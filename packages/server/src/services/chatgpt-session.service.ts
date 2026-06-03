import { ProxyAgent } from 'undici';
import { parseCheckoutSessionId } from '@pix/core';
import { AppError } from '../middleware/error-handler.ts';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const OAIPAY_LONG_LINK_URL = process.env.OAIPAY_LONG_LINK_URL?.trim() || 'https://oaipay.im-run.com/api/long-link';
const DEFAULT_TIMEOUT_MS = 30_000;
const SESSION_UNRECOGNIZED_MESSAGE =
  '无法识别 ChatGPT Session，请粘贴 accessToken，或包含 accessToken/access_token/at 的 session JSON';
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
  { kind: 'access_token'; accessToken: string };

interface OaiPayLongLinkResponse {
  ok?: unknown;
  stripe_hosted_url?: unknown;
  long_url?: unknown;
  provider_error?: unknown;
}

export function isAccessToken(session: string): boolean {
  return isCompactJwt(session.trim());
}

export function parseChatGptSessionInput(input: string): ChatGptSessionCredential {
  const sessionInput = input.trim();
  if (!sessionInput) throw unrecognizedSessionError();

  const jsonCredential = parseJsonSessionCredential(sessionInput);
  if (jsonCredential) return jsonCredential;

  if (isCompactJwt(sessionInput)) {
    return { kind: 'access_token', accessToken: sessionInput };
  }

  throw unrecognizedSessionError();
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

  for (const fieldName of ['accessToken', 'access_token', 'at']) {
    const accessToken = readNonEmptyString(parsed[fieldName]);
    if (!accessToken) continue;
    if (isCompactJwt(accessToken)) {
      return { kind: 'access_token', accessToken };
    }
    throw unrecognizedSessionError();
  }

  throw unrecognizedSessionError();
}

function isCompactJwt(value: string): boolean {
  const parts = value.split('.');
  return value.startsWith('eyJ') && parts.length === 3 && parts.every((part) => part.length > 0);
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
  const response = await fetchWithTimeout(OAIPAY_LONG_LINK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify(buildOaiPayLongLinkRequest(accessToken, options.proxyUrl)),
  }, options, 'oaipay');

  if (!response.ok) {
    throw checkoutFailedError(response.status, await safeResponseText(response));
  }

  const data = await readOaiPayLongLinkResponse(response);
  if (data.ok !== true) {
    throw checkoutFailedError(response.status, readProviderError(data));
  }

  return selectCheckoutUrl(data);
}

function buildOaiPayLongLinkRequest(accessToken: string, proxyUrl: string | null) {
  return {
    accessToken,
    link_type: 'hosted',
    proxy: proxyUrl ?? '',
    billing_country: 'BR',
    checkout_ui_mode: 'hosted',
    payment_locale: 'pt-BR',
    stripe_publishable_key: '',
    device_id: '',
    user_agent: USER_AGENT,
  };
}

async function readOaiPayLongLinkResponse(response: Response): Promise<OaiPayLongLinkResponse> {
  try {
    const data = await response.json();
    return isRecord(data) ? data : {};
  } catch (error) {
    throw checkoutFailedError(response.status, error instanceof Error ? error.message : null);
  }
}

function selectCheckoutUrl(response: OaiPayLongLinkResponse): string {
  for (const candidate of [response.stripe_hosted_url, response.long_url]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const checkoutUrl = candidate.trim();
    if (isSupportedCheckoutUrl(checkoutUrl)) return checkoutUrl;
  }

  throw checkoutFailedError(502, 'oaipay response did not include a supported checkout URL');
}

function isSupportedCheckoutUrl(url: string): boolean {
  try {
    parseCheckoutSessionId(url);
  } catch {
    return false;
  }

  const decodedUrl = decodeURIComponent(url);
  return (
    /pay\.openai\.com\/c\/pay\/cs_(?:live|test)_/i.test(decodedUrl) ||
    /api\.stripe\.com\/v1\/payment_pages\/cs_(?:live|test)_[^/?#]+\/confirm/i.test(decodedUrl)
  );
}

function readProviderError(response: OaiPayLongLinkResponse): string | null {
  const providerError = response.provider_error;
  return typeof providerError === 'string' && providerError.trim() ? providerError.trim() : null;
}

async function safeResponseText(response: Response): Promise<string | null> {
  return response.text().catch(() => null);
}

function checkoutFailedError(httpStatus: number, detail: string | null): AppError {
  return new AppError(502, CHECKOUT_FAILED_MESSAGE, 'CHATGPT_CHECKOUT_FAILED', {
    httpStatus,
    message: detail,
  });
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

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  options: Required<UpstreamRequestOptions>,
  service: string,
): Promise<Response> {
  const proxyAgent = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : null;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.retry.attempts; attempt += 1) {
    try {
      const response = await fetchOnce(url, init, options.timeoutMs, proxyAgent);
      if (!response.ok && isRetryableHttpStatus(response.status) && attempt < options.retry.attempts) {
        await response.text().catch(() => '');
        logRetry(service, url, attempt, options.retry.attempts, proxyAgent !== null, response.status);
        await delay(options.retry.backoffMs?.[attempt - 1] ?? options.retry.backoffMs?.at(-1) ?? 0);
        continue;
      }
      return response;
    } catch (error) {
      lastError = normalizeFetchError(error);
      if (!isRetryableFetchError(lastError) || attempt >= options.retry.attempts) {
        throw lastError;
      }
      logRetry(service, url, attempt, options.retry.attempts, proxyAgent !== null);
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
