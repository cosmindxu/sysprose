/**
 * `check-behaviour` — safety patterns over a configuration graph, and the three
 * things this engine refuses to say (plan §3.8).
 *
 * WHAT IT DECIDES, AND WHAT IT CANNOT. A property pattern is a shape with atoms
 * in it (`./atoms`) and a SCOPE it holds over. Four of the six patterns in the
 * catalogue are SAFETY properties: every violation of one has a finite bad
 * prefix, so a search over the configuration graph either finds a run that
 * breaks it — and prints that run — or, having seen the whole graph, does not.
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
import {
  BEHAVIOUR_UNSUPPORTED_CODE,
  BOUND_EXHAUSTED_CODE,
  DEFAULT_MAX_CONFIGS,
  DEFAULT_MAX_DEPTH,
  GUARD_UNDETERMINED_CODE,
  exploreMachine,
  machineAlphabet,
  transitionLabel,
  type BoundHit,
  type ExploreBounds,
  type ExploreOptions,
  type StateRef,
  type TransitionRef,
  type UnsupportedConstruct,
} from './explore';
import { SEMANTIC_PROFILE, type ProfileField } from './profile';
// One definition of "may this absence be stated", shared with `reachOne`.
import { publishabilityOf } from './publishable';

/* ───────────────────────────── the catalogue ────────────────────────────── */

/** The six patterns, split by what a bad-prefix search can decide. */
export type PatternName =
  | 'absence'
  | 'universality'
  | 'bounded-existence'
  | 'precedence'
  | 'existence'
  | 'response';

/** Safety is decided here; liveness is not decided in-process at all. */
export type PatternClass = 'safety' | 'liveness';

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
 * The catalogue, in `vogel-2022`'s split.
 *
 * The order is safety first, and it is not cosmetic: the four this engine
 * decides come first so a reader scanning `--help` or the guide meets what the
 * command can do before what it refuses, and the two liveness rows carry the
 * refusal in their own reading rather than in a footnote.
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

/** The four words this command may reach. Nothing here is ever `proved`. */
export type PropertyClaim = 'pass' | 'fail' | 'vacuous' | 'inconclusive';

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
  configs: number;
  exhaustive: boolean;
  boundHit: BoundHit;
  /** The sentence every figure on this row is true UNDER. */
  qualification: string;
  unsupported: readonly UnsupportedConstruct[];
  /** The bad prefix, when there is one. EMPTY on every other claim. */
  witness: readonly TraceStep[];
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
  };
  /** Was the vacuity row raised to an error? It changes no exit code (§2). */
  strictVacuity: boolean;
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

/** `{maxConfigs …, maxDepth …, maxCompletion …, alphabet …}`, spelled out. */
function boundsSentence(b: ExploreBounds): string {
  const alphabet = b.alphabet.length === 0 ? 'no named trigger' : b.alphabet.join(', ');
  return `{maxConfigs ${b.maxConfigs}, maxDepth ${b.maxDepth}, maxCompletion ${b.maxCompletion}, alphabet ${alphabet}}`;
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
    exhaustive: false,
    boundHit: 'none',
    qualification: 'nothing was checked: the property could not be read',
    unsupported: [],
    witness: [],
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
      exhaustive: false,
      boundHit: 'none',
      qualification: 'not decided: this engine decides safety patterns only',
      unsupported: [],
      witness: [],
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
      exhaustive: false,
      boundHit: walk.boundHit,
      qualification: `not explored — ${walk.unsupported.map((u) => u.construct).join(', ')}`,
      unsupported: walk.unsupported,
      witness: [],
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
  const base = {
    ...row,
    configs: found.configs,
    exhaustive,
    boundHit,
    qualification,
    unsupported: [] as readonly UnsupportedConstruct[],
    activated: found.activated,
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
    return {
      ...base,
      // The search RETURNED at the first violation, so `configs` counts the
      // product states seen up to the witness and is not the size of the
      // product space. `exhaustive` is still true of the machine graph — that
      // is `exploreMachine`'s figure — and printing the two side by side under
      // one word invited the count to be read as the second.
      qualification: `${qualification} — the count beside it is the product states seen up to the witness, not the size of the product space`,
      claim: 'fail',
      code: 'verification/refuted',
      detail:
        `fail — witness trace of ${witness.length - 1} step(s): ${sentence}. The run below is one ` +
        'this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      witness,
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
        'the runs it hides is exactly where a bad prefix would be. This is NOT a pass: `reach` on ' +
        'the same machine withholds its unreachable, dead and no-way-out lists for the same reason.',
      witness: [],
    };
  }
  if (!exhaustive) {
    return {
      ...base,
      claim: 'inconclusive',
      code: BOUND_EXHAUSTED_CODE,
      detail:
        `inconclusive: ${found.activated ? 'no bad prefix was found' : "no explored run opened the property's scope"}, and the walk did not finish — ${boundSentence(boundHit) || 'a trigger the machine names was never offered'}. ` +
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

/* ──────────────────────────────── the report ────────────────────────────── */

/** The code `--strict-vacuity` raises a vacuity row to. Declared at commit 5. */
const STRICT_VACUITY_CODE = 'verification/vacuous-property';

/** The codes this command can raise that no other part of the lane declares. */
export const PROPERTY_PATTERN_CODES: ReadonlySet<string> = new Set([
  MALFORMED_PROPERTY_CODE,
  UNKNOWN_ATOM_CODE,
]);

/**
 * Does this safety pattern hold on every reachable configuration (plan §3.8)?
 *
 * It JUDGES, which is why it carries an exit code where `reachReport` does not:
 * a property is a claim somebody wrote into a file, and a claim that fails is a
 * finding about the model. The arithmetic is §2's, over four words —
 * `fail` is 1, `vacuous` and `inconclusive` are 2, and a run with NOTHING to
 * decide is 2 as well, because exit 0 says every property was shown to hold and
 * a model that states none has been shown nothing.
 */
export function behaviourReport(model: Model, opts: BehaviourOptions): BehaviourReport {
  const { machineId, pattern, strictVacuity = false, ...explore } = opts;
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
  };
  const exitCode: 0 | 1 | 2 =
    counts.failed > 0
      ? 1
      : counts.vacuous > 0 || counts.inconclusive > 0 || rows.length === 0
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
    if (row.code === null) continue;
    findings.push({
      severity: row.claim === 'fail' ? 'error' : 'info',
      message: `\`${row.machine.qualifiedName}\`: ${row.sentence} — ${row.detail}`,
      elementId: row.machine.id,
      elementName: row.machine.qualifiedName,
      code: row.code,
      hint:
        row.claim === 'fail'
          ? 'Read the witness trace: it is a run this semantics admits, printed step by step with the atoms that hold at each one. The simulator may never take it — that is what makes it worth printing.'
          : 'Nothing is claimed about this property. A row that says what was not decided is the one thing a silence could never say.',
    });
  }

  return {
    machine,
    properties: rows,
    profile: SEMANTIC_PROFILE,
    counts,
    strictVacuity,
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
