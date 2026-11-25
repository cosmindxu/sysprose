/**
 * The interface control document (ICD): one row per connection, read from the
 * same facts the exchange-allocation rules judge — it is a READING, not a new
 * rule, and it reuses their helpers and their findings rather than copying them.
 *
 * SPEC. SysML v2 §7.12.1 (a port's directed features, read through `~` §7.12.3:
 * what leaves one end arrives at the other), §7.13 (connections and interfaces),
 * §7.15 (allocation). Method: Arcadia §20.4 (a functional exchange is implemented
 * by ONE component exchange), §21.9 (the items of an exchange are those of the
 * interfaces on its ports), §19.10–19.11 (a physical link carries component
 * exchanges).
 *
 * STATUS per row, by shape (never by name):
 *  - UNCARRIED   a flow allocated to the row that its ports cannot carry, or
 *                between other components (an `exchange-allocation` finding);
 *  - CONSISTENT  something is allocated to the row and nothing is wrong with it;
 *  - UNUSED      the row carries items, nothing is allocated to it, and its
 *                scope (nearest package) allocates flows elsewhere;
 *  - UNJUDGED    nothing is allocated to it and its scope allocates no flows:
 *                the layer does not model the exchange allocation.
 * The footer lists crossing flows allocated to no connection
 * (`exchange-unallocated`).
 */

import type { ElementId, ElementRecord, Model } from '@core/index';
import { payloadOf } from './connectors';
import { declaredDefinitions, directedFeaturesOf, portConjugated } from './port-conformance';
import {
  ALLOCATION_KINDS,
  endOwner,
  exchangeAllocation,
  exchangeUnallocated,
  FLOW_KINDS,
  label,
  LINK_KINDS,
  scopeOf,
} from '../validation/rules-allocation';

export type IcdStatus = 'CONSISTENT' | 'UNCARRIED' | 'UNUSED' | 'UNJUDGED';

export interface IcdEnd {
  /** The part the end hangs on, qualified. */
  part: string;
  /** The port usage, qualified (undefined when the end is not a port). */
  port?: string;
  portDefinition?: string;
  conjugated: boolean;
}

export interface IcdItem {
  item: string;
  /** `fromEnd` 0 means A to B, 1 means B to A. */
  direction: 'A->B' | 'B->A';
}

export interface IcdFlow {
  flow: string;
  item?: string;
  sender?: string;
  receiver?: string;
}

export interface IcdRow {
  connection: string;
  kind: string;
  ends: [IcdEnd, IcdEnd];
  items: IcdItem[];
  flows: IcdFlow[];
  /** Connections allocated to this one (a physical link carries them). */
  carries: string[];
  /** The links this connection is allocated to. */
  allocatedTo: string[];
  status: IcdStatus;
  findings: string[];
}

export interface IcdReport {
  owner?: string;
  rows: IcdRow[];
  unallocated: { flow: string; message: string }[];
  verdict: { uncarried: number; unallocated: number; exitCode: 0 | 1 | 2 };
}

const q = (model: Model, id: ElementId | undefined) => (id ? model.qualifiedName(id) || label(model, id) : '?');

function within(model: Model, el: ElementRecord, owner: ElementId): boolean {
  const seen = new Set<ElementId>();
  let cur: ElementId | null | undefined = el.id;
  while (cur && !seen.has(cur)) {
    if (cur === owner) return true;
    seen.add(cur);
    cur = model.get(cur)?.ownerId;
  }
  return false;
}

function endOf(model: Model, endId: ElementId | undefined): IcdEnd {
  const owner = endOwner(model, endId);
  const port = endId ? model.get(endId) : undefined;
  const isPort = port?.eClass === 'PortUsage';
  return {
    part: q(model, owner?.id),
    ...(isPort ? { port: q(model, port.id), conjugated: portConjugated(model, port.id) } : { conjugated: false }),
    ...(isPort ? { portDefinition: declaredDefinitions(model, port.id)[0]?.declaredName } : {}),
  } as IcdEnd;
}

