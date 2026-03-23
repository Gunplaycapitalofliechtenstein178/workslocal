// ─── WebSocket Passthrough (Server → Client) ─────────────

/**
 * A browser/external client opened a WebSocket to the tunnel URL.
 * CLI should open a matching WS to localhost.
 */
export interface WsOpenMessage {
  readonly type: 'ws_open';
  readonly request_id: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
  readonly protocol: string; // Sec-WebSocket-Protocol value (or empty)
}

/**
 * A WebSocket frame from either direction.
 * Sent by server (browser → CLI) or client (localhost → browser).
 */
export interface WsFrameMessage {
  readonly type: 'ws_frame';
  readonly request_id: string;
  readonly data: string; // base64-encoded frame data
  readonly is_binary: boolean;
}

/**
 * WebSocket closed from either side.
 */
export interface WsCloseMessage {
  readonly type: 'ws_close';
  readonly request_id: string;
  readonly code: number;
  readonly reason: string;
}
