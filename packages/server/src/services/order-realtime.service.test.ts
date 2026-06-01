import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = vi.hoisted(() => {
  const clients: Array<{
    publish: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    handlers: Record<string, (...args: string[]) => void>;
  }> = [];

  const RedisClient = vi.fn(function MockRedisClient(this: {
    publish: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    handlers: Record<string, (...args: string[]) => void>;
  }) {
    this.handlers = {};
    this.publish = vi.fn().mockResolvedValue(1);
    this.subscribe = vi.fn().mockResolvedValue(1);
    this.on = vi.fn((event: string, handler: (...args: string[]) => void) => {
      this.handlers[event] = handler;
      return this;
    });
    clients.push(this);
  });

  return { clients, RedisClient };
});

vi.mock('ioredis', () => ({ Redis: redisMock.RedisClient }));
vi.mock('../config.ts', () => ({
  config: {
    redisUrl: 'redis://127.0.0.1:6379',
  },
}));

async function loadRealtimeService() {
  vi.resetModules();
  redisMock.clients.length = 0;
  return import('./order-realtime.service.ts');
}

describe('order-realtime.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes order realtime events without Pix payload data', async () => {
    const { ORDER_REALTIME_CHANNEL, publishOrderRealtimeEvent } = await loadRealtimeService();

    await publishOrderRealtimeEvent({ type: 'order_ready', orderId: 'order-1' });

    expect(redisMock.RedisClient).toHaveBeenCalledWith(
      'redis://127.0.0.1:6379',
      expect.objectContaining({ enableReadyCheck: false, maxRetriesPerRequest: null }),
    );
    expect(redisMock.clients[0].publish).toHaveBeenCalledWith(
      ORDER_REALTIME_CHANNEL,
      JSON.stringify({ type: 'order_ready', orderId: 'order-1' }),
    );
  });

  it('subscribes and forwards only valid order realtime events', async () => {
    const { ORDER_REALTIME_CHANNEL, subscribeOrderRealtimeEvents } = await loadRealtimeService();
    const onEvent = vi.fn().mockResolvedValue(undefined);

    await subscribeOrderRealtimeEvents(onEvent);

    const subscriber = redisMock.clients[0];
    expect(subscriber.subscribe).toHaveBeenCalledWith(ORDER_REALTIME_CHANNEL);

    subscriber.handlers.message?.(ORDER_REALTIME_CHANNEL, JSON.stringify({ type: 'order_status_changed', orderId: 'order-1' }));
    subscriber.handlers.message?.(ORDER_REALTIME_CHANNEL, JSON.stringify({ type: 'bad_type', orderId: 'order-2' }));
    subscriber.handlers.message?.('other-channel', JSON.stringify({ type: 'order_ready', orderId: 'order-3' }));
    subscriber.handlers.message?.(ORDER_REALTIME_CHANNEL, 'not json');
    await Promise.resolve();

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'order_status_changed', orderId: 'order-1' });
  });
});
