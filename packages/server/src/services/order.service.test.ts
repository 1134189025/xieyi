import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  $transaction: vi.fn(),
  redemptionCode: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  order: {
    create: vi.fn(),
    deleteMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
};

const parseChatGptSessionInput = vi.fn();
const resolveAccessToken = vi.fn();
const createCheckoutUrl = vi.fn();
const generatePixPayment = vi.fn();
const broadcastOrderNew = vi.fn();

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('./chatgpt-session.service.ts', () => ({ parseChatGptSessionInput, resolveAccessToken, createCheckoutUrl }));
vi.mock('./pix-payment.service.ts', () => ({ generatePixPayment }));
vi.mock('../ws/index.ts', () => ({
  broadcastOrderNew,
  broadcastOrderStatusChange: vi.fn(),
}));

const { createOrder, completeOrder, getOrderByTrackingToken } = await import('./order.service.ts');

describe('order.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseChatGptSessionInput.mockReturnValue({ kind: 'session_token', sessionToken: 'session-token-value' });
  });

  it('兑换码不可预占时不调用外部支付流程', async () => {
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma),
    );
    prisma.redemptionCode.updateMany.mockResolvedValue({ count: 0 });
    prisma.redemptionCode.findUnique.mockResolvedValue({ id: 'code-1' });

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 400,
      code: 'CODE_USED',
    });

    expect(prisma.redemptionCode.updateMany).toHaveBeenCalledWith({
      where: { code: 'ABCD-1234', usedAt: null },
      data: { usedAt: expect.any(Date) },
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
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma),
    );
    prisma.redemptionCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.redemptionCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.order.create.mockResolvedValue({
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    });
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

    expect(prisma.order.deleteMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'CREATING_PAYMENT' },
    });
    expect(prisma.redemptionCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { usedAt: null },
    });
    expect(prisma.order.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });

  it('Stripe Pix 创建失败后释放兑换码并返回安全支付错误', async () => {
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma),
    );
    prisma.redemptionCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.redemptionCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.order.create.mockResolvedValue({
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    });
    prisma.order.deleteMany.mockResolvedValue({ count: 1 });
    resolveAccessToken.mockResolvedValue('access-token-value');
    createCheckoutUrl.mockResolvedValue('https://pay.openai.com/c/pay/cs_test_123');
    generatePixPayment.mockRejectedValue(new Error('Stripe token leaked upstream'));

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 502,
      code: 'PAYMENT_FAILED',
      message: '支付创建失败，请稍后重试',
    });

    expect(prisma.order.deleteMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'CREATING_PAYMENT' },
    });
    expect(prisma.redemptionCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { usedAt: null },
    });
  });

  it('支付创建成功后保留兑换码占用并广播待支付订单', async () => {
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma),
    );
    prisma.redemptionCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.redemptionCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.order.create.mockResolvedValue({
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    });
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
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-code',
      pixImageUrl: 'https://stripe.test/pix.png',
    });

    await expect(createOrder('ABCD-1234', 'session-token-value')).resolves.toMatchObject({
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-code',
    });

    expect(prisma.order.deleteMany).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'CREATING_PAYMENT' },
      data: expect.objectContaining({
        status: 'PENDING_PAYMENT',
        checkoutSessionId: 'cs_test_123',
      }),
    });
    expect(prisma.order.findUnique).toHaveBeenCalledWith({ where: { id: 'order-1' } });
    expect(broadcastOrderNew).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'order-1',
        status: 'PENDING_PAYMENT',
      }),
    );
    expect(prisma.redemptionCode.update).not.toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { usedAt: null },
    });
  });

  it('创建中订单被取消后不会被支付创建结果复活', async () => {
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma),
    );
    prisma.redemptionCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.redemptionCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.order.create.mockResolvedValue({
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    });
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
    expect(prisma.order.deleteMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'CREATING_PAYMENT' },
    });
    expect(prisma.redemptionCode.update).not.toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { usedAt: null },
    });
    expect(broadcastOrderNew).not.toHaveBeenCalled();
  });

  it('无稳定 code 的内部错误会转为安全支付错误', async () => {
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma),
    );
    prisma.redemptionCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.redemptionCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.order.create.mockResolvedValue({
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
    });
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
});
