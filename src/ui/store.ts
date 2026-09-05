/**
 * `useAppStore` — the single UI state container and command surface for the
 * modeler. Everything the panels do flows through here: the live
 * {@link Model}, the {@link ModelApi}/{@link SysmlApiServer} SDK surfaces, the
 * current selection/expansion, the active diagram view + its laid-out
 * {@link DiagramGraph}, validation diagnostics, the textual-editor buffer,
 * project name, the last query result, and an undo/redo history.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  STORE SELECTOR API (what the panel agents may rely on)
 * ──────────────────────────────────────────────────────────────────────────
 * Subscribe with the zustand hook, selecting only what you need, e.g.:
 *
 *   const selectionId = useAppStore((s) => s.selectionId);
 *   const diagram     = useAppStore((s) => s.diagram);
 *   const select      = useAppStore((s) => s.select);
 *
 * IMPORTANT — model reactivity:
 *   The {@link Model} is a mutable class instance, so mutating it does NOT by
 *   itself re-render React. Every command that mutates the model bumps a
 *   monotonically-increasing `rev` counter. Panels that read the model
 *   directly (Explorer tree, Properties fields) MUST subscribe to `rev` so
 *   they re-render on mutations:
 *
 *     const rev   = useAppStore((s) => s.rev);     // re-render trigger
 *     const model = useAppStore((s) => s.model);   // stable instance
 *
 * State fields:
 *   model        : Model              — single source of truth (mutated in place)
 *   api          : ModelApi           — ergonomic SDK (also on window.sysml)
 *   server       : SysmlApiServer     — in-process OMG REST facade
 *   selectionId  : string | null      — currently selected element id
 *   expandedIds  : Set<string>        — expanded tree-node ids (Explorer)
 *   activeView   : ViewKind           — current diagram/view kind
 *   diagram      : DiagramGraph | null— laid-out projection for activeView
 *   diagnostics  : Diagnostic[]       — current validation/parse findings
 *   textBuffer   : string             — textual-editor contents
 *   textDirty    : boolean            — buffer has edits not applied to model
 *   serializeError: string | null     — why the model could not be written as text
 *   projectName  : string             — current project name
 *   queryResult  : QueryResult | null — last API-console query result
 *   rev          : number             — bumps on every model mutation
 *
 * Commands (all keep model + diagram + text + diagnostics consistent and push
 * undo snapshots where they mutate):
 *   select(id) · toggleExpand(id) · expand(id, open?) · setActiveView(v)
 *   rebuildDiagram() · createElement(eClass, ownerId?, name?) → id
 *   updateElement(id, patch) · setAttr(id, k, v) · deleteElement(id)
 *   setRequirementShortId(id, value) · setRequirementAttr(id, key, value)
 *   setStatementKind(id, kind|null)
 *   reparent(id, ownerId) · connect(sourceId, targetId, kind)
 *   runValidation() · setTextBuffer(s) · applyText() · regenerateText()
 *   newProject() · saveProject(name?) · loadProject(name) · listProjects()
 *   importModel(text, fmt) · exportModel(fmt) → string · runQuery(q) → result
 *   undo() · redo()
 */

import { create } from 'zustand';
import * as Y from 'yjs';
import {
  Model,
  FORMAT_VERSION,
  buildSampleModel,
  duplicateSubtree,
  collectSubtrees,
  pasteSubtrees,
  isRelationship,
  isRequirement,
  type AttrValue,
  type ClipboardPayload,
  type ElementId,
  type ElementRecord,
  type SerializedModel,
} from '@core/index';
// Browser-safe collaboration client (Yjs CRDT + y-websocket + awareness). This
// re-export barrel never pulls in the Node-only "ws" relay (scripts/collab-server.ts).
import {
  bindModelToDoc,
  connect as collabConnect,
  setLocalSelection,
  readPeers,
  type CollabConnection,
  type ModelDocBinding,
  type Peer,
} from '../collab';
import {
  parseModel,
  retractResolvedSpecializationWarnings,
  serializeElement,
  resolveConnectorFeatureChains,
  type ParseDiagnostic,
  type ParseResult,
} from '@text/index';
// Import the JSON-free resolver directly; the multi-MB full library is loaded
// asynchronously via a dynamic import (see loadStandardLibraryAsync) so it is
// code-split into a lazy chunk and never blocks first paint.
import { resolveTypeReferences } from '@library/resolve';
import { validate, type Diagnostic } from '@validation/index';
import {
  ModelApi,
  SysmlApiServer,
  constraintReport,
  executionReport,
  analysisReport,
  evaluateQuery,
  type ActionFlowRun,
  type StateMachineRun,
  type AnalysisReport,
  type Query,
  type QueryResult,
  type Branch,
  type Commit,
  type MergeConflict,
  type MergeStrategy,
} from '@api/index';
import {
  buildDiagram,
  layoutDiagram,
  buildAllocationMatrix,
  buildSequence,
  buildGrid,
  buildGeometryScene,
  buildGraphAnalysis,
  buildDSM,
  defaultAnalysisConfig,
  restyleNodeSizes,
  buildPlan,
  defaultPlanConfig,
  planRegroup,
  defaultRegroupConfig,
  seedRegroupFromClusters,
  seedRegroupFromNodeIds,
  planApply,
  applyRegroup as applyRegroupOps,
  subtreeRoots,
  type DiagramGraph,
  type ViewKind,
  type AllocationMatrix,
  type SequenceDiagram,
  type GridModel,
  type GeometryScene,
  type AnalysisConfig,
  type GraphAnalysisModel,
  type DSMModel,
  type PlanConfig,
  type PlanModel,
  type RegroupConfig,
  type RegroupModel,
  type RegroupApplyPlan,
} from '@diagram/index';
import {
  createDefaultStore,
  downloadText,
  exportModel as ioExportModel,
  importModel as ioImportModel,
  MIME_BY_EXTENSION,
  type ModelFormat,
  type ProjectStore,
} from '@persistence/index';
import {
  SimulationSession,
  UNWRITABLE_NOTE_BODY_REFUSAL,
  clearStatementKind as semClearStatementKind,
  hasRequirementAttr,
  isSimulatable as semIsSimulatable,
  isWritableNoteBody,
  requirementShortId,
  setRequirementAttr as semSetRequirementAttr,
  setRequirementShortId as semSetRequirementShortId,
  setStatementKind as semSetStatementKind,
  statementKindOf,
  type RmAttrKey,
  type StatementKind,
  type SimSample,
} from '@semantics/index';
import { parseModelDescription, importFmiBlock } from '@interop/index';
import { GENERATOR_ID, LEGACY_STORAGE_DB } from '../branding';

/** Max number of undo snapshots retained. */
const UNDO_LIMIT = 50;

/** Persistence backend (chosen once for the session). */
const projectStore: ProjectStore = createDefaultStore({ dbName: LEGACY_STORAGE_DB });

/* ───────────────────────────── Collaboration types ──────────────────────── */

/** A remote collaborator as surfaced to the UI (mirrors {@link Peer}). */
export type CollabPeer = Peer;

/** Live collaboration state exposed to the panels. */
export interface CollabState {
  /** True once the WebSocket transport reports a live connection. */
  connected: boolean;
  /** The room / document name currently joined (empty when disconnected). */
  room: string;
  /** The WebSocket relay base URL in use / to use. */
  url: string;
  /** This client's presence identity (random per session — do not assert in unit tests). */
  self: { name: string; color: string };
  /** Remote peers currently present in the room (excludes self). */
  peers: CollabPeer[];
}

/* ─────────────────────────────── State shape ────────────────────────────── */

export interface AppState {
  // Data + SDK surfaces.
  model: Model;
  api: ModelApi;
  server: SysmlApiServer;

  // UI state.
  /** The PRIMARY selected element (drives Properties / breadcrumb / fit). */
  selectionId: ElementId | null;
  /** The full multi-selection set (always includes `selectionId` when non-null). */
  selectionIds: ElementId[];
  /** Element hovered in ANY navigator (Explorer / Requirements table), so the
   *  parallel views can cross-highlight the same element. Transient UI state. */
  hoverId: ElementId | null;
  /** Element whose inline rename input is open (Explorer). Transient UI state. */
  renamingId: ElementId | null;
  /** Element currently under a drag (Explorer drop-target highlight). Transient UI state. */
  dragOverId: ElementId | null;
  /** Element whose "add child" picker is open (Explorer). Transient UI state. */
  pickerId: ElementId | null;
  /** Explorer subtree scope (null = whole tree). Transient UI state. */
  focusId: ElementId | null;
  /**
   * Diagram scope (null = the whole user model, the default).
   *
   * The diagram builder has always supported a scope root, but nothing ever
   * passed one, so an interconnection view was always the entire model: every
   * definition and every assembly on one canvas, growing with the model. That
   * is what made the published UAV diagram unreadable — the wiring was correct,
   * but competing with seven unrelated boxes.
   *
   * Scope narrows the picture WITHOUT removing anything from the view's
   * vocabulary; filtering definitions out was tried instead and reverted,
   * because an empty definition frame is what a user drops new parts into.
   */
  diagramRootId: ElementId | null;
  expandedIds: Set<ElementId>;
  activeView: ViewKind;
  diagram: DiagramGraph | null;
  /** Allocation-matrix projection — populated only while `activeView === 'allocation'`. */
  matrix: AllocationMatrix | null;
  /** Sequence-diagram projection — populated only while `activeView === 'sequence'`. */
  sequence: SequenceDiagram | null;
  /** Tabular grid projection — populated only while `activeView === 'grid'`. */
  grid: GridModel | null;
  /** 3D geometry-scene projection — populated only while `activeView === 'geometry'`. */
  scene: GeometryScene | null;
  /** Graph Analysis config (filter + algorithms); persists across view switches. */
  analysisConfig: AnalysisConfig;
  /** Graph Analysis projection — populated while `activeView === 'analysis'`. */
  analysis: GraphAnalysisModel | null;
  /** DSM projection — populated while `activeView === 'analysis'` (DSM mode). */
  dsm: DSMModel | null;
  /** Planning (wave-slicing) config; persists across view switches. */
  planConfig: PlanConfig;
  /** Migration/effort plan projection — populated while `activeView === 'planning'`. */
  plan: PlanModel | null;
  /** Regroup Workbench config (bundles + membership); persists across view switches. */
  regroupConfig: RegroupConfig;
  /** Regroup preview projection — populated while `activeView === 'regroup'`. PREVIEW-ONLY. */
  regroup: RegroupModel | null;
  /**
   * Pre-validated APPLY plan for the current regroup config (op list + errors
   * + summary counts) — refreshed alongside `regroup`. Computing it is pure;
   * only the `applyRegroup()` command mutates the model.
   */
  regroupApply: RegroupApplyPlan | null;
  /* ── Interactive simulation (Phase 2) — non-serialisable; never snapshotted ── */
  /** The live time-stepped simulation session, or null when not simulating. */
  simSession: SimulationSession | null;
  /** The state machine being simulated. */
  simTargetId: ElementId | null;
  /** The session's captured time-series (mirror of `simSession.trace`). */
  simTrace: readonly SimSample[];
  /** Sample cursor the UI is viewing (drives the on-canvas active-state animation). */
  simIndex: number;
  /** Active state ids at the current cursor — drives `.rf-sim-active` on the canvas. */
  simActiveStates: ElementId[];
  /** Whether auto-play is running (the UI ticks `simAdvance`). */
  simPlaying: boolean;
  /** Whether to solve the parametric/constraint network each step (Phase 3). */
  simSolve: boolean;
  diagnostics: Diagnostic[];
  textBuffer: string;
  textDirty: boolean;
  /**
   * Why the model could not be written as text, or `null` when it could.
   *
   * A model can carry something the notation has no spelling for — a note body
   * containing the sequence that ends a note, a multiplicity containing the
   * bracket that ends one — and the serializer refuses rather than write a file
   * that parses cleanly and means something else. That refusal used to be
   * swallowed into the empty string, so the Text tab showed an empty document
   * while the status strip still said "in sync with model". While this is set,
   * {@link AppState.textBuffer} is the LAST text that could be written, the Text
   * view says so, and `applyText` refuses — a stale buffer must not be able to
   * replace the model it no longer describes. The element itself is named in the
   * Problems panel by the rule that reports it.
   */
  serializeError: string | null;
  projectName: string;
  queryResult: QueryResult | null;
  /** Bumps on every model mutation; selector hook for model-backed panels. */
  rev: number;
  /**
   * False until the standard library has finished merging into the model (see
   * {@link loadStandardLibraryAsync}). The App renders a brief loading gate and
   * withholds `window.sysml` / the diagram until this flips true, so the model
   * is DETERMINISTIC by the time the app is interactive — neither users nor E2E
   * tests ever observe the (idempotent, undo-free) library merge mid-session.
   */
  libraryReady: boolean;

