import { SUBDOMAIN_RESERVATION_MS } from '@workslocal/shared';

import { createDb } from '../db/index.js';
import { updateTunnelActivity } from '../db/queries.js';

import type { TunnelContext } from './types.js';
import { log } from './types.js';

export async function cleanup(ctx: TunnelContext): Promise<void> {
  // Close all user WebSocket connections
  for (const [requestId, socket] of ctx.userSockets) {
    try {
      socket.close(1001, 'Tunnel disconnected');
    } catch {
      // Already closed
    }
    log.info('Closing user WebSocket on tunnel disconnect', { requestId });
  }
  ctx.userSockets.clear();

  // Resolve all pending HTTP requests
  for (const [, pending] of ctx.pendingRequests) {
    clearTimeout(pending.timer);
    pending.resolve(
      Response.json(
        {
          ok: false,
          error: { code: 'CONNECTION_CLOSED', message: 'Tunnel client disconnected' },
        },
        { status: 502 },
      ),
    );
  }
  ctx.pendingRequests.clear();

  if (ctx.tunnel) {
    await removeTunnel(ctx, 'client_disconnected');
  }

  await ctx.doState.storage.delete('connectionId');
  ctx.connectionId = null;
}

export async function removeTunnel(ctx: TunnelContext, reason: string): Promise<void> {
  if (!ctx.tunnel) return;

  const { subdomain, domain, anonymousToken, userId, isPersistent } = ctx.tunnel;
  const kvKey = `tunnel:${domain}:${subdomain}`;

  await ctx.env.KV.delete(kvKey);

  if (isPersistent && userId) {
    const db = createDb(ctx.env.DB);
    await updateTunnelActivity(db, subdomain, domain);

    const reservationKey = `reserved:${domain}:${subdomain}`;
    await ctx.env.KV.put(reservationKey, `user:${userId}`, {
      expirationTtl: 30 * 24 * 60 * 60,
    });
  } else if (anonymousToken) {
    const reservationKey = `reserved:${domain}:${subdomain}`;
    await ctx.env.KV.put(reservationKey, anonymousToken, {
      expirationTtl: Math.floor(SUBDOMAIN_RESERVATION_MS / 1000),
    });
    await ctx.doState.storage.setAlarm(Date.now() + SUBDOMAIN_RESERVATION_MS);
  }

  log.info('Tunnel removed', { subdomain, domain, reason, isPersistent: String(isPersistent) });

  ctx.tunnel = null;
  await ctx.doState.storage.delete('tunnel');
}
