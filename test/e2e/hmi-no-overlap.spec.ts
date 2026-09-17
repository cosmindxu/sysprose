/**
 * The app's own chrome never covers itself, at any supported width.
 *
 * Scoped to what this project draws around the diagram — the toolbar, the view
 * bar, the palette, the bottom tabs and the canvas overlays — never to React
 * Flow nodes, edges or handles, which a user moves over overlays on purpose.
 *
 * Every assertion here was red before the fix it guards:
 *  - an open toolbar menu was clipped by the toolbar's own `overflow-x: auto`
 *    (which forces `overflow-y` too), and the bar scrolled its buttons out of
 *    sight to show one menu row;
 *  - at 1024 px the toolbar was wider than the window, and Undo, Redo and the
 *    theme toggle sat off-screen with nothing saying so;
 *  - on a small canvas the minimap covered the Legend toggle;
 *  - the active bottom tab was white text on a white ground.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { gotoApp } from './fixtures';

const WIDTHS = [1024, 1280, 1440, 1920] as const;

interface Box { x: number; y: number; width: number; height: number }

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  if (!b) throw new Error('element has no box (not rendered or hidden)');
  return b;
}

const overlap = (a: Box, b: Box): boolean =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;

/** True when the element's centre is the element itself (or inside it) — not clipped, not covered. */
async function reachable(page: Page, locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false;
    const hit = document.elementFromPoint(cx, cy);
    return !!hit && (hit === el || el.contains(hit));
  });
}

/** WCAG relative-luminance contrast of an element's text against its painted ground. */
async function contrast(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const rgb = (s: string): number[] => (s.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]): number => {
      const c = [r, g, b].map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    let ground: HTMLElement | null = el as HTMLElement;
    let bg = 'rgba(0, 0, 0, 0)';
    while (ground) {
      const b = getComputedStyle(ground).backgroundColor;
      if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) {
        bg = b;
        break;
      }
      ground = ground.parentElement;
    }
    const fg = lum(rgb(getComputedStyle(el).color));
    const gr = lum(rgb(bg));
    return (Math.max(fg, gr) + 0.05) / (Math.min(fg, gr) + 0.05);
  });
}

for (const width of WIDTHS) {
  test.describe(`chrome at ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test('every toolbar control is on screen and not covered', async ({ page }) => {
      await gotoApp(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      const controls = page.locator('.toolbar > button, .toolbar > div > button, .viewbar button');
      const count = await controls.count();
      const unreachable: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const c = controls.nth(i);
        if (!(await c.isVisible())) continue;
        if (!(await reachable(page, c))) unreachable.push((await c.getAttribute('data-testid')) ?? (await c.innerText()));
      }
      expect(unreachable, 'toolbar controls off-screen or covered').toEqual([]);
      // Undo and Redo never leave the bar, whatever the width.
      for (const id of ['tb-undo', 'tb-redo', 'tb-save']) await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 });
    });

    test('an open toolbar menu is whole, on top, and leaves the bar in place', async ({ page }) => {
      await gotoApp(page);
      const brand = await box(page.getByTestId('toolbar-brand'));
      await page.getByTestId('tb-export').click();
      const menu = page.getByTestId('tb-export-menu');
      await expect(menu).toBeVisible();
      const items = menu.getByRole('menuitem');
      const n = await items.count();
      expect(n).toBeGreaterThan(1);
      for (let i = 0; i < n; i += 1) {
        await expect(items.nth(i)).toBeInViewport({ ratio: 1 });
        expect(await reachable(page, items.nth(i)), `menu item ${i} covered or clipped`).toBe(true);
      }
      // The bar did not scroll to make room for the menu.
      expect(await box(page.getByTestId('toolbar-brand'))).toEqual(brand);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    });

    test('canvas overlays keep to their own corners', async ({ page }) => {
      await gotoApp(page);
      for (const view of ['general', 'state']) {
        await page.getByTestId(`tb-view-${view}`).click();
        // The sample model's state view may be empty; the overlays are drawn either way.
        await expect(page.locator('.react-flow__controls')).toBeVisible();
        const overlays: Array<[string, Locator]> = [
          ['zoom controls', page.locator('.react-flow__controls')],
          ['canvas actions', page.getByTestId('diagram-minibar')],
          ['legend', page.getByTestId('legend-toggle')],
          ['minimap', page.locator('.react-flow__minimap, [data-testid="minimap-toggle"]').first()],
        ];
        const boxes: Array<[string, Box]> = [];
        for (const [name, loc] of overlays) if (await loc.isVisible()) boxes.push([name, await box(loc)]);
        for (let i = 0; i < boxes.length; i += 1)
          for (let j = i + 1; j < boxes.length; j += 1)
            expect(overlap(boxes[i][1], boxes[j][1]), `${view}: ${boxes[i][0]} overlaps ${boxes[j][0]}`).toBe(false);
      }
    });

    test('tabs and tools are readable and big enough to hit', async ({ page }) => {
      await gotoApp(page);
      const active = page.locator('.bottom-tab.is-active');
      await expect(active).toBeVisible();
      expect(await contrast(active), 'active bottom tab text contrast').toBeGreaterThanOrEqual(4.5);
      const targets = page.locator('.toolbar button:visible, .viewbar button:visible, .bottom-tab:visible, [data-testid="palette"] button:visible');
      const small: string[] = [];
      for (let i = 0; i < (await targets.count()); i += 1) {
        const b = await box(targets.nth(i));
        if (b.width < 24 || b.height < 24) small.push(`${(await targets.nth(i).innerText()).trim() || '?'} ${Math.round(b.width)}×${Math.round(b.height)}`);
      }
      expect(small, 'targets under 24×24 px (WCAG 2.5.8)').toEqual([]);
    });
  });
}

test.describe('at the e2e viewport', () => {
  test('nothing collapses into a More menu, so specs that click toolbar buttons keep working', async ({ page }) => {
    await gotoApp(page);
    await expect(page.getByTestId('tb-more')).toHaveCount(0);
    for (const id of ['tb-validate', 'tb-check', 'tb-simulate', 'tb-solve', 'tb-layout', 'tb-undo', 'tb-redo']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });
});
