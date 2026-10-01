#!/usr/bin/env node
/**
 * record-tutorial — a silent, subtitled screen tutorial of the Sysprose app,
 * recorded from a scenario file.
 *
 *   node scripts/record-tutorial.mjs --scenario <file.json> --app <url> --out <dir>
 *
 * Needs a running build of the app (`npm run build && npm run preview`, or any
 * deployment), Playwright's Chromium, and ffmpeg with libass on the PATH.
 *
 * What it does, and why:
 *  - drives the REAL app with a visible pointer: every step is a click, a key
 *    or a typed word on the element named, resolved against the live UI — a
 *    target that is not there stops the recording rather than clicking air;
 *  - captures Chrome's own screencast frames (sharp text at the device scale),
 *    not a re-encoded window recording;
 *  - puts each step's caption — an action label and one sentence — in a band
 *    BELOW the app, so no caption ever covers the interface it explains, and
 *    holds it at least as long as it takes to read (15 characters a second);
 *  - burns the captions in and also writes them as WebVTT, for players that
 *    show subtitles themselves;
 *  - writes one still per step, to check before and after rendering.
 *
 * Scenario (JSON):
 *   {
 *     "name": "sa", "title": "…", "subtitle": "…",
 *     "query": "?model=model/X.sysml",           // appended to --app
 *     "viewport": { "width": 1600, "height": 767, "scale": 1.2 },
 *     "setup": [ <action>… ],                     // done before recording starts
 *     "steps": [ { "label": "OPEN THE LAYER", "text": "…", "do": [ <action>… ], "hold": 2 } ],
 *     "outro": { "title": "…", "text": "…" }
 *   }
 * Actions: {"click": T} {"hover": T} {"dblclick": T} {"type": "text", "into"?: T}
 *   {"zoom": {"at": T, "to": 0.9, "offset"?: [dx, dy]}} (wheel-zoom there)
 *   {"drag": {"from": T, "to": T, "fromOffset"?: [dx, dy], "offset"?: [dx, dy]}}
 *   {"hover": T, "offset"?: [dx, dy]}
 *   {"press": "Enter"} {"view": "state"} {"wait": ms} {"settle": true}
 *   {"expand": QName} (opens an Explorer row if closed) {"delete": QName} (setup
 *   only, through the model API) {"js": "…"} (setup only)
 * Targets T: "view:<kind>", "tree:<QName>", "tree-scope:<QName>",
 *   "tree-twisty:<QName>", "node:<QName>", "tree-toggle:<QName>" (a tree-view
 *   box's +N / −), "port:<part QName>><port name>" (a port handle on a part's
 *   box, interconnection), "palette:<Kind>:<node|edge>",
 *   "testid:<id>", "css:<selector>", "pane:empty" (an empty canvas point).
 */

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/* ─────────────────────────────── arguments ──────────────────────────────── */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.scenario || !args.app || !args.out) {
  console.error('usage: record-tutorial.mjs --scenario <file.json> --app <url> --out <dir>');
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(args.scenario, 'utf8'));
const OUT = resolve(args.out);
const NAME = scenario.name;
const VP = { width: 1600, height: 767, scale: 1.2, ...(scenario.viewport ?? {}) };
const W = Math.round(VP.width * VP.scale); // app pixels in the video
const APP_H = Math.round(VP.height * VP.scale);
const VIDEO_W = 1920;
const VIDEO_H = 1080;
const BAND = VIDEO_H - APP_H; // caption band under the app
if (W !== VIDEO_W || BAND < 120) throw new Error(`viewport ${VP.width}x${VP.height}@${VP.scale} does not leave a caption band in 1920x1080`);
const READ_CPS = 15; // subtitle reading speed, characters per second
const FONT = 'Inter';
const COLORS = { band: '#0f172a', label: '#5eead4', text: '#f8fafc', title: '#0f172a', accent: '#2563eb' };

