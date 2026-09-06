/**
 * The literal engine: what the model's OWN values say, and nothing more.
 *
 * THE CHARTER OF THIS FILE, IN ONE LINE: **a point evaluation is not a proof.**
 * This engine substitutes the model's declared feature values into a relation
 * and reads off the answer. That answer is worth having — it is the one every
 * engineer wants first, it needs nothing installed, and it is exactly what the
 * app's Analyze button already computes — but it holds at ONE point of the
 * design space, and the design space is infinite. So:
 *
 *  - The word this engine may print is **`holds-at-values`**, never `proved`.
 *    `verify --engine literal` exits 0 on it because the reader asked for a
 *    point evaluation by name; `--engine auto` and `--engine smt` do not accept
 *    it as a discharge, and {@link ../../api/verification} is where that rule
 *    lives.
 *  - **The assumptions are evaluated FIRST.** A requirement whose `assume`
 *    clause is false at these values is discharged by an antecedent that does
 *    not hold, which tells an engineer nothing: it is `vacuous`, and vacuous is
 *    inconclusive whatever the guarantee says. Reading the guarantee first and
 *    the assumption afterwards would let a `require` that happens to hold print
 *    a pass for a requirement that means nothing here.
 *  - **`checkConstraints` has a THIRD status.** `'unknown'`
 *    (`../evaluate-model.ts`) is neither a pass nor a fail, and the whole reason
 *    this lane exists is that a constraint which silently disappears reads as
 *    one that holds. It is `not-evaluable` — inconclusive, exit 2 — and it is
 *    never quietly folded into either verdict.
 *
 * WHY IT WRAPS `checkConstraints` RATHER THAN RE-EVALUATING. The numeric
 * surface a person already sees in the app is `checkConstraints`, and the
 * differential gate of the plan's §5 compares this engine against the SMT one
 * on the assumption that both read the same relations through the same gates.
 * An engine with its own evaluator would be a third opinion, and three surfaces
 * disagreeing about one model is the defect the whole verification lane was
 * lifted to prevent. `evaluateConstraintQuantityDetailed` is called beside it
 * for the two SI magnitudes, so a refutation can print the numbers that refute
 * it rather than only the relation that failed.
 *
 * Pure and deterministic: nothing here reads or writes anything but its
 * arguments.
 */

import { type ElementId, type Model } from '@core/index';
import { checkConstraints, type ConstraintCheck } from '../evaluate-model';
import { evaluateFeatureValue } from '../evaluate-model';
import { type Obligation } from '../obligations';
import { type ContractRef, type Refusal, type RefusalReason, type VariableRole } from '../contracts';
import { dimToString } from '../units';
import { evaluateConstraintQuantityDetailed } from '../units-eval';

/**
 * What the literal engine concluded about one obligation.
 *
 * Five outcomes, and the split between the last two is the one that matters to
 * the exit contract: `unsupported` is a well-formed relation whose SHAPE this
 * lane does not encode (`%`, a collection, °C arithmetic, or prose with no
 * clause at all — see {@link OUTSIDE_THE_FRAGMENT}), which
 * `--allow-inconclusive` may forgive; `not-evaluable` is a relation whose
 * ANSWER the model does not determine, including one nobody could read — a name
 * that resolves to nothing, kilograms compared against metres — and nothing
 * forgives it. Collapsing the two would let a flag turn "your requirement names
 * a feature that does not exist" into a green build.
 */
export type LiteralOutcome =
  | 'holds-at-values'
  | 'refuted'
  | 'vacuous'
  | 'not-evaluable'
  | 'unsupported';

