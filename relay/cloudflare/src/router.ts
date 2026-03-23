import type { Env } from './types.js';

type RouteHandler = (
  request: Request,
  env: Env,
  params: RouteParams,
) => Promise<Response> | Response;

export interface RouteParams {
  url: URL;
  pathParams: Record<string, string>;
}

interface Route {
  method: string;
  pattern: string;
  handler: RouteHandler;
}

export function createRouter(): {
  get: (pattern: string, handler: RouteHandler) => void;
  post: (pattern: string, handler: RouteHandler) => void;
  delete: (pattern: string, handler: RouteHandler) => void;
  handle(request: Request, env: Env): Promise<Response | null>;
} {
  const routes: Route[] = [];

  function addRoute(method: string, pattern: string, handler: RouteHandler): void {
    routes.push({ method, pattern, handler });
  }

  return {
    get: (pattern: string, handler: RouteHandler) => addRoute('GET', pattern, handler),
    post: (pattern: string, handler: RouteHandler) => addRoute('POST', pattern, handler),
    delete: (pattern: string, handler: RouteHandler) => addRoute('DELETE', pattern, handler),

    async handle(request: Request, env: Env): Promise<Response | null> {
      const url = new URL(request.url);
      const method = request.method;

      for (const route of routes) {
        if (route.method !== method) continue;

        const params = matchPattern(route.pattern, url.pathname);
        if (params !== null) {
          return route.handler(request, env, { url, pathParams: params });
        }
      }

      return null;
    },
  };
}

function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!;
    const path = pathParts[i]!;

    if (pp.startsWith(':')) {
      params[pp.slice(1)] = path;
    } else if (pp !== path) {
      return null;
    }
  }

  return params;
}
