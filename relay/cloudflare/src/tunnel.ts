import {
  ANONYMOUS_TUNNEL_TTL_MS,
  MAX_PAYLOAD_BYTES,
  MAX_TUNNELS_AUTHENTICATED,
  RESERVED_SUBDOMAINS,
  SUBDOMAIN_REGEX,
  SUBDOMAIN_RESERVATION_MS,
} from '@workslocal/shared';

import { authenticateRequest, type AuthResult } from './auth.js';
import { createDb } from './db/index.js';
import {
  findTunnelBySubdomain,
  getUserTunnelCount,
  reserveSubdomain,
  updateTunnelActivity,
} from './db/queries.js';
import type { Env } from './types.js';
import { generateId } from './utils/id.js';
import { createWorkerLogger } from './utils/logger.js';

// ─── Wire-format message types (snake_case) ──────────────

interface WireCreateTunnel {
  type: 'create_tunnel';
  local_port: number;
  custom_name?: string;
  domain?: string;
  client_version: string;
  anonymous_token?: string;
  auth_token?: string;
}

interface WireCloseTunnel {
  type: 'close_tunnel';
  tunnel_id: string;
}

interface WireHttpResponse {
  type: 'http_response';
  request_id: string;
  status_code: number;
  headers: Record<string, string>;
  body: string;
}

interface WirePing {
  type: 'ping';
  timestamp: number;
}

// ─── WebSocket passthrough wire types ────────────────────

interface WireWsFrame {
  type: 'ws_frame';
  request_id: string;
  data: string;
  is_binary: boolean;
}

interface WireWsClose {
  type: 'ws_close';
  request_id: string;
  code: number;
  reason: string;
}

type WireClientMessage =
  | WireCreateTunnel
  | WireCloseTunnel
  | WireHttpResponse
  | WirePing
  | WireWsFrame
  | WireWsClose;

// ─── Pending HTTP request tracking ───────────────────────

interface PendingRequest {
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

// ─── Tunnel state ────────────────────────────────────────

interface TunnelInfo {
  tunnelId: string;
  subdomain: string;
  domain: string;
  localPort: number;
  anonymousToken: string | null;
  userId: string | null;
  isPersistent: boolean;
  createdAt: string;
}

// ─── Logger ──────────────────────────────────────────────

const log = createWorkerLogger('tunnel-do');

/**
 * TunnelDO — one Durable Object per WebSocket connection.
 *
 * Keyed by "conn:{connectionId}". Holds the WebSocket to the CLI client.
 * When the client creates a tunnel, writes to KV so the Worker can
 * route tunnel HTTP traffic back to this DO.
 *
 * Uses the WebSocket Hibernation API — the DO can sleep between messages.
 * State (tunnel info, connectionId) is persisted to DO storage so it
 * survives hibernation. WebSockets are managed by the runtime and
 * retrieved via this.state.getWebSockets().
 *
 * Features:
 * - auth_token support (API key or Clerk JWT)
 * - Persistent subdomains for authenticated users (D1)
 * - 5-subdomain limit for authenticated, 2 for anonymous
 * - 30-min reservation for anonymous, 30-day for authenticated
 * - WebSocket passthrough (ws_open/ws_frame/ws_close)
 */
export class TunnelDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private connectionId: string | null = null;
  private tunnel: TunnelInfo | null = null;
  private pendingRequests = new Map<string, PendingRequest>();

