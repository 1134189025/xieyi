import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDirectStripePixPayment, type StripeHttpTransport } from './stripe-pix-protocol.ts';
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

  it('向 transport 传递请求超时配置', async () => {
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

  it('payment page 应付金额为 0 时继续创建 Pix 并确认 expected_amount=0', async () => {
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

    await createDirectStripePixPayment({
      checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123',
      profile,
      transport: { postForm },
    });

    const confirmBody = postForm.mock.calls[2]?.[1];
    expect(confirmBody?.get('expected_amount')).toBe('0');
  });

  it('payment page 应付金额大于 0 时返回账号无资格且不创建 Pix', async () => {
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
      message: '账号无资格，无法生成 Pix 支付',
    });

    expect(postForm).toHaveBeenCalledTimes(1);
  });

  it('payment page 缺少应付金额时不默认按 0 确认', async () => {
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

  it('默认 transport 使用代理并重试可恢复的 Stripe 抖动', async () => {
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

  it('Stripe checkout_amount_mismatch 业务错误映射为账号无资格且不重试', async () => {
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
