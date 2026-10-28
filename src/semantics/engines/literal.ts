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
 *  - **A point the model contradicts decides nothing.** An `assert` that is
 *    false at the model's values is a model that contradicts itself (SysML
 *    §7.20.1), and a relation over a value that contradiction reaches has no
 *    point at which its pass or its failure is unconditional: it is
 *    `contradicted` — inconclusive, exit 2, the SMT engine's
 *    `verification/inconsistent-axioms` — naming the assertion
 *    ({@link contradictionsOf}). The check still reads the values, and reports
 *    the assertion violated. So is a binding the check reports violated — a
 *    `bind` whose two ends the model gives values that differ — over the values
 *    it joins (D1): a binding holds in every instance, as an assertion does.
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
import { checkConstraints, checksByRow, type ConstraintCheck } from '../evaluate-model';
import {
  bindingHolder,
  contradictedDefinitionNaming,
  contradictedDefinitions,
  isFailedReading,
  isShadowedBody,
  readsContradictedDefinition,
  sharedDefinitions,
  type ContradictedDefinition,
} from '../defining-equation';
import { effectiveQualifiedName, redefinedClosure } from '../inheritance';
import { evaluateFeatureValue, featuresWithoutValue, valueAtPath } from '../evaluate-model';
import { rowElement, type Obligation } from '../obligations';
import {
  type ContractRef,
  type ContractVariable,
  type Refusal,
  type RefusalReason,
  type VariableRole,
} from '../contracts';
import { withinTolerance } from '../exact';
import { dimToString } from '../units';
import { evaluateConstraintQuantityDetailed, type DerivationMemo } from '../units-eval';

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
 *
 * `contradicted` is a relation that WOULD evaluate, over a value an `assert`
 * the model holds false at its values reaches: the point it would be judged
 * at is one the model contradicts, so neither its pass nor its failure is
 * unconditional, and nothing forgives it either.
 */
export type LiteralOutcome =
  | 'holds-at-values'
  | 'refuted'
  | 'vacuous'
  | 'not-evaluable'
  | 'unsupported'
  | 'contradicted';

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
 * `unread-definition` is NOT here, although it is no defect in the relation
 * either: a relation that turns on a value only an asserted equation defines,
 * read where the validation surface reads no definition (a feature chain
 * `p.e`, a feature a definition inherits). Its answer EXISTS in the model —
 * `p.e <= 1.0` over P's `e == x * 2.0` (6) is false there — so forgiving it
 * let a requirement the model violates exit 0 under `--allow-inconclusive`.
 * It is undecided, and `not-evaluable`, as the chain it replaced was.
 *
 * Everything else — `unresolved-name`, `unparseable`, `dimension-clash`,
 * `unit-unresolved`, `unscalable`, `derived-bare-literal` (a bare number
 * compared with a value derived from dimensioned quantities, which has no unit
 * to read it in), `refused-derivation` (an operand whose own derivation the
 * validation surface refuses), `unread-definition` and `unread-binding` (a
 * value a binding this tool does not read through may carry: a limit of this
 * tool, {@link refusalTail}) — is a relation this tool cannot read, and it
 * maps to `not-evaluable`, which nothing forgives.
 * An operand that is a point on an offset scale in arithmetic, or whose
 * derivation does arithmetic on one, is refused as `offset-arithmetic`, the
 * same refusal as that arithmetic in the body.
 */
const OUTSIDE_THE_FRAGMENT: ReadonlySet<RefusalReason> = new Set<RefusalReason>([
  'no-formal-clause',
  'offset-arithmetic',
  'collection-valued',
  'unsupported-operator',
  'non-numeric-operand',
]);

/**
 * The `not-evaluable` reading of a relation whose verdict the numeric surface
 * left undecided ONLY because it reads a name that surface reads no value for
 * in its context (`Obligation.unread`) — or `undefined`. Shared with the SMT
 * engine, which reaches the same row through an unconfirmed witness: the two
 * must file it under one code and one sentence.
 *
 * Only: a relation that ALSO reads a value the model never states (`p.e <=
 * x`, `x` declared without one) is undecided for that defect too, and is
 * left to the plain `not-evaluable` sentence that names it — never filed as
 * a limit of the tool ({@link featuresWithoutValue}). Neither is forgiven
 * (see {@link OUTSIDE_THE_FRAGMENT}).
 */
