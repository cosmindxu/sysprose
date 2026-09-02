import { chromium } from 'playwright';
const URL = 'http://localhost:4189';
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
await p.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
await p.getByTestId('diagram-canvas').waitFor();
await p.waitForTimeout(1200);
await p.evaluate(() => {
  const api = window.sysml; const M = api.model ?? api;
  const C = (k, o) => { const r = M.create ? M.create(k, o) : api.create(k, o); return r && r.id ? r.id : r; };
  const pkg = C('Package', { declaredName: 'ATM_System' });
  const uc = C('UseCaseDefinition', { declaredName: 'WithdrawCash', ownerId: pkg });
  const a = C('UseCaseUsage', { declaredName: 'Authenticate', ownerId: pkg });
  C('IncludeUseCaseUsage', { ownerId: uc, source: [uc], target: [a] });
});
await p.getByTestId('tb-view-case').click();
await p.waitForTimeout(1500);
const m = await p.evaluate(() => {
  const nodes = [...document.querySelectorAll('.react-flow__node')];
  const n = nodes.find((el) => /WithdrawCash/.test(el.textContent || ''));
  if (!n) return { err: 'node not found' };
  const inner = [...n.querySelectorAll('div')].find((d) => {
    const s = getComputedStyle(d); return s.borderRadius.includes('50%') || parseFloat(s.borderTopLeftRadius) > 20;
  }) || n.firstElementChild;
  const ir = inner.getBoundingClientRect();
  const R = (e) => { const bb = e.getBoundingClientRect(); return { cy: +(bb.y + bb.height / 2).toFixed(1), h: bb.height }; };
  const ht = n.querySelector('.react-flow__handle-top');
  const hb = n.querySelector('.react-flow__handle-bottom');
  return {
    ellipseTop: +ir.top.toFixed(1), ellipseBottom: +ir.bottom.toFixed(1), ellipseH: +ir.height.toFixed(1),
    topHandleCy: ht ? R(ht).cy : null, bottomHandleCy: hb ? R(hb).cy : null,
    topGap: ht ? +(R(ht).cy - ir.top).toFixed(1) : null,        // 0 = on the top vertex
    bottomGap: hb ? +(ir.bottom - R(hb).cy).toFixed(1) : null,  // 0 = on the bottom vertex
  };
});
console.log('MEASURE ' + JSON.stringify(m));
await b.close();
