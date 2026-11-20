/**
 * State effects written in the text (SysML v2 §7.18.2-7.18.3): `entry|do|exit assign x := e;` and a transition's
 * `do assign x := e`. They read to the model the long form reads to, the interpreter applies them (exit, then the
 * transition's effect, then entry), the explorer agrees with the interpreter configuration by configuration, and an
 * effect this evaluator cannot apply refuses the run and the walk with a stated reason.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { serializeElement } from '@text/serializer';
import { runStateMachine } from '../../src/semantics/execute';
import { exploreMachine } from '../../src/semantics/mc/explore';
import { MAX_COMPLETION, activeLeavesOf, seedStore, type MachineConfig, type StepInput } from '../../src/semantics/mc/config';
import { advanceConfig, candidatesOf, openConfig } from '../../src/semantics/mc/parallel';

const find = (m: any, n: string): any => m.all().find((e: any) => m.qualifiedName(e.id) === n);
const load = async (src: string): Promise<any> => loadModelText(src, { fileName: 'se.sysml' });
const errors = (r: any): any[] => r.diagnostics.filter((d: any) => d.severity === 'error');

const MACHINE =
  'package P { attribute x : Integer = 0; item def E; item def F; state def M { entry; then s; ' +
  'state s { entry assign x := 1; exit assign x := x * 2; } ' +
  'state t { entry assign x := x * 3; do assign x := x + 1; } ' +
  'transition tr first s accept E do assign x := x + 5 then t; ' +
  'transition back first t accept F then s; } }';

/** The second driver (the explorer's own relation), first enabled choice, as the interpreter takes it. */
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

describe('reading', () => {
  it('`entry assign` and `exit assign` read as the long form reads, and a transition `do assign` as the effect text', async () => {
    const l = await load(MACHINE);
    expect(errors(l.report)).toEqual([]);
    const entry = l.model.children(find(l.model, 'P::M::s').id).find((e: any) => e.attrs.stateSubaction === 'entry');
    expect(entry.declaredName).toBeUndefined();
    const kids = l.model.children(entry.id);
    expect(kids.map((k: any) => [k.eClass, k.declaredName, k.attrs.value])).toEqual([['AssignmentActionUsage', 'x', 1]]);
    expect(find(l.model, 'P::M::tr').attrs.effect).toBe('x = x + 5');
  });
  it('round-trips to an equal model', async () => {
    const l = await load(MACHINE);
    const out = serializeElement(l.model, find(l.model, 'P').id);
    expect(out).toContain('entry assign x := 1;');
    expect(out).toContain('exit assign x := x * 2;');
    expect(out).toContain('do assign x := x + 5 then t;');
    const again = await load(out);
    expect(errors(again.report)).toEqual([]);
    expect(serializeElement(again.model, find(again.model, 'P').id)).toBe(out);
    const shape = (m: any): unknown[] => m.all().filter((e: any) => !e.attrs.isLibrary).map((e: any) => [m.qualifiedName(e.id), e.eClass, e.attrs]);
    expect(shape(again.model)).toEqual(shape(l.model));
  });
  it('`do action eff`, guards, delays and `state off; accept E then on;` still read', async () => {
    const src =
      'package P { attribute n : Integer = 0; item def E; state def M { entry; then s; state s; state t; ' +
      'transition a first s accept E if n < 0 do action eff then t; transition b first t accept after 5[min] then s; ' +
      'state off; accept E then on; state on; calc c { if n then 1 else 2 } } }';
    const l = await load(src);
    expect(errors(l.report)).toEqual([]);
    expect(find(l.model, 'P::M::a').attrs).toMatchObject({ trigger: 'E', guard: 'n < 0', effect: 'eff' });
    expect(find(l.model, 'P::M::b').attrs.timeTrigger).toBe('5[min]');
  });
  it('the target-transition shorthand takes `do assign` too', async () => {
    const src = 'package P { attribute n : Integer = 0; item def E; state def M { entry; then off; state off; accept E do assign n := 2 then on; state on; } }';
    const l = await load(src);
    expect(errors(l.report)).toEqual([]);
    expect(l.model.all().find((e: any) => e.eClass === 'TransitionUsage' && !e.attrs.isLibrary).attrs.effect).toBe('n = 2');
  });
  it('`send` stays refused', async () => {
    const l = await load('package P { state def M { entry send E to p; state s; } }');
    expect(l.report.diagnostics.map((d: any) => d.code)).toContain('mapper/state-form-unread');
  });
});

