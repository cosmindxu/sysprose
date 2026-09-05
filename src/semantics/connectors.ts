/**
 * Connector / binding / item-flow semantics over a {@link Model}, as pure
 * functions.
 *
 * Implements the static reading of the OMG KerML/SysML v2 connection kernel
 * (Connector / BindingConnector / Succession / ItemFlow — see
 * docs/02-omg-standard-reference.md) on top of the model graph:
 *
 *  - {@link connectorEndsOf} — the connected features of a connector (its
 *    `source`/`target` endpoints, or, when absent, the referents of its end
 *    sub-features).
 *  - {@link bindingEquivalenceClasses} — the equality partition induced by every
 *    BindingConnector / `bind` / equality connector, computed with union-find.
 *  - {@link propagateValues} — full connector + binding value propagation to a
 *    fixpoint: literal feature values seed each binding equivalence class, and
 *    item flows carry a source feature's value to its target, iterated until
 *    stable. Supersedes `propagateBindings` (which remains available).
 *  - {@link itemFlowsOf} — every item/object flow with its payload and its
 *    source/target features.
 *
 * Every function is deterministic, bounded, cycle-safe, and never mutates the
 * model. This is an ORIGINAL, clean-room implementation of the standard's
 * algorithms.
 */

import { type ElementId, type ElementRecord, type Model } from '@core/index';
import { parseExpr, evaluate } from './expr';
import { dimensionalFacets } from './units-eval';
import { DIMENSIONLESS, dimEqual, resolveUnit, type Dimension } from './units';

/* ─────────────────────────── connector ends ──────────────────────────── */

/** Metaclasses that are connectors (carry two or more connected features). */
const CONNECTOR_KINDS = new Set([
  'Connector',
  'ConnectionUsage',
  'InterfaceUsage',
  'BindingConnector',
  'BindingConnectorAsUsage',
  'Flow',
  'FlowUsage',
  'SuccessionFlow',
  'ItemFlow',
  'Allocation',
]);

/** Relationship metaclasses that let an end sub-feature name its referent. */
const END_REFERENCE_KINDS = new Set(['ReferenceSubsetting', 'Subsetting', 'Redefinition']);

/**
 * The connected features of the connector `connectorId`: its `source` then
 * `target` endpoints, in order. When a connector carries no endpoint arrays
 * (its ends are modelled as child end sub-features), the referents of those
 * sub-features (via ReferenceSubsetting/Subsetting/Redefinition or an
 * `attrs.referencedFeature` id) are returned instead.
 */
export function connectorEndsOf(model: Model, connectorId: ElementId): ElementId[] {
  const c = model.get(connectorId);
  if (!c) return [];
  const ends: ElementId[] = [];
  for (const s of c.source ?? []) ends.push(s);
  for (const t of c.target ?? []) ends.push(t);
  if (ends.length > 0) return ends;

  // Fall back to end sub-features that reference the connected feature.
  for (const child of model.children(connectorId)) {
    const rf = child.attrs.referencedFeature ?? child.attrs.referent;
    if (typeof rf === 'string' && model.has(rf)) {
      ends.push(rf);
      continue;
    }
    for (const r of model.relationshipsFrom(child.id)) {
      if (!END_REFERENCE_KINDS.has(r.eClass)) continue;
      for (const target of r.target ?? []) ends.push(target);
    }
  }
  return ends;
}

/** Is `el` a connector metaclass (endpoint-bearing)? */
export function isConnector(el: ElementRecord): boolean {
  return CONNECTOR_KINDS.has(el.eClass);
}

/* ─────────────────────── binding equivalence classes ─────────────────── */

/**
 * Is `el` a binding/equality connector that forces its endpoints equal?
 * BindingConnector(AsUsage), or any connector whose kind is `bind` / `equals`
 * / `equality` (via `attrs.connectorKind` / `attrs.kind`), or one flagged
 * `attrs.bind === true`.
 */
export function isBindingEdge(el: ElementRecord): boolean {
  if (el.eClass === 'BindingConnectorAsUsage' || el.eClass === 'BindingConnector') return true;
  if (el.attrs.bind === true) return true;
  const kind = el.attrs.connectorKind ?? el.attrs.kind;
  return kind === 'bind' || kind === 'equals' || kind === 'equality';
}

/** Minimal union-find over element ids, preserving first-seen order. */
class UnionFind {
  private parent = new Map<ElementId, ElementId>();
  readonly order: ElementId[] = [];

