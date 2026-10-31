/**
 * {@link bindModelToDoc} — a two-way, loop-safe, idempotent binding between the
 * in-memory {@link Model} (the app's single source of truth) and a Yjs
 * {@link Y.Doc} (the CRDT replicated across collaborators).
 *
 * Representation in the doc:
 *   doc.getMap('elements') : Y.Map<ElementId, Y.Map>   — one entry per element
 *   each per-element Y.Map holds:
 *     eClass             : string
 *     declaredName       : string | undefined
 *     declaredShortName  : string | undefined
 *     ownerId            : string | null
 *     attrs              : Y.Map            — nested, for FIELD-LEVEL merge
 *     source             : ElementId[] (plain JSON array) | absent
 *     target             : ElementId[] (plain JSON array) | absent
 *     order              : number | absent  — its place among its owner's children
 *
 * Child order. An owner holds its children in an order — the order the Text
 * view writes them in, and the one a composite with no `initial` and the first
 * of two transitions out of a state go by — but a Y.Map lists its keys in the
 * order they first reached that copy of the doc: a key set again keeps its first
 * place, so a reset that puts an owner's children in another order leaves them
 * where they were, and a peer that joins receives them grouped by the peer that
 * wrote them. So each element carries `order`, its place among its owner's
 * children (the top level's, for a root). An owner of the standard library's
 * gives its children none until one is moved into it, or added to it by other
 * than the batch that made the owner: every peer loads the library in one
 * order, one batch at a time, and places on all of it would add about 7% to a
 * document that holds it (the relay takes one message of at most 64 MiB); a
 * peer holds the children of such an owner in the order its copy of the doc
 * lists them, the library's load order on every copy ({@link holdPlaces}). An
 * edit that adds an element to an owner, or moves one into it, gives it the
 * place after the highest its new siblings hold, as the model holds it last —
 * once each of them holds a place: when one holds none (the library's, or one
 * a doc an earlier build wrote holds), each first takes the place it holds in
 * the model. The library loading — an element of the library's added to an
 * owner of the library's the same batch made — takes none. A reset gives each
 * owner's children the places 0, 1, 2… in the order the model holds them — an
 * owner of the library's only when its children held places before, or the
 * reset moves one into it ({@link libraryOwnersPlaced}) — and so does an
 * `order` change of the model's: a seat of an owner's declarations before what
 * a load lists later and the library's ({@link Model.adoptSerialOrder}), or a
 * change of kind or of library flag that moves an element between the two. So
 * an owner's children hold places all or none, and the order of their places
 * is the order the peer who made the edit holds them in. A peer holds the
 * children of every owner a doc transaction added to, moved into, re-placed
 * or changed the kind or library flag of a child of, in the order of their
 * places, two equal places by id, its declarations seated as the edit seated
 * them ({@link Model.orderChildren}); a peer that joins loads every owner so.
 * Two peers that add to one owner at once give equal places, and every peer
 * orders them alike, a member whose kind one changed at that moment too.
 *
 * Containment. Two peers who each move one of two elements into the other at
 * once leave the doc holding each under the other. Every peer, a peer that
 * joins and a model bound to such a doc read the member of the lowest id of the
 * cycle at the top level ({@link docOwners}), and write that into the doc
 * ({@link breakCycles}), so a later edit of either leaves the peers alike.
 *
 * An owner removed while its children stay (`Model.remove` with `cascade: false`) leaves them
 * under an owner nobody has: the peer that removed it moves them to the top level
 * ({@link orphanedBy}), where every other peer reads them ({@link docOwners}); so does a model that
 * already holds such a child when it seeds the doc or is reset.
 *
 * Flow:
 *   local model change  → doc.transact(fn, ORIGIN_LOCAL)   (minimal ops)
 *   remote doc change   → model.transaction(fn) under an `applyingRemote`
 *                         guard so the model's own emitted events are NOT
 *                         written back to the doc (prevents echo loops).
 *
 * This file is BROWSER-SAFE: it imports only `yjs`. It never touches `ws` or
 * any y-websocket server code.
 */

import * as Y from 'yjs';
import type { Model, ChangeEvent } from '../core/model';
import type { AttrValue, ElementId, ElementRecord } from '../core/metamodel';

