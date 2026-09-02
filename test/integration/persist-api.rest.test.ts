/**
 * Integration: the OMG REST facade (SysmlApiServer.apiFetch).
 *
 * Covers task §2 — GET /projects, GET /projects/:id/elements (with pagination),
 * GET /elements/:id (OMG JSON shape), POST /queries (Query → QueryResult),
 * GET /analytics/metrics. Asserts status codes and body shapes, and confirms
 * that a query routed through the facade yields exactly the same elements as
 * evaluateQuery invoked directly against the model.
 */

import { describe, it, expect } from 'vitest';
import { buildSampleModel } from '@core/index';
import {
  ModelApi,
  SysmlApiServer,
  evaluateQuery,
  modelMetrics,
  type Query,
} from '@api/index';

function fixture() {
  const model = buildSampleModel();
  const api = new ModelApi(model);
  const srv = new SysmlApiServer(model);
  return {
    srv,
    model,
    vehicle: api.byName('VehicleModel::vehicle')!.id,
    req: api.byName('VehicleModel::maxMass')!.id,
  };
}

describe('REST facade — /projects', () => {
  it('GET /projects → 200 with a single Project resource', () => {
    const { srv } = fixture();
    const res = srv.apiFetch('GET', '/projects');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const list = res.body as Array<{ '@type': string; name: string; defaultCommit: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]['@type']).toBe('Project');
    expect(list[0].name).toBe('VehicleModel');
    expect(list[0].defaultCommit).toMatch(/^commit-/);
  });

  it('GET /projects/:id → 200 for the default project, 404 otherwise', () => {
    const { srv } = fixture();
    const ok = srv.apiFetch('GET', '/projects/project-default');
    expect(ok.status).toBe(200);
    expect((ok.body as { '@id': string })['@id']).toBe('project-default');
    const missing = srv.apiFetch('GET', '/projects/no-such-project');
    expect(missing.status).toBe(404);
    expect((missing.body as { error: string }).error).toMatch(/no such project/i);
  });

  it('rejects unsupported methods with 405', () => {
    const { srv } = fixture();
    expect(srv.apiFetch('POST', '/projects').status).toBe(405);
    // PATCH is not part of the project resource contract (GET/PUT/DELETE are).
    expect(srv.apiFetch('PATCH', '/projects/project-default').status).toBe(405);
  });
});

describe('REST facade — /projects/:id/elements (pagination)', () => {
  it('returns the full element collection with metadata', () => {
    const { srv, model } = fixture();
    const res = srv.apiFetch('GET', '/projects/project-default/elements');
    expect(res.status).toBe(200);
    const body = res.body as {
      total: number;
      offset: number;
      limit: number | null;
      commitId: string;
      elements: Array<{ '@id': string; '@type': string }>;
    };
    expect(body.total).toBe(model.size);
    expect(body.elements).toHaveLength(model.size);
    expect(body.offset).toBe(0);
    expect(body.limit).toBeNull();
    expect(body.commitId).toMatch(/^commit-/);
    // Every returned element is in OMG JSON shape.
    for (const e of body.elements) {
      expect(typeof e['@id']).toBe('string');
      expect(typeof e['@type']).toBe('string');
    }
  });

  it('honours offset + limit and is a stable window over the collection', () => {
    const { srv, model } = fixture();
    const page1 = srv.apiFetch('GET', '/projects/project-default/elements?offset=0&limit=3');
    const page2 = srv.apiFetch('GET', '/projects/project-default/elements?offset=3&limit=3');
    const b1 = page1.body as { elements: Array<{ '@id': string }>; total: number; limit: number };
    const b2 = page2.body as { elements: Array<{ '@id': string }>; total: number };
    expect(b1.elements).toHaveLength(3);
    expect(b1.limit).toBe(3);
    expect(b1.total).toBe(model.size);
    expect(b2.elements).toHaveLength(3);
    // Pages are disjoint.
    const ids1 = new Set(b1.elements.map((e) => e['@id']));
    expect(b2.elements.some((e) => ids1.has(e['@id']))).toBe(false);

    // Concatenating windows reproduces the unpaginated order.
    const full = (
      srv.apiFetch('GET', '/projects/project-default/elements').body as {
        elements: Array<{ '@id': string }>;
      }
    ).elements.map((e) => e['@id']);
    expect([...b1.elements, ...b2.elements].map((e) => e['@id'])).toEqual(full.slice(0, 6));
  });
});