export function unreadOutcome(
  model: Model,
  row: Obligation,
  check: ConstraintCheck | undefined,
): { reason: RefusalReason; detail: string } | undefined {
  if (!row.unread || row.unread.length === 0 || check?.result !== 'unknown') return undefined;
  const unread = new Set(row.unread);
  const others = row.vars.filter((v) => !unread.has(v.path)).map((v) => v.featureId);
  if (featuresWithoutValue(model, others).length > 0) return undefined;
  return {
    reason: 'unread-definition',
    detail:
      `not evaluable at the model's values (unread-definition): ${check.message.replace(/^Could not evaluate: /, '')}. ` +
      'The relation reads a value whose definition is written in another context, where this tool does not read it. ' +
      'That value exists in the model, so the relation is undecided here and `--allow-inconclusive` does not forgive it',
  };
}

/**
 * Is this refusal a SHAPE this lane declines to encode, rather than a relation
 * nobody can read?
 *
 * Exported because the SMT engine has to answer it the same way. Two engines
 * with two copies of this set would be two different scopes for
 * `--allow-inconclusive` — the flag would forgive a misspelt feature name under
 * one engine and refuse it under the other, over the same file.
 */
export function isOutsideTheFragment(reason: RefusalReason): boolean {
  return OUTSIDE_THE_FRAGMENT.has(reason);
}

/**
 * The sentence that closes a `not-evaluable` row a gate refused, by its
 * reason: a relation this tool does not read where the model gives it a value
 * (`unread-binding`, a binding or a value that equates two parts, or an
 * asserted equation over a `default` read through one or a reference;
 * `unread-definition`, a value the model states in a context this tool does
 * not read it in) is a LIMIT OF THIS TOOL — the relation is well-formed and
 * the model decides it — except a body over a parameter of its own
 * ({@link isShadowedBody}), which may state no value and is no one's to
 * decide — and a per-instance reading that threw ({@link isFailedReading}) is
 * a failure of the tool. Every other such
 * reason is a defect in the relation. None is forgiven, and the exit code is
 * the same 2; only what a person is told to fix differs. Shared with the SMT
 * engine, which files the same rows.
 */
export function refusalTail(reason: RefusalReason, detail = ''): string {
  if (reason === 'unread-definition') {
    return isFailedReading(detail)
      ? 'This is a failure of this tool, not a defect in the relation: its reading of the relation threw, so ' +
          '`--allow-inconclusive` does not forgive it'
      : isShadowedBody(detail)
        ? 'This is a limit of this tool, not a defect in the relation: its body is over a parameter of its own, ' +
          'which this tool does not read, so `--allow-inconclusive` does not forgive it'
        : 'This is a limit of this tool, not a defect in the relation: the model decides it, so ' +
          '`--allow-inconclusive` does not forgive it';
  }
  return reason === 'unread-binding'
    ? 'This is a limit of this tool, not a defect in the relation: the model gives it a value, so ' +
        '`--allow-inconclusive` does not forgive it'
    : 'This is a defect in the relation, not a construct outside the fragment, so ' +
        '`--allow-inconclusive` does not forgive it';
}

/** What a `not-evaluable` row a gate refused says is wrong, by its reason: the head of the sentence {@link refusalTail} closes. */
export function refusalHead(reason: RefusalReason, detail = ''): string {
  return reason === 'unread-definition' && isFailedReading(detail)
    ? 'this tool failed while reading the relation'
    : reason === 'unread-binding' || reason === 'unread-definition'
      ? 'the relation reads a value this tool does not read'
      : 'the relation itself cannot be read';
}

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
  /**
   * The value as STORED, in the feature's own declared unit — `null` where the model gives none, and for a
   * path read through an instance where the check's scalar scope finds none ({@link modelBindings}).
   */
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
  const swept = checkConstraints(model);
  const checks = checksByRow(swept);

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

  // One derivation memo for the run's SI readings, as the sweep above shares
  // one: built per row, it re-read every scope of the model once per row.
  const memo: DerivationMemo = new Map();
  const contradicted = contradictionsOf(model, rows, swept, checks);
  const out: LiteralResult[] = [];
  for (const row of rows) {
    if (row.role !== 'obligation') continue;
    out.push({ row, judgement: judgeOne(model, row, checks, premises, memo, contradicted) });
  }
  return out;
}

/** An `assert` the check holds false at the model's values, as a contradicted row's sentence names it. */
interface ContradictingAssert {
  expression: string;
  qualifiedName: string;
}