  // User WebSocket connections (browser ↔ relay, keyed by request_id)
  private userSockets = new Map<string, WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Restore state from DO storage (survives hibernation)
    void this.state.blockConcurrencyWhile(async () => {
      this.tunnel = (await this.state.storage.get<TunnelInfo>('tunnel')) ?? null;
      this.connectionId = (await this.state.storage.get<string>('connectionId')) ?? null;
    });
  }

  // ─── Get active WebSocket (Hibernation API) ──────────────

  private getWebSocket(): WebSocket | null {
    const sockets = this.state.getWebSockets();
    return sockets.length > 0 ? sockets[0]! : null;
  }

  // ─── Fetch handler ───────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const requestType = request.headers.get('X-Tunnel-Request-Type');

    if (requestType === 'http') {
      return this.handleTunnelHttp(request);
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

    this.state.acceptWebSocket(server);

    await this.state.storage.put('connectionId', this.connectionId);

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
        await this.handleCreateTunnel(ws, msg);
        break;

      case 'close_tunnel':
        await this.handleCloseTunnel(ws, msg);
        break;

      case 'http_response':
        this.handleHttpResponse(msg);
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
        break;

      // WebSocket passthrough: frames from CLI → browser
      case 'ws_frame':
        this.handleWsFrame(msg);
        break;

      case 'ws_close':
        this.handleWsClose(msg);
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
    await this.cleanup();
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    log.error('WebSocket error', {
      connectionId: this.connectionId ?? 'unknown',
      err: String(error),
    });
    await this.cleanup();
  }

  // ─── Tunnel Creation ─────────────────────────────────────

  private async handleCreateTunnel(ws: WebSocket, msg: WireCreateTunnel): Promise<void> {
    if (this.tunnel) {
      this.sendError(ws, 'TUNNEL_EXISTS', 'This connection already has an active tunnel');
      return;
    }

    const domain = msg.domain ?? 'workslocal.exposed';
    const tunnelDomains = this.env.TUNNEL_DOMAINS.split(',').map((d) => d.trim());

    if (!tunnelDomains.includes(domain)) {
      this.sendError(ws, 'DOMAIN_INVALID', `Invalid domain: ${domain}`);
      return;
    }

    // ─── Authenticate if token provided ──────────────────
    let auth: AuthResult = { authenticated: true, userId: null, email: null, error: null };
    const isAuthenticated = Boolean(msg.auth_token);

    if (msg.auth_token) {
      auth = await this.authenticateToken(msg.auth_token);
      if (!auth.authenticated || !auth.userId) {
        this.sendError(ws, 'AUTH_FAILED', auth.error ?? 'Invalid authentication token');
        return;
      }
    }

    // ─── Determine subdomain ─────────────────────────────
    let subdomain: string;
    if (msg.custom_name) {
      if (!SUBDOMAIN_REGEX.test(msg.custom_name)) {
        this.sendError(
          ws,
          'SUBDOMAIN_INVALID',
          'Subdomain must be lowercase alphanumeric with optional hyphens (1-50 chars)',
        );
        return;
      }
      if (RESERVED_SUBDOMAINS.includes(msg.custom_name as (typeof RESERVED_SUBDOMAINS)[number])) {
        this.sendError(ws, 'SUBDOMAIN_RESERVED', `Subdomain "${msg.custom_name}" is reserved`);
        return;
      }
      subdomain = msg.custom_name;
    } else {
      subdomain = generateRandomSubdomain();
    }

    // ─── Check limits ────────────────────────────────────
    if (isAuthenticated && auth.userId) {
      const db = createDb(this.env.DB);
      const count = await getUserTunnelCount(db, auth.userId);
      if (count >= MAX_TUNNELS_AUTHENTICATED) {
        this.sendError(
          ws,
          'MAX_TUNNELS_REACHED',
          `Maximum ${String(MAX_TUNNELS_AUTHENTICATED)} persistent subdomains allowed. Revoke old ones to create new.`,
        );
        return;
      }
    }

    // ─── Check subdomain availability ────────────────────
    const kvKey = `tunnel:${domain}:${subdomain}`;
    const existing = await this.env.KV.get(kvKey);

    if (existing) {
      const canReclaim = await this.canReclaimSubdomain(subdomain, domain, msg, auth);
      if (!canReclaim) {
        this.sendError(ws, 'SUBDOMAIN_TAKEN', `Subdomain "${subdomain}" is already in use`);
        return;
      }
      await this.env.KV.delete(`reserved:${domain}:${subdomain}`);
    } else {
      const reservationKey = `reserved:${domain}:${subdomain}`;
      const reservedBy = await this.env.KV.get(reservationKey);
      if (reservedBy) {
        const canReclaim = this.canReclaimReservation(reservedBy, msg, auth);
        if (!canReclaim) {
          this.sendError(ws, 'SUBDOMAIN_TAKEN', `Subdomain "${subdomain}" is temporarily reserved`);
          return;
        }
        await this.env.KV.delete(reservationKey);
      } else if (isAuthenticated && auth.userId) {
        const db = createDb(this.env.DB);
        const d1Tunnel = await findTunnelBySubdomain(db, subdomain, domain);
        if (d1Tunnel && d1Tunnel.userId !== auth.userId) {
          this.sendError(
            ws,
            'SUBDOMAIN_TAKEN',
            `Subdomain "${subdomain}" is owned by another user`,
          );
          return;
        }
      }
    }

    // ─── Register tunnel ─────────────────────────────────
    const connectionName = `conn:${this.connectionId}`;
    const isPersistent = isAuthenticated && auth.userId !== null;

    if (isPersistent && auth.userId) {
      const db = createDb(this.env.DB);
      await reserveSubdomain(db, auth.userId, subdomain, domain);
      await this.env.KV.put(kvKey, connectionName);
    } else {
      await this.env.KV.put(kvKey, connectionName, {
        expirationTtl: Math.floor(ANONYMOUS_TUNNEL_TTL_MS / 1000),
      });
    }

    // ─── Store tunnel info ───────────────────────────────
    const tunnelId = generateId();
    const publicUrl = `https://${subdomain}.${domain}`;
    const expiresAt = isPersistent
      ? null
      : new Date(Date.now() + ANONYMOUS_TUNNEL_TTL_MS).toISOString();

    this.tunnel = {
      tunnelId,
      subdomain,
      domain,
      localPort: msg.local_port,
      anonymousToken: msg.anonymous_token ?? null,
      userId: auth.userId,
      isPersistent,
      createdAt: new Date().toISOString(),
    };

    await this.state.storage.put('tunnel', this.tunnel);
    await this.state.storage.deleteAlarm();

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
      connectionId: this.connectionId ?? 'unknown',
      isPersistent: String(isPersistent),
      userId: auth.userId ?? 'anonymous',
    });
  }

  // ─── Subdomain Reclaim Logic ───────────────────────────

  private async canReclaimSubdomain(
    subdomain: string,
    domain: string,
    msg: WireCreateTunnel,
    auth: AuthResult,
  ): Promise<boolean> {
    if (auth.userId) {
      const db = createDb(this.env.DB);
      const d1Tunnel = await findTunnelBySubdomain(db, subdomain, domain);
      if (d1Tunnel && d1Tunnel.userId === auth.userId) {
        return true;
      }
    }

    const reservationKey = `reserved:${domain}:${subdomain}`;
    const reservedBy = await this.env.KV.get(reservationKey);
    if (reservedBy && reservedBy === msg.anonymous_token) {
      return true;
    }

    return false;
  }

  private canReclaimReservation(
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

  private async authenticateToken(token: string): Promise<AuthResult> {
    const fakeRequest = new Request('https://localhost/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return authenticateRequest(fakeRequest, this.env);
  }

  // ─── Tunnel Closing ──────────────────────────────────────

  private async handleCloseTunnel(ws: WebSocket, msg: WireCloseTunnel): Promise<void> {
    if (!this.tunnel || this.tunnel.tunnelId !== msg.tunnel_id) {
      this.sendError(ws, 'TUNNEL_NOT_FOUND', 'Tunnel not found on this connection');
      return;
    }

    const tunnelId = this.tunnel.tunnelId;
    await this.removeTunnel('client_requested');

    ws.send(
      JSON.stringify({
        type: 'tunnel_closed',
        tunnel_id: tunnelId,
        reason: 'client_requested',
      }),
    );
  }

  // ─── HTTP Response from Client ───────────────────────────

  private handleHttpResponse(msg: WireHttpResponse): void {
    const pending = this.pendingRequests.get(msg.request_id);
    if (!pending) {
      log.warn('No pending request', { requestId: msg.request_id });
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.request_id);

    let bodyBytes: Uint8Array | null = null;
    if (msg.body) {
      try {
        const binaryString = atob(msg.body);
        bodyBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bodyBytes[i] = binaryString.charCodeAt(i);
        }
      } catch {
        log.warn('Failed to decode base64 body', { requestId: msg.request_id });
      }
    }

    const headers = new Headers(msg.headers);
    headers.delete('transfer-encoding');
    headers.delete('connection');
    headers.delete('keep-alive');
    headers.set('X-Tunnel-Response', 'true');

    pending.resolve(
      new Response(bodyBytes, {
        status: msg.status_code,
        headers,
      }),
    );
  }

  // ─── Tunnel HTTP Traffic (forwarded by Worker) ───────────

  private async handleTunnelHttp(request: Request): Promise<Response> {
    // Check if this is a WebSocket upgrade from a browser/external client
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      return this.handleUserWebSocket(request);
    }

    const ws = this.getWebSocket();

    if (!ws) {
      return Response.json(
        {
          ok: false,
          error: { code: 'TUNNEL_NOT_CONNECTED', message: 'Tunnel client is not connected' },
        },
        { status: 502 },
      );
    }

    if (ws.readyState !== WebSocket.READY_STATE_OPEN) {
      return Response.json(
        {
          ok: false,
          error: { code: 'TUNNEL_NOT_CONNECTED', message: 'Tunnel client WebSocket is not open' },
        },
        { status: 502 },
      );
    }

    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    // Read request body as base64
    let bodyBase64 = '';
    if (request.body) {
      const bodyBytes = await request.arrayBuffer();
      if (bodyBytes.byteLength > MAX_PAYLOAD_BYTES) {
        return Response.json(
          {
            ok: false,
            error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 10MB limit' },
          },
          { status: 413 },
        );
      }
      if (bodyBytes.byteLength > 0) {
        const bytes = new Uint8Array(bodyBytes);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]!);
        }
        bodyBase64 = btoa(binary);
      }
    }

    // Extract headers (skip internal/hop-by-hop)
    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (
        lower === 'host' ||
        lower === 'connection' ||
        lower === 'upgrade' ||
        lower === 'transfer-encoding' ||
        lower.startsWith('x-tunnel-') ||
        lower.startsWith('cf-')
      )
        continue;
      headers[lower] = value;
    }

    // Extract query params
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      query[key] = value;
    }

    const httpRequestMsg = JSON.stringify({
      type: 'http_request',
      request_id: requestId,
      method: request.method,
      path: url.pathname,
      headers,
      body: bodyBase64,
      query,
    });

    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve(
          Response.json(
            {
              ok: false,
              error: {
                code: 'GATEWAY_TIMEOUT',
                message: 'Tunnel client did not respond within 30 seconds',
              },
            },
            { status: 504 },
          ),
        );
      }, 30_000);

      this.pendingRequests.set(requestId, {
        resolve,
        timer,
        createdAt: Date.now(),
      });

      try {
        ws.send(httpRequestMsg);
      } catch {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        resolve(
          Response.json(
            {
              ok: false,
              error: { code: 'WS_SEND_FAILED', message: 'Failed to send request to tunnel client' },
            },
            { status: 502 },
          ),
        );
      }
    });
  }

  // ─── User WebSocket Passthrough (Browser ↔ Relay ↔ CLI) ──

  /**
   * Handle a WebSocket upgrade from an external client (browser).
   * Accept the WS, assign a request_id, and tell the CLI to open
   * a matching local WS connection via ws_open message.
   */
  private handleUserWebSocket(request: Request): Response {
    const tunnelWs = this.getWebSocket();

    if (!tunnelWs) {
      return Response.json(
        {
          ok: false,
          error: { code: 'TUNNEL_NOT_CONNECTED', message: 'Tunnel client is not connected' },
        },
        { status: 502 },
      );
    }

    if (tunnelWs.readyState !== WebSocket.READY_STATE_OPEN) {
      return Response.json(
        {
          ok: false,
          error: { code: 'TUNNEL_NOT_CONNECTED', message: 'Tunnel client WebSocket is not open' },
        },
        { status: 502 },
      );
    }

    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    // Accept the browser's WebSocket
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Store the server-side socket keyed by request_id
    this.userSockets.set(requestId, server);

    // Extract headers (skip hop-by-hop and internal)
    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (
        lower === 'host' ||
        lower === 'connection' ||
        lower === 'upgrade' ||
        lower === 'sec-websocket-key' ||
        lower === 'sec-websocket-version' ||
        lower === 'sec-websocket-extensions' ||
        lower.startsWith('x-tunnel-') ||
        lower.startsWith('cf-')
      )
        continue;
      headers[lower] = value;
    }

    // Extract query params
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      query[key] = value;
    }

    const protocol = request.headers.get('Sec-WebSocket-Protocol') ?? '';

    // Tell CLI to open a local WebSocket
    tunnelWs.send(
      JSON.stringify({
        type: 'ws_open',
        request_id: requestId,
        path: url.pathname,
        headers,
        query,
        protocol,
      }),
    );

    log.info('User WebSocket opened', {
      requestId,
      path: url.pathname,
      connectionId: this.connectionId ?? 'unknown',
    });

    // Listen for frames from the browser → relay to CLI
    server.accept();

    server.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      let base64Data: string;
      let isBinary: boolean;

      if (typeof data === 'string') {
        // Text frame: base64-encode the UTF-8 string
        const encoder = new TextEncoder();
        const bytes = encoder.encode(data);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]!);
        }
        base64Data = btoa(binary);
        isBinary = false;
      } else if (data instanceof ArrayBuffer) {
        // Binary frame: base64-encode the raw bytes
        const bytes = new Uint8Array(data);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]!);
        }
        base64Data = btoa(binary);
        isBinary = true;
      } else {
        return;
      }

      // Forward to CLI via tunnel WS
      try {
        tunnelWs.send(
          JSON.stringify({
            type: 'ws_frame',
            request_id: requestId,
            data: base64Data,
            is_binary: isBinary,
          }),
        );
      } catch {
        log.warn('Failed to forward user WS frame to tunnel', { requestId });
      }
    });

    server.addEventListener('close', (event: CloseEvent) => {
      this.userSockets.delete(requestId);

      log.info('User WebSocket closed', {
        requestId,
        code: String(event.code),
      });

      // Tell CLI the browser WS closed
      try {
        tunnelWs.send(
          JSON.stringify({
            type: 'ws_close',
            request_id: requestId,
            code: event.code,
            reason: event.reason || 'Browser closed connection',
          }),
        );
      } catch {
        // Tunnel WS may be closed already
      }
    });

    server.addEventListener('error', () => {
      this.userSockets.delete(requestId);

      try {
        tunnelWs.send(
          JSON.stringify({
            type: 'ws_close',
            request_id: requestId,
            code: 1011,
            reason: 'WebSocket error',
          }),
        );
      } catch {
        // Tunnel WS may be closed already
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Forward a WS frame from CLI (localhost) back to the browser.
   */
  private handleWsFrame(msg: WireWsFrame): void {
    const userSocket = this.userSockets.get(msg.request_id);
    if (!userSocket) return;

    try {
      if (msg.is_binary) {
        const binary = atob(msg.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        userSocket.send(bytes.buffer);
      } else {
        userSocket.send(atob(msg.data));
      }
    } catch {
      log.warn('Failed to send WS frame to browser', { requestId: msg.request_id });
    }
  }

  /**
   * Close a user WebSocket (CLI told us the local WS closed).
   */
  private handleWsClose(msg: WireWsClose): void {
    const userSocket = this.userSockets.get(msg.request_id);
    if (!userSocket) return;

    try {
      userSocket.close(msg.code, msg.reason);
    } catch {
      // Already closed
    }
    this.userSockets.delete(msg.request_id);

    log.info('User WebSocket closed by CLI', {
      requestId: msg.request_id,
      code: String(msg.code),
    });
  }

  // ─── Cleanup ─────────────────────────────────────────────

  private async cleanup(): Promise<void> {
    // Close all user WebSocket connections
    for (const [requestId, socket] of this.userSockets) {
      try {
        socket.close(1001, 'Tunnel disconnected');
      } catch {
        // Already closed
      }
      log.info('Closing user WebSocket on tunnel disconnect', { requestId });
    }
    this.userSockets.clear();

    // Resolve all pending HTTP requests
    for (const [, pending] of this.pendingRequests) {
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
    this.pendingRequests.clear();

    if (this.tunnel) {
      await this.removeTunnel('client_disconnected');
    }

    await this.state.storage.delete('connectionId');
    this.connectionId = null;
  }

  private async removeTunnel(reason: string): Promise<void> {
    if (!this.tunnel) return;

    const { subdomain, domain, anonymousToken, userId, isPersistent } = this.tunnel;
    const kvKey = `tunnel:${domain}:${subdomain}`;

    await this.env.KV.delete(kvKey);

    if (isPersistent && userId) {
      const db = createDb(this.env.DB);
      await updateTunnelActivity(db, subdomain, domain);

      const reservationKey = `reserved:${domain}:${subdomain}`;
      await this.env.KV.put(reservationKey, `user:${userId}`, {
        expirationTtl: 30 * 24 * 60 * 60,
      });
    } else if (anonymousToken) {
      const reservationKey = `reserved:${domain}:${subdomain}`;
      await this.env.KV.put(reservationKey, anonymousToken, {
        expirationTtl: Math.floor(SUBDOMAIN_RESERVATION_MS / 1000),
      });
      await this.state.storage.setAlarm(Date.now() + SUBDOMAIN_RESERVATION_MS);
    }

    log.info('Tunnel removed', { subdomain, domain, reason, isPersistent: String(isPersistent) });

    this.tunnel = null;
    await this.state.storage.delete('tunnel');
  }

  // ─── Alarm ───────────────────────────────────────────────

  async alarm(): Promise<void> {
    log.info('Alarm fired — reservation expired', {
      connectionId: this.connectionId ?? 'unknown',
    });

    if (this.tunnel) {
      await this.removeTunnel('alarm_expired');
    }

    await this.state.storage.deleteAll();
    this.tunnel = null;
    this.connectionId = null;
  }

  // ─── Helpers ─────────────────────────────────────────────

  private sendError(ws: WebSocket, code: string, message: string): void {
    try {
      ws.send(JSON.stringify({ type: 'error', code, message }));
    } catch {
      log.warn('Failed to send error to WebSocket', { code, message });
    }
  }
}

// ─── Random subdomain generator ────────────────────────────

function generateRandomSubdomain(length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
