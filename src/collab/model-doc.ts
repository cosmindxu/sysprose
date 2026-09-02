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
    // Doc is empty → seed it from the model.
    doc.transact(() => {
      seedDocFromModel(model, elements);
    }, ORIGIN_LOCAL);
  } else if (elements.size > 0) {
    // Doc already has content → load the model from the doc.
    applyingRemote = true;
    try {
      model.reset(serializeFromDoc(elements));
    } finally {
      applyingRemote = false;
    }
  }

  /* ─────────────────────── Local model → Y.Doc (write) ─────────────────── */

  const unsubModel = model.subscribe((events: ChangeEvent[]) => {
    if (applyingRemote) return; // echo guard: don't write remote-applied changes back
    doc.transact(() => {
      for (const ev of events) applyLocalEvent(model, elements, ev);
    }, ORIGIN_LOCAL);
  });

  /* ─────────────────────── Y.Doc → local model (read) ──────────────────── */

  const observer = (_events: Y.YEvent<any>[], txn: Y.Transaction) => {
    if (txn.origin === ORIGIN_LOCAL) return; // our own write — ignore
    applyingRemote = true;
    try {
      model.transaction(() => {
        reconcileModelFromDoc(model, elements);
      });
    } finally {
      applyingRemote = false;
    }
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

function seedDocFromModel(model: Model, elements: Y.Map<ElementYMap>): void {
  for (const el of model.all()) {
    const ym = new Y.Map() as ElementYMap;
    elements.set(el.id, ym);
    writeRecordInto(ym, el);
  }
}

function serializeFromDoc(elements: Y.Map<ElementYMap>) {
  const records: ElementRecord[] = [];
  for (const [id, ym] of elements.entries()) records.push(readRecord(id, ym));
  const rootIds = records.filter((r) => r.ownerId === null).map((r) => r.id);
  return { formatVersion: '0.1.0', elements: records, rootIds };
}

function applyLocalEvent(model: Model, elements: Y.Map<ElementYMap>, ev: ChangeEvent): void {
  switch (ev.type) {
    case 'reset': {
      elements.clear();
      seedDocFromModel(model, elements);
      return;
    }
    case 'remove': {
      if (ev.id !== undefined && elements.has(ev.id)) elements.delete(ev.id);
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
      return;
    }
  }
}

/**
 * Reconcile the model to match the doc's element set. Idempotent & deterministic:
 * removes elements gone from the doc, creates missing ones (owners first), and
 * patches changed fields / ownership on the rest.
 */
function reconcileModelFromDoc(model: Model, elements: Y.Map<ElementYMap>): void {
  const docIds = new Set<ElementId>(elements.keys());

  // 1) Removals — anything in the model but no longer in the doc.
  for (const el of model.all()) {
    if (!docIds.has(el.id) && model.has(el.id)) model.remove(el.id, { cascade: false });
  }

  // 2) Creations — owners before children (repeat until settled).
  const pending: Array<[ElementId, ElementRecord]> = [];
  for (const [id, ym] of elements.entries()) {
    if (!model.has(id)) pending.push([id, readRecord(id, ym)]);
  }
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const [id, rec] = pending[i];
      if (rec.ownerId !== null && !model.has(rec.ownerId)) continue; // owner not ready yet
      model.create(rec.eClass, {
        id,
        declaredName: rec.declaredName,
        declaredShortName: rec.declaredShortName,
        ownerId: rec.ownerId,
        attrs: rec.attrs,
        source: rec.source,
        target: rec.target,
      });
      pending.splice(i, 1);
      progressed = true;
    }
  }
  // Fallback for any orphans (missing owner in doc): create at root.
  for (const [id, rec] of pending) {
    if (model.has(id)) continue;
    model.create(rec.eClass, {
      id,
      declaredName: rec.declaredName,
      declaredShortName: rec.declaredShortName,
      ownerId: null,
      attrs: rec.attrs,
      source: rec.source,
      target: rec.target,
    });
  }

  // 3) Updates + reparents — patch existing elements to match the doc.
  for (const [id, ym] of elements.entries()) {
    const cur = model.get(id);
    if (!cur) continue;
    const rec = readRecord(id, ym);

    if (cur.ownerId !== rec.ownerId) {
      try {
        model.reparent(id, rec.ownerId);
      } catch {
        /* ignore transient cycle/ordering during convergence */
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
}
