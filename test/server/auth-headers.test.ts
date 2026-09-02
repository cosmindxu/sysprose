// @vitest-environment node
/**
 * Opt-in bearer auth + CSP hardening on the optional Express deployment.
 * Verifies: CSP header present; without a token the API is open (local-first
 * default); with a token, requests need `Authorization: Bearer <token>` (401
 * otherwise) while `GET /health` stays open for liveness.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from '../../src/server/app';

async function listen(app: ReturnType<typeof createServer>): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('server: CSP + open-by-default', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => ({ server, base } = await listen(createServer())));
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('sets a strict Content-Security-Policy on every response', async () => {
    const res = await fetch(`${base}/health`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('serves the API without auth when no token is configured', async () => {
    expect((await fetch(`${base}/openapi.json`)).status).toBe(200);
  });
});

describe('server: bearer auth when a token is set', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => ({ server, base } = await listen(createServer({ token: 's3cret' }))));
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('allows GET /health unauthenticated (liveness)', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('rejects an unauthenticated API request with 401', async () => {
    expect((await fetch(`${base}/openapi.json`)).status).toBe(401);
  });

  it('accepts a correct bearer token', async () => {
    const res = await fetch(`${base}/openapi.json`, { headers: { Authorization: 'Bearer s3cret' } });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong bearer token', async () => {
    const res = await fetch(`${base}/openapi.json`, { headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });
});
