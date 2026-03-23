import {
  ANONYMOUS_TUNNEL_TTL_MS,
  MAX_TUNNELS_AUTHENTICATED,
  RESERVED_SUBDOMAINS,
  SUBDOMAIN_REGEX,
} from '@workslocal/shared';

import { authenticateRequest, type AuthResult } from '../auth.js';
import { createDb } from '../db/index.js';
import { findTunnelBySubdomain, getUserTunnelCount, reserveSubdomain } from '../db/queries.js';
import { generateId } from '../utils/id.js';

import { removeTunnel } from './cleanup.js';
import type { TunnelContext, WireCloseTunnel, WireCreateTunnel } from './types.js';
import { generateRandomSubdomain, log } from './types.js';

export async function handleCreateTunnel(
  ctx: TunnelContext,
  ws: WebSocket,
  msg: WireCreateTunnel,
): Promise<void> {
  if (ctx.tunnel) {
    ctx.sendError(ws, 'TUNNEL_EXISTS', 'This connection already has an active tunnel');
    return;
  }

  const domain = msg.domain ?? 'workslocal.exposed';
  const tunnelDomains = ctx.env.TUNNEL_DOMAINS.split(',').map((d) => d.trim());

  if (!tunnelDomains.includes(domain)) {
    ctx.sendError(ws, 'DOMAIN_INVALID', `Invalid domain: ${domain}`);
    return;
  }

  // ─── Authenticate if token provided ──────────────────
  let auth: AuthResult = { authenticated: true, userId: null, email: null, error: null };
  const isAuthenticated = Boolean(msg.auth_token);

  if (msg.auth_token) {
    auth = await authenticateToken(ctx, msg.auth_token);
    if (!auth.authenticated || !auth.userId) {
      ctx.sendError(ws, 'AUTH_FAILED', auth.error ?? 'Invalid authentication token');
      return;
    }
  }

  // ─── Determine subdomain ─────────────────────────────
  let subdomain: string;
  if (msg.custom_name) {
    if (!SUBDOMAIN_REGEX.test(msg.custom_name)) {
      ctx.sendError(
        ws,
        'SUBDOMAIN_INVALID',
        'Subdomain must be lowercase alphanumeric with optional hyphens (1-50 chars)',
      );
      return;
    }
    if (RESERVED_SUBDOMAINS.includes(msg.custom_name as (typeof RESERVED_SUBDOMAINS)[number])) {
      ctx.sendError(ws, 'SUBDOMAIN_RESERVED', `Subdomain "${msg.custom_name}" is reserved`);
      return;
    }
    subdomain = msg.custom_name;
  } else {
    subdomain = generateRandomSubdomain();
  }

  // ─── Check limits ────────────────────────────────────
  if (isAuthenticated && auth.userId) {
    const db = createDb(ctx.env.DB);
    const count = await getUserTunnelCount(db, auth.userId);
    if (count >= MAX_TUNNELS_AUTHENTICATED) {
      ctx.sendError(
        ws,
        'MAX_TUNNELS_REACHED',
        `Maximum ${String(MAX_TUNNELS_AUTHENTICATED)} persistent subdomains allowed. Revoke old ones to create new.`,
      );
      return;
    }
  }

  // ─── Check subdomain availability ────────────────────
  const kvKey = `tunnel:${domain}:${subdomain}`;
  const existing = await ctx.env.KV.get(kvKey);

  if (existing) {
    const canReclaim = await canReclaimSubdomain(ctx, subdomain, domain, msg, auth);
    if (!canReclaim) {
      ctx.sendError(ws, 'SUBDOMAIN_TAKEN', `Subdomain "${subdomain}" is already in use`);
      return;
    }
    await ctx.env.KV.delete(`reserved:${domain}:${subdomain}`);
  } else {
    const reservationKey = `reserved:${domain}:${subdomain}`;
    const reservedBy = await ctx.env.KV.get(reservationKey);
    if (reservedBy) {
      const canReclaim = canReclaimReservation(reservedBy, msg, auth);
      if (!canReclaim) {
        ctx.sendError(ws, 'SUBDOMAIN_TAKEN', `Subdomain "${subdomain}" is temporarily reserved`);
        return;
      }
      await ctx.env.KV.delete(reservationKey);
    } else if (isAuthenticated && auth.userId) {
      const db = createDb(ctx.env.DB);
      const d1Tunnel = await findTunnelBySubdomain(db, subdomain, domain);
      if (d1Tunnel && d1Tunnel.userId !== auth.userId) {
        ctx.sendError(ws, 'SUBDOMAIN_TAKEN', `Subdomain "${subdomain}" is owned by another user`);
        return;
      }
    }
  }

  // ─── Register tunnel ─────────────────────────────────
  const connectionName = `conn:${ctx.connectionId}`;
  const isPersistent = isAuthenticated && auth.userId !== null;

  if (isPersistent && auth.userId) {
    const db = createDb(ctx.env.DB);
    await reserveSubdomain(db, auth.userId, subdomain, domain);
    await ctx.env.KV.put(kvKey, connectionName);
  } else {
    await ctx.env.KV.put(kvKey, connectionName, {
      expirationTtl: Math.floor(ANONYMOUS_TUNNEL_TTL_MS / 1000),
    });
  }

  // ─── Store tunnel info ───────────────────────────────
  const tunnelId = generateId();
  const publicUrl = `https://${subdomain}.${domain}`;
  const expiresAt = isPersistent
    ? null
    : new Date(Date.now() + ANONYMOUS_TUNNEL_TTL_MS).toISOString();

  ctx.tunnel = {
    tunnelId,
    subdomain,
    domain,
    localPort: msg.local_port,
    anonymousToken: msg.anonymous_token ?? null,
    userId: auth.userId,
    isPersistent,
    createdAt: new Date().toISOString(),
  };

  await ctx.doState.storage.put('tunnel', ctx.tunnel);
  await ctx.doState.storage.deleteAlarm();

  ws.send(
    JSON.stringify({
      type: 'tunnel_created',
      tunnel_id: tunnelId,
      public_url: publicUrl,
      subdomain,
      domain,
      expires_at: expiresAt ?? '',
      is_persistent: isPersistent,
      user_id: auth.userId ?? null,
    }),
  );

  log.info('Tunnel created', {
    publicUrl,
    connectionId: ctx.connectionId ?? 'unknown',
    isPersistent: String(isPersistent),
    userId: auth.userId ?? 'anonymous',
  });
}

