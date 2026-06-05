import { parseChatGptSessionInput } from './chatgpt-session.service.ts';
import { generatePixPayment } from './pix-payment.service.ts';
import {
  recordProxyFailure,
  recordProxySuccess,
  selectHealthyProxy,
  shouldCountProxyFailure,
  type ProxyPoolName,
  type SelectedProxy,
} from './settings.service.ts';
import { decrypt, encrypt } from '../utils/crypto.ts';
import { prisma } from '../db.ts';
import { broadcastOrderReady } from '../ws/index.ts';
import { failCreatingPaymentOrder } from './order.service.ts';

const SAFE_PAYMENT_ERROR_CODE = 'PAYMENT_FAILED';
const TERMINAL_GENERATION_ERROR_CODES = new Set([
  'ACCOUNT_NOT_ELIGIBLE',
  'CHATGPT_SESSION_UNRECOGNIZED',
]);

interface ProcessPixGenerationJobInput {
  orderId: string;
  finalAttempt: boolean;
}

export async function processPixGenerationJob(input: ProcessPixGenerationJobInput): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: input.orderId } });
  if (!order || order.status !== 'CREATING_PAYMENT') return;
  if (!order.encryptedSessionData) {
    await failCreatingPaymentOrder(input.orderId, 'CHATGPT_SESSION_UNRECOGNIZED');
    return;
  }

  const started = await prisma.order.updateMany({
    where: { id: input.orderId, status: 'CREATING_PAYMENT' },
    data: { generationStartedAt: new Date(), generationErrorCode: null },
  });
  if (started.count === 0) return;

  let failedPoolName: ProxyPoolName | null = null;
  let failedProxy: SelectedProxy | null = null;
  let selectedProxy: SelectedProxy | null = null;
  let selectedProxyPoolName: ProxyPoolName | null = null;

  try {
    const credential = parseChatGptSessionInput(decrypt(order.encryptedSessionData));

    const pixProxy = await selectPixGenerationProxy();
    selectedProxy = pixProxy.proxy;
    selectedProxyPoolName = pixProxy.poolName;

    const { stripeResult, checkoutUrl, profile, qrPngBuffer } = await generatePixPayment(credential, {
      proxy: {
        proxyUrl: selectedProxy?.proxyUrl,
        poolName: selectedProxyPoolName,
      },
    });
    if (selectedProxyPoolName) {
      await recordProxySuccess(selectedProxyPoolName, selectedProxy?.id ?? null);
    }

    const pixExpiresAt = stripeResult.pix.expiresAt
      ? new Date(stripeResult.pix.expiresAt * 1000)
      : null;

    const changed = await prisma.order.updateMany({
      where: { id: input.orderId, status: 'CREATING_PAYMENT' },
      data: {
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
        generationFinishedAt: new Date(),
        generationErrorCode: null,
      },
    });
    if (changed.count === 0) return;

    const updatedOrder = await prisma.order.findUnique({ where: { id: input.orderId } });
    if (!updatedOrder) return;
    broadcastOrderReady(updatedOrder);
  } catch (error) {
    failedPoolName = proxyPoolNameFromError(error);
    failedProxy = failedPoolName === selectedProxyPoolName ? selectedProxy : null;

    if (failedPoolName && shouldCountProxyFailure(error)) {
      await recordProxyFailure(failedPoolName, failedProxy?.id ?? null, error);
    }

    const errorCode = publicGenerationErrorCode(error);
    if (!input.finalAttempt && !isTerminalGenerationError(errorCode)) {
      throw error;
    }

    await failCreatingPaymentOrder(input.orderId, errorCode, generationFailureDiagnosticFromError(error));
  }
}

async function selectPixGenerationProxy(): Promise<{ poolName: ProxyPoolName | null; proxy: SelectedProxy | null }> {
  const stripeProxy = await selectHealthyProxy('stripe');
  if (stripeProxy) return { poolName: 'stripe', proxy: stripeProxy };

  const chatGptProxy = await selectHealthyProxy('chatgpt');
  if (chatGptProxy) return { poolName: 'chatgpt', proxy: chatGptProxy };

  return { poolName: null, proxy: null };
}

function publicGenerationErrorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : SAFE_PAYMENT_ERROR_CODE;
}

function isTerminalGenerationError(errorCode: string): boolean {
  return TERMINAL_GENERATION_ERROR_CODES.has(errorCode);
}

function proxyPoolNameFromError(error: unknown): ProxyPoolName | null {
  const value = (error as { proxyPoolName?: unknown }).proxyPoolName;
  return value === 'chatgpt' || value === 'stripe' ? value : null;
}

function generationFailureDiagnosticFromError(error: unknown) {
  const diagnostic = (error as {
    generationFailureDiagnostic?: {
      stage?: string | null;
      detail?: string | null;
      httpStatus?: number | null;
    };
  }).generationFailureDiagnostic;
  return {
    stage: diagnostic?.stage ?? null,
    detail: diagnostic?.detail ?? null,
    httpStatus: diagnostic?.httpStatus ?? null,
  };
}
