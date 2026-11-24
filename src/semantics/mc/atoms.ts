/**
 * The atoms a behavioural property is written over (plan §3.8).
 *
 * WHAT AN ATOM IS HERE. A property pattern — `absence`, `universality`,
 * `precedence` — is a shape with holes in it, and an atom is what fills one:
 * a predicate that is true or false of ONE observation of a run. An observation
 * is a configuration together with the step that produced it, which is why
 * `trigger t` and `fires T` can be atoms at all: neither is a fact about a
 * configuration, both are facts about the step into it, and a language that
 * could only speak about states could not say "this transition never fires
 * after that one".
 *
 * FIVE SPELLINGS, AND THE REASON THERE ARE NOT MORE. `state X`, `trigger t`,
 * `fires T` and `node N` are the four things a walk of a configuration graph
 * can observe directly and name back to a reader in the model's own vocabulary.
 * Everything else is an EXPRESSION, read by the same `parseExpr` the guards are
 * read with and evaluated against the same store — because a property that
 * could not say `mode == 3` would push every value question out of the language
 * and back into a hand-written state name.
 *
 * THE FAIL DIRECTION, STATED ONCE. An atom this module cannot resolve is a
 * REFUSAL, never a `false`. A name that resolves to nothing is
 * `verification/unknown-atom` and a clause that is not a predicate at all is
 * `verification/malformed-property`; both make the property inconclusive and
 * exit 2. The alternative — reading an unresolvable atom as "does not hold" —
 * turns `absence of state failsafe` into a PASS the moment somebody misspells
 * `failsafe`, which is the single most likely way this lane could print a green
 * verdict that means nothing.
 */

import { refSegments, type ElementId, type ElementRecord, type Model } from '@core/index';
import { parseExpr, writtenChains } from '../expr';
import {
  activeLeavesOf,
  activeStatesOf,
  evalStr,
  leafOf,
  machineRegion,
  regionScope,
  storeScope,
  triggerLabelOf,
  type MachineConfig,
  type StepInput,
} from './config';

/** A name in a property names nothing the machine has (plan §3.8). */
export const UNKNOWN_ATOM_CODE = 'verification/unknown-atom';

/**
 * The property itself cannot be read as one.
 *
 * Declared HERE rather than in `./patterns`, with the code it sits beside,
 * because both modules raise it and a code spelled twice is a code that drifts.
 * `./patterns` raises it for a pattern name outside the catalogue or a field a
 * pattern needs and did not get; this module raises it for a clause that does
 * not parse, or that parses and is not a predicate.
 */
export const MALFORMED_PROPERTY_CODE = 'verification/malformed-property';

/** How an atom is spelled, which is also how it is observed. */
export type AtomKind = 'state' | 'trigger' | 'fires' | 'node' | 'expression' | 'formula';

/**
 * A Boolean combination of leaves read in ONE configuration: `state A and n > 3`, `state A or state B`, `not state A`.
 *
 * A `state` leaf reads the ACTIVE STATES of the configuration, the same set a plain `state X` reads (`activeStatesOf`),
 * so on a parallel machine `state a2 and state b2` asks whether two regions are in those states in ONE configuration.
 * An `expr` leaf is an expression over the machine's attributes, evaluated against the same configuration's store as a
 * plain expression atom is. A leaf that is a trigger, a transition or a node is a different kind of observation (a
 * step, not a configuration predicate) and is refused rather than mixed in.
 *
 * Three-valued: an `expr` leaf the evaluator cannot decide is `undefined`, and so is every formula it touches — never
 * `false` (a `false` would let `absence of (state A and n > 3)` pass on a configuration nobody evaluated).
 */
export type StateFormula =
  | { readonly op: 'state'; readonly id: ElementId }
  | { readonly op: 'expr'; readonly text: string }
  | { readonly op: 'not'; readonly a: StateFormula }
  | { readonly op: 'and' | 'or'; readonly a: StateFormula; readonly b: StateFormula };

/** Does the formula read the store (has an expression leaf)? Then a state-set-only walk cannot decide it. */
export function formulaReadsStore(f: StateFormula): boolean {
  switch (f.op) {
    case 'state':
      return false;
    case 'expr':
      return true;
    case 'not':
      return formulaReadsStore(f.a);
    default:
      return formulaReadsStore(f.a) || formulaReadsStore(f.b);
  }
}