export async function handleCloseTunnel(
  ctx: TunnelContext,
  ws: WebSocket,
  msg: WireCloseTunnel,
): Promise<void> {
  if (!ctx.tunnel || ctx.tunnel.tunnelId !== msg.tunnel_id) {
    ctx.sendError(ws, 'TUNNEL_NOT_FOUND', 'Tunnel not found on this connection');
    return;
  }

  const tunnelId = ctx.tunnel.tunnelId;
  await removeTunnel(ctx, 'client_requested');

  ws.send(
    JSON.stringify({
      type: 'tunnel_closed',
      tunnel_id: tunnelId,
      reason: 'client_requested',
    }),
  );
}

// ─── Subdomain Reclaim Logic ───────────────────────────

async function canReclaimSubdomain(
  ctx: TunnelContext,
  subdomain: string,
  domain: string,
  msg: WireCreateTunnel,
  auth: AuthResult,
): Promise<boolean> {
  if (auth.userId) {
    const db = createDb(ctx.env.DB);
    const d1Tunnel = await findTunnelBySubdomain(db, subdomain, domain);
    if (d1Tunnel && d1Tunnel.userId === auth.userId) {
      return true;
    }
  }

  const reservationKey = `reserved:${domain}:${subdomain}`;
  const reservedBy = await ctx.env.KV.get(reservationKey);
  if (reservedBy && reservedBy === msg.anonymous_token) {
    return true;
  }

  return false;
}

function canReclaimReservation(
  reservedBy: string,
  msg: WireCreateTunnel,
  auth: AuthResult,
): boolean {
  if (auth.userId && reservedBy === `user:${auth.userId}`) {
    return true;
  }
  if (msg.anonymous_token && reservedBy === msg.anonymous_token) {
    return true;
  }
  return false;
}

// ─── Auth Helper ───────────────────────────────────────

async function authenticateToken(ctx: TunnelContext, token: string): Promise<AuthResult> {
  const fakeRequest = new Request('https://localhost/', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return authenticateRequest(fakeRequest, ctx.env);
}
