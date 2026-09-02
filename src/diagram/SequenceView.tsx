/**
 * SequenceView — render a {@link SequenceDiagram} as SVG.
 *
 * Each lifeline is a header box atop a vertical dashed line (docs/02 §4.2:
 * "box header atop a vertical dashed lifeline"). Messages are drawn as
 * horizontal arrows between lifelines, ordered top→bottom by `order`, each
 * labelled with the message name. Purely presentational and prop-driven;
 * clicking a lifeline header selects its element, clicking a message arrow/label
 * selects the backing message element via `onSelect`.
 */

import type { CSSProperties } from 'react';
import type { SequenceDiagram } from './types';

export interface SequenceViewProps {
  sequence: SequenceDiagram;
  /** Called with an element id when a lifeline header or a message is clicked. */
  onSelect?: (elementId: string) => void;
}

/* Layout constants (px). */
const COL_W = 160;
const MARGIN_X = 40;
const HEADER_Y = 12;
const HEADER_H = 30;
const HEADER_W = 120;
const FIRST_MSG_Y = HEADER_H + 50;
const ROW_H = 44;
const BOTTOM_PAD = 30;

const headerBoxStyle: CSSProperties = { fill: 'var(--node-header)', stroke: 'var(--node-line)', cursor: 'pointer' };
const headerTextStyle: CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};
const lifelineStyle: CSSProperties = { stroke: 'var(--node-muted)', strokeWidth: 1, strokeDasharray: '4 4' };
const msgLineStyle: CSSProperties = { stroke: 'var(--node-fg)', strokeWidth: 1.5, cursor: 'pointer' };
const msgLabelStyle: CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  fontSize: 11,
  fill: 'var(--node-fg)',
  cursor: 'pointer',
};

export function SequenceView({ sequence, onSelect }: SequenceViewProps): JSX.Element {
  const { lifelines, messages } = sequence;

  // Column centre-x per lifeline id.
  const centreX = new Map<string, number>();
  lifelines.forEach((ll, i) => centreX.set(ll.id, MARGIN_X + i * COL_W + HEADER_W / 2));

  const ordered = [...messages].sort((a, b) => a.order - b.order);
  const height = FIRST_MSG_Y + ordered.length * ROW_H + BOTTOM_PAD;
  const width = MARGIN_X * 2 + Math.max(1, lifelines.length) * COL_W;

  const select = (id?: string): void => {
    if (id && onSelect) onSelect(id);
  };

  return (
    <svg
      data-testid="sequence-view"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
    >
      <defs>
        <marker
          id="seq-arrow"
          markerWidth="10"
          markerHeight="10"
          refX="8"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L8,3 L0,6 Z" fill="var(--node-fg)" />
        </marker>
      </defs>

      {/* Lifelines: header box + vertical dashed line. */}
      {lifelines.map((ll) => {
        const cx = centreX.get(ll.id)!;
        return (
          <g key={ll.id} data-testid="sequence-lifeline" data-element-id={ll.elementId}>
            <line x1={cx} y1={HEADER_Y + HEADER_H} x2={cx} y2={height - BOTTOM_PAD} style={lifelineStyle} />
            <rect
              x={cx - HEADER_W / 2}
              y={HEADER_Y}
              width={HEADER_W}
              height={HEADER_H}
              style={headerBoxStyle}
              onClick={() => select(ll.elementId)}
            />
            <text
              x={cx}
              y={HEADER_Y + HEADER_H / 2 + 4}
              textAnchor="middle"
              style={headerTextStyle}
              onClick={() => select(ll.elementId)}
            >
              {ll.label}
            </text>
          </g>
        );
      })}

      {/* Messages: horizontal arrows top→bottom by order. */}
      {ordered.map((msg, i) => {
        const x1 = centreX.get(msg.fromLifeline);
        const x2 = centreX.get(msg.toLifeline);
        if (x1 === undefined || x2 === undefined) return null;
        const y = FIRST_MSG_Y + i * ROW_H;
        const self = msg.fromLifeline === msg.toLifeline;
        const labelX = self ? x1 + 10 : (x1 + x2) / 2;
        return (
          <g
            key={msg.id}
            data-testid="sequence-message"
            data-order={msg.order}
            data-element-id={msg.elementId}
            onClick={() => select(msg.elementId)}
          >
            {self ? (
              <path
                d={`M${x1},${y} h40 v18 h-40`}
                fill="none"
                style={msgLineStyle}
                markerEnd="url(#seq-arrow)"
              />
            ) : (
              <line x1={x1} y1={y} x2={x2} y2={y} style={msgLineStyle} markerEnd="url(#seq-arrow)" />
            )}
            {msg.label ? (
              <text x={labelX} y={y - 6} textAnchor="middle" style={msgLabelStyle}>
                {msg.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export default SequenceView;
