import { describe, expect, it, vi } from 'vitest';
import { createDirectStripePixPayment, type StripeHttpTransport } from './stripe-pix-protocol.ts';

describe('createDirectStripePixPayment', () => {
  it('向 transport 传递请求超时配置', async () => {
    const postForm = vi
      .fn<StripeHttpTransport['postForm']>()
      .mockResolvedValueOnce({ config_id: 'cfg_123', init_checksum: 'init_123' })
      .mockResolvedValueOnce({ id: 'pm_123', type: 'pix' })
      .mockResolvedValueOnce({
        setup_intent: {
          next_action: {
            pix_display_qr_code: {
              data: '000201valid-pix-payload',
            },
          },
        },
      });

    await createDirectStripePixPayment({
      checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123',
      profile: {
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
      },
      timeoutMs: 1234,
      transport: { postForm },
    });

    expect(postForm).toHaveBeenCalledWith(
      expect.stringContaining('/v1/payment_pages/cs_test_123'),
      expect.any(URLSearchParams),
      { timeoutMs: 1234 },
    );
  });
});
