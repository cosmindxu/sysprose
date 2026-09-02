/**
 * regroup-apply — Phase 2 of the Regroup Workbench: APPLY the previewed
 * regroup as one atomic, undoable model mutation.
 *
 * Split from the pure `regroup.ts` because this module MUTATES:
 *  - {@link planApply} stays PURE — it consumes {@link planRegroup}'s preview
 *    and pre-validates everything into an explicit op list (+ errors), so the
 *    mutation below can never half-fail on a foreseeable inconsistency;
 *  - {@link applyRegroup} executes the op list (create composites → reparent
 *    members → synthesize delegation ports + bindings → rewire the crossing
 *    connections). It is called by the store inside `model.transaction` (one
 *    event batch); ATOMICITY comes from the store's undo snapshot — the
 *    transaction does NOT roll back, so on throw the store restores the
 *    just-pushed snapshot (see store.applyRegroup).
 *
 * Mutation rules honored here: ownership changes ONLY via `model.reparent`
 * (never by writing ownerId), endpoint rewires ONLY via `model.update`.
 */

import type { ElementId } from '@core/index';
import { Model } from '@core/index';
import type { RegroupConfig } from './types';
import { planRegroup, commonOwnerOf } from './regroup';

/* ─────────────────────────────── op contract ──────────────────────────────── */

/** Create one new composite part for an isNew bundle (≥1 explicit member). */
export interface RegroupApplyCreatePart {
  bundleId: string;
  label: string;
  /** Deepest common ancestor of the members' current owners (null ⇒ root). */
  ownerId: ElementId | null;
  /** Metaclass of the composite — the regrouped part kind (config.partKind). */
  eClass: string;
}

/** Reparent one explicitly-assigned member into its bundle's real part. */
export interface RegroupApplyMove {
  partId: ElementId;
  bundleId: string;
}

/** Replace one SIDE of a crossing connection with the new outer port. */
export interface RegroupApplyRewire {
  connectionId: ElementId;
  side: 'source' | 'target';
}

/**
 * Synthesize ONE outer delegation port on the bundle for ONE distinct inside
 * endpoint — grouped by (bundleId, insideEndpointId), NOT by the preview's
 * (label, direction) display dedup: two same-named ports on different member
 * parts must yield two outer ports (collision-suffixed `_2`, `_3`, …).
 */
export interface RegroupApplyPort {
  bundleId: string;
  /** Final (collision-resolved) outer-port name. */
  label: string;
  direction: string | null;
  insideEndpointId: ElementId;
  /**
   * For a chained MULTI-LEVEL delegation: the next-INNER bundle that also
   * delegates this endpoint. The port's binding targets that inner bundle's
   * port (resolved at apply time) instead of `insideEndpointId`. `null` ⇒ bind
   * directly to `insideEndpointId`. Port ops are ordered innermost-first so the
   * inner port always exists when the outer one binds to it.
   */
  innerBundleId: string | null;
  /**
   * Crossing-connection sides this outer port takes over — ONLY the connections
   * whose OUTERMOST crossed level is this bundle. Inner-level ports carry no
   * rewires (they exist to chain the delegation, not to attach the connection).
   */
  rewires: RegroupApplyRewire[];
}

/** The full pre-validated apply plan. `errors` non-empty ⇒ NOT applicable. */
export interface RegroupApplyPlan {
  ops: {
    createParts: RegroupApplyCreatePart[];
    moves: RegroupApplyMove[];
    ports: RegroupApplyPort[];
  };
  errors: string[];
  summary: {
    newParts: number;
    moves: number;
    ports: number;
    /** One BindingConnectorAsUsage (outer→inner) per synthesized port. */
    bindings: number;
    rewires: number;
  };
}

/** Ids of everything {@link applyRegroup} created/changed (for tests/telemetry). */
export interface RegroupApplyResult {
  createdPartIds: ElementId[];
  createdPortIds: ElementId[];
  createdBindingIds: ElementId[];
  movedPartIds: ElementId[];
  rewiredConnectionIds: ElementId[];
}

/* ─────────────────────────────── planApply ────────────────────────────────── */

// `commonOwnerOf` (where a new bundle's composite lands) is shared with
// planRegroup's ownership simulation — imported from './regroup' so preview and
// apply can never disagree on composite placement.

/**
 * PURE pre-validation: turn the current {@link planRegroup} preview into an
 * explicit, deterministic op list. Reuses the preview's boundary detection —
 * no boundary logic is duplicated here. Never mutates the model.
 */
