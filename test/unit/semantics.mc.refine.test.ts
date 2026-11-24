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
