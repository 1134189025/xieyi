import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  order: {
    count: vi.fn(),
    findFirst: vi.fn(),
  },
  user: {
    findMany: vi.fn(),
  },
};

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn(),
  },
}));

const { listWorkers } = await import('./worker.service.ts');

describe('worker.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.order.count.mockResolvedValue(0);
    prisma.order.findFirst.mockResolvedValue(null);
  });

  it('lists workers with per-worker completed order counts', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'worker-1',
        username: 'worker',
        displayName: '工人',
        enabled: true,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ]);
    prisma.order.count
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1);
    prisma.order.findFirst.mockResolvedValue({
      completedAt: new Date('2026-06-03T01:00:00.000Z'),
    });

    const workers = await listWorkers();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { role: 'WORKER' },
      orderBy: { createdAt: 'desc' },
    });
    expect(workers).toEqual([
      {
        id: 'worker-1',
        username: 'worker',
        displayName: '工人',
        enabled: true,
        completedTotal: 7,
        completedToday: 2,
        completedThisWeek: 4,
        claimedCount: 1,
        lastCompletedAt: '2026-06-03T01:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ]);
  });
});
