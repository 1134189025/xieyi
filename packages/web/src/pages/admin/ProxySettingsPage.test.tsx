// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ProxySettingsPage from './ProxySettingsPage';
import api from '../../api/client';
import toast from 'react-hot-toast';

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

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, className }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function proxySettingsResponse() {
  return {
    chatGpt: {
      enabled: true,
      proxies: [{ id: 'chat-1', host: 'chat.example', port: 10000, username: 'chat-user', maskedProxy: 'http://chat-user:****@chat.example:10000', healthy: true }],
    },
    stripe: {
      enabled: true,
      proxies: [{ id: 'stripe-1', host: 'stripe.example', port: 10001, username: 'stripe-user', maskedProxy: 'http://stripe-user:****@stripe.example:10001', healthy: true }],
    },
  };
}

function paymentProcessingResponse(overrides: Partial<{
  handler: string;
  outsourcedBuyerApiBaseUrl: string;
  outsourcedActivationCodeCount: number;
  outsourcedActivationCodePreview: string[];
}> = {}) {
  return {
    handler: 'LOCAL_WORKER',
    outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
    outsourcedActivationCodeCount: 2,
    outsourcedActivationCodePreview: ['DP-F...ODE', 'DP-S...ODE'],
    ...overrides,
  };
}

function mockSettingsResponse(paymentProcessing = paymentProcessingResponse()) {
  (api.get as Mock)
    .mockResolvedValueOnce({ data: proxySettingsResponse() })
    .mockResolvedValueOnce({ data: { enabled: true } })
    .mockResolvedValueOnce({ data: { enabled: false } })
    .mockResolvedValueOnce({ data: paymentProcessing });
}

async function renderSettingsPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<ProxySettingsPage />);
    await Promise.resolve();
    await Promise.resolve();
  });

  return { container, root };
}

