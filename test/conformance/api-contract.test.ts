// @vitest-environment node
/**
 * OpenAPI CONTRACT conformance for the mounted OMG REST surface (`src/server`).
 *
 * Runs under Node (express + http), starts the app on an ephemeral port, then
 * for a representative set of GET/POST endpoints fetches the LIVE response and
 * validates its body against the response schema DECLARED for that endpoint in
 * {@link openApiDocument} (`components.schemas`). This proves the served API
 * and its own OpenAPI description are self-consistent.
 *
 * Ajv is configured with every component schema registered under its
 * canonical `#/components/schemas/<Name>` pointer so intra-document `$ref`s
 * resolve; `ajv-formats` supplies the standard string formats.
 *
 * Contract fixes made while writing this suite (see git history of
 * `src/server/openapi.ts`):
 *   - `QueryResult.elements` referenced the OMG element-graph `Element`
 *     (`@id`/`@type`) shape, but the query endpoints actually return native
 *     model-JSON element records (`id`/`eClass`/`ownerId`/`attrs`). Added a
 *     `QueryResultElement` schema and pointed `QueryResult.elements` at it.
 *   - `GET /analytics/metrics` had no declared response schema; added a
 *     `Metrics` schema and wired it into the response so it can be validated.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { createServer } from '../../src/server/app';
import { openApiDocument } from '../../src/server/openapi';

let server: Server;
let base: string;
let ajv: Ajv;

/** Component schemas from the served OpenAPI document. */
const schemas = (openApiDocument as { components: { schemas: Record<string, unknown> } }).components
  .schemas;

/** Compile a validator for a single named component schema. */
function schemaValidator(name: string): ValidateFunction {
  return ajv.compile({ $ref: `#/components/schemas/${name}` });
}

/** Compile a validator for an array whose items are a named component schema. */
function arrayValidator(name: string): ValidateFunction {
  return ajv.compile({ type: 'array', items: { $ref: `#/components/schemas/${name}` } });
}

