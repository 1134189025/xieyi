import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  user: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  order: {
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  redemptionCode: {
    deleteMany: vi.fn(),
  },
  systemSetting: {
    findUnique: vi.fn(),
    deleteMany: vi.fn(),
  },
  outsourcedActivationCode: {
    count: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
};
const enqueuePixGenerationJob = vi.fn();
const getPixGenerationQueueMetrics = vi.fn();
const getPixGenerationQueueSnapshot = vi.fn();
const broadcastOrderStatusChange = vi.fn();

vi.mock('./db.ts', () => ({ prisma }));
vi.mock('./queues/pix-generation.queue.ts', () => ({
  enqueuePixGenerationJob,
  getPixGenerationQueueSnapshot,
  getPixGenerationQueueMetrics,
  secondsPerGenerationEstimate: () => 300,
}));
vi.mock('./ws/index.ts', () => ({
  broadcastOrderReady: vi.fn(),
  broadcastOrderNew: vi.fn(),
  broadcastOrderStatusChange,
}));

const { createApp } = await import('./app.ts');
const { config } = await import('./config.ts');

describe('server app routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ ok: 1 }]);
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      role: 'ADMIN',
      enabled: true,
      deletedAt: null,
    });
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);
    prisma.order.findUnique.mockResolvedValue(null);
    prisma.order.findFirst.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);
    prisma.redemptionCode.deleteMany.mockResolvedValue({ count: 0 });
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.systemSetting.findUnique.mockResolvedValue(null);
    prisma.systemSetting.deleteMany.mockResolvedValue({ count: 0 });
    prisma.outsourcedActivationCode.count.mockResolvedValue(0);
    prisma.outsourcedActivationCode.deleteMany.mockResolvedValue({ count: 0 });
    prisma.outsourcedActivationCode.findMany.mockResolvedValue([]);
    prisma.outsourcedActivationCode.updateMany.mockResolvedValue({ count: 0 });
    enqueuePixGenerationJob.mockResolvedValue({ id: 'pix-generation-order-1' });
    getPixGenerationQueueSnapshot.mockResolvedValue({
      waitingCount: 1,
      delayedCount: 0,
      activeCount: 0,
      failedCount: 0,
      orderIdsInQueue: ['order-1'],
      oldestWaitingTimestamp: Date.parse('2026-06-09T00:00:00.000Z'),
    });
    getPixGenerationQueueMetrics.mockResolvedValue({
      waitingCount: 0,
      delayedCount: 0,
      activeCount: 0,
      failedCount: 0,
      oldestWaitingSeconds: null,
    });

    server = createServer(createApp());
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('returns process health and dependency readiness through HTTP', async () => {
    await expectJson('/api/health', 200, expect.objectContaining({ status: 'ok' }));
    await expectJson('/api/ready', 200, {
      status: 'ok',
      checks: { database: 'ok', queue: 'ok' },
      timestamp: expect.any(String),
    });
  });

  it('logs in an admin and returns the current user through HTTP', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorseBattery', 4);
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'admin-1',
        username: 'admin',
        passwordHash,
        role: 'ADMIN',
        displayName: 'Administrator',
        enabled: true,
        deletedAt: null,
      })
      .mockResolvedValueOnce({
        id: 'admin-1',
        role: 'ADMIN',
        enabled: true,
        deletedAt: null,
      })
      .mockResolvedValueOnce({
        id: 'admin-1',
        username: 'admin',
        role: 'ADMIN',
        displayName: 'Administrator',
        enabled: true,
        deletedAt: null,
      });

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'CorrectHorseBattery' }),
    });
    expect(loginResponse.status).toBe(200);
    const loginBody = await loginResponse.json() as { token: string; user: { role: string } };
    expect(loginBody.user).toEqual(expect.objectContaining({ role: 'ADMIN' }));
    expect(jwt.verify(loginBody.token, config.jwtSecret)).toEqual(expect.objectContaining({
      sub: 'admin-1',
      role: 'ADMIN',
    }));

    await expectJson('/api/auth/me', 200, {
      user: {
        id: 'admin-1',
        username: 'admin',
        role: 'ADMIN',
        displayName: 'Administrator',
      },
    }, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  });

  it('rejects invalid login payloads before hitting authentication service', async () => {
    await expectJson(
      '/api/auth/login',
      400,
      { error: 'Invalid input' },
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '', password: '' }),
      },
    );
  });

  it('returns 503 readiness when the Pix queue is unavailable', async () => {
    getPixGenerationQueueMetrics.mockRejectedValueOnce(new Error('redis unavailable'));

    await expectJson('/api/ready', 503, {
      status: 'error',
      checks: { database: 'ok', queue: 'error' },
      timestamp: expect.any(String),
    });
  });

  it('requires admin authentication for order management', async () => {
    await expectJson('/api/admin/orders', 401, { error: 'Authentication required' });
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('requires worker authentication for claimed order management', async () => {
    await expectJson('/api/worker/orders/mine', 401, { error: 'Authentication required' });
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('creates a public order through HTTP and returns accepted tracking state', async () => {
    const createdAt = new Date('2026-06-09T00:00:00.000Z');
    prisma.$queryRaw.mockResolvedValueOnce([{
      id: 'order-1',
      trackingToken: 'track-abc',
      status: 'CREATING_PAYMENT',
      paymentHandler: 'LOCAL_WORKER',
      redemptionCodeId: 'code-1',
      pixCode: null,
      pixImageUrl: null,
      createdAt,
      generationQueuedAt: createdAt,
    }]);

    await expectJson(
      '/api/orders',
      202,
      expect.objectContaining({
        trackingToken: 'track-abc',
        status: 'CREATING_PAYMENT',
        paymentHandler: 'LOCAL_WORKER',
      }),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redemptionCode: 'CODE-001',
          session: 'session-token-with-enough-length',
        }),
      },
    );

    expect(enqueuePixGenerationJob).toHaveBeenCalledWith({ orderId: 'order-1' });
  });

  it('rejects invalid public order submissions before reserving a code', async () => {
    await expectJson(
      '/api/orders',
      400,
      { error: 'Invalid input: redemptionCode and session are required' },
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redemptionCode: '', session: 'short' }),
      },
    );

    expect(enqueuePixGenerationJob).not.toHaveBeenCalled();
  });

  it('tracks public order state through HTTP without exposing worker-only fields', async () => {
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'order-1',
      trackingToken: 'track-abc',
      status: 'PENDING_PAYMENT',
      paymentHandler: 'LOCAL_WORKER',
      pixCode: '000201pix-code',
      pixQrPng: Buffer.from('png'),
      pixExpiresAt: new Date('2026-06-09T01:00:00.000Z'),
      pixImageUrl: null,
      completedAt: null,
      createdAt: new Date('2026-06-09T00:00:00.000Z'),
      generationErrorCode: null,
      errorMessage: null,
    });

    await expectJson('/api/orders/track/track-abc', 200, expect.objectContaining({
      trackingToken: 'track-abc',
      status: 'PENDING_PAYMENT',
      paymentHandler: 'LOCAL_WORKER',
      pixCode: '000201pix-code',
      pixQrPngBase64: Buffer.from('png').toString('base64'),
    }));
  });

  it('returns available worker orders through HTTP with clamped pagination', async () => {
    const createdAt = new Date('2026-06-09T00:00:00.000Z');
    prisma.user.findUnique.mockResolvedValueOnce(workerAuthRecord());
    prisma.order.findMany.mockResolvedValueOnce([{
      id: 'order-1',
      trackingToken: 'track-worker',
      status: 'PENDING_PAYMENT',
      pixCode: '000201worker-pix',
      pixQrPng: Buffer.from('worker-png'),
      pixExpiresAt: new Date('2026-06-09T01:00:00.000Z'),
      pixImageUrl: null,
      createdAt,
      claimedById: null,
      claimedAt: null,
      claimExpiresAt: null,
    }]);
    prisma.order.count.mockResolvedValueOnce(1);

    await expectJson(
      '/api/worker/orders/available?page=0&limit=999',
      200,
      {
        total: 1,
        page: 1,
        limit: 100,
        orders: [expect.objectContaining({
          id: 'order-1',
          trackingToken: 'track-worker',
          pixQrPngBase64: Buffer.from('worker-png').toString('base64'),
        })],
      },
      { headers: workerHeaders() },
    );

    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'PENDING_PAYMENT',
        paymentHandler: 'LOCAL_WORKER',
      }),
      skip: 0,
      take: 100,
    }));
  });

  it('returns only the current worker claimed orders through HTTP', async () => {
    const createdAt = new Date('2026-06-09T00:00:00.000Z');
    const claimedAt = new Date('2026-06-09T00:05:00.000Z');
    const claimExpiresAt = new Date('2026-06-09T00:35:00.000Z');
    prisma.user.findUnique.mockResolvedValueOnce(workerAuthRecord());
    prisma.order.findMany.mockResolvedValueOnce([{
      id: 'order-1',
      trackingToken: 'track-mine',
      status: 'PENDING_PAYMENT',
      pixCode: '000201claimed-pix',
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: null,
      createdAt,
      claimedById: 'worker-1',
      claimedAt,
      claimExpiresAt,
    }]);
    prisma.order.count.mockResolvedValueOnce(1);

    await expectJson(
      '/api/worker/orders/mine?page=2&limit=5',
      200,
      {
        total: 1,
        page: 2,
        limit: 5,
        orders: [expect.objectContaining({
          id: 'order-1',
          claimedById: 'worker-1',
          claimedAt: claimedAt.toISOString(),
          claimExpiresAt: claimExpiresAt.toISOString(),
        })],
      },
      { headers: workerHeaders() },
    );

    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'PENDING_PAYMENT',
        paymentHandler: 'LOCAL_WORKER',
        claimedById: 'worker-1',
      }),
      skip: 5,
      take: 5,
    }));
  });

  it('returns current worker summary counts through HTTP', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(workerAuthRecord());
    prisma.order.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);

    await expectJson(
      '/api/worker/summary',
      200,
      {
        completedTotal: 10,
        completedToday: 2,
        completedThisWeek: 5,
        claimedCount: 1,
        availableCount: 3,
      },
      { headers: workerHeaders() },
    );

    expect(prisma.order.count).toHaveBeenCalledTimes(5);
    expect(prisma.order.count).toHaveBeenNthCalledWith(1, {
      where: { status: 'PAYMENT_COMPLETED', completedById: 'worker-1' },
    });
  });

  it('claims a worker order batch through HTTP', async () => {
    const claimedAt = new Date('2026-06-09T00:05:00.000Z');
    const claimExpiresAt = new Date('2026-06-09T00:35:00.000Z');
    prisma.user.findUnique.mockResolvedValueOnce(workerAuthRecord());
    prisma.$queryRaw.mockResolvedValueOnce([{
      id: 'order-1',
      trackingToken: 'track-claim',
      status: 'PENDING_PAYMENT',
      pixCode: '000201claim-pix',
      pixQrPng: null,
      pixExpiresAt: null,
      pixImageUrl: null,
      createdAt: new Date('2026-06-09T00:00:00.000Z'),
      claimedById: 'worker-1',
      claimedAt,
      claimExpiresAt,
    }]);

    await expectJson(
      '/api/worker/orders/claim-batch',
      200,
      {
        claimedCount: 1,
        orders: [expect.objectContaining({
          id: 'order-1',
          claimedById: 'worker-1',
          claimExpiresAt: claimExpiresAt.toISOString(),
        })],
      },
      { method: 'POST', headers: workerHeaders() },
    );

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('renews and releases a worker claim through HTTP', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(workerAuthRecord())
      .mockResolvedValueOnce(workerAuthRecord());
    prisma.order.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await expectJson(
      '/api/worker/orders/order-1/renew',
      200,
      { id: 'order-1', claimExpiresAt: expect.any(String) },
      { method: 'POST', headers: workerHeaders() },
    );
    await expectJson(
      '/api/worker/orders/order-1/release',
      200,
      { id: 'order-1', released: true },
      { method: 'POST', headers: workerHeaders() },
    );

    expect(prisma.order.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: 'order-1', claimedById: 'worker-1' }),
      data: { claimExpiresAt: expect.any(Date) },
    }));
    expect(prisma.order.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ id: 'order-1', claimedById: 'worker-1' }),
      data: { claimedById: null, claimedAt: null, claimExpiresAt: null },
    }));
  });

  it('returns conflict when the worker renews an order it does not own', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(workerAuthRecord());
    prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

    await expectJson(
      '/api/worker/orders/order-1/renew',
      409,
      { error: 'Order is not claimed by current worker' },
      { method: 'POST', headers: workerHeaders() },
    );
  });

  it('completes the current worker claimed order through HTTP', async () => {
    const completedAt = new Date('2026-06-09T00:10:00.000Z');
    const completedOrder = {
      id: 'order-1',
      trackingToken: 'track-complete',
      status: 'PAYMENT_COMPLETED',
      completedAt,
      completedById: 'worker-1',
    };
    prisma.user.findUnique.mockResolvedValueOnce(workerAuthRecord());
    prisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.order.findUnique.mockResolvedValueOnce(completedOrder);

    await expectJson(
      '/api/worker/orders/order-1/complete',
      200,
      {
        id: 'order-1',
        status: 'PAYMENT_COMPLETED',
        completedAt: completedAt.toISOString(),
        completedById: 'worker-1',
      },
      { method: 'POST', headers: workerHeaders() },
    );

    expect(prisma.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'order-1', claimedById: 'worker-1' }),
      data: expect.objectContaining({
        status: 'PAYMENT_COMPLETED',
        completedById: 'worker-1',
      }),
    }));
    expect(broadcastOrderStatusChange).toHaveBeenCalledWith(completedOrder);
  });

  it('does not broadcast when the worker completes an order it does not own', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(workerAuthRecord());
    prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'order-1',
      status: 'PENDING_PAYMENT',
    });

    await expectJson(
      '/api/worker/orders/order-1/complete',
      409,
      { error: 'Order is not claimed by current worker' },
      { method: 'POST', headers: workerHeaders() },
    );

    expect(broadcastOrderStatusChange).not.toHaveBeenCalled();
  });

  it('passes parsed admin order filters from HTTP query to Prisma', async () => {
    const createdAt = new Date('2026-06-09T00:00:00.000Z');
    prisma.order.findMany.mockResolvedValueOnce([{
      id: 'order-1',
      trackingToken: 'track-abc',
      status: 'PENDING_PAYMENT',
      paymentHandler: 'OUTSOURCED_BUYER_API',
      checkoutSessionId: 'cs_test_123',
      outsourcedTicketId: 'Toutsource123',
      outsourcedPaymentStatus: 'authorizing',
      outsourcedLastError: null,
      errorMessage: null,
      generationErrorCode: null,
      generationErrorStage: null,
      generationErrorDetail: null,
      generationErrorHttpStatus: null,
      claimedBy: null,
      completedBy: null,
      completedAt: null,
      createdAt,
    }]);
    prisma.order.count.mockResolvedValueOnce(1);

    await expectJson(
      '/api/admin/orders?page=2&limit=20&status=PENDING_PAYMENT&paymentHandler=OUTSOURCED_BUYER_API&trackingToken=track',
      200,
      expect.objectContaining({
        total: 1,
        page: 2,
        limit: 20,
        orders: [expect.objectContaining({
          trackingToken: 'track-abc',
          paymentHandler: 'OUTSOURCED_BUYER_API',
        })],
      }),
      { headers: adminHeaders() },
    );

    const expectedWhere = {
      status: 'PENDING_PAYMENT',
      paymentHandler: 'OUTSOURCED_BUYER_API',
      trackingToken: { contains: 'track', mode: 'insensitive' },
    };
    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expectedWhere,
      skip: 20,
      take: 20,
    }));
    expect(prisma.order.count).toHaveBeenCalledWith({ where: expectedWhere });
  });

  it('passes parsed admin worker filters from HTTP query to Prisma', async () => {
    const createdAt = new Date('2026-06-09T00:00:00.000Z');
    prisma.user.findMany.mockResolvedValueOnce([{
      id: 'worker-1',
      username: 'alpha-worker',
      displayName: '张三',
      enabled: true,
      deletedAt: null,
      createdAt,
    }]);
    prisma.user.count.mockResolvedValueOnce(1);
    prisma.order.count
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1);
    prisma.order.findFirst.mockResolvedValueOnce({ completedAt: createdAt });

    await expectJson(
      '/api/admin/workers?page=2&limit=20&status=enabled&search=%E5%BC%A0%E4%B8%89',
      200,
      {
        total: 1,
        page: 2,
        limit: 20,
        workers: [expect.objectContaining({
          id: 'worker-1',
          username: 'alpha-worker',
          completedTotal: 7,
          claimedCount: 1,
        })],
      },
      { headers: adminHeaders() },
    );

    const expectedWhere = {
      role: 'WORKER',
      deletedAt: null,
      enabled: true,
      OR: [
        { username: { contains: '张三', mode: 'insensitive' } },
        { displayName: { contains: '张三', mode: 'insensitive' } },
      ],
    };
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      orderBy: { createdAt: 'desc' },
      skip: 20,
      take: 20,
    });
    expect(prisma.user.count).toHaveBeenCalledWith({ where: expectedWhere });
  });

  it('bulk archives and deletes unused outsourced activation codes through HTTP filters', async () => {
    prisma.outsourcedActivationCode.updateMany.mockResolvedValueOnce({ count: 2 });
    prisma.outsourcedActivationCode.deleteMany.mockResolvedValueOnce({ count: 1 });

    const requestBody = {
      status: 'available',
      archiveScope: 'active',
      batchLabel: 'batch-001',
      search: 'DP-F',
    };

    await expectJson(
      '/api/admin/outsourced-activation-codes/archive',
      200,
      { archivedCount: 2 },
      {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      },
    );
    await expectJson(
      '/api/admin/outsourced-activation-codes/delete-unused',
      200,
      { deletedCount: 1 },
      {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      },
    );

    expect(prisma.outsourcedActivationCode.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ AND: expect.any(Array) }),
      data: { archivedAt: expect.any(Date) },
    }));
    expect(prisma.outsourcedActivationCode.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ AND: expect.any(Array) }),
    }));
    const deleteWhere = prisma.outsourcedActivationCode.deleteMany.mock.calls[0][0].where;
    expect(JSON.stringify(deleteWhere)).toContain('"localSubmitCount":0');
    expect(JSON.stringify(deleteWhere)).toContain('"orders":{"none":{}}');
  });

  it('bulk deletes unused local redemption codes through HTTP filters', async () => {
    prisma.redemptionCode.deleteMany.mockResolvedValueOnce({ count: 3 });

    await expectJson(
      '/api/admin/redemption-codes/delete-unused',
      200,
      { deletedCount: 3 },
      {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'all',
          archiveScope: 'active',
          batchLabel: 'batch-001',
          search: 'ABCD',
        }),
      },
    );

    expect(prisma.redemptionCode.deleteMany).toHaveBeenCalledWith({
      where: {
        AND: [
          {
            archivedAt: null,
            batchLabel: 'batch-001',
            OR: [
              { code: { contains: 'ABCD', mode: 'insensitive' } },
              { batchLabel: { contains: 'ABCD', mode: 'insensitive' } },
            ],
          },
          { usedAt: null },
        ],
      },
    });
  });

  it('blocks cancellation of outsourced pending orders after ticket submission through HTTP', async () => {
    prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'order-1',
      status: 'PENDING_PAYMENT',
      paymentHandler: 'OUTSOURCED_BUYER_API',
      outsourcedTicketId: 'Toutsource123',
    });

    await expectJson(
      '/api/admin/orders/order-1',
      409,
      {
        error: '已有外包票据的订单不能直接取消，请等待外包支付返回终态后再处理',
        code: 'OUTSOURCED_ORDER_CANCEL_BLOCKED',
      },
      {
        method: 'PATCH',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'CANCELLED' }),
      },
    );

    expect(broadcastOrderStatusChange).not.toHaveBeenCalled();
  });

  async function expectJson(
    path: string,
    status: number,
    expectedBody: unknown,
    init: RequestInit = {},
  ) {
    const response = await fetch(`${baseUrl}${path}`, init);
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(expectedBody);
  }

  function adminHeaders(): Record<string, string> {
    const token = jwt.sign({ sub: 'admin-1', role: 'ADMIN' }, config.jwtSecret, { expiresIn: '1h' });
    return { Authorization: `Bearer ${token}` };
  }

  function workerHeaders(): Record<string, string> {
    const token = jwt.sign({ sub: 'worker-1', role: 'WORKER' }, config.jwtSecret, { expiresIn: '1h' });
    return { Authorization: `Bearer ${token}` };
  }

  function workerAuthRecord() {
    return {
      id: 'worker-1',
      role: 'WORKER',
      enabled: true,
      deletedAt: null,
    };
  }
});
