/**
 * `check-behaviour` — safety patterns over a configuration graph, and the three
 * things this engine refuses to say (plan §3.8).
 *
 * WHAT IT DECIDES, AND WHAT IT CANNOT. A property pattern is a shape with atoms
 * in it (`./atoms`) and a SCOPE it holds over. Four of the eight patterns in the
 * catalogue are SAFETY properties: every violation of one has a finite bad
 * prefix, so a search over the configuration graph either finds a run that
 * breaks it — and prints that run — or, having seen the whole graph, does not.
 * One is a GUARANTEE: `cover` asks whether some run enters a situation, which
 * is Manna–Pnueli's `◇β` — not finitely refutable, so the bad-prefix engine
 * cannot refute it, but finitely WITNESSABLE, so the same search that refutes
 * `absence` confirms it. Its two answers are `covered` and `not-covered`, and
 * neither is laundered into the four words beside them: `covered` is a witness (row
 * W1 of `./publishable`), `not-covered` a decided absence (row A5) — a missing
 * behaviour, never a violated requirement, so it exits 2 and spends the 1 only
 * under `--cover-required`.
 * One is BRANCHING-TIME: `recovery` asks whether a named state is reachable
 * from EVERY reachable configuration — `AG EF p` — which no bad-prefix search
 * decides in either direction, so it never reaches one: {@link recoveryRow} is a
 * reverse-reachability pass over the relation the walk retained, and it
 * publishes `recoverable` or `not recoverable` only where `walkIsExact` holds.
 * Two of them are LIVENESS: `existence` and `response` are violated only by an
 * INFINITE run that never delivers what was promised, and a bad-prefix search
 * finds no bad prefix for either. Under a naive "no violation found ⇒ pass"
 * rule that would print the strongest verdict this command has for exactly the
 * two properties it cannot decide, so both report `inconclusive: liveness not
 * checked in-process` until a lasso search lands and a fairness assumption is
 * named. `vogel-2022`, this lane's own citation for the catalogue, is explicit
 * that response is the path-formula exception; that is why it needs observer
 * automata for it at all.
 *
 * THREE SENTENCES THIS FILE MUST NEVER PRODUCE, and where each is stopped:
 *
 *  1. **A pass on a partial walk.** `exhaustive` is read off `exploreMachine`'s
 *     result — the four conditions §3.8 states, plus the fifth this tool learned
 *     the hard way, that every guard the walk consulted decided something — and
 *     a `pass` is written only when all five hold. A bound hit, an unsupported
 *     construct or a guard nothing in the model decides makes the property
 *     `inconclusive`, never `pass`: the absence of a bad prefix in half a graph
 *     is not the absence of one, and neither is its absence in a graph missing
 *     an edge nobody decided.
 *  2. **A pass on a property class this engine cannot decide.** See the liveness
 *     paragraph above.
 *  3. **A pass over an antecedent that never holds.** A property whose scope no
 *     run ever opens is `vacuous` — inconclusive, exit 2 — because "P never
 *     happens after Q" is worth nothing on a machine that never reaches Q.
 *     Vacuity is this plan's one declared deviation from the standard (§6), and
 *     `--strict-vacuity` makes it an error rather than a row to scroll past. It
 *     does NOT change the exit code, and nothing here launders it back to green.
 *
 * A FAIL, ON THE OTHER HAND, DOES NOT NEED EXHAUSTION. The witness is a real
 * run of this semantics — the walk branches only on the declaration-order
 * tie-break the notation leaves undecided — so finding one in a partial walk
 * still refutes the property. The asymmetry is the point: a bound can hide a
 * violation, and it can never invent one.
 *
 * WHY THE WALK IS RUN TWICE. `exploreMachine` answers "was this graph seen
 * whole", which is one authority for every absence claim in this lane, and the
 * product search below answers "is there a bad prefix". Folding the second into
 * the first would put the publishability conditions in two places, and the one
 * thing worse than paying for a second walk is two readings of what
 * `exhaustive` means. That is not a slogan: this file and `reachOne` DID drift
 * apart for exactly one commit, `reach` withholding its lists over an
 * undetermined guard while `check-behaviour` printed `pass` and `exhaustive`
 * over the same machine, and the repair was to read the fifth condition off the
 * same walk result rather than to recompute it. The repair is now structural:
 * the conjunction itself is `publishabilityOf` in `./publishable`, this file and
 * `reachOne` both call it, and the only thing this one adds is the
 * product-search conjunct it passes in.
 */

import type { ElementId, ElementRecord, Model } from '@core/index';
import type { Diagnostic } from '@validation/types';
import {
  PROPERTY_PATTERN_DEFINITION,
  PROPERTY_PATTERN_QUALIFIED_NAME,
} from '../verification-vocabulary';
import {
  MALFORMED_PROPERTY_CODE,
  UNKNOWN_ATOM_CODE,
  atomHolds,
  expressionRefusal,
  readAtom,
  type Atom,
  type AtomRefusal,
  type Observation,
} from './atoms';
import {
  MAX_COMPLETION,
  afterDuration,
  enabledTransitions,
  hashConfig,
  initialConfig,
  leafOf,
  seedStore,
  stepConfig,
  triggerLabelOf,
  type MachineConfig,
  type StepInput,
} from './config';
// `boundsSentence` is IMPORTED and no longer copied. This file carried a
// byte-identical second definition of it, and the sentence it composes is the
// one every absence row in every lane is qualified by — so the two copies had to
// move together or say two different things about the same walk. That is the
// defect the publishability conjunction had one document down, and it is fixed
// the same way: one definition, two readers.
import {
  BEHAVIOUR_UNSUPPORTED_CODE,
  BEHAVIOUR_WARNING_CODES,
  BOUND_EXHAUSTED_CODE,
  DEFAULT_MAX_CONFIGS,
  DEFAULT_MAX_DEPTH,
  GUARD_UNDETERMINED_CODE,
  boundsSentence,
  classifyBottoms,
  exploreMachine,
  machineAlphabet,
  machineStates,
  transitionLabel,
  walkableTransitions,
  type BoundHit,
  type ExploreBounds,
  type ExploreOptions,
  type ExploreResult,
  type StateRef,
  type TransitionRef,
  type UnsupportedConstruct,
} from './explore';
import { SEMANTIC_PROFILE, type ProfileField } from './profile';
// One definition of "may this absence be stated", shared with `reachOne` — and
// the one gate the modality reads for BOTH of its values (`walkIsExact`) and
// the exactness gate's relation half, which is what the `covered` witness
// reads, with the standing sentences (§2.4) the modality's rows and the cover
// warrant print beside a withheld or a published answer. `./explore` prints
// them as well and imports nothing from here, so this file cannot be their home.
import {
  CLAUSE_SENTENCE,
  DWELL_SENTENCE,
  environmentSentence,
  SIMULATOR_SENTENCE,
  publishabilityOf,
  walkIsExact,
  type FailedClause,
} from './publishable';
// Component arithmetic over the retained relation, for the avoiding cycle.
// `./scc` decides nothing about what may be published; `modalityOf` asks the
// gate first and reads the components only where it holds.
import { acyclic, reverseReachable, tarjanComponents, type Components } from './scc';

/* ───────────────────────────── the catalogue ────────────────────────────── */

/** The eight patterns, split by what a bad-prefix search can decide. */
export type PatternName =
  | 'absence'
  | 'universality'
  | 'bounded-existence'
  | 'precedence'
  | 'cover'
  | 'recovery'
  | 'existence'
  | 'response';

/**
 * Safety is decided here in the refuting direction; a guarantee is decided here
 * in the WITNESSING direction (`cover` — Manna–Pnueli's `◇β`, confirmed by one
 * run and never refuted by a finite prefix); a branching-time pattern
 * (`recovery` — `AG EF p`) is decided in BOTH directions by reverse
 * reachability over the retained relation, and by no run at all; liveness is
 * not decided in-process at all.
 */
export type PatternClass = 'safety' | 'guarantee' | 'branching' | 'liveness';

/** The five scopes, spelled as a reader writes them in the carrier. */
export type ScopeName = 'globally' | 'before' | 'after' | 'between' | 'after-until';

/** What one pattern needs, what it means, and whether this engine can decide it. */
export interface PatternSpec {
  readonly name: PatternName;
  readonly kind: PatternClass;
  /** The atom fields it needs, beyond the scope's own. */
  readonly fields: readonly ('p' | 's')[];
  /** Does it need a count? Only `bounded-existence` does. */
  readonly needsCount: boolean;
  /** One sentence, in the words the verdict line prints. */
  readonly reading: string;
}

/**
 * The catalogue, in `vogel-2022`'s split, plus the one guarantee row.
 *
 * The order is safety first, and it is not cosmetic: the four this engine
 * decides come first so a reader scanning `--help` or the guide meets what the
 * command can do before what it refuses, and the two liveness rows carry the
 * refusal in their own reading rather than in a footnote. `cover` sits BETWEEN
 * the two groups and not at the end, because `test/unit/cli-reference.test.ts`
 * asserts that the liveness pair is the LAST TWO of `PATTERN_NAMES` — the
 * `--pattern` help row says "the last two are LIVENESS" — and appending would
 * have moved that guard for a reason nobody wanted.
 */
export const PATTERNS: readonly PatternSpec[] = [
  {
    name: 'absence',
    kind: 'safety',
    fields: ['p'],
    needsCount: false,
    reading: 'P never holds',
  },
  {
    name: 'universality',
    kind: 'safety',
    fields: ['p'],
    needsCount: false,
    reading: 'P holds at every configuration',
  },
  {
    name: 'bounded-existence',
    kind: 'safety',
    fields: ['p'],
    needsCount: true,
    reading: 'P holds at most N time(s)',
  },
  {
    name: 'precedence',
    kind: 'safety',
    fields: ['p', 's'],
    needsCount: false,
    reading: 'S holds before P ever does',
  },
  {
    // THE ONE GUARANTEE. `existence` below asks the same question of EVERY run
    // and is liveness; `cover` asks it of SOME run, which one witness settles.
    name: 'cover',
    kind: 'guarantee',
    fields: ['p'],
    needsCount: false,
    reading: 'P holds on some run',
  },
  {
    // THE ONE BRANCHING-TIME ROW. Not a property of a run at all: from every
    // configuration the walk reached, is there SOME continuation that enters
    // P? A bad-prefix search finds no bad prefix for it on any graph and would
    // return `pass` for free, which is why `checkProperty` dispatches it to
    // `recoveryRow` before any search runs. Before the liveness pair for the
    // reason `cover` is.
    name: 'recovery',
    kind: 'branching',
    fields: ['p'],
    needsCount: false,
    reading: 'P is reachable from every reachable configuration',
  },
  {
    name: 'existence',
    kind: 'liveness',
    fields: ['p'],
    needsCount: false,
    reading: 'P holds at some point',
  },
  {
    name: 'response',
    kind: 'liveness',
    fields: ['p', 's'],
    needsCount: false,
    reading: 'every P is followed by an S',
  },
];

/** What one scope needs and what it means. */
export interface ScopeSpec {
  readonly name: ScopeName;
  /** The atom fields it needs. */
  readonly fields: readonly ('q' | 'r')[];
  /**
   * The fields whose holding OPENS the scope — the antecedent, for vacuity.
   *
   * Not the same list as {@link fields}, and the difference is the whole
   * vacuity rule. `after Q until R` needs both atoms and is opened by Q alone,
   * so a run that never reaches R is still a run the property spoke about;
   * `before R` needs only R and is opened — for the purpose of having said
   * anything — only when an R actually arrives, because `<>R -> (!P U R)` is
   * true and empty on a run without one. A vacuity row that named the wrong
   * atom would send a reader to fix the wrong half of their property.
   */
  readonly antecedent: readonly ('q' | 'r')[];
  /** One sentence, in the words the verdict line prints. */
  readonly reading: string;
}

/**
 * The five scopes.
 *
 * `before` and `between` both require their CLOSING atom to occur before a
 * violation counts, and that is Dwyer's reading rather than a convenience: "P
 * is absent before R" is `<>R -> (!P U R)`, so on a run where R never happens
 * there is nothing to violate. A search that reported the P alone would report
 * a violation of a property that holds.
 */
export const SCOPES: readonly ScopeSpec[] = [
  { name: 'globally', fields: [], antecedent: [], reading: 'over the whole run' },
  { name: 'before', fields: ['r'], antecedent: ['r'], reading: 'before the first R' },
  { name: 'after', fields: ['q'], antecedent: ['q'], reading: 'from the first Q onwards' },
  {
    name: 'between',
    fields: ['q', 'r'],
    antecedent: ['q', 'r'],
    reading: 'between each Q and the next R',
  },
  {
    name: 'after-until',
    fields: ['q', 'r'],
    antecedent: ['q'],
    reading: 'after each Q until the next R (or the end)',
  },
];

/** The atom fields a property can carry, which are also the carrier's attributes. */
export const PROPERTY_FIELDS = ['pattern', 'scope', 'p', 'q', 'r', 's', 'n'] as const;

/* ──────────────────────────── what a property is ────────────────────────── */

/** Where a property came from, printed on its verdict line. */
export type PropertySource = 'model' | 'flag';

/** One property as written, before anything is resolved. */
export interface PropertyText {
  readonly pattern: string;
  readonly scope: string;
  readonly p?: string;
  readonly q?: string;
  readonly r?: string;
  readonly s?: string;
  readonly n?: string;
  readonly source: PropertySource;
  /** The element the carrier sits on, or `null` for a `--pattern` flag. */
  readonly carrier: string | null;
  /**
   * Attribute names on the carrier that are not property fields.
   *
   * Present only when there ARE some, so a property nobody mistyped is the same
   * object it always was. `--pattern` refuses an unknown key outright; a
   * carrier cannot, because it is read from a model whose other attributes are
   * none of this module's business — so the ones inside a `PropertyPattern`
   * carrier are collected here and refused at {@link resolveProperty}, where
   * every other unreadable property is refused.
   */
  readonly unknownFields?: readonly string[];
}