/**
 * Does the formula hold where exactly these states are active? `evalLeaf` decides an expression leaf (absent: such a
 * leaf is undecided). `undefined` = not decidable here; it propagates through every connective.
 */
export function formulaHolds(
  f: StateFormula,
  active: readonly ElementId[],
  evalLeaf?: (text: string) => boolean | undefined,
): boolean | undefined {
  switch (f.op) {
    case 'state':
      return active.includes(f.id);
    case 'expr':
      return evalLeaf === undefined ? undefined : evalLeaf(f.text);
    case 'not': {
      const a = formulaHolds(f.a, active, evalLeaf);
      return a === undefined ? undefined : !a;
    }
    default: {
      const a = formulaHolds(f.a, active, evalLeaf);
      const b = formulaHolds(f.b, active, evalLeaf);
      if (a === undefined || b === undefined) return undefined;
      return f.op === 'and' ? a && b : a || b;
    }
  }
}

/** One resolved atom: what it observes, and what it was written as. */
export interface Atom {
  readonly kind: AtomKind;
  /** Exactly what the author wrote, for the trace and for the verdict line. */
  readonly text: string;
  /** The name or the expression, with the leading keyword taken off. */
  readonly argument: string;
  /**
   * The element the name resolved to, for every kind but `expression`.
   *
   * An id rather than a name because the walk compares ids, and a qualified
   * name for the report is one lookup away. Absent for `trigger` (a trigger is
   * a string the machine names, not an element) and for `expression`.
   */
  readonly elementId?: ElementId;
  /** The qualified name of {@link elementId}, so a report never prints a raw id. */
  readonly qualifiedName?: string;
  /** For kind `formula`: the combination over state occupancy. */
  readonly formula?: StateFormula;
}

/** Why an atom was refused, in the words the row prints. */
export interface AtomRefusal {
  readonly code: string;
  readonly detail: string;
  /** What the machine DOES offer, so a misspelling is one line from being fixed. */
  readonly candidates: readonly string[];
}

/** Resolved, or refused with a reason — never a silent `false`. */
export type AtomResult =
  | { readonly ok: true; readonly atom: Atom }
  | { readonly ok: false; readonly refusal: AtomRefusal };

/** One observation of a run: a configuration, and the step that produced it. */
export interface Observation {
  readonly config: MachineConfig;
  /** The input offered, or `null` for the opening configuration. */
  readonly input: StepInput | null;
  /** The transition that fired, or `null` for the opening configuration. */
  readonly transition: ElementRecord | null;
  /** Every transition the step fired where it fired several (one per region of a parallel state); else absent. */
  readonly fired?: readonly ElementId[];
}

/** How many names a refusal lists before it stops naming them. */
const MAX_CANDIDATES = 12;

/** The keywords an atom may open with, longest first so `state` beats nothing. */
const KEYWORDS: readonly AtomKind[] = ['state', 'trigger', 'fires', 'node'];

/** Names an expression may use that are not features of the model. */
const RESERVED = new Set([
  'true',
  'false',
  'null',
  'and',
  'or',
  'not',
  'xor',
  'implies',
  'if',
  'then',
  'else',
]);

/**
 * Every state inside the machine, for `state X` and for a refusal's candidates.
 *
 * Read from the machine's REGION, as the four pools here are: the region stops
 * at a `state def` written inside the machine (`regionDescendants`,
 * `./config`). That definition is a machine of its own, walked by itself, and
 * no configuration of this machine ever stands on one of its states or fires
 * one of its transitions. Resolving `state y` to the nested definition's `y`
 * gave an atom that holds NOWHERE in this walk — `absence of state y` passed on
 * the outer machine while the same claim failed on the machine that holds `y` —
 * which is the outcome the header forbids. Read from the region, it is
 * `verification/unknown-atom`, as a state of another top-level machine is.
 */
function statesOf(model: Model, machineId: ElementId): ElementRecord[] {
  return machineRegion(model, machineId).descendants.filter((e) => e.eClass === 'StateUsage');
}

/**
 * Every element a configuration's leaf can BE — states and the control nodes
 * a transition can enter.
 *
 * `node N` exists for the second half of that list. `enterCascade` pushes
 * whatever a transition targets, and the ordinary way to end a machine in the
 * notation is `done`, which the mapper turns into a `DoneNode` — so without
 * this kind there would be no way to write "the machine never ends here", and
 * `state X` cannot do it because a `DoneNode` is not a `StateUsage`.
 */
