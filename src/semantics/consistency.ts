/**
 * `consistency` — can all the requirements on one subject hold at once, and if
 * not, which of them collide?
 *
 * THE CHARTER OF THIS FILE, IN ONE LINE: **inconsistency is only ever reported
 * with a NAMED subset that came out of an unsat core, and "consistent" is only
 * ever reported beside the count of what was left out.** Everything below is
 * one of those two sentences made mechanical:
 *
 *  - **The values in the file do not get to answer the question.** A
 *    requirement set is inconsistent when nothing at all can satisfy it, so
 *    every feature that carries a LITERAL value is released and only the
 *    STRUCTURAL axioms — `assert constraint` bodies, `bind` equalities and the
 *    defining equations of derived features — are kept. Otherwise `mtow <= 25`
 *    and `mtow >= 30` would be answered by whatever `mtow` happens to be today,
 *    which is a question about one design point and not about the requirement
 *    set. `--with-values` re-pins them and SAYS SO on every line, because it is
 *    a different and weaker question: "do the requirements hold together *at
 *    the point this file states*".
 *  - **UNSAT is sound under a partial context; SAT is not.** A relation a gate
 *    refused is not asserted, and adding an assertion can only make a set
 *    *less* satisfiable — so an inconsistency found without it is still an
 *    inconsistency, while a satisfying point found without it may be excluded
 *    by the very relation that was dropped. That asymmetry is why the refused
 *    count travels with the word "consistent" and why the plan's MUST-NEVER
 *    list forbids printing one without the other. It is the mirror image of the
 *    rule in {@link ./engines/smt}, where a PROOF survives a partial context and
 *    a refutation does not.
 *  - **A core is a "conflicting subset" and nothing stronger.** z3's unsat core
 *    is not minimal, and calling it minimal would tell a reader that removing
 *    any one member fixes the model. Only `--minimize`, having run its deletion
 *    loop to completion, earns the word — {@link ConsistencyGroup.minimized} is
 *    the flag and {@link ConsistencyGroup.coreLabel} is the phrase, and nothing
 *    here composes that phrase twice.
 *  - **An empty question is never a green answer.** A group whose requirements
 *    state no relation this lane encodes is `inconclusive`, never "consistent":
 *    an empty conjunction is satisfiable and says nothing about a requirement
 *    set. Same rule, same reason, as `verify` refusing to exit 0 over a model
 *    that states no obligation.
 *  - **The word `realizable` appears nowhere.** This decides SATISFIABILITY of
 *    static contracts. Reactive realizability is a different question with a
 *    different answer (§6 non-goal 5), and the word is reserved by the claims
 *    guard.
 *
 * WHAT IS ASSERTED PER REQUIREMENT: `A ⇒ G`, one implication per guarantee,
 * because that is what a requirement MEANS. The shipped library says so in its
 * own words — `Requirements::RequirementCheck` is
 * `allTrue(assumptions()) implies allTrue(constraints())` — and `verify` reads
 * the same file the same way, so the two judging commands cannot disagree about
 * what a requirement is. Asserting `A ∧ G` instead would force one design point
 * to satisfy every antecedent at once, and mode- and phase-conditional
 * requirements — `assume { mode == cruise }` against `assume { mode == ferry }`
 * — would come back as a contradiction. They are not one: their antecedents are
 * mutually exclusive, so no single point is ever required to meet both
 * guarantees. That false alarm fires on the most ordinary pattern in systems
 * engineering, which is why the conjunction reading is not available here and
 * why {@link READING} is printed on every verdict line: "consistent" under an
 * implication reading and under a conjunction reading are different claims.
 *
 * WHAT THE IMPLICATION READING COSTS, and how that is paid rather than hidden.
 * `⋀ (Aᵢ ⇒ Gᵢ)` is satisfiable by making every antecedent false, so on its own
 * it would call a requirement set consistent precisely when nobody can exercise
 * it — the vacuity trap, arriving one level up. So a requirement that carries
 * assumptions is asked a SECOND question ({@link ConsistencyGroup.unengageable}):
 * can this requirement be ENGAGED at a point that satisfies the whole set —
 * `⋀ (Aⱼ ⇒ Gⱼ) ∧ Aᵢ`? A requirement whose answer is no applies at no point the
 * set admits, and a set that holds only because one of its requirements never
 * applies is NOT reported consistent: the group is `inconclusive` under
 * `verification/vacuous` — the same code `verify` files for an obligation
 * discharged by an antecedent nothing satisfies, and §2's rule for this lane
 * that vacuity is inconclusive always and no flag launders it. The witness is
 * still published, because the set IS satisfiable; what is undecided is whether
 * the requirements mean anything at that point.
 *
 * Mutually exclusive modes PASS this check — each is engaged at its own point,
 * which is the whole discrimination the implication reading buys — while two
 * requirements under the SAME assumption whose guarantees collide fail it, so
 * the conflicts the conjunction reading was kept for are still found.
 *
 * The backend is passed IN, exactly as {@link ./engines/smt} takes it: whether a
 * solver exists is decided once, in `src/api/verification.ts`, and an absent
 * solver is `verification/tool-absent` rather than a fallback to anything.
 */

import { type ElementId, type Model } from '@core/index';
import { conforms } from './conformance';
import {
  contractsOf,
  type Contract,
  type Fragment,
  type Refusal,
  type RefusalReason,
} from './contracts';
import { evaluate } from './expr';
import { obligationsOf, type Obligation } from './obligations';
import {
  encodeRelation,
  encodeScript,
  encodeVariables,
  type EncodeVariable,
  type EncodedRelation,
  type ScriptAssertion,
} from './smt/encode';
import { type CheckOutcome, type WitnessValue, type Z3Backend } from './smt/z3-bridge';

/**
 * The largest core `--minimize` will attempt to reduce, by default.
 *
 * Minimisation costs one check per core member (§6), and a core is not bounded
 * by anything but the model. The bound is a BUDGET rather than a truncation:
 * the core itself is always reported in full — a core printed short is a core
 * that names the wrong set — and what the bound stops is the deletion loop. A
 * core bigger than this comes back with `minimized: false` and the sentence
 * says the budget was the reason, so a reader is never left to wonder whether
 * "conflicting subset" means "we did not try" or "we tried and it is not
 * minimal".
 */
export const DEFAULT_MAX_CORE = 8;

/**
 * The reading every verdict line carries, composed HERE and nowhere else.
 *
 * "Consistent" under the implication reading and under a conjunction reading
 * are different claims about a model, so the claim says which one it is rather
 * than leaving a reader to assume the other. See the module header.
 */
export const READING = 'each requirement read as `assume ⇒ require`';

/** How a consistency run is narrowed, bounded and told what to pin. */
export interface ConsistencyOptions {
  /** The solver. Absence is decided by the caller, never here. */
  backend: Z3Backend;
  /**
   * Only the subject types that conform to this element.
   *
   * A REF naming a supertype answers for its subtypes, because that is what
   * `conforms` means and what a reader typing a definition name expects.
   */
  subjectId?: ElementId;
  /** Re-pin the literal feature values as axioms. A different, weaker question. */
  withValues?: boolean;
  /** Run the deletion loop over the core, and earn the word "minimal". */
  minimize?: boolean;
  /** The deletion loop's budget — see {@link DEFAULT_MAX_CORE}. */
  maxCore?: number;
  /** The per-check budget in ms. Every check in this lane is bounded. */
  timeoutMs?: number;
}

/** The subject a group of requirements is about. */
export interface ConsistencySubject {
  /** The name a contract writes after `subject`, for the reader. */
  name: string;
  /** The type as written (`AirVehicle`), or `null`. */
  typeRef: string | null;
  /** The type's element id — the group key, since two packages may share a name. */
  typeId: ElementId | null;
  /** The type's qualified name, when it resolves to an element. */
  typeQualifiedName: string | null;
}