/** One property, resolved against the machine it is about. */
interface ResolvedProperty {
  readonly text: PropertyText;
  readonly pattern: PatternSpec;
  readonly scope: ScopeSpec;
  readonly atoms: { p?: Atom; q?: Atom; r?: Atom; s?: Atom };
  readonly count: number;
}

/* ─────────────────────────────── the verdict ────────────────────────────── */

/**
 * The six words this command may reach. Nothing here is ever `proved`.
 *
 * `covered` and `not-covered` are `cover`'s alone (plan §2.2) and the
 * vocabulary is CLOSED after them. Neither is laundered into the four it grew
 * from: `covered ⇒ pass` would file a witness under a word that means "on every
 * reachable configuration", and `not-covered ⇒ inconclusive` would file a
 * DECIDED absence under the word this tool reserves for undecided. The exit
 * arithmetic in {@link behaviourReport} and the summary line in
 * `scripts/sysprose.ts` both count all six, and a guard asserts the six buckets
 * sum to the row count — a word counted nowhere falls through to exit 0.
 */
export type PropertyClaim = 'pass' | 'fail' | 'vacuous' | 'inconclusive' | 'covered' | 'not-covered';

/**
 * The census one `cover` row publishes on `--json` (plan §2.5, §3.1).
 *
 * `coverUnreachedBehindUndefinedGuard` is correction 23's exposure counted
 * rather than argued about: the states this cover did not reach whose EVERY
 * inbound walkable transition carries a guard the walk could not evaluate. A
 * state nothing points at is not counted — `[].every()` is true and an orphan
 * is not "behind" anything. `coverUnreached` is the denominator — every state
 * of the machine the walk did not reach, orphans included — so the refusal
 * sentence can quote the exposure as a fraction rather than as a universal.
 */
export interface CoverCensus {
  readonly atomKind: Atom['kind'];
  readonly scope: ScopeName;
  readonly coverUnreached: number;
  readonly coverUnreachedBehindUndefinedGuard: number;
}

/**
 * The census one `recovery` row publishes on `--json` (plan §2.5, §3.2b, §5 row
 * 9): which atom kind it read, how many configurations hold the target, how
 * many cannot reach it, how many of those `reach` would report as a trap, and
 * which clause of the exactness gate — if any — withheld the answer.
 *
 * THREE-VALUED where `TrapCensus` is, for the same reason: `cannotReach` and
 * `bottomSccOverlap` are answers about the MACHINE and read `null` whenever
 * the row was refused — by the gate, or by the atom kind — because a
 * `cannotReach: 0` on a refused walk would read as a decided absence.
 * `targetConfigs` is a fact about the RETAINED relation and stays a number on
 * every walk the arm READ — a gate refusal carries the count it collected —
 * but it is `null` on the two refusals that come before the target set is
 * collected at all (a scope this pattern gives no semantics to, an atom kind
 * it cannot observe): a `0` there would read as "no configuration holds it",
 * the same species of decided-looking absence, about a set never computed.
 *
 * The kill measurement (§3.2b): if `cannotReach` is always either 0 or the
 * whole complement of the opening's component, this pattern answers the
 * question `reach`'s trap row already answers.
 */
export interface RecoveryCensus {
  readonly atomKind: Atom['kind'];
  readonly targetConfigs: number | null;
  readonly cannotReach: number | null;
  readonly bottomSccOverlap: number | null;
  readonly refusedByGate: FailedClause;
}

/** One observation of the witness run, in the words the trace prints. */
export interface TraceStep {
  /** 0 for the opening configuration, then one per step. */
  index: number;
  /** The event offered: a trigger name, `''` for completion, `-` for the opening. */
  event: string;
  transition: TransitionRef | null;
  leaf: StateRef | null;
  stack: readonly StateRef[];
  /** Which of the property's own atoms hold here, by field name. */
  holds: readonly string[];
}

/** The three answers the modality can give about a refutation (plan §3.R). */
export type ModalityValue = 'guaranteed' | 'potential' | 'not-decided';

/**
 * Whether the violation a `fail` row printed happens on SOME run or on EVERY
 * run of the machine (plan §3.R). It annotates the refutation; it replaces
 * nothing on the row, and no count or exit code reads it.
 *
 * `guaranteed` — every maximal run of the machine reaches the violation. An
 * absence claim (register row A8): *no run avoids it*. `potential` — some run
 * avoids it, and {@link Modality.sentence} names that run: a cycle that never
 * enters the violating configuration, or a configuration of the FULL retained
 * relation with no way out (register row W3, a maximality witness — the claim
 * is that the cycle or the sink has no exit, which a missing edge invents).
 * `not-decided` — one of the seven refusals of §3.R, with the reason in the
 * sentence and, where the reason is the walk, the clause of the exactness gate
 * that failed in {@link Modality.failedClause}.
 *
 * BOTH VALUES READ ONE PREDICATE. Neither `guaranteed` nor `potential` is ever
 * composed unless `walkIsExact` holds: the first quantifies over the run set,
 * which the cooperative environment changes; the second names a run with no
 * exit, which a bound, a dwell the walk offers at every configuration and a
 * guard nothing decided all manufacture. The value and the failed clause
 * together are this feature's census.
 */
export interface Modality {
  readonly value: ModalityValue;
  /**
   * The one line the report prints: the value word first, then the reason or
   * the named run. On a decided value over a walk that recorded a
   * nondeterministic choice, the simulator sentence is appended to it — one
   * string, one printed line.
   */
  readonly sentence: string;
  /**
   * Which clause of `walkIsExact` withheld the answer — `null` where the gate
   * held, AND `null` where the answer was withheld for a reason that is not
   * the gate's (rows 2, 3 and 4: the monitor carries state, or the atom is one
   * the retained relation cannot observe). So `value === 'not-decided' &&
   * failedClause !== null` reads exactly "refused by the gate", and the four
   * buckets of the census stay separable: a triggered machine refused at row 3
   * is an atom refusal, not an environment one.
   */
  readonly failedClause: FailedClause;
  /**
   * The avoiding run, as the sentence prints it: the cycle with its first
   * configuration repeated at the end, or the one configuration a run stops in.
   * `null` on every value but `potential`.
   */
  readonly avoiding: readonly StateRef[] | null;
}

/** What one property came to, and everything a reader needs to argue with it. */
export interface PropertyVerdict {
  /** The machine it is about. */
  machine: StateRef & { eClass: string };
  /** The property as written, with its provenance. */
  property: PropertyText;
  /** `absence` / `safety`, resolved — absent when the property was refused. */
  pattern: PatternName | null;
  patternClass: PatternClass | null;
  scope: ScopeName | null;
  /** The English reading the verdict holds under. */
  sentence: string;
  claim: PropertyClaim;
  /** The `verification/*` code, for any row that is not a pass. */
  code: string | null;
  detail: string;
  /** Did an explored run ever open the property's scope? */
  activated: boolean;
  bounds: ExploreBounds;
  /**
   * PRODUCT states the search saw — and, on a row with a witness, only those
   * seen UP TO the witness, because the search returns at the first breach.
   */
  configs: number;
  /**
   * Configurations of the MACHINE graph, `exploreMachine`'s own count.
   *
   * A second, LABELLED number beside {@link configs}, because `base` sets
   * `configs: found.configs` on every row and no sentence may quote that as a
   * total (§2.4b). The `not covered … over W configuration(s)` sentence names
   * this field, so the JSON and the prose cannot publish two unlabelled counts.
   */
  machineConfigs: number;
  exhaustive: boolean;
  boundHit: BoundHit;
  /** The sentence every figure on this row is true UNDER. */
  qualification: string;
  unsupported: readonly UnsupportedConstruct[];
  /** The run this row stands on — a bad prefix, or a `cover` witness. EMPTY on every other claim. */
  witness: readonly TraceStep[];
  /**
   * Some run or every run? Composed on a `fail` row and on no other claim.
   *
   * REQUIRED, `null` elsewhere, rather than optional: a `--json` consumer reads
   * a stable key set, and a row that carries no modality says so by carrying
   * the key. `counts` and `exitCode` never read it (plan §3.R: the exit-code
   * contract is unchanged).
   */
  modality: Modality | null;
  /** Present on a `cover` row that reached the walk, and on no other. */
  cover?: CoverCensus;
  /** Present on a `recovery` row that reached the walk, and on no other. */
  recovery?: RecoveryCensus;
}

/** What `check-behaviour` publishes. */
export interface BehaviourReport {
  /** The machine the run was scoped to. */
  machine: (StateRef & { eClass: string }) | null;
  properties: readonly PropertyVerdict[];
  /** The reading every verdict holds under (plan §3.8). */
  profile: readonly ProfileField[];
  counts: {
    passed: number;
    failed: number;
    vacuous: number;
    inconclusive: number;
    covered: number;
    notCovered: number;
  };
  /** Was the vacuity row raised to an error? It changes no exit code (§2). */
  strictVacuity: boolean;
  /** Does a `not-covered` row spend the 1? It changes no claim word (§2.2). */
  coverRequired: boolean;
  exitCode: 0 | 1 | 2;
  diagnostics: Diagnostic[];
}

/** What a caller may set. */
export interface BehaviourOptions extends ExploreOptions {
  /** The machine to check. Required: a property is about one machine. */
  machineId: ElementId;
  /** One property from the command line, in the `key=value` spelling. */
  pattern?: string;
  /** Raise the vacuity row to an ERROR. It changes no exit code (§2). */
  strictVacuity?: boolean;
  /**
   * Exit 1 on a `not-covered` row. It raises the exit code and NEVER the claim:
   * promoting `not-covered` to `fail` would print `verification/refuted` about
   * a design that violates nothing — the defect `cover` exists to fix,
   * reproduced by the fix (§2.2).
   */
  coverRequired?: boolean;
}

/* ──────────────────────────── reading a property ────────────────────────── */

/** A property text, or the reason it could not be read. */
type TextResult =
  | { readonly ok: true; readonly text: PropertyText }
  | { readonly ok: false; readonly detail: string };

/**
 * Read the `key=value` spelling `--pattern` takes.
 *
 * ONE GRAMMAR FOR BOTH DOORS. The fields are exactly the carrier's attributes,
 * in the same names, so a property typed at a terminal and one written into a
 * file are the same property and a reader learns one vocabulary. The separator
 * is `,` or `;`, and a field value may hold neither — which is the one thing
 * the carrier form can express and this one cannot, and is said in the help
 * text rather than left to be discovered.
 */
export function parsePropertyText(raw: string, source: PropertySource = 'flag'): TextResult {
  const fields = new Map<string, string>();
  for (const part of raw.split(/[,;]/)) {
    const chunk = part.trim();
    if (chunk === '') continue;
    const eq = chunk.indexOf('=');
    if (eq <= 0) {
      return {
        ok: false,
        detail:
          `\`${chunk}\` is not a \`key=value\` field. A property is written ` +
          `\`pattern=absence, scope=globally, p=state failsafe\` — the same field names the ` +
          `\`@${PROPERTY_PATTERN_DEFINITION}\` carrier uses.`,
      };
    }
    const key = chunk.slice(0, eq).trim();
    const value = chunk.slice(eq + 1).trim();
    if (!(PROPERTY_FIELDS as readonly string[]).includes(key)) {
      return {
        ok: false,
        detail: `\`${key}\` is not a property field — they are ${PROPERTY_FIELDS.join(', ')}.`,
      };
    }
    if (fields.has(key)) {
      return { ok: false, detail: `\`${key}\` is given twice; a property states each field once.` };
    }
    fields.set(key, value);
  }
  if (fields.size === 0) {
    return {
      ok: false,
      detail:
        'no fields at all. A property is written `pattern=absence, scope=globally, p=state failsafe`.',
    };
  }
  return {
    ok: true,
    text: {
      pattern: fields.get('pattern') ?? '',
      scope: fields.get('scope') ?? 'globally',
      ...(fields.has('p') ? { p: fields.get('p')! } : {}),
      ...(fields.has('q') ? { q: fields.get('q')! } : {}),
      ...(fields.has('r') ? { r: fields.get('r')! } : {}),
      ...(fields.has('s') ? { s: fields.get('s')! } : {}),
      ...(fields.has('n') ? { n: fields.get('n')! } : {}),
      source,
      carrier: null,
    },
  };
}

/** The text a carrier cell holds, unquoted — the lexeme shape facets use. */
function cellText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // A malformed literal is still text somebody wrote: hand it back unquoted
      // rather than dropping the carrier it is on.
    }
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Is this element a `@SysproseVerification::PropertyPattern { … }` carrier?
 *
 * Both spellings of the type, for the reason `isEvidenceCarrier` accepts both:
 * the parser stores what was written, and a tool that could not read the short
 * form after telling the reader to import the package would be refusing its own
 * documentation. A non-annotating `metadata PropertyPattern` is NOT a carrier —
 * that owns facets for its owner, and reading it as a property would let two
 * carriers collide.
 */
export function isPropertyCarrier(el: ElementRecord): boolean {
  if (el.eClass !== 'MetadataUsage' || el.attrs.annotation !== true) return false;
  const type = el.attrs.type;
  return type === PROPERTY_PATTERN_QUALIFIED_NAME || type === PROPERTY_PATTERN_DEFINITION;
}

/**
 * Every property carried inside one machine, in model order.
 *
 * Read from the machine AND its descendants: the natural home for a property
 * about a machine is the machine itself, and the natural home for one about a
 * state is that state. Both are inside the graph the walk covers, so both are
 * about the same runs.
 */
