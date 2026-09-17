/**
 * Toolbar — the top command strip.
 *
 * File:    New · Open (project picker) · Save · Import · Export (sysml/json/api)
 * Model:   Validate · Auto-layout
 * View:    segmented control over {@link ViewKind} (general/interconnection/…)
 * History: Undo · Redo
 *
 * Every control drives the shared {@link useAppStore}; view buttons reuse the
 * declarative {@link VIEW_COMMANDS} list so ids stay in lock-step with the
 * keyboard/command surface.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { useRovingMenu } from './useRovingMenu';
import { Collaborate } from './Collaborate';
import { VIEW_COMMANDS } from '../commands';
import { svgFromDiagram, type DiagramGraph, type ViewKind } from '@diagram/index';
import { downloadText, downloadBytes, openTextFile, type ModelFormat } from '@persistence/index';
import { exportFmu, fmiModelDescription } from '@interop/index';
import { PRODUCT_NAME } from '../../branding';
import { Popover, isInside } from './Popover';
import './panels.css';

/**
 * View buttons for the projections added after {@link VIEW_COMMANDS} was frozen:
 * the parametric/geometry React Flow graphs plus the dedicated allocation-matrix
 * and sequence renderers. Rendered alongside the existing `tb-view-*` buttons so
 * every {@link ViewKind} is reachable from the toolbar.
 */
const EXTRA_VIEW_COMMANDS: Array<{ id: string; label: string; view: ViewKind }> = [
  { id: 'tb-view-parametric', label: 'Parametric', view: 'parametric' },
  { id: 'tb-view-sequence', label: 'Sequence', view: 'sequence' },
  { id: 'tb-view-allocation', label: 'Allocation', view: 'allocation' },
  { id: 'tb-view-geometry', label: 'Geometry', view: 'geometry' },
  { id: 'tb-view-case', label: 'Case', view: 'case' },
  { id: 'tb-view-grid', label: 'Grid', view: 'grid' },
  { id: 'tb-view-requirements', label: 'Requirements', view: 'requirements' },
  { id: 'tb-view-analysis', label: 'Analysis', view: 'analysis' },
  { id: 'tb-view-planning', label: 'Planning', view: 'planning' },
  { id: 'tb-view-regroup', label: 'Regroup', view: 'regroup' },
  { id: 'tb-view-contracts', label: 'Contracts', view: 'contracts' },
];

/**
 * The views grouped for the dedicated view bar (row 2), so switching diagrams
 * is discoverable instead of buried in a horizontally-scrolling command row.
 *
 * The count is deliberately not written here: it moved with the Contracts view
 * and a number in a comment is a number nothing measures. `ViewKind` is the
 * list, and `docs-counts.test.ts` counts it for the documents that quote it.
 */
const VIEW_GROUPS: Array<{ title: string; views: ViewKind[] }> = [
  {
    title: 'Diagrams',
    views: [
      'general',
      'interconnection',
      'action',
      'state',
      'requirement',
      'tree',
      'parametric',
      'case',
      'sequence',
      'geometry',
    ],
  },
  { title: 'Tables', views: ['allocation', 'grid', 'requirements', 'contracts'] },
  { title: 'Analyze', views: ['analysis', 'planning', 'regroup'] },
];

interface MenuItem {
  label: string;
  testid: string;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}

/**
 * Views backed by the React Flow graph + the laid-out `diagram` projection —
 * the only ones where "Auto-layout" and the diagram SVG/PNG exports mean
 * anything (the table/analysis/geometry views have their own layout and no
 * `svgFromDiagram` graph). Used to context-disable those diagram-only tools.
 */
const GRAPH_VIEWS = new Set<ViewKind>([
  'general',
  'interconnection',
  'action',
  'state',
  'requirement',
  'tree',
  'parametric',
  'case',
]);

/**
 * Toolbar commands that give way to a "More ▾" menu when the bar is too narrow,
 * first to last. Save, Open, Export, Validate, Check, Undo and Redo are not in
 * the list: they never leave the bar. Before this, the bar scrolled sideways
 * and at 1024 px Undo, Redo and the theme toggle were simply off-screen.
 */
const COLLAPSE_ORDER = ['tb-import-fmi', 'tb-import', 'tb-layout', 'tb-solve', 'tb-simulate', 'tb-new'] as const;
const TOOLBAR_GAP = 6;
const MORE_WIDTH_GUESS = 72;

