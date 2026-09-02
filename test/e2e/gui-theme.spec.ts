import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * Dark theme: a toolbar toggle flips `data-theme` on <html> (persisted to
 * localStorage), repainting both the token-driven chrome and the diagram
 * (nodes/edges read `var(--node-*)`). The default follows the OS preference.
 */
test('theme: toggle switches light ↔ dark and repaints chrome + diagram', async ({ page }) => {
  const errors = captureErrors(page);
  await page.emulateMedia({ colorScheme: 'light' }); // deterministic default
  await gotoApp(page);

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await shot(page, '82-theme-light');

  // Toggle → dark.
  await page.getByTestId('tb-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const nodeBg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--node-bg').trim(),
  );
  expect(bgDark).not.toBe(bgLight); // chrome repainted
  expect(nodeBg).toBe('#1b212c'); // diagram token flipped to the dark surface
  await shot(page, '83-theme-dark');

  // Choice is persisted.
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');

  // Toggle back → light.
  await page.getByTestId('tb-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
