// Capture the README hero: the wired air vehicle, and the prose that produced it.
//
// COMPOSITION MATTERS HERE. The previous hero was a full 1680x1000 window at
// DPR 2, which GitHub reduces to ~900 px — a 3.7x shrink that put node labels at
// 2.9 CSS pixels, unreadable, with the actual wiring occupying under 5% of the
// image area. This capture fixes that three ways:
//   1. a narrower viewport, so GitHub's reduction is 2.8x rather than 3.7x;
//   2. both side panels collapsed, so the canvas is most of the width;
//   3. the diagram SCOPED to the air vehicle, so the six unconnected part
//      definitions and the empty usage box are not competing for space.
// Scope, not zoom: zooming leaves the clutter in frame at a larger size.
import { chromium } from 'playwright';

const URL = process.env.APP_URL || 'http://localhost:4173';
const OUT = process.env.OUT || 'docs/images/sysprose-uav.png';
const MODEL = process.env.MODEL_FILE || 'examples/uav-isr.sysml';

const { readFileSync } = await import('node:fs');
const source = readFileSync(MODEL, 'utf8');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
await page.getByTestId('diagram-canvas').waitFor();
await page.waitForFunction(() => Boolean(window.sysml), null, { timeout: 60_000 });

// Load the model through the Text tab — the same path a user or agent takes.
await page.getByTestId('tab-text').click();
const editor = page.getByTestId('text-editor');
await editor.waitFor();
await editor.fill(source);
await page.getByTestId('text-apply').click();
await page.waitForTimeout(2500);

// Scope the diagram to the air vehicle, so the picture is the wiring.
const scoped = await page.evaluate(() => {
  const sysml = window.sysml;
  const av = sysml.elementsOfType('PartDefinition').find((e) => e.declaredName === 'AirVehicle');
  if (!av) return null;
  window.sysprose.diagram.scopeTo(av.id);
  return av.id;
});
if (!scoped) throw new Error('AirVehicle not found — did the model load?');

await page.getByTestId('tb-view-interconnection').click();
await page.waitForTimeout(2500);

// Zoom to the air-vehicle frame. Plain "Fit" fits the whole canvas extent and
// leaves the diagram small in a sea of grid; fitting the SELECTION fills it.
await page.locator(`.react-flow__node[data-id="${scoped}"]`).click({ position: { x: 8, y: 6 } });
await page.waitForTimeout(600);
const fitSel = page.getByTestId('diagram-fit-selection');
if (await fitSel.count()) { await fitSel.click(); await page.waitForTimeout(1400); }

// Collapse both side panels so the canvas and the prose share the width.
for (const id of ['explorer-collapse', 'properties-collapse']) {
  const b = page.getByTestId(id);
  if (await b.count()) { await b.click(); await page.waitForTimeout(400); }
}
// Show the AirVehicle definition in the text pane: the caption claims the
// diagram is generated from the prose underneath, so the prose underneath must
// be the part that generates it, not whatever the file happens to end with.
await page.evaluate(() => {
  const ta = document.querySelector('[data-testid="text-editor"]');
  if (!(ta instanceof HTMLTextAreaElement)) return;
  const line = ta.value.split('\n').findIndex((l) => l.includes('part def AirVehicle'));
  if (line < 0) return;
  const perLine = ta.scrollHeight / Math.max(1, ta.value.split('\n').length);
  ta.scrollTop = Math.max(0, (line - 1) * perLine);
  ta.dispatchEvent(new Event('scroll', { bubbles: true }));
});
await page.waitForTimeout(1800);

// Hide the minimap for the capture only. Scoped to one wide frame it paints as
// a near-empty light rectangle that reads as a rendering artefact, and it is
// the single ugliest thing in the shot. Nothing about the MODEL is hidden —
// this is chrome, and the capture is otherwise the unmodified app.
await page.addStyleTag({ content: '.react-flow__minimap { display: none !important; }' });
await page.waitForTimeout(500);

const stats = {
  nodes: await page.locator('.react-flow__node').count(),
  edges: await page.locator('.react-flow__edge').count(),
};
await page.screenshot({ path: OUT });
console.log('RESULT ' + JSON.stringify({ out: OUT, ...stats, errors: errors.slice(0, 6) }));
await browser.close();
