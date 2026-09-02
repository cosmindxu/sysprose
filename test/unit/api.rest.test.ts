import { describe, it, expect } from 'vitest';
import { buildSampleModel } from '@core/index';
import { ModelApi, SysmlApiServer, type Query } from '@api/index';

function server() {
  const model = buildSampleModel();
  const vehicle = new ModelApi(model).byName('VehicleModel::vehicle')!.id;
  return { srv: new SysmlApiServer(model), model, vehicle };
}

describe('SysmlApiServer — projects', () => {
  it('lists and reads the single project', () => {
    const { srv } = server();
    const list = srv.apiFetch('GET', '/projects');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect((list.body as unknown[]).length).toBe(1);

    const one = srv.apiFetch('GET', '/projects/project-default');
    expect(one.status).toBe(200);
    const proj = one.body as { '@type': string; name: string };
    expect(proj['@type']).toBe('Project');
    expect(proj.name).toBe('VehicleModel');
  });

  it('404s for an unknown project and 405s for unsupported methods', () => {
    const { srv } = server();
    expect(srv.apiFetch('GET', '/projects/nope').status).toBe(404);
    expect(srv.apiFetch('POST', '/projects').status).toBe(405);
  });

  it('paginates the elements collection', () => {
    const { srv, model } = server();
    const res = srv.apiFetch('GET', '/projects/project-default/elements?offset=0&limit=3');
    expect(res.status).toBe(200);
    const body = res.body as { elements: unknown[]; total: number; limit: number };
    expect(body.elements).toHaveLength(3);
    expect(body.total).toBe(model.size);
    expect(body.limit).toBe(3);
  });
});

describe('SysmlApiServer — elements & analytics', () => {
  it('returns OMG element JSON for an element', () => {
    const { srv, vehicle } = server();
    const res = srv.apiFetch('GET', `/elements/${vehicle}`);
    expect(res.status).toBe(200);
    const body = res.body as { '@id': string; '@type': string };
    expect(body['@id']).toBe(vehicle);
    expect(body['@type']).toBe('PartUsage');
    expect(srv.apiFetch('GET', '/elements/missing').status).toBe(404);
  });

  it('serves analytics metrics', () => {
    const { srv, model } = server();
    const res = srv.apiFetch('GET', '/analytics/metrics');
    expect(res.status).toBe(200);
    expect((res.body as { totalElements: number }).totalElements).toBe(model.size);
  });
});

describe('SysmlApiServer — queries', () => {
  it('evaluates a posted query and returns a QueryResult', () => {
    const { srv } = server();
    const query: Query = { constraint: { property: '@type', operator: '=', value: 'PartUsage' } };
    const res = srv.apiFetch('POST', '/queries', query);
    expect(res.status).toBe(200);
    const body = res.body as { total: number; elements: unknown[]; commitId: string };
    expect(body.total).toBe(2);
    expect(body.elements).toHaveLength(2);
    expect(body.commitId).toMatch(/^commit-/);
  });

  it('404s an unknown route', () => {
    const { srv } = server();
    expect(srv.apiFetch('GET', '/totally/unknown').status).toBe(404);
  });
});
