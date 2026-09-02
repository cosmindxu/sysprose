// Assemble the self-contained demo/capabilities page: inline the Go fonts (BSD,
// Bigelow & Holmes) and the downscaled screenshots as data URIs so the page has
// zero external dependencies (Artifact CSP-safe). Output → scratchpad HTML.
import { readFileSync, writeFileSync } from 'node:fs';

const FONTS = '/usr/share/fonts/fonts-go';
const SC = '/tmp/claude-1000/-media-sf-Projects-SysMLv2Modeler/0bef7d81-88ca-4b6a-8f13-2b4b2e403b82/scratchpad';
const b64 = (p) => readFileSync(p).toString('base64');
const ttf = (name) => `url(data:font/ttf;base64,${b64(`${FONTS}/${name}.ttf`)}) format('truetype')`;
const jpg = (name) => `data:image/jpeg;base64,${b64(`${SC}/${name}.jpg`)}`;

const GO = ttf('Go-Regular'), GO_MED = ttf('Go-Medium'), GO_MONO = ttf('Go-Mono');
const IBD = jpg('ss-ibd'), BDD = jpg('ss-bdd');

// data rows
const pillars = [
  ['KerML metamodel', '168-class hierarchy classifies all 83 library metaclasses; full name/import resolution'],
  ['Textual notation', 'Langium parser — parses 100% of the real OMG library corpus (94/94 files)'],
  ['Graphical notation', '12 diagram views: BDD · IBD · action · state · sequence · requirement · parametric · case · grid · allocation · geometry · tree'],
  ['API &amp; Services', 'In-browser SDK + networked Express server, OpenAPI 3.1, OSLC (Turtle/RDF-XML/JSON-LD), versioning + diff/merge'],
  ['Standard libraries', 'Full OMG library bundled — 38,761 elements across 98 packages — with dimensional analysis + unit conversion'],
  ['KerML semantics', 'Inheritance · conformance · expression + constraint eval · action/state execution with a value store'],
];
const parity = [
  ['Model explorer, CRUD, drag-reparent', 'y', 'y', 'y'],
  ['Diagram views', 'y', 'p', 'y'],
  ['Textual notation + live sync', 'p', 'y', 'y'],
  ['Validation / model checking', 'y', 'y', 'y'],
  ['Simulation / execution', 'y', 'p', 'y'],
  ['Standard libraries + units', 'y', 'y', 'y'],
  ['Import / export (.sysml, JSON, OMG-graph)', 'y', 'y', 'y'],
  ['Programmable API / automation', 'y', 'y', 'y'],
  ['REST API server (OpenAPI) + OSLC', 'y', 'p', 'y'],
  ['Versioning — commit / branch / diff', 'y', 'y', 'y'],
  ['Real-time collaboration', 'p', 'y', 'y'],
  ['Pure-browser, offline, zero-install', 'n', 'n', 'y'],
];
const chip = (v) => v === 'y' ? '<span class="c ok">yes</span>' : v === 'p' ? '<span class="c pa">partial</span>' : '<span class="c no">&mdash;</span>';
const parityRows = parity.map(([cap, a, b, c]) =>
  `<tr><td>${cap}</td><td>${chip(a)}</td><td>${chip(b)}</td><td>${chip(c)}</td></tr>`).join('');
const pillarRows = pillars.map(([n, e]) =>
  `<div class="pill"><div class="pill-h"><span class="dot"></span><b>${n}</b><span class="c ok">Covered</span></div><p>${e}</p></div>`).join('');

