import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  $executeRaw: vi.fn(),
  order: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
};

const decrypt = vi.fn((ciphertext: string) => ciphertext.replace(/^encrypted:/, ''));
const parseChatGptSessionInput = vi.fn();
const createCheckoutUrl = vi.fn();
const generatePixPayment = vi.fn();
const selectHealthyProxy = vi.fn();
const recordProxySuccess = vi.fn();
const recordProxyFailure = vi.fn();
const shouldCountProxyFailure = vi.fn();
const broadcastOrderReady = vi.fn();
const broadcastOrderStatusChange = vi.fn();

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('../utils/crypto.ts', () => ({ decrypt, encrypt: vi.fn((value: string) => `encrypted:${value}`) }));
vi.mock('./chatgpt-session.service.ts', () => ({
  parseChatGptSessionInput,
  createCheckoutUrl,
}));
vi.mock('./pix-payment.service.ts', () => ({ generatePixPayment }));
vi.mock('./settings.service.ts', () => ({
  selectHealthyProxy,
  recordProxySuccess,
  recordProxyFailure,
  shouldCountProxyFailure,
}));
vi.mock('../ws/index.ts', () => ({ broadcastOrderReady, broadcastOrderStatusChange }));

const { processPixGenerationJob } = await import('./pix-generation.service.ts');

