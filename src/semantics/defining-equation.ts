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
 *
 * It is also where every scope reads NAMES ({@link DefiningEquations.scope}):
 * the one walk the scalar, the quantity and the variable scope share, which
 * ./relations cannot host (it reads the unit-aware evaluator, which reads this
 * module) — and with it what a name's VALUE is in a context: what each name
 * denotes ({@link DefiningEquations.denote}), the feature a redefinition that
 * states nothing reads ({@link DefiningEquations.carrier}), whether a value
 * written elsewhere is the same there ({@link DefiningEquations.sameIn}), the
 * binding a redefinition contradicts ({@link contradictedBindingOf}), two
 * values a context inherits under one name ({@link DefiningEquations.clash}),
 * the contexts a requirement's subject is bound in ({@link
 * DefiningEquations.satisfaction}), and the names a body declares itself
 * ({@link shadowedNamesOf}).
 */

import { type AttrValue, type ElementId, type ElementRecord, type Model, isDefinition, isUsage } from '@core/index';
import {
  effectiveFeatures,
  effectiveNameOf,
  effectiveQualifiedName,
  generalizationsOf,
  inheritedNameClashes,
  maskedByName,
  ownFeatures,
  redefinedClosure,
} from './inheritance';
import { type ExprNode } from './expr';
import { isKindOf } from './metaclasses';
import { decimalRational, scaleRational, type Rational } from './smt/encode';
import { NO_MARKERS, parseRelationBody, type MarkerDimensions } from './unit-literals';
import { DIMENSIONLESS, dimEqual, divideDim, multiplyDim, resolveUnit, type Dimension } from './units';

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

const SHADOWED = new WeakMap<DefiningEquation, readonly string[]>();

/**
 * The names an equation reads that its constraint declares itself while its
 * owner's scope resolves them to another feature ({@link shadowedNamesOf}) —
 * `[]` for nearly every one. Such an equation is a REFUSED definition: the
 * feature it defines reads no value on any surface, and is no design freedom
 * either. Asked where a definition is READ, never while the equations are
 * gathered: the test reads the owner's scope, whose walk reads the equations.
 */
