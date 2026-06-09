// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { publicApi } from '../../api/client';
import TrackOrderPage from './TrackOrderPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const trackingSocket = vi.hoisted(() => ({
  refresh: null as null | (() => void),
}));

vi.mock('../../api/client', () => ({
  publicApi: {
    get: vi.fn(),
  },
}));

vi.mock('../../hooks/useSocket', () => ({
  useOrderTracking: vi.fn((_trackingToken: string, refresh: () => void) => {
    trackingSocket.refresh = refresh;
  }),
}));

function pendingOrder(queueEstimate: unknown, overrides: Record<string, unknown> = {}) {
  return {
    trackingToken: 'track-1',
    status: 'PENDING_PAYMENT',
    paymentHandler: 'LOCAL_WORKER',
    outsourcedPaymentStatus: null,
    pixCode: 'pix-code',
    pixQrPngBase64: null,
    pixExpiresAt: '2026-06-01T01:00:00.000Z',
    pixImageUrl: null,
    completedAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    errorMessage: null,
    queueEstimate,
    ...overrides,
  };
}

function completedOrder() {
  return {
    ...pendingOrder(null),
    status: 'PAYMENT_COMPLETED',
    completedAt: '2026-06-01T00:10:00.000Z',
  };
}

function creatingOrder(queueEstimate: unknown) {
  return {
    trackingToken: 'track-1',
    status: 'CREATING_PAYMENT',
    paymentHandler: 'LOCAL_WORKER',
    outsourcedPaymentStatus: null,
    pixCode: null,
    pixQrPngBase64: null,
    pixExpiresAt: null,
    pixImageUrl: null,
    completedAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    errorMessage: null,
    queueEstimate,
  };
}

function failedOrder(errorMessage: string | null) {
  return {
    ...creatingOrder(null),
    status: 'FAILED',
    errorMessage,
  };
}

function renderTrackOrderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/track/track-1']}>
        <Routes>
          <Route path="/track/:trackingToken" element={<TrackOrderPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });

  return { container, root };
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TrackOrderPage', () => {
  let mountedRoot: Root | null = null;

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    trackingSocket.refresh = null;
    if (mountedRoot) {
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
    }
    document.body.innerHTML = '';
  });

  it('shows generation queue position for creating payment orders without exposing Pix code', async () => {
    (publicApi.get as Mock).mockResolvedValue({
      data: creatingOrder({
        ordersAhead: 2,
        position: 3,
        pendingTotal: 7,
        currentGenerationCount: 2,
        estimatedQueueSeconds: 15 * 60,
        secondsPerOrder: 5 * 60,
        calculationSource: 'generation_queue',
        calculatedAt: '2026-06-01T00:00:00.000Z',
      }),
    });

    const { container, root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.textContent).toContain('正在排队生成 Pix 二维码');
    expect(container.textContent).toContain('排队 #3');
    expect(container.textContent).toContain('前方 2 单');
    expect(container.textContent).toContain('生成中 2 单');
    expect(container.textContent).toContain('预计约 15 分钟');
    expect(container.querySelector<HTMLInputElement>('input[readonly]')).toBeNull();
  });

  it('refreshes creating payment orders every 5 seconds and shows Pix when generation finishes', async () => {
    vi.useFakeTimers();
    (publicApi.get as Mock)
      .mockResolvedValueOnce({ data: creatingOrder(null) })
      .mockResolvedValueOnce({ data: pendingOrder(null) });

    const { container, root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    expect(publicApi.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(publicApi.get).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('pix-code');
  });

  it('refreshes order details when the tracking socket reports a status change', async () => {
    (publicApi.get as Mock)
      .mockResolvedValueOnce({ data: creatingOrder(null) })
      .mockResolvedValueOnce({ data: pendingOrder(null) });

    const { container, root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    act(() => trackingSocket.refresh?.());
    await flushAsyncWork();

    expect(publicApi.get).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('pix-code');
  });

  it('shows pending payment queue estimate and keeps Pix payment code', async () => {
    (publicApi.get as Mock).mockResolvedValue({
      data: pendingOrder({
        ordersAhead: 2,
        position: 3,
        pendingTotal: 5,
        estimatedQueueSeconds: 15 * 60,
        secondsPerOrder: 5 * 60,
        calculationSource: 'recent_completion_cadence',
        calculatedAt: '2026-06-01T00:00:00.000Z',
      }),
    });

    const { container, root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.textContent).toContain('前方 2 单');
    expect(container.textContent).toContain('排队第 3 位');
    expect(container.textContent).toContain('预计约 15 分钟');
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('pix-code');
  });

  it('shows outsourced pending payment with safe tracking details', async () => {
    (publicApi.get as Mock).mockResolvedValue({
      data: pendingOrder(null, {
        paymentHandler: 'OUTSOURCED_BUYER_API',
        outsourcedPaymentStatus: 'authorizing',
        pixCode: null,
        pixQrPngBase64: null,
        pixImageUrl: null,
        queueEstimate: null,
      }),
    });

    const { container, root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.textContent).toContain('自动支付处理中');
    expect(container.textContent).toContain('正在支付中');
    expect(container.textContent).toContain('Pix 已提交到自动支付通道');
    expect(container.textContent).toContain('追踪码');
    expect(container.textContent).toContain('track-1');
    expect(container.textContent).toContain('创建时间');
    expect(container.textContent).toContain('当前阶段');
    expect(container.textContent).toContain('长时间未完成');
    expect(container.textContent).not.toContain('外包状态');
    expect(container.textContent).not.toContain('authorizing');
    expect(container.textContent).not.toContain('请让工人扫描二维码');
    expect(container.textContent).not.toContain('排队第');
    expect(container.textContent).not.toContain('提交新订单');
    expect(container.querySelector<HTMLInputElement>('input[readonly]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="复制 Pix 付款码"]')).toBeNull();
    expect(container.querySelector<HTMLImageElement>('img[alt="Pix 二维码"]')).toBeNull();
  });

  it('shows Pix image when payment code is absent but pixImageUrl is available', async () => {
    (publicApi.get as Mock).mockResolvedValue({
      data: {
        ...pendingOrder(null),
        pixCode: null,
        pixImageUrl: 'https://stripe.test/pix.png',
      },
    });

    const { container, root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.querySelector<HTMLImageElement>('img[alt="Pix 二维码"]')?.src).toBe('https://stripe.test/pix.png');
    expect(container.querySelector<HTMLInputElement>('input[readonly]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="复制 Pix 付款码"]')).toBeNull();
  });

  it('shows hosted Pix instructions as a link instead of a broken QR image', async () => {
    (publicApi.get as Mock).mockResolvedValue({
      data: {
        ...pendingOrder(null),
        pixCode: null,
        pixImageUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
      },
    });

    const { container, root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.querySelector<HTMLImageElement>('img[alt="Pix 二维码"]')).toBeNull();
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://checkout.stripe.com/c/pay/cs_test_123"]')?.textContent).toContain('打开 Pix 付款说明');
    expect(container.querySelector<HTMLInputElement>('input[readonly]')).toBeNull();
  });

  it('refreshes pending payment orders every 10 seconds and shows completion automatically', async () => {
    vi.useFakeTimers();
    (publicApi.get as Mock)
      .mockResolvedValueOnce({ data: pendingOrder(null) })
      .mockResolvedValueOnce({ data: completedOrder() });

    const { container, root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('pix-code');

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(publicApi.get).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.success-icon')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[readonly]')).toBeNull();
  });

  it('shows the safe failure reason returned by the tracking API', async () => {
    (publicApi.get as Mock).mockResolvedValue({
      data: failedOrder('账号无资格，无法生成 Pix 支付，请更换账号后重新提交。'),
    });

    const { container, root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.textContent).toContain('订单失败');
    expect(container.textContent).toContain('账号无资格，无法生成 Pix 支付，请更换账号后重新提交。');
  });

  it('keeps the failed order view stable when no failure reason is returned', async () => {
    (publicApi.get as Mock).mockResolvedValue({
      data: failedOrder(null),
    });

    const { container, root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.textContent).toContain('订单失败');
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('null');
  });
});
