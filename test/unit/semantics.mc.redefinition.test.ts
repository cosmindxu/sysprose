/**
 * T-115: a machine that redefines a member of its general machine, or has two general machines, equals its FLATTENED
 * twin written out by hand — for the walk (reach: exhaustive, configs, unreachable, dead, deadlocks, choices, the
 * cover and absence of every state) and the interpreter (`runStateMachine` on random trigger lists) alike. What the
 * view does not read stays refused as a `machine-boundary` with no walk claimed.
 */
import { describe, it, expect } from 'vitest';
import { ModelFactory, type ElementId, type Model } from '@core/index';
import { runStateMachine } from '@semantics/index';
import { loadModelText } from '@text/load';
import { machineStates, reachReport } from '../../src/semantics/mc/explore';
import { behaviourReport } from '../../src/semantics/mc/patterns';

let seed = 1150;
const rnd = (n: number): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed >> 8) % n;
};
const pick = <T,>(xs: readonly T[]): T => xs[rnd(xs.length)];

interface Step {
  name: string;
  from: string;
  to: string;
  trig: string;
  guard: string | null;
  effect: string | null;
}
const stepText = (t: Step): string =>
  `transition ${t.name} first ${t.from} accept ${t.trig}${t.guard ? ` if ${t.guard}` : ''} then ${t.to};`;
let counter = 0;
const mkStep = (froms: string[], tos: string[], attrs: string[], prefix = 't'): Step => ({
  name: `${prefix}${counter++}`,
  from: pick(froms),
  to: pick(tos),
  trig: pick(['a', 'b']),
  guard: rnd(2) === 0 ? null : `${pick(attrs)} ${pick(['<', '>', '=='])} ${rnd(4)}`,
  effect: rnd(3) === 0 ? `${pick(attrs)} = ${pick(attrs)} + 1` : null,
});

const load = async (text: string, steps: readonly Step[]): Promise<Model> => {
  const model = (await loadModelText(text, { fileName: 'redef.sysml', library: 'none' })).model;
  expect(model, text).toBeDefined();
  for (const e of steps) {
    if (e.effect === null) continue;
    const el = model!.all().find((r) => r.eClass === 'TransitionUsage' && r.declaredName === e.name);
    expect(el, `${e.name} in ${text}`).toBeDefined();
    model!.setAttrs(el!.id, { effect: e.effect });
  }
  return model!;
};
const idOf = (m: Model, qn: string): ElementId => m.all().find((e) => m.qualifiedName(e.id) === qn)!.id;
const nameOf = (model: Model, id: ElementId | undefined | null): string | null => (id == null ? null : (model.get(id)?.declaredName ?? null));

function digest(model: Model, machineId: ElementId): unknown {
  const m = reachReport(model).machines.find((r) => r.machine.id === machineId)!;
  const claims: Record<string, unknown> = {};
  for (const s of machineStates(model, machineId)) {
    for (const pattern of ['absence', 'cover'] as const) {
      const v = behaviourReport(model, {
        machineId,
        pattern: `pattern=${pattern}, scope=globally, p=state ${s.declaredName}`,
      }).properties.at(-1)!;
      claims[`${pattern} ${s.declaredName}`] = [v.claim, v.code, v.witness.map((w) => [w.event, nameOf(model, w.transition?.id), w.leaf?.name ?? null])];
    }
  }
  return {
    unsupported: m.unsupported.map((u) => u.construct),
    exhaustive: m.exhaustive,
    configs: m.configs,
    unreachable: m.states.unreachable.map((s) => s.name).sort(),
    dead: m.transitions.dead.map((t) => t.name).sort(),
    deadlocks: m.deadlocks.map((d) => [d.leaf.name, d.steps]).sort(),
    choices: m.nondeterminism.map((n) => [n.state.name, n.event, n.taken.name, n.notTaken.map((t) => t.name).sort()]).sort(),
    claims,
  };
}
function runs(model: Model, machineId: ElementId, lists: string[][]): unknown {
  return lists.map((events) => {
    const r = runStateMachine(model, machineId, events);
    return [r.visited.map((v) => nameOf(model, v)), r.fired.map((f) => nameOf(model, f.transitionId)), nameOf(model, r.finalState), [...r.valueStore].sort()];
  });
}
const lists = (): string[][] => Array.from({ length: 20 }, () => Array.from({ length: rnd(5) }, () => pick(['a', 'b'])));

