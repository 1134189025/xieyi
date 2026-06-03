import { randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Order, Prisma } from '@prisma/client';
import { prisma } from '../db.ts';
import { AppError } from '../middleware/error-handler.ts';
import { encrypt } from '../utils/crypto.ts';
import { broadcastOrderStatusChange } from '../ws/index.ts';
import { getShanghaiDayRange, getShanghaiWeekRange } from '../utils/shanghai-time.ts';
import { getMaintenanceModeSetting } from './settings.service.ts';
import {
  enqueuePixGenerationJob,
  getPixGenerationQueueSnapshot,
  secondsPerGenerationEstimate,
} from '../queues/pix-generation.queue.ts';

const SAFE_PAYMENT_ERROR_MESSAGE = '支付创建失败，请稍后重试。';
const GENERATION_FAILURE_MESSAGES: Record<string, string> = {
  ACCOUNT_NOT_ELIGIBLE: '账号无资格，无法生成 Pix 支付，请更换账号后重新提交。',
  CHATGPT_SESSION_UNRECOGNIZED: 'accessToken 无法识别，请重新粘贴有效 accessToken。',
  CHATGPT_CHECKOUT_FAILED: 'ChatGPT 结算链接创建失败，请稍后重试或更换账号。',
  PAYMENT_FAILED: SAFE_PAYMENT_ERROR_MESSAGE,
};
const ORDER_CREATE_BUSY_MESSAGE = '订单创建繁忙，请稍后重试';
const ORDER_QUEUE_UNAVAILABLE_MESSAGE = '订单排队失败，请稍后重试';
const DEFAULT_QUEUE_SECONDS_PER_ORDER = 5 * 60;
const MIN_QUEUE_SECONDS_PER_ORDER = 60;
const MAX_QUEUE_SECONDS_PER_ORDER = 30 * 60;
const RECENT_COMPLETION_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RECENT_COMPLETION_SAMPLE_LIMIT = 20;
const MIN_RECENT_COMPLETION_SAMPLES = 3;
const CLAIM_LOCK_MS = 30 * 60 * 1000;
const MAX_DIAGNOSTIC_DETAIL_LENGTH = 1000;

export interface GenerationFailureDiagnostic {
  stage?: string | null;
  detail?: string | null;
  httpStatus?: number | null;
}

interface CreatingPaymentOrder {
  id: string;
  trackingToken: string;
  status: string;
  redemptionCodeId: string | null;
  pixCode: string | null;
  pixImageUrl: string | null;
  createdAt: Date;
  generationQueuedAt: Date | null;
}

type QueueCalculationSource = 'recent_completion_cadence' | 'default' | 'generation_queue';

interface QueueEstimate {
  ordersAhead: number;
  position: number;
  pendingTotal: number;
  estimatedQueueSeconds: number;
  secondsPerOrder: number;
  calculationSource: QueueCalculationSource;
  calculatedAt: string;
  currentGenerationCount?: number;
}

type OrderWithGeneration = Order & {
  generationQueuedAt?: Date | null;
  generationStartedAt?: Date | null;
  generationFinishedAt?: Date | null;
  generationErrorCode?: string | null;
  generationErrorStage?: string | null;
  generationErrorDetail?: string | null;
  generationErrorHttpStatus?: number | null;
  submittedRedemptionCode?: string | null;
  claimedById?: string | null;
  claimedAt?: Date | null;
  claimExpiresAt?: Date | null;
  completedById?: string | null;
};

type WorkerOrderRow = {
  id: string;
  trackingToken: string;
  status: string;
  pixCode: string | null;
  pixQrPng: Uint8Array | Buffer | null;
  pixExpiresAt: Date | null;
  pixImageUrl: string | null;
  createdAt: Date;
  claimedById: string | null;
  claimedAt: Date | null;
  claimExpiresAt: Date | null;
};

