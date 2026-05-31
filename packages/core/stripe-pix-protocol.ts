import { randomUUID } from 'node:crypto';
import { ProxyAgent } from 'undici';
import { normalizeBrazilState, type BrazilBillingProfile } from './brazil-profile.ts';

export const DEFAULT_STRIPE_PUBLISHABLE_KEY =
  'pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n';
export const DEFAULT_STRIPE_VERSION = '2020-08-27;custom_checkout_beta=v1';
export const DEFAULT_STRIPE_JS_VERSION = '922d612e68';
export const DEFAULT_PAYMENT_USER_AGENT = `stripe.js/${DEFAULT_STRIPE_JS_VERSION}; stripe-js-v3/${DEFAULT_STRIPE_JS_VERSION}; checkout`;

export interface StripeRuntimeIdentifiers {
  guid: string;
  muid: string;
  sid: string;
}

export interface StripeRiskFields {
  initChecksum: string;
  jsChecksum: string;
  px3: string;
  pxvid: string;
  pxcts: string;
  passiveCaptchaToken: string;
  passiveCaptchaEkey: string;
  rvTimestamp: string;
}

export interface StripeAttributionMetadata {
  clientSessionId: string;
  checkoutConfigId?: string;
}

export interface BuildPaymentMethodRequestBodyInput extends StripeAttributionMetadata {
  checkoutSessionId: string;
  identifiers: StripeRuntimeIdentifiers;
  profile: BrazilBillingProfile;
  stripePublishableKey?: string;
  stripeVersion?: string;
  paymentUserAgent?: string;
}

export interface BuildPaymentPageRequestBodyInput {
  profile: BrazilBillingProfile;
  stripePublishableKey?: string;
}

export interface BuildConfirmRequestBodyInput extends StripeAttributionMetadata {
  checkoutSessionId: string;
  paymentMethodId: string;
  returnUrl: string;
  identifiers: StripeRuntimeIdentifiers;
  riskFields: StripeRiskFields;
  expectedAmount?: number;
  stripePublishableKey?: string;
  stripeVersion?: string;
  stripeJsVersion?: string;
}

export interface PixQrArtifact {
  data: string;
  hostedInstructionsUrl?: string;
  imageUrlPng?: string;
  expiresAt?: number;
  setupIntentId?: string;
  setupIntentStatus?: string;
}

export interface CreateStripePixPaymentInput extends StripeAttributionMetadata {
  checkoutUrl: string;
  identifiers?: StripeRuntimeIdentifiers;
  profile: BrazilBillingProfile;
  riskFields: StripeRiskFields;
  timeoutMs?: number;
  proxyUrl?: string;
  retry?: StripeRetryOptions;
  transport?: StripeHttpTransport;
}

export interface CreateDirectStripePixPaymentInput {
  checkoutUrl: string;
  profile: BrazilBillingProfile;
  identifiers?: StripeRuntimeIdentifiers;
  clientSessionId?: string;
  riskFields?: Partial<StripeRiskFields>;
  timeoutMs?: number;
  proxyUrl?: string;
  retry?: StripeRetryOptions;
  transport?: StripeHttpTransport;
}

export interface CreateStripePixPaymentResult {
  checkoutSessionId: string;
  paymentMethodId: string;
  pix: PixQrArtifact;
  checkoutConfigId?: string;
}

export interface StripeHttpTransport {
  postForm(url: string, body: URLSearchParams, options?: { timeoutMs?: number }): Promise<unknown>;
}

export interface StripeRetryOptions {
  attempts: number;
  backoffMs?: number[];
}

export class StripePixProtocolError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

