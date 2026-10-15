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
  isTypingSpecialization,
} from './metamodel';
import { newId } from './ids';
import { GENERATOR_ID } from '../branding';

export const FORMAT_VERSION = '0.1.0';

/** A description of a single change applied to the model. */
export interface ChangeEvent {
  type: 'add' | 'update' | 'remove' | 'reparent' | 'reset';
  id?: ElementId;
  element?: ElementRecord;
  /** For reparent: the previous owner id. */
  previousOwnerId?: ElementId | null;
}

export type ChangeListener = (events: ChangeEvent[]) => void;

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
    return this.relationshipsFrom(id)
      .filter((r) => isTypingSpecialization(r.eClass))
      .flatMap((r) => (r.target ?? []).map((t) => this.elements.get(t)).filter(Boolean) as ElementRecord[]);
  }

  /* ─────────────────────────────── Update ─────────────────────────────── */

  update(id: ElementId, patch: Partial<Omit<ElementRecord, 'id' | 'ownerId'>>): ElementRecord {
    const el = this.require(id);
    if (patch.eClass !== undefined) el.eClass = patch.eClass;
    if (patch.declaredName !== undefined) el.declaredName = patch.declaredName;
    if (patch.declaredShortName !== undefined) el.declaredShortName = patch.declaredShortName;
    if (patch.attrs !== undefined) el.attrs = mergeAttrs(el.attrs, patch.attrs);
    if (el.attrs.isLibrary === true) this._sawLibrary = true;
    if (patch.source !== undefined) el.source = [...patch.source];
    if (patch.target !== undefined) el.target = [...patch.target];
    this.emit({ type: 'update', id, element: el });
    return el;
  }

  /** Set/merge attribute values on an element. A key set to `undefined` is deleted. */
  setAttrs(id: ElementId, attrs: Record<string, AttrValue | undefined>): ElementRecord {
    const el = this.require(id);
    el.attrs = mergeAttrs(el.attrs, attrs);
    if (el.attrs.isLibrary === true) this._sawLibrary = true;
    this.emit({ type: 'update', id, element: el });
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
    el.declaredShortName = declaredShortName;
    this.emit({ type: 'update', id, element: el });
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
    this.indexChild(newOwnerId, id);
    this.emit({ type: 'reparent', id, element: el, previousOwnerId });
    return el;
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
    for (const r of this.elements.values()) {
      if (toRemove.has(r.id)) continue;
      const refs = [...(r.source ?? []), ...(r.target ?? [])];
      if (refs.length > 0 && refs.some((ref) => toRemove.has(ref))) toRemove.add(r.id);
    }
    return this.transaction(() => {
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
      return removed;
    });
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
   * List the model's own elements in {@link inSerialOrder}, so that {@link all},
   * and every index built from it — the endpoint index behind
   * {@link edgesFrom}, the order a walk finds its machines in — follows the
   * order every copy of this model is rebuilt in. The same records, re-listed:
   * nothing is copied, and no change is announced, since no element changed;
   * but the revision moves, so an index or a cache a listener of the move built
   * is built again. Returns whether anything moved.
   *
   * WHY. {@link reparent} appends the element it moves to its new owner's
   * children and leaves it where it was in `all()`. Every copy — the checks
   * worker's, an Undo snapshot, Save then reopen, a terminal over the text Save
   * writes — lists that owner's children in the order the owner holds them, so
   * the page alone decided by another order: of two transitions out of an
   * `initial`, one dragged out and back in, the page took the one added first
   * and said `holds`, where the worker and a terminal took the first in the text
   * and said `issues`; and two machines, one dragged out of their package and
   * back, were listed in one order by the page and the other by the worker
   * (review 2026-10-14 D-1).
   *
   * CALLED ONCE PER MOVE A PERSON OR A SCRIPT MAKES, not by {@link reparent}:
   * the store's drag commands (`reparent`, `reparentMany`), a regroup, the
   * SDK's `reparent`, and a collaboration room taking in a peer's move. The
   * parser reparents while it loads (see {@link inSerialOrder}), and the model
   * a terminal reads keeps the order the parse listed it in.
   *
   * What it does not give: elements of different owners stay in the order they
   * were added, as after any other edit, while a terminal reads the saved text
   * from top to bottom. So after a drag that reorders two packages, the machines
   * in them are walked in the order they were added, here and in every copy,
   * and in the text's order by a terminal (TODO.md).
   */
  adoptSerialOrder(): boolean {
    const listed = this.inSerialOrder();
    let i = 0;
    let same = true;
    for (const el of this.elements.values()) {
      if (listed[i++] !== el) {
        same = false;
        break;
      }
    }
    if (same) return false;
    this.elements = new Map(listed.map((el) => [el.id, el]));
    this._rev++;
    return true;
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
    this.pending = [];
    this._rev++;
    for (const l of this.listeners) l([{ type: 'reset' }]);
  }
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
