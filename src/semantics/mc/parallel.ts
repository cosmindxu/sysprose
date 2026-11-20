/**
 * The explorer's reading of a parallel state (SysML v2 §7.18.2) — the SAME reading `runHierRegion`
 * (`../execute.ts`) performs, so that `reach` and `check-behaviour` decide the machine the simulator runs.
 *
 * WHAT IS EXPLORED. A parallel state `p` nested in an ordinary machine, entered as a whole. A configuration that is in
 * `p` carries one active stack per region (`MachineConfig.par`). A step on an event offers it to every region in
 * declaration order; each region takes the transition the interpreter takes (innermost level first, declaration order
 * — every enabled one at that level is explored, as everywhere else in this walk, the first being the interpreter's);
 * a region with none stays; each region sees the store the previous one left. An event that leaves `p` (or a state
 * that holds it) exits every region first. Trigger-less transitions of a region are chased, region by region, as
 * ordinary completion steps.
 *
 * A PARALLEL MACHINE ROOT (`state def M parallel { state nav {…} state comms {…} }`) is that same parallel state with
 * the machine as `p`: it opens in `[M]` with every child state entered as a region ({@link rootConfig}), nothing
 * leaves it, and the walk is the one below.
 *
 * WHAT IS REFUSED (`parallelRefusal`), with the interpreter's own reasons where it refuses too: a parallel state
 * below a parallel machine root, a parallel state inside a parallel state, an entry action naming a start, a history state inside, a
 * transition between regions or out of one, a step into a region, a region with
 * an unread start — and three reasons the explorer adds, because the interpreter applies the regions in ONE fixed
 * order while the specification admits any interleaving, and an exhaustive verdict must not be claimed over an order
 * the specification does not fix:
 *   - COUPLED REGIONS: a region writes an attribute that another region reads or writes. The fixed order then decides
 *     the outcome, and the other orders are runs this walk would not explore.
 *   - an event a region takes AND a transition leaving `p` (or a state holding it) takes: the interpreter stops there
 *     rather than choose; the explorer refuses the trigger statically.
 *   - a timed (`after`) transition inside a region, which the interpreter never fires in a region.
 */
import { type ElementId, type ElementRecord, type Model } from '@core/index';
import {
  type EnabledTransition,
  type MachineConfig,
  type ParRegion,
  type StepEffects,
  type StepInput,
  type StepResult,
  type UndeterminedGuard,
  type StepCandidates,
  actionsNamed,
  afterDuration,
  entryControlEdges,
  entryStartUnreadOf,
  initialConfig,
  isCompletion,
  isFinalState,
  regionsAllFinal,
  isHistoryComposite,
  isHistoryPseudostate,
  isParallelState,
  machineRegion,
  parallelRegions,
  regionScope,
  runStatePhase,
  stepCandidates,
  stepConfig,
  strAttr,
  triggerLabelOf,
} from './config';

export { regionsAllFinal };

/** Is any state in this machine's region (below its root) a parallel state? */
export function hasNestedParallel(model: Model, machineId: ElementId): boolean {
  return machineRegion(model, machineId).descendants.some(
    (e) => e.id !== machineId && e.eClass !== 'TransitionUsage' && isParallelState(model, e.id),
  );
}

/** Is the machine a parallel one with regions to perform: marked parallel, holding at least one state? */
export function isParallelRoot(model: Model, machineId: ElementId): boolean {
  return isParallelState(model, machineId) && machineRegion(model, machineId).directStates(machineId).length > 0;
}

/**
 * The opening of a parallel machine ROOT, before its regions are entered: the machine is the active state, as a
 * parallel state nested in an ordinary machine is once the machine reaches it. The machine's own entry is not run
 * (as for any machine root: `initialConfig` enters its first state, not the machine); the regions are entered by
 * {@link enterRegions} here and by the interpreter's own copy of it.
 */
