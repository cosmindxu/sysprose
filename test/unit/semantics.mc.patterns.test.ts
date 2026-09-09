/**
 * `check-behaviour` — what a safety pattern may claim, and the four ways this
 * engine refuses to claim it (plan §3.8).
 *
 * THE MACHINE THE TRUTH IS KNOWN ON. `buildChain` is a straight line —
 * `A -a→ B -b→ C -c→ D` — plus an orphan `E` nothing reaches. Every pattern ×
 * scope answer over it is decidable by reading four state names in order, which
 * is the point: a corpus whose expected verdicts need a model checker to work
 * out cannot catch a model checker that is wrong. The two cases that look
 * identical and are not — `between B and E` (vacuous, because no segment ever
 * closes) and `after B until E` (fail, because a weak until needs no closing) —
 * are the pair that pins Dwyer's two readings apart.
 *
 * THE FOUR REFUSALS, each with a positive control beside it so none of them can
 * pass by refusing everything:
 *
 *  - a LIVENESS pattern is `inconclusive`, never `pass`, on a graph with no bad
 *    prefix in it at all — which is every graph, for `existence` and `response`;
 *  - a bound hit is `inconclusive`, never `pass`, and a violation found under
 *    the same bound is still a `fail`;
 *  - an unsupported construct is `inconclusive` and the machine is not walked;
 *  - a vacuous property is `vacuous` ⇒ exit 2, with the flag and without it, and
 *    `--strict-vacuity` moves the CODE and not the exit status.
 *
 * AND THE SEMANTIC PROFILE, pinned field by field against the interpreter it
 * describes. `semantics.mc.reach.test.ts` pins that each field cites a symbol
 * that exists; this pins that each field's SENTENCE is true of a run — a
 * provenance that compiles is not the same as a reading that holds, and the
 * profile is printed under every verdict this command reaches.
 */
import { describe, it, expect } from 'vitest';
import { Model, ModelFactory, type ElementId } from '@core/index';
import { runStateMachine } from '@semantics/index';
import { loadModelText } from '@text/load';
import { serializeModel } from '@text/serializer';
import { MALFORMED_PROPERTY_CODE, UNKNOWN_ATOM_CODE } from '../../src/semantics/mc/atoms';
import {
  PATTERNS,
  SCOPES,
  behaviourReport,
  checkProperty,
  parsePropertyText,
  propertiesOf,
  type PropertyText,
} from '../../src/semantics/mc/patterns';
import {
  BEHAVIOUR_UNSUPPORTED_CODE,
  BOUND_EXHAUSTED_CODE,
  GUARD_UNDETERMINED_CODE,
  exploreMachine,
  machineAlphabet,
  stateMachinesIn,
} from '../../src/semantics/mc/explore';
import { MAX_COMPLETION } from '../../src/semantics/mc/config';
import { SEMANTIC_PROFILE } from '../../src/semantics/mc/profile';

/** `A -a→ B -b→ C -c→ D`, and an orphan `E` no run reaches. */
function buildChain(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Chain');
  const a = f.state('A', sm.id);
  const b = f.state('B', sm.id);
  const c = f.state('C', sm.id);
  const d = f.state('D', sm.id);
  f.state('E', sm.id);
  f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'a' });
  f.transition(b.id, c.id, { ownerId: sm.id, trigger: 'b' });
  f.transition(c.id, d.id, { ownerId: sm.id, trigger: 'c' });
  return { model: m, machineId: sm.id };
}

/** A property as a caller writes one, with the two provenance fields filled in. */
function prop(fields: Partial<PropertyText> & { pattern: string; scope: string }): PropertyText {
  return { source: 'flag', carrier: null, ...fields };
}

