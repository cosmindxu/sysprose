/**
 * `bounds` — what is the tightest value this measure can take under the model's
 * AXIOMS?
 *
 * THE CHARTER OF THIS FILE, IN ONE LINE: **a bound is exact or it says it is
 * not, and every line names which clauses were axioms.** Everything below is
 * one of those two sentences made mechanical:
 *
 *  - **`require` clauses are NOT axioms.** A requirement is what is being
 *    checked, not a fact about the design, so the axiom set is exactly what
 *    {@link obligationsOf} files as `axiom`: feature values, `bind` equalities
 *    and `assert constraint` bodies. That is why `--measure uav.mtow --free all`
 *    answers **unbounded above** on a file that plainly states
 *    `require constraint { uav.mtow <= 25.0 [kg] }`, and why the exclusion is
 *    repeated on every verdict line rather than once in a header.
 *    `--with-requirements` folds those bodies in, as the implication the
 *    shipped library says a requirement IS, and the line then says so.
 *  - **`assume` clauses are not axioms either, and for the same reason.** An
 *    `assume` is the guard a requirement applies under — requirement context,
 *    not a statement about the design — so folding it in silently would
 *    constrain a measure by half a requirement while the line said no
 *    requirement had been read. The standard's own way to state a range as a
 *    FACT is `assert constraint { … }` (§2.1), and that is an axiom here.
 *  - **Optimality is claimed only where νZ can deliver it.** z3's `Optimize` is
 *    complete for LINEAR real arithmetic; over a nonlinear objective or a
 *    nonlinear axiom set it still returns a value, and calling that value "the
 *    optimum" would be the one sentence §3.7 forbids outright. Such a run is
 *    `bound-without-optimality`, under its own code, and it is exit 2 — a code
 *    `--allow-inconclusive` could lower would put a non-optimal bound back into
 *    a green build through the flag's back door, which is why this outcome does
 *    not share a code with the two merely-undecided ones.
 *  - **An axiom a gate refused is an axiom the bound was not computed over.**
 *    Dropping one WIDENS the design space, so the answer is looser than the
 *    model's — and "looser than the model's" is not a bound this command may
 *    publish as one: a file whose only ceiling on a quantity is a relation the
 *    encoder refused would otherwise read "unbounded above". So a refusal that
 *    shares a symbol with what the objective can REACH stands the row down
 *    ({@link relevantRefusals}), exactly as a refused axiom in reach of a goal
 *    stands a refutation down in {@link ./engines/smt}. A refusal in an
 *    unrelated corner of the file factorises and is only listed.
 *  - **The point z3 stopped at is re-read before the number is published.**
 *    §5's witness gate, which every other SAT-returning surface of this lane
 *    applies: the design point comes back through {@link ./expr}'s own
 *    evaluator and the assertions are re-read at it. A bound is the one answer
 *    here that IS a number the encoder produced, so it is the surface with the
 *    least redundancy — a mis-scaled factor or a flipped sign in a relation the
 *    objective reaches would otherwise be published as `exactly`.
 *  - **Three answers a single number cannot tell apart.** νZ reports a bound as
 *    `[infinity, rational, epsilon]`, and the three coefficients are three
 *    different sentences: unbounded (there is no optimum), a supremum the
 *    design approaches and never attains (`x < 5` has no maximum), and an
 *    optimum that is attained. {@link ObjectiveBound} keeps all three and this
 *    module prints the one that is true.
 *
 * THE OBJECTIVE IS THE STORED MAGNITUDE, and the result is reported in the unit
 * the feature declares. One variable per feature, declared in its STORAGE unit,
 * is the encoder's own charter ({@link ./smt/encode}) — `capacity = 640.0 [Wh]`
 * is the symbol `640`, not `2304000` — and each relation lifts its READS by
 * whatever its own scale map grants. So maximising the symbol maximises the
 * quantity in the unit the file writes, and the SI value is reported beside it
 * rather than instead of it. A feature that declares no unit stores coherent SI
 * already, and the line says which of the two a reader is holding.
 *
 * WHAT THIS IS NOT: the heuristic `optimize` in {@link ./solver}, which is a
 * coordinate descent with a golden-section line search over bounded design
 * variables. That one returns a point it found; this one returns a bound z3
 * proved. The report names both so the two are never read as one, and the L8
 * corpus pins the direction of the difference: a heuristic search may fall
 * short of the optimum and may never beat it.
 *
 * The backend is passed IN, exactly as {@link ./consistency} and
 * {@link ./refinement} take it: whether a solver exists is decided once, in
 * `src/api/verification.ts`, and an absent solver is `verification/tool-absent`
 * rather than a fallback to anything.
 */

import { type ElementId, type Model } from '@core/index';
import {
  contractsOf,
  type Contract,
  type Fragment,
  type Refusal,
  type RefusalReason,
} from './contracts';
import { isLiteralValueAxiom } from './consistency';
import { isFreedValueAxiom } from './engines/smt';
import { evaluate } from './expr';
import { obligationsOf, type Obligation } from './obligations';
import {
  encodeRelation,
  encodeScript,
  encodeVariables,
  symbolOf,
  type EncodeVariable,
  type EncodedRelation,
  type ScriptAssertion,
} from './smt/encode';
import {
  type ObjectiveBound,
  type OptimizeSense,
  type WitnessValue,
  type Z3Backend,
} from './smt/z3-bridge';

