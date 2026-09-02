/**
 * buildDiagram — project a {@link Model} into a view-specific {@link DiagramGraph}.
 *
 * Each {@link ViewKind} selects a different subset of elements and a different
 * mapping of relationships to edges, following the SysML v2 graphical-notation
 * view catalogue (docs/02 §4) and the module brief:
 *
 *  - general          ≈ BDD : definitions + structural usages as boxes;
 *                       attribute/port compartments in `data`; composition
 *                       (filled ◆), reference (◇), feature typing, the
 *                       specialization family, and satisfy/allocate/dependency
 *                       as edges.
 *  - interconnection  ≈ IBD : parts nested via `parentId`, ports on boundaries
 *                       (`node.ports`), ConnectionUsages as port-to-port edges.
 *  - action           ≈ Activity : ActionUsages + control nodes; Successions.
 *  - state            ≈ State machine : StateUsages; TransitionUsages labelled
 *                       'trigger [guard] / effect'.
 *  - requirement      ≈ Requirement diagram : requirement nodes + their
 *                       satisfy/refine/trace endpoints.
 *  - tree             : pure containment hierarchy.
 *
 * The optional `rootId` scopes the projection to that element's subtree.
 */

import type { ElementId, ElementRecord } from '@core/index';
import {
  Model,
  TEXTUAL_KEYWORD,
  isControlNode,
  isDefinition,
  isRelationship,
  isSpecialization,
  isUsage,
} from '@core/index';
import type { DiagramEdge, DiagramGraph, DiagramNode, DiagramPort, ViewKind } from './types';

/* ───────────────────────────── classification ──────────────────────────── */

/** Container metaclasses that never render as a diagram box. */
const CONTAINER_KINDS = new Set(['Package', 'LibraryPackage']);

/** Usages that render as a compartment row, not a standalone box (general view). */
const COMPARTMENT_KINDS = new Set(['AttributeUsage', 'PortUsage']);

/** Usages that carry endpoints and render as connectors (not boxes). */
const CONNECTION_USAGE_KINDS = new Set([
  'ConnectionUsage',
  'InterfaceUsage',
  'FlowUsage',
  'BindingConnectorAsUsage',
  'SuccessionFlow',
]);

/** Edge-bearing usages handled by behavioural views. */
const BEHAVIOUR_EDGE_KINDS = new Set(['TransitionUsage']);

/** Kind label for a specialization relationship metaclass. */
function specializeKind(eClass: string): string {
  return eClass === 'FeatureTyping' ? 'typed-by' : 'specialize';
}

/** Map a feature direction to a boundary side (React Flow `Position`). */
function directionSide(direction: unknown): string {
  if (direction === 'in') return 'left';
  if (direction === 'out') return 'right';
  return 'right';
}

/** Best human label for an element. */
function labelOf(el: ElementRecord): string {
  return el.declaredName ?? el.declaredShortName ?? el.eClass;
}

/** Compartment descriptor for an attribute/port usage. */
function compartmentOf(el: ElementRecord): Record<string, unknown> {
  return {
    id: el.id,
    name: labelOf(el),
    eClass: el.eClass,
    type: el.attrs.type,
    value: el.attrs.value,
    multiplicity: el.attrs.multiplicity,
    direction: el.attrs.direction,
  };
}

/** Shared `data` payload for a node. */
function nodeData(model: Model, el: ElementRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    keyword: TEXTUAL_KEYWORD[el.eClass] ?? el.eClass,
    name: labelOf(el),
    shortName: el.declaredShortName,
    isDefinition: isDefinition(el.eClass),
    isUsage: isUsage(el.eClass),
    attrs: el.attrs,
    qualifiedName: model.qualifiedName(el.id),
    ...extra,
  };
}

/* ──────────────────────────────── scoping ──────────────────────────────── */