export function shadowedEquation(model: Model, eq: DefiningEquation): readonly string[] {
  let hit = SHADOWED.get(eq);
  if (!hit) {
    const whole = equationOf(eq.constraint);
    hit = whole ? shadowedNamesOf(model, eq.constraint, refsIn(whole.node, whole.literals)) : [];
    SHADOWED.set(eq, hit);
  }
  return hit;
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
 * How a scope admits a name: `value` — the scopes that read VALUES (the
 * scalar scope of ./evaluate-model, the quantity scope of ./units-eval) map a
 * name to the feature whose value it reads, read where the context the name
 * is read in needs it read ({@link DefiningEquations.valueRef}), and a name
 * with no value to read to nothing; `all` — the scope that names VARIABLES
 * (`idScopeFor` of ./relations: the gates, the solver's names, the
 * verification lane's symbols) maps every named feature. Which feature a name
 * DENOTES is the same in both: one walk ({@link DefiningEquations.scope}).
 */
export type ScopeAdmission = 'value' | 'all';

const BEHAVIOUR = new Map<string, boolean>();

/**
 * Is `f` a feature whose own features are a BODY's — a behaviour's — and never
 * a bare name of the scope that encloses it ({@link DefiningEquations.scope})?
 * Every kind of action usage: a constraint's or a requirement's parameters and
 * locals, a calculation's or a case's, and an action's, a state's, a
 * transition's, a performed action's — `perform action deliver : Deliver { in
 * payload = 5.0; }` answered the bare `payload` of the part around it, so
 * `payload <= maxPayload` was refuted at a parameter's 5.
 */
function ownsBody(f: ElementRecord): boolean {
  let hit = BEHAVIOUR.get(f.eClass);
  if (hit === undefined) {
    hit = isKindOf(f.eClass, 'ActionUsage');
    BEHAVIOUR.set(f.eClass, hit);
  }
  return hit;
}

/**
 * Is `f` a DIRECTED feature — a parameter, `in`, `out` or `inout`? Its value is
 * what a call, a port's connection or a flow puts there, never a bare name of
 * the scope around its owner: `port pwr { in attribute voltage = 12.0; }` made
 * `voltage <= 5.0` of the part refuted at 12.
 */
function isDirected(f: ElementRecord): boolean {
  const direction = f.attrs.direction;
  return direction === 'in' || direction === 'out' || direction === 'inout';
}

/**
 * What a name denotes in a scope ({@link DefiningEquations.denote}): the
 * feature, the context it is read in — the scope's root for a direct name,
 * else the usage on the chain whose effective feature it is — and whether it
 * lies below a calculation with a parameter.
 *
 * `instance` is WHICH instance of the reader the name is read in: the path of
 * usages from the scope's root, spelled as a qualified name (`R::q1::p` for
 * `q1.p.load` read in R, where `p` is Q's part and the reader `Q::p` itself).
 * Two usages of one type are two instances, whose features are each their own
 * value ({@link DefiningEquations.symbolOf}). A requirement's subject that
 * nothing binds, read where the requirement is the scope's root, is the
 * GENERIC instance of its type — the requirement is about any one — and a
 * subject something binds is the instance it is bound to, `satisfy R by
 * q1.p` q1's p.
 *
 * `enclosing` is every instance the walk passed through on the way to
 * `instance`, outermost first — the scope's root included — each with the
 * context its features are read in: `R` (read in R) and `R::s` (read in `s`)
 * for `s.q.load` read in R over `part s : Sys`. Each is an instance of its
 * own types, whose asserts and bindings constrain what lies below it (Sys's
 * `bind p.load = q.load` is a fact of `R::s::q`'s load as much as P's own
 * asserts are).
 */
export interface Denotation {
  feature: ElementRecord;
  reader: ElementId;
  inCall: boolean;
  instance: string;
  enclosing: readonly InstanceFrame[];
}

/** One instance a walk is in ({@link Denotation}): its path, and the context its features are read in. */
export interface InstanceFrame {
  instance: string;
  reader: ElementId;
}

/**
 * Where a name's VALUE is read ({@link DefiningEquations.valueRef}): the
 * feature whose value it is, and — when that value reads something the
 * reading context changes — the context it is read IN, rather than where it
 * is written.
 */
export interface ValueRef {
  target: ElementRecord;
  at?: ElementId;
}

/**
 * A name read through an instance of its own ({@link
 * DefiningEquations.instanceReadings}): its symbol, the instance (`R::p`),
 * the context the walk read it in, the feature whose value it reads, and
 * where that value is read when not where it is written.
 */
export interface InstanceReading {
  symbol: string;
  instance: string;
  reader: ElementId;
  /** The instances that enclose `instance` on the walk ({@link Denotation}), re-rooted as `instance` is. */
  enclosing: readonly InstanceFrame[];
  /** The feature the variable scope maps the path to ({@link DefiningEquations.carrier}). */
  feature: ElementRecord;
  target: ElementRecord;
  at?: ElementId;
}

/**
 * The defining equations one evaluation pass reads, gathered once per context
 * — with the valueless feature of each name an equation there may define — so
 * a long chain does not re-parse every constraint of its context at every
 * link; and the NAMES every scope reads, walked once per context
 * ({@link scope}). It reads the model as it is at one revision: a pass takes
 * it from {@link sharedDefinitions}, which hands out a fresh one whenever the
 * model has moved on.
 */
export class DefiningEquations {
  /** The model revision this reading is of. */
  readonly rev: number;
  private readonly equations = new Map<ElementId, Map<string, DefiningEquation[]>>();
  private readonly valueless = new Map<ElementId, Map<string, ElementRecord>>();
  private readonly named = new Map<ElementId, Map<string, ElementRecord>>();
  private readonly same = new Map<string, boolean>();
  private readonly stated = new Map<ElementId, { value: AttrValue | undefined; names?: string[] }>();
  private readonly effective = new Map<ElementId, ElementRecord[]>();
  private readonly names = new Map<ElementId, string | undefined>();
  private readonly aliases = new Map<ElementId, string[]>();
  private readonly scopes = new Map<string, Map<string, ElementId>>();
  private readonly readers = new Map<ElementId, Map<string, ElementId>>();
  private readonly qualified = new Map<ElementId, string>();
  private redefining?: ReadonlySet<ElementId>;
  private readonly pinned = new Map<string, boolean>();
  private readonly pinning = new Set<string>();
  private readonly denoted = new Map<ElementId, Map<string, Denotation>>();
  private readonly carrying = new Map<string, ElementRecord>();
  private readonly carried = new Map<string, ElementRecord>();
  private readonly contradicted = new Map<ElementId, BindingConflict | null>();
  private readonly clashes = new Map<ElementId, Map<string, NameClash>>();
  private reportedClashes?: ReadonlyArray<{ context: ElementRecord; name: string; clash: NameClash }>;
  /** The {@link sameIn} questions being asked, and whether one was answered by a guess meanwhile. */
  private readonly asking = new Set<string>();
  private guessed = false;
  private bound?: ReadonlySet<ElementId>;
  private specialised?: Map<ElementId, ElementRecord[]>;
  private satisfying?: Map<ElementId, { requirement: ElementRecord; satisfier: ElementRecord }>;
  private readonly clauseContexts = new Map<ElementId, ElementRecord[]>();
  /** {@link changingContexts} per relation and names, with those a feature-only binding reading lists too. */
  private readonly changing = new Map<string, { listed: ElementRecord[]; plain: ReadonlySet<ElementId> }>();

  constructor(readonly model: Model) {
    this.rev = model.rev;
  }

  /** {@link definingEquationsFor}. */
  of(contextId: ElementId, name: string): readonly DefiningEquation[] {
    let byName = this.equations.get(contextId);
    if (!byName) {
      byName = equationsByName(this.model, contextId);
      this.equations.set(contextId, byName);
    }
    return byName.get(name) ?? [];
  }

  /** {@link effectiveFeatures}, once per context. */
  features(contextId: ElementId): readonly ElementRecord[] {
    let hit = this.effective.get(contextId);
    if (!hit) {
      // A `satisfy R by x` is a context with R's features ({@link satisfaction}).
      const satisfied = this.satisfaction(contextId);
      hit = effectiveFeatures(this.model, satisfied ? satisfied.requirement.id : contextId);
      this.effective.set(contextId, hit);
    }
    return hit;
  }

  /**
   * What a `satisfy R by x` relationship states, read as a CONTEXT: a usage of
   * R whose subject is x — KerML's SatisfyRequirementUsage. `undefined` for
   * any other element, and for a satisfier that does not conform to the type
   * of R's subject (it is no instance of what R constrains). R's clauses are
   * read there with the subject standing for x ({@link subjectOf}), so `s.load
   * <= 10.0` in `requirement def R { subject s : P; }` is read at `p`'s load,
   * not P's: proved at P's values while p — `:>> load = 50.0` over a
   * `default` — breaks it was a false proof.
   */
  satisfaction(contextId: ElementId): { requirement: ElementRecord; satisfier: ElementRecord } | undefined {
    if (!this.satisfying) {
      const out = new Map<ElementId, { requirement: ElementRecord; satisfier: ElementRecord }>();
      for (const rel of this.model.ofKind('Satisfy')) {
        if (rel.attrs.isLibrary === true) continue;
        const requirement = rel.target?.[0] !== undefined ? this.model.get(rel.target[0]) : undefined;
        const satisfier = rel.source?.[0] !== undefined ? this.model.get(rel.source[0]) : undefined;
        if (!requirement || !satisfier) continue;
        const subject = effectiveFeatures(this.model, requirement.id).find((f) => f.attrs.requirementRole === 'subject');
        const type = subject ? this.model.typesOf(subject.id)[0] : undefined;
        if (!type) continue;
        const conforms =
          satisfier.id === type.id || generalizationsOf(this.model, satisfier.id).some((g) => g.id === type.id);
        if (conforms) out.set(rel.id, { requirement, satisfier });
      }
      this.satisfying = out;
    }
    return this.satisfying.get(contextId);
  }

  /**
   * The feature a SUBJECT stands for, where something binds it: in a
   * `satisfy R by x` context ({@link satisfaction}), x; and where the subject
   * is bound by value — `requirement r : R { subject s = p; }`, `subject s : P
   * = p` — the feature `p` names, resolved outward from where the subject is
   * written. A chain through the subject reads through that feature, as SysML
   * reads it: `s.m2` IS `p.m2`, never P's own. `undefined` for any other
   * feature, and for a subject bound to nothing this walk resolves.
   */
  subjectOf(contextId: ElementId, f: ElementRecord): ElementRecord | undefined {
    return this.subjectScope(contextId, f)?.feature;
  }

  /**
   * {@link subjectOf}, with WHERE the value it stands for was resolved: the
   * `scope` — the first namespace outward from where the value is written in
   * which its `path` resolves (`s` in `part p : P { ref part :>> r = s; }`
   * written in Q is Q's `s`, resolved in Q) — or no scope for a `satisfy R by
   * x`'s subject, whose satisfier is no name resolved anywhere. The coverage
   * guard re-resolves `path` in the instance that plays `scope`'s part
   * ({@link instanceReadsOtherwise}): this walk resolves it once, in the type.
   */
  subjectScope(
    contextId: ElementId,
    f: ElementRecord,
  ): { feature: ElementRecord; scope?: ElementId; path?: string } | undefined {
    const subject = f.attrs.requirementRole === 'subject';
    // A REFERENCE feature (`ref part :>> r = r1`) stands for the feature its
    // value names, exactly as a bound subject does: every chain through it
    // reads the referenced feature, so `q.r.L` is r1's 50, not R's own 1.
    if (!subject && f.attrs.isRef !== true) return undefined;
    if (subject) {
      const satisfied = this.satisfaction(contextId);
      if (satisfied) return { feature: satisfied.satisfier };
    }
    const v = f.attrs.value;
    if (typeof v !== 'string') return undefined;
    const path = v.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) return undefined;
    const seen = new Set<ElementId>();
    for (let cur = f.ownerId; cur != null && !seen.has(cur); cur = this.model.get(cur)?.ownerId ?? null) {
      seen.add(cur);
      const end = this.chain([cur], path)?.feature;
      if (end && end !== f) return { feature: end, scope: cur, path };
    }
    return undefined;
  }

  /**
   * The name every scope reads `f` by — {@link effectiveNameOf}: its declared
   * name, else the name of what an unnamed redefinition (`attribute :>> load
   * = 50.0`) redefines. The one name hook of the walk, of the shadowing test
   * ({@link shadowedNamesOf}) and of every value path.
   */
  nameOf(f: ElementRecord): string | undefined {
    if (f.declaredName !== undefined) return f.declaredName;
    if (!this.names.has(f.id)) this.names.set(f.id, effectiveNameOf(this.model, f));
    return this.names.get(f.id);
  }

  /** {@link effectiveQualifiedName}, once per element. */
  qualifiedNameOf(id: ElementId): string {
    let hit = this.qualified.get(id);
    if (hit === undefined) {
      hit = effectiveQualifiedName(this.model, id);
      this.qualified.set(id, hit);
    }
    return hit;
  }

  /**
   * The instance a scope rooted at `contextId` reads its own features in
   * ({@link Denotation}): the context's effective qualified name — and for a
   * `satisfy R by x` ({@link satisfaction}), the usage of R it is, named for
   * its satisfier: `P::p1::«satisfy R»`. Every Satisfy is named `«Satisfy»`
   * in its package, so two of them read R's own features — a constraint's
   * local `attribute k` — as ONE symbol, and two satisfiers each pinned to
   * its own k made the model's values "inconsistent".
   */
  instanceNameOf(contextId: ElementId): string {
    const satisfied = this.satisfaction(contextId);
    if (!satisfied) return this.qualifiedNameOf(contextId);
    const requirement = this.nameOf(satisfied.requirement) ?? this.qualifiedNameOf(satisfied.requirement.id);
    return `${this.qualifiedNameOf(satisfied.satisfier.id)}::«satisfy ${requirement}»`;
  }

  /**
   * The other names a RENAMED redefinition answers to — `attribute heavy
   * redefines load` is `load` too, as the feature it redefines is not
   * inherited beside it — or `[]`.
   */
  aliasesOf(f: ElementRecord): readonly string[] {
    let hit = this.aliases.get(f.id);
    if (!hit) {
      const own = this.nameOf(f);
      hit = [];
      for (const g of redefinedClosure(this.model, f)) {
        const n = this.nameOf(g);
        if (n !== undefined && n !== own && !hit.includes(n)) hit.push(n);
      }
      this.aliases.set(f.id, hit);
    }
    return hit;
  }

  /** The first of `contextId`'s effective features named `name` that states no value. */
  feature(contextId: ElementId, name: string): ElementRecord | undefined {
    let byName = this.valueless.get(contextId);
    if (!byName) {
      byName = new Map();
      for (const f of this.features(contextId)) {
        const n = this.nameOf(f);
        if (n && !hasStatedValue(this.model, f) && !byName.has(n)) byName.set(n, f);
      }
      this.valueless.set(contextId, byName);
    }
    return byName.get(name);
  }

  /**
   * `contextId`'s effective features by effective name, first occurrence: the
   * feature a bare name denotes there — a renamed redefinition under the names
   * it redefines too, where nothing else claims them.
   */
  byName(contextId: ElementId): ReadonlyMap<string, ElementRecord> {
    let byName = this.named.get(contextId);
    if (!byName) {
      byName = new Map();
      const features = this.features(contextId);
      for (const f of features) {
        const n = this.nameOf(f);
        if (n && !byName.has(n)) byName.set(n, f);
      }
      for (const f of features) {
        for (const n of this.aliasesOf(f)) if (!byName.has(n)) byName.set(n, f);
      }
      this.named.set(contextId, byName);
    }
    return byName;
  }

  /**
   * The name → feature-id map of a scope rooted at `contextId` — THE walk
   * every scope reads names through, the scalar, the quantity and the
   * variable scope alike: every effective feature of the context under its
   * name, and every feature below it under its dotted chain, the chain
   * descending through each USAGE on the way — its own (re)definitions first,
   * then what its types declare (`q.p.load` in `part q : Q { part :>> p {
   * attribute :>> load = 50.0; } }` is q's p's load, never Q's or P's). A name
   * maps to the feature whose value it reads ({@link carrier}): a redefinition
   * that states nothing reads the one it redefines.
   *
   * THE BARE-NAME RULE. A body reads its context's own features by their bare
   * names, and the walk offers a NESTED feature's bare name as a convenience
   * (`mass` for the subject's `s.mass`). Three rules keep the convenience from
   * ever answering a name with the wrong feature:
   *  - every DIRECT feature of the context claims its bare name, valued or not
   *    — a nested `q.x = 7.0` used to answer `x` where the context's own `x`
   *    states no value, so `x >= 5.0` was refuted at a value of q's;
   *  - a nested bare name is offered only when exactly ONE feature below the
   *    context has it — of `a.y` and `b.y`, `y` named whichever came first;
   *  - the features of a behaviour — a constraint, a requirement, a
   *    calculation, an action, a state ({@link ownsBody}) — and a directed
   *    feature, with everything below either, are never a bare name of the
   *    scope around them — `in x = 1.0` of one constraint answered the bare
   *    `x` of its siblings.
   *
   * `admission` decides only whether a name the walk resolves is MAPPED
   * ({@link ScopeAdmission}); which feature it denotes, and which names are
   * claimed, do not depend on it ({@link denote}). The map is shared: a caller
   * copies it before changing it.
   *
   * A value scope maps a name to the feature whose value it reads
   * ({@link valueRef}) — and where that value reads something the context
   * changes, it is read IN the context ({@link readAt}): P's `attribute m2 =
   * 10.0 - load` read as `p.m2`, in a `p` whose `:>> load = 50.0` overrides a
   * `default`, is p's −40, where it was read as P's 9 (a false proof) and then
   * as no value at all.
   */
  scope(contextId: ElementId, admission: ScopeAdmission): ReadonlyMap<string, ElementId> {
    const key = `${admission} ${contextId}`;
    let hit = this.scopes.get(key);
    if (!hit) {
      hit = new Map();
      const readers = new Map<string, ElementId>();
      for (const [name, d] of this.denote(contextId)) {
        if (admission === 'all') {
          hit.set(name, this.carrier(d.reader, d.feature).id);
          continue;
        }
        if (d.inCall || this.clash(d.reader, d.feature)) continue;
        const ref = this.valueRef(d);
        if (!ref) continue;
        hit.set(name, ref.target.id);
        if (ref.at !== undefined) readers.set(name, ref.at);
      }
      this.scopes.set(key, hit);
      if (admission === 'value') this.readers.set(contextId, readers);
    }
    return hit;
  }

  /**
   * The context a name of the value scope rooted at `contextId` is read IN,
   * where that is not where the value it reads is written ({@link valueRef}):
   * the usage on the chain, or the context, that changes what the value
   * reads. `undefined` for a name read where its value is written.
   */
  readAt(contextId: ElementId, name: string): ElementId | undefined {
    if (!this.readers.has(contextId)) this.scope(contextId, 'value');
    return this.readers.get(contextId)?.get(name);
  }

  /**
   * Where the value a name that denotes `d` reads is read: the feature whose
   * value it is ({@link carrier}: a redefinition that states nothing reads the
   * value it redefines), and the context to read it in when that is not where
   * it is written. A value written in P and read in a context that changes
   * nothing it reads is P's own ({@link sameIn}), read once for every such
   * context; one read in a context that changes an input is that context's
   * — the expression evaluated over the context's names (KerML: a feature's
   * value is per instance). `undefined` for a feature with no value to read:
   * none stated, none it redefines, or one an asserted equation defines.
   */
  valueRef(d: Denotation): ValueRef | undefined {
    const target = this.carrier(d.reader, d.feature);
    if (target !== d.feature) return { target };
    if (this.statedValue(target) !== undefined) {
      return target.ownerId === d.reader || this.sameIn(d.reader, target) ? { target } : { target, at: d.reader };
    }
    // An asserted equation that defines it answers it, not a value it redefines.
    if (this.statesOrDefines(d.reader, target)) return undefined;
    for (const g of redefinedClosure(this.model, target)) {
      // Nor a default a binding of it overrides: the binding gives its value.
      if (this.statedValue(g) !== undefined) {
        return boundOverDefault(this.model, target, g) ? undefined : { target: g, at: d.reader };
      }
      const n = this.nameOf(g);
      if (n !== undefined && g.ownerId != null && this.of(g.ownerId, n).length > 0) return undefined;
    }
    return undefined;
  }

  /**
   * What every name of the scope rooted at `contextId` DENOTES — the walk
   * {@link scope} admits from, before any value is asked of it: the feature,
   * and the context it is read in. Two readings of a value are compared name
   * by name through it ({@link sameIn}): `e.load` and a nested bare `load`
   * denote `E::load` read through P's `e` in P, and p's own `load` in `part p
   * : P { part :>> e { attribute :>> load = 50.0; } }`.
   */
  denote(contextId: ElementId): ReadonlyMap<string, Denotation> {
    let hit = this.denoted.get(contextId);
    if (!hit) {
      hit = this.walk(contextId);
      this.denoted.set(contextId, hit);
    }
    return hit;
  }

  private walk(contextId: ElementId): Map<string, Denotation> {
    const ids = new Map<string, Denotation>();
    const direct = new Set<string>();
    // Each nested bare name: how many features below the context have it, and
    // what the first of them denotes.
    const nested = new Map<string, { denoted: Denotation; count: number }>();
    // TWO guards, because they answer different questions. `onPath` is the
    // CYCLE guard and must be keyed on the owner ALONE: a feature whose type is
    // one of its own owners (`item def Person { timeslice asPresident : Person;
    // }`, the L4-self-typed-feature fixture) generates an unbounded name tower
    // `asPresident.asPresident…`, and a key that carries the prefix never
    // repeats, so it cannot see the cycle — it recursed until the stack died.
    // `visited` is only a WORK BOUND for a diamond reached twice at the SAME
    // prefix, so it keeps the prefix: two sibling features of one type (`part
    // a : T; part b : T;`) are different scopes and both must be walked.
    const visited = new Set<string>();
    const onPath = new Set<ElementId>();
    // `inCall`: below a calculation with a parameter, whose features are the
    // values of a CALL — its `in y = 100.0` a default nothing invokes, its
    // `return r = y` the result of one — so a value scope reads none of them.
    // `instance`: the instance of `ownerId` the walk is in, and `enclosing`
    // the ones it passed through to get there ({@link Denotation}).
    const visit = (
      ownerId: ElementId,
      prefix: string,
      inBody: boolean,
      inCall: boolean,
      instance: string,
      enclosing: readonly InstanceFrame[],
    ): void => {
      if (onPath.has(ownerId)) return;
      const guardKey = `${prefix} ${ownerId}`;
      if (visited.has(guardKey)) return;
      visited.add(guardKey);
      onPath.add(ownerId);
      for (const feat of this.features(ownerId)) {
        const name = this.nameOf(feat);
        if (!name) continue;
        const denoted: Denotation = { feature: feat, reader: ownerId, inCall, instance, enclosing };
        // A directed feature is its owner's parameter: never a nested bare name.
        const own = inBody || isDirected(feat);
        for (const n of [name, ...this.aliasesOf(feat)]) {
          const full = prefix ? `${prefix}.${n}` : n;
          if (!ids.has(full)) ids.set(full, denoted);
          if (prefix === '') direct.add(n);
          else if (!own) {
            const seen = nested.get(n);
            if (seen) seen.count++;
            else nested.set(n, { denoted, count: 1 });
          }
        }
        // A subject something binds is read through what it stands for, in
        // the instance it stands for.
        const into = this.subjectOf(ownerId, feat) ?? feat;
        const bound = into !== feat ? this.boundInstance(ownerId, feat, into) : undefined;
        visit(
          into.id,
          prefix ? `${prefix}.${name}` : name,
          own || ownsBody(feat),
          inCall || isCall(this.model, feat),
          bound?.instance ?? this.instanceBelow(instance, feat, name, prefix === ''),
          bound?.enclosing ?? [...enclosing, { instance, reader: ownerId }],
        );
      }
      onPath.delete(ownerId);
    };
    visit(contextId, '', false, false, this.instanceNameOf(contextId), []);
    for (const [n, seen] of nested) {
      if (direct.has(n) || ids.has(n) || seen.count !== 1) continue;
      ids.set(n, seen.denoted);
    }
    return ids;
  }

  /**
   * The instance the walk is in below `feat`, read in `instance` — the one its
   * features are read in ({@link Denotation}): `instance::name`; the instance
   * a subject is bound to (`into`); and for a subject nothing binds, read
   * where its requirement is the scope's root (`atRoot`), the generic instance
   * of its type — the requirement is about any one.
   *
   * Nowhere else is a subject generic. Reached through a usage on the chain —
   * `r1.s` beside `r2.s` for two usages of one requirement, a nested
   * requirement's `r2.t`, `sys.ra.s` — it is that usage's subject: one
   * symbol for every such reading made `r2.s.load >= 5.0` PROVED from
   * `assert r1.s.load >= 5.0`. And a subject that says something of its own
   * below it — a value or a redefinition (`subject s : P { attribute :>> load
   * = 50.0; }`), an assert, a constraint or a binding — is an instance of its
   * own: generic, its own assert was filed as a fact of EVERY P, and another
   * requirement's `t.load <= 3.0` was proved from it.
   */
  private instanceBelow(instance: string, feat: ElementRecord, name: string, atRoot: boolean): string {
    if (atRoot && feat.attrs.requirementRole === 'subject') {
      const type = this.model.typesOf(feat.id)[0];
      if (type && !this.saysOwn(feat)) return this.qualifiedNameOf(type.id);
    }
    return `${instance}::${name}`;
  }

  /**
   * The instance a subject bound to `into` stands for, in `contextId` — and
   * the instances that enclose it: the satisfier of a `satisfy R by x`
   * ({@link satisfaction}) read where the relationship is written, and the
   * feature a subject's value names (`subject s = q1.p`) read where it
   * resolves. `satisfy R by q1.p` is q1's p — Q's `assert constraint { p.x
   * >= 1.0 }` holds of it — and not the p of every Q, nor P's own. A name
   * that does not resolve so is the bound feature's own instance.
   *
   * The chain is walked link by link ({@link chainInstance}), never through
   * the {@link denote} walk of a scope it starts in: that walk may be the one
   * running — the requirement's own, or its package's, which visits the
   * requirement — and answered then, the subject was the bound feature's own
   * instance, cached for good. `subject s = q1.p` in r1 and `subject s =
   * q2.p` in r2 were then ONE symbol, Q's p's x: `s.x >= 5.0` beside `s.x <=
   * 3.0` "inconsistent", and the x of every Q bounded to [5, 7] "exactly".
   */
  private boundInstance(
    contextId: ElementId,
    f: ElementRecord,
    into: ElementRecord,
  ): { instance: string; enclosing: readonly InstanceFrame[] } {
    const fallback = { instance: this.qualifiedNameOf(into.id), enclosing: [] };
    const satisfied = this.satisfaction(contextId);
    const written = satisfied ? this.model.get(contextId) : undefined;
    const ref = satisfied ? (written?.attrs.sourceChain ?? written?.attrs.sourceRef) : f.attrs.value;
    if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(ref.trim())) {
      return fallback;
    }
    const path = ref.trim();
    const seen = new Set<ElementId>();
    for (
      let cur = satisfied ? (written?.ownerId ?? null) : f.ownerId;
      cur != null && !seen.has(cur);
      cur = satisfied ? null : (this.model.get(cur)?.ownerId ?? null)
    ) {
      seen.add(cur);
      const end = this.chainInstance(cur, path);
      if (!end) continue;
      return end.feature.id === into.id ? { instance: end.instance, enclosing: end.enclosing } : fallback;
    }
    return fallback;
  }

  /**
   * The instance a dotted `path`, read in `contextId`, ends at — as the
   * {@link denote} walk names it — with the instances that enclose it,
   * outermost first, and the feature it is: each link among the effective
   * features of the one before ({@link byName}), and each instance below a
   * link named as the walk names it ({@link instanceBelow}). `undefined` when
   * the path does not resolve, or passes through a subject something binds
   * (the walk re-roots there).
   */
  private chainInstance(
    contextId: ElementId,
    path: string,
  ): { feature: ElementRecord; instance: string; enclosing: InstanceFrame[] } | undefined {
    const segments = path.split('.');
    let owner = contextId;
    let instance = this.instanceNameOf(contextId);
    const enclosing: InstanceFrame[] = [];
    for (let i = 0; i < segments.length; i++) {
      const feature = this.byName(owner).get(segments[i]!);
      const name = feature ? this.nameOf(feature) : undefined;
      if (!feature || name === undefined) return undefined;
      enclosing.push({ instance, reader: owner });
      if (i === segments.length - 1) return { feature, instance: `${instance}::${name}`, enclosing };
      if (this.subjectOf(owner, feature)) return undefined;
      instance = this.instanceBelow(instance, feature, name, i === 0);
      owner = feature.id;
    }
    return undefined;
  }

  /**
   * What a requirement context binds its subject to: a `satisfy R by x`
   * ({@link satisfaction}), or a usage of R whose subject is bound by value
   * (`requirement r1 : R { subject s = q1; }`) — R, the feature the subject
   * stands for, and the instance it reads it as ({@link boundInstance}), with
   * the instances enclosing it. `undefined` for any other element.
   */
  subjectInstance(contextId: ElementId):
    | { requirement: ElementRecord; bound: ElementRecord; instance: string; enclosing: readonly InstanceFrame[] }
    | undefined {
    const satisfied = this.satisfaction(contextId);
    const requirement = satisfied ? satisfied.requirement : this.model.typesOf(contextId)[0];
    if (!requirement) return undefined;
    const subject = this.features(contextId).find((f) => f.attrs.requirementRole === 'subject');
    const bound = subject ? this.subjectOf(contextId, subject) : undefined;
    if (!subject || !bound) return undefined;
    return { requirement, bound, ...this.boundInstance(contextId, subject, bound) };
  }

  /** The type of the subject of the requirement `requirementId`, if it has one. */
  subjectTypeOf(requirementId: ElementId): ElementRecord | undefined {
    const subject = effectiveFeatures(this.model, requirementId).find((f) => f.attrs.requirementRole === 'subject');
    return subject ? this.model.typesOf(subject.id)[0] : undefined;
  }

  /**
   * Does a usage say something of its own below it — a feature with a value
   * or a redefinition, a constraint (asserted or not), a calculation, or a
   * binding ({@link instanceBelow})?
   */
  saysOwn(f: ElementRecord): boolean {
    return this.model.children(f.id).some(
      (c) =>
        c.eClass === 'ConstraintUsage' ||
        c.eClass === 'CalculationUsage' ||
        isBindingConnector(c) ||
        (isUsage(c.eClass) && (hasStatedValue(this.model, c) || redefinedClosure(this.model, c).length > 0)),
    );
  }

  /**
   * The value a feature that states NONE reads as a redefinition — an implicit
   * connector-end copy included — where its own context changes what that
   * value reads, so it is read there ({@link valueRef} with `at`): p's copy of
   * P's `m2 = 10.0 - load` (`bind w2 = p.m2`) in a `p` whose `:>> load =
   * 50.0` overrides a `default` is −40. `undefined` for every other feature —
   * where the context changes nothing, the copy reads the value it redefines
   * by that feature's own name ({@link carrier}).
   */
  redefinedValueOf(f: ElementRecord): (ValueRef & { at: ElementId }) | undefined {
    if (f.ownerId == null || this.statedValue(f) !== undefined) return undefined;
    // Most features redefine nothing, or nothing that states a value: answered
    // before any walk.
    this.redefining ??= new Set(this.model.ofKind('Redefinition').flatMap((r) => r.source ?? []));
    if (!this.redefining.has(f.id)) return undefined;
    if (!redefinedClosure(this.model, f).some((g) => this.statedValue(g) !== undefined)) return undefined;
    const name = this.nameOf(f);
    if (name === undefined) return undefined;
    const d = this.denote(f.ownerId).get(name);
    if (!d || d.feature !== f) return undefined;
    const ref = this.valueRef(d);
    return ref && ref.at !== undefined && ref.target !== f ? { target: ref.target, at: ref.at } : undefined;
  }

  /**
   * The symbol the verification lane reads a name that denotes `d` by — one
   * per INSTANCE of the feature whose value it reads: `R::g1::g` and
   * `R::g2::g` for `g1.g` and `g2.g` over `part def G { attribute g; }`, where
   * one symbol `R::G::g` made `g1.g == g2.g` PROVED of two values nothing
   * relates; `R::p::m2` for `p.m2`, whose value is p's own. The feature's own
   * qualified name where the instance is its generic one (the name read where
   * it is declared, or through a subject nothing binds), and where its value
   * is the same in every instance — a literal, or a value over literals that
   * the instance changes nothing of ({@link pinnedIn}): an instance symbol
   * there would be one more name for one number.
   */
  symbolOf(d: Denotation): string {
    const target = this.carrier(d.reader, d.feature);
    const own = this.qualifiedNameOf(target.id);
    const name = this.nameOf(d.feature);
    if (name === undefined) return own;
    const symbol = `${d.instance}::${name}`;
    // The generic reading needs no more asking; another one is its own unless pinned.
    return symbol === own || this.pinnedIn(d.reader, target) ? own : symbol;
  }

  /**
   * The symbol of each of `paths` read by `el` — its owner's scope first,
   * then its own ({@link symbolOf}) — for the paths read through an instance
   * of their own, with the instance it is read in, the reader, and the feature
   * whose value it is ({@link valueRef}): what an engine that gives the
   * instance its own symbol must read there too — that value, and every
   * relation the reader's types hold of each of their instances. `instance`
   * re-roots the reading where `el` is a relation of its owner read for one of
   * the owner's INSTANCES (`load` in P's assert read for `R::p` is
   * `R::p::load`). A path whose symbol is its feature's own qualified name is
   * left out.
   */
  instanceReadings(el: ElementRecord, paths: readonly string[], instance?: string): Map<string, InstanceReading> {
    const out = new Map<string, InstanceReading>();
    const roots = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
    const rebase = (symbol: string, root: ElementId): string => {
      if (instance === undefined) return symbol;
      const own = root === el.ownerId;
      const from = this.instanceNameOf(own ? root : el.id);
      const to = own ? instance : `${instance}::${effectiveNameOf(this.model, el) ?? el.declaredShortName ?? `«${el.eClass}»`}`;
      if (symbol === from) return to;
      return symbol.startsWith(`${from}::`) ? `${to}${symbol.slice(from.length)}` : symbol;
    };
    for (const path of paths) {
      for (const root of roots) {
        const d = this.denote(root).get(path);
        if (!d) continue;
        const target = this.carrier(d.reader, d.feature);
        // A value the same in every instance keeps its own symbol, however read.
        const own = this.symbolOf(d);
        const symbol =
          instance === undefined || (own === this.qualifiedNameOf(target.id) && this.pinnedIn(d.reader, target))
            ? own
            : rebase(own, root);
        if (symbol !== this.qualifiedNameOf(target.id)) {
          const ref = this.valueRef(d);
          out.set(path, {
            symbol,
            instance: rebase(d.instance, root),
            reader: d.reader,
            enclosing: d.enclosing.map((e) => ({ instance: rebase(e.instance, root), reader: e.reader })),
            feature: target,
            target: ref?.target ?? target,
            ...(ref?.at !== undefined ? { at: ref.at } : {}),
          });
        }
        break;
      }
    }
    return out;
  }

  /**
   * Is `f`'s value, read in `contextId`, the same in EVERY instance — a
   * literal; a value over names that are all such values where it is written,
   * which `contextId` changes nothing of ({@link sameIn}); a redefinition that
   * states nothing of a value that is ({@link carrier}); a feature an asserted
   * equation defines over such values? A feature with no value, a value a
   * binding holds, and one whose inputs the context changes are not: each
   * instance has its own ({@link symbolOf}).
   */
  pinnedIn(contextId: ElementId, f: ElementRecord): boolean {
    const key = `${contextId} ${f.id}`;
    const hit = this.pinned.get(key);
    if (hit !== undefined) return hit;
    if (this.pinning.has(key)) return false;
    this.pinning.add(key);
    let answer: boolean;
    try {
      answer = this.pinnedUncached(contextId, f);
    } finally {
      this.pinning.delete(key);
    }
    this.pinned.set(key, answer);
    return answer;
  }

  private pinnedUncached(contextId: ElementId, f: ElementRecord): boolean {
    // A `default` a binding holds ({@link defaultGivesWay}), or one a held
    // redefinition falls through to somewhere ({@link
    // BindingEnds.heldSomewhere}), is another value in each instance it reads
    // (F8, `held-redef`): its symbol is the instance's own.
    if (defaultGivesWaySomewhere(this.model, f)) return false;
    // A literal is the one value in every instance — one a binding it
    // contradicts contradicts in every instance too.
    const v = this.statedValue(f);
    if (typeof v === 'number' || typeof v === 'boolean') return true;
    if (typeof v === 'string' && isQuoted(v.trim())) return true;
    if (this.contradiction(f) || this.clash(contextId, f)) return false;
    if (typeof v === 'string') {
      const s = v.trim();
      if (f.ownerId == null || (f.ownerId !== contextId && !this.sameIn(contextId, f))) return false;
      return this.namesPinnedIn(f.ownerId, namesOfValue(s));
    }
    const g = this.carrier(contextId, f);
    if (g !== f) return this.pinnedIn(contextId, g);
    const name = this.nameOf(f);
    if (name === undefined || f.ownerId == null) return false;
    const site = this.of(contextId, name).length > 0 ? contextId : this.of(f.ownerId, name).length > 0 ? f.ownerId : undefined;
    if (site === undefined || (site !== contextId && !this.sameIn(contextId, f, site))) return false;
    return this.of(site, name).every((eq) => this.namesPinnedIn(site, refsIn(eq.definition, eq.literals)));
  }

  /** Is every one of `names`, read in `contextId`, a value the same in every instance ({@link pinnedIn})? */
  private namesPinnedIn(contextId: ElementId, names: readonly string[]): boolean {
    const here = this.denote(contextId);
    for (const n of names) {
      const d = here.get(n);
      if (!d || !this.pinnedIn(d.reader, this.carrier(d.reader, d.feature))) return false;
    }
    return true;
  }

  /**
   * Where the asserted equations that define the valueless feature a bare
   * `name` denotes in `contextId` are written, and the context they are read
   * IN, when none in `contextId` may: the feature's owner — or the nearest
   * feature it redefines with one — read there when `contextId` changes
   * nothing they read ({@link inheritedSite}), and in `contextId` where it
   * does (the definition is a fact of every instance, over that instance's
   * names). `undefined` when none defines it.
   */
  definitionReadIn(contextId: ElementId, name: string): { site: ElementId; at: ElementId } | undefined {
    if (this.of(contextId, name).length > 0) return undefined;
    const feature = this.feature(contextId, name);
    if (!feature) return undefined;
    const site = this.definitionOwner(feature);
    if (site === undefined || site === contextId) return undefined;
    return { site, at: this.sameIn(contextId, feature, site) ? site : contextId };
  }

  /** Where `f`'s asserted definitions are written: its owner, else the owner of the nearest feature it redefines that has one. */
  private definitionOwner(f: ElementRecord): ElementId | undefined {
    for (const g of [f, ...redefinedClosure(this.model, f)]) {
      const n = this.nameOf(g);
      if (n === undefined || g.ownerId == null) continue;
      if (this.of(g.ownerId, n).length > 0) return g.ownerId;
      if (hasStatedValue(this.model, g)) return undefined;
    }
    return undefined;
  }

  /**
   * {@link chainSite}, read in the instance the chain names: the valueless
   * feature a dotted chain ends at, where its asserted definition is written,
   * and the context it is read IN — where it is written when the usage the
   * chain reads it through changes nothing it reads, else that usage. `p.e`,
   * over P's `e == load * 2.0` and a `p` whose `:>> load = 50.0` overrides a
   * `default`, is 100. `undefined` when the chain ends at no such feature.
   */
  chainDefinition(
    contexts: readonly ElementId[],
    path: string,
  ): { feature: ElementRecord; site: ElementId; at: ElementId } | undefined {
    if (!path.includes('.')) return undefined;
    const end = this.chain(contexts, path);
    if (!end || !end.clean || !end.usage) return undefined;
    const { feature } = end;
    const name = this.nameOf(feature);
    if (!name || hasStatedValue(this.model, feature)) return undefined;
    const site =
      end.via !== undefined && this.of(end.via, name).length > 0 ? end.via : this.definitionOwner(feature);
    if (site === undefined) return undefined;
    const same = site === end.usage.id || this.sameIn(end.usage.id, feature, site);
    return { feature, site, at: same ? site : end.usage.id };
  }

  /**
   * The feature a dotted chain ends at, walked as every scope walks it — its
   * head among the first of `contexts` that has it, each later link among the
   * effective features of the USAGE before it (its own (re)definitions first,
   * then what its types declare) — with the usage the last link was read
   * through, as `via`. `clean` is kept for the callers: a chain through the
   * usage always reads the feature the usage has. `undefined` when the chain
   * does not resolve.
   */
  chain(
    contexts: readonly ElementId[],
    path: string,
  ): { feature: ElementRecord; usage?: ElementRecord; via?: ElementId; clean: boolean } | undefined {
    const [head, ...rest] = path.split('.');
    let feature: ElementRecord | undefined;
    let owner: ElementId | undefined;
    for (const c of contexts) {
      feature = this.byName(c).get(head!);
      owner = c;
      if (feature) break;
    }
    let usage: ElementRecord | undefined;
    let via: ElementId | undefined;
    for (const segment of rest) {
      if (!feature || owner === undefined) return undefined;
      // A subject something binds is read through what it stands for, as the walk reads it.
      const into = this.subjectOf(owner, feature) ?? feature;
      const next = this.byName(into.id).get(segment);
      if (!next) return undefined;
      via = into.id;
      usage = into;
      owner = into.id;
      feature = next;
    }
    return feature ? { feature, ...(usage ? { usage } : {}), ...(via !== undefined ? { via } : {}), clean: true } : undefined;
  }

  /**
   * Does a name that denotes `mine` in `contextId` read the value `g` gives —
   * `g` itself, the feature whose value `mine` reads ({@link carrier}), or,
   * where neither states nor defines anything, the valueless feature `mine`
   * redefines (an implicit connector-end copy of a port, `attribute :>> x;`
   * of an `x` with no value: both are the one unknown) — or the same literal,
   * restated?
   *
   * Not a redefinition that states nothing of its own but CHANGES what lies
   * below it — `part :>> e { attribute :>> load = 50.0; }`, `part :>> e : E2`:
   * a chain through it reads another feature than one through `g`.
   */
  readsAs(contextId: ElementId, mine: ElementRecord, g: ElementRecord): boolean {
    if (mine === g || this.carrier(contextId, mine) === g) return true;
    // A redefinition that restates the literal it redefines reads that value.
    if (isLiteralRestatement(mine, g)) return true;
    if (this.statesOrDefines(contextId, mine) || this.statesOrDefines(contextId, g)) return false;
    if (changesBelow(this.model, mine)) return false;
    return redefinedClosure(this.model, mine).some((h) => h.id === g.id);
  }

  /** Does `f` state a value, or have an asserted definition where it is written or in `contextId`? */
  private statesOrDefines(contextId: ElementId, f: ElementRecord): boolean {
    if (hasStatedValue(this.model, f)) return true;
    const name = this.nameOf(f);
    if (name === undefined) return false;
    return (f.ownerId != null && this.of(f.ownerId, name).length > 0) || this.of(contextId, name).length > 0;
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
   * context redefines one with a value of its own, by name or by an unnamed
   * `:>>`, transitively through the values and definitions those names have.
   * Each name is compared WHOLE, as the walk resolves it in both places
   * ({@link denote}) — `e.load` and a nested bare `load` reach p's own `load`
   * through `part :>> e { … }` — and one feature read through two usages is
   * the same only where its value is the same in both (`p.m2` through Q's `p`
   * and through q's `:>> p`).
   * Where one does (`:>> load = 50.0` over a `default`, making margin −40),
   * the value is the context's own: read IN the context, over its names
   * ({@link valueRef}), and by a symbol of its own ({@link symbolOf}) — it
   * was read as P's (a false proof), then as no value at all (a refusal).
   * Where none does, every such context reads the one value written, once.
   * A redefinition that states nothing reads what it
   * redefines ({@link readsAs}) and changes nothing. A name the body reads
   * that is no feature of where it is written, and a valueless input a
   * binding holds, are not followed: answered as changed — but a name that
   * resolves neither where the value is written nor in the context reads the
   * same nothing in both, and leaves the value its own fault. `valueOnly` asks of
   * the value alone, for a feature the context's name does not denote itself
   * (the one a redefinition that states nothing reads: {@link carrier}).
   */
  sameIn(contextId: ElementId, feature: ElementRecord, site?: ElementId, valueOnly = false): boolean {
    const key = `${contextId} ${feature.id} ${site ?? ''} ${valueOnly}`;
    const hit = this.same.get(key);
    if (hit !== undefined) return hit;
    // A question that comes back to itself while it is asked (through a
    // redefinition that reads what it redefines: {@link carrier}) answers
    // "same" — it adds no change of its own — and nothing answered on the
    // strength of that guess is kept but the outermost answer.
    if (this.asking.has(key)) {
      this.guessed = true;
      return true;
    }
    const outermost = this.asking.size === 0;
    this.asking.add(key);
    try {
      const answer = this.sameUncached(contextId, feature, site, valueOnly);
      if (outermost || !this.guessed) this.same.set(key, answer);
      return answer;
    } finally {
      this.asking.delete(key);
      if (outermost) this.guessed = false;
    }
  }

  private sameUncached(contextId: ElementId, feature: ElementRecord, site: ElementId | undefined, valueOnly: boolean): boolean {
    const own = this.nameOf(feature);
    if (!valueOnly && own !== undefined && this.denote(contextId).get(own)?.feature !== feature) return false;
    const reads = this.readsOf(feature, site !== undefined ? [site] : []);
    if (reads === undefined) return false;
    const here = this.denote(contextId);
    for (const { owner, names } of reads) {
      const there = this.denote(owner);
      for (const name of names) {
        // Each name WHOLE — `e.load`, a nested bare `load` — as the walk
        // resolves it in both places: the head alone named P's `e` and p's `:>>
        // e` "the same", and missed the `load = 50.0` p's `e` holds.
        const g = there.get(name);
        const mine = here.get(name);
        // A name nothing resolves where the value is written, nor here, reads
        // nothing either place: unchanged, and the value keeps its own fault.
        if (g === undefined && mine === undefined) continue;
        if (g === undefined || mine === undefined || !this.sameReading(mine, g, name)) return false;
      }
    }
    return true;
  }

  /**
   * Does a name that denotes `mine` here read the value it reads where `g` is
   * what it denotes? The same feature read in the same context, or in another
   * that reads its value the same ({@link sameIn}: `p.m2` through Q's `p` and
   * through q's `:>> p`, whose `load` differs, is not); else `mine` reading
   * `g`'s value ({@link readsAs}) where that value is the same.
   */
  private sameReading(mine: Denotation, g: Denotation, name: string): boolean {
    const leaf = this.nameOf(g.feature) ?? name.slice(name.lastIndexOf('.') + 1);
    const site = g.reader !== g.feature.ownerId && this.of(g.reader, leaf).length > 0 ? g.reader : undefined;
    if (mine.feature === g.feature) {
      return mine.reader === g.reader || this.sameIn(mine.reader, g.feature, site);
    }
    return this.readsAs(mine.reader, mine.feature, g.feature) && this.sameIn(mine.reader, g.feature, site, true);
  }

  /**
   * The features `feature`'s value reads, transitively — through its stated
   * value, the asserted equations that define it (in `contextId` and where it
   * is written), and, for a redefinition that states nothing, the value it
   * redefines — each as resolved where the value is written AND in
   * `contextId` (a chain in the usage it is read through). The inputs a
   * context may change: for a value read where it is not ({@link sameIn}
   * false), the features whose change made it so.
   */
  dependencies(contextId: ElementId, feature: ElementRecord): ElementId[] {
    const out = new Set<ElementId>();
    const seen = new Set<string>();
    const visit = (f: ElementRecord, sites: readonly ElementId[], context: ElementId): void => {
      const key = `${f.id} ${context}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!hasStatedValue(this.model, f)) for (const g of redefinedClosure(this.model, f)) visit(g, sites, context);
      const here = this.denote(context);
      for (const { owner, names } of this.readsOf(f, sites) ?? []) {
        const there = this.denote(owner);
        for (const name of names) {
          const mine = here.get(name);
          if (mine) {
            out.add(mine.feature.id);
            out.add(this.carrier(mine.reader, mine.feature).id);
          }
          const g = there.get(name);
          if (g) {
            out.add(g.feature.id);
            visit(g.feature, [owner], mine?.reader ?? context);
          }
        }
      }
    };
    visit(feature, [contextId], contextId);
    return [...out];
  }

  /**
   * The feature whose value a name read in `contextId` reads, where the
   * feature it denotes there, `f` (the most specific), states none and
   * nothing defines it where it is written or in `contextId`: the nearest
   * feature it redefines that states a value or has an asserted definition
   * where it is written — when that value is the same read in `contextId`
   * ({@link sameIn}, the value alone). `attribute :>> load;` in `part p : P`
   * reads P's `load = 1.0`. Else `f` itself: a redefinition of a valueless
   * feature (an implicit connector-end copy) is the feature the chain names.
   */
  carrier(contextId: ElementId, f: ElementRecord): ElementRecord {
    const key = `${contextId} ${f.id}`;
    const hit = this.carried.get(key);
    if (hit) return hit;
    const asked = this.carrying.get(key);
    if (asked) {
      this.guessed = true;
      return asked;
    }
    const answer = this.carrierUncached(contextId, f, key);
    if (this.asking.size === 0 || !this.guessed) this.carried.set(key, answer);
    return answer;
  }

  private carrierUncached(contextId: ElementId, f: ElementRecord, key: string): ElementRecord {
    if (hasStatedValue(this.model, f)) return f;
    const name = this.nameOf(f);
    if (name === undefined) return f;
    if (f.ownerId != null && this.of(f.ownerId, name).length > 0) return f;
    if (this.of(contextId, name).length > 0) return f;
    for (const g of redefinedClosure(this.model, f)) {
      const gName = this.nameOf(g);
      const defined = gName !== undefined && g.ownerId != null && this.of(g.ownerId, gName).length > 0;
      if (!hasStatedValue(this.model, g) && !defined) continue;
      // A default the binding of `f` overrides is no value `f` reads.
      if (!defined && boundOverDefault(this.model, f, g)) return f;
      // While asked, `f` reads `g` (what `sameIn` meets of `f` again).
      this.carrying.set(key, g);
      try {
        return this.sameIn(contextId, g, defined ? g.ownerId! : undefined, true) ? g : f;
      } finally {
        this.carrying.delete(key);
      }
    }
    return f;
  }

  /**
   * The other value `contextId` inherits under `f`'s name where `f` is the
   * feature its name keeps there ({@link inheritedNameClashes}), or
   * `undefined` — `part def C :> A, B` over A's `:>> load = 5.0` and B's `:>>
   * load = 7.0`, both of P's `load`. Every C is an A and a B, so its load is
   * 5 AND 7; reading A's 5 dropped B's binding silently, and `c.load <= 6.0`
   * was PROVED. The name reads no value there on any surface. `contradiction`
   * when both values are bindings (`=`, not `default`) that neither overrides
   * — the model states both — and `decided` when both are literals that
   * differ ({@link compareWrittenValues}).
   */
  clash(contextId: ElementId, f: ElementRecord): NameClash | undefined {
    const name = this.nameOf(f);
    if (name === undefined) return undefined;
    const hit = this.clashesIn(contextId).get(name);
    return hit && hit.kept === f ? hit : undefined;
  }

  /**
   * Does `name`, read in `contextId`, denote a feature two values the context
   * it is read in inherit under one name ({@link clash})? Such a name reads
   * neither value on any surface, and nothing read through a binding stands in
   * for them (A.2.1): the binding reaches one of the two.
   */
  clashedIn(contextId: ElementId, name: string): boolean {
    const d = this.denote(contextId).get(name);
    return d !== undefined && this.clash(d.reader, d.feature) !== undefined;
  }

  /** Every {@link clash} of `contextId`, by name, once per context. */
  clashesIn(contextId: ElementId): ReadonlyMap<string, NameClash> {
    let out = this.clashes.get(contextId);
    if (!out) {
      out = new Map();
      for (const [name, [kept, ...others]] of inheritedNameClashes(this.model, contextId)) {
        const rk = valueSourceOf(this.model, kept!);
        if (!rk) continue;
        const keptOwner = kept!.ownerId;
        for (const other of others) {
          // The kept feature's owner specialises the other's: it masks it, as
          // a feature masks one by name ({@link contradictedBindingOf}).
          if (
            keptOwner != null &&
            other.ownerId != null &&
            generalizationsOf(this.model, keptOwner).some((g) => g.id === other.ownerId)
          ) {
            continue;
          }
          const ro = valueSourceOf(this.model, other);
          if (!ro || ro === rk || redefinedClosure(this.model, rk).includes(ro)) continue;
          const compared = compareWrittenValues(rk, ro);
          if (compared === 'same') continue;
          const independent = !redefinedClosure(this.model, ro).includes(rk);
          const contradiction = independent && rk.attrs.defaultValue !== true && ro.attrs.defaultValue !== true;
          out.set(name, {
            kept: kept!,
            other,
            keptValue: rk,
            otherValue: ro,
            contradiction,
            decided: contradiction && compared === 'differs',
          });
          break;
        }
      }
      this.clashes.set(contextId, out);
    }
    return out;
  }

  /**
   * Every {@link clash} that is a contradiction, once — at the most general
   * user context it arises in (`part def C :> A, B`, not every `part c : C`
   * too), in model order.
   */
  contradictoryClashes(): ReadonlyArray<{ context: ElementRecord; name: string; clash: NameClash }> {
    if (!this.reportedClashes) {
      const out: Array<{ context: ElementRecord; name: string; clash: NameClash }> = [];
      for (const x of this.model.all()) {
        if (x.attrs.isLibrary === true || x.attrs.implicit === true) continue;
        if (!isUsage(x.eClass) && !isDefinition(x.eClass)) continue;
        for (const [name, clash] of this.clashesIn(x.id)) {
          if (!clash.contradiction) continue;
          const inherited = generalizationsOf(this.model, x.id).some((g) => {
            if (g.attrs.isLibrary === true) return false;
            const there = this.clashesIn(g.id).get(name);
            return there !== undefined && there.keptValue === clash.keptValue && there.otherValue === clash.otherValue;
          });
          if (!inherited) out.push({ context: x, name, clash });
        }
      }
      this.reportedClashes = out;
    }
    return this.reportedClashes;
  }

  /**
   * The BINDING `f`'s stated value contradicts, or `undefined`
   * ({@link contradictedBindingOf}), once per feature.
   */
  contradiction(f: ElementRecord): BindingConflict | undefined {
    let hit = this.contradicted.get(f.id);
    if (hit === undefined) {
      hit = contradictedBindingOf(this.model, f) ?? null;
      this.contradicted.set(f.id, hit);
    }
    return hit ?? undefined;
  }

  /**
   * Where the asserted equations that define the valueless feature a bare
   * `name` denotes in `contextId` are read, when none in `contextId` may: the
   * feature's owner, when `contextId` INHERITS the feature and its definition
   * (`part def S :> P`, over P's `assert constraint { e == a * b }`) and
   * changes nothing the definition reads ({@link sameIn}). `undefined`
   * otherwise — and then the definition is read in `contextId` itself
   * ({@link definitionReadIn}), or nowhere: what a context comparing its
   * reading with its owner's asks ({@link changingContexts}).
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
   * the asserted equations that define it are read — the usage the chain
   * reads it through, else its owner — when the usage changes nothing the
   * definition reads ({@link sameIn}): `p.e`, over `part p : P` and P's `e ==
   * a * b`, is P's e. `undefined` otherwise — where the usage changes what it
   * reads, it reads the definition itself ({@link chainDefinition}).
   */
  chainSite(contexts: readonly ElementId[], path: string): { feature: ElementRecord; site: ElementId } | undefined {
    if (!path.includes('.')) return undefined;
    const end = this.chain(contexts, path);
    if (!end || !end.clean || !end.usage) return undefined;
    const { feature } = end;
    const name = this.nameOf(feature);
    if (!name || hasStatedValue(this.model, feature)) return undefined;
    const site = [end.via, feature.ownerId].find((c): c is ElementId => c != null && this.of(c, name).length > 0);
    if (site === undefined) return undefined;
    return site === end.usage.id || this.sameIn(end.usage.id, feature, site) ? { feature, site } : undefined;
  }

  /**
   * The user contexts that SPECIALISE `typeId` — every usage typed by it and
   * every definition or usage that specialises it, transitively — in model
   * order. Implicit connector-end copies are no context of their own.
   */
  specialisersOf(typeId: ElementId): readonly ElementRecord[] {
    if (!this.specialised) {
      const out = new Map<ElementId, ElementRecord[]>();
      const add = (g: ElementRecord, x: ElementRecord): void => {
        if (g.attrs.isLibrary === true) return;
        const list = out.get(g.id);
        if (list) list.push(x);
        else out.set(g.id, [x]);
      };
      for (const x of this.model.all()) {
        if (x.attrs.isLibrary === true || x.attrs.implicit === true) continue;
        // A `satisfy R by x` specialises R, and what R specialises.
        const satisfied = this.satisfaction(x.id);
        if (satisfied) {
          for (const g of [satisfied.requirement, ...generalizationsOf(this.model, satisfied.requirement.id)]) add(g, x);
          continue;
        }
        if (!isUsage(x.eClass) && !isDefinition(x.eClass)) continue;
        for (const g of generalizationsOf(this.model, x.id)) add(g, x);
      }
      this.specialised = out;
    }
    return this.specialised.get(typeId) ?? [];
  }

  /**
   * The name a context is shown by: a `satisfy R by x`'s satisfier's
   * ({@link satisfaction}) — the instance it names, `q1.p`'s `R::q1::p` —
   * else the context's own effective qualified name.
   */
  contextName(contextId: ElementId): string {
    const satisfied = this.satisfaction(contextId);
    if (!satisfied) return this.qualifiedNameOf(contextId);
    return this.subjectInstance(contextId)?.instance ?? this.qualifiedNameOf(satisfied.satisfier.id);
  }

  /**
   * The contexts a relation `el` holds in that read it DIFFERENTLY from where
   * it is written: of the user contexts that specialise `el`'s owner ({@link
   * specialisersOf}), those where a name the body reads (`names`, as written)
   * denotes another feature — a redefinition with a value of its own, never a
   * redefinition that states nothing ({@link readsAs}) — or a value read
   * there and not in the owner, or the other way round (a derived value whose
   * inputs the context changes), or one defined by an asserted equation in
   * one and not in the other. A definition's constraints and asserts hold in
   * every context that specialises it, so each such context reads them anew;
   * one that reads every name exactly as an earlier one does adds nothing
   * (`part s : S` beside `part def S :> P { :>> load … }`).
   */
  changingContexts(el: ElementRecord, names: readonly string[]): ElementRecord[] {
    return this.contextsOf(el, names).listed;
  }

  /**
   * Is the context `contextId` one `el` is read in ({@link readingContexts})
   * only because a binding member is read there otherwise than where it is
   * written ({@link readsOtherwise}) — a context the binding's reading by
   * feature alone does not list? M7's `q2 : Q { :>> K = 25.0; }` reads Q's `L =
   * 2.0 * K`, which Q's `bind p.load = L` gives p's load, as its own 50: Q's `c
   * { p.load <= 5.0 }` is q2's own there, and no surface reads a bound value
   * for one instance yet — so every surface leaves that reading undecided
   * ({@link boundHereSentence}). Read as the context reads its names, it
   * published a value the binding does not give: over an asserted partner
   * (`assert constraint { L == 2.0 * K }`), P's default through the end copy,
   * as Q2's `p.load` beside Q2's L of 50.
   */
  readsBoundOnly(el: ElementRecord, names: readonly string[], contextId: ElementId): boolean {
    const role = el.attrs.requirementRole;
    if ((role !== 'require' && role !== 'assume') || el.ownerId == null) {
      return !this.contextsOf(el, names).plain.has(contextId);
    }
    for (const c of this.model.children(el.ownerId)) {
      const r = c.attrs.requirementRole;
      if ((r !== 'require' && r !== 'assume') || typeof c.attrs.expression !== 'string') continue;
      const body = parseRelationBody(c.attrs.expression);
      if (body && this.contextsOf(c, refsIn(body.node, body.literals)).plain.has(contextId)) return false;
    }
    return true;
  }

  /**
   * {@link changingContexts}, and the contexts the binding reading by feature
   * alone lists (`plain`, {@link bindingReadingIn}): a context is listed where
   * either lists it, so none a feature-only reading lists is ever dropped.
   */
  private contextsOf(
    el: ElementRecord,
    names: readonly string[],
  ): { listed: ElementRecord[]; plain: ReadonlySet<ElementId> } {
    const key = `${el.id} ${el.ownerId ?? ''} ${names.join(' ')}`;
    const hit = this.changing.get(key);
    if (hit) return hit;
    const answer = this.contextsUncached(el, names);
    this.changing.set(key, answer);
    return answer;
  }

  private contextsUncached(
    el: ElementRecord,
    names: readonly string[],
  ): { listed: ElementRecord[]; plain: ReadonlySet<ElementId> } {
    const plain = new Set<ElementId>();
    const owner = el.ownerId;
    if (owner == null || names.length === 0) return { listed: [], plain };
    const contexts = this.specialisersOf(owner);
    if (contexts.length === 0) return { listed: [], plain };
    const ownAll = this.scope(owner, 'all');
    const ownValue = this.scope(owner, 'value');
    const reads = this.boundReads(owner, names);
    const ownBound = reads.size > 0 ? bindingReadingIn(this.model, owner, owner, reads) : undefined;
    const ownPlain = reads.size > 0 ? bindingReadingIn(this.model, owner, owner, reads, false) : undefined;
    const out: ElementRecord[] = [];
    const readings = new Set<string>();
    const plainReadings = new Set<string>();
    for (const x of contexts) {
      if (x.id === owner || x.id === el.id) continue;
      const all = this.scope(x.id, 'all');
      const value = this.scope(x.id, 'value');
      let changed = false;
      const reading: string[] = [];
      for (const n of names) {
        const idT = ownAll.get(n);
        if (idT === undefined) continue;
        const idX = all.get(n);
        const valued = value.has(n);
        // A value read IN the context, over its own names (`readAt`), is the
        // context's own: one its inputs make other than where it is written.
        const at = valued ? this.readAt(x.id, n) : undefined;
        const site = valued ? undefined : this.definitionSite(x.id, n);
        reading.push(`${n}=${idX ?? ''}:${valued}:${site ?? ''}:${at ?? ''}`);
        if (idX === undefined) {
          changed = true;
          continue;
        }
        if (idX !== idT) {
          const fT = this.model.get(idT);
          const fX = this.model.get(idX);
          if (!fT || !fX || !this.readsAs(x.id, fX, fT)) changed = true;
        }
        if (valued !== ownValue.has(n)) changed = true;
        else if (valued && (at === undefined) !== (this.readAt(owner, n) === undefined)) changed = true;
        else if (!valued && (site === undefined) !== (this.definitionSite(owner, n) === undefined)) changed = true;
      }
      // A value read through a binding the context joins otherwise: its own —
      // by the features it joins (`plain`), or by what a member reads there.
      let listed = false;
      if (ownBound !== undefined) {
        const bound = bindingReadingIn(this.model, owner, x.id, reads);
        const byFeature = bindingReadingIn(this.model, owner, x.id, reads, false);
        const key = [...reading, byFeature ?? ''].join(' ');
        if ((changed || byFeature !== ownPlain) && !plainReadings.has(key)) {
          plainReadings.add(key);
          plain.add(x.id);
          listed = true;
        }
        reading.push(bound ?? '');
        if (bound !== ownBound) changed = true;
      } else if (changed && !plainReadings.has(reading.join(' '))) {
        plainReadings.add(reading.join(' '));
        plain.add(x.id);
      }
      const key = reading.join(' ');
      if (changed && !readings.has(key)) {
        readings.add(key);
        listed = true;
      }
      if (listed || plain.has(x.id)) out.push(x);
    }
    return { listed: out, plain };
  }

  /**
   * The contexts a relation is read in besides where it is written: for a
   * clause of a requirement — an `assume` or a `require` — every context ANY
   * clause of that requirement is read differently in, so the requirement is
   * read there whole, each goal under its own assumptions (`assume A; require
   * G` where only G changes in `satisfy R by p` still reads A in p); for any
   * other relation, its own {@link changingContexts}.
   */
  readingContexts(el: ElementRecord, names: readonly string[]): ElementRecord[] {
    const role = el.attrs.requirementRole;
    if ((role !== 'require' && role !== 'assume') || el.ownerId == null) return this.changingContexts(el, names);
    let hit = this.clauseContexts.get(el.ownerId);
    if (!hit) {
      const out: ElementRecord[] = [];
      for (const c of this.model.children(el.ownerId)) {
        const r = c.attrs.requirementRole;
        if ((r !== 'require' && r !== 'assume') || typeof c.attrs.expression !== 'string') continue;
        const body = parseRelationBody(c.attrs.expression);
        if (!body) continue;
        for (const x of this.changingContexts(c, refsIn(body.node, body.literals))) {
          if (!out.includes(x)) out.push(x);
        }
      }
      hit = out;
      this.clauseContexts.set(el.ownerId, hit);
    }
    return hit;
  }

  /**
   * A context ABOVE the usage `contextId` that reads what `names` read there
   * through a binding otherwise than the usage's owner does — `q : Q`, where
   * Q's `bind p.load = L` joins Q's p's load to q's `L = 50.0`, for P's `load
   * <= 10.0` read in `Q::p` — or `undefined`. A relation read in `Q::p` is read
   * for Q's own p; q's p is an instance of P that no context names, so the
   * reading is not every Q's p's ({@link bindingReadingIn}).
   *
   * While a binding of the model was read in fewer contexts than it holds in
   * ({@link bindingCapOf}), the context that reads it otherwise may be one
   * left out: any reading of a binding's end — what `names` read, or what
   * their values read — answers the cap (`pastCap`), wherever it is read. So
   * does a reading of an end of one binding left out of a context
   * ({@link BindingEnds.unread}).
   */
  boundAbove(contextId: ElementId, names: readonly string[]): BoundAbove | undefined {
    if (!hasUserBindings(this.model)) return undefined;
    const reads = this.boundReads(contextId, names);
    if (reads.size === 0) return undefined;
    const { overCap, unread } = bindingEnds(this.model);
    if (overCap.size > 0 || unread.size > 0) {
      for (const id of reads) {
        const met = overCap.get(id);
        if (met !== undefined) return { pastCap: met };
        if (unread.has(id)) return { pastCap: 'outside' };
      }
    }
    const seen = new Set<ElementId>();
    for (let cur = this.model.get(contextId); cur && isUsage(cur.eClass) && cur.ownerId != null; ) {
      if (seen.has(cur.id)) return undefined;
      seen.add(cur.id);
      const owner = this.model.get(cur.ownerId);
      if (!owner) return undefined;
      const own = bindingReadingIn(this.model, owner.id, owner.id, reads);
      if (own !== undefined) {
        const other = this.specialisersOf(owner.id).find((y) => bindingReadingIn(this.model, owner.id, y.id, reads) !== own);
        if (other) return other;
      }
      cur = owner;
    }
    return undefined;
  }

  /**
   * The features the values of `names` read in `contextId` — each feature a
   * name denotes, what it reads ({@link carrier}), and its value's
   * {@link dependencies} — for {@link bindingReadingIn}.
   */
  private boundReads(contextId: ElementId, names: readonly string[]): Set<ElementId> {
    const out = new Set<ElementId>();
    if (!hasUserBindings(this.model)) return out;
    const denoted = this.denote(contextId);
    for (const n of names) {
      const d = denoted.get(n);
      if (!d) continue;
      out.add(d.feature.id);
      out.add(this.carrier(d.reader, d.feature).id);
      for (const id of this.dependencies(contextId, d.feature)) out.add(id);
    }
    return out;
  }

  /** Where the asserted equation that defines the valueless feature `name` denotes in `contextId` is read, if anywhere. */
  private definitionSite(contextId: ElementId, name: string): ElementId | undefined {
    if (name.includes('.')) return this.chainSite([contextId], name)?.site;
    return this.of(contextId, name).length > 0 ? contextId : this.inheritedSite(contextId, name);
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
    const name = this.nameOf(f);
    if (!name) return [];
    const out: Array<{ owner: ElementId; names: string[] }> = [];
    for (const site of new Set([...sites, ...(f.ownerId != null ? [f.ownerId] : [])])) {
      for (const eq of this.of(site, name)) out.push({ owner: site, names: refsIn(eq.definition, eq.literals) });
    }
    return out.length === 0 && this.boundFeatures().has(f.id) ? undefined : out;
  }

  /** Every feature a binding connector touches ({@link bindingEndsOf}). */
  private boundFeatures(): ReadonlySet<ElementId> {
    this.bound ??= bindingEndsOf(this.model);
    return this.bound;
  }
}

/**
 * Is `el` a binding connector — the test `isBindingEdge` of ./connectors
 * makes, written here because that module reads the unit-aware evaluator,
 * which reads this one.
 */
export function isBindingConnector(el: ElementRecord): boolean {
  const kind = el.attrs.connectorKind ?? el.attrs.kind;
  return (
    el.eClass === 'BindingConnectorAsUsage' ||
    el.eClass === 'BindingConnector' ||
    el.attrs.bind === true ||
    kind === 'bind' ||
    kind === 'equals' ||
    kind === 'equality'
  );
}

const SHARED = new WeakMap<Model, DefiningEquations>();

/**
 * The {@link DefiningEquations} of `model` at its current revision — one
 * reading shared by every pass and every scope asked of the same revision,
 * and a fresh one as soon as the model changes. A caller that holds no pass
 * (`idScopeFor` of ./relations) asks here rather than building one per
 * relation: the walk is the costly part of a scope, and it is the same walk.
 */
export function sharedDefinitions(model: Model): DefiningEquations {
  const hit = SHARED.get(model);
  if (hit && hit.rev === model.rev) return hit;
  const fresh = new DefiningEquations(model);
  SHARED.set(model, fresh);
  return fresh;
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
 *
 * Nor a `default` a binding holds ({@link defaultGivesWay}): the default gives
 * way to the binding, and the feature states no value of its own.
 */
export function statedValueOf(model: Model, el: ElementRecord): AttrValue | undefined {
  const v = el.attrs.value;
  if (v !== undefined && v !== null) return defaultGivesWay(model, el) ? undefined : v;
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
 * The ends of the model's binding connectors, and the features whose
 * `default` gives way to one ({@link heldDefaults}), once per model revision.
 */
interface BindingEnds {
  rev: number;
  ends: ReadonlySet<ElementId>;
  /**
   * The features a binding holds over a `default` — the one they write, or the
   * one they read through a redefinition (an implicit connector-end copy of
   * P's `load`): no surface reads that default for them.
   */
  held: ReadonlySet<ElementId>;
  /**
   * Per context a binding holds in: each end path there, the feature at it,
   * and the component it is in ({@link heldDefaults}).
   */
  readings: ReadonlyMap<ElementId, ReadonlyMap<string, { feature: ElementId; component: string }>>;
  /**
   * Whether ANY binding of the model was read in fewer contexts than it holds
   * in ({@link BindingEnds.overCap}), and which cap it met first — the
   * model-wide summary {@link bindingCapOf} reports. The guards read the
   * per-binding {@link BindingEnds.overCap}, so a model with one deep binding
   * no longer abstains every bound read ({@link boundPartnerSafe}, {@link
   * DefiningEquations.boundAbove}).
   */
  partial: boolean;
  cap?: BindingCap;
  /**
   * The ends of the bindings read in fewer contexts than they hold in — past
   * {@link MAX_BINDING_FRAMES}, or a context deeper than
   * {@link MAX_BINDING_SEGMENTS} usages left out ({@link heldDefaults}) — each
   * with the cap its own binding met: per binding, never model-wide. Only a
   * reading of one of THESE ends answers the cap ({@link boundPartnerSafe},
   * {@link DefiningEquations.boundAbove}); a deep binding no longer abstains
   * every bound read of the model.
   */
  overCap: ReadonlyMap<ElementId, BindingCap>;
  /**
   * The ends of the bindings read in a context where one of their ends is no
   * feature this tool finds ({@link heldDefaults}) — held as past a cap, and
   * read for no one instance ({@link boundPartnerSafe}, {@link
   * DefiningEquations.boundAbove}): per binding, not model-wide.
   */
  unread: ReadonlySet<ElementId>;
  /**
   * The instance spellings at which a held redefinition's fall-through would
   * read the redefined feature's own `default` — the original feature's
   * default gives way THERE, and only there ({@link defaultGivesWayIn}): the
   * held-redefinition defect's per-instance hold.
   */
  heldIn: ReadonlySet<string>;
  /**
   * The features a binding holds over a `default` SOMEWHERE ({@link heldIn}):
   * a feature whose default gives way in one instance is not a value the same
   * in every instance ({@link DefiningEquations.pinnedIn}), and the numeric
   * and SMT lanes key it per instance, rather than seeding the definition's
   * own value.
   */
  heldSomewhere: ReadonlySet<ElementId>;
  /**
   * The ends of the bindings that join a feature of an instance enclosing
   * where they are written (R's `L` in `part q : Q { bind p.load = L; }`):
   * read where they are written by their own id (`#…`), for every such
   * instance alike ({@link readAsJoined}).
   */
  enclosed: ReadonlySet<ElementId>;
  /** How many binding connectors the USER wrote — the library's are never read ({@link hasUserBindings}). */
  userBindings: number;
  /** The two ends of each of them: what one connector joins, whatever context reads it ({@link joinedTo}). */
  edges: ReadonlyArray<readonly [ElementId, ElementId]>;
  /** Lazy indexes over `readings`, built when first asked ({@link indexOf}). */
  index?: BindingIndex;
}

/**
 * The cap a binding's reading met ({@link BindingEnds.partial}) — or, for one
 * binding alone, `outside`: a context it holds in where an end it joins is no
 * feature this tool finds ({@link BindingEnds.unread}).
 */
export type BindingCap = 'frames' | 'segments' | 'outside';

/**
 * The lazy indexes over {@link BindingEnds.readings}: each context's
 * components with their member paths (`members`), the contexts and paths
 * each feature is a member at (`roots`), how each member is read there
 * (`marks`, {@link readsOtherwise}), the features the connectors join to
 * each end (`joined`, {@link joinedTo}), and whether every context reads a
 * feature's component as its connectors join it (`uniform`).
 */
interface BindingIndex {
  members: Map<ElementId, Map<string, string[]>>;
  roots: Map<ElementId, Array<{ root: ElementId; path: string }>>;
  marks: Map<ElementId, Map<string, string>>;
  joined?: Map<ElementId, ReadonlySet<ElementId>>;
  uniform: Map<ElementId, boolean>;
}

const BINDING_ENDS = new WeakMap<Model, BindingEnds>();

/** Past this many contexts for one binding, its ends are held wherever they read a default. */
const MAX_BINDING_FRAMES = 4096;

/** Past this many usages on a context's path below where a binding is written, the context is not read. */
const MAX_BINDING_SEGMENTS = 32;

function bindingEnds(model: Model): BindingEnds {
  const hit = BINDING_ENDS.get(model);
  if (hit && hit.rev === model.rev) return hit;
  const ends = new Set<ElementId>();
  const bindings: ElementRecord[] = [];
  const edges: Array<readonly [ElementId, ElementId]> = [];
  for (const el of model.all()) {
    if (!isBindingConnector(el)) continue;
    for (const id of [...(el.source ?? []), ...(el.target ?? [])]) ends.add(id);
    if (el.attrs.isLibrary === true || el.ownerId == null) continue;
    bindings.push(el);
    const [s, t] = [el.source?.[0], el.target?.[0]];
    if (s !== undefined && t !== undefined && s !== t) edges.push([s, t]);
  }
  const read: Pick<BindingEnds, 'held' | 'readings' | 'cap' | 'unread' | 'enclosed' | 'heldIn' | 'heldSomewhere' | 'overCap'> =
    bindings.length > 0
      ? heldDefaults(model, bindings)
      : { held: new Set<ElementId>(), readings: new Map(), unread: new Set<ElementId>(), enclosed: new Set<ElementId>(), heldIn: new Set<string>(), heldSomewhere: new Set<ElementId>(), overCap: new Map() };
  const fresh: BindingEnds = {
    rev: model.rev,
    ends,
    ...read,
    partial: read.cap !== undefined,
    userBindings: bindings.length,
    edges,
  };
  BINDING_ENDS.set(model, fresh);
  return fresh;
}

/** Every feature a binding connector touches ({@link isBindingConnector}), once per model revision. */
export function bindingEndsOf(model: Model): ReadonlySet<ElementId> {
  return bindingEnds(model).ends;
}

/**
 * Does the user's model hold a binding connector of its own? The library
 * carries dozens (82 `BindingConnectorAsUsage` in the full one), and no
 * surface reads them as the model's: a model that writes none — v9 — reads
 * every value as it always did, and nothing below asks about bindings.
 */
export function hasUserBindings(model: Model): boolean {
  return bindingEnds(model).userBindings > 0;
}

/**
 * The cap a binding of the model met ({@link BindingEnds.partial}) —
 * `undefined` while every binding is read in every context it holds in.
 */
export function bindingCapOf(model: Model): BindingCap | undefined {
  return bindingEnds(model).cap;
}

/** The indexes over the model's binding readings ({@link BindingIndex}), built once per revision. */
function indexOf(model: Model): BindingIndex {
  const ends = bindingEnds(model);
  if (ends.index) return ends.index;
  const members = new Map<ElementId, Map<string, string[]>>();
  const roots = new Map<ElementId, Array<{ root: ElementId; path: string }>>();
  for (const [root, reading] of ends.readings) {
    const byComponent = new Map<string, string[]>();
    for (const [path, r] of reading) {
      const list = byComponent.get(r.component);
      if (list) list.push(path);
      else byComponent.set(r.component, [path]);
      const at = roots.get(r.feature);
      if (at) at.push({ root, path });
      else roots.set(r.feature, [{ root, path }]);
    }
    members.set(root, byComponent);
  }
  ends.index = { members, roots, marks: new Map(), uniform: new Map() };
  return ends.index;
}

/**
 * How the member at `path` of the binding reading of context `root` is read
 * there: its feature id, with `@` and what its value reads there
 * ({@link readSignature}) where it is read in another context than where it
 * is written ({@link readsOtherwise}) — once per member.
 */
function markOf(model: Model, root: ElementId, path: string): string | undefined {
  const r = bindingEnds(model).readings.get(root)?.get(path);
  if (!r) return undefined;
  const { marks } = indexOf(model);
  let byPath = marks.get(root);
  if (!byPath) {
    byPath = new Map();
    marks.set(root, byPath);
  }
  let mark = byPath.get(path);
  if (mark === undefined) {
    const f = model.get(r.feature);
    const at = f ? readsOtherwise(model, root, path, f) : undefined;
    mark = at === undefined || !f ? r.feature : `${r.feature}@${readSignature(model, at, f)}`;
    byPath.set(path, mark);
  }
  return mark;
}

/**
 * What makes the value of `f`, read in the context `at` ({@link
 * readsOtherwise}), the one it is there: the features it reads, as `at`
 * resolves them ({@link DefiningEquations.dependencies}). A usage that
 * changes nothing the value reads — each of a thousand `part qi : Q2;` — reads
 * it as Q2 does and signs it alike, so {@link
 * DefiningEquations.changingContexts} lists one of them, as it lists one for a
 * value it reads directly; q's `:>> K = 25.0` and q2's `:>> K = 0.1` sign it
 * apart. Where the value reads a binding's end, what that end reads is no
 * feature `at` resolves (`L = 2.0 * K` with `bind K = J`): the context itself
 * signs it.
 */
function readSignature(model: Model, at: ElementId, f: ElementRecord): string {
  const deps = sharedDefinitions(model).dependencies(at, f);
  const { ends } = bindingEnds(model);
  if (deps.length === 0 || deps.some((id) => ends.has(id))) return at;
  return [...deps].sort().join('+');
}

/**
 * The context the value of `f`, the member at `path` of a binding read in
 * `contextId`, is read IN there, where that is not where it is written — or
 * `undefined`. A value over names the context changes is the context's own
 * ({@link DefiningEquations.readAt}): Q's `L = 2.0 * K` read at `L` in `q :
 * Q { :>> K = 25.0; }` is q's 50, not Q's 1. So is one an asserted equation
 * defines, read where the context changes what it reads ({@link
 * DefiningEquations.definitionReadIn}, {@link
 * DefiningEquations.chainDefinition}). A literal never is: it is one value in
 * every instance.
 *
 * Where its own reading reads it already is no other context: a redefinition
 * that states nothing reads the value it redefines in its own usage ({@link
 * DefiningEquations.redefinedValueOf}) — p's copy of P's `m2 = 10.0 - load`
 * in `p : P { :>> load = 50.0; }` is p's −40 however it is reached.
 *
 * Two contexts that join the same features read a binding alike only where
 * each member is read as its own reading reads it in both — or in one context
 * both share: a value the binding carries to its other end is read for the
 * instance, and the generic reading of a partner (`boundDerivation` of
 * ./units-eval, which reads it so) is that instance's only then ({@link
 * boundPartnerSafe}).
 */
export function readsOtherwise(model: Model, contextId: ElementId, path: string, f: ElementRecord): ElementId | undefined {
  const v = f.attrs.value;
  if (typeof v === 'number' || typeof v === 'boolean') return undefined;
  if (path.startsWith('#')) return undefined;
  const definitions = sharedDefinitions(model);
  const at = definitions.readAt(contextId, path);
  if (at !== undefined) return at === definitions.redefinedValueOf(f)?.at ? undefined : at;
  const read = path.includes('.')
    ? definitions.chainDefinition([contextId], path)
    : definitions.definitionReadIn(contextId, path);
  return read && read.at !== read.site ? read.at : undefined;
}

/**
 * Where a context `contextId` reads the binding component of the feature its
 * bare `name` denotes — the context itself where a binding is read there,
 * else the nearest context above it, climbing from a usage to its owner as
 * {@link heldDefaults} does (`Q::p`'s `load` is read in Q, at `p.load`) — or
 * `undefined` where no binding reaches it.
 */
function componentOf(
  model: Model,
  contextId: ElementId,
  name: string,
): { root: ElementId; path: string; feature: ElementId; component: string } | undefined {
  const { readings } = bindingEnds(model);
  const definitions = sharedDefinitions(model);
  const seen = new Set<ElementId>();
  let path = name;
  for (let cur = model.get(contextId); cur && !seen.has(cur.id); ) {
    seen.add(cur.id);
    const r = readings.get(cur.id)?.get(path);
    if (r) return { root: cur.id, path, ...r };
    if (!isUsage(cur.eClass) || cur.ownerId == null || path.split('.').length > MAX_BINDING_SEGMENTS) return undefined;
    const n = definitions.nameOf(cur);
    if (n === undefined) return undefined;
    path = `${n}.${path}`;
    cur = model.get(cur.ownerId);
  }
  return undefined;
}

/**
 * The features the user's binding connectors join to `featureId`, itself
 * included — each connector's two ends, joined through the ends they share
 * (`bind x = y; bind y = e;` holds `x` to `e`), wherever they are read. These
 * are the partners `boundDerivation` of ./units-eval reads a value from.
 */
function joinedTo(model: Model, featureId: ElementId): ReadonlySet<ElementId> {
  const index = indexOf(model);
  if (!index.joined) {
    const parent = new Map<ElementId, ElementId>();
    const find = (a: ElementId): ElementId => {
      let root = a;
      while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
      parent.set(a, root);
      return root;
    };
    for (const [a, b] of bindingEnds(model).edges) {
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      const [x, y] = [find(a), find(b)];
      if (x !== y) parent.set(x, y);
    }
    const classes = new Map<ElementId, Set<ElementId>>();
    for (const id of parent.keys()) {
      const root = find(id);
      const set = classes.get(root) ?? new Set<ElementId>();
      set.add(id);
      classes.set(root, set);
    }
    index.joined = new Map([...parent.keys()].map((id) => [id, classes.get(find(id))!]));
  }
  return index.joined.get(featureId) ?? new Set([featureId]);
}

/**
 * Does context `root` read the binding component `component` as its
 * connectors join it to `featureId` — its members exactly the features they
 * join ({@link joinedTo}), none a redefinition that stands in one's place
 * there (`q2 : Q { :>> L = 50.0; }` joins Q's `load` to q2's own L), and each
 * read where it is written ({@link readsOtherwise})? Then the value a partner
 * gives where it is written is the value it gives there.
 *
 * Where the binding is written, a feature of an instance enclosing it is read
 * by its own id — R's `L` for `part q : Q { bind p.load = L; }`, whichever R
 * the q is in ({@link BindingEnds.enclosed}) — so that reading is every such
 * instance's only `alike`: when every context that reads the binding in an
 * instance of R reads it as joined ({@link uniformlyRead}).
 */
function readAsJoined(model: Model, root: ElementId, component: string, featureId: ElementId, alike = false): boolean {
  const { readings, enclosed } = bindingEnds(model);
  const reading = readings.get(root);
  const paths = indexOf(model).members.get(root)?.get(component) ?? [];
  const joined = joinedTo(model, featureId);
  const features = new Set<ElementId>();
  for (const path of paths) {
    if (markOf(model, root, path)?.includes('@')) return false;
    const r = reading?.get(path);
    if (!r || !joined.has(r.feature)) return false;
    if (!alike && path.startsWith('#') && enclosed.has(r.feature)) return false;
    features.add(r.feature);
  }
  return features.size === joined.size;
}

/**
 * Does every context a binding is read in read the component of `featureId`
 * as its connectors join it ({@link readAsJoined})? Then a partner's value is
 * one in every instance, and its generic reading is each one's. Vacuously so
 * for a feature no binding reading reaches.
 */
function uniformlyRead(model: Model, featureId: ElementId): boolean {
  const index = indexOf(model);
  const hit = index.uniform.get(featureId);
  if (hit !== undefined) return hit;
  const { readings } = bindingEnds(model);
  let answer = true;
  for (const { root, path } of index.roots.get(featureId) ?? []) {
    const component = readings.get(root)?.get(path)?.component;
    if (component === undefined || !readAsJoined(model, root, component, featureId, true)) {
      answer = false;
      break;
    }
  }
  index.uniform.set(featureId, answer);
  return answer;
}

/**
 * May the value a BINDING gives the valueless feature `featureId` — the one
 * the bare `name` denotes in `contextId` — be read where its partner is
 * written (`boundDerivation` of ./units-eval, which reads a derived partner at
 * its own element)? That is each instance's value only where every instance
 * the reading stands for reads the partner so:
 *  - always, in a model that writes no binding ({@link hasUserBindings});
 *  - never, while a binding was read in fewer contexts than it holds in
 *    ({@link BindingEnds.partial}) and the feature, or the one it reads, is
 *    any binding's end — or is an end of a binding left out of a context
 *    ({@link BindingEnds.unread});
 *  - where every context reads its component as its connectors join it
 *    ({@link uniformlyRead});
 *  - else where the context's own reading of the component does
 *    ({@link readAsJoined}), and no context above it reads the binding
 *    otherwise ({@link DefiningEquations.boundAbove}).
 *
 * M2's `q.p.m2` (P's `10.0 - load`, Q's `bind p.load = L` over `L = 2.0 *
 * K`, q's K of 25) is read in `Q::p` for every Q's p: read at Q, L was 1 and
 * m2 9 — a false refutation of `q.p.m2 <= 0.0`, where q's is −40. So was
 * Q's `load <= 5.0` read in `q2 : Q { :>> L = 50.0; }` over Q's `L default =
 * 2.0 * K`: Q's L of 1, where q2's load is its own L of 50. No value is read
 * there now; only a reading per instance may give one.
 */
export function boundPartnerSafe(model: Model, contextId: ElementId, name: string, featureId: ElementId): boolean {
  const ends = bindingEnds(model);
  if (ends.userBindings === 0) return true;
  const f = model.get(featureId);
  if (!f) return true;
  const definitions = sharedDefinitions(model);
  const carried = definitions.carrier(contextId, f).id;
  if (ends.overCap.has(f.id) || ends.overCap.has(carried)) return false;
  // A feature whose default a held redefinition falls through to SOMEWHERE
  // (`held-redef`): its generic reading is one instance's only, so a partner
  // read through it is not safe.
  if (ends.heldSomewhere.has(f.id) || ends.heldSomewhere.has(carried)) return false;
  if (ends.unread.has(f.id) || ends.unread.has(carried)) return false;
  if (uniformlyRead(model, f.id)) return true;
  // Read where the context reads the component: no binding reaching it there
  // leaves nothing that says which instances it stands for.
  const own = componentOf(model, contextId, name);
  if (!own || own.feature !== f.id || !readAsJoined(model, own.root, own.component, f.id)) return false;
  return definitions.boundAbove(contextId, [name]) === undefined;
}

/**
 * What {@link DefiningEquations.boundAbove} finds above a context: another
 * context that reads a binding otherwise, or the cap a binding of the model
 * met ({@link BindingEnds.partial}).
 */
export type BoundAbove = ElementRecord | { pastCap: BindingCap };

/**
 * The sentence a cap answers a bound read with ({@link BindingEnds.overCap}):
 * the binding it belongs to held in more contexts than this tool reads, or is
 * read deeper than {@link MAX_BINDING_SEGMENTS} usages.
 */
function bindingCapSentence(cap: BindingCap): string {
  return cap === 'frames'
    ? `a binding of this model holds in more than ${MAX_BINDING_FRAMES.toLocaleString('en')} contexts`
    : `a binding of this model is read deeper than ${MAX_BINDING_SEGMENTS} usages`;
}

/**
 * Why a relation read in `contextId` is not read there for one instance
 * ({@link DefiningEquations.boundAbove}) — the sentence every surface refuses
 * or abstains on it with.
 */
export function boundAboveSentence(definitions: DefiningEquations, contextId: ElementId, above: BoundAbove): string {
  const where = definitions.contextName(contextId);
  if ('pastCap' in above) {
    if (above.pastCap === 'outside') {
      return (
        `the relation is read in ${where} and reads a value a binding joins, and that binding joins a feature ` +
        'outside where it is written that this tool finds no instance of in a context the binding holds in: ' +
        'so it reads no value the binding gives for any one instance, and the relation is not carried'
      );
    }
    const cap = bindingCapSentence(above.pastCap);
    return (
      `the relation is read in ${where} and reads a value a binding joins, and ${cap}: past that, this tool ` +
      'reads no bound value for any one instance, so it is not carried'
    );
  }
  return (
    `the relation is read in ${where}, and a binding above it joins what it reads to another value in ` +
    `${definitions.contextName(above.id)}: each instance reads it otherwise, and this tool reads it for one ` +
    'alone, so it is not carried'
  );
}

/**
 * Why a relation is not read in the context `contextId`, which reads it
 * otherwise only because a binding member's value is its own there ({@link
 * DefiningEquations.readsBoundOnly}) — the sentence every surface leaves that
 * reading undecided with.
 */
export function boundHereSentence(definitions: DefiningEquations, contextId: ElementId): string {
  const where = definitions.contextName(contextId);
  return (
    `the relation is read in ${where}, and a binding joins what it reads to a value ${where} reads as its own: ` +
    'this tool reads a bound value for one instance only where every instance reads it alike, so it is not carried'
  );
}

/**
 * Why a relation written in a USAGE is not read for one instance — the usage
 * stands for several, and a binding above it reads what the relation reads
 * otherwise in one of them ({@link DefiningEquations.boundAbove}) — or
 * `undefined`. `part p : P { constraint c2 { load <= 10.0 } }` in Q, whose
 * `bind p.load = L` gives q's p the load of q's `L = 50.0`, was PROVED at Q's
 * own L of 1: c2 is a feature of every Q's p, and q's breaks it. Every surface
 * reads such a relation as no verdict, in this sentence; an asserted one stays
 * a fact of the model (its generic reading is a weaker, sound assumption).
 * `names` are the names its body reads.
 */
export function usageOwnedRefusal(model: Model, el: ElementRecord, names: readonly string[]): string | undefined {
  if (el.ownerId == null || !hasUserBindings(model)) return undefined;
  const owner = model.get(el.ownerId);
  if (!owner || !isUsage(owner.eClass)) return undefined;
  const definitions = sharedDefinitions(model);
  const above = definitions.boundAbove(owner.id, names);
  return above ? boundAboveSentence(definitions, owner.id, above) : undefined;
}

/** The names a relation body reads, a `[unit]` literal's marker excluded, once each — `[]` for one that does not parse. */
export function relationNamesOf(expr: string): string[] {
  const body = parseRelationBody(expr.trim());
  return body ? [...new Set(refsIn(body.node, body.literals))] : [];
}

/**
 * The dotted path of feature `id` below `ownerId`, by effective names —
 * `undefined` when it is not below it: `p.load` for the end of Q's `bind
 * p.load = L`.
 */
export function bindingEndPath(model: Model, id: ElementId | undefined, ownerId: ElementId): string | undefined {
  const segments: string[] = [];
  const seen = new Set<ElementId>();
  for (let cur = id !== undefined ? model.get(id) : undefined; cur; cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
    if (cur.id === ownerId) return segments.length > 0 ? segments.join('.') : undefined;
    if (seen.has(cur.id)) return undefined;
    seen.add(cur.id);
    const name = effectiveNameOf(model, cur);
    if (name === undefined) return undefined;
    segments.unshift(name);
  }
  return undefined;
}

/** What a feature at a binding's end states, for {@link heldDefaults}. */
type EndValue = { kind: 'value' } | { kind: 'default'; source: ElementRecord } | { kind: 'none' };

/**
 * The features whose `default` gives way to a binding (decision 10) — read in
 * every CONTEXT a binding holds in: where it is written, every context that
 * specialises its owner, and every context such an instance is a feature of
 * (Q's `bind p.load = L` holds in R at `q.p.load` and `q.L` for `part q : Q`
 * in R, and in `part r : R` at `r.q.p.load`). In each context the bindings
 * that hold there join their ends — each end the most specific feature at its
 * path there — into components: `bind B = A; bind C = B;` is one, and so is
 * Q's binding beside R's `bind q.L = M`. Where a component has a value of its
 * own — written with `=`, or defined by an asserted equation — every
 * `default` in it gives way: the one a member writes (q's `:>> load default =
 * 30.0` in a `p` Q binds to its `L = 50.0`) and the one a member reads
 * through a redefinition (the copy `bind p.load = L` makes of P's `load`).
 * Where it has none, one default stands — a binding to a feature nothing
 * gives a value (`attribute w; bind w = p.load;`) carries the default INTO
 * it, as it always did, an expression too — and two or more stand only where
 * they are one CONSTANT value ({@link defaultsAgree}); otherwise they give
 * way: two defaults bound to each other are no value the model states, and
 * reading both made it contradict itself. An expression is never one value
 * by its text: `2.0 * K` is another value in each instance that sets K.
 *
 * Read per context, a context's own value is no reason for a default where
 * the binding does not reach: Q's `L default = 1.0` stands in Q, though `q :
 * Q` sets L to 50 (q's L masks it there). The answer is per FEATURE: a
 * default that gives way in one context gives way in every one — a context
 * where it would have stood reads it through the binding, or not at all.
 *
 * A binding read in fewer contexts than it holds in — more than {@link
 * MAX_BINDING_FRAMES}, or one deeper than {@link MAX_BINDING_SEGMENTS} usages
 * left out — holds its ends wherever they read a default, since the context
 * left out may be the one that gives them another value (a package's `bind
 * top.a.….a.L = X` 33 usages down left T1's `L default = 1.0` standing
 * beside X's 50), and sets `cap` ({@link BindingEnds.partial}).
 */
function heldDefaults(
  model: Model,
  bindings: readonly ElementRecord[],
): Pick<BindingEnds, 'held' | 'readings' | 'cap' | 'unread' | 'enclosed' | 'heldIn' | 'heldSomewhere' | 'overCap'> {
  const definitions = sharedDefinitions(model);
  // Per context: the paths its bindings join, and the feature at each.
  const contexts = new Map<ElementId, { parent: Map<string, string>; at: Map<string, ElementRecord> }>();
  const held = new Set<ElementId>();
  const unread = new Set<ElementId>();
  const enclosed = new Set<ElementId>();
  const heldIn = new Set<string>();
  const heldSomewhere = new Set<ElementId>();
  const overCap = new Map<ElementId, BindingCap>();
  let cap: BindingCap | undefined;
  // Read nowhere in particular: held wherever an end reads a default.
  const holdEnds = (holder: ElementRecord, ids: readonly ElementId[]): void => {
    for (const id of ids) {
      const f = model.get(id);
      if (f && endValue(model, f, holder, '').kind === 'default') holdDefault(model, held, heldIn, heldSomewhere, f);
    }
  };
  const resolve = (root: ElementId, path: string): ElementRecord | undefined => {
    let owner = root;
    let f: ElementRecord | undefined;
    for (const seg of path.split('.')) {
      f = definitions.byName(owner).get(seg);
      if (!f) return undefined;
      owner = f.id;
    }
    return f;
  };
  const find = (parent: Map<string, string>, a: string): string => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (a !== root) {
      const next = parent.get(a)!;
      parent.set(a, root);
      a = next;
    }
    return root;
  };
  for (const b of bindings) {
    const holder = model.get(b.ownerId!);
    const left = b.source?.[0];
    const right = b.target?.[0];
    if (!holder || left === undefined || right === undefined || left === right) continue;
    const pair = [left, right] as const;
    const places = [endPlace(model, left, holder), endPlace(model, right, holder)] as const;
    places.forEach((place, k) => place.kind === 'enclosed' && enclosed.add(pair[k]));
    // The contexts it holds in, each with the path its ends are read at — and,
    // for an end of an instance that encloses the holder (R's `L` in `part q :
    // Q { bind p.load = L; }`), the path from the context to that instance
    // (`outer`), once a climb from a usage to its owner reached it.
    type Frame = { root: ElementRecord; prefix: string; outer: readonly [string | undefined, string | undefined] };
    const frames: Frame[] = [{ root: holder, prefix: '', outer: [undefined, undefined] }];
    const index = new Map<string, number>([[`${holder.id} `, 0]]);
    const next: number[][] = [];
    let dropped = false;
    for (let i = 0; i < frames.length && frames.length <= MAX_BINDING_FRAMES; i++) {
      const { root, prefix, outer } = frames[i]!;
      const succ: Frame[] = definitions.specialisersOf(root.id).map((z) => ({ root: z, prefix, outer }));
      const name = isUsage(root.eClass) ? definitions.nameOf(root) : undefined;
      const owner = root.ownerId != null ? model.get(root.ownerId) : undefined;
      if (name !== undefined && owner && owner.attrs.isLibrary !== true) {
        const up = (k: 0 | 1): string | undefined => {
          const o = outer[k];
          if (o !== undefined) return o === '' ? name : `${name}.${o}`;
          const place = places[k];
          return place.kind === 'enclosed' && place.within.has(owner.id) ? '' : undefined;
        };
        succ.push({ root: owner, prefix: prefix === '' ? name : `${name}.${prefix}`, outer: [up(0), up(1)] });
      }
      const edges: number[] = [];
      for (const f of succ) {
        const key = `${f.root.id} ${f.prefix}`;
        const known = index.get(key);
        if (known !== undefined) {
          edges.push(known);
          continue;
        }
        if (f.prefix.split('.').length > MAX_BINDING_SEGMENTS) {
          dropped = true;
          continue;
        }
        index.set(key, frames.length);
        edges.push(frames.length);
        frames.push(f);
      }
      next[i] = edges;
    }
    if (frames.length > MAX_BINDING_FRAMES) {
      cap ??= 'frames';
      for (const id of pair) overCap.set(id, 'frames');
      holdEnds(holder, pair);
      continue;
    }
    if (dropped) {
      cap ??= 'segments';
      for (const id of pair) overCap.set(id, 'segments');
      holdEnds(holder, pair);
    }
    // A context below the instance that owns an end (a usage of the holder in
    // that instance's definition, before a climb reaches it) reads the end
    // where the climb does (`pending`); one in which an end is no feature at
    // all — its path does not resolve there, or no climb reaches its owner —
    // is a context left out, and its ends are held as past a cap.
    const located: boolean[] = [];
    const pending: boolean[] = [];
    let outside = false;
    for (let i = 0; i < frames.length; i++) {
      const { root, prefix, outer } = frames[i]!;
      const own = prefix === '' && root.id === holder.id;
      const at = (k: 0 | 1): [string, ElementRecord] | 'pending' | undefined => {
        const end = pair[k];
        const place = places[k];
        if (own || place.kind === 'global') {
          const f = model.get(end);
          return f ? [own && place.kind === 'below' ? place.path : `#${end}`, f] : undefined;
        }
        if (place.kind === 'nowhere') return undefined;
        let full: string;
        if (place.kind === 'below') full = prefix === '' ? place.path : `${prefix}.${place.path}`;
        else if (outer[k] === undefined) return 'pending';
        else full = outer[k] === '' ? place.path : `${outer[k]}.${place.path}`;
        const f = resolve(root.id, full);
        return f ? [full, f] : undefined;
      };
      const l = at(0);
      const r = at(1);
      if (l === undefined || r === undefined) {
        outside = true;
        continue;
      }
      if (l === 'pending' || r === 'pending') {
        pending[i] = true;
        continue;
      }
      located[i] = true;
      let ctx = contexts.get(root.id);
      if (!ctx) {
        ctx = { parent: new Map(), at: new Map() };
        contexts.set(root.id, ctx);
      }
      for (const [path, f] of [l, r]) {
        if (!ctx.parent.has(path)) ctx.parent.set(path, path);
        ctx.at.set(path, f);
      }
      const a = find(ctx.parent, l[0]);
      const c = find(ctx.parent, r[0]);
      if (a !== c) ctx.parent.set(a, c);
    }
    // A pending context is read where a climb from it reads both ends; one
    // no climb takes there is left out.
    const reached = located.slice();
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = frames.length - 1; i >= 0; i--) {
        if (reached[i] === true || pending[i] !== true || !(next[i] ?? []).some((j) => reached[j] === true)) continue;
        reached[i] = true;
        changed = true;
      }
    }
    if (pending.some((p, i) => p && reached[i] !== true)) outside = true;
    if (outside) {
      holdEnds(holder, pair);
      for (const id of pair) unread.add(id);
    }
  }
  const readings = new Map<ElementId, Map<string, { feature: ElementId; component: string }>>();
  for (const [rootId, ctx] of contexts) {
    const root = model.get(rootId)!;
    const components = new Map<string, Array<{ f: ElementRecord; value: EndValue; path: string }>>();
    const reading = new Map<string, { feature: ElementId; component: string }>();
    for (const [path, f] of ctx.at) {
      const key = find(ctx.parent, path);
      const list = components.get(key) ?? [];
      list.push({ f, value: endValue(model, f, root, path), path });
      components.set(key, list);
      reading.set(path, { feature: f.id, component: key });
    }
    readings.set(rootId, reading);
    for (const members of components.values()) {
      // One default per MEMBER, not per source: R3a's `A::v` read at a1.v and
      // at a2.v is two readings of `2.0 * K`, one per instance.
      const defaults = members.flatMap((m) => (m.value.kind === 'default' ? [m.value.source] : []));
      if (defaults.length === 0) continue;
      const stated = members.some((m) => m.value.kind === 'value');
      if (stated || !defaultsAgree(defaults))
        for (const m of members)
          if (m.value.kind === 'default') holdDefault(model, held, heldIn, heldSomewhere, m.f, heldInstance(definitions, rootId, m.path));
    }
  }
  return { held, readings, unread, enclosed, heldIn, heldSomewhere, overCap, ...(cap !== undefined ? { cap } : {}) };
}

/**
 * Hold the default a binding overrides — and, for `inst`, the instance at
 * which a held redefinition falls through to the redefined feature's own
 * `default`. Reading `P::a` generically where a redefinition of it
 * (`part :>> p { attribute :>> a default = 50.0; }`) is held would read the
 * redefined feature's default beside the binding there (`held-redef`): the
 * original's default gives way at that instance alone
 * ({@link defaultGivesWayIn}), so other instances of P keep it.
 */
function holdDefault(
  model: Model,
  held: Set<ElementId>,
  heldIn: Set<string>,
  heldSomewhere: Set<ElementId>,
  f: ElementRecord,
  inst?: string,
): void {
  held.add(f.id);
  // A held redefinition falls through to the default it redefines when read
  // generically: that default is per instance — heldSomewhere, not held — so
  // the reading surfaces suppress it only at the instance (`defaultGivesWayIn`)
  // while the numeric and SMT lanes key it per instance.
  for (const g of redefinedClosure(model, f)) if (g.attrs.defaultValue === true) heldSomewhere.add(g.id);
  // Only a held member that itself WRITES a default suppresses the redefined
  // feature at that instance. A valueless implicit end copy redefining a
  // feature an asserted equation defines (GA6's `p.load`) must not: its
  // fall-through reads the assert, a stated value, not the default.
  if (inst !== undefined && f.attrs.defaultValue === true) heldIn.add(inst);
}

/** The instance spelling of the member at `path` read in the frame rooted at `rootId` — or `undefined` for one no path spells. */
function heldInstance(definitions: DefiningEquations, rootId: ElementId, path: string): string | undefined {
  if (path.startsWith('#')) return undefined;
  return `${definitions.instanceNameOf(rootId)}::${path.split('.').join('::')}`;
}

/**
 * The default a feature's own `default` gives way to a binding ({@link
 * defaultGivesWay}) — or gives way AT the instance `inst` because a held
 * redefinition of it falls through there (`held-redef`). `undefined` `inst`
 * answers the per-feature hold alone.
 */
export function defaultGivesWaySomewhere(model: Model, f: ElementRecord): boolean {
  if (f.attrs.defaultValue !== true) return false;
  const ends = bindingEnds(model);
  return ends.held.has(f.id) || ends.heldSomewhere.has(f.id);
}

/**
 * The default a feature's own `default` gives way to a binding ({@link
 * defaultGivesWay}) — or gives way AT the instance `inst` because a held
 * redefinition of it falls through there (`held-redef`). `undefined` `inst`
 * answers the per-feature hold alone.
 */
export function defaultGivesWayIn(model: Model, f: ElementRecord, inst: string | undefined): boolean {
  if (f.attrs.defaultValue !== true) return false;
  const ends = bindingEnds(model);
  if (ends.held.has(f.id)) return true;
  if (inst === undefined) return false;
  if (ends.heldIn.has(inst)) return true;
  const name = effectiveNameOf(model, f);
  return name !== undefined && ends.heldIn.has(`${inst}::${name}`);
}

/**
 * Do the defaults a binding component joins with no value of its own — one
 * per member, `sources` the features that write them ({@link heldDefaults})
 * — stand as ONE value in every instance they are read in?
 *  - One default stands: a binding into a feature with nothing of its own
 *    carries it, even an expression, read in that member's own instance.
 *  - Two or more agree only where each is a CONSTANT — a literal number with
 *    its unit, a boolean, or an expression that reads no name ({@link
 *    constantOf}) — and all compare the same exactly ({@link sameConstant}).
 *    Never by their text: R3a's one `v default = 2.0 * K`, read at a1.v and
 *    at a2.v where a2 sets K to 5, is 2 and 10; and R3c's P and Q each write
 *    `2.0 * K` over a K of their own.
 */
function defaultsAgree(sources: readonly ElementRecord[]): boolean {
  if (sources.length < 2) return true;
  const [first, ...rest] = sources;
  return rest.every((g) => sameConstant(first!, g));
}

/**
 * Do `a` and `b` write one CONSTANT value, compared exactly ({@link
 * defaultsAgree})? Two literal numbers as {@link compareQuantities} reads
 * them, two booleans as written, and otherwise two name-free expressions
 * ({@link compareConstants}); anything that reads a name is no constant.
 */
function sameConstant(a: ElementRecord, b: ElementRecord): boolean {
  const x = a.attrs.value;
  const y = b.attrs.value;
  if (typeof x === 'number' && typeof y === 'number') return compareQuantities(a, b) === 'same';
  if (typeof x === 'boolean' && typeof y === 'boolean') return x === y;
  const cx = constantOf(a);
  const cy = constantOf(b);
  return cx !== undefined && cy !== undefined && compareConstants(cx, cy) === 'same';
}

/**
 * Where an end of a binding written in `holder` is, for {@link heldDefaults}:
 *  - `below` the holder, at a path every context of it reads (`p.load` in `part
 *    q : Q { bind p.load = L; }`);
 *  - `global`: a feature of no definition — a package's, or a feature of one
 *    of its usages — one instance wherever it is read (a package's `attribute G
 *    = 2.0 * K` beside `part def Q { bind p.load = G; }`);
 *  - `enclosed` by an instance the holder is a feature of: the nearest owner
 *    of the holder the end is a feature of, through usages alone — R for R's
 *    `L` above — with the path below it, and the contexts that are such an
 *    instance (`within`: the owner and what specialises it);
 *  - `nowhere` this tool finds an instance of it.
 */
type EndPlace =
  | { kind: 'below'; path: string }
  | { kind: 'global' }
  | { kind: 'enclosed'; path: string; within: ReadonlySet<ElementId> }
  | { kind: 'nowhere' };

function endPlace(model: Model, end: ElementId, holder: ElementRecord): EndPlace {
  const below = bindingEndPath(model, end, holder.id);
  if (below !== undefined) return { kind: 'below', path: below };
  const seen = new Set<ElementId>();
  for (let cur = model.get(end); cur && !seen.has(cur.id); ) {
    seen.add(cur.id);
    const owner = cur.ownerId != null ? model.get(cur.ownerId) : undefined;
    if (!owner || isDefinition(owner.eClass)) break;
    if (!isUsage(owner.eClass)) return { kind: 'global' };
    cur = owner;
  }
  const definitions = sharedDefinitions(model);
  seen.clear();
  for (let cur = holder.ownerId != null ? model.get(holder.ownerId) : undefined; cur && !seen.has(cur.id); ) {
    seen.add(cur.id);
    if (cur.attrs.isLibrary === true) break;
    const path = instancePathBelow(model, end, cur.id);
    if (path !== undefined) {
      return { kind: 'enclosed', path, within: new Set([cur.id, ...definitions.specialisersOf(cur.id).map((x) => x.id)]) };
    }
    cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined;
  }
  return { kind: 'nowhere' };
}

/**
 * The dotted path of feature `id` below `ownerId` through usages alone — the
 * path an instance of `ownerId` reads it at — or `undefined`.
 */
function instancePathBelow(model: Model, id: ElementId, ownerId: ElementId): string | undefined {
  const segments: string[] = [];
  const seen = new Set<ElementId>();
  for (let cur = model.get(id); cur; cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
    if (cur.id === ownerId) return segments.length > 0 ? segments.join('.') : undefined;
    if (seen.has(cur.id) || !isUsage(cur.eClass)) return undefined;
    seen.add(cur.id);
    const name = effectiveNameOf(model, cur);
    if (name === undefined) return undefined;
    segments.unshift(name);
  }
  return undefined;
}

/**
 * How a binding reads what `features` are among, in `contextId` where it
 * holds — the features of the binding component each is in there, one
 * signature per component ({@link heldDefaults}) — or `undefined` where no
 * binding joins any of them in `ownerId`. Q's `bind p.load = L` joins p's load
 * to Q's `L` in Q and to q's `:>> L = 50.0` in `q : Q`: a value Q reads
 * through p's load (`m2 = 10.0 - load`) is another in q, though no name of it
 * is redefined there.
 *
 * Each member is signed with what its value reads where it is read ({@link
 * readsOtherwise}, {@link readSignature}): Q's `L = 2.0 * K` is the same
 * feature in `q : Q { :>> K = 25.0; }`, read there as q's own 50 — so q joins
 * p's load to another value too, and a relation Q reads through it is q's own
 * (`Q::c in q`). `marked: false` signs by feature alone, as this did before
 * values were signed ({@link DefiningEquations.readsBoundOnly}).
 */
export function bindingReadingIn(
  model: Model,
  ownerId: ElementId,
  contextId: ElementId,
  features: ReadonlySet<ElementId>,
  marked = true,
): string | undefined {
  const { readings } = bindingEnds(model);
  const own = readings.get(ownerId);
  if (!own) return undefined;
  const there = readings.get(contextId);
  const { members } = indexOf(model);
  const sign = (root: ElementId, p: string): string =>
    (marked ? markOf(model, root, p) : readings.get(root)?.get(p)?.feature) ?? '';
  const signed = (root: ElementId, component: string): string =>
    [...new Set((members.get(root)?.get(component) ?? []).map((p) => sign(root, p)))].sort().join(',');
  const out: string[] = [];
  for (const [path, r] of own) {
    if (!features.has(r.feature)) continue;
    const x = there?.get(path);
    out.push(`${path}=${x ? signed(contextId, x.component) : signed(ownerId, r.component)}`);
  }
  return out.length > 0 ? out.sort().join(' ') : undefined;
}

/**
 * What the feature `f` at `path` in the context `root` states, for a binding
 * end ({@link heldDefaults}): a value of its own — the nearest value it or a
 * feature it redefines writes, with `=`; or an asserted equation of its owner,
 * or of the context, that defines it — a `default`, with the feature that
 * writes it, or nothing.
 */
function endValue(model: Model, f: ElementRecord, root: ElementRecord, path: string): EndValue {
  for (const g of [f, ...redefinedClosure(model, f)]) {
    if (g.attrs.value === undefined || g.attrs.value === null) continue;
    return g.attrs.defaultValue === true ? { kind: 'default', source: g } : { kind: 'value' };
  }
  const defines = (ownerId: ElementId | null, n: string | undefined): boolean =>
    n !== undefined && ownerId != null && model.children(ownerId).some((c) => isAsserted(c) && namesDefinedBy(c).includes(n));
  // No value of its own: an asserted equation that defines the feature — its
  // own, or one it redefines, an assert inherited from a general definition
  // through the copy's redefinition closure (the G340 family, `assert-min`) —
  // is a stated value, so a `default` in the component gives way to it.
  if ([f, ...redefinedClosure(model, f)].some((g) => defines(g.ownerId, effectiveNameOf(model, g)))) {
    return { kind: 'value' };
  }
  return defines(root.id, path) ? { kind: 'value' } : { kind: 'none' };
}

/**
 * Does a binding override `f`'s `default` — is `f` written `attribute load
 * default = 1.0`, and held by a binding ({@link heldDefaults})? The default
 * gives way to the binding exactly as to a redefinition: the feature reads the
 * value the binding gives it — on every surface — and no surface reads the
 * default (`bind load = L` with `L` set to 50 in `q` is q's load of 50, never
 * the 1.0 that, read beside the binding, made the model contradict itself in
 * q). A value written with `=` is a binding of its own and gives way to
 * nothing: against another binding it is a contradiction (strict KerML). A
 * redefinition that states nothing over a default — the implicit
 * connector-end copy `bind p.load = L` creates of P's `load` — reads no
 * default either ({@link DefiningEquations.carrier}).
 */
export function defaultGivesWay(model: Model, f: ElementRecord): boolean {
  return f.attrs.defaultValue === true && bindingEnds(model).held.has(f.id);
}

/**
 * Does a feature `f` read nothing of `g`, the feature it redefines that states
 * a value — a `default` a binding holding `f` overrides ({@link heldDefaults})?
 */
function boundOverDefault(model: Model, f: ElementRecord, g: ElementRecord): boolean {
  return g.attrs.defaultValue === true && bindingEnds(model).held.has(f.id);
}

/*
 * THE INSTANCE INDEX (plan per-instance-check, step F3). One shared index over
 * the bindings a model states, used by the per-instance readings of the check
 * (F5) and the per-instance rows of the obligations lane (F7). F3 builds the
 * index and its tests; no consumer reads it yet, so a model's `held`/`readings`
 * are byte-identical and no verdict moves.
 *
 *  - {@link bindingFrames}: the contexts a definition (or a usage at the top of
 *    a usage chain) is read in, as {@link heldDefaults} walks them.
 *  - {@link classified}: what a binding component's members state in one frame
 *    root — a value, a readable `default`, or a `default` the binding holds.
 *  - {@link boundSourceIn}: the outermost frame root a name's instance reads a
 *    binding through, and which member there gives its value (A.2).
 *  - {@link instancesOfDefinition} / {@link instancesOfUsage}: the instances
 *    of a definition, frames ∪ `denote` over every user package.
 *  - {@link instanceGroups}: the groups a relation is read per instance in,
 *    expanded all-or-nothing past the caps (A.7).
 *  - {@link rebaseInstance}, {@link enclosingAssertOn}: the helpers A.2 threads
 *    an instance through a reading with.
 */

/** Why a per-instance reading abstains (A.9). */
export type InstanceAbstention =
  | 'free'
  | 'defaults-differ'
  | 'held-elsewhere'
  | 'two-values'
  | 'enclosing-assert'
  | 'past-cap'
  | 'not-enumerated'
  | 'internal';

/** One context a definition is read in, with the dotted path to it from that context's root ({@link bindingFrames}). */
export interface BindingFrame {
  root: ElementRecord;
  prefix: string;
}

/** What a binding component's members state, classified by path ({@link classified}). */
export interface ComponentClass {
  /** Members that state a value — `=`, or an asserted equation. */
  valued: string[];
  /** Members whose `default` stands — not held by the binding. */
  readable: string[];
  /** Members whose `default` gives way to the binding. */
  heldDefaults: string[];
}

/**
 * The source of a name's value read through a binding ({@link boundSourceIn}):
 * the frame root it is read in, the member paths the component joins there,
 * the component, and — where one member supplies the value — which binding
 * connectors join it and which path is the source. Or the abstention, with its
 * sentence (A.9).
 */
export type BoundSource =
  | {
      root: ElementId;
      paths: string[];
      component: string;
      via: { bindingIds: ElementId[]; source: string };
    }
  | { abstain: InstanceAbstention; sentence: string };

/** One group a relation is read per instance in ({@link instanceGroups}): (relation, shared usage). */
export interface InstanceGroup {
  relationId: ElementId;
  usageId: ElementId;
  definitionId: ElementId;
  /** The instances the usage is read in, its own (generic) first. */
  instances: string[];
  /** Whether the group was expanded — every instance read — or kept as today's single refusal. */
  expanded: boolean;
  refusal?: { kind: InstanceAbstention; sentence: string };
  /**
   * The instances of an expanded group its rows do NOT read (A.7's coverage
   * guard), each with the kind and the sentence every surface abstains on it
   * with ({@link instanceReadsOtherwise}): one whose own element cannot be
   * read for it (`not-enumerated`), or that an enclosing assert constrains
   * (`enclosing-assert`). Absent where there is none.
   */
  otherwise?: ReadonlyMap<string, { kind: InstanceAbstention; sentence: string }>;
  /**
   * The instances of an expanded group read in an element of their OWN, by
   * that element's id: an instance whose most specific element reads a name of
   * the relation — or a name its value reads — through another feature than
   * the usage does (a redefinition with a value of its own, a specialised
   * type, a nested override; {@link instanceReadsOtherwise}) is read there, at
   * the instance, never through the usage's features. Absent where there is
   * none.
   */
  readIn?: ReadonlyMap<string, ElementId>;
  /**
   * The instances of an expanded group that are an element's own instance,
   * by that element's id — an element other than the usage (q2's `part :>> p
   * { … }` is q2's p; Q2's `part :>> p : P2` is Q2's p): the group's row for
   * the instance IS the relation read in that element, so the element is no
   * context of the relation's own — no other row reads it there, and the
   * instance is filed once under its name. Absent where there is none.
   */
  standsFor?: ReadonlyMap<string, ElementId>;
}

/** Past this many instances of one usage, its group is not expanded (A.7, E). */
export const MAX_INSTANCE_READS = 4096;

/** Past this many instance readings in one sweep, later groups are not expanded (A.7, E). */
export const MAX_INSTANCE_RELATIONS = 16384;

/** Past this many instance goal rows in one verify run, a group keeps its single refusal (A.7, E). */
export const MAX_INSTANCE_GOALS = 256;

/** Past this many paths of what a relation reads, the coverage guard compares no further and abstains (A.7). */
const MAX_GUARD_PATHS = 256;

/**
 * The contexts a definition (or a usage at the top of a usage chain) is read
 * in, as {@link heldDefaults} walks them: itself, then every context that
 * specialises it, and — where it is a usage — the contexts above it, climbing
 * from a usage to its owner up to the outermost non-library owner, packages
 * included. Each frame is a context `root` and the dotted `prefix` of the path
 * from that root to the definition's instance. `truncated` is set past
 * {@link MAX_BINDING_FRAMES} contexts, or a context deeper than
 * {@link MAX_BINDING_SEGMENTS} usages left out.
 *
 * The walk is the one {@link heldDefaults} takes, extracted so the per-instance
 * index and the held-default reading share it; {@link heldDefaults} keeps its
 * own copy because its frames carry an `outer` the index does not need.
 */
export function bindingFrames(
  definitions: DefiningEquations,
  holder: ElementRecord,
): { frames: BindingFrame[]; truncated: boolean } {
  const model = definitions.model;
  const frames: BindingFrame[] = [{ root: holder, prefix: '' }];
  const index = new Map<string, number>([[`${holder.id} `, 0]]);
  let truncated = false;
  for (let i = 0; i < frames.length && frames.length <= MAX_BINDING_FRAMES; i++) {
    const { root, prefix } = frames[i]!;
    const succ: BindingFrame[] = definitions.specialisersOf(root.id).map((z) => ({ root: z, prefix }));
    const name = isUsage(root.eClass) ? definitions.nameOf(root) : undefined;
    const owner = root.ownerId != null ? model.get(root.ownerId) : undefined;
    if (name !== undefined && owner && owner.attrs.isLibrary !== true) {
      succ.push({ root: owner, prefix: prefix === '' ? name : `${name}.${prefix}` });
    }
    for (const f of succ) {
      const key = `${f.root.id} ${f.prefix}`;
      if (index.has(key)) continue;
      if (f.prefix.split('.').length > MAX_BINDING_SEGMENTS) {
        truncated = true;
        continue;
      }
      index.set(key, frames.length);
      frames.push(f);
    }
  }
  if (frames.length > MAX_BINDING_FRAMES) truncated = true;
  return { frames, truncated };
}

/**
 * Re-root an instance spelling: the instance `symbol`, read as rooted at
 * `contextId`'s own instance, read instead where the instance is `instance`
 * (A.2.1). The Denotation the fallback reads is rooted at the row's context;
 * this re-roots it to the instance the reading is for.
 */
export function rebaseInstance(
  definitions: DefiningEquations,
  contextId: ElementId,
  instance: string,
  symbol: string,
): string {
  const from = definitions.instanceNameOf(contextId);
  if (symbol === from) return instance;
  return symbol.startsWith(`${from}::`) ? `${instance}${symbol.slice(from.length)}` : symbol;
}

/**
 * What the members of a binding component state, classified by path (A.3):
 * `valued` (a value of its own), `readable` (a `default` the binding does not
 * hold), and `heldDefaults` (a `default` it holds, {@link heldDefaults}).
 */
export function classified(model: Model, root: ElementId, component: string): ComponentClass {
  const { readings, held } = bindingEnds(model);
  const valued: string[] = [];
  const readable: string[] = [];
  const heldDefaults: string[] = [];
  const reading = readings.get(root);
  const rootEl = model.get(root);
  if (!reading || !rootEl) return { valued, readable, heldDefaults };
  for (const [path, r] of reading) {
    if (r.component !== component) continue;
    const f = model.get(r.feature);
    if (!f) continue;
    const v = endValue(model, f, rootEl, path);
    if (v.kind === 'value') valued.push(path);
    else if (v.kind === 'default') (held.has(f.id) ? heldDefaults : readable).push(path);
  }
  return { valued, readable, heldDefaults };
}

/** Every member path of `component` read in `root`. */
function componentPaths(model: Model, root: ElementId, component: string): string[] {
  const reading = bindingEnds(model).readings.get(root);
  if (!reading) return [];
  return [...reading].filter(([, r]) => r.component === component).map(([path]) => path);
}

/**
 * The binding connectors that join the component read in `root` — the
 * connectors whose two ends are the features the component's members read,
 * each member matched through what it redefines (an implicit connector-end
 * copy of the end). Best-effort: the per-instance reading (F5) is what
 * consumes this, and it reads the member it names rather than these ids.
 */
function componentConnectors(model: Model, root: ElementId, component: string): ElementRecord[] {
  const reading = bindingEnds(model).readings.get(root);
  if (!reading) return [];
  const origins = new Set<ElementId>();
  for (const [, r] of reading) {
    if (r.component !== component) continue;
    origins.add(r.feature);
    const f = model.get(r.feature);
    if (f) for (const g of redefinedClosure(model, f)) origins.add(g.id);
  }
  const out: ElementRecord[] = [];
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || el.ownerId == null || !isBindingConnector(el)) continue;
    const [s, t] = [el.source?.[0], el.target?.[0]];
    if (s !== undefined && t !== undefined && origins.has(s) && origins.has(t)) out.push(el);
  }
  return out;
}

