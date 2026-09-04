/**
 * AST → Model mapper for the Langium-backed SysML v2 textual parser.
 *
 * {@link astToModel} runs the Langium services on a source string, walks the
 * resulting AST in DOCUMENT ORDER and builds a live {@link Model} through
 * `Model.create` — producing the *exact same element/relationship shapes* the
 * legacy recursive-descent parser produced (see `../parser.ts`), so the
 * serializer and the whole test suite keep working unchanged.
 *
 * Faithfulness contract (mirrors the legacy parser precisely):
 *  - Metaclass names come from {@link TEXTUAL_KEYWORD} (keyword + `def` +
 *    prefixes → concrete metaclass).
 *  - Attribute typing (`: T` on an attribute) is stored as the plain string
 *    `attrs.type`; resolved typing/specialization on any other feature becomes a
 *    real relationship element (FeatureTyping / Subclassification / Subsetting /
 *    Redefinition / ReferenceSubsetting) owned by the feature.
 *  - Cross-references (typings, connection ends, satisfy/allocate/transition
 *    endpoints) are resolved by qualified/relative name AGAINST THE MODEL BUILT
 *    SO FAR — exactly like the single-pass legacy resolver — so forward
 *    references stay unresolved and are preserved textually in `attrs`
 *    (`typeRef` / `sourceRef` / `targetRef` / `specializes` / `redefines` /
 *    `references`) with a `warning` diagnostic.
 *  - `direction` / `multiplicity` / `value` / `reqId` / `text` / `trigger` /
 *    `guard` / `effect` / `expression` / `stateSubaction` / `requirementRole`
 *    are stored on `attrs` with the identical keys the legacy parser used.
 *  - Langium lexer/parser diagnostics are mapped to `error` {@link ParseDiagnostic}s.
 *
 * The grammar itself is a clean-room implementation of the OMG SysML v2 / KerML
 * textual notation (see `sysml.langium` and docs/LICENSES.md).
 */

import {
  Model,
  ModelFactory,
  isDefinition,
  isMembership,
  isRelationship,
  isSpecialization,
  refSegments,
  TEXTUAL_KEYWORD,
  unquoteName,
  type ElementId,
  type ElementRecord,
  type AttrValue,
} from '@core/index';
import {
  resolveFullName,
  resolveImportTargets,
  resolveRedefinedFeature,
} from '@semantics/bind';
import { generalizationsWithImplicit } from '@semantics/featuring';
import { resolveName } from '@semantics/resolve-names';
import type { AstNode } from 'langium';
import type { ParseResult, ParseDiagnostic } from '../types';
import type { TextRange } from '@validation/types';
import { parseDocument } from './module';
import { findUnterminatedDelimiter } from './lexical-scan';
import { bracePairs, rehomeAfterFault } from './rehome';
import {
  codeForParserError,
  expectedFromMessage,
  foundFromMessage,
  refineParserError,
  renderHint,
} from './diagnostic-codes';
import type {
  Alias,
  Allocate,
  Annotation,
  BehaviorStmt,
  Bind,
  BracketExpr,
  Comment as CommentNode,
  Connect,
  TextualRep as TextualRepNode,
  ControlNode,
  Definition,
  Dependency,
  Derive,
  Doc,
  Expression,
  FirstThen,
  IfStmt,
  Import,
  LoopStmt,
  Member,
  Multiplicity,
  Refine,
  RelationshipStmt,
  RequirementClause,
  ReturnStmt,
  Satisfy,
  Specialization,
  StateBehavior,
  Succession,
  Trace,
  Transition,
  Verify,
} from './generated/ast';

/* ───────────────────────── keyword / prefix tables ──────────────────────── */

/** Space-stripped keyword (e.g. `partdef`, `usecase`) → metaclass. */
const KEYWORD_TO_ECLASS = new Map<string, string>();
for (const [eClass, kw] of Object.entries(TEXTUAL_KEYWORD)) {
  KEYWORD_TO_ECLASS.set(kw.replace(/\s+/g, ''), eClass);
}
// `metadata` has no TEXTUAL_KEYWORD entry (the legacy parser never mapped it);
// map it best-effort so the mapper never crashes on a valid metadata keyword.
KEYWORD_TO_ECLASS.set('metadata', 'MetadataUsage');
KEYWORD_TO_ECLASS.set('metadatadef', 'MetadataDefinition');
// The grammar also accepts the `render` alias for rendering usages.
KEYWORD_TO_ECLASS.set('render', 'RenderingUsage');

const DIRECTIONS = new Set(['in', 'out', 'inout']);

/** Control-node keyword → metaclass (mirrors the legacy CONTROL_NODE_KEYWORD). */
const CONTROL_NODE_ECLASS: Record<string, string> = {
  fork: 'ForkNode',
  join: 'JoinNode',
  merge: 'MergeNode',
  decide: 'DecisionNode',
  initial: 'InitialNode',
  done: 'DoneNode',
};

/** Behavioural action-statement keyword → metaclass (SysML action/state usages). */
const BEHAVIOR_ECLASS: Record<string, string> = {
  accept: 'AcceptActionUsage',
  send: 'SendActionUsage',
  assign: 'AssignmentActionUsage',
  perform: 'PerformActionUsage',
  exhibit: 'ExhibitStateUsage',
  include: 'IncludeUseCaseUsage',
  terminate: 'ActionUsage',
};

/** Loop-statement keyword → metaclass. */
const LOOP_ECLASS: Record<string, string> = {
  while: 'WhileLoopActionUsage',
  until: 'WhileLoopActionUsage',
  loop: 'WhileLoopActionUsage',
  for: 'ForLoopActionUsage',
};

/* ─────────────────────────── small utilities ────────────────────────────── */

/**
 * Inner text of an `ML_COMMENT` token (`/* … *\/`), trimmed like the lexer.
 *
 * `raw` is typed as `string` by the generated AST but is genuinely `undefined`
 * when error recovery hands back a Comment node whose body never terminated —
 * an unterminated `/*` at end of file. That threw a TypeError out of
 * `parseModel`, so an agent whose only mistake was forgetting `*\/` got a crash
 * instead of a diagnostic. Degrade to an empty body and let the parser's own
 * errors describe the problem.
 */
function stripBlockComment(raw: string | undefined): string {
  if (raw === undefined || raw === null) return '';
  let s = raw;
  if (s.startsWith('/*')) s = s.slice(2);
  if (s.endsWith('*/')) s = s.slice(0, -2);
  return s.trim();
}

/**
 * The source lexeme of a numeric value, when `String(value)` would not
 * reproduce it and only while `Number(lexeme)` still denotes the value.
 *
 * `terminal NUMBER returns number` converts at CST→AST time, so by the time the
 * mapper sees `1500.0` it is the JS number 1500 and re-serializes as `1500`;
 * `1e3` becomes `1000`. The number stays in `attrs.value` — the solver, unit
 * evaluation, conformance and the query engine all read it as a number — and
 * the lexeme travels beside it in `attrs.valueText`, which the serializer
 * prefers only while it still denotes the same number. Clean cases (`= 42`)
 * get no attribute at all, so the model stays byte-identical for them.
 */
function valueTextFor(expr: Expression, value: unknown): { valueText?: string } {
  if (typeof value !== 'number') return { valueText: undefined };
  const lexeme = expr.$cstNode?.text?.trim();
  // Keep the lexeme only while `Number(lexeme)` reproduces the value — the same
  // guard the serializer applies when it reads it back. A folded signed
  // literal written as `- 2` has a lexeme `Number()` cannot parse; storing it
  // would make parse → serialize → parse drift, so it is dropped here.
  return {
    valueText: lexeme && lexeme !== String(value) && Number(lexeme) === value ? lexeme : undefined,
  };
}

/** 1-based line/column of an AST node (falls back to 1,1). */
function posOf(node: AstNode | undefined): { line: number; column: number } {
  const start = node?.$cstNode?.range?.start;
  if (!start) return { line: 1, column: 1 };
  return { line: (start.line ?? 0) + 1, column: (start.character ?? 0) + 1 };
}

/**
 * Position of the end of `text`, used when an error points at the EOF token.
 *
 * Chevrotain's EOF token carries NaN line/column, which reached agents as
 * `NaN:NaN` — a position that cannot be navigated to and that breaks any
 * consumer doing arithmetic on it. An error at end of file is precisely the
 * "you forgot a closing brace" case, so it must report the last real position.
 */
function eofPos(text: string): { line: number; column: number; offset: number } {
  const lines = text.split('\n');
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
    offset: text.length,
  };
}

/**
 * The LEXER's name for a token: `'ID'` for an identifier, the keyword itself
 * for a keyword. It is the only non-guessing answer to "did the author write a
 * word the grammar knows?", which `refineParserError` needs to tell a
 * misspelled keyword from a stray identifier.
 */
function tokenTypeName(token: unknown): string | undefined {
  return (token as { tokenType?: { name?: string } } | undefined)?.tokenType?.name;
}

/**
 * Full source span of an AST node: 1-based line/column, 0-based offsets.
 *
 * Returns `undefined` when the node carries no CST node — which is exactly the
 * error-recovery case, where the parser synthesised the node and there is no
 * honest position to report. Callers must degrade rather than invent one.
 */
function rangeOf(node: AstNode | undefined): TextRange | undefined {
  const cst = node?.$cstNode;
  const r = cst?.range;
  if (!cst || !r) return undefined;
  return {
    start: {
      line: (r.start.line ?? 0) + 1,
      column: (r.start.character ?? 0) + 1,
      offset: cst.offset ?? 0,
    },
    end: {
      line: (r.end.line ?? 0) + 1,
      column: (r.end.character ?? 0) + 1,
      offset: cst.end ?? cst.offset ?? 0,
    },
  };
}

/** Format a multiplicity node back into the legacy compact string form. */
function formatMultiplicity(m: Multiplicity): string {
  const lo = String(m.lower);
  return m.upper !== undefined && m.upper !== null ? `${lo}..${String(m.upper)}` : lo;
}

/** Verbatim source text of an expression node (trimmed), for free-form fragments. */
function exprText(expr: Expression | undefined): string {
  return (expr?.$cstNode?.text ?? '').trim();
}

/**
 * The unit spelled by a bracket operand, as `attrs.unit` stores it: quoted
 * name segments unquoted (`'m/s'` → `m/s`, `SI::'watt hour'` → `SI::watt hour`)
 * and whitespace outside quotes removed (`m / s` → `m/s`), separators kept as
 * written. Quotes are the notation's escape, not part of the unit; the
 * serializer puts them back (`unitLexeme`) only where the grammar needs them.
 */
function unitTextOf(text: string): string {
  return text.replace(/'((?:\\.|[^'\\])*)'|\s+/g, (_m, inner: string | undefined) =>
    inner === undefined ? '' : inner.replace(/\\(.)/g, '$1'),
  );
}

/* ───────────────────────── shared name resolution ───────────────────────── */

/** Enclosing-scope chain (innermost → outermost → null root scope). */
function scopeChain(model: Model, scopeOwnerId: ElementId | null): Array<ElementId | null> {
  const scopes: Array<ElementId | null> = [];
  let cur: ElementId | null = scopeOwnerId;
  const guard = new Set<ElementId>();
  while (cur != null && !guard.has(cur)) {
    scopes.push(cur);
    guard.add(cur);
    cur = model.get(cur)?.ownerId ?? null;
  }
  scopes.push(null);
  return scopes;
}

function nameMatches(e: ElementRecord, seg: string): boolean {
  return e.declaredName === seg || e.declaredShortName === seg;
}

/**
 * Can a usage-scoped mirror of `el` be materialised for a connector end?
 *
 * Only FEATURES are mirrored. A definition, package or relationship reached
 * through inheritance is named, not owned: copying one would invent a nested
 * definition nobody wrote, so those bind directly instead.
 */
function isMaterialisableFeature(el: ElementRecord): boolean {
  return (
    !isDefinition(el.eClass) &&
    !isRelationship(el.eClass) &&
    el.eClass !== 'Package' &&
    el.eClass !== 'LibraryPackage'
  );
}

/* ─────────────── connector feature-chain endpoint resolution ─────────────── */

/**
 * Connector-family metaclasses whose textual endpoints (`connect a.p to b.p`)
 * are FEATURE CHAINS: a later segment may name a feature declared on the TYPE
 * of the usage reached by the earlier segments (or on the type of an enclosing
 * usage, for a bare `p`). Only these classes get chain materialization —
 * transitions, satisfies, aliases, typings etc. keep the plain resolver.
 */
const CHAIN_CONNECTOR_CLASSES = new Set([
  'ConnectionUsage',
  'Connector',
  'InterfaceUsage',
  'BindingConnectorAsUsage',
  'Flow',
  'FlowUsage',
]);

/**
 * Transitive specialization closure of `el`: every element reachable through
 * resolved specialization relationships (FeatureTyping / Subsetting /
 * Redefinition / Subclassification) plus still-textual `attrs.typeRef` strings
 * (resolved in-model, read-only — this never binds a typeRef; that stays
 * `resolveTypeReferences`' job). Cycle-safe (A :> B :> A terminates).
 */
function typeClosure(model: Model, el: ElementRecord): ElementRecord[] {
  const out: ElementRecord[] = [];
  const seen = new Set<ElementId>([el.id]);
  const stack: ElementRecord[] = [el];
  while (stack.length) {
    const cur = stack.pop()!;
    const next: ElementRecord[] = [...model.typesOf(cur.id)];
    const typeRef = cur.attrs.typeRef;
    if (typeof typeRef === 'string') {
      const t = resolveFullName(model, typeRef, cur.ownerId, { exclude: cur.id });
      if (t) next.push(t);
    }
    for (const n of next) {
      if (!seen.has(n.id)) {
        seen.add(n.id);
        out.push(n);
        stack.push(n);
      }
    }
  }
  return out;
}