export async function createOrder(redemptionCode: string, session: string) {
  const maintenanceMode = await getMaintenanceModeSetting();
  if (maintenanceMode.enabled) {
    throw new AppError(503, '系统维护中，请稍后再提交', 'MAINTENANCE_MODE');
  }

  const order = await createCreatingPaymentOrder({
    redemptionCode,
    reservedAt: new Date(),
    trackingToken: nanoid(12),
    encryptedSession: encrypt(session),
  });

  try {
    await enqueuePixGenerationJob({ orderId: order.id });
    return buildPublicOrderView(toOrderLike(order));
  } catch (error) {
    console.error(`Pix generation enqueue failed order=${order.id} ${safeQueueEstimateLog(error)}`);
    await releaseCreatingPaymentOrder(order.id);
    throw new AppError(502, ORDER_QUEUE_UNAVAILABLE_MESSAGE, 'ORDER_QUEUE_UNAVAILABLE');
  }
}

async function createCreatingPaymentOrder(input: {
  redemptionCode: string;
  reservedAt: Date;
  trackingToken: string;
  encryptedSession: string;
}): Promise<CreatingPaymentOrder> {
  try {
    const orderId = randomUUID();
    const [order] = await prisma.$queryRaw<CreatingPaymentOrder[]>`
      WITH reserved AS (
        UPDATE "redemption_codes"
        SET "used_at" = ${input.reservedAt}
        WHERE "code" = ${input.redemptionCode} AND "used_at" IS NULL
        RETURNING "id"
      ),
      inserted AS (
        INSERT INTO "orders" (
          "id",
          "tracking_token",
          "status",
          "redemption_code_id",
          "encrypted_session_data",
          "generation_queued_at",
          "submitted_redemption_code",
          "created_at",
          "updated_at"
        )
        SELECT
          ${orderId},
          ${input.trackingToken},
          'CREATING_PAYMENT'::"OrderStatus",
          reserved."id",
          ${input.encryptedSession},
          ${input.reservedAt},
          ${input.redemptionCode},
          NOW(),
          NOW()
        FROM reserved
        RETURNING
          "id",
          "tracking_token",
          "status",
          "redemption_code_id",
          "pix_code",
          "pix_image_url",
          "created_at",
          "generation_queued_at"
      )
      SELECT
        "id",
        "tracking_token" AS "trackingToken",
        "status"::text AS "status",
        "redemption_code_id" AS "redemptionCodeId",
        "pix_code" AS "pixCode",
        "pix_image_url" AS "pixImageUrl",
        "created_at" AS "createdAt",
        "generation_queued_at" AS "generationQueuedAt"
      FROM inserted
    `;

    if (order) return order;

    const existingCode = await prisma.redemptionCode.findUnique({
      where: { code: input.redemptionCode },
      select: { id: true },
    });
    throw existingCode
      ? new AppError(400, 'Redemption code already used', 'CODE_USED')
      : new AppError(400, 'Invalid redemption code', 'INVALID_CODE');
  } catch (error) {
    throw toPublicOrderCreationError(error);
  }
}

async function releaseCreatingPaymentOrder(orderId: string) {
  await prisma.$executeRaw`
    WITH deleted AS (
      DELETE FROM "orders"
      WHERE "id" = ${orderId} AND "status" = 'CREATING_PAYMENT'
      RETURNING "redemption_code_id"
    )
    UPDATE "redemption_codes"
    SET "used_at" = NULL
    FROM deleted
    WHERE "redemption_codes"."id" = deleted."redemption_code_id"
  `;
}

