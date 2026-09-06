/**
 * The SMT engine: the only thing in this repository that may print `proved`.
 *
 * THE CHARTER OF THIS FILE, IN ONE LINE: **`proved` means the negation was
 * UNSAT under a SATISFIABLE axiom set, non-vacuously, over a two-sided
 * domain — and nothing else does.** Every branch below exists to keep one of
 * the ways that sentence can be false from reaching a reader as a pass:
 *
 *  - **(0) The axiom set is checked ONCE PER RUN.** A proof from a
 *    contradiction is void, and an inconsistent axiom set makes every negation
 *    unsat: without this step the tool would print "proved" for every
 *    obligation in a model that contradicts itself, which is the loudest way a
 *    verification lane can be silently wrong. If `check(A)` is unsat, every
 *    obligation is `inconclusive: axioms inconsistent`, and the UNSAT CORE is
 *    printed so the reader can see which facts collide.
 *  - **(1) `check(A ∧ P ∧ ¬G)`.** UNSAT ⇒ the obligation holds for every
 *    assignment the axioms and premises admit. SAT ⇒ a counterexample.
 *  - **(2) `check(A ∧ P)`.** UNSAT ⇒ the premises cannot all hold, so the
 *    UNSAT in (1) was free — `vacuous`, never a pass. Run for every proof, so
 *    "proved" always stands on a satisfiable-assumptions witness.
 *  - **(3) `check(¬G)` alone.** UNSAT ⇒ the goal is a tautology: still proved,
 *    and FLAGGED, because `x == x` is not evidence about a design.
 *
 *  - **A FREED FEATURE MUST BE TWO-SIDED, and this is BLOCKING.** The tool
 *    derives nothing from ISQ typing: it does not know that a power is
 *    non-negative. On the shipped example, `--free uav.cruisePower` with only
 *    an upper premise lets z3 answer sat with `cruisePower = -1 W` and
 *    `endurance = -1 843 200 s`, and the in-process re-evaluation gate below
 *    *confirms that arithmetic* — so the tool would print a fabricated
 *    counterexample against a requirement nothing is wrong with. A freed
 *    feature the context does not confine on BOTH sides is
 *    `verification/free-variable-unbounded` ⇒ inconclusive, never `refuted`.
 *    Freeing a feature is a two-sided act.
 *  - **Every SAT witness is re-evaluated in process before it is printed.** A
 *    witness the tool's own evaluator does not agree refutes the relation is
 *    reported as `inconclusive: witness not confirmed`, never as a violation:
 *    that is what catches an encoder defect in the direction that matters. With
 *    `--free none` the witness must also be a `violated` reading on the NUMERIC
 *    SURFACE (`checkConstraints`) — an independent surface, and the one the
 *    differential gate of §5 compares against.
 *  - **A refutation needs the WHOLE context.** A counterexample found while an
 *    axiom or a premise was refused by the gates may be excluded by the very
 *    relation that was dropped, so it is reported as undecided with the refused
 *    relation named. A PROOF under a partial context is sound in the other
 *    direction — fewer facts make UNSAT harder, never easier — and is kept.
 *
 * WHAT THE SYMBOLS MEAN. One variable per feature, named by its QUALIFIED NAME
 * (element ids are fresh per load), declared in the magnitude the file STORES,
 * and read through whatever scale ITS OWN relation was granted
 * ({@link Obligation.scaled}). That is the encoder's contract and it is why
 * this engine never scales a relation the gates left verbatim: `range = 5.0
 * [km]` against a bare `<= 10.0` is read in kilometres by the numeric surface,
 * and an engine that read it as `5000 <= 10` would refute a satisfied
 * constraint with total confidence.
 *
 * Everything here is a pure function of the model, the worklist and the
 * backend. The backend is passed IN rather than loaded: this module must not
 * decide whether a solver exists — {@link ../../api/verification} does, once,
 * and an absent solver is `verification/tool-absent`, never a fallback.
 */

import { type ElementId, type Model } from '@core/index';
import { checkConstraints, type ConstraintCheck } from '../evaluate-model';
import { evaluate } from '../expr';
import { type Obligation } from '../obligations';
import { type ContractVariable, type Refusal } from '../contracts';
import { idScopeFor } from '../relations';
import { dimToString } from '../units';
import { evaluateConstraintQuantityDetailed } from '../units-eval';
import {
  encodeRelation,
  encodeScript,
  encodeVariables,
  exactNumeral,
  notTerm,
  symbolOf,
  type EncodeVariable,
  type EncodedRelation,
  type ScriptAssertion,
  type SideCondition,
} from '../smt/encode';
import { type CheckOutcome, type WitnessValue, type Z3Backend } from '../smt/z3-bridge';
import {
  isOutsideTheFragment,
  modelBindings,
  readPremise,
  type PremiseReading,
  type ValueBinding,
} from './literal';

/**
 * How far a freed feature may range before this engine declines to call it
 * bounded, in the magnitude the file stores.
 *
 * The rule §3.4 states is "unbounded below/above". Unboundedness is not a
 * question a quantifier-free check answers, so what is actually asked is
 * CONFINEMENT: `A ∧ P ∧ x > B` and `A ∧ P ∧ x < -B` must both be UNSAT. Either
 * one satisfiable and the freed feature is reported unbounded on that side.
 *
 * The failure direction is the safe one. A model that really does confine a
 * freed feature to ±10¹² is reported as unbounded and comes back
 * INCONCLUSIVE — the tool declines to distinguish "very large" from "without
 * limit", and says so with the figure — where the opposite error would print a
 * counterexample from a region the author never admitted. The bound is printed
 * on every row it decides, because a bound that is not printed is not a bound.
 */
export const FREE_DOMAIN_BOUND = 1e12;

