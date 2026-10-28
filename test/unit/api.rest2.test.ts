import { describe, it, expect } from 'vitest';
import { buildSampleModel, type Model } from '@core/index';
import { SysmlApiServer } from '@api/index';
import { parseModel, serializeModel } from '@text/index';
import { checkConstraints } from '@semantics/index';

function server() {
  const model = buildSampleModel();
  return { srv: new SysmlApiServer(model), model, rootId: model.roots()[0].id };
}

/** The default project's current head commit id (advances as commits are made). */
function headCommit(srv: SysmlApiServer): string {
  return (srv.apiFetch('GET', '/projects/project-default').body as { defaultCommit: string }).defaultCommit;
}

describe('REST — projects CRUD-ish', () => {
  it('creates a project (201) and lists it alongside the default', () => {
    const { srv } = server();
    expect((srv.apiFetch('GET', '/projects').body as unknown[]).length).toBe(1);

    const create = srv.apiFetch('POST', '/projects', { name: 'Rover' });
    expect(create.status).toBe(201);
    const proj = create.body as { '@id': string; '@type': string; name: string };
    expect(proj['@type']).toBe('Project');
    expect(proj.name).toBe('Rover');
    expect(proj['@id']).toMatch(/^project-/);

    const list = srv.apiFetch('GET', '/projects');
    expect((list.body as unknown[]).length).toBe(2);
    expect(srv.apiFetch('GET', `/projects/${proj['@id']}`).status).toBe(200);
  });

  it('preserves legacy behaviours: bodyless POST → 405, unknown → 404, bad method → 405', () => {
    const { srv } = server();
    expect(srv.apiFetch('POST', '/projects').status).toBe(405);
    expect(srv.apiFetch('GET', '/projects/nope').status).toBe(404);
    expect(srv.apiFetch('PUT', '/projects/project-default').status).toBe(405);
  });
});

describe('REST — branches', () => {
  it('lists, creates and reads branches', () => {
    const { srv } = server();
    const list = srv.apiFetch('GET', '/projects/project-default/branches');
    expect(list.status).toBe(200);
    const branches = list.body as Array<{ '@type': string; name: string }>;
    expect(branches).toHaveLength(1);
    expect(branches[0]['@type']).toBe('Branch');
    expect(branches[0].name).toBe('main');

    const created = srv.apiFetch('POST', '/projects/project-default/branches', { name: 'dev' });
    expect(created.status).toBe(201);
    const dev = created.body as { '@id': string; name: string; head: { '@id': string } };
    expect(dev.name).toBe('dev');
    expect(dev.head['@id']).toBe(headCommit(srv));

    expect(srv.apiFetch('GET', `/projects/project-default/branches/${dev['@id']}`).status).toBe(200);
    expect(srv.apiFetch('GET', '/projects/project-default/branches/nope').status).toBe(404);
    expect(srv.apiFetch('POST', '/projects/project-default/branches').status).toBe(405);
  });
});

describe('REST — tags', () => {
  it('lists, creates and reads tags; 404s a bad commit', () => {
    const { srv } = server();
    const cid = headCommit(srv);
    expect((srv.apiFetch('GET', '/projects/project-default/tags').body as unknown[]).length).toBe(0);

    const created = srv.apiFetch('POST', '/projects/project-default/tags', { name: 'v1', commit: cid });
    expect(created.status).toBe(201);
    const tag = created.body as { '@id': string; '@type': string; taggedCommit: { '@id': string } };
    expect(tag['@type']).toBe('Tag');
    expect(tag.taggedCommit['@id']).toBe(cid);

    expect((srv.apiFetch('GET', '/projects/project-default/tags').body as unknown[]).length).toBe(1);
    expect(srv.apiFetch('GET', `/projects/project-default/tags/${tag['@id']}`).status).toBe(200);
    expect(srv.apiFetch('GET', '/projects/project-default/tags/nope').status).toBe(404);
    expect(srv.apiFetch('POST', '/projects/project-default/tags').status).toBe(405);
    expect(srv.apiFetch('POST', '/projects/project-default/tags', { name: 'x', commit: 'nope' }).status).toBe(404);
  });
});