export async function failCreatingPaymentOrder(
  orderId: string,
  errorCode: string,
  diagnostic: GenerationFailureDiagnostic = {},
) {
  const failedAt = new Date();
  const safeFailureMessage = customerFailureMessage(errorCode);
  const safeDiagnostic = sanitizeGenerationFailureDiagnostic(diagnostic);
  await prisma.$executeRaw`
    WITH target AS (
      SELECT "redemption_code_id"
      FROM "orders"
      WHERE "id" = ${orderId} AND "status" = 'CREATING_PAYMENT'
    ),
    failed AS (
      UPDATE "orders"
      SET
        "status" = 'FAILED',
        "generation_finished_at" = ${failedAt},
        "generation_error_code" = ${errorCode},
        "generation_error_stage" = ${safeDiagnostic.stage},
        "generation_error_detail" = ${safeDiagnostic.detail},
        "generation_error_http_status" = ${safeDiagnostic.httpStatus},
        "error_message" = ${safeFailureMessage},
        "redemption_code_id" = NULL,
        "encrypted_session_data" = NULL,
        "updated_at" = NOW()
      FROM target
      WHERE "orders"."id" = ${orderId}
        AND "orders"."status" = 'CREATING_PAYMENT'
      RETURNING target."redemption_code_id"
    )
    UPDATE "redemption_codes"
    SET "used_at" = NULL
    FROM failed
    WHERE "redemption_codes"."id" = failed."redemption_code_id"
  `;

  const updatedOrder = await prisma.order.findUnique({ where: { id: orderId } });
  if (updatedOrder) broadcastOrderStatusChange(updatedOrder);
}

function sanitizeGenerationFailureDiagnostic(
  diagnostic: GenerationFailureDiagnostic,
): Required<GenerationFailureDiagnostic> {
  return {
    stage: sanitizeDiagnosticStage(diagnostic.stage),
    detail: sanitizeDiagnosticDetail(diagnostic.detail),
    httpStatus: typeof diagnostic.httpStatus === 'number' ? diagnostic.httpStatus : null,
  };
}

function sanitizeDiagnosticStage(value: string | null | undefined): string | null {
  if (!value) return null;
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return sanitized || null;
}

function sanitizeDiagnosticDetail(value: string | null | undefined): string | null {
  if (!value) return null;
  const sanitized = value
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/eyJ[^\s"'<>]+/g, '[redacted-token]')
    .replace(/seti_[A-Za-z0-9_]+_secret_[A-Za-z0-9_]+/g, '[redacted-client-secret]')
    .replace(/000201[A-Za-z0-9+/.=_-]{40,}/g, '[redacted-pix-code]')
    .replace(/:\/\/([^:@/\s]+):([^@/\s]+)@/g, '://****@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DIAGNOSTIC_DETAIL_LENGTH);
  return sanitized || null;
}

function toPublicOrderCreationError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (prismaErrorCode(error) === 'P2028') {
    return new AppError(409, ORDER_CREATE_BUSY_MESSAGE, 'ORDER_CREATE_BUSY');
  }
  if (isRedemptionCodeOrderUniqueConflict(error)) {
    return new AppError(400, 'Redemption code already used', 'CODE_USED');
  }
  return new AppError(502, SAFE_PAYMENT_ERROR_MESSAGE, 'PAYMENT_FAILED');
}

function isRedemptionCodeOrderUniqueConflict(error: unknown): boolean {
  const code = prismaErrorCode(error);
  if (code !== 'P2002' && code !== 'P2010') return false;

  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const rawMessage = (error as { meta?: { message?: unknown } }).meta?.message;
  const targetText = [
    Array.isArray(target) ? target.join(' ') : String(target ?? ''),
    typeof rawMessage === 'string' ? rawMessage : '',
  ].join(' ');
  return /redemptionCodeId|redemption_code_id/i.test(targetText);
}

function prismaErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export async function getOrderByTrackingToken(trackingToken: string) {
  const order = await prisma.order.findUnique({ where: { trackingToken } });
  if (!order) {
    throw new AppError(404, 'Order not found');
  }

  return buildPublicOrderView(order);
}

async function buildPublicOrderView(order: Order) {
  return {
    trackingToken: order.trackingToken,
    status: order.status,
    pixCode: order.pixCode,
    pixQrPngBase64: order.pixQrPng ? Buffer.from(order.pixQrPng).toString('base64') : null,
    pixExpiresAt: order.pixExpiresAt?.toISOString() ?? null,
    pixImageUrl: order.pixImageUrl,
    completedAt: order.completedAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    errorMessage: order.status === 'FAILED' ? customerFailureMessage((order as OrderWithGeneration).generationErrorCode) : null,
    queueEstimate: await safeCalculateQueueEstimate(order),
  };
}

function customerFailureMessage(errorCode: string | null | undefined): string {
  if (!errorCode) return SAFE_PAYMENT_ERROR_MESSAGE;
  return GENERATION_FAILURE_MESSAGES[errorCode] ?? SAFE_PAYMENT_ERROR_MESSAGE;
}

export async function getWorkerOrders(page: number, limit: number) {
  const now = new Date();
  const workerQueueWhere: Prisma.OrderWhereInput = {
    status: 'PENDING_PAYMENT',
    OR: [{ claimedById: null }, { claimExpiresAt: { lt: now } }],
  };
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where: workerQueueWhere,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.count({ where: workerQueueWhere }),
  ]);

  return {
    orders: orders.map(buildWorkerOrderView),
    total,
    page,
    limit,
  };
}