/** One relation nothing asserted, with the gate that refused it. */
export interface RefusedRelation {
  id: ElementId;
  qualifiedName: string;
  expression: string;
  reason: RefusalReason;
  detail: string;
  /** The requirement it belongs to, or `null` for a model-level axiom. */
  requirement: string | null;
}

/** One requirement as this command counted it. */
export interface ConsistencyRequirement {
  id: ElementId;
  qualifiedName: string;
  /** The `<R-UAV-001>` short name, or `''` — the reader's name for it. */
  shortId: string;
  declaredName?: string;
  /** How many of its relations were asserted, and how many a gate refused. */
  asserted: number;
  refused: number;
}

/**
 * What one core member IS.
 *
 * `guarantee` rather than `requirement`, because that is the precision the
 * implication reading buys: what enters the script under a tracking literal is
 * a requirement's GUARANTEE, asserted under that requirement's assumptions. An
 * `assume` clause is never asserted on its own and can therefore never be a
 * conflicting subset's member by itself — it travels with the guarantee it
 * conditions, in {@link CoreMember.assumptions}, so a reader can see the whole
 * implication that collided rather than half of it.
 */
export type CoreMemberKind = 'guarantee' | 'axiom';

/** One member of a conflicting subset, named the two ways the plan requires. */
export interface CoreMember {
  /** The `:named` label z3 handed back — kept so a reader can find it in the script. */
  label: string;
  /** The element the relation IS: a clause, a feature value or a binding edge. */
  id: ElementId;
  qualifiedName: string;
  expression: string;
  /** A `require` clause under its assumptions, or a fact the model states. */
  kind: CoreMemberKind;
  /**
   * The `assume` clauses the guarantee was asserted under, as written.
   *
   * Empty for an unconditional requirement and for an axiom. A conditional
   * requirement in a core conflicts ONLY where its antecedent holds, and a
   * subset printed without that is a subset a reader would try to fix in the
   * wrong clause.
   */
  assumptions: string[];
  /** The requirement the clause belongs to, when it is one. */
  requirement: { id: ElementId; qualifiedName: string; shortId: string } | null;
}

/**
 * A requirement this set admits no point for — satisfiable, and never engaged.
 *
 * See the module header: it is what the implication reading costs, paid by an
 * extra check per conditional requirement rather than left for a reader to
 * discover.
 */
export interface UnengageableRequirement {
  id: ElementId;
  qualifiedName: string;
  shortId: string;
  /** The `assume` clauses that cannot hold here, as written. */
  assumptions: string[];
}

/** What this command concluded about one requirement set. */
export type ConsistencyOutcome = 'consistent' | 'inconsistent' | 'inconclusive';

/** One subject's requirement set, and what came of it. */
export interface ConsistencyGroup {
  subject: ConsistencySubject | null;
  requirements: ConsistencyRequirement[];
  outcome: ConsistencyOutcome;
  /** The `verification/*` code, for a group that is not `consistent`. */
  code: string | null;
  /** The sentence a person reads. It always carries the refused count and the mode. */
  detail: string;
  /** The conflicting subset, for `inconsistent` and empty otherwise. */
  core: CoreMember[];
  /** Did `--minimize` run its deletion loop to completion over this core? */
  minimized: boolean;
  /**
   * The phrase the core may be printed under.
   *
   * Composed HERE and nowhere else, so "minimal" cannot be reached by a
   * renderer that forgot to read {@link minimized}.
   */
  coreLabel: string;
  /**
   * Requirements of this set that apply at no point the set admits.
   *
   * Only ever non-empty beside `consistent`: it is the second question the
   * implication reading obliges, and it is asked only when there is a set to
   * ask it of.
   */
  unengageable: UnengageableRequirement[];
  /** The design point the solver found, for `consistent` and empty otherwise. */
  witness: WitnessValue[];
  /** Was every asserted requirement relation re-read as true at that point? */
  witnessConfirmed: boolean;
  /** Relations of this group's requirements that nothing asserted. */
  refused: RefusedRelation[];
  /**
   * Requirements that carry prose and no relation at all.
   *
   * Counted apart from {@link refused}, because no gate refused them: the file
   * simply does not say, formally, what they require. Folding the two together
   * would report a model with prose requirements as one whose relations this
   * tool turned down.
   */
  noFormalClause: number;
  /** The plan's two-word fragment vocabulary, free-relative. */
  fragment: Fragment;
  /** The `set-logic` the script actually declared. `''` when none ran. */
  logic: string;
  /** How many solver checks this group cost, including its share of the axiom check. */
  checks: number;
}

/** What one run came to. */
export interface ConsistencyResult {
  groups: ConsistencyGroup[];
  /** Was the question asked at the model's own values? */
  withValues: boolean;
  /** Was the deletion loop asked for? */
  minimize: boolean;
  /** The deletion loop's budget, in core members. */
  maxCore: number;
  /**
   * The feature values released because they are literals — by qualified name,
   * sorted. Empty under `--with-values`, and that is the whole difference
   * between the two modes stated as data rather than as prose.
   */
  released: string[];
  /**
   * Every relation nothing asserted, over the whole run — each listed ONCE.
   *
   * Deduplicated by element id, because a contract on a supertype is a member
   * of every subtype's group: a run-level list built by concatenating the
   * groups would report one refused relation as two the moment a model has a
   * type hierarchy, and this is the figure the plan's MUST-NEVER rule makes
   * travel beside the word "consistent".
   */
  refused: RefusedRelation[];
  /** Every requirement no point of its own set engages, over the whole run. */
  unengageable: UnengageableRequirement[];
  /** How many requirements were considered at all. */
  requirements: number;
  /**
   * How many DISTINCT requirements carry prose and no relation at all.
   *
   * Counted here rather than summed over the groups, because a contract on a
   * supertype belongs to every subtype's group: summing would report one prose
   * requirement as two the moment a model has a type hierarchy, and the figure
   * travels beside the refused count on every verdict a reader acts on.
   */
  noFormalClause: number;
  /** `check(A)` over the structural axioms, once per run. */
  axiomsConsistent: boolean;
  /** The unsat core of the axiom check, when there was one. */
  axiomCore: CoreMember[];
  /** Total solver checks. */
  checks: number;
  /** The per-check budget every check above ran under. */
  timeoutMs: number | undefined;
}

/* ─────────────────────────── the encoded worklist ────────────────────────── */

/** One worklist row, encoded under its own scale and the run's free set. */
interface EncodedRow {
  row: Obligation;
  /** `undefined` when the row could not be encoded — the reason is beside it. */
  encoded?: EncodedRelation;
  /** The variables as THIS relation reads them. */
  vars: EncodeVariable[];
  refusal?: Refusal;
}

/**
 * Encode one row's body under its OWN scale decision and the caller's free set.
 *
 * The same three lines `judgeBySmt` runs, for the same reason: a relation the
 * gates left in raw magnitudes (`range = 5.0 [km]` against a bare `<= 10.0`) is
 * read in kilometres by every surface of this tool, and an encoder that scaled
 * it because it COULD would report `5000 <= 10`. `row.scaled` is the gates' own
 * answer and it is what is passed; nothing here re-derives it.
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

/**
 * One assertion and everything that must travel with it.
 *
 * A UNIT, not an assertion, because the deletion loop removes relations and a
 * relation may carry `≠ 0` side conditions the encoder added for it. Dropping
 * the relation and keeping its guard would leave a script asserting something
 * about a divisor that is no longer divided by, and dropping the guard alone
 * would change the meaning of a relation nobody asked to remove.
 */
interface Unit {
  row: EncodedRow;
  kind: CoreMemberKind;
  /** The requirement the row belongs to, for a clause under a tracking literal. */
  contract: Contract | null;
  /**
   * The encoded `assume` clauses this guarantee is asserted under.
   *
   * Empty for an axiom and for an unconditional requirement. They are part of
   * the UNIT rather than units of their own because the implication is what is
   * asserted: an antecedent removed from the script while its consequent stays
   * would turn a conditional requirement into an unconditional one, which is
   * the strictly stronger claim and not the one the file makes.
   */
  premises: EncodedRow[];
  assertions: ScriptAssertion[];
}

