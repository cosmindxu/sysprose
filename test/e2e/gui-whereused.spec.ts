import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, selectElementById } from './fixtures';

test('properties: Metrics show children / descendants for the selection', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Find a user element that has children.
  const pick = await page.evaluate(() => {
    const w = window as unknown as {
      sysml: {
        model: { all(): { id: string; attrs?: Record<string, unknown> }[] };
        children(id: string): unknown[];
      };
    };
    for (const e of w.sysml.model.all()) {
      if (e.attrs?.isLibrary === true) continue;
      const n = w.sysml.children(e.id).length;
      if (n >= 1) return { id: e.id, children: n };
    }
    return null;
  });
  expect(pick, 'a user element with children').not.toBeNull();

  await selectElementById(page, pick!.id);
  await expect(page.getByTestId('metric-children')).toHaveText(String(pick!.children));
  const desc = Number(await page.getByTestId('metric-descendants').textContent());
  expect(desc).toBeGreaterThanOrEqual(pick!.children); // subtree ⊇ direct children

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

/**
 * Properties "Centrality" metric: whole-graph PageRank of the user model, shown
 * per element as a score + rank ("0.0123 · #k of N"). Backed by the pure
 * elementCentrality() helper reusing the Analysis view's pageRank().
 */
test('properties: Centrality shows a PageRank score + rank for a node', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // A user NODE element that is the target of a relationship (so it is part of
  // the centrality graph and has a meaningful score).
  const pick = await page.evaluate(() => {
    const w = window as unknown as {
      sysml: {
        model: {
          all(): { id: string; eClass: string; attrs?: Record<string, unknown>; source?: string[]; target?: string[] }[];
        };
        getElement(id: string): { eClass: string; attrs?: Record<string, unknown> } | undefined;
      };
    };
    for (const e of w.sysml.model.all()) {
      if (e.source?.length && e.target?.length) {
        const t = w.sysml.getElement(e.target[0]!);
        if (t && t.attrs?.isLibrary !== true) return { id: e.target[0]! };
      }
    }
    return null;
  });
  expect(pick, 'a user node targeted by a relationship').not.toBeNull();

  await selectElementById(page, pick!.id);
  const pr = page.getByTestId('metric-pagerank');
  await expect(pr).toBeVisible();
  const txt = (await pr.textContent()) ?? '';
  // Score is a 4-decimal fraction, followed by "#k of N" with 1 ≤ k ≤ N.
  expect(txt).toMatch(/\d\.\d{4}/);
  const m = txt.match(/#(\d+) of (\d+)/);
  expect(m, `rank text in "${txt}"`).not.toBeNull();
  const rank = Number(m![1]);
  const total = Number(m![2]);
  expect(rank).toBeGreaterThanOrEqual(1);
  expect(rank).toBeLessThanOrEqual(total);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

/**
 * Properties "Used by" (where-used) overlay: surfaces the distinct elements that
 * reference the selection, each a click-to-navigate link. Impact analysis at a
 * glance, driven by the api-layer whereUsed().
 */
test('properties: "Used by" lists referencers and click-navigates to one', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Find a relationship in the sample model whose source is a NAMED element;
  // its target is therefore referenced-by that named source.
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

  // Select the referenced (target) element → its "Used by" lists the source.
  await selectElementById(page, pick!.targetId);
  const usedBy = page.getByTestId('prop-used-by');
  await expect(usedBy).toContainText('Used by (');
  const link = page
    .getByTestId('prop-used-by-item')
    .filter({ hasText: pick!.sourceName })
    .first();
  await expect(link).toBeVisible();

  // Clicking the referencer navigates the selection to it.
  await link.click();
  await expect(page.getByTestId('prop-name')).toHaveValue(pick!.sourceName);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