/**
 * Which gate refusals are "outside the fragment", and which are defects.
 *
 * THIS SET IS THE SCOPE OF `--allow-inconclusive`, indirectly and completely,
 * so it is stated as a set of reasons rather than left to a branch. Every
 * refusal used to map to `unsupported` ⇒ `verification/unsupported-construct`,
 * which the flag may lower to exit 0 — and a requirement whose relation names a
 * feature that DOES NOT EXIST, or compares kilograms against metres, was
 * therefore forgivable. That is a defect in the model, not a construct this
 * lane declines to encode, and forgiving it is exactly the "a constraint that
 * silently disappears reads as one that holds" failure the lane exists to stop.
 *
 * The five reasons here are the ones the plan's own trap table enumerates as
 * outside the encodable fragment — "multiplicity > 1 … string and enum
 * comparisons, `null`, `%` and variable exponents", plus offset-scale
 * arithmetic, which is refused BY DESIGN and equally by the numeric surface.
 * The relation is well-formed; this lane just does not encode its shape.
 *
 * Everything else — `unresolved-name`, `unparseable`, `dimension-clash`,
 * `unit-unresolved`, `unscalable` — is a relation nobody can read AT ALL, and
 * it maps to `not-evaluable`, which nothing forgives.
 */
const OUTSIDE_THE_FRAGMENT: ReadonlySet<RefusalReason> = new Set<RefusalReason>([
  'no-formal-clause',
  'offset-arithmetic',
  'collection-valued',
  'unsupported-operator',
  'non-numeric-operand',
]);

/** One assumption, and what it said at the model's values. */
export interface PremiseReading {
  clause: ContractRef;
  expression: string;
  holds: 'holds' | 'fails' | 'unknown';
  /** The evaluator's own sentence, so an `unknown` names its cause. */
  detail: string;
}

/** One feature the relation reads, with the value the model gives it. */
export interface ValueBinding {
  /** The dotted path the relation writes (`uav.endurance`). */
  path: string;
  /** The same feature by qualified name — never by element id, which is fresh per load. */
  qualifiedName: string;
  /** The value as STORED, in the feature's own declared unit. */
  value: number | boolean | string | null;
  unit: string | null;
  /**
   * How the feature gets its value — and the reason this field is not optional.
   *
   * A `derived` feature stores whatever ITS OWN equation produced, in whatever
   * unit that arithmetic landed in, and `unit` is `null` because the author
   * declared none: `uav.endurance` reads `0.7876923…` (hours) beside a
   * requirement written `>= 45.0 [min]`. A reader shown only the number sees a
   * verdict's own witness refuting it. The role says which values a person
   * could edit to move the verdict and which are computed; the pair the
   * comparison was actually made on is in the bound's `si` slot.
   */
  role: VariableRole;
}

/** What this engine holds about one obligation, and how it got there. */
export interface LiteralJudgement {
  outcome: LiteralOutcome;
  /** The sentence a person reads. Never contains the word `proved`. */
  detail: string;
  /** The assumptions, in the model's order, evaluated before the guarantee. */
  premises: PremiseReading[];
  /** The two sides in coherent SI, when the root was a comparison both sides of which evaluated. */
  lhsSI?: number;
  rhsSI?: number;
  /** The dimension the comparison was made in, printed as the registry writes it. */
  dimension?: string;
  /** The model's own values for the features the relation reads — the witness at this point. */
  bindings: ValueBinding[];
}

/** One judged row: the worklist row, and what this engine made of it. */
export interface LiteralResult {
  row: Obligation;
  judgement: LiteralJudgement;
}

/**
 * Judge every `obligation` row of a worklist at the model's own values.
 *
 * The whole worklist is passed in, not just the rows to judge: the premises of
 * a requirement are rows of the same worklist, and an engine that took only the
 * obligations could not see the assumption that makes one of them vacuous.
 * Axiom rows are read by no one here — a feature value IS the point being
 * substituted, so it needs no separate verdict.
 */
export function judgeLiterally(model: Model, rows: readonly Obligation[]): LiteralResult[] {
  // One sweep of the numeric surface for the whole run: `checkConstraints`
  // walks the model, and calling it per row would walk it once per requirement.
  const checks = new Map<ElementId, ConstraintCheck>();
  for (const c of checkConstraints(model)) checks.set(c.id, c);

  // Premises belong to their requirement, and a row with no requirement (a
  // model-level axiom) has none. Keyed on the requirement's element id, which
  // is an in-memory grouping key and never leaves this function — the digests
  // and the assertion names are keyed on qualified names, per the plan's §6
  // "element ids are not stable" row.
  const premises = new Map<ElementId, Obligation[]>();
  for (const row of rows) {
    if (row.role !== 'premise' || !row.requirement) continue;
    const list = premises.get(row.requirement.id);
    if (list) list.push(row);
    else premises.set(row.requirement.id, [row]);
  }

  const out: LiteralResult[] = [];
  for (const row of rows) {
    if (row.role !== 'obligation') continue;
    out.push({ row, judgement: judgeOne(model, row, checks, premises) });
  }
  return out;
}

