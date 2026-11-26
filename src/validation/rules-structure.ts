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
import { definitionEndsOf, endPairs } from '../semantics/port-conformance';
import { resolveQualifiedNameFull } from '../semantics';
import { childNamed, findTypeFeature, resolveFullName } from '../semantics/bind';
import { evaluate, parseExpr } from '../semantics/expr';
import { configurationsSelecting, familyConfigurations } from '../semantics/variability';
import type { ExprNode } from '../semantics/expr';
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

/** The variants (usages marked `variant`) a feature sits in, innermost first, itself included: what must be selected for it to exist. */
function variantGuard(model: Model, el: ElementRecord): ElementRecord[] {
  const out: ElementRecord[] = [];
  const seen = new Set<string>();
  let cur: ElementRecord | undefined = el;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.attrs.isVariant === true && isKindOf(cur.eClass, 'Usage')) out.push(cur);
    cur = cur.ownerId !== null ? model.get(cur.ownerId) : undefined;
  }
  return out;
}

/** Can two guards hold in one configuration? Not when they name two different variants of the one variation point (a sibling pair: one is chosen, §8.4.2.3). */
function guardsCompatible(a: ElementRecord[], b: ElementRecord[]): boolean {
  return !a.some((x) => b.some((y) => x.id !== y.id && x.ownerId === y.ownerId));
}

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
 *
 * Through variants (§7.6.1 variation, §8.4.2.3: exactly one variant of a variation
 * point is chosen): features that sit in different variants of one variation point are
 * never present together, so they are left out of one another's sum (the sum was
 * wrongly taken over alternatives before). A feature inside a variant exists only in
 * the configurations that select it: a sum that needs variants is reported as an
 * `info` naming them ("exceeds only when ... are selected"), because the
 * constraints of the family may exclude that selection. The V4 configuration enumeration (it reads the
 * family constraints) then decides: no valid configuration selects them → silent; every valid one does →
 * warning "in every valid configuration"; some → info "exceeds only in: ...". A cut enumeration or an
 * undecided family keeps the info reading, never a warning. When the enumeration is read, every valid
 * configuration is judged on its own: each disjoint clique among the features it keeps that exceeds is reported once,
 * with the configurations it exceeds in (warning only when every valid configuration has it). The V4 enumeration has no
 * solver route past its cap, so a cut enumeration is not decided per configuration (old info reading). A sum that needs no variant is the warning
 * and holds "in every configuration".
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
      const guards = new Map<ElementId, ElementRecord[]>(cand.map((s) => [s, variantGuard(model, model.require(s))]));
      const supGuard = variantGuard(model, sup);
      const compat = (c: ElementId, s: ElementId): boolean => !!disjoint.get(c)?.has(s) && guardsCompatible(guards.get(c)!, guards.get(s)!) && guardsCompatible(supGuard, guards.get(s)!);
      // The heaviest set of pairwise-disjoint subsetters (a clique), by exhaustive search over a small set,
      // restricted to the candidates `pool` (a configuration keeps only the features whose variants it selects).
      const heaviest = (pool: ElementId[]): { best: ElementId[]; bestSum: number } => {
        let best: ElementId[] = [];
        let bestSum = 0;
        const search = (chosen: ElementId[], rest: ElementId[], sum: number): void => {
          if (sum > bestSum) {
            bestSum = sum;
            best = chosen;
          }
          rest.forEach((s, i) => {
            if (chosen.every((c) => compat(c, s)) && guardsCompatible(supGuard, guards.get(s)!)) search([...chosen, s], rest.slice(i + 1), sum + lowers.get(s)!);
          });
        };
        search([], pool, 0);
        return { best, bestSum };
      };
      /** Every maximal clique of `pool` whose lower bounds add up above the superset's upper bound. */
      const exceeding = (pool: ElementId[]): ElementId[][] => {
        const found: ElementId[][] = [];
        const grow = (chosen: ElementId[], rest: ElementId[], sum: number): void => {
          const ext = rest.filter((s) => chosen.every((c) => compat(c, s)) && guardsCompatible(supGuard, guards.get(s)!));
          if (ext.length === 0) {
            if (chosen.length >= 2 && sum > hi.hi) found.push(chosen);
            return;
          }
          ext.forEach((s, i) => grow([...chosen, s], ext.slice(i + 1), sum + lowers.get(s)!));
          // A clique that stops here is maximal only if no later candidate extends it; the loop above covers every ordered extension.
        };
        grow([], pool, 0);
        // Keep the maximal ones only (a subset of another found clique is not reported).
        return found.filter((c, i) => !found.some((d, j) => j !== i && c.every((x) => d.includes(x)) && (d.length > c.length || (d.length === c.length && j < i))));
      };
      if (cand.length > 14) continue;
      const { best, bestSum } = heaviest(cand);
      if (best.length < 2 || bestSum <= hi.hi) continue;
      const describe = (clique: ElementId[]): string => clique.map((s) => `${featureLabel(model, model.require(s))} ${show({ lo: lowers.get(s)!, hi: statedRange(model.require(s))!.hi })}`).join(', ');
      const neededOf = (clique: ElementId[]): Map<ElementId, ElementRecord> => {
        const m = new Map<ElementId, ElementRecord>();
        for (const g of [...supGuard, ...clique.flatMap((s) => guards.get(s)!)]) m.set(g.id, g);
        return m;
      };
      const allGuardIds = [...new Set([...supGuard, ...cand.flatMap((s) => guards.get(s)!)].map((g) => g.id))];
      const cfgs = allGuardIds.length > 0 ? familyConfigurations(model, allGuardIds) : null;
      if (cfgs !== null && cfgs.length > 0) {
        // Per valid configuration: every exceeding clique among the features that configuration keeps.
        const byClique = new Map<string, { clique: ElementId[]; where: string[][] }>();
        for (const cfg of cfgs) {
          const keeps = (s: ElementId): boolean => guards.get(s)!.every((g) => cfg.kept.has(g.id));
          if (!supGuard.every((g) => cfg.kept.has(g.id))) continue;
          for (const clique of exceeding(cand.filter(keeps))) {
            const key = [...clique].sort().join('|');
            const e = byClique.get(key) ?? { clique, where: [] };
            e.where.push(cfg.label);
            byClique.set(key, e);
          }
        }
        for (const { clique, where } of byClique.values()) {
          const every = where.length === cfgs.length;
          const when = every ? 'in every valid configuration' : where.length <= 10 ? `exceeds only in: ${where.map((c) => c.join(', ')).join('; ')}` : `exceeds in ${where.length} of ${cfgs.length} valid configurations`;
          const sum = clique.reduce((t, s) => t + lowers.get(s)!, 0);
          out.push({
            id: `disjoint-sum-exceeds#${n++}`,
            ruleId: 'disjoint-sum-exceeds',
            severity: every ? 'warning' : 'info',
            message: `${describe(clique)} are disjoint and subset ${qualifiedLabel(model, sup)} ${show(hi)}: their lower bounds add up to ${sum}, above its upper bound ${hi.hi}, so they cannot all hold (§7.6.1, KerML disjoining), ${when}.`,
            elementId: clique[0]!,
          });
        }
        continue;
      }
      const names = describe(best);
      const needed = neededOf(best);
      let severity: 'warning' | 'info' = needed.size === 0 ? 'warning' : 'info';
      let when = needed.size === 0 ? 'in every configuration' : `only when ${[...needed.values()].map((v) => qualifiedLabel(model, v)).join(', ')} ${needed.size === 1 ? 'is' : 'are'} selected`;
      let note = needed.size === 0 ? '' : ' (the family constraints are not read here)';
      if (needed.size > 0) {
        // Cut or unread enumeration, or a family that does not hold every variant: the selection-only reading, never a warning.
        const fam = configurationsSelecting(model, [...needed.keys()]);
        if (fam !== null && fam.total > 0) {
          if (fam.selecting.length === 0) continue;
          if (fam.selecting.length === fam.total) {
            severity = 'warning';
            when = 'in every valid configuration';
            note = '';
          } else if (fam.selecting.length <= 10) {
            when = `exceeds only in: ${fam.selecting.map((c) => c.join(', ')).join('; ')}`;
            note = '';
          }
        }
      }
      out.push({
        id: `disjoint-sum-exceeds#${n++}`,
        ruleId: 'disjoint-sum-exceeds',
        severity,
        message: `${names} are disjoint and subset ${qualifiedLabel(model, sup)} ${show(hi)}: their lower bounds add up to ${bestSum}, above its upper bound ${hi.hi}, so they cannot all hold (§7.6.1, KerML disjoining), ${when}${note}.`,
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

/**
 * Is `text` a single scalar expression over literals only (`2 * 3 + 1`, `-4`, `"a" + "b"`)? It is parsed and
 * evaluated by the existing evaluator; a name, call, conditional, list, range or anything it cannot evaluate is no.
 */
function literalArithmetic(text: string): boolean {
  if (text.includes(',') || text.includes('..')) return false;
  let node: ExprNode;
  try {
    node = parseExpr(text);
  } catch {
    return false;
  }
  const pure = (n: ExprNode): boolean => {
    switch (n.kind) {
      case 'num':
      case 'str':
      case 'bool':
        return true;
      case 'unary':
        return pure(n.operand);
      case 'binary':
        return pure(n.left) && pure(n.right);
      default:
        return false;
    }
  };
  if (!pure(node)) return false;
  const r = evaluate(node, () => undefined);
  return 'value' in r && r.value !== null && r.value !== undefined && !(typeof r.value === 'number' && !Number.isFinite(r.value));
}

/**
 * The number of values an expression gives, where the evaluator's reading decides it: a literal is one value;
 * arithmetic whose every operand is one value is one value; a plain name of a feature whose multiplicity is exactly
 * `[n]`, or which is bound to a value of decided count, gives that many; a call of a calculation whose result states
 * exactly `[n]` gives that many; a parenthesised sequence is the sum of its parts. Anything else (a chain, an
 * unresolved name, a conditional, a range, an arrow) is undecided: `undefined`.
 */
function decidedCount(model: Model, scope: ElementRecord, node: ExprNode, depth = 0): number | undefined {
  if (depth > 6) return undefined;
  switch (node.kind) {
    case 'num':
    case 'str':
    case 'bool':
      return 1;
    case 'unary':
      return decidedCount(model, scope, node.operand, depth + 1) === 1 ? 1 : undefined;
    case 'binary':
      return decidedCount(model, scope, node.left, depth + 1) === 1 && decidedCount(model, scope, node.right, depth + 1) === 1 ? 1 : undefined;
    case 'ref': {
      if (node.path.length !== 1 || node.qualifier !== undefined) return undefined;
      const hit = resolveFullName(model, node.path[0]!, scope.ownerId, { exclude: scope.id });
      if (!hit || !isKindOf(hit.eClass, 'Usage') || hit.id === scope.id) return undefined;
      const range = statedRange(hit);
      if (range) return range.lo === range.hi ? range.lo : undefined;
      if (hit.attrs.value === undefined) return undefined;
      const vc = valueCount(model, hit, depth + 1);
      return vc?.exact ? vc.count : undefined;
    }
    case 'call': {
      const fn = resolveFullName(model, node.name, scope.ownerId, { exclude: scope.id });
      if (!fn || (fn.eClass !== 'CalculationDefinition' && fn.eClass !== 'CalculationUsage')) return undefined;
      const results = model.children(fn.id).filter((c) => isKindOf(c.eClass, 'Usage') && (c.attrs.featureRole === 'return' || c.attrs.direction === 'return' || c.attrs.isResult === true));
      if (results.length !== 1) return undefined;
      const range = statedRange(results[0]!);
      return range && range.lo === range.hi ? range.lo : undefined;
    }
    default:
      return undefined;
  }
}

/** The decided count of a text that parses as one expression, or `undefined`. */
function decidedCountOfText(model: Model, el: ElementRecord, text: string, depth: number): number | undefined {
  let node: ExprNode;
  try {
    node = parseExpr(text);
  } catch {
    return undefined;
  }
  return decidedCount(model, el, node, depth);
}

/** The values a written value expression gives, when its text is a literal or a parenthesised list: `count` of top-level elements, `exact` when every one is a literal. */
function valueCount(model: Model, el: ElementRecord, rdepth = 0): { count: number; exact: boolean } | undefined {
  const v = el.attrs.value;
  if (typeof v === 'number' || typeof v === 'boolean') return { count: 1, exact: true };
  if (typeof v !== 'string') return undefined;
  const text = v.trim();
  const literal = (t: string): boolean => /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(t) || /^"(?:[^"\\]|\\.)*"$/.test(t) || t === 'true' || t === 'false';
  if (literal(text) || literalArithmetic(text)) return { count: 1, exact: true };
  if (!text.startsWith('(') && !text.includes(',') && !text.includes('..')) {
    const d = decidedCountOfText(model, el, text, rdepth);
    return d === undefined ? undefined : { count: d, exact: true };
  }
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
  const decided = parts.map((p) => (literal(p) || literalArithmetic(p) ? 1 : decidedCountOfText(model, el, p, rdepth)));
  if (parts.length === 1) return decided[0] === undefined ? undefined : { count: decided[0], exact: true };
  if (decided.every((d) => d !== undefined)) return { count: decided.reduce((a, b) => a! + b!, 0)!, exact: true };
  return { count: parts.length, exact: false };
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
 * value that is any other expression may stand for any number of values, unless the evaluator decides its count
 * (`decidedCount`: a name of a feature of exact multiplicity or decided value, a call of a calculation with an exact
 * result multiplicity, arithmetic over single values). Arithmetic over literals
 * alone (`2 * 3 + 1`) evaluates to one scalar and is read as a single value.
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
      const vc = valueCount(model, el);
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
 *
 * Usage level (§7.6.3, line ~3300, and §8.3: every usage kind must subset its own base
 * usage, "A PartUsage must subset, directly or indirectly, the base PartUsage parts"): a
 * usage that subsets, redefines or reference-subsets another follows the same line of
 * metaclasses, so `attribute x :> p` over a part usage, or `part q :> port r`, are
 * flagged. A `ref` usage and the bare `Usage` metaclass stand for any kind and are not read.
 */
export const specializationKindIncompatible: ValidationRule = {
  id: 'specialization-kind-incompatible',
  description: 'A definition specialises a definition of an incompatible kind (item def :> attribute def, part def :> port def, enum def :> enum def).',
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    for (const rel of model.all()) {
      const usageLevel = rel.eClass === 'Subsetting' || rel.eClass === 'Redefinition' || rel.eClass === 'ReferenceSubsetting';
      if ((rel.eClass !== 'Subclassification' && !usageLevel) || rel.attrs.isLibrary === true || rel.attrs.implicit === true) continue;
      const subId = rel.source?.[0];
      const supId = rel.target?.[0];
      const sub = subId ? model.get(subId) : undefined;
      const sup = supId ? model.get(supId) : undefined;
      if (!sub || !sup || !isUserElement(sub) || sub.id === sup.id) continue;
      // A usage-level pair reads only the specific usage kinds: a reference usage (`ref x`) or the bare `Usage` may stand for any.
      const known = (e: ElementRecord): boolean =>
        usageLevel
          ? e.eClass.endsWith('Usage') && e.eClass in DIRECT_SUPERTYPES && e.eClass !== 'ReferenceUsage' && e.eClass !== 'Usage'
          : e.eClass.endsWith('Definition') && e.eClass in DIRECT_SUPERTYPES;
      if (!known(sub) || !known(sup)) continue;
      let why: string | undefined;
      if (!usageLevel && sub.eClass === 'EnumerationDefinition' && sup.eClass === 'EnumerationDefinition') {
        why = 'an enumeration definition must not specialise another enumeration definition: its literals would add to the values the general allows (§7.8.2)';
      } else if (!isKindOf(sub.eClass, sup.eClass) && !isKindOf(sup.eClass, sub.eClass)) {
        why = `a «${sub.eClass}» and a «${sup.eClass}» are on different lines of the metaclass hierarchy, so neither is a kind of the other (§7.6.2, §7.7.2)`;
      }
      if (!why) continue;
      out.push({
        id: `specialization-kind-incompatible#${n++}`,
        ruleId: 'specialization-kind-incompatible',
        severity: 'warning',
        message: `${qualifiedLabel(model, sub)} (${sub.eClass}) ${usageLevel ? rel.eClass === 'Redefinition' ? 'redefines' : 'subsets' : 'specialises'} ${qualifiedLabel(model, sup)} (${sup.eClass}): ${why}.`,
        elementId: sub.id,
      });
    }
    return out;
  },
};

