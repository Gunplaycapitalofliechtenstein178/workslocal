import type { HttpRequestMessage } from '@workslocal/shared';

import type { ClientContext } from '../client-context.js';
import type { CapturedRequest } from '../types.js';

export async function handleHttpRequest(
  ctx: ClientContext,
  msg: HttpRequestMessage,
): Promise<void> {
  const startTime = Date.now();

  // Find which local port this tunnel maps to.
  // http_request doesn't include tunnel_id - use first tunnel on this connection.
  let localPort = 0;
  let tunnelId = '';
  for (const [id, port] of ctx.portMap.entries()) {
    localPort = port;
    tunnelId = id;
    break;
  }

  if (localPort === 0 && !ctx.proxyOverride) {
    ctx.log.warn('No tunnel found for incoming request', {
      requestId: msg.request_id,
    });
    ctx.send({
      type: 'http_response',
      request_id: msg.request_id,
      status_code: 502,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('No active tunnel').toString('base64'),
    });
    return;
  }

  ctx.emit('request:start', msg.request_id, msg.method, msg.path);

  try {
    // Use proxyOverride (catch mode) or LocalProxy (http mode)
    let response;
    if (ctx.proxyOverride) {
      response = await ctx.proxyOverride(msg);
    } else {
      response = await ctx.localProxy.forward(msg, localPort);
    }

    const durationMs = Date.now() - startTime;

    ctx.send({
      type: 'http_response',
      request_id: msg.request_id,
      status_code: response.statusCode,
      headers: response.headers,
      body: response.body,
    });

    const captured: CapturedRequest = {
      requestId: msg.request_id,
      tunnelId,
      method: msg.method,
      path: msg.path,
      query: msg.query,
      requestHeaders: msg.headers,
      requestBody: msg.body,
      responseStatusCode: response.statusCode,
      responseHeaders: response.headers,
      responseBody: response.body,
      responseTimeMs: durationMs,
      timestamp: new Date(),
    };

    ctx.requestStore.add(captured);
    ctx.emit('request:complete', captured);
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    ctx.log.error('Failed to forward request', {
      requestId: msg.request_id,
      err: errMessage,
    });

    ctx.send({
      type: 'http_response',
      request_id: msg.request_id,
      status_code: 502,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from(`Proxy error: ${errMessage}`).toString('base64'),
    });

    ctx.emit('request:error', msg.request_id, errMessage);
  }
}
