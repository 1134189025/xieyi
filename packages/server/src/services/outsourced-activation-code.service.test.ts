import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  $queryRaw: vi.fn(),
  outsourcedActivationCode: {
    aggregate: vi.fn(),
    count: vi.fn(),
    createMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
};

const encrypt = vi.fn((plaintext: string) => `encrypted:${plaintext}`);
const decrypt = vi.fn((ciphertext: string) => ciphertext.replace(/^encrypted:/, ''));

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('../utils/crypto.ts', () => ({ encrypt, decrypt }));

const {
  archiveOutsourcedActivationCodes,
  deleteUnusedOutsourcedActivationCodes,
  importOutsourcedActivationCodes,
  findReservedOutsourcedActivationCodeForOrder,
  listOutsourcedActivationCodes,
  reserveOutsourcedActivationCodeForOrder,
  refreshOutsourcedActivationCodeStatuses,
  selectAvailableOutsourcedActivationCode,
} = await import('./outsourced-activation-code.service.ts');

describe('outsourced-activation-code.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
    prisma.outsourcedActivationCode.aggregate.mockResolvedValue({
      _sum: { lastRemaining: 0, lastUsed: null, localSubmitCount: 0 },
    });
    prisma.outsourcedActivationCode.count.mockResolvedValue(0);
    prisma.outsourcedActivationCode.findMany.mockResolvedValue([]);
    prisma.outsourcedActivationCode.createMany.mockResolvedValue({ count: 0 });
    prisma.outsourcedActivationCode.deleteMany.mockResolvedValue({ count: 0 });
    prisma.outsourcedActivationCode.updateMany.mockResolvedValue({ count: 0 });
    prisma.$queryRaw.mockResolvedValue([]);
  });

  it('imports normalized unique codes with encrypted storage and masked display', async () => {
    prisma.outsourcedActivationCode.findMany.mockResolvedValueOnce([{ codeHash: hashCode('DP-FIRST-CODE') }]);
    prisma.outsourcedActivationCode.createMany.mockResolvedValue({ count: 1 });

    const result = await importOutsourcedActivationCodes({
      codesText: 'dp-first-code\nDP-FIRST-CODE\nDP-SECOND-CODE',
      batchLabel: 'batch-001',
      createdById: 'admin-1',
    });

    expect(result).toEqual({
      importedCount: 1,
      duplicateCount: 1,
      totalInputCount: 2,
      batchLabel: 'batch-001',
    });
    expect(encrypt).toHaveBeenCalledWith('DP-SECOND-CODE');
    expect(prisma.outsourcedActivationCode.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        encryptedCode: 'encrypted:DP-SECOND-CODE',
        maskedCode: 'DP-S...ODE',
        batchLabel: 'batch-001',
        createdById: 'admin-1',
      })],
      skipDuplicates: true,
    });
  });

  it('reports actual imported count when createMany skips a concurrent duplicate', async () => {
    prisma.outsourcedActivationCode.findMany.mockResolvedValueOnce([]);
    prisma.outsourcedActivationCode.createMany.mockResolvedValue({ count: 1 });

    await expect(importOutsourcedActivationCodes({
      codesText: 'DP-FIRST-CODE\nDP-SECOND-CODE',
      batchLabel: 'batch-001',
    })).resolves.toEqual({
      importedCount: 1,
      duplicateCount: 1,
      totalInputCount: 2,
      batchLabel: 'batch-001',
    });
  });

  it('lists codes with status and summary for current filters', async () => {
    prisma.outsourcedActivationCode.findMany.mockResolvedValueOnce([{
      id: 'code-1',
      maskedCode: 'DP-F...ODE',
      batchLabel: 'batch-001',
      lastRemaining: 2,
      lastUsed: 1,
      lastTotal: 3,
      localSubmitCount: 1,
      lastCheckedAt: new Date('2026-06-01T00:00:00.000Z'),
      lastError: null,
      exhaustedAt: null,
      archivedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      _count: { orders: 1 },
    }]);
    prisma.outsourcedActivationCode.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    prisma.outsourcedActivationCode.aggregate.mockResolvedValueOnce({
      _sum: { lastRemaining: 2, lastUsed: 1, localSubmitCount: 1 },
    });

    await expect(listOutsourcedActivationCodes({
      status: 'available',
      archiveScope: 'active',
      batchLabel: 'batch-001',
      search: 'DP-F',
      page: 1,
      limit: 20,
    })).resolves.toMatchObject({
      codes: [{ id: 'code-1', status: 'AVAILABLE', lastRemaining: 2, orderCount: 1 }],
      summary: { total: 1, totalRemaining: 2, localSubmitCount: 1 },
      total: 1,
    });

    expect(prisma.outsourcedActivationCode.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 0,
      take: 20,
      include: { _count: { select: { orders: true } } },
    }));
  });

  it('refreshes remote status and records remaining quota', async () => {
    prisma.outsourcedActivationCode.findMany.mockResolvedValueOnce([
      { id: 'code-1', encryptedCode: 'encrypted:DP-FIRST-CODE' },
    ]);
    prisma.outsourcedActivationCode.update.mockResolvedValue({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({
      ok: true,
      remaining: 2,
      total: 3,
      used: 1,
    }));

    await expect(refreshOutsourcedActivationCodeStatuses({
      baseUrl: 'https://scan.amazo.indevs.in',
      filters: { status: 'all', archiveScope: 'active' },
    })).resolves.toEqual({ checked: 1, available: 1, exhausted: 0, failed: 0 });

    expect(fetch).toHaveBeenCalledWith(
      'https://scan.amazo.indevs.in/buyer/api/code-info',
      expect.objectContaining({ body: JSON.stringify({ code: 'DP-FIRST-CODE' }) }),
    );
    expect(prisma.outsourcedActivationCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: expect.objectContaining({ lastRemaining: 2, lastTotal: 3, lastUsed: 1, lastError: null }),
    });
  });

  it('redacts activation code from failed remote code-info messages', async () => {
    prisma.outsourcedActivationCode.findMany.mockResolvedValueOnce([
      { id: 'code-1', encryptedCode: 'encrypted:DP-FIRST-CODE' },
    ]);
    prisma.outsourcedActivationCode.update.mockResolvedValue({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({
      ok: false,
      message: 'DP-FIRST-CODE 已失效',
    }));

    await expect(refreshOutsourcedActivationCodeStatuses({
      baseUrl: 'https://scan.amazo.indevs.in',
      filters: { status: 'all', archiveScope: 'active' },
    })).resolves.toEqual({ checked: 1, available: 0, exhausted: 0, failed: 1 });

    expect(prisma.outsourcedActivationCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: expect.objectContaining({
        lastError: '[redacted-activation-code] 已失效',
      }),
    });
  });

  it('redacts activation code from non-2xx remote code-info responses', async () => {
    prisma.outsourcedActivationCode.findMany.mockResolvedValueOnce([
      { id: 'code-1', encryptedCode: 'encrypted:DP-FIRST-CODE' },
    ]);
    prisma.outsourcedActivationCode.update.mockResolvedValue({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({
      message: 'buyer API echoed DP-FIRST-CODE',
    }, { ok: false, status: 502 }));

    await expect(refreshOutsourcedActivationCodeStatuses({
      baseUrl: 'https://scan.amazo.indevs.in',
      filters: { status: 'all', archiveScope: 'active' },
    })).resolves.toEqual({ checked: 1, available: 0, exhausted: 0, failed: 1 });

    const lastError = prisma.outsourcedActivationCode.update.mock.calls[0][0].data.lastError;
    expect(lastError).toContain('buyer_api_http_502');
    expect(lastError).toContain('[redacted-activation-code]');
    expect(lastError).not.toContain('DP-FIRST-CODE');
  });

  it('selects the first candidate with remaining quota and skips exhausted codes', async () => {
    prisma.outsourcedActivationCode.findMany.mockResolvedValueOnce([
      { id: 'code-1', encryptedCode: 'encrypted:DP-FIRST-CODE', maskedCode: 'DP-F...ODE' },
      { id: 'code-2', encryptedCode: 'encrypted:DP-SECOND-CODE', maskedCode: 'DP-S...ODE' },
    ]);
    prisma.outsourcedActivationCode.update.mockResolvedValue({});
    (fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(jsonResponse({ ok: true, remaining: 0, total: 1, used: 1 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, remaining: 2, total: 3, used: 1 }));

    await expect(selectAvailableOutsourcedActivationCode('https://scan.amazo.indevs.in')).resolves.toEqual({
      id: 'code-2',
      code: 'DP-SECOND-CODE',
      maskedCode: 'DP-S...ODE',
    });
  });

  it('finds and decrypts a reserved outsourced activation code for a creating order', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{
      id: 'code-1',
      encryptedCode: 'encrypted:DP-FIRST-CODE',
      maskedCode: 'DP-F...ODE',
    }]);

    await expect(findReservedOutsourcedActivationCodeForOrder('order-1')).resolves.toEqual({
      id: 'code-1',
      code: 'DP-FIRST-CODE',
      maskedCode: 'DP-F...ODE',
    });
  });

  it('reserves an outsourced activation code with a database lock', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);

    await expect(reserveOutsourcedActivationCodeForOrder({
      codeId: 'code-1',
      orderId: 'order-1',
    })).resolves.toBe(true);

    const rawSql = String(prisma.$queryRaw.mock.calls[0][0]);
    expect(rawSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(rawSql).toContain('outsourced_ticket_id');
  });

  it('archives outsourced activation codes by current filters without touching archived rows again', async () => {
    prisma.outsourcedActivationCode.updateMany.mockResolvedValueOnce({ count: 3 });

    await expect(archiveOutsourcedActivationCodes({
      status: 'available',
      archiveScope: 'all',
      batchLabel: 'batch-001',
      search: 'DP-F',
    })).resolves.toEqual({ archivedCount: 3 });

    expect(prisma.outsourcedActivationCode.updateMany).toHaveBeenCalledWith({
      where: {
        AND: [
          {
            AND: [
              expect.objectContaining({
                batchLabel: 'batch-001',
                OR: expect.arrayContaining([
                  expect.objectContaining({ maskedCode: expect.objectContaining({ contains: 'DP-F' }) }),
                ]),
              }),
              { lastRemaining: { gt: 0 }, lastError: null },
            ],
          },
          { archivedAt: null },
        ],
      },
      data: { archivedAt: expect.any(Date) },
    });
  });

  it('deletes only unused outsourced activation codes by current filters', async () => {
    prisma.outsourcedActivationCode.deleteMany.mockResolvedValueOnce({ count: 2 });

    await expect(deleteUnusedOutsourcedActivationCodes({
      status: 'all',
      archiveScope: 'active',
      batchLabel: 'batch-001',
      search: 'DP-F',
    })).resolves.toEqual({ deletedCount: 2 });

    expect(prisma.outsourcedActivationCode.deleteMany).toHaveBeenCalledWith({
      where: {
        AND: [
          expect.objectContaining({
            archivedAt: null,
            batchLabel: 'batch-001',
            OR: expect.arrayContaining([
              expect.objectContaining({ maskedCode: expect.objectContaining({ contains: 'DP-F' }) }),
            ]),
          }),
          {
            localSubmitCount: 0,
            orders: { none: {} },
          },
        ],
      },
    });
  });
});

function jsonResponse(payload: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