/* ─────────────────────────────── the codes ───────────────────────────────── */

/**
 * A bound z3 returned that νZ does not certify as the optimum.
 *
 * ITS OWN CODE, and not one of the two `--allow-inconclusive` may lower. The
 * flag's scope is stated over codes (§2), so filing this under
 * `verification/unsupported-construct` would let `--allow-inconclusive` turn
 * "we found 47.3 and cannot show it is the tightest" into exit 0 — which is
 * exactly "presenting a non-optimal bound as the optimum", the sentence §3.7
 * puts on its MUST-NEVER list, arriving through a flag instead of through a
 * verdict line.
 */
export const OPTIMALITY_NOT_ESTABLISHED_CODE = 'verification/optimality-not-established';

/** Every code this module can file, for the exit-contract tables to key on. */
export const BOUNDS_CODES: readonly string[] = [
  OPTIMALITY_NOT_ESTABLISHED_CODE,
  'verification/inconsistent-axioms',
  'verification/timeout',
  'verification/not-evaluable',
  'verification/unsupported-construct',
];

/**
 * The sentence every verdict line of this command carries about its axiom set.
 *
 * Composed HERE and nowhere else, because §3.7 requires the exclusion to be
 * repeated on every line rather than stated once: a reader who scrolls to a row
 * saying "max mtow: unbounded above" over a file containing
 * `require constraint { uav.mtow <= 25.0 [kg] }` has to be able to see, on that
 * row, that the requirement was not an axiom of it.
 */
export const AXIOMS_ONLY_NOTE =
  'the model’s axioms — feature values, `bind` equalities and `assert constraint` bodies; ' +
  '`require` and `assume` clauses excluded, because a requirement is what is being checked, not a fact';

/** The same sentence when `--with-requirements` folded the requirement bodies in. */
export const WITH_REQUIREMENTS_NOTE =
  'the model’s axioms PLUS the `require` bodies, each asserted as the implication ' +
  '`assume ⇒ require` the shipped library states a requirement to be (`--with-requirements`)';

/* ──────────────────────────────── the shapes ─────────────────────────────── */

/** Which direction, or both. */
export type BoundsSense = OptimizeSense | 'both';

/** How a bounds run is aimed, released and bounded. */
export interface BoundsOptions {
  /** The solver. Absence is decided by the caller, never here. */
  backend: Z3Backend;
  /** The feature whose tightest value is asked for. */
  measureId: ElementId;
  /** `min`, `max`, or both. Two senses are two scripts — see {@link Z3Backend.optimize}. */
  sense?: BoundsSense;
  /** Feature values released, already resolved to qualified names by the caller. */
  free?: ReadonlySet<string>;
  /** Release every feature the file states a LITERAL value for (`--free all`). */
  freeAll?: boolean;
  /** Fold the `require` bodies into the axiom set, and say so on every line. */
  withRequirements?: boolean;
  /** The per-check budget in ms. Every check in this lane is bounded. */
  timeoutMs?: number;
}

/** What one optimisation came to. */
export type BoundOutcome =
  /** An optimum whose optimality νZ established, attained at the witness. */
  | 'optimum'
  /** An exact bound the design approaches and never attains (`x < 5`). */
  | 'supremum'
  | 'infimum'
  /** No finite bound in this direction, under the axioms that were asserted. */
  | 'unbounded'
  /**
   * A bound with no claim that it is the tightest one — a nonlinear run.
   *
   * Finite or infinite: an `oo` reached over a nonlinear script is as much an
   * unestablished claim about the tightest value as a number is, so it files
   * here rather than as `unbounded`.
   */
  | 'bound-without-optimality'
  /** The axioms cannot hold together, so every bound over them is entailed by nothing. */
  | 'vacuous'
  /** A timeout, or a script the solver refused. */
  | 'inconclusive';

/** One direction, and what the optimiser made of it. */
export interface Bound {
  sense: OptimizeSense;
  outcome: BoundOutcome;
  /** The `verification/*` code, for a row that is not a decided bound. */
  code: string | null;
  /** The sentence a person reads. It always names which clauses were axioms. */
  detail: string;
  /** The bound in the magnitude the model STORES, or `null` when there is none. */
  value: number | null;
  /** The same bound lifted to coherent SI (`value·factor + offset`), or `null`. */
  siValue: number | null;
  /** z3's own rendering of the bound — the exact answer, `oo` and `epsilon` included. */
  term: string;
  /** The point the optimiser stopped at, for a decided bound. Empty otherwise. */
  witness: WitnessValue[];
  /** How many solver checks this row cost. */
  checks: number;
}

/** The feature a run is about, named the way a verdict line names it. */
export interface MeasureRef {
  id: ElementId;
  qualifiedName: string;
  declaredName?: string;
  /** The declared unit, or `null` for a feature that stores coherent SI. */
  unit: string | null;
  /** The factor taking the stored magnitude into SI (`si = value·factor + offset`). */
  siFactor: number;
  siOffset: number;
}

