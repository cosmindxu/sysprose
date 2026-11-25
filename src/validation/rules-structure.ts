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
 * Wave 2 (BD3, BD6-BD9, BD11) adds `subset-type-conformance`,
 * `disjoint-sum-exceeds`, `enum-value-not-member`, `value-multiplicity-mismatch`,
 * `specialization-kind-incompatible` and `unresolved-value-chain`; each carries its
 * own spec reading above its rule. All are WARNINGS.
 *
 * Both of the first two are WARNINGS (user ruling, to be promoted to errors later). Only bounds
 * written as natural-number literals are read; a bound that names a usage, an
 * inherited multiplicity, or an unresolved type gives no finding.
 */

import type { ElementId, ElementRecord, Model } from '@core/index';
import { findLibraryType } from '../library/resolve';
import { conforms } from '../semantics/conformance';
import { endPairs } from '../semantics/port-conformance';
import { resolveQualifiedNameFull } from '../semantics';
import { childNamed, findTypeFeature, resolveFullName } from '../semantics/bind';
import { effectiveFeaturesWithLibrary } from '../semantics/featuring';
import { effectiveNameOf, generalizationsOf } from '../semantics/inheritance';
import { DIRECT_SUPERTYPES, isKindOf } from '../semantics/metaclasses';
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


/** Every type a feature declares: its `:` name and each FeatureTyping, resolved ones only. */
function allDeclaredTypes(model: Model, featureId: ElementId): ElementId[] {
  const out: ElementId[] = [];
  const first = declaredTypeElementId(model, featureId);
  if (first) out.push(first);
  for (const r of model.relationshipsFrom(featureId)) {
    if (r.eClass !== 'FeatureTyping') continue;
    const t = r.target?.[0];
    if (t && model.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

const isUserElement = (el: ElementRecord): boolean => el.attrs.isLibrary !== true && el.attrs.implicit !== true;

/**
 * BD3 `subset-type-conformance`.
 *
 * Spec (§7.6.1, lines ~2836-2846): "A subsetting usage has a subset of the values
 * of the subsetted usage". Every value of the subsetter is then a value of the
 * subsetted usage, so the subsetter's type must be the subsetted usage's type or
 * a specialisation of it (§7.6.3: a usage that subsets inherits the subsetted
 * usage's constraints, its typing among them). `part b : B subsets a` over
 * `part a : A` with neither of A, B specialising the other has values that are
 * not values of `a`. A subsetter's types are those it declares and those of the
 * features it redefines (a redefinition has the redefined feature's typing, §7.6.3);
 * one that only inherits a type through the subsetting has it by the subsetting
 * itself. It is judged only when it has some type and none conforms; a type that
 * does not resolve gives no finding.
 * Redefinitions are `redefinition-conformance`'s.
 */
export const subsetTypeConformance: ValidationRule = {
  id: 'subset-type-conformance',
  description: "A subsetting feature's declared type does not conform to the subsetted feature's type.",
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    for (const rel of model.all()) {
      if (rel.eClass !== 'Subsetting' || rel.attrs.isLibrary === true) continue;
      const subId = rel.source?.[0];
      const superId = rel.target?.[0];
      if (!subId || !superId || subId === superId) continue;
      const sub = model.get(subId);
      const sup = model.get(superId);
      if (!sub || !sup || !isUserElement(sub)) continue;
      const subTypes = allDeclaredTypes(model, subId);
      // A redefining feature has the typing of the feature it redefines (`part c redefines x subsets a`, `x : B`).
      const seen = new Set<ElementId>([subId]);
      const queue = [subId];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const r of model.relationshipsFrom(cur)) {
          const t = r.eClass === 'Redefinition' ? r.target?.[0] : undefined;
          if (!t || seen.has(t) || !model.has(t) || t === superId) continue;
          seen.add(t);
          queue.push(t);
          for (const ty of allDeclaredTypes(model, t)) if (!subTypes.includes(ty)) subTypes.push(ty);
        }
      }
      const supType = typeOf(model, superId);
      if (subTypes.length === 0 || !supType) continue;
      if (subTypes.some((t) => conforms(model, t, supType))) continue;
      const name = (id: ElementId): string => model.get(id)?.declaredName ?? id;
      out.push({
        id: `subset-type-conformance#${n++}`,
        ruleId: 'subset-type-conformance',
        severity: 'warning',
        message: `${featureLabel(model, sub)} : ${subTypes.map(name).join(', ')} subsets ${qualifiedLabel(model, sup)} : ${name(supType)}, but its type does not specialise the subsetted feature's: a subset of the values must be values of that type (§7.6.1).`,
        elementId: sub.id,
      });
    }
    return out;
  },
};