/** Set of element ids in scope (subtree of `rootId`, or the whole model). */
function scopeIds(model: Model, rootId?: ElementId, excludeLibrary = true): Set<ElementId> {
  const ids = rootId
    ? new Set<ElementId>([rootId, ...model.descendants(rootId).map((d) => d.id)])
    : new Set<ElementId>(model.all().map((e) => e.id));
  if (excludeLibrary) {
    for (const id of ids) {
      if (model.get(id)?.attrs.isLibrary === true) ids.delete(id);
    }
  }
  return ids;
}

/** Options controlling a diagram projection. */
export interface BuildDiagramOptions {
  /**
   * Exclude bundled standard-library elements (`attrs.isLibrary === true`) from
   * the projection so the user model's diagrams are unchanged by loading the
   * library. Defaults to `true`.
   */
  excludeLibrary?: boolean;
}

/* ─────────────────────────────── general ───────────────────────────────── */

/** A general-view box: a definition or a structural usage (not a compartment/edge). */
function isStructuralNode(eClass: string): boolean {
  if (isRelationship(eClass)) return false;
  if (CONTAINER_KINDS.has(eClass)) return false;
  if (COMPARTMENT_KINDS.has(eClass)) return false;
  if (CONNECTION_USAGE_KINDS.has(eClass)) return false;
  if (BEHAVIOUR_EDGE_KINDS.has(eClass)) return false;
  if (isControlNode(eClass)) return false;
  return isDefinition(eClass) || isUsage(eClass);
}

function buildGeneral(model: Model, scope: Set<ElementId>): DiagramGraph {
  const nodes: DiagramNode[] = [];
  const nodeIds = new Set<ElementId>();

  for (const el of model.all()) {
    if (!scope.has(el.id) || !isStructuralNode(el.eClass)) continue;
    const attributes: Record<string, unknown>[] = [];
    const ports: Record<string, unknown>[] = [];
    for (const child of model.children(el.id)) {
      if (child.eClass === 'AttributeUsage') attributes.push(compartmentOf(child));
      else if (child.eClass === 'PortUsage') ports.push(compartmentOf(child));
    }
    nodes.push({
      id: el.id,
      elementId: el.id,
      kind: el.eClass,
      label: labelOf(el),
      data: nodeData(model, el, { attributes, ports }),
    });
    nodeIds.add(el.id);
  }

  const edges: DiagramEdge[] = [];

  // Composition / reference: a structural usage owned by another box.
  for (const el of model.all()) {
    if (!nodeIds.has(el.id) || !isUsage(el.eClass)) continue;
    if (el.ownerId === null || !nodeIds.has(el.ownerId)) continue;
    const kind = el.eClass === 'ReferenceUsage' ? 'reference' : 'composite';
    edges.push({
      id: `comp:${el.ownerId}->${el.id}`,
      source: el.ownerId,
      target: el.id,
      kind,
    });
  }

  // Relationship-backed edges (typing, specialization, satisfy/allocate/dependency).
  const crossKind: Record<string, string> = {
    Satisfy: 'satisfy',
    Allocation: 'allocate',
    Dependency: 'dependency',
    Verify: 'verify',
    Refine: 'refine',
    Trace: 'trace',
    Derive: 'derive',
  };
  for (const r of model.relationships()) {
    const src = r.source?.[0];
    const tgt = r.target?.[0];
    if (!src || !tgt || !nodeIds.has(src) || !nodeIds.has(tgt)) continue;
    if (isSpecialization(r.eClass)) {
      edges.push({ id: `rel:${r.id}`, elementId: r.id, source: src, target: tgt, kind: specializeKind(r.eClass) });
    } else if (crossKind[r.eClass]) {
      edges.push({ id: `rel:${r.id}`, elementId: r.id, source: src, target: tgt, kind: crossKind[r.eClass] });
    }
  }

  return { nodes, edges, viewKind: 'general' };
}

/* ──────────────────────────── interconnection ──────────────────────────── */

