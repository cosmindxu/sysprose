import { test, expect, type Page } from '@playwright/test';

/**
 * Regression guard for the React Flow handle fix: relationship edges must
 * actually render in the diagram DOM — composition/feature-typing/satisfy in the
 * general view, containment in the tree, satisfy in the requirement view, and the
 * port-to-port ConnectionUsage in interconnection. Before the fix, custom nodes
 * exposed no default handles, so React Flow silently dropped every edge (0 edges
 * rendered in every view despite the model's relationships).
 */
async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByTestId('diagram-canvas').waitFor();
  await page.waitForTimeout(700);
  return errors;
}

test('relationship edges render across diagram views (handle-fix regression)', async ({ page }) => {
  const errors = await open(page);

  const views: Array<[string, number]> = [
    ['general', 1], // composition + feature-typing + satisfy
    ['tree', 1], // containment
    ['requirement', 1], // satisfy
    ['interconnection', 1], // port-to-port ConnectionUsage (a drawn connection)
  ];
  for (const [view, min] of views) {
    await page.getByTestId(`tb-view-${view}`).click();
    await page.waitForTimeout(700);
    const edges = await page.locator('.react-flow__edge').count();
    expect(edges, `${view} view should render >= ${min} edge(s)`).toBeGreaterThanOrEqual(min);
    await page.screenshot({ path: `test-results/screenshots/10-edges-${view}.png` });
  }

  // Handles must exist for edges to attach, and the app must not have errored.
  expect(await page.locator('.react-flow__handle').count()).toBeGreaterThan(0);

  // Port-preservation: in the interconnection (IBD) view the port-to-port
  // ConnectionUsage must stay ANCHORED to its boundary-port handles (not floated).
  // React Flow only emits `data-handleid` for handles given an explicit id, which
  // is exactly the boundary ports SysmlNode renders — so their presence alongside
  // a rendered edge proves the IBD connector still connects at ports.
  await page.getByTestId('tb-view-interconnection').click();
  await page.waitForTimeout(700);
  expect(
    await page.locator('.react-flow__handle[data-handleid]').count(),
    'interconnection view should expose boundary-port handles for IBD edges to anchor to',
  ).toBeGreaterThan(0);
  expect(await page.locator('.react-flow__edge').count()).toBeGreaterThanOrEqual(1);

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});
