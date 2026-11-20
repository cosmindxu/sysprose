/**
 * A parallel machine ROOT (`state def M parallel { … }`, `exhibit state m parallel { … }`, SysML v2 §7.18.2) is
 * performed as a parallel state is: every region entered at once, every event offered to every region in declaration
 * order (a region with no enabled transition stays), per-region completion. The interpreter (`runStateMachine`) and
 * the explorer (`exploreMachine`, through `./mc/parallel`) agree on every event sequence up to a bound; what neither
 * performs is refused with a stated reason; Simulate stops where the run does.
 */
import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { loadModelText } from '@text/load';
import { runStateMachine, parallelRoot, refusalStopsRun, SimulationSession, simulationAtRest } from '../../src/semantics/index';
import { exploreMachine, reachReport } from '../../src/semantics/mc/explore';
import { SEMANTIC_PROFILE } from '../../src/semantics/mc/profile';
import {
  MAX_COMPLETION,
  activeLeavesOf,
  seedStore,
  type MachineConfig,
  type StepInput,
} from '../../src/semantics/mc/config';
import { advanceConfig, candidatesOf, openConfig } from '../../src/semantics/mc/parallel';

const find = (m: any, n: string): any => m.all().find((e: any) => m.qualifiedName(e.id) === n);
async function load(src: string, effects: Record<string, string> = {}): Promise<any> {
  const l: any = await loadModelText(src, { fileName: 'pr.sysml' });
  for (const [q, eff] of Object.entries(effects)) find(l.model, q).attrs.effect = eff;
  return l.model;
}

const region = (n: string, a: string, b: string, ev: string, extra = '') =>
  `state ${n} { entry; then ${a}; state ${a}; state ${b} ${extra}; transition t_${n} first ${a} accept ${ev} then ${b}; }`;
const root = (body: string, tail = '') =>
  `package P { item def e; item def f; item def g; attribute n : Integer = 0; state def M parallel { ${body} ${tail} } }`;

const MACHINES: Record<string, { src: string; effects?: Record<string, string> }> = {
  'two regions on one event': { src: root(region('r1', 'a1', 'a2', 'f') + region('r2', 'b1', 'b2', 'f')) },
  'a region that stays': { src: root(region('r1', 'a1', 'a2', 'f') + region('r2', 'b1', 'b2', 'g')) },
  'a region guarded by an attribute nobody writes': {
    src: root(
      region('r1', 'a1', 'a2', 'f') +
        'state r2 { entry; then b1; state b1; state b2; transition u first b1 accept f if n == 0 then b2; }',
    ),
  },
  'a trigger-less step inside a region': {
    src: root(
      'state r1 { entry; then a1; state a1; state a2; state a3; transition t first a1 accept f then a2; transition c first a2 then a3; }' +
        region('r2', 'b1', 'b2', 'g'),
    ),
  },
  'three regions, one of them without substates': { src: root(region('r1', 'a1', 'a2', 'f') + region('r2', 'b1', 'b2', 'g') + 'state r3;') },
  'a region that cycles back': {
    src: root(
      'state r1 { entry; then a1; state a1; state a2; transition t first a1 accept e then a2; transition v first a2 accept e then a1; }' +
        region('r2', 'b1', 'b2', 'g'),
    ),
  },
  'a nested composite inside a region': {
    src: root(
      'state r1 { entry; then a1; state a1 { entry; then x1; state x1; state x2; transition w first x1 accept g then x2; } state a2; transition t first a1 accept f then a2; }' +
        region('r2', 'b1', 'b2', 'g'),
    ),
  },
};

const EVENTS = ['e', 'f', 'g'];
const sequences = (len: number): string[][] => {
  let out: string[][] = [[]];
  let layer: string[][] = [[]];
  for (let i = 0; i < len; i++) {
    layer = layer.flatMap((s) => EVENTS.map((x) => [...s, x]));
    out = out.concat(layer);
  }
  return out;
};

