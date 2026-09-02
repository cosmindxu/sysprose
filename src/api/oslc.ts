/**
 * Representative OSLC PSM facade for the SysML v2 API & Services.
 *
 * The OMG API & Services spec binds its Platform-Independent Model to TWO
 * Platform-Specific Models: the REST/HTTP PSM (see {@link SysmlApiServer}) and
 * an **OSLC** (Open Services for Lifecycle Collaboration) linked-data PSM,
 * mirrored as the OASIS "OSLC Systems Modeling Language v2.0" specification
 * (docs/02-omg-standard-reference.md §5.1; docs/LICENSES.md).
 *
 * This file implements a **representative subset** of that OSLC PSM, authored
 * originally from the OSLC Core / OMG specifications (no third-party code
 * copied). It surfaces the four load-bearing OSLC constructs over the same
 * in-memory model the REST facade uses:
 *
 *   - `GET /oslc/catalog`        → an **oslc:ServiceProviderCatalog**.
 *   - `GET /oslc/services`       → an **oslc:ServiceProvider** advertising a
 *                                  query capability + creation factory.
 *   - `GET /oslc/query?oslc.where=…&oslc.select=…`
 *                                → a **Query capability**: a minimal `oslc.where`
 *                                  parser maps to our {@link Query} and returns
 *                                  an `oslc:ResponseInfo` with `rdfs:member`s.
 *   - `GET /oslc/elements/:id`   → a **JSON-LD** representation of one element
 *                                  with an `@context` (oslc/rdf/rdfs/dcterms/
 *                                  sysml prefixes), `rdf:type`,
 *                                  `dcterms:identifier`/`dcterms:title` and
 *                                  `sysml:ownedRelationship` links.
 *
 * All responses are JSON-LD-shaped plain objects; a real OSLC server would
 * content-negotiate RDF/Turtle from the same graph.
 */

import type { ElementRecord, Model } from '@core/index';
import { ModelApi } from './sdk';
import { evaluateQuery, type Constraint, type PrimitiveConstraint, type Query } from './query';

/** HTTP-shaped response from {@link OslcServer.oslcFetch}. */
export interface OslcResponse {
  status: number;
  body: unknown;
}

/** Namespace prefixes advertised in every JSON-LD `@context`. */
export const OSLC_CONTEXT = {
  oslc: 'http://open-services.net/ns/core#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  dcterms: 'http://purl.org/dc/terms/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  // Representative SysML v2 metamodel namespace (final IRI is spec-defined).
  sysml: 'https://www.omg.org/spec/SysML/20250201/SysML#',
} as const;

const ELEMENT_BASE = '/oslc/elements/';
const SHAPE_BASE = '/oslc/shapes/';
const DIALOG_BASE = '/oslc/dialogs/';

/**
 * An OSLC linked-data facade over a single {@link Model}. Mirrors
 * {@link SysmlApiServer}'s in-process `apiFetch` style with `oslcFetch`.
 */
export class OslcServer {
  private readonly api: ModelApi;

  constructor(public readonly model: Model) {
    this.api = new ModelApi(model);
  }

  /** Route an OSLC request. `path` may carry an `oslc.*` query string. */
  oslcFetch(method: string, path: string): OslcResponse {
    if (method.toUpperCase() !== 'GET') return methodNotAllowed();
    const [rawPath, rawQuery] = path.split('?');
    const seg = rawPath.split('/').filter(Boolean);

    if (seg[0] !== 'oslc') return notFound(`Unknown OSLC route: /${seg.join('/')}`);

    if (seg[1] === 'catalog' && seg.length === 2) return ok(this.catalog());
    if (seg[1] === 'services' && seg.length === 2) return ok(this.serviceProvider());
    if (seg[1] === 'query' && seg.length === 2) return ok(this.query(parseQueryString(rawQuery)));
    if (seg[1] === 'shapes' && seg.length === 3) return this.resourceShape(seg[2]);
    if (seg[1] === 'dialogs' && seg.length === 3) return this.dialog(seg[2]);
    if (seg[1] === 'elements' && seg.length === 3) {
      const params = parseQueryString(rawQuery);
      // Compact preview: `?compact` (or an OSLC compact `Accept` mapped to it).
      if ('compact' in params) return this.compact(seg[2]);
      return this.element(seg[2]);
    }

    return notFound(`Unknown OSLC route: /${seg.join('/')}`);
  }

  /* ─────────────────────────── Discovery documents ──────────────────────── */

  private catalog(): Record<string, unknown> {
    return {
      '@context': OSLC_CONTEXT,
      '@id': '/oslc/catalog',
      '@type': 'oslc:ServiceProviderCatalog',
      'dcterms:title': 'SysML v2 Service Provider Catalog',
      'oslc:serviceProvider': [
        {
          '@id': '/oslc/services',
          '@type': 'oslc:ServiceProvider',
          'dcterms:title': 'SysML v2 Model Repository',
        },
      ],
    };
  }

