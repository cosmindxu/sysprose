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
import { readFileSync } from 'node:fs';
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

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/* ─────────────────────────── the second driver ──────────────────────────── */

interface Folded {
  visited: ElementId[];
  fired: Array<{ transitionId: ElementId; from: ElementId; to: ElementId; trigger: string }>;
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
    out.fired.push(...r.effects.fired);
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
  expect(res.fired, `${label}: fired`).toEqual(fold.fired);
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