export function rootConfig(machineId: ElementId, seed: Parameters<typeof initialConfig>[2] = {}): StepResult {
  const clock = seed.clock ?? 0;
  return {
    config: {
      regionId: machineId,
      stack: [machineId],
      store: new Map(seed.store ?? []),
      clock,
      entryTime: new Map([[machineId, clock]]),
      history: new Map(seed.history ?? []),
    },
    effects: { visited: [], fired: [], performed: [] },
  };
}

/** Identifier-like tokens of a text. */
function tokens(text: unknown, into: Set<string>): void {
  if (typeof text !== 'string') return;
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*|'[^']*'/g)) into.add(m[0].replace(/^'|'$/g, ''));
}

/** What a region reads or writes in the attribute store: every name in its transitions' guards/effects and its states' actions. */
function regionNames(model: Model, regionId: ElementId, ids: ReadonlySet<ElementId>): { all: Set<string>; writes: Set<string> } {
  const all = new Set<string>();
  const writes = new Set<string>();
  const addEffect = (text: unknown): void => {
    tokens(text, all);
    if (typeof text === 'string') {
      const i = text.indexOf('=');
      if (i > 0 && text[i + 1] !== '=') {
        const lhs = text.slice(0, i).trim().replace(/:$/, '').replace(/^'|'$/g, '');
        if (lhs !== '') writes.add(lhs);
      }
    }
  };
  const addAction = (x: ElementRecord | undefined): void => {
    if (!x) return;
    for (const asg of model.children(x.id).filter((c) => c.eClass === 'AssignmentActionUsage')) {
      const t = strAttr(asg, 'target') ?? strAttr(asg, 'referent') ?? strAttr(asg, 'feature') ?? asg.declaredName;
      if (t) {
        writes.add(t.replace(/^'|'$/g, ''));
        all.add(t.replace(/^'|'$/g, ''));
      }
      tokens(asg.attrs.value, all);
      tokens(strAttr(asg, 'expression'), all);
    }
    addEffect(strAttr(x, 'effect'));
  };
  const addRef = (ref: ElementRecord): void => {
    if (ref.attrs.stateSubactionRef !== true) return;
    for (const sub of model.children(ref.id).filter((c) => c.eClass === 'Subsetting')) {
      for (const t of sub.target ?? []) addAction(model.get(t));
    }
  };
  const view = machineRegion(model, regionId);
  for (const el of view.descendants) {
    if (el.id === regionId || !ids.has(el.id)) continue;
    if (el.eClass === 'TransitionUsage') {
      tokens(el.attrs.guard, all);
      const eff = strAttr(el, 'effect');
      addEffect(eff);
      if (eff !== undefined && /^[A-Za-z_'][^=]*$/.test(eff.trim())) for (const x of actionsNamed(model, el, eff.trim())) addAction(x);
    }
    if (el.attrs.stateSubaction !== undefined) addRef(el);
    for (const c of model.children(el.id)) if (c.attrs.stateSubaction !== undefined) addRef(c);
    if (el.attrs.stateSubaction !== undefined) {
      for (const asg of model.children(el.id).filter((c) => c.eClass === 'AssignmentActionUsage')) {
        const t = strAttr(asg, 'target') ?? strAttr(asg, 'referent') ?? strAttr(asg, 'feature') ?? asg.declaredName;
        if (t) {
          writes.add(t.replace(/^'|'$/g, ''));
          all.add(t.replace(/^'|'$/g, ''));
        }
        tokens(asg.attrs.value, all);
        tokens(strAttr(asg, 'expression'), all);
      }
      addEffect(strAttr(el, 'effect'));
      tokens(el.attrs.value, all);
      tokens(strAttr(el, 'expression'), all);
      const target = strAttr(el, 'target') ?? strAttr(el, 'referent') ?? strAttr(el, 'feature') ?? el.declaredName;
      if (el.eClass === 'AssignmentActionUsage' || strAttr(el, 'target') !== undefined) {
        if (target) writes.add(target.replace(/^'|'$/g, ''));
        if (target) all.add(target.replace(/^'|'$/g, ''));
      }
    }
  }
  for (const a of model.children(regionId)) {
    if (a.attrs.stateSubaction === undefined) continue;
    addRef(a);
    for (const asg of model.children(a.id).filter((c) => c.eClass === 'AssignmentActionUsage')) {
      const t = strAttr(asg, 'target') ?? strAttr(asg, 'referent') ?? strAttr(asg, 'feature') ?? asg.declaredName;
      if (t) {
        writes.add(t.replace(/^'|'$/g, ''));
        all.add(t.replace(/^'|'$/g, ''));
      }
      tokens(asg.attrs.value, all);
      tokens(strAttr(asg, 'expression'), all);
    }
    addEffect(strAttr(a, 'effect'));
    tokens(a.attrs.value, all);
    tokens(strAttr(a, 'expression'), all);
    const t = strAttr(a, 'target') ?? strAttr(a, 'referent') ?? strAttr(a, 'feature');
    if (t) {
      writes.add(t.replace(/^'|'$/g, ''));
      all.add(t.replace(/^'|'$/g, ''));
    }
  }
  return { all, writes };
}

export interface ParallelRefusal {
  /** The sentence, citing §7.18.2. */
  reason: string;
  /** The parallel state it is about. */
  elementId: ElementId;
}

/** The label a transition is taken on: its trigger text, `''` for a completion transition. */
const labelOf = (tr: ElementRecord): string => (isCompletion(tr) ? '' : triggerLabelOf(tr));

/**
 * Why a machine holding a parallel state below its root cannot be explored, or `undefined`. The interpreter's own
 * refusals (`nestedParallelRefusal`, `../execute.ts`), in its words, then the explorer's three; a differential test
 * (`semantics.mc.parallel.test.ts`) compares the two lists shape by shape.
 */
export function parallelRefusal(model: Model, machineId: ElementId): ParallelRefusal | undefined {
  const view = machineRegion(model, machineId);
  const pars = view.descendants.filter(
    (e) => e.id !== machineId && e.eClass !== 'TransitionUsage' && isParallelState(model, e.id),
  );
  const root = isParallelRoot(model, machineId);
  const name = (id: ElementId): string => `\`${model.qualifiedName(id) || id}\``;
  const out = (elementId: ElementId, reason: string): ParallelRefusal => ({
    elementId,
    reason: `${reason} (SysML v2 §7.18.2)`,
  });
  if (root && pars.length > 0) {
    return out(pars[0].id, `its state ${name(pars[0].id)} is a parallel state below a parallel machine, and nested parallel states are not performed concurrently here`);
  }
  // A parallel machine root is checked as the parallel state it is: its regions are its child states.
  for (const p of root ? [model.get(machineId)!] : pars) {
    const inside = new Set(machineRegion(model, p.id).descendants.map((e) => e.id));
    if (pars.some((q) => q.id !== p.id && inside.has(q.id))) {
      return out(p.id, `its parallel state ${name(p.id)} holds another parallel state, and nested parallel states are not performed concurrently here`);
    }
    if (entryControlEdges(model, p.id).length > 0) {
      return out(p.id, `its parallel state ${name(p.id)} has an entry action naming a start, but a parallel state enters all its regions, each at its own start`);
    }
    const regions = parallelRegions(model, p.id);
    if (regions.some((r) => entryStartUnreadOf(model, machineRegion(model, r.id), view.directStates(r.id)))) {
      return out(p.id, `a region of its parallel state ${name(p.id)} has an entry action naming a start that this interpreter does not read`);
    }
    if (
      [...inside].some((id) => {
        const e = model.get(id)!;
        return isHistoryPseudostate(e) || (e.eClass === 'StateUsage' && isHistoryComposite(model, id));
      })
    ) {
      return out(p.id, `its parallel state ${name(p.id)} holds a history state, whose resumption inside concurrent regions is not performed`);
    }
    const regionOf = (id: ElementId): ElementId | undefined =>
      regions.find((r) => r.id === id || machineRegion(model, r.id).descendants.some((e) => e.id === id))?.id;
    for (const tr of view.transitions) {
      const from = tr.source?.[0];
      const to = tr.target?.[0];
      // A step into the machine's own root is refused by the census (`step-outside-states`); the run stops there.
      if (root && to === p.id) continue;
      if (from !== undefined && to !== undefined && inside.has(from) && regionOf(from) !== (inside.has(to) ? regionOf(to) : undefined)) {
        return out(p.id, `a transition of its parallel state ${name(p.id)} leaves its region or connects two regions, which a parallel state does not allow and this interpreter does not perform`);
      }
      if (from === p.id && isCompletion(tr) && regions.length === 0) {
        return out(p.id, `its parallel state ${name(p.id)} has no region, so it never completes and its completion transition is not performed`);
      }
      if (to !== undefined && inside.has(to) && from !== undefined && !inside.has(from) && from !== p.id) {
        return out(p.id, `a transition steps into a region of its parallel state ${name(p.id)}, which is not performed`);
      }
      // A completion transition of a parallel machine ROOT may name a state of the machine (the old orthogonal join).
      if (to !== undefined && inside.has(to) && from === p.id && !(root && isCompletion(tr))) {
        return out(p.id, `a transition from its parallel state ${name(p.id)} steps into one of its own regions, which is not performed`);
      }
    }
    // — the explorer's own three —
    const regionTrs = view.transitions.filter((t) => t.source?.[0] !== undefined && inside.has(t.source[0]));
    if (regionTrs.some((t) => afterDuration(t) !== undefined)) {
      return out(p.id, `a region of its parallel state ${name(p.id)} has a timed (\`after\`) transition, which the interpreter never fires inside a region, so no verdict is given over it`);
    }
    // The states the machine is in while `p` is: `p` and the states that hold it, up to the machine's root.
    const holders = new Set<ElementId>([p.id]);
    for (let o = view.parentOf(p.id); o !== null && o !== undefined; o = view.parentOf(o)) holders.add(o);
    const regionLabels = new Set(regionTrs.map(labelOf).filter((l) => l !== ''));
    for (const tr of view.transitions) {
      const from = tr.source?.[0];
      if (from === undefined || !holders.has(from)) continue;
      const l = labelOf(tr);
      if (l !== '' && regionLabels.has(l)) {
        return out(p.id, `the event \`${l}\` is taken by a transition of a region of its parallel state ${name(p.id)} and by a transition that leaves it or a state that holds it, and the interpreter stops there rather than choose; no verdict is given over it`);
      }
    }
    const names = regions.map((r) => regionNames(model, r.id, new Set(machineRegion(model, r.id).descendants.map((e) => e.id))));
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < names.length; j++) {
        if (i === j) continue;
        const shared = [...names[i].writes].filter((w) => names[j].all.has(w));
        if (shared.length > 0) {
          return out(
            p.id,
            `the regions ${name(regions[i].id)} and ${name(regions[j].id)} of its parallel state ${name(p.id)} are coupled through \`${shared[0]}\`: one writes it and the other reads or writes it, the interpreter applies the regions in declaration order, and the specification admits any interleaving, so no exhaustive verdict is given over this order alone`,
          );
        }
      }
    }
  }
  return undefined;
}

