/**
 * SysML v2 §7.18.2 / §8.4.14: a parallel state (or a parallel machine root) is COMPLETE when every one of its
 * regions stands at a final state, and a trigger-less transition out of it is taken then — after every region is
 * exited, with its guard read at that moment. The interpreter and the explorer perform exactly this, together.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '../../src/semantics/execute';
import { exploreMachine } from '../../src/semantics/mc/explore';
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
  const l: any = await loadModelText(src, { fileName: 'pc.sysml' });
  for (const [q, eff] of Object.entries(effects)) find(l.model, q).attrs.effect = eff;
  return l.model;
}

const reg = (n: string, a: string, ev: string, extra = '') =>
  `state ${n} { entry; then ${a}; state ${a}; state final; transition t_${n} first ${a} accept ${ev} then final; ${extra} }`;
const nested = (tail: string, body = reg('r1', 'a1', 'f') + reg('r2', 'b1', 'g')) =>
  `package P { item def e; item def f; item def g; attribute n : Integer = 0; state def M { entry; then p; ` +
  `state p parallel { ${body} } state q; state z; ${tail} } }`;
const root = (tail: string) =>
  `package P { item def f; item def g; attribute n : Integer = 0; state def M parallel { ${reg('r1', 'a1', 'f')} ${reg('r2', 'b1', 'g')} state fin2; ${tail} } }`;

const MACHINES: Record<string, { src: string; effects?: Record<string, string> }> = {
  'nested: completion to q': { src: nested('transition done first p then q;') },
  'nested: guarded completion that holds': { src: nested('transition done first p if n == 0 then q;') },
  'nested: guarded completion that fails': { src: nested('transition done first p if n == 1 then q;') },
  'nested: completion with an effect, then q to z': {
    src: nested('transition done first p then q; transition on first q accept e then z;'),
    effects: { 'P::M::done': 'n = 5' },
  },
  'nested: no completion transition': { src: nested('transition go first p accept e then q;') },
  'nested: completion and a leaving trigger': { src: nested('transition done first p then q; transition go first p accept e then z;') },
  'nested: a region with a trigger-less path to its final': {
    src: nested(
      'transition done first p then q;',
      'state r1 { entry; then a1; state a1; state a2; state final; transition t first a1 accept f then a2; transition c first a2 then final; }' +
        reg('r2', 'b1', 'g'),
    ),
  },
  'root: join to fin2': { src: root('transition j first M then fin2;') },
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

describe('a parallel state completes when every region is final', () => {
  for (const [name, { src, effects }] of Object.entries(MACHINES)) {
    it(`${name}: the explorer and the interpreter agree on every event sequence up to 4`, async () => {
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
  }

  it('nested: the completion waits for the last region, then leaves with every region exited', async () => {
    const model = await load(nested('transition done first p then q;'));
    const id = find(model, 'P::M').id;
    const name = (x: string[]): string[] => x.map((s) => model.qualifiedName(s));
    expect(name(runStateMachine(model, id, ['f']).activeStates)).toEqual(['P::M::p::r1::final', 'P::M::p::r2::b1']);
    expect(name(runStateMachine(model, id, ['f', 'g']).activeStates)).toEqual(['P::M::q']);
    expect(name(runStateMachine(model, id, ['g', 'f']).activeStates)).toEqual(['P::M::q']);
    expect(name(runStateMachine(model, id, []).activeStates)).toEqual(['P::M::p::r1::a1', 'P::M::p::r2::b1']);
  });

  it('nested: a guard that fails when the state completes keeps it there; one that holds takes it', async () => {
    const stays = await load(nested('transition done first p if n == 1 then q;'));
    const r = runStateMachine(stays, find(stays, 'P::M').id, ['f', 'g']);
    expect(r.activeStates.map((s: string) => stays.qualifiedName(s))).toEqual(['P::M::p::r1::final', 'P::M::p::r2::final']);
    const goes = await load(nested('transition done first p if n == 0 then q;'));
    const r2 = runStateMachine(goes, find(goes, 'P::M').id, ['f', 'g']);
    expect(r2.activeStates.map((s: string) => goes.qualifiedName(s))).toEqual(['P::M::q']);
  });

  it('nested: the walk reaches q, passing through the last region final step', async () => {
    const model = await load(nested('transition done first p then q;'));
    const walk = exploreMachine(model, find(model, 'P::M').id);
    expect(walk.exhaustive).toBe(true);
    const sets = walk.configRegionLeaves.map((ls) => ls.map((s) => model.qualifiedName(s)).sort().join('|'));
    expect(sets).toContain('P::M::q');
    expect(sets).toContain('P::M::p::r1::final|P::M::p::r2::b1');
  });

  it('root: the join fires once both regions are final, not before', async () => {
    const model = await load(root('transition j first M then fin2;'));
    const id = find(model, 'P::M').id;
    const names = (x: string[]): string[] => x.map((s) => model.qualifiedName(s));
    expect(names(runStateMachine(model, id, ['f']).activeStates)).toEqual(['P::M::r1::final', 'P::M::r2::b1']);
    const done = runStateMachine(model, id, ['f', 'g']);
    expect(done.unopened).toBeUndefined();
    expect(names(done.activeStates)).toEqual(['P::M::fin2']);
  });

  it('shapes that stay refused: a parallel state without regions with a completion transition', async () => {
    const model = await load(nested('transition done first p then q;', ''));
    const r = runStateMachine(model, find(model, 'P::M').id, []);
    expect(r.unopened).toMatch(/no region/);
    expect(exploreMachine(model, find(model, 'P::M').id).unsupported.map((u) => u.construct)).toEqual(['parallel-regions']);
  });

  it('shapes that stay refused: a completion transition from a nested state into one of its own regions', async () => {
    const model = await load(nested('transition done first p then p::r1::a1;'));
    const r = runStateMachine(model, find(model, 'P::M').id, []);
    expect(r.unopened).toMatch(/steps into one of its own regions/);
  });
});
