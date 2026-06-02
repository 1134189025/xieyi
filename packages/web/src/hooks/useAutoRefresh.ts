import { useEffect, useRef } from 'react';

export const AUTO_REFRESH_INTERVAL_MS = 10_000;

export function useAutoRefresh(
  refresh: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
) {
  const refreshRef = useRef(refresh);
  const inFlightRef = useRef(false);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;

    const intervalId = window.setInterval(() => {
      if (inFlightRef.current) return;

      inFlightRef.current = true;
      Promise.resolve(refreshRef.current())
        .catch(() => undefined)
        .finally(() => {
          inFlightRef.current = false;
        });
    }, intervalMs);

    return () => window.clearInterval(intervalId);
  }, [enabled, intervalMs]);
}
