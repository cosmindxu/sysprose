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
import { hasStatedValue, sharedDefinitions } from '../defining-equation';
import {
  checkConstraints,
  checksByRow,
  definedFeatureOf,
  evaluateFeatureValue,
  featureIdsFor,
  type ConstraintCheck,
} from '../evaluate-model';
import { rereadRelation, tieSentence, type PointValues } from '../exact';
import {
  axiomsOf,
  reachOfRow,
  rowElement,
  reachedBy,
  refusalReaches,
  type Obligation,
  type RefusalReach,
} from '../obligations';
import { type ContractVariable, type Refusal } from '../contracts';
import { idScopeFor, mergeMaps } from '../relations';
import { effectiveNameOf, effectiveQualifiedName } from '../inheritance';
import { dimToString } from '../units';
import { evaluateConstraintQuantityDetailed, type DerivationMemo } from '../units-eval';
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
import { rereadPoint, type CheckOutcome, type WitnessValue, type Z3Backend } from '../smt/z3-bridge';
import {
  isOutsideTheFragment,
  modelBindings,
  readPremise,
  unreadOutcome,
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

/**
 * The sentence that has to stand beside every printed unsat core, and the
 * reason the core is worth printing at all only with it.
 *
 * An unsat core is A sufficient reason, chosen by the solver, and it is not the
 * set of assumptions the claim depends on. MEASURED on a model with
 * `mtow = 18.5`, `mtowCapA {mtow <= 20}` and `mtowCapB {mtow <= 22}` all in
 * scope: z3's core for `mtow <= 25.0 [kg]` is `{axiom:…mtowCapB, goal:…}` — as
 * small as any sufficient set could be here, naming the WEAKEST of the three
 * reasons, and not naming the model's own value at all. Swapping the two caps'
 * declaration order did not move the pick. So both false readings are live, and the dangerous one
 * is the second: an axiom absent from a core may still carry the claim.
 *
 * It is not the word `minimal` either, and that word is reserved: `consistency
 * --minimize` runs a deletion loop and is what earns it. Nothing here deletes.
 */
export const CORE_SUFFICIENCY_NOTE =
  'the set z3 returned is sufficient, not minimal: an axiom listed here may not have been ' +
  'needed, and an axiom NOT listed may still carry the claim';

/** `axiom:Foo::bar#2` → `{ kind: 'axiom', name: 'Foo::bar' }`. */
export function coreLabelParts(label: string): { kind: string; name: string } {
  const at = label.indexOf(':');
  if (at < 0) return { kind: '', name: label };
  // The `#2` suffix is `encodeScript`'s own disambiguation of two assertions
  // that mangled to one label — an artefact of the script, not part of any
  // name — so it is dropped for display and the member is still counted once
  // per occurrence by every caller that counts.
  return { kind: label.slice(0, at), name: label.slice(at + 1).replace(/#\d+$/, '') };
}

/** How many members of a core carry this label kind. */
export function coreCount(core: readonly string[], kind: string): number {
  return core.filter((label) => coreLabelParts(label).kind === kind).length;
}

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

/**
 * How many axioms this obligation's proof was drawn from, offered from, asked
 * with, and answered from — the four numbers `--why` reads and `--json`
 * publishes.
 *
 * It is a CENSUS and not a claim: it says how far the solver's own answer
 * narrowed the model's axiom set for this row, and nothing about which of them
 * the requirement depends on. The narrowing is what decides whether a
 * core-scoped staleness check is worth building at all, and it cannot be
 * decided by reasoning — measured, `examples/uav-isr.sysml` narrows not at all
 * (the core equals the footprint on both of its obligations) while
 * `examples/uav-power-budget.sysml` narrows on five of its six, 24 footprint
 * axioms to 9 core axioms in total.
 *
 * `scriptAxioms` counts ASSERTIONS and `footprintAxioms` counts ROWS, which is
 * why they are two numbers: an axiom whose body divides by a variable is
 * asserted twice — once as itself, once as the side condition the encoding adds
 * — and a reader comparing `coreAxioms` against the wrong one of the two would
 * read a narrowing that did not happen.
 */
export interface AxiomCensus {
  /** Every axiom row this run encoded from the model — the denominator. */
  modelAxioms: number;
  /** The axiom rows this obligation's read-closure kept — see {@link relevantAxioms}. */
  footprintAxioms: number;
  /** The assertions those rows put in the script, side conditions included. */
  scriptAxioms: number;
  /** How many `axiom:` labels the solver's own unsat core named. 0 where none did. */
  coreAxioms: number;
}

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
  /**
   * The `:named` labels of the NEGATION check's unsat core, sorted.
   *
   * Populated on `proved` and empty everywhere else, because that is the only
   * outcome whose core is about this obligation's proof: `axioms-inconsistent`
   * carries step 0's core (a property of the whole file) and `vacuous` carries
   * step 2's (a property of the premises), and both of those print their own
   * core in {@link detail} already. Three cores under one field name would be
   * three different claims read as one.
   *
   * Sorted for the reason {@link coreSentence} is sorted: z3's ordering of a
   * SET carries no meaning and was measured to move with worker-pool
   * contention, so a golden over the unsorted form tests the pool.
   *
   * AND ITS MEMBERSHIP MOVES TOO, which is why nothing in {@link detail} quotes
   * it and why no golden verdict pins it. Measured on `examples/uav-isr.sysml`,
   * one model, one tool, one seed: the endurance proof's core is SIX labels in a
   * fresh process and FIVE — the same four axioms and the goal, without the side
   * condition — when the same obligation is judged inside a test worker running
   * the whole verdict corpus of `test/campaign/verification.test.ts`. WHY the
   * two runs differ is NOT established, and no mechanism is asserted here: a
   * probe repeating the call, and one judging every model of that corpus first,
   * both return the six in one process. The observation is what this comment
   * rests on. Both cores are sufficient reasons and neither is wrong; a `detail`
   * string quoting either would put a solver's choice into the evidence record,
   * whose byte-identity across two runs over an unchanged file is a promise this
   * lane makes. It is printed by `verify --why`, which is a display on a spawned
   * run, and counted in {@link AxiomCensus}, which is `--json`.
   *
   * The set is SUFFICIENT, never minimal — see {@link CORE_SUFFICIENCY_NOTE},
   * which is the sentence anything printing this field has to print with it.
   */
  core: readonly string[];
  /**
   * The four axiom counts, or `null` where no script was built for this row.
   *
   * `null` rather than four zeroes: a row the encoder refused never had a
   * script, and "0 axioms in the script" is a measurement, not an absence.
   */
  axiomCensus: AxiomCensus | null;
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
  opts: { measure?: boolean } = {},
): FreeResolution {
  const scope = new Map<string, ElementId>();
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || el.attrs.implicit === true) continue;
    if (!el.eClass.endsWith('Package')) continue;
    for (const [name, id] of idScopeFor(model, el.id)) if (!scope.has(name)) scope.set(name, id);
  }
  const byQualifiedName = new Map<string, ElementId>();
  // BARE NAMES ARE COUNTED SEPARATELY, because `idScopeFor` cannot answer this
  // question: it offers a bare name for the feature a relation body would read
  // — a nested one only where exactly one feature below has the name — and
  // was FIRST-WINS once, so two `mass` attributes in two part definitions
  // collapsed to one entry and `--free mass` silently released whichever the
  // model walk reached first. The count is taken over the user's own names (by
  // effective name: an unnamed `:>> mass` is `mass`), which is what "unique in
  // scope" means to the person typing it.
  const byDeclaredName = new Map<string, Set<ElementId>>();
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || el.attrs.implicit === true) continue;
    // By the name the lane's symbols carry: an unnamed redefinition (`attribute
    // :>> load = 50.0` in `p`) is `R::p::load`, as every relation reads it.
    byQualifiedName.set(effectiveQualifiedName(model, el.id), el.id);
    const declared = effectiveNameOf(model, el);
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
  // An INSTANCE's own symbol (`R::p1::g`, for `p1.g` over `part def G {
  // attribute g; }`) names that instance's value: spelled as the symbol, or as
  // the dotted path a relation reads it by (`p1.g`), it releases that one.
  const bySymbol = new Map<string, ElementId>();
  for (const r of rows) for (const v of r.vars) if (v.instance) bySymbol.set(v.qualifiedName, v.featureId);
  const definitions = sharedDefinitions(model);
  const pathSymbol = new Map<string, { symbol: string; same: boolean }>();
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || el.attrs.implicit === true) continue;
    if (!el.eClass.endsWith('Package')) continue;
    for (const [name, d] of definitions.denote(el.id)) {
      if (pathSymbol.has(name)) continue;
      pathSymbol.set(name, { symbol: definitions.symbolOf(d), same: definitions.valueRef(d)?.at === undefined });
    }
  }
  // The symbol a dotted path names. A MEASURE read through an instance no
  // relation reads, which changes nothing its value reads, is bounded by the
  // feature's own: the instance holds exactly what every instance holds, and
  // no fact of its own. A release is never widened so: it would free every
  // instance's value where one was asked for.
  const symbolAt = (spelling: string, id: ElementId): string => {
    const at = pathSymbol.get(spelling);
    if (!at) return effectiveQualifiedName(model, id);
    if (opts.measure && at.same && !readable.has(at.symbol)) return effectiveQualifiedName(model, id);
    return at.symbol;
  };

  const features = new Map<string, ElementId>();
  const qualifiedNames = new Set<string>();
  const unresolved: string[] = [];
  const ambiguous: Array<{ spelling: string; candidates: string[] }> = [];
  const unread: Array<{ spelling: string; qualifiedName: string }> = [];
  for (const spelling of spellings) {
    const exact = byQualifiedName.get(spelling) ?? bySymbol.get(spelling);
    // Only a BARE name can be ambiguous: a qualified name is exact and a dotted
    // path is a route, so neither can name two things. A bare name the scope
    // offers no feature for — it offers a nested one only where exactly one
    // has the name — is still a name the person typed: counted below.
    const bare = exact === undefined && !spelling.includes('.') && !spelling.includes('::');
    const declared = bare ? byDeclaredName.get(spelling) : undefined;
    const id = exact ?? scope.get(spelling) ?? (declared ? [...declared][0] : undefined);
    if (id === undefined) {
      unresolved.push(spelling);
      continue;
    }
    const named = bare ? (declared ?? new Set([id])) : new Set([id]);
    if (named.size > 1) {
      ambiguous.push({
        spelling,
        candidates: [...named].map((e) => model.qualifiedName(e)).sort(),
      });
      continue;
    }
    const qualifiedName = bySymbol.has(spelling)
      ? spelling
      : exact === undefined && scope.has(spelling)
        ? symbolAt(spelling, id)
        : effectiveQualifiedName(model, id);
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
  const checks = checksByRow(checkConstraints(model));

  const encodedRows = rows.map((row) => encodeRow(row, free));
  const byId = new Map<ElementId, EncodedRow>(encodedRows.map((e) => [e.row.element.id, e]));

  // A feature-value axiom that PINS a freed feature is dropped: that is what
  // `--free` means. Nothing else is dropped — a `bind` edge and an `assert`
  // are separate statements about the model, and silently deleting them would
  // widen the design space past what the reader asked for.
  // The axiom set, chosen by the SAME predicate the model-level `footprintOf`
  // reads — `axiomsOf` over the rows — so a footprint computed without an
  // encoder cannot name an axiom this run did not carry.
  const axiomIds = new Set<ElementId>(axiomsOf(rows, free).map((r) => r.element.id));
  const axioms = encodedRows.filter((e) => axiomIds.has(e.row.element.id));
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

  const memo: DerivationMemo = new Map();
  const scopes = new Map<ElementId, Map<string, ElementId>>();
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
        scopes,
        backend,
        free,
        timeoutMs,
        checks,
        memo,
      }),
    });
  }
  return out;
}