export function planApply(model: Model, config: RegroupConfig): RegroupApplyPlan {
  const preview = planRegroup(model, config);
  const errors: string[] = [];

  // Distinct bundle ids: two bundles sharing an id would create indistinguishable
  // targets (last-write-wins in applyRegroup's realIdByBundle → orphaned composite
  // or duplicated moves). Refuse up-front.
  const bundleIds = config.bundles.map((b) => b.id);
  if (new Set(bundleIds).size !== bundleIds.length) {
    errors.push('Two bundles share the same id — remove and re-add one of them.');
  }

  // Bundle interiors must not NEST: planRegroup's flat interior classifier cannot
  // model one bundle sitting inside another, so refuse (rather than silently
  // mis-port) any config where an EXISTING TARGET ends up inside another bundle —
  // a target nested in another target, or a target whose ancestor is a moved
  // member (the target would ride into that member's bundle).
  //
  // Scope: this guards the existing-target nesting introduced by "bundle into an
  // existing part". NEW-bundle-inside-NEW-bundle (a parent part → Bundle 1, its
  // child → Bundle 2, so Bundle 2's composite lands inside Bundle 1's) is NOT
  // refused — it is a valid regroup, and planRegroup's hierarchical interior
  // simulation classifies its crossings correctly (the outer composite no longer
  // gets a spurious delegation port for a connection internal to it).
  const targetIds = new Set(
    preview.bundles.filter((b) => !b.isNew && model.has(b.id)).map((b) => b.id),
  );
  const movedMemberIds = new Set(preview.bundles.flatMap((b) => b.members.map((m) => m.id)));
  for (const b of preview.bundles) {
    if (b.isNew || !model.has(b.id)) continue;
    for (const anc of model.ancestors(b.id)) {
      if (targetIds.has(anc.id)) {
        errors.push(
          `Bundle "${b.label}" is nested inside bundle "${anc.declaredName ?? anc.id}" — regroup one level at a time.`,
        );
        break;
      }
      if (movedMemberIds.has(anc.id)) {
        errors.push(
          `Bundle "${b.label}"'s target part is itself being moved into another bundle — remove one of them.`,
        );
        break;
      }
    }
  }

  const createParts: RegroupApplyCreatePart[] = [];
  const moves: RegroupApplyMove[] = [];

  for (const bundle of preview.bundles) {
    const memberIds = bundle.members.map((m) => m.id);

    if (bundle.isNew) {
      // Skip empty isNew bundles entirely — no empty composites.
      if (memberIds.length === 0) continue;
      const ownerId = commonOwnerOf(model, memberIds);
      // Belt-and-braces: the composite's owner must never be one of THIS
      // bundle's own members (or sit inside one) — reparenting that member
      // under the composite would then throw mid-apply. Unreachable via
      // commonOwnerOf's math today, but guarded against future changes.
      const memberIdSet = new Set(memberIds);
      if (
        ownerId !== null &&
        (memberIdSet.has(ownerId) || model.ancestors(ownerId).some((a) => memberIdSet.has(a.id)))
      ) {
        errors.push(
          `Bundle "${bundle.label}": the computed owner for the new composite is one of its own members (or inside one) — cannot create it there.`,
        );
        continue;
      }
      createParts.push({ bundleId: bundle.id, label: bundle.label, ownerId, eClass: config.partKind });
      for (const id of memberIds) moves.push({ partId: id, bundleId: bundle.id });
      continue;
    }

    // Existing-part bundle: the target must exist …
    const target = model.get(bundle.id);
    if (!target) {
      if (memberIds.length > 0 || preview.boundary.some((e) => e.bundleId === bundle.id)) {
        errors.push(`Bundle "${bundle.label}": target part no longer exists in the model.`);
      }
      continue;
    }
    // … and no member may equal it or be one of its ancestors (reparent cycle).
    const targetAncestors = new Set(model.ancestors(bundle.id).map((a) => a.id));
    for (const m of bundle.members) {
      if (m.id === bundle.id) {
        errors.push(`Bundle "${bundle.label}": part "${m.label}" cannot be moved into itself.`);
        continue;
      }
      if (targetAncestors.has(m.id)) {
        errors.push(
          `Bundle "${bundle.label}": moving "${m.label}" into its own descendant would create a containment cycle.`,
        );
        continue;
      }
      // Already owned by the target → nothing to move (no-op member).
      const el = model.get(m.id);
      if (el && el.ownerId === bundle.id) continue;
      moves.push({ partId: m.id, bundleId: bundle.id });
    }
  }

  // Two isNew bundles that resolve to the SAME label under the SAME computed
  // owner would create two indistinguishable sibling composites — refuse.
  const seenComposite = new Map<string, string>();
  for (const cp of createParts) {
    const key = `${cp.label}|${cp.ownerId ?? ''}`;
    const other = seenComposite.get(key);
    if (other !== undefined) {
      errors.push(
        `Two bundles share the label "${cp.label}" under the same owner — rename one of them.`,
      );
    } else {
      seenComposite.set(key, cp.bundleId);
    }
  }

  // Validate every reparent against a SIMULATED ownership overlay, applied in
  // the exact order applyRegroup will execute: new composites enter at their
  // planned owner (keyed by their synthetic bundle id), each move re-homes its
  // part, and a move whose target's SIMULATED ancestor chain contains the part
  // is a cycle applyRegroup would throw on mid-way — refuse it up-front. This
  // catches interactions plain per-bundle checks cannot see (e.g. two
  // existing-part bundles swapping members: A→X and X→A).
  const simOwner = new Map<string, ElementId | null>();
  for (const cp of createParts) simOwner.set(cp.bundleId, cp.ownerId);
  const simOwnerOf = (id: string): string | null =>
    simOwner.has(id) ? simOwner.get(id)! : (model.get(id)?.ownerId ?? null);
  for (const mv of moves) {
    // isNew targets are their synthetic bundle id (seeded above); existing
    // targets are the bundle part id itself.
    let cur: string | null = mv.bundleId;
    let cycle = false;
    const visited = new Set<string>();
    while (cur !== null && !visited.has(cur)) {
      visited.add(cur);
      if (cur === mv.partId) {
        cycle = true;
        break;
      }
      cur = simOwnerOf(cur);
    }
    if (cycle) {
      const label = model.get(mv.partId)?.declaredName ?? mv.partId;
      errors.push(
        `Moving "${label}" would create a containment cycle once the other planned moves are applied.`,
      );
    } else {
      simOwner.set(mv.partId, mv.bundleId);
    }
  }

  // Ports: consume the preview's DEFINITIVE per-endpoint port list (labels +
  // innerBundleId chain are already resolved there — single source of truth).
  // Each port takes over ONLY the connections whose OUTERMOST crossed level is
  // its bundle (boundary rows with `crossingOutermost`); inner-level ports just
  // chain the delegation (their binding targets the inner port, not the
  // connection). Ordered innermost→outermost per endpoint so Apply can resolve
  // each outer port's inner-port binding target.
  const ports: RegroupApplyPort[] = [];
  for (const bundle of preview.bundles) {
    for (const pp of bundle.proposedPorts) {
      const op: RegroupApplyPort = {
        bundleId: bundle.id,
        label: pp.label,
        direction: pp.direction,
        insideEndpointId: pp.insideEndpointId,
        innerBundleId: pp.innerBundleId,
        rewires: [],
      };
      for (const entry of preview.boundary) {
        if (
          entry.bundleId !== bundle.id ||
          entry.insideEndpointId !== pp.insideEndpointId ||
          !entry.crossingOutermost // inner levels chain only — no direct rewire
        ) {
          continue;
        }
        // Which side of the crossing connection currently holds the endpoint?
        const conn = model.get(entry.connectionId);
        if (conn?.source?.[0] === entry.insideEndpointId) {
          op.rewires.push({ connectionId: entry.connectionId, side: 'source' });
        } else if (conn?.target?.[0] === entry.insideEndpointId) {
          op.rewires.push({ connectionId: entry.connectionId, side: 'target' });
        } else {
          errors.push(
            `Connection "${entry.connectionLabel}" no longer references endpoint "${entry.insideEndpointLabel}" — refresh the preview.`,
          );
        }
      }
      ports.push(op);
    }
  }
  // Create inner ports before the outer ones that bind to them. Depth = number of
  // innerBundleId hops for this (endpoint, bundle); a stable sort by depth keeps
  // per-endpoint chains inner-first while preserving bundle order among equals.
  const portDepth = (op: RegroupApplyPort): number => {
    let depth = 0;
    let inner = op.innerBundleId;
    const guard = new Set<string>();
    while (inner !== null && !guard.has(inner)) {
      guard.add(inner);
      depth++;
      inner =
        ports.find((p) => p.bundleId === inner && p.insideEndpointId === op.insideEndpointId)
          ?.innerBundleId ?? null;
    }
    return depth;
  };
  const depthOf = new Map(ports.map((op) => [op, portDepth(op)] as const));
  ports.sort((a, b) => depthOf.get(a)! - depthOf.get(b)!);

  const rewireCount = ports.reduce((n, p) => n + p.rewires.length, 0);
  return {
    ops: { createParts, moves, ports },
    errors,
    summary: {
      newParts: createParts.length,
      moves: moves.length,
      ports: ports.length,
      bindings: ports.length,
      rewires: rewireCount,
    },
  };
}

