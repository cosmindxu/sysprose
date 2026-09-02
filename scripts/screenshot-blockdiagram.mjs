// Screenshot the running tool showing a functional block diagram.
import { chromium } from 'playwright';
const URL = process.env.APP_URL || 'http://localhost:4185';
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await p.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
await p.getByTestId('diagram-canvas').waitFor();
await p.waitForTimeout(1800);

async function view(testid) {
  const btn = p.getByTestId(testid);
  if (await btn.count()) { await btn.click(); await p.waitForTimeout(2200); }
}

// Interconnection view = SysML v2 functional/internal block diagram (parts wired via ports)
await view('tb-view-interconnection');
const ibd = { nodes: await p.locator('.react-flow__node').count(), edges: await p.locator('.react-flow__edge').count() };
await p.screenshot({ path: 'test-results/screenshots/tool-interconnection-blockdiagram.png' });

// General view = block definition diagram (definitions + composition/typing)
await view('tb-view-general');
const bdd = { nodes: await p.locator('.react-flow__node').count(), edges: await p.locator('.react-flow__edge').count() };
await p.screenshot({ path: 'test-results/screenshots/tool-general-bdd.png' });

console.log('RESULT ' + JSON.stringify({ interconnection: ibd, general: bdd, errors: errs.slice(0, 6) }));
await b.close();
