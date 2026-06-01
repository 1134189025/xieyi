// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { publicApi } from '../../api/client';
import TrackOrderPage from './TrackOrderPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const useOrderTracking = vi.hoisted(() => vi.fn());

vi.mock('../../api/client', () => ({
  publicApi: {
    get: vi.fn(),
  },
}));

vi.mock('../../hooks/useSocket', () => ({
  useOrderTracking,
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function pendingOrder(queueEstimate: unknown) {
  return {
    trackingToken: 'track-1',
    status: 'PENDING_PAYMENT',
    pixCode: 'pix-code',
    pixQrPngBase64: null,
    pixExpiresAt: '2026-06-01T01:00:00.000Z',
    pixImageUrl: null,
    completedAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    errorMessage: null,
    queueEstimate,
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
  });
}

describe('TrackOrderPage', () => {
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

  it('待支付订单展示预计排队时间并保留 Pix 付款码', async () => {
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

  it('队列估算为空时不展示预计排队时间', async () => {
    (publicApi.get as Mock).mockResolvedValue({ data: pendingOrder(null) });

    const { container, root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    expect(container.textContent).not.toContain('预计约');
    expect(container.textContent).not.toContain('排队第');
  });

  it('待支付订单每 60 秒静默刷新追踪接口', async () => {
    vi.useFakeTimers();
    (publicApi.get as Mock).mockResolvedValue({ data: pendingOrder(null) });

    const { root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    expect(publicApi.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(publicApi.get).toHaveBeenCalledTimes(2);
  });

  it('待支付订单静默刷新失败时保留已加载的订单内容', async () => {
    vi.useFakeTimers();
    (publicApi.get as Mock)
      .mockResolvedValueOnce({
        data: pendingOrder({
          ordersAhead: 1,
          position: 2,
          pendingTotal: 2,
          estimatedQueueSeconds: 5 * 60,
          secondsPerOrder: 5 * 60,
          calculationSource: 'default',
          calculatedAt: '2026-06-01T00:00:00.000Z',
        }),
      })
      .mockRejectedValueOnce({
        response: { data: { error: '临时网络错误' } },
      });

    const { container, root } = renderTrackOrderPage();
    mountedRoot = root;
    await flushAsyncWork();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('前方 1 单');
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('pix-code');
    expect(container.textContent).not.toContain('临时网络错误');
  });
});
