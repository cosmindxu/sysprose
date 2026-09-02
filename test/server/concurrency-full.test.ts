// @vitest-environment node
/**
 * Real multi-user concurrency for the optional Express server (`src/server`).
 *
 * Runs under Node (express + http) on an ephemeral port. Where
 * `concurrency.test.ts` covers the sequential optimistic-concurrency contract,
 * this suite fires genuinely *overlapping* async requests and asserts the
 * per-project write serialization added in `src/server/app.ts` +
 * `src/api/versioning.ts`:
 *
 *   - N concurrent `POST …/commits` to the SAME branch with the SAME base head
 *     ⇒ exactly one wins (advances the head by one), the rest 409 with
 *     `{ currentHead, expected }` (no lost updates).
 *   - concurrent commits to DIFFERENT branches of a project all succeed.
 *   - a 3-way merge of two divergent branches that both edited the same element
 *     produces a merge commit AND reports that element as a conflict.
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

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get('etag'), json: text ? JSON.parse(text) : undefined };
}

/** Create a fresh, isolated project and return its id + head + default branch. */
async function freshProject(name: string): Promise<{ id: string; head: string; branch: string }> {
  const p = await req('POST', '/api/projects', { name });
  expect(p.status).toBe(201);
  return { id: p.json['@id'], head: p.json.defaultCommit, branch: p.json.defaultBranch['@id'] };
}

function createPart(name: string, branch?: string, extra: Record<string, unknown> = {}): unknown {
  return {
    ...(branch ? { branch } : {}),
    description: `add ${name}`,
    changes: [{ operation: 'create', element: { '@type': 'PartDefinition', declaredName: name } }],
    ...extra,
  };
}

function renamePart(id: string, name: string, branch?: string, extra: Record<string, unknown> = {}): unknown {
  return {
    ...(branch ? { branch } : {}),
    description: `rename ${id} → ${name}`,
    changes: [{ operation: 'update', identifier: id, element: { declaredName: name } }],
    ...extra,
  };
}

beforeAll(async () => {
  const app = createServer({ seed: false });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe('server: N concurrent commits to the same branch on the same base', () => {
  it('serializes to exactly one winner; the rest 409 and the head advances once', async () => {
    const { id, head } = await freshProject('Race');
    const ifMatch = `"${head}"`;
    const N = 8;

    // Fire N overlapping conditional commits, all naming the SAME base head.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        req('POST', `/api/projects/${id}/commits`, createPart(`P${i}`), { 'If-Match': ifMatch }),
      ),
    );

    const winners = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status === 409);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(N - 1);

    // The single winner advanced the head exactly once.
    const winHead: string = winners[0].json['@id'];
    expect(winHead).not.toBe(head);
    expect(winners[0].etag).toBe(`"${winHead}"`);

    // Every loser reports the fresh head and the (now stale) expected base.
    for (const l of losers) {
      expect(l.json.error).toMatch(/conflict/i);
      expect(l.json.expected).toBe(head);
      expect(l.json.currentHead).toBe(winHead);
    }

    // The live head is the winner's commit — no lost updates.
    const now = await req('GET', `/api/projects/${id}`);
    expect(now.json.defaultCommit).toBe(winHead);
  });

  it('a fresh conditional write on the new head then succeeds again', async () => {
    const { id, head } = await freshProject('Race2');
    const first = await req('POST', `/api/projects/${id}/commits`, createPart('one'), { 'If-Match': `"${head}"` });
    expect(first.status).toBe(201);
    const h1 = first.json['@id'];
    const second = await req('POST', `/api/projects/${id}/commits`, createPart('two'), { 'If-Match': `"${h1}"` });
    expect(second.status).toBe(201);
    expect(second.json['@id']).not.toBe(h1);
  });
});

describe('server: concurrent commits to different branches', () => {
  it('all succeed and each branch head advances independently', async () => {
    const { id, head, branch: main } = await freshProject('MultiBranch');

    // Two extra branches, all rooted at the same initial commit.
    const b1 = (await req('POST', `/api/projects/${id}/branches`, { name: 'b1', fromCommit: head })).json['@id'];
    const b2 = (await req('POST', `/api/projects/${id}/branches`, { name: 'b2', fromCommit: head })).json['@id'];

    // Fire an (unconditional) commit at each branch concurrently.
    const [rMain, r1, r2] = await Promise.all([
      req('POST', `/api/projects/${id}/commits`, createPart('onMain', main)),
      req('POST', `/api/projects/${id}/commits`, createPart('onB1', b1)),
      req('POST', `/api/projects/${id}/commits`, createPart('onB2', b2)),
    ]);
    expect(rMain.status).toBe(201);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    // Three distinct new commits, one per branch.
    const heads = new Set([rMain.json['@id'], r1.json['@id'], r2.json['@id']]);
    expect(heads.size).toBe(3);

    // Each branch head points at its own commit.
    const getHead = async (bid: string) =>
      (await req('GET', `/api/projects/${id}/branches/${bid}`)).json.head['@id'];
    expect(await getHead(main)).toBe(rMain.json['@id']);
    expect(await getHead(b1)).toBe(r1.json['@id']);
    expect(await getHead(b2)).toBe(r2.json['@id']);
  });
});

