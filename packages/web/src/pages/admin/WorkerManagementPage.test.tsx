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
    delete: vi.fn(),
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

  it('shows per-worker completed order counts', async () => {
    (api.get as Mock).mockResolvedValue({
      data: {
        workers: [
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
            createdAt: '2026-06-01T00:00:00.000Z',
          },
        ],
      },
    });

    const { container, root } = await renderWorkerManagement();
    mountedRoot = root;

    expect(container.textContent).toContain('工人管理');
    expect(container.textContent).toContain('worker');
    expect(container.textContent).toContain('今日完成');
    expect(container.textContent).toContain('本周完成');
    expect(container.textContent).toContain('总完成');
    expect(container.textContent).toContain('12');
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

  it('deletes a worker account after confirmation and refreshes the list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    (api.get as Mock)
      .mockResolvedValueOnce({
        data: {
          workers: [workerResponse({ id: 'worker-1', username: 'worker-delete' })],
        },
      })
      .mockResolvedValueOnce({
        data: {
          workers: [],
        },
      });
    (api.delete as Mock).mockResolvedValue({});

    const { container, root } = await renderWorkerManagement();
    mountedRoot = root;

    const deleteButton = container.querySelector('button[title="删除工人"]') as HTMLButtonElement | null;
    expect(deleteButton).not.toBeNull();

    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.confirm).toHaveBeenCalledWith('确认删除工人「worker-delete」？该账号将不可登录，历史订单归属会保留。');
    expect(api.delete).toHaveBeenCalledWith('/admin/workers/worker-1');
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('worker-delete');
  });

  it('renders disabled workers with zero active claimed orders from the refreshed data', async () => {
    (api.get as Mock).mockResolvedValue({
      data: {
        workers: [
          workerResponse({
            id: 'worker-disabled',
            username: 'disabled-worker',
            enabled: false,
            claimedCount: 0,
          }),
        ],
      },
    });

    const { container, root } = await renderWorkerManagement();
    mountedRoot = root;

    expect(container.textContent).toContain('disabled-worker');
    expect(container.textContent).toContain('禁用');
    expect(container.textContent).not.toContain('已领取 1');
  });
});

function workerResponse(
  overrides: Partial<{ id: string; username: string; enabled: boolean; claimedCount: number }> = {},
) {
  return {
    id: overrides.id ?? 'worker-1',
    username: overrides.username ?? 'worker',
    displayName: '工人',
    enabled: overrides.enabled ?? true,
    completedTotal: 12,
    completedToday: 2,
    completedThisWeek: 7,
    claimedCount: overrides.claimedCount ?? 1,
    lastCompletedAt: '2026-06-03T01:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}