/** The instance of the feature the member `path` of `root` names, for {@link boundSourceIn}'s own-path check. */
function memberInstance(definitions: DefiningEquations, root: ElementId, path: string): string | undefined {
  if (path.startsWith('#')) {
    const f = definitions.model.get(path.slice(1));
    return f ? definitions.instanceNameOf(f.id) : undefined;
  }
  const d = definitions.denote(root).get(path);
  if (!d) return undefined;
  return `${d.instance}::${definitions.nameOf(d.feature) ?? ''}`;
}

/** Why a binding component gives no value, in the A.9 sentence. */
function abstentionSentence(
  model: Model,
  symbol: string,
  root: ElementId,
  component: string,
  kind: 'free' | 'defaults-differ' | 'two-values',
): string {
  const sep = symbol.lastIndexOf('::');
  const name = sep >= 0 ? symbol.slice(sep + 2) : symbol;
  const instance = sep >= 0 ? symbol.slice(0, sep) : '';
  const members = componentPaths(model, root, component);
  const connector = componentConnectors(model, root, component)[0];
  const ownerId = connector?.ownerId ?? null;
  const holder = ownerId != null ? effectiveQualifiedName(model, ownerId) : undefined;
  const l = ownerId != null ? bindingEndPath(model, connector!.source?.[0], ownerId) : undefined;
  const r = ownerId != null ? bindingEndPath(model, connector!.target?.[0], ownerId) : undefined;
  const bind = l !== undefined && r !== undefined ? `\`bind ${l} = ${r}\`` : 'a binding';
  const of = holder !== undefined ? ` of ${holder}` : '';
  if (kind === 'two-values') {
    return (
      `${name} is not read in ${instance}: ${bind}${of} joins two values the model states (${members.join(', ')}), ` +
      'and a binding holds in every instance (see the binding\u2019s own finding)'
    );
  }
  if (kind === 'defaults-differ') {
    return (
      `${name} has no value in ${instance}: ${bind}${of} joins defaults that differ or are not constants ` +
      `(${members.join(', ')}), and the model states neither`
    );
  }
  return `${name} has no value in ${instance}: ${bind}${of} joins it to ${members.join(', ')}, and none of them states one`;
}

