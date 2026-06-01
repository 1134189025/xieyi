import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
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
  });

  it('lists workers without per-worker completed order counts', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'worker-1',
        username: 'worker',
        displayName: '工人',
        enabled: true,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ]);

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
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ]);
    expect(workers[0]).not.toHaveProperty('completedOrderCount');
  });
});
