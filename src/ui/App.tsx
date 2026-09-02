/**
 * App — composes the IDE shell: a top toolbar, a three-column body (Explorer ·
 * center canvas+palette · Properties) and a bottom panel (Problems / Text /
 * API). On mount it builds the initial diagram + validation for the
 * sample model, exposes the SDK on `window.sysml`, and wires global keyboard
 * shortcuts.
 *
 * The panel components are authored by sibling agents; they all read and drive
 * the shared {@link useAppStore}. This module only owns the layout.
 */

import { useEffect, useState } from 'react';
import '@xyflow/react/dist/style.css';
import './layout.css';

import { useAppStore } from './store';
import { handleShortcut } from './commands';

import { Toolbar } from './panels/Toolbar';
import { Explorer } from './panels/Explorer';
import { CenterPanel } from './panels/CenterPanel';
import { Breadcrumb } from './panels/Breadcrumb';
import { Palette, viewHasTools } from './panels/Palette';
import { Properties } from './panels/Properties';
import { BottomPanel } from './panels/BottomPanel';

export function App(): JSX.Element {
  const api = useAppStore((s) => s.api);
  const rebuildDiagram = useAppStore((s) => s.rebuildDiagram);
  const runValidation = useAppStore((s) => s.runValidation);
  const libraryReady = useAppStore((s) => s.libraryReady);
  const activeView = useAppStore((s) => s.activeView);

  // One-time bootstrap: expose the SDK and build the initial projection — but
  // only AFTER the standard library has settled into the model. Withholding
  // `window.sysml` and the first diagram build until then keeps the model
  // DETERMINISTIC by the time the app is interactive: element counts, undo
  // history, and simulate traces never shift as the (idempotent, undo-free)
  // library merge lands mid-session. See loadStandardLibraryAsync in store.ts.
  useEffect(() => {
    if (!libraryReady) return;
    (window as unknown as { sysml: typeof api }).sysml = api;
    void rebuildDiagram();
    runValidation();
  }, [api, rebuildDiagram, runValidation, libraryReady]);

  // ── Resizable + collapsible side panels ──────────────────────────────────
  // Widths persist in component state (session-local); a pointer-drag splitter
  // resizes within a clamp, a chevron collapses each side to a thin re-open rail.
  const [explorerW, setExplorerW] = useState(260);
  const [propertiesW, setPropertiesW] = useState(300);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [propertiesCollapsed, setPropertiesCollapsed] = useState(false);
  const startResize = (which: 'explorer' | 'properties') => (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startW = which === 'explorer' ? explorerW : propertiesW;
    const clamp = (v: number) => Math.max(180, Math.min(560, v));
    // Capture the pointer so move/up/CANCEL always target the splitter (even off
    // it), and are torn down on cancel too — no window-level listener leak and no
    // stuck global col-resize cursor if the drag is interrupted.
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* capture unsupported — element listeners below still work */
    }
    const onMove = (ev: PointerEvent) => {
      // Explorer grows rightward; Properties grows leftward.
      const delta = which === 'explorer' ? ev.clientX - startX : startX - ev.clientX;
      const next = clamp(startW + delta);
      if (which === 'explorer') setExplorerW(next);
      else setPropertiesW(next);
    };
    const end = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };

  // Global keyboard shortcuts (undo/redo/save).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore when typing in the text editor / inputs.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'TEXTAREA' ||
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        target?.isContentEditable
      )
        return;
      if (handleShortcut(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Brief loading gate while the standard library merges. It intentionally does
  // NOT render the SDK-backed body (Explorer / diagram-canvas / Properties), so
  // the E2E fixtures — which wait for `diagram-canvas` + `window.sysml` — only
  // proceed once the model has settled.
  if (!libraryReady) {
    return (
      <div className="app app-loading" data-testid="app-loading">
        <div className="app-loading-msg">Loading standard library…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <Toolbar />
      <div className="app-body">
        {explorerCollapsed ? (
          <button
            className="app-rail app-rail-left"
            data-testid="explorer-expand"
            title="Show Explorer"
            aria-label="Show Explorer"
            onClick={() => setExplorerCollapsed(false)}
          >
            <span className="app-rail-chev">›</span>
            <span className="app-rail-label">Explorer</span>
          </button>
        ) : (
          <>
            <aside className="app-explorer" style={{ width: explorerW, flexBasis: explorerW }}>
              <button
                className="app-collapse-btn"
                data-testid="explorer-collapse"
                title="Collapse Explorer"
                aria-label="Collapse Explorer"
                onClick={() => setExplorerCollapsed(true)}
              >
                ‹
              </button>
              <Explorer />
            </aside>
            <div
              className="app-splitter"
              data-testid="explorer-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize Explorer"
              onPointerDown={startResize('explorer')}
            />
          </>
        )}
        <main className="app-center">
          {viewHasTools(activeView) && (
            <aside className="app-palette">
              <Palette />
            </aside>
          )}
          <section className="app-canvas">
            <Breadcrumb />
            <div className="app-canvas-content">
              <CenterPanel />
            </div>
          </section>
        </main>
        {propertiesCollapsed ? (
          <button
            className="app-rail app-rail-right"
            data-testid="properties-expand"
            title="Show Properties"
            aria-label="Show Properties"
            onClick={() => setPropertiesCollapsed(false)}
          >
            <span className="app-rail-chev">‹</span>
            <span className="app-rail-label">Properties</span>
          </button>
        ) : (
          <>
            <div
              className="app-splitter"
              data-testid="properties-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize Properties"
              onPointerDown={startResize('properties')}
            />
            <aside
              className="app-properties"
              style={{ width: propertiesW, flexBasis: propertiesW }}
            >
              <button
                className="app-collapse-btn app-collapse-btn-right"
                data-testid="properties-collapse"
                title="Collapse Properties"
                aria-label="Collapse Properties"
                onClick={() => setPropertiesCollapsed(true)}
              >
                ›
              </button>
              <Properties />
            </aside>
          </>
        )}
      </div>
      <div className="app-bottom">
        <BottomPanel />
      </div>
    </div>
  );
}

export default App;