/** The label a row's assertion carries — a qualified name, never an element id. */
function nameOf(row: Obligation): string {
  return row.element.qualifiedName || row.expression;
}

/**
 * One relation as a unit: the tracking literal, plus the guards it obliged.
 *
 * The `kind` on the assertion is what the LABEL says, and the label is what
 * comes back in an unsat core — so a reader who sees `goal:P::R::«…»` in a core
 * knows it was a requirement clause and `axiom:P::part::mass` knows it was a
 * fact the model states.
 *
 * A GUARANTEE IS ASSERTED AS AN IMPLICATION, under its requirement's `assume`
 * clauses (module header). One assertion, not several, so the tracking literal
 * tracks the whole implication and an unsat core names the requirement that
 * carried it rather than an antecedent nobody asserted. The side conditions
 * the encoder added — a `≠ 0` under a division — go on the side of the
 * implication their relation stands on: an antecedent's guard conditions the
 * implication (a requirement whose assumption cannot even be read does not
 * apply), and a consequent's guard is part of what the requirement demands.
 */
function unitOf(
  row: EncodedRow,
  kind: Unit['kind'],
  contract: Contract | null,
  premises: readonly EncodedRow[] = [],
): Unit {
  const encoded = row.encoded;
  const kept = premises.filter((p) => p.encoded !== undefined);
  if (!encoded) return { row, kind, contract, premises: [...kept], assertions: [] };
  const label = nameOf(row.row);
  if (kind === 'axiom') {
    // A fact the model states, with its guards beside it: there is no
    // antecedent to hang them under, and the model asserts both outright.
    return {
      row,
      kind,
      contract,
      premises: [],
      assertions: [
        { kind: 'axiom', name: label, term: encoded.term },
        ...encoded.sideConditions.map((s) => ({ kind: 'side' as const, name: label, term: s.term })),
      ],
    };
  }
  const consequent = conjunction([encoded.term, ...encoded.sideConditions.map((s) => s.term)])!;
  const antecedent = conjunction(
    kept.flatMap((p) => [p.encoded!.term, ...p.encoded!.sideConditions.map((s) => s.term)]),
  );
  return {
    row,
    kind,
    contract,
    premises: [...kept],
    assertions: [
      {
        kind: 'goal',
        name: label,
        term: antecedent === null ? consequent : `(=> ${antecedent} ${consequent})`,
      },
    ],
  };
}

/** `(and …)` over the terms that are actually there, or `null` for none. */
function conjunction(terms: readonly string[]): string | null {
  if (terms.length === 0) return null;
  if (terms.length === 1) return terms[0];
  return `(and ${terms.join(' ')})`;
}

/** The rows one unit's assertion is built from: its own, and its antecedent's. */
function rowsOf(unit: Unit): EncodedRow[] {
  return [unit.row, ...unit.premises];
}

/** Every symbol one unit's assertion reads, its antecedent's included. */
function readsOf(unit: Unit): string[] {
  return rowsOf(unit).flatMap((r) => r.encoded?.reads ?? []);
}

/** Every variable these units may read, deduplicated by qualified name. */
function variablesOf(units: readonly Unit[]): EncodeVariable[] {
  const out: EncodeVariable[] = [];
  const seen = new Set<string>();
  for (const u of units) {
    // The antecedent's variables are declared too, or a script would assert an
    // implication over a symbol it never declared.
    for (const v of rowsOf(u).flatMap((r) => r.vars)) {
      if (seen.has(v.qualifiedName)) continue;
      seen.add(v.qualifiedName);
      out.push(v);
    }
  }
  return out;
}

/** One script over a set of units, with the labels it gave each assertion. */
function scriptOf(units: readonly Unit[]): {
  text: string;
  logic: string;
  fragment: Fragment;
  /** label → the unit that produced the assertion carrying it. */
  owners: Map<string, Unit>;
  symbols: string[];
} {
  const assertions: ScriptAssertion[] = [];
  const from: Unit[] = [];
  for (const u of units) {
    for (const a of u.assertions) {
      assertions.push(a);
      from.push(u);
    }
  }
  const variables = variablesOf(units);
  const script = encodeScript({
    variables,
    assertions,
    nonlinear: units.some((u) => rowsOf(u).some((r) => r.encoded?.nonlinear === true)),
    syntacticNonlinear: units.some((u) =>
      rowsOf(u).some((r) => r.encoded?.syntacticNonlinear === true),
    ),
  });
  // `encodeScript` returns its labels in ASSERTION order and makes them unique
  // itself, so the mapping back from a core is an index lookup rather than a
  // second implementation of its uniquifying rule. A second implementation is
  // exactly how a core would end up attributed to the wrong requirement.
  const owners = new Map<string, Unit>();
  script.labels.forEach((label, i) => {
    const owner = from[i];
    if (owner) owners.set(label, owner);
  });
  return {
    text: script.text,
    logic: script.logic,
    fragment: script.fragment,
    owners,
    symbols: script.symbols,
  };
}

/* ────────────────────────────── the run ─────────────────────────────────── */

/**
 * Is this axiom the binding of a feature the file states as a LITERAL?
 *
 * The default mode releases exactly these, and nothing else: a derived
 * feature's defining equation (`endurance = capacity * f / power`) is
 * STRUCTURE — it says how the model computes a quantity, not what value it
 * happens to take — and releasing it would let the solver satisfy a requirement
 * set by pretending the design has no equations in it. A `bind` edge and an
 * `assert constraint` are structure for the same reason.
 *
 * THE TEST IS SEMANTIC, NOT A TEST OF THE STORAGE FORM, and that distinction is
 * the whole correctness of the default mode. The mapper keeps a bare numeral as
 * a number and every other value expression as verbatim source text, so
 * `= 30.0`, `= - 30.0`, `= -(30.0)` and `= 2.0 * 5.0` arrive here in three
 * different shapes stating four values. A test that asked whether the text
 * parses as a numeral would release the first two and PIN the last two, and a
 * requirement set answered at a pinned value is the other question entirely —
 * `{k >= 20, k <= 100}` over `k = 2.0 * 5.0` would come back as
 * `inconsistent`, an error and exit 1, over a set any design satisfies, while
 * the same file with `k = 10.0` came back consistent. Two spellings of one
 * number must not give opposite verdicts.
 *
 * So a feature value is a STATED VALUE when its expression is CLOSED — it reads
 * no feature but the one it defines — and STRUCTURE when it is open. That is
 * exactly the distinction the release is about: `endurance = capacity * f /
 * power` says how the model COMPUTES a quantity and releasing it would let the
 * solver satisfy a requirement set by pretending the design has no equations in
 * it, while `k = 2.0 * 5.0` says what `k` is and nothing else. `row.vars` is
 * the gathered read set of the row's own body, so the question is asked of the
 * relation this lane actually asserts rather than of the bytes it came from.
 *
 * EXPORTED because `bounds --free all` releases exactly this set: "release
 * every value the file STATES, and keep every equation that says how the model
 * COMPUTES a quantity" is one rule, and two implementations of it would let one
 * command bound a measure over a design space the other one called
 * inconsistent.
 */
export function isLiteralValueAxiom(model: Model, row: Obligation): boolean {
  if (row.role !== 'axiom' || row.source !== 'feature-value') return false;
  const raw = model.get(row.element.id)?.attrs.value;
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'number' || typeof raw === 'boolean') return true;
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  return row.vars.every((v) => v.qualifiedName === row.element.qualifiedName);
}

/**
 * The axioms this requirement set can reach, by shared symbols.
 *
 * The same closure `judgeBySmt` computes, and sound for the same reason:
 * assertions that share no variable with the set, directly or transitively,
 * factorise, so a satisfying assignment for one can always be pasted onto a
 * satisfying assignment for the other. Dropping them changes neither
 * satisfiability nor unsatisfiability — and keeping them would put the whole
 * model's facts into every core and every witness, so a reader asking about the
 * mass requirement would be handed the data link's frequency.
 *
 * A refused axiom has no symbols to connect through and is not carried at all:
 * it is reported under `refused`, where a reader can see it, and it cannot
 * enter a core because nothing asserted it.
 */
