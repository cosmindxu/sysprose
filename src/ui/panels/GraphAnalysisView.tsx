/**
 * GraphAnalysisView — a Gephi-style network-analysis workbench + DSM, over the
 * live model. Two modes (toggle): a pan/zoom SVG force graph (nodes colored by
 * type or community, sized by centrality, clusters laid out spatially) and a
 * Design Structure Matrix (interaction heatmap + relation-kind glyphs, elements
 * reordered into module blocks). All configuration lives in `store.analysisConfig`;
 * changing it re-runs the analysis via the store's rebuild.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import {
  CATEGORY_LABELS,
  type AnalysisConfig,
  type DSMModel,
  type GraphAnalysisModel,
} from '@diagram/index';
import './panels.css';

/* ─────────────────────────────── config strip ────────────────────────────── */

function Select<T extends string>(props: {
  testid: string;
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <label className="ga-field">
      <span>{props.label}</span>
      <select
        data-testid={props.testid}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value as T)}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A labelled range slider showing its current value (×N or ×N.N). */
function Slider(props: {
  testid: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label className="ga-field ga-slider" title={props.label}>
      <span>
        {props.label} <b>×{props.value % 1 === 0 ? props.value : props.value.toFixed(2)}</b>
      </span>
      <input
        data-testid={props.testid}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.currentTarget.value))}
      />
    </label>
  );
}

