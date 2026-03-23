import type { Env } from '../types.js';

import { cleanup, removeTunnel } from './cleanup.js';
import { handleCloseTunnel, handleCreateTunnel } from './creation.js';
import { handleHttpResponse, handleTunnelHttp } from './http-handler.js';
import type { PendingRequest, TunnelContext, TunnelInfo, WireClientMessage } from './types.js';
import { log } from './types.js';
import { handleWsClose, handleWsFrame } from './ws-passthrough.js';

export class TunnelDO implements DurableObject, TunnelContext {
  readonly doState: DurableObjectState;
  readonly env: Env;
  connectionId: string | null = null;
  tunnel: TunnelInfo | null = null;
  readonly pendingRequests = new Map<string, PendingRequest>();
  readonly userSockets = new Map<string, WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    this.doState = state;
    this.env = env;

    // Restore state from DO storage (survives hibernation)
    void this.doState.blockConcurrencyWhile(async () => {
      this.tunnel = (await this.doState.storage.get<TunnelInfo>('tunnel')) ?? null;
      this.connectionId = (await this.doState.storage.get<string>('connectionId')) ?? null;
    });
  }

  // ─── Get active WebSocket (Hibernation API) ──────────────

  getWebSocket(): WebSocket | null {
    const sockets = this.doState.getWebSockets();
    return sockets.length > 0 ? sockets[0]! : null;
  }

  // ─── Fetch handler ───────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const requestType = request.headers.get('X-Tunnel-Request-Type');

    if (requestType === 'http') {
      return handleTunnelHttp(this, request);
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    return Response.json({
      ok: true,
      data: {
        hasConnection: this.getWebSocket() !== null,
        tunnel: this.tunnel
          ? {
              tunnelId: this.tunnel.tunnelId,
              subdomain: this.tunnel.subdomain,
              domain: this.tunnel.domain,
              isPersistent: this.tunnel.isPersistent,
              userId: this.tunnel.userId,
            }
          : null,
      },
    });
  }

  // ─── WebSocket Handling (CLI ↔ Relay) ────────────────────

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const existingWs = this.getWebSocket();
    if (existingWs) {
      try {
        existingWs.close(1000, 'New connection replacing old one');
      } catch {
        // Already closed
      }
    }

    this.connectionId = request.headers.get('X-Connection-Id') ?? crypto.randomUUID();

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.doState.acceptWebSocket(server);

    await this.doState.storage.put('connectionId', this.connectionId);

    log.info('WebSocket connected', { connectionId: this.connectionId });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // ─── WebSocket Hibernation API callbacks ─────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      this.sendError(ws, 'INVALID_MESSAGE', 'Binary messages not supported');
      return;
    }

    let msg: WireClientMessage;
    try {
      msg = JSON.parse(message) as WireClientMessage;
    } catch {
      this.sendError(ws, 'INVALID_JSON', 'Invalid JSON message');
      return;
    }

    switch (msg.type) {
      case 'create_tunnel':
        await handleCreateTunnel(this, ws, msg);
        break;

      case 'close_tunnel':
        await handleCloseTunnel(this, ws, msg);
        break;

      case 'http_response':
        handleHttpResponse(this, msg);
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
        break;

      case 'ws_frame':
        handleWsFrame(this, msg);
        break;

      case 'ws_close':
        handleWsClose(this, msg);
        break;

      default:
        this.sendError(
          ws,
          'UNKNOWN_MESSAGE',
          `Unknown message type: ${(msg as { type: string }).type}`,
        );
    }
  }

  async webSocketClose(_ws: WebSocket, code: number, reason: string): Promise<void> {
    log.info('WebSocket closed', {
      connectionId: this.connectionId ?? 'unknown',
      code: String(code),
      reason,
    });
    await cleanup(this);
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    log.error('WebSocket error', {
      connectionId: this.connectionId ?? 'unknown',
      err: String(error),
    });
    await cleanup(this);
  }

  // ─── Alarm ───────────────────────────────────────────────

  async alarm(): Promise<void> {
    log.info('Alarm fired — reservation expired', {
      connectionId: this.connectionId ?? 'unknown',
    });

    if (this.tunnel) {
      await removeTunnel(this, 'alarm_expired');
    }

    await this.doState.storage.deleteAll();
    this.tunnel = null;
    this.connectionId = null;
  }

  // ─── Helpers ─────────────────────────────────────────────

  sendError(ws: WebSocket, code: string, message: string): void {
    try {
      ws.send(JSON.stringify({ type: 'error', code, message }));
    } catch {
      log.warn('Failed to send error to WebSocket', { code, message });
    }
  }
}
