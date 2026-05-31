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
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
};

const resolveAccessToken = vi.fn();
const createCheckoutUrl = vi.fn();
const generatePixPayment = vi.fn();

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('./chatgpt-session.service.ts', () => ({ resolveAccessToken, createCheckoutUrl }));
vi.mock('./pix-payment.service.ts', () => ({ generatePixPayment }));
vi.mock('../ws/index.ts', () => ({
  broadcastOrderNew: vi.fn(),
  broadcastOrderStatusChange: vi.fn(),
}));

const { createOrder, completeOrder, getOrderByTrackingToken } = await import('./order.service.ts');

describe('order.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