/** The asserts a relation's point is contradicted by, and what it reads that their contradiction reaches. */
interface ContradictedRead {
  /** The `assert` rows the check holds false at the model's values, in the worklist's order. */
  asserts: ContradictingAssert[];
  /**
   * The asserted equations that give one feature with no value two values the check reports apart (`definitionConflicts`
   * of ../evaluate-model): each is a contradiction of the model's whose equations' own rows the check no longer reads.
   */
  sets: ContradictedDefinition[];
  /**
   * The bindings the check reports violated (`bindingConflicts` of ../evaluate-model), each as a sentence names it:
   * Q's `bind p.load = L`, and the contexts it is violated in where only a context changes what it joins.
   */
  bindings: NamedBinding[];
  /** The paths the relation itself reads that those asserts' contradiction reaches. */
  paths: string[];
  /** The assumptions it stands on that read a path that contradiction reaches, each with those paths. */
  premises: { expression: string; paths: string[] }[];
}

/**
 * A violated assert whose contradiction this engine cannot place: one that reads no feature (`1.0 == 2.0`,
 * false whatever the values), or one the check reports violated in an instance the worklist files no row of
 * that assert for — so no axiom row says which values it reads there. Either contradicts every point.
 */
interface UnplacedContradiction extends ContradictingAssert {
  /**
   * `constant`: it reads no feature; `unread`: the check's instance (`where`) has no worklist row; `equations`: two
   * asserted equations the check reports giving one feature two values (`set`), none of which the worklist files;
   * `binding`: a binding the check reports violated (`expression` and `qualifiedName` name it), of which the
   * worklist files no row that reads a feature.
   */
  kind: 'constant' | 'unread' | 'equations' | 'binding';
  where?: string;
  set?: ContradictedDefinition;
}

/**
 * Which values an `assert` the model holds false at its own values contradicts — as a lookup from a relation
 * and the assumptions it stands on to the asserts whose contradiction reaches what they read, or `undefined`.
 *
 * A violated assert is a model that contradicts itself (SysML §7.20.1), and the SMT engine says so for
 * every row of the file (`verification/inconsistent-axioms`; only for the rows whose proof context holds the
 * assert, where a gate refuses it). The literal engine reads one point, and a relation over a value the
 * contradiction never reaches still holds or fails at it as the model states; one over a value it does
 * reach is judged at a point the model contradicts, and is `contradicted`.
 *
 * "Reaches" is the component of the axiom rows' symbols: two symbols one axiom row reads (a feature's value
 * and what it is derived from, the two ends of a binding, an assert's operands) are one component, and every
 * assert the check reports violated contradicts the component of the symbols it reads. An instance's own
 * value row (`load == 1` for Q3's p) is joined to the feature it is the instance's value of (`Q::p::load`),
 * so the binding that carries it there (`bind p.load = L`, filed once, in Q) comes with it. A minimal set of
 * the model's facts that cannot all hold reads one component, so every value one of them pins is in it; the
 * component may hold more, which this engine leaves undecided too — an abstention, never a verdict: a
 * sibling summed beside the contradicted value, and every instance that reads the feature under the one
 * symbol the SMT engine gives every instance it does not tell apart (q1's `assert p.x == 50.0` over P's `x
 * default = 2.0` reads `P::x`, so P's own `c` and q2's p's read the contradiction too, as they do to the SMT
 * engine).
 *
 * The seeds fail closed. An assert the check reports violated anywhere — on its own row or in any instance
 * — seeds every worklist row of it that the check does not hold true under that row's own id: a row read
 * for an instance the check reads alike with another (BND's `tie in q2`, read as the generic row) has no
 * check entry of its own, and its contradiction is the generic row's. So does every worklist row of two asserted
 * equations the check reports giving one feature with no value two values (`definitionConflicts` of
 * ../evaluate-model): their own rows are no longer read violated, and the names their defining sides read (`a`
 * of `L == a * 2.0`, the package's `g` of `W == m * g`) join the feature's component through them. An instance's
 * symbol in an axiom row (`SP2::Q3::p::load`, Q3's p's) is joined to the feature it reads and to every feature
 * that one redefines (`SP2::Q::p::load`), so a contradiction there reaches the bindings and values filed for the
 * feature in the definition (Q's `bind p.load = L`, whose L is `= 1.0`), whether or not another relation reads
 * the instance. A violated assert this engine cannot place ({@link UnplacedContradiction}) reaches every relation.
 *
 * So does a binding the check reports violated (`bindingConflicts` of ../evaluate-model, D1): a `bind` whose two ends
 * the model gives values that differ is a model that contradicts itself as much as an assert held false — a binding
 * holds in every instance, as an assertion does (decision 1) — and the SMT engine's axioms for it are inconsistent.
 * Its axiom rows (`source: 'bind'`: the connector's own, and its reading in each context that changes what it joins)
 * seed the component the same way, so what the binding joins, and everything the model's values, bindings and
 * assertions tie to it, is read by no verdict. A binding is violated anywhere as an assert is: every row of it is a
 * seed, as the SMT engine holds every one as an axiom. The check keeps deciding the values beside it. A violated
 * binding the worklist files no row of that reads a feature reaches every relation.
 */
