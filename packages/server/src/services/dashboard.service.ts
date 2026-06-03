import { prisma } from '../db.ts';
import { getShanghaiDayRange, getShanghaiWeekRange } from '../utils/shanghai-time.ts';
import { getPixGenerationQueueMetrics } from '../queues/pix-generation.queue.ts';
import { getProxyPoolHealthSummary } from './settings.service.ts';
import { config } from '../config.ts';
import { listWorkers } from './worker.service.ts';

export async function getDashboardStats() {
  const shanghaiDayRange = getShanghaiDayRange(new Date());
  const shanghaiWeekRange = getShanghaiWeekRange(new Date());
  const [
    totalOrders,
    pendingOrders,
    completedTotal,
    completedToday,
    completedThisWeek,
    failedOrders,
    cancelledOrders,
    expiredOrders,
    generationCompletedLastHour,
    generationFailedLastHour,
    totalCodes,
    unusedCodes,
    queueMetrics,
    proxyHealth,
    workerPerformance,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({ where: { status: 'PENDING_PAYMENT' } }),
    prisma.order.count({ where: { status: 'PAYMENT_COMPLETED' } }),
    prisma.order.count({
      where: {
        status: 'PAYMENT_COMPLETED',
        completedAt: {
          gte: shanghaiDayRange.start,
          lt: shanghaiDayRange.end,
        },
      },
    }),
    prisma.order.count({
      where: {
        status: 'PAYMENT_COMPLETED',
        completedAt: {
          gte: shanghaiWeekRange.start,
          lt: shanghaiWeekRange.end,
        },
      },
    }),
    prisma.order.count({ where: { status: 'FAILED' } }),
    prisma.order.count({ where: { status: 'CANCELLED' } }),
    prisma.order.count({ where: { status: 'EXPIRED' } }),
    prisma.order.count({
      where: {
        status: 'PENDING_PAYMENT',
        generationFinishedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
    }),
    prisma.order.count({
      where: {
        status: 'FAILED',
        generationFinishedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
    }),
    prisma.redemptionCode.count(),
    prisma.redemptionCode.count({ where: { usedAt: null } }),
    getPixGenerationQueueMetrics(),
    getProxyPoolHealthSummary(),
    getWorkerPerformanceStats(shanghaiDayRange, shanghaiWeekRange),
  ]);

  const dailyTrend = await prisma.$queryRaw<
    Array<{ date: string; created: bigint; completed: bigint; failed: bigint }>
  >`
    SELECT
      DATE(created_at) as date,
      COUNT(*) as created,
      COUNT(*) FILTER (WHERE status = 'PAYMENT_COMPLETED') as completed,
      COUNT(*) FILTER (WHERE status = 'FAILED') as failed
    FROM orders
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `;
  const [generationAverage] = await prisma.$queryRaw<Array<{ average_seconds: number | null }>>`
    SELECT AVG(EXTRACT(EPOCH FROM (generation_finished_at - generation_started_at)))::float AS average_seconds
    FROM orders
    WHERE generation_started_at IS NOT NULL
      AND generation_finished_at IS NOT NULL
      AND generation_finished_at >= NOW() - INTERVAL '1 hour'
  `;
  const generationTotalLastHour = generationCompletedLastHour + generationFailedLastHour;
  const successRateLastHour = generationTotalLastHour === 0
    ? 100
    : Math.round((generationCompletedLastHour / generationTotalLastHour) * 100);

  return {
    totals: {
      totalOrders,
      pendingOrders,
      completedOrders: completedTotal,
      completedTotal,
      completedToday,
      completedThisWeek,
      failedOrders,
      cancelledOrders,
      expiredOrders,
      totalCodes,
      unusedCodes,
    },
    queue: {
      ...queueMetrics,
      pixWorkerConcurrency: config.pixWorkerConcurrency,
      paymentDetectionConcurrency: config.paymentDetectionConcurrency,
      averageGenerationSeconds: Math.round(generationAverage?.average_seconds ?? 0),
      successRateLastHour,
    },
    proxyHealth,
    dailyTrend: dailyTrend.map((row) => ({
      date: String(row.date),
      created: Number(row.created),
      completed: Number(row.completed),
      failed: Number(row.failed),
    })),
    workerPerformance,
  };
}

async function getWorkerPerformanceStats(
  shanghaiDayRange: { start: Date; end: Date },
  shanghaiWeekRange: { start: Date; end: Date },
) {
  const now = new Date();
  const [
    workers,
    claimedOrders,
    unclaimedPendingOrders,
    assignedCompletedToday,
    assignedCompletedThisWeek,
    unassignedCompletedToday,
    unassignedCompletedThisWeek,
  ] = await Promise.all([
    listWorkers(),
    prisma.order.count({
      where: {
        status: 'PENDING_PAYMENT',
        claimedById: { not: null },
        claimExpiresAt: { gt: now },
      },
    }),
    prisma.order.count({
      where: {
        status: 'PENDING_PAYMENT',
        OR: [{ claimedById: null }, { claimExpiresAt: { lt: now } }],
      },
    }),
    prisma.order.count({
      where: {
        status: 'PAYMENT_COMPLETED',
        completedById: { not: null },
        completedAt: { gte: shanghaiDayRange.start, lt: shanghaiDayRange.end },
      },
    }),
    prisma.order.count({
      where: {
        status: 'PAYMENT_COMPLETED',
        completedById: { not: null },
        completedAt: { gte: shanghaiWeekRange.start, lt: shanghaiWeekRange.end },
      },
    }),
    prisma.order.count({
      where: {
        status: 'PAYMENT_COMPLETED',
        completedById: null,
        completedAt: { gte: shanghaiDayRange.start, lt: shanghaiDayRange.end },
      },
    }),
    prisma.order.count({
      where: {
        status: 'PAYMENT_COMPLETED',
        completedById: null,
        completedAt: { gte: shanghaiWeekRange.start, lt: shanghaiWeekRange.end },
      },
    }),
  ]);

  return {
    totalWorkers: workers.length,
    enabledWorkers: workers.filter((worker) => worker.enabled).length,
    claimedOrders,
    unclaimedPendingOrders,
    assignedCompletedToday,
    assignedCompletedThisWeek,
    unassignedCompletedToday,
    unassignedCompletedThisWeek,
    topWorkers: [...workers]
      .sort((first, second) => second.completedToday - first.completedToday || second.completedTotal - first.completedTotal)
      .slice(0, 10),
  };
}