/** One relation nothing asserted, with the gate that refused it. */
export interface RefusedAxiom {
  id: ElementId;
  qualifiedName: string;
  expression: string;
  reason: RefusalReason;
  detail: string;
}

/** What one bounds run came to. */
export interface BoundsResult {
  measure: MeasureRef | null;
  bounds: Bound[];
  /** Were the `require` bodies folded in? */
  withRequirements: boolean;
  /** The feature values released, sorted — what `--free` actually let go. */
  released: string[];
  /** How many axioms were asserted, after the reachability trim. */
  axioms: number;
  /** The `require` bodies folded in, by requirement, under the flag only. */
  requirements: string[];
  /** Axioms a gate refused: listed, never dropped silently. */
  refused: RefusedAxiom[];
  /** Is the script z3 saw nonlinear in its BYTES — the question νZ's completeness turns on? */
  nonlinear: boolean;
  /** The plan's two-word fragment vocabulary, over the script this run ran. */
  fragment: Fragment;
  /** The `set-logic` the script declared. `''` when none ran. */
  logic: string;
  /** The unsat core of the axiom check, when the axioms cannot hold together. */
  vacuityCore: string[];
  /** Total solver checks, the axiom check included. */
  checks: number;
  /** The per-check budget every check above ran under. */
  timeoutMs: number | undefined;
}

/* ────────────────────────── encoding one relation ────────────────────────── */

/** One worklist row, encoded under its own scale and the run's free set. */
interface EncodedRow {
  row: Obligation;
  encoded?: EncodedRelation;
  vars: EncodeVariable[];
  refusal?: Refusal;
  /**
   * May the witness gate re-read this row? Absent means yes.
   *
   * False for the DEFINING EQUATION of a derived feature, and for the reason
   * {@link ./consistency}'s own gate gives for skipping the structural axioms:
   * z3 reasons over exact rationals and {@link ./expr} over binary64, so
   * `endurance == capacity * 0.8 / cruisePower` re-read at an exact rational
   * point can differ in the last bit — and reporting an encoder defect for a
   * rounding difference would make the gate a nuisance rather than a check. A
   * feature value the file states as a LITERAL is re-read: it is exact on both
   * sides, and it is where a wrong unit factor would show.
   */
  rereadable?: boolean;
}

/**
 * Encode one row under its OWN scale decision and the caller's free set.
 *
 * The same three lines `judgeBySmt`, `checkConsistency` and `checkRefinement`
 * run, for the same reason: a relation the gates left in raw magnitudes
 * (`range = 5.0 [km]` against a bare `<= 10.0`) is read in kilometres by every
 * surface of this tool, and an encoder that scaled it because it COULD would
 * report `5000 <= 10`. `row.scaled` is the gates' own answer and it is what is
 * passed; nothing here re-derives it.
 */
function encodeRow(row: Obligation, free: ReadonlySet<string>): EncodedRow {
  const spellings = new Set<string>(free);
  for (const v of row.vars) if (free.has(v.qualifiedName)) spellings.add(v.path);
  const vars = encodeVariables(row.vars, row.sortPerVar, { scaled: row.scaled, free: spellings });
  if (row.node === null || row.encodable !== true) {
    return {
      row,
      vars,
      refusal:
        row.encodable === true
          ? { reason: 'unparseable', detail: 'the relation has no readable body' }
          : row.encodable,
    };
  }
  const encoded = encodeRelation(row.node, vars);
  return encoded.ok ? { row, vars, encoded } : { row, vars, refusal: encoded.refusal };
}

/** `(and …)` over the terms that are actually there, or `null` for none. */
function conjunction(terms: readonly string[]): string | null {
  if (terms.length === 0) return null;
  if (terms.length === 1) return terms[0];
  return `(and ${terms.join(' ')})`;
}

/** Everything one encoded row asserts: its relation, and the guards its encoding added. */
function termsOf(row: EncodedRow): string[] {
  if (!row.encoded) return [];
  return [row.encoded.term, ...row.encoded.sideConditions.map((s) => s.term)];
}

/** A refused row, in the shape the report lists it under. */
function refusalOf(row: EncodedRow): RefusedAxiom {
  return {
    id: row.row.element.id,
    qualifiedName: row.row.element.qualifiedName,
    expression: row.row.expression,
    reason: row.refusal?.reason ?? 'unparseable',
    detail: row.refusal?.detail ?? 'the relation was not encoded',
  };
}

/* ───────────────────────────── the assertion set ─────────────────────────── */

/** One assertion, with the row (or rows) it was built from. */
interface Assertion {
  assertion: ScriptAssertion;
  rows: EncodedRow[];
  /**
   * The rows that form the ANTECEDENT, for a requirement folded in as `A ⇒ G`.
   *
   * Absent for an axiom, whose every row is asserted outright. The witness gate
   * needs the split for the reason {@link ./consistency}'s does: what was
   * asserted is the implication, and re-reading a conditional requirement's
   * guarantee at a point its own assumption excludes would report an encoder
   * defect for a requirement that simply does not apply there.
   */
  premiseRows?: EncodedRow[];
}

/** Every symbol an assertion reads. */
function readsOf(a: Assertion): string[] {
  return a.rows.flatMap((r) => r.encoded?.reads ?? []);
}