function contradictionsOf(
  model: Model,
  rows: readonly Obligation[],
  raw: readonly ConstraintCheck[],
  checks: ReadonlyMap<ElementId, ConstraintCheck>,
): {
  unplaced: UnplacedContradiction[];
  reach: (row: Obligation, premises: readonly Obligation[]) => ContradictedRead | undefined;
} {
  const none = { unplaced: [], reach: () => undefined };
  // The asserts the check reports violated, anywhere, and the row ids (with their aliases, as
  // `checksByRow` keys them) of each violated reading.
  const violatedAnywhere = new Set<ElementId>();
  const violatedAt: { assert: ConstraintCheck; keys: string[]; where?: string }[] = [];
  for (const c of raw) {
    if (model.get(c.id)?.attrs.requirementRole !== 'assert') continue;
    if (c.result === 'violated') violatedAt.push({ assert: c, keys: [c.id] });
    for (const i of c.instances ?? []) {
      if (i.result !== 'violated') continue;
      const at = i.instance ?? i.contextId;
      violatedAt.push({
        assert: c,
        keys: [`${c.id}@${at}`, ...(i.elementId !== undefined ? [`${c.id}@${i.elementId}`] : [])],
        where: i.instance ?? model.qualifiedName(i.contextId),
      });
    }
  }
  for (const v of violatedAt) violatedAnywhere.add(v.assert.id);
  // The asserted equations the check reports giving one feature two values, by each equation's id.
  const apartKeys = new Set(raw.filter((c) => c.conflict === 'equations' && c.result === 'violated').map((c) => c.id));
  const apartBy = new Map<ElementId, ContradictedDefinition>();
  const apartSets = contradictedDefinitions(model).sets.filter((set) => apartKeys.has(`${set.feature.id}@${set.context.id}`));
  for (const set of apartSets) for (const c of set.equations) if (!apartBy.has(c.id)) apartBy.set(c.id, set);
  // The bindings the check reports violated anywhere, by the connector (a reading of one in a context is
  // `<connector id>@<context id>`): the worklist's bind axiom rows of it are read in contexts of their own (an
  // enclosed binding, in the instance it holds in), which the check's reading need not name.
  const violatedBinds = new Map<ElementId, ViolatedBinding>();
  for (const c of raw) {
    if (c.conflict !== 'bind' || c.result !== 'violated') continue;
    const read = c.ownerId != null && c.id.endsWith(`@${c.ownerId}`);
    const base = read ? c.id.slice(0, c.id.length - c.ownerId!.length - 1) : c.id;
    const at = violatedBinds.get(base) ?? { check: c, generic: false, contexts: [] };
    if (read) at.contexts.push(c.ownerId!);
    else at.generic = true;
    violatedBinds.set(base, at);
  }
  if (violatedAnywhere.size === 0 && apartSets.length === 0 && violatedBinds.size === 0) return none;

  const symbolOf = (v: ContractVariable): string => v.symbol ?? v.qualifiedName;
  const parent = new Map<string, string>();
  const find = (s: string): string => {
    if (!parent.has(s)) parent.set(s, s);
    let root = s;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let at = s; at !== root; ) {
      const next = parent.get(at)!;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) parent.set(x, y);
  };
  const baseOf = (row: Obligation): ElementId => row.instance?.baseId ?? row.element.id;
  const seeds: Obligation[] = [];
  const setOf = new Map<Obligation, ContradictedDefinition>();
  /** The seeds that are a violated binding's own row (the connector, whichever reading of it). */
  const bindingSeeds = new Set<Obligation>();
  /** The violated bindings the worklist files a row of that reads a feature. */
  const placedBinds = new Set<ElementId>();
  const filed = new Set<ContradictedDefinition>();
  const unplaced: UnplacedContradiction[] = [];
  const named = (row: Obligation): ContradictingAssert => ({
    expression: row.expression,
    qualifiedName: row.element.qualifiedName,
  });
  const assertRowIds = new Set<string>();
  for (const row of rows) {
    if (row.role !== 'axiom') continue;
    const symbols = row.vars.map(symbolOf);
    for (const s of symbols) find(s);
    for (const s of symbols.slice(1)) union(symbols[0]!, s);
    // An instance's own value of a feature is a value of that feature: join it to the feature's symbol,
    // and so to the bindings and derivations filed for the feature where the instance is written.
    if (row.source === 'feature-value' && row.instance !== undefined && symbols.length > 0) {
      for (const id of new Set([row.instance.featureId, row.instance.baseId])) {
        if (id !== undefined) union(symbols[0]!, model.qualifiedName(id));
      }
    }
    // An instance's symbol is joined to the feature it reads, and to every one that feature redefines: Q3's p's
    // `load` to Q's p's, where Q's binding is filed (CV-SP2 without a relation over q3's p).
    row.vars.forEach((v, k) => {
      if (v.instance === undefined) return;
      const f = model.get(v.featureId as ElementId);
      if (!f) return;
      for (const g of [f, ...redefinedClosure(model, f)]) union(symbols[k]!, model.qualifiedName(g.id));
    });
    if (row.source === 'bind') {
      if (violatedBinds.has(baseOf(row)) && symbols.length > 0) {
        placedBinds.add(baseOf(row));
        seeds.push(row);
        bindingSeeds.add(row);
      }
      continue;
    }
    if (row.source !== 'assert') continue;
    assertRowIds.add(row.element.id);
    const set = apartBy.get(baseOf(row));
    if (set !== undefined) {
      filed.add(set);
      if (symbols.length > 0) {
        seeds.push(row);
        setOf.set(row, set);
      }
      continue;
    }
    if (!violatedAnywhere.has(baseOf(row)) || checks.get(row.element.id)?.result === 'satisfied') continue;
    if (symbols.length > 0) seeds.push(row);
    else if (checks.get(row.element.id)?.result === 'violated') unplaced.push({ ...named(row), kind: 'constant' });
  }
  // Two asserted equations the check reports apart, none of which the worklist files: what they read is not known.
  for (const set of apartSets) {
    if (filed.has(set)) continue;
    unplaced.push({
      expression: set.equations.map((c) => String(c.attrs.expression ?? '').trim()).join(' and '),
      qualifiedName: model.qualifiedName(set.context.id),
      kind: 'equations',
      set,
    });
  }
  // A violated binding the worklist files no row of that reads a feature: what it joins there is not known.
  for (const [base, at] of violatedBinds) {
    if (placedBinds.has(base)) continue;
    const named = bindingNamed(model, base, at);
    unplaced.push({ expression: at.check.expression, qualifiedName: named.text + named.where, kind: 'binding' });
  }
  // A violated reading the worklist files no row of the assert for: what it reads there is not known.
  for (const v of violatedAt) {
    if (v.keys.some((k) => assertRowIds.has(k))) continue;
    unplaced.push({
      expression: v.assert.expression,
      qualifiedName: model.qualifiedName(v.assert.id),
      kind: 'unread',
      ...(v.where !== undefined ? { where: v.where } : {}),
    });
  }
  const byRoot = new Map<string, Obligation[]>();
  for (const a of seeds) {
    const root = find(symbolOf(a.vars[0]!));
    byRoot.set(root, [...(byRoot.get(root) ?? []), a]);
  }
  const reached = (vars: readonly ContractVariable[], into: Set<Obligation>): string[] => {
    const paths: string[] = [];
    for (const v of vars) {
      const s = symbolOf(v);
      const hit = parent.has(s) ? byRoot.get(find(s)) : undefined;
      if (hit === undefined) continue;
      for (const a of hit) into.add(a);
      if (!paths.includes(v.path)) paths.push(v.path);
    }
    return paths;
  };
  return {
    unplaced,
    reach: (row, premises) => {
      const asserts = new Set<Obligation>();
      const paths = reached(row.vars, asserts);
      const onPremises = premises
        .map((p) => ({ expression: p.expression, paths: reached(p.vars, asserts) }))
        .filter((p) => p.paths.length > 0);
      if (asserts.size === 0) return undefined;
      const hit = seeds.filter((a) => asserts.has(a));
      const sets = [...new Set(hit.flatMap((a) => setOf.get(a) ?? []))];
      return {
        asserts: namedOnce(model, hit.filter((a) => !setOf.has(a) && !bindingSeeds.has(a))),
        sets,
        bindings: [...new Set(hit.filter((a) => bindingSeeds.has(a)).map(baseOf))].map((base) => bindingNamed(model, base, violatedBinds.get(base))),
        paths,
        premises: onPremises,
      };
    },
  };
}