/**
 * The footprint this engine would compute for one obligation, as element ids.
 *
 * EXPORTED FOR ONE TEST, and the test is the reason the model-level twin is
 * allowed to exist. `footprintOf` (`src/semantics/obligations.ts`) computes the
 * same read-closure without an encoder, because the staleness rule is
 * synchronous and reachable from the browser bundle; this function is the
 * ENCODER'S answer, and `test/campaign/verification.test.ts` asserts the two
 * sets are equal over every case of the verdict corpus. Without it the twin
 * would be a re-derivation nobody could check, and a re-derivation that drifted
 * would scope a proof's staleness to axioms the proof did not stand on.
 *
 * No solver: {@link relevantAxioms} is syntactic, so this costs an encode and
 * nothing else.
 *
 * `null` where this row never had a script — the encoder refused the goal, so
 * no closure was taken. That is the same distinction {@link AxiomCensus} makes
 * by being `null` rather than four zeroes.
 */
export function encodedFootprint(
  rows: readonly Obligation[],
  obligation: Obligation,
  free: ReadonlySet<string> = new Set<string>(),
): ReadonlySet<ElementId> | null {
  const encodedRows = rows.map((row) => encodeRow(row, free));
  const axiomIds = new Set<ElementId>(axiomsOf(rows, free).map((r) => r.element.id));
  const axioms = encodedRows.filter((e) => axiomIds.has(e.row.element.id));
  const premises = encodedRows.filter(
    (e) =>
      e.row.role === 'premise' &&
      e.row.requirement !== null &&
      obligation.requirement !== null &&
      e.row.requirement.id === obligation.requirement.id,
  );
  const goal = encodedRows.find((e) => e.row.element.id === obligation.element.id)?.encoded;
  if (goal === undefined) return null;
  const { kept } = relevantAxioms(axioms, premises, goal);
  return new Set<ElementId>(kept.map((e) => e.row.element.id));
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
  /** The numeric surface's name → feature map of each context it was asked about, for the run. */
  scopes: Map<ElementId, Map<string, ElementId>>;
  backend: Z3Backend;
  free: ReadonlySet<string>;
  timeoutMs: number | undefined;
  checks: ReadonlyMap<ElementId, ConstraintCheck>;
  /** One derivation memo for the run's SI readings (the literal engine's reason). */
  memo: DerivationMemo;
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
    // Both filled in below the point where a script exists to measure. A row
    // that never reached one keeps these: no core, and no census rather than a
    // census of zeroes.
    core: [] as readonly string[],
    axiomCensus: null as AxiomCensus | null,
  };

  // Nothing to ask a solver about.
  if (row.refusal) {
    const refusal = row.refusal;
    // A refused row has NO proof context, so the only release that could reach
    // it is one on its own variables — which is what `rowFreed` answers.
    // The unit-aware pair, on the same precondition the literal engine reads it
    // under: a row with no readable body has no comparison to print.
    const refusedSI = row.row.node !== null ? quantities(model, row.row, input.memo) : {};
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
    // …OF THE FEATURES THE RELATION NAMES. A `violated` the numeric surface
    // read over a different feature is no violation of this one, exactly as it
    // confirms no counterexample of it (`confirm`): `x % 4.0 >= 3.5` in a P
    // whose own `x` has no value was read at a nested part's `x = 7.0` and
    // printed refuted, exit 1. The two surfaces then read the relation
    // differently, which nothing forgives.
    const elsewhere = !rowFreed && check?.result === 'violated' ? readElsewhere(model, row.row, input.scopes) : undefined;
    if (elsewhere) {
      return {
        ...base,
        ...refusedPoint,
        outcome: 'not-evaluable',
        detail:
          `the numeric surface reads \`${elsewhere.path}\` as ${elsewhere.check} where this relation names ` +
          `${elsewhere.encoder}, so its \`violated\` is a reading of a different feature — and a gate refuses the ` +
          `relation for the solver lane (${refusal.reason}: ${refusal.detail}), so nothing reads it as written. ` +
          '`--allow-inconclusive` does not forgive it',
        boundKind: 'none',
        boundDetail: 'no relation was encoded, and the point reading is of another feature, so nothing is claimed',
      };
    }
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
    countFree(variables) === 0 ? quantities(model, row.row, input.memo) : {};
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
  // The census, from the point a script exists to take it over. `core` is
  // passed in rather than read from a variable because only one branch below
  // has one: everything else reports the same three numbers with `coreAxioms`
  // at 0, which is what "no core was named here" looks like as a measurement.
  const census = (core: readonly string[] = []): AxiomCensus => ({
    modelAxioms: input.axioms.length,
    footprintAxioms: axioms.length,
    scriptAxioms: axiomAssertions.length,
    coreAxioms: coreCount(core, 'axiom'),
  });

  // STEP 0's answer, read here so every obligation reports it.
  if (input.consistency.status === 'unsat') {
    return {
      ...base,
      ...point,
      outcome: 'axioms-inconsistent',
      axiomCensus: census(),
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
      axiomCensus: census(),
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
  // ONE encoding of the negation script, read for its logic line here and sent
  // to the solver at step 1 below. It was encoded twice — the same arguments,
  // the same bytes — and the second copy was there only to be checked; a core
  // read back from a script this function did not keep would be labels nothing
  // in it could be matched against.
  const negationScript = scriptOf(
    variables,
    [...assumed, { kind: 'goal', name: nameOf(row.row), term: notTerm(goal.term) }],
    context,
  );
  const logic = negationScript.logic;

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
        axiomCensus: census(),
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
  const negation = await input.backend.check(negationScript.text, {
    timeoutMs: input.timeoutMs,
    variables: variables.map((v) => v.qualifiedName),
  });
  checks += 1;

  if (negation.status === 'unknown') {
    return {
      ...base,
      ...point,
      outcome: 'timeout',
      axiomCensus: census(),
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
      axiomCensus: census(),
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
        axiomCensus: census(),
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
        axiomCensus: census(),
        checks,
        logic,
        detail:
          `the negation was unsat, but the assumptions could not be shown satisfiable ` +
          `(${antecedent.reason || antecedent.status} after ${antecedent.timeoutMs} ms). A pass without a ` +
          'satisfiable-assumptions witness is a pass that may be vacuous, so this row stays undecided',
        ...bound('timeout', `a bounded check of ${antecedent.timeoutMs} ms in ${logic}`),
      };
    }

    // AN ASSUMPTION OVER A VALUE THIS TOOL DOES NOT READ HERE cannot be read
    // at the model either. Its name is a symbol of its own, shared with the
    // goal of the same requirement, so `assume p.e >= 10.0` / `require p.e >=
    // 9.0` was PROVED although P's equation makes `p.e` 6 — the assumption is
    // false at the model, and the pass vacuous. Whether it is cannot be
    // decided here, so no pass is printed: undecided, as the literal engine
    // files an assumption that does not evaluate.
    const unreadPremise = input.premises.find((p) => (p.row.unread?.length ?? 0) > 0);
    if (unreadPremise) {
      return {
        ...base,
        ...point,
        outcome: 'not-evaluable',
        axiomCensus: census(),
        checks,
        logic,
        detail:
          `proof not claimed: A ∧ P ∧ ¬G is unsat, but the assumption \`${unreadPremise.row.expression}\` reads ` +
          `${(unreadPremise.row.unread ?? []).map((n) => `\`${n}\``).join(', ')} — a value whose definition is ` +
          'written in another context, which this tool does not read here — so whether it holds at the model, and so whether ' +
          'this pass is vacuous, is undecided. That value exists in the model, and `--allow-inconclusive` does not ' +
          'forgive it',
        ...bound('none', 'an assumption turns on a value this tool does not read here, so nothing is claimed'),
      };
    }

    // AN ASSUMPTION NO SURFACE READS — one over a name its own clause declares,
    // which its owner's scope answers with another feature (`shadowedNamesOf`
    // of ../defining-equation) — was refused, so the proof above stood on the
    // other assumptions alone. Whether it holds at the model is undecided, and
    // so is whether this pass is vacuous: `assume constraint { in y = 100.0; y
    // <= 10.0 }` is false, and the requirement says nothing about the design.
    const shadowedPremise = input.premises.find((p) => (p.row.shadowed?.length ?? 0) > 0);
    if (shadowedPremise) {
      return {
        ...base,
        ...point,
        outcome: 'not-evaluable',
        axiomCensus: census(),
        checks,
        logic,
        detail:
          `proof not claimed: A ∧ P ∧ ¬G is unsat without the assumption \`${shadowedPremise.row.expression}\`, ` +
          `which no surface reads (${(shadowedPremise.row.encodable as Refusal).detail}). Whether it holds at the ` +
          'model, and so whether this pass is vacuous, is undecided, and `--allow-inconclusive` does not forgive it',
        ...bound('none', 'an assumption no surface reads may make the pass vacuous, so nothing is claimed'),
      };
    }

    // THE ASSUMPTIONS WERE SHOWN SATISFIABLE WITHOUT EVERY RELATION THEY STAND
    // ON — see {@link partialAntecedent}.
    const partial = partialAntecedent(model, input, row, axioms, reached, countFree(variables) > 0);
    if (partial) {
      return {
        ...base,
        ...point,
        ...partial,
        axiomCensus: census(),
        checks,
        logic,
      };
    }

    // STEP 3: is the goal true of every model, whatever the context says?
    const alone = await input.backend.check(
      scriptOf(row.vars, [{ kind: 'goal', name: nameOf(row.row), term: notTerm(goal.term) }], [row]).text,
      { timeoutMs: input.timeoutMs },
    );
    checks += 1;
    const tautology = alone.status === 'unsat';
    const core = sortedCore(negation.core);
    // A PROOF AT THE MODEL'S OWN VALUES IS CONFIRMED, as a refutation is.
    // With nothing in this proof released, every symbol is pinned to the
    // value the model states, and the numeric surface reads the same relation
    // at those values. It decides a tie by the decimals written, as this
    // engine does (the tie rule of ../exact), so `e != 3544.6153846 [s]` over
    // 640 Wh / 650 W is satisfied on both; where it reads the relation
    // VIOLATED all the same, the two readings disagree about something else,
    // and printing `proved` beside a violation would be a pass the tool's own
    // other reading contradicts. It is reported undecided, with both readings.
    //
    // A RELEASE DOES NOT TAKE THE MODEL'S OWN POINT OUT OF THE CLAIM. With
    // `--free`, `proved` says the goal holds for EVERY value of the freed
    // features the assumptions admit — the model's own values among them,
    // whenever every assumption holds there. If the numeric surface reads the
    // goal violated at that point, the universal claim is contradicted by the
    // tool's own reading of one of its instances, however the release was
    // chosen (an unrelated feature freed was enough to step around the guard
    // above).
    const pointCheck = input.checks.get(row.row.element.id);
    const freed = countFree(variables) > 0;
    const atModelPoint = !freed || input.readings.every((p) => p.holds === 'holds');
    if (pointCheck?.result === 'violated' && atModelPoint) {
      return {
        ...base,
        ...point,
        outcome: 'witness-unconfirmed',
        axiomCensus: census(),
        checks,
        logic,
        detail:
          `proof not confirmed: A ∧ P ∧ ¬G is unsat in exact arithmetic, but ` +
          (freed
            ? `the model's own values — where every assumption holds — are a point the proof covers over its ` +
              `${countFree(variables)} freed feature(s), and the numeric surface reads this relation as ` +
              `\`violated\` there (${pointCheck.message}). `
            : `with nothing freed the numeric surface reads this relation as \`violated\` at the model's values ` +
              `(${pointCheck.message}). `) +
          'A pass the tool’s own evaluator contradicts is not a pass',
        ...bound('none', 'the proof and the point evaluation disagree, so nothing is claimed'),
      };
    }
    return {
      ...base,
      ...point,
      outcome: 'proved',
      tautology,
      checks,
      logic,
      witness: antecedent.witness,
      core,
      axiomCensus: census(core),
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
  const confirmation = confirm(model, row, rereadPoint(negation), input, countFree(variables) > 0);
  // A witness over a name the numeric surface reads no value for here, where
  // that surface is undecided: the answer depends on a value this tool does
  // not read — filed as the literal engine files it, as a limit of the tool.
  const unread =
    !confirmation.ok && countFree(variables) === 0
      ? unreadOutcome(model, row.row, input.checks.get(row.row.element.id))
      : undefined;
  if (unread) {
    return {
      ...base,
      ...point,
      outcome: 'not-evaluable',
      axiomCensus: census(),
      checks,
      logic,
      detail: unread.detail,
      ...bound('none', 'the relation turns on a value this tool does not read here, so nothing is claimed'),
    };
  }
  if (!confirmation.ok) {
    return {
      ...base,
      ...point,
      outcome: 'witness-unconfirmed',
      axiomCensus: census(),
      checks,
      logic,
      witness,
      detail: `witness not confirmed: ${confirmation.why}. A counterexample this tool cannot reproduce is not a violation`,
      ...bound('none', 'a witness was found and not confirmed, so nothing is claimed'),
    };
  }
  // A REFUTATION AT THE MODEL'S VALUES NEEDS EVERY ASSUMPTION TO HOLD THERE.
  // With nothing released the witness is the model's own point only for the
  // symbols the model pins, and `confirm` re-reads the GOAL alone. An
  // assumption over a symbol nothing pins — a value this tool does not read
  // here, a feature with no value, a calculation over a parameter — is met by
  // the solver's choice of it: `assume p.e >= 10.0`, over P's `e == x * 2.0`
  // (6), was satisfied by e = 10 and the requirement printed refuted, exit 1,
  // where at the model's values the assumption is false and `assume ⇒
  // require` holds. The numeric surface reads each assumption at those values
  // (`readings`, the literal engine's reading); a refutation is published only
  // where every one of them holds, and otherwise nothing is claimed.
  if (countFree(variables) === 0) {
    const open = input.readings.find((p) => p.holds !== 'holds');
    if (open) {
      return {
        ...base,
        ...point,
        outcome: 'not-evaluable',
        axiomCensus: census(),
        checks,
        logic,
        witness,
        detail:
          `refutation not claimed: a counterexample was found with nothing freed, but the assumption ` +
          `\`${open.expression}\` reads \`${open.holds}\` on the numeric surface at the model's values ` +
          `(${open.detail}) — so the witness met it by a value the model does not state, and whether the ` +
          'requirement applies at the model, and so whether it is violated there, is undecided. ' +
          '`--allow-inconclusive` does not forgive it',
        ...bound('none', 'an assumption does not hold at the model’s values as read, so the counterexample is not claimed'),
      };
    }
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
  // relevantAxioms} already computes for exactly that question — compared by
  // FEATURE as well, through the reach test every command shares
  // ({@link refusalReaches}): a refused row over a value this tool does not
  // read here reads it by a symbol of its own. A refusal with no readable
  // variables at all is kept: its reach is unknown, and the conservative
  // reading of unknown is that it might matter — save a feature value's,
  // which is its own feature ({@link reachOfRow}).
  const reachedSet = contextReach(row, axioms, input.premises, reached);
  const droppedAxioms = input.axiomsRefused.filter((a) => refusalReaches(reachOfEncoded(a), reachedSet));
  if (droppedAxioms.length > 0 || input.premises.some((p) => p.encoded === undefined)) {
    const dropped = [...droppedAxioms, ...input.premises.filter((p) => p.encoded === undefined)];
    return {
      ...base,
      ...point,
      outcome: 'witness-unconfirmed',
      axiomCensus: census(),
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
      axiomCensus: census(),
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
    axiomCensus: census(),
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

/** What one refused row would have read ({@link refusalReaches}, {@link reachOfRow}). */
function reachOfEncoded(e: EncodedRow): RefusalReach {
  return reachOfRow(e.row, e.vars.map((v) => v.qualifiedName));
}

/** What this obligation's asserted context reads: the goal, the premises, the encoded axioms kept. */
function contextReach(
  row: EncodedRow,
  axioms: readonly EncodedRow[],
  premises: readonly EncodedRow[],
  reached: ReadonlySet<string>,
): ReturnType<typeof reachedBy> {
  return reachedBy([
    ...[row, ...premises, ...axioms]
      .filter((e) => e.encoded !== undefined)
      .map((e) => ({ vars: e.row.vars, symbols: e.vars.map((v) => v.qualifiedName) })),
    { vars: [], symbols: reached },
  ]);
}

/** How the numeric surface reads one row at the model's values: a premise or assert, a value, or nothing. */
type ModelReading = 'holds' | 'fails' | 'unknown';

/**
 * "Assumptions satisfiable" over a PARTIAL antecedent, re-read at the model's
 * point — or `undefined` where the claim stands.
 *
 * Step 2 shows `A ∧ P` satisfiable, and a relation a gate refused is not in
 * `A ∧ P`. Dropping a relation makes a set EASIER to satisfy, so a proof
 * survives it and the satisfiable antecedent it stands on does not: `assume
 * p.x % 4.0 >= 3.5` beside `assume p.x >= 5.0 and p.x <= 5.5` holds nowhere,
 * and the proof printed "assumptions satisfiable"; at x = 5 the literal
 * engine called it vacuous; and a refused closed `assert { 7.0 % 4.0 == 0.0 }`
 * hid an axiom set that contradicts itself. So where a premise was refused, or
 * a refused axiom reaches this context ({@link refusalReaches}), the claim has
 * to be re-earned at the model's own point, through the numeric surface:
 *
 *  - the rows re-read are the refused ones, and every asserted one of the
 *    context that reads a feature the model gives a value the encoding does
 *    not pin — a value whose definition was refused, and what is derived from
 *    it, where the solver's point is free to differ from the model's;
 *  - an axiom among them the model's values VIOLATE is a contradiction of the
 *    model (`inconsistent-axioms`), and a premise they make FALSE is an
 *    antecedent that cannot hold (`vacuous`) — every value read is a binding,
 *    with nothing freed;
 *  - where every one HOLDS, the model's point (the solver's, for the features
 *    the model gives no value) satisfies the whole antecedent, and the proof
 *    stands;
 *  - anything else — a row the model's values do not decide, or a release, so
 *    that there is no model point at all — is `not-evaluable`, never forgiven.
 */
function partialAntecedent(
  model: Model,
  input: JudgeInput,
  row: EncodedRow,
  axioms: readonly EncodedRow[],
  reached: ReadonlySet<string>,
  freed: boolean,
): Pick<SmtJudgement, 'outcome' | 'detail' | 'boundKind' | 'boundDetail'> | undefined {
  const reachedSet = contextReach(row, axioms, input.premises, reached);
  const dropped = [
    ...input.premises.filter((p) => p.encoded === undefined),
    ...axioms.filter((a) => a.encoded === undefined && refusalReaches(reachOfEncoded(a), reachedSet)),
  ];
  if (dropped.length === 0) return undefined;
  const named = dropped.map((d) => `${d.row.element.qualifiedName}: ${d.refusal?.reason ?? 'refused'}`).join('; ');
  const without =
    `the assumptions were shown satisfiable only without ${dropped.length} relation(s) of this proof's context ` +
    `that a gate refused (${named})`;
  if (freed) {
    return {
      outcome: 'not-evaluable',
      detail:
        `proof not claimed: A ∧ P ∧ ¬G is unsat, but ${without}, and with a feature released there is no model ` +
        'point to re-read them at — so whether this pass is vacuous is undecided. `--allow-inconclusive` does not ' +
        'forgive it',
      boundKind: 'none',
      boundDetail: 'the antecedent was shown satisfiable over a partial context, so nothing is claimed',
    };
  }

  const asserted = [...axioms, ...input.premises].filter((e) => e.encoded !== undefined);
  const pinned = pinnedSymbols(model, asserted);
  const valued = new Map<ElementId, boolean>();
  const hasValue = (id: ElementId): boolean => {
    let v = valued.get(id);
    if (v === undefined) {
      v = 'value' in evaluateFeatureValue(model, id);
      valued.set(id, v);
    }
    return v;
  };
  // Where the solver's point may differ from the model's: a symbol of its own,
  // or a feature the model gives a value the encoding leaves free.
  const open = [
    ...dropped,
    ...asserted.filter((e) =>
      e.row.vars.some(
        (v) => v.symbol !== undefined || (!pinned.has(v.qualifiedName) && hasValue(v.featureId)),
      ),
    ),
  ];
  const readings = new Map(input.readings.map((p) => [p.clause.id, p]));
  const read = (e: EncodedRow): ModelReading => {
    if (e.row.role === 'premise') return readings.get(e.row.element.id)?.holds ?? 'unknown';
    // A refusal that is a defect, or a value this tool does not read here, is
    // no reading at the model's values whatever the evaluator would compute.
    if (e.refusal !== undefined && !isOutsideTheFragment(e.refusal.reason)) return 'unknown';
    if (e.row.source === 'feature-value' || e.row.source === 'calculation') {
      const el = model.get(e.row.element.id);
      return el && hasStatedValue(model, el) && hasValue(el.id) ? 'holds' : 'unknown';
    }
    if (e.row.source === 'assert') {
      const c = input.checks.get(e.row.element.id)?.result;
      return c === 'satisfied' ? 'holds' : c === 'violated' ? 'fails' : 'unknown';
    }
    return 'unknown';
  };
  const readOf = open.map((e) => ({ e, reading: read(e) }));
  const contradiction = readOf.find((x) => x.e.row.role === 'axiom' && x.reading === 'fails');
  if (contradiction) {
    return {
      outcome: 'axioms-inconsistent',
      detail:
        `the axiom set is unsatisfiable at the model's own values: \`${contradiction.e.row.expression}\` is false ` +
        `there, and ${without}, so step 0 never saw it. A proof from a contradiction is void`,
      boundKind: 'none',
      boundDetail: 'no obligation was decided — the context contradicts itself at the model’s values',
    };
  }
  const empty = readOf.find((x) => x.e.row.role === 'premise' && x.reading === 'fails');
  if (empty) {
    return {
      outcome: 'vacuous',
      detail:
        `the premises are unsatisfiable under the axioms: the assumption \`${empty.e.row.expression}\` is false at ` +
        `the model's values, and ${without}, so the obligation is discharged by an antecedent that cannot hold ` +
        'and says nothing about the design',
      boundKind: 'none',
      boundDetail: 'nothing satisfies the assumptions, so there is no point the claim holds at',
    };
  }
  const unread = readOf.find((x) => x.reading !== 'holds');
  if (!unread) return undefined;
  return {
    outcome: 'not-evaluable',
    detail:
      `proof not claimed: A ∧ P ∧ ¬G is unsat, but ${without}, and \`${unread.e.row.expression}\` cannot be ` +
      "re-read at the model's values — so whether the assumptions can hold, and so whether this pass is vacuous, " +
      'is undecided. `--allow-inconclusive` does not forgive it',
    boundKind: 'none',
    boundDetail: 'the antecedent was shown satisfiable over a partial context, so nothing is claimed',
  };
}

/**
 * The symbols the encoded axioms pin to the value the model states, with
 * nothing freed: a literal value; a derived value, a calculation and an
 * asserted defining equation whose inputs are pinned; and either end of a
 * `bind` whose other end is.
 */
function pinnedSymbols(model: Model, rows: readonly EncodedRow[]): Set<string> {
  const pinned = new Set<string>();
  const symbolOfVar = (v: ContractVariable): string => v.symbol ?? v.qualifiedName;
  const defines = rows
    .filter((e) => e.row.role === 'axiom')
    .map((e) => {
      if (e.row.source === 'bind') return { e, defined: undefined as ContractVariable | undefined };
      const el = model.get(e.row.element.id);
      const target = e.row.source !== 'assert' ? e.row.element.id : el ? definedFeatureOf(model, el)?.id : undefined;
      return { e, defined: e.row.vars.find((v) => v.featureId === target) };
    });
  let grew = true;
  while (grew) {
    grew = false;
    for (const { e, defined } of defines) {
      if (e.row.source === 'bind') {
        const ends = e.row.vars.map(symbolOfVar);
        if (ends.some((x) => pinned.has(x))) {
          for (const x of ends) {
            if (pinned.has(x)) continue;
            pinned.add(x);
            grew = true;
          }
        }
        continue;
      }
      if (!defined || pinned.has(symbolOfVar(defined)) || defined.symbol !== undefined) continue;
      if (e.row.vars.every((v) => v === defined || pinned.has(symbolOfVar(v)))) {
        pinned.add(symbolOfVar(defined));
        grew = true;
      }
    }
  }
  return pinned;
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
  return sortedCore(core).join(', ');
}

/** The same sort, as the SET it is — see {@link coreSentence} for why it exists. */
function sortedCore(core: readonly string[]): readonly string[] {
  return [...core].sort();
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
  /** The witness's point: z3's model COMPLETED ({@link rereadPoint}), never only what is printed. */
  values: PointValues,
  input: JudgeInput,
  /** Did THIS proof release anything? Not the run — this obligation's context. */
  anyFreed: boolean,
): { ok: true } | { ok: false; why: string } {
  const node = row.row.node;
  if (node === null) return { ok: false, why: 'the relation has no readable body to re-evaluate' };

  // The witness is exact — z3's rationals — and so is the re-read
  // (`rereadRelation` of ../exact): the solver read the model in the decimals
  // the author wrote (`numeral` in ../smt/encode), so `3.0 [ft]` is exactly
  // `0.9144 [m]` there and 0.9144000000000001 in binary64, and the re-read
  // compares the decimals too, as the validation surface decides a tie. The
  // second gate below still has to find the relation violated.
  const reread = rereadRelation(node, row.vars, values);
  if (!('value' in reread)) {
    return {
      ok: false,
      why: reread.tie
        ? `the tool’s own evaluator cannot decide the relation at the witness: ${tieSentence(reread.tie)}`
        : 'the tool’s own evaluator could not read the relation at the witness',
    };
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
    // …AND IT HAS TO HAVE READ THE SAME FEATURES. A `violated` over a
    // different feature confirms nothing about this one: `x <= 5.0` in a P
    // whose own `x` has no value was "violated" on the numeric surface because
    // its scope gave the bare `x` to a nested part's `x = 7.0`, and the solver's
    // counterexample over P's `x` was printed refuted, exit 1, on that reading.
    const other = readElsewhere(model, row.row, input.scopes);
    if (other) {
      return {
        ok: false,
        why:
          `the numeric surface reads \`${other.path}\` as ${other.check} where this relation names ` +
          `${other.encoder}, so its \`violated\` is a reading of a different feature`,
      };
    }
  }
  return { ok: true };
}

/**
 * A name of the relation the numeric surface resolves to a DIFFERENT feature
 * from the one the encoder read, or `undefined` where the two agree (or the
 * surface resolves it through an equation, by the name alone). The surface's
 * scope is the relation's owner first, then the relation itself — the order
 * its constraint check reads them in.
 */
function readElsewhere(
  model: Model,
  row: Obligation,
  scopes: Map<ElementId, Map<string, ElementId>>,
): { path: string; encoder: string; check: string } | undefined {
  const el = model.get(row.element.id);
  if (!el) return undefined;
  const scope = (id: ElementId): Map<string, ElementId> => {
    let ids = scopes.get(id);
    if (!ids) {
      ids = featureIdsFor(model, id);
      scopes.set(id, ids);
    }
    return ids;
  };
  const names = mergeMaps(el.ownerId != null ? scope(el.ownerId) : new Map(), scope(el.id));
  for (const v of row.vars) {
    if (v.symbol !== undefined) continue;
    const id = names.get(v.path);
    if (id !== undefined && id !== v.featureId) {
      return { path: v.path, encoder: v.qualifiedName, check: model.qualifiedName(id) };
    }
  }
  return undefined;
}

/** The two SI magnitudes and the dimension, when the unit-aware evaluator has them. */
function quantities(
  model: Model,
  row: Obligation,
  memo: DerivationMemo = new Map(),
): { lhsSI?: number; rhsSI?: number; dimension?: string } {
  const el = rowElement(model, row);
  if (!el) return {};
  const q = evaluateConstraintQuantityDetailed(model, el, { memo });
  return {
    ...(q.lhsSI !== undefined ? { lhsSI: q.lhsSI } : {}),
    ...(q.rhsSI !== undefined ? { rhsSI: q.rhsSI } : {}),
    ...(q.dimension !== undefined ? { dimension: dimToString(q.dimension) } : {}),
  };
}