describe('each safety pattern × scope, on a machine whose truth is known', () => {
  const { model, machineId } = buildChain();
  const claim = (fields: Partial<PropertyText> & { pattern: string; scope: string }) =>
    checkProperty(model, machineId, prop(fields)).claim;

  /**
   * EVERY SAFETY PATTERN × EVERY SCOPE, with the expected claim written out by
   * hand from the four state names.
   *
   * The cases below take the interesting cells one at a time and say WHY each
   * answer is what it is; this table says that no cell is missing. It was added
   * after a review found three defects living in cells nothing exercised — the
   * per-segment `count`/`sSeen` resets and the `pending` establishment were
   * reached through `absence` alone, so a `between` that mis-opened and a
   * `bounded-existence` that counted the wrong thing both survived a green run.
   * One `pass` and one `fail` per cell, because a pattern that answered `fail`
   * everywhere would satisfy a table of passes and vice versa.
   */
  it('answers every safety pattern over every scope, both ways', () => {
    const cells: Array<
      [string, string, Partial<PropertyText> & Record<string, string>, 'pass' | 'fail']
    > = [
      // `absence` — P never holds in the segment.
      ['absence', 'globally', { p: 'state E' }, 'pass'],
      ['absence', 'globally', { p: 'state D' }, 'fail'],
      ['absence', 'before', { p: 'state D', r: 'state C' }, 'pass'],
      ['absence', 'before', { p: 'state B', r: 'state C' }, 'fail'],
      ['absence', 'after', { p: 'state A', q: 'state B' }, 'pass'],
      ['absence', 'after', { p: 'state D', q: 'state B' }, 'fail'],
      ['absence', 'between', { p: 'state A', q: 'state B', r: 'state D' }, 'pass'],
      ['absence', 'between', { p: 'state C', q: 'state B', r: 'state D' }, 'fail'],
      ['absence', 'after-until', { p: 'state A', q: 'state B', r: 'state D' }, 'pass'],
      ['absence', 'after-until', { p: 'state C', q: 'state B', r: 'state D' }, 'fail'],
      // `universality` — P holds at EVERY observation of the segment. The
      // passing globally/before cells use an expression true everywhere,
      // because no state name on a chain holds at two observations.
      ['universality', 'globally', { p: '1 == 1' }, 'pass'],
      ['universality', 'globally', { p: 'state A' }, 'fail'],
      ['universality', 'before', { p: '1 == 1', r: 'state C' }, 'pass'],
      ['universality', 'before', { p: 'state A', r: 'state C' }, 'fail'],
      ['universality', 'after', { p: 'state D', q: 'state D' }, 'pass'],
      ['universality', 'after', { p: 'state B', q: 'state B' }, 'fail'],
      // `between C and D` is the one-observation segment {C}: the D closes the
      // segment before the pattern is tested there.
      ['universality', 'between', { p: 'state C', q: 'state C', r: 'state D' }, 'pass'],
      ['universality', 'between', { p: 'state B', q: 'state B', r: 'state D' }, 'fail'],
      ['universality', 'after-until', { p: 'state C', q: 'state C', r: 'state D' }, 'pass'],
      ['universality', 'after-until', { p: 'state B', q: 'state B', r: 'state D' }, 'fail'],
      // `bounded-existence` — the same segment, one occurrence, n on either
      // side of it.
      ['bounded-existence', 'globally', { p: 'state B', n: '1' }, 'pass'],
      ['bounded-existence', 'globally', { p: 'state B', n: '0' }, 'fail'],
      ['bounded-existence', 'before', { p: 'state B', r: 'state C', n: '1' }, 'pass'],
      ['bounded-existence', 'before', { p: 'state B', r: 'state C', n: '0' }, 'fail'],
      ['bounded-existence', 'after', { p: 'state D', q: 'state B', n: '1' }, 'pass'],
      ['bounded-existence', 'after', { p: 'state D', q: 'state B', n: '0' }, 'fail'],
      ['bounded-existence', 'between', { p: 'state C', q: 'state B', r: 'state D', n: '1' }, 'pass'],
      ['bounded-existence', 'between', { p: 'state C', q: 'state B', r: 'state D', n: '0' }, 'fail'],
      ['bounded-existence', 'after-until', { p: 'state C', q: 'state B', r: 'state D', n: '1' }, 'pass'],
      ['bounded-existence', 'after-until', { p: 'state C', q: 'state B', r: 'state D', n: '0' }, 'fail'],
      // `precedence` — S before P, inside the segment. The failing `between`
      // and `after-until` cells use the orphan `E` as an S that never holds.
      ['precedence', 'globally', { p: 'state D', s: 'state B' }, 'pass'],
      ['precedence', 'globally', { p: 'state B', s: 'state D' }, 'fail'],
      ['precedence', 'before', { p: 'state B', s: 'state A', r: 'state C' }, 'pass'],
      ['precedence', 'before', { p: 'state B', s: 'state C', r: 'state C' }, 'fail'],
      ['precedence', 'after', { p: 'state D', s: 'state C', q: 'state B' }, 'pass'],
      ['precedence', 'after', { p: 'state C', s: 'state D', q: 'state B' }, 'fail'],
      ['precedence', 'between', { p: 'state C', s: 'state B', q: 'state B', r: 'state D' }, 'pass'],
      ['precedence', 'between', { p: 'state C', s: 'state E', q: 'state B', r: 'state D' }, 'fail'],
      ['precedence', 'after-until', { p: 'state C', s: 'state B', q: 'state B', r: 'state D' }, 'pass'],
      ['precedence', 'after-until', { p: 'state C', s: 'state E', q: 'state B', r: 'state D' }, 'fail'],
    ];
    // Every safety cell is present: a pattern or a scope cannot be added to the
    // catalogue and left with no row here.
    const covered = new Set(cells.map(([pattern, scope]) => `${pattern}/${scope}`));
    for (const pattern of PATTERNS.filter((x) => x.kind === 'safety')) {
      for (const scope of SCOPES) {
        expect(covered, `${pattern.name} × ${scope.name} has no case`).toContain(
          `${pattern.name}/${scope.name}`,
        );
      }
    }
    for (const [pattern, scope, fields, expected] of cells) {
      expect(claim({ pattern, scope, ...fields }), `${pattern} × ${scope} ${JSON.stringify(fields)}`).toBe(
        expected,
      );
    }
  });

  it('opens no `between` or `after … until` segment where the CLOSING atom holds too', () => {
    // DWYER'S `Q & !R` CONJUNCT. `between` is `[]((Q & !R & <>R) -> (!P U R))`
    // and `after … until` is `[]((Q & !R) -> (!P W R))`: an observation where
    // the opening and closing atoms hold TOGETHER opens nothing, because there
    // is nothing between a Q and an R that are the same observation. It is not
    // a corner case in a model — a composite state and the substate its entry
    // cascades into hold together at every observation, and so do a trigger and
    // the state it lands in, which is the shape below.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Cycle');
    const start = f.state('Start', sm.id);
    const safe = f.state('Safe', sm.id);
    const fire = f.state('Fire', sm.id);
    f.transition(start.id, safe.id, { ownerId: sm.id, trigger: 'go' });
    f.transition(safe.id, fire.id, { ownerId: sm.id, trigger: 'x' });
    f.transition(fire.id, safe.id, { ownerId: sm.id, trigger: 'arm' });
    for (const scope of ['between', 'after-until'] as const) {
      // `trigger arm` holds only at an observation whose leaf is `Safe`, so Q
      // never holds without R. Under the conjunct the property opens on
      // nothing and is VACUOUS; without it the engine opened a segment, ran
      // into `Fire`, and printed a `fail` with a witness whose own `holds`
      // column showed q and r together at the opening observation.
      const v = checkProperty(
        m,
        sm.id,
        prop({ pattern: 'absence', scope, p: 'state Fire', q: 'trigger arm', r: 'state Safe' }),
      );
      expect(v.claim, `${scope} must not open where R holds`).toBe('vacuous');
      expect(v.witness).toEqual([]);
      // The positive control, one atom apart: a Q that does NOT coincide with
      // the R opens the segment and the same machine is decided.
      expect(
        checkProperty(
          m,
          sm.id,
          prop({ pattern: 'absence', scope, p: 'state Fire', q: 'state Start', r: 'state Safe' }),
        ).claim,
      ).toBe('pass');
      expect(
        checkProperty(
          m,
          sm.id,
          prop({ pattern: 'absence', scope, p: 'state Safe', q: 'state Start', r: 'state Fire' }),
        ).claim,
      ).toBe('fail');
    }
  });

  it('decides `absence` over all five scopes', () => {
    // globally: `D` is entered on the one run this machine has; `E` is not.
    expect(claim({ pattern: 'absence', scope: 'globally', p: 'state D' })).toBe('fail');
    expect(claim({ pattern: 'absence', scope: 'globally', p: 'state E' })).toBe('pass');
    // before C: `B` is entered before it and `D` after it. The C observation
    // itself closes the scope, so a P there would not count — `!P U R` asks for
    // P false STRICTLY before the first R.
    expect(claim({ pattern: 'absence', scope: 'before', p: 'state B', r: 'state C' })).toBe('fail');
    expect(claim({ pattern: 'absence', scope: 'before', p: 'state D', r: 'state C' })).toBe('pass');
    // after B: the scope is inclusive of the Q observation, so `B` itself is in it.
    expect(claim({ pattern: 'absence', scope: 'after', p: 'state D', q: 'state B' })).toBe('fail');
    expect(claim({ pattern: 'absence', scope: 'after', p: 'state A', q: 'state B' })).toBe('pass');
    // between B and D: `C` sits inside that segment, `A` before it.
    expect(
      claim({ pattern: 'absence', scope: 'between', p: 'state C', q: 'state B', r: 'state D' }),
    ).toBe('fail');
    expect(
      claim({ pattern: 'absence', scope: 'between', p: 'state A', q: 'state B', r: 'state D' }),
    ).toBe('pass');
    // after B until D: the same two, and the same answers — the scopes differ
    // only on a run whose closing atom never arrives (the case below).
    expect(
      claim({ pattern: 'absence', scope: 'after-until', p: 'state C', q: 'state B', r: 'state D' }),
    ).toBe('fail');
    expect(
      claim({ pattern: 'absence', scope: 'after-until', p: 'state A', q: 'state B', r: 'state D' }),
    ).toBe('pass');
  });

  it('splits `between` from `after … until` on a segment that never closes', () => {
    // THE PAIR THAT PINS DWYER'S TWO READINGS APART, and the reason `between`
    // carries a `pending` state at all. `E` is reached by no run, so the segment
    // opened at `B` never closes. `between Q and R` speaks only about segments
    // that CLOSE — `[]((Q & !R & <>R) -> (!P U R))` — so there is nothing it
    // says here and the answer is vacuous. `after Q until R` is a WEAK until,
    // so the same trace is a violation.
    const between = checkProperty(
      model,
      machineId,
      prop({ pattern: 'absence', scope: 'between', p: 'state C', q: 'state B', r: 'state E' }),
    );
    const until = checkProperty(
      model,
      machineId,
      prop({ pattern: 'absence', scope: 'after-until', p: 'state C', q: 'state B', r: 'state E' }),
    );
    expect(between.claim).toBe('vacuous');
    expect(until.claim).toBe('fail');
    expect(until.witness.map((w) => w.leaf?.name)).toEqual(['A', 'B', 'C']);
  });

  it('reads `before R` as EMPTY when the opening configuration is the R', () => {
    // `<>R -> (!P U R)` is satisfied at position 0 when R holds there, and it
    // is satisfied NON-vacuously — the antecedent `<>R` held. So the answer is
    // a pass over an empty segment, not a vacuity, and certainly not a
    // violation from checking P after the R that ended the scope.
    const v = checkProperty(
      model,
      machineId,
      prop({ pattern: 'absence', scope: 'before', p: 'state B', r: 'state A' }),
    );
    expect(v.claim).toBe('pass');
    expect(v.activated).toBe(true);
  });

  it('decides `universality`, and reads a configuration nobody left as a violation', () => {
    // After D — the last configuration — `D` holds everywhere, and after B it
    // does not.
    expect(claim({ pattern: 'universality', scope: 'after', p: 'state D', q: 'state D' })).toBe(
      'pass',
    );
    expect(claim({ pattern: 'universality', scope: 'after', p: 'state D', q: 'state B' })).toBe(
      'fail',
    );
    expect(claim({ pattern: 'universality', scope: 'globally', p: 'state A' })).toBe('fail');
  });

  it('decides `bounded-existence`, and counts occurrences rather than states', () => {
    expect(claim({ pattern: 'bounded-existence', scope: 'globally', p: 'state B', n: '1' })).toBe(
      'pass',
    );
    expect(claim({ pattern: 'bounded-existence', scope: 'globally', p: 'state B', n: '0' })).toBe(
      'fail',
    );
    // The witness stops at the occurrence that breaks the bound, not at the end
    // of the run: a bad prefix is a prefix.
    const over = checkProperty(
      model,
      machineId,
      prop({ pattern: 'bounded-existence', scope: 'globally', p: 'state B', n: '0' }),
    );
    expect(over.witness.map((w) => w.leaf?.name)).toEqual(['A', 'B']);
  });

  it('counts an occurrence of P once, however many configurations it spans', () => {
    // OCCURRENCES, NOT CONFIGURATIONS, and on this machine the two numbers
    // differ. `Busy` is composite, so entering it puts BOTH it and the substate
    // its entry cascades into on the active stack, and `state Busy` then holds
    // at every observation until the machine leaves it — which it never does.
    // Dwyer's at-most-N formula counts the maximal intervals in which P holds,
    // so a machine that enters `Busy` exactly once satisfies "at most once".
    // Counting each configuration instead refuted it, with a `verification/
    // refuted` witness whose two steps are one uninterrupted stay.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Job');
    const idle = f.state('idle', sm.id);
    const busy = f.state('Busy', sm.id);
    const s1 = f.state('s1', busy.id);
    const s2 = f.state('s2', busy.id);
    f.transition(idle.id, busy.id, { ownerId: sm.id, trigger: 'go' });
    f.transition(s1.id, s2.id, { ownerId: busy.id, trigger: 'tick' });
    const once = checkProperty(
      m,
      sm.id,
      prop({ pattern: 'bounded-existence', scope: 'globally', p: 'state Busy', n: '1' }),
    );
    expect(once.claim, '`Busy` is entered once and never left').toBe('pass');
    expect(once.witness).toEqual([]);
    // Ground truth that `Busy` really does hold at more than one observation —
    // otherwise the case above would pass for the wrong reason. `state X` reads
    // the whole active STACK, so from the first `Busy` onwards it holds
    // everywhere, and the machine never leaves it.
    expect(
      checkProperty(
        m,
        sm.id,
        prop({ pattern: 'universality', scope: 'after', p: 'state Busy', q: 'state Busy' }),
      ).claim,
    ).toBe('pass');
    expect(m.get(runStateMachine(m, sm.id, ['go', 'tick']).finalState!)?.declaredName).toBe('s2');

    // THE POSITIVE CONTROL, so "count the edges" cannot become "count nothing":
    // a P that is left and re-entered occurs twice, and `n = 1` is refuted.
    const b = new Model();
    const bf = new ModelFactory(b);
    const blink = bf.stateDef('Blink');
    const on = bf.state('on', blink.id);
    const off = bf.state('off', blink.id);
    bf.transition(on.id, off.id, { ownerId: blink.id, trigger: 'x' });
    bf.transition(off.id, on.id, { ownerId: blink.id, trigger: 'y' });
    expect(
      checkProperty(b, blink.id, prop({ pattern: 'bounded-existence', scope: 'globally', p: 'state on', n: '1' }))
        .claim,
    ).toBe('fail');
    expect(
      checkProperty(b, blink.id, prop({ pattern: 'bounded-existence', scope: 'globally', p: 'state on', n: '9' }))
        .claim,
    ).toBe('fail');
  });

  it('decides `precedence`, and allows S and P at the same observation', () => {
    expect(claim({ pattern: 'precedence', scope: 'globally', p: 'state D', s: 'state B' })).toBe(
      'pass',
    );
    expect(claim({ pattern: 'precedence', scope: 'globally', p: 'state B', s: 'state D' })).toBe(
      'fail',
    );
    // `!P U S` asks P to be false strictly before the first S, so S and P
    // holding together is not a violation — here of one state against itself.
    expect(claim({ pattern: 'precedence', scope: 'globally', p: 'state B', s: 'state B' })).toBe(
      'pass',
    );
  });

  it('reads all five atom spellings, and refuses a sixth', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Atoms');
    const idle = f.state('idle', sm.id);
    const busy = f.state('busy', sm.id);
    const t = f.transition(idle.id, busy.id, { ownerId: sm.id, trigger: 'go' });
    m.update(t.id, { declaredName: 'starting' });
    const one = (p: string) =>
      checkProperty(m, sm.id, prop({ pattern: 'absence', scope: 'globally', p })).claim;
    expect(one('state busy')).toBe('fail');
    expect(one('node busy')).toBe('fail');
    expect(one('trigger go')).toBe('fail');
    expect(one('fires starting')).toBe('fail');
    // An expression, read by the same parser the guards are read with. Nothing
    // in this machine's store is named `busy`, so the interesting expression is
    // one over a literal.
    expect(one('1 == 1')).toBe('fail');
    expect(one('1 == 2')).toBe('pass');
  });
});

