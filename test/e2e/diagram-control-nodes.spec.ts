/**
 * Control nodes draw their canonical SysML flow symbols.
 *
 * The action/state views have only ever been checked for "renders without
 * errors". But a control node is nothing *but* its symbol — a fork and a
 * decision carry no text to tell them apart, so if `controlShapeFor()` mapped
 * every kind to the same shape the diagram would be meaningless and every
 * existing test would still pass.
 *
 * The mapping under test is the documented one in `src/diagram/nodes.tsx`:
 * fork/join → thin bar, decision/merge → diamond, initial → filled circle,
 * done → ringed final circle.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, shot } from './fixtures';
import { addChild, renameInTree } from './model-helpers';

/** kind → the shape the SysML notation prescribes. */
const SHAPES: ReadonlyArray<readonly [eClass: string, shape: string]> = [
  ['InitialNode', 'initial'],
  ['DoneNode', 'final'],
  ['ForkNode', 'bar'],
  ['JoinNode', 'bar'],
  ['DecisionNode', 'diamond'],
  ['MergeNode', 'diamond'],
];

test('every control-node kind renders its prescribed flow symbol', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // ── Author an action definition holding one node of each kind ──
  const rootId = await findElementId(page, 'Package', 'VehicleModel');
  const flowId = await addChild(page, rootId, 'ActionDefinition');
  await renameInTree(page, flowId, 'ControlFlow');

  const created: Array<{ id: string; eClass: string; shape: string }> = [];
  for (const [eClass, shape] of SHAPES) {
    const id = await addChild(page, flowId, eClass);
    await renameInTree(page, id, `n${eClass}`);
    created.push({ id, eClass, shape });
  }

  // ── The action view draws them ──
  await page.getByTestId('tb-view-action').click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await shot(page, 'control-nodes-a-flow');

  for (const { id, eClass, shape } of created) {
    const node = page.locator(`.react-flow__node[data-id="${id}"] [data-testid="control-node"]`);
    await expect(node, `${eClass} should render as a control node`).toBeVisible();
    await expect(node, `${eClass} should draw the "${shape}" symbol`).toHaveAttribute(
      'data-control-shape',
      shape,
    );
  }

  // The four distinct symbols are genuinely distinct — not one shape reused.
  const shapes = await page
    .locator('[data-testid="control-node"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-control-shape')));
  expect(new Set(shapes.filter(Boolean)).size).toBe(4);

  // A control node is a symbol, not a box: it never renders the SysML box chrome.
  const firstControl = page.locator(
    `.react-flow__node[data-id="${created[0].id}"] [data-testid="sysml-node"]`,
  );
  await expect(firstControl).toHaveCount(0);
  await shot(page, 'control-nodes-b-symbols');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
