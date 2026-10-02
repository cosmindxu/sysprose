/**
 * Which symbols of a proof context the SMT encoder reads in DECIMALS.
 *
 * The encoder has two readings of a numeral (`numeral` in ./encode): the
 * binary64 the validation surface holds for a relation over plain numbers
 * (`0.1` is `3602879701896397 / 2⁵⁵`), and the decimal the author wrote for a
 * relation over quantities (`0.1` is one tenth), which is the number the
 * validation surface's relative tolerance stands for. A `[unit]` literal is
 * always the second: the author's magnitude times the unit's factor.
 *
 * THE READING IS A PROPERTY OF THE PROOF CONTEXT, NOT OF ONE RELATION. A proof
 * mixes relations: a plain feature's value axiom (`usableEnergyFraction : Real
 * = 0.1`), a plain `assume`, a goal that reads a mass (`f * mass != 0.1
 * [kg]`). Chosen one relation at a time, the axiom pinned `f` to the binary
 * 0.1 and the goal compared with the decimal one, and the proof decided the
 * tie by which side of it the number arrived on — `0.1 × 1 kg ≠ 0.1 kg` was
 * PROVED, with the release of an unrelated feature taking away the only guard.
 * And the commands that never asked (consistency, bounds, refine) read a
 * mass's own `= 0.1 [kg]` axiom in binary beside `mass <= 0.1 [kg]` in
 * decimals, and called the simplest model inconsistent.
 *
 * So the symbols are grouped by the relations that connect them — every row
 * the caller encodes, axioms, premises, goals and any extra equalities it
 * asserts — and a group is read in decimals whenever it holds a DIMENSIONED
 * feature (a declared unit, an ISQ kind, or a dimension its derivation gives)
 * or a `[unit]` literal. Two relations a proof can put side by side share a
 * symbol, or are linked through one, so they are always read the same way;
 * relations that share nothing factorise out of any proof and may differ.
 *
 * A group of plain features with no `[unit]` literal anywhere keeps binary64,
 * exactly as before: the doubles the validation surface holds.
 */

import { type ElementId, type Model } from '@core/index';
import type { ContractVariable } from '../contracts';
import type { ExprNode } from '../expr';
import { DIMENSIONLESS, dimEqual } from '../units';
import { derivedDimensionOf, dimensionalFacets, type DerivationMemo } from '../units-eval';
import { hasUnitLiteral } from './encode';

/** What {@link decimalSymbols} reads of one row: its variables and its (lowered) body. */
export interface DecimalRow {
  vars: readonly ContractVariable[];
  node: ExprNode | null;
}

/** The SMT symbol a variable is encoded by — `encodeVariables`'s own choice. */
export function contractSymbol(v: ContractVariable): string {
  return v.symbol ?? v.qualifiedName;
}

/**
 * The symbols, over `rows` (and any `links` — groups of symbols the caller
 * asserts equal outside those rows), whose numerals the encoder reads as the
 * decimals they are written as. Pass the result as `decimal` to
 * `encodeVariables` for EVERY row the same proof context encodes.
 */
export function decimalSymbols(
  model: Model,
  rows: readonly DecimalRow[],
  links: readonly (readonly string[])[] = [],
): Set<string> {
  const parent = new Map<string, string>();
  const find = (s: string): string => {
    if (!parent.has(s)) parent.set(s, s);
    let root = s;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression, iteratively: a long chain of relations is no stack.
    let cur = s;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const memo: DerivationMemo = new Map();
  const dimensionedById = new Map<ElementId, boolean>();
  const dimensioned = (v: ContractVariable): boolean => {
    const hit = dimensionedById.get(v.featureId);
    if (hit !== undefined) return hit;
    const facets = dimensionalFacets(model, v.featureId);
    const dimension = facets.unitDimension ?? facets.kindDimension ?? derivedDimensionOf(model, v.featureId, memo);
    const out = facets.unit !== undefined || (dimension !== undefined && !dimEqual(dimension, DIMENSIONLESS));
    dimensionedById.set(v.featureId, out);
    return out;
  };

  // Seeds: one symbol of every row that holds a dimensioned feature or a
  // `[unit]` literal. A row with neither variable nor literal seeds nothing.
  const seeds: string[] = [];
  for (const row of rows) {
    const symbols = row.vars.map(contractSymbol);
    for (const s of symbols) find(s);
    for (let i = 1; i < symbols.length; i++) union(symbols[0]!, symbols[i]!);
    if (symbols.length === 0) continue;
    if ((row.node !== null && hasUnitLiteral(row.node)) || row.vars.some(dimensioned)) seeds.push(symbols[0]!);
  }
  for (const group of links) {
    for (const s of group) find(s);
    for (let i = 1; i < group.length; i++) union(group[0]!, group[i]!);
  }

  const decimalRoots = new Set(seeds.map(find));
  const out = new Set<string>();
  for (const s of parent.keys()) if (decimalRoots.has(find(s))) out.add(s);
  return out;
}