  // ── Real-time collaboration (Yjs CRDT + presence) ────────────────────────
  /** Live collaboration status, room, transport URL, self identity + remote peers. */
  collab: CollabState;

  // ── Version control (over api.repository / ProjectRepository) ────────────
  /** The branch the Versions UI currently targets (reads/writes/switch). */
  currentBranchId: string;
  /** All branches of the working project. */
  branches: Branch[];
  /** Commit history of {@link currentBranchId}, oldest → newest. */
  commits: Commit[];
  /** Result of the last merge: the new merge-commit id (if any) + conflicts. */
  mergeResult: { commitId?: string; conflicts: MergeConflict[] } | null;

  // Undo/redo snapshot stacks (model.toJSON()).
  undoStack: SerializedModel[];
  redoStack: SerializedModel[];

  // ── Commands ──────────────────────────────────────────────────────────
  select(id: ElementId | null, opts?: { additive?: boolean }): void;
  /** Replace the selection with an explicit set (e.g. a canvas box-select). */
  setSelection(ids: ElementId[]): void;
  /** Delete every element in the multi-selection in one undo step. */
  deleteSelection(): void;
  /** Duplicate every selected subtree (skipping relationships) in one undo step. */
  duplicateSelection(): void;
  /** Detached clipboard of copied subtrees (survives edits; null when empty). */
  clipboard: ClipboardPayload | null;
  /** Copy the current selection's subtrees into the clipboard (not undoable). */
  copySelection(): void;
  /** Paste the clipboard under `ownerId` (default: the primary selection), in
   *  one undo step; returns the new root ids. */
  pasteClipboard(ownerId?: ElementId | null): ElementId[];
  /** Set/clear the cross-view hover highlight (null = nothing hovered). */
  setHover(id: ElementId | null): void;
  /** Set which element's rename input is open (null = none). Transient UI state. */
  setRenamingId(id: ElementId | null): void;
  /** Set the current drag-over element (null = none). Transient UI state. */
  setDragOverId(id: ElementId | null): void;
  /** Set which element's "add child" picker is open (null = none). Transient UI state. */
  setPickerId(id: ElementId | null): void;
  /** Set the Explorer subtree scope (null = whole tree). Transient UI state. */
  setFocusId(id: ElementId | null): void;
  /** Scope the diagram to `id`'s subtree, or pass null to show the whole model. */
  setDiagramRoot(id: ElementId | null): void;
  toggleExpand(id: ElementId): void;
  expand(id: ElementId, open?: boolean): void;
  setActiveView(v: ViewKind): void;
  rebuildDiagram(): Promise<void>;
  /** Merge a patch into the Graph Analysis config and rebuild the projection. */
  setAnalysisConfig(patch: Partial<AnalysisConfig>): void;
  /** Merge a patch into the Planning config and rebuild the plan projection. */
  setPlanConfig(patch: Partial<PlanConfig>): void;
  /**
   * Merge a patch into the Regroup config and rebuild the preview. PURE UI
   * state — the model is never mutated (Phase 1 has no Apply).
   */
  setRegroupConfig(patch: Partial<RegroupConfig>): void;
  /** Named what-if snapshots of the Regroup config (session-scoped). */
  scenarios: Record<string, RegroupConfig>;
  /** Snapshot the current Regroup config under `name`. */
  saveScenario(name: string): void;
  /** Restore a saved scenario into the live Regroup config. */
  loadScenario(name: string): void;
  /** Forget a saved scenario. */
  deleteScenario(name: string): void;
  /** Replace the Regroup config with Louvain-cluster-seeded bundles (read-only). */
  seedRegroup(): void;
  /**
   * Switch to the Regroup Workbench seeded from a specific set of graph nodes —
   * the handoff from the Graph Analysis view ("regroup this community"). Each
   * node rolls up to its nearest candidate part; the resolved parts become one
   * new bundle. PURE-config + a view switch (no model mutation).
   */
  regroupFromCluster(nodeIds: string[], label?: string): void;
  /**
   * APPLY the previewed regroup as ONE atomic, undoable mutation: create the
   * new composite parts, reparent the explicitly-assigned members, synthesize
   * the delegation ports + bindings, and rewire the crossing connections.
   * Refuses (zero mutation) when the pre-validated plan carries errors or has
   * nothing to do. On an unexpected mid-apply throw the just-pushed undo
   * snapshot is restored and popped — the model is never left half-applied.
   */
  applyRegroup(): void;

  createElement(eClass: string, ownerId?: ElementId | null, name?: string): ElementId;
  updateElement(id: ElementId, patch: Partial<Omit<ElementRecord, 'id' | 'ownerId'>>): void;
  setAttr(id: ElementId, key: string, value: AttrValue): void;
  /**
   * Set a requirement's ID — the `<R1>` short name the file keeps — or clear it
   * with an empty value. ONE undo step; the same value again is not a change
   * and spends none. Both id controls (the grid's ID cell and the Properties
   * box) go through here rather than `setAttr(id, 'reqId', …)`: that wrote the
   * legacy slot the serializer only falls back to, so the edited id was shown
   * and the old one saved. Refused, before any snapshot, for a standard-library
   * element (undo restores those verbatim) and for anything that is not a
   * requirement.
   */
  setRequirementShortId(id: ElementId, value: string | null): void;
  /**
   * Set one requirement facet — status, verdict, risk, priority, criticality,
   * rationale, source, owner, verification method, or the statement kind — or
   * clear it with an empty value. ONE undo step per call, whatever it takes in
   * the model (a lazily created metadata carrier, an attribute, a keyword).
   * A value the key does not allow is refused: the model is untouched and the
   * snapshot comes straight back off the undo stack. Two calls do nothing at
   * all, before any snapshot is taken — a clear of a key that is not set, and
   * anything aimed at a standard-library element, which undo restores verbatim
   * and so could never take back.
   */
  setRequirementAttr(id: ElementId, key: RmAttrKey, value: string | null): void;
  /**
   * Say what kind of statement an element makes — `requirement`, `prose` or
   * `prompt` — or take the kind off with `null`.
   *
   * Separate from {@link setRequirementAttr} because the kind is the one facet
   * that is NOT about requirements: the guidance a `prompt` carries is most
   * useful on a definition or a package, where every element of that type or in
   * that package inherits it, and those are not requirements. ONE undo step.
   * Refused — model untouched, snapshot straight back off the stack — for a
   * library element, and for an element whose notation has nowhere to write the
   * keyword (a `connect`, a bare `doc`), which is a refusal the panel is
   * expected to prevent by not offering the control at all.
   */
  setStatementKind(id: ElementId, kind: StatementKind | null): void;
  deleteElement(id: ElementId): void;
  /** Deep-clone an element + its subtree as a sibling; returns the new root id. */
  duplicateElement(id: ElementId): ElementId | null;
  reparent(id: ElementId, ownerId: ElementId | null): void;
  /**
   * Reparent several elements under one new owner in a SINGLE undo step. Skips
   * ids that don't exist, are already owned by `ownerId`, or whose move is
   * illegal (self / cycle); applies the rest. Used by canvas drag-to-reparent.
   */
  reparentMany(ids: ElementId[], ownerId: ElementId | null): void;
  connect(sourceId: ElementId, targetId: ElementId, kind: string): ElementId;

  runValidation(): void;
  runConstraintCheck(): void;
  simulate(): void;
  solveParametric(): void;
  /* ── Interactive simulation (Phase 2) ── */
  /** Start (or restart) an interactive simulation of `id` (auto-picks a state machine when omitted). */
  simStart(id?: ElementId | null): void;
  /** Inject a named event into the running session and move the cursor to the new sample. */
  simInject(event: string): void;
  /** Advance the running session's clock by `dt` (default 1) and move the cursor forward. */
  simAdvance(dt?: number): void;
  /** Move the view cursor over the captured trace WITHOUT driving the machine. */
  simSeek(index: number): void;
  /** Reset the running session to its initial sample. */
  simReset(): void;
  /** Toggle auto-play (the UI ticks `simAdvance`). */
  simSetPlaying(playing: boolean): void;
  /** Toggle per-step parametric solving; restarts a live session with the new mode. */
  simSetSolve(on: boolean): void;
  /** Tear down the session and leave simulation. */
  simStop(): void;
  setTextBuffer(text: string): void;
  applyText(): void;
  regenerateText(): void;

  newProject(name?: string): void;
  saveProject(name?: string): Promise<void>;
  loadProject(name: string): Promise<void>;
  listProjects(): Promise<string[]>;

  importModel(text: string, fmt: ModelFormat): void;
  /** Import an FMI 3.0 modelDescription.xml as a new SysML block (added, not replacing). */
  importFmi(xml: string): void;
  exportModel(fmt: ModelFormat): string;

  runQuery(query: Query): QueryResult;

  // ── Collaboration commands ───────────────────────────────────────────────
  /**
   * Join a collaboration room: create a fresh Y.Doc, two-way bind it to the live
   * {@link Model}, open the WebSocket transport + awareness, and start mirroring
   * peer presence into {@link CollabState.peers}. `url` defaults to the current
   * {@link CollabState.url} (which is seeded from the `collabUrl=` query or
   * `ws://localhost:1234`). Idempotent — reconnecting first tears down any prior
   * session.
   */
  connectCollab(room: string, url?: string): void;
  /** Leave the current room and tear down the doc/binding/transport. */
  disconnectCollab(): void;

  // ── Version-control commands (over api.repository) ───────────────────────
  refreshVersions(): void;
  commitVersion(description?: string): void;
  createBranchCmd(name: string): void;
  switchBranch(branchId: string): void;
  mergeBranchesCmd(sourceBranchId: string, targetBranchId: string, strategy: MergeStrategy): void;

  undo(): void;
  redo(): void;
}

/* ──────────────────────────────── Helpers ───────────────────────────────── */

/**
 * Map a textual-notation parse diagnostic to the validation Diagnostic shape.
 *
 * Carries the Agent Diagnostics Contract fields through unchanged (`code`,
 * `range`, `expected`, `found`, `hint`) — they used to be discarded here, which
 * left the Problems panel with an English sentence and nothing to navigate by.
 * The `(line N:C)` suffix stays on the message: it is what the panel shows
 * today and what the existing E2E asserts, and the structured `range` is the
 * field new consumers should read.
 */
function parseDiagToDiagnostic(d: ParseDiagnostic, i: number): Diagnostic {
  return {
    id: `parse#${i}`,
    ruleId: 'parse',
    severity: d.severity,
    message: `${d.message} (line ${d.line}:${d.column})`,
    ...(d.code ? { code: d.code } : {}),
    ...(d.range ? { range: d.range } : {}),
    ...(d.expected ? { expected: d.expected } : {}),
    ...(d.found ? { found: d.found } : {}),
    ...(d.hint ? { hint: d.hint } : {}),
    source: d.source ?? 'parser',
  };
}

/** Safe validation that never throws into a render. */
function safeValidate(model: Model): Diagnostic[] {
  try {
    return validate(model);
  } catch (err) {
    console.error('validation failed', err);
    return [];
  }
}

/**
 * Root ids of the USER model — the bundled standard library (roots carrying
 * `attrs.isLibrary`) is kept out of the Explorer's auto-expanded set and out of
 * the textual buffer so loading it never changes the user-facing project.
 */
function userRootIds(model: Model): ElementId[] {
  return model.rootIds().filter((id) => model.get(id)?.attrs.isLibrary !== true);
}

/* ── Named Regroup scenarios — persisted to localStorage (durable across reloads). */
const SCENARIO_KEY = 'sysmlv2-scenarios';

function loadScenarios(): Record<string, RegroupConfig> {
  try {
    const raw = localStorage.getItem(SCENARIO_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, RegroupConfig>) : {};
  } catch {
    return {};
  }
}

function persistScenarios(scenarios: Record<string, RegroupConfig>): void {
  try {
    localStorage.setItem(SCENARIO_KEY, JSON.stringify(scenarios));
  } catch {
    /* localStorage unavailable / quota — best-effort persistence */
  }
}

/* ── Selection helpers ──────────────────────────────────────────────────────
   The store carries a multi-selection: `selectionIds` is the full set and
   `selectionId` is the PRIMARY (last-focused) element that drives Properties /
   the breadcrumb. These keep the two in sync so no write site can desync them. */

/** A single-element selection patch (primary + set aligned). */
function singleSel(id: ElementId | null): { selectionId: ElementId | null; selectionIds: ElementId[] } {
  return { selectionId: id, selectionIds: id ? [id] : [] };
}

/** Selection reset to the model's first user root (after a model swap). */
function rootSelection(model: Model): { selectionId: ElementId | null; selectionIds: ElementId[] } {
  return singleSel(userRootIds(model)[0] ?? model.roots()[0]?.id ?? null);
}

