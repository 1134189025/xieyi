import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const detectCompletedPixPayments = vi.fn();
const expirePendingOrders = vi.fn();

vi.mock('./payment-status.service.ts', () => ({ detectCompletedPixPayments }));
vi.mock('./order.service.ts', () => ({ expirePendingOrders }));

const { PAYMENT_MAINTENANCE_INTERVAL_MS, startPaymentMaintenanceLoop } = await import('./payment-maintenance.service.ts');

describe('payment-maintenance.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    detectCompletedPixPayments.mockResolvedValue({ checked: 0, completed: 0, disabled: false, skipped: false });
    expirePendingOrders.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs payment detection and expiration maintenance every 10 seconds', async () => {
    const interval = startPaymentMaintenanceLoop();

    expect(PAYMENT_MAINTENANCE_INTERVAL_MS).toBe(10_000);
    expect(detectCompletedPixPayments).not.toHaveBeenCalled();

    await actTimer(PAYMENT_MAINTENANCE_INTERVAL_MS);

    expect(detectCompletedPixPayments).toHaveBeenCalledTimes(1);
    expect(expirePendingOrders).toHaveBeenCalledTimes(1);
    expect(expirePendingOrders.mock.invocationCallOrder[0]).toBeGreaterThan(
      detectCompletedPixPayments.mock.invocationCallOrder[0],
    );

    clearInterval(interval);
  });
});

async function actTimer(milliseconds: number) {
  vi.advanceTimersByTime(milliseconds);
  await Promise.resolve();
  await Promise.resolve();
}
