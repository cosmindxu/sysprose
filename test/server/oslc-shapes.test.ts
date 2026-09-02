// @vitest-environment node
/**
 * Full-shape OSLC surface tests for the linked-data facade (`src/api/oslc.ts` +
 * `src/server`). Runs under Node (express + http) on an ephemeral port.
 *
 * Beyond the Core discovery/query already covered by
 * `test/conformance/oslc-conformance.test.ts`, this asserts the richer OSLC
 * constructs (clean-room per docs/02-omg-standard-reference.md / OSLC Core 3.0):
 *
 *   - the `oslc:ServiceProvider` advertises `oslc:resourceShape`,
 *     `oslc:creationDialog`, `oslc:selectionDialog` and `oslc:queryCapability`;
 *   - `oslc:ResourceShape` resources at `/oslc/shapes/:type` carry `oslc:Property`
 *     entries with `oslc:propertyDefinition` / `oslc:valueType` / `oslc:occurs`,
 *     negotiable as Turtle + JSON-LD;
 *   - delegated `oslc:Dialog`s at `/oslc/dialogs/*` carry `oslc:dialog` +
 *     `oslc:hintWidth` + `oslc:label`;
 *   - an `oslc:Compact` preview (`?compact` or a compact `Accept`) carries
 *     `dcterms:title` + `oslc:shortTitle` + `oslc:icon`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from '../../src/server/app';

let server: Server;
let base: string;
let elementId: string;

async function getJsonLd(path: string, accept = 'application/ld+json'): Promise<{ status: number; ct: string; body: any }> {
  const res = await fetch(`${base}${path}`, { headers: { Accept: accept } });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, ct, body: await res.json() };
}

async function getText(path: string, accept: string): Promise<{ status: number; ct: string; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { Accept: accept } });
  return { status: res.status, ct: res.headers.get('content-type') ?? '', text: await res.text() };
}

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

describe('OSLC full-shape: ServiceProvider advertises shapes + dialogs', () => {
  it('advertises resourceShape, creation/selection dialogs and a queryCapability', async () => {
    const { status, body } = await getJsonLd('/oslc/services');
    expect(status).toBe(200);
    expect(body['@type']).toBe('oslc:ServiceProvider');

    // Resource shapes advertised at the provider level.
    const shapes = asArray(body['oslc:resourceShape']);
    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes.map((s: any) => s['@id'])).toContain('/oslc/shapes/Element');

    const services = asArray(body['oslc:service']);
    expect(services.length).toBeGreaterThan(0);

    // Query capability references a resource shape.
    const queryCaps = services.flatMap((s: any) => asArray(s['oslc:queryCapability']));
    expect(queryCaps.length).toBeGreaterThan(0);
    expect(queryCaps[0]['oslc:resourceShape']['@id']).toBe('/oslc/shapes/Element');

    // Delegated creation + selection dialogs.
    const creation = services.flatMap((s: any) => asArray(s['oslc:creationDialog']));
    const selection = services.flatMap((s: any) => asArray(s['oslc:selectionDialog']));
    expect(creation.length).toBeGreaterThan(0);
    expect(selection.length).toBeGreaterThan(0);
    expect(creation[0]['@type']).toBe('oslc:Dialog');
    expect(selection[0]['@type']).toBe('oslc:Dialog');
  });
});

describe('OSLC full-shape: ResourceShape resources', () => {
  it('GET /oslc/shapes/Element is an oslc:ResourceShape with typed properties (JSON-LD)', async () => {
    const { status, ct, body } = await getJsonLd('/oslc/shapes/Element');
    expect(status).toBe(200);
    expect(ct).toContain('application/ld+json');
    expect(body['@type']).toBe('oslc:ResourceShape');
    expect(body['oslc:describes']['@id']).toContain('SysML#Element');

    const props = asArray(body['oslc:property']);
    expect(props.length).toBeGreaterThan(2);
    expect(props[0]['@type']).toBe('oslc:Property');
    // Every property carries propertyDefinition + valueType + occurs cardinality.
    for (const p of props) {
      expect(typeof p['oslc:name']).toBe('string');
      expect(p['oslc:propertyDefinition']['@id']).toBeTruthy();
      expect(p['oslc:valueType']['@id']).toBeTruthy();
      expect(p['oslc:occurs']['@id']).toMatch(/oslc:(Exactly-one|Zero-or-one|Zero-or-many|One-or-many)/);
    }
    // The identifier property is required (Exactly-one).
    const idProp = props.find((p: any) => p['oslc:name'] === 'identifier');
    expect(idProp['oslc:occurs']['@id']).toBe('oslc:Exactly-one');
  });

  it('GET /oslc/shapes/Project is a distinct ResourceShape', async () => {
    const { status, body } = await getJsonLd('/oslc/shapes/Project');
    expect(status).toBe(200);
    expect(body['@type']).toBe('oslc:ResourceShape');
    expect(body['oslc:describes']['@id']).toContain('SysML#Project');
    expect(asArray(body['oslc:property']).length).toBeGreaterThan(0);
  });

  it('negotiates the Element shape as Turtle (with oslc:property/propertyDefinition)', async () => {
    const { status, ct, text } = await getText('/oslc/shapes/Element', 'text/turtle');
    expect(status).toBe(200);
    expect(ct).toContain('text/turtle');
    expect(text).toContain('@prefix oslc:');
    expect(text).toContain('oslc:ResourceShape');
    expect(text).toContain('oslc:propertyDefinition');
    expect(text).toContain('oslc:occurs');
  });

  it('negotiates the Element shape as RDF/XML', async () => {
    const { status, ct, text } = await getText('/oslc/shapes/Element', 'application/rdf+xml');
    expect(status).toBe(200);
    expect(ct).toContain('application/rdf+xml');
    expect(text).toContain('<rdf:RDF');
    expect(text).toContain('oslc:propertyDefinition');
  });

  it('404s an unknown shape type', async () => {
    const res = await fetch(`${base}/oslc/shapes/Nope`, { headers: { Accept: 'application/ld+json' } });
    expect(res.status).toBe(404);
  });
});

describe('OSLC full-shape: delegated dialogs', () => {
  it('GET /oslc/dialogs/creation is an oslc:Dialog with dialog/hintWidth/label', async () => {
    const { status, body } = await getJsonLd('/oslc/dialogs/creation');
    expect(status).toBe(200);
    expect(body['@type']).toBe('oslc:Dialog');
    expect(body['oslc:dialog']['@id']).toBeTruthy();
    expect(typeof body['oslc:hintWidth']).toBe('string');
    expect(typeof body['oslc:label']).toBe('string');
    expect(asArray(body['oslc:resourceType']).length).toBeGreaterThan(0);
  });

  it('GET /oslc/dialogs/selection is a distinct oslc:Dialog, negotiable as Turtle', async () => {
    const { status, body } = await getJsonLd('/oslc/dialogs/selection');
    expect(status).toBe(200);
    expect(body['@type']).toBe('oslc:Dialog');
    expect(body['oslc:hintHeight']).toBeTruthy();

    const ttl = await getText('/oslc/dialogs/selection', 'text/turtle');
    expect(ttl.status).toBe(200);
    expect(ttl.ct).toContain('text/turtle');
    expect(ttl.text).toContain('oslc:Dialog');
    expect(ttl.text).toContain('oslc:hintWidth');
  });
});

describe('OSLC full-shape: Compact preview', () => {
  it('GET /oslc/elements/:id?compact is an oslc:Compact with title/shortTitle/icon', async () => {
    const { status, body } = await getJsonLd(`/oslc/elements/${elementId}?compact`);
    expect(status).toBe(200);
    expect(body['@type']).toBe('oslc:Compact');
    expect(body['dcterms:title']).toBeTruthy();
    expect(body['oslc:shortTitle']).toBeTruthy();
    expect(body['oslc:icon']['@id']).toBeTruthy();
    // The small preview points back at the full resource.
    expect(body['oslc:smallPreview']['oslc:document']['@id']).toContain(elementId);
  });

  it('an OSLC compact Accept header also yields the oslc:Compact document', async () => {
    const { status, body } = await getJsonLd(
      `/oslc/elements/${elementId}`,
      'application/x-oslc-compact+xml',
    );
    expect(status).toBe(200);
    expect(body['@type']).toBe('oslc:Compact');
    expect(body['oslc:shortTitle']).toBeTruthy();
  });

  it('without ?compact the element is the full resource (not a Compact)', async () => {
    const { status, body } = await getJsonLd(`/oslc/elements/${elementId}`);
    expect(status).toBe(200);
    expect(body['@type']).not.toBe('oslc:Compact');
    expect(body['dcterms:identifier']).toBe(elementId);
  });
});
