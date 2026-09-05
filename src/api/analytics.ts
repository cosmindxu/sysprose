/**
 * Pure analysis functions over a {@link Model}.
 *
 * Every function returns plain, JSON-serialisable data (no class instances, no
 * model references) so results can be rendered in tables, exported as JSON/CSV,
 * or shipped over the REST facade unchanged. These power the analytics surface in
 * plan §6: element counts, model metrics, requirement-satisfaction coverage,
 * traceability matrices, where-used / transitive impact analysis, the orphan
 * inventory, and connectivity checks.
 */

import {
  REQUIREMENT_KINDS,
  type ElementId,
  type ElementRecord,
  type Model,
  isControlNode,
  isDefinition,
  isRelationship,
  isTypingSpecialization,
} from '@core/index';
import {
  checkConstraints,
  checkConstraintsNumeric,
  isNonNormativeStatement,
  runActionFlow,
  runStateMachine,
  simulateStateMachine,
  isSimulatable,
  discoverTriggers as simTriggers,
  solve,
  evaluateMoEs,
  statementKindOf,
  type ConstraintCheck,
  type MeasureResult,
  type SimStep,
  type SimTrace,
} from '../semantics/index';
// `@library/resolve` and NOT the `@library` barrel: the barrel statically
// imports the multi-MB standard-library JSON, and this module is on the app's
// synchronous entry graph (see the note at the top of `src/library/index.ts`).
import { resolveDeclaredTypeName } from '@library/resolve';
import { dimEqual, dimToString } from '@semantics/units';
import { dimensionalFacets, evaluateQuantity } from '@semantics/units-eval';

/** A compact, serialisable reference to an element. */
export interface ElementRef {
  id: string;
  eClass: string;
  declaredName?: string;
  qualifiedName: string;
}

function ref(model: Model, el: ElementRecord): ElementRef {
  return {
    id: el.id,
    eClass: el.eClass,
    declaredName: el.declaredName,
    qualifiedName: model.qualifiedName(el.id),
  };
}

/* ───────────────────────────── Counts & metrics ─────────────────────────── */

/**
 * Is `el` the user's own content — as opposed to context the tool put there?
 *
 * Implicit features (usage-scoped connector endpoints materialized by the
 * feature-chain resolver, `attrs.implicit === true`) — and the elements they own
 * (e.g. their `Redefinition` to the type-owned prototype) — are re-derived
 * internals, not user-authored model content. They are excluded from
 * user-facing counts and metrics so a text-authored IBD does not inflate the
 * element census.
 *
 * Exported because every report in this module owes the reader the same answer.
 * It was applied to the metrics and left off the requirement, traceability and
 * connectivity reports, which is how the app's Requirement-satisfaction button
 * came to call a fully-covered model 7.7% covered: the divisor was the bundled
 * library's requirements. A report that answers "how big / how covered / how
 * connected is MY model" has to agree with every other one about whose model it
 * is, so the predicate is one function rather than a habit.
 */
export const isUserElement = (model: Model, el: ElementRecord): boolean =>
  el.attrs.implicit !== true &&
  // The bundled standard library is not the user's model. It is ~38,700
  // elements, so counting it made an 8-element model report 38,770 — three
  // orders of magnitude wrong for an agent asking how big its model is. The
  // library is still reported, as its own `libraryElements` figure, so its
  // presence is VISIBLE rather than silently folded into every total.
  el.attrs.isLibrary !== true &&
  !(el.ownerId != null && model.get(el.ownerId)?.attrs.implicit === true);

/** True when `el` is a bundled standard-library element. */
const isLibrary = (el: ElementRecord): boolean => el.attrs.isLibrary === true;

/**
 * Does `el` declare a type as TEXT that the graph does not carry as an EDGE?
 *
 * Every report in this module navigates edges (`model.typesOf`,
 * `model.edgesOf`), so a feature whose type exists only as a string on
 * `attrs.type`/`attrs.typeRef` is INVISIBLE to all of them. That is not a rare
 * corner: the library binder materialises a `FeatureTyping` for an
 * AttributeUsage only when the resolved type is a member of `ScalarValues`
 * (`src/library/resolve.ts`), so every attribute typed by an ISQ quantity kind
 * or an SI unit — `attribute mtow : ISQ::MassValue` in the shipped UAV example
 * — keeps its type as a display string and nothing else, and the mapper's
 * unresolved-attribute-type path is silent about it by design.
 *
 * The reports therefore answered "nothing" with `libraryExcluded: 0` beside it,
 * which was affirmatively true (nothing had been dropped from the walk) and
 * useless: a reader could not tell "this attribute has no type" from "this
 * report cannot see its type". Each report counts these under
 * `unresolvedTypings` so the silent zero becomes a figure.
 *
 * WHAT THE COUNT DOES NOT CLAIM. It says the walk could not follow a declared
 * type; it does not say the name is wrong, nor that a type exists to be found.
 * A name that resolves to nothing at all is counted the same way, because the
 * report is equally blind either way — and a dangling one is already reported
 * loudly by validation (`unresolved-type-ref`), which is not this report's job.
 */
function hasUnfollowedTyping(model: Model, el: ElementRecord): boolean {
  return unfollowedTypeNameOf(model, el) !== undefined;
}

/** The type name `el` declares as text and the graph does not carry as an edge. */
function unfollowedTypeNameOf(model: Model, el: ElementRecord): string | undefined {
  const declared = el.attrs.type ?? el.attrs.typeRef;
  if (typeof declared !== 'string' || declared.trim() === '') return undefined;
  return model.typesOf(el.id).length === 0 ? declared.trim() : undefined;
}

/**
 * How many of `ids` declare a type this module's edge walks cannot follow.
 *
 * Takes IDS, and de-duplicates them, because every caller assembles its input
 * from sets that overlap — the two axes of a `Parts × Parts` matrix are the
 * same elements twice — and a figure that double-counts is one the reader
 * cannot check against the rows in front of them.
 *
 * Exported for `scripts/sysprose.ts`, which merges several sub-matrices into one
 * view and must not re-derive this from scratch: the CLI figure and the API
 * figure disagreeing is exactly the failure this counter exists to end.
 */
export function countUnfollowedTypings(model: Model, ids: Iterable<ElementId>): number {
  let n = 0;
  for (const id of new Set(ids)) {
    const el = model.get(id);
    if (el && hasUnfollowedTyping(model, el)) n++;
  }
  return n;
}

/**
 * Every element that names `id` as its type IN TEXT with no edge to show for it.
 *
 * WHY A REPORT ABOUT `id` NEEDS THIS DIRECTION. `whereUsed` and `impactClosure`
 * both answer "what depends on this element", and for the query that matters —
 * a type — the blindness is INCOMING: the three attributes written
 * `attribute … : ISQ::MassValue` in the shipped UAV example carry no
 * `FeatureTyping`, so the edge walk finds nothing and a counter that looked only
 * at what the walk STOOD ON printed 0 exactly where the report is most blind.
 *
 * The name is resolved by the binder's own chain
 * ({@link resolveDeclaredTypeName}) rather than by matching text against
 * `qualifiedName`: the two are not the same string for a member re-exported
 * through a package import (`ISQ::MassValue` is written, `ISQBase::MassValue` is
 * contained), and a report that re-derived its own answer could disagree with
 * the model it is reporting on.
 */
function incomingUnfollowedTypings(model: Model, id: ElementId): ElementId[] {
  const out: ElementId[] = [];
  for (const el of model.all()) {
    if (el.id === id || isLibrary(el)) continue;
    const declared = unfollowedTypeNameOf(model, el);
    if (declared === undefined) continue;
    if (resolveDeclaredTypeName(model, declared, el.ownerId, el.id)?.id === id) out.push(el.id);
  }
  return out;
}

/** Number of elements per metaclass, e.g. `{ PartUsage: 3, Package: 1 }`. */
export function countByMetaclass(model: Model): Record<string, number> {
  const out: Record<string, number> = {};
  for (const el of model.all()) {
    if (!isUserElement(model, el)) continue;
    out[el.eClass] = (out[el.eClass] ?? 0) + 1;
  }
  return out;
}

/** Aggregate model metrics. */
export interface ModelMetrics {
  totalElements: number;
  nodeCount: number;
  relationshipCount: number;
  rootCount: number;
  /** Maximum containment nesting depth (a single root counts as depth 1). */
  maxDepth: number;
  /** Count of diagram-able (non-relationship) elements. */
  diagramableCount: number;
  byMetaclass: Record<string, number>;
  /**
   * Bundled standard-library elements present alongside the user's model.
   *
   * Excluded from every other figure here — they are not the user's content —
   * but reported so the library's presence is visible rather than hidden.
   */
  libraryElements: number;
}

export function modelMetrics(model: Model): ModelMetrics {
  const all = model.all().filter((el) => isUserElement(model, el));
  let nodeCount = 0;
  let relationshipCount = 0;
  let maxDepth = 0;
  for (const el of all) {
    if (isRelationship(el.eClass)) relationshipCount++;
    else nodeCount++;
    const depth = model.ancestors(el.id).length + 1;
    if (depth > maxDepth) maxDepth = depth;
  }
  return {
    totalElements: all.length,
    nodeCount,
    relationshipCount,
    rootCount: model.roots().filter((r) => r.attrs.isLibrary !== true).length,
    maxDepth,
    diagramableCount: nodeCount,
    byMetaclass: countByMetaclass(model),
    libraryElements: model.all().filter((el) => el.attrs.isLibrary === true).length,
  };
}

/* ─────────────────────── Requirement satisfaction ───────────────────────── */

const SATISFY_KINDS = new Set(['Satisfy', 'SatisfyRequirementUsage']);

/** One requirement's satisfaction status. */
export interface RequirementStatus {
  requirement: ElementRef;
  satisfiers: ElementRef[];
  satisfied: boolean;
}

