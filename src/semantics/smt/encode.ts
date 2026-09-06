/**
 * The encoder: a gated relation becomes an SMT-LIB2 term, and everything it
 * cannot encode is named.
 *
 * THE CHARTER OF THIS FILE, IN ONE LINE: **encode after the gates; report what
 * the gates refuse** — the same sentence that heads `../relations.ts`, because
 * this module is the second consumer that sentence was lifted for. Nothing here
 * decides whether a relation MAY be judged: `readRelation` /
 * {@link ../contracts} already asked the unit gates, and this file encodes what
 * they passed. What it adds is the finer refusal a SOLVER needs and a point
 * evaluation does not — a fractional exponent, a Boolean where a number has to
 * stand — and every one of those is returned as a {@link Refusal} with the same
 * branchable `reason` vocabulary the rest of the lane uses, never as a silent
 * omission and never as an exception.
 *
 * Four decisions carry the file:
 *
 *  1. **It emits TEXT, and it never imports z3.** The whole suite for this
 *     module runs with no solver installed, `export --format smt2` will be the
 *     same bytes the in-process solver saw rather than a second rendering of
 *     them, and "two encodes of the same model are byte-equal" is a statement
 *     about an artefact a person can read. {@link ./z3-bridge} asserts the
 *     script with `Solver.fromString`.
 *  2. **One variable per feature, declared in its STORAGE unit, read in SI.**
 *     The declaration is `(declare-fun |Pkg::uav::endurance| () Real)` — the
 *     magnitude the file stores — and every READ of it is `factor·x + offset`
 *     from the gates' own `ScaleMap`. Declaring the SI value instead would make
 *     a witness a number the model does not contain, and a person reading
 *     `endurance = 2835.7` for a feature written in hours cannot check the tool
 *     against the file. When the gates granted NO scale (the declared-unit
 *     contract: `range = 5.0 [km]` against `<= 10.0` is read in kilometres on
 *     both surfaces) the caller passes factor 1 / offset 0 and the read is the
 *     bare symbol — the same verbatim reading the numeric surface gives it.
 *  3. **Exact rationals, never a re-parsed decimal.** Every numeral a BODY
 *     contains is the binary64 the rest of this tool holds, written exactly:
 *     `18.5` is `(/ 37.0 2.0)` and `0.1` is `3602879701896397 / 2⁵⁵`, via the
 *     double's own significand and exponent, so the number the solver sees is
 *     precisely the number `checkConstraints` evaluates. Nothing is rounded on
 *     the way in, and nothing is re-parsed from a decimal. The one reading that
 *     is NOT the double is a feature VALUE the author wrote — `0.1` in a file is
 *     one tenth — and {@link valueTextNumeral} is the affordance for it; it is
 *     deliberately not applied to body literals, because an axiom set and a goal
 *     that disagreed about a boundary number would decide the boundary case by
 *     which side of the proof the number arrived on. The engine that builds
 *     feature-value axioms from `attrs.valueText` is commit 5, and it is the
 *     only caller that function is for.
 *  4. **Symbols are qualified names.** Element ids are fresh UUIDs on every load
 *     (§6, "element ids are not stable"), so a script keyed on them would differ
 *     between two loads of one file and no digest over it would mean anything.
 *     Two distinct PATHS that resolve to one feature therefore share one
 *     symbol — `u.powerIn.voltage` and `u.powerOut.voltage` are one element in
 *     this model, and every other surface of the tool reads them as one value.
 *
 * Pure and deterministic: nothing here reads or writes anything but its
 * arguments. Declarations are emitted in symbol order and labels are made
 * unique in assertion order, so the same input is the same bytes in any process.
 */

import type { ExprNode } from '../expr';
import type { ContractVariable, Fragment, Refusal, VarSort } from '../contracts';
import type { ScaleMap } from '../relations';

/* ────────────────────────────── variables ───────────────────────────────── */

/**
 * One feature as the encoder sees it: a symbol, a sort, and the affine map that
 * lifts its stored magnitude into SI.
 *
 * `free` is not a fact about the model; it is what the CALLER has released — a
 * feature with no literal value, or one named by `--free`. It decides only two
 * things, and both are reported: whether a product or a quotient counts as
 * nonlinear, and which variable a `QF_LRA → QF_NRA` promotion is blamed on.
 */
export interface EncodeVariable {
  /** The dotted path the relation body writes (`uav.endurance`). */
  path: string;
  /** The qualified name — the SMT symbol, and the only stable identity. */
  qualifiedName: string;
  sort: VarSort;
  /** `si = value·factor + offset`. 1 / 0 when the gates granted no scaling. */
  factor: number;
  offset: number;
  /** Has the caller released this feature's value? */
  free: boolean;
}

/**
 * Build the encoder's variable environment from a gated relation reading.
 *
 * `scaled` is the caller's answer to "did the gates grant a `ScaleMap`?" —
 * `reading.scale !== undefined`. It is an ARGUMENT rather than something this
 * module infers, because the answer is not derivable from the variables alone:
 * `range = 5.0 [km]` compared against a bare `10.0` has a variable with factor
 * 1000 and is nevertheless read in kilometres by both surfaces, and an encoder
 * that scaled it because it COULD would turn a satisfied constraint into
 * `5000 <= 10`. Getting it wrong is a confident wrong verdict, so it is stated.
 */
