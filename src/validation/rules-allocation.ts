/**
 * `exchange-allocation` — is an exchange allocated to an exchange that can carry it?
 *
 * WHY. SysML v2 §7.15 makes an allocation a binary connection between any two
 * elements and sets no consistency rule on it, so `allocate repFlow to cmdLink`
 * (a report flowing drone→ground put on a ground→drone command link) passed
 * silently, as did a flow put on a link between the wrong components and a
 * logical link put on a physical link between the wrong nodes. The rules below
 * are Arcadia's (Voirin, *Conception architecturale des systèmes basée sur les
 * modèles avec la méthode Arcadia*, 2018):
 *
 *  - §20.4: a functional exchange between functions allocated to two components
 *    is implemented by ONE AND ONLY ONE behavioural exchange BETWEEN THOSE TWO
 *    components;
 *  - §21.9: the items an exchange carries are consistent with those of the
 *    interfaces on the ports it joins — here, the flow's payload is a directed
 *    feature of the port on each side, `out` where it leaves and `in` where it
 *    arrives (§7.12.1, read through `~`, §7.12.3);
 *  - §19.10–19.11: a physical link carries behavioural exchanges between the
 *    components hosted on its two ends; a physical port is not oriented, so
 *    either order matches.
 *
 * SHAPE, NOT VOCABULARY. An exchange is any flow or connector; its ends are
 * reached through the owner of each end feature (an action for a flow between
 * parameters, a part for a port). The component an end sits on is the target
 * of an `allocate` from that owner, the part that performs it, or the owner
 * itself when it is a part. Two components match when they are the same, one
 * contains the other, or one subsets the other (a representative member of a
 * fleet). An end whose component is unknown is not judged.
 *
 * SEVERITY. Warning: the allocation is legal SysML v2; Arcadia's consistency is
 * a method rule. Findings are anchored on the allocation.
 */

import type { ElementId, ElementRecord, Model } from '@core/index';
import { payloadOf } from '../semantics/connectors';
import { generalizationsOf } from '../semantics/inheritance';
import { declaredDefinitions, declaredDirection, directedFeaturesOf, payloadDefinition } from '../semantics/port-conformance';
import type { Diagnostic, ValidationRule } from './types';

export const FLOW_KINDS = new Set(['Flow', 'FlowUsage', 'SuccessionFlowUsage', 'ItemFlow', 'SuccessionFlow']);
export const LINK_KINDS = new Set(['ConnectionUsage', 'InterfaceUsage', 'Connector']);
export const ALLOCATION_KINDS = new Set(['Allocation', 'AllocationUsage']);
/** Features an end is reached through before its owner: ports, parameters, items. */
const END_FEATURE_KINDS = new Set(['PortUsage', 'ReferenceUsage', 'ItemUsage', 'AttributeUsage']);

const isExchange = (el: ElementRecord | undefined) =>
  el !== undefined && (FLOW_KINDS.has(el.eClass) || LINK_KINDS.has(el.eClass));

export function label(model: Model, id: ElementId | undefined): string {
  const el = id ? model.get(id) : undefined;
  if (!el) return String(id);
  const parts: string[] = [];
  let cur: ElementRecord | undefined = el;
  const seen = new Set<ElementId>();
  while (cur && !seen.has(cur.id) && parts.length < 3) {
    seen.add(cur.id);
    if (cur.declaredName) parts.unshift(cur.declaredName);
    cur = cur.ownerId ? model.get(cur.ownerId) : undefined;
  }
  return parts.join('::') || el.eClass;
}

/** The element an exchange end hangs on: the first owner of the end feature that is not itself a port, parameter or item. */
export function endOwner(model: Model, endId: ElementId | undefined): ElementRecord | undefined {
  let cur = endId ? model.get(endId) : undefined;
  const seen = new Set<ElementId>();
  while (cur && END_FEATURE_KINDS.has(cur.eClass) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = cur.ownerId ? model.get(cur.ownerId) : undefined;
  }
  return cur;
}

/**
 * Is `a` the same feature as `b`, a container of it, or does one subset the other?
 *
 * Containment is read through typing too: `ctl.sub` resolves to the feature
 * `Ctl::sub` owned by the definition `Ctl`, so a feature owned (at any depth) by
 * a definition of `outer`, or by one it specialises, is inside `outer`. A
 * component and its own sub-component are joined by delegation, never by a
 * component exchange between them (Arcadia §20.4).
 */
