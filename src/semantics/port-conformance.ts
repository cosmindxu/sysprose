/**
 * Port conformance, connection-end conformance and flow ends — the readings the
 * interface rules (`rules-connection.ts`) and the interface reports share.
 *
 * NORMATIVE BASIS.
 *  - SysML v2 §7.12.1: "A feature of a port may be directed … Two features match
 *    if they have conforming definitions and either both have no direction or
 *    they have conjugate directions. The conjugate of direction in is out and
 *    vice versa, while direction inout is its own conjugate. A transfer can occur
 *    from the out features of one port usage to the matching in features of
 *    connected port usages. … Two ports are said to conform if each feature of
 *    one port has a matching feature on the other port."
 *  - §7.12.3: a conjugated port definition has the same features "except that any
 *    directed features have conjugated directions".
 *  - §7.12.2: "A port usage must only be defined by port definitions."
 *  - KerML §7.4.6.1: each connector end redefines the end of the association that
 *    types the connector, and the links are "restricted to those that link things
 *    classified by the types of its association ends". KerML classifiers are not
 *    disjoint unless declared so, so an end whose related feature does not
 *    conform is not a contradiction: the connection can only link something that
 *    is both. The rules built on this module are therefore WARNINGS, worded as
 *    non-conformance, never as emptiness.
 *  - §7.16.1/§8.2.2.13: a streaming flow takes its payload from an output feature
 *    of the source and delivers it to an input feature of the target.
 *
 * DIRECTION. The model stores `attrs.direction` as written, and an implicit
 * per-usage copy of a port's feature keeps its prototype's direction unflipped
 * (`b.meshIn.update` reads `out` though `meshIn : ~MeshPort`). Every reading of
 * a direction here goes through {@link effectiveDirection}, which applies the
 * conjugation of each port the feature is reached through.
 *
 * ABSTENTION. A feature with no definition, a port whose definition cannot be
 * read, or a payload name that does not resolve gives no finding: these readings
 * only ever add a warning where the model states enough to show the mismatch.
 */

import type { ElementId, ElementRecord, Model } from '@core/index';
import { effectiveFeatures, generalizationsOf } from './inheritance';
import { resolveName } from './resolve-names';

export type Direction = 'in' | 'out' | 'inout';

const DIRECTIONS = new Set<string>(['in', 'out', 'inout']);

export function conjugateDirection(d: Direction): Direction {
  return d === 'in' ? 'out' : d === 'out' ? 'in' : 'inout';
}

function asDirection(v: unknown): Direction | undefined {
  return typeof v === 'string' && DIRECTIONS.has(v) ? (v as Direction) : undefined;
}

function isDefinition(el: ElementRecord): boolean {
  return el.eClass.endsWith('Definition') || el.eClass === 'Classifier' || el.eClass === 'DataType';
}

/** The direction a feature declares, on itself or on the first feature it redefines or subsets that declares one. */
export function declaredDirection(model: Model, id: ElementId): Direction | undefined {
  const el = model.get(id);
  if (!el) return undefined;
  // An implicit per-usage copy carries its prototype's direction verbatim; the
  // prototype is the authority (the copy's flag is not flipped by conjugation).
  const own = asDirection(el.attrs.direction);
  if (own !== undefined && el.attrs.implicit !== true) return own;
  for (const g of generalizationsOf(model, id)) {
    if (isDefinition(g)) continue;
    const d = asDirection(g.attrs.direction);
    if (d !== undefined) return d;
  }
  return own;
}

/** Net conjugation of a port: its own `~` and every `~` along its generalizations (twice cancels). */
export function portConjugated(model: Model, id: ElementId): boolean {
  const el = model.get(id);
  if (!el) return false;
  let c = el.attrs.conjugated === true;
  for (const g of generalizationsOf(model, id)) if (g.attrs.conjugated === true) c = !c;
  return c;
}

/**
 * The direction of `id` as seen from outside the outermost port it is reached
 * through: its declared direction, conjugated once for every conjugated port
 * between it and the first owner that is not a port (§7.12.3).
 */