/** Re-validate a NON-EMPTY selection against the live model, dropping ids that
 *  no longer exist and keeping the primary in the set. Falls back to a user root
 *  only when everything was dropped. Returns the SAME references when nothing
 *  changed, so callers on hot paths (the model-subscribe handler) don't churn
 *  re-renders. Callers must handle a legitimately-empty selection themselves. */
/**
 * Drop a diagram scope whose root no longer exists.
 *
 * A scope pointing at a deleted element would silently render an empty canvas
 * with no way to tell why, so it degrades to the whole model.
 */
function validDiagramRoot(rootId: ElementId | null, model: Model): ElementId | null {
  return rootId !== null && model.has(rootId) ? rootId : null;
}

function validSelection(
  s: { selectionId: ElementId | null; selectionIds: ElementId[] },
  model: Model,
): { selectionId: ElementId | null; selectionIds: ElementId[] } {
  const kept = s.selectionIds.filter((x) => model.has(x));
  const primaryOk = s.selectionId != null && model.has(s.selectionId);
  // Fast path: still fully valid → return the same array/primitive references.
  if (primaryOk && kept.length === s.selectionIds.length) {
    return { selectionId: s.selectionId, selectionIds: s.selectionIds };
  }
  const selectionId = primaryOk ? s.selectionId : (kept[kept.length - 1] ?? null);
  if (selectionId == null) return rootSelection(model);
  if (!kept.includes(selectionId)) kept.push(selectionId);
  return { selectionId, selectionIds: kept };
}

/** An element belongs to the bundled standard library (never edited by the user). */
/** The first OUTERMOST, non-library simulatable state machine in the model (or null). */
function outermostSimulatable(model: Model): ElementId | null {
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue; // never auto-pick a library machine
    if (!semIsSimulatable(model, el.id)) continue;
    if (model.ancestors(el.id).some((a) => semIsSimulatable(model, a.id))) continue;
    return el.id;
  }
  return null;
}

const isLibraryEl = (el: ElementRecord): boolean => el.attrs.isLibrary === true;
/** An element belongs to the user's model (everything that isn't library). */
const isUserEl = (el: ElementRecord): boolean => el.attrs.isLibrary !== true;
/** An empty serialised model — used with `resetPreserving` to clear only the user scope. */
const EMPTY_SNAPSHOT: SerializedModel = {
  formatVersion: FORMAT_VERSION,
  generator: GENERATOR_ID,
  elements: [],
  rootIds: [],
};

/**
 * The text view of the model — or, when the model cannot be written, the
 * previous text and the reason.
 *
 * Never throws into a render. Library packages are excluded so the Text view
 * shows only the user's model and re-applying the text never re-ingests (and
 * duplicates) the standard library.
 *
 * The failure branch used to return the empty string, which is a claim about
 * the model — "it is empty" — that the store then published as clean and in
 * sync. Returning the previous buffer plus {@link AppState.serializeError}
 * keeps the Text view honest and gives `applyText` something to refuse on. The
 * patch is PARTIAL on failure: `textDirty` is left as it was, because whether
 * the user has unapplied edits is not what just changed.
 */
function textView(model: Model, previous: string): Partial<AppState> {
  try {
    return {
      textBuffer: userRootIds(model)
        .map((id) => serializeElement(model, id, 0))
        .join('\n\n'),
      textDirty: false,
      serializeError: null,
    };
  } catch (err) {
    console.error('serialization failed', err);
    return { textBuffer: previous, serializeError: serializeRefusal(err) };
  }
}

/** The sentence shown for a serializer refusal (its message, or a last resort). */
function serializeRefusal(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message === '' ? 'The model could not be written as text.' : message;
}

/** Compact display form of a value-store value. */
function fmtStoreValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

/** Build navigable info rows for a simulated action-flow trace. */
function actionFlowDiagnostics(flow: ActionFlowRun): Diagnostic[] {
  const name = flow.action.declaredName || flow.action.qualifiedName || flow.action.id;
  const header: Diagnostic = {
    id: 'simulate#0',
    ruleId: 'simulate',
    severity: 'info',
    message: `Action flow "${name}": ${flow.steps.length} step(s), ${flow.edgesFired} edge(s) fired${
      flow.iterations ? `, ${flow.iterations} loop iteration(s)` : ''
    }${flow.depth ? `, composite depth ${flow.depth}` : ''}${flow.complete ? ', complete' : ''}.`,
    elementId: flow.action.id,
  };
  const steps: Diagnostic[] = flow.steps.map((s, i) => {
    const indent = '  '.repeat(s.depth ?? 0);
    // Composite / call sub-behavior enter/exit markers.
    if (s.event) {
      const produced = s.produced && Object.keys(s.produced).length > 0
        ? ` ⇒ ${Object.entries(s.produced).map(([k, v]) => `${k}=${fmtStoreValue(v)}`).join(', ')}`
        : '';
      return {
        id: `simulate#${i + 1}`,
        ruleId: 'simulate',
        severity: 'info' as const,
        message: `${i + 1}. ${indent}${s.event === 'enter' ? '▶ enter' : '◀ exit'} ${s.name || `«${s.kind}»`}${produced}`,
        elementId: s.id,
      };
    }
    return {
      id: `simulate#${i + 1}`,
      ruleId: 'simulate',
      severity: 'info' as const,
      message: `${i + 1}. ${indent}${s.name || `«${s.kind}»`} (${s.kind})${s.guard ? ` [guard: ${s.guard}]` : ''}${
        s.parallelGroup ? ' ∥' : ''
      }${s.note ? ` — ${s.note}` : ''}`,
      elementId: s.id,
    };
  });
  // Value-store rows: the evolving feature name → value map after execution.
  const storeEntries = Object.entries(flow.valueStore ?? {});
  const store: Diagnostic[] = storeEntries.map(([k, v], i) => ({
    id: `simulate#store#${i}`,
    ruleId: 'simulate',
    severity: 'info',
    message: `store: ${k} = ${fmtStoreValue(v)}`,
    elementId: flow.action.id,
  }));
  return [header, ...steps, ...store];
}

/** Build navigable info rows for a simulated state-machine run. */
function stateMachineDiagnostics(model: Model, machine: StateMachineRun): Diagnostic[] {
  const name =
    machine.stateMachine.declaredName || machine.stateMachine.qualifiedName || machine.stateMachine.id;
  const stateName = (id: string): string => model.get(id)?.declaredName ?? id;
  const active = (machine.activeStates ?? []).map(stateName).join(', ');
  const header: Diagnostic = {
    id: 'simulate#0',
    ruleId: 'simulate',
    severity: 'info',
    message: `State machine "${name}": triggers [${machine.triggers.join(', ')}] → ${machine.firedCount} transition(s) fired${
      active ? `; active: ${active}` : ''
    }${machine.clock ? `; clock ${machine.clock}` : ''}${machine.complete ? '; complete' : ''}.`,
    elementId: machine.stateMachine.id,
  };
  const states: Diagnostic[] = machine.visited.map((sid, i) => ({
    id: `simulate#${i + 1}`,
    ruleId: 'simulate',
    severity: 'info',
    message: `${i + 1}. ${stateName(sid)}${i === 0 ? ' (initial)' : ''}${
      sid === machine.finalState && i === machine.visited.length - 1 ? ' (final)' : ''
    }`,
    elementId: sid,
  }));
  // Performed behaviors: entry/do/exit actions run while driving the machine.
  const performed: Diagnostic[] = (machine.performed ?? []).map((p, i) => ({
    id: `simulate#perf#${i}`,
    ruleId: 'simulate',
    severity: 'info',
    message: `performed ${p.phase}: ${p.name || `«behavior»`} @ ${stateName(p.stateId)}`,
    elementId: p.actionId,
  }));
  // Value-store rows after the run (transition/behavior effects applied).
  const store: Diagnostic[] = Object.entries(machine.valueStore ?? {}).map(([k, v], i) => ({
    id: `simulate#store#${i}`,
    ruleId: 'simulate',
    severity: 'info',
    message: `store: ${k} = ${fmtStoreValue(v)}`,
    elementId: machine.stateMachine.id,
  }));
  return [header, ...states, ...performed, ...store];
}

/**
 * Build navigable info rows for a numeric-analysis (Solve) run: a header with the
 * solver convergence, one row per solved feature value, and one row per evaluated
 * measure of effectiveness (each navigable to its underlying feature element).
 */
function analysisDiagnostics(model: Model, report: AnalysisReport): Diagnostic[] {
  const header: Diagnostic = {
    id: 'solve#0',
    ruleId: 'solve',
    severity: report.converged ? 'info' : 'warning',
    message: `Solve: ${report.converged ? 'converged' : 'did not converge'} in ${
      report.iterations
    } iteration(s), residual ${report.residual.toExponential(2)}; ${
      report.values.length
    } value(s), ${report.measures.length} measure(s).`,
  };
  const values: Diagnostic[] = report.values.map((v, i) => ({
    id: `solve#value#${i}`,
    ruleId: 'solve',
    severity: 'info',
    message: `value: ${v.element.declaredName || v.element.qualifiedName || v.element.id} = ${v.value}`,
    elementId: v.element.id,
  }));
  const measures: Diagnostic[] = report.measures.map((mo, i) => ({
    id: `solve#moe#${i}`,
    ruleId: 'solve',
    severity: 'info',
    message: `MoE: ${mo.name || mo.id} = ${mo.value ?? '(unknown)'}${
      mo.unit ? ` [${mo.unit}]` : ''
    }${mo.dimension ? ` {${mo.dimension}}` : ''}`,
    elementId: mo.id,
  }));
  // An unjudged relation is not a satisfied one: saying "all satisfied" beside
  // an `unjudged` row below would be the same silent-drop failure in words.
  const unjudged = report.unknowns?.length ?? 0;
  const unjudgedNote = unjudged > 0 ? ` ${unjudged} constraint(s) unjudged.` : '';
  const feasibility: Diagnostic = {
    id: 'solve#feasible',
    ruleId: 'solve',
    severity: report.feasible ? 'info' : 'warning',
    message: report.feasible
      ? `Feasibility: no violated inequality constraint.${unjudgedNote}`
      : `Feasibility: ${report.violations.length} violated constraint(s).${unjudgedNote}`,
  };
  // A STRICT ordering violated exactly at its boundary has an amount of 0 (the
  // violation IS the tie), and "by 0.000" reads as no violation at all — so
  // that row says where it stands instead of quoting the number.
  const violations: Diagnostic[] = report.violations.map((v, i) => ({
    id: `solve#viol#${i}`,
    ruleId: 'solve',
    severity: 'warning',
    message:
      v.amount === 0
        ? `violated ${v.kind}: ${v.expression} (at the boundary)`
        : `violated ${v.kind}: ${v.expression} (by ${v.amount.toPrecision(4)}${
            v.unit ? ` [${v.unit}]` : ''
          })`,
    elementId: v.element.id,
  }));
  // A relation neither engine could judge is REPORTED, not dropped: an
  // information row, because an unjudged constraint is not a violated one.
  const unknowns: Diagnostic[] = (report.unknowns ?? []).map((u, i) => ({
    id: `solve#unknown#${i}`,
    ruleId: 'solve',
    severity: 'info',
    message: `unjudged ${u.kind}: ${u.expression}${u.reason ? ` — ${u.reason}` : ''}`,
    elementId: u.element.id,
  }));
  const rows = [header, feasibility, ...violations, ...unknowns, ...values, ...measures];
  if (report.values.length === 0 && report.measures.length === 0 && report.violations.length === 0) {
    header.message = 'Solve: no parametric constraints or measures to evaluate.';
  }
  return rows;
}

/** Filename + MIME for an export format. */
function exportTarget(fmt: ModelFormat, projectName: string): { filename: string; mime: string } {
  switch (fmt) {
    case 'sysml':
      return { filename: `${projectName}.sysml`, mime: MIME_BY_EXTENSION['.sysml'] };
    case 'api-json':
      return { filename: `${projectName}.api.json`, mime: MIME_BY_EXTENSION['.json'] };
    case 'model-json':
    default:
      return { filename: `${projectName}.json`, mime: MIME_BY_EXTENSION['.json'] };
  }
}

/** Root-name → project name (ignores library roots; falls back to 'Untitled'). */
function deriveProjectName(model: Model): string {
  const firstUser = userRootIds(model)[0];
  const name = firstUser ? model.get(firstUser)?.declaredName : model.roots()[0]?.declaredName;
  return name ?? 'Untitled';
}

/* ─────────────────────────────── Collaboration helpers ──────────────────── */

/** Whimsical, human-readable random self name so peers are distinguishable. */
const SELF_ANIMALS = [
  'Otter', 'Falcon', 'Lynx', 'Heron', 'Maple', 'Cobalt', 'Willow', 'Ember',
  'Comet', 'Basil', 'Cedar', 'Onyx', 'Pika', 'Wren', 'Slate', 'Fern',
];
const SELF_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#469990', '#9a6324', '#800000',
];