/** Enter every region of the parallel state that ends `cfg.stack`, in declaration order, each at its own start — the interpreter's `enterRegionsIfParallel`. */
export function enterRegions(model: Model, cfg: MachineConfig): StepResult {
  const top = cfg.stack[cfg.stack.length - 1];
  const noEffects: StepEffects = { visited: [], fired: [], performed: [] };
  if (top === undefined || !isParallelState(model, top) || cfg.par !== undefined) return { config: cfg, effects: noEffects };
  const visited: ElementId[] = [];
  const performed: StepEffects['performed'][number][] = [];
  const w = new Map(cfg.store);
  const scope = regionScope(model, cfg.regionId);
  const regs: ParRegion[] = [];
  for (const r of parallelRegions(model, top)) {
    visited.push(r.id);
    runStatePhase(model, r.id, 'entry', w, scope, performed);
    runStatePhase(model, r.id, 'do', w, scope, performed);
    const o = initialConfig(model, r.id, { store: w, clock: cfg.clock });
    visited.push(...o.effects.visited);
    performed.push(...o.effects.performed);
    w.clear();
    for (const [k, v] of o.config.store) w.set(k, v);
    regs.push({ id: r.id, stack: o.config.stack, entryTime: o.config.entryTime });
  }
  return {
    config: { ...cfg, store: w, par: { id: top, regs } },
    effects: { visited, fired: [], performed },
  };
}

