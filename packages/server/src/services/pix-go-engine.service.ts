import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrazilBillingProfile } from '@pix/core';
import type { ChatGptSessionCredential } from './chatgpt-session.service.ts';

const DEFAULT_ENGINE_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

export interface PixGoEngineInput {
  credential: ChatGptSessionCredential;
  proxyUrl?: string | null;
  billingProfile: BrazilBillingProfile;
  useTrial?: boolean;
  maxApproveBlockedRetries?: number;
  retryWaitMs?: number;
  timeoutMs?: number;
}

export interface PixGoEngineResult {
  checkoutSessionId: string;
  checkoutUrl?: string;
  processorEntity?: string;
  paymentMethodId: string;
  paymentIntentId?: string;
  amount: number;
  amountPresent: boolean;
  currency?: string;
  qrData: string;
  imageUrlPng?: string;
  imageUrlSvg?: string;
  hostedInstructionsUrl?: string;
  expiresAt?: number;
  setupIntentId?: string;
  setupIntentClientSecret?: string;
  setupIntentStatus?: string;
}

interface EngineErrorPayload {
  code?: string;
  status_code?: number;
  stage?: string;
  detail?: string;
  http_status?: number;
}

interface EngineResponse {
  ok?: boolean;
  error?: EngineErrorPayload;
  checkout_session_id?: string;
  checkout_url?: string;
  processor_entity?: string;
  payment_method_id?: string;
  payment_intent_id?: string;
  amount?: number;
  amount_present?: boolean;
  currency?: string;
  qr_data?: string;
  image_url_png?: string;
  image_url_svg?: string;
  hosted_instructions_url?: string;
  expires_at?: number;
  setup_intent_id?: string;
  setup_intent_client_secret?: string;
  setup_intent_status?: string;
}

export class PixGoEngineError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly stage: string | null;
  readonly detail: string | null;
  readonly httpStatus: number | null;
  readonly generationFailureDiagnostic: {
    stage: string | null;
    detail: string | null;
    httpStatus: number | null;
  };

  constructor(message: string, input: {
    code?: string;
    statusCode?: number;
    stage?: string | null;
    detail?: string | null;
    httpStatus?: number | null;
  } = {}) {
    super(message);
    this.name = 'PixGoEngineError';
    this.code = input.code ?? 'PAYMENT_FAILED';
    this.statusCode = input.statusCode ?? 502;
    this.stage = input.stage ?? null;
    this.detail = input.detail ?? null;
    this.httpStatus = input.httpStatus ?? null;
    this.generationFailureDiagnostic = {
      stage: this.stage,
      detail: this.detail,
      httpStatus: this.httpStatus,
    };
  }
}

