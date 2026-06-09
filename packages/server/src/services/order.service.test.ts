import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  order: {
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  redemptionCode: {
    findUnique: vi.fn(),
  },
};

const enqueuePixGenerationJob = vi.fn();
const getPixGenerationQueueSnapshot = vi.fn();
const getMaintenanceModeSetting = vi.fn();
const getPaymentProcessingSetting = vi.fn();
const broadcastOrderStatusChange = vi.fn();
const encrypt = vi.fn((plaintext: string) => `encrypted:${plaintext}`);

vi.mock('../db.ts', () => ({ prisma }));
vi.mock('../queues/pix-generation.queue.ts', () => ({
  enqueuePixGenerationJob,
  getPixGenerationQueueSnapshot,
  secondsPerGenerationEstimate: () => 300,
}));
vi.mock('./settings.service.ts', () => ({ getMaintenanceModeSetting, getPaymentProcessingSetting }));
vi.mock('../utils/crypto.ts', () => ({ encrypt }));
vi.mock('../ws/index.ts', () => ({
  broadcastOrderStatusChange,
  broadcastOrderNew: vi.fn(),
}));

const {
  claimPaymentOrderBatch,
  cancelOrder,
  createOrder,
  completeOrder,
  completeClaimedPaymentOrder,
  failCreatingPaymentOrder,
  getAdminOrders,
  getOrderByTrackingToken,
  getWorkerSummary,
  getWorkerOrders,
  getWorkerClaimedOrders,
  releaseClaimedPaymentOrder,
  renewClaimedPaymentOrder,
} = await import('./order.service.ts');

