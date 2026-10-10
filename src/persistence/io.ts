/**
 * Model import/export across three interchange formats:
 *
 *  - `'model-json'` — the modeler's native snapshot ({@link SerializedModel} via
 *    `Model.toJSON` / `Model.fromJSON`). Loss-less and trivial.
 *  - `'sysml'`      — SysML v2 textual notation, delegated to the `@text`
 *    serializer/parser. The USER's roots only: the merged standard library
 *    stays out (see {@link userModelText}).
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
import { parseModel, serializeElement, type ParseDiagnostic } from '@text/index';
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
      return userModelText(model);
    case 'api-json':
      return JSON.stringify(toApiGraph(model), null, 2);
    default: {
      const never: never = format;
      throw new Error(`Unknown export format: ${String(never)}`);
    }
  }
}

/**
 * The model as text — the user's own roots, never the bundled standard
 * library (`attrs.isLibrary`).
 *
 * `serializeModel` writes every root, and once the app has merged the full
 * library that is 188 library roots (~1.28 MB of text) after the user's few.
 * Text carries no `isLibrary` flag, so importing that file made every one
 * of them the user's — hundreds of parse errors, and a second copy of the
 * library beside the one merged again. The Text view and Save to Drive
 * have always written the user's roots only (`userRootIds` in
 * `src/ui/store.ts`), and so has the CLI (`modelText` in
 * `scripts/sysprose.ts`); this is the export's copy, so an exported file
 * holds the text the Text view writes for the same model. `serializeModel`
 * itself still writes every root: it is asked to write library models too
 * (the conformance round trip writes ISQ and SI).
 *
 * The two JSON formats keep the library on purpose: each element carries its
 * `isLibrary` flag, so an import reads the library back AS library, as a saved
 * browser project does.
 */
function userModelText(model: Model): string {
  return model
    .roots()
    .filter((r) => r.attrs.isLibrary !== true)
    .map((r) => serializeElement(model, r.id, 0))
    .join('\n\n');
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

/** Infer the import {@link ModelFormat} from a filename + its contents. */
export function detectFormat(name: string, content: string): ModelFormat {
  const lower = name.toLowerCase();
  if (lower.endsWith('.sysml') || lower.endsWith('.txt')) return 'sysml';
  if (lower.endsWith('.json')) {
    try {
      const obj = JSON.parse(content) as Record<string, unknown>;
      // Native snapshots carry `rootIds`; the OMG API graph carries `@type`/`rootElement`.
      if (Array.isArray((obj as { rootIds?: unknown }).rootIds)) return 'model-json';
      if ('@type' in obj || 'rootElement' in obj) return 'api-json';
    } catch {
      /* fall through */
    }
    return 'model-json';
  }
  // Unknown extension: sniff for a leading JSON object.
  return content.trimStart().startsWith('{') ? 'model-json' : 'sysml';
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

/**
 * Membership metaclasses used to reify ownership on the wire. A plain
 * `Membership` is not one: it never owns its member (KerML), the export never
 * reifies ownership with one, and in a model it is an element of its own — an
 * `alias`.
 */
const OWNERSHIP_MEMBERSHIPS = new Set<string>(['OwningMembership', 'FeatureMembership']);

/** Deterministic id for the synthesised ownership membership of `childId`. */
function membershipId(childId: ElementId): ElementId {
  return `om-${childId}`;
}

/**
 * The containment an entry of the graph reifies, or `null` when the entry is an
 * element of the model.
 *
 * The type alone does not tell: the model's own membership elements are on the
 * wire too, under their own metaclass (the full library holds 268 `alias`
 * `Membership`s). An entry reifies the ownership of its member only when it is
 * an owning or feature membership that names a member and an owner, and is that
 * member's OWNING membership:
 * - the export's `om-<member id>`;
 * - in a graph written elsewhere, whose memberships carry ids of their own, the
 *   membership the member names as its `owningRelationship`;
 * - or, when the member names no `owningRelationship` at all (it is derived, and
 *   optional on the wire), any owning membership of it, as the import has always
 *   read one.
 *
 * A plain `Membership` (an alias) never owns what it names, and neither does any
 * other owning membership whose member names another as its
 * `owningRelationship`: each is an element of the model and never re-parents
 * the element it points at. (A model's own `OwningMembership` or
 * `FeatureMembership` element carries no `memberElement` on the wire —
 * {@link RESERVED_KEYS} — so it is kept as well.)
 *
 * @param owningOf each entry's `owningRelationship` id, by entry id.
 */
function reifiedOwnership(
  ae: ApiElement,
  owningOf: ReadonlyMap<ElementId, ElementId>,
): { child: ElementId; owner: ElementId } | null {
  if (!OWNERSHIP_MEMBERSHIPS.has(ae['@type'])) return null;
  const child = ae.memberElement?.['@id'] ?? ae.ownedMemberElement?.['@id'];
  const owner = ae.owningRelatedElement?.['@id'];
  if (!child || !owner) return null;
  const id = ae['@id'];
  const named = owningOf.get(child);
  return id === membershipId(child) || named === undefined || named === id ? { child, owner } : null;
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
 * round-trip reproduces the original element set exactly. The model's own
 * membership elements (an `alias` is a `Membership`) are elements like any
 * other: see {@link reifiedOwnership} for how the two are told apart.
 */
function fromApiGraph(graph: ApiGraph): Model {
  const apiElements = graph.elements ?? [];
  // Pass 1: index ownership from the reified ownership memberships.
  const owningOf = new Map<ElementId, ElementId>();
  for (const ae of apiElements) {
    const owning = ae.owningRelationship?.['@id'];
    if (owning) owningOf.set(ae['@id'], owning);
  }
  const ownerOf = new Map<ElementId, ElementId>();
  const reified = new Set<ApiElement>();
  for (const ae of apiElements) {
    const link = reifiedOwnership(ae, owningOf);
    if (!link) continue;
    ownerOf.set(link.child, link.owner);
    reified.add(ae);
  }
  // A relationship kept as an element of the model (another tool's alias, say)
  // is owned by its `owningRelatedElement`, as KerML has it, when no reified
  // membership owns it. Sysprose's own export writes that link only on its
  // reified memberships, never on an element of the model (RESERVED_KEYS).
  const kept = new Set<ElementId>();
  for (const ae of apiElements) if (!reified.has(ae)) kept.add(ae['@id']);
  for (const ae of apiElements) {
    const id = ae['@id'];
    const related = ae.owningRelatedElement?.['@id'];
    if (reified.has(ae) || ownerOf.has(id) || !related || related === id || !kept.has(related)) continue;
    ownerOf.set(id, related);
  }

  // Pass 2: build ElementRecords for the model's elements.
  const elements: ElementRecord[] = [];
  const rootIds: ElementId[] = [];
  for (const ae of apiElements) {
    if (reified.has(ae)) continue;
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
