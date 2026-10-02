/**
 * The defining equation of a feature that states no value (CV-17):
 * `attribute est; assert constraint { est == a * b / c }` gives `est` the value
 * of the right-hand side.
 *
 * It lives apart from both evaluators because both read it: the scalar scope in
 * {@link ./evaluate-model} and the quantity scope in {@link ./units-eval}, which
 * imports nothing from the former. Two copies of the rule were two chances to
 * let one scope read an equation as a definition that the other reads as a
 * check — the same model then fixed a value on one path and not on the other.
 *
 * The rule has three parts, all here:
 *  - WHICH equations may define a name, and in what order
 *    ({@link definingEquationsFor});
 *  - which of them DOES, when a derivation is under way
 *    ({@link chooseDefinition}): the first that gives the name a value — one
 *    that would lead back to a feature already being derived never does;
 *  - how deep definitions may nest ({@link MAX_DERIVATION_DEPTH}).
 */

import { type AttrValue, type ElementId, type ElementRecord, type Model } from '@core/index';
import { effectiveFeatures } from './inheritance';
import { type ExprNode } from './expr';
import { NO_MARKERS, parseRelationBody, type MarkerDimensions } from './unit-literals';

/** An asserted equation that may define a name: `name == <expr>`, or `<expr> == name`. */
export interface DefiningEquation {
  constraint: ElementRecord;
  /** The side that defines the name — the other one. */
  definition: ExprNode;
  /** True when the name is the LEFT side: the CV-17 form `name == <expr>`. */
  left: boolean;
  /**
   * The `[unit]` literals the equation carries, lowered: `definition` reads a
   * marker name for each ({@link ./unit-literals}). Empty for a body without.
   */
  literals: MarkerDimensions;
}

/**
 * Every asserted equation `name == <expr>` (either way round) among the
 * constraints `ownerId` owns, in the order a derivation tries them: those with
 * the name on the LEFT — the CV-17 form, the one an author writes as a
 * definition — first, then those with it on the right; each in declaration
 * order.
 *
 * Declaration order alone decided before, and on either side: `assert
 * constraint { b == a }` written above `assert constraint { a == x0 * 2.0 }`
 * read the alias as `a`'s definition, so `a` was derived from `b`, `b` from
 * `a`, and both were refused as the loop "a → b → a" — swap the two lines and
 * a = b = 2 m. Two equations that fix the same name to DIFFERENT values
 * (`x == 1.0` and `2.0 == x`) are a model at odds with itself; the one that
 * defines is the first in this order that gives a value — so `x == 1.0` in
 * either order — and the other is judged against it, and violated.
 */
export function definingEquationsFor(model: Model, ownerId: ElementId, name: string): DefiningEquation[] {
  return equationsByName(model, ownerId).get(name) ?? [];
}

/** The first of {@link definingEquationsFor}: whether a name has a defining equation at all. */
export function definingEquationFor(model: Model, ownerId: ElementId, name: string): DefiningEquation | undefined {
  return definingEquationsFor(model, ownerId, name)[0];
}

/** {@link definingEquationsFor} for every name at once: one parse of each constraint `ownerId` owns. */
function equationsByName(model: Model, ownerId: ElementId): Map<string, DefiningEquation[]> {
  const left = new Map<string, DefiningEquation[]>();
  const right = new Map<string, DefiningEquation[]>();
  const add = (into: Map<string, DefiningEquation[]>, name: string, e: DefiningEquation) => {
    const list = into.get(name);
    if (list) list.push(e);
    else into.set(name, [e]);
  };
  for (const c of model.children(ownerId)) {
    if (!isAsserted(c)) continue;
    const eq = equationOf(c);
    if (!eq) continue;
    const { node, literals } = eq;
    const l = bareName(node.left, literals);
    const r = bareName(node.right, literals);
    if (l !== undefined) add(left, l, { constraint: c, definition: node.right, left: true, literals });
    if (r !== undefined && r !== l) add(right, r, { constraint: c, definition: node.left, left: false, literals });
  }
  for (const [name, list] of right) {
    const first = left.get(name);
    if (first) first.push(...list);
    else left.set(name, list);
  }
  return left;
}

/**
 * The defining equations one evaluation pass reads, gathered once per context
 * — with the valueless feature of each name an equation there may define — so
 * a long chain does not re-parse every constraint of its context at every
 * link. It reads the model as it is when the pass starts, and lives exactly as
 * long as the pass that made it.
 */