  private serviceProvider(): Record<string, unknown> {
    const S = OSLC_CONTEXT.sysml;
    const dialogs = this.dialogDocs();
    return {
      '@context': OSLC_CONTEXT,
      '@id': '/oslc/services',
      '@type': 'oslc:ServiceProvider',
      'dcterms:title': 'SysML v2 Model Repository',
      'oslc:service': [
        {
          '@type': 'oslc:Service',
          'oslc:domain': { '@id': S },
          'oslc:queryCapability': [
            {
              '@type': 'oslc:QueryCapability',
              'dcterms:title': 'SysML Element Query',
              'oslc:queryBase': { '@id': '/oslc/query' },
              'oslc:resourceType': [{ '@id': `${S}Element` }],
              'oslc:resourceShape': { '@id': `${SHAPE_BASE}Element` },
            },
          ],
          'oslc:creationFactory': [
            {
              '@type': 'oslc:CreationFactory',
              'dcterms:title': 'SysML Element Creation',
              'oslc:creation': { '@id': ELEMENT_BASE },
              'oslc:resourceType': [{ '@id': `${S}Element` }],
              'oslc:resourceShape': [
                { '@id': `${SHAPE_BASE}Element` },
                { '@id': `${SHAPE_BASE}Project` },
              ],
            },
          ],
          // Delegated UI dialogs (OSLC Core "Delegated Dialogs"): embedded inline
          // and independently retrievable at `/oslc/dialogs/{creation,selection}`.
          'oslc:creationDialog': [dialogs.creation],
          'oslc:selectionDialog': [dialogs.selection],
        },
      ],
      // Resource shapes advertised at the provider level for easy discovery.
      'oslc:resourceShape': [
        { '@id': `${SHAPE_BASE}Element` },
        { '@id': `${SHAPE_BASE}Project` },
      ],
    };
  }

  /* ─────────────────────────── Resource shapes ──────────────────────────── */

  /** Return the requested {@link https://docs.oasis-open-projects.org OSLC} `oslc:ResourceShape`. */
  private resourceShape(type: string): OslcResponse {
    const shape = this.shapeDocs()[type];
    if (!shape) return notFound(`No such resource shape: ${type}`);
    return ok(shape);
  }

  /**
   * The `oslc:ResourceShape` documents for the modeler's resource types. Each
   * shape `oslc:describes` a resource type and lists its `oslc:Property`s, every
   * property carrying an `oslc:propertyDefinition`, `oslc:valueType` and
   * `oslc:occurs` cardinality (OSLC Core 3.0 "Resource Shape").
   */
  private shapeDocs(): Record<string, Record<string, unknown>> {
    const S = OSLC_CONTEXT.sysml;
    const XSD = OSLC_CONTEXT.xsd;
    const Element: Record<string, unknown> = {
      '@context': OSLC_CONTEXT,
      '@id': `${SHAPE_BASE}Element`,
      '@type': 'oslc:ResourceShape',
      'dcterms:title': 'SysML Element Resource Shape',
      'oslc:describes': { '@id': `${S}Element` },
      'oslc:property': [
        shapeProperty('identifier', 'dcterms:identifier', `${XSD}string`, 'oslc:Exactly-one', true),
        shapeProperty('title', 'dcterms:title', `${XSD}string`, 'oslc:Zero-or-one', false),
        shapeProperty('type', 'rdf:type', `${S}Element`, 'oslc:Exactly-one', true),
        shapeProperty('owner', `${S}owner`, `${S}Element`, 'oslc:Zero-or-one', false),
        shapeProperty('ownedRelationship', `${S}ownedRelationship`, `${S}Element`, 'oslc:Zero-or-many', false),
      ],
    };
    const Project: Record<string, unknown> = {
      '@context': OSLC_CONTEXT,
      '@id': `${SHAPE_BASE}Project`,
      '@type': 'oslc:ResourceShape',
      'dcterms:title': 'SysML Project Resource Shape',
      'oslc:describes': { '@id': `${S}Project` },
      'oslc:property': [
        shapeProperty('identifier', 'dcterms:identifier', `${XSD}string`, 'oslc:Exactly-one', true),
        shapeProperty('title', 'dcterms:title', `${XSD}string`, 'oslc:Exactly-one', false),
        shapeProperty('defaultBranch', `${S}defaultBranch`, `${S}Branch`, 'oslc:Exactly-one', false),
      ],
    };
    return { Element, Project };
  }

  /* ──────────────────────────── Delegated dialogs ───────────────────────── */

