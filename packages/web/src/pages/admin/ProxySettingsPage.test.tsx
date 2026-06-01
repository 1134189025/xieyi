// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ProxySettingsPage from './ProxySettingsPage';
import api from '../../api/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    put: vi.fn(),
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

function mockSettingsResponse(autoDetectionEnabled = true) {
  (api.get as Mock)
    .mockResolvedValueOnce({
      data: {
        enabled: false,
        host: null,
        port: null,
        username: null,
        maskedProxy: null,
      },
    })
    .mockResolvedValueOnce({ data: { enabled: autoDetectionEnabled } });
}

async function renderSettingsPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<ProxySettingsPage />);
  });

  return { container, root };
}

describe('ProxySettingsPage', () => {
  let mountedRoot: Root | null = null;

  afterEach(() => {
    vi.clearAllMocks();
    if (mountedRoot) {
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
    }
    document.body.innerHTML = '';
  });

  it('loads proxy and auto payment detection settings', async () => {
    mockSettingsResponse(true);

    const { container, root } = await renderSettingsPage();
    mountedRoot = root;

    expect(api.get).toHaveBeenCalledWith('/admin/settings/proxy');
    expect(api.get).toHaveBeenCalledWith('/admin/settings/auto-payment-detection');
    expect(container.textContent).toContain('系统设置');
    expect(container.textContent).toContain('自动检测支付完成');
    expect(container.textContent).toContain('已开启');
  });

  it('saves auto payment detection switch', async () => {
    mockSettingsResponse(true);
    (api.put as Mock).mockResolvedValueOnce({ data: { enabled: false } });

    const { container, root } = await renderSettingsPage();
    mountedRoot = root;
    const toggleButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('已开启'),
    );
    expect(toggleButton).not.toBeUndefined();

    await act(async () => {
      toggleButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(api.put).toHaveBeenCalledWith('/admin/settings/auto-payment-detection', { enabled: false });
    expect(container.textContent).toContain('已关闭');
  });
});