export async function runPixGoEngine(input: PixGoEngineInput): Promise<PixGoEngineResult> {
  const command = resolveEngineCommand();
  const child = spawn(command.file, command.args, {
    cwd: command.cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, input.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS);

  const closePromise = new Promise<{ code: number | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code }));
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk);
    });
  });

  child.stdin?.end(JSON.stringify(toEngineRequest(input)));

  try {
    const { code } = await closePromise;
    if (timedOut) {
      throw new PixGoEngineError('Pix Go engine timed out', {
        code: 'UPSTREAM_TIMEOUT',
        statusCode: 504,
        stage: 'engine_io',
        detail: 'timeout',
      });
    }
    return parseEngineOutput(stdout, stderr, code);
  } catch (error) {
    if (error instanceof PixGoEngineError) throw error;
    throw new PixGoEngineError('Pix Go engine failed to start', {
      code: 'PAYMENT_FAILED',
      statusCode: 502,
      stage: 'engine_io',
      detail: sanitizeDiagnostic(error instanceof Error ? error.message : String(error)),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseEngineOutput(stdout: string, stderr: string, exitCode: number | null): PixGoEngineResult {
  let response: EngineResponse;
  try {
    response = JSON.parse(stdout) as EngineResponse;
  } catch {
    throw new PixGoEngineError('Pix Go engine returned invalid JSON', {
      code: 'PAYMENT_FAILED',
      statusCode: 502,
      stage: 'engine_io',
      detail: sanitizeDiagnostic(stderr || 'invalid_json'),
    });
  }

  if (!response.ok) {
    const payload = response.error ?? {};
    throw new PixGoEngineError('Pix Go engine returned an error', {
      code: payload.code ?? 'PAYMENT_FAILED',
      statusCode: payload.status_code ?? 502,
      stage: payload.stage ?? 'engine_io',
      detail: sanitizeDiagnostic(payload.detail ?? 'engine_error'),
      httpStatus: typeof payload.http_status === 'number' ? payload.http_status : null,
    });
  }

  const result = mapSuccessResponse(response);
  if (!hasQrArtifact(result) || result.amount !== 0) {
    throw new PixGoEngineError('Pix Go engine returned an invalid success payload', {
      code: result.amount > 0 ? 'ACCOUNT_NOT_ELIGIBLE' : 'PAYMENT_FAILED',
      statusCode: result.amount > 0 ? 400 : 502,
      stage: result.amount > 0 ? 'stripe_init' : 'engine_io',
      detail: result.amount > 0 ? 'amount_nonzero' : 'invalid_success_payload',
    });
  }
  if (exitCode !== 0) {
    throw new PixGoEngineError('Pix Go engine exited unsuccessfully', {
      code: 'PAYMENT_FAILED',
      statusCode: 502,
      stage: 'engine_io',
      detail: sanitizeDiagnostic(stderr || 'exit_nonzero'),
    });
  }
  return result;
}

function hasQrArtifact(result: Pick<PixGoEngineResult, 'qrData' | 'imageUrlPng' | 'imageUrlSvg' | 'hostedInstructionsUrl'>): boolean {
  return Boolean(
    result.qrData.trim()
      || result.imageUrlPng
      || result.imageUrlSvg
      || result.hostedInstructionsUrl,
  );
}

function mapSuccessResponse(response: EngineResponse): PixGoEngineResult {
  return {
    checkoutSessionId: readString(response.checkout_session_id),
    checkoutUrl: readOptionalString(response.checkout_url),
    processorEntity: readOptionalString(response.processor_entity),
    paymentMethodId: readString(response.payment_method_id),
    paymentIntentId: readOptionalString(response.payment_intent_id),
    amount: readAmount(response),
    amountPresent: response.amount_present === true,
    currency: readOptionalString(response.currency),
    qrData: readString(response.qr_data),
    imageUrlPng: readOptionalString(response.image_url_png),
    imageUrlSvg: readOptionalString(response.image_url_svg),
    hostedInstructionsUrl: readOptionalString(response.hosted_instructions_url),
    expiresAt: typeof response.expires_at === 'number' ? response.expires_at : undefined,
    setupIntentId: readOptionalString(response.setup_intent_id),
    setupIntentClientSecret: readOptionalString(response.setup_intent_client_secret),
    setupIntentStatus: readOptionalString(response.setup_intent_status),
  };
}

function readAmount(response: EngineResponse): number {
  if (typeof response.amount === 'number' && Number.isFinite(response.amount)) return response.amount;
  if (response.amount_present === false || response.amount === undefined) return 0;
  return Number.NaN;
}

function toEngineRequest(input: PixGoEngineInput) {
  return {
    token: {
      access_token: input.credential.accessToken,
      session_token: input.credential.sessionToken ?? '',
      device_id: input.credential.deviceId ?? '',
      email: input.credential.email ?? '',
    },
    proxy_url: input.proxyUrl ?? '',
    use_trial: input.useTrial ?? true,
    max_approve_blocked_retries: input.maxApproveBlockedRetries ?? 3,
    retry_wait_ms: input.retryWaitMs ?? 0,
    billing: {
      cpf: input.billingProfile.cpf,
      email: input.billingProfile.email,
      full_name: input.billingProfile.name,
      address_line1: input.billingProfile.address.line1,
      address_line2: '',
      city: input.billingProfile.address.city,
      state: input.billingProfile.address.state,
      postal_code: input.billingProfile.address.postalCode,
      country: input.billingProfile.address.country,
    },
  };
}

function resolveEngineCommand(): { file: string; args: string[]; cwd: string } {
  const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../tools/pix-go-engine');
  const envPath = process.env.PIX_GO_ENGINE_PATH?.trim();
  if (envPath) return { file: envPath, args: [], cwd: engineDir };

  const exePath = path.join(engineDir, process.platform === 'win32' ? 'pix-go-engine.exe' : 'pix-go-engine');
  if (existsSync(exePath)) return { file: exePath, args: [], cwd: engineDir };

  return { file: 'go', args: ['run', '.'], cwd: engineDir };
}

function appendLimited(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString('utf8');
  if (Buffer.byteLength(combined) <= MAX_OUTPUT_BYTES) return combined;
  return combined.slice(-MAX_OUTPUT_BYTES);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readOptionalString(value: unknown): string | undefined {
  const text = readString(value).trim();
  return text || undefined;
}

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const LOOSE_JWT_START_PATTERN = /eyJ[^\s"'<>]+/g;
const SETUP_SECRET_PATTERN = /seti_[A-Za-z0-9_]+_secret_[A-Za-z0-9_]+/g;
const PIX_PATTERN = /000201[A-Za-z0-9+/.=_-]{40,}/g;
const PROXY_CREDENTIAL_PATTERN = /:\/\/([^:@/\s]+):([^@/\s]+)@/g;

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(JWT_PATTERN, '[redacted-token]')
    .replace(LOOSE_JWT_START_PATTERN, '[redacted-token]')
    .replace(SETUP_SECRET_PATTERN, '[redacted-client-secret]')
    .replace(PIX_PATTERN, '[redacted-pix-code]')
    .replace(PROXY_CREDENTIAL_PATTERN, '://****@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}
