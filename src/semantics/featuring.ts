/**
 * KerML **featuring** and **implicit library specialization** semantics.
 *
 * The OMG SysML v2 abstract syntax says every Usage/Definition implicitly
 * specializes a standard-library base type for its metaclass (a PartUsage is
 * always ultimately a `Parts::Part`, an ActionUsage an `Actions::Action`, an
 * AttributeUsage a `Base::DataValue`, and so on — the "semantic metamodel"
 * mapping). This module resolves those implicit bases against the loaded library
 * and layers them onto the explicit generalization/effective-feature analyses:
 *
 *  - {@link implicitBaseTypesOf} — the standard implicit library base type(s) an
 *    element specializes, from a documented metaclass → library-qualified-name
 *    table, resolved via {@link findLibraryType}.
 *  - {@link generalizationsWithImplicit} — explicit generals (see
 *    {@link generalizationsOf}) PLUS implicit library bases, transitively.
 *  - {@link effectiveFeaturesWithLibrary} — effective features including those
 *    inherited from implicit library bases (library `Feature`/`Step`/`Connector`
 *    children as well as SysML Usages), with redefinition-by-name masking.
 *  - {@link typeIntersectionConforms} — a feature typed by several types conforms
 *    to their intersection iff it conforms to every one.
 *  - {@link featuringTypeOf} — the type that features a feature (its featuring
 *    type; in this metamodel, the owning Type).
 *
 * Traversal is cycle-safe and library-bounded: walking a library base only
 * follows its own explicit specialization edges (a short chain up to
 * `Base::Anything`), so the closure never explodes over the ~38k-element
 * library. Results are memoised per model.
 *
 * Spec references: docs/02-omg-standard-reference.md (implicit specialization /
 * semantic metamodel; featuring; classification & conformance).
 */

import { type ElementId, type ElementRecord, type Model } from '@core/index';
import { findLibraryType } from '@core/index';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- JSDoc @link target
import { generalizationsOf } from './inheritance';
import { conforms } from './conformance';
import { isFeatureMetaclass, isTypeMetaclass } from './metaclasses';

/**
 * Metaclass → standard-library base type (fully-qualified name) it implicitly
 * specializes. Both the Definition and Usage forms of a kind map to the same
 * library base (a PartUsage and a PartDefinition are both, ultimately,
 * `Parts::Part`). Names verified against the bundled full library; entries that
 * fail to resolve at runtime are simply skipped by {@link implicitBaseTypesOf}.
 */
export const IMPLICIT_BASE_TYPE: Readonly<Record<string, string>> = {
  // Occurrences (root of the structural + behavioral towers).
  OccurrenceDefinition: 'Occurrences::Occurrence',
  OccurrenceUsage: 'Occurrences::Occurrence',

  // Items & Parts.
  ItemDefinition: 'Items::Item',
  ItemUsage: 'Items::Item',
  PartDefinition: 'Parts::Part',
  PartUsage: 'Parts::Part',

  // Attributes & Enumerations (value types).
  AttributeDefinition: 'Base::DataValue',
  AttributeUsage: 'Base::DataValue',
  EnumerationDefinition: 'Base::DataValue',
  EnumerationUsage: 'Base::DataValue',

  // Ports.
  PortDefinition: 'Ports::Port',
  PortUsage: 'Ports::Port',

  // Connections, interfaces, flows.
  ConnectionDefinition: 'Connections::Connection',
  ConnectionUsage: 'Connections::Connection',
  BindingConnectorAsUsage: 'Connections::Connection',
  InterfaceDefinition: 'Interfaces::Interface',
  InterfaceUsage: 'Interfaces::Interface',
  FlowDefinition: 'Flows::Flow',
  FlowUsage: 'Flows::Flow',

  // Actions & States.
  ActionDefinition: 'Actions::Action',
  ActionUsage: 'Actions::Action',
  StateDefinition: 'States::StateAction',
  StateUsage: 'States::StateAction',
  ExhibitStateUsage: 'States::StateAction',
  PerformActionUsage: 'Actions::Action',
  TransitionUsage: 'Actions::TransitionAction',
  AcceptActionUsage: 'Actions::AcceptAction',
  SendActionUsage: 'Actions::SendAction',
  AssignmentActionUsage: 'Actions::AssignmentAction',
  IfActionUsage: 'Actions::IfThenAction',
  WhileLoopActionUsage: 'Actions::WhileLoopAction',
  ForLoopActionUsage: 'Actions::ForLoopAction',

  // Calculations & Constraints.
  CalculationDefinition: 'Calculations::Calculation',
  CalculationUsage: 'Calculations::Calculation',
  ConstraintDefinition: 'Constraints::ConstraintCheck',
  ConstraintUsage: 'Constraints::ConstraintCheck',

  // Requirements & Concerns.
  RequirementDefinition: 'Requirements::RequirementCheck',
  RequirementUsage: 'Requirements::RequirementCheck',
  SatisfyRequirementUsage: 'Requirements::RequirementCheck',
  ConcernDefinition: 'Requirements::ConcernCheck',
  ConcernUsage: 'Requirements::ConcernCheck',

  // Cases.
  CaseDefinition: 'Cases::Case',
  CaseUsage: 'Cases::Case',
  AnalysisCaseDefinition: 'AnalysisCases::AnalysisCase',
  AnalysisCaseUsage: 'AnalysisCases::AnalysisCase',
  VerificationCaseDefinition: 'VerificationCases::VerificationCase',
  VerificationCaseUsage: 'VerificationCases::VerificationCase',
  UseCaseDefinition: 'UseCases::UseCase',
  UseCaseUsage: 'UseCases::UseCase',
  IncludeUseCaseUsage: 'UseCases::UseCase',

  // Views, viewpoints, renderings.
  ViewDefinition: 'Views::View',
  ViewUsage: 'Views::View',
  ViewpointDefinition: 'Views::ViewpointCheck',
  ViewpointUsage: 'Views::ViewpointCheck',
  RenderingDefinition: 'Views::Rendering',
  RenderingUsage: 'Views::Rendering',

  // Metadata.
  MetadataDefinition: 'Metadata::MetadataItem',
  MetadataUsage: 'Metadata::MetadataItem',

  // Reference usages resolve to the KerML root classifier.
  ReferenceUsage: 'Base::Anything',
};