/** What this engine concluded about one obligation. */
export type SmtOutcome =
  /** `A ∧ P ∧ ¬G` unsat, `A ∧ P` sat, axioms sat. The only claim word that is a proof. */
  | 'proved'
  /** A counterexample with every feature at its model value, confirmed in process. */
  | 'refuted'
  /** A counterexample obtained only because `--free` released a value the model states. */
  | 'design-admitted'
  /** `A ∧ P` unsat: the premises cannot all hold, so the goal was discharged for free. */
  | 'vacuous'
  /** `check(A)` unsat: every proof from this context would be a proof from a contradiction. */
  | 'axioms-inconsistent'
  /** A freed feature the context does not confine on both sides. */
  | 'free-unbounded'
  /** The solver did not answer inside its budget. */
  | 'timeout'
  /** A SAT witness the in-process evaluator would not confirm, or a partial context. */
  | 'witness-unconfirmed'
  /** Outside the fragment this lane encodes at all. `--allow-inconclusive` may forgive it. */
  | 'unsupported'
  /** The relation cannot be read at all, or the solver refused our own script. Never forgiven. */
  | 'not-evaluable';

/** What this engine holds about one obligation, and everything the report prints. */
export interface SmtJudgement {
  outcome: SmtOutcome;
  /** The sentence a person reads. `proved` appears only for the outcome of that name. */
  detail: string;
  /** The assumptions, read at the model's values beside being asserted. */
  premises: PremiseReading[];
  /** The model's own values — populated only when nothing was freed. */
  bindings: ValueBinding[];
  /** The bound the claim holds within: which kind, and the sentence beside it. */
  boundKind: 'model-values' | 'free-variables' | 'timeout' | 'none';
  boundDetail: string;
  /** The two sides in coherent SI, when the unit-aware evaluator had them. */
  lhsSI?: number;
  rhsSI?: number;
  dimension?: string;
  /** `check(¬G)` alone was unsat: proved, and true of every model. */
  tautology: boolean;
  /** The solver's own witness, as z3 wrote it. Empty unless a check answered sat. */
  witness: WitnessValue[];
  /** The `set-logic` the script the verdict came from declared. `''` when none ran. */
  logic: string;
  /** How many solver checks this row cost, including its share of step 0. */
  checks: number;
}

/** One judged row: the worklist row, and what this engine made of it. */
export interface SmtResult {
  row: Obligation;
  judgement: SmtJudgement;
}

/** How a run is bounded and what it releases. */
export interface SmtOptions {
  backend: Z3Backend;
  /** Features released by `--free`, already resolved to qualified names. */
  free?: ReadonlySet<string>;
  /** The per-check budget in ms. Every check in this file is bounded. */
  timeoutMs?: number;
}

/* ─────────────────────────── resolving `--free` ──────────────────────────── */

/** What a `--free` spelling named, or the spellings that named nothing. */
export interface FreeResolution {
  /** Qualified name → the feature element it names. */
  features: Map<string, ElementId>;
  /** The qualified names, which is what the engine and the record carry. */
  qualifiedNames: Set<string>;
  /** Spellings that resolved to no feature at all. */
  unresolved: string[];
  /** Bare spellings that named MORE than one element of the user's model. */
  ambiguous: Array<{ spelling: string; candidates: string[] }>;
  /** Spellings that resolved to an element no relation in the worklist reads. */
  unread: Array<{ spelling: string; qualifiedName: string }>;
}

/**
 * Resolve every `--free` spelling to a feature of the user's model.
 *
 * A SPELLING THAT FREES NOTHING IS REFUSED, never ignored. `--free` changes
 * what a verdict means — it turns a violation into a design the model admits,
 * and it turns a pinned variable into one a counterexample may move — so a
 * spelling that quietly freed nothing would print a verdict under a bound the
 * record then claimed was in force. THREE WAYS a spelling can free nothing, and
 * all three are refused rather than ignored; the caller raises them as one
 * usage error:
 *
 *  1. **It names nothing at all** — a misspelling. The obvious one, and the
 *     only one the first draft caught.
 *  2. **It names more than one thing.** A bare feature name is accepted only
 *     when it is unique, because `--free mass` over two `mass` attributes
 *     silently released the first one the model walk happened to reach.
 *  3. **It names something no relation READS.** MEASURED, on the shipped
 *     example: `--free UAVSurveillanceSystem::uav` resolves to the part usage,
 *     which is no relation's variable, so it released nothing — and the run
 *     printed `proved` and exited 0 under a header reading "with uav released",
 *     where the intended `--free uav.cruisePower` is `design-admitted` and
 *     exits 2. A typo that turns exit 2 into a green build is the worst shape a
 *     flag can have, and refusing it is the only reading under which the header
 *     stays true. (The bare `uav` reaches rule 2 first there — the part usage
 *     and each requirement's `subject uav` all declare the name.)
 *
 * Three spellings are accepted because all three are what a person has in front
 * of them: the qualified name (`A::B::cruisePower`), the dotted path a relation
 * body writes (`uav.cruisePower`), and a bare feature name unique in scope. The
 * dotted path is resolved through {@link idScopeFor} over the user's own
 * packages — the same resolver a relation body goes through, so a name that
 * works in a constraint works here.
 *
 * `rows` is the worklist the run will judge, and it is what rule 3 is answered
 * against: the question is not "is this a feature?" but "would releasing it
 * change any relation this run reads?", and only the worklist knows.
 */
