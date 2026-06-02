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
      params: { status: 'all', page: 1, limit: 20 },
    });
    expect(container.textContent).toContain('CODE-NEW');
    expect(container.textContent).not.toContain('CODE-OLD');
  });
});

function codeResponse(code: string) {
  return {
    id: code,
    code,
    batchLabel: null,
    usedAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    order: null,
  };
}