export function effectiveDirection(model: Model, id: ElementId): Direction | undefined {
  let d = declaredDirection(model, id);
  if (d === undefined) return undefined;
  const seen = new Set<ElementId>([id]);
  let cur = model.get(id)?.ownerId ?? null;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const owner = model.get(cur);
    if (!owner || owner.eClass !== 'PortUsage') break;
    if (portConjugated(model, owner.id)) d = conjugateDirection(d);
    cur = owner.ownerId;
  }
  return d;
}

/** The definitions a feature is typed by directly (own typings, else its prototype's), without library supertypes. */
export function declaredDefinitions(model: Model, id: ElementId): ElementRecord[] {
  const typed = (fid: ElementId): ElementRecord[] => {
    const out: ElementRecord[] = [];
    for (const r of model.relationshipsFrom(fid)) {
      if (r.eClass !== 'FeatureTyping' && r.eClass !== 'ConjugatedPortTyping') continue;
      for (const t of r.target ?? []) {
        const d = model.get(t);
        if (d && isDefinition(d)) out.push(d);
      }
    }
    return out;
  };
  const own = typed(id);
  if (own.length > 0) return own;
  for (const g of generalizationsOf(model, id)) {
    if (isDefinition(g)) continue;
    const t = typed(g.id);
    if (t.length > 0) return t;
  }
  return [];
}

/** `a` is `b` or specialises it. */
function specialises(model: Model, a: ElementRecord, b: ElementRecord): boolean {
  return a.id === b.id || generalizationsOf(model, a.id).some((g) => g.id === b.id);
}

/**
 * Whether two features' definitions conform: some definition of one is, or
 * specialises, some definition of the other. An untyped side conforms (no basis
 * for a finding).
 */
export function definitionsConform(model: Model, a: ElementId, b: ElementId): boolean {
  const da = declaredDefinitions(model, a);
  const db = declaredDefinitions(model, b);
  if (da.length === 0 || db.length === 0) return true;
  return da.some((x) => db.some((y) => specialises(model, x, y) || specialises(model, y, x)));
}

export interface DirectedFeature {
  el: ElementRecord;
  name: string;
  direction: Direction;
}

/**
 * The directed features of a port usage as seen from outside it: its effective
 * features (own and inherited from its definitions, redefinitions resolved) that
 * carry a direction, with the port's conjugation applied. Nested ports are not
 * descended into (their own conformance is a separate pair).
 */
export function directedFeaturesOf(model: Model, portId: ElementId): DirectedFeature[] {
  const conj = portConjugated(model, portId);
  const out: DirectedFeature[] = [];
  for (const f of effectiveFeatures(model, portId)) {
    if (f.attrs.isLibrary === true || f.attrs.isEnd === true || f.eClass === 'PortUsage') continue;
    const d = declaredDirection(model, f.id);
    if (d === undefined) continue;
    out.push({ el: f, name: f.declaredName ?? `«${f.eClass}»`, direction: conj ? conjugateDirection(d) : d });
  }
  return out;
}

export interface PortMismatch {
  /** The port whose feature found no match. */
  port: ElementId;
  feature: DirectedFeature;
  /** Why: a feature of a conforming definition exists but its direction is not the conjugate, or none conforms. */
  reason: 'direction' | 'definition';
  /** The other side's same-definition feature, when the reason is direction. */
  other?: DirectedFeature;
}

/**
 * §7.12.1 port conformance between two port usages, over their DIRECTED
 * features. `undefined` when neither port has a directed feature (the question
 * is the nominal one the caller already asks); `[]` when they conform.
 */
