import {
  silentLogger,
  type WLLogger,
  type HttpRequestMessage,
  type ClientMessage,
} from '@workslocal/shared';
import WebSocket from 'ws';

import { getAnonymousToken } from './auth.js';
import type { ClientContext } from './client-context.js';
import { startHeartbeat, stopHeartbeat } from './connection/heartbeat.js';
import { handleMessage } from './handlers/message-handler.js';
import { createLocalProxy, type LocalProxy, type LocalProxyResponse } from './local-proxy.js';
import { createRequestStore, type RequestStore } from './request-store.js';
import type {
  ConnectionState,
  TunnelClientEvents,
  TunnelClientOptions,
  TunnelInfo,
} from './types.js';

// ─── Typed event emitter ─────────────────────────────────

type EventHandler<T extends (...args: never[]) => void> = T;
type EventMap = { [K in keyof TunnelClientEvents]: Set<EventHandler<TunnelClientEvents[K]>> };

// ─── Reconnect config ────────────────────────────────────

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

/**
 * WorksLocal Tunnel Client.
 *
 * Core client library used by both CLI and desktop app.
 * Manages WebSocket connection to the relay server, handles
 * tunnel creation/closing, heartbeat, auto-reconnect, local HTTP
 * proxying, and request capture.
 *
 * authToken for persistent subdomains.
 * proxyOverride for catch mode (static responses without localhost).
 *
 * Usage:
 * ```typescript
 * // HTTP mode (forward to localhost)
 * const client = new TunnelClient({ serverUrl: "wss://api.workslocal.dev/ws" });
 *
 * // Catch mode (static response, no localhost)
 * const client = new TunnelClient({
 *   serverUrl: "wss://api.workslocal.dev/ws",
 *   proxyOverride: (msg) => ({ statusCode: 200, headers: {}, body: btoa("ok") }),
 * });
 * ```
 */
export class TunnelClient implements ClientContext {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  readonly log: WLLogger;
  private readonly serverUrl: string;
  private readonly clientVersion: string;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly authToken: string | undefined;
  readonly proxyOverride:
    | ((msg: HttpRequestMessage) => LocalProxyResponse | Promise<LocalProxyResponse>)
    | undefined;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private autoReconnectEnabled = true;

  // Tunnel state
  readonly tunnels = new Map<string, TunnelInfo>();
  readonly portMap = new Map<string, number>();
  pendingPort: number | null = null;

  // Components
  readonly localProxy: LocalProxy;
  readonly requestStore: RequestStore;

  readonly localWebSockets = new Map<string, WebSocket>();

  // Event system
  private readonly listeners: EventMap = {
    connected: new Set(),
    disconnected: new Set(),
    reconnecting: new Set(),
    reconnect_failed: new Set(),
    'tunnel:created': new Set(),
    'tunnel:closed': new Set(),
    'request:start': new Set(),
    'request:complete': new Set(),
    'request:error': new Set(),
    error: new Set(),
  };

  constructor(options: TunnelClientOptions) {
    this.serverUrl = options.serverUrl;
    this.log = options.logger ?? silentLogger;
    this.clientVersion = options.clientVersion ?? '0.0.1';
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.authToken = options.authToken;
    this.proxyOverride = options.proxyOverride;

    this.localProxy = createLocalProxy({ logger: this.log });
    this.requestStore = createRequestStore();
  }

  // ─── Public: Auth status ───────────────────────────────

  get isAuthenticated(): boolean {
    return Boolean(this.authToken);
  }

  // ─── Event system ──────────────────────────────────────

  on<K extends keyof TunnelClientEvents>(event: K, handler: TunnelClientEvents[K]): void {
    (this.listeners[event] as Set<TunnelClientEvents[K]>).add(handler);
  }

  off<K extends keyof TunnelClientEvents>(event: K, handler: TunnelClientEvents[K]): void {
    (this.listeners[event] as Set<TunnelClientEvents[K]>).delete(handler);
  }