/** Transaction origin tag marking doc writes that originate from the local model. */
export const ORIGIN_LOCAL = Symbol('sysml-collab-local');

/** The handle returned by {@link bindModelToDoc}. */
export interface ModelDocBinding {
  /** Tear down the binding (unsubscribe both directions). */
  unbind(): void;
}

const ELEMENTS_KEY = 'elements';
/** The per-element key that holds its place among its owner's children (the header's "Child order"). */
const PLACE_KEY = 'order';

/**
 * Whether a doc written whole — a seed, a reset — gives `el` a place: every
 * element but one under an owner of the standard library's, unless `kept`
 * names that owner ({@link libraryOwnersPlaced}).
 */
function carriesPlace(model: Model, el: ElementRecord, kept?: ReadonlySet<ElementId>): boolean {
  if (el.ownerId === null || kept?.has(el.ownerId) === true) return true;
  return model.get(el.ownerId)?.attrs.isLibrary !== true;
}

/**
 * The owners of the library's a reset to `model` gives places to under
 * ({@link carriesPlace}), read from the doc before the reset: one whose
 * children held places; one the reset moves an element into, or puts back an
 * element the doc held once — every copy of the doc lists a key it held where
 * it first listed it; and one it gives a new child ahead of one it held. A
 * peer present takes such a child in last, or where its copy of the doc
 * lists it, which need not be where the model holds it. The children of any
 * other owner of the library's — none new, or all new, which reach every copy
 * of the doc in the order the model holds them — are held in the order the
 * doc lists them, on every peer ({@link holdPlaces}).
 */
function libraryOwnersPlaced(model: Model, elements: Y.Map<ElementYMap>): Set<ElementId> {
  const kept = new Set<ElementId>();
  const ownerOf = new Map<ElementId, ElementId | null>();
  for (const [id, ym] of elements.entries()) {
    const ownerId = (ym.get('ownerId') as ElementId | null | undefined) ?? null;
    ownerOf.set(id, ownerId);
    if (ownerId !== null && typeof ym.get(PLACE_KEY) === 'number') kept.add(ownerId);
  }
  for (const owner of model.all()) {
    if (owner.attrs.isLibrary !== true || kept.has(owner.id)) continue;
    let added = false;
    for (const id of model.childIds(owner.id)) {
      const was = ownerOf.get(id);
      // A key the doc holds no longer, but held once (a Y.Map keeps a removed key's last entry), counts as moved.
      if (was === undefined && !elements._map.has(id)) added = true;
      else if (was !== owner.id || added) {
        kept.add(owner.id);
        break;
      }
    }
  }
  return kept;
}

/** Each element's position in the order this copy of the doc lists its keys. */
function keyOrder(elements: Y.Map<ElementYMap>): Map<ElementId, number> {
  const at = new Map<ElementId, number>();
  for (const id of elements.keys()) at.set(id, at.size);
  return at;
}

/**
 * What one batch of local changes has placed, per owner: the place the next
 * child added to it takes, or that its children hold none and keep none (an
 * owner of the library's, loading); and the elements it added.
 */
interface Placing {
  next: Map<ElementId | null, number>;
  bare: Set<ElementId | null>;
  made: Set<ElementId>;
}

type ElementYMap = Y.Map<unknown>;

/** JSON-equality for attr / endpoint values (handles arrays & objects). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Read a per-element Y.Map into a plain {@link ElementRecord}. */
function readRecord(id: ElementId, ym: ElementYMap): ElementRecord {
  const attrsY = ym.get('attrs');
  const attrs: Record<string, AttrValue> = {};
  if (attrsY instanceof Y.Map) {
    for (const [k, v] of attrsY.entries()) attrs[k] = v as AttrValue;
  }
  const rec: ElementRecord = {
    id,
    eClass: (ym.get('eClass') as string) ?? '',
    declaredName: ym.get('declaredName') as string | undefined,
    declaredShortName: ym.get('declaredShortName') as string | undefined,
    ownerId: (ym.get('ownerId') as ElementId | null) ?? null,
    attrs,
  };
  const source = ym.get('source') as ElementId[] | undefined;
  const target = ym.get('target') as ElementId[] | undefined;
  if (Array.isArray(source)) rec.source = [...source];
  if (Array.isArray(target)) rec.target = [...target];
  return rec;
}