describe('the three sentences this engine refuses to produce', () => {
  it('never passes a liveness pattern, on a graph with no bad prefix in it', () => {
    // `Chain` has no bad prefix for `response` — no finite prefix of any run
    // refutes "every B is followed by a D" — so a bad-prefix search finds
    // nothing, and "found nothing" must not become the strongest verdict this
    // command has.
    const { model, machineId } = buildChain();
    for (const pattern of PATTERNS.filter((p) => p.kind === 'liveness')) {
      const v = checkProperty(
        model,
        machineId,
        prop({ pattern: pattern.name, scope: 'globally', p: 'state B', s: 'state D' }),
      );
      expect(v.claim, `${pattern.name} must never pass`).toBe('inconclusive');
      // THE BEHAVIOUR LANE'S OWN CODE. `verification/unsupported-construct` is
      // the SMT lane's, and its published catalogue entry says it is one of the
      // two codes `--allow-inconclusive` may lower to exit 0 and sends the
      // reader to `obligations --missing`. Filing a liveness refusal under it
      // would print, in the catalogue a reader checks, that the one row this
      // command must never lower is lowerable.
      expect(v.code).toBe(BEHAVIOUR_UNSUPPORTED_CODE);
      expect(v.code).not.toBe('verification/unsupported-construct');
      expect(v.detail).toContain('liveness not checked in-process');
      expect(v.detail).toContain('fairness');
      expect(v.patternClass).toBe('liveness');
      // And the row says nothing about the machine at all: no walk was paid for.
      expect(v.configs).toBe(0);
      expect(v.exhaustive).toBe(false);
    }
    // The positive control: the same shape as a SAFETY pattern is decided.
    expect(
      checkProperty(
        model,
        machineId,
        prop({ pattern: 'absence', scope: 'globally', p: 'state E' }),
      ).claim,
    ).toBe('pass');
  });

  it('never passes on a partial walk, and still refutes on one', () => {
    const { model, machineId } = buildChain();
    // A bound that stops the walk before `D`: no bad prefix was found, and the
    // absence of one in part of a graph is not the absence of one.
    const bounded = checkProperty(
      model,
      machineId,
      prop({ pattern: 'absence', scope: 'globally', p: 'state D' }),
      { maxConfigs: 2 },
    );
    expect(bounded.claim).toBe('inconclusive');
    expect(bounded.code).toBe(BOUND_EXHAUSTED_CODE);
    expect(bounded.exhaustive).toBe(false);
    expect(bounded.witness).toEqual([]);
    expect(bounded.detail).toContain('not the absence of one');
    // The asymmetry: a violation INSIDE the same bound is still a violation,
    // because the witness is a run this semantics admits. A bound can hide a
    // violation and can never invent one.
    const refuted = checkProperty(
      model,
      machineId,
      prop({ pattern: 'absence', scope: 'globally', p: 'state B' }),
      { maxConfigs: 1 },
    );
    expect(refuted.claim).toBe('fail');
    expect(refuted.exhaustive).toBe(false);
    expect(refuted.witness.map((w) => w.leaf?.name)).toEqual(['A', 'B']);
    // And the unbounded run of the same question passes nothing it should not.
    expect(
      checkProperty(model, machineId, prop({ pattern: 'absence', scope: 'globally', p: 'state D' }))
        .claim,
    ).toBe('fail');
  });

  it('never walks a machine the explorer refuses, and never passes one', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Parallel');
    m.update(sm.id, { attrs: { parallel: true } });
    const r1 = f.state('R1', sm.id);
    const r2 = f.state('R2', sm.id);
    const a1 = f.state('a1', r1.id);
    const a2 = f.state('a2', r1.id);
    const b1 = f.state('b1', r2.id);
    const b2 = f.state('b2', r2.id);
    f.transition(a1.id, a2.id, { ownerId: r1.id, trigger: 'go' });
    f.transition(b1.id, b2.id, { ownerId: r2.id, trigger: 'go' });
    expect(exploreMachine(m, sm.id).unsupported.map((u) => u.construct)).toEqual([
      'parallel-regions',
    ]);
    const v = checkProperty(
      m,
      sm.id,
      prop({ pattern: 'absence', scope: 'globally', p: 'state a2' }),
    );
    expect(v.claim).toBe('inconclusive');
    expect(v.code).toBe(BEHAVIOUR_UNSUPPORTED_CODE);
    expect(v.exhaustive).toBe(false);
    expect(v.unsupported).toHaveLength(1);
    // `a2` IS entered by a run of the interpreter, so a walk that had gone ahead
    // anyway would have refuted this property. The refusal is not a shortcut
    // around a hard answer; it is a refusal to answer under semantics the
    // report says it does not implement.
    expect(runStateMachine(m, sm.id, ['go']).activeStates).toHaveLength(2);
  });
});