describe('order.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.order.count.mockResolvedValue(0);
    prisma.order.findMany.mockResolvedValue([]);
    getMaintenanceModeSetting.mockResolvedValue({ enabled: false });
    getPaymentProcessingSetting.mockResolvedValue({
      handler: 'LOCAL_WORKER',
      outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
      outsourcedActivationCodeCount: 0,
      outsourcedActivationCodePreview: [],
    });
    getPixGenerationQueueSnapshot.mockResolvedValue({
      waitingCount: 1,
      delayedCount: 0,
      activeCount: 0,
      failedCount: 0,
      orderIdsInQueue: ['order-1'],
      oldestWaitingTimestamp: Date.parse('2026-06-01T00:00:00.000Z'),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a queued payment order and enqueues Pix generation without calling upstream services', async () => {
    const queuedAt = new Date('2026-06-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(queuedAt);
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
      generationQueuedAt: queuedAt,
      createdAt: queuedAt,
    }]);
    enqueuePixGenerationJob.mockResolvedValue({ id: 'pix-generation-order-1' });

    const response = await createOrder('ABCD-1234', 'session-token-value');

    expect(response).toMatchObject({
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
      queueEstimate: {
        ordersAhead: 0,
        position: 1,
        pendingTotal: 1,
        currentGenerationCount: 0,
        estimatedQueueSeconds: 0,
        calculationSource: 'generation_queue',
      },
    });
    expect(enqueuePixGenerationJob).toHaveBeenCalledWith({ orderId: 'order-1' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.calls[0]).toContain('LOCAL_WORKER');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('freezes outsourced payment handler on newly created queued orders', async () => {
    getPaymentProcessingSetting.mockResolvedValue({
      handler: 'OUTSOURCED_BUYER_API',
      outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
      outsourcedActivationCodeCount: 1,
      outsourcedActivationCodePreview: ['DP-F...ODE'],
    });
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
      paymentHandler: 'OUTSOURCED_BUYER_API',
      generationQueuedAt: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    }]);
    enqueuePixGenerationJob.mockResolvedValue({ id: 'pix-generation-order-1' });

    await expect(createOrder('ABCD-1234', 'session-token-value')).resolves.toMatchObject({
      status: 'CREATING_PAYMENT',
      paymentHandler: 'OUTSOURCED_BUYER_API',
    });

    expect(prisma.$queryRaw.mock.calls[0]).toContain('OUTSOURCED_BUYER_API');
  });

  it('rejects new orders during maintenance mode before reserving a redemption code', async () => {
    getMaintenanceModeSetting.mockResolvedValue({ enabled: true });

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 503,
      code: 'MAINTENANCE_MODE',
    });

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(enqueuePixGenerationJob).not.toHaveBeenCalled();
  });

  it('releases the reserved code if queue enqueue fails before the tracking token is returned', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.$queryRaw.mockResolvedValue([{
      id: 'order-1',
      redemptionCodeId: 'code-1',
      trackingToken: 'track-1',
      status: 'CREATING_PAYMENT',
      generationQueuedAt: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    }]);
    enqueuePixGenerationJob.mockRejectedValue(new Error('Custom Id cannot contain :'));

    await expect(createOrder('ABCD-1234', 'session-token-value')).rejects.toMatchObject({
      statusCode: 502,
      code: 'ORDER_QUEUE_UNAVAILABLE',
    });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('message=Custom Id cannot contain :'),
    );
  });

  it('reports generation queue position for a creating payment order', async () => {
    const createdAt = new Date('2026-06-01T00:10:00.000Z');
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-2',
      trackingToken: 'track-2',
      status: 'CREATING_PAYMENT',
      pixCode: null,
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: null,
      completedAt: null,
      createdAt,
      generationQueuedAt: createdAt,
      errorMessage: null,
    });
    getPixGenerationQueueSnapshot.mockResolvedValue({
      waitingCount: 4,
      delayedCount: 1,
      activeCount: 2,
      failedCount: 0,
      orderIdsInQueue: ['order-a', 'order-b', 'order-2', 'order-c', 'order-d'],
      oldestWaitingTimestamp: Date.parse('2026-06-01T00:00:00.000Z'),
    });

    await expect(getOrderByTrackingToken('track-2')).resolves.toMatchObject({
      status: 'CREATING_PAYMENT',
      queueEstimate: {
        ordersAhead: 2,
        position: 3,
        pendingTotal: 7,
        currentGenerationCount: 2,
        estimatedQueueSeconds: 600,
        secondsPerOrder: 300,
        calculationSource: 'generation_queue',
      },
    });
  });

  it('hides Pix artifacts and queue estimate while outsourced payments are processing', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      paymentHandler: 'OUTSOURCED_BUYER_API',
      outsourcedPaymentStatus: 'authorizing',
      outsourcedTicketId: 'Toutsource123',
      pixCode: '000201pix-code',
      pixQrPng: Buffer.from('png'),
      pixExpiresAt: new Date('2026-06-01T01:00:00.000Z'),
      pixImageUrl: 'https://stripe.test/pix.png',
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      generationErrorCode: null,
      errorMessage: null,
    });

    await expect(getOrderByTrackingToken('track-1')).resolves.toMatchObject({
      status: 'PENDING_PAYMENT',
      paymentHandler: 'OUTSOURCED_BUYER_API',
      outsourcedPaymentStatus: 'authorizing',
      pixCode: null,
      pixQrPngBase64: null,
      pixImageUrl: null,
      queueEstimate: null,
    });
  });

  it('stores a safe customer failure message when Pix generation fails with account not eligible', async () => {
    const failedOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'FAILED',
      generationErrorCode: 'ACCOUNT_NOT_ELIGIBLE',
      errorMessage: '账号无资格，无法生成 Pix 支付，请更换账号后重新提交。',
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    prisma.order.findUnique.mockResolvedValue(failedOrder);

    await failCreatingPaymentOrder('order-1', 'ACCOUNT_NOT_ELIGIBLE');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.calls[0]).toContain('ACCOUNT_NOT_ELIGIBLE');
    expect(prisma.$executeRaw.mock.calls[0]).toContain('账号无资格，无法生成 Pix 支付，请更换账号后重新提交。');
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(failedOrder);
  });

  it('stores admin-only generation diagnostics without changing the customer-safe message', async () => {
    const failedOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'FAILED',
      generationErrorCode: 'PAYMENT_FAILED',
      generationErrorStage: 'stripe_pix',
      generationErrorDetail: 'Stripe request failed token=[redacted-token]',
      generationErrorHttpStatus: 400,
      errorMessage: '支付创建失败，请稍后重试。',
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    prisma.order.findUnique.mockResolvedValue(failedOrder);

    await failCreatingPaymentOrder('order-1', 'PAYMENT_FAILED', {
      stage: 'stripe_pix',
      detail: 'Stripe request failed token=eyJ.secret.payload',
      httpStatus: 400,
    });

    const rawSqlCall = String(prisma.$executeRaw.mock.calls[0]);
    expect(rawSqlCall).toContain('stripe_pix');
    expect(rawSqlCall).toContain('[redacted-token]');
    expect(rawSqlCall).not.toContain('eyJ.secret.payload');
    expect(rawSqlCall).toContain('400');
    expect(rawSqlCall).toContain('支付创建失败，请稍后重试。');
  });

  it('returns a safe customer failure message based on generation error code', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'FAILED',
      pixCode: null,
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: null,
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      generationErrorCode: 'ACCOUNT_NOT_ELIGIBLE',
      errorMessage: '支付创建失败，请稍后重试。',
    });

    await expect(getOrderByTrackingToken('track-1')).resolves.toMatchObject({
      status: 'FAILED',
      errorMessage: '账号无资格，无法生成 Pix 支付，请更换账号后重新提交。',
    });
  });

  it('worker queue only returns local worker payment orders', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);

    await getWorkerOrders(1, 20);

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'PENDING_PAYMENT',
          paymentHandler: 'LOCAL_WORKER',
        }),
      }),
    );
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: 'PENDING_PAYMENT',
        paymentHandler: 'LOCAL_WORKER',
      }),
    });
  });

  it('falls back to the generic customer failure message for unknown generation errors', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'FAILED',
      pixCode: null,
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: null,
      completedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      generationErrorCode: 'UNKNOWN_UPSTREAM_ERROR',
      errorMessage: 'raw internal message',
    });

    await expect(getOrderByTrackingToken('track-1')).resolves.toMatchObject({
      status: 'FAILED',
      errorMessage: '支付创建失败，请稍后重试。',
    });
  });

  it('worker queue returns only unclaimed or expired pending payment orders in stable server order', async () => {
    const firstOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-1',
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    const secondOrder = {
      ...firstOrder,
      id: 'order-2',
      trackingToken: 'track-2',
      pixCode: 'pix-2',
      createdAt: new Date('2026-06-01T00:01:00.000Z'),
    };
    prisma.order.findMany.mockResolvedValue([firstOrder, secondOrder]);
    prisma.order.count.mockResolvedValue(2);

    const response = await getWorkerOrders(1, 20);

    expect(response).toMatchObject({
      total: 2,
      orders: [{ id: 'order-1' }, { id: 'order-2' }],
    });
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'PENDING_PAYMENT',
          paymentHandler: 'LOCAL_WORKER',
          OR: [{ claimedById: null }, { claimExpiresAt: { lt: expect.any(Date) } }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('completeOrder completes a pending order without claim ownership', async () => {
    const completedAt = new Date('2026-06-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(completedAt);
    const completedOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PAYMENT_COMPLETED',
      completedAt,
    };
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUnique.mockResolvedValue(completedOrder);

    await expect(completeOrder('order-1')).resolves.toEqual({
      id: 'order-1',
      status: 'PAYMENT_COMPLETED',
      completedAt: completedAt.toISOString(),
    });

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'PENDING_PAYMENT' },
      data: {
        status: 'PAYMENT_COMPLETED',
        completedAt,
      },
    });
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(completedOrder);
  });

  it('claims up to ten available pending orders for the current worker in stable queue order', async () => {
    const claimedAt = new Date('2026-06-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(claimedAt);
    prisma.$queryRaw.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `order-${index + 1}`,
        trackingToken: `track-${index + 1}`,
        status: 'PENDING_PAYMENT',
        pixCode: `pix-code-${index + 1}`,
        pixQrPng: null,
        pixExpiresAt: null,
        pixImageUrl: null,
        createdAt: new Date(claimedAt.getTime() + index),
        claimedById: 'worker-1',
        claimedAt,
        claimExpiresAt: new Date('2026-06-01T00:30:00.000Z'),
      })),
    );

    const claimedBatch = await claimPaymentOrderBatch('worker-1');

    expect(claimedBatch.claimedCount).toBe(10);
    expect(claimedBatch.orders).toHaveLength(10);
    expect(claimedBatch.orders.slice(0, 2)).toMatchObject([
      { id: 'order-1', claimedById: 'worker-1', claimExpiresAt: '2026-06-01T00:30:00.000Z' },
      { id: 'order-2', claimedById: 'worker-1', claimExpiresAt: '2026-06-01T00:30:00.000Z' },
    ]);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const rawSqlCall = prisma.$queryRaw.mock.calls[0];
    expect(rawSqlCall).toContain(10);
    expect(rawSqlCall.some((part) => String(part).includes('ORDER BY "created_at" ASC, "id" ASC'))).toBe(true);
    expect(rawSqlCall.some((part) => String(part).includes('FOR UPDATE SKIP LOCKED'))).toBe(true);
    expect(rawSqlCall.some((part) => String(part).includes('"orders"."id" AS "id"'))).toBe(true);
  });

  it('claims every available pending order when fewer than ten are available', async () => {
    const claimedAt = new Date('2026-06-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(claimedAt);
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'order-1',
        trackingToken: 'track-1',
        status: 'PENDING_PAYMENT',
        pixCode: 'pix-code-1',
        pixQrPng: null,
        pixExpiresAt: null,
        pixImageUrl: null,
        createdAt: claimedAt,
        claimedById: 'worker-1',
        claimedAt,
        claimExpiresAt: new Date('2026-06-01T00:30:00.000Z'),
      },
      {
        id: 'order-2',
        trackingToken: 'track-2',
        status: 'PENDING_PAYMENT',
        pixCode: 'pix-code-2',
        pixQrPng: null,
        pixExpiresAt: null,
        pixImageUrl: null,
        createdAt: new Date('2026-06-01T00:00:01.000Z'),
        claimedById: 'worker-1',
        claimedAt,
        claimExpiresAt: new Date('2026-06-01T00:30:00.000Z'),
      },
    ]);

    await expect(claimPaymentOrderBatch('worker-1')).resolves.toMatchObject({
      claimedCount: 2,
      orders: [{ id: 'order-1' }, { id: 'order-2' }],
    });
  });

  it('returns an empty claimed batch when no pending orders are available', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(claimPaymentOrderBatch('worker-1')).resolves.toEqual({
      orders: [],
      claimedCount: 0,
    });
  });

  it('returns the current worker claimed orders only', async () => {
    prisma.order.findMany.mockResolvedValue([{
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PENDING_PAYMENT',
      pixCode: 'pix-code',
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      claimedById: 'worker-1',
      claimedAt: new Date('2026-06-01T00:00:00.000Z'),
      claimExpiresAt: new Date('2026-06-01T00:30:00.000Z'),
    }]);
    prisma.order.count.mockResolvedValue(1);

    const response = await getWorkerClaimedOrders('worker-1', 1, 20);

    expect(response.total).toBe(1);
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'PENDING_PAYMENT',
          paymentHandler: 'LOCAL_WORKER',
          claimedById: 'worker-1',
          claimExpiresAt: { gt: expect.any(Date) },
        },
      }),
    );
  });

  it('renews and releases only orders claimed by the current worker', async () => {
    prisma.order.updateMany.mockResolvedValue({ count: 1 });

    await expect(renewClaimedPaymentOrder('order-1', 'worker-1')).resolves.toMatchObject({
      id: 'order-1',
      claimExpiresAt: expect.any(String),
    });
    await expect(releaseClaimedPaymentOrder('order-1', 'worker-1')).resolves.toEqual({
      id: 'order-1',
      released: true,
    });

    expect(prisma.order.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'order-1',
        status: 'PENDING_PAYMENT',
        paymentHandler: 'LOCAL_WORKER',
        claimedById: 'worker-1',
        claimExpiresAt: { gt: expect.any(Date) },
      },
      data: { claimExpiresAt: expect.any(Date) },
    });
    expect(prisma.order.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'order-1',
        status: 'PENDING_PAYMENT',
        paymentHandler: 'LOCAL_WORKER',
        claimedById: 'worker-1',
      },
      data: { claimedById: null, claimedAt: null, claimExpiresAt: null },
    });
  });

  it('completes only the current worker claimed order and records completedById', async () => {
    const completedAt = new Date('2026-06-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(completedAt);
    const completedOrder = {
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PAYMENT_COMPLETED',
      completedAt,
      completedById: 'worker-1',
    };
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUnique.mockResolvedValue(completedOrder);

    await expect(completeClaimedPaymentOrder('order-1', 'worker-1')).resolves.toEqual({
      id: 'order-1',
      status: 'PAYMENT_COMPLETED',
      completedAt: completedAt.toISOString(),
      completedById: 'worker-1',
    });

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        status: 'PENDING_PAYMENT',
        paymentHandler: 'LOCAL_WORKER',
        claimedById: 'worker-1',
        claimExpiresAt: { gt: completedAt },
      },
      data: {
        status: 'PAYMENT_COMPLETED',
        completedAt,
        completedById: 'worker-1',
      },
    });
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(completedOrder);
  });

  it('worker summary counts only the current worker completions in Asia Shanghai time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T10:30:00.000Z'));
    prisma.order.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(5);

    await expect(getWorkerSummary('worker-1')).resolves.toEqual({
      completedTotal: 10,
      completedToday: 2,
      completedThisWeek: 5,
      claimedCount: 0,
      availableCount: 0,
    });
    expect(prisma.order.count).toHaveBeenNthCalledWith(1, {
      where: { status: 'PAYMENT_COMPLETED', completedById: 'worker-1' },
    });
  });

  it('admin orders expose worker ownership and generation diagnostics', async () => {
    prisma.order.findMany.mockResolvedValue([{
      id: 'order-1',
      trackingToken: 'track-1',
      status: 'PAYMENT_COMPLETED',
      pixCode: 'pix-code',
      checkoutSessionId: 'cs_test_123',
      errorMessage: null,
      generationErrorCode: 'ACCOUNT_NOT_ELIGIBLE',
      generationErrorStage: 'stripe_pix',
      generationErrorDetail: 'payment_pages amount_due=9900',
      generationErrorHttpStatus: 400,
      completedBy: { id: 'worker-1', username: 'worker', displayName: '工人' },
      claimedBy: { id: 'worker-1', username: 'worker', displayName: '工人' },
      completedAt: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    }]);
    prisma.order.count.mockResolvedValue(1);

    const response = await getAdminOrders({ page: 1, limit: 50 });

    expect(response.orders[0]).toMatchObject({
      completedBy: { id: 'worker-1', username: 'worker', displayName: '工人' },
      claimedBy: { id: 'worker-1', username: 'worker', displayName: '工人' },
      generationErrorCode: 'ACCOUNT_NOT_ELIGIBLE',
      generationErrorStage: 'stripe_pix',
      generationErrorDetail: 'payment_pages amount_due=9900',
      generationErrorHttpStatus: 400,
    });
    expect(response.orders[0]).not.toHaveProperty('pixCode');
  });

  it('admin orders can be filtered by tracking token and payment handler', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);

    await getAdminOrders({
      page: 2,
      limit: 20,
      status: 'PENDING_PAYMENT',
      paymentHandler: 'OUTSOURCED_BUYER_API',
      trackingToken: 'track-abc',
    });

    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: 'PENDING_PAYMENT',
        paymentHandler: 'OUTSOURCED_BUYER_API',
        trackingToken: { contains: 'track-abc', mode: 'insensitive' },
      },
      skip: 20,
      take: 20,
    }));
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: {
        status: 'PENDING_PAYMENT',
        paymentHandler: 'OUTSOURCED_BUYER_API',
        trackingToken: { contains: 'track-abc', mode: 'insensitive' },
      },
    });
  });

  it('does not cancel outsourced pending orders after a remote ticket is created', async () => {
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      status: 'PENDING_PAYMENT',
      paymentHandler: 'OUTSOURCED_BUYER_API',
      outsourcedTicketId: 'Toutsource123',
    });

    await expect(cancelOrder('order-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'OUTSOURCED_ORDER_CANCEL_BLOCKED',
    });

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        status: { in: ['CREATING_PAYMENT', 'PENDING_PAYMENT', 'FAILED', 'EXPIRED'] },
        OR: [
          { status: { not: 'PENDING_PAYMENT' } },
          { paymentHandler: { not: 'OUTSOURCED_BUYER_API' } },
          { outsourcedTicketId: null },
        ],
      },
      data: { status: 'CANCELLED' },
    });
    expect(broadcastOrderStatusChange).not.toHaveBeenCalled();
  });

  it('still cancels local pending payment orders', async () => {
    const cancelledOrder = {
      id: 'order-1',
      status: 'CANCELLED',
      paymentHandler: 'LOCAL_WORKER',
      outsourcedTicketId: null,
    };
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUnique.mockResolvedValue(cancelledOrder);

    await expect(cancelOrder('order-1')).resolves.toEqual({ id: 'order-1', status: 'CANCELLED' });

    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(cancelledOrder);
  });
});
