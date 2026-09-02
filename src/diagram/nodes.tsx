/**
 * React Flow custom node components for SysML v2 diagrams.
 *
 * These are purely presentational and prop-driven from {@link DiagramNode.data}
 * (as produced by {@link buildDiagram}). They render the canonical SysML box:
 * a «keyword» header, the element name, and optional attribute/port
 * compartments, plus boundary port handles for interconnection views.
 *
 * Heavy visual behaviour is covered by UI/E2E tests; unit tests focus on the
 * model→graph mapping and layout. The {@link nodeTypes} map is what React Flow
 * consumes.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo, type CSSProperties } from 'react';
import { TEXTUAL_KEYWORD, isRequirement } from '@core/index';

/* ────────────────────────────── styling ────────────────────────────────── */

const boxStyle: CSSProperties = {
  border: '1px solid var(--node-line)',
  borderRadius: 4,
  background: 'var(--node-bg)',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 12,
  minWidth: 140,
  boxSizing: 'border-box',
  overflow: 'hidden',
  // Fill the layout-assigned box so the DRAWN shape matches the box that the
  // handles anchor to and that FloatingEdge reads via useInternalNode — otherwise
  // a content-shorter node leaves its bottom handle / edge endpoint floating below
  // the outline (most visibly on the use-case ellipse). Content is centred so the
  // header/compartments sit in the middle of the filled shape.
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
};

const headerStyle: CSSProperties = {
  background: 'var(--node-header)',
  borderBottom: '1px solid var(--node-sep)',
  padding: '4px 8px',
  textAlign: 'center',
};

const keywordStyle: CSSProperties = { color: 'var(--node-muted)', fontStyle: 'italic', fontSize: 10 };
const nameStyle: CSSProperties = { fontWeight: 600 };
const badgeRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 3,
  justifyContent: 'center',
  marginTop: 2,
};
const badgeStyle: CSSProperties = {
  fontSize: 9,
  lineHeight: 1.4,
  padding: '0 4px',
  borderRadius: 3,
  background: 'var(--node-sep)',
  color: 'var(--node-line)',
};
const compartmentStyle: CSSProperties = {
  borderTop: '1px solid var(--node-sep)',
  padding: '3px 8px',
  fontSize: 11,
  color: 'var(--node-fg)',
};

/** Subtle default handles for node-to-node relationship edges. */
const bodyHandleStyle: CSSProperties = { width: 7, height: 7, background: 'var(--node-muted)', border: 'none' };
/** Visible boundary-port handle (interconnection view). */
const portHandleStyle: CSSProperties = {
  width: 9,
  height: 9,
  background: 'var(--node-line)',
  border: '1px solid var(--node-bg)',
  borderRadius: 2,
};

interface Compartment {
  id?: string;
  name?: string;
  type?: unknown;
  value?: unknown;
  direction?: unknown;
  multiplicity?: unknown;
}

function compartmentLabel(c: Compartment): string {
  let s = c.name ?? '';
  if (c.direction) s = `${String(c.direction)} ${s}`;
  if (c.type) s += ` : ${String(c.type)}`;
  if (c.multiplicity) s += ` [${String(c.multiplicity)}]`;
  if (c.value !== undefined && c.value !== null) s += ` = ${String(c.value)}`;
  return s.trim();
}

/**
 * Where along its side a boundary-port handle sits, as a CSS percentage.
 *
 * React Flow places every handle on a side at the same point, so N
 * same-direction ports would stack into one square and their connectors fan
 * into a single pixel — which wire binds which port becomes unreadable, and a
 * handle-drag cannot target one. The layout engine already distributes ports
 * (ELK `elk.portAlignment.default = DISTRIBUTED`); only the rendering collapsed
 * them. Percentages track the node box, which is pinned to the ELK size.
 *
 * Exported for testing: the renderer is deliberately unit-tested without a
 * React Flow context, so the arithmetic lives here rather than inline.
 */
export function portOffsetPercent(index: number, countOnSide: number): string {
  const n = Math.max(1, countOnSide);
  const i = Math.min(Math.max(index, 0), n - 1);
  return `${((i + 1) / (n + 1)) * 100}%`;
}

