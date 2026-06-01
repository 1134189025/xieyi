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

function pendingOrder(overrides: Partial<WorkerOrder> = {}): WorkerOrder {
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

function findCompleteButton(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes('标记为已完成'),
  );
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function clickButton(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

  it('只渲染工人处理付款需要的二维码、Pix 付款码和完成按钮', async () => {
    (api.get as Mock).mockResolvedValue({ data: { orders: [pendingOrder()] } });

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.querySelector('img[alt="Pix 二维码"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('pix-code');
    expect(container.textContent).toContain('Pix 付款码');
    expect(container.textContent).toContain('标记为已完成');
    expect(container.textContent).not.toContain('Pix 协议支付');
    expect(container.textContent).not.toContain('待处理订单');
    expect(container.textContent).not.toContain('1 个订单等待付款');
    expect(container.textContent).not.toContain('track-1');
    expect(container.textContent).not.toContain('待支付');
  });

  it('通过工人实时事件新增和移除待处理订单', async () => {
    (api.get as Mock).mockResolvedValue({ data: { orders: [] } });

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    act(() => socketMock.emitEvent('order:new', pendingOrder({ id: 'order-2', pixCode: 'pix-new' })));

    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('pix-new');

    act(() => socketMock.emitEvent('order:completed', { id: 'order-2' }));

    expect(container.querySelector<HTMLInputElement>('input[readonly]')).toBeNull();
  });

  it('取消完成确认时不请求接口', async () => {
    (api.get as Mock).mockResolvedValue({ data: { orders: [pendingOrder()] } });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    const completeButton = findCompleteButton(container);
    expect(completeButton).not.toBeNull();

    await clickButton(completeButton!);

    expect(api.post).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('pix-code');
  });

  it('完成成功后移除订单，完成失败时保留订单', async () => {
    (api.get as Mock).mockResolvedValue({ data: { orders: [pendingOrder()] } });
    (api.post as Mock).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ data: {} });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { container, root } = renderWorkerDashboard();
    mountedRoot = root;
    await flushAsyncWork();

    await clickButton(findCompleteButton(container)!);

    expect(api.post).toHaveBeenCalledWith('/worker/orders/order-1/complete');
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('pix-code');

    await clickButton(findCompleteButton(container)!);

    expect(container.querySelector<HTMLInputElement>('input[readonly]')).toBeNull();
  });
});