export function encodeVariables(
  variables: readonly ContractVariable[],
  sortPerVar: Readonly<Record<string, VarSort>>,
  opts: { scaled: boolean; free?: ReadonlySet<string> },
): EncodeVariable[] {
  const free = opts.free ?? new Set<string>();
  return variables.map((v) => ({
    path: v.path,
    qualifiedName: v.qualifiedName,
    sort: sortPerVar[v.path] ?? 'Real',
    factor: opts.scaled ? v.siFactor : 1,
    offset: opts.scaled ? v.siOffset : 0,
    free: free.has(v.path) || free.has(v.qualifiedName),
  }));
}

/**
 * The part of a gated relation reading this module needs — satisfied by
 * `RelationReading` of {@link ../contracts}, and by anything else that carries
 * the same three fields.
 */
export interface GatedRelation {
  variables: readonly ContractVariable[];
  sortPerVar: Readonly<Record<string, VarSort>>;
  /** The gates' own `ScaleMap`, or `undefined` when they granted no scaling. */
  scale: ScaleMap | undefined;
}

/**
 * {@link encodeVariables} for a caller that HAS the gated reading — the shape
 * every consumer should prefer.
 *
 * It takes each variable's factor and offset from the gates' own `ScaleMap`
 * rather than from `ContractVariable.siFactor`, and it therefore cannot scale a
 * relation the gates left in raw magnitudes: `siFactor` is the feature's
 * storage scale whatever the gates decided, and `scale === undefined` is the
 * decision. That is the whole difference between reading `range = 5.0 [km]`
 * against `<= 10.0` in kilometres, as both surfaces do, and reporting
 * `5000 <= 10`.
 */
export function encodeVariablesOf(
  reading: GatedRelation,
  free: ReadonlySet<string> = new Set(),
): EncodeVariable[] {
  return reading.variables.map((v) => {
    const s = reading.scale?.get(v.featureId);
    return {
      path: v.path,
      qualifiedName: v.qualifiedName,
      sort: reading.sortPerVar[v.path] ?? 'Real',
      factor: s?.factor ?? 1,
      offset: s?.offset ?? 0,
      free: free.has(v.path) || free.has(v.qualifiedName),
    };
  });
}

/* ─────────────────────────────── one relation ───────────────────────────── */

/**
 * A `≠ 0` (or any other) guard the ENCODING adds, with the sentence that says so.
 *
 * It is an ENCODING ASSUMPTION, not a fact the model states, and the difference
 * matters to whoever asserts it. A divisor the model pins at zero makes this
 * guard contradict the axiom set, and `A ∧ side ∧ ¬G` is then unsat for a reason
 * that has nothing to do with the goal — a vacuous "proved". So an engine must
 * put these through the once-per-run axiom-consistency precondition (§6,
 * "Vacuity") rather than fold them in beside the goal and read `unsat` as a
 * proof. Nothing in this commit asserts one; they are carried, named and
 * reported, so the engine that does assert them has to decide this on purpose.
 */
export interface SideCondition {
  /** The SMT term to assert beside the relation. */
  term: string;
  /** Why it is there, in words a verdict line can print. */
  detail: string;
  /** The variables in the divisor, by qualified name. */
  variables: string[];
}

/** A relation that encoded, and everything the report has to say about it. */
export interface EncodedRelation {
  ok: true;
  /** The SMT-LIB2 term. Boolean-sorted: a relation is a proposition. */
  term: string;
  /** Is it nonlinear once the caller's free set is taken into account? */
  nonlinear: boolean;
  /**
   * Is the TERM syntactically nonlinear, whatever the free set says?
   *
   * The two are different questions and only one of them is a question z3 will
   * answer. `{@link nonlinear}` is free-RELATIVE — `a * b` with `b` pinned by an
   * axiom is linear *reasoning*, and that is what the plan's `qf-lra`/`qf-nra`
   * report vocabulary means — but the bytes still say `(* |a| |b|)`, and z3
   * checks the `set-logic` line against the SYNTAX. Emitting `QF_LRA` for that
   * script makes z3 refuse the whole thing, which {@link ../z3-bridge} then
   * reports as `error`, i.e. as a defect in our own output. So the script's
   * logic line is computed from this flag (and, for a hand-built term, from a
   * scan of the term itself) while the report keeps the free-relative word.
   */
  syntacticNonlinear: boolean;
  /** The free variables a nonlinear site reads, by qualified name, sorted. */
  nonlinearIn: string[];
  /** `≠ 0` guards this encoding added, each naming its divisor. */
  sideConditions: SideCondition[];
  /** The variables the term actually reads, by qualified name, first-seen order. */
  reads: string[];
}

/** A relation this lane does not encode, with the reason a person branches on. */
export interface RefusedRelation {
  ok: false;
  refusal: Refusal;
}

export type RelationEncoding = EncodedRelation | RefusedRelation;

/** The sort an encoded term carries. `Int` is folded into `Real` — see {@link readOf}. */
type TermSort = 'Real' | 'Bool';

/** One encoded sub-term, or the refusal that stopped it. */
type Encoded = { ok: true; text: string; sort: TermSort } | RefusedRelation;

/** Working state for one relation: what it read, and what it had to add. */
interface Walk {
  vars: Map<string, EncodeVariable>;
  reads: string[];
  seen: Set<string>;
  nonlinearIn: Set<string>;
  nonlinear: boolean;
  /** Set wherever the emitted BYTES are nonlinear — see `EncodedRelation`. */
  syntacticNonlinear: boolean;
  sideConditions: SideCondition[];
}

