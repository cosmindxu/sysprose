/**
 * Palette — the per-view tools: what to draw, what to do to the selection, and
 * what to check.
 *
 * Three sections, because a person at a diagram has three questions — "how do I
 * add this", "how do I change that", "is it right?" — and only the first had an
 * answer here. Checks come from {@link CHECKS}, the one registry the Checks tab
 * and the copyable terminal command also read, so the three cannot drift.
 *
 * Every view has a palette now. A table or analysis view draws nothing, so it
 * has no Tools section, and its palette is Edit + Checks — which is exactly
 * where a reader of the allocation matrix or the contracts table wants
 * `trace`, `orphans` or `refine`.
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

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { create } from 'zustand';
import { TEXTUAL_KEYWORD } from '@core/index';
import type { ViewKind } from '@diagram/index';
import { checkFileName, loadHealthAtHand, loadHealthNow, useAppStore } from '../store';
import { checksFor, commandNote, selectionKey, type CheckSpec } from '../checks';
import { runningVerdict, useChecksStore, verdictOf, VERDICT_LABEL } from './checks-store';
import { cancelChecked, runChecked, runCheckedOnceDrawn, type RunStart } from './checks-runner';

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
      // The dependency lines this view draws can be drawn here too: a satisfier
      // that has lost its requirement is not in the Requirement view any more.
      tools: [
        EDGE('Specialization', 'Specialize'),
        EDGE('FeatureTyping', 'Typed by'),
        EDGE('Satisfy', 'Satisfy'),
        EDGE('Allocation', 'Allocate'),
        EDGE('Trace', 'Trace'),
      ],
    },
  ],
  interconnection: [
    {
      title: 'Nodes',
      tools: [NODE('PartUsage', 'Part'), NODE('PortUsage', 'Port')],
    },
    {
      title: 'Edges',
      // Drawn box to box, or port to port (a handle on each box's edge): the
      // ends are then the ports, as in `interface i : I connect a.p to b.q`.
      tools: [EDGE('ConnectionUsage', 'Connection'), EDGE('InterfaceUsage', 'Interface')],
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
  // Read-only inventory: a contract is written in a requirement body, never
  // drawn, so this view offers no tools.
  contracts: [],
};

/** Whether a view offers drawing tools — the Tools section appears only then. */
export function viewHasTools(view: ViewKind): boolean {
  return (TOOLS_BY_VIEW[view] ?? []).length > 0;
}

/**
 * Whether the palette column is worth showing at all. Every view has Edit and
 * Checks, so this is true everywhere; kept as the one place that decides, so a
 * future view with nothing to offer can say so.
 */