export function related(model: Model, a: ElementId, b: ElementId): boolean {
  if (a === b) return true;
  const within = (inner: ElementId, outer: ElementId) => {
    const defs = new Set<ElementId>();
    for (const d of declaredDefinitions(model, outer)) {
      defs.add(d.id);
      for (const g of generalizationsOf(model, d.id)) defs.add(g.id);
    }
    const seen = new Set<ElementId>();
    let cur = model.get(inner)?.ownerId ?? null;
    while (cur !== null && !seen.has(cur)) {
      if (cur === outer || defs.has(cur)) return true;
      seen.add(cur);
      cur = model.get(cur)?.ownerId ?? null;
    }
    return false;
  };
  if (within(a, b) || within(b, a)) return true;
  return generalizationsOf(model, a).some((g) => g.id === b) || generalizationsOf(model, b).some((g) => g.id === a);
}

export interface Index {
  /** Allocation targets by source, for allocations whose source is not an exchange. */
  allocatedTo: Map<ElementId, ElementId[]>;
  /** Parts that `perform` an action, by the action. */
  performedBy: Map<ElementId, ElementId[]>;
}

export function buildIndex(model: Model): Index {
  const allocatedTo = new Map<ElementId, ElementId[]>();
  const performedBy = new Map<ElementId, ElementId[]>();
  const push = (m: Map<ElementId, ElementId[]>, k: ElementId, v: ElementId) => {
    const l = m.get(k);
    if (l) l.push(v);
    else m.set(k, [v]);
  };
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    if (ALLOCATION_KINDS.has(el.eClass)) {
      const s = el.source?.[0];
      const t = el.target?.[0];
      if (s !== undefined && t !== undefined && !isExchange(model.get(s))) push(allocatedTo, s, t);
    } else if (el.eClass === 'PerformActionUsage' && el.ownerId) {
      // `perform x;` carries the performed action as a ReferenceSubsetting (SysML v2 §7.17.6).
      for (const r of model.relationshipsFrom(el.id)) {
        if (r.eClass !== 'ReferenceSubsetting' && r.eClass !== 'Subsetting') continue;
        for (const t of r.target ?? []) {
          push(performedBy, t, el.ownerId);
        }
      }
    }
  }
  return { allocatedTo, performedBy };
}

/**
 * The components `owner` sits on: itself when it is not an action-like
 * behaviour, else what it (or an enclosing action) is allocated to or
 * performed by. Empty when unknown.
 */
export function hostsOf(model: Model, idx: Index, owner: ElementRecord | undefined): ElementId[] {
  if (!owner) return [];
  const behaviour = (e: ElementRecord) => /Action|State|Calculation|Case/.test(e.eClass);
  let cur: ElementRecord | undefined = owner;
  const seen = new Set<ElementId>();
  while (cur && behaviour(cur) && !seen.has(cur.id)) {
    seen.add(cur.id);
    const hosts = [...(idx.allocatedTo.get(cur.id) ?? []), ...(idx.performedBy.get(cur.id) ?? [])];
    if (hosts.length > 0) return hosts;
    const up: ElementRecord | undefined = cur.ownerId ? model.get(cur.ownerId) : undefined;
    if (up && !behaviour(up) && up.eClass !== 'Package' && up.eClass !== 'Namespace' && !up.eClass.endsWith('Definition')) return [up.id];
    cur = up;
  }
  return cur && !behaviour(cur) ? [cur.id] : [];
}

/** The components a part is deployed on: its allocation targets, else itself (containment counts in `related`). */
function deployedOn(idx: Index, part: ElementRecord): ElementId[] {
  return [part.id, ...(idx.allocatedTo.get(part.id) ?? [])];
}

const matches = (model: Model, as: ElementId[], b: ElementRecord | undefined) =>
  b !== undefined && as.some((a) => related(model, a, b.id));

function conformsTo(model: Model, feature: ElementRecord, def: ElementRecord): boolean {
  return declaredDefinitions(model, feature.id).some(
    (d) =>
      d.id === def.id ||
      generalizationsOf(model, d.id).some((g) => g.id === def.id) ||
      generalizationsOf(model, def.id).some((g) => g.id === d.id),
  );
}