  ensure(id: ElementId): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      this.order.push(id);
    }
  }

  find(x: ElementId): ElementId {
    this.ensure(x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = x;
    while (this.parent.get(c) !== r) {
      const nxt = this.parent.get(c)!;
      this.parent.set(c, r);
      c = nxt;
    }
    return r;
  }

  union(a: ElementId, b: ElementId): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }

  /** Members grouped by their component root, in first-seen order. */
  classes(): ElementId[][] {
    const byRoot = new Map<ElementId, ElementId[]>();
    for (const id of this.order) {
      const root = this.find(id);
      const list = byRoot.get(root);
      if (list) list.push(id);
      else byRoot.set(root, [id]);
    }
    return [...byRoot.values()];
  }
}

/** Build a union-find over every binding/equality connector in the model. */
function bindingUnionFind(model: Model): UnionFind {
  const uf = new UnionFind();
  for (const el of model.all()) {
    if (!isBindingEdge(el)) continue;
    const s = el.source?.[0];
    const t = el.target?.[0];
    if (s === undefined || t === undefined) continue;
    uf.union(s, t);
  }
  return uf;
}

/**
 * The equality partition induced by every binding/equality connector: an array
 * of equivalence classes, each a list of feature ids that the model forces to
 * hold a common value. Singleton (unconnected) features are not included.
 */
export function bindingEquivalenceClasses(model: Model): ElementId[][] {
  return bindingUnionFind(model).classes();
}

/* ───────────────────────────── item flows ────────────────────────────── */

/** Metaclasses that model an item/object flow (payload transfer). */
const ITEM_FLOW_KINDS = new Set(['ItemFlow', 'Flow', 'FlowUsage', 'SuccessionFlow']);

/** A single item/object flow: its payload plus its source and target features. */
export interface ItemFlowInfo {
  /** Element id of the flow. */
  id: ElementId;
  /** Declared name of the flow (empty when anonymous). */
  name: string;
  /** Metaclass of the flow. */
  kind: string;
  /** The payload item/type carried by the flow, if declared. */
  payload: string | undefined;
  /** Source feature id (the flow's output end), if any. */
  source: ElementId | undefined;
  /** Target feature id (the flow's input end), if any. */
  target: ElementId | undefined;
}

/** The payload item/type of a flow, read from its usual attribute slots. */
function payloadOf(el: ElementRecord): string | undefined {
  const raw =
    el.attrs.payload ?? el.attrs.item ?? el.attrs.ofPayload ?? el.attrs.payloadType ?? el.attrs.itemType;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
}

/**
 * Every item/object flow in the model with its payload and source/target
 * features. Successions that carry a payload are treated as SuccessionFlows.
 */
export function itemFlowsOf(model: Model): ItemFlowInfo[] {
  const out: ItemFlowInfo[] = [];
  for (const el of model.all()) {
    const isFlow = ITEM_FLOW_KINDS.has(el.eClass);
    // A Succession with a payload behaves as a succession flow.
    const isPayloadSuccession = el.eClass === 'Succession' && payloadOf(el) !== undefined;
    if (!isFlow && !isPayloadSuccession) continue;
    out.push({
      id: el.id,
      name: el.declaredName ?? '',
      kind: el.eClass,
      payload: payloadOf(el),
      source: el.source?.[0],
      target: el.target?.[0],
    });
  }
  return out;
}

/* ──────────────────────── full value propagation ─────────────────────── */

/**
 * Full connector + binding value propagation to a fixpoint.
 *
 * Seeds every feature that carries a literal `attrs.value` with that value,
 * then repeatedly (a) forces every binding equivalence class to share the one
 * value known in the class, and (b) carries each item flow's source value to
 * its (still-unknown) target, until nothing changes. The result maps feature
 * ids (by element id) to their propagated value; features in an undetermined
 * component are omitted.
 *
 * Supersedes `propagateBindings`: it adds directional item-flow propagation and
 * iterates connector and binding effects together to a common fixpoint.
 */