function FilterPopover(props: {
  analysis: GraphAnalysisModel;
  config: AnalysisConfig;
  set: (patch: Partial<AnalysisConfig>) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const { analysis, config, set } = props;
  const toggle = (list: string[], key: string): string[] =>
    list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  const nodeActive = (e: string) => config.nodeKinds.length === 0 || config.nodeKinds.includes(e);
  // Containment is opt-in ONLY (never part of the empty="all" default); every
  // other edge kind is on when the filter is empty.
  const edgeActive = (k: string) =>
    k === 'containment'
      ? config.edgeKinds.includes('containment')
      : config.edgeKinds.length === 0 || config.edgeKinds.includes(k);
  /** The materialized "all" edge set — excludes containment so unchecking a real
   *  kind never silently switches containment on. */
  const edgeBase = () =>
    config.edgeKinds.length === 0
      ? analysis.edgeKindsPresent.map((k) => k.kind).filter((k) => k !== 'containment')
      : config.edgeKinds;
  const edgeFacets = [
    ...analysis.edgeKindsPresent,
    ...(analysis.edgeKindsPresent.some((f) => f.kind === 'containment')
      ? []
      : [{ kind: 'containment', count: 0 }]),
  ];
  return (
    <div className="ga-filter">
      <button data-testid="analysis-filter" className="ga-btn" onClick={() => setOpen((o) => !o)}>
        Filter ▾
      </button>
      {open && (
        <div className="ga-popover" data-testid="analysis-filter-popover">
          <div className="ga-popover-col">
            <div className="ga-popover-head">Node types</div>
            {analysis.nodeKindsPresent.map((f) => (
              <label key={f.eClass} className="ga-check">
                <input
                  type="checkbox"
                  checked={nodeActive(f.eClass)}
                  onChange={() => {
                    // Materialize the "all" state before toggling one off.
                    const base =
                      config.nodeKinds.length === 0
                        ? analysis.nodeKindsPresent.map((k) => k.eClass)
                        : config.nodeKinds;
                    set({ nodeKinds: toggle(base, f.eClass) });
                  }}
                />
                {f.eClass} <span className="ga-count">{f.count}</span>
              </label>
            ))}
          </div>
          <div className="ga-popover-col">
            <div className="ga-popover-head">Edge types</div>
            {edgeFacets.map((f) => (
              <label key={f.kind} className="ga-check">
                <input
                  type="checkbox"
                  checked={edgeActive(f.kind)}
                  onChange={() => set({ edgeKinds: toggle(edgeBase(), f.kind) })}
                />
                {f.kind} {f.count ? <span className="ga-count">{f.count}</span> : null}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────── graph (SVG) ──────────────────────────────── */

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function fitViewBox(a: GraphAnalysisModel, aspect: number): ViewBox {
  const pad = 60;
  let { minX, minY, maxX, maxY } = a.bounds;
  if (!Number.isFinite(minX) || maxX - minX < 1) {
    minX = -100;
    maxX = 100;
  }
  if (!Number.isFinite(minY) || maxY - minY < 1) {
    minY = -100;
    maxY = 100;
  }
  let w = maxX - minX + 2 * pad;
  let h = maxY - minY + 2 * pad;
  // Match the container aspect ratio so nothing is squashed.
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function GraphSvg(props: {
  analysis: GraphAnalysisModel;
  selectionId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { analysis, selectionId, onSelect } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [vb, setVb] = useState<ViewBox | null>(null);
  const pan = useRef<{ x: number; y: number; vb: ViewBox } | null>(null);

  // id → node, so the edge render is O(E) not O(E·N) (rebuilt only on new data).
  const nodeById = useMemo(() => new Map(analysis.nodes.map((n) => [n.id, n])), [analysis.nodes]);

  const { minX, minY, maxX, maxY } = analysis.bounds;
  // Fit the graph to the container whenever the projection (node set / bounds)
  // changes — not on selection.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const aspect = el && el.clientHeight > 0 ? el.clientWidth / el.clientHeight : 1.5;
    setVb(fitViewBox(analysis, aspect));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis.nodes.length, minX, minY, maxX, maxY]);

  const box = vb ?? { x: -500, y: -500, w: 1000, h: 1000 };

  // Zoom-about-cursor via a NATIVE non-passive wheel listener — React's wheel
  // handler is passive, so `preventDefault()` there throws a console error and
  // can't block the browser's ctrl+wheel zoom.
  const boxRef = useRef(box);
  boxRef.current = box;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const b = boxRef.current;
      const rect = el.getBoundingClientRect();
      const mx = b.x + ((e.clientX - rect.left) / rect.width) * b.w;
      const my = b.y + ((e.clientY - rect.top) / rect.height) * b.h;
      const factor = e.deltaY > 0 ? 1.1 : 0.9;
      setVb({ x: mx - (mx - b.x) * factor, y: my - (my - b.y) * factor, w: b.w * factor, h: b.h * factor });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  return (
    <div className="ga-graph-wrap" ref={wrapRef} data-testid="graph-analysis-graph">
      <svg
        className="ga-svg"
        data-testid="graph-svg"
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={(e) => {
          pan.current = { x: e.clientX, y: e.clientY, vb: box };
        }}
        onMouseMove={(e) => {
          if (!pan.current || !wrapRef.current) return;
          const rect = wrapRef.current.getBoundingClientRect();
          const dx = ((e.clientX - pan.current.x) / rect.width) * pan.current.vb.w;
          const dy = ((e.clientY - pan.current.y) / rect.height) * pan.current.vb.h;
          setVb({ ...pan.current.vb, x: pan.current.vb.x - dx, y: pan.current.vb.y - dy });
        }}
        onMouseUp={() => (pan.current = null)}
        onMouseLeave={() => (pan.current = null)}
      >
        <g>
          {analysis.edges.map((e) => {
            const s = nodeById.get(e.source);
            const t = nodeById.get(e.target);
            if (!s || !t) return null;
            return (
              <line
                key={e.id}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                stroke={e.color}
                strokeWidth={Math.max(0.6, box.w / 1400)}
                strokeDasharray={e.containment ? `${box.w / 260} ${box.w / 400}` : undefined}
                opacity={0.7}
              />
            );
          })}
          {analysis.nodes.map((n) => {
            const selected = n.id === selectionId;
            return (
              <g
                key={n.id}
                data-testid="graph-node"
                data-element-id={n.id}
                transform={`translate(${n.x},${n.y})`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(n.id);
                }}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  r={n.size}
                  fill={n.color}
                  stroke={selected ? 'var(--accent)' : '#fff'}
                  strokeWidth={selected ? n.size * 0.4 + 1.5 : 1}
                />
                <text
                  x={n.size + 2}
                  y={3}
                  fontSize={Math.max(6, box.w / 130)}
                  fill="var(--text, #2d3748)"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

/* ─────────────────────────────────── DSM ─────────────────────────────────── */

/** Blue heatmap: intensity 0..1 → light→saturated fill. */
function heat(t: number): string {
  const a = 0.12 + 0.83 * Math.min(1, Math.max(0, t));
  return `rgba(43, 108, 176, ${a.toFixed(3)})`;
}

function DsmSvg(props: {
  dsm: DSMModel;
  selectionId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { dsm, selectionId, onSelect } = props;
  const n = dsm.elements.length;
  const CELL = 24;
  const LABEL = 150;
  const size = n * CELL;
  const truncate = (s: string) => (s.length > 20 ? s.slice(0, 19) + '…' : s);

  return (
    <div className="ga-dsm-scroll" data-testid="dsm-view">
      <svg
        data-testid="dsm-svg"
        width={LABEL + size + 8}
        height={LABEL + size + 8}
        style={{ fontFamily: 'var(--font, sans-serif)' }}
      >
        {/* Module blocks (diagonal) */}
        {dsm.modules.map((mod) => (
          <rect
            key={`mod${mod.index}-${mod.start}`}
            x={LABEL + mod.start * CELL}
            y={LABEL + mod.start * CELL}
            width={mod.size * CELL}
            height={mod.size * CELL}
            fill={mod.color}
            fillOpacity={0.08}
            stroke={mod.color}
            strokeWidth={1.5}
          />
        ))}
        {/* Column headers (rotated) */}
        {dsm.elements.map((el, j) => (
          <text
            key={`col${el.id}`}
            transform={`translate(${LABEL + j * CELL + CELL / 2}, ${LABEL - 4}) rotate(-60)`}
            fontSize={10}
            fill={el.id === selectionId ? '#2b6cb0' : 'var(--text-muted, #718096)'}
            style={{ cursor: 'pointer' }}
            onClick={() => onSelect(el.id)}
          >
            {truncate(el.label)}
          </text>
        ))}
        {/* Row headers */}
        {dsm.elements.map((el, i) => (
          <text
            key={`row${el.id}`}
            x={LABEL - 6}
            y={LABEL + i * CELL + CELL / 2 + 3}
            fontSize={10}
            textAnchor="end"
            fill={el.id === selectionId ? '#2b6cb0' : 'var(--text, #2d3748)'}
            style={{ cursor: 'pointer' }}
            data-testid="dsm-row-label"
            data-element-id={el.id}
            onClick={() => onSelect(el.id)}
          >
            {i + 1}. {truncate(el.label)}
          </text>
        ))}
        {/* Grid lines (O(n), not a rect per cell) */}
        {dsm.elements.map((_e, i) => (
          <g key={`grid${i}`}>
            <line
              x1={LABEL}
              y1={LABEL + i * CELL}
              x2={LABEL + size}
              y2={LABEL + i * CELL}
              stroke="var(--border, #e2e8f0)"
              strokeWidth={0.5}
            />
            <line
              x1={LABEL + i * CELL}
              y1={LABEL}
              x2={LABEL + i * CELL}
              y2={LABEL + size}
              stroke="var(--border, #e2e8f0)"
              strokeWidth={0.5}
            />
            {/* Diagonal cell shading */}
            <rect
              x={LABEL + i * CELL}
              y={LABEL + i * CELL}
              width={CELL}
              height={CELL}
              fill="var(--bg-muted, #edf2f7)"
            />
          </g>
        ))}
        <rect
          x={LABEL}
          y={LABEL}
          width={size}
          height={size}
          fill="none"
          stroke="var(--border-strong, #cbd5e0)"
          strokeWidth={1}
        />
        {/* Only OCCUPIED cells (the actual interactions) — not n² rects. */}
        {dsm.cells.map((cell) => {
          const x = LABEL + cell.col * CELL;
          const y = LABEL + cell.row * CELL;
          const t = cell.weight / (dsm.maxWeight || 1);
          return (
            <g key={`cell${cell.row}-${cell.col}`}>
              <rect
                x={x}
                y={y}
                width={CELL}
                height={CELL}
                fill={heat(t)}
                onClick={() => onSelect(dsm.elements[cell.row].id)}
                style={{ cursor: 'pointer' }}
              >
                <title>{`${dsm.elements[cell.row].label} → ${dsm.elements[cell.col].label}: ${cell.kinds.join(', ')} (${cell.weight})`}</title>
              </rect>
              <text
                x={x + CELL / 2}
                y={y + CELL / 2 + 4}
                fontSize={12}
                textAnchor="middle"
                fill={t > 0.6 ? '#fff' : '#1a202c'}
                style={{ pointerEvents: 'none' }}
              >
                {cell.symbol}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ─────────────────────────────── legend ──────────────────────────────────── */

function Legend(props: {
  analysis: GraphAnalysisModel;
  config: AnalysisConfig;
  set: (patch: Partial<AnalysisConfig>) => void;
}): JSX.Element {
  const { analysis, config, set } = props;
  const editable = config.colorBy === 'type';
  return (
    <div className="ga-legend" data-testid="analysis-legend">
      {analysis.legend.map((e) => (
        <div key={e.key} className="ga-legend-row">
          {editable ? (
            <input
              type="color"
              className="ga-swatch-input"
              data-testid="analysis-color"
              value={e.color}
              title={`Color for ${e.label}`}
              onChange={(ev) =>
                set({ colorOverrides: { ...config.colorOverrides, [e.key]: ev.currentTarget.value } })
              }
            />
          ) : (
            <span className="ga-swatch" style={{ background: e.color }} />
          )}
          <span className="ga-legend-label">{CATEGORY_LABELS[e.key] ?? e.label}</span>
          <span className="ga-count">{e.count}</span>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────── main view ───────────────────────────────── */

export function GraphAnalysisView(): JSX.Element {
  const analysis = useAppStore((s) => s.analysis);
  const dsm = useAppStore((s) => s.dsm);
  const config = useAppStore((s) => s.analysisConfig);
  const selectionId = useAppStore((s) => s.selectionId);
  const select = useAppStore((s) => s.select);
  const setAnalysisConfig = useAppStore((s) => s.setAnalysisConfig);
  const regroupFromCluster = useAppStore((s) => s.regroupFromCluster);
  const set = (patch: Partial<AnalysisConfig>) => setAnalysisConfig(patch);

  if (!analysis) {
    return (
      <div className="ga-wrap" data-testid="graph-analysis">
        <div className="center-empty">Building analysis…</div>
      </div>
    );
  }

  // "Regroup cluster": hand the selected node's whole community to the Regroup
  // Workbench. Enabled only in graph mode with clustering on and a clustered
  // node selected (community ≥ 0).
  const selectedNode = analysis.nodes.find((n) => n.id === selectionId) ?? null;
  const clusterId = selectedNode?.community ?? -1;
  const canRegroupCluster =
    config.mode === 'graph' && config.clustering !== 'none' && clusterId >= 0;
  const regroupSelectedCluster = (): void => {
    if (clusterId < 0) return;
    const ids = analysis.nodes.filter((n) => n.community === clusterId).map((n) => n.id);
    regroupFromCluster(ids, `Cluster ${clusterId + 1}`);
  };

  return (
    <div className="ga-wrap" data-testid="graph-analysis">
      <div className="ga-config">
        <div className="ga-modes">
          <button
            data-testid="analysis-mode-graph"
            className={`ga-btn${config.mode === 'graph' ? ' is-active' : ''}`}
            onClick={() => set({ mode: 'graph' })}
          >
            Graph
          </button>
          <button
            data-testid="analysis-mode-dsm"
            className={`ga-btn${config.mode === 'dsm' ? ' is-active' : ''}`}
            onClick={() => set({ mode: 'dsm' })}
          >
            DSM
          </button>
        </div>
        <FilterPopover analysis={analysis} config={config} set={set} />
        {config.mode === 'graph' ? (
          <>
            <Select
              testid="analysis-layout"
              label="Layout"
              value={config.layout}
              options={[
                { value: 'force', label: 'Force-directed' },
                { value: 'circular', label: 'Circular' },
                { value: 'grid', label: 'Grid' },
              ]}
              onChange={(layout) => set({ layout })}
            />
            <Select
              testid="analysis-clustering"
              label="Clustering"
              value={config.clustering}
              options={[
                { value: 'louvain', label: 'Louvain' },
                { value: 'labelprop', label: 'Label prop.' },
                { value: 'components', label: 'Components' },
                { value: 'none', label: 'None' },
              ]}
              onChange={(clustering) => set({ clustering })}
            />
            <Select
              testid="analysis-size"
              label="Size by"
              value={config.sizeBy}
              options={[
                { value: 'degree', label: 'Degree' },
                { value: 'in-degree', label: 'In-Degree' },
                { value: 'out-degree', label: 'Out-Degree' },
                { value: 'pagerank', label: 'PageRank' },
                { value: 'uniform', label: 'Uniform' },
              ]}
              onChange={(sizeBy) => set({ sizeBy })}
            />
            <Slider
              testid="analysis-size-scale"
              label="Size"
              value={config.sizeScale}
              min={0.5}
              max={3}
              step={0.1}
              onChange={(sizeScale) => set({ sizeScale })}
            />
            <Slider
              testid="analysis-size-contrast"
              label="Contrast"
              value={config.sizeContrast}
              min={0.5}
              max={4}
              step={0.25}
              onChange={(sizeContrast) => set({ sizeContrast })}
            />
            <Select
              testid="analysis-colorby"
              label="Color by"
              value={config.colorBy}
              options={[
                { value: 'type', label: 'Type' },
                { value: 'community', label: 'Cluster' },
              ]}
              onChange={(colorBy) => set({ colorBy })}
            />
            <button
              data-testid="analysis-regroup-cluster"
              className="ga-btn"
              disabled={!canRegroupCluster}
              title={
                canRegroupCluster
                  ? `Open the Regroup Workbench seeded with the selected node’s cluster (Cluster ${clusterId + 1})`
                  : 'Select a clustered node first, then regroup its whole community'
              }
              onClick={regroupSelectedCluster}
            >
              Regroup cluster
            </button>
          </>
        ) : (
          <Select
            testid="analysis-dsm-order"
            label="Modules"
            value={config.dsmOrder}
            options={[
              { value: 'louvain', label: 'Louvain modules' },
              { value: 'cuthill-mckee', label: 'Cuthill–McKee' },
              { value: 'declaration', label: 'Declaration order' },
            ]}
            onChange={(dsmOrder) => set({ dsmOrder })}
          />
        )}
        <span className="ga-stat" data-testid="analysis-stats">
          {analysis.nodes.length} nodes · {analysis.edges.length} edges
          {config.clustering !== 'none' && analysis.communityCount > 0
            ? ` · ${analysis.communityCount} clusters · Q=${analysis.modularity.toFixed(2)}`
            : ''}
        </span>
      </div>

      <div className="ga-body">
        {config.mode === 'graph' ? (
          <>
            <GraphSvg analysis={analysis} selectionId={selectionId} onSelect={select} />
            <Legend analysis={analysis} config={config} set={set} />
          </>
        ) : dsm ? (
          <DsmSvg dsm={dsm} selectionId={selectionId} onSelect={select} />
        ) : (
          <div className="center-empty">Building DSM…</div>
        )}
      </div>
    </div>
  );
}
