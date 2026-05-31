import bcrypt from 'bcrypt';
import { prisma } from '../db.ts';
import { AppError } from '../middleware/error-handler.ts';

export async function createWorker(username: string, password: string, displayName?: string) {
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) throw new AppError(409, 'Username already exists');

  const passwordHash = await bcrypt.hash(password, 10);
  const worker = await prisma.user.create({
    data: { username, passwordHash, role: 'WORKER', displayName },
  });

  return {
    id: worker.id,
    username: worker.username,
    displayName: worker.displayName,
    role: worker.role,
    enabled: worker.enabled,
    createdAt: worker.createdAt.toISOString(),
  };
}

export async function listWorkers() {
  const workers = await prisma.user.findMany({
    where: { role: 'WORKER' },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { completedOrders: true } } },
  });

  return workers.map((w) => ({
    id: w.id,
    username: w.username,
    displayName: w.displayName,
    enabled: w.enabled,
    createdAt: w.createdAt.toISOString(),
    completedOrderCount: w._count.completedOrders,
  }));
}

export async function updateWorker(
  workerId: string,
  data: { enabled?: boolean; password?: string; displayName?: string },
) {
  const worker = await prisma.user.findUnique({ where: { id: workerId } });
  if (!worker || worker.role !== 'WORKER') throw new AppError(404, 'Worker not found');

  const updateData: Record<string, unknown> = {};
  if (data.enabled !== undefined) updateData.enabled = data.enabled;
  if (data.displayName !== undefined) updateData.displayName = data.displayName;
  if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 10);

  const updated = await prisma.user.update({ where: { id: workerId }, data: updateData });
  return {
    id: updated.id,
    username: updated.username,
    displayName: updated.displayName,
    enabled: updated.enabled,
  };
}

export async function deleteWorker(workerId: string) {
  const worker = await prisma.user.findUnique({ where: { id: workerId } });
  if (!worker || worker.role !== 'WORKER') throw new AppError(404, 'Worker not found');

  await prisma.user.update({ where: { id: workerId }, data: { enabled: false } });
}