export function resolveFreeFeatures(
  model: Model,
  spellings: readonly string[],
  rows: readonly Obligation[] = [],
): FreeResolution {
  const scope = new Map<string, ElementId>();
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || el.attrs.implicit === true) continue;
    if (!el.eClass.endsWith('Package')) continue;
    for (const [name, id] of idScopeFor(model, el.id)) if (!scope.has(name)) scope.set(name, id);
  }
  const byQualifiedName = new Map<string, ElementId>();
  // BARE NAMES ARE COUNTED SEPARATELY, because `idScopeFor` cannot answer this
  // question: its bare-name entry is FIRST-WINS by design (`if (!map.has(name))`
  // — the resolution a relation body gets, and not something to change from
  // here), so two `mass` attributes in two part definitions collapse to one
  // entry and `--free mass` silently released whichever the model walk reached
  // first. The count is taken over the user's own declared names, which is what
  // "unique in scope" means to the person typing it.
  const byDeclaredName = new Map<string, Set<ElementId>>();
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || el.attrs.implicit === true) continue;
    byQualifiedName.set(model.qualifiedName(el.id), el.id);
    const declared = el.declaredName;
    if (declared === undefined || declared === '') continue;
    const seen = byDeclaredName.get(declared);
    if (seen) seen.add(el.id);
    else byDeclaredName.set(declared, new Set([el.id]));
  }

  // What `freed()` below tests, gathered once: a feature is released only if a
  // relation reads it as a variable, or if it is the feature a feature-value
  // axiom binds. Anything else is a name the run would carry and never use.
  const readable = new Set<string>();
  for (const r of rows) {
    for (const v of r.vars) readable.add(v.qualifiedName);
    if (r.role === 'axiom' && r.source === 'feature-value') readable.add(r.element.qualifiedName);
  }

  const features = new Map<string, ElementId>();
  const qualifiedNames = new Set<string>();
  const unresolved: string[] = [];
  const ambiguous: Array<{ spelling: string; candidates: string[] }> = [];
  const unread: Array<{ spelling: string; qualifiedName: string }> = [];
  for (const spelling of spellings) {
    const exact = byQualifiedName.get(spelling);
    const id = exact ?? scope.get(spelling);
    if (id === undefined) {
      unresolved.push(spelling);
      continue;
    }
    // Only a BARE name can be ambiguous: a qualified name is exact and a dotted
    // path is a route, so neither can name two things.
    const bare = exact === undefined && !spelling.includes('.') && !spelling.includes('::');
    const named = bare ? (byDeclaredName.get(spelling) ?? new Set([id])) : new Set([id]);
    if (named.size > 1) {
      ambiguous.push({
        spelling,
        candidates: [...named].map((e) => model.qualifiedName(e)).sort(),
      });
      continue;
    }
    const qualifiedName = model.qualifiedName(id);
    if (rows.length > 0 && !readable.has(qualifiedName)) {
      unread.push({ spelling, qualifiedName });
      continue;
    }
    features.set(qualifiedName, id);
    qualifiedNames.add(qualifiedName);
  }
  return { features, qualifiedNames, unresolved, ambiguous, unread };
}

/** Every feature a `--free` spelling could name, for the sentence that refuses one. */
export function freeableFeatures(rows: readonly Obligation[]): string[] {
  const out = new Set<string>();
  for (const r of rows) for (const v of r.vars) out.add(v.qualifiedName);
  return [...out].sort();
}

/* ──────────────────────────────── the run ───────────────────────────────── */

/** One encoded row, kept beside the row it came from. */
interface EncodedRow {
  row: Obligation;
  /** `undefined` when the row could not be encoded — the reason is on the row. */
  encoded?: EncodedRelation;
  /** The variables as THIS relation reads them: its own scale, its own free set. */
  vars: EncodeVariable[];
  /** Why it did not encode, when it did not. */
  refusal?: Refusal;
}

/**
 * Judge every `obligation` row of a worklist with the solver.
 *
 * The whole worklist is passed in, exactly as the literal engine takes it: the
 * axioms and premises of an obligation are rows of the same list, and an engine
 * given only the obligations would prove each one against an empty context.
 */
export async function judgeBySmt(
  model: Model,
  rows: readonly Obligation[],
  opts: SmtOptions,
): Promise<SmtResult[]> {
  const free = opts.free ?? new Set<string>();
  const timeoutMs = opts.timeoutMs ?? undefined;
  const backend = opts.backend;

  // One sweep of the numeric surface for the whole run — the same surface the
  // literal engine reads, which is what makes the differential gate of §5 a
  // comparison of two engines rather than of three evaluators.
  const checks = new Map<ElementId, ConstraintCheck>();
  for (const c of checkConstraints(model)) checks.set(c.id, c);

  const encodedRows = rows.map((row) => encodeRow(row, free));
  const byId = new Map<ElementId, EncodedRow>(encodedRows.map((e) => [e.row.element.id, e]));

  // A feature-value axiom that PINS a freed feature is dropped: that is what
  // `--free` means. Nothing else is dropped — a `bind` edge and an `assert`
  // are separate statements about the model, and silently deleting them would
  // widen the design space past what the reader asked for.
  const axioms = encodedRows.filter(
    (e) => e.row.role === 'axiom' && !(e.row.source === 'feature-value' && freed(e.row, free)),
  );
  const premisesByRequirement = new Map<ElementId, EncodedRow[]>();
  for (const e of encodedRows) {
    if (e.row.role !== 'premise' || !e.row.requirement) continue;
    const list = premisesByRequirement.get(e.row.requirement.id);
    if (list) list.push(e);
    else premisesByRequirement.set(e.row.requirement.id, [e]);
  }

  const axiomAssertions = assertionsOf(axioms, 'axiom');
  const axiomVars = variablesOf(axioms);
  const axiomsRefused = axioms.filter((e) => e.encoded === undefined);

  // STEP 0, once per run. Every obligation below stands on this answer.
  const consistency = await backend.check(
    scriptOf(axiomVars, axiomAssertions, axioms).text,
    { timeoutMs },
  );

  const out: SmtResult[] = [];
  for (const row of rows) {
    if (row.role !== 'obligation') continue;
    const premises = (row.requirement ? premisesByRequirement.get(row.requirement.id) : undefined) ?? [];
    const readings = premises.map((p) => readPremise(p.row, checks));
    out.push({
      row,
      judgement: await judgeOne(model, {
        row: byId.get(row.element.id) ?? encodeRow(row, free),
        readings,
        axioms,
        axiomsRefused,
        premises,
        consistency,
        backend,
        free,
        timeoutMs,
        checks,
      }),
    });
  }
  return out;
}

/** Is this feature-value axiom the binding of a feature the caller released? */
function freed(row: Obligation, free: ReadonlySet<string>): boolean {
  if (free.has(row.element.qualifiedName)) return true;
  return row.vars.some((v) => free.has(v.qualifiedName) && v.featureId === row.element.id);
}