/**
 * The assertions this measure can reach, by shared symbols.
 *
 * The same closure {@link ./consistency}'s `reachableAxioms` and
 * {@link ./refinement}'s `reachableGamma` compute, and sound for the same
 * reason: an assertion that shares no variable with the objective, directly or
 * transitively, factorises — an assignment satisfying one can always be pasted
 * onto an assignment satisfying the other — so it can change neither the
 * optimum nor whether one exists. What it WOULD change is the answer to "can
 * these hold together at all": a contradiction in an unrelated corner of the
 * file would otherwise make every bound in the model vacuous, which is a
 * statement about that corner dressed as one about this measure.
 */
function reachable(
  all: readonly Assertion[],
  seeds: readonly string[],
): { kept: Assertion[]; reached: Set<string> } {
  const reached = new Set<string>(seeds);
  const kept: Assertion[] = [];
  const taken = new Set<Assertion>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of all) {
      if (taken.has(a)) continue;
      const reads = readsOf(a);
      if (!reads.some((r) => reached.has(r))) continue;
      taken.add(a);
      kept.push(a);
      for (const r of reads) reached.add(r);
      grew = true;
    }
  }
  // `reached` is returned as well as used: it is the set the refused-axiom rule
  // below is written over, and recomputing it there would be a second reading
  // of one closure.
  return { kept, reached };
}

/**
 * A requirement as ONE assertion: `A ⇒ G`, which is what a requirement MEANS.
 *
 * The shipped library says so in its own words — `Requirements::RequirementCheck`
 * is `allTrue(assumptions()) implies allTrue(constraints())` — and `verify` and
 * `consistency` read the same file the same way, so the three commands cannot
 * disagree about what folding a requirement in does. Asserting `A ∧ G` instead
 * would make a mode-conditional requirement constrain a design point its own
 * assumption excludes.
 *
 * A requirement with a clause a gate refused contributes NOTHING: dropping a
 * conjunct of `G` weakens the constraint (a wider design space, a looser bound
 * that reads as the model's) and dropping one of `A` strengthens it (a tighter
 * bound than the file states). Both directions are wrong, so the whole
 * implication stands down and the refusal is listed.
 */
function requirementAssertion(
  contract: Contract,
  clauses: readonly EncodedRow[],
): Assertion | undefined {
  if (clauses.length === 0 || clauses.some((c) => !c.encoded)) return undefined;
  const assumptionIds = new Set(contract.assumptions.map((a) => a.id));
  const premises = clauses.filter((c) => assumptionIds.has(c.row.element.id));
  const goals = clauses.filter((c) => !assumptionIds.has(c.row.element.id));
  const consequent = conjunction(goals.flatMap(termsOf));
  if (consequent === null) return undefined;
  const antecedent = conjunction(premises.flatMap(termsOf));
  return {
    assertion: {
      kind: 'premise',
      name: contract.qualifiedName,
      term: antecedent === null ? consequent : `(=> ${antecedent} ${consequent})`,
    },
    rows: [...clauses],
    premiseRows: premises,
  };
}

/* ──────────────────────────────── the run ────────────────────────────────── */

/** Everything a run needs before a solver is involved. */
interface Prepared {
  measure: MeasureRef | null;
  assertions: Assertion[];
  refused: RefusedAxiom[];
  /**
   * The refusals that can change THIS answer — a subset of {@link refused}.
   *
   * A refused relation sharing a symbol with what the objective reaches, or one
   * with no readable variable at all (its reach is unknown, and the
   * conservative reading of unknown is that it might matter). The rest
   * factorise: an assignment satisfying them can always be pasted onto one
   * satisfying the objective's own closure, so they can move neither the bound
   * nor whether one exists, and listing them is all this run owes them.
   */
  relevantRefusals: RefusedAxiom[];
  released: string[];
  requirements: string[];
  /** Every variable the assertions may read, plus the objective's own. */
  variables: EncodeVariable[];
  nonlinear: boolean;
  syntacticNonlinear: boolean;
}

/**
 * The pure half of a run: release, encode, and gather what the measure reaches.
 *
 * Separated from the deciding half because BOTH halves are needed even when
 * there is no solver: a tool-absent run still has to name the measure it did
 * not bound and the axiom set it would have bounded it over.
 */
