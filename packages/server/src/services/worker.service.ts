import bcrypt from 'bcrypt';
import { prisma } from '../db.ts';
import { AppError } from '../middleware/error-handler.ts';
import { getShanghaiDayRange, getShanghaiWeekRange } from '../utils/shanghai-time.ts';

type WorkerAccountUpdate = {
  enabled?: boolean;
  password?: string;
  displayName?: string;
};

export async function createWorkerAccount(username: string, password: string, displayName?: string) {
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
    deletedAt: worker.deletedAt?.toISOString() ?? null,
    createdAt: worker.createdAt.toISOString(),
  };
}

export async function listWorkerAccountsForManagement() {
  const shanghaiDayRange = getShanghaiDayRange(new Date());
  const shanghaiWeekRange = getShanghaiWeekRange(new Date());
  const workers = await prisma.user.findMany({
    where: { role: 'WORKER', deletedAt: null },
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
        worker.enabled
          ? prisma.order.count({
            where: {
              status: 'PENDING_PAYMENT',
              paymentHandler: 'LOCAL_WORKER',
              claimedById: worker.id,
              claimExpiresAt: { gt: new Date() },
            } as never,
          })
          : Promise.resolve(0),
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
        deletedAt: worker.deletedAt?.toISOString() ?? null,
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

export async function updateWorkerAccount(workerId: string, data: WorkerAccountUpdate) {
  await requireEditableWorkerAccount(workerId);

  const updateData: Record<string, unknown> = {};
  if (data.enabled !== undefined) updateData.enabled = data.enabled;
  if (data.displayName !== undefined) updateData.displayName = data.displayName;
  if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 10);

  const updated = await prisma.$transaction(async (client) => {
    const worker = await client.user.update({ where: { id: workerId }, data: updateData });
    if (data.enabled === false) await releaseActiveWorkerClaims(client, workerId);
    return worker;
  });

  return {
    id: updated.id,
    username: updated.username,
    displayName: updated.displayName,
    enabled: updated.enabled,
    deletedAt: updated.deletedAt?.toISOString() ?? null,
  };
}

export async function archiveWorkerAccount(workerId: string) {
  await requireEditableWorkerAccount(workerId);

  const updated = await prisma.$transaction(async (client) => {
    const worker = await client.user.update({
      where: { id: workerId },
      data: { enabled: false, deletedAt: new Date() },
    });
    await releaseActiveWorkerClaims(client, workerId);
    return worker;
  });

  return {
    id: updated.id,
    username: updated.username,
    displayName: updated.displayName,
    enabled: updated.enabled,
    deletedAt: updated.deletedAt?.toISOString() ?? null,
  };
}

async function requireEditableWorkerAccount(workerId: string) {
  const worker = await prisma.user.findUnique({ where: { id: workerId } });
  if (!worker || worker.role !== 'WORKER' || worker.deletedAt) throw new AppError(404, 'Worker not found');
}

async function releaseActiveWorkerClaims(client: Pick<typeof prisma, 'order'>, workerId: string) {
  await client.order.updateMany({
    where: {
      status: 'PENDING_PAYMENT',
      paymentHandler: 'LOCAL_WORKER',
      claimedById: workerId,
      claimExpiresAt: { gt: new Date() },
    } as never,
    data: {
      claimedById: null,
      claimedAt: null,
      claimExpiresAt: null,
    },
  });
}