export class DefiningEquations {
  private readonly equations = new Map<ElementId, Map<string, DefiningEquation[]>>();
  private readonly valueless = new Map<ElementId, Map<string, ElementRecord>>();
  private readonly named = new Map<ElementId, Map<string, ElementRecord>>();
  private readonly redefined = new Map<ElementId, ReadonlySet<ElementId>>();
  private readonly same = new Map<string, boolean>();
  private readonly stated = new Map<ElementId, { value: AttrValue | undefined; names?: string[] }>();
  private bound?: ReadonlySet<ElementId>;

  constructor(readonly model: Model) {}

  /** {@link definingEquationsFor}. */
  of(contextId: ElementId, name: string): readonly DefiningEquation[] {
    let byName = this.equations.get(contextId);
    if (!byName) {
      byName = equationsByName(this.model, contextId);
      this.equations.set(contextId, byName);
    }
    return byName.get(name) ?? [];
  }

  /** The first of `contextId`'s effective features named `name` that states no value. */
  feature(contextId: ElementId, name: string): ElementRecord | undefined {
    let byName = this.valueless.get(contextId);
    if (!byName) {
      byName = new Map();
      for (const f of effectiveFeatures(this.model, contextId)) {
        if (f.declaredName && !hasStatedValue(this.model, f) && !byName.has(f.declaredName)) byName.set(f.declaredName, f);
      }
      this.valueless.set(contextId, byName);
    }
    return byName.get(name);
  }

  /** `contextId`'s effective features by declared name, first occurrence: the feature a bare name denotes there. */
  byName(contextId: ElementId): ReadonlyMap<string, ElementRecord> {
    let byName = this.named.get(contextId);
    if (!byName) {
      byName = new Map();
      for (const f of effectiveFeatures(this.model, contextId)) {
        if (f.declaredName && !byName.has(f.declaredName)) byName.set(f.declaredName, f);
      }
      this.named.set(contextId, byName);
    }
    return byName;
  }

  /**
   * Every feature a feature of `contextId` redefines, through any number of
   * redefinitions. An unnamed redefinition (`attribute :>> load = 50.0`)
   * claims no name, so a scope still answers `load` with the feature it
   * redefines; this is where it is seen.
   */
  redefinedIn(contextId: ElementId): ReadonlySet<ElementId> {
    let out = this.redefined.get(contextId);
    if (!out) {
      const set = new Set<ElementId>();
      const queue = effectiveFeatures(this.model, contextId).map((f) => f.id);
      while (queue.length > 0) {
        const id = queue.shift()!;
        for (const r of this.model.relationshipsFrom(id)) {
          if (r.eClass !== 'Redefinition') continue;
          for (const t of r.target ?? []) {
            if (set.has(t)) continue;
            set.add(t);
            queue.push(t);
          }
        }
      }
      out = set;
      this.redefined.set(contextId, out);
    }
    return out;
  }

  /**
   * The feature a dotted chain ends at, walked as every scope walks it — its
   * head among the first of `contexts` that has it, each later link among the
   * features of the declared type of the one before — with the usage whose
   * type held the last link and that type. `clean` is false when a usage on
   * the way has a feature that stands for the next link (`q : Q { :>> p {…} }`
   * read as `q.p…`): the walk reads the type's link, which is then not the
   * one the usage has. `undefined` when the chain does not resolve.
   */
  chain(
    contexts: readonly ElementId[],
    path: string,
  ): { feature: ElementRecord; usage?: ElementRecord; via?: ElementId; clean: boolean } | undefined {
    const [head, ...rest] = path.split('.');
    let feature: ElementRecord | undefined;
    for (const c of contexts) {
      feature = this.byName(c).get(head!);
      if (feature) break;
    }
    let usage: ElementRecord | undefined;
    let via: ElementId | undefined;
    let clean = true;
    for (const segment of rest) {
      if (!feature) return undefined;
      let next: ElementRecord | undefined;
      for (const type of this.model.typesOf(feature.id)) {
        next = this.byName(type.id).get(segment);
        if (next) {
          via = type.id;
          break;
        }
      }
      if (!next) return undefined;
      if (!this.linkReads(feature, next)) clean = false;
      usage = feature;
      feature = next;
    }
    return feature ? { feature, ...(usage ? { usage } : {}), ...(via !== undefined ? { via } : {}), clean } : undefined;
  }

