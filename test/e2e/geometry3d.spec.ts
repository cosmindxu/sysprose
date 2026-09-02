/**
 * E2E coverage for the 3D geometry view (Three.js/WebGL).
 *
 * Switching to the geometry view mounts the lazily-loaded {@link Geometry3DView},
 * which creates a real `WebGLRenderer` — headless Chromium provides a WebGL
 * context (swiftshader), so the `<canvas>` renders for real. This asserts the
 * `geometry-3d` root is present and contains a `<canvas>`, that no uncaught
 * console/page errors occur, captures a screenshot, and that clicking the canvas
 * (a raycast/select gesture) does not throw.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

test('geometry view renders a real WebGL canvas and handles clicks', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Switch to the geometry view → the lazy Three.js chunk loads + mounts.
  await page.getByTestId('tb-view-geometry').click();

  // The dedicated 3D root replaces the React Flow canvas.
  const root = page.getByTestId('geometry-3d');
  await expect(root).toBeVisible();
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);

  // A real <canvas> is created inside the root (WebGL render, not the fallback).
  const canvas = root.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveCount(1);

  // Let the render loop settle, then screenshot the 3D scene.
  await page.waitForTimeout(600);
  await shot(page, 'geometry3d');

  // Clicking the canvas raycasts for a mesh → must not throw / log errors.
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(200);
    // A drag (orbit) followed by release should also be error-free.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
  }
  await page.waitForTimeout(200);

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});