/** Build (or patch) a per-element Y.Map from an {@link ElementRecord}. */
function writeRecordInto(ym: ElementYMap, el: ElementRecord): void {
  if (!sameValue(ym.get('eClass'), el.eClass)) ym.set('eClass', el.eClass);
  if (!sameValue(ym.get('declaredName'), el.declaredName)) {
    ym.set('declaredName', el.declaredName);
  }
  if (!sameValue(ym.get('declaredShortName'), el.declaredShortName)) {
    ym.set('declaredShortName', el.declaredShortName);
  }
  if (!sameValue(ym.get('ownerId'), el.ownerId)) ym.set('ownerId', el.ownerId ?? null);

  // attrs → nested Y.Map with per-key writes (field-level merge).
  let attrsY = ym.get('attrs');
  if (!(attrsY instanceof Y.Map)) {
    attrsY = new Y.Map();
    ym.set('attrs', attrsY);
  }
  const attrsMap = attrsY as Y.Map<unknown>;
  const nextAttrs = el.attrs ?? {};
  for (const [k, v] of Object.entries(nextAttrs)) {
    if (!sameValue(attrsMap.get(k), v)) attrsMap.set(k, v as unknown);
  }
  for (const k of [...attrsMap.keys()]) {
    if (!(k in nextAttrs)) attrsMap.delete(k);
  }

  // source / target as whole JSON arrays (whole-array replace semantics).
  if (el.source !== undefined) {
    if (!sameValue(ym.get('source'), el.source)) ym.set('source', [...el.source]);
  } else if (ym.has('source')) {
    ym.delete('source');
  }
  if (el.target !== undefined) {
    if (!sameValue(ym.get('target'), el.target)) ym.set('target', [...el.target]);
  } else if (ym.has('target')) {
    ym.delete('target');
  }
}

export function bindModelToDoc(model: Model, doc: Y.Doc): ModelDocBinding {
  const elements = doc.getMap<ElementYMap>(ELEMENTS_KEY);

  /** Guard: while true, model-emitted events are NOT mirrored back to the doc. */
  let applyingRemote = false;

  /* ───────────────────────── Initial synchronisation ──────────────────── */

  if (elements.size === 0 && model.size > 0) {
    // Doc is empty → seed it from the model. A child whose owner the model no longer has (an SDK
    // `delete(id, { cascade: false })` before joining) is read at the top level by every joiner: so is it here.
    const dangling = orphanedBy(model, [{ type: 'reset' }]);
    if (dangling.length > 0) model.transaction(() => dangling.forEach((id) => model.reparent(id, null)));
    doc.transact(() => {
      seedDocFromModel(model, elements);
    }, ORIGIN_LOCAL);
  } else if (elements.size > 0) {
    // Doc already has content → load the model from the doc.
    applyingRemote = true;
    const { owner, broken } = docOwners(elements);
    try {
      model.reset(serializeFromDoc(elements, owner));
      // The doc lists the elements in the order they reached it, not the order
      // their text gives them: list the model as the peers present at those
      // edits list theirs (`Model.adoptSerialOrder`, D-1).
      model.adoptSerialOrder({ whole: true });
    } finally {
      applyingRemote = false;
    }
    breakCycles(doc, elements, broken);
  }

  /* ─────────────────────── Local model → Y.Doc (write) ─────────────────── */

  const unsubModel = model.subscribe((events: ChangeEvent[]) => {
    if (applyingRemote) return; // echo guard: don't write remote-applied changes back
    const placing: Placing = { next: new Map(), bare: new Set(), made: new Set() };
    doc.transact(() => {
      for (const ev of events) applyLocalEvent(model, elements, ev, placing);
    }, ORIGIN_LOCAL);
    // A removal that kept the owner's children (`cascade: false`) leaves them under an owner no peer
    // has; every peer reads them at the top level, so this model does too, and the doc says so.
    // The move is a nested transaction: a listener subscribed after this one is told of it before the removal.
    // Removed and made again in one transaction, the owner has the id but not the child: the child is moved too.
    const orphans = orphanedBy(model, events);
    if (orphans.length > 0) model.transaction(() => orphans.forEach((id) => model.reparent(id, null)));
  });

  /* ─────────────────────── Y.Doc → local model (read) ──────────────────── */

  const observer = (events: Y.YEvent<any>[], txn: Y.Transaction) => {
    if (txn.origin === ORIGIN_LOCAL) return; // our own write — ignore
    const placed = placedBy(events, elements);
    applyingRemote = true;
    // The reading of the owners changes only with an owner or the set of elements
    // (a cycle can arise in no other transaction): a rename or an attribute edit,
    // the common remote edit, reads each owner as the doc holds it, without the scan.
    const { owner, broken } = ownersTouched(events, elements) ? docOwners(elements) : { owner: undefined, broken: [] };
    try {
      model.transaction(() => {
        for (const id of reconcileModelFromDoc(model, elements, owner)) placed.add(id);
        // Each owner the peer's edit added to, moved into or re-placed holds its
        // children as that peer holds them (the header's "Child order").
        holdPlaces(model, elements, placed);
        // A peer's drag, or an element a peer added, lists this model in the
        // order its text gives it, as an edit made here does: as its Undo, Save
        // and checks worker rebuild it, and a terminal over the text it saves
        // reads it (`Model.adoptSerialOrder`, D-1). Free when the peer's edit
        // added and moved nothing.
        model.adoptSerialOrder();
      });
    } finally {
      applyingRemote = false;
    }
    breakCycles(doc, elements, broken);
  };
  elements.observeDeep(observer);

  return {
    unbind() {
      unsubModel();
      elements.unobserveDeep(observer);
    },
  };
}

