/**
 * One publishability predicate, and the two registers a test can walk.
 *
 * THREE THINGS THIS FILE IS FOR.
 *
 *  1. **The refactor moved nothing.** `reachOne` and `checkProperty` each used
 *     to write out their own conjunction. Both now call `publishabilityOf`, and
 *     the assertions below recompute the SHIPPED expression inline — the same
 *     four conjuncts, in the same order, off the same walk — and require it to
 *     agree with `decreasingOk` on every machine in the tree, then require the
 *     published row to agree with both. A per-machine table of what `reach`
 *     printed before the refactor is pinned beside it, so a moved sentence is a
 *     named failure rather than a diff nobody ran.
 *  2. **The registers are executable.** `ABSENCE_CLAIMS` and `WITNESS_CLAIMS`
 *     are data, so adding a claim without a condition, wiring an increasing
 *     claim to the decreasing conjunction, or letting a bound condition back in
 *     one `alsoRequires` entry at a time is a red test here rather than a review
 *     comment somebody has to notice.
 *  3. **The regression the two-conjunction shape exists to prevent.** A single
 *     `ok` — one boolean for both polarities — would flip false on any machine
 *     carrying a dwell transition and empty a sound `verification/unreachable-
 *     state` finding out of a shipped command. No `.sysml` file in this tree can
 *     exhibit that, and no `.sysml` file ever will: `accept after(n)` is a parse
 *     error, so a timed transition is API-only. The machine is therefore built
 *     through `ModelFactory` here, and it is the input that tells `decreasingOk`
 *     and the exactness gate apart.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Model, ModelFactory, type ElementId } from '@core/index';
import { loadModelText } from '@text/load';
import {
  exploreMachine,
  machineAlphabet,
  machineStates,
  reachReport,
  stateMachinesIn,
  walkableTransitions,
  type ExploreResult,
} from '../../src/semantics/mc/explore';
import { checkProperty, type PropertyText } from '../../src/semantics/mc/patterns';
import { afterDuration } from '../../src/semantics/mc/config';
import {
  ABSENCE_CLAIMS,
  BOUND_FAMILY,
  DWELL_SENTENCE,
  environmentSentence,
  SIMULATOR_SENTENCE,
  WITNESS_CLAIMS,
  publishabilityOf,
  walkIsExact,
  type AbsenceClaim,
  type ExactnessWalk,
} from '../../src/semantics/mc/publishable';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/**
 * Every model in the tree that carries a state machine — the six shipped
 * examples first, because they are what the byte-equality gate is measured on,
 * then the fixture models, which are the only inputs in the repository on which
 * the conjunction reads FALSE. Without them every assertion below would be an
 * assertion about `true === true`.
 */
const MODELS = [
  'examples/contract-authoring-prompts.sysml',
  'examples/uav-isr.sysml',
  'examples/uav-isr-verification.sysml',
  'examples/uav-power-budget.sysml',
  'examples/vehicle.sysml',
  'examples/views-tour.sysml',
  'test/fixtures/verification/models/guard-undetermined.sysml',
  'test/fixtures/verification/models/succession-mixed.sysml',
  'test/fixtures/verification/models/succession-only.sysml',
  'test/fixtures/verification/models/latch.sysml',
  'test/fixtures/verification/models/cover-reachable.sysml',
  'test/fixtures/verification/models/cover-sealed.sysml',
  'test/fixtures/agent-authoring/L2-bare-transition-arrow/fixed.sysml',
  'test/fixtures/agent-authoring/L3-unresolved-transition-end/input.sysml',
  'test/fixtures/agent-authoring/L3-unresolved-transition-end/fixed.sysml',
];

interface Loaded {
  file: string;
  model: Model;
}

const loaded: Loaded[] = [];

/** A globally-scoped `absence` over one atom, as a caller writes one. */
function prop(p: string): PropertyText {
  return { source: 'flag', carrier: null, pattern: 'absence', scope: 'globally', p };
}

/**
 * `reachOne`'s conjunction as it was WRITTEN before this commit, recomputed here
 * off the same walk.
 *
 * This is the byte-equality gate, and it is deliberately a transcription rather
 * than a call: a test that re-used `publishabilityOf` to check
 * `publishabilityOf` would pass on any definition at all.
 */
function shippedReachConjunction(walk: ExploreResult): boolean {
  const alphabetOffered = walk.bounds.alphabet.every((t) => walk.offered.has(t));
  const guardsDecided = walk.undeterminedGuards.length === 0;
  return walk.exhaustive && alphabetOffered && walk.unsupported.length === 0 && guardsDecided;
}

beforeAll(async () => {
  for (const file of MODELS) {
    const text = read(file);
    const r = await loadModelText(text, { fileName: file });
    if (r.model) loaded.push({ file, model: r.model });
  }
}, 300_000);

describe('the two shipped conjunctions and `decreasingOk`', () => {
  it('every model in the tree loads, so no assertion below is vacuous', () => {
    expect(loaded.map((l) => l.file)).toEqual(MODELS);
  });

  it("`reachOne`'s four conjuncts ARE `decreasingOk`, on every machine in the tree", () => {
    let machines = 0;
    let refusing = 0;
    for (const { file, model } of loaded) {
      for (const m of stateMachinesIn(model)) {
        machines += 1;
        const walk = exploreMachine(model, m.id);
        const shipped = shippedReachConjunction(walk);
        const p = publishabilityOf(walk);
        expect(p.decreasingOk, `${file} ${model.qualifiedName(m.id)}`).toBe(shipped);
        // The four conjuncts, one at a time, so a predicate that got the right
        // answer for the wrong reason is still a failure.
        expect(p.exhaustive).toBe(walk.exhaustive);
        expect(p.supported).toBe(walk.unsupported.length === 0);
        expect(p.guardsDetermined).toBe(walk.undeterminedGuards.length === 0);
        expect(p.alphabetOffered).toBe(walk.bounds.alphabet.every((t) => walk.offered.has(t)));
        // A WALK-ONLY CLAIM HAS NO `searchComplete`, and the field is ABSENT
        // rather than `false`: reading it as `false` would print "bound
        // exhausted" about a bound nobody hit.
        expect('searchComplete' in p).toBe(false);
        if (!shipped) refusing += 1;
      }
    }
    expect(machines, 'the tree no longer carries the machines this file walks').toBeGreaterThan(5);
    expect(refusing, 'no model in the tree refuses publication, so the gate is untested').toBe(2);
  });

  it("`reach`'s published row reads the predicate and nothing else", () => {
    for (const { file, model } of loaded) {
      const report = reachReport(model);
      for (const row of report.machines) {
        const walk = exploreMachine(model, row.machine.id);
        const ok = publishabilityOf(walk).decreasingOk;
        expect(row.exhaustive, `${file} ${row.machine.qualifiedName}`).toBe(ok);
        expect(row.suppressed).toBe(!ok);
        // The two absence LISTS are the claims the conjunction gates, so they
        // are checked against it rather than against themselves.
        if (!ok) {
          expect(row.states.unreachable).toEqual([]);
          expect(row.transitions.dead).toEqual([]);
        }
      }
    }
  });

  it("`checkProperty`'s conjunction ADDS the product search and nothing else", () => {
    let rows = 0;
    for (const { file, model } of loaded) {
      for (const m of stateMachinesIn(model)) {
        const states = machineStates(model, m.id);
        if (states.length === 0) continue;
        const atom = `state ${states[0].declaredName ?? ''}`;
        const walk = exploreMachine(model, m.id);
        const row = checkProperty(model, m.id, prop(atom));
        rows += 1;
        // `row.boundHit` is `found.boundHit` whenever the WALK hit no bound,
        // which is the only case in which the search bound can be recovered from
        // the published row — so the equality is asserted there and the bounded
        // case is exercised separately below.
        if (walk.boundHit !== 'none') continue;
        const shipped =
          walk.exhaustive &&
          walk.bounds.alphabet.every((t) => walk.offered.has(t)) &&
          row.boundHit === 'none' &&
          walk.undeterminedGuards.length === 0;
        const p = publishabilityOf(walk, { boundHit: row.boundHit });
        expect(p.decreasingOk, `${file} ${model.qualifiedName(m.id)}`).toBe(shipped);
        expect(p.searchComplete).toBe(row.boundHit === 'none');
        // An unsupported machine returns before the conjunction is ever
        // computed, so `exhaustive` is false there for a reason the predicate
        // also gives — but the two are only required to agree where the row
        // reached the conjunction at all.
        if (walk.unsupported.length === 0) expect(row.exhaustive).toBe(shipped);
      }
    }
    expect(rows, 'no property row was produced, so this test asserts nothing').toBeGreaterThan(5);
  });

  it('a product-search bound alone withholds the pass — the conjunct `reach` does not have', async () => {
    const r = await loadModelText(read('examples/uav-isr.sysml'), {
      fileName: 'examples/uav-isr.sysml',
    });
    const model = r.model!;
    const machine = stateMachinesIn(model).find((m) => m.declaredName === 'FlightModes')!;
    const bounded = checkProperty(model, machine.id, prop('state failsafe'), {
      maxConfigs: 3,
    });
    expect(bounded.exhaustive).toBe(false);
    const walk = exploreMachine(model, machine.id, { maxConfigs: 3 });
    // The walk-only predicate and the search-aware one disagree here, and that
    // disagreement IS the extra conjunct: whichever of the two bounds was hit,
    // the row is not a pass.
    expect(publishabilityOf(walk, { boundHit: bounded.boundHit }).decreasingOk).toBe(false);
    // The same walk with its own bound lifted: the walk-only claim publishes,
    // and the search-aware one still refuses. That gap is the extra conjunct,
    // and it is the ONE thing `checkProperty` asks for that `reach` does not.
    const finished = { ...walk, exhaustive: true };
    expect(publishabilityOf(finished).decreasingOk).toBe(true);
    expect(publishabilityOf(finished, { boundHit: 'configs' }).decreasingOk).toBe(false);
    expect(publishabilityOf(finished, { boundHit: 'configs' }).sentence).toContain(
      'the product search did not finish',
    );
  });
});