function buildInterconnection(model: Model, scope: Set<ElementId>, rootId?: ElementId): DiagramGraph {
  const partKinds = new Set(['PartUsage', 'ItemUsage', 'PartDefinition']);
  const nodes: DiagramNode[] = [];
  const nodeIds = new Set<ElementId>();

  // Candidate part nodes: the scoped root part itself (the frame) plus nested parts.
  //
  // Every in-scope part definition and usage gets a box, including a definition
  // that owns no parts. That looks like clutter when READING a wiring diagram —
  // such a definition can carry no connections — but it is the empty frame a
  // user drops new parts into, which is how the interconnection view is
  // authored (test/e2e/diagram-create-connect.spec.ts, palette-per-view.spec.ts).
  // Filtering them out was tried and reverted: it silently removed the authoring
  // lane. The right lever for an uncluttered picture is SCOPE — see `rootId`
  // and `store.diagramRootId` — which narrows the view without removing anything.
  const candidates = model.all().filter((el) => scope.has(el.id) && partKinds.has(el.eClass));

  for (const el of candidates) {
    const ports: DiagramPort[] = model
      .children(el.id)
      .filter((c) => c.eClass === 'PortUsage')
      .map((p) => ({ id: p.id, side: directionSide(p.attrs.direction), label: labelOf(p) }));
    nodes.push({
      id: el.id,
      elementId: el.id,
      kind: el.eClass,
      label: labelOf(el),
      data: nodeData(model, el),
      ports: ports.length ? ports : undefined,
    });
    nodeIds.add(el.id);
  }

  // Nesting: a part nested inside another part node (but not the frame root onto itself).
  for (const n of nodes) {
    const el = model.get(n.elementId)!;
    if (el.id === rootId) continue;
    if (el.ownerId && nodeIds.has(el.ownerId)) n.parentId = el.ownerId;
  }

  // Map a port id to its owning part node (an in-scope ConnectionUsage may bind ports).
  const portOwnerInScope = (portId: ElementId): boolean => {
    const p = model.get(portId);
    return !!p && !!p.ownerId && nodeIds.has(p.ownerId);
  };

  const edges: DiagramEdge[] = [];
  for (const el of model.all()) {
    if (!scope.has(el.id) || !CONNECTION_USAGE_KINDS.has(el.eClass)) continue;
    const src = el.source?.[0];
    const tgt = el.target?.[0];
    if (!src || !tgt) continue;
    if (!portOwnerInScope(src) || !portOwnerInScope(tgt)) continue;
    edges.push({
      id: `conn:${el.id}`,
      elementId: el.id,
      source: src,
      target: tgt,
      kind: 'connection',
      label: el.declaredName,
    });
  }

  return { nodes, edges, viewKind: 'interconnection' };
}

/* ─────────────────────────────── action ────────────────────────────────── */

function buildAction(model: Model, scope: Set<ElementId>): DiagramGraph {
  const nodes: DiagramNode[] = [];
  const nodeIds = new Set<ElementId>();
  for (const el of model.all()) {
    if (!scope.has(el.id)) continue;
    // Match the whole ActionUsage family, not just the base metaclass — Accept/
    // Send/Assignment/Perform/If/While/For action usages were previously dropped
    // from the action view entirely.
    const isAction = el.eClass.endsWith('ActionUsage');
    const isCtrl = isControlNode(el.eClass);
    if (!isAction && !isCtrl) continue;
    nodes.push({
      id: el.id,
      elementId: el.id,
      kind: el.eClass,
      label: labelOf(el),
      data: nodeData(model, el, { isControl: isCtrl }),
    });
    nodeIds.add(el.id);
  }

  const edges: DiagramEdge[] = [];
  for (const el of model.all()) {
    if (!scope.has(el.id)) continue;
    if (el.eClass !== 'Succession' && el.eClass !== 'SuccessionFlow') continue;
    const src = el.source?.[0];
    const tgt = el.target?.[0];
    if (!src || !tgt || !nodeIds.has(src) || !nodeIds.has(tgt)) continue;
    edges.push({ id: `succ:${el.id}`, elementId: el.id, source: src, target: tgt, kind: 'succession' });
  }

  return { nodes, edges, viewKind: 'action' };
}

