/**
 * `ModelApi` — the ergonomic in-browser TypeScript SDK over a {@link Model}.
 *
 * This is the headline data-analysis & automation surface (plan §6.1). It wraps a
 * single mutable {@link Model} and exposes navigation, type/name lookup, graph
 * traversal, mutation passthroughs, batched commits, and an OMG-API JSON
 * serializer (`toElementJSON`) that mirrors the wire shape described in
 * docs/02-omg-standard-reference.md §5.4. Intended to be exposed on
 * `globalThis.sysml` for console scripting.
 */

import {
  type ElementId,
  type ElementRecord,
  type Model,
  type CreateElementOptions,
  isRelationship,
} from '@core/index';
import { modelCommitId } from './query';
import { unitReport, type UnitReport } from './analytics';
import {
  ProjectRepository,
  type Branch,
  type Commit,
  type CommitDiff,
  type Tag,
} from './versioning';
import { convert, areCompatible, UNIT_REGISTRY } from '@semantics/units';
import { evaluateQuantity as semEvaluateQuantity, type Quantity } from '@semantics/units-eval';
import {
  effectiveFeaturesWithLibrary as semEffectiveFeatures,
  conforms as semConforms,
  checkConstraints as semCheckConstraints,
  isKindOf as semIsKindOf,
  resolveQualifiedNameFull as semResolveQualifiedNameFull,
  runActionFlow as semRunActionFlow,
  runStateMachine as semRunStateMachine,
  executeBehavior as semExecuteBehavior,
  simulateStateMachine as semSimulate,
  SimulationSession as SemSimulationSession,
  isSimulatable as semIsSimulatable,
  discoverTriggers as semDiscoverTriggers,
  evaluateModel as semEvaluateModel,
  executeModel as semExecuteModel,
  solve as semSolve,
  solveFeasible as semSolveFeasible,
  evaluateMoEs as semEvaluateMoEs,
  optimize as semOptimize,
  type ConstraintCheck,
  type ExecutionTrace,
  type StateRunResult,
  type BehaviorExecution,
  type ExecuteBehaviorOptions,
  type ModelEvaluation,
  type ModelExecution,
  type SimStep,
  type SimTrace,
  type SimOptions,
  type SolveOptions,
  type SolveResult,
  type FeasibilityOptions,
  type FeasibilityResult,
  type MeasureResult,
  type OptimizeOptions,
  type OptimizeResult,
} from '../semantics/index';

/** Direction for {@link ModelApi.traverse}. */
export type TraverseDir = 'out' | 'in' | 'both';

/** OMG-API element JSON shape (reified-relationship form, §5.4). */
export interface OmgElementJSON {
  '@id': string;
  '@type': string;
  identifier: string;
  declaredName?: string;
  declaredShortName?: string;
  /** References to owned relationship elements. */
  ownedRelationship: Array<{ '@id': string }>;
  /** References to owned member (non-relationship child) elements. */
  ownedMember: Array<{ '@id': string }>;
  /** Back-reference to the owner element (containment), if any. */
  owner?: { '@id': string };
  /** Relationship endpoints (only for relationship/edge elements). */
  source?: Array<{ '@id': string }>;
  target?: Array<{ '@id': string }>;
  /** Metaclass-specific fields ride along (open `additionalProperties`). */
  [key: string]: unknown;
}

export class ModelApi {
  /** Monotonic mutation counter; feeds deterministic commit ids (no Date/random). */
  private counter = 0;

  /** Lazily-seeded version-control repository (see {@link repository}). */
  private _repository?: ProjectRepository;
  private _projectId?: string;
  private _branchId?: string;

  constructor(public readonly model: Model) {}

  /* ───────────────────────────── Versioning ─────────────────────────────── */

  /**
   * The version-control {@link ProjectRepository} backing this SDK, lazily
   * created on first access and seeded with a `working` project whose `main`
   * branch holds an initial commit snapshotting the current model. Subsequent
   * {@link commit} calls append immutable commits and advance the branch head.
   * Lazy so the many transient `new ModelApi(...)` instances (rest/oslc facades)
   * pay nothing unless they actually use versioning.
   */
  get repository(): ProjectRepository {
    if (!this._repository) {
      this._repository = new ProjectRepository();
      const project = this._repository.createProject('working', this.model);
      this._projectId = project.id;
      this._branchId = project.defaultBranchId;
    }
    return this._repository;
  }

