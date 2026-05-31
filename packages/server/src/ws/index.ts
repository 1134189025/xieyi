import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config.ts';
import type { JwtPayload } from '../middleware/auth.ts';
import type { Order } from '@prisma/client';

let io: Server;

export function setupWebSocket(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
  });

  const ordersNs = io.of('/orders');
  ordersNs.on('connection', (socket) => {
    socket.on('join', (data: { trackingToken: string }) => {
      if (data.trackingToken) {
        socket.join(`order:${data.trackingToken}`);
      }
    });
  });

  const workerNs = io.of('/worker');
  workerNs.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string;
      const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
      if (payload.role !== 'WORKER' && payload.role !== 'ADMIN') {
        return next(new Error('Insufficient permissions'));
      }
      socket.data.user = payload;
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  const adminNs = io.of('/admin');
  adminNs.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string;
      const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
      if (payload.role !== 'ADMIN') {
        return next(new Error('Insufficient permissions'));
      }
      socket.data.user = payload;
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  return io;
}

export function broadcastOrderNew(order: Order) {
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

export function broadcastOrderStatusChange(order: Order) {
  if (!io) return;

  const payload = {
    id: order.id,
    trackingToken: order.trackingToken,
    status: order.status,
    completedAt: order.completedAt?.toISOString() ?? null,
  };

  io.of('/orders').to(`order:${order.trackingToken}`).emit('order:status', payload);
  io.of('/worker').emit('order:completed', payload);
  io.of('/admin').emit('order:completed', payload);
}