/**
 * BD6 `disjoint-sum-exceeds`.
 *
 * Spec: §7.6.1 (lines ~2836-2846) a subsetting feature holds a subset of the
 * values of the subsetted one; KerML `disjoint a from b` (the Disjoining
 * relationship, textual `disjoint a from b;`) says the two share no value. Where
 * features that pairwise disjoint from each other all subset one feature, each
 * holds at least its own lower bound of values, none of them shared, so the
 * lower bounds add up inside the superset: the sum must not exceed the
 * superset's upper bound. (`wheels [4]` with `front [3]` and `rear [3]` disjoint
 * from each other would need six.) Only bounds written as literals are read; a
 * superset with no stated multiplicity gives no finding.
 */
export const disjointSumExceeds: ValidationRule = {
  id: 'disjoint-sum-exceeds',
  description: 'Features declared disjoint that subset one feature have lower bounds adding up above its upper bound.',
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    const disjoint = new Map<ElementId, Set<ElementId>>();
    for (const rel of model.all()) {
      if (rel.eClass !== 'Disjoining' || rel.attrs.isLibrary === true) continue;
      const a = rel.source?.[0];
      const b = rel.target?.[0];
      if (!a || !b || a === b) continue;
      for (const [x, y] of [[a, b], [b, a]] as const) {
        const set = disjoint.get(x) ?? new Set<ElementId>();
        set.add(y);
        disjoint.set(x, set);
      }
    }
    if (disjoint.size === 0) return out;
    const subsetters = new Map<ElementId, ElementId[]>();
    for (const rel of model.all()) {
      if (rel.eClass !== 'Subsetting' || rel.attrs.isLibrary === true) continue;
      const sub = rel.source?.[0];
      const sup = rel.target?.[0];
      if (!sub || !sup || !disjoint.has(sub)) continue;
      const list = subsetters.get(sup) ?? [];
      if (!list.includes(sub)) list.push(sub);
      subsetters.set(sup, list);
    }
    for (const [supId, subs] of subsetters) {
      const sup = model.get(supId);
      const hi = sup ? statedRange(sup) : undefined;
      if (!sup || !hi || hi.hi === Infinity || subs.length < 2) continue;
      const lowers = new Map<ElementId, number>();
      for (const s of subs) {
        const r = model.get(s) ? statedRange(model.get(s)!) : undefined;
        if (r && r.lo <= r.hi) lowers.set(s, r.lo);
      }
      const cand = subs.filter((s) => lowers.has(s));
      // The heaviest set of pairwise-disjoint subsetters (a clique), by exhaustive search over a small set.
      let best: ElementId[] = [];
      let bestSum = 0;
      const search = (chosen: ElementId[], rest: ElementId[], sum: number): void => {
        if (sum > bestSum) {
          bestSum = sum;
          best = chosen;
        }
        rest.forEach((s, i) => {
          if (chosen.every((c) => disjoint.get(c)?.has(s))) search([...chosen, s], rest.slice(i + 1), sum + lowers.get(s)!);
        });
      };
      if (cand.length <= 14) search([], cand, 0);
      if (best.length < 2 || bestSum <= hi.hi) continue;
      const names = best.map((s) => `${featureLabel(model, model.require(s))} ${show({ lo: lowers.get(s)!, hi: statedRange(model.require(s))!.hi })}`);
      out.push({
        id: `disjoint-sum-exceeds#${n++}`,
        ruleId: 'disjoint-sum-exceeds',
        severity: 'warning',
        message: `${names.join(', ')} are disjoint and subset ${qualifiedLabel(model, sup)} ${show(hi)}: their lower bounds add up to ${bestSum}, above its upper bound ${hi.hi}, so they cannot all hold (§7.6.1, KerML disjoining).`,
        elementId: best[0]!,
      });
    }
    return out;
  },
};