  /** Return the requested delegated `oslc:Dialog` (`creation` | `selection`). */
  private dialog(kind: string): OslcResponse {
    const d = this.dialogDocs()[kind];
    if (!d) return notFound(`No such dialog: ${kind}`);
    return ok(d);
  }

  /**
   * Delegated-UI dialog descriptors (OSLC Core "Delegated Dialogs"). Each is an
   * `oslc:Dialog` with an `oslc:dialog` UI URI, `oslc:hintWidth`/`oslc:hintHeight`
   * sizing hints, an `oslc:label` and the `oslc:resourceType` it operates on.
   */
  private dialogDocs(): Record<string, Record<string, unknown>> {
    const S = OSLC_CONTEXT.sysml;
    const creation: Record<string, unknown> = {
      '@context': OSLC_CONTEXT,
      '@id': `${DIALOG_BASE}creation`,
      '@type': 'oslc:Dialog',
      'dcterms:title': 'Create SysML Element',
      'oslc:label': 'New Element',
      'oslc:dialog': { '@id': `${DIALOG_BASE}creation/ui` },
      'oslc:hintWidth': '640px',
      'oslc:hintHeight': '480px',
      'oslc:resourceType': [{ '@id': `${S}Element` }],
    };
    const selection: Record<string, unknown> = {
      '@context': OSLC_CONTEXT,
      '@id': `${DIALOG_BASE}selection`,
      '@type': 'oslc:Dialog',
      'dcterms:title': 'Select SysML Element',
      'oslc:label': 'Pick Element',
      'oslc:dialog': { '@id': `${DIALOG_BASE}selection/ui` },
      'oslc:hintWidth': '600px',
      'oslc:hintHeight': '400px',
      'oslc:resourceType': [{ '@id': `${S}Element` }],
    };
    return { creation, selection };
  }

  /* ──────────────────────────── Compact preview ─────────────────────────── */

  /**
   * `oslc:Compact` preview of an element (OSLC Core "UI Preview"): a
   * `dcterms:title`, `oslc:shortTitle`, `oslc:icon` and an `oslc:smallPreview`
   * (`oslc:Preview`) pointing at the full resource.
   */
  private compact(id: string): OslcResponse {
    if (!this.model.get(id)) return notFound(`No such element: ${id}`);
    const json = this.api.toElementJSON(id)!;
    const type = String(json['@type'] ?? 'Element');
    const doc: Record<string, unknown> = {
      '@context': OSLC_CONTEXT,
      '@id': `${ELEMENT_BASE}${id}?compact`,
      '@type': 'oslc:Compact',
      'dcterms:title': json.declaredName ?? id,
      'oslc:shortTitle': json.declaredShortName ?? type,
      'oslc:icon': { '@id': `/oslc/icons/${type}.svg` },
      'oslc:iconTitle': type,
      'oslc:smallPreview': {
        '@type': 'oslc:Preview',
        'oslc:document': { '@id': `${ELEMENT_BASE}${id}` },
        'oslc:hintWidth': '320px',
        'oslc:hintHeight': '150px',
      },
    };
    return ok(doc);
  }

  /* ───────────────────────────── Query capability ───────────────────────── */

  private query(params: Record<string, string>): Record<string, unknown> {
    const query: Query = {};
    const where = params['oslc.where'];
    if (where) {
      const constraint = parseOslcWhere(where);
      if (constraint) query.constraint = constraint;
    }
    // `oslc.select` projects JSON-LD property keys (e.g. `dcterms:title`) directly.
    const select = params['oslc.select'];
    const selectKeys = select ? select.split(',').map((s) => s.trim()).filter(Boolean) : [];

    const result = evaluateQuery(this.model, query);
    // `query` never carries a `select` here (projection happens on the JSON-LD
    // output below), so every element is a full record (finding M14).
    const members = result.elements.map((el) => {
      const full = this.elementJsonLd((el as ElementRecord).id);
      if (selectKeys.length === 0) return full;
      const projected: Record<string, unknown> = { '@id': full['@id'] };
      for (const k of selectKeys) if (full[k] !== undefined) projected[k] = full[k];
      return projected;
    });

    return {
      '@context': OSLC_CONTEXT,
      '@type': 'oslc:ResponseInfo',
      'oslc:totalCount': result.total,
      'rdfs:member': members,
    };
  }

  /* ─────────────────────────── Element representation ───────────────────── */

  private element(id: string): OslcResponse {
    if (!this.model.get(id)) return notFound(`No such element: ${id}`);
    return ok(this.elementJsonLd(id));
  }

