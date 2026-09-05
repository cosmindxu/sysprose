/**
 * regroup — the Regroup Workbench engine: given a proposed re-bundling of parts
 * ({@link RegroupConfig}), compute which connections would CROSS a bundle
 * boundary (becoming external interfaces) and which delegation ports Apply
 * would have to synthesize on each bundle ({@link planRegroup}).
 *
 * PHASE 1 CONTRACT: everything here is PURE and READ-ONLY — no model mutation,
 * no reparenting, no port creation. Apply (mutation + undo) is a later phase.
 * Deterministic: iterates `model.all()` in declaration order; no Date /
 * Math.random (Louvain seeding is deterministic in ./graph-algorithms).
 */

import type { ElementId, ElementRecord } from '@core/index';
import { Model } from '@core/index';
import type {
  RegroupBoundary,
  RegroupBundle,
  RegroupConfig,
  RegroupMember,
  RegroupModel,
  RegroupPlannedBundle,
  RegroupProposedPort,
} from './types';
import { type Graph, louvain } from './graph-algorithms';

/* ───────────────────────────── classification ─────────────────────────────── */

/** Part metaclasses a connection endpoint can roll up to (build.ts's part kinds). */
const PART_KINDS = new Set(['PartUsage', 'PartDefinition', 'ItemUsage']);

/**
 * Endpoint-bearing usages that render as connectors: build.ts's
 * CONNECTION_USAGE_KINDS plus 'Flow'/'ItemFlow' — the textual mapper emits
 * eClass 'Flow' for `flow from a to b` (map-to-model.ts) and the semantics
 * layer treats both as connectors (connectors.ts CONNECTOR_KINDS), so a flow
 * crossing a bundle boundary must be detected and rewired like any connection.
 */
const CONNECTION_KINDS = new Set([
  'ConnectionUsage',
  'InterfaceUsage',
  'FlowUsage',
  'Flow',
  'ItemFlow',
  'BindingConnectorAsUsage',
  'SuccessionFlow',
]);

const labelOf = (el: ElementRecord): string =>
  el.declaredName ?? el.declaredShortName ?? (el.attrs.reqId as string | undefined) ?? el.eClass;

/**
 * Stable identity of ONE proposed delegation port: a bundle + the inside
 * endpoint it delegates for. Used to key {@link RegroupConfig.portLabels} user
 * renames, so the same physical port keeps its override across re-previews.
 */
export function proposedPortKey(bundleId: string, insideEndpointId: ElementId): string {
  return `${bundleId}::${insideEndpointId}`;
}

/* ─────────────────────────────── contract ─────────────────────────────────── */

/** The default (empty) regroup configuration. */
export function defaultRegroupConfig(): RegroupConfig {
  return { bundles: [], membership: {}, partKind: 'PartUsage' };
}

/**
 * Resolve a connection ENDPOINT id to the part that owns it: the element itself
 * when it is already a part kind (`connect a to b` binds parts directly), else
 * the nearest part-kind ancestor (a PortUsage's owning part — walked via
 * `model.ancestors` rather than assuming `ownerId`, to survive deeper nesting).
 * Undefined when the id is unknown or no part-kind ancestor exists.
 */
export function endpointToPart(model: Model, endpointId: ElementId): ElementRecord | undefined {
  const el = model.get(endpointId);
  if (!el) return undefined;
  if (PART_KINDS.has(el.eClass)) return el;
  return model.ancestors(endpointId).find((a) => PART_KINDS.has(a.eClass));
}

/** A connection's two resolved sides, ready for boundary classification. */
interface ResolvedConnection {
  conn: ElementRecord;
  /** [source side, target side]: endpoint id + the part it belongs to. */
  sides: Array<{ endpointId: ElementId; part: ElementRecord }>;
}

/** Resolve every non-library connection whose BOTH endpoints roll up to a part. */
function resolvedConnections(model: Model): ResolvedConnection[] {
  const out: ResolvedConnection[] = [];
  for (const conn of model.all()) {
    if (!CONNECTION_KINDS.has(conn.eClass) || conn.attrs.isLibrary === true) continue;
    const s = conn.source?.[0];
    const t = conn.target?.[0];
    if (!s || !t) continue;
    const ps = endpointToPart(model, s);
    const pt = endpointToPart(model, t);
    if (!ps || !pt) continue;
    out.push({
      conn,
      sides: [
        { endpointId: s, part: ps },
        { endpointId: t, part: pt },
      ],
    });
  }
  return out;
}