export function prepareBounds(
  model: Model,
  opts: { measureId: ElementId; free?: ReadonlySet<string>; freeAll?: boolean; withRequirements?: boolean },
): Prepared {
  const rows = obligationsOf(model);
  const measureName = model.qualifiedName(opts.measureId);

  // THE RELEASE. `--free F` drops the axiom that PINS F, exactly as it does in
  // `verify`; `--free all` drops every feature value the file states, which is
  // the mode `consistency` runs in by default. Nothing else is dropped: a
  // `bind` edge and an `assert constraint` are separate statements about the
  // design and deleting them would widen the space past what was asked for.
  const explicit = opts.free ?? new Set<string>();
  const free = new Set<string>(explicit);
  if (opts.freeAll === true) {
    // `all` is every value the file STATES — a closed expression — and not
    // every feature-value row: `mtow = emptyMass + payload` says how the model
    // COMPUTES a quantity, and releasing it would answer over a design that has
    // no equations in it. The rule is `consistency`'s, imported rather than
    // rewritten.
    for (const r of rows) if (isLiteralValueAxiom(model, r)) free.add(r.element.qualifiedName);
  }
  const released = [...free].sort();

  const encoded = rows.map((row) => encodeRow(row, free));

  // The measure's own facets are read off ANY row that names it — including one
  // this run does not assert. A feature released by `--free all` is still the
  // feature the file declares, with the unit the file declares.
  let measure: MeasureRef | null = null;
  for (const row of encoded) {
    const v = row.row.vars.find((x) => x.featureId === opts.measureId);
    if (!v) continue;
    const el = model.get(opts.measureId);
    measure = {
      id: opts.measureId,
      qualifiedName: measureName,
      ...(el?.declaredName !== undefined ? { declaredName: el.declaredName } : {}),
      unit: v.unit,
      siFactor: v.siFactor,
      siOffset: v.siOffset,
    };
    break;
  }

  const assertions: Assertion[] = [];
  const refused: RefusedAxiom[] = [];
  /** Every refusal beside the variables it would have read, for the reach test. */
  const refusedReach: Array<{ axiom: RefusedAxiom; vars: EncodeVariable[] }> = [];
  for (const row of encoded) {
    if (row.row.role !== 'axiom') continue;
    if (row.row.source === 'feature-value' && isFreedValueAxiom(row.row, free)) continue;
    if (!row.encoded) {
      const axiom = refusalOf(row);
      refused.push(axiom);
      refusedReach.push({ axiom, vars: row.vars });
      continue;
    }
    row.rereadable = row.row.source !== 'feature-value' || isLiteralValueAxiom(model, row.row);
    const label = row.row.element.qualifiedName || row.row.expression;
    for (const term of termsOf(row)) {
      assertions.push({ assertion: { kind: 'axiom', name: label, term }, rows: [row] });
    }
  }

  const requirements: string[] = [];
  if (opts.withRequirements === true) {
    const byRequirement = new Map<ElementId, EncodedRow[]>();
    for (const row of encoded) {
      const id = row.row.requirement?.id;
      // A row whose role is `axiom` is context even inside a requirement body,
      // and the synthetic `no-formal-clause` row is not a relation at all.
      if (id === undefined || row.row.role === 'axiom' || row.row.source === 'none') continue;
      const list = byRequirement.get(id);
      if (list) list.push(row);
      else byRequirement.set(id, [row]);
    }
    for (const contract of contractsOf(model)) {
      const clauses = byRequirement.get(contract.id);
      if (!clauses) continue;
      const built = requirementAssertion(contract, clauses);
      if (!built) {
        for (const c of clauses) {
          if (c.encoded) continue;
          const axiom = refusalOf(c);
          refused.push(axiom);
          refusedReach.push({ axiom, vars: c.vars });
        }
        continue;
      }
      assertions.push(built);
      requirements.push(contract.qualifiedName);
    }
  }

  const { kept, reached } = reachable(assertions, [measureName]);
  const relevantRefusals = refusedReach
    .filter((r) => r.vars.length === 0 || r.vars.some((v) => reached.has(v.qualifiedName)))
    .map((r) => r.axiom);
  const variables: EncodeVariable[] = [];
  const seen = new Set<string>();
  for (const a of kept) {
    for (const v of a.rows.flatMap((r) => r.vars)) {
      if (seen.has(v.qualifiedName)) continue;
      seen.add(v.qualifiedName);
      variables.push(v);
    }
  }
  return {
    measure,
    assertions: kept,
    refused,
    relevantRefusals,
    released,
    requirements: requirements.filter((q) =>
      kept.some((a) => a.assertion.kind === 'premise' && a.assertion.name === q),
    ),
    variables,
    nonlinear: kept.some((a) => a.rows.some((r) => r.encoded?.nonlinear === true)),
    syntacticNonlinear: kept.some((a) => a.rows.some((r) => r.encoded?.syntacticNonlinear === true)),
  };
}

/** The senses one run asks for, in a fixed order so two runs print alike. */
function sensesOf(sense: BoundsSense | undefined): OptimizeSense[] {
  if (sense === 'both') return ['min', 'max'];
  return [sense ?? 'max'];
}

/** The sentence every row of this run carries about what stood behind it. */
function axiomSentence(prepared: Prepared, withRequirements: boolean): string {
  const head = `over ${prepared.assertions.length} assertion(s) — ${withRequirements ? WITH_REQUIREMENTS_NOTE : AXIOMS_ONLY_NOTE}`;
  const released =
    prepared.released.length === 0
      ? 'no feature value was released'
      : `${prepared.released.length} feature value(s) released (${prepared.released.join(', ')})`;
  const refused =
    prepared.refused.length === 0
      ? '0 relations refused'
      : `${prepared.refused.length} relation(s) refused by a gate and not asserted (${prepared.refused
          .map((r) => `${r.qualifiedName}: ${r.reason}`)
          .join('; ')})`;
  return `${head}; ${released}; ${refused}`;
}

/* ─────────────────────── the witness re-evaluation gate ──────────────────── */