  /**
   * Does `usage` read, under `feature`'s name, the feature its type declares —
   * no feature of its own standing for it, by name or by an unnamed `:>>`? A
   * chain through it then reads what the type says; where not, the type's
   * feature is not the one the usage has.
   */
  linkReads(usage: ElementRecord, feature: ElementRecord): boolean {
    const name = feature.declaredName;
    return name !== undefined && this.byName(usage.id).get(name) === feature && !this.redefinedIn(usage.id).has(feature.id);
  }

  /**
   * Is `feature`'s value — its stated value expression, a calculation's
   * body, or the definition the asserted equations in `site` give it — the
   * same read in `contextId` as where it is written?
   *
   * Every evaluator reads such a value where it is WRITTEN, over the names
   * there: P's `calc margin { 10.0 - load }` is P's arithmetic over P's
   * `load`. Read in a context that inherits it (`part p : P`, `part def S :>
   * P`), or through a chain (`p.margin`), that is the value the context has
   * exactly when the context changes nothing it reads — no feature of the
   * context redefines one, by name or by an unnamed `:>>`, transitively
   * through the values and definitions those names have. Where one does
   * (`:>> load = 50.0` makes margin −40, read as 5), the value is not read
   * there: no surface reads it, as no surface reads a value nothing states.
   * A name the body reads that is no feature of where it is written, and a
   * valueless input a binding holds, are not followed: answered as changed.
   */
  sameIn(contextId: ElementId, feature: ElementRecord, site?: ElementId): boolean {
    const key = `${contextId} ${feature.id} ${site ?? ''}`;
    const hit = this.same.get(key);
    if (hit !== undefined) return hit;
    const here = this.byName(contextId);
    const redefined = this.redefinedIn(contextId);
    const seen = new Set<ElementId>();
    const stable = (f: ElementRecord, sites: readonly ElementId[]): boolean => {
      if (seen.has(f.id)) return true;
      seen.add(f.id);
      if (redefined.has(f.id)) return false;
      const reads = this.readsOf(f, sites);
      if (reads === undefined) return false;
      for (const { owner, names } of reads) {
        const there = this.byName(owner);
        for (const name of names) {
          const head = name.split('.')[0]!;
          const g = there.get(head);
          if (g === undefined || here.get(head) !== g || !stable(g, [owner])) return false;
        }
      }
      return true;
    };
    const answer =
      (feature.declaredName === undefined || here.get(feature.declaredName) === feature) &&
      stable(feature, site !== undefined ? [site] : []);
    this.same.set(key, answer);
    return answer;
  }

  /**
   * Where the asserted equations that define the valueless feature a bare
   * `name` denotes in `contextId` are read, when none in `contextId` may: the
   * feature's owner, when `contextId` INHERITS the feature and its definition
   * (`part def S :> P`, over P's `assert constraint { e == a * b }`) and
   * changes nothing the definition reads ({@link sameIn}). `undefined`
   * otherwise — and then no surface reads a value for the name there.
   */
  inheritedSite(contextId: ElementId, name: string): ElementId | undefined {
    if (this.of(contextId, name).length > 0) return undefined;
    const feature = this.feature(contextId, name);
    const owner = feature?.ownerId;
    if (!feature || owner == null || owner === contextId || this.of(owner, name).length === 0) return undefined;
    return this.sameIn(contextId, feature, owner) ? owner : undefined;
  }

  /**
   * The valueless feature a dotted chain read in `contexts` ends at, and where
   * the asserted equations that define it are read — the type the chain found
   * it in, else its owner — when the chain reads it as its type declares it
   * ({@link chain}) and the usage it is read through changes nothing the
   * definition reads ({@link sameIn}): `p.e`, over `part p : P` and P's `e ==
   * a * b`, is P's e. `undefined` otherwise.
   */
  chainSite(contexts: readonly ElementId[], path: string): { feature: ElementRecord; site: ElementId } | undefined {
    if (!path.includes('.')) return undefined;
    const end = this.chain(contexts, path);
    if (!end || !end.clean || !end.usage) return undefined;
    const { feature } = end;
    const name = feature.declaredName;
    if (!name || hasStatedValue(this.model, feature)) return undefined;
    const site = [end.via, feature.ownerId].find((c): c is ElementId => c != null && this.of(c, name).length > 0);
    if (site === undefined) return undefined;
    return this.sameIn(end.usage.id, feature, site) ? { feature, site } : undefined;
  }

