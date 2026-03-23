import { describe, expect, it } from 'vitest';

import { createRouter } from '../src/router.js';
import type { Env } from '../src/types.js';

// Minimal mock Env — router doesn't use it, handlers do
const mockEnv = {} as Env;

function mockRequest(url: string, method = 'GET'): Request {
  return new Request(url, { method });
}

describe('Router', () => {
  describe('exact path matching', () => {
    it('matches GET /health', async () => {
      const router = createRouter();
      let called = false;

      router.get('/health', () => {
        called = true;
        return new Response('ok');
      });

      const result = await router.handle(mockRequest('https://api.workslocal.dev/health'), mockEnv);
      expect(called).toBe(true);
      expect(result).not.toBeNull();
    });

    it('matches POST /api/v1/keys', async () => {
      const router = createRouter();
      let called = false;

      router.post('/api/v1/keys', () => {
        called = true;
        return new Response('ok');
      });

      const result = await router.handle(
        mockRequest('https://api.workslocal.dev/api/v1/keys', 'POST'),
        mockEnv,
      );
      expect(called).toBe(true);
      expect(result).not.toBeNull();
    });

    it('matches DELETE method', async () => {
      const router = createRouter();
      let called = false;

      router.delete('/api/v1/keys/abc', () => {
        called = true;
        return new Response('ok');
      });

      const result = await router.handle(
        mockRequest('https://api.workslocal.dev/api/v1/keys/abc', 'DELETE'),
        mockEnv,
      );
      expect(called).toBe(true);
      expect(result).not.toBeNull();
    });
  });

  describe('method filtering', () => {
    it('does not match wrong method', async () => {
      const router = createRouter();
      let called = false;

      router.get('/health', () => {
        called = true;
        return new Response('ok');
      });

      const result = await router.handle(
        mockRequest('https://api.workslocal.dev/health', 'POST'),
        mockEnv,
      );
      expect(called).toBe(false);
      expect(result).toBeNull();
    });

    it('same path different methods route to different handlers', async () => {
      const router = createRouter();
      let getCalled = false;
      let postCalled = false;

      router.get('/api/v1/keys', () => {
        getCalled = true;
        return new Response('list');
      });

      router.post('/api/v1/keys', () => {
        postCalled = true;
        return new Response('create');
      });

      await router.handle(mockRequest('https://api.workslocal.dev/api/v1/keys', 'GET'), mockEnv);
      expect(getCalled).toBe(true);
      expect(postCalled).toBe(false);

      getCalled = false;

      await router.handle(mockRequest('https://api.workslocal.dev/api/v1/keys', 'POST'), mockEnv);
      expect(postCalled).toBe(true);
      expect(getCalled).toBe(false);
    });
  });

  describe('param extraction', () => {
    it('extracts :id from path', async () => {
      const router = createRouter();
      let capturedId = '';

      router.delete('/api/v1/keys/:id', (_req, _env, { pathParams }) => {
        capturedId = pathParams['id'] ?? '';
        return new Response('ok');
      });

      await router.handle(
        mockRequest('https://api.workslocal.dev/api/v1/keys/abc123', 'DELETE'),
        mockEnv,
      );
      expect(capturedId).toBe('abc123');
    });

    it('extracts multiple params', async () => {
      const router = createRouter();
      let capturedDomain = '';
      let capturedSub = '';

      router.get('/tunnels/:domain/:subdomain', (_req, _env, { pathParams }) => {
        capturedDomain = pathParams['domain'] ?? '';
        capturedSub = pathParams['subdomain'] ?? '';
        return new Response('ok');
      });

      await router.handle(
        mockRequest('https://api.workslocal.dev/tunnels/workslocal.exposed/myapp'),
        mockEnv,
      );
      expect(capturedDomain).toBe('workslocal.exposed');
      expect(capturedSub).toBe('myapp');
    });

    it('does not match if path segment count differs', async () => {
      const router = createRouter();
      let called = false;

      router.get('/api/v1/keys/:id', () => {
        called = true;
        return new Response('ok');
      });

      // Too many segments
      const r1 = await router.handle(
        mockRequest('https://api.workslocal.dev/api/v1/keys/abc/extra'),
        mockEnv,
      );
      expect(r1).toBeNull();
      expect(called).toBe(false);

      // Too few segments
      const r2 = await router.handle(
        mockRequest('https://api.workslocal.dev/api/v1/keys'),
        mockEnv,
      );
      expect(r2).toBeNull();
      expect(called).toBe(false);
    });
  });

  describe('no match', () => {
    it('returns null when no routes match', async () => {
      const router = createRouter();
      router.get('/health', () => new Response('ok'));

      const result = await router.handle(
        mockRequest('https://api.workslocal.dev/unknown'),
        mockEnv,
      );
      expect(result).toBeNull();
    });

    it('returns null for empty router', async () => {
      const router = createRouter();

      const result = await router.handle(
        mockRequest('https://api.workslocal.dev/anything'),
        mockEnv,
      );
      expect(result).toBeNull();
    });
  });

  describe('route priority', () => {
    it('matches first registered route', async () => {
      const router = createRouter();
      let firstCalled = false;
      let secondCalled = false;

      router.get('/test', () => {
        firstCalled = true;
        return new Response('first');
      });

      router.get('/test', () => {
        secondCalled = true;
        return new Response('second');
      });

      await router.handle(mockRequest('https://api.workslocal.dev/test'), mockEnv);
      expect(firstCalled).toBe(true);
      expect(secondCalled).toBe(false);
    });
  });

  describe('query string handling', () => {
    it('ignores query string when matching', async () => {
      const router = createRouter();
      let called = false;

      router.get('/health', () => {
        called = true;
        return new Response('ok');
      });

      const result = await router.handle(
        mockRequest('https://api.workslocal.dev/health?foo=bar'),
        mockEnv,
      );
      expect(called).toBe(true);
      expect(result).not.toBeNull();
    });
  });

  describe('provides URL in params', () => {
    it('passes parsed URL to handler', async () => {
      const router = createRouter();
      let capturedQuery = '';

      router.get('/search', (_req, _env, { url }) => {
        capturedQuery = url.searchParams.get('q') ?? '';
        return new Response('ok');
      });

      await router.handle(mockRequest('https://api.workslocal.dev/search?q=hello'), mockEnv);
      expect(capturedQuery).toBe('hello');
    });
  });
});
