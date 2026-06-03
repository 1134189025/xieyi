// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import api from '../../api/client';
import WorkerDashboard from './WorkerDashboard';
import toast from 'react-hot-toast';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SocketHandler = (data: unknown) => void;

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<SocketHandler>>();

  return {
    on: vi.fn((event: string, handler: SocketHandler) => {
      const eventHandlers = handlers.get(event) ?? new Set<SocketHandler>();
      eventHandlers.add(handler);
      handlers.set(event, eventHandlers);
    }),
    off: vi.fn((event: string, handler: SocketHandler) => {
      handlers.get(event)?.delete(handler);
    }),
    emitEvent(event: string, data: unknown) {
      handlers.get(event)?.forEach((handler) => handler(data));
    },
    reset() {
      handlers.clear();
      this.on.mockClear();
      this.off.mockClear();
    },
  };
});

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    token: 'worker-token',
    user: {
      id: 'worker-1',
      username: 'worker',
      role: 'WORKER',
      displayName: '工人',
    },
    logout: vi.fn(),
    isAdmin: false,
    isWorker: true,
    authStatus: 'authenticated',
  }),
}));

vi.mock('../../hooks/useSocket', () => ({
  useSocket: vi.fn(() => socketMock),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

interface WorkerOrder {
  id: string;
  trackingToken: string;
  status: string;
  pixCode: string;
  pixQrPngBase64: string | null;
  pixExpiresAt: string | null;
  pixImageUrl: string | null;
  createdAt: string;
}

interface CompletionSummary {
  completedTotal: number;
  completedToday: number;
  completedThisWeek: number;
  claimedCount: number;
  availableCount: number;
}

function workerOrder(overrides: Partial<WorkerOrder> = {}): WorkerOrder {
  return {
    id: 'order-1',
    trackingToken: 'track-1',
    status: 'PENDING_PAYMENT',
    pixCode: 'pix-code',
    pixQrPngBase64: 'iVBORw0KGgo=',
    pixExpiresAt: '2026-06-01T01:00:00.000Z',
    pixImageUrl: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockDashboardLoad(
  orders: WorkerOrder[],
  summary: CompletionSummary = {
    completedTotal: 10,
    completedToday: 2,
    completedThisWeek: 5,
    claimedCount: orders.length,
    availableCount: 3,
  },
) {
  (api.get as Mock).mockImplementation((url: string) => {
    if (url === '/worker/orders/mine?limit=50') {
      return Promise.resolve({ data: { orders } });
    }
    if (url === '/worker/summary') {
      return Promise.resolve({ data: summary });
    }
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  });
}

function renderWorkerDashboard() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <MemoryRouter>
        <WorkerDashboard />
      </MemoryRouter>,
    );
  });

  return { container, root };
}

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(label),
  );
}

