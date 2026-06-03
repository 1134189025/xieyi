import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  $queryRaw: vi.fn(),
  order: {
    count: vi.fn(),
    findFirst: vi.fn(),
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
    prisma.order.findFirst.mockResolvedValue({ completedAt: new Date('2026-06-03T01:00:00.000Z') });
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'worker-1',
        username: 'worker',
        displayName: '工人',
        enabled: true,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ]);
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

  it('returns global completion counters, queue operations metrics, and per-worker performance', async () => {
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
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);

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
      workerPerformance: {
        totalWorkers: 1,
        enabledWorkers: 1,
        claimedOrders: 2,
        unclaimedPendingOrders: 1,
        assignedCompletedToday: 3,
        assignedCompletedThisWeek: 5,
        unassignedCompletedToday: 0,
        unassignedCompletedThisWeek: 1,
        topWorkers: [
          {
            id: 'worker-1',
            username: 'worker',
            displayName: '工人',
            enabled: true,
            completedToday: 1,
            completedThisWeek: 2,
            completedTotal: 5,
            claimedCount: 0,
          },
        ],
      },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { role: 'WORKER' },
      orderBy: { createdAt: 'desc' },
    });
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