describe('a witness is a run this semantics admits, and never one it does not', () => {
  it('does not cross the priority rule to reach a violation', () => {
    // `inner`'s self-loop on `go` always wins over `Outer -> Sink`, so `Sink`
    // is entered by no run of this semantics at all — `reach` reports it
    // unreachable, and the interpreter never leaves `Outer`. A search that
    // branched on every enabled transition rather than on the innermost level
    // would reach `Sink` and print a "witness" the model does not admit, which
    // is the one way this command could refute a property that holds.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Beaten');
    const outer = f.state('Outer', sm.id);
    const inner = f.state('inner', outer.id);
    const sink = f.state('Sink', sm.id);
    f.transition(inner.id, inner.id, { ownerId: outer.id, trigger: 'go' });
    f.transition(outer.id, sink.id, { ownerId: sm.id, trigger: 'go' });

    // GROUND TRUTH from the interpreter: every `go` sequence up to length 6
    // stays inside `Outer`.
    for (let n = 0; n <= 6; n++) {
      const run = runStateMachine(m, sm.id, Array.from({ length: n }, () => 'go'));
      const seen = new Set(run.visited.map((v) => m.get(v)?.declaredName));
      expect([...seen].sort()).toEqual(['Outer', 'inner']);
    }
    const v = checkProperty(m, sm.id, prop({ pattern: 'absence', scope: 'globally', p: 'state Sink' }));
    expect(v.claim, 'a witness was drawn from a configuration no run enters').toBe('pass');
    expect(v.witness).toEqual([]);
    // The positive control: the state the runs DO enter is refuted.
    expect(
      checkProperty(m, sm.id, prop({ pattern: 'absence', scope: 'globally', p: 'state inner' }))
        .claim,
    ).toBe('fail');
  });
});

