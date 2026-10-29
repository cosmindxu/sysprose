/**
 * THE DIFFERENTIAL GATE: the interpreter and the checker share one step
 * relation (plan §3.8, §5 "Mutation").
 *
 * `runStateMachine` must equal the left fold of `stepConfig` with
 * `choice = enabledTransitions(...)[0]` — visited, fired, performed, store and
 * clock — on every machine the execute suites build and on both shipped
 * examples. That is what makes the sentence "the checker decides the machine
 * the simulator runs" a measurement rather than a hope.
 *
 * WHY THE FOLD IS WRITTEN HERE rather than imported. The point of a
 * differential is that two INDEPENDENT drivers agree; a test that called the
 * interpreter's own driving loop would be comparing a function with itself. So
 * this file drives the relation on its own — region by region, chase, timed
 * advance and join — and the assertion is that the two drivers, one of which
 * (`runRegion`, the flat path) does not go through `./mc/config.ts` at all,
 * produce identical output.
 *
 * The flat path matters most here: `runStateMachine` routes a simple machine to
 * `runRegion`, which still fires transitions with its own inline `find`. Every
 * flat case below is therefore a genuine comparison of two implementations, and
 * the hierarchical cases pin the DRIVING DISCIPLINE (when a chase runs, what a
 * time advance fires, how regions compose) that the refactor moved.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Model, ModelFactory, type ElementId, type ElementRecord } from '@core/index';
import { runStateMachine, type StateStep, type StateRunResult } from '@semantics/index';
import {
  MAX_COMPLETION,
  advanceClock,
  enabledTransitions,
  hashConfig,
  initialConfig,
  isCompletion,
  seedStore,
  stepConfig,
  triggerLabelOf,
  type MachineConfig,
  type StepEffects,
  type StepInput,
} from '../../src/semantics/mc/config';
import { loadModelText } from '@text/load';
import { exploreMachine, machineStates, reachReport, stateMachinesIn } from '../../src/semantics/mc/explore';
import { WITNESS_NOT_REPLAYED_CODE, behaviourReport } from '../../src/semantics/mc/patterns';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/* ─────────────────────────── the second driver ──────────────────────────── */

interface Folded {
  visited: ElementId[];
  fired: Array<{ transitionId: ElementId; from: ElementId; to: ElementId; trigger: string; stack?: ElementId[] }>;
  performed: Array<{ stateId: ElementId; phase: string; actionId: ElementId; name: string }>;
  store: Map<string, unknown>;
  clock: number;
}

const COMPLETION: StepInput = { kind: 'completion' };
const TIMEOUT: StepInput = { kind: 'timeout' };

function isTimed(s: StateStep): s is { advance: number } {
  return typeof s === 'object' && s !== null && typeof (s as { advance: number }).advance === 'number';
}

/** Directly-owned child states that themselves contain states (the regions). */
function regionsOf(model: Model, machineId: ElementId, parallel: boolean): ElementId[] {
  if (!parallel) return [machineId];
  const rs = model
    .children(machineId)
    .filter(
      (c) => c.eClass === 'StateUsage' && model.children(c.id).some((d) => d.eClass === 'StateUsage'),
    )
    .map((c) => c.id);
  return rs.length > 0 ? rs : [machineId];
}

/**
 * The left fold: drive one region by asking what is enabled and taking the
 * head, exactly as the semantic profile says the interpreter does.
 */
function foldRegion(
  model: Model,
  regionId: ElementId,
  steps: StateStep[],
  out: Folded,
  history: Map<ElementId, ElementId>,
  maxCompletion: number,
): { leaf: ElementId | null; final: boolean } {
  let cfg: MachineConfig;
  const take = (r: { config: MachineConfig; effects: StepEffects }): void => {
    cfg = r.config;
    out.visited.push(...r.effects.visited);
    // The interpreter records the stack each fire leaves (`StateFire.stack`, the
    // witness replay's); the fold takes it from the configuration the same step made.
    out.fired.push(...r.effects.fired.map((f) => ({ ...f, stack: [...r.config.stack] })));
    out.performed.push(...r.effects.performed);
    for (const [k, v] of r.config.store) out.store.set(k, v);
    out.clock = r.config.clock;
    for (const [k, v] of r.config.history) history.set(k, v);
  };

  const opening = initialConfig(model, regionId, { store: out.store, clock: out.clock, history });
  cfg = opening.config;
  if (cfg.stack.length === 0) return { leaf: null, final: false };
  take(opening);

  const chase = (): void => {
    for (let k = 0; k < maxCompletion; k++) {
      const enabled = enabledTransitions(model, cfg, COMPLETION);
      if (enabled.length === 0) return;
      take(stepConfig(model, cfg, enabled[0]));
    }
  };
  chase();

  for (const step of steps) {
    if (isTimed(step)) {
      cfg = advanceClock(cfg, step.advance);
      out.clock = cfg.clock;
      for (let k = 0; k < maxCompletion; k++) {
        const enabled = enabledTransitions(model, cfg, TIMEOUT);
        if (enabled.length === 0) break;
        take(stepConfig(model, cfg, enabled[0]));
        chase();
      }
    } else {
      const enabled = enabledTransitions(model, cfg, { kind: 'trigger', trigger: step });
      if (enabled.length === 0) continue;
      take(stepConfig(model, cfg, enabled[0]));
      chase();
    }
  }
  const leaf = cfg.stack.length > 0 ? cfg.stack[cfg.stack.length - 1] : null;
  const el = leaf === null ? undefined : model.get(leaf);
  const final =
    el !== undefined &&
    (el.attrs.kind === 'final' || el.attrs.isFinal === true || el.declaredName === 'final');
  return { leaf, final };
}

/** The whole machine: regions in turn, then the orthogonal join if it fires. */
function foldRun(model: Model, machineId: ElementId, steps: StateStep[]): Folded {
  const machine = model.get(machineId)!;
  const out: Folded = { visited: [], fired: [], performed: [], store: new Map(), clock: 0 };
  seedStore(model, machine, out.store);
  const parallel =
    machine.attrs.parallel === true ||
    machine.attrs.parallel === 'true' ||
    machine.attrs.isParallel === true;
  const history = new Map<ElementId, ElementId>();
  const finals: boolean[] = [];
  for (const region of regionsOf(model, machineId, parallel)) {
    finals.push(foldRegion(model, region, steps, out, history, MAX_COMPLETION).final);
  }
  if (parallel && finals.length > 0 && finals.every(Boolean)) {
    const join = model
      .descendants(machineId)
      .find(
        (e: ElementRecord) =>
          e.eClass === 'TransitionUsage' &&
          e.source?.[0] === machineId &&
          e.target?.[0] !== undefined &&
          (e.attrs.kind === 'join' || isCompletion(e)),
      );
    if (join) {
      // The join is fired by `runHierMachine`, outside any region, so the fold
      // reproduces it here rather than pretending the region relation covers it.
      const to = join.target![0];
      out.fired.push({ transitionId: join.id, from: machineId, to, trigger: triggerLabelOf(join) });
      out.visited.push(to);
      for (const a of model.children(to)) {
        if (a.attrs.stateSubaction === 'entry' || a.attrs.stateSubaction === 'do') {
          out.performed.push({
            stateId: to,
            phase: a.attrs.stateSubaction as string,
            actionId: a.id,
            name: a.declaredName ?? '',
          });
        }
      }
    }
  }
  return out;
}

