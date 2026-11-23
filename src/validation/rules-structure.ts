/**
 * Structure rules over multiplicities and bindings: `multiplicity-conformance`
 * and `binding-conformance`. Their own module, so they can be tested and
 * reviewed on their own; the registry in `rules.ts` lists them.
 *
 * Spec readings (SysML v2, `/tmp/ps3/spec/part1.txt`, verified by reading):
 *  - §7.6.3 Usages (lines ~3330-3362): a multiplicity is a range
 *    `[lowerBound..upperBound]` of natural numbers; a single bound is both
 *    bounds. A range whose lower bound exceeds its upper bound has no cardinality
 *    that satisfies it.
 *  - §7.6.1 (lines ~2836-2846): "A subsetting usage has a subset of the values of
 *    the subsetted usage"; its multiplicity may further constrain the subsetted
 *    one (the example subsets `wheels [4..8]` by features `[1..1]` and `[0..1]`,
 *    so a subsetting feature's LOWER bound may be below the superset's, and
 *    several subsetters' lower bounds add up). What cannot hold is an upper bound
 *    above the superset's: the subset can then hold more values than the set.
 *  - §7.6.3 (lines ~3350-3358): a usage that subsets or redefines inherits the
 *    constraints of the usage; the example `ref item redefines children[0]`
 *    narrows `children[0..numberOfChildren]`. A redefinition replaces the
 *    redefined feature in its owner, so it may only narrow: its range must lie
 *    within the redefined feature's (KerML: a redefining feature's multiplicity
 *    is a constraint on the same values).
 *  - §7.13.3 Bindings as Usages (lines ~5145-5175): a binding relates two
 *    features by `bind a = b`; §7.13.4 reads it as "the feature is equivalent to"
 *    the other, and the graphical notation (8.2.3.13, line ~13696) says "the
 *    usage-nodes at the ends of a binding-connection must be of compatible
 *    types". The text of 7.13.3 states no multiplicity equality; a binding whose
 *    ends declare multiplicities with no cardinality in common cannot hold, which
 *    is all that is flagged (differing but overlapping ranges are legal).
 *
 * Both are WARNINGS (user ruling, to be promoted to errors later). Only bounds
 * written as natural-number literals are read; a bound that names a usage, an
 * inherited multiplicity, or an unresolved type gives no finding.
 */

import type { ElementId, ElementRecord, Model } from '@core/index';
import { findLibraryType } from '../library/resolve';
import { conforms } from '../semantics/conformance';
import { resolveQualifiedNameFull } from '../semantics';
import { generalizationsOf } from '../semantics/inheritance';
import type { Diagnostic, ValidationRule } from './types';

/** A feature's declared type element (a name in `attrs.type`/`typeRef`, else its FeatureTyping), `undefined` when absent or unresolved. */
function declaredTypeElementId(model: Model, featureId: ElementId): ElementId | undefined {
  const el = model.get(featureId);
  if (!el) return undefined;
  const raw = el.attrs.type ?? el.attrs.typeRef;
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name !== '') {
    const lib = findLibraryType(model, name);
    if (lib) return lib.id;
    const q = resolveQualifiedNameFull(model, name);
    if (q) return q.id;
  }
  for (const r of model.relationshipsFrom(featureId)) {
    if (r.eClass === 'FeatureTyping') {
      const t = r.target?.[0];
      if (t && model.has(t)) return t;
    }
  }
  return undefined;
}

/** A range `[lo, hi]`; `hi` is `Infinity` for `*`. */
interface Range {
  lo: number;
  hi: number;
}

/**
 * The range a feature's own `attrs.multiplicity` states, or `undefined` when it
 * states none or a bound is not a plain literal. `5` is `[5, 5]`, `*` is
 * `[0, *]` (§7.6.3), `1..*` and `2..4` are themselves.
 */
export function statedRange(el: ElementRecord): Range | undefined {
  const m = el.attrs.multiplicity;
  if (typeof m !== 'string') return undefined;
  const parts = m.replace(/^\[|\]$/g, '').split('..').map((x) => x.trim());
  const bound = (s: string): number | undefined => (s === '*' ? Infinity : /^\d+$/.test(s) ? Number(s) : undefined);
  if (parts.length === 1) {
    const b = bound(parts[0]!);
    if (b === undefined) return undefined;
    return b === Infinity ? { lo: 0, hi: Infinity } : { lo: b, hi: b };
  }
  if (parts.length !== 2) return undefined;
  const lo = bound(parts[0]!);
  const hi = bound(parts[1]!);
  if (lo === undefined || hi === undefined || lo === Infinity) return undefined;
  return { lo, hi };
}

function show(r: Range): string {
  const hi = r.hi === Infinity ? '*' : String(r.hi);
  return r.lo === r.hi ? `[${hi}]` : `[${r.lo}..${hi}]`;
}

function qualifiedLabel(model: Model, el: ElementRecord): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur: ElementRecord | undefined = el;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.declaredName ?? cur.declaredShortName ?? `«${cur.eClass}»`);
    cur = cur.ownerId !== null ? model.get(cur.ownerId) : undefined;
  }
  return parts.join('::');
}

