import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const prisma = {
  $transaction: vi.fn(),
  order: {
    count: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  user: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn(),
  },
}));

const {
  archiveWorkerAccount,
  listWorkerAccountsForManagement,
  updateWorkerAccount,
} = await import('./worker.service.ts');

describe('worker.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback: (client: typeof prisma) => Promise<unknown>) => callback(prisma));
    prisma.order.count.mockResolvedValue(0);
    prisma.order.findFirst.mockResolvedValue(null);
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
  });

  it('lists non-deleted workers with per-worker completed order counts', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'worker-1',
        username: 'worker',
        displayName: '工人',
        enabled: true,
        deletedAt: null,
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

    const workers = await listWorkerAccountsForManagement();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { role: 'WORKER', deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(workers).toEqual([
      {
        id: 'worker-1',
        username: 'worker',
        displayName: '工人',
        enabled: true,
        deletedAt: null,
        completedTotal: 7,
        completedToday: 2,
        completedThisWeek: 4,
        claimedCount: 1,
        lastCompletedAt: '2026-06-03T01:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ]);
    expect(prisma.order.count).toHaveBeenNthCalledWith(4, {
      where: {
        status: 'PENDING_PAYMENT',
        paymentHandler: 'LOCAL_WORKER',
        claimedById: 'worker-1',
        claimExpiresAt: { gt: expect.any(Date) },
      },
    });
  });

  it('keeps disabled workers visible but clears their active claimed count', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'worker-disabled',
        username: 'disabled-worker',
        displayName: '禁用工人',
        enabled: false,
        deletedAt: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ]);
    prisma.order.count
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);

    const workers = await listWorkerAccountsForManagement();

    expect(prisma.order.count).toHaveBeenCalledTimes(3);
    expect(workers).toEqual([
      expect.objectContaining({
        id: 'worker-disabled',
        enabled: false,
        completedTotal: 5,
        completedToday: 1,
        completedThisWeek: 3,
        claimedCount: 0,
      }),
    ]);
  });

  it('disables a worker and releases active claimed orders without clearing completed ownership', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'worker-1',
      role: 'WORKER',
      enabled: true,
      deletedAt: null,
    });
    prisma.user.update.mockResolvedValue({
      id: 'worker-1',
      username: 'worker',
      displayName: '工人',
      enabled: false,
      deletedAt: null,
    });

    await expect(updateWorkerAccount('worker-1', { enabled: false })).resolves.toEqual({
      id: 'worker-1',
      username: 'worker',
      displayName: '工人',
      enabled: false,
      deletedAt: null,
    });

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        status: 'PENDING_PAYMENT',
        paymentHandler: 'LOCAL_WORKER',
        claimedById: 'worker-1',
        claimExpiresAt: { gt: expect.any(Date) },
      },
      data: {
        claimedById: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'worker-1' },
      data: { enabled: false },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('archives a worker account and keeps historical completed ownership untouched', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'worker-1',
      role: 'WORKER',
      enabled: true,
      deletedAt: null,
    });
    prisma.user.update.mockResolvedValue({
      id: 'worker-1',
      username: 'worker',
      displayName: '工人',
      enabled: false,
      deletedAt: new Date('2026-06-03T05:00:00.000Z'),
    });

    await expect(archiveWorkerAccount('worker-1')).resolves.toEqual({
      id: 'worker-1',
      username: 'worker',
      displayName: '工人',
      enabled: false,
      deletedAt: '2026-06-03T05:00:00.000Z',
    });

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        status: 'PENDING_PAYMENT',
        paymentHandler: 'LOCAL_WORKER',
        claimedById: 'worker-1',
        claimExpiresAt: { gt: expect.any(Date) },
      },
      data: {
        claimedById: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'worker-1' },
      data: { enabled: false, deletedAt: expect.any(Date) },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('migration releases active claims held by already disabled workers', () => {
    const migrationSql = readFileSync(
      new URL('../../prisma/migrations/20260603140000_add_worker_soft_delete/migration.sql', import.meta.url),
      'utf8',
    );

    expect(migrationSql).toContain('UPDATE "orders"');
    expect(migrationSql).toContain('"claimed_by_id" = NULL');
    expect(migrationSql).toContain('"status" = \'PENDING_PAYMENT\'');
    expect(migrationSql).toContain('"enabled" = false');
  });
});