  /** {@link statedValueOf}, once per feature — and the names a string value reads, once. */
  statedValue(f: ElementRecord): AttrValue | undefined {
    return this.statedOf(f).value;
  }

  private statedOf(f: ElementRecord): { value: AttrValue | undefined; names?: string[] } {
    let hit = this.stated.get(f.id);
    if (!hit) {
      hit = { value: statedValueOf(this.model, f) };
      this.stated.set(f.id, hit);
    }
    return hit;
  }

  /**
   * The names `f`'s value is read from, with the context each is read in: its
   * stated value's (in its owner), or its asserted definitions' in `sites`
   * and in its owner. `undefined` for a valueless feature a binding holds.
   */
  private readsOf(f: ElementRecord, sites: readonly ElementId[]): Array<{ owner: ElementId; names: string[] }> | undefined {
    const stated = this.statedOf(f);
    if (stated.value !== undefined) {
      if (typeof stated.value !== 'string' || f.ownerId == null) return [];
      stated.names ??= namesOfValue(stated.value);
      return [{ owner: f.ownerId, names: stated.names }];
    }
    const name = f.declaredName;
    if (!name) return [];
    const out: Array<{ owner: ElementId; names: string[] }> = [];
    for (const site of new Set([...sites, ...(f.ownerId != null ? [f.ownerId] : [])])) {
      for (const eq of this.of(site, name)) out.push({ owner: site, names: refsIn(eq.definition, eq.literals) });
    }
    return out.length === 0 && this.boundFeatures().has(f.id) ? undefined : out;
  }

  /**
   * Every feature a binding connector touches — the test `isBindingEdge` of
   * ./connectors makes, written here because that module reads the unit-aware
   * evaluator, which reads this one.
   */
  private boundFeatures(): ReadonlySet<ElementId> {
    if (!this.bound) {
      const out = new Set<ElementId>();
      for (const el of this.model.all()) {
        const kind = el.attrs.connectorKind ?? el.attrs.kind;
        const binding =
          el.eClass === 'BindingConnectorAsUsage' ||
          el.eClass === 'BindingConnector' ||
          el.attrs.bind === true ||
          kind === 'bind' ||
          kind === 'equals' ||
          kind === 'equality';
        if (!binding) continue;
        for (const id of [...(el.source ?? []), ...(el.target ?? [])]) out.add(id);
      }
      this.bound = out;
    }
    return this.bound;
  }
}

/** The names a value expression reads, a `[unit]` literal's marker excluded — `[]` for one that does not parse. */
function namesOfValue(text: string): string[] {
  const s = text.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) return [];
  const body = parseRelationBody(s);
  return body ? refsIn(body.node, body.literals) : [];
}

/** The names a node reads, a `[unit]` literal's marker excluded. */
function refsIn(node: ExprNode, literals: MarkerDimensions): string[] {
  const out: string[] = [];
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'ref': {
        const path = n.path.join('.');
        if (!literals.has(path)) out.push(path);
        return;
      }
      case 'unary':
        walk(n.operand);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'if':
        walk(n.cond);
        walk(n.then);
        walk(n.else);
        return;
      default:
        return;
    }
  };
  walk(node);
  return out;
}

/**
 * Is `el` an `assert constraint` — the one constraint whose equation may
 * DEFINE a value? An assert states a fact about the model; a `require` or
 * `assume` clause, and a plain `constraint` usage, are checks of values the
 * model gives elsewhere. Reading those as definitions too made a brief's test
 * condition, `require constraint { jammedFraction == 0.5 }` on a measure that
 * carries no value by design, report "defines jammedFraction = 0.5" — a value
 * the model never stated — while the budget beside it (`<= 12`) read "has no
 * value anywhere". The verification lane already files the roles this way
 * (`assert` an axiom, `require` an obligation: `roleOf` in obligations.ts),
 * so the literal reading now agrees with it. The mapper records the clause
 * keyword on `attrs.requirementRole`, wherever the clause is written.
 */
