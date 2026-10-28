/**
 * The {@link Model} — an in-memory SysML v2 element graph with CRUD,
 * containment indexing, traversal, relationship helpers, change events and
 * JSON (de)serialisation. This is the single source of truth the whole app
 * mutates; the UI subscribes to {@link Model.subscribe} for reactivity and the
 * API/SDK queries it for analysis & automation.
 */

import {
  type AttrValue,
  type ElementId,
  type ElementRecord,
  type SerializedModel,
  isMembership,
  isRelationship,
  isSpecialization,
  isTypingSpecialization,
} from './metamodel';
import { newId } from './ids';
import { GENERATOR_ID } from '../branding';

export const FORMAT_VERSION = '0.1.0';

/** A description of a single change applied to the model. */
export interface ChangeEvent {
  type: 'add' | 'update' | 'remove' | 'reparent' | 'reset' | 'order';
  id?: ElementId;
  element?: ElementRecord;
  /** For reparent: the previous owner id. */
  previousOwnerId?: ElementId | null;
  /**
   * For update: which fields the change set (`eClass`, `declaredName`, `declaredShortName`, `attrs`, `source`,
   * `target`). A change of `attrs` alone leaves every name, owner and relationship as it was, which is all a
   * listener that follows what an element inherits needs to know to pass it over.
   */
  fields?: readonly string[];
  /** For an update that moved the relationship's `source`: the ends it had. */
  previousSource?: readonly ElementId[];
  /** For an update that moved the relationship's `target`: the ends it had. */
  previousTarget?: readonly ElementId[];
  /** For an update of `declaredName` or `declaredShortName`: the names the element had (those it had). */
  previousNames?: readonly string[];
  /**
   * For order: the owner whose children are held in another order (`null`: the
   * top level). An `order` names no element: its `id` is undefined.
   */
  ownerId?: ElementId | null;
}

export type ChangeListener = (events: ChangeEvent[]) => void;

/**
 * Something that follows a removal beyond the removal itself. It is called with the ids a {@link Model.remove}
 * is about to take away (the element, what it owns, and the edges that reference them), BEFORE any is gone, and
 * returns what to do once they are, or nothing.
 */
export type RemovalPlanner = (going: ReadonlySet<ElementId>) => (() => void) | void;

/** Options when creating an element. */
export interface CreateElementOptions {
  id?: ElementId;
  declaredName?: string;
  declaredShortName?: string;
  ownerId?: ElementId | null;
  attrs?: Record<string, AttrValue>;
  source?: ElementId[];
  target?: ElementId[];
}

export class Model {
  private elements = new Map<ElementId, ElementRecord>();
  /** ownerId → ordered child ids. `null` owner ⇒ roots. */
  private childrenIndex = new Map<ElementId | null, ElementId[]>();
  private listeners = new Set<ChangeListener>();
  private removalPlanners = new Set<RemovalPlanner>();
  /** When >0, change events are buffered and flushed on transaction end. */
  private txnDepth = 0;
  private pending: ChangeEvent[] = [];
  /**
   * Monotonic revision counter, bumped on every structural change. A cheap,
   * stable cache key: semantics/library memoisation (which keyed only on Model
   * *identity* via WeakMap and so went stale after any mutation) invalidates by
   * comparing against this, and the endpoint index below rebuilds when it moves.
   */
  private _rev = 0;
  /**
   * Has any element carrying `attrs.isLibrary === true` ever entered this model?
   *
   * A MONOTONE flag, not a count. Every library lookup (`findLibraryType`, the
   * implicit-base resolution behind `generalizationsWithImplicit`) is a scan or
   * an index rebuild over the whole model, and during a PARSE the model is
   * user-only — so the answer is always "no" and the work is always wasted.
   * A rev-keyed cache cannot help there: the mapper bumps `rev` on every
   * element it creates, so the scan would run once per element.
   *
   * Monotone is deliberate. Removing the library again leaves the flag set,
   * which only costs a lookup that finds nothing — the conservative direction.
   * A wrongly-cleared flag would instead make library types silently
   * unresolvable, so the flag is only ever reset where the element map itself
   * is rebuilt from scratch (`reset` / `resetPreserving`).
   */
  private _sawLibrary = false;
  /**
   * Whether the model may have left its text order ({@link adoptSerialOrder})
   * since it was last listed in it or reset: an element of the user's added
   * that a load lists in place ({@link listedLater}), an element moved, one
   * whose kind or library flag changed, or an owner's children held in another
   * order ({@link orderChildren}). Nothing else can put a declaration
   * out of that order, or an owner's children out of the order the owner holds
   * them — a removal leaves the rest as they were, and an element a load lists
   * later is added at the end, where a load lists it — so an edit that did
   * none of these costs `adoptSerialOrder` nothing.
   */
  private _orderStale = false;
  /**
   * Whether an element was moved since then, a declaration seated before its
   * owner's typings ({@link seatDeclarations}), or an owner's children held in
   * another order ({@link orderChildren}): only these can leave an
   * owner's children listed out of the order the owner holds them, so only
   * then are the elements listed after the walk put back in that order (a pass
   * over every element and its owner, not only a filter).
   */
  private _orderMoved = false;
  /**
   * The owners an edit gave a declaration below a child a load lists later
   * ({@link listedLater}: a typing, a specialisation, an implicit feature) or
   * one of the library's ({@link heldLater}), or a child whose kind or library
   * flag moved it between those and the declarations ({@link notePlacing}),
   * since the model was last listed: a terminal over the text Save writes
   * holds that declaration before them, as a load holds every declaration
   * before what it binds once every name is known, so {@link adoptSerialOrder}
   * seats it there ({@link seatDeclarations}). A load holds none so (none of
   * the 856 models measured holds a child of those kinds ahead of a declared
   * sibling, and no text gives an owner of the user's a child of the
   * library's), so seating leaves the parser's own models as it made them.
   */
  private _orderSeats = new Set<ElementId>();
  /** Lazy endpoint indices (source id → edges, target id → edges), keyed by rev. */
  private _edgeIndexRev = -1;
  private _sourceIndex = new Map<ElementId, ElementRecord[]>();
  private _targetIndex = new Map<ElementId, ElementRecord[]>();

