// Screenshot the Case (use-case) view with a small ATM use-case model injected
// at runtime via the live SDK (window.sysml) — the built-in sample has no use cases.
import { chromium } from 'playwright';
const URL = process.env.APP_URL || 'http://localhost:4189';
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await p.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
await p.getByTestId('diagram-canvas').waitFor();
await p.waitForTimeout(1500);

const built = await p.evaluate(() => {
  const api = window.sysml;
  if (!api) return 'no window.sysml';
  const M = api.model ?? api;
  const C = (k, o) => {
    const r = M.create ? M.create(k, o) : api.create(k, o);
    return r && r.id ? r.id : r;
  };
  try {
    const pkg = C('Package', { declaredName: 'ATM_System' });
    const uc = C('UseCaseDefinition', { declaredName: 'WithdrawCash', ownerId: pkg });
    C('ReferenceUsage', { declaredName: 'Customer', ownerId: uc, attrs: { caseRole: 'actor' } });
    C('ReferenceUsage', { declaredName: 'Bank', ownerId: uc, attrs: { caseRole: 'actor' } });
    C('PartUsage', { declaredName: 'ATM', ownerId: uc, attrs: { caseRole: 'subject' } });
    const auth = C('UseCaseUsage', { declaredName: 'Authenticate', ownerId: pkg });
    const disp = C('UseCaseUsage', { declaredName: 'DispenseCash', ownerId: pkg });
    const rec = C('UseCaseUsage', { declaredName: 'PrintReceipt', ownerId: pkg });
    C('IncludeUseCaseUsage', { ownerId: uc, source: [uc], target: [auth] });
    C('IncludeUseCaseUsage', { ownerId: uc, source: [uc], target: [disp] });
    C('IncludeUseCaseUsage', { ownerId: uc, source: [uc], target: [rec] });
    return 'ok';
  } catch (e) {
    return 'err: ' + e.message;
  }
});

await p.getByTestId('tb-view-case').click();
await p.waitForTimeout(2000);
const al = p.getByTestId('diagram-autolayout');
if (await al.count()) { await al.click(); await p.waitForTimeout(1800); }
await p.screenshot({ path: 'test-results/screenshots/tool-usecase-diagram.png' });
console.log('RESULT ' + JSON.stringify({
  built,
  rfNodes: await p.locator('.react-flow__node').count(),
  rfEdges: await p.locator('.react-flow__edge').count(),
  errors: errs.slice(0, 6),
}));
await b.close();