function buildWorkerOrderView(order: Order) {
  const claim = order as OrderWithGeneration;
  return {
    id: order.id,
    trackingToken: order.trackingToken,
    status: order.status,
    pixCode: order.pixCode,
    pixQrPngBase64: order.pixQrPng ? Buffer.from(order.pixQrPng).toString('base64') : null,
    pixExpiresAt: order.pixExpiresAt?.toISOString() ?? null,
    pixImageUrl: order.pixImageUrl,
    claimedById: claim.claimedById ?? null,
    claimedAt: claim.claimedAt?.toISOString() ?? null,
    claimExpiresAt: claim.claimExpiresAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
  };
}

function buildWorkerOrderRowView(order: WorkerOrderRow) {
  return {
    id: order.id,
    trackingToken: order.trackingToken,
    status: order.status,
    pixCode: order.pixCode,
    pixQrPngBase64: order.pixQrPng ? Buffer.from(order.pixQrPng).toString('base64') : null,
    pixExpiresAt: order.pixExpiresAt?.toISOString() ?? null,
    pixImageUrl: order.pixImageUrl,
    claimedById: order.claimedById,
    claimedAt: order.claimedAt?.toISOString() ?? null,
    claimExpiresAt: order.claimExpiresAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
  };
}

export async function claimNextPaymentOrder(workerId: string) {
  const claimedAt = new Date();
  const claimExpiresAt = new Date(claimedAt.getTime() + CLAIM_LOCK_MS);
  const [claimed] = await prisma.$queryRaw<WorkerOrderRow[]>`
    WITH candidate AS (
      SELECT "id"
      FROM "orders"
      WHERE "status" = 'PENDING_PAYMENT'
        AND ("claimed_by_id" IS NULL OR "claim_expires_at" < NOW())
      ORDER BY "created_at" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    ),
    claimed AS (
      UPDATE "orders"
      SET
        "claimed_by_id" = ${workerId},
        "claimed_at" = ${claimedAt},
        "claim_expires_at" = ${claimExpiresAt},
        "updated_at" = NOW()
      WHERE "id" IN (SELECT "id" FROM candidate)
      RETURNING
        "id",
        "tracking_token" AS "trackingToken",
        "status"::text AS "status",
        "pix_code" AS "pixCode",
        "pix_qr_png" AS "pixQrPng",
        "pix_expires_at" AS "pixExpiresAt",
        "pix_image_url" AS "pixImageUrl",
        "created_at" AS "createdAt",
        "claimed_by_id" AS "claimedById",
        "claimed_at" AS "claimedAt",
        "claim_expires_at" AS "claimExpiresAt"
    )
    SELECT * FROM claimed
  `;

  return claimed ? buildWorkerOrderRowView(claimed) : null;
}