/**
 * The source of the value a name read at the instance `symbol` gets through a
 * binding (A.2.2): the OUTERMOST frame root whose generic instance prefixes
 * `symbol` and whose readings hold the rest of the path, its component
 * classified ({@link classified}) and resolved as A.3 does — one valued member
 * (read, unless it is the name's own path), else one readable `default`, else
 * `two-values`, `defaults-differ` or `free`. `undefined` where no binding
 * holds `symbol`.
 */
export function boundSourceIn(model: Model, symbol: string): BoundSource | undefined {
  if (!hasUserBindings(model)) return undefined;
  const definitions = sharedDefinitions(model);
  const { readings } = bindingEnds(model);
  let best: { root: ElementId; component: string; feature: ElementId } | undefined;
  let bestSegments = Number.POSITIVE_INFINITY;
  for (const [root, reading] of readings) {
    const inst = definitions.instanceNameOf(root);
    if (symbol !== inst && !symbol.startsWith(`${inst}::`)) continue;
    const rest = symbol === inst ? '' : symbol.slice(inst.length + 2);
    const r = reading.get(rest.split('::').join('.'));
    if (!r) continue;
    const segments = inst.split('::').length;
    if (best === undefined || segments < bestSegments) {
      best = { root, component: r.component, feature: r.feature };
      bestSegments = segments;
    }
  }
  if (!best) return undefined;
  // A name defined by an asserted equation in a general definition — the G340
  // family, where the binding's implicit end copy masks the assert: the value
  // is the equation's, not the binding's, and no per-instance value is read
  // here (today's reading abstains).
  const member = model.get(best.feature);
  if (
    member &&
    [member, ...redefinedClosure(model, member)].some(
      (g) => definitions.of(g.ownerId ?? best.root, definitions.nameOf(g) ?? '').length > 0,
    )
  ) {
    return undefined;
  }
  // A binding read nowhere this tool finds an instance of one of its ends
  // ({@link BindingEnds.unread}) reads no value per instance (A.3).
  const { unread, overCap } = bindingEnds(model);
  const carried = member ? definitions.carrier(best.root, member).id : undefined;
  if (member && (unread.has(member.id) || (carried !== undefined && unread.has(carried)))) return undefined;
  // Past a cap for THIS binding (A.3), no bound value is read for any one
  // instance: the frame that carries the value may be one the cap dropped.
  // Another binding's cap never abstains this read.
  const capped = member ? (overCap.get(member.id) ?? (carried !== undefined ? overCap.get(carried) : undefined)) : undefined;
  if (capped !== undefined) return { abstain: 'past-cap', sentence: bindingCapSentence(capped) };
  // A binding whose end is a feature of an instance ENCLOSING where it is
  // written (R's `L` in `part q : Q { bind p.load = L; }`) is read by that
  // feature's own id, for every such instance alike ({@link
  // BindingEnds.enclosed}) — not per instance. No per-instance value is read
  // here (A.3's F1 conditions; encl-W1/W3/W5 stay abstaining).
  const { readings: rds, enclosed } = bindingEnds(model);
  if ([...componentPaths(model, best.root, best.component)].some((p) => enclosed.has(rds.get(best.root)?.get(p)?.feature ?? ('' as ElementId)))) {
    return undefined;
  }
  const cls = classified(model, best.root, best.component);
  const source = (valuePath: string): BoundSource => ({
    root: best!.root,
    paths: componentPaths(model, best!.root, best!.component),
    component: best!.component,
    via: { bindingIds: componentConnectors(model, best!.root, best!.component).map((c) => c.id), source: valuePath },
  });
  if (cls.valued.length > 1) {
    return { abstain: 'two-values', sentence: abstentionSentence(model, symbol, best.root, best.component, 'two-values') };
  }
  if (cls.valued.length === 1) {
    // The member that states the value IS the name's own path: today's reading
    // already answers it, and the fallback adds nothing.
    if (memberInstance(definitions, best.root, cls.valued[0]!) === symbol) return undefined;
    return source(cls.valued[0]!);
  }
  // A readable default: the one that is not the name's own path (a binding
  // INTO a feature with nothing of its own carries the source's default, K's
  // `bind w = x` over `x default = 5.0`). The name's own default is no value
  // the binding gives it — the partner supplies none either (the G340 family).
  const readable = cls.readable.find((p) => memberInstance(definitions, best.root, p) !== symbol);
  if (readable !== undefined) return source(readable);
  if (cls.heldDefaults.length > 0) {
    return {
      abstain: 'defaults-differ',
      sentence: abstentionSentence(model, symbol, best.root, best.component, 'defaults-differ'),
    };
  }
  return { abstain: 'free', sentence: abstentionSentence(model, symbol, best.root, best.component, 'free') };
}

