import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  order: {
    findMany: vi.fn(),
  },
};

const getPaymentProcessingConfig = vi.fn();
const completeOutsourcedPaymentOrder = vi.fn();
const failOutsourcedPaymentOrder = vi.fn();

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('./settings.service.ts', () => ({ getPaymentProcessingConfig }));
vi.mock('./order.service.ts', () => ({
  completeOutsourcedPaymentOrder,
  failOutsourcedPaymentOrder,
}));

const {
  OutsourcedBuyerApiError,
  selectOutsourcedActivationCode,
  submitOutsourcedPixPayment,
  detectOutsourcedPixPayments,
} = await import('./outsourced-payment.service.ts');

describe('outsourced-payment.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
    getPaymentProcessingConfig.mockResolvedValue({
      handler: 'OUTSOURCED_BUYER_API',
      outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
      outsourcedActivationCodes: ['DP-FIRST-CODE', 'DP-SECOND-CODE'],
    });
  });

  it('selects the first outsourced activation code with remaining quota', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(jsonResponse({ ok: false, message: '激活码不存在或已停用' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, remaining: 2, total: 3, used: 1, held: 0 }));

    await expect(selectOutsourcedActivationCode()).resolves.toBe('DP-SECOND-CODE');

    expect(fetch).toHaveBeenCalledWith(
      'https://scan.amazo.indevs.in/buyer/api/code-info',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: 'DP-FIRST-CODE' }),
      }),
    );
  });

  it('throws a terminal error when no outsourced activation code has quota', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(jsonResponse({ ok: true, remaining: 0, total: 1, used: 1, held: 0 }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, message: '已停用' }));

    await expect(selectOutsourcedActivationCode()).rejects.toMatchObject({
      code: 'OUTSOURCED_CODE_UNAVAILABLE',
      statusCode: 503,
    });
  });

  it('submits pix code to buyer API and returns the external ticket', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({
      ok: true,
      ticket_id: 'Toutsource123',
      status: 'queued',
      message: '已提交，后台处理中',
    }));

    await expect(submitOutsourcedPixPayment({
      activationCode: 'DP-FIRST-CODE',
      pixCode: '000201pix-payload',
    })).resolves.toEqual({
      ticketId: 'Toutsource123',
      status: 'queued',
      message: '已提交，后台处理中',
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://scan.amazo.indevs.in/buyer/api/submit',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: 'DP-FIRST-CODE', pix_code: '000201pix-payload' }),
      }),
    );
  });

  it('polls outsourced pending orders and maps paid and failed terminal statuses', async () => {
    prisma.order.findMany.mockResolvedValue([
      { id: 'order-paid', outsourcedTicketId: 'Tpaid' },
      { id: 'order-failed', outsourcedTicketId: 'Tfailed' },
      { id: 'order-queued', outsourcedTicketId: 'Tqueued' },
    ]);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({
      ok: true,
      orders: [
        { ticket_id: 'Tpaid', status: 'paid', last_error: '', paid_at: '2026-06-01T00:00:00' },
        { ticket_id: 'Tfailed', status: 'failed', last_error: '外包支付失败' },
        { ticket_id: 'Tqueued', status: 'authorizing', last_error: '' },
      ],
    }));

    await expect(detectOutsourcedPixPayments()).resolves.toEqual({
      checked: 3,
      completed: 1,
      failed: 1,
    });

    expect(completeOutsourcedPaymentOrder).toHaveBeenCalledWith('order-paid', 'paid');
    expect(failOutsourcedPaymentOrder).toHaveBeenCalledWith('order-failed', 'failed', '外包支付失败');
    expect(completeOutsourcedPaymentOrder).not.toHaveBeenCalledWith('order-queued', expect.anything());
  });

  it('redacts pix payload and activation code from buyer API errors', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({
      ok: false,
      message: 'DP-FIRST-CODE failed 000201abcdefghijklmnopqrstuvwxyz1234567890pix',
    }));

    const promise = submitOutsourcedPixPayment({
      activationCode: 'DP-FIRST-CODE',
      pixCode: '000201abcdefghijklmnopqrstuvwxyz1234567890pix',
    });

    await expect(promise).rejects.toBeInstanceOf(OutsourcedBuyerApiError);
    await expect(promise).rejects.toMatchObject({
      code: 'OUTSOURCED_SUBMIT_FAILED',
      generationFailureDiagnostic: {
        detail: expect.stringContaining('[redacted-pix-code]'),
      },
    });
  });

  it('treats non-2xx buyer API responses as external API failures', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ message: 'service unavailable' }, { ok: false, status: 503 }),
    );

    await expect(selectOutsourcedActivationCode()).rejects.toMatchObject({
      code: 'OUTSOURCED_API_UNAVAILABLE',
      generationFailureDiagnostic: {
        httpStatus: 503,
      },
    });
  });
});

function jsonResponse(payload: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: async () => JSON.stringify(payload),
  } as Response;
}
