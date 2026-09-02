import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp } from './fixtures';

/**
 * Edge-reconnection wiring, asserted deterministically at the DOM level.
 *
 * React Flow renders endpoint-drag anchors (`.react-flow__edgeupdater`) only for
 * edges whose `reconnectable` flag is set AND when an `onReconnect` handler is
 * wired. So "a relationship edge shows anchors, a structural containment edge
 * shows none" proves both that the builder's reconnectable gating reaches RF and
 * that `onReconnect` is live — without a flaky headless pointer-drag. The
 * endpoint math itself is exhaustively covered in unit tests (reconnect.test.ts).
 */
test('canvas: relationship edges expose reconnect anchors; structural edges do not', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // A relationship edge (element-backed, non-port) — hover to surface anchors.
  const relEdge = page.locator('[data-testid^="rf__edge-rel:"]').first();
  await expect(relEdge).toBeAttached();
  const rb = (await relEdge.boundingBox())!;
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await expect(relEdge.locator('.react-flow__edgeupdater')).toHaveCount(2); // source + target

  // A structural containment edge (no backing element → reconnectable:false).
  const structEdge = page
    .locator('[data-testid^="rf__edge-comp:"], [data-testid^="rf__edge-own:"]')
    .first();
  await expect(structEdge).toBeAttached();
  const sb = (await structEdge.boundingBox())!;
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await expect(structEdge.locator('.react-flow__edgeupdater')).toHaveCount(0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
