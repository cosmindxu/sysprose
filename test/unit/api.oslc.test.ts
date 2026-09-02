import { describe, it, expect } from 'vitest';
import { buildSampleModel } from '@core/index';
import { ModelApi } from '@api/index';
import { OslcServer, parseOslcWhere, oslcPropertyToPath } from '@api/oslc';

function server() {
  const model = buildSampleModel();
  const api = new ModelApi(model);
  return { srv: new OslcServer(model), model, vehicle: api.byName('VehicleModel::vehicle')!.id };
}

describe('OSLC — discovery documents', () => {
  it('serves a ServiceProviderCatalog with a @context and a provider link', () => {
    const { srv } = server();
    const res = srv.oslcFetch('GET', '/oslc/catalog');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body['@type']).toBe('oslc:ServiceProviderCatalog');
    expect(body['@context'].oslc).toMatch(/open-services/);
    expect(body['@context'].dcterms).toMatch(/purl.org\/dc\/terms/);
    expect(body['oslc:serviceProvider'][0]['@id']).toBe('/oslc/services');
  });

  it('serves a ServiceProvider advertising a query capability and creation factory', () => {
    const { srv } = server();
    const res = srv.oslcFetch('GET', '/oslc/services');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body['@type']).toBe('oslc:ServiceProvider');
    const service = body['oslc:service'][0];
    expect(service['oslc:queryCapability'][0]['oslc:queryBase']['@id']).toBe('/oslc/query');
    expect(service['oslc:creationFactory'][0]['@type']).toBe('oslc:CreationFactory');
  });

  it('rejects non-GET methods and unknown routes', () => {
    const { srv } = server();
    expect(srv.oslcFetch('POST', '/oslc/catalog').status).toBe(405);
    expect(srv.oslcFetch('GET', '/oslc/nope').status).toBe(404);
  });
});

describe('OSLC — JSON-LD element representation', () => {
  it('returns rdf:type, dcterms identifier/title and ownedRelationship links', () => {
    const { srv, vehicle } = server();
    const res = srv.oslcFetch('GET', `/oslc/elements/${vehicle}`);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body['@id']).toBe(`/oslc/elements/${vehicle}`);
    expect(body['rdf:type']['@id']).toMatch(/PartUsage$/);
    expect(body['dcterms:identifier']).toBe(vehicle);
    expect(body['dcterms:title']).toBe('vehicle');
    expect(Array.isArray(body['sysml:ownedRelationship'])).toBe(true);
    // Every owned link is itself an /oslc/elements/ resource reference.
    expect(body['sysml:ownedRelationship'].every((r: any) => r['@id'].startsWith('/oslc/elements/'))).toBe(true);
    expect(body['@context'].rdf).toMatch(/22-rdf-syntax-ns/);
  });

  it('404s an unknown element', () => {
    const { srv } = server();
    expect(srv.oslcFetch('GET', '/oslc/elements/missing').status).toBe(404);
  });
});

describe('OSLC — query capability', () => {
  it('parses oslc.where into a Query and returns matching members', () => {
    const { srv } = server();
    const res = srv.oslcFetch('GET', '/oslc/query?oslc.where=rdf:type="PartUsage"');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body['@type']).toBe('oslc:ResponseInfo');
    expect(body['oslc:totalCount']).toBe(2);
    expect(body['rdfs:member']).toHaveLength(2);
    expect(body['rdfs:member'][0]['rdf:type']['@id']).toMatch(/PartUsage$/);
  });

  it('supports a conjunction and oslc.select projection', () => {
    const { srv } = server();
    const res = srv.oslcFetch(
      'GET',
      '/oslc/query?oslc.where=rdf:type="PortUsage" and direction="out"&oslc.select=dcterms:title',
    );
    const body = res.body as Record<string, any>;
    expect(body['oslc:totalCount']).toBe(1);
    const member = body['rdfs:member'][0];
    expect(member['dcterms:title']).toBe('fuelOut');
    // Projection keeps @id + selected JSON-LD keys only.
    expect(Object.keys(member).sort()).toEqual(['@id', 'dcterms:title']);
  });

  it('returns all elements when oslc.where is absent', () => {
    const { srv, model } = server();
    const res = srv.oslcFetch('GET', '/oslc/query');
    const body = res.body as Record<string, any>;
    expect(body['oslc:totalCount']).toBe(model.size);
  });
});

describe('OSLC — where parser mapping', () => {
  it('maps prefixed terms to internal property paths', () => {
    expect(oslcPropertyToPath('dcterms:title')).toBe('name');
    expect(oslcPropertyToPath('dcterms:identifier')).toBe('@id');
    expect(oslcPropertyToPath('rdf:type')).toBe('@type');
    expect(oslcPropertyToPath('sysml:direction')).toBe('direction');
  });

  it('builds a composite constraint for multi-term where clauses', () => {
    const c = parseOslcWhere('rdf:type="PortUsage" and direction="in"') as any;
    expect(c.operator).toBe('and');
    expect(c.constraint).toHaveLength(2);
    expect(c.constraint[0]).toEqual({ property: '@type', operator: '=', value: 'PortUsage' });
    // Single-term clauses collapse to a bare primitive.
    const single = parseOslcWhere('name="Engine"') as any;
    expect(single).toEqual({ property: 'name', operator: '=', value: 'Engine' });
  });
});