/** Compare the five fields the plan names, with a message naming the machine. */
function expectAgreement(label: string, res: StateRunResult, fold: Folded): void {
  expect(res.visited, `${label}: visited`).toEqual(fold.visited);
  // The flat path (`runRegion`) keeps no stack, so a fire it made is compared without one. The
  // hierarchical path records one on EVERY region fire (the orthogonal join, fired outside any
  // region, has none): a run that stacked anything, or that any fire of it recorded a stack for,
  // took that path, and a fire without a stack there is a defect the mask must not hide.
  const hierarchical =
    res.fired.some((f) => f.stack !== undefined) || fold.fired.some((f) => (f.stack?.length ?? 0) > 1);
  if (hierarchical) {
    fold.fired.forEach((f, i) => {
      if (f.stack !== undefined) expect(res.fired[i]?.stack, `${label}: fired[${i}] stack`).toBeDefined();
    });
  }
  const foldFired = fold.fired.map((f, i) => (res.fired[i]?.stack === undefined ? { ...f, stack: undefined } : f));
  expect(res.fired, `${label}: fired`).toEqual(foldFired);
  expect(res.performed, `${label}: performed`).toEqual(fold.performed);
  expect([...res.valueStore.entries()].sort(), `${label}: store`).toEqual(
    [...fold.store.entries()].sort(),
  );
  expect(res.clock ?? 0, `${label}: clock`).toBe(fold.clock);
}

/* ────────────────────── the machines the suites build ───────────────────── */

interface Case {
  name: string;
  build: () => { model: Model; machineId: ElementId };
  steps: StateStep[];
}

/** `semantics.execute.test.ts` — the flat off/running/idle machine. */
function flatMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Machine');
  const off = f.state('off', sm.id);
  const running = f.state('running', sm.id);
  const idle = f.state('idle', sm.id);
  f.transition(off.id, running.id, { ownerId: sm.id, trigger: 'start' });
  f.transition(running.id, off.id, { ownerId: sm.id, trigger: 'stop' });
  f.transition(running.id, idle.id, { ownerId: sm.id, trigger: 'pause' });
  f.transition(idle.id, running.id, { ownerId: sm.id, trigger: 'resume' });
  return { model: m, machineId: sm.id };
}

const CASES: Case[] = [
  { name: 'flat machine, every trigger', build: flatMachine, steps: ['start', 'pause', 'resume', 'stop'] },
  { name: 'flat machine, triggers with nothing enabled', build: flatMachine, steps: ['stop', 'stop', 'start'] },
  {
    name: 'guarded transition (guard false)',
    build: () => {
      const m = new Model();
      const f = new ModelFactory(m);
      const sm = f.stateDef('Guarded');
      f.attribute('ready', sm.id, { type: 'Boolean', value: false });
      const s0 = f.state('s0', sm.id);
      const s1 = f.state('s1', sm.id);
      f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'go', guard: 'ready' });
      return { model: m, machineId: sm.id };
    },
    steps: ['go'],
  },
  {
    name: 'entry/exit behaviors and a transition effect',
    build: () => {
      const m = new Model();
      const f = new ModelFactory(m);
      const sm = f.stateDef('Machine');
      f.attribute('power', sm.id, { type: 'Integer', value: 0 });
      const off = f.state('off', sm.id);
      const on = f.state('on', sm.id);
      m.create('ActionUsage', { ownerId: off.id, declaredName: 'shutdown', attrs: { stateSubaction: 'exit' } });
      m.create('ActionUsage', { ownerId: on.id, declaredName: 'turnOn', attrs: { stateSubaction: 'entry' } });
      f.transition(off.id, on.id, { ownerId: sm.id, trigger: 'go', effect: 'power = 1' });
      return { model: m, machineId: sm.id };
    },
    steps: ['go'],
  },
  {
    name: 'completion transition fires automatically',
    build: () => {
      const m = new Model();
      const f = new ModelFactory(m);
      const sm = f.stateDef('Auto');
      const a = f.state('a', sm.id);
      const b = f.state('b', sm.id);
      const c = f.state('c', sm.id);
      f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'start' });
      f.transition(b.id, c.id, { ownerId: sm.id });
      return { model: m, machineId: sm.id };
    },
    steps: ['start'],
  },
  {
    name: 'parallel regions on a shared trigger',
    build: () => {
      const m = new Model();
      const f = new ModelFactory(m);
      const par = m.create('StateDefinition', { declaredName: 'Par', attrs: { parallel: true } });
      const r1 = f.state('r1', par.id);
      const a1 = f.state('a1', r1.id);
      const a2 = f.state('a2', r1.id);
      f.transition(a1.id, a2.id, { ownerId: r1.id, trigger: 't' });
      const r2 = f.state('r2', par.id);
      const b1 = f.state('b1', r2.id);
      const b2 = f.state('b2', r2.id);
      f.transition(b1.id, b2.id, { ownerId: r2.id, trigger: 't' });
      return { model: m, machineId: par.id };
    },
    steps: ['t'],
  },
  {
    name: 'composite state cascades entry/exit',
    build: () => {
      const m = new Model();
      const f = new ModelFactory(m);
      const sm = f.stateDef('M');
      const active = f.state('Active', sm.id);
      m.create('ActionUsage', { ownerId: active.id, declaredName: 'enterActive', attrs: { stateSubaction: 'entry' } });
      m.create('ActionUsage', { ownerId: active.id, declaredName: 'exitActive', attrs: { stateSubaction: 'exit' } });
      const s1 = f.state('s1', active.id);
      m.create('ActionUsage', { ownerId: s1.id, declaredName: 'enterS1', attrs: { stateSubaction: 'entry' } });
      m.create('ActionUsage', { ownerId: s1.id, declaredName: 'exitS1', attrs: { stateSubaction: 'exit' } });
      const s2 = f.state('s2', active.id);
      m.create('ActionUsage', { ownerId: s2.id, declaredName: 'enterS2', attrs: { stateSubaction: 'entry' } });
      f.transition(s1.id, s2.id, { ownerId: active.id, trigger: 'go' });
      const done = f.state('Done', sm.id);
      f.transition(active.id, done.id, { ownerId: sm.id, trigger: 'finish' });
      return { model: m, machineId: sm.id };
    },
    steps: ['finish'],
  },
  {
    name: 'one trigger enabled at two levels: the inner state wins',
    build: buildPriority,
    steps: ['go'],
  },
  {
    name: 'history pseudostate resumes the last substate',
    build: () => buildHistory(true),
    steps: ['go', 'out', 'back'],
  },
  {
    name: 'no history restarts at the initial substate',
    build: () => buildHistory(false),
    steps: ['go', 'out', 'back'],
  },
  {
    name: 'orthogonal regions, join fires when both complete',
    build: buildJoin,
    steps: ['t1', 't2'],
  },
  {
    name: 'orthogonal regions, join withheld while one region is open',
    build: buildJoin,
    steps: ['t1'],
  },
  { name: 'after(5) before the dwell', build: buildTimer, steps: [{ advance: 3 }] },
  { name: 'after(5) once the dwell is met', build: buildTimer, steps: [{ advance: 3 }, { advance: 3 }] },
  // THE EDGE KIND THAT WAS IN ONE READER AND NOT THE OTHER. `first active then
  // done;` is a succession between two states, and a machine that mixes it with
  // a `transition` is the shape on which the explorer and the simulator walked
  // different graphs while this file stayed green — because both readers were
  // built from their own filter and both filters said `TransitionUsage`. They
  // now read ONE relation (`regionTransitions`), and this case is what fails if
  // either grows its own again: the flat path is a genuinely independent driver,
  // so a relation widened on one side only diverges here on the first step.
  { name: 'a succession between two states, mixed with a transition', build: buildSuccessionMix, steps: [] },
  { name: 'the same machine driven by a trigger it does not name', build: buildSuccessionMix, steps: ['go'] },
  { name: 'a succession that closes a completion cycle', build: buildSuccessionLoop, steps: [] },
  // A STEP EXITS TO THE LEAST COMMON ANCESTOR (`docs/06` §8.10). Both drivers
  // read `stepConfig`, so these hold the DRIVING DISCIPLINE to one relation on
  // every way a step can stand to the hierarchy; what the relation does there
  // is asserted on its result below.
  { name: 'out of a composite, then a step its own transitions no longer offer', build: buildLca, steps: ['go', 'x', 'back', 'reset'] },
  { name: 'to the composite’s sibling, then on to the first composite', build: buildLca, steps: ['go', 'x', 'side', 'cross'] },
  { name: 'to an ancestor, and self-transitions on a substate and a composite', build: buildLca, steps: ['go', 'x', 'up', 'again', 'x', 'reset'] },
  { name: 'from a composite to its own substate, and into a nested state from outside', build: buildLca, steps: ['go', 'pick', 'back', 'dive'] },
  // A STEP INTO A NODE WRITTEN INSIDE A LEAF STATE, on a machine with no
  // composite. The step enters the state first; the flat path entered the
  // target alone, so it stood at `work` with `S` never entered, never offered
  // `S`'s own transitions, and parted from the walk on the next step. Such a
  // machine now runs on the path that drives `stepConfig` (`needsHierarchical`),
  // and these cases fail the moment it takes the flat one again.
  { name: 'a step into a node inside a leaf state, then the state’s own transition', build: () => buildIntoLeaf(false), steps: ['go', 'x'] },
  { name: 'the same, the state settling on completion before an event its node accepts', build: () => buildIntoLeaf(true), steps: ['go', 'e'] },
  { name: 'the same in one of two parallel regions', build: buildIntoLeafParallel, steps: ['go', 'x'] },
];