  /** Id of the working project in {@link repository}. */
  get projectId(): string {
    void this.repository; // ensure seeded
    return this._projectId!;
  }

  /** Id of the active branch (the project's `main` by default). */
  get branchId(): string {
    void this.repository; // ensure seeded
    return this._branchId!;
  }

  /** The id of the active branch's head commit. */
  headCommitId(): string {
    return this.repository.getBranch(this.branchId)!.headCommitId;
  }

  /** Commits on the active branch, oldest → newest (the branch history). */
  history(): Commit[] {
    return this.repository.listCommits(this.projectId, this.branchId);
  }

  /**
   * Element-level diff of the branch head against its immediate predecessor,
   * or `undefined` when the head is the project's initial commit.
   */
  diffWithPrevious(): CommitDiff | undefined {
    const headCommit = this.repository.getCommit(this.headCommitId())!;
    if (!headCommit.previousCommitId) return undefined;
    return this.repository.diff(headCommit.previousCommitId, headCommit.id);
  }

  /** Create a new branch off the current head commit. */
  createBranch(name: string): Branch {
    return this.repository.createBranch(this.projectId, name, this.headCommitId());
  }

  /** Attach an immutable named tag to the current head commit. */
  tag(name: string): Tag {
    return this.repository.createTag(this.projectId, name, this.headCommitId());
  }

  /* ───────────────────────────── Navigation ─────────────────────────────── */

  getElement(id: ElementId): ElementRecord | undefined {
    return this.model.get(id);
  }

  /**
   * All elements whose metaclass is one of `eClasses`, from the USER's model.
   *
   * The bundled standard library is excluded by default. It contributes ~38,700
   * elements, so an agent asking "how many part definitions are in my model"
   * used to be answered mostly about the library — 1,011 AttributeDefinitions
   * for an 8-element model. Pass `includeLibrary` to search it deliberately,
   * e.g. to discover the ISQ quantity kinds.
   */
  elementsOfType(...eClasses: string[]): ElementRecord[];
  elementsOfType(opts: { includeLibrary: boolean }, ...eClasses: string[]): ElementRecord[];
  elementsOfType(
    first: string | { includeLibrary: boolean },
    ...rest: string[]
  ): ElementRecord[] {
    const includeLibrary = typeof first === 'object' ? first.includeLibrary : false;
    const eClasses = typeof first === 'object' ? rest : [first, ...rest];
    const found = this.model.ofKind(...eClasses);
    return includeLibrary ? found : found.filter((el) => el.attrs.isLibrary !== true);
  }

  /** How many bundled standard-library elements are loaded alongside the model. */
  libraryElementCount(): number {
    return this.model.all().filter((el) => el.attrs.isLibrary === true).length;
  }

  /** Resolve an element by qualified name (`Pkg::Sub::part`). */
  byName(qname: string): ElementRecord | undefined {
    return this.model.resolveQualifiedName(qname);
  }

  children(id: ElementId): ElementRecord[] {
    return this.model.children(id);
  }

  owner(id: ElementId): ElementRecord | undefined {
    return this.model.owner(id);
  }

  /** Ancestor chain from immediate owner up to the root. */
  ancestors(id: ElementId): ElementRecord[] {
    return this.model.ancestors(id);
  }

  /** Depth-first descendants (excluding the element itself). */
  descendants(id: ElementId): ElementRecord[] {
    return this.model.descendants(id);
  }

  /**
   * Root elements of the USER's model.
   *
   * The bundled library contributes ~188 roots of its own; returning them made
   * `roots()` useless for "what did I write". Pass `includeLibrary` for the
   * unfiltered list.
   */
  roots(opts: { includeLibrary?: boolean } = {}): ElementRecord[] {
    const all = this.model.roots();
    return opts.includeLibrary === true ? all : all.filter((r) => r.attrs.isLibrary !== true);
  }

  /**
   * Traverse edges of metaclass `relKind` from `id` and return the connected
   * elements at the far endpoint(s). `dir` selects which endpoint `id` sits on:
   *  - `out`  — follow edges whose `source` includes `id` → return targets.
   *  - `in`   — follow edges whose `target` includes `id` → return sources.
   *  - `both` — union of the two.
   * Uses endpoint-bearing elements (KerML relationships AND edge-like usages such
   * as ConnectionUsage/Flow/Succession/Transition), matching the core edge model.
   */
  traverse(id: ElementId, relKind: string, dir: TraverseDir = 'out'): ElementRecord[] {
    const out = new Map<ElementId, ElementRecord>();
    const collect = (ids: ElementId[] | undefined) => {
      for (const tid of ids ?? []) {
        if (tid === id) continue;
        const el = this.model.get(tid);
        if (el) out.set(tid, el);
      }
    };
    if (dir === 'out' || dir === 'both') {
      for (const e of this.model.edgesFrom(id)) {
        if (e.eClass === relKind) collect(e.target);
      }
    }
    if (dir === 'in' || dir === 'both') {
      for (const e of this.model.edgesTo(id)) {
        if (e.eClass === relKind) collect(e.source);
      }
    }
    return [...out.values()];
  }

