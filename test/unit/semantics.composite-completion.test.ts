/**
 * SysML v2 Part 1 §9.2.11.2.1: a transition with no accepter follows the COMPLETION of its source's performance,
 * after its middle (do action AND substates). A trigger-less transition out of a COMPOSITE state is therefore
 * enabled only when the active leaf under it is a final state; a simple state completes after its entry/do.
 * The interpreter and the explorer share this rule (`stateCompleted`, `mc/config.ts`).
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '../../src/semantics/execute';
import { reachReport } from '../../src/semantics/mc/explore';
import { MAX_COMPLETION, activeLeavesOf, seedStore, type MachineConfig, type StepInput } from '../../src/semantics/mc/config';
import { advanceConfig, candidatesOf, openConfig } from '../../src/semantics/mc/parallel';

const find = (m: any, n: string): any => m.all().find((e: any) => m.qualifiedName(e.id) === n);
async function load(src: string): Promise<any> {
  return ((await loadModelText(src, { fileName: 'cc.sysml' })) as any).model;
}

const PROBE =
  'package P { item def e; state def M { entry; then c; state c { entry; then x; state x; state y; ' +
  'transition first x accept e then y; } state z; transition cz first c then z; } }';
const DONE =
  'package P { item def e; state def M { entry; then c; state c { entry; then x; state x; ' +
  'transition first x accept e then done; } state z; transition cz first c then z; } }';
const NESTED =
  'package P { item def e; state def M { entry; then c; state c { entry; then d; state d { entry; then x; state x; ' +
  'transition first x accept e then done; } state w; transition dw first d then w; } ' +
  'state z; transition cz first c then z; } }';
const SIMPLE = 'package P { item def e; state def M { entry; then a; state a; state b; transition ab first a then b; } }';

const names = (m: any, ids: string[]): string[] => ids.map((s) => m.qualifiedName(s)).sort();

describe('completion out of a composite waits for its final substate', () => {
  it('the probe: no immediate exit, c::y reachable, z not', async () => {
    const m = await load(PROBE);
    const id = find(m, 'P::M').id;
    expect(names(m, runStateMachine(m, id, []).activeStates)).toEqual(['P::M::c::x']);
    expect(names(m, runStateMachine(m, id, ['e']).activeStates)).toEqual(['P::M::c::y']);
    const row: any = reachReport(m).machines.find((x: any) => x.machine.qualifiedName === 'P::M');
    expect(row.exhaustive).toBe(true);
    expect(row.states.unreachable.map((x: any) => x.qualifiedName)).toContain('P::M::z');
    expect(row.states.reachable.map((x: any) => x.qualifiedName)).toContain('P::M::c::y');
  });
  it('a final substate lets the composite complete', async () => {
    const m = await load(DONE);
    const id = find(m, 'P::M').id;
    expect(names(m, runStateMachine(m, id, []).activeStates)).toEqual(['P::M::c::x']);
    expect(names(m, runStateMachine(m, id, ['e']).activeStates)).toEqual(['P::M::z']);
  });
  it('nested composites: the inner completion waits, the outer waits for done', async () => {
    const m = await load(NESTED);
    const id = find(m, 'P::M').id;
    expect(names(m, runStateMachine(m, id, []).activeStates)).toEqual(['P::M::c::d::x']);
    expect(names(m, runStateMachine(m, id, ['e']).activeStates)).toEqual(['P::M::c::w']);
  });
  it('a simple state still completes after its entry', async () => {
    const m = await load(SIMPLE);
    const id = find(m, 'P::M').id;
    expect(names(m, runStateMachine(m, id, []).activeStates)).toEqual(['P::M::b']);
  });
});

const EVENTS = ['e'];
const sequences = (len: number): string[][] => {
  let out: string[][] = [[]];
  let layer: string[][] = [[]];
  for (let i = 0; i < len; i++) {
    layer = layer.flatMap((s) => EVENTS.map((x) => [...s, x]));
    out = out.concat(layer);
  }
  return out;
};
function drive(model: any, machineId: string, events: string[]): string[] {
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
  return activeLeavesOf(cfg).map((s) => model.qualifiedName(s)).sort();
}

describe('walk and interpreter agree on composite completion', () => {
  for (const [name, src] of Object.entries({ PROBE, DONE, NESTED, SIMPLE })) {
    it(`${name}: every event sequence up to 4`, async () => {
      const m = await load(src);
      const id = find(m, 'P::M').id;
      for (const seq of sequences(4)) {
        const run = runStateMachine(m, id, seq);
        expect(drive(m, id, seq), `${name} after ${seq.join(',')}`).toEqual(names(m, run.activeStates));
      }
    });
  }
});
