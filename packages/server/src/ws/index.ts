import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config.ts';
import type { JwtPayload } from '../middleware/auth.ts';
import type { Order } from '@prisma/client';
import { prisma } from '../db.ts';
import {
  publishOrderRealtimeEvent,
  subscribeOrderRealtimeEvents,
  type OrderRealtimeEvent,
} from '../services/order-realtime.service.ts';

let io: Server | undefined;

export function setupWebSocket(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
  });

  const ordersNs = io.of('/orders');
  ordersNs.on('connection', (socket) => {
    let joinedRooms = 0;
    socket.on('join', (data: { trackingToken: string }) => {
      if (joinedRooms >= 5) return;
      if (/^[A-Za-z0-9_-]{8,64}$/.test(data.trackingToken)) {
        joinedRooms += 1;
        socket.join(`order:${data.trackingToken}`);
      }
    });
  });

  const workerNs = io.of('/worker');
  workerNs.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string;
      const user = await verifySocketUser(token);
      if (user.role !== 'WORKER' && user.role !== 'ADMIN') {
        return next(new Error('Insufficient permissions'));
      }
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });
  workerNs.on('connection', (socket) => {
    socket.join(`worker:${socket.data.user.sub}`);
  });

  const adminNs = io.of('/admin');
  adminNs.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string;
      const user = await verifySocketUser(token);
      if (user.role !== 'ADMIN') {
        return next(new Error('Insufficient permissions'));
      }
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  void subscribeOrderRealtimeEvents(handleOrderRealtimeEvent).catch((error) => {
    console.warn(`Order realtime subscription failed ${safeSocketErrorLog(error)}`);
  });

  return io;
}

export function broadcastOrderReady(order: Order): boolean {
  if (!io) {
    publishLater({ type: 'order_ready', orderId: order.id });
    return false;
  }

  emitOrderReady(order);
  return true;
}

export function broadcastOrderNew(order: Order): boolean {
  return broadcastOrderReady(order);
}

export function broadcastOrderStatusChange(order: Order): boolean {
  if (!io) {
    publishLater({ type: 'order_status_changed', orderId: order.id });
    return false;
  }

  emitOrderStatusChange(order);
  return true;
}

async function handleOrderRealtimeEvent(event: OrderRealtimeEvent): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: event.orderId } });
  if (!order) return;

  if (event.type === 'order_ready') {
    emitOrderReady(order);
    return;
  }

  emitOrderStatusChange(order);
}

function emitOrderReady(order: Order) {
  emitOrderNew(order);
  emitOrderStatusToCustomer(order);
}

function emitOrderNew(order: Order) {
  if (!io) return;

  const summary = {
    id: order.id,
    trackingToken: order.trackingToken,
    status: order.status,
    pixCode: order.pixCode,
    pixQrPngBase64: order.pixQrPng ? Buffer.from(order.pixQrPng).toString('base64') : null,
    pixExpiresAt: order.pixExpiresAt?.toISOString() ?? null,
    pixImageUrl: order.pixImageUrl,
    createdAt: order.createdAt.toISOString(),
  };

  io.of('/worker').emit('order:new', summary);
  io.of('/admin').emit('order:new', summary);
}

function emitOrderStatusChange(order: Order) {
  if (!io) return;

  const publicPayload = emitOrderStatusToCustomer(order);
  io.of('/worker').emit('order:completed', publicPayload);
  io.of('/admin').emit('order:completed', publicPayload);
}

function emitOrderStatusToCustomer(order: Order) {
  const publicPayload = {
    id: order.id,
    trackingToken: order.trackingToken,
    status: order.status,
    completedAt: order.completedAt?.toISOString() ?? null,
  };
  if (!io) return publicPayload;

  io.of('/orders').to(`order:${order.trackingToken}`).emit('order:status', publicPayload);
  return publicPayload;
}

function publishLater(event: OrderRealtimeEvent) {
  void publishOrderRealtimeEvent(event).catch((error) => {
    console.warn(`Order realtime publish failed order=${event.orderId} ${safeSocketErrorLog(error)}`);
  });
}

function safeSocketErrorLog(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error && error.message
    ? ` message=${error.message.replace(/\s+/g, ' ').slice(0, 160)}`
    : '';
  return `error=${name}${message}`;
}

async function verifySocketUser(token: string): Promise<JwtPayload> {
  const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, role: true, enabled: true },
  });
  if (!user?.enabled) throw new Error('Authentication failed');
  return { sub: user.id, role: user.role };
}