/**
 * Encode one already-gated relation body.
 *
 * `node` is the LOWERED node — `readRelation` has already folded every
 * `[unit]` literal to its SI magnitude, so a `ref` reaching here is a feature
 * and never a lowering marker.
 */
export function encodeRelation(
  node: ExprNode,
  variables: readonly EncodeVariable[],
): RelationEncoding {
  const walk: Walk = {
    vars: indexBy(variables),
    reads: [],
    seen: new Set(),
    nonlinearIn: new Set(),
    nonlinear: false,
    syntacticNonlinear: false,
    sideConditions: [],
  };
  const encoded = term(node, walk);
  if (!encoded.ok) return encoded;
  if (encoded.sort !== 'Bool') {
    return refuse(
      'non-numeric-operand',
      'the body is an arithmetic expression, not a proposition: there is nothing for a solver to ' +
        'decide about `' +
        encoded.text +
        '` on its own',
    );
  }
  return {
    ok: true,
    term: encoded.text,
    nonlinear: walk.nonlinear,
    syntacticNonlinear: walk.syntacticNonlinear,
    nonlinearIn: [...walk.nonlinearIn].sort(),
    sideConditions: walk.sideConditions,
    reads: walk.reads,
  };
}

/** Both spellings a body may use for a variable: its path and its qualified name. */
function indexBy(variables: readonly EncodeVariable[]): Map<string, EncodeVariable> {
  const map = new Map<string, EncodeVariable>();
  for (const v of variables) {
    if (!map.has(v.path)) map.set(v.path, v);
    if (!map.has(v.qualifiedName)) map.set(v.qualifiedName, v);
  }
  return map;
}

/** A refusal in the shape every other gate in this lane returns. */
function refuse(reason: Refusal['reason'], detail: string): RefusedRelation {
  return { ok: false, refusal: { reason, detail } };
}

/** The recursive descent. Every arm returns a SORT, because sorts are checked. */
function term(node: ExprNode, walk: Walk): Encoded {
  switch (node.kind) {
    case 'num':
      return numeral(node.value);
    case 'bool':
      return { ok: true, text: node.value ? 'true' : 'false', sort: 'Bool' };
    case 'str':
      return refuse(
        'non-numeric-operand',
        `the body reads the string literal "${node.value}"; only numeric and boolean operands are encoded`,
      );
    case 'null':
      return refuse(
        'non-numeric-operand',
        'the body reads `null`, which has no encoding in a quantifier-free arithmetic',
      );
    case 'ref':
      return readOf(node.path.join('.'), walk);
    case 'unary':
      return unary(node, walk);
    case 'binary':
      return binary(node, walk);
    case 'if':
      return ite(node, walk);
  }
}

/**
 * One read of a feature: the symbol, lifted into SI by its own scale.
 *
 * An `Int`-sorted feature is DECLARED `Int` — the integrality is a fact about
 * the model and is kept — and READ through `to_real`, so every arithmetic term
 * in a script is Real-sorted and a mixed comparison cannot be ill-sorted. The
 * logic line says `QF_LIRA` / `QF_NIRA` when that happens (see
 * {@link logicOf}); the report's fragment vocabulary stays the plan's two words.
 */
function readOf(path: string, walk: Walk): Encoded {
  const v = walk.vars.get(path);
  if (!v) {
    return refuse(
      'unresolved-name',
      `\`${path}\` names nothing the encoder was given a variable for, so there is no symbol to encode`,
    );
  }
  const symbol = symbolOf(v.qualifiedName);
  if (symbol === undefined) {
    return refuse(
      'unparseable',
      `the qualified name \`${v.qualifiedName}\` contains a character no SMT symbol can carry ` +
        '(`|` or `\\`), so the feature cannot be named in a script',
    );
  }
  if (!walk.seen.has(v.qualifiedName)) {
    walk.seen.add(v.qualifiedName);
    walk.reads.push(v.qualifiedName);
  }
  if (v.sort === 'Bool') {
    if (v.factor !== 1 || v.offset !== 0) {
      return refuse(
        'non-numeric-operand',
        `\`${v.path}\` is a boolean carrying a unit scale, which is not a reading this lane has`,
      );
    }
    return { ok: true, text: symbol, sort: 'Bool' };
  }
  // A degenerate scale is a REFUSAL, not an exception and not a silent erasure.
  // `exactNumeral` throws on a non-finite number, and this module's charter is
  // that everything it cannot encode comes back as a `Refusal`; a factor of
  // zero is worse than a throw, because `(* 0.0 |x|)` would quietly delete the
  // variable from the relation and leave a verdict about nothing.
  if (!Number.isFinite(v.factor) || !Number.isFinite(v.offset) || v.factor === 0) {
    return refuse(
      'unscalable',
      `\`${v.path}\` carries a scale this encoder cannot write (factor \`${String(v.factor)}\`, ` +
        `offset \`${String(v.offset)}\`): a factor must be a finite non-zero number, since a zero ` +
        'factor would erase the variable from the relation rather than scale it',
    );
  }
  const base = v.sort === 'Int' ? `(to_real ${symbol})` : symbol;
  return { ok: true, text: affine(base, v.factor, v.offset), sort: 'Real' };
}