/** Encode one row's body under its OWN scale decision and the caller's free set. */
function encodeRow(row: Obligation, free: ReadonlySet<string>): EncodedRow {
  const vars = encodeVariables(row.vars, row.sortPerVar, {
    scaled: row.scaled,
    free: freeSpellings(row.vars, free),
  });
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

/**
 * The free set as {@link encodeVariables} wants it — by PATH as well as by
 * qualified name.
 *
 * `--free` is resolved to qualified names, and the encoder matches a variable
 * on either spelling; passing both means a freed feature is freed in every
 * relation that reads it, whatever dotted path that relation happens to write.
 */
function freeSpellings(
  vars: readonly ContractVariable[],
  free: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>(free);
  for (const v of vars) if (free.has(v.qualifiedName)) out.add(v.path);
  return out;
}

/** The labelled assertions of a set of encoded rows, skipping the refused ones. */
function assertionsOf(rows: readonly EncodedRow[], kind: 'axiom' | 'premise'): ScriptAssertion[] {
  const out: ScriptAssertion[] = [];
  for (const e of rows) {
    if (!e.encoded) continue;
    out.push({ kind, name: nameOf(e.row), term: e.encoded.term });
    for (const side of e.encoded.sideConditions) {
      out.push({ kind: 'side', name: nameOf(e.row), term: side.term });
    }
  }
  return out;
}

/** The label a row's assertion carries — a qualified name, never an element id. */
function nameOf(row: Obligation): string {
  return row.element.qualifiedName || row.expression;
}

/** Every variable the rows may read, deduplicated by qualified name. */
function variablesOf(rows: readonly EncodedRow[]): EncodeVariable[] {
  const out: EncodeVariable[] = [];
  const seen = new Set<string>();
  for (const e of rows) {
    for (const v of e.vars) {
      if (seen.has(v.qualifiedName)) continue;
      seen.add(v.qualifiedName);
      out.push(v);
    }
  }
  return out;
}

/** Build one script; the fragment word is free-relative, the logic line is not. */
function scriptOf(
  variables: readonly EncodeVariable[],
  assertions: readonly ScriptAssertion[],
  rows: readonly EncodedRow[],
): ReturnType<typeof encodeScript> {
  return encodeScript({
    variables,
    assertions,
    nonlinear: rows.some((e) => e.encoded?.nonlinear === true),
    syntacticNonlinear: rows.some((e) => e.encoded?.syntacticNonlinear === true),
  });
}

/* ───────────────────────────── one obligation ───────────────────────────── */

interface JudgeInput {
  row: EncodedRow;
  readings: PremiseReading[];
  axioms: readonly EncodedRow[];
  axiomsRefused: readonly EncodedRow[];
  premises: readonly EncodedRow[];
  consistency: CheckOutcome;
  backend: Z3Backend;
  free: ReadonlySet<string>;
  timeoutMs: number | undefined;
  checks: ReadonlyMap<ElementId, ConstraintCheck>;
}

/**
 * One obligation, judged in the order the plan fixes.
 *
 * The order is not a style choice. Encodability is answered before any solver
 * call, because there is nothing to ask; the axiom set is answered before the
 * goal, because a proof from a contradiction is void; the freed features are
 * answered before the negation check, because a sat answer over a one-sided
 * domain is a fabricated counterexample and must never be printed as a
 * refutation.
 */
async function judgeOne(model: Model, input: JudgeInput): Promise<SmtJudgement> {
  const { row } = input;
  // THE POINT THE CLAIM WAS READ AT is the model's own values only when nothing
  // this obligation's proof reads was released. Keyed on the row's own
  // variables rather than on the run's `--free` list: releasing a feature this
  // obligation never mentions changes nothing about it, and reporting its
  // bound as "free variables" would name a release that was not in force here.
  const rowFreed = row.vars.some((v) => v.free);
  const base = {
    premises: input.readings,
    // Filled in per branch, from the same predicate the BOUND is chosen by —
    // see the `point` binding below, and the branches before it that have no
    // proof context to read a free count out of.
    bindings: [] as ValueBinding[],
    tautology: false,
    witness: [] as WitnessValue[],
    logic: '',
    checks: 0,
  };

  // Nothing to ask a solver about.
  if (row.refusal) {
    const refusal = row.refusal;
    // A refused row has NO proof context, so the only release that could reach
    // it is one on its own variables — which is what `rowFreed` answers.
    // The unit-aware pair, on the same precondition the literal engine reads it
    // under: a row with no readable body has no comparison to print.
    const refusedSI = row.row.node !== null ? quantities(model, row.row) : {};
    const refusedPoint = rowFreed ? {} : { bindings: modelBindings(model, row.row), ...refusedSI };
    if (row.row.status === 'no-formal-clause') {
      return {
        ...base,
        ...refusedPoint,
        outcome: 'unsupported',
        detail: `nothing to encode: ${refusal.detail}`,
        boundKind: 'none',
        boundDetail: 'no relation was encoded, so nothing is claimed',
      };
    }

    // A RELATION NO ENGINE CAN ENCODE MAY STILL BE FALSE AT THE MODEL'S OWN
    // VALUES, AND THAT IS A VIOLATION WHOEVER READS IT.
    //
    // `--allow-inconclusive` may lower "outside the fragment" to exit 0 — that
    // is the whole point of the code. §2 says it may never do so OVER A
    // VIOLATION, and until this branch existed it did: `bus.seats % 2 == 0`
    // with `seats = 13` is refused by the gates (`%` has no encoding) and read
    // `violated` by the numeric surface, so `--engine literal` exited 1 with
    // `verification/refuted` while `--engine smt --allow-inconclusive` exited
    // 0 on the same file — and `auto` resolves to `smt`, so that was the
    // DEFAULT invocation going green over a requirement the tool itself calls
    // false.
    //
    // The claim is stated for what it is: a point evaluation on the surface
    // both engines share, never a solver refutation. No proof is available for
    // a relation nothing encoded, and the sentence says so rather than
    // borrowing the negation-check wording.
    const check = input.checks.get(row.row.element.id);
    if (!rowFreed && check?.result === 'violated') {
      const si = refusedSI;
      return {
        ...base,
        ...refusedPoint,
        outcome: 'refuted',
        detail:
          `refuted with every feature at its model value: \`${row.row.expression}\` is false on the ` +
          'numeric surface' +
          (si.lhsSI !== undefined && si.rhsSI !== undefined
            ? ` (${si.lhsSI} vs ${si.rhsSI}${si.dimension ? ` in ${si.dimension}` : ''}, coherent SI)`
            : '') +
          ` — a gate refuses this relation for the solver lane (${refusal.reason}: ${refusal.detail}), ` +
          'so no proof is available for it either way, but a requirement that is false at the values ' +
          'the model states is a violation whichever engine reads it and no flag forgives one',
        boundKind: 'model-values',
        boundDetail:
          'every feature at the value the model binds it to, read on the numeric surface — nothing ' +
          `was encoded, so this is a point evaluation and not a proof${siSentence(si)}`,
      };
    }
    // WHICH SURFACE REFUSED IS PART OF THE ANSWER, and it decides whether a
    // flag may forgive the row.
    //
    // `--allow-inconclusive`'s scope is the GATES': `obligations --missing`
    // reports what they refused, and the forgivable code means "a well-formed
    // relation whose shape is outside the fragment". A refusal the gates did
    // NOT make — the row arrived `encodable: true` and the encoder turned it
    // down — is a relation the two surfaces of this tool read differently, and
    // the conservative reading of that is the only honest one: nobody could
    // read it as a claim, so nothing may lower it to exit 0.
    //
    // Found by the differential gate rather than reasoned out: `constraint c {
    // a + + 2 }` (test/fixtures/agent-authoring/L2-double-operator) is not a
    // proposition at all. The numeric surface reports it `unknown` and the
    // literal engine calls it `verification/not-evaluable`, which nothing
    // forgives; this engine called it `unsupported-construct`, which
    // `--allow-inconclusive` lowers — so one malformed constraint body was a
    // green build under `--engine smt` and exit 2 under `--engine literal`, on
    // one file. Two engines with two scopes for one flag is exactly what
    // exporting `isOutsideTheFragment` was meant to prevent.
    const gatesRefusedToo = row.row.encodable !== true;
    return gatesRefusedToo && isOutsideTheFragment(refusal.reason)
      ? {
          ...base,
          ...refusedPoint,
          outcome: 'unsupported',
          detail: `outside the fragment this lane encodes (${refusal.reason}): ${refusal.detail}`,
          boundKind: 'none',
          boundDetail: 'no relation was encoded, so nothing is claimed',
        }
      : {
          ...base,
          ...refusedPoint,
          outcome: 'not-evaluable',
          detail:
            `the relation itself cannot be read (${refusal.reason}): ${refusal.detail}. ` +
            (gatesRefusedToo
              ? ''
              : 'The unit gates passed this relation and the encoder refused it, so the two ' +
                'surfaces of this tool read it differently. ') +
            'This is a defect in the relation, not a construct outside the fragment, so ' +
            '`--allow-inconclusive` does not forgive it',
          boundKind: 'none',
          boundDetail: 'no relation was encoded, so nothing is claimed',
        };
  }

  const goal = row.encoded as EncodedRelation;
  // Only the axioms this obligation can actually reach — see {@link relevantAxioms}.
  const { kept: axioms, reached } = relevantAxioms(input.axioms, input.premises, goal);
  const context = [...axioms, ...input.premises, row];
  const variables = variablesOf([...context]);
  // THE POINT THE CLAIM WAS READ AT, from the SAME predicate the bound is
  // chosen by. Keyed on this obligation's own proof CONTEXT rather than on the
  // goal's variables: `uav.endurance >= 45 [min]` reads only `endurance`, and
  // `--free uav.cruisePower` reaches it through the derived equation — so a
  // goal-keyed test called nothing released, and a `design-admitted` row
  // carried `witness: model-values` naming the model's own point plus an SI
  // pair (2835.69 vs 2700) that reads as the requirement HOLDING, on the row
  // reporting that it fails. Where the context released anything, there is no
  // single point to name and none is offered.
  const si: { lhsSI?: number; rhsSI?: number; dimension?: string } =
    countFree(variables) === 0 ? quantities(model, row.row) : {};
  const point = countFree(variables) === 0 ? { bindings: modelBindings(model, row.row), ...si } : {};
  const axiomAssertions = assertionsOf(axioms, 'axiom');
  const premiseAssertions = assertionsOf(input.premises, 'premise');
  const goalSides: ScriptAssertion[] = goal.sideConditions.map((s: SideCondition) => ({
    kind: 'side' as const,
    name: nameOf(row.row),
    term: s.term,
  }));
  const assumed = [...axiomAssertions, ...premiseAssertions, ...goalSides];
  const bound = (kind: SmtJudgement['boundKind'], detail: string) => ({ boundKind: kind, boundDetail: detail });

  // STEP 0's answer, read here so every obligation reports it.
  if (input.consistency.status === 'unsat') {
    return {
      ...base,
      ...point,
      outcome: 'axioms-inconsistent',
      checks: 1,
      detail:
        'the axiom set is unsatisfiable, so nothing can be proved from it: a proof from a ' +
        'contradiction is void. ' +
        (input.consistency.core.length > 0
          ? `core: ${coreSentence(input.consistency.core)}`
          : 'the solver named no core'),
      ...bound('none', 'no obligation was decided — the context contradicts itself'),
    };
  }
  if (input.consistency.status !== 'sat') {
    return {
      ...base,
      ...point,
      outcome: input.consistency.status === 'unknown' ? 'timeout' : 'not-evaluable',
      checks: 1,
      detail:
        input.consistency.status === 'unknown'
          ? `the axiom set could not be shown satisfiable (${input.consistency.reason || 'unknown'} after ` +
            `${input.consistency.timeoutMs} ms), and a proof over an axiom set nobody has checked is not a proof`
          : `the solver refused the axiom script this tool produced: ${input.consistency.reason}. ` +
            'That is a defect in this tool, not in the model',
      ...bound('none', 'no obligation was decided'),
    };
  }

  let checks = 1;
  const logic = scriptOf(variables, [...assumed, { kind: 'goal', name: nameOf(row.row), term: notTerm(goal.term) }], context).logic;

  // THE TWO-SIDED RULE, before the negation check and blocking it. Only over
  // the freed features this obligation's own context reads: a feature released
  // on the command line that no assertion in this proof mentions cannot put a
  // witness anywhere, and refusing an obligation over it would report a bound
  // that was not in force for it.
  for (const v of variables) {
    if (!v.free) continue;
    const unbounded = await unboundedSide(input.backend, variables, assumed, context, v, input.timeoutMs);
    checks += unbounded.checks;
    if (unbounded.side) {
      return {
        ...base,
        ...point,
        outcome: 'free-unbounded',
        checks,
        logic,
        detail:
          `freed feature ${v.qualifiedName} is unbounded ${unbounded.side}: the axioms and premises ` +
          `admit a value beyond ±${FREE_DOMAIN_BOUND} in its stored magnitude, and a witness outside ` +
          'the physical domain is not a counterexample. This tool derives no domain axiom from a ' +
          'quantity kind — it does not know that a power or a mass is non-negative — so the premise ' +
          'has to say so on both sides before a verdict is available',
        ...bound(
          'free-variables',
          `${countFree(variables)} freed feature(s); confinement was asked at ±${FREE_DOMAIN_BOUND} ` +
            `in stored magnitudes and ${v.qualifiedName} escaped it ${unbounded.side}`,
        ),
      };
    }
  }

  // STEP 1: is the negation satisfiable?
  const negation = await input.backend.check(
    scriptOf(variables, [...assumed, { kind: 'goal', name: nameOf(row.row), term: notTerm(goal.term) }], context).text,
    { timeoutMs: input.timeoutMs, variables: variables.map((v) => v.qualifiedName) },
  );
  checks += 1;

  if (negation.status === 'unknown') {
    return {
      ...base,
      ...point,
      outcome: 'timeout',
      checks,
      logic,
      detail:
        `unknown after ${negation.timeoutMs} ms (${negation.reason || 'no reason given'}) — the solver ` +
        'was asked and did not answer, so nothing is claimed either way. It was not retried with a ' +
        'weaker encoding',
      ...bound('timeout', `a single bounded check of ${negation.timeoutMs} ms in ${logic}`),
    };
  }
  if (negation.status === 'error') {
    return {
      ...base,
      ...point,
      outcome: 'not-evaluable',
      checks,
      logic,
      detail:
        `the solver refused the script this tool produced: ${negation.reason}. That is a defect in ` +
        'this tool, not in the model, and it is never folded into the undecided codes a flag may forgive',
      ...bound('none', 'the script was refused, so nothing was decided'),
    };
  }

  if (negation.status === 'unsat') {
    // STEP 2: was the antecedent satisfiable at all?
    const antecedent = await input.backend.check(scriptOf(variables, assumed, context).text, {
      timeoutMs: input.timeoutMs,
      variables: variables.map((v) => v.qualifiedName),
    });
    checks += 1;
    if (antecedent.status === 'unsat') {
      return {
        ...base,
        ...point,
        outcome: 'vacuous',
        checks,
        logic,
        detail:
          'the premises are unsatisfiable under the axioms, so the obligation is discharged ' +
          'by an antecedent that cannot hold and says nothing about the design' +
          (antecedent.core.length > 0 ? `. core: ${coreSentence(antecedent.core)}` : ''),
        ...bound('none', 'nothing satisfies the assumptions, so there is no point the claim holds at'),
      };
    }
    if (antecedent.status !== 'sat') {
      return {
        ...base,
        ...point,
        outcome: 'timeout',
        checks,
        logic,
        detail:
          `the negation was unsat, but the assumptions could not be shown satisfiable ` +
          `(${antecedent.reason || antecedent.status} after ${antecedent.timeoutMs} ms). A pass without a ` +
          'satisfiable-assumptions witness is a pass that may be vacuous, so this row stays undecided',
        ...bound('timeout', `a bounded check of ${antecedent.timeoutMs} ms in ${logic}`),
      };
    }

    // STEP 3: is the goal true of every model, whatever the context says?
    const alone = await input.backend.check(
      scriptOf(row.vars, [{ kind: 'goal', name: nameOf(row.row), term: notTerm(goal.term) }], [row]).text,
      { timeoutMs: input.timeoutMs },
    );
    checks += 1;
    const tautology = alone.status === 'unsat';
    return {
      ...base,
      ...point,
      outcome: 'proved',
      tautology,
      checks,
      logic,
      witness: antecedent.witness,
      detail:
        `A ∧ P ∧ ¬G unsat, ${logic}, ` +
        `${variables.length - countFree(variables)} fixed / ${countFree(variables)} free, ` +
        `timeout ${negation.timeoutMs} ms; assumptions satisfiable` +
        (tautology
          ? '. TAUTOLOGY: the goal is unsat when negated on its own, so it is true of every model and ' +
            'says nothing about this one'
          : ''),
      ...bound(
        countFree(variables) === 0 ? 'model-values' : 'free-variables',
        (countFree(variables) === 0
          ? `every feature at the value the model binds it to; ${variables.length} symbol(s), 0 free` +
            `${siSentence(si)}`
          : `${countFree(variables)} freed feature(s), each confined on both sides within ` +
            `±${FREE_DOMAIN_BOUND} in stored magnitudes; ${variables.length} symbol(s)`) +
          solverSentence(input.backend),
      ),
    };
  }

  // SAT: a candidate counterexample. Nothing below prints it as a violation
  // until the tool's own evaluator agrees with it.
  const witness = negation.witness;
  const confirmation = confirm(model, row, witness, input, countFree(variables) > 0);
  if (!confirmation.ok) {
    return {
      ...base,
      ...point,
      outcome: 'witness-unconfirmed',
      checks,
      logic,
      witness,
      detail: `witness not confirmed: ${confirmation.why}. A counterexample this tool cannot reproduce is not a violation`,
      ...bound('none', 'a witness was found and not confirmed, so nothing is claimed'),
    };
  }
  // A REFUTATION NEEDS THE WHOLE CONTEXT — the whole context OF THIS
  // OBLIGATION, which is not the whole model.
  //
  // `axiomsRefused` is the run-level set, and reading it directly made one
  // refused feature value anywhere in a file suppress every refutation in it:
  // `attribute parity = seats % 2` shares no symbol with `bus.mass <= 2000
  // [kg]` and cannot possibly exclude a witness for it, yet it downgraded a
  // confirmed counterexample to `verification/not-evaluable` (exit 2) while
  // `--engine literal` reported the same row `refuted` (exit 1) on the same
  // file. Only a refusal that touches a symbol the goal or its premises READ
  // can exclude this witness, and `reached` is the closure {@link
  // relevantAxioms} already computes for exactly that question. A refusal with
  // no readable variables at all is kept: its reach is unknown, and the
  // conservative reading of unknown is that it might matter.
  const droppedAxioms = input.axiomsRefused.filter(
    (a) => a.vars.length === 0 || a.vars.some((v) => reached.has(v.qualifiedName)),
  );
  if (droppedAxioms.length > 0 || input.premises.some((p) => p.encoded === undefined)) {
    const dropped = [...droppedAxioms, ...input.premises.filter((p) => p.encoded === undefined)];
    return {
      ...base,
      ...point,
      outcome: 'witness-unconfirmed',
      checks,
      logic,
      witness,
      detail:
        `a counterexample was found under a PARTIAL context: ${dropped.length} relation(s) in the ` +
        `proof context were refused by a gate (${dropped
          .map((d) => `${d.row.element.qualifiedName}: ${d.refusal?.reason ?? 'refused'}`)
          .join('; ')}), and the very relation that was dropped may exclude this witness. A proof under ` +
        'a partial context would still be sound; a refutation is not',
      ...bound('none', 'the context was incomplete, so the counterexample is not claimed'),
    };
  }

  const freedWitness = witnessSentence(witness, variables);
  if (countFree(variables) > 0) {
    return {
      ...base,
      ...point,
      outcome: 'design-admitted',
      checks,
      logic,
      witness,
      detail:
        'design admitted by the model, not a violation of it: the counterexample exists only because ' +
        `--free released ${variables.filter((v) => v.free).map((v) => v.qualifiedName).join(', ')}, and a ` +
        '`=` value is a binding the model states. ' +
        'Re-run without --free for the verdict at the model’s own values',
      ...bound(
        'free-variables',
        `${countFree(variables)} freed feature(s), each confined within ±${FREE_DOMAIN_BOUND} in ` +
          `stored magnitudes${freedWitness}${solverSentence(input.backend)}`,
      ),
    };
  }
  return {
    ...base,
    ...point,
    outcome: 'refuted',
    checks,
    logic,
    witness,
    detail:
      `refuted with every feature at its model value: \`${row.row.expression}\` is false here` +
      (si.lhsSI !== undefined && si.rhsSI !== undefined
        ? ` (${si.lhsSI} vs ${si.rhsSI}${si.dimension ? ` in ${si.dimension}` : ''}, coherent SI)`
        : '') +
      ', confirmed by re-evaluation on the numeric surface',
    ...bound(
      'model-values',
      `every feature at the value the model binds it to; ${variables.length} symbol(s), 0 free` +
        `${siSentence(si)}${solverSentence(input.backend)}`,
    ),
  };
}

/**
 * The axioms this obligation can reach, by shared symbols.
 *
 * WHY PRUNE AT ALL — it is not a performance decision, though it is also that.
 * A model states facts about every part it has, and an obligation about the
 * take-off mass proved under an axiom set that also mentions the data-link
 * frequency reports "12 fixed / 0 free" about a relation that reads one
 * variable. Worse, under `--free` it inherits every freed feature in the file:
 * releasing `cruisePower` made the MASS requirement inconclusive for
 * unboundedness in a variable its own proof never mentions.
 *
 * WHY IT IS SOUND. Assertions that share no variable with the goal, directly or
 * transitively, factorise: a satisfying assignment for the rest can always be
 * pasted onto one for the component, so dropping them changes neither
 * satisfiability nor unsatisfiability of `A ∧ P ∧ ¬G`. Step 0 has already
 * established that the WHOLE axiom set is satisfiable, which is what makes that
 * pasting available.
 *
 * WHY THE PREMISES SEED IT TOO, and are never themselves pruned. Step 2 asks
 * whether `A ∧ P` can hold at all, and a premise that shares no symbol with the
 * goal can still be unsatisfiable against an axiom — which is exactly the
 * vacuity this lane must not hide. So every premise is kept, and the closure is
 * seeded from the goal's symbols and theirs together.
 */
function relevantAxioms(
  axioms: readonly EncodedRow[],
  premises: readonly EncodedRow[],
  goal: EncodedRelation,
): { kept: EncodedRow[]; reached: Set<string> } {
  const reached = new Set<string>(goal.reads);
  for (const p of premises) for (const r of p.encoded?.reads ?? []) reached.add(r);
  const kept: EncodedRow[] = [];
  const taken = new Set<EncodedRow>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of axioms) {
      if (taken.has(a)) continue;
      const reads = a.encoded?.reads ?? [];
      // A refused axiom has no symbols to connect through; it is carried anyway
      // so the "a refutation needs the whole context" rule can still see it.
      if (a.encoded !== undefined && !reads.some((r) => reached.has(r))) continue;
      taken.add(a);
      kept.push(a);
      for (const r of reads) reached.add(r);
      grew = true;
    }
  }
  // `reached` is returned as well as used: it is the set the "a refutation
  // needs the whole context" rule is written over, and recomputing it there
  // would be a second reading of one closure.
  return { kept, reached };
}

