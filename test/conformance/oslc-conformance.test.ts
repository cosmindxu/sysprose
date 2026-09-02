// @vitest-environment node
/**
 * OSLC Core structural conformance for the linked-data surface (`src/server`).
 *
 * Runs under Node (express + http), starts the app on an ephemeral port, and
 * asserts the OSLC Core 3.0 discovery + query + resource structure the modeler
 * exposes (clean-room per docs/02-omg-standard-reference.md / OSLC Core):
 *
 *   - `/oslc/catalog`  is an `oslc:ServiceProviderCatalog` carrying at least one
 *     `oslc:serviceProvider`.
 *   - `/oslc/services` is an `oslc:ServiceProvider` whose `oslc:service` exposes
 *     an `oslc:queryCapability` with an `oslc:queryBase`.
 *   - an element resource carries `@context`, `rdf:type` and `dcterms:identifier`.
 *   - `/oslc/query` is an `oslc:ResponseInfo` with `rdfs:member` entries.
 *   - content negotiation yields valid Turtle (`@prefix`), RDF/XML (`<rdf:RDF`)
 *     and JSON-LD (default), each with the correct `Content-Type`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from '../../src/server/app';

let server: Server;
let base: string;
let elementId: string;

async function getJsonLd(path: string): Promise<{ status: number; ct: string; body: any }> {
  const res = await fetch(`${base}${path}`, { headers: { Accept: 'application/ld+json' } });
  return { status: res.status, ct: res.headers.get('content-type') ?? '', body: await res.json() };
}

async function getText(path: string, accept: string): Promise<{ status: number; ct: string; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { Accept: accept } });
  return { status: res.status, ct: res.headers.get('content-type') ?? '', text: await res.text() };
}

/** Normalise `oslc:x` values that may be a single object or an array. */
function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

beforeAll(async () => {
  const app = createServer(); // seeded demo project
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  // Discover a real element id from the seeded HEAD to exercise a resource.
  const proj = await (await fetch(`${base}/api/projects/project-default`)).json();
  const cid = proj.defaultCommit as string;
  const page = await (
    await fetch(`${base}/api/projects/project-default/commits/${cid}/elements?limit=1`)
  ).json();
  elementId = page.elements[0]['@id'];
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe('OSLC Core: ServiceProviderCatalog', () => {
  it('/oslc/catalog is an oslc:ServiceProviderCatalog with serviceProvider(s)', async () => {
    const { status, body } = await getJsonLd('/oslc/catalog');
    expect(status).toBe(200);
    expect(body['@type']).toBe('oslc:ServiceProviderCatalog');
    expect(body['@context']).toBeTruthy();
    expect(body['@context'].oslc).toBe('http://open-services.net/ns/core#');

    const providers = asArray(body['oslc:serviceProvider']);
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0]['@type']).toBe('oslc:ServiceProvider');
    expect(typeof providers[0]['@id']).toBe('string');
  });
});

describe('OSLC Core: ServiceProvider', () => {
  it('/oslc/services is an oslc:ServiceProvider exposing a queryCapability', async () => {
    const { status, body } = await getJsonLd('/oslc/services');
    expect(status).toBe(200);
    expect(body['@type']).toBe('oslc:ServiceProvider');
    expect(body['@context']).toBeTruthy();

    const services = asArray(body['oslc:service']);
    expect(services.length).toBeGreaterThan(0);
    expect(services[0]['@type']).toBe('oslc:Service');

    const queryCaps = services.flatMap((s: any) => asArray(s['oslc:queryCapability']));
    expect(queryCaps.length).toBeGreaterThan(0);
    expect(queryCaps[0]['@type']).toBe('oslc:QueryCapability');
    expect(queryCaps[0]['oslc:queryBase']['@id']).toBeTruthy();
  });
});

describe('OSLC Core: element resource', () => {
  it('an element resource has @context + rdf:type + dcterms:identifier', async () => {
    const { status, ct, body } = await getJsonLd(`/oslc/elements/${elementId}`);
    expect(status).toBe(200);
    expect(ct).toContain('application/ld+json');
    expect(body['@context']).toBeTruthy();
    expect(body['@context'].sysml).toContain('omg.org');
    expect(body['@id']).toContain(elementId);
    expect(body['rdf:type']).toBeTruthy();
    expect(body['rdf:type']['@id']).toContain('SysML#');
    expect(body['dcterms:identifier']).toBe(elementId);
  });
});

describe('OSLC Core: query capability', () => {
  it('/oslc/query is an oslc:ResponseInfo with rdfs:member entries', async () => {
    const { status, body } = await getJsonLd('/oslc/query');
    expect(status).toBe(200);
    expect(body['@type']).toBe('oslc:ResponseInfo');
    expect(typeof body['oslc:totalCount']).toBe('number');
    const members = asArray(body['rdfs:member']);
    expect(members.length).toBeGreaterThan(0);
    expect(members[0]['@id']).toBeTruthy();
  });
});

describe('OSLC Core: RDF content negotiation', () => {
  it('negotiates Turtle (has @prefix) for the catalog', async () => {
    const { status, ct, text } = await getText('/oslc/catalog', 'text/turtle');
    expect(status).toBe(200);
    expect(ct).toContain('text/turtle');
    expect(text).toContain('@prefix');
    expect(text).toContain('oslc:');
  });

  it('negotiates RDF/XML (has <rdf:RDF) for the catalog', async () => {
    const { status, ct, text } = await getText('/oslc/catalog', 'application/rdf+xml');
    expect(status).toBe(200);
    expect(ct).toContain('application/rdf+xml');
    expect(text).toContain('<rdf:RDF');
  });

  it('negotiates JSON-LD (default) for the catalog', async () => {
    const { status, ct, body } = await getJsonLd('/oslc/catalog');
    expect(status).toBe(200);
    expect(ct).toContain('application/ld+json');
    expect(body['@context']).toBeTruthy();
  });

  it('serves an element resource as Turtle and RDF/XML too', async () => {
    const ttl = await getText(`/oslc/elements/${elementId}`, 'text/turtle');
    expect(ttl.status).toBe(200);
    expect(ttl.ct).toContain('text/turtle');
    expect(ttl.text).toContain('@prefix');

    const rdfxml = await getText(`/oslc/elements/${elementId}`, 'application/rdf+xml');
    expect(rdfxml.status).toBe(200);
    expect(rdfxml.ct).toContain('application/rdf+xml');
    expect(rdfxml.text).toContain('<rdf:RDF');
  });
});