/* ──────────────────────────────── state ────────────────────────────────── */

/** Compose a transition label 'trigger [guard] / effect' from its attrs. */
function transitionLabel(el: ElementRecord): string | undefined {
  const trigger = el.attrs.trigger;
  const guard = el.attrs.guard;
  const effect = el.attrs.effect;
  const parts: string[] = [];
  if (typeof trigger === 'string' && trigger) parts.push(trigger);
  if (typeof guard === 'string' && guard) parts.push(`[${guard}]`);
  let label = parts.join(' ');
  if (typeof effect === 'string' && effect) label = label ? `${label} / ${effect}` : `/ ${effect}`;
  return label || undefined;
}

function buildState(model: Model, scope: Set<ElementId>): DiagramGraph {
  const stateKinds = new Set(['StateUsage', 'ExhibitStateUsage']);
  const nodes: DiagramNode[] = [];
  const nodeIds = new Set<ElementId>();
  for (const el of model.all()) {
    if (!scope.has(el.id) || !stateKinds.has(el.eClass)) continue;
    nodes.push({
      id: el.id,
      elementId: el.id,
      kind: el.eClass,
      label: labelOf(el),
      data: nodeData(model, el),
    });
    nodeIds.add(el.id);
  }

  const edges: DiagramEdge[] = [];
  for (const el of model.all()) {
    if (!scope.has(el.id) || el.eClass !== 'TransitionUsage') continue;
    const src = el.source?.[0];
    const tgt = el.target?.[0];
    if (!src || !tgt || !nodeIds.has(src) || !nodeIds.has(tgt)) continue;
    edges.push({
      id: `trans:${el.id}`,
      elementId: el.id,
      source: src,
      target: tgt,
      kind: 'transition',
      label: transitionLabel(el),
    });
  }

  return { nodes, edges, viewKind: 'state' };
}

/* ──────────────────────────── requirement ──────────────────────────────── */

function buildRequirement(model: Model, scope: Set<ElementId>): DiagramGraph {
  const reqKinds = new Set(['RequirementUsage', 'RequirementDefinition', 'ConstraintUsage', 'ConstraintDefinition']);
  const reqEdgeKind: Record<string, string> = {
    Satisfy: 'satisfy',
    Verify: 'verify',
    Refine: 'refine',
    Trace: 'trace',
    Derive: 'derive',
    Dependency: 'derive',
  };

  const nodeIds = new Set<ElementId>();
  const nodes: DiagramNode[] = [];
  const addNode = (el: ElementRecord) => {
    if (nodeIds.has(el.id)) return;
    nodes.push({
      id: el.id,
      elementId: el.id,
      kind: el.eClass,
      label: labelOf(el),
      data: nodeData(model, el),
    });
    nodeIds.add(el.id);
  };

  // Requirement/constraint nodes in scope.
  for (const el of model.all()) {
    if (scope.has(el.id) && reqKinds.has(el.eClass)) addNode(el);
  }

  // Requirement relationship edges; pull in their (in-scope) non-relationship endpoints.
  const edges: DiagramEdge[] = [];
  for (const r of model.relationships()) {
    const kind = reqEdgeKind[r.eClass];
    if (!kind) continue;
    const src = r.source?.[0];
    const tgt = r.target?.[0];
    if (!src || !tgt) continue;
    if (!scope.has(src) || !scope.has(tgt)) continue;
    // Only keep edges that touch at least one requirement/constraint node.
    const touchesReq = reqKinds.has(model.get(src)?.eClass ?? '') || reqKinds.has(model.get(tgt)?.eClass ?? '');
    if (!touchesReq) continue;
    const srcEl = model.get(src);
    const tgtEl = model.get(tgt);
    if (srcEl && !isRelationship(srcEl.eClass)) addNode(srcEl);
    if (tgtEl && !isRelationship(tgtEl.eClass)) addNode(tgtEl);
    edges.push({ id: `req:${r.id}`, elementId: r.id, source: src, target: tgt, kind });
  }

  return { nodes, edges, viewKind: 'requirement' };
}

