// @vitest-environment node
/**
 * RDF content-negotiation tests for the OSLC linked-data surface (`src/server`).
 *
 * Runs under Node (express + http), starts the app on an ephemeral port, and
 * asserts that OSLC resources — ServiceProviderCatalog, ServiceProvider, query
 * ResponseInfo and element resources — serialize as Turtle (`text/turtle`),
 * RDF/XML (`application/rdf+xml`) and JSON-LD (`application/ld+json`, default),
 * negotiated via the `Accept` header and the `?format=` override, with correct
 * prefixes (oslc, rdf, rdfs, dcterms, sysml).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from '../../src/server/app';

let server: Server;
let base: string;

async function get(path: string, accept?: string): Promise<{ status: number; ct: string; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: accept ? { Accept: accept } : undefined });
  return { status: res.status, ct: res.headers.get('content-type') ?? '', text: await res.text() };
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

describe('OSLC RDF content negotiation: ServiceProvider(-Catalog)', () => {
  it('negotiates Turtle for the catalog (@prefix + oslc: + a-triples)', async () => {
    const { status, ct, text } = await get('/oslc/catalog', 'text/turtle');
    expect(status).toBe(200);
    expect(ct).toMatch(/text\/turtle/);
    expect(text).toContain('@prefix oslc:');
    expect(text).toContain('@prefix dcterms:');
    expect(text).toContain('oslc:');
    // rdf:type is emitted with the Turtle `a` keyword.
    expect(text).toMatch(/\ba\s+oslc:ServiceProviderCatalog\b/);
  });

  it('negotiates RDF/XML for the ServiceProvider (<rdf:RDF + namespaces)', async () => {
    const { status, ct, text } = await get('/oslc/services', 'application/rdf+xml');
    expect(status).toBe(200);
    expect(ct).toMatch(/application\/rdf\+xml/);
    expect(text).toContain('<rdf:RDF');
    expect(text).toContain('xmlns:oslc=');
    expect(text).toContain('xmlns:sysml=');
    expect(text).toContain('rdf:type');
  });

  it('defaults to JSON-LD for the ServiceProvider (application/ld+json)', async () => {
    const { status, ct, text } = await get('/oslc/services', 'application/ld+json');
    expect(status).toBe(200);
    expect(ct).toMatch(/application\/ld\+json/);
    const json = JSON.parse(text);
    expect(json['@type']).toBe('oslc:ServiceProvider');
    expect(json['@context']).toBeTruthy();
  });

  it('defaults to JSON-LD when no Accept is given', async () => {
    const { status, ct, text } = await get('/oslc/catalog');
    expect(status).toBe(200);
    expect(ct).toMatch(/json/);
    expect(JSON.parse(text)['@type']).toBe('oslc:ServiceProviderCatalog');
  });
});

describe('OSLC RDF content negotiation: query results', () => {
  it('serializes the ResponseInfo as Turtle with members', async () => {
    const { status, text } = await get('/oslc/query', 'text/turtle');
    expect(status).toBe(200);
    expect(text).toContain('@prefix rdfs:');
    expect(text).toMatch(/\ba\s+oslc:ResponseInfo\b/);
    expect(text).toContain('rdfs:member');
  });

  it('serializes the ResponseInfo as RDF/XML', async () => {
    const { status, text } = await get('/oslc/query', 'application/rdf+xml');
    expect(status).toBe(200);
    expect(text).toContain('<rdf:RDF');
    expect(text).toContain('oslc:totalCount');
  });
});

describe('OSLC RDF content negotiation: element resources (all three)', () => {
  async function firstElementId(): Promise<string> {
    const { text } = await get('/oslc/query', 'application/ld+json');
    const members = JSON.parse(text)['rdfs:member'] as Array<{ '@id': string }>;
    expect(members.length).toBeGreaterThan(0);
    return members[0]['@id'].replace('/oslc/elements/', '');
  }

  it('negotiates Turtle, RDF/XML and JSON-LD for one element', async () => {
    const id = await firstElementId();

    const ttl = await get(`/oslc/elements/${id}`, 'text/turtle');
    expect(ttl.status).toBe(200);
    expect(ttl.ct).toMatch(/text\/turtle/);
    expect(ttl.text).toContain('@prefix sysml:');
    expect(ttl.text).toContain('dcterms:identifier');
    // element type compresses to the sysml: prefix via rdf:type / `a`.
    expect(ttl.text).toMatch(/\ba\s+sysml:/);

    const xml = await get(`/oslc/elements/${id}`, 'application/rdf+xml');
    expect(xml.status).toBe(200);
    expect(xml.ct).toMatch(/application\/rdf\+xml/);
    expect(xml.text).toContain('<rdf:RDF');
    expect(xml.text).toContain('dcterms:identifier');

    const jsonld = await get(`/oslc/elements/${id}`, 'application/ld+json');
    expect(jsonld.status).toBe(200);
    expect(jsonld.ct).toMatch(/application\/ld\+json/);
    const doc = JSON.parse(jsonld.text);
    expect(doc['dcterms:identifier']).toBe(id);
    expect(doc['rdf:type']).toBeTruthy();
  });

  it('honours the ?format= override regardless of Accept', async () => {
    const id = await firstElementId();
    // Accept says JSON-LD, but ?format=turtle must win.
    const forced = await get(`/oslc/elements/${id}?format=turtle`, 'application/ld+json');
    expect(forced.ct).toMatch(/text\/turtle/);
    expect(forced.text).toContain('@prefix');

    const forcedXml = await get(`/oslc/elements/${id}?format=rdfxml`, 'application/ld+json');
    expect(forcedXml.ct).toMatch(/application\/rdf\+xml/);
    expect(forcedXml.text).toContain('<rdf:RDF');
  });
});

describe('OSLC RDF parse-back triples (finding M16)', () => {
  it('JSON-LD element carries identifier, type, and sysml prefix triples', async () => {
    const { text } = await get('/oslc/query', 'application/ld+json');
    const doc = JSON.parse(text) as Record<string, unknown>;
    expect(String(doc['@type'] ?? '')).toMatch(/ResponseInfo/);
    const members = doc['rdfs:member'] as Array<Record<string, unknown>>;
    const el = members[0];
    const elId = String(el['dcterms:identifier'] ?? '');
    expect(elId.length).toBeGreaterThan(0);
    expect(el['rdf:type']).toBeTruthy();
    // rdf:type is an { @id } reference; the @id value should reference a sysml metaclass.
    const typeRef = (el['rdf:type'] as { '@id'?: string })['@id'] ?? '';
    expect(typeRef).toMatch(/SysML#\w+/);
  });

  it('Turtle element carries explicit sysml type and identifier triple', async () => {
    const { text: membersText } = await get('/oslc/query', 'application/ld+json');
    const members = (JSON.parse(membersText)['rdfs:member'] as Array<{ '@id': string }>);
    const id = members[0]['@id'].replace('/oslc/elements/', '');
    const { text, status, ct } = await get(`/oslc/elements/${id}`, 'text/turtle');
    expect(status).toBe(200);
    expect(ct).toMatch(/text\/turtle/);
    // Turtle `a sysml:X` triple for the rdf:type.
    expect(text).toMatch(/\ba\s+sysml:\w+/);
    // Turtle `dcterms:identifier "id"` triple.
    expect(text).toContain('dcterms:identifier');
    expect(text).toContain(id);
  });

  it('RDF/XML element carries identifier and type in rdf:Description attributes', async () => {
    const { text: membersText } = await get('/oslc/query', 'application/ld+json');
    const members = (JSON.parse(membersText)['rdfs:member'] as Array<{ '@id': string }>);
    const id = members[0]['@id'].replace('/oslc/elements/', '');
    const { text, status, ct } = await get(`/oslc/elements/${id}`, 'application/rdf+xml');
    expect(status).toBe(200);
    expect(ct).toMatch(/application\/rdf\+xml/);
    // rdf:Description with rdf:about identifying the resource
    expect(text).toContain('<rdf:Description');
    expect(text).toContain(id);
    // rdf:type as an attribute or child element
    expect(text).toContain('rdf:type');
    // dcterms:identifier present
    expect(text).toContain('dcterms:identifier');
  });
});
