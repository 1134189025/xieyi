// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import api from '../../api/client';
import WorkerManagementPage from './WorkerManagementPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
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

async function renderWorkerManagement() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<WorkerManagementPage />);
    await Promise.resolve();
    await Promise.resolve();
  });

  return { container, root };
}

describe('WorkerManagementPage', () => {
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

  it('does not show per-worker completed order counts', async () => {
    (api.get as Mock).mockResolvedValue({
      data: {
        workers: [
          {
            id: 'worker-1',
            username: 'worker',
            displayName: '工人',
            enabled: true,
            createdAt: '2026-06-01T00:00:00.000Z',
          },
        ],
      },
    });

    const { container, root } = await renderWorkerManagement();
    mountedRoot = root;

    expect(container.textContent).toContain('工人管理');
    expect(container.textContent).toContain('worker');
    expect(container.textContent).not.toContain('完成订单');
  });

  it('silently refreshes workers every 10 seconds', async () => {
    vi.useFakeTimers();
    (api.get as Mock)
      .mockResolvedValueOnce({
        data: {
          workers: [workerResponse({ id: 'worker-1', username: 'worker-old' })],
        },
      })
      .mockResolvedValueOnce({
        data: {
          workers: [workerResponse({ id: 'worker-2', username: 'worker-new' })],
        },
      });

    const { container, root } = await renderWorkerManagement();
    mountedRoot = root;

    expect(container.textContent).toContain('worker-old');

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('worker-new');
    expect(container.textContent).not.toContain('worker-old');
  });
});

function workerResponse(overrides: Partial<{ id: string; username: string }> = {}) {
  return {
    id: overrides.id ?? 'worker-1',
    username: overrides.username ?? 'worker',
    displayName: '宸ヤ汉',
    enabled: true,
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}