/** A binding the check reports violated: one of its readings, whether it is violated where it is written, and the contexts it is read violated in. */
interface ViolatedBinding {
  check: ConstraintCheck;
  generic: boolean;
  contexts: ElementId[];
}

/** A binding as a contradicted row names it: `text`, and `where` it is violated if only in contexts that change what it joins. */
interface NamedBinding {
  text: string;
  where: string;
}

/**
 * A binding connector as a contradicted row names it: the element it is written in and the `bind` it is there
 * (`Q's \`bind p.load = L\``) — the words the check's own finding uses (`bindingConflicts` of ../evaluate-model) —
 * and, where the check reports it violated only in the contexts that change what it joins (q2's, where Q's `L`
 * is redefined), which.
 */
function bindingNamed(model: Model, bindingId: ElementId, violated?: ViolatedBinding): NamedBinding {
  const b = model.get(bindingId);
  const read = b ? bindingHolder(model, b) : undefined;
  const bind = read?.left !== undefined && read.right !== undefined ? `\`bind ${read.left} = ${read.right}\`` : 'a `bind`';
  const holder = read ? effectiveQualifiedName(model, read.holder.id) : undefined;
  const names = (violated?.contexts ?? []).map((id) => sharedDefinitions(model).contextName(id));
  return {
    text: `${holder !== undefined ? `${holder}'s ` : ''}${bind}`,
    where:
      violated === undefined || violated.generic || names.length === 0
        ? ''
        : ` in ${names.slice(0, 2).join(' and ')}${names.length > 2 ? ` and ${names.length - 2} other context(s)` : ''}`,
  };
}

