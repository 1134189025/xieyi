import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';

export function useSocket(namespace: string, authToken?: string | null) {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(namespace, {
      auth: authToken ? { token: authToken } : undefined,
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [namespace, authToken]);

  return socketRef;
}

export function useOrderTracking(
  trackingToken: string | undefined,
  onStatusChange: (data: { status: string; completedAt: string | null }) => void,
) {
  useEffect(() => {
    if (!trackingToken) return;

    const socket = io('/orders', { transports: ['websocket', 'polling'] });
    socket.emit('join', { trackingToken });
    socket.on('order:status', onStatusChange);

    return () => {
      socket.disconnect();
    };
  }, [trackingToken, onStatusChange]);
}