function reachableAxioms(axioms: readonly Unit[], seeds: readonly Unit[]): Unit[] {
  const reached = new Set<string>();
  for (const s of seeds) for (const r of readsOf(s)) reached.add(r);
  const kept: Unit[] = [];
  const taken = new Set<Unit>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of axioms) {
      if (taken.has(a)) continue;
      const reads = readsOf(a);
      if (!reads.some((r) => reached.has(r))) continue;
      taken.add(a);
      kept.push(a);
      for (const r of reads) reached.add(r);
      grew = true;
    }
  }
  return kept;
}

/** A refused row, in the shape the report lists it under. */
function refusalOf(row: EncodedRow, requirement: string | null): RefusedRelation {
  return {
    id: row.row.element.id,
    qualifiedName: row.row.element.qualifiedName,
    expression: row.row.expression,
    reason: row.refusal?.reason ?? 'unparseable',
    detail: row.refusal?.detail ?? 'the relation was not encoded',
    requirement,
  };
}

/**
 * Decide whether every requirement on each subject can hold at once.
 *
 * Asynchronous only because the solver is. Everything else is a pure function
 * of the model and the options.
 */
/** Everything a run needs before a solver is involved, and after the release. */
interface Prepared {
  /** The feature values released because they are literals, sorted. */
  released: string[];
  /** The structural axioms, encoded. */
  axiomUnits: Unit[];
  /** Structural axioms nothing could encode. */
  axiomsRefused: RefusedRelation[];
  /** Each requirement's own relations, by requirement id. */
  clausesOf: Map<ElementId, EncodedRow[]>;
  contracts: Contract[];
}

/**
 * The pure half of a run: release, encode, and file each relation on the side
 * of the question it stands on.
 *
 * Separated from the deciding half because BOTH halves are needed even when
 * there is no solver. A tool-absent run still has to say how many requirements
 * it did not decide and on which subjects — "0 requirement(s) on 0 subject(s)"
 * over a file full of requirements is a census of nothing dressed as a census
 * of the model, and it is exactly how an absent solver would read as an empty
 * model.
 */
function prepare(model: Model, withValues: boolean): Prepared {
  const rows = obligationsOf(model);

  // THE RELEASE. Everything that carries a literal value goes, unless the
  // caller asked for the other question — see {@link isLiteralValueAxiom}.
  const literalRows = rows.filter((r) => isLiteralValueAxiom(model, r));
  const released = withValues
    ? []
    : [...new Set(literalRows.map((r) => r.element.qualifiedName))].sort();
  const free = new Set(released);
  const releasedIds = new Set(withValues ? [] : literalRows.map((r) => r.element.id));

  const encoded = new Map<ElementId, EncodedRow>();
  for (const row of rows) encoded.set(row.element.id, encodeRow(row, free));

  // The structural axioms: every axiom row that survived the release.
  const axiomUnits: Unit[] = [];
  const axiomsRefused: RefusedRelation[] = [];
  for (const row of rows) {
    if (row.role !== 'axiom') continue;
    if (releasedIds.has(row.element.id)) continue;
    const e = encoded.get(row.element.id);
    if (!e) continue;
    if (!e.encoded) {
      axiomsRefused.push(refusalOf(e, null));
      continue;
    }
    axiomUnits.push(unitOf(e, 'axiom', null));
  }

  // The requirement clauses, indexed by the requirement they belong to. A row
  // whose role is `axiom` is context even when it sits inside a requirement
  // body (`assert constraint`), so it is not here: the tracking literals are
  // for what the requirement ASKS, not for what it takes as given.
  const clausesOf = new Map<ElementId, EncodedRow[]>();
  for (const row of rows) {
    const id = row.requirement?.id;
    if (id === undefined || row.role === 'axiom') continue;
    // The synthetic `no-formal-clause` row is not a relation and no gate
    // refused it: it is a requirement with prose and no body, counted on its
    // own further down rather than listed as something a gate turned down.
    if (row.source === 'none') continue;
    const e = encoded.get(row.element.id);
    if (!e) continue;
    const list = clausesOf.get(id);
    if (list) list.push(e);
    else clausesOf.set(id, [e]);
  }

  return { released, axiomUnits, axiomsRefused, clausesOf, contracts: contractsOf(model) };
}

/**
 * The census of one requirement set, taken before any solver is asked.
 *
 * Shared by the deciding path and the tool-absent one, so the two cannot
 * disagree about how many requirements a subject has or which of their
 * relations a gate refused.
 */
function censusOf(
  contracts: readonly Contract[],
  clausesOf: ReadonlyMap<ElementId, EncodedRow[]>,
): {
  units: Unit[];
  refused: RefusedRelation[];
  requirements: ConsistencyRequirement[];
  noFormalClause: number;
  /** Every contract that carries an asserted antecedent, and what it is. */
  conditional: Array<{ contract: Contract; premises: EncodedRow[] }>;
} {
  const units: Unit[] = [];
  const refused: RefusedRelation[] = [];
  const requirements: ConsistencyRequirement[] = [];
  const conditional: Array<{ contract: Contract; premises: EncodedRow[] }> = [];
  let noFormalClause = 0;
  for (const contract of contracts) {
    const clauses = clausesOf.get(contract.id) ?? [];
    const premises = clauses.filter((c) => c.row.role === 'premise');
    const goals = clauses.filter((c) => c.row.role !== 'premise');
    // AN ANTECEDENT NOBODY ENCODED IS NOT AN ANTECEDENT THAT IS TRUE. Dropping
    // it from the implication would leave `G` asserted where the file states
    // `A ⇒ G` — strictly the stronger claim — and a requirement set can be
    // called inconsistent on the strength of a demand the model never made.
    // The whole requirement stands down instead: every relation of it is
    // listed under `refused`, where the count travels with the verdict, and
    // dropping conjuncts is the direction UNSAT survives.
    const brokenPremise = premises.find((p) => !p.encoded);
    let asserted = 0;
    let turnedDown = 0;
    for (const clause of clauses) {
      if (clause.encoded && brokenPremise === undefined) {
        asserted += 1;
      } else if (clause.encoded && brokenPremise !== undefined) {
        const why = brokenPremise.refusal?.reason ?? 'unparseable';
        refused.push({
          ...refusalOf(clause, contract.qualifiedName),
          reason: why,
          detail:
            `nothing asserted it: the \`assume\` clause it stands under ` +
            `(\`${brokenPremise.row.expression}\`) was refused (${why}), and a guarantee asserted ` +
            `without the assumption it is conditioned on is a stronger claim than the model makes`,
        });
        turnedDown += 1;
      } else {
        refused.push(refusalOf(clause, contract.qualifiedName));
        turnedDown += 1;
      }
    }
    if (brokenPremise === undefined) {
      for (const goal of goals) {
        if (goal.encoded) units.push(unitOf(goal, 'guarantee', contract, premises));
      }
      const encodedPremises = premises.filter((p) => p.encoded !== undefined);
      if (encodedPremises.length > 0 && goals.some((g) => g.encoded !== undefined)) {
        conditional.push({ contract, premises: encodedPremises });
      }
    }
    if (asserted + turnedDown === 0) noFormalClause += 1;
    requirements.push({
      id: contract.id,
      qualifiedName: contract.qualifiedName,
      shortId: contract.shortId,
      ...(contract.declaredName !== undefined ? { declaredName: contract.declaredName } : {}),
      asserted,
      refused: turnedDown,
    });
  }
  return { units, refused, requirements, noFormalClause, conditional };
}

/**
 * The census a run with NO SOLVER can still take, with every set undecided.
 *
 * The same shape `checkConsistency` returns, so the report above it does not
 * branch: every group is `inconclusive` under the code the caller names, the
 * requirement and refusal counts are real, and nothing was decided — which is
 * exit 2 by {@link ConsistencyResult} carrying no `consistent` group at all.
 */
