import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  redemptionCode: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    updateManyAndReturn: vi.fn(),
    update: vi.fn(),
  },
  order: {
    create: vi.fn(),
    deleteMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
};

const parseChatGptSessionInput = vi.fn();
const resolveAccessToken = vi.fn();
const createCheckoutUrl = vi.fn();
const generatePixPayment = vi.fn();
const broadcastOrderNew = vi.fn();
const getConfiguredProxyUrl = vi.fn();
const encrypt = vi.fn((plaintext: string) => `encrypted:${plaintext}`);

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('./chatgpt-session.service.ts', () => ({ parseChatGptSessionInput, resolveAccessToken, createCheckoutUrl }));
vi.mock('./pix-payment.service.ts', () => ({ generatePixPayment }));
vi.mock('./settings.service.ts', () => ({ getConfiguredProxyUrl }));
vi.mock('../utils/crypto.ts', () => ({ encrypt }));
vi.mock('../ws/index.ts', () => ({
  broadcastOrderNew,
  broadcastOrderStatusChange: vi.fn(),
}));

const {
  createOrder,
  completeOrder,
  getAdminOrders,
  getOrderByTrackingToken,
  getWorkerOrders,
} = await import('./order.service.ts');

describe('order.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseChatGptSessionInput.mockReturnValue({ kind: 'session_token', sessionToken: 'session-token-value' });
    getConfiguredProxyUrl.mockResolvedValue(null);
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.order.count.mockResolvedValue(0);
    prisma.order.findMany.mockResolvedValue([]);
  });

  it('使用单条 CTE 原子预占兑换码并创建订单，不再用 interactive transaction', async () => {
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    }]);
    resolveAccessToken.mockRejectedValue(
      Object.assign(new Error('session failed'), {
        statusCode: 502,
        code: 'CHATGPT_SESSION_FAILED',
      }),
    );

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      code: 'CHATGPT_SESSION_FAILED',
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.redemptionCode.updateManyAndReturn).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('兑换码不可预占时不调用外部支付流程', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.redemptionCode.findUnique.mockResolvedValue({ id: 'code-1' });

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 400,
      code: 'CODE_USED',
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(resolveAccessToken).not.toHaveBeenCalled();
    expect(generatePixPayment).not.toHaveBeenCalled();
  });

  it('兑换码不存在时返回无效兑换码', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.redemptionCode.findUnique.mockResolvedValue(null);

    await expect(createOrder('MISSING', 'session-token-value')).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_CODE',
    });

    expect(resolveAccessToken).not.toHaveBeenCalled();
    expect(generatePixPayment).not.toHaveBeenCalled();
  });

  it('无法识别 session 时不预占兑换码', async () => {
    parseChatGptSessionInput.mockImplementation(() => {
      const error = new Error('无法识别 ChatGPT Session');
      Object.assign(error, { statusCode: 400, code: 'CHATGPT_SESSION_UNRECOGNIZED' });
      throw error;
    });

    await expect(createOrder('ABCD-1234', '{"user":{}}')).rejects.toMatchObject({
      statusCode: 400,
      code: 'CHATGPT_SESSION_UNRECOGNIZED',
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.redemptionCode.updateMany).not.toHaveBeenCalled();
    expect(resolveAccessToken).not.toHaveBeenCalled();
  });

  it('ChatGPT Session 验证失败后删除创建中订单并释放兑换码', async () => {
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    }]);
    prisma.order.deleteMany.mockResolvedValue({ count: 1 });
    resolveAccessToken.mockRejectedValue(
      Object.assign(new Error('session failed'), {
        statusCode: 502,
        code: 'CHATGPT_SESSION_FAILED',
      }),
    );

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 502,
      code: 'CHATGPT_SESSION_FAILED',
    });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.order.deleteMany).not.toHaveBeenCalled();
    expect(prisma.redemptionCode.update).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });

  it('Stripe Pix 创建失败后释放兑换码并返回安全支付错误', async () => {
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    }]);
    prisma.order.deleteMany.mockResolvedValue({ count: 1 });
    resolveAccessToken.mockResolvedValue('access-token-value');
    createCheckoutUrl.mockResolvedValue('https://pay.openai.com/c/pay/cs_test_123');
    generatePixPayment.mockRejectedValue(new Error('Stripe token leaked upstream'));

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 502,
      code: 'PAYMENT_FAILED',
      message: '支付创建失败，请稍后重试',
    });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('账号无资格时释放兑换码并保留稳定错误码', async () => {
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    }]);
    prisma.order.deleteMany.mockResolvedValue({ count: 1 });
    resolveAccessToken.mockResolvedValue('access-token-value');
    createCheckoutUrl.mockResolvedValue('https://pay.openai.com/c/pay/cs_test_123');
    generatePixPayment.mockRejectedValue(
      Object.assign(new Error('账号无资格，无法生成 Pix 支付'), {
        statusCode: 400,
        code: 'ACCOUNT_NOT_ELIGIBLE',
      }),
    );

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 400,
      code: 'ACCOUNT_NOT_ELIGIBLE',
      message: '账号无资格，无法生成 Pix 支付',
    });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('创建订单时把后台代理配置传给 ChatGPT 和 Stripe 流程', async () => {
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    }]);
    getConfiguredProxyUrl.mockResolvedValue('http://user:pass@proxy.example:10000');
    resolveAccessToken.mockResolvedValue('access-token-value');
    createCheckoutUrl.mockResolvedValue('https://pay.openai.com/c/pay/cs_test_123');
    generatePixPayment.mockResolvedValue({
      stripeResult: {
        checkoutSessionId: 'cs_test_123',
        paymentMethodId: 'pm_test_123',
        pix: { data: 'pix-code' },
      },
      profile: { name: 'Cliente Teste' },
      qrPngBuffer: Buffer.from('png'),
    });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-code',
      pixImageUrl: null,
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    await createOrder('ABCD-1234', 'session-token-value');

    expect(resolveAccessToken).toHaveBeenCalledWith(
      { kind: 'session_token', sessionToken: 'session-token-value' },
      expect.objectContaining({ proxyUrl: 'http://user:pass@proxy.example:10000' }),
    );
    expect(createCheckoutUrl).toHaveBeenCalledWith(
      'access-token-value',
      expect.objectContaining({ proxyUrl: 'http://user:pass@proxy.example:10000' }),
    );
    expect(generatePixPayment).toHaveBeenCalledWith(
      'https://pay.openai.com/c/pay/cs_test_123',
      expect.objectContaining({ proxyUrl: 'http://user:pass@proxy.example:10000' }),
    );
  });

  it('支付创建成功后保留兑换码占用并广播待支付订单', async () => {
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    }]);
    resolveAccessToken.mockResolvedValue('access-token-value');
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
          setupIntentStatus: 'requires_action',
        },
      },
      profile: { name: 'Cliente Teste' },
      qrPngBuffer: Buffer.from('png'),
    });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-code',
      pixImageUrl: 'https://stripe.test/pix.png',
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    const response = await createOrder('ABCD-1234', 'session-token-value');

    expect(response).toMatchObject({
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-code',
      queueEstimate: {
        ordersAhead: 0,
        position: 1,
        pendingTotal: 1,
        estimatedQueueSeconds: 0,
        secondsPerOrder: 300,
        calculationSource: 'default',
        calculatedAt: expect.any(String),
      },
    });
    expect(response).not.toHaveProperty('setupIntentClientSecret');

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'CREATING_PAYMENT' },
      data: expect.objectContaining({
        status: 'PENDING_PAYMENT',
        checkoutSessionId: 'cs_test_123',
        setupIntentId: 'seti_test_123',
        setupIntentClientSecret: 'encrypted:seti_test_123_secret_456',
      }),
    });
    expect(prisma.order.findUnique).toHaveBeenCalledWith({ where: { id: 'order-1' } });
    expect(broadcastOrderNew).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'order-1',
        status: 'PENDING_PAYMENT',
      }),
    );
  });

  it('支付创建成功后队列估算失败不会把订单误报为支付失败', async () => {
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    }]);
    resolveAccessToken.mockResolvedValue('access-token-value');
    createCheckoutUrl.mockResolvedValue('https://pay.openai.com/c/pay/cs_test_123');
    generatePixPayment.mockResolvedValue({
      stripeResult: {
        checkoutSessionId: 'cs_test_123',
        paymentMethodId: 'pm_test_123',
        pix: { data: 'pix-code' },
      },
      profile: { name: 'Cliente Teste' },
      qrPngBuffer: Buffer.from('png'),
    });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-code',
      pixImageUrl: null,
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    prisma.order.count.mockRejectedValueOnce(new Error('queue estimate unavailable'));

    await expect(createOrder('ABCD-1234', 'session-token-value')).resolves.toMatchObject({
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      queueEstimate: null,
    });

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(broadcastOrderNew).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'order-1',
        status: 'PENDING_PAYMENT',
      }),
    );
  });

  it('创建中订单被取消后不会被支付创建结果复活', async () => {
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    }]);
    resolveAccessToken.mockResolvedValue('access-token-value');
    createCheckoutUrl.mockResolvedValue('https://pay.openai.com/c/pay/cs_test_123');
    generatePixPayment.mockResolvedValue({
      stripeResult: {
        checkoutSessionId: 'cs_test_123',
        paymentMethodId: 'pm_test_123',
        pix: {
          data: 'pix-code',
          expiresAt: 1781111404,
          imageUrlPng: 'https://stripe.test/pix.png',
        },
      },
      profile: { name: 'Cliente Teste' },
      qrPngBuffer: Buffer.from('png'),
    });
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CANCELLED',
    });
    prisma.order.deleteMany.mockResolvedValue({ count: 0 });

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_STATE_CHANGED',
      message: '订单状态已变化，请重新提交或联系管理员',
    });

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'CREATING_PAYMENT' },
      data: expect.objectContaining({ status: 'PENDING_PAYMENT' }),
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.redemptionCode.update).not.toHaveBeenCalled();
    expect(broadcastOrderNew).not.toHaveBeenCalled();
  });

  it('无稳定 code 的内部错误会转为安全支付错误', async () => {
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    }]);
    prisma.order.deleteMany.mockResolvedValue({ count: 1 });
    resolveAccessToken.mockRejectedValue(
      Object.assign(new Error('No accessToken in ChatGPT session response'), {
        statusCode: 502,
      }),
    );

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 502,
      code: 'PAYMENT_FAILED',
      message: '支付创建失败，请稍后重试',
    });
  });

  it('订单创建 P2028 时释放本次预占并返回繁忙错误', async () => {
    prisma.$queryRaw.mockRejectedValue(
      Object.assign(new Error('Transaction already closed'), {
        code: 'P2028',
      }),
    );

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_CREATE_BUSY',
      message: '订单创建繁忙，请稍后重试',
    });

    expect(prisma.redemptionCode.updateMany).not.toHaveBeenCalled();
    expect(resolveAccessToken).not.toHaveBeenCalled();
  });

  it('订单创建遇到兑换码唯一冲突时返回已使用且不释放已有占用', async () => {
    prisma.$queryRaw.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['redemptionCodeId'] },
      }),
    );

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 400,
      code: 'CODE_USED',
    });

    expect(prisma.redemptionCode.updateMany).not.toHaveBeenCalled();
    expect(resolveAccessToken).not.toHaveBeenCalled();
  });

  it('raw query 包装的兑换码唯一冲突也返回已使用', async () => {
    prisma.$queryRaw.mockRejectedValue(
      Object.assign(new Error('Raw query failed'), {
        code: 'P2010',
        meta: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "orders_redemption_code_id_key"',
        },
      }),
    );

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 400,
      code: 'CODE_USED',
    });

    expect(resolveAccessToken).not.toHaveBeenCalled();
  });

  it('tracking token 唯一冲突不误判为兑换码已使用', async () => {
    prisma.$queryRaw.mockRejectedValue(
      Object.assign(new Error('Raw query failed'), {
        code: 'P2010',
        meta: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "orders_tracking_token_key"',
        },
      }),
    );

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 502,
      code: 'PAYMENT_FAILED',
    });

    expect(resolveAccessToken).not.toHaveBeenCalled();
  });

  it('完成订单使用条件状态更新避免并发覆盖', async () => {
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', status: 'PAYMENT_COMPLETED' });

    await expect(completeOrder('order-1', 'worker-1')).rejects.toMatchObject({
      statusCode: 409,
    });

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'PENDING_PAYMENT' },
      data: {
        status: 'PAYMENT_COMPLETED',
        completedById: 'worker-1',
        completedAt: expect.any(Date),
      },
    });
  });

  it('公开追踪接口不暴露内部错误详情', async () => {
    prisma.order.findUnique.mockResolvedValue({
      trackingToken: 'track-1',
      status: 'FAILED',
      pixCode: null,
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: null,
      completedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      errorMessage: 'Stripe request failed: 400 token=secret',
    });

    await expect(getOrderByTrackingToken('track-1')).resolves.toMatchObject({
      status: 'FAILED',
      errorMessage: '支付创建失败，请稍后重试',
    });
  });

  it('公开追踪接口为待支付订单返回队列估算并只统计前方待支付订单', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-current',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-code',
      pixQrPng: Buffer.from('png'),
      pixExpiresAt: new Date('2026-06-01T01:00:00.000Z'),
      pixImageUrl: null,
      completedAt: null,
      createdAt: new Date('2026-06-01T00:10:00.000Z'),
      errorMessage: null,
    });
    prisma.order.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(5);
    prisma.order.findMany.mockResolvedValue([
      {
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        completedAt: new Date('2026-06-01T00:04:00.000Z'),
      },
      {
        createdAt: new Date('2026-06-01T00:01:00.000Z'),
        completedAt: new Date('2026-06-01T00:06:00.000Z'),
      },
      {
        createdAt: new Date('2026-06-01T00:02:00.000Z'),
        completedAt: new Date('2026-06-01T00:08:00.000Z'),
      },
    ]);

    await expect(getOrderByTrackingToken('track-1')).resolves.toMatchObject({
      queueEstimate: {
        ordersAhead: 2,
        position: 3,
        pendingTotal: 5,
        estimatedQueueSeconds: 600,
        secondsPerOrder: 300,
        calculationSource: 'recent_completion_cadence',
        calculatedAt: expect.any(String),
      },
    });

    expect(prisma.order.count).toHaveBeenNthCalledWith(1, {
      where: {
        status: 'PENDING_PAYMENT',
        OR: [
          { createdAt: { lt: new Date('2026-06-01T00:10:00.000Z') } },
          { createdAt: new Date('2026-06-01T00:10:00.000Z'), id: { lt: 'order-current' } },
        ],
      },
    });
    expect(prisma.order.count).toHaveBeenNthCalledWith(2, {
      where: { status: 'PENDING_PAYMENT' },
    });
  });

  it('公开追踪接口为非待支付订单返回空队列估算', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PAYMENT_COMPLETED',
      pixCode: null,
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: null,
      completedAt: new Date('2026-06-01T00:20:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      errorMessage: null,
    });

    await expect(getOrderByTrackingToken('track-1')).resolves.toMatchObject({
      queueEstimate: null,
    });

    expect(prisma.order.count).not.toHaveBeenCalled();
  });

  it('队列估算在近期完成样本不足时使用默认耗时', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-current',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-code',
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: null,
      completedAt: null,
      createdAt: new Date('2026-06-01T00:10:00.000Z'),
      errorMessage: null,
    });
    prisma.order.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    prisma.order.findMany.mockResolvedValue([
      {
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        completedAt: new Date('2026-06-01T00:02:00.000Z'),
      },
    ]);

    await expect(getOrderByTrackingToken('track-1')).resolves.toMatchObject({
      queueEstimate: {
        ordersAhead: 1,
        position: 2,
        pendingTotal: 2,
        estimatedQueueSeconds: 300,
        secondsPerOrder: 300,
        calculationSource: 'default',
      },
    });
  });

  it('工人队列使用和客户排队估算一致的稳定排序', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);

    await getWorkerOrders(1, 20);

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PENDING_PAYMENT' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('后台订单列表把自动完成订单显示为自动检测', async () => {
    prisma.order.findMany.mockResolvedValue([{
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PAYMENT_COMPLETED',
      pixCode: 'pix-code',
      checkoutSessionId: 'cs_test_123',
      errorMessage: null,
      completedBy: null,
      completedAt: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    }]);
    prisma.order.count.mockResolvedValue(1);

    await expect(getAdminOrders({ page: 1, limit: 50 })).resolves.toMatchObject({
      orders: [{
        id: 'order-1',
        completedBy: {
          id: 'auto-payment-detection',
          displayName: '自动检测',
        },
      }],
    });
  });
});
