import {
  generateBrazilBillingProfile,
  type BrazilBillingProfile,
  type CreateStripePixPaymentResult,
} from '@pix/core';
import QRCode from 'qrcode';
import type { ChatGptSessionCredential } from './chatgpt-session.service.ts';
import {
  runPixGoEngine,
  type PixGoEngineResult,
} from './pix-go-engine.service.ts';
import type { ProxyPoolName } from './settings.service.ts';

export interface PixPaymentResult {
  stripeResult: CreateStripePixPaymentResult;
  checkoutUrl: string;
  profile: BrazilBillingProfile;
  qrPngBuffer: Buffer | null;
}

export interface GeneratePixPaymentOptions {
  proxy?: PixPaymentProxyOptions;
  timeoutMs?: number;
}

export interface PixPaymentProxyOptions {
  proxyUrl?: string | null;
  poolName?: ProxyPoolName | null;
}

export type PixPaymentUpstreamError = Error & {
  proxyPoolName?: ProxyPoolName;
  generationFailureDiagnostic?: {
    stage: string | null;
    detail: string | null;
    httpStatus: number | null;
  };
};

export async function generatePixPayment(
  credential: ChatGptSessionCredential,
  options: GeneratePixPaymentOptions = {},
): Promise<PixPaymentResult> {
  const generatedProfile = generateBrazilBillingProfile();
  const accountEmail = credential.email?.trim() || null;
  const profile = accountEmail
    ? { ...generatedProfile, email: accountEmail }
    : generatedProfile;
  const engineBillingProfile = {
    ...profile,
    email: accountEmail ?? '',
  };
  const engineResult = await runEngine(credential, engineBillingProfile, options);
  const stripeResult = toStripeResult(engineResult);
  const qrPngBuffer = stripeResult.pix.data
    ? await QRCode.toBuffer(stripeResult.pix.data, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 8,
    })
    : null;

  return {
    stripeResult,
    checkoutUrl: engineResult.checkoutUrl ?? checkoutUrl(engineResult.checkoutSessionId),
    profile,
    qrPngBuffer,
  };
}

async function runEngine(
  credential: ChatGptSessionCredential,
  profile: BrazilBillingProfile,
  options: GeneratePixPaymentOptions,
): Promise<PixGoEngineResult> {
  try {
    return await runPixGoEngine({
      credential,
      proxyUrl: options.proxy?.proxyUrl ?? null,
      billingProfile: profile,
      useTrial: true,
      maxApproveBlockedRetries: 3,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw tagPaymentError(error, options.proxy?.poolName ?? null);
  }
}

function tagPaymentError(error: unknown, proxyPoolName: ProxyPoolName | null): PixPaymentUpstreamError {
  const paymentError = error instanceof Error
    ? error as PixPaymentUpstreamError
    : new Error('Pix payment generation failed') as PixPaymentUpstreamError;

  if (proxyPoolName) paymentError.proxyPoolName = proxyPoolName;

  const diagnostic = (error as {
    generationFailureDiagnostic?: PixPaymentUpstreamError['generationFailureDiagnostic'];
  }).generationFailureDiagnostic;
  if (diagnostic) {
    paymentError.generationFailureDiagnostic = diagnostic;
  } else {
    const fields = error as { stage?: unknown; detail?: unknown; httpStatus?: unknown };
    if (typeof fields.stage === 'string' || typeof fields.detail === 'string' || typeof fields.httpStatus === 'number') {
      paymentError.generationFailureDiagnostic = {
        stage: typeof fields.stage === 'string' ? fields.stage : null,
        detail: typeof fields.detail === 'string' ? fields.detail : null,
        httpStatus: typeof fields.httpStatus === 'number' ? fields.httpStatus : null,
      };
    }
  }

  return paymentError;
}

function toStripeResult(engineResult: PixGoEngineResult): CreateStripePixPaymentResult {
  const qrData = engineResult.qrData.trim();
  return {
    checkoutSessionId: engineResult.checkoutSessionId,
    checkoutConfigId: undefined,
    paymentMethodId: engineResult.paymentMethodId,
    pix: {
      data: qrData || null,
      hostedInstructionsUrl: engineResult.hostedInstructionsUrl,
      imageUrlPng: engineResult.imageUrlPng,
      imageUrlSvg: engineResult.imageUrlSvg,
      expiresAt: engineResult.expiresAt,
      setupIntentId: engineResult.setupIntentId,
      setupIntentClientSecret: engineResult.setupIntentClientSecret,
      setupIntentStatus: engineResult.setupIntentStatus,
    },
  };
}

function checkoutUrl(checkoutSessionId: string): string {
  return `https://checkout.stripe.com/c/pay/${checkoutSessionId}?redirect_pm_type=pix&ui_mode=custom`;
}
