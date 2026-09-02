// @vitest-environment node
/**
 * Optimistic-concurrency / multi-user tests for the optional Express server.
 *
 * Runs under Node. Verifies that commit writes return an `ETag` naming the new
 * head, that conditional writes (`If-Match` header or `baseCommit` body field)
 * against a stale head are rejected with 409 Conflict while the fresh writer
 * succeeds, and that sequential correct writes advance the head. The shared
 * repository sequences writes atomically (the head read + write happen in one
 * synchronous handler invocation).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from '../../src/server/app';

let server: Server;
let base: string;

interface Res {
  status: number;
  etag: string | null;
  json: any;
}

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get('etag'), json: text ? JSON.parse(text) : undefined };
}

let projectId: string;

beforeAll(async () => {
  const app = createServer();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  projectId = (await req('GET', '/api/projects')).json[0]['@id'];
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

function addPart(name: string): unknown {
  return { description: `add ${name}`, changes: [{ operation: 'create', element: { '@type': 'PartDefinition', declaredName: name } }] };
}

describe('server: commit responses carry an ETag naming the new head', () => {
  it('a project GET exposes the current head; a commit advances it and ETags it', async () => {
    const project = await req('GET', `/api/projects/${projectId}`);
    expect(project.status).toBe(200);
    const head0: string = project.json.defaultCommit;
    expect(head0).toBeTruthy();

    const commit = await req('POST', `/api/projects/${projectId}/commits`, addPart('Alpha'));
    expect(commit.status).toBe(201);
    expect(commit.json['@type']).toBe('Commit');
    // ETag names the new head and matches the commit id.
    expect(commit.etag).toBe(`"${commit.json['@id']}"`);
    expect(commit.json['@id']).not.toBe(head0);

    // The project head advanced to the new commit.
    const after = await req('GET', `/api/projects/${projectId}`);
    expect(after.json.defaultCommit).toBe(commit.json['@id']);

    // A branch GET also carries an ETag naming its head.
    const branchId = after.json.defaultBranch['@id'];
    const branch = await req('GET', `/api/projects/${projectId}/branches/${branchId}`);
    expect(branch.status).toBe(200);
    expect(branch.etag).toBe(`"${after.json.defaultCommit}"`);
  });
});

describe('server: two clients race on the same head (If-Match)', () => {
  it('the stale client gets 409, the fresh one 201, and the head advances once', async () => {
    // Both clients read the current head ETag.
    const head = (await req('GET', `/api/projects/${projectId}`)).json.defaultCommit;
    expect(head).toBeTruthy();
    const sharedEtag = `"${head}"`;

    // Client A commits first with the matching If-Match → succeeds.
    const a = await req('POST', `/api/projects/${projectId}/commits`, addPart('RaceA'), { 'If-Match': sharedEtag });
    expect(a.status).toBe(201);
    const newHead: string = a.json['@id'];
    expect(newHead).not.toBe(head);
    expect(a.etag).toBe(`"${newHead}"`);

    // Client B commits with the now-stale If-Match → 409 Conflict.
    const b = await req('POST', `/api/projects/${projectId}/commits`, addPart('RaceB'), { 'If-Match': sharedEtag });
    expect(b.status).toBe(409);
    expect(b.json.error).toMatch(/conflict/i);
    expect(b.json.currentHead).toBe(newHead);
    expect(b.json.expected).toBe(head);

    // The head advanced exactly once (to A's commit), B did not apply.
    const nowHead = (await req('GET', `/api/projects/${projectId}`)).json.defaultCommit;
    expect(nowHead).toBe(newHead);

    // A sequential correct commit (fresh If-Match) advances the head again.
    const c = await req('POST', `/api/projects/${projectId}/commits`, addPart('RaceC'), { 'If-Match': `"${newHead}"` });
    expect(c.status).toBe(201);
    expect(c.json['@id']).not.toBe(newHead);
    const finalHead = (await req('GET', `/api/projects/${projectId}`)).json.defaultCommit;
    expect(finalHead).toBe(c.json['@id']);
  });

  it('supports baseCommit body field as an If-Match alternative', async () => {
    const head = (await req('GET', `/api/projects/${projectId}`)).json.defaultCommit;

    // Stale baseCommit → 409.
    const stale = await req('POST', `/api/projects/${projectId}/commits`, {
      baseCommit: 'commit-does-not-exist',
      changes: [{ operation: 'create', element: { '@type': 'PartDefinition', declaredName: 'BaseStale' } }],
    });
    expect(stale.status).toBe(409);

    // Correct baseCommit → applies.
    const good = await req('POST', `/api/projects/${projectId}/commits`, {
      baseCommit: head,
      changes: [{ operation: 'create', element: { '@type': 'PartDefinition', declaredName: 'BaseGood' } }],
    });
    expect(good.status).toBe(201);
  });

  it('an unconditional commit (no If-Match) still applies and advances the head', async () => {
    const before = (await req('GET', `/api/projects/${projectId}`)).json.defaultCommit;
    const commit = await req('POST', `/api/projects/${projectId}/commits`, addPart('Unconditional'));
    expect(commit.status).toBe(201);
    const after = (await req('GET', `/api/projects/${projectId}`)).json.defaultCommit;
    expect(after).toBe(commit.json['@id']);
    expect(after).not.toBe(before);
  });

  it('If-Match: * applies against any existing head', async () => {
    const commit = await req('POST', `/api/projects/${projectId}/commits`, addPart('Wildcard'), { 'If-Match': '*' });
    expect(commit.status).toBe(201);
  });
});
