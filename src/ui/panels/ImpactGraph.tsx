/**
 * ImpactGraph — a compact, selection-driven radial graph of an element's 1-hop
 * reference neighbourhood: the focus element at the centre, its neighbours on a
 * ring, with directed edges showing which neighbours REFERENCE the focus
 * (fan-in, arrow → centre) and which the focus REFERENCES (fan-out, arrow →
 * neighbour). Neighbours are click-to-navigate. Pure SVG, themed via tokens.
 */

import { useMemo } from 'react';
import type { Model, ElementId } from '@core/index';

const MAX_NEIGHBOURS = 12;

interface Neighbour {
  id: string;
  label: string;
  dir: 'in' | 'out' | 'both';
}

function neighboursOf(model: Model, id: ElementId): Neighbour[] {
  const acc = new Map<string, Neighbour>();
  for (const e of model.edgesOf(id)) {
    if (e.id === id) continue;
    const onSource = (e.source ?? []).includes(id);
    const others = (onSource ? e.target : e.source) ?? [];
    const dir = onSource ? 'out' : 'in';
    for (const oid of others) {
      if (oid === id) continue;
      const oe = model.get(oid);
      if (!oe) continue;
      const label = oe.declaredName || oe.declaredShortName || `«${oe.eClass}»`;
      const prev = acc.get(oid);
      if (!prev) acc.set(oid, { id: oid, label, dir });
      else if (prev.dir !== dir) prev.dir = 'both';
    }
  }
  return [...acc.values()];
}

export function ImpactGraph(props: {
  model: Model;
  focusId: ElementId;
  /** Store revision — recompute when the model mutates while the graph is open. */
  rev: number;
  onSelect: (id: ElementId) => void;
}): JSX.Element {
  const { model, focusId, rev, onSelect } = props;
  const focus = model.get(focusId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => neighboursOf(model, focusId), [model, focusId, rev]);
  const neighbours = all.slice(0, MAX_NEIGHBOURS);
  const hiddenCount = all.length - neighbours.length;

  const W = 280;
  const H = 200;
  const cx = W / 2;
  const cy = H / 2;
  const R = 74;
  const focusLabel = focus?.declaredName || focus?.declaredShortName || '(selection)';

  if (neighbours.length === 0) {
    return <div className="rel-empty">No direct references.</div>;
  }

  return (
    <svg
      className="impact-graph"
      data-testid="impact-graph"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Reference neighbourhood graph"
    >
      <defs>
        <marker id="ig-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
          <path d="M0,0 L7,3 L0,6 Z" fill="var(--node-line)" />
        </marker>
      </defs>
      {neighbours.map((n, i) => {
        const a = (i / neighbours.length) * Math.PI * 2 - Math.PI / 2;
        const nx = cx + Math.cos(a) * R;
        const ny = cy + Math.sin(a) * R;
        // Edge endpoints trimmed toward the node centres; arrow direction encodes
        // in (→ focus) vs out (→ neighbour); 'both' draws toward the neighbour.
        const inward = n.dir === 'in';
        const x1 = inward ? nx : cx;
        const y1 = inward ? ny : cy;
        const x2 = inward ? cx : nx;
        const y2 = inward ? cy : ny;
        return (
          <g key={n.id}>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="var(--node-line)"
              strokeWidth={1}
              markerEnd="url(#ig-arrow)"
              markerStart={n.dir === 'both' ? 'url(#ig-arrow)' : undefined}
            />
            <g
              className="impact-node"
              data-testid="impact-node"
              onClick={() => onSelect(n.id)}
              transform={`translate(${nx},${ny})`}
            >
              <circle r={5} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth={1} />
              <text x={Math.cos(a) >= 0 ? 8 : -8} y={3} textAnchor={Math.cos(a) >= 0 ? 'start' : 'end'}>
                {n.label.length > 14 ? `${n.label.slice(0, 13)}…` : n.label}
              </text>
            </g>
          </g>
        );
      })}
      <g transform={`translate(${cx},${cy})`}>
        <circle r={8} fill="var(--accent)" />
        <text y={-12} textAnchor="middle" className="impact-focus-label">
          {focusLabel.length > 18 ? `${focusLabel.slice(0, 17)}…` : focusLabel}
        </text>
      </g>
      {hiddenCount > 0 && (
        <text x={W - 4} y={H - 4} textAnchor="end" data-testid="impact-more">
          +{hiddenCount} more
        </text>
      )}
    </svg>
  );
}

export default ImpactGraph;