/** Is `f` an enumerated value: a usage the body of an enumeration definition declares (`enum red;`, or the keyword-less `red;`)? */
function isLiteral(model: Model, f: ElementRecord): boolean {
  const owner = f.ownerId !== null ? model.get(f.ownerId) : undefined;
  return owner?.eClass === 'EnumerationDefinition' && isKindOf(f.eClass, 'Usage');
}

/** Enumeration-literal names an enumeration definition has: its own and those it inherits. */
function literalsOf(model: Model, enumId: ElementId): Set<string> {
  const names = new Set<string>();
  for (const f of effectiveFeaturesWithLibrary(model, enumId)) {
    if (!isLiteral(model, f)) continue;
    const nm = effectiveNameOf(model, f);
    if (nm) names.add(nm);
  }
  return names;
}

/**
 * BD7 `enum-value-not-member`.
 *
 * Spec §7.8.2 (lines ~3782-3800): "An enumeration usage is restricted to only
 * the set of enumerated values specified in its definition"; an attribute usage
 * defined by an enumeration definition is "semantically restricted to take on
 * only the values allowed by its enumeration definition". A feature typed by an
 * enumeration definition and bound to `Color::blue`, when `Color` has no `blue`,
 * is bound to a value outside its type; so is one bound to a literal of ANOTHER
 * enumeration definition, or (where the enumeration definition specialises no
 * attribute definition, whose values the literals could stand for, §7.8.2) to a
 * number, Boolean or string literal. A plain name that does not resolve, or one
 * that resolves to something that is not an enumeration literal, gives no
 * finding (it may be a feature holding one).
 */
export const enumValueNotMember: ValidationRule = {
  id: 'enum-value-not-member',
  description: "A value bound to an enumeration-typed feature is not one of that enumeration definition's literals.",
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (!isUserElement(el) || el.attrs.value === undefined || !isKindOf(el.eClass, 'Usage')) continue;
      const enumId = allDeclaredTypes(model, el.id).find((t) => model.get(t)?.eClass === 'EnumerationDefinition');
      if (!enumId) continue;
      const enumDef = model.require(enumId);
      const lits = literalsOf(model, enumId);
      const v = el.attrs.value;
      const mk = (what: string): void => {
        out.push({
          id: `enum-value-not-member#${n++}`,
          ruleId: 'enum-value-not-member',
          severity: 'warning',
          message: `${featureLabel(model, el)} : ${enumDef.declaredName ?? enumId} is bound to ${what}, which is not one of ${enumDef.declaredName ?? 'its enumeration'}'s literals (${[...lits].join(', ') || 'none'}): an enumeration-typed feature takes only its definition's values (§7.8.2).`,
          elementId: el.id,
        });
      };
      const generalsOfEnum = generalizationsOf(model, enumId).filter((g) => g.attrs.isLibrary !== true);
      if (typeof v === 'number' || typeof v === 'boolean') {
        if (generalsOfEnum.length === 0) mk(`the literal ${String(el.attrs.valueText ?? v)}`);
        continue;
      }
      if (typeof v !== 'string') continue;
      const text = v.trim();
      if (/^"(?:[^"\\]|\\.)*"$/.test(text)) {
        if (generalsOfEnum.length === 0) mk(`the string ${text}`);
        continue;
      }
      if (!/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(text)) continue;
      const hit = resolveFullName(model, text, el.ownerId, { exclude: el.id });
      if (hit) {
        if (!isLiteral(model, hit)) continue;
        const owner = hit.ownerId !== null ? model.get(hit.ownerId) : undefined;
        if (owner?.eClass === 'EnumerationDefinition' && owner.id !== enumId && !literalsOf(model, enumId).has(effectiveNameOf(model, hit) ?? '')) {
          mk(`${qualifiedLabel(model, hit)}, a literal of ${owner.declaredName ?? 'another enumeration'}`);
        }
        continue;
      }
      const segs = text.split('::');
      if (segs.length < 2) continue;
      const prefix = resolveFullName(model, segs.slice(0, -1).join('::'), el.ownerId);
      if (prefix?.id === enumId && !lits.has(segs[segs.length - 1]!)) mk(`${text}`);
    }
    return out;
  },
};

