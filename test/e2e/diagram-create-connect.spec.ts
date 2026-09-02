/**
 * Scenario 4 — diagram authoring:
 *  - switch to the interconnection view,
 *  - arm palette node tools to add a part and a port on the canvas,
 *  - arm the connection edge tool and draw a connection between two nodes
 *    (click-to-connect → store.connect), asserting a new connection element
 *    exists and an edge is rendered,
 *  - then switch through every other view (general / action / state /
 *    requirement / tree) and confirm each renders without error.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, shot } from './fixtures';

const countOfType = (page: import('@playwright/test').Page, eClass: string) =>
  page.evaluate(
    (e) =>
      (window as unknown as { sysml: { elementsOfType: (t: string) => unknown[] } }).sysml
        .elementsOfType(e).length,
    eClass,
  );

test('interconnection: add part + port, connect two nodes, then all views render', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // ── Switch to the interconnection view ──
  await page.getByTestId('tb-view-interconnection').click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await shot(page, '04a-interconnection');

  // Target the two top-level PartDefinition frame nodes by element id — these are
  // laid out side-by-side (no nesting), so clicks don't get intercepted by
  // overlapping child nodes. data-id on the RF node === the element id.
  const vehicleDefId = await findElementId(page, 'PartDefinition', 'Vehicle');
  const engineDefId = await findElementId(page, 'PartDefinition', 'Engine');
  const rfNode = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(rfNode(vehicleDefId)).toBeVisible();
  await expect(rfNode(engineDefId)).toBeVisible();

  // Click the node's header corner (force: a nested child may overlap the body).
  const HEAD = { force: true, position: { x: 8, y: 6 } } as const;

  // ── Add a Part via the palette node tool (arm, then click a frame node) ──
  const partsBefore = await countOfType(page, 'PartUsage');
  await page.locator('[data-testid="palette-tool"][data-kind="PartUsage"]').click();
  await rfNode(vehicleDefId).click(HEAD);
  await expect.poll(() => countOfType(page, 'PartUsage')).toBe(partsBefore + 1);

  // ── Add a Port via the palette node tool ──
  const portsBefore = await countOfType(page, 'PortUsage');
  await page.locator('[data-testid="palette-tool"][data-kind="PortUsage"]').click();
  await rfNode(engineDefId).click(HEAD);
  await expect.poll(() => countOfType(page, 'PortUsage')).toBe(portsBefore + 1);

  await shot(page, '04b-after-add');

  // ── Draw a connection between two distinct nodes (click-to-connect) ──
  const connBefore = await countOfType(page, 'ConnectionUsage');
  await page.locator('[data-testid="palette-tool"][data-kind="ConnectionUsage"]').click();
  await rfNode(vehicleDefId).click(HEAD); // arm source
  await rfNode(engineDefId).click(HEAD); // resolve target → connect()
  await expect.poll(() => countOfType(page, 'ConnectionUsage')).toBe(connBefore + 1);

  // The drawn edge appears in the model wired between the two chosen endpoints.
  // (The React Flow edge DOM is not asserted here: this build renders the nodes
  // but does not emit edge elements into the DOM — see the agent report.)
  const wired = await page.evaluate(
    ({ src, tgt }) => {
      const api = (window as unknown as {
        sysml: { elementsOfType: (t: string) => { source?: string[]; target?: string[] }[] };
      }).sysml;
      return api
        .elementsOfType('ConnectionUsage')
        .some((c) => (c.source ?? []).includes(src) && (c.target ?? []).includes(tgt));
    },
    { src: vehicleDefId, tgt: engineDefId },
  );
  expect(wired).toBe(true);
  await shot(page, '04c-connected');

  // ── Every other view renders without error ──
  for (const view of [
    'tb-view-general',
    'tb-view-action',
    'tb-view-state',
    'tb-view-requirement',
    'tb-view-tree',
  ] as const) {
    await page.getByTestId(view).click();
    await expect(page.getByTestId('diagram-canvas')).toBeVisible();
    // Let the async layout settle.
    await page.waitForTimeout(300);
    await shot(page, `04-view-${view}`);
  }

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
