/**
 * Dependency-free RDF serializers for the OSLC linked-data surface.
 *
 * The {@link OslcServer} facade emits JSON-LD-shaped plain objects
 * (`@context`/`@id`/`@type` + prefixed properties). A real OSLC server, per the
 * OSLC Core 3.0 spec (§ "RDF Representations") and the OASIS OSLC SysML v2.0
 * PSM, must content-negotiate the *same* linked-data graph in multiple RDF
 * concrete syntaxes. This module renders that JSON-LD graph into:
 *
 *   - **Turtle** (`text/turtle`)             — {@link toTurtle}
 *   - **RDF/XML** (`application/rdf+xml`)     — {@link toRdfXml}
 *   - **JSON-LD** (`application/ld+json`)     — the input, served verbatim (default)
 *
 * It is a *clean-room* implementation authored from the W3C Turtle / RDF 1.1
 * XML Syntax recommendations and the OSLC Core spec — no third-party RDF
 * library is used or bundled (keeping the browser build free of dependencies
 * and this file usable standalone under `src/server`).
 *
 * Scope: it understands the shapes the OSLC facade actually produces — a root
 * object, nested anonymous objects (→ blank nodes), pure reference objects
 * (`{ '@id': … }` → IRIs), `@type`/`rdf:type` (→ `rdf:type`), and scalar
 * literals (string/number/boolean). That covers ServiceProviderCatalog,
 * ServiceProvider, query ResponseInfo and element resources.
 */

/** A prefix→namespace map (an OSLC/JSON-LD `@context`). */
export type Context = Record<string, string>;

/** Default prefixes, used when a document carries no `@context`. */
const DEFAULT_CONTEXT: Context = {
  oslc: 'http://open-services.net/ns/core#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  dcterms: 'http://purl.org/dc/terms/',
  sysml: 'https://www.omg.org/spec/SysML/20250201/SysML#',
};

/** The negotiated RDF serialization format. */
export type RdfFormat = 'turtle' | 'rdfxml' | 'jsonld';

/* ─────────────────────────── Triple model ──────────────────────────────── */

type Term =
  | { kind: 'iri'; value: string } // raw CURIE / absolute IRI / relative IRI
  | { kind: 'bnode'; value: string } // blank-node label (without `_:`)
  | { kind: 'literal'; value: string | number | boolean };

interface Triple {
  s: Term;
  /** Predicate as a CURIE (e.g. `dcterms:title`, `rdf:type`). */
  p: string;
  o: Term;
}

type JsonLd = Record<string, unknown>;

/** Collect the RDF triples of a JSON-LD document (recursively). */
function collect(doc: JsonLd): { triples: Triple[]; context: Context } {
  const context = (doc['@context'] as Context | undefined) ?? DEFAULT_CONTEXT;
  const triples: Triple[] = [];
  const counter = { n: 0 };
  collectNode(doc, triples, counter);
  return { triples, context };
}

function collectNode(node: JsonLd, triples: Triple[], counter: { n: number }): Term {
  const id = node['@id'];
  const subject: Term =
    typeof id === 'string'
      ? { kind: 'iri', value: id }
      : { kind: 'bnode', value: `b${++counter.n}` };

  for (const [key, value] of Object.entries(node)) {
    if (key === '@context' || key === '@id') continue;
    const predicate = key === '@type' ? 'rdf:type' : key;
    emit(subject, predicate, value, triples, counter);
  }
  return subject;
}