async function same(text: string, qn: string, twinText: string, steps: readonly Step[], where: string): Promise<void> {
  const model = await load(text, steps);
  const twin = await load(twinText, steps);
  const l = lists();
  const a = idOf(model, qn);
  const b = idOf(twin, 'G::Flat');
  expect((digest(model, a) as { unsupported: unknown[] }).unsupported, where).toEqual([]);
  expect(digest(model, a), where).toEqual(digest(twin, b));
  expect(runs(model, a, l), `${where}\nruns`).toEqual(runs(twin, b, l));
}

const refusedAs = async (text: string, qn: string, constructs: string[] = ['machine-boundary']): Promise<string> => {
  const model = (await loadModelText(text, { fileName: 'redef.sysml', library: 'none' })).model!;
  const m = reachReport(model).machines.find((r) => r.machine.id === idOf(model, qn));
  expect(m, text).toBeDefined();
  expect(m!.unsupported.map((u) => u.construct), text).toEqual(expect.arrayContaining(constructs));
  expect(m!.exhaustive, text).toBe(false);
  return m!.unsupported.map((u) => u.detail).join(' | ');
};

describe('redefinitions and two general machines equal their flattened twin (T-115)', () => {
  it('a state redefined with a body replaces the empty state it redefines (def and typed), steps of both sides reach it', async () => {
    for (let i = 0; i < 40; i++) {
      const attrs = ['n'];
      counter = 0;
      const states = ['s0', 's1', 'x', 's2'].slice(0, 3 + rnd(2));
      const baseSteps = Array.from({ length: 2 + rnd(3) }, () => mkStep(states, states, attrs));
      const inner = ['i1', 'i2'];
      const innerStep = mkStep(['i1'], ['i2'], attrs, 'ti');
      const entry = rnd(2) === 0;
      const body = `${entry ? 'entry action e0;\n' : ''}state i1; state i2; ${stepText(innerStep)}`;
      const ownStates = ['d0'].slice(0, rnd(2));
      const ownSteps = Array.from({ length: rnd(3) }, () => mkStep(['r', ...states.filter((s) => s !== 'x'), ...ownStates], ['r', ...states.filter((s) => s !== 'x'), ...ownStates], attrs, 'to'));
      const rOwnStep = mkStep(['r'], ['r', 's0'], attrs, 'tr');
      const all = [...baseSteps, innerStep, rOwnStep, ...ownSteps];
      const typed = i % 2 === 1;
      const baseBody = `attribute n : Integer = ${rnd(3)};\n${states.map((s) => `state ${s};`).join('\n')}\n${baseSteps.map(stepText).join('\n')}`;
      const ownBody = [`state r :>> x { ${body} }`, ...ownStates.map((s) => `state ${s};`), stepText(rOwnStep), ...ownSteps.map(stepText)].join('\n');
      const text = `package G {\nstate def Base {\n${baseBody}\n}\n${typed ? `part def H { exhibit state m : Base {\n${ownBody}\n} }` : `state def Derived :> Base {\n${ownBody}\n}`}\n}`;
      // Flat: x replaced by r in its place; the general's steps over x read r.
      const flatBase = [
        baseBody.split('\n')[0],
        ...states.map((s) => (s === 'x' ? `state r { ${body} }` : `state ${s};`)),
        ...baseSteps.map((t) => stepText({ ...t, from: t.from === 'x' ? 'r' : t.from, to: t.to === 'x' ? 'r' : t.to })),
      ].join('\n');
      const flat = `package G { state def Flat {\n${flatBase}\n${[...ownStates.map((s) => `state ${s};`), stepText(rOwnStep), ...ownSteps.map(stepText)].join('\n')}\n} }`;
      void inner;
      await same(text, typed ? 'G::H::m' : 'G::Derived', flat, all, `#${i}\n${text}\n---\n${flat}`);
    }
  }, 600_000);

  it('`state :>> s;` is s: a step that names the redefining state resolves to s', async () => {
    for (let i = 0; i < 30; i++) {
      counter = 0;
      const attrs = ['n'];
      const states = ['s0', 's1', 's2'];
      const baseSteps = Array.from({ length: 2 + rnd(3) }, () => mkStep(states, states, attrs));
      const target = pick(states);
      const ownStep = mkStep(['q'], states, attrs, 'to');
      const ownStep2 = mkStep(states, ['q'], attrs, 'tp');
      const ownRef = { ...ownStep2, to: 'q' };
      const baseBody = `attribute n : Integer = ${rnd(3)};\n${states.map((s) => `state ${s};`).join('\n')}\n${baseSteps.map(stepText).join('\n')}`;
      const mapName = (s: string): string => (s === 'q' ? target : s);
      const typed = i % 2 === 1;
      const own = `state q :>> ${target};\n${stepText({ ...ownStep, from: 'q' })}\n${stepText({ ...ownRef, to: 'q' })}`;
      const text = `package G {\nstate def Base {\n${baseBody}\n}\n${typed ? `part def H { exhibit state m : Base {\n${own}\n} }` : `state def Derived :> Base {\n${own}\n}`}\n}`;
      const flat = `package G { state def Flat {\n${baseBody}\n${stepText({ ...ownStep, from: mapName('q') })}\n${stepText({ ...ownRef, to: mapName('q') })}\n} }`;
      await same(text, typed ? 'G::H::m' : 'G::Derived', flat, [...baseSteps, ownStep, ownRef], `#${i}\n${text}`);
    }
  }, 600_000);

  it('a transition redefined (API) replaces the inherited one; one that omits a guard or trigger it replaces is refused', async () => {
    for (let i = 0; i < 40; i++) {
      counter = 0;
      const attrs = ['n'];
      const states = ['s0', 's1', 's2'];
      const baseSteps = Array.from({ length: 2 + rnd(3) }, () => mkStep(states, states, attrs));
      const k = rnd(baseSteps.length);
      const t1 = baseSteps[k];
      const t2: Step = { ...mkStep(states, states, attrs, 'tn'), guard: t1.guard === null ? null : `n ${pick(['<', '>', '=='])} ${rnd(4)}`, effect: t1.effect === null ? null : 'n = n + 1' };
      const extra = mkStep(states, states, attrs, 'tx');
      const baseBody = `attribute n : Integer = ${rnd(3)};\n${states.map((s) => `state ${s};`).join('\n')}\n${baseSteps.map(stepText).join('\n')}`;
      const text = `package G {\nstate def Base {\n${baseBody}\n}\nstate def Derived :> Base {\n${stepText(t2)}\n${stepText(extra)}\n}\n}`;
      const flat = `package G { state def Flat {\nattribute n : Integer = 0;\n${states.map((s) => `state ${s};`).join('\n')}\n${baseSteps.filter((_, j) => j !== k).map(stepText).join('\n')}\n${stepText(t2)}\n${stepText(extra)}\n} }`;
      const steps = [...baseSteps, t2, extra];
      const m1 = await load(text, steps);
      // Same initial attribute value in both.
      const nVal = /attribute n : Integer = (\d)/.exec(baseBody)![1];
      const twinFixed = flat.replace('= 0;', `= ${nVal};`);
      const m3 = await load(twinFixed, steps.filter((x) => x !== t1));
      new ModelFactory(m1).redefinition(idOf(m1, `G::Derived::${t2.name}`), idOf(m1, `G::Base::${t1.name}`));
      const l = lists();
      const a = idOf(m1, 'G::Derived');
      const b = idOf(m3, 'G::Flat');
      expect((digest(m1, a) as { unsupported: unknown[] }).unsupported, text).toEqual([]);
      expect(digest(m1, a), text).toEqual(digest(m3, b));
      expect(runs(m1, a, l), text).toEqual(runs(m3, b, l));
    }
    // A replacement that drops the guard the replaced step carries is not read.
    const text = `package G { state def Base { state s0; state s1; transition t1 first s0 accept a if n < 2 then s1; attribute n : Integer = 0; }
      state def Derived :> Base { transition t2 first s0 accept b then s1; } }`;
    const model = (await loadModelText(text, { fileName: 'r.sysml', library: 'none' })).model!;
    new ModelFactory(model).redefinition(idOf(model, 'G::Derived::t2'), idOf(model, 'G::Base::t1'));
    const m = reachReport(model).machines.find((r) => r.machine.id === idOf(model, 'G::Derived'))!;
    expect(m.unsupported.map((u) => u.construct)).toContain('machine-boundary');
    expect(m.exhaustive).toBe(false);
  }, 600_000);

  it('two general machines are read in declaration order when they share no name, def and typed', async () => {
    for (let i = 0; i < 40; i++) {
      counter = 0;
      const attrs = ['n', 'k'];
      const aStates = ['a0', 'a1', 'a2'].slice(0, 2 + rnd(2));
      const bStates = ['b0', 'b1'];
      const aSteps = Array.from({ length: 1 + rnd(3) }, () => mkStep(aStates, aStates, ['n'], 'ta'));
      const bSteps = Array.from({ length: 1 + rnd(3) }, () => mkStep(bStates, bStates, ['k'], 'tb'));
      const both = [...aStates, ...bStates];
      const ownSteps = Array.from({ length: 1 + rnd(3) }, () => mkStep(both, both, attrs, 'to'));
      const aBody = `attribute n : Integer = ${rnd(3)};\n${aStates.map((s) => `state ${s};`).join('\n')}\n${aSteps.map(stepText).join('\n')}`;
      const bBody = `attribute k : Integer = ${rnd(3)};\n${bStates.map((s) => `state ${s};`).join('\n')}\n${bSteps.map(stepText).join('\n')}`;
      const typed = i % 2 === 1;
      const own = ownSteps.map(stepText).join('\n');
      const heads = i % 4 < 2 ? 'A, B' : 'B, A';
      const first = heads === 'A, B' ? [aBody, bBody] : [bBody, aBody];
      const text = `package G {\nstate def A {\n${aBody}\n}\nstate def B {\n${bBody}\n}\n${typed ? `part def H { exhibit state m : ${heads} {\n${own}\n} }` : `state def Derived :> ${heads} {\n${own}\n}`}\n}`;
      const flat = `package G { state def Flat {\n${first.join('\n')}\n${own}\n} }`;
      await same(text, typed ? 'G::H::m' : 'G::Derived', flat, [...aSteps, ...bSteps, ...ownSteps], `#${i}\n${text}`);
    }
  }, 600_000);

  it('stays refused, with the reason stated: a name both generals hold, a cycle, two starts, a redefinition over a state holding an entry action (substates and steps merge: redefinition-merge test), a nested redefinition, an attribute redefinition, a transition redefinition with no ends', async () => {
    const both = await refusedAs(
      `package G { state def A { state s0; state s1; transition t0 first s0 accept a then s1; } state def B { state s0; transition t1 first s0 accept b then s0; }
        state def D :> A, B { state z; transition tz first s0 accept a then z; } }`,
      'G::D',
    );
    expect(both).toContain('both declare `s0`');
    const cyc = await refusedAs(
      `package G { state def A :> B { state s0; transition t0 first s0 accept a then s0; } state def B :> A { state s1; } }`,
      'G::A',
    );
    expect(cyc).toContain('cycle');
    const starts = await refusedAs(
      `package G { state def A { initial a0; state s0; transition t0 first s0 accept a then s0; } state def B { initial b0; state s1; }
        state def D :> A, B { transition tz first s0 accept a then s1; } }`,
      'G::D',
    );
    expect(starts).toContain('start node');
    const content = await refusedAs(
      `package G { state def A { state s0 { entry action e0; state in0; } state s1; transition t0 first s0 accept a then s1; }
        state def D :> A { state r :>> s0 { state in1; } transition tz first r accept b then s1; } }`,
      'G::D',
    );
    expect(content).toContain('something other than substates and steps');
    await refusedAs(
      `package G { state def A { state s0; state s1; transition t0 first s0 accept a then s1; }
        state def D :> A { state r :>> s0 { state x; state y :>> x; } transition tz first r accept b then s1; } }`,
      'G::D',
    );
    await refusedAs(
      `package G { state def A { attribute n : Integer = 1; state s0; transition t0 first s0 accept a then s0; }
        state def D :> A { attribute :>> n = 7; state z; transition tz first s0 accept b then z; } }`,
      'G::D',
    );
    await refusedAs(
      `package G { state def A { state s0; state s1; transition t0 first s0 accept a then s1; }
        state def D :> A { state r :>> s0 { entry action e0; } state r2 :>> s0 { } transition tz first r accept b then s1; } }`,
      'G::D',
    );
  });
});