export function propertiesOf(model: Model, machineId: ElementId): PropertyText[] {
  const out: PropertyText[] = [];
  const holders = [model.get(machineId), ...model.descendants(machineId)];
  for (const holder of holders) {
    if (!holder) continue;
    for (const carrier of model.children(holder.id)) {
      if (!isPropertyCarrier(carrier)) continue;
      const cells = new Map<string, string>();
      const unknown: string[] = [];
      for (const cell of model.children(carrier.id)) {
        if (cell.eClass !== 'AttributeUsage') continue;
        const name = cell.declaredName ?? '';
        const value = cellText(cell.attrs.value);
        if (name === '' || value === undefined) continue;
        // A CELL THIS MODULE DOES NOT KNOW IS NOT A CELL TO SKIP. `scope` is
        // the one field with a default, so a carrier written `scpoe = "after"`
        // silently re-read as `scope = globally` is a DIFFERENT property — and
        // one this command will happily decide, print a witness for and exit 1
        // on, about a claim nobody made. Collected and refused, exactly as the
        // `--pattern` grammar refuses an unknown key.
        if (!(PROPERTY_FIELDS as readonly string[]).includes(name)) {
          unknown.push(name);
          continue;
        }
        cells.set(name, value);
      }
      out.push({
        pattern: cells.get('pattern') ?? '',
        scope: cells.get('scope') ?? 'globally',
        ...(cells.has('p') ? { p: cells.get('p')! } : {}),
        ...(cells.has('q') ? { q: cells.get('q')! } : {}),
        ...(cells.has('r') ? { r: cells.get('r')! } : {}),
        ...(cells.has('s') ? { s: cells.get('s')! } : {}),
        ...(cells.has('n') ? { n: cells.get('n')! } : {}),
        source: 'model',
        carrier: model.qualifiedName(holder.id) || holder.id,
        ...(unknown.length > 0 ? { unknownFields: unknown } : {}),
      });
    }
  }
  return out;
}

/* ──────────────────────────── resolving a property ──────────────────────── */

/** A resolved property, or the refusal that stopped it. */
type ResolveResult =
  | { readonly ok: true; readonly property: ResolvedProperty }
  | { readonly ok: false; readonly refusal: AtomRefusal };

function malformed(detail: string): { ok: false; refusal: AtomRefusal } {
  return { ok: false, refusal: { code: MALFORMED_PROPERTY_CODE, detail, candidates: [] } };
}

/**
 * Resolve a written property against the machine.
 *
 * Every refusal here is `verification/malformed-property` or
 * `verification/unknown-atom`, and every one of them makes the property
 * INCONCLUSIVE rather than absent: a property nobody could read is not a
 * property that holds, and dropping it from the run would let a typo look like
 * a clean sweep.
 */