/**
 * Which solver answered, in the words a verdict has to name it by.
 *
 * It goes in the BOUND rather than in the claim sentence, and that is
 * deliberate: the evidence record carries the bound, so the solver that ran is
 * recorded — while the golden verdict corpus pins `detail`, and a claim
 * sentence carrying a version string would make every golden a pin on
 * the solver package's release schedule rather than on this tool's behaviour.
 * (The package is named nowhere in this file on purpose: the browser-build
 * guard in `test/integration/smt-z3.integration.test.ts` holds every source
 * that names it to the variable-specifier form, and this engine never imports
 * it at all — the backend is passed in.)
 */
function solverSentence(backend: Z3Backend): string {
  return `; decided by z3 ${backend.fullVersion}, seed ${backend.seed}`;
}

/**
 * An unsat core, in an order this tool chose rather than the one z3 happened to
 * build it in.
 *
 * A core is a SET of assertion labels and z3's ordering of it carries no
 * meaning — but this sentence is pinned in the L8 goldens, and MEASURED: the
 * same model produced `axiom:…flow, premise:…FlowCeiling` when its suite ran
 * alone and the two the other way round inside the full 138-file suite. A
 * golden that moves with the worker pool is a golden that tests contention, so
 * the set is sorted before it is printed and the diff is about behaviour again.
 */