/* ──────────────────────────────── tree ─────────────────────────────────── */

function buildTree(model: Model, scope: Set<ElementId>): DiagramGraph {
  const nodes: DiagramNode[] = [];
  const nodeIds = new Set<ElementId>();
  for (const el of model.all()) {
    if (!scope.has(el.id) || isRelationship(el.eClass)) continue;
    nodes.push({
      id: el.id,
      elementId: el.id,
      kind: el.eClass,
      label: labelOf(el),
      data: nodeData(model, el),
    });
    nodeIds.add(el.id);
  }

  const edges: DiagramEdge[] = [];
  for (const n of nodes) {
    const el = model.get(n.elementId)!;
    if (el.ownerId && nodeIds.has(el.ownerId)) {
      n.parentId = el.ownerId;
      edges.push({
        id: `own:${el.ownerId}->${el.id}`,
        source: el.ownerId,
        target: el.id,
        kind: 'containment',
      });
    }
  }

  return { nodes, edges, viewKind: 'tree' };
}

/* ──────────────────────────────── parametric ───────────────────────────── */

/** Constraint/analysis boxes for the parametric view. */
const CONSTRAINT_NODE_KINDS = new Set([
  'ConstraintUsage',
  'ConstraintDefinition',
  'CalculationUsage',
  'CalculationDefinition',
]);

/** Feature metaclasses that render as parameter nodes bound by binding connectors. */
const PARAMETER_NODE_KINDS = new Set(['AttributeUsage', 'ReferenceUsage']);

/** Binding-connector usages that render as `bind` edges. */
const BINDING_USAGE_KINDS = new Set(['BindingConnectorAsUsage']);

/**
 * Parametric / analysis view: constraint & calculation boxes, their parameter
 * features, plus any AttributeUsages bound to them, wired by binding connectors
 * / feature-value bindings (`bind` edges). Satisfy links that touch a constraint
 * are surfaced too so analysis→requirement traceability is visible.
 */
function buildParametric(model: Model, scope: Set<ElementId>): DiagramGraph {
  const nodes: DiagramNode[] = [];
  const nodeIds = new Set<ElementId>();

  const addNode = (el: ElementRecord, extra: Record<string, unknown> = {}): void => {
    if (nodeIds.has(el.id)) return;
    nodes.push({
      id: el.id,
      elementId: el.id,
      kind: el.eClass,
      label: labelOf(el),
      data: nodeData(model, el, extra),
    });
    nodeIds.add(el.id);
  };

  // Constraint / calculation nodes and their parameter features.
  for (const el of model.all()) {
    if (!scope.has(el.id) || !CONSTRAINT_NODE_KINDS.has(el.eClass)) continue;
    addNode(el, { isConstraint: true });
    for (const child of model.children(el.id)) {
      if (PARAMETER_NODE_KINDS.has(child.eClass)) addNode(child, { isParameter: true });
    }
  }

  const edges: DiagramEdge[] = [];

  // Binding connectors (usage form): pull in the two bound features as nodes and
  // wire a `bind` edge between them.
  for (const el of model.all()) {
    if (!scope.has(el.id) || !BINDING_USAGE_KINDS.has(el.eClass)) continue;
    const src = el.source?.[0];
    const tgt = el.target?.[0];
    if (!src || !tgt || !scope.has(src) || !scope.has(tgt)) continue;
    const s = model.get(src);
    const t = model.get(tgt);
    if (s && !isRelationship(s.eClass)) addNode(s, { isParameter: PARAMETER_NODE_KINDS.has(s.eClass) });
    if (t && !isRelationship(t.eClass)) addNode(t, { isParameter: PARAMETER_NODE_KINDS.has(t.eClass) });
    edges.push({ id: `bind:${el.id}`, elementId: el.id, source: src, target: tgt, kind: 'bind' });
  }

  // Relationship-backed bindings (BindingConnector / feature-value) and analysis
  // Satisfy links that touch a constraint node.
  for (const r of model.relationships()) {
    const src = r.source?.[0];
    const tgt = r.target?.[0];
    if (!src || !tgt || !scope.has(src) || !scope.has(tgt)) continue;
    if (r.eClass === 'BindingConnector' || r.eClass === 'FeatureValue') {
      const s = model.get(src);
      const t = model.get(tgt);
      if (s && !isRelationship(s.eClass)) addNode(s, { isParameter: PARAMETER_NODE_KINDS.has(s.eClass) });
      if (t && !isRelationship(t.eClass)) addNode(t, { isParameter: PARAMETER_NODE_KINDS.has(t.eClass) });
      edges.push({ id: `bind:${r.id}`, elementId: r.id, source: src, target: tgt, kind: 'bind' });
    } else if (r.eClass === 'Satisfy' && (nodeIds.has(src) || nodeIds.has(tgt))) {
      const s = model.get(src);
      const t = model.get(tgt);
      if (s && !isRelationship(s.eClass)) addNode(s);
      if (t && !isRelationship(t.eClass)) addNode(t);
      edges.push({ id: `rel:${r.id}`, elementId: r.id, source: src, target: tgt, kind: 'satisfy' });
    }
  }

  return { nodes, edges, viewKind: 'parametric' };
}