function nodesOf(model: Model, machineId: ElementId): ElementRecord[] {
  return machineRegion(model, machineId).descendants.filter(
    (e) =>
      e.declaredName !== undefined &&
      // ONLY WHAT A LEAF CAN BE. A machine holds attributes, actions and
      // transitions as well as states, and none of those is ever the active
      // leaf — so resolving `node someAttribute` would give an atom that
      // holds NOWHERE, and `absence of node someAttribute` would pass on
      // every machine. That is the failure this module's header refuses: an
      // atom that cannot be observed is a refusal, never a silent `false`.
      (e.eClass === 'StateUsage' || e.eClass.endsWith('Node')),
  );
}

/** Named transitions, for `fires T` — the anonymous ones cannot be named at all. */
function namedTransitions(model: Model, machineId: ElementId): ElementRecord[] {
  return machineRegion(model, machineId).descendants.filter(
    (e) => e.eClass === 'TransitionUsage' && (e.declaredName ?? '') !== '',
  );
}

/** The distinct triggers the machine names, in declaration order. */
function triggersOf(model: Model, machineId: ElementId): string[] {
  const out: string[] = [];
  for (const tr of machineRegion(model, machineId).descendants) {
    if (tr.eClass !== 'TransitionUsage') continue;
    const label = triggerLabelOf(tr);
    if (label === '' || out.includes(label)) continue;
    out.push(label);
  }
  return out;
}

/** `A`, `B`, `C` — the names a refusal offers instead of the one it refused. */
function candidateList(names: readonly string[]): string[] {
  return names.slice(0, MAX_CANDIDATES);
}

/**
 * Resolve one element name among the candidates, by declared or qualified name.
 *
 * BOTH SPELLINGS, and the ambiguity is refused rather than resolved. A machine
 * may hold two states with one declared name in different regions, and picking
 * the first would make `absence of state idle` a claim about whichever region
 * the walk happened to reach first — an answer a reader cannot check. The same
 * rule §3.0 states for every `REF` this lane takes: on several matches, refuse
 * and print them.
 */