describe('REST — commits: history, writes and diff', () => {
  it('commits a change, grows history, links previousCommit and diffs', () => {
    const { srv, rootId } = server();
    const initial = headCommit(srv);
    const before = srv.apiFetch('GET', '/projects/project-default/commits');
    expect((before.body as unknown[]).length).toBe(1);

    const commitRes = srv.apiFetch('POST', '/projects/project-default/commits', {
      description: 'add wheel',
      changes: [
        {
          operation: 'create',
          element: { '@type': 'PartUsage', identifier: 'wheel-1', declaredName: 'wheel', ownerId: rootId },
        },
      ],
    });
    expect(commitRes.status).toBe(201);
    const commit = commitRes.body as { '@id': string; '@type': string; previousCommit: { '@id': string }; description: string };
    expect(commit['@type']).toBe('Commit');
    expect(commit.previousCommit['@id']).toBe(initial);
    expect(commit.description).toBe('add wheel');
    const newCid = commit['@id'];

    const after = srv.apiFetch('GET', '/projects/project-default/commits');
    expect((after.body as unknown[]).length).toBe(2);
    expect(srv.apiFetch('GET', `/projects/project-default/commits/${newCid}`).status).toBe(200);
    expect(srv.apiFetch('GET', '/projects/project-default/commits/nope').status).toBe(404);

    // The new commit's element collection contains the added element.
    const el = srv.apiFetch('GET', `/projects/project-default/commits/${newCid}/elements/wheel-1`);
    expect(el.status).toBe(200);
    const elBody = el.body as { '@id': string; '@type': string; declaredName: string };
    expect(elBody['@id']).toBe('wheel-1');
    expect(elBody['@type']).toBe('PartUsage');
    expect(elBody.declaredName).toBe('wheel');
    expect(srv.apiFetch('GET', `/projects/project-default/commits/${newCid}/elements/missing`).status).toBe(404);

    // diff(newCid vs base initial) reports the wheel as added.
    const diff = srv.apiFetch('GET', `/projects/project-default/commits/${newCid}/diff/${initial}`);
    expect(diff.status).toBe(200);
    const diffBody = diff.body as { added: Array<{ '@id': string }>; removed: unknown[]; changed: unknown[] };
    expect(diffBody.added.map((e) => e['@id'])).toContain('wheel-1');
    expect(diffBody.removed).toHaveLength(0);
    expect(diffBody.changed).toHaveLength(0);
  });

  it('lands a redefinition on the feature the saved text finds when a commit deletes its target', () => {
    // Q4's `M4 redefines Q::M` skips Q2's unnamed `:>> M`; s's `:>> M` redefines M4. Without M4 the text reads Q2's:
    // the commit's model satisfies s2 and saves `:>> M`, not the qualified `DA::Q::M` the walk up the chain would land.
    const text = `package DA {
  part def Q { attribute M default = 1.0; }
  part def Q2 :> Q { attribute :>> M default = 2.0; }
  part def Q4 :> Q2 { attribute M4 redefines Q::M default = 4.0; }
  part s : Q4 { attribute :>> M; }
  constraint s1 { s.M == 1.0 }
  constraint s2 { s.M == 2.0 }
  constraint s4 { s.M == 4.0 }
}`;
    const page = parseModel(text).model;
    const srv = new SysmlApiServer(page);
    const satisfied = (m: Model): string[] =>
      checkConstraints(m).filter((c) => c.result === 'satisfied').map((c) => m.qualifiedName(c.id)).sort();
    const m4 = page.all().find((e) => e.declaredName === 'M4')!;
    const res = srv.apiFetch('POST', '/projects/project-default/commits', { changes: [{ operation: 'delete', identifier: m4.id }] });
    expect(res.status).toBe(201);
    const committed = (res.body as { '@id': string })['@id'];
    const after = (srv as unknown as { repo: { getModelAtCommit(id: string): Model } }).repo.getModelAtCommit(committed);
    expect(satisfied(after)).toEqual(['DA::s2']);
    expect(serializeModel(after)).toMatch(/part s : Q4 \{\s*attribute :>> M;\s*\}/);
    // The commit is the text without M4, and the page's model is the REST commit's business no more than before.
    expect(satisfied(after)).toEqual(satisfied(parseModel(text.replace('attribute M4 redefines Q::M default = 4.0;', '')).model));
    expect(page.has(m4.id)).toBe(true);
  });

  it('reads roots at a commit', () => {
    const { srv, model } = server();
    const cid = headCommit(srv);
    const roots = srv.apiFetch('GET', `/projects/project-default/commits/${cid}/roots`);
    expect(roots.status).toBe(200);
    const body = roots.body as Array<{ '@id': string; '@type': string }>;
    expect(body).toHaveLength(1);
    expect(body[0]['@id']).toBe(model.roots()[0].id);
    expect(body[0]['@type']).toBe('Package');
  });
});

describe('REST — elements-at-commit pagination & query', () => {
  it('paginates by offset/limit and by cursor', () => {
    const { srv, model } = server();
    const cid = headCommit(srv);

    const off = srv.apiFetch('GET', `/projects/project-default/commits/${cid}/elements?offset=0&limit=3`);
    expect(off.status).toBe(200);
    const offBody = off.body as { elements: unknown[]; total: number; limit: number };
    expect(offBody.elements).toHaveLength(3);
    expect(offBody.total).toBe(model.size);
    expect(offBody.limit).toBe(3);

    const cur = srv.apiFetch('GET', `/projects/project-default/commits/${cid}/elements?size=5`);
    const curBody = cur.body as { elements: Array<{ '@id': string }>; nextCursor: string; size: number };
    expect(curBody.elements).toHaveLength(5);
    expect(curBody.size).toBe(5);
    expect(curBody.nextCursor).toBe(curBody.elements[4]['@id']);

    const cur2 = srv.apiFetch(
      'GET',
      `/projects/project-default/commits/${cid}/elements?size=5&after=${curBody.nextCursor}`,
    );
    const cur2Body = cur2.body as { elements: Array<{ '@id': string }> };
    expect(cur2Body.elements[0]['@id']).toBe(model.all()[5].id);
  });

  it('runs a Query at a commit via query-results', () => {
    const { srv } = server();
    const cid = headCommit(srv);
    const res = srv.apiFetch('POST', `/projects/project-default/commits/${cid}/query-results`, {
      constraint: { property: '@type', operator: '=', value: 'PartUsage' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { total: number; commitId: string };
    expect(body.total).toBe(2);
  });

  it('filters the element collection with a body constraint', () => {
    const { srv } = server();
    const cid = headCommit(srv);
    const res = srv.apiFetch('GET', `/projects/project-default/commits/${cid}/elements`, {
      constraint: { property: '@type', operator: '=', value: 'PortUsage' },
    });
    const body = res.body as { total: number; elements: Array<{ '@type': string }> };
    expect(body.total).toBe(2);
    expect(body.elements.every((e) => e['@type'] === 'PortUsage')).toBe(true);
  });
});
