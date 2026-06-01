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

vi.mock('../db.ts', () => ({ prisma }));

const { getDashboardStats } = await import('./dashboard.service.ts');

describe('dashboard.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.redemptionCode.count.mockResolvedValueOnce(30).mockResolvedValueOnce(12);
  });

  it('returns global completion counters without per-worker performance', async () => {
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