export function isAsserted(el: ElementRecord): boolean {
  return el.eClass === 'ConstraintUsage' && el.attrs.requirementRole === 'assert';
}

/**
 * When `constraint` reads `name == <expr>` or `<expr> == name`, the `<expr>`
 * side; else `undefined`. `=` is the same equation in the solver's spelling.
 */
export function definedSide(constraint: ElementRecord, name: string): ExprNode | undefined {
  return definedSideOf(constraint, name)?.node;
}

/** {@link definedSide}, with the `[unit]` literals the side may read. */
export function definedSideOf(
  constraint: ElementRecord,
  name: string,
): { node: ExprNode; literals: MarkerDimensions } | undefined {
  const eq = equationOf(constraint);
  if (!eq) return undefined;
  const { node, literals } = eq;
  if (bareName(node.left, literals) === name) return { node: node.right, literals };
  if (bareName(node.right, literals) === name) return { node: node.left, literals };
  return undefined;
}

/** The bare names either side of the equation `constraint` states is — the names it may define. */
export function namesDefinedBy(constraint: ElementRecord): string[] {
  const eq = equationOf(constraint);
  if (!eq) return [];
  const names = [bareName(eq.node.left, eq.literals), bareName(eq.node.right, eq.literals)].filter(
    (n): n is string => n !== undefined,
  );
  return [...new Set(names)];
}

/**
 * The equation `constraint` states, parsed as every relation body is parsed
 * ({@link parseRelationBody}) — `undefined` for anything else.
 *
 * A `[unit]` literal is part of the equation, not a reason it is none.
 * `assert constraint { e == 640.0 [Wh] / power }` was no definition to the
 * validation surface — the scalar grammar rejects `[` — while the solver lane
 * solved it and the SMT engine took it as an axiom: `e` had no value on one
 * surface and 3544.6 s, proved against bare literals, on the other two. A
 * literal whose unit could not be lowered (an unknown unit, an offset scale)
 * leaves the body no equation at all: what it would define is unknown.
 */
function equationOf(
  constraint: ElementRecord,
): { node: Extract<ExprNode, { kind: 'binary' }>; literals: MarkerDimensions } | undefined {
  const expr = constraint.attrs.expression;
  if (typeof expr !== 'string') return undefined;
  const body = parseRelationBody(expr);
  if (!body || (body.hadUnit && !body.resolved)) return undefined;
  const node = body.node;
  if (node.kind !== 'binary' || (node.op !== '==' && node.op !== '=')) return undefined;
  return { node, literals: body.literals.size > 0 ? body.literals : NO_MARKERS };
}

/** The bare name a side of an equation is, a lowered `[unit]` literal's marker excluded. */
function bareName(n: ExprNode, literals: MarkerDimensions = NO_MARKERS): string | undefined {
  return n.kind === 'ref' && n.path.length === 1 && !literals.has(n.path[0]!) ? n.path[0] : undefined;
}

/**
 * The value a feature STATES: its `attrs.value`, or — for a calculation usage
 * whose body is a value expression (`calc endurance { capacity / power }`)
 * rather than a relation — that body. `undefined` for one that states none.
 *
 * A calculation's body is a value the way a feature value is: the solver lane
 * has always solved it as `endurance = capacity / power` and read relations
 * over `endurance` from that. The validation surface did not read it at all
 * ("endurance has no value anywhere"), and the solver read it unit-blind
 * (0.98, Wh/W) — so `endurance <= 60.0` was satisfied and PROVED on one side
 * and unknown on the other. Every surface now reads it as the value it states,
 * a derivation like any other.
 *
 * NOT a calculation that has a PARAMETER — a feature with a direction (`in y
 * = 100.0`), or any feature its body names, owned or inherited from the `calc
 * def` that types it. Its body is read in its OWNER's scope, where such a name
 * is the owner's feature or nothing: `calc g { in y = 100.0; y }` beside
 * `attribute y = 4.0` read 4, so `g <= 10.0` — false, g is 100 — passed the
 * literal gate. Such a calculation states no value this tool reads, as before
 * calculation bodies were read ({@link isParameterisedCalculation}).
 */