/* ─────────────────────────── memoisation caches ─────────────────────────── */

/** Per-model cache keyed by element id, invalidated when the model revision moves. */
type IdCache = Map<ElementId, ElementRecord[]>;
interface RevCache {
  rev: number;
  map: IdCache;
}
const implicitBaseCache = new WeakMap<Model, RevCache>();
const generalsCache = new WeakMap<Model, RevCache>();
const effectiveCache = new WeakMap<Model, RevCache>();

const cacheFor = (store: WeakMap<Model, RevCache>, model: Model): IdCache => {
  let c = store.get(model);
  if (!c || c.rev !== model.rev) {
    // A specialization/typing/reparent change since last use would make the
    // memoised general/effective-feature results stale. Rebuild at current rev.
    c = { rev: model.rev, map: new Map() };
    store.set(model, c);
  }
  return c.map;
};

/**
 * The standard implicit library base type(s) `elementId` specializes, resolved
 * against the loaded standard library. Empty when the element's metaclass has no
 * implicit base (e.g. Package) or the library is not loaded / the base cannot be
 * resolved. A library element never has an implicit base (its bases are all
 * explicit), so this returns `[]` for library content.
 */
export function implicitBaseTypesOf(model: Model, elementId: ElementId): ElementRecord[] {
  const cache = cacheFor(implicitBaseCache, model);
  const hit = cache.get(elementId);
  if (hit) return hit;

  const el = model.get(elementId);
  let result: ElementRecord[] = [];
  if (el && el.attrs.isLibrary !== true) {
    const qname = IMPLICIT_BASE_TYPE[el.eClass];
    if (qname) {
      const base = findLibraryType(model, qname);
      // Guard against an element being its own implicit base (defensive).
      if (base && base.id !== elementId) result = [base];
    }
  }
  cache.set(elementId, result);
  return result;
}

/**
 * All general types of `id` — the transitive closure over BOTH explicit
 * specialization edges (see {@link generalizationsOf}) AND implicit library
 * bases (see {@link implicitBaseTypesOf}).
 *
 * The walk adds, for every reached user (non-library) element, its implicit
 * library base; library elements contribute only their explicit generals, so
 * the closure stays bounded by the library's own (short) specialization chains.
 * `id` itself is not included; each general appears once. Cycle-safe; memoised.
 */
