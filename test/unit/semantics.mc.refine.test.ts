/**
 * Specialisation conformance (audit S5, `./conformance`): `state def X :> Y` preserves the traces of Y — every run of Y
 * over the events Y names is a run X can follow — decided off both exhaustive walks, never claiming refinement.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '@semantics/index';
import { behaviourReport, SPECIALISATION_CODE } from '../../src/semantics/mc/patterns';
import { propertyVerdictLines, textOf } from '../../src/semantics/mc/report-lines';
import { checkConformance } from '../../src/semantics/mc/conformance';
import { checkInterfacePair, interfacesLines, interfacesReport } from '../../src/semantics/mc/interfaces';
import { isKnownCode } from '@text/langium/diagnostic-codes';

const BASE = `
  state def Base {
    entry; then a;
    state a; state b;
    transition t1 first a accept go then b;
  }`;

async function load(body: string) {
  const r = await loadModelText(`package P {${body}\n}\n`, { fileName: 'c.sysml', library: 'none' });
  expect(r.report.diagnostics).toEqual([]);
  const model = r.model!;
  const id = (qn: string) => model.all().find((e) => model.qualifiedName(e.id) === qn)!.id;
  return { model, id };
}
const row = (model: any, machineId: any, extra: object = {}) =>
  behaviourReport(model, { machineId, conformance: true, ...extra }).properties.find((p) => p.property.pattern === 'conformance');

describe('S5 — a specialisation that only adds states and transitions conforms', () => {
  it('p9: Special adds a state and a transition, Base traces are preserved', async () => {
    const { model, id } = await load(`${BASE}
  state def Special :> Base { state c; transition t2 first b accept go then c; }`);
    const r = row(model, id('P::Special'))!;
    expect(r.claim).toBe('pass');
    expect(r.code).toBeNull();
    expect(r.sentence).toBe('`P::Special` preserves the `P::Base` traces over alphabet {go}');
    expect(r.detail).toContain('nothing here claims the specialising machine refines');
    expect(isKnownCode(SPECIALISATION_CODE)).toBe(true);
  });

  it('a machine that specialises nothing gets no row, and the row is off unless asked', async () => {
    const { model, id } = await load(`${BASE}
  state def Special :> Base { state c; transition t2 first b accept go then c; }`);
    expect(row(model, id('P::Base'))).toBeUndefined();
    const plain = behaviourReport(model, { machineId: id('P::Special') });
    expect(plain.properties.find((p) => p.property.pattern === 'conformance')).toBeUndefined();
  });

  it('an added event the general never names is not offered, and does not break conformance', async () => {
    const { model, id } = await load(`${BASE}
  state def Special :> Base { state c; transition t2 first b accept extra then c; }`);
    expect(row(model, id('P::Special'))!.claim).toBe('pass');
  });
});

describe('S5 — a specialisation that changes a step of the general does not', () => {
  const retargeted = `${BASE}
  state def Special :> Base { state c; transition t1 :>> t1 first a accept go then c; }`;

  it('a re-targeted transition fails with a witness that replays on the general machine', async () => {
    const { model, id } = await load(retargeted);
    const r = row(model, id('P::Special'))!;
    expect(r.claim).toBe('fail');
    expect(r.code).toBe(SPECIALISATION_CODE);
    expect(r.witness.map((w) => w.event)).toEqual(['-', 'go']);
    // The witness is a run of Base: the interpreter takes it there and ends where the witness ends.
    const run = runStateMachine(model, id('P::Base'), r.witness.filter((w) => w.event !== '-' && w.event !== '').map((w) => w.event));
    expect(model.qualifiedName(run.finalState!)).toBe(r.witness[r.witness.length - 1].leaf!.qualifiedName);
    // ... and Special does not end there.
    const sp = runStateMachine(model, id('P::Special'), ['go']);
    expect(model.qualifiedName(sp.finalState!)).not.toBe(r.witness[r.witness.length - 1].leaf!.qualifiedName);
    const rep = behaviourReport(model, { machineId: id('P::Special'), conformance: true });
    expect(rep.exitCode).toBe(1);
    expect(rep.diagnostics.some((d) => d.code === SPECIALISATION_CODE && d.severity === 'error')).toBe(true);
    expect(textOf(propertyVerdictLines(r, false, 0))).toContain('from --conformance');
  });

  it('a completion added after the general’s step moves the run on: not preserved', async () => {
    const { model, id } = await load(`${BASE}
  state def Special :> Base { state c; transition t2 first b then c; }`);
    expect(row(model, id('P::Special'))!.claim).toBe('fail');
  });
});

describe('S5 — what is not claimed', () => {
  it('a cut walk is inconclusive, never a pass', async () => {
    const { model, id } = await load(`${BASE}
  state def Special :> Base { state c; transition t2 first b accept go then c; }`);
    const r = row(model, id('P::Special'), { maxConfigs: 2 })!;
    expect(r.claim).toBe('inconclusive');
    expect(r.detail).toContain('no conformance claimed');
    expect(r.detail).toContain('did not finish');
  });

  it('a general with a dwell is inconclusive: the walk has no clock', async () => {
    const { model, id } = await load(`
  state def B2 { entry; then a; state a; state b; transition t1 first a accept after 5 then b; }
  state def S2 :> B2 { state c; transition t2 first b accept go then c; }`);
    const out = checkConformance(model, id('P::S2'));
    expect(out.kind).toBe('inconclusive');
    expect(row(model, id('P::S2'))!.detail).toContain('dwell');
  });
});

/**
 * Interface protocol compatibility (`--interfaces`, `../../src/semantics/mc/interfaces`): the two connected parts'
 * machines composed on the items their ports carry (de Alfaro & Henzinger 2001).
 */
