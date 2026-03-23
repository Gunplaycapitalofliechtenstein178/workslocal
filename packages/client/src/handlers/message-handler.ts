import type { ServerMessage } from '@workslocal/shared';

import type { ClientContext } from '../client-context.js';
import type { TunnelInfo } from '../types.js';

import { handleHttpRequest } from './http-handler.js';
import {
  handleWsCloseFromServer,
  handleWsFrameFromServer,
  handleWsOpen,
} from './ws-passthrough.js';

export async function handleMessage(ctx: ClientContext, raw: string): Promise<void> {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(raw) as ServerMessage;
  } catch {
    ctx.log.warn('Invalid JSON from server', { raw: raw.slice(0, 100) });
    return;
  }

  switch (msg.type) {
    case 'tunnel_created':
      handleTunnelCreated(ctx, msg);
      break;

    case 'tunnel_closed':
      handleTunnelClosed(ctx, msg);
      break;

    case 'http_request':
      await handleHttpRequest(ctx, msg);
      break;

    case 'pong':
      // Heartbeat acknowledged
      break;

    case 'error':
      handleError(ctx, msg);
      break;

    case 'domains_updated':
      ctx.log.info('Domains updated', { domains: msg.domains });
      break;

    case 'ws_open':
      handleWsOpen(
        ctx,
        msg as unknown as {
          type: 'ws_open';
          request_id: string;
          path: string;
          headers: Record<string, string>;
          query: Record<string, string>;
          protocol: string;
        },
      );
      break;

    case 'ws_frame':
      handleWsFrameFromServer(
        ctx,
        msg as unknown as {
          type: 'ws_frame';
          request_id: string;
          data: string;
          is_binary: boolean;
        },
      );
      break;

    case 'ws_close':
      handleWsCloseFromServer(
        ctx,
        msg as unknown as {
          type: 'ws_close';
          request_id: string;
          code: number;
          reason: string;
        },
      );
      break;

    default:
      ctx.log.warn('Unknown message type from server', {
        type: (msg as { type: string }).type,
      });
  }
}

function handleTunnelCreated(
  ctx: ClientContext,
  msg: {
    tunnel_id: string;
    public_url: string;
    subdomain: string;
    domain: string;
    expires_at: string;
    is_persistent?: boolean;
    user_id?: string | null;
  },
): void {
  const tunnel: TunnelInfo = {
    tunnelId: msg.tunnel_id,
    publicUrl: msg.public_url,
    subdomain: msg.subdomain,
    domain: msg.domain,
    localPort: ctx.pendingPort ?? 0,
    expiresAt: msg.expires_at || null,
    isPersistent: msg.is_persistent ?? false,
    userId: msg.user_id ?? null,
    createdAt: new Date(),
  };

  ctx.tunnels.set(tunnel.tunnelId, tunnel);
  ctx.portMap.set(tunnel.tunnelId, tunnel.localPort);
  ctx.pendingPort = null;

  ctx.log.info('Tunnel created', {
    tunnelId: tunnel.tunnelId,
    publicUrl: tunnel.publicUrl,
    isPersistent: String(tunnel.isPersistent),
  });

  ctx.emit('tunnel:created', tunnel);
}

function handleTunnelClosed(ctx: ClientContext, msg: { tunnel_id: string; reason: string }): void {
  const tunnel = ctx.tunnels.get(msg.tunnel_id);
  ctx.tunnels.delete(msg.tunnel_id);
  ctx.portMap.delete(msg.tunnel_id);

  ctx.log.info('Tunnel closed', {
    tunnelId: msg.tunnel_id,
    reason: msg.reason,
    subdomain: tunnel?.subdomain ?? 'unknown',
  });

  ctx.emit('tunnel:closed', msg.tunnel_id, msg.reason);
}

function handleError(ctx: ClientContext, msg: { code: string; message: string }): void {
  ctx.log.warn('Server error', { code: msg.code, message: msg.message });
  ctx.emit('error', new Error(`[${msg.code}] ${msg.message}`));
}
