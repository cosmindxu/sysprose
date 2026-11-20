/**
 * A parallel state nested in an ordinary machine is performed concurrently (SysML v2 §7.18.2): every region is
 * entered at its own start, an event is offered to every region, an event leaving the state exits all regions.
 * Shapes the interpreter does not perform stay refused with a stated reason.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '../../src/semantics/execute';

const find = (m: any, n: string) => m.all().find((e: any) => m.qualifiedName(e.id) === n);
async function run(src: string, events: string[], effects: Record<string, string> = {}): Promise<any> {
  const l: any = await loadModelText(src, { fileName: 'pn.sysml' });
  const m = l.model;
  // Transition effects are set through the API (`attrs.effect`): the text has no spelling for one on a nested transition.
  for (const [q, eff] of Object.entries(effects)) find(m, q).attrs.effect = eff;
  const r = runStateMachine(m, find(m, 'P::M').id, events);
  const act = r.activeStates.map((s: any) => m.qualifiedName(s).replace('P::M::', ''));
  const store = Object.fromEntries(r.valueStore);
  const performed = r.performed.map((a: any) => `${m.qualifiedName(a.stateId).replace('P::M::', '')}.${a.phase}`);
  return { r, act, store, performed };
}

const region = (n: string, a: string, b: string, ev: string, extra = '') =>
  `state ${n} { entry; then ${a}; state ${a}; state ${b} ${extra}; transition t_${n} first ${a} accept ${ev} then ${b}; }`;
const two = (body = '', tail = '') =>
  `package P { item def e; item def f; item def g; attribute n : Integer = 0; state def M { entry; then p; ` +
  `state p parallel { ${region('r1', 'a1', 'a2', 'f')} ${region('r2', 'b1', 'b2', 'f')} ${body} } state q; ` +
  `transition go first p accept e then q; ${tail} } }`;

describe('nested parallel state, performed concurrently', () => {
  it('enters every region at its own start', async () => {
    const x = await run(two(), []);
    expect(x.r.unopened).toBeUndefined();
    expect(x.act).toEqual(['p::r1::a1', 'p::r2::b1']);
  });
  it('offers an event to every region', async () => {
    const x = await run(two(), ['f']);
    expect(x.act).toEqual(['p::r1::a2', 'p::r2::b2']);
  });
  it('a region with no enabled transition stays', async () => {
    const src = two().replace('accept f then b2', 'accept g then b2');
    const x = await run(src, ['f']);
    expect(x.act).toEqual(['p::r1::a2', 'p::r2::b1']);
  });
  it('an event leaving the parallel state exits all regions', async () => {
    const x = await run(two(), ['f', 'e']);
    expect(x.act).toEqual(['q']);
  });
  it('exit actions run for every region, then the parallel state', async () => {
    const src = `package P { item def e; state def M { entry; then p; state p parallel { exit action xp; state r1 { exit action x1; } state r2 { exit action x2; } } state q; transition go first p accept e then q; } }`;
    const x = await run(src, ['e']);
    expect(x.act).toEqual(['q']);
    expect(x.performed.filter((s: string) => s.endsWith('.exit'))).toEqual(['p::r1.exit', 'p::r2.exit', 'p.exit']);
  });
  it('simple regions without substates are all active at once', async () => {
    const src = `package P { item def e; state def M { entry; then p; state p parallel { state r1; state r2; } state q; transition go first p accept e then q; } }`;
    expect((await run(src, [])).act).toEqual(['p::r1', 'p::r2']);
    expect((await run(src, ['e'])).act).toEqual(['q']);
  });
  it('regions are applied in declaration order, each seeing the store the previous one left', async () => {
    const r1 = 'state r1 { entry; then a1; state a1; state a2; transition t first a1 accept f then a2; }';
    const r2 = 'state r2 { entry; then b1; state b1; state b2; transition u first b1 accept f if n == 1 then b2; }';
    const mk = (body: string): string =>
      `package P { item def f; state def M { attribute n : Integer = 0; entry; then p; state p parallel { ${body} } } }`;
    const eff = { 'P::M::p::r1::t': 'n = 1' };
    const x = await run(mk(r1 + r2), ['f'], eff);
    expect(x.act).toEqual(['p::r1::a2', 'p::r2::b2']);
    expect(x.store.n).toBe(1);
    // r2 declared first: it is offered the event before r1 has written n, its guard does not hold, and it stays
    const y = await run(mk(r2 + r1), ['f'], eff);
    expect(y.act).toEqual(['p::r2::b1', 'p::r1::a2']);
    expect(y.store.n).toBe(1);
  });
  it('re-entering the parallel state restarts every region at its start', async () => {
    const src = two('', 'transition back first q accept g then p;');
    const x = await run(src, ['f', 'e', 'g']);
    expect(x.act).toEqual(['p::r1::a1', 'p::r2::b1']);
  });
  it('an event taken by a region and also leaving the state stops the run, naming the transition', async () => {
    const src = two().replace('accept f then a2', 'accept e then a2');
    const x = await run(src, ['e', 'f']);
    expect(x.r.refused).toBeDefined();
    expect(x.act).toEqual(['p::r1::a1', 'p::r2::b1']);
  });
});

describe('nested parallel shapes that stay refused, with a reason', () => {
  const base = (inner: string, tail = '') =>
    `package P { item def e; state def M { entry; then p; state p parallel { ${inner} } state q; transition go first p accept e then q; ${tail} } }`;
  const refused = async (src: string, re: RegExp): Promise<void> => {
    const x = await run(src, ['e']);
    expect(x.r.unopened).toMatch(re);
    expect(x.r.unopened).toMatch(/§7\.18\.2/);
    expect(x.act).toEqual([]);
  };
  it('a parallel state inside a parallel state', () =>
    refused(base('state r1 parallel { state s1; state s2; } state r2;'), /holds another parallel state/));
  it('a completion transition out of the parallel state', () =>
    refused(base('state r1; state r2;', 'transition done first p then q;'), /completion transition/));
  it('a history composite inside a region', async () => {
    const l: any = await loadModelText(base('state r1 { state a; state b; } state r2;'), { fileName: 'h.sysml' });
    find(l.model, 'P::M::p::r1').attrs.history = true;
    const r = runStateMachine(l.model, find(l.model, 'P::M').id, ['e']);
    expect(r.unopened).toMatch(/history state/);
    expect(r.activeStates).toEqual([]);
  });
  it('a step into a region', () =>
    refused(base('state r1 { state a1; state a2; } state r2;', 'transition into first q accept e then p::r1::a2;'), /steps into a region/));
  it('a parallel state below a top-level parallel machine', async () => {
    const src = `package P { state def M parallel { state x { entry; then x1; state x1; state y parallel { state s1; state s2; } } state z; } }`;
    const x = await run(src, []);
    expect(x.r.unopened).toMatch(/below a parallel machine/);
  });
  it('an entry action naming a start on the parallel state', () =>
    refused(base('entry; then r1; state r1; state r2;'), /entry action naming a start/));
});
