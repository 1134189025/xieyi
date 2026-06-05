import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDirectStripePixPayment,
  pollStripePaymentPageForPixQr,
  retrieveStripeSetupIntentStatus,
  submitStripePixPayment,
  type StripeHttpTransport,
} from './stripe-pix-protocol.ts';
import type { BrazilBillingProfile } from './brazil-profile.ts';

const profile: BrazilBillingProfile = {
  name: 'Cliente Teste',
  email: 'cliente@example.com',
  cpf: '12345678909',
  address: {
    country: 'BR',
    state: 'Sao Paulo',
    city: 'Sao Paulo',
    line1: 'Rua Teste 123',
    postalCode: '01001000',
  },
};

const pixResponse = {
  setup_intent: {
    id: 'seti_123',
    client_secret: 'seti_123_secret_456',
    status: 'requires_action',
    next_action: {
      pix_display_qr_code: {
        data: '000201valid-pix-payload',
        image_url_png: 'https://stripe.test/pix.png',
        hosted_instructions_url: 'https://payments.stripe.com/qr/instructions/test',
        expires_at: 1781111404,
      },
    },
  },
};

describe('submitStripePixPayment', () => {
  it('checks Stripe init amount before confirming Pix and reuses init metadata', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({
        config_id: 'cfg_123',
        init_checksum: 'init_123',
        invoice: { amount_due: 0, subtotal: 9990 },
        total_summary: { due: 0, total: 0, subtotal: 9990 },
        currency: 'brl',
      })
      .mockResolvedValueOnce({ id: 'pm_123', type: 'pix' })
      .mockResolvedValueOnce(pixResponse);

    const result = await submitStripePixPayment({
      checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123#fragment',
      profile,
      timeoutMs: 1234,
      identifiers: {
        guid: 'guid-value',
        muid: 'muid-value',
        sid: 'sid-value',
      },
      clientSessionId: 'client-session-id',
      transport: { postForm },
    });

    expect(postForm).toHaveBeenCalledTimes(3);
    expect(postForm).toHaveBeenNthCalledWith(
      1,
      'https://api.stripe.com/v1/payment_pages/cs_test_123/init',
      expect.any(URLSearchParams),
      { timeoutMs: 1234 },
    );

    const paymentMethodBody = postForm.mock.calls[1]?.[1];
    expect(paymentMethodBody?.get('billing_details[address][state]')).toBe('SP');
    expect(paymentMethodBody?.get('client_attribution_metadata[checkout_config_id]')).toBe('cfg_123');
    expect(paymentMethodBody?.get('guid')).toBe('guid-value');

    const confirmBody = postForm.mock.calls[2]?.[1];
    expect(confirmBody?.get('expected_amount')).toBe('0');
    expect(confirmBody?.get('init_checksum')).toBe('init_123');
    expect(confirmBody?.get('js_checksum')).toBeNull();
    expect(confirmBody?.get('return_url')).toBe('https://pay.openai.com/c/pay/cs_test_123#fragment');
    expect(confirmBody?.get('client_attribution_metadata[checkout_config_id]')).toBe('cfg_123');
    expect(confirmBody?.get('guid')).toBe('guid-value');

    expect(result).toMatchObject({
      checkoutSessionId: 'cs_test_123',
      checkoutConfigId: 'cfg_123',
      paymentMethodId: 'pm_123',
      amount: 0,
      currency: 'brl',
      pix: {
        data: '000201valid-pix-payload',
        setupIntentId: 'seti_123',
        setupIntentClientSecret: 'seti_123_secret_456',
      },
    });
  });

  it('uses the explicit checkout session id even when the stored checkout URL differs', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({
        config_id: 'cfg_123',
        init_checksum: 'init_123',
        invoice: { amount_due: 0 },
      })
      .mockResolvedValueOnce({ id: 'pm_123', type: 'pix' })
      .mockResolvedValueOnce(pixResponse);

    await submitStripePixPayment({
      checkoutSessionId: 'cs_test_123',
      checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_different',
      profile,
      transport: { postForm },
    });

    expect(postForm).toHaveBeenNthCalledWith(
      1,
      'https://api.stripe.com/v1/payment_pages/cs_test_123/init',
      expect.any(URLSearchParams),
      { timeoutMs: 30_000 },
    );
    const paymentMethodBody = postForm.mock.calls[1]?.[1];
    expect(paymentMethodBody?.get('client_attribution_metadata[checkout_session_id]')).toBe('cs_test_123');
    const confirmBody = postForm.mock.calls[2]?.[1];
    expect(confirmBody?.get('client_attribution_metadata[checkout_session_id]')).toBe('cs_test_123');
  });

  it('rejects an invalid explicit checkout session id without falling back to the URL', async () => {
    const postForm = vi.fn<StripeHttpTransport['postForm']>();

    await expect(
      submitStripePixPayment({
        checkoutSessionId: 'not-a-checkout-session-id',
        checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123',
        profile,
        transport: { postForm },
      }),
    ).rejects.toThrow('Invalid checkout session id');

    expect(postForm).not.toHaveBeenCalled();
  });

  it('rejects non-zero payable amount before creating a Pix payment method', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({
        config_id: 'cfg_123',
        init_checksum: 'init_123',
        invoice: { amount_due: 9990 },
        currency: 'brl',
      });

    await expect(
      submitStripePixPayment({
        checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123',
        profile,
        transport: { postForm },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'ACCOUNT_NOT_ELIGIBLE',
    });

    expect(postForm).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Stripe init exposes a negative amount', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({
        config_id: 'cfg_123',
        init_checksum: 'init_123',
        invoice: { amount_due: -100 },
        currency: 'brl',
      });

    await expect(
      submitStripePixPayment({
        checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123',
        profile,
        transport: { postForm },
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'PAYMENT_FAILED',
    });

    expect(postForm).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Stripe init does not expose a payable amount', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({
        config_id: 'cfg_123',
        init_checksum: 'init_123',
        invoice: { subtotal: 9990 },
      });

    await expect(
      submitStripePixPayment({
        checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123',
        profile,
        transport: { postForm },
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'PAYMENT_FAILED',
    });

    expect(postForm).toHaveBeenCalledTimes(1);
  });

  it('returns a pending confirmation when confirm succeeds without a QR payload', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({
        config_id: 'cfg_123',
        init_checksum: 'init_123',
        invoice: { amount_due: 0 },
      })
      .mockResolvedValueOnce({ id: 'pm_123', type: 'pix' })
      .mockResolvedValueOnce({ payment_status: 'unpaid', setup_intent: { id: 'seti_123' } });

    await expect(
      submitStripePixPayment({
        checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123',
        profile,
        transport: { postForm },
      }),
    ).resolves.toMatchObject({
      checkoutSessionId: 'cs_test_123',
      paymentMethodId: 'pm_123',
      pix: null,
    });
  });
});