function resolveProperty(model: Model, machineId: ElementId, text: PropertyText): ResolveResult {
  if (text.unknownFields !== undefined && text.unknownFields.length > 0) {
    return malformed(
      `${text.unknownFields.map((f) => `\`${f}\``).join(', ')} ` +
        `${text.unknownFields.length === 1 ? 'is not a property field' : 'are not property fields'} — ` +
        `they are ${PROPERTY_FIELDS.join(', ')}. The carrier is refused rather than read without ` +
        'them: `scope` defaults, so a misspelled one would quietly become a different property and ' +
        'be decided as if somebody had written it.',
    );
  }
  const pattern = PATTERNS.find((p) => p.name === text.pattern);
  if (!pattern) {
    return malformed(
      `\`${text.pattern === '' ? '(none)' : text.pattern}\` is not a pattern in the catalogue — ` +
        `it holds ${PATTERNS.map((p) => `\`${p.name}\``).join(', ')}.`,
    );
  }
  const scope = SCOPES.find((s) => s.name === text.scope);
  if (!scope) {
    return malformed(
      `\`${text.scope === '' ? '(none)' : text.scope}\` is not a scope — ` +
        `they are ${SCOPES.map((s) => `\`${s.name}\``).join(', ')}.`,
    );
  }
  const atoms: { p?: Atom; q?: Atom; r?: Atom; s?: Atom } = {};
  const fields: readonly ('p' | 'q' | 'r' | 's')[] = [...pattern.fields, ...scope.fields];
  for (const field of fields) {
    const written = text[field];
    if (written === undefined || written.trim() === '') {
      return malformed(
        `\`${pattern.name}\` ${scope.fields.includes(field as 'q' | 'r') ? `over the \`${scope.name}\` scope ` : ''}` +
          `needs a \`${field}\` atom (${readingFor(pattern, scope)}), and the property states none.`,
      );
    }
    const read = readAtom(model, machineId, written);
    if (!read.ok) return { ok: false, refusal: read.refusal };
    atoms[field] = read.atom;
  }
  let count = 0;
  if (pattern.needsCount) {
    const raw = (text.n ?? '').trim();
    const parsed = Number(raw);
    if (raw === '' || !Number.isInteger(parsed) || parsed < 0) {
      return malformed(
        `\`bounded-existence\` needs an \`n\` — the number of times P may hold — and this ` +
          `property states ${raw === '' ? 'none' : `\`${raw}\``}. A bound nobody wrote is a bound ` +
          'nobody meant, so there is no default.',
      );
    }
    count = parsed;
  }
  return { ok: true, property: { text, pattern, scope, atoms, count } };
}

/**
 * The English reading of a pattern over a scope, with the atoms filled in.
 *
 * ONE PASS, NOT FIVE. The placeholders are single letters, and an atom's own
 * text may contain one: `state N`, `state P`, a guard expression over a feature
 * called `R`. Substituting them one letter at a time re-scans text that was
 * just written in, so `absence of state N` came out as "`state 0` never holds"
 * — a verdict, and a `verification/refuted` message, naming a state the model
 * does not have. A single alternation with a replacer function never looks at
 * its own output.
 */
function readingFor(pattern: PatternSpec, scope: ScopeSpec, atoms?: ResolvedProperty['atoms'], n = 0): string {
  const fill = (letter: string, atom: Atom | undefined): string =>
    atom ? `\`${atom.text}\`` : letter;
  const body = pattern.reading.replace(/\b[PSN]\b/g, (letter) =>
    letter === 'P' ? fill('P', atoms?.p) : letter === 'S' ? fill('S', atoms?.s) : String(n),
  );
  const where = scope.reading.replace(/\b[QR]\b/g, (letter) =>
    letter === 'Q' ? fill('Q', atoms?.q) : fill('R', atoms?.r),
  );
  return `${body}, ${where}`;
}

/* ─────────────────────────────── the monitor ────────────────────────────── */

/**
 * The valuation of one observation: which of the property's atoms hold there.
 *
 * `undefined` for an atom the property does not use. An atom that could not be
 * evaluated does not reach here — it becomes a refusal at the call site, which
 * is the fail direction `./atoms` states.
 */
interface Valuation {
  p?: boolean;
  q?: boolean;
  r?: boolean;
  s?: boolean;
}

/**
 * What a monitor remembers between observations.
 *
 * It is a DFA state, and it is part of the search key: two visits to one
 * configuration with different monitor states are different futures, and
 * merging them would let a run that had already seen Q inherit the answer of
 * one that had not.
 */
interface Monitor {
  /** Is a scope segment open here? */
  readonly open: boolean;
  /** Has a segment ever opened on this run? — the vacuity question. */
  readonly activated: boolean;
  /** Has a segment CLOSED on this run? `before` and `between` need it. */
  readonly closed: boolean;
  /** OCCURRENCES of P in the current segment, saturating at the bound + 1. */
  readonly count: number;
  /**
   * Did P hold at the PREVIOUS observation of this segment?
   *
   * `bounded-existence` counts occurrences of P and not configurations at which
   * P holds, which are different numbers the moment a P persists: a composite
   * state entered once is on the active stack at every observation until it is
   * left, and counting each of those would refute "P holds at most once" about
   * a machine that enters it exactly once. Dwyer's at-most-N formula —
   * `!P W (P W (!P W (P W []!P)))` for N = 2 — counts the maximal intervals in
   * which P holds, so this bit is what turns the count into a RISING EDGE.
   */
  readonly pHeld: boolean;
  /** Has S held in the current segment? — `precedence`. */
  readonly sSeen: boolean;
  /** Has P held in an open segment at all? — precedence's own antecedent. */
  readonly pSeen: boolean;
  /** A violation is established once the segment's closing condition is met. */
  readonly pending: boolean;
  /** Established: this run breaks the property. */
  readonly violated: boolean;
}

const OPENING: Monitor = {
  open: false,
  activated: false,
  closed: false,
  count: 0,
  pHeld: false,
  sSeen: false,
  pSeen: false,
  pending: false,
  violated: false,
};

/** A process-local key for a monitor state — the second half of the search key. */
function monitorKey(m: Monitor): string {
  return `${m.open ? 1 : 0}${m.activated ? 1 : 0}${m.closed ? 1 : 0}${m.count}${m.pHeld ? 1 : 0}${m.sSeen ? 1 : 0}${m.pSeen ? 1 : 0}${m.pending ? 1 : 0}${m.violated ? 1 : 0}`;
}

/**
 * One step of the monitor: fold one observation's valuation into the state.
 *
 * THE ORDER OF THE THREE HALVES IS THE SEMANTICS, and each is Dwyer's rather
 * than a convenience:
 *
 *  - **Closing first.** `!P U R` asks P to be false at every observation
 *    STRICTLY BEFORE the first R, so at the R itself P is allowed. Checking P
 *    first would report a violation at the very observation that ends the
 *    scope.
 *  - **Then S, then P**, for the same reason on `precedence`: `!P U S` allows P
 *    at the observation where S first holds.
 *  - **Opening last, inclusive, and NOT where the closing atom also holds.**
 *    `after Q` is `[](Q -> [](…))`, which puts the Q observation itself inside
 *    the scope — so a P at the Q is inside it. The opening is applied after the
 *    closing so that a `between` segment which ends at this observation is shut
 *    before the test that would re-open it. And the two two-atom scopes carry
 *    Dwyer's `Q & !R` conjunct — `[]((Q & !R & <>R) -> (!P U R))` for `between`
 *    and `[]((Q & !R) -> (!P W R))` for `after … until` — so an observation
 *    where Q and R hold TOGETHER opens nothing at all. Without that conjunct a
 *    machine whose Q always coincides with its R (a composite state and the
 *    substate its entry cascades into, say, or a trigger and the state it lands
 *    in) would open a segment the property never opened, and the run that
 *    followed would be printed as a `fail` refuting nothing.
 */
function monitorStep(p: ResolvedProperty, m: Monitor, v: Valuation): Monitor {
  if (m.violated) return m;
  const { pending } = m;
  let { open, activated, closed, count, pHeld, sSeen, pSeen } = m;
  const scope = p.scope.name;

  // `before R` IS OPEN FROM THE OPENING CONFIGURATION, and saying so here
  // rather than in the opening block below is what makes an R at that very
  // first observation close a scope that was already running. Without it the
  // closing test — which asks whether a segment is open — would find none on
  // the first observation, the scope would open AFTER the R that should have
  // ended it, and `absence of P before R` on a machine whose opening state IS
  // the R would check P over a segment the property says is empty.
  if (scope === 'before' && !closed) open = true;

  // ── closing ──
  if (open && v.r === true && (scope === 'before' || scope === 'between' || scope === 'after-until')) {
    open = false;
    closed = true;
    // THE ANTECEDENT OF `before` AND `between` IS THE CLOSING ATOM, not the
    // opening one. "P is absent before R" is `<>R -> (!P U R)`: on a run where
    // R never happens the property is true and says nothing, so the scope
    // counts as OPENED for the vacuity question only once an R has closed it.
    if (scope === 'before' || scope === 'between') activated = true;
    if (pending) return { ...m, open, activated, closed, pending: false, violated: true };
    // A `between` segment that closes takes its per-segment counters with it,
    // `pHeld` among them: the next segment's first P is a new occurrence.
    count = 0;
    pHeld = false;
    sSeen = false;
  }

  // ── opening ──
  if (!open) {
    if (scope === 'globally') {
      open = true;
      activated = true;
    } else if (scope === 'before') {
      // Open from the start, and once closed it never re-opens: there is only
      // one "before the first R". `activated` is NOT set here — see above.
      open = !closed;
    } else if (v.q === true && !(v.r === true && (scope === 'between' || scope === 'after-until'))) {
      // DWYER'S `Q & !R`, and it is the whole reason this test is not just
      // `v.q === true`. Both two-atom scopes are written over `Q & !R`, so an
      // observation at which the closing atom holds as well opens no segment:
      // there is nothing between a Q and an R that are the same observation.
      // `after Q` has no R to conflict with and is unaffected.
      open = true;
      count = 0;
      pHeld = false;
      sSeen = false;
      // `after` and `after-until` have no closing requirement, so reaching Q is
      // the whole antecedent.
      if (scope === 'after' || scope === 'after-until') activated = true;
    }
  }
  if (!open) {
    return { open, activated, closed, count, pHeld: false, sSeen, pSeen, pending, violated: false };
  }

  // ── the pattern, inside an open segment ──
  if (v.s === true) sSeen = true;
  if (v.p === true) pSeen = true;
  let breach = false;
  switch (p.pattern.name) {
    case 'absence':
    case 'cover':
      // BYTE-FOR-BYTE THE SAME BREACH. `cover` is `absence` read the other way
      // round: the "bad prefix" of `absence of P` is exactly the witness of
      // `cover P`, so the monitor is shared and only the verdict tail in
      // `checkProperty` reads the breach differently. Listed explicitly rather
      // than left to `default` so a new pattern cannot fall through this switch
      // into a silent "no breach".
      breach = v.p === true;
      break;
    case 'universality':
      breach = v.p !== true;
      break;
    case 'bounded-existence':
      // A RISING EDGE, not an observation. `p.count` bounds the number of times
      // P OCCURS, and a P that persists across a run of configurations occurred
      // once — see {@link Monitor.pHeld}.
      if (v.p === true && !pHeld) count = Math.min(count + 1, p.count + 1);
      breach = count > p.count;
      break;
    case 'precedence':
      breach = v.p === true && !sSeen;
      break;
    default:
      // The liveness patterns never reach here: `checkProperty` answers them
      // before a walk starts. Left explicit so a new pattern cannot fall
      // through this switch into a silent "no breach".
      breach = false;
  }

  if (!breach) {
    return { open, activated, closed, count, pHeld: v.p === true, sSeen, pSeen, pending, violated: false };
  }
  // `before` and `between` need the segment to CLOSE before the breach counts:
  // on a run where R never comes, there is nothing to violate. `globally`,
  // `after` and `after-until` establish it on the spot.
  const needsClosing = scope === 'before' || scope === 'between';
  return {
    open,
    activated,
    closed,
    count,
    pHeld: v.p === true,
    sSeen,
    pSeen,
    pending: needsClosing,
    violated: !needsClosing,
  };
}

/* ────────────────────────────── the search ──────────────────────────────── */

/** One node of the product search: a configuration, a monitor, and how we got here. */
interface ProductNode {
  readonly config: MachineConfig;
  readonly monitor: Monitor;
  readonly depth: number;
  /** Consecutive completion steps taken to reach here — the chase budget. */
  readonly completionRun: number;
  readonly parent: ProductNode | null;
  readonly input: StepInput | null;
  readonly transition: ElementRecord | null;
  /** Which of the property's atoms hold here, for the trace. */
  readonly holds: readonly string[];
}

/** What the product search came to. */
interface SearchResult {
  readonly violation: ProductNode | null;
  readonly activated: boolean;
  readonly pSeen: boolean;
  readonly configs: number;
  readonly boundHit: BoundHit;
  /** Set when an atom could not be evaluated where the walk offered it. */
  readonly refusal: AtomRefusal | null;
}

/** The valuation of one observation, or the refusal that stopped the walk. */
function valuationOf(
  model: Model,
  property: ResolvedProperty,
  obs: Observation,
): { ok: true; value: Valuation; holds: string[] } | { ok: false; refusal: AtomRefusal } {
  const value: Valuation = {};
  const holds: string[] = [];
  for (const field of ['p', 'q', 'r', 's'] as const) {
    const atom = property.atoms[field];
    if (!atom) continue;
    const held = atomHolds(model, atom, obs);
    if (held === undefined) return { ok: false, refusal: expressionRefusal(model, atom, obs) };
    value[field] = held;
    if (held) holds.push(field);
  }
  return { ok: true, value, holds };
}

/**
 * Breadth-first search of the product of the configuration graph and the
 * monitor, stopping at the first established violation.
 *
 * BREADTH-FIRST so the witness is the SHORTEST run that breaks the property. A
 * depth-first search would find a violation just as reliably and print a
 * hundred-step trace where a three-step one exists, and a witness nobody reads
 * is a witness that does not refute anything to the person holding it.
 *
 * The successor rule is `exploreMachine`'s, exactly: every transition enabled
 * at the INNERMOST active level, which is the set the interpreter's
 * declaration-order tie-break picks one from. Crossing the priority rule would
 * produce configurations no run of this semantics enters, and a "witness" drawn
 * from one would be a trace the model does not admit.
 */
function search(
  model: Model,
  machineId: ElementId,
  property: ResolvedProperty,
  bounds: ExploreBounds,
): SearchResult {
  const inputs: StepInput[] = [
    { kind: 'completion' },
    ...bounds.alphabet.map((trigger): StepInput => ({ kind: 'trigger', trigger })),
  ];
  const seeded = new Map<string, unknown>();
  const machineEl = model.get(machineId);
  if (machineEl) seedStore(model, machineEl, seeded);
  const opening = initialConfig(model, machineId, { store: seeded });
  const first = valuationOf(model, property, {
    config: opening.config,
    input: null,
    transition: null,
  });
  if (!first.ok) {
    return {
      violation: null,
      activated: false,
      pSeen: false,
      configs: 0,
      boundHit: 'none',
      refusal: first.refusal,
    };
  }
  const root: ProductNode = {
    config: opening.config,
    monitor: monitorStep(property, OPENING, first.value),
    depth: 0,
    completionRun: 0,
    parent: null,
    input: null,
    transition: null,
    holds: first.holds,
  };
  let activated = root.monitor.activated;
  let pSeen = root.monitor.pSeen;
  if (root.monitor.violated) {
    return { violation: root, activated, pSeen, configs: 1, boundHit: 'none', refusal: null };
  }

  const seen = new Set<string>([`${hashConfig(root.config)}|${monitorKey(root.monitor)}`]);
  const queue: ProductNode[] = [root];
  let boundHit: BoundHit = 'none';

  while (queue.length > 0) {
    const here = queue.shift()!;
    for (const input of inputs) {
      const enabled = enabledTransitions(model, here.config, input);
      if (enabled.length === 0) continue;
      const innermost = enabled[0].level;
      for (const choice of enabled) {
        if (choice.level !== innermost) continue;
        const next = stepConfig(model, here.config, choice);
        const obs: Observation = {
          config: next.config,
          input,
          transition: choice.transition,
        };
        const valued = valuationOf(model, property, obs);
        if (!valued.ok) {
          return {
            violation: null,
            activated,
            pSeen,
            configs: seen.size,
            boundHit,
            refusal: valued.refusal,
          };
        }
        const monitor = monitorStep(property, here.monitor, valued.value);
        activated = activated || monitor.activated;
        pSeen = pSeen || monitor.pSeen;
        const node: ProductNode = {
          config: next.config,
          monitor,
          depth: here.depth + 1,
          completionRun: input.kind === 'completion' ? here.completionRun + 1 : 0,
          parent: here,
          input,
          transition: choice.transition,
          holds: valued.holds,
        };
        if (monitor.violated) {
          return {
            violation: node,
            activated,
            pSeen,
            configs: seen.size,
            boundHit,
            refusal: null,
          };
        }
        const key = `${hashConfig(next.config)}|${monitorKey(monitor)}`;
        if (seen.has(key)) continue;
        // The three bounds, in `exploreMachine`'s own order and with its own
        // `>` on the chase budget: a configuration reached in exactly
        // `maxCompletion` completion steps is one the interpreter reaches
        // cleanly, and refusing it would report a chain that is not too long as
        // one that is.
        if (node.completionRun > bounds.maxCompletion) {
          boundHit = 'completion';
          continue;
        }
        if (node.depth > bounds.maxDepth) {
          boundHit = 'depth';
          continue;
        }
        if (seen.size >= bounds.maxConfigs) {
          boundHit = 'configs';
          continue;
        }
        seen.add(key);
        queue.push(node);
      }
    }
  }
  return { violation: null, activated, pSeen, configs: seen.size, boundHit, refusal: null };
}

/* ─────────────────────────── rows and rendering ─────────────────────────── */

function stateRef(model: Model, id: ElementId): StateRef {
  const el = model.get(id);
  return {
    id,
    name: el?.declaredName ?? '',
    qualifiedName: model.qualifiedName(id) || id,
  };
}

function transitionRef(model: Model, tr: ElementRecord): TransitionRef {
  const from = tr.source?.[0];
  const to = tr.target?.[0];
  return {
    id: tr.id,
    name: tr.declaredName ?? '',
    qualifiedName: model.qualifiedName(tr.id) || tr.id,
    from: from ? stateRef(model, from) : null,
    to: to ? stateRef(model, to) : null,
    // `triggerLabelOf`, not `attrs.trigger`: a completion transition has no
    // label at all and a machine of them must never be shown one it does not
    // have — the same rule `./explore` states for `reach`.
    label: triggerLabelOf(tr),
  };
}

/** The witness run, opening configuration first. */
function traceOf(model: Model, leaf: ProductNode): TraceStep[] {
  const chain: ProductNode[] = [];
  for (let n: ProductNode | null = leaf; n !== null; n = n.parent) chain.unshift(n);
  return chain.map((n, index) => {
    const active = leafOf(n.config);
    return {
      index,
      event: n.input === null ? '-' : n.input.kind === 'trigger' ? n.input.trigger : '',
      transition: n.transition ? transitionRef(model, n.transition) : null,
      leaf: active === null ? null : stateRef(model, active),
      stack: n.config.stack.map((s) => stateRef(model, s)),
      holds: n.holds,
    };
  });
}

/** Why a walk stopped, in the words the report prints. */
function boundSentence(hit: BoundHit): string {
  switch (hit) {
    case 'configs':
      return 'the configuration bound was reached';
    case 'depth':
      return 'the depth bound was reached';
    case 'completion':
      return `a completion chain longer than the ${MAX_COMPLETION}-step chase budget was found`;
    default:
      return '';
  }
}

/** The row a refused property produces: inconclusive, with the reason. */
function refusedRow(
  machine: StateRef & { eClass: string },
  text: PropertyText,
  refusal: AtomRefusal,
  bounds: ExploreBounds,
): PropertyVerdict {
  return {
    machine,
    property: text,
    pattern: null,
    patternClass: null,
    scope: null,
    sentence: `${text.pattern || '(no pattern)'} — not read`,
    claim: 'inconclusive',
    code: refusal.code,
    detail: refusal.detail,
    activated: false,
    bounds,
    configs: 0,
    machineConfigs: 0,
    exhaustive: false,
    boundHit: 'none',
    qualification: 'nothing was checked: the property could not be read',
    unsupported: [],
    witness: [],
    modality: null,
  };
}

/* ──────────────────────────── the one property ──────────────────────────── */

/**
 * Decide one property against one machine (plan §3.8).
 *
 * The order of the refusals is the order of what is knowable. A property that
 * cannot be READ is refused before a walk is paid for; a LIVENESS property is
 * refused before one too, because no length of walk would change the answer; a
 * machine with an unsupported construct is refused because it was never walked
 * at all. Only then is a bad-prefix search run, and only a search that found no
 * prefix over a graph seen WHOLE may return a pass.
 */
export function checkProperty(
  model: Model,
  machineId: ElementId,
  text: PropertyText,
  opts: ExploreOptions = {},
): PropertyVerdict {
  const machineEl = model.get(machineId);
  const machine: StateRef & { eClass: string } = {
    ...stateRef(model, machineId),
    eClass: machineEl?.eClass ?? '',
  };
  const bounds: ExploreBounds = {
    maxConfigs: Math.max(1, opts.maxConfigs ?? DEFAULT_MAX_CONFIGS),
    maxDepth: Math.max(0, opts.maxDepth ?? DEFAULT_MAX_DEPTH),
    maxCompletion: Math.max(0, opts.maxCompletion ?? MAX_COMPLETION),
    alphabet: machineAlphabet(model, machineId),
  };

  const resolved = resolveProperty(model, machineId, text);
  if (!resolved.ok) return refusedRow(machine, text, resolved.refusal, bounds);
  const property = resolved.property;
  const sentence = readingFor(property.pattern, property.scope, property.atoms, property.count);
  const row = {
    machine,
    property: text,
    pattern: property.pattern.name,
    patternClass: property.pattern.kind,
    scope: property.scope.name,
    sentence,
    bounds,
  };

  // LIVENESS, refused before a walk. A bad-prefix search returns no bad prefix
  // for `existence` or `response` on ANY graph, so a walk would answer "no
  // violation found" every time and a pass drawn from that would be the
  // strongest verdict this command has, printed for the two properties it
  // cannot decide.
  if (property.pattern.kind === 'liveness') {
    return {
      ...row,
      claim: 'inconclusive',
      // THE BEHAVIOUR LANE'S OWN CODE, and not the SMT lane's
      // `verification/unsupported-construct`. That code's published entry says
      // it is one of the two `--allow-inconclusive` may lower to exit 0 and
      // sends the reader to `obligations --missing`; filing a liveness refusal
      // under it would print, in the catalogue a reader checks, that the one
      // row this command must never lower is lowerable.
      code: BEHAVIOUR_UNSUPPORTED_CODE,
      detail:
        `inconclusive: liveness not checked in-process. \`${property.pattern.name}\` is violated ` +
        'only by an infinite run that never delivers what it promised, and this engine searches ' +
        'for finite bad prefixes — of which such a run has none. It stays inconclusive until a ' +
        'lasso search lands and a fairness assumption is named; there is no flag that lowers it.',
      activated: false,
      configs: 0,
      machineConfigs: 0,
      exhaustive: false,
      boundHit: 'none',
      qualification: 'not decided: this engine decides safety and guarantee patterns only',
      unsupported: [],
      witness: [],
      modality: null,
    };
  }

  // The one authority on whether the graph was seen whole. It also owns the
  // unsupported-construct refusal, which is why it is asked first: a machine
  // this engine does not explore has no answer, not a partial one.
  const walk = exploreMachine(model, machineId, opts);
  if (walk.unsupported.length > 0) {
    return {
      ...row,
      claim: 'inconclusive',
      code: BEHAVIOUR_UNSUPPORTED_CODE,
      detail:
        `the machine was not walked: ${walk.unsupported.map((u) => u.detail).join(' ')} ` +
        'Nothing about this property is claimed — an unexplored graph holds no bad prefix and no ' +
        'absence of one.',
      activated: false,
      configs: 0,
      machineConfigs: 0,
      exhaustive: false,
      boundHit: walk.boundHit,
      qualification: `not explored — ${walk.unsupported.map((u) => u.construct).join(', ')}`,
      unsupported: walk.unsupported,
      witness: [],
      modality: null,
    };
  }
  // The FIFTH condition, and it is `reachOne`'s: a guard the walk consulted and
  // could not evaluate is not a guard that is false. A property no bad prefix
  // violated over a graph some of whose edges were never decided is
  // inconclusive, not a pass — the withheld edge is exactly the one that might
  // have led to the violation. Read from the SAME `exploreMachine` result the
  // other four are read from, so the two commands cannot drift on it: `reach`
  // withholding its absence lists while this one wrote `pass` and `exhaustive`
  // over the same machine was the tool contradicting itself on one file.
  const guardsDecided = walk.undeterminedGuards.length === 0;
  // THE THIRD DISPATCH ARM, AND ITS POSITION IS THE SPECIFICATION (plan §3.2b).
  // `recovery` is branching-time — `AG EF p` — and the search below is a
  // bad-prefix search, which finds no bad prefix for it on ANY graph and would
  // return `pass` for free. So the arm sits here and nowhere else: AFTER the
  // unsupported refusal above, which is the only enforcement point on this
  // function for the `unsupported` conjunct of `seenWhole`, and BEFORE the
  // search, which must never run for it. The walk exists here; two lines
  // higher it would not.
  if (property.pattern.kind === 'branching') return recoveryRow(model, walk, property, row, bounds);
  const found = search(model, machineId, property, bounds);
  // ONE DEFINITION, in `./publishable`, and this is the reader that adds the
  // product-search conjunct: `found.boundHit === 'none'` becomes
  // `Publishability.searchComplete`, which is a field only a claim that ran a
  // search HAS — a walk-only claim gets no value there rather than `false`,
  // which would print "bound exhausted" about a bound nobody hit. The
  // `unsupported` conjunct the predicate also carries is vacuous by the time
  // control reaches here: the early return above already refused the machine.
  const exhaustive = publishabilityOf(walk, found).decreasingOk;
  const boundHit = found.boundHit !== 'none' ? found.boundHit : walk.boundHit;
  const qualification = exhaustive
    ? `exhaustive under ${boundsSentence(bounds)}`
    : !guardsDecided
      ? // Neither `exhaustive` nor `partial`: the walk FINISHED, so "partial"
        // would be false too, and either word answers a question this row
        // declined. Same sentence `reachOne` prints, for the same reason.
        `undetermined under ${boundsSentence(bounds)} — ${walk.undeterminedGuards.length} guard(s) the walk could not evaluate${
          boundHit === 'none' ? '' : `, and ${boundSentence(boundHit)}`
        }`
      : `partial under ${boundsSentence(bounds)} — ${
          boundHit === 'none'
            ? 'a trigger the machine names was never offered'
            : boundSentence(boundHit)
        }`;
  const isCover = property.pattern.name === 'cover';
  const base = {
    ...row,
    configs: found.configs,
    machineConfigs: walk.configs,
    exhaustive,
    boundHit,
    qualification,
    unsupported: [] as readonly UnsupportedConstruct[],
    activated: found.activated,
    // The modality is a fact about a REFUTATION and about nothing else; the
    // `fail` return below overrides this, and every other claim keeps it.
    modality: null as Modality | null,
    // The census rides on EVERY cover row that reached the walk, the
    // guard-undetermined one included: correction 23's number is most useful
    // exactly where the row is withheld.
    ...(isCover ? { cover: coverCensus(model, machineId, walk, property) } : {}),
  };

  // An atom that could not be evaluated where the walk offered it. Never read
  // as `false`: `absence of `mode == 3`` would then PASS on a machine whose
  // store has no `mode` at all.
  if (found.refusal !== null) {
    return {
      ...base,
      claim: 'inconclusive',
      code: found.refusal.code,
      detail: found.refusal.detail,
      // NOT `base`'s figures. The walk stopped at the observation the atom
      // could not be read on, so it decided nothing — and a row that decided
      // nothing must not publish `exhaustive`, for `refusedRow`'s reason.
      exhaustive: false,
      qualification: 'nothing was decided: an atom could not be evaluated where the walk offered it',
      witness: [],
    };
  }

  // A VIOLATION STANDS ON A PARTIAL WALK. The witness is a run this semantics
  // admits, so a bound that stopped the search elsewhere takes nothing away
  // from it. The asymmetry is deliberate: a bound can hide a violation and can
  // never invent one.
  if (found.violation !== null) {
    const witness = traceOf(model, found.violation);
    // The search RETURNED at the first violation, so `configs` counts the
    // product states seen up to the witness and is not the size of the
    // product space. `exhaustive` is still true of the machine graph — that
    // is `exploreMachine`'s figure — and printing the two side by side under
    // one word invited the count to be read as the second.
    const witnessQualification = `${qualification} — the count beside it is the product states seen up to the witness, not the size of the product space`;
    // THE FIRST FORK: `cover`'s breach is a WITNESS, not a refutation. Routing
    // it through the `fail` return below would print `verification/refuted`
    // and exit 1 about a design that does what its author asked — the polarity
    // defect this pattern exists to fix. The claim is `covered`, the code is
    // none, and the warrant is `coverWarrant`'s: register row W1.
    if (isCover) {
      return {
        ...base,
        qualification: witnessQualification,
        claim: 'covered',
        code: null,
        detail: coverWarrant(model, walk, bounds, found.violation, witness.length - 1, sentence),
        witness,
      };
    }
    return {
      ...base,
      qualification: witnessQualification,
      claim: 'fail',
      code: 'verification/refuted',
      detail:
        `fail — witness trace of ${witness.length - 1} step(s): ${sentence}. The run below is one ` +
        'this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      witness,
      // Some run, or every run? Composed here and nowhere else, from the walk
      // the function opened with and never from `found` — the prefix walked
      // before the first witness is an accident of where the search stopped.
      modality: modalityOf(model, property, walk, bounds),
    };
  }

  // A PASS NEEDS THE WHOLE GRAPH, AND SO DOES A VACUITY. Everything above this
  // line stands on a partial walk — a violation is a run this semantics admits
  // whatever else went unexplored. Nothing below it does, and vacuity is on
  // this side of the line for the reason a pass is: "no explored run opens the
  // scope" is a claim of ABSENCE, and a walk that stopped at a bound has not
  // established one. Reporting it as `vacuous` printed "its antecedent is never
  // met" about an antecedent the walk simply had not reached yet, and
  // `--strict-vacuity` filed that as an error against a model that was fine.
  // ...AND A GUARD THE WALK COULD NOT EVALUATE TAKES BOTH AWAY, for the reason a
  // bound does and one a bound does not: the graph this search ran over is
  // missing an edge nothing decided, so "no bad prefix" and "no run opened the
  // scope" are both absences it did not establish. Ahead of the bound branch
  // because the two are fixed differently — this one in the model, that one with
  // `--max-configs` — and a reader given the wrong sentence raises the wrong
  // thing. `--allow-inconclusive` is scoped to `verification/timeout` and
  // `verification/unsupported-construct`, so this row keeps exit 2.
  if (!guardsDecided) {
    const g = walk.undeterminedGuards[0];
    return {
      ...base,
      claim: 'inconclusive',
      code: GUARD_UNDETERMINED_CODE,
      detail:
        `inconclusive: ${walk.undeterminedGuards.length} guard(s) on this machine could not be ` +
        `evaluated — the first is \`${g.guard}\`${
          g.unresolved.length > 0
            ? ` (no value is in scope for ${g.unresolved.map((n) => `\`${n}\``).join(', ')})`
            : ' (it did not evaluate to a value)'
        }. The walk did not decide whether those transitions are enabled, so this ` +
        'property was searched over a graph missing an edge that may well be there — and one of ' +
        // NAMES THE TWO LISTS THAT GO WALK-WISE, and no longer the third. A
        // no-way-out row is withheld per configuration (register row A0), so a
        // machine can publish one of them while this command reports the whole
        // property inconclusive — and this sentence, which is about the SAME
        // machine and is the one place the two commands speak about each other,
        // must not describe `reach` as withholding a row `reach` prints.
        'the runs it hides is exactly where a bad prefix would be. This is NOT a pass: `reach` on ' +
        'the same machine withholds its unreachable and dead lists for the same reason.',
      witness: [],
    };
  }
  if (!exhaustive) {
    return {
      ...base,
      claim: 'inconclusive',
      code: BOUND_EXHAUSTED_CODE,
      // `not-covered` is register row A5, a decreasing absence: it is withheld
      // here exactly where `pass` is, and this row says which claim went.
      detail: isCover
        ? `inconclusive: bound exhausted — the not-covered claim is not made. No witness was found and the walk did not finish — ${boundSentence(boundHit) || 'a trigger the machine names was never offered'}. ` +
          'A missing witness in part of a graph is not a missing behaviour. Raise the bound (`--max-configs N`) and re-run.'
        : `inconclusive: ${found.activated ? 'no bad prefix was found' : "no explored run opened the property's scope"}, and the walk did not finish — ${boundSentence(boundHit) || 'a trigger the machine names was never offered'}. ` +
          'The absence of a violation in part of a graph is not the absence of one, and neither is ' +
          'the absence of an antecedent. Raise the bound (`--max-configs N`) and re-run.',
      witness: [],
    };
  }

  // VACUITY, in the two forms this engine detects. Both are antecedents that
  // never hold, and neither is a pass: a property whose scope no run opens says
  // nothing, and `precedence` over a P that never happens is true of every
  // machine. Sub-formula-replacement vacuity is NOT done (§6), and the row says
  // which two were checked rather than implying a general vacuity check.
  if (!found.activated) {
    return {
      ...base,
      claim: 'vacuous',
      code: null,
      detail:
        `vacuous: no explored run opens the \`${property.scope.name}\` scope — its antecedent ` +
        `(${property.scope.antecedent.map((f) => `\`${property.atoms[f]!.text}\``).join(', ')}) is ` +
        'never met, so the property is true of this machine for a reason that has nothing to do ' +
        'with it. It is inconclusive and exits 2; `--strict-vacuity` raises it to an error and ' +
        'changes no exit code.',
      witness: [],
    };
  }
  if (property.pattern.name === 'precedence' && !found.pSeen) {
    return {
      ...base,
      claim: 'vacuous',
      code: null,
      detail:
        `vacuous: \`${property.atoms.p!.text}\` holds on no explored run, so "${sentence}" is ` +
        'true of this machine without S ever being reached. It is inconclusive and exits 2; ' +
        '`--strict-vacuity` raises it to an error and changes no exit code.',
      witness: [],
    };
  }

  // THE SECOND FORK: no breach over a graph seen whole is `pass` for an
  // assertion and `not-covered` for a cover — a DECIDED absence (register row
  // A5, read off `decreasingOk` like every other decreasing claim), which is a
  // missing behaviour and not a violated requirement. It carries a code and
  // exits 2; `--cover-required` spends the 1 for it and changes no word here.
  // The count it quotes is `machineConfigs`, never `found.configs` (§2.4b).
  if (isCover) {
    return {
      ...base,
      claim: 'not-covered',
      code: NOT_COVERED_CODE,
      detail:
        `not covered under ${boundsSentence(bounds)} — over ${walk.configs} configuration(s): ` +
        `${sentence} — and no explored run holds \`${property.atoms.p!.text}\` inside an open ` +
        'scope segment. A decided absence: the design as written admits no such run within these ' +
        'bounds. It is a missing behaviour and not a violated requirement, so it exits 2; ' +
        '`--cover-required` spends the 1 for it instead.',
      witness: [],
    };
  }

  return {
    ...base,
    claim: 'pass',
    code: null,
    detail:
      `pass — holds on every reachable configuration: ${sentence}. ${qualification}, over ` +
      `${found.configs} product state(s).`,
    witness: [],
  };
}

