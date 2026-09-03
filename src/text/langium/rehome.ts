/**
 * Post-fault RE-HOMING of declarations that error recovery moved out of their
 * enclosing body.
 *
 * WHY. When a member fails to parse, Chevrotain re-syncs by leaving the `Body`
 * rule rather than the failed `Member`, so the parent's body is truncated at the
 * fault and every declaration after it is parsed one scope OUT: `package P {
 * part def A; blok def B; part def C; }` yields `C` as a ROOT, and a fault two
 * levels deep escapes twice. The elements survive; their containment does not,
 * and a save after a failed apply makes that loss permanent. Langium exposes no
 * hook to choose a re-sync token, so this is repaired after the fact from two
 * things the parser cannot corrupt: each declaration's source offset, and the
 * brace structure of the text itself.
 *
 * WHEN. Only when the parse reported errors, and only when the braces balance.
 * An unbalanced file (`L2-missing-closing-brace`, `L2-extra-closing-brace`) is
 * genuinely ambiguous about where anything belongs, so the pass declines rather
 * than guess. The brace scan follows the lexer for comments and NOTES — a `//*`
 * note is hidden and multi-line — because a scan that disagreed with it made a
 * faulted file look balanced BY COINCIDENCE and grew a phantom body out of the
 * difference. It does NOT follow the lexer everywhere: the quote scan stops at
 * a newline, while `UNRESTRICTED_NAME` and `STRING` are newline-tolerant, so a
 * brace inside a MULTI-LINE quoted name is still counted as real. That is the
 * remaining coincidence shape, recorded in the campaign ledger.
 *
 * WHERE. Called from `Mapper.run` between the member walk and the deferred
 * reference pass, so references that failed only because of wrong ownership
 * resolve normally afterwards and their warnings are retracted.
 */

import type { ElementId, Model } from '@core/index';
import { isRelationship } from '@core/index';
import type { TextRange } from '@validation/types';

/** An opening brace and the offset of its matching close. */
interface BracePair {
  open: number;
  close: number;
}

/**
 * Every balanced `{ … }` pair in `text`, skipping strings and comments with the
 * same rules as the lexical scan. Returns `undefined` when the braces do not
 * balance, which is the caller's signal to decline.
 */
export function bracePairs(text: string): BracePair[] | undefined {
  const pairs: BracePair[] = [];
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      // A NOTE is hidden and MULTI-LINE (`//*` … `*/`, sysml.langium ML_NOTE);
      // a `//` comment is hidden to end of line. The order mirrors the lexer:
      // the note terminal is tried first, and when it has no closer its regex
      // fails and SL_COMMENT wins — so an unterminated `//*` is a plain line
      // comment on a VALID file, never a reason to decline. Reading a note as
      // a line comment swallowed only its FIRST line and counted the braces on
      // the rest as real, which is how a faulted file could become
      // brace-balanced by coincidence and grow a phantom body.
      if (text[i + 2] === '*') {
        const noteClose = text.indexOf('*/', i + 3);
        if (noteClose !== -1) {
          i = noteClose + 1;
          continue;
        }
      }
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return undefined; // unterminated: the lexical scan owns this
      i = close + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== '\n' && text[j] !== c) {
        if (text[j] === '\\') j++;
        j++;
      }
      i = j;
      continue;
    }
    if (c === '{') stack.push(i);
    else if (c === '}') {
      const open = stack.pop();
      if (open === undefined) return undefined; // more closes than opens
      pairs.push({ open, close: i });
    }
  }
  return stack.length === 0 ? pairs : undefined;
}

/**
 * Move every element declared after `faultOffset` under the element that opened
 * the innermost `{` still open at its position. Returns the number moved.
 *
 * Candidates are non-implicit elements that carry a source range — implicit
 * features are created by the mapper's own passes and are owned correctly by
 * construction, and a relationship written as a STATEMENT escapes recovery
 * like anything else (only one owned by its own source is excluded; see the
 * filter below). The owner of a candidate is the latest-starting ranged
 * element declared before the enclosing brace — "the thing whose body this
 * is". Ranges are start-anchored on purpose: the faulted parent's range is
 * truncated at the fault, so containment cannot be used.
 */
export function rehomeAfterFault(
  model: Model,
  text: string,
  ranges: Map<ElementId, TextRange>,
  faultOffset: number,
): number {
  const pairs = bracePairs(text);
  if (pairs === undefined || pairs.length === 0) return 0;

  // Ranged, non-implicit elements in source order.
  //
  // Relationships are INCLUDED. A statement-form relationship (`import`,
  // `alias`, `dependency`, `succession`, a forward-source `subset x subsets
  // y;`) escapes recovery exactly like a declaration does — an escaped
  // `import` silently leaves the package it scopes — and a body owned by one
  // (`alias b for a { … }`, mapped under a Membership) needs it as an OPENER
  // or its members are re-homed onto the previous sibling.
  //
  // The one exclusion is a relationship owned by its own SOURCE: an inline
  // specialization (`part def X :> Y { … }`) shares its owner's start offset
  // and, being inserted after it in this insertion-ordered map, would win the
  // opener tie-break and steal the body it is written on.
  //
  // As the mapper stands TODAY no such element exists when this runs: every
  // relationship the member walk creates is built with an empty `source`, and
  // the deliberate reparent onto the source happens later, in
  // `resolveDeferredRefs`. The clause is therefore a guard on that ORDER, not
  // on anything the current pipeline produces — move this pass after the
  // deferred pass and the tie-break becomes reachable at once. It is pinned by
  // a hand-built model in `test/unit/text.rehome.test.ts` for that reason.
  const ranged = [...ranges]
    .map(([id, r]) => ({ id, start: r.start.offset, el: model.get(id) }))
    .filter(
      (x) =>
        x.el !== undefined &&
        x.el.attrs.implicit !== true &&
        !(
          isRelationship(x.el.eClass) &&
          x.el.ownerId !== null &&
          (x.el.source ?? []).includes(x.el.ownerId)
        ),
    )
    .sort((a, b) => a.start - b.start);

  /** The element that owns the body opened at `open`: latest start before it. */
  const openerOf = (open: number): ElementId | undefined => {
    let best: (typeof ranged)[number] | undefined;
    for (const x of ranged) {
      if (x.start >= open) break;
      best = x;
    }
    return best?.id;
  };

  /** Innermost brace pair enclosing `offset`. */
  const enclosing = (offset: number): BracePair | undefined => {
    let best: BracePair | undefined;
    for (const p of pairs) {
      if (p.open < offset && offset < p.close && (best === undefined || p.open > best.open)) best = p;
    }
    return best;
  };

  const isAncestorOf = (maybeAncestor: ElementId, id: ElementId): boolean =>
    model.ancestors(id).some((a) => a.id === maybeAncestor);

  let moved = 0;
  for (const x of ranged) {
    // Everything from the fault onward is a recovery product — including the
    // residue of the faulty declaration itself, whose range starts AT the fault.
    if (x.start < faultOffset) continue;
    const brace = enclosing(x.start);
    const wantOwner = brace === undefined ? null : (openerOf(brace.open) ?? null);
    if (wantOwner === x.id) continue;
    if (wantOwner !== null && isAncestorOf(x.id, wantOwner)) continue; // never create a cycle
    if ((x.el?.ownerId ?? null) === wantOwner) continue;
    model.reparent(x.id, wantOwner);
    moved++;
  }
  return moved;
}
