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
          averageGenerationSeconds: 180,
          successRateLastHour: 75,
        },
        proxyHealth: {
          chatGpt: { total: 3, healthy: 2, coolingDown: 1 },
          stripe: { total: 4, healthy: 4, coolingDown: 0 },
        },
        dailyTrend: [],
      },
    });

    const { container, root } = await renderDashboard();
    mountedRoot = root;

    expect(container.textContent).toContain('总已完成');
    expect(container.textContent).toContain('今日已完成');
    expect(container.textContent).toContain('本周已完成');
    expect(container.textContent).toContain('队列等待');
    expect(container.textContent).toContain('处理中');
    expect(container.textContent).toContain('失败任务');
    expect(container.textContent).toContain('最老等待 7 分钟');
    expect(container.textContent).toContain('近 1 小时成功率 75%');
    expect(container.textContent).toContain('ChatGPT 代理');
    expect(container.textContent).toContain('Stripe 代理');
    expect(container.textContent).not.toContain('工人绩效');
  });
});
