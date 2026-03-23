import type { ClientMessage, HttpRequestMessage, WLLogger } from '@workslocal/shared';
import type WebSocket from 'ws';

import type { LocalProxy, LocalProxyResponse } from './local-proxy.js';
import type { RequestStore } from './request-store.js';
import type { TunnelClientEvents, TunnelInfo } from './types.js';

export interface ClientContext {
  readonly log: WLLogger;
  readonly tunnels: Map<string, TunnelInfo>;
  readonly portMap: Map<string, number>;
  readonly localWebSockets: Map<string, WebSocket>;
  readonly localProxy: LocalProxy;
  readonly requestStore: RequestStore;
  readonly proxyOverride:
    | ((msg: HttpRequestMessage) => LocalProxyResponse | Promise<LocalProxyResponse>)
    | undefined;
  pendingPort: number | null;
  send(msg: ClientMessage): void;
  emit<K extends keyof TunnelClientEvents>(
    event: K,
    ...args: Parameters<TunnelClientEvents[K]>
  ): void;
}
