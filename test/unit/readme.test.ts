/**
 * The front page must map the tool onto the tool that exists.
 *
 * The README is the one document everybody reads and nobody owns. It carries a
 * capability table — one row per thing the tool can be asked, and the three
 * places that answer it: the control in the app, the terminal command, the
 * function you can import — and a table like that is several claims per row
 * about several different parts of the source. Left unguarded it is the
 * fastest-rotting documentation in the repository: a renamed control, a
 * re-backed subcommand or a moved function all leave it silently wrong with the
 * whole gate green.
 *
 * WHAT THE TABLE IS ALLOWED TO CLAIM. An earlier draft of this page said the
 * app, the terminal and the SDK were three doors onto ONE function. They are
 * not, and the difference is measurable: the Allocation view runs
 * `buildAllocationMatrix` (rows = the elements that take part in a link) while
 * `trace` runs `traceabilityMatrix` (rows = every element of the row kind), so
 * on `examples/uav-isr.sysml` the view shows one row where the command shows
 * seven; Properties → Used by runs `whereUsed`, which keeps re-derived copies,
 * while `where-used` runs `impactClosure`, which drops them; and no control in
 * the app calls `connectivityReport` at all. So the table names, per row, the
 * function the CONTROL runs as well as the one the COMMAND runs, and marks with
 * a dagger every row where those differ. The identity that survives — the
 * subcommand is a thin shell over the import beside it — is the one this file
 * checks hardest, because it is the one still being promised.
 *
 * Each column is therefore checked against its own source of truth: the control
 * ids and the functions behind them against {@link APP_DOORS}, pinned row by
 * row and verified against the app's own sources (an id the app renders, a
 * function really called in the file named); the terminal column against the
 * command table `sysprose` parses (both directions — no missing subcommand, no
 * invented one); and the in-process column against the exports of the file it
 * cites AND against what the command table says computes that answer, function
 * for function and path for path.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMANDS, type CommandSpec } from '../../scripts/lib/sysprose-spec';
import { renderedTestIds } from '../support/ui-testids';

const root = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(root(p), 'utf8');

const README = read('README.md');

/** The marker the table puts on a row whose app control runs something else. */
const DAGGER = '†';

/**
 * What the app actually runs for each row, pinned by hand.
 *
 * WHY BY HAND. There is no declaration to read: a view button sets
 * `activeView` and the work happens two modules away in `store.rebuildDiagram`,
 * so nothing in the source states "this control answers that question". The
 * mapping is a claim, and a claim needs a place to live where changing it is
 * deliberate. Everything ABOUT the claim is then checked — the id is one the
 * app renders, the function is really called in the file named, and whether the
 * row deserves its dagger is derived from the README's own in-process column
 * rather than asserted here — so this list cannot quietly disagree with either
 * the source or the page.
 *
 * A set-membership check was tried and is NOT enough: `renderedTestIds()` is one
 * flat set of every id in `src/ui` + `src/diagram`, so "the id exists somewhere"
 * passes just as happily when two rows' controls are swapped, when a row points
 * at a `<code>` span that is not a control, or when a whole cell is emptied.
 * Rows are pinned in order, cell by cell, for exactly that reason.
 */
const APP_DOORS: ReadonlyArray<{
  /** The subcommand the row's terminal cell shows; `check` for the checker row. */
  command: string;
  /** Controls the "In the app" cell must name, in order. */
  controls: ReadonlyArray<{ id: string; fn: string; file: string }>;
}> = [
  {
    command: 'check',
    controls: [{ id: 'tb-validate', fn: 'safeValidate', file: 'src/ui/store.ts' }],
  },
  {
    command: 'stats',
    controls: [{ id: 'api-metrics', fn: 'modelMetrics', file: 'src/ui/panels/BottomPanel.tsx' }],
  },
  {
    command: 'elements',
    controls: [{ id: 'tb-view-grid', fn: 'buildGrid', file: 'src/ui/store.ts' }],
  },
  {
    command: 'requirements',
    controls: [
      {
        id: 'tb-view-requirements',
        fn: 'buildRequirementsTable',
        file: 'src/ui/panels/RequirementsTable.tsx',
      },
    ],
  },
  {
    command: 'trace',
    controls: [
      { id: 'tb-view-allocation', fn: 'buildAllocationMatrix', file: 'src/ui/store.ts' },
    ],
  },
  {
    command: 'connectivity',
    controls: [
      {
        id: 'tb-view-interconnection',
        fn: 'buildInterconnection',
        file: 'src/diagram/build.ts',
      },
    ],
  },
  {
    command: 'where-used',
    controls: [
      { id: 'prop-used-by', fn: 'whereUsed', file: 'src/ui/panels/Properties.tsx' },
      { id: 'prop-impact', fn: 'neighboursOf', file: 'src/ui/panels/ImpactGraph.tsx' },
    ],
  },
  // `orphans` has no control at all — the row says so, and the case below holds
  // it to saying so rather than letting an empty cell pass silently.
  { command: 'orphans', controls: [] },
];

