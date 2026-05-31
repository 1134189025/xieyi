import { readFile } from 'node:fs/promises';
import { normalizeBrazilState, type BrazilBillingProfile } from './brazil-profile.ts';
import {
  extractPaymentMethodId,
  extractPixQrArtifact,
  parseCheckoutSessionId,
  type PixQrArtifact,
  type StripeRiskFields,
  type StripeRuntimeIdentifiers,
} from './stripe-pix-protocol.ts';

export interface ExtractedStripePixProtocol {
  checkoutSessionId: string;
  paymentMethodId: string;
  returnUrl: string;
  profile: BrazilBillingProfile;
  identifiers: StripeRuntimeIdentifiers;
  clientSessionId: string;
  checkoutConfigId?: string;
  stripePublishableKey: string;
  riskFields: StripeRiskFields;
  pix: PixQrArtifact;
}

export async function loadStripePixProtocolFromHarFile(harPath: string): Promise<ExtractedStripePixProtocol> {
  const raw = await readFile(harPath, 'utf8');
  return extractStripePixProtocolFromHar(JSON.parse(raw) as unknown);
}

export function extractStripePixProtocolFromHar(har: unknown): ExtractedStripePixProtocol {
  const entries = getHarEntries(har);
  const paymentMethodEntry = entries.find((entry) => {
    const request = getRecord(entry.request);
    return request.method === 'POST' && String(request.url).includes('/v1/payment_methods');
  });
  const confirmEntry = entries.find((entry) => {
    const request = getRecord(entry.request);
    return request.method === 'POST' && /\/v1\/payment_pages\/cs_(?:live|test)_[^/]+\/confirm/.test(String(request.url));
  });

  if (!paymentMethodEntry) throw new Error('Stripe payment_methods request not found in HAR');
  if (!confirmEntry) throw new Error('Stripe payment_pages confirm request not found in HAR');

  const paymentMethodRequest = getRecord(paymentMethodEntry.request);
  const confirmRequest = getRecord(confirmEntry.request);
  const paymentMethodParams = parseFormText(getPostDataText(paymentMethodRequest));
  const confirmParams = parseFormText(getPostDataText(confirmRequest));
  const checkoutSessionId =
    readParam(paymentMethodParams, 'client_attribution_metadata[checkout_session_id]') ||
    parseCheckoutSessionId(String(confirmRequest.url));
  const paymentMethodResponse = parseJsonContent(paymentMethodEntry.response);
  const confirmResponse = parseJsonContent(confirmEntry.response);

  return {
    checkoutSessionId,
    paymentMethodId: extractPaymentMethodId(paymentMethodResponse),
    returnUrl: readRequiredParam(confirmParams, 'return_url'),
    profile: extractProfile(paymentMethodParams),
    identifiers: extractIdentifiers(paymentMethodParams, confirmParams),
    clientSessionId: readRequiredParam(paymentMethodParams, 'client_attribution_metadata[client_session_id]'),
    checkoutConfigId: readParam(paymentMethodParams, 'client_attribution_metadata[checkout_config_id]') || undefined,
    stripePublishableKey: readRequiredParam(paymentMethodParams, 'key'),
    riskFields: extractRiskFields(confirmParams),
    pix: extractPixQrArtifact(confirmResponse),
  };
}

function extractProfile(params: URLSearchParams): BrazilBillingProfile {
  return {
    name: readRequiredParam(params, 'billing_details[name]'),
    email: readRequiredParam(params, 'billing_details[email]'),
    cpf: readRequiredParam(params, 'billing_details[tax_id]'),
    address: {
      country: 'BR',
      line1: readRequiredParam(params, 'billing_details[address][line1]'),
      city: readRequiredParam(params, 'billing_details[address][city]'),
      state: normalizeBrazilState(readRequiredParam(params, 'billing_details[address][state]')),
      postalCode: readRequiredParam(params, 'billing_details[address][postal_code]'),
    },
  };
}

function extractIdentifiers(pmParams: URLSearchParams, confirmParams: URLSearchParams): StripeRuntimeIdentifiers {
  return {
    guid: readParam(pmParams, 'guid') || readRequiredParam(confirmParams, 'guid'),
    muid: readParam(pmParams, 'muid') || readRequiredParam(confirmParams, 'muid'),
    sid: readParam(pmParams, 'sid') || readRequiredParam(confirmParams, 'sid'),
  };
}

function extractRiskFields(params: URLSearchParams): StripeRiskFields {
  return {
    initChecksum: readRequiredParam(params, 'init_checksum'),
    jsChecksum: readRequiredParam(params, 'js_checksum'),
    px3: readRequiredParam(params, 'px3'),
    pxvid: readRequiredParam(params, 'pxvid'),
    pxcts: readRequiredParam(params, 'pxcts'),
    passiveCaptchaToken: readRequiredParam(params, 'passive_captcha_token'),
    passiveCaptchaEkey: readParam(params, 'passive_captcha_ekey') ?? '',
    rvTimestamp: readRequiredParam(params, 'rv_timestamp'),
  };
}

function getHarEntries(har: unknown): Array<Record<string, unknown>> {
  const root = getRecord(har);
  const log = getRecord(root.log);
  if (!Array.isArray(log.entries)) throw new Error('Invalid HAR: log.entries is missing');
  return log.entries.map((entry) => getRecord(entry));
}

function getPostDataText(request: Record<string, unknown>): string {
  const postData = getRecord(request.postData);
  if (typeof postData.text !== 'string') throw new Error(`Request body missing for ${String(request.url)}`);
  return postData.text;
}

function parseFormText(text: string): URLSearchParams {
  return new URLSearchParams(text);
}

function parseJsonContent(response: unknown): unknown {
  const responseRecord = getRecord(response);
  const content = getRecord(responseRecord.content);
  const text = typeof content.text === 'string' ? content.text : '';
  const encoding = typeof content.encoding === 'string' ? content.encoding : '';
  const jsonText = encoding.toLowerCase() === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : text;
  if (!jsonText) throw new Error('HAR response JSON content is missing');
  return JSON.parse(jsonText) as unknown;
}

function readRequiredParam(params: URLSearchParams, key: string): string {
  const value = readParam(params, key);
  if (value === null || value === '') throw new Error(`Required Stripe field missing: ${key}`);
  return value;
}

function readParam(params: URLSearchParams, key: string): string | null {
  return params.get(key);
}

function getRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return {};
}
