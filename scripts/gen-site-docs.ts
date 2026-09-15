/**
 * Render the reference documents to static HTML for the published site.
 *
 * WHY THIS EXISTS. The app is a single-page bundle: a crawler that fetches the
 * site gets a title, a script tag and nothing else, so none of the writing in
 * `docs/` is discoverable by anyone who is not already in the repository. That
 * writing is the part of this project a reader can evaluate without installing
 * it — what the tool measured, what it refuses to say, and why. Publishing it as
 * ordinary HTML costs one build step and makes it readable, linkable and
 * indexable.
 *
 * The output is deliberately plain: no client-side JavaScript, no web fonts, no
 * network requests at all, so a page renders identically under a crawler, a
 * reader-mode view and a text browser. Every page carries its own description,
 * canonical URL and Open Graph block, because a shared link with none of those
 * renders as a bare URL.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { marked } from 'marked';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist', 'docs');
const SITE = 'https://cosmindxu.github.io/sysprose';

/** The documents worth publishing, in the order a newcomer should meet them. */
const ORDER = [
  'CONFORMANCE.md',
  'USER-GUIDE.md',
  'CLI-REFERENCE.md',
  'FEATURE-PARITY.md',
  '04-formal-verification-plan.md',
  '05-model-checking-literature.md',
  '06-model-checking-implementation-plan.md',
  '01-state-of-the-art.md',
  '02-omg-standard-reference.md',
  '03-architecture-and-plan.md',
  'DIAGNOSTIC-CODES.md',
  'AGENT-AUTHORING-CAMPAIGN.md',
  'TEST-REPORT.md',
  'TEST-SUMMARY.md',
  'UI-ROADMAP.md',
  'LICENSES.md',
];

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The page's own description: its first real sentence, not a generic blurb.
 *
 * Search results show this, so a document that opens with a table or a heading
 * gets the first paragraph that is actually prose rather than the first line of
 * the file.
 */