/** The values a written value expression gives, when its text is a literal or a parenthesised list: `count` of top-level elements, `exact` when every one is a literal. */
function valueCount(el: ElementRecord): { count: number; exact: boolean } | undefined {
  const v = el.attrs.value;
  if (typeof v === 'number' || typeof v === 'boolean') return { count: 1, exact: true };
  if (typeof v !== 'string') return undefined;
  const text = v.trim();
  const literal = (t: string): boolean => /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(t) || /^"(?:[^"\\]|\\.)*"$/.test(t) || t === 'true' || t === 'false';
  if (literal(text)) return { count: 1, exact: true };
  if (!text.startsWith('(') || !text.endsWith(')')) return undefined;
  // Split at top-level commas; give up on a text where the first `(` does not close at the end.
  const parts: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      cur += c;
      if (c === '\\') cur += text[++i] ?? '';
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') quote = true;
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      if (depth === 1) continue;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        if (i !== text.length - 1) return undefined;
        continue;
      }
    } else if (c === ',' && depth === 1) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (depth !== 0 || quote) return undefined;
  parts.push(cur.trim());
  if (parts.some((p) => p === '' || p.includes('..'))) return undefined;
  // `(a, b)` is a sequence; `(a)` alone is a parenthesised expression, which may itself stand for many values.
  if (parts.length === 1) return literal(parts[0]!) ? { count: 1, exact: true } : undefined;
  return { count: parts.length, exact: parts.every(literal) };
}

/**
 * BD8 `value-multiplicity-mismatch`.
 *
 * Spec §7.13.4 (lines ~5173-5215): a feature value relationship, bound
 * (`=`) or default, relates a usage to a value expression whose result provides
 * the values of the feature, and implies a binding between them (§7.13.3, the
 * two are equivalent); §7.6.3 (lines ~3330-3362): the multiplicity of a usage is
 * the number of values it has. A feature whose upper bound is 1 (`[1]`,
 * `[0..1]`) given a list of several values holds more than it may; a feature
 * bound (not given a default or initial value) to a literal, or to a list of
 * literals, whose lower bound exceeds the number of values written has fewer.
 * Only a multiplicity the feature states itself, with literal bounds, and a
 * value that is a literal or a parenthesised list at its top level are read; a
 * value that is any other expression may stand for any number of values.
 */
