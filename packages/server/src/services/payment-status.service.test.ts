import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  order: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
  },
};

const getAutoPaymentDetectionSetting = vi.fn();
const getConfiguredProxyUrl = vi.fn();
const decrypt = vi.fn((ciphertext: string) => ciphertext.replace(/^encrypted:/, ''));
const retrieveStripeSetupIntentStatus = vi.fn();
const broadcastOrderStatusChange = vi.fn();

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('./settings.service.ts', () => ({ getAutoPaymentDetectionSetting, getConfiguredProxyUrl }));
vi.mock('../utils/crypto.ts', () => ({ decrypt }));
vi.mock('@pix/core', () => ({ retrieveStripeSetupIntentStatus }));
vi.mock('../ws/index.ts', () => ({ broadcastOrderStatusChange }));

const { detectCompletedPixPayments } = await import('./payment-status.service.ts');

describe('payment-status.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAutoPaymentDetectionSetting.mockResolvedValue({ enabled: true });
    getConfiguredProxyUrl.mockResolvedValue(null);
    prisma.order.findMany.mockResolvedValue([]);
  });

  it('自动检测开关关闭时不查询 Stripe', async () => {
    getAutoPaymentDetectionSetting.mockResolvedValue({ enabled: false });

    await expect(detectCompletedPixPayments()).resolves.toEqual({
      checked: 0,
      completed: 0,
      disabled: true,
      skipped: false,
    });

    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(retrieveStripeSetupIntentStatus).not.toHaveBeenCalled();
  });

  it('Stripe 返回 succeeded 时只按状态自动完成订单并广播', async () => {
    const pendingOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      setupIntentId: 'seti_123',
      setupIntentClientSecret: 'encrypted:seti_123_secret_456',
    };
    const completedOrder = {
      ...pendingOrder,
      status: 'PAYMENT_COMPLETED',
      completedAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    prisma.order.findMany.mockResolvedValue([pendingOrder]);
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUnique.mockResolvedValue(completedOrder);
    retrieveStripeSetupIntentStatus.mockResolvedValue({ id: 'seti_123', status: 'succeeded' });

    await expect(detectCompletedPixPayments()).resolves.toMatchObject({
      checked: 1,
      completed: 1,
      disabled: false,
      skipped: false,
    });

    expect(retrieveStripeSetupIntentStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        setupIntentId: 'seti_123',
        clientSecret: 'seti_123_secret_456',
        retry: { attempts: 3 },
      }),
    );
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'PENDING_PAYMENT' },
      data: {
        status: 'PAYMENT_COMPLETED',
        completedAt: expect.any(Date),
      },
    });
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(completedOrder);
  });

  it('自动检测按客户队列一致的稳定顺序扫描待支付订单', async () => {
    await detectCompletedPixPayments();

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'PENDING_PAYMENT',
          setupIntentId: { not: null },
          setupIntentClientSecret: { not: null },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('订单已取消或过期时不会被自动检测复活', async () => {
    prisma.order.findMany.mockResolvedValue([{
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      setupIntentId: 'seti_123',
      setupIntentClientSecret: 'encrypted:seti_123_secret_456',
    }]);
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    retrieveStripeSetupIntentStatus.mockResolvedValue({ id: 'seti_123', status: 'succeeded' });

    await expect(detectCompletedPixPayments()).resolves.toMatchObject({
      checked: 1,
      completed: 0,
    });

    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(broadcastOrderStatusChange).not.toHaveBeenCalled();
  });

  it('requires_action 状态只继续等待不修改订单', async () => {
    prisma.order.findMany.mockResolvedValue([{
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      setupIntentId: 'seti_123',
      setupIntentClientSecret: 'encrypted:seti_123_secret_456',
    }]);
    retrieveStripeSetupIntentStatus.mockResolvedValue({ id: 'seti_123', status: 'requires_action' });

    await expect(detectCompletedPixPayments()).resolves.toMatchObject({
      checked: 1,
      completed: 0,
    });

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(broadcastOrderStatusChange).not.toHaveBeenCalled();
  });
  it('Stripe 返回的 SetupIntent id 与订单不一致时不自动完成', async () => {
    prisma.order.findMany.mockResolvedValue([{
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      setupIntentId: 'seti_123',
      setupIntentClientSecret: 'encrypted:seti_123_secret_456',
    }]);
    retrieveStripeSetupIntentStatus.mockResolvedValue({ id: 'seti_other', status: 'succeeded' });

    await expect(detectCompletedPixPayments()).resolves.toMatchObject({
      checked: 1,
      completed: 0,
    });

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(broadcastOrderStatusChange).not.toHaveBeenCalled();
  });
});