export function viewHasPalette(view: ViewKind): boolean {
  return viewHasTools(view) || checksFor(view).length > 0;
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

/* ────────────────────────────── Sections ───────────────────────────────── */

/** The Edit section: what the store can already do to a selection. */
function EditSection(): JSX.Element | null {
  const selectionId = useAppStore((st) => st.selectionId);
  const selectionCount = useAppStore((st) => st.selectionIds.length);
  const deleteSelection = useAppStore((st) => st.deleteSelection);
  const duplicateSelection = useAppStore((st) => st.duplicateSelection);
  const setRenamingId = useAppStore((st) => st.setRenamingId);
  const none = selectionId === null;
  const what = selectionCount > 1 ? `${selectionCount} elements` : 'the selection';
  return (
    <div className="palette-group" data-testid="palette-edit">
      <div className="palette-group-title">Edit</div>
      <button
        type="button"
        className="palette-action"
        data-testid="palette-rename"
        disabled={none}
        title={none ? 'Select an element first' : 'Rename it in the explorer (F2)'}
        onClick={() => selectionId && setRenamingId(selectionId)}
      >
        <span aria-hidden>✎</span>
        <span>Rename</span>
        <kbd>F2</kbd>
      </button>
      <button
        type="button"
        className="palette-action"
        data-testid="palette-duplicate"
        disabled={none}
        title={none ? 'Select an element first' : `Duplicate ${what} as a sibling`}
        onClick={() => duplicateSelection()}
      >
        <span aria-hidden>⧉</span>
        <span>Duplicate</span>
        <kbd>Ctrl+D</kbd>
      </button>
      <button
        type="button"
        className="palette-action is-destructive"
        data-testid="palette-delete"
        disabled={none}
        title={none ? 'Select an element first' : `Delete ${what} and what it contains`}
        onClick={() => deleteSelection()}
      >
        <span aria-hidden>␡</span>
        <span>Delete</span>
        <kbd>Del</kbd>
      </button>
      <div className="palette-note">Drag a node onto another to reparent it.</div>
    </div>
  );
}

/** One check: the question, the verdict, Run, and the command to run it elsewhere. */
function CheckRowView({ spec }: { spec: CheckSpec }): JSX.Element {
  const model = useAppStore((st) => st.model);
  const rev = useAppStore((st) => st.rev);
  const selectionId = useAppStore((st) => st.selectionId);
  // Read on every store change rather than once per selection: the model is
  // edited in place, so a rename of the selected element would otherwise leave
  // its old name in the command that names it.
  const selectionName = useAppStore((st) => {
    const selected = st.selectionId ? st.model.get(st.selectionId) : undefined;
    return selected ? (st.model.qualifiedName(selected.id) ?? selected.attrs.declaredName ?? null) : null;
  });
  // The file the terminal commands name: the attached Google Drive file's
  // name, which is what a student downloads from Drive, else the project's.
  const fileName = useAppStore(checkFileName);
  const stored = useChecksStore((st) => st.results[spec.id]);
  const run = useChecksStore((st) => st.running[spec.id]);
  const running = run !== undefined;
  const [copied, setCopied] = useState(false);

  // One object per (model, selection, file name), so the callbacks below are
  // stable between renders instead of being rebuilt on each one.
  const ctx = useMemo(
    () => ({
      model,
      selectionId,
      selectionName,
      isolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
      fileName,
    }),
    [model, selectionId, selectionName, fileName],
  );
  // What of the selection the result read: once that moves, the row shows the
  // result as stale, since the command beside it names the new selection.
  const reads = selectionKey(spec, ctx);
  // A check in a worker is checking the load, then running, until it settles, whatever it said before.
  const verdict = run !== undefined ? runningVerdict(run) : verdictOf(stored, rev, reads);
  // A file or element name the command could not carry as it is (it would be
  // read as code by some terminal): what the stand-in in its place stands for.
  const note = commandNote(spec, ctx);

  const onRun = useCallback(() => {
    const st = useAppStore.getState();
    // A check not judged over the load reads the model alone, which an edit
    // changes at once: nothing an edit's recompute owes (the text, Problems) is
    // waited for.
    if (!spec.readsLoadHealth) {
      runChecked(spec, { ...ctx, model: st.model }, st.rev);
      return;
    }
    // What is known of the load health is read in the same turn as `rev` (I8),
    // with no parse on this thread: a text no parse has measured yet goes to the
    // worker, and the row reads `checking the load…` until it is back. The health
    // travels with the request so an off-thread walk judges what the page would.
    const read = (): RunStart => {
      const health = loadHealthNow();
      const now = useAppStore.getState();
      return { model: now.model, rev: now.rev, health };
    };
    if (loadHealthAtHand()) {
      const start = read();
      runChecked(spec, { ...ctx, model: start.model }, start.rev, start.health);
    } else {
      // Reading it would hold the page — an edit's recompute is still waiting
      // (up to about 0.6 s on the drone-swarm model) — so the run begins first and
      // reads once its row is drawn (review 2026-10-14 D-3).
      runCheckedOnceDrawn(spec, ctx, st.rev, read);
    }
  }, [spec, ctx]);
  const onCancel = useCallback(() => cancelChecked(spec.id), [spec.id]);

  // Cancel goes when the check stops, whether the person pressed it or the answer
  // came while it had the focus. A focused button that leaves the page leaves the
  // focus on <body>, and there the Backspace guard (`handleShortcut` refuses
  // Delete/Backspace only on a button or link) no longer holds: a reflex Backspace
  // would delete the selection. So the focus goes to Run, which stays. A ref
  // callback runs with null before the node leaves the page, while it still has it.
  const runButton = useRef<HTMLButtonElement>(null);
  const cancelNode = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useCallback((node: HTMLButtonElement | null) => {
    if (node === null && cancelNode.current !== null && document.activeElement === cancelNode.current) {
      runButton.current?.focus();
    }
    cancelNode.current = node;
  }, []);

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(spec.command(ctx)).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }, [spec, ctx]);

  return (
    <div
      className="palette-check"
      data-testid="palette-check"
      data-check={spec.id}
      data-verdict={verdict}
      data-ran-in={stored?.ranIn}
    >
      <div className="palette-check-head">
        <span className="palette-check-label" title={`${spec.question}\n\n${spec.command(ctx)}`}>
          {spec.label}
        </span>
        <span className={`palette-check-verdict is-${verdict}`} data-testid="palette-check-verdict">
          {VERDICT_LABEL[verdict]}
        </span>
      </div>
      <div className="palette-check-actions">
        {/* aria-disabled, not disabled: the button keeps the focus the click gave it while the check runs. */}
        <button
          ref={runButton}
          type="button"
          data-testid="palette-check-run"
          aria-disabled={running}
          onClick={running ? undefined : onRun}
          title={running ? `${spec.id} is running` : `Run ${spec.id} on the model as it is now`}
        >
          Run
        </button>
        {running && (
          <button ref={cancelRef} type="button" data-testid="palette-check-cancel" onClick={onCancel} title={`Stop ${spec.id}; it keeps the result it had`}>
            Cancel
          </button>
        )}
        <button type="button" data-testid="palette-check-copy" onClick={onCopy} title={spec.command(ctx)}>
          {copied ? 'Copied' : 'Copy command'}
        </button>
        <code className="palette-check-cli">{spec.id}</code>
      </div>
      {note !== null && (
        <div className="palette-check-note" data-testid="palette-check-note">
          {note}
        </div>
      )}
      {verdict === 'checking' ? (
        <div className="palette-check-summary" role="status">
          Checking that the model’s text loads, in the background — the page stays usable. Cancel stops it.
        </div>
      ) : running ? (
        <div className="palette-check-summary" role="status">
          Running in the background — the page stays usable. Cancel stops it.
        </div>
      ) : (
        stored && <div className="palette-check-summary">{stored.result.summary}</div>
      )}
    </div>
  );
}

