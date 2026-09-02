/**
 * DiagramCanvas — renders the active view's laid-out {@link DiagramGraph} with
 * React Flow.
 *
 * Responsibilities:
 *  - Project `store.diagram` → React Flow nodes/edges via the diagram module's
 *    {@link toReactFlow} adapter and the shared {@link nodeTypes}/{@link edgeTypes}.
 *  - Node click → `store.select(elementId)` (unless a palette tool is armed).
 *  - Node drag end → persist the new position back into `store.diagram` so the
 *    manual layout tweak survives until the next rebuild.
 *  - Auto-layout affordance → `store.rebuildDiagram()`.
 *  - Connection gestures → `store.connect(source, target, kind)`, where `kind`
 *    is the armed edge tool's metaclass, or a sensible default for the active
 *    view. Two ways to draw: React Flow handle-drag (`onConnect`) and palette
 *    click-to-connect (source node click, then target node click).
 *  - Palette node tool armed → click the pane or a parent node to create an
 *    element via `store.createElement` under a sensible owner.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type Node,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import {
  edgeTypes,
  nodeTypes,
  reconnectEndpoint,
  resolveReparentTarget,
  subtreeRoots,
  toReactFlow,
  type DiagramGraph,
  type ViewKind,
} from '@diagram/index';
import { useAppStore } from '../store';
import { usePaletteStore } from './Palette';
import { NodeContextMenu } from './NodeContextMenu';
import { PaneContextMenu } from './PaneContextMenu';
import { Legend } from './Legend';

/** A memoised decorated node plus the base node it was derived from (H5-b). */
interface DecoratedNode {
  base: Node;
  node: Node;
}

/* ──────────────────────────── view → edge kind ──────────────────────────── */

/**
 * Default relationship metaclass used when the user draws a connection without
 * an edge tool armed. Chosen to match the active view's semantics.
 */
const DEFAULT_EDGE_KIND: Record<ViewKind, string> = {
  general: 'Specialization',
  interconnection: 'ConnectionUsage',
  action: 'Succession',
  state: 'TransitionUsage',
  requirement: 'Satisfy',
  tree: 'Specialization',
  parametric: 'BindingConnector',
  geometry: 'Specialization',
  // Case view ≈ use-case diagram: default connector is an include link.
  case: 'IncludeUseCaseUsage',
  // Non-graph views (rendered by MatrixView/SequenceView/GridView, not this
  // canvas); present only to keep the map exhaustive over ViewKind.
  allocation: 'AllocationUsage',
  sequence: 'Succession',
  grid: 'Specialization',
  requirements: 'Satisfy',
  analysis: 'Dependency',
  planning: 'Dependency',
  regroup: 'Dependency',
};

/** Fit-animation duration, honoring the user's reduced-motion preference. */
function fitDuration(): number {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 0 : 250;
}

/** Resolve an RF node id back to the model element id it renders. */
function elementIdOf(graph: DiagramGraph | null, rfNodeId: string): string | null {
  const n = graph?.nodes.find((dn) => dn.id === rfNodeId);
  return n?.elementId ?? null;
}

/** Client-space pointer coords from a React Flow drag event (mouse or touch). */
function pointerXY(evt: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in evt) return { x: evt.clientX, y: evt.clientY };
  const t = evt.changedTouches?.[0] ?? evt.touches?.[0];
  return t ? { x: t.clientX, y: t.clientY } : null;
}

/* ──────────────────────────────── Inner ─────────────────────────────────── */