/**
 * How many of {@link COLLAPSE_ORDER} have to move into "More" for the bar to fit.
 *
 * Widths are measured while a command is on the bar and remembered, so a
 * collapsed command still counts when the window grows again. The bar's
 * natural width is its scroll width minus the flexible spacer; from that the
 * smallest number of commands to move is computed directly — never by
 * collapsing, re-rendering and checking again, which oscillates at the edge.
 */
function useToolbarOverflow(barRef: React.RefObject<HTMLDivElement>): Set<string> {
  const [count, setCount] = useState(0);
  const widths = useRef(new Map<string, number>());
  const moreWidth = useRef(MORE_WIDTH_GUESS);

  const measure = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    for (const id of COLLAPSE_ORDER) {
      const el = bar.querySelector<HTMLElement>(`:scope [data-testid="${id}"]`);
      if (el) widths.current.set(id, el.offsetWidth);
    }
    const more = bar.querySelector<HTMLElement>('[data-testid="tb-more"]');
    if (more) moreWidth.current = more.offsetWidth;
    const spacer = bar.querySelector<HTMLElement>('.toolbar-spacer');
    const width = (id: string): number => (widths.current.get(id) ?? 0) + TOOLBAR_GAP;
    const collapsedNow = COLLAPSE_ORDER.slice(0, count);
    const natural =
      bar.scrollWidth -
      (spacer?.offsetWidth ?? 0) +
      collapsedNow.reduce((sum, id) => sum + width(id), 0) -
      (count > 0 ? moreWidth.current + TOOLBAR_GAP : 0);
    let k = 0;
    let need = natural;
    while (need > bar.clientWidth - 2 && k < COLLAPSE_ORDER.length) {
      need -= width(COLLAPSE_ORDER[k]);
      if (k === 0) need += moreWidth.current + TOOLBAR_GAP;
      k += 1;
    }
    if (k !== count) setCount(k);
  }, [barRef, count]);

  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(bar);
    return () => observer.disconnect();
  }, [barRef, measure]);

  return useMemo(() => new Set<string>(COLLAPSE_ORDER.slice(0, count)), [count]);
}