/** `factor·x + offset`, with the identity map written as the bare symbol. */
function affine(base: string, factor: number, offset: number): string {
  const scaled = factor === 1 ? base : `(* ${exactNumeral(factor)} ${base})`;
  return offset === 0 ? scaled : `(+ ${scaled} ${exactNumeral(offset)})`;
}

/** `-x`, `+x`, `not x`. */
function unary(node: Extract<ExprNode, { kind: 'unary' }>, walk: Walk): Encoded {
  const operand = term(node.operand, walk);
  if (!operand.ok) return operand;
  if (node.op === 'not') {
    if (operand.sort !== 'Bool') return sortClash('not', 'a boolean', operand.sort);
    return { ok: true, text: `(not ${operand.text})`, sort: 'Bool' };
  }
  if (operand.sort !== 'Real') return sortClash(node.op, 'a number', operand.sort);
  return node.op === '-'
    ? { ok: true, text: `(- ${operand.text})`, sort: 'Real' }
    : { ok: true, text: operand.text, sort: 'Real' };
}

/** The comparison operators, by the SMT-LIB symbol each maps to. */
const COMPARISONS: Readonly<Record<string, string>> = {
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
};

/** The boolean connectives, by the SMT-LIB symbol each maps to. */
const CONNECTIVES: Readonly<Record<string, string>> = {
  and: 'and',
  or: 'or',
  xor: 'xor',
  implies: '=>',
};

function binary(node: Extract<ExprNode, { kind: 'binary' }>, walk: Walk): Encoded {
  const op = node.op;

  // `%` and a variable exponent are refused BEFORE their operands are walked,
  // so the reason names the operator rather than whatever its operands say.
  if (op === '%') {
    return refuse(
      'unsupported-operator',
      'the remainder operator `%` has no encoding in this fragment',
    );
  }
  if (op === '^') return power(node, walk);

  const left = term(node.left, walk);
  if (!left.ok) return left;
  const right = term(node.right, walk);
  if (!right.ok) return right;

  if (op === '+' || op === '-' || op === '*') {
    if (left.sort !== 'Real' || right.sort !== 'Real') {
      return sortClash(op, 'two numbers', left.sort === 'Real' ? right.sort : left.sort);
    }
    if (op === '*' && varsOf(node.left, walk).length > 0 && varsOf(node.right, walk).length > 0) {
      // Syntax first: `(* |a| |b|)` is a nonlinear SCRIPT whether or not either
      // operand is freed, and the `set-logic` line has to say so.
      walk.syntacticNonlinear = true;
      if (readsFree(node.left, walk) && readsFree(node.right, walk)) markNonlinear(node, walk);
    }
    return { ok: true, text: `(${op} ${left.text} ${right.text})`, sort: 'Real' };
  }

  if (op === '/') {
    if (left.sort !== 'Real' || right.sort !== 'Real') {
      return sortClash(op, 'two numbers', left.sort === 'Real' ? right.sort : left.sort);
    }
    return division(node, left.text, right.text, walk);
  }

  const cmp = COMPARISONS[op];
  if (cmp !== undefined) {
    if (left.sort !== 'Real' || right.sort !== 'Real') {
      return sortClash(op, 'two numbers', left.sort === 'Real' ? right.sort : left.sort);
    }
    return { ok: true, text: `(${cmp} ${left.text} ${right.text})`, sort: 'Bool' };
  }

  if (op === '==' || op === '=' || op === '!=') {
    if (left.sort !== right.sort) {
      return refuse(
        'non-numeric-operand',
        `\`${op}\` compares a ${left.sort.toLowerCase()} with a ${right.sort.toLowerCase()}; ` +
          'only operands of one sort are encoded',
      );
    }
    const text = op === '!=' ? `(distinct ${left.text} ${right.text})` : `(= ${left.text} ${right.text})`;
    return { ok: true, text, sort: 'Bool' };
  }

  const connective = CONNECTIVES[op];
  if (connective !== undefined) {
    if (left.sort !== 'Bool' || right.sort !== 'Bool') {
      return sortClash(op, 'two booleans', left.sort === 'Bool' ? right.sort : left.sort);
    }
    return { ok: true, text: `(${connective} ${left.text} ${right.text})`, sort: 'Bool' };
  }

  return refuse('unsupported-operator', `the operator \`${op}\` has no encoding in this fragment`);
}

/**
 * `a / b`, and the `≠ 0` guard a variable divisor obliges.
 *
 * SMT-LIB's `/` is TOTAL: `x / 0` is an unspecified value, not an error, so a
 * solver handed a model where the divisor can be zero will happily satisfy the
 * formula through a division this tool's own evaluator calls undefined. The
 * guard is therefore asserted beside the relation, and it is REPORTED — the
 * plan's words are "adds `≠ 0` **and says so**" — because a proof that quietly
 * assumed a denominator non-zero is a proof of something the reader did not ask
 * for.
 *
 * The guard is added for ANY divisor that reads a variable, not only a freed
 * one. A pinned divisor is pinned by an axiom in a different assertion; the
 * guard costs one literal, and stating it is cheaper than reasoning about which
 * axioms happened to be in the same script.
 */
