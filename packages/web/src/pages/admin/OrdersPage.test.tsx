// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import api from '../../api/client';
import OrdersPage from './OrdersPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    patch: vi.fn(),
  },
}));

vi.mock('../../components/Layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

async function renderOrdersPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<OrdersPage />);
    await Promise.resolve();
    await Promise.resolve();
  });

  return { container, root };
}

describe('OrdersPage', () => {
  let mountedRoot: Root | null = null;

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    if (mountedRoot) {
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
    }
    document.body.innerHTML = '';
  });

  it('shows worker completion ownership and generation diagnostics', async () => {
    (api.get as Mock).mockResolvedValue({
      data: {
        orders: [
          {
            id: 'order-1',
            trackingToken: 'track-1',
            status: 'PAYMENT_COMPLETED',
            paymentHandler: 'LOCAL_WORKER',
            checkoutSessionId: 'cs_test_123',
            outsourcedTicketId: null,
            outsourcedPaymentStatus: null,
            outsourcedLastError: null,
            errorMessage: null,
            completedBy: { id: 'worker-1', username: 'worker', displayName: '张三' },
            claimedBy: { id: 'worker-1', username: 'worker', displayName: '张三' },
            generationErrorCode: 'ACCOUNT_NOT_ELIGIBLE',
            generationErrorStage: 'stripe_pix',
            generationErrorDetail: 'payment_pages amount_due=9900',
            generationErrorHttpStatus: 400,
            completedAt: '2026-06-01T00:00:00.000Z',
            createdAt: '2026-06-01T00:00:00.000Z',
          },
          {
            id: 'order-2',
            trackingToken: 'track-2',
            status: 'PENDING_PAYMENT',
            paymentHandler: 'LOCAL_WORKER',
            checkoutSessionId: 'cs_test_456',
            outsourcedTicketId: null,
            outsourcedPaymentStatus: null,
            outsourcedLastError: null,
            errorMessage: null,
            completedBy: null,
            claimedBy: { id: 'worker-2', username: 'worker2', displayName: '李四' },
            generationErrorCode: null,
            generationErrorStage: null,
            generationErrorDetail: null,
            generationErrorHttpStatus: null,
            completedAt: null,
            createdAt: '2026-06-01T00:05:00.000Z',
          },
          {
            id: 'order-3',
            trackingToken: 'track-3',
            status: 'PAYMENT_COMPLETED',
            paymentHandler: 'OUTSOURCED_BUYER_API',
            checkoutSessionId: 'cs_test_789',
            outsourcedTicketId: 'Toutsource123',
            outsourcedPaymentStatus: 'paid',
            outsourcedLastError: null,
            errorMessage: null,
            completedBy: null,
            claimedBy: null,
            generationErrorCode: null,
            generationErrorStage: null,
            generationErrorDetail: null,
            generationErrorHttpStatus: null,
            completedAt: '2026-06-01T00:12:00.000Z',
            createdAt: '2026-06-01T00:06:00.000Z',
          },
          {
            id: 'order-4',
            trackingToken: 'track-4',
            status: 'FAILED',
            paymentHandler: 'LOCAL_WORKER',
            checkoutSessionId: null,
            outsourcedTicketId: null,
            outsourcedPaymentStatus: null,
            outsourcedLastError: null,
            errorMessage: '支付创建失败，请稍后重试。',
            completedBy: null,
            claimedBy: null,
            generationErrorCode: 'PAYMENT_FAILED',
            generationErrorStage: null,
            generationErrorDetail: null,
            generationErrorHttpStatus: null,
            completedAt: null,
            createdAt: '2026-06-01T00:20:00.000Z',
          },
        ],
        total: 4,
      },
    });

    const { container, root } = await renderOrdersPage();
    mountedRoot = root;

    expect(container.textContent).toContain('订单管理');
    expect(container.textContent).toContain('track-1');
    expect(container.textContent).toContain('track-3');
    expect(container.textContent).toContain('处理方式');
    expect(container.textContent).toContain('本地工人扫码');
    expect(container.textContent).toContain('外包自动支付');
    expect(container.textContent).toContain('外包自动完成');
    expect(container.textContent).toContain('Toutsource123');
    expect(container.textContent).toContain('状态：paid');
    expect(container.textContent).toContain('归属工人');
    expect(container.textContent).toContain('完成：张三');
    expect(container.textContent).toContain('领取：李四');
    expect(container.textContent).toContain('失败诊断');
    expect(container.textContent).toContain('stripe_pix');
    expect(container.textContent).toContain('payment_pages amount_due=9900');
    expect(container.textContent).toContain('PAYMENT_FAILED');
  });

  it('silently refreshes the current orders page every 10 seconds', async () => {
    vi.useFakeTimers();
    (api.get as Mock)
      .mockResolvedValueOnce({
        data: {
          orders: [orderResponse({ id: 'order-1', trackingToken: 'track-1', status: 'PENDING_PAYMENT' })],
          total: 1,
        },
      })
      .mockResolvedValueOnce({
        data: {
          orders: [orderResponse({
            id: 'order-2',
            trackingToken: 'track-2',
            status: 'PAYMENT_COMPLETED',
            completedAt: '2026-06-01T00:10:00.000Z',
          })],
          total: 1,
        },
      });

    const { container, root } = await renderOrdersPage();
    mountedRoot = root;

    expect(container.textContent).toContain('track-1');

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get).toHaveBeenLastCalledWith('/admin/orders', { params: { page: 1, limit: 20 } });
    expect(container.textContent).toContain('track-2');
    expect(container.textContent).not.toContain('track-1');
  });

  it('sends tracking token and payment handler filters to the admin orders API', async () => {
    (api.get as Mock).mockResolvedValue({
      data: {
        orders: [orderResponse({ id: 'order-1', trackingToken: 'track-1', status: 'PENDING_PAYMENT' })],
        total: 1,
      },
    });

    const { container, root } = await renderOrdersPage();
    mountedRoot = root;

    const outsourcedButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === '外包自动支付');
    const searchInput = container.querySelector('input[placeholder="追踪码"]') as HTMLInputElement;
    const searchButton = container.querySelector('button[title="搜索追踪码"]') as HTMLButtonElement;

    await act(async () => {
      outsourcedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      changeInputValue(searchInput, 'track-abc');
      searchButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.get).toHaveBeenLastCalledWith('/admin/orders', {
      params: {
        page: 1,
        limit: 20,
        paymentHandler: 'OUTSOURCED_BUYER_API',
        trackingToken: 'track-abc',
      },
    });
  });

  it('shows an empty state when no orders match the current filters', async () => {
    (api.get as Mock).mockResolvedValue({
      data: {
        orders: [],
        total: 0,
      },
    });

    const { container, root } = await renderOrdersPage();
    mountedRoot = root;

    expect(container.textContent).toContain('没有符合筛选条件的订单');
  });

  it('moves through orders with next page and direct jump controls', async () => {
    (api.get as Mock).mockResolvedValue({
      data: {
        orders: [orderResponse({ id: 'order-1', trackingToken: 'track-1', status: 'PENDING_PAYMENT' })],
        total: 45,
      },
    });

    const { container, root } = await renderOrdersPage();
    mountedRoot = root;

    const nextButton = container.querySelector('button[title="下一页"]') as HTMLButtonElement;
    await act(async () => {
      nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.get).toHaveBeenLastCalledWith('/admin/orders', { params: { page: 2, limit: 20 } });

    const pageInput = container.querySelector('form input.w-16') as HTMLInputElement;
    const jumpButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === '跳转');

    await act(async () => {
      changeInputValue(pageInput, '3');
      jumpButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.get).toHaveBeenLastCalledWith('/admin/orders', { params: { page: 3, limit: 20 } });
  });

  it('does not show cancel action for outsourced pending orders after ticket submission', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    (api.get as Mock).mockResolvedValue({
      data: {
        orders: [
          orderResponse({
            id: 'order-1',
            trackingToken: 'local-track',
            status: 'PENDING_PAYMENT',
            paymentHandler: 'LOCAL_WORKER',
          }),
          orderResponse({
            id: 'order-2',
            trackingToken: 'outsourced-track',
            status: 'PENDING_PAYMENT',
            paymentHandler: 'OUTSOURCED_BUYER_API',
            outsourcedTicketId: 'Toutsource123',
          }),
        ],
        total: 2,
      },
    });

    const { container, root } = await renderOrdersPage();
    mountedRoot = root;

    const cancelButtons = container.querySelectorAll('button[title="取消订单"]');
    expect(cancelButtons).toHaveLength(1);

    await act(async () => {
      cancelButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.patch).toHaveBeenCalledWith('/admin/orders/order-1', { status: 'CANCELLED' });
    expect(api.patch).not.toHaveBeenCalledWith('/admin/orders/order-2', expect.anything());
  });
});

function orderResponse(overrides: Partial<{
  id: string;
  trackingToken: string;
  status: string;
  completedAt: string | null;
  paymentHandler: 'LOCAL_WORKER' | 'OUTSOURCED_BUYER_API';
  outsourcedTicketId: string | null;
}> = {}) {
  return {
    id: overrides.id ?? 'order-1',
    trackingToken: overrides.trackingToken ?? 'track-1',
    status: overrides.status ?? 'PAYMENT_COMPLETED',
    paymentHandler: overrides.paymentHandler ?? 'LOCAL_WORKER',
    checkoutSessionId: 'cs_test_123',
    outsourcedTicketId: overrides.outsourcedTicketId ?? null,
    outsourcedPaymentStatus: null,
    outsourcedLastError: null,
    errorMessage: null,
    claimedBy: null,
    completedBy: null,
    generationErrorCode: null,
    generationErrorStage: null,
    generationErrorDetail: null,
    generationErrorHttpStatus: null,
    completedAt: overrides.completedAt ?? null,
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

function changeInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
