import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp } from './fixtures';

/**
 * Reduced-motion: with the OS "reduce motion" preference on, the global CSS
 * reset neutralizes transitions/animations (JS fit animations are gated
 * separately in DiagramCanvas). We assert an element that normally has a
 * 0.12s transition collapses to ~0 under the preference.
 */
const collapseTransition = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const el = document.querySelector('.app-collapse-btn');
    return el ? getComputedStyle(el).transitionDuration : null;
  });

test('reduced-motion: transitions are neutralized when the user prefers reduced motion', async ({
  page,
}) => {
  const errors = captureErrors(page);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await gotoApp(page);
  const normal = await collapseTransition(page);
  expect(normal).not.toBeNull();
  expect(parseFloat(normal!)).toBeGreaterThan(0.05); // ~0.12s

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await collapseTransition(page);
  expect(parseFloat(reduced!)).toBeLessThan(0.01); // ~0.01ms

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('accessibility: keyboard focus shows a visible focus ring', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Tab into the UI — keyboard modality makes :focus-visible apply. Land on the
  // first focusable control (skip the body).
  let ring: { matches: boolean; width: string; style: string } | null = null;
  for (let i = 0; i < 3 && !ring; i++) {
    await page.keyboard.press('Tab');
    ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return { matches: el.matches(':focus-visible'), width: cs.outlineWidth, style: cs.outlineStyle };
    });
  }
  expect(ring, 'a focusable control received keyboard focus').not.toBeNull();
  expect(ring!.matches).toBe(true); // :focus-visible is active
  expect(parseFloat(ring!.width)).toBeGreaterThanOrEqual(2); // 2px ring
  expect(ring!.style).toBe('solid');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