describe('vacuity is surfaced, and no flag launders it', () => {
  const { model, machineId } = buildChain();

  it('calls an antecedent that never holds `vacuous`, in both of its forms', () => {
    // The scope's own antecedent: `E` is reached by no run, so `after E` opens
    // on nothing.
    const scope = checkProperty(
      model,
      machineId,
      prop({ pattern: 'absence', scope: 'after', p: 'state D', q: 'state E' }),
    );
    expect(scope.claim).toBe('vacuous');
    expect(scope.activated).toBe(false);
    expect(scope.detail).toContain('antecedent');
    // And `precedence`'s own: "S holds before P ever does" is true of every
    // machine on which P never happens, and says nothing about any of them.
    const prec = checkProperty(
      model,
      machineId,
      prop({ pattern: 'precedence', scope: 'globally', p: 'state E', s: 'state B' }),
    );
    expect(prec.claim).toBe('vacuous');
    // The positive control, one atom away: with a P that DOES happen, the same
    // property is decided.
    expect(
      checkProperty(
        model,
        machineId,
        prop({ pattern: 'precedence', scope: 'globally', p: 'state C', s: 'state B' }),
      ).claim,
    ).toBe('pass');
  });

  it('never calls a bound hit `vacuous`: an antecedent not reached is not one that cannot be', () => {
    // A BOUND HIT MUST NOT MASQUERADE AS A FINDING. "No explored run opens the
    // scope" is a claim of ABSENCE, and a walk that stopped at a bound has not
    // established one — so under `--max-configs 2` the run below is
    // inconclusive, not `vacuous`. Reported as a vacuity it printed "its
    // antecedent is never met" about an antecedent the walk had simply not
    // reached yet, and `--strict-vacuity` filed that as an error against a
    // model that is fine.
    const property = prop({ pattern: 'absence', scope: 'after', p: 'state A', q: 'state D' });
    const bounded = checkProperty(model, machineId, property, { maxConfigs: 2 });
    expect(bounded.claim).not.toBe('vacuous');
    expect(bounded.claim).toBe('inconclusive');
    expect(bounded.code).toBe(BOUND_EXHAUSTED_CODE);
    expect(bounded.detail).toContain('the walk did not finish');
    // THE POSITIVE CONTROL: unbounded, the same property is decided, and `D`
    // IS reachable — so the vacuity sentence would have been false as well as
    // unearned.
    expect(checkProperty(model, machineId, property).claim).toBe('pass');
    // `precedence`'s own vacuity form, under the same bound.
    const prec = prop({ pattern: 'precedence', scope: 'globally', p: 'state D', s: 'state B' });
    expect(checkProperty(model, machineId, prec, { maxConfigs: 2 }).claim).toBe('inconclusive');
    expect(checkProperty(model, machineId, prec).claim).toBe('pass');
    // And nothing is filed against the model: not a vacuity row, and not the
    // error `--strict-vacuity` would have raised from one.
    const report = behaviourReport(model, {
      machineId,
      pattern: 'pattern=absence, scope=after, p=state A, q=state D',
      maxConfigs: 2,
      strictVacuity: true,
    });
    expect(report.counts.vacuous).toBe(0);
    expect(report.exitCode).toBe(2);
    expect(report.diagnostics.map((d) => d.code)).not.toContain('verification/vacuous-property');
    expect(report.diagnostics.map((d) => d.severity)).toEqual(['info']);
  });

  it('exits 2 on a vacuity with `--strict-vacuity` and without it, and only the CODE moves', () => {
    const pattern = 'pattern=absence, scope=after, p=state D, q=state E';
    const plain = behaviourReport(model, { machineId, pattern });
    const strict = behaviourReport(model, { machineId, pattern, strictVacuity: true });

    // BOTH SPELLINGS ASSERTED, so the flag cannot quietly acquire exit
    // semantics §2 does not give it. It changes the code and the severity and
    // nothing else.
    expect(plain.exitCode).toBe(2);
    expect(strict.exitCode).toBe(2);
    expect(plain.counts).toEqual(strict.counts);
    expect(plain.counts.vacuous).toBe(1);
    expect(plain.properties[0].claim).toBe(strict.properties[0].claim);
    expect(plain.properties[0].claim).toBe('vacuous');

    // Without the flag a vacuity is a row and not a finding — visible in the
    // report and in the exit code, and easy to scroll past. That is exactly
    // what the flag exists to change.
    expect(plain.diagnostics.map((d) => d.code)).not.toContain('verification/vacuous-property');
    const raised = strict.diagnostics.filter((d) => d.code === 'verification/vacuous-property');
    expect(raised).toHaveLength(1);
    expect(raised[0].severity).toBe('error');
    expect(strict.strictVacuity).toBe(true);
  });
});