export function statedValueOf(model: Model, el: ElementRecord): AttrValue | undefined {
  const v = el.attrs.value;
  if (v !== undefined && v !== null) return v;
  if (el.eClass !== 'CalculationUsage' || !el.declaredName) return undefined;
  const body = el.attrs.expression;
  if (typeof body !== 'string' || !isValueBody(body)) return undefined;
  return ownsParameter(model, el, body) ? undefined : body;
}

/** Does `f` state a value ({@link statedValueOf})? */
export function hasStatedValue(model: Model, f: ElementRecord): boolean {
  return statedValueOf(model, f) !== undefined;
}

/**
 * Is `f` a calculation whose stated value is its BODY ({@link statedValueOf})?
 *
 * Such a body is read in the calculation's owner, over the owner's names. It
 * is a value there; read where the calculation is INHERITED (`part p : P`,
 * over P's `calc margin { 10.0 - load }`) or through a feature chain
 * (`p.margin`), it is P's arithmetic over P's inputs — the value the reading
 * context has when that context changes nothing it reads, and the wrong one
 * wherever it redefines one (`:>> load = 50.0` makes margin −40, read as 5).
 * Every surface reads it there as it reads an inherited asserted definition:
 * the value it has, or none ({@link readsStatedValueIn}).
 */
export function isCalculationValue(model: Model, f: ElementRecord): boolean {
  if (f.eClass !== 'CalculationUsage') return false;
  if (f.attrs.value !== undefined && f.attrs.value !== null) return false;
  return statedValueOf(model, f) !== undefined;
}

/**
 * Does a scope rooted at `contextId` read `f`'s stated value under a name
 * reached through `prefix` (`''` for a bare name of the context itself)? A
 * stated value, read everywhere — but a calculation's body ({@link
 * isCalculationValue}) by a bare name in the context that owns it, and
 * elsewhere only where the reading context changes nothing the body reads
 * ({@link DefiningEquations.sameIn}): the context itself for a bare name, and
 * for a chain the usage whose type holds the calculation, every link on the
 * way read as the type says (`link.clean`).
 */
export function readsStatedValueIn(
  model: Model,
  f: ElementRecord,
  contextId: ElementId,
  prefix: string,
  definitions: DefiningEquations,
  link?: { usage: ElementRecord; clean: boolean },
): boolean {
  if (f.attrs.value !== undefined && f.attrs.value !== null) return true;
  if (f.eClass !== 'CalculationUsage' || definitions.statedValue(f) === undefined) return false;
  if (prefix === '') return f.ownerId === contextId || definitions.sameIn(contextId, f);
  return link !== undefined && link.clean && definitions.sameIn(link.usage.id, f);
}

/**
 * Does calculation `el` have a parameter — a directed feature, or any feature
 * its `body` names — among its EFFECTIVE features? A calculation typed by a
 * `calc def` owns none of the definition's parameters and has every one of
 * them: `calc t : Scale { x * 5.0 }` reads Scale's `in x`, not the `x` of the
 * part it is written in.
 */
function ownsParameter(model: Model, el: ElementRecord, body: string): boolean {
  const features = effectiveFeatures(model, el.id);
  if (features.length === 0) return false;
  const parsed = parseRelationBody(body);
  const read = new Set<string>();
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'ref':
        if (n.path[0] !== undefined) read.add(n.path[0]);
        return;
      case 'unary':
        walk(n.operand);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'if':
        walk(n.cond);
        walk(n.then);
        walk(n.else);
        return;
      default:
        return;
    }
  };
  if (parsed) walk(parsed.node);
  return features.some((c) => {
    const direction = c.attrs.direction;
    if (direction === 'in' || direction === 'out' || direction === 'inout') return true;
    return c.declaredName !== undefined && read.has(c.declaredName);
  });
}

/**
 * Is `el` a calculation whose body is a value expression that it states no
 * value by — one with a parameter ({@link statedValueOf})? Its body is the
 * value of a CALL, over arguments, and read in the owner's scope it is a value
 * nothing in the model states: no surface reads it, and the verification lane
 * asserts no axiom from it.
 */
export function isParameterisedCalculation(model: Model, el: ElementRecord): boolean {
  if (el.eClass !== 'CalculationUsage' || !el.declaredName) return false;
  if (el.attrs.value !== undefined && el.attrs.value !== null) return false;
  const body = el.attrs.expression;
  return typeof body === 'string' && isValueBody(body) && ownsParameter(model, el, body);
}

