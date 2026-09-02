/**
 * CenterPanel — chooses the right renderer for the active view.
 *
 * Graph views (general/interconnection/action/state/requirement/tree/parametric)
 * are React Flow projections and render through the existing
 * {@link DiagramCanvas} (keeping its `data-testid="diagram-canvas"`). The
 * non-graph views render their dedicated, prop-driven components from the
 * diagram module: 'allocation' → {@link MatrixView} (from `store.matrix`),
 * 'sequence' → {@link SequenceView} (from `store.sequence`), 'grid' →
 * {@link GridView} (from `store.grid`), and 'geometry' → the lazily-loaded
 * Three.js `Geometry3DView` (from `store.scene`, `data-testid="geometry-3d"`).
 * The 'case' view is a React Flow graph and uses the shared {@link DiagramCanvas}
 * like the other graph views. All report clicks back through `store.select`.
 *
 * The projections are computed asynchronously by `store.rebuildDiagram()` when
 * the view switches, so this component renders a lightweight placeholder until
 * the matrix/sequence/grid is available.
 */

import { Suspense, lazy } from 'react';
import { MatrixView, SequenceView, GridView } from '@diagram/index';
import { useAppStore } from '../store';
import { DiagramCanvas } from './DiagramCanvas';
import { RequirementsTable } from './RequirementsTable';
import { GraphAnalysisView } from './GraphAnalysisView';
import { PlanningView } from './PlanningView';
import { RegroupView } from './RegroupView';

/**
 * The Three.js WebGL geometry view is loaded LAZILY (a dynamic import) so the
 * heavy `three` bundle becomes a separate chunk that is only fetched when the
 * user opens the 'geometry' view — keeping the main app bundle lean.
 */
const Geometry3DView = lazy(() =>
  import('@diagram/Geometry3DView').then((m) => ({ default: m.Geometry3DView })),
);

/** Scroll container for the SVG/table-based (non-React-Flow) views. */
function ScrollBox({ testid, children }: { testid: string; children: React.ReactNode }): JSX.Element {
  return (
    <div
      data-testid={testid}
      style={{ width: '100%', height: '100%', overflow: 'auto', padding: 12, boxSizing: 'border-box' }}
    >
      {children}
    </div>
  );
}

export function CenterPanel(): JSX.Element {
  const activeView = useAppStore((s) => s.activeView);
  const matrix = useAppStore((s) => s.matrix);
  const sequence = useAppStore((s) => s.sequence);
  const grid = useAppStore((s) => s.grid);
  const scene = useAppStore((s) => s.scene);
  const select = useAppStore((s) => s.select);

  if (activeView === 'allocation') {
    return (
      <ScrollBox testid="center-allocation">
        {matrix ? (
          <MatrixView matrix={matrix} onSelect={select} />
        ) : (
          <div className="center-empty">Building allocation matrix…</div>
        )}
      </ScrollBox>
    );
  }

  if (activeView === 'sequence') {
    return (
      <ScrollBox testid="center-sequence">
        {sequence ? (
          <SequenceView sequence={sequence} onSelect={select} />
        ) : (
          <div className="center-empty">Building sequence diagram…</div>
        )}
      </ScrollBox>
    );
  }

  if (activeView === 'grid') {
    return (
      <ScrollBox testid="center-grid">
        {grid ? (
          <GridView grid={grid} onSelect={select} />
        ) : (
          <div className="center-empty">Building grid…</div>
        )}
      </ScrollBox>
    );
  }

  if (activeView === 'requirements') {
    // Model-backed editor (reads the live model + rev directly, like Explorer)
    // — no store projection; it mutates the model in place.
    return (
      <ScrollBox testid="center-requirements">
        <RequirementsTable />
      </ScrollBox>
    );
  }

  if (activeView === 'analysis') {
    return (
      <div data-testid="center-analysis" style={{ width: '100%', height: '100%' }}>
        <GraphAnalysisView />
      </div>
    );
  }

  if (activeView === 'planning') {
    return (
      <div data-testid="center-planning" style={{ width: '100%', height: '100%' }}>
        <PlanningView />
      </div>
    );
  }

  if (activeView === 'regroup') {
    return (
      <div data-testid="center-regroup" style={{ width: '100%', height: '100%' }}>
        <RegroupView />
      </div>
    );
  }

  if (activeView === 'geometry') {
    return (
      <div data-testid="center-geometry" style={{ width: '100%', height: '100%' }}>
        {scene ? (
          <Suspense fallback={<div className="center-empty">Loading 3D geometry view…</div>}>
            <Geometry3DView scene={scene} onSelect={select} />
          </Suspense>
        ) : (
          <div className="center-empty">Building geometry scene…</div>
        )}
      </div>
    );
  }

  // All graph views (including 'case') keep the React Flow canvas (and its data-testid).
  return <DiagramCanvas />;
}

export default CenterPanel;