function coreSentence(core: readonly string[]): string {
  return [...core].sort().join(', ');
}

/** How many of these variables the caller released. */
function countFree(variables: readonly EncodeVariable[]): number {
  return variables.filter((v) => v.free).length;
}

/** The SI pair, printed beside a bound so a reader can check the comparison. */
function siSentence(si: { lhsSI?: number; rhsSI?: number; dimension?: string }): string {
  if (si.lhsSI === undefined || si.rhsSI === undefined) return '';
  return `; compared as ${si.lhsSI} vs ${si.rhsSI}${si.dimension !== undefined ? ` in ${si.dimension}` : ''}, coherent SI`;
}

/** The freed features' witness values, for the bound sentence. Never for `detail`. */
function witnessSentence(
  witness: readonly WitnessValue[],
  variables: readonly EncodeVariable[],
): string {
  const freedNames = new Set(variables.filter((v) => v.free).map((v) => v.qualifiedName));
  if (freedNames.size === 0) return '';
  const shown = witness.filter((w) => freedNames.has(w.symbol));
  if (shown.length === 0) return '';
  return `; witness ${shown.map((w) => `${w.symbol} = ${w.term}`).join(', ')} (stored magnitudes)`;
}

/**
 * Is a freed feature unbounded on either side under this context?
 *
 * Two bounded checks per freed feature — see {@link FREE_DOMAIN_BOUND} for why
 * confinement is what is actually asked, and why the failure direction of that
 * approximation is the safe one.
 */