/**
 * What `reach` printed on every machine in the tree BEFORE the conjunction was
 * lifted, measured on this tree and pinned here.
 *
 * The gate of this commit is *"not one published sentence moved"*, and a gate
 * nobody can fail proves nothing. Every figure below is a published one.
 *
 * RE-RECORDED TWICE SINCE, BOTH DELIBERATELY AND BOTH NAMED. The component
 * commit appended the store clause to every `under {…}` qualification (the
 * successors suite pins the position), and the same commit moved ONE more
 * sentence in ONE row of this table: `GuardProbe::Ctrl::Modes`'s qualification
 * no longer enumerates *the unreachable, dead and no-way-out lists* as withheld
 * — the no-way-out row is withheld per configuration now (register row A0), so
 * the sentence names that list only where a row of it went, counted from the
 * withheld rows themselves. On that machine one did — `idle`'s only way out is
 * the guard nothing valued — and the tail says so. Every count below is
 * unmoved: `deadlocks: 0` there is the published list, and the withheld row
 * sits beside it in `deadlocksWithheld`, which this table predates.
 */
const REACH_BEFORE: Array<{
  file: string;
  machine: string;
  configs: number;
  depth: number;
  exhaustive: boolean;
  boundHit: string;
  qualification: string;
  unreachable: string[];
  dead: number;
  deadlocks: number;
  suppressed: boolean;
}> = [
  {
    file: 'examples/uav-isr.sysml',
    machine: 'UAVSurveillanceSystem::FlightModes',
    configs: 4,
    depth: 3,
    exhaustive: true,
    boundHit: 'none',
    qualification:
      'exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false}',
    unreachable: [],
    dead: 0,
    deadlocks: 0,
    suppressed: false,
  },
  {
    file: 'examples/vehicle.sysml',
    machine: 'VehicleModel::VehicleStates',
    configs: 3,
    depth: 2,
    exhaustive: true,
    boundHit: 'none',
    qualification:
      'exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false}',
    unreachable: [],
    dead: 0,
    deadlocks: 0,
    suppressed: false,
  },
  {
    file: 'examples/views-tour.sysml',
    machine: 'DroneDemo::FlightModes',
    configs: 2,
    depth: 1,
    exhaustive: true,
    boundHit: 'none',
    qualification:
      'exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false}',
    unreachable: [],
    dead: 0,
    deadlocks: 0,
    suppressed: false,
  },
  {
    file: 'test/fixtures/verification/models/guard-undetermined.sysml',
    machine: 'GuardProbe::Ctrl::Modes',
    configs: 1,
    depth: 0,
    exhaustive: false,
    boundHit: 'none',
    qualification:
      'undetermined under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — 1 guard(s) the walk could not evaluate; the unreachable and dead lists are WITHHELD and are NOT reported as findings, as is the no-way-out row for 1 configuration(s) whose only ways out are guards this walk could not decide',
    unreachable: [],
    dead: 0,
    deadlocks: 0,
    suppressed: true,
  },
  {
    file: 'test/fixtures/verification/models/guard-undetermined.sysml',
    machine: 'GuardProbe::Decided::Modes',
    configs: 1,
    depth: 0,
    exhaustive: true,
    boundHit: 'none',
    qualification:
      'exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false}',
    unreachable: ['hazard'],
    dead: 1,
    deadlocks: 1,
    suppressed: false,
  },
  {
    file: 'test/fixtures/verification/models/guard-undetermined.sysml',
    machine: 'GuardProbe::Fires::Modes',
    configs: 2,
    depth: 1,
    exhaustive: true,
    boundHit: 'none',
    qualification:
      'exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false}',
    unreachable: [],
    dead: 0,
    deadlocks: 1,
    suppressed: false,
  },
  {
    file: 'test/fixtures/verification/models/succession-mixed.sysml',
    machine: 'SuccMix::Ctrl::Modes',
    configs: 3,
    depth: 2,
    exhaustive: true,
    boundHit: 'none',
    qualification:
      'exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false}',
    unreachable: [],
    dead: 0,
    deadlocks: 1,
    suppressed: false,
  },
  {
    file: 'test/fixtures/verification/models/succession-mixed.sysml',
    machine: 'SuccMix::Loop::Modes',
    configs: 2,
    depth: 1,
    exhaustive: true,
    boundHit: 'none',
    qualification:
      'exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false}',
    unreachable: [],
    dead: 0,
    deadlocks: 0,
    suppressed: false,
  },
  {
    file: 'test/fixtures/agent-authoring/L2-bare-transition-arrow/fixed.sysml',
    machine: 'P::M',
    configs: 2,
    depth: 1,
    exhaustive: true,
    boundHit: 'none',
    qualification:
      'exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false}',
    unreachable: [],
    dead: 0,
    deadlocks: 1,
    suppressed: false,
  },
  {
    file: 'test/fixtures/agent-authoring/L3-unresolved-transition-end/input.sysml',
    machine: 'P::M',
    configs: 0,
    depth: 0,
    exhaustive: false,
    boundHit: 'none',
    qualification:
      'not explored — transition-without-endpoints; no figure below is a claim of absence',
    unreachable: [],
    dead: 0,
    deadlocks: 0,
    suppressed: true,
  },
  {
    file: 'test/fixtures/agent-authoring/L3-unresolved-transition-end/fixed.sysml',
    machine: 'P::M',
    configs: 2,
    depth: 1,
    exhaustive: true,
    boundHit: 'none',
    qualification:
      'exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false}',
    unreachable: [],
    dead: 0,
    deadlocks: 1,
    suppressed: false,
  },
];