/* ─────────────────────────────── the modality ───────────────────────────── */

/**
 * The reason a store-valued atom is refused, spelled ONCE for two readers:
 * §3.R's row 4 (`modalityOf`, as `not decided: …`) and §3.2b's atom-kind gate
 * (`recoveryRow`, as a `verification/malformed-property` refusal). Exported so
 * the two sections cannot drift back apart — the draft plan had them stating
 * opposite gates for one restriction.
 */
export const STORE_ATOM_REASON = 'this atom reads the store, which this walk does not retain';

/**
 * The reason a step-valued atom is refused by `recovery`: `trigger` and `fires`
 * hold on a STEP (`atomHolds` reads `obs.input` and `obs.transition`), and a
 * configuration graph has no steps to select target nodes from. Ungated, the
 * target set would be empty and the row would publish a refutation — exit 1,
 * `verification/refuted` — about a well-formed model on the strength of an atom
 * kind the engine cannot observe, which is the one path in the plan where a
 * tool limitation would earn a refutation (§3.2b MUST-NEVER).
 */
export const STEP_ATOM_REASON =
  'a trigger is observed on a step, not at a configuration, so `recovery` has no target set to reverse from';


/**
 * The seven `not decided` sentences of plan §3.R, rows 1–7, spelled once.
 *
 * Rows 1, 5, 6 and 7 are the clauses of `walkIsExact` as four sentences rather
 * than one, because an author whose machine names `abort` and one whose
 * machine guards on something the walk could not read have two different
 * things to do about it, and *"this walk is not exact"* would tell neither
 * which. Row 7 says *a condition the walk could not decide* and not *an
 * attribute with no declared value*: the store clause is the SHIPPED
 * `undeterminedGuards` predicate, which also covers `not mode` over a fully
 * valued `mode` (`trapguard-typed.sysml`), and the narrower sentence would be
 * false on the one corpus model that tells the two readings apart.
 */
const NOT_DECIDED = {
  walk: 'not decided: the walk was not exhaustive',
  step: 'not decided: this atom is a property of a step, not of a configuration, so the product does not collapse onto the configuration graph',
  store: `not decided: ${STORE_ATOM_REASON}`,
  environment:
    'not decided: this machine names triggers, and "every run" would be a claim about an environment this walk has no carrier for',
  time: 'not decided: this machine carries `after(n)` dwell transitions this walk takes without advancing a clock, so a run that avoids the violation may be one the interpreter never takes',
  guard:
    'not decided: a transition of this machine is guarded by a condition the walk consulted and could not decide, so this walk never offered an edge the model states and a run that avoids the violation may be one it could not see',
} as const;

/** Row 9's sentence: the absence claim, register row A8. */
const GUARANTEED_SENTENCE = 'guaranteed — every maximal run of this machine reaches it';

/**
 * The configurations of *G₀*: reachable from the opening WITHIN the
 * non-violating subgraph, in breadth-first order.
 *
 * SEEDED FROM NODE 0 AND NOWHERE ELSE, and empty when the opening itself
 * violates — `absence (state standby)` on a machine that opens in `standby`
 * is refuted at step 0 and every run violates. Reachability is taken INSIDE
 * *G*: a cycle entered only by passing through a violating configuration is
 * a cycle no violation-avoiding run reaches, and naming it would be a sentence
 * about a run that does not exist.
 */