describe('pollStripePaymentPageForPixQr', () => {
  it('polls the Stripe payment page until a Pix QR appears', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({ payment_status: 'unpaid' })
      .mockResolvedValueOnce(pixResponse);

    await expect(
      pollStripePaymentPageForPixQr({
        checkoutSessionId: 'cs_test_123',
        paymentMethodId: 'pm_123',
        attempts: 2,
        waitMs: 0,
        transport: { postForm },
      }),
    ).resolves.toMatchObject({
      data: '000201valid-pix-payload',
      setupIntentId: 'seti_123',
    });

    expect(postForm).toHaveBeenNthCalledWith(
      1,
      'https://api.stripe.com/v1/payment_pages/cs_test_123',
      expect.any(URLSearchParams),
      { timeoutMs: 30_000 },
    );
  });
});

describe('createDirectStripePixPayment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a Pix QR when the direct Stripe confirmation contains one', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({
        config_id: 'cfg_123',
        init_checksum: 'init_123',
        invoice: { amount_due: 0 },
      })
      .mockResolvedValueOnce({ id: 'pm_123', type: 'pix' })
      .mockResolvedValueOnce(pixResponse);

    await expect(
      createDirectStripePixPayment({
        checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123',
        profile,
        transport: { postForm },
      }),
    ).resolves.toMatchObject({
      checkoutSessionId: 'cs_test_123',
      paymentMethodId: 'pm_123',
      pix: {
        data: '000201valid-pix-payload',
        setupIntentClientSecret: 'seti_123_secret_456',
      },
    });
  });

  it('default transport uses proxy and retries recoverable Stripe errors', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { amount_due: 0 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'pm_123', type: 'pix' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(pixResponse), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createDirectStripePixPayment({
      checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123',
      profile,
      proxyUrl: 'http://user:pass@proxy.example:10000',
      retry: { attempts: 3, backoffMs: [0, 0] },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.stripe.com/v1/payment_pages/cs_test_123/init',
      expect.objectContaining({
        dispatcher: expect.any(Object),
      }),
    );
  });

  it('maps checkout amount mismatch to account-not-eligible without retrying', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invoice: { amount_due: 0 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'pm_123', type: 'pix' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'checkout_amount_mismatch',
              message: 'The computed invoice amount does not match the latest invoice on the subscription.',
            },
          }),
          { status: 400 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createDirectStripePixPayment({
        checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123',
        profile,
        retry: { attempts: 3, backoffMs: [0, 0] },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'ACCOUNT_NOT_ELIGIBLE',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('retrieveStripeSetupIntentStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retrieves SetupIntent status with client_secret and publishable key', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'seti_123', status: 'succeeded' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      retrieveStripeSetupIntentStatus({
        setupIntentId: 'seti_123',
        clientSecret: 'seti_123_secret_456',
        timeoutMs: 1234,
      }),
    ).resolves.toEqual({ id: 'seti_123', status: 'succeeded' });

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain('/v1/setup_intents/seti_123');
    expect(requestUrl).toContain('client_secret=seti_123_secret_456');
    expect(requestUrl).toContain('key=pk_live_');
  });

  it('retries transient SetupIntent checks but not 400 business errors', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'seti_123', status: 'requires_action' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'invalid_request_error' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      retrieveStripeSetupIntentStatus({
        setupIntentId: 'seti_123',
        clientSecret: 'seti_123_secret_456',
        retry: { attempts: 3, backoffMs: [0, 0] },
        proxyUrl: 'http://user:pass@proxy.example:10000',
      }),
    ).resolves.toEqual({ id: 'seti_123', status: 'requires_action' });

    await expect(
      retrieveStripeSetupIntentStatus({
        setupIntentId: 'seti_bad',
        clientSecret: 'seti_bad_secret',
        retry: { attempts: 3, backoffMs: [0, 0] },
      }),
    ).rejects.toMatchObject({
      code: 'PAYMENT_STATUS_CHECK_FAILED',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