/** Per-requirement satisfaction plus an overall coverage ratio. */
export interface SatisfactionReport {
  requirements: RequirementStatus[];
  total: number;
  satisfied: number;
  /** satisfied / total (0 when there are no requirements). */
  coverage: number;
  /**
   * Bundled standard-library requirements left out of `total`.
   *
   * Reported rather than dropped in silence: the ratio is only meaningful if
   * the reader can see what the divisor is, and on a model bound against the
   * full library the excluded figure dwarfs the model's own requirements.
   */
  libraryExcluded: number;
  /** Implicit (re-derived) requirement copies left out of `total`. */
  implicitExcluded: number;
  /**
   * The user's own requirement-shaped statements left out of `total` because
   * they are not normative — the ones tagged `#prose` or `#prompt`.
   *
   * Nothing is meant to satisfy an explanation, so counting one is the same
   * mistake the bundled library was: a divisor the reader did not agree to.
   * It is reported rather than dropped in silence for the same reason the other
   * two are — a ratio the rows in front of you do not add up to is a number
   * nobody can check.
   */
  nonNormativeExcluded: number;
}

/**
 * For each requirement, the elements that satisfy it (via `Satisfy` edges whose
 * `target` is the requirement and whose `source` is the satisfier), and whether
 * it is covered. Overall `coverage` = satisfied / total.
 *
 * Only the USER's NORMATIVE requirements are counted. Counting the bundled
 * library's made the shipped UAV example — every one of its requirements
 * satisfied — report 2/26 = 7.7% coverage on the app's own
 * Requirement-satisfaction button. A statement tagged `#prose` or `#prompt`
 * is left out for the neighbouring reason: it binds nothing, so nothing
 * satisfies it, and a requirement-shaped explanation would sit in the divisor
 * forever as a gap that can never be closed. Each exclusion is counted under
 * its own name — see {@link SatisfactionReport}.
 */
export function requirementSatisfaction(model: Model): SatisfactionReport {
  const candidates = model.ofKind(...REQUIREMENT_KINDS);
  const own = candidates.filter((r) => isUserElement(model, r));
  // An untagged requirement is normative: `statementKindOf` answers
  // `requirement` from the metaclass, so a model that has never heard of
  // statement kinds counts exactly what it counted before.
  const reqs = own.filter((r) => statementKindOf(model, r.id) === 'requirement');
  const requirements: RequirementStatus[] = reqs.map((r) => {
    const satisfierIds = model
      .edgesTo(r.id)
      .filter((e) => SATISFY_KINDS.has(e.eClass))
      .flatMap((e) => e.source ?? []);
    const seen = new Set<string>();
    const satisfiers: ElementRef[] = [];
    for (const sid of satisfierIds) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      const el = model.get(sid);
      if (el) satisfiers.push(ref(model, el));
    }
    return { requirement: ref(model, r), satisfiers, satisfied: satisfiers.length > 0 };
  });
  const satisfied = requirements.filter((r) => r.satisfied).length;
  return {
    requirements,
    total: requirements.length,
    satisfied,
    coverage: requirements.length === 0 ? 0 : satisfied / requirements.length,
    libraryExcluded: candidates.filter(isLibrary).length,
    implicitExcluded: candidates.filter((r) => !isLibrary(r) && !isUserElement(model, r)).length,
    nonNormativeExcluded: own.length - reqs.length,
  };
}

/* ───────────────────────── Traceability matrix ──────────────────────────── */

/** A 2D traceability matrix between two element kinds over one relationship kind. */
export interface TraceabilityMatrix {
  fromKind: string;
  toKind: string;
  relKind: string;
  rows: ElementRef[];
  columns: ElementRef[];
  /** `cells[i][j]` = true iff a `relKind` edge links rows[i] → columns[j]. */
  cells: boolean[][];
  /** Flattened list of the existing links. */
  links: Array<{ from: string; to: string; relationshipId: string }>;
  /**
   * Bundled standard-library row and column candidates left out of the matrix.
   *
   * A matrix is read by scanning it, so a library row is worse than a wrong
   * number: it is a line the reader has to dismiss by hand, every time. The
   * count says how many were dismissed for them.
   */
  libraryExcluded: number;
  /** Implicit (re-derived) row and column candidates left out of the matrix. */
  implicitExcluded: number;
  /**
   * Row/column candidates whose declared type this matrix cannot follow.
   *
   * See {@link hasUnfollowedTyping}: a feature typed only by a string on
   * `attrs.type` carries no edge, so a `FeatureTyping` matrix shows it as a
   * blank row and no exclusion counter accounts for it. This one does.
   */
  unresolvedTypings: number;
}

/**
 * Build a from×to traceability matrix: rows are elements of `fromKind`, columns
 * are elements of `toKind`, and a cell is set when a `relKind` edge runs from the
 * row element (source) to the column element (target).
 *
 * Rows and columns are the USER's elements. Unfiltered, the shipped UAV example
 * built an 18-row PartUsage axis for the 7 parts it declares, the other 11
 * coming from the bundled library.
 */
export function traceabilityMatrix(
  model: Model,
  fromKind: string,
  toKind: string,
  relKind: string,
): TraceabilityMatrix {
  const rowCandidates = model.ofKind(fromKind);
  const columnCandidates = model.ofKind(toKind);
  const rows = rowCandidates.filter((r) => isUserElement(model, r));
  const columns = columnCandidates.filter((c) => isUserElement(model, c));

  // One pass over the edges instead of a linear scan per cell: the matrix is
  // rows × columns cells and the old `edges.find` inside it made the whole
  // report O(rows·columns·edges) on a model that also carries the library's
  // edges. First edge wins, which is the element order `find` returned.
  //
  // NUL joins the pair because an id is only guaranteed to be a string: a
  // locally parsed model uses `newId()`, but an id can also arrive from an
  // api-json import or the OMG REST client, where it is whatever the server
  // called it. Written as an escape rather than a literal control character so
  // the separator is visible to the next reader — and so the file stays text to
  // the tools that grep it.
  const PAIR = '\u0000';
  const byPair = new Map<string, ElementRecord>();
  for (const e of model.all()) {
    if (e.eClass !== relKind) continue;
    for (const from of e.source ?? []) {
      for (const to of e.target ?? []) {
        const key = `${from}${PAIR}${to}`;
        if (!byPair.has(key)) byPair.set(key, e);
      }
    }
  }

  const links: TraceabilityMatrix['links'] = [];
  const cells = rows.map((r) =>
    columns.map((c) => {
      const edge = byPair.get(`${r.id}${PAIR}${c.id}`);
      if (edge) {
        links.push({ from: r.id, to: c.id, relationshipId: edge.id });
        return true;
      }
      return false;
    }),
  );
  // De-duplicated by id: `fromKind` and `toKind` are often the SAME kind (a
  // parts × parts dependency view, requirements × requirements over `Derive`),
  // and a plain concatenation then counts every candidate twice — reporting 22
  // dismissed library parts on the UAV example, which has 11. An exclusion
  // count exists to be trusted at a glance, so it has to be a count of
  // elements, not of slots.
  const candidates = [
    ...new Map([...rowCandidates, ...columnCandidates].map((e) => [e.id, e])).values(),
  ];
  return {
    fromKind,
    toKind,
    relKind,
    rows: rows.map((r) => ref(model, r)),
    columns: columns.map((c) => ref(model, c)),
    cells,
    links,
    libraryExcluded: candidates.filter(isLibrary).length,
    implicitExcluded: candidates.filter((e) => !isLibrary(e) && !isUserElement(model, e)).length,
    // Counted over the candidates that made it onto an AXIS: a library or
    // implicit candidate is already accounted for by its own counter, and
    // counting it twice would make the three figures uncheckable against each
    // other. `countUnfollowedTypings` de-duplicates, which matters here because
    // a `Parts × Parts` view puts the same elements on both axes.
    unresolvedTypings: countUnfollowedTypings(model, [...rows, ...columns].map((e) => e.id)),
  };
}

/* ─────────────────────────────── Where-used ─────────────────────────────── */

/** A single reference to the queried element. */
export interface UsageRef {
  /** The relationship/edge metaclass doing the referencing. */
  via: string;
  relationshipId: string;
  /** Whether the queried id sits on the `source` or `target` end of the edge. */
  role: 'source' | 'target';
  /** The element(s) at the opposite end(s) of the edge. */
  relatedElements: ElementRef[];
  /** True when `via` is a specialization-family relationship (typing/generalization). */
  isTyping: boolean;
}

/** Impact / where-used report for one element. */
export interface WhereUsedReport {
  element: ElementRef;
  references: UsageRef[];
  /** Distinct elements that reference the queried element (deduplicated). */
  usedBy: ElementRef[];
  /**
   * Declared types this report cannot follow, in BOTH directions: the queried
   * element's own, plus every element that names it as a type in text without
   * an edge to show for it.
   *
   * See {@link incomingUnfollowedTypings}. `references` is built from
   * `model.edgesOf`, so a typing that lives only as a string on `attrs`
   * produces no row here and an empty report reads as "nothing uses it" — a
   * different statement from "this report cannot see what uses it". Asking
   * where `ISQBase::MassValue` is used in the shipped UAV example is the case:
   * three attributes name it (as `ISQ::MassValue`) and none of them is an edge.
   */
  unresolvedTypings: number;
}

/**
 * Find everything that references `id` via typing or any relationship/edge — the
 * basis of impact analysis. For each edge touching `id`, reports the edge kind,
 * the role `id` plays, and the elements at the far end.
 */
export function whereUsed(model: Model, id: string): WhereUsedReport {
  const el = model.get(id);
  const element: ElementRef = el
    ? ref(model, el)
    : { id, eClass: '«unknown»', qualifiedName: '' };
  const references: UsageRef[] = [];
  const usedByMap = new Map<string, ElementRef>();

  for (const e of model.edgesOf(id)) {
    if (e.id === id) continue;
    const onSource = (e.source ?? []).includes(id);
    const role: 'source' | 'target' = onSource ? 'source' : 'target';
    const otherIds = (onSource ? e.target : e.source) ?? [];
    const relatedElements: ElementRef[] = [];
    for (const oid of otherIds) {
      if (oid === id) continue;
      const oe = model.get(oid);
      if (oe) {
        const r = ref(model, oe);
        relatedElements.push(r);
        usedByMap.set(oid, r);
      }
    }
    references.push({
      via: e.eClass,
      relationshipId: e.id,
      role,
      relatedElements,
      isTyping: isTypingSpecialization(e.eClass),
    });
  }
  return {
    element,
    references,
    usedBy: [...usedByMap.values()],
    unresolvedTypings: el
      ? countUnfollowedTypings(model, [el.id, ...incomingUnfollowedTypings(model, el.id)])
      : 0,
  };
}