function readonlyInputValues(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[readonly]')).map((input) => input.value);
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function clickButton(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('WorkerDashboard', () => {
  let mountedRoot: Root | null = null;

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    socketMock.reset();
    if (mountedRoot) {
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
    }
    document.body.innerHTML = '';
  });

  it('显示我的计数、可领取数量和领取 10 单按钮', async () => {
    mockDashboardLoad([workerOrder()]);

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.textContent).toContain('我的总完成 10 单');
    expect(container.textContent).toContain('我的今日 2 单');
    expect(container.textContent).toContain('我的本周 5 单');
    expect(container.textContent).toContain('可领取 3 单');
    expect(container.textContent).toContain('#1');
    expect(findButton(container, '领取 10 单')).not.toBeNull();
    expect(findButton(container, '标记为已完成')).not.toBeNull();
    expect(container.textContent).not.toContain('track-1');
  });

  it('点击领取 10 单后调用批量领取接口并刷新我的任务和计数', async () => {
    let orderRequests = 0;
    (api.get as Mock).mockImplementation((url: string) => {
      if (url === '/worker/orders/mine?limit=50') {
        orderRequests += 1;
        return Promise.resolve({
          data: {
            orders: orderRequests >= 2 ? [workerOrder({ id: 'order-2', pixCode: 'pix-claimed' })] : [],
          },
        });
      }
      if (url === '/worker/summary') {
        return Promise.resolve({
          data: { completedTotal: 10, completedToday: 2, completedThisWeek: 5, claimedCount: 1, availableCount: 2 },
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });
    (api.post as Mock).mockResolvedValue({ data: { orders: [workerOrder({ id: 'order-2' })], claimedCount: 1 } });

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    await clickButton(findButton(container, '领取 10 单')!);
    await flushAsyncWork();

    expect(api.post).toHaveBeenCalledWith('/worker/orders/claim-batch');
    expect(toast.success).toHaveBeenCalledWith('已领取 1 单');
    expect(container.textContent).toContain('#1');
  });

  it('批量领取没有可领取订单时提示暂无任务', async () => {
    mockDashboardLoad([]);
    (api.post as Mock).mockResolvedValue({ data: { orders: [], claimedCount: 0 } });

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    await clickButton(findButton(container, '领取 10 单')!);
    await flushAsyncWork();

    expect(api.post).toHaveBeenCalledWith('/worker/orders/claim-batch');
    expect(toast.error).toHaveBeenCalledWith('暂无可领取任务');
  });

  it('批量领取请求未完成时禁用按钮', async () => {
    mockDashboardLoad([]);
    let resolveClaimRequest: (value: { data: { orders: WorkerOrder[]; claimedCount: number } }) => void = () => undefined;
    (api.post as Mock).mockReturnValue(new Promise((resolve) => {
      resolveClaimRequest = resolve;
    }));

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    const claimButton = findButton(container, '领取 10 单')!;
    await act(async () => {
      claimButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(claimButton.disabled).toBe(true);
    expect(claimButton.textContent).toContain('领取中...');

    await act(async () => {
      resolveClaimRequest({ data: { orders: [], claimedCount: 0 } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('二维码和 Pix 付款码界面按相同序号展示，切换不会改变排序', async () => {
    mockDashboardLoad([
      workerOrder({
        id: 'order-1',
        pixCode: 'pix-1',
        createdAt: '2026-06-01T00:00:00.000Z',
      }),
      workerOrder({
        id: 'order-2',
        trackingToken: 'track-2',
        pixCode: 'pix-2',
        createdAt: '2026-06-01T00:01:00.000Z',
      }),
    ]);

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.textContent).toContain('#1');
    expect(container.textContent).toContain('#2');
    expect(container.querySelectorAll('img[alt="Pix 二维码"]')).toHaveLength(2);
    expect(readonlyInputValues(container)).toEqual([]);

    await clickButton(findButton(container, 'Pix 付款码')!);

    expect(container.textContent).toContain('#1');
    expect(container.textContent).toContain('#2');
    expect(container.querySelectorAll('img[alt="Pix 二维码"]')).toHaveLength(0);
    expect(readonlyInputValues(container)).toEqual(['pix-1', 'pix-2']);
  });

  it('实时新增可领取任务不会直接进入我的任务列表', async () => {
    mockDashboardLoad([
      workerOrder({ id: 'order-2', pixCode: 'pix-2', createdAt: '2026-06-01T00:02:00.000Z' }),
    ]);

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    await act(async () => {
      socketMock.emitEvent(
        'order:new',
        workerOrder({ id: 'order-1', pixCode: 'pix-1', createdAt: '2026-06-01T00:01:00.000Z' }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      socketMock.emitEvent(
        'order:new',
        workerOrder({ id: 'order-2', pixCode: 'pix-2-updated', createdAt: '2026-06-01T00:02:00.000Z' }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('#1');
    expect(container.textContent).not.toContain('#2');

    await clickButton(findButton(container, 'Pix 付款码')!);

    expect(readonlyInputValues(container)).toEqual(['pix-2']);
  });

  it('完成失败保留订单，完成成功或收到完成事件后移除订单并刷新三个计数', async () => {
    let summaryRequests = 0;
    (api.get as Mock).mockImplementation((url: string) => {
      if (url === '/worker/orders/mine?limit=50') {
        return Promise.resolve({ data: { orders: [workerOrder()] } });
      }
      if (url === '/worker/summary') {
        summaryRequests += 1;
        return Promise.resolve({
          data:
            summaryRequests >= 2
              ? { completedTotal: 11, completedToday: 3, completedThisWeek: 6, claimedCount: 0, availableCount: 3 }
              : { completedTotal: 10, completedToday: 2, completedThisWeek: 5, claimedCount: 1, availableCount: 3 },
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });
    (api.post as Mock).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ data: {} });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    await clickButton(findButton(container, '标记为已完成')!);

    expect(api.post).toHaveBeenCalledWith('/worker/orders/order-1/complete');
    expect(container.querySelector('img[alt="Pix 二维码"]')).not.toBeNull();
    expect(container.textContent).toContain('我的总完成 10 单');

    await clickButton(findButton(container, '标记为已完成')!);
    await flushAsyncWork();

    expect(container.querySelector('img[alt="Pix 二维码"]')).toBeNull();
    expect(container.textContent).toContain('我的总完成 11 单');
    expect(container.textContent).toContain('我的今日 3 单');
    expect(container.textContent).toContain('我的本周 6 单');

    act(() => socketMock.emitEvent('order:new', workerOrder({ id: 'order-3' })));
    act(() => socketMock.emitEvent('order:completed', { id: 'order-3' }));
    await flushAsyncWork();

    expect(container.querySelector('img[alt="Pix 二维码"]')).toBeNull();
  });

  it('取消完成确认时不请求接口', async () => {
    mockDashboardLoad([workerOrder()]);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    await clickButton(findButton(container, '标记为已完成')!);

    expect(api.post).not.toHaveBeenCalled();
    expect(container.querySelector('img[alt="Pix 二维码"]')).not.toBeNull();
  });

  it('silently refreshes worker orders and completion counters every 10 seconds', async () => {
    vi.useFakeTimers();
    let orderRequests = 0;
    let summaryRequests = 0;
    (api.get as Mock).mockImplementation((url: string) => {
      if (url === '/worker/orders/mine?limit=50') {
        orderRequests += 1;
        return Promise.resolve({
          data: {
            orders: [
              orderRequests >= 2
                ? workerOrder({ id: 'order-2', pixCode: 'pix-new', createdAt: '2026-06-01T00:02:00.000Z' })
                : workerOrder({ id: 'order-1', pixCode: 'pix-old', createdAt: '2026-06-01T00:01:00.000Z' }),
            ],
          },
        });
      }
      if (url === '/worker/summary') {
        summaryRequests += 1;
        return Promise.resolve({
          data: summaryRequests >= 2
            ? { completedTotal: 11, completedToday: 3, completedThisWeek: 6, claimedCount: 1, availableCount: 2 }
            : { completedTotal: 10, completedToday: 2, completedThisWeek: 5, claimedCount: 1, availableCount: 3 },
        });
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    await clickButton(findButton(container, 'Pix 付款码')!);
    expect(readonlyInputValues(container)).toEqual(['pix-old']);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readonlyInputValues(container)).toEqual(['pix-new']);
    expect(container.textContent).toContain('11');
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('6');
  });
});