function DiagramCanvasInner(): JSX.Element {
  const diagram = useAppStore((s) => s.diagram);
  const model = useAppStore((s) => s.model);
  const activeView = useAppStore((s) => s.activeView);
  const selectionId = useAppStore((s) => s.selectionId);
  const selectionIds = useAppStore((s) => s.selectionIds);
  const select = useAppStore((s) => s.select);
  const setSelection = useAppStore((s) => s.setSelection);
  const rebuildDiagram = useAppStore((s) => s.rebuildDiagram);
  const createElement = useAppStore((s) => s.createElement);
  const connect = useAppStore((s) => s.connect);
  const updateElement = useAppStore((s) => s.updateElement);
  const reparentMany = useAppStore((s) => s.reparentMany);
  const simActiveStates = useAppStore((s) => s.simActiveStates);

  const tool = usePaletteStore((s) => s.tool);
  const pendingSource = usePaletteStore((s) => s.pendingSource);
  const setPendingSource = usePaletteStore((s) => s.setPendingSource);
  const resetTool = usePaletteStore((s) => s.reset);

  const rf = useReactFlow();
  const [snap, setSnap] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    elementId: string;
    isEdge: boolean;
  } | null>(null);
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number } | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // True only while a Shift+drag box-select is in progress (see onSelectionChange).
  const boxDragging = useRef(false);

  // The element a drag-to-reparent would drop onto (highlighted mid-drag). A ref
  // mirrors the state so onNodeDrag only calls setState when the target actually
  // CHANGES — not on every drag frame — keeping the decoratedNodes memo cheap.
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dropTargetRef = useRef<string | null>(null);
  const setDropTarget = useCallback((id: string | null) => {
    if (dropTargetRef.current !== id) {
      dropTargetRef.current = id;
      setDropTargetId(id);
    }
  }, []);

  // Re-project whenever the store diagram changes (rebuild / layout / mutation).
  useEffect(() => {
    // A diagram change (view switch, rebuild) is never a box-drag; clear the flag
    // defensively so a box-drag interrupted without onSelectionEnd (pointercancel)
    // can't leave it stuck true and let the ensuing reconcile prune the selection.
    boxDragging.current = false;
    // Same defense for the drag-to-reparent highlight: a drag aborted without
    // onNodeDragStop (e.g. the dragged node deleted mid-drag → React Flow aborts)
    // must not leave a node stuck with the rf-reparent-target outline.
    setDropTarget(null);
    if (!diagram) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const { nodes: rfNodes, edges: rfEdges } = toReactFlow(diagram);
    setNodes(rfNodes);
    setEdges(rfEdges);
  }, [diagram, setNodes, setEdges, setDropTarget]);

  // Reflect the current model selection as React Flow selection.
  //
  // H5-b: keep object identity STABLE for every node whose decoration (selected
  // / pending className) and underlying base node are both unchanged, so the
  // `React.memo`-ized node components skip re-rendering when an unrelated node's
  // selection flips. A naive `nodes.map(n => ({...n, selected}))` minted a fresh
  // object for every node on any selection change, defeating the memoization.
  const decoCache = useRef(new Map<string, DecoratedNode>());
  const selectionSet = useMemo(() => new Set(selectionIds), [selectionIds]);
  // Nodes whose element is a currently-active simulation state (animated glow).
  const simActiveSet = useMemo(() => new Set(simActiveStates), [simActiveStates]);
  const decoratedNodes = useMemo(() => {
    const next = new Map<string, DecoratedNode>();
    const out = nodes.map((n) => {
      const elementId = (n.data as { elementId?: string }).elementId;
      const isSelected = elementId != null && selectionSet.has(elementId);
      const isPending = elementId != null && elementId === pendingSource;
      const isDropTarget = elementId != null && elementId === dropTargetId;
      // Only the state view renders state machines; other views may reuse the
      // same elementIds as node ids, so gate the sim glow to the state view.
      const isSimActive = activeView === 'state' && elementId != null && simActiveSet.has(elementId);
      // Compose (not choose) so a node that is both the pending connect-source and
      // the resolved drop target (or an active sim state) shows every marker.
      const className =
        [
          isPending && 'rf-pending-source',
          isDropTarget && 'rf-reparent-target',
          isSimActive && 'rf-sim-active',
        ]
          .filter(Boolean)
          .join(' ') || undefined;
      const prev = decoCache.current.get(n.id);
      // stable comparison by value, not by reference (H5-b).  React Flow
      // may replace node objects on unrelated updates; comparing the fields
      // that affect rendering lets us reuse the previous React element
      // instance so React.memo on the node component pays off.
      const sameBase =
        prev &&
        prev.base.id === n.id &&
        prev.base.position.x === n.position.x &&
        prev.base.position.y === n.position.y &&
        prev.base.type === n.type &&
        JSON.stringify(prev.base.data) === JSON.stringify(n.data);
      const node =
        prev && sameBase && prev.node.selected === isSelected && prev.node.className === className
          ? prev.node
          : { ...n, selected: isSelected, className };
      next.set(n.id, { base: n, node });
      return node;
    });
    decoCache.current = next;
    return out;
  }, [nodes, selectionSet, pendingSource, dropTargetId, simActiveSet, activeView]);

  /* ── connection: shared resolution for handle-drag and click-to-connect ── */

  const doConnect = useCallback(
    (sourceElementId: string, targetElementId: string) => {
      const kind = tool.mode === 'edge' ? tool.eClass : DEFAULT_EDGE_KIND[activeView];
      try {
        connect(sourceElementId, targetElementId, kind);
      } catch (err) {
        console.error('connect failed', err);
      } finally {
        resetTool();
      }
    },
    [tool, activeView, connect, resetTool],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      if (!params.source || !params.target) return;
      const src = elementIdOf(diagram, params.source);
      const tgt = elementIdOf(diagram, params.target);
      if (src && tgt) doConnect(src, tgt);
    },
    [diagram, doConnect],
  );

  // Box-select (Shift+drag, React Flow's default) → sync the boxed nodes into
  // the store's multi-selection. Only synced during an ACTUAL box-drag: our
  // decoratedNodes drive node.selected FROM the store, so RF fires
  // onSelectionChange on every prop-reconcile too (e.g. a view switch projecting
  // only some selected elements) — acting on those would silently PRUNE the
  // selection to the visible subset. The `boxDragging` gate confines the sync to
  // a genuine user drag, and the set-equality check breaks the store↔RF loop.
  const onSelectionStart = useCallback(() => {
    boxDragging.current = true;
  }, []);
  const onSelectionEnd = useCallback(() => {
    boxDragging.current = false;
  }, []);
  const onSelectionChange = useCallback(
    ({ nodes: sel }: { nodes: Node[] }) => {
      if (!boxDragging.current) return; // ignore reconcile-driven changes
      const ids = sel
        .map((n) => (n.data as { elementId?: string }).elementId)
        .filter((x): x is string => !!x);
      if (ids.length < 2) return; // single/empty box: click handles single
      const cur = useAppStore.getState().selectionIds;
      const set = new Set(ids);
      const same = set.size === cur.length && cur.every((id) => set.has(id));
      if (!same) setSelection(ids);
    },
    [setSelection],
  );

  // Endpoint reconnection: drag a relationship edge's end onto another node to
  // re-target it. Only element-level relationship edges are reconnectable (set
  // in toReactFlowEdge), so `elementId` is the relationship to patch. Exactly
  // one end moves per drag; re-target that side's source/target (undoable). The
  // model rebuild re-projects the edge at its new endpoint.
  const onReconnect = useCallback(
    (oldEdge: Edge, conn: Connection) => {
      const req = reconnectEndpoint(
        {
          source: oldEdge.source,
          target: oldEdge.target,
          elementId: (oldEdge.data as { elementId?: string } | undefined)?.elementId,
        },
        { source: conn.source, target: conn.target },
        (id) => elementIdOf(diagram, id),
      );
      if (req) updateElement(req.relId, req.patch);
    },
    [diagram, updateElement],
  );

  /* ───────────────────────────── node clicks ─────────────────────────────── */

  const onNodeClick = useCallback<NodeMouseHandler>(
    (evt, node) => {
      const elementId = (node.data as { elementId?: string }).elementId ?? null;
      if (!elementId) return;

      if (tool.mode === 'node') {
        // Create the new element nested under the clicked node.
        createElement(tool.eClass, elementId);
        resetTool();
        return;
      }

      if (tool.mode === 'edge') {
        if (!pendingSource) {
          setPendingSource(elementId);
        } else {
          doConnect(pendingSource, elementId);
        }
        return;
      }

      // ⌘/Ctrl/Shift-click extends the multi-selection; a plain click replaces it.
      select(elementId, { additive: evt.shiftKey || evt.ctrlKey || evt.metaKey });
    },
    [tool, pendingSource, createElement, resetTool, setPendingSource, doConnect, select],
  );

  /* ───────────────────────────── pane clicks ─────────────────────────────── */

  const onPaneClick = useCallback(() => {
    if (tool.mode === 'node') {
      // Place under the current selection (store falls back to root if absent).
      createElement(tool.eClass);
      resetTool();
      return;
    }
    if (tool.mode === 'edge') {
      // Abort an in-progress connect.
      setPendingSource(null);
      return;
    }
    select(null);
  }, [tool, createElement, resetTool, setPendingSource, select]);

  /* ───────────────────────── drag end → persist pos ──────────────────────── */

  /* ─────────────────────── right-click context menu ──────────────────────── */

  const onNodeContextMenu = useCallback<NodeMouseHandler>(
    (evt, node) => {
      evt.preventDefault(); // suppress the browser menu
      const elementId = (node.data as { elementId?: string }).elementId;
      if (!elementId) return;
      // Preserve an existing multi-selection when right-clicking one of its
      // members (so "Delete N" applies to all); otherwise select just this node.
      if (!useAppStore.getState().selectionIds.includes(elementId)) select(elementId);
      setPaneMenu(null);
      setCtxMenu({ x: evt.clientX, y: evt.clientY, elementId, isEdge: false });
    },
    [select],
  );
  /** Right-click an edge → select its relationship + open the context menu. */
  const onEdgeContextMenu = useCallback<EdgeMouseHandler>(
    (evt, edge) => {
      evt.preventDefault();
      const elementId = (edge.data as { elementId?: string } | undefined)?.elementId;
      if (!elementId) return;
      select(elementId);
      setPaneMenu(null);
      setCtxMenu({ x: evt.clientX, y: evt.clientY, elementId, isEdge: true });
    },
    [select],
  );
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  /** Right-click empty canvas → the pane menu (create a top-level element / fit). */
  const onPaneContextMenu = useCallback((evt: React.MouseEvent | MouseEvent) => {
    evt.preventDefault();
    setCtxMenu(null);
    setPaneMenu({ x: evt.clientX, y: evt.clientY });
  }, []);
  const closePaneMenu = useCallback(() => setPaneMenu(null), []);

  /* ───────────────────────── canvas mini-toolbar ─────────────────────────── */

  const onFitAll = useCallback(
    () => rf.fitView({ padding: 0.15, duration: fitDuration() }),
    [rf],
  );
  /** Zoom/centre on a specific element's node (if it's in the current diagram). */
  const fitElement = useCallback(
    (elementId: string) => {
      const rfNode = nodes.find((n) => (n.data as { elementId?: string }).elementId === elementId);
      if (rfNode) rf.fitView({ nodes: [{ id: rfNode.id }], padding: 0.6, duration: fitDuration(), maxZoom: 1.5 });
    },
    [nodes, rf],
  );
  const onFitSelection = useCallback(() => {
    if (selectionId) fitElement(selectionId);
  }, [selectionId, fitElement]);
  const hasSelectionNode =
    selectionId != null &&
    nodes.some((n) => (n.data as { elementId?: string }).elementId === selectionId);

  /* ─────────────────── drag-to-reparent (canvas) ─────────────────── */

  // Reparent only in plain select mode — while a palette node/edge tool is armed
  // a drag stays a pure position tweak (and can't collide with click-to-connect).
  const canReparent = tool.mode === 'select';

  // The element(s) actually being dragged, from React Flow's authoritative
  // `nodes` argument (the physically-dragged rendered set — NOT the store
  // selection, which can hold ids from other views), reduced to subtree roots so
  // a parent+descendant drag moves the subtree whole instead of flattening it.
  const draggedRootsFrom = useCallback(
    (rfNodes: Node[]): string[] => {
      const ids = rfNodes
        .map((n) => (n.data as { elementId?: string }).elementId)
        .filter((x): x is string => !!x);
      return subtreeRoots(model, ids);
    },
    [model],
  );

  // Candidate owners UNDER THE POINTER (not the dragged node's bounding box), most
  // specific (innermost / smallest) first. Pointer hit-testing means an edge that
  // merely grazes a sibling doesn't reparent, and a selection-rect drag aims by
  // the cursor rather than an arbitrary member. Control nodes (fork/join/…) can't
  // own model elements, so they're excluded as targets.
  const candidatesAtPointer = useCallback(
    (evt: MouseEvent | TouchEvent): string[] => {
      const client = pointerXY(evt);
      if (!client) return [];
      const p = rf.screenToFlowPosition(client);
      let inter: Node[] = [];
      try {
        inter = rf.getIntersectingNodes({ x: p.x, y: p.y, width: 1, height: 1 });
      } catch {
        inter = [];
      }
      const area = (n: Node) =>
        (n.measured?.width ?? (n.width as number | undefined) ?? 0) *
        (n.measured?.height ?? (n.height as number | undefined) ?? 0);
      const out: string[] = [];
      const seen = new Set<string>();
      for (const n of [...inter].sort((a, b) => area(a) - area(b))) {
        if (n.type === 'control') continue; // control nodes can't own elements
        const eid = elementIdOf(diagram, n.id);
        if (eid && !seen.has(eid)) {
          seen.add(eid);
          out.push(eid);
        }
      }
      return out;
    },
    [rf, diagram],
  );

  // Grabbing an UNSELECTED node replaces the selection with it, so a stray prior
  // multi-selection can't ride along and get reparented with it.
  const onNodeDragStart = useCallback<OnNodeDrag<Node>>(
    (_evt, node) => {
      const eid = (node.data as { elementId?: string }).elementId;
      if (eid && !useAppStore.getState().selectionIds.includes(eid)) select(eid);
    },
    [select],
  );

  // Mid-drag: highlight the element the drop would reparent onto (if any).
  const onNodeDrag = useCallback<OnNodeDrag<Node>>(
    (evt, _node, nodes) => {
      if (!canReparent) return;
      const target = resolveReparentTarget(model, draggedRootsFrom(nodes), candidatesAtPointer(evt));
      setDropTarget(target);
    },
    [canReparent, model, draggedRootsFrom, candidatesAtPointer, setDropTarget],
  );

  const onNodeDragStop = useCallback<OnNodeDrag<Node>>(
    (evt, _node, nodes) => {
      setDropTarget(null);
      if (canReparent) {
        const dragged = draggedRootsFrom(nodes);
        const target = resolveReparentTarget(model, dragged, candidatesAtPointer(evt));
        if (target) {
          // Dropped onto a valid new owner → reparent (one undo step). The ensuing
          // rebuild re-lays-out, so the manual position tweak isn't persisted.
          reparentMany(dragged, target);
          return;
        }
      }
      // No reparent: persist the manual position tweak for EVERY dragged node into
      // store.diagram (local layout) so it survives until the next rebuild.
      const moved = new Map(nodes.map((n) => [n.id, n.position]));
      useAppStore.setState((s) => {
        if (!s.diagram) return {};
        const next = {
          ...s.diagram,
          nodes: s.diagram.nodes.map((dn) => {
            const pos = moved.get(dn.id);
            return pos ? { ...dn, position: { x: pos.x, y: pos.y } } : dn;
          }),
        };
        return { diagram: next };
      });
    },
    [canReparent, model, draggedRootsFrom, candidatesAtPointer, setDropTarget, reparentMany],
  );

  return (
    <div className="diagram-canvas" data-testid="diagram-canvas" style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={decoratedNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnect={onReconnect}
        onSelectionStart={onSelectionStart}
        onSelectionEnd={onSelectionEnd}
        onSelectionChange={onSelectionChange}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onPaneClick={onPaneClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        nodeDragThreshold={4}
        deleteKeyCode={null}
        fitView
        snapToGrid={snap}
        snapGrid={[20, 20]}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
        <Panel position="bottom-center">
          <Legend edges={diagram?.edges ?? []} />
        </Panel>
        <Panel position="top-right">
          <div className="diagram-minibar" data-testid="diagram-minibar">
            <button
              type="button"
              data-testid="diagram-fit"
              title="Fit the whole diagram in view"
              onClick={onFitAll}
            >
              ⤢ Fit
            </button>
            <button
              type="button"
              data-testid="diagram-fit-selection"
              title="Zoom to the selected element"
              disabled={!hasSelectionNode}
              onClick={onFitSelection}
            >
              ◎ Selection
            </button>
            <button
              type="button"
              data-testid="diagram-snap"
              className={snap ? 'is-active' : ''}
              aria-pressed={snap}
              title={snap ? 'Snap-to-grid: on' : 'Snap-to-grid: off'}
              onClick={() => setSnap((s) => !s)}
            >
              ▦ Snap
            </button>
            <button
              type="button"
              className="diagram-autolayout"
              data-testid="diagram-autolayout"
              title="Re-run automatic layout"
              onClick={() => void rebuildDiagram()}
            >
              Auto-layout
            </button>
          </div>
        </Panel>
      </ReactFlow>
      {ctxMenu && (
        <NodeContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          elementId={ctxMenu.elementId}
          isEdge={ctxMenu.isEdge}
          onClose={closeCtxMenu}
          onFit={fitElement}
        />
      )}
      {paneMenu && (
        <PaneContextMenu x={paneMenu.x} y={paneMenu.y} onClose={closePaneMenu} onFitAll={onFitAll} />
      )}
    </div>
  );
}

/** Wrap in a provider so React Flow hooks/state are scoped to this canvas. */
export function DiagramCanvas(): JSX.Element {
  return (
    <ReactFlowProvider>
      <DiagramCanvasInner />
    </ReactFlowProvider>
  );
}

export default DiagramCanvas;
