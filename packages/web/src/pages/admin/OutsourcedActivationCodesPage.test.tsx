// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import api from '../../api/client';
import OutsourcedActivationCodesPage from './OutsourcedActivationCodesPage';

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

async function renderOutsourcedCodesPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<OutsourcedActivationCodesPage />);
    await Promise.resolve();
    await Promise.resolve();
  });

  return { container, root };
}

describe('OutsourcedActivationCodesPage', () => {
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

  it('renders outsourced activation code summary and masked codes', async () => {
    (api.get as Mock).mockResolvedValueOnce({ data: outsourcedCodesResponse() });

    const { container, root } = await renderOutsourcedCodesPage();
    mountedRoot = root;

    expect(api.get).toHaveBeenCalledWith('/admin/outsourced-activation-codes', {
      params: { status: 'all', archiveScope: 'active', page: 1, limit: 20 },
    });
    expect(container.textContent).toContain('外包兑换码管理');
    expect(container.textContent).toContain('DP-F...ODE');
    expect(container.textContent).toContain('远端剩余');
    expect(container.textContent).toContain('检测失败');
    expect(container.textContent).toContain('本系统提交');
    expect(container.textContent).not.toContain('DP-FIRST-CODE');
  });

  it('shows an empty state when no outsourced activation codes match the current filters', async () => {
    (api.get as Mock).mockResolvedValueOnce({
      data: outsourcedCodesResponse({ codes: [], total: 0 }),
    });

    const { container, root } = await renderOutsourcedCodesPage();
    mountedRoot = root;

    expect(container.textContent).toContain('没有符合筛选条件的外包兑换码');
  });

  it('imports codes with an optional batch label', async () => {
    (api.get as Mock)
      .mockResolvedValueOnce({ data: outsourcedCodesResponse() })
      .mockResolvedValueOnce({ data: outsourcedCodesResponse({ total: 2 }) });
    (api.post as Mock).mockResolvedValueOnce({ data: { importedCount: 2, duplicateCount: 0 } });

    const { container, root } = await renderOutsourcedCodesPage();
    mountedRoot = root;

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="每行一个外包兑换码"]');
    const batchInput = container.querySelector<HTMLInputElement>('input[placeholder="例如 outsourced-001"]');
    await act(async () => {
      setTextareaValue(textarea!, 'DP-FIRST-CODE\nDP-SECOND-CODE');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
      setInputValue(batchInput!, 'batch-001');
      batchInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const importButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('导入'),
    );
    await act(async () => {
      importButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.post).toHaveBeenCalledWith('/admin/outsourced-activation-codes/import', {
      codesText: 'DP-FIRST-CODE\nDP-SECOND-CODE',
      batchLabel: 'batch-001',
    });
  });

  it('refreshes current filtered outsourced codes', async () => {
    (api.get as Mock)
      .mockResolvedValueOnce({ data: outsourcedCodesResponse() })
      .mockResolvedValue({ data: outsourcedCodesResponse() });
    (api.post as Mock).mockResolvedValueOnce({ data: { checked: 1, available: 1, exhausted: 0, failed: 0 } });

    const { container, root } = await renderOutsourcedCodesPage();
    mountedRoot = root;

    const batchInput = container.querySelector<HTMLInputElement>('input[placeholder="输入批次标签筛选"]');
    const searchInput = container.querySelector<HTMLInputElement>('input[placeholder="搜索脱敏码或批次"]');
    await act(async () => {
      setInputValue(batchInput!, 'batch-001');
      batchInput!.dispatchEvent(new Event('input', { bubbles: true }));
      setInputValue(searchInput!, 'DP-F');
      searchInput!.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-testid="refresh-outsourced-codes"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.post).toHaveBeenCalledWith('/admin/outsourced-activation-codes/refresh', {
      status: 'all',
      archiveScope: 'active',
      batchLabel: 'batch-001',
      search: 'DP-F',
    });
  });

  it('archives and deletes unused outsourced codes with current filters', async () => {
    (api.get as Mock)
      .mockResolvedValueOnce({ data: outsourcedCodesResponse() })
      .mockResolvedValue({ data: outsourcedCodesResponse() });
    (api.post as Mock)
      .mockResolvedValueOnce({ data: { archivedCount: 1 } })
      .mockResolvedValueOnce({ data: { deletedCount: 1 } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { container, root } = await renderOutsourcedCodesPage();
    mountedRoot = root;

    const batchInput = container.querySelector<HTMLInputElement>('input[placeholder="输入批次标签筛选"]');
    const searchInput = container.querySelector<HTMLInputElement>('input[placeholder="搜索脱敏码或批次"]');
    await act(async () => {
      setInputValue(batchInput!, 'batch-001');
      batchInput!.dispatchEvent(new Event('input', { bubbles: true }));
      setInputValue(searchInput!, 'DP-F');
      searchInput!.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-testid="archive-outsourced-codes"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-testid="delete-unused-outsourced-codes"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.post).toHaveBeenCalledWith('/admin/outsourced-activation-codes/archive', {
      status: 'all',
      archiveScope: 'active',
      batchLabel: 'batch-001',
      search: 'DP-F',
    });
    expect(api.post).toHaveBeenCalledWith('/admin/outsourced-activation-codes/delete-unused', {
      status: 'all',
      archiveScope: 'active',
      batchLabel: 'batch-001',
      search: 'DP-F',
    });
  });
});

function outsourcedCodesResponse(overrides: Partial<{ codes: Array<Record<string, unknown>>; total: number }> = {}) {
  return {
    codes: overrides.codes ?? [{
      id: 'code-1',
      maskedCode: 'DP-F...ODE',
      batchLabel: 'batch-001',
      status: 'AVAILABLE',
      lastRemaining: 2,
      lastUsed: 1,
      lastTotal: 3,
      localSubmitCount: 1,
      lastCheckedAt: '2026-06-01T00:00:00.000Z',
      lastError: null,
      exhaustedAt: null,
      archivedAt: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      orderCount: 1,
    }],
    summary: {
      total: overrides.total ?? 1,
      available: 1,
      exhausted: 0,
      unknown: 0,
      checkFailed: 0,
      totalRemaining: 2,
      totalUsed: 1,
      localSubmitCount: 1,
    },
    total: overrides.total ?? 1,
    page: 1,
    limit: 20,
  };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}
