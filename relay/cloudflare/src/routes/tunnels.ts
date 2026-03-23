import { authenticateRequest } from '../auth.js';
import { createDb } from '../db/index.js';
import { getUserTunnels } from '../db/queries.js';
import type { Env } from '../types.js';
import { success, error } from '../utils/response.js';

export async function handleListTunnels(request: Request, env: Env): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (!auth.authenticated || !auth.userId) {
    return error('AUTH_FAILED', auth.error ?? 'Authentication required', 401);
  }
  const db = createDb(env.DB);
  const tunnels = await getUserTunnels(db, auth.userId);
  return success({ tunnels });
}
