// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAutoRefresh } from './useAutoRefresh';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function AutoRefreshProbe({
  enabled = true,
  intervalMs = 10_000,
  onRefresh,
}: {
  enabled?: boolean;
  intervalMs?: number;
  onRefresh: (value: number) => void;
}) {
  const [value, setValue] = useState(1);
  useAutoRefresh(() => onRefresh(value), intervalMs, enabled);
  return <button onClick={() => setValue(2)}>change</button>;
}

describe('useAutoRefresh', () => {
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

  it('runs the latest callback on the configured interval', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    mountedRoot = createRoot(container);

    act(() => mountedRoot?.render(<AutoRefreshProbe onRefresh={onRefresh} />));
    act(() => container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => vi.advanceTimersByTime(10_000));

    expect(onRefresh).toHaveBeenCalledWith(2);
  });

  it('does not start an interval when disabled', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    mountedRoot = createRoot(container);

    act(() => mountedRoot?.render(<AutoRefreshProbe enabled={false} onRefresh={onRefresh} />));
    act(() => vi.advanceTimersByTime(10_000));

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