/**
 * The member of the component at `root` whose `default` STANDS for the
 * instance that root's reading serves (F8, A.4 Part 2) — its path and the
 * feature that writes it — or `undefined`. A `default` a binding holds only
 * per FEATURE ({@link heldDefaults}) gives way where the bindings joined to it
 * reach a value of its own; in an instance whose outermost component states
 * none, and whose every default is a literal agreeing exactly, it stands there
 * (P's `load default = 5.0` beside Q's `bind p.load = L`: q1 sets L, q2 leaves
 * it, and q2's load is 5.0). A component with a stated member has a value the
 * binding gives; a default that reads a name, or two that do not compare the
 * same exactly, may be another value in each instance and gives way.
 */
function standingDefaultPath(
  model: Model,
  root: ElementId,
  component: string,
): { path: string; source: ElementRecord } | undefined {
  const { readings } = bindingEnds(model);
  const rootEl = model.get(root);
  const reading = readings.get(root);
  if (!rootEl || !reading) return undefined;
  const definitions = sharedDefinitions(model);
  // A member DEFINED by an asserted equation — its own, or one inherited from
  // a general definition, which {@link endValue} does not see — is a stated
  // value: the default does not stand (the open default-vs-assert semantics,
  // H5). `equationsByName` is direct, so the generalisations are walked.
  const asserted = (ownerId: ElementId | null | undefined, name: string | undefined): boolean => {
    if (name === undefined || ownerId == null) return false;
    for (const o of [model.get(ownerId), ...generalizationsOf(model, ownerId)]) {
      if (o && definitions.of(o.id, name).length > 0) return true;
    }
    return false;
  };
  let first: { path: string; source: ElementRecord } | undefined;
  for (const [path, r] of reading) {
    if (r.component !== component) continue;
    const f = model.get(r.feature);
    if (!f) continue;
    const name = effectiveNameOf(model, f);
    if (asserted(f.ownerId, name) || asserted(root, path)) return undefined;
    const v = endValue(model, f, rootEl, path);
    if (v.kind === 'value') return undefined;
    if (v.kind !== 'default') continue;
    const literal = v.source.attrs.value;
    if (typeof literal !== 'number' && typeof literal !== 'boolean') return undefined;
    if (first === undefined) {
      first = { path, source: v.source };
      continue;
    }
    if (!sameConstant(first.source, v.source)) return undefined;
  }
  return first;
}

