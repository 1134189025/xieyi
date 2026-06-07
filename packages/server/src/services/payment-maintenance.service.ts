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
    console.error(error);
  }

  try {
    await detectOutsourcedPixPayments();
  } catch (error) {
    console.error(error);
  }

  try {
    await expirePendingOrders();
  } catch (error) {
    console.error(error);
  }
}