/* ─────────────────────────────── Helpers ──────────────────────────────── */

function seedDocFromModel(model: Model, elements: Y.Map<ElementYMap>, kept?: ReadonlySet<ElementId>): void {
  const places = placesIn(model);
  for (const el of model.all()) {
    const ym = new Y.Map() as ElementYMap;
    elements.set(el.id, ym);
    writeRecordInto(ym, el);
    const place = places.get(el.id);
    if (place !== undefined && carriesPlace(model, el, kept)) ym.set(PLACE_KEY, place);
  }
}

/** Each element's place among its owner's children (the top level's, for a root), as the model holds them. */
function placesIn(model: Model): Map<ElementId, number> {
  const places = new Map<ElementId, number>();
  model.rootIds().forEach((id, i) => places.set(id, i));
  for (const el of model.all()) model.childIds(el.id).forEach((id, i) => places.set(id, i));
  return places;
}

/** An element's place among its owner's children, or undefined when the doc gives it none (an owner of the library's, {@link carriesPlace}, or a doc an earlier build wrote). */
function placeOf(elements: Y.Map<ElementYMap>, id: ElementId): number | undefined {
  const ym = elements.get(id);
  const place = ym instanceof Y.Map ? ym.get(PLACE_KEY) : undefined;
  return typeof place === 'number' ? place : undefined;
}

/**
 * `ids`, children of one owner, in the order of their places: ascending, two
 * equal places — two peers that added at once — by id, so on every peer alike.
 * One with no place goes after those with one — an owner's children hold
 * places all or none, but where a peer of an earlier build, which writes none,
 * added one last, or where the library loads into an owner of its own at the
 * moment another peer moves an element into it — and two with none in the
 * order `keyAt` gives them, or else where `ids` has them.
 */
