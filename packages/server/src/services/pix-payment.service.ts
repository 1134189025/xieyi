import {
  generateBrazilBillingProfile,
  pollStripePaymentPageForPixQr,
  submitStripePixPayment,
  type BrazilBillingProfile,
  type CreateStripePixPaymentResult,
  type StripeRetryOptions,
} from '@pix/core';
import QRCode from 'qrcode';
import {
  approveCheckoutSession,
  createCheckoutSession,
  type UpstreamRequestOptions,
} from './chatgpt-session.service.ts';
import type { ProxyPoolName } from './settings.service.ts';

export interface PixPaymentResult {
  stripeResult: CreateStripePixPaymentResult;
  checkoutUrl: string;
  profile: BrazilBillingProfile;
  qrPngBuffer: Buffer;
}

export interface GeneratePixPaymentOptions {
  chatGpt?: UpstreamRequestOptions;
  stripe?: StripeRequestOptions;
}

export interface StripeRequestOptions {
  timeoutMs?: number;
  proxyUrl?: string | null;
  retry?: StripeRetryOptions;
}

export type PixPaymentUpstreamError = Error & { proxyPoolName?: ProxyPoolName };

export async function generatePixPayment(
  accessToken: string,
  options: GeneratePixPaymentOptions = {},
): Promise<PixPaymentResult> {
  const profile = generateBrazilBillingProfile();
  const checkoutSession = await runChatGptStep(
    () => createCheckoutSession(accessToken, options.chatGpt ?? {}),
  );

  const stripeOptions = normalizeStripeOptions(options.stripe);
  const submission = await runStripeStep(() => submitStripePixPayment({
    checkoutSessionId: checkoutSession.checkoutSessionId,
    checkoutUrl: checkoutSession.checkoutUrl,
    profile,
    timeoutMs: stripeOptions.timeoutMs,
    proxyUrl: stripeOptions.proxyUrl ?? undefined,
    retry: stripeOptions.retry,
  }));

  const pix = await approveAndResolvePix({
    accessToken,
    checkoutSession,
    pix: submission.pix,
    paymentMethodId: submission.paymentMethodId,
    stripeOptions,
    chatGptOptions: options.chatGpt ?? {},
  });

  const stripeResult: CreateStripePixPaymentResult = {
    checkoutSessionId: submission.checkoutSessionId,
    checkoutConfigId: submission.checkoutConfigId,
    paymentMethodId: submission.paymentMethodId,
    pix,
  };

  const qrPngBuffer = await QRCode.toBuffer(stripeResult.pix.data, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    scale: 8,
  });

  return {
    stripeResult,
    checkoutUrl: checkoutSession.checkoutUrl,
    profile,
    qrPngBuffer,
  };
}

async function approveAndResolvePix(input: {
  accessToken: string;
  checkoutSession: Awaited<ReturnType<typeof createCheckoutSession>>;
  pix: CreateStripePixPaymentResult['pix'] | null;
  paymentMethodId: string;
  stripeOptions: RequiredStripeRequestOptions;
  chatGptOptions: UpstreamRequestOptions;
}) {
  const approval = await runChatGptStep(() =>
    approveCheckoutSession(input.accessToken, input.checkoutSession, input.chatGptOptions),
  );
  if (approval.result === 'blocked') {
    throw tagProxyPool(new Error('ChatGPT checkout approve blocked'), 'chatgpt');
  }
  if (approval.statusCode >= 400 || approval.result !== 'approved') {
    throw tagProxyPool(new Error(`ChatGPT checkout approve failed: ${approval.result}`), 'chatgpt');
  }

  if (input.pix) return input.pix;

  return runStripeStep(() => pollStripePaymentPageForPixQr({
    checkoutSessionId: input.checkoutSession.checkoutSessionId,
    paymentMethodId: input.paymentMethodId,
    timeoutMs: input.stripeOptions.timeoutMs,
    proxyUrl: input.stripeOptions.proxyUrl ?? undefined,
    retry: input.stripeOptions.retry,
  }));
}

async function runChatGptStep<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw tagProxyPool(error, 'chatgpt');
  }
}

async function runStripeStep<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw tagProxyPool(error, 'stripe');
  }
}

function tagProxyPool(error: unknown, proxyPoolName: ProxyPoolName): PixPaymentUpstreamError {
  if (error instanceof Error) {
    (error as PixPaymentUpstreamError).proxyPoolName = proxyPoolName;
    return error as PixPaymentUpstreamError;
  }
  return Object.assign(new Error('Pix payment generation failed'), { proxyPoolName });
}

interface RequiredStripeRequestOptions {
  timeoutMs: number;
  proxyUrl: string | null;
  retry?: StripeRetryOptions;
}

function normalizeStripeOptions(options: StripeRequestOptions | undefined): RequiredStripeRequestOptions {
  return {
    timeoutMs: options?.timeoutMs ?? 30_000,
    proxyUrl: options?.proxyUrl ?? null,
    retry: options?.retry,
  };
}
