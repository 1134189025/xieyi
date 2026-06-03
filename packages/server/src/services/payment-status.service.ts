import { retrieveStripeSetupIntentStatus } from '@pix/core';
import type { Order } from '@prisma/client';
import { prisma } from '../db.ts';
import { config } from '../config.ts';
import { decrypt } from '../utils/crypto.ts';
import { broadcastOrderStatusChange } from '../ws/index.ts';
import {
  getAutoPaymentDetectionSetting,
  recordProxyFailure,
  recordProxySuccess,
  selectHealthyProxy,
  shouldCountProxyFailure,
  type SelectedProxy,
} from './settings.service.ts';

const PAYMENT_STATUS_CHECK_LIMIT = 50;

export interface PixPaymentDetectionResult {
  checked: number;
  completed: number;
  disabled: boolean;
  skipped: boolean;
}

let detectionRunning = false;

export async function detectCompletedPixPayments(): Promise<PixPaymentDetectionResult> {
  if (detectionRunning) {
    return { checked: 0, completed: 0, disabled: false, skipped: true };
  }

  detectionRunning = true;
  try {
    return await runPixPaymentDetection();
  } finally {
    detectionRunning = false;
  }
}

async function runPixPaymentDetection(): Promise<PixPaymentDetectionResult> {
  const setting = await getAutoPaymentDetectionSetting();
  if (!setting.enabled) {
    return { checked: 0, completed: 0, disabled: true, skipped: false };
  }

  const orders = await prisma.order.findMany({
    where: {
      status: 'PENDING_PAYMENT',
      setupIntentId: { not: null },
      setupIntentClientSecret: { not: null },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PAYMENT_STATUS_CHECK_LIMIT,
  });

  const results = await runWithConcurrency(orders, config.paymentDetectionConcurrency, async (order) => {
    const stripeProxy = await selectHealthyProxy('stripe');
    return detectSingleOrderPayment(order, stripeProxy);
  });
  const completed = results.filter(Boolean).length;

  return { checked: orders.length, completed, disabled: false, skipped: false };
}

async function detectSingleOrderPayment(order: Order, stripeProxy: SelectedProxy | null): Promise<boolean> {
  if (!order.setupIntentId || !order.setupIntentClientSecret) return false;

  try {
    const setupIntentStatus = await retrieveStripeSetupIntentStatus({
      setupIntentId: order.setupIntentId,
      clientSecret: decrypt(order.setupIntentClientSecret),
      proxyUrl: stripeProxy?.proxyUrl,
      retry: { attempts: 3 },
    });
    await recordProxySuccess('stripe', stripeProxy?.id ?? null);

    if (setupIntentStatus.id !== order.setupIntentId) {
      console.warn(`Pix payment status check id mismatch order=${order.id}`);
      return false;
    }

    if (setupIntentStatus.status !== 'succeeded') {
      return false;
    }

    const completedAt = new Date();
    const changed = await prisma.$executeRaw`
      UPDATE "orders"
      SET
        "status" = 'PAYMENT_COMPLETED'::"OrderStatus",
        "completed_at" = ${completedAt},
        "completed_by_id" = CASE
          WHEN "claimed_by_id" IS NOT NULL AND "claim_expires_at" > ${completedAt}
          THEN "claimed_by_id"
          ELSE NULL
        END,
        "updated_at" = NOW()
      WHERE "id" = ${order.id}
        AND "status" = 'PENDING_PAYMENT'::"OrderStatus"
    `;
    if (changed === 0) return false;

    const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } });
    if (updatedOrder) broadcastOrderStatusChange(updatedOrder);
    return true;
  } catch (error) {
    if (shouldCountProxyFailure(error)) {
      await recordProxyFailure('stripe', stripeProxy?.id ?? null, error);
    }
    console.warn(`Pix payment status check failed order=${order.id} ${safeStatusCheckLog(error)}`);
    return false;
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex]);
      }
    }),
  );

  return results;
}

function safeStatusCheckLog(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  const codeText = typeof code === 'string' ? ` code=${code}` : '';
  const name = error instanceof Error ? error.name : 'UnknownError';
  return `error=${name}${codeText}`;
}
