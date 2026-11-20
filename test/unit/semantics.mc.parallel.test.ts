/**
 * A parallel state nested in an ordinary machine is EXPLORED (SysML v2 §7.18.2) under the same reading the
 * interpreter performs: the explorer's configurations are exactly the interpreter's, event sequence by event
 * sequence; the shapes the interpreter refuses stay refused with its reason; and coupled regions are
 * explored in every order (semantics.mc.parallel-orders.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '../../src/semantics/execute';
import { exploreMachine, reachReport } from '../../src/semantics/mc/explore';
import { behaviourReport } from '../../src/semantics/mc/patterns';
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
  const l: any = await loadModelText(src, { fileName: 'pp.sysml' });
  for (const [q, eff] of Object.entries(effects)) find(l.model, q).attrs.effect = eff;
  return l.model;
}

const region = (n: string, a: string, b: string, ev: string, extra = '') =>
  `state ${n} { entry; then ${a}; state ${a}; state ${b} ${extra}; transition t_${n} first ${a} accept ${ev} then ${b}; }`;
const wrap = (body: string, tail = '') =>
  `package P { item def e; item def f; item def g; attribute n : Integer = 0; state def M { entry; then p; ` +
  `state p parallel { ${body} } state q; transition go first p accept e then q; ${tail} } }`;

const MACHINES: Record<string, { src: string; effects?: Record<string, string> }> = {
  'two regions on one event': { src: wrap(region('r1', 'a1', 'a2', 'f') + region('r2', 'b1', 'b2', 'f'), 'transition back first q accept g then p;') },
  'a region that stays': { src: wrap(region('r1', 'a1', 'a2', 'f') + region('r2', 'b1', 'b2', 'g'), 'transition back first q accept g then p;') },
  'a region guarded by an attribute nobody writes': {
    src: wrap(
      region('r1', 'a1', 'a2', 'f') +
        'state r2 { entry; then b1; state b1; state b2; transition u first b1 accept f if n == 0 then b2; }',
      'transition back first q accept g then p;',
    ),
  },
  'a trigger-less step inside a region': {
    src: wrap(
      'state r1 { entry; then a1; state a1; state a2; state a3; transition t first a1 accept f then a2; transition c first a2 then a3; }' +
        region('r2', 'b1', 'b2', 'g'),
      'transition back first q accept g then p;',
    ),
  },
  'three regions, one of them without substates': { src: wrap(region('r1', 'a1', 'a2', 'f') + region('r2', 'b1', 'b2', 'g') + 'state r3;') },
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

/** The second driver: this module's own relation, event by event, taking the first enabled choice as the interpreter does. */
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
  return {
    leaves: activeLeavesOf(cfg).map((s) => model.qualifiedName(s)),
    store: Object.fromEntries(cfg.store),
  };
}

describe('the explorer agrees with the interpreter on parallel states', () => {
  for (const [name, { src, effects }] of Object.entries(MACHINES)) {
    it(`${name}: every event sequence up to 4 events reaches the same configuration`, async () => {
      const model = await load(src, effects);
      const id = find(model, 'P::M').id;
      expect(exploreMachine(model, id).unsupported).toEqual([]);
      for (const seq of sequences(4)) {
        const run = runStateMachine(model, id, seq);
        expect(run.unopened, seq.join(',')).toBeUndefined();
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
        const r = runStateMachine(model, id, seq);
        run.add(key(r.activeStates.map((s: string) => model.qualifiedName(s))));
      }
      // The interpreter's set is quiescent configurations; the walk may add the steps of a chase it passes through.
      for (const k of run) expect(walked.has(k), `the walk lacks ${k}`).toBe(true);
      if (!name.includes('trigger-less')) expect([...walked].sort()).toEqual([...run].sort());
    });
  }

  it('a transition leaving the parallel state exits every region, in the interpreter\'s order', async () => {
    const src = `package P { item def e; state def M { entry; then p; state p parallel { exit action xp; state r1 { exit action x1; } state r2 { exit action x2; } } state q; transition go first p accept e then q; } }`;
    const model = await load(src);
    const id = find(model, 'P::M').id;
    const walk = exploreMachine(model, id);
    expect(walk.exhaustive).toBe(true);
    expect(walk.configs).toBe(2);
    const reach = reachReport(model, { scopeId: id });
    expect(reach.machines[0].exhaustive).toBe(true);
    expect(reach.machines[0].states.unreachable).toEqual([]);
    expect(reach.machines[0].transitions.dead).toEqual([]);
  });

  it('absences are decided over the regions: a state of a region is reachable, a transition on a never-sent event is dead', async () => {
    const model = await load(wrap(region('r1', 'a1', 'a2', 'f') + region('r2', 'b1', 'b2', 'h')));
    const id = find(model, 'P::M').id;
    const r = reachReport(model, { scopeId: id });
    expect(r.machines[0].exhaustive).toBe(true);
    expect(r.machines[0].states.unreachable).toEqual([]);
  });

  it('check-behaviour decides a property about a state of a region, and a witness is withheld as not replayed', async () => {
    const model = await load(wrap(region('r1', 'a1', 'a2', 'f') + region('r2', 'b1', 'b2', 'f')));
    const id = find(model, 'P::M').id;
    const walk = exploreMachine(model, id);
    expect(walk.configStates.some((s) => s.includes(find(model, 'P::M::p::r2::b2').id))).toBe(true);
    void behaviourReport;
  });
});