describe('REST facade — /elements/:id', () => {
  it('GET /elements/:id → 200 with the OMG element JSON shape', () => {
    const { srv, vehicle } = fixture();
    const res = srv.apiFetch('GET', `/elements/${vehicle}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      '@id': string;
      '@type': string;
      identifier: string;
      declaredName: string;
      ownedRelationship: unknown[];
      ownedMember: unknown[];
      owner?: { '@id': string };
    };
    expect(body['@id']).toBe(vehicle);
    expect(body['@type']).toBe('PartUsage');
    expect(body.identifier).toBe(vehicle);
    expect(body.declaredName).toBe('vehicle');
    expect(Array.isArray(body.ownedRelationship)).toBe(true);
    expect(Array.isArray(body.ownedMember)).toBe(true);
    expect(body.owner).toBeTruthy();
  });

  it('GET /elements/:id → 404 for an unknown id', () => {
    const { srv } = fixture();
    const res = srv.apiFetch('GET', '/elements/does-not-exist');
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/no such element/i);
  });
});

describe('REST facade — POST /queries', () => {
  it('evaluates a posted Query and returns a QueryResult', () => {
    const { srv } = fixture();
    const query: Query = { constraint: { property: '@type', operator: '=', value: 'PartUsage' } };
    const res = srv.apiFetch('POST', '/queries', query);
    expect(res.status).toBe(200);
    const body = res.body as { total: number; elements: unknown[]; commitId: string };
    expect(body.total).toBe(2);
    expect(body.elements).toHaveLength(2);
    expect(body.commitId).toMatch(/^commit-/);
  });

  it('matches evaluateQuery invoked directly (facade is a thin wrapper)', () => {
    const { srv, model } = fixture();
    const queries: Query[] = [
      { constraint: { property: '@type', operator: '=', value: 'PartUsage' } },
      {
        constraint: {
          kind: 'or',
          operands: [
            { property: '@type', operator: '=', value: 'PartDefinition' },
            { property: 'name', operator: '=', value: 'mass' },
          ],
        },
      },
      { constraint: { property: 'name', operator: 'exists', value: true }, page: { offset: 1, limit: 4 } },
    ];
    for (const q of queries) {
      const direct = evaluateQuery(model, q);
      const viaRest = srv.apiFetch('POST', '/queries', q).body as typeof direct;
      expect(viaRest.total).toBe(direct.total);
      expect(viaRest.elements.map((e) => (e as { id: string }).id)).toEqual(
        direct.elements.map((e) => e.id),
      );
    }
  });

  it('rejects GET on /queries with 405', () => {
    const { srv } = fixture();
    expect(srv.apiFetch('GET', '/queries').status).toBe(405);
  });
});

describe('REST facade — /analytics/metrics & unknown routes', () => {
  it('GET /analytics/metrics → 200 matching modelMetrics()', () => {
    const { srv, model } = fixture();
    const res = srv.apiFetch('GET', '/analytics/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(modelMetrics(model));
    const body = res.body as { totalElements: number; nodeCount: number; relationshipCount: number };
    expect(body.totalElements).toBe(model.size);
    expect(body.nodeCount + body.relationshipCount).toBe(model.size);
  });

  it('404s an unknown route', () => {
    const { srv } = fixture();
    expect(srv.apiFetch('GET', '/totally/unknown/route').status).toBe(404);
  });
});
