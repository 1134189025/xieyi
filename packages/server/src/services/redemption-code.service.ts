import { customAlphabet } from 'nanoid';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.ts';
import { AppError } from '../middleware/error-handler.ts';

const generateCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 8);

function formatCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

type CodeStatusFilter = 'unused' | 'used' | 'all';
type ArchiveScopeFilter = 'active' | 'archived' | 'all';

interface ListCodeFilters {
  status?: CodeStatusFilter;
  batchLabel?: string;
  search?: string;
  archiveScope?: ArchiveScopeFilter;
  page: number;
  limit: number;
}

interface ArchiveUsedCodeFilters {
  status?: CodeStatusFilter;
  batchLabel?: string;
  search?: string;
  archiveScope?: ArchiveScopeFilter;
}

export async function batchCreateCodes(count: number, createdById: string, batchLabel?: string) {
  const normalizedBatchLabel = normalizeOptionalText(batchLabel);
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
        data: { code: c.code, createdById, batchLabel: normalizedBatchLabel },
      }),
    ),
  );

  return created.map((c) => ({
    id: c.id,
    code: c.code,
    batchLabel: c.batchLabel,
    createdAt: c.createdAt.toISOString(),
  }));
}

export async function listCodes(filters: ListCodeFilters) {
  const where = buildCodeWhere(filters);

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
      archivedAt: c.archivedAt?.toISOString() ?? null,
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

export async function archiveCode(codeId: string) {
  const code = await prisma.redemptionCode.findUnique({ where: { id: codeId } });
  if (!code) throw new AppError(404, 'Code not found');
  if (!code.usedAt) throw new AppError(409, 'Unused code should be deleted instead of archived');
  if (code.archivedAt) return { id: code.id, archived: true };

  await prisma.redemptionCode.update({
    where: { id: codeId },
    data: { archivedAt: new Date() },
  });
  return { id: code.id, archived: true };
}

export async function archiveUsedCodes(filters: ArchiveUsedCodeFilters) {
  const baseWhere = buildCodeWhere({ ...filters, status: 'used' });
  const where = filters.archiveScope === 'archived' || filters.archiveScope === 'all'
    ? andWhere(baseWhere, { archivedAt: null })
    : baseWhere;
  const archived = await prisma.redemptionCode.updateMany({
    where,
    data: { archivedAt: new Date() },
  });
  return { archivedCount: archived.count };
}

export async function deleteUnusedCodes(filters: ArchiveUsedCodeFilters) {
  const where = andWhere(
    buildCodeWhere(filters),
    { usedAt: null },
  );
  const deleted = await prisma.redemptionCode.deleteMany({ where });
  return { deletedCount: deleted.count };
}

export async function listCodeBatches() {
  const codes = await prisma.redemptionCode.findMany({
    where: { archivedAt: null },
    select: { batchLabel: true, usedAt: true, archivedAt: true },
  });
  const batchCounts = new Map<string, { batchLabel: string; total: number; used: number; unused: number }>();

  for (const code of codes) {
    const batchLabel = normalizeOptionalText(code.batchLabel);
    if (!batchLabel) continue;
    const current = batchCounts.get(batchLabel) ?? { batchLabel, total: 0, used: 0, unused: 0 };
    current.total += 1;
    if (code.usedAt) current.used += 1;
    else current.unused += 1;
    batchCounts.set(batchLabel, current);
  }

  return Array.from(batchCounts.values()).sort((first, second) =>
    first.batchLabel.localeCompare(second.batchLabel),
  );
}

function buildCodeWhere(filters: ArchiveUsedCodeFilters): Prisma.RedemptionCodeWhereInput {
  const where: Prisma.RedemptionCodeWhereInput = {};
  const status = filters.status ?? 'all';
  const archiveScope = filters.archiveScope ?? 'active';
  const batchLabel = normalizeOptionalText(filters.batchLabel);
  const search = normalizeOptionalText(filters.search);

  if (status === 'unused') where.usedAt = null;
  else if (status === 'used') where.usedAt = { not: null };

  if (archiveScope === 'active') where.archivedAt = null;
  else if (archiveScope === 'archived') where.archivedAt = { not: null };

  if (batchLabel) where.batchLabel = batchLabel;
  if (search) {
    where.OR = [
      { code: { contains: search, mode: 'insensitive' } },
      { batchLabel: { contains: search, mode: 'insensitive' } },
    ];
  }

  return where;
}

function andWhere(
  left: Prisma.RedemptionCodeWhereInput,
  right: Prisma.RedemptionCodeWhereInput,
): Prisma.RedemptionCodeWhereInput {
  if (Object.keys(left).length === 0) return right;
  return { AND: [left, right] };
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
