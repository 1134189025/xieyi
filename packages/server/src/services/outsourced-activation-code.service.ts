import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.ts';
import { AppError } from '../middleware/error-handler.ts';
import { decrypt, encrypt } from '../utils/crypto.ts';
import { redactOutsourcedSensitiveText, type OutsourcedSensitiveContext } from '../utils/outsourced-redaction.ts';

const DEFAULT_TIMEOUT_MS = 5_000;
const REFRESH_LIMIT = 50;
const SELECT_LIMIT = 10;
const REFRESH_CONCURRENCY = 5;

export type OutsourcedActivationCodeStatus = 'AVAILABLE' | 'EXHAUSTED' | 'CHECK_FAILED' | 'UNKNOWN';
export type OutsourcedActivationCodeStatusFilter = 'all' | 'available' | 'exhausted' | 'error' | 'unknown';
export type OutsourcedActivationCodeArchiveScope = 'active' | 'archived' | 'all';

export interface ListOutsourcedActivationCodeFilters {
  status?: OutsourcedActivationCodeStatusFilter;
  batchLabel?: string;
  search?: string;
  archiveScope?: OutsourcedActivationCodeArchiveScope;
  page: number;
  limit: number;
}

export interface RefreshOutsourcedActivationCodeFilters {
  status?: OutsourcedActivationCodeStatusFilter;
  batchLabel?: string;
  search?: string;
  archiveScope?: OutsourcedActivationCodeArchiveScope;
}

export interface SelectedOutsourcedActivationCode {
  id: string;
  code: string;
  maskedCode: string;
}

interface ReservedOutsourcedActivationCodeRow {
  id: string;
  encryptedCode: string;
  maskedCode: string;
}

interface BuyerCodeInfoResult {
  ok: boolean;
  remaining: number | null;
  total: number | null;
  used: number | null;
  message: string | null;
}

export async function importOutsourcedActivationCodes(input: {
  codesText: string;
  batchLabel?: string | null;
  createdById?: string | null;
}) {
  const batchLabel = normalizeOptionalText(input.batchLabel);
  const codes = normalizeActivationCodeLines(input.codesText);
  if (codes.length === 0) {
    return { importedCount: 0, duplicateCount: 0, totalInputCount: 0, batchLabel: batchLabel ?? null };
  }

  const hashes = codes.map(codeHash);
  const existing = await prisma.outsourcedActivationCode.findMany({
    where: { codeHash: { in: hashes } },
    select: { codeHash: true },
  });
  const existingHashes = new Set(existing.map((row) => row.codeHash));
  const toCreate = codes
    .map((code) => ({ code, hash: codeHash(code) }))
    .filter(({ hash }) => !existingHashes.has(hash));

  let importedCount = 0;
  if (toCreate.length > 0) {
    const created = await prisma.outsourcedActivationCode.createMany({
      data: toCreate.map(({ code, hash }) => ({
        codeHash: hash,
        encryptedCode: encrypt(code),
        maskedCode: maskActivationCode(code),
        batchLabel,
        createdById: input.createdById ?? null,
      })),
      skipDuplicates: true,
    });
    importedCount = created.count;
  }

  return {
    importedCount,
    duplicateCount: codes.length - importedCount,
    totalInputCount: codes.length,
    batchLabel: batchLabel ?? null,
  };
}

