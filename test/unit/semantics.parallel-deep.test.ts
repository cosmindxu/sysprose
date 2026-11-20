/**
 * SysML v2 §7.18.2: a parallel state INSIDE a region of a parallel state (or below a parallel machine root) is
 * performed — the regions form a tree, the events are offered in flattened depth-first declaration order, a nested
 * parallel state completes when its regions are final, and leaving it exits its regions first. The interpreter
 * (`runHierRegion`) and the explorer (`MachineConfig.par`, `candidatesOf`, `advanceConfig`) are compared over every
 * event sequence up to 4, on the active leaves and on the store, where every entry, exit and effect appends a digit
 * to `n`, so the store also records the ORDER of everything that was performed.
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
  'a parallel state in a region, entered by a transition': outer(`${INNER} transition en first a1 accept f then pp; transition lv first pp accept h then a1;`),
  'a parallel state that is the start of its region': outer(`${INNER} state a1; transition lv first pp accept h then a1;`, '', true),
  'a parallel state in a composite of a region': outer(
    `state c { entry ${d(1)}; ${INNER} } transition en first a1 accept f then c;`,
  ),
  'a nested parallel state that completes, then a completion transition leaves it': outer(
    `${INNER} state done1; transition en first a1 accept f then pp; transition cp first pp then done1;`,
  ),
  'a completion that waits for the last nested region': outer(
    `${INNER} state done1; transition en first a1 accept f then pp; transition cp first pp if n > 0 then done1;`,
  ),
  'the outer parallel state leaves while the nested one is active': outer(`${INNER} transition en first a1 accept f then pp;`),
  'a nested event shared with another outer region': outer(`${INNER} transition en first a1 accept f then pp;`).replace(
    'transition tb first b1 accept f then b2;',
    'transition tb first b1 accept g then b2;',
  ),
  'coupled nested regions (one writes what the other reads)': outer(
    `state pp parallel { state x { state x1; state x2; transition tx first x1 accept g then x2 ; } ` +
      `state y { state y1; state y2; transition ty first y1 accept g if n == 0 then y2; } } transition en first a1 accept f then pp;`,
    '',
  ),
  'the machine root is parallel, and a region holds a parallel state': pre.replace('package P {', 'package P {') +
    `state def M parallel { state r1 { state a1; ${INNER} transition en first a1 accept f then pp; } ` +
    `state r2 { state b1; state b2; transition tb first b1 accept g then b2; } }}`,
};
const EXTRA_EFFECTS: Record<string, Record<string, string>> = {
  'a parallel state in a region, entered by a transition': { 'P::M::p::r1::en': 'n = n * 10 + 11', 'P::M::p::r1::pp::x::tx': 'n = n * 10 + 12' },
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

describe('a parallel state inside a parallel state: the explorer and the interpreter agree', () => {
  for (const [name, src] of Object.entries(MACHINES)) {
    it(`${name}: every event sequence up to 4`, async () => {
      const model = await load(src, EXTRA_EFFECTS[name] ?? {});
      const id = find(model, 'P::M').id;
      expect(parallelRefusal(model, id)).toBeUndefined();
      expect(exploreMachine(model, id).unsupported).toEqual([]);
      for (const seq of sequences(4)) {
        const run = runStateMachine(model, id, seq);
        if (run.unopened !== undefined || run.refused !== undefined) continue; // a stop the explorer refuses statically
        const want = run.activeStates.map((s: string) => model.qualifiedName(s)).sort();
        const got = drive(model, id, seq);
        expect([...got.leaves].sort(), `${name} after ${seq.join(',')}`).toEqual(want);
        expect(got.store, `${name} store after ${seq.join(',')}`).toEqual(Object.fromEntries(run.valueStore));
      }
    });
  }

  it('both nested regions are entered, in flattened declaration order, with the store as a trace', async () => {
    const model = await load(outer(`${INNER} transition en first a1 accept f then pp;`));
    const id = find(model, 'P::M').id;
    const names = (x: string[]): string[] => x.map((s) => model.qualifiedName(s));
    expect(names(runStateMachine(model, id, []).activeStates)).toEqual(['P::M::p::r1::a1', 'P::M::p::r2::b1']);
    const r = runStateMachine(model, id, ['f']);
    // f: r1 takes `en` into pp (entry pp 1, x 3, y 5); then r2 takes f (b1 -> b2); nothing else.
    expect(names(r.activeStates)).toEqual(['P::M::p::r1::pp::x::x1', 'P::M::p::r1::pp::y::y1', 'P::M::p::r2::b2']);
    expect(Object.fromEntries(r.valueStore).n).toBe(79135); // r1 7, r2 9, then pp 1, x 3, y 5
  });

  it('leaving the nested parallel state exits its regions first; leaving the outer one exits every level inner first', async () => {
    const model = await load(outer(`${INNER} transition en first a1 accept f then pp;`));
    const id = find(model, 'P::M').id;
    const store = (seq: string[]): number => Object.fromEntries(runStateMachine(model, id, seq).valueStore).n as number;
    const entered = store(['f']);
    const left = store(['f', 'e']);
    // e leaves p: exits x (4), y (6) before pp (2), then r1 (8): the digits are appended in exactly that order.
    expect(String(left).slice(String(entered).length)).toBe('46' + '2' + '8');
    expect(model.qualifiedName(runStateMachine(model, id, ['f', 'e']).activeStates[0])).toBe('P::M::q');
  });

  it('the nested state completes only when every nested region is final', async () => {
    const model = await load(outer(`${INNER} state done1; transition en first a1 accept f then pp; transition cp first pp then done1;`));
    const id = find(model, 'P::M').id;
    const at = (seq: string[]): string[] => runStateMachine(model, id, seq).activeStates.map((s: string) => model.qualifiedName(s)).sort();
    // f enters pp; a second f moves y to y2; then x needs g,g and y needs g to be final.
    expect(at(['f', 'f', 'g', 'g', 'g'])).toContain('P::M::p::r1::done1');
    expect(at(['f', 'f', 'g'])).not.toContain('P::M::p::r1::done1');
  });
});