/** A random per-session identity. Random by design — not asserted in unit tests. */
function randomSelf(): { name: string; color: string } {
  const rid = Math.random().toString(36).slice(2, 6);
  const name = `${SELF_ANIMALS[Math.floor(Math.random() * SELF_ANIMALS.length)]}-${rid}`;
  const color = SELF_COLORS[Math.floor(Math.random() * SELF_COLORS.length)];
  return { name, color };
}

/** Read the default collab URL (`collabUrl=`) and auto-connect room (`room=`) from the page URL. */
function collabDefaultsFromUrl(): { url: string; room: string | null } {
  let url = 'ws://localhost:1234';
  let room: string | null = null;
  try {
    if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      url = params.get('collabUrl') || url;
      room = params.get('room');
    }
  } catch {
    /* non-browser / opaque location — keep defaults */
  }
  return { url, room };
}

/** Live transport handles kept OUTSIDE React state (never serialized / snapshotted). */
interface CollabRuntime {
  doc: Y.Doc;
  binding: ModelDocBinding;
  conn: CollabConnection;
  onAwareness: () => void;
  onStatus: (e: { status: string }) => void;
  /** Unsubscribe the model listener that refreshes panels on remote CRDT applies. */
  unsubModelRev: () => void;
}
let collabRuntime: CollabRuntime | null = null;

/* ─────────────────────────────── Store factory ──────────────────────────── */

const initialModel = buildSampleModel();
// The app boots with ONLY the user sample so first paint is fast. The full
// standard library (potentially tens of thousands of elements) is merged into
// this same model ASYNCHRONOUSLY right after the store is created — see
// loadStandardLibraryAsync + the `void loadStandardLibraryAsync()` kickoff at
// the bottom of this module — which then binds the sample's textual type
// references (e.g. `mass : Real`) and refreshes the UI. The library shares this
// model instance so the api/server below observe a single source of truth.
const initialApi = new ModelApi(initialModel);
const initialServer = new SysmlApiServer(initialModel);

// Coalesce the per-mutation RECOMPUTE — validation (24 rules), textual
// re-serialization, and the ELK diagram rebuild — into a single pass after a
// burst of edits settles, instead of running all three synchronously on every
// edit (findings C4, C5, L6 — the dominant large-model cost). `rev` is bumped
// immediately (see afterMutation) so model-backed panels (Explorer/Properties)
// stay responsive; the heavier derived state lands one debounce later. The
// explicit `rebuildDiagram()`/`regenerateText()` actions stay immediate, so
// nothing that awaits them is affected.
const RECOMPUTE_DEBOUNCE_MS = 80;
// Hard cap on how long a sustained burst (e.g. continuous remote CRDT applies)
// may postpone the recompute — without it a peer typing faster than the debounce
// would starve this client's diagnostics/text/diagram indefinitely (Fable #1).
const RECOMPUTE_MAX_WAIT_MS = 250;
let recomputeTimer: ReturnType<typeof setTimeout> | null = null;
let recomputeDeadline = 0;
// While a store command that OWNS its derived state (sets diagnostics/text
// synchronously) is mutating the model, suppress the collab model-subscribe
// listener's auto-scheduled recompute — otherwise that listener, which fires
// synchronously from `model.reset`/`resetPreserving`, would re-arm a recompute
// AFTER the command's `cancelRecompute()` and later clobber the command's richer
// diagnostics/text (Fable D2). The listener still bumps `rev` for panel refresh.
let autoRecomputeSuppressed = false;
// Whether any recompute coalesced into the current window must overwrite the
// text buffer even if it is dirty (a local model mutation discards unapplied
// text edits — the historical `afterMutation` behavior); remote CRDT applies
// pass `false` so they never clobber the user's in-progress text edits.
let recomputePendingForce = false;