export function consistencyCensus(
  model: Model,
  opts: { subjectId?: ElementId; withValues?: boolean; minimize?: boolean; maxCore?: number },
  undecided: { code: string; detail: string },
): ConsistencyResult {
  const withValues = opts.withValues === true;
  const prepared = prepare(model, withValues);
  const groups = groupBySubject(model, prepared.contracts, opts.subjectId);
  const out: ConsistencyGroup[] = [];
  for (const group of groups) {
    const census = censusOf(group.contracts, prepared.clausesOf);
    out.push({
      subject: group.subject,
      requirements: census.requirements,
      outcome: 'inconclusive',
      code: undecided.code,
      detail: `${undecided.detail}. ${refusedSentence(census.refused)}`,
      core: [],
      minimized: false,
      coreLabel: coreLabelOf(false),
      unengageable: [],
      witness: [],
      witnessConfirmed: false,
      refused: census.refused,
      noFormalClause: census.noFormalClause,
      fragment: 'qf-lra',
      logic: '',
      checks: 0,
    });
  }
  return {
    groups: out,
    withValues,
    minimize: opts.minimize === true,
    maxCore: opts.maxCore ?? DEFAULT_MAX_CORE,
    released: prepared.released,
    refused: distinctRefusals([...prepared.axiomsRefused, ...out.flatMap((g) => g.refused)]),
    unengageable: [],
    requirements: new Set(out.flatMap((g) => g.requirements.map((r) => r.id))).size,
    noFormalClause: distinctProseOnly(out),
    axiomsConsistent: true,
    axiomCore: [],
    checks: 0,
    timeoutMs: undefined,
  };
}

/**
 * The refused relations of a whole run, each listed ONCE.
 *
 * A contract about a supertype is a member of every subtype's group, so a list
 * built by concatenating the groups counts its refusals once per group it
 * appears in. `requirements` above has always been deduplicated; these two
 * figures are read beside it, and three figures over the same model that
 * disagree about how big it is are worse than any one of them being wrong.
 */
function distinctRefusals(refused: readonly RefusedRelation[]): RefusedRelation[] {
  const seen = new Set<ElementId>();
  const out: RefusedRelation[] = [];
  for (const r of refused) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/** How many DISTINCT requirements carry prose and no relation, over a run. */
function distinctProseOnly(groups: readonly ConsistencyGroup[]): number {
  const prose = new Set<ElementId>();
  for (const g of groups) {
    for (const r of g.requirements) if (r.asserted + r.refused === 0) prose.add(r.id);
  }
  return prose.size;
}

export async function checkConsistency(
  model: Model,
  opts: ConsistencyOptions,
): Promise<ConsistencyResult> {
  const withValues = opts.withValues === true;
  const minimize = opts.minimize === true;
  const maxCore = opts.maxCore ?? DEFAULT_MAX_CORE;
  const timeoutMs = opts.timeoutMs;
  const { released, axiomUnits, axiomsRefused, clausesOf, contracts } = prepare(model, withValues);
  const groups = groupBySubject(model, contracts, opts.subjectId);

  // STEP 0, once per run: is the model's own axiom set satisfiable at all? A
  // requirement set called inconsistent over a context that contradicts itself
  // would put the blame on the requirements, and the fault is in the facts.
  let checks = 0;
  let axiomsConsistent = true;
  let axiomCore: CoreMember[] = [];
  let axiomOutcome: CheckOutcome | null = null;
  if (axiomUnits.length > 0) {
    const script = scriptOf(axiomUnits);
    axiomOutcome = await opts.backend.check(script.text, { timeoutMs });
    checks += 1;
    axiomsConsistent = axiomOutcome.status === 'sat';
    if (axiomOutcome.status === 'unsat') {
      axiomCore = coreMembersOf(axiomOutcome.core, script.owners);
    }
  }

  const out: ConsistencyGroup[] = [];
  for (const group of groups) {
    const judged = await judgeGroup({
      subject: group.subject,
      contracts: group.contracts,
      clausesOf,
      axiomUnits,
      axiomsRefused,
      axiomOutcome,
      axiomCore,
      backend: opts.backend,
      timeoutMs,
      withValues,
      minimize,
      maxCore,
    });
    checks += judged.checks;
    out.push(judged);
  }

  const refused = [...axiomsRefused];
  for (const g of out) refused.push(...g.refused);
  const unengageable: UnengageableRequirement[] = [];
  const engagedSeen = new Set<ElementId>();
  for (const g of out) {
    for (const u of g.unengageable) {
      if (engagedSeen.has(u.id)) continue;
      engagedSeen.add(u.id);
      unengageable.push(u);
    }
  }

  return {
    groups: out,
    withValues,
    minimize,
    maxCore,
    released,
    refused: distinctRefusals(refused),
    unengageable,
    requirements: new Set(out.flatMap((g) => g.requirements.map((r) => r.id))).size,
    noFormalClause: distinctProseOnly(out),
    axiomsConsistent,
    axiomCore,
    checks,
    timeoutMs,
  };
}

/* ─────────────────────────────── grouping ────────────────────────────────── */

/** One subject's contracts, before anything is asked of a solver. */
interface SubjectGroup {
  subject: ConsistencySubject | null;
  contracts: Contract[];
}

/**
 * Group the contracts by subject type, through `conforms`.
 *
 * The key is the subject TYPE — a contract about an `AirVehicle` and one about
 * a `Vehicle` are both about any air vehicle, so the air-vehicle group holds
 * both. That is what `conforms` means and it is the only grouping under which
 * the question has an answer a reader can act on: a requirement set is
 * inconsistent for a SUBJECT, and every requirement that reaches that subject
 * is part of it. The reverse direction is deliberately not taken — a `Vehicle`
 * group does not inherit an `AirVehicle` requirement, because a vehicle that is
 * not an air vehicle never has to meet it.
 *
 * Contracts with no subject at all form one group of their own, reported with a
 * `null` subject rather than dropped: a requirement with no subject is still a
 * requirement, and silently omitting it would let a file be called consistent
 * because the part nobody could group was never asked about.
 *
 * `--subject` NARROWS BY WHAT THE READER TYPED, not by what some contract
 * happened to name. Two spellings a reader reaches for first would otherwise
 * select nothing at all: the part usage the file writes after `subject` (which
 * every surface of this report prints beside the type), and a subtype no
 * contract names directly — the very case the promise "a type answers for its
 * subtypes" is about. A usage is narrowed through its declared type, and the
 * named type forms a group of its own even when no contract is written about
 * it, holding the requirements its supertypes state. Selecting nothing is left
 * as an EMPTY result for the caller to refuse by name: a run that quietly
 * reports the model states no requirement set, when what happened is that a
 * subject selected none of them, is a false statement about the file.
 */
function groupBySubject(
  model: Model,
  contracts: readonly Contract[],
  subjectId: ElementId | undefined,
): SubjectGroup[] {
  const narrow = subjectId === undefined ? undefined : subjectTypeOf(model, subjectId);
  const typed = contracts.filter((c) => c.subject?.typeId != null);
  const untyped = contracts.filter((c) => c.subject?.typeId == null);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const c of typed) {
    const id = c.subject!.typeId!;
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push(id);
  }
  if (narrow !== undefined && !seen.has(narrow)) keys.push(narrow);
  const out: SubjectGroup[] = [];
  for (const typeId of keys) {
    if (narrow !== undefined && !conforms(model, typeId, narrow)) continue;
    const members = typed.filter((c) => conforms(model, typeId, c.subject!.typeId!));
    if (members.length === 0) continue;
    const first = members.find((c) => c.subject!.typeId === typeId);
    const named = model.get(typeId);
    out.push({
      subject: {
        // The type the reader named answers under its own name when no
        // contract writes a subject for it.
        name: first?.subject!.name ?? named?.declaredName ?? '',
        typeRef: first?.subject!.typeRef ?? named?.declaredName ?? null,
        typeId,
        typeQualifiedName: model.qualifiedName(typeId) || null,
      },
      contracts: members,
    });
  }
  // The subjectless group is answered only when nothing narrowed the run: a
  // reader who named a subject asked about that subject.
  if (untyped.length > 0 && subjectId === undefined) {
    out.push({ subject: null, contracts: untyped });
  }
  return out;
}

