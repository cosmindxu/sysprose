/**
 * A bare `entry X;` / `do X;` / `exit X;` that names an existing action is a reference (SysML v2 §7.18.2): entering or
 * leaving the state performs X, so X's own assignments apply as if written in place — in the interpreter and the walk
 * alike. An X this evaluator cannot read refuses the run and the walk with a stated reason. The start of a state with a
 * reference entry is the succession written after it (`entry X; then s;`, `first X then s;`); a `transition` from X's
 * name is refused, never guessed.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '../../src/semantics/execute';
import { exploreMachine } from '../../src/semantics/mc/explore';
import { MAX_COMPLETION, activeLeavesOf, seedStore, type MachineConfig, type StepInput } from '../../src/semantics/mc/config';
import { advanceConfig, candidatesOf, openConfig } from '../../src/semantics/mc/parallel';

const find = (m: any, n: string): any => m.all().find((e: any) => m.qualifiedName(e.id) === n);
const load = async (src: string): Promise<any> => loadModelText(src, { fileName: 'ere.sysml' });
const errors = (r: any): any[] => r.diagnostics.filter((d: any) => d.severity === 'error');

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

const PRE =
  'attribute x : Integer = 0; item def E; item def F; action bump { assign x := x + 1; } action dbl { assign x := x * 2; } ' +
  'action def Warm { assign x := x + 10; } ';
describe('the referenced action\'s assignments apply on entry, do and exit', () => {
  const src = `package P { ${PRE} state def M { entry; then s; state s { entry bump; exit dbl; } state t { entry dbl; do bump; exit bump; } ` +
    'transition tr first s accept E then t; transition back first t accept F then s; } }';
  it('interpreter: entry s (+1), exit s (*2), entry t (*2), do t (+1)', async () => {
    const l = await load(src);
    expect(errors(l.report)).toEqual([]);
    const id = find(l.model, 'P::M').id;
    expect(find(l.model, 'P::M::s').id).toBeDefined();
    expect(Object.fromEntries(runStateMachine(l.model, id, []).valueStore).x).toBe(1);
    expect(Object.fromEntries(runStateMachine(l.model, id, ['E']).valueStore).x).toBe(((1 * 2) * 2) + 1);
    expect(Object.fromEntries(runStateMachine(l.model, id, ['E', 'F']).valueStore).x).toBe(((1 * 2) * 2 + 1 + 1) + 1);
  });
  it('the walk equals the interpreter over every event sequence up to 4', async () => {
    const l = await load(src);
    const id = find(l.model, 'P::M').id;
    expect(exploreMachine(l.model, id).unsupported).toEqual([]);
    let layer: string[][] = [[]];
    const all: string[][] = [[]];
    for (let i = 0; i < 4; i++) {
      layer = layer.flatMap((s) => ['E', 'F'].map((e) => [...s, e]));
      all.push(...layer);
    }
    for (const seq of all) {
      const run = runStateMachine(l.model, id, seq);
      expect(run.unopened, seq.join(',')).toBeUndefined();
      const got = drive(l.model, id, seq);
      expect(got.store, seq.join(',')).toEqual(Object.fromEntries(run.valueStore));
      expect([...got.leaves].sort()).toEqual(run.activeStates.map((s: string) => l.model.qualifiedName(s)).sort());
    }
  });
  it('an action definition is a referent too', async () => {
    const l = await load(`package P { ${PRE} state def M { entry; then s; state s { entry Warm; } } }`);
    expect(Object.fromEntries(runStateMachine(l.model, find(l.model, 'P::M').id, []).valueStore).x).toBe(10);
  });
});

describe('an action this evaluator cannot read refuses the run and the walk', () => {
  const cases: Record<string, string> = {
    'a parameter': 'action a { in n : Integer; assign x := n; }',
    'a nested action': 'action a { action inner; assign x := 1; }',
    'an if': 'action a { if x == 0 { assign x := 1; } }',
    'a specialization': 'action base { assign x := 1; } action a :> base;',
    'a typed body': 'action def W { assign x := 1; } action a : W;',
    'a value it cannot evaluate': 'action a { assign x := nothing + 1; }',
  };
  for (const [name, decl] of Object.entries(cases)) {
    it(`${name}`, async () => {
      const l = await load(
        `package P { attribute x : Integer = 0; item def E; ${decl} state def M { entry; then s; state s; state t { entry a; } transition tr first s accept E then t; } }`,
      );
      expect(errors(l.report)).toEqual([]);
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

describe('the start of a state with a reference entry', () => {
  const m = (body: string): string => `package P { ${PRE} action init { assign x := 7; } state def M { ${body} state t; transition tr first s accept E then t; state s; } }`;
  it('`entry init; then s;` starts at s with init applied, run and walk', async () => {
    const l = await load(m('entry init; then s;'));
    const id = find(l.model, 'P::M').id;
    const run = runStateMachine(l.model, id, []);
    expect(run.unopened).toBeUndefined();
    expect(run.activeStates.map((s: string) => l.model.qualifiedName(s))).toEqual(['P::M::s']);
    expect(exploreMachine(l.model, id).unsupported).toEqual([]);
    expect(drive(l.model, id, []).leaves).toEqual(['P::M::s']);
  });
  it('`entry init; first init then s;` is the same start, even when s is declared last', async () => {
    const l = await load(m('entry init; first init then s;'));
    const id = find(l.model, 'P::M').id;
    const run = runStateMachine(l.model, id, []);
    expect(run.unopened).toBeUndefined();
    expect(run.activeStates.map((s: string) => l.model.qualifiedName(s))).toEqual(['P::M::s']);
    expect(exploreMachine(l.model, id).unsupported).toEqual([]);
    expect(drive(l.model, id, []).leaves).toEqual(['P::M::s']);
  });
  it('`transition first init then s` from the referenced action\'s name is refused, run and walk, saying why', async () => {
    const l = await load(m('entry init; transition first init then s;'));
    const id = find(l.model, 'P::M').id;
    const run = runStateMachine(l.model, id, []);
    expect(run.unopened).toMatch(/reference to an existing action/);
    expect(run.activeStates).toEqual([]);
    const walk = exploreMachine(l.model, id);
    expect(walk.exhaustive).toBe(false);
    expect(walk.unsupported[0].detail).toMatch(/reference to an existing action/);
  });
});
