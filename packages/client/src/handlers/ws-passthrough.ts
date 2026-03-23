import type { ClientMessage } from '@workslocal/shared';
import WebSocket from 'ws';

import type { ClientContext } from '../client-context.js';

/**
 * Server tells us a browser opened a WebSocket to the tunnel URL.
 * Open a matching WebSocket to localhost.
 */
export function handleWsOpen(
  ctx: ClientContext,
  msg: {
    request_id: string;
    path: string;
    headers: Record<string, string>;
    query: Record<string, string>;
    protocol: string;
  },
): void {
  // Find the local port
  let localPort = 0;
  for (const [, port] of ctx.portMap.entries()) {
    localPort = port;
    break;
  }

  if (localPort === 0) {
    ctx.log.warn('No tunnel for WS connection', { requestId: msg.request_id });
    ctx.send({
      type: 'ws_close',
      request_id: msg.request_id,
      code: 1011,
      reason: 'No active tunnel',
    } as unknown as ClientMessage);
    return;
  }

  // Build local WebSocket URL
  const queryString = Object.entries(msg.query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const wsUrl = queryString
    ? `ws://localhost:${String(localPort)}${msg.path}?${queryString}`
    : `ws://localhost:${String(localPort)}${msg.path}`;

  const wsOptions: WebSocket.ClientOptions = {
    headers: { ...msg.headers },
  };

  if (msg.protocol) {
    wsOptions.protocol = msg.protocol;
  }

  ctx.log.info('Opening local WebSocket', {
    requestId: msg.request_id,
    url: wsUrl,
  });

  const localWs = new WebSocket(wsUrl, wsOptions);
  ctx.localWebSockets.set(msg.request_id, localWs);

  localWs.on('open', () => {
    ctx.log.debug('Local WebSocket connected', { requestId: msg.request_id });
  });

  localWs.on('message', (data: WebSocket.Data, isBinary: boolean) => {
    // Forward frame from localhost back to the relay → browser
    let base64Data: string;

    if (typeof data === 'string') {
      base64Data = Buffer.from(data, 'utf-8').toString('base64');
    } else if (Buffer.isBuffer(data)) {
      base64Data = data.toString('base64');
    } else if (Array.isArray(data)) {
      base64Data = Buffer.concat(data).toString('base64');
    } else {
      base64Data = Buffer.from(data).toString('base64');
    }

    ctx.send({
      type: 'ws_frame',
      request_id: msg.request_id,
      data: base64Data,
      is_binary: isBinary,
    } as unknown as ClientMessage);
  });

  localWs.on('close', (code: number, reason: Buffer) => {
    ctx.localWebSockets.delete(msg.request_id);
    ctx.log.debug('Local WebSocket closed', {
      requestId: msg.request_id,
      code: String(code),
    });

    ctx.send({
      type: 'ws_close',
      request_id: msg.request_id,
      code,
      reason: reason.toString('utf-8') || 'Local server closed connection',
    } as unknown as ClientMessage);
  });

  localWs.on('error', (err: Error) => {
    ctx.localWebSockets.delete(msg.request_id);
    ctx.log.warn('Local WebSocket error', {
      requestId: msg.request_id,
      err: err.message,
    });

    ctx.send({
      type: 'ws_close',
      request_id: msg.request_id,
      code: 1011,
      reason: `Local WebSocket error: ${err.message}`,
    } as unknown as ClientMessage);
  });
}

/**
 * Server sends a WS frame from the browser.
 * Forward it to the local WebSocket.
 */
export function handleWsFrameFromServer(
  ctx: ClientContext,
  msg: {
    request_id: string;
    data: string;
    is_binary: boolean;
  },
): void {
  const localWs = ctx.localWebSockets.get(msg.request_id);
  if (!localWs || localWs.readyState !== WebSocket.OPEN) return;

  const decoded = Buffer.from(msg.data, 'base64');

  if (msg.is_binary) {
    localWs.send(decoded);
  } else {
    localWs.send(decoded.toString('utf-8'));
  }
}

/**
 * Server tells us the browser closed the WS.
 * Close the corresponding local WebSocket.
 */
export function handleWsCloseFromServer(
  ctx: ClientContext,
  msg: {
    request_id: string;
    code: number;
    reason: string;
  },
): void {
  const localWs = ctx.localWebSockets.get(msg.request_id);
  if (!localWs) return;

  try {
    localWs.close(msg.code, msg.reason);
  } catch {
    // Already closed
  }
  ctx.localWebSockets.delete(msg.request_id);
}
