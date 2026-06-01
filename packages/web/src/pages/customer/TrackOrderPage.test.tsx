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

function creatingOrder(queueEstimate: unknown) {
  return {
    trackingToken: 'track-1',
    status: 'CREATING_PAYMENT',
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

  it('refreshes creating payment orders every 60 seconds', async () => {
    vi.useFakeTimers();
    (publicApi.get as Mock).mockResolvedValue({ data: creatingOrder(null) });

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
});