  /* ───────────────────────────── Semantics ──────────────────────────────── */

  /**
   * The effective feature set of a type (KerML inheritance): own features first,
   * then features inherited from every general type — INCLUDING the implicit
   * standard-library base types (e.g. `Base::Anything`, `Parts::Part`) — with
   * redefinition resolution (a redefining feature masks the inherited one it
   * redefines). Uses {@link effectiveFeaturesWithLibrary} so library-inherited
   * features are surfaced.
   */
  effectiveFeatures(id: ElementId): ElementRecord[] {
    return semEffectiveFeatures(this.model, id);
  }

  /**
   * Resolve a (possibly qualified) name to the element it denotes, following the
   * complete KerML scoping rules — owned, inherited (incl. implicit library
   * bases) and imported members — via {@link resolveQualifiedNameFull}. A single
   * `A::B::C` walk that also resolves import-stripped bundled-library names such
   * as `ISQ::MassValue`. Returns `undefined` when nothing matches.
   */
  resolveName(qname: string): ElementRecord | undefined {
    return semResolveQualifiedNameFull(this.model, qname);
  }

  /**
   * True iff `specificId` conforms to (is the same as, or transitively
   * specializes) `generalId` — the KerML specialization/subtyping test.
   */
  conforms(specificId: ElementId, generalId: ElementId): boolean {
    return semConforms(this.model, specificId, generalId);
  }

  /**
   * Evaluate every ConstraintUsage / RequirementUsage carrying a boolean
   * expression, classifying each as satisfied / violated / unknown.
   */
  checkConstraints(): ConstraintCheck[] {
    return semCheckConstraints(this.model);
  }

  /**
   * True iff metaclass `metaclass` is the same as, or a reflexive-transitive
   * subtype of, `superMetaclass` in the OMG metaclass generalization lattice
   * (e.g. `isKindOf('PartUsage', 'Feature')` → true). A pure metamodel query;
   * no {@link Model} lookup is involved.
   */
  isKindOf(metaclass: string, superMetaclass: string): boolean {
    return semIsKindOf(metaclass, superMetaclass);
  }

  /* ───────────────────────────── Execution ──────────────────────────────── */

  /**
   * Simulate the control/object flow of the action `actionId`: order its
   * contained ActionUsages and control nodes by their Succession edges, tag
   * fork/join parallel regions, choose true-guard decision branches, and stop at
   * a DoneNode. Returns the visited-node trace.
   */
  runActionFlow(actionId: ElementId): ExecutionTrace {
    return semRunActionFlow(this.model, actionId);
  }

  /**
   * Drive the state machine rooted at `stateId` against a `triggers` sequence,
   * firing the first enabled TransitionUsage per trigger, and return the visited
   * state sequence + fired transitions + final state.
   */
  runStateMachine(stateId: ElementId, triggers: string[]): StateRunResult {
    return semRunStateMachine(this.model, stateId, triggers);
  }

  /**
   * TIME-STEPPED simulation of the state machine `stateId`: drive it with a
   * `script` of named events + `{ advance }` time steps and get back a serialisable
   * time-series ({@link SimTrace}) — per step: clock, active states, value
   * snapshot, transitions fired, and live constraint status. For interactive
   * play/step/reset, use {@link simulationSession} instead. See {@link semSimulate}.
   */
  simulate(stateId: ElementId, script: SimStep[] = [], opts?: SimOptions): SimTrace {
    return semSimulate(this.model, stateId, script, opts);
  }

  /** Create a stateful, interactive {@link SemSimulationSession} for `stateId`. */
  simulationSession(stateId: ElementId, opts?: SimOptions): SemSimulationSession {
    return new SemSimulationSession(this.model, stateId, opts);
  }

  /** Is `id` a state machine that can be time-stepped? */
  isSimulatable(id: ElementId): boolean {
    return semIsSimulatable(this.model, id);
  }

