import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  $queryRaw: vi.fn(),
  order: {
    count: vi.fn(),
  },
  redemptionCode: {
    count: vi.fn(),
  },
  user: {
    findMany: vi.fn(),
  },
};

const getPixGenerationQueueMetrics = vi.fn();
const getProxyPoolHealthSummary = vi.fn();

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('../queues/pix-generation.queue.ts', () => ({ getPixGenerationQueueMetrics }));
vi.mock('./settings.service.ts', () => ({ getProxyPoolHealthSummary }));

const { getDashboardStats } = await import('./dashboard.service.ts');

describe('dashboard.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ average_seconds: 180 }]);
    prisma.redemptionCode.count.mockResolvedValueOnce(30).mockResolvedValueOnce(12);
    getPixGenerationQueueMetrics.mockResolvedValue({
      waitingCount: 8,
      delayedCount: 1,
      activeCount: 2,
      failedCount: 3,
      oldestWaitingSeconds: 420,
    });
    getProxyPoolHealthSummary.mockResolvedValue({
      chatGpt: { total: 3, healthy: 2, coolingDown: 1 },
      stripe: { total: 4, healthy: 4, coolingDown: 0 },
    });
  });

  it('returns global completion counters and queue operations metrics without per-worker performance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T10:30:00.000Z'));
    prisma.order.count
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);

    const stats = await getDashboardStats();

    expect(stats).toMatchObject({
      totals: {
        totalOrders: 20,
        pendingOrders: 4,
        completedTotal: 9,
        completedToday: 2,
        completedThisWeek: 5,
        failedOrders: 1,
        cancelledOrders: 1,
        expiredOrders: 0,
        totalCodes: 30,
        unusedCodes: 12,
      },
      queue: {
        waitingCount: 8,
        delayedCount: 1,
        activeCount: 2,
        failedCount: 3,
        oldestWaitingSeconds: 420,
        averageGenerationSeconds: 180,
        successRateLastHour: 75,
      },
      proxyHealth: {
        chatGpt: { total: 3, healthy: 2, coolingDown: 1 },
        stripe: { total: 4, healthy: 4, coolingDown: 0 },
      },
    });
    expect(stats).not.toHaveProperty('workerPerformance');
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.order.count).toHaveBeenNthCalledWith(3, {
      where: { status: 'PAYMENT_COMPLETED' },
    });
    expect(prisma.order.count).toHaveBeenNthCalledWith(4, {
      where: {
        status: 'PAYMENT_COMPLETED',
        completedAt: {
          gte: new Date('2026-06-02T16:00:00.000Z'),
          lt: new Date('2026-06-03T16:00:00.000Z'),
        },
      },
    });
    expect(prisma.order.count).toHaveBeenNthCalledWith(5, {
      where: {
        status: 'PAYMENT_COMPLETED',
        completedAt: {
          gte: new Date('2026-05-31T16:00:00.000Z'),
          lt: new Date('2026-06-07T16:00:00.000Z'),
        },
      },
    });
  });
});
