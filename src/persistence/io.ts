/**
 * Model import/export across three interchange formats:
 *
 *  - `'model-json'` — the modeler's native snapshot ({@link SerializedModel} via
 *    `Model.toJSON` / `Model.fromJSON`). Loss-less and trivial.
 *  - `'sysml'`      — SysML v2 textual notation, delegated to the `@text`
 *    serializer/parser.
 *  - `'api-json'`   — the OMG SysML v2 *API & Services* element-graph JSON: a
 *    flat list of elements keyed on `@id`/`@type`, with containment reified as
 *    `OwningMembership`/`FeatureMembership` relationship elements (see
 *    docs/02-omg-standard-reference.md §5.4). Implemented as a faithful,
 *    invertible (de)serializer below.
 *
 * `exportModel` always returns a string; `importModel` returns the rebuilt
 * {@link Model} plus any parser diagnostics (only the `'sysml'` path produces
 * them).
 */

import {
  Model,
  FORMAT_VERSION,
  isUsage,
  type AttrValue,
  type ElementId,
  type ElementRecord,
  type SerializedModel,
} from '@core/index';
import { parseModel, serializeModel, type ParseDiagnostic } from '@text/index';
import { GENERATOR_ID } from '../branding';

/** Interchange formats understood by {@link exportModel}/{@link importModel}. */
export type ModelFormat = 'model-json' | 'sysml' | 'api-json';

/** Result of {@link importModel}. */
export interface ImportResult {
  model: Model;
  /** Diagnostics from parsing (textual notation only); omitted otherwise. */
  diagnostics?: ParseDiagnostic[];
}

/* ───────────────────────────── Public surface ───────────────────────────── */

/** Serialise a {@link Model} to text in the requested `format`. */
export function exportModel(model: Model, format: ModelFormat): string {
  switch (format) {
    case 'model-json':
      return JSON.stringify(model.toJSON(), null, 2);
    case 'sysml':
      return serializeModel(model);
    case 'api-json':
      return JSON.stringify(toApiGraph(model), null, 2);
    default: {
      const never: never = format;
      throw new Error(`Unknown export format: ${String(never)}`);
    }
  }
}

/** Parse `text` in the requested `format` into a fresh {@link Model}. */
export function importModel(text: string, format: ModelFormat): ImportResult {
  switch (format) {
    case 'model-json': {
      const data = parseJson(text, 'model JSON');
      if (!isSerializedModel(data)) {
        throw new ImportError('Not a valid model-JSON document: missing an "elements" array.');
      }
      return { model: Model.fromJSON(data) };
    }
    case 'sysml': {
      const { model, diagnostics } = parseModel(text);
      return { model, diagnostics };
    }
    case 'api-json': {
      const graph = parseJson(text, 'API element-graph JSON');
      if (!isApiGraph(graph)) {
        throw new ImportError('Not a valid api-json document: expected an "@graph"/element array.');
      }
      return { model: fromApiGraph(graph) };
    }
    default: {
      const never: never = format;
      throw new Error(`Unknown import format: ${String(never)}`);
    }
  }
}

/** Import failure with a human-readable reason (vs. a raw SyntaxError). */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