describe('not one published sentence moved', () => {
  it('reproduces the pre-refactor `reach` row on every machine that has one', () => {
    for (const want of REACH_BEFORE) {
      const model = loaded.find((l) => l.file === want.file)!.model;
      const row = reachReport(model).machines.find(
        (m) => m.machine.qualifiedName === want.machine,
      );
      expect(row, `${want.file} no longer declares ${want.machine}`).toBeDefined();
      expect({
        configs: row!.configs,
        depth: row!.depth,
        exhaustive: row!.exhaustive,
        boundHit: row!.boundHit,
        qualification: row!.qualification,
        unreachable: row!.states.unreachable.map((s) => s.name),
        dead: row!.transitions.dead.length,
        deadlocks: row!.deadlocks.length,
        suppressed: row!.suppressed,
      }).toEqual({
        configs: want.configs,
        depth: want.depth,
        exhaustive: want.exhaustive,
        boundHit: want.boundHit,
        qualification: want.qualification,
        unreachable: want.unreachable,
        dead: want.dead,
        deadlocks: want.deadlocks,
        suppressed: want.suppressed,
      });
    }
  });

  it('spells the three §2.4 standing sentences verbatim, so a divergent copy is red', () => {
    // THREE LANES DEFINE THESE CONSTANTS FROM THE SAME PARAGRAPH and the merge
    // keeps one copy of each; nothing else in the tree pins the SPELLING —
    // every consumer asserts `toContain(DWELL_SENTENCE)`, which is green on any
    // wording — so this is the only assertion a copy that drifted from §2.4(a),
    // (c) or (d) can fail. (a) is read by three producers — the cover row, the
    // trap block of `reach`, and the `recovery` refusal — and it is a FUNCTION
    // of the triggers the run consumed: the plan's example, `abort`, is the
    // pin for the spelling, and the two other shapes pin what the function
    // does with the names it is given.
    expect(environmentSentence(['abort'])).toBe(
      'the environment offered every trigger this machine names at every configuration, so a witness that consumes `abort` is a claim about that environment and not about one that withholds it',
    );
    expect(environmentSentence(['unlatch'])).toBe(
      'the environment offered every trigger this machine names at every configuration, so a witness that consumes `unlatch` is a claim about that environment and not about one that withholds it',
    );
    // Two triggers: each backticked, comma-joined, in the order given — the
    // caller's order, which is trace order for a witness and alphabet order for
    // a report — and never sorted or deduplicated here.
    expect(environmentSentence(['go', 'abort'])).toBe(
      'the environment offered every trigger this machine names at every configuration, so a witness that consumes `go`, `abort` is a claim about that environment and not about one that withholds it',
    );
    // No trigger is the F2 defect — a sentence about an environment the
    // machine does not name — and it is an error, not an empty sentence.
    expect(() => environmentSentence([])).toThrow(/named none/);
    expect(DWELL_SENTENCE).toBe(
      'this walk advances no clock: a transition carrying an `after(n)` dwell is offered at every configuration — as a named event where the dwell is written as a trigger, as a completion where it is written as `attrs.after` — so a step taken across one is a step the interpreter may never take',
    );
    expect(SIMULATOR_SENTENCE).toBe(
      "every claim above is about this MACHINE's semantics — the walk explores both branches of a nondeterministic choice; the simulator takes the first declared one, so a run this verdict quantifies over may be a run `simulate` never produces",
    );
  });
});

/* ═══════════════════ reflection over the two registers ═══════════════════ */

const WALK_REQUIRES = ['decreasingOk', 'walkIsExact', 'relationIsTheMachines', null];
const POLARITIES = ['decreasing', 'increasing', 'mixed', 'not-a-walk'];

/**
 * The mechanisms a `mixed` or `increasing` row's polarity can flip in, and the
 * conjunct that covers each.
 *
 * A row that reads the DECREASING conjunction while its polarity says the
 * approximation can falsify it is legal only by naming, in `alsoRequires`, a
 * conjunct that covers the mechanism its own note identifies. This table is how
 * "covers" is decided mechanically rather than by reading the prose.
 */
const MECHANISMS: Array<{ note: RegExp; conjunct: RegExp }> = [
  { note: /undecided[- ]guard|guard/i, conjunct: /undeterminedGuards/ },
  { note: /dwell|after\(n\)|clock/i, conjunct: /timedTransitions/ },
  { note: /environment|trigger/i, conjunct: /alphabet/ },
];

const ALL_ROWS: readonly AbsenceClaim[] = [...ABSENCE_CLAIMS, ...WITNESS_CLAIMS];

