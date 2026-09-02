/**
 * Playwright E2E configuration for Sysprose.
 *
 * Drives the *built* app served by `vite preview` on :4173 (the vboxsf share is
 * slow, so the build/node_modules live on the home filesystem — see PROJECT
 * ROOT note). A single worker is used because the preview server and the
 * IndexedDB-backed persistence are a shared, serial resource under vboxsf.
 *
 * Browser: the bundled Chromium is used by default (verified to launch headless
 * in this environment via scripts/smoke.mjs). If a future environment lacks the
 * system libraries Chromium needs, set `channel: 'chrome'` in `use` below to
 * fall back to the system Google Chrome (which is installed at
 * /usr/bin/google-chrome).
 */

import { defineConfig, devices } from '@playwright/test';

/**
 * Watch the suite drive a REAL visible browser:
 *
 *     HEADED=1 npx playwright test undo-redo-deep       # on your desktop
 *     HEADED=1 SLOWMO=400 npx playwright test           # slow enough to follow
 *     VIDEO=1 npx playwright test <spec>                # .webm per test instead
 *
 * `HEADED` needs a display (`DISPLAY` set). `SLOWMO` is the per-action pause in
 * ms (default 150) — without it a headed run is far too fast to read. `VIDEO`
 * records `test-results/e2e/<test>/video.webm` and works headless too, which is
 * the option to use over SSH or in CI.
 *
 * ⚠️ A headed run takes real keyboard focus on the desktop: anything typed while
 * it runs lands in whatever field the test has focused (observed once as a
 * `prop-value` of "3dddd" and a spurious failure). Don't type during a headed
 * run — or use `VIDEO=1` headless and watch the recording instead.
 */
const HEADED = !!process.env.HEADED;
const SLOWMO = Number(process.env.SLOWMO ?? 150);

export default defineConfig({
  testDir: 'test/e2e',
  outputDir: 'test-results/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/e2e-results.json' }],
  ],

  use: {
    baseURL: 'http://localhost:4173',
    headless: !HEADED,
    launchOptions: HEADED ? { slowMo: SLOWMO } : {},
    video: process.env.VIDEO ? 'on' : 'off',
    screenshot: 'on',
    trace: 'on-first-retry',
    // To fall back to the system Chrome (missing-libs environments), uncomment:
    // channel: 'chrome',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: undefined },
    },
  ],

  // Two servers: the built app (vite preview :4173) and the Yjs collaboration
  // relay (`npm run collab` on :1234). The relay is Node-only (imports "ws") and
  // is exercised solely by test/e2e/collab.spec.ts — the browser never imports it.
  webServer: [
    {
      command: 'npm run build && npm run preview',
      url: 'http://localhost:4173',
      timeout: 180_000,
      reuseExistingServer: true,
    },
    {
      command: 'npm run collab',
      url: 'http://localhost:1234',
      timeout: 60_000,
      reuseExistingServer: true,
    },
  ],
});
