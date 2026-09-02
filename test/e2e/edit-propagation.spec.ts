/**
 * One edit, every surface.
 *
 * The modeler shows the same model four ways at once — Explorer tree, diagram
 * canvas, Properties form and the serialized SysML v2 text. A user who renames
 * something in one place expects the other three to agree immediately, and a
 * user who deletes a node on the canvas expects it gone from the tree *and* the
 * notation. These two tests assert exactly that cross-surface coherence, which
 * the per-surface suites (properties / text-sync / gui-context-menu) each only
 * check on their own side of the app.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, openTab, shot } from './fixtures';
import { exists, nameOf, setPropName } from './model-helpers';

test('a Properties rename lands in the tree, on the diagram node, and in the text', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // The interconnection view lays the definitions out as top-level frames, so
  // the node under test is addressable by element id.
  await page.getByTestId('tb-view-interconnection').click();
  const engineDefId = await findElementId(page, 'PartDefinition', 'Engine');
  const node = page.locator(`.react-flow__node[data-id="${engineDefId}"]`);
  await expect(node).toBeVisible();
  await expect(node).toContainText('Engine');

  // The Text tab starts out agreeing with the model.
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  expect(await editor.inputValue()).toContain('part def Engine');
  await shot(page, 'propagate-a-before');

  // ── Rename through the Properties form ──
  await setPropName(page, engineDefId, 'PowerUnit');

  // …the Explorer row, the diagram node and the notation all follow.
  await expect(page.locator(`[data-elementid="${engineDefId}"]`).first()).toContainText(
    'PowerUnit',
  );
  await expect(node).toContainText('PowerUnit');
  await expect.poll(() => editor.inputValue()).toContain('part def PowerUnit');
  await expect.poll(() => editor.inputValue()).not.toContain('part def Engine;');
  await shot(page, 'propagate-b-after');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('deleting a node on the canvas removes it from the tree and from the notation', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-interconnection').click();
  const engineDefId = await findElementId(page, 'PartDefinition', 'Engine');
  const node = page.locator(`.react-flow__node[data-id="${engineDefId}"]`);
  await expect(node).toBeVisible();

  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  expect(await editor.inputValue()).toContain('part def Engine');

  // ── Delete via the node context menu ──
  await node.click({ button: 'right', force: true, position: { x: 8, y: 6 } });
  await expect(page.getByTestId('node-ctx-menu')).toBeVisible();
  await page.getByTestId('node-ctx-delete').click();

  await expect.poll(() => exists(page, engineDefId)).toBe(false);
  await expect(page.locator(`[data-elementid="${engineDefId}"]`)).toHaveCount(0);
  await expect(node).toHaveCount(0);
  await expect.poll(() => editor.inputValue()).not.toContain('part def Engine');
  await shot(page, 'propagate-c-node-deleted');

  // Undo puts it back on every surface at once.
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => nameOf(page, engineDefId)).toBe('Engine');
  await expect(page.locator(`[data-elementid="${engineDefId}"]`).first()).toBeVisible();
  await expect.poll(() => editor.inputValue()).toContain('part def Engine');
  await shot(page, 'propagate-d-node-restored');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
