import { randomUUID } from 'node:crypto';
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
  transport?: StripeHttpTransport;
}

export interface CreateDirectStripePixPaymentInput {
  checkoutUrl: string;
  profile: BrazilBillingProfile;
  identifiers?: StripeRuntimeIdentifiers;
  clientSessionId?: string;
  riskFields?: Partial<StripeRiskFields>;
  transport?: StripeHttpTransport;
}

export interface CreateStripePixPaymentResult {
  checkoutSessionId: string;
  paymentMethodId: string;
  pix: PixQrArtifact;
  checkoutConfigId?: string;
}

export interface StripeHttpTransport {
  postForm(url: string, body: URLSearchParams): Promise<unknown>;
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
  const transport = input.transport ?? new FetchStripeHttpTransport();

  const paymentMethodBody = buildPaymentMethodRequestBody({
    checkoutSessionId,
    clientSessionId: input.clientSessionId,
    checkoutConfigId: input.checkoutConfigId,
    identifiers,
    profile: input.profile,
  });
  const paymentMethodResponse = await transport.postForm('https://api.stripe.com/v1/payment_methods', paymentMethodBody);
  const paymentMethodId = extractPaymentMethodId(paymentMethodResponse);

  const confirmBody = buildConfirmRequestBody({
    checkoutSessionId,
    paymentMethodId,
    returnUrl: input.checkoutUrl,
    clientSessionId: input.clientSessionId,
    checkoutConfigId: input.checkoutConfigId,
    identifiers,
    riskFields: input.riskFields,
  });
  const confirmResponse = await transport.postForm(
    `https://api.stripe.com/v1/payment_pages/${checkoutSessionId}/confirm`,
    confirmBody,
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
  const transport = input.transport ?? new FetchStripeHttpTransport();

  const paymentPageResponse = await transport.postForm(
    `https://api.stripe.com/v1/payment_pages/${checkoutSessionId}`,
    buildPaymentPageRequestBody({ profile: input.profile }),
  );
  const checkoutConfigId = optionalString(asRecord(paymentPageResponse).config_id);
  const initChecksum = optionalString(asRecord(paymentPageResponse).init_checksum);

  const paymentMethodResponse = await transport.postForm(
    'https://api.stripe.com/v1/payment_methods',
    buildPaymentMethodRequestBody({
      checkoutSessionId,
      clientSessionId,
      checkoutConfigId,
      identifiers,
      profile: input.profile,
    }),
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
    }),
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

class FetchStripeHttpTransport implements StripeHttpTransport {
  async postForm(url: string, body: URLSearchParams): Promise<unknown> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        origin: 'https://pay.openai.com',
        referer: 'https://pay.openai.com/',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      },
      body,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Stripe request failed: ${response.status} ${text.slice(0, 500)}`);
    }

    return JSON.parse(text) as unknown;
  }
}