function division(
  node: Extract<ExprNode, { kind: 'binary' }>,
  left: string,
  right: string,
  walk: Walk,
): Encoded {
  if (node.right.kind === 'num' && node.right.value === 0) {
    return refuse(
      'unsupported-operator',
      'the body divides by the literal zero, which SMT-LIB leaves unspecified rather than undefined',
    );
  }
  const divisorVars = varsOf(node.right, walk);
  if (divisorVars.length > 0) {
    // A variable divisor is nonlinear ARITHMETIC whatever pins it, and the
    // logic line is checked against the bytes rather than against the free set.
    walk.syntacticNonlinear = true;
    if (readsFree(node.right, walk)) markNonlinear(node, walk);
    walk.sideConditions.push({
      term: `(distinct ${right} 0.0)`,
      detail:
        `the divisor \`${divisorVars.join('`, `')}\` is a variable, so the encoding asserts it is ` +
        'non-zero: SMT-LIB division is total and would otherwise satisfy the relation through a ' +
        'value this tool’s own evaluator calls undefined',
      variables: divisorVars,
    });
  }
  return { ok: true, text: `(/ ${left} ${right})`, sort: 'Real' };
}

/** The largest literal exponent this encoder will expand into a product. */
const MAX_EXPONENT = 32;

/**
 * The exponent as a literal number, or `undefined` when it is not one.
 *
 * `parseExpr` renders `x ^ -1` as `binary(^, ref x, unary(-, num 1))` — the
 * minus is a UNARY node, not part of the numeral — so a plain
 * `node.right.kind === 'num'` test calls a written literal "not a literal" and
 * makes the negative-exponent arm of {@link power} unreachable. Folding the
 * sign here keeps that arm live and keeps the refusal sentence truthful.
 */
function literalExponent(node: ExprNode): number | undefined {
  if (node.kind === 'num') return node.value;
  if (node.kind === 'unary' && (node.op === '-' || node.op === '+')) {
    const inner = literalExponent(node.operand);
    if (inner === undefined) return undefined;
    return node.op === '-' ? -inner : inner;
  }
  return undefined;
}

/**
 * `a ^ n`, expanded into a product.
 *
 * Only an INTEGER literal exponent is encoded, and only up to
 * {@link MAX_EXPONENT}. SMT-LIB's `^` is not in the quantifier-free arithmetic
 * fragments at all, a fractional exponent is a root (partial, and outside the
 * polynomial reading the fragment names promise), and a variable exponent has
 * no polynomial reading whatever — the gate in `../contracts` already refuses
 * that one, and this refuses the two it does not see.
 */
function power(node: Extract<ExprNode, { kind: 'binary' }>, walk: Walk): Encoded {
  const literal = literalExponent(node.right);
  if (literal === undefined) {
    return refuse(
      'unsupported-operator',
      'the exponent is not a literal, and a variable exponent has no polynomial reading',
    );
  }
  const n = literal;
  if (!Number.isInteger(n)) {
    return refuse(
      'unsupported-operator',
      `the exponent \`${n}\` is not an integer; a fractional power is a root, which is outside the ` +
        'polynomial fragment this lane encodes',
    );
  }
  if (Math.abs(n) > MAX_EXPONENT) {
    return refuse(
      'unsupported-operator',
      `the exponent \`${n}\` is larger than the ${MAX_EXPONENT} this encoder expands into a product`,
    );
  }
  const base = term(node.left, walk);
  if (!base.ok) return base;
  if (base.sort !== 'Real') return sortClash('^', 'a number', base.sort);
  if (n !== 0 && n !== 1 && varsOf(node.left, walk).length > 0) {
    // `x ^ 3` expands to `(* x x x)` and `x ^ -1` to `(/ 1.0 x)`; both are
    // nonlinear bytes, so the logic line moves even when `x` is pinned.
    walk.syntacticNonlinear = true;
    if (readsFree(node.left, walk)) markNonlinear(node, walk);
  }

  const k = Math.abs(n);
  if (k === 0) return { ok: true, text: '1.0', sort: 'Real' };
  const product =
    k === 1 ? base.text : `(* ${Array.from({ length: k }, () => base.text).join(' ')})`;
  if (n > 0) return { ok: true, text: product, sort: 'Real' };
  const baseVars = varsOf(node.left, walk);
  if (baseVars.length > 0) {
    walk.sideConditions.push({
      term: `(distinct ${base.text} 0.0)`,
      detail:
        `the base \`${baseVars.join('`, `')}\` of a negative power is a variable, so the encoding ` +
        'asserts it is non-zero: SMT-LIB division is total and would otherwise satisfy the ' +
        'relation through a value this tool’s own evaluator calls undefined',
      variables: baseVars,
    });
  }
  return { ok: true, text: `(/ 1.0 ${product})`, sort: 'Real' };
}

/** `if c then t else e` → `ite`, with both branches at one sort. */
function ite(node: Extract<ExprNode, { kind: 'if' }>, walk: Walk): Encoded {
  const cond = term(node.cond, walk);
  if (!cond.ok) return cond;
  if (cond.sort !== 'Bool') return sortClash('if', 'a boolean condition', cond.sort);
  const then = term(node.then, walk);
  if (!then.ok) return then;
  const other = term(node.else, walk);
  if (!other.ok) return other;
  if (then.sort !== other.sort) {
    return refuse(
      'non-numeric-operand',
      `the two branches of an \`if\` carry different sorts (${then.sort} and ${other.sort}), ` +
        'which has no single-sorted encoding',
    );
  }
  return {
    ok: true,
    text: `(ite ${cond.text} ${then.text} ${other.text})`,
    sort: then.sort,
  };
}