/**
 * The asserts of `rows` as a contradicted row names them, once each: an assert seeded on its own row and in N
 * instances (`L == a * 2.0` read in P and in p) is "`L == a * 2.0` (P::e1, and in 1 instance(s))", one seeded in
 * one row alone keeps that row's name (`INS::P::ca in INS::q1`).
 */
function namedOnce(model: Model, rows: readonly Obligation[]): ContradictingAssert[] {
  const byBase = new Map<ElementId, Obligation[]>();
  for (const r of rows) {
    const base = r.instance?.baseId ?? r.element.id;
    byBase.set(base, [...(byBase.get(base) ?? []), r]);
  }
  return [...byBase].map(([base, group]) => {
    if (group.length === 1) return { expression: group[0]!.expression, qualifiedName: group[0]!.element.qualifiedName };
    const generic = group.find((r) => r.instance === undefined);
    const n = group.filter((r) => r.instance !== undefined).length;
    return {
      expression: (generic ?? group[0]!).expression,
      qualifiedName: `${model.qualifiedName(base)}, ${generic ? 'and ' : ''}in ${n} instance(s)`,
    };
  });
}

/** `` `a` `` and `` `b` ``: paths as a sentence lists them. */
const quotedPaths = (paths: readonly string[]): string => paths.map((p) => `\`${p}\``).join(', ');

/** The asserts a contradicted row names: the first, and up to two more, then a count. */
function namedAsserts(asserts: readonly ContradictingAssert[]): string {
  const [first, ...rest] = asserts;
  const named = (a: ContradictingAssert) => `\`${a.expression}\` (${a.qualifiedName})`;
  const more =
    rest.length === 0
      ? ''
      : `, as ${rest.length === 1 ? 'is' : 'are'} ${rest.slice(0, 2).map(named).join(' and ')}` +
        (rest.length > 2 ? ` and ${rest.length - 2} other assertion(s)` : '');
  return `${named(first!)} is false at them${more}`;
}

/**
 * The close of every contradicted sentence: what the relation does at the point, and why that decides nothing.
 * `what` is the kind of contradiction it names: an assertion held false, a pair of asserted equations, or a
 * binding (an assertion beside it is the one it names first).
 */
const contradictedTail = (holds: boolean, what: 'assert' | 'pair' | 'binding' = 'assert'): string =>
  `The relation ${holds ? 'holds' : 'is false'} at these values, but a point the model contradicts is no point ` +
  'at which a pass or a failure is unconditional: ' +
  (what === 'pair'
    ? 'reconcile the asserted equations, which the check reports giving the feature two values'
    : what === 'binding'
      ? 'reconcile the binding, which the check reports violated, with the values it joins'
      : 'reconcile the assertion, which the check reports violated, with the value it contradicts');

/**
 * The sentence of a `contradicted` row: the assert the model holds false at its values (and how many
 * more), what the relation — or an assumption it stands on — reads that the contradiction reaches, and what
 * the relation does at that point.
 */
