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
const generatePixPayment = vi.fn();
const selectOutsourcedActivationCode = vi.fn();
const submitOutsourcedPixPayment = vi.fn();
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
}));
vi.mock('./pix-payment.service.ts', () => ({ generatePixPayment }));
vi.mock('./outsourced-payment.service.ts', () => ({
  selectOutsourcedActivationCode,
  submitOutsourcedPixPayment,
}));
vi.mock('./settings.service.ts', () => ({
  selectHealthyProxy,
  recordProxySuccess,
  recordProxyFailure,
  shouldCountProxyFailure,
}));
vi.mock('../ws/index.ts', () => ({ broadcastOrderReady, broadcastOrderStatusChange }));

const { processPixGenerationJob } = await import('./pix-generation.service.ts');

const credential = {
  kind: 'access_token' as const,
  accessToken: 'access-token-value',
  sessionToken: 'session-token-value',
  deviceId: 'device-123',
  email: 'customer@example.com',
};

const stripeProxy = {
  id: 'stripe-proxy-1',
  proxyUrl: 'http://stripe:user@br-proxy.example:10001',
  maskedProxy: 'http://stripe:****@br-proxy.example:10001',
};

const chatGptProxy = {
  id: 'chatgpt-proxy-1',
  proxyUrl: 'http://chat:user@br-proxy.example:10000',
  maskedProxy: 'http://chat:****@br-proxy.example:10000',
};

function queuedOrder() {
  return {
    id: 'order-1',
    trackingToken: 'track-1',
    status: 'CREATING_PAYMENT',
    encryptedSessionData: 'encrypted:session-token-value',
    generationQueuedAt: new Date('2026-06-01T00:00:00.000Z'),
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
  };
}