export async function getWorkerClaimedOrders(workerId: string, page: number, limit: number) {
  const where: Prisma.OrderWhereInput = {
    status: 'PENDING_PAYMENT',
    claimedById: workerId,
    claimExpiresAt: { gt: new Date() },
  };
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [{ claimedAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders: orders.map(buildWorkerOrderView),
    total,
    page,
    limit,
  };
}

export async function renewClaimedPaymentOrder(orderId: string, workerId: string) {
  const now = new Date();
  const claimExpiresAt = new Date(now.getTime() + CLAIM_LOCK_MS);
  const changed = await prisma.order.updateMany({
    where: {
      id: orderId,
      status: 'PENDING_PAYMENT',
      claimedById: workerId,
      claimExpiresAt: { gt: now },
    },
    data: { claimExpiresAt },
  });
  if (changed.count === 0) throw new AppError(409, 'Order is not claimed by current worker');

  return { id: orderId, claimExpiresAt: claimExpiresAt.toISOString() };
}

export async function releaseClaimedPaymentOrder(orderId: string, workerId: string) {
  const changed = await prisma.order.updateMany({
    where: { id: orderId, status: 'PENDING_PAYMENT', claimedById: workerId },
    data: { claimedById: null, claimedAt: null, claimExpiresAt: null },
  });
  if (changed.count === 0) throw new AppError(409, 'Order is not claimed by current worker');

  return { id: orderId, released: true };
}

async function calculateQueueEstimate(order: Order): Promise<QueueEstimate | null> {
  if (order.status === 'CREATING_PAYMENT') {
    return calculateGenerationQueueEstimate(order);
  }
  if (order.status !== 'PENDING_PAYMENT') return null;

  const [ordersAhead, pendingTotal, cadence] = await Promise.all([
    prisma.order.count({
      where: {
        status: 'PENDING_PAYMENT',
        OR: [
          { createdAt: { lt: order.createdAt } },
          { createdAt: order.createdAt, id: { lt: order.id } },
        ],
      },
    }),
    prisma.order.count({ where: { status: 'PENDING_PAYMENT' } }),
    resolveQueueCadence(),
  ]);

  return {
    ordersAhead,
    position: ordersAhead + 1,
    pendingTotal: Math.max(pendingTotal, ordersAhead + 1),
    estimatedQueueSeconds: ordersAhead * cadence.secondsPerOrder,
    secondsPerOrder: cadence.secondsPerOrder,
    calculationSource: cadence.calculationSource,
    calculatedAt: new Date().toISOString(),
  };
}

async function calculateGenerationQueueEstimate(order: Order): Promise<QueueEstimate> {
  const snapshot = await getPixGenerationQueueSnapshot();
  const indexInQueue = snapshot.orderIdsInQueue.indexOf(order.id);
  const ordersAhead = indexInQueue >= 0
    ? indexInQueue
    : await countCreatingPaymentOrdersAhead(order);
  const secondsPerOrder = secondsPerGenerationEstimate();

  return {
    ordersAhead,
    position: ordersAhead + 1,
    pendingTotal: Math.max(snapshot.waitingCount + snapshot.delayedCount + snapshot.activeCount, ordersAhead + 1),
    currentGenerationCount: snapshot.activeCount,
    estimatedQueueSeconds: ordersAhead * secondsPerOrder,
    secondsPerOrder,
    calculationSource: 'generation_queue',
    calculatedAt: new Date().toISOString(),
  };
}

async function countCreatingPaymentOrdersAhead(order: Order): Promise<number> {
  return prisma.order.count({
    where: {
      status: 'CREATING_PAYMENT',
      OR: [
        { createdAt: { lt: order.createdAt } },
        { createdAt: order.createdAt, id: { lt: order.id } },
      ],
    },
  });
}

async function safeCalculateQueueEstimate(order: Order): Promise<QueueEstimate | null> {
  try {
    return await calculateQueueEstimate(order);
  } catch (error) {
    console.warn(`Queue estimate failed order=${order.id} ${safeQueueEstimateLog(error)}`);
    return null;
  }
}

async function resolveQueueCadence(): Promise<{
  secondsPerOrder: number;
  calculationSource: QueueCalculationSource;
}> {
  const recentCompletedOrders = await prisma.order.findMany({
    where: {
      status: 'PAYMENT_COMPLETED',
      completedAt: { gte: new Date(Date.now() - RECENT_COMPLETION_LOOKBACK_MS) },
    },
    orderBy: { completedAt: 'desc' },
    take: RECENT_COMPLETION_SAMPLE_LIMIT,
    select: { createdAt: true, completedAt: true },
  });

  const completionSeconds = recentCompletedOrders
    .filter((order) => order.completedAt)
    .map((order) => Math.round((order.completedAt!.getTime() - order.createdAt.getTime()) / 1000))
    .filter((seconds) => seconds > 0);

  if (completionSeconds.length < MIN_RECENT_COMPLETION_SAMPLES) {
    return {
      secondsPerOrder: DEFAULT_QUEUE_SECONDS_PER_ORDER,
      calculationSource: 'default',
    };
  }

  const averageSeconds = Math.round(
    completionSeconds.reduce((sum, seconds) => sum + seconds, 0) / completionSeconds.length,
  );

  return {
    secondsPerOrder: clampQueueSeconds(averageSeconds),
    calculationSource: 'recent_completion_cadence',
  };
}

function clampQueueSeconds(seconds: number): number {
  return Math.min(MAX_QUEUE_SECONDS_PER_ORDER, Math.max(MIN_QUEUE_SECONDS_PER_ORDER, seconds));
}

function safeQueueEstimateLog(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const code = (error as { code?: unknown }).code;
  const codeText = typeof code === 'string' ? ` code=${code}` : '';
  const messageText = error instanceof Error && error.message
    ? ` message=${error.message.replace(/\s+/g, ' ').slice(0, 160)}`
    : '';
  return `error=${name}${codeText}${messageText}`;
}

export async function completeOrder(orderId: string) {
  const completedAt = new Date();
  const changed = await prisma.order.updateMany({
    where: { id: orderId, status: 'PENDING_PAYMENT' },
    data: {
      status: 'PAYMENT_COMPLETED',
      completedAt,
    },
  });

  if (changed.count === 0) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new AppError(404, 'Order not found');
    throw new AppError(409, `Order is ${order.status}, cannot complete`);
  }

  const updated = await prisma.order.findUnique({ where: { id: orderId } });
  if (!updated) throw new AppError(404, 'Order not found');

  broadcastOrderStatusChange(updated);
  return { id: updated.id, status: updated.status, completedAt: updated.completedAt?.toISOString() };
}