// sm-inherit I1: a machine usage that redefines an inherited machine usage is walked on the effective machine
// (Part 1 §7.13: the redefining usage replaces the redefined one and keeps its members).
describe('a machine usage redefining an inherited machine usage is walked whole (sm-inherit I1)', () => {
  const base = `part def Eng { exhibit state s { entry state a; state b; state c; transition t1 first a accept go then b; } }`;
  const walk = async (text: string, qn: string) => {
    const model = (await loadModelText(text, { fileName: 'inh.sysml', library: 'none' })).model!;
    const m = reachReport(model).machines.find((r) => r.machine.id === idOf(model, qn))!;
    expect(m, text).toBeDefined();
    return m;
  };
  const names = (xs: readonly { qualifiedName?: string }[]): string[] => xs.map((x) => x.qualifiedName ?? '').sort();

  it('a dead state only in the inherited part stays dead on both machines, the walk exhaustive', async () => {
    const text = `package P { ${base} part def Eng2 :> Eng { exhibit state s :>> Eng::s { state d; transition t2 first b accept g2 then d; } } }`;
    for (const qn of ['P::Eng::s', 'P::Eng2::s']) {
      const m = await walk(text, qn);
      expect(m.exhaustive, qn).toBe(true);
      expect(m.unsupported, qn).toEqual([]);
      expect(names(m.states.unreachable), qn).toEqual(['P::Eng::s::c']);
    }
    expect((await walk(text, 'P::Eng2::s')).states.total).toBe(4);
  });

  it('a dead state only in the redefining part is reported on the redefining machine alone', async () => {
    const text = `package P { ${base} part def Eng2 :> Eng { exhibit state s :>> Eng::s { state d; state e; transition t2 first b accept g2 then d; } } }`;
    const m = await walk(text, 'P::Eng2::s');
    expect(m.exhaustive).toBe(true);
    expect(names(m.states.unreachable)).toEqual(['P::Eng2::s::e', 'P::Eng::s::c'].sort());
    expect(names((await walk(text, 'P::Eng::s')).states.unreachable)).toEqual(['P::Eng::s::c']);
  });

  it('the redefining part can make an inherited dead state reachable, so it is not reported dead there', async () => {
    const text = `package P { ${base} part def Eng2 :> Eng { exhibit state s :>> Eng::s { transition t2 first b accept g2 then c; } } }`;
    expect(names((await walk(text, 'P::Eng::s')).states.unreachable)).toEqual(['P::Eng::s::c']);
    const m = await walk(text, 'P::Eng2::s');
    expect(m.exhaustive).toBe(true);
    expect(m.states.unreachable).toEqual([]);
  });

  it('a state redefined by name (not the same name) is read too', async () => {
    const text = `package P { ${base} part def Eng2 :> Eng { exhibit state s2 :>> s { state d; transition t2 first b accept g2 then d; } } }`;
    const m = await walk(text, 'P::Eng2::s2');
    expect(m.exhaustive).toBe(true);
    expect(m.states.total).toBe(4);
  });

  it('a clash on a name the general already holds stays refused with the reason, never a silent claim', async () => {
    const text = `package P { ${base} part def Eng2 :> Eng { exhibit state s :>> Eng::s { state a; transition t2 first b accept g2 then a; } } }`;
    const m = await walk(text, 'P::Eng2::s');
    expect(m.exhaustive).toBe(false);
    expect(m.unsupported.length).toBeGreaterThan(0);
  });
});