export const valueMultiplicityMismatch: ValidationRule = {
  id: 'value-multiplicity-mismatch',
  description: 'A feature bound to more values than its upper bound, or to fewer literal values than its lower bound.',
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (!isUserElement(el) || el.attrs.value === undefined || !isKindOf(el.eClass, 'Usage')) continue;
      const range = statedRange(el);
      const vc = valueCount(el);
      if (!range || !vc || range.lo > range.hi) continue;
      const bound = el.attrs.defaultValue !== true && el.attrs.initialValue !== true;
      let why: string | undefined;
      if (vc.count > range.hi) {
        why = `${vc.count} values, above its upper bound`;
      } else if (bound && vc.exact && vc.count < range.lo) {
        why = `${vc.count} value${vc.count === 1 ? '' : 's'}, below its lower bound`;
      }
      if (!why) continue;
      out.push({
        id: `value-multiplicity-mismatch#${n++}`,
        ruleId: 'value-multiplicity-mismatch',
        severity: 'warning',
        message: `${featureLabel(model, el)} declares multiplicity ${show(range)} but its value gives ${why}: a feature value provides the values of the feature, so their number must fit its multiplicity (§7.13.4, §7.6.3).`,
        elementId: el.id,
      });
    }
    return out;
  },
};

/**
 * BD9 `specialization-kind-incompatible`.
 *
 * Spec §7.6.2 / §7.7.2 (line ~3665: "An attribute definition may only specialize
 * other attribute definitions (including enumeration definitions) or KerML data
 * types"), §7.8.2 (line ~3790: an enumeration definition must not subclassify
 * another enumeration definition) and the metaclass hierarchy of §8.3 (mirrored
 * by `DIRECT_SUPERTYPES`): a definition subclassifies one of its own line of
 * metaclasses. The legal pairs, specific : general, are those where one
 * metaclass is the other or a subtype of the other:
 *   - attribute def / enum def with attribute def / enum def only (never an
 *     occurrence-side definition: item, part, port, connection, action, state,
 *     calculation, constraint, requirement, case, view, metadata ...);
 *   - the occurrence side: item def with item, part, occurrence, metadata def;
 *     part def with part, item, occurrence, connection, interface, allocation,
 *     flow, view, rendering def; port def with port, occurrence (and its
 *     conjugate); action def with action, state, calculation, constraint,
 *     requirement, case, occurrence; and so on up and down each chain;
 *   - never across chains: `item def :> attribute def`, `part def :> port def`,
 *     `part def :> action def`, `port def :> item def`.
 * `enum def :> enum def` is the one same-kind pair that is not legal.
 * Both ends must be definitions of a known metaclass; implicit and library
 * specialisations are not read.
 */
export const specializationKindIncompatible: ValidationRule = {
  id: 'specialization-kind-incompatible',
  description: 'A definition specialises a definition of an incompatible kind (item def :> attribute def, part def :> port def, enum def :> enum def).',
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    for (const rel of model.all()) {
      if (rel.eClass !== 'Subclassification' || rel.attrs.isLibrary === true) continue;
      const subId = rel.source?.[0];
      const supId = rel.target?.[0];
      const sub = subId ? model.get(subId) : undefined;
      const sup = supId ? model.get(supId) : undefined;
      if (!sub || !sup || !isUserElement(sub) || sub.id === sup.id) continue;
      const known = (e: ElementRecord): boolean => e.eClass.endsWith('Definition') && e.eClass in DIRECT_SUPERTYPES;
      if (!known(sub) || !known(sup)) continue;
      let why: string | undefined;
      if (sub.eClass === 'EnumerationDefinition' && sup.eClass === 'EnumerationDefinition') {
        why = 'an enumeration definition must not specialise another enumeration definition: its literals would add to the values the general allows (§7.8.2)';
      } else if (!isKindOf(sub.eClass, sup.eClass) && !isKindOf(sup.eClass, sub.eClass)) {
        why = `a «${sub.eClass}» and a «${sup.eClass}» are on different lines of the metaclass hierarchy, so neither is a kind of the other (§7.6.2, §7.7.2)`;
      }
      if (!why) continue;
      out.push({
        id: `specialization-kind-incompatible#${n++}`,
        ruleId: 'specialization-kind-incompatible',
        severity: 'warning',
        message: `${qualifiedLabel(model, sub)} (${sub.eClass}) specialises ${qualifiedLabel(model, sup)} (${sup.eClass}): ${why}.`,
        elementId: sub.id,
      });
    }
    return out;
  },
};