/**
 * Substitute the design point back through this tool's own evaluator.
 *
 * §5's rule, applied at the one surface of this lane whose ANSWER is a number
 * the encoder produced: a bound has less redundancy behind it than a
 * refutation, so a wrong unit factor, a sign error or a mis-scaled offset in a
 * relation the objective reaches would otherwise be published as `exactly`.
 * What is re-read is every assertion the objective could reach, in the scope
 * shape {@link ./consistency}'s gate uses — and a requirement folded in by
 * `--with-requirements` is re-read as the IMPLICATION it was asserted as, never
 * as a bare guarantee at a point its own assumption excludes.
 *
 * A symbol the solver did not assign is an unread relation, and an unread
 * relation is NOT a confirmation: it comes back as a failure, because "the
 * point could not be checked" and "the point checks out" must not be the same
 * answer. See {@link EncodedRow.rereadable} for the one class of row this gate
 * deliberately does not read, and why.
 */
function confirmBoundWitness(
  assertions: readonly Assertion[],
  witness: readonly WitnessValue[],
): { ok: true } | { ok: false; why: string } {
  const values = new Map<string, number | boolean>();
  for (const w of witness) if (w.value !== null) values.set(w.symbol, w.value);
  /** One row re-read at the point, or the reason it could not be. */
  const reread = (row: EncodedRow): boolean | string => {
    const node = row.row.node;
    if (node === null) return `\`${row.row.expression}\` has no readable body`;
    const scope = (name: string): unknown => {
      const v = row.vars.find((x) => x.path === name || x.qualifiedName === name);
      if (!v) return undefined;
      const raw = values.get(v.qualifiedName);
      if (raw === undefined) return undefined;
      if (typeof raw === 'boolean') return raw;
      return raw * v.factor + v.offset;
    };
    const out = evaluate(node, scope);
    if (!('value' in out)) {
      return `\`${row.row.expression}\` could not be re-read at the point the solver chose`;
    }
    if (typeof out.value !== 'boolean') {
      return (
        `this tool’s own evaluator makes \`${row.row.expression}\` ${String(out.value)} at the point ` +
        'the solver chose, not a truth value'
      );
    }
    return out.value;
  };
  for (const a of assertions) {
    const premises = a.premiseRows ?? [];
    let engaged = true;
    for (const p of premises) {
      if (p.rereadable === false || p.row.node === null) continue;
      const value = reread(p);
      if (typeof value === 'string') return { ok: false, why: value };
      if (!value) {
        engaged = false;
        break;
      }
    }
    if (!engaged) continue;
    for (const row of a.rows) {
      if (premises.includes(row)) continue;
      if (row.rereadable === false || row.row.node === null) continue;
      const value = reread(row);
      if (typeof value === 'string') return { ok: false, why: value };
      if (!value) {
        return {
          ok: false,
          why:
            `this tool’s own evaluator makes \`${row.row.expression}\` false at the point the solver ` +
            'chose, not true',
        };
      }
    }
  }
  return { ok: true };
}

/**
 * The tightest value a measure can take, in each direction that was asked for.
 *
 * Asynchronous only because the solver is. Everything else is a pure function
 * of the model and the options.
 */