/**
 * Deepest common ancestor of the given members' CURRENT owners — where Apply
 * creates a new bundle's composite. Walk each member's ancestor-id chain
 * root→leaf (ending at its direct owner), take the longest common prefix, return
 * its last id. No common prefix (members span roots) ⇒ null (root). SHARED by
 * planRegroup's ownership simulation and planApply so preview and apply agree on
 * exactly where each composite lands.
 */
export function commonOwnerOf(model: Model, memberIds: ElementId[]): ElementId | null {
  const chains = memberIds.map((id) =>
    model
      .ancestors(id) // nearest-first: [owner, …, root]
      .map((a) => a.id)
      .reverse(), // root→leaf, ending at the member's direct owner
  );
  if (chains.length === 0) return null;
  let prefixLen = chains[0].length;
  for (const chain of chains.slice(1)) {
    let k = 0;
    while (k < prefixLen && k < chain.length && chain[k] === chains[0][k]) k++;
    prefixLen = k;
  }
  return prefixLen > 0 ? chains[0][prefixLen - 1] : null;
}

/**
 * Compute the read-only regroup PREVIEW for a proposed configuration.
 *
 * Boundary detection: for every connection whose endpoints resolve to parts
 * `ps`/`pt`, classify by their EFFECTIVE bundles (see below).
 *  - same bundle (both assigned)          → INTERNAL to that bundle;
 *  - different (incl. one side unassigned) → for EACH side that IS in a bundle,
 *    emit a {@link RegroupBoundary} whose `inside` is that side — so a
 *    connection between two different bundles yields TWO entries (each bundle
 *    needs its own delegation port).
 *
 * EXPLICIT vs EFFECTIVE membership: `membership` names the parts the user
 * assigned (the ones Apply would reparent) — an entry only counts when the part
 * is a LIVE CANDIDATE of `config.partKind`, so a stale assignment from another
 * part kind (or against a deleted bundle) is inert. A NESTED part physically
 * rides along when its ancestor is reparented, so boundary classification uses
 * the EFFECTIVE bundle of each side: its own explicit assignment, else the
 * nearest explicitly-assigned part-kind ancestor (self/nearest wins — a nested
 * part explicitly assigned to a different bundle overrides its ancestor).
 * Members / unassigned / movedCount stay EXPLICIT: ride-along parts are not
 * themselves reparented, so they are neither member chips nor "moved".
 *
 * The proposed port keeps the inside PortUsage's name + direction; when the
 * endpoint is the part itself, a synthetic `${part}_${connection}` name is used.
 *
 * PURE: reads the model, never writes it.
 */