/** The second driver: the explorer's own relation, event by event, taking the first enabled choice as the interpreter does. */
function drive(model: any, machineId: string, events: string[]): { leaves: string[]; store: Record<string, unknown> } {
  const COMPLETION: StepInput = { kind: 'completion' };
  const seeded = new Map<string, unknown>();
  seedStore(model, model.get(machineId), seeded);
  let cfg: MachineConfig = openConfig(model, machineId, { store: seeded }).config;
  const chase = (): void => {
    for (let k = 0; k < MAX_COMPLETION; k++) {
      const en = candidatesOf(model, cfg, COMPLETION).enabled;
      if (en.length === 0) return;
      cfg = advanceConfig(model, cfg, en[0]).config;
    }
  };
  chase();
  for (const ev of events) {
    const en = candidatesOf(model, cfg, { kind: 'trigger', trigger: ev }).enabled;
    if (en.length > 0) {
      cfg = advanceConfig(model, cfg, en[0]).config;
      chase();
    }
  }
  return { leaves: activeLeavesOf(cfg).map((s) => model.qualifiedName(s)), store: Object.fromEntries(cfg.store) };
}

describe('a parallel machine root: the explorer agrees with the interpreter', () => {
  for (const [name, { src, effects }] of Object.entries(MACHINES)) {
    it(`${name}: every event sequence up to 4 events reaches the same configuration`, async () => {
      const model = await load(src, effects);
      const id = find(model, 'P::M').id;
      expect(exploreMachine(model, id).unsupported).toEqual([]);
      for (const seq of sequences(4)) {
        const run = runStateMachine(model, id, seq);
        expect(run.unopened, seq.join(',')).toBeUndefined();
        expect(run.refused, seq.join(',')).toBeUndefined();
        const want = run.activeStates.map((s: string) => model.qualifiedName(s)).sort();
        const got = drive(model, id, seq);
        expect([...got.leaves].sort(), `${name} after ${seq.join(',')}`).toEqual(want);
        expect(got.store, `${name} store after ${seq.join(',')}`).toEqual(Object.fromEntries(run.valueStore));
      }
    });
    it(`${name}: the walk's configurations are exactly the interpreter's reachable leaf sets`, async () => {
      const model = await load(src, effects);
      const id = find(model, 'P::M').id;
      const walk = exploreMachine(model, id);
      expect(walk.exhaustive).toBe(true);
      const key = (names: string[]): string => [...names].sort().join(' | ');
      const walked = new Set(walk.configRegionLeaves.map((ls) => key(ls.map((s) => model.qualifiedName(s)))));
      const run = new Set<string>();
      for (const seq of sequences(6)) {
        run.add(key(runStateMachine(model, id, seq).activeStates.map((s: string) => model.qualifiedName(s))));
      }
      for (const k of run) expect(walked.has(k), `the walk lacks ${k}`).toBe(true);
      if (!name.includes('trigger-less')) expect([...walked].sort()).toEqual([...run].sort());
    });
  }

  it('reach decides it: every state of every region reachable, none dead, exhaustive', async () => {
    const model = await load(MACHINES['two regions on one event'].src);
    const r = reachReport(model, { scopeId: find(model, 'P::M').id });
    expect(r.machines[0].exhaustive).toBe(true);
    expect(r.machines[0].states.unreachable).toEqual([]);
    expect(r.machines[0].transitions.dead).toEqual([]);
  });

  it('exhibit state m parallel { … } is performed and explored the same way', async () => {
    const src =
      'package P { item def e; item def f; part def X { exhibit state m parallel { ' +
      region('r1', 'a1', 'a2', 'e') +
      region('r2', 'b1', 'b2', 'f') +
      ' } } }';
    const model = await load(src);
    const id = find(model, 'P::X::m').id;
    const walk = exploreMachine(model, id);
    expect(walk.unsupported).toEqual([]);
    expect(walk.exhaustive).toBe(true);
    for (const seq of [[], ['e'], ['f'], ['e', 'f'], ['f', 'e']]) {
      const run = runStateMachine(model, id, seq);
      expect(run.unopened).toBeUndefined();
      expect([...drive(model, id, seq).leaves].sort()).toEqual(run.activeStates.map((s: string) => model.qualifiedName(s)).sort());
    }
    expect(runStateMachine(model, id, ['e', 'f']).activeStates.map((s: string) => model.qualifiedName(s))).toEqual([
      'P::X::m::r1::a2',
      'P::X::m::r2::b2',
    ]);
  });
});