/** `initialConfig`, then the regions of a parallel state the machine opens in. */
export function openConfig(
  model: Model,
  regionId: ElementId,
  seed: Parameters<typeof initialConfig>[2] = {},
): StepResult {
  const o = isParallelRoot(model, regionId) ? rootConfig(regionId, seed) : initialConfig(model, regionId, seed);
  const e = enterRegions(model, o.config);
  return { config: e.config, effects: merge(o.effects, e.effects) };
}

function merge(a: StepEffects, b: StepEffects): StepEffects {
  return { visited: [...a.visited, ...b.visited], fired: [...a.fired, ...b.fired], performed: [...a.performed, ...b.performed] };
}

/** The configuration of one region, on the run's store. */
function regionView(cfg: MachineConfig, i: number): MachineConfig {
  const rg = cfg.par!.regs[i];
  return { regionId: rg.id, stack: rg.stack, store: cfg.store, clock: cfg.clock, entryTime: rg.entryTime, history: cfg.history };
}

/** Take one transition inside region `i`. */
function stepInRegion(model: Model, cfg: MachineConfig, i: number, choice: EnabledTransition): StepResult {
  const r = stepConfig(model, regionView(cfg, i), choice);
  const regs = cfg.par!.regs.map((rg, k) => (k === i ? { id: rg.id, stack: r.config.stack, entryTime: r.config.entryTime } : rg));
  return { config: { ...cfg, store: r.config.store, par: { id: cfg.par!.id, regs } }, effects: r.effects };
}