export const useAppStore = create<AppState>((set, get) => {
  /** Snapshot the current model onto the undo stack and clear redo. */
  function pushUndo(): void {
    const { model, undoStack } = get();
    // Snapshot only the USER model — the ~38.8 k-element standard library is
    // immutable and shared, so cloning it on every edit (up to UNDO_LIMIT deep
    // copies) was the dominant undo cost (finding C6). Restores re-attach the
    // live library via Model.resetPreserving.
    const snap = model.toJSONWhere(isUserEl);
    const next = [...undoStack, snap];
    if (next.length > UNDO_LIMIT) next.splice(0, next.length - UNDO_LIMIT);
    set({ undoStack: next, redoStack: [] });
  }

  /**
   * The coalesced recompute body (C4/C5/L6): refresh diagnostics, re-serialize
   * the textual view (keeps the bidirectional text sync; §5), and rebuild the
   * diagram. `forceText` overwrites the text buffer even when dirty (a local
   * model edit); remote CRDT applies pass `false` to preserve unapplied edits.
   */
  function recomputeNow(forceText: boolean): void {
    const { model, textDirty, textBuffer } = get();
    const patch: Partial<AppState> = { diagnostics: safeValidate(model) };
    if (forceText || !textDirty) Object.assign(patch, textView(model, textBuffer));
    set(patch);
    void get().rebuildDiagram();
  }

  /**
   * Debounce a recompute; `forceText` sticks for the whole coalescing window.
   * The per-burst delay is capped at RECOMPUTE_MAX_WAIT_MS so a long stream of
   * closely-spaced calls can't postpone the recompute forever (Fable #1).
   */
  function scheduleRecompute(forceText: boolean): void {
    recomputePendingForce = recomputePendingForce || forceText;
    const now = Date.now();
    if (recomputeTimer === null) recomputeDeadline = now + RECOMPUTE_MAX_WAIT_MS;
    else clearTimeout(recomputeTimer);
    const wait = Math.max(0, Math.min(RECOMPUTE_DEBOUNCE_MS, recomputeDeadline - now));
    recomputeTimer = setTimeout(() => {
      recomputeTimer = null;
      const force = recomputePendingForce;
      recomputePendingForce = false;
      recomputeNow(force);
    }, wait);
  }

  /**
   * Cancel any pending coalesced recompute. Called by actions that set the
   * derived state (diagnostics / text buffer) SYNCHRONOUSLY and with richer
   * content than the recompute would (parse or analysis diagnostics, applied
   * text) — otherwise a recompute scheduled by an immediately-preceding edit
   * would fire ~80 ms later and silently overwrite that richer state (Fable #2).
   */
  function cancelRecompute(): void {
    if (recomputeTimer !== null) {
      clearTimeout(recomputeTimer);
      recomputeTimer = null;
    }
    recomputePendingForce = false;
  }

  /**
   * Run `mutate` (a model reset/mutation) with the collab subscribe listener's
   * auto-recompute suppressed, so an active collab session can't re-arm a
   * recompute mid-command and later clobber the command's own derived state
   * (Fable D2). Restores the flag even if `mutate` throws.
   */
  function withCommandMutation(mutate: () => void): void {
    autoRecomputeSuppressed = true;
    try {
      mutate();
    } finally {
      autoRecomputeSuppressed = false;
    }
  }

  /**
   * Re-run after any local model mutation: bump `rev` immediately so
   * model-backed panels refresh, then schedule the coalesced recompute
   * (diagnostics + text + diagram). The text buffer is force-refreshed,
   * discarding any unapplied text edits (historical behavior).
   */
  function afterMutation(): void {
    set({ rev: get().rev + 1 });
    scheduleRecompute(true);
  }

  return {
    model: initialModel,
    api: initialApi,
    server: initialServer,

    ...rootSelection(initialModel),
    clipboard: null,
    hoverId: null,
    renamingId: null,
    dragOverId: null,
    pickerId: null,
    focusId: null,
    diagramRootId: null,
    expandedIds: new Set(userRootIds(initialModel)),
    activeView: 'general',
    diagram: null,
    matrix: null,
    analysisConfig: defaultAnalysisConfig(),
    analysis: null,
    dsm: null,
    planConfig: defaultPlanConfig(),
    plan: null,
    regroupConfig: defaultRegroupConfig(),
    scenarios: loadScenarios(),
    regroup: null,
    regroupApply: null,
    simSession: null,
    simTargetId: null,
    simTrace: [],
    simIndex: 0,
    simActiveStates: [],
    simPlaying: false,
    simSolve: false,
    sequence: null,
    grid: null,
    scene: null,
    diagnostics: safeValidate(initialModel),
    textBuffer: '',
    textDirty: false,
    serializeError: null,
    ...textView(initialModel, ''),
    projectName: deriveProjectName(initialModel),
    queryResult: null,
    rev: 0,
    // Flips true once loadStandardLibraryAsync (kicked off below) settles.
    libraryReady: false,

    collab: {
      connected: false,
      room: collabDefaultsFromUrl().room ?? '',
      url: collabDefaultsFromUrl().url,
      self: randomSelf(),
      peers: [],
    },

    // Version-control state. Left empty/lazy so the repository is only seeded
    // when the Versions UI first calls refreshVersions() (keeps deterministic
    // commit ids and avoids eager seeding at module load).
    currentBranchId: '',
    branches: [],
    commits: [],
    mergeResult: null,

    undoStack: [],
    redoStack: [],

    /* ─────────────────────────── Selection / view ─────────────────────── */

    select(id, opts) {
      set((s) => {
        if (id == null) return singleSel(null);
        if (!opts?.additive) return singleSel(id);
        // Additive (⌘/Ctrl/Shift-click): toggle the id in the set; the primary
        // becomes the toggled id (or the last survivor when it was removed).
        const had = s.selectionIds.includes(id);
        const selectionIds = had ? s.selectionIds.filter((x) => x !== id) : [...s.selectionIds, id];
        const selectionId = had ? (selectionIds[selectionIds.length - 1] ?? null) : id;
        return { selectionId, selectionIds };
      });
    },

    setSelection(ids) {
      const { model } = get();
      // Dedup + keep only live ids; primary = the last one.
      const seen = new Set<ElementId>();
      const selectionIds: ElementId[] = [];
      for (const id of ids) {
        if (!seen.has(id) && model.has(id)) {
          seen.add(id);
          selectionIds.push(id);
        }
      }
      set({ selectionId: selectionIds[selectionIds.length - 1] ?? null, selectionIds });
    },

    deleteSelection() {
      const { model, selectionIds } = get();
      const ids = selectionIds.filter((id) => model.has(id));
      if (ids.length === 0) return;
      pushUndo();
      // Removing an ancestor cascades its descendants; the has-guard skips ids
      // already removed by an earlier cascade.
      for (const id of ids) if (model.has(id)) model.remove(id);
      set(singleSel(null));
      afterMutation();
    },

    duplicateSelection() {
      const { model, selectionIds } = get();
      // Only duplicate TOP-LEVEL selections (drop any whose ancestor is also
      // selected — its clone already comes along) and skip relationships.
      const selected = new Set(selectionIds);
      const ids = selectionIds.filter((id) => {
        const el = model.get(id);
        if (!el || isRelationship(el.eClass)) return false;
        return !model.ancestors(id).some((a) => selected.has(a.id));
      });
      if (ids.length === 0) return;
      const redoBefore = get().redoStack;
      pushUndo();
      const newRoots: ElementId[] = [];
      try {
        for (const id of ids) {
          const nid = duplicateSubtree(model, id);
          if (nid) newRoots.push(nid);
        }
      } catch {
        // Roll back partial clones, drop the empty undo entry, restore redo, and
        // refresh derived state (unreachable with plain JSON attrs; defensive).
        const { undoStack } = get();
        const snap = undoStack[undoStack.length - 1];
        if (snap) withCommandMutation(() => model.resetPreserving(snap, isLibraryEl));
        set({ undoStack: undoStack.slice(0, -1), redoStack: redoBefore });
        afterMutation();
        return;
      }
      set({ selectionId: newRoots[newRoots.length - 1] ?? null, selectionIds: newRoots });
      afterMutation();
    },

    copySelection() {
      const { model, selectionIds } = get();
      const ids = selectionIds.filter((id) => model.has(id) && !isRelationship(model.get(id)!.eClass));
      if (ids.length === 0) return;
      try {
        set({ clipboard: collectSubtrees(model, ids) });
      } catch {
        // A structuredClone of non-cloneable attrs (unreachable with plain JSON
        // attrs) — copy is read-only, so just leave the clipboard untouched.
      }
    },

    pasteClipboard(ownerId) {
      const { model, clipboard, selectionId } = get();
      if (!clipboard || clipboard.records.length === 0) return [];
      // Default target: the primary selection (paste as its children); fall back
      // to the root when nothing valid is selected.
      const target = ownerId !== undefined ? ownerId : selectionId;
      const redoBefore = get().redoStack;
      pushUndo();
      let roots: ElementId[];
      try {
        roots = pasteSubtrees(model, clipboard, target && model.has(target) ? target : null);
      } catch {
        const { undoStack } = get();
        const snap = undoStack[undoStack.length - 1];
        if (snap) withCommandMutation(() => model.resetPreserving(snap, isLibraryEl));
        set({ undoStack: undoStack.slice(0, -1), redoStack: redoBefore });
        afterMutation();
        return [];
      }
      if (roots.length === 0) {
        // Nothing survived (e.g. a payload of only now-dangling relationships) —
        // roll back to the snapshot, drop the empty undo entry, restore redo.
        const { undoStack } = get();
        const snap = undoStack[undoStack.length - 1];
        if (snap) withCommandMutation(() => model.resetPreserving(snap, isLibraryEl));
        set({ undoStack: undoStack.slice(0, -1), redoStack: redoBefore });
        afterMutation();
        return [];
      }
      set((s) => {
        const expandedIds = new Set(s.expandedIds);
        if (target && model.has(target)) expandedIds.add(target);
        return { expandedIds, selectionId: roots[roots.length - 1], selectionIds: roots };
      });
      afterMutation();
      return roots;
    },

    setHover(id) {
      if (get().hoverId !== id) set({ hoverId: id });
    },

    setRenamingId(id) {
      if (get().renamingId !== id) set({ renamingId: id });
    },

    setDragOverId(id) {
      if (get().dragOverId !== id) set({ dragOverId: id });
    },

    setPickerId(id) {
      if (get().pickerId !== id) set({ pickerId: id });
    },

    setDiagramRoot(id) {
      if (get().diagramRootId === id) return;
      set({ diagramRootId: id });
      void get().rebuildDiagram();
    },

    setFocusId(id) {
      if (get().focusId !== id) set({ focusId: id });
    },

    toggleExpand(id) {
      set((s) => {
        const next = new Set(s.expandedIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { expandedIds: next };
      });
    },

    expand(id, open = true) {
      set((s) => {
        const next = new Set(s.expandedIds);
        if (open) next.add(id);
        else next.delete(id);
        return { expandedIds: next };
      });
    },

    setActiveView(v) {
      set({ activeView: v });
      void get().rebuildDiagram();
    },

    setAnalysisConfig(patch) {
      set((s) => ({ analysisConfig: { ...s.analysisConfig, ...patch } }));
      // Fast path: node-size scale/contrast only re-map radii (O(n)); they don't
      // touch topology, so skip the expensive rebuild (Louvain + force layout)
      // — critical for the size sliders, which fire per drag step.
      const keys = Object.keys(patch);
      const sizeOnly =
        keys.length > 0 && keys.every((k) => k === 'sizeScale' || k === 'sizeContrast');
      const { analysis, analysisConfig } = get();
      if (sizeOnly && analysis) {
        set({ analysis: restyleNodeSizes(analysis, analysisConfig.sizeScale, analysisConfig.sizeContrast) });
        return;
      }
      void get().rebuildDiagram();
    },

    setPlanConfig(patch) {
      set((s) => ({ planConfig: { ...s.planConfig, ...patch } }));
      void get().rebuildDiagram();
    },

    setRegroupConfig(patch) {
      set((s) => ({ regroupConfig: { ...s.regroupConfig, ...patch } }));
      void get().rebuildDiagram();
    },

    saveScenario(name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      // Deep-copy so later edits don't mutate the saved snapshot.
      const scenarios = { ...get().scenarios, [trimmed]: structuredClone(get().regroupConfig) };
      set({ scenarios });
      persistScenarios(scenarios);
    },

    loadScenario(name) {
      const saved = get().scenarios[name];
      if (!saved) return;
      set({ regroupConfig: structuredClone(saved) });
      void get().rebuildDiagram();
    },

    deleteScenario(name) {
      if (!(name in get().scenarios)) return;
      const scenarios = { ...get().scenarios };
      delete scenarios[name];
      set({ scenarios });
      persistScenarios(scenarios);
    },

    seedRegroup() {
      const { model, regroupConfig } = get();
      try {
        set({ regroupConfig: seedRegroupFromClusters(model, regroupConfig.partKind) });
      } catch (err) {
        console.error('seedRegroup failed', err);
        return;
      }
      void get().rebuildDiagram();
    },

    regroupFromCluster(nodeIds, label) {
      const { model, regroupConfig } = get();
      let config: RegroupConfig;
      try {
        config = seedRegroupFromNodeIds(model, regroupConfig.partKind, nodeIds, label);
      } catch (err) {
        console.error('regroupFromCluster failed', err);
        return;
      }
      // Switch to the workbench AND install the seeded config in one update, then
      // rebuild the (pure) regroup preview + apply plan for the new active view.
      set({ activeView: 'regroup', regroupConfig: config });
      void get().rebuildDiagram();
    },

    applyRegroup() {
      const { model, regroupConfig } = get();
      // Fresh pre-validation against the CURRENT model (the cached plan could
      // predate a collab/remote edit). Errors ⇒ refuse with zero mutation.
      let plan: RegroupApplyPlan;
      try {
        plan = planApply(model, regroupConfig);
      } catch (err) {
        console.error('applyRegroup: planning failed', err);
        return;
      }
      set({ regroupApply: plan });
      if (plan.errors.length > 0) {
        console.error('applyRegroup refused:', plan.errors.join(' | '));
        return;
      }
      const { newParts, moves, ports, rewires } = plan.summary;
      if (newParts === 0 && moves === 0 && ports === 0 && rewires === 0) return; // nothing to do
      // pushUndo clears the redo stack; keep it so a FAILED apply (which is a
      // no-op once rolled back) doesn't destroy the user's redo history.
      const redoBefore = get().redoStack;
      pushUndo();
      try {
        // One event batch; atomicity comes from the snapshot restore below —
        // model.transaction does NOT roll back on throw.
        model.transaction(() => applyRegroupOps(model, plan));
        // The config is consumed: the next preview starts fresh over the new shape.
        set({ regroupConfig: defaultRegroupConfig() });
        afterMutation();
      } catch (err) {
        console.error('applyRegroup failed', err);
        // Multi-step mutation may have partially landed: restore the snapshot
        // we just pushed (exactly like undo()'s restore), pop it, and put the
        // redo stack back. The model is now byte-identical to its pre-apply
        // state, so the existing `regroup` preview/diagram projections are
        // still accurate — no rebuild; instead surface the failure in the
        // plan-errors strip so the UI is never silent about a failed apply.
        cancelRecompute();
        const snapshot = get().undoStack[get().undoStack.length - 1];
        withCommandMutation(() => model.resetPreserving(snapshot, isLibraryEl));
        set((s) => ({
          undoStack: s.undoStack.slice(0, -1),
          redoStack: redoBefore,
          diagnostics: safeValidate(model),
          ...textView(model, s.textBuffer),
          rev: s.rev + 1,
          regroupApply: {
            ...plan,
            errors: [`Apply failed — the model was restored, nothing was changed: ${String(err)}`],
          },
        }));
      }
    },

    /**
     * Recompute the projection for the active view. Graph views
     * (general/interconnection/action/state/requirement/tree/parametric/case)
     * are built with {@link buildDiagram} + laid out with {@link layoutDiagram}
     * into `diagram`; the non-graph views project into their own state:
     * 'allocation' → {@link buildAllocationMatrix} into `matrix`, 'sequence' →
     * {@link buildSequence} into `sequence`, 'grid' → {@link buildGrid} into `grid`,
     * 'planning' → {@link buildPlan} into `plan`, 'geometry' →
     * {@link buildGeometryScene} into `scene` (rendered by the lazy Three.js
     * `Geometry3DView`).
     */
    async rebuildDiagram() {
      const { model, activeView } = get();

      if (activeView === 'allocation') {
        try {
          set({ matrix: buildAllocationMatrix(model) });
        } catch (err) {
          console.error('rebuildDiagram (allocation) failed', err);
          set({ matrix: { rowElements: [], colElements: [], cells: [], relKind: 'allocate' } });
        }
        return;
      }

      if (activeView === 'sequence') {
        try {
          set({ sequence: buildSequence(model) });
        } catch (err) {
          console.error('rebuildDiagram (sequence) failed', err);
          set({ sequence: { lifelines: [], messages: [] } });
        }
        return;
      }

      if (activeView === 'grid') {
        try {
          set({ grid: buildGrid(model) });
        } catch (err) {
          console.error('rebuildDiagram (grid) failed', err);
          set({ grid: { columns: [], rows: [] } });
        }
        return;
      }

      if (activeView === 'requirements') {
        // The requirements table is MODEL-BACKED: the RequirementsTable panel
        // reads the live model + `rev` and re-derives its rows itself. There is
        // no projection to compute here, so nothing to build.
        return;
      }

      if (activeView === 'analysis') {
        const { analysisConfig } = get();
        try {
          // `analysis` also backs the config-strip stats, so build it in both
          // modes; build the DSM (a second independent Louvain) only when its
          // mode is active, so a DSM-order change never re-runs the force layout.
          set({
            analysis: buildGraphAnalysis(model, analysisConfig),
            dsm: analysisConfig.mode === 'dsm' ? buildDSM(model, analysisConfig) : null,
          });
        } catch (err) {
          console.error('rebuildDiagram (analysis) failed', err);
          set({ analysis: null, dsm: null });
        }
        return;
      }

      if (activeView === 'planning') {
        try {
          set({ plan: buildPlan(model, get().planConfig) });
        } catch (err) {
          console.error('rebuildDiagram (planning) failed', err);
          set({ plan: null });
        }
        return;
      }

      if (activeView === 'regroup') {
        // Read-only preview: planRegroup AND planApply are pure — the apply
        // PLAN (op list + summary + errors) is just derived state here.
        try {
          const regroupConfig = get().regroupConfig;
          set({
            regroup: planRegroup(model, regroupConfig),
            regroupApply: planApply(model, regroupConfig),
          });
        } catch (err) {
          console.error('rebuildDiagram (regroup) failed', err);
          set({ regroup: null, regroupApply: null });
        }
        return;
      }

      if (activeView === 'geometry') {
        try {
          set({ scene: buildGeometryScene(model) });
        } catch (err) {
          console.error('rebuildDiagram (geometry) failed', err);
          set({
            scene: {
              items: [],
              bounds: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 0, y: 0, z: 0 },
                center: { x: 0, y: 0, z: 0 },
                size: { x: 0, y: 0, z: 0 },
              },
            },
          });
        }
        return;
      }

      // Graph views (including 'case') build a React Flow projection.
      try {
        // A scope root of null is the whole user model — the long-standing
        // default, kept so every existing view and e2e behaves unchanged.
        const scoped = validDiagramRoot(get().diagramRootId, model);
        if (scoped !== get().diagramRootId) set({ diagramRootId: scoped });
        const rootId = scoped ?? undefined;
        const graph = buildDiagram(model, activeView, rootId);
        const laid = await layoutDiagram(graph);
        set({ diagram: laid });
      } catch (err) {
        console.error('rebuildDiagram failed', err);
        set({ diagram: { nodes: [], edges: [], viewKind: get().activeView } });
      }
    },

    /* ───────────────────────────── Mutations ──────────────────────────── */

    createElement(eClass, ownerId, name) {
      const { model } = get();
      const owner = ownerId !== undefined ? ownerId : get().selectionId;
      // Guard: only nest under an existing owner; otherwise create at root.
      const ownerArg = owner && model.has(owner) ? owner : null;
      pushUndo();
      const el = model.create(eClass, {
        declaredName: name,
        ownerId: ownerArg,
      });
      set((s) => {
        const expandedIds = new Set(s.expandedIds);
        if (ownerArg) expandedIds.add(ownerArg);
        return { expandedIds, ...singleSel(el.id) };
      });
      afterMutation();
      return el.id;
    },

    updateElement(id, patch) {
      const { model } = get();
      if (!model.has(id)) return;
      pushUndo();
      model.update(id, patch);
      afterMutation();
    },

    setAttr(id, key, value) {
      const { model } = get();
      const el = model.get(id);
      if (!el) return;
      // A note body is written into the file with no escaping, and the notation
      // gives the sequence that ENDS a note no escape at all:
      // written back it would close the note early and the rest of the value
      // would be read as declarations. So it must not be stored either. The
      // panels ask `isWritableNoteBody` first and put the reason on the box;
      // this is the backstop for every other caller, and it refuses BEFORE
      // pushUndo so a refused write costs no undo step.
      const isNote = key === 'body' || (key === 'text' && isRequirement(el.eClass));
      if (isNote && !isWritableNoteBody(value)) {
        console.error('setAttr refused', UNWRITABLE_NOTE_BODY_REFUSAL);
        return;
      }
      pushUndo();
      // A hand-edited value invalidates the parser's source lexeme for it.
      model.setAttrs(id, key === 'value' ? { value, valueText: undefined } : { [key]: value });
      afterMutation();
    },

    setRequirementShortId(id, value) {
      const { model } = get();
      const el = model.get(id);
      if (!el) return;
      // Same refusal as the facet commands: undo keeps library elements
      // verbatim, so an edit to one would outlive its own undo step.
      if (el.attrs.isLibrary === true) return;
      const next = value === null || value === '' ? undefined : value;
      // Not a change: the id the controls SHOW is the one coming back. The
      // comparison is on the displayed value, not the raw slot, because the
      // grid commits on blur whether or not a key was pressed, and a blank
      // `<''>` id — displayed as '' — would otherwise be read as "clear it"
      // and the file would lose the `<''>` it held. A snapshot here would
      // also spend an undo step on a model that never moved — and the
      // Properties box calls this on every keystroke, including the ones that
      // re-type the current value.
      if (requirementShortId(model, id) === (next ?? '')) return;
      const redoBefore = get().redoStack;
      pushUndo();
      try {
        semSetRequirementShortId(model, id, next);
        afterMutation();
      } catch (err) {
        // The writer validates before it mutates (a non-requirement, or one
        // under a faulted declaration, is refused whole), so there is nothing
        // to undo: drop the snapshot, keep the redo.
        console.error('setRequirementShortId failed', err);
        set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: redoBefore }));
      }
    },

    setRequirementAttr(id, key, value) {
      const { model } = get();
      const el = model.get(id);
      if (!el) return;
      // The standard library is not the user's to edit, and undo could not take
      // the edit back if it were: `resetPreserving(snap, isLibraryEl)` restores
      // a snapshot while keeping every library element exactly as it stands, so
      // a facet written onto one would outlive its own undo step.
      if (el.attrs.isLibrary === true) return;
      // A clear of a key that is not set changes nothing. Pushing a snapshot for
      // it would spend an undo step on a model that never moved and throw the
      // redo stack away with it — the same early return duplicateElement and
      // reparentMany make when there is nothing to do.
      const clearing = value === undefined || value === null || value === '';
      if (clearing && !hasRequirementAttr(model, id, key)) return;
      // pushUndo clears redo; keep it so a REFUSED write doesn't destroy the
      // user's redo history — same shape as reparent().
      const redoBefore = get().redoStack;
      pushUndo();
      try {
        semSetRequirementAttr(model, id, key, value);
        afterMutation();
      } catch (err) {
        // The write validates before it mutates, so there is nothing to undo:
        // drop the snapshot and put the redo stack back. Surfacing the reason
        // is the panel's job — the store's job is not to leave a phantom step.
        console.error('setRequirementAttr failed', err);
        set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: redoBefore }));
      }
    },

    setStatementKind(id, kind) {
      const { model } = get();
      const el = model.get(id);
      if (!el) return;
      // Same two refusals setRequirementAttr makes, for the same reasons: undo
      // restores a snapshot while keeping library elements verbatim, so an edit
      // to one would outlive its own undo step; and a clear of a kind nobody
      // wrote changes nothing, so it must not spend an undo step and throw the
      // redo stack away with it.
      if (el.attrs.isLibrary === true) return;
      // `hasRequirementAttr` answers "is a kind keyword actually WRITTEN here",
      // which is the question, and it is not requirement-only for this key —
      // reusing it beats a second copy of the keyword scan in the UI layer.
      const tagged = hasRequirementAttr(model, id, 'statementKind');
      if (kind === null && !tagged) return;
      if (kind !== null && tagged && kind === statementKindOf(model, id)) return;
      const redoBefore = get().redoStack;
      pushUndo();
      try {
        if (kind === null) semClearStatementKind(model, id);
        else semSetStatementKind(model, id, kind);
        afterMutation();
      } catch (err) {
        // `setStatementKind` validates before it mutates (it refuses a notation
        // with nowhere to put the keyword), so there is nothing to undo.
        console.error('setStatementKind failed', err);
        set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: redoBefore }));
      }
    },

    deleteElement(id) {
      const { model } = get();
      if (!model.has(id)) return;
      pushUndo();
      const removed = model.remove(id);
      const removedSet = new Set(removed);
      set((s) => {
        const selectionIds = s.selectionIds.filter((x) => !removedSet.has(x));
        const selectionId =
          s.selectionId && !removedSet.has(s.selectionId)
            ? s.selectionId
            : (selectionIds[selectionIds.length - 1] ?? null);
        return { selectionId, selectionIds };
      });
      afterMutation();
    },

    duplicateElement(id) {
      const { model } = get();
      const root = model.get(id);
      if (!root) return null;
      // A relationship has no meaningful subtree — cloning it just makes a
      // redundant parallel edge. The node context menu already forbids this
      // (node-only); keep the Ctrl/⌘+D path consistent.
      if (isRelationship(root.eClass)) return null;
      const redoBefore = get().redoStack;
      pushUndo();
      let newRootId: ElementId | null;
      try {
        newRootId = duplicateSubtree(model, id);
      } catch {
        // A structuredClone of non-cloneable attrs (unreachable with plain JSON
        // attrs, but defensive) could throw mid-clone. Roll the partial clones
        // back to the snapshot we just pushed, drop that now-empty undo entry,
        // restore the redo stack pushUndo cleared, and refresh derived state.
        const { undoStack } = get();
        const snap = undoStack[undoStack.length - 1];
        if (snap) withCommandMutation(() => model.resetPreserving(snap, isLibraryEl));
        set({ undoStack: undoStack.slice(0, -1), redoStack: redoBefore });
        afterMutation();
        return null;
      }
      if (!newRootId) return null;
      set((s) => {
        const expandedIds = new Set(s.expandedIds);
        if (root.ownerId) expandedIds.add(root.ownerId);
        return { expandedIds, ...singleSel(newRootId) };
      });
      afterMutation();
      return newRootId;
    },

    reparent(id, ownerId) {
      const { model } = get();
      if (!model.has(id)) return;
      const redoBefore = get().redoStack;
      try {
        pushUndo();
        model.reparent(id, ownerId);
        if (ownerId) get().expand(ownerId, true);
        afterMutation();
      } catch (err) {
        // Illegal reparent (cycle / self): roll the snapshot back off the stack
        // and restore the redo stack pushUndo cleared (don't destroy redo history).
        console.error('reparent failed', err);
        set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: redoBefore }));
      }
    },

    reparentMany(ids, ownerId) {
      const { model } = get();
      // Reduce to subtree roots first: reparenting must move whole subtrees, not
      // flatten them (a set holding both a parent and its descendant would
      // otherwise rip the descendant out and re-own it directly). Then keep only
      // elements that exist and would actually change owner.
      const targets = subtreeRoots(model, ids).filter(
        (id) => model.has(id) && model.get(id)?.ownerId !== ownerId,
      );
      if (targets.length === 0) return;
      // Capture redo so a fully-failed call doesn't destroy the user's redo
      // history (pushUndo clears it) — matches duplicateSelection/duplicateElement.
      const redoBefore = get().redoStack;
      pushUndo();
      let moved = 0;
      for (const id of targets) {
        try {
          model.reparent(id, ownerId);
          moved++;
        } catch (err) {
          // Skip an individual illegal move (self / cycle); the rest still apply.
          console.error('reparent failed', err);
        }
      }
      if (moved === 0) {
        // Nothing actually changed — drop the snapshot we just pushed and
        // restore the redo stack pushUndo cleared.
        set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: redoBefore }));
        return;
      }
      if (ownerId) get().expand(ownerId, true);
      afterMutation();
    },

    connect(sourceId, targetId, kind) {
      const { model } = get();
      if (!model.has(sourceId) || !model.has(targetId)) {
        throw new Error('connect: source or target does not exist');
      }
      pushUndo();
      const ownerId = model.get(sourceId)?.ownerId ?? null;
      const edge = model.create(kind, {
        ownerId,
        source: [sourceId],
        target: [targetId],
      });
      set(singleSel(edge.id));
      afterMutation();
      return edge.id;
    },

    /* ─────────────────────────── Validation / text ────────────────────── */

    runValidation() {
      cancelRecompute();
      set({ diagnostics: safeValidate(get().model) });
    },

    /**
     * Run the KerML constraint/requirement checker and surface every result in
     * the Problems list: satisfied → info, violated → warning, unknown → info,
     * each navigable to its owning constraint. Structural validation findings
     * are kept, but the validator's own `constraint-violation` rows are dropped
     * here to avoid double-listing the constraints we re-report in full.
     */
    runConstraintCheck() {
      cancelRecompute();
      const { model } = get();
      const base = safeValidate(model).filter((d) => d.ruleId !== 'constraint-violation');
      let report;
      try {
        report = constraintReport(model);
      } catch (err) {
        console.error('constraint check failed', err);
        report = { total: 0, satisfied: 0, violated: 0, unknown: 0, constraints: [] };
      }
      const constraintDiags: Diagnostic[] = report.constraints.map((c, i) => ({
        id: `constraint-check#${i}`,
        ruleId: 'constraint-check',
        severity: c.result === 'violated' ? 'warning' : 'info',
        message:
          c.result === 'satisfied'
            ? `Constraint satisfied: ${c.expression}`
            : c.result === 'violated'
              ? c.message
              : `Constraint could not be evaluated ("${c.expression}"): ${c.message}.`,
        elementId: c.id,
      }));
      set({ diagnostics: [...base, ...constraintDiags] });
    },

    /**
     * Simulate the active behavior and surface its trace in the Problems list as
     * navigable info rows (each row selects the underlying action/state element).
     *
     * Target selection: the current selection when it is itself a runnable action
     * flow or state machine; otherwise the first candidate matching the active
     * view (a state machine for the 'state' view, an action flow for the 'action'
     * view), falling back to any runnable behavior. State machines are driven with
     * the trigger alphabet discovered on their transitions. Uses
     * {@link executionReport} (which runs the semantics engine) so the console/UI
     * and the REST `/analytics/execution` route show identical traces.
     */
    simulate() {
      cancelRecompute();
      const { model, activeView, selectionId } = get();
      let report;
      try {
        report = executionReport(model);
      } catch (err) {
        console.error('simulate failed', err);
        set({
          diagnostics: [
            { id: 'simulate#err', ruleId: 'simulate', severity: 'error', message: 'Simulation failed.' },
          ],
        });
        return;
      }
      const { actionFlows, stateMachines } = report;

      // Prefer an exact selection match, then the active view's kind, then any.
      let flow = selectionId ? actionFlows.find((f) => f.action.id === selectionId) : undefined;
      let machine = selectionId
        ? stateMachines.find((m) => m.stateMachine.id === selectionId)
        : undefined;
      if (!flow && !machine) {
        if (activeView === 'state') machine = stateMachines[0];
        else if (activeView === 'action') flow = actionFlows[0];
        else {
          flow = actionFlows[0];
          if (!flow) machine = stateMachines[0];
        }
      }

      let diags: Diagnostic[];
      if (machine && (activeView === 'state' || !flow)) {
        diags = stateMachineDiagnostics(model, machine);
      } else if (flow) {
        diags = actionFlowDiagnostics(flow);
      } else if (machine) {
        diags = stateMachineDiagnostics(model, machine);
      } else {
        diags = [
          {
            id: 'simulate#none',
            ruleId: 'simulate',
            severity: 'info',
            message: 'Nothing to simulate: no runnable action flow or state machine in the model.',
          },
        ];
      }
      set({ diagnostics: diags });
    },

    /**
     * Solve the model's numeric parametric constraints and evaluate its measures
     * of effectiveness ({@link analysisReport}, which runs the semantics solver),
     * surfacing the solved values / MoE results in the Problems list as navigable
     * info rows (each selects its underlying feature). Drives the parametric
     * view's "Solve" affordance and mirrors the REST `/analytics/analysis` route.
     */
    solveParametric() {
      cancelRecompute();
      const { model } = get();
      let report: AnalysisReport;
      try {
        report = analysisReport(model);
      } catch (err) {
        console.error('solve failed', err);
        set({
          diagnostics: [
            { id: 'solve#err', ruleId: 'solve', severity: 'error', message: 'Solve failed.' },
          ],
        });
        return;
      }
      set({ diagnostics: analysisDiagnostics(model, report) });
    },

    /* ── Interactive simulation (Phase 2) ── */

    simStart(id) {
      const { model } = get();
      let targetId = id ?? get().simTargetId ?? null;
      if (!targetId || !semIsSimulatable(model, targetId)) {
        targetId = outermostSimulatable(model);
      }
      if (!targetId) {
        set({
          simSession: null,
          simTargetId: null,
          simTrace: [],
          simIndex: 0,
          simActiveStates: [],
          simPlaying: false,
        });
        return;
      }
      // A fresh session over the LIVE model (not the cached SDK api, which can
      // hold a stale model after new/open). Its constructor captures sample 0.
      const session = new SimulationSession(model, targetId, { solve: get().simSolve });
      const last = session.trace[session.trace.length - 1];
      set({
        simSession: session,
        simTargetId: targetId,
        // A FRESH array reference each capture so trace-keyed memos recompute
        // (SimulationSession.trace returns its live, in-place-mutated samples).
        simTrace: session.trace.slice(),
        simIndex: session.trace.length - 1,
        simActiveStates: last ? last.activeStates.slice() : [],
        simPlaying: false,
      });
    },

    simInject(event) {
      const { simSession: s, simTargetId, model } = get();
      if (!s) return;
      if (!simTargetId || !model.has(simTargetId)) return void get().simStop(); // target gone
      const sample = s.inject(event);
      set({ simTrace: s.trace.slice(), simIndex: sample.index, simActiveStates: sample.activeStates.slice() });
    },

    simAdvance(dt = 1) {
      const { simSession: s, simTargetId, model } = get();
      if (!s) return;
      if (!simTargetId || !model.has(simTargetId)) return void get().simStop(); // target gone
      const sample = s.advance(dt);
      set({ simTrace: s.trace.slice(), simIndex: sample.index, simActiveStates: sample.activeStates.slice() });
    },

    simSeek(index) {
      const t = get().simTrace;
      if (t.length === 0) return;
      const i = Math.max(0, Math.min(index, t.length - 1));
      set({ simIndex: i, simActiveStates: t[i].activeStates.slice() });
    },

    simReset() {
      const { simSession: s, simTargetId, model } = get();
      if (!s) return;
      if (!simTargetId || !model.has(simTargetId)) return void get().simStop(); // target gone
      const s0 = s.reset();
      set({
        simTrace: s.trace.slice(),
        simIndex: s0.index,
        simActiveStates: s0.activeStates.slice(),
        simPlaying: false,
      });
    },

    simSetPlaying(playing) {
      set({ simPlaying: playing });
    },

    simSetSolve(on) {
      set({ simSolve: on });
      const { simSession, simTargetId, simTrace } = get();
      if (!simSession || !simTargetId) return;
      // Rebuild the driving script from the current trace so toggling solve mode
      // REPLAYS the run (a fresh session with the new mode) instead of losing it.
      const script = simTrace.slice(1).map((s, i) => {
        const step: { event?: string; advance?: number } = {};
        if (s.event) step.event = s.event;
        const dt = s.clock - simTrace[i].clock;
        if (dt > 0) step.advance = dt;
        return step;
      });
      get().simStart(simTargetId); // fresh session in the new solve mode (captures sample 0)
      const s = get().simSession;
      if (s && script.length > 0) {
        s.run(script);
        const last = s.trace[s.trace.length - 1];
        set({
          simTrace: s.trace.slice(),
          simIndex: s.trace.length - 1,
          simActiveStates: last ? last.activeStates.slice() : [],
        });
      }
    },

    simStop() {
      set({
        simSession: null,
        simTargetId: null,
        simTrace: [],
        simIndex: 0,
        simActiveStates: [],
        simPlaying: false,
      });
    },

    setTextBuffer(text) {
      // User keystrokes supersede a pending FORCED recompute (from a just-made
      // canvas/tree edit): downgrade it so it refreshes diagnostics/diagram but
      // no longer overwrites the buffer the user is now typing into (Fable D3).
      recomputePendingForce = false;
      set({ textBuffer: text, textDirty: true });
    },

    applyText() {
      // While the model cannot be written, the buffer is the LAST text that
      // could be written — an older model. Parsing it here would replace the
      // live model with a text that never described it, on one click, silently.
      // A buffer the user has EDITED is a different thing: applying it is their
      // explicit intent and it is the way out of the state, so the refusal is
      // only over the buffer nobody typed into.
      if (get().serializeError !== null && !get().textDirty) return;
      if (get().simSession) get().simStop(); // replacing the model orphans the sim target
      cancelRecompute();
      const { model, textBuffer } = get();
      const result = parseModel(textBuffer);
      lastParse = result;
      pushUndo();
      // Replace the live model's contents in place (keeps api/server bound).
      withCommandMutation(() => model.reset(result.model.toJSON()));
      const parseDiags = result.diagnostics.map(parseDiagToDiagnostic);
      const validationDiags = safeValidate(model);
      set((s) => ({
        diagnostics: [...parseDiags, ...validationDiags],
        textDirty: false,
        // The model now IS this text, so anything that could not be written
        // before is gone with the model that held it: nothing the parser
        // produces can carry a note body or a multiplicity that closes its own
        // delimiter. Leaving the old reason standing would keep refusing the
        // apply that just succeeded.
        serializeError: null,
        rev: s.rev + 1,
        projectName: deriveProjectName(model),
        ...validSelection(s, model),
        expandedIds: new Set(userRootIds(model)),
      }));
      void get().rebuildDiagram();
      // model.reset dropped the library; re-merge it and bind type references
      // asynchronously so the (potentially large) library never blocks the edit.
      void loadStandardLibraryAsync();
    },

    regenerateText() {
      set(textView(get().model, get().textBuffer));
    },

    /* ───────────────────────────── Projects ───────────────────────────── */

    newProject(name = 'NewModel') {
      if (get().simSession) get().simStop(); // a new model orphans the sim target
      const { model } = get();
      pushUndo();
      // Clear the USER model but keep the already-loaded standard library in
      // place (so `mass : Real` still resolves in the fresh project, and an
      // undo of New restores the prior user model beside the same library — C6).
      model.resetPreserving(EMPTY_SNAPSHOT, isLibraryEl);
      const root = model.create('Package', { declaredName: name });
      set((s) => ({
        projectName: name,
        ...singleSel(root.id),
        expandedIds: new Set([root.id]),
        queryResult: null,
        rev: s.rev + 1,
      }));
      afterMutation();
    },

    async saveProject(name) {
      const { model, projectName } = get();
      const target = name ?? projectName;
      await projectStore.saveProject(target, model.toJSON());
      set({ projectName: target });
    },

    async loadProject(name) {
      const data = await projectStore.loadProject(name);
      if (!data) throw new Error(`No such project: ${name}`);
      const { model } = get();
      pushUndo();
      forgetParseResult(); // the loaded model did not come from the open text
      model.reset(data);
      set((s) => ({
        projectName: name,
        ...rootSelection(model),
        expandedIds: new Set(userRootIds(model)),
        queryResult: null,
        rev: s.rev + 1,
      }));
      afterMutation();
      // (Re)load the library when the saved project predates library support
      // (a no-op merge when it already carries one) and bind references — done
      // asynchronously so a large library never blocks the load.
      void loadStandardLibraryAsync();
    },

    async listProjects() {
      return projectStore.listProjects();
    },

    /* ───────────────────────────── Import / export ────────────────────── */

    importModel(text, fmt) {
      if (get().simSession) get().simStop(); // importing replaces the model → orphans the sim target
      cancelRecompute();
      const { model } = get();
      const result = ioImportModel(text, fmt);
      forgetParseResult(); // an import carries no retractable parse result
      pushUndo();
      withCommandMutation(() => model.reset(result.model.toJSON()));
      const parseDiags = (result.diagnostics ?? []).map(parseDiagToDiagnostic);
      set((s) => ({
        diagnostics: [...parseDiags, ...safeValidate(model)],
        projectName: deriveProjectName(model),
        ...rootSelection(model),
        expandedIds: new Set(userRootIds(model)),
        queryResult: null,
        ...textView(model, s.textBuffer),
        rev: s.rev + 1,
      }));
      void get().rebuildDiagram();
      // Merge the standard library (when the import didn't carry one) and bind
      // the imported model's type references against it — asynchronously.
      void loadStandardLibraryAsync();
    },

    importFmi(xml) {
      const parsed = parseModelDescription(xml);
      if (!parsed.valid) {
        // Not a real FMI modelDescription — don't silently create a junk block.
        set({
          diagnostics: [
            {
              id: 'fmi-import#invalid',
              ruleId: 'fmi-import',
              severity: 'error',
              message: 'Not a valid FMI modelDescription.xml (no <fmiModelDescription> root).',
            },
          ],
        });
        return;
      }
      const { model } = get();
      const redoBefore = get().redoStack;
      try {
        pushUndo();
        const id = importFmiBlock(model, parsed); // ADDS a block (does not replace)
        set(singleSel(id));
        afterMutation();
      } catch (err) {
        console.error('FMI import failed', err);
        set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: redoBefore }));
      }
    },

    exportModel(fmt) {
      const { model, projectName } = get();
      let text: string;
      try {
        text = ioExportModel(model, fmt);
      } catch (err) {
        // The SysML export runs the same serializer as the Text view, so it can
        // refuse for the same reason — and this is called straight from a
        // Toolbar click handler and a command, neither of which has anywhere to
        // catch a throw (the app has no error boundary). Record the refusal
        // where the Text view shows it, export nothing, and let the Problems
        // panel name the offending element.
        console.error('export failed', err);
        set({ serializeError: serializeRefusal(err) });
        return '';
      }
      const { filename, mime } = exportTarget(fmt, projectName);
      try {
        downloadText(filename, text, mime);
      } catch (err) {
        // No DOM (e.g. unit test) — still return the serialized text.
        console.error('downloadText failed', err);
      }
      return text;
    },

    /* ────────────────────────────── Query ─────────────────────────────── */

    runQuery(query) {
      const result = evaluateQuery(get().model, query);
      set({ queryResult: result });
      return result;
    },

    /* ─────────────────────────── Collaboration ────────────────────────── */

    connectCollab(room, url) {
      // Reconnecting: always tear down any prior session first (idempotent).
      get().disconnectCollab();
      const trimmed = room.trim();
      if (!trimmed) return;

      const { model, collab } = get();
      const useUrl = (url && url.trim()) || collab.url || 'ws://localhost:1234';
      const self = collab.self;

      let doc: Y.Doc;
      let binding: ModelDocBinding;
      let conn: CollabConnection;
      try {
        doc = new Y.Doc();
        binding = bindModelToDoc(model, doc);
        conn = collabConnect(doc, { url: useUrl, room: trimmed, user: self });
      } catch (err) {
        console.error('connectCollab failed', err);
        return;
      }

      // Awareness → peers: whenever presence changes, re-read remote peers and
      // bump `rev` so model-backed panels (Explorer remote-selection rings) refresh.
      const onAwareness = () => {
        set((s) => ({
          collab: { ...s.collab, peers: readPeers(conn.awareness) },
          rev: s.rev + 1,
        }));
      };
      conn.awareness.on('change', onAwareness);

      // Transport status → connected flag.
      const onStatus = (e: { status: string }) => {
        set((s) => ({ collab: { ...s.collab, connected: e.status === 'connected' } }));
      };
      conn.provider.on('status', onStatus);

      // Remote CRDT applies mutate the shared Model directly (via the doc→model
      // observer inside bindModelToDoc) WITHOUT going through a store command, so
      // they never bump `rev`. Subscribe to the model so any change — local OR
      // remote — refreshes the model-backed panels (Explorer tree, Properties,
      // remote-selection rings). Cheap (a counter bump); the doc observer batches
      // each remote update into a single model transaction → one event batch here.
      const unsubModelRev = model.subscribe(() => {
        // A remote (or non-command) change may have removed a selected element;
        // re-validate so `selectionIds`/`selectionId` never retain a dead id.
        // Preserve a deliberately-empty selection (don't force-select a root),
        // and rely on validSelection's identity-stable no-op path to avoid churn.
        set((s) =>
          s.selectionId == null && s.selectionIds.length === 0
            ? { rev: s.rev + 1 }
            : { rev: s.rev + 1, ...validSelection(s, model) },
        );
        // Remote (or local-non-command) applies changed the model → refresh the
        // derived views too, coalesced. `false`: never clobber unapplied text
        // edits (C5/L6 — replaces the old TextEditor regenerate-on-rev effect).
        // Suppressed while a command owns its derived state (D2).
        if (!autoRecomputeSuppressed) scheduleRecompute(false);
      });

      collabRuntime = { doc, binding, conn, onAwareness, onStatus, unsubModelRev };

      // Publish our current selection to peers immediately.
      setLocalSelection(conn.awareness, get().selectionId);

      set((s) => ({
        collab: {
          ...s.collab,
          room: trimmed,
          url: useUrl,
          connected: Boolean((conn.provider as { wsconnected?: boolean }).wsconnected),
          peers: readPeers(conn.awareness),
        },
        rev: s.rev + 1,
      }));
    },

    disconnectCollab() {
      const rt = collabRuntime;
      collabRuntime = null;
      if (rt) {
        try {
          rt.unsubModelRev();
        } catch {
          /* ignore */
        }
        try {
          rt.conn.awareness.off('change', rt.onAwareness);
        } catch {
          /* ignore */
        }
        try {
          (rt.conn.provider as { off?: (ev: string, cb: unknown) => void }).off?.('status', rt.onStatus);
        } catch {
          /* ignore */
        }
        try {
          rt.conn.disconnect();
        } catch {
          /* ignore */
        }
        try {
          rt.binding.unbind();
        } catch {
          /* ignore */
        }
        try {
          rt.doc.destroy();
        } catch {
          /* ignore */
        }
      }
      set((s) => ({
        collab: { ...s.collab, connected: false, peers: [] },
        rev: s.rev + 1,
      }));
    },

    /* ─────────────────────────── Version control ──────────────────────── */

    /**
     * Repopulate the Versions UI from {@link ModelApi.repository}: the branch
     * list and the commit history of the current branch. Seeds `currentBranchId`
     * to the repository's `main` branch on first call (this is also what triggers
     * lazy repository seeding).
     */
    refreshVersions() {
      const { api } = get();
      const repo = api.repository; // seeds the working project on first access
      const branchId = get().currentBranchId || api.branchId;
      set({
        currentBranchId: branchId,
        branches: repo.listBranches(api.projectId),
        commits: repo.listCommits(api.projectId, branchId),
      });
    },

    /**
     * Snapshot the live working model as a new immutable Commit on the current
     * branch (advancing its head), then refresh the Versions UI. The api/server
     * stay bound to the same live model.
     */
    commitVersion(description) {
      const { api } = get();
      const repo = api.repository;
      const branchId = get().currentBranchId || api.branchId;
      const count = repo.listCommits(api.projectId, branchId).length;
      repo.commit(api.projectId, branchId, get().model, description ?? `Snapshot ${count}`);
      get().refreshVersions();
    },

    /**
     * Branch from the current branch's head, then switch the UI to the new
     * branch. The working model is unchanged (the new head is the same commit).
     */
    createBranchCmd(name) {
      const { api } = get();
      const repo = api.repository;
      const from = get().currentBranchId || api.branchId;
      const head = repo.getBranch(from)?.headCommitId;
      const branch = repo.createBranch(api.projectId, name, head);
      set({ currentBranchId: branch.id });
      get().refreshVersions();
    },

    /**
     * Switch the current branch and load THAT branch's head into the live
     * working model (via `model.reset`, keeping api/server bound), then refresh
     * the diagram / text / validation. Re-merges the standard library
     * asynchronously (a no-op when the snapshot already carries one).
     */
    switchBranch(branchId) {
      const { api, model } = get();
      const branch = api.repository.getBranch(branchId);
      if (!branch) return;
      if (get().simSession) get().simStop(); // switching branches replaces the model
      cancelRecompute();
      pushUndo();
      forgetParseResult(); // the branch head did not come from the open text
      withCommandMutation(() =>
        model.reset(api.repository.getModelAtCommit(branch.headCommitId).toJSON()),
      );
      set((s) => ({
        currentBranchId: branchId,
        diagnostics: safeValidate(model),
        ...textView(model, s.textBuffer),
        projectName: deriveProjectName(model),
        ...rootSelection(model),
        expandedIds: new Set(userRootIds(model)),
        queryResult: null,
        rev: s.rev + 1,
      }));
      void get().rebuildDiagram();
      get().refreshVersions();
      void loadStandardLibraryAsync();
    },

    /**
     * Three-way merge `sourceBranchId` (theirs) into `targetBranchId` (ours) via
     * the repository engine. Stores the result (merge-commit id + per-element
     * conflicts). On a resolving strategy that produced a commit, also switch to
     * the target branch and load the merge-commit model into the live workspace.
     */
    mergeBranchesCmd(sourceBranchId, targetBranchId, strategy) {
      const { api } = get();
      const result = api.repository.mergeBranches(api.projectId, sourceBranchId, targetBranchId, {
        strategy,
      });
      set({
        mergeResult: {
          commitId: result.commit?.id,
          conflicts: result.conflicts,
        },
      });
      if (result.applied && result.commit) {
        // Target head now points at the merge commit; switchBranch loads it.
        get().switchBranch(targetBranchId);
      } else {
        get().refreshVersions();
      }
    },

    /* ──────────────────────────── Undo / redo ─────────────────────────── */

    undo() {
      const { model, undoStack, redoStack } = get();
      if (undoStack.length === 0) return;
      cancelRecompute();
      const snapshot = undoStack[undoStack.length - 1];
      const current = model.toJSONWhere(isUserEl);
      withCommandMutation(() => model.resetPreserving(snapshot, isLibraryEl));
      set((s) => ({
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, current].slice(-UNDO_LIMIT),
        diagnostics: safeValidate(model),
        ...textView(model, s.textBuffer),
        projectName: deriveProjectName(model),
        ...validSelection(s, model),
        rev: s.rev + 1,
      }));
      void get().rebuildDiagram();
    },

    redo() {
      const { model, undoStack, redoStack } = get();
      if (redoStack.length === 0) return;
      cancelRecompute();
      const snapshot = redoStack[redoStack.length - 1];
      const current = model.toJSONWhere(isUserEl);
      withCommandMutation(() => model.resetPreserving(snapshot, isLibraryEl));
      set((s) => ({
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack, current].slice(-UNDO_LIMIT),
        diagnostics: safeValidate(model),
        ...textView(model, s.textBuffer),
        projectName: deriveProjectName(model),
        ...validSelection(s, model),
        rev: s.rev + 1,
      }));
      void get().rebuildDiagram();
    },
  };
});