  /** The injectable event alphabet of the state machine `id`. */
  simulationTriggers(id: ElementId): string[] {
    return semDiscoverTriggers(this.model, id);
  }

  /**
   * Unified behavior execution: dispatch `id` to the action-flow or
   * state-machine interpreter based on the element and return a single
   * {@link BehaviorExecution}. Applies the fuller semantics — composite/call
   * sub-behavior recursion and item-flow data passing for actions; hierarchical,
   * orthogonal and timed execution (named triggers + `{ advance }` time steps)
   * for state machines. See {@link executeBehavior}.
   */
  executeBehavior(id: ElementId, opts?: ExecuteBehaviorOptions): BehaviorExecution {
    return semExecuteBehavior(this.model, id, opts);
  }

  /**
   * Evaluate feature values/expressions across the whole model (literals, bound
   * values, and derived/dependent expressions to a fixpoint) and check every
   * constraint/requirement. See {@link ModelEvaluation}.
   */
  evaluateModel(): ModelEvaluation {
    return semEvaluateModel(this.model);
  }

  /**
   * Execute the whole model with the fuller execution semantics: propagate
   * connector & binding values ({@link propagateValues}), evaluate
   * feature/expression values, run every top-level behavior (action flows +
   * state machines) capturing their value stores / loop iterations / performed
   * behaviors, and check all constraints. See {@link ModelExecution}.
   */
  executeModel(): ModelExecution {
    return semExecuteModel(this.model);
  }

  /* ─────────────────────────── Numeric solving ──────────────────────────── */

  /**
   * Solve the model's numeric constraint system — ConstraintUsage/
   * CalculationUsage `lhs = rhs` bodies, feature-value expression assignments,
   * and BindingConnector equalities — seeding literal values and iterating
   * constraint + binding propagation to a fixpoint, finishing coupled residuals
   * with a bounded Newton step. Returns solved feature values + convergence.
   */
  solve(opts?: SolveOptions): SolveResult {
    return semSolve(this.model, opts);
  }

  /**
   * Find variable values satisfying the model's equalities AND inequality
   * constraints ({@link solveFeasible}): seeds from {@link solve}, then minimises a
   * penalty over the free variables. Returns the solved values, whether every
   * inequality holds, and the violated inequalities with their amounts.
   */
  solveFeasible(opts?: FeasibilityOptions): FeasibilityResult {
    return semSolveFeasible(this.model, opts);
  }

  /**
   * Evaluate the model's measures of effectiveness (features owned by an
   * AnalysisCase/VerificationCase, flagged `attrs.isMoe`, named
   * MoE/measure/objective, or an analysis-case objective/return parameter)
   * against a whole-model {@link solve}, with unit + dimension where known.
   */
  evaluateMoEs(): MeasureResult[] {
    return semEvaluateMoEs(this.model);
  }

  /**
   * Gradient-free optimization of the objective feature `objectiveId` over the
   * bounded design variables `variableIds` (coordinate descent + golden-section
   * line search), re-solving the constraint system at each trial. `sense`
   * selects minimise (default) / maximise.
   */
  optimize(objectiveId: ElementId, variableIds: ElementId[], opts?: OptimizeOptions): OptimizeResult {
    return semOptimize(this.model, objectiveId, variableIds, opts);
  }

  /* ───────────────────────────────── Units ──────────────────────────────── */

  /**
   * Convert `magnitude` from `fromUnit` to `toUnit` (each a long unit name or
   * symbol, e.g. `convertUnit(1500, 'kg', 't')` → `1.5`). Applies the affine SI
   * maps so temperature scales round-trip. Throws when a unit is unknown or the
   * two units' dimensions differ.
   */
  convertUnit(magnitude: number, fromUnit: string, toUnit: string): number {
    return convert(magnitude, fromUnit, toUnit);
  }

  /**
   * Evaluate a feature's value as a {@link Quantity} — its magnitude, physical
   * dimension, and (when known) the unit it is expressed in. Returns `undefined`
   * when the feature carries no numeric value.
   */
  evaluateQuantity(featureId: ElementId): Quantity | undefined {
    return semEvaluateQuantity(this.model, featureId);
  }

  /**
   * Dimensional-analysis report over every quantity-valued feature (magnitude,
   * unit, dimension, quantity kind, and unit/kind dimensional consistency).
   */
  dimensionalAnalysis(): UnitReport {
    return unitReport(this.model);
  }