export function propagateValues(model: Model): Map<ElementId, unknown> {
  const known = new Map<ElementId, unknown>();

  // 1. Seed with literal feature values.
  for (const el of model.all()) {
    const v = literalValueOf(el);
    if (v !== undefined) known.set(el.id, v);
  }

  // 2. Pre-compute the binding equivalence partition and the item flows.
  const classes = bindingEquivalenceClasses(model);
  const flows = itemFlowsOf(model);

  // 3. Iterate binding-class seeding + directional flow propagation to a
  //    fixpoint (bounded by the number of features + flows for safety).
  let changed = true;
  let guard = known.size + classes.length + flows.length + model.size + 2;
  while (changed && guard-- > 0) {
    changed = false;

    // (a) Binding classes: propagate the single known value to every member.
    for (const members of classes) {
      let seed: unknown;
      let seedId: ElementId | undefined;
      for (const id of members) {
        if (known.has(id)) {
          seed = known.get(id);
          seedId = id;
          break;
        }
      }
      if (seed === undefined || seedId === undefined) continue;
      for (const id of members) {
        if (!known.has(id)) {
          known.set(id, convertInto(model, seedId, id, seed));
          changed = true;
        }
      }
    }

    // (b) Item flows: carry the source value forward to the target.
    for (const flow of flows) {
      if (flow.source === undefined || flow.target === undefined) continue;
      if (known.has(flow.source) && !known.has(flow.target)) {
        known.set(flow.target, known.get(flow.source));
        changed = true;
      }
    }
  }
  return known;
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

/**
 * The affine map from a feature's STORED magnitude to SI, and the dimension it
 * carries — the storage unit being its declared unit, else the coherent SI unit
 * of its declared quantity kind. `undefined` only when the feature NAMES a unit
 * the registry cannot resolve, where converting would invent a factor.
 *
 * DIMENSION ONE is a kind, not the absence of one. The ISO 80000-13
 * information units are dimension one and still carry a factor (a byte is
 * 8 bit), so a scale is returned for them too; refusing one whose dimension
 * was `DIMENSIONLESS` copied 2 bytes into a `[bit]` feature as 2 bits.
 *
 * A feature with NO kind at all — a plain `Real` sink — is dimension one with a
 * factor of 1: its magnitude IS its SI value. That is what the solver's gate
 * (c) reads it as, and what the unit-aware evaluator reads it as (`r : Real =
 * 2.0` against `2 [B]` is VIOLATED on both surfaces, 2 not being 16 bit). It is
 * returned rather than refused so this site and the solver agree; refusing it
 * left `bind cap = r` writing 2 here and 16 there, and the model NOT CONVERGED.
 * Nothing changes for a model without units: two factor-1 sides copy verbatim,
 * and a DIMENSIONED value against a kind-less one still copies, their
 * dimensions being unequal.
 */
function storageOf(
  model: Model,
  id: ElementId,
): { factor: number; offset: number; dimension: Dimension } | undefined {
  const facets = dimensionalFacets(model, id);
  if (facets.unit !== undefined) {
    const u = resolveUnit(facets.unit);
    if (!u) return undefined;
    return { factor: u.factorToSI, offset: u.offsetSI ?? 0, dimension: u.dimension };
  }
  const kind = facets.kindDimension;
  if (!kind) return { factor: 1, offset: 0, dimension: DIMENSIONLESS };
  return { factor: 1, offset: 0, dimension: kind };
}

/**
 * Carry a bound value from one feature to another, converting when BOTH sides
 * are dimensioned and their dimensions agree.
 *
 * A binding equivalence class is a statement that two features denote the same
 * quantity, not that they hold the same number: `bind a = b` with `a` in
 * kilometres and `b` a unit-less `LengthValue` (which the quantity engine reads
 * as metres) must fill `b` with 5000, not 5. When the two DIMENSIONS differ —
 * a plain `Real` sink beside a length, a boolean, a string — the value is
 * copied verbatim, which is what every model without units has always relied
 * on.
 *
 * An OFFSET (affine) scale converts like any other, and must: the solver reads
 * `bind a = b` as the equation `a − b = 0` in SI, so copying 20 °C into a
 * kelvin-storage feature as 20 is what would leave THAT equation with a
 * residual of 273.15 — and it published a kelvin constraint on the copy as
 * satisfied with 253.15 K of slack. The two sites must agree; they now do,
 * both converting.
 */
function convertInto(model: Model, fromId: ElementId, toId: ElementId, value: unknown): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  const from = storageOf(model, fromId);
  const to = storageOf(model, toId);
  if (!from || !to) return value;
  if (!dimEqual(from.dimension, to.dimension)) return value;
  if (from.factor === to.factor && from.offset === to.offset) return value;
  return (value * from.factor + from.offset - to.offset) / to.factor;
}

/** The literal value of a feature (`attrs.value`), or `undefined` if none/expr. */
function literalValueOf(feat: ElementRecord | undefined): unknown {
  if (!feat) return undefined;
  const raw = feat.attrs.value;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  // A self-contained literal expression (e.g. "5", "true") with no references.
  try {
    const r = evaluate(parseExpr(s), () => undefined);
    return 'value' in r ? r.value : undefined;
  } catch {
    return undefined;
  }
}