function sideToPosition(side: string): Position {
  switch (side) {
    case 'left':
      return Position.Left;
    case 'top':
      return Position.Top;
    case 'bottom':
      return Position.Bottom;
    default:
      return Position.Right;
  }
}

/* ──────────────────────────── components ───────────────────────────────── */

interface PortDescriptor {
  id: string;
  side: string;
  label: string;
}

interface SysmlNodeData {
  keyword?: string;
  name?: string;
  kind?: string;
  attributes?: Compartment[];
  ports?: Compartment[];
  boundaryPorts?: PortDescriptor[];
  isConstraint?: boolean;
  [k: string]: unknown;
}

/* ─────────────────────────── symbol resolvers ──────────────────────────── */

/** Control-node metaclasses → their SysML flow-symbol shape. */
export type ControlShape = 'bar' | 'diamond' | 'initial' | 'final' | 'node';

/**
 * Map a control-node metaclass to its canonical shape:
 * fork/join → thin bar, decision/merge → diamond, initial → filled circle,
 * done/final → ringed circle. Exposed (and unit-tested) so the symbol set is
 * verifiable without a React Flow render context.
 */
export function controlShapeFor(kind: string): ControlShape {
  switch (kind) {
    case 'ForkNode':
    case 'JoinNode':
      return 'bar';
    case 'DecisionNode':
    case 'MergeNode':
      return 'diamond';
    case 'InitialNode':
      return 'initial';
    case 'DoneNode':
      return 'final';
    default:
      return 'node';
  }
}

/** Distinct SysML box variants that get bespoke styling. */
export type NodeVariant =
  | 'constraint'
  | 'requirement'
  | 'case'
  | 'analysis'
  | 'verification'
  | 'viewpoint'
  | 'view'
  | 'default';

/**
 * Map a metaclass (and optional flags) to a visual box variant so the
 * requirement / constraint / case / analysis / verification / viewpoint / view
 * families each get a distinct shape+tint. Falls back to `'default'` for ordinary
 * structural boxes. Pure + unit-tested.
 */
export function nodeVariantFor(kind: string | undefined, data?: { isConstraint?: boolean }): NodeVariant {
  const k = kind ?? '';
  if (
    data?.isConstraint ||
    k === 'ConstraintUsage' ||
    k === 'ConstraintDefinition' ||
    k === 'CalculationUsage' ||
    k === 'CalculationDefinition'
  ) {
    return 'constraint';
  }
  if (isRequirement(k)) return 'requirement';
  if (k === 'AnalysisCaseUsage' || k === 'AnalysisCaseDefinition') return 'analysis';
  if (k === 'VerificationCaseUsage' || k === 'VerificationCaseDefinition') return 'verification';
  if (k === 'ViewpointUsage' || k === 'ViewpointDefinition') return 'viewpoint';
  if (k === 'ViewUsage' || k === 'ViewDefinition') return 'view';
  if (
    k === 'CaseUsage' ||
    k === 'CaseDefinition' ||
    k === 'UseCaseUsage' ||
    k === 'UseCaseDefinition'
  ) {
    return 'case';
  }
  return 'default';
}

/** Per-variant box overrides layered on top of {@link boxStyle}. */
function variantBoxStyle(variant: NodeVariant): CSSProperties {
  switch (variant) {
    case 'constraint':
      return { borderRadius: 14, borderColor: 'var(--dgm-green)', borderStyle: 'dashed' };
    case 'requirement':
      return { borderColor: 'var(--dgm-orange)' };
    case 'analysis':
      return { borderColor: 'var(--dgm-blue)' };
    case 'verification':
      return { borderColor: 'var(--dgm-teal)' };
    case 'viewpoint':
      return { borderColor: 'var(--dgm-purple)', borderStyle: 'dashed' };
    case 'view':
      return { borderColor: 'var(--dgm-purple)' };
    case 'case':
      // Use-case / case boxes render as an ELLIPSE (SysML use-case oval) so the
      // floating-edge ellipse intersection lands on the drawn outline. The extra
      // padding keeps the centred name clear of the curved sides.
      return { borderRadius: '50%', borderColor: 'var(--dgm-blue)', padding: '10px 22px' };
    default:
      return {};
  }
}