interface Row {
  capability: string;
  inApp: string;
  terminal: string;
  inProcess: string;
}

/**
 * The capability table, found by its header rather than by position.
 *
 * A positional read ("the third table") would break the moment somebody adds a
 * table above it and would then be checking the wrong rows — quietly, since a
 * mismatched header yields no rows and an empty `every` passes. The header is
 * asserted to exist, and the row count with it.
 */
function capabilityRows(): Row[] {
  const lines = README.split('\n');
  const cells = (line: string) =>
    line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
  const header = lines.findIndex(
    (l) =>
      l.startsWith('|') &&
      cells(l).join('|') === 'Capability|In the app|From a terminal|In process',
  );
  expect(
    header,
    'README.md no longer has a `| Capability | In the app | From a terminal | In process |` table',
  ).toBeGreaterThan(-1);
  const rows: Row[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const c = cells(line);
    expect(c, `capability row has ${c.length} cells, not 4:\n${line}`).toHaveLength(4);
    rows.push({ capability: c[0], inApp: c[1], terminal: c[2], inProcess: c[3] });
  }
  return rows;
}

/** The dagger paragraph under the table, which must explain every marked row. */
function footnote(): string {
  const m = /\*\*† Where the app runs something else[\s\S]*?\n\n/.exec(README);
  expect(m, 'README.md no longer explains what the † rows do differently').not.toBeNull();
  return m![0];
}

/** Backticked words in a cell. */
const ticked = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** The `` `control-id` → `functionName` `` pairs a cell names, in order. */
const doorsOf = (cell: string) =>
  [...cell.matchAll(/`([a-z0-9-]+)`\s*→\s*`([A-Za-z_$][\w$]*)`/g)].map((m) => ({
    id: m[1],
    fn: m[2],
  }));

/**
 * The function names a `backedBy` string credits, without its file paths.
 *
 * `cmd.backedBy.includes(fn)` was tried and is a raw substring test against a
 * string that embeds the path, so `grid` would "agree" with
 * `buildGrid (src/diagram/grid.ts)`. Parsed instead: `a + b (path)` groups,
 * paths peeled off.
 */
function backing(cmd: CommandSpec): { fns: string[]; paths: Map<string, string> } {
  const fns: string[] = [];
  const paths = new Map<string, string>();
  // `a + b (path)` and `a (path) + b (other/path)` are both spellings in use, so
  // the groups are matched rather than split on `+`.
  for (const m of cmd.backedBy.matchAll(/([A-Za-z][\w\s+]*?)\s*\(([^)]+)\)/g)) {
    for (const fn of m[1].split(/\s*\+\s*/)) {
      fns.push(fn.trim());
      paths.set(fn.trim(), m[2].trim());
    }
  }
  expect(fns.length, `\`${cmd.name}\`'s backedBy names no "fn (path)": ${cmd.backedBy}`).toBeGreaterThan(0);
  return { fns, paths };
}

/** The `fns — `path`` groups an "In process" cell names. */
function inProcessGroups(row: Row): Array<{ fns: string[]; path: string }> {
  return row.inProcess.split(';').map((group) => {
    const [fns, file] = group.split('—').map((s) => s.trim());
    expect(file, `"${row.capability}" does not cite a file for ${fns}`).toBeTruthy();
    const path = ticked(file)[0];
    expect(path, `"${row.capability}" cites ${file} outside backticks`).toBeTruthy();
    return { fns: ticked(fns), path };
  });
}

