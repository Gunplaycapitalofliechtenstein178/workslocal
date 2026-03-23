import { HEARTBEAT_INTERVAL_MS, type ClientMessage } from '@workslocal/shared';
import WebSocket from 'ws';

export function startHeartbeat(
  send: (msg: ClientMessage) => void,
  wsGetter: () => WebSocket | null,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    const ws = wsGetter();
    if (ws && ws.readyState === WebSocket.OPEN) {
      send({ type: 'ping', timestamp: Date.now() });
    }
  }, HEARTBEAT_INTERVAL_MS);

  timer.unref();
  return timer;
}

export function stopHeartbeat(timer: NodeJS.Timeout | null): void {
  if (timer) {
    clearInterval(timer);
  }
}