export function planRegroup(model: Model, config: RegroupConfig): RegroupModel {
  const validBundles = new Set(config.bundles.map((b) => b.id));

  // Candidate parts (declaration order — determinism) + part-kind facet.
  // Implicit (compiler-materialized) features are never regroup candidates.
  const facet = new Map<string, number>();
  const candidates: ElementRecord[] = [];
  for (const el of model.all()) {
    if (!PART_KINDS.has(el.eClass) || el.attrs.isLibrary === true || el.attrs.implicit === true)
      continue;
    facet.set(el.eClass, (facet.get(el.eClass) ?? 0) + 1);
    if (el.eClass === config.partKind) candidates.push(el);
  }
  const candidateIds = new Set(candidates.map((p) => p.id));

  /**
   * EXPLICIT membership — what Apply would reparent: a live candidate assigned
   * to an existing bundle. Anything else (another part kind, a stale/deleted
   * bundle id) is inert and treated as unassigned.
   */
  const explicitBundleOf = (partId: ElementId): string | undefined => {
    if (!candidateIds.has(partId)) return undefined;
    const b = config.membership[partId];
    return b !== undefined && validBundles.has(b) ? b : undefined;
  };

  // Existing (non-new) bundle targets that still exist. A part IS "inside" its
  // own existing-target bundle, and so are that target's PRE-EXISTING
  // descendants — they don't move, but a member's connection to them must read
  // as INTERNAL once the member joins (otherwise Apply would synthesize a
  // spurious delegation port for a connection that is no longer crossing).
  // Keyed partId (== bundle id) → bundle id.
  const existingTargets = new Map<ElementId, string>();
  for (const b of config.bundles) {
    if (!b.isNew && model.has(b.id)) existingTargets.set(b.id, b.id);
  }

  // Post-regroup ownership SIMULATION. Boundary crossings must be judged against
  // the tree Apply will actually produce — which can NEST bundles: a NEW bundle's
  // composite lands at the deepest common ancestor of its members (shared
  // `commonOwnerOf`), so dragging a parent part into Bundle 1 and its child into
  // Bundle 2 makes Bundle 2's composite end up INSIDE Bundle 1's. A flat "one
  // bundle per part" then mis-reads an internal connection as crossing the outer
  // bundle. So overlay the future ownership and ask which bundles truly contain
  // each part: each new bundle's composite (keyed by its synthetic id) sits at
  // its members' common owner, every moved member is re-homed under its bundle's
  // root (composite id for new, target part id for existing), the rest unchanged.
  const membersByBundle = new Map<string, ElementId[]>();
  for (const p of candidates) {
    const b = explicitBundleOf(p.id);
    if (b !== undefined) (membersByBundle.get(b) ?? membersByBundle.set(b, []).get(b)!).push(p.id);
  }
  const simOwner = new Map<ElementId, ElementId | null>();
  for (const b of config.bundles) {
    const members = membersByBundle.get(b.id) ?? [];
    if (b.isNew) simOwner.set(b.id, commonOwnerOf(model, members)); // composite location
    for (const m of members) simOwner.set(m, b.id); // member re-homed under the root
  }
  const simOwnerOf = (id: ElementId): ElementId | null =>
    simOwner.has(id) ? simOwner.get(id)! : (model.get(id)?.ownerId ?? null);

  // Bundle roots that actually materialize (a new bundle's synthetic id, or an
  // existing target part that still exists). Empty new bundles have no members,
  // so nothing ever nests under them — harmless.
  const activeBundleIds = new Set<string>();
  for (const b of config.bundles) if (b.isNew || model.has(b.id)) activeBundleIds.add(b.id);

  /**
   * The bundles that CONTAIN a part after the regroup, INNERMOST first: the part
   * itself when it IS an existing target, then every bundle root on its simulated
   * ancestor chain. With nesting a part can be inside several bundles at once.
   * Cycle-safe + memoized (queried O(connections) times).
   */
  const insideCache = new Map<ElementId, string[]>();
  const insideBundlesOf = (partId: ElementId): string[] => {
    const cached = insideCache.get(partId);
    if (cached) return cached;
    const out: string[] = [];
    if (activeBundleIds.has(partId)) out.push(partId); // existing target = its own bundle
    const seen = new Set<ElementId>([partId]);
    let cur = simOwnerOf(partId);
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      if (activeBundleIds.has(cur)) out.push(cur);
      cur = simOwnerOf(cur);
    }
    insideCache.set(partId, out);
    return out;
  };

  /**
   * Was `part` ALREADY inside bundle `bundleId` BEFORE the regroup? Only an
   * existing target has a "before" interior (the target part + its current
   * subtree); a NEW bundle has none. Distinguishes a crossing this regroup NEWLY
   * created (→ needs a delegation port) from an existing target's own PRE-EXISTING
   * external interface (→ left untouched).
   */
  const beforeInside = (part: ElementRecord, bundleId: string): boolean => {
    if (!existingTargets.has(bundleId)) return false;
    if (part.id === bundleId) return true;
    return model.ancestors(part.id).some((a) => a.id === bundleId);
  };

  // ── Boundary detection over every part-to-part connection ────────────────
  // MULTI-LEVEL delegation: for each crossing side we emit a boundary row per
  // bundle LEVEL the connection crosses (innermost→outermost), so Apply can chain
  // a delegation port through EACH level (endpoint ← inner port ← … ← outer port)
  // rather than only the innermost. `portInfoByEndpoint` records, per delegated
  // endpoint, the part it belongs to + the set of bundles that get a port, so the
  // ports can later be linked (innerBundleId) in nesting order.
  const boundary: RegroupBoundary[] = [];
  const portInfoByEndpoint = new Map<ElementId, { partId: ElementId; ported: Set<string> }>();
  let internalCount = 0;
  for (const { conn, sides } of resolvedConnections(model)) {
    const [src, tgt] = sides;
    const inS = insideBundlesOf(src.part.id);
    const inT = insideBundlesOf(tgt.part.id);
    if (inS[0] === inT[0]) {
      // Same innermost bundle ⇒ identical containing-chain (an inner bundle's
      // outer bundles are shared), so the connection is internal; both outside ⇒
      // ignore. Count it only when THIS regroup made it internal.
      const b = inS[0];
      if (b !== undefined && !(beforeInside(src.part, b) && beforeInside(tgt.part, b))) {
        internalCount++;
      }
      continue;
    }
    const connectionLabel = labelOf(conn);
    for (const [inside, outside, chain] of [
      [src, tgt, inS],
      [tgt, src, inT],
    ] as const) {
      // The bundle LEVELS this side crosses, innermost→outermost: every bundle
      // containing the inside part, up to (not including) the first that ALSO
      // contains the outside part (nested → internal to that outer bundle), minus
      // an existing target's own PRE-EXISTING external interface (a crossing this
      // regroup did not create).
      const outsideInside = new Set(insideBundlesOf(outside.part.id));
      const levels: string[] = [];
      for (const B of chain) {
        if (outsideInside.has(B)) break; // internal from here outward
        if (beforeInside(inside.part, B) && !beforeInside(outside.part, B)) continue;
        levels.push(B);
      }
      if (levels.length === 0) continue;
      let rec = portInfoByEndpoint.get(inside.endpointId);
      if (!rec) {
        rec = { partId: inside.part.id, ported: new Set() };
        portInfoByEndpoint.set(inside.endpointId, rec);
      }
      for (const B of levels) rec.ported.add(B);
      const endpointEl = model.get(inside.endpointId)!;
      const isPort = endpointEl.eClass === 'PortUsage';
      const insidePartLabel = labelOf(inside.part);
      const baseLabel = isPort
        ? labelOf(endpointEl)
        : `${insidePartLabel}_${connectionLabel || 'if'}`;
      const baseDir = isPort ? ((endpointEl.attrs.direction as string | undefined) ?? null) : null;
      levels.forEach((bundleId, i) => {
        boundary.push({
          connectionId: conn.id,
          connectionLabel,
          connectionKind: conn.eClass,
          bundleId,
          insidePartId: inside.part.id,
          insidePartLabel,
          insideEndpointId: inside.endpointId,
          insideEndpointLabel: labelOf(endpointEl),
          outsidePartId: outside.part.id,
          outsidePartLabel: labelOf(outside.part),
          outsideEndpointLabel: labelOf(model.get(outside.endpointId)!),
          proposedPortLabel: baseLabel,
          proposedPortDirection: baseDir,
          crossingOutermost: i === levels.length - 1,
        });
      });
    }
  }

  // Each delegated endpoint's ported bundles, ordered innermost→outermost — the
  // chain Apply threads bindings through (port on level j binds to the port on
  // level j−1, or the endpoint itself when j = 0).
  const portedByEndpoint = new Map<ElementId, string[]>();
  for (const [endpointId, rec] of portInfoByEndpoint) {
    portedByEndpoint.set(
      endpointId,
      insideBundlesOf(rec.partId).filter((b) => rec.ported.has(b)),
    );
  }

  // ── Bundles: members + the DEFINITIVE proposed delegation ports ───────────
  // Members are the EXPLICIT assignments (the chips the user placed).
  // Proposed ports are grouped by inside ENDPOINT — exactly what Apply creates
  // (ONE outer port per distinct inside endpoint) — and their labels are
  // collision-suffixed here (`_2`, `_3`, …) against everything the bundle will
  // contain: existing children of an existing target, the incoming members,
  // and previously assigned port names. The matching boundary rows are synced
  // to the FINAL name, so the preview never promises a port Apply won't make.
  const bundles: RegroupPlannedBundle[] = config.bundles.map((b: RegroupBundle) => {
    const members: RegroupMember[] = candidates
      .filter((p) => explicitBundleOf(p.id) === b.id)
      .map((p) => ({ id: p.id, label: labelOf(p) }));
    const taken = new Set<string>(members.map((m) => m.label));
    // Existing-target bundles show the part's LIVE name (a later rename of the
    // part is reflected, not the label snapshotted when the bundle was added).
    const exists = !b.isNew && model.has(b.id);
    const label = exists ? labelOf(model.get(b.id)!) : b.label;
    if (exists) {
      // labelOf (not declaredName): a shortName-only sibling must reserve too.
      for (const child of model.children(b.id)) taken.add(labelOf(child));
    }
    const proposedPorts: RegroupProposedPort[] = [];
    const byEndpoint = new Map<string, RegroupProposedPort>();
    for (const entry of boundary) {
      if (entry.bundleId !== b.id) continue;
      let port = byEndpoint.get(entry.insideEndpointId);
      if (!port) {
        // User rename (if any) is the BASE; collision-suffixing still applies on
        // top, so the preview's final port name stays the single source of truth.
        const override = config.portLabels?.[proposedPortKey(b.id, entry.insideEndpointId)]?.trim();
        const base = override || entry.proposedPortLabel;
        let label = base;
        for (let n = 2; taken.has(label); n++) label = `${base}_${n}`;
        taken.add(label);
        // Link to the next-inner ported bundle for this endpoint (for the
        // delegation chain); null when this bundle is the innermost ported level.
        const ordered = portedByEndpoint.get(entry.insideEndpointId) ?? [];
        const idx = ordered.indexOf(b.id);
        port = {
          label,
          direction: entry.proposedPortDirection,
          connectionId: entry.connectionId,
          insideEndpointId: entry.insideEndpointId,
          innerBundleId: idx > 0 ? ordered[idx - 1] : null,
        };
        byEndpoint.set(entry.insideEndpointId, port);
        proposedPorts.push(port);
      }
      // Every row for this endpoint advertises the ONE final port name.
      entry.proposedPortLabel = port.label;
      entry.proposedPortDirection = port.direction;
    }
    return { id: b.id, label, isNew: b.isNew, members, proposedPorts };
  });

  // Unassigned = no EXPLICIT assignment (a nested ride-along part still shows
  // here — it is not itself reparented, only carried by its ancestor), EXCLUDING
  // any part that is itself an existing-target bundle (it is a container, not a
  // draggable/assignable chip).
  const unassigned: RegroupMember[] = candidates
    .filter((p) => explicitBundleOf(p.id) === undefined && !existingTargets.has(p.id))
    .map((p) => ({ id: p.id, label: labelOf(p) }));

  // Moved parts (EXPLICIT only): a NEW bundle is always a new owner; an
  // existing-part bundle moves the part only when it isn't already owned by it.
  const bundleById = new Map(config.bundles.map((b) => [b.id, b] as const));
  let movedCount = 0;
  for (const p of candidates) {
    const bid = explicitBundleOf(p.id);
    if (bid === undefined) continue;
    const b = bundleById.get(bid)!;
    if (b.isNew || p.ownerId !== b.id) movedCount++;
  }

  return {
    bundles,
    unassigned,
    candidateParts: candidates.map((p) => ({ id: p.id, label: labelOf(p) })),
    boundary,
    partKindsPresent: [...facet.entries()]
      .map(([eClass, count]) => ({ eClass, count }))
      .sort((a, b) => b.count - a.count || (a.eClass < b.eClass ? -1 : 1)),
    stats: {
      partCount: candidates.length,
      bundleCount: config.bundles.length,
      movedCount,
      boundaryCount: boundary.length,
      internalCount,
    },
  };
}