export async function listOutsourcedActivationCodes(filters: ListOutsourcedActivationCodeFilters) {
  const where = buildCodeWhere(filters);
  const summaryWhere = buildCodeWhere({ ...filters, status: 'all' });

  const [codes, total, summary] = await Promise.all([
    prisma.outsourcedActivationCode.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      include: { _count: { select: { orders: true } } },
    }),
    prisma.outsourcedActivationCode.count({ where }),
    buildSummary(summaryWhere),
  ]);

  return {
    codes: codes.map((code) => ({
      id: code.id,
      maskedCode: code.maskedCode,
      batchLabel: code.batchLabel,
      status: outsourcedActivationCodeStatus(code),
      lastRemaining: code.lastRemaining,
      lastUsed: code.lastUsed,
      lastTotal: code.lastTotal,
      localSubmitCount: code.localSubmitCount,
      lastCheckedAt: code.lastCheckedAt?.toISOString() ?? null,
      lastError: code.lastError,
      exhaustedAt: code.exhaustedAt?.toISOString() ?? null,
      archivedAt: code.archivedAt?.toISOString() ?? null,
      createdAt: code.createdAt.toISOString(),
      orderCount: code._count.orders,
    })),
    summary,
    total,
    page: filters.page,
    limit: filters.limit,
  };
}

export async function listOutsourcedActivationCodeBatches() {
  const codes = await prisma.outsourcedActivationCode.findMany({
    where: { archivedAt: null },
    select: { batchLabel: true, lastRemaining: true, lastError: true, exhaustedAt: true },
  });
  const batchCounts = new Map<string, {
    batchLabel: string;
    total: number;
    available: number;
    exhausted: number;
    checkFailed: number;
    unknown: number;
    totalRemaining: number;
  }>();

  for (const code of codes) {
    const batchLabel = normalizeOptionalText(code.batchLabel);
    if (!batchLabel) continue;
    const current = batchCounts.get(batchLabel) ?? {
      batchLabel,
      total: 0,
      available: 0,
      exhausted: 0,
      checkFailed: 0,
      unknown: 0,
      totalRemaining: 0,
    };
    current.total += 1;
    current.totalRemaining += code.lastRemaining ?? 0;
    const status = outsourcedActivationCodeStatus(code);
    if (status === 'AVAILABLE') current.available += 1;
    else if (status === 'EXHAUSTED') current.exhausted += 1;
    else if (status === 'CHECK_FAILED') current.checkFailed += 1;
    else current.unknown += 1;
    batchCounts.set(batchLabel, current);
  }

  return Array.from(batchCounts.values()).sort((first, second) =>
    first.batchLabel.localeCompare(second.batchLabel),
  );
}

export async function refreshOutsourcedActivationCodeStatuses(input: {
  baseUrl: string;
  filters: RefreshOutsourcedActivationCodeFilters;
}) {
  const where = buildCodeWhere({ ...input.filters, archiveScope: input.filters.archiveScope ?? 'active' });
  const codes = await prisma.outsourcedActivationCode.findMany({
    where,
    orderBy: [{ lastCheckedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: REFRESH_LIMIT,
  });

  let checked = 0;
  let available = 0;
  let exhausted = 0;
  let failed = 0;

  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, codes.length) }, async () => {
    while (nextIndex < codes.length) {
      const code = codes[nextIndex++];
      const result = await refreshOutsourcedActivationCodeRecord(input.baseUrl, code);
      checked += 1;
      if (result === 'AVAILABLE') available += 1;
      else if (result === 'EXHAUSTED') exhausted += 1;
      else if (result === 'CHECK_FAILED') failed += 1;
    }
  }));

  return { checked, available, exhausted, failed };
}

export async function refreshOutsourcedActivationCodeById(id: string, baseUrl: string) {
  const code = await prisma.outsourcedActivationCode.findUnique({ where: { id } });
  if (!code) throw new AppError(404, 'Outsourced activation code not found');
  const status = await refreshOutsourcedActivationCodeRecord(baseUrl, code);
  return { id, status };
}

export async function deleteOutsourcedActivationCode(id: string) {
  const code = await prisma.outsourcedActivationCode.findUnique({
    where: { id },
    include: { _count: { select: { orders: true } } },
  });
  if (!code) throw new AppError(404, 'Outsourced activation code not found');
  if (code.localSubmitCount > 0 || code._count.orders > 0) {
    throw new AppError(409, 'Cannot delete an outsourced activation code that has been used');
  }

  await prisma.outsourcedActivationCode.delete({ where: { id } });
}