describe('pix-generation.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseChatGptSessionInput.mockReturnValue(credential);
    selectHealthyProxy.mockResolvedValue(stripeProxy);
    shouldCountProxyFailure.mockReturnValue(false);
    selectOutsourcedActivationCode.mockResolvedValue('DP-FIRST-CODE');
    submitOutsourcedPixPayment.mockResolvedValue({
      ticketId: 'Toutsource123',
      status: 'queued',
      message: '已提交，后台处理中',
    });
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
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123?redirect_pm_type=pix&ui_mode=custom',
      profile: { name: 'Cliente Teste' },
      qrPngBuffer: Buffer.from('png'),
    });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
  });

  it('使用完整 ChatGPT 凭证和单个巴西代理生成 Pix 并落库', async () => {
    const pendingOrder = {
      ...queuedOrder(),
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-code',
      pixQrPng: Buffer.from('png'),
      pixExpiresAt: new Date(1781111404 * 1000),
      pixImageUrl: 'https://stripe.test/pix.png',
      completedAt: null,
    };
    prisma.order.findUnique.mockResolvedValueOnce(queuedOrder()).mockResolvedValueOnce(pendingOrder);

    await processPixGenerationJob({ orderId: 'order-1', finalAttempt: false });

    expect(parseChatGptSessionInput).toHaveBeenCalledWith('session-token-value');
    expect(selectHealthyProxy).toHaveBeenCalledTimes(1);
    expect(selectHealthyProxy).toHaveBeenCalledWith('stripe');
    expect(generatePixPayment).toHaveBeenCalledWith(
      credential,
      expect.objectContaining({
        proxy: {
          proxyUrl: 'http://stripe:user@br-proxy.example:10001',
          poolName: 'stripe',
        },
      }),
    );
    expect(prisma.order.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'order-1', status: 'CREATING_PAYMENT' },
      data: expect.objectContaining({
        status: 'PENDING_PAYMENT',
        checkoutSessionId: 'cs_test_123',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123?redirect_pm_type=pix&ui_mode=custom',
        setupIntentId: 'seti_test_123',
        encryptedSessionData: null,
        generationErrorCode: null,
        generationFinishedAt: expect.any(Date),
      }),
    });
    expect(recordProxySuccess).toHaveBeenCalledWith('stripe', 'stripe-proxy-1');
    expect(recordProxySuccess).not.toHaveBeenCalledWith('chatgpt', expect.anything());
    expect(broadcastOrderReady).toHaveBeenCalledWith(pendingOrder);
    expect(submitOutsourcedPixPayment).not.toHaveBeenCalled();
  });

  it('外包模式生成 Pix 后提交买家端 API 并保存外包票据，不广播给本地工人', async () => {
    const outsourcedOrder = {
      ...queuedOrder(),
      paymentHandler: 'OUTSOURCED_BUYER_API',
    };
    const pendingOrder = {
      ...outsourcedOrder,
      status: 'PENDING_PAYMENT',
      outsourcedTicketId: 'Toutsource123',
      outsourcedPaymentStatus: 'queued',
      pixCode: null,
      pixQrPng: null,
      pixImageUrl: null,
      completedAt: null,
    };
    prisma.order.findUnique.mockResolvedValueOnce(outsourcedOrder).mockResolvedValueOnce(pendingOrder);

    await processPixGenerationJob({ orderId: 'order-1', finalAttempt: false });

    expect(selectOutsourcedActivationCode).toHaveBeenCalledTimes(1);
    expect(submitOutsourcedPixPayment).toHaveBeenCalledWith({
      activationCode: 'DP-FIRST-CODE',
      pixCode: 'pix-code',
    });
    expect(prisma.order.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'order-1', status: 'CREATING_PAYMENT' },
      data: expect.objectContaining({
        status: 'PENDING_PAYMENT',
        paymentHandler: 'OUTSOURCED_BUYER_API',
        outsourcedTicketId: 'Toutsource123',
        outsourcedPaymentStatus: 'queued',
        outsourcedSubmittedAt: expect.any(Date),
        encryptedSessionData: null,
        pixCode: null,
        pixQrPng: null,
        pixImageUrl: null,
      }),
    });
    expect(broadcastOrderReady).not.toHaveBeenCalled();
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(pendingOrder);
  });

  it('只有 Stripe 图片链接且没有 Pix 码串时仍进入待付款并落库图片', async () => {
    const pendingOrder = {
      ...queuedOrder(),
      status: 'PENDING_PAYMENT',
      pixCode: null,
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: 'https://stripe.test/pix.png',
      completedAt: null,
    };
    prisma.order.findUnique.mockResolvedValueOnce(queuedOrder()).mockResolvedValueOnce(pendingOrder);
    generatePixPayment.mockResolvedValueOnce({
      stripeResult: {
        checkoutSessionId: 'cs_test_123',
        paymentMethodId: 'pm_test_123',
        pix: {
          data: null,
          expiresAt: undefined,
          imageUrlPng: 'https://stripe.test/pix.png',
          setupIntentId: undefined,
          setupIntentClientSecret: undefined,
        },
      },
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123?redirect_pm_type=pix&ui_mode=custom',
      profile: { name: 'Cliente Teste' },
      qrPngBuffer: null,
    });

    await processPixGenerationJob({ orderId: 'order-1', finalAttempt: false });

    expect(prisma.order.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'order-1', status: 'CREATING_PAYMENT' },
      data: expect.objectContaining({
        status: 'PENDING_PAYMENT',
        pixCode: null,
        pixQrPng: null,
        pixImageUrl: 'https://stripe.test/pix.png',
      }),
    });
    expect(broadcastOrderReady).toHaveBeenCalledWith(pendingOrder);
  });

  it('Stripe 代理池为空时回退 ChatGPT 代理池作为单代理出口', async () => {
    prisma.order.findUnique.mockResolvedValueOnce(queuedOrder()).mockResolvedValueOnce({
      ...queuedOrder(),
      status: 'PENDING_PAYMENT',
    });
    selectHealthyProxy.mockReset();
    selectHealthyProxy.mockResolvedValueOnce(null).mockResolvedValueOnce(chatGptProxy);

    await processPixGenerationJob({ orderId: 'order-1', finalAttempt: false });

    expect(selectHealthyProxy).toHaveBeenCalledWith('stripe');
    expect(selectHealthyProxy).toHaveBeenCalledWith('chatgpt');
    expect(generatePixPayment).toHaveBeenCalledWith(
      credential,
      expect.objectContaining({
        proxy: {
          proxyUrl: 'http://chat:user@br-proxy.example:10000',
          poolName: 'chatgpt',
        },
      }),
    );
    expect(recordProxySuccess).toHaveBeenCalledWith('chatgpt', 'chatgpt-proxy-1');
  });

  it('可重试代理失败在非最终尝试不释放兑换码', async () => {
    prisma.order.findUnique.mockResolvedValue(queuedOrder());
    const timeout = Object.assign(new Error('timeout'), {
      code: 'UPSTREAM_TIMEOUT',
      proxyPoolName: 'stripe',
      generationFailureDiagnostic: { stage: 'engine_io', detail: 'timeout', httpStatus: null },
    });
    generatePixPayment.mockRejectedValue(timeout);
    shouldCountProxyFailure.mockReturnValue(true);

    await expect(processPixGenerationJob({ orderId: 'order-1', finalAttempt: false })).rejects.toBe(timeout);

    expect(recordProxyFailure).toHaveBeenCalledWith('stripe', 'stripe-proxy-1', timeout);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('无法识别 session 时不选代理并直接释放兑换码', async () => {
    const failedOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'FAILED',
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    prisma.order.findUnique
      .mockResolvedValueOnce(queuedOrder())
      .mockResolvedValueOnce(failedOrder);
    parseChatGptSessionInput.mockImplementation(() => {
      throw Object.assign(new Error('bad session'), { code: 'CHATGPT_SESSION_UNRECOGNIZED' });
    });

    await processPixGenerationJob({ orderId: 'order-1', finalAttempt: false });

    expect(selectHealthyProxy).not.toHaveBeenCalled();
    expect(generatePixPayment).not.toHaveBeenCalled();
    expect(recordProxyFailure).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(failedOrder);
  });

  it('非 0 元账号无资格错误立即终止并写入脱敏诊断', async () => {
    const failedOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'FAILED',
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    prisma.order.findUnique
      .mockResolvedValueOnce(queuedOrder())
      .mockResolvedValueOnce(failedOrder);
    generatePixPayment.mockRejectedValue(Object.assign(new Error('account not eligible'), {
      statusCode: 400,
      code: 'ACCOUNT_NOT_ELIGIBLE',
      proxyPoolName: 'stripe',
      generationFailureDiagnostic: {
        stage: 'stripe_init',
        detail: 'amount_nonzero',
        httpStatus: 200,
      },
    }));

    await processPixGenerationJob({ orderId: 'order-1', finalAttempt: false });

    expect(recordProxyFailure).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const rawSqlCall = String(prisma.$executeRaw.mock.calls[0]);
    expect(rawSqlCall).toContain('ACCOUNT_NOT_ELIGIBLE');
    expect(rawSqlCall).toContain('stripe_init');
    expect(rawSqlCall).toContain('amount_nonzero');
    expect(rawSqlCall).toContain('200');
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(failedOrder);
  });
});