function emit(
  subject: Term,
  predicate: string,
  value: unknown,
  triples: Triple[],
  counter: { n: number },
): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const v of value) emit(subject, predicate, v, triples, counter);
    return;
  }

  if (typeof value === 'object') {
    const obj = value as JsonLd;
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj['@id'] === 'string') {
      // Pure reference → an IRI object.
      triples.push({ s: subject, p: predicate, o: { kind: 'iri', value: obj['@id'] as string } });
      return;
    }
    // Nested node → its own subject (blank node unless it carries an `@id`).
    const child = collectNode(obj, triples, counter);
    triples.push({ s: subject, p: predicate, o: child });
    return;
  }

  // Scalar. `rdf:type` scalars are IRIs (CURIEs like `oslc:ServiceProvider`).
  if (predicate === 'rdf:type') {
    triples.push({ s: subject, p: predicate, o: { kind: 'iri', value: String(value) } });
  } else {
    triples.push({ s: subject, p: predicate, o: { kind: 'literal', value: value as string | number | boolean } });
  }
}

/* ─────────────────────────────── Turtle ────────────────────────────────── */

/** Serialize a JSON-LD document to Turtle (`text/turtle`). */
export function toTurtle(doc: JsonLd): string {
  const { triples, context } = collect(doc);

  const lines: string[] = [];
  for (const [prefix, ns] of Object.entries(context)) {
    lines.push(`@prefix ${prefix}: <${ns}> .`);
  }
  lines.push('');

  // Group triples by subject, preserving first-seen order.
  const order: string[] = [];
  const bySubject = new Map<string, { subject: Term; triples: Triple[] }>();
  for (const t of triples) {
    const key = subjectKey(t.s);
    let group = bySubject.get(key);
    if (!group) {
      group = { subject: t.s, triples: [] };
      bySubject.set(key, group);
      order.push(key);
    }
    group.triples.push(t);
  }

  for (const key of order) {
    const group = bySubject.get(key)!;
    const subj = ttlTerm(group.subject, context);
    const preds = group.triples
      .map((t) => `    ${ttlPredicate(t.p)} ${ttlTerm(t.o, context)}`)
      .join(' ;\n');
    lines.push(`${subj}\n${preds} .`);
    lines.push('');
  }

  return lines.join('\n');
}

function subjectKey(t: Term): string {
  return t.kind === 'bnode' ? `_:${t.value}` : `<${t.value}>`;
}

function ttlPredicate(curie: string): string {
  return curie === 'rdf:type' ? 'a' : curie;
}

function ttlTerm(t: Term, ctx: Context): string {
  if (t.kind === 'bnode') return `_:${t.value}`;
  if (t.kind === 'literal') return ttlLiteral(t.value);
  return ttlIri(t.value, ctx);
}

function ttlLiteral(v: string | number | boolean): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `"${escapeTurtleString(String(v))}"`;
}

/** Render a raw IRI value as a CURIE (when a prefix matches) or `<iri>`. */
function ttlIri(raw: string, ctx: Context): string {
  const curie = toCurie(raw, ctx);
  if (curie) return curie;
  return `<${escapeIri(raw)}>`;
}

/**
 * Compress an IRI/CURIE to CURIE form when possible:
 *  - already a `prefix:local` with a known prefix → returned unchanged;
 *  - an absolute IRI under a known namespace with a NCName-safe local → compressed.
 * Returns `undefined` when no safe CURIE applies.
 */
function toCurie(raw: string, ctx: Context): string | undefined {
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (isAbsolute) {
    for (const [prefix, ns] of Object.entries(ctx)) {
      if (raw.startsWith(ns)) {
        const local = raw.slice(ns.length);
        if (/^[A-Za-z_][\w.-]*$/.test(local)) return `${prefix}:${local}`;
      }
    }
    return undefined;
  }
  const colon = raw.indexOf(':');
  if (colon > 0 && ctx[raw.slice(0, colon)]) return raw;
  return undefined;
}

