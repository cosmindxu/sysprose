/**
 * Palette — a floating, view-aware list of element/edge creation tools.
 *
 * The palette is *modal*: clicking a tool arms it, and the actual model
 * mutation happens on the {@link DiagramCanvas} (a node tool creates an element
 * on the next canvas/node click; an edge tool puts the canvas into a
 * pending-connect mode that resolves on the next two node clicks or a React
 * Flow handle drag).
 *
 * The armed tool lives in a tiny module-scoped zustand store
 * ({@link usePaletteStore}) so {@link DiagramCanvas} can read/clear it without a
 * prop-drilling bridge. This keeps the diagram canvas and the palette as the
 * only two files this surface owns.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { TEXTUAL_KEYWORD } from '@core/index';
import type { ViewKind } from '@diagram/index';
import { useAppStore } from '../store';

/* ─────────────────────────── Shared tool state ──────────────────────────── */

/** The currently-armed palette tool (shared with the canvas). */
export type Tool =
  | { mode: 'select' }
  | { mode: 'node'; eClass: string }
  | { mode: 'edge'; eClass: string };

interface PaletteState {
  /** The armed tool; `select` means "no tool" (plain selection/drag). */
  tool: Tool;
  /** First endpoint chosen for a click-to-connect edge gesture (element id). */
  pendingSource: string | null;
  /** Arm a tool (toggles off if the same tool is clicked again). */
  setTool(tool: Tool): void;
  /** Record the first endpoint of a click-to-connect gesture. */
  setPendingSource(id: string | null): void;
  /** Disarm everything (back to plain selection). */
  reset(): void;
}

/**
 * Module-scoped store for the armed palette tool. Intentionally separate from
 * the main app store (which this surface must not modify): it is pure transient
 * UI interaction state with no bearing on the model.
 */
export const usePaletteStore = create<PaletteState>((set) => ({
  tool: { mode: 'select' },
  pendingSource: null,
  setTool: (tool) =>
    set((s) => {
      const same =
        s.tool.mode === tool.mode &&
        (tool.mode === 'select' || (s.tool as { eClass?: string }).eClass === (tool as { eClass: string }).eClass);
      return same ? { tool: { mode: 'select' }, pendingSource: null } : { tool, pendingSource: null };
    }),
  setPendingSource: (id) => set({ pendingSource: id }),
  reset: () => set({ tool: { mode: 'select' }, pendingSource: null }),
}));

/* ─────────────────────────── Per-view tool config ───────────────────────── */

interface ToolSpec {
  /** Metaclass (node) or relationship metaclass (edge) created by this tool. */
  eClass: string;
  /** Display label. */
  label: string;
  /** Whether the tool places a node or arms a connector. */
  type: 'node' | 'edge';
}

interface ToolGroup {
  title: string;
  tools: ToolSpec[];
}

const NODE = (eClass: string, label?: string): ToolSpec => ({
  eClass,
  label: label ?? eClass,
  type: 'node',
});
const EDGE = (eClass: string, label?: string): ToolSpec => ({
  eClass,
  label: label ?? eClass,
  type: 'edge',
});

/** Tool groups offered for each view kind. */
const TOOLS_BY_VIEW: Record<ViewKind, ToolGroup[]> = {
  general: [
    {
      title: 'Nodes',
      tools: [
        NODE('PartDefinition', 'Part Def'),
        NODE('PartUsage', 'Part'),
        NODE('AttributeUsage', 'Attribute'),
        NODE('PortUsage', 'Port'),
      ],
    },
    {
      title: 'Edges',
      tools: [EDGE('Specialization', 'Specialize'), EDGE('FeatureTyping', 'Typed by')],
    },
  ],
  interconnection: [
    {
      title: 'Nodes',
      tools: [NODE('PartUsage', 'Part'), NODE('PortUsage', 'Port')],
    },
    {
      title: 'Edges',
      tools: [EDGE('ConnectionUsage', 'Connection')],
    },
  ],
  action: [
    {
      title: 'Nodes',
      tools: [NODE('ActionUsage', 'Action')],
    },
    {
      title: 'Control nodes',
      tools: [
        NODE('InitialNode', 'Initial'),
        NODE('DecisionNode', 'Decision'),
        NODE('MergeNode', 'Merge'),
        NODE('ForkNode', 'Fork'),
        NODE('JoinNode', 'Join'),
        NODE('DoneNode', 'Done'),
      ],
    },
    {
      title: 'Edges',
      tools: [EDGE('Succession', 'Succession')],
    },
  ],
  state: [
    {
      title: 'Nodes',
      tools: [NODE('StateUsage', 'State')],
    },
    {
      title: 'Edges',
      tools: [EDGE('TransitionUsage', 'Transition')],
    },
  ],
  requirement: [
    {
      title: 'Nodes',
      tools: [NODE('RequirementDefinition', 'Requirement Def'), NODE('RequirementUsage', 'Requirement')],
    },
    {
      title: 'Edges',
      tools: [EDGE('Satisfy', 'Satisfy'), EDGE('Refine', 'Refine'), EDGE('Verify', 'Verify')],
    },
  ],
  tree: [
    {
      title: 'Nodes',
      tools: [NODE('Package', 'Package'), NODE('PartDefinition', 'Part Def'), NODE('PartUsage', 'Part')],
    },
  ],
  parametric: [
    {
      title: 'Nodes',
      tools: [NODE('ConstraintUsage', 'Constraint'), NODE('AttributeUsage', 'Attribute')],
    },
    {
      title: 'Edges',
      tools: [EDGE('BindingConnector', 'Bind')],
    },
  ],
  geometry: [
    {
      title: 'Nodes',
      tools: [NODE('PartUsage', 'Part'), NODE('ItemUsage', 'Item')],
    },
  ],
  case: [
    {
      title: 'Nodes',
      tools: [NODE('UseCaseUsage', 'Use Case'), NODE('CaseUsage', 'Case')],
    },
    {
      title: 'Edges',
      tools: [EDGE('IncludeUseCaseUsage', 'Include')],
    },
  ],
  // Non-graph views render via MatrixView/SequenceView/GridView (no drawing palette).
  allocation: [],
  sequence: [],
  grid: [],
  requirements: [],
  analysis: [],
  planning: [],
  regroup: [],
};