/** A calculation body that is a value — arithmetic or a name — rather than a relation or a test. */
function isValueBody(body: string): boolean {
  if (body.trim() === '') return false;
  const parsed = parseRelationBody(body);
  if (!parsed || (parsed.hadUnit && !parsed.resolved)) return false;
  const node = parsed.node;
  if (node.kind === 'binary') return ['+', '-', '*', '/', '%', '^'].includes(node.op);
  if (node.kind === 'unary') return node.op !== 'not';
  return node.kind === 'num' || node.kind === 'ref' || node.kind === 'if';
}

/* ─────────────────────── Which equation defines, mid-derivation ─────────────────────── */

/**
 * The derivation stack of one evaluation, in the order it was entered: each
 * feature being derived, and the asserted equation it is being derived through
 * — `undefined` for a feature's own value expression.
 */
export type InFlight = Map<ElementId, ElementId | undefined>;

/**
 * How an answer met the derivation stack: the features in flight it came back
 * to — through a loop, or only by reading an equation back ({@link returnTo})
 * — and whether the depth guard answered somewhere under it. An answer with a
 * contact depends on what else was being derived at the time, so neither
 * evaluator memoises it; one without is a fact about the model, the same
 * whichever check asked first.
 */
export interface Contact {
  loops: ReadonlySet<ElementId>;
  echoes: ReadonlySet<ElementId>;
  guard: boolean;
}

const NONE: ReadonlySet<ElementId> = new Set();

/** The contact of a depth limit answering: the guard at the cap, or the engine's own stack running out. */
export const GUARD_CONTACT: Contact = { loops: NONE, echoes: NONE, guard: true };

/**
 * What reading `id` again while it is in flight is. An ECHO when the reader —
 * the derivation on top of the stack — is another feature derived through the
 * same equation: `e2 == e` read as `e`'s definition (through `e2`) and then as
 * `e2`'s (through `e`) is one equation read back, not a loop the author wrote.
 * Any other return is a LOOP: `a == b * 2.0` beside `b == a / 2.0`, or
 * `x == x + 1`.
 */
export function returnTo(inFlight: InFlight, id: ElementId): Contact {
  const via = inFlight.get(id);
  let reader: [ElementId, ElementId | undefined] | undefined;
  for (const entry of inFlight) reader = entry;
  const echo = via !== undefined && reader !== undefined && reader[0] !== id && reader[1] === via;
  return echo ? { loops: NONE, echoes: new Set([id]), guard: false } : { loops: new Set([id]), echoes: NONE, guard: false };
}

/** Both contacts, as one. */
export function mergeContact(a: Contact | undefined, b: Contact | undefined): Contact | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    loops: a.loops.size === 0 ? b.loops : b.loops.size === 0 ? a.loops : new Set([...a.loops, ...b.loops]),
    echoes: a.echoes.size === 0 ? b.echoes : b.echoes.size === 0 ? a.echoes : new Set([...a.echoes, ...b.echoes]),
    guard: a.guard || b.guard,
  };
}

/** How many of the features in flight are being derived through a defining equation. */
export function definitionsInFlight(inFlight: InFlight): number {
  let n = 0;
  for (const via of inFlight.values()) if (via !== undefined) n++;
  return n;
}

/**
 * How many defining equations one derivation may read through, nested, before
 * it answers `depth` instead — on both paths, the scalar one and the
 * unit-aware one, so past it neither has a value the other lacks. It is a fact
 * about the model, so the answer does not depend on which derivations an
 * earlier check left in the memo. Measured, uncapped: a chain of asserted
 * equations `x_i == x_{i-1} + 1.0` derived to 801 at 800 links and overflowed
 * the stack at 900 (a cold `tsx` process, node 22, default stack); the scalar
 * scope, which catches the overflow, gave a value at 1400 links and nothing at
 * 1200 in one warm process. The drone-swarm v9 model's equations nest two deep
 * at most. The cap is far from both. A candidate past it ends the search for a
 * definition ({@link chooseDefinition}).
 */
export const MAX_DERIVATION_DEPTH = 64;

