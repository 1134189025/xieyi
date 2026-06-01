import { prisma } from '../db.ts';
import { getShanghaiDayRange, getShanghaiWeekRange } from '../utils/shanghai-time.ts';
import { getPixGenerationQueueMetrics } from '../queues/pix-generation.queue.ts';
import { getProxyPoolHealthSummary } from './settings.service.ts';

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
  };
}
