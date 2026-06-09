import { expirePendingOrders } from './order.service.ts';
import { detectOutsourcedPixPayments } from './outsourced-payment.service.ts';
import { detectCompletedPixPayments } from './payment-status.service.ts';

export const PAYMENT_MAINTENANCE_INTERVAL_MS = 10_000;

export function startPaymentMaintenanceLoop(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void runPaymentMaintenanceOnce();
  }, PAYMENT_MAINTENANCE_INTERVAL_MS);
}

export async function runPaymentMaintenanceOnce(): Promise<void> {
  try {
    await detectCompletedPixPayments();
  } catch (error) {
    console.error(`Payment maintenance pix status failed ${safeMaintenanceErrorLog(error)}`);
  }

  try {
    await detectOutsourcedPixPayments();
  } catch (error) {
    console.error(`Payment maintenance outsourced status failed ${safeMaintenanceErrorLog(error)}`);
  }

  try {
    await expirePendingOrders();
  } catch (error) {
    console.error(`Payment maintenance expiration failed ${safeMaintenanceErrorLog(error)}`);
  }
}

function safeMaintenanceErrorLog(error: unknown): string {
  const record = error as {
    name?: unknown;
    code?: unknown;
    statusCode?: unknown;
    generationFailureDiagnostic?: {
      stage?: unknown;
      httpStatus?: unknown;
    };
  };
  const diagnostic = record?.generationFailureDiagnostic;
  return [
    `name=${safeLogToken(record?.name)}`,
    `code=${safeLogToken(record?.code)}`,
    `statusCode=${safeLogToken(record?.statusCode)}`,
    `stage=${safeLogToken(diagnostic?.stage)}`,
    `httpStatus=${safeLogToken(diagnostic?.httpStatus)}`,
  ].join(' ');
}

function safeLogToken(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  return String(value).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120);
}