export function icdReport(model: Model, owner?: ElementId): IcdReport {
  const inScope = (el: ElementRecord) => el.attrs.isLibrary !== true && (owner === undefined || within(model, el, owner));
  const findingsByAlloc = new Map<ElementId, string>();
  for (const d of exchangeAllocation.run(model)) if (d.elementId) findingsByAlloc.set(d.elementId, d.message);

  const flowsOf = new Map<ElementId, IcdFlow[]>();
  const carries = new Map<ElementId, string[]>();
  const allocatedTo = new Map<ElementId, string[]>();
  const findings = new Map<ElementId, string[]>();
  const allocScopes = new Set<ElementId | undefined>();
  for (const al of model.all()) {
    if (al.attrs.isLibrary === true || !ALLOCATION_KINDS.has(al.eClass)) continue;
    const from = al.source?.[0] ? model.get(al.source[0]) : undefined;
    const to = al.target?.[0] ? model.get(al.target[0]) : undefined;
    if (!from || !to || !LINK_KINDS.has(to.eClass)) continue;
    const push = <T>(m: Map<ElementId, T[]>, v: T) => m.set(to.id, [...(m.get(to.id) ?? []), v]);
    const msg = findingsByAlloc.get(al.id);
    if (msg) push(findings, msg);
    if (FLOW_KINDS.has(from.eClass)) {
      allocScopes.add(scopeOf(model, al));
      const payload = payloadOf(from);
      push(flowsOf, {
        flow: q(model, from.id),
        ...(payload ? { item: payload } : {}),
        ...(endOwner(model, from.source?.[0]) ? { sender: q(model, endOwner(model, from.source?.[0])!.id) } : {}),
        ...(endOwner(model, from.target?.[0]) ? { receiver: q(model, endOwner(model, from.target?.[0])!.id) } : {}),
      });
    } else if (LINK_KINDS.has(from.eClass)) {
      push(carries, q(model, from.id));
      allocatedTo.set(from.id, [...(allocatedTo.get(from.id) ?? []), q(model, to.id)]);
    }
  }

  const rows: IcdRow[] = [];
  for (const c of model.all()) {
    if (!LINK_KINDS.has(c.eClass) || !inScope(c)) continue;
    const a = c.source?.[0];
    const b = c.target?.[0];
    if (a === undefined || b === undefined) continue;
    const ends: [IcdEnd, IcdEnd] = [endOf(model, a), endOf(model, b)];
    const items: IcdItem[] = [];
    const seen = new Set<string>();
    [a, b].forEach((p, i) => {
      if (model.get(p)?.eClass !== 'PortUsage') return;
      for (const f of directedFeaturesOf(model, p)) {
        const dirs: ('A->B' | 'B->A')[] =
          f.direction === 'inout' ? ['A->B', 'B->A'] : (f.direction === 'out') === (i === 0) ? ['A->B'] : ['B->A'];
        for (const direction of dirs) {
          const key = `${f.name}|${direction}`;
          if (!seen.has(key)) {
            seen.add(key);
            items.push({ item: f.name, direction });
          }
        }
      }
    });
    const flows = flowsOf.get(c.id) ?? [];
    const car = carries.get(c.id) ?? [];
    const found = findings.get(c.id) ?? [];
    const status: IcdStatus =
      found.length > 0
        ? 'UNCARRIED'
        : flows.length > 0 || car.length > 0
          ? 'CONSISTENT'
          : items.length > 0 && allocScopes.has(scopeOf(model, c))
            ? 'UNUSED'
            : 'UNJUDGED';
    rows.push({
      connection: q(model, c.id),
      kind: c.eClass,
      ends,
      items,
      flows,
      carries: car,
      allocatedTo: allocatedTo.get(c.id) ?? [],
      status,
      findings: found,
    });
  }

  const unallocated = exchangeUnallocated
    .run(model)
    .filter((d) => d.elementId && inScope(model.get(d.elementId)!))
    .map((d) => ({ flow: q(model, d.elementId), message: d.message }));
  const uncarried = rows.filter((r) => r.status === 'UNCARRIED').length;
  const exitCode = rows.length === 0 && unallocated.length === 0 ? 2 : uncarried > 0 || unallocated.length > 0 ? 1 : 0;
  return { ...(owner ? { owner: q(model, owner) } : {}), rows, unallocated, verdict: { uncarried, unallocated: unallocated.length, exitCode } };
}

export function icdLines(r: IcdReport, name: string): string[] {
  const n = (s: IcdStatus) => r.rows.filter((x) => x.status === s).length;
  const out = [
    `${name}: ${r.rows.length} connection(s) — ${n('CONSISTENT')} CONSISTENT, ${n('UNCARRIED')} UNCARRIED, ${n('UNUSED')} UNUSED, ${n('UNJUDGED')} UNJUDGED; ${r.unallocated.length} crossing flow(s) allocated to no connection`,
  ];
  for (const w of r.rows) {
    const e = (x: IcdEnd) => `${x.port ?? x.part}${x.portDefinition ? ` : ${x.conjugated ? '~' : ''}${x.portDefinition}` : ''}`;
    out.push(`  ${w.status.padEnd(10)} ${w.connection}  ${e(w.ends[0])}  <->  ${e(w.ends[1])}`);
    for (const i of w.items) out.push(`      item ${i.item} ${i.direction}`);
    for (const f of w.flows) out.push(`      flow ${f.flow}${f.item ? ` (${f.item})` : ''}: ${f.sender ?? '?'} -> ${f.receiver ?? '?'}`);
    for (const c of w.carries) out.push(`      carries ${c}`);
    for (const m of w.findings) out.push(`      ! ${m}`);
  }
  for (const u of r.unallocated) out.push(`  UNALLOCATED ${u.flow}: ${u.message}`);
  return out;
}