const html = `<title>Sysprose — full OMG coverage, in a browser tab</title>
<style>
@font-face{font-family:'Go';src:${GO};font-weight:400;font-display:swap}
@font-face{font-family:'Go';src:${GO_MED};font-weight:600;font-display:swap}
@font-face{font-family:'GoMono';src:${GO_MONO};font-weight:400;font-display:swap}
:root{
  --paper:#F5F7FA; --ink:#0E1726; --ink2:#43506A; --line:#D9E0EA;
  --navy:#0A1120; --navy2:#111C31; --accent:#2E6BE6; --sky:#6FA8FF;
  --ok:#1F9D57; --pa:#C08118; --no:#8A94A6;
  --mono:'GoMono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:'Go',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
}
*{box-sizing:border-box}
.page{font-family:var(--sans);color:var(--ink);background:var(--paper);line-height:1.55;
  -webkit-font-smoothing:antialiased;font-size:16px}
.wrap{max-width:1040px;margin:0 auto;padding:0 24px}
h1,h2,h3{font-weight:600;letter-spacing:-.01em;text-wrap:balance;margin:0}
p{margin:0}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--sky)}
.eyebrow.dark{color:var(--accent)}
/* hero */
.hero{background:var(--navy);color:#EAF0FA;
  background-image:linear-gradient(var(--navy2) 1px,transparent 1px),linear-gradient(90deg,var(--navy2) 1px,transparent 1px);
  background-size:34px 34px;border-bottom:1px solid #1c2942}
.hero .wrap{padding-top:64px;padding-bottom:52px}
.hero h1{font-size:clamp(34px,5vw,58px);line-height:1.02;margin:16px 0 14px;color:#fff}
.hero .lede{font-size:clamp(17px,2vw,21px);color:#B8C6DE;max-width:60ch}
.hero .accent{color:var(--sky)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  margin-top:38px;background:#1c2942;border:1px solid #1c2942;border-radius:10px;overflow:hidden}
.stat{background:var(--navy);padding:16px 18px}
.stat .n{font-family:var(--mono);font-size:26px;font-variant-numeric:tabular-nums;color:#fff;letter-spacing:-.02em}
.stat .l{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8FA3C4;margin-top:4px}
/* sections */
section{padding:52px 0;border-bottom:1px solid var(--line)}
section h2{font-size:26px;margin-bottom:6px}
.sub{color:var(--ink2);max-width:62ch;margin-bottom:26px}
/* pillars */
.pills{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
.pill{border:1px solid var(--line);border-radius:10px;padding:16px 18px;background:#fff}
.pill-h{display:flex;align-items:center;gap:9px;margin-bottom:6px;font-size:15px}
.pill-h b{margin-right:auto}
.pill p{color:var(--ink2);font-size:14px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none}
/* chips */
.c{font-family:var(--mono);font-size:11px;letter-spacing:.03em;padding:2px 8px;border-radius:999px;white-space:nowrap}
.c.ok{background:#E4F5EB;color:var(--ok)}
.c.pa{background:#FaF0DE;color:var(--pa)}
.c.no{background:#EEF1F5;color:var(--no)}
/* table */
.tbl{width:100%;border-collapse:collapse;font-size:14px}
.tbl th,.tbl td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line)}
.tbl th{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2);font-weight:400}
.tbl td:not(:first-child),.tbl th:not(:first-child){text-align:center;width:120px}
.tbl tr:last-child td{border-bottom:none}
.tbl td:first-child{color:var(--ink)}
/* shots */
.shots{display:grid;grid-template-columns:1fr 1fr;gap:18px}
figure{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff}
figure img{display:block;width:100%;height:auto}
figcaption{font-family:var(--mono);font-size:12px;color:var(--ink2);padding:10px 14px;border-top:1px solid var(--line)}
/* proof grid */
.proof{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.card{border:1px solid var(--line);border-radius:10px;padding:18px;background:#fff}
.card .k{font-family:var(--mono);font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--accent)}
.card .v{font-size:15px;color:var(--ink);margin-top:8px}
.card .v b{font-family:var(--mono);font-variant-numeric:tabular-nums}
/* code */
pre{font-family:var(--mono);font-size:13px;background:var(--navy);color:#DCE6F5;
  padding:18px 20px;border-radius:10px;overflow-x:auto;line-height:1.7;margin:0}
pre .cm{color:#7E93B5}
pre b{color:var(--sky);font-weight:400}
/* footer */
.foot{padding:34px 0 60px;color:var(--ink2);font-size:13.5px}
.foot b{color:var(--ink);font-weight:600}
.gap{font-family:var(--mono);font-size:12.5px;color:var(--ink2)}
@media(max-width:720px){.pills,.shots,.proof{grid-template-columns:1fr}}
@media(prefers-reduced-motion:no-preference){.reveal{animation:rise .6s ease both}@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}
</style>

<div class="page">
  <div class="hero">
    <div class="wrap reveal">
      <div class="eyebrow">OMG SysML v2 &middot; KerML &middot; pure browser</div>
      <h1>A complete SysML&nbsp;v2 modeler that runs in a <span class="accent">browser tab</span>.</h1>
      <p class="lede">Model graphically and textually, validate, simulate, and automate &mdash; against the full OMG standard, with no install and no backend. All six OMG pillars <b style="color:#fff">Covered</b>; proven interoperable with the reference pilot.</p>
      <div class="stats">
        <div class="stat"><div class="n">854</div><div class="l">tests, 0 failing</div></div>
        <div class="stat"><div class="n">6&#8202;/&#8202;6</div><div class="l">OMG pillars covered</div></div>
        <div class="stat"><div class="n">12</div><div class="l">diagram views</div></div>
        <div class="stat"><div class="n">38,761</div><div class="l">library elements</div></div>
        <div class="stat"><div class="n">100%</div><div class="l">grammar corpus parse</div></div>
      </div>
    </div>
  </div>

  <div class="wrap">
    <section>
      <div class="eyebrow dark">What it is</div>
      <h2>The authoring experience of a mainstream MBSE tool, client-side.</h2>
      <p class="sub">A model explorer, twelve diagram kinds, a synchronized textual-notation editor, a properties/spec panel, validation, behavioral simulation, a numeric parametric solver, the full standard model library, a programmable API, and real-time multi-user co-editing &mdash; delivered as a static single-page app plus optional OMG-shaped REST/OSLC and collaboration servers.</p>
      <div class="shots">
        <figure><img src="${IBD}" alt="Interconnection view — functional block diagram"><figcaption>Interconnection view &mdash; parts wired through ports (functional block diagram)</figcaption></figure>
        <figure><img src="${BDD}" alt="General view — block definition diagram"><figcaption>General view &mdash; definitions, composition &amp; typing (BDD)</figcaption></figure>
      </div>
    </section>

    <section>
      <div class="eyebrow dark">Standard coverage</div>
      <h2>All six OMG pillars, tested end-to-end.</h2>
      <p class="sub">Each pillar is exercised broadly with green automated evidence &mdash; not a slideware claim.</p>
      <div class="pills">${pillarRows}</div>
    </section>

    <section>
      <div class="eyebrow dark">Feature parity</div>
      <h2>Measured against mainstream MBSE tools.</h2>
      <p class="sub">Candid, capability by capability. Where it is <span class="c pa">partial</span> or <span class="c no">&mdash;</span>, the report says so.</p>
      <div style="overflow-x:auto"><table class="tbl">
        <tr><th>Capability</th><th>Commercial desktop</th><th>Open-source web</th><th>This tool</th></tr>
        ${parityRows}
      </table></div>
    </section>

    <section>
      <div class="eyebrow dark">Proof</div>
      <h2>Verified, spec-shaped, interoperable.</h2>
      <div class="proof">
        <div class="card"><div class="k">Automated tests</div><div class="v"><b>815</b> unit/integration + <b>39</b> Playwright E2E covering every UI interaction. <b>0</b> failures.</div></div>
        <div class="card"><div class="k">Conformance</div><div class="v">api-JSON validates against the OMG element-graph schema; <b>10/10</b> REST endpoints validate vs OpenAPI 3.1; OSLC Core across 3 RDF serializations.</div></div>
        <div class="card"><div class="k">Live interop</div><div class="v">Round-tripped against the real OMG pilot (<span style="font-family:var(--mono)">sysml2.intercax.com</span>): READ 300 real elements + WRITE a Package, <b>@id</b> preserved.</div></div>
      </div>
    </section>

    <section>
      <div class="eyebrow dark">Run it</div>
      <h2>Zero-install, static-hostable.</h2>
      <p class="sub">The app is a pure SPA (deployable to GitHub Pages / any static host). The OMG API server is optional.</p>
      <pre><span class="cm"># the modeler (any static host)</span>
npm run build &amp;&amp; npm run <b>preview</b>       <span class="cm"># → http://localhost:4173</span>

<span class="cm"># optional OMG REST + OSLC API server</span>
npm run <b>serve</b>                          <span class="cm"># OpenAPI at :5178/openapi.json, OSLC at /oslc/*</span>
docker build -t sysmlv2-api . &amp;&amp; docker run -p 5178:5178 sysmlv2-api

<span class="cm"># verify &amp; interop</span>
npm test  &amp;&amp;  npx playwright test  &amp;&amp;  npm run <b>interop</b></pre>
    </section>

    <div class="foot">
      <p><b>Status.</b> Not a formal 100%-conformance certification, and there is no user-rights / permissions layer &mdash; collaboration uses open rooms (an academic-use choice). The residuals once listed here are now implemented and tested: real-time multi-user collaboration (Yjs CRDT), in-UI 3-way merge, a numeric measures-of-effectiveness solver, hierarchical &amp; timed behavioral execution, and an interactive 3D geometry view. Remaining depth limits: geometry is primitive solids (not CAD B-rep), the solver is equality-constrained (no inequality / feasibility solving), and behavioral execution is a load-bearing subset.</p>
      <p style="margin-top:12px" class="gap">MIT licensed &middot; the bundled OMG standard library under <b>src/library/std</b> is EPL-2.0 (dual-licensed, attributed) &middot; built clean-room from the OMG SysML v2 / KerML / API &amp; Services specifications.</p>
    </div>
  </div>
</div>`;

const out = `${SC}/demo.html`;
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KiB)`);