/* ──────────────────────────────── geometry ─────────────────────────────── */

/** Read a `{x,y}` position (or `{w,h}`/`{width,height}` size) off an attrs bag. */
function readPoint(v: unknown, ax: string, ay: string): { a: number; b: number } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const rec = v as Record<string, unknown>;
  const a = rec[ax];
  const b = rec[ay];
  if (typeof a === 'number' && typeof b === 'number') return { a, b };
  return undefined;
}

/**
 * Minimal spatial (geometry) view: part usages placed by their `attrs.position`
 * ({x,y}) and sized by `attrs.size` ({w,h}) when present, otherwise laid out on a
 * simple grid. Containment relationships render as edges. Placeholder-but-
 * functional pending a richer geometric-model phase.
 */
function buildGeometry(model: Model, scope: Set<ElementId>): DiagramGraph {
  const partKinds = new Set(['PartUsage', 'ItemUsage', 'PartDefinition']);
  const nodes: DiagramNode[] = [];
  const nodeIds = new Set<ElementId>();

  const GRID_COLS = 4;
  const CELL_W = 200;
  const CELL_H = 150;
  let i = 0;

  for (const el of model.all()) {
    if (!scope.has(el.id) || !partKinds.has(el.eClass)) continue;
    const node: DiagramNode = {
      id: el.id,
      elementId: el.id,
      kind: el.eClass,
      label: labelOf(el),
      data: nodeData(model, el, { isGeometry: true }),
    };
    const pos = readPoint(el.attrs.position, 'x', 'y');
    node.position = pos
      ? { x: pos.a, y: pos.b }
      : { x: (i % GRID_COLS) * CELL_W, y: Math.floor(i / GRID_COLS) * CELL_H };
    const size = readPoint(el.attrs.size, 'w', 'h') ?? readPoint(el.attrs.size, 'width', 'height');
    if (size) node.size = { w: size.a, h: size.b };
    nodes.push(node);
    nodeIds.add(el.id);
    i += 1;
  }

  const edges: DiagramEdge[] = [];
  for (const n of nodes) {
    const el = model.get(n.elementId)!;
    if (el.ownerId && nodeIds.has(el.ownerId)) {
      edges.push({
        id: `own:${el.ownerId}->${el.id}`,
        source: el.ownerId,
        target: el.id,
        kind: 'containment',
      });
    }
  }

  return { nodes, edges, viewKind: 'geometry' };
}

/* ──────────────────────────────── case ─────────────────────────────────── */

/** Case-kind boxes for the case view: the case defs/usages that frame the view. */
const CASE_NODE_KINDS = new Set([
  'CaseUsage',
  'UseCaseUsage',
  'AnalysisCaseUsage',
  'VerificationCaseUsage',
  'CaseDefinition',
  'UseCaseDefinition',
  'AnalysisCaseDefinition',
  'VerificationCaseDefinition',
]);