/** The name a redefining feature goes by: its own, else the one it redefines. */
function featureLabel(model: Model, el: ElementRecord): string {
  if (el.declaredName ?? el.declaredShortName) return qualifiedLabel(model, el);
  const red = model.relationshipsFrom(el.id).find((r) => r.eClass === 'Redefinition');
  const t = red?.target?.[0] ? model.get(red.target[0]) : undefined;
  const owner = el.ownerId !== null ? model.get(el.ownerId) : undefined;
  return `${owner ? qualifiedLabel(model, owner) + '::' : ''}${t?.declaredName ?? `«${el.eClass}»`}`;
}

export const multiplicityConformance: ValidationRule = {
  id: 'multiplicity-conformance',
  description: 'A multiplicity with lower above upper, a subsetting feature above its superset, or a redefinition that widens.',
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    const mk = (message: string, elementId: ElementId): void => {
      out.push({ id: `multiplicity-conformance#${n++}`, ruleId: 'multiplicity-conformance', severity: 'warning', message, elementId });
    };
    for (const el of model.all()) {
      if (el.attrs.isLibrary === true || el.attrs.implicit === true) continue;
      const own = statedRange(el);
      if (own && own.lo > own.hi) {
        mk(`${featureLabel(model, el)} declares multiplicity ${show(own)}, whose lower bound is above its upper bound: no number of values satisfies it (§7.6.3).`, el.id);
      }
    }
    for (const rel of model.all()) {
      if (rel.attrs.isLibrary === true) continue;
      if (rel.eClass !== 'Subsetting' && rel.eClass !== 'Redefinition') continue;
      const subId = rel.source?.[0];
      const superId = rel.target?.[0];
      if (!subId || !superId) continue;
      const sub = model.get(subId);
      const sup = model.get(superId);
      if (!sub || !sup || sub.attrs.implicit === true) continue;
      const a = statedRange(sub);
      const b = statedRange(sup);
      if (!a || !b || a.lo > a.hi || b.lo > b.hi) continue;
      if (rel.eClass === 'Subsetting') {
        if (a.hi > b.hi) {
          mk(`${featureLabel(model, sub)} ${show(a)} subsets ${qualifiedLabel(model, sup)} ${show(b)}, but its upper bound is above the subsetted feature's: a subset of the values cannot have more of them (§7.6.1).`, sub.id);
        }
      } else if (a.hi > b.hi || a.lo < b.lo) {
        mk(`${featureLabel(model, sub)} ${show(a)} redefines ${qualifiedLabel(model, sup)} ${show(b)} and widens its bounds: a redefinition may only narrow the multiplicity of the feature it redefines (§7.6.3).`, sub.id);
      }
    }
    return out;
  },
};

/** The type a feature is declared with, else the one its prototype is (an implicit per-usage copy carries none). */
function typeOf(model: Model, id: ElementId): ElementId | undefined {
  const own = declaredTypeElementId(model, id);
  if (own) return own;
  for (const g of generalizationsOf(model, id)) {
    if (g.eClass.endsWith('Definition')) continue;
    const t = declaredTypeElementId(model, g.id);
    if (t) return t;
  }
  return undefined;
}

/** The multiplicity a feature states, else its prototype's (the redefined feature the end copy stands for). */
function rangeOf(model: Model, el: ElementRecord): Range | undefined {
  const own = statedRange(el);
  if (own) return own;
  if (el.attrs.implicit !== true) return undefined;
  for (const g of generalizationsOf(model, el.id)) {
    if (g.eClass.endsWith('Definition')) continue;
    const r = statedRange(g);
    if (r) return r;
  }
  return undefined;
}

export const bindingConformance: ValidationRule = {
  id: 'binding-conformance',
  description: 'The ends of a binding have types that do not conform either way, or multiplicities with no cardinality in common.',
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (el.attrs.isLibrary === true || el.eClass !== 'BindingConnectorAsUsage' || el.attrs.staleEnd === true) continue;
      const aId = el.source?.[0];
      const bId = el.target?.[0];
      const a = aId ? model.get(aId) : undefined;
      const b = bId ? model.get(bId) : undefined;
      if (!a || !b) continue;
      const mk = (message: string): void => {
        out.push({ id: `binding-conformance#${n++}`, ruleId: 'binding-conformance', severity: 'warning', message, elementId: el.id });
      };
      const ta = typeOf(model, a.id);
      const tb = typeOf(model, b.id);
      if (ta && tb && !conforms(model, ta, tb) && !conforms(model, tb, ta)) {
        mk(
          `Binding ${qualifiedLabel(model, el)} relates ${qualifiedLabel(model, a)} : ${model.get(ta)?.declaredName ?? ta} to ${qualifiedLabel(model, b)} : ${model.get(tb)?.declaredName ?? tb}, and neither type specialises the other: a binding makes its two features equivalent, so their types must be compatible (§7.13.3, §8.2.3.13).`,
        );
      }
      const ra = rangeOf(model, a);
      const rb = rangeOf(model, b);
      if (ra && rb && ra.lo <= ra.hi && rb.lo <= rb.hi && (ra.hi < rb.lo || rb.hi < ra.lo)) {
        mk(
          `Binding ${qualifiedLabel(model, el)} relates ${qualifiedLabel(model, a)} ${show(ra)} to ${qualifiedLabel(model, b)} ${show(rb)}: the two multiplicities have no cardinality in common, so the binding cannot hold (§7.13.3).`,
        );
      }
    }
    return out;
  },
};
