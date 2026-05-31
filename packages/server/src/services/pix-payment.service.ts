import { createDirectStripePixPayment, generateBrazilBillingProfile } from '@pix/core';
import type { CreateStripePixPaymentResult, BrazilBillingProfile } from '@pix/core';
import QRCode from 'qrcode';

export interface PixPaymentResult {
  stripeResult: CreateStripePixPaymentResult;
  profile: BrazilBillingProfile;
  qrPngBuffer: Buffer;
}

export async function generatePixPayment(checkoutUrl: string): Promise<PixPaymentResult> {
  const profile = generateBrazilBillingProfile();

  const stripeResult = await createDirectStripePixPayment({
    checkoutUrl,
    profile,
  });

  const qrPngBuffer = await QRCode.toBuffer(stripeResult.pix.data, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    scale: 8,
  });

  return { stripeResult, profile, qrPngBuffer };
}