export async function archiveOutsourcedActivationCode(id: string) {
  const code = await prisma.outsourcedActivationCode.findUnique({ where: { id } });
  if (!code) throw new AppError(404, 'Outsourced activation code not found');
  if (code.archivedAt) return { id, archived: true };

  await prisma.outsourcedActivationCode.update({
    where: { id },
    data: { archivedAt: new Date() },
  });
  return { id, archived: true };
}

export async function archiveOutsourcedActivationCodes(filters: RefreshOutsourcedActivationCodeFilters) {
  const where = andWhere(
    buildCodeWhere(filters),
    { archivedAt: null },
  );
  const archived = await prisma.outsourcedActivationCode.updateMany({
    where,
    data: { archivedAt: new Date() },
  });
  return { archivedCount: archived.count };
}

export async function deleteUnusedOutsourcedActivationCodes(filters: RefreshOutsourcedActivationCodeFilters) {
  const where = andWhere(
    buildCodeWhere(filters),
    {
      localSubmitCount: 0,
      orders: { none: {} },
    } as Prisma.OutsourcedActivationCodeWhereInput,
  );
  const deleted = await prisma.outsourcedActivationCode.deleteMany({ where });
  return { deletedCount: deleted.count };
}

export async function findReservedOutsourcedActivationCodeForOrder(
  orderId: string,
): Promise<SelectedOutsourcedActivationCode | null> {
  const [reservedCode] = await prisma.$queryRaw<ReservedOutsourcedActivationCodeRow[]>`
    SELECT
      "outsourced_activation_codes"."id" AS "id",
      "outsourced_activation_codes"."encrypted_code" AS "encryptedCode",
      "outsourced_activation_codes"."masked_code" AS "maskedCode"
    FROM "orders"
    INNER JOIN "outsourced_activation_codes"
      ON "outsourced_activation_codes"."id" = "orders"."outsourced_activation_code_id"
    WHERE "orders"."id" = ${orderId}
      AND "orders"."status" = 'CREATING_PAYMENT'::"OrderStatus"
      AND "orders"."outsourced_ticket_id" IS NULL
      AND "outsourced_activation_codes"."archived_at" IS NULL
    LIMIT 1
  `;
  if (!reservedCode) return null;

  return {
    id: reservedCode.id,
    code: decrypt(reservedCode.encryptedCode),
    maskedCode: reservedCode.maskedCode,
  };
}

