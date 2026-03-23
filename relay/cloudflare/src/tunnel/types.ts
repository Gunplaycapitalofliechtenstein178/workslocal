import type { Env } from '../types.js';
import { createWorkerLogger } from '../utils/logger.js';

// ─── Wire-format message types (snake_case) ──────────────

export interface WireCreateTunnel {
  type: 'create_tunnel';
  local_port: number;
  custom_name?: string;
  domain?: string;
  client_version: string;
  anonymous_token?: string;
  auth_token?: string;
}

export interface WireCloseTunnel {
  type: 'close_tunnel';
  tunnel_id: string;
}

export interface WireHttpResponse {
  type: 'http_response';
  request_id: string;
  status_code: number;
  headers: Record<string, string>;
  body: string;
}

export interface WirePing {
  type: 'ping';
  timestamp: number;
}

// ─── WebSocket passthrough wire types ────────────────────

export interface WireWsFrame {
  type: 'ws_frame';
  request_id: string;
  data: string;
  is_binary: boolean;
}

export interface WireWsClose {
  type: 'ws_close';
  request_id: string;
  code: number;
  reason: string;
}

export type WireClientMessage =
  | WireCreateTunnel
  | WireCloseTunnel
  | WireHttpResponse
  | WirePing
  | WireWsFrame
  | WireWsClose;

// ─── Pending HTTP request tracking ───────────────────────

export interface PendingRequest {
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

// ─── Tunnel state ────────────────────────────────────────

export interface TunnelInfo {
  tunnelId: string;
  subdomain: string;
  domain: string;
  localPort: number;
  anonymousToken: string | null;
  userId: string | null;
  isPersistent: boolean;
  createdAt: string;
}

// ─── Context interface for extracted modules ─────────────

export interface TunnelContext {
  readonly doState: DurableObjectState;
  readonly env: Env;
  connectionId: string | null;
  tunnel: TunnelInfo | null;
  readonly pendingRequests: Map<string, PendingRequest>;
  readonly userSockets: Map<string, WebSocket>;
  getWebSocket(): WebSocket | null;
  sendError(ws: WebSocket, code: string, message: string): void;
}

// ─── Shared logger ───────────────────────────────────────

export const log = createWorkerLogger('tunnel-do');

// ─── Random subdomain generator ─────────────────────────

export function generateRandomSubdomain(length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
