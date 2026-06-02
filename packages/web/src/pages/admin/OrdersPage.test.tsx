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
    if (mountedRoot) {
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
    }
    document.body.innerHTML = '';
  });

  it('does not show worker completion ownership', async () => {
    (api.get as Mock).mockResolvedValue({
      data: {
        orders: [
          {
            id: 'order-1',
            trackingToken: 'track-1',
            status: 'PAYMENT_COMPLETED',
            pixCode: 'pix-code',
            checkoutSessionId: 'cs_test_123',
            errorMessage: null,
            completedAt: '2026-06-01T00:00:00.000Z',
            createdAt: '2026-06-01T00:00:00.000Z',
          },
        ],
        total: 1,
      },
    });

    const { container, root } = await renderOrdersPage();
    mountedRoot = root;

    expect(container.textContent).toContain('订单管理');
    expect(container.textContent).toContain('track-1');
    expect(container.textContent).not.toContain('工人');
    expect(container.textContent).not.toContain('张三');
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
});

function orderResponse(overrides: Partial<{
  id: string;
  trackingToken: string;
  status: string;
  completedAt: string | null;
}> = {}) {
  return {
    id: overrides.id ?? 'order-1',
    trackingToken: overrides.trackingToken ?? 'track-1',
    status: overrides.status ?? 'PAYMENT_COMPLETED',
    pixCode: 'pix-code',
    checkoutSessionId: 'cs_test_123',
    errorMessage: null,
    completedAt: overrides.completedAt ?? null,
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}
