// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useOrderTracking } from './useSocket';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const socketClient = vi.hoisted(() => {
  const socket = {
    connected: false,
    disconnect: vi.fn(),
    emit: vi.fn(),
    off: vi.fn(),
    on: vi.fn(),
    handlers: {} as Record<string, (...args: unknown[]) => void>,
  };

  return {
    io: vi.fn(() => socket),
    socket,
  };
});

vi.mock('socket.io-client', () => ({
  io: socketClient.io,
}));

function TrackingProbe({ onRefresh }: { onRefresh: () => void }) {
  useOrderTracking('track-1', onRefresh);
  return null;
}

function renderTrackingProbe(onRefresh: () => void) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TrackingProbe onRefresh={onRefresh} />);
  });
  return root;
}

describe('useOrderTracking', () => {
  let mountedRoot: Root | null = null;

  afterEach(() => {
    vi.clearAllMocks();
    socketClient.socket.connected = false;
    socketClient.socket.handlers = {};
    if (mountedRoot) {
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
    }
    document.body.innerHTML = '';
  });

  it('joins the order room and refreshes after the socket connects', () => {
    socketClient.socket.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      socketClient.socket.handlers[event] = handler;
      return socketClient.socket;
    });
    const onRefresh = vi.fn();

    mountedRoot = renderTrackingProbe(onRefresh);
    act(() => socketClient.socket.handlers.connect?.());

    expect(socketClient.socket.emit).toHaveBeenCalledWith('join', { trackingToken: 'track-1' });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