/* ─────────────────────── Collaboration wiring (post-store) ───────────────── */

// Push the local selection to peers whenever it changes (drives remote-selection
// highlights on every collaborator's Explorer). Only active while connected.
let lastPushedSelection: ElementId | null = null;
useAppStore.subscribe((state) => {
  if (collabRuntime && state.selectionId !== lastPushedSelection) {
    lastPushedSelection = state.selectionId;
    try {
      setLocalSelection(collabRuntime.conn.awareness, state.selectionId);
    } catch (err) {
      console.error('collab: pushing selection failed', err);
    }
  }
});

// Auto-connect when the page URL carries a `room=` (used by the E2E two-user
// test and by anyone opening a shared-room link). Deferred a tick so the store
// is fully initialized first. No-op under unit tests (no `room=` query).
{
  const { room: autoRoom, url: autoUrl } = collabDefaultsFromUrl();
  if (autoRoom) {
    void Promise.resolve().then(() => {
      try {
        useAppStore.getState().connectCollab(autoRoom, autoUrl);
      } catch (err) {
        console.error('collab auto-connect failed', err);
      }
    });
  }
}

/* ─────────────────────── Asynchronous standard-library load ──────────────── */

/**
 * The most recent `parseModel` result, kept so its warnings can be RETRACTED
 * once the library binder settles. Null whenever the live model did not come
 * from parsing text (an import, a loaded project).
 */