/* ─────────────────── Impact closure & orphan inventory ──────────────────── */

/** One element reached by an impact closure, with how it was reached. */
export interface ImpactedElement {
  element: ElementRef;
  /** Reference hops from the queried element: 1 means it references it directly. */
  depth: number;
  /**
   * The element one hop nearer the query that this one is attached to.
   *
   * Always the reader's own element (or the query itself): a hop that passed
   * THROUGH one of the tool's implicit copies names the element on the near
   * side of the copy, because an id the reader cannot find in their own file is
   * not provenance.
   */
  from: ElementRef;
  /**
   * Metaclass of the edge that carried the walk here from `from`.
   *
   * Normally the edge of the last hop. When the path crossed one of the tool's
   * implicit copies and went across exactly ONE cable — a
   * {@link CONNECTION_KINDS} edge — it is that cable instead, and `from` names
   * the reader's element on the near side, so the pair reads as "reached from
   * here, across a wire of this kind" rather than as a single edge between the
   * two.
   *
   * The distinction is the whole point of the crossing. A copy is tied to the
   * feature it stands for by a `Redefinition` the tool materialised, so the
   * literal last edge of `port --Redefinition--> copy --ConnectionUsage-->
   * copy --Redefinition--> far port` is a redefinition: reporting that labelled
   * a WIRE crossing with the one edge on the path that is not in the reader's
   * file, and answered "what breaks if I change this port" with the word
   * `Redefinition` about a part on the other end of a cable.
   *
   * Only a cable is lifted, and only one. A crossing that meets no cable — a
   * copy of a copy of one declaration, or a reader's `Dependency` hung off an
   * implicit element — keeps its literal last edge, which is then the truth;
   * lifting "the first edge that is not the copy tie" instead would have put
   * the tool's own `FeatureTyping` on that second case. And a crossing that
   * runs straight through a HUB copy wired by two different connections keeps
   * its literal last edge too, because naming the first cable there says two
   * ports on different wires are wired to each other.
   */
  via: string;
}

/** Transitive where-used: everything a change to one element can reach. */
export interface ImpactReport {
  element: ElementRef;
  /**
   * Hops to the DEEPEST element reported, and 0 when nothing was reached.
   *
   * Neither the depth asked for nor the number of passes made: a closure that
   * closes three hops out reports 3, not the barren fourth pass that found
   * nothing to expand. A report that says "4 hops" about a set whose furthest
   * element is 3 hops away invites a bug report.
   */
  depth: number;
  /** Everything reached, nearest hop first. */
  impacted: ImpactedElement[];
  /**
   * The depth limit stopped the walk with somewhere left to go.
   *
   * It is a lookahead over the final frontier, not `frontier.length > 0`: a
   * last hop that landed on elements with no unvisited neighbours has answered
   * the question completely, and calling that incomplete labelled 45 of the 84
   * truncated results over the shipped UAV example as prefixes of themselves.
   * False therefore means this IS the whole impact. True means one more hop has
   * somewhere to go — not that it would report anything, since it may land on
   * an implicit copy whose only way onward is back where the walk has been.
   */
  truncated: boolean;
  /** Bundled standard-library elements dropped from the frontier. */
  libraryExcluded: number;
  /** Implicit (re-derived) elements walked through but never reported. */
  implicitExcluded: number;
  /**
   * Declared types this closure cannot follow — the elements it STOOD ON, plus
   * the elements that name the queried element as a type in text.
   *
   * See {@link hasUnfollowedTyping} and {@link incomingUnfollowedTypings}.
   * Includes the element asked about, unlike the two exclusion counters — it is
   * the one whose blindness the caller is most likely to mistake for an answer,
   * because a closure that reports nothing about a feature reads as "changing
   * it reaches nothing", and one asked about a TYPE reads the same way while
   * the attributes that name it sit right there in the file.
   */
  unresolvedTypings: number;
}

/**
 * The edge that ties one of the tool's implicit copies to the feature it stands for.
 *
 * `connect a.p to b.q` materialises a usage-scoped copy of each port and links
 * it to the declaration with a `Redefinition`. It is the tool's own
 * bookkeeping, so it is never something a reader can be told they wrote; both
 * places that must know the tie — {@link liftImplicitEndpoint}, which follows
 * it to lift a connection endpoint onto the declared port, and the crossing in
 * {@link impactClosure}, which walks along it — read it from here, so that
 * widening it (to `Subsetting`, say) is one edit and not a hunt for a literal.
 */
const COPY_TIE = 'Redefinition';

/**
 * The metaclasses that are a WIRE: an edge a reader drew between two features.
 *
 * Declared here rather than beside {@link connectivityReport}, its other
 * reader, because the impact closure needs the same list to answer a different
 * question, and two lists would drift: the closure labels a crossing by the
 * cable it went across, and the pin that says no crossing happens on the
 * shipped examples asserts the absence of exactly these kinds. Exported so a
 * test cannot re-guess the set with a substring match — `Connector`,
 * `BindingConnectorAsUsage` and `Allocation` contain none of the words a
 * hand-written `/Connection|Flow|Interface/` looks for, so such a pin passes
 * vacuously on the three kinds it forgot.
 */
export const CONNECTION_KINDS: ReadonlySet<string> = new Set([
  'ConnectionUsage',
  'InterfaceUsage',
  'Connector',
  'BindingConnectorAsUsage',
  'Flow',
  'FlowUsage',
  'SuccessionFlow',
  'Allocation',
]);

/**
 * The far ends of every edge touching `fromId`, with the edge kind that got there.
 *
 * Shared by the walk and by its one-hop lookahead so that "what would the next
 * hop see" is answered by the same code that would take it.
 */
function impactNeighbours(model: Model, fromId: ElementId): Array<{ id: ElementId; via: string }> {
  const out: Array<{ id: ElementId; via: string }> = [];
  for (const usage of whereUsed(model, fromId).references) {
    for (const related of usage.relatedElements) out.push({ id: related.id, via: usage.via });
  }
  return out;
}

/**
 * Everything within `depth` reference hops of `id` — transitive {@link whereUsed}.
 *
 * `whereUsed` answers "what points at this", which is one hop, and one hop is
 * usually the wrong end of the question. On the shipped UAV example the direct
 * users of `AirVehicle` are the part usage `uav` and the two `ReferenceUsage`
 * subjects of the requirements; the requirements THEMSELVES — the things a
 * change has to be re-checked against — are a second hop away, through the
 * `Satisfy` edges. A depth-1 report cannot show them at all.
 *
 * `depth` defaults to 1, which is exactly today's `whereUsed` (as a list of
 * elements rather than of edges), so raising it is opt-in. A depth below 1, or
 * one that is not a finite number at all — `Number.parseInt` on a mistyped
 * `--depth` flag yields `NaN`, and `Math.max(1, NaN)` is `NaN` — is read as 1,
 * because the failure a caller must never get from a bad flag is a confident
 * empty answer. The walk stops early when the frontier empties, so a
 * deliberately large depth is how you ask for the complete closure.
 *
 * Library elements are dropped from the frontier at EVERY hop, with no flag to
 * turn it off, and this is deliberate. `whereUsed` is a lookup: asking what
 * points at one element and being told about a library type is an answer. A
 * closure is a walk, and walking INTO the bundled library does not come back —
 * the library is ~38,700 elements that all reference each other, so one
 * unfiltered hop through `Real` turns "what does my change reach" into the
 * whole standard library. What was dropped is still counted, so the reader can
 * see the walk was pruned rather than wonder. There is deliberately no options
 * parameter to relax it, which a caller that offers a library-inclusion flag
 * has to honour by REFUSING the flag here rather than accepting one that does
 * nothing: unfiltered, the four-hop closure of a single attribute typed by a
 * library type — `usableEnergyFraction` on the shipped UAV example — reaches
 * 3,721 elements instead of none.
 *
 * The tool's own implicit copies are treated differently from the library: they
 * are walked THROUGH — never reported, counted in `implicitExcluded`, and
 * costing the hop they take — rather than dropped. Dropping them was the same
 * trap the connectivity report fell into: `connect a.p to b.q` wires the
 * CONNECTION to usage-scoped copies of the two ports, so a walk that stops at a
 * copy cannot cross a wire at all, and "what breaks if I change this port"
 * answers with the port's own type and nothing on the other end. They are
 * conduits, not destinations, so the walk crosses them and the report stays
 * free of ids the reader cannot find in their file — labelled by the cable, as
 * {@link ImpactedElement.via} describes, and not by the tie at its far end.
 *
 * Three limits worth knowing before reading a result. The walk is UNDIRECTED,
 * because `whereUsed` is: it follows every edge from both ends, so a hop up a
 * typing edge and back down reaches the SIBLINGS of the query — the other ports
 * of the same port definition — which reference it in no direction. And the
 * relationship elements themselves are never destinations: an edge appears as
 * the `via` of the hop it made, so a `ConnectionUsage` or a `Satisfy` is how
 * the walk got somewhere and never a member of `impacted`.
 *
 * The third is what those two do TOGETHER, and it is the one that decides
 * whether this report can answer a wiring question. It depends on the SHAPE of
 * the connection's ends, not on the ports' types. A connection written on the
 * declarations it joins — `connection c connect a to b` inside the `part def`
 * that owns `a` and `b` — binds to those declarations, so the wire is a single
 * hop and always labels the far end, whatever the two ports are typed by. A
 * connection written under a part USAGE, or through a feature chain
 * (`connect engine.fuelOut to fuelIn`), instead binds to usage-scoped COPIES,
 * and then the wire costs three hops: out to the near copy, across, back down
 * to the far declaration. Two ports of the same port definition are two hops
 * apart up and down that definition, so on that shape the undirected typing
 * detour reaches the far port first, the visited set closes it, and the wire
 * never gets to label anything: the report names the far port at depth 2
 * `via: 'FeatureTyping'`, mixed in with every other port of that definition,
 * wired or not.
 *
 * That combination — copied ends, one shared port definition — is not a corner
 * case. It is every connection of both shipped examples, where NO reported
 * element is reached across a wire at any depth, a measurement pinned over
 * `examples/uav-isr.sysml` in `test/integration/uav-example.test.ts` and over
 * `examples/vehicle.sysml` in `test/integration/pipeline.api.test.ts`. The
 * crossing does show in the report when the copies' ports have different port
 * definitions, which `test/unit/api.analytics.test.ts` pins on parsed text in
 * turn. Ask this report what a change REACHES; ask
 * {@link connectivityReport}, which lifts each endpoint to the port it stands
 * for, what is wired to what.
 */
