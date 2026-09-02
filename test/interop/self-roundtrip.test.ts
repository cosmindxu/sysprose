// @vitest-environment node
/**
 * Self round-trip conformance: push a model through the OMG SysML v2 API &
 * Services REST protocol (over a real HTTP `createServer()` instance) with the
 * clean-room {@link PilotApiClient}, pull it back, and assert element-set
 * equivalence — proving the client speaks the wire contract our server serves.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSampleModel, Model } from '@core/index';
import { parseModel } from '@text/index';
import { createServer } from '../../src/server/app';
import { PilotApiClient } from '../../src/interop/index';

/** Canonical, order-insensitive signature of a model's element set. */
function signature(model: Model): { elements: string[]; endpoints: string[] } {
  const qn = (id: string): string => model.qualifiedName(id) || `«${model.get(id)?.eClass ?? '?'}»`;
  const elements = model.all().map((el) => `${el.eClass}\t${qn(el.id)}`).sort();
  const endpoints: string[] = [];
  for (const el of model.all()) {
    for (const s of el.source ?? []) {
      for (const t of el.target ?? []) endpoints.push(`${el.eClass}:${qn(s)}→${qn(t)}`);
    }
  }
  return { elements, endpoints: endpoints.sort() };
}

let server: Server;
let baseUrl: string;

beforeAll(() => {
  server = createServer({ seed: false }).listen(0);
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://localhost:${port}/api`;
});

afterAll(() => {
  server.close();
});

describe('PilotApiClient self round-trip', () => {
  it('round-trips buildSampleModel with element-set equivalence', async () => {
    const client = new PilotApiClient(baseUrl);
    const source = buildSampleModel();

    const pushed = await client.pushModel(source, 'SampleRT');
    expect(pushed.projectId).toBeTruthy();
    expect(pushed.branchId).toBeTruthy();
    expect(pushed.commitId).toBeTruthy();

    const pulled = await client.pullModel(pushed.projectId, pushed.commitId);
    expect(pulled.size).toBe(source.size);

    const a = signature(source);
    const b = signature(pulled);
    // metaclass + qualifiedName multiset preserved
    expect(b.elements).toEqual(a.elements);
    // relationship endpoints preserved
    expect(b.endpoints).toEqual(a.endpoints);
    expect(b.endpoints.length).toBeGreaterThan(0);
  });

  it('round-trips a parsed model (examples/vehicle.sysml)', async () => {
    const client = new PilotApiClient(baseUrl);
    const src = readFileSync(fileURLToPath(new URL('../../examples/vehicle.sysml', import.meta.url)), 'utf8');
    const parsed = parseModel(src);
    expect(parsed.model.size).toBeGreaterThan(0);

    const pushed = await client.pushModel(parsed.model, 'VehicleRT');
    const pulled = await client.pullModel(pushed.projectId, pushed.commitId);
    expect(pulled.size).toBe(parsed.model.size);

    const a = signature(parsed.model);
    const b = signature(pulled);
    expect(b.elements).toEqual(a.elements);
    expect(b.endpoints).toEqual(a.endpoints);
  });

  it('preserves ids, metaclasses and containment element-by-element', async () => {
    const client = new PilotApiClient(baseUrl);
    const source = buildSampleModel();
    const pushed = await client.pushModel(source, 'FidelityRT');
    const pulled = await client.pullModel(pushed.projectId, pushed.commitId);

    for (const el of source.all()) {
      const back = pulled.get(el.id);
      expect(back).toBeDefined();
      expect(back!.eClass).toBe(el.eClass);
      expect(back!.ownerId).toBe(el.ownerId);
    }
    // A single element fetched directly matches its metaclass.
    const root = source.roots()[0];
    const oneJson = await client.getElement(pushed.projectId, pushed.commitId, root.id);
    expect(oneJson['@type']).toBe(root.eClass);
    expect(oneJson['@id']).toBe(root.id);
  });

  it('follows pagination to fetch ALL elements (> page size)', async () => {
    // Build a model larger than the page size we will read with.
    const big = new Model();
    const pkg = big.create('Package', { declaredName: 'Big' });
    for (let i = 0; i < 25; i++) {
      big.create('PartUsage', { declaredName: `p${i}`, ownerId: pkg.id });
    }
    expect(big.size).toBe(26);

    // Count how many element-listing requests the client issues.
    let elementRequests = 0;
    const countingFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/elements')) elementRequests++;
      return fetch(input as Parameters<typeof fetch>[0], init);
    };
    const client = new PilotApiClient(baseUrl, { fetchImpl: countingFetch, pageSize: 5 });

    const pushed = await client.pushModel(big, 'PagingRT');
    const pulled = await client.pullModel(pushed.projectId, pushed.commitId);

    // All 26 elements arrived...
    expect(pulled.size).toBe(26);
    // ...across more than one page (26 / 5 ⇒ several requests).
    expect(elementRequests).toBeGreaterThan(1);
    expect(signature(pulled).elements).toEqual(signature(big).elements);
  });

  it('query returns matching elements at a commit', async () => {
    const client = new PilotApiClient(baseUrl);
    const source = buildSampleModel();
    const pushed = await client.pushModel(source, 'QueryRT');

    const partUsages = source.all().filter((el) => el.eClass === 'PartUsage');
    const result = await client.query(pushed.projectId, pushed.commitId, {
      constraint: { property: '@type', operator: '=', value: 'PartUsage' },
    });
    expect(result.total).toBe(partUsages.length);
    expect(result.elements.length).toBe(partUsages.length);
    expect(result.elements.every((e) => e.eClass === 'PartUsage')).toBe(true);
  });

  it('exposes the Git-like resource tree (projects/branches/commits)', async () => {
    const client = new PilotApiClient(baseUrl);
    const source = buildSampleModel();
    const pushed = await client.pushModel(source, 'TreeRT');

    const projects = await client.listProjects();
    expect(projects.some((p) => p['@id'] === pushed.projectId)).toBe(true);

    const project = await client.getProject(pushed.projectId);
    expect(project.name).toBe('TreeRT');

    const branch = await client.getDefaultBranch(pushed.projectId);
    expect(branch['@id']).toBe(pushed.branchId);

    const branches = await client.listBranches(pushed.projectId);
    expect(branches.length).toBeGreaterThanOrEqual(1);

    const commits = await client.listCommits(pushed.projectId);
    expect(commits.some((c) => c['@id'] === pushed.commitId)).toBe(true);
  });

  it('uses the base URL verbatim as the API root (trailing slash trimmed)', async () => {
    const port = (server.address() as AddressInfo).port;
    // Our server mounts the API at /api, so the caller passes .../api. The base
    // URL is used VERBATIM (no forced /api) so the SAME client also works against
    // servers mounted at the host root (e.g. the OMG pilot at http://host:9000).
    const withApi = new PilotApiClient(`http://localhost:${port}/api`);
    const trailing = new PilotApiClient(`http://localhost:${port}/api/`);
    const a = await withApi.listProjects();
    const c = await trailing.listProjects();
    expect(Array.isArray(a)).toBe(true);
    expect(Array.isArray(c)).toBe(true);
    // A base pointing at the wrong root (no /api against our /api-mounted server)
    // is NOT silently rewritten — verbatim means it fails, as it should.
    const wrongRoot = new PilotApiClient(`http://localhost:${port}`);
    await expect(wrongRoot.listProjects()).rejects.toThrow(/404|Unknown route/i);
  });
});
