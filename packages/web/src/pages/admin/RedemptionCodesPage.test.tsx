// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import api from '../../api/client';
import RedemptionCodesPage from './RedemptionCodesPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../api/client', () => ({
  default: {
    delete: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
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

async function renderRedemptionCodesPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<RedemptionCodesPage />);
    await Promise.resolve();
    await Promise.resolve();
  });

  return { container, root };
}

describe('RedemptionCodesPage', () => {
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

  it('silently refreshes redemption codes every 10 seconds', async () => {
    vi.useFakeTimers();
    (api.get as Mock)
      .mockResolvedValueOnce({ data: { codes: [codeResponse('CODE-OLD')], total: 1 } })
      .mockResolvedValueOnce({ data: { codes: [codeResponse('CODE-NEW')], total: 1 } });

    const { container, root } = await renderRedemptionCodesPage();
    mountedRoot = root;

    expect(container.textContent).toContain('CODE-OLD');

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get).toHaveBeenLastCalledWith('/admin/redemption-codes', {
      params: { status: 'all', archiveScope: 'active', page: 1, limit: 20 },
    });
    expect(container.textContent).toContain('CODE-NEW');
    expect(container.textContent).not.toContain('CODE-OLD');
  });

  it('shows an empty state when no redemption codes match the current filters', async () => {
    (api.get as Mock).mockResolvedValueOnce({ data: { codes: [], total: 0 } });

    const { container, root } = await renderRedemptionCodesPage();
    mountedRoot = root;

    expect(container.textContent).toContain('本地兑换码管理');
    expect(container.textContent).toContain('没有符合筛选条件的兑换码');
  });

  it('filters by batch and search then archives or deletes with current filters', async () => {
    (api.get as Mock)
      .mockResolvedValueOnce({ data: { codes: [codeResponse('CODE-OLD', { batchLabel: 'batch-001', usedAt: '2026-06-01T00:00:00.000Z' })], total: 1 } })
      .mockResolvedValueOnce({ data: { codes: [], total: 0 } });
    (api.post as Mock)
      .mockResolvedValueOnce({ data: { archivedCount: 1 } })
      .mockResolvedValueOnce({ data: { deletedCount: 1 } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { container, root } = await renderRedemptionCodesPage();
    mountedRoot = root;

    const batchInput = container.querySelector<HTMLInputElement>('input[placeholder="输入批次标签筛选"]');
    const searchInput = container.querySelector<HTMLInputElement>('input[placeholder="搜索兑换码或批次"]');
    expect(batchInput).not.toBeNull();
    expect(searchInput).not.toBeNull();

    await act(async () => {
      batchInput!.value = 'batch-001';
      batchInput!.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput!.value = 'CODE';
      searchInput!.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-testid="archive-used-codes"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-testid="delete-unused-codes"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.post).toHaveBeenCalledWith('/admin/redemption-codes/archive-used', {
      status: 'all',
      batchLabel: 'batch-001',
      search: 'CODE',
      archiveScope: 'active',
    });
    expect(api.post).toHaveBeenCalledWith('/admin/redemption-codes/delete-unused', {
      status: 'all',
      batchLabel: 'batch-001',
      search: 'CODE',
      archiveScope: 'active',
    });
  });
});

function codeResponse(code: string, overrides: Partial<{ batchLabel: string | null; usedAt: string | null }> = {}) {
  return {
    id: code,
    code,
    batchLabel: overrides.batchLabel ?? null,
    usedAt: overrides.usedAt ?? null,
    createdAt: '2026-06-01T00:00:00.000Z',
    order: null,
  };
}