async function unboundedSide(
  backend: Z3Backend,
  variables: readonly EncodeVariable[],
  assumed: readonly ScriptAssertion[],
  rows: readonly EncodedRow[],
  v: EncodeVariable,
  timeoutMs: number | undefined,
): Promise<{ side: 'above' | 'below' | null; checks: number }> {
  const symbol = symbolOf(v.qualifiedName);
  if (symbol === undefined) return { side: null, checks: 0 };
  // Read through `to_real` for an Int-sorted feature, exactly as the encoder
  // reads one, so the comparison against a Real bound is well-sorted.
  const read = v.sort === 'Int' ? `(to_real ${symbol})` : symbol;
  const bound = exactNumeral(FREE_DOMAIN_BOUND);
  let checks = 0;
  for (const [side, term] of [
    ['above', `(> ${read} ${bound})`],
    ['below', `(< ${read} (- ${bound}))`],
  ] as const) {
    const probe = scriptOf(
      variables,
      [...assumed, { kind: 'goal', name: `free-domain:${v.qualifiedName}`, term }],
      rows,
    );
    const outcome = await backend.check(probe.text, { timeoutMs });
    checks += 1;
    // `unknown` is treated as escaping the bound: the safe direction is to
    // decline the verdict, never to assume a confinement nobody proved.
    if (outcome.status !== 'unsat') return { side, checks };
  }
  return { side: null, checks };
}