export function parseCheckoutSessionId(url: string): string {
  const decodedUrl = decodeURIComponent(url);
  const match =
    decodedUrl.match(/\/c\/pay\/(cs_(?:live|test)_[^/?#]+)/) ??
    decodedUrl.match(/\/v1\/payment_pages\/(cs_(?:live|test)_[^/?#]+)\/confirm/);

  if (!match?.[1]) throw new Error('Checkout session id not found in URL');
  return match[1];
}

export function createStripeRuntimeIdentifiers(): StripeRuntimeIdentifiers {
  return {
    guid: `${randomUUID()}${randomNumericSuffix()}`,
    muid: `${randomUUID()}${randomNumericSuffix()}`,
    sid: `${randomUUID()}${randomNumericSuffix()}`,
  };
}

export function buildPaymentPageRequestBody(input: BuildPaymentPageRequestBodyInput): URLSearchParams {
  const body = new URLSearchParams();
  body.set('eid', 'NA');
  body.set('tax_region[country]', input.profile.address.country);
  body.set('tax_region[state]', normalizeBrazilState(input.profile.address.state));
  body.set('tax_region[postal_code]', input.profile.address.postalCode);
  body.set('tax_region[line1]', input.profile.address.line1);
  body.set('tax_region[city]', input.profile.address.city);
  body.set('key', input.stripePublishableKey ?? DEFAULT_STRIPE_PUBLISHABLE_KEY);
  return body;
}

export function buildPaymentMethodRequestBody(input: BuildPaymentMethodRequestBodyInput): URLSearchParams {
  const body = new URLSearchParams();
  const stateCode = normalizeBrazilState(input.profile.address.state);

  body.set('type', 'pix');
  body.set('billing_details[name]', input.profile.name);
  body.set('billing_details[email]', input.profile.email);
  body.set('billing_details[address][country]', input.profile.address.country);
  body.set('billing_details[address][line1]', input.profile.address.line1);
  body.set('billing_details[address][city]', input.profile.address.city);
  body.set('billing_details[address][postal_code]', input.profile.address.postalCode);
  body.set('billing_details[address][state]', stateCode);
  body.set('billing_details[tax_id]', input.profile.cpf);
  appendRuntimeFields(body, input.identifiers, input.stripePublishableKey, input.stripeVersion);
  body.set('payment_user_agent', input.paymentUserAgent ?? DEFAULT_PAYMENT_USER_AGENT);
  appendAttributionFields(body, input.checkoutSessionId, input.clientSessionId, input.checkoutConfigId);
  return body;
}

export function buildConfirmRequestBody(input: BuildConfirmRequestBodyInput): URLSearchParams {
  const body = new URLSearchParams();
  body.set('eid', 'NA');
  body.set('payment_method', input.paymentMethodId);
  body.set('expected_amount', String(input.expectedAmount ?? 0));
  body.set('consent[terms_of_service]', 'accepted');
  body.set('expected_payment_method_type', 'pix');
  body.set('return_url', input.returnUrl);
  appendRuntimeFields(body, input.identifiers, input.stripePublishableKey, input.stripeVersion);
  body.set('version', input.stripeJsVersion ?? DEFAULT_STRIPE_JS_VERSION);
  appendRiskFields(body, input.riskFields);
  appendAttributionFields(body, input.checkoutSessionId, input.clientSessionId, input.checkoutConfigId);
  body.set('link_brand', 'link');
  return body;
}

export function extractPaymentMethodId(response: unknown): string {
  const record = asRecord(response);
  const id = String(record.id ?? '');
  const type = String(record.type ?? '');
  if (!id.startsWith('pm_') || type !== 'pix') {
    throw new Error('Pix payment method id not found in Stripe response');
  }
  return id;
}

export function extractPixQrArtifact(response: unknown): PixQrArtifact {
  const root = asRecord(response);
  const setupIntent = asRecord(root.setup_intent ?? root);
  const nextAction = asRecord(setupIntent.next_action ?? root.next_action);
  const qrCode = asRecord(nextAction.pix_display_qr_code ?? nextAction);
  const data = typeof qrCode.data === 'string' ? qrCode.data : '';

  if (!data.startsWith('000201')) {
    throw new Error('Pix QR code payload not found in Stripe response');
  }

  return {
    data,
    hostedInstructionsUrl: optionalString(qrCode.hosted_instructions_url),
    imageUrlPng: optionalString(qrCode.image_url_png),
    expiresAt: optionalNumber(qrCode.expires_at),
    setupIntentId: optionalString(setupIntent.id),
    setupIntentStatus: optionalString(setupIntent.status),
  };
}

export async function createStripePixPayment(input: CreateStripePixPaymentInput): Promise<CreateStripePixPaymentResult> {
  const checkoutSessionId = parseCheckoutSessionId(input.checkoutUrl);
  const identifiers = input.identifiers ?? createStripeRuntimeIdentifiers();
  const transport = input.transport ?? new FetchStripeHttpTransport({ proxyUrl: input.proxyUrl, retry: input.retry });

  const paymentMethodBody = buildPaymentMethodRequestBody({
    checkoutSessionId,
    clientSessionId: input.clientSessionId,
    checkoutConfigId: input.checkoutConfigId,
    identifiers,
    profile: input.profile,
  });
  const requestOptions = { timeoutMs: input.timeoutMs ?? 30_000 };
  const paymentMethodResponse = await transport.postForm('https://api.stripe.com/v1/payment_methods', paymentMethodBody, requestOptions);
  const paymentMethodId = extractPaymentMethodId(paymentMethodResponse);

  const confirmBody = buildConfirmRequestBody({
    checkoutSessionId,
    paymentMethodId,
    returnUrl: input.checkoutUrl,
    clientSessionId: input.clientSessionId,
    checkoutConfigId: input.checkoutConfigId,
    identifiers,
    riskFields: input.riskFields,
    expectedAmount: 0,
  });
  const confirmResponse = await transport.postForm(
    `https://api.stripe.com/v1/payment_pages/${checkoutSessionId}/confirm`,
    confirmBody,
    requestOptions,
  );

  return {
    checkoutSessionId,
    paymentMethodId,
    pix: extractPixQrArtifact(confirmResponse),
    checkoutConfigId: input.checkoutConfigId,
  };
}

export async function createDirectStripePixPayment(
  input: CreateDirectStripePixPaymentInput,
): Promise<CreateStripePixPaymentResult> {
  const checkoutSessionId = parseCheckoutSessionId(input.checkoutUrl);
  const identifiers = input.identifiers ?? createStripeRuntimeIdentifiers();
  const clientSessionId = input.clientSessionId ?? randomUUID();
  const transport = input.transport ?? new FetchStripeHttpTransport({ proxyUrl: input.proxyUrl, retry: input.retry });
  const requestOptions = { timeoutMs: input.timeoutMs ?? 30_000 };

  const paymentPageResponse = await transport.postForm(
    `https://api.stripe.com/v1/payment_pages/${checkoutSessionId}`,
    buildPaymentPageRequestBody({ profile: input.profile }),
    requestOptions,
  );
  const checkoutConfigId = optionalString(asRecord(paymentPageResponse).config_id);
  const initChecksum = optionalString(asRecord(paymentPageResponse).init_checksum);
  const payableAmount = extractPaymentPagePayableAmount(paymentPageResponse);
  if (payableAmount > 0) {
    throw new StripePixProtocolError(400, '账号无资格，无法生成 Pix 支付', 'ACCOUNT_NOT_ELIGIBLE');
  }

  const paymentMethodResponse = await transport.postForm(
    'https://api.stripe.com/v1/payment_methods',
    buildPaymentMethodRequestBody({
      checkoutSessionId,
      clientSessionId,
      checkoutConfigId,
      identifiers,
      profile: input.profile,
    }),
    requestOptions,
  );
  const paymentMethodId = extractPaymentMethodId(paymentMethodResponse);

  const confirmResponse = await transport.postForm(
    `https://api.stripe.com/v1/payment_pages/${checkoutSessionId}/confirm`,
    buildConfirmRequestBody({
      checkoutSessionId,
      paymentMethodId,
      returnUrl: input.checkoutUrl,
      clientSessionId,
      checkoutConfigId,
      identifiers,
      riskFields: completeRiskFields(input.riskFields, initChecksum),
      expectedAmount: payableAmount,
    }),
    requestOptions,
  );

  return {
    checkoutSessionId,
    checkoutConfigId,
    paymentMethodId,
    pix: extractPixQrArtifact(confirmResponse),
  };
}

export function urlSearchParamsToObject(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(params.entries());
}

function appendRuntimeFields(
  body: URLSearchParams,
  identifiers: StripeRuntimeIdentifiers,
  stripePublishableKey = DEFAULT_STRIPE_PUBLISHABLE_KEY,
  stripeVersion = DEFAULT_STRIPE_VERSION,
): void {
  body.set('guid', identifiers.guid);
  body.set('muid', identifiers.muid);
  body.set('sid', identifiers.sid);
  body.set('_stripe_version', stripeVersion);
  body.set('key', stripePublishableKey);
}

function appendRiskFields(body: URLSearchParams, riskFields: StripeRiskFields): void {
  appendNonEmpty(body, 'init_checksum', riskFields.initChecksum);
  appendNonEmpty(body, 'js_checksum', riskFields.jsChecksum);
  appendNonEmpty(body, 'px3', riskFields.px3);
  appendNonEmpty(body, 'pxvid', riskFields.pxvid);
  appendNonEmpty(body, 'pxcts', riskFields.pxcts);
  appendNonEmpty(body, 'passive_captcha_token', riskFields.passiveCaptchaToken);
  appendNonEmpty(body, 'passive_captcha_ekey', riskFields.passiveCaptchaEkey);
  appendNonEmpty(body, 'rv_timestamp', riskFields.rvTimestamp);
}

function appendAttributionFields(
  body: URLSearchParams,
  checkoutSessionId: string,
  clientSessionId: string,
  checkoutConfigId?: string,
): void {
  body.set('client_attribution_metadata[client_session_id]', clientSessionId);
  body.set('client_attribution_metadata[checkout_session_id]', checkoutSessionId);
  body.set('client_attribution_metadata[merchant_integration_source]', 'checkout');
  body.set('client_attribution_metadata[merchant_integration_version]', 'hosted_checkout');
  body.set('client_attribution_metadata[payment_method_selection_flow]', 'automatic');
  if (checkoutConfigId) body.set('client_attribution_metadata[checkout_config_id]', checkoutConfigId);
}

function appendNonEmpty(body: URLSearchParams, key: string, value: string): void {
  if (value !== '') body.set(key, value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function extractPaymentPagePayableAmount(response: unknown): number {
  const root = asRecord(response);
  const invoice = asRecord(root.invoice);
  const totalSummary = asRecord(root.total_summary);

  const amount =
    optionalNumber(invoice.amount_due) ??
    optionalNumber(invoice.total) ??
    optionalNumber(totalSummary.total);

  if (amount === undefined || !Number.isFinite(amount)) {
    throw new StripePixProtocolError(502, '支付创建失败，请稍后重试', 'PAYMENT_FAILED');
  }

  return amount;
}

function completeRiskFields(riskFields: Partial<StripeRiskFields> | undefined, initChecksum: string | undefined): StripeRiskFields {
  return {
    initChecksum: riskFields?.initChecksum ?? initChecksum ?? '',
    jsChecksum: riskFields?.jsChecksum ?? '',
    px3: riskFields?.px3 ?? '',
    pxvid: riskFields?.pxvid ?? '',
    pxcts: riskFields?.pxcts ?? '',
    passiveCaptchaToken: riskFields?.passiveCaptchaToken ?? '',
    passiveCaptchaEkey: riskFields?.passiveCaptchaEkey ?? '',
    rvTimestamp: riskFields?.rvTimestamp ?? '',
  };
}

function randomNumericSuffix(): string {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

interface FetchStripeHttpTransportOptions {
  proxyUrl?: string;
  retry?: StripeRetryOptions;
}

type RequestInitWithDispatcher = RequestInit & { dispatcher?: unknown };

class FetchStripeHttpTransport implements StripeHttpTransport {
  private readonly proxyAgent: ProxyAgent | null;
  private readonly retry: Required<StripeRetryOptions>;

  constructor(options: FetchStripeHttpTransportOptions = {}) {
    this.proxyAgent = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : null;
    this.retry = {
      attempts: Math.max(1, options.retry?.attempts ?? 1),
      backoffMs: options.retry?.backoffMs ?? [500, 1500, 3000],
    };
  }

  async postForm(url: string, body: URLSearchParams, options: { timeoutMs?: number } = {}): Promise<unknown> {
    const response = await this.fetchWithRetry(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          origin: 'https://pay.openai.com',
          referer: 'https://pay.openai.com/',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        },
        body,
      },
      options.timeoutMs ?? 30_000,
    );

    const text = await response.text();
    if (!response.ok) {
      throw stripeResponseError(response.status, text);
    }

    return JSON.parse(text) as unknown;
  }

  private async fetchWithRetry(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
      try {
        const response = await fetchWithTimeout(url, init, timeoutMs, this.proxyAgent);
        if (!response.ok && isRetryableHttpStatus(response.status) && attempt < this.retry.attempts) {
          await response.text().catch(() => '');
          logRetry('Stripe', url, attempt, this.retry.attempts, this.proxyAgent !== null, response.status);
          await delay(this.retry.backoffMs[attempt - 1] ?? this.retry.backoffMs.at(-1) ?? 0);
          continue;
        }
        return response;
      } catch (error) {
        lastError = normalizeFetchError(error);
        if (!isRetryableFetchError(lastError) || attempt >= this.retry.attempts) {
          throw lastError;
        }
        logRetry('Stripe', url, attempt, this.retry.attempts, this.proxyAgent !== null);
        await delay(this.retry.backoffMs[attempt - 1] ?? this.retry.backoffMs.at(-1) ?? 0);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Stripe request failed');
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  proxyAgent: ProxyAgent | null,
): Promise<Response> {
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

function stripeResponseError(status: number, text: string): Error {
  const stripeCode = readStripeErrorCode(text);
  if (status === 400 && stripeCode === 'checkout_amount_mismatch') {
    return new StripePixProtocolError(400, '账号无资格，无法生成 Pix 支付', 'ACCOUNT_NOT_ELIGIBLE');
  }

  return new Error(`Stripe request failed: ${status} ${text.slice(0, 500)}`);
}

function readStripeErrorCode(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === 'string' ? parsed.error.code : null;
  } catch {
    return null;
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof StripePixProtocolError) return error.code === 'UPSTREAM_TIMEOUT';
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError');
}

function normalizeFetchError(error: unknown): unknown {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new StripePixProtocolError(504, '外部服务请求超时，请稍后重试', 'UPSTREAM_TIMEOUT');
  }
  return error;
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