/** What one candidate's derivation came to, as {@link chooseDefinition} reads it. */
export interface CandidateOutcome {
  /** True when it gave the feature a value. */
  answered: boolean;
  /** True when it has none because its definitions nest past {@link MAX_DERIVATION_DEPTH}. */
  deep: boolean;
  /** Everything it met of the derivation stack: the answer depends on all of it. */
  contact?: Contact;
  /**
   * What its LACK of a value met: the contact of the inputs that had none.
   * An input that had a value, through a candidate of its own passed over for
   * coming back, is no part of why this one has none.
   */
  cause?: Contact;
}

/**
 * THE choice among the equations that may define `featureId` (in the order
 * of {@link definingEquationsFor}), for both evaluators: the first whose
 * derivation gives the feature a value — tried with `featureId` in flight,
 * through the candidate, while `derive` runs. One that gives none is passed
 * over for the next: an equation that would read the feature back into its own
 * derivation, and one with an input nothing fixes, alike.
 *
 * Stopping at the first that FAILED for a reason of its own made the value
 * turn on declaration order once more: `b == c + 0.0` (with `c` unfixed)
 * written above `b == x0 * 2.0` left `b` with no value, and swapped b = 2. So
 * did the reach of a failure: a candidate whose input `d` had a value only by
 * passing over an equation that read the feature back was itself "a loop",
 * and skipped — so swapping `d`'s two equations, neither of them the
 * feature's, decided whether `a == d + b` (with `b` unfixed) or `d == a`
 * defined `a`. Every candidate that answers now answers the same in a model
 * whose equations agree, so which one comes first decides nothing there; in
 * one at odds with itself, the first in the order above decides.
 *
 * One failure does end the search: a candidate whose definitions nest past
 * {@link MAX_DERIVATION_DEPTH} is the answer, refused for it. The cap is met
 * at a count of definitions in flight, so whether a candidate meets it turns
 * on how deep the derivation already is, and on which links an earlier check
 * left in the memo (they are read whole there, not re-derived to the cap):
 * passing it over made the next candidate's value the answer in one order of
 * checks and not in the other. And every link of a chain past the cap would
 * re-derive the link below once for each of its own candidates — a 150-link
 * chain whose links each read the one below through two definitions, and the
 * one above through a third, did not finish in five minutes.
 *
 * When none gives a value, the first that failed for a reason of its own —
 * its `cause` comes back to no feature in flight — is the answer, and its
 * reason is; when every one came back, the first that LOOPED is, and its own
 * derivation names the loop; when all of them only read an equation back, the
 * name has no definition here (`chosen` absent). `contact` is what every
 * candidate tried met, and `cause` — when none answered — what their failures
 * met: the answer depends on them.
 */
export function chooseDefinition<T>(
  inFlight: InFlight,
  featureId: ElementId,
  candidates: readonly DefiningEquation[],
  derive: (c: DefiningEquation) => T,
  outcome: (t: T) => CandidateOutcome,
): { chosen?: T; contact?: Contact; cause?: Contact } {
  let contact: Contact | undefined;
  let cause: Contact | undefined;
  let own: T | undefined;
  let looped: T | undefined;
  try {
    for (const c of candidates) {
      inFlight.set(featureId, c.constraint.id);
      const t = derive(c);
      const o = outcome(t);
      contact = mergeContact(contact, o.contact);
      if (o.answered) return { chosen: t, ...(contact ? { contact } : {}) };
      cause = mergeContact(cause, o.cause);
      if (o.deep) return { chosen: t, ...(contact ? { contact } : {}), ...(cause ? { cause } : {}) };
      const back = o.cause ? cameBack(o.cause, inFlight) : undefined;
      if (back === undefined) own ??= t;
      else if (back === 'loop') looped ??= t;
    }
  } finally {
    inFlight.delete(featureId);
  }
  const chosen = own ?? looped;
  return { ...(chosen !== undefined ? { chosen } : {}), ...(contact ? { contact } : {}), ...(cause ? { cause } : {}) };
}

/** Whether `contact` comes back to a feature still in flight: through a loop, else only by an echo. */
function cameBack(contact: Contact, inFlight: InFlight): 'loop' | 'echo' | undefined {
  for (const id of contact.loops) if (inFlight.has(id)) return 'loop';
  for (const id of contact.echoes) if (inFlight.has(id)) return 'echo';
  return undefined;
}

/** The memo key of the derivation an equation in `contextId` gives a feature — never a bare element id. */
export function definitionKey(featureId: ElementId, contextId: ElementId): string {
  return `${featureId} defined in ${contextId}`;
}
