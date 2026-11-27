/**
 * Review findings in the state-machine evaluation: coupling through a referenced action, a transition effect that
 * names an action, an assignment effect that fails at run time, and a timed transition in a parallel region.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '../../src/semantics/execute';
import { exploreMachine } from '../../src/semantics/mc/explore';

const load = async (src: string): Promise<any> => loadModelText(src, { fileName: 'rf.sysml' });
const find = (m: any, n: string): any => m.all().find((e: any) => m.qualifiedName(e.id) === n);

const coupled = (entry: string): string =>
  `package P { action setn { assign n := 1; } state def M { attribute n : Integer = 0; entry; then p; state p parallel { ` +
  `state r1 { entry; then a1; state a1; state a2 { ${entry} } transition t1 first a1 accept e then a2; } ` +
  'state r2 { entry; then b1; state b1; state b2; transition t2 first b1 accept e if n == 1 then b2; } } } }';

describe('1. coupling through a referenced action', () => {
  for (const entry of ['entry assign n := 1;', 'entry setn;']) {
    it(`explored in every order, coupled through n: ${entry}`, async () => {
      const l = await load(coupled(entry));
      const w = exploreMachine(l.model, find(l.model, 'P::M').id);
      expect(w.exhaustive).toBe(true);
      expect(w.unsupported).toEqual([]);
    });
  }
});

describe('2. a transition effect referring to an action (`do bump`)', () => {
  const src = 'package P { action bump { assign n := n + 1; } state def M { attribute n : Integer = 0; entry; then a; state a; state b; state c; ' +
    'transition t1 first a accept e do bump then b; transition t2 first b accept f if n == 1 then c; } }';
  it('is performed by the interpreter and the walk', async () => {
    const l = await load(src);
    const id = find(l.model, 'P::M').id;
    const run = runStateMachine(l.model, id, ['e', 'f']);
    expect(Object.fromEntries(run.valueStore).n).toBe(1);
    expect(run.fired.map((f: any) => f.trigger)).toEqual(['e', 'f']);
    const w = exploreMachine(l.model, id);
    expect(w.unsupported).toEqual([]);
    expect(w.configStates.some((s: any) => s.includes(find(l.model, 'P::M::c').id))).toBe(true);
  });
  it('`do action bump` DECLARES a new, empty effect action named bump (SysML v2 §7.18.3, OnOff4): it changes no value', async () => {
    const l = await load(src.replace('do bump', 'do action bump'));
    const id = find(l.model, 'P::M').id;
    const run = runStateMachine(l.model, id, ['e', 'f']);
    expect(Object.fromEntries(run.valueStore).n).toBe(0);
    const w = exploreMachine(l.model, id);
    expect(w.unsupported).toEqual([]);
    expect(w.exhaustive).toBe(true);
    expect(w.configStates.some((s: any) => s.includes(find(l.model, 'P::M::c').id))).toBe(false);
  });
  it('an unresolvable or non-assignment action refuses', async () => {
    const l = await load(src.replace('assign n := n + 1;', 'action inner;'));
    const id = find(l.model, 'P::M').id;
    expect(exploreMachine(l.model, id).exhaustive).toBe(false);
  });
});

describe('3. an assignment effect that fails when the transition fires', () => {
  const src = 'package P { state def M { attribute m : Integer; attribute n : Integer = 0; entry; then a; state a; state b; state c; state d; ' +
    'transition t1 first c accept g do assign m := 1 then a; transition t2 first a accept e do assign n := m + 1 then b; ' +
    'transition t3 first b accept f if n == 0 then d; } }';
  it('refuses the run and the walk instead of skipping the effect', async () => {
    const l = await load(src);
    const id = find(l.model, 'P::M').id;
    const run = runStateMachine(l.model, id, ['e', 'f']);
    expect(run.unopened ?? '').not.toBe('');
    const w = exploreMachine(l.model, id);
    expect(w.exhaustive).toBe(false);
    expect(w.configStates.some((s: any) => s.includes(find(l.model, 'P::M::d').id))).toBe(false);
  });
});

describe('4. a timed transition inside a parallel region', () => {
  it('a dwell that is no literal whole number: the interpreter refuses, in the explorer\'s words (a literal one is run, sm-par-dwell)', async () => {
    const l = await load('package P { item def e; state def M { entry; then p; state p parallel { state r1 { entry; then a1; state a1; state a2; transition t1 first a1 accept e then a2; } state r2; } state q; transition go first p accept e then q; } }');
    const id = find(l.model, 'P::M').id;
    l.model.setAttrs(find(l.model, 'P::M::p::r1::t1').id, { trigger: 'after(2.5)' });
    const u = exploreMachine(l.model, id).unsupported;
    expect(u.map((x: any) => x.construct)).toEqual(['parallel-regions']);
    const run = runStateMachine(l.model, id, ['e']);
    expect(run.unopened ?? '').toMatch(/timed \(`after`\) transition/);
    expect(run.unopened).toContain(u[0].detail.replace(/ \(SysML.*/, ''));
  });
});