export function portMismatches(model: Model, a: ElementId, b: ElementId): PortMismatch[] | undefined {
  const fa = directedFeaturesOf(model, a);
  const fb = directedFeaturesOf(model, b);
  if (fa.length === 0 && fb.length === 0) return undefined;
  const out: PortMismatch[] = [];
  const side = (port: ElementId, mine: DirectedFeature[], theirs: DirectedFeature[]) => {
    for (const f of mine) {
      const conforming = theirs.filter((g) => definitionsConform(model, f.el.id, g.el.id));
      if (conforming.some((g) => g.direction === conjugateDirection(f.direction))) continue;
      if (conforming.length > 0) out.push({ port, feature: f, reason: 'direction', other: conforming[0] });
      else out.push({ port, feature: f, reason: 'definition' });
    }
  };
  side(a, fa, fb);
  side(b, fb, fa);
  return out;
}

/** The end features of the connection/interface definitions typing `connId`, in declaration order. */
export function definitionEndsOf(model: Model, connId: ElementId): ElementRecord[] {
  for (const def of declaredDefinitions(model, connId)) {
    const ends = effectiveFeatures(model, def.id).filter((f) => f.attrs.isEnd === true);
    if (ends.length > 0) return ends;
  }
  return [];
}

/**
 * Pair each related feature of a binary connection with the definition end it
 * redefines: by the end name written in the connection (`connect sender ::> a.p
 * to receiver ::> b.q`), else by position (KerML §7.4.6.2: "matched in order").
 */
export function endPairs(
  model: Model,
  connId: ElementId,
): { end: ElementRecord; related: ElementId; written: 'name' | 'position' }[] {
  const c = model.get(connId);
  if (!c) return [];
  const ends = definitionEndsOf(model, connId);
  if (ends.length === 0) return [];
  const related: [ElementId | undefined, unknown][] = [
    [c.source?.[0], c.attrs.sourceEndName],
    [c.target?.[0], c.attrs.targetEndName],
  ];
  const out: { end: ElementRecord; related: ElementId; written: 'name' | 'position' }[] = [];
  related.forEach(([rid, endName], i) => {
    if (rid === undefined) return;
    if (typeof endName === 'string') {
      const e = ends.find((x) => x.declaredName === endName);
      if (e) out.push({ end: e, related: rid, written: 'name' });
      return;
    }
    if (ends[i]) out.push({ end: ends[i], related: rid, written: 'position' });
  });
  return out;
}

export interface EndMismatch {
  end: ElementRecord;
  related: ElementId;
  reason: 'definition' | 'conjugation';
  required: ElementRecord[];
  actual: ElementRecord[];
}

/**
 * KerML §7.4.6.1 end conformance of a connection typed by a connection or
 * interface definition: each related feature should be classified by its end's
 * definition, and a port end's conjugation should agree with the related port's.
 */
export function endMismatches(model: Model, connId: ElementId): EndMismatch[] {
  const out: EndMismatch[] = [];
  for (const { end, related } of endPairs(model, connId)) {
    const required = declaredDefinitions(model, end.id);
    const actual = declaredDefinitions(model, related);
    if (required.length === 0 || actual.length === 0) continue;
    const classified = required.every((r) => actual.some((a) => specialises(model, a, r)));
    if (!classified) {
      out.push({ end, related, reason: 'definition', required, actual });
      continue;
    }
    const rel = model.get(related);
    if (rel?.eClass === 'PortUsage' && required.some((r) => r.eClass === 'PortDefinition')) {
      if (portConjugated(model, end.id) !== portConjugated(model, related)) {
        out.push({ end, related, reason: 'conjugation', required, actual });
      }
    }
  }
  return out;
}

/** The payload definition a flow names (`flow of T …`), resolved outward from the flow's owner; undefined if it does not resolve. */
export function payloadDefinition(model: Model, flowId: ElementId, payload: string): ElementRecord | undefined {
  const seen = new Set<ElementId>();
  let scope = model.get(flowId)?.ownerId ?? null;
  while (scope !== null && !seen.has(scope)) {
    seen.add(scope);
    const hit = resolveName(model, scope, payload);
    if (hit) return isDefinition(hit) ? hit : undefined;
    scope = model.get(scope)?.ownerId ?? null;
  }
  const hit = resolveName(model, null, payload);
  return hit && isDefinition(hit) ? hit : undefined;
}
