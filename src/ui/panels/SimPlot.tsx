/**
 * SimPlot — a compact inline-SVG line chart of simulation value time-series.
 *
 * Plots one polyline per selected value key across the captured samples, with the
 * x-axis either the sample index or the simulation clock. Booleans render as 0/1;
 * non-numeric values create gaps. Themed via the diagram palette tokens so it
 * follows light/dark automatically. A vertical cursor marks the current sample.
 */

import { useMemo } from 'react';
import type { SimSample, SimValue } from '@semantics/index';

const W = 560;
const H = 168;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24;

const SERIES_COLORS = [
  'var(--accent)',
  'var(--dgm-orange, #b45309)',
  'var(--dgm-teal, #0e7490)',
  'var(--dgm-purple, #7c3aed)',
  'var(--dgm-green, #1a7f37)',
  'var(--dgm-violet, #9333ea)',
];

/** Coerce a sim value to a plottable number (booleans → 0/1), or null. */
function num(v: SimValue | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

/** A key's value at a sample: the machine value, else the parametric-solved value. */
function valAt(s: SimSample, k: string): number | null {
  const v = num(s.values[k]);
  if (v !== null) return v;
  const solved = s.solved[k];
  return typeof solved === 'number' && Number.isFinite(solved) ? solved : null;
}

export function SimPlot(props: {
  samples: readonly SimSample[];
  keys: string[];
  xBy: 'index' | 'clock';
  cursor: number;
}): JSX.Element {
  const { samples, keys, xBy, cursor } = props;

  const model = useMemo(() => {
    const xs = samples.map((s, i) => (xBy === 'clock' ? s.clock : i));
    const xMin = xs.length ? Math.min(...xs) : 0;
    const xMax = xs.length ? Math.max(...xs) : 1;
    const xSpan = xMax - xMin || 1;

    let yMin = Infinity;
    let yMax = -Infinity;
    for (const k of keys) {
      for (const s of samples) {
        const y = valAt(s, k);
        if (y === null) continue;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    if (!Number.isFinite(yMin)) {
      yMin = 0;
      yMax = 1;
    }
    if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    }
    const ySpan = yMax - yMin;

    const px = (x: number): number => PAD_L + ((x - xMin) / xSpan) * (W - PAD_L - PAD_R);
    const py = (y: number): number => H - PAD_B - ((y - yMin) / ySpan) * (H - PAD_T - PAD_B);

    const series = keys.map((k, ki) => {
      const pts: string[] = [];
      samples.forEach((s, i) => {
        const y = valAt(s, k);
        if (y === null) return;
        pts.push(`${px(xs[i]).toFixed(1)},${py(y).toFixed(1)}`);
      });
      return { key: k, color: SERIES_COLORS[ki % SERIES_COLORS.length], points: pts.join(' ') };
    });

    const cursorX = px(xs[Math.max(0, Math.min(cursor, xs.length - 1))] ?? xMin);
    return { series, yMin, yMax, cursorX, px, py };
  }, [samples, keys, xBy, cursor]);

  return (
    <svg
      className="sim-plot"
      data-testid="sim-plot"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Simulation value time-series"
    >
      {/* axes */}
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} stroke="var(--border)" strokeWidth={1} />
      <line
        x1={PAD_L}
        y1={H - PAD_B}
        x2={W - PAD_R}
        y2={H - PAD_B}
        stroke="var(--border)"
        strokeWidth={1}
      />
      {/* y range labels */}
      <text x={PAD_L - 6} y={PAD_T + 4} textAnchor="end" className="sim-plot-axis">
        {model.yMax.toFixed(2)}
      </text>
      <text x={PAD_L - 6} y={H - PAD_B} textAnchor="end" className="sim-plot-axis">
        {model.yMin.toFixed(2)}
      </text>
      <text x={W - PAD_R} y={H - 6} textAnchor="end" className="sim-plot-axis">
        {xBy === 'clock' ? 'clock' : 'step'}
      </text>
      {/* cursor */}
      <line
        x1={model.cursorX}
        y1={PAD_T}
        x2={model.cursorX}
        y2={H - PAD_B}
        stroke="var(--accent)"
        strokeWidth={1}
        strokeDasharray="3 3"
        opacity={0.6}
      />
      {/* series */}
      {model.series.map((s) =>
        s.points ? (
          <polyline
            key={s.key}
            points={s.points}
            fill="none"
            stroke={s.color}
            strokeWidth={1.6}
            strokeLinejoin="round"
          />
        ) : null,
      )}
    </svg>
  );
}

export default SimPlot;
