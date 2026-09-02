import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, selectElementById } from './fixtures';

/**
 * Impact graph: a collapsible radial graph in Properties of the selection's
 * 1-hop reference neighbourhood (fan-in + fan-out), with click-to-navigate nodes.
 */
test('properties: the impact graph shows neighbours and navigates on click', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Pick a relationship whose source is named → its target has that neighbour.
  const pick = await page.evaluate(() => {
    const w = window as unknown as {
      sysml: {
        model: { all(): { id: string; source?: string[]; target?: string[] }[] };
        getElement(id: string): { declaredName?: string } | undefined;
      };
    };
    for (const e of w.sysml.model.all()) {
      if (e.source?.length && e.target?.length && e.source[0] !== e.target[0]) {
        const src = w.sysml.getElement(e.source[0]);
        if (src?.declaredName) return { targetId: e.target[0]!, sourceName: src.declaredName };
      }
    }
    return null;
  });
  expect(pick, 'a relationship with a named source').not.toBeNull();

  await selectElementById(page, pick!.targetId);

  // Expand the impact graph.
  await page.getByTestId('prop-impact-toggle').click();
  const graph = page.getByTestId('impact-graph');
  await expect(graph).toBeVisible();
  await expect(page.getByTestId('impact-node')).not.toHaveCount(0);

  // Click the neighbour matching the source → navigate to it.
  await graph.getByTestId('impact-node').filter({ hasText: pick!.sourceName }).first().click();
  await expect(page.getByTestId('prop-name')).toHaveValue(pick!.sourceName);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