/**
 * `idle -> active` as a transition, `active -> done` as a succession.
 *
 * Both are trigger-less, so the opening completion chase drives the whole
 * machine and the two drivers have to agree about an edge kind, not only about
 * an order.
 */
function buildSuccessionMix(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('SuccMix');
  const idle = f.state('idle', sm.id);
  const active = f.state('active', sm.id);
  const done = f.state('done', sm.id);
  f.transition(idle.id, active.id, { ownerId: sm.id });
  f.succession(active.id, done.id, sm.id);
  return { model: m, machineId: sm.id };
}

/** The same, with the succession closing the cycle instead of ending it. */
function buildSuccessionLoop(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('SuccLoop');
  const idle = f.state('idle', sm.id);
  const active = f.state('active', sm.id);
  f.transition(idle.id, active.id, { ownerId: sm.id });
  f.succession(active.id, idle.id, sm.id);
  return { model: m, machineId: sm.id };
}

function buildHistory(history: boolean): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef(history ? 'H' : 'NoH');
  const active = m.create('StateUsage', {
    declaredName: 'Active',
    ownerId: sm.id,
    attrs: history ? { history: true } : {},
  });
  const s1 = f.state('s1', active.id);
  const s2 = f.state('s2', active.id);
  f.transition(s1.id, s2.id, { ownerId: active.id, trigger: 'go' });
  const idle = f.state('Idle', sm.id);
  f.transition(active.id, idle.id, { ownerId: sm.id, trigger: 'out' });
  f.transition(idle.id, active.id, { ownerId: sm.id, trigger: 'back' });
  return { model: m, machineId: sm.id };
}

/**
 * A machine where the SAME trigger leaves a composite state and its own active
 * substate. Which one fires is the profile's `priority` field, and it is the
 * one field a differential alone cannot check: both drivers ask the same
 * `enabledTransitions`, so flipping the level order flips both of them
 * identically and the comparison stays green. It is pinned by asserting the
 * interpreter's OUTPUT below instead.
 */
function buildPriority(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Priority');
  const outer = f.state('Outer', sm.id);
  const inner = f.state('inner', outer.id);
  const innerTarget = f.state('innerTarget', outer.id);
  const outerTarget = f.state('OuterTarget', sm.id);
  // Declared OUTER first, so a walk that took the first match in declaration
  // order rather than the innermost state would take this one.
  f.transition(outer.id, outerTarget.id, { ownerId: sm.id, trigger: 'go' });
  f.transition(inner.id, innerTarget.id, { ownerId: outer.id, trigger: 'go' });
  return { model: m, machineId: sm.id };
}

function buildJoin(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const par = m.create('StateDefinition', { declaredName: 'Par', attrs: { parallel: true } });
  const r1 = f.state('r1', par.id);
  const a1 = f.state('a1', r1.id);
  const a1f = m.create('StateUsage', { declaredName: 'a1f', ownerId: r1.id, attrs: { kind: 'final' } });
  f.transition(a1.id, a1f.id, { ownerId: r1.id, trigger: 't1' });
  const r2 = f.state('r2', par.id);
  const b1 = f.state('b1', r2.id);
  const b2f = m.create('StateUsage', { declaredName: 'b2f', ownerId: r2.id, attrs: { kind: 'final' } });
  f.transition(b1.id, b2f.id, { ownerId: r2.id, trigger: 't2' });
  const allDone = f.state('AllDone', par.id);
  m.create('TransitionUsage', {
    ownerId: par.id,
    source: [par.id],
    target: [allDone.id],
    attrs: { kind: 'join' },
  });
  return { model: m, machineId: par.id };
}

function buildTimer(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Timer');
  const s0 = f.state('s0', sm.id);
  const s1 = f.state('s1', sm.id);
  f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'after(5)' });
  return { model: m, machineId: sm.id };
}

/**
 * A top state and two composites, every state with an entry action `inX` and an
 * exit action `outX`, and one transition for each way a step can stand to the
 * state hierarchy (`docs/06` §8.10): between two substates, out of a composite,
 * to the composite's sibling, to its ancestor, a self-transition on a substate
 * and on a composite, from a composite to its own substate, into a nested state
 * from outside, and from a substate of one composite to a substate of the other.
 */
function buildLca(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Lca');
  const idle = f.state('Idle', sm.id);
  const c0 = f.state('C0', sm.id);
  const a = f.state('a', c0.id);
  const b = f.state('b', c0.id);
  const c1 = f.state('C1', sm.id);
  const p = f.state('p', c1.id);
  const q = f.state('q', c1.id);
  for (const s of [idle, c0, a, b, c1, p, q]) {
    m.create('ActionUsage', { ownerId: s.id, declaredName: `in${s.declaredName}`, attrs: { stateSubaction: 'entry' } });
    m.create('ActionUsage', { ownerId: s.id, declaredName: `out${s.declaredName}`, attrs: { stateSubaction: 'exit' } });
  }
  f.transition(idle.id, c0.id, { ownerId: sm.id, trigger: 'go' });
  f.transition(a.id, b.id, { ownerId: c0.id, trigger: 'x' });
  f.transition(b.id, idle.id, { ownerId: c0.id, trigger: 'back' });
  f.transition(b.id, c1.id, { ownerId: c0.id, trigger: 'side' });
  f.transition(b.id, c0.id, { ownerId: c0.id, trigger: 'up' });
  f.transition(a.id, a.id, { ownerId: c0.id, trigger: 'again' });
  f.transition(c0.id, c0.id, { ownerId: sm.id, trigger: 'reset' });
  f.transition(c0.id, b.id, { ownerId: sm.id, trigger: 'pick' });
  f.transition(idle.id, q.id, { ownerId: sm.id, trigger: 'dive' });
  f.transition(p.id, b.id, { ownerId: c1.id, trigger: 'cross' });
  return { model: m, machineId: sm.id };
}

