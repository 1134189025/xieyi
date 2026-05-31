import { createDirectStripePixPayment, generateBrazilBillingProfile } from '@pix/core';
import type { CreateStripePixPaymentResult, BrazilBillingProfile } from '@pix/core';
import QRCode from 'qrcode';

export interface PixPaymentResult {
  stripeResult: CreateStripePixPaymentResult;
  profile: BrazilBillingProfile;
  qrPngBuffer: Buffer;
}

export interface GeneratePixPaymentOptions {
  timeoutMs?: number;
  proxyUrl?: string;
  retry?: { attempts: number; backoffMs?: number[] };
}

export async function generatePixPayment(
  checkoutUrl: string,
  options: GeneratePixPaymentOptions = {},
): Promise<PixPaymentResult> {
  const profile = generateBrazilBillingProfile();

  const stripeResult = await createDirectStripePixPayment({
    checkoutUrl,
    profile,
    timeoutMs: options.timeoutMs ?? 30_000,
    proxyUrl: options.proxyUrl,
    retry: options.retry,
  });

  const qrPngBuffer = await QRCode.toBuffer(stripeResult.pix.data, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    scale: 8,
  });

  return { stripeResult, profile, qrPngBuffer };
}