/**
 * Seed a {@link RegroupConfig} from Louvain communities over the part graph:
 * nodes = candidate parts of `partKind`; one weighted undirected edge per
 * connection, each endpoint rolled up to the NEAREST CANDIDATE part at or above
 * the endpoint's owning part (so a connection landing on a nested non-candidate
 * part still couples its candidate ancestors). One NEW bundle per community
 * (communities numbered by first appearance in declaration order); every
 * CONNECTED part is assigned to its community's bundle, while degree-0
 * (connection-less) parts stay UNASSIGNED — a disconnected model must not seed
 * one singleton bundle per part.
 * Deterministic (louvain is seeded/order-stable) and PURE — no model mutation.
 */
export function seedRegroupFromClusters(model: Model, partKind: string): RegroupConfig {
  const candidates = model
    .all()
    .filter(
      (el) =>
        el.eClass === partKind && el.attrs.isLibrary !== true && el.attrs.implicit !== true,
    );
  const candidateIds = new Set(candidates.map((p) => p.id));

  /** The nearest candidate part at-or-above a resolved endpoint part. */
  const toCandidate = (part: ElementRecord): ElementId | undefined => {
    if (candidateIds.has(part.id)) return part.id;
    return model.ancestors(part.id).find((a) => candidateIds.has(a.id))?.id;
  };

  // Weighted undirected part graph (parallel connections accumulate weight).
  const weights = new Map<string, number>();
  for (const { sides } of resolvedConnections(model)) {
    const a = toCandidate(sides[0].part);
    const b = toCandidate(sides[1].part);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? `${a} ${b}` : `${b} ${a}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  // Degree-0 parts stay unassigned: cluster only the CONNECTED candidates.
  const connected = new Set<ElementId>();
  for (const key of weights.keys()) {
    const [a, b] = key.split(' ');
    connected.add(a);
    connected.add(b);
  }
  const graph: Graph = {
    nodes: candidates.filter((p) => connected.has(p.id)).map((p) => p.id),
    edges: [...weights.entries()].map(([key, weight]) => {
      const [source, target] = key.split(' ');
      return { source, target, weight };
    }),
  };

  const community = louvain(graph);

  // One bundle per community, indexed by first appearance over the candidates.
  const bundles: RegroupBundle[] = [];
  const bundleByCommunity = new Map<number, string>();
  const membership: Record<string, string> = {};
  for (const p of candidates) {
    if (!connected.has(p.id)) continue; // degree-0 → left unassigned
    const c = community.get(p.id) ?? -1;
    let bundleId = bundleByCommunity.get(c);
    if (bundleId === undefined) {
      bundleId = `new:${bundles.length}`;
      bundles.push({ id: bundleId, label: `Bundle ${bundles.length + 1}`, isNew: true });
      bundleByCommunity.set(c, bundleId);
    }
    membership[p.id] = bundleId;
  }

  return { bundles, membership, partKind };
}

/**
 * Seed a {@link RegroupConfig} that gathers a SPECIFIC set of graph nodes into
 * ONE new bundle — the handoff from the Graph Analysis view, where the user
 * picks a visible community and asks to re-bundle it. Each node id is rolled up
 * to its nearest candidate part of `partKind` (itself if it already is one,
 * else the nearest such ancestor — mirroring {@link seedRegroupFromClusters}'s
 * rollup), skipping library/implicit parts; the resolved parts (de-duplicated,
 * first-seen order) form the bundle's membership.
 *
 * Returns a config with NO bundles when nothing resolves to a candidate part
 * (e.g. the community was all requirements/actions) — the caller still switches
 * to the workbench, which then shows every part unassigned. PURE.
 */
export function seedRegroupFromNodeIds(
  model: Model,
  partKind: string,
  nodeIds: Iterable<ElementId>,
  label = 'Bundle 1',
): RegroupConfig {
  const isCandidate = (el: ElementRecord | undefined): el is ElementRecord =>
    !!el && el.eClass === partKind && el.attrs.isLibrary !== true && el.attrs.implicit !== true;

  const partIds: ElementId[] = [];
  const seen = new Set<ElementId>();
  for (const nid of nodeIds) {
    const el = model.get(nid);
    if (!el) continue;
    const target = isCandidate(el) ? el.id : model.ancestors(nid).find(isCandidate)?.id;
    if (target !== undefined && !seen.has(target)) {
      seen.add(target);
      partIds.push(target);
    }
  }

  if (partIds.length === 0) return { bundles: [], membership: {}, partKind };
  const bundleId = 'new:0';
  const membership: Record<string, string> = {};
  for (const id of partIds) membership[id] = bundleId;
  return { bundles: [{ id: bundleId, label, isNew: true }], membership, partKind };
}
