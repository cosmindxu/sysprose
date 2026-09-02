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
 * than guess. A file that is faulted AND brace-balanced by coincidence can still
 * be mis-homed; that is the documented residual.
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
 * Candidates are non-relationship, non-implicit elements that carry a source
 * range (relationships and implicit features are created by the mapper's own
 * passes and are owned correctly by construction). The owner of a candidate is
 * the latest-starting ranged, non-relationship element declared before the
 * enclosing brace — "the thing whose body this is". Ranges are start-anchored
 * on purpose: the faulted parent's range is truncated at the fault, so
 * containment cannot be used.
 */
export function rehomeAfterFault(
  model: Model,
  text: string,
  ranges: Map<ElementId, TextRange>,
  faultOffset: number,
): number {
  const pairs = bracePairs(text);
  if (pairs === undefined || pairs.length === 0) return 0;

  // Ranged, non-relationship, non-implicit elements in source order.
  const ranged = [...ranges]
    .map(([id, r]) => ({ id, start: r.start.offset, el: model.get(id) }))
    .filter(
      (x) =>
        x.el !== undefined && !isRelationship(x.el.eClass) && x.el.attrs.implicit !== true,
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