/** Feature "roles" a case surfaces as associated nodes (with a matching edge kind). */
const CASE_ROLES = new Set(['actor', 'subject', 'objective', 'stakeholder']);

/** The case role a feature declares (`attrs.caseRole` or the shared `requirementRole`). */
function caseRoleOf(el: ElementRecord): string | undefined {
  const raw = el.attrs.caseRole ?? el.attrs.requirementRole;
  if (typeof raw === 'string' && CASE_ROLES.has(raw)) return raw;
  return undefined;
}

/**
 * Case view ≈ Case / Use-Case diagram: the case defs/usages
 * (Case/UseCase/AnalysisCase/VerificationCase) frame the view; their
 * `actor`/`subject`/`objective`/`stakeholder` features render as associated
 * nodes (edge kind = the role); `include`d use cases render as nodes wired by
 * `include` edges (IncludeUseCaseUsage endpoints); and `satisfy`/`verify` links
 * that touch a case surface the requirement they trace to.
 */
function buildCase(model: Model, scope: Set<ElementId>): DiagramGraph {
  const nodes: DiagramNode[] = [];
  const nodeIds = new Set<ElementId>();
  const caseIds = new Set<ElementId>();

  const addNode = (el: ElementRecord, extra: Record<string, unknown> = {}): void => {
    if (nodeIds.has(el.id)) return;
    nodes.push({
      id: el.id,
      elementId: el.id,
      kind: el.eClass,
      label: labelOf(el),
      data: nodeData(model, el, extra),
    });
    nodeIds.add(el.id);
  };

  // Frame: every in-scope case def/usage.
  for (const el of model.all()) {
    if (!scope.has(el.id) || !CASE_NODE_KINDS.has(el.eClass)) continue;
    addNode(el, { isCase: true, isFrame: true });
    caseIds.add(el.id);
  }

  const edges: DiagramEdge[] = [];

  // Role features (actor/subject/objective/stakeholder) owned by a case node.
  for (const caseId of caseIds) {
    for (const child of model.children(caseId)) {
      if (!scope.has(child.id)) continue;
      const role = caseRoleOf(child);
      if (!role) continue;
      addNode(child, { caseRole: role });
      edges.push({ id: `case:${role}:${caseId}->${child.id}`, source: caseId, target: child.id, kind: role });
    }
  }

  // Includes: an IncludeUseCaseUsage wires its owning case to the included case.
  for (const el of model.all()) {
    if (!scope.has(el.id) || el.eClass !== 'IncludeUseCaseUsage') continue;
    const src = el.source?.[0] ?? el.ownerId ?? undefined;
    const tgt = el.target?.[0];
    const tgtEl = tgt ? model.get(tgt) : undefined;
    if (src && tgtEl && scope.has(tgtEl.id) && !isRelationship(tgtEl.eClass)) {
      // Endpoint form: case → included case (both nodes), the include is the edge.
      const srcEl = model.get(src);
      if (srcEl && !isRelationship(srcEl.eClass)) addNode(srcEl, { isCase: caseIds.has(src) });
      addNode(tgtEl, { isCase: CASE_NODE_KINDS.has(tgtEl.eClass), included: true });
      // The included case may already be a frame node — mark it included regardless.
      const tgtNode = nodes.find((n) => n.id === tgtEl.id);
      if (tgtNode) tgtNode.data.included = true;
      edges.push({
        id: `include:${el.id}`,
        elementId: el.id,
        source: src,
        target: tgtEl.id,
        kind: 'include',
        // Display-only source may be `ownerId` (see `src` fallback) → not a true
        // relationship endpoint; block endpoint reconnection.
        reconnectable: false,
      });
    } else if (el.ownerId && caseIds.has(el.ownerId)) {
      // Reference form: render the include usage itself as the included node.
      addNode(el, { included: true });
      edges.push({
        id: `include:${el.id}`,
        elementId: el.id,
        source: el.ownerId,
        target: el.id,
        kind: 'include',
        // Reference form renders `ownerId → self`; neither endpoint is the
        // element's real source[0]/target[0] → block endpoint reconnection.
        reconnectable: false,
      });
    }
  }

  // satisfy / verify links that touch a case node → surface the requirement end.
  const caseRelKind: Record<string, string> = { Satisfy: 'satisfy', Verify: 'verify' };
  for (const r of model.relationships()) {
    const kind = caseRelKind[r.eClass];
    if (!kind) continue;
    const src = r.source?.[0];
    const tgt = r.target?.[0];
    if (!src || !tgt || !scope.has(src) || !scope.has(tgt)) continue;
    if (!caseIds.has(src) && !caseIds.has(tgt)) continue;
    const srcEl = model.get(src);
    const tgtEl = model.get(tgt);
    if (srcEl && !isRelationship(srcEl.eClass)) addNode(srcEl);
    if (tgtEl && !isRelationship(tgtEl.eClass)) addNode(tgtEl);
    edges.push({ id: `case-rel:${r.id}`, elementId: r.id, source: src, target: tgt, kind });
  }

  return { nodes, edges, viewKind: 'case' };
}

