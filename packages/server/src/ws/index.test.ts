import { beforeEach, describe, expect, it, vi } from 'vitest';

const socketIoMock = vi.hoisted(() => {
  const namespaces = new Map<string, {
    emit: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    to: ReturnType<typeof vi.fn>;
    toEmit: ReturnType<typeof vi.fn>;
    use: ReturnType<typeof vi.fn>;
  }>();

  function namespace(name: string) {
    const existing = namespaces.get(name);
    if (existing) return existing;

    const toEmit = vi.fn();
    const nextNamespace = {
      emit: vi.fn(),
      on: vi.fn(),
      to: vi.fn(() => ({ emit: toEmit })),
      toEmit,
      use: vi.fn(),
    };
    namespaces.set(name, nextNamespace);
    return nextNamespace;
  }

  const ServerMock = vi.fn(function MockServer(this: { of: ReturnType<typeof vi.fn> }) {
    this.of = vi.fn(namespace);
  });

  return { namespaces, ServerMock };
});

const realtimeMock = vi.hoisted(() => ({
  publishOrderRealtimeEvent: vi.fn().mockResolvedValue(undefined),
  subscribeOrderRealtimeEvents: vi.fn().mockResolvedValue(undefined),
}));

const prisma = vi.hoisted(() => ({
  order: {
    findUnique: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
}));

vi.mock('socket.io', () => ({ Server: socketIoMock.ServerMock }));
vi.mock('../services/order-realtime.service.ts', () => realtimeMock);
vi.mock('../db.ts', () => ({ prisma }));
vi.mock('../config.ts', () => ({
  config: {
    corsOrigin: 'http://localhost:5173',
    jwtSecret: 'test-secret',
  },
}));

function pendingOrder() {
  return {
    id: 'order-1',
    trackingToken: 'track-1',
    status: 'PENDING_PAYMENT',
    pixCode: 'pix-code',
    pixQrPng: Buffer.from('png'),
    pixExpiresAt: new Date('2026-06-01T01:00:00.000Z'),
    pixImageUrl: 'https://stripe.test/pix.png',
    completedAt: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
  };
}

async function loadWsModule() {
  vi.resetModules();
  socketIoMock.namespaces.clear();
  return import('./index.ts');
}

describe('ws order realtime bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.order.findUnique.mockReset();
    realtimeMock.publishOrderRealtimeEvent.mockResolvedValue(undefined);
    realtimeMock.subscribeOrderRealtimeEvents.mockResolvedValue(undefined);
  });

  it('publishes an order_ready event when a worker process has no Socket.IO instance', async () => {
    const { broadcastOrderReady } = await loadWsModule();

    const emittedLocally = broadcastOrderReady(pendingOrder() as never);

    expect(emittedLocally).toBe(false);
    expect(realtimeMock.publishOrderRealtimeEvent).toHaveBeenCalledWith({
      type: 'order_ready',
      orderId: 'order-1',
    });
  });

  it('forwards order_ready Redis events to customers and workers from the API process', async () => {
    const { setupWebSocket } = await loadWsModule();
    prisma.order.findUnique.mockResolvedValue(pendingOrder());

    setupWebSocket({} as never);
    const handler = realtimeMock.subscribeOrderRealtimeEvents.mock.calls[0]?.[0];
    await handler({ type: 'order_ready', orderId: 'order-1' });

    const ordersNamespace = socketIoMock.namespaces.get('/orders');
    const workerNamespace = socketIoMock.namespaces.get('/worker');

    expect(prisma.order.findUnique).toHaveBeenCalledWith({ where: { id: 'order-1' } });
    expect(ordersNamespace?.to).toHaveBeenCalledWith('order:track-1');
    expect(ordersNamespace?.toEmit).toHaveBeenCalledWith(
      'order:status',
      expect.objectContaining({ id: 'order-1', trackingToken: 'track-1', status: 'PENDING_PAYMENT' }),
    );
    expect(workerNamespace?.emit).toHaveBeenCalledWith(
      'order:new',
      expect.objectContaining({
        id: 'order-1',
        trackingToken: 'track-1',
        status: 'PENDING_PAYMENT',
        pixCode: 'pix-code',
        pixQrPngBase64: Buffer.from('png').toString('base64'),
      }),
    );
    expect(workerNamespace?.emit).not.toHaveBeenCalledWith('order:completed', expect.anything());
  });

  it('publishes status changes when a worker process cannot emit locally', async () => {
    const { broadcastOrderStatusChange } = await loadWsModule();
    const failedOrder = { ...pendingOrder(), status: 'FAILED' };

    const emittedLocally = broadcastOrderStatusChange(failedOrder as never);

    expect(emittedLocally).toBe(false);
    expect(realtimeMock.publishOrderRealtimeEvent).toHaveBeenCalledWith({
      type: 'order_status_changed',
      orderId: 'order-1',
    });
  });

  it('forwards order_status_changed Redis events to customers and completion listeners from the API process', async () => {
    const { setupWebSocket } = await loadWsModule();
    prisma.order.findUnique.mockResolvedValue({ ...pendingOrder(), status: 'PAYMENT_COMPLETED' });

    setupWebSocket({} as never);
    const handler = realtimeMock.subscribeOrderRealtimeEvents.mock.calls[0]?.[0];
    await handler({ type: 'order_status_changed', orderId: 'order-1' });

    const ordersNamespace = socketIoMock.namespaces.get('/orders');
    const workerNamespace = socketIoMock.namespaces.get('/worker');
    const adminNamespace = socketIoMock.namespaces.get('/admin');

    expect(ordersNamespace?.to).toHaveBeenCalledWith('order:track-1');
    expect(ordersNamespace?.toEmit).toHaveBeenCalledWith(
      'order:status',
      expect.objectContaining({ id: 'order-1', trackingToken: 'track-1', status: 'PAYMENT_COMPLETED' }),
    );
    expect(workerNamespace?.emit).toHaveBeenCalledWith(
      'order:completed',
      expect.objectContaining({ id: 'order-1', trackingToken: 'track-1', status: 'PAYMENT_COMPLETED' }),
    );
    expect(adminNamespace?.emit).toHaveBeenCalledWith(
      'order:completed',
      expect.objectContaining({ id: 'order-1', trackingToken: 'track-1', status: 'PAYMENT_COMPLETED' }),
    );
  });
});