/**
 * BD11 `unresolved-value-chain`.
 *
 * Spec §7.6.6 (lines ~3469-3475): "Each qualified name in a feature chain must
 * resolve to a Usage (or, more generally, a KerML Feature). The first qualified
 * name in a feature chain is resolved in the local namespace as usual.
 * Subsequent qualified names are then resolved using the previously resolved
 * usage (feature) as the context namespace." A value `= e.nosuch` whose head `e`
 * resolves to a usage, but where `e`'s own and inherited features (through every
 * type it has, the library included) hold no `nosuch`, names nothing. No existing
 * `ref/` code reads value expressions (they cover relationship targets), so this
 * is a rule of its own. Only a value that is exactly one dotted chain of plain
 * names is read, and only where each step's feature has a resolved type and no
 * type is left unresolved; otherwise nothing is concluded.
 */
export const unresolvedValueChain: ValidationRule = {
  id: 'unresolved-value-chain',
  description: 'A value that is a feature chain whose later name is not a feature of the one before.',
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (!isUserElement(el) || !isKindOf(el.eClass, 'Usage')) continue;
      const v = el.attrs.value;
      if (typeof v !== 'string' || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(v.trim())) continue;
      const segs = v.trim().split('.');
      let cur = resolveFullName(model, segs[0]!, el.ownerId, { exclude: el.id });
      if (!cur || cur.attrs.isLibrary === true || !isKindOf(cur.eClass, 'Usage')) continue;
      for (let i = 1; i < segs.length && cur; i++) {
        const seg = segs[i]!;
        const next: ElementRecord | undefined = childNamed(model, cur.id, seg) ?? findTypeFeature(model, cur, seg);
        if (next) {
          cur = next;
          continue;
        }
        const types = allDeclaredTypes(model, cur.id);
        const raw = cur.attrs.type ?? cur.attrs.typeRef;
        const unresolvedType = typeof raw === 'string' && raw.trim() !== '' && declaredTypeElementId(model, cur.id) === undefined;
        const known = types.length > 0 && !unresolvedType;
        const inherited = new Set<string>();
        for (const t of types) {
          for (const f of effectiveFeaturesWithLibrary(model, t)) {
            const nm = effectiveNameOf(model, f);
            if (nm) inherited.add(nm);
          }
        }
        for (const f of effectiveFeaturesWithLibrary(model, cur.id)) {
          const nm = effectiveNameOf(model, f);
          if (nm) inherited.add(nm);
        }
        if (known && !inherited.has(seg)) {
          out.push({
            id: `unresolved-value-chain#${n++}`,
            ruleId: 'unresolved-value-chain',
            severity: 'warning',
            message: `Value ${v.trim()} of ${featureLabel(model, el)}: ${segs.slice(0, i).join('.')} has no feature "${seg}", so the chain names nothing (§7.6.6).`,
            elementId: el.id,
          });
        }
        cur = undefined;
      }
    }
    return out;
  },
};

/**
 * BD5 `connector-end-multiplicity`.
 *
 * Spec reading (SysML v2, `/tmp/ps3/spec/part1.txt`, §7.13.2, lines ~5025-5112,
 * verified by reading): an end of a connection carries a CROSS multiplicity,
 * written `end [0..1] part hub` on a connection definition or `connect [1] hub
 * ::> a to [0..4] device ::> b` on a usage; it counts the values of that end per
 * set of values of the other end ("a Device must have at most one Hub as its hub";
 * "connects each one of the networkHubs to at most four of the networkDevices"),
 * and a usage's cross multiplicity "further constrains" the one it inherits.
 * Two shapes cannot hold and are flagged (warnings):
 *  - the usage writes a cross multiplicity whose upper bound exceeds the upper bound
 *    of the part the end relates (`connect [5] wheels to hub` over `wheels : Wheel [4]`),
 *    or whose lower bound does; or exceeds the upper bound of the definition end it redefines;
 *  - no cross multiplicity is written, the definition end allows at most n, the other
 *    end relates exactly one instance, and the related part has more than n at least
 *    (`part a : W [3]` on an end `[0..2]`): all connect to that one instance.
 * Read only: `connect [m] a to [n] b` (binary, the form the grammar reads, with or
 * without `end ::>` names), bounds written as number literals, an end related to a
 * feature owned beside the connection (never a chain). The `connect (a, b, c)` list form
 * and `end [m] … references x` bodies are not read.
 */