/** Leave every region (inner to outer, regions in declaration order) — the interpreter's `exitRegions`. */
function exitRegions(model: Model, cfg: MachineConfig): StepResult {
  const performed: StepEffects['performed'][number][] = [];
  const w = new Map(cfg.store);
  const scope = regionScope(model, cfg.regionId);
  for (const rg of cfg.par!.regs) {
    for (let i = rg.stack.length - 1; i >= 0; i--) runStatePhase(model, rg.stack[i], 'exit', w, scope, performed);
    runStatePhase(model, rg.id, 'exit', w, scope, performed);
  }
  const { par: _par, ...rest } = cfg;
  void _par;
  return { config: { ...rest, store: w }, effects: { visited: [], fired: [], performed } };
}

/** What a configuration's regions offer on one input, and what holds back. */
export interface ParCandidates extends StepCandidates {
  /** Per region, the alternatives at its innermost level where it has more than one: a hidden choice inside the region. */
  readonly regionChoices: readonly { cfg: MachineConfig; enabled: EnabledTransition[] }[];
}

/**
 * {@link stepCandidates}, for a configuration that may be in a parallel state. Without `cfg.par` it IS
 * `stepCandidates`. With it: a TRIGGER enabled outside the regions (it leaves `p` or a state holding it) is that
 * transition alone; otherwise the regions' steps, one macro choice per combination of alternatives. A COMPLETION is
 * the regions' trigger-less steps first (each region that has one takes it), the outer ones only when no region has
 * any — the interpreter's `chaseAll`. A TIMEOUT is the outer one's (a region's `after` is refused).
 */