describe('interface automata — check-behaviour --interfaces', () => {
  const HEAD = `
  item def Req; item def Resp;
  port def ClientP { out item rq : Req; in item rs : Resp; }
  port def ServerP { in item rq : Req; out item rs : Resp; }`;
  const CLIENT = `
  part def Client { port c : ClientP;
    action ask { send Req via c; }
    exhibit state m { entry; then idle; state idle; state wait;
      transition t1 first idle accept go do ask then wait;
      transition t2 first wait accept Resp via c then idle; } }`;
  const SYS = `part sys { part cl : Client; part sv : Server; connect cl.c to sv.s; }`;

  async function run(body: string) {
    const r = await loadModelText(`package P {${HEAD}${body}\n}\n`, { fileName: 'i.sysml', library: 'none' });
    expect(r.report.diagnostics).toEqual([]);
    const out = interfacesReport(r.model!);
    expect(out.pairs).toHaveLength(1);
    return { out: out.pairs[0], text: interfacesLines(r.model!, out).join('\n'), model: r.model! };
  }

  it('a compatible request/response pair is compatible, and the flag is off by default', async () => {
    const { out, text } = await run(`${CLIENT}
  part def Server { port s : ServerP;
    action reply { send Resp via s; }
    exhibit state m { entry; then idle; state idle; state busy;
      transition t1 first idle accept Req via s then busy;
      transition t2 first busy accept done do reply then idle; } }
  ${SYS}`);
    expect(out.kind).toBe('compatible');
    expect(text).toContain('are compatible over');
    expect(text).toContain('untimed');
  });

  it('an unspecified reception: the server has no transition taking the request, with the product trace', async () => {
    const { out } = await run(`${CLIENT}
  part def Server { port s : ServerP;
    exhibit state m { entry; then idle; state idle; state busy;
      transition t1 first idle accept ping then busy; } }
  ${SYS}`);
    // Not forced: the environment avoids it by withholding \`go\`, so the pair is compatible (de Alfaro-Henzinger) and the
    // reception is reported as a finding a helpful environment reaches.
    expect(out.kind).toBe('compatible');
    if (out.kind !== 'compatible') return;
    const f = out.findings.find((x) => x.kind === 'unspecified-reception')!;
    expect(f.item).toBe('rq');
    expect(f.sender).toBe('A');
    expect(f.forced).toBe(false); // reachable only when the environment offers `go`
    expect(f.witness.map((s) => s.label)).toEqual(['open', 'A: go / send rq via c; B: no transition accepting rq']);
  });

  it('a send nothing triggers is forced: no environment choice avoids the unspecified reception', async () => {
    const { out } = await run(`
  part def Client { port c : ClientP;
    action ask { send Req via c; }
    exhibit state m { entry; then idle; state idle; state wait;
      transition t1 first idle do ask then wait; } }
  part def Server { port s : ServerP;
    exhibit state m { entry; then idle; state idle; state busy; transition t1 first idle accept ping then busy; } }
  ${SYS}`);
    expect(out.kind).toBe('incompatible');
    if (out.kind === 'incompatible') expect(out.findings[0]).toMatchObject({ kind: 'unspecified-reception', forced: true });
  });

  it('a deadlock: both machines wait for the other and nothing is enabled', async () => {
    const { out } = await run(`
  part def Client { port c : ClientP;
    exhibit state m { entry; then idle; state idle; state done;
      transition t first idle accept Resp via c then done; } }
  part def Server { port s : ServerP;
    exhibit state m { entry; then idle; state idle; state done;
      transition t first idle accept Req via s then done; } }
  ${SYS}`);
    // A deadlock is reported, never a verdict of incompatibility.
    expect(out.kind).toBe('compatible');
    if (out.kind !== 'compatible') return;
    const d = out.findings.find((x) => x.kind === 'deadlock')!;
    expect(d.forced).toBe(true);
    expect(d.witness.map((s) => s.label)).toEqual(['open']);
  });

  it('a send the walk cannot attribute to a port gives no verdict, with the reason', async () => {
    const { out } = await run(`
  part def Client { port c : ClientP;
    action ask { send Req; }
    exhibit state m { entry; then idle; state idle; state wait;
      transition t1 first idle accept go do ask then wait; } }
  part def Server { port s : ServerP;
    exhibit state m { entry; then idle; state idle; state busy;
      transition t1 first idle accept Req via s then busy; } }
  ${SYS}`);
    expect(out.kind).toBe('no-verdict');
    if (out.kind === 'no-verdict') expect(out.reason).toContain('without a port');
  });

  it('a guard gives no verdict; a cut walk is undecided, never compatible', async () => {
    const guarded = await run(`
  part def Client { port c : ClientP; attribute n : Integer = 0;
    exhibit state m { entry; then idle; state idle; state wait;
      transition t1 first idle accept go if n > 1 then wait; } }
  part def Server { port s : ServerP;
    exhibit state m { entry; then idle; state idle; state busy; transition t1 first idle accept ping then busy; } }
  ${SYS}`);
    expect(guarded.out.kind).toBe('no-verdict');
    const r = await loadModelText(`package P {${HEAD}${CLIENT}
  part def Server { port s : ServerP;
    action reply { send Resp via s; }
    exhibit state m { entry; then idle; state idle; state busy;
      transition t1 first idle accept Req via s then busy;
      transition t2 first busy accept done do reply then idle; } }
  ${SYS}
}`, { fileName: 'i.sysml', library: 'none' });
    const conn = r.model!.all().find((e) => e.eClass === 'ConnectionUsage')!;
    expect(checkInterfacePair(r.model!, conn.id, { maxStates: 1 }).kind).toBe('undecided');
  });

  // if-automata2: composite states flattened to their leaves, and sends in entry/exit actions and several sends in one step.
  const TWO = `
  item def Ack;
  port def CP2 { out item rq : Req; in item rs : Resp; in item ak : Ack; }
  port def SP2 { in item rq : Req; out item rs : Resp; out item ak : Ack; }`;

  it('hierarchy: a transition of a composite state applies in every substate (compatible), and a substate without one is a forced reception', async () => {
    const eager = `
  part def Client { port c : ClientP;
    action ask { send Req via c; }
    exhibit state m { entry; then s0; state s0; state s1; state s2;
      transition t1 first s0 do ask then s1; transition t2 first s1 do ask then s2; } }`;
    const ok = await run(`${eager}
  part def Server { port s : ServerP;
    exhibit state m { entry; then up; state up { entry; then a; state a; state b; transition t first a accept ping then b; }
      transition outer first up accept Req via s then up; } }
  ${SYS}`);
    expect(ok.out.kind).toBe('compatible');
    const bad = await run(`${eager}
  part def Server { port s : ServerP;
    exhibit state m { entry; then up; state up { entry; then a; state a; state b;
      transition t first a accept Req via s then b; } } }
  ${SYS}`);
    expect(bad.out.kind).toBe('incompatible');
    if (bad.out.kind !== 'incompatible') return;
    expect(bad.out.findings[0]).toMatchObject({ kind: 'unspecified-reception', sender: 'A', forced: true });
    expect(bad.out.findings[0].witness.at(-1)!.b).toBe('b'); // the leaf the composite's step left the server in
  });

  it('hierarchy: a completion of a composite and clashing priorities stay no-verdict', async () => {
    const server = (body: string) => `
  part def Server { port s : ServerP; exhibit state m { entry; then up; ${body} } }
  ${SYS}`;
    const nested = await run(`${CLIENT} ${server(`state up { entry; then a; state a; state b; transition t first a accept Req via s then b; }
      transition done first up then up;`)}`);
    expect(nested.out.kind).toBe('no-verdict');
    if (nested.out.kind === 'no-verdict') expect(nested.out.reason).toContain('completion transition of a composite');
    const clash = await run(`${CLIENT} ${server(`state up { entry; then a; state a; state b; transition t first a accept Req via s then b; }
      transition o first up accept Req via s then up;`)}`);
    expect(clash.out.kind).toBe('no-verdict');
    if (clash.out.kind === 'no-verdict') expect(clash.out.reason).toContain('priority');
  });

  it('an entry action that sends: the receiver must be ready in the state the sender then is in (compatible / forced reception)', async () => {
    const server = `
  part def Server { port s : ServerP;
    exhibit state m { entry; then idle; state idle; state busy { entry action r { send Resp via s; } }
      transition t1 first idle accept Req via s then busy; transition t2 first busy accept done then idle; } }
  ${SYS}`;
    const ok = await run(`${CLIENT} ${server}`);
    expect(ok.out.kind).toBe('compatible');
    const eager = `
  part def Client { port c : ClientP;
    action ask { send Req via c; }
    exhibit state m { entry; then idle; state idle; state wait;
      transition t1 first idle do ask then wait; transition t2 first wait accept other then idle; } }`;
    const bad = await run(`${eager} ${server}`);
    expect(bad.out.kind).toBe('incompatible');
    if (bad.out.kind !== 'incompatible') return;
    const f = bad.out.findings.find((x) => x.kind === 'unspecified-reception')!;
    expect(f).toMatchObject({ item: 'rs', sender: 'B', forced: true });
    expect(f.witness.at(-1)!.label).toContain('B: send rs via s; A: no transition accepting rs');
  });

  it('an exit action and an effect that send, in order: the first output meets a receiver that cannot take it', async () => {
    const server = (body: string) => `${TWO}
  part def Server { port s : SP2;
    action reply { send Ack via s; send Resp via s; }
    exhibit state m { entry; then idle; state idle { exit action bye { send Ack via s; } } state busy;
      transition t1 first idle accept Req via s do reply then busy; ${body} } }`;
    const client = (acc: string) => `
  part def Client { port c : CP2;
    action ask { send Req via c; }
    exhibit state m { entry; then idle; state idle; state w1; state w2; state w3; state fin;
      transition t1 first idle do ask then w1; ${acc} } }`;
    const sys = `part sys { part cl : Client; part sv : Server; connect cl.c to sv.s; }`;
    // exit Ack, effect Ack, effect Resp: three outputs in order
    const ok = await run(`${client('transition a1 first w1 accept Ack via c then w2; transition a2 first w2 accept Ack via c then w3; transition a3 first w3 accept Resp via c then fin;')}
  ${server('')} ${sys}`);
    expect(ok.out.kind).toBe('compatible');
    const bad = await run(`${client('transition a1 first w1 accept Ack via c then w2; transition a3 first w2 accept Resp via c then fin;')}
  ${server('')} ${sys}`);
    expect(bad.out.kind).toBe('incompatible');
    if (bad.out.kind === 'incompatible') {
      expect(bad.out.findings.some((f) => f.kind === 'unspecified-reception' && f.item === 'ak' && f.sender === 'B' && f.forced === true)).toBe(true);
    }
  });

  it('a send in a do action stays no-verdict', async () => {
    const { out } = await run(`${CLIENT}
  part def Server { port s : ServerP;
    exhibit state m { entry; then idle; state idle; state busy { do action r { send Resp via s; } }
      transition t1 first idle accept Req via s then busy; } }
  ${SYS}`);
    expect(out.kind).toBe('no-verdict');
    if (out.kind === 'no-verdict') expect(out.reason).toContain('do action');
  });
});
