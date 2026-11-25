/**
 * The Interconnection overlay: each connection drawn in the interconnection
 * view is coloured by its ICD status and carries its allocated flows in its
 * hover text. Everything is READ from `icdReport` (src/semantics/icd.ts) — the
 * UI recomputes no allocation fact.
 *
 * Colour: CONSISTENT, UNCARRIED and UNUSED each get a class (layout.css);
 * UNJUDGED (nothing allocated, and the scope allocates no flows) gets none, so
 * a model that does not use exchange allocation looks exactly as before.
 */
import type { ElementId, Model } from '@core/index';
import { icdReport, type IcdRow, type IcdStatus } from '../semantics/icd';
import { LINK_KINDS } from '../validation/rules-allocation';

/** The edge class of a status, or undefined for "no colour change". */
export function icdEdgeClass(status: IcdStatus): string | undefined {
  return status === 'UNJUDGED' ? undefined : `rf-icd-${status.toLowerCase()}`;
}

/** Hover text: status line, then one line per allocated flow (name, item, direction), then findings. */
export function icdHoverText(row: IcdRow): string {
  const lines = [`ICD: ${row.status}`];
  for (const f of row.flows) {
    const dir = f.sender && f.receiver ? ` (${f.sender} -> ${f.receiver})` : '';
    lines.push(`flow ${f.flow}${f.item ? ` : ${f.item}` : ''}${dir}`);
  }
  if (row.flows.length === 0 && row.status === 'UNUSED') {
    lines.push(`unused: carries ${row.items.map((i) => `${i.item} ${i.direction}`).join(', ')}, nothing allocated`);
  }
  for (const m of row.findings) lines.push(m);
  return lines.join('\n');
}

export interface IcdEdgeMark {
  className: string;
  title: string;
}

/** Overlay per connection element id; empty when no row has a coloured status. */
export function icdOverlay(model: Model, owner?: ElementId): Map<ElementId, IcdEdgeMark> {
  const out = new Map<ElementId, IcdEdgeMark>();
  const rows = icdReport(model, owner).rows.filter((r) => icdEdgeClass(r.status) !== undefined);
  if (rows.length === 0) return out;
  const byName = new Map(rows.map((r) => [r.connection, r]));
  for (const el of model.all()) {
    if (!LINK_KINDS.has(el.eClass)) continue;
    const row = byName.get(model.qualifiedName(el.id));
    if (row) out.set(el.id, { className: icdEdgeClass(row.status)!, title: icdHoverText(row) });
  }
  return out;
}