function contradictedDetail(model: Model, read: ContradictedRead, holds: boolean): string {
  const reads = [
    ...(read.paths.length > 0 ? [`this relation reads ${quotedPaths(read.paths)}`] : []),
    ...read.premises.map((p) => `its assumption \`${p.expression}\` reads ${quotedPaths(p.paths)}`),
  ].join(', and ');
  const what = [
    ...read.sets.map((set) => `${contradictedDefinitionNaming(model, set)} and give it two values that differ`),
    ...(read.asserts.length > 0 ? [`the asserted ${namedAsserts(read.asserts)}`] : []),
    ...(read.bindings.length > 0 ? [namedBindings(read.bindings)] : []),
  ].join('; ');
  // What reads the value: the assertion, or, where only a binding contradicts it, the binding that joins it.
  const byBinding = read.asserts.length === 0 && read.sets.length === 0 && read.bindings.length > 0;
  const [reader, readsIn] = byBinding ? ['binding joins', 'joins'] : ['assertion reads', 'reads'];
  return (
    `not judged at the model's values: the model contradicts itself there — ${what}, ` +
    `and ${reads}, which that contradiction reaches: the ${reader} it, or ${readsIn} it in another instance ` +
    "this tool reads as one value with it, or the model's values, bindings and assertions tie it to one the " +
    `${reader}. ${contradictedTail(holds, read.asserts.length > 0 ? 'assert' : read.sets.length > 0 ? 'pair' : 'binding')}`
  );
}

/** The bindings a contradicted row names: the first, and up to two more, then a count. */
function namedBindings(bindings: readonly NamedBinding[]): string {
  const [first, ...rest] = bindings;
  const more =
    rest.length === 0
      ? ''
      : `, as ${rest.length === 1 ? 'does' : 'do'} ${rest
          .slice(0, 2)
          .map((b) => b.text + b.where)
          .join(' and ')}` + (rest.length > 2 ? ` and ${rest.length - 2} other binding(s)` : '');
  return `${first!.text} joins two values that differ${first!.where}${more}`;
}

/** The sentence of a row a contradiction this engine cannot place reaches ({@link UnplacedContradiction}). */
function unplacedDetail(model: Model, unplaced: readonly UnplacedContradiction[], holds: boolean): string {
  const [first] = unplaced;
  const why =
    first!.kind === 'constant'
      ? `the asserted \`${first!.expression}\` (${first!.qualifiedName}) reads no feature and is false whatever ` +
        "the values, so the model contradicts itself at every point, this relation's among them"
      : first!.kind === 'equations' && first!.set !== undefined
        ? `${contradictedDefinitionNaming(model, first!.set)} and give it two values that differ, and the worklist ` +
          'files no row of them, so this tool does not read which values that contradiction reaches, and takes it to ' +
          'reach every relation of the model, this one among them'
      : first!.kind === 'binding'
        ? `the check reports ${first!.qualifiedName} violated, and the worklist files no row of it that reads a ` +
          'feature, so this tool does not read which values that binding joins, and takes the contradiction to reach ' +
          'every relation of the model, this one among them'
      : `the check reports the asserted \`${first!.expression}\` (${first!.qualifiedName}) false in ` +
        `${first!.where ?? 'an instance'}, an instance the worklist files no row of that assertion for, so this ` +
        'tool does not read which values that contradiction reaches there, and takes it to reach every relation of ' +
        'the model, this one among them';
  const more = unplaced.length > 1 ? ` (and ${unplaced.length - 1} other such ${unplaced.every((u) => u.kind === 'binding') ? 'binding' : 'assertion'}(s))` : '';
  return (
    `not judged at the model's values: the model contradicts itself — ${why}${more}. ` +
    contradictedTail(holds, first!.kind === 'equations' ? 'pair' : first!.kind === 'binding' ? 'binding' : 'assert')
  );
}

/**
 * The reading of one assumption at the model's values.
 *
 * Exported for the SMT engine, which ASSERTS the premises rather than
 * evaluating them and still has to print what each one says at the values —
 * a proof that stands on three assumptions is a different claim from an
 * unconditional one, and the two engines must describe them identically.
 */