describe('pix-generation.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseChatGptSessionInput.mockReturnValue({ kind: 'access_token', accessToken: 'access-token-value' });
    selectHealthyProxy
      .mockResolvedValueOnce({
        id: 'chatgpt-proxy-1',
        proxyUrl: 'http://chat:user@chat-proxy.example:10000',
        maskedProxy: 'http://chat:****@chat-proxy.example:10000',
      })
      .mockResolvedValueOnce({
        id: 'stripe-proxy-1',
        proxyUrl: 'http://stripe:user@stripe-proxy.example:10001',
        maskedProxy: 'http://stripe:****@stripe-proxy.example:10001',
      });
    createCheckoutUrl.mockResolvedValue('https://pay.openai.com/c/pay/cs_test_123');
    generatePixPayment.mockResolvedValue({
      stripeResult: {
        checkoutSessionId: 'cs_test_123',
        paymentMethodId: 'pm_test_123',
        pix: {
          data: 'pix-code',
          expiresAt: 1781111404,
          imageUrlPng: 'https://stripe.test/pix.png',
          setupIntentId: 'seti_test_123',
          setupIntentClientSecret: 'seti_test_123_secret_456',
        },
      },
      profile: { name: 'Cliente Teste' },
      qrPngBuffer: Buffer.from('png'),
    });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
  });

  it('generates Pix for a queued order using directly extracted accessToken and separate proxies', async () => {
    const queuedOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
      encryptedSessionData: 'encrypted:session-token-value',
      generationQueuedAt: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    const pendingOrder = {
      ...queuedOrder,
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-code',
      pixQrPng: Buffer.from('png'),
      pixExpiresAt: new Date(1781111404 * 1000),
      pixImageUrl: 'https://stripe.test/pix.png',
      completedAt: null,
    };
    prisma.order.findUnique.mockResolvedValueOnce(queuedOrder).mockResolvedValueOnce(pendingOrder);

    await processPixGenerationJob({ orderId: 'order-1', finalAttempt: false });

    expect(parseChatGptSessionInput).toHaveBeenCalledWith('session-token-value');
    expect(createCheckoutUrl).toHaveBeenCalledWith(
      'access-token-value',
      expect.objectContaining({ proxyUrl: 'http://chat:user@chat-proxy.example:10000' }),
    );
    expect(generatePixPayment).toHaveBeenCalledWith(
      'https://pay.openai.com/c/pay/cs_test_123',
      expect.objectContaining({ proxyUrl: 'http://stripe:user@stripe-proxy.example:10001' }),
    );
    expect(prisma.order.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'order-1', status: 'CREATING_PAYMENT' },
      data: expect.objectContaining({
        status: 'PENDING_PAYMENT',
        checkoutSessionId: 'cs_test_123',
        setupIntentId: 'seti_test_123',
        encryptedSessionData: null,
        generationErrorCode: null,
        generationFinishedAt: expect.any(Date),
      }),
    });
    expect(recordProxySuccess).toHaveBeenCalledWith('chatgpt', 'chatgpt-proxy-1');
    expect(recordProxySuccess).toHaveBeenCalledWith('stripe', 'stripe-proxy-1');
    expect(broadcastOrderReady).toHaveBeenCalledWith(pendingOrder);
    expect(broadcastOrderStatusChange).not.toHaveBeenCalledWith(pendingOrder);
  });

  it('retries proxy failures without releasing the code until the final attempt', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
      encryptedSessionData: 'encrypted:session-token-value',
      generationQueuedAt: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const timeout = Object.assign(new Error('timeout'), { code: 'UPSTREAM_TIMEOUT' });
    createCheckoutUrl.mockRejectedValue(timeout);
    shouldCountProxyFailure.mockReturnValue(true);

    await expect(processPixGenerationJob({ orderId: 'order-1', finalAttempt: false })).rejects.toBe(timeout);

    expect(recordProxyFailure).toHaveBeenCalledWith('chatgpt', 'chatgpt-proxy-1', timeout);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('retries ChatGPT checkout failures without releasing the code until the final attempt', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
      encryptedSessionData: 'encrypted:session-token-value',
      generationQueuedAt: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const checkoutFailure = Object.assign(new Error('checkout failed'), { code: 'CHATGPT_CHECKOUT_FAILED' });
    createCheckoutUrl.mockRejectedValue(checkoutFailure);
    shouldCountProxyFailure.mockReturnValue(true);

    await expect(processPixGenerationJob({ orderId: 'order-1', finalAttempt: false })).rejects.toBe(checkoutFailure);

    expect(recordProxyFailure).toHaveBeenCalledWith('chatgpt', 'chatgpt-proxy-1', checkoutFailure);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('rejects unparseable session input before selecting proxies without waiting for the final attempt', async () => {
    const failedOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'FAILED',
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    prisma.order.findUnique
      .mockResolvedValueOnce({
        id: 'order-1',
        trackingToken: 'track-1',
        status: 'CREATING_PAYMENT',
        encryptedSessionData: 'encrypted:legacy-session-cookie',
        generationQueuedAt: new Date('2026-06-01T00:00:00.000Z'),
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      })
      .mockResolvedValueOnce(failedOrder);
    parseChatGptSessionInput.mockImplementation(() => {
      throw Object.assign(new Error('bad session'), { code: 'CHATGPT_SESSION_UNRECOGNIZED' });
    });

    await processPixGenerationJob({ orderId: 'order-1', finalAttempt: false });

    expect(selectHealthyProxy).not.toHaveBeenCalled();
    expect(createCheckoutUrl).not.toHaveBeenCalled();
    expect(generatePixPayment).not.toHaveBeenCalled();
    expect(recordProxyFailure).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(failedOrder);
  });

  it('marks the order failed and releases the code when generation fails on the final attempt', async () => {
    const failedOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'FAILED',
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    prisma.order.findUnique
      .mockResolvedValueOnce({
        id: 'order-1',
        trackingToken: 'track-1',
        status: 'CREATING_PAYMENT',
        encryptedSessionData: 'encrypted:session-token-value',
        generationQueuedAt: new Date('2026-06-01T00:00:00.000Z'),
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      })
      .mockResolvedValueOnce(failedOrder);
    generatePixPayment.mockRejectedValue(Object.assign(new Error('account not eligible'), {
      statusCode: 400,
      code: 'ACCOUNT_NOT_ELIGIBLE',
    }));
    shouldCountProxyFailure.mockReturnValue(false);

    await processPixGenerationJob({ orderId: 'order-1', finalAttempt: true });

    expect(recordProxyFailure).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(failedOrder);
  });

  it('marks account-not-eligible failures terminal without waiting for the final attempt', async () => {
    const failedOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'FAILED',
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    prisma.order.findUnique
      .mockResolvedValueOnce({
        id: 'order-1',
        trackingToken: 'track-1',
        status: 'CREATING_PAYMENT',
        encryptedSessionData: 'encrypted:session-token-value',
        generationQueuedAt: new Date('2026-06-01T00:00:00.000Z'),
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      })
      .mockResolvedValueOnce(failedOrder);
    generatePixPayment.mockRejectedValue(Object.assign(new Error('account not eligible'), {
      statusCode: 400,
      code: 'ACCOUNT_NOT_ELIGIBLE',
    }));
    shouldCountProxyFailure.mockReturnValue(false);

    await processPixGenerationJob({ orderId: 'order-1', finalAttempt: false });

    expect(recordProxyFailure).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(failedOrder);
  });
});