/** Per-variant header overrides. */
function variantHeaderStyle(variant: NodeVariant): CSSProperties {
  switch (variant) {
    case 'constraint':
      return { background: 'color-mix(in srgb, var(--node-bg) 88%, var(--dgm-green) 12%)' };
    case 'requirement':
      return { background: 'color-mix(in srgb, var(--node-bg) 88%, var(--dgm-orange) 12%)' };
    case 'analysis':
      return { background: 'color-mix(in srgb, var(--node-bg) 88%, var(--dgm-blue) 12%)' };
    case 'verification':
      return { background: 'color-mix(in srgb, var(--node-bg) 88%, var(--dgm-teal) 12%)' };
    case 'viewpoint':
    case 'view':
      return { background: 'color-mix(in srgb, var(--node-bg) 88%, var(--dgm-purple) 12%)' };
    case 'case':
      // Ellipse (use-case) node: no rectangular header fill or rule — keep the oval clean.
      return { background: 'transparent', borderBottom: 'none' };
    default:
      return {};
  }
}

/* ─────────────────────────── port symbol resolver ──────────────────────── */

/** Kind of boundary/compartment port and whether it is conjugated (`~`). */
export interface PortSymbol {
  /** proxy → open/hollow square; full → filled square. */
  shape: 'proxy' | 'full';
  /** True when the port is conjugated (`~Port`), drawn with a conjugation tick. */
  conjugated: boolean;
}

/** Read a possibly-nested attribute bag off a data payload. */
function attrsOf(data: unknown): Record<string, unknown> {
  const d = (data ?? {}) as Record<string, unknown>;
  const a = d.attrs;
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
}

/**
 * Resolve a port's SysML symbol from its data:
 *  - `shape`: PROXY ports (`attrs.portKind`/`portKind`/metaclass === 'proxy' /
 *    'ProxyPortUsage'…) render as an OPEN square; FULL ports as a FILLED square.
 *    Plain ports default to FULL.
 *  - `conjugated`: true when `attrs.conjugated`/`conjugated` is set or the label
 *    starts with the conjugation operator `~`.
 * Pure + unit-tested (no React Flow context needed).
 */
export function portSymbolFor(data: unknown): PortSymbol {
  const d = (data ?? {}) as Record<string, unknown>;
  const attrs = attrsOf(d);
  const rawKind = String(
    (d.portKind as string | undefined) ??
      (attrs.portKind as string | undefined) ??
      (d.kind as string | undefined) ??
      (d.eClass as string | undefined) ??
      '',
  ).toLowerCase();
  const shape: PortSymbol['shape'] = rawKind.includes('proxy') ? 'proxy' : 'full';

  const label = String(d.name ?? d.label ?? '');
  const conjugated =
    d.conjugated === true || attrs.conjugated === true || label.trimStart().startsWith('~');

  return { shape, conjugated };
}

/* ─────────────────────────── node adornments ───────────────────────────── */

/** Truthy test for a modifier flag on either the data payload or its attrs bag. */
function flag(data: Record<string, unknown>, name: string): boolean {
  const attrs = attrsOf(data);
  return data[name] === true || attrs[name] === true;
}

/**
 * The ordered set of textual adornments for a node. The first entry is always the
 * «keyword» guillemet for the metaclass (from {@link TEXTUAL_KEYWORD}); subsequent
 * entries flag `abstract`, `variation`, `variant`, `derived` and `readonly`
 * modifiers (read from `data.is*` or `data.attrs.is*`). Pure + unit-tested; the
 * renderer maps these to header text and badges.
 */
export function adornmentsFor(kind: string | undefined, data?: Record<string, unknown>): string[] {
  const d = (data ?? {}) as Record<string, unknown>;
  const k = kind ?? String(d.kind ?? '');
  const keyword = TEXTUAL_KEYWORD[k] ?? (typeof d.keyword === 'string' ? d.keyword : undefined) ?? k;
  const out: string[] = [`«${keyword}»`];
  if (flag(d, 'isAbstract')) out.push('abstract');
  if (flag(d, 'isVariation')) out.push('variation');
  if (flag(d, 'isVariant')) out.push('variant');
  if (flag(d, 'isDerived')) out.push('derived');
  if (flag(d, 'isReadonly') || flag(d, 'isReadOnly')) out.push('readonly');
  return out;
}

