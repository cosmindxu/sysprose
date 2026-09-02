import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp } from './fixtures';
import { PRODUCT_NAME } from '../../src/branding';

/**
 * PWA: the app is installable (linked web manifest) and offline-capable (a
 * service worker registers and activates). The worker is network-first, so it's
 * transparent while online — every other E2E runs unaffected.
 */
test('pwa: manifest is linked and the service worker activates', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // The manifest is linked and describes an installable standalone app.
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toMatch(/manifest\.webmanifest$/); // build uses a relative base
  const manifest = await page.evaluate(async (h) => (await fetch(h!)).json(), href);
  expect(manifest.name).toBe(PRODUCT_NAME);
  expect(manifest.display).toBe('standalone');
  expect(Array.isArray(manifest.icons) && manifest.icons.length).toBeTruthy();

  // The service worker registers and reaches an active, controlling state.
  const active = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  expect(active).toBe(true);

  // The boot shell was precached atomically into a versioned cache (so the app
  // loads offline as a self-consistent unit).
  const precached = await page.evaluate(async () => {
    const key = (await caches.keys()).find((k) => k.startsWith('sysmlv2-'));
    if (!key) return false;
    const cache = await caches.open(key);
    return !!(await cache.match('index.html'));
  });
  expect(precached).toBe(true);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
