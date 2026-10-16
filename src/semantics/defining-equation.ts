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
import { resolveFullName } from './bind';
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
    // A DOTTED defined name (`assert constraint { p.x == 3.0 }`) indexes under
    // the whole path; a single-segment ref is the bare name it always was.
    const l = definedName(node.left, literals);
    const r = definedName(node.right, literals);
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
  /** The user elements by the instance a scope rooted at each reads its features in ({@link framesAbove}). */
  private rootsByInstance?: Map<string, ElementRecord[]>;
  /** {@link framesAbove} per instance spelling (`null`: no chain spells it). */
  private readonly above = new Map<string, readonly InstanceFrame[] | null>();
  /** The asserted relations each reader holds, with the names each reads ({@link assertsOf}). */
  private readonly asserted = new Map<ElementId, ReadonlyArray<{ expr: string; names: readonly string[] }>>();
  /** {@link anyAsserted}, once asked. */
  private anyAsserts?: boolean;
  /** {@link reachingAssert} per `${contextId} ${name}` (`null`: none). */
  private readonly reaching = new Map<string, { site: ElementId; path: string; equations: readonly DefiningEquation[] } | null>();
  /** {@link boundAbove} per context and names (`null`: none above) — every instance row of a group asks it of the usage. */
  private readonly aboveBound = new Map<string, BoundAbove | null>();
  /** {@link lexicalNames} per context. */
  private readonly lexical = new Map<ElementId, { admitted: ReadonlyMap<string, Denotation>; refused: ReadonlyMap<string, string> }>();
  /** The ends of the user's binding connectors and what each redefines, for {@link lexicallyUniform}. */
  private joined?: ReadonlySet<ElementId>;
  /** The implicit contexts (connector-end copies) that specialise each element, for {@link lexicallyUniform}. */
  private implicitlySpecialised?: ReadonlyMap<ElementId, readonly ElementRecord[]>;
  /** {@link assertedNames}, once asked. */
  private assertNames?: ReadonlyMap<string, ReadonlySet<ElementId>>;
  /** {@link namesWritten} per element. */
  private readonly writtenNames = new Map<ElementId, ReadonlyMap<string, readonly ElementRecord[]>>();

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
    // A part a part-valued binding equates with another, saying nothing of its
    // own (`bind pp = top.a`), stands for it as a reference does: its path is
    // resolved in the instance read, of the element the binding is written in
    // (w's own top for `part w : W { part :>> top { … } }`), and there alone.
    const equated = subject ? undefined : this.equatedPart(f, contextId);
    // A REFERENCE feature (`ref part :>> r = r1`) stands for the feature its
    // value names, exactly as a bound subject does: every chain through it
    // reads the referenced feature, so `q.r.L` is r1's 50, not R's own 1.
    if (!subject && f.attrs.isRef !== true && !equated) return undefined;
    if (subject) {
      const satisfied = this.satisfaction(contextId);
      if (satisfied) return { feature: satisfied.satisfier };
    }
    const v = equated ? equated.path : f.attrs.value;
    if (typeof v !== 'string') return undefined;
    const path = v.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) return undefined;
    const seen = new Set<ElementId>();
    for (
      let cur = equated ? equated.from : f.ownerId;
      cur != null && !seen.has(cur);
      cur = equated ? null : (this.model.get(cur)?.ownerId ?? null)
    ) {
      seen.add(cur);
      const end = this.chain([cur], path)?.feature;
      if (end && end !== f) return { feature: end, scope: cur, path };
    }
    return undefined;
  }

  /**
   * The partner a part-valued binding has `f` stand for ({@link equatedParts})
   * when read in `contextId`: its path, and where it is resolved — the
   * context, when `f` is a feature of the element the binding is written in
   * and the context has it among its own (that element, a usage it types, one
   * that specialises it: an instance reads its own partner), else that
   * element. `undefined` for any other feature.
   */
  equatedPart(f: ElementRecord, contextId: ElementId): { path: string; from: ElementId } | undefined {
    const hit = equatedParts(this.model).standsFor.get(f.id);
    if (!hit || contextId === hit.from || f.ownerId !== hit.from || !this.features(contextId).includes(f)) return hit;
    return { path: hit.path, from: contextId };
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
      return target.ownerId === d.reader || (this.sameIn(d.reader, target) && !this.changedByAssert(d.reader, target))
        ? { target }
        : { target, at: d.reader };
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
        const bound = into !== feat ? this.boundInstance(ownerId, feat, into, { instance, enclosing }) : undefined;
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
    // Last, a name nothing below the context answers: the attribute its
    // owning namespaces declare ({@link lexicalNames}).
    for (const [n, denoted] of this.lexicalNames(contextId).admitted) if (!ids.has(n)) ids.set(n, denoted);
    return ids;
  }

  /**
   * The names `contextId` reads through the OWNING namespaces of the elements
   * that write its bodies (E3, KerML's lexical scope): `K` in `package Lex {
   * attribute K = 7.0; part def A { attribute x = K; } }` is Lex's K, which
   * A's own features do not answer. The bodies read in a context are its own
   * and its general types' ({@link namesWritten}); each names `n` as KerML
   * resolves it where it is written ({@link resolveFullName}: its owners
   * outward, with their imports and aliases), and `n` is read here only where
   * every one of them resolves it to one attribute, which the nearest owner
   * of each declaring a feature by that name declares. So an import or an
   * alias on the way (`import Consts::*;`) leaves the name unread, as does a
   * name a writer does not see (H's K for A's `x = K`, where A is declared
   * outside H), and one a specialiser of the context declares itself (q's
   * `part :>> p { attribute L … }` beside Q's p reading Q's L: there that
   * body would read q's p's L). Each is read where it is declared, as one
   * value:
   *  - a package's attribute is one instance wherever it is read;
   *  - an enclosing definition's or usage's attribute is read in the instance
   *    that encloses the reading, so it is read here only where that is the
   *    same value in EVERY instance of its owner ({@link lexicallyUniform}):
   *    none specialises the owner and declares it anew, no binding joins it,
   *    no asserted relation names it where it is a `default`, and what its
   *    value reads is the same too. Where one is not (h2c0's `q : Q { :>> L =
   *    50.0; }` beside Q's p `:>> load = L`), the name is left unread — the
   *    generic read abstains where a specialiser changes the value — and the
   *    reason is kept (`refused`, {@link lexicalRefusal}).
   * Once per context; it reads no {@link denote} walk, and no value a binding
   * or an assert decides ({@link lexicallyUniform}).
   */
  private lexicalNames(contextId: ElementId): {
    admitted: ReadonlyMap<string, Denotation>;
    refused: ReadonlyMap<string, string>;
  } {
    const hit = this.lexical.get(contextId);
    if (hit) return hit;
    const admitted = new Map<string, Denotation>();
    const refused = new Map<string, string>();
    const out = { admitted, refused };
    this.lexical.set(contextId, out);
    // A relation's body is read with the context it is read in around it,
    // whose own owners answer such a name: the relation itself offers none (P's
    // `c` read in Q2's p reads no attribute of P as an owner's).
    const context = this.model.get(contextId);
    if (!context || context.attrs.isLibrary === true || isKindOf(context.eClass, 'ConstraintUsage')) return out;
    const own = this.byName(contextId);
    const writers = [context, ...generalizationsOf(this.model, contextId).filter((t) => t.attrs.isLibrary !== true)];
    const written = new Map<string, ElementRecord[]>();
    for (const w of writers) {
      for (const [n, at] of this.namesWritten(w.id)) if (!own.has(n)) written.set(n, [...(written.get(n) ?? []), ...at]);
    }
    for (const [n, at] of written) {
      // Each element that writes it: the nearest of its owners that declares
      // the name answers it, and KerML's resolution agrees — no import, alias
      // or member of its own answers it first.
      let target: { owner: ElementRecord; feature: ElementRecord } | undefined;
      const agree = at.every((x) => {
        const t = this.lexicalTarget(x.id, n);
        if (!t || (target !== undefined && (t.feature !== target.feature || t.owner !== target.owner))) return false;
        target = t;
        return resolveFullName(this.model, n, x.id)?.id === t.feature.id;
      });
      if (!agree || !target || target.feature.eClass !== 'AttributeUsage') continue;
      const { owner: o, feature: f } = target;
      if (this.specialisersOf(contextId).some((s) => (this.byName(s.id).get(n) ?? f) !== f)) continue;
      // A package's `default` an assert other than its own names (one nested in it too) may give way there
      // with the default it is set equal to (U7): not one value either.
      const elsewhere = isPackage(o) && f.attrs.defaultValue === true && [...(this.assertedNames().get(n) ?? [])].some((x) => x !== o.id);
      const why = elsewhere ? `an asserted relation other than its own names ${n}` : isPackage(o) ? undefined : this.lexicallyUniform(o.id, f, n);
      if (why !== undefined) {
        refused.set(n, `${n} is read through ${this.qualifiedNameOf(o.id)}, which declares it, and is not one value in every instance of it: ${why}`);
        continue;
      }
      admitted.set(n, { feature: f, reader: o.id, inCall: false, instance: this.instanceNameOf(o.id), enclosing: [] });
    }
    return out;
  }

  /**
   * The bare names the bodies `id` owns read — its features' values and its
   * relations' expressions, by the first segment of each — with the elements
   * that write them ({@link lexicalNames}). Once per element.
   */
  private namesWritten(id: ElementId): ReadonlyMap<string, readonly ElementRecord[]> {
    let hit = this.writtenNames.get(id);
    if (!hit) {
      const out = new Map<string, ElementRecord[]>();
      const add = (names: readonly string[], x: ElementRecord): void => {
        for (const n of names) {
          const head = n.split('.')[0]!;
          const list = out.get(head);
          if (!list) out.set(head, [x]);
          else if (!list.includes(x)) list.push(x);
        }
      };
      for (const x of this.model.children(id)) {
        if (typeof x.attrs.value === 'string') add(namesOfValue(x.attrs.value), x);
        if (typeof x.attrs.expression === 'string') add(relationNamesOf(x.attrs.expression), x);
      }
      this.writtenNames.set(id, (hit = out));
    }
    return hit;
  }

  /**
   * The attribute a body read in `contextId` reads `name` as through the
   * owners of the element that writes it ({@link lexicalNames}) — `undefined`
   * where it reads none so: a feature of the context, or a name left unread.
   */
  lexicalFeature(contextId: ElementId, name: string): ElementRecord | undefined {
    return this.byName(contextId).has(name) ? undefined : this.lexicalNames(contextId).admitted.get(name)?.feature;
  }

  /**
   * Why a name a body reads through its owners ({@link lexicalNames}) is left
   * unread in `contextId` — the sentence naming what makes it another value in
   * some instance — or `undefined`.
   */
  lexicalRefusal(contextId: ElementId, name: string): string | undefined {
    return this.byName(contextId).has(name) ? undefined : this.lexicalNames(contextId).refused.get(name);
  }

  /** The feature the nearest owner of `fromId` that declares `name` declares under it, with that owner. */
  private lexicalTarget(fromId: ElementId, name: string): { owner: ElementRecord; feature: ElementRecord } | undefined {
    const seen = new Set<ElementId>([fromId]);
    for (let id = this.model.get(fromId)?.ownerId ?? null; id != null && !seen.has(id); ) {
      seen.add(id);
      const o = this.model.get(id);
      if (!o || o.attrs.isLibrary === true) return undefined;
      const feature = this.byName(id).get(name);
      if (feature) return { owner: o, feature };
      id = o.ownerId;
    }
    return undefined;
  }

  /**
   * Is the attribute `f`, declared as `name` in (or inherited by) the
   * definition or usage `ownerId`, one value in EVERY instance of it — so that
   * reading it where it is declared is reading it in whichever instance
   * encloses the reading ({@link lexicalNames})? `undefined` when it is; else
   * why not. No context that specialises the owner answers the name with
   * another feature; no binding joins it, and no asserted relation names it
   * where it is a `default` (a value given per instance); it states a literal,
   * or an expression whose every name is such a value where it is read, as
   * KerML resolves it there. Conservative: a value it cannot follow so is not
   * one.
   */
  private lexicallyUniform(ownerId: ElementId, f: ElementRecord, name: string, seen = new Set<ElementId>()): string | undefined {
    if (seen.has(f.id)) return `${name}'s value reads itself`;
    seen.add(f.id);
    // Every context that specialises the owner — an implicit connector-end
    // copy included, which redefines what a binding reaches into.
    if (!this.implicitlySpecialised) {
      const out = new Map<ElementId, ElementRecord[]>();
      for (const x of this.model.all()) {
        if (x.attrs.isLibrary === true || x.attrs.implicit !== true || (!isUsage(x.eClass) && !isDefinition(x.eClass))) continue;
        for (const g of generalizationsOf(this.model, x.id)) out.set(g.id, [...(out.get(g.id) ?? []), x]);
      }
      this.implicitlySpecialised = out;
    }
    const changed = [...this.specialisersOf(ownerId), ...(this.implicitlySpecialised.get(ownerId) ?? [])].find(
      (s) => this.byName(s.id).get(name) !== f,
    );
    if (changed) return `${this.qualifiedNameOf(changed.id)} declares ${name} anew`;
    // A binding end, or a feature one redefines: a value given per instance.
    if (!this.joined) {
      const joined = new Set<ElementId>();
      for (const e of this.model.all()) {
        if (e.attrs.isLibrary === true || !isBindingConnector(e)) continue;
        for (const id of [...(e.source ?? []), ...(e.target ?? [])]) {
          joined.add(id);
          const end = this.model.get(id);
          if (end) for (const g of redefinedClosure(this.model, end)) joined.add(g.id);
        }
      }
      this.joined = joined;
    }
    if (this.joined.has(f.id)) return `a binding joins ${name}`;
    // An assert overrides a `default` (H5), never a value written with `=`:
    // against one, it is checked.
    if (f.attrs.defaultValue === true && this.assertedNames().has(name)) return `an asserted relation names ${name}`;
    // The value as written: whether a `default` gives way is a binding's or an
    // assert's question, both answered above — and asking it here would read
    // the walk this one is part of.
    const v = f.attrs.value;
    if (typeof v === 'number' || typeof v === 'boolean') return undefined;
    if (typeof v !== 'string') return `${name} states no value`;
    if (isQuoted(v.trim())) return undefined;
    for (const m of namesOfValue(v)) {
      if (m.includes('.')) return `${name}'s value reads ${m} through another feature`;
      const g = this.byName(ownerId).get(m);
      if (g) {
        const why = this.lexicallyUniform(ownerId, g, m, seen);
        if (why !== undefined) return why;
        continue;
      }
      const t = f.ownerId != null ? this.lexicalTarget(f.ownerId, m) : undefined;
      if (!t) return `${name}'s value reads ${m}, which nothing declares`;
      if (resolveFullName(this.model, m, f.id)?.id !== t.feature.id) return `${name}'s value reads ${m}, which an import or an alias answers`;
      if (isPackage(t.owner)) continue;
      const why = this.lexicallyUniform(t.owner.id, t.feature, m, seen);
      if (why !== undefined) return why;
    }
    return undefined;
  }

  /**
   * Every name the user's asserted relations read, by each segment, with the
   * owners of the relations that read it — once per revision. An assert typed
   * by a constraint definition reads its type's expression and the values its
   * parameters are given (`assert constraint e : Eq { in a = L; }`), so both
   * count, the type's own parameter values too.
   */
  private assertedNames(): ReadonlyMap<string, ReadonlySet<ElementId>> {
    if (!this.assertNames) {
      const out = new Map<string, Set<ElementId>>();
      const add = (seg: string, owner: ElementId): void => {
        const owners = out.get(seg);
        if (owners) owners.add(owner);
        else out.set(seg, new Set([owner]));
      };
      for (const c of this.model.ofKind('ConstraintUsage')) {
        if (c.attrs.isLibrary === true || !isAsserted(c) || c.ownerId == null) continue;
        for (const x of [c, ...generalizationsOf(this.model, c.id).filter((t) => t.attrs.isLibrary !== true)]) {
          if (typeof x.attrs.expression === 'string') {
            for (const n of relationNamesOf(x.attrs.expression)) for (const seg of n.split('.')) add(seg, c.ownerId);
          }
          for (const [n] of this.namesWritten(x.id)) add(n, c.ownerId);
        }
      }
      this.assertNames = out;
    }
    return this.assertNames;
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
    at?: { instance: string; enclosing: readonly InstanceFrame[] },
  ): { instance: string; enclosing: readonly InstanceFrame[] } {
    const fallback = { instance: this.qualifiedNameOf(into.id), enclosing: [] };
    // A part a binding equates is read where the binding is written ({@link
    // equatedPart}): read in the walk's instance of that element (`at`), the
    // partner is that instance's own — s's w's top's a for W's `bind pp =
    // top.a` reached as `s.w.pp`, never the a of Sys's own w.
    const equated = this.equatedPart(f, contextId);
    if (equated && at && equated.from === contextId) {
      const end = this.chainFrom(at.instance, at.enclosing, contextId, equated.path, false);
      return end && end.feature.id === into.id ? { instance: end.instance, enclosing: end.enclosing } : fallback;
    }
    const satisfied = equated ? undefined : this.satisfaction(contextId);
    const written = satisfied ? this.model.get(contextId) : undefined;
    const ref = equated ? equated.path : satisfied ? (written?.attrs.sourceChain ?? written?.attrs.sourceRef) : f.attrs.value;
    if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(ref.trim())) {
      return fallback;
    }
    const path = ref.trim();
    const seen = new Set<ElementId>();
    for (
      let cur = equated ? equated.from : satisfied ? (written?.ownerId ?? null) : f.ownerId;
      cur != null && !seen.has(cur);
      cur = satisfied || equated ? null : (this.model.get(cur)?.ownerId ?? null)
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
    return this.chainFrom(this.instanceNameOf(contextId), [], contextId, path, true);
  }

  /**
   * {@link chainInstance} from `instance`, the instance of `contextId` the
   * caller is in, below the instances `above` (`atRoot`: `contextId` is the
   * scope's root).
   */
  private chainFrom(
    instance: string,
    above: readonly InstanceFrame[],
    contextId: ElementId,
    path: string,
    atRoot: boolean,
  ): { feature: ElementRecord; instance: string; enclosing: InstanceFrame[] } | undefined {
    const segments = path.split('.');
    let owner = contextId;
    const enclosing: InstanceFrame[] = [...above];
    for (let i = 0; i < segments.length; i++) {
      const feature = this.byName(owner).get(segments[i]!);
      const name = feature ? this.nameOf(feature) : undefined;
      if (!feature || name === undefined) return undefined;
      enclosing.push({ instance, reader: owner });
      if (i === segments.length - 1) return { feature, instance: `${instance}::${name}`, enclosing };
      if (this.subjectOf(owner, feature)) return undefined;
      instance = this.instanceBelow(instance, feature, name, atRoot && i === 0);
      owner = feature.id;
    }
    return undefined;
  }

  /**
   * The instances ENCLOSING the instance `inst`, outermost first, each with
   * the context its features are read in ({@link Denotation}'s `enclosing`):
   * `R1` (read in R1) and `R1::q1` (read in q1) for `R1::q1::p` — spelled link
   * by link ({@link chainInstance}) from the OUTERMOST user element whose own
   * instance prefixes it. A reading for an instance that is not its context's
   * own — a group row reads Q's p for q1's p; a derived value is read in its
   * definition for the instance it belongs to — reads none of these from its
   * context's walk, whose frames are the context's ({@link enclosingAssertOn}).
   * `undefined` where no element's chain spells `inst` (a subject a value
   * binds, a `satisfy` context).
   */
  framesAbove(inst: string): readonly InstanceFrame[] | undefined {
    const hit = this.above.get(inst);
    if (hit !== undefined) return hit ?? undefined;
    if (!this.rootsByInstance) {
      this.rootsByInstance = new Map();
      for (const el of this.model.all()) {
        if (el.attrs.isLibrary === true) continue;
        const name = this.instanceNameOf(el.id);
        const list = this.rootsByInstance.get(name);
        if (list) list.push(el);
        else this.rootsByInstance.set(name, [el]);
      }
    }
    const segments = inst.split('::');
    let found: readonly InstanceFrame[] | null = null;
    for (let k = 1; k < segments.length && found === null; k++) {
      const path = segments.slice(k).join('.');
      for (const root of this.rootsByInstance.get(segments.slice(0, k).join('::')) ?? []) {
        const end = this.chainInstance(root.id, path);
        if (end && end.instance === inst) {
          found = end.enclosing;
          break;
        }
      }
    }
    this.above.set(inst, found);
    return found ?? undefined;
  }

  /**
   * Does any user element own an asserted relation ({@link assertsOf})? Where
   * none does, no frame constrains a read ({@link enclosingAssertOn}). Once per
   * revision.
   */
  anyAsserted(): boolean {
    this.anyAsserts ??= this.model
      .ofKind('ConstraintUsage')
      .some(
        (c) =>
          c.attrs.isLibrary !== true &&
          isAsserted(c) &&
          typeof c.attrs.expression === 'string' &&
          c.attrs.expression.trim() !== '',
      );
    return this.anyAsserts;
  }

  /**
   * The asserted relations `readerId` owns, user-written, each with the names
   * its body reads ({@link relationNamesOf}) — once per reader, for
   * {@link enclosingAssertOn}.
   */
  assertsOf(readerId: ElementId): ReadonlyArray<{ expr: string; names: readonly string[] }> {
    let hit = this.asserted.get(readerId);
    if (!hit) {
      const out: Array<{ expr: string; names: readonly string[] }> = [];
      for (const child of this.model.children(readerId)) {
        if (child.attrs.isLibrary === true || !isAsserted(child)) continue;
        const expr = child.attrs.expression;
        if (typeof expr !== 'string' || expr.trim() === '') continue;
        out.push({ expr, names: relationNamesOf(expr) });
      }
      hit = out;
      this.asserted.set(readerId, hit);
    }
    return hit;
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
    // So is one an asserted equation of an enclosing element defines in some
    // instance (H5, {@link assertHeldInSome}): q1's p's x is 50, every other P's 2.
    if (assertHeldInSome(this.model, f)) return false;
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

  /**
   * Does `contextId` read `feature`'s stated value otherwise than where it is
   * written because an asserted equation of an enclosing context defines a
   * name the value reads there, by its dotted path ({@link reachingAssert})?
   * B1's `p.y`, over P's `y = x * 2.0` and the package's `assert constraint {
   * p.x == 3.0 }`, is p's own: 6, where P's x has no value.
   */
  private changedByAssert(contextId: ElementId, feature: ElementRecord): boolean {
    if (!this.anyAsserted()) return false;
    const stated = this.statedOf(feature);
    if (typeof stated.value !== 'string') return false;
    stated.names ??= namesOfValue(stated.value);
    return stated.names.some((n) => this.reachingAssert(contextId, n) !== undefined);
  }

  /**
   * The asserted equation of an ENCLOSING context that defines, by its DOTTED
   * path, the valueless feature a bare `name` denotes in `contextId` — `assert
   * constraint { p.x == 3.0 }` in the package, read at `part p : P` whose P
   * declares `x` with no value: p's x is 3 (class C). The
   * path is the chain of usages that own one another from that context down
   * to `contextId`, then `name`; `site` writes the equations. Only one that
   * reads no name defines here — the same value in every instance the context
   * stands for; one over names is read per instance (H5's enclosing rule).
   * Nor a feature that writes a value, or a `default`: an equation against a
   * value is checked against it, and one over a default is that enclosing
   * rule's too. Nor one a binding gives a value, nor one two asserts give
   * different values. `undefined` when none does.
   */
  reachingAssert(
    contextId: ElementId,
    name: string,
  ): { site: ElementId; path: string; equations: readonly DefiningEquation[] } | undefined {
    if (name.includes('.') || !this.anyAsserted()) return undefined;
    const key = `${contextId} ${name}`;
    if (!this.reaching.has(key)) this.reaching.set(key, this.reachingUncached(contextId, name) ?? null);
    return this.reaching.get(key) ?? undefined;
  }

  private reachingUncached(
    contextId: ElementId,
    name: string,
  ): { site: ElementId; path: string; equations: readonly DefiningEquation[] } | undefined {
    const f = this.feature(contextId, name);
    if (!f) return undefined;
    // A binding that joins the feature — its own end (the implicit end copy
    // `bind p.x = L` makes), or one it redefines — gives it the binding's
    // value, against which the assert is checked, not read (RB). So does a
    // binding, or a value, that equates a part on the path with another part
    // (`bind r = s`: q's r is s, whose x the assert does not define).
    const ends = bindingEndsOf(this.model);
    const fixed = (g: ElementRecord): boolean => ends.has(g.id) || (g.attrs.value !== undefined && g.attrs.value !== null);
    if ([f, ...redefinedClosure(this.model, f)].some(fixed)) return undefined;
    const path = [name];
    for (let cur = this.model.get(contextId); cur && isUsage(cur.eClass) && cur.ownerId != null; ) {
      const owner = this.model.get(cur.ownerId);
      const n = this.nameOf(cur);
      if (!owner || owner.attrs.isLibrary === true || n === undefined || fixed(cur)) return undefined;
      path.unshift(n);
      const equations = this.of(owner.id, path.join('.'));
      if (equations.length > 0) {
        // Two asserts that give it different values leave it undecided (`two-values`).
        const first = JSON.stringify([equations[0]!.definition, [...equations[0]!.literals]]);
        return equations.every(
          (eq) => refsIn(eq.definition, eq.literals).length === 0 && JSON.stringify([eq.definition, [...eq.literals]]) === first,
        )
          ? { site: owner.id, path: path.join('.'), equations }
          : undefined;
      }
      cur = owner;
    }
    return undefined;
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
   * { p.load <= 5.0 }` is q2's own there. Every surface reads it at the
   * context's own instance (E7), as it reads one a binding above lists (F5) —
   * q2's load of 50 — except over a member stated twice there, or a binding
   * not read there ({@link boundStatedTwiceIn}). Read as the context reads its
   * names, not at its instance, it published a value the binding does not
   * give: over an asserted partner (`assert constraint { L == 2.0 * K }`), P's
   * default through the end copy, as Q2's `p.load` beside Q2's L of 50 (G340).
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
   * Why a context {@link readsBoundOnly} lists is not read at its instance, or
   * `undefined` where it is. `'two-values'`: a binding of `el`'s owner joins
   * what `names` read, in the context `contextId`, to a component two of whose
   * members state a value there (A.3's `valued`, {@link classified}) — Q's `load
   * = 1.0` beside the bound `L = 2.0 * K`, read in `q2 : Q { :>> K = 25.0; }`:
   * the model states 1 and 50 for q2's load, and its instance reading reads the
   * first alone. `'unread'`: fail closed, where that binding is not read in the
   * context. Every surface leaves such a reading undecided ({@link
   * boundHereSentence}).
   */
  boundStatedTwiceIn(el: ElementRecord, names: readonly string[], contextId: ElementId): BoundHere | undefined {
    if (el.ownerId == null) return 'unread';
    const { readings } = bindingEnds(this.model);
    const own = readings.get(el.ownerId);
    const there = readings.get(contextId);
    if (!own || !there) return 'unread';
    const reads = this.boundReads(el.ownerId, names);
    for (const [path, r] of own) {
      if (!reads.has(r.feature)) continue;
      const x = there.get(path);
      if (!x) return 'unread';
      if (classified(this.model, contextId, x.component).valued.length > 1) return 'two-values';
    }
    return undefined;
  }

  /**
   * Does the context `contextId` read what `el` reads through a binding of
   * `el`'s owner otherwise than the owner does ({@link bindingReadingIn})? h2c's
   * `q : Q { :>> L = 50.0; }`, whose L Q's `bind p.load = L` carries into the
   * p.m2 Q's `c` reads, and M7's `q2 : Q { :>> K = 25.0; }`, whose K reaches the
   * bound L: the context's reading of `el` is carried by a binding (PI-3), so
   * it is an instance's reading, reported as one (`constraint-by-instance`).
   * Only where the binding carries it: a name the context redefines is its own
   * value there (`q : Q { :>> L = 500.0; }` under Q's `L <= 100.0`), and a
   * bound feature whose value is its own is no value carried in (Q's `defL { L
   * == 2.0 * K }` read in `Q2 :> Q { :>> K = 25.0; }`, L the binding's source).
   */
  readsThroughBinding(el: ElementRecord, names: readonly string[], contextId: ElementId): boolean {
    if (el.ownerId == null) return false;
    const there = this.denote(contextId);
    const here = this.denote(el.ownerId);
    const reads = this.boundReads(el.ownerId, names.filter((n) => there.get(n)?.feature.id === here.get(n)?.feature.id));
    if (reads.size === 0) return false;
    const own = bindingReadingIn(this.model, el.ownerId, el.ownerId, reads);
    if (own === undefined || bindingReadingIn(this.model, el.ownerId, contextId, reads) === own) return false;
    return this.boundSources(el.ownerId, contextId, reads).some(({ path, sources }) => sources.some((p) => p !== path));
  }

  /**
   * The member written in `rootId` that states the value a binding carries
   * there into what `names` read — C.1's anchor rule, the component's single
   * stated member: q's `:>> L = 50.0` for Q's `c { p.m2 >= 0.0 }` read in `q :
   * Q` over Q's `bind p.load = L` — or `undefined`: no binding carries one in,
   * more than one member could, or the one that does is written outside
   * `rootId` (M7's `L = 2.0 * K`, Q's own for every Q). Only the paths below
   * `under` are read (an instance's own, `p.` for q1's p in q1): a root of a
   * thousand instances is not scanned whole for each of them.
   */
  statedMember(rootId: ElementId, names: readonly string[], under = ''): ElementRecord | undefined {
    const reading = bindingEnds(this.model).readings.get(rootId);
    // A root that writes nothing of its own (`part a : T4;`) states no member: no reading is asked of it.
    if (reading === undefined || !this.model.children(rootId).some((c) => isUsage(c.eClass) && c.attrs.implicit !== true)) return undefined;
    const reads = this.boundReads(rootId, names);
    if (reads.size === 0) return undefined;
    for (const { path, sources } of this.boundSources(rootId, rootId, reads, under)) {
      const others = sources.filter((p) => p !== path);
      const member = others.length === 1 ? this.model.get(reading.get(others[0]!)?.feature ?? '') : undefined;
      for (let cur = member; cur; cur = cur.ownerId != null ? this.model.get(cur.ownerId) : undefined) {
        if (cur.id === rootId) return member;
      }
    }
    return undefined;
  }

  /**
   * Per path the binding reading of `rootId` holds one of `reads` at ({@link
   * bindingReadingIn}), the members that give its component its value in
   * `contextId` ({@link classified}): the stated ones, else the readable
   * defaults — of the paths below `under` alone, where one is given.
   */
  private boundSources(
    rootId: ElementId,
    contextId: ElementId,
    reads: ReadonlySet<ElementId>,
    under = '',
  ): Array<{ path: string; sources: readonly string[] }> {
    const { readings } = bindingEnds(this.model);
    const own = readings.get(rootId);
    const there = readings.get(contextId);
    const out: Array<{ path: string; sources: readonly string[] }> = [];
    if (!own || !there) return out;
    for (const [path, r] of own) {
      const x = path.startsWith(under) && reads.has(r.feature) ? there.get(path) : undefined;
      if (!x) continue;
      const { valued, readable } = classified(this.model, contextId, x.component);
      out.push({ path, sources: valued.length > 0 ? valued : readable });
    }
    return out;
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
      // A context in whose instances an asserted equation — its own, or of an
      // element above it — defines what the relation reads (H5's enclosing
      // rule): its reading is its own.
      if (!listed && !plain.has(x.id) && reads.size > 0) {
        const asserting = assertedThrough(this.model, x.id, reads, true);
        if (asserting !== undefined && !readings.has(`${key} ${asserting.id}`)) {
          readings.add(`${key} ${asserting.id}`);
          plain.add(x.id);
          listed = true;
        }
      }
      // A usage one instance of which a binding written in its own element
      // reads otherwise (A7's q2: `bind p.extra = E` makes q2's p a copy of
      // Q's p): nothing it reads is another feature, and no binding of an
      // owner lists it, so it is listed here, to be read per instance.
      if (!listed && !plain.has(x.id) && isUsage(x.eClass) && bindingsIntoRedefiners(this.model).has(x.id)) {
        if (this.boundInRedefiner(x.id, this.boundReads(x.id, names)) !== undefined) {
          plain.add(x.id);
          listed = true;
        }
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
   *
   * So is a binding written in an instance of the usage's own element, which
   * no binding of an owner tells apart ({@link boundInRedefiner}): A7's `q2 :
   * Q { bind p.extra = E; }` gives q2's p the extra of q2's E, while Q's p —
   * and every other Q's — reads P's default.
   */
  boundAbove(contextId: ElementId, names: readonly string[]): BoundAbove | undefined {
    if (!readsPerInstance(this.model)) return undefined;
    const key = `${contextId} ${names.join('\u0000')}`;
    let hit = this.aboveBound.get(key);
    if (hit === undefined) {
      hit = this.boundAboveOf(contextId, names) ?? null;
      this.aboveBound.set(key, hit);
    }
    return hit ?? undefined;
  }

  /** {@link boundAbove}, worked out. */
  private boundAboveOf(contextId: ElementId, names: readonly string[]): BoundAbove | undefined {
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
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      const owner = this.model.get(cur.ownerId);
      if (!owner) break;
      const own = bindingReadingIn(this.model, owner.id, owner.id, reads);
      if (own !== undefined) {
        const other = this.specialisersOf(owner.id).find((y) => bindingReadingIn(this.model, owner.id, y.id, reads) !== own);
        if (other) return other;
      }
      cur = owner;
    }
    // An asserted equation of an element above the usage that defines what it
    // reads in that element's instances (H5's enclosing rule): each instance
    // reads it otherwise, as under a binding.
    return this.boundInRedefiner(contextId, reads) ?? assertedThrough(this.model, contextId, reads);
  }

  /**
   * The element a binding is written in that reaches INTO a redefinition of
   * the usage `contextId` — an end at or below it ({@link
   * bindingsIntoRedefiners}) that is, or redefines, one of the features the
   * usage's reading reads (`reads`, {@link boundReads}), or the redefinition
   * itself — or `undefined`. A7's `part q2 : Q { attribute E = 20.0; bind p.extra =
   * E; }` makes q2's p a copy of Q's p whose extra is q2's E: P's `extra <=
   * 10.0`, read in Q's p, is q2's p's own there, though no feature of Q's p
   * is redefined and no binding of an owner joins it otherwise. Read for Q's
   * own p alone, it was proved, and nothing read q2's — a decided violation
   * no surface reported.
   */
  private boundInRedefiner(contextId: ElementId, reads: ReadonlySet<ElementId>): ElementRecord | undefined {
    const into = bindingsIntoRedefiners(this.model).get(contextId);
    if (into === undefined || reads.size === 0) return undefined;
    for (const { end, holder } of into) {
      const f = this.model.get(end);
      if (!f) continue;
      if ([f, ...redefinedClosure(this.model, f)].some((g) => g.id === contextId || reads.has(g.id))) return this.model.get(holder);
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
    if (!readsPerInstance(this.model)) return out;
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

/**
 * The name a side of an equation DEFINES — its bare name, or its whole dotted
 * path (`p.x` in `assert constraint { p.x == 3.0 }`) — a lowered `[unit]`
 * literal's marker excluded, or `undefined` for anything that is no reference.
 */
function definedName(n: ExprNode, literals: MarkerDimensions = NO_MARKERS): string | undefined {
  if (n.kind !== 'ref' || n.path.length === 0) return undefined;
  return n.path.some((s) => literals.has(s)) ? undefined : n.path.join('.');
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
 * Nor a `default` a binding, or an asserted equation, overrides ({@link
 * defaultGivesWay}): the default gives way, and the feature states no value of
 * its own.
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
   * with the cap its own binding met, and every end of a binding joined to one
   * of them in the global component of the connectors' ends, through what an
   * end redefines too ({@link pastCapComponents}): such a binding carries the
   * capped value on. Per component, never model-wide. Only a reading of one of
   * THESE ends answers the cap ({@link boundPartnerSafe},
   * {@link DefiningEquations.boundAbove}, {@link boundSourceIn},
   * {@link defaultStandsIn}); a deep binding no longer abstains every bound
   * read of the model.
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
  /** Each of them by the element it is written in, with its ends ({@link bindingsIntoRedefiners}). */
  written: ReadonlyArray<{ holder: ElementId; ends: readonly ElementId[] }>;
  /** Each of them, in the model's order ({@link componentConnectors}). */
  connectors: readonly ElementRecord[];
  /** Lazy indexes over `readings`, built when first asked ({@link indexOf}). */
  index?: BindingIndex;
  /** {@link bindingsIntoRedefiners}, built when first asked. */
  into?: ReadonlyMap<ElementId, ReadonlyArray<{ end: ElementId; holder: ElementId }>>;
  /**
   * The context roots of `readings` by the instance each reads its own
   * features in, each with its place in `readings` ({@link outermostReading}),
   * built when first asked.
   */
  byInstance?: ReadonlyMap<string, ReadonlyArray<{ root: ElementId; order: number }>>;
  /** What one component read in one root states and joins, per `${root} ${component}` ({@link componentFacts}). */
  components?: Map<string, ComponentFacts>;
  /** {@link boundSourceIn} per instance symbol, once per revision. */
  sources?: Map<string, BoundSource | undefined>;
  /** The {@link DefinitionHead} members of each package's binding reading, by root ({@link heldDefaults}). */
  heads: ReadonlyMap<ElementId, readonly DefinitionHead[]>;
  /** {@link outsideBindingsOf}, built when first asked. */
  outside?: ReadonlyMap<ElementId, readonly OutsideBinding[]>;
  /** {@link boundPartnerSafe} per `${contextId} ${name} ${featureId}`, once per revision. */
  partnerSafe?: Map<string, boolean>;
  /** {@link statedAgainstBoundSomewhere}'s features, built when first asked. */
  against?: ReadonlySet<ElementId>;
}

/**
 * What the component `component` read in the context `root` states and joins,
 * each worked out once per revision when first asked ({@link componentFacts}):
 * its member paths in reading order, the connectors that join it, what its
 * members state ({@link classified}), and the member whose default stands
 * there ({@link standingDefaultPath}).
 */
interface ComponentFacts {
  paths: readonly string[];
  connectors?: readonly ElementRecord[];
  /** The ids of {@link connectors}. */
  bindingIds?: readonly ElementId[];
  classified?: ComponentClass;
  standing?: { path: string; source: ElementRecord } | null;
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
  const read: Pick<BindingEnds, 'held' | 'readings' | 'cap' | 'unread' | 'enclosed' | 'heldIn' | 'heldSomewhere' | 'overCap' | 'heads'> =
    bindings.length > 0
      ? heldDefaults(model, bindings)
      : { held: new Set<ElementId>(), readings: new Map(), unread: new Set<ElementId>(), enclosed: new Set<ElementId>(), heldIn: new Set<string>(), heldSomewhere: new Set<ElementId>(), overCap: new Map(), heads: new Map() };
  const fresh: BindingEnds = {
    rev: model.rev,
    ends,
    ...read,
    partial: read.cap !== undefined,
    userBindings: bindings.length,
    edges,
    written: bindings.map((b) => ({ holder: b.ownerId!, ends: [...(b.source ?? []), ...(b.target ?? [])] })),
    connectors: bindings,
  };
  BINDING_ENDS.set(model, fresh);
  return fresh;
}

/**
 * The user's bindings that reach INTO a redefinition, by the feature it
 * redefines: each binding end, then each usage that owns it in turn — an
 * implicit connector-end copy (q2's `bind p.extra = E` makes q2's p, a copy of
 * Q's p, and its extra, a copy of P's), a redefinition of the user's own
 * (`part :>> p { bind extra = E; }`), the usage the binding is written in —
 * is filed, with the end and the element the binding is written in, under
 * every feature that usage redefines: Q's p, for A7's q2. A binding written in
 * the usage itself holds in every instance of it, and is filed under nothing
 * of it. An end that states a value of its own ({@link endValue}: `=`, or an
 * asserted equation that defines it — G340's `L == 2.0 * K` under `bind
 * r.q.p.load = r.q.L`) is no end a value is carried INTO: the binding carries
 * its value out, or states a second one (its own finding, `#bind`). Once per
 * revision ({@link DefiningEquations.boundAbove}).
 */
function bindingsIntoRedefiners(model: Model): ReadonlyMap<ElementId, ReadonlyArray<{ end: ElementId; holder: ElementId }>> {
  const ends = bindingEnds(model);
  if (ends.into) return ends.into;
  const into = new Map<ElementId, Array<{ end: ElementId; holder: ElementId }>>();
  for (const { holder, ends: ids } of ends.written) {
    const holderEl = model.get(holder);
    if (!holderEl) continue;
    for (const end of new Set(ids)) {
      const f = model.get(end);
      if (!f || endValue(model, f, holderEl, '').kind === 'value') continue;
      const seen = new Set<ElementId>();
      for (let o: ElementRecord | undefined = f; o && !seen.has(o.id); o = o.ownerId != null ? model.get(o.ownerId) : undefined) {
        if (seen.size > 0 && !isUsage(o.eClass)) break;
        seen.add(o.id);
        for (const g of redefinedClosure(model, o)) {
          if (g.id === o.id) continue;
          const list = into.get(g.id);
          if (list) list.push({ end, holder });
          else into.set(g.id, [{ end, holder }]);
        }
      }
    }
  }
  ends.into = into;
  return into;
}

/** Every feature a binding connector touches ({@link isBindingConnector}), once per model revision. */
export function bindingEndsOf(model: Model): ReadonlySet<ElementId> {
  return bindingEnds(model).ends;
}

/**
 * Does a binding of the user's join a feature of an instance enclosing where
 * it is written ({@link BindingEnds.enclosed}: R's `L` in `part q : Q { bind
 * p.load = L; }`)? Such a binding holds of every instance below that one —
 * r0's q, read through Q's p's own walk as `r0::q::p`, as much as r's — so the
 * engines that hold an instance's frames hold those above it too
 * ({@link enclosedBindingFrame}). Once per revision.
 */
export function hasEnclosedBindings(model: Model): boolean {
  return bindingEnds(model).enclosed.size > 0;
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

/**
 * The model's PART-VALUED bindings (`bind pp = top.a`, both ends parts,
 * items, ports — any usage but an attribute), once per revision. Such a
 * binding equates the two: `pp.load` IS `top.a.load`, where every surface
 * read pp's own `default` (a false verdict on all four, O5 S5). An end that
 * says nothing of its own — no feature, binding end, value or redefinition
 * below it or below what it redefines, no other feature redefining it, no
 * asserted relation reading through its name, one such binding only, no type
 * its partner lacks, and a feature of the element the binding is written in
 * unless that is a package — STANDS FOR its partner (`standsFor`: the
 * partner's path below the binding's owner, where it is resolved), when the
 * partner itself stands for nothing else: every chain through it reads the
 * partner, as a reference's value is read ({@link
 * DefiningEquations.subjectScope}). The partner then has everything both say.
 * Where neither end is so plain, each says something the other's reading
 * would miss (`unread`, the binding; `unreadEnds`, its ends): no relation row
 * that may read a value either carries is read ({@link equatedPartsRefusal}).
 * Nor is an end a reference's or a bound subject's value, or a `satisfy`,
 * lands on (`ref part r = pp`) plain: the walk reads such an end's own
 * features there, never through its binding. The sweep reads the model alone
 * — no binding reading and no scope — since the walk asks it.
 */
const EQUATED_PARTS = new WeakMap<
  Model,
  {
    rev: number;
    standsFor: ReadonlyMap<ElementId, { path: string; from: ElementId }>;
    unread: readonly ElementRecord[];
    unreadEnds: ReadonlySet<ElementId>;
    /** {@link equatedTaint}, built on first ask. */
    taint?: ReadonlyMap<ElementId, ElementRecord>;
  }
>();

/** The usages whose value naming another equates the two ({@link equatedParts}). */
const VALUED_PART_KINDS: ReadonlySet<string> = new Set(['PartUsage', 'PortUsage', 'ItemUsage']);

function equatedParts(model: Model): NonNullable<ReturnType<typeof EQUATED_PARTS.get>> {
  const hit = EQUATED_PARTS.get(model);
  if (hit && hit.rev === model.rev) return hit;
  const standsFor = new Map<ElementId, { path: string; from: ElementId }>();
  const unread: ElementRecord[] = [];
  const unreadEnds = new Set<ElementId>();
  const partLike = (e: ElementRecord | undefined): e is ElementRecord =>
    e !== undefined && isUsage(e.eClass) && e.eClass !== 'AttributeUsage';
  const pairs: Array<{ b: ElementRecord; f: ElementRecord; g: ElementRecord }> = [];
  const count = new Map<ElementId, number>();
  for (const b of model.all()) {
    if (!isBindingConnector(b) || b.attrs.isLibrary === true || b.ownerId == null) continue;
    const f = b.source?.[0] !== undefined ? model.get(b.source[0]) : undefined;
    const g = b.target?.[0] !== undefined ? model.get(b.target[0]) : undefined;
    if (!partLike(f) || !partLike(g) || f.id === g.id) continue;
    pairs.push({ b, f, g });
    for (const e of [f, g]) count.set(e.id, (count.get(e.id) ?? 0) + 1);
  }
  if (pairs.length > 0) {
    const redefined = new Set(
      [...model.ofKind('Redefinition'), ...model.ofKind('Subsetting')].flatMap((r) => r.target ?? []),
    );
    // The names a reference's or a bound subject's value, or a `satisfy`, lands on.
    const aimed = new Set<string>();
    for (const e of model.all()) {
      if (e.attrs.isLibrary === true || typeof e.attrs.value !== 'string') continue;
      if (e.attrs.isRef === true || e.attrs.requirementRole === 'subject') aimed.add(e.attrs.value.trim().split('.').pop()!);
    }
    for (const rel of model.ofKind('Satisfy')) {
      const s = rel.source?.[0] !== undefined ? model.get(rel.source[0]) : undefined;
      const n = s ? effectiveNameOf(model, s) : undefined;
      if (n !== undefined) aimed.add(n);
    }
    // The names an asserted relation reads a feature THROUGH (`pp` of `pp.load
    // == 3.0`): such a relation says something of the part.
    const through = new Set<string>();
    for (const c of model.all()) {
      if (c.attrs.isLibrary === true || !isAsserted(c) || typeof c.attrs.expression !== 'string') continue;
      for (const n of relationNamesOf(c.attrs.expression)) n.split('.').slice(0, -1).forEach((s) => through.add(s));
    }
    const kinds = (e: ElementRecord): Set<ElementId> =>
      new Set(generalizationsOf(model, e.id).filter((t) => isDefinition(t.eClass)).map((t) => t.id));
    // Each owner of `e` up to `holder` reads its features as written: no
    // reference or subject, no end of a part-valued binding.
    const cleanTo = (e: ElementRecord, holder: ElementId): boolean => {
      for (let o = e.ownerId != null ? model.get(e.ownerId) : undefined; o && o.id !== holder; o = o.ownerId != null ? model.get(o.ownerId) : undefined) {
        if (o.attrs.isRef === true || o.attrs.requirementRole === 'subject' || count.has(o.id)) return false;
      }
      return true;
    };
    const plain = (f: ElementRecord, g: ElementRecord, holder: ElementId): boolean => {
      if (count.get(f.id) !== 1 || count.get(g.id) !== 1 || redefined.has(f.id)) return false;
      const name = effectiveNameOf(model, f);
      if (name === undefined || through.has(name) || aimed.has(name)) return false;
      // Read below the binding's owner, the partner is resolved in that owner's
      // instance, which only a package has one of ({@link
      // DefiningEquations.equatedPart}).
      const owner = model.get(holder);
      if (f.ownerId !== holder && (!owner || isUsage(owner.eClass) || isDefinition(owner.eClass))) return false;
      for (const h of [f, ...redefinedClosure(model, f)]) {
        if (h.attrs.value !== undefined || h.attrs.requirementRole === 'subject') return false;
        if (model.children(h.id).some((c) => isUsage(c.eClass))) return false;
      }
      if (g.attrs.value !== undefined || g.attrs.requirementRole === 'subject') return false;
      const theirs = kinds(g);
      if ([...kinds(f)].some((t) => !theirs.has(t))) return false;
      return cleanTo(f, holder) && cleanTo(g, holder) && bindingEndPath(model, g.id, holder) !== undefined;
    };
    for (const { b, f, g } of pairs) {
      const holder = b.ownerId!;
      const [from, to] = plain(f, g, holder) ? [f, g] : plain(g, f, holder) ? [g, f] : [undefined, undefined];
      if (from && to) {
        standsFor.set(from.id, { path: bindingEndPath(model, to.id, holder)!, from: holder });
        continue;
      }
      unread.push(b);
      unreadEnds.add(f.id).add(g.id);
    }
  }
  // A part, port or item whose value names another (`part pp : T0 = top.a`)
  // equates the two as a binding does, and no surface reads through it: an
  // unread pair of its own, so no row that may read through it is read.
  for (const e of model.all()) {
    if (e.attrs.isLibrary === true || !VALUED_PART_KINDS.has(e.eClass) || e.attrs.isRef === true) continue;
    const v = e.attrs.value;
    if (e.ownerId == null || e.attrs.requirementRole === 'subject' || typeof v !== 'string' || isQuoted(v.trim())) continue;
    if (namesOfValue(v).length === 0) continue;
    unread.push(e);
    unreadEnds.add(e.id);
  }
  const fresh = { rev: model.rev, standsFor, unread, unreadEnds };
  EQUATED_PARTS.set(model, fresh);
  return fresh;
}

/**
 * What an unread part-valued binding ({@link equatedParts}) may carry a value
 * to, each with the binding, once per revision: its two ends and each usage
 * above an end up to where the binding is written; then, to a fixpoint, the
 * ends of every binding one end of which is, or is read through, one of them
 * (and each usage above such an end); every feature whose value reads
 * through one; the first link of each name an asserted relation reads beside
 * one; what redefines or subsets one; an equated part whose partner is one
 * ({@link DefiningEquations.equatedPart}); and a `satisfy` of one. A relation
 * read through none of them, for an instance below none of them, reads what
 * the binding carries nowhere ({@link equatedPartsRefusal}).
 */
function equatedTaint(model: Model): ReadonlyMap<ElementId, ElementRecord> {
  const parts = equatedParts(model);
  if (parts.taint) return parts.taint;
  const taint = new Map<ElementId, ElementRecord>();
  if (parts.unread.length === 0) return (parts.taint = taint);
  const defs = sharedDefinitions(model);
  const ownerOf = (e: ElementRecord): ElementRecord | undefined => (e.ownerId != null ? model.get(e.ownerId) : undefined);
  let grew = true;
  // `e`, and with `holder` each usage above it up to `holder`.
  const add = (e: ElementRecord, b: ElementRecord, holder?: ElementId): void => {
    for (let cur: ElementRecord | undefined = e; cur && cur.id !== holder; cur = ownerOf(cur)) {
      if (cur !== e && !isUsage(cur.eClass)) break;
      if (!taint.has(cur.id)) {
        taint.set(cur.id, b);
        grew = true;
      }
      if (holder === undefined) break;
    }
  };
  const users = model.all().filter((el) => el.attrs.isLibrary !== true);
  const bindings = users.filter((el) => isBindingConnector(el) && el.ownerId != null);
  const valued = users.filter((el) => isUsage(el.eClass) && typeof el.attrs.value === 'string');
  const asserted = users.filter((el) => isAsserted(el) && typeof el.attrs.expression === 'string');
  const narrowing = [...model.ofKind('Redefinition'), ...model.ofKind('Subsetting')];
  for (const b of parts.unread) {
    if (!isBindingConnector(b)) add(b, b);
    for (const id of [b.source?.[0], b.target?.[0]]) {
      const end = id !== undefined ? model.get(id) : undefined;
      if (end) add(end, b, b.ownerId!);
    }
  }
  const endsOf = (b: ElementRecord): ElementRecord[] =>
    [b.source?.[0], b.target?.[0]].flatMap((id) => (id !== undefined ? (model.get(id) ?? []) : []));
  while (grew) {
    grew = false;
    for (const b of bindings) {
      const ends = endsOf(b);
      const hit = ends
        .map((e) => taintedAt(model, taint, e) ?? readsTainted(model, taint, [b.ownerId!], bindingEndPath(model, e.id, b.ownerId!)))
        .find((x) => x !== undefined);
      if (hit) for (const e of ends) add(e, hit, b.ownerId!);
    }
    for (const f of valued) {
      const hit = namesOfValue(f.attrs.value as string)
        .map((n) => readsTainted(model, taint, [f.ownerId!], n))
        .find((x) => x !== undefined);
      if (hit) add(f, hit);
    }
    for (const a of asserted) {
      const roots = [a.ownerId, a.id].filter((x): x is ElementId => x != null);
      const names = relationNamesOf(a.attrs.expression as string);
      const hit = names.map((n) => readsTainted(model, taint, roots, n)).find((x) => x !== undefined);
      if (!hit) continue;
      for (const n of names) {
        const head = n.split('.')[0]!;
        for (const r of roots) {
          const d = defs.denote(r).get(head);
          if (d) add(d.feature, hit);
        }
      }
    }
    for (const r of narrowing) {
      const target = r.target?.[0] !== undefined ? model.get(r.target[0]) : undefined;
      const source = r.source?.[0] !== undefined ? model.get(r.source[0]) : undefined;
      const hit = target ? taintedAt(model, taint, target) : undefined;
      if (hit && source) add(source, hit);
    }
    for (const [id, { path, from }] of parts.standsFor) {
      const end = model.get(id);
      const hit = readsTainted(model, taint, [from], path);
      if (end && hit) add(end, hit);
    }
    for (const rel of model.ofKind('Satisfy')) {
      const s = rel.source?.[0] !== undefined ? model.get(rel.source[0]) : undefined;
      const hit = s ? taintedAt(model, taint, s) : undefined;
      if (hit) add(rel, hit);
    }
  }
  parts.taint = taint;
  return taint;
}

/** The binding whose value `e`, or a usage above it, may carry ({@link equatedTaint}). */
function taintedAt(model: Model, taint: ReadonlyMap<ElementId, ElementRecord>, e: ElementRecord | undefined): ElementRecord | undefined {
  const seen = new Set<ElementId>();
  for (let cur = e; cur && !seen.has(cur.id); cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
    seen.add(cur.id);
    const hit = taint.get(cur.id);
    if (hit) return hit;
    if (!isUsage(cur.eClass)) return undefined;
  }
  return undefined;
}

/**
 * The binding a dotted `name` read in `roots` (the first that resolves its
 * first link, else each namespace enclosing the first root) carries a value
 * through: a link that denotes a feature of {@link equatedTaint}, or is read
 * in one (a reference's `r.load` read in the `pp` it names).
 */
function readsTainted(
  model: Model,
  taint: ReadonlyMap<ElementId, ElementRecord>,
  roots: readonly ElementId[],
  name: string | undefined,
): ElementRecord | undefined {
  if (name === undefined || roots.length === 0) return undefined;
  const defs = sharedDefinitions(model);
  const segments = name.split('.');
  let scopes = roots.filter((r) => defs.denote(r).has(segments[0]!));
  if (scopes.length === 0) {
    scopes = [];
    const seen = new Set<ElementId>();
    for (let o = model.get(roots[0]!)?.ownerId ?? null; o != null && !seen.has(o); o = model.get(o)?.ownerId ?? null) {
      seen.add(o);
      scopes.push(o);
    }
  }
  for (const r of scopes) {
    const denoted = defs.denote(r);
    for (let k = 1; k <= segments.length; k++) {
      const d = denoted.get(segments.slice(0, k).join('.'));
      const hit = d ? (taintedAt(model, taint, d.feature) ?? taintedAt(model, taint, model.get(d.reader))) : undefined;
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Why a relation row of `model` is not read ({@link equatedParts}), or
 * `undefined`: the row may read a value a part-valued binding neither end of
 * which stands for the other carries ({@link equatedTaint}) — a name of
 * `expression` read in its context (`at.contextId`; for its own row, where
 * the relation is written) through such a feature, or the instance it is read
 * for (that context, or `at.path`) at or below one. Each part says something
 * of its own that the other's reading would miss. Every surface leaves such a
 * row undecided in this sentence (`checkConstraints` of ./evaluate-model,
 * `numericRows` of ./solver, `obligationsOf` of ./obligations); any other row
 * reads as before.
 */
export function equatedPartsRefusal(
  model: Model,
  relationId: ElementId,
  expression: string,
  at?: { contextId: ElementId; path?: string },
): string | undefined {
  const { unread } = equatedParts(model);
  if (unread.length === 0) return undefined;
  const names = relationNamesOf(expression);
  if (names.length === 0) return undefined;
  const taint = equatedTaint(model);
  const rel = model.get(relationId);
  const context = at ? model.get(at.contextId) : rel;
  const roots = [at ? at.contextId : rel?.ownerId, relationId].filter((x): x is ElementId => x != null);
  let b = names.map((n) => readsTainted(model, taint, roots, n)).find((x) => x !== undefined);
  b ??= taintedAt(model, taint, context);
  if (!b && at?.path !== undefined) {
    const frames = sharedDefinitions(model).framesAbove(at.path);
    b = frames === undefined ? unread[0] : frames.map((fr) => taintedAt(model, taint, model.get(fr.reader))).find((x) => x !== undefined);
  }
  if (!b) return undefined;
  if (!isBindingConnector(b)) {
    return (
      `\`${effectiveNameOf(model, b) ?? b.id} = ${String(b.attrs.value).trim()}\` in ${effectiveQualifiedName(model, b.ownerId!)} ` +
      'values a part, port or item with another, which equates the two as a binding does; this tool does not read ' +
      'through such a value, so no relation that may read a value it carries is read'
    );
  }
  const [l, r] = [b.source?.[0], b.target?.[0]].map((id) => (id !== undefined ? bindingEndPath(model, id, b.ownerId!) : undefined));
  const ends = l !== undefined && r !== undefined ? `\`bind ${l} = ${r}\`` : 'a binding';
  return (
    `${ends} in ${effectiveQualifiedName(model, b.ownerId!)} equates two parts, ports or items; this tool reads ` +
    'such a binding only where one says nothing of its own and is bound once, as the other, and neither is ' +
    'here, so no relation that may read a value it carries is read'
  );
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
 * every instance — but a literal `default` an asserted equation overrides (H5)
 * is the equation's value, read where the context changes what it reads: Q's
 * `L default = 7.0` under Q's `assert { L == 2.0 * K }` is q1's 50 where q1's K
 * is 25 (P5H).
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
  if ((typeof v === 'number' || typeof v === 'boolean') && !assertHeld(model).has(f.id)) return undefined;
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
  // Once per revision: every instance row of a group reads the usage's names
  // through the usage, and asks the same question of it.
  const memo = (ends.partnerSafe ??= new Map());
  const key = `${contextId} ${name} ${featureId}`;
  let safe = memo.get(key);
  if (safe === undefined) {
    safe = partnerSafeOf(model, ends, contextId, name, featureId);
    memo.set(key, safe);
  }
  return safe;
}

/** {@link boundPartnerSafe}, worked out. */
function partnerSafeOf(model: Model, ends: BindingEnds, contextId: ElementId, name: string, featureId: ElementId): boolean {
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
  if (assertFrameOnly(definitions.model, above)) {
    return (
      `the relation is read in ${where}, and an asserted equation of ${definitions.contextName(above.id)} above it ` +
      'defines what it reads there: each instance reads it otherwise, and this tool reads it for one alone, so it is not carried'
    );
  }
  return (
    `the relation is read in ${where}, and a binding above it joins what it reads to another value in ` +
    `${definitions.contextName(above.id)}: each instance reads it otherwise, and this tool reads it for one ` +
    'alone, so it is not carried'
  );
}

/** Why a context listed only for a binding member's own value there is not read at its instance. */
export type BoundHere = 'two-values' | 'unread';

/**
 * Why a relation is not read in the context `contextId`, which reads it
 * otherwise only because a binding member's value is its own there ({@link
 * DefiningEquations.readsBoundOnly}): beside another member that states a
 * value there, or over a binding not read there ({@link
 * DefiningEquations.boundStatedTwiceIn}) — the sentence every surface leaves
 * that reading undecided with.
 */
export function boundHereSentence(definitions: DefiningEquations, contextId: ElementId, why: BoundHere): string {
  const where = definitions.contextName(contextId);
  return why === 'two-values'
    ? `the relation is read in ${where}, and a binding joins what it reads to a value ${where} reads as its own ` +
        'and to another value the model states there: this tool reads neither of two values, so it is not carried'
    : `the relation is read in ${where}, and a binding joins what it reads to a value ${where} reads as its own: ` +
        `this tool reads that binding in no instance of ${where}, so it is not carried`;
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
  if (el.ownerId == null || !readsPerInstance(model)) return undefined;
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
): Pick<BindingEnds, 'held' | 'readings' | 'cap' | 'unread' | 'enclosed' | 'heldIn' | 'heldSomewhere' | 'overCap' | 'heads'> {
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
  // The feature at `path` in `root`, and the path as `root` spells it: a
  // segment a renamed redefinition answers to (`part pp :>> p` in `part q :
  // Q`, under Q's `bind p.load = L`) by that redefinition's own name — q's
  // `pp.load`, the instance every surface reads (H5, E8: R13).
  const resolve = (root: ElementId, path: string): { f: ElementRecord; path: string } | undefined => {
    let owner = root;
    let f: ElementRecord | undefined;
    const spelled: string[] = [];
    for (const seg of path.split('.')) {
      f = definitions.byName(owner).get(seg);
      if (!f) return undefined;
      spelled.push(definitions.nameOf(f) ?? seg);
      owner = f.id;
    }
    return f ? { f, path: spelled.join('.') } : undefined;
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
        const hit = resolve(root.id, full);
        return hit ? [hit.path, hit.f] : undefined;
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
  if (overCap.size > 0) pastCapComponents(model, bindings, overCap, holdEnds);
  const readings = new Map<ElementId, Map<string, { feature: ElementId; component: string }>>();
  const { heads, byRedefined } = headsOfReadings(model, definitions, contexts, (rootId, path) => find(contexts.get(rootId)!.parent, path));
  // The names an owner's asserted equations define, once per owner ({@link fallsToDefault}).
  const asserted = new Map<ElementId, ReadonlySet<string>>();
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
    for (const [key, members] of components) {
      // A package's binding on a DEFINITION's feature (w4, {@link
      // definitionHeadMatch}) holds in every instance of the definition, and
      // so over every feature that redefines that one with a value of its own
      // (`part p3 : P { attribute :>> load default = 7.0; }` under `bind
      // P::load = L`): each is a member's value too. Two such members (`bind
      // P::load = P::cap`) are read per instance, and no default of theirs is
      // the component's one value; nor is any where an instance's slot is
      // fixed outside the component ({@link DefinitionHead.fixed}).
      const mine = (heads.get(rootId) ?? []).filter((h) => h.component === key);
      const redefiners = mine.length > 0 ? [...new Set(mine.flatMap((h) => byRedefined?.get(h.feature) ?? []))] : [];
      // One default per MEMBER, not per source: R3a's `A::v` read at a1.v and
      // at a2.v is two readings of `2.0 * K`, one per instance.
      const defaults = [
        ...members.flatMap((m) => (m.value.kind === 'default' ? [m.value.source] : [])),
        ...redefiners.filter((r) => r.attrs.defaultValue === true),
      ];
      if (defaults.length === 0) continue;
      const stated = members.some((m) => m.value.kind === 'value') || mine.some((h) => h.fixed !== undefined);
      if (stated || mine.length > 1 || !defaultsAgree(defaults)) {
        for (const r of redefiners) if (r.attrs.defaultValue === true) holdDefault(model, held, heldIn, heldSomewhere, r);
        for (const m of members)
          if (m.value.kind === 'default')
            holdDefault(
              model,
              held,
              heldIn,
              heldSomewhere,
              m.f,
              heldInstance(definitions, rootId, m.path),
              fallsToDefault(model, m.f, root, m.path, asserted),
            );
      }
    }
  }
  return { held, readings, unread, enclosed, heldIn, heldSomewhere, overCap, heads, ...(cap !== undefined ? { cap } : {}) };
}

/**
 * Past a cap, a binding is read in fewer contexts than it holds in — and the
 * value it gives in a context left out still reaches every feature joined to
 * its ends there, whatever binding joins them: CAP1's `bind Y = top.a.….a.load`,
 * read in the package, joins Y's `default = 1.0` to the load T1's `bind a.load
 * = L` gives X's 50 thirty-three usages down, a binding past the segment cap
 * (the package is the context left out). Read as one component in the package,
 * Y and the load's fall-through were two defaults that agree, and Y stood at
 * 1 (`Y >= 40.0` refuted where it holds). So the cap reaches the whole GLOBAL
 * component of the connectors' ends — their union-find over every user
 * binding, each end joined to every other binding's end it redefines ({@link
 * redefinedClosure}), since the end the package's binding reads at that path
 * redefines the one T1's joins: every end in a component with an end past a
 * cap is past that cap too (`overCap`, the first cap the component met), and
 * every default in it is held (`holdEnds`). The readings that consult
 * `overCap` — {@link boundSourceIn}, {@link defaultStandsIn}, {@link
 * boundPartnerSafe}, {@link DefiningEquations.boundAbove} — then abstain on
 * every one of them, never on a binding the capped one does not reach. A
 * feature no binding names joins nothing: U's `bind a.load = M` on its own
 * `part a : T0` redefines T0's load, as T1's capped end does, and joined
 * through it U's M and load were held past a cap that is not theirs — free
 * to the numeric lane, which then solved `u.a.load == 9.0` as a design
 * equation where both are U's default of 1 (CAPU2).
 */
function pastCapComponents(
  model: Model,
  bindings: readonly ElementRecord[],
  overCap: Map<ElementId, BindingCap>,
  holdEnds: (holder: ElementRecord, ids: readonly ElementId[]) => void,
): void {
  const parent = new Map<ElementId, ElementId>();
  const find = (a: ElementId): ElementId => {
    if (!parent.has(a)) parent.set(a, a);
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (a !== root) {
      const next = parent.get(a)!;
      parent.set(a, root);
      a = next;
    }
    return root;
  };
  const union = (a: ElementId, b: ElementId): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };
  const joined: Array<{ holder: ElementRecord; pair: readonly [ElementId, ElementId] }> = [];
  for (const b of bindings) {
    const holder = model.get(b.ownerId!);
    const left = b.source?.[0];
    const right = b.target?.[0];
    if (!holder || left === undefined || right === undefined || left === right) continue;
    joined.push({ holder, pair: [left, right] as const });
  }
  const ends = new Set<ElementId>(joined.flatMap(({ pair }) => pair));
  for (const { pair } of joined) {
    union(pair[0], pair[1]);
    // Through what an end redefines only where that is another binding's end: a feature of a
    // definition no binding names (T0's `load`) is redefined in every instance that binds it, and
    // joined through it two instances' bindings were one component.
    for (const id of pair) {
      const f = model.get(id);
      if (f) for (const g of redefinedClosure(model, f)) if (ends.has(g.id)) union(id, g.id);
    }
  }
  const capped = new Map<ElementId, BindingCap>();
  for (const [id, met] of overCap) {
    const root = find(id);
    if (!capped.has(root)) capped.set(root, met);
  }
  for (const { holder, pair } of joined) {
    const met = capped.get(find(pair[0]));
    if (met === undefined) continue;
    for (const id of pair) if (!overCap.has(id)) overCap.set(id, met);
    holdEnds(holder, pair);
  }
}

/**
 * Hold the default a binding overrides — and, for `inst`, the instance at
 * which a held member falls through to the redefined feature's own
 * `default`. Reading `P::a` generically where a redefinition of it
 * (`part :>> p { attribute :>> a default = 50.0; }`) is held would read the
 * redefined feature's default beside the binding there (`held-redef`): the
 * original's default gives way at that instance alone
 * ({@link defaultGivesWayIn}), so other instances of P keep it. So does a
 * held member that states nothing and reads the redefined default
 * (`fallsThrough`, {@link fallsToDefault}): the implicit end copy q2's `bind
 * p.extra = E` makes of P's `extra default = 0.0` (A4) holds P's extra at
 * q2's p, though the copy writes no default.
 */
function holdDefault(
  model: Model,
  held: Set<ElementId>,
  heldIn: Set<string>,
  heldSomewhere: Set<ElementId>,
  f: ElementRecord,
  inst?: string,
  fallsThrough = false,
): void {
  held.add(f.id);
  // A held redefinition falls through to the default it redefines when read
  // generically: that default is per instance — heldSomewhere, not held — so
  // the reading surfaces suppress it only at the instance (`defaultGivesWayIn`)
  // while the numeric and SMT lanes key it per instance.
  for (const g of redefinedClosure(model, f)) if (g.attrs.defaultValue === true) heldSomewhere.add(g.id);
  // A held member that WRITES a default suppresses the redefined feature at
  // that instance, and so does one that writes nothing and falls through to
  // it: read there, the redefined default was a decided answer a binding
  // overrides (A4: P's extra of 0 at q2's p, against q2's E of 20, the SMT
  // lane's instance value row beside the binding's). A valueless end copy
  // redefining a feature an asserted equation defines (GA6's `p.load`) does
  // not ({@link fallsToDefault}): its fall-through reads the assert.
  if (inst !== undefined && (f.attrs.defaultValue === true || fallsThrough)) heldIn.add(inst);
}

/** The instance spelling of the member at `path` read in the frame rooted at `rootId` — or `undefined` for one no path spells. */
function heldInstance(definitions: DefiningEquations, rootId: ElementId, path: string): string | undefined {
  if (path.startsWith('#')) return undefined;
  return `${definitions.instanceNameOf(rootId)}::${path.split('.').join('::')}`;
}

const ASSERT_HELD = new WeakMap<Model, { rev: number; held: ReadonlySet<ElementId> }>();

/**
 * The features whose `default` an asserted EQUATION overrides (H5, plan J
 * decision 14), once per revision: `attribute L default = 2.0` beside `assert
 * constraint { L == 5.0 }` is L = 5 on every surface, exactly as a binding
 * overrides a default (decision 10). A feature is held when an asserted
 * equation of its owner, or of a general type of its owner, defines its
 * effective name — or one of a feature it redefines, under that feature's
 * name: Q's `assert { L == 5.0 }` holds q's `:>> L default = 9.0` too (HR).
 * The equation is the LOCAL rule only; one written in an enclosing context
 * (`part q1 : Q { assert { p.x == 50.0 } }`) is read per instance (S3).
 *
 * The equation defines the default's feature only where its other side has
 * a value of its own that does not read that feature back: a name-free side,
 * or one whose every name is a feature with a value (`=`, or a `default`),
 * not the feature itself, and whose value reads none of it in turn. Where the other side reads a feature with no value,
 * the equation defines THAT feature from the default, as it always did (`L
 * == M`, M valueless: M = L's default). Two defaults an equation sets equal
 * (`L == K`) each give way, so neither is read: the value is undecided (U7).
 * An inequality defines nothing, and the default stands (U5): the assert is
 * checked against it. A plain `=` value never gives way: against an assert
 * that contradicts it, it is the strict-KerML contradiction (decision 1).
 */
function assertHeld(model: Model): ReadonlySet<ElementId> {
  const hit = ASSERT_HELD.get(model);
  if (hit && hit.rev === model.rev) return hit.held;
  const held = new Set<ElementId>();
  const owners = new Set<ElementId>();
  const defaults: ElementRecord[] = [];
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    if (isAsserted(el) && el.ownerId != null) owners.add(el.ownerId);
    else if (el.attrs.defaultValue === true && el.attrs.value !== undefined && el.attrs.value !== null) defaults.push(el);
  }
  if (owners.size > 0) {
    const named = new Map<ElementId, ReadonlyMap<string, ElementRecord>>();
    const parsed = new Map<ElementId, Map<string, DefiningEquation[]>>();
    const equationsOf = (ownerId: ElementId): Map<string, DefiningEquation[]> => {
      let m = parsed.get(ownerId);
      if (!m) parsed.set(ownerId, (m = equationsByName(model, ownerId)));
      return m;
    };
    const featuresOf = (ownerId: ElementId): ReadonlyMap<string, ElementRecord> => {
      let m = named.get(ownerId);
      if (!m) {
        const byName = new Map<string, ElementRecord>();
        for (const h of [...ownFeatures(model, ownerId), ...effectiveFeatures(model, ownerId)]) {
          const n = effectiveNameOf(model, h);
          if (n !== undefined && !byName.has(n)) byName.set(n, h);
        }
        named.set(ownerId, (m = byName));
      }
      return m;
    };
    // The other side has a value of its own that does not read `name` back,
    // through the values it reads in turn (`K = L; M = K * 2.0` beside `L ==
    // M` reads L back: the default stands, IND). A name with no value, a
    // dotted one, or a cycle is no value of its own.
    const valued = (ownerId: ElementId, eq: DefiningEquation, name: string): boolean => {
      const seen = new Map<string, boolean>();
      const independent = (n: string): boolean => {
        const hit = seen.get(n);
        if (hit !== undefined) return hit;
        seen.set(n, false);
        let answer = false;
        if (n !== name && !n.includes('.')) {
          const h = featuresOf(ownerId).get(n);
          const g = h && [h, ...redefinedClosure(model, h)].find((x) => x.attrs.value !== undefined && x.attrs.value !== null);
          const v = g?.attrs.value;
          answer = v !== undefined && v !== null && (typeof v !== 'string' || namesOfValue(v).every(independent));
          // A name the owner's owners declare (E3): a constant written with `=` is a value of its own.
          if (!h) answer = lexicalConstant(model, ownerId, n) !== undefined;
        }
        seen.set(n, answer);
        return answer;
      };
      return refsIn(eq.definition, eq.literals).every(independent);
    };
    for (const f of defaults) {
      const hit = [f, ...redefinedClosure(model, f)].some((g) => {
        const name = effectiveNameOf(model, g);
        if (name === undefined || g.ownerId == null) return false;
        return [g.ownerId, ...generalizationsOf(model, g.ownerId).map((t) => t.id)].some(
          (o) => owners.has(o) && (equationsOf(o).get(name) ?? []).some((eq) => valued(o, eq, name)),
        );
      });
      if (hit) held.add(f.id);
    }
  }
  ASSERT_HELD.set(model, { rev: model.rev, held });
  return held;
}

/**
 * The attribute a bare name `n` reads in `contextId` through the owners of the
 * element that writes it (E3, {@link DefiningEquations.lexicalFeature}), where
 * it is a CONSTANT written with `=` — a number, a boolean, or an expression
 * that parses and reads no name: a value of its own for an asserted equation
 * over a `default` ({@link assertHeld}, {@link enclosingAsserts}), LA4's
 * package `L = 50.0` for p's `x == L`. `undefined` for any other name.
 */
function lexicalConstant(model: Model, contextId: ElementId, n: string): ElementRecord | undefined {
  const definitions = sharedDefinitions(model);
  const f = definitions.lexicalFeature(contextId, n);
  if (!f || f.attrs.defaultValue === true) return undefined;
  // Only where the context's own scope reads the name as that feature: a unique feature nested below the
  // context answers it first (`part p : P` with P's `K`, beside the package's `K`: NX1), and that is read.
  if (definitions.denote(contextId).get(n)?.feature.id !== f.id) return undefined;
  const v = f.attrs.value;
  if (typeof v === 'number' || typeof v === 'boolean') return f;
  return typeof v === 'string' && !isQuoted(v.trim()) && parseRelationBody(v.trim()) && namesOfValue(v).length === 0 ? f : undefined;
}

/**
 * The asserted equations that define a `default` in the INSTANCES an element
 * stands for (H5's enclosing rule, plan J decision 14), once per revision:
 * per element that writes them, by the path — dotted or bare — each defines,
 * and the defaulted features those paths end at. `part q1 : Q { assert
 * constraint { p.x == 50.0 } }` over P's `x default = 2.0` makes q1's p's x
 * 50, while every other P keeps 2; so does the package's `assert constraint {
 * q1.p.x == 50.0 }`, and Q2's `p.x == 50.0` in every Q2 (`q1 : Q2`). An
 * equation whose other side is a value of its own — name-free, or over names
 * written with `=` that do not read the path back — gives it that value. One
 * whose other side reads a `default` (q1's `p.x == L` over q1's `L default =
 * 9.0`) gives it none: both defaults give way there and neither is read
 * (`undecided`, U7) — L's is filed under its own name. Never a dotted name on
 * the other side. Not past a feature a binding joins or a part a value
 * equates (`part r = s`), nor onto an end a binding joins: the binding's
 * value is read there, and the assert is checked against it (RB). Not past a
 * reference or a subject, nor past a part some usage redefines as one or with
 * a value (`ref part :>> r = p1`, `part :>> p = other`): the instance there
 * may be another one altogether, which no path below the frame reads, so the
 * default stands, as before H5. A bare
 * equation over a default the local rule already holds ({@link assertHeld})
 * is filed, for two values, but splits no instance.
 */
interface EnclosingAsserts {
  byOwner: ReadonlyMap<ElementId, ReadonlyMap<string, readonly DefiningEquation[]>>;
  /** Per owner and path, the feature each segment names — matched by identity where an instance renames one ({@link assertDefinitionsAt}). */
  chains: ReadonlyMap<ElementId, ReadonlyMap<string, readonly ElementId[]>>;
  features: ReadonlySet<ElementId>;
  /**
   * The asserted relations among them whose other side reads a `default`, with the names that read one:
   * where such a name still reads a `default` in the frame, they give no value ({@link assertDefinitionIn}).
   */
  undecided: ReadonlyMap<ElementId, readonly string[]>;
  /** The `default`s such a relation sets equal to the path's (q1's L, with what each redefines), by the element that writes it. */
  partners: ReadonlyMap<ElementId, ElementId>;
  /**
   * Each such path read from the element that writes it: the features it
   * passes through (`through`, with what each redefines and what redefines
   * it — q's `part pp :>> p`) and the one it ends at (`end`, likewise) — the
   * usages whose instances it reads otherwise.
   */
  paths: ReadonlyArray<{ owner: ElementId; through: ReadonlySet<ElementId>; end: ReadonlySet<ElementId> }>;
  /** {@link assertHeldEverywhere} per feature, when first asked. */
  everywhere: Map<ElementId, boolean>;
}

const ENCLOSING_ASSERTS = new WeakMap<Model, { rev: number; index: EnclosingAsserts }>();

function enclosingAsserts(model: Model): EnclosingAsserts {
  const hit = ENCLOSING_ASSERTS.get(model);
  if (hit && hit.rev === model.rev) return hit.index;
  const byOwner = new Map<ElementId, Map<string, DefiningEquation[]>>();
  const chains = new Map<ElementId, Map<string, ElementId[]>>();
  const features = new Set<ElementId>();
  const undecided = new Map<ElementId, string[]>();
  const partnerOf = new Map<ElementId, ElementId>();
  const paths: Array<{ owner: ElementId; through: Set<ElementId>; end: Set<ElementId> }> = [];
  const owners = new Set<ElementId>();
  const ends = new Set<ElementId>();
  for (const el of model.all()) {
    if (isBindingConnector(el)) for (const id of [...(el.source ?? []), ...(el.target ?? [])]) ends.add(id);
    else if (el.attrs.isLibrary !== true && isAsserted(el) && el.ownerId != null) owners.add(el.ownerId);
  }
  // The user's usages by each feature they redefine, through any number of redefinitions — built when first asked.
  let redefining: Map<ElementId, ElementRecord[]> | undefined;
  const redefinersOf = (id: ElementId): readonly ElementRecord[] => {
    if (!redefining) {
      redefining = new Map();
      for (const x of model.all()) {
        if (x.attrs.isLibrary === true || !isUsage(x.eClass)) continue;
        for (const g of redefinedClosure(model, x)) {
          const list = redefining.get(g.id);
          if (list) list.push(x);
          else redefining.set(g.id, [x]);
        }
      }
    }
    return redefining.get(id) ?? [];
  };
  // A reference, a subject, or a part some usage redefines as one or with a value: another instance may stand there.
  const elsewhere = (h: ElementRecord): boolean =>
    [h, ...redefinedClosure(model, h)].some((g) => g.attrs.isRef === true || g.attrs.requirementRole === 'subject') ||
    redefinersOf(h.id).some((x) => x.attrs.isRef === true || (x.attrs.value !== undefined && x.attrs.value !== null));
  const named = new Map<ElementId, ReadonlyMap<string, ElementRecord>>();
  const featuresOf = (ownerId: ElementId): ReadonlyMap<string, ElementRecord> => {
    let m = named.get(ownerId);
    if (!m) {
      const byName = new Map<string, ElementRecord>();
      for (const h of [...ownFeatures(model, ownerId), ...effectiveFeatures(model, ownerId)]) {
        const n = effectiveNameOf(model, h);
        if (n !== undefined && !byName.has(n)) byName.set(n, h);
      }
      named.set(ownerId, (m = byName));
    }
    return m;
  };
  const valueOf = (h: ElementRecord): ElementRecord | undefined =>
    [h, ...redefinedClosure(model, h)].find((x) => x.attrs.value !== undefined && x.attrs.value !== null);
  const bound = (h: ElementRecord): boolean => [h, ...redefinedClosure(model, h)].some((g) => ends.has(g.id));
  const local = assertHeld(model);
  // The other side's names, each a value written in `ownerId` (a `default` too) that reads `path` back
  // through no name it reads in turn — and the defaulted features among them, through `=` values too, but
  // for one the local rule holds (its equation's value). `undefined` where one is not (a dotted name, a
  // name with no value, a cycle). A bare name the owner's owners declare (E3) is a value of its own where
  // it is read there as a constant written with `=` ({@link lexicalConstant}); one they declare that is not
  // read so gives the path no value either (`unread`, filed as undecided: it abstains, LA1).
  const unread = new Map<DefiningEquation, string[]>();
  const valued = (ownerId: ElementId, eq: DefiningEquation, path: string): ElementRecord[] | undefined => {
    const seen = new Map<string, boolean>();
    const defaults: ElementRecord[] = [];
    const independent = (n: string): boolean => {
      const known = seen.get(n);
      if (known !== undefined) return known;
      seen.set(n, false);
      // Not a name the owner's scope reads as a feature nested below it (`part r : R` with R's `K`, beside
      // the package's `K`: NX4): it gives the path no value of its own.
      const scoped = !n.includes('.') ? sharedDefinitions(model).denote(ownerId).get(n) : undefined;
      const lexical = scoped === undefined || scoped.feature.id === sharedDefinitions(model).lexicalFeature(ownerId, n)?.id;
      if (n !== path && !n.includes('.') && !featuresOf(ownerId).has(n) && lexical) {
        const outer = lexicalConstant(model, ownerId, n) !== undefined || resolveFullName(model, n, ownerId) !== undefined;
        if (outer && lexicalConstant(model, ownerId, n) === undefined) unread.set(eq, [...(unread.get(eq) ?? []), n]);
        seen.set(n, outer);
        return outer;
      }
      const h = n !== path && !n.includes('.') ? featuresOf(ownerId).get(n) : undefined;
      const g = h && valueOf(h);
      const v = g?.attrs.value;
      const answer = g !== undefined && v !== undefined && v !== null && (typeof v !== 'string' || namesOfValue(v).every(independent));
      if (answer && g.attrs.defaultValue === true && !local.has(g.id)) defaults.push(h!);
      seen.set(n, answer);
      return answer;
    };
    return refsIn(eq.definition, eq.literals).every(independent) ? defaults : undefined;
  };
  const file = (
    o: ElementId,
    path: string,
    equations: readonly DefiningEquation[],
    end: ElementRecord,
    through: Set<ElementId>,
    chain: readonly ElementId[],
  ): void => {
    let m = byOwner.get(o);
    if (!m) byOwner.set(o, (m = new Map()));
    const list = m.get(path);
    if (list) list.push(...equations.filter((eq) => !list.includes(eq)));
    else m.set(path, [...equations]);
    let c = chains.get(o);
    if (!c) chains.set(o, (c = new Map()));
    c.set(path, [...chain]);
    // A bare name the local rule holds already is read by its equation everywhere: no instance of its own.
    if (!path.includes('.') && local.has(valueOf(end)!.id)) return;
    const closure = new Set([end, ...redefinedClosure(model, end)].map((g) => g.id));
    for (const id of closure) features.add(id);
    // What redefines the path's own features — never a sibling's redefinition of what they redefine.
    const read = new Set(closure);
    for (const x of redefinersOf(end.id)) read.add(x.id);
    for (const id of chain.slice(0, -1)) for (const x of redefinersOf(id)) through.add(x.id);
    paths.push({ owner: o, through, end: read });
  };
  for (const o of owners) {
    const byName = equationsByName(model, o);
    for (const [path, equations] of byName) {
      let read = equations.map((eq) => ({ eq, defaults: valued(o, eq, path) })).filter((r) => r.defaults !== undefined);
      if (read.length === 0) continue;
      // The feature the path ends at, read from `o` segment by segment.
      let end: ElementRecord | undefined;
      let cur: ElementId = o;
      const through = new Set<ElementId>();
      const chain: ElementId[] = [];
      const segments = path.split('.');
      for (const [i, segment] of segments.entries()) {
        const h = featuresOf(cur).get(segment);
        if (!h || bound(h)) break;
        chain.push(h.id);
        if (i === segments.length - 1) end = h;
        else if (valueOf(h) !== undefined || elsewhere(h)) break;
        else for (const g of [h, ...redefinedClosure(model, h)]) through.add(g.id);
        cur = h.id;
      }
      const holder = end && valueOf(end);
      if (!holder || holder.attrs.defaultValue !== true) continue;
      // Over a `default` the other side reads, the equation gives no value (U7): that default gives way
      // with this one — unless a binding joins it, whose value is read (the equation then stays unread).
      // A bare name the local rule holds keeps its reading (`L == 2.0 * K`: L is twice K's default).
      if (!path.includes('.') && local.has(holder.id)) read = read.filter((r) => r.defaults!.length === 0 && !unread.has(r.eq));
      if (read.length === 0) continue;
      const partners = read.flatMap((r) => r.defaults!);
      if (partners.some(bound)) continue;
      for (const r of read) {
        const names = undecided.get(r.eq.constraint.id) ?? [];
        for (const n of unread.get(r.eq) ?? []) if (!names.includes(n)) names.push(n);
        if (names.length > 0) undecided.set(r.eq.constraint.id, names);
        if (r.defaults!.length === 0) continue;
        for (const h of r.defaults!) {
          const n = effectiveNameOf(model, h);
          if (n !== undefined && !names.includes(n)) names.push(n);
        }
        undecided.set(r.eq.constraint.id, names);
      }
      file(o, path, read.map((r) => r.eq), end!, through, chain);
      for (const h of partners) {
        const n = effectiveNameOf(model, h);
        if (n === undefined) continue;
        const own = (byName.get(n) ?? []).filter((eq) => undecided.has(eq.constraint.id));
        file(o, n, own.length > 0 ? own : read.filter((r) => r.defaults!.includes(h)).map((r) => r.eq), h, new Set(), [h.id]);
        for (const g of [h, ...redefinedClosure(model, h)]) if (!partnerOf.has(g.id)) partnerOf.set(g.id, o);
      }
    }
  }
  const index: EnclosingAsserts = { byOwner, chains, features, undecided, partners: partnerOf, paths, everywhere: new Map() };
  ENCLOSING_ASSERTS.set(model, { rev: model.rev, index });
  return index;
}

/**
 * Does an asserted equation of an enclosing element define `f`'s `default` in
 * SOME instance ({@link enclosingAsserts})? Its value is then the instance's
 * own wherever it is read through one (its symbol is, {@link
 * DefiningEquations.pinnedIn}), and a generic reading that cannot key it per
 * instance reads no default there.
 */
export function assertHeldInSome(model: Model, f: ElementRecord): boolean {
  const { features } = enclosingAsserts(model);
  return features.size > 0 && [f, ...redefinedClosure(model, f)].some((g) => features.has(g.id));
}

/**
 * Does an asserted equation of an element enclosing `f`'s OWN declaration —
 * an owner up its containment, or a general type of one — define `f` there
 * ({@link enclosingAsserts})? Every instance `f` stands for is then such an
 * element's, and its `default` gives way in each — the feature's own reading
 * included ({@link defaultGivesWay}): q1's `part :>> p { attribute :>> x
 * default = 9.0; }` under q1's, or q1's type's, `p.x == 50.0` is 50 wherever
 * it is read, and no surface reads its 9 (U7's Q3). P's own x is no such
 * feature: P's own instance has no frame that asserts it.
 */
function assertHeldEverywhere(model: Model, f: ElementRecord): boolean {
  if (!assertHeldInSome(model, f)) return false;
  const index = enclosingAsserts(model);
  const hit = index.everywhere.get(f.id);
  if (hit !== undefined) return hit;
  let answer = false;
  let path = effectiveNameOf(model, f);
  const seen = new Set<ElementId>();
  for (let cur: ElementRecord | undefined = f; path !== undefined && cur?.ownerId != null && !answer; ) {
    const owner = model.get(cur.ownerId);
    if (!owner || owner.attrs.isLibrary === true || seen.has(owner.id)) break;
    seen.add(owner.id);
    const at = path;
    answer = [owner.id, ...generalizationsOf(model, owner.id).map((t) => t.id)].some((o) => index.byOwner.get(o)?.has(at) === true);
    const n = effectiveNameOf(model, owner);
    path = n === undefined ? undefined : `${n}.${path}`;
    cur = owner;
  }
  index.everywhere.set(f.id, answer);
  return answer;
}

/** Does an asserted equation of the model set one `default` equal to another, both giving way (U7, {@link undecidedPartnerOf})? */
export function hasUndecidedPartners(model: Model): boolean {
  return enclosingAsserts(model).partners.size > 0;
}

/**
 * The element whose asserted equation sets `f`'s `default` equal to another
 * `default` (U7 Q4: q1's `p.x == L` over q1's `L default = 9.0` and P's `x
 * default = 2.0`), where `f`'s value is still such a default and gives way
 * wherever `f` is read ({@link assertHeldEverywhere}): both give way, so `f`
 * has no value, and that equation derives none for it either — it would read
 * the other side's default, the very one that gave way. `undefined` for any
 * other feature, and for one that states a plain value (H2E's q's `:>> L =
 * 50.0`), which is its own.
 */
export function undecidedPartnerOf(model: Model, f: ElementRecord): ElementId | undefined {
  const { partners } = enclosingAsserts(model);
  if (partners.size === 0) return undefined;
  const chain = [f, ...redefinedClosure(model, f)];
  if (chain.find((g) => g.attrs.value !== undefined && g.attrs.value !== null)?.attrs.defaultValue !== true) return undefined;
  if (!assertHeldEverywhere(model, f)) return undefined;
  for (const g of chain) {
    const o = partners.get(g.id);
    if (o !== undefined) return o;
  }
  return undefined;
}

/**
 * Does a model read a value per instance — a binding of the user's own
 * ({@link hasUserBindings}), or an asserted equation of an enclosing element
 * that defines a `default` in some instance ({@link enclosingAsserts})?
 */
export function readsPerInstance(model: Model): boolean {
  return hasUserBindings(model) || enclosingAsserts(model).features.size > 0;
}

/**
 * The element whose asserted equation defines, in some instance of the usage
 * `contextId`, a feature among `reads` — the path it defines passes through
 * the usage ({@link enclosingAsserts}): HE's q1, whose `p.x == 50.0` makes
 * q1's p read otherwise than Q's p does. `undefined` where none does. With
 * `own`, the usage may write the equation itself (a context whose own assert
 * changes what a relation of its type reads).
 */
function assertedThrough(model: Model, contextId: ElementId, reads: ReadonlySet<ElementId>, own = false): ElementRecord | undefined {
  const { paths } = enclosingAsserts(model);
  for (const p of paths) {
    if (!(p.through.has(contextId) || (own && p.owner === contextId))) continue;
    for (const id of p.end) if (reads.has(id)) return model.get(p.owner);
  }
  return undefined;
}

/** Is `el` an element whose asserted equation defines a `default` below it ({@link enclosingAsserts}), and that writes no binding? */
function assertFrameOnly(model: Model, el: ElementRecord): boolean {
  return enclosingAsserts(model).byOwner.has(el.id) && !bindingEnds(model).written.some((w) => w.holder === el.id);
}

/** One asserted equation an enclosing element writes that defines a value at an instance ({@link assertDefinitionsAt}). */
export interface AssertDefinition {
  /** The element that writes it: the frame's own, or a general type of it. */
  owner: ElementId;
  /** The path it defines, spelled below that frame. */
  path: string;
  equations: readonly DefiningEquation[];
  /** The frame it is read in: the instance enclosing the value, and the element read there. */
  frame: InstanceFrame;
}

/**
 * The asserted equations of the elements ENCLOSING the instance `symbol` —
 * each frame above it ({@link DefiningEquations.framesAbove}), its reader and
 * every general type of the reader — that define `symbol`'s path below that
 * frame, where `f` (the feature read there) states a `default` some such
 * equation overrides ({@link enclosingAsserts}): R1's `R1::q1::p::x` is
 * defined by q1's `assert constraint { p.x == 50.0 }`. `[]` where none does,
 * where `f` reads a plain value, and where a binding carries a value into the instance ({@link
 * boundSourceIn}), or one of its end copies lies on the path below a frame
 * (`part q1 : Q { bind p.x = K; }` under Q's `p.x == 50.0`): the binding's
 * value is read there, and the assert is checked against it (RB).
 */
export function assertDefinitionsAt(model: Model, f: ElementRecord, symbol: string): readonly AssertDefinition[] {
  if (!assertHeldInSome(model, f) || boundSourceMemo(model, symbol) !== undefined) return [];
  // Only a `default` gives way: a plain value read there (q's `:>> L = 50.0`) is its own (decision 1).
  const holder = [f, ...redefinedClosure(model, f)].find((g) => g.attrs.value !== undefined && g.attrs.value !== null);
  if (holder?.attrs.defaultValue !== true) return [];
  const { byOwner, chains } = enclosingAsserts(model);
  const definitions = sharedDefinitions(model);
  const { ends } = bindingEnds(model);
  const out: AssertDefinition[] = [];
  for (const frame of definitions.framesAbove(symbol) ?? []) {
    if (!symbol.startsWith(`${frame.instance}::`)) continue;
    const spelled = symbol.slice(frame.instance.length + 2).split('::').join('.');
    let cur: ElementId | undefined = frame.reader;
    const read: ElementRecord[] = [];
    for (const segment of spelled.split('.')) {
      const h: ElementRecord | undefined = cur === undefined ? undefined : definitions.byName(cur).get(segment);
      cur = h && ![h, ...redefinedClosure(model, h)].some((g) => ends.has(g.id)) ? h.id : undefined;
      if (h) read.push(h);
    }
    if (cur === undefined) continue;
    // The path the owner writes as the instance spells it, or whose every segment is the feature the
    // instance reads there or one it redefines: q's `part pp :>> p` reads Q's `p.x == 50.0` at `pp.x`.
    const names = (id: ElementId, h: ElementRecord): boolean => h.id === id || redefinedClosure(model, h).some((g) => g.id === id);
    for (const owner of [frame.reader, ...generalizationsOf(model, frame.reader).map((t) => t.id)]) {
      for (const [path, chain] of chains.get(owner) ?? []) {
        if (path !== spelled && (chain.length !== read.length || !chain.every((id, k) => names(id, read[k]!)))) continue;
        const equations = byOwner.get(owner)?.get(path);
        if (equations) out.push({ owner, path, equations, frame });
      }
    }
  }
  return out;
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
  return ends.held.has(f.id) || ends.heldSomewhere.has(f.id) || assertHeld(model).has(f.id) || assertHeldEverywhere(model, f);
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
  if (ends.held.has(f.id) || assertHeld(model).has(f.id) || assertHeldEverywhere(model, f)) return true;
  if (inst === undefined) return false;
  let answer = ends.heldIn.has(inst);
  if (!answer) {
    const name = effectiveNameOf(model, f);
    answer = name !== undefined && ends.heldIn.has(`${inst}::${name}`);
  }
  // An asserted equation of an element enclosing the instance defines it there (H5's enclosing rule).
  if (!answer) answer = assertDefinitionsIn(model, f, inst).length > 0;
  recording?.push({ kind: 'gives-way', feature: f, inst, answer });
  return answer;
}

/**
 * {@link assertDefinitionsAt} for `f` read at `inst` — the instance of its
 * owner (`R1::q1::p`) or its own (`R1::q1::p::x`), as {@link
 * defaultGivesWayIn} is asked either.
 */
export function assertDefinitionsIn(model: Model, f: ElementRecord, inst: string): readonly AssertDefinition[] {
  const name = effectiveNameOf(model, f);
  if (name === undefined || !assertHeldInSome(model, f)) return [];
  const below = assertDefinitionsAt(model, f, `${inst}::${name}`);
  return below.length > 0 || !inst.endsWith(`::${name}`) ? below : assertDefinitionsAt(model, f, inst);
}

/**
 * The ONE asserted equation of the elements enclosing the instance `inst`
 * that defines `f` there ({@link assertDefinitionsIn}): the equation, the
 * path it defines, the element that writes it and the frame it is read in —
 * a definition read in that frame, over the frame's own names. `{ abstain:
 * 'two-values' }` where such equations give it two values — two over names
 * read in two frames, or written by two elements, are two whatever their text
 * (q1's `p.x == M` reads q1's M, the package's `q1.p.x == M` the package's);
 * `{ abstain: 'defaults' }` where one sets it equal to another `default` and
 * both give way (U7); `undefined` where none defines it. A question of the
 * instance's spelling, recorded as one ({@link InstanceLookup}).
 */
export function assertDefinitionIn(
  model: Model,
  f: ElementRecord,
  inst: string,
):
  | { owner: ElementId; path: string; equation: DefiningEquation; frame: InstanceFrame; constant: boolean }
  | { abstain: 'two-values' | 'defaults'; owner: ElementId }
  | undefined {
  const defs = assertDefinitionsIn(model, f, inst);
  let answer: ReturnType<typeof assertDefinitionIn>;
  if (defs.length > 0) {
    const all = defs.flatMap((d) => d.equations.map((equation) => ({ owner: d.owner, path: d.path, equation, frame: d.frame })));
    const constant = (eq: DefiningEquation): boolean => refsIn(eq.definition, eq.literals).length === 0;
    const text = (d: (typeof all)[number]): string =>
      JSON.stringify([d.equation.definition, [...d.equation.literals], constant(d.equation) ? '' : `${d.owner} ${d.frame.instance}`]);
    const first = all[0]!;
    // One over a `default` gives no value where a name it reads still reads one in the frame — not in q,
    // whose `:>> L = 50.0` is read where Q's `p.load == L` meets Q's `L default = 1.0` (H2E).
    const { undecided } = enclosingAsserts(model);
    const definitions = sharedDefinitions(model);
    const open = all.find((d) =>
      (undecided.get(d.equation.constraint.id) ?? []).some((n) => {
        // A name the writer's owners declare, read as no constant (E3): no value, whatever the frame has.
        if (!definitions.byName(d.owner).has(n)) return true;
        const h = definitions.byName(d.frame.reader).get(n);
        const g = h && [h, ...redefinedClosure(model, h)].find((x) => x.attrs.value !== undefined && x.attrs.value !== null);
        return g === undefined || (g.attrs.defaultValue === true && !assertHeld(model).has(g.id));
      }),
    );
    answer = open
      ? { abstain: 'defaults', owner: open.owner }
      : all.some((d) => text(d) !== text(first))
        ? { abstain: 'two-values', owner: first.owner }
        : { ...first, constant: constant(first.equation) };
  }
  recording?.push({ kind: 'asserted', feature: f, inst, answer: assertedKey(answer) });
  return answer;
}

/**
 * {@link assertDefinitionIn}'s answer as a key: two answers with one key read
 * one value, or abstain alike — the frame's instance included, whose names an
 * equation over names reads.
 */
function assertedKey(answer: ReturnType<typeof assertDefinitionIn>): string {
  if (answer === undefined) return '';
  if ('abstain' in answer) return `${answer.abstain} ${answer.owner}`;
  return `${answer.owner} ${answer.path} ${answer.equation.constraint.id} ${answer.frame.instance}`;
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
 * A binding `edge` written in `holder`, read for `instance` (an instance of
 * `holder` or of what it is a type of), whose one end is a feature of an
 * instance ENCLOSING `holder` ({@link endPlace}'s `enclosed`: R's `L` in `part
 * q : Q { bind p.load = L; }`): the enclosing instance it is read in — the
 * nearest frame above `instance` whose reader is that owner or specialises it
 * ({@link DefiningEquations.framesAbove}) — with each end, in the edge's
 * order, as a path below that frame's reader: `q.p.load` and `L` in r, for
 * r's q (E3). `undefined` for any other binding, or where no frame above
 * `instance` is such an instance (the end has no instance there).
 */
export function enclosedBindingFrame(
  model: Model,
  edge: ElementRecord,
  holder: ElementRecord,
  instance: string,
): { reader: ElementId; instance: string; ends: readonly [string, string] } | undefined {
  const pair = [edge.source?.[0], edge.target?.[0]] as const;
  if (pair[0] === undefined || pair[1] === undefined) return undefined;
  const places = [endPlace(model, pair[0], holder), endPlace(model, pair[1], holder)] as const;
  const k = places[0].kind === 'enclosed' ? 0 : 1;
  const up = places[k];
  const down = places[1 - k]!;
  if (up.kind !== 'enclosed' || down.kind !== 'below') return undefined;
  const frames = sharedDefinitions(model).framesAbove(instance) ?? [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i]!;
    if (!up.within.has(frame.reader) || !instance.startsWith(`${frame.instance}::`)) continue;
    const below = `${instance.slice(frame.instance.length + 2).split('::').join('.')}.${down.path}`;
    return { reader: frame.reader, instance: frame.instance, ends: k === 0 ? [up.path, below] : [below, up.path] };
  }
  return undefined;
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
    // A `default` an asserted equation overrides (H5, {@link assertHeld}) is
    // the equation's value, and a default in the component gives way to it.
    return g.attrs.defaultValue === true && !assertHeld(model).has(g.id) ? { kind: 'default', source: g } : { kind: 'value' };
  }
  // No value of its own: an asserted equation that defines the feature — its
  // own, or one it redefines, an assert inherited from a general definition
  // through the copy's redefinition closure (the G340 family, `assert-min`) —
  // is a stated value, so a `default` in the component gives way to it.
  if (assertDefinesEnd(model, f, root, path)) return { kind: 'value' };
  return { kind: 'none' };
}

/**
 * Does an asserted equation define the binding end `f` at `path` in `root` —
 * one of the owner of `f` or of a feature it redefines, under that feature's
 * name, or one of the context, under the path ({@link endValue})?
 */
function assertDefinesEnd(
  model: Model,
  f: ElementRecord,
  root: ElementRecord,
  path: string,
  cache?: Map<ElementId, ReadonlySet<string>>,
): boolean {
  // Given a `cache`, each owner's asserted names are gathered once (a package of thousands of usages is
  // the root of every held member it reads).
  const definedIn = (ownerId: ElementId, n: string): boolean => {
    if (!cache) return model.children(ownerId).some((c) => isAsserted(c) && namesDefinedBy(c).includes(n));
    let hit = cache.get(ownerId);
    if (!hit) {
      hit = new Set(model.children(ownerId).flatMap((c) => (isAsserted(c) ? namesDefinedBy(c) : [])));
      cache.set(ownerId, hit);
    }
    return hit.has(n);
  };
  const defines = (ownerId: ElementId | null, n: string | undefined): boolean =>
    n !== undefined && ownerId != null && definedIn(ownerId, n);
  return [f, ...redefinedClosure(model, f)].some((g) => defines(g.ownerId, effectiveNameOf(model, g))) || defines(root.id, path);
}

/**
 * Does the binding end `f` — at `path` in `root`, where it reads a `default`
 * ({@link endValue}) — state nothing of its own, so that read generically it
 * falls through to the `default` of a feature it redefines? The implicit
 * connector-end copy q2's `bind p.extra = E` makes of P's `extra default =
 * 0.0` does: read at q2's p, through the copy, the redefined default is what
 * the reading meets, and it is not q2's p's value (A4). Not where an asserted
 * equation defines the end (GA6's `p.load`, whose P asserts `load == 7.0`):
 * the assert stands over a default (H5, {@link assertHeld}), and the
 * fall-through reads the assert.
 */
function fallsToDefault(
  model: Model,
  f: ElementRecord,
  root: ElementRecord,
  path: string,
  cache: Map<ElementId, ReadonlySet<string>>,
): boolean {
  if (f.attrs.value !== undefined && f.attrs.value !== null) return false;
  return !assertDefinesEnd(model, f, root, path, cache);
}

/**
 * Does a binding override `f`'s `default` — is `f` written `attribute load
 * default = 1.0`, and held by a binding ({@link heldDefaults})? The default
 * gives way to the binding exactly as to a redefinition: the feature reads the
 * value the binding gives it — on every surface — and no surface reads the
 * default (`bind load = L` with `L` set to 50 in `q` is q's load of 50, never
 * the 1.0 that, read beside the binding, made the model contradict itself in
 * q). So does a `default` an asserted equation defines (H5, {@link
 * assertHeld}), one of an enclosing element's in every instance the feature
 * stands for included ({@link assertHeldEverywhere}). A value written with `=` is a binding of its own and gives way to
 * nothing: against another binding it is a contradiction (strict KerML). A
 * redefinition that states nothing over a default — the implicit
 * connector-end copy `bind p.load = L` creates of P's `load` — reads no
 * default either ({@link DefiningEquations.carrier}).
 */
export function defaultGivesWay(model: Model, f: ElementRecord): boolean {
  return f.attrs.defaultValue === true && (bindingEnds(model).held.has(f.id) || assertHeld(model).has(f.id) || assertHeldEverywhere(model, f));
}

/**
 * Does a binding of the model, or one joined to it, meet a cap ({@link
 * BindingEnds.overCap}), or hold in a context where an end has no instance
 * ({@link BindingEnds.unread}, the `outside` cap)?
 */
export function hasPastCapBindings(model: Model): boolean {
  const { overCap, unread } = bindingEnds(model);
  return overCap.size > 0 || unread.size > 0;
}

/**
 * Is the feature `featureId` an end of a binding past a cap ({@link
 * BindingEnds.overCap}, or {@link BindingEnds.unread}: `outside`), or one that
 * redefines such an end — a feature whose value a binding holds in a context
 * this tool does not read? Its `default` was held for that (`holdEnds`), not
 * because a binding gives it another value, and where nothing else determines
 * it, it is no value the model leaves free: the value is there, unread.
 * CAPU4's `part s : T1;` beside T1's chain 33 usages deep holds s's L and its
 * a's load at T1's default of 1; read as free, `s.a.load == 9.0` was solved as
 * a design equation, and `s.L <= 5.0` refuted at that 9. So was R's nested Q,
 * used outside any R, for `r2 : R`'s q's p's load, where r2's L is R's default
 * of 1 (`r2.q.p.m2 >= 5.0` refuted at m2 = 1). The numeric lane reads such a
 * feature as one it cannot read (the solver's `unreadable`) unless its
 * bindings fix it from values the model states (CAP1's Y, 50 from X).
 */
export function pastCapEnd(model: Model, featureId: ElementId): boolean {
  return pastCapOf(model, featureId) !== undefined;
}

/** The cap a {@link pastCapEnd} feature's binding met — the first of it and the features it redefines — or `undefined`. */
export function pastCapOf(model: Model, featureId: ElementId): BindingCap | undefined {
  const { overCap, unread } = bindingEnds(model);
  if (overCap.size === 0 && unread.size === 0) return undefined;
  const capOf = (id: ElementId): BindingCap | undefined => overCap.get(id) ?? (unread.has(id) ? 'outside' : undefined);
  const own = capOf(featureId);
  if (own !== undefined) return own;
  const f = model.get(featureId);
  if (f === undefined) return undefined;
  for (const g of redefinedClosure(model, f)) {
    const cap = capOf(g.id);
    if (cap !== undefined) return cap;
  }
  return undefined;
}

/**
 * Why a {@link pastCapEnd} feature has no value read for an instance — what
 * is not read, and the cap: `R::L is held by a binding that joins a feature
 * outside where it is written, … so no value the binding gives it is read for
 * any one instance`. Its `default`, where it states one, was held for the cap,
 * and is no value of its own here either: never `declared without one`.
 */
export function heldPastCapSentence(name: string, cap: BindingCap): string {
  const held =
    cap === 'outside'
      ? 'a binding that joins a feature outside where it is written, which this tool finds no instance of in a context the binding holds in'
      : cap === 'frames'
        ? `a binding that holds in more than ${MAX_BINDING_FRAMES.toLocaleString('en')} contexts`
        : `a binding read deeper than ${MAX_BINDING_SEGMENTS} usages`;
  return `${name} is held by ${held}, so no value the binding gives it is read for any one instance`;
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

/**
 * The A.9 `internal` sentence (A.2.9): a per-instance reading of `name` in
 * `instance` threw, and says so, naming the error's class. It is reported,
 * never dropped and never thrown on: a throw out of the sweep made `validate()`
 * throw, and the app's Problems view (`safeValidate`) then showed nothing at
 * all, every other rule's findings included. One sentence for the scalar
 * reading and its unit-aware twin.
 */
export function failedReadingSentence(name: string, instance: string, e: unknown): string {
  return `${name} is not read in ${instance}: the per-instance reading failed ` +
    `(${e instanceof Error ? e.constructor.name : 'error'}); reported, not dropped`;
}

/** One context a definition is read in, with the dotted path to it from that context's root ({@link bindingFrames}). */
export interface BindingFrame {
  root: ElementRecord;
  prefix: string;
}

/** What a binding component's members state, classified by path ({@link classified}). */
export interface ComponentClass {
  /** Members that state a value — `=`, or an asserted equation. */
  readonly valued: readonly string[];
  /** Members whose `default` stands — not held by the binding. */
  readonly readable: readonly string[];
  /** Members whose `default` gives way to the binding. */
  readonly heldDefaults: readonly string[];
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
      paths: readonly string[];
      component: string;
      via: { bindingIds: readonly ElementId[]; source: string };
    }
  | { abstain: InstanceAbstention; sentence: string };

/** One group a relation is read per instance in ({@link instanceGroups}): (relation, shared usage). */
export interface InstanceGroup {
  relationId: ElementId;
  usageId: ElementId;
  definitionId: ElementId;
  /** The instances the usage is read in, its own (generic) first. */
  instances: readonly string[];
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
 * `path`, a member path written in a general type of `contextId` (an end of
 * Q's `bind p.load = L`), as `contextId` spells it: a segment a renamed
 * redefinition answers to (`part pp :>> p` in `part q : Q`) by that
 * redefinition's own name — q's `pp.load`, the symbol every relation over
 * q's pp reads (H5, E8: R13). `path` itself where the scope names it, or
 * where a segment resolves to nothing there.
 */
export function spelledIn(definitions: DefiningEquations, contextId: ElementId, path: string): string {
  const denoted = definitions.denote(contextId);
  if (denoted.has(path)) return path;
  let spelled = '';
  for (const seg of path.split('.')) {
    const d = denoted.get(spelled === '' ? seg : `${spelled}.${seg}`);
    const name = d ? definitions.nameOf(d.feature) : undefined;
    if (name === undefined) return path;
    spelled = spelled === '' ? name : `${spelled}.${name}`;
  }
  return spelled;
}

/**
 * The {@link ComponentFacts} record of the component `component` read in
 * `root`, made when first asked with the member paths alone — in reading
 * order, from the `members` index ({@link indexOf}) rather than a scan of the
 * whole reading per ask — and filled in by each fact's own reader. Thousands
 * of instance symbols read through one root (big-bind's q's, perf9b's 767
 * N0s) ask the same component.
 */
function componentFacts(model: Model, root: ElementId, component: string): ComponentFacts {
  const ends = bindingEnds(model);
  const memo = (ends.components ??= new Map());
  const key = `${root} ${component}`;
  let facts = memo.get(key);
  if (!facts) {
    facts = { paths: Object.freeze(indexOf(model).members.get(root)?.get(component) ?? []) };
    memo.set(key, facts);
  }
  return facts;
}

/**
 * What the members of a binding component state, classified by path (A.3):
 * `valued` (a value of its own), `readable` (a `default` the binding does not
 * hold), and `heldDefaults` (a `default` it holds, {@link heldDefaults}).
 * Once per (root, component) and revision; the record is shared — read it,
 * never change it.
 */
export function classified(model: Model, root: ElementId, component: string): ComponentClass {
  const facts = componentFacts(model, root, component);
  if (facts.classified) return facts.classified;
  const { readings, held } = bindingEnds(model);
  const valued: string[] = [];
  const readable: string[] = [];
  const heldDefaults: string[] = [];
  const reading = readings.get(root);
  const rootEl = model.get(root);
  if (reading && rootEl) {
    for (const path of facts.paths) {
      const r = reading.get(path);
      const f = r ? model.get(r.feature) : undefined;
      if (!f) continue;
      const v = endValue(model, f, rootEl, path);
      if (v.kind === 'value') valued.push(path);
      else if (v.kind === 'default') (held.has(f.id) ? heldDefaults : readable).push(path);
    }
  }
  facts.classified = Object.freeze({
    valued: Object.freeze(valued),
    readable: Object.freeze(readable),
    heldDefaults: Object.freeze(heldDefaults),
  });
  return facts.classified;
}

/** Every member path of `component` read in `root`, in reading order — the component's own list, frozen. */
function componentPaths(model: Model, root: ElementId, component: string): readonly string[] {
  return componentFacts(model, root, component).paths;
}

/** The ids of the {@link componentConnectors} of `component` read in `root` — the component's own list, frozen. */
function componentBindingIds(model: Model, root: ElementId, component: string): readonly ElementId[] {
  const facts = componentFacts(model, root, component);
  facts.bindingIds ??= Object.freeze(componentConnectors(model, root, component).map((c) => c.id));
  return facts.bindingIds;
}

/**
 * The binding connectors that join the component read in `root` — the
 * connectors whose two ends are the features the component's members read,
 * each member matched through what it redefines (an implicit connector-end
 * copy of the end) — in the model's order. Best-effort: the per-instance
 * reading (F5) is what consumes this, and it reads the member it names rather
 * than these ids. Once per (root, component) and revision, over the user's
 * binding connectors ({@link BindingEnds.connectors}), never the whole model.
 */
function componentConnectors(model: Model, root: ElementId, component: string): readonly ElementRecord[] {
  const facts = componentFacts(model, root, component);
  if (facts.connectors) return facts.connectors;
  const ends = bindingEnds(model);
  const reading = ends.readings.get(root);
  const origins = new Set<ElementId>();
  for (const path of facts.paths) {
    const r = reading?.get(path);
    if (!r) continue;
    origins.add(r.feature);
    const f = model.get(r.feature);
    if (f) for (const g of redefinedClosure(model, f)) origins.add(g.id);
  }
  facts.connectors =
    origins.size === 0
      ? []
      : ends.connectors.filter((el) => {
          const [s, t] = [el.source?.[0], el.target?.[0]];
          return s !== undefined && t !== undefined && origins.has(s) && origins.has(t);
        });
  return facts.connectors;
}

/**
 * The context roots of the binding readings by the instance each reads its
 * own features in ({@link DefiningEquations.instanceNameOf}), in reading
 * order — so a symbol's frame roots are found by its own prefixes, not by
 * spelling every root's instance per symbol. Once per revision.
 */
function readingsByInstance(model: Model): ReadonlyMap<string, ReadonlyArray<{ root: ElementId; order: number }>> {
  const ends = bindingEnds(model);
  if (ends.byInstance) return ends.byInstance;
  const definitions = sharedDefinitions(model);
  const byInstance = new Map<string, Array<{ root: ElementId; order: number }>>();
  let order = 0;
  for (const root of ends.readings.keys()) {
    const inst = definitions.instanceNameOf(root);
    const list = byInstance.get(inst);
    if (list) list.push({ root, order });
    else byInstance.set(inst, [{ root, order }]);
    order += 1;
  }
  ends.byInstance = byInstance;
  return byInstance;
}

/** Is `e` a package — a namespace, which {@link isDefinition} counts among the definitions? */
function isPackage(e: ElementRecord): boolean {
  return e.eClass === 'Package' || e.eClass === 'LibraryPackage';
}

/**
 * The DEFINITION the member path `path` of `rootId`'s reading is written below
 * — the last one the path names, P for `P.load` or `Pkg.P.sub.load` below a
 * package — with the features from it down to the member ({@link
 * featuresAtPath}); `undefined` for a path through usages alone (`q1.p.load`,
 * though P owns that load).
 */
function definitionHeadOf(
  model: Model,
  definitions: DefiningEquations,
  rootId: ElementId,
  path: string,
): { definition: ElementRecord; tail: ElementRecord[] } | undefined {
  const chain = featuresAtPath(model, definitions, rootId, path);
  if (!chain) return undefined;
  for (let at = chain.length - 2; at >= 0; at--) {
    const e = chain[at]!;
    if (isDefinition(e.eClass) && !isPackage(e)) return { definition: e, tail: chain.slice(at + 1) };
  }
  return undefined;
}

/**
 * A member of a binding reading written on a DEFINITION's feature from outside
 * it — a package's `bind P::load = L` (w4), at `P.load` in the package's
 * reading — with the definition (`P`) and the features from it down to the
 * member (`[P::load]`): the binding holds in every instance of P, read at the
 * instance's own path ({@link definitionHeadMatch}).
 */
interface DefinitionHead {
  path: string;
  component: string;
  feature: ElementId;
  definition: ElementRecord;
  tail: readonly ElementRecord[];
  /** Does a feature with a value of its own redefine the member — an instance's `:>> load default = 7.0`? */
  redefined: boolean;
  /**
   * What gives the member's slot a value in some instance of the definition
   * OUTSIDE the component — and so gives the component's one-instance end
   * (the package's `L`) that value, which this tool does not read into the
   * other instances: a redefinition's own `=` (`part p4 : P { attribute :>>
   * load = 7.0; }`), a member of another binding reading at an instance's
   * path (Q's `bind p.load = M` for `part p : P`, the package's own `bind
   * p2.load = K`), or an asserted equation that defines an instance's slot
   * (`assert constraint { p2.load == 5.0 }`). No `default` in such a
   * component is its value ({@link heldDefaults}, {@link standingDefaultIn}).
   */
  fixed?: string;
}

/**
 * The {@link DefinitionHead} members of each binding reading in `contexts`,
 * by root — only a package's reading has any, the one a binding written there
 * reads its ends in — and the user's features with a value of their own
 * (`=` or `default`) by each feature they redefine, built only where a head
 * exists. A head's slot is `fixed` where a redefinition states it with `=`,
 * or where a member of another component read in any root ({@link
 * heldDefaults}' `contexts`), or a path an asserted equation defines, is the
 * slot at an instance of the head's definition: the instance the path's
 * prefix names (a usage or definition that specialises it, or the root
 * itself), and below it the head's features, each the feature or one that
 * redefines it. Once per revision, inside {@link heldDefaults}.
 */
function headsOfReadings(
  model: Model,
  definitions: DefiningEquations,
  contexts: ReadonlyMap<ElementId, { at: ReadonlyMap<string, ElementRecord> }>,
  componentOf: (rootId: ElementId, path: string) => string,
): { heads: Map<ElementId, DefinitionHead[]>; byRedefined?: ReadonlyMap<ElementId, readonly ElementRecord[]> } {
  const heads = new Map<ElementId, DefinitionHead[]>();
  const all: Array<{ rootId: ElementId; head: DefinitionHead }> = [];
  for (const [rootId, ctx] of contexts) {
    const root = model.get(rootId);
    if (!root || !isPackage(root)) continue;
    for (const [path, f] of ctx.at) {
      const head = definitionHeadOf(model, definitions, rootId, path);
      if (!head) continue;
      const entry: DefinitionHead = { path, component: componentOf(rootId, path), feature: f.id, ...head, redefined: false };
      const list = heads.get(rootId) ?? [];
      list.push(entry);
      heads.set(rootId, list);
      all.push({ rootId, head: entry });
    }
  }
  if (all.length === 0) return { heads };
  const byRedefined = new Map<ElementId, ElementRecord[]>();
  for (const x of model.all()) {
    if (x.attrs.isLibrary === true || !isUsage(x.eClass) || x.attrs.value === undefined || x.attrs.value === null) continue;
    for (const g of redefinedClosure(model, x)) {
      const list = byRedefined.get(g.id);
      if (list) list.push(x);
      else byRedefined.set(g.id, [x]);
    }
  }
  for (const { head } of all) {
    const redefiners = byRedefined.get(head.feature) ?? [];
    head.redefined = redefiners.length > 0;
    const plain = redefiners.find((r) => r.attrs.defaultValue !== true);
    if (plain) head.fixed = `the value ${effectiveQualifiedName(model, plain.id)} states`;
  }
  // Is `path` read in `rootId` the slot `head` names at an instance of its definition?
  const chains = new Map<string, ElementRecord[] | undefined>();
  const slotOf = (rootId: ElementId, path: string, head: DefinitionHead): boolean => {
    const key = `${rootId} ${path}`;
    if (!chains.has(key)) chains.set(key, featuresAtPath(model, definitions, rootId, path));
    const chain = chains.get(key);
    if (!chain) return false;
    const at = chain.length - head.tail.length - 1;
    const instance = at >= 0 ? chain[at] : at === -1 ? model.get(rootId) : undefined;
    if (!instance || isPackage(instance)) return false;
    if (instance.id !== head.definition.id && !generalizationsOf(model, instance.id).some((g) => g.id === head.definition.id)) return false;
    return head.tail.every((g, k) => {
      const mine = chain[at + 1 + k]!;
      return mine.id === g.id || redefinedClosure(model, mine).some((x) => x.id === g.id);
    });
  };
  for (const [rootId, ctx] of contexts) {
    for (const path of ctx.at.keys()) {
      for (const { rootId: headRoot, head } of all) {
        if (head.fixed !== undefined || (rootId === headRoot && componentOf(rootId, path) === head.component)) continue;
        if (slotOf(rootId, path, head)) head.fixed = `a binding read in ${effectiveQualifiedName(model, rootId)} at ${path}`;
      }
    }
  }
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || el.ownerId == null || !isAsserted(el)) continue;
    const eq = equationOf(el);
    if (!eq) continue;
    const paths = [definedName(eq.node.left, eq.literals), definedName(eq.node.right, eq.literals)];
    for (const { head } of all) {
      if (head.fixed !== undefined) continue;
      if (paths.some((p) => p !== undefined && slotOf(el.ownerId!, p, head))) {
        head.fixed = `the asserted equation ${effectiveQualifiedName(model, el.id)}`;
      }
    }
  }
  return { heads, byRedefined };
}

/**
 * The element at each segment of the dotted `path` below `root` (075b306's
 * `featureAtPath`), resolved through the model's ownership by effective name
 * — a definition and its features included (`Q.p.load` below a package, Q's
 * own p's load), which a scope's {@link DefiningEquations.denote} walk leaves
 * out — then through each element's effective features. `undefined` where a
 * segment resolves to nothing.
 */
function featuresAtPath(model: Model, definitions: DefiningEquations, root: ElementId, path: string): ElementRecord[] | undefined {
  const out: ElementRecord[] = [];
  let owner = root;
  for (const seg of path.split('.')) {
    const f =
      childNamed(model, definitions, owner, seg) ??
      definitions.byName(owner).get(seg) ??
      definitions.features(owner).find((c) => definitions.nameOf(c) === seg);
    if (!f) return undefined;
    out.push(f);
    owner = f.id;
  }
  return out;
}

/** Each owner's children by name, the first of each name, once per {@link DefiningEquations} (one revision). */
const CHILDREN_BY_NAME = new WeakMap<DefiningEquations, Map<ElementId, ReadonlyMap<string, ElementRecord>>>();

/**
 * The first child of `owner` whose name is `name` ({@link featuresAtPath}):
 * indexed per owner, so a package's reading of many paths scans its children
 * once, not once per path.
 */
function childNamed(model: Model, definitions: DefiningEquations, owner: ElementId, name: string): ElementRecord | undefined {
  let byOwner = CHILDREN_BY_NAME.get(definitions);
  if (!byOwner) CHILDREN_BY_NAME.set(definitions, (byOwner = new Map()));
  let named = byOwner.get(owner);
  if (!named) {
    const m = new Map<string, ElementRecord>();
    for (const c of model.children(owner)) {
      const n = definitions.nameOf(c);
      if (n !== undefined && !m.has(n)) m.set(n, c);
    }
    byOwner.set(owner, (named = m));
  }
  return named.get(name);
}

/**
 * The {@link DefinitionHead} member of `root`'s reading that the path `path`
 * of `root` reads (H5, w4): an instance of the head's definition at a prefix
 * of the path — a usage it types or specialises, `p2` for P — and below it the
 * head's features, each segment the feature itself or one that redefines it.
 * A package's `bind P::load = L` is read at `p2.load` for `part p2 : P`, and at
 * `q.p.load` for a `part def Q { part p : P; }` and `part q : Q`. `undefined`
 * where none matches, or where two in different components do (that instance
 * is read through neither).
 */
function definitionHeadMatch(model: Model, root: ElementId, path: string): DefinitionHead | undefined {
  const heads = bindingEnds(model).heads.get(root);
  if (!heads || path === '') return undefined;
  const slots = featuresAtPath(model, sharedDefinitions(model), root, path);
  if (!slots) return undefined;
  const same = (mine: ElementRecord, g: ElementRecord): boolean =>
    mine.id === g.id || redefinedClosure(model, mine).some((x) => x.id === g.id);
  let match: DefinitionHead | undefined;
  for (const head of heads) {
    const at = slots.length - head.tail.length - 1;
    if (at < 0) continue;
    const instance = slots[at]!;
    if (!isUsage(instance.eClass)) continue;
    if (!generalizationsOf(model, instance.id).some((g) => g.id === head.definition.id)) continue;
    if (!head.tail.every((g, k) => same(slots[at + 1 + k]!, g))) continue;
    if (match && match.component !== head.component) return undefined;
    match ??= head;
  }
  return match;
}

/**
 * A binding a package writes on a definition's features ({@link
 * outsideBindingsOf}), with each end's path below the definition — or
 * `undefined` for an end that is one instance wherever it is read.
 */
export interface OutsideBinding {
  binding: ElementRecord;
  ends: readonly [string | undefined, string | undefined];
}

/**
 * The bindings a package writes on the features of the definition
 * `definitionId` (w4: `bind P::load = L`), each with its ends: the path below
 * the definition of an end that is one of its features (`load`), `undefined`
 * for an end of no definition — the package's `L`, one instance wherever it is
 * read. Such a binding holds in every instance of the definition, as one the
 * definition writes does: the numeric and SMT lanes read it for each instance
 * they read, over that instance's own symbols, as the check reads it
 * ({@link definitionHeadMatch}). One whose other end is a feature of another
 * definition is not listed. Once per revision.
 */
export function outsideBindingsOf(model: Model, definitionId: ElementId): readonly OutsideBinding[] {
  if (!hasUserBindings(model)) return [];
  const ends = bindingEnds(model);
  if (!ends.outside) {
    const outside = new Map<ElementId, OutsideBinding[]>();
    const definitions = sharedDefinitions(model);
    for (const b of ends.connectors) {
      const holder = b.ownerId != null ? model.get(b.ownerId) : undefined;
      if (!holder || !isPackage(holder)) continue;
      // Each end at its path in the package, as the package's reading spells it.
      const paths = [b.source?.[0], b.target?.[0]].map((id) => (id !== undefined ? bindingEndPath(model, id, holder.id) : undefined));
      if (paths[0] === undefined || paths[1] === undefined) continue;
      const heads = paths.map((p) => definitionHeadOf(model, definitions, holder.id, p!));
      const definition = (heads[0] ?? heads[1])?.definition;
      if (!definition || heads.some((h) => h !== undefined && h.definition.id !== definition.id)) continue;
      // An end of no definition is a feature of the package: one instance (`undefined`).
      const below = heads.map((h) => (h ? h.tail.map((f) => definitions.nameOf(f) ?? '').join('.') : undefined));
      const list = outside.get(definition.id) ?? [];
      list.push({ binding: b, ends: [below[0], below[1]] });
      outside.set(definition.id, list);
    }
    ends.outside = outside;
  }
  return ends.outside.get(definitionId) ?? [];
}

/**
 * The OUTERMOST frame root whose instance prefixes the instance `symbol` —
 * the symbol itself, or a prefix of it up to a `::` — and whose binding
 * reading holds the rest of the path, with the component and the feature at
 * that path: the one with the fewest `::` segments, the first in reading
 * order among equals. Each prefix of the symbol is looked up in
 * {@link readingsByInstance}; the answer is the one a scan of every root
 * would give. A path a package's reading does not hold is read through a
 * binding written there on a definition's feature ({@link
 * definitionHeadMatch}: `head`). `undefined` where no binding reading holds
 * the symbol.
 */
function outermostReading(
  model: Model,
  symbol: string,
): { root: ElementId; component: string; feature: ElementId; head?: DefinitionHead } | undefined {
  const { readings } = bindingEnds(model);
  const byInstance = readingsByInstance(model);
  let best: { root: ElementId; component: string; feature: ElementId; head?: DefinitionHead } | undefined;
  let bestSegments = Number.POSITIVE_INFINITY;
  let bestOrder = Number.POSITIVE_INFINITY;
  const consider = (inst: string): void => {
    const roots = byInstance.get(inst);
    if (!roots) return;
    const rest = symbol === inst ? '' : symbol.slice(inst.length + 2);
    const path = rest.split('::').join('.');
    const segments = inst.split('::').length;
    for (const { root, order } of roots) {
      const head = readings.get(root)?.has(path) ? undefined : definitionHeadMatch(model, root, path);
      const r = head ?? readings.get(root)?.get(path);
      if (!r) continue;
      // The roots of one instance are in reading order: the first that holds the path is this prefix's answer.
      if (segments < bestSegments || (segments === bestSegments && order < bestOrder)) {
        best = { root, component: r.component, feature: r.feature, ...(head ? { head } : {}) };
        bestSegments = segments;
        bestOrder = order;
      }
      return;
    }
  };
  consider(symbol);
  for (let i = symbol.indexOf('::'); i >= 0; i = symbol.indexOf('::', i + 1)) consider(symbol.slice(0, i));
  return best;
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

/**
 * Why a binding component gives no value, in the A.9 sentence — `two-values`
 * pointing at the binding's own finding, which a package's binding on a
 * definition's feature does not file (`finding` false), nor one whose end is
 * outside the element that writes it (R's `L` in `part q : Q { bind p.load =
 * L; }`: no end path, EB4).
 */
function abstentionSentence(
  model: Model,
  symbol: string,
  root: ElementId,
  component: string,
  kind: 'free' | 'defaults-differ' | 'two-values',
  finding = true,
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
      'and a binding holds in every instance' +
      (finding && l !== undefined && r !== undefined ? ' (see the binding\u2019s own finding)' : '')
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
 * One question a per-instance reading asked of an instance's SPELLING, with
 * the answer it got: where a binding carries a value into it ({@link
 * boundSourceIn}), whether a held default stands there ({@link
 * defaultStandsIn}) or gives way ({@link defaultGivesWayIn}), what an
 * enclosing asserted equation defines there ({@link assertDefinitionIn}), and
 * whether an enclosing assert constrains a read there ({@link
 * enclosingAssertOn}). These are the only places a reading decides anything
 * by an instance's spelling;
 * everywhere else it passes the spelling on, extends it (`${inst}::x`, {@link
 * rebaseInstance}), keys a memo with it, or prints it. A memo keyed with it
 * keeps the lookups each entry was worked out with ({@link lookupsWhile}) and
 * records them again at every hit ({@link replayLookups}), so a reading asked
 * them whether it worked a value out or took it from the memo. So two
 * instances whose questions get the same answers are read alike ({@link
 * lookupsHold}).
 */
export type InstanceLookup =
  | { kind: 'source'; symbol: string; answer: BoundSource | undefined }
  | { kind: 'stands'; symbol: string; answer: ElementRecord | undefined }
  | { kind: 'gives-way'; feature: ElementRecord; inst: string; answer: boolean }
  | { kind: 'asserted'; feature: ElementRecord; inst: string; answer: string }
  | {
      kind: 'enclosing';
      contextId: ElementId;
      enclosing: readonly InstanceFrame[];
      name: string;
      inst: string;
      answer: { frame: ElementId; expr: string } | undefined;
    };

/** The lookups of the reading {@link recordingLookups} is recording, while it runs. */
let recording: InstanceLookup[] | undefined;

/**
 * Run `read`, and return what it gave with every {@link InstanceLookup} it
 * made, in order. A reading recorded inside another's is recorded in both.
 */
export function recordingLookups<T>(read: () => T): { value: T; lookups: InstanceLookup[] } {
  const outer = recording;
  const lookups: InstanceLookup[] = [];
  recording = lookups;
  try {
    return { value: read(), lookups };
  } finally {
    recording = outer;
    if (outer) for (const l of lookups) outer.push(l);
  }
}

/**
 * Work out a memo entry keyed on an instance — `read` — and return its value
 * with the lookups it made, each question once ({@link lookupKey}), to be kept
 * beside the entry and said again at every hit ({@link replayLookups}). They
 * are recorded for the reading the entry is worked out in too, as {@link
 * recordingLookups} records them.
 */
export function lookupsWhile<T>(read: () => T): { value: T; lookups: readonly InstanceLookup[] } {
  const outer = recording;
  const lookups: InstanceLookup[] = [];
  recording = lookups;
  let asked: readonly InstanceLookup[] = lookups;
  try {
    const value = read();
    asked = distinctLookups(lookups);
    return { value, lookups: asked };
  } finally {
    recording = outer;
    if (outer) for (const l of asked) outer.push(l);
  }
}

/**
 * Record `lookups` — the questions a memo entry keyed on an instance was
 * worked out with ({@link lookupsWhile}) — for the reading being recorded, if
 * any. A memo hit gives the entry's value without asking them again, and the
 * reading that takes it reads that value all the same: a reading whose every
 * value came from the memo recorded no question of its instance, and every
 * other instance of the group took its verdict ({@link lookupsHold}) — Sh1's
 * `m <= 10.0` read q2's p at q1's m of 4, worked out for `m <= 1000.0` just
 * before, and held where q2's m is 100.
 */
export function replayLookups(lookups: readonly InstanceLookup[] | undefined): void {
  if (recording !== undefined && lookups !== undefined) for (const l of lookups) recording.push(l);
}

/** `lookups`, each question once, in order: a memo entry's replayed list stays as long as the questions it asks. */
function distinctLookups(lookups: readonly InstanceLookup[]): readonly InstanceLookup[] {
  if (lookups.length < 2) return lookups;
  const seen = new Set<string>();
  const out: InstanceLookup[] = [];
  for (const l of lookups) {
    const key = lookupKey(l);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/** The question a lookup asks, as a key: two lookups with one key asked the same, and were answered the same. */
function lookupKey(l: InstanceLookup): string {
  if (l.kind === 'source' || l.kind === 'stands') return `${l.kind} ${l.symbol}`;
  if (l.kind === 'gives-way' || l.kind === 'asserted') return `${l.kind} ${l.feature.id} ${l.inst}`;
  return `${l.kind} ${l.contextId} ${l.name} ${l.inst} ${l.enclosing.map((f) => `${f.reader}@${f.instance}`).join(' ')}`;
}

/**
 * The lookups among `lookups` (recorded reading the instance `inst`) whose
 * question spells `inst` — the rest ask the same of every instance — each
 * once, in order: what {@link lookupsHold} asks again of another instance.
 */
export function lookupsOf(lookups: readonly InstanceLookup[], inst: string): InstanceLookup[] {
  const spells = (s: string): boolean => spellsInstance(s, inst);
  const seen = new Set<string>();
  const out: InstanceLookup[] = [];
  for (const l of lookups) {
    if (l.kind === 'source' || l.kind === 'stands') {
      if (!spells(l.symbol)) continue;
    } else if (l.kind === 'gives-way' || l.kind === 'asserted') {
      if (!spells(l.inst)) continue;
    } else if (!spells(l.inst) && !l.enclosing.some((f) => spells(f.instance))) {
      continue;
    }
    const key = lookupKey(l);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/**
 * Would a reading for the instance `to` get the answers `lookups` record for
 * `from` ({@link lookupsOf})? Each question is asked again, `from`'s spelling
 * replaced by `to`'s where it begins one. Where every answer is the same, a
 * reading for `to` takes the path the reading for `from` took — it reads the
 * same values from the same sources and comes to the same verdict — and only
 * the spellings that extend `from` change (tree10: the 512 instances of
 * `T1::a` under `top` each read top's L through one component). An answer
 * that abstains is never the same: its sentence names its instance.
 */
export function lookupsHold(model: Model, lookups: readonly InstanceLookup[], from: string, to: string): boolean {
  const outer = recording;
  recording = undefined;
  try {
    for (const l of lookups) {
      if (l.kind === 'source') {
        if (!sameSource(l.answer, boundSourceIn(model, respell(l.symbol, from, to)))) return false;
      } else if (l.kind === 'stands') {
        if (defaultStandsIn(model, respell(l.symbol, from, to)) !== l.answer) return false;
      } else if (l.kind === 'gives-way') {
        if (defaultGivesWayIn(model, l.feature, respell(l.inst, from, to)) !== l.answer) return false;
      } else if (l.kind === 'asserted') {
        if (assertedKey(assertDefinitionIn(model, l.feature, respell(l.inst, from, to))) !== l.answer) return false;
      } else {
        const enclosing = l.enclosing.some((f) => respell(f.instance, from, to) !== f.instance)
          ? l.enclosing.map((f) => ({ instance: respell(f.instance, from, to), reader: f.reader }))
          : l.enclosing;
        const a = enclosingAssertOn(model, l.contextId, enclosing, l.name, respell(l.inst, from, to));
        if (a?.frame !== l.answer?.frame || a?.expr !== l.answer?.expr) return false;
      }
    }
    return true;
  } finally {
    recording = outer;
  }
}

/** `s`, the instance `from` it begins with (or is) spelled `to` instead; any other spelling as it is. */
function respell(s: string, from: string, to: string): string {
  if (s === from) return to;
  return spellsInstance(s, from) ? `${to}${s.slice(from.length)}` : s;
}

/** Is `s` the instance `inst`, or a spelling below it (`${inst}::…`)? */
export function spellsInstance(s: string, inst: string): boolean {
  return s === inst || (s.length >= inst.length + 2 && s.startsWith(inst) && s.startsWith('::', inst.length));
}

/**
 * Do two {@link boundSourceIn} answers read the same member of the same
 * component in the same root — so the same paths, through the same
 * connectors, which are the component's own ({@link componentFacts})? Never
 * an abstention.
 */
function sameSource(a: BoundSource | undefined, b: BoundSource | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if ('abstain' in a || 'abstain' in b) return false;
  return a.root === b.root && a.component === b.component && a.via.source === b.via.source;
}

/**
 * The source of the value a name read at the instance `symbol` gets through a
 * binding (A.2.2): the OUTERMOST frame root whose generic instance prefixes
 * `symbol` and whose readings hold the rest of the path, its component
 * classified ({@link classified}) and resolved as A.3 does — one valued member
 * (read, unless it is the name's own path), else one readable `default`, else
 * `two-values`, `defaults-differ` or `free`. `undefined` where no binding
 * holds `symbol`. Once per symbol and revision: every instance reading of a
 * sweep asks it per name, and the check, the numeric lane and the unit-aware
 * twin ask the same symbols again. The answer is shared, and frozen with its
 * lists — read it, never change it.
 */
export function boundSourceIn(model: Model, symbol: string): BoundSource | undefined {
  const source = boundSourceMemo(model, symbol);
  recording?.push({ kind: 'source', symbol, answer: source });
  return source;
}

/** {@link boundSourceIn}, once per symbol and revision. */
function boundSourceMemo(model: Model, symbol: string): BoundSource | undefined {
  if (!hasUserBindings(model)) return undefined;
  const ends = bindingEnds(model);
  const memo = (ends.sources ??= new Map());
  const hit = memo.get(symbol);
  if (hit !== undefined || memo.has(symbol)) return hit;
  const source = boundSourceOf(model, symbol);
  if (source !== undefined && !('abstain' in source)) Object.freeze(source.via);
  memo.set(symbol, source === undefined ? undefined : Object.freeze(source));
  return source;
}

/** {@link boundSourceIn}, worked out. */
function boundSourceOf(model: Model, symbol: string): BoundSource | undefined {
  const definitions = sharedDefinitions(model);
  const best = outermostReading(model, symbol);
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
  // instance: the frame that carries the value may be one the cap dropped. So
  // too for a binding joined to a capped one in the global component of the
  // connectors' ends ({@link pastCapComponents}: CAP1's Y, bound to the load a
  // capped binding gives 50); a cap no binding of it reaches never abstains it.
  const capped = member ? (overCap.get(member.id) ?? (carried !== undefined ? overCap.get(carried) : undefined)) : undefined;
  if (capped !== undefined) return { abstain: 'past-cap', sentence: bindingCapSentence(capped) };
  // A package's binding between two features of definitions (`bind P::load =
  // P::cap`) joins them in every instance, each at its own value there: read
  // in the package, the component holds P's own — no value for any instance.
  if (best.head && pairedHeads(model, best.root, best.component)) {
    return { abstain: 'free', sentence: pairedHeadsSentence(model, symbol, best.root, best.component) };
  }
  // A binding whose end is a feature of an instance ENCLOSING where it is
  // written (R's `L` in `part q : Q { bind p.load = L; }`) is read in that
  // enclosing instance (E3): the outermost root's reading holds the end at
  // the path its climb reached it by (`r.L` for r's q), so r's q reads r's L,
  // and r0's q r0's.
  const cls = classified(model, best.root, best.component);
  // The member paths and the connectors are the component's own: one list each
  // for every symbol read through it ({@link componentFacts}), never copied.
  const source = (valuePath: string): BoundSource => ({
    root: best!.root,
    paths: componentPaths(model, best!.root, best!.component),
    component: best!.component,
    via: { bindingIds: componentBindingIds(model, best!.root, best!.component), source: valuePath },
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
  // A package's binding on a definition's feature whose slot an instance
  // fixes outside the component ({@link DefinitionHead.fixed}) says so, not
  // that no member states a value.
  const fixed = bindingEnds(model).heads.get(best.root)?.find((h) => h.component === best.component && h.fixed !== undefined);
  if (cls.heldDefaults.length > 0) {
    return {
      abstain: 'defaults-differ',
      sentence: fixed
        ? fixedHeadSentence(model, symbol, best.root, best.component, fixed)
        : abstentionSentence(model, symbol, best.root, best.component, 'defaults-differ'),
    };
  }
  return {
    abstain: 'free',
    sentence: fixed
      ? fixedHeadSentence(model, symbol, best.root, best.component, fixed)
      : abstentionSentence(model, symbol, best.root, best.component, 'free'),
  };
}

/**
 * Why the value `f` states with `=`, read at the instance `inst`, is not read
 * there: a binding joins it to another value written with `=` that DIFFERS
 * from it (A.5, U11) — `part q : Q { part :>> p { attribute :>> load = 30.0;
 * } }` under Q's `L = 50.0` and `bind p.load = L` (d1plain), or `part p4 : P
 * { attribute :>> load = 7.0; }` under a package's `bind P::load = L`
 * (w4-plain). A value written with `=` is a binding too, so the model states
 * both, and neither is read where the binding joins them: the A.9 `two-values`
 * sentence, with the binding's own row reporting the pair
 * ({@link bindsDifferingWrittenValues}) — none for a package's binding on a
 * definition's feature, whose package-side value, one instance, is still read
 * at its own. The values are compared as
 * written ({@link compareWrittenValues}), as {@link contradictedBindingOf}
 * compares a redefinition with the binding it redefines; a pair only an
 * evaluation could compare is read as before, and the binding's finding is
 * judged at the two values read. `undefined` where `f` writes no `=` value,
 * no binding joins it at `inst`, or no value written there differs from it.
 */
export function statedAgainstBoundIn(model: Model, f: ElementRecord, inst: string): string | undefined {
  // Asked first, per feature: no instance is asked anything of the others.
  if (!statedAgainstBoundSomewhere(model, f)) return undefined;
  const name = sharedDefinitions(model).nameOf(f);
  if (name === undefined) return undefined;
  const symbol = `${inst}::${name}`;
  const src = boundSourceIn(model, symbol);
  if (src === undefined || ('abstain' in src && src.abstain !== 'two-values')) return undefined;
  const best = outermostReading(model, symbol);
  const reading = best ? bindingEnds(model).readings.get(best.root) : undefined;
  // The member the symbol names states `f`'s value, or is the slot `f` redefines (a package's head).
  const own = best ? model.get(best.feature) : undefined;
  if (!best || !reading || !own || !(valueSourceOf(model, own) === f || redefinedClosure(model, f).includes(own))) {
    return undefined;
  }
  const differs = classified(model, best.root, best.component).valued.some((path) => {
    const member = reading.get(path);
    const g = member ? model.get(member.feature) : undefined;
    const written = g ? valueSourceOf(model, g) : undefined;
    // A value an asserted equation states is not written to compare: today's reading stands beside it.
    if (written === undefined || written === f || written.attrs.defaultValue === true) return false;
    return compareWrittenValues(f, written) === 'differs';
  });
  if (!differs) return undefined;
  if ('abstain' in src) return src.sentence;
  return abstentionSentence(model, symbol, best.root, best.component, 'two-values', false);
}

/**
 * Is `f` a value written with `=` that a binding joins, in SOME context it is
 * read in, to another value written with `=` that differs from it
 * ({@link statedAgainstBoundIn})? Both are, and a redefinition with a value of
 * its own of the slot a package's binding joins (`fixed`,
 * {@link DefinitionHead}) is joined so to every value written in that
 * component. The readings that key no instance — the numeric lane's seeds, a
 * generic unit-aware derivation — read none of them, as they read no
 * `default` a binding holds somewhere ({@link defaultGivesWaySomewhere}).
 * Once per revision.
 */
export function statedAgainstBoundSomewhere(model: Model, f: ElementRecord): boolean {
  if (f.attrs.value === undefined || f.attrs.value === null || f.attrs.defaultValue === true) return false;
  if (!hasUserBindings(model)) return false;
  const ends = bindingEnds(model);
  if (!ends.against) {
    const out = new Set<ElementId>();
    const against = (list: readonly ElementRecord[]): void => {
      for (const w of list) if (list.some((o) => o !== w && compareWrittenValues(w, o) === 'differs')) out.add(w.id);
    };
    const fixed: Array<{ head: DefinitionHead; written: ElementRecord[] }> = [];
    for (const [root, reading] of ends.readings) {
      const written = new Map<string, ElementRecord[]>();
      for (const { feature, component } of reading.values()) {
        const g = model.get(feature);
        const w = g ? valueSourceOf(model, g) : undefined;
        if (!w || w.attrs.defaultValue === true) continue;
        const list = written.get(component) ?? [];
        if (!list.includes(w)) list.push(w);
        written.set(component, list);
      }
      for (const list of written.values()) against(list);
      for (const head of ends.heads.get(root) ?? []) {
        if (head.fixed === undefined || !head.redefined) continue;
        fixed.push({ head, written: written.get(head.component) ?? [] });
      }
    }
    if (fixed.length > 0) {
      for (const g of model.all()) {
        if (g.attrs.isLibrary === true || g.attrs.defaultValue === true) continue;
        if (g.attrs.value === undefined || g.attrs.value === null) continue;
        const closure = redefinedClosure(model, g);
        for (const { head, written } of fixed) {
          if (written.length > 0 && closure.some((r) => r.id === head.feature)) against([g, ...written]);
        }
      }
    }
    ends.against = out;
  }
  return ends.against.has(f.id);
}

/**
 * Do the two features a binding's ends denote state values written with `=`
 * that DIFFER as written ({@link compareWrittenValues}) — each end's own
 * value, else the nearest it redefines that states one ({@link valueSourceOf}:
 * an implicit end copy states none of its own), never a `default`? Then the
 * binding itself joins two values the model states (A.5): its own row is
 * violated, though neither end reads either value any more
 * ({@link statedAgainstBoundIn}). A binding whose own ends agree, or one end of
 * which states no such value, is judged at the values read, whatever else its
 * component joins.
 */
export function bindsDifferingWrittenValues(model: Model, a: ElementRecord, b: ElementRecord): boolean {
  const x = valueSourceOf(model, a);
  const y = valueSourceOf(model, b);
  if (x === undefined || y === undefined || x === y) return false;
  if (x.attrs.defaultValue === true || y.attrs.defaultValue === true) return false;
  return compareWrittenValues(x, y) === 'differs';
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
 * same exactly, may be another value in each instance and gives way. Once per
 * (root, component) and revision ({@link componentFacts}).
 */
function standingDefaultPath(
  model: Model,
  root: ElementId,
  component: string,
): { path: string; source: ElementRecord } | undefined {
  const facts = componentFacts(model, root, component);
  if (facts.standing === undefined) facts.standing = standingDefaultOf(model, root, facts.paths) ?? null;
  return facts.standing ?? undefined;
}

/** {@link standingDefaultPath}, worked out over the component's member `paths`, in reading order. */
function standingDefaultOf(
  model: Model,
  root: ElementId,
  paths: readonly string[],
): { path: string; source: ElementRecord } | undefined {
  const { readings } = bindingEnds(model);
  const rootEl = model.get(root);
  const reading = readings.get(root);
  if (!rootEl || !reading) return undefined;
  const definitions = sharedDefinitions(model);
  // A member DEFINED by an asserted equation — its own, or one inherited from
  // a general definition, which {@link endValue} does not see — is a stated
  // value: the default does not stand (H5: an asserted equation stands over a
  // default). `equationsByName` is direct, so the generalisations are walked.
  const asserted = (ownerId: ElementId | null | undefined, name: string | undefined): boolean => {
    if (name === undefined || ownerId == null) return false;
    for (const o of [model.get(ownerId), ...generalizationsOf(model, ownerId)]) {
      if (o && definitions.of(o.id, name).length > 0) return true;
    }
    return false;
  };
  let first: { path: string; source: ElementRecord } | undefined;
  for (const path of paths) {
    const r = reading.get(path);
    const f = r ? model.get(r.feature) : undefined;
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
  const answer = standingDefaultIn(model, symbol);
  recording?.push({ kind: 'stands', symbol, answer });
  return answer;
}

/** {@link defaultStandsIn}, worked out. */
function standingDefaultIn(model: Model, symbol: string): ElementRecord | undefined {
  if (!hasUserBindings(model)) return undefined;
  const definitions = sharedDefinitions(model);
  const best = outermostReading(model, symbol);
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
  // A definition's feature joined so carries every instance's value into the
  // component: where one redefines it with a value of its own (`part p4 : P {
  // attribute :>> load = 7.0; }` under `bind P::load = L`, L valueless), P's
  // default is no value of the component's (L is 7) — none stands.
  if (pairedHeads(model, best.root, best.component, true)) return undefined;
  return standingDefaultPath(model, best.root, best.component)?.source;
}

/**
 * Does the component read in the package `root` join two or more features of
 * definitions ({@link DefinitionHead}) — `bind P::load = P::cap` — which each
 * instance of the definition reads at values of its own? With `orRedefined`,
 * or one a feature with a value of its own redefines in some instance.
 */
function pairedHeads(model: Model, root: ElementId, component: string, orRedefined = false): boolean {
  const heads = (bindingEnds(model).heads.get(root) ?? []).filter((h) => h.component === component);
  return heads.length > 1 || (orRedefined && heads.some((h) => h.redefined || h.fixed !== undefined));
}

/** Why a package's binding between features of definitions gives an instance no value ({@link pairedHeads}). */
function pairedHeadsSentence(model: Model, symbol: string, root: ElementId, component: string): string {
  const sep = symbol.lastIndexOf('::');
  const name = sep >= 0 ? symbol.slice(sep + 2) : symbol;
  const instance = sep >= 0 ? symbol.slice(0, sep) : '';
  const members = componentPaths(model, root, component);
  return (
    `${name} has no value in ${instance}: a binding of ${effectiveQualifiedName(model, root)} joins features of a ` +
    `definition (${members.join(', ')}), each at its own value in every instance, and this tool reads none of them there`
  );
}

/**
 * Why a package's binding on a definition's feature gives an instance no
 * value where some instance fixes that feature outside it ({@link
 * DefinitionHead.fixed}): the binding carries that value into its other
 * ends, and so into every instance, which this tool does not read.
 */
function fixedHeadSentence(model: Model, symbol: string, root: ElementId, component: string, head: DefinitionHead): string {
  const sep = symbol.lastIndexOf('::');
  const name = sep >= 0 ? symbol.slice(sep + 2) : symbol;
  const instance = sep >= 0 ? symbol.slice(0, sep) : '';
  const members = componentPaths(model, root, component);
  return (
    `${name} has no value in ${instance}: a binding of ${effectiveQualifiedName(model, root)} joins ${members.join(', ')} ` +
    `in every instance of ${effectiveQualifiedName(model, head.definition.id)}, and ${head.fixed} gives ${head.path} a value ` +
    'in one of them, which this tool does not read into the others'
  );
}

/** The user packages of a model — `package` elements, nested ones included. */
function userPackages(model: Model): ElementRecord[] {
  return model.all().filter((e) => e.eClass === 'Package' && e.attrs.isLibrary !== true);
}

/**
 * One entry of a user package's {@link DefiningEquations.denote} walk, with
 * its place in the walk over every user package in turn (`order`).
 */
interface PackageDenotation {
  order: number;
  pkg: ElementId;
  path: string;
  denoted: Denotation;
}

/**
 * Every entry of every user package's {@link DefiningEquations.denote} walk,
 * by the feature it denotes — {@link instanceSitesOf}'s union half, built once
 * per {@link DefiningEquations} (one per revision, {@link sharedDefinitions})
 * rather than walked again for each definition a group is read for.
 */
const PACKAGE_DENOTE = new WeakMap<DefiningEquations, ReadonlyMap<ElementId, readonly PackageDenotation[]>>();

/** {@link PACKAGE_DENOTE} of `definitions`, built when first asked. */
function packageDenotations(definitions: DefiningEquations): ReadonlyMap<ElementId, readonly PackageDenotation[]> {
  const hit = PACKAGE_DENOTE.get(definitions);
  if (hit) return hit;
  const byFeature = new Map<ElementId, PackageDenotation[]>();
  let order = 0;
  for (const pkg of userPackages(definitions.model)) {
    for (const [path, denoted] of definitions.denote(pkg.id)) {
      const entry = { order: order++, pkg: pkg.id, path, denoted };
      const list = byFeature.get(denoted.feature.id);
      if (list) list.push(entry);
      else byFeature.set(denoted.feature.id, [entry]);
    }
  }
  PACKAGE_DENOTE.set(definitions, byFeature);
  return byFeature;
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
  // The package entries that denote the definition or a specialiser, in the
  // order the walk over every user package meets them ({@link packageDenotations}).
  const byFeature = packageDenotations(definitions);
  const entries = [...new Set([definition.id, ...definitions.specialisersOf(definition.id).map((s) => s.id)])]
    .flatMap((id) => byFeature.get(id) ?? [])
    .sort((a, b) => a.order - b.order);
  for (const { pkg, path, denoted: d } of entries) {
    const name = definitions.nameOf(d.feature) ?? '';
    const walked = path.slice(path.lastIndexOf('.') + 1) === name && (path.includes('.') || d.reader === pkg);
    add(`${d.instance}::${name}`, walked ? { root: pkg, path } : undefined);
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
 * What one sweep of {@link groupsOf} works out once and asks again for each
 * instance — the instances of one tree share their sites' prefixes, and the
 * guard asks each instance's sites more than once.
 */
interface PathCaches {
  /** {@link inheritedTwice} per owner and name. */
  twice: Map<string, readonly ElementRecord[] | undefined>;
  /** {@link siteWalk} per site root and path. */
  walks: Map<string, SiteWalk>;
  /** {@link instanceElementOf} per instance, by its sites (`null`: none). */
  elements: Map<readonly InstanceSite[], ElementRecord | null>;
}

/** A path name inherited twice: the element, the name, and the features ({@link inheritedTwice}). */
type PathDiamond = { owner: ElementRecord; name: string; features: readonly ElementRecord[] };

/**
 * The {@link DefiningEquations.denote} walk along a site's path, so far: the
 * first diamond on it, else the element it has reached (`undefined` where it
 * reaches none, and stops).
 */
type SiteWalk = { diamond: PathDiamond } | { owner: ElementRecord | undefined };

/**
 * {@link diamondOnPath} for one site, and the element its walk reaches: the
 * walk to the path's last segment ({@link PathCaches.walks}), then that
 * segment — read in what the walk reached, then the element it denotes. Once
 * per site root and path; every path extends a shorter one's walk.
 */
function siteWalk(definitions: DefiningEquations, root: ElementId, path: string, caches: PathCaches): SiteWalk {
  const key = `${root} ${path}`;
  const hit = caches.walks.get(key);
  if (hit) return hit;
  let walk: SiteWalk;
  if (path === '') {
    walk = { owner: definitions.model.get(root) };
  } else {
    const sep = path.lastIndexOf('.');
    const before = siteWalk(definitions, root, sep < 0 ? '' : path.slice(0, sep), caches);
    const step = path.slice(sep + 1);
    if ('diamond' in before || before.owner === undefined) {
      walk = 'diamond' in before ? before : { owner: undefined };
    } else {
      const features = inheritedTwice(definitions.model, before.owner.id, step, caches.twice);
      if (features !== undefined) {
        walk = { diamond: { owner: before.owner, name: step, features } };
      } else {
        const d = definitions.denote(root).get(path);
        walk = { owner: d ? (definitions.subjectOf(d.reader, d.feature) ?? d.feature) : undefined };
      }
    }
  }
  caches.walks.set(key, walk);
  return walk;
}

/**
 * The first segment of an instance's path, spelled from a site ({@link
 * instanceSitesOf}), that the element it is read in inherits twice ({@link
 * inheritedTwice}): the element, the name, and the features. Each segment is
 * read in the site's root, then in what the {@link DefiningEquations.denote}
 * walk reaches along the path before it ({@link siteWalk}). `undefined` where
 * none is.
 */
function diamondOnPath(
  definitions: DefiningEquations,
  sites: readonly InstanceSite[],
  caches: PathCaches,
): PathDiamond | undefined {
  for (const { root, path } of sites) {
    if (path === '') continue;
    const walk = siteWalk(definitions, root, path, caches);
    if ('diamond' in walk) return walk.diamond;
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
 * stands for an instance of Q3's p, which is Q2's p and Q4's p at once. Once
 * per instance ({@link PathCaches.elements}).
 */
function instanceElementOf(
  definitions: DefiningEquations,
  sites: readonly InstanceSite[],
  caches: PathCaches,
): ElementRecord | undefined {
  const hit = caches.elements.get(sites);
  if (hit !== undefined) return hit ?? undefined;
  let element: ElementRecord | undefined;
  if (diamondOnPath(definitions, sites, caches) === undefined) {
    const elements = new Set<ElementRecord | undefined>();
    for (const { root, path } of sites) {
      if (path === '') {
        elements.add(definitions.model.get(root));
        continue;
      }
      const d = definitions.denote(root).get(path);
      elements.add(d ? (definitions.subjectOf(d.reader, d.feature) ?? d.feature) : undefined);
    }
    if (elements.size === 1) [element] = elements;
  }
  caches.elements.set(sites, element ?? null);
  return element;
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
 * `cache` holds {@link readFeatures} per context and relation, and `caches`
 * the path walks ({@link PathCaches}), for one sweep.
 */
function instanceReadsOtherwise(
  definitions: DefiningEquations,
  relation: ElementRecord,
  usage: ElementRecord,
  instance: string,
  sites: readonly InstanceSite[],
  names: readonly string[],
  cache: Map<string, GuardReading | undefined>,
  caches: PathCaches,
): GuardVerdict | undefined {
  const model = definitions.model;
  const head = `${effectiveQualifiedName(model, relation.id)} is not read in ${instance}`;
  const named = (f: ElementRecord | undefined) => (f ? definitions.qualifiedNameOf(f.id) : 'nothing this tool resolves');
  const abstain = (sentence: string): GuardVerdict => ({ kind: 'not-enumerated', sentence });
  const diamond = diamondOnPath(definitions, sites, caches);
  if (diamond !== undefined) {
    const features = diamond.features.map((f) => named(f));
    const listed = `${features.slice(0, -1).join(', ')} and ${features[features.length - 1]}`;
    return abstain(
      `${head}: ${definitions.qualifiedNameOf(diamond.owner.id)} inherits ${listed} ` +
        `under the one name \`${diamond.name}\`, ${diamond.features.length === 2 ? 'neither redefining the other' : 'none redefining another'}, ` +
        'so this tool cannot tell which element stands for it there',
    );
  }
  const element = instanceElementOf(definitions, sites, caches);
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
  // under decision 14 the equation stands, but this reading does not read an
  // assert of the element's own yet, and a reading in the element would read
  // the default — so it abstains.
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
 * below that instance: q2's `assert constraint { p.load >= 0.5 }` over q2's
 * `part :>> p { … }` reading `load`. A.2.4: an enclosing assert constrains
 * the value, and a reading in `element` reads none of it — save an asserted
 * equation that defines a `default` there, which the reading reads at the
 * instance (H5, {@link enclosingAsserts}). `undefined` where none does.
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
        // An equation that defines a `default` the element reads is read at the instance, as a binding is (H5's
        // enclosing rule, {@link assertDefinitionIn}): no reason to abstain.
        const defining = enclosingAsserts(model).byOwner.get(holder.id);
        for (const child of model.children(holder.id)) {
          if (child.attrs.isLibrary === true || !isAsserted(child)) continue;
          const expr = child.attrs.expression;
          if (typeof expr !== 'string' || expr.trim() === '') continue;
          for (const n of relationNamesOf(expr)) {
            for (const p of paths) {
              const remaining = `${below}.${p}`;
              if (n === remaining && defining?.get(n)?.some((eq) => eq.constraint.id === child.id)) continue;
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

/** {@link instanceGroups} per model, keyed on its revision (B.5): nothing survives an edit. */
const INSTANCE_GROUPS = new WeakMap<Model, { rev: number; groups: readonly InstanceGroup[] }>();

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
 *
 * Once per model revision ({@link INSTANCE_GROUPS}, B.5): the check, the
 * obligations lane and the numeric lane each ask it, and the app's validation
 * sweep, Check and Solve ask it again of the same revision. The list, its
 * groups and their instance lists are shared, and frozen, and the maps are
 * read-only — read them, never change them.
 */
export function instanceGroups(model: Model): readonly InstanceGroup[] {
  const hit = INSTANCE_GROUPS.get(model);
  if (hit && hit.rev === model.rev) return hit.groups;
  const groups = Object.freeze(
    groupsOf(model).map((g) => {
      Object.freeze(g.instances);
      if (g.refusal) Object.freeze(g.refusal);
      return Object.freeze(g);
    }),
  );
  INSTANCE_GROUPS.set(model, { rev: model.rev, groups });
  return groups;
}

/** {@link instanceGroups}, worked out. */
function groupsOf(model: Model): InstanceGroup[] {
  const definitions = sharedDefinitions(model);
  if (!readsPerInstance(model)) return [];
  const out: InstanceGroup[] = [];
  const read = new Map<string, GuardReading | undefined>();
  const caches: PathCaches = { twice: new Map(), walks: new Map(), elements: new Map() };
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
            if (diamondOnPath(definitions, own, caches) !== undefined) crossed.add(instance);
            // The element whose own instance this is: the group's row reads the
            // relation there, so that element's context row is this row.
            const element = instanceElementOf(definitions, own, caches);
            if (element !== undefined && element.id !== usage.id && definitions.instanceNameOf(element.id) === instance) {
              standsFor.set(instance, element.id);
            }
            const verdict = instanceReadsOtherwise(definitions, el, usage, instance, own, names, read, caches);
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
 *
 * `inst` is the instance the context is read for. Where it is not the
 * context's own — a group row reads Q's p for `R1::q1::p`, a derived value is
 * read in its definition for the instance it belongs to — the frames are the
 * INSTANCE's: every instance enclosing `inst` ({@link
 * DefiningEquations.framesAbove}), outermost first, the name spelled below
 * each (`p.x` below q1, `q1.p.x` below R1), then the context's own frames
 * below it. Read through the usage's frames alone, R1's group row `P::c in
 * R1::q1::p` read x's default past q1's `assert constraint { p.x == 50.0 }`,
 * decided where the own row `top1`, the same quantity at the same instance,
 * abstained (A-H1). The package is the outermost such frame (H1C's `assert
 * constraint { q1.p.x == 50.0 }` constrains q1's p's x as q1's own does). A
 * type definition's own instance (`R1::Q` above `R1::Q::p`) is no such frame:
 * its asserts hold of every instance of it, and a reading in its usage reads
 * them as today, whether the name is read there or in a value that usage
 * reads.
 */
export function enclosingAssertOn(
  model: Model,
  contextId: ElementId,
  enclosing: readonly InstanceFrame[],
  name: string,
  inst?: string,
): { frame: ElementId; expr: string } | undefined {
  const answer = assertEnclosing(model, contextId, enclosing, name, inst);
  // Where nothing is asserted, the answer is the same for every instance: no question of its spelling.
  if (inst !== undefined && recording !== undefined && sharedDefinitions(model).anyAsserted()) {
    recording.push({ kind: 'enclosing', contextId, enclosing, name, inst, answer });
  }
  return answer;
}

/** {@link enclosingAssertOn}, worked out: only a frame whose reader asserts something is spelled out. */
function assertEnclosing(
  model: Model,
  contextId: ElementId,
  enclosing: readonly InstanceFrame[],
  name: string,
  inst?: string,
): { frame: ElementId; expr: string } | undefined {
  const definitions = sharedDefinitions(model);
  if (!definitions.anyAsserted()) return undefined;
  const root = definitions.instanceNameOf(contextId);
  const segments = name.split('.');
  const constrains = (reader: ElementRecord, remaining: string): { frame: ElementId; expr: string } | undefined => {
    for (const { expr, names } of definitions.assertsOf(reader.id)) {
      for (const n of names) {
        if (n === remaining || n.startsWith(`${remaining}.`) || remaining.startsWith(`${n}.`)) {
          return { frame: reader.id, expr };
        }
      }
    }
    return undefined;
  };
  if (inst !== undefined && inst !== root) {
    for (const frame of definitions.framesAbove(inst) ?? []) {
      if (definitions.assertsOf(frame.reader).length === 0) continue;
      const reader = model.get(frame.reader);
      if (!reader || reader.attrs.isLibrary === true) continue;
      // A type definition's own frame reads as before; a package's is the instance's outermost frame (its
      // `assert constraint { q1.p.x == 50.0 }` constrains q1's p's x as q1's own `p.x == 50.0` does).
      if (isDefinition(reader.eClass) && reader.eClass !== 'Package' && reader.eClass !== 'LibraryPackage') continue;
      if (!inst.startsWith(`${frame.instance}::`)) continue;
      const below = inst.slice(frame.instance.length + 2).split('::');
      const hit = constrains(reader, [...below, ...segments].join('.'));
      if (hit) return hit;
    }
  }
  for (const frame of enclosing) {
    if (definitions.assertsOf(frame.reader).length === 0) continue;
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
    const hit = constrains(reader, remaining);
    if (hit) return hit;
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