  emit<K extends keyof TunnelClientEvents>(
    event: K,
    ...args: Parameters<TunnelClientEvents[K]>
  ): void {
    for (const handler of this.listeners[event]) {
      try {
        (handler as (...a: Parameters<TunnelClientEvents[K]>) => void)(...args);
      } catch (err) {
        this.log.error('Event handler error', {
          event,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ─── Connection ────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.state = 'connecting';

    return new Promise<void>((resolve, reject) => {
      this.log.info('Connecting to relay server', { url: this.serverUrl });

      this.ws = new WebSocket(this.serverUrl);

      this.ws.on('open', () => {
        this.state = 'connected';
        this.reconnectAttempt = 0;
        this.stopHeartbeat();
        this.heartbeatTimer = startHeartbeat(
          (msg) => this.send(msg),
          () => this.ws,
        );
        this.log.info('Connected to relay server');
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        let raw: string;
        if (typeof data === 'string') {
          raw = data;
        } else if (Buffer.isBuffer(data)) {
          raw = data.toString('utf-8');
        } else if (Array.isArray(data)) {
          raw = Buffer.concat(data).toString('utf-8');
        } else {
          raw = Buffer.from(data).toString('utf-8');
        }
        void handleMessage(this, raw);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString('utf-8') || 'unknown';
        this.state = 'disconnected';
        this.stopHeartbeat();

        this.log.info('Disconnected from relay server', {
          code: String(code),
          reason: reasonStr,
        });
        this.emit('disconnected', code, reasonStr);

        if (this.autoReconnect && this.autoReconnectEnabled && code !== 1000) {
          void this.attemptReconnect();
        }
      });

      this.ws.on('error', (err: Error) => {
        this.log.error('WebSocket error', { err: err.message });
        this.emit('error', err);

        if (this.state === 'connecting') {
          reject(err);
        }
      });
    });
  }

  disconnect(): void {
    this.autoReconnectEnabled = false;

    this.stopHeartbeat();
    this.clearReconnectTimer();

    // Close all local WebSocket connections (WS passthrough)
    for (const [, localWs] of this.localWebSockets) {
      try {
        localWs.close(1001, 'Tunnel disconnecting');
      } catch {
        // Already closed
      }
    }
    this.localWebSockets.clear();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      for (const tunnelId of this.tunnels.keys()) {
        this.send({ type: 'close_tunnel', tunnel_id: tunnelId });
      }
      this.ws.close(1000, 'Client disconnect');
    }

    this.tunnels.clear();
    this.portMap.clear();
    this.state = 'disconnected';
  }

  // ─── Tunnel management ─────────────────────────────────

  async createTunnel(options: {
    port: number;
    name?: string | undefined;
    domain?: string | undefined;
  }): Promise<TunnelInfo> {
    if (this.state !== 'connected') {
      throw new Error('Not connected to relay server');
    }

    return new Promise<TunnelInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('tunnel:created', handler);
        this.off('error', errorHandler);
        reject(new Error('Tunnel creation timed out'));
      }, 10_000);

      const handler = (tunnel: TunnelInfo): void => {
        clearTimeout(timeout);
        this.off('tunnel:created', handler);
        this.off('error', errorHandler);
        resolve(tunnel);
      };

      const errorHandler = (err: Error): void => {
        clearTimeout(timeout);
        this.off('tunnel:created', handler);
        this.off('error', errorHandler);
        reject(err);
      };

      this.on('tunnel:created', handler);
      this.on('error', errorHandler);

      const msg: Record<string, unknown> = {
        type: 'create_tunnel',
        local_port: options.port,
        custom_name: options.name,
        domain: options.domain,
        client_version: this.clientVersion,
        anonymous_token: getAnonymousToken(),
      };

      if (this.authToken) {
        msg.auth_token = this.authToken;
      }

      this.pendingPort = options.port;
      this.send(msg as unknown as ClientMessage);
    });
  }

  closeTunnel(tunnelId: string): void {
    if (!this.tunnels.has(tunnelId)) {
      this.log.warn('Tunnel not found', { tunnelId });
      return;
    }
    this.send({ type: 'close_tunnel', tunnel_id: tunnelId });
  }

  closeAll(): void {
    for (const tunnelId of this.tunnels.keys()) {
      this.closeTunnel(tunnelId);
    }
  }

  getTunnel(tunnelId: string): TunnelInfo | undefined {
    return this.tunnels.get(tunnelId);
  }

  getAllTunnels(): readonly TunnelInfo[] {
    return [...this.tunnels.values()];
  }

  getState(): ConnectionState {
    return this.state;
  }

  get tunnelCount(): number {
    return this.tunnels.size;
  }

  // ─── Send ──────────────────────────────────────────────

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.log.warn('Cannot send - WebSocket not open', {
        type: msg.type,
        state: String(this.ws?.readyState ?? 'null'),
      });
    }
  }

  // ─── Heartbeat ─────────────────────────────────────────

  private stopHeartbeat(): void {
    stopHeartbeat(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ─── Reconnect ─────────────────────────────────────────

  private async attemptReconnect(): Promise<void> {
    if (!this.autoReconnectEnabled) return;
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.log.error('Max reconnect attempts reached');
      this.emit('reconnect_failed');
      return;
    }

    this.reconnectAttempt++;
    this.state = 'reconnecting';

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt - 1),
      RECONNECT_MAX_MS,
    );

    this.log.info('Reconnecting', {
      attempt: String(this.reconnectAttempt),
      maxAttempts: String(this.maxReconnectAttempts),
      delayMs: String(delay),
    });

    this.emit('reconnecting', this.reconnectAttempt, this.maxReconnectAttempts);

    await new Promise<void>((resolve) => {
      this.reconnectTimer = setTimeout(resolve, delay);
      this.reconnectTimer.unref();
    });

    try {
      await this.connect();

      // Re-create tunnels that were active before disconnect
      const previousTunnels = [...this.tunnels.values()];
      this.tunnels.clear();
      this.portMap.clear();

      for (const tunnel of previousTunnels) {
        try {
          await this.createTunnel({
            port: tunnel.localPort,
            name: tunnel.subdomain,
            domain: tunnel.domain,
          });
          this.log.info('Tunnel re-created after reconnect', {
            subdomain: tunnel.subdomain,
          });
        } catch (err) {
          this.log.warn('Failed to re-create tunnel after reconnect', {
            subdomain: tunnel.subdomain,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch {
      // connect() failed - will trigger another reconnect via close handler
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