describe('a property nobody can read is inconclusive, never absent and never false', () => {
  const { model, machineId } = buildChain();

  it('refuses a pattern name outside the catalogue, and exits 2', () => {
    const r = behaviourReport(model, {
      machineId,
      pattern: 'pattern=eventually, scope=globally, p=state D',
    });
    expect(r.properties).toHaveLength(1);
    expect(r.properties[0].claim).toBe('inconclusive');
    expect(r.properties[0].code).toBe(MALFORMED_PROPERTY_CODE);
    expect(r.properties[0].detail).toContain('not a pattern in the catalogue');
    expect(r.exitCode).toBe(2);
    // Every name it DOES hold is offered on the row, so the fix is one line.
    for (const p of PATTERNS) expect(r.properties[0].detail).toContain(p.name);
  });

  it('refuses a scope, a missing field and a `bounded-existence` with no bound', () => {
    const one = (fields: Partial<PropertyText> & { pattern: string; scope: string }) =>
      checkProperty(model, machineId, prop(fields));
    expect(one({ pattern: 'absence', scope: 'someday', p: 'state D' }).code).toBe(
      MALFORMED_PROPERTY_CODE,
    );
    for (const s of SCOPES) {
      expect(one({ pattern: 'absence', scope: 'someday', p: 'state D' }).detail).toContain(s.name);
    }
    expect(one({ pattern: 'precedence', scope: 'globally', p: 'state D' }).code).toBe(
      MALFORMED_PROPERTY_CODE,
    );
    // A bound nobody wrote is a bound nobody meant: there is no default.
    expect(one({ pattern: 'bounded-existence', scope: 'globally', p: 'state B' }).code).toBe(
      MALFORMED_PROPERTY_CODE,
    );
    expect(
      one({ pattern: 'bounded-existence', scope: 'globally', p: 'state B', n: 'two' }).code,
    ).toBe(MALFORMED_PROPERTY_CODE);
  });

  it('never fills a placeholder letter with another atom’s text', () => {
    // THE VERDICT SENTENCE IS THE VERDICT. `P`, `S`, `N`, `Q` and `R` are the
    // placeholders in a pattern's reading, and an atom's own text may contain
    // one — a state called `N`, an expression over a feature called `R`.
    // Substituting them one letter at a time re-scanned text that had just been
    // written in, so `absence of state N` was published, in the verdict line
    // and in the `verification/refuted` message, as "`state 0` never holds".
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Letters');
    const names = ['P', 'S', 'N', 'Q', 'R'];
    const st = names.map((n) => f.state(n, sm.id));
    for (let i = 0; i + 1 < st.length; i++) {
      f.transition(st[i].id, st[i + 1].id, { ownerId: sm.id, trigger: `t${i}` });
    }
    const one = (fields: Partial<PropertyText> & { pattern: string; scope: string }) =>
      checkProperty(m, sm.id, prop(fields)).sentence;
    expect(one({ pattern: 'absence', scope: 'globally', p: 'state N' })).toBe(
      '`state N` never holds, over the whole run',
    );
    expect(one({ pattern: 'precedence', scope: 'globally', p: 'state S', s: 'state P' })).toBe(
      '`state P` holds before `state S` ever does, over the whole run',
    );
    expect(
      one({ pattern: 'absence', scope: 'between', p: 'state N', q: 'state R', r: 'state Q' }),
    ).toBe('`state N` never holds, between each `state R` and the next `state Q`');
    // The count still fills `N`, which is the substitution the letters collide
    // with: it is written from `n` and never from an atom.
    expect(
      one({ pattern: 'bounded-existence', scope: 'globally', p: 'state N', n: '2' }),
    ).toBe('`state N` holds at most 2 time(s), over the whole run');
  });

  it('never reads an unresolvable atom as `false`', () => {
    // THE FAILURE THIS RULE EXISTS AGAINST: `absence of state failsafe` passing
    // the moment somebody misspells `failsafe`. The property here is true of
    // the machine if the atom is read as false, and it must not be.
    const v = checkProperty(
      model,
      machineId,
      prop({ pattern: 'absence', scope: 'globally', p: 'state Dd' }),
    );
    expect(v.claim).not.toBe('pass');
    expect(v.claim).toBe('inconclusive');
    expect(v.code).toBe(UNKNOWN_ATOM_CODE);
    // AND THE ROW SAYS IT CHECKED NOTHING: a property refused before a walk is
    // paid for must never publish `exhaustive`.
    expect(v.exhaustive).toBe(false);
    expect(v.qualification).toContain('nothing was checked');
    // The row lists what the machine does offer.
    for (const name of ['A', 'B', 'C', 'D', 'E']) expect(v.detail).toContain(`\`${name}\``);
    // A trigger the machine never names, and a transition with no such name.
    expect(
      checkProperty(model, machineId, prop({ pattern: 'absence', scope: 'globally', p: 'trigger z' }))
        .code,
    ).toBe(UNKNOWN_ATOM_CODE);
    expect(
      checkProperty(model, machineId, prop({ pattern: 'absence', scope: 'globally', p: 'fires t' }))
        .code,
    ).toBe(UNKNOWN_ATOM_CODE);
    // And an expression reading a name nothing in scope offers — which is an
    // unknown atom rather than a malformed property, because the CLAUSE is
    // well-formed and the NAME is not there.
    const late = checkProperty(
      model,
      machineId,
      prop({ pattern: 'absence', scope: 'globally', p: 'nothingHere == 3' }),
    );
    expect(late.code).toBe(UNKNOWN_ATOM_CODE);
    // An expression that parses and is not a predicate is the other refusal.
    const notAPredicate = checkProperty(
      model,
      machineId,
      prop({ pattern: 'absence', scope: 'globally', p: '1 + 1' }),
    );
    expect(notAPredicate.code).toBe(MALFORMED_PROPERTY_CODE);
    // BOTH OF THOSE ARE REFUSED MID-WALK, where the atom was offered — and the
    // walk that stopped there decided nothing, so neither row may publish
    // `exhaustive` beside a count that is not the graph's size.
    for (const row of [late, notAPredicate]) {
      expect(row.claim).toBe('inconclusive');
      expect(row.exhaustive).toBe(false);
      expect(row.qualification).toContain('nothing was decided');
    }
  });

  it('refuses a `node N` naming something that can never be a leaf', () => {
    // A machine holds attributes and actions as well as states, and none of
    // them is ever the active leaf. Resolving one would give an atom that holds
    // NOWHERE — and `absence of node speed` would then pass on every machine
    // that declares a `speed`, which is the false-confidence direction this
    // whole module is written against.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('WithData');
    const idle = f.state('idle', sm.id);
    const busy = f.state('busy', sm.id);
    f.transition(idle.id, busy.id, { ownerId: sm.id, trigger: 'go' });
    m.create('AttributeUsage', { declaredName: 'speed', ownerId: sm.id, attrs: { value: '3' } });
    const v = checkProperty(m, sm.id, prop({ pattern: 'absence', scope: 'globally', p: 'node speed' }));
    expect(v.claim).not.toBe('pass');
    expect(v.code).toBe(UNKNOWN_ATOM_CODE);
    // The states it CAN name still resolve, and still decide.
    expect(
      checkProperty(m, sm.id, prop({ pattern: 'absence', scope: 'globally', p: 'node busy' })).claim,
    ).toBe('fail');
  });

  it('refuses an ambiguous name rather than resolving it', () => {
    // §3.0's rule for every `REF` this lane takes, applied to an atom: two
    // states with one declared name in different regions, and a property that
    // picked the first would be a claim a reader cannot check.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Twice');
    const outer = f.state('Outer', sm.id);
    const other = f.state('Other', sm.id);
    f.state('idle', outer.id);
    f.state('idle', other.id);
    f.transition(outer.id, other.id, { ownerId: sm.id, trigger: 'go' });
    const v = checkProperty(m, sm.id, prop({ pattern: 'absence', scope: 'globally', p: 'state idle' }));
    expect(v.code).toBe(UNKNOWN_ATOM_CODE);
    expect(v.detail).toContain('names 2 elements');
    expect(v.claim).toBe('inconclusive');
    // The qualified name resolves, which is what the refusal tells the reader.
    expect(
      checkProperty(
        m,
        sm.id,
        prop({ pattern: 'absence', scope: 'globally', p: 'state Twice::Outer::idle' }),
      ).claim,
    ).toBe('fail');
  });

  it('never drops a `--pattern` that was given, however empty its value', () => {
    // A CI LINE WHOSE SHELL VARIABLE EXPANDED TO NOTHING. Dropped, the run
    // reported on the carriers alone and looked like a clean sweep — the exact
    // silence the flag's own refusal path exists to prevent. `parsePropertyText`
    // already has the right words for it, so it lands as a refused row like any
    // other unreadable spelling.
    for (const given of ['', '   ', ',', ' ; ']) {
      const r = behaviourReport(model, { machineId, pattern: given });
      expect(r.properties, `\`--pattern ${JSON.stringify(given)}\` was dropped`).toHaveLength(1);
      expect(r.properties[0].claim).toBe('inconclusive');
      expect(r.properties[0].code).toBe(MALFORMED_PROPERTY_CODE);
      expect(r.properties[0].detail).toContain('no fields at all');
      expect(r.properties[0].property.source).toBe('flag');
      expect(r.exitCode).toBe(2);
    }
    // And the flag not given at all is still the flag not given: this machine
    // states no property, so there is nothing to decide.
    expect(behaviourReport(model, { machineId }).properties).toEqual([]);
  });

  it('reads the `--pattern` field grammar, and says what is wrong with a bad one', () => {
    expect(parsePropertyText('pattern=absence, scope=globally, p=state D')).toEqual({
      ok: true,
      text: {
        pattern: 'absence',
        scope: 'globally',
        p: 'state D',
        source: 'flag',
        carrier: null,
      },
    });
    // `;` separates too, and the first `=` splits: an expression atom holding
    // `==` keeps it.
    const expr = parsePropertyText('pattern=absence; scope=globally; p=mode == 3');
    expect(expr.ok && expr.text.p).toBe('mode == 3');
    for (const bad of ['absence', 'pattern=absence, nope=1', 'pattern=a, pattern=b', '']) {
      const r = parsePropertyText(bad);
      expect(r.ok, `\`${bad}\` should not parse`).toBe(false);
    }
    // Scope defaults to `globally` — the only field that has a default, because
    // a property with no scope is a property about the whole run.
    const bare = parsePropertyText('pattern=absence, p=state D');
    expect(bare.ok && bare.text.scope).toBe('globally');
  });
});