export function generalizationsWithImplicit(model: Model, id: ElementId): ElementRecord[] {
  const cache = cacheFor(generalsCache, model);
  const hit = cache.get(id);
  if (hit) return hit;

  const out: ElementRecord[] = [];
  const seen = new Set<ElementId>([id]);
  const queue: ElementId[] = [id];

  const enqueue = (rec: ElementRecord): void => {
    if (seen.has(rec.id)) return;
    seen.add(rec.id);
    out.push(rec);
    queue.push(rec.id);
  };

  while (queue.length) {
    const cur = queue.shift()!;
    // Explicit generals (specialization family), library-aware.
    for (const general of model.typesOf(cur)) enqueue(general);
    // Implicit library base(s) for the current element's metaclass.
    for (const base of implicitBaseTypesOf(model, cur)) enqueue(base);
  }

  cache.set(id, out);
  return out;
}

/** The features `typeId` owns — SysML Usages and library `Feature`/`Step`/… */
function featureChildren(model: Model, typeId: ElementId): ElementRecord[] {
  return model.children(typeId).filter((c) => isFeatureMetaclass(c.eClass));
}

/**
 * The ids of the features `featureId` redefines, transitively over the
 * {@link Redefinition} chain. A Redefinition is owned by (a child of) the
 * redefining feature with the redefined feature as its `target`, so this uses
 * the (indexed) containment children rather than scanning all relationships,
 * keeping it cheap even over the standard library. Cycle-safe.
 */
function transitiveRedefinedIds(model: Model, featureId: ElementId, out = new Set<ElementId>()): Set<ElementId> {
  for (const child of model.children(featureId)) {
    if (child.eClass !== 'Redefinition') continue;
    for (const t of child.target ?? []) {
      if (out.has(t)) continue;
      out.add(t);
      transitiveRedefinedIds(model, t, out);
    }
  }
  return out;
}

/**
 * The effective feature set of `id`, INCLUDING features inherited from implicit
 * library bases (in addition to explicit generals). Own features come first (in
 * declaration order), then features contributed by each general in
 * {@link generalizationsWithImplicit} order.
 *
 * Redefinition rule (as in {@link effectiveFeatures}): a named feature already
 * claimed by a more-specific type masks any inherited same-named feature.
 * Anonymous features (no `declaredName`, common in the library) are all kept.
 * Cycle-safe; memoised.
 */
export function effectiveFeaturesWithLibrary(model: Model, id: ElementId): ElementRecord[] {
  const cache = cacheFor(effectiveCache, model);
  const hit = cache.get(id);
  if (hit) return hit;

  const result: ElementRecord[] = [];
  const claimedNames = new Set<string>();
  const seenIds = new Set<ElementId>();
  /** Ids explicitly redefined by an already-contributed (more specific) feature. */
  const redefinedIds = new Set<ElementId>();

  const contribute = (feat: ElementRecord): void => {
    if (seenIds.has(feat.id)) return;
    // Masked by an explicit Redefinition from a more-specific feature (honours
    // redefinition chains even across renames / anonymous redefinitions).
    if (redefinedIds.has(feat.id)) return;
    const name = feat.declaredName;
    if (name !== undefined && claimedNames.has(name)) return; // masked by name redefinition
    seenIds.add(feat.id);
    if (name !== undefined) claimedNames.add(name);
    for (const rid of transitiveRedefinedIds(model, feat.id)) redefinedIds.add(rid);
    result.push(feat);
  };

  for (const f of featureChildren(model, id)) contribute(f);
  for (const general of generalizationsWithImplicit(model, id)) {
    for (const f of featureChildren(model, general.id)) contribute(f);
  }

  cache.set(id, result);
  return result;
}

/**
 * True iff the feature `featureId` conforms to the INTERSECTION of `typeIds` —
 * i.e. it conforms to every type in the list (a feature typed by several types
 * is a subtype of each). An empty `typeIds` is vacuously true.
 */
export function typeIntersectionConforms(
  model: Model,
  featureId: ElementId,
  typeIds: readonly ElementId[],
): boolean {
  return typeIds.every((t) => conforms(model, featureId, t));
}

/**
 * The type that features `featureId` — its *featuring type*. In KerML a feature
 * is featured by the type in whose scope it is declared; in this metamodel that
 * is the feature's owning Type (Definition/Usage/classifier). Returns `undefined`
 * for a root feature or when the owner is not a type.
 */
export function featuringTypeOf(model: Model, featureId: ElementId): ElementRecord | undefined {
  const owner = model.owner(featureId);
  if (!owner) return undefined;
  return isTypeMetaclass(owner.eClass) ? owner : undefined;
}

