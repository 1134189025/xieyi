import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

export function useSocket(namespace: string, authToken?: string | null) {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const nextSocket = io(namespace, {
      auth: authToken ? { token: authToken } : undefined,
      transports: ['websocket', 'polling'],
    });
    setSocket(nextSocket);

    return () => {
      nextSocket.disconnect();
      setSocket(null);
    };
  }, [namespace, authToken]);

  return socket;
}

export function useOrderTracking(
  trackingToken: string | undefined,
  onStatusChange: (data: { status: string; completedAt: string | null }) => void,
) {
  useEffect(() => {
    if (!trackingToken) return;

    const socket = io('/orders', { transports: ['websocket', 'polling'] });
    const joinRoom = () => socket.emit('join', { trackingToken });
    socket.on('connect', joinRoom);
    joinRoom();
    socket.on('order:status', onStatusChange);

    return () => {
      socket.off('connect', joinRoom);
      socket.off('order:status', onStatusChange);
      socket.disconnect();
    };
  }, [trackingToken, onStatusChange]);
}
