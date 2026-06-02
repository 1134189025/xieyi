import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  order: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
  },
};

const getAutoPaymentDetectionSetting = vi.fn();
const selectHealthyProxy = vi.fn();
const recordProxySuccess = vi.fn();
const recordProxyFailure = vi.fn();
const shouldCountProxyFailure = vi.fn();
const decrypt = vi.fn((ciphertext: string) => ciphertext.replace(/^encrypted:/, ''));
const retrieveStripeSetupIntentStatus = vi.fn();
const broadcastOrderStatusChange = vi.fn();

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('./settings.service.ts', () => ({
  getAutoPaymentDetectionSetting,
  selectHealthyProxy,
  recordProxySuccess,
  recordProxyFailure,
  shouldCountProxyFailure,
}));
vi.mock('../utils/crypto.ts', () => ({ decrypt }));
vi.mock('@pix/core', () => ({ retrieveStripeSetupIntentStatus }));
vi.mock('../ws/index.ts', () => ({ broadcastOrderStatusChange }));

const { detectCompletedPixPayments } = await import('./payment-status.service.ts');

describe('payment-status.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAutoPaymentDetectionSetting.mockResolvedValue({ enabled: true });
    selectHealthyProxy.mockResolvedValue({
      id: 'stripe-proxy-1',
      proxyUrl: 'http://stripe:user@stripe-proxy.example:10001',
      maskedProxy: 'http://stripe:****@stripe-proxy.example:10001',
    });
    shouldCountProxyFailure.mockReturnValue(false);
    prisma.order.findMany.mockResolvedValue([]);
  });

  it('does not query Stripe when automatic payment detection is disabled', async () => {
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

  it('uses the Stripe proxy pool and completes succeeded SetupIntents by order status only', async () => {
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

    expect(selectHealthyProxy).toHaveBeenCalledWith('stripe');
    expect(retrieveStripeSetupIntentStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        setupIntentId: 'seti_123',
        clientSecret: 'seti_123_secret_456',
        proxyUrl: 'http://stripe:user@stripe-proxy.example:10001',
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
    expect(recordProxySuccess).toHaveBeenCalledWith('stripe', 'stripe-proxy-1');
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(completedOrder);
  });

  it('scans pending payment orders in stable order', async () => {
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

  it('does not revive an order if it changed before automatic completion update', async () => {
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

  it('leaves requires_action orders untouched', async () => {
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

  it('records retryable Stripe proxy failures without failing the detector loop', async () => {
    const timeout = Object.assign(new Error('timeout'), { code: 'UPSTREAM_TIMEOUT' });
    prisma.order.findMany.mockResolvedValue([{
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      setupIntentId: 'seti_123',
      setupIntentClientSecret: 'encrypted:seti_123_secret_456',
    }]);
    retrieveStripeSetupIntentStatus.mockRejectedValue(timeout);
    shouldCountProxyFailure.mockReturnValue(true);

    await expect(detectCompletedPixPayments()).resolves.toMatchObject({
      checked: 1,
      completed: 0,
    });

    expect(recordProxyFailure).toHaveBeenCalledWith('stripe', 'stripe-proxy-1', timeout);
  });

  it('skips overlapping automatic detection runs', async () => {
    let resolveSetting!: (value: { enabled: boolean }) => void;
    getAutoPaymentDetectionSetting.mockReturnValueOnce(new Promise((resolve) => {
      resolveSetting = resolve;
    }));

    const firstRun = detectCompletedPixPayments();

    await expect(detectCompletedPixPayments()).resolves.toEqual({
      checked: 0,
      completed: 0,
      disabled: false,
      skipped: true,
    });

    resolveSetting({ enabled: true });
    await expect(firstRun).resolves.toEqual({
      checked: 0,
      completed: 0,
      disabled: false,
      skipped: false,
    });
  });
});