export const exchangeAllocation: ValidationRule = {
  id: 'exchange-allocation',
  description:
    'An exchange is allocated to an exchange whose ends are on other components, whose ports do not carry its item the same way, or to more than one exchange (Arcadia §19.10–19.11, §20.4, §21.9).',
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    const mk = (message: string, elementId: ElementId) =>
      out.push({ id: `exchange-allocation#${n++}`, ruleId: 'exchange-allocation', severity: 'warning', message, elementId });
    const idx = buildIndex(model);
    const flowTargets = new Map<ElementId, ElementId[]>();

    for (const al of model.all()) {
      if (al.attrs.isLibrary === true || !ALLOCATION_KINDS.has(al.eClass)) continue;
      const from = al.source?.[0] ? model.get(al.source[0]) : undefined;
      const to = al.target?.[0] ? model.get(al.target[0]) : undefined;
      if (!from || !to || !isExchange(from) || !to || !LINK_KINDS.has(to.eClass)) continue;
      const what = `"${label(model, from.id)}" allocated to "${label(model, to.id)}"`;

      // The two ends of each exchange, as the element each hangs on.
      const fEnds = [from.source?.[0], from.target?.[0]];
      const tEnds = [to.source?.[0], to.target?.[0]];
      if (fEnds.some((e) => e === undefined) || tEnds.some((e) => e === undefined)) continue;
      const tOwners = tEnds.map((e) => endOwner(model, e));

      if (FLOW_KINDS.has(from.eClass)) {
        // ── a functional exchange onto a component exchange (§20.4, §21.9)
        const l = flowTargets.get(from.id);
        if (l) l.push(to.id);
        else flowTargets.set(from.id, [to.id]);
        const fHosts = fEnds.map((e) => hostsOf(model, idx, endOwner(model, e)));
        if (fHosts.some((h) => h.length === 0)) continue;
        const forward = matches(model, fHosts[0]!, tOwners[0]) && matches(model, fHosts[1]!, tOwners[1]);
        const reverse = matches(model, fHosts[0]!, tOwners[1]) && matches(model, fHosts[1]!, tOwners[0]);
        const on = (h: ElementId[]) => h.map((x) => label(model, x)).join(' or ');
        if (!forward && !reverse) {
          mk(
            `${what}: the flow runs from a function on ${on(fHosts[0]!)} to one on ${on(fHosts[1]!)}, but the link joins ${label(model, tOwners[0]?.id)} and ${label(model, tOwners[1]?.id)}; a functional exchange is implemented by an exchange between the components its functions are allocated to (Arcadia §20.4).`,
            al.id,
          );
          continue;
        }
        // Items (§21.9): the payload leaves through an `out` feature and arrives through an `in` one.
        const payload = payloadOf(from);
        const pdef = payload ? payloadDefinition(model, from.id, payload) : undefined;
        if (!pdef) continue;
        const [sendEnd, recvEnd] = forward ? [tEnds[0]!, tEnds[1]!] : [tEnds[1]!, tEnds[0]!];
        for (const [port, want] of [
          [sendEnd, 'out'],
          [recvEnd, 'in'],
        ] as const) {
          const feats = directedFeaturesOf(model, port);
          if (feats.length === 0) continue;
          const conforming = feats.filter((f) => conformsTo(model, f.el, pdef));
          const pname = pdef.declaredName ?? payload;
          if (conforming.length === 0) {
            mk(
              `${what}: the flow carries ${pname}, but port ${label(model, port)} has no feature of that kind (it carries ${feats.map((f) => `${f.direction} ${f.name}`).join(', ')}); the items of an exchange are those of the interfaces on its ports (Arcadia §21.9, SysML v2 §7.12.1).`,
              al.id,
            );
            break; // the other port says the same thing
          } else if (!conforming.some((f) => f.direction === want || f.direction === 'inout')) {
            mk(
              `${what}: the flow's ${pname} ${want === 'out' ? 'leaves' : 'arrives'} through port ${label(model, port)}, where ${conforming[0]!.name} is \`${conforming[0]!.direction}\`; it must be \`${want}\` there (§7.12.1, read through \`~\`, §7.12.3; Arcadia §21.9).`,
              al.id,
            );
          }
        }
      } else {
        // ── a component exchange onto a physical link (§19.10–19.11): unordered ends.
        const fOwners = fEnds.map((e) => endOwner(model, e));
        if (fOwners.some((o) => o === undefined) || tOwners.some((o) => o === undefined)) continue;
        const dep = fOwners.map((o) => deployedOn(idx, o!));
        const forward = matches(model, dep[0]!, tOwners[0]) && matches(model, dep[1]!, tOwners[1]);
        const reverse = matches(model, dep[0]!, tOwners[1]) && matches(model, dep[1]!, tOwners[0]);
        if (!forward && !reverse) {
          mk(
            `${what}: the exchange joins ${label(model, fOwners[0]!.id)} and ${label(model, fOwners[1]!.id)}, but the link joins ${label(model, tOwners[0]!.id)} and ${label(model, tOwners[1]!.id)}, and they are not deployed there; a link carries exchanges between the components hosted on its ends (Arcadia §19.10–19.11).`,
            al.id,
          );
        }
      }
    }

    // One and only one (§20.4).
    for (const [flow, targets] of flowTargets) {
      const distinct = [...new Set(targets)];
      if (distinct.length < 2) continue;
      const anchor = [...model.all()].find(
        (a) => ALLOCATION_KINDS.has(a.eClass) && a.source?.[0] === flow && a.target?.[0] === distinct[1],
      );
      mk(
        `"${label(model, flow)}" is allocated to ${distinct.length} exchanges (${distinct.map((t) => label(model, t)).join(', ')}); a functional exchange is implemented by one and only one exchange (Arcadia §20.4).`,
        anchor?.id ?? flow,
      );
    }
    return out;
  },
};