describe('ProxySettingsPage', () => {
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

  it('loads ChatGPT proxy pool, Stripe proxy pool, auto detection, and maintenance mode', async () => {
    mockSettingsResponse();

    const { container, root } = await renderSettingsPage();
    mountedRoot = root;

    expect(api.get).toHaveBeenCalledWith('/admin/settings/proxy');
    expect(api.get).toHaveBeenCalledWith('/admin/settings/auto-payment-detection');
    expect(api.get).toHaveBeenCalledWith('/admin/settings/maintenance-mode');
    expect(api.get).toHaveBeenCalledWith('/admin/settings/payment-processing');
    expect(container.textContent).toContain('ChatGPT 代理池');
    expect(container.textContent).toContain('Stripe 代理池');
    expect(container.textContent).toContain('付款处理方式');
    expect(container.textContent).toContain('本地工人扫码');
    expect(container.textContent).toContain('DP-F...ODE');
    expect(container.textContent).toContain('去管理外包兑换码');
    expect(container.querySelector('a[href="/admin/outsourced-activation-codes"]')).not.toBeNull();
    expect(container.textContent).toContain('维护模式');
    expect(container.textContent).toContain('http://chat-user:****@chat.example:10000');
    expect(container.textContent).not.toContain('chat-pass');
  });

  it('saves separate proxy pools and toggles maintenance mode', async () => {
    mockSettingsResponse();
    (api.put as Mock)
      .mockResolvedValueOnce({ data: proxySettingsResponse() })
      .mockResolvedValueOnce({ data: { enabled: true } });

    const { container, root } = await renderSettingsPage();
    mountedRoot = root;

    const textareas = container.querySelectorAll<HTMLTextAreaElement>('textarea');
    await act(async () => {
      setTextareaValue(textareas[0], 'chat.example:10000:chat-user:chat-pass');
      textareas[0].dispatchEvent(new Event('input', { bubbles: true }));
      setTextareaValue(textareas[1], 'stripe.example:10001:stripe-user:stripe-pass');
      textareas[1].dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('保存代理池'),
    );
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.put).toHaveBeenCalledWith('/admin/settings/proxy', {
      chatGptProxyPool: 'chat.example:10000:chat-user:chat-pass',
      stripeProxyPool: 'stripe.example:10001:stripe-user:stripe-pass',
    });

    const maintenanceButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('维护已关闭'),
    );
    await act(async () => {
      maintenanceButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.put).toHaveBeenCalledWith('/admin/settings/maintenance-mode', { enabled: true });
  });

  it('saves outsourced payment processing settings without exposing full activation codes', async () => {
    mockSettingsResponse();
    (api.put as Mock).mockResolvedValueOnce({
      data: {
        handler: 'OUTSOURCED_BUYER_API',
        outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
        outsourcedActivationCodeCount: 2,
        outsourcedActivationCodePreview: ['DP-F...ODE', 'DP-S...ODE'],
      },
    });

    const { container, root } = await renderSettingsPage();
    mountedRoot = root;

    const outsourcedButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('外包自动支付'),
    );
    const apiBaseUrlInput = container.querySelector<HTMLInputElement>('input[placeholder="https://scan.amazo.indevs.in"]');

    await act(async () => {
      outsourcedButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      setInputValue(apiBaseUrlInput!, 'https://scan.amazo.indevs.in/buyer/');
      apiBaseUrlInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('保存付款处理方式'),
    );
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.put).toHaveBeenCalledWith('/admin/settings/payment-processing', {
      handler: 'OUTSOURCED_BUYER_API',
      outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in/buyer/',
    });
    expect(container.textContent).toContain('外包自动支付');
    expect(container.textContent).toContain('DP-F...ODE');
    expect(container.textContent).not.toContain('DP-FIRST-CODE');
  });

  it('blocks outsourced payment processing when no outsourced activation codes are configured', async () => {
    mockSettingsResponse(paymentProcessingResponse({
      outsourcedActivationCodeCount: 0,
      outsourcedActivationCodePreview: [],
    }));

    const { container, root } = await renderSettingsPage();
    mountedRoot = root;

    const outsourcedButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('外包自动支付'),
    );
    await act(async () => {
      outsourcedButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('保存付款处理方式'),
    );
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.put).not.toHaveBeenCalledWith('/admin/settings/payment-processing', expect.anything());
    expect(toast.error).toHaveBeenCalledWith('请先导入外包兑换码，再开启外包自动支付');
  });

  it('refreshes settings every 10 seconds without clearing edited proxy textareas', async () => {
    vi.useFakeTimers();
    mockSettingsResponse();
    (api.get as Mock)
      .mockResolvedValueOnce({
        data: {
          chatGpt: {
            enabled: true,
            proxies: [{
              id: 'chat-2',
              host: 'chat2.example',
              port: 10002,
              username: 'chat-user',
              maskedProxy: 'http://chat-user:****@chat2.example:10002',
              healthy: false,
            }],
          },
          stripe: {
            enabled: true,
            proxies: [{
              id: 'stripe-2',
              host: 'stripe2.example',
              port: 10003,
              username: 'stripe-user',
              maskedProxy: 'http://stripe-user:****@stripe2.example:10003',
              healthy: true,
            }],
          },
        },
      })
      .mockResolvedValueOnce({ data: { enabled: false } })
      .mockResolvedValueOnce({ data: { enabled: true } })
      .mockResolvedValueOnce({
        data: {
          handler: 'OUTSOURCED_BUYER_API',
          outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
          outsourcedActivationCodeCount: 1,
          outsourcedActivationCodePreview: ['DP-N...ODE'],
        },
      });

    const { container, root } = await renderSettingsPage();
    mountedRoot = root;

    const textareas = container.querySelectorAll<HTMLTextAreaElement>('textarea');
    await act(async () => {
      setTextareaValue(textareas[0], 'chat.example:10000:chat-user:chat-pass');
      textareas[0].dispatchEvent(new Event('input', { bubbles: true }));
      setTextareaValue(textareas[1], 'stripe.example:10001:stripe-user:stripe-pass');
      textareas[1].dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.get).toHaveBeenCalledTimes(8);
    expect(textareas[0].value).toBe('chat.example:10000:chat-user:chat-pass');
    expect(textareas[1].value).toBe('stripe.example:10001:stripe-user:stripe-pass');
    expect(textareas).toHaveLength(2);
    expect(container.textContent).toContain('http://chat-user:****@chat2.example:10002');
  });
});

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}