describe('a parallel machine root: what the interpreter does', () => {
  it('enters every region at once and offers every event to every region in declaration order', async () => {
    const model = await load(MACHINES['a region that stays'].src);
    const id = find(model, 'P::M').id;
    const q = (r: any): string[] => r.activeStates.map((s: string) => model.qualifiedName(s));
    expect(q(runStateMachine(model, id, []))).toEqual(['P::M::r1::a1', 'P::M::r2::b1']);
    const run = runStateMachine(model, id, ['f', 'g']);
    expect(q(run)).toEqual(['P::M::r1::a2', 'P::M::r2::b2']);
    expect(run.fired.map((x: any) => x.trigger)).toEqual(['f', 'g']);
    expect(q(runStateMachine(model, id, ['g', 'f']))).toEqual(q(run));
  });

  it('one event taken by two regions fires both, in declaration order', async () => {
    const model = await load(MACHINES['two regions on one event'].src);
    const run = runStateMachine(model, find(model, 'P::M').id, ['f']);
    expect(run.fired.map((x: any) => model.qualifiedName(x.transitionId))).toEqual(['P::M::r1::t_r1', 'P::M::r2::t_r2']);
  });

  it('the old reading is gone: events reach the regions one at a time, not region by region over the script', async () => {
    // r1 takes `g`, r2 takes `f`; the script is f, g. Concatenated, r1 (over the whole script) would fire first;
    // performed together, `f` (r2) is fired before `g` (r1).
    const model = await load(root(region('r1', 'a1', 'a2', 'g') + region('r2', 'b1', 'b2', 'f')));
    const run = runStateMachine(model, find(model, 'P::M').id, ['f', 'g']);
    expect(run.fired.map((x: any) => model.qualifiedName(x.transitionId))).toEqual(['P::M::r2::t_r2', 'P::M::r1::t_r1']);
  });

  it('completion is per region: complete only when every region stands at a final state', async () => {
    const src = root(
      'state r1 { entry; then a1; state a1; state final; transition t first a1 accept e then final; }' +
        'state r2 { entry; then b1; state b1; state final; transition u first b1 accept f then final; }',
    );
    const model = await load(src);
    const id = find(model, 'P::M').id;
    expect(runStateMachine(model, id, []).complete).toBe(false);
    expect(runStateMachine(model, id, ['e']).complete).toBe(false);
    expect(runStateMachine(model, id, ['f']).complete).toBe(false);
    expect(runStateMachine(model, id, ['e', 'f']).complete).toBe(true);
    expect(runStateMachine(model, id, ['f', 'e']).complete).toBe(true);
  });

  it('a parallel machine with no state runs as any machine does', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Empty');
    m.setAttrs(sm.id, { parallel: true });
    expect(parallelRoot(m, m.get(sm.id)!)).toBe(false);
    expect(runStateMachine(m, sm.id, ['e']).unopened).toBeUndefined();
  });
});

