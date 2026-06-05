import { beforeEach, describe, expect, it, vi } from 'vitest';

const createCheckoutSession = vi.fn();
const approveCheckoutSession = vi.fn();
const generateBrazilBillingProfile = vi.fn();
const submitStripePixPayment = vi.fn();
const pollStripePaymentPageForPixQr = vi.fn();

vi.mock('./chatgpt-session.service.ts', () => ({
  createCheckoutSession,
  approveCheckoutSession,
}));

vi.mock('@pix/core', () => ({
  generateBrazilBillingProfile,
  submitStripePixPayment,
  pollStripePaymentPageForPixQr,
}));

const { generatePixPayment } = await import('./pix-payment.service.ts');

const checkoutSession = {
  checkoutSessionId: 'cs_test_123',
  checkoutUrl: 'https://chatgpt.com/checkout/openai_llc/cs_test_123',
  processorEntity: 'openai_llc',
};

const profile = {
  name: 'Cliente Teste',
  email: 'cliente@example.com',
  cpf: '123.456.789-09',
  address: {
    country: 'BR',
    state: 'SP',
    city: 'Sao Paulo',
    line1: 'Rua Teste 123',
    postalCode: '01000-000',
  },
};

const pix = {
  data: '000201valid-pix-payload',
  imageUrlPng: 'https://stripe.test/pix.png',
  expiresAt: 1781111404,
  setupIntentId: 'seti_123',
  setupIntentClientSecret: 'seti_123_secret_456',
};

describe('pix-payment.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createCheckoutSession.mockResolvedValue(checkoutSession);
    approveCheckoutSession.mockResolvedValue({ result: 'approved', statusCode: 200 });
    generateBrazilBillingProfile.mockReturnValue(profile);
  });

  it('creates checkout, confirms Stripe Pix, approves ChatGPT, then polls when confirm has no QR', async () => {
    submitStripePixPayment.mockResolvedValue({
      checkoutSessionId: 'cs_test_123',
      checkoutConfigId: 'cfg_123',
      paymentMethodId: 'pm_123',
      amount: 0,
      currency: 'brl',
      pix: null,
    });
    pollStripePaymentPageForPixQr.mockResolvedValue(pix);

    const result = await generatePixPayment('access-token-value', {
      chatGpt: { proxyUrl: 'http://chat:user@chat-proxy.example:10000', retry: { attempts: 3 } },
      stripe: { proxyUrl: 'http://stripe:user@stripe-proxy.example:10001', retry: { attempts: 3 } },
    });

    expect(createCheckoutSession).toHaveBeenCalledWith(
      'access-token-value',
      expect.objectContaining({ proxyUrl: 'http://chat:user@chat-proxy.example:10000' }),
    );
    expect(submitStripePixPayment).toHaveBeenCalledWith(expect.objectContaining({
      checkoutSessionId: 'cs_test_123',
      checkoutUrl: checkoutSession.checkoutUrl,
      profile,
      proxyUrl: 'http://stripe:user@stripe-proxy.example:10001',
    }));
    expect(approveCheckoutSession).toHaveBeenCalledWith(
      'access-token-value',
      checkoutSession,
      expect.objectContaining({ proxyUrl: 'http://chat:user@chat-proxy.example:10000' }),
    );
    expect(pollStripePaymentPageForPixQr).toHaveBeenCalledWith(expect.objectContaining({
      checkoutSessionId: 'cs_test_123',
      paymentMethodId: 'pm_123',
      proxyUrl: 'http://stripe:user@stripe-proxy.example:10001',
    }));
    expect(result.stripeResult.pix).toEqual(pix);
    expect(result.qrPngBuffer.length).toBeGreaterThan(0);
  });

  it('approves ChatGPT even when Stripe confirm already returns a QR and skips poll', async () => {
    submitStripePixPayment.mockResolvedValue({
      checkoutSessionId: 'cs_test_123',
      paymentMethodId: 'pm_123',
      amount: 0,
      currency: 'brl',
      pix,
    });

    const result = await generatePixPayment('access-token-value');

    expect(approveCheckoutSession).toHaveBeenCalledWith('access-token-value', checkoutSession, {});
    expect(pollStripePaymentPageForPixQr).not.toHaveBeenCalled();
    expect(result.stripeResult.pix).toEqual(pix);
  });

  it('fails immediately when ChatGPT approve does not return approved', async () => {
    submitStripePixPayment.mockResolvedValue({
      checkoutSessionId: 'cs_test_123',
      paymentMethodId: 'pm_123',
      amount: 0,
      currency: 'brl',
      pix: null,
    });
    approveCheckoutSession.mockResolvedValue({ result: 'exception', statusCode: 200 });

    await expect(generatePixPayment('access-token-value')).rejects.toMatchObject({
      proxyPoolName: 'chatgpt',
    });

    expect(pollStripePaymentPageForPixQr).not.toHaveBeenCalled();
  });

  it('fails immediately when ChatGPT approve returns a non-success HTTP status', async () => {
    submitStripePixPayment.mockResolvedValue({
      checkoutSessionId: 'cs_test_123',
      paymentMethodId: 'pm_123',
      amount: 0,
      currency: 'brl',
      pix: null,
    });
    approveCheckoutSession.mockResolvedValue({ result: 'error', statusCode: 502 });

    await expect(generatePixPayment('access-token-value')).rejects.toMatchObject({
      proxyPoolName: 'chatgpt',
    });

    expect(pollStripePaymentPageForPixQr).not.toHaveBeenCalled();
  });

  it('tags ChatGPT checkout failures with the chatgpt proxy pool', async () => {
    const checkoutError = Object.assign(new Error('checkout failed'), { code: 'CHATGPT_CHECKOUT_FAILED' });
    createCheckoutSession.mockRejectedValue(checkoutError);

    await expect(generatePixPayment('access-token-value')).rejects.toMatchObject({
      code: 'CHATGPT_CHECKOUT_FAILED',
      proxyPoolName: 'chatgpt',
    });
  });

  it('tags Stripe failures with the stripe proxy pool and does not approve', async () => {
    const stripeError = Object.assign(new Error('account not eligible'), { code: 'ACCOUNT_NOT_ELIGIBLE' });
    submitStripePixPayment.mockRejectedValue(stripeError);

    await expect(generatePixPayment('access-token-value')).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_ELIGIBLE',
      proxyPoolName: 'stripe',
    });

    expect(approveCheckoutSession).not.toHaveBeenCalled();
  });
});