export function impactClosure(model: Model, id: ElementId, depth = 1): ImpactReport {
  const el = model.get(id);
  const element: ElementRef = el
    ? ref(model, el)
    : { id, eClass: '«unknown»', qualifiedName: '' };
  // `Infinity` is a legitimate way to ask for the complete closure and stays
  // itself; only `NaN` — what `Number.parseInt` hands back for a mistyped
  // `--depth` flag, and what `Math.max(1, NaN)` silently propagates — has to be
  // caught, because the answer it produced was an empty report with no error.
  const requested = Math.floor(depth);
  const maxDepth = Number.isNaN(requested) ? 1 : Math.max(1, requested);

  const impacted: ImpactedElement[] = [];
  const seen = new Set<ElementId>([id]);
  // Counted as SETS, not as increments: one library element reached from three
  // different frontier elements is one element the reader cannot see, and a
  // report whose exclusion count exceeds the model's element count is a number
  // nobody can check.
  const libraryDropped = new Set<ElementId>();
  const implicitCrossed = new Set<ElementId>();

  /** A frontier entry, and the nearest REPORTED element on the path to it. */
  interface Step {
    node: ElementRef;
    /** `node` itself, unless the path crossed implicit copies to get here. */
    provenance: ElementRef;
    /**
     * The ONE cable the crossing in progress went across, if there is exactly one.
     *
     * `undefined` on every step that is one of the reader's own elements, on a
     * crossing that has met no wire yet, and on a crossing that has met more
     * than one. Only a {@link CONNECTION_KINDS} edge sets it — a whitelist, not
     * "anything that is not the copy tie", because every other edge incident to
     * a copy is bookkeeping the tool materialised too, and letting one of those
     * label the landing is the same defect one edge family over: a reader's
     * `Dependency` onto an implicit element would be reported as the
     * `FeatureTyping` the tool wrote.
     */
    crossingVia?: string;
    /**
     * Cables this crossing has already gone across.
     *
     * Counted, not flagged, because ONE is the only count that can be named. A
     * hub copy wired by two different connections lets a crossing continue
     * straight through it, and carrying the first cable's label to that landing
     * says "these two ports are wired together" about two ports on different
     * cables — a false statement, where the unlabelled crossing was merely an
     * uninformative one. Past one, the carry is dropped and the landing falls
     * back to the literal last edge.
     */
    cables: number;
  }
  let frontier: Step[] = el ? [{ node: element, provenance: element, cables: 0 }] : [];
  let deepest = 0;
  let hops = 0;
  while (hops < maxDepth && frontier.length > 0) {
    hops++;
    const next: Step[] = [];
    for (const from of frontier) {
      for (const { id: nextId, via } of impactNeighbours(model, from.node.id)) {
        const target = model.get(nextId);
        if (!target) continue;
        if (isLibrary(target)) {
          libraryDropped.add(nextId);
          continue;
        }
        // A model is a graph, not a tree: `a → b → c → a` is a legal
        // dependency ring and every typing edge is walkable from both ends,
        // so the visited set is what makes this terminate at all.
        if (seen.has(nextId)) continue;
        seen.add(nextId);
        const reached = ref(model, target);
        if (!isUserElement(model, target)) {
          implicitCrossed.add(nextId);
          // Exactly one cable is nameable. `??` and not a reassignment because
          // the FIRST cable of a crossing is the one that describes it — a wire
          // between two copies is `Redefinition, ConnectionUsage,
          // Redefinition`, and letting the far tie overwrite it puts the
          // bookkeeping back on the label. `cables === 1` and not a truthy
          // check because a second cable makes the label a lie rather than
          // merely stale, and must silence it rather than pick a winner.
          const cables = from.cables + (CONNECTION_KINDS.has(via) ? 1 : 0);
          next.push({
            node: reached,
            provenance: from.provenance,
            crossingVia: cables === 1 ? (from.crossingVia ?? via) : undefined,
            cables,
          });
          continue;
        }
        impacted.push({
          element: reached,
          depth: hops,
          from: from.provenance,
          via: from.crossingVia ?? via,
        });
        deepest = hops;
        next.push({ node: reached, provenance: reached, cables: 0 });
      }
    }
    frontier = next;
  }

  // Only the depth limit can truncate, and only if a deeper run would REPORT
  // something: the probe looks past the frontier for an unseen element of the
  // reader's own, crossing implicit copies exactly as the walk would, because
  // "the frontier is non-empty" is not the same question and answered it wrong
  // on 45 of the 84 truncated results over the shipped UAV example.
  const reachesMore = (): boolean => {
    const probed = new Set<ElementId>(seen);
    let probe = frontier.map((step) => step.node.id);
    while (probe.length > 0) {
      const onward: ElementId[] = [];
      for (const fromId of probe) {
        for (const { id: nextId } of impactNeighbours(model, fromId)) {
          const target = model.get(nextId);
          if (!target || isLibrary(target) || probed.has(nextId)) continue;
          probed.add(nextId);
          if (isUserElement(model, target)) return true;
          onward.push(nextId);
        }
      }
      probe = onward;
    }
    return false;
  };
  const truncated = hops === maxDepth && frontier.length > 0 && reachesMore();

  return {
    element,
    depth: deepest,
    impacted,
    truncated,
    libraryExcluded: libraryDropped.size,
    implicitExcluded: implicitCrossed.size,
    // `seen` is every element the walk stood on: the query, the impacted
    // elements, and the re-derived copies it crossed on the way (it is marked
    // BEFORE the user-element test, so those are in). Library elements never
    // enter it — they are dropped at the frontier — which is the right axis: a
    // library type the walk declined to follow is already the
    // `libraryExcluded` story.
    unresolvedTypings: countUnfollowedTypings(model, [
      ...seen,
      ...incomingUnfollowedTypings(model, id),
    ]),
  };
}

/* ────────────────────── The guidance that applies here ─────────────────── */

/**
 * The last hop that reached the element a prompt hangs on.
 *
 * `self` is the element asked about; `type` is a typing or specialization edge
 * (`Model.typesOf`); `owner` is containment. A prompt two hops out is labelled
 * by the LAST hop only — guidance on the package that owns a part's definition
 * is reached `owner` at distance 2 — because a caller reading a list wants to
 * know what the guidance is attached to, and the whole path is recoverable from
 * {@link ApplicablePrompt.attachedTo} if they need it.
 */
export type PromptRelation = 'self' | 'owner' | 'type';

/** One prompt that applies to an element, and where it came from. */
export interface ApplicablePrompt {
  /** The element carrying the `prompt` statement kind. */
  prompt: ElementRef;
  /**
   * Its guidance, as text: the body of the first documentation or comment
   * child that has one and is addressed to the prompt itself, else the
   * prompt's own `text` attribute, else the empty string.
   *
   * Carried here rather than left for the caller to fetch, because every
   * caller of this function wants the words and there is no shared accessor
   * for them in the tree — the same three-line walk is hand-rolled in the
   * properties panel and the grid builder, and a fourth copy in a CLI would be
   * a fourth chance to read a different channel.
   */
  text: string;
  /** The element the prompt hangs on: the query, an owner, or a type. */
  attachedTo: ElementRef;
  /** How `attachedTo` was reached — see {@link PromptRelation}. */
  via: PromptRelation;
  /** Hops from the element asked about to `attachedTo`; 0 means "written on it". */
  distance: number;
}

/** What guidance applies to one element. */
export interface PromptReport {
  /** The element asked about. */
  element: ElementRef;
  /** Every prompt that applies, nearest first. */
  prompts: ApplicablePrompt[];
  /** Bundled standard-library elements dropped from the walk. */
  libraryExcluded: number;
  /**
   * Elements the tool re-derived — implicit copies and what they own — walked
   * through but never reported.
   */
  implicitExcluded: number;
  /**
   * Elements the walk STOOD ON whose declared type it could not follow.
   *
   * See {@link hasUnfollowedTyping}. Guidance reaches an element through what
   * it IS as well as where it sits, so a type the walk cannot follow is a whole
   * path of guidance this report silently did not look down.
   */
  unresolvedTypings: number;
}

/**
 * Whether an annotating child is addressed to the element that owns it.
 *
 * A `doc`, and a bare `comment`, annotate their owner: there is nothing else
 * they could be about. But `comment about Engine /* … *\/` written inside a
 * prompt is about Engine — the author aimed it somewhere else, and since the
 * previous commit the target survives the round-trip in `attrs.about` instead
 * of being silently dropped. Reading it as the prompt's own words would hand an
 * agent documentation written about a DIFFERENT element as the instruction
 * addressed to it, which is the one failure this whole text field exists to
 * prevent. Names, not ids: `about` holds raw qualified names, so a comment that
 * names its own owner (legal, and redundant) is matched on the last segment.
 */
function annotatesOwner(el: ElementRecord, child: ElementRecord): boolean {
  const about = child.attrs.about;
  if (!Array.isArray(about) || about.length === 0) return true;
  const names = new Set([el.declaredName, el.declaredShortName].filter((n) => n !== undefined));
  return about.some((t) => typeof t === 'string' && names.has(t.split('::').pop()?.trim() ?? ''));
}