/**
 * The TYPE a `--subject` REF narrows to: the element itself, or what it is
 * typed by.
 *
 * `subject uav : AirVehicle` puts `uav` in front of a reader on every row of
 * this report, so `--subject uav` is the spelling they reach for — and it is a
 * usage, not a type, so a conformance test against it matches nothing. Reading
 * through the usage's declared type is what makes the flag mean what it looks
 * like it means. A REF that is already a type is returned unchanged.
 */
function subjectTypeOf(model: Model, subjectId: ElementId): ElementId {
  const el = model.get(subjectId);
  if (!el) return subjectId;
  if (/Definition$/.test(el.eClass)) return subjectId;
  const typed = model.typesOf(subjectId)[0];
  return typed?.id ?? subjectId;
}

/* ──────────────────────────── one requirement set ────────────────────────── */

interface JudgeInput {
  subject: ConsistencySubject | null;
  contracts: readonly Contract[];
  clausesOf: ReadonlyMap<ElementId, EncodedRow[]>;
  axiomUnits: readonly Unit[];
  axiomsRefused: readonly RefusedRelation[];
  axiomOutcome: CheckOutcome | null;
  axiomCore: readonly CoreMember[];
  backend: Z3Backend;
  timeoutMs: number | undefined;
  withValues: boolean;
  minimize: boolean;
  maxCore: number;
}

/**
 * The words every sentence in this command ends with: the mode, and the
 * reading.
 *
 * The two travel together because a verdict needs both to mean anything —
 * which values answered, and what a requirement was taken to say.
 */
function mode(withValues: boolean): string {
  return (
    (withValues
      ? 'at the model’s own values (`--with-values`)'
      : 'with every literal feature value released') + `, ${READING}`
  );
}

/** The refused count, which the plan forbids printing "consistent" without. */
function refusedSentence(refused: readonly RefusedRelation[]): string {
  return refused.length === 0
    ? '0 relations refused'
    : `${refused.length} relation(s) refused by a gate and not asserted (${refused
        .map((r) => `${r.qualifiedName}: ${r.reason}`)
        .join('; ')})`;
}

async function judgeGroup(input: JudgeInput): Promise<ConsistencyGroup> {
  const {
    units: requirementUnits,
    refused,
    requirements,
    noFormalClause,
    conditional,
  } = censusOf(input.contracts, input.clausesOf);

  const base = {
    subject: input.subject,
    requirements,
    core: [] as CoreMember[],
    minimized: false,
    coreLabel: coreLabelOf(false),
    unengageable: [] as UnengageableRequirement[],
    witness: [] as WitnessValue[],
    witnessConfirmed: false,
    refused,
    noFormalClause,
    fragment: 'qf-lra' as Fragment,
    logic: '',
    checks: 0,
  };

  // AN EMPTY CONJUNCTION IS SATISFIABLE AND SAYS NOTHING. A group whose
  // requirements state no relation this lane encodes is undecided, never
  // consistent — the same rule that stops `verify` exiting 0 over a model with
  // no obligations, one level up.
  if (requirementUnits.length === 0) {
    return {
      ...base,
      outcome: 'inconclusive',
      code: 'verification/unsupported-construct',
      detail:
        `no requirement on this subject states a relation this lane encodes, so there is nothing ` +
        `to check: an empty requirement set is satisfiable and says nothing about the model. ` +
        `${requirements.length} requirement(s), ${refusedSentence(refused)}`,
    };
  }

  // The axiom check, read here so every group reports it. A requirement set is
  // not what is wrong when the model's own facts collide.
  if (input.axiomOutcome !== null && input.axiomOutcome.status !== 'sat') {
    const status = input.axiomOutcome.status;
    return {
      ...base,
      outcome: 'inconclusive',
      // NO CHECK OF ITS OWN. The axiom check ran ONCE, for the whole run, and
      // the run counts it there; a group that short-circuits on it and also
      // reports it would make the published total read `N + 1` for one check.
      checks: 0,
      code:
        status === 'unsat'
          ? 'verification/inconsistent-axioms'
          : status === 'unknown'
            ? 'verification/timeout'
            : 'verification/not-evaluable',
      detail:
        status === 'unsat'
          ? 'the model’s own axiom set is unsatisfiable, so no question about its requirements can ' +
            'be answered from it: every set is inconsistent under a contradiction. core: ' +
            (input.axiomCore.length > 0
              ? coreSentence(input.axiomCore)
              : 'the solver named none') +
            `. ${refusedSentence(refused)}`
          : status === 'unknown'
            ? `the model’s own axiom set could not be shown satisfiable (${input.axiomOutcome.reason || 'unknown'} ` +
              `after ${input.axiomOutcome.timeoutMs} ms), and an answer over an axiom set nobody has ` +
              `checked is not an answer. ${refusedSentence(refused)}`
            : `the solver refused the axiom script this tool produced: ${input.axiomOutcome.reason}. ` +
              `That is a defect in this tool, not in the model. ${refusedSentence(refused)}`,
    };
  }

  const axioms = reachableAxioms(input.axiomUnits, requirementUnits);
  const units = [...axioms, ...requirementUnits];
  const script = scriptOf(units);
  const outcome = await input.backend.check(script.text, {
    timeoutMs: input.timeoutMs,
    variables: script.symbols,
  });
  let checks = 1;

  const shape = {
    ...base,
    fragment: script.fragment,
    logic: script.logic,
  };

  if (outcome.status === 'unknown') {
    return {
      ...shape,
      outcome: 'inconclusive',
      checks,
      code: 'verification/timeout',
      detail:
        `unknown after ${outcome.timeoutMs} ms (${outcome.reason || 'no reason given'}) — the solver ` +
        `was asked whether these ${requirements.length} requirement(s) can hold together ${mode(input.withValues)} ` +
        `and did not answer, so nothing is claimed either way. ${refusedSentence(refused)}`,
    };
  }
  if (outcome.status === 'error') {
    return {
      ...shape,
      outcome: 'inconclusive',
      checks,
      code: 'verification/not-evaluable',
      detail:
        `the solver refused the script this tool produced: ${outcome.reason}. That is a defect in ` +
        `this tool, not in the model. ${refusedSentence(refused)}`,
    };
  }

  if (outcome.status === 'unsat') {
    let core = coreMembersOf(outcome.core, script.owners);
    // AN INCONSISTENCY IS ONLY EVER PRINTED WITH A NAMED SUBSET — the charter
    // of this file. A core this tool cannot map back to the relations that
    // produced it names nothing, and `{}` is not a subset a reader can act on,
    // so the answer is that the run failed rather than that the model did. The
    // axiom branch above says the same thing the same way.
    if (core.length === 0) {
      return {
        ...shape,
        outcome: 'inconclusive',
        checks,
        code: 'verification/not-evaluable',
        detail:
          `the solver answered unsat over these ${requirements.length} requirement(s) and named no ` +
          `subset this tool could map back to the model, so there is nothing to show a reader: an ` +
          `inconsistency without a named conflicting subset is not reported as one. That is a defect ` +
          `in this tool, not in the model. ${refusedSentence(refused)}`,
      };
    }
    let minimized = false;
    if (input.minimize && core.length > 0) {
      const reduced = await minimizeCore(input, script.owners, core);
      checks += reduced.checks;
      core = reduced.core;
      minimized = reduced.complete;
    }
    return {
      ...shape,
      outcome: 'inconsistent',
      checks,
      code: 'verification/inconsistent-requirements',
      core,
      minimized,
      coreLabel: coreLabelOf(minimized),
      detail:
        `no design point satisfies all ${requirements.length} requirement(s) on this subject ` +
        `${mode(input.withValues)}: ${coreLabelOf(minimized)} is {${coreSentence(core)}}` +
        (input.minimize && !minimized
          ? ` — the deletion loop did not run to completion, so the subset is not claimed minimal ` +
            `(budget --max-core ${input.maxCore}, core ${core.length})`
          : '') +
        `. ${refusedSentence(refused)}`,
    };
  }

  // SAT — a design point. It is re-read through this tool's own evaluator
  // before it is printed, exactly as the SMT engine re-reads a counterexample.
  const confirmation = confirmWitness(requirementUnits, outcome.witness);
  if (!confirmation.ok) {
    return {
      ...shape,
      outcome: 'inconclusive',
      checks,
      code: 'verification/not-evaluable',
      witness: outcome.witness,
      detail:
        `a design point was found and this tool’s own evaluator would not confirm it: ` +
        `${confirmation.why}. A satisfying point this tool cannot reproduce is not evidence that ` +
        `the requirement set can be met. ${refusedSentence(refused)}`,
    };
  }
  // THE SECOND QUESTION THE IMPLICATION READING OBLIGES (module header): a set
  // of implications is satisfiable by falsifying every antecedent, so each
  // conditional requirement is asked whether it can be ENGAGED at a point this
  // set admits. Unconditional requirements are not asked — their antecedent is
  // empty and the main check already engaged them.
  const engagement = await checkEngagement(input, axioms, requirementUnits, conditional);
  checks += engagement.checks;

  // A SET SATISFIABLE ONLY BY NEVER ENGAGING ONE OF ITS REQUIREMENTS IS NOT A
  // GREEN ANSWER. It is a vacuity, and §2's rule for this lane is that vacuity
  // is inconclusive always and no flag launders it — the same rule `verify`
  // applies to an obligation discharged by an antecedent nothing satisfies, and
  // the reason the two commands cannot disagree here. The set IS satisfiable
  // and the witness says so; what is undecided is whether the requirements mean
  // anything at that point.
  if (engagement.unengageable.length > 0) {
    return {
      ...shape,
      outcome: 'inconclusive',
      checks,
      code: 'verification/vacuous',
      unengageable: engagement.unengageable,
      witness: outcome.witness,
      witnessConfirmed: true,
      detail:
        `these ${requirements.length} requirement(s) are satisfiable ${mode(input.withValues)} — ` +
        `witness ${witnessSentence(outcome.witness)} (stored magnitudes), re-read in process — but ` +
        `${engagement.unengageable.length} of them appl${engagement.unengageable.length === 1 ? 'ies' : 'y'} ` +
        `at NO point this set admits: ${engagement.unengageable
          .map((u) => `${u.shortId || u.qualifiedName} (assume ${u.assumptions.map((a) => `\`${a}\``).join(' and ')})`)
          .join(', ')}. A set that holds only because a requirement in it never applies has not been ` +
        `shown consistent, so nothing is claimed. ${refusedSentence(refused)}`,
    };
  }

  return {
    ...shape,
    outcome: 'consistent',
    checks,
    code: null,
    unengageable: engagement.unengageable,
    witness: outcome.witness,
    witnessConfirmed: true,
    detail:
      `${requirements.length} requirement(s) can hold together ${mode(input.withValues)}: ` +
      `${fragmentWord(script.fragment)}, witness ${witnessSentence(outcome.witness)} (stored magnitudes), ` +
      `re-read in process. ${refusedSentence(refused)}` +
      // The prose-only count travels with the word "consistent" for the same
      // reason the refused count does: it is how many of the N above this run
      // never encoded at all, and "3 requirement(s) can hold together … 0
      // relations refused" over a set where two of the three state nothing
      // formally is a figure that reads as a checked set.
      (noFormalClause > 0
        ? `, ${noFormalClause} requirement(s) state no relation at all and were not part of the question`
        : '') +
      `. This tool derives no domain axiom from a ` +
      `quantity kind, so the point is one the model’s own axioms admit and not necessarily one a ` +
      `physical design could take`,
  };
}