const work = join(OUT, `.${NAME}-work`);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'frames'), { recursive: true });
rmSync(join(OUT, `${NAME}-stills`), { recursive: true, force: true }); // no stills left from a longer run
mkdirSync(join(OUT, `${NAME}-stills`), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

/* ─────────────────────────────── the pointer ────────────────────────────── */

// A visible pointer with a click ripple: headless capture has no cursor, and a
// tutorial without one cannot show where to click. Styles go through the CSSOM
// so the app's content-security policy does not block them.
const POINTER = `(() => {
  const install = () => {
    if (document.getElementById('__tut_pointer')) return;
    const c = document.createElement('div');
    c.id = '__tut_pointer';
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M4 2 L4 22 L9.5 17 L13.2 25.2 L16.8 23.6 L13.2 15.6 L20.5 15.6 Z" fill="#111827" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', width: '28px', height: '28px', pointerEvents: 'none', zIndex: '2147483647', transform: 'translate(-200px,-200px)' });
    document.body.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + (e.clientX - 4) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      Object.assign(r.style, { position: 'fixed', left: (e.clientX - 20) + 'px', top: (e.clientY - 20) + 'px', width: '40px', height: '40px', borderRadius: '50%', border: '3px solid ${COLORS.accent}', pointerEvents: 'none', zIndex: '2147483646', opacity: '0.95', transform: 'scale(0.35)', transition: 'transform 480ms ease-out, opacity 480ms ease-out' });
      document.body.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(1.35)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 520);
    }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install); else install();
})();`;

/* ──────────────────────────────── the page ──────────────────────────────── */

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: VP.width, height: VP.height },
  deviceScaleFactor: VP.scale,
  colorScheme: 'light',
  reducedMotion: 'no-preference',
});
await context.addInitScript(POINTER);
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !/fetching the script|sw\.js/.test(m.text())) consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR ${e.message}`));

await page.goto(args.app.replace(/\/?$/, '/') + (scenario.query ?? ''));
// Ready = the API is up and the first diagram is laid out and drawn (a large
// model takes seconds after the API appears).
await page.waitForFunction(
  () =>
    !!window.sysml &&
    !!window.sysprose &&
    (window.sysprose.diagram.current()?.nodes.length ?? 0) > 0 &&
    !(window.sysprose.diagram.busy?.() ?? false) &&
    document.querySelectorAll('.react-flow__node').length > 0,
  null,
  { timeout: 180_000 },
);
await sleep(1000);

let pointer = { x: VP.width * 0.55, y: VP.height * 0.5 };
await page.mouse.move(pointer.x, pointer.y);

/** Element id of a qualified name (or of a bare id). */
async function idOf(qname) {
  const id = await page.evaluate((q) => {
    const api = window.sysml;
    const hit = api.byName?.(q) ?? api.resolveName?.(q);
    if (hit) return hit.id;
    return api.getElement(q) ? q : null;
  }, qname);
  if (!id) throw new Error(`no element named ${qname}`);
  return id;
}

/** A target string → a Playwright locator. */
async function locate(target) {
  const [kind, ...rest] = target.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'view':
      return page.getByTestId(`tb-view-${arg}`).first();
    case 'tree':
      return page.locator(`[data-testid="tree-node"][data-elementid="${await idOf(arg)}"]`).first();
    case 'tree-scope':
      return page.locator(`[data-testid="tree-node"][data-elementid="${await idOf(arg)}"] [data-testid="tree-scope"]`).first();
    case 'tree-twisty':
      return page.locator(`[data-testid="tree-node"][data-elementid="${await idOf(arg)}"] .tree-twisty`).first();
    case 'node':
      return page.locator(`.react-flow__node[data-id="${await idOf(arg)}"]`).first();
    case 'port': {
      // `port:<part QName>><port name>` — the handle of that port on that part's
      // box (its own port, or one it has through its type).
      const [partQ, portName] = arg.split('>');
      const partId = await idOf(partQ);
      const handle = await page.evaluate(
        ({ partId, portName }) =>
          window.sysprose.diagram.current()?.nodes.find((n) => n.id === partId)?.ports?.find((p) => p.label === portName)?.id ?? null,
        { partId, portName },
      );
      if (!handle) throw new Error(`no port ${portName} on ${partQ} in this diagram`);
      return page.locator(`.react-flow__node[data-id="${partId}"] .react-flow__handle.source[data-handleid="${handle}"]`).first();
    }
    case 'tree-toggle':
      return page.locator(`.react-flow__node[data-id="${await idOf(arg)}"] [data-testid="tree-toggle"]`).first();
    case 'palette': {
      const [k, t] = arg.split(':');
      return page.locator(`[data-testid="palette-tool"][data-kind="${k}"][data-tooltype="${t ?? 'node'}"]`).first();
    }
    case 'testid':
      return page.getByTestId(arg).first();
    case 'css':
      return page.locator(arg).first();
    default:
      throw new Error(`unknown target ${target}`);
  }
}

/** A free point on the canvas: clear of every box and overlay. */
async function emptyCanvasPoint() {
  const p = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane').getBoundingClientRect();
    const blockers = [...document.querySelectorAll('.react-flow__node, .react-flow__panel, .react-flow__controls, .react-flow__minimap, .react-flow__edge-label, [data-testid="edge-label"]')]
      .map((n) => n.getBoundingClientRect());
    const free = (x, y) => !blockers.some((r) => x >= r.left - 40 && x <= r.right + 40 && y >= r.top - 40 && y <= r.bottom + 40);
    const cx = pane.left + pane.width / 2;
    const cy = pane.top + pane.height / 2;
    let best = null;
    for (let y = pane.top + 60; y < pane.bottom - 60; y += 12) {
      for (let x = pane.left + 60; x < pane.right - 60; x += 12) {
        if (!free(x, y)) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    return best;
  });
  if (!p) throw new Error('no empty point on the canvas');
  return p;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Glide the pointer to (x, y): an eased path, about as fast as a hand. */
async function glide(x, y) {
  const dist = Math.hypot(x - pointer.x, y - pointer.y);
  const ms = Math.max(280, Math.min(950, 260 + dist * 0.7));
  const steps = Math.max(8, Math.round(ms / 16));
  const from = { ...pointer };
  for (let i = 1; i <= steps; i++) {
    const k = ease(i / steps);
    await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
    await sleep(ms / steps);
  }
  pointer = { x, y };
}

/** The centre of a target (or a given offset into it), visible on screen. */
async function pointOf(target) {
  if (target === 'pane:empty') return emptyCanvasPoint();
  const loc = await locate(target);
  await loc.waitFor({ state: 'visible', timeout: 20_000 });
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  if (!b) throw new Error(`${target} has no box`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/**
 * Wait for the diagram to finish laying out and stop moving. Layout runs off
 * the page (in a worker), so nothing on screen changes while it computes: the
 * app's busy flag says when one is still running.
 */
async function settle() {
  await page
    .waitForFunction(() => !(window.sysprose?.diagram.busy?.() ?? false), null, { timeout: 120_000 })
    .catch(() => {});
  let last = '';
  for (let i = 0; i < 60; i++) {
    const key = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.react-flow__node')].slice(0, 40);
      const vp = document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? '';
      return nodes.length + '|' + vp + '|' + nodes.map((n) => n.getAttribute('style')).join(';');
    });
    if (key === last) return;
    last = key;
    await sleep(250);
  }
}

async function act(a, recording) {
  if (a.wait) return sleep(a.wait);
  if (a.settle) return settle();
  if (a.view) {
    await act({ click: `view:${a.view}` }, recording);
    await page.waitForFunction((v) => ['allocation', 'sequence', 'grid', 'requirements', 'contracts', 'analysis', 'planning', 'regroup', 'geometry'].includes(v) || window.sysprose.diagram.current()?.viewKind === v, a.view, { timeout: 120_000 });
    await sleep(400);
    return settle();
  }
  if (a.expand) {
    const open = await page.evaluate(async (q) => {
      const id = window.sysml.byName(q)?.id;
      const row = document.querySelector(`[data-testid="tree-node"][data-elementid="${id}"] .tree-twisty`);
      return row ? row.textContent.trim() : null;
    }, a.expand);
    if (open === '▸') await act({ click: `tree-twisty:${a.expand}` }, recording);
    return;
  }
  if (a.delete) {
    if (recording) throw new Error('delete is a setup action');
    const id = await idOf(a.delete);
    await page.evaluate((i) => window.sysml.delete(i), id);
    return sleep(600);
  }
  if (a.js) {
    if (recording) throw new Error('js is a setup action');
    await page.evaluate(a.js);
    return sleep(300);
  }
  if (a.zoom) {
    // Wheel-zoom at a point, as a hand does: the pointer glides there (plus an
    // optional offset), then the wheel turns until the diagram reaches the scale.
    const p = await pointOf(a.zoom.at);
    const x = p.x + (a.zoom.offset?.[0] ?? 0);
    const y = p.y + (a.zoom.offset?.[1] ?? 0);
    await glide(x, y);
    const scale = () =>
      page.evaluate(() => {
        const m = /scale\(([\d.]+)\)/.exec(document.querySelector('.react-flow__viewport')?.style.transform ?? '');
        return m ? Number(m[1]) : 1;
      });
    for (let i = 0; i < 200; i++) {
      const k = await scale();
      if (Math.abs(Math.log(k / a.zoom.to)) < 0.08) break;
      await page.mouse.wheel(0, k < a.zoom.to ? -100 : 100);
      await sleep(35);
    }
    const reached = await scale();
    if (Math.abs(Math.log(reached / a.zoom.to)) > 0.2) console.warn(`zoom at ${a.zoom.at}: wanted ${a.zoom.to}, reached ${reached.toFixed(3)}`);
    await settle();
    // The pointer has done its job: move it off the subject it zoomed to.
    return glide(x + 90, y + 70);
  }
  if (a.hover) {
    const p = await pointOf(a.hover);
    return glide(p.x + (a.offset?.[0] ?? 0), p.y + (a.offset?.[1] ?? 0));
  }
  if (a.drag) {
    // Press on one target, carry it at a hand's pace, release on another.
    const from = await pointOf(a.drag.from);
    const fx = from.x + (a.drag.fromOffset?.[0] ?? 0);
    const fy = from.y + (a.drag.fromOffset?.[1] ?? 0);
    const to = await pointOf(a.drag.to);
    const tx = to.x + (a.drag.offset?.[0] ?? 0);
    const ty = to.y + (a.drag.offset?.[1] ?? 0);
    await glide(fx, fy);
    await sleep(recording ? 260 : 60);
    await page.mouse.down();
    await sleep(120);
    await glide(tx, ty);
    await sleep(120);
    await page.mouse.up();
    return sleep(recording ? 500 : 150);
  }
  if (a.click || a.dblclick) {
    const target = a.click ?? a.dblclick;
    const p = await pointOf(target);
    const x = p.x + (a.offset?.[0] ?? 0);
    const y = p.y + (a.offset?.[1] ?? 0);
    await glide(x, y);
    await sleep(recording ? 260 : 60); // the pointer rests on the target before the press
    if (a.dblclick) await page.mouse.dblclick(x, y);
    else {
      await page.mouse.down();
      await sleep(90);
      await page.mouse.up();
    }
    return sleep(recording ? 450 : 150);
  }
  if (a.type !== undefined) {
    if (a.into) {
      await act({ click: a.into }, recording);
      await page.keyboard.press('Control+A');
    }
    await page.keyboard.type(a.type, { delay: recording ? 70 : 0 });
    return sleep(250);
  }
  if (a.press) {
    await page.keyboard.press(a.press);
    return sleep(350);
  }
  throw new Error(`unknown action ${JSON.stringify(a)}`);
}

/* ──────────────────────────────── set up ────────────────────────────────── */

for (const a of scenario.setup ?? []) await act(a, false);
await settle();

/* ─────────────────────────────── record ─────────────────────────────────── */

const cdp = await context.newCDPSession(page);
const frames = [];
let frameNo = 0;
cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
  const t = now();
  const file = join(work, 'frames', `f${String(frameNo++).padStart(6, '0')}.jpg`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ t, file });
  try {
    await cdp.send('Page.screencastFrameAck', { sessionId });
  } catch {
    /* the session is closing */
  }
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: W, maxHeight: APP_H, everyNthFrame: 1 });
// Nudge a first frame out: the screencast only sends frames when the page repaints.
await page.mouse.move(pointer.x + 1, pointer.y);
await sleep(300);
const t0 = now();

const timeline = [];
for (const [i, step] of scenario.steps.entries()) {
  const start = now();
  const entry = { label: step.label, text: step.text, start: (start - t0) / 1000 };
  timeline.push(entry);
  for (const a of step.do ?? []) {
    try {
      await act(a, true);
    } catch (err) {
      throw new Error(`step ${i + 1} (${step.label}): ${err.message}`);
    }
  }
  const minRead = ((step.label?.length ?? 0) + (step.text?.length ?? 0)) / READ_CPS + 1.2;
  const elapsed = (now() - start) / 1000;
  const hold = Math.max(step.hold ?? 0, minRead - elapsed, 1.5);
  // Take the step's still once the screen has settled, then finish the hold.
  await sleep(Math.min(hold * 1000, 700));
  await page.screenshot({ path: join(OUT, `${NAME}-stills`, `${String(i + 1).padStart(2, '0')}.png`) });
  await sleep(Math.max(0, hold * 1000 - 700));
  entry.end = (now() - t0) / 1000;
}
await sleep(400);
const tEnd = now();
await cdp.send('Page.stopScreencast');
await sleep(300);
await browser.close();
if (consoleErrors.length) console.warn('console errors while recording:', consoleErrors);
if (!frames.length) throw new Error('no frames captured');

/* ──────────────────────────────── render ────────────────────────────────── */

// 1. The recording: every captured frame for as long as it was on screen.
const concat = [];
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  const tStart = Math.max(f.t, t0);
  const tNext = i + 1 < frames.length ? Math.max(frames[i + 1].t, t0) : tEnd;
  if (tNext <= tStart && i + 1 < frames.length) continue; // before t0: superseded
  concat.push(`file '${f.file}'\nduration ${Math.max(0.001, (tNext - tStart) / 1000).toFixed(4)}`);
}
concat.push(`file '${frames[frames.length - 1].file}'`);
writeFileSync(join(work, 'frames.txt'), concat.join('\n') + '\n');

// 2. Captions: ASS for the burn-in (label + sentence in the band), VTT alongside.
const TITLE_S = 4.0;
const OUTRO_S = 5.0;
const ts = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
};
const assColor = (hex) => `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`;
const esc = (s) => String(s ?? '').replace(/[{}]/g, '').replace(/\n/g, '\\N');
const ass = [
  '[Script Info]',
  'ScriptType: v4.00+',
  `PlayResX: ${VIDEO_W}`,
  `PlayResY: ${VIDEO_H}`,
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  `Style: Label,${FONT},27,${assColor(COLORS.label)},&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,1.5,0,1,0,0,7,64,64,${APP_H + 18},1`,
  `Style: Text,${FONT},34,${assColor(COLORS.text)},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,64,64,${APP_H + 56},1`,
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
];
const vtt = ['WEBVTT', ''];
const vttTs = (s) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
for (const [i, e] of timeline.entries()) {
  ass.push(`Dialogue: 0,${ts(e.start)},${ts(e.end)},Label,,0,0,0,,${esc(e.label)}`);
  ass.push(`Dialogue: 0,${ts(e.start)},${ts(e.end)},Text,,0,0,0,,${esc(e.text)}`);
  vtt.push(String(i + 1), `${vttTs(e.start + TITLE_S)} --> ${vttTs(e.end + TITLE_S)}`, `${e.label}\n${e.text}`, '');
}
writeFileSync(join(work, 'captions.ass'), ass.join('\n') + '\n');
writeFileSync(join(OUT, `${NAME}.vtt`), vtt.join('\n'));

const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
const ENC = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30'];

ff('-f', 'concat', '-safe', '0', '-i', join(work, 'frames.txt'),
  '-vf', `scale=${VIDEO_W}:${APP_H}:flags=lanczos,pad=${VIDEO_W}:${VIDEO_H}:0:0:color=${COLORS.band},subtitles=${join(work, 'captions.ass')},fps=30`,
  ...ENC, join(work, 'main.mp4'));

// 3. Title and closing cards, drawn as pages so they use the same type as the app.
const card = async (file, kicker, title, text) => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: VIDEO_W, height: VIDEO_H } });
  const escHtml = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  await p.setContent(`<!doctype html><html><body style="margin:0;width:${VIDEO_W}px;height:${VIDEO_H}px;background:${COLORS.band};color:${COLORS.text};font-family:${FONT},sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 140px;box-sizing:border-box">
    <div style="color:${COLORS.label};font-size:30px;letter-spacing:3px;font-weight:600;text-transform:uppercase">${escHtml(kicker)}</div>
    <div style="font-size:84px;font-weight:700;line-height:1.1;margin:22px 0 30px">${escHtml(title)}</div>
    <div style="font-size:38px;line-height:1.45;color:#cbd5e1;max-width:1500px">${escHtml(text)}</div></body></html>`);
  await p.screenshot({ path: file });
  await b.close();
};
await card(join(work, 'title.png'), scenario.kicker ?? 'Sysprose tutorial', scenario.title, scenario.subtitle);
await card(join(work, 'outro.png'), scenario.outro?.kicker ?? 'Next', scenario.outro?.title ?? '', scenario.outro?.text ?? '');
for (const [png, secs] of [['title', TITLE_S], ['outro', OUTRO_S]]) {
  ff('-loop', '1', '-t', String(secs), '-i', join(work, `${png}.png`), '-vf', `scale=${VIDEO_W}:${VIDEO_H},fps=30`, ...ENC, join(work, `${png}.mp4`));
}

// 4. One file: title, recording, closing card — silent, web-ready.
writeFileSync(join(work, 'parts.txt'), ['title', 'main', 'outro'].map((p) => `file '${join(work, `${p}.mp4`)}'`).join('\n') + '\n');
ff('-f', 'concat', '-safe', '0', '-i', join(work, 'parts.txt'), '-c', 'copy', '-movflags', '+faststart', '-an', join(OUT, `${NAME}.mp4`));
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(TITLE_S + 1), '-i', join(OUT, `${NAME}.mp4`), '-frames:v', '1', join(OUT, `${NAME}-poster.jpg`)]);

writeFileSync(join(OUT, `${NAME}.timeline.json`), JSON.stringify({ title: scenario.title, titleSeconds: TITLE_S, steps: timeline }, null, 1));
if (!process.env.KEEP_WORK && existsSync(work)) rmSync(work, { recursive: true, force: true });
const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(OUT, `${NAME}.mp4`)]).toString().trim();
console.log(`${NAME}.mp4: ${Number(dur).toFixed(1)} s, ${timeline.length} steps, ${frames.length} frames captured`);