function escapeTurtleString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function escapeIri(s: string): string {
  // Turtle IRIREF forbids these raw; percent-safe escaping of the rare cases.
  return s.replace(/[<>"{}|^`\\\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/* ─────────────────────────────── RDF/XML ───────────────────────────────── */

/** Serialize a JSON-LD document to RDF/XML (`application/rdf+xml`). */
export function toRdfXml(doc: JsonLd): string {
  const { triples, context } = collect(doc);

  // Group by subject (first-seen order), like Turtle.
  const order: string[] = [];
  const bySubject = new Map<string, { subject: Term; triples: Triple[] }>();
  for (const t of triples) {
    const key = subjectKey(t.s);
    let group = bySubject.get(key);
    if (!group) {
      group = { subject: t.s, triples: [] };
      bySubject.set(key, group);
      order.push(key);
    }
    group.triples.push(t);
  }

  const nsAttrs = Object.entries(context)
    .map(([prefix, ns]) => `xmlns:${prefix}="${escapeXmlAttr(ns)}"`)
    .join('\n         ');

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<rdf:RDF ${nsAttrs}>`);

  for (const key of order) {
    const group = bySubject.get(key)!;
    const openAttr =
      group.subject.kind === 'bnode'
        ? `rdf:nodeID="${escapeXmlAttr(group.subject.value)}"`
        : `rdf:about="${escapeXmlAttr(expandIri(String(group.subject.value), context))}"`;
    out.push(`  <rdf:Description ${openAttr}>`);
    for (const t of group.triples) {
      out.push(`    ${xmlProperty(t, context)}`);
    }
    out.push('  </rdf:Description>');
  }

  out.push('</rdf:RDF>');
  return out.join('\n');
}

function xmlProperty(t: Triple, ctx: Context): string {
  const el = t.p; // CURIE is a valid XML QName (rdf:type, dcterms:title, …)
  if (t.o.kind === 'literal') {
    return `<${el}>${escapeXmlText(String(t.o.value))}</${el}>`;
  }
  if (t.o.kind === 'bnode') {
    return `<${el} rdf:nodeID="${escapeXmlAttr(t.o.value)}"/>`;
  }
  return `<${el} rdf:resource="${escapeXmlAttr(expandIri(t.o.value, ctx))}"/>`;
}

/** Expand a CURIE to an absolute IRI for RDF/XML attributes; pass IRIs through. */
function expandIri(raw: string, ctx: Context): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw; // already absolute
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const ns = ctx[raw.slice(0, colon)];
    if (ns) return ns + raw.slice(colon + 1);
  }
  return raw; // relative IRI — resolved by the consumer against a base
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, '&quot;');
}

/* ─────────────────────── Content negotiation helper ─────────────────────── */

/**
 * Choose an RDF format from an optional `?format=` override and the `Accept`
 * header. Precedence: explicit `format` param, then `Accept`, else JSON-LD.
 */
export function chooseRdfFormat(accept: string | undefined, formatParam?: string): RdfFormat {
  const fmt = (formatParam ?? '').toLowerCase();
  if (fmt === 'turtle' || fmt === 'ttl') return 'turtle';
  if (fmt === 'rdfxml' || fmt === 'rdf+xml' || fmt === 'rdf' || fmt === 'xml') return 'rdfxml';
  if (fmt === 'jsonld' || fmt === 'json-ld' || fmt === 'json') return 'jsonld';

  const a = (accept ?? '').toLowerCase();
  if (a.includes('text/turtle') || a.includes('application/x-turtle')) return 'turtle';
  if (a.includes('application/rdf+xml')) return 'rdfxml';
  // application/ld+json, application/json, */*, or empty → JSON-LD default.
  return 'jsonld';
}

/** MIME type for a chosen RDF format. */
export function rdfContentType(format: RdfFormat): string {
  switch (format) {
    case 'turtle':
      return 'text/turtle; charset=utf-8';
    case 'rdfxml':
      return 'application/rdf+xml; charset=utf-8';
    case 'jsonld':
      return 'application/ld+json; charset=utf-8';
  }
}

/** Serialize a JSON-LD document to the chosen RDF format. */
export function serializeRdf(doc: JsonLd, format: RdfFormat): string {
  switch (format) {
    case 'turtle':
      return toTurtle(doc);
    case 'rdfxml':
      return toRdfXml(doc);
    case 'jsonld':
      return JSON.stringify(doc, null, 2);
  }
}