/**
 * The guidance text a prompt carries, from whichever channel it is written in.
 *
 * An author can write those words in three disjoint places in this tool and no
 * two writers agree: a `doc` under most elements becomes a `Documentation`
 * child with a `body`, a `doc` under a REQUIREMENT is folded into that
 * element's own `text` attribute instead, and a free-standing comment keeps its
 * words in `body`. A reader that knew only one of them would silently report a
 * prompt with no words, which is worse than reporting no prompt: the caller
 * would act as though nothing had been asked of it. The last read — the
 * prompt's own `body` — is a defence for models built through the API rather
 * than parsed, where an element that is not a `Comment` can still be given one;
 * no authored text produces it (`map-to-model.ts` writes `body` only on
 * `Comment` and `TextualRepresentation`, neither of which can carry `#prompt`).
 */
function promptText(model: Model, el: ElementRecord): string {
  for (const child of model.children(el.id)) {
    if (child.eClass === 'Documentation' || child.eClass === 'Comment') {
      if (!annotatesOwner(el, child)) continue;
      const body = child.attrs.body;
      if (typeof body === 'string' && body !== '') return body;
    }
  }
  const text = el.attrs.text;
  if (typeof text === 'string' && text !== '') return text;
  const body = el.attrs.body;
  return typeof body === 'string' ? body : '';
}

/**
 * Every prompt that applies to `id` — guidance written for an agent working on
 * this element — nearest first, each with where it came from.
 *
 * A `prompt` is a statement kind (`@semantics/statement-kind`): an element
 * tagged `#prompt`, whose words are guidance addressed to a machine reader
 * rather than a rule that binds or an explanation for a person. The point of
 * making it findable is REUSE. Guidance written once on a port definition —
 * "check the fuel line before changing this port" — is guidance about every
 * port of that type, and an agent that has just been handed one port should not
 * have to know that somebody wrote it up one level. So the question this
 * answers is not "what is attached to this element" but "what governs it".
 *
 * WHAT COUNTS AS APPLYING. Three sources, and they are the three ways one
 * element is ABOUT another here: the element itself (a prompt written on it, or
 * one written inside it), its types (what it IS), and its owners (where it
 * sits). The walk takes both edges from every scope it reaches, transitively,
 * so a supertype's guidance reaches a derived part, and a package's guidance
 * reaches everything in it. Prompts are collected from a scope and from the
 * scope's DIRECT children only: guidance nested two levels down was written
 * about the thing that owns it, and hoovering up a subtree would make every
 * package-level query return the whole file.
 *
 * That uniform walk has one consequence worth stating out loud rather than
 * discovering: it also reaches the OWNERS OF TYPES. A part typed by a
 * definition that lives in another package inherits that package's guidance.
 * That is the rule taken to its conclusion — you used a definition from there,
 * so what that package says about its contents is addressed to you — and it is
 * the reason the walk is one rule and not two. It also means `via: 'owner'` is
 * not by itself the element's own owner chain: the owner of a type wears the
 * same label. A caller that wants only its own containment chain has to
 * intersect `attachedTo` with `model.ancestors(id)`; `via` and `distance` will
 * not separate them.
 *
 * ORDER. Nearest first, by hop count, and at equal distance a type comes before
 * an owner: a type says what the element IS, an owner only says where it sits,
 * so of two statements the same distance away the type's is the more specific.
 * That holds at EVERY distance, not just the first hop: each frontier is sorted
 * before it is walked, so the type of an owner outranks the owner of a type two
 * hops out as well. Each prompt is reported ONCE, at the nearest place it was
 * found — and, at equal distance, along the preferred edge, since the sort runs
 * before the collecting — so a caller can read down the list and stop.
 *
 * THE SAME RULES {@link impactClosure} FOLLOWS, for the same reasons. Bundled
 * library elements are dropped at every hop, with no flag to turn it off: the
 * library is ~38,700 elements that all reference each other, and one unfiltered
 * hop through a library type turns "what guidance applies to my part" into a
 * walk of the whole standard library. What was dropped is counted so the reader
 * can see the walk was pruned. The tool's own implicit copies are treated the
 * other way — walked THROUGH, counted, never reported — because `connect a.p to
 * b.q` materialises a usage-scoped copy of each port tied to the declaration by
 * a `Redefinition`, and a walk that stopped at the copy could not reach the port
 * definition where the guidance was written. They are conduits, not
 * destinations. Neither counter includes the element asked about: that is the
 * question, not an exclusion.
 *
 * A model is a graph, not a tree — `part def A :> B` and `part def B :> A` is
 * illegal and parses anyway — so a visited set, not the shape of the data, is
 * what makes this terminate.
 *
 * Pure: reading a model never writes to it.
 */
export function promptsFor(model: Model, id: ElementId): PromptReport {
  const el = model.get(id);
  const element: ElementRef = el
    ? ref(model, el)
    : { id, eClass: '«unknown»', qualifiedName: '' };

  /** An element the guidance may hang on, and how the walk got to it. */
  interface Scope {
    el: ElementRecord;
    via: PromptRelation;
    distance: number;
  }

  const prompts: ApplicablePrompt[] = [];
  const visited = new Set<ElementId>(el ? [id] : []);
  // Nearest wins: a prompt reached as a child of a near scope is not reported
  // again when the walk meets it as a scope of its own further out.
  const reported = new Set<ElementId>();
  // Counted as SETS, not as increments, for the reason `impactClosure` gives:
  // an exclusion count larger than the model is a number nobody can check.
  const libraryDropped = new Set<ElementId>();
  const implicitCrossed = new Set<ElementId>();

  let frontier: Scope[] = el ? [{ el, via: 'self', distance: 0 }] : [];
  while (frontier.length > 0) {
    // Every step out of this whole level, gathered before any of it is taken,
    // so that "a type before an owner" can be decided across the level rather
    // than inside one scope's own two edges (see ORDER above). Deciding it per
    // scope orders the first hop right and then loses the rule: at distance two
    // the level is the concatenation of each scope's steps, so the owner of a
    // type — queued by whichever scope the walk reached first — would come out
    // ahead of the type of an owner, and would also be the one that claims the
    // element if both lead to the same place.
    const candidates: Scope[] = [];
    for (const scope of frontier) {
      const attachedTo = ref(model, scope.el);
      for (const candidate of [scope.el, ...model.children(scope.el.id)]) {
        if (reported.has(candidate.id)) continue;
        // The library and implicit filters apply to the PROMPT as well as to
        // the walk, so a library prompt reached from the element asked about —
        // the one scope the walk does not filter — is still never reported.
        if (!isUserElement(model, candidate)) continue;
        if (statementKindOf(model, candidate.id) !== 'prompt') continue;
        reported.add(candidate.id);
        prompts.push({
          prompt: ref(model, candidate),
          text: promptText(model, candidate),
          attachedTo,
          via: scope.via,
          distance: scope.distance,
        });
      }

      const owner = scope.el.ownerId != null ? model.get(scope.el.ownerId) : undefined;
      candidates.push(
        ...model
          .typesOf(scope.el.id)
          .map((t) => ({ el: t, via: 'type' as const, distance: scope.distance + 1 })),
        ...(owner ? [{ el: owner, via: 'owner' as const, distance: scope.distance + 1 }] : []),
      );
    }

    // Stable, so the order the model holds things in still decides ties within
    // each group; it only moves types ahead of owners.
    candidates.sort((a, b) => (a.via === 'type' ? 0 : 1) - (b.via === 'type' ? 0 : 1));

    const next: Scope[] = [];
    for (const step of candidates) {
      if (visited.has(step.el.id)) continue;
      if (isLibrary(step.el)) {
        libraryDropped.add(step.el.id);
        continue;
      }
      visited.add(step.el.id);
      if (!isUserElement(model, step.el)) implicitCrossed.add(step.el.id);
      next.push(step);
    }
    frontier = next;
  }

  return {
    element,
    prompts,
    libraryExcluded: libraryDropped.size,
    implicitExcluded: implicitCrossed.size,
    // Same axis as `impactClosure`: every scope the walk stood on, the element
    // asked about included.
    unresolvedTypings: countUnfollowedTypings(model, visited),
  };
}

/**
 * Namespace metaclasses: containers, not modelled things.
 *
 * They are `Definition`s to the metamodel, but "declared and never used" is not
 * a judgement that means anything about a container — a package is where the
 * model lives, not a thing the model uses. Nor would the rule pick out anything
 * useful if it were applied: `import` makes a package an endpoint like any
 * other (a `NamespaceImport` targets the package it imports and is sourced on
 * the one importing), so of the packages in a model loaded with the bundled
 * library, the only one with no edge at all is typically the reader's own root
 * package — which would head every report with a finding that is never a
 * finding.
 */
const NAMESPACE_KINDS = new Set(['Package', 'LibraryPackage']);

/** Definitions that are declared and then never used. */
export interface OrphanReport {
  /**
   * Definitions with no edge, in either direction, to anything in the reader's
   * own model.
   */
  orphans: ElementRef[];
  /** Definitions examined — the population `orphans` is a subset of. */
  definitionsExamined: number;
  /** Namespace packages skipped (see {@link NAMESPACE_KINDS}). */
  packagesSkipped: number;
  /** Bundled standard-library definitions skipped. */
  libraryExcluded: number;
  /** Implicit (re-derived) definitions skipped. */
  implicitExcluded: number;
}