let lastParse: ParseResult | null = null;

/**
 * Forget the retained parse result — call it from EVERY path that replaces the
 * live model without parsing the open text.
 *
 * `lastParse` outlives one `applyText`, and `refreshAfterLibraryLoad` runs a
 * few hundred milliseconds later, so a load/branch switch in between made the
 * refresh rebuild the Problems panel from the PREVIOUS document: rows with the
 * old file's line numbers, about text that is no longer open. Retraction could
 * not drop them either — its elements are gone from the model, and a warning
 * whose element it cannot find is kept, not retracted. Hence a named call
 * rather than an assignment: a future `model.reset` + `loadStandardLibraryAsync`
 * pair has something to copy.
 */
function forgetParseResult(): void {
  lastParse = null;
}

/**
 * The parse rows to keep after the library binder has run.
 *
 * Carrying them over verbatim left a permanent, FALSE "Unresolved reference"
 * in the Problems panel for every reference only the standard library can
 * resolve: the warning was true when the parse published it and untrue a few
 * hundred milliseconds later, and nothing took it back. `checkText` already
 * retracted those; the panel did not, so the app disagreed with its own CLI.
 * Retraction needs the parse RESULT (which reference each warning belongs to),
 * not the widened diagnostics, so the last one is kept — and when there is none
 * (an import, a loaded project) the rows are carried over as before.
 */