/**
 * Can each conditional requirement be ENGAGED at a point the whole set admits?
 *
 * `⋀ (Aⱼ ⇒ Gⱼ) ∧ Aᵢ`, once per requirement that carries assumptions. This is
 * the price of the implication reading, paid rather than hidden: without it a
 * requirement set whose antecedents contradict the model's own facts would be
 * called consistent precisely because nothing can ever engage it. Mutually
 * exclusive modes pass — each mode is engaged at its own point, which is the
 * whole reason the conjunction reading is not the one asked.
 *
 * An UNKNOWN or a refused script is not an answer and is not reported as one:
 * only an `unsat` — the requirement demonstrably applies nowhere — is named.
 * The cost is bounded by the number of conditional requirements, which is zero
 * on the ordinary unconditional set.
 */
async function checkEngagement(
  input: JudgeInput,
  axioms: readonly Unit[],
  requirementUnits: readonly Unit[],
  conditional: ReadonlyArray<{ contract: Contract; premises: EncodedRow[] }>,
): Promise<{ unengageable: UnengageableRequirement[]; checks: number }> {
  const unengageable: UnengageableRequirement[] = [];
  let checks = 0;
  for (const { contract, premises } of conditional) {
    // The antecedent, asserted on its own as a fact of this trial: `A ∧ ⋀(A⇒G)`.
    const engaged = premises.map((p) => unitOf(p, 'guarantee', contract, []));
    const outcome = await input.backend.check(
      scriptOf([...axioms, ...requirementUnits, ...engaged]).text,
      { timeoutMs: input.timeoutMs },
    );
    checks += 1;
    if (outcome.status !== 'unsat') continue;
    unengageable.push({
      id: contract.id,
      qualifiedName: contract.qualifiedName,
      shortId: contract.shortId,
      assumptions: premises.map((p) => p.row.expression),
    });
  }
  return { unengageable, checks };
}

/** `a conflicting subset`, and the one phrase that may say more. */
function coreLabelOf(minimized: boolean): string {
  return minimized ? 'a minimal conflicting subset' : 'a conflicting subset';
}

/**
 * The core, in an order this tool chose rather than the one z3 built it in.
 *
 * A core is a SET and z3's ordering of it carries no meaning, but the sentence
 * is read by people and pinned by tests — the same reason `coreSentence` in
 * {@link ./engines/smt} sorts. Each member is named the two ways the plan
 * requires: by the reader's name for the requirement, and by the qualified name
 * of the relation itself.
 */
function coreSentence(core: readonly CoreMember[]): string {
  const rendered = core.map((m) =>
    m.requirement
      ? `${m.requirement.shortId || m.requirement.qualifiedName}::${short(m.qualifiedName)}`
      : m.qualifiedName,
  );
  // TWO MEMBERS THAT RENDER THE SAME NAME NAME NOTHING. An anonymous clause has
  // no name of its own — most of the corpus is written that way — so a
  // requirement with two of them would print
  // `{R-1::«ConstraintUsage», R-1::«ConstraintUsage»}` and leave a reader with
  // a subset they cannot look up, in the one sentence §3.5 requires be a named
  // subset. Where the name repeats, the relation itself is what separates them.
  const count = new Map<string, number>();
  for (const name of rendered) count.set(name, (count.get(name) ?? 0) + 1);
  return rendered
    .map((name, i) =>
      (count.get(name) ?? 0) > 1 && core[i].expression
        ? `${name} \`${core[i].expression}\``
        : name,
    )
    .sort()
    .join(', ');
}

/** The last segment of a qualified name — the clause, without its owner again. */
function short(qualifiedName: string): string {
  const parts = qualifiedName.split('::');
  return parts[parts.length - 1] || qualifiedName;
}

