/**
 * Legend — a collapsible overlay (bottom-left of the canvas) that explains the
 * relationship notation actually present in the ACTIVE view: it groups the
 * diagram's edge kinds into notation families and shows a line sample + marker
 * glyph + label for each family that appears. Purely presentational, driven by
 * the current diagram's edges.
 */

import { useMemo, useState } from 'react';
import type { DiagramEdge } from '@diagram/index';

interface Family {
  key: string;
  label: string;
  glyph: string;
  color: string;
  dashed: boolean;
  kinds: string[];
}

/** Notation families, in reading order. `color`/`dashed`/`glyph` mirror edges.tsx. */
const FAMILIES: Family[] = [
  { key: 'composition', label: 'Composition', glyph: '◆', color: 'var(--node-line)', dashed: false, kinds: ['composite', 'composition'] },
  { key: 'reference', label: 'Reference / aggregation', glyph: '◇', color: 'var(--node-line)', dashed: false, kinds: ['aggregate', 'aggregation', 'reference'] },
  { key: 'specialize', label: 'Specialization / typing', glyph: '▷', color: 'var(--node-line)', dashed: false, kinds: ['specialize', 'specialization', 'subclassification', 'subsetting', 'redefinition', 'typed-by', 'typing', 'feature-typing'] },
  { key: 'flow', label: 'Succession / flow / binding', glyph: '▸', color: 'var(--node-line)', dashed: false, kinds: ['succession', 'transition', 'flow', 'succession-flow', 'bind', 'binding'] },
  { key: 'connection', label: 'Connection', glyph: '—', color: 'var(--dgm-blue)', dashed: false, kinds: ['connection', 'interface', 'actor', 'subject', 'objective', 'stakeholder'] },
  { key: 'containment', label: 'Containment', glyph: '⊕', color: 'var(--node-muted)', dashed: false, kinds: ['containment'] },
  { key: 'dependency', label: 'Dependency (satisfy, derive, …)', glyph: '▹', color: 'var(--dgm-violet)', dashed: true, kinds: ['include', 'satisfy', 'verify', 'refine', 'derive', 'trace', 'allocate', 'dependency'] },
];

export function Legend({ edges }: { edges: DiagramEdge[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const present = useMemo(() => {
    const kinds = new Set(edges.map((e) => e.kind));
    return FAMILIES.filter((f) => f.kinds.some((k) => kinds.has(k)));
  }, [edges]);

  if (present.length === 0) return null;

  return (
    <div className="diagram-legend" data-testid="diagram-legend">
      <button
        type="button"
        className="diagram-legend-toggle"
        data-testid="legend-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Legend
      </button>
      {open && (
        <ul className="diagram-legend-list" data-testid="legend-list">
          {present.map((f) => (
            <li key={f.key}>
              <span
                className="legend-swatch"
                style={{ borderTopStyle: f.dashed ? 'dashed' : 'solid', borderTopColor: f.color }}
              />
              <span className="legend-glyph" style={{ color: f.color }} aria-hidden="true">
                {f.glyph}
              </span>
              <span>{f.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default Legend;