/** The display name with SysML modifier transforms (derived '/' prefix). */
function displayName(kind: string | undefined, data: Record<string, unknown>): string {
  const name = String(data.name ?? '');
  return flag(data, 'isDerived') && !name.startsWith('/') ? `/${name}` : name;
}

/**
 * The canonical SysML definition/usage box. Reads everything from `data`, so it
 * serves every node kind (a thin wrapper can specialise colours by `type`).
 */
export function SysmlNode({ data }: NodeProps): JSX.Element {
  const d = (data ?? {}) as SysmlNodeData;
  const attributes = Array.isArray(d.attributes) ? d.attributes : [];
  const ports = Array.isArray(d.ports) ? d.ports : [];
  const boundaryPorts = Array.isArray(d.boundaryPorts) ? d.boundaryPorts : [];
  const variant = nodeVariantFor(d.kind, d);

  // Adornments: [0] is the «keyword» guillemet; the rest are modifier badges.
  const adornments = adornmentsFor(d.kind, d as Record<string, unknown>);
  const keywordLabel =
    adornments[0] ?? (variant === 'constraint' ? '«constraint»' : undefined);
  const badges = adornments.slice(1);
  const isAbstract = flag(d as Record<string, unknown>, 'isAbstract');
  const isVariation = flag(d as Record<string, unknown>, 'isVariation');
  const name = displayName(d.kind, d as Record<string, unknown>);

  // Definition boxes read heavier than usage boxes; variation is dashed.
  const defUsageStyle: CSSProperties = {
    ...(d.isDefinition ? { borderWidth: 2 } : {}),
    ...(isVariation ? { borderStyle: 'dashed' } : {}),
  };

  return (
    <div
      style={{ ...boxStyle, ...variantBoxStyle(variant), ...defUsageStyle }}
      data-testid="sysml-node"
      data-node-variant={variant}
      data-abstract={isAbstract || undefined}
      data-variation={isVariation || undefined}
    >
      {/* Default (unnamed) handles so node-to-node relationship edges — composition,
          feature typing, specialization, satisfy/allocate, containment — attach and
          render in EVERY view. React Flow drops edges that have no handle to bind. */}
      <Handle type="target" position={Position.Top} className="body-handle" style={bodyHandleStyle} />
      <Handle type="source" position={Position.Bottom} className="body-handle" style={bodyHandleStyle} />
      <div style={{ ...headerStyle, ...variantHeaderStyle(variant) }}>
        {keywordLabel ? <div style={keywordStyle}>{keywordLabel}</div> : null}
        <div style={{ ...nameStyle, ...(isAbstract ? { fontStyle: 'italic' } : {}) }}>{name}</div>
        {badges.length > 0 && (
          <div style={badgeRowStyle}>
            {badges.map((b) => (
              <span key={b} data-testid="node-adornment" data-adornment={b} style={badgeStyle}>
                {b === 'readonly' ? '■ readonly' : b}
              </span>
            ))}
          </div>
        )}
      </div>
      {attributes.length > 0 && (
        <div style={compartmentStyle}>
          {attributes.map((a, i) => (
            <div key={a.id ?? i}>{compartmentLabel(a)}</div>
          ))}
        </div>
      )}
      {ports.length > 0 && (
        <div style={compartmentStyle}>
          {ports.map((p, i) => {
            const sym = portSymbolFor(p);
            return (
              <div key={p.id ?? i} data-testid="port-row" data-port-shape={sym.shape}>
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    marginRight: 5,
                    border: '1px solid var(--node-fg)',
                    background: sym.shape === 'full' ? 'var(--node-fg)' : 'var(--node-bg)',
                    verticalAlign: 'middle',
                  }}
                />
                {sym.conjugated ? '~' : ''}
                {compartmentLabel(p)}
              </div>
            );
          })}
        </div>
      )}
      {/* Boundary ports (interconnection): each exposes BOTH a source and a target
          handle sharing the port id, so a ConnectionUsage can bind it as either end. */}
      {boundaryPorts.flatMap((p) => {
        // Distribute the handles along their side — see portOffsetPercent.
        const sameSide = boundaryPorts.filter((q) => q.side === p.side);
        const fraction = portOffsetPercent(sameSide.indexOf(p), sameSide.length);
        const along =
          p.side === 'left' || p.side === 'right' ? { top: fraction } : { left: fraction };
        const style = { ...portHandleStyle, ...along };
        return [
          <Handle
            key={`${p.id}:s`}
            id={p.id}
            type="source"
            position={sideToPosition(p.side)}
            style={style}
            title={p.label}
          />,
          <Handle
            key={`${p.id}:t`}
            id={p.id}
            type="target"
            position={sideToPosition(p.side)}
            style={style}
            title={p.label}
          />,
        ];
      })}
    </div>
  );
}