/** Whether a view offers drawing tools — used to hide the palette column on the
 *  table/analysis/geometry views, where it would only be dead space. */
export function viewHasTools(view: ViewKind): boolean {
  return (TOOLS_BY_VIEW[view] ?? []).length > 0;
}

/* ──────────────────────────────── Component ─────────────────────────────── */

/**
 * A per-metaclass glyph so the palette is scannable — control nodes especially
 * read distinctly (Initial ●, Decision/Merge ◇, Done ◉) instead of every node
 * being an identical box. Reliable Unicode only; falls back to the box/arrow.
 */
const NODE_GLYPH: Record<string, string> = {
  PartDefinition: '◆',
  PartUsage: '▭',
  AttributeUsage: '▪',
  ItemUsage: '▪',
  PortUsage: '◻',
  ActionUsage: '▷',
  InitialNode: '●',
  DecisionNode: '◇',
  MergeNode: '◇',
  ForkNode: '≡',
  JoinNode: '≡',
  DoneNode: '◉',
  StateUsage: '◉',
  RequirementDefinition: '◈',
  RequirementUsage: '◈',
  Package: '▤',
  ConstraintUsage: 'ƒ',
  UseCaseUsage: '◈',
  CaseUsage: '◈',
};
function toolGlyph(spec: ToolSpec): string {
  return spec.type === 'edge' ? '→' : (NODE_GLYPH[spec.eClass] ?? '▭');
}

/** Tooltip text: the textual-notation keyword + what arming the tool does. */
function tooltip(spec: ToolSpec): string {
  const keyword = TEXTUAL_KEYWORD[spec.eClass] ?? spec.eClass;
  return spec.type === 'node'
    ? `Create ${spec.label} («${keyword}») — then click the canvas or a parent node`
    : `Connect with ${spec.label} («${keyword}») — then click a source then a target node`;
}

export function Palette(): JSX.Element {
  const activeView = useAppStore((s) => s.activeView);
  const tool = usePaletteStore((s) => s.tool);
  const setTool = usePaletteStore((s) => s.setTool);

  const groups = TOOLS_BY_VIEW[activeView] ?? [];

  const isActive = (spec: ToolSpec): boolean =>
    tool.mode !== 'select' && (tool as { eClass: string }).eClass === spec.eClass && tool.mode === spec.type;

  // Escape disarms the pending tool (matches the on-screen Cancel affordance) —
  // but not while typing in a field, so clearing a search/rename with Escape
  // doesn't also cancel the armed tool.
  useEffect(() => {
    if (tool.mode === 'select') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return;
      setTool({ mode: 'select' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool.mode, setTool]);

  // The label of the currently-armed tool (for the hint) — found in the groups.
  const armedLabel =
    tool.mode === 'select'
      ? ''
      : (groups
          .flatMap((g) => g.tools)
          .find((t) => t.eClass === (tool as { eClass: string }).eClass && t.type === tool.mode)
          ?.label ?? (tool as { eClass: string }).eClass);

  return (
    <div className="palette" data-testid="palette">
      <div className="palette-group-title">Palette · {activeView}</div>
      {groups.map((group) => (
        <div key={group.title} className="palette-group">
          <div className="palette-group-title">{group.title}</div>
          {group.tools.map((spec) => (
            <button
              key={`${spec.type}:${spec.eClass}`}
              type="button"
              className={`palette-tool${isActive(spec) ? ' is-active' : ''}`}
              data-testid="palette-tool"
              data-kind={spec.eClass}
              data-tooltype={spec.type}
              title={tooltip(spec)}
              aria-pressed={isActive(spec)}
              onClick={() =>
                setTool(
                  spec.type === 'node'
                    ? { mode: 'node', eClass: spec.eClass }
                    : { mode: 'edge', eClass: spec.eClass },
                )
              }
            >
              <span aria-hidden>{toolGlyph(spec)}</span>
              <span>{spec.label}</span>
            </button>
          ))}
        </div>
      ))}
      {tool.mode !== 'select' && (
        <div className="palette-hint" data-testid="palette-hint">
          <div className="palette-hint-title">
            {tool.mode === 'node' ? 'Placing' : 'Connecting'} <b>{armedLabel}</b>
          </div>
          <div className="palette-hint-body">
            {tool.mode === 'node'
              ? 'Click the canvas (or a parent node) to place.'
              : 'Click a source node, then a target node.'}
          </div>
          <button
            type="button"
            className="palette-cancel"
            onClick={() => setTool({ mode: 'select' })}
          >
            Cancel (Esc)
          </button>
        </div>
      )}
    </div>
  );
}

export default Palette;