export async function completeClaimedPaymentOrder(orderId: string, workerId: string) {
  const completedAt = new Date();
  const changed = await prisma.order.updateMany({
    where: {
      id: orderId,
      status: 'PENDING_PAYMENT',
      claimedById: workerId,
      claimExpiresAt: { gt: completedAt },
    },
    data: {
      status: 'PAYMENT_COMPLETED',
      completedAt,
      completedById: workerId,
    },
  });

  if (changed.count === 0) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new AppError(404, 'Order not found');
    throw new AppError(409, 'Order is not claimed by current worker');
  }

  const updated = await prisma.order.findUnique({ where: { id: orderId } });
  if (!updated) throw new AppError(404, 'Order not found');

  broadcastOrderStatusChange(updated);
  return {
    id: updated.id,
    status: updated.status,
    completedAt: updated.completedAt?.toISOString(),
    completedById: (updated as OrderWithGeneration).completedById ?? workerId,
  };
}

export async function getWorkerSummary(workerId: string) {
  const shanghaiDayRange = getShanghaiDayRange(new Date());
  const shanghaiWeekRange = getShanghaiWeekRange(new Date());
  const now = new Date();
  const [completedTotal, completedToday, completedThisWeek, claimedCount, availableCount] = await Promise.all([
    prisma.order.count({
      where: { status: 'PAYMENT_COMPLETED', completedById: workerId },
    }),
    prisma.order.count({
      where: {
        status: 'PAYMENT_COMPLETED',
        completedById: workerId,
        completedAt: {
          gte: shanghaiDayRange.start,
          lt: shanghaiDayRange.end,
        },
      },
    }),
    prisma.order.count({
      where: {
        status: 'PAYMENT_COMPLETED',
        completedById: workerId,
        completedAt: {
          gte: shanghaiWeekRange.start,
          lt: shanghaiWeekRange.end,
        },
      },
    }),
    prisma.order.count({
      where: {
        status: 'PENDING_PAYMENT',
        claimedById: workerId,
        claimExpiresAt: { gt: now },
      },
    }),
    prisma.order.count({
      where: {
        status: 'PENDING_PAYMENT',
        OR: [{ claimedById: null }, { claimExpiresAt: { lt: now } }],
      },
    }),
  ]);

  return { completedTotal, completedToday, completedThisWeek, claimedCount, availableCount };
}