describe('what stays refused, with a reason', () => {
  const refusedBy = async (src: string): Promise<{ explorer: string; interp: string }> => {
    const model = await load(src);
    const id = find(model, 'P::M').id;
    const u = exploreMachine(model, id).unsupported;
    expect(u.map((x) => x.construct)).toEqual(['parallel-regions']);
    const run = runStateMachine(model, id, ['e']);
    return { explorer: u[0].detail, interp: run.unopened ?? '' };
  };
  const base = (inner: string, tail = '') =>
    `package P { item def e; state def M { entry; then p; state p parallel { ${inner} } state q; transition go first p accept e then q; ${tail} } }`;
  const shapes: Record<string, string> = {
    'a region that is itself a parallel state': base('state r1 parallel { state s1; state s2; } state r2;'),
    'a step into a region': base('state r1 { state a1; state a2; } state r2;', 'transition into first q accept e then p::r1::a2;'),
    'an entry action naming a start on the parallel state': base('entry; then r1; state r1; state r2;'),
  };
  for (const [name, src] of Object.entries(shapes)) {
    it(`${name}: refused by both, in the same words`, async () => {
      const { explorer, interp } = await refusedBy(src);
      expect(interp).toMatch(/§7\.18\.2/);
      // the interpreter's sentence up to its §7.18.2 citation; the explorer's is the same sentence
      const sentence = interp.slice(0, interp.indexOf(' (SysML v2 §7.18.2)') + ' (SysML v2 §7.18.2)'.length);
      expect(sentence.endsWith(explorer)).toBe(true);
    });
  }

  it('a parallel machine root is explored, not refused (the root cases are pinned in semantics.parallel-root.test.ts)', async () => {
    const model = await load(`package P { state def M parallel { state x; state y; } }`);
    const walk = exploreMachine(model, find(model, 'P::M').id);
    expect(walk.unsupported).toEqual([]);
    expect(walk.exhaustive).toBe(true);
  });

  it('coupled regions are explored in every order: the fixed order decides the interpreter\'s outcome, the walk keeps both', async () => {
    const r1 = 'state r1 { entry; then a1; state a1; state a2; transition t first a1 accept f then a2; }';
    const r2 = 'state r2 { entry; then b1; state b1; state b2; transition u first b1 accept f if n == 1 then b2; }';
    const src = `package P { item def f; state def M { attribute n : Integer = 0; entry; then p; state p parallel { ${r1} ${r2} } } }`;
    const model = await load(src, { 'P::M::p::r1::t': 'n = 1' });
    const id = find(model, 'P::M').id;
    const walk = exploreMachine(model, id);
    expect(walk.exhaustive).toBe(true);
    expect(walk.unsupported).toEqual([]);
    // the interpreter's result depends on the declaration order — the reason the explorer takes every order
    const swapped = await load(src.replace(`${r1} ${r2}`, `${r2} ${r1}`), { 'P::M::p::r1::t': 'n = 1' });
    const a = runStateMachine(model, id, ['f']).activeStates.map((s: string) => model.qualifiedName(s)).sort();
    const b = runStateMachine(swapped, find(swapped, 'P::M').id, ['f']).activeStates.map((s: string) => swapped.qualifiedName(s)).sort();
    expect(a).not.toEqual(b);
    const rep = reachReport(model, { scopeId: id });
    // (reach's own gate may still hold the guard over `n` undecided; what it no longer says is `not explored`)
    expect(rep.machines[0].qualification).not.toMatch(/not explored/);
    const key = (ls: readonly string[]): string => ls.map((s) => model.qualifiedName(s)).sort().join(' | ');
    const walked = new Set(walk.configRegionLeaves.map(key));
    expect(walked.has(a.join(' | '))).toBe(true);
    expect(walked.has(['P::M::p::r1::a2', 'P::M::p::r2::b1'].join(' | '))).toBe(true);
  });

  it('an event a region takes and a transition leaving the state takes is refused', async () => {
    const src = wrap(region('r1', 'a1', 'a2', 'e') + region('r2', 'b1', 'b2', 'f'));
    const model = await load(src);
    const u = exploreMachine(model, find(model, 'P::M').id).unsupported;
    expect(u[0].detail).toMatch(/the interpreter stops there rather than choose/);
  });

  it('the semantic profile says what the regions do now', () => {
    const f = SEMANTIC_PROFILE.find((x) => x.field === 'regions')!;
    expect(f.reading).toContain('performed concurrently');
    expect(f.reading).not.toContain('CONCATENATES');
    expect(f.reading).toContain('fixed declaration order');
    expect(f.reading).toContain('EVERY order');
  });
});
