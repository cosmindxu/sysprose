/**
 * SysML v2 §7.18.2: a REGION that is itself a parallel state (`state p parallel { state r parallel { state x … state y … } state q … }`)
 * is performed: its own substates are regions of it, entered at once, offered events depth first in declaration order, final when
 * they all are, exited inner first. The interpreter and the explorer are compared over every event sequence up to 4.
 * History inside a parallel state stays refused in both: the explorer refuses history everywhere (`history-state`).
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '../../src/semantics/execute';
import { exploreMachine } from '../../src/semantics/mc/explore';
import { MAX_COMPLETION, activeLeavesOf, activeStatesOf, seedStore, type MachineConfig, type StepInput } from '../../src/semantics/mc/config';
import { advanceConfig, candidatesOf, openConfig, parallelRefusal } from '../../src/semantics/mc/parallel';

const find = (m: any, n: string): any => m.all().find((e: any) => m.qualifiedName(e.id) === n);
async function load(src: string, effects: Record<string, string> = {}): Promise<any> {
  const l: any = await loadModelText(src, { fileName: 'pd.sysml' });
  for (const [q, eff] of Object.entries(effects)) find(l.model, q).attrs.effect = eff;
  return l.model;
}
const d = (k: number): string => `assign n := n * 10 + ${k}`;
const pre = `package P { item def e; item def f; item def g; item def h; attribute n : Integer = 0; `;

// Region r1 ends in the parallel state `pp` (regions x, y); r2 is a plain region. Digits record entry/exit order.
const INNER =
  `state pp parallel { entry ${d(1)}; exit ${d(2)}; ` +
  `state x { entry ${d(3)}; exit ${d(4)}; state x1; state x2; state final; transition tx first x1 accept g then x2; transition tf first x2 accept g then final; } ` +
  `state y { entry ${d(5)}; exit ${d(6)}; state y1; state y2; state final; transition ty first y1 accept f then y2; transition tg first y2 accept g then final; } }`;
const outer = (r1: string, tail = '', ppFirst = false): string =>
  pre +
  `state def M { entry; then p; state p parallel { ` +
  `state r1 { entry ${d(7)}; exit ${d(8)}; ${ppFirst ? r1 : `state a1; ${r1}`} } ` +
  `state r2 { entry ${d(9)}; state b1; state b2; transition tb first b1 accept f then b2; } ` +
  `} state q; state z; transition go first p accept e then q; ${tail} } }`;

const MACHINES: Record<string, string> = {
  'a region that is a parallel state, beside a plain region':
    pre + `state def M { entry; then p; state p parallel { state r parallel { entry ${d(1)}; exit ${d(2)}; ` +
    `state x { entry ${d(3)}; exit ${d(4)}; state x1; state x2; transition tx first x1 accept f then x2; } ` +
    `state y { entry ${d(5)}; exit ${d(6)}; state y1; state y2; transition ty first y1 accept g then y2; } } ` +
    `state q { entry ${d(7)}; state q1; state q2; transition tq first q1 accept f then q2; } } state z; transition go first p accept e then z; } }`,
  'the same event taken by the region and by the plain region':
    pre + `state def M { entry; then p; state p parallel { state r parallel { ` +
    `state x { state x1; state x2; transition tx first x1 accept f then x2; } state y { state y1; state y2; transition ty first y1 accept f then y2; } } ` +
    `state q { state q1; state q2; transition tq first q1 accept f then q2; } } state z; transition go first p accept e then z; } }`,
  'completion: every region of the parallel region final, then the outer completes':
    pre + `state def M { entry; then p; state p parallel { state r parallel { ` +
    `state x { state x1; state final; transition tx first x1 accept f then final; } state y { state y1; state final; transition ty first y1 accept g then final; } } ` +
    `state q { state q1; state final; transition tq first q1 accept h then final; } } state z; transition cp first p then z; } }`,
  'two parallel regions in a parallel region':
    pre + `state def M { entry; then p; state p parallel { state r parallel { state x { state x1; state x2; transition tx first x1 accept f then x2; } ` +
    `state s parallel { state u { state u1; state u2; transition tu first u1 accept f then u2; } state v { state v1; state v2; transition tv first v1 accept g then v2; } } } ` +
    `state q { state q1; state q2; transition tq first q1 accept h then q2; } } state z; transition go first p accept e then z; } }`,
  'a parallel machine root with a parallel region':
    pre + `state def M parallel { state r parallel { state x { state x1; state x2; transition tx first x1 accept f then x2; } ` +
    `state y { state y1; state y2; transition ty first y1 accept g then y2; } } state q { state q1; state q2; transition tq first q1 accept h then q2; } }}`,
  'a parallel region whose substates are coupled through the store':
    pre + `state def M { entry; then p; state p parallel { state r parallel { state x { state x1; state x2; transition tx first x1 accept f then x2 { effect assign n := 5; } } ` +
    `state y { state y1; state y2; transition ty first y1 accept f if n == 5 then y2; } } state q { state q1; } } state z; transition go first p accept e then z; } }`,
};

const EVENTS = ['e', 'f', 'g', 'h'];
const sequences = (len: number): string[][] => {
  let out: string[][] = [[]];
  let layer: string[][] = [[]];
  for (let i = 0; i < len; i++) {
    layer = layer.flatMap((s) => EVENTS.map((x) => [...s, x]));
    out = out.concat(layer);
  }
  return out;
};

function drive(model: any, machineId: string, events: string[]): { leaves: string[]; states: string[]; store: Record<string, unknown> } {
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
  const q = (s: string): string => model.qualifiedName(s);
  return { leaves: activeLeavesOf(cfg).map(q), states: activeStatesOf(cfg).map(q), store: Object.fromEntries(cfg.store) };
}

describe('a region that is a parallel state: the explorer and the interpreter agree', () => {
  for (const [name, src] of Object.entries(MACHINES)) {
    it(`${name}: every event sequence up to 4`, async () => {
      const model = await load(src);
      const id = find(model, 'P::M').id;
      expect(parallelRefusal(model, id)).toBeUndefined();
      expect(exploreMachine(model, id).unsupported).toEqual([]);
      for (const seq of sequences(4)) {
        const run = runStateMachine(model, id, seq);
        if (run.unopened !== undefined || run.refused !== undefined) continue;
        const want = run.activeStates.map((s: string) => model.qualifiedName(s)).sort();
        const got = drive(model, id, seq);
        expect([...got.leaves].sort(), `${name} after ${seq.join(',')}`).toEqual(want);
        expect(got.store, `${name} store after ${seq.join(',')}`).toEqual(Object.fromEntries(run.valueStore));
      }
    });
  }

  it('enters the nested regions at once, in order, and exits them inner first', async () => {
    const model = await load(MACHINES['a region that is a parallel state, beside a plain region']);
    const id = find(model, 'P::M').id;
    const names = (x: string[]): string[] => x.map((s) => model.qualifiedName(s));
    const r0 = runStateMachine(model, id, []);
    expect(names(r0.activeStates)).toEqual(['P::M::p::r::x::x1', 'P::M::p::r::y::y1', 'P::M::p::q::q1']);
    expect(Object.fromEntries(r0.valueStore).n).toBe(1357); // r 1, x 3, y 5, q 7
    const r1 = runStateMachine(model, id, ['f', 'g']);
    expect(names(r1.activeStates)).toEqual(['P::M::p::r::x::x2', 'P::M::p::r::y::y2', 'P::M::p::q::q2']);
    const left = String(Object.fromEntries(runStateMachine(model, id, ['e']).valueStore).n);
    expect(left.slice(4)).toBe('4' + '6' + '2'); // x, y, then r
  });

  it('the outer state completes only once every region, the parallel one included, is final', async () => {
    const model = await load(MACHINES['completion: every region of the parallel region final, then the outer completes']);
    const id = find(model, 'P::M').id;
    const at = (seq: string[]): string[] => runStateMachine(model, id, seq).activeStates.map((s: string) => model.qualifiedName(s));
    expect(at(['f', 'g'])).not.toContain('P::M::z');
    expect(at(['f', 'g', 'h'])).toEqual(['P::M::z']);
    expect(at(['h', 'f'])).not.toContain('P::M::z');
  });

  it('history inside a parallel state stays refused, by both, with the history reason', async () => {
    const model = await load(
      pre + `state def M { entry; then p; state p parallel { state r1 { state a { state a1; state a2; } } state r2 { state b1; } } state z; transition go first p accept e then z; } }`,
    );
    const id = find(model, 'P::M').id;
    find(model, 'P::M::p::r1::a').attrs.history = true;
    expect(parallelRefusal(model, id)?.reason).toContain('history');
    expect(exploreMachine(model, id).unsupported.map((u: any) => u.construct)).toEqual(expect.arrayContaining(['history-state', 'parallel-regions']));
    const run = runStateMachine(model, id, ['e']);
    expect(run.unopened).toBeDefined();
  });
});
