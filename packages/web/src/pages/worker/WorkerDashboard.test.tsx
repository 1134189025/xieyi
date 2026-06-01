// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import api from '../../api/client';
import WorkerDashboard from './WorkerDashboard';

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
  claimedById: string | null;
  claimedAt: string | null;
  isClaimedByCurrentWorker: boolean;
  createdAt: string;
}

function workerOrder(overrides: Partial<WorkerOrder> = {}): WorkerOrder {
  const claimedById = overrides.claimedById ?? null;
  return {
    id: 'order-1',
    trackingToken: 'track-1',
    status: 'PENDING_PAYMENT',
    pixCode: 'pix-code',
    pixQrPngBase64: 'iVBORw0KGgo=',
    pixExpiresAt: '2026-06-01T01:00:00.000Z',
    pixImageUrl: null,
    claimedById,
    claimedAt: claimedById ? '2026-06-01T00:10:00.000Z' : null,
    isClaimedByCurrentWorker: claimedById === 'worker-1',
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockDashboardLoad(orders: WorkerOrder[], completedToday = 0) {
  (api.get as Mock).mockImplementation((url: string) => {
    if (url === '/worker/orders?limit=50') {
      return Promise.resolve({ data: { orders } });
    }
    if (url === '/worker/summary') {
      return Promise.resolve({ data: { completedToday } });
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
    vi.clearAllMocks();
    socketMock.reset();
    if (mountedRoot) {
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
    }
    document.body.innerHTML = '';
  });

  it('未领取订单只显示序号和领取按钮，不显示二维码、Pix 付款码或完成按钮', async () => {
    mockDashboardLoad([workerOrder()], 5);

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.textContent).toContain('今日完成 5 单');
    expect(container.textContent).toContain('#1');
    expect(findButton(container, '领取订单')).not.toBeNull();
    expect(container.querySelector('img[alt="Pix 二维码"]')).toBeNull();
    expect(readonlyInputValues(container)).toEqual([]);
    expect(findButton(container, '标记为已完成')).toBeUndefined();
    expect(container.textContent).not.toContain('track-1');
  });

  it('领取订单后在二维码界面显示同一序号、二维码和完成按钮', async () => {
    const claimedOrder = workerOrder({ claimedById: 'worker-1', isClaimedByCurrentWorker: true });
    mockDashboardLoad([workerOrder()]);
    (api.post as Mock).mockResolvedValue({ data: claimedOrder });

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    await clickButton(findButton(container, '领取订单')!);

    expect(api.post).toHaveBeenCalledWith('/worker/orders/order-1/claim');
    expect(container.textContent).toContain('#1');
    expect(container.querySelector('img[alt="Pix 二维码"]')).not.toBeNull();
    expect(findButton(container, '标记为已完成')).not.toBeNull();
    expect(readonlyInputValues(container)).toEqual([]);
  });

  it('二维码和 Pix 付款码界面按相同序号展示，切换不会改变排序', async () => {
    mockDashboardLoad([
      workerOrder({
        id: 'order-1',
        pixCode: 'pix-1',
        claimedById: 'worker-1',
        isClaimedByCurrentWorker: true,
        createdAt: '2026-06-01T00:00:00.000Z',
      }),
      workerOrder({
        id: 'order-2',
        trackingToken: 'track-2',
        pixCode: 'pix-2',
        claimedById: 'worker-1',
        isClaimedByCurrentWorker: true,
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

  it('实时领取事件会移除别人领取的订单，保留自己领取的订单并重新计算序号', async () => {
    mockDashboardLoad([
      workerOrder({ id: 'order-1', pixCode: 'pix-1', createdAt: '2026-06-01T00:00:00.000Z' }),
      workerOrder({ id: 'order-2', pixCode: 'pix-2', createdAt: '2026-06-01T00:01:00.000Z' }),
    ]);

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    act(() => socketMock.emitEvent('order:claimed', workerOrder({ id: 'order-1', claimedById: 'worker-2' })));
    act(() =>
      socketMock.emitEvent(
        'order:claimed',
        workerOrder({
          id: 'order-2',
          pixCode: 'pix-2',
          claimedById: 'worker-1',
          isClaimedByCurrentWorker: true,
          createdAt: '2026-06-01T00:01:00.000Z',
        }),
      ),
    );

    expect(container.textContent).toContain('#1');
    expect(container.textContent).not.toContain('#2');
    expect(container.querySelector('img[alt="Pix 二维码"]')).not.toBeNull();
    expect(findButton(container, '领取订单')).toBeUndefined();
  });

  it('完成失败保留订单，完成成功或收到完成事件后移除订单并刷新今日计数', async () => {
    let summaryRequests = 0;
    (api.get as Mock).mockImplementation((url: string) => {
      if (url === '/worker/orders?limit=50') {
        return Promise.resolve({
          data: { orders: [workerOrder({ claimedById: 'worker-1', isClaimedByCurrentWorker: true })] },
        });
      }
      if (url === '/worker/summary') {
        summaryRequests += 1;
        return Promise.resolve({ data: { completedToday: summaryRequests >= 2 ? 3 : 2 } });
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
    expect(container.textContent).toContain('今日完成 2 单');

    await clickButton(findButton(container, '标记为已完成')!);
    await flushAsyncWork();

    expect(container.querySelector('img[alt="Pix 二维码"]')).toBeNull();
    expect(container.textContent).toContain('今日完成 3 单');

    act(() =>
      socketMock.emitEvent('order:new', workerOrder({ id: 'order-3', claimedById: 'worker-1', isClaimedByCurrentWorker: true })),
    );
    act(() => socketMock.emitEvent('order:completed', { id: 'order-3' }));
    await flushAsyncWork();

    expect(container.textContent).toContain('今日完成 3 单');
    expect(container.querySelector('img[alt="Pix 二维码"]')).toBeNull();
  });

  it('取消完成确认时不请求接口', async () => {
    mockDashboardLoad([workerOrder({ claimedById: 'worker-1', isClaimedByCurrentWorker: true })]);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    await clickButton(findButton(container, '标记为已完成')!);

    expect(api.post).not.toHaveBeenCalled();
    expect(container.querySelector('img[alt="Pix 二维码"]')).not.toBeNull();
  });
});
