import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  redemptionCode: {
    count: vi.fn(),
    delete: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
};

vi.mock('../db.ts', () => ({ prisma }));

const {
  archiveCode,
  archiveUsedCodes,
  deleteCode,
  listCodeBatches,
  listCodes,
} = await import('./redemption-code.service.ts');

describe('redemption-code.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.redemptionCode.count.mockResolvedValue(0);
    prisma.redemptionCode.findMany.mockResolvedValue([]);
  });

  it('lists active codes with status, batch and search filters', async () => {
    await listCodes({
      status: 'used',
      batchLabel: 'batch-001',
      search: 'ABCD',
      archiveScope: 'active',
      page: 2,
      limit: 20,
    });

    expect(prisma.redemptionCode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          usedAt: { not: null },
          batchLabel: 'batch-001',
          archivedAt: null,
          OR: [
            { code: { contains: 'ABCD', mode: 'insensitive' } },
            { batchLabel: { contains: 'ABCD', mode: 'insensitive' } },
          ],
        },
        skip: 20,
        take: 20,
      }),
    );
    expect(prisma.redemptionCode.count).toHaveBeenCalledWith({
      where: {
        usedAt: { not: null },
        batchLabel: 'batch-001',
        archivedAt: null,
        OR: [
          { code: { contains: 'ABCD', mode: 'insensitive' } },
          { batchLabel: { contains: 'ABCD', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('archives used codes instead of hard deleting them', async () => {
    prisma.redemptionCode.findUnique.mockResolvedValue({
      id: 'code-1',
      usedAt: new Date('2026-06-01T00:00:00.000Z'),
      archivedAt: null,
    });
    prisma.redemptionCode.update.mockResolvedValue({ id: 'code-1' });

    await archiveCode('code-1');

    expect(prisma.redemptionCode.delete).not.toHaveBeenCalled();
    expect(prisma.redemptionCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { archivedAt: expect.any(Date) },
    });
  });

  it('keeps unused codes as hard-delete only and rejects archive', async () => {
    prisma.redemptionCode.findUnique.mockResolvedValue({
      id: 'code-1',
      usedAt: null,
      archivedAt: null,
    });

    await expect(archiveCode('code-1')).rejects.toMatchObject({
      statusCode: 409,
    });
    await deleteCode('code-1');

    expect(prisma.redemptionCode.delete).toHaveBeenCalledWith({ where: { id: 'code-1' } });
  });

  it('archives only used active codes matching current filters', async () => {
    prisma.redemptionCode.updateMany.mockResolvedValue({ count: 3 });

    await expect(
      archiveUsedCodes({
        status: 'all',
        batchLabel: 'batch-001',
        search: 'ABCD',
        archiveScope: 'active',
      }),
    ).resolves.toEqual({ archivedCount: 3 });

    expect(prisma.redemptionCode.updateMany).toHaveBeenCalledWith({
      where: {
        usedAt: { not: null },
        batchLabel: 'batch-001',
        archivedAt: null,
        OR: [
          { code: { contains: 'ABCD', mode: 'insensitive' } },
          { batchLabel: { contains: 'ABCD', mode: 'insensitive' } },
        ],
      },
      data: { archivedAt: expect.any(Date) },
    });
  });

  it('returns batch options with used and unused counts', async () => {
    prisma.redemptionCode.findMany.mockResolvedValue([
      { batchLabel: 'batch-001', usedAt: null, archivedAt: null },
      { batchLabel: 'batch-001', usedAt: new Date('2026-06-01T00:00:00.000Z'), archivedAt: null },
      { batchLabel: 'batch-002', usedAt: null, archivedAt: null },
      { batchLabel: null, usedAt: null, archivedAt: null },
    ]);

    await expect(listCodeBatches()).resolves.toEqual([
      { batchLabel: 'batch-001', total: 2, used: 1, unused: 1 },
      { batchLabel: 'batch-002', total: 1, used: 0, unused: 1 },
    ]);
  });
});

