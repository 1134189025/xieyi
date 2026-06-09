import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const detectCompletedPixPayments = vi.fn();
const detectOutsourcedPixPayments = vi.fn();
const expirePendingOrders = vi.fn();

vi.mock('./payment-status.service.ts', () => ({ detectCompletedPixPayments }));
vi.mock('./outsourced-payment.service.ts', () => ({ detectOutsourcedPixPayments }));
vi.mock('./order.service.ts', () => ({ expirePendingOrders }));

const { PAYMENT_MAINTENANCE_INTERVAL_MS, startPaymentMaintenanceLoop } = await import('./payment-maintenance.service.ts');

describe('payment-maintenance.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    detectCompletedPixPayments.mockResolvedValue({ checked: 0, completed: 0, disabled: false, skipped: false });
    detectOutsourcedPixPayments.mockResolvedValue({ checked: 0, completed: 0, failed: 0 });
    expirePendingOrders.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('runs payment detection and expiration maintenance every 10 seconds', async () => {
    const interval = startPaymentMaintenanceLoop();

    expect(PAYMENT_MAINTENANCE_INTERVAL_MS).toBe(10_000);
    expect(detectCompletedPixPayments).not.toHaveBeenCalled();

    await actTimer(PAYMENT_MAINTENANCE_INTERVAL_MS);

    expect(detectCompletedPixPayments).toHaveBeenCalledTimes(1);
    expect(detectOutsourcedPixPayments).toHaveBeenCalledTimes(1);
    expect(expirePendingOrders).toHaveBeenCalledTimes(1);
    expect(detectOutsourcedPixPayments.mock.invocationCallOrder[0]).toBeGreaterThan(
      detectCompletedPixPayments.mock.invocationCallOrder[0],
    );
    expect(expirePendingOrders.mock.invocationCallOrder[0]).toBeGreaterThan(
      detectOutsourcedPixPayments.mock.invocationCallOrder[0],
    );

    clearInterval(interval);
  });

  it('logs outsourced maintenance failures without exposing upstream details', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    detectOutsourcedPixPayments.mockRejectedValueOnce(Object.assign(
      new Error('raw DP-FIRST-CODE 000201abcdefghijklmnopqrstuvwxyz1234567890pix'),
      {
        name: 'OutsourcedBuyerApiError',
        code: 'OUTSOURCED_API_UNAVAILABLE',
        statusCode: 502,
        generationFailureDiagnostic: {
          stage: 'outsourced_api',
          httpStatus: 503,
          detail: 'raw DP-FIRST-CODE 000201abcdefghijklmnopqrstuvwxyz1234567890pix',
        },
      },
    ));

    const { runPaymentMaintenanceOnce } = await import('./payment-maintenance.service.ts');
    await runPaymentMaintenanceOnce();

    expect(detectCompletedPixPayments).toHaveBeenCalledTimes(1);
    expect(expirePendingOrders).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Payment maintenance outsourced status failed'));

    const logged = String(logSpy.mock.calls[0][0]);
    expect(logged).toContain('code=OUTSOURCED_API_UNAVAILABLE');
    expect(logged).toContain('stage=outsourced_api');
    expect(logged).toContain('httpStatus=503');
    expect(logged).not.toContain('DP-FIRST-CODE');
    expect(logged).not.toContain('000201abcdefghijklmnopqrstuvwxyz1234567890pix');
    expect(logged).not.toContain('detail');
    expect(logged).not.toContain('raw');
  });
});

async function actTimer(milliseconds: number) {
  vi.advanceTimersByTime(milliseconds);
  await Promise.resolve();
  await Promise.resolve();
}