/** The refusal an operator makes when its operand is the wrong sort. */
function sortClash(op: string, wanted: string, got: TermSort): RefusedRelation {
  return refuse(
    'non-numeric-operand',
    `\`${op}\` wants ${wanted} and one operand encodes as a ${got.toLowerCase()}`,
  );
}

/** Record a nonlinear site, and which freed variables it reads. */
function markNonlinear(node: ExprNode, walk: Walk): void {
  walk.nonlinear = true;
  for (const name of freeVarsOf(node, walk)) walk.nonlinearIn.add(name);
}

/** The qualified names of every variable an expression reads. */
function varsOf(node: ExprNode, walk: Walk): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: ExprNode): void => {
    switch (n.kind) {
      case 'ref': {
        const v = walk.vars.get(n.path.join('.'));
        if (v && !seen.has(v.qualifiedName)) {
          seen.add(v.qualifiedName);
          out.push(v.qualifiedName);
        }
        return;
      }
      case 'unary':
        visit(n.operand);
        return;
      case 'binary':
        visit(n.left);
        visit(n.right);
        return;
      case 'if':
        visit(n.cond);
        visit(n.then);
        visit(n.else);
        return;
      default:
        return;
    }
  };
  visit(node);
  return out;
}

/** The FREED variables an expression reads, by qualified name. */
function freeVarsOf(node: ExprNode, walk: Walk): string[] {
  return varsOf(node, walk).filter((name) => {
    const v = walk.vars.get(name);
    return v?.free === true;
  });
}

/**
 * Does this expression read a variable the caller released?
 *
 * The same question `isNonlinear` asks in `../contracts`, over the same free
 * set, so the fragment this encoder reports and the fragment the inventory
 * reports agree by construction of the ARGUMENT rather than by coincidence —
 * `test/unit/smt.encode.test.ts` asserts the two answers match over a corpus of
 * bodies, which is the check that keeps them from drifting.
 */
function readsFree(node: ExprNode, walk: Walk): boolean {
  return freeVarsOf(node, walk).length > 0;
}

/* ─────────────────────────────── numerals ───────────────────────────────── */

/** A numeral, or the refusal a non-finite number earns. */
function numeral(value: number): Encoded {
  if (!Number.isFinite(value)) {
    return refuse(
      'non-numeric-operand',
      `the body reads \`${String(value)}\`, which is not a rational and has no SMT-LIB numeral`,
    );
  }
  return { ok: true, text: exactNumeral(value), sort: 'Real' };
}

/**
 * A binary64 as an EXACT SMT-LIB rational.
 *
 * Every double is `m · 2^e` for integers `m` and `e`, so every double is exactly
 * a rational with a power-of-two denominator — `0.1` is
 * `3602879701896397 / 2^55`, not one tenth. Writing that rational rather than
 * the shortest decimal that round-trips means the solver reasons about the
 * number this tool actually holds. It is also why {@link valueTextNumeral}
 * exists: for a value the AUTHOR wrote, one tenth is the right reading and the
 * double is not, so the text is preferred wherever there is one.
 */
export function exactNumeral(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`\`${String(value)}\` has no SMT-LIB numeral`);
  }
  if (value === 0) return Object.is(value, -0) ? '0.0' : '0.0';
  const { num, den } = exactRationalOfDouble(value);
  return render(num < 0n ? -num : num, den, num < 0n);
}

/** A double as an exact `num / den` in lowest terms, `den` a power of two. */
export function exactRationalOfDouble(value: number): { num: bigint; den: bigint } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = (BigInt(view.getUint32(0)) << 32n) | BigInt(view.getUint32(4));
  const negative = (bits >> 63n) === 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xf_ffff_ffff_ffffn;
  // Subnormals carry no implicit leading bit and sit at the smallest exponent.
  let mantissa = exponent === 0 ? fraction : fraction | (1n << 52n);
  let scale = exponent === 0 ? -1074 : exponent - 1075;
  while (mantissa !== 0n && mantissa % 2n === 0n && scale < 0) {
    mantissa /= 2n;
    scale += 1;
  }
  const magnitude = scale >= 0 ? mantissa << BigInt(scale) : mantissa;
  const den = scale >= 0 ? 1n : 1n << BigInt(-scale);
  return { num: negative ? -magnitude : magnitude, den };
}

/**
 * The author's own decimal text as an EXACT SMT-LIB rational.
 *
 * `attrs.valueText` is what the file says — `18.5`, `0.1`, `1.5e3` — and it is
 * preferred over the double it parsed to wherever the tool has it. Anything
 * that is not a decimal literal is refused rather than coerced: a value this
 * function cannot read is a value the axiom set must not contain.
 */
export function valueTextNumeral(text: string): { ok: true; text: string } | RefusedRelation {
  const t = text.trim();
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(t);
  if (!m) {
    return refuse(
      'non-numeric-operand',
      `\`${text}\` is not a decimal literal this encoder can read as an exact rational`,
    );
  }
  const [, sign, whole, frac = '', exp = '0'] = m;
  let num = BigInt(whole + frac);
  let den = 10n ** BigInt(frac.length);
  const e = Number(exp);
  if (e > 0) num *= 10n ** BigInt(e);
  else if (e < 0) den *= 10n ** BigInt(-e);
  const g = gcd(num, den);
  if (g > 1n) {
    num /= g;
    den /= g;
  }
  return { ok: true, text: render(num, den, sign === '-' && num !== 0n) };
}

