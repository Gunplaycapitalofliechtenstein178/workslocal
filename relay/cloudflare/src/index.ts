import { STALE_THRESHOLD_DAYS } from '@workslocal/shared';

import { createDb } from './db/index.js';
import { cleanupStaleTunnels } from './db/queries.js';
import { createRouter } from './router.js';
import { handleGetAccount } from './routes/account.js';
import { handleAuthLoginPage, handleAuthCallback } from './routes/auth.js';
import { routeToDO, routeWebSocket } from './routes/do.js';
import { handleHealth, handleHealthReady } from './routes/health.js';
import { handleCreateKey, handleListKeys, handleRevokeKey } from './routes/keys.js';
import { handleListTunnels } from './routes/tunnels.js';
import type { Env } from './types.js';
import { handleCors, withCors } from './utils/cors.js';
import { parseTunnelHost } from './utils/host.js';
import { createWorkerLogger } from './utils/logger.js';
import { error, withStandardHeaders } from './utils/response.js';

const log = createWorkerLogger('worker');

export { TunnelDO } from './tunnel/durable-object.js';

// ─── Build router ────────────────────────────────────────

const router = createRouter();

router.get('/health', handleHealth);
router.get('/health/ready', handleHealthReady);
router.get('/auth/login', handleAuthLoginPage);
router.get('/auth/callback', handleAuthCallback);
router.get('/api/v1/account', handleGetAccount);
router.post('/api/v1/keys', handleCreateKey);
router.get('/api/v1/keys', handleListKeys);
router.delete('/api/v1/keys/:id', handleRevokeKey);
router.get('/api/v1/tunnels', handleListTunnels);

// ─── Worker ──────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const corsResponse = handleCors(request);
    if (corsResponse) return corsResponse;

    let response: Response;

    try {
      const host = request.headers.get('Host') ?? '';
      const tunnelDomains = env.TUNNEL_DOMAINS.split(',').map((d) => d.trim());
      const tunnel = parseTunnelHost(host, tunnelDomains);

      if (tunnel) {
        response = await routeToDO(request, env, tunnel.subdomain, tunnel.domain);
      } else if (new URL(request.url).pathname === '/ws') {
        response = await routeWebSocket(request, env);
      } else {
        const routed = await router.handle(request, env);
        response =
          routed ?? error('NOT_FOUND', `Route not found: ${new URL(request.url).pathname}`, 404);
      }
    } catch (err) {
      log.error('Worker fetch error', { err: err instanceof Error ? err.message : String(err) });
      response = error(
        'INTERNAL_ERROR',
        err instanceof Error ? err.message : 'Internal server error',
        500,
      );
    }

    response = withStandardHeaders(response, env.API_VERSION);
    response = withCors(response);

    return response;
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    log.info('Stale tunnel cleanup started');

    try {
      const db = createDb(env.DB);
      const startTime = Date.now();
      const removed = await cleanupStaleTunnels(db, Number(STALE_THRESHOLD_DAYS));
      const durationMs = Date.now() - startTime;

      log.info('Stale tunnel cleanup complete', {
        removed: String(removed),
        durationMs: String(durationMs),
      });
    } catch (err) {
      log.error('Stale tunnel cleanup failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