/**
 * The feature whose `default` STANDS for the name read at the instance
 * `symbol` (F8, A.4 Part 2) — the default a binding holds per feature but
 * which this instance's outermost component reads as its value — or
 * `undefined`. `symbol` is the spelling {@link boundSourceIn} reads
 * (`W2::q2::p::load`). Past a binding cap, or where an end has no instance,
 * no bound value is read for any one instance ({@link defaultGivesWay} stays
 * the per-feature answer). The solver and the SMT lane read this to give the
 * instance the literal value the check reads there.
 */
export function defaultStandsIn(model: Model, symbol: string): ElementRecord | undefined {
  if (!hasUserBindings(model)) return undefined;
  const definitions = sharedDefinitions(model);
  const { readings } = bindingEnds(model);
  let best: { root: ElementId; component: string; feature: ElementId } | undefined;
  let bestSegments = Number.POSITIVE_INFINITY;
  for (const [root, reading] of readings) {
    const inst = definitions.instanceNameOf(root);
    if (symbol !== inst && !symbol.startsWith(`${inst}::`)) continue;
    const rest = symbol === inst ? '' : symbol.slice(inst.length + 2);
    const r = reading.get(rest.split('::').join('.'));
    if (!r) continue;
    const segments = inst.split('::').length;
    if (best === undefined || segments < bestSegments) {
      best = { root, component: r.component, feature: r.feature };
      bestSegments = segments;
    }
  }
  if (!best) return undefined;
  const member = model.get(best.feature);
  const { unread, overCap } = bindingEnds(model);
  const carried = member ? definitions.carrier(best.root, member).id : undefined;
  if (
    member &&
    (unread.has(member.id) ||
      (carried !== undefined && unread.has(carried)) ||
      overCap.get(member.id) !== undefined ||
      (carried !== undefined && overCap.get(carried) !== undefined))
  ) {
    return undefined;
  }
  return standingDefaultPath(model, best.root, best.component)?.source;
}

/** The user packages of a model — `package` elements, nested ones included. */
function userPackages(model: Model): ElementRecord[] {
  return model.all().filter((e) => e.eClass === 'Package' && e.attrs.isLibrary !== true);
}

/**
 * The instances of a definition — or of a usage at the top of a usage chain —
 * in reading order, its own (generic) instance first: every frame of
 * {@link bindingFrames} spelled through the {@link DefiningEquations.denote}
 * walk, unioned with the `denote` entries of every user package that reach it
 * or a specialiser, deduplicated by string. The union guards against a frame
 * spelling gap (R14b/c/d), so an instance the full `denote` walk finds is
 * never dropped because a frame failed to spell it.
 */
export function instancesOfDefinition(definitions: DefiningEquations, definition: ElementRecord): string[] {
  return [...instanceSitesOf(definitions, definition).sites.keys()];
}

/** {@link instancesOfDefinition}, for a shared usage: a usage is its own definition at the top of a usage chain. */
export function instancesOfUsage(definitions: DefiningEquations, usage: ElementRecord): string[] {
  return instancesOfDefinition(definitions, usage);
}

/**
 * Where an instance is spelled ({@link instanceSitesOf}): a context `root`
 * and the dotted `path` the {@link DefiningEquations.denote} walk takes from
 * it to the instance — `''` for the root itself.
 */
interface InstanceSite {
  root: ElementId;
  path: string;
}

/**
 * {@link instancesOfDefinition}, in the same order, with every site each
 * instance is spelled at — the places the coverage guard reads it from
 * ({@link instanceReadsOtherwise}) — and whether {@link bindingFrames} was
 * truncated. A package's `denote` entry is a site only under the path the
 * walk takes to it: under an alias, or a nested bare name, it names the
 * instance but no path below it.
 */
function instanceSitesOf(
  definitions: DefiningEquations,
  definition: ElementRecord,
): { sites: Map<string, InstanceSite[]>; truncated: boolean } {
  const sites = new Map<string, InstanceSite[]>();
  const add = (s: string, site?: InstanceSite): void => {
    let list = sites.get(s);
    if (!list) {
      list = [];
      sites.set(s, list);
    }
    if (site) list.push(site);
  };
  const { frames, truncated } = bindingFrames(definitions, definition);
  for (const { root, prefix } of frames) {
    if (prefix === '') {
      add(definitions.instanceNameOf(root.id), { root: root.id, path: '' });
      continue;
    }
    const d = definitions.denote(root.id).get(prefix);
    if (d) add(`${d.instance}::${definitions.nameOf(d.feature) ?? ''}`, { root: root.id, path: prefix });
  }
  for (const pkg of userPackages(definitions.model)) {
    for (const [path, d] of definitions.denote(pkg.id)) {
      if (d.feature.id === definition.id || definitions.specialisersOf(definition.id).some((s) => s.id === d.feature.id)) {
        const name = definitions.nameOf(d.feature) ?? '';
        const walked = path.slice(path.lastIndexOf('.') + 1) === name && (path.includes('.') || d.reader === pkg.id);
        add(`${d.instance}::${name}`, walked ? { root: pkg.id, path } : undefined);
      }
    }
  }
  return { sites, truncated };
}

/**
 * What a relation reads in one context ({@link readFeatures}). `paths`: by
 * dotted path below the context, a signature of what each path reads.
 * `crossings`: each prefix of a read path that stands for what a reference's
 * — or a bound subject's — value names (`r` of `r.x` over `ref part :>> r =
 * s`), a value the {@link DefiningEquations.denote} walk resolves once, where
 * it is written ({@link DefiningEquations.subjectScope}). `bound`: the first
 * prefix — the context itself (`''`) included — that a binding connector
 * touches, or that redefines one it touches: a part bound to another, whose
 * features every reading reads as its type's (`bind p.r = s` joins p's `r` to
 * Q's `s`, and `r.x` read R's own x); {@link boundSourceIn} carries a value
 * bound to a read feature, never the identity of a bound part.
 */
interface GuardReading {
  paths: Map<string, { signature: string; assertedDefault?: string }>;
  crossings: Array<{ path: string; reader: ElementId; feature: ElementRecord }>;
  bound?: { path: string; prefix: string };
}

/**
 * What `names` read in the context `contextId` ({@link GuardReading}): each
 * name, and every name the value of what it denotes reads — its stated value,
 * the value it redefines ({@link DefiningEquations.carrier}), the asserted
 * equations that define it where it is read and where it is written —
 * transitively, each resolved below the instance it is read in, as the
 * {@link DefiningEquations.denote} walk resolves it. Each path's signature is
 * the feature it denotes, the one whose value that is, the asserts that
 * define it (`''` where it denotes nothing) and — below a prefix — the
 * feature it is read through, the instance it is read in where that is
 * spelled outside the context (through a reference to `rb`, `rb::x`), and
 * whether two values inherited under its name collide where it is read
 * ({@link DefiningEquations.clash}: it then reads neither). A
 * binding partner is not followed: the per-instance reading reads it in the
 * binding's own frame ({@link boundSourceIn}). `undefined` past
 * {@link MAX_GUARD_PATHS} paths.
 */
function readFeatures(
  definitions: DefiningEquations,
  contextId: ElementId,
  names: readonly string[],
): GuardReading | undefined {
  const model = definitions.model;
  const denoted = definitions.denote(contextId);
  const root = definitions.instanceNameOf(contextId);
  const ends = bindingEndsOf(model);
  const isBound = (f: ElementRecord): boolean =>
    ends.has(f.id) || redefinedClosure(model, f).some((g) => ends.has(g.id));
  const paths: GuardReading['paths'] = new Map();
  const crossings: GuardReading['crossings'] = [];
  const crossed = new Set<string>();
  const context = model.get(contextId);
  let bound: GuardReading['bound'] = context && isBound(context) ? { path: names[0] ?? '', prefix: '' } : undefined;
  const queue = [...names];
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i]!;
    if (paths.has(path)) continue;
    if (paths.size >= MAX_GUARD_PATHS) return undefined;
    // What the path is read through: a part a binding joins to another, and a
    // reference whose value stands for another feature.
    const segments = path.split('.');
    for (let k = 1; k < segments.length; k++) {
      const prefix = segments.slice(0, k).join('.');
      const p = denoted.get(prefix);
      if (!p) continue;
      if (bound === undefined && isBound(p.feature)) bound = { path, prefix };
      if (!crossed.has(prefix) && definitions.subjectOf(p.reader, p.feature) !== undefined) {
        crossed.add(prefix);
        crossings.push({ path: prefix, reader: p.reader, feature: p.feature });
      }
    }
    const d = denoted.get(path);
    if (!d) {
      paths.set(path, { signature: '' });
      continue;
    }
    const target = definitions.carrier(d.reader, d.feature);
    const name = definitions.nameOf(target);
    const asserts: DefiningEquation[] = [];
    if (name !== undefined) {
      for (const site of new Set([d.reader, target.ownerId, d.feature.ownerId])) {
        if (site != null) asserts.push(...definitions.of(site, name));
      }
    }
    // The instance the feature is read in, below the context: where the names
    // its value reads are read. One the walk reaches through a bound subject
    // is spelled elsewhere: that instance is compared, and its reads are not
    // followed.
    const at =
      d.instance === root
        ? ''
        : d.instance.startsWith(`${root}::`)
          ? d.instance.slice(root.length + 2).split('::').join('.')
          : undefined;
    const signature = [
      d.feature.id,
      target === d.feature ? '' : target.id,
      asserts.map((eq) => eq.constraint.id).sort().join(','),
      segments.length > 1 ? d.reader : '',
      at === undefined ? d.instance : '',
      definitions.clash(d.reader, d.feature) !== undefined ? 'clash' : '',
    ].join(' ');
    // A `default` an asserted equation constrains (H5): the asserts, by id.
    const defaulted = [d.feature, target].some((f) => f.attrs.defaultValue === true);
    paths.set(path, {
      signature,
      ...(defaulted && asserts.length > 0
        ? { assertedDefault: asserts.map((eq) => eq.constraint.id).sort().join(',') }
        : {}),
    });
    if (at === undefined) continue;
    const reads: string[] = [];
    for (const f of new Set([d.feature, target])) {
      const v = definitions.statedValue(f);
      if (typeof v === 'string') reads.push(...namesOfValue(v));
    }
    for (const eq of asserts) reads.push(...refsIn(eq.definition, eq.literals));
    for (const n of reads) queue.push(at === '' ? n : `${at}.${n}`);
  }
  return { paths, crossings, ...(bound ? { bound } : {}) };
}

/**
 * The features a dotted `path` passes through, read in `contextId` as
 * {@link DefiningEquations.chain} reads it; `undefined` where it does not
 * resolve, or passes through a reference.
 */
function featuresAlong(definitions: DefiningEquations, contextId: ElementId, path: string): ElementRecord[] | undefined {
  const out: ElementRecord[] = [];
  let owner = contextId;
  for (const segment of path.split('.')) {
    if (out.length > 0 && definitions.subjectOf(owner, out[out.length - 1]!) !== undefined) return undefined;
    if (out.length > 0) owner = out[out.length - 1]!.id;
    const f = definitions.byName(owner).get(segment);
    if (!f) return undefined;
    out.push(f);
  }
  return out;
}

/** Is `e` — or a feature it redefines — `t`, or of a type that is or specialises `t`? */
function standsAs(model: Model, e: ElementRecord, t: ElementRecord): boolean {
  return [e, ...redefinedClosure(model, e)].some(
    (x) => x.id === t.id || generalizationsOf(model, x.id).some((g) => g.id === t.id),
  );
}

/**
 * Whether a reference the reading crosses ({@link GuardReading}) stands for
 * the same feature at an instance as where its value is written: the value's
 * path is resolved once, in the namespace it is written in or encloses it —
 * Q's `s` for `ref part :>> r = s` written in Q's p — and an instance of Q
 * reads it in ITS `s` (q2's `part :>> s { … }`, Q2's `part :>> s : R2`). The
 * namespace that plays that part at the instance is the innermost of the
 * features along the crossing's path, the instance's element, the features
 * along the site's path back to its root, and the root's owners, that is or
 * specialises it; the path is read there again. A package is one namespace
 * for every instance. A phrase where the reading differs, a binding reaches
 * into the feature it stands for (its value may then differ per instance),
 * or this tool cannot tell; `undefined` where it is the same.
 */