  /**
   * The registry unit symbols dimensionally compatible with `unit` (i.e. the
   * units a magnitude in `unit` may be converted to). Empty when `unit` is
   * unknown.
   */
  compatibleUnits(unit: string): string[] {
    return UNIT_REGISTRY.filter((u) => areCompatible(u, unit)).map((u) => u.symbol);
  }

  /* ───────────────────────────── Mutation ───────────────────────────────── */

  /** Create an element (passthrough to the model). */
  create(eClass: string, opts: CreateElementOptions = {}): ElementRecord {
    return this.model.create(eClass, opts);
  }

  /** Update an element (passthrough to the model). */
  update(
    id: ElementId,
    patch: Partial<Omit<ElementRecord, 'id' | 'ownerId'>>,
  ): ElementRecord {
    return this.model.update(id, patch);
  }

  /** Delete an element (cascades by default); returns removed ids. */
  delete(id: ElementId, opts: { cascade?: boolean } = {}): ElementId[] {
    return this.model.remove(id, opts);
  }

  /** Reparent an element to a new owner (or root). */
  reparent(id: ElementId, newOwnerId: ElementId | null): ElementRecord {
    return this.model.reparent(id, newOwnerId);
  }

  /**
   * Two forms over one name (both backward-compatible & deterministic):
   *
   *  - `commit(fn)` — **batch mutation**: run `fn` inside a single model
   *    transaction (one change notification) and return a deterministic commit
   *    id derived from model size + an internal monotonic counter (never
   *    Date.now/Math.random). This is the original signature.
   *  - `commit(description?)` — **version snapshot**: append the current model
   *    as a new immutable {@link Commit} on the active branch (advancing its
   *    head) in {@link repository}, and return that commit.
   */
  commit(fn: (api: ModelApi) => void): string;
  commit(description?: string): Commit;
  commit(arg?: string | ((api: ModelApi) => void)): string | Commit {
    if (typeof arg === 'function') {
      this.counter++;
      this.model.transaction(() => arg(this));
      return this.commitId();
    }
    return this.repository.commit(this.projectId, this.branchId, this.model, arg);
  }

  /** The current deterministic commit id for this api instance's model. */
  commitId(): string {
    return modelCommitId(this.model, this.counter);
  }

  /* ─────────────────────────── Serialization ────────────────────────────── */

  /**
   * Serialize one element to the OMG-API JSON shape (§5.4): flat `@id`/`@type`,
   * reified `ownedRelationship`/`ownedMember` references, an `owner` back-link,
   * relationship endpoints as `{'@id'}` refs, and metaclass attributes spread as
   * open additional properties.
   */
  toElementJSON(id: ElementId): OmgElementJSON | undefined {
    const el = this.model.get(id);
    if (!el) return undefined;

    const ownedRelationship: Array<{ '@id': string }> = [];
    const ownedMember: Array<{ '@id': string }> = [];
    for (const child of this.model.children(id)) {
      if (isRelationship(child.eClass)) ownedRelationship.push({ '@id': child.id });
      else ownedMember.push({ '@id': child.id });
    }

    const json: OmgElementJSON = {
      '@id': el.id,
      '@type': el.eClass,
      identifier: el.id,
      ownedRelationship,
      ownedMember,
    };
    if (el.declaredName !== undefined) json.declaredName = el.declaredName;
    if (el.declaredShortName !== undefined) json.declaredShortName = el.declaredShortName;
    if (el.ownerId !== null) json.owner = { '@id': el.ownerId };
    if (el.source) json.source = el.source.map((s) => ({ '@id': s }));
    if (el.target) json.target = el.target.map((t) => ({ '@id': t }));
    // Spread metaclass-specific attributes as open additional properties.
    for (const [k, v] of Object.entries(el.attrs)) {
      if (json[k] === undefined) json[k] = v;
    }
    return json;
  }

  /**
   * Serialize the USER's model as an array of OMG element JSON objects.
   *
   * Library content is excluded by default: including it turned a small model
   * into a ~38,700-element dump, which is neither what an agent asked for nor
   * something it can afford to read.
   */
  toModelJSON(opts: { includeLibrary?: boolean } = {}): OmgElementJSON[] {
    const all =
      opts.includeLibrary === true
        ? this.model.all()
        : this.model.all().filter((el) => el.attrs.isLibrary !== true);
    return all.map((el) => this.toElementJSON(el.id)!);
  }
}