export function readPremise(row: Obligation, checks: ReadonlyMap<ElementId, ConstraintCheck>): PremiseReading {
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
  memo: DerivationMemo = new Map(),
  contradicted: ReturnType<typeof contradictionsOf> = { unplaced: [], reach: () => undefined },
): LiteralJudgement {
  const premises = (row.requirement ? premisesByRequirement.get(row.requirement.id) : undefined) ?? [];
  const readings = premises.map((p) => readPremise(p, checks));
  const check = checks.get(row.element.id);
  const bindings = modelBindings(model, row, check);
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

  const detailed =
    row.node !== null ? quantities(model, row, memo, check) : {};

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

  // A point the model contradicts decides nothing: a relation, or an assumption it stands on, over a
  // value an `assert` the model holds false at its values reaches is judged at a point the model itself
  // rules out, so neither its pass nor its failure is unconditional ({@link contradictionsOf}).
  if (check?.result === 'satisfied' || check?.result === 'violated') {
    const holds = check.result === 'satisfied';
    if (contradicted.unplaced.length > 0) {
      return { ...base, outcome: 'contradicted', detail: unplacedDetail(model, contradicted.unplaced, holds) };
    }
    const against = contradicted.reach(row, premises);
    if (against !== undefined) return { ...base, outcome: 'contradicted', detail: contradictedDetail(model, against, holds) };
  }

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
          ? ` (${detailed.lhsSI} vs ${detailed.rhsSI}${detailed.dimension ? ` in ${detailed.dimension}` : ''}, ` +
            'coherent SI' +
            // Two doubles within the tolerance say nothing on their own — `0.1
            // + 0.2 > 0.3` is 0.30000000000000004 vs 0.3 — so the sentence
            // says what decided it.
            (withinTolerance(detailed.lhsSI, detailed.rhsSI)
              ? ', a tie to binary64 that the decimals written decide'
              : '') +
            ')'
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
  const unread = row.encodable === true ? unreadOutcome(model, row, check) : undefined;
  if (unread) return { ...base, outcome: 'not-evaluable', detail: unread.detail };
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
        `not evaluable at the model's values — ${
          refusalHead(refusal.reason, refusal.detail)
        } (${refusal.reason}): ${refusal.detail}. ${refusalTail(refusal.reason, refusal.detail)}`,
    };
  }
  return { ...base, outcome: 'not-evaluable', detail: `not evaluable at the model's values: ${why}` };
}

/** The two SI magnitudes and the dimension, when the unit-aware evaluator has them. */
function quantities(
  model: Model,
  row: Obligation,
  memo: DerivationMemo = new Map(),
  check?: ConstraintCheck,
): { lhsSI?: number; rhsSI?: number; dimension?: string } {
  // A value a binding carried in was compared as the quantity it is: those are the sides.
  if (check?.sides) return check.sides;
  const el = rowElement(model, row);
  if (!el) return {};
  const q = evaluateConstraintQuantityDetailed(model, el, {
    memo,
    instances: true,
    ...(row.instance?.path !== undefined ? { instance: row.instance.path } : {}),
  });
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
 * A path read through an instance of its own is that instance's value, as the
 * check's scalar scope reads it ({@link valueAtPath}), and no value (`null`)
 * where that reading finds none — a derived value a binding carries into the
 * instance, or an expression with a unit literal, which it does not read.
 *
 * "What a reader would have to change to move the verdict" is true only of the
 * roles that are *stated*. A `derived` feature stores the magnitude its own
 * equation produced, in whatever unit that arithmetic landed in and with no
 * declared unit at all — which is why every binding carries its role, and why
 * the pair the comparison was made on lives in the bound's `si` slot instead of
 * being inferred from these numbers.
 *
 * Exported for the SMT engine, which records the same point for a run with
 * nothing freed: with every value a binding, the solver's witness IS the
 * model's own values, and a record that showed a solver's rendering of them
 * instead would be a different artefact for the same fact.
 */
export function modelBindings(model: Model, row: Obligation, check?: ConstraintCheck): ValueBinding[] {
  const out: ValueBinding[] = [];
  const el = rowElement(model, row);
  // A group's instance row that abstains reads none of its names there: the usage's generic values
  // (the definition's `extra` of 0 for an instance that states another) are no point of its.
  const abstains = row.instance?.path !== undefined && (check?.cause !== undefined || check?.result === 'unknown');
  for (const v of row.vars) {
    // A path read through an instance of its own (`q.m2`, ContractVariable.instance) is THAT instance's
    // value, read where the relation reads it — the check's own reading (`check.reads`, F5), else the
    // feature's own value is the definition's (9 beside the −40 the row compared). Every other path is
    // its feature's, the same wherever it is read; where the feature states none, the value a binding
    // carries into it, as the check read it.
    const read = check?.reads?.find((x) => x.path === v.path);
    let raw: unknown = null;
    // Nor does a path two asserted equations give two values print one: the first written is no value the model
    // states (`readsContradictedDefinition`).
    if (abstains || readsContradictedDefinition(model, v.featureId)) {
      raw = null;
    } else if (!v.instance) {
      const r = evaluateFeatureValue(model, v.featureId);
      raw = 'value' in r ? r.value : (read?.value ?? null);
    } else {
      raw = read !== undefined && read.value !== undefined ? read.value : el ? valueAtPath(model, el, v.path) : null;
    }
    out.push({
      path: v.path,
      qualifiedName: v.qualifiedName,
      value:
        typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string' ? raw : null,
      unit: read?.unit !== undefined && raw === read.value ? read.unit : v.unit,
      role: v.role,
    });
  }
  return out;
}