/** `num / den` as an SMT-LIB Real term; SMT-LIB has no negative numeral. */
function render(num: bigint, den: bigint, negative: boolean): string {
  const body = den === 1n ? `${num}.0` : `(/ ${num}.0 ${den}.0)`;
  return negative ? `(- ${body})` : body;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) {
    [x, y] = [y, x % y];
  }
  return x;
}

/* ──────────────────────────────── the script ────────────────────────────── */

/** Which side of a proof an assertion stands on — and its label's prefix. */
export type AssertionKind = 'axiom' | 'premise' | 'goal' | 'side';

/** One labelled assertion of a script. */
export interface ScriptAssertion {
  kind: AssertionKind;
  /**
   * The name the label carries — a qualified name or a requirement's short id.
   * NEVER an element id: ids are fresh per load and a script keyed on one is
   * not the same bytes twice.
   */
  name: string;
  /** The Boolean-sorted term. */
  term: string;
}

/** The encoded script, and everything a report needs to describe it. */
export interface SmtScript {
  /** Exactly the bytes {@link ./z3-bridge}'s `check` asserts. */
  text: string;
  /** The `set-logic` line's logic. */
  logic: string;
  /** The plan's two-word fragment vocabulary, which the logic refines. */
  fragment: Fragment;
  /** The declared symbols, in the order they are declared (symbol order). */
  symbols: string[];
  /** The `:named` labels, in assertion order — what an UNSAT core comes back as. */
  labels: string[];
}

/** What a script is built from. */
export interface ScriptRequest {
  /** Every variable the assertions may read. Only the ones read are declared. */
  variables: readonly EncodeVariable[];
  assertions: readonly ScriptAssertion[];
  /**
   * Is any assertion nonlinear once the caller's free set is taken into account?
   *
   * This is the REPORT's word — the plan's `qf-lra` / `qf-nra` vocabulary — and
   * it decides {@link SmtScript.fragment} and nothing else. The `set-logic`
   * line is computed from the SYNTAX of the assertion terms, because that is
   * what z3 checks it against.
   */
  nonlinear: boolean;
  /**
   * The encoder's own answer to "are the emitted bytes nonlinear?", when the
   * caller has one ({@link EncodedRelation.syntacticNonlinear}).
   *
   * Optional because it is only ever an accelerator: {@link encodeScript} scans
   * the terms it was handed regardless, so a caller that forgets this field
   * still gets a logic line the script actually fits.
   */
  syntacticNonlinear?: boolean;
  /** Emit `(set-option :produce-unsat-cores true)`. Default true. */
  cores?: boolean;
}

/**
 * The header, written once and never with a version or a timestamp.
 *
 * A byte-stable artefact is the point (§6, "element ids are not stable"): the
 * export test compares two scripts from two PROCESSES, and anything that moves
 * between runs — a clock, a build number, an element id — would make that test
 * about the header rather than about the encoding.
 */
const HEADER = [
  '; sysprose — SMT-LIB2 encoding of one obligation.',
  '; Variables are declared in their storage unit; every read is lifted to coherent SI.',
  '; Symbols and assertion labels are qualified names — never element ids, which are fresh per load.',
].join('\n');

/**
 * Render one script.
 *
 * `(check-sat)` is deliberately NOT emitted: this text is exactly what is
 * asserted, and the check is the caller's — {@link ./z3-bridge} calls
 * `solver.check()` and an export appends its own `(check-sat)` / `(get-model)`.
 * Emitting it here would make the in-process solver run a check while merely
 * parsing the script.
 */
export function encodeScript(req: ScriptRequest): SmtScript {
  const read = new Set<string>();
  for (const a of req.assertions) {
    for (const v of req.variables) {
      if (mentions(a.term, symbolOf(v.qualifiedName))) read.add(v.qualifiedName);
    }
  }
  const declared = req.variables
    .filter((v) => read.has(v.qualifiedName))
    .filter((v, i, all) => all.findIndex((o) => o.qualifiedName === v.qualifiedName) === i)
    .sort((a, b) => (a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0));

  // The logic line is the one claim in this file z3 will CHECK, so it is
  // derived from the bytes rather than from the caller's free-relative flag.
  const syntacticNonlinear =
    req.syntacticNonlinear === true || req.assertions.some((a) => nonlinearTerm(a.term));
  const logic = logicOf(declared, syntacticNonlinear);
  const lines = [HEADER, `(set-logic ${logic})`];
  if (req.cores !== false) lines.push('(set-option :produce-unsat-cores true)');
  const symbols: string[] = [];
  for (const v of declared) {
    const symbol = symbolOf(v.qualifiedName);
    if (symbol === undefined) continue;
    symbols.push(v.qualifiedName);
    lines.push(`(declare-fun ${symbol} () ${v.sort})`);
  }

  const labels: string[] = [];
  const used = new Set<string>();
  for (const a of req.assertions) {
    // Uniqueness is decided AFTER the mangling, and the mangled string is what
    // is reported. `|` and `\` cannot appear inside a quoted SMT symbol, so a
    // name holding either is written with `_` — and two names that differ only
    // in those characters therefore become one label. Deduplicating on the raw
    // name would emit that label twice, which z3 refuses outright ("named
    // expression already defined") and which would otherwise attribute an unsat
    // core to the wrong requirement. Returning the mangled form is the other
    // half: `coreOf` reads these strings back out of z3.
    const base = labelSymbol(`${a.kind}:${a.name}`);
    let label = base;
    for (let n = 2; used.has(label); n += 1) label = `${base}#${n}`;
    used.add(label);
    labels.push(label);
    lines.push(`(assert (! ${a.term} :named |${label}|))`);
  }

  return {
    text: `${lines.join('\n')}\n`,
    logic,
    fragment: req.nonlinear ? 'qf-nra' : 'qf-lra',
    symbols,
    labels,
  };
}