/** A toolbar button that opens a small dropdown of commands (closes on outside click). */
function ToolbarMenu(props: { label: string; testid: string; items: MenuItem[]; align?: 'start' | 'end'; title?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // Shared roving-tabindex keyboard nav + focus lifecycle (same as canvas menus):
  // focus first item on open, roving ↑/↓, close on Tab-out, restore focus to the
  // trigger on close.
  useRovingMenu(dropdownRef, close, open);
  useEffect(() => {
    if (!open) return;
    // The dropdown lives in a portal, so "outside" is outside both the trigger and the panel.
    const onDown = (e: MouseEvent) => {
      if (!isInside(e.target, ref, dropdownRef)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="toolbar-menu" ref={ref} style={{ position: 'relative' }}>
      <button
        data-testid={props.testid}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={props.title}
      >
        {props.label} ▾
      </button>
      {open && (
        <Popover
          anchor={ref}
          panelRef={dropdownRef}
          className="toolbar-dropdown"
          testid={`${props.testid}-menu`}
          role="menu"
          align={props.align}
        >
          {props.items.map((it) => (
            <button
              key={it.testid}
              className="toolbar-dropdown-item"
              data-testid={it.testid}
              role="menuitem"
              data-menuitem=""
              title={it.title}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

/** Infer the import {@link ModelFormat} from a filename + its contents. */
function detectFormat(name: string, content: string): ModelFormat {
  const lower = name.toLowerCase();
  if (lower.endsWith('.sysml') || lower.endsWith('.txt')) return 'sysml';
  if (lower.endsWith('.json')) {
    try {
      const obj = JSON.parse(content) as Record<string, unknown>;
      // Native snapshots carry `rootIds`; the OMG API graph carries `@type`/`rootElement`.
      if (Array.isArray((obj as { rootIds?: unknown }).rootIds)) return 'model-json';
      if ('@type' in obj || 'rootElement' in obj) return 'api-json';
    } catch {
      /* fall through */
    }
    return 'model-json';
  }
  // Unknown extension: sniff for a leading JSON object.
  return content.trimStart().startsWith('{') ? 'model-json' : 'sysml';
}

/** Read the `width`/`height` (px) declared on the root `<svg>` of a serialized SVG. */
function svgPixelSize(svg: string): { width: number; height: number } {
  const w = Number(/\bwidth="([\d.]+)"/.exec(svg)?.[1]);
  const h = Number(/\bheight="([\d.]+)"/.exec(svg)?.[1]);
  return {
    width: Number.isFinite(w) && w > 0 ? w : 800,
    height: Number.isFinite(h) && h > 0 ? h : 600,
  };
}

/**
 * Rasterise an SVG string to a PNG in the browser and trigger its download.
 * Draws the SVG (as an `Image` from a data-URL) onto an offscreen `<canvas>` at
 * `scale`× resolution, then `canvas.toBlob(...)` → an `<a download>` click.
 * Pure browser DOM; no external libraries.
 */
async function downloadSvgAsPng(svg: string, filename: string, scale = 2): Promise<void> {
  if (typeof document === 'undefined') throw new Error('PNG export requires a browser document');
  const { width, height } = svgPixelSize(svg);
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = new Image();
  img.width = width;
  img.height = height;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to rasterise SVG'));
    img.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Canvas toBlob returned no data');
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Reads the theme actually applied to `<html>` (set pre-paint in index.html). */
function currentTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function Toolbar(): JSX.Element {
  const newProject = useAppStore((s) => s.newProject);
  const saveProject = useAppStore((s) => s.saveProject);
  const loadProject = useAppStore((s) => s.loadProject);
  const listProjects = useAppStore((s) => s.listProjects);
  const importModel = useAppStore((s) => s.importModel);
  const importFmi = useAppStore((s) => s.importFmi);
  const exportModel = useAppStore((s) => s.exportModel);
  const runValidation = useAppStore((s) => s.runValidation);
  const runConstraintCheck = useAppStore((s) => s.runConstraintCheck);
  const simulate = useAppStore((s) => s.simulate);
  const solveParametric = useAppStore((s) => s.solveParametric);
  const rebuildDiagram = useAppStore((s) => s.rebuildDiagram);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);

  const activeView = useAppStore((s) => s.activeView);
  const projectName = useAppStore((s) => s.projectName);
  const model = useAppStore((s) => s.model);
  const selectionId = useAppStore((s) => s.selectionId);
  const rev = useAppStore((s) => s.rev);
  const diagram = useAppStore((s) => s.diagram);
  const canUndo = useAppStore((s) => s.undoStack.length > 0);
  const canRedo = useAppStore((s) => s.redoStack.length > 0);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const openWrapRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(currentTheme);

  const toggleTheme = useCallback(() => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    setTheme(next);
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch {
      setProjects([]);
    }
  }, [listProjects]);

  const togglePicker = useCallback(() => {
    setPickerOpen((open) => {
      const next = !open;
      if (next) void refreshProjects();
      return next;
    });
  }, [refreshProjects]);

  // Close the picker on an outside click.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!isInside(e.target, openWrapRef, pickerRef)) setPickerOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  const onOpenProject = useCallback(
    async (name: string) => {
      setPickerOpen(false);
      try {
        await loadProject(name);
      } catch (err) {
        console.error('loadProject failed', err);
      }
    },
    [loadProject],
  );

  /** The current laid-out graph, or an empty projection for non-graph views. */
  const currentGraph = useCallback(
    (): DiagramGraph => diagram ?? { nodes: [], edges: [], viewKind: activeView as ViewKind },
    [diagram, activeView],
  );

  const onExportSvg = useCallback(() => {
    try {
      const svg = svgFromDiagram(currentGraph());
      downloadText(`${projectName}.svg`, svg, 'image/svg+xml;charset=utf-8');
    } catch (err) {
      console.error('SVG export failed', err);
    }
  }, [currentGraph, projectName]);

  const onExportPng = useCallback(async () => {
    try {
      const svg = svgFromDiagram(currentGraph());
      await downloadSvgAsPng(svg, `${projectName}.png`);
    } catch (err) {
      console.error('PNG export failed', err);
    }
  }, [currentGraph, projectName]);

  /** The block to export as an FMU: the selection if it's a part, else the first. */
  const fmuTarget = useMemo((): string | null => {
    const isBlock = (id: string): boolean => {
      const k = model.get(id)?.eClass;
      return k === 'PartDefinition' || k === 'PartUsage';
    };
    if (selectionId && isBlock(selectionId)) return selectionId;
    return model.all().find((e) => e.attrs.isLibrary !== true && isBlock(e.id))?.id ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, selectionId, rev]);

  const onExportFmu = useCallback(() => {
    const target = fmuTarget;
    if (!target) return;
    try {
      const fmu = exportFmu(model, target);
      downloadBytes(fmu.fileName, fmu.data, 'application/octet-stream');
    } catch (err) {
      console.error('FMU export failed', err);
    }
  }, [model, fmuTarget]);

  const onExportFmiXml = useCallback(() => {
    const target = fmuTarget;
    if (!target) return;
    try {
      const md = fmiModelDescription(model, target);
      downloadText('modelDescription.xml', md.xml, 'application/xml;charset=utf-8');
    } catch (err) {
      console.error('FMI description export failed', err);
    }
  }, [model, fmuTarget]);

  const onImport = useCallback(async () => {
    try {
      const file = await openTextFile('.sysml,.json,.txt');
      if (!file) return;
      importModel(file.content, detectFormat(file.name, file.content));
    } catch (err) {
      console.error('import failed', err);
    }
  }, [importModel]);

  const onImportFmi = useCallback(async () => {
    try {
      const file = await openTextFile('.xml,.txt');
      if (!file) return;
      importFmi(file.content);
    } catch (err) {
      console.error('FMI import failed', err);
    }
  }, [importFmi]);

  // view → { testid, label } lookup for the grouped view bar.
  const viewMeta = new Map<ViewKind, { id: string; label: string }>(
    [...VIEW_COMMANDS, ...EXTRA_VIEW_COMMANDS].map((v) => [v.view, { id: v.id, label: v.label }]),
  );
  // Any reachable view NOT placed in a VIEW_GROUP still shows (in an "Other"
  // group) — so adding a ViewKind to the command list can never silently drop it
  // from the toolbar if someone forgets to categorize it.
  const grouped = new Set(VIEW_GROUPS.flatMap((g) => g.views));
  const ungrouped = [...viewMeta.keys()].filter((v) => !grouped.has(v));
  const viewGroups = ungrouped.length
    ? [...VIEW_GROUPS, { title: 'Other', views: ungrouped }]
    : VIEW_GROUPS;

  // Diagram-only tools (Auto-layout, SVG/PNG export) are inert on non-graph views.
  const isGraphView = GRAPH_VIEWS.has(activeView);
  const graphOnlyTitle = (base: string): string =>
    isGraphView ? base : `${base} — available on a diagram view`;

  const barRef = useRef<HTMLDivElement>(null);
  const collapsed = useToolbarOverflow(barRef);
  // The commands that can give way, as data: the same entry renders as a bar
  // button or as a "More" item, with the same test id either way.
  const collapsible: Record<(typeof COLLAPSE_ORDER)[number], MenuItem> = {
    'tb-new': { label: 'New', testid: 'tb-new', onClick: () => newProject(), title: 'New project' },
    'tb-import': { label: 'Import', testid: 'tb-import', onClick: () => void onImport(), title: 'Import .sysml / .json' },
    'tb-import-fmi': { label: 'Import FMI', testid: 'tb-import-fmi', onClick: () => void onImportFmi(), title: 'Import an FMI 3.0 modelDescription.xml as a SysML block' },
    'tb-simulate': { label: 'Simulate', testid: 'tb-simulate', onClick: () => simulate(), title: 'Simulate the active action flow / state machine' },
    'tb-solve': { label: 'Solve', testid: 'tb-solve', onClick: () => solveParametric(), title: 'Solve parametric constraints & evaluate measures of effectiveness' },
    'tb-layout': { label: 'Auto-layout', testid: 'tb-layout', onClick: () => void rebuildDiagram(), disabled: !isGraphView, title: graphOnlyTitle('Re-run auto-layout') },
  };
  const command = (id: (typeof COLLAPSE_ORDER)[number]): JSX.Element | null => {
    if (collapsed.has(id)) return null;
    const c = collapsible[id];
    return (
      <button data-testid={c.testid} onClick={c.onClick} disabled={c.disabled} title={c.title}>
        {c.label}
      </button>
    );
  };

  return (
    <>
      {/* ── Row 1: command bar (no view tabs → no horizontal scroll) ── */}
      <div className="toolbar" ref={barRef}>
        <span className="toolbar-brand" data-testid="toolbar-brand">
          {PRODUCT_NAME}
        </span>

        {/* File */}
        {command('tb-new')}
        <div className="toolbar-open" ref={openWrapRef} style={{ position: 'relative' }}>
          <button data-testid="tb-open" onClick={togglePicker} title="Open a saved project">
            Open ▾
          </button>
          {pickerOpen && (
            <Popover anchor={openWrapRef} panelRef={pickerRef} className="toolbar-picker" testid="project-picker">
              {projects.length === 0 ? (
                <div className="toolbar-picker-empty">No saved projects</div>
              ) : (
                projects.map((name) => (
                  <button
                    key={name}
                    className="toolbar-picker-item"
                    data-testid="project-pick"
                    data-name={name}
                    onClick={() => void onOpenProject(name)}
                  >
                    {name}
                  </button>
                ))
              )}
            </Popover>
          )}
        </div>
        <button
          data-testid="tb-save"
          onClick={() => void saveProject()}
          title={`Save project "${projectName}"`}
        >
          Save
        </button>
        {command('tb-import')}
        {command('tb-import-fmi')}
        <ToolbarMenu
          label="Export"
          testid="tb-export"
          items={[
            { label: 'SysML (.sysml)', testid: 'tb-export-sysml', onClick: () => exportModel('sysml'), title: 'Export SysML v2 textual notation' },
            { label: 'Model JSON', testid: 'tb-export-json', onClick: () => exportModel('model-json'), title: 'Export native model JSON' },
            { label: 'OMG API JSON', testid: 'tb-export-api-json', onClick: () => exportModel('api-json'), title: 'Export OMG API element-graph JSON' },
            { label: 'Diagram SVG', testid: 'tb-export-svg', onClick: () => onExportSvg(), disabled: !isGraphView, title: graphOnlyTitle('Export the current diagram as SVG') },
            { label: 'Diagram PNG', testid: 'tb-export-png', onClick: () => void onExportPng(), disabled: !isGraphView, title: graphOnlyTitle('Export the current diagram as PNG') },
            { label: 'FMU (.fmu)', testid: 'tb-export-fmu', onClick: () => onExportFmu(), disabled: !fmuTarget, title: 'Export the selected block (else the first part) as an FMI 3.0 FMU' },
            { label: 'FMI description (.xml)', testid: 'tb-export-fmi-xml', onClick: () => onExportFmiXml(), disabled: !fmuTarget, title: 'Export just the FMI 3.0 modelDescription.xml' },
          ]}
        />

        <span className="toolbar-sep" />

        {/* Model */}
        <button data-testid="tb-validate" onClick={() => runValidation()} title="Validate model">
          Validate
        </button>
        <button
          data-testid="tb-check"
          onClick={() => runConstraintCheck()}
          title="Check constraints & requirements"
        >
          Check
        </button>
        {command('tb-simulate')}
        {command('tb-solve')}
        {command('tb-layout')}
        {collapsed.size > 0 && (
          <ToolbarMenu
            label="More"
            testid="tb-more"
            title={`${collapsed.size} command(s) that do not fit at this width`}
            items={COLLAPSE_ORDER.filter((id) => collapsed.has(id)).map((id) => collapsible[id])}
          />
        )}

        <span className="toolbar-spacer" />

        <Collaborate />
        <span className="toolbar-sep" />
        <button data-testid="tb-undo" onClick={() => undo()} disabled={!canUndo} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button data-testid="tb-redo" onClick={() => redo()} disabled={!canRedo} title="Redo (Ctrl+Y)">
          Redo
        </button>
        <span className="toolbar-sep" />
        <button
          data-testid="tb-theme"
          onClick={toggleTheme}
          title="Toggle dark theme"
          aria-label="Toggle dark theme"
          aria-pressed={theme === 'dark'}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>

      {/* ── Row 2: the view switcher, grouped by category, wraps (never scrolls) ── */}
      <div className="viewbar" role="group" aria-label="Views">
        {viewGroups.map((g) => (
          <div key={g.title} className="viewbar-group">
            <span className="viewbar-group-label">{g.title}</span>
            {g.views.map((view) => {
              const meta = viewMeta.get(view);
              if (!meta) return null;
              return (
                <button
                  key={meta.id}
                  data-testid={meta.id}
                  className={`viewbar-tab${activeView === view ? ' is-active' : ''}`}
                  onClick={() => setActiveView(view)}
                  title={`${meta.label} view`}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}

export default Toolbar;
