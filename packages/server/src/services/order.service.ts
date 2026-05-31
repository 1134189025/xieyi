import { nanoid } from 'nanoid';
import { prisma } from '../db.ts';
import { AppError } from '../middleware/error-handler.ts';
import { encrypt } from '../utils/crypto.ts';
import { resolveAccessToken, createCheckoutUrl } from './chatgpt-session.service.ts';
import { generatePixPayment } from './pix-payment.service.ts';
import { broadcastOrderNew, broadcastOrderStatusChange } from '../ws/index.ts';

export async function createOrder(redemptionCode: string, session: string) {
  const code = await prisma.redemptionCode.findUnique({
    where: { code: redemptionCode },
  });

  if (!code) {
    throw new AppError(400, 'Invalid redemption code', 'INVALID_CODE');
  }
  if (code.usedAt) {
    throw new AppError(400, 'Redemption code already used', 'CODE_USED');
  }

  const trackingToken = nanoid(12);
  const encryptedSession = encrypt(session);

  let order = await prisma.order.create({
    data: {
      trackingToken,
      redemptionCodeId: code.id,
      encryptedSessionData: encryptedSession,
    },
  });

  try {
    const accessToken = await resolveAccessToken(session);
    const checkoutUrl = await createCheckoutUrl(accessToken);
    const { stripeResult, profile, qrPngBuffer } = await generatePixPayment(checkoutUrl);

    const pixExpiresAt = stripeResult.pix.expiresAt
      ? new Date(stripeResult.pix.expiresAt * 1000)
      : null;

    order = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'PENDING_PAYMENT',
        checkoutSessionId: stripeResult.checkoutSessionId,
        checkoutUrl,
        paymentMethodId: stripeResult.paymentMethodId,
        pixCode: stripeResult.pix.data,
        pixQrPng: new Uint8Array(qrPngBuffer),
        pixExpiresAt,
        pixImageUrl: stripeResult.pix.imageUrlPng,
        billingProfileJson: profile as object,
        encryptedSessionData: null,
      },
    });

    await prisma.redemptionCode.update({
      where: { id: code.id },
      data: { usedAt: new Date() },
    });

    broadcastOrderNew(order);

    return {
      trackingToken: order.trackingToken,
      status: order.status,
      pixCode: order.pixCode,
      pixQrPngBase64: qrPngBuffer.toString('base64'),
      pixExpiresAt: pixExpiresAt?.toISOString() ?? null,
      pixImageUrl: order.pixImageUrl,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'FAILED',
        errorMessage,
        encryptedSessionData: null,
      },
    });

    await prisma.redemptionCode.update({
      where: { id: code.id },
      data: { usedAt: new Date() },
    });

    throw new AppError(502, `Payment creation failed: ${errorMessage}`, 'PAYMENT_FAILED');
  }
}

export async function getOrderByTrackingToken(trackingToken: string) {
  const order = await prisma.order.findUnique({ where: { trackingToken } });
  if (!order) {
    throw new AppError(404, 'Order not found');
  }

  return {
    trackingToken: order.trackingToken,
    status: order.status,
    pixCode: order.pixCode,
    pixQrPngBase64: order.pixQrPng ? Buffer.from(order.pixQrPng).toString('base64') : null,
    pixExpiresAt: order.pixExpiresAt?.toISOString() ?? null,
    pixImageUrl: order.pixImageUrl,
    completedAt: order.completedAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    errorMessage: order.status === 'FAILED' ? order.errorMessage : null,
  };
}

export async function getWorkerOrders(page: number, limit: number) {
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where: { status: 'PENDING_PAYMENT' },
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.count({ where: { status: 'PENDING_PAYMENT' } }),
  ]);

  return {
    orders: orders.map((o) => ({
      id: o.id,
      trackingToken: o.trackingToken,
      status: o.status,
      pixCode: o.pixCode,
      pixQrPngBase64: o.pixQrPng ? Buffer.from(o.pixQrPng).toString('base64') : null,
      pixExpiresAt: o.pixExpiresAt?.toISOString() ?? null,
      pixImageUrl: o.pixImageUrl,
      createdAt: o.createdAt.toISOString(),
    })),
    total,
    page,
    limit,
  };
}

export async function completeOrder(orderId: string, workerId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    throw new AppError(404, 'Order not found');
  }
  if (order.status !== 'PENDING_PAYMENT') {
    throw new AppError(409, `Order is ${order.status}, cannot complete`);
  }

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      status: 'PAYMENT_COMPLETED',
      completedById: workerId,
      completedAt: new Date(),
    },
  });

  broadcastOrderStatusChange(updated);
  return { id: updated.id, status: updated.status, completedAt: updated.completedAt?.toISOString() };
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
      include: { completedBy: { select: { id: true, displayName: true, username: true } } },
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
      completedBy: o.completedBy
        ? { id: o.completedBy.id, displayName: o.completedBy.displayName ?? o.completedBy.username }
        : null,
      completedAt: o.completedAt?.toISOString() ?? null,
      createdAt: o.createdAt.toISOString(),
    })),
    total,
    page: filters.page,
    limit: filters.limit,
  };
}

export async function cancelOrder(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError(404, 'Order not found');
  if (order.status === 'PAYMENT_COMPLETED') {
    throw new AppError(409, 'Cannot cancel a completed order');
  }

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status: 'CANCELLED' },
  });

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