export async function checkBounds(model: Model, opts: BoundsOptions): Promise<BoundsResult> {
  const withRequirements = opts.withRequirements === true;
  const prepared = prepareBounds(model, {
    measureId: opts.measureId,
    ...(opts.free !== undefined ? { free: opts.free } : {}),
    ...(opts.freeAll !== undefined ? { freeAll: opts.freeAll } : {}),
    withRequirements,
  });
  const census = axiomSentence(prepared, withRequirements);
  const base = {
    measure: prepared.measure,
    withRequirements,
    released: prepared.released,
    axioms: prepared.assertions.length,
    requirements: prepared.requirements,
    refused: prepared.refused,
    nonlinear: prepared.syntacticNonlinear,
    timeoutMs: opts.timeoutMs,
  };

  // A MEASURE NO RELATION READS IS NOT A MEASURE THIS LANE CAN BOUND. There is
  // no variable to declare, no sort to give it and no axiom about it — and
  // "unbounded", the arithmetically true answer, would read as a finding about
  // a model that never mentions the quantity in a relation at all.
  if (prepared.measure === null) {
    return {
      ...base,
      // ONE ROW PER SENSE, exactly as a run that reached the solver publishes:
      // `--sense both` asks two questions and gets two answers, and a payload
      // whose shape depended on whether a solver had loaded would make the
      // tool-absent census a different document from the run it stands in for.
      bounds: sensesOf(opts.sense).map((sense) => ({
        sense,
        outcome: 'inconclusive' as const,
        code: 'verification/unsupported-construct',
        detail:
          `no relation this lane encodes reads \`${model.qualifiedName(opts.measureId)}\`, so there ` +
          `is nothing to optimise over: a measure is bounded by the relations that mention it. ` +
          `${census}`,
        value: null,
        siValue: null,
        term: '',
        witness: [],
        checks: 0,
      })),
      fragment: 'qf-lra',
      logic: '',
      vacuityCore: [],
      checks: 0,
    };
  }

  const symbol = symbolOf(prepared.measure.qualifiedName);
  const script = encodeScript({
    variables: prepared.variables,
    assertions: prepared.assertions.map((a) => a.assertion),
    nonlinear: prepared.nonlinear,
    syntacticNonlinear: prepared.syntacticNonlinear,
  });
  // THE OBJECTIVE HAS TO BE DECLARED EVEN WHEN NOTHING ASSERTS IT. `encodeScript`
  // declares the symbols its assertions actually read, which is right for a
  // check and wrong for an optimisation: `--free all` releases the very axiom
  // that pinned the measure, and `(maximize |…::mtow|)` over an undeclared
  // symbol is a script z3 refuses outright — reported as a defect in this tool
  // rather than as the unbounded answer it is.
  const declared = script.symbols.includes(prepared.measure.qualifiedName);
  const objectiveSort =
    prepared.variables.find((v) => v.qualifiedName === prepared.measure!.qualifiedName)?.sort ??
    'Real';
  const preamble = declared || symbol === undefined ? '' : `(declare-fun ${symbol} () ${objectiveSort})\n`;
  const symbols = declared
    ? script.symbols
    : [...script.symbols, prepared.measure.qualifiedName];

  let checks = 0;
  // STEP 0: can the axioms hold together at all? A bound over an unsatisfiable
  // set is entailed by a contradiction, exactly as a refinement obligation is,
  // and the core is what makes the row actionable.
  const consistency = await opts.backend.check(script.text, {
    timeoutMs: opts.timeoutMs,
    variables: script.symbols,
  });
  checks += 1;

  const bounds: Bound[] = [];
  for (const sense of sensesOf(opts.sense)) {
    if (consistency.status === 'unsat') {
      bounds.push({
        sense,
        outcome: 'vacuous',
        code: 'verification/inconsistent-axioms',
        detail:
          `the assertions this bound would stand on cannot hold together ` +
          `(core ${consistency.core.length > 0 ? consistency.core.join(', ') : 'the solver named none'}), ` +
          `so every bound over them is entailed by a contradiction and none is claimed. ${census}`,
        value: null,
        siValue: null,
        term: '',
        witness: [],
        checks: 0,
      });
      continue;
    }
    const before = checks;
    const outcome = await opts.backend.optimize(
      `${script.text}${preamble}(${sense === 'max' ? 'maximize' : 'minimize'} ${symbol})\n`,
      sense,
      { timeoutMs: opts.timeoutMs, variables: symbols },
    );
    checks += 1;
    bounds.push(boundRow(sense, outcome, prepared, census, checks - before));
  }

  return {
    ...base,
    bounds,
    fragment: script.fragment,
    logic: script.logic,
    vacuityCore: consistency.status === 'unsat' ? [...consistency.core] : [],
    checks,
  };
}