function crossingReadsOtherwise(
  definitions: DefiningEquations,
  site: InstanceSite,
  element: ElementRecord,
  crossing: GuardReading['crossings'][number],
): string | undefined {
  const model = definitions.model;
  const cannot = `this tool cannot tell what its ${crossing.path} stands for there`;
  const resolved = definitions.subjectScope(crossing.reader, crossing.feature);
  if (resolved?.scope === undefined || resolved.path === undefined) return cannot;
  const scope = model.get(resolved.scope);
  if (!scope) return cannot;
  if (scope.eClass === 'Package' || scope.attrs.isLibrary === true) return undefined;
  const chain: ElementRecord[] = [];
  const below = crossing.path.split('.');
  const denoted = definitions.denote(element.id);
  for (let k = below.length - 1; k >= 1; k--) {
    const d = denoted.get(below.slice(0, k).join('.'));
    if (!d || definitions.subjectOf(d.reader, d.feature) !== undefined) return cannot;
    chain.push(d.feature);
  }
  chain.push(element);
  if (site.path !== '') {
    const steps = site.path.split('.');
    const fromRoot = definitions.denote(site.root);
    for (let k = steps.length - 1; k >= 1; k--) {
      const d = fromRoot.get(steps.slice(0, k).join('.'));
      if (!d || definitions.subjectOf(d.reader, d.feature) !== undefined) return cannot;
      chain.push(d.feature);
    }
  }
  const seen = new Set(chain.map((e) => e.id));
  for (let cur = model.get(site.root); cur; cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    chain.push(cur);
  }
  const at = chain.find((e) => standsAs(model, e, scope));
  if (!at) return cannot;
  const its = featuresAlong(definitions, scope.id, resolved.path);
  const mine = featuresAlong(definitions, at.id, resolved.path);
  const named = (f: ElementRecord | undefined) => (f ? definitions.qualifiedNameOf(f.id) : 'nothing this tool resolves');
  if (!its || !mine || its.length !== mine.length || its.some((f, k) => f !== mine[k])) {
    return `its ${crossing.path} there stands for ${named(mine?.[mine.length - 1])}, not ${named(resolved.feature)}`;
  }
  const head = its[0]!;
  for (const id of bindingEndsOf(model)) {
    for (let e = model.get(id); e; e = e.ownerId != null ? model.get(e.ownerId) : undefined) {
      if (e.id === head.id) {
        return `its ${crossing.path} stands for ${named(resolved.feature)} of that instance, which a binding reaches into`;
      }
    }
  }
  return undefined;
}

/**
 * The features `ownerId` inherits under `name` from two general types or
 * more, none redefining another — a diamond: `part def Q3 :> Q2, Q4` over
 * Q2's `part :>> p : P2` and Q4's `part :>> p : P4`, both of Q's `p`; a usage
 * typed by both, `part q3 : Q2, Q4` — unless a feature `ownerId` declares
 * under the name redefines every one of them. `undefined` where there is no
 * such pair. Every instance of `ownerId` is an instance of each, so its `p`
 * is P2's and P4's at once; the {@link DefiningEquations.denote} walk reads
 * the name through one of them (Q2's), and a feature `ownerId` declares that
 * redefines only Q's `p` (`part :>> p;`) reads neither. `cache` holds the
 * answer per owner and name, for one sweep.
 */
function inheritedTwice(
  model: Model,
  ownerId: ElementId,
  name: string,
  cache: Map<string, readonly ElementRecord[] | undefined>,
): readonly ElementRecord[] | undefined {
  const key = `${ownerId} ${name}`;
  if (cache.has(key)) return cache.get(key);
  const candidates = new Set<ElementRecord>();
  for (const general of generalizationsOf(model, ownerId)) {
    if (general.attrs.isLibrary === true) continue;
    for (const f of ownFeatures(model, general.id)) if (effectiveNameOf(model, f) === name) candidates.add(f);
  }
  let hit: readonly ElementRecord[] | undefined;
  if (candidates.size >= 2) {
    const redefined = new Set<ElementId>();
    for (const f of candidates) for (const g of redefinedClosure(model, f)) redefined.add(g.id);
    const left = [...candidates].filter((f) => !redefined.has(f.id));
    const mine = ownFeatures(model, ownerId).find((f) => effectiveNameOf(model, f) === name);
    const covered = new Set(mine ? redefinedClosure(model, mine).map((g) => g.id) : []);
    if (left.length >= 2 && left.some((f) => !covered.has(f.id))) hit = left;
  }
  cache.set(key, hit);
  return hit;
}

/**
 * The first segment of an instance's path, spelled from a site ({@link
 * instanceSitesOf}), that the element it is read in inherits twice ({@link
 * inheritedTwice}): the element, the name, and the features. Each segment is
 * read in the site's root, then in what the {@link DefiningEquations.denote}
 * walk reaches along the path before it. `undefined` where none is.
 */
function diamondOnPath(
  definitions: DefiningEquations,
  sites: readonly InstanceSite[],
  cache: Map<string, readonly ElementRecord[] | undefined>,
): { owner: ElementRecord; name: string; features: readonly ElementRecord[] } | undefined {
  const model = definitions.model;
  for (const { root, path } of sites) {
    if (path === '') continue;
    const steps = path.split('.');
    const denoted = definitions.denote(root);
    let owner = model.get(root);
    for (let k = 0; k < steps.length && owner !== undefined; k++) {
      const features = inheritedTwice(model, owner.id, steps[k]!, cache);
      if (features !== undefined) return { owner, name: steps[k]!, features };
      const d = denoted.get(steps.slice(0, k + 1).join('.'));
      owner = d ? (definitions.subjectOf(d.reader, d.feature) ?? d.feature) : undefined;
    }
  }
  return undefined;
}

/**
 * The most specific element that denotes an instance: the one the {@link
 * DefiningEquations.denote} walk reaches along the instance's path from each
 * site it is spelled at ({@link instanceSitesOf}) — what a subject or a
 * reference there stands for, else the feature itself — or `undefined` where
 * it is spelled at no site, at sites that reach different elements, or along
 * a path that inherits a name twice ({@link diamondOnPath}): no one element
 * stands for an instance of Q3's p, which is Q2's p and Q4's p at once.
 */
function instanceElementOf(
  definitions: DefiningEquations,
  sites: readonly InstanceSite[],
  cache: Map<string, readonly ElementRecord[] | undefined>,
): ElementRecord | undefined {
  if (diamondOnPath(definitions, sites, cache) !== undefined) return undefined;
  const elements = new Set<ElementRecord | undefined>();
  for (const { root, path } of sites) {
    if (path === '') {
      elements.add(definitions.model.get(root));
      continue;
    }
    const d = definitions.denote(root).get(path);
    elements.add(d ? (definitions.subjectOf(d.reader, d.feature) ?? d.feature) : undefined);
  }
  const [element] = elements;
  return elements.size === 1 ? element : undefined;
}

/**
 * What the coverage guard makes of one instance ({@link instanceReadsOtherwise}):
 * the instance is read in an element of its own, `element` — the most specific
 * element that denotes it — or its row abstains, in `sentence`.
 */
type GuardVerdict = { element: ElementRecord } | { kind: InstanceAbstention; sentence: string };

/**
 * THE COVERAGE GUARD (A.7, `not-enumerated`). A group reads every instance of
 * its shared usage U through U's own features, re-rooted at the instance: a
 * value a binding carries into one instance is read there ({@link
 * boundSourceIn}), and nothing else is. So an instance whose element — the
 * most specific element that denotes it, the one the {@link
 * DefiningEquations.denote} walk reaches along its path from each site it is
 * spelled at ({@link instanceSitesOf}) — reads a name of the relation, or a
 * name such a name's value reads, through ANOTHER feature or source than U
 * does — a redefinition with a value of its own (`part :>> p { attribute :>>
 * extra = 20.0; }`), a specialised type (`part :>> p : P2`), a nested
 * override on its path, a binding written there (its implicit end copy, A4's
 * `bind p.extra = E` in q2), an asserted equation of its own, a reference to
 * another feature (`ref part :>> r = ra`) — is not read through U: read so,
 * it published U's value as its own (A2: `P::c in q2::p` held at P's `extra`
 * of 0 while q2's p states 20). It is read in that element instead, at the
 * instance (`{ element }`): A2's q2's p is read in q2's `part :>> p`, whose
 * extra is 20, and A3's q2's p in Q2's `part :>> p : P2`, at q2's own values
 * — the reading the element's own context row gives where the element is the
 * instance's alone.
 *
 * Its row abstains — `undefined` where it reads every name as U does — where
 * that element cannot be read for it either: an instance spelled at no site,
 * at sites that reach different elements, along a path that inherits a name
 * twice ({@link diamondOnPath}: Q3's p, where `Q3 :> Q2, Q4` and each types
 * its p, is both at once), or whose reading runs past {@link MAX_GUARD_PATHS}
 * paths; one that redefines the relation itself (`constraint :>> c { … }`;
 * its own relation is read in its own row); one read through a part a binding
 * joins to another (`bind p.r = s`); one where a reference the reading
 * crosses stands for another feature than where its value is written ({@link
 * crossingReadsOtherwise}: `r = s` written in Q's p is Q's `s`, and q2's p
 * reads q2's); one whose element states a `default` an asserted equation of
 * its own constrains (H5: which of the two stands is not decided here); and
 * one an asserted relation of an instance ENCLOSING the element constrains
 * ({@link assertAbove}, A.2.4: `enclosing-assert`).
 * `cache` holds {@link readFeatures} per context and relation, for one sweep.
 */
function instanceReadsOtherwise(
  definitions: DefiningEquations,
  relation: ElementRecord,
  usage: ElementRecord,
  instance: string,
  sites: readonly InstanceSite[],
  names: readonly string[],
  cache: Map<string, GuardReading | undefined>,
  twice: Map<string, readonly ElementRecord[] | undefined>,
): GuardVerdict | undefined {
  const model = definitions.model;
  const head = `${effectiveQualifiedName(model, relation.id)} is not read in ${instance}`;
  const named = (f: ElementRecord | undefined) => (f ? definitions.qualifiedNameOf(f.id) : 'nothing this tool resolves');
  const abstain = (sentence: string): GuardVerdict => ({ kind: 'not-enumerated', sentence });
  const diamond = diamondOnPath(definitions, sites, twice);
  if (diamond !== undefined) {
    const features = diamond.features.map((f) => named(f));
    const listed = `${features.slice(0, -1).join(', ')} and ${features[features.length - 1]}`;
    return abstain(
      `${head}: ${definitions.qualifiedNameOf(diamond.owner.id)} inherits ${listed} ` +
        `under the one name \`${diamond.name}\`, ${diamond.features.length === 2 ? 'neither redefining the other' : 'none redefining another'}, ` +
        'so this tool cannot tell which element stands for it there',
    );
  }
  const element = instanceElementOf(definitions, sites, twice);
  if (element === undefined) {
    return abstain(`${head}: this tool cannot tell which element stands for it there`);
  }
  // The relation itself, redefined there: the instance's own relation is read in its own row.
  const relationName = definitions.nameOf(relation);
  if (element.id !== usage.id && relationName !== undefined) {
    const mine = definitions.byName(element.id).get(relationName);
    if (mine !== undefined && mine.id !== relation.id) {
      return abstain(
        `${head}: its ${relationName} there is ${named(mine)}, not ${named(relation)}, and that relation is read in a row of its own`,
      );
    }
  }
  const shared = guardReading(definitions, relation, usage.id, names, cache);
  const own = element.id === usage.id ? shared : guardReading(definitions, relation, element.id, names, cache);
  if (shared === undefined || own === undefined) {
    return abstain(`${head}: what it reads there runs past ${MAX_GUARD_PATHS} names, and this tool compares no further`);
  }
  if (own.bound !== undefined) {
    return abstain(`${head}: ${boundPartPhrase(own.bound, instance)}`);
  }
  let differs = false;
  if (element.id !== usage.id) {
    for (const path of new Set([...shared.paths.keys(), ...own.paths.keys()])) {
      if (shared.paths.get(path)?.signature !== own.paths.get(path)?.signature) {
        differs = true;
        break;
      }
    }
  }
  for (const crossing of own.crossings) {
    for (const site of sites) {
      const why = crossingReadsOtherwise(definitions, site, element, crossing);
      if (why !== undefined) {
        return abstain(`${head}: ${why}, and this tool resolves what a reference stands for only where its value is written`);
      }
    }
  }
  if (!differs) return undefined;
  // A value of the element's own that states a `default` and that an asserted
  // equation the usage does not read constrains (H5B: q2's `part :>> p {
  // assert constraint { extra == 20.0 } }` over P's `extra default = 0.0`):
  // which of the two stands is not decided here (H5), and a reading in the
  // element would read the default.
  for (const [path, mine] of own.paths) {
    if (mine.assertedDefault === undefined || mine.assertedDefault === shared.paths.get(path)?.assertedDefault) continue;
    return abstain(
      `${head}: its ${path} there states a default that an asserted equation of its own constrains, ` +
        'and this tool does not decide per instance which of the two it reads',
    );
  }
  const assert = assertAbove(definitions, sites, element, [...own.paths.keys()]);
  if (assert !== undefined) {
    return {
      kind: 'enclosing-assert',
      sentence:
        `${head}: ${effectiveQualifiedName(model, assert.frame)}'s asserted \`${assert.expr}\` constrains it there, ` +
        'and this tool does not read a value an enclosing assert constrains',
    };
  }
  return { element };
}

/**
 * The first asserted relation of an instance ENCLOSING `element` on an
 * instance's path — the root of a site it is spelled at ({@link
 * instanceSitesOf}), every usage on the path between, and each one's types
 * and the features it redefines, user-written — that references a path
 * `element` reads (`paths`, as {@link readFeatures} lists them), spelled
 * below that instance: q2's `assert constraint { p.load == 5.0 }` over q2's
 * `part :>> p { … }` reading `load`. A.2.4: an enclosing assert constrains
 * the value, and a reading in `element` reads none of it. `undefined` where
 * none does.
 */
function assertAbove(
  definitions: DefiningEquations,
  sites: readonly InstanceSite[],
  element: ElementRecord,
  paths: readonly string[],
): { frame: ElementId; expr: string } | undefined {
  const model = definitions.model;
  for (const site of sites) {
    if (site.path === '') continue;
    const steps = site.path.split('.');
    const denoted = definitions.denote(site.root);
    // The instances above the element, outermost first, each with the path
    // from it down to the element.
    const frames: Array<{ el: ElementRecord; below: string }> = [];
    const root = model.get(site.root);
    if (root) frames.push({ el: root, below: site.path });
    for (let k = 1; k < steps.length; k++) {
      const d = denoted.get(steps.slice(0, k).join('.'));
      if (d) frames.push({ el: definitions.subjectOf(d.reader, d.feature) ?? d.feature, below: steps.slice(k).join('.') });
    }
    for (const { el, below } of frames) {
      if (el.id === element.id) continue;
      const holders = new Set<ElementRecord>();
      for (const h of [el, ...redefinedClosure(model, el)]) {
        holders.add(h);
        for (const g of generalizationsOf(model, h.id)) holders.add(g);
      }
      for (const holder of holders) {
        if (holder.attrs.isLibrary === true) continue;
        for (const child of model.children(holder.id)) {
          if (child.attrs.isLibrary === true || !isAsserted(child)) continue;
          const expr = child.attrs.expression;
          if (typeof expr !== 'string' || expr.trim() === '') continue;
          for (const n of relationNamesOf(expr)) {
            for (const p of paths) {
              const remaining = `${below}.${p}`;
              if (n === remaining || n.startsWith(`${remaining}.`) || remaining.startsWith(`${n}.`)) {
                return { frame: holder.id, expr };
              }
            }
          }
        }
      }
    }
  }
  return undefined;
}

/** {@link readFeatures} of `relation` in `contextId`, once per sweep (`cache`). */
function guardReading(
  definitions: DefiningEquations,
  relation: ElementRecord,
  contextId: ElementId,
  names: readonly string[],
  cache: Map<string, GuardReading | undefined>,
): GuardReading | undefined {
  const key = `${contextId} ${relation.id}`;
  if (!cache.has(key)) cache.set(key, readFeatures(definitions, contextId, names));
  return cache.get(key);
}

/**
 * Why a reading through a bound part ({@link GuardReading}'s `bound`) is no
 * reading: the clause after `{rel} is not read … in {where}: `.
 */
function boundPartPhrase(bound: NonNullable<GuardReading['bound']>, where: string): string {
  const through = bound.prefix === '' ? `${where} itself` : bound.prefix;
  return `it reads ${bound.path} through ${through}, which a binding joins to another feature, and this tool reads no feature through a bound part`;
}

/**
 * The groups a relation is read per instance in, one per (relation, shared
 * usage) — a usage whose reading `boundAbove` reports otherwise. Each group is
 * expanded all-or-nothing (A.7): the frames of its definition are not
 * truncated, it has at most {@link MAX_INSTANCE_READS} instances, and the
 * sweep stays at or under {@link MAX_INSTANCE_RELATIONS}. An unexpanded group
 * keeps today's single refusal, in the cap's sentence. So does a group whose
 * usage reads the relation through a bound part ({@link GuardReading}'s
 * `bound`; `bind p.r = s`): no row of it — its generic row included — reads
 * what the part is bound to (`not-enumerated`). In an expanded group, an
 * instance whose own element reads the relation otherwise than the usage
 * does is read in that element (`readIn`), or — where that element cannot be
 * read for it — not read: the coverage guard ({@link instanceReadsOtherwise})
 * lists it in `otherwise`, and its row abstains on every surface. An instance
 * that is an element's own instance is that element's reading (`standsFor`),
 * and one that a group of a more specific usage lists is that group's: every
 * instance is one row.
 */
export function instanceGroups(model: Model): InstanceGroup[] {
  const definitions = sharedDefinitions(model);
  if (!hasUserBindings(model)) return [];
  const out: InstanceGroup[] = [];
  const read = new Map<string, GuardReading | undefined>();
  const twice = new Map<string, readonly ElementRecord[] | undefined>();
  let budget = MAX_INSTANCE_RELATIONS;
  for (const el of model.ofKind('ConstraintUsage', 'RequirementUsage')) {
    if (el.ownerId == null) continue;
    const expr = el.attrs.expression;
    if (typeof expr !== 'string' || expr.trim() === '') continue;
    const definition = model.get(el.ownerId);
    if (!definition || definition.attrs.isLibrary === true) continue;
    const names = relationNamesOf(expr);
    const usages: ElementRecord[] = [];
    for (const usage of definitions.readingContexts(el, names)) {
      if (isUsage(usage.eClass) && definitions.boundAbove(usage.id, names) !== undefined) usages.push(usage);
    }
    // A relation OWNED by a usage U (R17c/R17, R1-M2): U is itself a group —
    // its own row is U's generic reading, and each other instance gets a row
    // of its own. `readingContexts` never lists the owner, so this is added.
    if (isUsage(definition.eClass) && definitions.boundAbove(definition.id, names) !== undefined) usages.push(definition);
    const mine: InstanceGroup[] = [];
    // The instances on whose path a name is inherited twice, per group
    // ({@link diamondOnPath}): no group of one of the features takes them.
    const diamonds = new Map<InstanceGroup, Set<string>>();
    for (const usage of usages) {
      const { sites, truncated } = instanceSitesOf(definitions, usage);
      const instances = [...sites.keys()];
      const group: InstanceGroup = { relationId: el.id, usageId: usage.id, definitionId: definition.id, instances, expanded: false };
      if (truncated) {
        group.refusal = {
          kind: 'past-cap',
          sentence: `a binding of this model holds in more than ${MAX_BINDING_FRAMES.toLocaleString('en')} contexts`,
        };
      } else if (instances.length > MAX_INSTANCE_READS) {
        group.refusal = {
          kind: 'past-cap',
          sentence: `${effectiveQualifiedName(model, el.id)} is read in more than ${MAX_INSTANCE_READS.toLocaleString('en')} instances of ${definitions.contextName(usage.id)}; this tool reads none of them per instance`,
        };
      } else if (budget - instances.length < 0) {
        group.refusal = {
          kind: 'past-cap',
          sentence: `more than ${MAX_INSTANCE_RELATIONS.toLocaleString('en')} instance readings in this model`,
        };
      } else {
        // The usage's own reading first: through a bound part (or past the
        // guard's budget) no row of the group reads what it stands for.
        const reading = guardReading(definitions, el, usage.id, names, read);
        const where = definitions.contextName(usage.id);
        if (reading === undefined || reading.bound !== undefined) {
          group.refusal = {
            kind: 'not-enumerated',
            sentence: `${effectiveQualifiedName(model, el.id)} is not read per instance in ${where}: ${
              reading === undefined
                ? `what it reads runs past ${MAX_GUARD_PATHS} names, and this tool cannot tell which instance reads it otherwise`
                : boundPartPhrase(reading.bound!, where)
            }`,
          };
        } else {
          group.expanded = true;
          budget -= instances.length;
          const otherwise = new Map<string, { kind: InstanceAbstention; sentence: string }>();
          const readIn = new Map<string, ElementId>();
          const standsFor = new Map<string, ElementId>();
          const crossed = new Set<string>();
          for (const instance of instances.slice(1)) {
            const own = sites.get(instance) ?? [];
            if (diamondOnPath(definitions, own, twice) !== undefined) crossed.add(instance);
            // The element whose own instance this is: the group's row reads the
            // relation there, so that element's context row is this row.
            const element = instanceElementOf(definitions, own, twice);
            if (element !== undefined && element.id !== usage.id && definitions.instanceNameOf(element.id) === instance) {
              standsFor.set(instance, element.id);
            }
            const verdict = instanceReadsOtherwise(definitions, el, usage, instance, own, names, read, twice);
            if (verdict === undefined) continue;
            if ('element' in verdict) readIn.set(instance, verdict.element.id);
            else otherwise.set(instance, verdict);
          }
          if (otherwise.size > 0) group.otherwise = otherwise;
          if (readIn.size > 0) group.readIn = readIn;
          if (standsFor.size > 0) group.standsFor = standsFor;
          if (crossed.size > 0) diamonds.set(group, crossed);
        }
      }
      mine.push(group);
    }
    // A group of a usage that redefines another group's usage (Q2's `part :>>
    // p : P2`, a group of its own where q2 sets Q's L, below Q's p) reads its
    // instances itself — through the more specific usage, each in its own
    // element: the other group files none of them, so each is one row. An
    // instance on whose path a name is inherited twice (Q3's p, Q2's p and
    // Q4's p at once) is no more Q2's than Q4's: the group it is taken from
    // keeps it, and every group of one of the features drops it. One that
    // two groups still list is filed by the first.
    const byUsage = new Map(mine.map((g) => [g.usageId, g] as const));
    const taken = new Map<InstanceGroup, Set<string>>();
    const dropped = (g: InstanceGroup): Set<string> => {
      let set = taken.get(g);
      if (!set) taken.set(g, (set = new Set<string>()));
      return set;
    };
    if (mine.length > 1) {
      for (const h of mine) {
        const hu = model.get(h.usageId);
        for (const x of hu ? redefinedClosure(model, hu) : []) {
          const g = byUsage.get(x.id);
          if (g === undefined || g === h) continue;
          const listed = new Set(g.instances);
          for (const [k, i] of h.instances.entries()) {
            if (k > 0 && diamonds.get(h)?.has(i) === true && listed.has(i)) dropped(h).add(i);
            else dropped(g).add(i);
          }
        }
      }
      const filed = new Set<string>();
      for (const g of mine) {
        for (const [k, i] of g.instances.entries()) {
          if (k === 0 || taken.get(g)?.has(i) === true) continue;
          if (filed.has(i)) dropped(g).add(i);
          else filed.add(i);
        }
      }
    }
    for (const [g, theirs] of taken) {
      g.instances = g.instances.filter((i, k) => k === 0 || !theirs.has(i));
      const keep = <V>(m: ReadonlyMap<string, V> | undefined): Map<string, V> | undefined => {
        const kept = new Map([...(m ?? [])].filter(([i]) => !theirs.has(i)));
        return kept.size > 0 ? kept : undefined;
      };
      const [otherwise, readIn, standsFor] = [keep(g.otherwise), keep(g.readIn), keep(g.standsFor)];
      if (otherwise) g.otherwise = otherwise;
      else delete g.otherwise;
      if (readIn) g.readIn = readIn;
      else delete g.readIn;
      if (standsFor) g.standsFor = standsFor;
      else delete g.standsFor;
    }
    out.push(...mine);
  }
  return out;
}

/**
 * Whether a name read at an instance lies below a frame among `enclosing` whose
 * reader asserts a relation referencing the remaining dotted path — the read
 * then abstains with `enclosing-assert` (A.2.4, R1-S5): the enclosing assert
 * constrains the value, and this tool reads no value an enclosing assert
 * constrains. Each frame is checked against the name as it is spelled below
 * that frame (`q1.p.x` read in R1, q1's `assert { p.x == 50.0 }` references the
 * remaining `p.x`). `{ frame, expr }` names the first such frame and its
 * expression; `undefined` where none does.
 */