/** Assert an Ajv validator passes; surface the errors verbatim on failure. */
function assertValid(validate: ValidateFunction, body: unknown, label: string): void {
  const ok = validate(body);
  if (!ok) {
    throw new Error(`${label} failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`);
  }
  expect(ok).toBe(true);
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function postJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function putJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function del(path: string): Promise<{ status: number }> {
  const res = await fetch(`${base}${path}`, { method: 'DELETE' });
  return { status: res.status };
}

/** Commit a change-set onto a branch of a project; return the new commit id. */
async function commitChange(
  projectId: string,
  branchId: string,
  changes: unknown[],
): Promise<string> {
  const { status, body } = await postJson(`/api/projects/${projectId}/commits`, {
    branch: branchId,
    changes,
  });
  expect(status).toBe(201);
  return (body as { '@id': string })['@id'];
}

beforeAll(async () => {
  const app = createServer(); // seeded demo project
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  // Register each component schema by name at '#/components/schemas/<Name>' so
  // that intra-document $refs (e.g. Project.defaultBranch -> Ref) resolve.
  for (const [name, schema] of Object.entries(schemas)) {
    ajv.addSchema(schema as object, `#/components/schemas/${name}`);
  }
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe('OpenAPI contract: representative GET/POST endpoints validate against declared schemas', () => {
  // Discovered at runtime from the live, seeded repository.
  let projectId: string;
  let commitId: string;
  let elementId: string;

  it('GET /api/projects -> 2xx and array of Project', async () => {
    const { status, body } = await getJson('/api/projects');
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBeGreaterThan(0);
    assertValid(arrayValidator('Project'), body, 'GET /api/projects');
    projectId = (body as Array<{ '@id': string }>)[0]['@id'];
    expect(typeof projectId).toBe('string');
  });

  it('GET /api/projects/{id} -> 2xx and Project', async () => {
    const { status, body } = await getJson(`/api/projects/${projectId}`);
    expect(status).toBe(200);
    assertValid(schemaValidator('Project'), body, 'GET /api/projects/{id}');
    commitId = (body as { defaultCommit: string }).defaultCommit;
    expect(typeof commitId).toBe('string');
  });

  it('GET /api/projects/{id}/commits -> 2xx and Commit[]', async () => {
    const { status, body } = await getJson(`/api/projects/${projectId}/commits`);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBeGreaterThan(0);
    assertValid(arrayValidator('Commit'), body, 'GET /api/projects/{id}/commits');
  });

  it('GET /api/projects/{id}/branches -> 2xx and Branch[]', async () => {
    const { status, body } = await getJson(`/api/projects/${projectId}/branches`);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    assertValid(arrayValidator('Branch'), body, 'GET /api/projects/{id}/branches');
  });

  it('GET .../commits/{cid}/elements -> 2xx and ElementsPage (element-graph elements)', async () => {
    const { status, body } = await getJson(
      `/api/projects/${projectId}/commits/${commitId}/elements?offset=0&limit=3`,
    );
    expect(status).toBe(200);
    assertValid(schemaValidator('ElementsPage'), body, 'GET .../elements');
    const page = body as { elements: Array<{ '@id': string }>; total: number };
    expect(page.total).toBeGreaterThan(0);
    expect(page.elements.length).toBeLessThanOrEqual(3);
    elementId = page.elements[0]['@id'];
    expect(typeof elementId).toBe('string');
  });

  it('GET .../commits/{cid}/elements/{eid} -> 2xx and Element', async () => {
    const { status, body } = await getJson(
      `/api/projects/${projectId}/commits/${commitId}/elements/${elementId}`,
    );
    expect(status).toBe(200);
    assertValid(schemaValidator('Element'), body, 'GET .../elements/{eid}');
  });

  it('GET /api/elements/{eid} -> 2xx and Element (default HEAD)', async () => {
    const { status, body } = await getJson(`/api/elements/${elementId}`);
    expect(status).toBe(200);
    assertValid(schemaValidator('Element'), body, 'GET /api/elements/{eid}');
    expect((body as { '@type': string })['@type']).toBeTruthy();
  });

  it('GET /api/analytics/metrics -> 2xx and Metrics', async () => {
    const { status, body } = await getJson('/api/analytics/metrics');
    expect(status).toBe(200);
    assertValid(schemaValidator('Metrics'), body, 'GET /api/analytics/metrics');
    expect((body as { totalElements: number }).totalElements).toBeGreaterThan(0);
  });

  it('POST /api/queries -> 2xx and QueryResult (native element records)', async () => {
    const { status, body } = await postJson('/api/queries', {});
    expect(status).toBe(200);
    assertValid(schemaValidator('QueryResult'), body, 'POST /api/queries');
    const qr = body as { elements: Array<{ id: string; eClass: string }> };
    expect(qr.elements.length).toBeGreaterThan(0);
    expect(qr.elements.every((e) => typeof e.id === 'string' && typeof e.eClass === 'string')).toBe(
      true,
    );
  });

  it('POST .../commits/{cid}/query-results -> 2xx and QueryResult', async () => {
    const { status, body } = await postJson(
      `/api/projects/${projectId}/commits/${commitId}/query-results`,
      {
        constraint: {
          property: '@type',
          operator: '=',
          value: 'PartDefinition',
        },
      },
    );
    expect(status).toBe(200);
    assertValid(schemaValidator('QueryResult'), body, 'POST .../query-results');
    const qr = body as { elements: Array<{ eClass: string }> };
    expect(qr.elements.every((e) => e.eClass === 'PartDefinition')).toBe(true);
  });

  it('the QueryResult contract fix is reflected in the served document', () => {
    // Regression guard: QueryResult.elements must reference the native
    // QueryResultElement shape, not the element-graph Element shape.
    const qr = schemas.QueryResult as { properties: { elements: { items: { $ref: string } } } };
    expect(qr.properties.elements.items.$ref).toBe('#/components/schemas/QueryResultElement');
    expect(schemas.QueryResultElement).toBeTruthy();
    expect(schemas.Metrics).toBeTruthy();
  });
});

describe('OMG resource surface — new endpoints validate against declared schemas', () => {
  let projectId: string;
  let commitId: string;
  let elementId: string;

  beforeAll(async () => {
    const projects = (await getJson('/api/projects')).body as Array<{ '@id': string }>;
    projectId = projects[0]['@id'];
    const project = (await getJson(`/api/projects/${projectId}`)).body as { defaultCommit: string };
    commitId = project.defaultCommit;
    const page = (await getJson(`/api/projects/${projectId}/commits/${commitId}/elements?limit=1`))
      .body as { elements: Array<{ '@id': string }> };
    elementId = page.elements[0]['@id'];
  });

  it('GET .../elements/{eid}/relationships -> 200 and RelationshipsResult', async () => {
    const { status, body } = await getJson(
      `/api/projects/${projectId}/commits/${commitId}/elements/${elementId}/relationships`,
    );
    expect(status).toBe(200);
    assertValid(schemaValidator('RelationshipsResult'), body, 'GET .../relationships');
    const r = body as { owned: unknown[]; owning: unknown[]; incoming: unknown[]; outgoing: unknown[] };
    expect(Array.isArray(r.owned)).toBe(true);
    expect(Array.isArray(r.incoming)).toBe(true);
    expect(Array.isArray(r.outgoing)).toBe(true);
  });

  it('GET .../diff?base=&compare= (arbitrary commits) -> 200 and CommitDiff', async () => {
    const { status, body } = await getJson(
      `/api/projects/${projectId}/diff?base=${commitId}&compare=${commitId}`,
    );
    expect(status).toBe(200);
    assertValid(schemaValidator('CommitDiff'), body, 'GET .../diff');
    const d = body as { added: unknown[]; removed: unknown[]; changed: unknown[] };
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.changed).toHaveLength(0);
  });

  it('missing base/compare on arbitrary diff -> 404', async () => {
    const { status } = await getJson(`/api/projects/${projectId}/diff`);
    expect(status).toBe(404);
  });

  it('?type= and ?name= filter element pages', async () => {
    const all = (await getJson(`/api/projects/${projectId}/commits/${commitId}/elements`)).body as {
      elements: Array<{ '@type': string }>;
      total: number;
    };
    const someType = all.elements[0]['@type'];
    const filtered = (
      await getJson(
        `/api/projects/${projectId}/commits/${commitId}/elements?type=${encodeURIComponent(someType)}`,
      )
    ).body as { elements: Array<{ '@type': string }>; total: number };
    expect(filtered.total).toBeLessThanOrEqual(all.total);
    expect(filtered.elements.every((e) => e['@type'] === someType)).toBe(true);
  });

  it('cursor paging accepts the OMG page[size]/page[after] spelling', async () => {
    const first = (
      await getJson(`/api/projects/${projectId}/commits/${commitId}/elements?page[size]=2`)
    ).body as { elements: Array<{ '@id': string }>; nextCursor?: string };
    expect(first.elements.length).toBeLessThanOrEqual(2);
    if (first.nextCursor) {
      const next = (
        await getJson(
          `/api/projects/${projectId}/commits/${commitId}/elements?page[size]=2&page[after]=${first.nextCursor}`,
        )
      ).body as { elements: Array<{ '@id': string }> };
      expect(next.elements[0]['@id']).not.toBe(first.elements[0]['@id']);
    }
  });
});

describe('OMG resource surface — project/branch/tag/query CRUD lifecycles', () => {
  it('project PUT rename + DELETE lifecycle (201/200/204/404)', async () => {
    const created = await postJson('/api/projects', { name: 'CrudProj' });
    expect(created.status).toBe(201);
    const pid = (created.body as { '@id': string })['@id'];

    const renamed = await putJson(`/api/projects/${pid}`, { name: 'CrudProjRenamed' });
    expect(renamed.status).toBe(200);
    expect((renamed.body as { name: string }).name).toBe('CrudProjRenamed');
    assertValid(schemaValidator('Project'), renamed.body, 'PUT /api/projects/{id}');

    expect((await putJson(`/api/projects/${pid}`, {})).status).toBe(405);

    const deleted = await del(`/api/projects/${pid}`);
    expect(deleted.status).toBe(204);
    expect((await getJson(`/api/projects/${pid}`)).status).toBe(404);
  });

  it('branch DELETE (204), default-branch DELETE (409), tag DELETE (204)', async () => {
    const pid = ((await postJson('/api/projects', { name: 'BranchProj' })).body as { '@id': string })[
      '@id'
    ];
    const defaultBranch = ((await getJson(`/api/projects/${pid}/branches`)).body as Array<{
      '@id': string;
    }>)[0]['@id'];
    const head = (await getJson(`/api/projects/${pid}`)).body as { defaultCommit: string };

    // A deletable feature branch.
    const feature = (await postJson(`/api/projects/${pid}/branches`, { name: 'feature' }))
      .body as { '@id': string };
    expect((await del(`/api/projects/${pid}/branches/${feature['@id']}`)).status).toBe(204);
    expect((await getJson(`/api/projects/${pid}/branches/${feature['@id']}`)).status).toBe(404);

    // The default branch cannot be deleted -> 409.
    expect((await del(`/api/projects/${pid}/branches/${defaultBranch}`)).status).toBe(409);

    // Tag then delete.
    const tag = (await postJson(`/api/projects/${pid}/tags`, { name: 'v1', commit: head.defaultCommit }))
      .body as { '@id': string };
    expect((await del(`/api/projects/${pid}/tags/${tag['@id']}`)).status).toBe(204);
    expect((await getJson(`/api/projects/${pid}/tags/${tag['@id']}`)).status).toBe(404);
  });

  it('stored-query CRUD + results lifecycle validates against schemas', async () => {
    const pid = ((await postJson('/api/projects', { name: 'QueryProj' })).body as { '@id': string })[
      '@id'
    ];
    const branch = ((await getJson(`/api/projects/${pid}/branches`)).body as Array<{ '@id': string }>)[0][
      '@id'
    ];
    // Seed an element so the stored query has something to match.
    await commitChange(pid, branch, [
      { operation: 'create', element: { '@type': 'PartDefinition', identifier: 'sq-part', declaredName: 'SQ' } },
    ]);

    const create = await postJson(`/api/projects/${pid}/queries`, {
      name: 'parts',
      query: { constraint: { property: '@type', operator: '=', value: 'PartDefinition' } },
    });
    expect(create.status).toBe(201);
    assertValid(schemaValidator('StoredQuery'), create.body, 'POST .../queries');
    const qid = (create.body as { '@id': string })['@id'];

    const list = await getJson(`/api/projects/${pid}/queries`);
    expect(list.status).toBe(200);
    assertValid(arrayValidator('StoredQuery'), list.body, 'GET .../queries');
    expect((list.body as unknown[]).length).toBe(1);

    const got = await getJson(`/api/projects/${pid}/queries/${qid}`);
    expect(got.status).toBe(200);
    assertValid(schemaValidator('StoredQuery'), got.body, 'GET .../queries/{qid}');

    const put = await putJson(`/api/projects/${pid}/queries/${qid}`, { name: 'renamed-query' });
    expect(put.status).toBe(200);
    expect((put.body as { name: string }).name).toBe('renamed-query');

    const results = await getJson(`/api/projects/${pid}/queries/${qid}/results`);
    expect(results.status).toBe(200);
    assertValid(schemaValidator('QueryResult'), results.body, 'GET .../queries/{qid}/results');
    const qr = results.body as { elements: Array<{ eClass: string }> };
    expect(qr.elements.every((e) => e.eClass === 'PartDefinition')).toBe(true);

    expect((await del(`/api/projects/${pid}/queries/${qid}`)).status).toBe(204);
    expect((await getJson(`/api/projects/${pid}/queries/${qid}`)).status).toBe(404);
  });
});

describe('OMG resource surface — 3-way branch merge', () => {
  it('clean merge auto-merges divergent adds (201, MergeResult, no conflicts)', async () => {
    const pid = ((await postJson('/api/projects', { name: 'MergeClean' })).body as { '@id': string })[
      '@id'
    ];
    const main = ((await getJson(`/api/projects/${pid}/branches`)).body as Array<{ '@id': string }>)[0][
      '@id'
    ];
    // Common base: add A on main.
    await commitChange(pid, main, [
      { operation: 'create', element: { '@type': 'PartDefinition', identifier: 'A', declaredName: 'A' } },
    ]);
    const feature = ((await postJson(`/api/projects/${pid}/branches`, { name: 'feature' })).body as {
      '@id': string;
    })['@id'];
    // Divergent, non-conflicting adds: B on main, C on feature.
    await commitChange(pid, main, [
      { operation: 'create', element: { '@type': 'PartDefinition', identifier: 'B', declaredName: 'B' } },
    ]);
    await commitChange(pid, feature, [
      { operation: 'create', element: { '@type': 'PartDefinition', identifier: 'C', declaredName: 'C' } },
    ]);

    const merged = await postJson(`/api/projects/${pid}/merge`, { source: feature, target: main });
    expect(merged.status).toBe(201);
    assertValid(schemaValidator('MergeResult'), merged.body, 'POST .../merge (clean)');
    const mr = merged.body as { applied: boolean; conflicts: unknown[]; commit: { '@id': string } | null };
    expect(mr.applied).toBe(true);
    expect(mr.conflicts).toHaveLength(0);
    expect(mr.commit).not.toBeNull();

    // The merge commit contains A, B and C together.
    const mergeCid = (mr.commit as { '@id': string })['@id'];
    const roots = (await getJson(`/api/projects/${pid}/commits/${mergeCid}/elements?limit=100`)).body as {
      elements: Array<{ '@id': string }>;
    };
    const ids = roots.elements.map((e) => e['@id']);
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    expect(ids).toContain('C');
  });

  it('conflicting change reports 409 under manual and resolves under theirs', async () => {
    const pid = ((await postJson('/api/projects', { name: 'MergeConflict' })).body as { '@id': string })[
      '@id'
    ];
    const main = ((await getJson(`/api/projects/${pid}/branches`)).body as Array<{ '@id': string }>)[0][
      '@id'
    ];
    await commitChange(pid, main, [
      { operation: 'create', element: { '@type': 'PartDefinition', identifier: 'X', declaredName: 'base' } },
    ]);
    const feature = ((await postJson(`/api/projects/${pid}/branches`, { name: 'feature' })).body as {
      '@id': string;
    })['@id'];
    // Both sides rename X differently -> change/change conflict.
    await commitChange(pid, main, [{ operation: 'update', identifier: 'X', element: { declaredName: 'ours' } }]);
    await commitChange(pid, feature, [
      { operation: 'update', identifier: 'X', element: { declaredName: 'theirs' } },
    ]);

    const manual = await postJson(`/api/projects/${pid}/merge`, {
      source: feature,
      target: main,
      strategy: 'manual',
    });
    expect(manual.status).toBe(409);
    assertValid(schemaValidator('MergeResult'), manual.body, 'POST .../merge (manual conflict)');
    const mm = manual.body as { applied: boolean; conflicts: Array<{ '@id': string; kind: string }> };
    expect(mm.applied).toBe(false);
    expect(mm.conflicts).toHaveLength(1);
    expect(mm.conflicts[0]['@id']).toBe('X');
    expect(mm.conflicts[0].kind).toBe('change-change');

    const theirs = await postJson(`/api/projects/${pid}/merge`, {
      source: feature,
      target: main,
      strategy: 'theirs',
    });
    expect(theirs.status).toBe(201);
    const mt = theirs.body as { applied: boolean; commit: { '@id': string } };
    expect(mt.applied).toBe(true);
    const x = (await getJson(`/api/projects/${pid}/commits/${mt.commit['@id']}/elements/X`)).body as {
      declaredName: string;
    };
    expect(x.declaredName).toBe('theirs');
  });
});

describe('OpenAPI coverage — every documented GET path has an implemented route', () => {
  // Substitution values for path templates, discovered/created at runtime.
  const subs: Record<string, string> = {};

  beforeAll(async () => {
    const projects = (await getJson('/api/projects')).body as Array<{ '@id': string }>;
    const projectId = projects[0]['@id'];
    subs.projectId = projectId;
    const project = (await getJson(`/api/projects/${projectId}`)).body as { defaultCommit: string };
    subs.commitId = project.defaultCommit;
    subs.baseCommitId = project.defaultCommit;
    const branches = (await getJson(`/api/projects/${projectId}/branches`)).body as Array<{ '@id': string }>;
    subs.branchId = branches[0]['@id'];
    const page = (await getJson(`/api/projects/${projectId}/commits/${subs.commitId}/elements?limit=1`))
      .body as { elements: Array<{ '@id': string }> };
    subs.elementId = page.elements[0]['@id'];
    const tag = (await postJson(`/api/projects/${projectId}/tags`, { name: 'cov', commit: subs.commitId }))
      .body as { '@id': string };
    subs.tagId = tag['@id'];
    const q = (
      await postJson(`/api/projects/${projectId}/queries`, {
        query: { constraint: { property: '@type', operator: 'exists' } },
      })
    ).body as { '@id': string };
    subs.queryId = q['@id'];
  });

  it('enumerates openApiDocument.paths and confirms each GET is routed (not 404)', async () => {
    const paths = (openApiDocument as { paths: Record<string, Record<string, unknown>> }).paths;
    let checked = 0;
    let skipped = 0;
    for (const [template, item] of Object.entries(paths)) {
      if (!item.get) continue;
      let path = template.replace(/\{(\w+)\}/g, (_m, name: string) => subs[name] ?? `{${name}}`);
      if (path.includes('{')) {
        skipped++;
        continue; // an unknown path parameter we cannot substitute
      }
      // The arbitrary-diff GET requires base/compare query parameters.
      if (path.endsWith('/diff')) path += `?base=${subs.commitId}&compare=${subs.commitId}`;
      const res = await fetch(`${base}${path}`);
      expect(res.status, `${template} -> ${path}`).not.toBe(404);
      expect(res.status, `${template} -> ${path}`).toBeLessThan(500);
      checked++;
    }
    // We should have positively exercised a broad set of documented GET routes.
    expect(checked).toBeGreaterThanOrEqual(15);
    expect(skipped).toBe(0);
  });
});
