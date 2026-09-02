import { chromium } from 'playwright';
const APP_URL = process.env.APP_URL || 'http://localhost:4173';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(APP_URL, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
const views = ['general', 'interconnection', 'action', 'state', 'requirement', 'tree'];
const out = {};
for (const v of views) {
  const btn = p.getByTestId('tb-view-' + v);
  if (await btn.count()) { await btn.click(); await p.waitForTimeout(1200); }
  out[v] = {
    rfNodes: await p.locator('.react-flow__node').count(),
    rfEdges: await p.locator('.react-flow__edge').count(),
    handles: await p.locator('.react-flow__handle').count(),
  };
}
console.log('EDGECHECK ' + JSON.stringify(out, null, 2));
console.log('ERRORS ' + JSON.stringify(errs.slice(0, 6)));
await b.close();
