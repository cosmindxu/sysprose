/**
 * The Simulation Play path (SimulationSession, what the app's Play/Step drives) for a machine whose entry start
 * is not read: it must say why it did not start, in the words of `runStateMachine`'s `Not started: …`, instead of
 * opening on an empty configuration with no sentence, or resting at a composite with no substate.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { SimulationSession, runStateMachine } from '@semantics/index';
import { initialConfig } from '../../src/semantics/mc/config';

const load = async (src: string) => {
  const { model } = await loadModelText(src);
  const m = model!.all().find((el) => model!.qualifiedName(el.id) === 'P::M')!;
  return { model: model!, m };
};

// The entry succession leads into an action, not a state: the start is not read.
const TOP = `package P { state def M {
  entry; then q; action q; state a; transition tz first a accept zz then a; state c; } }`;
// The outer start is read (b); b is a composite whose own entry action names two successors.
const NESTED = `package P { state def M {
  entry; then a; state a; state b { entry; then x; entry; then y; state x; state y; }
  transition go first a accept g then b; } }`;
// A well-formed machine: nothing changes.
const FINE = `package P { state def M {
  entry; then a; state a; state b { entry; then x; state x; state y; }
  transition go first a accept g then b; } }`;

describe('Simulation Play path: a start that is not read says so', () => {
  it('top-level unread entry: no active state and a sentence, on sample 0 and after a step', async () => {
    const { model, m } = await load(TOP);
    // What the app's start built before: an empty configuration (the explorer's own refusal lives elsewhere).
    expect(initialConfig(model, m.id).config.stack).toEqual([]);
    const s = new SimulationSession(model, m.id);
    expect(s.trace[0].activeStates).toEqual([]);
    expect(s.trace[0].unopened).toContain('does not start');
    expect(s.trace[0].unopened).toBe(runStateMachine(model, m.id, []).unopened);
    const next = s.inject('zz');
    expect(next.activeStates).toEqual([]);
    expect(next.unopened).toContain('does not start');
  });

  it('composite entered mid-run with an unread entry: refused up front, the composite named', async () => {
    const { model, m } = await load(NESTED);
    const run = runStateMachine(model, m.id, ['g']);
    expect(run.visited).toEqual([]);
    expect(run.complete).toBe(false);
    expect(run.unopened).toContain('P::M::b');
    expect(run.unopened).toContain('no substate');
    const s = new SimulationSession(model, m.id);
    expect(s.trace[0].unopened).toContain('P::M::b');
    expect(s.inject('g').activeStateNames).toEqual([]);
  });

  it('a machine whose starts are read still starts, with no sentence', async () => {
    const { model, m } = await load(FINE);
    const s = new SimulationSession(model, m.id);
    expect(s.trace[0].unopened).toBeUndefined();
    expect(s.trace[0].activeStateNames).toEqual(['a']);
    expect(s.inject('g').activeStateNames).toEqual(['x']);
  });
});