/**
 * Definitions nothing uses: declared, complete, and connected to nothing.
 *
 * This is an INVENTORY, not a gate. Two validation rules already fail a check
 * over broken references — `dangling-endpoint` (an error: a relationship whose
 * endpoint id is not in the model) and `orphan-relationship` (a warning: a
 * relationship element with no owner) — and both are about relationships that
 * are wrong. Nothing here is wrong: a `part def` that no `part` instantiates
 * parses, binds and validates clean, and may be a library-in-progress, a
 * deliberate spare, or the leftover of a rename. So it is reported where a
 * reader asks for it and never as a diagnostic.
 *
 * The reading is "a DEFINITION with no edge, either way, to anything else in
 * the reader's model", and the narrowing is the whole value of the report. The naive reading — any element
 * with no edges — is true of 67 of the 113 elements of the shipped UAV example,
 * because attributes, documentation and untyped parts legitimately have none;
 * a finding that fires on 59% of a clean model is not a finding. The narrow one
 * returns exactly `FlyMission` and `FlightModes` there, and `Drive` and
 * `VehicleStates` on the vehicle example: in both files, the behaviour the
 * author wrote out and never performed.
 *
 * "Used" means used HERE. An edge whose far end is a bundled library element,
 * or one of the tool's own implicit copies, is not the reader using anything —
 * counting it would let a definition be kept off this list by content the
 * reader cannot see, and would make this report disagree with every other one
 * in the module about whose model it is.
 *
 * What it therefore CANNOT see, all for the same reason — the rule is
 * deliberately conservative in BOTH directions, and an edge of any kind is
 * enough to keep a definition off the list:
 *
 * - a definition that specialises something and that nothing instantiates:
 *   `part def DeadSubclass :> Base` carries a `Subclassification`, so it counts
 *   as used, by whatever reads the specialisation;
 * - a definition used only through a feature chain the resolver did not
 *   materialise;
 * - dead content that is not a definition — an unreferenced attribute of a live
 *   part is invisible here, which is the price of not reporting 67 things.
 */
export function orphanReport(model: Model): OrphanReport {
  const orphans: ElementRef[] = [];
  let definitionsExamined = 0;
  let packagesSkipped = 0;
  let libraryExcluded = 0;
  let implicitExcluded = 0;

  for (const el of model.all()) {
    if (!isDefinition(el.eClass)) continue;
    // Ordered so each candidate is counted under exactly one heading: the
    // library's packages are the library's, not the reader's skipped namespaces.
    if (isLibrary(el)) {
      libraryExcluded++;
      continue;
    }
    if (!isUserElement(model, el)) {
      implicitExcluded++;
      continue;
    }
    if (NAMESPACE_KINDS.has(el.eClass)) {
      packagesSkipped++;
      continue;
    }
    definitionsExamined++;
    // One predicate over both directions and both ends: a definition that is
    // typed by nothing but specialises something IS used, and an edge that only
    // reaches the library or an implicit copy is NOT the reader using it. The
    // far end is what decides, because `edgesOf(...).length` counts an edge the
    // reader did not write as if they had.
    const usedHere = model.edgesOf(el.id).some((edge) =>
      [...(edge.source ?? []), ...(edge.target ?? [])].some((otherId) => {
        if (otherId === el.id) return false;
        const other = model.get(otherId);
        return other != null && isUserElement(model, other);
      }),
    );
    if (!usedHere) orphans.push(ref(model, el));
  }

  return { orphans, definitionsExamined, packagesSkipped, libraryExcluded, implicitExcluded };
}

/* ───────────────────────── Connectivity report ──────────────────────────── */

/** One declared port as it occurs under one part usage. */
export interface PortOccurrence {
  /** The part usage the port occurs under. */
  part: ElementRef;
  /** The port, as declared on that part's type (or on the part itself). */
  port: ElementRef;
}

/** Ports, connections, and which ports are left unconnected. */
export interface ConnectivityReport {
  portCount: number;
  connectionCount: number;
  connectedPortCount: number;
  /**
   * Declared ports that NO usage of them is wired to anything.
   *
   * Read it at the granularity it is: a port declared on a `part def` used
   * three times is one entry here, and it stays off this list as soon as any
   * one of the three is connected. The per-usage question — "which end is
   * dangling in THIS part?" — is {@link unconnectedPortUsages}.
   */
  unconnectedPorts: ElementRef[];
  /**
   * Every (part usage, declared port) pair with nothing wired to it.
   *
   * `unconnectedPorts` cannot answer this on its own: when one `part def` is
   * used twice, connecting one usage's port marks the DECLARATION connected,
   * so a genuinely dangling end in the other usage disappears from a report
   * whose whole job is to surface it. Ports occur per usage, so the dangling
   * ends are reported per usage too.
   *
   * Occurrences come from each part usage's types (and their supertypes), plus
   * any port the part usage declares itself. A port on a definition that is
   * never used has no occurrence and appears only in `unconnectedPorts`.
   */
  unconnectedPortUsages: PortOccurrence[];
  connections: Array<{
    connection: ElementRef;
    /**
     * The endpoint ids exactly as the model records them — usage-scoped copies
     * included. Two usages of one definition have DISTINCT endpoints here;
     * `sourcePorts`/`targetPorts` is where they become the same declared port.
     */
    source: string[];
    /** As recorded, like `source`. */
    target: string[];
    /** `source` lifted onto the declared ports counted by `portCount`. */
    sourcePorts: string[];
    /** `target` lifted onto the declared ports counted by `portCount`. */
    targetPorts: string[];
  }>;
  /** Bundled standard-library ports and connections left out of the counts. */
  libraryExcluded: number;
  /**
   * Implicit usage-scoped port copies left out of `portCount`: they are
   * duplicates of a declared port, not ports of their own.
   */
  implicitExcluded: number;
  /**
   * Connection endpoints that named such a copy and were resolved back to the
   * feature it redefines.
   *
   * Reported because it is the difference between "this model has 14 connected
   * ports" and "this report quietly rewrote 18 endpoint references to get
   * there" — and because a model with implicit copies but zero resolved
   * endpoints is the signature of the lift having stopped working.
   *
   * "Feature", not "port": the lift runs on every endpoint of every connection
   * kind, and an `Allocation` or `Flow` end can be a part, an item or an
   * attribute.
   */
  implicitResolved: number;
}

/**
 * The declared feature an implicit connector endpoint stands for, or `id` itself.
 *
 * `connect a.p to b.p` materialises a usage-scoped copy of each port under the
 * PART and wires the connection to the copies, each carrying a `Redefinition`
 * to the port declared on the part's type. The chain is followed to its end
 * (a nested feature chain makes a copy of a copy) and guarded against a cycle.
 *
 * It is a FEATURE, not necessarily a port: `Allocation` and `Flow` ends can be
 * parts, items or attributes, and they are lifted by the same rule.
 *
 * The lift is a mapping, not a replacement. Two usages of one part definition
 * lift onto the SAME declared port, so substituting the lifted id for the raw
 * one would turn `connect a.p to b.p` into a self-edge on `T::p` — the
 * definition-edge collapse the endpoint materialisation exists to prevent.
 * Callers keep both ends of the mapping.
 */
function liftImplicitEndpoint(model: Model, id: ElementId): ElementId {
  const seen = new Set<ElementId>([id]);
  let current = id;
  for (;;) {
    const el = model.get(current);
    if (!el || el.attrs.implicit !== true) return current;
    const redefined = model
      .edgesOf(current)
      .find((e) => e.eClass === COPY_TIE && (e.source ?? []).includes(current))
      ?.target?.[0];
    if (redefined == null || seen.has(redefined) || !model.get(redefined)) return current;
    seen.add(redefined);
    current = redefined;
  }
}

/**
 * Every (part usage, declared port) pair in the user's model.
 *
 * A port is declared once and OCCURS once per usage of the thing that declares
 * it. `part def Node { in port a; out port b; }` with two `Node` parts has two
 * ports and four ends, and only the ends can be dangling — which is why the
 * connectivity report cannot answer "what is unwired?" from the declarations
 * alone.
 *
 * Occurrences are collected from the part usage's types and their supertypes
 * (a `part def` that specialises another inherits its ports), cycle-guarded,
 * plus any port the part usage declares itself. Library ports are skipped by
 * the same predicate as everywhere else, so walking into the implicit library
 * supertypes every `part def` gets costs a traversal, not rows.
 */
function portOccurrences(model: Model): Array<{ part: ElementRecord; port: ElementRecord }> {
  const out: Array<{ part: ElementRecord; port: ElementRecord }> = [];
  for (const part of model.ofKind('PartUsage')) {
    if (!isUserElement(model, part)) continue;
    const seenPorts = new Set<ElementId>();
    const collect = (ownerId: ElementId): void => {
      for (const child of model.children(ownerId)) {
        if (child.eClass !== 'PortUsage' || !isUserElement(model, child)) continue;
        if (seenPorts.has(child.id)) continue;
        seenPorts.add(child.id);
        out.push({ part, port: child });
      }
    };
    collect(part.id);
    const seenTypes = new Set<ElementId>([part.id]);
    const queue = model.typesOf(part.id);
    while (queue.length > 0) {
      const type = queue.shift()!;
      if (seenTypes.has(type.id)) continue;
      seenTypes.add(type.id);
      collect(type.id);
      queue.push(...model.typesOf(type.id));
    }
  }
  return out;
}

/**
 * Inventory of ports (PortUsage) and connection-like edges, flagging ports not
 * referenced by any connection endpoint as unconnected.
 *
 * Counts the USER's ports, and resolves every endpoint onto them. The filter
 * alone is not enough and is worse than nothing: on the shipped UAV example the
 * 9 connections reference only implicit copies, so dropping the copies from the
 * port list — without lifting the endpoints that name them — turns "37 ports,
 * 23 unconnected" into "15 ports, 15 unconnected", which is a new wrong answer
 * and a more believable one. With the lift it is 15 ports, 14 connected, and
 * the one genuinely dangling port is the finding worth reading.
 *
 * Each connection carries BOTH forms of its endpoints: `source`/`target` as the
 * model records them, and `sourcePorts`/`targetPorts` lifted onto the ports the
 * inventory counts. Reporting only the lifted form would make `connect a.p to
 * b.p` between two usages of one definition read as a self-edge on the
 * definition's port; reporting only the raw form leaves ids in the list that
 * are absent from the inventory, which is unusable to a caller joining the two.
 */
