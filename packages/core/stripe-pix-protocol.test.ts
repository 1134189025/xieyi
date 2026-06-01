import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDirectStripePixPayment,
  retrieveStripeSetupIntentStatus,
  type StripeHttpTransport,
} from './stripe-pix-protocol.ts';
import type { BrazilBillingProfile } from './brazil-profile.ts';

const profile: BrazilBillingProfile = {
  name: 'Cliente Teste',
  email: 'cliente@example.com',
  cpf: '12345678909',
  address: {
    country: 'BR',
    state: 'SP',
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
      },
    },
  },
};

describe('createDirectStripePixPayment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes timeout configuration to the transport', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({
        config_id: 'cfg_123',
        init_checksum: 'init_123',
        invoice: { amount_due: 0 },
      })
      .mockResolvedValueOnce({ id: 'pm_123', type: 'pix' })
      .mockResolvedValueOnce(pixResponse);

    await createDirectStripePixPayment({
      checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123',
      profile,
      timeoutMs: 1234,
      transport: { postForm },
    });

    expect(postForm).toHaveBeenCalledWith(
      expect.stringContaining('/v1/payment_pages/cs_test_123'),
      expect.any(URLSearchParams),
      { timeoutMs: 1234 },
    );
  });

  it('continues when payable amount is zero and keeps SetupIntent credentials', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({
        config_id: 'cfg_123',
        init_checksum: 'init_123',
        invoice: { amount_due: 0, subtotal: 9990 },
        total_summary: { total: 0, subtotal: 9990 },
      })
      .mockResolvedValueOnce({ id: 'pm_123', type: 'pix' })
      .mockResolvedValueOnce(pixResponse);

    const result = await createDirectStripePixPayment({
      checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123',
      profile,
      transport: { postForm },
    });

    const confirmBody = postForm.mock.calls[2]?.[1];
    expect(confirmBody?.get('expected_amount')).toBe('0');
    expect(result.pix).toMatchObject({
      setupIntentId: 'seti_123',
      setupIntentClientSecret: 'seti_123_secret_456',
      setupIntentStatus: 'requires_action',
    });
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

  it('returns account-not-eligible when payable amount is greater than zero', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({
        config_id: 'cfg_123',
        invoice: { amount_due: 9900 },
      });

    await expect(
      createDirectStripePixPayment({
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

  it('does not default missing payable amount to zero', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({
        config_id: 'cfg_123',
        invoice: { subtotal: 9990 },
      });

    await expect(
      createDirectStripePixPayment({
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
      'https://api.stripe.com/v1/payment_pages/cs_test_123',
      expect.objectContaining({
        dispatcher: expect.any(Object),
      }),
    );
  });

  it('maps checkout_amount_mismatch to account-not-eligible without retrying', async () => {
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