describe('the README capability table', () => {
  const rows = capabilityRows();

  it('has one row per subcommand plus the checker, in the pinned order', () => {
    expect(rows.length, 'the capability table lost or gained rows').toBe(APP_DOORS.length);
    expect(APP_DOORS.length, 'APP_DOORS is missing a subcommand').toBe(COMMANDS.length + 1);
    const shown = rows.map((r) => {
      const m = /(?:sysprose -- ([a-z][a-z-]*)|npm run (check) --)/.exec(r.terminal);
      expect(m, `capability row "${r.capability}" shows no command:\n${r.terminal}`).not.toBeNull();
      return m![1] ?? m![2];
    });
    expect(shown, 'the capability table and APP_DOORS are in different orders').toEqual(
      APP_DOORS.map((d) => d.command),
    );
  });

  it('names, per row, the control the app really renders for it', () => {
    const rendered = renderedTestIds();
    for (const [i, door] of APP_DOORS.entries()) {
      const named = doorsOf(rows[i].inApp);
      expect(
        named.map((d) => d.id),
        `the "In the app" cell for \`${door.command}\` names the wrong controls`,
      ).toEqual(door.controls.map((c) => c.id));
      for (const c of door.controls) {
        expect(rendered.has(c.id), `the README names \`${c.id}\`, which the app never renders`).toBe(
          true,
        );
      }
      if (door.controls.length === 0) {
        // An emptied cell must SAY it is empty; a bare `—` is how a deleted
        // claim used to pass unnoticed.
        expect(
          rows[i].inApp,
          `\`${door.command}\` has no control, so its cell must say so`,
        ).toMatch(/no view yet/);
      }
    }
  });

  it('credits each control with a function that file really calls', () => {
    for (const [i, door] of APP_DOORS.entries()) {
      const named = doorsOf(rows[i].inApp);
      expect(
        named.map((d) => d.fn),
        `the "In the app" cell for \`${door.command}\` credits the wrong functions`,
      ).toEqual(door.controls.map((c) => c.fn));
      for (const c of door.controls) {
        expect(existsSync(root(c.file)), `${c.file} does not exist`).toBe(true);
        expect(
          /^src\/(ui|diagram)\//.test(c.file),
          `${c.file} is not an app-side module, so it cannot be what a control runs`,
        ).toBe(true);
        const src = read(c.file);
        expect(
          new RegExp(`\\b${c.fn}\\(`).test(src),
          `${c.file} never calls \`${c.fn}\`, which the README says \`${c.id}\` runs`,
        ).toBe(true);
        expect(
          new RegExp(`(function|const) ${c.fn}\\b`).test(src) ||
            new RegExp(`import[^;]*\\b${c.fn}\\b[^;]*from`).test(src),
          `${c.file} neither defines nor imports \`${c.fn}\` — the file pin has gone stale`,
        ).toBe(true);
      }
    }
  });

  it('daggers exactly the rows where the app runs something else', () => {
    const note = footnote();
    for (const [i, door] of APP_DOORS.entries()) {
      const row = rows[i];
      const shared = inProcessGroups(row).flatMap((g) => g.fns);
      // A row is honest without a dagger only when the control runs one of the
      // functions the command and the import share.
      const same =
        door.controls.length > 0 && door.controls.every((c) => shared.includes(c.fn));
      const marked = row.inApp.includes(DAGGER);
      expect(
        marked,
        same
          ? `\`${door.command}\` runs the same function in the app; it must not be daggered`
          : `\`${door.command}\` runs ${door.controls.map((c) => c.fn).join(', ') || 'nothing'} in the app but ${shared.join(', ')} in a terminal — it must carry a ${DAGGER}`,
      ).toBe(door.controls.length > 0 && !same);
      if (marked) {
        for (const c of door.controls) {
          expect(
            note,
            `the † paragraph never explains \`${c.fn}\`, which \`${door.command}\` is daggered for`,
          ).toContain(c.fn);
        }
      }
    }
  });

  it('shows every subcommand the command has, and no others', () => {
    const shown = new Set(
      rows.flatMap((r) => [...r.terminal.matchAll(/sysprose -- ([a-z][a-z-]*)/g)].map((m) => m[1])),
    );
    expect([...shown].sort(), 'the terminal column and the command table disagree').toEqual(
      COMMANDS.map((c) => c.name).sort(),
    );
  });

  it('shows the checker too, which is the other exit-code contract', () => {
    expect(
      rows.some((r) => r.terminal.includes('npm run check --')),
      'the capability table no longer shows `npm run check`',
    ).toBe(true);
  });

  it('names functions the files it cites really export', () => {
    for (const row of rows) {
      for (const { fns, path } of inProcessGroups(row)) {
        expect(existsSync(root(path)), `${path} does not exist`).toBe(true);
        const src = read(path);
        expect(fns.length, `"${row.capability}" names no in-process function`).toBeGreaterThan(0);
        for (const fn of fns) {
          expect(
            new RegExp(`export (async )?function ${fn}\\b`).test(src),
            `${path} does not export \`${fn}\`, which the README says answers "${row.capability}"`,
          ).toBe(true);
        }
      }
    }
  });

  it('credits every function the command table says computes each answer', () => {
    // The drift this pass exists to prevent: a subcommand re-pointed at another
    // engine while the front page keeps crediting the old one, so the "thin
    // shell over one import" claim quietly stops being true. Every function
    // named must agree — one right name beside a real-but-wrong one used to
    // pass — and the file it is credited to must agree too.
    for (const cmd of COMMANDS) {
      const row = rows.find((r) => r.terminal.includes(`sysprose -- ${cmd.name} `));
      expect(row, `no capability row shows \`sysprose -- ${cmd.name}\``).toBeTruthy();
      const { fns, paths } = backing(cmd);
      const groups = inProcessGroups(row!);
      const named = groups.flatMap((g) => g.fns);
      expect(
        named.filter((fn) => !fns.includes(fn)),
        `README credits ${named.join(', ')} for \`${cmd.name}\`; the command table says it is computed by ${cmd.backedBy}`,
      ).toEqual([]);
      expect(
        fns.filter((fn) => !named.includes(fn)),
        `the command table says \`${cmd.name}\` is computed by ${cmd.backedBy}; the README does not credit all of it`,
      ).toEqual([]);
      for (const g of groups) {
        for (const fn of g.fns) {
          expect(
            g.path,
            `README puts \`${fn}\` in ${g.path}; the command table puts it in ${paths.get(fn)}`,
          ).toBe(paths.get(fn));
        }
      }
    }
  });
});