/* ─────────────────────── the witness re-evaluation gate ──────────────────── */

/**
 * Substitute a SAT witness back through the tool's own evaluator, before it is
 * printed.
 *
 * TWO GATES, and the second is the one with independent teeth. The first
 * re-evaluates the relation with each variable read exactly as the ENCODER read
 * it (its own scale, its own factor), which catches a term built wrong — a
 * flipped comparison, a mis-parenthesised product, a numeral that is not the
 * number the tool holds. The second applies only when nothing was freed, and it
 * asks the NUMERIC SURFACE: with every feature at its model value, a
 * counterexample must be a `violated` reading of `checkConstraints`. That is a
 * different implementation reached through a different path, and it is the
 * comparison the differential gate of §5 is built on.
 *
 * Note the limit this gate has, exposed by the `cruisePower = -1 W` case:
 * re-evaluation confirms ARITHMETIC, not physical admissibility. That is why
 * the two-sided rule above is a separate and blocking check.
 */
function confirm(
  model: Model,
  row: EncodedRow,
  witness: readonly WitnessValue[],
  input: JudgeInput,
  /** Did THIS proof release anything? Not the run — this obligation's context. */
  anyFreed: boolean,
): { ok: true } | { ok: false; why: string } {
  const node = row.row.node;
  if (node === null) return { ok: false, why: 'the relation has no readable body to re-evaluate' };

  const values = new Map<string, number | boolean>();
  for (const w of witness) if (w.value !== null) values.set(w.symbol, w.value);
  const scope = (name: string): unknown => {
    const v = row.vars.find((x) => x.path === name || x.qualifiedName === name);
    if (!v) return undefined;
    const raw = values.get(v.qualifiedName);
    if (raw === undefined) return undefined;
    if (typeof raw === 'boolean') return raw;
    return raw * v.factor + v.offset;
  };
  const reread = evaluate(node, scope);
  if (!('value' in reread)) {
    return { ok: false, why: 'the tool’s own evaluator could not read the relation at the witness' };
  }
  if (reread.value !== false) {
    return {
      ok: false,
      why: `the tool’s own evaluator makes the relation ${String(reread.value)} at the witness, not false`,
    };
  }

  // The second gate, and the independent one: with nothing in THIS proof
  // released, the witness can only be the model's own values, so the numeric
  // surface must read the relation as violated there. A different
  // implementation, reached through a different path — which is what makes it
  // worth asking.
  if (!anyFreed) {
    const check = input.checks.get(row.row.element.id);
    if (check?.result !== 'violated') {
      return {
        ok: false,
        why:
          'with nothing freed the witness must be the model’s own values, and the numeric surface ' +
          `reads this relation as \`${check?.result ?? 'not gathered'}\` there` +
          (check?.message ? ` (${check.message})` : ''),
      };
    }
  }
  return { ok: true };
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