export function connectivityReport(model: Model): ConnectivityReport {
  const portCandidates = model.ofKind('PortUsage');
  const ports = portCandidates.filter((p) => isUserElement(model, p));
  const connectionCandidates = model
    .all()
    .filter(
      (e) => CONNECTION_KINDS.has(e.eClass) && ((e.source?.length ?? 0) + (e.target?.length ?? 0) > 0),
    );
  const connections = connectionCandidates.filter((c) => isUserElement(model, c));

  const connectedPortIds = new Set<string>();
  // Which OCCURRENCE each endpoint wires up, keyed `<part usage> NUL <declared
  // port>`: the lifted id alone cannot say which of a definition's usages the
  // endpoint belonged to, and that is exactly what a dangling end is.
  const OCC = '\u0000';
  const wiredOccurrences = new Set<string>();
  let implicitResolved = 0;
  const lift = (ids: readonly ElementId[]): ElementId[] =>
    ids.map((id) => {
      const lifted = liftImplicitEndpoint(model, id);
      if (lifted !== id) implicitResolved++;
      connectedPortIds.add(lifted);
      const owner = model.get(id)?.ownerId;
      if (owner != null) wiredOccurrences.add(`${owner}${OCC}${lifted}`);
      return lifted;
    });
  const endpoints = connections.map((c) => {
    const source = [...(c.source ?? [])];
    const target = [...(c.target ?? [])];
    return {
      connection: ref(model, c),
      source,
      target,
      sourcePorts: lift(source),
      targetPorts: lift(target),
    };
  });

  const unconnectedPorts = ports
    .filter((p) => !connectedPortIds.has(p.id))
    .map((p) => ref(model, p));
  const unconnectedPortUsages = portOccurrences(model)
    .filter((o) => !wiredOccurrences.has(`${o.part.id}${OCC}${o.port.id}`))
    .map((o) => ({ part: ref(model, o.part), port: ref(model, o.port) }));

  const candidates = [...portCandidates, ...connectionCandidates];
  return {
    portCount: ports.length,
    connectionCount: connections.length,
    connectedPortCount: ports.filter((p) => connectedPortIds.has(p.id)).length,
    unconnectedPorts,
    unconnectedPortUsages,
    connections: endpoints,
    libraryExcluded: candidates.filter(isLibrary).length,
    implicitExcluded: candidates.filter((e) => !isLibrary(e) && !isUserElement(model, e)).length,
    implicitResolved,
  };
}

/* ───────────────────────── Constraint report ────────────────────────────── */

/** One evaluated constraint/requirement, plus a navigable element reference. */
export interface ConstraintReportEntry extends ConstraintCheck {
  element: ElementRef;
}

/** Summary of constraint/requirement satisfaction across the model. */
export interface ConstraintReport {
  total: number;
  satisfied: number;
  violated: number;
  unknown: number;
  constraints: ConstraintReportEntry[];
}

/**
 * Evaluate every ConstraintUsage / RequirementUsage carrying a boolean
 * expression (via the semantics engine) and summarise the satisfied / violated
 * / unknown counts, alongside per-constraint detail with a navigable element
 * reference. JSON-serialisable for the REST facade and UI.
 */
export function constraintReport(model: Model): ConstraintReport {
  // Library elements are not the user's, and a statement the author tagged
  // `#prose` / `#prompt` binds nothing, so it has no verdict to report. The
  // second filter is not cosmetic: `runConstraintCheck` DROPS the validator's
  // own `constraint-violation` rows and re-lists this report in their place, so
  // without it the very rows the rule now suppresses came back into the same
  // Problems panel by the other door.
  const checks = checkConstraints(model).filter((c) => {
    const el = model.get(c.id);
    return el?.attrs.isLibrary !== true && !isNonNormativeStatement(model, c.id);
  });
  let satisfied = 0;
  let violated = 0;
  let unknown = 0;
  const constraints: ConstraintReportEntry[] = [];
  for (const c of checks) {
    if (c.result === 'satisfied') satisfied++;
    else if (c.result === 'violated') violated++;
    else unknown++;
    const el = model.get(c.id);
    constraints.push({
      ...c,
      element: el
        ? ref(model, el)
        : { id: c.id, eClass: '«unknown»', qualifiedName: '' },
    });
  }
  return { total: checks.length, satisfied, violated, unknown, constraints };
}

/* ─────────────────────────── Dimensional analysis ───────────────────────── */

/** Dimensional analysis of one quantity-valued feature. */
export interface UnitFeatureAnalysis {
  element: ElementRef;
  /** Numeric magnitude, or `null` when the feature has no evaluable value. */
  value: number | null;
  /** The unit the magnitude is expressed in, or `null` when none is set. */
  unit: string | null;
  /** Human-readable physical dimension (e.g. `M`, `L·T⁻¹`), or `null`. */
  dimension: string | null;
  /** The ISQ quantity kind the feature is typed by, or `null`. */
  quantityKind: string | null;
  /** False when the value's unit dimension conflicts with the quantity kind's. */
  consistent: boolean;
}

/** Model-wide dimensional-analysis report over quantity-valued features. */
export interface UnitReport {
  features: UnitFeatureAnalysis[];
  total: number;
  consistent: number;
  inconsistent: number;
}

/**
 * Analyse every quantity-valued feature (one carrying a unit and/or typed by an
 * ISQ quantity kind): its magnitude, unit, physical dimension, quantity kind,
 * and whether the value's unit dimension is consistent with the quantity kind.
 * Library content is excluded. JSON-serialisable for the REST facade and UI.
 */
export function unitReport(model: Model): UnitReport {
  const features: UnitFeatureAnalysis[] = [];
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    const facets = dimensionalFacets(model, el.id);
    // Only quantity-valued features: those carrying a unit or an ISQ kind.
    if (!facets.unit && !facets.kindDimension) continue;
    const q = evaluateQuantity(model, el.id);
    const consistent =
      !facets.unitDimension || !facets.kindDimension
        ? true
        : dimEqual(facets.unitDimension, facets.kindDimension);
    const dimension = q
      ? dimToString(q.dimension)
      : facets.kindDimension
        ? dimToString(facets.kindDimension)
        : null;
    features.push({
      element: ref(model, el),
      value: q ? q.magnitude : null,
      unit: facets.unit ?? null,
      dimension,
      quantityKind: facets.kindName ?? null,
      consistent,
    });
  }
  const inconsistent = features.filter((f) => !f.consistent).length;
  return {
    features,
    total: features.length,
    consistent: features.length - inconsistent,
    inconsistent,
  };
}

/* ───────────────────────────── Analysis report ──────────────────────────── */

/** One solved feature value, with a navigable element reference. */
export interface SolvedValue {
  element: ElementRef;
  value: number;
}

/**
 * Numeric-analysis report over the whole model: the solved parametric values,
 * the evaluated measures of effectiveness, and the solver's convergence. Plain
 * and JSON-serialisable for the REST facade and UI (`GET /analytics/analysis`
 * and the parametric "Solve" affordance).
 */
/** A numerically-violated equality/inequality constraint, with a navigable ref. */
export interface AnalysisViolation {
  element: ElementRef;
  /** The shape of the violated relation (see `NumericConstraintResult.kind`). */
  kind: 'equality' | 'inequality' | 'boolean';
  /** The source text of the relation. */
  expression: string;
  /**
   * The amount by which the constraint is violated — 0 for a STRICT ordering
   * violated exactly at its boundary (`mass < 25.0` at 25 kg), where the
   * violation is the tie itself. Presence in this list, not this number, is
   * what says the relation does not hold.
   */
  amount: number;
  /**
   * The coherent SI unit {@link amount} is expressed in, when the relation was
   * judged dimensionally. Absent for a unitless relation, whose amount is in
   * the raw magnitudes the model declares.
   */
  unit?: string;
}

/**
 * A relation NEITHER engine could judge — a `[unit]` the registry does not
 * know, an offset temperature scale in arithmetic, a hand-converted `Real`.
 * Reported rather than dropped: a constraint that silently disappears from the
 * analysis reads as one that holds.
 */
export interface AnalysisUnknown {
  element: ElementRef;
  kind: 'equality' | 'inequality' | 'boolean';
  expression: string;
  /** Why it could not be judged, in the author's terms. */
  reason?: string;
}

export interface AnalysisReport {
  converged: boolean;
  iterations: number;
  residual: number;
  /** Solved numeric feature values (library content excluded). */
  values: SolvedValue[];
  /** Evaluated measures of effectiveness. */
  measures: MeasureResult[];
  /**
   * True when NO inequality constraint is KNOWN to be violated at the solved
   * values. It is not a proof that all of them hold: a relation neither engine
   * could judge appears in {@link unknowns} and leaves this flag true, because
   * an unjudged constraint is not a violated one. Read the two together — the
   * Solve header does.
   */
  feasible: boolean;
  /** The numerically-violated equality/inequality constraints. */
  violations: AnalysisViolation[];
  /** The relations neither engine could judge (never silently dropped). */
  unknowns: AnalysisUnknown[];
}

/**
 * Solve the model's numeric constraint system, read off its measures of
 * effectiveness, and summarise convergence. Library content is excluded from
 * the reported values. JSON-serialisable for the REST facade and UI.
 */
export function analysisReport(model: Model): AnalysisReport {
  const solved = solve(model);
  const values: SolvedValue[] = [];
  for (const [id, value] of solved.values) {
    const el = model.get(id);
    if (!el || el.attrs.isLibrary === true) continue;
    values.push({ element: ref(model, el), value });
  }

  // Numeric feasibility: violated equalities/inequalities at the solved values.
  const numeric = checkConstraintsNumeric(model);
  const violations: AnalysisViolation[] = [];
  const unknowns: AnalysisUnknown[] = [];
  for (const c of numeric) {
    const el = model.get(c.id);
    const element = el ? ref(model, el) : { id: c.id, eClass: '«unknown»', qualifiedName: '' };
    if (c.result === 'violated') {
      violations.push({
        element,
        kind: c.kind,
        expression: c.raw,
        amount: c.amount,
        ...(c.slackUnit ? { unit: c.slackUnit } : {}),
      });
    } else if (c.result === 'unknown') {
      unknowns.push({
        element,
        kind: c.kind,
        expression: c.raw,
        ...(c.reason ? { reason: c.reason } : {}),
      });
    }
  }
  // "No KNOWN violation" — see the field's doc comment. An `unknown` row is
  // reported through `unknowns`, never folded into this flag.
  const feasible = !numeric.some((c) => c.kind === 'inequality' && c.result === 'violated');

  return {
    converged: solved.converged,
    iterations: solved.iterations,
    residual: solved.residual,
    values,
    measures: evaluateMoEs(model),
    feasible,
    violations,
    unknowns,
  };
}