function resolveNamed(
  model: Model,
  candidates: readonly ElementRecord[],
  name: string,
  kind: AtomKind,
  text: string,
): AtomResult {
  const hits = candidates.filter(
    (c) => {
      if (c.declaredName === name) return true;
      const qn = model.qualifiedName(c.id);
      // `r1::a2` names the state by the tail of its qualified name, on a segment boundary — a name a reader can
      // write to tell two same-named states of different regions apart. Still refused when it names several.
      return qn === name || (name.includes('::') && qn.endsWith(`::${name}`));
    },
  );
  if (hits.length === 1) {
    return {
      ok: true,
      atom: {
        kind,
        text,
        argument: name,
        elementId: hits[0].id,
        qualifiedName: model.qualifiedName(hits[0].id) || hits[0].id,
      },
    };
  }
  const names = candidates.map((c) => c.declaredName ?? '').filter((n) => n !== '');
  if (hits.length === 0) {
    return {
      ok: false,
      refusal: {
        code: UNKNOWN_ATOM_CODE,
        detail:
          `\`${text}\` names no ${kind === 'fires' ? 'named transition' : kind} in this machine` +
          (names.length > 0
            ? ` — it declares ${candidateList(names)
                .map((n) => `\`${n}\``)
                .join(', ')}`
            : ' — this machine declares none at all'),
        candidates: candidateList(names),
      },
    };
  }
  return {
    ok: false,
    refusal: {
      code: UNKNOWN_ATOM_CODE,
      detail:
        `\`${text}\` names ${hits.length} elements in this machine — ` +
        `${hits.map((h) => `\`${model.qualifiedName(h.id) || h.id}\``).join(', ')}. ` +
        'Write the qualified name: a property that named whichever one the walk reached first ' +
        'would be a claim a reader cannot check.',
      candidates: hits.map((h) => model.qualifiedName(h.id) || h.id),
    },
  };
}

/** Tokens of a state-occupancy formula: parentheses, and words (a quoted name keeps its spaces). */
function formulaTokens(text: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  const flush = (): void => {
    if (cur !== '') out.push(cur);
    cur = '';
  };
  for (const ch of text) {
    if (ch === "'") {
      quoted = !quoted;
      cur += ch;
    } else if (quoted) cur += ch;
    else if (ch === '(' || ch === ')') {
      flush();
      out.push(ch);
    } else if (/\s/.test(ch)) flush();
    else cur += ch;
  }
  if (quoted) return null;
  flush();
  return out;
}

type FormulaTree =
  | { readonly op: 'name'; readonly name: string }
  | { readonly op: 'expr'; readonly text: string }
  | { readonly op: 'step'; readonly text: string }
  | { readonly op: 'not'; readonly a: FormulaTree }
  | { readonly op: 'and' | 'or'; readonly a: FormulaTree; readonly b: FormulaTree };

/**
 * Parse `state X`, an expression leaf, `not F`, `F and F`, `F or F`, `( F )`; `not` binds tighter than `and`, `and`
 * tighter than `or`. An expression leaf runs to the next `and`/`or` outside its own parentheses (so an expression
 * written with `and` is split into leaves, which reads the same). A `(` opens a group only when what follows the
 * closing `)` is a connective, a `)` or the end; otherwise it begins an expression leaf, as `(n + 1) > 2` does.
 * Returns null where the text is not that grammar, so the caller falls back to the reading it had before.
 */
function parseFormula(tokens: readonly string[]): { tree: FormulaTree; connectives: number; states: number } | null {
  let i = 0;
  let connectives = 0;
  let states = 0;
  const KW = new Set(['trigger', 'fires', 'node']);
  const leaf = (): FormulaTree | null => {
    const start = i;
    let depth = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '(') depth++;
      else if (t === ')') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (t === 'and' || t === 'or')) break;
      i++;
    }
    if (depth !== 0 || i === start) return null;
    const words = tokens.slice(start, i);
    const text = words.join(' ');
    return KW.has(words[0]) && words.length > 1 ? { op: 'step', text } : { op: 'expr', text };
  };
  const atom = (): FormulaTree | null => {
    const t = tokens[i];
    if (t === undefined) return null;
    if (t === 'not') {
      i++;
      connectives++;
      const a = atom();
      return a === null ? null : { op: 'not', a };
    }
    if (t === '(') {
      const save = i;
      const saveC = connectives;
      const saveS = states;
      i++;
      const e = or();
      if (e !== null && tokens[i] === ')') {
        const next = tokens[i + 1];
        if (next === undefined || next === 'and' || next === 'or' || next === ')') {
          i++;
          connectives++;
          return e;
        }
      }
      i = save;
      connectives = saveC;
      states = saveS;
      return leaf();
    }
    if (t === 'state') {
      const n = tokens[i + 1];
      if (n === undefined || n === '(' || n === ')') return null;
      // `state X` is a leaf only when nothing but a connective follows; `state s == 1` stays an expression leaf.
      const after = tokens[i + 2];
      if (after === undefined || after === 'and' || after === 'or' || after === ')') {
        i += 2;
        states++;
        return { op: 'name', name: n };
      }
      return null;
    }
    return leaf();
  };
  const and = (): FormulaTree | null => {
    let a = atom();
    while (a !== null && tokens[i] === 'and') {
      i++;
      connectives++;
      const b = atom();
      if (b === null) return null;
      a = { op: 'and', a, b };
    }
    return a;
  };
  const or = (): FormulaTree | null => {
    let a = and();
    while (a !== null && tokens[i] === 'or') {
      i++;
      connectives++;
      const b = and();
      if (b === null) return null;
      a = { op: 'or', a, b };
    }
    return a;
  };
  const tree = or();
  return tree === null || i !== tokens.length ? null : { tree, connectives, states };
}

/**
 * `state A and state B`, `state A and n > 3`, `not state A`, resolved against the machine. A `state` leaf that names no
 * state, or several, refuses the WHOLE property (`resolveNamed`): an unresolved leaf is never read as false. So does a
 * trigger / transition / node leaf (a step, not a configuration predicate) and an expression leaf that does not parse.
 * A text with no `state` leaf is not read here: it is a plain expression, read as before.
 */
function readFormula(model: Model, machineId: ElementId, text: string): AtomResult | null {
  const tokens = formulaTokens(text);
  if (tokens === null) return null;
  const parsed = parseFormula(tokens);
  if (parsed === null || parsed.connectives === 0 || parsed.states === 0) return null;
  const pool = statesOf(model, machineId);
  let refusal: AtomRefusal | null = null;
  const refuse = (r: AtomRefusal): null => {
    refusal ??= r;
    return null;
  };
  const build = (t: FormulaTree): StateFormula | null => {
    if (t.op === 'not') {
      const a = build(t.a);
      return a === null ? null : { op: 'not', a };
    }
    if (t.op === 'step') {
      return refuse({
        code: UNKNOWN_ATOM_CODE,
        detail:
          `\`${t.text}\` is a step (a trigger, a transition or a node), not a predicate of one configuration, so it ` +
          'cannot be combined with a `state` or an expression in one formula; state it as its own property.',
        candidates: [],
      });
    }
    if (t.op === 'expr') {
      try {
        parseExpr(t.text);
      } catch (err) {
        return refuse({
          code: MALFORMED_PROPERTY_CODE,
          detail: `\`${t.text}\` is not an expression this tool can read: ${err instanceof Error ? err.message : String(err)}.`,
          candidates: [],
        });
      }
      return { op: 'expr', text: t.text };
    }
    if (t.op === 'name') {
      const name = t.name.includes("'") ? refSegments(t.name).join('::') : t.name;
      const r = resolveNamed(model, pool, name, 'state', `state ${t.name}`);
      if (!r.ok) return refuse(r.refusal);
      return { op: 'state', id: r.atom.elementId! };
    }
    const a = build(t.a);
    const b = build(t.b);
    return a === null || b === null ? null : { op: t.op, a, b };
  };
  const formula = build(parsed.tree);
  if (formula === null) return { ok: false, refusal: refusal! };
  return { ok: true, atom: { kind: 'formula', text, argument: text, formula } };
}