const CONTROL_INK = 'var(--node-fg)';

/**
 * A control node rendered with its canonical SysML flow symbol
 * (see {@link controlShapeFor}): fork/join thin bar, decision/merge diamond,
 * initial filled circle, done ringed (final) circle. Every shape keeps the
 * `in`/`out` handles so successions/transitions attach, and the stable
 * `data-testid="control-node"` for tests.
 */
export function ControlNode({ data }: NodeProps): JSX.Element {
  const d = (data ?? {}) as SysmlNodeData;
  const kind = typeof d.kind === 'string' ? d.kind : '';
  const shape = controlShapeFor(kind);
  const title = d.name || d.keyword || kind || '';

  const handles = (
    <>
      <Handle id="in" type="target" position={Position.Left} className="body-handle" style={bodyHandleStyle} />
      <Handle id="out" type="source" position={Position.Right} className="body-handle" style={bodyHandleStyle} />
    </>
  );

  const common: CSSProperties = { position: 'relative', boxSizing: 'border-box' };

  if (shape === 'bar') {
    // Fork / join: a thin solid bar.
    return (
      <div
        data-testid="control-node"
        data-control-shape={shape}
        title={title}
        style={{ ...common, width: 48, height: 8, background: CONTROL_INK, borderRadius: 2 }}
      >
        {handles}
      </div>
    );
  }

  if (shape === 'diamond') {
    // Decision / merge: a hollow diamond.
    return (
      <div
        data-testid="control-node"
        data-control-shape={shape}
        title={title}
        style={{
          ...common,
          width: 26,
          height: 26,
          background: 'var(--node-bg)',
          border: `1.5px solid ${CONTROL_INK}`,
          transform: 'rotate(45deg)',
        }}
      >
        {handles}
      </div>
    );
  }

  if (shape === 'final') {
    // Done / final: a filled disc inside a ring.
    return (
      <div
        data-testid="control-node"
        data-control-shape={shape}
        title={title}
        style={{
          ...common,
          width: 22,
          height: 22,
          borderRadius: '50%',
          border: `2px solid ${CONTROL_INK}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: CONTROL_INK }} />
        {handles}
      </div>
    );
  }

  // Initial (filled circle) and any other control node fall back to a solid disc.
  return (
    <div
      data-testid="control-node"
      data-control-shape={shape}
      title={title}
      style={{ ...common, width: 20, height: 20, borderRadius: '50%', background: CONTROL_INK }}
    >
      {handles}
    </div>
  );
}

/**
 * React Flow `nodeTypes` map. `sysml` is the general box; `control` the small
 * activity/state control node. Callers set `node.type` accordingly (see
 * {@link toReactFlowNodes}).
 */
export const nodeTypes = {
  // `memo` so React Flow skips re-rendering a node whose props are unchanged
  // (finding H5). The exported SysmlNode/ControlNode stay un-memoized for direct
  // use/tests. NOTE: the full benefit also needs stable node identities in
  // DiagramCanvas.decoratedNodes (H5-b) — see the review doc.
  sysml: memo(SysmlNode),
  control: memo(ControlNode),
} as const;