function avoidingReach(
  successors: readonly (readonly number[])[],
  violates: (node: number) => boolean,
): number[] {
  if (successors.length === 0 || violates(0)) return [];
  const seen = new Uint8Array(successors.length);
  const order: number[] = [0];
  seen[0] = 1;
  for (let head = 0; head < order.length; head++) {
    for (const w of successors[order[head]]) {
      if (seen[w] === 1 || violates(w)) continue;
      seen[w] = 1;
      order.push(w);
    }
  }
  return order;
}

/**
 * One cycle of the first cyclic component of a relation, as a closed walk.
 *
 * The component chosen is the one whose smallest member is smallest — the
 * closest to the opening in discovery order, which is what a reader is most
 * likely to be able to follow — and the cycle is the SHORTEST one through that
 * member, found breadth-first inside the component and closed back on it. A
 * self-loop is a cycle of one node and prints as `hazard → hazard`.
 * Returns `null` when the relation has no cycle at all.
 */
function exhibitCycle(
  successors: readonly (readonly number[])[],
  comps: Components,
): number[] | null {
  let start = -1;
  let member: number[] | null = null;
  for (const members of comps.members) {
    const cyclic =
      members.length > 1 || (successors[members[0]] ?? []).includes(members[0]);
    if (!cyclic) continue;
    if (start === -1 || members[0] < start) {
      start = members[0];
      member = [...members];
    }
  }
  if (member === null) return null;
  const inside = new Set(member);
  const parent = new Map<number, number>([[start, -1]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    for (const w of successors[v] ?? []) {
      if (!inside.has(w)) continue;
      if (w === start) {
        // Closed: walk the parents back from `v` to `start`, then repeat `start`.
        const path: number[] = [];
        for (let n = v; n !== -1; n = parent.get(n)!) path.unshift(n);
        path.push(start);
        return path;
      }
      if (parent.has(w)) continue;
      parent.set(w, v);
      queue.push(w);
    }
  }
  // Unreachable: a cyclic component holds a closed walk through every member.
  return null;
}

/**
 * Some run, or every run? — the guaranteed / potential modality on a `fail`
 * (plan §3.R). THE ONE PRODUCER OF BOTH VALUES, and the dispatch is the plan's
 * nine rows in their stated order, because the precedence is part of the
 * specification: a machine satisfying rows 5, 6 and 7 at once prints row 5.
 *
 * It reads {@link walkIsExact} and nothing from the decreasing family — never
 * `decreasingOk`, never `publishabilityOf` — and it reads the WALK the caller
 * opened with, never `found`: the prefix the product search walked before its
 * first witness is an accident of where the search stopped, and `enabled[0]`
 * is the simulator's tie-break, which correction 13 forbids a verdict to be
 * derived from.
 *
 * Rows 8 and 9 are decided over the retained relation explicitly. Let *V* be
 * the violating configurations — those where `p` holds for `absence`, those
 * where it does not for `universality` — *G* the subgraph induced on the
 * others, and *G₀* the part of *G* reachable from the opening within *G*. A
 * run avoiding the violation exists iff *G₀* holds a cycle, or holds a
 * configuration with no successor IN THE FULL RELATION. Both scopings are
 * load-bearing: *"reachable"* alone admits a cycle behind a violation, and *"no
 * successor in G"* calls `nominal` a sink when its only edge leads into
 * `hazard` — a sink is a sink in the full graph or it is not a sink.
 */
function modalityOf(
  model: Model,
  property: ResolvedProperty,
  walk: ExploreResult,
  bounds: ExploreBounds,
): Modality {
  const gate = walkIsExact(walk, bounds);
  // `clause` is the gate's failed clause by default — the rows that ARE the
  // gate's refusal (1, 5, 6, 7) — and `null` where the row's reason is the
  // monitor's or the atom's, so the field never names a clause the sentence
  // did not: `failedClause !== null` on a `not-decided` value reads "refused
  // by the gate", and nothing else.
  const withheld = (sentence: string, clause: FailedClause = gate.failedClause): Modality => ({
    value: 'not-decided',
    sentence,
    failedClause: clause,
    avoiding: null,
  });

  // Row 1 — the walk was not seen whole. The `unsupported` arm is unreachable
  // here: `checkProperty` refuses an unsupported machine before it searches,
  // so no `fail` ever reaches this function over one. It is dispatched all the
  // same, because the gate names it and a row is selected by the clause.
  if (gate.failedClause === 'bound' || gate.failedClause === 'unsupported') {
    return withheld(`${NOT_DECIDED.walk} — ${gate.sentence}`);
  }
  // Row 2 — a stateful monitor. `search` short-circuits at the first
  // violation, so the PRODUCT graph does not exist here; only a memoryless
  // monitor — `absence` or `universality`, `globally` — collapses onto the
  // configuration graph the walk retained. The parenthesis names whichever of
  // the two made it stateful.
  const memoryless =
    property.pattern.name === 'absence' || property.pattern.name === 'universality';
  if (!memoryless || property.scope.name !== 'globally') {
    const carrier = memoryless ? property.scope.name : property.pattern.name;
    return withheld(
      `not decided: this monitor carries state (\`${carrier}\`), so the product does not collapse onto the configuration graph`,
      null,
    );
  }
  // Rows 3 and 4 — an atom the retained relation cannot observe. `fires` and
  // `trigger` are properties of a STEP; `expression` needs the store, which the
  // walk does not retain — left open, no configuration is ever marked
  // violating, *G* is the whole graph and every cyclic machine reads
  // `potential`, whatever the model says.
  const atom = property.atoms.p;
  if (atom === undefined) return withheld(NOT_DECIDED.store, null);
  if (atom.kind === 'trigger' || atom.kind === 'fires') return withheld(NOT_DECIDED.step, null);
  if (atom.kind === 'expression') return withheld(NOT_DECIDED.store, null);
  // Rows 5, 6, 7 — the three relation clauses of the gate, in the gate's own
  // order (`environment` first: a named trigger is something the author can
  // act on, and the dwell sentence would send them to the wrong carrier).
  switch (gate.failedClause) {
    case 'environment':
      return withheld(NOT_DECIDED.environment);
    case 'time':
      return withheld(`${NOT_DECIDED.time} — ${DWELL_SENTENCE}`);
    case 'store':
      return withheld(`${NOT_DECIDED.guard} — ${CLAUSE_SENTENCE.store}`);
    case null:
      break;
  }
  // Rows 8 and 9 — and only here, under the whole gate. The check is stated
  // even though `failedClause === null` already implies it, because this is
  // the line the MUST-NEVER list is about.
  if (!gate.walkIsExact) return withheld(`${NOT_DECIDED.walk} — ${gate.sentence}`);

  const target = atom.elementId!;
  const holdsAt = (i: number): boolean =>
    atom.kind === 'state' ? walk.configStates[i].includes(target) : walk.configLeaves[i] === target;
  const violates = (i: number): boolean =>
    property.pattern.name === 'absence' ? holdsAt(i) : !holdsAt(i);
  const g0 = avoidingReach(walk.successors, violates);
  const inG0 = new Uint8Array(walk.successors.length);
  for (const i of g0) inG0[i] = 1;
  const induced = walk.successors.map((targets, v) =>
    inG0[v] === 1 ? targets.filter((w) => inG0[w] === 1) : [],
  );
  const comps = tarjanComponents(induced);
  const cycle = acyclic(induced, comps) ? null : exhibitCycle(induced, comps);
  // THE FULL RELATION, never the induced one: `walk.successors[i]`, not
  // `induced[i]`.
  const sink = g0.find((i) => walk.successors[i].length === 0);
  const nameOf = (i: number): StateRef => {
    const leaf = walk.configLeaves[i];
    const stack = walk.configStates[i];
    return stateRef(model, leaf ?? stack[stack.length - 1] ?? '');
  };
  const verb = property.pattern.name === 'absence' ? 'enters' : 'leaves';
  // The (d) trigger reads the RECORDED rows alone. §2.4(d) also names "a
  // nondeterminism row was withheld" — `exploreMachine` withholds one where an
  // undetermined guard sits strictly inside the level of the choice — but that
  // arm is vacuous here: such a walk has a non-empty `undeterminedGuards`, so
  // `walkIsExact` fails on its store clause and row 7 has already returned.
  const simulator =
    walk.nondeterminism.length > 0 ? ` — ${SIMULATOR_SENTENCE}` : '';

  if (cycle !== null) {
    const run = cycle.map(nameOf);
    return {
      value: 'potential',
      sentence: `potential — some run avoids it: the cycle ${run.map((s) => s.name).join(' → ')} never ${verb} \`${atom.argument}\`${simulator}`,
      failedClause: null,
      avoiding: run,
    };
  }
  if (sink !== undefined) {
    const stop = nameOf(sink);
    return {
      value: 'potential',
      sentence: `potential — some run avoids it: the run that stops in \`${stop.name}\` never ${verb} \`${atom.argument}\`${simulator}`,
      failedClause: null,
      avoiding: [stop],
    };
  }
  return {
    value: 'guaranteed',
    sentence: `${GUARANTEED_SENTENCE}${simulator}`,
    failedClause: null,
    avoiding: null,
  };
}

/* ─────────────────────────── the recovery pattern ───────────────────────── */

/**
 * The three §3.2b refusal sentences, one per clause of the exactness gate,
 * each followed by the standing sentence for its mechanism (§2.4).
 *
 * The store sentence says *a condition the walk consulted and could not decide*
 * and NOT the plan's *an attribute with no declared value*, for the reason
 * `modalityOf`'s row 7 gives: the store clause is the shipped
 * `undeterminedGuards` predicate, which also covers `not mode` over a fully
 * valued `mode` (`trapguard-typed.sysml`), and the narrower sentence would be
 * false on the one corpus model that tells the two readings apart.
 */
const RECOVERY_REFUSED: Record<'time' | 'store', string> & {
  /**
   * A function of the triggers the clause failed on, because the standing
   * sentence names them: `alphabet ∖ timedLabels`, the gate's own subtraction,
   * computed at the one call site that holds the walk. Never called with
   * `[]` — the environment clause fails only when that difference is non-empty.
   */
  environment: (triggers: readonly string[]) => string;
} = {
  environment: (triggers) =>
    'inconclusive: this machine names triggers this walk offers at every configuration, so "reachable from every configuration" would be a claim about an environment this walk has no carrier for — ' +
    environmentSentence(triggers),
  time:
    'inconclusive: this machine carries `after(n)` dwell transitions this walk takes without advancing a clock, so "reachable from every configuration" would be a claim about escapes this walk invented — ' +
    DWELL_SENTENCE,
  store:
    'inconclusive: a transition of this machine is guarded by a condition the walk consulted and could not decide, so this walk never offered an edge the model states and neither direction of this claim is made — ' +
    CLAUSE_SENTENCE.store,
};

/**
 * How many of `cannot` sit inside a trap — the second of §3.2b's two numbers,
 * under its own question. Read off the SAME classifier and exemption order
 * `reach` applies, so the *"Of these, N form a set nothing leaves"* clause can
 * never disagree with the `verification/unrecoverable-mode` row on one machine.
 */
function trapOverlap(model: Model, walk: ExploreResult, cannot: ReadonlySet<number>): number {
  let overlap = 0;
  for (const members of classifyBottoms(model, walk, tarjanComponents(walk.successors)).traps) {
    for (const i of members) if (cannot.has(i)) overlap++;
  }
  return overlap;
}

/** The shortest number of steps from the opening into `target`, breadth-first over the relation. */
function nearestDepth(successors: readonly (readonly number[])[], target: ReadonlySet<number>): number {
  const depth = new Int32Array(successors.length).fill(-1);
  const queue = [0];
  depth[0] = 0;
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    if (target.has(v)) return depth[v];
    for (const w of successors[v]) {
      if (depth[w] !== -1) continue;
      depth[w] = depth[v] + 1;
      queue.push(w);
    }
  }
  // Every node the walk numbered is reachable from node 0 by construction, so a
  // non-empty target the loop never met is a defect in the producer.
  throw new Error('a configuration of the walk is not reachable from its opening');
}

/**
 * `recovery` — reverse reachability to a named state (plan §3.2b): from every
 * configuration the walk reached, can the machine get back to `p`? THE ONE
 * PRODUCER OF BOTH ANSWERS, register row A7, and the arm `checkProperty`
 * dispatches to instead of the bad-prefix search.
 *
 * ONE GATE, BOTH DIRECTIONS, AND WHY. `recoverable` (∀ configuration ∃ run into
 * `p`) is monotone-INCREASING in the edge relation: every over-approximating
 * mechanism of this walk — a dwell offered without a clock, a trigger offered
 * without an environment — can invent it, so it reads `walkIsExact` like every
 * increasing claim. `not recoverable` (∃ configuration reaching no target) is an
 * absence over REVERSE reachability, monotone-DECREASING in edges, so on the
 * dwell and trigger mechanisms alone the decreasing conjunction would be a sound
 * gate for that half — but not under an UNDER-approximation: a guard the walk
 * consulted and could not decide (`trapguard.sysml`: the escape edge is absent,
 * measured `cannot 2`) removes an edge the model states and MANUFACTURES the
 * refutation, `verification/refuted` at exit 1 on a design that declares the
 * way back. A bound and a missing edge kind are the other two, and both are
 * already inside `seenWhole`. So both halves are gated on the whole of
 * `walkIsExact` and print under ONE `qualification`; a per-direction relaxation
 * would put two exhaustiveness promises on one row and re-admit the trapguard
 * refutation through the store. Nothing here reads the decreasing family, the
 * product search, or its prefix — the reflection suite pins that off the
 * source.
 *
 * THE TARGET PREDICATE IS `atomHolds`'s OWN SELECTION. A `state` atom holds
 * where the id is on the active STACK (`configStates[i].includes`), a `node`
 * atom where it is the active LEAF (`configLeaves[i] ===`) — exactly as
 * `atomHolds` reads them, so `recovery` and `absence` cannot disagree about
 * one atom inside one command. One predicate for both was the draft's error:
 * on any composite state it flips the verdict AND the exit code (measured,
 * §3.2b). `walk.reachable` is never a target predicate — it is the entry
 * cascade, and a state can be in it without being any configuration's leaf.
 * Reverse reachability is REFLEXIVE: a configuration already holding `p`
 * reaches it in zero steps.
 *
 * ORDER OF THE REFUSALS, which is the order of what is knowable: a scope this
 * pattern gives no semantics to; an atom kind the configuration graph cannot
 * observe (`trigger`, `fires`, `expression` — each with the reason its own
 * kind earns, the last byte-identical to §3.R's row 4); a walk that did not
 * see the graph whole; a relation that is not the machine's, one clause at a
 * time; THEN an empty target set, which over an exact walk is a decided
 * refutation and never `vacuous` — there is no antecedent left unopened; and
 * only then the reverse-reachability pass.
 */
