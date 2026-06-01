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
});