/**
 * `Idle`, `S { action work; }` and `Z`, no composite: `Idle -go-> S::work`,
 * `S -x-> Z` and `S::work -e-> Z`, every state with an entry action `inX` — and,
 * with `settle`, a trigger-less `S -> Idle`. The review's `nd1` and `flat-act`.
 */
function buildIntoLeaf(settle: boolean): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('IntoLeaf');
  const idle = f.state('Idle', sm.id);
  const s = f.state('S', sm.id);
  const work = m.create('ActionUsage', { ownerId: s.id, declaredName: 'work' });
  const z = f.state('Z', sm.id);
  for (const st of [idle, s, z]) {
    m.create('ActionUsage', { ownerId: st.id, declaredName: `in${st.declaredName}`, attrs: { stateSubaction: 'entry' } });
  }
  f.transition(idle.id, work.id, { ownerId: sm.id, trigger: 'go' });
  if (settle) f.transition(s.id, idle.id, { ownerId: sm.id });
  f.transition(s.id, z.id, { ownerId: sm.id, trigger: 'x' });
  f.transition(work.id, z.id, { ownerId: sm.id, trigger: 'e' });
  return { model: m, machineId: sm.id };
}

/** {@link buildIntoLeaf}'s shape as region `r1` of a parallel machine, beside a plain region `r2`. */
function buildIntoLeafParallel(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const par = m.create('StateDefinition', { declaredName: 'ParLeaf', attrs: { parallel: true } });
  const r1 = f.state('r1', par.id);
  const idle = f.state('Idle', r1.id);
  const s = f.state('S', r1.id);
  m.create('ActionUsage', { ownerId: s.id, declaredName: 'inS', attrs: { stateSubaction: 'entry' } });
  const work = m.create('ActionUsage', { ownerId: s.id, declaredName: 'work' });
  const z = f.state('Z', r1.id);
  f.transition(idle.id, work.id, { ownerId: r1.id, trigger: 'go' });
  f.transition(s.id, z.id, { ownerId: r1.id, trigger: 'x' });
  const r2 = f.state('r2', par.id);
  const b1 = f.state('b1', r2.id);
  const b2 = f.state('b2', r2.id);
  f.transition(b1.id, b2.id, { ownerId: r2.id, trigger: 'go' });
  return { model: m, machineId: par.id };
}

/* ──────────────────────────────── the gate ──────────────────────────────── */

describe('the interpreter is the left fold of the step function', () => {
  for (const c of CASES) {
    it(`${c.name}`, () => {
      const { model, machineId } = c.build();
      const res = runStateMachine(model, machineId, c.steps);
      expectAgreement(c.name, res, foldRun(model, machineId, c.steps));
    });
  }
});

describe('the same, on both shipped examples', () => {
  let uav: Model;
  let vehicle: Model;
  beforeAll(async () => {
    const a = await loadModelText(read('examples/uav-isr.sysml'), { fileName: 'examples/uav-isr.sysml' });
    const b = await loadModelText(read('examples/vehicle.sysml'), { fileName: 'examples/vehicle.sysml' });
    uav = a.model!;
    vehicle = b.model!;
  }, 90_000);

  /** Every non-library element that directly owns a transition, as analytics counts them. */
  function machinesOf(model: Model): ElementRecord[] {
    return model
      .all()
      .filter(
        (el) =>
          el.attrs.isLibrary !== true &&
          model.children(el.id).some((c) => c.eClass === 'TransitionUsage'),
      );
  }

  /** The distinct triggers a machine names, which is what analytics drives it with. */
  function triggersOf(model: Model, id: ElementId): string[] {
    const out: string[] = [];
    for (const e of model.descendants(id)) {
      if (e.eClass !== 'TransitionUsage') continue;
      const t = triggerLabelOf(e);
      if (t === '' || out.includes(t)) continue;
      out.push(t);
    }
    return out;
  }

  it('examples/uav-isr.sysml — FlightModes agrees, chase budget included', () => {
    const machines = machinesOf(uav);
    expect(machines.length, 'the UAV example no longer declares a state machine').toBeGreaterThan(0);
    for (const m of machines) {
      const steps = triggersOf(uav, m.id);
      expectAgreement(m.declaredName ?? m.id, runStateMachine(uav, m.id, steps), foldRun(uav, m.id, steps));
    }
  });

  it('examples/vehicle.sysml agrees on every machine it declares', () => {
    for (const m of machinesOf(vehicle)) {
      const steps = triggersOf(vehicle, m.id);
      expectAgreement(
        m.declaredName ?? m.id,
        runStateMachine(vehicle, m.id, steps),
        foldRun(vehicle, m.id, steps),
      );
    }
  });
});

describe('the priority rule the differential cannot see', () => {
  /**
   * The profile says "innermost active substate first". Both drivers read that
   * rule from one function, so only an assertion about the RESULT can hold it:
   * a machine offering `go` at two levels must leave the inner state, and
   * `enabledTransitions` must offer the inner one first.
   */
  it('fires the transition leaving the deepest active state', () => {
    const { model, machineId } = buildPriority();
    const res = runStateMachine(model, machineId, ['go']);
    const names = res.visited.map((id) => model.get(id)!.declaredName);
    expect(names, 'the outer transition won a race the inner state should have taken').toEqual([
      'Outer',
      'inner',
      'innerTarget',
    ]);
    expect(res.fired).toHaveLength(1);
    expect(model.get(res.fired[0].from)!.declaredName).toBe('inner');

    const opening = initialConfig(model, machineId);
    const enabled = enabledTransitions(model, opening.config, { kind: 'trigger', trigger: 'go' });
    expect(enabled).toHaveLength(2);
    expect(
      model.get(enabled[0].transition.source![0])!.declaredName,
      'enabledTransitions no longer offers the innermost state first',
    ).toBe('inner');
    expect(enabled[0].level).toBeGreaterThan(enabled[1].level);
  });
});