  constructor() {
    this.childrenIndex.set(null, []);
  }

  /** Current revision — increments on every add/update/remove/reparent/reset. */
  get rev(): number {
    return this._rev;
  }

  /**
   * True once any standard-library element has been merged in. False means
   * "there is nothing library-shaped to find here" — the cheap short-circuit
   * for every library-wide lookup. See {@link _sawLibrary}.
   */
  get hasLibrary(): boolean {
    return this._sawLibrary;
  }

  /* ──────────────────────────── Subscriptions ─────────────────────────── */

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Have `planner` follow every {@link remove} of this model: whoever removes (a command, the SDK, a REST call, a
   * peer's edit) gets what the planner does after the removal, in the removal's own notification. For what the
   * model cannot decide itself: where a redefinition goes when its target does (the name its text is saved by,
   * `src/text`), which is no business of `src/core`.
   */
  addRemovalPlanner(planner: RemovalPlanner): () => void {
    this.removalPlanners.add(planner);
    return () => this.removalPlanners.delete(planner);
  }

  /** Batch a set of mutations into a single notification. */
  transaction<T>(fn: () => T): T {
    this.txnDepth++;
    try {
      return fn();
    } finally {
      this.txnDepth--;
      if (this.txnDepth === 0) this.flush();
    }
  }

  private emit(event: ChangeEvent): void {
    this._rev++;
    this.pending.push(event);
    if (this.txnDepth === 0) this.flush();
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    for (const l of this.listeners) l(batch);
  }

  /* ─────────────────────────────── Create ─────────────────────────────── */

  create(eClass: string, opts: CreateElementOptions = {}): ElementRecord {
    const id = opts.id ?? newId();
    if (this.elements.has(id)) throw new Error(`Element id already exists: ${id}`);
    const ownerId = opts.ownerId ?? null;
    if (ownerId !== null && !this.elements.has(ownerId)) {
      throw new Error(`Owner does not exist: ${ownerId}`);
    }
    const el: ElementRecord = {
      id,
      eClass,
      declaredName: opts.declaredName,
      declaredShortName: opts.declaredShortName,
      ownerId,
      attrs: opts.attrs ? { ...opts.attrs } : {},
    };
    if (opts.source) el.source = [...opts.source];
    if (opts.target) el.target = [...opts.target];
    if (el.attrs.isLibrary === true) this._sawLibrary = true;
    else if (!listedLater(el)) {
      this._orderStale = true;
      this.noteSeat(ownerId);
    }
    this.elements.set(id, el);
    this.indexChild(ownerId, id);
    this.emit({ type: 'add', id, element: el });
    return el;
  }

  /** Insert a pre-built record (used by deserialisation). */
  private insertRaw(el: ElementRecord): void {
    if (el.attrs.isLibrary === true) this._sawLibrary = true;
    this.elements.set(el.id, el);
  }

  /* ─────────────────────────────── Read ───────────────────────────────── */

  has(id: ElementId): boolean {
    return this.elements.has(id);
  }

  get(id: ElementId): ElementRecord | undefined {
    return this.elements.get(id);
  }

  /** Throwing accessor for code paths that require existence. */
  require(id: ElementId): ElementRecord {
    const el = this.elements.get(id);
    if (!el) throw new Error(`Element not found: ${id}`);
    return el;
  }

  get size(): number {
    return this.elements.size;
  }

  all(): ElementRecord[] {
    return [...this.elements.values()];
  }

  roots(): ElementRecord[] {
    return (this.childrenIndex.get(null) ?? []).map((id) => this.elements.get(id)!).filter(Boolean);
  }

  rootIds(): ElementId[] {
    return [...(this.childrenIndex.get(null) ?? [])];
  }

  children(ownerId: ElementId): ElementRecord[] {
    return (this.childrenIndex.get(ownerId) ?? [])
      .map((id) => this.elements.get(id)!)
      .filter(Boolean);
  }

  childIds(ownerId: ElementId | null): ElementId[] {
    return [...(this.childrenIndex.get(ownerId) ?? [])];
  }

  owner(id: ElementId): ElementRecord | undefined {
    const el = this.elements.get(id);
    if (!el || el.ownerId === null) return undefined;
    return this.elements.get(el.ownerId);
  }

  /** Depth-first descendants of an element (excluding itself). Cycle-safe. */
  descendants(id: ElementId): ElementRecord[] {
    const out: ElementRecord[] = [];
    const visited = new Set<ElementId>([id]);
    // Explicit stack with pop()/push() — O(1) per node. (The prior
    // shift()/unshift(...children) form was O(n) per step ⇒ O(n²) overall.)
    // Children are pushed in reverse so they pop in declaration order.
    const stack = [...this.childIds(id)].reverse();
    while (stack.length) {
      const cid = stack.pop()!;
      if (visited.has(cid)) continue; // guard against malformed containment cycles
      visited.add(cid);
      const el = this.elements.get(cid);
      if (!el) continue;
      out.push(el);
      const kids = this.childIds(cid);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  }

  /** Ancestor chain from immediate owner up to a root. Cycle-safe. */
  ancestors(id: ElementId): ElementRecord[] {
    const out: ElementRecord[] = [];
    const visited = new Set<ElementId>([id]);
    let cur = this.elements.get(id);
    while (cur && cur.ownerId !== null) {
      const owner = this.elements.get(cur.ownerId);
      if (!owner || visited.has(owner.id)) break;
      visited.add(owner.id);
      out.push(owner);
      cur = owner;
    }
    return out;
  }

  filter(predicate: (el: ElementRecord) => boolean): ElementRecord[] {
    return this.all().filter(predicate);
  }

  ofKind(...eClasses: string[]): ElementRecord[] {
    const set = new Set(eClasses);
    return this.filter((el) => set.has(el.eClass));
  }

  /** All node (non-relationship) elements. */
  nodes(): ElementRecord[] {
    return this.filter((el) => !isRelationship(el.eClass));
  }

  /** All relationship elements. */
  relationships(): ElementRecord[] {
    return this.filter((el) => isRelationship(el.eClass));
  }

  /**
   * Resolve a qualified name like `Pkg::Sub::part` to an element, searching by
   * declaredName then declaredShortName at each step.
   */
  resolveQualifiedName(qname: string): ElementRecord | undefined {
    const segments = qname.split('::').map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) return undefined;
    let candidates = this.roots();
    let found: ElementRecord | undefined;
    for (const seg of segments) {
      found = candidates.find((el) => el.declaredName === seg || el.declaredShortName === seg);
      if (!found) return undefined;
      candidates = this.children(found.id);
    }
    return found;
  }

  /** Fully-qualified name of an element (`Root::Owner::name`). */
  qualifiedName(id: ElementId): string {
    const el = this.elements.get(id);
    if (!el) return '';
    const parts: string[] = [];
    const visited = new Set<ElementId>();
    let cur: ElementRecord | undefined = el;
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id); // cycle-safe on malformed containment
      parts.unshift(cur.declaredName ?? cur.declaredShortName ?? `«${cur.eClass}»`);
      cur = cur.ownerId !== null ? this.elements.get(cur.ownerId) : undefined;
    }
    return parts.join('::');
  }

  /* ───────────────────────── Relationship helpers ─────────────────────── */

  /**
   * (Re)build the source/target endpoint indices when the model has changed.
   * Turns the per-call O(n) scans below into O(1) lookups after a single O(n)
   * build that is reused across every call at the same revision — the hot path
   * for analytics (traceability/where-used) which query endpoints in nested
   * loops (previously O(rows × cols × n)).
   */
  private ensureEdgeIndex(): void {
    if (this._edgeIndexRev === this._rev) return;
    const src = new Map<ElementId, ElementRecord[]>();
    const tgt = new Map<ElementId, ElementRecord[]>();
    const add = (m: Map<ElementId, ElementRecord[]>, key: ElementId, el: ElementRecord): void => {
      const list = m.get(key);
      if (list) list.push(el);
      else m.set(key, [el]);
    };
    for (const el of this.elements.values()) {
      if (el.source) for (const s of new Set(el.source)) add(src, s, el);
      if (el.target) for (const t of new Set(el.target)) add(tgt, t, el);
    }
    this._sourceIndex = src;
    this._targetIndex = tgt;
    this._edgeIndexRev = this._rev;
  }

  /** Edge elements whose `source` includes `id` (any endpoint-bearing element). */
  edgesFrom(id: ElementId): ElementRecord[] {
    this.ensureEdgeIndex();
    return [...(this._sourceIndex.get(id) ?? [])];
  }

  /** Edge elements whose `target` includes `id`. */
  edgesTo(id: ElementId): ElementRecord[] {
    this.ensureEdgeIndex();
    return [...(this._targetIndex.get(id) ?? [])];
  }

  /** Edge elements touching `id` on either endpoint (deduplicated). */
  edgesOf(id: ElementId): ElementRecord[] {
    this.ensureEdgeIndex();
    const from = this._sourceIndex.get(id);
    const to = this._targetIndex.get(id);
    if (!from) return [...(to ?? [])];
    if (!to) return [...from];
    const seen = new Set(from.map((e) => e.id));
    return [...from, ...to.filter((e) => !seen.has(e.id))];
  }

  /** Relationships whose `source` includes `id`. */
  relationshipsFrom(id: ElementId): ElementRecord[] {
    return this.edgesFrom(id).filter((r) => isRelationship(r.eClass));
  }

  /** Relationships whose `target` includes `id`. */
  relationshipsTo(id: ElementId): ElementRecord[] {
    return this.edgesTo(id).filter((r) => isRelationship(r.eClass));
  }

  /** All relationships touching `id` on either end. */
  relationshipsOf(id: ElementId): ElementRecord[] {
    return this.edgesOf(id).filter((r) => isRelationship(r.eClass));
  }

  /**
   * The types a feature/usage specialises (FeatureTyping/Subclassification
   * targets). Returns resolved target elements where they exist in-model.
   */
  typesOf(id: ElementId): ElementRecord[] {
    // One pass over the edge index, no copy of it: every walk of the generals of a type asks this once per type it
    // meets, so on a deep lattice the copies and filters were most of a parse.
    this.ensureEdgeIndex();
    const out: ElementRecord[] = [];
    for (const r of this._sourceIndex.get(id) ?? []) {
      if (!isRelationship(r.eClass) || !isTypingSpecialization(r.eClass)) continue;
      for (const t of r.target ?? []) {
        const general = this.elements.get(t);
        if (general) out.push(general);
      }
    }
    return out;
  }

  /* ─────────────────────────────── Update ─────────────────────────────── */

  update(id: ElementId, patch: Partial<Omit<ElementRecord, 'id' | 'ownerId'>>): ElementRecord {
    const el = this.require(id);
    const placing = placingOf(el);
    const previousNames =
      patch.declaredName !== undefined || patch.declaredShortName !== undefined
        ? [el.declaredName, el.declaredShortName].filter((n): n is string => n !== undefined)
        : undefined;
    if (patch.eClass !== undefined) el.eClass = patch.eClass;
    if (patch.declaredName !== undefined) el.declaredName = patch.declaredName;
    if (patch.declaredShortName !== undefined) el.declaredShortName = patch.declaredShortName;
    if (patch.attrs !== undefined) el.attrs = mergeAttrs(el.attrs, patch.attrs);
    if (el.attrs.isLibrary === true) this._sawLibrary = true;
    if (placingOf(el) !== placing) this.notePlacing(el);
    const previousSource = patch.source !== undefined ? el.source : undefined;
    const previousTarget = patch.target !== undefined ? el.target : undefined;
    if (patch.source !== undefined) el.source = [...patch.source];
    if (patch.target !== undefined) el.target = [...patch.target];
    const fields = (['eClass', 'declaredName', 'declaredShortName', 'attrs', 'source', 'target'] as const).filter(
      (k) => patch[k] !== undefined,
    );
    const event: ChangeEvent = { type: 'update', id, element: el, fields };
    if (previousSource !== undefined) event.previousSource = previousSource;
    if (previousTarget !== undefined) event.previousTarget = previousTarget;
    if (previousNames !== undefined) event.previousNames = previousNames;
    this.emit(event);
    return el;
  }

  /** Set/merge attribute values on an element. A key set to `undefined` is deleted. */
  setAttrs(id: ElementId, attrs: Record<string, AttrValue | undefined>): ElementRecord {
    const el = this.require(id);
    const placing = placingOf(el);
    el.attrs = mergeAttrs(el.attrs, attrs);
    if (el.attrs.isLibrary === true) this._sawLibrary = true;
    if (placingOf(el) !== placing) this.notePlacing(el);
    this.emit({ type: 'update', id, element: el, fields: ['attrs'] });
    return el;
  }

  rename(id: ElementId, declaredName: string): ElementRecord {
    return this.update(id, { declaredName });
  }

  /**
   * Set or REMOVE an element's short name (`<R1>`).
   *
   * {@link update} reads an absent patch key as "leave it alone", so it cannot
   * clear a short name — and `''` is not a clearing either: it is a blank id,
   * a distinct state the file can hold and the serializer writes out as `<''>`
   * (no validation rule reports it today). A requirement whose id was emptied
   * must carry NO short name, so this is the one setter that can take it off.
   */
  setShortName(id: ElementId, declaredShortName: string | undefined): ElementRecord {
    const el = this.require(id);
    const previousNames = el.declaredShortName === undefined ? [] : [el.declaredShortName];
    el.declaredShortName = declaredShortName;
    this.emit({ type: 'update', id, element: el, fields: ['declaredShortName'], previousNames });
    return el;
  }

  /** Reparent an element to a new owner (or root when `null`). */
  reparent(id: ElementId, newOwnerId: ElementId | null): ElementRecord {
    const el = this.require(id);
    if (newOwnerId !== null && !this.elements.has(newOwnerId)) {
      throw new Error(`New owner does not exist: ${newOwnerId}`);
    }
    if (newOwnerId === id) throw new Error('An element cannot own itself');
    // Guard against cycles: newOwner must not be a descendant of el.
    if (newOwnerId !== null && this.isAncestorOf(id, newOwnerId)) {
      throw new Error('Reparent would create a containment cycle');
    }
    const previousOwnerId = el.ownerId;
    this.deindexChild(previousOwnerId, id);
    el.ownerId = newOwnerId;
    if (placingOf(el) === 'inPlace') this.noteSeat(newOwnerId);
    this.indexChild(newOwnerId, id);
    this._orderStale = true;
    this._orderMoved = true;
    this.emit({ type: 'reparent', id, element: el, previousOwnerId });
    return el;
  }

  /**
   * Hold `ownerId`'s children — the top level's with `null` — in the order
   * `order` gives them: those it names, in its order, then those it does not
   * name, in the order they were held. An id it names that is not one of them
   * is passed over, and none is added or taken away.
   *
   * A collaboration room holds each owner's children by it in the order the
   * peer who made an edit holds them (`src/collab/model-doc.ts`). That order is
   * the one the edit left before the peer's model was listed in its text order
   * ({@link adoptSerialOrder}), which seats an owner's declarations before the
   * children a load lists later and the library's ({@link seatDeclarations});
   * so an owner of the user's is seated here in the same way, and is held as
   * that peer holds it.
   *
   * Announces an `order` change, and returns whether the order moved. The
   * model is listed in its text order again by the next
   * {@link adoptSerialOrder}.
   */
  orderChildren(ownerId: ElementId | null, order: readonly ElementId[]): boolean {
    const held = this.childrenIndex.get(ownerId);
    if (held === undefined || held.length === 0) return false;
    const unnamed = new Set(held);
    const named: ElementId[] = [];
    for (const id of order) if (unnamed.delete(id)) named.push(id);
    const next = this.seated(ownerId, [...named, ...held.filter((id) => unnamed.has(id))]);
    if (next.every((id, i) => id === held[i])) return false;
    this.childrenIndex.set(ownerId, next);
    this._orderStale = true;
    this._orderMoved = true;
    this.emit({ type: 'order', ownerId });
    return true;
  }

  private isAncestorOf(ancestorId: ElementId, descendantId: ElementId): boolean {
    const visited = new Set<ElementId>();
    let cur = this.elements.get(descendantId);
    while (cur && cur.ownerId !== null) {
      if (cur.ownerId === ancestorId) return true;
      if (visited.has(cur.id)) break; // cycle-safe
      visited.add(cur.id);
      cur = this.elements.get(cur.ownerId);
    }
    return false;
  }

  /* ─────────────────────────────── Delete ─────────────────────────────── */

  /**
   * Remove an element. By default cascades to owned children and removes any
   * relationships that reference the deleted element(s).
   */
  remove(id: ElementId, opts: { cascade?: boolean } = {}): ElementId[] {
    const cascade = opts.cascade ?? true;
    const el = this.elements.get(id);
    if (!el) return [];
    const toRemove = new Set<ElementId>([id]);
    if (cascade) for (const d of this.descendants(id)) toRemove.add(d.id);
    // Also remove dangling EDGES — any element carrying endpoints (KerML
    // Relationships AND endpoint-bearing Usages like ConnectionUsage / Flow /
    // Transition / Succession) that references a removed element.
    //
    // A Redefinition whose target goes but whose feature stays is MOVED, not removed, when the target redefined a
    // feature in turn: the feature then redefines the nearest feature up the chain that stays (`part s : Q2 {
    // attribute :>> M = 5.0; }` over Q2's unnamed `:>> M default = 2.0`, deleted, redefines Q's `M` — removed with it,
    // the feature saved as `attribute = 5.0;` and the user's `:>> M` gone). That is a fallback only: it walks UP the
    // redefinitions of the target, and the redefinition rule lands on the MOST SPECIFIC feature the text's name finds,
    // which skips a level the walk takes (Q4's `M4 redefines Q::M` beside Q2's `:>> M`: the walk lands on Q's `M`, the
    // name `M` on Q2's). A model the app edits has a removal planner (`addRemovalPlanner`) that re-resolves by the
    // name the saved text writes (`retargetRedefinitions`), so a delete in the app, through the SDK or a REST call,
    // and the same delete in the text agree.
    const moved = new Map<ElementId, ElementId[]>();
    for (const r of this.elements.values()) {
      if (toRemove.has(r.id)) continue;
      const refs = [...(r.source ?? []), ...(r.target ?? [])];
      if (refs.length > 0 && refs.some((ref) => toRemove.has(ref))) {
        const targets = r.eClass === 'Redefinition' ? this.survivingTargets(r, toRemove) : undefined;
        if (targets !== undefined) moved.set(r.id, targets);
        else toRemove.add(r.id);
      }
    }
    const afterwards: Array<() => void> = [];
    for (const plan of this.removalPlanners) {
      const after = plan(toRemove);
      if (after) afterwards.push(after);
    }
    return this.transaction(() => {
      for (const [rid, target] of moved) this.update(rid, { target });
      const removed: ElementId[] = [];
      for (const rid of toRemove) {
        const rec = this.elements.get(rid);
        if (!rec) continue;
        this.deindexChild(rec.ownerId, rid);
        this.childrenIndex.delete(rid);
        this.elements.delete(rid);
        removed.push(rid);
        this.emit({ type: 'remove', id: rid, element: rec });
      }
      for (const after of afterwards) after();
      return removed;
    });
  }

  /**
   * The targets a Redefinition keeps when `gone` is removed: its own that stay, and for each that goes the nearest
   * feature it redefines that stays (a breadth-first walk over its Redefinitions). `undefined` when the redefinition
   * has to go with them: its feature is removed, or a target that goes redefines nothing that stays.
   */
  private survivingTargets(r: ElementRecord, gone: ReadonlySet<ElementId>): ElementId[] | undefined {
    if ((r.source ?? []).some((x) => gone.has(x)) || (r.target ?? []).length === 0) return undefined;
    const out: ElementId[] = [];
    for (const t of r.target ?? []) {
      if (!gone.has(t)) {
        if (!out.includes(t)) out.push(t);
        continue;
      }
      const seen = new Set<ElementId>([t]);
      const queue: ElementId[] = [t];
      let found: ElementId | undefined;
      for (let i = 0; i < queue.length && found === undefined; i++) {
        for (const e of this.relationshipsFrom(queue[i]!)) {
          if (e.eClass !== 'Redefinition') continue;
          for (const x of e.target ?? []) {
            if (seen.has(x) || !this.elements.has(x)) continue;
            seen.add(x);
            if (gone.has(x)) queue.push(x);
            else if (found === undefined) found = x;
          }
        }
      }
      if (found === undefined) return undefined;
      if (!out.includes(found)) out.push(found);
    }
    return out;
  }

  /* ─────────────────────────── Index maintenance ──────────────────────── */

  private indexChild(ownerId: ElementId | null, childId: ElementId): void {
    const list = this.childrenIndex.get(ownerId);
    if (list) list.push(childId);
    else this.childrenIndex.set(ownerId, [childId]);
  }

  private deindexChild(ownerId: ElementId | null, childId: ElementId): void {
    const list = this.childrenIndex.get(ownerId);
    if (!list) return;
    const i = list.indexOf(childId);
    if (i >= 0) list.splice(i, 1);
  }

  /** Before a declaration is added to `ownerId`'s children: note the owner when it would follow one held after them ({@link _orderSeats}, {@link heldLater}). */
  private noteSeat(ownerId: ElementId | null): void {
    if (ownerId === null) return;
    const list = this.childrenIndex.get(ownerId);
    const last = list === undefined || list.length === 0 ? undefined : this.elements.get(list[list.length - 1]);
    if (last !== undefined && heldLater(last)) this._orderSeats.add(ownerId);
  }

  /** An element's kind or flags moved it between the user's declarations, what a load lists later, and the library. */
  private notePlacing(el: ElementRecord): void {
    this._orderStale = true;
    if (el.ownerId === null) return;
    // A declaration now, among children held after the declarations ({@link heldLater}), or one of those among
    // declarations: seat its owner, as a load holds that owner's declarations first. So every owner of the user's
    // stays so held, on every peer of a collaboration room alike ({@link orderChildren}).
    this._orderSeats.add(el.ownerId);
    // Announced as an `order` change, as a seat is: how that owner's children are seated changed, so a collaboration
    // room is told the order this model holds them in, and seats them as it does (`src/collab/model-doc.ts`).
    this.emit({ type: 'order', ownerId: el.ownerId });
  }

  /* ──────────────────────────── Serialisation ─────────────────────────── */

  /**
   * Every element `keep` accepts (all of them without one), the model's own
   * records, in the order a serialised model lists them: each owner's children
   * in the order the model holds them ({@link children}), everything else where
   * it was added.
   *
   * WHY NOT {@link all}. A serialised model carries no child order of its own:
   * {@link fromJSON} and {@link resetPreserving} rebuild it from the order the
   * elements are listed in. `all()` lists them in the order they were added, and
   * {@link reparent} appends the element it moves to its new owner's children
   * without moving it in that order. So a model listed by `all()` after a
   * reparent came back with that owner's children reordered — on Save then
   * reopen, on every Undo and Redo, and in the checks worker, which rebuilt
   * another model than the page's: a composite with no `initial` enters its
   * first child, and the palette said `issues` where the page and a terminal
   * said `holds` (review 2026-10-14 D-1, D-2).
   *
   * ONLY CHILDREN MOVE, and only among the places their own siblings held. A
   * model no reparent touched lists each owner's children in the order they
   * were added, so it is listed exactly as `all()` lists it and serialises byte
   * for byte as it did. The parser's own reparents count: a load puts a
   * feature's specialisations back in declaration order
   * (`restoreSpecializationOrder`), moves a relationship statement onto its
   * source, and rehomes what it recovered after a fault, each by a reparent.
   * Such a load is now saved with its children in the order the parser set, and
   * so comes back as it was read: before, Save then reopen and every Undo wrote
   * `part :>> p : Sub;` back as `part : Sub :>> p;`, and `part b : W :> a;` as
   * `part b :> a : W;` (1 of the 637 models of the verdict corpus, 2 of the
   * repository's 218 `.sysml` files, none of the examples or the drone-swarm
   * model). A full pre-order walk would list the same children in the same
   * order, but it would also move every element a load adds after its owner's
   * later siblings — the typings a parse binds in a second pass, 1,030 of the
   * drone-swarm model's 3,823 — and so rewrite every saved model and every
   * {@link clone} for nothing a reader can tell. Roots keep their places:
   * `rootIds` carries their order, and every load reads it.
   */
  inSerialOrder(keep?: (el: ElementRecord) => boolean): ElementRecord[] {
    const out: ElementRecord[] = [];
    // Where in `out` each owner's children are, in the order they were added.
    const places = new Map<ElementId, number[]>();
    for (const el of this.elements.values()) {
      if (keep !== undefined && !keep(el)) continue;
      if (el.ownerId !== null) {
        const at = places.get(el.ownerId);
        if (at) at.push(out.length);
        else places.set(el.ownerId, [out.length]);
      }
      out.push(el);
    }
    for (const [ownerId, at] of places) {
      if (at.length < 2) continue;
      const order = this.childrenIndex.get(ownerId) ?? [];
      // Already in the order the model holds them — every owner, unless a child was reparented into it.
      let k = 0;
      for (let j = 0; j < order.length && k < at.length; j++) if (order[j] === out[at[k]].id) k++;
      if (k === at.length) continue;
      const listed = new Set<ElementId>();
      for (const i of at) listed.add(out[i].id);
      const held: ElementRecord[] = [];
      for (const id of order) if (listed.delete(id)) held.push(this.elements.get(id)!);
      // A child the index does not hold — one a non-cascading `remove` of its owner left behind — keeps its place among the rest.
      for (const i of at) if (listed.has(out[i].id)) held.push(out[i]);
      for (let n = 0; n < at.length; n++) out[at[n]] = held[n];
    }
    return out;
  }

  /**
   * List the model's own elements in its TEXT ORDER — the order in which a
   * terminal lists the declarations of the model it reads from the text this
   * one writes — so that {@link all}, and every index built from it — the
   * endpoint index behind {@link edgesFrom}, the order a walk finds its
   * machines in — follows that order, and every copy of this model is rebuilt
   * in it: the text order lists each owner's children in the order the owner
   * holds them, so {@link inSerialOrder} lists a model in it as it stands. The
   * same records, re-listed: nothing is copied, and the re-listing is not
   * announced, since no element changed; but the revision moves, so an index or
   * a cache a listener of the edit built is built again. Returns whether
   * anything moved. An owner whose declarations are seated (below) holds its
   * children in another order, and that is announced, as an `order` change for
   * that owner: a collaboration room holds them so on every peer
   * (`src/collab/model-doc.ts`).
   *
   * THE TEXT ORDER. The user's elements a load lists in place, in containment
   * pre-order, from the user's roots down, each owner's children in the order
   * it holds them; then every other element as {@link inSerialOrder} lists it.
   * A load lists in place every element the text declares, in the order it
   * reads them; what it makes later — the typings, specialisations and
   * redefinitions it binds once every name is known, the implicit features it
   * makes for a connector end that chains through a type, and what they own
   * ({@link listedLater}) — it lists after them, and holds them after its
   * owner's declarations. So the walk leaves out an owner's last children while
   * they are of those kinds, and what they own. An edit that adds a
   * declaration where one of them is its owner's last child — a doc typed into
   * a typed part, an attribute added to it, an element dragged into it — is
   * first seated before them ({@link seatDeclarations}), where a terminal over
   * the saved text holds it; else the owner's typing would be walked among the
   * declarations, ahead of every other owner's, and `where-used` would list the
   * usages it types in another order than a terminal. No load holds one of
   * those kinds ahead of a declared sibling (none of the 856 models below);
   * should one stand there all the same, it keeps its place among its
   * siblings, so that every copy still rebuilds each owner's children in the
   * order the owner holds them.
   *
   * The page's load — the parse as {@link toJSON} lists it — is in this order
   * already: of 856 models — the verdict corpus's 637, the repository's 218
   * model files that load, and the drone-swarm model — all but the two copies
   * of `L5-relationship-after-fault` (a `subset` statement written above the
   * feature it is about, one element each); none of the drone-swarm model's
   * 3,823 elements moves, where a plain pre-order walk would move 1,030 (10,489
   * in 712 of the 856). A terminal's own parse, not listed through `toJSON`,
   * also lists two specialisations of the verdict corpus's `s1-spec` where the
   * parser made them before it put them back in declaration order, as
   * `inSerialOrder` lists them. The model a person loads is therefore left as
   * the parse listed it, and is re-listed only once an edit adds or moves an
   * element.
   *
   * WHY. {@link reparent} appends the element it moves to its new owner's
   * children and leaves it where it was in `all()`, and {@link create} adds an
   * element at the end, while a terminal reads the text Save writes from top to
   * bottom, and the checks worker, an Undo snapshot and Save then reopen rebuild
   * the model from the order a serialised model lists it in. So the page
   * decided by an order no copy had: of two transitions out of an `initial`,
   * one dragged out and back in, the page took the one added first and said
   * `holds`, where the worker and a terminal took the first in the text and
   * said `issues` (review 2026-10-14 D-1); and after a package was dragged out
   * of its owner and back in, or a machine was made in a package above another
   * machine's, the page and the worker reported the machines' rows in the order
   * they were added, and a terminal over the saved text in the text's order
   * (the D-1 review, its S2 review).
   *
   * CALLED ONCE PER EDIT, not by {@link reparent} or {@link create}: by the
   * store after each command and each call of the SDK on `window.sysml` that
   * edits (a script adds its elements in one `commit` to pay once for them),
   * by the store's drag commands and a regroup, the SDK's `reparent` at each
   * call, in a `commit` too, and a collaboration room after taking in a peer's
   * edits. An edit that adds no element a load lists in place, moves nothing
   * and changes no element's kind costs nothing ({@link _orderStale}); one
   * that does costs a pass over the model (about 16 ms on the drone-swarm
   * model and its library of 42,584 elements, on a loaded machine). The parser
   * reparents and adds while it loads, and the model a terminal reads keeps
   * the order the parse listed it in.
   *
   * WHOLE: for a model reset from data this session did not list — a project
   * stored by an earlier build, a model JSON or an element graph imported or
   * pulled, a branch's commit, a collaboration room's document a peer joins —
   * which may list it in the order its elements were added: every owner of the
   * user's is seated, and the model re-listed, whatever was edited. Undo and
   * Redo snapshots and a parse are listed already.
   *
   * What it does not give: what a load lists after the declarations keeps
   * its place among the others, where a terminal over the saved text binds
   * them in the order their declarations come. One an edit adds — a typing
   * set with Properties' Type field, a specialisation drawn with the palette
   * — is listed after those the model had; one whose element a drag puts
   * elsewhere in the text, or that a project, model JSON or branch stored in
   * another order, stays where it was. So `where-used` over a definition
   * lists a usage typed in the app after one typed below it in the text, and
   * after a drag of their packages in the order they had, here and in every
   * copy, and in the text's order in a terminal (TODO.md).
   */
  adoptSerialOrder(opts: { whole?: boolean } = {}): boolean {
    const whole = opts.whole === true;
    if (!this._orderStale && !whole) return false;
    const seated = this.seatDeclarations(whole);
    const listed = this.inTextOrder();
    this.keepListedOrder();
    let i = 0;
    let same = true;
    for (const el of this.elements.values()) {
      if (listed[i++] !== el) {
        same = false;
        break;
      }
    }
    if (!same) {
      this.elements = new Map(listed.map((el) => [el.id, el]));
      this._rev++;
    }
    // A seat holds an owner's children in another order: announced, as by `orderChildren`, so that a
    // collaboration room holds them so on every peer (`src/collab/model-doc.ts`).
    if (seated.length > 0) {
      this.transaction(() => {
        for (const ownerId of seated) this.emit({ type: 'order', ownerId });
      });
    }
    return !same;
  }

  /** The order {@link adoptSerialOrder} lists the model in. */
  private inTextOrder(): ElementRecord[] {
    const out: ElementRecord[] = [];
    const placed = new Set<ElementId>();
    const stack: ElementId[] = [];
    // An owner's children, last first, so that they pop in the order it holds them — but a last run of kinds a load lists later.
    const push = (ids: readonly ElementId[]): void => {
      let end = ids.length;
      while (end > 0) {
        const last = this.elements.get(ids[end - 1]);
        if (last !== undefined && !listedLater(last)) break;
        end--;
      }
      for (let i = end - 1; i >= 0; i--) stack.push(ids[i]);
    };
    push((this.childrenIndex.get(null) ?? []).filter((id) => this.elements.get(id)?.attrs.isLibrary !== true));
    while (stack.length > 0) {
      const id = stack.pop()!;
      const el = this.elements.get(id);
      if (el === undefined || placed.has(id)) continue;
      placed.add(id);
      out.push(el);
      push(this.childrenIndex.get(id) ?? []);
    }
    // Without a move, each owner's children are listed in the order it holds them already: a filter keeps that.
    const rest = this._orderMoved
      ? this.inSerialOrder((el) => !placed.has(el.id))
      : this.all().filter((el) => !placed.has(el.id));
    for (const el of rest) out.push(el);
    return out;
  }

  /**
   * Seat the declarations an edit added below children a load lists later or
   * the library's ({@link heldLater}) — in every owner of the user's with
   * `whole` — where a terminal over the text Save writes holds them: each such
   * owner's declarations first, in the order it holds them, then its other
   * children, in theirs ({@link seated}). A typing stays
   * its owner's last child, and so stays where a load listed it among the
   * typings ({@link inTextOrder}). Returns the owners it seated.
   */
  private seatDeclarations(whole: boolean): ElementId[] {
    const owners = whole ? [...this.childrenIndex.keys()] : [...this._orderSeats];
    const seated: ElementId[] = [];
    for (const ownerId of owners) {
      const ids = this.childrenIndex.get(ownerId);
      if (ownerId === null || ids === undefined) continue;
      const next = this.seated(ownerId, ids);
      if (next === ids) continue;
      this.childrenIndex.set(ownerId, next);
      this._orderMoved = true;
      seated.push(ownerId);
    }
    return seated;
  }

  /**
   * `ids`, children of `ownerId`, as {@link seatDeclarations} seats them: an
   * owner of the user's holds its declarations first, then its children a
   * load lists later and the library's ({@link heldLater}), each in the order
   * `ids` gives them. `ids` itself when no declaration follows one of those,
   * or when the owner is the top level, the library's, or gone.
   */
  private seated(ownerId: ElementId | null, ids: ElementId[]): ElementId[] {
    if (ownerId === null) return ids;
    const owner = this.elements.get(ownerId);
    if (owner === undefined || owner.attrs.isLibrary === true) return ids;
    const declared: ElementId[] = [];
    const later: ElementId[] = [];
    let behind = false;
    for (const id of ids) {
      const el = this.elements.get(id);
      if (el !== undefined && heldLater(el)) later.push(id);
      else {
        if (later.length > 0) behind = true;
        declared.push(id);
      }
    }
    return behind ? [...declared, ...later] : ids;
  }

  /** The model is listed as it should stay until an edit adds or moves an element: a load's order, a snapshot's, or the text order. */
  private keepListedOrder(): void {
    this._orderStale = false;
    this._orderMoved = false;
    this._orderSeats.clear();
  }

  toJSON(): SerializedModel {
    return {
      formatVersion: FORMAT_VERSION,
      generator: GENERATOR_ID,
      elements: this.inSerialOrder().map((el) => structuredCloneSafe(el)),
      rootIds: this.rootIds(),
    };
  }

  static fromJSON(data: SerializedModel): Model {
    const m = new Model();
    // Insert raw, then rebuild indices (so ownerId ordering follows rootIds/owner).
    for (const el of data.elements) m.insertRaw(structuredCloneSafe(el));
    m.rebuildIndex(data.rootIds);
    return m;
  }

  /** Rebuild the containment index from scratch. */
  private rebuildIndex(rootOrder?: ElementId[]): void {
    this.childrenIndex = new Map<ElementId | null, ElementId[]>();
    this.childrenIndex.set(null, []);
    // Group by owner preserving Map insertion order of elements.
    for (const el of this.elements.values()) {
      this.indexChild(el.ownerId, el.id);
    }
    if (rootOrder) {
      const present = rootOrder.filter((id) => {
        const el = this.elements.get(id);
        return el && el.ownerId === null;
      });
      const extra = (this.childrenIndex.get(null) ?? []).filter((id) => !present.includes(id));
      this.childrenIndex.set(null, [...present, ...extra]);
    }
  }

  /** Deep-clone the entire model. */
  clone(): Model {
    return Model.fromJSON(this.toJSON());
  }

  /** Replace all contents from another serialised model and notify once. */
  reset(data?: SerializedModel): void {
    this.elements = new Map();
    this.childrenIndex = new Map();
    this.childrenIndex.set(null, []);
    this._sawLibrary = false; // rebuilt from scratch below by `insertRaw`
    if (data) {
      for (const el of data.elements) this.insertRaw(structuredCloneSafe(el));
      this.rebuildIndex(data.rootIds);
    }
    this.keepListedOrder();
    this.pending = [];
    this._rev++;
    for (const l of this.listeners) l([{ type: 'reset' }]);
  }

  /**
   * Serialise only the elements for which `keep` returns true (deep-cloned),
   * preserving root ordering and each owner's child order
   * ({@link inSerialOrder}). Used to snapshot just the *user* model for
   * undo/redo without cloning the (large, immutable) standard library on every
   * edit — see finding C6.
   */
  toJSONWhere(keep: (el: ElementRecord) => boolean): SerializedModel {
    const elements = this.inSerialOrder(keep);
    const kept = new Set<ElementId>(elements.map((el) => el.id));
    return {
      formatVersion: FORMAT_VERSION,
      generator: GENERATOR_ID,
      elements: elements.map((el) => structuredCloneSafe(el)),
      rootIds: this.rootIds().filter((id) => kept.has(id)),
    };
  }

  /**
   * Replace the elements NOT matching `preserve` with `data`'s elements; the
   * preserved elements (e.g. the standard library) stay in place. The inverse
   * of {@link toJSONWhere}: `m.resetPreserving(m.toJSONWhere(p), q)` restores a
   * user-only snapshot while keeping the library, notifying once. (C6)
   */
  resetPreserving(data: SerializedModel, preserve: (el: ElementRecord) => boolean): void {
    const keptRootIds: ElementId[] = [];
    for (const id of this.rootIds()) {
      const el = this.elements.get(id);
      if (el && preserve(el)) keptRootIds.push(id);
    }
    // Preserved records are already owned solely by this model and are about to
    // be re-inserted into freshly rebuilt maps — REUSE them (no deep clone), so
    // restoring a user-only snapshot never pays a full standard-library clone
    // (C6). `data`'s records ARE cloned: they belong to an undo-stack snapshot
    // that must stay immutable to later model mutations. Listed as a serialised
    // model lists them ({@link inSerialOrder}): the index is rebuilt from this
    // order, and a library element moved within the library would otherwise
    // come back among its siblings where it was added.
    const keptEls = this.inSerialOrder(preserve);

    this.elements = new Map();
    this.childrenIndex = new Map();
    this.childrenIndex.set(null, []);
    this._sawLibrary = false; // rebuilt from scratch below by `insertRaw`
    // Insert the restored user model FIRST, then the preserved library, and put
    // user roots ahead of library roots — matching the live boot order (user
    // sample first, library merged after) so the Explorer's root order does not
    // flip to library-first after an undo/redo/new (Fable #5).
    for (const el of data.elements) this.insertRaw(structuredCloneSafe(el));
    for (const el of keptEls) this.insertRaw(el);
    this.rebuildIndex([...data.rootIds, ...keptRootIds]);
    this.keepListedOrder();
    this.pending = [];
    this._rev++;
    for (const l of this.listeners) l([{ type: 'reset' }]);
  }
}

