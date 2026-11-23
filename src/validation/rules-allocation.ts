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
import { declaredDefinitions, directedFeaturesOf, payloadDefinition } from '../semantics/port-conformance';
import { resolveName } from '../semantics/resolve-names';
import type { Diagnostic, ValidationRule } from './types';

const FLOW_KINDS = new Set(['Flow', 'FlowUsage', 'SuccessionFlowUsage', 'ItemFlow', 'SuccessionFlow']);
const LINK_KINDS = new Set(['ConnectionUsage', 'InterfaceUsage', 'Connector']);
const ALLOCATION_KINDS = new Set(['Allocation', 'AllocationUsage']);
/** Features an end is reached through before its owner: ports, parameters, items. */
const END_FEATURE_KINDS = new Set(['PortUsage', 'ReferenceUsage', 'ItemUsage', 'AttributeUsage']);

const isExchange = (el: ElementRecord | undefined) =>
  el !== undefined && (FLOW_KINDS.has(el.eClass) || LINK_KINDS.has(el.eClass));

function label(model: Model, id: ElementId | undefined): string {
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
function endOwner(model: Model, endId: ElementId | undefined): ElementRecord | undefined {
  let cur = endId ? model.get(endId) : undefined;
  const seen = new Set<ElementId>();
  while (cur && END_FEATURE_KINDS.has(cur.eClass) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = cur.ownerId ? model.get(cur.ownerId) : undefined;
  }
  return cur;
}

/** Is `a` the same feature as `b`, a container of it, or does one subset the other? */
function related(model: Model, a: ElementId, b: ElementId): boolean {
  if (a === b) return true;
  const within = (inner: ElementId, outer: ElementId) => {
    const seen = new Set<ElementId>();
    let cur = model.get(inner)?.ownerId ?? null;
    while (cur !== null && !seen.has(cur)) {
      if (cur === outer) return true;
      seen.add(cur);
      cur = model.get(cur)?.ownerId ?? null;
    }
    return false;
  };
  if (within(a, b) || within(b, a)) return true;
  return generalizationsOf(model, a).some((g) => g.id === b) || generalizationsOf(model, b).some((g) => g.id === a);
}

interface Index {
  /** Allocation targets by source, for allocations whose source is not an exchange. */
  allocatedTo: Map<ElementId, ElementId[]>;
  /** Parts that `perform` an action, by the action. */
  performedBy: Map<ElementId, ElementId[]>;
}

function buildIndex(model: Model): Index {
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
      let found = false;
      for (const r of model.relationshipsFrom(el.id)) {
        if (r.eClass !== 'ReferenceSubsetting' && r.eClass !== 'Subsetting') continue;
        for (const t of r.target ?? []) {
          push(performedBy, t, el.ownerId);
          found = true;
        }
      }
      // `perform x;` is mapped today as a usage NAMED x with no reference to
      // the performed action (TODO: map it as §7.17's ReferenceSubsetting).
      // Resolve the name from the performer's scope until it is.
      const performer = model.get(el.ownerId);
      if (!found && el.declaredName && performer?.ownerId) {
        const hit = resolveName(model, performer.ownerId, el.declaredName);
        if (hit && hit.id !== el.id && /Action/.test(hit.eClass)) push(performedBy, hit.id, el.ownerId);
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
function hostsOf(model: Model, idx: Index, owner: ElementRecord | undefined): ElementId[] {
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