describe('server: 3-way merge of divergent branches', () => {
  it('produces a merge commit and reports a conflict on a doubly-edited element', async () => {
    const { id, head, branch: main } = await freshProject('Merge');

    // Seed one element on main so both branches share it as their base.
    const seed = await req('POST', `/api/projects/${id}/commits`, createPart('Widget', main), {
      'If-Match': `"${head}"`,
    });
    expect(seed.status).toBe(201);
    const c1: string = seed.json['@id'];

    const page = await req('GET', `/api/projects/${id}/commits/${c1}/elements`);
    const widgetId: string = page.json.elements[0]['@id'];
    expect(widgetId).toBeTruthy();

    // Diverge: branch `feature` off c1, edit the element on BOTH sides.
    const feature = (await req('POST', `/api/projects/${id}/branches`, { name: 'feature', fromCommit: c1 })).json[
      '@id'
    ];

    const onMain = await req('POST', `/api/projects/${id}/commits`, renamePart(widgetId, 'MainWidget', main), {
      'If-Match': `"${c1}"`,
    });
    expect(onMain.status).toBe(201);

    const onFeature = await req(
      'POST',
      `/api/projects/${id}/commits`,
      renamePart(widgetId, 'FeatureWidget', feature),
      { 'If-Match': `"${c1}"` },
    );
    expect(onFeature.status).toBe(201);

    // Merge feature → main with a resolving strategy: applies AND reports conflicts.
    const merge = await req('POST', `/api/projects/${id}/merge`, {
      source: feature,
      target: main,
      strategy: 'theirs',
    });
    expect(merge.status).toBe(201);
    expect(merge.json['@type']).toBe('MergeResult');
    expect(merge.json.applied).toBe(true);
    expect(merge.json.commit).toBeTruthy();
    expect(merge.json.commit['@type']).toBe('Commit');
    expect(merge.json.ancestorCommit['@id']).toBe(c1);

    // The doubly-edited element is reported as a change-change conflict.
    const conflicts = merge.json.conflicts as Array<{ '@id': string; kind: string; resolution: string }>;
    expect(conflicts.length).toBeGreaterThan(0);
    const widgetConflict = conflicts.find((c) => c['@id'] === widgetId);
    expect(widgetConflict).toBeTruthy();
    expect(widgetConflict!.kind).toBe('change-change');
    expect(widgetConflict!.resolution).toBe('source'); // `theirs` keeps the source

    // The merge commit is now the main head; `theirs` kept the feature edit.
    const mergeHead: string = merge.json.commit['@id'];
    const mainHead = (await req('GET', `/api/projects/${id}/branches/${main}`)).json.head['@id'];
    expect(mainHead).toBe(mergeHead);
    const merged = await req('GET', `/api/projects/${id}/commits/${mergeHead}/elements/${widgetId}`);
    expect(merged.status).toBe(200);
    expect(merged.json.declaredName).toBe('FeatureWidget');
  });

  it('a manual merge with conflicts produces NO commit and 409s', async () => {
    const { id, head, branch: main } = await freshProject('MergeManual');
    const seed = await req('POST', `/api/projects/${id}/commits`, createPart('Gadget', main), {
      'If-Match': `"${head}"`,
    });
    const c1: string = seed.json['@id'];
    const gadgetId: string = (await req('GET', `/api/projects/${id}/commits/${c1}/elements`)).json.elements[0]['@id'];

    const feature = (await req('POST', `/api/projects/${id}/branches`, { name: 'feat', fromCommit: c1 })).json['@id'];
    await req('POST', `/api/projects/${id}/commits`, renamePart(gadgetId, 'MainGadget', main), {
      'If-Match': `"${c1}"`,
    });
    await req('POST', `/api/projects/${id}/commits`, renamePart(gadgetId, 'FeatGadget', feature), {
      'If-Match': `"${c1}"`,
    });

    const merge = await req('POST', `/api/projects/${id}/merge`, { source: feature, target: main }); // manual
    expect(merge.status).toBe(409);
    expect(merge.json.applied).toBe(false);
    expect(merge.json.commit).toBeNull();
    expect((merge.json.conflicts as unknown[]).length).toBeGreaterThan(0);
  });
});