/** JSON.parse wrapped so a malformed/truncated file yields a clear ImportError. */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ImportError(`Malformed ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isSerializedModel(v: unknown): v is SerializedModel {
  return typeof v === 'object' && v !== null && Array.isArray((v as { elements?: unknown }).elements);
}

function isApiGraph(v: unknown): v is ApiGraph {
  return typeof v === 'object' && v !== null && Array.isArray((v as { elements?: unknown }).elements);
}

/* ─────────────────────── OMG API element-graph shape ────────────────────── */

/** A `{ "@id": "…" }` reference to another element. */
interface Ref {
  '@id': ElementId;
}

/** One element in the OMG element-graph (open/extensible: metaclass fields ride along). */
interface ApiElement {
  '@id': ElementId;
  '@type': string;
  identifier: ElementId;
  declaredName?: string;
  declaredShortName?: string;
  /** Reified relationships owned by this element (memberships of its members). */
  ownedRelationship?: Ref[];
  /** The membership that contains this element (absent for roots). */
  owningRelationship?: Ref;
  /** Relationship/endpoint sources (reified relationships & connector usages). */
  source?: Ref[];
  /** Relationship/endpoint targets. */
  target?: Ref[];
  /** The member element (membership elements only). */
  memberElement?: Ref;
  /** The owned member element (owning-membership elements only). */
  ownedMemberElement?: Ref;
  /** The owning namespace/type (membership elements only). */
  owningRelatedElement?: Ref;
  /** Metaclass-specific attributes (name, value, direction, …) ride along here. */
  [extra: string]: unknown;
}

/** The exchanged document: `{ elements: [...], rootElement: [...] }`. */
interface ApiGraph {
  '@type'?: string;
  formatVersion?: string;
  generator?: string;
  elements: ApiElement[];
  /** Convenience index of root (un-owned) element ids. */
  rootElement?: Ref[];
}

/** Structural keys that are NOT metaclass attributes (must not leak into `attrs`). */
const RESERVED_KEYS = new Set<string>([
  '@id',
  '@type',
  'identifier',
  'declaredName',
  'declaredShortName',
  'ownedRelationship',
  'owningRelationship',
  'source',
  'target',
  'memberElement',
  'ownedMemberElement',
  'owningRelatedElement',
]);

/** Membership metaclasses used to reify ownership on the wire. */
const OWNERSHIP_MEMBERSHIPS = new Set<string>([
  'OwningMembership',
  'FeatureMembership',
  'Membership',
]);

/** Deterministic id for the synthesised ownership membership of `childId`. */
function membershipId(childId: ElementId): ElementId {
  return `om-${childId}`;
}

/**
 * Narrow a raw API-JSON value object to the {@link ElementRecord.attrs}
 * shape. The incoming object can carry arbitrary additional members (the
 * element graph is open), so we drop the reserved structural keys and treat
 * everything else as a metaclass attribute.
 *
 * (finding M15 — keeps the attrs narrowing a checked boundary instead of a
 * bare cast at the construction site.)
 */
function jsonAttrs(ae: Record<string, unknown>): ElementRecord['attrs'] {
  const attrs: ElementRecord['attrs'] = {};
  for (const [k, v] of Object.entries(ae)) {
    if (!RESERVED_KEYS.has(k)) attrs[k] = v as AttrValue;
  }
  return attrs;
}

/**
 * Serialise a model to the OMG element-graph. Ownership (denormalised onto
 * `ownerId` in the core model) is reified as one `FeatureMembership` (for
 * usages) or `OwningMembership` (otherwise) per owned element. Endpoint arrays
 * (`source`/`target`) on relationships and connector usages become `{@id}`
 * reference arrays. Every metaclass attribute rides along at top level.
 */
function toApiGraph(model: Model): ApiGraph {
  const elements: ApiElement[] = [];
  // Pre-compute the membership ids each owner contributes, so `ownedRelationship`
  // can list them on the owner.
  const ownedByOwner = new Map<ElementId, Ref[]>();
  for (const el of model.all()) {
    if (el.ownerId !== null) {
      const list = ownedByOwner.get(el.ownerId) ?? [];
      list.push({ '@id': membershipId(el.id) });
      ownedByOwner.set(el.ownerId, list);
    }
  }

  for (const el of model.all()) {
    const out: ApiElement = {
      '@id': el.id,
      '@type': el.eClass,
      identifier: el.id,
    };
    if (el.declaredName !== undefined) out.declaredName = el.declaredName;
    if (el.declaredShortName !== undefined) out.declaredShortName = el.declaredShortName;
    if (el.source) out.source = el.source.map((id) => ({ '@id': id }));
    if (el.target) out.target = el.target.map((id) => ({ '@id': id }));
    // Metaclass attributes ride along at top level (OMG additionalProperties).
    for (const [k, v] of Object.entries(el.attrs)) {
      if (!RESERVED_KEYS.has(k)) out[k] = v;
    }
    const owned = ownedByOwner.get(el.id);
    if (owned && owned.length) out.ownedRelationship = owned;
    if (el.ownerId !== null) out.owningRelationship = { '@id': membershipId(el.id) };
    elements.push(out);

    // Emit the reified ownership membership for this element.
    if (el.ownerId !== null) {
      const mId = membershipId(el.id);
      elements.push({
        '@id': mId,
        '@type': isUsage(el.eClass) ? 'FeatureMembership' : 'OwningMembership',
        identifier: mId,
        memberElement: { '@id': el.id },
        ownedMemberElement: { '@id': el.id },
        owningRelatedElement: { '@id': el.ownerId },
      });
    }
  }

  return {
    '@type': 'ElementGraph',
    formatVersion: FORMAT_VERSION,
    generator: GENERATOR_ID,
    elements,
    rootElement: model.rootIds().map((id) => ({ '@id': id })),
  };
}

/**
 * Rebuild a {@link Model} from an OMG element-graph. The synthesised ownership
 * memberships are *consumed* (their `memberElement`→`owningRelatedElement` link
 * restores `ownerId`) rather than materialised as model elements, so the
 * round-trip reproduces the original element set exactly.
 */
function fromApiGraph(graph: ApiGraph): Model {
  const apiElements = graph.elements ?? [];
  // Pass 1: index ownership from membership elements.
  const ownerOf = new Map<ElementId, ElementId>();
  for (const ae of apiElements) {
    if (OWNERSHIP_MEMBERSHIPS.has(ae['@type'])) {
      const child = ae.memberElement?.['@id'] ?? ae.ownedMemberElement?.['@id'];
      const owner = ae.owningRelatedElement?.['@id'];
      if (child && owner) ownerOf.set(child, owner);
    }
  }

  // Pass 2: build ElementRecords for the real (non-membership) elements.
  const elements: ElementRecord[] = [];
  const rootIds: ElementId[] = [];
  for (const ae of apiElements) {
    if (OWNERSHIP_MEMBERSHIPS.has(ae['@type'])) continue;
    const id = ae['@id'];
    const ownerId = ownerOf.get(id) ?? null;
    const rec: ElementRecord = {
      id,
      eClass: ae['@type'],
      ownerId,
      attrs: jsonAttrs(ae),
    };
    if (ae.declaredName !== undefined) rec.declaredName = ae.declaredName;
    if (ae.declaredShortName !== undefined) rec.declaredShortName = ae.declaredShortName;
    if (ae.source) rec.source = ae.source.map((r) => r['@id']);
    if (ae.target) rec.target = ae.target.map((r) => r['@id']);
    elements.push(rec);
    if (ownerId === null) rootIds.push(id);
  }

  // Honour an explicit root ordering when supplied.
  const orderedRoots =
    graph.rootElement && graph.rootElement.length
      ? graph.rootElement.map((r) => r['@id']).filter((id) => rootIds.includes(id))
      : rootIds;

  return Model.fromJSON({
    formatVersion: graph.formatVersion ?? FORMAT_VERSION,
    generator: graph.generator,
    elements,
    rootIds: orderedRoots,
  });
}
