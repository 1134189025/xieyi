import { customAlphabet } from 'nanoid';
import { prisma } from '../db.ts';
import { AppError } from '../middleware/error-handler.ts';

const generateCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 8);

function formatCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export async function batchCreateCodes(count: number, createdById: string, batchLabel?: string) {
  const codes: { code: string }[] = [];
  const existingCodes = new Set(
    (await prisma.redemptionCode.findMany({ select: { code: true } })).map((c) => c.code),
  );

  for (let i = 0; i < count; i++) {
    let code: string;
    do {
      code = formatCode(generateCode());
    } while (existingCodes.has(code));
    existingCodes.add(code);
    codes.push({ code });
  }

  const created = await prisma.$transaction(
    codes.map((c) =>
      prisma.redemptionCode.create({
        data: { code: c.code, createdById, batchLabel },
      }),
    ),
  );

  return created.map((c) => ({
    id: c.id,
    code: c.code,
    createdAt: c.createdAt.toISOString(),
  }));
}

export async function listCodes(filters: {
  status?: 'unused' | 'used' | 'all';
  batchLabel?: string;
  page: number;
  limit: number;
}) {
  const where: Record<string, unknown> = {};
  if (filters.status === 'unused') where.usedAt = null;
  else if (filters.status === 'used') where.usedAt = { not: null };
  if (filters.batchLabel) where.batchLabel = filters.batchLabel;

  const [codes, total] = await Promise.all([
    prisma.redemptionCode.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      include: { order: { select: { id: true, trackingToken: true, status: true } } },
    }),
    prisma.redemptionCode.count({ where }),
  ]);

  return {
    codes: codes.map((c) => ({
      id: c.id,
      code: c.code,
      batchLabel: c.batchLabel,
      usedAt: c.usedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      order: c.order
        ? { id: c.order.id, trackingToken: c.order.trackingToken, status: c.order.status }
        : null,
    })),
    total,
    page: filters.page,
    limit: filters.limit,
  };
}

export async function deleteCode(codeId: string) {
  const code = await prisma.redemptionCode.findUnique({ where: { id: codeId } });
  if (!code) throw new AppError(404, 'Code not found');
  if (code.usedAt) throw new AppError(409, 'Cannot delete a used code');

  await prisma.redemptionCode.delete({ where: { id: codeId } });
}
