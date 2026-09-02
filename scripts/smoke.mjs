// Headless smoke test: load the built app, capture console/page errors, verify
// the key panels mount, and screenshot. Tries bundled chromium, falls back to
// system Chrome channel if launch fails (missing system libs).
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:4173';

async function launch() {
  try {
    return await chromium.launch({ headless: true });
  } catch (e) {
    console.error('bundled chromium launch failed, trying channel=chrome:', e.message);
    return await chromium.launch({ headless: true, channel: 'chrome' });
  }
}

const browser = await launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2000);

const count = async (tid) => { try { return await page.getByTestId(tid).count(); } catch { return 0; } };
const result = {
  url: URL,
  hasRoot: await page.locator('#root').count(),
  rootChildren: await page.locator('#root *').count(),
  explorer: await count('explorer'),
  diagramCanvas: await count('diagram-canvas'),
  properties: await count('properties'),
  palette: await count('palette'),
  treeNodes: await count('tree-node'),
  rfNodes: await page.locator('.react-flow__node').count().catch(() => 0),
  errorCount: errors.length,
  errors: errors.slice(0, 12),
};
await page.screenshot({ path: 'test-results/smoke.png', fullPage: true });
console.log('SMOKE_RESULT ' + JSON.stringify(result, null, 2));
await browser.close();
process.exit(result.hasRoot > 0 && result.errorCount === 0 ? 0 : 1);
