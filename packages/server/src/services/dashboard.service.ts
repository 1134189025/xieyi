import { prisma } from '../db.ts';

export async function getDashboardStats() {
  const [
    totalOrders,
    pendingOrders,
    completedOrders,
    failedOrders,
    cancelledOrders,
    expiredOrders,
    totalCodes,
    unusedCodes,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({ where: { status: 'PENDING_PAYMENT' } }),
    prisma.order.count({ where: { status: 'PAYMENT_COMPLETED' } }),
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

  const workerPerformance = await prisma.user.findMany({
    where: { role: 'WORKER', completedOrders: { some: {} } },
    select: {
      id: true,
      displayName: true,
      username: true,
      _count: { select: { completedOrders: true } },
      completedOrders: {
        select: { createdAt: true, completedAt: true },
        orderBy: { completedAt: 'desc' },
        take: 100,
      },
    },
  });

  return {
    totals: {
      totalOrders,
      pendingOrders,
      completedOrders,
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
    workerPerformance: workerPerformance.map((w) => {
      const completionTimes = w.completedOrders
        .filter((o) => o.completedAt)
        .map((o) => (o.completedAt!.getTime() - o.createdAt.getTime()) / 60000);
      const avgMinutes =
        completionTimes.length > 0
          ? Math.round(completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length)
          : 0;

      return {
        workerId: w.id,
        displayName: w.displayName ?? w.username,
        completedCount: w._count.completedOrders,
        avgCompletionMinutes: avgMinutes,
      };
    }),
  };
}
