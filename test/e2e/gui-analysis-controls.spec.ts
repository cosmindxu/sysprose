/**
 * Graph Analysis — the view controls, not the algorithms.
 *
 * `graph-analysis.spec.ts` covers the algorithm selectors (clustering, colour-by,
 * DSM ordering, node sizing) and the DSM switch. What it never touches is the
 * filtering surface that decides *what is in the graph at all*: the "Filter ▾"
 * popover, the legend, the live node/edge counter, and the way back from DSM to
 * the graph. A filter that silently fails to exclude anything is invisible in a
 * screenshot but wrong, so the assertions here are on the COUNTS.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/** The node count the view reports in its stats line ("N nodes · M edges"). */
async function reportedNodes(page: Page): Promise<number> {
  const text = (await page.getByTestId('analysis-stats').textContent()) ?? '';
  return Number(/(\d+)\s+nodes/.exec(text)?.[1] ?? NaN);
}

test('the filter popover excludes a node type, and the legend + stats follow', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-analysis').click();
  await expect(page.getByTestId('graph-analysis')).toBeVisible();
  await expect(page.getByTestId('graph-analysis-graph')).toBeVisible();
  await expect(page.getByTestId('analysis-legend')).toBeVisible();

  const drawnNodes = page.getByTestId('graph-node');
  const nodesBefore = await reportedNodes(page);
  expect(nodesBefore).toBeGreaterThan(0);
  // The stats line is not decoration — it matches what is actually drawn.
  await expect.poll(() => drawnNodes.count()).toBe(nodesBefore);
  await shot(page, 'analysis-ctl-a-unfiltered');

  // ── Open the filter popover and switch one node type off ──
  await page.getByTestId('analysis-filter').click();
  const popover = page.getByTestId('analysis-filter-popover');
  await expect(popover).toBeVisible();

  const typeBoxes = popover.locator('.ga-popover-col').first().locator('input[type="checkbox"]');
  await expect.poll(() => typeBoxes.count()).toBeGreaterThan(1);
  // Every type starts included (the "all" default is materialized on first toggle).
  await expect(typeBoxes.first()).toBeChecked();
  await typeBoxes.first().uncheck();

  // Fewer nodes are reported AND fewer are drawn.
  await expect.poll(() => reportedNodes(page)).toBeLessThan(nodesBefore);
  const nodesFiltered = await reportedNodes(page);
  await expect.poll(() => drawnNodes.count()).toBe(nodesFiltered);
  await shot(page, 'analysis-ctl-b-filtered');

  // ── Re-checking it restores the full graph ──
  await typeBoxes.first().check();
  await expect.poll(() => reportedNodes(page)).toBe(nodesBefore);
  await expect.poll(() => drawnNodes.count()).toBe(nodesBefore);

  // The popover closes again from its own toggle.
  await page.getByTestId('analysis-filter').click();
  await expect(popover).toHaveCount(0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('DSM and graph are two views of one analysis, and the legend recolours by type', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-analysis').click();
  await expect(page.getByTestId('graph-analysis-graph')).toBeVisible();
  const nodes = await reportedNodes(page);

  // ── Switch to DSM and back; the analysis behind both is the same ──
  await page.getByTestId('analysis-mode-dsm').click();
  await expect(page.getByTestId('dsm-view')).toBeVisible();
  await expect(page.getByTestId('graph-analysis-graph')).toHaveCount(0);
  expect(await reportedNodes(page)).toBe(nodes);
  await shot(page, 'analysis-ctl-c-dsm');

  await page.getByTestId('analysis-mode-graph').click();
  await expect(page.getByTestId('graph-analysis-graph')).toBeVisible();
  await expect(page.getByTestId('dsm-view')).toHaveCount(0);
  expect(await reportedNodes(page)).toBe(nodes);

  // ── With colour-by = type the legend swatches become editable colour inputs ──
  await page.getByTestId('analysis-colorby').selectOption('type');
  const swatch = page.getByTestId('analysis-color').first();
  await expect(swatch).toBeVisible();
  const original = await swatch.inputValue();
  await swatch.fill('#ff00ff');
  await expect(swatch).toHaveValue('#ff00ff');
  expect(original).not.toBe('#ff00ff');
  await shot(page, 'analysis-ctl-d-recoloured');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