describe('the user guide marks the same rows', () => {
  /**
   * The guide carries the same table in shorter form, and carried the same
   * over-strong claim before this pass. Two pages disagreeing about which
   * figures are promised to match is worse than either being wrong alone, so
   * the dagger sets are compared — matched by the subcommand each row shows,
   * which is the one cell both tables spell identically.
   */
  it('daggers the same subcommands the README does', () => {
    const guide = read('docs/USER-GUIDE.md');
    const daggered = (doc: string) => {
      const out = new Set<string>();
      for (const line of doc.split('\n')) {
        if (!line.startsWith('|') || !line.includes(DAGGER)) continue;
        const m = /(?:sysprose -- ([a-z][a-z-]*)|npm run (check) --)/.exec(line);
        if (m) out.add(m[1] ?? m[2]);
      }
      return [...out].sort();
    };
    const inReadme = daggered(README);
    expect(inReadme.length, 'the README daggers no row at all').toBeGreaterThan(0);
    expect(
      daggered(guide),
      'the guide and the README disagree about which answers the app computes differently',
    ).toEqual(inReadme);
  });
});

describe('the README documentation index', () => {
  it('links the user guide and the command reference', () => {
    for (const doc of ['USER-GUIDE.md', 'CLI-REFERENCE.md']) {
      expect(README, `README.md links docs/${doc}`).toContain(`docs/${doc}`);
    }
  });

  it('links every document in docs/', () => {
    // An index that omits a document is a document nobody finds. `docs/` has
    // one level of top-level pages plus subject folders with their own entry
    // points; the top level is what the front page indexes.
    const docs = readdirSync(root('docs'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name);
    expect(docs.length, 'docs/ has no top-level pages — the scan is wrong').toBeGreaterThan(5);
    const missing = docs.filter((d) => !README.includes(`(docs/${d})`));
    expect(missing, `documents the README never links:\n${missing.join('\n')}`).toEqual([]);
  });

  it('has no dead links', () => {
    const dead = [...README.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1])
      .filter((href) => !/^(https?:|mailto:|#)/.test(href))
      .map((href) => href.replace(/#.*$/, ''))
      .filter((href) => href && !existsSync(root(href)));
    expect(dead, `README.md links files that do not exist:\n${dead.join('\n')}`).toEqual([]);
  });
});