describe('a property in the file, and a run with nothing to decide', () => {
  const SRC = `package Modes {
    state def FlightModes {
        @SysproseVerification::PropertyPattern {
            attribute pattern = "absence";
            attribute scope = "globally";
            attribute p = "state failsafe";
        }
        state standby;
        state manual;
        state failsafe;
        transition standby -> manual;
        transition manual -> standby;
    }
}
`;

  it('reads a `@PropertyPattern` carrier, and round-trips it idempotently from the second save', async () => {
    const first = await loadModelText(SRC, { fileName: 'p.sysml', library: 'none' });
    expect(first.report.diagnostics).toEqual([]);
    const machines = stateMachinesIn(first.model!);
    expect(machines.map((m) => m.declaredName)).toEqual(['FlightModes']);
    expect(propertiesOf(first.model!, machines[0].id)).toEqual([
      {
        pattern: 'absence',
        scope: 'globally',
        p: 'state failsafe',
        source: 'model',
        carrier: 'Modes::FlightModes',
      },
    ]);

    // IDEMPOTENT FROM THE SECOND SAVE, which is what this plan asserts
    // everywhere and is not the same as byte-identical from arbitrary input:
    // the first save canonicalises `transition a -> b` to `transition first a
    // then b`, and nothing after it moves.
    const once = serializeModel(first.model!);
    const second = await loadModelText(once, { fileName: 'p.sysml', library: 'none' });
    expect(serializeModel(second.model!)).toBe(once);
    expect(once).toContain('@SysproseVerification::PropertyPattern');
    expect(once).toContain('attribute p = "state failsafe";');
    // And the carrier still reads as the same property after the round trip.
    const reloaded = stateMachinesIn(second.model!)[0];
    expect(propertiesOf(second.model!, reloaded.id)[0].p).toBe('state failsafe');

    // The verdict it produces: `failsafe` is declared and nothing reaches it.
    const r = behaviourReport(first.model!, { machineId: machines[0].id });
    expect(r.properties.map((p) => p.claim)).toEqual(['pass']);
    expect(r.exitCode).toBe(0);
    expect(r.properties[0].property.source).toBe('model');
  });

  it('refuses a carrier attribute that is not a property field, rather than skipping it', async () => {
    // `scope` IS THE ONE FIELD WITH A DEFAULT, which is what turns a dropped
    // cell into a different property. Read without the misspelled `scpoe` this
    // carrier says `absence of state manual, over the whole run` — which this
    // machine refutes, with a witness, exiting 1 on a claim nobody made. The
    // `--pattern` grammar refuses an unknown key; the carrier now does too.
    const src = SRC.replace('attribute scope = "globally";', 'attribute scpoe = "after";').replace(
      'attribute p = "state failsafe";',
      'attribute p = "state manual";\n            attribute q = "state failsafe";',
    );
    const loaded = await loadModelText(src, { fileName: 'p.sysml', library: 'none' });
    expect(loaded.report.diagnostics).toEqual([]);
    const machineId = stateMachinesIn(loaded.model!)[0].id;
    expect(propertiesOf(loaded.model!, machineId)[0].unknownFields).toEqual(['scpoe']);
    const r = behaviourReport(loaded.model!, { machineId });
    expect(r.properties[0].claim).not.toBe('fail');
    expect(r.properties[0].claim).toBe('inconclusive');
    expect(r.properties[0].code).toBe(MALFORMED_PROPERTY_CODE);
    expect(r.properties[0].detail).toContain('`scpoe`');
    expect(r.exitCode).toBe(2);
    // The positive control: spelled correctly, the same carrier is decided.
    const fixed = await loadModelText(src.replace('scpoe', 'scope'), {
      fileName: 'p.sysml',
      library: 'none',
    });
    const fixedId = stateMachinesIn(fixed.model!)[0].id;
    expect(propertiesOf(fixed.model!, fixedId)[0].unknownFields).toBeUndefined();
    expect(behaviourReport(fixed.model!, { machineId: fixedId }).properties[0].claim).toBe(
      'vacuous',
    );
  });

  it('answers a `response` CARRIER inconclusive on a graph with no bad prefix in it', async () => {
    // The same refusal as the flag path, through the door a model actually
    // uses. `standby` and `manual` alternate forever here, so no finite prefix
    // refutes "every standby is followed by a failsafe" — which is exactly the
    // shape where a bad-prefix search finds nothing and a naive engine would
    // call it a pass.
    const src = SRC.replace('"absence"', '"response"').replace(
      'attribute p = "state failsafe";',
      'attribute p = "state standby";\n            attribute s = "state failsafe";',
    );
    const loaded = await loadModelText(src, { fileName: 'p.sysml', library: 'none' });
    expect(loaded.report.diagnostics).toEqual([]);
    const machineId = stateMachinesIn(loaded.model!)[0].id;
    const r = behaviourReport(loaded.model!, { machineId });
    expect(r.properties).toHaveLength(1);
    expect(r.properties[0].property.source).toBe('model');
    expect(r.properties[0].claim, 'a liveness carrier must never pass').toBe('inconclusive');
    expect(r.properties[0].detail).toContain('liveness not checked in-process');
    expect(r.exitCode).toBe(2);
  });

  it('exits 2 on a machine that states no property at all', async () => {
    const bare = SRC.split('\n')
      .filter((l) => !l.includes('@SysproseVerification') && !l.includes('attribute '))
      .join('\n')
      .replace(/\{\n\s*\}\n/, '');
    const loaded = await loadModelText(bare, { fileName: 'p.sysml', library: 'none' });
    const machineId = stateMachinesIn(loaded.model!)[0].id;
    const r = behaviourReport(loaded.model!, { machineId });
    // NOT exit 0. Exit 0 says every property was shown to hold, and a machine
    // that states none has been shown nothing — the same rule VERIFY_EXIT_CODES
    // states for a model with no obligation in it.
    expect(r.properties).toEqual([]);
    expect(r.exitCode).toBe(2);
  });

  it('checks a `--pattern` BESIDE the carriers, never instead of them', async () => {
    const loaded = await loadModelText(SRC, { fileName: 'p.sysml', library: 'none' });
    const machineId = stateMachinesIn(loaded.model!)[0].id;
    const r = behaviourReport(loaded.model!, {
      machineId,
      pattern: 'pattern=absence, scope=globally, p=state manual',
    });
    expect(r.properties.map((p) => `${p.property.source}:${p.claim}`)).toEqual([
      'model:pass',
      'flag:fail',
    ]);
    // One fail decides the run, whatever passed beside it.
    expect(r.exitCode).toBe(1);
  });
});

/**
 * The profile, field by field, against the interpreter it describes.
 *
 * Every verdict this command reaches is printed under these six sentences, so
 * each one is a claim about `execute.ts` that a reader is invited to rely on.
 * `andre-2023` §2.6's point is that every published formalisation differs on
 * exactly these, which is why a report that does not name its reading is a
 * verdict nobody can reproduce — and a reading nothing checks is a verdict
 * nobody can trust either.
 */