export function candidatesOf(model: Model, cfg: MachineConfig, input: StepInput, resolveNames = false): ParCandidates {
  if (cfg.par === undefined) return { ...stepCandidates(model, cfg, input, resolveNames), regionChoices: [] };
  const outer = stepCandidates(model, cfg, input, resolveNames);
  if (input.kind === 'timeout') return { ...outer, regionChoices: [] };
  const undetermined: UndeterminedGuard[] = [...outer.undetermined];
  const regionChoices: { cfg: MachineConfig; enabled: EnabledTransition[] }[] = [];
  const n = cfg.par.regs.length;
  // Branches: the partial macro (picks so far) and the configuration it leaves.
  let branches: { picks: (EnabledTransition | null)[]; at: MachineConfig }[] = [{ picks: [], at: cfg }];
  for (let i = 0; i < n; i++) {
    const next: typeof branches = [];
    let first = true;
    for (const b of branches) {
      const found = stepCandidates(model, regionView(b.at, i), input, resolveNames);
      if (first) {
        for (const u of found.undetermined) undetermined.push({ ...u, level: cfg.stack.length });
        first = false;
      }
      if (found.enabled.length === 0) {
        next.push({ picks: [...b.picks, null], at: b.at });
        continue;
      }
      const innermost = found.enabled[0].level;
      const alts = found.enabled.filter((e) => e.level === innermost);
      if (alts.length > 1) regionChoices.push({ cfg: regionView(b.at, i), enabled: alts });
      for (const a of alts) next.push({ picks: [...b.picks, a], at: stepInRegion(model, b.at, i, a).config });
    }
    branches = next;
  }
  const macros = branches.filter((b) => b.picks.some((p) => p !== null));
  if (input.kind === 'completion' && macros.length === 0) return { ...outer, undetermined, regionChoices: [] };
  if (input.kind === 'trigger' && outer.enabled.length > 0) return { ...outer, regionChoices: [] };
  const level = cfg.stack.length - 1;
  const enabled: EnabledTransition[] = macros.map((b) => {
    const rep = b.picks.find((p) => p !== null)!;
    return { transition: rep.transition, level, label: rep.label, macro: { picks: b.picks } };
  });
  return { enabled, undetermined, regionChoices };
}

/**
 * {@link stepConfig}, for a configuration that may be in a parallel state, and for a step that enters one: a macro
 * choice takes its regions' picks in order; any other choice first leaves every region, then steps, then enters the
 * regions of a parallel state it lands in.
 */
export function advanceConfig(model: Model, cfg: MachineConfig, choice: EnabledTransition): StepResult {
  if (choice.macro !== undefined) {
    let at = cfg;
    let effects: StepEffects = { visited: [], fired: [], performed: [] };
    choice.macro.picks.forEach((p, i) => {
      if (p === null) return;
      const r = stepInRegion(model, at, i, p);
      at = r.config;
      effects = merge(effects, r.effects);
    });
    return { config: at, effects };
  }
  let base = cfg;
  let effects: StepEffects = { visited: [], fired: [], performed: [] };
  if (cfg.par !== undefined) {
    const x = exitRegions(model, cfg);
    base = x.config;
    effects = x.effects;
  }
  const s = stepConfig(model, base, choice);
  const e = enterRegions(model, s.config);
  return { config: e.config, effects: merge(merge(effects, s.effects), e.effects) };
}

/** Every transition a choice takes: itself, or each region's pick of a macro. */
export function transitionsOf(choice: EnabledTransition): readonly EnabledTransition[] {
  return choice.macro === undefined ? [choice] : choice.macro.picks.filter((p): p is EnabledTransition => p !== null);
}