/** Feature named `seg` inherited from `el`'s type closure (not a direct child). */
function findTypeFeature(model: Model, el: ElementRecord, seg: string): ElementRecord | undefined {
  for (const t of typeClosure(model, el)) {
    const hit = model.children(t.id).find((e) => nameMatches(e, seg));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Ensure `owner` has a usage-scoped feature mirroring the type-owned `proto`:
 * reuse an existing same-named child, else materialize an IMPLICIT nested usage
 * (`attrs.implicit === true`, suppressed by the serializer) that redefines
 * `proto`. This is the standard implicit-feature materialization that keeps
 * `connect a.p to b.p` endpoints distinct per usage (no self-edges) and owned
 * by the usage (so IBD edges land on the usage nodes).
 */
function ensureImplicitFeature(
  model: Model,
  owner: ElementRecord,
  proto: ElementRecord,
): ElementRecord {
  const name = proto.declaredName ?? proto.declaredShortName ?? '';
  const existing = model.children(owner.id).find((c) => nameMatches(c, name));
  if (existing) return existing;
  const attrs: Record<string, AttrValue> = { implicit: true };
  if (typeof proto.attrs.direction === 'string') attrs.direction = proto.attrs.direction;
  // DETERMINISTIC id (no randomness): a stable hash of a fixed prefix + the
  // owner's QUALIFIED NAME + the feature name. The qualified-name path is stable
  // across parses and across collab clients (it is built from declared names,
  // not the random per-element UUIDs), so re-derivation and concurrent clients
  // converge on the SAME id instead of minting duplicate same-named implicit
  // features. `<owner-qname>::name` is unique (a name is unique among an owner's
  // children), so the id is collision-safe.
  const ownerQName = model.qualifiedName(owner.id);
  const fid = implicitId('impl', ownerQName, name);
  const created = model.create(proto.eClass, {
    id: model.has(fid) ? undefined : fid,
    ownerId: owner.id,
    declaredName: proto.declaredName,
    declaredShortName: proto.declaredShortName,
    attrs,
  });
  const rid = implicitId('impl-redef', ownerQName, name);
  model.create('Redefinition', {
    id: model.has(rid) ? undefined : rid,
    ownerId: created.id,
    source: [created.id],
    target: [proto.id],
  });
  return created;
}

/** Deterministic, collision-safe id from a prefix + parts (FNV-1a, no randomness). */
function implicitId(prefix: string, ...parts: string[]): string {
  const key = parts.join(' ');
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return `${prefix}-${hex}`;
}

/**
 * Walk a chain `segs` starting from `anchor`. Each segment prefers a direct
 * containment child; failing that, a feature inherited through the type
 * closure. `commit=false` is a side-effect-free dry run (an inherited feature
 * is traversed as the type-owned prototype itself); `commit=true` materializes
 * an implicit usage-scoped feature per inherited hop. Both modes visit the
 * same names, so a successful dry run guarantees a successful commit.
 */
function walkChain(
  model: Model,
  anchor: ElementRecord,
  segs: string[],
  commit: boolean,
): ElementRecord | undefined {
  let cur = anchor;
  for (const seg of segs) {
    const direct = model.children(cur.id).find((e) => nameMatches(e, seg));
    if (direct) {
      cur = direct;
      continue;
    }
    const proto = findTypeFeature(model, cur, seg);
    if (!proto) return undefined;
    cur = commit ? ensureImplicitFeature(model, cur, proto) : proto;
  }
  return cur;
}

/**
 * Resolve a connector endpoint reference as a feature chain, materializing
 * implicit usage-scoped features for segments that live on types. Returns the
 * usage-scoped endpoint element, or `undefined` when the chain is genuinely
 * unresolvable (in which case NO implicit element is created — resolution is
 * dry-run first, so a half-resolvable `a.b.missing` leaves no debris).
 */
function resolveChainEnd(
  model: Model,
  ref: string,
  scopeOwnerId: ElementId | null,
): ElementRecord | undefined {
  const segs = refSegments(ref);
  if (segs.length === 0) return undefined;
  const scopes = scopeChain(model, scopeOwnerId);

  const [head, ...rest] = segs;
  const tryAnchor = (anchor: ElementRecord): ElementRecord | undefined => {
    if (!walkChain(model, anchor, rest, false)) return undefined; // dry run
    return walkChain(model, anchor, rest, true);
  };

  // ANCHOR DISCOVERY uses the spec walk (owned + alias → inherited → imported,
  // outward), so `connect a to x` finds the `x` a supertype contributes instead
  // of an unrelated `x` in an enclosing package. But an anchor reached through
  // INHERITANCE OR A TYPE is only a prototype: binding the endpoint to it
  // directly would make every usage of the same definition share one endpoint
  // element, collapsing `connect a.p to b.p` into a self-edge on the
  // definition. Such an anchor is MATERIALISED as a usage-scoped implicit
  // feature instead — which is what keeps `battery.powerOut` distinct per
  // connection in examples/uav-isr.sysml.
  //
  // INHERITANCE, and nothing else. The test is that the anchor's owner is in
  // the scope's own generals closure — NOT merely "the scope does not own it",
  // which was also true of a member reached through `import Lib::*;`. A package
  // inherits nothing, so there is no prototype to mirror there: mirroring one
  // fabricated an implicit `P::x` plus a Redefinition and bound the connector
  // to the invention instead of the imported feature. An imported anchor is a
  // real element the author named; it binds directly.
  //
  // Every LATER segment stays with walkChain for the same reason: it prefers
  // containment and materialises per inherited hop.
  for (const s of scopes) {
    const hit = resolveName(model, s, head);
    if (!hit) continue;
    const scopeEl = s === null ? undefined : model.get(s);
    const inherited =
      s !== null &&
      hit.ownerId != null &&
      hit.ownerId !== s &&
      generalizationsWithImplicit(model, s).some((g) => g.id === hit.ownerId);
    if (!inherited || scopeEl === undefined || !isMaterialisableFeature(hit)) {
      const end = tryAnchor(hit);
      if (end) return end;
      continue;
    }
    if (!walkChain(model, hit, rest, false)) continue; // dry run before materializing
    const anchor = ensureImplicitFeature(model, scopeEl, hit);
    const end = walkChain(model, anchor, rest, true);
    if (end) return end;
  }
  // Containment fallback: a name `resolveName` does not enumerate (a named
  // relationship element) can still be a connector end.
  for (const s of scopes) {
    const kids = s === null ? model.roots() : model.children(s);
    const hit = kids.find((e) => nameMatches(e, head));
    if (hit) {
      const end = tryAnchor(hit);
      if (end) return end;
    }
  }
  // Finally a bare `p` naming a feature of an enclosing usage's TYPE.
  for (const s of scopes) {
    if (s === null) continue;
    const scopeEl = model.get(s);
    if (!scopeEl) continue;
    const proto = findTypeFeature(model, scopeEl, head);
    if (!proto) continue;
    if (!walkChain(model, proto, rest, false)) continue; // dry run before materializing
    const anchor = ensureImplicitFeature(model, scopeEl, proto);
    const end = walkChain(model, anchor, rest, true);
    if (end) return end;
  }
  return undefined;
}

/**
 * Post-type-binding pass: re-resolve still-textual connector endpoints as
 * feature chains. Needed when a chain traverses a type only bound AFTER parse
 * time (a standard-library type resolved by `resolveTypeReferences`). Safe to
 * re-run (idempotent: implicit features are found and reused, resolved
 * endpoints are skipped). Exposed via the text module for the UI store; the
 * mapper runs the same logic at parse time for types known in-source.
 *
 * @returns the number of endpoint references newly resolved.
 */
export function resolveConnectorFeatureChains(model: Model): number {
  let resolved = 0;
  model.transaction(() => {
    for (const el of model.all()) {
      if (!CHAIN_CONNECTOR_CLASSES.has(el.eClass)) continue;
      if (el.attrs.isLibrary === true) continue;
      resolved += resolveChainEndpointsOf(model, el);
    }
  });
  return resolved;
}

/** Chain-resolve the still-textual endpoints of one connector. @returns count. */
function resolveChainEndpointsOf(model: Model, el: ElementRecord): number {
  let n = 0;
  const scope = el.ownerId;
  if (typeof el.attrs.sourceRef === 'string' && (el.source?.length ?? 0) === 0) {
    const r = resolveChainEnd(model, el.attrs.sourceRef, scope);
    if (r && r.id !== el.id) {
      model.update(el.id, { source: [r.id] });
      model.setAttrs(el.id, { sourceRef: undefined });
      n++;
    }
  }
  if (typeof el.attrs.targetRef === 'string' && (el.target?.length ?? 0) === 0) {
    const r = resolveChainEnd(model, el.attrs.targetRef, scope);
    if (r && r.id !== el.id) {
      model.update(el.id, { target: [r.id] });
      model.setAttrs(el.id, { targetRef: undefined });
      n++;
    }
  }
  return n;
}

/* ─────────────────────────────── the mapper ─────────────────────────────── */

class Mapper {
  readonly model = new Model();
  readonly factory = new ModelFactory(this.model);
  readonly diagnostics: ParseDiagnostic[] = [];

  /**
   * The source text and the offsets the lexer could not tokenise, for the one
   * place the AST is known to be lossy: a bracket unit whose spelling holds a
   * character the lexer skipped (`[m²]` reaches the parser as `[m]`). The unit
   * is then sliced from the source, so the model never carries a silently
   * different dimension — the lexer error itself is still reported.
   */
  source = '';
  lexerErrorOffsets: number[] = [];

  /**
   * Source span of every element this mapper created (Agent Diagnostics
   * Contract). A SIDE TABLE — never written onto `ElementRecord`, because a
   * range belongs to one source text, not to the model.
   */
  readonly ranges = new Map<ElementId, TextRange>();

  /**
   * The target of the last succession mapped in each owner scope.
   *
   * SysML chains successions: `first a then b; then c; then d;` means a→b→c→d,
   * where a bare `then X` continues from the PREVIOUS succession's target. The
   * mapper used to require both endpoints, so every bare `then` was dropped —
   * silently, with no diagnostic. examples/uav-isr.sysml writes three of them
   * and got one succession. Keyed by owner so two sibling behaviours cannot
   * chain into each other.
   */
  private readonly lastSuccessionTarget = new Map<ElementId | null, string>();

  /**
   * Warnings about an unresolved SPECIALIZATION reference, paired with the
   * element and attribute that still hold the unresolved name.
   *
   * These warnings are true at parse time but become STALE once the library
   * binder resolves the reference (a forward reference to a type declared later
   * in the file is the normal case). The binder runs outside this mapper, so the
   * pairing is published on the {@link ParseResult} and retracted by whoever
   * runs the binder — see `retractResolvedSpecializationWarnings`. Without this,
   * a perfectly valid model reports "Unresolved reference" for every forward
   * type reference in it.
   */
  readonly deferredSpecializationWarnings: Array<{
    diagnostic: ParseDiagnostic;
    elementId: ElementId;
    attr: string;
    ref?: string;
  }> = [];

  /**
   * Every `:`/`:>`/`:>>`/`::>` written in the source, in DECLARATION ORDER,
   * recorded as a NAME rather than resolved on the spot.
   *
   * Resolution happens once, in {@link resolveDeferredRefs}, because the answer
   * depends on the finished namespace: what `W` denotes inside
   * `part def Car :> Base` cannot be known until `Car :> Base` itself is bound,
   * which cannot be known until every declaration has been seen. Resolving as
   * the mapper walked the AST is what made declaration order decide the answer.
   */
  private readonly deferredSpecs: DeferredSpec[] = [];

  /**
   * Warnings that are only TRUE if the reference is still unresolved once
   * {@link resolveDeferredRefs} has finished. They are held here rather than
   * emitted at the declaration, so a reference to something declared later in
   * the file never produces a warning that a later pass has to take back.
   */
  private readonly pendingWarnings: PendingWarning[] = [];

  /**
   * Owner namespace → the namespaces its imports bring into scope, built once
   * for {@link scopeGainedGeneral}. Imports are all bound before the
   * specialization fixpoint runs and never change after, so the map is stable.
   */
  private importTargetsByScope: Map<ElementId, ElementId[]> | null = null;

  /**
   * The member declaration currently being mapped. Every element created while
   * it is on the stack is attributed to its span, which is what an agent needs:
   * "the problem is in THIS declaration, at these lines".
   */
  private readonly nodeStack: AstNode[] = [];

  /**
   * The parser errors of THIS parse, as the two offsets the residue hunt needs.
   *
   * When a member's keyword is unknown, the `Body` rule does not fault on it:
   * it takes the trailing-expression branch, so the bad word is consumed as an
   * expression and the mismatch is reported on the token AFTER it. Those two
   * offsets — where the residue text begins (`previousToken`) and where the
   * parser stopped (`token`) — are the only things error recovery leaves
   * behind (`resyncedTokens` is always empty), and they are what
   * {@link residueOfFault} and {@link markUnparsedResidue} run on.
   */
  private faultErrors: ReadonlyArray<{ tokenOffset: number; previousToken?: TokenSpan }> = [];

  /**
   * Residues found while walking: the source offset each faulty declaration
   * starts at, the offset the parser stopped at, and the element the swallowed
   * text was welded onto as `attrs.expression`. Filled by
   * {@link noteResidueOfFault} at the two trailing-expression sites, consumed
   * by {@link markUnparsedResidue} once every element (and its range) exists.
   */
  private readonly faultResidues: Array<{
    start: number;
    tokenOffset: number;
    weldedTo: ElementId;
  }> = [];

  /**
   * Create an element and record its source span. Every `create` inside the
   * mapper goes through here so ranges cannot silently go missing when a new
   * mapping branch is added.
   */
  private create(
    eClass: string,
    opts: Parameters<Model['create']>[1] = {},
    node?: AstNode,
  ): ElementRecord {
    const el = this.model.create(eClass, opts);
    // `node` is for elements built AFTER the AST walk (the deferred resolution
    // sweep), where the declaration stack is empty but the declaration that
    // asked for the element is still known.
    const range = rangeOf(node ?? this.nodeStack[this.nodeStack.length - 1]);
    if (range) this.ranges.set(el.id, range);
    return el;
  }

  private warn(message: string, node?: AstNode, code?: string): ParseDiagnostic {
    const { line, column } = posOf(node);
    const diag: ParseDiagnostic = {
      message,
      line,
      column,
      severity: 'warning',
      source: 'mapper',
      ...(code ? { code, hint: renderHint(code) } : {}),
      ...(rangeOf(node) ? { range: rangeOf(node) } : {}),
    };
    this.diagnostics.push(diag);
    return diag;
  }

  /**
   * Record a reference that MIGHT be unresolved. Nothing is emitted here: the
   * warning is written only if, after the whole file has been mapped and every
   * reference resolved, `attr` still holds `ref`.
   */
  private defer(
    elementId: ElementId,
    attr: string,
    ref: string,
    message: string,
    code: string,
    node: AstNode,
    retractOnRef = true,
    survives?: () => boolean,
  ): void {
    this.pendingWarnings.push({
      elementId,
      attr,
      ref,
      message,
      code,
      node,
      retractOnRef,
      ...(survives ? { survives } : {}),
    });
  }

  /** Does `el.attrs[attr]` still hold `ref`? (An array attr holds several.) */
  private stillUnresolved(w: PendingWarning): boolean {
    const el = this.model.get(w.elementId);
    if (!el) return false;
    // A shared slot cannot answer for one name among several — the site gave a
    // predicate that asks about THIS name instead.
    if (w.survives) return w.survives();
    const v = el.attrs[w.attr];
    if (v === undefined) return false;
    if (Array.isArray(v)) return v.includes(w.ref);
    return typeof v === 'string' ? v === w.ref : true;
  }

  /**
   * Emit the warnings whose reference is STILL unresolved, in source order.
   *
   * Source order, not the order the passes happened to decide things in: an
   * agent reads diagnostics as a list of places to go, and grouping them by
   * which internal pass gave up sends it up and down the file.
   *
   * One warning per (code, message, span). A statement with several targets —
   * `subtype Missing specializes B, C;` — creates one relationship PER target
   * and defers the SOURCE warning on each, which would tell the author twice
   * that `Missing` is missing. The duplicates still all register for
   * retraction, so the library binder resolving any one of them takes the
   * single warning back.
   */
  private emitPendingWarnings(): void {
    const live = this.pendingWarnings.filter((w) => this.stillUnresolved(w));
    live.sort((a, b) => (a.node.$cstNode?.offset ?? 0) - (b.node.$cstNode?.offset ?? 0));
    const emitted = new Map<string, ParseDiagnostic>();
    for (const w of live) {
      const key = `${w.code} ${w.message} ${w.node.$cstNode?.offset ?? -1}`;
      const diag = emitted.get(key) ?? this.warn(w.message, w.node, w.code);
      emitted.set(key, diag);
      // Register for RETRACTION by the library binder: a reference that only
      // the standard library can resolve is still unresolved here, and the
      // warning must disappear once the binder succeeds.
      this.deferredSpecializationWarnings.push({
        diagnostic: diag,
        elementId: w.elementId,
        attr: w.attr,
        ...(w.retractOnRef ? { ref: w.ref } : {}),
      });
    }
  }

  /* ────────────────────────── name resolution ───────────────────────────── */

  private resolveRef(
    ref: string,
    scopeOwnerId: ElementId | null,
    excludeId?: ElementId,
  ): ElementRecord | undefined {
    return resolveFullName(this.model, ref, scopeOwnerId, {
      ...(excludeId === undefined ? {} : { exclude: excludeId }),
    });
  }

  /* ────────────────────────────── entry ────────────────────────────────── */

  /**
   * Map the members, repair recovery damage, then resolve deferred references.
   *
   * `fault` is the source offset of the first parser error, when there was one.
   * Error recovery parses every declaration after a fault one scope OUT of its
   * body (see `rehome.ts`), so the re-homing runs BEFORE resolution: a
   * reference that failed only because of wrong ownership then resolves
   * normally, instead of producing a false "unresolved" finding.
   *
   * Warnings come LAST, after resolution, so the only ones written are about
   * references nothing in the file resolves.
   */
  run(members: Member[], fault?: Fault): void {
    this.faultErrors = fault?.errors ?? [];
    this.model.transaction(() => {
      for (const m of members) this.mapMember(m, null);
      if (fault) {
        this.markUnparsedResidue(fault.text);
        rehomeAfterFault(this.model, fault.text, this.ranges, fault.offset);
      }
      this.resolveDeferredRefs();
      this.emitPendingWarnings();
    });
  }

  /**
   * Note a trailing expression that may be the RESIDUE of a faulted member
   * rather than a real body expression.
   *
   * `Body` is `'{' members* expr? '}'`, so an unknown leading word is not a
   * member fault: the rule takes the trailing-expression branch, swallows the
   * word, and only then mismatches on the token after it. The swallowed word
   * is welded onto the PARENT as `attrs.expression` — which is how
   * `package P { blok def Vehicle; }` used to save as `Vehicle;` plus a
   * dangling `blok` at the end of the body, a file that re-parses CLEAN.
   *
   * NOTHING IS STRIPPED HERE. The offsets alone cannot tell the residue of
   * `blok def Vehicle;` from a REAL one-reference constraint body whose fault
   * is the token after it (`constraint c { a x }` parses identically: a bare
   * `RefExpr` ending at the token before the mismatch). Stripping on that
   * evidence deleted the constraint's expression, so the strip is deferred to
   * {@link markUnparsedResidue} and happens only if the residue text is
   * actually attached to an element — the strip and the mark are two halves of
   * one signal, and losing the text both ways is the one outcome forbidden.
   *
   * The candidate test stays narrow: only a bare reference (`RefExpr`) that
   * either BEGINS at the token before the fault (`blok def Vehicle;`) or ENDS
   * there (`A::B c;`, one reference spelled with several tokens). The parser's
   * own CST cannot answer this — it is truncated at the fault, so the error
   * token lies outside every AST span.
   */
  private noteResidueOfFault(expr: Expression | undefined, weldedTo: ElementId): void {
    const cst = expr?.$cstNode;
    if (expr === undefined || cst === undefined || expr.$type !== 'RefExpr') return;
    for (const e of this.faultErrors) {
      const prev = e.previousToken;
      if (prev === undefined) continue;
      // Chevrotain end offsets are INCLUSIVE; CST `end` is exclusive.
      const endsAtPrevToken = prev.endOffset !== undefined && cst.end === prev.endOffset + 1;
      if (cst.offset === prev.startOffset || endsAtPrevToken) {
        this.faultResidues.push({ start: cst.offset, tokenOffset: e.tokenOffset, weldedTo });
        return;
      }
    }
  }

  /**
   * Can this element carry `unparsedText` — i.e. will the serializer emit it
   * as a statement of its own?
   *
   * Kept in sync with `bodyMembers` in `src/text/serializer.ts`: a
   * specialization may be rendered INLINE on its source's declaration line, an
   * implicit-containment membership and a `FeatureValue` are never text at all.
   * Marking one of those hid the residue instead of preserving it — the save
   * dropped the text and the file re-parsed CLEAN, which is the exact
   * laundering this pass exists to stop.
   */
  private canCarryResidue(id: ElementId): boolean {
    const el = this.model.get(id);
    if (el === undefined) return false;
    if (isSpecialization(el.eClass)) return false;
    if (isMembership(el.eClass) && el.eClass !== 'Membership') return false;
    if (el.eClass === 'FeatureValue') return false;
    return true;
  }

  /**
   * Give the residue of each faulted declaration its own source text back, so
   * a save reproduces the fault instead of hiding it.
   *
   * The declaration's TAIL still parses (`blok def Vehicle;` leaves a
   * keyword-less `Vehicle`), so the element exists and carries a range; what
   * is missing is everything before it. `unparsedText` is the source from
   * where the residue began to the end of that element, and the serializer
   * emits it verbatim and nothing else. When that lands, the swallowed text is
   * removed from the parent it was welded onto — the strip happens HERE, and
   * only here, so text is never lost twice.
   *
   * Four guards keep a wrong span out of the file:
   *  - the file must be brace-balanced (an unbalanced one is ambiguous about
   *    every scope, and `rehomeAfterFault` declines on the same signal);
   *  - the element must sit in the same brace body as the fault;
   *  - no `;` or `}` may separate the fault from it, because a residue is ONE
   *    statement — without that test the mark swallowed the healthy
   *    declaration that merely came next (`blok 5;` + `part def B { … }`) and
   *    froze its whole subtree behind a verbatim string;
   *  - the sliced text must itself be brace-balanced, so a bodied residue
   *    (`blok def V { part x; }`) is emitted whole rather than cut at its
   *    first `;`, which would re-parse to a DIFFERENT fault.
   */
  private markUnparsedResidue(text: string): void {
    if (this.faultResidues.length === 0) return;
    const pairs = bracePairs(text);
    if (pairs === undefined) return;
    /** The `{` of the innermost body containing `offset`; -1 at file level. */
    const scopeOf = (offset: number): number => {
      let best = -1;
      for (const p of pairs) {
        if (p.open < offset && offset < p.close && p.open > best) best = p.open;
      }
      return best;
    };
    const ranged = [...this.ranges]
      .map(([id, r]) => ({ id, start: r.start.offset, end: r.end.offset }))
      .filter((x) => this.model.get(x.id)?.attrs.implicit !== true)
      .sort((a, b) => a.start - b.start);

    for (const residue of this.faultResidues) {
      const scope = scopeOf(residue.tokenOffset);
      const target = ranged.find(
        (x) =>
          x.start >= residue.tokenOffset &&
          x.end > residue.start &&
          scopeOf(x.start) === scope &&
          !/[;}]/.test(text.slice(residue.tokenOffset, x.start)) &&
          this.canCarryResidue(x.id),
      );
      if (target === undefined) continue;
      const el = this.model.get(target.id);
      if (el === undefined || typeof el.attrs.unparsedText === 'string') continue;
      const verbatim = text.slice(residue.start, target.end);
      if (bracePairs(verbatim) === undefined) continue; // would re-parse differently
      this.model.setAttrs(target.id, { unparsedText: verbatim });
      // The other half of the mark: the text now lives on the residue element,
      // so it must not ALSO stay welded onto the body that swallowed it.
      this.model.setAttrs(residue.weldedTo, { expression: undefined });
    }
  }

  /**
   * THE resolution point — every textual reference in the file is bound here,
   * once, against the finished model.
   *
   * WHY ONE POINT. Binding used to be split: the mapper resolved whatever
   * happened to exist when it reached a declaration, and the library binder
   * picked up the rest afterwards with DIFFERENT scoping rules. Which resolver
   * answered a given reference therefore depended on where in the file it was
   * written, and the two disagreed about inherited members, so `part w : W`
   * inside `part def Car :> Base` denoted the outer `W` when written after its
   * declaration and the inherited one when written before.
   *
   * THE ORDER MATTERS, and it is the whole design:
   *
   *  1. INDIRECTIONS — in-file imports and aliases. Nothing can resolve
   *     *through* `import Lib::*;` or `alias A for W;` until they have a
   *     target, and their own targets may be declared later.
   *  2. THE SPECIALIZATION FAMILY (`:>` / `:>>` / `::>`), to a FIXPOINT and
   *     BEFORE any typing is decided. These build the inheritance graph every
   *     later answer depends on, and binding one can enable another (`A :> B`
   *     where `B :> C` is itself forward), so one sweep is not enough. It is
   *     this ORDERING that answers `part def W; part def Base :> Grand;
   *     part def Car :> Base { part w1 : W; } part def Grand { part def W; }`
   *     with `Grand::W`: `Car`'s inheritance is complete before `w1` is asked.
   *  3. TYPINGS (`:`) — which also add generals — then the endpoints, aliases
   *     and dependencies that read the finished graph.
   *  4. RE-DECISION, for the generals step 2 cannot see: a TYPING adds one too.
   *     In `part def W; part c : T { part w1 : W; } part def T :> G;
   *     part def G { part def W; }`, `c : T` and `w1 : W` are decided in the
   *     same round, and only once `c` is typed can `w1` see `G::W`. So a
   *     reference bound in an earlier round is re-decided when anything it
   *     resolves THROUGH gained a general — its scope chain, those scopes'
   *     generals, and the namespaces they import (see
   *     {@link scopeGainedGeneral}, which was too narrow when it walked the
   *     scope chain alone). Monotone — generals are only ever ADDED, so a
   *     re-decision moves inward and the loop terminates.
   *
   * WHICH mechanism answers WHICH witness, because they are easy to confuse:
   * the ORDERING in (2) answers the transitive-supertype witness (`Base :>
   * Grand` forward), and the RE-DECISION in (4) answers the typing-chain
   * witness (`c : T` gaining a general). Either alone survives the loss of the
   * other on those two; losing BOTH loses the I4 witnesses themselves.
   *
   * Each round DECIDES without mutating and then APPLIES, because `Model.emit`
   * bumps `rev` on every mutation and every resolver memo is keyed on `rev`:
   * interleaving would cold-start the name cache and the generalization
   * closures once per binding.
   */
  private resolveDeferredRefs(): void {
    // (1) The names other names resolve THROUGH: in-file imports and aliases.
    //     Both must be bound BEFORE anything else, because `part p : A;` where
    //     `alias A for Real2;` reads the alias's TARGET — an unbound alias made
    //     `p` bind to the alias Membership itself and validation then reported a
    //     feature typed by a non-type. They can also feed each other
    //     (`import Lib::*;` then `alias A for AWidget;`), so they loop until
    //     nothing new binds. Library-free: `import Lib::*;` where `Lib` is in
    //     this file resolves without the standard library being loaded at all.
    const indirections = this.model
      .all()
      .filter(
        (e) =>
          e.eClass === 'NamespaceImport' ||
          e.eClass === 'MembershipImport' ||
          (e.eClass === 'Membership' && typeof e.attrs.aliasFor === 'string'),
      ).length;
    for (let round = 0; round <= indirections; round++) {
      if (resolveImportTargets(this.model) + this.bindAliases() === 0) break;
    }

    // (2) The specialization family to a fixpoint, BEFORE any typing is
    //     decided, so the inheritance graph is complete when typings resolve.
    this.specializationFixpoint((r) => r.op !== ':');
    // (3)+(4) Then everything, re-deciding earlier answers each round.
    this.specializationFixpoint(() => true);

    // Endpoints, aliases and dependencies. They READ the graph above and never
    // extend it — a bound connector end adds no general — so one sweep is a
    // fixpoint.
    this.bindEndpointRefs();

    // Whatever is still unbound falls back to its textual form.
    this.recordUnresolvedSpecs();
    this.restoreSpecializationOrder();
  }

  /**
   * Decide-then-apply rounds over the deferred specializations matching
   * `filter`, until no answer changes.
   *
   * A request already bound is RE-decided every round: that is what closes the
   * transitive-supertype witness in the class comment. Retargeting an existing
   * relationship (rather than creating a second one) is what keeps the element
   * set stable and the pass idempotent.
   */
  private specializationFixpoint(filter: (r: DeferredSpec) => boolean): void {
    // Each round either changes an answer or stops; an answer can change at
    // most once per general added, and generals only grow.
    const limit = this.deferredSpecs.length + 2;
    /** Elements that gained a general in the previous round; null = first round. */
    let gained: Set<ElementId> | null = null;
    for (let round = 0; round < limit; round++) {
      // Phase 1 — decide, without mutating (every resolver memo stays hot).
      const decided: Array<{ req: DeferredSpec; targetId: ElementId }> = [];
      for (const req of this.deferredSpecs) {
        if (!filter(req)) continue;
        // An ALREADY-BOUND reference is only worth re-deciding when its scope
        // chain gained a general since — that is the only way full resolution
        // can produce a different (nearer) answer. Without this gate every
        // round re-resolves every reference in the file, which is quadratic on
        // a big flat package and finds nothing.
        if (req.targetId !== undefined && gained !== null && !this.scopeGainedGeneral(req, gained)) {
          continue;
        }
        const target = this.resolveSpecTarget(req);
        if (!target || target.id === req.targetId) continue;
        decided.push({ req, targetId: target.id });
      }
      if (decided.length === 0) return;

      // Phase 2 — apply.
      const nowGained = new Set<ElementId>();
      for (const { req, targetId } of decided) {
        const el = this.model.get(req.elementId);
        if (!el) continue;
        if (req.relId !== undefined) {
          this.model.update(req.relId, { target: [targetId] });
        } else {
          const rel = this.create(
            relClassForOp(req.op, isDefinition(el.eClass)),
            { ownerId: el.id, source: [el.id], target: [targetId] },
            req.node,
          );
          req.relId = rel.id;
        }
        req.targetId = targetId;
        nowGained.add(el.id);
      }
      gained = nowGained;
    }
  }

  /**
   * Did anything this reference resolves THROUGH gain a general last round?
   *
   * "Through" is the scope chain, the general types of each scope, AND the
   * namespaces each scope imports (plus THEIR generals) — because that is
   * exactly what `resolveName` consults: owned + alias, then inherited, then
   * imported. Walking only the scope chain made the gate too narrow rather
   * than merely conservative: in
   *
   *     package P { part def Grand { part def W; } part def T :> Grand;
   *                 part H : T; }
   *     package Outer { part def W;
   *                     package Use { import P::H::*; part def C :> W; } }
   *
   * `H : T` and `C :> W` are decided in the SAME round, so `C` first answers
   * with `Outer::W`; the general `H` then gains is on a namespace reached
   * through `Use`'s import, which the scope walk never visits, so nothing was
   * ever re-decided and the mapper's answer disagreed with its own resolver.
   *
   * Import targets are read from a map built ONCE (imports are all bound in
   * step (1) and never change afterwards): scanning each scope's children per
   * request per round would be quadratic on a big flat package, which is the
   * cost this gate exists to avoid.
   */
  private scopeGainedGeneral(req: DeferredSpec, gained: Set<ElementId>): boolean {
    const imports = this.importTargetsByScope ?? this.buildImportTargets();
    let scope = this.model.get(req.elementId)?.ownerId ?? null;
    const seen = new Set<ElementId>();
    while (scope !== null && !seen.has(scope)) {
      seen.add(scope);
      if (this.namespaceGained(scope, gained)) return true;
      for (const nsId of imports.get(scope) ?? []) {
        if (this.namespaceGained(nsId, gained)) return true;
      }
      scope = this.model.get(scope)?.ownerId ?? null;
    }
    return false;
  }

  /** Did `id` — or anything it inherits from — gain a general last round? */
  private namespaceGained(id: ElementId, gained: Set<ElementId>): boolean {
    if (gained.has(id)) return true;
    for (const g of generalizationsWithImplicit(this.model, id)) {
      if (gained.has(g.id)) return true;
    }
    return false;
  }

  /** Owner namespace → the namespaces its imports bring into scope. */
  private buildImportTargets(): Map<ElementId, ElementId[]> {
    const map = new Map<ElementId, ElementId[]>();
    for (const el of this.model.all()) {
      if (el.eClass !== 'NamespaceImport' && el.eClass !== 'MembershipImport') continue;
      const owner = el.ownerId;
      const nsId = (el.target ?? [])[0];
      if (owner == null || !nsId) continue;
      const cur = map.get(owner);
      if (cur) cur.push(nsId);
      else map.set(owner, [nsId]);
    }
    this.importTargetsByScope = map;
    return map;
  }

  /**
   * Bind `alias N for Target;` Memberships whose target now resolves.
   *
   * @returns the number newly bound.
   */
  private bindAliases(): number {
    let bound = 0;
    for (const el of this.model.all()) {
      if (el.eClass !== 'Membership') continue;
      if ((el.target ?? []).length > 0) continue;
      const ref = el.attrs.aliasFor;
      if (typeof ref !== 'string') continue;
      const r = this.resolveRef(ref, el.ownerId, el.id);
      if (!r || r.id === el.id) continue;
      this.model.update(el.id, { target: [r.id] });
      this.model.setAttrs(el.id, { aliasFor: undefined });
      bound++;
    }
    return bound;
  }

  /** The element one deferred specialization denotes, or `undefined`. */
  private resolveSpecTarget(req: DeferredSpec): ElementRecord | undefined {
    const el = this.model.get(req.elementId);
    if (!el) return undefined;
    // The scope is read NOW, not at map time: `rehomeAfterFault` may have moved
    // the declaration back into the body it was written in.
    const scope = el.ownerId;
    // KerML §8.2.3.5.1 gives a redefinition its own rule — the generals of the
    // owning type are the local namespaces, tried before ordinary resolution.
    return req.op === ':>>'
      ? resolveRedefinedFeature(this.model, req.ref, el.id, scope)
      : resolveFullName(this.model, req.ref, scope, { exclude: el.id });
  }

  /**
   * Specializations that never resolved fall back to the textual form the
   * serializer and the library binder read — and get their warning queued.
   *
   * An unresolved `:` on an ATTRIBUTE stays SILENT (`attrs.type`): a value type
   * (`Real`, `String`, …) usually lives outside the loaded scope, and warning
   * about every one of them would bury the references that are genuinely
   * broken. Pinned by the `L3-unresolved-attribute-type-is-silent` fixture.
   */
  private recordUnresolvedSpecs(): void {
    for (const req of this.deferredSpecs) {
      if (req.relId !== undefined) continue;
      const el = this.model.get(req.elementId);
      if (!el) continue;
      if (req.op === ':') {
        if (el.eClass === 'AttributeUsage' || el.eClass === 'AttributeDefinition') {
          this.model.setAttrs(el.id, { type: req.ref });
          continue;
        }
        this.model.setAttrs(el.id, { typeRef: req.ref });
        // `typeRef` is a single slot; two unresolved `:` types on one feature
        // (`part x : Gone1, Gone2;`) overwrite each other. Two consequences,
        // and they need different answers. RETRACTION still tests only that
        // the slot was emptied (`retractOnRef` false) — the library binder
        // clears the slot, it does not rewrite a name. EMISSION cannot use the
        // slot at all: testing `typeRef === 'Gone1'` dropped the first name's
        // warning and reported only the last. Every request that reaches here
        // is one the fixpoint already failed to bind, so the answer is simply
        // yes, as long as the element survived.
        this.defer(
          el.id,
          'typeRef',
          req.ref,
          `Unresolved reference '${req.ref}'`,
          'ref/unresolved-specialization',
          req.node,
          /* retractOnRef */ false,
          () => this.model.get(el.id) !== undefined,
        );
        continue;
      }
      const key = req.op === ':>>' ? 'redefines' : req.op === '::>' ? 'references' : 'specializes';
      const cur = (el.attrs[key] as string[] | undefined) ?? [];
      this.model.setAttrs(el.id, { [key]: [...cur, req.ref] });
      this.defer(
        el.id,
        key,
        req.ref,
        `Unresolved reference '${req.ref}'`,
        'ref/unresolved-specialization',
        req.node,
      );
    }
  }

  /**
   * Put each element's specialization relationships back into DECLARATION
   * order.
   *
   * The fixpoint decides `:>` before `:`, so `part def A : T :> B;` would
   * otherwise own its Subclassification before its FeatureTyping and re-emit as
   * `part def A :> B : T;`. `specializationFragments` in the serializer reads
   * them in child order, and `reparent` to the same owner moves a child to the
   * end — so replaying the declarations in order restores it.
   */
  private restoreSpecializationOrder(): void {
    const byOwner = new Map<ElementId, ElementId[]>();
    for (const req of this.deferredSpecs) {
      if (req.relId === undefined) continue;
      const list = byOwner.get(req.elementId);
      if (list) list.push(req.relId);
      else byOwner.set(req.elementId, [req.relId]);
    }
    for (const [ownerId, relIds] of byOwner) {
      if (relIds.length < 2) continue;
      const current = this.model.children(ownerId).filter((c) => relIds.includes(c.id));
      if (current.every((c, i) => c.id === relIds[i])) continue; // already in order
      for (const relId of relIds) this.model.reparent(relId, ownerId);
    }
  }

  /**
   * Bind the endpoint, alias and dependency references — every reference that
   * names an element rather than a type.
   *
   * Runs over a snapshot: relationships created above are not revisited.
   */
  private bindEndpointRefs(): void {
    const worklist = this.model.all();
    for (const el of worklist) {
      // Capture the scope once — the reparent below mutates el.ownerId, and
      // every ref in this statement resolves against the scope it was written
      // in, not a re-homed owner.
      const scope = el.ownerId;
      const spec = isSpecialization(el.eClass);

      // Multi-endpoint Dependency: rebuild source/target from the clients/
      // suppliers name lists (the single sourceRef/targetRef holds only the
      // first endpoint, so it is lossy for these).
      if (el.eClass === 'Dependency') {
        this.upgradeDependency(el, scope);
        continue;
      }

      // Connector endpoint that is a FEATURE CHAIN through a type (`a.p` where
      // `p` is declared on the type of `a`, or a bare `p` on the type of an
      // enclosing usage): materialize an implicit usage-scoped feature and bind
      // the endpoint to THAT — never to the shared type-owned feature (which
      // would collapse same-type connectors into self-edges and re-home edges
      // onto the definition). The chain resolver owns EVERY segment of a
      // connector end, so it runs FIRST for these classes; the plain resolver
      // below only sees what it could not bind (a qualified cross-package name).
      if (CHAIN_CONNECTOR_CLASSES.has(el.eClass)) resolveChainEndpointsOf(this.model, el);

      // Endpoint source. For a specialization relationship owned by its source
      // (mapRelationshipStmt), re-home it onto the resolved source so the
      // serializer's specializationFragments can emit it.
      const sref = el.attrs.sourceRef;
      let sourceResolved = (el.source?.length ?? 0) > 0;
      if (typeof sref === 'string' && !sourceResolved) {
        const r = this.resolveRef(sref, scope, el.id);
        if (r && r.id !== el.id) {
          this.model.update(el.id, { source: [r.id] });
          this.model.setAttrs(el.id, { sourceRef: undefined });
          sourceResolved = true;
          // A `:>`-family relationship built while its source name was still
          // unbound defaulted to Subsetting (mapRelationshipStmt). Now that the
          // source is known, upgrade to Subclassification when it is a
          // definition — matching what the inline `part def A :> B;` form and
          // a re-parse of the serialized text produce.
          if (el.eClass === 'Subsetting' && isDefinition(r.eClass)) {
            this.model.update(el.id, { eClass: 'Subclassification' });
          }
          // A relationship STATEMENT belongs to its source, so the serializer
          // can inline it back onto that declaration.
          if ((spec || el.eClass === 'Disjoining') && el.ownerId !== r.id) {
            this.model.reparent(el.id, r.id);
          }
        }
      }
      // Endpoint target. A specialization relationship whose source is still
      // dangling must NOT get a resolved target — a half-relationship would be
      // mis-inlined onto its (wrong) owner.
      const tref = el.attrs.targetRef;
      if (typeof tref === 'string' && (el.target?.length ?? 0) === 0 && (!spec || sourceResolved)) {
        // A Redefinition STATEMENT is the same construct as the inline `:>>`,
        // so it must use the same rule (KerML §8.2.3.5.1) — otherwise
        // `redefinition w redefines w;` self-bound and reported
        // `specialization-cycle` while `part w :>> w;` was clean, and one
        // save/re-parse silently made the error disappear. The source feature
        // is already bound above, which is what the rule needs.
        const srcId = (el.source ?? [])[0];
        const r =
          el.eClass === 'Redefinition' && srcId
            ? resolveRedefinedFeature(this.model, tref, srcId, this.model.get(srcId)?.ownerId ?? scope)
            : this.resolveRef(tref, scope, el.id);
        if (r && r.id !== el.id) {
          this.model.update(el.id, { target: [r.id] });
          this.model.setAttrs(el.id, { targetRef: undefined });
        }
      }

      // Alias (`alias N for Target`).
      if (
        el.eClass === 'Membership' &&
        typeof el.attrs.aliasFor === 'string' &&
        (el.target ?? []).length === 0
      ) {
        const r = this.resolveRef(el.attrs.aliasFor, scope, el.id);
        if (r && r.id !== el.id) {
          this.model.update(el.id, { target: [r.id] });
          this.model.setAttrs(el.id, { aliasFor: undefined });
        }
      }
    }
  }

  /**
   * Rebuild a Dependency's `source`/`target` endpoint arrays from its full
   * `clients`/`suppliers` name lists (finding F4/D3). The build-time
   * `sourceRef`/`targetRef` capture only the FIRST unresolved client/supplier, so
   * a multi-endpoint dependency with any forward endpoint would otherwise be left
   * with wrong endpoints even though every name is resolvable now.
   */
  private upgradeDependency(el: ElementRecord, scope: ElementId | null): void {
    const resolveList = (key: string): ElementId[] | undefined => {
      const refs = el.attrs[key];
      if (!Array.isArray(refs)) return undefined;
      const ids: ElementId[] = [];
      for (const ref of refs) {
        const r = typeof ref === 'string' ? this.resolveRef(ref, scope) : undefined;
        if (r) ids.push(r.id);
      }
      return ids;
    };
    const endpoints: { source?: ElementId[]; target?: ElementId[] } = {};
    const clears: Record<string, AttrValue | undefined> = {};

    const clientIds = resolveList('clients');
    if (clientIds && clientIds.length > (el.source?.length ?? 0)) {
      endpoints.source = clientIds;
      if (clientIds.length === (el.attrs.clients as unknown[]).length) clears.sourceRef = undefined;
    } else if (typeof el.attrs.sourceRef === 'string' && (el.source?.length ?? 0) === 0) {
      const r = this.resolveRef(el.attrs.sourceRef, scope);
      if (r) {
        endpoints.source = [r.id];
        clears.sourceRef = undefined;
      }
    }

    const supplierIds = resolveList('suppliers');
    if (supplierIds && supplierIds.length > (el.target?.length ?? 0)) {
      endpoints.target = supplierIds;
      if (supplierIds.length === (el.attrs.suppliers as unknown[]).length) clears.targetRef = undefined;
    } else if (typeof el.attrs.targetRef === 'string' && (el.target?.length ?? 0) === 0) {
      const r = this.resolveRef(el.attrs.targetRef, scope);
      if (r) {
        endpoints.target = [r.id];
        clears.targetRef = undefined;
      }
    }

    if (endpoints.source || endpoints.target) this.model.update(el.id, endpoints);
    if (Object.keys(clears).length) this.model.setAttrs(el.id, clears);
  }

  /* ────────────────────────────── members ──────────────────────────────── */

  private mapMember(node: Member, ownerId: ElementId | null): void {
    this.nodeStack.push(node);
    try {
      this.mapMemberInner(node, ownerId);
    } finally {
      this.nodeStack.pop();
    }
  }

  private mapMemberInner(node: Member, ownerId: ElementId | null): void {
    switch (node.$type) {
      case 'Doc':
        return this.mapDoc(node as Doc, ownerId);
      case 'Comment': {
        // `comment C about A, B locale "en-GB" /* … */`. The name, the `about`
        // targets and the locale are all in the grammar and were all dropped
        // here, so a save rewrote the statement as a bare `comment` and the
        // reader lost what it was about. `about` holds raw qualified names —
        // the same shape `@Meta about X` stores (see mapAnnotation) — because
        // a comment may point at something declared later, or outside the file.
        const cm = node as CommentNode;
        const cmAttrs: Record<string, AttrValue> = { body: stripBlockComment(cm.body) };
        if (cm.about && cm.about.length) cmAttrs.about = [...cm.about];
        // Presence, not truth: `locale ""` is a tag the author wrote, and
        // dropping it here is the same silent loss this case exists to fix.
        if (cm.locale !== undefined) cmAttrs.locale = cm.locale;
        this.create('Comment', {
          ownerId: ownerId ?? undefined,
          declaredName: unquoteName(cm.name),
          attrs: cmAttrs,
        });
        return;
      }
      case 'TextualRep': {
        // A free-standing `/* … */` block comment, or a `rep`/`language` textual
        // representation. Captured as a TextualRepresentation element so it
        // survives round-trip (the serializer re-emits it); previously dropped
        // (finding L2). Body text is stripped of its `/* */` delimiters.
        const tr = node as TextualRepNode;
        const trAttrs: Record<string, AttrValue> = { body: stripBlockComment(tr.body) };
        if (tr.language) trAttrs.language = tr.language;
        this.create('TextualRepresentation', {
          ownerId: ownerId ?? undefined,
          declaredName: unquoteName(tr.name),
          attrs: trAttrs,
        });
        return;
      }
      case 'Annotation':
        return this.mapAnnotation(node as Annotation, ownerId);
      case 'Alias':
        return this.mapAlias(node as Alias, ownerId);
      case 'Dependency':
        return this.mapDependency(node as Dependency, ownerId);
      case 'Bind':
        return this.mapBind(node as Bind, ownerId);
      case 'RelationshipStmt':
        return this.mapRelationshipStmt(node as RelationshipStmt, ownerId);
      case 'ReturnStmt':
        return this.mapReturnStmt(node as ReturnStmt, ownerId);
      case 'LoopStmt':
        return this.mapLoopStmt(node as LoopStmt, ownerId);
      case 'IfStmt':
        return this.mapIfStmt(node as IfStmt, ownerId);
      case 'BehaviorStmt':
        return this.mapBehaviorStmt(node as BehaviorStmt, ownerId);
      case 'Import':
        return this.mapImport(node as Import, ownerId);
      case 'Connect':
        return this.mapConnect(node as Connect, ownerId);
      case 'Satisfy':
        return this.mapSatisfy(node as Satisfy, ownerId);
      case 'Verify': {
        const v = node as Verify;
        return this.mapRequirementRelation('Verify', v.requirement, v.by, node, ownerId, v.visibility);
      }
      case 'Refine': {
        const r = node as Refine;
        return this.mapRequirementRelation('Refine', r.requirement, r.by, node, ownerId, r.visibility);
      }
      case 'Trace': {
        const t = node as Trace;
        return this.mapRequirementRelation('Trace', t.requirement, t.to, node, ownerId, t.visibility);
      }
      case 'Derive': {
        const d = node as Derive;
        return this.mapRequirementRelation('Derive', d.requirement, d.from, node, ownerId, d.visibility);
      }
      case 'Allocate':
        return this.mapAllocate(node as Allocate, ownerId);
      case 'Succession': {
        const s = node as Succession;
        this.makeEdge('Succession', ownerId, s.source, s.target, node);
        return;
      }
      case 'FirstThen': {
        const ft = node as FirstThen;
        if (!ft.target) return;
        // A bare `then X` chains from the previous succession's target.
        const source = ft.source ?? this.lastSuccessionTarget.get(ownerId);
        if (!source) {
          const code = 'parse/dangling-then';
          this.diagnostics.push({
            message: `'then ${ft.target}' has nothing to follow — no preceding succession in this scope.`,
            ...posOf(node),
            severity: 'error',
            source: 'mapper',
            code,
            found: 'then',
            hint: renderHint(code, { found: 'then' }),
            ...(rangeOf(node) ? { range: rangeOf(node) } : {}),
          });
          return;
        }
        this.makeEdge('Succession', ownerId, source, ft.target, node);
        this.lastSuccessionTarget.set(ownerId, ft.target);
        return;
      }
      case 'Transition':
        return this.mapTransition(node as Transition, ownerId);
      case 'StateBehavior':
        return this.mapStateBehavior(node as StateBehavior, ownerId);
      case 'ControlNode':
        return this.mapControlNode(node as ControlNode, ownerId);
      case 'RequirementClause':
        return this.mapRequirementClause(node as RequirementClause, ownerId);
      case 'Definition':
        return this.mapDefinition(node as Definition, ownerId);
      default:
        return;
    }
  }

  private mapDoc(node: Doc, ownerId: ElementId | null): void {
    const body = stripBlockComment(node.body);
    const owner = ownerId != null ? this.model.get(ownerId) : undefined;
    if (owner && (owner.eClass === 'RequirementUsage' || owner.eClass === 'RequirementDefinition')) {
      this.model.setAttrs(owner.id, { text: body });
    } else {
      // F-follow-up: `doc name /* … */` carries an optional name — preserve it
      // so the serializer's `doc ${name} /* … */` round-trips.
      const docName = node.name !== undefined ? unquoteName(node.name) : undefined;
      this.create('Documentation', {
        ownerId: ownerId ?? undefined,
        declaredName: docName,
        attrs: { body },
      });
    }
  }

  private mapImport(node: Import, ownerId: ElementId | null): void {
    // The grammar allows a bare `import ;` (nameless) — treat it as a no-op
    // rather than crashing on `undefined.includes` (deep-session E2E finding).
    const name = node.importedName;
    if (!name) return;
    const wildcard = name.includes('*');
    const attrs: Record<string, AttrValue> = { importedName: name };
    if (node.visibility) attrs.visibility = node.visibility;
    if (node.filters && node.filters.length) {
      attrs.filters = node.filters.map((f) => exprText(f));
    }
    this.create(wildcard ? 'NamespaceImport' : 'MembershipImport', {
      ownerId: ownerId ?? undefined,
      attrs,
    });
  }

  /** `@Type { … }` metadata annotation → a MetadataUsage carrying the type. */
  private mapAnnotation(node: Annotation, ownerId: ElementId | null): void {
    const attrs: Record<string, AttrValue> = { annotation: true, type: node.type };
    if (node.about && node.about.length) attrs.about = [...node.about];
    const el = this.create('MetadataUsage', {
      ownerId: ownerId ?? undefined,
      attrs,
    });
    if (node.body) for (const m of node.body.members) this.mapMember(m, el.id);
  }

  /** `alias N for Target` → a named Membership pointing at the target. */
  private mapAlias(node: Alias, ownerId: ElementId | null): void {
    const targetRef = node.target;
    const attrs: Record<string, AttrValue> = {};
    if (node.visibility) attrs.visibility = node.visibility;
    if (targetRef) attrs.aliasFor = targetRef;
    const el = this.create('Membership', {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      declaredShortName: unquoteName(node.shortName),
      target: [],
      attrs,
    });
    if (targetRef) {
      this.defer(el.id, 'aliasFor', targetRef, `Unresolved alias target '${targetRef}'`, 'ref/unresolved-alias-target', node);
    }
    // F-follow-up: `alias b for a { … }` body members were silently dropped.
    if (node.body) for (const m of node.body.members) this.mapMember(m, el.id);
  }

  /** `dependency (id from)? clients… to suppliers…` → a Dependency relationship. */
  private mapDependency(node: Dependency, ownerId: ElementId | null): void {
    const attrs: Record<string, AttrValue> = {};
    if (node.client.length) attrs.sourceRef = node.client[0];
    if (node.supplier.length) attrs.targetRef = node.supplier[0];
    // The full lists are kept only when there is more than one endpoint (a
    // single one lives on sourceRef/targetRef) — the shape the serializer and
    // `upgradeDependency` both read.
    if (node.client.length > 1) attrs.clients = [...node.client];
    if (node.supplier.length > 1) attrs.suppliers = [...node.supplier];
    const el = this.create('Dependency', {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      declaredShortName: unquoteName(node.shortName),
      source: [],
      target: [],
      attrs,
    });
    // A multi-endpoint dependency keeps only its FIRST name in sourceRef /
    // targetRef, so the slot cannot say which of `a, missing` failed — tested
    // against the slot it named `a`, the one that resolved. Each name therefore
    // carries a predicate that re-asks the real question about ITSELF once the
    // fixpoint has run. The retraction entry stays slot-shaped (`retractOnRef`
    // false): the library binder empties the slot, it does not rewrite a name.
    const stillMissing = (ref: string) => () => this.resolveRef(ref, ownerId) === undefined;
    for (const c of node.client) {
      this.defer(el.id, 'sourceRef', c, `Unresolved dependency client '${c}'`, 'ref/unresolved-dependency-end', node, false, stillMissing(c));
    }
    for (const sup of node.supplier) {
      this.defer(el.id, 'targetRef', sup, `Unresolved dependency supplier '${sup}'`, 'ref/unresolved-dependency-end', node, false, stillMissing(sup));
    }
  }

  /** `bind a = b` / `binding a = b` → a BindingConnectorAsUsage endpoint pair. */
  private mapBind(node: Bind, ownerId: ElementId | null): void {
    const attrs: Record<string, AttrValue> = {};
    if (node.ofPayload) attrs.ofPayload = node.ofPayload;
    const el = this.makeEdge('BindingConnectorAsUsage', ownerId, node.source, node.target, node, attrs);
    // F-follow-up: `bind a = b { … }` body members were silently dropped.
    if (node.body) for (const m of node.body.members) this.mapMember(m, el.id);
  }

  /**
   * Named KerML relationship statement (`subset X subsets Y;`, `typing t X : Y;`,
   * `disjoint A from B;`). Each becomes a specialization-family (or Disjoining)
   * relationship element, owned by the resolved source when possible.
   */
  private mapRelationshipStmt(node: RelationshipStmt, ownerId: ElementId | null): void {
    const srcRef = node.source;

    if (node.kind === 'disjoint') {
      const tgtRef = node.target;
      const dj = this.create('Disjoining', {
        ownerId: ownerId ?? undefined,
        source: [],
        target: [],
        attrs: {
          ...(srcRef ? { sourceRef: srcRef } : {}),
          ...(tgtRef ? { targetRef: tgtRef } : {}),
        },
      });
      if (srcRef) {
        this.defer(dj.id, 'sourceRef', srcRef, `Unresolved relationship source '${srcRef}'`, 'ref/unresolved-reference', node);
      }
      if (tgtRef) {
        this.defer(dj.id, 'targetRef', tgtRef, `Unresolved disjoint target '${tgtRef}'`, 'ref/unresolved-reference', node);
      }
      return;
    }

    for (const spec of node.specializations) {
      const op = normalizeSpecOp(spec.op);
      for (const tgtRef of spec.types) {
        // The relationship METACLASS depends on whether the source is a
        // definition (`subtype A specializes B;` on a definition must build a
        // Subclassification, exactly like the inline `part def A :> B;` form),
        // and the source name is not resolved yet — so this defaults to
        // Subsetting and `bindEndpointRefs` upgrades it once the source binds.
        const rel = this.create(relClassForOp(op, false), {
          ownerId: ownerId ?? undefined,
          source: [],
          target: [],
          attrs: {
            ...(srcRef ? { sourceRef: srcRef } : {}),
            targetRef: tgtRef,
          },
        });
        if (srcRef) {
          this.defer(rel.id, 'sourceRef', srcRef, `Unresolved relationship source '${srcRef}'`, 'ref/unresolved-reference', node);
        }
        this.defer(rel.id, 'targetRef', tgtRef, `Unresolved reference '${tgtRef}'`, 'ref/unresolved-specialization', spec);
      }
    }
  }

  /** `return (ref)? name (: T)? (= expr)?` → a result ReferenceUsage feature. */
  private mapReturnStmt(node: ReturnStmt, ownerId: ElementId | null): void {
    const el = this.create('ReferenceUsage', {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      attrs: { featureRole: 'return' },
    });
    for (const spec of node.specializations) this.applySpecialization(el, spec);
    const mults = (node.multiplicity ?? []).map(formatMultiplicity);
    if (mults.length) this.model.setAttrs(el.id, { multiplicity: mults[mults.length - 1] });
    if (node.valueOp && node.value) {
      this.model.setAttrs(el.id, this.splitValueUnit(node.value));
      // `:=` provenance (F-follow-up): keep return/behavior statements from
      // drifting to `=` on re-emission.
      if (node.valueOp === ':=' || node.valueOp.endsWith(':=')) {
        this.model.setAttrs(el.id, { initialValue: true });
      }
    }
  }

  /** `while/until c { … }`, `for x : T in coll { … }`, `loop { … }`. */
  private mapLoopStmt(node: LoopStmt, ownerId: ElementId | null): void {
    const eClass = LOOP_ECLASS[node.kind] ?? 'ActionUsage';
    const attrs: Record<string, AttrValue> = { loopKind: node.kind };
    if (node.cond) attrs.condition = exprText(node.cond);
    if (node.coll) attrs.collection = exprText(node.coll);
    const loopVar = unquoteName(node.var);
    if (loopVar) attrs.loopVar = loopVar;
    if (node.varType) attrs.loopVarType = node.varType;
    if (node.succession) attrs.succession = node.succession;
    const el = this.create(eClass, { ownerId: ownerId ?? undefined, attrs });
    if (node.body) for (const m of node.body.members) this.mapMember(m, el.id);
  }

  /** `if c { … } (else { … })?` → an IfActionUsage with a guard condition. */
  private mapIfStmt(node: IfStmt, ownerId: ElementId | null): void {
    const attrs: Record<string, AttrValue> = { condition: exprText(node.cond) };
    if (node.target) attrs.thenTarget = node.target;
    if (node.elseTarget) attrs.elseTarget = node.elseTarget;
    if (node.elseBody) attrs.hasElse = true;
    if (node.succession) attrs.succession = node.succession;
    const el = this.create('IfActionUsage', { ownerId: ownerId ?? undefined, attrs });
    if (node.body) for (const m of node.body.members) this.mapMember(m, el.id);
    if (node.elseBody) for (const m of node.elseBody.members) this.mapMember(m, el.id);
  }

  /** accept / send / assign / perform / exhibit / include / terminate action. */
  private mapBehaviorStmt(node: BehaviorStmt, ownerId: ElementId | null): void {
    const eClass = BEHAVIOR_ECLASS[node.kind] ?? 'ActionUsage';
    const attrs: Record<string, AttrValue> = { actionKind: node.kind };
    if (node.via) attrs.via = node.via;
    if (node.target) attrs.actionTarget = node.target;
    if (node.succession) attrs.succession = node.succession;
    const el = this.create(eClass, {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      declaredShortName: unquoteName(node.shortName),
      attrs,
    });
    for (const spec of node.specializations) this.applySpecialization(el, spec);
    const mults = (node.multiplicity ?? []).map(formatMultiplicity);
    if (mults.length) this.model.setAttrs(el.id, { multiplicity: mults[mults.length - 1] });
    if (node.valueOp && node.value) {
      this.model.setAttrs(el.id, this.splitValueUnit(node.value));
      if (node.valueOp === ':=' || node.valueOp.endsWith(':=')) {
        this.model.setAttrs(el.id, { initialValue: true });
      }
    }
    if (node.body) for (const m of node.body.members) this.mapMember(m, el.id);
  }

  private mapConnect(node: Connect, ownerId: ElementId | null): void {
    const srcRef = node.source;
    const tgtRef = node.target;
    const el = this.create('ConnectionUsage', {
      ownerId: ownerId ?? undefined,
      source: [],
      target: [],
      attrs: {
        ...(srcRef ? { sourceRef: srcRef } : {}),
        ...(tgtRef ? { targetRef: tgtRef } : {}),
      },
    });
    this.deferEnds(el.id, srcRef, tgtRef, node, 'ref/unresolved-connection-end', (r) => `Unresolved connection end '${r}'`);
  }

  /**
   * Queue the "unresolved endpoint" warnings for a two-ended statement. They
   * fire only if the deferred pass leaves the ref in place.
   */
  private deferEnds(
    elementId: ElementId,
    srcRef: string | undefined,
    tgtRef: string | undefined,
    node: AstNode,
    code: string,
    message: (ref: string) => string,
    srcMessage?: (ref: string) => string,
  ): void {
    if (srcRef) this.defer(elementId, 'sourceRef', srcRef, (srcMessage ?? message)(srcRef), code, node);
    if (tgtRef) this.defer(elementId, 'targetRef', tgtRef, message(tgtRef), code, node);
  }

  private mapSatisfy(node: Satisfy, ownerId: ElementId | null): void {
    const reqRef = node.requirement;
    const satRef = node.satisfier;
    const el = this.create('Satisfy', {
      ownerId: ownerId ?? undefined,
      source: [],
      target: [],
      attrs: {
        ...(node.visibility ? { visibility: node.visibility } : {}),
        ...(reqRef ? { targetRef: reqRef } : {}),
        ...(satRef ? { sourceRef: satRef } : {}),
      },
    });
    this.deferEnds(
      el.id,
      satRef,
      reqRef,
      node,
      'ref/unresolved-requirement',
      (r) => `Unresolved requirement '${r}'`,
      (r) => `Unresolved satisfier '${r}'`,
    );
  }

  /**
   * `verify R by X;` / `refine R by X;` / `trace R to X;` / `derive R from X;`
   * — requirement cross-relationships mirroring {@link mapSatisfy}: the
   * REFERENCED ELEMENT is the `source` endpoint and the REQUIREMENT is the
   * `target` endpoint (uniform with Satisfy: satisfier=source,
   * requirement=target — see factory.satisfy / analytics.requirementSatisfaction).
   * Unresolved (e.g. forward) names fall back to the textual
   * `targetRef`/`sourceRef` attrs and are re-resolved by
   * {@link resolveDeferredRefs}, exactly like Satisfy.
   */
  private mapRequirementRelation(
    eClass: 'Verify' | 'Refine' | 'Trace' | 'Derive',
    reqRef: string | undefined,
    elemRef: string | undefined,
    node: AstNode,
    ownerId: ElementId | null,
    visibility?: string,
  ): void {
    const el = this.create(eClass, {
      ownerId: ownerId ?? undefined,
      source: [],
      target: [],
      attrs: {
        ...(visibility ? { visibility } : {}),
        ...(reqRef ? { targetRef: reqRef } : {}),
        ...(elemRef ? { sourceRef: elemRef } : {}),
      },
    });
    this.deferEnds(
      el.id,
      elemRef,
      reqRef,
      node,
      'ref/unresolved-requirement',
      (r) => `Unresolved requirement '${r}'`,
      (r) => `Unresolved ${eClass.toLowerCase()} element '${r}'`,
    );
  }

  private mapAllocate(node: Allocate, ownerId: ElementId | null): void {
    const srcRef = node.source;
    const tgtRef = node.target;
    // An unresolved end is KEPT as its textual ref. The legacy parser stored
    // nothing, so `allocate a to Missing;` lost the name outright and re-emitted
    // a half statement; the serializer's endpoint fallback reads it now.
    const el = this.create('Allocation', {
      ownerId: ownerId ?? undefined,
      source: [],
      target: [],
      attrs: {
        ...(srcRef ? { sourceRef: srcRef } : {}),
        ...(tgtRef ? { targetRef: tgtRef } : {}),
      },
    });
    this.deferEnds(
      el.id,
      srcRef,
      tgtRef,
      node,
      'ref/unresolved-allocation-end',
      (r) => `Unresolved allocation target '${r}'`,
      (r) => `Unresolved allocation source '${r}'`,
    );
  }

  /** Resolve a source/target pair and build an endpoint-bearing edge element. */
  private makeEdge(
    eClass: string,
    ownerId: ElementId | null,
    aRef: string | undefined,
    bRef: string | undefined,
    node: AstNode,
    attrs: Record<string, AttrValue> = {},
  ): ElementRecord {
    const el = this.create(eClass, {
      ownerId: ownerId ?? undefined,
      source: [],
      target: [],
      attrs: {
        ...attrs,
        ...(aRef ? { sourceRef: aRef } : {}),
        ...(bRef ? { targetRef: bRef } : {}),
      },
    });
    this.deferEnds(el.id, aRef, bRef, node, 'ref/unresolved-reference', (r) => `Unresolved reference '${r}'`);
    return el;
  }

  private mapTransition(node: Transition, ownerId: ElementId | null): void {
    let trigger: string | undefined;
    let guard: string | undefined;
    let effect: string | undefined;
    for (const c of node.clauses) {
      if (c.$type === 'AcceptClause') trigger = c.payload;
      else if (c.$type === 'GuardClause') guard = exprText(c.expr);
      else if (c.$type === 'EffectClause') effect = c.effect;
    }
    const srcRef = node.source;
    const tgtRef = node.target;
    const attrs: Record<string, AttrValue> = {};
    if (trigger) attrs.trigger = trigger;
    if (guard) attrs.guard = guard;
    if (effect) attrs.effect = effect;
    const el = this.create('TransitionUsage', {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      source: [],
      target: [],
      attrs: {
        ...attrs,
        ...(srcRef ? { sourceRef: srcRef } : {}),
        ...(tgtRef ? { targetRef: tgtRef } : {}),
      },
    });
    this.deferEnds(
      el.id,
      srcRef,
      tgtRef,
      node,
      'ref/unresolved-transition-end',
      (r) => `Unresolved transition target '${r}'`,
      (r) => `Unresolved transition source '${r}'`,
    );
  }

  /** `entry` / `do` / `exit` (name)? (= value)? — the value is kept like any behaviour statement's. */
  private mapStateBehavior(node: StateBehavior, ownerId: ElementId | null): void {
    const el = this.create('ActionUsage', {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      attrs: { stateSubaction: node.kind },
    });
    if (node.valueOp && node.value) {
      this.model.setAttrs(el.id, this.splitValueUnit(node.value));
      if (node.valueOp === ':=' || node.valueOp.endsWith(':=')) {
        this.model.setAttrs(el.id, { initialValue: true });
      }
    }
  }

  private mapControlNode(node: ControlNode, ownerId: ElementId | null): void {
    const eClass = CONTROL_NODE_ECLASS[node.kind] ?? node.kind;
    this.create(eClass, {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
    });
  }

  private mapRequirementClause(node: RequirementClause, ownerId: ElementId | null): void {
    if (node.kind === 'subject') {
      const el = this.create('ReferenceUsage', {
        ownerId: ownerId ?? undefined,
        declaredName: unquoteName(node.name),
        attrs: { requirementRole: 'subject' },
      });
      for (const spec of node.specializations) this.applySpecialization(el, spec);
      return;
    }
    // require / assume constraint
    const el = this.create('ConstraintUsage', {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      attrs: { requirementRole: node.kind },
    });
    for (const spec of node.specializations) this.applySpecialization(el, spec);
    if (node.expr) {
      // The expression is always written; `markUnparsedResidue` takes it back
      // if this turns out to be a swallowed unknown keyword it can re-home.
      this.model.setAttrs(el.id, { expression: exprText(node.expr) });
      this.noteResidueOfFault(node.expr, el.id);
    }
  }

  /* ─────────────────────── definitions / usages ────────────────────────── */

  private mapDefinition(node: Definition, ownerId: ElementId | null): void {
    const prefixes = node.prefixes ?? [];
    const direction = prefixes.find((p) => DIRECTIONS.has(p));
    // `in port out x` — two different directions on one feature. The first
    // used to win silently; the author needs to be told which one was kept.
    const directions = [...new Set(prefixes.filter((p) => DIRECTIONS.has(p)))];
    if (directions.length > 1) {
      const code = 'parse/conflicting-direction';
      this.diagnostics.push({
        message: `Conflicting directions ${directions.map((d) => `'${d}'`).join(' and ')}; '${direction}' was kept.`,
        ...posOf(node),
        severity: 'warning',
        source: 'mapper',
        code,
        found: directions[1],
        hint: renderHint(code, { found: directions[1] }),
        ...(rangeOf(node) ? { range: rangeOf(node) } : {}),
      });
    }
    const hasLibrary = prefixes.includes('library');
    const flags = prefixes.filter((p) => !DIRECTIONS.has(p) && p !== 'library');

    // Resolve the concrete metaclass.
    let eClass: string | undefined;
    if (node.keyword) {
      if (hasLibrary && node.keyword === 'package') {
        eClass = 'LibraryPackage';
      } else {
        eClass = KEYWORD_TO_ECLASS.get(node.keyword + (node.isDef ? 'def' : ''));
      }
    } else {
      // Keyword-less feature: `out fuelOut : Fuel;` (port) or `end p : T;` (ref).
      eClass = direction ? 'PortUsage' : 'ReferenceUsage';
    }
    if (!eClass) {
      // A keyword the GRAMMAR accepts but this tool models no metaclass for —
      // the KerML type/feature family (`namespace`, `class`, `feature`,
      // `step`, … 21 of them). This used to `return` here, which dropped the
      // declaration AND its whole body without a trace of the text. The
      // declaration is kept instead, carrying its own source: the serializer
      // re-emits that verbatim and nothing else, so a save can neither delete
      // the author's model nor pretend it was understood.
      const code = 'mapper/unsupported-keyword';
      this.diagnostics.push({
        message: `Unsupported keyword '${node.keyword}'`,
        ...posOf(node),
        severity: 'error',
        source: 'mapper',
        code,
        found: node.keyword,
        hint: renderHint(code, { found: node.keyword }),
        ...(rangeOf(node) ? { range: rangeOf(node) } : {}),
      });
      const verbatim = node.$cstNode?.text;
      this.create('ReferenceUsage', {
        ownerId: ownerId ?? undefined,
        declaredName: unquoteName(node.name),
        attrs: {
          keywordless: true,
          ...(verbatim ? { unparsedText: verbatim } : {}),
        },
      });
      return;
    }

    // A `flow (of payload)? from A to B` usage becomes a Flow relationship with
    // resolved endpoints (additive — only when the from/to clause is present).
    if (node.flowFrom !== undefined || node.flowTo !== undefined) {
      const flowAttrs: Record<string, AttrValue> = {};
      if (node.ofPayload) flowAttrs.payload = node.ofPayload;
      if (node.flowFrom) flowAttrs.sourceRef = node.flowFrom;
      if (node.flowTo) flowAttrs.targetRef = node.flowTo;
      const flow = this.create('Flow', {
        ownerId: ownerId ?? undefined,
        declaredName: unquoteName(node.name),
        source: [],
        target: [],
        attrs: flowAttrs,
      });
      this.deferEnds(
        flow.id,
        node.flowFrom,
        node.flowTo,
        node,
        'ref/unresolved-flow-end',
        (r) => `Unresolved flow target '${r}'`,
        (r) => `Unresolved flow source '${r}'`,
      );
      return;
    }

    // Assemble creation attrs (direction + modifier flags + reqId).
    const attrs: Record<string, AttrValue> = {};
    if (direction) attrs.direction = direction;
    for (const f of flags) attrs[`is${f[0].toUpperCase()}${f.slice(1)}`] = true;
    // Keyword-less provenance (F5 residual): a purely name-led feature such as
    // an enum literal (`low = 0.25;`) is a ReferenceUsage WITHOUT the `ref`
    // keyword; the serializer uses this marker to re-emit it keyword-less.
    // A `ref x :>> A;` declaration leads with the `ref` PREFIX (not a keyword),
    // so it keeps its keyword on re-emission.
    if (!node.keyword && prefixes.length === 0 && eClass === 'ReferenceUsage') {
      attrs.keywordless = true;
    }

    // Additive descriptors preserved on attrs (do not affect existing shapes:
    // each key is set only when the corresponding syntax is present).
    if (node.visibility) attrs.visibility = node.visibility;
    if (node.succession) attrs.succession = node.succession;
    if (node.via) attrs.via = node.via;
    if (node.ofPayload) attrs.ofPayload = node.ofPayload;
    if (node.sendTarget) attrs.sendTarget = node.sendTarget;
    if (node.modifiers && node.modifiers.length) attrs.modifiers = [...node.modifiers];
    if (node.prefixMeta && node.prefixMeta.length) {
      attrs.metadata = node.prefixMeta.map((p) => p.type);
    }
    if (node.ctrl) {
      attrs.loopKind = node.ctrl;
      if (node.ctrlCond) attrs.condition = exprText(node.ctrlCond);
      if (node.ctrlColl) attrs.collection = exprText(node.ctrlColl);
      if (node.ctrlVar) attrs.loopVar = unquoteName(node.ctrlVar) ?? node.ctrlVar;
      if (node.ctrlType) attrs.loopVarType = node.ctrlType;
    }

    const declaredShortName = unquoteName(node.shortName);
    const declaredName = unquoteName(node.name);

    const isRequirement = eClass === 'RequirementUsage' || eClass === 'RequirementDefinition';
    if (isRequirement && declaredShortName) attrs.reqId = declaredShortName;

    const el = this.create(eClass, {
      ownerId: ownerId ?? undefined,
      declaredName,
      declaredShortName,
      attrs,
    });

    // Specializations (resolved against the model built so far).
    for (const spec of node.specializations) this.applySpecialization(el, spec);

    // Multiplicity — a real `[m..n]` count range, declared BEFORE the value.
    // A unit on the value (`= 1500 [kg]`) is a bracket expression and lands in
    // `attrs.unit` through `splitValueUnit`, never in attrs.multiplicity (the
    // legacy parser conflated the two — finding D1/H11). The semantics layer
    // reads `attrs.unit` first, falling back to a unit-named attrs.multiplicity
    // for models saved by the old parser.
    const mults = (node.multiplicity ?? []).map(formatMultiplicity);
    if (mults.length) this.model.setAttrs(el.id, { multiplicity: mults[mults.length - 1] });

    // Feature value ( = / := ), with its unit split off.
    if (node.valueOp && node.value) {
      this.model.setAttrs(el.id, this.splitValueUnit(node.value));
      if (node.valueOp === ':=' || node.valueOp.endsWith(':=')) this.model.setAttrs(el.id, { initialValue: true });
    }

    // Inline `connection c connect A to B` / `interface i connect A to B`.
    if (node.connectSource !== undefined || node.connectTarget !== undefined) {
      const srcRef = node.connectSource;
      const tgtRef = node.connectTarget;
      const patch: Record<string, AttrValue> = {};
      if (srcRef) patch.sourceRef = srcRef;
      if (tgtRef) patch.targetRef = tgtRef;
      this.model.update(el.id, { source: [], target: [], attrs: patch });
      this.deferEnds(el.id, srcRef, tgtRef, node, 'ref/unresolved-connection-end', (r) => `Unresolved connection end '${r}'`);
    }

    // Body members (walked in document order → single-pass resolution).
    if (node.body) {
      for (const m of node.body.members) this.mapMember(m, el.id);
      // The trailing expression of a constraint/calculation body. It is always
      // written; if it turns out to be the residue of a faulted member the
      // `Body` rule swallowed, `markUnparsedResidue` moves it to that
      // declaration — but only once it has somewhere honest to put it.
      if (node.body.expr) {
        this.model.setAttrs(el.id, { expression: exprText(node.body.expr) });
        this.noteResidueOfFault(node.body.expr, el.id);
      }
    }
  }

  /**
   * A feature value with its unit split off, in the shape `attrs` stores:
   * `value` (number / boolean / verbatim expression text), `unit` when the
   * value's TOP node is a bracket expression, and `valueText` beside a number
   * whose written form `String(value)` would not reproduce.
   *
   * Only the outermost bracket is a unit annotation on the value: `18.5 [kg]`,
   * `(1 + 2) [m]`, `num#(1) [mRef.mRefs#(1)]`. A bracket deeper in the tree
   * (`229835/900 [K]`, `2 * 3 [kg]`) is part of the expression and stays in
   * its verbatim text, exactly as the notation reads it. A sign in front of the
   * bracket (`-5 [m]`, a UnaryExpr over the BracketExpr because the bracket
   * binds tighter) folds under the same bare-number guard as `mapValue`.
   */
  private splitValueUnit(
    expr: Expression,
  ): { value: string | number | boolean; unit?: string; valueText?: string } {
    if (expr.$type === 'BracketExpr') {
      const value = this.mapValue(expr.base);
      const unit = this.unitOf(expr);
      return { value, ...(unit ? { unit } : {}), ...valueTextFor(expr.base, value) };
    }
    if (
      expr.$type === 'UnaryExpr' &&
      (expr.op === '-' || expr.op === '+') &&
      expr.operand?.$type === 'BracketExpr' &&
      expr.operand.base.$type === 'NumberLiteral' &&
      /^[0-9]/.test(expr.operand.base.$cstNode?.text ?? '')
    ) {
      const magnitude = expr.operand.base.value;
      const value = expr.op === '-' ? -magnitude : magnitude;
      // The lexeme is the sign plus the base's own text (`-2.50`): the
      // UnaryExpr's text would carry the bracket. Kept under the same guard as
      // `valueTextFor` — only while it still denotes the number.
      const lexeme = expr.op + (expr.operand.base.$cstNode?.text ?? '').trim();
      const unit = this.unitOf(expr.operand);
      return {
        value,
        ...(unit ? { unit } : {}),
        valueText: lexeme !== String(value) && Number(lexeme) === value ? lexeme : undefined,
      };
    }
    const value = this.mapValue(expr);
    return { value, ...valueTextFor(expr, value) };
  }

  /**
   * The unit a bracket expression annotates its base with, as `attrs.unit`
   * spells it. A reference (`kg`, `SI::kg`, `'in'`, `SI::'watt hour'`) is
   * unquoted; any other operand (`m/s`, `W*h`, `mRef.mRefs#(1)`) is its source
   * text with whitespace removed, so `[m / s]` and `[m/s]` are one unit. When
   * the lexer skipped a character inside the bracket (`[m²]`), the AST has lost
   * it and the unit is the SOURCE slice between the brackets instead.
   *
   * Returns '' (no unit) when the bracket has no operand: `= 5 []`, `= 5 [;`,
   * `= 5 [initial]` are routine mid-edit states that the parser recovers from
   * with `arg` unset, and the parse error is the whole report — a mapper that
   * dereferenced the missing operand cost the agent the entire file as an
   * internal error instead of one positioned diagnostic.
   */
  private unitOf(bracket: BracketExpr): string {
    const cst = bracket.$cstNode;
    if (cst && this.lexerErrorOffsets.some((o) => o >= cst.offset && o < cst.end)) {
      const open = this.source.indexOf('[', bracket.base.$cstNode?.end ?? cst.offset);
      const close = cst.end - 1;
      if (open !== -1 && open < close && this.source[close] === ']') {
        const sliced = this.source.slice(open + 1, close).trim();
        if (sliced) return sliced;
      }
    }
    const arg = bracket.arg as Expression | undefined;
    if (!arg) return '';
    return unitTextOf(arg.$type === 'RefExpr' ? arg.ref : exprText(arg));
  }

  /** Map a single value expression to the legacy primitive-or-verbatim form. */
  private mapValue(expr: Expression): string | number | boolean {
    switch (expr.$type) {
      case 'NumberLiteral':
        return expr.value;
      case 'BracketExpr':
        // A bracket that is not the top of a feature value is part of the
        // expression (`2 * 3 [kg]`); it is kept as the notation reads it.
        return exprText(expr);
      case 'BoolLiteral':
        return expr.value === 'true';
      case 'StringLiteral':
        // The legacy parser kept the quotes so the value round-trips; the raw
        // CST text is exactly that quoted literal.
        return expr.$cstNode?.text ?? JSON.stringify(expr.value);
      case 'UnaryExpr':
        // The NUMBER terminal is unsigned and the sign is a unary operator, so
        // `-2.50` arrives here rather than as a NumberLiteral. It still denotes
        // a number, and the query engine and the export contract expect one.
        // Only a sign directly on a bare number folds: parentheses are
        // transparent in the AST, so `-(2)` also has a NumberLiteral operand,
        // and the digit-start test on the operand's own text is what keeps it
        // (and `-x`, `--2`, `not true`, `~x`) an expression string.
        // The operand is optional in practice: a dangling `= -;` is parsed
        // with recovery and reaches here with no operand, and must fall
        // through to the verbatim text like any other malformed value.
        if (
          (expr.op === '-' || expr.op === '+') &&
          expr.operand?.$type === 'NumberLiteral' &&
          /^[0-9]/.test(expr.operand.$cstNode?.text ?? '')
        ) {
          return expr.op === '-' ? -expr.operand.value : expr.operand.value;
        }
        return exprText(expr);
      default:
        return exprText(expr);
    }
  }

  /* ───────────────────────── specialization ────────────────────────────── */

  private applySpecialization(el: ElementRecord, spec: Specialization): void {
    const op = normalizeSpecOp(spec.op);
    if (spec.conjugated === true) this.model.setAttrs(el.id, { conjugated: true });
    // RECORD, do not resolve. What a name denotes depends on the finished
    // namespace — inherited members included — which does not exist until the
    // whole file has been mapped. `resolveDeferredRefs` decides, in declaration
    // order, once. (The scope is read there too, because error recovery may
    // still move this declaration.)
    for (const ref of spec.types) {
      this.deferredSpecs.push({ elementId: el.id, op, ref, node: spec });
    }
  }
}

/** One token's span as Chevrotain reports it (`endOffset` is INCLUSIVE). */
interface TokenSpan {
  startOffset: number;
  endOffset?: number;
  image?: string;
}

/**
 * What a faulted parse hands the recovery passes: the source, the offset of
 * the first fault (re-homing's gate), and the two token offsets of EVERY parser
 * error — where the residue text starts and where the parser stopped.
 */
interface Fault {
  text: string;
  offset: number;
  errors: ReadonlyArray<{ tokenOffset: number; previousToken?: TokenSpan }>;
}

/** One `:`/`:>`/`:>>`/`::>` written in the source, awaiting resolution. */
interface DeferredSpec {
  elementId: ElementId;
  /** Canonical operator: `:` | `:>` | `:>>` | `::>`. */
  op: string;
  /** The name as written. */
  ref: string;
  /** The declaration it was written in — for the diagnostic position. */
  node: AstNode;
  /** The relationship created for it, once bound (retargeted on re-decision). */
  relId?: ElementId;
  /** The element it currently denotes, once bound. */
  targetId?: ElementId;
}

/** A warning that is only emitted if its reference is still unresolved at the end. */
interface PendingWarning {
  elementId: ElementId;
  attr: string;
  ref: string;
  message: string;
  code: string;
  node: AstNode;
  /** Retract when the attr no longer holds THIS ref (vs. merely being empty). */
  retractOnRef: boolean;
  /**
   * Decide emission from what actually FAILED, rather than from `attrs[attr]`.
   *
   * The slot test is only sound when the slot is this warning's own. Several
   * endpoint names share ONE slot — a multi-endpoint `dependency a, missing to
   * b` keeps only `a` in `sourceRef`, and `part x : Gone1, Gone2;` overwrites
   * `typeRef` — so the slot test named the endpoint that RESOLVED and stayed
   * silent about the one that did not. Sites with a shared slot pass a
   * predicate that re-asks the real question about THIS name.
   */
  survives?: () => boolean;
}

/** Specialization-family relationship metaclass for a canonical operator. */
function relClassForOp(op: string, definitionOwner: boolean): string {
  if (op === ':') return 'FeatureTyping';
  if (op === ':>>') return 'Redefinition';
  if (op === '::>') return 'ReferenceSubsetting';
  return definitionOwner ? 'Subclassification' : 'Subsetting';
}

/** Normalize a SpecOp (operator or keyword spelling) to the canonical operator. */
function normalizeSpecOp(op: string): string {
  switch (op) {
    case 'specializes':
    case 'subsets':
      return ':>';
    case 'redefines':
      return ':>>';
    case 'references':
      return '::>';
    case 'definedby':
      return ':';
    default:
      return op; // already one of ':' ':>' ':>>' '::>'
  }
}

/* ───────────────────────────── public entry ─────────────────────────────── */

/**
 * Parse SysML v2 textual notation into a {@link Model} with diagnostics, using
 * the Langium grammar + this AST->Model mapper. Drop-in replacement for the
 * legacy `parseModel`: identical {@link ParseResult} contract.
 */
export function astToModel(text: string): ParseResult {
  const { ast, lexerErrors, parserErrors } = parseDocument(text);
  const mapper = new Mapper();
  mapper.source = text;
  mapper.lexerErrorOffsets = lexerErrors
    .map((e) => e.offset)
    .filter((o): o is number => typeof o === 'number');

  // Map Chevrotain lexer diagnostics. `offset`/`length` give an exact span.
  for (const e of lexerErrors) {
    const line = e.line ?? 1;
    const column = e.column ?? 1;
    const offset = e.offset ?? 0;
    const length = e.length ?? 1;
    const found = text.slice(offset, offset + length) || undefined;
    const code = /unterminated|unclosed/i.test(e.message)
      ? 'lexer/unterminated-string'
      : 'lexer/illegal-char';
    mapper.diagnostics.push({
      message: e.message,
      line,
      column,
      severity: 'error',
      source: 'lexer',
      code,
      ...(found ? { found } : {}),
      hint: renderHint(code, { found }),
      range: {
        start: { line, column, offset },
        end: { line, column: column + length, offset: offset + length },
      },
    });
  }

  // Map Chevrotain parser diagnostics. The exception CLASS carries what the
  // message only says in prose, so it becomes the stable `code`; `expected`
  // and `found` are recovered so an agent does not have to parse English.
  // An unterminated delimiter makes every later parse error an artefact of the
  // delimiter, so report the delimiter itself and suppress the cascade. Without
  // this the agent gets four messages about tokens inside its own prose and none
  // that mentions the comment it forgot to close.
  const unterminated = findUnterminatedDelimiter(text);
  if (unterminated) {
    const code =
      unterminated.kind === 'comment' ? 'lexer/unterminated-comment' : 'lexer/unterminated-string';
    mapper.diagnostics.length = 0;
    mapper.diagnostics.push({
      message:
        unterminated.kind === 'comment'
          ? 'Unterminated block comment: this /* is never closed.'
          : 'Unterminated string literal: this quote is never closed before the end of the line.',
      line: unterminated.line,
      column: unterminated.column,
      severity: 'error',
      source: 'lexer',
      code,
      found: unterminated.found,
      hint: renderHint(code, { found: unterminated.found }),
      range: {
        start: { line: unterminated.line, column: unterminated.column, offset: unterminated.offset },
        end: {
          line: unterminated.line,
          column: unterminated.column + unterminated.found.length,
          offset: unterminated.offset + unterminated.found.length,
        },
      },
    });
    mapper.run(ast.members ?? []);
    return {
      model: mapper.model,
      diagnostics: mapper.diagnostics,
      ranges: mapper.ranges,
      deferredSpecializationWarnings: mapper.deferredSpecializationWarnings,
    };
  }

  const eof = eofPos(text);
  // "Expecting end of file but found X" is only meaningful when the parse
  // OTHERWISE succeeded. After an earlier error the parser has already bailed
  // mid-declaration, so the leftover text is an artefact of that error, not an
  // independent one — reporting it sends the agent to fix a brace that is fine.
  const meaningfulParserErrors =
    parserErrors.length > 1
      ? parserErrors.filter((e) => e.name !== 'NotAllInputParsedException')
      : parserErrors;
  for (const e of meaningfulParserErrors.length > 0 ? meaningfulParserErrors : parserErrors) {
    const tok = e.token;
    const code = codeForParserError(e.name);
    const expected = expectedFromMessage(e.message);
    // Chevrotain's EOF token has an empty image and NaN positions; report the
    // end of the file rather than propagating NaN to the agent.
    const atEof =
      tok === undefined ||
      !Number.isFinite(tok.startLine ?? NaN) ||
      (tok.image ?? '') === '';
    const rawFound = tok?.image ?? foundFromMessage(e.message);
    const foundToken = atEof ? '<end of file>' : rawFound;
    // Chevrotain reports where parsing STOPPED, which for a misspelled or
    // misordered keyword is one token past the mistake. Refine using the
    // previous token so the diagnostic names what the agent actually wrote.
    const srcLines = text.split('\n');
    const refined = atEof
      ? undefined
      : refineParserError(
          code,
          rawFound,
          (e as { previousToken?: { image?: string } }).previousToken?.image,
          srcLines[(tok?.startLine ?? 1) - 1],
          {
            ...(tokenTypeName(tok) ? { found: tokenTypeName(tok) } : {}),
            ...(tokenTypeName((e as { previousToken?: unknown }).previousToken)
              ? { previous: tokenTypeName((e as { previousToken?: unknown }).previousToken) }
              : {}),
          },
        );
    const found = refined?.found ?? foundToken;
    const line = atEof ? eof.line : (tok?.startLine ?? 1);
    const column = atEof ? eof.column : (tok?.startColumn ?? 1);
    const offset = atEof ? eof.offset : (tok?.startOffset ?? 0);
    mapper.diagnostics.push({
      message: e.message,
      line,
      column,
      severity: 'error',
      source: 'parser',
      code: refined?.code ?? code,
      ...(expected.length > 0 ? { expected } : {}),
      ...(found ? { found } : {}),
      hint: renderHint(refined?.code ?? code, { found, expected }),
      range: {
        start: { line, column, offset },
        end: atEof
          ? { line, column, offset }
          : {
              line: Number.isFinite(tok?.endLine ?? NaN) ? (tok?.endLine as number) : line,
              // Chevrotain end positions are INCLUSIVE; the contract's are exclusive.
              column: (Number.isFinite(tok?.endColumn ?? NaN) ? (tok?.endColumn as number) : column) + 1,
              offset: (Number.isFinite(tok?.endOffset ?? NaN) ? (tok?.endOffset as number) : offset) + 1,
            },
      },
    });
  }

  // Recovery may have parsed declarations after the first fault one scope
  // out; the mapper re-homes them from the brace structure before resolving.
  const firstFault = parserErrors
    .map((e) => e.token?.startOffset)
    .filter((o): o is number => typeof o === 'number' && Number.isFinite(o))
    .sort((a, b) => a - b)[0];
  // Each error's own token pair travels with it: `previousToken` is where the
  // faulty declaration's text begins (the parser stops one token PAST the
  // mistake), which is the only handle on the text recovery skipped —
  // `resyncedTokens` is always empty.
  const faultErrors = parserErrors
    .map((e) => ({
      tokenOffset: e.token?.startOffset,
      previousToken: (e as { previousToken?: TokenSpan }).previousToken,
    }))
    .filter(
      (e): e is { tokenOffset: number; previousToken: TokenSpan | undefined } =>
        typeof e.tokenOffset === 'number' && Number.isFinite(e.tokenOffset),
    );
  mapper.run(
    ast.members ?? [],
    firstFault === undefined ? undefined : { text, offset: firstFault, errors: faultErrors },
  );
  return {
    model: mapper.model,
    diagnostics: mapper.diagnostics,
    ranges: mapper.ranges,
    deferredSpecializationWarnings: mapper.deferredSpecializationWarnings,
  };
}


/**
 * Drop "Unresolved reference" warnings whose reference the LIBRARY BINDER has
 * since resolved.
 *
 * Call after `resolveTypeReferences`. A warning is retracted only when the
 * attribute that held the unresolved name is gone — i.e. the binder actually
 * bound it — so a genuinely unresolvable name keeps its warning. Mutates and
 * returns `diagnostics`' filtered copy; the parse result itself is untouched.
 */
export function retractResolvedSpecializationWarnings(
  model: Model,
  result: ParseResult,
): ParseDiagnostic[] {
  const stale = new Set<ParseDiagnostic>();
  for (const w of result.deferredSpecializationWarnings) {
    const el = model.get(w.elementId);
    if (!el) continue;
    const v = el.attrs[w.attr];
    // Still unresolved while the attribute holds the name. An ARRAY attribute
    // (`specializes`) holds several, so "the attribute is gone" would keep
    // three warnings alive because one of the three names is still broken.
    const held =
      v !== undefined &&
      (w.ref === undefined
        ? true
        : Array.isArray(v)
          ? v.includes(w.ref)
          : typeof v === 'string'
            ? v === w.ref
            : true);
    if (!held) stale.add(w.diagnostic);
  }
  return stale.size === 0 ? result.diagnostics : result.diagnostics.filter((d) => !stale.has(d));
}
