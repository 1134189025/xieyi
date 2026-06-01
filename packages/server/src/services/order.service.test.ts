import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  order: {
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  redemptionCode: {
    findUnique: vi.fn(),
  },
};

const enqueuePixGenerationJob = vi.fn();
const getPixGenerationQueueSnapshot = vi.fn();
const getMaintenanceModeSetting = vi.fn();
const broadcastOrderStatusChange = vi.fn();
const encrypt = vi.fn((plaintext: string) => `encrypted:${plaintext}`);

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('../queues/pix-generation.queue.ts', () => ({
  enqueuePixGenerationJob,
  getPixGenerationQueueSnapshot,
  secondsPerGenerationEstimate: () => 300,
}));
vi.mock('./settings.service.ts', () => ({ getMaintenanceModeSetting }));
vi.mock('../utils/crypto.ts', () => ({ encrypt }));
vi.mock('../ws/index.ts', () => ({
  broadcastOrderStatusChange,
  broadcastOrderNew: vi.fn(),
}));

const {
  createOrder,
  completeOrder,
  getAdminOrders,
  getOrderByTrackingToken,
  getWorkerSummary,
  getWorkerOrders,
} = await import('./order.service.ts');

describe('order.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.order.count.mockResolvedValue(0);
    prisma.order.findMany.mockResolvedValue([]);
    getMaintenanceModeSetting.mockResolvedValue({ enabled: false });
    getPixGenerationQueueSnapshot.mockResolvedValue({
      waitingCount: 1,
      delayedCount: 0,
      activeCount: 0,
      failedCount: 0,
      orderIdsInQueue: ['order-1'],
      oldestWaitingTimestamp: Date.parse('2026-06-01T00:00:00.000Z'),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a queued payment order and enqueues Pix generation without calling upstream services', async () => {
    const queuedAt = new Date('2026-06-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(queuedAt);
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
      generationQueuedAt: queuedAt,
      createdAt: queuedAt,
    }]);
    enqueuePixGenerationJob.mockResolvedValue({ id: 'pix-generation-order-1' });

    const response = await createOrder('ABCD-1234', 'session-token-value');

    expect(response).toMatchObject({
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
      queueEstimate: {
        ordersAhead: 0,
        position: 1,
        pendingTotal: 1,
        currentGenerationCount: 0,
        estimatedQueueSeconds: 0,
        calculationSource: 'generation_queue',
      },
    });
    expect(enqueuePixGenerationJob).toHaveBeenCalledWith({ orderId: 'order-1' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('rejects new orders during maintenance mode before reserving a redemption code', async () => {
    getMaintenanceModeSetting.mockResolvedValue({ enabled: true });

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 503,
      code: 'MAINTENANCE_MODE',
    });

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(enqueuePixGenerationJob).not.toHaveBeenCalled();
  });

  it('releases the reserved code if queue enqueue fails before the tracking token is returned', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
      generationQueuedAt: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    }]);
    enqueuePixGenerationJob.mockRejectedValue(new Error('Custom Id cannot contain :'));

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 502,
      code: 'ORDER_QUEUE_UNAVAILABLE',
    });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('message=Custom Id cannot contain :'),
    );
  });

  it('reports generation queue position for a creating payment order', async () => {
    const createdAt = new Date('2026-06-01T00:10:00.000Z');
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-2',
      trackingToken: 'track-2',
      status: 'CREATING_PAYMENT',
      pixCode: null,
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: null,
      completedAt: null,
      createdAt,
      generationQueuedAt: createdAt,
      errorMessage: null,
    });
    getPixGenerationQueueSnapshot.mockResolvedValue({
      waitingCount: 4,
      delayedCount: 1,
      activeCount: 2,
      failedCount: 0,
      orderIdsInQueue: ['order-a', 'order-b', 'order-2', 'order-c', 'order-d'],
      oldestWaitingTimestamp: Date.parse('2026-06-01T00:00:00.000Z'),
    });

    await expect(getOrderByTrackingToken('track-2')).resolves.toMatchObject({
      status: 'CREATING_PAYMENT',
      queueEstimate: {
        ordersAhead: 2,
        position: 3,
        pendingTotal: 7,
        currentGenerationCount: 2,
        estimatedQueueSeconds: 600,
        secondsPerOrder: 300,
        calculationSource: 'generation_queue',
      },
    });
  });

  it('worker queue returns all pending payment orders in stable server order', async () => {
    const firstOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-1',
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    const secondOrder = {
      ...firstOrder,
      id: 'order-2',
      trackingToken: 'track-2',
      pixCode: 'pix-2',
      createdAt: new Date('2026-06-01T00:01:00.000Z'),
    };
    prisma.order.findMany.mockResolvedValue([firstOrder, secondOrder]);
    prisma.order.count.mockResolvedValue(2);

    const response = await getWorkerOrders(1, 20);

    expect(response).toMatchObject({
      total: 2,
      orders: [{ id: 'order-1' }, { id: 'order-2' }],
    });
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PENDING_PAYMENT' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('completeOrder completes a pending order without claim ownership', async () => {
    const completedAt = new Date('2026-06-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(completedAt);
    const completedOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PAYMENT_COMPLETED',
      completedAt,
    };
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUnique.mockResolvedValue(completedOrder);

    await expect(completeOrder('order-1')).resolves.toEqual({
      id: 'order-1',
      status: 'PAYMENT_COMPLETED',
      completedAt: completedAt.toISOString(),
    });

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'PENDING_PAYMENT' },
      data: {
        status: 'PAYMENT_COMPLETED',
        completedAt,
      },
    });
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(completedOrder);
  });

  it('worker summary counts total, today, and this week completions in Asia Shanghai time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T10:30:00.000Z'));
    prisma.order.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(5);

    await expect(getWorkerSummary()).resolves.toEqual({
      completedTotal: 10,
      completedToday: 2,
      completedThisWeek: 5,
    });
  });

  it('admin orders do not expose worker completion ownership', async () => {
    prisma.order.findMany.mockResolvedValue([{
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PAYMENT_COMPLETED',
      pixCode: 'pix-code',
      checkoutSessionId: 'cs_test_123',
      errorMessage: null,
      completedAt: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    }]);
    prisma.order.count.mockResolvedValue(1);

    const response = await getAdminOrders({ page: 1, limit: 50 });

    expect(response.orders[0]).not.toHaveProperty('completedBy');
  });
});