describe('a parallel machine root: what stays refused, with a reason', () => {
  const both = async (src: string): Promise<{ explorer: string; interp: string }> => {
    const model = await load(src);
    const id = find(model, 'P::M').id;
    const u = exploreMachine(model, id).unsupported;
    expect(u.map((x) => x.construct)).toEqual(['parallel-regions']);
    const run = runStateMachine(model, id, ['e']);
    expect(run.activeStates).toEqual([]);
    return { explorer: u[0].detail, interp: run.unopened ?? '' };
  };
  const shapes: Record<string, [string, RegExp]> = {
    'a parallel state below the root': [root('state r1 parallel { state s1; state s2; } state r2;'), /below a parallel machine/],
    'a TRIGGERED transition from the root into one of its regions': [root('state r1; state r2;', 'transition done first M accept e then r1;'), /steps into one of its own regions/],
    'a transition between two regions': [root('state r1 { state a; } state r2 { state b; }', 'transition x first r1::a accept e then r2::b;'), /connects two regions/],
    'an entry action naming a start on the root': [root('entry; then r1; state r1; state r2;'), /entry action naming a start/],
  };
  for (const [name, [src, why]] of Object.entries(shapes)) {
    it(`${name}: refused by both`, async () => {
      const { explorer, interp } = await both(src);
      expect(interp).toMatch(/§7\.18\.2/);
      expect(interp).toMatch(why);
      expect(explorer).toMatch(why);
    });
  }

  it('coupled regions: the interpreter runs them in declaration order, the explorer explores every order', async () => {
    const r1 = 'state r1 { entry; then a1; state a1; state a2; transition t first a1 accept f then a2; }';
    const r2 = 'state r2 { entry; then b1; state b1; state b2; transition u first b1 accept f if n == 1 then b2; }';
    const model = await load(root(r1 + r2), { 'P::M::r1::t': 'n = 1' });
    const id = find(model, 'P::M').id;
    const walk = exploreMachine(model, id);
    expect(walk.exhaustive).toBe(true);
    expect(walk.unsupported).toEqual([]);
    expect(runStateMachine(model, id, ['f']).activeStates.map((s: string) => model.qualifiedName(s)).sort()).toEqual(['P::M::r1::a2', 'P::M::r2::b2']);
    expect(reachReport(model, { scopeId: id }).machines[0].qualification).not.toMatch(/not explored/);
  });

  it('history inside a region (set through the API) is refused', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const par = f.stateDef('M');
    m.setAttrs(par.id, { parallel: true });
    const r1 = f.state('r1', par.id);
    f.state('a', r1.id);
    const h = f.state('h', r1.id);
    m.setAttrs(h.id, { kind: 'history' });
    f.state('r2', par.id);
    const u = exploreMachine(m, par.id).unsupported;
    expect(u.map((x) => x.construct)).toContain('parallel-regions');
    expect(u.map((x) => x.construct)).toContain('history-state');
    expect(runStateMachine(m, par.id, []).unopened).toMatch(/history/);
  });

  it('a step into the root stops the whole run where it stands, and Play stops with it', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const par = f.stateDef('Par');
    m.setAttrs(par.id, { parallel: true });
    const r1 = f.state('R1', par.id);
    const a = f.state('a', r1.id);
    const r2 = f.state('R2', par.id);
    const x = f.state('x', r2.id);
    const y = f.state('y', r2.id);
    const z = f.state('z', r2.id);
    const into = f.transition(a.id, par.id, { ownerId: r1.id, trigger: 'go' });
    f.transition(x.id, y.id, { ownerId: r2.id, trigger: 'go' });
    f.transition(y.id, z.id, { ownerId: r2.id, trigger: 'go2' });
    // R1 meets the step first: the run stops before R2 is offered `go`, and no later event reaches any region
    const run = runStateMachine(m, par.id, ['go', 'go2']);
    expect(run.refused?.transitionId).toBe(into.id);
    expect(run.refusals).toHaveLength(1);
    expect(run.regionCount).toBe(1);
    expect(refusalStopsRun(m, par.id, run)).toBe(true);
    expect(run.complete).toBe(false);
    expect(run.fired).toEqual([]);
    expect(run.activeStates).toEqual([a.id, x.id]);
    // Simulate stops at the refusal: at rest, not run on to the sample cap (rollup 'Abstentions left', item 1)
    const s = new SimulationSession(m, par.id);
    const sample = s.inject('go');
    expect(sample.refused?.stopsRun).toBe(true);
    expect(sample.refused?.sentence).toContain('every region stops');
    expect(simulationAtRest(sample)).toBe(true);
    expect(simulationAtRest(s.inject('go2'))).toBe(true);
    expect(exploreMachine(m, par.id).exhaustive).toBe(false);
  });

  it('the one region that refuses stops the others too, whichever region it is', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const par = f.stateDef('Par');
    m.setAttrs(par.id, { parallel: true });
    const r1 = f.state('R1', par.id);
    const p1 = f.state('p1', r1.id);
    const q1 = f.state('q1', r1.id);
    const r2 = f.state('R2', par.id);
    const a = f.state('a', r2.id);
    f.state('b', r2.id);
    f.transition(p1.id, q1.id, { ownerId: r1.id, trigger: 'go' });
    f.transition(a.id, par.id, { ownerId: r2.id, trigger: 'go' });
    const run = runStateMachine(m, par.id, ['go', 'go']);
    expect(run.refused?.from).toBe(a.id);
    expect(run.fired).toHaveLength(1);
    expect(refusalStopsRun(m, par.id, run)).toBe(true);
    expect(simulationAtRest(new SimulationSession(m, par.id).inject('go'))).toBe(true);
  });
});

describe('the semantic profile', () => {
  it('says a parallel machine root is performed as a parallel state is', () => {
    const f = SEMANTIC_PROFILE.find((x) => x.field === 'regions')!;
    expect(f.reading).toContain('performed concurrently');
    expect(f.reading).toContain('machine root');
    expect(f.reading).not.toContain('CONCATENATES');
  });
});