export const connectorEndMultiplicity: ValidationRule = {
  id: 'connector-end-multiplicity',
  description: 'A connection end whose multiplicity lies outside that of the part it connects or of the definition end it redefines.',
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (el.attrs.isLibrary === true || el.attrs.staleEnd === true) continue;
      if (!el.source?.[0] || !el.target?.[0]) continue;
      if (!['ConnectionUsage', 'InterfaceUsage', 'Connector'].includes(el.eClass)) continue;
      const mk = (message: string): void => {
        out.push({ id: `connector-end-multiplicity#${n++}`, ruleId: 'connector-end-multiplicity', severity: 'warning', message, elementId: el.id });
      };
      const cross = (which: 'source' | 'target'): Range | undefined => {
        const raw = which === 'source' ? el.attrs.sourceCrossMult : el.attrs.targetCrossMult;
        return typeof raw === 'string' ? statedRange({ attrs: { multiplicity: raw } } as unknown as ElementRecord) : undefined;
      };
      const related = (which: 'source' | 'target'): ElementRecord | undefined => {
        const rel = model.get(el[which]![0]!);
        return rel && rel.ownerId === el.ownerId ? rel : undefined;
      };
      const pairs = endPairs(model, el.id);
      for (const which of ['source', 'target'] as const) {
        const rel = related(which);
        if (!rel) continue;
        const other = related(which === 'source' ? 'target' : 'source');
        const c = cross(which);
        const p = rangeOf(model, rel);
        const end = pairs.find((x) => x.related === rel.id)?.end;
        const e = end ? statedRange(end) : undefined;
        const label = `${which === 'source' ? 'source' : 'target'} end ${qualifiedLabel(model, rel)}`;
        if (c && p && c.lo <= c.hi && (c.hi > p.hi || c.lo > p.hi)) {
          mk(
            `Connection ${qualifiedLabel(model, el)}: the ${label} is written ${show(c)} but ${qualifiedLabel(model, rel)} has ${show(p)}: an end cannot connect more instances than the part has (§7.13.2).`,
          );
        } else if (c && e && c.hi > e.hi) {
          mk(
            `Connection ${qualifiedLabel(model, el)}: the ${label} is written ${show(c)} but the definition end ${end!.declaredName ?? ''} allows ${show(e)}: a usage may only narrow the cross multiplicity it inherits (§7.13.2).`,
          );
        } else if (!c && e && p && other) {
          // A part usage that states no multiplicity and specialises nothing has the default 1 (§7.6.3).
          const plain =
            other.eClass === 'PartUsage' && other.attrs.multiplicity === undefined && other.attrs.implicit !== true &&
            !model.relationshipsFrom(other.id).some((r) => ['Subsetting', 'Redefinition', 'ReferenceSubsetting'].includes(r.eClass));
          const o = rangeOf(model, other) ?? (plain ? { lo: 1, hi: 1 } : undefined);
          if (o && o.lo === 1 && o.hi === 1 && p.lo > e.hi) {
            mk(
              `Connection ${qualifiedLabel(model, el)}: the ${label} has ${show(p)} instances all connected to the single ${qualifiedLabel(model, other)}, but the definition end ${end!.declaredName ?? ''} allows at most ${e.hi} (§7.13.2).`,
            );
          }
        }
      }
    }
    return out;
  },
};
