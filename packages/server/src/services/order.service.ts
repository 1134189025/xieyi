import { randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Order, Prisma } from '@prisma/client';
import { prisma } from '../db.ts';
import { AppError } from '../middleware/error-handler.ts';
import { encrypt } from '../utils/crypto.ts';
import { parseChatGptSessionInput, resolveAccessToken, createCheckoutUrl } from './chatgpt-session.service.ts';
import { generatePixPayment } from './pix-payment.service.ts';
import { getConfiguredProxyUrl } from './settings.service.ts';
import { broadcastOrderNew, broadcastOrderStatusChange } from '../ws/index.ts';
import { getShanghaiDayRange, getShanghaiWeekRange } from '../utils/shanghai-time.ts';

const SAFE_PAYMENT_ERROR_MESSAGE = '支付创建失败，请稍后重试';
const ORDER_STATE_CHANGED_MESSAGE = '订单状态已变化，请重新提交或联系管理员';
const ORDER_CREATE_BUSY_MESSAGE = '订单创建繁忙，请稍后重试';
const DEFAULT_QUEUE_SECONDS_PER_ORDER = 5 * 60;
const MIN_QUEUE_SECONDS_PER_ORDER = 60;
const MAX_QUEUE_SECONDS_PER_ORDER = 30 * 60;
const RECENT_COMPLETION_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RECENT_COMPLETION_SAMPLE_LIMIT = 20;
const MIN_RECENT_COMPLETION_SAMPLES = 3;
const SAFE_PAYMENT_ERROR_CODES = new Set([
  'PAYMENT_FAILED',
  'CHATGPT_SESSION_FAILED',
  'CHATGPT_CHECKOUT_FAILED',
  'UPSTREAM_TIMEOUT',
  'CHATGPT_SESSION_UNRECOGNIZED',
  'ORDER_STATE_CHANGED',
  'ACCOUNT_NOT_ELIGIBLE',
  'ORDER_CREATE_BUSY',
]);

interface CreatingPaymentOrder {
  id: string;
  trackingToken: string;
  status: string;
  redemptionCodeId: string;
  pixCode: string | null;
  pixImageUrl: string | null;
}

type QueueCalculationSource = 'recent_completion_cadence' | 'default';

interface QueueEstimate {
  ordersAhead: number;
  position: number;
  pendingTotal: number;
  estimatedQueueSeconds: number;
  secondsPerOrder: number;
  calculationSource: QueueCalculationSource;
  calculatedAt: string;
}