describe('a step exits to the least common ancestor of its source and its target', () => {
  /*
   * Where a step out of, into or across a composite leaves the machine is the
   * relation's own rule, and the differential cannot see it either: both
   * drivers read `stepConfig`, so a wrong rule is wrong in both and the
   * comparison stays green. So each way a step can stand to the hierarchy is
   * pinned on its RESULT — the stack it leaves and the exit and entry actions
   * it performs, in order. The step used to exit only down to the source's
   * level and enter the target on top (`docs/06` §8.9): `back` left `[C0,
   * Idle]`, with `C0`'s own transitions still enabled, and every round trip
   * stacked one more state. Every transition is external: a self-transition
   * exits and re-enters its state (§8.10).
   */
  const nameOf = (model: Model, id: ElementId): string => model.get(id)!.declaredName ?? id;

  /** The configuration the relation leaves after `steps`, each fired as the interpreter fires it. */
  function configAfter(model: Model, machineId: ElementId, steps: string[]): MachineConfig {
    let cfg = initialConfig(model, machineId).config;
    for (const step of steps) {
      const enabled = enabledTransitions(model, cfg, { kind: 'trigger', trigger: step });
      if (enabled.length > 0) cfg = stepConfig(model, cfg, enabled[0]).config;
    }
    return cfg;
  }

  /** What the interpreter performed on the LAST of `steps`: its actions past those of all the others. */
  function lastStepPerformed(model: Model, machineId: ElementId, steps: string[]): string[] {
    const before = runStateMachine(model, machineId, steps.slice(0, -1)).performed.length;
    return runStateMachine(model, machineId, steps).performed.slice(before).map((a) => a.name);
  }

  const WAYS: Array<{ way: string; steps: string[]; stack: string[]; performed: string[] }> = [
    { way: 'between two substates of one composite', steps: ['go', 'x'], stack: ['C0', 'b'], performed: ['outa', 'inb'] },
    { way: 'out of its composite: the composite is exited too', steps: ['go', 'x', 'back'], stack: ['Idle'], performed: ['outb', 'outC0', 'inIdle'] },
    { way: 'to the composite’s sibling', steps: ['go', 'x', 'side'], stack: ['C1', 'p'], performed: ['outb', 'outC0', 'inC1', 'inp'] },
    { way: 'to its ancestor: exited and entered again, at its initial substate', steps: ['go', 'x', 'up'], stack: ['C0', 'a'], performed: ['outb', 'outC0', 'inC0', 'ina'] },
    { way: 'a self-transition on a substate: exited and entered again', steps: ['go', 'again'], stack: ['C0', 'a'], performed: ['outa', 'ina'] },
    { way: 'a self-transition on a composite: exited and entered again, at its initial substate', steps: ['go', 'x', 'reset'], stack: ['C0', 'a'], performed: ['outb', 'outC0', 'inC0', 'ina'] },
    { way: 'from a composite to its own substate: the composite is exited and entered again', steps: ['go', 'pick'], stack: ['C0', 'b'], performed: ['outa', 'outC0', 'inC0', 'inb'] },
    { way: 'into a nested state from outside: its composite is entered first', steps: ['dive'], stack: ['C1', 'q'], performed: ['outIdle', 'inC1', 'inq'] },
    { way: 'from a substate of one composite to a substate of another', steps: ['go', 'x', 'side', 'cross'], stack: ['C0', 'b'], performed: ['outp', 'outC1', 'inC0', 'inb'] },
    { way: 'a composite that was left offers its own transitions no more', steps: ['go', 'x', 'back', 'reset'], stack: ['Idle'], performed: [] },
  ];
  for (const w of WAYS) {
    it(w.way, () => {
      const { model, machineId } = buildLca();
      const cfg = configAfter(model, machineId, w.steps);
      expect(cfg.stack.map((id) => nameOf(model, id)), 'the active stack the step leaves').toEqual(w.stack);
      expect(lastStepPerformed(model, machineId, w.steps), 'the exit and entry actions, in order').toEqual(w.performed);
      const run = runStateMachine(model, machineId, w.steps);
      expect(nameOf(model, run.finalState!), 'the interpreter ends where the relation does').toBe(w.stack[w.stack.length - 1]);
    });
  }

  it('a round trip out of a composite stacks nothing', () => {
    const { model, machineId } = buildLca();
    const trips = ['go', 'x', 'back', 'go', 'x', 'back', 'go', 'x', 'back'];
    expect(configAfter(model, machineId, trips).stack.map((id) => nameOf(model, id))).toEqual(['Idle']);
    // Each `back` exits `C0` once and each `go` enters it once.
    const performed = runStateMachine(model, machineId, trips).performed.map((a) => a.name);
    expect(performed.filter((n) => n === 'outC0')).toHaveLength(3);
    expect(performed.filter((n) => n === 'inC0')).toHaveLength(3);
  });

  it('records where a composite was left, and a composite that resumes resumes there', () => {
    // `out` leaves from the substate `h2`, so the composite `H` is exited by the
    // step's exit cascade: `h2` first, recorded as `H`'s last-active child, then `H`.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Resume');
    const idle = f.state('Idle', sm.id);
    const h = m.create('StateUsage', { declaredName: 'H', ownerId: sm.id, attrs: { history: true } });
    const h1 = f.state('h1', h.id);
    const h2 = f.state('h2', h.id);
    f.transition(idle.id, h.id, { ownerId: sm.id, trigger: 'in' });
    f.transition(h1.id, h2.id, { ownerId: h.id, trigger: 'n' });
    f.transition(h2.id, idle.id, { ownerId: h.id, trigger: 'out' });

    const left = configAfter(m, sm.id, ['in', 'n', 'out']);
    expect(left.stack.map((id) => nameOf(m, id))).toEqual(['Idle']);
    expect(left.history.get(h.id)).toBe(h2.id);
    const back = configAfter(m, sm.id, ['in', 'n', 'out', 'in']);
    expect(back.stack.map((id) => nameOf(m, id))).toEqual(['H', 'h2']);
    expect(nameOf(m, runStateMachine(m, sm.id, ['in', 'n', 'out', 'in']).finalState!)).toBe('h2');
  });
});

describe('stepConfig never mutates its input', () => {
  it('leaves the stack, the store, the clock, the entry times and the history untouched', () => {
    const { model, machineId } = flatMachine();
    const opening = initialConfig(model, machineId);
    const before = {
      hash: hashConfig(opening.config),
      stack: [...opening.config.stack],
      store: [...opening.config.store.entries()],
      entryTime: [...opening.config.entryTime.entries()],
      history: [...opening.config.history.entries()],
      clock: opening.config.clock,
    };
    const enabled = enabledTransitions(model, opening.config, { kind: 'trigger', trigger: 'start' });
    expect(enabled.length, 'the flat machine no longer offers `start`').toBe(1);
    const next = stepConfig(model, opening.config, enabled[0]);

    expect(next.config).not.toBe(opening.config);
    expect(next.config.store).not.toBe(opening.config.store);
    expect(hashConfig(opening.config)).toBe(before.hash);
    expect([...opening.config.stack]).toEqual(before.stack);
    expect([...opening.config.store.entries()]).toEqual(before.store);
    expect([...opening.config.entryTime.entries()]).toEqual(before.entryTime);
    expect([...opening.config.history.entries()]).toEqual(before.history);
    expect(opening.config.clock).toBe(before.clock);
    // And the step really did something, so the assertions above are not
    // holding over a no-op.
    expect(next.effects.fired).toHaveLength(1);
    expect(hashConfig(next.config)).not.toBe(before.hash);
  });

  it('refuses a choice taken from another configuration', () => {
    const { model, machineId } = flatMachine();
    const opening = initialConfig(model, machineId);
    const enabled = enabledTransitions(model, opening.config, { kind: 'trigger', trigger: 'start' });
    const next = stepConfig(model, opening.config, enabled[0]);
    // `start` leaves `off`, which the next configuration is not in.
    expect(() => stepConfig(model, next.config, enabled[0])).toThrow(/another configuration/);
  });
});

describe('the edge kind a differential alone cannot see', () => {
  /**
   * A differential is green when BOTH drivers ignore the same edge, which is
   * exactly how a succession under a state machine stayed invisible to this
   * file while `reach` published two absence findings over it. Agreement is
   * necessary and is not sufficient: what the two agree ON has to be asserted
   * too, so the case above is paired with a statement about the RESULT.
   */
  it('both drivers traverse `first active then done`, rather than both ignoring it', () => {
    const { model, machineId } = buildSuccessionMix();
    const res = runStateMachine(model, machineId, []);
    expect(
      res.visited.map((id) => model.get(id)!.declaredName),
      'the succession is not walked: the machine stops at `active`',
    ).toEqual(['idle', 'active', 'done']);
    expect(res.fired).toHaveLength(2);
    expect(model.get(res.fired[1].transitionId)!.eClass).toBe('Succession');
    expectAgreement('succession mix', res, foldRun(model, machineId, []));
  });
});