/* ─────────────────────────────── dispatch ──────────────────────────────── */

/**
 * Build the diagram projection of `model` for `viewKind`, optionally scoped to
 * the subtree rooted at `rootId`.
 */
export function buildDiagram(
  model: Model,
  viewKind: ViewKind,
  rootId?: ElementId,
  opts: BuildDiagramOptions = {},
): DiagramGraph {
  const scope = scopeIds(model, rootId, opts.excludeLibrary ?? true);
  switch (viewKind) {
    case 'general':
      return buildGeneral(model, scope);
    case 'interconnection':
      return buildInterconnection(model, scope, rootId);
    case 'action':
      return buildAction(model, scope);
    case 'state':
      return buildState(model, scope);
    case 'requirement':
      return buildRequirement(model, scope);
    case 'tree':
      return buildTree(model, scope);
    case 'parametric':
      return buildParametric(model, scope);
    case 'geometry':
      return buildGeometry(model, scope);
    case 'case':
      return buildCase(model, scope);
    case 'grid':
      // Rendered by the dedicated grid builder/component ({@link buildGrid} /
      // GridView), not the React Flow graph — return an empty projection.
      return { nodes: [], edges: [], viewKind: 'grid' };
    case 'sequence':
      // Rendered by a dedicated sequence-diagram builder/component (next phase),
      // not the React Flow graph — return an empty, non-throwing projection.
      return { nodes: [], edges: [], viewKind: 'sequence' };
    case 'allocation':
      // Rendered by a dedicated allocation-matrix builder/component (next phase),
      // not the React Flow graph — return an empty, non-throwing projection.
      return { nodes: [], edges: [], viewKind: 'allocation' };
    case 'requirements':
      // Rendered by the model-backed RequirementsTable editor (buildRequirementsTable
      // / RequirementsTable panel), not the React Flow graph — empty projection.
      return { nodes: [], edges: [], viewKind: 'requirements' };
    case 'analysis':
      // Rendered by the model-backed GraphAnalysisView (buildGraphAnalysis /
      // buildDSM), not the React Flow graph — empty projection.
      return { nodes: [], edges: [], viewKind: 'analysis' };
    case 'planning':
      // Rendered by the model-backed PlanningView (buildPlan), not the React
      // Flow graph — empty projection.
      return { nodes: [], edges: [], viewKind: 'planning' };
    case 'regroup':
      // Rendered by the model-backed RegroupView (planRegroup), not the React
      // Flow graph — empty projection.
      return { nodes: [], edges: [], viewKind: 'regroup' };
    default: {
      const _exhaustive: never = viewKind;
      throw new Error(`Unknown view kind: ${String(_exhaustive)}`);
    }
  }
}
