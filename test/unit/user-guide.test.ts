/**
 * The user guide must describe the app that exists.
 *
 * `docs/USER-GUIDE.md` is hand-written — it explains what a view is FOR, which
 * no generator can do — so it cannot be regenerated the way
 * `docs/CLI-REFERENCE.md` and `docs/DIAGNOSTIC-CODES.md` are. What CAN be
 * checked is the part of it that is a claim about the source: the controls it
 * names, the views it covers, the subcommands it points at, and the keyboard
 * shortcuts it lists. Those are exactly the claims that went stale in
 * `docs/FEATURE-PARITY.md` §3 and `docs/TEST-REPORT.md` §6 while the whole gate
 * stayed green, so they are the ones with a test under them here.
 *
 * The guide names a control by its `data-testid`, in a table column called
 * "Test id" — the same id the E2E suite drives it by, which makes the appendix
 * useful to an agent as well as checkable. A renamed or deleted control fails
 * the first case below; a control added to the toolbar and left out of the
 * guide fails the second.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COMMANDS } from '../../scripts/lib/sysprose-spec';
import { checkText } from '../../src/text/check';

const root = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(root(p), 'utf8');

const GUIDE = read('docs/USER-GUIDE.md');

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(root(dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Ids the two view-command tables declare, which the view bar renders verbatim.
 *
 * The view buttons are the one place an id reaches the DOM without ever being
 * written as `data-testid="…"`: `Toolbar.tsx` merges {@link VIEW_COMMANDS} with
 * its own `EXTRA_VIEW_COMMANDS` and renders `data-testid={meta.id}`. So the
 * declaration IS the id, and the two arrays are read here — the indirection is
 * asserted below rather than assumed, because an id that is only a string in a
 * list nobody renders is exactly the fiction this file exists to catch.
 */
function viewBarTestIds(): Set<string> {
  const ids = new Set<string>();
  for (const [file, decl] of [
    ['src/ui/commands.ts', 'VIEW_COMMANDS'],
    ['src/ui/panels/Toolbar.tsx', 'EXTRA_VIEW_COMMANDS'],
  ] as const) {
    const body = new RegExp(`const ${decl}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`).exec(read(file));
    expect(body, `${file} no longer declares ${decl} as an array literal`).not.toBeNull();
    for (const m of body![1].matchAll(/\bid:\s*'([a-z0-9-]+)'/g)) ids.add(m[1]);
  }
  return ids;
}

/**
 * Every test id the app can render.
 *
 * Two spellings reach the DOM directly: the JSX attribute itself, and a `testid`
 * prop passed down to a wrapper that renders it (`ScrollBox`, the toolbar's
 * export menu). The view renderers under `src/diagram` carry their own ids
 * (`grid-view`, `sequence-view`), so they are scanned too, plus the view-bar
 * ids from {@link viewBarTestIds}.
 *
 * A general `id: '…'` scan was tried and REMOVED. `commands.ts` gives every
 * toolbar command an `id` that mirrors its `data-testid`, so the scan accepted
 * the mirror as proof of the original: renaming `data-testid="tb-validate"` to
 * anything at all left this suite green, because `id: 'tb-validate'` was still
 * in `commands.ts`. The guard the appendix advertises is that a renamed control
 * fails a unit test, so the id has to be sourced from something the DOM
 * actually gets.
 */
function renderedTestIds(): Set<string> {
  const ids = viewBarTestIds();
  for (const file of [...sources('src/ui'), ...sources('src/diagram')]) {
    const src = readFileSync(root(file), 'utf8');
    for (const m of src.matchAll(/data-testid="([a-z0-9-]+)"/g)) ids.add(m[1]);
    for (const m of src.matchAll(/\btestid="([a-z0-9-]+)"/g)) ids.add(m[1]);
    for (const m of src.matchAll(/\btestid:\s*'([a-z0-9-]+)'/g)) ids.add(m[1]);
  }
  return ids;
}