  /** JSON-LD representation of one element (used standalone and as a member). */
  private elementJsonLd(id: string): Record<string, unknown> {
    const json = this.api.toElementJSON(id)!;
    const doc: Record<string, unknown> = {
      '@context': OSLC_CONTEXT,
      '@id': `${ELEMENT_BASE}${id}`,
      'rdf:type': { '@id': `${OSLC_CONTEXT.sysml}${json['@type']}` },
      'dcterms:identifier': id,
    };
    if (json.declaredName !== undefined) doc['dcterms:title'] = json.declaredName;
    if (json.owner) doc['sysml:owner'] = { '@id': `${ELEMENT_BASE}${json.owner['@id']}` };
    const owned = [...json.ownedRelationship, ...json.ownedMember];
    if (owned.length > 0) {
      doc['sysml:ownedRelationship'] = owned.map((r) => ({ '@id': `${ELEMENT_BASE}${r['@id']}` }));
    }
    if (json.source) {
      doc['sysml:source'] = json.source.map((r) => ({ '@id': `${ELEMENT_BASE}${r['@id']}` }));
    }
    if (json.target) {
      doc['sysml:target'] = json.target.map((r) => ({ '@id': `${ELEMENT_BASE}${r['@id']}` }));
    }
    return doc;
  }
}

/* ─────────────────────────── Resource-shape helper ──────────────────────── */

/**
 * Build one `oslc:Property` entry of an `oslc:ResourceShape`: a named property
 * with its `oslc:propertyDefinition` (predicate IRI/CURIE), `oslc:valueType`
 * and `oslc:occurs` cardinality (an `oslc:` cardinality individual such as
 * `oslc:Exactly-one` / `oslc:Zero-or-many`), plus `oslc:readOnly`.
 */
function shapeProperty(
  name: string,
  propertyDefinition: string,
  valueType: string,
  occurs: string,
  readOnly: boolean,
): Record<string, unknown> {
  return {
    '@type': 'oslc:Property',
    'oslc:name': name,
    'oslc:propertyDefinition': { '@id': propertyDefinition },
    'oslc:valueType': { '@id': valueType },
    'oslc:occurs': { '@id': occurs },
    'oslc:readOnly': readOnly,
  };
}

/* ───────────────────────────── oslc.where parser ────────────────────────── */

/**
 * Minimal `oslc.where` parser: a conjunction of comparison terms joined by
 * ` and ` (case-insensitive) or commas, each `property <op> value`, with
 * `op ∈ {=,!=,<,>,<=,>=}`. String values are double-quoted; bare tokens parse
 * as number/boolean when possible. Property names map through
 * {@link oslcPropertyToPath}. Returns a single primitive, an `and` composite,
 * or `null` when nothing parses.
 */
export function parseOslcWhere(where: string): Constraint | undefined {
  const terms = where
    .split(/\s+and\s+|,/i)
    .map((t) => t.trim())
    .filter(Boolean);

  const primitives: PrimitiveConstraint[] = [];
  for (const term of terms) {
    const m = term.match(/^([\w:.@]+)\s*(<=|>=|!=|=|<|>)\s*(.+)$/);
    if (!m) continue;
    const property = oslcPropertyToPath(m[1]);
    if (!property) continue;
    primitives.push({ property, operator: m[2] as PrimitiveConstraint['operator'], value: parseValue(m[3]) });
  }

  if (primitives.length === 0) return undefined;
  if (primitives.length === 1) return primitives[0];
  return { operator: 'and', constraint: primitives };
}

/** Map an OSLC property term (possibly prefixed) to an internal property path. */
export function oslcPropertyToPath(term: string): string {
  switch (term) {
    case 'dcterms:title':
    case 'title':
    case 'name':
      return 'name';
    case 'dcterms:identifier':
    case 'identifier':
    case '@id':
      return '@id';
    case 'rdf:type':
    case 'type':
    case '@type':
      return '@type';
    default:
      break;
  }
  if (term.startsWith('sysml:')) return term.slice('sysml:'.length);
  return term;
}

function parseValue(raw: string): string | number | boolean {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  const n = Number(t);
  if (t !== '' && Number.isFinite(n)) return n;
  return t;
}

/* ───────────────────────────────── Helpers ──────────────────────────────── */

/** Decode a percent-encoded query component; malformed input (e.g. a bare `%`)
 * is returned verbatim rather than throwing URIError (finding M3). */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseQueryString(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    const v = eq >= 0 ? pair.slice(eq + 1) : '';
    out[safeDecode(k)] = safeDecode(v.replace(/\+/g, ' '));
  }
  return out;
}

function ok(body: unknown): OslcResponse {
  return { status: 200, body };
}
function notFound(message: string): OslcResponse {
  return { status: 404, body: { error: message } };
}
function methodNotAllowed(): OslcResponse {
  return { status: 405, body: { error: 'Method not allowed' } };
}