/**
 * Whether a load lists an element after the elements the text declares, rather
 * than where the text puts it ({@link Model.adoptSerialOrder}): a typing,
 * specialisation, subsetting or redefinition, which the parser binds once every
 * name is known — even one written as a statement, which it then moves onto
 * the element it is about — and an implicit feature, made for a connector end
 * that chains through a type.
 */
function listedLater(el: ElementRecord): boolean {
  return isSpecialization(el.eClass) || el.attrs.implicit === true;
}

/**
 * Whether an owner of the user's holds `el` after its declarations
 * ({@link Model.adoptSerialOrder}'s seat): what a load lists later
 * ({@link listedLater}), and an element of the library's, which the user's
 * text does not hold and which an edit adds without seating it.
 */
function heldLater(el: ElementRecord): boolean {
  return listedLater(el) || el.attrs.isLibrary === true;
}

/** Where the text order places an element: as the user's, listed in place or later, or as the library's. */
function placingOf(el: ElementRecord): 'library' | 'later' | 'inPlace' {
  if (el.attrs.isLibrary === true) return 'library';
  return listedLater(el) ? 'later' : 'inPlace';
}

/**
 * Merge `patch` onto `base`, DELETING any key whose patch value is `undefined`.
 * A plain spread (`{...base, ...patch}`) instead leaves `key: undefined` present,
 * which then leaks into serialization/JSON — callers could not clear an attr.
 */
function mergeAttrs(
  base: Record<string, AttrValue>,
  patch: Record<string, AttrValue | undefined>,
): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** structuredClone with a JSON fallback for environments lacking it. */
function structuredCloneSafe<T>(value: T): T {
  const sc = (globalThis as { structuredClone?: <U>(v: U) => U }).structuredClone;
  if (typeof sc === 'function') return sc(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export { isMembership };