/**
 * The ids the guide names, read out of every table with a "Test id" column.
 *
 * Confining them to that column is what makes the extraction unambiguous: the
 * guide is full of backticked words (`stats`, `where-used`, `part def`) and a
 * scan for "things that look like an id" would either miss ids or invent them.
 */
function guideTestIds(): string[] {
  const ids: string[] = [];
  let inTable = false;
  for (const line of GUIDE.split('\n')) {
    if (!line.trimStart().startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = line.split('|').map((c) => c.trim());
    const last = cells[cells.length - 2] ?? '';
    if (/^Test ids?$/i.test(last)) {
      inTable = true;
      continue;
    }
    if (!inTable || /^-+$/.test(last.replace(/[: ]/g, '-'))) continue;
    for (const m of last.matchAll(/`([a-z0-9-]+)`/g)) ids.push(m[1]);
  }
  return ids;
}

/**
 * Ids from the appendix's non-toolbar tables that must stay documented.
 *
 * The toolbar half checks itself: every `tb-*` id in the source has to appear in
 * the guide, so a new toolbar button cannot be left out. The panel and
 * bottom-panel halves have no such namespace, and without this list the whole
 * "### Panels" table could be deleted and every case here would still pass —
 * which would make the appendix's own promise that it "cannot quietly go stale"
 * false for three quarters of the ids it names. One id per row of those tables,
 * chosen as the row's subject.
 */
const MUST_DOCUMENT = [
  // Panels.
  'explorer-tree',
  'explorer-search',
  'explorer-library-toggle',
  'tree-focus',
  'tree-add',
  'prop-name',
  'prop-used-by',
  'prop-impact',
  'breadcrumb',
  'palette',
  'diagram-canvas',
  'diagram-fit',
  'node-ctx-scope',
  'node-ctx-scope-clear',
  'diagram-legend',
  // Bottom panel.
  'tab-problems',
  'tab-text',
  'text-apply',
  'tab-api',
  'tab-simulation',
  'tab-versions',
];

describe('the controls the user guide names', () => {
  it('all exist in the app', () => {
    const rendered = renderedTestIds();
    const named = guideTestIds();
    expect(named.length, 'the guide names no test ids at all — the appendix is gone').toBeGreaterThan(
      30,
    );
    const gone = [...new Set(named)].filter((id) => !rendered.has(id));
    expect(gone, `the guide names controls the app no longer renders:\n${gone.join('\n')}`).toEqual(
      [],
    );
  });

  it('cover every toolbar and view-bar command', () => {
    // `tb-*` is the toolbar's own namespace, so "every tb- id in the source" is
    // "every command on the two toolbar rows" without a second list to keep.
    const toolbar = [...renderedTestIds()].filter((id) => id.startsWith('tb-')).sort();
    const named = new Set(guideTestIds());
    const missing = toolbar.filter((id) => !named.has(id));
    expect(
      missing,
      `toolbar controls the guide does not document:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('still cover the panels and the bottom panel', () => {
    const named = new Set(guideTestIds());
    const dropped = MUST_DOCUMENT.filter((id) => !named.has(id));
    expect(
      dropped,
      `the appendix stopped documenting controls it is meant to keep:\n${dropped.join('\n')}`,
    ).toEqual([]);
    // And they must be real, which the first case covers for the union — this
    // asserts the list itself has not gone stale against the app.
    const rendered = renderedTestIds();
    const gone = MUST_DOCUMENT.filter((id) => !rendered.has(id));
    expect(gone, `MUST_DOCUMENT names ids the app no longer renders:\n${gone.join('\n')}`).toEqual(
      [],
    );
  });

  it('the view bar really renders the ids its tables declare', () => {
    // viewBarTestIds() trusts two array literals; this is the line that makes
    // trusting them sound. If the toolbar stops rendering `meta.id` as the
    // test id, those ids are fiction and must be scanned some other way.
    const toolbar = read('src/ui/panels/Toolbar.tsx');
    expect(toolbar, 'the view bar no longer renders `data-testid={meta.id}`').toContain(
      'data-testid={meta.id}',
    );
    expect(toolbar, 'the view-button map no longer merges the two tables').toContain(
      '[...VIEW_COMMANDS, ...EXTRA_VIEW_COMMANDS]',
    );
  });

  it('cover every view the app can render', () => {
    const decl = /export type ViewKind =([\s\S]*?);/.exec(read('src/diagram/types.ts'));
    const views = [...decl![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    const named = new Set(guideTestIds());
    const missing = views.filter((v) => !named.has(`tb-view-${v}`));
    expect(missing, `views the guide does not describe:\n${missing.join('\n')}`).toEqual([]);
  });
});

describe('the keyboard shortcuts the user guide lists', () => {
  /**
   * Every shortcut LABEL a command declares must be a shortcut the handler
   * actually wires.
   *
   * The New command advertised `Ctrl+N` and `handleShortcut` never handled `n`,
   * so the app's own command table promised a key that did nothing and the
   * guide would have copied the promise. A label is a claim about behaviour and
   * this is the claim's test.
   */
  it('are wired, not just labelled', () => {
    const src = read('src/ui/commands.ts');
    const handler = src.slice(src.indexOf('export function handleShortcut'));
    const unwired: string[] = [];
    for (const m of src.matchAll(/shortcut:\s*'([^']+)'/g)) {
      const key = m[1].split('+').pop()!.toLowerCase();
      if (!handler.includes(`case '${key}':`)) unwired.push(m[1]);
    }
    expect(
      unwired,
      `commands.ts declares a shortcut the handler never receives:\n${unwired.join('\n')}`,
    ).toEqual([]);
  });
});

describe("the notation primer's snippets", () => {
  /**
   * The action snippet must check clean when typed as printed.
   *
   * §3 shows `first … then …` and a bare `then X;`. Abridged from the shipped
   * example, it kept the `then surveilTarget;` line and lost the `action
   * surveilTarget;` that declares it, so a reader who pasted the box got
   * `connector-endpoints` (an error) and `ref/unresolved-reference` — and was
   * taught, wrongly, that `then X;` introduces a step. A primer whose examples
   * do not check is worse than no primer, so this one is checked.
   *
   * `library: 'none'` because the snippet uses no library type; it keeps the
   * case fast and its failure about the snippet.
   */
  it('the action snippet parses and validates clean', async () => {
    const snippet = /```sysml\n(action def FlyMission \{[\s\S]*?)```/.exec(GUIDE);
    expect(snippet, 'the guide no longer shows an `action def FlyMission` snippet').not.toBeNull();
    const report = await checkText(`package Snippet {\n${snippet![1]}}\n`, { library: 'none' });
    expect(
      report.summary,
      `the guide's action snippet does not check clean:\n${report.diagnostics
        .map((d) => `${d.severity} ${d.code} ${d.message}`)
        .join('\n')}`,
    ).toMatchObject({ errors: 0, warnings: 0 });
  });
});

describe('the user guide and the command reference describe one tool', () => {
  it('the guide points at every subcommand the command has', () => {
    const missing = COMMANDS.map((c) => c.name).filter(
      (n) => !GUIDE.includes(`sysprose -- ${n} `),
    );
    expect(missing, `subcommands the guide never shows:\n${missing.join('\n')}`).toEqual([]);
  });

  it('links to the reference documents it defers to', () => {
    for (const doc of ['CLI-REFERENCE.md', 'DIAGNOSTIC-CODES.md']) {
      expect(GUIDE, `the guide links to ${doc}`).toContain(`(${doc})`);
      expect(() => read(`docs/${doc}`), `${doc} exists`).not.toThrow();
    }
  });
});
