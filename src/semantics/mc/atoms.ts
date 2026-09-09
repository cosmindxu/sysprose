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

import type { ElementId, ElementRecord, Model } from '@core/index';
import { parseExpr } from '../expr';
import {
  evalStr,
  leafOf,
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
export type AtomKind = 'state' | 'trigger' | 'fires' | 'node' | 'expression';

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

/** Every state inside the machine, for `state X` and for a refusal's candidates. */
function statesOf(model: Model, machineId: ElementId): ElementRecord[] {
  return model.descendants(machineId).filter((e) => e.eClass === 'StateUsage');
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
  return model
    .descendants(machineId)
    .filter(
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
  return model
    .descendants(machineId)
    .filter((e) => e.eClass === 'TransitionUsage' && (e.declaredName ?? '') !== '');
}

/** The distinct triggers the machine names, in declaration order. */
function triggersOf(model: Model, machineId: ElementId): string[] {
  const out: string[] = [];
  for (const tr of model.descendants(machineId)) {
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
    (c) => c.declaredName === name || model.qualifiedName(c.id) === name,
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
  for (const kw of KEYWORDS) {
    if (!text.startsWith(`${kw} `)) continue;
    const name = text.slice(kw.length + 1).trim();
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
      return obs.config.stack.includes(atom.elementId!);
    case 'node':
      return leafOf(obs.config) === atom.elementId;
    case 'trigger':
      return obs.input?.kind === 'trigger' && obs.input.trigger === atom.argument;
    case 'fires':
      return obs.transition?.id === atom.elementId;
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
  const scope = storeScope(obs.config.store, regionScope(model, obs.config.regionId));
  const identifiers = [...atom.argument.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)]
    .map((m) => m[0])
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