function describe(md: string): string {
  for (const block of md.split(/\n\s*\n/)) {
    const t = block
      .replace(/^#+\s.*$/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/^\|.*$/gm, '')
      .replace(/^```[\s\S]*?```$/gm, '')
      .replace(/[*`_[\]]/g, '')
      .replace(/\((?:https?|\.)[^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length > 80) return t.length > 300 ? `${t.slice(0, 297)}…` : t;
  }
  return 'Reference documentation for Sysprose.';
}

/** The document's own H1, or its filename if it has none. */
function titleOf(md: string, file: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  const raw = m ? m[1].replace(/[`*]/g, '').trim() : basename(file, '.md');
  // The page template already appends " · Sysprose"; a document whose own H1
  // opens with the product name would otherwise read "Sysprose — X · Sysprose".
  return raw.replace(/^Sysprose\s*[—–-]\s*/, '');
}

function page(opts: {
  title: string;
  description: string;
  canonical: string;
  body: string;
  crumb: string;
}): string {
  const t = escape(opts.title);
  const d = escape(opts.description);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t} · Sysprose</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${opts.canonical}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Sysprose">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${opts.canonical}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<style>
:root{--bg:#fbfbfc;--fg:#16181d;--mut:#5a6069;--rule:#e3e5ea;--acc:#2f4f7f;--code:#f2f3f6}
@media(prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e7e9ee;--mut:#9aa1ab;--rule:#2a2e36;--acc:#9ab8e8;--code:#1d2027}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 ui-serif,Georgia,"Times New Roman",serif}
.bar{border-bottom:1px solid var(--rule);padding:14px 20px;font:600 13px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.02em}
.bar a{color:var(--acc);text-decoration:none;margin-right:16px}
main{max-width:52rem;margin:0 auto;padding:32px 20px 80px}
h1,h2,h3,h4{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.25;text-wrap:balance}
h1{font-size:1.9rem;margin:.2em 0 .6em}
h2{font-size:1.35rem;margin:2em 0 .5em;padding-top:.6em;border-top:1px solid var(--rule)}
h3{font-size:1.1rem;margin:1.6em 0 .4em}
a{color:var(--acc)}
code{font:.86em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:.1em .35em;border-radius:3px}
pre{background:var(--code);border:1px solid var(--rule);padding:14px 16px;overflow-x:auto;font-size:.85rem}
pre code{background:none;padding:0}
blockquote{margin:1.2em 0;padding-left:1em;border-left:3px solid var(--rule);color:var(--mut)}
table{border-collapse:collapse;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;width:100%}
th,td{border-bottom:1px solid var(--rule);padding:8px 12px 8px 0;text-align:left;vertical-align:top}
.tw{overflow-x:auto;margin:1.2em 0}
hr{border:0;border-top:1px solid var(--rule);margin:2em 0}
footer{margin-top:64px;padding-top:16px;border-top:1px solid var(--rule);color:var(--mut);font:13px/1.6 ui-sans-serif,system-ui,sans-serif}
</style>
</head>
<body>
<nav class="bar"><a href="${SITE}/">Sysprose</a><a href="${SITE}/docs/">Documentation</a><a href="https://github.com/cosmindxu/sysprose">Source</a></nav>
<main>
${opts.body}
<footer>${opts.crumb} · <a href="https://github.com/cosmindxu/sysprose">github.com/cosmindxu/sysprose</a> · Sysprose implements a SysML v2–style notation and is a candidate, not a certified or conformance-tested implementation. SysML is a trademark of the Object Management Group.</footer>
</main>
</body>
</html>
`;
}

mkdirSync(OUT, { recursive: true });

const present = new Set(readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')));
const files = [...ORDER.filter((f) => present.has(f)), ...[...present].filter((f) => !ORDER.includes(f)).sort()];

const written: Array<{ slug: string; title: string; description: string }> = [];

for (const file of files) {
  const md = readFileSync(join(ROOT, 'docs', file), 'utf8');
  const slug = file.replace(/\.md$/, '');
  const title = titleOf(md, file);
  const description = describe(md);
  // Rewrite intra-doc links so they resolve on the published site.
  const linked = md.replace(/\]\((?:\.\/)?([A-Za-z0-9._-]+)\.md(#[^)]*)?\)/g, '](./$1.html$2)');
  let body = marked.parse(linked, { async: false }) as string;
  body = body.replace(/<table>/g, '<div class="tw"><table>').replace(/<\/table>/g, '</table></div>');
  writeFileSync(
    join(OUT, `${slug}.html`),
    page({ title, description, canonical: `${SITE}/docs/${slug}.html`, body, crumb: `docs/${file}` }),
  );
  written.push({ slug, title, description });
}

const list = written
  .map(
    (d) =>
      `<li><a href="./${d.slug}.html">${escape(d.title)}</a><br><span class="d">${escape(d.description.slice(0, 180))}${d.description.length > 180 ? '…' : ''}</span></li>`,
  )
  .join('\n');

writeFileSync(
  join(OUT, 'index.html'),
  page({
    title: 'Documentation',
    description:
      'Reference documentation for Sysprose: what has been measured against the SysML v2 specification and what has not, the command-line verification surface, the formal-verification plan, and an assessment of the model-checking literature read against this tool.',
    canonical: `${SITE}/docs/`,
    crumb: 'docs/',
    body: `<h1>Documentation</h1>
<p>Sysprose is an open-source, pure-browser modeler for a SysML v2–style notation, with a
command-line verification lane. These are its reference documents, published as written.</p>
<style>ul.docs{list-style:none;padding:0}ul.docs li{margin:0 0 18px;padding-left:0}ul.docs .d{color:var(--mut);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}</style>
<ul class="docs">${list}</ul>`,
  }),
);

const urls = ['', 'docs/', ...written.map((d) => `docs/${d.slug}.html`)];
writeFileSync(
  join(ROOT, 'dist', 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${SITE}/${u}</loc></url>`)
    .join('\n')}\n</urlset>\n`,
);
writeFileSync(
  join(ROOT, 'dist', 'robots.txt'),
  `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`,
);

console.log(`Wrote dist/docs — ${written.length} pages, sitemap with ${urls.length} URLs.`);