/**
 * A value that is exactly one feature chain, as its names: the head (a qualified name, its `::` steps
 * joined, quotes removed) and the `.`-steps after it. Names are plain (`[A-Za-z_]\w*`) or quoted
 * (`'a b'`); anything else (calls, operators, indexes) gives `undefined`.
 */
export function parseValueChain(text: string): { head: string; rest: string[] } | undefined {
  const name = "(?:[A-Za-z_]\\w*|'(?:[^'\\\\]|\\\\.)+')";
  const re = new RegExp(`^${name}(?:::${name})*(?:\\.${name})*$`);
  const t = text.trim();
  if (!re.test(t)) return undefined;
  const parts: string[] = [];
  const tok = new RegExp(`${name}|::|\\.`, 'g');
  const sep: string[] = [];
  for (const m of t.matchAll(tok)) {
    if (m[0] === '::' || m[0] === '.') sep.push(m[0]);
    else {
      parts.push(m[0].startsWith("'") ? m[0].slice(1, -1) : m[0]);
    }
  }
  const dotted = sep.indexOf('.');
  const headLen = (dotted === -1 ? sep.length : dotted) + 1;
  return { head: parts.slice(0, headLen).join('::'), rest: parts.slice(headLen) };
}

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
 * type is left unresolved; otherwise nothing is concluded. Names may be quoted
 * (`'my part'.mass`) and the head may be a `::` qualified name (`Pkg::e.mass`).
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
      if (typeof v !== 'string') continue;
      const chain = parseValueChain(v);
      if (!chain || chain.rest.length === 0) continue;
      const segs = [chain.head, ...chain.rest];
      let cur = resolveFullName(model, chain.head, el.ownerId, { exclude: el.id });
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
 *  - no cross multiplicity is written (the usage inherits the definition end's), the definition end allows at most n,
 *    and the related part has more than n times the product of the other ends' upper bounds at least
 *    (`part a : W [3]` on an end `[0..2]` with a single other part: all connect to that one instance; `[1..2]` others: more than 2n).
 * Read only: `connect [m] a to [n] b` and its two-end list form `connect ([m] a, [n] b)` (with or
 * without `end ::>` names), and a connection body of two or more `end [m] part x references a`
 * ends (the spec's EndUsagePrefix form, §8.2.2.7; a definition end's `end [m] part x` is read like
 * `end part x [m]`); bounds written as number literals, an end related to a feature owned beside
 * the connection (never a chain). A body of three or more `end … references` ends is read end by end (each against the
 * product of the others); the list form of three or more ends is a syntax error, and any other body shape is not read.
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
      if (!['ConnectionUsage', 'InterfaceUsage', 'Connector'].includes(el.eClass)) continue;
      const mk = (message: string): void => {
        out.push({ id: `connector-end-multiplicity#${n++}`, ruleId: 'connector-end-multiplicity', severity: 'warning', message, elementId: el.id });
      };
      const written = (raw: unknown): Range | undefined =>
        typeof raw === 'string' ? statedRange({ attrs: { multiplicity: raw } } as unknown as ElementRecord) : undefined;
      // The two ends, each with the part it relates, the cross multiplicity written on it and the definition end it
      // redefines. Read from `connect [m] a to [n] b` / `connect ([m] a, [n] b)` (stored on the connection), or from
      // two or more `end [m] part x references a` bodies; any other shape is left unread.
      interface End { rel: ElementRecord; cross: Range | undefined; end: ElementRecord | undefined; label: string }
      const sameOwner = (id: ElementId | undefined): ElementRecord | undefined => {
        const rel = id ? model.get(id) : undefined;
        return rel && rel.ownerId === el.ownerId ? rel : undefined;
      };
      const ends: (End | undefined)[] = [];
      if (el.source?.[0] && el.target?.[0]) {
        const pairs = endPairs(model, el.id);
        (['source', 'target'] as const).forEach((which) => {
          const rel = sameOwner(el[which]![0]);
          ends.push(
            rel && {
              rel,
              cross: written(which === 'source' ? el.attrs.sourceCrossMult : el.attrs.targetCrossMult),
              end: pairs.find((x) => x.related === rel.id)?.end,
              label: `${which} end ${qualifiedLabel(model, rel)}`,
            },
          );
        });
      } else {
        const owned = model.children(el.id).filter((c) => c.attrs.isEnd === true);
        if (owned.length < 2) continue;
        const defEnds = definitionEndsOf(model, el.id);
        owned.forEach((o, i) => {
          const refs = model
            .relationshipsFrom(o.id)
            .filter((r) => ['ReferenceSubsetting', 'Subsetting', 'Redefinition'].includes(r.eClass));
          const rel = refs.length === 1 ? sameOwner(refs[0]!.target?.[0]) : undefined;
          ends.push(
            rel && {
              rel,
              cross: written(o.attrs.endCrossMult),
              end: o.declaredName !== undefined ? defEnds.find((d) => d.declaredName === o.declaredName) : undefined,
              label: `${i === 0 ? 'source' : i === 1 ? 'target' : `end ${i + 1}`} end ${qualifiedLabel(model, rel)}`,
            },
          );
        });
      }
      for (const [i, me] of ends.entries()) {
        if (!me) continue;
        const { rel, cross: c, end, label } = me;
        // The other ends, all read (an unread one leaves the third check unjudged). KerML: an end's cross multiplicity
        // is read against the product of the OTHER ends' instances, so a connection of n ends is checked end by end.
        const others = ends.filter((_, j) => j !== i).map((x) => x?.rel);
        const p = rangeOf(model, rel);
        const e = end ? (written(end.attrs.endCrossMult) ?? statedRange(end)) : undefined;        if (c && p && c.lo <= c.hi && (c.hi > p.hi || c.lo > p.hi)) {
          mk(
            `Connection ${qualifiedLabel(model, el)}: the ${label} is written ${show(c)} but ${qualifiedLabel(model, rel)} has ${show(p)}: an end cannot connect more instances than the part has (§7.13.2).`,
          );
        } else if (c && e && c.hi > e.hi) {
          mk(
            `Connection ${qualifiedLabel(model, el)}: the ${label} is written ${show(c)} but the definition end ${end!.declaredName ?? ''} allows ${show(e)}: a usage may only narrow the cross multiplicity it inherits (§7.13.2).`,
          );
        } else if (!c && e && p && others.length > 0 && others.every((x) => x !== undefined)) {
          // A part usage that states no multiplicity and specialises nothing has the default 1 (§7.6.3).
          const plain = (x: ElementRecord): boolean =>
            x.eClass === 'PartUsage' && x.attrs.multiplicity === undefined && x.attrs.implicit !== true &&
            !model.relationshipsFrom(x.id).some((r) => ['Subsetting', 'Redefinition', 'ReferenceSubsetting'].includes(r.eClass));
          // The usage writes no cross multiplicity, so it inherits the definition end's (a redefinition). Each tuple of
          // the other ends' instances links at most e.hi of this end's, so all of p.lo instances connected need
          // (the product of the others' upper bounds) tuples at least.
          let tuples = 1;
          for (const x of others) {
            const o = rangeOf(model, x!) ?? (plain(x!) ? { lo: 1, hi: 1 } : undefined);
            if (!o || !Number.isFinite(o.hi)) { tuples = NaN; break; }
            tuples *= o.hi;
          }
          if (Number.isFinite(tuples) && p.lo > e.hi * tuples) {
            const what = others.length === 1 && tuples === 1
              ? `the single ${qualifiedLabel(model, others[0]!)}`
              : `at most ${tuples} instance${tuples === 1 ? '' : 's'} of the other end${others.length > 1 ? 's' : ''} (${others.map((x) => qualifiedLabel(model, x!)).join(', ')})`;
            mk(
              `Connection ${qualifiedLabel(model, el)}: the ${label} has ${show(p)} instances all connected to ${what}, but the definition end ${end!.declaredName ?? ''} allows at most ${e.hi} per instance of ${others.length > 1 ? 'the others' : 'the other'} (§7.13.2).`,
            );
          }
        }
      }
    }
    return out;
  },
};
