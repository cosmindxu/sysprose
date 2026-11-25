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
    if (f.attrs.isLibrary === true || f.attrs.isEnd === true) continue;
    // A nested port is its own pair; a keyword-less `out x : T;` is a directed feature of this port, not a port.
    if (f.eClass === 'PortUsage' && f.attrs.keywordless !== true) continue;
    const d = declaredDirection(model, f.id);
    if (d === undefined) continue;
    out.push({ el: f, name: f.declaredName ?? `«${f.eClass}»`, direction: conj ? conjugateDirection(d) : d });
  }
  return out;
}

export interface PortMismatch {
  /** The port whose feature found no match. */
  port: ElementId;
  /** The unmatched feature; `direction` is absent for an undirected feature or a nested port. */
  feature: { el: ElementRecord; name: string; direction?: Direction };
  /**
   * Why: `direction` — a feature of a conforming definition exists but its direction is not the conjugate;
   * `definition` — none conforms; `undirected` — an undirected feature has no same-named counterpart;
   * `nested` — a nested port has no same-named counterpart.
   */
  reason: 'direction' | 'definition' | 'undirected' | 'nested';
  /** The other side's same-definition feature, when the reason is direction. */
  other?: DirectedFeature;
  /** Names of the nested ports descended through from `port` to the feature (empty at the top). */
  path: string[];
}

/** Words for a mismatch's feature: `out x : T`, `attribute x`, `port x`, with the nested path in front. */
export function mismatchFeatureText(m: PortMismatch, typeSuffix: string): string {
  const prefix = m.path.length > 0 ? `${m.path.join('.')}.` : '';
  const kw = m.feature.direction ?? (m.reason === 'nested' ? 'port' : 'undirected');
  return `${kw} ${prefix}${m.feature.name}${typeSuffix}`;
}

const MAX_NEST = 6;

interface PortFeatures {
  directed: DirectedFeature[];
  undirected: { el: ElementRecord; name: string }[];
  nested: { el: ElementRecord; name: string }[];
}

/** The features of a port by kind; directions carry the net conjugation `acc` (of the ancestors) composed with the port's own. */
function featuresByKind(model: Model, portId: ElementId, acc: boolean): PortFeatures {
  const conj = acc !== portConjugated(model, portId);
  const out: PortFeatures = { directed: [], undirected: [], nested: [] };
  const seen = new Set<string>();
  for (const f of effectiveFeatures(model, portId)) {
    if (f.attrs.isLibrary === true || f.attrs.isEnd === true) continue;
    const name = f.declaredName ?? undefined;
    const d = declaredDirection(model, f.id);
    if (f.eClass === 'PortUsage' && f.attrs.keywordless !== true) {
      if (name !== undefined && !seen.has(`p:${name}`)) {
        seen.add(`p:${name}`);
        out.nested.push({ el: f, name });
      }
      continue;
    }
    if (d !== undefined) {
      out.directed.push({ el: f, name: name ?? `«${f.eClass}»`, direction: conj ? conjugateDirection(d) : d });
      continue;
    }
    if (name !== undefined && (f.eClass === 'AttributeUsage' || f.eClass === 'ItemUsage') && !seen.has(`u:${name}`)) {
      seen.add(`u:${name}`);
      out.undirected.push({ el: f, name });
    }
  }
  return out;
}

/** A nested port with something to exchange (an empty one has nothing a counterpart could lack). */
function hasContent(model: Model, portId: ElementId, depth: number): boolean {
  const f = featuresByKind(model, portId, false);
  if (f.directed.length > 0 || f.undirected.length > 0) return true;
  return depth < MAX_NEST && f.nested.some((n) => hasContent(model, n.el.id, depth + 1));
}

/**
 * §7.12.1 port conformance between two port usages: their DIRECTED features
 * (conjugate directions), their UNDIRECTED attribute and item features (a
 * same-named feature of a conforming definition on the other), and their NESTED
 * ports (the same-named nested port on the other end, compared recursively with
 * the conjugation of every port along the path composed, §7.12.3). `undefined`
 * when neither port has a directed feature and nothing else mismatched (the
 * question is the nominal one the caller already asks); `[]` when they conform.
 */
export function portMismatches(model: Model, a: ElementId, b: ElementId): PortMismatch[] | undefined {
  const out: PortMismatch[] = [];
  let anyDirected = false;
  const visited = new Set<string>();
  const walk = (pa: ElementId, pb: ElementId, accA: boolean, accB: boolean, path: string[], depth: number): void => {
    const key = `${pa}|${pb}`;
    if (visited.has(key)) return; // cycle guard (a port def whose nested port is typed by itself)
    visited.add(key);
    const A = featuresByKind(model, pa, accA);
    const B = featuresByKind(model, pb, accB);
    if (A.directed.length > 0 || B.directed.length > 0) anyDirected = true;
    const side = (port: ElementId, mine: PortFeatures, theirs: PortFeatures) => {
      for (const f of mine.directed) {
        const conforming = theirs.directed.filter((g) => definitionsConform(model, f.el.id, g.el.id));
        if (conforming.some((g) => g.direction === conjugateDirection(f.direction))) continue;
        if (conforming.length > 0) out.push({ port, feature: f, reason: 'direction', other: conforming[0], path });
        else out.push({ port, feature: f, reason: 'definition', path });
      }
      for (const u of mine.undirected) {
        // A same-named DIRECTED feature on the other side is the directed check's finding, not a second one here.
        if (theirs.directed.some((g) => g.name === u.name)) continue;
        const same = theirs.undirected.filter((g) => g.name === u.name);
        if (same.length === 0 || !same.some((g) => definitionsConform(model, u.el.id, g.el.id))) {
          out.push({ port, feature: u, reason: 'undirected', path });
        }
      }
      for (const n of mine.nested) {
        if (!theirs.nested.some((g) => g.name === n.name) && hasContent(model, n.el.id, depth + 1)) {
          out.push({ port, feature: n, reason: 'nested', path });
        }
      }
    };
    side(pa, A, B);
    side(pb, B, A);
    if (depth >= MAX_NEST) return;
    for (const n of A.nested) {
      const m = B.nested.find((g) => g.name === n.name);
      if (!m) continue;
      walk(
        n.el.id,
        m.el.id,
        accA !== portConjugated(model, pa),
        accB !== portConjugated(model, pb),
        [...path, n.name],
        depth + 1,
      );
    }
  };
  walk(a, b, false, false, [], 0);
  if (!anyDirected && out.length === 0) return undefined;
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
