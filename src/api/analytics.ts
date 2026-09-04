/**
 * Pure analysis functions over a {@link Model}.
 *
 * Every function returns plain, JSON-serialisable data (no class instances, no
 * model references) so results can be rendered in tables, exported as JSON/CSV,
 * or shipped over the REST facade unchanged. These power the analytics surface in
 * plan §6: element counts, model metrics, requirement-satisfaction coverage,
 * traceability matrices, where-used / impact analysis, and connectivity checks.
 */

import {
  REQUIREMENT_KINDS,
  type ElementId,
  type ElementRecord,
  type Model,
  isControlNode,
  isRelationship,
  isTypingSpecialization,
} from '@core/index';
import {
  checkConstraints,
  checkConstraintsNumeric,
  runActionFlow,
  runStateMachine,
  simulateStateMachine,
  isSimulatable,
  discoverTriggers as simTriggers,
  solve,
  evaluateMoEs,
  type ConstraintCheck,
  type MeasureResult,
  type SimStep,
  type SimTrace,
} from '../semantics/index';
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
}

/**
 * For each requirement, the elements that satisfy it (via `Satisfy` edges whose
 * `target` is the requirement and whose `source` is the satisfier), and whether
 * it is covered. Overall `coverage` = satisfied / total.
 *
 * Only the USER's requirements are counted. Counting the bundled library's made
 * the shipped UAV example — every one of its requirements satisfied — report
 * 2/26 = 7.7% coverage on the app's own Requirement-satisfaction button.
 */
export function requirementSatisfaction(model: Model): SatisfactionReport {
  const candidates = model.ofKind(...REQUIREMENT_KINDS);
  const reqs = candidates.filter((r) => isUserElement(model, r));
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
  return { element, references, usedBy: [...usedByMap.values()] };
}

/* ───────────────────────── Connectivity report ──────────────────────────── */

const CONNECTION_KINDS = new Set([
  'ConnectionUsage',
  'InterfaceUsage',
  'Connector',
  'BindingConnectorAsUsage',
  'Flow',
  'FlowUsage',
  'SuccessionFlow',
  'Allocation',
]);

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
      .find((e) => e.eClass === 'Redefinition' && (e.source ?? []).includes(current))
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
  const checks = checkConstraints(model).filter((c) => model.get(c.id)?.attrs.isLibrary !== true);
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
  /** The amount by which the constraint is violated. */
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