/**
 * THE ORACLE, AND THE REPLAY SWEEP (plan O1: review B's `oracle.mts` and
 * `witness-sweep.mts`, made standing tests).
 *
 * The differential above holds the two DRIVERS to one relation on runs the
 * interpreter takes. What it cannot see is a claim the CHECKER makes about runs
 * it did not take: `reach` and `check-behaviour` publish absences — unreachable,
 * dead, a safety `pass`, a `not-covered` — and an absence is false the moment
 * the interpreter does the thing. The chase budget was such a gap: the walk
 * never took an event where a chase stopped, and published `admissionFails`
 * dead on v9 while the interpreter fired it on `[peerVerdict]`.
 *
 * So the interpreter is driven over every event sequence up to length three on
 * every machine of the corpus (the verification fixtures, the agent-authoring
 * fixtures, the shipped examples, and review B's probe shapes inline), capped
 * per machine, and nothing it visits or fires may be one the checker called
 * impossible. And every witness those machines publish — their own properties,
 * plus `cover` and `absence` of every state — must replay through the
 * interpreter, independently of the replay the engine itself does.
 */
describe('the interpreter never does what the checker calls impossible, and every witness replays', () => {
  const DEPTH = 3;
  const RUN_CAP = 1500;
  /**
   * Review B's probe shapes, so the oracle holds where the corpus has no such
   * machine — and two of review S5's: a way into a completion cycle only a
   * branch the simulator never takes leads to, on a machine whose choice row
   * the walk withholds (`wi-hidden-choice`), and a chain whose back-edge the
   * chase reaches only on the budget's last step (`edge-chain62`).
   */
  const PROBES: Record<string, string> = {
    'wi-hidden-choice.sysml': `package WI { part def P {
      attribute x : Integer;
      state def M {
        state s0;
        state comp { state i1; transition i1self first i1 if x > 0 then i1; }
        state good; state a; state b;
        transition go first s0 accept go then comp;
        transition c1 first comp then good;
        transition c2 first comp then a;
        transition ab first a then b;
        transition ba first b then a;
        transition gs first good accept e then s0;
      }
    } }`,
    'edge-chain62.sysml': `package Edge62 { state def M { ${Array.from({ length: 65 }, (_, i) => `state c${i};`).join(' ')} ${Array.from(
      { length: 64 },
      (_, i) => `transition t${i} first c${i} then c${i + 1};`,
    ).join(' ')} transition back first c64 then c63; } }`,
    'livelock-two.sysml': `package LiveTwo { state def M {
      state s0; state a; state b; state c;
      transition go first s0 accept go then a;
      transition ab first a then b;
      transition ba first b then a;
      transition ac first a accept e then c;
    } }`,
    'livelock-self.sysml': `package LiveSelf { state def M {
      state a; state b;
      transition spin first a then a;
      transition leave first a accept e then b;
    } }`,
    'longchain.sysml': (() => {
      const states = ['s0', ...Array.from({ length: 70 }, (_, i) => `c${i + 1}`), 'z'];
      const lines = states.map((s) => `state ${s};`);
      lines.push('transition go first s0 accept go then c1;', 'transition jump first s0 accept jump then c30;');
      for (let i = 1; i < 70; i++) lines.push(`transition t${i} first c${i} then c${i + 1};`);
      lines.push('transition esc first c65 accept e then z;');
      return `package LongChain { state def M { ${lines.join(' ')} } }`;
    })(),
    'swarm-modes.sysml': `package Modes { state def SwarmMemberModes {
      initial start;
      state Nominal; state NavigationDegraded; state Isolated; state Quarantined; state Readmitted;
      transition start -> Nominal;
      transition Nominal -> NavigationDegraded;
      transition NavigationDegraded -> Nominal;
      transition Nominal -> Isolated;
      transition Isolated -> Quarantined;
      transition admissionFails first Nominal accept peerVerdict then Quarantined;
      transition readmissionPasses first Quarantined accept readmitVerdict then Readmitted;
      transition Readmitted -> Nominal;
    } }`,
    'choice-plain.sysml': `package ChoicePlain { state def M {
      state a; state b; state c; state d;
      transition ab first a then b;
      transition ac first a then c;
      transition bd first b accept e then d;
    } }`,
    // docs/06 §8.12: a trigger-less cycle, where a counting monitor's search
    // ends the run where the budget stops its one chase; and the same cycle
    // with a choice out of it, so the tie-break's other runs are searched too.
    'tl-cycle.sysml': `package TlCycle { state def M { state a; state b; transition ab first a then b; transition ba first b then a; } }`,
    'tl-cycle-exit.sysml': `package TlCycleExit { state def M {
      state a; state b; state c;
      transition ab first a then b; transition ba first b then a; transition bc first b then c;
    } }`,
    // O8 S1's review: each way a step can stand to the hierarchy (docs/06
    // §8.10), so a witness through a step that enters a target's enclosing
    // states is replayed, and a machine with no composite whose step targets a
    // node inside a state is held to what the interpreter does.
    'lca-out.sysml': `package LcaOut { state def M {
      state Idle;
      state C0 { state a; state b; transition ab first a accept x then b; transition bk first b accept back then Idle; }
      transition go first Idle accept go then C0;
    } }`,
    'lca-dive.sysml': `package LcaDive { state def M {
      state Idle;
      state C1 { state p; state q; transition pq first p accept x then q; }
      transition dive first Idle accept dive then C1::q;
      transition home first C1 accept home then Idle;
    } }`,
    'lca-cousin.sysml': `package LcaCousin { state def M {
      state Idle;
      state A { state a1; state a2; state a3; transition x first a1 accept x then a2; }
      state B { state b1; state b2; }
      transition go first Idle accept go then A;
      transition cross first A::a2 accept cross then B::b2;
      transition pick first A accept pick then A::a3;
      transition up first B::b2 accept up then B;
    } }`,
    'lca-into-leaf.sysml': `package LcaIntoLeaf { state def M {
      state a; state b { action inner; } state c;
      transition t1 first a accept go then b::inner;
      transition t3 first b accept x then c;
    } }`,
    'lca-flat-act.sysml': `package LcaFlatAct { state def M {
      state Idle; state S { action work; } state Z;
      transition go first Idle accept go then S::work;
      transition settle first S then Idle;
      transition ez first S::work accept e then Z;
    } }`,
  };

  interface Loaded {
    name: string;
    model: Model;
  }
  const corpus: Loaded[] = [];
  beforeAll(async () => {
    const files = [
      ...readdirSync(resolve(process.cwd(), 'test/fixtures/verification/models'))
        .filter((f) => f.endsWith('.sysml'))
        .map((f) => `test/fixtures/verification/models/${f}`),
      ...readdirSync(resolve(process.cwd(), 'test/fixtures/agent-authoring')).flatMap((d) =>
        ['input.sysml', 'fixed.sysml']
          .map((f) => `test/fixtures/agent-authoring/${d}/${f}`)
          .filter((p) => existsSync(resolve(process.cwd(), p))),
      ),
      ...readdirSync(resolve(process.cwd(), 'examples'))
        .filter((f) => f.endsWith('.sysml'))
        .map((f) => `examples/${f}`),
    ];
    for (const file of files) {
      const text = read(file);
      if (!/\b(transition|accept)\b/.test(text)) continue;
      const loaded = await loadModelText(text, { fileName: file, library: file.startsWith('examples/') ? 'full' : 'none' });
      if (loaded.model) corpus.push({ name: file, model: loaded.model });
    }
    for (const [name, text] of Object.entries(PROBES)) {
      corpus.push({ name, model: (await loadModelText(text, { fileName: name, library: 'none' })).model! });
    }
  }, 180_000);

  /** Every event sequence over `alphabet` up to `DEPTH` long, shortest first, at most `RUN_CAP`. */
  function sequences(alphabet: readonly string[]): string[][] {
    const out: string[][] = [[]];
    for (let head = 0; head < out.length && out.length < RUN_CAP; head++) {
      if (out[head].length === DEPTH) continue;
      for (const a of alphabet) if (out.length < RUN_CAP) out.push([...out[head], a]);
    }
    return out;
  }

  /** Each machine's state named as `state X` can name it — the atom reads a declared name. */
  function nameable(model: Model, machineId: ElementId): ElementRecord[] {
    return machineStates(model, machineId).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.declaredName ?? ''));
  }

  it('finds every machine of the corpus, the four probe shapes among them', () => {
    const machines = corpus.flatMap((c) => stateMachinesIn(c.model));
    expect(machines.length).toBeGreaterThanOrEqual(30);
    expect(corpus.map((c) => c.name)).toEqual(expect.arrayContaining(Object.keys(PROBES)));
  });

  it('the oracle: nothing the interpreter visits or fires is unreachable, dead, passed absent or not covered', () => {
    const problems: string[] = [];
    for (const { name, model } of corpus) {
      const report = reachReport(model);
      for (const m of report.machines) {
        const where = `${name} ${m.machine.qualifiedName}`;
        const visited = new Set<ElementId>();
        const fired = new Set<ElementId>();
        for (const events of sequences(m.bounds.alphabet)) {
          const run = runStateMachine(model, m.machine.id, events);
          for (const v of run.visited) visited.add(v);
          for (const f of run.fired) fired.add(f.transitionId);
        }
        for (const s of m.states.unreachable) if (visited.has(s.id)) problems.push(`${where}: unreachable ${s.name}, and a run visits it`);
        for (const t of m.transitions.dead) if (fired.has(t.id)) problems.push(`${where}: dead ${t.qualifiedName}, and a run fires it`);
        for (const s of nameable(model, m.machine.id)) {
          if (!visited.has(s.id)) continue;
          for (const pattern of ['absence', 'cover'] as const) {
            const v = behaviourReport(model, {
              machineId: m.machine.id,
              pattern: `pattern=${pattern}, scope=globally, p=state ${s.declaredName}`,
            }).properties.at(-1)!;
            if (pattern === 'absence' && v.claim === 'pass') problems.push(`${where}: absence of ${s.declaredName} passes, and a run visits it`);
            if (pattern === 'cover' && v.claim === 'not-covered') problems.push(`${where}: ${s.declaredName} not covered, and a run visits it`);
          }
        }
        // The machine's own properties, over a `state` atom globally.
        for (const v of behaviourReport(model, { machineId: m.machine.id }).properties) {
          const atom = /^state (\w+)$/.exec((v.property as { p?: string }).p ?? '');
          if (!atom || v.scope !== 'globally') continue;
          const target = nameable(model, m.machine.id).find((s) => s.declaredName === atom[1]);
          if (!target || !visited.has(target.id)) continue;
          if (v.pattern === 'absence' && v.claim === 'pass') problems.push(`${where}: its own absence of ${atom[1]} passes, and a run visits it`);
          if (v.pattern === 'cover' && v.claim === 'not-covered') problems.push(`${where}: its own cover of ${atom[1]} is not covered, and a run visits it`);
        }
      }
    }
    expect(problems).toEqual([]);
  }, 300_000);

  /**
   * The states a run's LAST chase went round, read over configurations: the
   * run's fires re-stepped through `./mc/config.ts` from the opening the walk
   * starts from, the last chase cut out (everything after the last fire on an
   * event), and — where that chase spent the whole budget and came back to a
   * configuration it had been at — the union of the active stacks over one
   * period. `null` for a chase that rested, a chain longer than the budget
   * (no configuration repeats), or a run this re-stepping cannot follow.
   */
  function lastChaseCycle(model: Model, machineId: ElementId, run: StateRunResult, maxCompletion: number): ElementId[] | null {
    const store = new Map<string, unknown>();
    seedStore(model, model.get(machineId)!, store);
    let cfg: MachineConfig = initialConfig(model, machineId, { store }).config;
    let chase: MachineConfig[] = [cfg];
    for (const f of run.fired) {
      const input: StepInput = f.trigger === '' ? COMPLETION : { kind: 'trigger', trigger: f.trigger };
      const choice = enabledTransitions(model, cfg, input).find((e) => e.transition.id === f.transitionId);
      if (choice === undefined) return null;
      cfg = stepConfig(model, cfg, choice).config;
      if (f.trigger !== '') chase = [];
      chase.push(cfg);
    }
    if (chase.length - 1 < maxCompletion) return null;
    const firstAt = new Map<string, number>();
    for (let i = 0; i < chase.length; i++) {
      const h = hashConfig(chase[i]);
      const j = firstAt.get(h);
      if (j !== undefined) return [...new Set(chase.slice(j, i).flatMap((c) => c.stack))];
      firstAt.set(h, i);
    }
    return null;
  }

  it('the livelock oracle: a run whose last chase the budget stops going round a cycle names a row’s states, and a row the simulator enters is one some run goes round', () => {
    // U1 (plan O1 S4). The row says the interpreter's chase goes round a cycle
    // and never rests there; the interpreter is asked both ways, over
    // CONFIGURATIONS as the row is decided (`lastChaseCycle`). Completeness:
    // every driven run whose last chase spent the whole budget and came back
    // to a configuration — a chase stopped going round, not a chain longer
    // than the budget — went round the states of a livelock row, published or
    // withheld. Soundness, per ROW and not per machine: a published row whose
    // way in is the simulator's own run (`entryBy: 'simulator'`) is one some
    // driven run goes round. A row whose way in is the walk's says in its
    // finding that `simulate` may never enter it, and is not held to that —
    // which is the line a machine-wide test (skip a machine with a choice row)
    // drew in the wrong place: the walk withholds a choice row over an
    // undecided guard inside its level and still takes both branches.
    const problems: string[] = [];
    let rows = 0;
    let simulated = 0;
    const key = (ids: Iterable<ElementId>) => [...new Set(ids)].sort().join(' ');
    for (const { name, model } of corpus) {
      for (const m of reachReport(model).machines) {
        const where = `${name} ${m.machine.qualifiedName}`;
        const named = new Set([...m.livelocks, ...m.livelocksWithheld].map((l) => key(l.states.map((s) => s.id))));
        rows += m.livelocks.length;
        const goneRound = new Set<string>();
        for (const events of sequences(m.bounds.alphabet)) {
          const run = runStateMachine(model, m.machine.id, events);
          if (!run.completionBudgetHit) continue;
          const cycle = lastChaseCycle(model, m.machine.id, run, m.bounds.maxCompletion);
          if (cycle === null) continue;
          goneRound.add(key(cycle));
          if (!named.has(key(cycle))) {
            problems.push(
              `${where}: [${events.join(',')}] goes round {${cycle.map((s) => model.get(s)?.declaredName).join(', ')}} in its last chase, which no livelock row names`,
            );
          }
        }
        for (const l of m.livelocks) {
          if (l.entryBy !== 'simulator') continue;
          simulated++;
          if (!goneRound.has(key(l.states.map((s) => s.id)))) {
            problems.push(`${where}: livelock {${l.states.map((s) => s.name).join(', ')}} says the simulator enters it, and no run goes round it`);
          }
        }
      }
    }
    expect(rows, 'no corpus machine carries a livelock row, so the oracle checked nothing').toBeGreaterThanOrEqual(4);
    expect(simulated, 'no row was held to the soundness half').toBeGreaterThanOrEqual(4);
    expect(problems).toEqual([]);
  }, 300_000);

  it('the count oracle: on a machine that names no trigger, a count is decided at the budget, and never passed below the run’s own (docs/06 §8.12)', () => {
    // Every run of such a machine is the one chase from the opening, which the
    // interpreter ends where the budget stops it. So a `bounded-existence` of a
    // state is decided over the runs the budget allows — no row is refused as
    // a chase past it — and none passes at a count the declaration-order run
    // itself goes over: the run's occurrences of the state, counted as the
    // monitor counts them (rising edges of the state on the active stack),
    // over the stacks re-stepped through `./mc/config.ts`.
    const problems: string[] = [];
    let decided = 0;
    let scoped = 0;
    for (const { name, model } of corpus) {
      for (const m of reachReport(model).machines) {
        if (m.bounds.alphabet.length > 0 || !m.exhaustive || m.undeterminedGuards.length > 0) continue;
        const walk = exploreMachine(model, m.machine.id);
        if (walk.timedTransitions.size > 0) continue;
        const run = runStateMachine(model, m.machine.id, []);
        const store = new Map<string, unknown>();
        seedStore(model, model.get(m.machine.id)!, store);
        let cfg: MachineConfig = initialConfig(model, m.machine.id, { store }).config;
        const stacks: (readonly ElementId[])[] = [cfg.stack];
        let followed = true;
        for (const f of run.fired) {
          const choice = enabledTransitions(model, cfg, COMPLETION).find((e) => e.transition.id === f.transitionId);
          if (choice === undefined) {
            followed = false;
            break;
          }
          cfg = stepConfig(model, cfg, choice).config;
          stacks.push(cfg.stack);
        }
        if (!followed) {
          problems.push(`${name} ${m.machine.qualifiedName}: the run could not be re-stepped`);
          continue;
        }
        for (const s of nameable(model, m.machine.id)) {
          const count = stacks.filter((st, i) => st.includes(s.id) && (i === 0 || !stacks[i - 1].includes(s.id))).length;
          for (const n of count > 0 ? [count, count - 1] : [count]) {
            const v = behaviourReport(model, {
              machineId: m.machine.id,
              pattern: `pattern=bounded-existence, scope=globally, p=state ${s.declaredName}, n=${n}`,
            }).properties.at(-1)!;
            const where = `${name} ${m.machine.qualifiedName}: at most ${n} of ${s.declaredName} (the run has ${count})`;
            if (v.boundHit === 'completion') problems.push(`${where}: refused as a chase past the budget`);
            if (v.claim !== 'pass' && v.claim !== 'fail') problems.push(`${where}: ${v.claim}, not decided`);
            if (n < count && v.claim === 'pass') problems.push(`${where}: passes below the run's own count`);
            if (v.claim === 'pass' || v.claim === 'fail') decided++;
          }
        }
        // THE SCOPED HALF (the whole-branch review's cyc65). A scope is opened
        // and closed by what a run does, so where the walk meets no choice the
        // run above is the machine's only run, and a scope it does not open is
        // one no run opens. `absence of r between q and r` then passes exactly
        // where that run closes a segment (a `q` without `r`, and a later `r`)
        // and is vacuous where it does not; `precedence` after `q` with `s = q`
        // passes exactly where an `r` is on the run at or after the first `q`.
        // With `q` held where the run ends — the budget's stop on a cycle —
        // the only step that could close the segment or show the `r` is the
        // one past the budget, which no run takes: the search folded the
        // vacuity flags on that step before it dropped it, and printed `pass`.
        if (m.nondeterminism.length > 0) continue;
        const states = nameable(model, m.machine.id);
        const closes = (q: ElementId, r: ElementId) =>
          stacks.some((st, i) => st.includes(q) && !st.includes(r) && stacks.slice(i + 1).some((later) => later.includes(r)));
        const follows = (q: ElementId, r: ElementId) => {
          const first = stacks.findIndex((st) => st.includes(q));
          return first >= 0 && stacks.slice(first).some((st) => st.includes(r));
        };
        const ending = states.filter((s) => stacks[stacks.length - 1].includes(s.id));
        const asked = (pattern: string) =>
          behaviourReport(model, { machineId: m.machine.id, pattern }).properties.at(-1)!;
        for (const q of ending) {
          for (const r of states) {
            const where = `${name} ${m.machine.qualifiedName}: q ${q.declaredName}, r ${r.declaredName}`;
            const between = asked(`pattern=absence, scope=between, q=state ${q.declaredName}, r=state ${r.declaredName}, p=state ${r.declaredName}`);
            if (between.claim !== (closes(q.id, r.id) ? 'pass' : 'vacuous')) {
              problems.push(`${where}: between is ${between.claim}, and the run ${closes(q.id, r.id) ? 'closes' : 'closes no'} segment`);
            }
            const after = asked(`pattern=precedence, scope=after, q=state ${q.declaredName}, s=state ${q.declaredName}, p=state ${r.declaredName}`);
            if (after.claim !== (follows(q.id, r.id) ? 'pass' : 'vacuous')) {
              problems.push(`${where}: precedence after is ${after.claim}, and the run ${follows(q.id, r.id) ? 'shows' : 'shows no'} r at or after q`);
            }
            scoped++;
          }
          // And the other way round: segments the run closes where it ends.
          for (const o of states) {
            const where = `${name} ${m.machine.qualifiedName}: q ${o.declaredName}, r ${q.declaredName}`;
            const between = asked(`pattern=absence, scope=between, q=state ${o.declaredName}, r=state ${q.declaredName}, p=state ${q.declaredName}`);
            if (between.claim !== (closes(o.id, q.id) ? 'pass' : 'vacuous')) {
              problems.push(`${where}: between is ${between.claim}, and the run ${closes(o.id, q.id) ? 'closes' : 'closes no'} segment`);
            }
            scoped++;
          }
        }
      }
    }
    expect(problems).toEqual([]);
    // Not vacuous: the cycles above, and the corpus's own trigger-less machines.
    expect(decided).toBeGreaterThan(20);
    expect(scoped, 'no machine without a choice was asked a scoped question').toBeGreaterThan(100);
  }, 300_000);

  it('the replay sweep: every published witness is a run the interpreter takes', () => {
    let witnesses = 0;
    const problems: string[] = [];
    for (const { name, model } of corpus) {
      for (const m of reachReport(model).machines) {
        const reports = [behaviourReport(model, { machineId: m.machine.id })];
        for (const s of nameable(model, m.machine.id)) {
          if (!m.states.reachable.some((r) => r.id === s.id)) continue;
          for (const pattern of ['absence', 'cover']) {
            reports.push(behaviourReport(model, { machineId: m.machine.id, pattern: `pattern=${pattern}, scope=globally, p=state ${s.declaredName}` }));
          }
        }
        for (const v of reports.flatMap((r) => r.properties)) {
          const where = `${name} ${m.machine.qualifiedName} ${v.sentence}`;
          if (v.code === WITNESS_NOT_REPLAYED_CODE) problems.push(`${where}: withheld, the witness did not replay`);
          if (v.witness.length === 0) continue;
          witnesses++;
          // Independently of `replayWitness`: the events in, the tie-break the
          // witness's way, and every fire compared with the trace.
          const steps = v.witness.slice(1);
          const run = runStateMachine(
            model,
            m.machine.id,
            steps.filter((s) => s.event !== '').map((s) => s.event),
            { follow: steps.map((s) => s.transition!.id) },
          );
          const opened = runStateMachine(model, m.machine.id, [], { maxCompletion: 0 }).visited;
          if (opened.at(-1) !== v.witness[0].leaf?.id) problems.push(`${where}: opens elsewhere`);
          steps.forEach((s, i) => {
            const got = run.fired[i];
            if (got?.transitionId !== s.transition!.id || got.trigger !== s.event || !s.stack.some((x) => x.id === got.to)) {
              problems.push(`${where}: parts at step ${s.index}`);
            }
          });
        }
      }
    }
    expect(problems).toEqual([]);
    // Not vacuous: the corpus publishes witnesses, the long chase ones included.
    expect(witnesses).toBeGreaterThan(100);
  }, 300_000);
});