describe('the interpreter applies the effects, exit then transition effect then entry', () => {
  it('entry of the opening state', async () => {
    const l = await load(MACHINE);
    const r = runStateMachine(l.model, find(l.model, 'P::M').id, []);
    expect(r.unopened).toBeUndefined();
    expect(Object.fromEntries(r.valueStore).x).toBe(1);
  });
  it('a step: exit s (x*2), the effect (+5), entry t (x*3), do t (+1)', async () => {
    const l = await load(MACHINE);
    const r = runStateMachine(l.model, find(l.model, 'P::M').id, ['E']);
    expect(Object.fromEntries(r.valueStore).x).toBe(((1 * 2) + 5) * 3 + 1);
  });
  it('a nested parallel state applies each region\'s entry in order', async () => {
    const src =
      'package P { attribute n : Integer = 0; state def M { entry; then p; state p parallel { ' +
      'state r1 { entry assign n := n + 1; } state r2 { entry assign n := n * 10; } } } }';
    const l = await load(src);
    const r = runStateMachine(l.model, find(l.model, 'P::M').id, []);
    expect(r.unopened).toBeUndefined();
    expect(Object.fromEntries(r.valueStore).n).toBe(10);
  });
});

describe('the explorer agrees with the interpreter', () => {
  const machines: Record<string, string> = {
    'entry, exit, do and a transition effect': MACHINE,
    'a loop of two states': MACHINE.replace('transition back', 'transition back0 first t accept F then s; transition back'),
    'a nested parallel state with region entries': MACHINE.replace(
      'state t {',
      'state t { state u { entry assign x := x + 2; } ',
    ),
  };
  const events = ['E', 'F'];
  const seqs = (n: number): string[][] => {
    let layer: string[][] = [[]];
    let all: string[][] = [[]];
    for (let i = 0; i < n; i++) {
      layer = layer.flatMap((s) => events.map((e) => [...s, e]));
      all = all.concat(layer);
    }
    return all;
  };
  for (const [name, src] of Object.entries(machines)) {
    it(`${name}: the walk's store after every event sequence is the interpreter's`, async () => {
      const l = await load(src);
      expect(errors(l.report)).toEqual([]);
      const id = find(l.model, 'P::M').id;
      expect(exploreMachine(l.model, id).unsupported).toEqual([]);
      for (const seq of seqs(4)) {
        const run = runStateMachine(l.model, id, seq);
        expect(run.unopened, seq.join(',')).toBeUndefined();
        const got = drive(l.model, id, seq);
        expect(got.store, `${name} after ${seq.join(',')}`).toEqual(Object.fromEntries(run.valueStore));
        expect([...got.leaves].sort()).toEqual(run.activeStates.map((s: string) => l.model.qualifiedName(s)).sort());
      }
    });
  }
  it('parallel regions with entry assignments: the same stores', async () => {
    const src =
      'package P { item def f; state def M { attribute n : Integer = 0; attribute m : Integer = 0; entry; then p; state p parallel { ' +
      'state r1 { entry; then a1; state a1; state a2 { entry assign n := n + 1; } transition t first a1 accept f then a2; } ' +
      'state r2 { entry; then b1; state b1; state b2 { entry assign m := m + 2; } transition u first b1 accept f then b2; } } } }';
    const l = await load(src);
    const id = find(l.model, 'P::M').id;
    expect(exploreMachine(l.model, id).unsupported).toEqual([]);
    for (const seq of [[], ['f'], ['f', 'f']]) {
      const run = runStateMachine(l.model, id, seq);
      expect(drive(l.model, id, seq).store).toEqual(Object.fromEntries(run.valueStore));
    }
    expect(Object.fromEntries(runStateMachine(l.model, id, ['f']).valueStore)).toMatchObject({ n: 1, m: 2 });
  });
});