/** One optimiser answer as a row, with the claim it is allowed to make. */
function boundRow(
  sense: OptimizeSense,
  outcome: {
    status: string;
    reason: string;
    timeoutMs: number;
    bound: ObjectiveBound | null;
    witness: WitnessValue[];
  },
  prepared: Prepared,
  census: string,
  checks: number,
): Bound {
  const word = sense === 'max' ? 'max' : 'min';
  const name = prepared.measure?.qualifiedName ?? '';
  const empty = { sense, value: null, siValue: null, term: '', witness: [] as WitnessValue[], checks };
  if (outcome.status === 'unknown') {
    return {
      ...empty,
      outcome: 'inconclusive',
      code: 'verification/timeout',
      detail:
        `the optimiser did not answer inside ${outcome.timeoutMs} ms (${outcome.reason || 'no reason given'}), ` +
        `so nothing is claimed about the ${word} of \`${name}\`. ${census}`,
    };
  }
  if (outcome.status !== 'sat' || outcome.bound === null) {
    return {
      ...empty,
      outcome: 'inconclusive',
      code: 'verification/not-evaluable',
      detail:
        `the solver refused the script this tool produced: ${outcome.reason || 'no bound came back'}. ` +
        `That is a defect in this tool, not in the model. ${census}`,
    };
  }

  // AN AXIOM A GATE REFUSED IN REACH OF THE OBJECTIVE IS A MISSING AXIOM, and a
  // bound over a set smaller than the file's is not the file's bound. Dropping
  // one WIDENS the design space, so the row that would be published is looser
  // than the model's — and every decided outcome here is a claim that it is
  // not: `unbounded` says no ceiling exists, `optimum` says this one is the
  // tightest. The reach test is the one {@link ./engines/smt} applies before it
  // publishes a refutation, for the same reason and over the same closure.
  if (prepared.relevantRefusals.length > 0) {
    return {
      ...empty,
      outcome: 'inconclusive',
      code: 'verification/not-evaluable',
      detail:
        `the ${word} of \`${name}\` was computed over a PARTIAL axiom set: ` +
        `${prepared.relevantRefusals.length} relation(s) a gate refused share a symbol with what this ` +
        `objective reaches (${prepared.relevantRefusals
          .map((r) => `${r.qualifiedName}: ${r.reason}`)
          .join('; ')}), and the very relation that was dropped may be the one that bounds it. A bound ` +
        `over a widened space is looser than the model’s, so none is claimed. ${census}`,
    };
  }

  const bound = outcome.bound;
  const scale = prepared.measure;
  const si = (v: number): number => v * (scale?.siFactor ?? 1) + (scale?.siOffset ?? 0);
  const unit = scale?.unit;
  const inUnit = (v: number): string =>
    unit === null || unit === undefined
      ? `${v} (coherent SI; the feature declares no unit)`
      : `${v} [${unit}] (${si(v)} in coherent SI)`;

  // THE POINT IS RE-READ BEFORE ANY OF IT IS PUBLISHED. §5's gate, and it comes
  // before the three decided outcomes rather than beside the one that prints a
  // witness: what the gate checks is the ENCODING, and an encoding this tool
  // cannot reproduce is one no answer of this run may stand on — the `oo` and
  // the supremum included, whose rows publish no point at all.
  const confirmation = confirmBoundWitness(prepared.assertions, outcome.witness);
  if (!confirmation.ok) {
    return {
      ...empty,
      outcome: 'inconclusive',
      code: 'verification/not-evaluable',
      term: bound.term,
      detail:
        `the optimiser answered and this tool’s own evaluator would not confirm the point it stopped ` +
        `at: ${confirmation.why}. A bound whose design point this tool cannot reproduce is a statement ` +
        `about the encoding and not about the model, so none is claimed. ${census}`,
    };
  }

  if (bound.infinite !== 0) {
    // NOT EVEN AN `oo` IS PROVED OVER A NONLINEAR SCRIPT. νZ is complete for
    // linear real arithmetic and nothing else, and "unbounded" is as much a
    // claim about the tightest value as a number is — so the nonlinearity rule
    // below governs this branch too rather than being skipped by it.
    if (prepared.syntacticNonlinear) {
      return {
        ...empty,
        outcome: 'bound-without-optimality',
        code: OPTIMALITY_NOT_ESTABLISHED_CODE,
        term: bound.term,
        detail:
          `${word} \`${name}\`: no finite bound came back (z3: \`${bound.term}\`), and this script is ` +
          `not linear — νZ is complete for linear real arithmetic, so an unboundedness it reached over ` +
          `a nonlinear script is not one it established either. ${census}`,
      };
    }
    return {
      ...empty,
      outcome: 'unbounded',
      term: bound.term,
      // NO WITNESS ON AN UNBOUNDED ROW. The optimiser still hands back the
      // point it stopped at, and that point is not a witness to anything: an
      // objective with no maximum has no maximising design, so printing
      // `mtow = 0` beside "unbounded above" invites exactly the reading the row
      // exists to deny.
      witness: [],
      detail:
        `${word} \`${name}\`: unbounded ${sense === 'max' ? 'above' : 'below'} — ${census}`,
      code: null,
    };
  }
  const value = bound.value;
  if (value === null) {
    return {
      ...empty,
      outcome: 'inconclusive',
      code: 'verification/not-evaluable',
      term: bound.term,
      detail:
        `the optimum has no decimal reading (\`${bound.term}\`) — an algebraic number this tool ` +
        `will not round into a verdict. ${census}`,
    };
  }
  // NONLINEAR: A VALUE, NEVER "THE OPTIMUM". νZ is complete for linear real
  // arithmetic; what it returns over a nonlinear script is a bound it reached,
  // and §3.7 forbids presenting one of those as the optimum. The test is over
  // the SYNTAX of the script z3 was handed, which is the same question the
  // `set-logic` line answers and the conservative one: a product whose operand
  // an axiom happens to pin still reaches z3 as `(* |a| |b|)`.
  if (prepared.syntacticNonlinear) {
    return {
      ...empty,
      outcome: 'bound-without-optimality',
      code: OPTIMALITY_NOT_ESTABLISHED_CODE,
      term: bound.term,
      value,
      siValue: si(value),
      witness: outcome.witness,
      detail:
        `${word} \`${name}\`: bound found at ${inUnit(value)}, optimality not established (nonlinear) — ` +
        `z3’s νZ is complete for linear real arithmetic and this script is not linear, so this is a ` +
        `value it reached and not one it established as the tightest. ${census}`,
    };
  }
  if (bound.epsilon !== 0) {
    return {
      ...empty,
      outcome: sense === 'max' ? 'supremum' : 'infimum',
      code: null,
      term: bound.term,
      value,
      siValue: si(value),
      // NO WITNESS ON A SUPREMUM ROW EITHER, and for the reason the row itself
      // gives: the bound is never attained, so no design takes it and the point
      // the optimiser stopped at is a feasible design that is NOT at the bound.
      // Printing `payload = 5` beside "6 exactly, approached and never
      // attained" invites the one reading this row exists to deny. The point is
      // still re-read above — the gate is about the encoding, not about what is
      // printed.
      witness: [],
      detail:
        `${word} \`${name}\`: ${inUnit(value)} exactly, ${sense === 'max' ? 'approached from below' : 'approached from above'} ` +
        `and never attained — the assertions bound it strictly (z3: \`${bound.term}\`), so no design ` +
        `takes this value. ${census}`,
    };
  }
  return {
    ...empty,
    outcome: 'optimum',
    code: null,
    term: bound.term,
    value,
    siValue: si(value),
    witness: outcome.witness,
    detail:
      `${word} \`${name}\` = ${inUnit(value)} exactly (linear optimum, optimality established by z3’s νZ) ` +
      `${census}`,
  };
}