/**
 * Read one atom, resolved against the machine it is about.
 *
 * The keyword is taken off the front and the rest is a name; anything with no
 * keyword is an expression. That ordering is deliberate: `state` is a name a
 * model could plausibly give a feature, and reading `state x` as an expression
 * because a feature happened to be called `state` would silently change what
 * the property means.
 */
export function readAtom(model: Model, machineId: ElementId, raw: string): AtomResult {
  const text = raw.trim();
  if (text === '') {
    return {
      ok: false,
      refusal: {
        code: MALFORMED_PROPERTY_CODE,
        detail:
          'an empty atom: a pattern field was declared and left blank, so there is no predicate ' +
          'to check. Write `state X`, `trigger t`, `fires T`, `node N`, or an expression.',
        candidates: [],
      },
    };
  }
  // A Boolean combination of `state` atoms; any other text that is not one reads as it did before.
  {
    const combined = readFormula(model, machineId, text);
    if (combined !== null) return combined;
  }
  for (const kw of KEYWORDS) {
    if (!text.startsWith(`${kw} `)) continue;
    // A quoted name (`state 'deg A'`, `state M::'deg A'`) is the name it quotes, as everywhere else a name is read:
    // its segments are unquoted and rejoined with `::`, the separator a qualified name prints with.
    const written = text.slice(kw.length + 1).trim();
    const name = written.includes("'") ? refSegments(written).join('::') : written;
    if (name === '') {
      return {
        ok: false,
        refusal: {
          code: MALFORMED_PROPERTY_CODE,
          detail: `\`${text}\` names nothing after \`${kw}\``,
          candidates: [],
        },
      };
    }
    if (kw === 'trigger') {
      const triggers = triggersOf(model, machineId);
      if (!triggers.includes(name)) {
        return {
          ok: false,
          refusal: {
            code: UNKNOWN_ATOM_CODE,
            detail:
              `\`${text}\` names a trigger this machine never declares` +
              (triggers.length > 0
                ? ` — it names ${candidateList(triggers)
                    .map((t) => `\`${t}\``)
                    .join(', ')}`
                : ', and it names none at all: every transition in it is trigger-less'),
            candidates: candidateList(triggers),
          },
        };
      }
      return { ok: true, atom: { kind: 'trigger', text, argument: name } };
    }
    const pool =
      kw === 'state'
        ? statesOf(model, machineId)
        : kw === 'node'
          ? nodesOf(model, machineId)
          : namedTransitions(model, machineId);
    return resolveNamed(model, pool, name, kw, text);
  }
  // Anything else is an expression, and it has to PARSE before it is accepted:
  // a clause refused here is refused before any verdict stands on it.
  try {
    // `evalStr` swallows a parse failure and answers `undefined`, which is the
    // right behaviour for a guard and the wrong one for a gate — so the parse
    // is asked for here, where a failure can be reported as one.
    parseExpr(text);
  } catch (err) {
    return {
      ok: false,
      refusal: {
        code: MALFORMED_PROPERTY_CODE,
        detail:
          `\`${text}\` is not an expression this tool can read: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'Write `state X`, `trigger t`, `fires T`, `node N`, or a boolean expression over the ' +
          "machine's own features.",
        candidates: [],
      },
    };
  }
  return { ok: true, atom: { kind: 'expression', text, argument: text } };
}

/**
 * Does this atom hold at this observation?
 *
 * `undefined` means NOT EVALUABLE, and the caller must turn it into a refusal
 * rather than into a `false` — see the fail-direction paragraph in the header.
 * Only an expression atom can produce it: the other four are membership tests
 * against sets the walk already holds.
 */
export function atomHolds(model: Model, atom: Atom, obs: Observation): boolean | undefined {
  switch (atom.kind) {
    case 'state':
      // On the active STACK, not just the leaf: in a hierarchical machine the
      // composite state is active while its substate is, and a property about
      // `Degraded` that went false the moment the machine entered a substate of
      // it would be a property about the leaf wearing the name of the state.
      return activeStatesOf(obs.config).includes(atom.elementId!);
    case 'node':
      return leafOf(obs.config) === atom.elementId || activeLeavesOf(obs.config).includes(atom.elementId!);
    case 'trigger':
      return obs.input?.kind === 'trigger' && obs.input.trigger === atom.argument;
    case 'fires':
      return obs.fired !== undefined ? obs.fired.includes(atom.elementId!) : obs.transition?.id === atom.elementId;
    case 'formula': {
      const scope = regionScope(model, obs.config.regionId);
      return formulaHolds(atom.formula!, activeStatesOf(obs.config), (t) => {
        const v = evalStr(t, obs.config.store, scope);
        return typeof v === 'boolean' ? v : undefined;
      });
    }
    case 'expression': {
      const scope = regionScope(model, obs.config.regionId);
      const value = evalStr(atom.argument, obs.config.store, scope);
      return typeof value === 'boolean' ? value : undefined;
    }
  }
}

/**
 * Why an expression atom did not evaluate to a boolean, as a refusal.
 *
 * Computed only when it happens, and that is the point: an identifier check run
 * up front would refuse a name the machine ASSIGNS during a run — the store
 * grows as effects fire — and a property refused for naming a feature that does
 * exist is worse than one refused late. Here the walk has an actual
 * configuration in hand, so the question "is this name offered anywhere" has an
 * answer rather than a guess.
 */
export function expressionRefusal(
  model: Model,
  atom: Atom,
  obs: Observation,
): AtomRefusal {
  if (atom.kind === 'formula') {
    // The first expression leaf the configuration could not decide names the refusal.
    const scope0 = regionScope(model, obs.config.regionId);
    const leaves: string[] = [];
    const collect = (f: StateFormula): void => {
      if (f.op === 'expr') leaves.push(f.text);
      else if (f.op === 'not') collect(f.a);
      else if (f.op !== 'state') {
        collect(f.a);
        collect(f.b);
      }
    };
    collect(atom.formula!);
    const bad = leaves.find((t) => typeof evalStr(t, obs.config.store, scope0) !== 'boolean') ?? leaves[0];
    return expressionRefusal(model, { kind: 'expression', text: bad, argument: bad }, obs);
  }
  const scope = storeScope(obs.config.store, regionScope(model, obs.config.regionId));
  const identifiers = writtenChains(atom.argument)
    .map((c) => (c.includes("'") ? refSegments(c).join('.') : c))
    .filter((n) => !RESERVED.has(n));
  const unknown = identifiers.filter((n) => scope(n) === undefined && scope(n.split('.')[0]) === undefined);
  if (unknown.length > 0) {
    return {
      code: UNKNOWN_ATOM_CODE,
      detail:
        `\`${atom.text}\` reads ${unknown.map((n) => `\`${n}\``).join(', ')}, which ` +
        `${unknown.length === 1 ? 'names' : 'name'} nothing in the scope of this machine — ` +
        'so the clause could not be evaluated where the walk offered it.',
      candidates: candidateList([...obs.config.store.keys()]),
    };
  }
  return {
    code: MALFORMED_PROPERTY_CODE,
    detail:
      `\`${atom.text}\` did not evaluate to a boolean in a configuration the walk reached: an ` +
      'atom is a predicate, and a clause that yields a number (or nothing) is not one. ' +
      'Compare it: `mode == 3` rather than `mode`.',
    candidates: [],
  };
}
