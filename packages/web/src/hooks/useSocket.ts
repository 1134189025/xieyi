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
  onRefresh: () => void,
) {
  useEffect(() => {
    if (!trackingToken) return;

    const socket = io('/orders', { transports: ['websocket', 'polling'] });
    const joinRoom = () => {
      socket.emit('join', { trackingToken });
      onRefresh();
    };
    socket.on('connect', joinRoom);
    if (socket.connected) joinRoom();
    socket.on('order:status', onRefresh);

    return () => {
      socket.off('connect', joinRoom);
      socket.off('order:status', onRefresh);
      socket.disconnect();
    };
  }, [trackingToken, onRefresh]);
}
