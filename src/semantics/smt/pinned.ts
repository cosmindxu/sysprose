/**
 * Which symbols a set of asserted axioms pins to a value: the strict reading
 * the `search` cell of a constraint class is built on.
 *
 * A nonlinear script is `pinned` when every symbol at a nonlinear site is fixed
 * by a stated value, or by an equation solved for it from fixed values, in THIS
 * script. That is a claim about what z3 is asked, so the rule is the stricter
 * of the two readings in the lane. The engine's own `pinnedSymbols`
 * (`engines/smt.ts`) decides which axioms the numeric surface may rely on and
 * is deliberately NOT lifted here: it pins a defined symbol when every variable
 * of the row is pinned or is the defined symbol itself, so `assert constraint
 * { x == x * y }` pins `x`, and a class that called `x` "fixed" on that row
 * would over-state what the proof stands on. Here a symbol is never pinned by
 * an equation that mentions it on its own right-hand side.
 *
 * Pure and label-only: nothing in the lane branches on the answer.
 */
import type { ElementId, Model } from '@core/index';
import { definedFeatureOf } from '../evaluate-model';
import type { ExprNode } from '../expr';
import type { Obligation } from '../obligations';
import type { ContractVariable } from '../contracts';

/** A worklist row beside what the encoder made of it; structurally the engine's `EncodedRow`. */
export interface PinnableRow {
  row: Obligation;
  /** `undefined` when the row was refused: a refused axiom asserts nothing, so it pins nothing. */
  encoded?: unknown;
}

/** The symbol a path is read by in a row: its own, or the feature's qualified name (`encodeVariables`). */
const symbolOfVar = (v: ContractVariable): string => v.symbol ?? v.qualifiedName;

/**
 * The paths a body reads, or `undefined` when a node kind this walk does not know could hide one.
 * Unknown means "do not pin": the weaker reading wins.
 */
function refsOf(n: ExprNode): string[] | undefined {
  switch (n.kind) {
    case 'ref':
      return [n.path.join('.')];
    case 'unary':
      return refsOf(n.operand);
    case 'binary': {
      const l = refsOf(n.left);
      const r = refsOf(n.right);
      return l && r ? [...l, ...r] : undefined;
    }
    case 'if': {
      const parts = [refsOf(n.cond), refsOf(n.then), refsOf(n.else)];
      return parts.every((p): p is string[] => p !== undefined) ? parts.flat() : undefined;
    }
    case 'num':
    case 'str':
    case 'bool':
    case 'null':
      return [];
    default:
      return undefined;
  }
}

/**
 * The qualified names (or own-symbol names) the encoded axioms of `rows` pin.
 *
 * - A stated value `f == literal` pins `f`.
 * - A defining row pins its defined symbol only if the node is `==` with that
 *   feature as its bare left-hand reference, the symbol does not occur in the
 *   right-hand side (checked on the body's references, not on `row.vars`, which
 *   lists both sides), and every symbol of the right-hand side is already pinned.
 *   The defined feature is the row's own element for a feature value and a
 *   calculation, and `definedFeatureOf` for an asserted equation. A row read in an
 *   instance has an element id of the form `feature@path`, which names no feature, so
 *   it pins nothing: the engine's `pinnedSymbols` reads the same id the same way, and
 *   this reading never pins more than the engine does.
 * - A `bind` pins both ends once either is pinned.
 * - A defining row never pins a symbol of its own (`ContractVariable.symbol`), and mutual
 *   definitions (`w == u * y`, `u == w / y`) stay unpinned.
 */
export function pinnedSymbolsOf(model: Model, rows: readonly PinnableRow[]): Set<string> {
  const pinned = new Set<string>();
  type Defining = { vars: readonly ContractVariable[]; defined: ContractVariable; rhs: string[] };
  type Binding = { l: ContractVariable; r: ContractVariable };
  const defining: Defining[] = [];
  const binds: Binding[] = [];
  for (const { row, encoded } of rows) {
    if (encoded === undefined || row.role !== 'axiom') continue;
    const node = row.node;
    if (node?.kind !== 'binary' || node.op !== '==' || node.left.kind !== 'ref') continue;
    const byPath = (path: string): ContractVariable | undefined => row.vars.find((v) => v.path === path);
    if (row.source === 'bind') {
      if (node.right.kind !== 'ref') continue;
      const l = byPath(node.left.path.join('.'));
      const r = byPath(node.right.path.join('.'));
      if (l && r) binds.push({ l, r });
      continue;
    }
    if (row.source !== 'feature-value' && row.source !== 'calculation' && row.source !== 'assert') continue;
    const leftPath = node.left.path.join('.');
    const left = byPath(leftPath);
    if (!left || left.symbol !== undefined) continue;
    const target =
      row.source === 'assert'
        ? (() => {
            const el = model.get(row.element.id as ElementId);
            return el ? definedFeatureOf(model, el)?.id : undefined;
          })()
        : row.element.id;
    if (target === undefined || left.featureId !== target) continue;
    const rhs = refsOf(node.right);
    if (rhs === undefined || rhs.includes(leftPath)) continue;
    defining.push({ vars: row.vars, defined: left, rhs });
  }
  const rhsPinned = (d: Defining): boolean =>
    d.rhs.every((p) => {
      const v = d.vars.find((x) => x.path === p);
      return v !== undefined && symbolOfVar(v) !== symbolOfVar(d.defined) && pinned.has(symbolOfVar(v));
    });
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of defining) {
      const s = symbolOfVar(d.defined);
      if (pinned.has(s) || !rhsPinned(d)) continue;
      pinned.add(s);
      grew = true;
    }
    for (const { l, r } of binds) {
      const a = symbolOfVar(l);
      const b = symbolOfVar(r);
      if (pinned.has(a) === pinned.has(b)) continue;
      pinned.add(a);
      pinned.add(b);
      grew = true;
    }
  }
  return pinned;
}
