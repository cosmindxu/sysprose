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
  isSpecialization,
  TEXTUAL_KEYWORD,
  type ElementId,
  type ElementRecord,
  type AttrValue,
} from '@core/index';
import type { AstNode } from 'langium';
import type { ParseResult, ParseDiagnostic } from '../types';
import { parseDocument } from './module';
import type {
  Alias,
  Allocate,
  Annotation,
  BehaviorStmt,
  Bind,
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

/** Strip a single-quoted unrestricted name's surrounding quotes + unescape. */
function unquoteName(s: string | undefined): string | undefined {
  if (s == null) return s;
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return s;
}

/**
 * Split a qualified name on `::` / `.` separators that lie OUTSIDE single quotes,
 * so a quoted segment containing a dot or `::` (`'a.b'::c`) is not shattered
 * (finding F7). Each returned segment is still quoted; the caller unquotes it.
 */
function splitQualified(ref: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < ref.length; i++) {
    const c = ref[i];
    if (inQuote) {
      cur += c;
      if (c === '\\' && i + 1 < ref.length) cur += ref[++i]; // keep escaped char verbatim
      else if (c === "'") inQuote = false;
    } else if (c === "'") {
      inQuote = true;
      cur += c;
    } else if (c === ':' && ref[i + 1] === ':') {
      segs.push(cur);
      cur = '';
      i++; // consume the second ':'
    } else if (c === '.') {
      segs.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  segs.push(cur);
  return segs;
}

/** Inner text of an `ML_COMMENT` token (`/* … *\/`), trimmed like the lexer. */
function stripBlockComment(raw: string): string {
  let s = raw;
  if (s.startsWith('/*')) s = s.slice(2);
  if (s.endsWith('*/')) s = s.slice(0, -2);
  return s.trim();
}

/** 1-based line/column of an AST node (falls back to 1,1). */
function posOf(node: AstNode | undefined): { line: number; column: number } {
  const start = node?.$cstNode?.range?.start;
  if (!start) return { line: 1, column: 1 };
  return { line: (start.line ?? 0) + 1, column: (start.character ?? 0) + 1 };
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

/* ───────────────────────── shared name resolution ───────────────────────── */

/** Split a (possibly quoted) qualified/dotted ref into clean name segments. */
function refSegments(ref: string): string[] {
  return splitQualified(ref)
    .map((s) => unquoteName(s.trim()) ?? '')
    .filter(Boolean);
}

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

/** Scope-walk + containment-descent resolution (the legacy resolver). */
function resolveRefIn(
  model: Model,
  ref: string,
  scopeOwnerId: ElementId | null,
): ElementRecord | undefined {
  const segs = refSegments(ref);
  if (segs.length === 0) return undefined;
  for (const s of scopeChain(model, scopeOwnerId)) {
    const m = descendMatchIn(model, segs, s);
    if (m) return m;
  }
  return model.resolveQualifiedName(segs.join('::'));
}

function descendMatchIn(
  model: Model,
  segs: string[],
  scope: ElementId | null,
): ElementRecord | undefined {
  let candidates = scope === null ? model.roots() : model.children(scope);
  let found: ElementRecord | undefined;
  for (const seg of segs) {
    found = candidates.find((e) => nameMatches(e, seg));
    if (!found) return undefined;
    candidates = model.children(found.id);
  }
  return found;
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
      const t = resolveRefIn(model, typeRef, cur.ownerId);
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

  // Candidate anchors for the first segment: containment hits (innermost scope
  // first — the pre-existing resolution priority), then features inherited
  // through an enclosing usage's type (innermost first).
  const [head, ...rest] = segs;
  const tryAnchor = (anchor: ElementRecord): ElementRecord | undefined => {
    if (!walkChain(model, anchor, rest, false)) return undefined; // dry run
    return walkChain(model, anchor, rest, true);
  };

  for (const s of scopes) {
    const kids = s === null ? model.roots() : model.children(s);
    const hit = kids.find((e) => nameMatches(e, head));
    if (hit) {
      const end = tryAnchor(hit);
      if (end) return end;
    }
  }
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

  private warn(message: string, node?: AstNode): ParseDiagnostic {
    const { line, column } = posOf(node);
    const diag: ParseDiagnostic = { message, line, column, severity: 'warning' };
    this.diagnostics.push(diag);
    return diag;
  }

  /**
   * Connector-endpoint "Unresolved connection end" warnings are emitted at map
   * time, BEFORE {@link resolveDeferredRefs} runs the feature-chain pass. Each is
   * registered here so that, once the deferred pass has (possibly) resolved the
   * endpoint, a now-stale warning can be retracted — otherwise the flagship
   * `connect a.p to b.p` syntax would emit a permanent FALSE warning for every
   * `parseModel` consumer.
   */
  private readonly endpointWarnings: Array<{
    diag: ParseDiagnostic;
    elId: ElementId;
    which: 'sourceRef' | 'targetRef';
  }> = [];

  private registerEndpointWarning(
    diag: ParseDiagnostic,
    elId: ElementId,
    which: 'sourceRef' | 'targetRef',
  ): void {
    this.endpointWarnings.push({ diag, elId, which });
  }

  /** Drop endpoint warnings whose ref was resolved (cleared) by the deferred pass. */
  private retractResolvedEndpointWarnings(): void {
    const stale = new Set<ParseDiagnostic>();
    for (const w of this.endpointWarnings) {
      const el = this.model.get(w.elId);
      if (el && el.attrs[w.which] === undefined) stale.add(w.diag);
    }
    if (stale.size === 0) return;
    for (let i = this.diagnostics.length - 1; i >= 0; i--) {
      if (stale.has(this.diagnostics[i])) this.diagnostics.splice(i, 1);
    }
  }

  /* ─────────────────── name resolution (mirrors legacy) ─────────────────── */

  private resolveRef(ref: string, scopeOwnerId: ElementId | null): ElementRecord | undefined {
    return resolveRefIn(this.model, ref, scopeOwnerId);
  }

  /* ────────────────────────────── entry ────────────────────────────────── */

  run(members: Member[]): void {
    this.model.transaction(() => {
      for (const m of members) this.mapMember(m, null);
      this.resolveDeferredRefs();
      this.retractResolvedEndpointWarnings();
    });
  }

  /**
   * Second resolution pass (finding F4): re-resolve references that missed
   * during the single forward-order build because their target was declared
   * LATER, or in a sibling scope. Runs once at the end of {@link run}, inside the
   * same transaction, over a snapshot of the fully-built model.
   *
   * `resolveRef` is a pure read of model state, so "resolvable now" is exactly
   * "was a forward / cross-scope reference": a name that still exists is
   * upgraded; a typo / genuinely-absent name is left as its textual fallback (and
   * its build-time warning). It deliberately handles ONLY the endpoint
   * (`sourceRef`/`targetRef`), `aliasFor` and node-level specialization-array
   * refs — NEVER `typeRef` / `attrs.type`, which are the separate, library-aware
   * responsibility of `resolveTypeReferences` (so `part x : Q::Later` stays a
   * `typeRef` at parse time, per that pass's contract). One sweep reaches a
   * fixpoint: upgrading a ref only sets endpoints or creates anonymous
   * relationship elements — never a new NAMED, resolvable target — so nothing
   * becomes newly resolvable as a side effect.
   */
  private resolveDeferredRefs(): void {
    const worklist = this.model.all(); // snapshot: relationships made below aren't revisited
    for (const el of worklist) {
      // Capture the ORIGINAL lexical scope once — the reparent below mutates
      // el.ownerId, and every ref in this statement must resolve against the
      // scope it was written in, not a re-homed owner.
      const scope = el.ownerId;
      const spec = isSpecialization(el.eClass);

      // Multi-endpoint Dependency: rebuild source/target from the clients/
      // suppliers name lists (the single sourceRef/targetRef holds only the first
      // unresolved endpoint, so it is lossy for these).
      if (el.eClass === 'Dependency') {
        this.upgradeDependency(el, scope);
        continue;
      }

      // Endpoint source. For a specialization relationship owned by its source
      // (mapRelationshipStmt), re-home it onto the resolved source so the
      // serializer's specializationFragments can emit it.
      const sref = el.attrs.sourceRef;
      let sourceResolved = (el.source?.length ?? 0) > 0;
      if (typeof sref === 'string' && !sourceResolved) {
        const r = this.resolveRef(sref, scope);
        if (r && r.id !== el.id) {
          this.model.update(el.id, { source: [r.id] });
          this.model.setAttrs(el.id, { sourceRef: undefined });
          sourceResolved = true;
          // A `:>`-family relationship built while its source name was still
          // forward defaulted to Subsetting (mapRelationshipStmt). Now that the
          // source is known, upgrade to Subclassification when it is a
          // definition — matching what the inline `part def A :> B;` form and
          // a re-parse of the serialized text produce.
          if (el.eClass === 'Subsetting' && isDefinition(r.eClass)) {
            this.model.update(el.id, { eClass: 'Subclassification' });
          }
          if (spec && el.ownerId !== r.id) this.model.reparent(el.id, r.id);
        }
      }
      // Endpoint target. A specialization relationship whose source is still
      // dangling must NOT get a resolved target — a half-relationship would be
      // mis-inlined onto its (wrong) owner.
      const tref = el.attrs.targetRef;
      if (typeof tref === 'string' && (el.target?.length ?? 0) === 0 && (!spec || sourceResolved)) {
        const r = this.resolveRef(tref, scope);
        if (r && r.id !== el.id) {
          this.model.update(el.id, { target: [r.id] });
          this.model.setAttrs(el.id, { targetRef: undefined });
        }
      }
      // Connector endpoint that is a FEATURE CHAIN through a type (`a.p` where
      // `p` is declared on the type of `a`, or a bare `p` on the type of an
      // enclosing usage): materialize an implicit usage-scoped feature and bind
      // the endpoint to THAT — never to the shared type-owned feature (which
      // would collapse same-type connectors into self-edges and re-home edges
      // onto the definition). Runs only when the plain resolver above failed.
      if (CHAIN_CONNECTOR_CLASSES.has(el.eClass)) resolveChainEndpointsOf(this.model, el);

      // Alias (`alias N for Target`) whose target was forward.
      if (el.eClass === 'Membership' && typeof el.attrs.aliasFor === 'string' && (el.target?.length ?? 0) === 0) {
        const r = this.resolveRef(el.attrs.aliasFor, scope);
        if (r && r.id !== el.id) {
          this.model.update(el.id, { target: [r.id] });
          this.model.setAttrs(el.id, { aliasFor: undefined });
        }
      }
      // Node-level specialization arrays (`:> b` / `:>> b` / `::> b` on a feature
      // whose target was forward) — materialize a relationship per now-resolvable
      // ref, mirroring applySpecialization. Never typeRef/type.
      for (const [key, op] of SPEC_ARRAY_KEYS) {
        const arr = el.attrs[key];
        if (!Array.isArray(arr)) continue;
        const leftover: string[] = [];
        for (const ref of arr) {
          const r = typeof ref === 'string' ? this.resolveRef(ref, scope) : undefined;
          if (r && r.id !== el.id) {
            this.model.create(relClassForOp(op, isDefinition(el.eClass)), {
              ownerId: el.id,
              source: [el.id],
              target: [r.id],
            });
          } else if (typeof ref === 'string') {
            leftover.push(ref);
          }
        }
        this.model.setAttrs(el.id, { [key]: leftover.length ? leftover : undefined });
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
    switch (node.$type) {
      case 'Doc':
        return this.mapDoc(node as Doc, ownerId);
      case 'Comment':
        this.model.create('Comment', {
          ownerId: ownerId ?? undefined,
          attrs: { body: stripBlockComment((node as CommentNode).body) },
        });
        return;
      case 'TextualRep': {
        // A free-standing `/* … */` block comment, or a `rep`/`language` textual
        // representation. Captured as a TextualRepresentation element so it
        // survives round-trip (the serializer re-emits it); previously dropped
        // (finding L2). Body text is stripped of its `/* */` delimiters.
        const tr = node as TextualRepNode;
        const trAttrs: Record<string, AttrValue> = { body: stripBlockComment(tr.body) };
        if (tr.language) trAttrs.language = tr.language;
        this.model.create('TextualRepresentation', {
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
        if (ft.source && ft.target) this.makeEdge('Succession', ownerId, ft.source, ft.target, node);
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
      this.model.create('Documentation', {
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
    this.model.create(wildcard ? 'NamespaceImport' : 'MembershipImport', {
      ownerId: ownerId ?? undefined,
      attrs,
    });
  }

  /** `@Type { … }` metadata annotation → a MetadataUsage carrying the type. */
  private mapAnnotation(node: Annotation, ownerId: ElementId | null): void {
    const attrs: Record<string, AttrValue> = { annotation: true, type: node.type };
    if (node.about && node.about.length) attrs.about = [...node.about];
    const el = this.model.create('MetadataUsage', {
      ownerId: ownerId ?? undefined,
      attrs,
    });
    if (node.body) for (const m of node.body.members) this.mapMember(m, el.id);
  }

  /** `alias N for Target` → a named Membership pointing at the resolved target. */
  private mapAlias(node: Alias, ownerId: ElementId | null): void {
    const targetRef = node.target;
    const target = targetRef ? this.resolveRef(targetRef, ownerId) : undefined;
    if (targetRef && !target) this.warn(`Unresolved alias target '${targetRef}'`, node);
    const attrs: Record<string, AttrValue> = {};
    if (node.visibility) attrs.visibility = node.visibility;
    if (targetRef && !target) attrs.aliasFor = targetRef;
    const el = this.model.create('Membership', {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      declaredShortName: unquoteName(node.shortName),
      target: target ? [target.id] : [],
      attrs,
    });
    // F-follow-up: `alias b for a { … }` body members were silently dropped.
    if (node.body) for (const m of node.body.members) this.mapMember(m, el.id);
  }

  /** `dependency (id from)? clients… to suppliers…` → a Dependency relationship. */
  private mapDependency(node: Dependency, ownerId: ElementId | null): void {
    const srcIds: ElementId[] = [];
    const tgtIds: ElementId[] = [];
    const unresolvedSrc: string[] = [];
    const unresolvedTgt: string[] = [];
    for (const c of node.client) {
      const r = this.resolveRef(c, ownerId);
      if (r) srcIds.push(r.id);
      else {
        unresolvedSrc.push(c);
        this.warn(`Unresolved dependency client '${c}'`, node);
      }
    }
    for (const s of node.supplier) {
      const r = this.resolveRef(s, ownerId);
      if (r) tgtIds.push(r.id);
      else {
        unresolvedTgt.push(s);
        this.warn(`Unresolved dependency supplier '${s}'`, node);
      }
    }
    const attrs: Record<string, AttrValue> = {};
    if (unresolvedSrc.length) attrs.sourceRef = unresolvedSrc[0];
    if (unresolvedTgt.length) attrs.targetRef = unresolvedTgt[0];
    if (node.client.length > 1) attrs.clients = [...node.client];
    if (node.supplier.length > 1) attrs.suppliers = [...node.supplier];
    this.model.create('Dependency', {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      declaredShortName: unquoteName(node.shortName),
      source: srcIds,
      target: tgtIds,
      attrs,
    });
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
    const src = srcRef ? this.resolveRef(srcRef, ownerId) : undefined;
    if (srcRef && !src) this.warn(`Unresolved relationship source '${srcRef}'`, node);
    const owner = src ? src.id : ownerId;

    if (node.kind === 'disjoint') {
      const tgtRef = node.target;
      const tgt = tgtRef ? this.resolveRef(tgtRef, ownerId) : undefined;
      if (tgtRef && !tgt) this.warn(`Unresolved disjoint target '${tgtRef}'`, node);
      this.model.create('Disjoining', {
        ownerId: owner ?? undefined,
        source: src ? [src.id] : [],
        target: tgt ? [tgt.id] : [],
        attrs: {
          ...(srcRef && !src ? { sourceRef: srcRef } : {}),
          ...(tgtRef && !tgt ? { targetRef: tgtRef } : {}),
        },
      });
      return;
    }

    for (const spec of node.specializations) {
      const op = normalizeSpecOp(spec.op);
      for (const tgtRef of spec.types) {
        const tgt = this.resolveRef(tgtRef, ownerId);
        if (!tgt) this.warn(`Unresolved reference '${tgtRef}'`, spec);
        // Classify by the RESOLVED source's kind — `subtype A specializes B;`
        // on a definition must build a Subclassification, exactly like the
        // inline `part def A :> B;` form does, or the element class flips
        // across a serialize→parse round-trip (C9-residual sweep). An
        // unresolved source defaults to Subsetting and is upgraded by
        // resolveDeferredRefs once the source name resolves.
        const relClass = relClassForOp(op, src ? isDefinition(src.eClass) : false);
        this.model.create(relClass, {
          ownerId: owner ?? undefined,
          source: src ? [src.id] : [],
          target: tgt ? [tgt.id] : [],
          attrs: {
            ...(srcRef && !src ? { sourceRef: srcRef } : {}),
            ...(tgt ? {} : { targetRef: tgtRef }),
          },
        });
      }
    }
  }

  /** `return (ref)? name (: T)? (= expr)?` → a result ReferenceUsage feature. */
  private mapReturnStmt(node: ReturnStmt, ownerId: ElementId | null): void {
    const el = this.model.create('ReferenceUsage', {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      attrs: { featureRole: 'return' },
    });
    for (const spec of node.specializations) this.applySpecialization(el, spec, ownerId);
    const mults = (node.multiplicity ?? []).map(formatMultiplicity);
    if (mults.length) this.model.setAttrs(el.id, { multiplicity: mults[mults.length - 1] });
    if (node.valueOp && node.value) {
      const value = this.mapValue(node.value);
      if (value !== undefined) this.model.setAttrs(el.id, { value });
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
    const el = this.model.create(eClass, { ownerId: ownerId ?? undefined, attrs });
    if (node.body) for (const m of node.body.members) this.mapMember(m, el.id);
  }

  /** `if c { … } (else { … })?` → an IfActionUsage with a guard condition. */
  private mapIfStmt(node: IfStmt, ownerId: ElementId | null): void {
    const attrs: Record<string, AttrValue> = { condition: exprText(node.cond) };
    if (node.target) attrs.thenTarget = node.target;
    if (node.elseTarget) attrs.elseTarget = node.elseTarget;
    if (node.elseBody) attrs.hasElse = true;
    if (node.succession) attrs.succession = node.succession;
    const el = this.model.create('IfActionUsage', { ownerId: ownerId ?? undefined, attrs });
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
    const el = this.model.create(eClass, {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      declaredShortName: unquoteName(node.shortName),
      attrs,
    });
    for (const spec of node.specializations) this.applySpecialization(el, spec, ownerId);
    const mults = (node.multiplicity ?? []).map(formatMultiplicity);
    if (mults.length) this.model.setAttrs(el.id, { multiplicity: mults[mults.length - 1] });
    if (node.valueOp && node.value) {
      const value = this.mapValue(node.value);
      if (value !== undefined) this.model.setAttrs(el.id, { value });
      if (node.valueOp === ':=' || node.valueOp.endsWith(':=')) {
        this.model.setAttrs(el.id, { initialValue: true });
      }
    }
    if (node.body) for (const m of node.body.members) this.mapMember(m, el.id);
  }

  private mapConnect(node: Connect, ownerId: ElementId | null): void {
    const srcRef = node.source;
    const tgtRef = node.target;
    const src = srcRef ? this.resolveRef(srcRef, ownerId) : undefined;
    const tgt = tgtRef ? this.resolveRef(tgtRef, ownerId) : undefined;
    const srcWarn = srcRef && !src ? this.warn(`Unresolved connection end '${srcRef}'`, node) : undefined;
    const tgtWarn = tgtRef && !tgt ? this.warn(`Unresolved connection end '${tgtRef}'`, node) : undefined;
    const el = this.model.create('ConnectionUsage', {
      ownerId: ownerId ?? undefined,
      source: src ? [src.id] : [],
      target: tgt ? [tgt.id] : [],
      attrs: {
        ...(srcRef && !src ? { sourceRef: srcRef } : {}),
        ...(tgtRef && !tgt ? { targetRef: tgtRef } : {}),
      },
    });
    if (srcWarn) this.registerEndpointWarning(srcWarn, el.id, 'sourceRef');
    if (tgtWarn) this.registerEndpointWarning(tgtWarn, el.id, 'targetRef');
  }

  private mapSatisfy(node: Satisfy, ownerId: ElementId | null): void {
    const reqRef = node.requirement;
    const satRef = node.satisfier;
    const req = reqRef ? this.resolveRef(reqRef, ownerId) : undefined;
    const sat = satRef ? this.resolveRef(satRef, ownerId) : undefined;
    // Capture the warnings so resolveDeferredRefs can RETRACT them once a
    // forward reference resolves (mirrors mapConnect) — otherwise a
    // `satisfy R by X;` before `R`/`X` leaves a permanent false warning.
    const reqWarn = reqRef && !req ? this.warn(`Unresolved requirement '${reqRef}'`, node) : undefined;
    const satWarn = satRef && !sat ? this.warn(`Unresolved satisfier '${satRef}'`, node) : undefined;
    const el = this.model.create('Satisfy', {
      ownerId: ownerId ?? undefined,
      source: sat ? [sat.id] : [],
      target: req ? [req.id] : [],
      attrs: {
        ...(node.visibility ? { visibility: node.visibility } : {}),
        ...(reqRef && !req ? { targetRef: reqRef } : {}),
        ...(satRef && !sat ? { sourceRef: satRef } : {}),
      },
    });
    if (reqWarn) this.registerEndpointWarning(reqWarn, el.id, 'targetRef');
    if (satWarn) this.registerEndpointWarning(satWarn, el.id, 'sourceRef');
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
    const req = reqRef ? this.resolveRef(reqRef, ownerId) : undefined;
    const elem = elemRef ? this.resolveRef(elemRef, ownerId) : undefined;
    // Retractable warnings (mirrors mapConnect) so a forward-referenced
    // `verify R by X;` before `R`/`X` does not leave a permanent false warning
    // once resolveDeferredRefs resolves the endpoints.
    const reqWarn = reqRef && !req ? this.warn(`Unresolved requirement '${reqRef}'`, node) : undefined;
    const elemWarn =
      elemRef && !elem
        ? this.warn(`Unresolved ${eClass.toLowerCase()} element '${elemRef}'`, node)
        : undefined;
    const el = this.model.create(eClass, {
      ownerId: ownerId ?? undefined,
      source: elem ? [elem.id] : [],
      target: req ? [req.id] : [],
      attrs: {
        ...(visibility ? { visibility } : {}),
        ...(reqRef && !req ? { targetRef: reqRef } : {}),
        ...(elemRef && !elem ? { sourceRef: elemRef } : {}),
      },
    });
    if (reqWarn) this.registerEndpointWarning(reqWarn, el.id, 'targetRef');
    if (elemWarn) this.registerEndpointWarning(elemWarn, el.id, 'sourceRef');
  }

  private mapAllocate(node: Allocate, ownerId: ElementId | null): void {
    const srcRef = node.source;
    const tgtRef = node.target;
    const src = srcRef ? this.resolveRef(srcRef, ownerId) : undefined;
    const tgt = tgtRef ? this.resolveRef(tgtRef, ownerId) : undefined;
    if (srcRef && !src) this.warn(`Unresolved allocation source '${srcRef}'`, node);
    if (tgtRef && !tgt) this.warn(`Unresolved allocation target '${tgtRef}'`, node);
    // NB: the legacy parser stores NO textual ref attrs on Allocation.
    this.model.create('Allocation', {
      ownerId: ownerId ?? undefined,
      source: src ? [src.id] : [],
      target: tgt ? [tgt.id] : [],
    });
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
    const a = aRef ? this.resolveRef(aRef, ownerId) : undefined;
    const b = bRef ? this.resolveRef(bRef, ownerId) : undefined;
    if (aRef && !a) this.warn(`Unresolved reference '${aRef}'`, node);
    if (bRef && !b) this.warn(`Unresolved reference '${bRef}'`, node);
    return this.model.create(eClass, {
      ownerId: ownerId ?? undefined,
      source: a ? [a.id] : [],
      target: b ? [b.id] : [],
      attrs: {
        ...attrs,
        ...(aRef && !a ? { sourceRef: aRef } : {}),
        ...(bRef && !b ? { targetRef: bRef } : {}),
      },
    });
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
    const src = srcRef ? this.resolveRef(srcRef, ownerId) : undefined;
    const tgt = tgtRef ? this.resolveRef(tgtRef, ownerId) : undefined;
    if (srcRef && !src) this.warn(`Unresolved transition source '${srcRef}'`, node);
    if (tgtRef && !tgt) this.warn(`Unresolved transition target '${tgtRef}'`, node);
    const attrs: Record<string, AttrValue> = {};
    if (trigger) attrs.trigger = trigger;
    if (guard) attrs.guard = guard;
    if (effect) attrs.effect = effect;
    this.model.create('TransitionUsage', {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      source: src ? [src.id] : [],
      target: tgt ? [tgt.id] : [],
      attrs: {
        ...attrs,
        ...(srcRef && !src ? { sourceRef: srcRef } : {}),
        ...(tgtRef && !tgt ? { targetRef: tgtRef } : {}),
      },
    });
  }

  private mapStateBehavior(node: StateBehavior, ownerId: ElementId | null): void {
    this.model.create('ActionUsage', {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      attrs: { stateSubaction: node.kind },
    });
  }

  private mapControlNode(node: ControlNode, ownerId: ElementId | null): void {
    const eClass = CONTROL_NODE_ECLASS[node.kind] ?? node.kind;
    this.model.create(eClass, {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
    });
  }

  private mapRequirementClause(node: RequirementClause, ownerId: ElementId | null): void {
    if (node.kind === 'subject') {
      const el = this.model.create('ReferenceUsage', {
        ownerId: ownerId ?? undefined,
        declaredName: unquoteName(node.name),
        attrs: { requirementRole: 'subject' },
      });
      for (const spec of node.specializations) this.applySpecialization(el, spec, ownerId);
      return;
    }
    // require / assume constraint
    const el = this.model.create('ConstraintUsage', {
      ownerId: ownerId ?? undefined,
      declaredName: unquoteName(node.name),
      attrs: { requirementRole: node.kind },
    });
    for (const spec of node.specializations) this.applySpecialization(el, spec, ownerId);
    if (node.expr) this.model.setAttrs(el.id, { expression: exprText(node.expr) });
  }

  /* ─────────────────────── definitions / usages ────────────────────────── */

  private mapDefinition(node: Definition, ownerId: ElementId | null): void {
    const prefixes = node.prefixes ?? [];
    const direction = prefixes.find((p) => DIRECTIONS.has(p));
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
      this.diagnostics.push({
        message: `Unknown keyword '${node.keyword}'`,
        ...posOf(node),
        severity: 'error',
      });
      return;
    }

    // A `flow (of payload)? from A to B` usage becomes a Flow relationship with
    // resolved endpoints (additive — only when the from/to clause is present).
    if (node.flowFrom !== undefined || node.flowTo !== undefined) {
      const flowAttrs: Record<string, AttrValue> = {};
      if (node.ofPayload) flowAttrs.payload = node.ofPayload;
      const src = node.flowFrom ? this.resolveRef(node.flowFrom, ownerId) : undefined;
      const tgt = node.flowTo ? this.resolveRef(node.flowTo, ownerId) : undefined;
      if (node.flowFrom && !src) this.warn(`Unresolved flow source '${node.flowFrom}'`, node);
      if (node.flowTo && !tgt) this.warn(`Unresolved flow target '${node.flowTo}'`, node);
      if (node.flowFrom && !src) flowAttrs.sourceRef = node.flowFrom;
      if (node.flowTo && !tgt) flowAttrs.targetRef = node.flowTo;
      this.model.create('Flow', {
        ownerId: ownerId ?? undefined,
        declaredName: unquoteName(node.name),
        source: src ? [src.id] : [],
        target: tgt ? [tgt.id] : [],
        attrs: flowAttrs,
      });
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

    const el = this.model.create(eClass, {
      ownerId: ownerId ?? undefined,
      declaredName,
      declaredShortName,
      attrs,
    });

    // Specializations (resolved against the model built so far).
    for (const spec of node.specializations) this.applySpecialization(el, spec, ownerId);

    // Multiplicity — a real `[m..n]` count range. A trailing VALUE unit
    // (`= 1500 [kg]`) is stored in `attrs.unit`, never in attrs.multiplicity
    // (the legacy parser conflated the two — finding D1/H11). The semantics
    // layer reads `attrs.unit` first, falling back to a unit-named
    // attrs.multiplicity for models saved by the old parser.
    const mults = (node.multiplicity ?? []).map(formatMultiplicity);
    if (node.valueMult) this.model.setAttrs(el.id, { unit: formatMultiplicity(node.valueMult) });
    if (mults.length) this.model.setAttrs(el.id, { multiplicity: mults[mults.length - 1] });

    // Feature value ( = / := ).
    if (node.valueOp && node.value) {
      const value = this.mapValue(node.value);
      if (value !== undefined) this.model.setAttrs(el.id, { value });
      if (node.valueOp === ':=' || node.valueOp.endsWith(':=')) this.model.setAttrs(el.id, { initialValue: true });
    }

    // Inline `connection c connect A to B` / `interface i connect A to B`.
    if (node.connectSource !== undefined || node.connectTarget !== undefined) {
      const srcRef = node.connectSource;
      const tgtRef = node.connectTarget;
      const src = srcRef ? this.resolveRef(srcRef, ownerId) : undefined;
      const tgt = tgtRef ? this.resolveRef(tgtRef, ownerId) : undefined;
      const srcWarn = srcRef && !src ? this.warn(`Unresolved connection end '${srcRef}'`, node) : undefined;
      const tgtWarn = tgtRef && !tgt ? this.warn(`Unresolved connection end '${tgtRef}'`, node) : undefined;
      const patch: Record<string, AttrValue> = {};
      if (srcRef && !src) patch.sourceRef = srcRef;
      if (tgtRef && !tgt) patch.targetRef = tgtRef;
      this.model.update(el.id, {
        source: src ? [src.id] : [],
        target: tgt ? [tgt.id] : [],
        attrs: patch,
      });
      if (srcWarn) this.registerEndpointWarning(srcWarn, el.id, 'sourceRef');
      if (tgtWarn) this.registerEndpointWarning(tgtWarn, el.id, 'targetRef');
    }

    // Body members (walked in document order → single-pass resolution).
    if (node.body) {
      for (const m of node.body.members) this.mapMember(m, el.id);
      if (node.body.expr) this.model.setAttrs(el.id, { expression: exprText(node.body.expr) });
    }
  }

  /** Map a single value expression to the legacy primitive-or-verbatim form. */
  private mapValue(expr: Expression): string | number | boolean {
    switch (expr.$type) {
      case 'NumberLiteral':
        return expr.value;
      case 'BoolLiteral':
        return expr.value === 'true';
      case 'StringLiteral':
        // The legacy parser kept the quotes so the value round-trips; the raw
        // CST text is exactly that quoted literal.
        return expr.$cstNode?.text ?? JSON.stringify(expr.value);
      default:
        return exprText(expr);
    }
  }

  /* ───────────────────────── specialization ────────────────────────────── */

  private applySpecialization(
    el: ElementRecord,
    spec: Specialization,
    scope: ElementId | null,
  ): void {
    const op = normalizeSpecOp(spec.op);
    const conjugated = spec.conjugated === true;
    for (const rawRef of spec.types) {
      const ref = rawRef;
      const target = this.resolveRef(ref, scope);
      // Attribute typing whose target is NOT in the model stays a plain
      // `attrs.type` string (the value type — Real, String, … — is usually
      // outside the loaded scope). When the type DOES resolve (e.g. a library
      // usage typed by a loaded unit `LengthUnit`), a real FeatureTyping
      // relationship is created — mirroring the library builder — so the
      // serialize→parse round-trip reproduces that relationship element.
      if (
        op === ':' &&
        !target &&
        (el.eClass === 'AttributeUsage' || el.eClass === 'AttributeDefinition')
      ) {
        this.model.setAttrs(el.id, { type: ref });
        if (conjugated) this.model.setAttrs(el.id, { conjugated: true });
        continue;
      }
      if (!target) {
        this.warn(`Unresolved reference '${ref}'`, spec);
        if (op === ':') {
          this.model.setAttrs(el.id, { typeRef: ref });
        } else {
          const key = op === ':>>' ? 'redefines' : op === '::>' ? 'references' : 'specializes';
          const cur = (el.attrs[key] as string[] | undefined) ?? [];
          this.model.setAttrs(el.id, { [key]: [...cur, ref] });
        }
        if (conjugated) this.model.setAttrs(el.id, { conjugated: true });
        continue;
      }
      const relClass = relClassForOp(op, isDefinition(el.eClass));
      this.model.create(relClass, {
        ownerId: el.id,
        source: [el.id],
        target: [target.id],
      });
      if (conjugated) this.model.setAttrs(el.id, { conjugated: true });
    }
  }
}

/** Specialization-family relationship metaclass for a canonical operator. */
/** Node-level unresolved-specialization attr keys and their canonical operator. */
const SPEC_ARRAY_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['specializes', ':>'],
  ['redefines', ':>>'],
  ['references', '::>'],
];

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

  // Map Langium/Chevrotain lexer + parser diagnostics to error diagnostics.
  for (const e of lexerErrors) {
    mapper.diagnostics.push({
      message: e.message,
      line: e.line ?? 1,
      column: e.column ?? 1,
      severity: 'error',
    });
  }
  for (const e of parserErrors) {
    const tok = e.token;
    mapper.diagnostics.push({
      message: e.message,
      line: tok?.startLine ?? 1,
      column: tok?.startColumn ?? 1,
      severity: 'error',
    });
  }

  mapper.run(ast.members ?? []);
  return { model: mapper.model, diagnostics: mapper.diagnostics };
}