function byPlace(elements: Y.Map<ElementYMap>, ids: readonly ElementId[], keyAt?: ReadonlyMap<ElementId, number>): ElementId[] {
  const placed = ids.map((id) => ({ id, place: placeOf(elements, id) }));
  placed.sort((a, b) => {
    if (a.place === undefined || b.place === undefined) {
      if (a.place !== b.place) return a.place === undefined ? 1 : -1;
      return keyAt === undefined ? 0 : (keyAt.get(a.id) ?? 0) - (keyAt.get(b.id) ?? 0);
    }
    return a.place - b.place || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return placed.map((p) => p.id);
}

/** Give each child of `ownerId` the doc holds the place it holds in the model. */
function placeAll(model: Model, elements: Y.Map<ElementYMap>, ownerId: ElementId | null): void {
  model.childIds(ownerId).forEach((id, place) => {
    const ym = elements.get(id);
    if (ym instanceof Y.Map && ym.get(PLACE_KEY) !== place) ym.set(PLACE_KEY, place);
  });
}

/**
 * Place `el`, just added to its owner or moved into it (`moved`), as the model
 * holds it: last among its siblings (the header's "Child order"). The first
 * time this batch places a child of that owner, a sibling the doc holds with
 * no place — the library's, or one a doc an earlier build wrote holds — first
 * has every child take the place it holds. But the library loading — an
 * element of the library's added to an owner of the library's this batch made
 * — takes none, and that owner's children stay so for the rest of the batch:
 * one peer writes them all, in one batch, so every copy of the doc lists them
 * in the order this model holds them, the order a peer that holds none of
 * their places holds them in ({@link holdPlaces}).
 */
function placeIn(
  model: Model,
  elements: Y.Map<ElementYMap>,
  el: ElementRecord,
  ym: ElementYMap,
  moved: boolean,
  placing: Placing,
): void {
  const ownerId = el.ownerId;
  const { next, bare } = placing;
  let place = next.get(ownerId);
  if (place === undefined && bare.has(ownerId) && (moved || el.attrs.isLibrary !== true)) bare.delete(ownerId);
  else if (place === undefined && bare.has(ownerId)) {
    if (ym.has(PLACE_KEY)) ym.delete(PLACE_KEY);
    return;
  }
  if (place === undefined) {
    place = 0;
    let unplaced = false;
    let held = false;
    for (const id of model.childIds(ownerId)) {
      if (id === el.id || !elements.has(id)) continue;
      const at = placeOf(elements, id);
      if (at === undefined) unplaced = true;
      else {
        held = true;
        if (at >= place) place = at + 1;
      }
    }
    const libraryOwner = ownerId !== null && model.get(ownerId)?.attrs.isLibrary === true;
    if (libraryOwner && !held && !moved && el.attrs.isLibrary === true && placing.made.has(ownerId)) {
      // The library loading into an owner of its own: no place, and none for the rest of the batch.
      bare.add(ownerId);
      if (ym.has(PLACE_KEY)) ym.delete(PLACE_KEY);
      return;
    }
    if (unplaced || (libraryOwner && !held)) {
      placeAll(model, elements, ownerId);
      next.set(ownerId, model.childIds(ownerId).length);
      return;
    }
  }
  next.set(ownerId, place + 1);
  ym.set(PLACE_KEY, place);
}

/**
 * The owner each element of the doc stands under, as every peer reads it. An
 * owner the doc lacks (one peer removed it while another added to it or moved
 * an element into it) reads as the top level. Elements the doc holds in each
 * other (two peers who each moved one of two elements into the other at once,
 * or one into itself) read with the member of the lowest id at the top level and
 * the rest in the chain under it, on every peer, on a join, and on a model bound
 * to a doc that holds them: no peer's own refusal decides which. `broken` lists
 * those members: {@link breakCycles} writes the reading into the doc.
 */
function docOwners(elements: Y.Map<ElementYMap>): { owner: Map<ElementId, ElementId | null>; broken: ElementId[] } {
  const owner = new Map<ElementId, ElementId | null>();
  for (const [id, ym] of elements.entries()) {
    const ownerId = (ym.get('ownerId') as ElementId | null | undefined) ?? null;
    owner.set(id, ownerId !== null && !elements.has(ownerId) ? null : ownerId);
  }
  const broken: ElementId[] = [];
  const onPath = new Set<ElementId>();
  const done = new Set<ElementId>();
  for (const start of owner.keys()) {
    const path: ElementId[] = [];
    let cur: ElementId | null = start;
    while (cur !== null && !done.has(cur) && !onPath.has(cur)) {
      onPath.add(cur);
      path.push(cur);
      cur = owner.get(cur) ?? null;
    }
    if (cur !== null && onPath.has(cur)) {
      const cycle = path.slice(path.indexOf(cur));
      const lowest = cycle.reduce((low, id) => (id < low ? id : low));
      owner.set(lowest, null);
      broken.push(lowest);
    }
    for (const id of path) {
      onPath.delete(id);
      done.add(id);
    }
  }
  return { owner, broken };
}

/**
 * The elements still in `model` whose owner is gone: one a `remove` of `events` took away (the removal did not
 * cascade; an owner removed and made again keeps the id, so only the removed ids count), or any owner a `reset`
 * snapshot lacks (Open, Undo, Import of a model that already holds such a child).
 */
function orphanedBy(model: Model, events: readonly ChangeEvent[]): ElementId[] {
  let gone: Set<ElementId> | undefined;
  let reset = false;
  for (const ev of events) {
    if (ev.type === 'reset') reset = true;
    else if (ev.type === 'remove' && ev.id !== undefined) (gone ??= new Set()).add(ev.id);
  }
  if (gone === undefined && !reset) return [];
  return model
    .all()
    .filter((e) => e.ownerId !== null && (reset ? !model.has(e.ownerId) : gone!.has(e.ownerId)))
    .map((e) => e.id);
}

/** Whether a doc transaction added, replaced or removed an element, or wrote an element's owner: the only edits that change the reading of {@link docOwners}. */
function ownersTouched(events: Y.YEvent<any>[], elements: Y.Map<ElementYMap>): boolean {
  for (const ev of events) {
    if (!(ev instanceof Y.YMapEvent)) continue;
    if (ev.target === elements ? ev.keysChanged.size > 0 : ev.target.parent === elements && ev.keysChanged.has('ownerId')) return true;
  }
  return false;
}

/**
 * Write the reading of {@link docOwners} into the doc: the member of lowest id
 * of each cycle at the top level. Every peer that sees the cycle writes the same
 * value, so the writes merge; and a peer's own move of either element, made
 * while the doc holds the cycle, no longer changes how the other reads.
 */
function breakCycles(doc: Y.Doc, elements: Y.Map<ElementYMap>, broken: readonly ElementId[]): void {
  if (broken.length === 0) return;
  doc.transact(() => {
    for (const id of broken) elements.get(id)?.set('ownerId', null);
  }, ORIGIN_LOCAL);
}

function serializeFromDoc(elements: Y.Map<ElementYMap>, owners: ReadonlyMap<ElementId, ElementId | null>) {
  const records: ElementRecord[] = [];
  // Where in `records` each owner's children are (the top level's under `null`), in the doc's order.
  const at = new Map<ElementId | null, number[]>();
  for (const [id, ym] of elements.entries()) {
    const rec = readRecord(id, ym);
    // An owner the doc lacks, or one of two elements it holds in each other: at the top level, as a peer present holds it.
    rec.ownerId = owners.get(id) ?? null;
    const mine = at.get(rec.ownerId);
    if (mine) mine.push(records.length);
    else at.set(rec.ownerId, [records.length]);
    records.push(rec);
  }
  // Each owner's children in the order of their places, among the places they hold in `records`:
  // `Model.reset` holds an owner's children in the order the records list them.
  for (const places of at.values()) {
    if (places.length < 2) continue;
    const byId = new Map(places.map((i) => [records[i].id, records[i]] as const));
    byPlace(elements, [...byId.keys()]).forEach((id, n) => {
      records[places[n]] = byId.get(id)!;
    });
  }
  const rootIds = records.filter((r) => r.ownerId === null).map((r) => r.id);
  return { formatVersion: '0.1.0', elements: records, rootIds };
}

function applyLocalEvent(model: Model, elements: Y.Map<ElementYMap>, ev: ChangeEvent, placing: Placing): void {
  switch (ev.type) {
    case 'reset': {
      const kept = libraryOwnersPlaced(model, elements);
      elements.clear();
      seedDocFromModel(model, elements, kept);
      placing.next.clear();
      placing.bare.clear();
      return;
    }
    case 'remove': {
      if (ev.id !== undefined && elements.has(ev.id)) elements.delete(ev.id);
      return;
    }
    case 'order': {
      // Held in another order: each child takes the place it now holds — an owner of the library's too.
      const ownerId = ev.ownerId ?? null;
      placeAll(model, elements, ownerId);
      placing.next.delete(ownerId);
      placing.bare.delete(ownerId);
      return;
    }
    case 'add':
    case 'update':
    case 'reparent': {
      const el = ev.element ?? (ev.id !== undefined ? model.get(ev.id) : undefined);
      if (!el) return;
      let ym = elements.get(el.id);
      if (!(ym instanceof Y.Map)) {
        ym = new Y.Map() as ElementYMap;
        elements.set(el.id, ym);
      }
      writeRecordInto(ym, el);
      // Added to its owner, or moved into one: the model holds it last among the owner's children.
      if (ev.type !== 'update') placeIn(model, elements, el, ym, ev.type === 'reparent', placing);
      if (ev.type === 'add') placing.made.add(el.id);
      return;
    }
  }
}

/**
 * The elements a doc transaction added, replaced, moved or re-placed, or whose
 * kind or library flag it changed: the owners they stand in may hold their
 * children in another order. A Y.Map made in the transaction reports nothing
 * of its own; its key in `elements` does. A kind or flag decides where an
 * owner seats the element ({@link Model.orderChildren}), and the peer who
 * changed it may send the places it gives in a doc transaction of their own,
 * which this peer takes in under the old kind (`Model.update` and `setAttrs`
 * announce the owner's `order` before the `update`): the owner is held again
 * under the new one.
 */
function placedBy(events: Y.YEvent<any>[], elements: Y.Map<ElementYMap>): Set<ElementId> {
  const ids = new Set<ElementId>();
  for (const ev of events) {
    if (!(ev instanceof Y.YMapEvent)) continue;
    if (ev.target === elements) {
      for (const id of ev.keysChanged) ids.add(id);
    } else if (ev.target.parent === elements) {
      const keys = ev.keysChanged;
      if (keys.has('ownerId') || keys.has(PLACE_KEY) || keys.has('eClass')) ids.add(ev.path[0] as ElementId);
    } else if (ev.target.parent?.parent === elements) {
      // An element's nested `attrs`: an implicit feature, or one of the library's, is seated after the declarations.
      if (ev.keysChanged.has('implicit') || ev.keysChanged.has('isLibrary')) ids.add(ev.path[0] as ElementId);
    }
  }
  return ids;
}

/**
 * Hold the children of every owner one of `placed` stands in, in the order of
 * their places. The children of an owner of the library's that hold none are
 * held in the order this copy of the doc lists them — the library's load order
 * on every peer, where every peer adds what the library loads later — not
 * where this peer took in a move into it last: a reset that put a member back
 * where it was, at the moment this peer moved it out, does so on every peer.
 */
function holdPlaces(model: Model, elements: Y.Map<ElementYMap>, placed: ReadonlySet<ElementId>): void {
  const owners = new Set<ElementId | null>();
  for (const id of placed) {
    const el = model.get(id);
    if (el !== undefined) owners.add(el.ownerId);
  }
  let keyAt: Map<ElementId, number> | undefined;
  for (const ownerId of owners) {
    const ids = model.childIds(ownerId);
    if (ids.length < 2) continue;
    const bare = ownerId !== null && model.get(ownerId)?.attrs.isLibrary === true && ids.some((id) => placeOf(elements, id) === undefined);
    if (bare) keyAt ??= keyOrder(elements);
    model.orderChildren(ownerId, byPlace(elements, ids, bare ? keyAt : undefined));
  }
}

/**
 * Reconcile the model to match the doc's element set. Idempotent & deterministic:
 * removes elements gone from the doc, creates missing ones (owners first), and
 * patches changed fields / ownership on the rest. Returns the elements it
 * created or moved: the owners they stand in may now hold their children in
 * another order.
 */
function reconcileModelFromDoc(model: Model, elements: Y.Map<ElementYMap>, owners?: ReadonlyMap<ElementId, ElementId | null>): Set<ElementId> {
  const docIds = new Set<ElementId>(elements.keys());
  const moved = new Set<ElementId>();
  // An element whose owner the doc lacks — one peer removed the owner while
  // another added to it or moved an element into it — stands at the top level,
  // on every peer alike, and goes back under that owner should the doc hold it
  // again (a third peer's reset). So does the lowest of two elements the doc
  // holds in each other ({@link docOwners}), given as `owners` (left out, when the
  // transaction changed no owner and no element: each reads as the doc holds it).
  const ownerIn = (rec: ElementRecord): ElementId | null =>
    owners !== undefined ? (owners.get(rec.id) ?? null) : rec.ownerId !== null && !docIds.has(rec.ownerId) ? null : rec.ownerId;

  // 1) Removals — anything in the model but no longer in the doc. A child the
  //    doc still holds goes to the top level in 3), its owner gone.
  for (const el of model.all()) {
    if (!docIds.has(el.id) && model.has(el.id)) model.remove(el.id, { cascade: false });
  }

  // 2) Creations — owners before children (repeat until settled), each in the
  //    doc's order: a peer's batch reaches it in the order the peer made it.
  let pending: Array<[ElementId, ElementRecord]> = [];
  for (const [id, ym] of elements.entries()) {
    if (!model.has(id)) {
      const rec = readRecord(id, ym);
      rec.ownerId = ownerIn(rec);
      pending.push([id, rec]);
    }
  }
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    const waiting: Array<[ElementId, ElementRecord]> = [];
    for (const [id, rec] of pending) {
      if (rec.ownerId !== null && !model.has(rec.ownerId)) {
        waiting.push([id, rec]); // owner not ready yet
        continue;
      }
      model.create(rec.eClass, {
        id,
        declaredName: rec.declaredName,
        declaredShortName: rec.declaredShortName,
        ownerId: rec.ownerId,
        attrs: rec.attrs,
        source: rec.source,
        target: rec.target,
      });
      moved.add(id);
      progressed = true;
    }
    pending = waiting;
  }

  // 3) Updates + reparents — patch existing elements to match the doc. A move
  //    the model refuses — one that would hold an element under its own
  //    descendant — waits, and is tried again once the others have moved: a
  //    reset that swaps two elements' nesting (an Undo of a drag) moves both.
  let refused: ElementId[] = [];
  for (const [id, ym] of elements.entries()) {
    const cur = model.get(id);
    if (!cur) continue;
    const rec = readRecord(id, ym);

    if (cur.ownerId !== ownerIn(rec)) {
      try {
        model.reparent(id, ownerIn(rec));
        moved.add(id);
      } catch {
        refused.push(id);
      }
    }

    const patch: Partial<Omit<ElementRecord, 'id' | 'ownerId'>> = {};
    if (cur.eClass !== rec.eClass) patch.eClass = rec.eClass;
    if (cur.declaredName !== rec.declaredName) patch.declaredName = rec.declaredName;
    if (cur.declaredShortName !== rec.declaredShortName) {
      patch.declaredShortName = rec.declaredShortName;
    }
    if (!sameValue(cur.source, rec.source) && rec.source !== undefined) patch.source = rec.source;
    if (!sameValue(cur.target, rec.target) && rec.target !== undefined) patch.target = rec.target;

    // attrs: apply added/changed keys, then drop keys removed remotely.
    const attrPatch: Record<string, AttrValue> = {};
    let attrsChanged = false;
    for (const [k, v] of Object.entries(rec.attrs)) {
      if (!sameValue(cur.attrs[k], v)) {
        attrPatch[k] = v;
        attrsChanged = true;
      }
    }
    const removedKeys = Object.keys(cur.attrs).filter((k) => !(k in rec.attrs));

    if (Object.keys(patch).length > 0) model.update(id, patch);
    if (attrsChanged) model.setAttrs(id, attrPatch);
    if (removedKeys.length > 0) {
      // Rebuild attrs without the removed keys (Model.update merges, so replace).
      const next = { ...cur.attrs };
      for (const k of removedKeys) delete next[k];
      const el = model.get(id);
      if (el) el.attrs = next;
    }
  }
  for (let progressed = true; progressed && refused.length > 0; ) {
    progressed = false;
    const still: ElementId[] = [];
    for (const id of refused) {
      const ym = elements.get(id);
      if (!(ym instanceof Y.Map)) continue;
      try {
        model.reparent(id, ownerIn(readRecord(id, ym)));
        moved.add(id);
        progressed = true;
      } catch {
        still.push(id); // waits for another element's move
      }
    }
    refused = still;
  }
  return moved;
}