export function enclosingAssertOn(
  model: Model,
  contextId: ElementId,
  enclosing: readonly InstanceFrame[],
  name: string,
): { frame: ElementId; expr: string } | undefined {
  const definitions = sharedDefinitions(model);
  const root = definitions.instanceNameOf(contextId);
  const segments = name.split('.');
  for (const frame of enclosing) {
    const reader = model.get(frame.reader);
    if (!reader || reader.attrs.isLibrary === true) continue;
    const rel =
      frame.instance === root
        ? 0
        : frame.instance.startsWith(`${root}::`)
          ? frame.instance.slice(root.length + 2).split('::').length
          : segments.length;
    // The row's own context is read as today (A.2.4); only the frames strictly
    // between it and the instance constrain the read.
    if (rel === 0) continue;
    const remaining = segments.slice(rel).join('.');
    if (remaining === '') continue;
    for (const child of model.children(reader.id)) {
      if (child.attrs.isLibrary === true || !isAsserted(child)) continue;
      const expr = child.attrs.expression;
      if (typeof expr !== 'string' || expr.trim() === '') continue;
      for (const n of relationNamesOf(expr)) {
        if (n === remaining || n.startsWith(`${remaining}.`) || remaining.startsWith(`${n}.`)) {
          return { frame: reader.id, expr };
        }
      }
    }
  }
  return undefined;
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
 * over the context's own names ({@link DefiningEquations.valueRef}).
 */
export function isCalculationValue(model: Model, f: ElementRecord): boolean {
  if (f.eClass !== 'CalculationUsage') return false;
  if (f.attrs.value !== undefined && f.attrs.value !== null) return false;
  return statedValueOf(model, f) !== undefined;
}

/**
 * Does `f` state a value that READS something — an expression over names, or a
 * calculation's body — rather than a literal? Such a value is read where it is
 * written, and in a context that changes what it reads, over that context's
 * names ({@link DefiningEquations.valueRef}).
 */
export function isDerivedValue(model: Model, f: ElementRecord): boolean {
  if (isCalculationValue(model, f)) return true;
  const v = f.attrs.value;
  return typeof v === 'string' && namesOfValue(v).length > 0;
}

/* ─────────────────────── A value written with `=` is a binding ─────────────────────── */

/**
 * How two written values compare ({@link compareWrittenValues}): the same
 * value, two different values, or a pair only an evaluation could compare.
 */
export type WrittenComparison = 'same' | 'differs' | 'undecided';

/**
 * Two values a context inherits under one name ({@link DefiningEquations.clash}):
 * the feature the name keeps and the other one, the features whose written
 * values each reads ({@link valueSourceOf}), and whether the two are bindings
 * that contradict each other — `decided` where two literals differ.
 */
export interface NameClash {
  kept: ElementRecord;
  other: ElementRecord;
  keptValue: ElementRecord;
  otherValue: ElementRecord;
  contradiction: boolean;
  decided: boolean;
}

/** The feature whose written value `f` reads: `f` itself, else the nearest it redefines that states one. */
function valueSourceOf(model: Model, f: ElementRecord): ElementRecord | undefined {
  for (const g of [f, ...redefinedClosure(model, f)]) {
    if (g.attrs.isLibrary === true) return undefined;
    if (g.attrs.value !== undefined && g.attrs.value !== null) return g;
  }
  return undefined;
}

/**
 * `C::load` inherits A::load = 5.0 and B::load = 7.0 … — the one sentence every
 * surface gives a name two inherited values collide under ({@link NameClash}).
 */
export function clashSentence(model: Model, contextId: ElementId, clash: NameClash): string {
  const context = effectiveQualifiedName(model, contextId);
  const name = effectiveNameOf(model, clash.kept) ?? 'the feature';
  const both =
    `${context} inherits ${writtenName(model, clash.keptValue)} = ${writtenValue(clash.keptValue)} and ` +
    `${writtenName(model, clash.otherValue)} = ${writtenValue(clash.otherValue)} under the one name \`${name}\``;
  if (clash.decided) {
    return `${both}, both bindings every instance holds (values written with \`=\`), so the model states both values and neither is read`;
  }
  return `${both}, and which one an instance has is not decided by reading them, so neither is read`;
}

/**
 * A redefinition's value against a BINDING it redefines
 * ({@link contradictedBindingOf}): the binding, and whether the two values are
 * DECIDED to differ — two literal values, compared exactly. Undecided, the
 * two may still meet (`:>> load = 50.0` over `load = 2.0 * k` where the
 * redefinition's context makes k 25): neither is read here, and the
 * verification lane, which carries both, decides.
 */
export interface BindingConflict {
  binding: ElementRecord;
  decided: boolean;
}

/**
 * The BINDING `f`'s own stated value contradicts — the nearest feature `f`
 * overrides ({@link overriddenBy}), transitively, whose value is written with
 * `=` (not `default`) and is not the value `f` states — or `undefined`.
 *
 * KerML reads `attribute load = 1.0` in `part def P` as a binding: every P,
 * in every context, has load 1.0. A usage that redefines it with another
 * value (`part p : P { attribute :>> load = 50.0; }`) states that p's load is
 * 50 AND 1: the model contradicts itself, and no surface may silently read
 * either value as p's. Only `attribute load default = 1.0` is overridable —
 * the redefinition's value replaces a DEFAULT in its own context.
 *
 * The values are compared as VALUES, never as spelled
 * ({@link compareWrittenValues}): `1000.0 [g]` restates `1.0 [kg]`, `10.0-k`
 * restates `10.0 - k`, and neither contradicts anything; `1.0 [g]` against
 * `1.0 [kg]` does. A pair only an evaluation could compare is a conflict
 * that is not `decided`.
 */
export function contradictedBindingOf(model: Model, f: ElementRecord): BindingConflict | undefined {
  const v = f.attrs.value;
  if (v === undefined || v === null) return undefined;
  for (const g of overriddenBy(model, f)) {
    const w = g.attrs.value;
    // The standard library's own values are its modelling, not a design's
    // bindings: a redefinition of one is read as the library means it.
    if (w === undefined || w === null || g.attrs.defaultValue === true || g.attrs.isLibrary === true) continue;
    const compared = compareWrittenValues(f, g);
    if (compared !== 'same') return { binding: g, decided: compared === 'differs' };
  }
  return undefined;
}

/**
 * The features `f` overrides: every feature it redefines, transitively, and
 * every one it masks BY NAME ({@link maskedByName}) — `attribute load = 50.0`
 * written in `part p : P` with no `:>>` over P's `load = 1.0` replaced it all
 * the same, silently, where the strict reading makes it a contradiction.
 */
function overriddenBy(model: Model, f: ElementRecord): ElementRecord[] {
  const masked = maskedByName(model, f);
  const closure = redefinedClosure(model, f);
  return masked.length === 0 ? closure : [...closure, ...masked.filter((g) => !closure.includes(g))];
}

/**
 * Do `a` and `b` state the same value — compared as values, not as written?
 *  - Two literal numbers: exactly, as the decimals written, each in SI
 *    through the unit registry (`1000.0 [g]` is `1.0 [kg]`; a mass is never
 *    a length) — `same` or `differs`. A unit nothing converts is compared as
 *    spelled, and one side with a unit and the other without is `undecided`.
 *  - Two booleans, or two quoted strings: as written.
 *  - Two value expressions: the same parsed body — whitespace and the
 *    spelling of a unit literal aside — is `same`; any other pair of
 *    expressions, or an expression against a literal, only an evaluation
 *    could compare: `undecided`.
 */
export function compareWrittenValues(a: ElementRecord, b: ElementRecord): WrittenComparison {
  const x = a.attrs.value;
  const y = b.attrs.value;
  if (typeof x === 'number' && typeof y === 'number') return compareQuantities(a, b);
  if (typeof x === 'boolean' && typeof y === 'boolean') return x === y ? 'same' : 'differs';
  if (typeof x === 'string' && typeof y === 'string') {
    const s = x.trim();
    const t = y.trim();
    if (isQuoted(s) && isQuoted(t)) return s === t ? 'same' : 'differs';
    if (s === t) return 'same';
  }
  // A value that reads no name is a CONSTANT, compared exactly: `2.0 * 0.5`
  // is the binding `1.0`, and `1000.0 [g]` is `1.0 [kg]`.
  const cx = constantOf(a);
  const cy = constantOf(b);
  if (cx && cy) return compareConstants(cx, cy);
  if (typeof x !== 'string' || typeof y !== 'string') return 'undecided';
  const p = parseRelationBody(x.trim());
  const q = parseRelationBody(y.trim());
  if (!p || !q || (p.hadUnit && !p.resolved) || (q.hadUnit && !q.resolved)) return 'undecided';
  return sameBody(p.node, p.literals, q.node, q.literals) ? 'same' : 'undecided';
}

/** An exact constant: its value in SI, and its dimension — `undefined` for a bare number. */
interface Constant {
  si: Rational;
  dimension: Dimension | undefined;
}

/** Two constants compared exactly: a bare number against a quantity is not decided by reading them. */
function compareConstants(a: Constant, b: Constant): WrittenComparison {
  if (a.dimension === undefined || b.dimension === undefined) {
    if (a.dimension !== b.dimension) return 'undecided';
    return equalRationals(a.si, b.si) ? 'same' : 'differs';
  }
  if (!dimEqual(a.dimension, b.dimension)) return 'differs';
  return equalRationals(a.si, b.si) ? 'same' : 'differs';
}

/**
 * `f`'s value as an exact constant — a literal number with the unit beside it,
 * or a value expression that reads no name, over `+ - * /` and `[unit]`
 * literals — or `undefined`.
 */
function constantOf(f: ElementRecord): Constant | undefined {
  const v = f.attrs.value;
  if (typeof v === 'number') {
    const m = magnitudeOf(f);
    const unit = typeof f.attrs.unit === 'string' ? f.attrs.unit.trim() : '';
    if (!m) return undefined;
    if (unit === '') return { si: m, dimension: undefined };
    const u = resolveUnit(unit);
    if (!u || u.offsetSI) return undefined;
    return { si: multiplyRationals(m, scaleRational(u.factorToSI, u.factorTerms)), dimension: u.dimension };
  }
  if (typeof v !== 'string' || isQuoted(v.trim())) return undefined;
  const body = parseRelationBody(v.trim());
  if (!body || (body.hadUnit && !body.resolved)) return undefined;
  return exactConstant(body.node, body.literals);
}

/** A name-free expression evaluated exactly, or `undefined` where it reads a name or leaves `+ - * /`. */
function exactConstant(n: ExprNode, literals: MarkerDimensions): Constant | undefined {
  switch (n.kind) {
    case 'num': {
      const r = decimalRational(String(n.value));
      return r ? { si: r, dimension: undefined } : undefined;
    }
    case 'ref': {
      const lit = literals.get(n.path.join('.'));
      const m = lit ? decimalRational(lit.magnitude) : undefined;
      if (!lit || !m) return undefined;
      return { si: multiplyRationals(m, scaleRational(lit.factor, lit.factorTerms)), dimension: lit.dimension };
    }
    case 'unary': {
      if (n.op === 'not') return undefined;
      const x = exactConstant(n.operand, literals);
      return x && n.op === '-' ? { si: { num: -x.si.num, den: x.si.den }, dimension: x.dimension } : x;
    }
    case 'binary': {
      const l = exactConstant(n.left, literals);
      const r = exactConstant(n.right, literals);
      if (!l || !r) return undefined;
      const dims = (d: (x: Dimension, y: Dimension) => Dimension): Dimension | undefined =>
        l.dimension === undefined ? r.dimension : r.dimension === undefined ? l.dimension : d(l.dimension, r.dimension);
      switch (n.op) {
        case '+':
        case '-': {
          if ((l.dimension === undefined) !== (r.dimension === undefined)) return undefined;
          if (l.dimension && r.dimension && !dimEqual(l.dimension, r.dimension)) return undefined;
          const sign = n.op === '-' ? -1n : 1n;
          return {
            si: { num: l.si.num * r.si.den + sign * r.si.num * l.si.den, den: l.si.den * r.si.den },
            dimension: l.dimension,
          };
        }
        case '*':
          return { si: multiplyRationals(l.si, r.si), dimension: dims(multiplyDim) };
        case '/':
          if (r.si.num === 0n) return undefined;
          return {
            si: { num: r.si.num < 0n ? -l.si.num * r.si.den : l.si.num * r.si.den, den: l.si.den * (r.si.num < 0n ? -r.si.num : r.si.num) },
            dimension: l.dimension === undefined && r.dimension !== undefined ? divideDim(DIMENSIONLESS, r.dimension) : dims(divideDim),
          };
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** Two literal numbers, each with the unit written beside it, compared exactly in SI. */
function compareQuantities(a: ElementRecord, b: ElementRecord): WrittenComparison {
  const ua = typeof a.attrs.unit === 'string' ? a.attrs.unit.trim() : '';
  const ub = typeof b.attrs.unit === 'string' ? b.attrs.unit.trim() : '';
  const ma = magnitudeOf(a);
  const mb = magnitudeOf(b);
  if (!ma || !mb) return a.attrs.value === b.attrs.value && ua === ub ? 'same' : 'undecided';
  if (ua === '' && ub === '') return equalRationals(ma, mb) ? 'same' : 'differs';
  if (ua === '' || ub === '') return 'undecided';
  const fa = resolveUnit(ua);
  const fb = resolveUnit(ub);
  if (!fa || !fb || fa.offsetSI || fb.offsetSI) {
    if (ua !== ub) return 'undecided';
    return equalRationals(ma, mb) ? 'same' : 'differs';
  }
  if (!dimEqual(fa.dimension, fb.dimension)) return 'differs';
  const sa = multiplyRationals(ma, scaleRational(fa.factorToSI, fa.factorTerms));
  const sb = multiplyRationals(mb, scaleRational(fb.factorToSI, fb.factorTerms));
  return equalRationals(sa, sb) ? 'same' : 'differs';
}

/** A literal value as the exact decimal written — its `valueText`, else the number's shortest spelling. */
function magnitudeOf(f: ElementRecord): Rational | undefined {
  const text = typeof f.attrs.valueText === 'string' ? f.attrs.valueText : String(f.attrs.value);
  return decimalRational(text) ?? (typeof f.attrs.value === 'number' ? decimalRational(String(f.attrs.value)) : undefined);
}

function multiplyRationals(a: Rational, b: Rational): Rational {
  return { num: a.num * b.num, den: a.den * b.den };
}

function equalRationals(a: Rational, b: Rational): boolean {
  return a.num * b.den === b.num * a.den;
}

function isQuoted(s: string): boolean {
  return s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")));
}

/**
 * Two parsed bodies the same expression — the same tree, the same names, the
 * same numbers, and every `[unit]` literal the same quantity exactly.
 */
function sameBody(a: ExprNode, la: MarkerDimensions, b: ExprNode, lb: MarkerDimensions): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'num':
      return a.value === (b as typeof a).value;
    case 'bool':
      return a.value === (b as typeof a).value;
    case 'ref': {
      const pa = a.path.join('.');
      const pb = (b as typeof a).path.join('.');
      const ma = la.get(pa);
      const mb = lb.get(pb);
      if (ma || mb) {
        if (!ma || !mb || !dimEqual(ma.dimension, mb.dimension)) return false;
        const ra = decimalRational(ma.magnitude);
        const rb = decimalRational(mb.magnitude);
        if (!ra || !rb) return ma.si === mb.si;
        return equalRationals(
          multiplyRationals(ra, scaleRational(ma.factor, ma.factorTerms)),
          multiplyRationals(rb, scaleRational(mb.factor, mb.factorTerms)),
        );
      }
      return pa === pb;
    }
    case 'unary':
      return a.op === (b as typeof a).op && sameBody(a.operand, la, (b as typeof a).operand, lb);
    case 'binary':
      return (
        a.op === (b as typeof a).op &&
        sameBody(a.left, la, (b as typeof a).left, lb) &&
        sameBody(a.right, la, (b as typeof a).right, lb)
      );
    case 'if':
      return (
        sameBody(a.cond, la, (b as typeof a).cond, lb) &&
        sameBody(a.then, la, (b as typeof a).then, lb) &&
        sameBody(a.else, la, (b as typeof a).else, lb)
      );
    default:
      return JSON.stringify(a) === JSON.stringify(b);
  }
}

/** Does `mine` restate the LITERAL value `g` states — one that reads no name — as the same value ({@link compareWrittenValues})? */
function isLiteralRestatement(mine: ElementRecord, g: ElementRecord): boolean {
  const v = g.attrs.value;
  if (v === undefined || v === null || mine.attrs.value === undefined || mine.attrs.value === null) return false;
  if (typeof v === 'string' && namesOfValue(v).length > 0) return false;
  return compareWrittenValues(mine, g) === 'same';
}

/**
 * Does `f` — a redefinition that states no value — change what lies below it:
 * own a feature that states a value or redefines one, or carry a type of its
 * own (`part :>> e : E2`)? An implicit connector-end copy changes nothing.
 */
function changesBelow(model: Model, f: ElementRecord): boolean {
  if (model.relationshipsFrom(f.id).some((r) => r.eClass === 'FeatureTyping')) return true;
  return model
    .children(f.id)
    .some((c) => isUsage(c.eClass) && (hasStatedValue(model, c) || redefinedClosure(model, c).length > 0));
}

/**
 * The one sentence every surface gives a feature whose value conflicts with a
 * binding it overrides ({@link contradictedBindingOf}): `p::load = 50.0
 * contradicts P::load = 1.0, a binding …` where the two values are decided to
 * differ, and where only an evaluation could compare them, that neither is
 * read while the verification lane decides.
 */
export function contradictionSentence(model: Model, f: ElementRecord, conflict: BindingConflict): string {
  const { binding } = conflict;
  const owner = binding.ownerId != null ? model.get(binding.ownerId) : undefined;
  const ownerName = owner?.declaredName ?? owner?.declaredShortName ?? 'its owner';
  const overrides = redefinedClosure(model, f).includes(binding) ? 'redefines' : 'masks by name';
  if (!conflict.decided) {
    return (
      `${writtenName(model, f)} = ${writtenValue(f)} ${overrides} ${writtenName(model, binding)} = ` +
      `${writtenValue(binding)}, a binding every ${ownerName} holds (a value written with \`=\`), with a value ` +
      'that is not the same as written; whether the two meet takes an evaluation this tool does not make here, so ' +
      'neither is read — the verification lane carries both and decides'
    );
  }
  return (
    `${writtenName(model, f)} = ${writtenValue(f)} contradicts ${writtenName(model, binding)} = ` +
    `${writtenValue(binding)}, a binding every ${ownerName} holds (a value written with \`=\`); a redefinition ` +
    'may override only a `default`, so the model states both values and neither is read'
  );
}

/** `p::load` — the owner's name and the feature's effective one. */
function writtenName(model: Model, f: ElementRecord): string {
  const owner = f.ownerId != null ? model.get(f.ownerId) : undefined;
  const own = effectiveNameOf(model, f) ?? f.declaredShortName ?? `«${f.eClass}»`;
  const ownerName = owner ? (effectiveNameOf(model, owner) ?? owner.declaredShortName) : undefined;
  return ownerName ? `${ownerName}::${own}` : own;
}

/** A feature's value as written, its unit beside it. */
function writtenValue(f: ElementRecord): string {
  const text = typeof f.attrs.valueText === 'string' ? f.attrs.valueText : String(f.attrs.value);
  return typeof f.attrs.unit === 'string' && f.attrs.unit !== '' ? `${text} [${f.attrs.unit}]` : text;
}

/**
 * Does calculation `el` have a parameter — a directed feature, or any feature
 * its `body` names — among its EFFECTIVE features? A calculation typed by a
 * `calc def` owns none of the definition's parameters and has every one of
 * them: `calc t : Scale { x * 5.0 }` reads Scale's `in x`, not the `x` of the
 * part it is written in.
 */
function ownsParameter(model: Model, el: ElementRecord, body: string): boolean {
  // A calculation that specialises one with a body of its own — `calc t : Two {
  // x * 5.0 }` over `calc def Two { 2.0 }`, `calc t :> base { … }` — has that
  // result binding too: its own body is not its whole value.
  if (inheritsBody(model, el)) return true;
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
    const name = effectiveNameOf(model, c);
    return name !== undefined && read.has(name);
  });
}

/** Does a calculation or calc def `el` specialises (typing, subsetting, redefinition) carry a body of its own? */
function inheritsBody(model: Model, el: ElementRecord): boolean {
  return generalizationsOf(model, el.id).some(
    (g) =>
      g.attrs.isLibrary !== true &&
      (g.eClass === 'CalculationUsage' || g.eClass === 'CalculationDefinition') &&
      typeof g.attrs.expression === 'string' &&
      g.attrs.expression.trim() !== '',
  );
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

/* ─────────────────────── Names a body's own features shadow ─────────────────────── */

/**
 * The names `names` (as a body reads them, dotted or bare) whose HEAD `el`
 * declares ITSELF — an owned or inherited feature of the constraint,
 * calculation, requirement or feature that owns the body, by its effective
 * name ({@link DefiningEquations.nameOf}: an unnamed `in :>> y = 100.0` is
 * `y`): a parameter (`in y = 100.0`), a local `attribute y`, a parameter of
 * the `constraint def` or `calc def` typing it, a feature of a feature's own
 * — where the scope of `el`'s OWNER resolves that head to a DIFFERENT
 * feature.
 *
 * Every evaluator reads a body through its owner's names first. SysML resolves
 * a name in the innermost namespace first, so there the name is `el`'s own
 * feature, and every surface read the owner's: `constraint c { in y = 100.0; y
 * <= 10.0 }` beside `attribute y = 4.0` was satisfied, and PROVED, with y 100.
 * Where the owner has no such name the merged scope already reads `el`'s own,
 * and nothing is shadowed. A shadowed body is read by no surface: it is
 * undecided, never judged against the owner's value — and an assumption that
 * is one is no premise a proof may stand on.
 */
export function shadowedNamesOf(model: Model, el: ElementRecord, names: Iterable<string>): string[] {
  if (el.ownerId == null) return [];
  const definitions = sharedDefinitions(model);
  let own: ReadonlyMap<string, ElementRecord> | undefined;
  const out: string[] = [];
  for (const name of new Set(names)) {
    own ??= ownNames(definitions, el);
    if (own.size === 0) return [];
    const head = name.split('.')[0]!;
    const f = own.get(head);
    if (f === undefined) continue;
    const outer = definitions.scope(el.ownerId, 'all').get(head);
    if (outer !== undefined && outer !== f.id && outer !== definitions.carrier(el.id, f).id) out.push(name);
  }
  return out;
}

/** `el`'s own named features — owned or inherited, the user's own (a library feature is not read). */
function ownNames(definitions: DefiningEquations, el: ElementRecord): ReadonlyMap<string, ElementRecord> {
  const own = new Map<string, ElementRecord>();
  for (const f of definitions.features(el.id)) {
    if (f.attrs.isLibrary === true) continue;
    const n = definitions.nameOf(f);
    if (n === undefined || n === '' || own.has(n)) continue;
    own.set(n, f);
  }
  return own;
}

/** The one sentence every surface gives a body {@link shadowedNamesOf} refuses. */
export function shadowedSentence(model: Model, el: ElementRecord, shadowed: readonly string[]): string {
  const definitions = sharedDefinitions(model);
  const head = shadowed[0]!.split('.')[0]!;
  const f = ownNames(definitions, el).get(head);
  const outer = el.ownerId != null ? definitions.scope(el.ownerId, 'all').get(head) : undefined;
  const who = effectiveNameOf(model, el) ?? effectiveQualifiedName(model, el.id);
  const what =
    f && typeof f.attrs.direction === 'string'
      ? `its own ${f.attrs.direction} parameter`
      : f && f.ownerId !== el.id
        ? 'a feature it inherits'
        : 'a feature of its own';
  return (
    `\`${head}\` in ${who} is ${f ? effectiveQualifiedName(model, f.id) : head}, ${what}; this tool reads a ` +
    `body in its owner's scope, where \`${head}\` is ${outer !== undefined ? effectiveQualifiedName(model, outer) : 'another feature'} ` +
    '— another feature — so the body is not read'
  );
}

/**
 * Is `el` a calculation whose features are the values of a CALL — one with a
 * parameter: a calculation that states no value by its body for one
 * ({@link isParameterisedCalculation}), or any with a directed feature, owned
 * or from the `calc def` that types it (`calc g { in y = 100.0; return r = y;
 * }`)? A chain into it (`g.r`) reads a default nothing invokes, and no
 * surface reads it.
 */
export function isCall(model: Model, el: ElementRecord): boolean {
  if (el.eClass !== 'CalculationUsage') return false;
  if (isParameterisedCalculation(model, el)) return true;
  return effectiveFeatures(model, el.id).some((c) => {
    const direction = c.attrs.direction;
    return direction === 'in' || direction === 'out' || direction === 'inout';
  });
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

/**
 * The key of a feature's value read IN a context that is not where it is
 * written ({@link DefiningEquations.readAt}) — its memo key and its key on a
 * derivation stack, apart from the value it has where it is written.
 */
export function instanceKey(featureId: ElementId, contextId: ElementId): string {
  return `${featureId}@${contextId}`;
}

/** The feature an {@link instanceKey} (or a plain feature id) is of. */
export function baseIdOf(key: string): ElementId {
  const at = key.indexOf('@');
  return at < 0 ? key : key.slice(0, at);
}

/** The memo key of the derivation an equation in `contextId` gives a feature — never a bare element id. */
export function definitionKey(featureId: ElementId, contextId: ElementId): string {
  return `${featureId} defined in ${contextId}`;
}