/** The nearest enclosing package (or namespace) of an element: the scope a layer's allocations are read in. */
export function scopeOf(model: Model, el: ElementRecord): ElementId | undefined {
  const seen = new Set<ElementId>();
  let cur: ElementRecord | undefined = el.ownerId ? model.get(el.ownerId) : undefined;
  while (cur && !seen.has(cur.id)) {
    if (cur.eClass === 'Package' || cur.eClass === 'LibraryPackage') return cur.id;
    seen.add(cur.id);
    cur = cur.ownerId ? model.get(cur.ownerId) : undefined;
  }
  return undefined;
}

/**
 * `exchange-unallocated` — a flow between functions on two components that no
 * connection carries (Arcadia §20.4: a functional exchange between functions on
 * two components is implemented by one and only one component exchange between
 * them; `exchange-allocation` owns "more than one").
 *
 * OPT-IN BY SHAPE. Judged only in a scope (nearest owning package) that already
 * allocates at least one flow to a connection: that is a layer modelling the
 * functional-to-component exchange allocation. A scope with none is silent.
 * A flow whose functions share a host (same, containing or subsetting
 * component), or whose end has no known host, is not judged.
 */
export const exchangeUnallocated: ValidationRule = {
  id: 'exchange-unallocated',
  description:
    'A flow between functions on two different components, in a scope that allocates flows to connections, is allocated to no connection (Arcadia §20.4).',
  severity: 'warning',
  run(model) {
    const out: Diagnostic[] = [];
    const scopes = new Set<ElementId | undefined>();
    const allocated = new Set<ElementId>();
    for (const al of model.all()) {
      if (al.attrs.isLibrary === true || !ALLOCATION_KINDS.has(al.eClass)) continue;
      const from = al.source?.[0] ? model.get(al.source[0]) : undefined;
      const to = al.target?.[0] ? model.get(al.target[0]) : undefined;
      if (from && to && FLOW_KINDS.has(from.eClass) && LINK_KINDS.has(to.eClass)) {
        scopes.add(scopeOf(model, al));
        allocated.add(from.id);
      }
    }
    if (scopes.size === 0) return out;
    const idx = buildIndex(model);
    let n = 0;
    for (const f of model.all()) {
      if (f.attrs.isLibrary === true || !FLOW_KINDS.has(f.eClass) || allocated.has(f.id)) continue;
      if (!scopes.has(scopeOf(model, f))) continue;
      const a = f.source?.[0];
      const b = f.target?.[0];
      if (a === undefined || b === undefined) continue;
      const ha = hostsOf(model, idx, endOwner(model, a));
      const hb = hostsOf(model, idx, endOwner(model, b));
      if (ha.length === 0 || hb.length === 0) continue;
      if (ha.some((x) => hb.some((y) => related(model, x, y)))) continue;
      const on = (h: ElementId[]) => h.map((x) => label(model, x)).join(' or ');
      out.push({
        id: `exchange-unallocated#${n++}`,
        ruleId: 'exchange-unallocated',
        severity: 'warning',
        message: `"${label(model, f.id)}" crosses from ${on(ha)} to ${on(hb)} and no connection carries it; allocate it to the connection between them (Arcadia §20.4).`,
        elementId: f.id,
      });
    }
    return out;
  },
};

