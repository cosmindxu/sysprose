/**
 * Scenario — opening a model from the page URL (`?model=` / `?source=`).
 *
 * The model file is served through `page.route`, so nothing test-only ships in
 * `dist`. A relative `?model=` path is the case a project uses when it deploys
 * its model next to the app (same origin, no CSP change); the failure cases
 * check that a bad link falls back to the sample model and says why, rather
 * than leaving an empty or half-loaded app.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors } from './fixtures';

const FIXTURE = `package LinkedFixture {
    doc /* A small model opened through ?model= */
    part def Drone {
        attribute massKg : ScalarValues::Real;
    }
    part def Swarm {
        part members : Drone [3];
    }
}
`;

const SOURCE = 'https://github.com/example/repo/tree/main/model';

interface Sdk {
  roots(): { declaredName?: string }[];
}

/** Serve `body` (or a status) for any request whose path ends in `path`. */
async function serve(page: Page, path: string, body: string | number): Promise<void> {
  await page.route(`**/${path}`, (route) =>
    typeof body === 'number'
      ? route.fulfill({ status: body, body: 'not here' })
      : route.fulfill({ status: 200, contentType: 'text/plain', body }),
  );
}

/** Open the app at `query` and wait for it to leave the loading gate. */
async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('diagram-canvas')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => !!(window as unknown as { sysml?: unknown }).sysml);
}

async function rootNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { sysml: Sdk }).sysml.roots().map((r) => r.declaredName ?? ''),
  );
}

test('?model= opens the linked model in place of the sample, with a propose-change link', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await serve(page, 'linked/Fixture.sysml', FIXTURE);
  await open(page, `?model=linked/Fixture.sysml&source=${encodeURIComponent(SOURCE)}`);

  await expect.poll(() => rootNames(page)).toContain('LinkedFixture');
  expect(await rootNames(page)).toEqual(['LinkedFixture']);

  const banner = page.getByTestId('linked-banner');
  await expect(banner).toHaveAttribute('data-status', 'loaded');
  await expect(banner).toContainText('Fixture.sysml');
  const link = page.getByTestId('linked-banner-source');
  await expect(link).toHaveAttribute('href', SOURCE);
  await expect(link).toHaveAttribute('target', '_blank');

  // The linked model is where the session starts: nothing to undo back to.
  await expect(page.getByTestId('tb-undo')).toBeDisabled();

  await page.getByTestId('linked-banner-close').click();
  await expect(banner).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('?model= that 404s falls back to the sample model and says why', async ({ page }) => {
  await serve(page, 'linked/Missing.sysml', 404);
  await open(page, '?model=linked/Missing.sysml');

  const banner = page.getByTestId('linked-banner');
  await expect(banner).toHaveAttribute('data-status', 'failed');
  await expect(banner).toContainText('HTTP 404');
  expect((await rootNames(page)).length).toBeGreaterThan(0);
  expect(await rootNames(page)).not.toContain('LinkedFixture');
});

test('?model= with a non-http scheme is refused without fetching', async ({ page }) => {
  await open(page, `?model=${encodeURIComponent('javascript:alert(1)')}`);
  const banner = page.getByTestId('linked-banner');
  await expect(banner).toHaveAttribute('data-status', 'failed');
  await expect(banner).toContainText('only http(s) URLs');
});

test('?source= with a non-http scheme renders no link', async ({ page }) => {
  await serve(page, 'linked/Fixture.sysml', FIXTURE);
  await open(page, `?model=linked/Fixture.sysml&source=${encodeURIComponent('javascript:alert(1)')}`);
  await expect(page.getByTestId('linked-banner')).toHaveAttribute('data-status', 'loaded');
  await expect(page.getByTestId('linked-banner-source')).toHaveCount(0);
});

test('without ?model= there is no banner', async ({ page }) => {
  await open(page, '');
  await expect(page.getByTestId('linked-banner')).toHaveCount(0);
});
