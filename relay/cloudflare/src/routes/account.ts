import { authenticateRequest } from '../auth.js';
import type { Env } from '../types.js';
import { error, success } from '../utils/response.js';

export async function handleGetAccount(request: Request, env: Env): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (!auth.authenticated || !auth.userId) {
    return error('AUTH_FAILED', auth.error ?? 'Authentication required', 401);
  }
  return success({ id: auth.userId, email: auth.email });
}