function recoveryRow(
  model: Model,
  walk: ExploreResult,
  property: ResolvedProperty,
  row: Pick<PropertyVerdict, 'machine' | 'property' | 'pattern' | 'patternClass' | 'scope' | 'sentence' | 'bounds'>,
  bounds: ExploreBounds,
): PropertyVerdict {
  const atom = property.atoms.p!;
  // Every row this arm composes carries the machine's own count twice —
  // `configs` is the product-search figure elsewhere and there is no product
  // search here — an empty witness (a set is not a run), no modality (a
  // `not recoverable` is not a bad-prefix `fail`), and an open scope.
  const shape = {
    ...row,
    configs: walk.configs,
    machineConfigs: walk.configs,
    boundHit: walk.boundHit,
    unsupported: [] as readonly UnsupportedConstruct[],
    activated: true,
    witness: [] as readonly TraceStep[],
    modality: null as Modality | null,
  };
  const refused = (
    code: string,
    detail: string,
    qualification: string,
    census: Omit<RecoveryCensus, 'atomKind'>,
  ): PropertyVerdict => ({
    ...shape,
    claim: 'inconclusive',
    code,
    detail,
    exhaustive: false,
    qualification,
    recovery: { atomKind: atom.kind, ...census },
  });
  // Nothing below the two refusals that use this ran: no target set was
  // collected, so its count is `null` and not a `0` a `--json` reader would
  // take for "no configuration holds it".
  const notRead = { targetConfigs: null, cannotReach: null, bottomSccOverlap: null, refusedByGate: null };

  // (1) The scope. §3.2b gives a scope no semantics and every example is
  // `globally`; a scope is a monitor over a RUN, and this question is asked of
  // configurations. Refused rather than read as `globally`, which would decide
  // a property nobody wrote.
  if (property.scope.name !== 'globally') {
    return refused(
      MALFORMED_PROPERTY_CODE,
      `inconclusive: \`recovery\` is read over \`globally\` only — a scope selects segments of a run, and "reachable from every reachable configuration" is a question about configurations, not about the segments \`${property.scope.name}\` would select; the property was not read.`,
      'nothing was checked: this pattern reads no scope but `globally`',
      notRead,
    );
  }
  // (2) The atom-kind gate, which is part of the arm. Only `state` and `node`
  // are observed AT a configuration; the other three would leave the target
  // set empty and land on the refutation row below.
  if (atom.kind === 'trigger' || atom.kind === 'fires' || atom.kind === 'expression') {
    const reason = atom.kind === 'expression' ? STORE_ATOM_REASON : STEP_ATOM_REASON;
    return refused(
      MALFORMED_PROPERTY_CODE,
      `inconclusive: \`${atom.text}\` was not read by \`recovery\` — ${reason}`,
      'nothing was checked: this pattern reads `state` and `node` atoms only',
      notRead,
    );
  }

  // (3) The gate, computed once; and the target set, read through
  // `atomHolds`'s own selection for the kind.
  const gate = walkIsExact(walk, bounds);
  const id = atom.elementId!;
  const targets: number[] = [];
  for (let i = 0; i < walk.configs; i++) {
    const holds = atom.kind === 'state' ? walk.configStates[i].includes(id) : walk.configLeaves[i] === id;
    if (holds) targets.push(i);
  }
  const withheld = {
    targetConfigs: targets.length,
    cannotReach: null,
    bottomSccOverlap: null,
    refusedByGate: gate.failedClause,
  };

  // (4) The walk did not see the graph whole. `unsupported` never reaches here
  // — `checkProperty` refused it above — so the clause is `bound` or the
  // residue, and both print the bound code.
  if (!gate.seenWhole) {
    return refused(
      BOUND_EXHAUSTED_CODE,
      `inconclusive: bound exhausted — the recovery claim is not made. ${gate.sentence}; neither "reachable from every configuration" nor its complement is a claim a partial relation supports. Raise the bound (\`--max-configs N\`) and re-run.`,
      gate.sentence,
      withheld,
    );
  }
  // (5) The relation is not the machine's. One switch on the gate's own
  // clause, in its own order, so two machines failing for two reasons never
  // print one sentence. The codes: the store clause files under the same code
  // `reach` and the search branch file that mechanism under; a trigger and a
  // dwell are questions this engine cannot decide HERE, the liveness refusal's
  // precedent — never `null`, which only a `vacuous` row carries today.
  switch (gate.failedClause) {
    case 'environment':
      return refused(
        BEHAVIOUR_UNSUPPORTED_CODE,
        RECOVERY_REFUSED.environment(bounds.alphabet.filter((t) => !walk.timedLabels.has(t))),
        gate.sentence,
        withheld,
      );
    case 'time':
      return refused(BEHAVIOUR_UNSUPPORTED_CODE, RECOVERY_REFUSED.time, gate.sentence, withheld);
    case 'store':
      return refused(GUARD_UNDETERMINED_CODE, RECOVERY_REFUSED.store, gate.sentence, withheld);
    default:
      break;
  }

  const qualification = `exhaustive under ${boundsSentence(bounds)}`;
  const decided = (claim: 'pass' | 'fail', code: string | null, detail: string, cannot: number, overlap: number): PropertyVerdict => ({
    ...shape,
    claim,
    code,
    detail,
    exhaustive: gate.walkIsExact,
    qualification,
    recovery: {
      atomKind: atom.kind,
      targetConfigs: targets.length,
      cannotReach: cannot,
      bottomSccOverlap: overlap,
      refusedByGate: null,
    },
  });

  // The second of §3.2b's two numbers, printed under its own question and only
  // when there is one — the same clause on both `fail` rows, so the census
  // never carries a figure the text withholds.
  const overlapClause = (overlap: number): string =>
    overlap > 0 ? ` Of these, ${overlap} form a set nothing leaves — \`reach\` reports them as \`verification/unrecoverable-mode\`.` : '';

  // (6) An empty target set over an exact walk is a decided refutation, NOT a
  // vacuity: `AG EF p` over a non-empty reachable set with no `p` anywhere is
  // false, and there is no antecedent left unopened. Two reasons a target set
  // is empty, told apart by the STACKS and not by the atom kind: the state is
  // on some stack but the leaf of none — a composite, which only the `node`
  // reading can miss, and which `reach` reports reachable (measured on the
  // composite fixture) — or it is on no stack at all, which is `reach`'s
  // `verification/unreachable-state` whichever reading asked. Branching on
  // the kind alone gave a plain unreachable leaf the composite explanation
  // under `node` and withheld the pointer that was true of it.
  if (targets.length === 0) {
    const all = new Set<number>();
    for (let i = 0; i < walk.configs; i++) all.add(i);
    const overlap = trapOverlap(model, walk, all);
    const onSomeStack = walk.configStates.some((stack) => stack.includes(id));
    const none = `so none of the ${walk.configs} configuration(s) this walk reached can reach it`;
    const where = onSomeStack
      ? `is the active leaf of no reachable configuration, ${none} — the design as written never rests in \`${atom.argument}\` itself; a composite state is on the stack inside its substates and the leaf of none, which \`state ${atom.argument}\` would read.`
      : `is on the stack of no reachable configuration, ${none} — the design as written has no way into \`${atom.argument}\` at all; \`reach\` reports it under \`verification/unreachable-state\`.`;
    return decided('fail', 'verification/refuted', `not recoverable: \`${atom.text}\` ${where}${overlapClause(overlap)}`, walk.configs, overlap);
  }

  // (7) The reverse pass, reflexive, over the retained relation.
  const canReach = reverseReachable(walk.successors, targets);
  const cannot: number[] = [];
  for (let i = 0; i < walk.configs; i++) if (!canReach.has(i)) cannot.push(i);
  if (cannot.length === 0) {
    return decided(
      'pass',
      null,
      `recoverable: \`${atom.text}\` is reachable from every reachable configuration, ${qualification}${
        walk.nondeterminism.length > 0 ? ` — ${SIMULATOR_SENTENCE}` : ''
      }`,
      0,
      0,
    );
  }
  const cannotSet = new Set(cannot);
  const overlap = trapOverlap(model, walk, cannotSet);
  // The set is named by the STATE each configuration rests in, once per
  // state — a state is what a reader can find in the model, a configuration
  // is not. Deduplicated by the leaf's identity and not its spelling, so two
  // same-named leaves under different composites are two entries and not
  // one; spelled by their qualified names when the simple ones collide; and
  // when one state hosts more than one configuration, the count and the
  // list disagree on purpose and the row says so, so the cardinality of the
  // set can always be read against the number that introduces it.
  const leaves: ElementId[] = [];
  for (const i of cannot) {
    const states = walk.configStates[i];
    const leaf = walk.configLeaves[i] ?? states[states.length - 1];
    if (!leaves.includes(leaf)) leaves.push(leaf);
  }
  const refs = leaves.map((leaf) => stateRef(model, leaf));
  const spelt = new Map<string, number>();
  for (const ref of refs) spelt.set(ref.name, (spelt.get(ref.name) ?? 0) + 1);
  const names = refs.map((ref) => ((spelt.get(ref.name) ?? 0) > 1 ? ref.qualifiedName : ref.name));
  const resting = names.length < cannot.length ? ` (${names.length} state(s), holding the ${cannot.length} configurations between them)` : '';
  const openingLeaf = walk.configLeaves[0];
  const opening = stateRef(model, openingLeaf ?? walk.configStates[0][walk.configStates[0].length - 1]).name;
  return decided(
    'fail',
    'verification/refuted',
    `not recoverable: ${cannot.length} configuration(s) cannot reach \`${atom.text}\`: {${names.join(', ')}}${resting}; the nearest is entered in ${nearestDepth(walk.successors, cannotSet)} step(s) from \`${opening}\`.${overlapClause(overlap)}`,
    cannot.length,
    overlap,
  );
}

/* ─────────────────────────── the cover witness ──────────────────────────── */

/** The two warrants a `covered` row may carry, in the words the row prints. */
export const SEMANTICS_ADMITS = 'a run this semantics admits';
export const WALK_ADMITS = 'a run this WALK admits';

/**
 * The warrant of a `covered` row — register row W1, and the FIRST affirmative
 * claim this lane publishes.
 *
 * The bare wording (`SEMANTICS_ADMITS`) needs `relationIsTheMachines` OR the
 * per-step alternative: no step of the witness was taken across a transition
 * with `afterDuration` defined — tested on the step's TRANSITION RECORD and
 * never on its recorded label, which a numeric `attrs.after` step leaves
 * empty — and none crossed a transition in `undeterminedGuards`. Where that
 * disjunction fails the claim SURVIVES and the warrant is re-worded
 * (`WALK_ADMITS`, naming the mechanism the step used): a bound can hide a
 * witness and can never invent one, so this is never `inconclusive` — but the
 * walk offers every dwell at every configuration and advances no clock, so a
 * trace across one is a trace the interpreter may never take, and saying
 * "this semantics admits" of it would be the sentence the plan bans verbatim.
 *
 * READS NO MEMBER OF THE BOUND FAMILY — not `decreasingOk`, not `seenWhole`,
 * not `searchComplete`, not `boundHit`. `test/unit/semantics.mc.patterns.test.ts`
 * asserts that by reading this function's source, and the `--max-configs d`
 * frontier case asserts it by running one.
 */
function coverWarrant(
  model: Model,
  walk: ExploreResult,
  bounds: ExploreBounds,
  leaf: ProductNode,
  steps: number,
  sentence: string,
): string {
  const undetermined = new Set(walk.undeterminedGuards.map((g) => g.transition.id));
  const crossed: string[] = [];
  let dwell = false;
  let store = false;
  // The triggers the witness consumed, leaf-first as the walk visits them and
  // reversed below into TRACE order, so the sentence names the first
  // consumption first and each trigger once.
  const consumedBackward: string[] = [];
  let index = steps;
  for (let n: ProductNode | null = leaf; n !== null && n.parent !== null; n = n.parent, index--) {
    // §2.4(a) is about an ENVIRONMENT — one that supplied the triggers this
    // trace consumed, which the sentence names. The walk also offers every
    // `after(n)` dwell as a named event (plan §2.3: "the trace is a run of NO
    // environment"), so a step whose input is a dwell label consumed nothing
    // an environment sends; `timedLabels` and the alphabet range over the same
    // relation, so the subtraction is the one `walkIsExact`'s environment
    // clause makes. Without it a machine naming no trigger at all printed a
    // sentence about the environment it lacks.
    if (n.input?.kind === 'trigger' && !walk.timedLabels.has(n.input.trigger)) {
      consumedBackward.push(n.input.trigger);
    }
    const tr = n.transition;
    if (tr === null) continue;
    const label = transitionLabel(transitionRef(model, tr));
    if (afterDuration(tr) !== undefined) {
      dwell = true;
      crossed.unshift(
        `step ${index} fires \`${triggerLabelOf(tr) || `after(${afterDuration(tr)})`}\` (${label}), a dwell this engine offers as a named event without advancing a clock`,
      );
    } else if (undetermined.has(tr.id)) {
      store = true;
      crossed.unshift(`step ${index} crosses ${label}, whose guard the walk read against a store nothing valued`);
    }
  }
  const exact = walkIsExact(walk, bounds).relationIsTheMachines;
  const bare = exact || (!dwell && !store);
  const consumed = [...new Set(consumedBackward.reverse())];
  const riders = [
    ...(consumed.length > 0 ? [environmentSentence(consumed)] : []),
    ...(dwell ? [DWELL_SENTENCE] : []),
    ...(walk.nondeterminism.length > 0 ? [SIMULATOR_SENTENCE] : []),
  ];
  const head = bare
    ? `covered — witness trace of ${steps} step(s), ${SEMANTICS_ADMITS}: ${sentence}`
    : `covered — witness trace of ${steps} step(s), ${WALK_ADMITS}: ${crossed.join('; ')}, so the interpreter may never take this trace. ${sentence}`;
  return [head, ...riders].join(' — ');
}

