import { retrieveStripeSetupIntentStatus } from '@pix/core';
import type { Order } from '@prisma/client';
import { prisma } from '../db.ts';
import { decrypt } from '../utils/crypto.ts';
import { broadcastOrderStatusChange } from '../ws/index.ts';
import { getAutoPaymentDetectionSetting, getConfiguredProxyUrl } from './settings.service.ts';

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
  const proxyUrl = await getConfiguredProxyUrl();
  let completed = 0;

  for (const order of orders) {
    const didComplete = await detectSingleOrderPayment(order, proxyUrl);
    if (didComplete) completed += 1;
  }

  return { checked: orders.length, completed, disabled: false, skipped: false };
}

async function detectSingleOrderPayment(order: Order, proxyUrl: string | null): Promise<boolean> {
  if (!order.setupIntentId || !order.setupIntentClientSecret) return false;

  try {
    const setupIntentStatus = await retrieveStripeSetupIntentStatus({
      setupIntentId: order.setupIntentId,
      clientSecret: decrypt(order.setupIntentClientSecret),
      proxyUrl: proxyUrl ?? undefined,
      retry: { attempts: 3 },
    });

    if (setupIntentStatus.id !== order.setupIntentId) {
      console.warn(`Pix payment status check id mismatch order=${order.id}`);
      return false;
    }

    if (setupIntentStatus.status !== 'succeeded') {
      return false;
    }

    const completedAt = new Date();
    const changed = await prisma.order.updateMany({
      where: { id: order.id, status: 'PENDING_PAYMENT' },
      data: {
        status: 'PAYMENT_COMPLETED',
        completedById: null,
        completedAt,
      },
    });
    if (changed.count === 0) return false;

    const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } });
    if (updatedOrder) broadcastOrderStatusChange(updatedOrder);
    return true;
  } catch (error) {
    console.warn(`Pix payment status check failed order=${order.id} ${safeStatusCheckLog(error)}`);
    return false;
  }
}

function safeStatusCheckLog(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  const codeText = typeof code === 'string' ? ` code=${code}` : '';
  const name = error instanceof Error ? error.name : 'UnknownError';
  return `error=${name}${codeText}`;
}