describe('the semantic profile is a description of what the interpreter does', () => {
  const field = (name: string) => {
    const f = SEMANTIC_PROFILE.find((p) => p.field === name);
    expect(f, `the profile no longer declares \`${name}\``).toBeDefined();
    return f!;
  };

  it('run-to-completion: the chase is a budget of 64, and a run that spends it says so', () => {
    expect(field('run-to-completion').reading).toContain(`${MAX_COMPLETION} chase steps`);
    const chain = (n: number): { model: Model; machineId: ElementId } => {
      const m = new Model();
      const f = new ModelFactory(m);
      const sm = f.stateDef('Chain');
      const states = Array.from({ length: n + 1 }, (_, i) => f.state(`s${i}`, sm.id));
      for (let i = 0; i < n; i++) f.transition(states[i].id, states[i + 1].id, { ownerId: sm.id });
      return { model: m, machineId: sm.id };
    };
    const long = chain(MAX_COMPLETION + 6);
    const run = runStateMachine(long.model, long.machineId, []);
    expect(run.completionBudgetHit, 'a 70-step chain must spend the budget').toBe(true);
    expect(long.model.get(run.finalState!)?.declaredName).toBe(`s${MAX_COMPLETION}`);
    const short = chain(3);
    expect(runStateMachine(short.model, short.machineId, []).completionBudgetHit).toBe(false);
  });

  it('priority: the innermost active substate wins', () => {
    expect(field('priority').reading).toContain('innermost active substate first');
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('P');
    const outer = f.state('Outer', sm.id);
    const inner = f.state('inner', outer.id);
    const it = f.state('innerTarget', outer.id);
    const ot = f.state('OuterTarget', sm.id);
    f.transition(inner.id, it.id, { ownerId: outer.id, trigger: 'go' });
    f.transition(outer.id, ot.id, { ownerId: sm.id, trigger: 'go' });
    const run = runStateMachine(m, sm.id, ['go']);
    expect(m.get(run.finalState!)?.declaredName).toBe('innerTarget');
  });

  it('history: shallow, and only where the composite is marked as one', () => {
    expect(field('history').reading).toContain('shallow');
    const build = (history: boolean) => {
      const m = new Model();
      const f = new ModelFactory(m);
      const sm = f.stateDef('H');
      const outer = f.state('Outer', sm.id);
      if (history) m.update(outer.id, { attrs: { ...outer.attrs, history: true } });
      const i1 = f.state('i1', outer.id);
      const i2 = f.state('i2', outer.id);
      const away = f.state('Away', sm.id);
      f.transition(i1.id, i2.id, { ownerId: outer.id, trigger: 'x' });
      f.transition(outer.id, away.id, { ownerId: sm.id, trigger: 'out' });
      f.transition(away.id, outer.id, { ownerId: sm.id, trigger: 'back' });
      const run = runStateMachine(m, sm.id, ['x', 'out', 'back']);
      return m.get(run.finalState!)?.declaredName;
    };
    expect(build(true), 'a history composite resumes its last-active child').toBe('i2');
    expect(build(false), 'an ordinary composite re-enters its initial child').toBe('i1');
  });

  it('regions: the interpreter concatenates them, and the walk refuses to interleave', () => {
    expect(field('regions').reading).toContain('CONCATENATES');
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('R');
    m.update(sm.id, { attrs: { parallel: true } });
    const r1 = f.state('R1', sm.id);
    const r2 = f.state('R2', sm.id);
    const a1 = f.state('a1', r1.id);
    const a2 = f.state('a2', r1.id);
    const b1 = f.state('b1', r2.id);
    const b2 = f.state('b2', r2.id);
    f.transition(a1.id, a2.id, { ownerId: r1.id, trigger: 'go' });
    f.transition(b1.id, b2.id, { ownerId: r2.id, trigger: 'go' });
    const run = runStateMachine(m, sm.id, ['go']);
    // Concatenated: the whole of region 1, then the whole of region 2. An
    // interleaving interpreter would visit a1, b1, a2, b2.
    expect(run.visited.map((v) => m.get(v)?.declaredName)).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(exploreMachine(m, sm.id).exhaustive).toBe(false);
  });

  it('deferred events: none — an event nothing accepts is dropped where it was offered', () => {
    expect(field('deferred events').reading).toContain('no event pool');
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('D');
    const a = f.state('A', sm.id);
    const b = f.state('B', sm.id);
    const c = f.state('C', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'a' });
    f.transition(b.id, c.id, { ownerId: sm.id, trigger: 'b' });
    // `b` is offered at `A`, where nothing accepts it, and `a` after it. With
    // an event pool the deferred `b` would fire from `B` and the run would end
    // at `C`; there is no pool, so it ends at `B`.
    const run = runStateMachine(m, sm.id, ['b', 'a']);
    expect(m.get(run.finalState!)?.declaredName).toBe('B');
  });

  it('time: discrete, and the walk offers each `after(n)` label rather than a clock', () => {
    expect(field('time').reading).toContain('discrete');
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('T');
    const a = f.state('A', sm.id);
    const b = f.state('B', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'after(2)' });
    // The interpreter advances no clock on its own, so an undriven run stays.
    expect(m.get(runStateMachine(m, sm.id, []).finalState!)?.declaredName).toBe('A');
    // The walk offers the label as a named event, which OVER-approximates time:
    // `B` counts as reachable. An over-approximation can only shrink an absence
    // claim, so this direction is the safe one — and it is why `absence of
    // state B` here is a fail rather than a pass.
    expect(machineAlphabet(m, sm.id)).toEqual(['after(2)']);
    expect(
      checkProperty(m, sm.id, prop({ pattern: 'absence', scope: 'globally', p: 'state B' })).claim,
    ).toBe('fail');
  });
});

/**
 * The fifth publishability condition, on THIS command.
 *
 * `reach` withholding its absence lists over a guard nothing decided while
 * `check-behaviour` wrote `pass` and `exhaustive` over the same machine was the
 * tool contradicting itself between two commands on one file — and a `pass`
 * with no reason to doubt it is the worse half of the contradiction, because it
 * is the one somebody acts on. Both halves are pinned here: the gate, and the
 * two controls that stop it firing where the walk DID decide.
 */
describe('a pass needs every guard decided, not only every bound unspent', () => {
  /** `s0 -go-> s1` under a guard, and `mode` valued or not. */
  function guarded(value?: number): { model: Model; machineId: ElementId } {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Modes');
    if (value !== undefined) f.attribute('mode', sm.id, { type: 'Integer', value });
    const idle = f.state('idle', sm.id);
    const hazard = f.state('hazard', sm.id);
    f.transition(idle.id, hazard.id, { ownerId: sm.id, guard: 'mode == 3' });
    return { model: m, machineId: sm.id };
  }
  const absence = prop({ pattern: 'absence', scope: 'globally', p: 'state hazard' });

  it('reports inconclusive rather than pass, and never prints `exhaustive`', () => {
    const { model, machineId } = guarded();
    const row = checkProperty(model, machineId, absence);
    expect(row.claim).toBe('inconclusive');
    expect(row.code).toBe(GUARD_UNDETERMINED_CODE);
    expect(row.exhaustive).toBe(false);
    expect(row.qualification).toContain('undetermined under');
    expect(row.qualification, 'a walk that decided nothing was called exhaustive').not.toContain(
      'exhaustive',
    );
    // The sentence has to name the guard and the missing name, and say it is
    // not a pass — a reader who is only told "inconclusive" raises a bound.
    expect(row.detail).toContain('mode == 3');
    expect(row.detail).toContain('`mode`');
    expect(row.detail).toContain('NOT a pass');
    expect(row.witness).toEqual([]);
  });

  it('is NOT the bound row: the two are fixed differently and say so', () => {
    const { model, machineId } = guarded();
    const row = checkProperty(model, machineId, absence);
    expect(row.code).not.toBe(BOUND_EXHAUSTED_CODE);
    expect(row.boundHit).toBe('none');
    // `--allow-inconclusive` is scoped to timeout and unsupported-construct, so
    // naming this row `verification/bound-exhausted` would not have laundered
    // it — but it would have sent an author to raise `--max-configs` over a
    // walk that finished.
    expect(row.detail).not.toContain('--max-configs');
  });

  it('a guard that is genuinely false still passes, exhaustively', () => {
    // The over-firing control. `mode = 4` decides `mode == 3` FALSE, so `hazard`
    // really is never entered and the pass is earned.
    const { model, machineId } = guarded(4);
    const row = checkProperty(model, machineId, absence);
    expect(row.claim).toBe('pass');
    expect(row.exhaustive).toBe(true);
    expect(row.qualification).toContain('exhaustive under');
  });

  it('a guard that holds refutes it, with a witness', () => {
    const { model, machineId } = guarded(3);
    const row = checkProperty(model, machineId, absence);
    expect(row.claim).toBe('fail');
    expect(row.witness.length).toBeGreaterThan(1);
  });

  it('the report counts it undecided and exits 2, and the row reaches a reader', () => {
    const { model, machineId } = guarded();
    const rep = behaviourReport(model, {
      machineId,
      pattern: 'pattern=absence, scope=globally, p=state hazard',
    });
    expect(rep.counts).toMatchObject({ passed: 0, failed: 0, vacuous: 0, inconclusive: 1 });
    // Inconclusive is exit 2 by the lane's contract, and no flag lowers this
    // one: `--allow-inconclusive` is scoped to `verification/timeout` and
    // `verification/unsupported-construct`.
    expect(rep.exitCode).toBe(2);
    expect(rep.diagnostics.map((d) => d.code)).toContain(GUARD_UNDETERMINED_CODE);
  });
});
