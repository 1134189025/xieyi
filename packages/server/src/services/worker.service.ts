import bcrypt from 'bcrypt';
import { prisma } from '../db.ts';
import { AppError } from '../middleware/error-handler.ts';
import { getShanghaiDayRange, getShanghaiWeekRange } from '../utils/shanghai-time.ts';

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
  const shanghaiDayRange = getShanghaiDayRange(new Date());
  const shanghaiWeekRange = getShanghaiWeekRange(new Date());
  const workers = await prisma.user.findMany({
    where: { role: 'WORKER' },
    orderBy: { createdAt: 'desc' },
  });

  return Promise.all(
    workers.map(async (worker) => {
      const [completedTotal, completedToday, completedThisWeek, claimedCount, lastCompleted] = await Promise.all([
        prisma.order.count({
          where: { status: 'PAYMENT_COMPLETED', completedById: worker.id },
        }),
        prisma.order.count({
          where: {
            status: 'PAYMENT_COMPLETED',
            completedById: worker.id,
            completedAt: { gte: shanghaiDayRange.start, lt: shanghaiDayRange.end },
          },
        }),
        prisma.order.count({
          where: {
            status: 'PAYMENT_COMPLETED',
            completedById: worker.id,
            completedAt: { gte: shanghaiWeekRange.start, lt: shanghaiWeekRange.end },
          },
        }),
        prisma.order.count({
          where: {
            status: 'PENDING_PAYMENT',
            claimedById: worker.id,
            claimExpiresAt: { gt: new Date() },
          },
        }),
        prisma.order.findFirst({
          where: { status: 'PAYMENT_COMPLETED', completedById: worker.id },
          orderBy: { completedAt: 'desc' },
          select: { completedAt: true },
        }),
      ]);

      return {
        id: worker.id,
        username: worker.username,
        displayName: worker.displayName,
        enabled: worker.enabled,
        completedTotal,
        completedToday,
        completedThisWeek,
        claimedCount,
        lastCompletedAt: lastCompleted?.completedAt?.toISOString() ?? null,
        createdAt: worker.createdAt.toISOString(),
      };
    }),
  );
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