/** A label as an SMT symbol: the two characters a quoted symbol cannot hold. */
function labelSymbol(name: string): string {
  return name.replace(/[|\\]/g, '_');
}

/**
 * Is this term's SYNTAX nonlinear?
 *
 * z3 checks `(set-logic QF_LRA)` against the shape of the assertions, not
 * against anybody's reasoning about which variables are pinned, so this scan is
 * the thing that decides the logic line. `(* 60.0 |x|)` is linear — one operand
 * carries a symbol; `(* |x| |y|)` is not, and neither is a division whose
 * divisor carries one. A term this returns `true` for and a `QF_LRA` header is
 * a script z3 refuses outright, reported by {@link ../z3-bridge} as `error`.
 *
 * Not exported: {@link encodeScript} is the only caller, and an exported helper
 * nothing calls is how a documented behaviour ends up describing no code path.
 */
function nonlinearTerm(text: string): boolean {
  return parseSexps(text).some(nonlinearSexp);
}

/** An S-expression: a quoted-or-bare atom, or an application. */
type Sexp = string | Sexp[];

/** Tokenise and nest. `|a::b|` is one atom, pipes included. */
function parseSexps(text: string): Sexp[] {
  const stack: Sexp[][] = [[]];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '(') {
      const child: Sexp[] = [];
      stack[stack.length - 1].push(child);
      stack.push(child);
      i += 1;
    } else if (c === ')') {
      if (stack.length > 1) stack.pop();
      i += 1;
    } else if (c === '|') {
      const end = text.indexOf('|', i + 1);
      if (end === -1) return stack[0];
      stack[stack.length - 1].push(text.slice(i, end + 1));
      i = end + 1;
    } else if (/\s/.test(c)) {
      i += 1;
    } else {
      let j = i;
      while (j < text.length && !/[\s()|]/.test(text[j])) j += 1;
      stack[stack.length - 1].push(text.slice(i, j));
      i = j;
    }
  }
  return stack[0];
}

/** Does this sub-term carry a variable, as opposed to only literals? */
function carriesSymbol(s: Sexp): boolean {
  // The head of an application is an operator (`-`, `to_real`, `ite`), never a
  // variable, so `(- 3.0)` and `(/ 37.0 2.0)` are literals and are skipped.
  if (Array.isArray(s)) return s.slice(1).some(carriesSymbol);
  return !/^[+-]?\d/.test(s) && s !== 'true' && s !== 'false';
}

function nonlinearSexp(s: Sexp): boolean {
  if (!Array.isArray(s) || s.length === 0) return false;
  const head = s[0];
  const args = s.slice(1);
  if (head === '*' && args.filter(carriesSymbol).length >= 2) return true;
  if (head === '/' && args.slice(1).some(carriesSymbol)) return true;
  if (head === '^') return true;
  return s.some(nonlinearSexp);
}

/**
 * The `set-logic` line.
 *
 * The plan's report vocabulary has two words — `qf-lra` and `qf-nra` — and
 * SMT-LIB has four names for what this encoder can produce, because an `Int`
 * declaration puts a script in the mixed integer/real fragment. The report
 * keeps the two words; the script names the logic its BYTES are in. The two
 * questions differ, and the difference is the whole reason this takes a
 * syntactic flag rather than the report's: `a * b` with `b` pinned by an axiom
 * is linear reasoning and a nonlinear script, and a `QF_LRA` header over it is
 * refused by z3 before it decides anything.
 */
function logicOf(declared: readonly EncodeVariable[], nonlinear: boolean): string {
  const mixed = declared.some((v) => v.sort === 'Int');
  if (mixed) return nonlinear ? 'QF_NIRA' : 'QF_LIRA';
  return nonlinear ? 'QF_NRA' : 'QF_LRA';
}

/**
 * Does this term mention a symbol?
 *
 * A substring test is exact here BECAUSE every symbol is pipe-quoted: `|A::b|`
 * cannot occur inside `|A::bc|`, since the closing pipe would have to match a
 * `c`. An unquoted spelling would need a token scan.
 */
function mentions(term: string, symbol: string | undefined): boolean {
  if (symbol === undefined) return false;
  return term.includes(symbol);
}

/**
 * A qualified name as an SMT-LIB symbol, or `undefined` when it cannot be one.
 *
 * Always quoted with pipes: a qualified name carries `::` and may carry spaces,
 * and a quoted symbol is the only spelling that survives both. The two
 * characters a quoted symbol may not contain are `|` and `\`, and a name
 * holding either is refused rather than mangled — a mangled symbol is a symbol
 * that no longer names the feature it came from.
 */
export function symbolOf(qualifiedName: string): string | undefined {
  if (qualifiedName.includes('|') || qualifiedName.includes('\\')) return undefined;
  return `|${qualifiedName}|`;
}

/** `¬t` — the negation step 1 of the SMT engine asserts. */
export function notTerm(term: string): string {
  return `(not ${term})`;
}