/** The reading of one assumption at the model's values. */
function readPremise(row: Obligation, checks: ReadonlyMap<ElementId, ConstraintCheck>): PremiseReading {
  const check = checks.get(row.element.id);
  const holds =
    check?.result === 'satisfied' ? 'holds' : check?.result === 'violated' ? 'fails' : 'unknown';
  return {
    clause: row.element,
    expression: row.expression,
    holds,
    detail:
      check?.message ??
      'the numeric surface never reached this clause, so nothing is known about it here',
  };
}

/**
 * One obligation, judged in the order the plan fixes: assumptions, then the
 * guarantee.
 *
 * The `no-formal-clause` and gate-refused rows are answered before either,
 * because there is nothing for the evaluator to read: a requirement with prose
 * and no constraint body is not a requirement that holds, and the fail
 * direction here is the whole point — the honest answer is "this lane cannot
 * decide it", printed with its reason, never a silence that reads as a pass.
 */
function judgeOne(
  model: Model,
  row: Obligation,
  checks: ReadonlyMap<ElementId, ConstraintCheck>,
  premisesByRequirement: ReadonlyMap<ElementId, Obligation[]>,
): LiteralJudgement {
  const premises = (row.requirement ? premisesByRequirement.get(row.requirement.id) : undefined) ?? [];
  const readings = premises.map((p) => readPremise(p, checks));
  const bindings = bindingsOf(model, row);
  const base = { premises: readings, bindings };

  if (row.status === 'no-formal-clause') {
    const refusal = row.encodable as Refusal;
    return {
      ...base,
      outcome: 'unsupported',
      detail: `nothing to evaluate: ${refusal.detail}`,
    };
  }

  // Assumptions first. A false assumption makes the guarantee's own verdict
  // irrelevant: the requirement is discharged by an antecedent that does not
  // hold, which is the plan's one declared deviation from the standard's
  // `allTrue(assumptions) implies allTrue(constraints)` reading (§6, §8.4.17).
  const failed = readings.find((p) => p.holds === 'fails');
  if (failed) {
    return {
      ...base,
      outcome: 'vacuous',
      detail:
        `vacuous at the model's values: the assumption \`${failed.expression}\` is false here, so the ` +
        'requirement is discharged by an antecedent that does not hold and says nothing about the design',
    };
  }
  const unknownPremise = readings.find((p) => p.holds === 'unknown');
  if (unknownPremise) {
    return {
      ...base,
      outcome: 'not-evaluable',
      detail:
        `not evaluable at the model's values: the assumption \`${unknownPremise.expression}\` does not ` +
        `evaluate here (${unknownPremise.detail}), so a pass could not be called unconditional`,
    };
  }

  const check = checks.get(row.element.id);
  const detailed =
    row.node !== null ? quantities(model, row) : {};

  // A relation the SMT gates refused may still evaluate perfectly well HERE —
  // `%` is the plain case: the numeric surface computes `12 % 2 == 0` and the
  // gate declines to encode a remainder. The point evaluation is real and is
  // reported as such, but the refusal is APPENDED to the sentence rather than
  // dropped: this file's charter is that a relation a gate refuses is listed
  // with its reason, never silently, and a reader who is shown only
  // `holds-at-values` cannot tell that no other engine will ever confirm it.
  // (`no-formal-clause` returned above, so every refusal reaching here is one
  // the gates made about a relation that exists.)
  const gated =
    row.encodable !== true
      ? ` — a gate refuses this relation for the solver lane (${row.encodable.reason}: ${row.encodable.detail}), so a point evaluation is all any engine will offer for it`
      : '';

  if (check?.result === 'satisfied') {
    return {
      ...base,
      ...detailed,
      outcome: 'holds-at-values',
      detail:
        (readings.length === 0
          ? "holds at the model's values (no assumptions — the pass is unconditional at these values)"
          : `holds at the model's values, and so do the ${readings.length} assumption(s) it stands on`) +
        gated,
    };
  }
  if (check?.result === 'violated') {
    return {
      ...base,
      ...detailed,
      outcome: 'refuted',
      detail:
        `refuted with every feature at its model value: \`${row.expression}\` is false here` +
        (detailed.lhsSI !== undefined && detailed.rhsSI !== undefined
          ? ` (${detailed.lhsSI} vs ${detailed.rhsSI}${detailed.dimension ? ` in ${detailed.dimension}` : ''}, coherent SI)`
          : '') +
        gated,
    };
  }

  // Unknown, or a relation the numeric surface never gathered. The split is the
  // one the exit contract is written over: a construct outside this lane's
  // fragment is `unsupported` and `--allow-inconclusive` may forgive it; a
  // relation the values do not decide — INCLUDING one nobody could read, such
  // as a name that resolves to nothing or a comparison across dimensions — is
  // `not-evaluable` and nothing forgives it. See {@link OUTSIDE_THE_FRAGMENT}
  // for why the two are told apart by the refusal's reason and not by the mere
  // fact that a gate spoke.
  const why = check?.message ?? 'the numeric surface never gathered this relation';
  if (row.encodable !== true) {
    const refusal = row.encodable;
    if (OUTSIDE_THE_FRAGMENT.has(refusal.reason)) {
      return {
        ...base,
        outcome: 'unsupported',
        detail: `outside the fragment this lane encodes (${refusal.reason}): ${refusal.detail}`,
      };
    }
    return {
      ...base,
      outcome: 'not-evaluable',
      detail:
        `not evaluable at the model's values — the relation itself cannot be read (${refusal.reason}): ` +
        `${refusal.detail}. This is a defect in the relation, not a construct outside the fragment, ` +
        'so `--allow-inconclusive` does not forgive it',
    };
  }
  return { ...base, outcome: 'not-evaluable', detail: `not evaluable at the model's values: ${why}` };
}

