// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import api from '../../api/client';
import AdminDashboard from './AdminDashboard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock('../../components/Layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => <div />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  CartesianGrid: () => <div />,
  Tooltip: () => <div />,
}));

async function renderDashboard() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<AdminDashboard />);
    await Promise.resolve();
    await Promise.resolve();
  });

  return { container, root };
}

describe('AdminDashboard', () => {
  let mountedRoot: Root | null = null;

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    if (mountedRoot) {
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
    }
    document.body.innerHTML = '';
  });

  it('shows completion counters, queue operations metrics, and proxy health', async () => {
    (api.get as Mock).mockResolvedValue({
      data: {
        totals: {
          totalOrders: 20,
          pendingOrders: 4,
          completedTotal: 9,
          completedToday: 2,
          completedThisWeek: 5,
          failedOrders: 1,
          cancelledOrders: 1,
          expiredOrders: 0,
          totalCodes: 30,
          unusedCodes: 12,
        },
        queue: {
          waitingCount: 8,
          delayedCount: 1,
          activeCount: 2,
          failedCount: 3,
          oldestWaitingSeconds: 420,
          pixWorkerConcurrency: 5,
          paymentDetectionConcurrency: 5,
          averageGenerationSeconds: 180,
          successRateLastHour: 75,
        },
        proxyHealth: {
          chatGpt: { total: 3, healthy: 2, coolingDown: 1 },
          stripe: { total: 4, healthy: 4, coolingDown: 0 },
        },
        dailyTrend: [],
        workerPerformance: workerPerformanceResponse(),
      },
    });

    const { container, root } = await renderDashboard();
    mountedRoot = root;

    expect(container.textContent).toContain('总已完成');
    expect(container.textContent).toContain('今日已完成');
    expect(container.textContent).toContain('本周已完成');
    expect(container.textContent).toContain('本地兑换码');
    expect(container.textContent).toContain('未用本地码');
    expect(container.textContent).toContain('队列等待');
    expect(container.textContent).toContain('处理中');
    expect(container.textContent).toContain('失败任务');
    expect(container.textContent).toContain('最老等待 7 分钟');
    expect(container.textContent).toContain('近 1 小时成功率 75%');
    expect(container.textContent).toContain('ChatGPT 代理');
    expect(container.textContent).toContain('Stripe 代理');
    expect(container.textContent).toContain('工人绩效');
    expect(container.textContent).toContain('启用工人 1 / 2');
    expect(container.textContent).toContain('归属今日 2');
    expect(container.textContent).toContain('未归属今日 1');
    expect(container.textContent).toContain('工人');
    expect(container.textContent).toContain('今日 2 单');
  });

  it('silently refreshes dashboard data every 10 seconds', async () => {
    vi.useFakeTimers();
    (api.get as Mock)
      .mockResolvedValueOnce({ data: dashboardResponse({ totalOrders: 20, completedTotal: 9 }) })
      .mockResolvedValueOnce({ data: dashboardResponse({ totalOrders: 21, completedTotal: 10 }) });

    const { container, root } = await renderDashboard();
    mountedRoot = root;

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('20');

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('21');
    expect(container.textContent).toContain('10');
  });
});

function dashboardResponse(overrides: Partial<{
  totalOrders: number;
  completedTotal: number;
}> = {}) {
  return {
    totals: {
      totalOrders: overrides.totalOrders ?? 20,
      pendingOrders: 4,
      completedTotal: overrides.completedTotal ?? 9,
      completedToday: 2,
      completedThisWeek: 5,
      failedOrders: 1,
      cancelledOrders: 1,
      expiredOrders: 0,
      totalCodes: 30,
      unusedCodes: 12,
    },
    queue: {
      waitingCount: 8,
      delayedCount: 1,
      activeCount: 2,
      failedCount: 3,
      oldestWaitingSeconds: 420,
      pixWorkerConcurrency: 5,
      paymentDetectionConcurrency: 5,
      averageGenerationSeconds: 180,
      successRateLastHour: 75,
    },
    proxyHealth: {
      chatGpt: { total: 3, healthy: 2, coolingDown: 1 },
      stripe: { total: 4, healthy: 4, coolingDown: 0 },
    },
    workerPerformance: workerPerformanceResponse(),
    dailyTrend: [],
  };
}

function workerPerformanceResponse() {
  return {
    totalWorkers: 2,
    enabledWorkers: 1,
    claimedOrders: 3,
    unclaimedPendingOrders: 4,
    assignedCompletedToday: 2,
    assignedCompletedThisWeek: 7,
    unassignedCompletedToday: 1,
    unassignedCompletedThisWeek: 3,
    topWorkers: [
      {
        id: 'worker-1',
        username: 'worker',
        displayName: '工人',
        enabled: true,
        completedTotal: 12,
        completedToday: 2,
        completedThisWeek: 7,
        claimedCount: 1,
        lastCompletedAt: '2026-06-03T01:00:00.000Z',
      },
    ],
  };
}