/** The Checks section: the verification commands that apply to this view. */
function ChecksSection({ view }: { view: ViewKind }): JSX.Element | null {
  const specs = checksFor(view);
  if (specs.length === 0) return null;
  return (
    <div className="palette-group" data-testid="palette-checks">
      <div className="palette-group-title">Checks</div>
      {specs.map((spec) => (
        <CheckRowView key={spec.id} spec={spec} />
      ))}
    </div>
  );
}

const COLLAPSE_KEY = 'palette-collapsed';

/** Whether the column starts collapsed — remembered per browser, never in the model. */
function initiallyCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function Palette(): JSX.Element {
  const activeView = useAppStore((s) => s.activeView);
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  // Put away or brought back, the control pressed is replaced by its opposite (two
  // different trees). A focused button that leaves the page leaves the focus on
  // <body>, where a reflex Backspace would delete the selection (the guard refuses
  // it only on a button), so the keyboard goes to the control that took its place.
  // Only when the pressed one held the focus: a mouse click that gave none stays put.
  const hideButton = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const toggleCollapsed = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
    refocus.current = document.activeElement === e.currentTarget;
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        // A browser that refuses storage still gets the toggle, just not the memory.
      }
      return !c;
    });
  }, []);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    (collapsed ? showButton : hideButton).current?.focus();
  }, [collapsed]);
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

  if (collapsed) {
    // What the column hides, named in its own section words (a table view draws
    // nothing, so it has no Tools). The accessible name holds the visible label
    // whole, then says what the click does.
    const sections = groups.length > 0 ? 'Tools, Edit, Checks' : 'Edit, Checks';
    return (
      <div className="palette is-collapsed" data-testid="palette" data-collapsed="true">
        <button
          ref={showButton}
          type="button"
          className="app-rail app-rail-left palette-rail"
          data-testid="palette-expand"
          title={`Show the palette (${sections.toLowerCase()})`}
          aria-label={`Show Palette: ${sections}`}
          aria-expanded={false}
          onClick={toggleCollapsed}
        >
          <span className="app-rail-chev">›</span>
          <span className="app-rail-label" data-testid="palette-collapsed-label">
            Palette:<span className="palette-rail-sections"> {sections}</span>
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="palette" data-testid="palette" data-collapsed="false">
      <div className="palette-head">
        <span className="palette-group-title">Palette · {activeView}</span>
        <button
          ref={hideButton}
          type="button"
          className="palette-collapse"
          data-testid="palette-collapse"
          title="Hide the palette"
          aria-label="Hide the palette"
          aria-expanded
          onClick={toggleCollapsed}
        >
          ‹
        </button>
      </div>
      {groups.length > 0 && (
        <div className="palette-group" data-testid="palette-tools">
          <div className="palette-group-title">Tools</div>
          <button
            type="button"
            className={`palette-tool${tool.mode === 'select' ? ' is-active' : ''}`}
            data-testid="palette-select"
            aria-pressed={tool.mode === 'select'}
            title="Select and move elements — no tool armed (Esc)"
            onClick={() => setTool({ mode: 'select' })}
          >
            <span aria-hidden>▸</span>
            <span>Select</span>
          </button>
        </div>
      )}
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
      <EditSection />
      <ChecksSection view={activeView} />
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
