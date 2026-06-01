import { prisma } from '../db.ts';
import { getShanghaiDayRange, getShanghaiWeekRange } from '../utils/shanghai-time.ts';

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
    totalCodes,
    unusedCodes,
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
    prisma.redemptionCode.count(),
    prisma.redemptionCode.count({ where: { usedAt: null } }),
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
    dailyTrend: dailyTrend.map((row) => ({
      date: String(row.date),
      created: Number(row.created),
      completed: Number(row.completed),
      failed: Number(row.failed),
    })),
  };
}
