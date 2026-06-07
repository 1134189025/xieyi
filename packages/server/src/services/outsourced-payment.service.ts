import { prisma } from '../db.ts';
import { getPaymentProcessingConfig } from './settings.service.ts';
import {
  completeOutsourcedPaymentOrder,
  failOutsourcedPaymentOrder,
} from './order.service.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const OUTSOURCED_STATUS_CHECK_LIMIT = 100;
const TERMINAL_FAILED_STATUSES = new Set(['failed', 'expired', 'canceled']);

export interface OutsourcedSubmitResult {
  ticketId: string;
  status: string;
  message: string;
}

export interface OutsourcedDetectionResult {
  checked: number;
  completed: number;
  failed: number;
}

export class OutsourcedBuyerApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly generationFailureDiagnostic: {
    stage: string | null;
    detail: string | null;
    httpStatus: number | null;
  };

  constructor(message: string, input: {
    code: string;
    statusCode?: number;
    stage?: string;
    detail?: string | null;
    httpStatus?: number | null;
  }) {
    super(message);
    this.name = 'OutsourcedBuyerApiError';
    this.code = input.code;
    this.statusCode = input.statusCode ?? 502;
    this.generationFailureDiagnostic = {
      stage: input.stage ?? 'outsourced_buyer_api',
      detail: sanitizeOutsourcedDetail(input.detail ?? message),
      httpStatus: input.httpStatus ?? null,
    };
  }
}

export async function selectOutsourcedActivationCode(): Promise<string> {
  const config = await getPaymentProcessingConfig();
  if (config.outsourcedActivationCodes.length === 0) {
    throw new OutsourcedBuyerApiError('No outsourced activation code configured', {
      code: 'OUTSOURCED_CODE_UNAVAILABLE',
      statusCode: 503,
      stage: 'outsourced_code_info',
      detail: 'empty_activation_code_pool',
    });
  }

  for (const activationCode of config.outsourcedActivationCodes) {
    const response = await postBuyerApi(config.outsourcedBuyerApiBaseUrl, '/buyer/api/code-info', {
      code: activationCode,
    });
    if (response.ok !== true) continue;
    if (Number(response.remaining) > 0) return activationCode;
  }

  throw new OutsourcedBuyerApiError('No outsourced activation code has remaining quota', {
    code: 'OUTSOURCED_CODE_UNAVAILABLE',
    statusCode: 503,
    stage: 'outsourced_code_info',
    detail: 'no_remaining_quota',
  });
}

export async function submitOutsourcedPixPayment(input: {
  activationCode: string;
  pixCode: string;
}): Promise<OutsourcedSubmitResult> {
  const config = await getPaymentProcessingConfig();
  const response = await postBuyerApi(config.outsourcedBuyerApiBaseUrl, '/buyer/api/submit', {
    code: input.activationCode,
    pix_code: input.pixCode,
  });

  if (response.ok !== true) {
    throw new OutsourcedBuyerApiError('Outsourced buyer API submit failed', {
      code: 'OUTSOURCED_SUBMIT_FAILED',
      statusCode: 502,
      stage: 'outsourced_submit',
      detail: redactOutsourcedSecrets(String(response.message ?? 'submit_failed'), input),
    });
  }

  const ticketId = stringField(response.ticket_id);
  if (!ticketId) {
    throw new OutsourcedBuyerApiError('Outsourced buyer API did not return ticket_id', {
      code: 'OUTSOURCED_SUBMIT_FAILED',
      statusCode: 502,
      stage: 'outsourced_submit',
      detail: 'missing_ticket_id',
    });
  }

  return {
    ticketId,
    status: stringField(response.status) || 'queued',
    message: stringField(response.message) || '',
  };
}

export async function detectOutsourcedPixPayments(): Promise<OutsourcedDetectionResult> {
  const orders = await prisma.order.findMany({
    where: {
      status: 'PENDING_PAYMENT',
      paymentHandler: 'OUTSOURCED_BUYER_API',
      outsourcedTicketId: { not: null },
    } as never,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: OUTSOURCED_STATUS_CHECK_LIMIT,
  });
  if (orders.length === 0) return { checked: 0, completed: 0, failed: 0 };

  const config = await getPaymentProcessingConfig();
  const response = await postBuyerApi(config.outsourcedBuyerApiBaseUrl, '/buyer/api/orders-status', {
    ticket_ids: orders.map(outsourcedTicketIdOf).filter(Boolean),
  });
  if (response.ok !== true || !Array.isArray(response.orders)) {
    return { checked: orders.length, completed: 0, failed: 0 };
  }

  const orderByTicketId = new Map(
    orders
      .map((order) => [outsourcedTicketIdOf(order), order] as const)
      .filter(([ticketId]) => ticketId),
  );
  let completed = 0;
  let failed = 0;

  for (const externalOrder of response.orders) {
    const ticketId = stringField((externalOrder as Record<string, unknown>).ticket_id);
    const status = stringField((externalOrder as Record<string, unknown>).status);
    if (!ticketId || !status) continue;

    const localOrder = orderByTicketId.get(ticketId);
    if (!localOrder) continue;

    if (status === 'paid') {
      await completeOutsourcedPaymentOrder(localOrder.id, status);
      completed += 1;
      continue;
    }
    if (TERMINAL_FAILED_STATUSES.has(status)) {
      await failOutsourcedPaymentOrder(
        localOrder.id,
        status,
        stringField((externalOrder as Record<string, unknown>).last_error),
      );
      failed += 1;
    }
  }

  return { checked: orders.length, completed, failed };
}

async function postBuyerApi(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetchJson(joinBuyerUrl(baseUrl, path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response;
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new OutsourcedBuyerApiError('Outsourced buyer API returned HTTP error', {
        code: 'OUTSOURCED_API_UNAVAILABLE',
        statusCode: response.status >= 500 ? 502 : response.status,
        stage: 'outsourced_api',
        detail: text.slice(0, 200),
        httpStatus: response.status,
      });
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      throw new OutsourcedBuyerApiError('Outsourced buyer API returned invalid JSON', {
        code: 'OUTSOURCED_API_INVALID_RESPONSE',
        statusCode: 502,
        stage: 'outsourced_api',
        detail: text.slice(0, 200),
        httpStatus: response.status,
      });
    }
  } catch (error) {
    if (error instanceof OutsourcedBuyerApiError) throw error;
    throw new OutsourcedBuyerApiError('Outsourced buyer API request failed', {
      code: error instanceof DOMException && error.name === 'AbortError'
        ? 'OUTSOURCED_API_TIMEOUT'
        : 'OUTSOURCED_API_UNAVAILABLE',
      statusCode: error instanceof DOMException && error.name === 'AbortError' ? 504 : 502,
      stage: 'outsourced_api',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

function joinBuyerUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function outsourcedTicketIdOf(order: unknown): string {
  return stringField((order as { outsourcedTicketId?: unknown }).outsourcedTicketId);
}

function redactOutsourcedSecrets(
  value: string,
  input: { activationCode: string; pixCode: string },
): string {
  return sanitizeOutsourcedDetail(value)
    .replaceAll(input.activationCode, '[redacted-activation-code]')
    .replaceAll(input.pixCode, '[redacted-pix-code]');
}

const PIX_PATTERN = /000201[A-Za-z0-9+/.=_-]{20,}/g;

function sanitizeOutsourcedDetail(value: string): string {
  return value
    .replace(PIX_PATTERN, '[redacted-pix-code]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}