export async function reserveOutsourcedActivationCodeForOrder(input: { codeId: string; orderId: string }) {
  const [reservedOrder] = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH target_code AS (
      SELECT "id"
      FROM "outsourced_activation_codes"
      WHERE "id" = ${input.codeId}
        AND "archived_at" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "orders"
          WHERE "outsourced_activation_code_id" = ${input.codeId}
            AND "status" = 'CREATING_PAYMENT'::"OrderStatus"
            AND "outsourced_ticket_id" IS NULL
        )
      FOR UPDATE SKIP LOCKED
    ),
    reserved_order AS (
      UPDATE "orders"
      SET
        "outsourced_activation_code_id" = target_code."id",
        "updated_at" = NOW()
      FROM target_code
      WHERE "orders"."id" = ${input.orderId}
        AND "orders"."status" = 'CREATING_PAYMENT'::"OrderStatus"
        AND "orders"."outsourced_activation_code_id" IS NULL
      RETURNING "orders"."id"
    )
    SELECT "id" FROM reserved_order
  `;
  return Boolean(reservedOrder);
}

export async function releaseOutsourcedActivationCodeReservation(input: { codeId: string; orderId: string }) {
  await prisma.order.updateMany({
    where: {
      id: input.orderId,
      outsourcedActivationCodeId: input.codeId,
      outsourcedTicketId: null,
    } as never,
    data: { outsourcedActivationCodeId: null } as never,
  });
}

export async function selectAvailableOutsourcedActivationCode(baseUrl: string): Promise<SelectedOutsourcedActivationCode> {
  const candidates = await prisma.outsourcedActivationCode.findMany({
    where: {
      archivedAt: null,
      orders: {
        none: {
          status: 'CREATING_PAYMENT',
          outsourcedTicketId: null,
        },
      },
      OR: [
        { exhaustedAt: null },
        { lastRemaining: { gt: 0 } },
      ],
    } as never,
    orderBy: [{ lastCheckedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: SELECT_LIMIT,
  });
  if (candidates.length === 0) {
    throw new AppError(503, 'No outsourced activation code configured', 'OUTSOURCED_CODE_UNAVAILABLE');
  }

  for (const candidate of candidates) {
    const status = await refreshOutsourcedActivationCodeRecord(baseUrl, candidate);
    if (status === 'AVAILABLE') {
      return {
        id: candidate.id,
        code: decrypt(candidate.encryptedCode),
        maskedCode: candidate.maskedCode,
      };
    }
  }

  throw new AppError(503, 'No outsourced activation code has remaining quota', 'OUTSOURCED_CODE_UNAVAILABLE');
}

export async function recordOutsourcedActivationCodeSubmit(id: string) {
  await prisma.outsourcedActivationCode.update({
    where: { id },
    data: { localSubmitCount: { increment: 1 } },
  });
}

export async function getOutsourcedActivationCodeSettingSummary() {
  const codes = await prisma.outsourcedActivationCode.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { maskedCode: true },
  });
  const count = await prisma.outsourcedActivationCode.count({ where: { archivedAt: null } });
  return {
    count,
    preview: codes.map((code) => code.maskedCode),
  };
}

async function buildSummary(where: Prisma.OutsourcedActivationCodeWhereInput) {
  const [total, available, exhausted, checkFailed, unknown, aggregate] = await Promise.all([
    prisma.outsourcedActivationCode.count({ where }),
    prisma.outsourcedActivationCode.count({ where: andWhere(where, availableWhere()) }),
    prisma.outsourcedActivationCode.count({ where: andWhere(where, exhaustedWhere()) }),
    prisma.outsourcedActivationCode.count({ where: andWhere(where, { lastError: { not: null } }) }),
    prisma.outsourcedActivationCode.count({ where: andWhere(where, unknownWhere()) }),
    prisma.outsourcedActivationCode.aggregate({
      where,
      _sum: { lastRemaining: true, lastUsed: true, localSubmitCount: true },
    }),
  ]);

  return {
    total,
    available,
    exhausted,
    unknown,
    checkFailed,
    totalRemaining: aggregate._sum.lastRemaining ?? 0,
    totalUsed: aggregate._sum.lastUsed ?? null,
    localSubmitCount: aggregate._sum.localSubmitCount ?? 0,
  };
}

async function refreshOutsourcedActivationCodeRecord(
  baseUrl: string,
  code: {
    id: string;
    encryptedCode: string;
  },
): Promise<OutsourcedActivationCodeStatus> {
  const checkedAt = new Date();
  let plainCode: string | null = null;
  try {
    plainCode = decrypt(code.encryptedCode);
    const info = await fetchBuyerCodeInfo(baseUrl, plainCode);
    if (!info.ok) {
      await prisma.outsourcedActivationCode.update({
        where: { id: code.id },
        data: {
          lastCheckedAt: checkedAt,
          lastError: redactOutsourcedSensitiveText(info.message ?? 'code_info_failed', { activationCode: plainCode }),
        },
      });
      return 'CHECK_FAILED';
    }

    const remaining = info.remaining;
    await prisma.outsourcedActivationCode.update({
      where: { id: code.id },
      data: {
        lastRemaining: remaining,
        lastTotal: info.total,
        lastUsed: info.used,
        lastCheckedAt: checkedAt,
        lastError: null,
        exhaustedAt: typeof remaining === 'number' && remaining <= 0 ? checkedAt : null,
      },
    });
    if (typeof remaining === 'number' && remaining <= 0) return 'EXHAUSTED';
    if (typeof remaining === 'number' && remaining > 0) return 'AVAILABLE';
    return 'UNKNOWN';
  } catch (error) {
    await prisma.outsourcedActivationCode.update({
      where: { id: code.id },
      data: {
        lastCheckedAt: checkedAt,
        lastError: redactOutsourcedSensitiveText(
          error instanceof Error ? error.message : String(error),
          { activationCode: plainCode },
        ),
      },
    });
    return 'CHECK_FAILED';
  }
}

async function fetchBuyerCodeInfo(baseUrl: string, code: string): Promise<BuyerCodeInfoResult> {
  const response = await fetchJson(joinBuyerUrl(baseUrl, '/buyer/api/code-info'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }, { activationCode: code });

  return {
    ok: response.ok === true,
    remaining: numberField(response.remaining),
    total: numberField(response.total),
    used: numberField(response.used),
    message: stringField(response.message),
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  redactionContext: OutsourcedSensitiveContext,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`buyer_api_http_${response.status}:${redactOutsourcedSensitiveText(text, redactionContext)}`);
    }
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } finally {
    clearTimeout(timer);
  }
}

function buildCodeWhere(filters: RefreshOutsourcedActivationCodeFilters): Prisma.OutsourcedActivationCodeWhereInput {
  const where: Prisma.OutsourcedActivationCodeWhereInput = {};
  const archiveScope = filters.archiveScope ?? 'active';
  const batchLabel = normalizeOptionalText(filters.batchLabel);
  const search = normalizeOptionalText(filters.search);

  if (archiveScope === 'active') where.archivedAt = null;
  else if (archiveScope === 'archived') where.archivedAt = { not: null };

  if (batchLabel) where.batchLabel = batchLabel;
  if (search) {
    where.OR = [
      { maskedCode: { contains: search, mode: 'insensitive' } },
      { batchLabel: { contains: search, mode: 'insensitive' } },
    ];
  }

  const status = filters.status ?? 'all';
  if (status === 'available') return andWhere(where, availableWhere());
  if (status === 'exhausted') return andWhere(where, exhaustedWhere());
  if (status === 'error') return andWhere(where, { lastError: { not: null } });
  if (status === 'unknown') return andWhere(where, unknownWhere());
  return where;
}

function availableWhere(): Prisma.OutsourcedActivationCodeWhereInput {
  return { lastRemaining: { gt: 0 }, lastError: null };
}

function exhaustedWhere(): Prisma.OutsourcedActivationCodeWhereInput {
  return { lastError: null, OR: [{ exhaustedAt: { not: null } }, { lastRemaining: { lte: 0 } }] };
}

function unknownWhere(): Prisma.OutsourcedActivationCodeWhereInput {
  return { lastCheckedAt: null, lastError: null, exhaustedAt: null, lastRemaining: null };
}

function andWhere(
  left: Prisma.OutsourcedActivationCodeWhereInput,
  right: Prisma.OutsourcedActivationCodeWhereInput,
): Prisma.OutsourcedActivationCodeWhereInput {
  if (Object.keys(left).length === 0) return right;
  return { AND: [left, right] };
}

function outsourcedActivationCodeStatus(code: {
  lastRemaining: number | null;
  lastError: string | null;
  exhaustedAt: Date | null;
}): OutsourcedActivationCodeStatus {
  if (code.lastError) return 'CHECK_FAILED';
  if (code.exhaustedAt || (typeof code.lastRemaining === 'number' && code.lastRemaining <= 0)) return 'EXHAUSTED';
  if (typeof code.lastRemaining === 'number' && code.lastRemaining > 0) return 'AVAILABLE';
  return 'UNKNOWN';
}

export function normalizeActivationCodeLines(value: string): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const code = line.trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

function codeHash(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

function maskActivationCode(code: string): string {
  if (code.length <= 6) return '****';
  return `${code.slice(0, 4)}...${code.slice(-3)}`;
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function joinBuyerUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberField(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