/**
 * `function-port-allocation` — a function's parameter allocated to a port
 * (Arcadia §20.3: each functional port is carried by a component port).
 * Judged only where `allocate fn.p to comp.q;` is written, with `q` a port:
 *  - the port belongs to a host of the function (or a part it contains, or that
 *    subsets it);
 *  - the port carries the parameter's item in the parameter's direction
 *    (`out` by `out`, `in` by `in`, `inout` either), read through conjugation;
 *  - the item conforms (as for `exchange-allocation`, §21.9).
 */
export const functionPortAllocation: ValidationRule = {
  id: 'function-port-allocation',
  description:
    'A function parameter is allocated to a port that is not on a component hosting the function, or that does not carry its item in its direction (Arcadia §20.3, §21.9).',
  severity: 'warning',
  run(model) {
    const out: Diagnostic[] = [];
    let idx: Index | undefined;
    let typed: Map<ElementId, ElementRecord[]> | undefined;
    const usagesOf = (def: ElementRecord): ElementRecord[] | undefined => {
      if (!typed) {
        typed = new Map();
        for (const e of model.all()) {
          if (e.attrs.isLibrary === true || !e.eClass.endsWith('Usage')) continue;
          for (const d of declaredDefinitions(model, e.id)) typed.set(d.id, [...(typed.get(d.id) ?? []), e]);
        }
      }
      return typed.get(def.id);
    };
    let n = 0;
    const mk = (message: string, elementId: ElementId) =>
      out.push({ id: `function-port-allocation#${n++}`, ruleId: 'function-port-allocation', severity: 'warning', message, elementId });
    for (const al of model.all()) {
      if (al.attrs.isLibrary === true || !ALLOCATION_KINDS.has(al.eClass)) continue;
      const p = al.source?.[0] ? model.get(al.source[0]) : undefined;
      const q = al.target?.[0] ? model.get(al.target[0]) : undefined;
      if (!p || !q || q.eClass !== 'PortUsage' || isExchange(p)) continue;
      // A parameter is a directed feature of the function (mapped as a PortUsage today) or a reference.
      if (p.eClass !== 'ReferenceUsage' && p.eClass !== 'PortUsage') continue;
      const fn = p.ownerId ? model.get(p.ownerId) : undefined;
      if (!fn || !/Action|Calculation/.test(fn.eClass)) continue;
      const what = `"${label(model, p.id)}" allocated to port "${label(model, q.id)}"`;
      idx ??= buildIndex(model);
      // `allocate ex.cmd to d.cmdIn` resolves to the features of the DEFINITIONS the
      // usages are typed by, so a definition stands for the usages typed by it.
      const isDef = fn.eClass.endsWith('Definition');
      const hosts = isDef ? (usagesOf(fn) ?? []).flatMap((u) => hostsOf(model, idx!, u)) : hostsOf(model, idx, fn);
      const owner = q.ownerId ? model.get(q.ownerId) : undefined;
      const onOwner = (h: ElementId) =>
        owner !== undefined &&
        (related(model, h, owner.id) ||
          (owner.eClass.endsWith('Definition') &&
            declaredDefinitions(model, h).some((d) => d.id === owner.id || generalizationsOf(model, d.id).some((g) => g.id === owner.id))));
      if (hosts.length > 0 && owner && !hosts.some(onOwner)) {
        mk(`${what}: the port is on ${label(model, owner.id)}, but the function runs on ${[...new Set(hosts)].map((h) => label(model, h)).join(' or ')}; a functional port is carried by a port of the component that hosts the function (Arcadia §20.3).`, al.id);
        continue;
      }
      const feats = directedFeaturesOf(model, q.id);
      const dir = declaredDirection(model, p.id);
      const def = declaredDefinitions(model, p.id)[0];
      if (feats.length === 0 || !def || dir === undefined) continue;
      const conforming = feats.filter((f) => conformsTo(model, f.el, def));
      if (conforming.length === 0) {
        mk(`${what}: the parameter carries ${def.declaredName}, but the port has no feature of that kind (it carries ${feats.map((f) => `${f.direction} ${f.name}`).join(', ')}); a functional port is carried by a port carrying the same item (Arcadia §20.3, §21.9).`, al.id);
      } else if (dir !== 'inout' && !conforming.some((f) => f.direction === dir || f.direction === 'inout')) {
        mk(`${what}: the parameter is \`${dir}\` but ${conforming[0]!.name} is \`${conforming[0]!.direction}\` on the port; an \`${dir}\` parameter is carried by a port that carries the item ${dir === 'out' ? 'out' : 'in'} (Arcadia §20.3, SysML v2 §7.12.1).`, al.id);
      }
    }
    return out;
  },
};