/* ─────────────────────────────── applyRegroup ─────────────────────────────── */

/**
 * Execute a validated {@link RegroupApplyPlan} — MUTATING. Call inside
 * `model.transaction` with a store undo snapshot pushed first: the transaction
 * only batches events (no rollback), so a throw here is made atomic by the
 * caller restoring that snapshot.
 *
 * Order: (1) create the new composite parts; (2) reparent the moved members
 * into their real bundle parts; (3) per port op (ordered innermost→outermost per
 * endpoint) — create the PortUsage on the bundle, ONE BindingConnectorAsUsage
 * whose target is the next-INNER delegation port (for a chained multi-level
 * delegation) or the inside endpoint itself, then rewire each crossing
 * connection's recorded side (only the connections whose outermost crossed level
 * is this bundle) to the port via `model.update`. Throws on any inconsistency
 * (missing target, stale endpoint) BEFORE touching the affected element.
 */
export function applyRegroup(model: Model, plan: RegroupApplyPlan): RegroupApplyResult {
  if (plan.errors.length > 0) {
    throw new Error(`applyRegroup: plan is not applicable: ${plan.errors.join(' | ')}`);
  }

  // (1) Composites. isNew bundles map to their fresh part; existing to their own id.
  const realIdByBundle = new Map<string, ElementId>();
  const createdPartIds: ElementId[] = [];
  for (const cp of plan.ops.createParts) {
    const el = model.create(cp.eClass, { declaredName: cp.label, ownerId: cp.ownerId });
    realIdByBundle.set(cp.bundleId, el.id);
    createdPartIds.push(el.id);
  }
  const realBundleId = (bundleId: string): ElementId => {
    const created = realIdByBundle.get(bundleId);
    if (created !== undefined) return created;
    if (!model.has(bundleId)) throw new Error(`applyRegroup: bundle target missing: ${bundleId}`);
    return bundleId;
  };

  // (2) Reparent the explicitly-assigned members (model.reparent guards cycles).
  const movedPartIds: ElementId[] = [];
  for (const mv of plan.ops.moves) {
    model.reparent(mv.partId, realBundleId(mv.bundleId));
    movedPartIds.push(mv.partId);
  }

  // (3) Delegation ports + one binding each + endpoint rewires. Ports come
  // innermost-first; `portByKey` remembers each created (endpoint, bundle) port
  // so an outer port's binding can target the inner one it chains from.
  const createdPortIds: ElementId[] = [];
  const createdBindingIds: ElementId[] = [];
  const rewired = new Set<ElementId>();
  const portByKey = new Map<string, ElementId>();
  for (const op of plan.ops.ports) {
    const owner = realBundleId(op.bundleId);
    const port = model.create('PortUsage', {
      declaredName: op.label,
      ownerId: owner,
      attrs: op.direction !== null ? { direction: op.direction } : {},
    });
    createdPortIds.push(port.id);
    portByKey.set(`${op.insideEndpointId}::${op.bundleId}`, port.id);
    // Chain: bind to the next-inner delegation port when there is one, else to
    // the deep endpoint itself. The inner port must already exist (inner-first order).
    let bindTarget: ElementId = op.insideEndpointId;
    if (op.innerBundleId !== null) {
      const inner = portByKey.get(`${op.insideEndpointId}::${op.innerBundleId}`);
      if (inner === undefined) {
        throw new Error(
          `applyRegroup: inner delegation port for ${op.insideEndpointId} at ${op.innerBundleId} missing`,
        );
      }
      bindTarget = inner;
    }
    const binding = model.create('BindingConnectorAsUsage', {
      ownerId: owner,
      source: [port.id],
      target: [bindTarget],
    });
    createdBindingIds.push(binding.id);
    for (const rw of op.rewires) {
      const conn = model.get(rw.connectionId);
      const current = rw.side === 'source' ? conn?.source?.[0] : conn?.target?.[0];
      if (!conn || current !== op.insideEndpointId) {
        throw new Error(
          `applyRegroup: connection ${rw.connectionId} ${rw.side} no longer references ${op.insideEndpointId}`,
        );
      }
      model.update(
        rw.connectionId,
        rw.side === 'source' ? { source: [port.id] } : { target: [port.id] },
      );
      rewired.add(rw.connectionId);
    }
  }

  return {
    createdPartIds,
    createdPortIds,
    createdBindingIds,
    movedPartIds,
    rewiredConnectionIds: [...rewired],
  };
}