/** Map z3's labels back to the relations that produced them. */
function coreMembersOf(
  labels: readonly string[],
  owners: ReadonlyMap<string, Unit>,
): CoreMember[] {
  const out: CoreMember[] = [];
  const seen = new Set<ElementId>();
  for (const label of labels) {
    const unit = owners.get(label);
    if (!unit) continue;
    // One member per RELATION, not per assertion: a relation whose encoding
    // added a `≠ 0` guard contributes two labels, and a core naming it twice
    // would read as two colliding facts where the model states one.
    if (seen.has(unit.row.row.element.id)) continue;
    seen.add(unit.row.row.element.id);
    out.push({
      label,
      id: unit.row.row.element.id,
      qualifiedName: unit.row.row.element.qualifiedName,
      expression: unit.row.row.expression,
      kind: unit.kind,
      assumptions: unit.premises.map((p) => p.row.expression),
      requirement: unit.contract
        ? {
            id: unit.contract.id,
            qualifiedName: unit.contract.qualifiedName,
            shortId: unit.contract.shortId,
          }
        : null,
    });
  }
  return out;
}

/**
 * Reduce a core by deletion, one member at a time.
 *
 * THE ONLY THING THAT EARNS THE WORD "MINIMAL". The working set is the CORE
 * ITSELF and nothing else — an unsat core is by definition a subset of the
 * assertions that is unsatisfiable on its own, so that is the set a deletion
 * loop has to shrink. Testing each candidate against the whole script instead
 * is a defect that looks like a working algorithm: whenever the script carries
 * an assertion the core does NOT — a reachable axiom, or under `--with-values`
 * the pinned value of the very feature the core is about — that assertion keeps
 * every trial unsatisfiable, so the loop deletes a member the rest does not
 * contradict without and returns a SATISFIABLE singleton labelled MINIMAL. It
 * was found by running the command and it is regression-tested at
 * `--minimize --with-values` over `consistency-conflict.sysml`, which is the
 * shape that reproduces it; the two modes are not interchangeable here, because
 * with the values released the core and the script coincide and the defect is
 * invisible.
 *
 * Each member is removed and the rest re-checked: still unsat and the member
 * was not needed, so it stays out; satisfiable without it and it is
 * load-bearing, so it goes back. The loop is COMPLETE only when every member
 * was tried and every check answered — a timeout or a refused script leaves
 * `complete: false`, and the caller then prints "a conflicting subset" exactly
 * as it would have without the flag.
 *
 * The budget is a member count rather than a wall clock, because that is what
 * the cost is: one check per member (§6). A core larger than the budget is
 * returned untouched, which is the honest answer — "we did not try" — rather
 * than a partially reduced set that would be neither the core nor minimal.
 */
async function minimizeCore(
  input: JudgeInput,
  owners: ReadonlyMap<string, Unit>,
  core: readonly CoreMember[],
): Promise<{ core: CoreMember[]; complete: boolean; checks: number }> {
  if (core.length > input.maxCore) {
    return { core: [...core], complete: false, checks: 0 };
  }
  const units: Unit[] = [];
  for (const member of core) {
    const unit = owners.get(member.label);
    // A label with no owner is this tool failing to recognise its own script.
    // The core stands — z3 answered unsat over it — but nothing may be reduced
    // on the strength of a member nobody can find.
    if (!unit) return { core: [...core], complete: false, checks: 0 };
    if (!units.includes(unit)) units.push(unit);
  }
  let working = units;
  let checks = 0;
  const remaining = (): CoreMember[] => {
    const kept = new Set(working);
    return core.filter((m) => {
      const unit = owners.get(m.label);
      return unit === undefined || kept.has(unit);
    });
  };
  for (const unit of units) {
    if (!working.includes(unit)) continue;
    const trial = working.filter((u) => u !== unit);
    const outcome = await input.backend.check(scriptOf(trial).text, { timeoutMs: input.timeoutMs });
    checks += 1;
    if (outcome.status === 'unsat') {
      working = trial;
      continue;
    }
    if (outcome.status !== 'sat') {
      // The solver did not answer. What remains is a genuine conflicting
      // subset — every deletion so far was made on an unsat — but it is not
      // MINIMAL, and saying so is the whole point of the flag.
      return { core: remaining(), complete: false, checks };
    }
  }
  return { core: remaining(), complete: true, checks };
}

/* ─────────────────────── the witness re-evaluation gate ──────────────────── */

/**
 * Substitute the design point back through this tool's own evaluator.
 *
 * SCOPED TO THE REQUIREMENT RELATIONS, deliberately, and the limit is worth
 * stating rather than hiding. The claim being made is about the requirement
 * set, so the requirements are what must be re-read as true at the point the
 * solver chose; that is what catches an encoding built wrong — a flipped
 * comparison, a mis-scaled factor, a numeral that is not the number this tool
 * holds. The structural axioms are NOT re-read, because z3 reasons over exact
 * rationals and this evaluator over binary64: a derived feature's defining
 * equation re-read at an exact rational witness can differ in the last bit and
 * would report an encoder defect for a rounding difference. What that costs is
 * stated in the report — the point is one the axioms ADMIT — and the direction
 * of the remaining risk is the safe one, since an axiom this gate cannot check
 * can only make the set harder to satisfy.
 *
 * A symbol the solver did not assign is an unread relation, and an unread
 * relation is NOT a confirmation: it comes back as a failure, because "the
 * point could not be checked" and "the point checks out" must not be the same
 * answer.
 */
function confirmWitness(
  units: readonly Unit[],
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
      return `this tool’s own evaluator makes \`${row.row.expression}\` ${String(out.value)} at the point the solver chose, not a truth value`;
    }
    return out.value;
  };
  for (const unit of units) {
    if (unit.row.row.node === null) continue;
    // WHAT IS RE-READ IS THE IMPLICATION, because that is what was asserted. A
    // conditional requirement whose antecedent is FALSE at the solver's point
    // is satisfied, and re-reading only its guarantee would report an encoder
    // defect for a requirement that simply does not apply there.
    let engaged = true;
    for (const premise of unit.premises) {
      const p = reread(premise);
      if (typeof p === 'string') return { ok: false, why: p };
      if (!p) {
        engaged = false;
        break;
      }
    }
    if (!engaged) continue;
    const g = reread(unit.row);
    if (typeof g === 'string') return { ok: false, why: g };
    if (!g) {
      return {
        ok: false,
        why: `this tool’s own evaluator makes \`${unit.row.row.expression}\` false at the point the solver chose, not true`,
      };
    }
  }
  return { ok: true };
}

/**
 * The plan's two-word fragment vocabulary, spelled the way a verdict line
 * spells it.
 *
 * The FRAGMENT is free-relative — `a * b` with `b` pinned by an axiom is linear
 * reasoning — and the `set-logic` line is computed from the bytes, so the two
 * legitimately differ: under `--with-values` this reads `QF_LRA` over a script
 * whose header says `QF_NRA`. Both are published on the group, and this is the
 * one a reader is shown.
 */
function fragmentWord(fragment: Fragment): string {
  return fragment.replace('-', '_').toUpperCase();
}

/**
 * The design point, in the magnitudes the file stores.
 *
 * THE NUMBER, NOT z3's TERM. The solver answers in exact rationals and prints
 * them as `(/ 37.0 2.0)`; this tool already computes the decimal it means
 * ({@link WitnessValue.value}, the same number the re-evaluation gate reads),
 * and §3.5's own verdict vocabulary is `witness mtow = 18.5 kg`. The exact term
 * stays on the payload for a reader who needs it — a decimal is a rounding of
 * the rational and the JSON says both — but the sentence a person reads is the
 * number.
 */
function witnessSentence(witness: readonly WitnessValue[]): string {
  if (witness.length === 0) return '(no symbol was assigned)';
  return witness.map((w) => `${w.symbol} = ${witnessNumber(w)}`).join(', ');
}

/** One witness value as a reader reads it, falling back to the exact term. */
export function witnessNumber(w: WitnessValue): string {
  if (typeof w.value === 'boolean') return String(w.value);
  if (typeof w.value === 'number' && Number.isFinite(w.value)) return String(w.value);
  return w.term;
}