export async function createOrder(redemptionCode: string, session: string) {
  const chatGptCredential = parseChatGptSessionInput(session);
  const proxyUrl = await getConfiguredProxyUrl();
  const externalRequestOptions = {
    proxyUrl: proxyUrl ?? undefined,
    retry: { attempts: 3 },
  };

  const trackingToken = nanoid(12);
  const encryptedSession = encrypt(session);
  const reservedAt = new Date();
  let order = await createCreatingPaymentOrder({
    redemptionCode,
    reservedAt,
    trackingToken,
    encryptedSession,
  });

  try {
    const accessToken = await resolveAccessToken(chatGptCredential, externalRequestOptions);
    const checkoutUrl = await createCheckoutUrl(accessToken, externalRequestOptions);
    const { stripeResult, profile, qrPngBuffer } = await generatePixPayment(checkoutUrl, externalRequestOptions);

    const pixExpiresAt = stripeResult.pix.expiresAt
      ? new Date(stripeResult.pix.expiresAt * 1000)
      : null;

    const pendingOrderData = {
        status: 'PENDING_PAYMENT',
        checkoutSessionId: stripeResult.checkoutSessionId,
        checkoutUrl,
        paymentMethodId: stripeResult.paymentMethodId,
        pixCode: stripeResult.pix.data,
        pixQrPng: new Uint8Array(qrPngBuffer),
        pixExpiresAt,
        pixImageUrl: stripeResult.pix.imageUrlPng,
        setupIntentId: stripeResult.pix.setupIntentId ?? null,
        setupIntentClientSecret: stripeResult.pix.setupIntentClientSecret
          ? encrypt(stripeResult.pix.setupIntentClientSecret)
          : null,
        billingProfileJson: profile as object,
        encryptedSessionData: null,
    } as const;

    const changed = await prisma.order.updateMany({
      where: { id: order.id, status: 'CREATING_PAYMENT' },
      data: pendingOrderData,
    });

    if (changed.count === 0) {
      throw new AppError(409, ORDER_STATE_CHANGED_MESSAGE, 'ORDER_STATE_CHANGED');
    }

    const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } });
    if (!updatedOrder) throw new AppError(502, SAFE_PAYMENT_ERROR_MESSAGE, 'PAYMENT_FAILED');

    broadcastOrderNew(updatedOrder);

    return {
      trackingToken: updatedOrder.trackingToken,
      status: updatedOrder.status,
      pixCode: updatedOrder.pixCode,
      pixQrPngBase64: qrPngBuffer.toString('base64'),
      pixExpiresAt: pixExpiresAt?.toISOString() ?? null,
      pixImageUrl: updatedOrder.pixImageUrl,
      queueEstimate: await safeCalculateQueueEstimate(updatedOrder),
    };
  } catch (error) {
    console.error('Payment creation failed:', error);
    await releaseCreatingPaymentOrder(order.id);

    throw toPublicPaymentCreationError(error);
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
          "created_at",
          "updated_at"
        )
        SELECT
          ${orderId},
          ${input.trackingToken},
          'CREATING_PAYMENT'::"OrderStatus",
          reserved."id",
          ${input.encryptedSession},
          NOW(),
          NOW()
        FROM reserved
        RETURNING
          "id",
          "tracking_token",
          "status",
          "redemption_code_id",
          "pix_code",
          "pix_image_url"
      )
      SELECT
        "id",
        "tracking_token" AS "trackingToken",
        "status"::text AS "status",
        "redemption_code_id" AS "redemptionCodeId",
        "pix_code" AS "pixCode",
        "pix_image_url" AS "pixImageUrl"
      FROM inserted
    `;

    if (order) {
      return order;
    }

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

function toPublicPaymentCreationError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error.code && SAFE_PAYMENT_ERROR_CODES.has(error.code)
      ? error
      : new AppError(502, SAFE_PAYMENT_ERROR_MESSAGE, 'PAYMENT_FAILED');
  }

  const orderCreationError = toPublicPrismaOrderError(error);
  if (orderCreationError) return orderCreationError;

  const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (
    typeof candidate.statusCode === 'number' &&
    typeof candidate.code === 'string' &&
    SAFE_PAYMENT_ERROR_CODES.has(candidate.code) &&
    typeof candidate.message === 'string'
  ) {
    return new AppError(candidate.statusCode, candidate.message, candidate.code);
  }

  return new AppError(502, SAFE_PAYMENT_ERROR_MESSAGE, 'PAYMENT_FAILED');
}

function toPublicPrismaOrderError(error: unknown): AppError | null {
  if (prismaErrorCode(error) === 'P2028') {
    return new AppError(409, ORDER_CREATE_BUSY_MESSAGE, 'ORDER_CREATE_BUSY');
  }
  if (isRedemptionCodeOrderUniqueConflict(error)) {
    return new AppError(400, 'Redemption code already used', 'CODE_USED');
  }
  return null;
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
    errorMessage: order.status === 'FAILED' ? SAFE_PAYMENT_ERROR_MESSAGE : null,
    queueEstimate: await safeCalculateQueueEstimate(order),
  };
}

export async function getWorkerOrders(page: number, limit: number) {
  const workerQueueWhere: Prisma.OrderWhereInput = { status: 'PENDING_PAYMENT' };
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
  return {
    id: order.id,
    trackingToken: order.trackingToken,
    status: order.status,
    pixCode: order.pixCode,
    pixQrPngBase64: order.pixQrPng ? Buffer.from(order.pixQrPng).toString('base64') : null,
    pixExpiresAt: order.pixExpiresAt?.toISOString() ?? null,
    pixImageUrl: order.pixImageUrl,
    createdAt: order.createdAt.toISOString(),
  };
}

async function calculateQueueEstimate(order: Order): Promise<QueueEstimate | null> {
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
  return `error=${name}${codeText}`;
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

export async function getWorkerSummary() {
  const shanghaiDayRange = getShanghaiDayRange(new Date());
  const shanghaiWeekRange = getShanghaiWeekRange(new Date());
  const [completedTotal, completedToday, completedThisWeek] = await Promise.all([
    prisma.order.count({
      where: { status: 'PAYMENT_COMPLETED' },
    }),
    prisma.order.count({
      where: {
        status: 'PAYMENT_COMPLETED',
        completedAt: {
          gte: shanghaiDayRange.start,
          lt: shanghaiDayRange.end,
        },
      },
    }),
    prisma.order.count({
      where: {
        status: 'PAYMENT_COMPLETED',
        completedAt: {
          gte: shanghaiWeekRange.start,
          lt: shanghaiWeekRange.end,
        },
      },
    }),
  ]);

  return { completedTotal, completedToday, completedThisWeek };
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
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders: orders.map((o) => ({
      id: o.id,
      trackingToken: o.trackingToken,
      status: o.status,
      pixCode: o.pixCode,
      checkoutSessionId: o.checkoutSessionId,
      errorMessage: o.errorMessage,
      completedAt: o.completedAt?.toISOString() ?? null,
      createdAt: o.createdAt.toISOString(),
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