describe('an effect this evaluator cannot apply refuses the run and the walk', () => {
  const cases: Record<string, string> = {
    'an entry assignment': 'package P { attribute x : Integer = 0; state def M { entry; then s; state s { entry assign x := nothing + 1; } } }',
    'a transition effect': 'package P { attribute x : Integer = 0; item def E; state def M { entry; then s; state s; state t; transition tr first s accept E do assign x := nothing + 1 then t; } }',
  };
  for (const [name, src] of Object.entries(cases)) {
    it(`${name}: both refuse, naming it`, async () => {
      const l = await load(src);
      const id = find(l.model, 'P::M').id;
      const run = runStateMachine(l.model, id, ['E']);
      expect(run.unopened).toMatch(/cannot evaluate/);
      expect(run.activeStates).toEqual([]);
      const walk = exploreMachine(l.model, id);
      expect(walk.exhaustive).toBe(false);
      expect(walk.unsupported.map((u) => u.construct)).toEqual(['state-effect']);
      expect(walk.unsupported[0].detail).toMatch(/cannot evaluate/);
    });
  }
});

describe('a region assigning an attribute its scope does not hold', () => {
  it('is refused by the run and the walk alike, not shown with the effect dropped', async () => {
    const src =
      'package P { attribute n : Integer = 0; item def f; state def M { entry; then p; state p parallel { ' +
      'state r1 { entry; then a1; state a1; state a2 { entry assign n := n + 1; } transition t first a1 accept f then a2; } state r2; } } }';
    const l = await load(src);
    const id = find(l.model, 'P::M').id;
    const run = runStateMachine(l.model, id, ['f']);
    expect(run.unopened).toMatch(/cannot evaluate/);
    expect(exploreMachine(l.model, id).unsupported.map((u) => u.construct)).toEqual(['state-effect']);
  });
});

describe('coupled regions, written in the text', () => {
  const r1 = 'state r1 { entry; then a1; state a1; state a2 { entry assign n := 1; } transition t first a1 accept f then a2; }';
  const r2 = 'state r2 { entry; then b1; state b1; state b2; transition u first b1 accept f if n == 1 then b2; }';
  const mk = (body: string): string =>
    `package P { item def f; state def M { attribute n : Integer = 0; entry; then p; state p parallel { ${body} } } }`;
  it('the explorer refuses the coupling', async () => {
    const l = await load(mk(r1 + r2));
    const walk = exploreMachine(l.model, find(l.model, 'P::M').id);
    expect(walk.exhaustive).toBe(false);
    expect(walk.unsupported[0].construct).toBe('parallel-regions');
    expect(walk.unsupported[0].detail).toMatch(/coupled through `n`/);
  });
  it('the interpreter runs the regions in declaration order, each seeing what the one before wrote', async () => {
    const a = await load(mk(r1 + r2));
    const x = runStateMachine(a.model, find(a.model, 'P::M').id, ['f']);
    expect(x.unopened).toBeUndefined();
    expect(x.activeStates.map((s: string) => a.model.qualifiedName(s).replace('P::M::', ''))).toEqual(['p::r1::a2', 'p::r2::b2']);
    expect(Object.fromEntries(x.valueStore).n).toBe(1);
    const b = await load(mk(r2 + r1));
    const y = runStateMachine(b.model, find(b.model, 'P::M').id, ['f']);
    expect(y.activeStates.map((s: string) => b.model.qualifiedName(s).replace('P::M::', ''))).toEqual(['p::r2::b1', 'p::r1::a2']);
    expect(Object.fromEntries(y.valueStore).n).toBe(1);
  });
});