/* ───────────────────────────── Execution report ─────────────────────────── */

/** Metaclasses of the succession (control-flow) edges of an action body. */
const SUCCESSION_KINDS = new Set(['Succession', 'SuccessionFlow']);

/** A compact, serialisable step of a simulated action flow. */
export interface ExecutionStepSummary {
  id: string;
  name: string;
  kind: string;
  /** Guard of the succession fired to reach this node, when any. */
  guard?: string;
  /** Fork id when the node lies on a parallel branch. */
  parallelGroup?: string;
  /** Sub-behavior lifecycle marker for a composite/call action. */
  event?: 'enter' | 'exit';
  /** Composite/call recursion depth (0 at the top-level flow). */
  depth?: number;
  /** Effect note (assignment / accept / send / loop). */
  note?: string;
  /** Result-parameter values produced by an invoked sub-behavior (on `exit`). */
  produced?: Record<string, unknown>;
}

/** A runnable action flow plus a short trace summary from {@link runActionFlow}. */
export interface ActionFlowRun {
  action: ElementRef;
  nodeCount: number;
  successionCount: number;
  steps: ExecutionStepSummary[];
  edgesFired: number;
  complete: boolean;
  /**
   * The value store after execution (feature name → evaluated value), as a plain
   * JSON-serialisable object. Populated from assignments, loop variables and
   * literal seeds by {@link runActionFlow}.
   */
  valueStore: Record<string, unknown>;
  /** Total loop iterations executed across every While/For loop in the flow. */
  iterations: number;
  /**
   * Maximum composite/call recursion depth reached (0 when the flow has no
   * nested/invoked sub-behaviors).
   */
  depth: number;
}

/** A behavior (entry/do/exit action) performed during a state-machine run. */
export interface PerformedActionSummary {
  stateId: string;
  phase: 'entry' | 'do' | 'exit';
  actionId: string;
  name: string;
}

/** A runnable state machine plus a short trace summary from {@link runStateMachine}. */
export interface StateMachineRun {
  stateMachine: ElementRef;
  stateCount: number;
  transitionCount: number;
  /** Distinct trigger alphabet discovered on the machine's transitions, in order. */
  triggers: string[];
  /** State ids visited when driven with the discovered `triggers`. */
  visited: string[];
  finalState: string | null;
  firedCount: number;
  /** Entry/do/exit behaviors performed while running the machine, in order. */
  performed: PerformedActionSummary[];
  /** The value store after the run (feature name → value), JSON-serialisable. */
  valueStore: Record<string, unknown>;
  /** Active leaf states (one per concurrent region) after the run. */
  activeStates: string[];
  /** Discrete clock after a timed run (0 for untimed machines). */
  clock: number;
  /** Whether every region reached a final/complete state (and any join fired). */
  complete: boolean;
}

/** Runnable behaviors in the model, each with a short simulated trace. */
export interface ExecutionReport {
  actionFlows: ActionFlowRun[];
  stateMachines: StateMachineRun[];
}

/** Is `el` a node that participates in an action's control/object flow? */
function isFlowNode(el: ElementRecord): boolean {
  return isControlNode(el.eClass) || el.eClass === 'ActionUsage' || el.eClass.endsWith('ActionUsage');
}

/**
 * Enumerate the model's runnable behaviors and simulate each with the semantics
 * engine, returning a plain, JSON-serialisable summary (plan §6 execution
 * surface, powering the REST `GET /analytics/execution` route and the UI
 * "Simulate" affordance):
 *
 *  - **Action flows** — every non-library element that directly owns a
 *    Succession/SuccessionFlow edge is an action body; simulated with
 *    {@link runActionFlow} (topological token walk with fork/join + decision
 *    handling).
 *  - **State machines** — every non-library element that directly owns a
 *    TransitionUsage is a state machine; driven with {@link runStateMachine}
 *    against the distinct trigger alphabet discovered on its transitions (in
 *    declaration order), a deterministic "exercise every trigger" run.
 *
 * The two sets are disjoint in practice (action bodies use successions, state
 * machines use transitions). Library content is excluded.
 */
export function executionReport(model: Model): ExecutionReport {
  const actionFlows: ActionFlowRun[] = [];
  const stateMachines: StateMachineRun[] = [];

  for (const el of model.all()) {
    if (isRelationship(el.eClass) || el.attrs.isLibrary === true) continue;
    const children = model.children(el.id);

    // Action flow: directly owns ≥1 succession edge.
    if (children.some((c) => SUCCESSION_KINDS.has(c.eClass))) {
      const desc = model.descendants(el.id);
      const trace = runActionFlow(model, el.id);
      actionFlows.push({
        action: ref(model, el),
        nodeCount: desc.filter(isFlowNode).length,
        successionCount: desc.filter((d) => SUCCESSION_KINDS.has(d.eClass)).length,
        steps: trace.steps.map((s) => {
          const step: ExecutionStepSummary = { id: s.id, name: s.name, kind: s.kind };
          if (s.guard !== undefined) step.guard = s.guard;
          if (s.parallelGroup !== undefined) step.parallelGroup = s.parallelGroup;
          if (s.event !== undefined) step.event = s.event;
          if (s.depth !== undefined) step.depth = s.depth;
          if (s.note !== undefined) step.note = s.note;
          if (s.produced !== undefined) step.produced = s.produced;
          return step;
        }),
        edgesFired: trace.edgesFired.length,
        complete: trace.complete,
        valueStore: Object.fromEntries(trace.valueStore),
        iterations: trace.iterations,
        depth: trace.depth,
      });
    }

    // State machine: directly owns ≥1 transition.
    const transitions = children.filter((c) => c.eClass === 'TransitionUsage');
    if (transitions.length > 0) {
      const triggers = discoverTriggers(transitions);
      const result = runStateMachine(model, el.id, triggers);
      stateMachines.push({
        stateMachine: ref(model, el),
        stateCount: model.descendants(el.id).filter((d) => d.eClass === 'StateUsage').length,
        transitionCount: transitions.length,
        triggers,
        visited: result.visited,
        finalState: result.finalState,
        firedCount: result.fired.length,
        performed: result.performed.map((p) => ({
          stateId: p.stateId,
          phase: p.phase,
          actionId: p.actionId,
          name: p.name,
        })),
        valueStore: Object.fromEntries(result.valueStore),
        activeStates: result.activeStates,
        clock: result.clock ?? 0,
        complete: result.complete ?? result.finalState !== null,
      });
    }
  }

  return { actionFlows, stateMachines };
}

/** A time-stepped simulation of one state machine (JSON-serialisable). */
export interface SimulationReport {
  /** Whether a state machine was found and simulated. */
  ran: boolean;
  /** The simulated behavior + its time-series (present iff `ran`). */
  trace?: SimTrace;
  message: string;
}

/**
 * Run a default TIME-STEPPED simulation of one state machine and return its
 * serialisable time-series (powers a "Simulate over time" affordance + the REST
 * `GET /analytics/simulation` route). Target selection mirrors
 * {@link executionReport}: `behaviorId` if given, else the first non-library
 * element that directly owns a TransitionUsage. The auto-script exercises every
 * injectable trigger once (declaration order), then advances the clock past the
 * longest `after(n)` dwell so timed transitions fire. For interactive driving,
 * use the SDK `simulationSession`/`simulate` instead.
 */
export function simulationReport(model: Model, behaviorId?: ElementId): SimulationReport {
  let targetId = behaviorId;
  if (targetId === undefined) {
    // Same criterion as the SDK's isSimulatable (a transition ANYWHERE in the
    // subtree, so orthogonal machines with transitions inside regions qualify),
    // and prefer the OUTERMOST such machine (skip one nested in another).
    for (const el of model.all()) {
      if (isRelationship(el.eClass) || el.attrs.isLibrary === true) continue;
      if (!isSimulatable(model, el.id)) continue;
      if (model.ancestors(el.id).some((a) => isSimulatable(model, a.id))) continue;
      targetId = el.id;
      break;
    }
  }
  if (targetId === undefined || model.get(targetId) === undefined) {
    return { ran: false, message: 'No state machine to simulate.' };
  }

  // Use the SAME trigger discovery the trace reports, so the auto-script and the
  // returned `trace.triggers` cannot disagree.
  const triggers = simTriggers(model, targetId);
  const transitions = model.descendants(targetId).filter((d) => d.eClass === 'TransitionUsage');
  const hasTimed = transitions.some((t) => afterDwell(t) > 0 || /^\s*after\s*\(/.test(String(t.attrs.trigger ?? '')));
  const maxAfter = transitions.reduce((mx, t) => Math.max(mx, afterDwell(t)), 0);

  const script: SimStep[] = triggers.map((event) => ({ event }));
  if (hasTimed) script.push({ advance: Math.max(maxAfter, 1) });

  const trace = simulateStateMachine(model, targetId, script);
  return {
    ran: true,
    trace,
    message: `Simulated "${trace.behaviorName || targetId}" over ${trace.samples.length} samples.`,
  };
}

/** The dwell of an `after(n)` timed transition (`attrs.after` or `after(n)` trigger), else 0. */
function afterDwell(tr: ElementRecord): number {
  const a = tr.attrs.after;
  if (typeof a === 'number') return a;
  const t = tr.attrs.trigger;
  if (typeof t === 'string') {
    const m = /^\s*after\s*\(\s*([0-9]+(?:\.[0-9]+)?)\s*\)\s*$/.exec(t);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Distinct, non-empty transition triggers in declaration order. */
function discoverTriggers(transitions: ElementRecord[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of transitions) {
    const trig = t.attrs.trigger;
    if (typeof trig !== 'string' || trig.trim() === '') continue;
    if (seen.has(trig)) continue;
    seen.add(trig);
    out.push(trig);
  }
  return out;
}