/**
 * Correction 23's exposure, counted: the unreached states, and how many of
 * them sit behind an undecided guard alone. Both numbers, because the refusal
 * sentence quotes them as a fraction: "1 of 4" is a fact a reader can check
 * against the model, where "every" was a universal nothing computed — an
 * unreached state behind a guard the walk DID decide, or behind an unguarded
 * edge from another unreached state, is not behind an undecided one.
 */
function coverCensus(
  model: Model,
  machineId: ElementId,
  walk: ExploreResult,
  property: ResolvedProperty,
): CoverCensus {
  const undetermined = new Set(walk.undeterminedGuards.map((g) => g.transition.id));
  const walkable = walkableTransitions(model, machineId);
  let unreached = 0;
  let behind = 0;
  for (const state of machineStates(model, machineId)) {
    if (walk.reachable.has(state.id)) continue;
    unreached++;
    const inbound = walkable.filter((tr) => tr.target?.[0] === state.id);
    if (inbound.length > 0 && inbound.every((tr) => undetermined.has(tr.id))) behind++;
  }
  return {
    atomKind: property.atoms.p!.kind,
    scope: property.scope.name,
    coverUnreached: unreached,
    coverUnreachedBehindUndefinedGuard: behind,
  };
}

/* ──────────────────────────────── the report ────────────────────────────── */

/** The code `--strict-vacuity` raises a vacuity row to. Declared at commit 5. */
const STRICT_VACUITY_CODE = 'verification/vacuous-property';

/** A `cover` no explored run witnessed, over a graph seen whole: a decided absence, info. */
export const NOT_COVERED_CODE = 'verification/not-covered';
/** The error `--cover-required` ADDS beside {@link NOT_COVERED_CODE} — never in place of it. */
export const COVER_REQUIRED_CODE = 'verification/cover-required';

/** The codes this command can raise that no other part of the lane declares. */
export const PROPERTY_PATTERN_CODES: ReadonlySet<string> = new Set([
  MALFORMED_PROPERTY_CODE,
  UNKNOWN_ATOM_CODE,
  NOT_COVERED_CODE,
  COVER_REQUIRED_CODE,
]);

/**
 * The sentence printed beside EVERY `cover` row `--cover-required` declines to
 * spend the 1 on (correction 23): the row is not `not-covered` at all but
 * `inconclusive` under `verification/guard-undetermined`, so the flag has no
 * decided absence to grade. An answer about an unbound model parameter is not
 * an answer about a design that violates something.
 *
 * COUNTED, NOT UNIVERSAL. An earlier wording said "every unreached state of
 * this cover sits behind a guard over an attribute with no declared value" —
 * a claim nothing computed: the census counts the states behind an undecided
 * guard ALONE, and a machine with an unreached state behind a guard the walk
 * did decide (`k : Integer = 4` under `if k == 3`), or behind an unguarded
 * edge out of another unreached state, printed that universal falsely. The
 * sentence now quotes the census as a fraction the reader can check against
 * the model, and prints on every withheld cover — a census of 0 is a fact
 * about the model too, and the flag declined on that row all the same.
 */
export function coverRequiredRefusal(census: CoverCensus): string {
  const { coverUnreached: unreached, coverUnreachedBehindUndefinedGuard: behind } = census;
  const states =
    unreached === 0
      ? 'no state of this machine is unreached'
      : `${behind} of its ${unreached} unreached state(s) sit${behind === 1 ? 's' : ''} behind a guard over an attribute with no declared value, which the walk read as false`;
  return `--cover-required not applied: this cover is inconclusive under verification/guard-undetermined, not \`not covered\`, so there is no decided absence to spend the 1 on — ${states} — exit 2, not 1`;
}

/**
 * Does this behaviour pattern hold on every reachable configuration, and can
 * this design reach the situation I name (plan §3.8, model-checking plan §3.1,
 * §3.2b — `recovery` asks the second question of EVERY configuration)?
 *
 * It JUDGES, which is why it carries an exit code where `reachReport` does not:
 * a property is a claim somebody wrote into a file, and a claim that fails is a
 * finding about the model. The arithmetic is §2's, over six words — `fail` is
 * 1, `vacuous`, `inconclusive` and `not-covered` are 2, `covered` and `pass`
 * are both discharged, a run with NOTHING to decide is 2 as well, because exit
 * 0 says every property was shown to hold and a model that states none has
 * been shown nothing — and `--cover-required` moves `not-covered` to 1 without
 * touching the word.
 */
export function behaviourReport(model: Model, opts: BehaviourOptions): BehaviourReport {
  const { machineId, pattern, strictVacuity = false, coverRequired = false, ...explore } = opts;
  const machineEl = model.get(machineId);
  const machine: (StateRef & { eClass: string }) | null = machineEl
    ? { ...stateRef(model, machineId), eClass: machineEl.eClass }
    : null;

  const texts: PropertyText[] = [...propertiesOf(model, machineId)];
  const rows: PropertyVerdict[] = [];
  const bounds: ExploreBounds = {
    maxConfigs: Math.max(1, explore.maxConfigs ?? DEFAULT_MAX_CONFIGS),
    maxDepth: Math.max(0, explore.maxDepth ?? DEFAULT_MAX_DEPTH),
    maxCompletion: Math.max(0, explore.maxCompletion ?? MAX_COMPLETION),
    alphabet: machineAlphabet(model, machineId),
  };
  // `pattern !== undefined` ALONE. An empty or all-blank value — a CI line
  // whose shell variable expanded to nothing — used to be dropped here, and the
  // run then reported on the carriers alone and looked like a clean sweep, or
  // said "none was given" about a flag that was. `parsePropertyText` already
  // refuses it with the right words ("no fields at all"), so it lands as a
  // refused row like every other unreadable spelling.
  if (pattern !== undefined) {
    const parsed = parsePropertyText(pattern, 'flag');
    if (parsed.ok) texts.push(parsed.text);
    else {
      // A `--pattern` this tool cannot read is reported as a ROW rather than
      // thrown away: it is inconclusive, it exits 2, and the reader sees which
      // of their properties was not checked. Silence here would be a run that
      // reported on the carriers alone and looked like a clean sweep.
      rows.push(
        refusedRow(
          machine ?? { id: machineId, name: '', qualifiedName: machineId, eClass: '' },
          {
            pattern: pattern.trim(),
            scope: '',
            source: 'flag',
            carrier: null,
          },
          { code: MALFORMED_PROPERTY_CODE, detail: parsed.detail, candidates: [] },
          bounds,
        ),
      );
    }
  }
  for (const text of texts) rows.push(checkProperty(model, machineId, text, explore));

  const counts = {
    passed: rows.filter((r) => r.claim === 'pass').length,
    failed: rows.filter((r) => r.claim === 'fail').length,
    vacuous: rows.filter((r) => r.claim === 'vacuous').length,
    inconclusive: rows.filter((r) => r.claim === 'inconclusive').length,
    covered: rows.filter((r) => r.claim === 'covered').length,
    notCovered: rows.filter((r) => r.claim === 'not-covered').length,
  };
  // §2.2's arithmetic. A word counted in none of the six buckets would fall
  // through this ternary to exit 0 — a green run that decided nothing — which
  // is why the suite asserts the buckets sum to `rows.length`.
  const exitCode: 0 | 1 | 2 =
    counts.failed > 0
      ? 1
      : coverRequired && counts.notCovered > 0
        ? 1
        : counts.vacuous > 0 || counts.inconclusive > 0 || counts.notCovered > 0 || rows.length === 0
          ? 2
          : 0;

  const findings: Array<Omit<Diagnostic, 'id' | 'ruleId' | 'source'>> = [];
  for (const row of rows) {
    if (row.claim === 'vacuous') {
      // Without the flag a vacuity is a ROW and not a finding — visible in the
      // report and in the exit code, and easy to scroll past, which is exactly
      // what `--strict-vacuity` exists to change (§2). With it, one error.
      if (!strictVacuity) continue;
      findings.push({
        severity: 'error',
        message: `\`${row.machine.qualifiedName}\`: ${row.sentence} — ${row.detail}`,
        elementId: row.machine.id,
        elementName: row.machine.qualifiedName,
        code: STRICT_VACUITY_CODE,
        hint: 'The flag changes the code and the severity and NOTHING else: the claim stays `vacuous`, the row stays undecided, and the run exits 2 exactly as it does without the flag. Fix the antecedent so the property stands on something that can happen.',
      });
      continue;
    }
    if (row.claim === 'not-covered' && coverRequired) {
      // THE DEDICATED BRANCH, mirroring `--strict-vacuity`'s above in shape
      // and NOT in its `continue`. The generic push below derives severity
      // from the CLAIM, and a `not-covered` row is not `fail` — so this code,
      // catalogued `error`, would otherwise be emitted `info`. And the flagged
      // run must still emit the `verification/not-covered` info finding the
      // plain run emits (§2.2): the two runs differ by this added error and
      // the exit code, and by nothing else. A `continue` here drops the info
      // row, which is exactly the substitution shape the plan forbids.
      findings.push({
        severity: 'error',
        message: `\`${row.machine.qualifiedName}\`: ${row.sentence} — ${row.detail}`,
        elementId: row.machine.id,
        elementName: row.machine.qualifiedName,
        code: COVER_REQUIRED_CODE,
        hint: 'The flag spends the 1 and changes NOTHING else: the claim stays `not-covered`, the row stays a decided absence, and `verification/not-covered` is still filed beside this. A missing behaviour is a defect only because you said so with the flag — add the run the cover asks for, or drop the flag and read the row as the answer it is.',
      });
    }
    if (row.code === null) continue;
    findings.push({
      // Severity is a property of the CODE, read off the same sets the
      // catalogue guard compares — never a per-branch override. `fail` rows
      // are the lane's one refutation; a `BEHAVIOUR_WARNING_CODES` member is a
      // finding about the MODEL (a guard nothing valued); everything else says
      // what was not decided.
      severity: row.claim === 'fail' ? 'error' : BEHAVIOUR_WARNING_CODES.has(row.code) ? 'warning' : 'info',
      message: `\`${row.machine.qualifiedName}\`: ${row.sentence} — ${row.detail}`,
      elementId: row.machine.id,
      elementName: row.machine.qualifiedName,
      code: row.code,
      hint:
        row.claim === 'fail' && row.patternClass === 'branching' && row.recovery?.targetConfigs === 0
          ? // The empty-target refutation names no configuration and counts
            // no steps — there is no nearest one — so the hint that promised
            // both would point at text the row does not carry.
            'No configuration this walk reached holds the state the property names, so every one of them is on the list and there is no nearest one to count steps to. The row says which of two things that is: a state the design has no way into, or a composite the `node` reading never rests in and the `state` reading would find. Add the way in, or name the reading that matches the state.'
          : row.claim === 'fail' && row.patternClass === 'branching'
          ? // A `recovery` refutation is a SET, not a run: there is no trace
            // to read, and the hint that sends a reader to one would send
            // them to an empty block.
            'Read the set: each configuration named cannot reach the state the property names, over the relation this machine states, and the nearest of them is entered in the number of steps given. Where `reach` reports part of it as `verification/unrecoverable-mode`, that is the same set seen from the other side. Add the way back the design is missing, or name a state that is reachable from there.'
          : row.claim === 'fail'
          ? 'Read the witness trace: it is a run this semantics admits, printed step by step with the atoms that hold at each one. The simulator may never take it — that is what makes it worth printing.'
          : row.claim === 'not-covered'
            ? // The "pass `--cover-required`" clause is printed on a flagged run
              // too, where it is advice about a flag already given. That is the
              // cost of §2.2's rule that the info finding is BYTE-IDENTICAL
              // between a flagged and a plain run, and the rule wins: the
              // error row beside it is what says the flag was applied.
              'This row IS decided: over a graph the walk saw whole, no run enters the situation the cover names. It is a missing behaviour and not a violated requirement, so it exits 2 — pass `--cover-required` to make it exit 1, which adds `verification/cover-required` and changes no word above.'
            : 'Nothing is claimed about this property. A row that says what was not decided is the one thing a silence could never say.',
    });
  }

  return {
    machine,
    properties: rows,
    profile: SEMANTIC_PROFILE,
    counts,
    strictVacuity,
    coverRequired,
    exitCode,
    diagnostics: findings.map((d, i) => ({
      id: `verification#${i}`,
      ruleId: 'verification',
      source: 'verification',
      ...d,
    })),
  };
}

/** One witness step as a line a person reads. */
export function traceLine(step: TraceStep): string {
  const head = `${String(step.index).padStart(2, ' ')}  `;
  const event =
    step.index === 0 ? 'start' : step.event === '' ? 'completion' : `on \`${step.event}\``;
  const via = step.transition === null ? '' : ` ${transitionLabel(step.transition)}`;
  const where = step.leaf === null ? '(no active state)' : step.leaf.qualifiedName;
  const holds = step.holds.length > 0 ? `  [holds ${step.holds.join(', ')}]` : '';
  return `${head}${event}${via} → ${where}${holds}`;
}
