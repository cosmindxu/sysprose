// @vitest-environment node
/**
 * HTTP-level tests for the optional Node/Express deployment (`src/server`).
 *
 * Runs under the Node environment (express + http need real Node), starts the
 * app on an ephemeral port (`listen(0)`), exercises the mounted OMG REST +
 * OSLC + discovery routes with the global `fetch`, then closes the server.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from '../../src/server/app';

let server: Server;
let base: string;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  const app = createServer(); // seeded demo project
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe('server: discovery + health', () => {
  it('GET /health returns 200 ok', async () => {
    const { status, json } = await api('GET', '/health');
    expect(status).toBe(200);
    expect(json.status).toBe('ok');
  });

  it('GET /openapi.json is a valid OpenAPI 3.1 document', async () => {
    const { status, json } = await api('GET', '/openapi.json');
    expect(status).toBe(200);
    expect(typeof json.openapi).toBe('string');
    expect(json.openapi.startsWith('3.1')).toBe(true);
    expect(json.info?.title).toBeTruthy();
    expect(json.paths && typeof json.paths).toBe('object');
    // Coverage: the load-bearing routes are all described.
    expect(json.paths['/health']).toBeTruthy();
    expect(json.paths['/api/projects']).toBeTruthy();
    expect(json.paths['/api/projects/{projectId}/commits']).toBeTruthy();
    expect(json.paths['/oslc/catalog']).toBeTruthy();
    // Schemas referenced by the task exist.
    for (const s of ['Element', 'Project', 'Commit', 'Query', 'QueryResult']) {
      expect(json.components.schemas[s]).toBeTruthy();
    }
  });

  it('GET /docs serves an HTML viewer', async () => {
    const res = await fetch(`${base}/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/html/);
    expect(await res.text()).toMatch(/openapi\.json/);
  });

  it('sets permissive CORS headers', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('server: OMG REST surface', () => {
  it('GET /api/projects returns a non-empty list', async () => {
    const { status, json } = await api('GET', '/api/projects');
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBeGreaterThan(0);
    expect(json[0]['@type']).toBe('Project');
  });

  it('POST a commit, then GET its elements (paginated) and a diff', async () => {
    // Resolve the seeded project and its default branch/commit.
    const projects = await api('GET', '/api/projects');
    const projectId = projects.json[0]['@id'];
    const project = await api('GET', `/api/projects/${projectId}`);
    expect(project.status).toBe(200);
    const baseCommitId: string = project.json.defaultCommit;
    expect(baseCommitId).toBeTruthy();

    // Create a commit that adds one element.
    const commitRes = await api('POST', `/api/projects/${projectId}/commits`, {
      description: 'add a part definition',
      changes: [
        {
          operation: 'create',
          element: { '@type': 'PartDefinition', declaredName: 'Wheel' },
        },
      ],
    });
    expect(commitRes.status).toBe(201);
    expect(commitRes.json['@type']).toBe('Commit');
    const newCommitId: string = commitRes.json['@id'];
    expect(newCommitId).toBeTruthy();

    // Elements at the new commit, paginated.
    const page = await api('GET', `/api/projects/${projectId}/commits/${newCommitId}/elements?offset=0&limit=3`);
    expect(page.status).toBe(200);
    expect(page.json.commitId).toBe(newCommitId);
    expect(Array.isArray(page.json.elements)).toBe(true);
    expect(page.json.elements.length).toBeLessThanOrEqual(3);
    expect(page.json.total).toBeGreaterThan(0);

    // The new element is present in a full listing.
    const all = await api('GET', `/api/projects/${projectId}/commits/${newCommitId}/elements`);
    const names = all.json.elements.map((e: any) => e.declaredName);
    expect(names).toContain('Wheel');

    // Diff new commit against the base commit shows the addition.
    const diff = await api('GET', `/api/projects/${projectId}/commits/${newCommitId}/diff/${baseCommitId}`);
    expect(diff.status).toBe(200);
    expect(Array.isArray(diff.json.added)).toBe(true);
    expect(diff.json.added.length).toBe(1);
    expect(diff.json.added[0].declaredName).toBe('Wheel');
    expect(diff.json.removed.length).toBe(0);
  });

  it('POST .../query-results returns a QueryResult', async () => {
    const projects = await api('GET', '/api/projects');
    const projectId = projects.json[0]['@id'];
    const commitId = (await api('GET', `/api/projects/${projectId}`)).json.defaultCommit;

    const qr = await api('POST', `/api/projects/${projectId}/commits/${commitId}/query-results`, {
      constraint: { property: '@type', operator: '=', value: 'PartDefinition' },
    });
    expect(qr.status).toBe(200);
    expect(typeof qr.json.commitId).toBe('string');
    expect(typeof qr.json.total).toBe('number');
    expect(Array.isArray(qr.json.elements)).toBe(true);
    expect(qr.json.elements.length).toBeGreaterThan(0);
    // query-results emits raw element records (metaclass in `eClass`).
    expect(qr.json.elements.every((e: any) => e.eClass === 'PartDefinition')).toBe(true);
  });

  it('GET /api/analytics/metrics returns a report', async () => {
    const { status, json } = await api('GET', '/api/analytics/metrics');
    expect(status).toBe(200);
    expect(json && typeof json).toBe('object');
  });
});

describe('server: OSLC surface', () => {
  it('GET /oslc/catalog returns an OSLC ServiceProviderCatalog', async () => {
    const { status, json } = await api('GET', '/oslc/catalog');
    expect(status).toBe(200);
    expect(json['@type']).toBe('oslc:ServiceProviderCatalog');
    expect(Array.isArray(json['oslc:serviceProvider'])).toBe(true);
    expect(json['@context']).toBeTruthy();
  });

  it('GET /oslc/query returns an oslc:ResponseInfo with members', async () => {
    const { status, json } = await api('GET', '/oslc/query');
    expect(status).toBe(200);
    expect(json['@type']).toBe('oslc:ResponseInfo');
    expect(Array.isArray(json['rdfs:member'])).toBe(true);
  });
});