/** The two SI magnitudes and the dimension, when the unit-aware evaluator has them. */
function quantities(
  model: Model,
  row: Obligation,
): { lhsSI?: number; rhsSI?: number; dimension?: string } {
  const el = model.get(row.element.id);
  if (!el) return {};
  const q = evaluateConstraintQuantityDetailed(model, el);
  return {
    ...(q.lhsSI !== undefined ? { lhsSI: q.lhsSI } : {}),
    ...(q.rhsSI !== undefined ? { rhsSI: q.rhsSI } : {}),
    ...(q.dimension !== undefined ? { dimension: dimToString(q.dimension) } : {}),
  };
}

/**
 * The model's own values for every feature the relation reads.
 *
 * This is the witness a `holds-at-values` or a `refuted` verdict stands on, and
 * it is recorded so an evidence record says WHICH point of the design space was
 * evaluated rather than only what happened there. Values are reported as
 * STORED, in the feature's declared unit, because that is what the file says.
 *
 * "What a reader would have to change to move the verdict" is true only of the
 * roles that are *stated*. A `derived` feature stores the magnitude its own
 * equation produced, in whatever unit that arithmetic landed in and with no
 * declared unit at all — which is why every binding carries its role, and why
 * the pair the comparison was made on lives in the bound's `si` slot instead of
 * being inferred from these numbers.
 */
function bindingsOf(model: Model, row: Obligation): ValueBinding[] {
  const out: ValueBinding[] = [];
  for (const v of row.vars) {
    const r = evaluateFeatureValue(model, v.featureId);
    const raw = 'value' in r ? r.value : null;
    out.push({
      path: v.path,
      qualifiedName: v.qualifiedName,
      value:
        typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string' ? raw : null,
      unit: v.unit,
      role: v.role,
    });
  }
  return out;
}
