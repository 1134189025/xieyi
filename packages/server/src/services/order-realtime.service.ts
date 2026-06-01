import { Redis } from 'ioredis';
import { config } from '../config.ts';

export const ORDER_REALTIME_CHANNEL = 'pix-order-realtime';

export type OrderRealtimeEventType = 'order_ready' | 'order_status_changed';

export interface OrderRealtimeEvent {
  type: OrderRealtimeEventType;
  orderId: string;
}

let publisher: Redis | null = null;
let subscriber: Redis | null = null;
let subscribed = false;

export async function publishOrderRealtimeEvent(event: OrderRealtimeEvent): Promise<void> {
  await getPublisher().publish(ORDER_REALTIME_CHANNEL, JSON.stringify(event));
}

export async function subscribeOrderRealtimeEvents(
  onEvent: (event: OrderRealtimeEvent) => Promise<void>,
): Promise<void> {
  if (subscribed) return;

  const redisSubscriber = getSubscriber();
  redisSubscriber.on('message', (channel: string, message: string) => {
    if (channel !== ORDER_REALTIME_CHANNEL) return;

    const event = parseOrderRealtimeEvent(message);
    if (!event) return;

    void onEvent(event).catch((error) => {
      console.warn(`Order realtime event failed ${safeRealtimeErrorLog(error)}`);
    });
  });
  await redisSubscriber.subscribe(ORDER_REALTIME_CHANNEL);
  subscribed = true;
}

function getPublisher(): Redis {
  if (!publisher) {
    publisher = createRedisClient();
  }
  return publisher;
}

function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = createRedisClient();
  }
  return subscriber;
}

function createRedisClient(): Redis {
  return new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

function parseOrderRealtimeEvent(message: string): OrderRealtimeEvent | null {
  try {
    const parsed = JSON.parse(message) as Partial<OrderRealtimeEvent>;
    if (!isOrderRealtimeEventType(parsed.type)) return null;
    if (typeof parsed.orderId !== 'string' || parsed.orderId.length === 0) return null;
    return { type: parsed.type, orderId: parsed.orderId };
  } catch {
    return null;
  }
}

function isOrderRealtimeEventType(type: unknown): type is OrderRealtimeEventType {
  return type === 'order_ready' || type === 'order_status_changed';
}

function safeRealtimeErrorLog(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error && error.message
    ? ` message=${error.message.replace(/\s+/g, ' ').slice(0, 160)}`
    : '';
  return `error=${name}${message}`;
}