export async function getAdminOrders(filters: {
  status?: string;
  page: number;
  limit: number;
}) {
  const where: Record<string, unknown> = {};
  if (filters.status) {
    where.status = filters.status;
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      include: {
        claimedBy: { select: { id: true, username: true, displayName: true } },
        completedBy: { select: { id: true, username: true, displayName: true } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders: orders.map((order) => ({
      id: order.id,
      trackingToken: order.trackingToken,
      status: order.status,
      checkoutSessionId: order.checkoutSessionId,
      errorMessage: order.errorMessage,
      generationErrorCode: order.generationErrorCode,
      generationErrorStage: (order as OrderWithGeneration).generationErrorStage ?? null,
      generationErrorDetail: (order as OrderWithGeneration).generationErrorDetail ?? null,
      generationErrorHttpStatus: (order as OrderWithGeneration).generationErrorHttpStatus ?? null,
      claimedBy: (order as typeof order & {
        claimedBy?: { id: string; username: string; displayName: string | null } | null;
      }).claimedBy ?? null,
      completedBy: (order as typeof order & {
        completedBy?: { id: string; username: string; displayName: string | null } | null;
      }).completedBy ?? null,
      completedAt: order.completedAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
    })),
    total,
    page: filters.page,
    limit: filters.limit,
  };
}

export async function cancelOrder(orderId: string) {
  const changed = await prisma.order.updateMany({
    where: {
      id: orderId,
      status: { in: ['CREATING_PAYMENT', 'PENDING_PAYMENT', 'FAILED', 'EXPIRED'] },
    },
    data: { status: 'CANCELLED' },
  });

  if (changed.count === 0) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new AppError(404, 'Order not found');
    throw new AppError(409, `Order is ${order.status}, cannot cancel`);
  }

  const updated = await prisma.order.findUnique({ where: { id: orderId } });
  if (!updated) throw new AppError(404, 'Order not found');

  broadcastOrderStatusChange(updated);
  return { id: updated.id, status: updated.status };
}

export async function expirePendingOrders() {
  const now = new Date();
  const expired = await prisma.order.updateMany({
    where: {
      status: 'PENDING_PAYMENT',
      pixExpiresAt: { lt: now },
    },
    data: { status: 'EXPIRED' },
  });

  if (expired.count > 0) {
    console.log(`Expired ${expired.count} orders`);
    const orders = await prisma.order.findMany({
      where: { status: 'EXPIRED', updatedAt: { gte: new Date(now.getTime() - 120000) } },
    });
    for (const order of orders) {
      broadcastOrderStatusChange(order);
    }
  }
}

function toOrderLike(order: CreatingPaymentOrder): Order {
  return {
    id: order.id,
    trackingToken: order.trackingToken,
    status: order.status,
    redemptionCodeId: order.redemptionCodeId,
    checkoutSessionId: null,
    checkoutUrl: null,
    paymentMethodId: null,
    setupIntentId: null,
    setupIntentClientSecret: null,
    pixCode: order.pixCode,
    pixQrPng: null,
    pixExpiresAt: null,
    pixImageUrl: order.pixImageUrl,
    billingProfileJson: null,
    encryptedSessionData: null,
    errorMessage: null,
    completedById: null,
    completedAt: null,
    createdAt: order.createdAt,
    updatedAt: order.createdAt,
    generationQueuedAt: order.generationQueuedAt,
    generationStartedAt: null,
    generationFinishedAt: null,
    generationErrorCode: null,
    generationErrorStage: null,
    generationErrorDetail: null,
    generationErrorHttpStatus: null,
    submittedRedemptionCode: null,
    claimedById: null,
    claimedAt: null,
    claimExpiresAt: null,
  } as unknown as OrderWithGeneration;
}