function retainedParseRows(current: Diagnostic[], model: Model): Diagnostic[] {
  if (!lastParse) return current.filter((d) => d.ruleId === 'parse');
  const kept = new Set(retractResolvedSpecializationWarnings(model, lastParse));
  // Widen with the ORIGINAL index so a retracted row does not renumber the ids
  // the Problems panel is keyed on.
  return lastParse.diagnostics
    .map((d, i) => ({ diag: d, row: parseDiagToDiagnostic(d, i) }))
    .filter(({ diag }) => kept.has(diag))
    .map(({ row }) => row);
}

/**
 * Refresh derived UI state after the library has been merged/bound.
 *
 * PARSE diagnostics are carried over. `applyText` publishes the parser's errors
 * and then kicks off the (asynchronous) library merge; this refresh used to land
 * a few hundred ms later with a validation-only diagnostics list and silently
 * erase them, so applying malformed notation replaced the user's model and
 * reported NOTHING. Validation findings are recomputed here because the merged
 * library can change them; parse findings describe the TEXT, which the merge did
 * not touch, so they must survive it. They are dropped on the next real model
 * mutation (`recomputeNow`), where they would genuinely be stale.
 */
function refreshAfterLibraryLoad(): void {
  const { model } = useAppStore.getState();
  useAppStore.setState((s) => {
    const parseRows = retainedParseRows(s.diagnostics, model);
    // A FAULTED APPLY KEEPS THE USER'S TEXT. Re-serializing the model here
    // replaced the buffer the user typed with the model recovery made of it —
    // for a file with a syntax error that means their text is REPLACED by a
    // partial reading of it, in a refresh that lands a few hundred ms after
    // the apply, with no undo of its own. So when a parse ERROR is standing
    // (warnings do not count: a forward reference is normal and would freeze
    // the buffer forever), the text is left alone and marked dirty, because
    // the model genuinely was not regenerated from it.
    const faulted = parseRows.some((d) => d.ruleId === 'parse' && d.severity === 'error');
    return {
      diagnostics: [...parseRows, ...safeValidate(model)],
      ...(faulted ? { textDirty: true } : textView(model, s.textBuffer)),
      rev: s.rev + 1,
    };
  });
  void useAppStore.getState().rebuildDiagram();
}

/**
 * Merge the FULL standard library into the live model and bind every
 * outstanding type reference, then refresh the UI.
 *
 * The library JSON is pulled via a DYNAMIC import so it is code-split into a
 * lazy chunk and never blocks first paint: the app renders the user sample
 * immediately, and this runs afterwards (idempotent, so re-calling it after an
 * apply/import/load never duplicates the library). Falls back to the curated
 * subset when the full bundle cannot be loaded. Errors are swallowed (logged)
 * so a library hiccup never breaks the interactive app.
 */
async function loadStandardLibraryAsync(): Promise<void> {
  try {
    try {
      const { loadFullStandardLibrary, preloadFullLibrary } = await import('../library/full-library');
      // Fetch the library data ASSET (emitted out of the JS graph) before the
      // synchronous merge. In the browser this fetches the Vite-emitted
      // `stdlib-<hash>.json`; a fetch/parse failure throws here and drops us into
      // the curated-subset fallback below.
      await preloadFullLibrary();
      const { model } = useAppStore.getState();
      loadFullStandardLibrary(model); // idempotent: skips when a library is present
      resolveTypeReferences(model);
      // Connector endpoints chained through freshly-bound library types.
      resolveConnectorFeatureChains(model);
      refreshAfterLibraryLoad();
    } catch (err) {
      console.error('full standard library unavailable; loading curated subset', err);
      try {
        const { loadCuratedLibrary } = await import('../library/standard-library');
        const { model } = useAppStore.getState();
        if (!model.all().some((e) => e.attrs.isLibrary === true)) loadCuratedLibrary(model);
        resolveTypeReferences(model);
        resolveConnectorFeatureChains(model);
        refreshAfterLibraryLoad();
      } catch (err2) {
        console.error('curated standard-library fallback failed', err2);
      }
    }
  } finally {
    // However the merge resolved (full library, curated fallback, or a total
    // failure), the model is now in its final settled shape: unblock the app.
    // This is what makes the interactive model DETERMINISTIC — the library is
    // present BEFORE window.sysml / the diagram-canvas appear, so tests (and
    // users) never see counts drift as the library merges in mid-session.
    if (!useAppStore.getState().libraryReady) useAppStore.setState({ libraryReady: true });
  }
}

// Kick off the asynchronous library load once, right after the store exists, so
// the app is interactive with the user sample first and gains the full library
// (and resolved types) a moment later.
void loadStandardLibraryAsync();