/* ─────────────────────────────── type operators ─────────────────────────── */

/**
 * The reflexive generalization closure of a type: the type itself followed by
 * every general in {@link generalizationsWithImplicit}. Missing ids are skipped.
 */
function closure(model: Model, typeId: ElementId): ElementRecord[] {
  const self = model.get(typeId);
  const out = self ? [self] : [];
  return out.concat(generalizationsWithImplicit(model, typeId));
}

/** Deduplicate a list of records by id, preserving first-seen order. */
function dedupe(records: ElementRecord[]): ElementRecord[] {
  const seen = new Set<ElementId>();
  const out: ElementRecord[] = [];
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * The **union** of the given types, as a generalization set: every type in the
 * reflexive generalization closure of ANY operand. This is the set of types a
 * value classified by the union (`A | B`, KerML {@link Unioning}) may conform
 * to. Order follows the operands' closures; each type appears once.
 */
export function unionOf(model: Model, typeIds: readonly ElementId[]): ElementRecord[] {
  return dedupe(typeIds.flatMap((t) => closure(model, t)));
}

/**
 * The **intersection** of the given types, as a generalization set: the types
 * common to the reflexive generalization closure of EVERY operand — i.e. the
 * common generalizations a value classified by all operands (KerML
 * {@link Intersecting}, `A & B`) is guaranteed to conform to. Empty `typeIds`
 * yields `[]`.
 */
export function intersectionOf(model: Model, typeIds: readonly ElementId[]): ElementRecord[] {
  if (typeIds.length === 0) return [];
  const closures = typeIds.map((t) => new Set(closure(model, t).map((r) => r.id)));
  const [first, ...rest] = closures;
  return closure(model, typeIds[0]).filter(
    (r) => first.has(r.id) && rest.every((s) => s.has(r.id)),
  );
}

/**
 * The **difference** of the first type and the rest, as a generalization set:
 * the types in the first operand's reflexive generalization closure that are in
 * NONE of the other operands' closures (KerML {@link Differencing}, `A - B`).
 * Empty `typeIds` yields `[]`.
 */
export function differenceOf(model: Model, typeIds: readonly ElementId[]): ElementRecord[] {
  if (typeIds.length === 0) return [];
  const [first, ...rest] = typeIds;
  const subtracted = new Set(rest.flatMap((t) => closure(model, t).map((r) => r.id)));
  return closure(model, first).filter((r) => !subtracted.has(r.id));
}

/**
 * Resolve a **feature chain** `a.b.c` given the ordered feature ids `[a, b, c]`:
 * each feature after the first must be an effective feature of (a type of) the
 * preceding feature — the KerML {@link FeatureChaining} well-formedness rule.
 *
 * Returns the resolved records for the longest valid prefix of the chain (the
 * full chain when every link is well-formed, an empty array when the first id is
 * unknown). The terminal record's type(s) give the value type of the chain.
 */
export function featureChain(model: Model, ids: readonly ElementId[]): ElementRecord[] {
  const out: ElementRecord[] = [];
  for (let i = 0; i < ids.length; i++) {
    const rec = model.get(ids[i]);
    if (!rec) break;
    if (i > 0) {
      const prev = ids[i - 1];
      // The type(s) featuring `prev`, i.e. the types `prev` is typed by.
      const prevTypes = model.typesOf(prev);
      const reachable = prevTypes.some((t) =>
        effectiveFeaturesWithLibrary(model, t.id).some((feat) => feat.id === rec.id),
      );
      if (!reachable) break; // broken link — return the valid prefix
    }
    out.push(rec);
  }
  return out;
}

/**
 * The **inverse** of a feature, via a KerML {@link FeatureInverting}
 * relationship (a `FeatureInverting` element relating two features as mutual
 * inverses, e.g. the two ends of an association). The relationship is treated as
 * symmetric: the feature at the *other* endpoint is returned regardless of which
 * end `featureId` occupies. Returns `undefined` when the feature has no inverse.
 */
export function inverseOf(model: Model, featureId: ElementId): ElementRecord | undefined {
  for (const rel of model.edgesOf(featureId)) {
    if (rel.eClass !== 'FeatureInverting') continue;
    const ends = [...(rel.source ?? []), ...(rel.target ?? [])];
    const other = ends.find((id) => id !== featureId);
    if (other) {
      const rec = model.get(other);
      if (rec) return rec;
    }
  }
  return undefined;
}
