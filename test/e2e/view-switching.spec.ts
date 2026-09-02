/**
 * View-switching coverage — clicks ALL 16 `tb-view-<kind>` toolbar buttons and
 * asserts the correct centre-panel renderer mounts for each, with zero
 * console/page errors across the whole sweep and a screenshot per view.
 *
 * Renderer contract (see CenterPanel):
 *  - graph views (general/interconnection/action/state/requirement/tree/
 *    parametric/case) → the React Flow `diagram-canvas`;
 *  - allocation → the dedicated `matrix-view` table (no diagram-canvas);
 *  - sequence   → the dedicated `sequence-view` SVG (no diagram-canvas);
 *  - grid       → the dedicated `grid-view` table (no diagram-canvas);
 *  - geometry   → the lazy Three.js `geometry-3d` WebGL view (no diagram-canvas).
 */

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/** The 16 views and the centre-panel testid each is expected to render. */
const GRAPH_VIEWS = [
  'general',
  'interconnection',
  'action',
  'state',
  'requirement',
  'tree',
  'parametric',
  'case',
] as const;

const DEDICATED_VIEWS: Array<{ view: string; testid: string }> = [
  { view: 'allocation', testid: 'matrix-view' },
  { view: 'sequence', testid: 'sequence-view' },
  { view: 'grid', testid: 'grid-view' },
  // The geometry view is now a lazily-loaded Three.js/WebGL renderer, not a
  // React Flow graph — it replaces the canvas with its own `geometry-3d` root.
  { view: 'geometry', testid: 'geometry-3d' },
  // The requirements view is a model-backed DOORS-NG-style editor table.
  { view: 'requirements', testid: 'requirements-table' },
  // The graph-analysis view is a Gephi-style SVG network + DSM.
  { view: 'analysis', testid: 'graph-analysis' },
  // The planning view is a migration/effort wave-planner board.
  { view: 'planning', testid: 'planning-view' },
  // The regroup view is the re-bundling workbench (preview-only in Phase 1).
  { view: 'regroup', testid: 'regroup-view' },
];

test('all 16 views render their correct centre panel without console errors', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // ── Graph views: the React Flow canvas mounts (empty projections still do) ──
  for (const view of GRAPH_VIEWS) {
    await page.getByTestId(`tb-view-${view}`).click();
    await expect(page.getByTestId('diagram-canvas')).toBeVisible();
    await expect(page.locator('.react-flow')).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, `view-${view}`);
  }

  // ── Dedicated (non-graph) views: the specific renderer replaces the canvas ──
  for (const { view, testid } of DEDICATED_VIEWS) {
    await page.getByTestId(`tb-view-${view}`).click();
    await expect(page.getByTestId(testid)).toBeVisible();
    await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
    await shot(page, `view-${view}`);
  }

  // Switching back to a graph view restores the canvas.
  await page.getByTestId('tb-view-general').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});