describe('the registers are data, and every column is asserted', () => {
  it('registers sixteen absence claims and six positive witnesses', () => {
    expect(ABSENCE_CLAIMS.map((r) => r.id)).toEqual([
      'A0',
      'A1',
      'A2',
      'A3',
      'A4',
      'A5',
      'A6',
      'A7',
      'A8',
      'A9',
      'A10',
      'A11',
      'A12',
      'A13',
      'A14',
      'A15',
    ]);
    expect(WITNESS_CLAIMS.map((r) => r.id)).toEqual(['W1', 'W2', 'W3', 'W4', 'W5', 'W6']);
    expect(new Set(ALL_ROWS.map((r) => r.id)).size).toBe(ALL_ROWS.length);
  });

  it('every row fills every column: a claim, a feature, a note, an `otherwise`', () => {
    for (const row of ALL_ROWS) {
      expect(row.claim.length, row.id).toBeGreaterThan(3);
      expect(row.feature.length, row.id).toBeGreaterThan(3);
      expect(row.polarityNote.length, row.id).toBeGreaterThan(10);
      expect(row.otherwise.length, row.id).toBeGreaterThan(3);
    }
  });

  it('`walkRequires` is one of exactly four values, and `polarity` one of exactly four', () => {
    for (const row of ALL_ROWS) {
      expect(WALK_REQUIRES, `${row.id}: ${String(row.walkRequires)}`).toContain(row.walkRequires);
      expect(POLARITIES, `${row.id}: ${row.polarity}`).toContain(row.polarity);
    }
  });

  it('`walkRequires: null` appears only where the polarity says "not a walk"', () => {
    for (const row of ALL_ROWS) {
      expect(row.walkRequires === null, `${row.id}`).toBe(row.polarity === 'not-a-walk');
    }
  });

  it('no row carries no condition at all — the claim three documents make about this file', () => {
    // `docs/CONFORMANCE.md` §8.5, `publishable.ts`'s own comment on
    // `ABSENCE_CLAIMS`, and this file's header all publish the sentence *"a
    // claim added without a condition is a failing test"*. Without this
    // assertion it was prose: a `not-a-walk` row reads no gate by construction,
    // so emptying its `alsoRequires` left it with nothing to satisfy and
    // nothing went red. The three rows that read no gate today — A9, A14, A15 —
    // each name their own conjuncts, so this lands green and bites the next
    // row that does not.
    for (const row of ALL_ROWS) {
      const conditions = (row.walkRequires === null ? 0 : 1) + row.alsoRequires.length;
      expect(conditions, `${row.id} names neither a gate nor a conjunct`).toBeGreaterThan(0);
      if (row.walkRequires === null) {
        expect(row.alsoRequires.length, `${row.id} reads no gate and names no conjunct`)
          .toBeGreaterThan(0);
      }
    }
  });

  it('no register cell names a `PC` number — the vocabulary that let this defect be re-argued', () => {
    // Plan §2.3: *"No `PC` name appears in `publishable.ts`, in a register cell,
    // in a verdict row, in a MUST-NEVER list or in a test name, and a cell
    // naming one is a red test in exactly the way a per-mechanism conjunction
    // is."* The per-mechanism half is asserted above by the four-value
    // `walkRequires` check; this is the other half.
    for (const row of ALL_ROWS) {
      const cells = [
        row.claim,
        row.feature,
        row.polarityNote,
        row.otherwise,
        String(row.walkRequires),
        ...row.alsoRequires,
      ].join(' ');
      expect(cells, `${row.id} names a PC condition`).not.toMatch(/\bPC\d\b/);
    }
    expect(read('src/semantics/mc/publishable.ts')).not.toMatch(/\bPC\d\b/);
  });

  it('every row names a producer that exists, or names none at all', () => {
    for (const row of ALL_ROWS) {
      if (row.producedBy === null) continue;
      const { file, symbol } = row.producedBy;
      expect(existsSync(resolve(process.cwd(), file)), `${row.id}: ${file}`).toBe(true);
      expect(read(file), `${row.id}: ${file} declares no \`${symbol}\``).toContain(
        `function ${symbol}(`,
      );
    }
    // NINE rows name a producer, and A0 is among them: `verification/deadlock`
    // is machinery this register RECORDS rather than machinery it repairs. The
    // set is pinned so a feature landing without its row being wired is red.
    // A9 joined it with the scoped staleness comparison (§3.3b), whose producer
    // is a checker rule's reading and not a walk at all. A5 and W1 joined it
    // with `cover` (§3.1) — the first witness row in the register to ship; A6
    // and its rider W2 with the trap list (§3.2a), both pointing at `reachOne`
    // because that is where the gate is applied, not where the component
    // arithmetic lives; A8 and W3 together, with the modality (§3.R): the two
    // values of one field, composed by one function, which is what "gated
    // together and by one predicate" means when it is data rather than prose.
    // A7 joined it with `recovery` (§3.2b): one producer for both directions
    // of a branching-time claim, and no witness row beside it — a set is not
    // a run.
    expect(ALL_ROWS.filter((r) => r.producedBy !== null).map((r) => r.id)).toEqual([
      'A0',
      'A1',
      'A2',
      'A3',
      'A4',
      'A5',
      'A6',
      'A7',
      'A8',
      'A9',
      'A14',
      'W1',
      'W2',
      'W3',
    ]);
  });

  it('the recovery producer reads `walkIsExact` for BOTH directions, and nothing from the decreasing family or the search', () => {
    // THE REGISTER IS THE WIRING, AND THIS READS THE WIRE — for the producer
    // A7 names. `recoverable` is increasing and `not recoverable` is an
    // absence over reverse reachability; the store clause manufactures the
    // second (trapguard: the escape edge is absent, measured `cannot 2`), so
    // both halves read the whole gate and neither reads `decreasingOk`, which
    // would let an undecided guard publish a refutation at exit 1 on a
    // design that states the way back. And it never reads `found`: no product
    // search runs on this path, and `searchComplete` has no value to read.
    const a7 = ABSENCE_CLAIMS.find((r) => r.id === 'A7')!;
    expect(a7.producedBy).toEqual({ file: 'src/semantics/mc/patterns.ts', symbol: 'recoveryRow' });
    expect(a7.alsoRequires).toEqual([]);
    const src = read(a7.producedBy!.file);
    const body = /function recoveryRow\([\s\S]*?\n}\n/.exec(src);
    expect(body, 'patterns.ts no longer declares recoveryRow').not.toBeNull();
    const producer = body![0];
    expect(producer).toContain('walkIsExact(');
    expect(producer).toContain('reverseReachable(');
    expect(producer).not.toContain('decreasingOk');
    expect(producer).not.toContain('publishabilityOf');
    expect(producer).not.toContain('searchComplete');
    expect(producer).not.toContain('found');
    expect(producer).not.toContain('search(');
    // The pass and the fail both sit behind the SAME two checks, in the
    // gate's own order, and the empty-target refutation comes after them.
    expect(producer.indexOf('if (!gate.seenWhole)')).toBeLessThan(producer.indexOf('switch (gate.failedClause)'));
    expect(producer.indexOf('switch (gate.failedClause)')).toBeLessThan(producer.indexOf('if (targets.length === 0)'));
    expect(producer.indexOf('if (targets.length === 0)')).toBeLessThan(producer.indexOf('reverseReachable('));
    // And `checkProperty` dispatches to it exactly once, before its search.
    expect(src.match(/return recoveryRow\(/g)).toHaveLength(1);
    expect(src.indexOf('return recoveryRow(')).toBeLessThan(src.indexOf('const found = search('));
  });

  it('the modality producer reads `walkIsExact`, and nothing from the decreasing family', () => {
    // THE REGISTER IS THE WIRING, AND THIS READS THE WIRE — the same shape as
    // the `reachOne` assertion above, for the producer A8 and W3 both name.
    // `guaranteed` quantifies over the run set and `potential` names a cycle
    // with no exit; both are manufactured by a relation that is not the
    // machine's, so the one function that composes them reads the whole gate
    // and neither `decreasingOk` nor `publishabilityOf`, which would let a
    // bounded or a triggered walk publish either word. And it never reads
    // `found` — the prefix walked before the first witness — nor `enabled[0]`,
    // the simulator's tie-break, which correction 13 forbids a verdict to be
    // derived from.
    const a8 = ABSENCE_CLAIMS.find((r) => r.id === 'A8')!;
    const w3 = WITNESS_CLAIMS.find((r) => r.id === 'W3')!;
    expect(a8.producedBy).toEqual({ file: 'src/semantics/mc/patterns.ts', symbol: 'modalityOf' });
    expect(w3.producedBy).toEqual(a8.producedBy);
    const src = read(a8.producedBy!.file);
    const body = /function modalityOf\([\s\S]*?\n}\n/.exec(src);
    expect(body, 'patterns.ts no longer declares modalityOf').not.toBeNull();
    const producer = body![0];
    expect(producer).toContain('walkIsExact(');
    expect(producer).not.toContain('decreasingOk');
    expect(producer).not.toContain('publishabilityOf');
    expect(producer).not.toContain('found');
    expect(producer).not.toContain('enabled[0]');
    // Both values sit BEHIND the gate: the decided branches read the gate's
    // own field, and the sink is tested on the FULL relation (§3.R's
    // sink-scoping rule), never on the induced one.
    expect(producer).toContain('if (!gate.walkIsExact) return withheld(');
    expect(producer).toContain('walk.successors[i].length === 0');
    expect(producer).not.toContain('induced[i].length === 0');
    // And `checkProperty` composes it on the `fail` row and nowhere else.
    expect(src.match(/modality: modalityOf\(/g)).toHaveLength(1);
    expect(src.match(/modality: null/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it('the producer applies the gate each row declares, read off its source', () => {
    // THE REGISTER IS THE WIRING, AND THIS READS THE WIRE. The columns say what
    // `reachOne` applies to each list; nothing else in this file reads
    // `reachOne` to check that it does. A1 and A2 declare `decreasingOk`, which
    // `reachOne` binds as `publishable` and ternaries both lists on. A0
    // declares `decreasingOk` too — the plan's cell (§2.3) — with the
    // per-configuration conjunct in `alsoRequires`; what the producer applies
    // to the deadlock rows is that conjunct and ONLY that conjunct. It cannot
    // apply the walk-wise family without regressing the row: `decreasingOk`
    // includes `exhaustive`, and the `verification/deadlock` catalogue entry
    // says a bound does not withhold the row, while `guardsDecided` subsumes
    // the leaf-wise conjunct and would empty the array whole again, which is
    // the reading §4 says loses the decided sink. So the assertion is exact:
    // the conjunct is applied, and neither walk-wise symbol is.
    const src = read('src/semantics/mc/explore.ts');
    const body = /function reachOne\([\s\S]*?\n}\n/.exec(src);
    expect(body, 'explore.ts no longer declares reachOne').not.toBeNull();
    const reachOne = body![0];
    // A1, A2: `const unreachable = publishable ? … : []`, `const dead = publishable ? … : []`.
    expect(reachOne).toMatch(/const publishable = publishabilityOf\(walk\)\.decreasingOk;/);
    expect(reachOne).toMatch(/const unreachable = publishable\s*\?/);
    expect(reachOne).toMatch(/const dead = publishable\s*\?/);
    // A0: the published rows are the walk's rows filtered by the conjunct, the
    // withheld rows are the complement, and no walk-wise symbol touches either.
    const deadlocks = /const deadlocks = ([^;]*);/.exec(reachOne);
    const withheld = /const deadlocksWithheld = ([^;]*);/.exec(reachOne);
    expect(deadlocks, 'reachOne no longer binds `deadlocks`').not.toBeNull();
    expect(withheld, 'reachOne no longer binds `deadlocksWithheld`').not.toBeNull();
    for (const [name, m] of [
      ['deadlocks', deadlocks],
      ['deadlocksWithheld', withheld],
    ] as const) {
      expect(m![1], name).toContain('walk.deadlocks.filter(');
      expect(m![1], name).toContain('nothingUndecidedLeaves(row, undecidedExits)');
      expect(m![1], name).not.toContain('publishable');
      expect(m![1], name).not.toContain('guardsDecided');
      expect(m![1], name).not.toContain('decreasingOk');
    }
    expect(withheld![1]).toContain('!nothingUndecidedLeaves');
    expect(deadlocks![1]).not.toContain('!nothingUndecidedLeaves');
    // And the row itself names that conjunct, so the two cannot drift apart.
    const a0 = ABSENCE_CLAIMS.find((r) => r.id === 'A0')!;
    expect(a0.alsoRequires).toEqual([
      'no outgoing transition of the deadlocked leaf is in `walk.undeterminedGuards`',
    ]);
    expect(src).toContain('function nothingUndecidedLeaves(');
    // A6: the trap list is the ONE field gated on the increasing side, and it
    // reads the whole gate — `gate.walkIsExact` — and nothing from the
    // decreasing family. The wrong wiring is named: `publishable` here would
    // publish "no trap" over a walk that supplied the escape itself, and the
    // rule two tests below ("no increasing row reads decreasingOk") would go
    // red on the register while the producer quietly did it anyway.
    const traps = /const traps = ([^;]*);/.exec(reachOne);
    expect(traps, 'reachOne no longer binds `traps`').not.toBeNull();
    expect(reachOne).toMatch(/const traps = gate\.walkIsExact\s*\?/);
    expect(traps![1]).not.toContain('publishable');
    expect(traps![1]).not.toContain('decreasingOk');
    expect(traps![1]).not.toContain('guardsDecided');
    expect(traps![1]).toContain('trapsOf(');
    expect(src).toContain('function trapsOf(');
    const a6 = ABSENCE_CLAIMS.find((r) => r.id === 'A6')!;
    expect(a6.walkRequires).toBe('walkIsExact');
    expect(a6.producedBy).toEqual({ file: 'src/semantics/mc/explore.ts', symbol: 'reachOne' });
  });

  it('A0–A5, the six decreasing rows, read the conjunction the shipped commands read', () => {
    // All six ship. A5 (`cover`'s `not covered`, §3.1) was listed here before
    // it was built because its POLARITY was settled — it reads `decreasingOk`,
    // and a commit wiring it to the exactness gate is red here.
    for (const id of ['A0', 'A1', 'A2', 'A3', 'A4', 'A5']) {
      const row = ABSENCE_CLAIMS.find((r) => r.id === id)!;
      expect(row.walkRequires, id).toBe('decreasingOk');
    }
  });

  it('no `alsoRequires` entry on any row names a member of the bound family', () => {
    for (const row of ALL_ROWS) {
      for (const conjunct of row.alsoRequires) {
        for (const bound of BOUND_FAMILY) {
          expect(conjunct, `${row.id} names the bound family member \`${bound}\``).not.toContain(
            bound,
          );
        }
      }
    }
  });

  it('no increasing or mixed row reads `decreasingOk` without covering its own mechanism', () => {
    const escapes: string[] = [];
    for (const row of ALL_ROWS) {
      if (row.polarity !== 'increasing' && row.polarity !== 'mixed') continue;
      if (row.walkRequires !== 'decreasingOk') continue;
      escapes.push(row.id);
      // EVERY mechanism the note names, not any one of them. A row whose note
      // identifies two — say a missing edge AND a dwell the walk offers — would
      // otherwise buy the escape by covering the cheapest of the two, which is
      // the per-conjunct erosion this assertion exists to stop. The filtered
      // list is required non-empty first, because `[].every` is vacuously true
      // and would hand the escape to a row whose note names no mechanism at all.
      const named = MECHANISMS.filter((m) => m.note.test(row.polarityNote));
      expect(named.length, `${row.id} reads \`decreasingOk\` and its note names no mechanism`)
        .toBeGreaterThan(0);
      const covered = named.every((m) => row.alsoRequires.some((c) => m.conjunct.test(c)));
      expect(covered, `${row.id} reads \`decreasingOk\` and covers no mechanism its note names`)
        .toBe(true);
    }
    // EXACTLY ONE ROW USES THAT ESCAPE. A second one arriving without a
    // sentence beside it is what this assertion is for.
    expect(escapes).toEqual(['A0']);
  });

  it('every existential witness reads the relation half and names no bound', () => {
    const existential = WITNESS_CLAIMS.filter((w) => w.kind === 'existential');
    expect(existential.map((w) => w.id)).toEqual(['W1', 'W2', 'W5', 'W6']);
    for (const w of existential) {
      // A bound can HIDE a witness and can never INVENT one, so a witness row
      // that read the bound family would make a bounded `covered` and this
      // assertion mutually unsatisfiable.
      expect(w.walkRequires, w.id).toBe('relationIsTheMachines');
      expect(w.perStepAlternative, w.id).toBe(true);
    }
  });

  it('W1 stands on a partial walk: the `--max-configs d` witness still publishes `covered`', async () => {
    // The register's claim, run rather than read. Without this beside the
    // reflection above, that assertion and `cover`'s bound-frontier case would
    // be mutually unsatisfiable, and the cheap repair would have been to weaken
    // the reflection. The witness on the reachable probe is two steps deep;
    // at `maxConfigs 2` the walk is partial and the row is still `covered`.
    const file = 'test/fixtures/verification/models/cover-reachable.sysml';
    const r = await loadModelText(read(file), { fileName: file });
    const machine = r.model!.all().find((el) => r.model!.qualifiedName(el.id) === 'CoverProbe::Reachable::Modes')!;
    const row = checkProperty(
      r.model!,
      machine.id,
      { source: 'flag', carrier: null, pattern: 'cover', scope: 'globally', p: 'state failsafe' },
      { maxConfigs: 2 },
    );
    expect(row.claim).toBe('covered');
    expect(row.exhaustive).toBe(false);
    expect(row.boundHit).not.toBe('none');
    expect(row.qualification).toContain('partial under {maxConfigs 2');
    expect(row.witness).toHaveLength(3);
    // And `decreasingOk` reads FALSE on the same walk — which is what a row
    // reading it would have withheld the witness on.
    expect(publishabilityOf(exploreMachine(r.model!, machine.id, { maxConfigs: 2 })).decreasingOk).toBe(false);
  });

  it('every maximality witness reads the whole gate', () => {
    const maximality = WITNESS_CLAIMS.filter((w) => w.kind === 'maximality');
    expect(maximality.map((w) => w.id)).toEqual(['W3', 'W4']);
    for (const w of maximality) {
      // *This cycle has no exit* / *this run has no successor* is an absence
      // wearing a witness's clothes: a bound and an undecided guard both
      // manufacture it, so the per-step alternative does not substitute.
      expect(w.walkRequires, w.id).toBe('walkIsExact');
      expect(w.perStepAlternative, w.id).toBe(false);
    }
  });

  it('every `ridesOn` resolves, and no rider reads a gate outside the increasing family', () => {
    const riders = WITNESS_CLAIMS.filter((w) => w.ridesOn !== null);
    expect(riders.map((w) => `${w.id}->${String(w.ridesOn)}`)).toEqual([
      'W2->A6',
      'W5->A11',
      'W6->A13',
    ]);
    for (const w of riders) {
      const host = ABSENCE_CLAIMS.find((a) => a.id === w.ridesOn);
      expect(host, `${w.id} rides on ${String(w.ridesOn)}, which is not a row`).toBeDefined();
      // A rider prints only inside its host's published report, so its EFFECTIVE
      // gate is the host's conjoined with its own — which is what "no weaker
      // than what its host publishes under" means here. What the column stops is
      // a rider reading the DECREASING conjunction and a later commit publishing
      // it while the host is suppressed.
      expect(host!.walkRequires, `${w.id}: host ${host!.id}`).toBe('walkIsExact');
      expect(['relationIsTheMachines', 'walkIsExact'], w.id).toContain(w.walkRequires);
    }
  });
});

/* ═══════════ the exactness gate, and the regression it must not cause ═══════════ */

/** `failsafe ⇄ failsafeHold` on dwells, with an escape nothing takes. */
function twoDwellMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Dwells');
  const failsafe = f.state('failsafe', sm.id);
  const failsafeHold = f.state('failsafeHold', sm.id);
  const standby = f.state('standby', sm.id);
  const orphan = f.state('orphan', sm.id);
  f.transition(failsafe.id, failsafeHold.id, { ownerId: sm.id, trigger: 'after(5)' });
  f.transition(failsafe.id, standby.id, { ownerId: sm.id, trigger: 'after(60)' });
  f.transition(failsafeHold.id, failsafe.id, { ownerId: sm.id, trigger: 'after(5)' });
  // The edge that makes the absence lists non-empty: nothing enters `orphan`, so
  // nothing fires this.
  f.transition(orphan.id, failsafe.id, { ownerId: sm.id, trigger: 'after(5)' });
  return { model: m, machineId: sm.id };
}

describe('a timed machine keeps its decreasing claims and loses its increasing ones', () => {
  const { model, machineId } = twoDwellMachine();

  it('is built through the factory because no `.sysml` file can carry it', () => {
    // `accept after(n)` is a parse error and the escaped spelling is a different
    // trigger string, so a timed transition arrives through the API or not at
    // all. That is why this machine is not a corpus file.
    expect(machineAlphabet(model, machineId)).toEqual(['after(5)', 'after(60)']);
    const timed = walkableTransitions(model, machineId).filter(
      (tr) => afterDuration(tr) !== undefined,
    );
    expect(timed).toHaveLength(4);
  });

  it('`decreasingOk` is TRUE on it, and `reach` keeps both absence lists', () => {
    const walk = exploreMachine(model, machineId);
    expect(publishabilityOf(walk).decreasingOk).toBe(true);

    const row = reachReport(model).machines[0];
    expect(row.exhaustive).toBe(true);
    expect(row.suppressed).toBe(false);
    // THE ASSERTION THAT GOES RED THE MOMENT ANYONE POINTS THE DECREASING SIDE
    // AT THE EXACTNESS GATE. Both lists are sound here — an over-approximating
    // walk can only SHRINK them — and a single `ok` would empty both.
    expect(row.states.unreachable.map((s) => s.name)).toEqual(['orphan']);
    expect(row.transitions.dead).toHaveLength(1);
    expect(row.transitions.dead[0].from!.name).toBe('orphan');
    expect(row.qualification).toContain('exhaustive under {maxConfigs 10000');
  });

  it('and the gate is LIVE on that row without touching either list', () => {
    // The A1/A2 non-regression, re-run now that `reach` computes the gate on
    // every machine it walks. The census on this row says the walk is not
    // exact and names the time clause, and the two absence lists beside it are
    // the same non-empty lists they were before the gate existed. This is the
    // assertion that fails the moment anyone points the decreasing side at it.
    const row = reachReport(model).machines[0];
    expect(row.exactness.walkIsExact).toBe(false);
    expect(row.exactness.failedClause).toBe('time');
    expect(row.exactness.timedTransitions).toBe(4);
    expect(row.exactness.alphabet).toBe(2);
    // Unmoved, beside a gate that reads false on the same object.
    expect(row.states.unreachable.map((s) => s.name)).toEqual(['orphan']);
    expect(row.transitions.dead).toHaveLength(1);
    expect(row.suppressed).toBe(false);
    // And the census field that IS gated: a walk this inexact decides nothing
    // about cycles, even though its relation plainly has one.
    expect(row.exactness.acyclic).toBeNull();
    expect(row.exactness.edges).toBeGreaterThan(0);
  });

  it('`walkIsExact` is FALSE on the same walk, and names the time clause', () => {
    const walk = exploreMachine(model, machineId);
    // THE REAL WALK, not a fabricated argument. This test used to assemble the
    // gate's two dwell fields itself, because they did not exist on
    // `ExploreResult` — they ship now, so the assertion below reaches the
    // SHIPPED producers and a regression in either of them lands here.
    const gate = walkIsExact(walk, walk.bounds);
    // The walk finished inside every bound and refused nothing, so the FIRST
    // half of the gate holds — which is exactly why a bound flag would not have
    // caught this machine.
    expect(gate.seenWhole).toBe(true);
    expect(gate.relationIsTheMachines).toBe(false);
    expect(gate.walkIsExact).toBe(false);
    // Its whole alphabet is dwell labels, so the failure is `'time'` and not
    // `'environment'`: there is no trigger here an environment could withhold.
    expect(gate.failedClause).toBe('time');
    expect(gate.sentence).toContain('advances no clock');
  });
});

describe('the exactness gate, clause by clause', () => {
  const base: ExactnessWalk = {
    exhaustive: true,
    boundHit: 'none',
    bounds: { alphabet: [] },
    offered: new Set<string>(),
    unsupported: [],
    undeterminedGuards: [],
    timedTransitions: new Set<ElementId>(),
    timedLabels: new Set<string>(),
  };

  it('holds, with no failed clause, on a walk that saw the machine whole', () => {
    const gate = walkIsExact(base, base.bounds);
    expect(gate.walkIsExact).toBe(true);
    expect(gate.seenWhole).toBe(true);
    expect(gate.relationIsTheMachines).toBe(true);
    expect(gate.failedClause).toBeNull();
  });

  it('`alphabetOffered` is a real conjunct: a trigger the walk never offered withholds', () => {
    // THE ONE CONJUNCT NO MODEL IN THE TREE CAN FALSIFY. `bounds.alphabet` is
    // `[]` on all eleven corpus machines (plan §5(d)), and `exploreMachine`
    // offers the whole alphabet at every configuration it dequeues, so the
    // per-conjunct assertion in the byte-equality block reads `true === true`
    // on every input the file walks and the `!alphabetOffered` sentence branch
    // had no reader at all. This row is what makes the conjunct falsifiable:
    // an alphabet member the walk never offered, which is precisely the walk
    // that would start filtering its inputs and silently narrow what
    // "unreachable" means.
    const withheld = publishabilityOf({
      ...base,
      bounds: { alphabet: ['abort'] },
      offered: new Set<string>(),
    });
    expect(withheld.alphabetOffered).toBe(false);
    expect(withheld.decreasingOk).toBe(false);
    expect(withheld.sentence).toContain('never offered');
    // Offering it restores the conjunct, so the assertion above is about the
    // alphabet and not about some other field of the row.
    const offered = publishabilityOf({
      ...base,
      bounds: { alphabet: ['abort'] },
      offered: new Set(['abort']),
    });
    expect(offered.alphabetOffered).toBe(true);
    expect(offered.decreasingOk).toBe(true);
    // And the branch ORDER `reachOne` ships: the alphabet is named LAST, so a
    // walk that also stopped short is told it stopped short. A reader shown
    // "a trigger was never offered" after a bound would raise the wrong thing.
    const alsoShort = publishabilityOf({
      ...base,
      exhaustive: false,
      bounds: { alphabet: ['abort'] },
      offered: new Set<string>(),
    });
    expect(alsoShort.alphabetOffered).toBe(false);
    expect(alsoShort.sentence).toContain('did not finish');
    expect(alsoShort.sentence).not.toContain('never offered');
  });

  it('reports exactly one clause, in the order two failures must not collide in', () => {
    const bound = walkIsExact({ ...base, exhaustive: false, boundHit: 'configs' }, base.bounds);
    expect(bound.failedClause).toBe('bound');
    expect(bound.seenWhole).toBe(false);

    // The unsupported early return: `exhaustive: false` with `boundHit: 'none'`,
    // which is why `seenWhole` states both conjuncts.
    const unsupported = walkIsExact(
      { ...base, exhaustive: false, unsupported: [{ construct: 'parallel' }] },
      base.bounds,
    );
    expect(unsupported.failedClause).toBe('unsupported');

    const store = walkIsExact({ ...base, undeterminedGuards: [{}] }, base.bounds);
    expect(store.failedClause).toBe('store');
    expect(store.seenWhole).toBe(true);

    const time = walkIsExact({ ...base, timedTransitions: new Set(['t1']) }, base.bounds);
    expect(time.failedClause).toBe('time');

    const environment = walkIsExact({ ...base, bounds: { alphabet: ['abort'] } }, {
      alphabet: ['abort'],
    });
    expect(environment.failedClause).toBe('environment');
  });

  it('every adjacent pair of the order is exercised by a walk that fails BOTH', () => {
    // The single-failure rows above pin which clause each shape reports and
    // nothing about the ORDER — every one of them has the other four clean, so
    // any permutation of the table answers them identically. Measured: moving
    // `'store'` to the front of `firstFailedClause` left all of them green,
    // and a reader of the trapguard shape (`--max-configs 2` over a machine
    // with one guard) would then be told to fix the model when the fix is
    // `--max-configs`. The order is only load-bearing where two clauses fail at
    // once, so each adjacent pair gets a walk that fails both.
    const guard = [{ guard: 'mode == 3', unresolved: ['mode'] }];

    // bound ≺ unsupported. Today's `exploreMachine` cannot produce this pair —
    // its unsupported early return sets `boundHit: 'none'` — but `walkIsExact`
    // is exported through `src/api/index.ts` and takes a structural walk, so a
    // caller can hand it one, and the order must answer even then.
    expect(
      walkIsExact(
        {
          ...base,
          exhaustive: false,
          boundHit: 'configs',
          unsupported: [{ construct: 'parallel' }],
        },
        base.bounds,
      ).failedClause,
    ).toBe('bound');

    // unsupported ≺ environment
    expect(
      walkIsExact(
        { ...base, exhaustive: false, unsupported: [{ construct: 'parallel' }] },
        { alphabet: ['abort'] },
      ).failedClause,
    ).toBe('unsupported');

    // environment ≺ time is asserted on its own below, because it is the pair
    // §3.R's row-precedence test names and the draft of the plan got backwards.

    // time ≺ store
    expect(
      walkIsExact(
        { ...base, timedTransitions: new Set(['t1']), undeterminedGuards: guard },
        base.bounds,
      ).failedClause,
    ).toBe('time');

    // And the two clauses furthest apart, which is the mutation that survived
    // every single-failure row: a bound AND an undecided guard reports the
    // bound, because raising `--max-configs` is what the reader can do.
    const boundAndStore = walkIsExact(
      { ...base, exhaustive: false, boundHit: 'configs', undeterminedGuards: guard },
      base.bounds,
    );
    expect(boundAndStore.failedClause).toBe('bound');
    expect(boundAndStore.sentence).toContain('stopped at a bound');
    expect(
      walkIsExact(
        { ...base, exhaustive: false, unsupported: [{ construct: 'parallel' }], undeterminedGuards: guard },
        base.bounds,
      ).failedClause,
    ).toBe('unsupported');
    expect(
      walkIsExact({ ...base, undeterminedGuards: guard }, { alphabet: ['abort'] }).failedClause,
    ).toBe('environment');
  });

  it('puts `environment` before `time` on a machine that carries both', () => {
    const both = walkIsExact(
      {
        ...base,
        bounds: { alphabet: ['abort', 'after(5)'] },
        timedTransitions: new Set(['t1']),
        timedLabels: new Set(['after(5)']),
      },
      { alphabet: ['abort', 'after(5)'] },
    );
    // An author whose machine names `abort` has something to do about it; the
    // dwell sentence would send them to the wrong carrier.
    expect(both.failedClause).toBe('environment');
  });

  it('never reads `null` while the gate reads false', () => {
    const walks: ExactnessWalk[] = [
      { ...base, exhaustive: false, boundHit: 'configs' },
      { ...base, exhaustive: false, unsupported: [{ construct: 'parallel' }] },
      { ...base, bounds: { alphabet: ['abort'] } },
      { ...base, timedTransitions: new Set(['t1']) },
      { ...base, undeterminedGuards: [{}] },
      // The residue: `exhaustive` and `boundHit` disagreeing with nothing else
      // wrong. Unreachable through today's engine, and still not allowed to
      // publish an exact walk.
      { ...base, exhaustive: false },
    ];
    for (const w of walks) {
      const gate = walkIsExact(w, w.bounds);
      expect(gate.walkIsExact).toBe(false);
      expect(gate.failedClause, JSON.stringify(w.boundHit)).not.toBeNull();
      expect(gate.sentence.length).toBeGreaterThan(20);
    }
    // AND THE RESIDUE DOES NOT LIE ABOUT A BOUND. It is reported under the
    // `'bound'` clause name — the union is the five values the plan pins — but
    // it is reached with `boundHit: 'none'`, so the shared bound prose would
    // send a reader to `--max-configs` for a defect that is not there.
    // Asserting the length only, as this case used to, pinned the false
    // sentence instead of catching it.
    const residual = walkIsExact({ ...base, exhaustive: false }, base.bounds);
    expect(residual.failedClause).toBe('bound');
    expect(residual.sentence).toContain('named no bound');
    expect(residual.sentence).not.toContain('stopped at a bound');
    // The real bound still says it stopped at one.
    expect(
      walkIsExact({ ...base, exhaustive: false, boundHit: 'configs' }, base.bounds).sentence,
    ).toContain('stopped at a bound');
  });

  it('reads the SHIPPED guard predicate, not a narrower "no declared value"', () => {
    // `undeterminedGuards` is populated for a guard that was consulted and
    // decided nothing, which covers a non-boolean operand under `not` and a
    // mixed-type comparison as well as an unvalued feature — so the row for
    // `not mode` over a fully valued `mode` carries an EMPTY `unresolved` and
    // still refuses the gate.
    const fullyValued = walkIsExact(
      { ...base, undeterminedGuards: [{ guard: 'not mode', unresolved: [] }] },
      base.bounds,
    );
    expect(fullyValued.relationIsTheMachines).toBe(false);
    expect(fullyValued.failedClause).toBe('store');
    expect(publishabilityOf({ ...base, undeterminedGuards: [{ guard: 'not mode', unresolved: [] }] }).guardsDetermined).toBe(
      false,
    );
  });
});

/* ═════════ the survey the gate is priced on, re-measured rather than quoted ═══ */

/**
 * What the exactness gate answers on the eleven machines the tree carried when
 * the gate landed, machine by machine.
 *
 * The plan's §5(d) survey is the kill measurement every feature that reads this
 * gate is retired on, and a survey that lives only in a document is a number
 * nobody re-takes. Nine of the eleven machines are exact; the two that are not
 * are the ones that ALREADY report `suppressed: true` today — one on the
 * unsupported construct, one on the guard clause — so the gate suppresses
 * nothing the shipped flag does not already suppress, and the honest reading of
 * that is *the gate is free on THESE ELEVEN*, not *the gate is proven* and not
 * *free on the tree*: the machines added since (`latch.sysml`, then the two
 * `cover` probes) are pinned in the last case below, and two of them are the
 * shape these eleven cannot show — refused on the environment clause with
 * `suppressed: false`.
 */
const EXACTNESS_SURVEY: Array<{
  file: string;
  machine: string;
  walkIsExact: boolean;
  failedClause: string | null;
}> = [
  { file: 'examples/uav-isr.sysml', machine: 'UAVSurveillanceSystem::FlightModes', walkIsExact: true, failedClause: null },
  { file: 'examples/vehicle.sysml', machine: 'VehicleModel::VehicleStates', walkIsExact: true, failedClause: null },
  { file: 'examples/views-tour.sysml', machine: 'DroneDemo::FlightModes', walkIsExact: true, failedClause: null },
  {
    file: 'test/fixtures/agent-authoring/L2-bare-transition-arrow/fixed.sysml',
    machine: 'P::M',
    walkIsExact: true,
    failedClause: null,
  },
  {
    file: 'test/fixtures/agent-authoring/L3-unresolved-transition-end/fixed.sysml',
    machine: 'P::M',
    walkIsExact: true,
    failedClause: null,
  },
  // The one machine class this engine refuses to walk: nothing was explored, so
  // the first half of the gate fails on its own and the relation is empty.
  {
    file: 'test/fixtures/agent-authoring/L3-unresolved-transition-end/input.sysml',
    machine: 'P::M',
    walkIsExact: false,
    failedClause: 'unsupported',
  },
  // The corpus witness for clause (d), and the only one the tree has: an
  // undecidable guard with two decided controls beside it in the same file.
  {
    file: 'test/fixtures/verification/models/guard-undetermined.sysml',
    machine: 'GuardProbe::Ctrl::Modes',
    walkIsExact: false,
    failedClause: 'store',
  },
  {
    file: 'test/fixtures/verification/models/guard-undetermined.sysml',
    machine: 'GuardProbe::Decided::Modes',
    walkIsExact: true,
    failedClause: null,
  },
  {
    file: 'test/fixtures/verification/models/guard-undetermined.sysml',
    machine: 'GuardProbe::Fires::Modes',
    walkIsExact: true,
    failedClause: null,
  },
  {
    file: 'test/fixtures/verification/models/succession-mixed.sysml',
    machine: 'SuccMix::Ctrl::Modes',
    walkIsExact: true,
    failedClause: null,
  },
  {
    file: 'test/fixtures/verification/models/succession-mixed.sysml',
    machine: 'SuccMix::Loop::Modes',
    walkIsExact: true,
    failedClause: null,
  },
];

describe('the exactness survey, over the eleven machines the tree had when the gate landed', () => {
  it('reads the gate machine by machine: nine exact, two refused, and which clause refused each', () => {
    const seen: string[] = [];
    for (const want of EXACTNESS_SURVEY) {
      const model = loaded.find((l) => l.file === want.file)!.model;
      const row = reachReport(model).machines.find((m) => m.machine.qualifiedName === want.machine);
      expect(row, `${want.file} no longer declares ${want.machine}`).toBeDefined();
      expect(row!.exactness.walkIsExact, want.machine).toBe(want.walkIsExact);
      expect(row!.exactness.failedClause, want.machine).toBe(want.failedClause);
      seen.push(want.machine);
    }
    expect(seen).toHaveLength(11);
    expect(EXACTNESS_SURVEY.filter((r) => r.walkIsExact)).toHaveLength(9);
    // THE HONEST HALF OF THE MEASUREMENT: neither refusal is new. Both machines
    // already withheld their lists before this gate existed, so nothing in the
    // corpus can say what the gate would cost anyone else.
    for (const refused of EXACTNESS_SURVEY.filter((r) => !r.walkIsExact)) {
      const model = loaded.find((l) => l.file === refused.file)!.model;
      const row = reachReport(model).machines.find(
        (m) => m.machine.qualifiedName === refused.machine,
      )!;
      expect(row.suppressed, refused.machine).toBe(true);
    }
  }, 300_000);

  it('accounts for every edge on all eleven — the one clause of exactness this corpus exercises', () => {
    // `census.unaccounted` is the ELEMENT-SET half of the gate, and it is the
    // half with real corpus coverage: it is checked on every machine of every
    // walk, including the two the other half refuses. An edge-bearing element
    // nobody accounted for lands here and refuses the machine, which is why
    // `relationIsTheMachines` needs no clause for a missing edge KIND.
    for (const want of EXACTNESS_SURVEY) {
      const model = loaded.find((l) => l.file === want.file)!.model;
      const row = reachReport(model).machines.find((m) => m.machine.qualifiedName === want.machine)!;
      expect(row.census.counts.unaccounted, want.machine).toBe(0);
      expect(row.census.unaccounted, want.machine).toEqual([]);
    }
  }, 300_000);

  it('leaves clauses (b) and (c) unfalsifiable by this corpus, which is what the fixtures are for', () => {
    // No `.sysml` file in the tree carries a dwell — `accept after(n)` is a
    // parse error and `attrs.after` has no notation at all — and none of the
    // eleven names a trigger (the tree's trigger-naming machines sit outside
    // the survey; see the next case). Said plainly here rather than implied:
    // no run of the shipped examples is evidence that either clause behaves
    // correctly.
    for (const want of EXACTNESS_SURVEY) {
      const model = loaded.find((l) => l.file === want.file)!.model;
      const row = reachReport(model).machines.find((m) => m.machine.qualifiedName === want.machine)!;
      expect(row.exactness.timedTransitions, want.machine).toBe(0);
      expect(row.exactness.alphabet, want.machine).toBe(0);
    }
  }, 300_000);

  it('names the machines added since, outside the survey premise: two refused on the environment clause and NOT suppressed, one exact', () => {
    // `latch.sysml` (since eb36d71) and `cover-reachable.sysml` (commit 6)
    // each name a trigger, so clause (c) refuses them and the shipped
    // `suppressed` flag never fired on either — the one shape the eleven
    // above cannot show, and the reason "free on this corpus" is a claim
    // about those eleven. `cover-sealed.sysml` is exact. They stay out of
    // `EXACTNESS_SURVEY` because two of its three premises (refused ⇒
    // suppressed; alphabet 0) are exactly what the first two falsify.
    const outside = [
      { file: 'test/fixtures/verification/models/latch.sysml', machine: 'Latch::Latch::Modes', failedClause: 'environment', alphabet: 1 },
      { file: 'test/fixtures/verification/models/cover-reachable.sysml', machine: 'CoverProbe::Reachable::Modes', failedClause: 'environment', alphabet: 1 },
      { file: 'test/fixtures/verification/models/cover-sealed.sysml', machine: 'CoverProbe::Sealed::Modes', failedClause: null, alphabet: 0 },
    ];
    for (const want of outside) {
      expect(EXACTNESS_SURVEY.some((r) => r.machine === want.machine), `${want.machine} is in the survey`).toBe(false);
      const model = loaded.find((l) => l.file === want.file)!.model;
      const row = reachReport(model).machines.find((m) => m.machine.qualifiedName === want.machine);
      expect(row, `${want.file} no longer declares ${want.machine}`).toBeDefined();
      expect(row!.exactness.walkIsExact, want.machine).toBe(want.failedClause === null);
      expect(row!.exactness.failedClause, want.machine).toBe(want.failedClause);
      expect(row!.suppressed, want.machine).toBe(false);
      expect(row!.exactness.alphabet, want.machine).toBe(want.alphabet);
      expect(row!.exactness.timedTransitions, want.machine).toBe(0);
      expect(row!.census.counts.unaccounted, want.machine).toBe(0);
    }
  }, 300_000);
});

/* ═══════════ one fixture per clause, because that is all they will get ═══════ */

/** Three dwells and no trigger at all: the machine an alphabet-scoped clause (b) reads clean. */
function numericAfterMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('NumericDwells');
  const failsafe = f.state('failsafe', sm.id);
  const hold = f.state('failsafeHold', sm.id);
  const standby = f.state('standby', sm.id);
  for (const [from, to, after] of [
    [failsafe.id, hold.id, 5],
    [failsafe.id, standby.id, 60],
    [hold.id, failsafe.id, 5],
  ] as const) {
    m.create('TransitionUsage', { ownerId: sm.id, attrs: { after }, source: [from], target: [to] });
  }
  return { model: m, machineId: sm.id };
}

/** A named trigger in one region and a dwell in another, on one machine. */
function triggerAndDwellMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Both');
  const nominal = f.state('nominal', sm.id);
  const aborting = f.state('aborting', sm.id);
  const hold = f.state('hold', sm.id);
  f.transition(nominal.id, aborting.id, { ownerId: sm.id, trigger: 'abort' });
  f.transition(aborting.id, hold.id, { ownerId: sm.id, trigger: 'after(5)' });
  return { model: m, machineId: sm.id };
}

describe('each clause of the gate, on the one input that can fail it', () => {
  it('names `environment` on the latch file — one of the two models in the tree that name a trigger (the other, `cover-reachable.sysml`, is pinned in the successors suite)', async () => {
    const file = 'test/fixtures/verification/models/latch.sysml';
    const r = await loadModelText(read(file), { fileName: file });
    const row = reachReport(r.model!).machines[0];
    expect(row.exactness.alphabet).toBe(1);
    expect(row.exactness.walkIsExact).toBe(false);
    expect(row.exactness.failedClause).toBe('environment');
    // The walk is otherwise whole: it is the cooperative environment alone
    // that refuses, and `locked -> nominal` exists only because the walk hands
    // the machine `unlatch` at every configuration.
    expect(row.exhaustive).toBe(true);
    expect(row.suppressed).toBe(false);
  }, 120_000);

  it('names `store` on the trapguard file, whose escape edge the walk never had', async () => {
    const file = 'test/fixtures/verification/models/trapguard.sysml';
    const r = await loadModelText(read(file), { fileName: file });
    const row = reachReport(r.model!).machines.find(
      (m) => m.machine.qualifiedName === 'TrapGuard::Trap::Modes',
    )!;
    expect(row.exactness.undeterminedGuards).toBe(1);
    expect(row.exactness.walkIsExact).toBe(false);
    expect(row.exactness.failedClause).toBe('store');
  }, 120_000);

  it('names `time` on the factory-built dwell machine, and again on the numeric spelling of it', () => {
    const dwell = twoDwellMachine();
    expect(reachReport(dwell.model).machines[0].exactness.failedClause).toBe('time');

    // THE SECOND SPELLING OF CLAUSE (b), and the one the draft's alphabet-scoped
    // version could not see: every edge is a completion transition carrying a
    // numeric `attrs.after`, so the alphabet is empty, no label was ever
    // contributed, and the transition set is the only field that knows.
    const numeric = numericAfterMachine();
    const row = reachReport(numeric.model).machines[0];
    expect(row.exactness.alphabet).toBe(0);
    expect(row.exactness.timedLabels).toBe(0);
    expect(row.exactness.timedTransitions).toBe(3);
    expect(row.exactness.walkIsExact).toBe(false);
    expect(row.exactness.failedClause).toBe('time');
    // And the wrong answer, named: a gate that read `true` here would let a
    // later pass call `{failsafe, failsafeHold}` a set nothing leaves, on a
    // walk whose every edge is a wait the interpreter never grants.
    expect(row.exactness.walkIsExact).not.toBe(true);
    expect(row.exactness.acyclic).toBeNull();
  });

  it('puts `environment` before `time` on a real machine carrying both, not only on a fabricated walk', () => {
    const { model } = triggerAndDwellMachine();
    const row = reachReport(model).machines[0];
    expect(row.exactness.alphabet).toBe(2);
    expect(row.exactness.timedTransitions).toBe(1);
    expect(row.exactness.timedLabels).toBe(1);
    // `abort` is in the alphabet and not in `timedLabels`, so it is a trigger an
    // environment supplies and the author has something to do about it. The
    // dwell sentence would send them to the wrong carrier, and this is the
    // order the modality's own row-precedence rule reads.
    expect(row.exactness.failedClause).toBe('environment');
    expect(row.exactness.failedClause).not.toBe('time');
  });
});
