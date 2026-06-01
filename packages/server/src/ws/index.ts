import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config.ts';
import type { JwtPayload } from '../middleware/auth.ts';
import type { Order } from '@prisma/client';
import { prisma } from '../db.ts';

let io: Server;

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

  const publicPayload = {
    id: order.id,
    trackingToken: order.trackingToken,
    status: order.status,
    completedAt: order.completedAt?.toISOString() ?? null,
  };

  io.of('/orders').to(`order:${order.trackingToken}`).emit('order:status', publicPayload);
  io.of('/worker').emit('order:completed', publicPayload);
  io.of('/admin').emit('order:completed', publicPayload);
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
