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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMANDS } from '../../scripts/lib/sysprose-spec';
import { checkText } from '../../src/text/check';
import { loadModelText } from '@text/load';
import { isUserElement, promptsFor, requirementSatisfaction } from '@api/index';
import { buildRequirementsTable } from '@diagram/index';
import {
  STATEMENT_KINDS,
  STATEMENT_KIND_KEYWORD,
  STATEMENT_KIND_LIBRARY,
  statementKindOf,
} from '@semantics/index';
// The scan lives in `test/support` because the README's capability table names
// controls the same way this appendix does, and one weak scan behind two
// documents is one bug behind two green guards.
import { renderedTestIds } from '../support/ui-testids';

const root = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(root(p), 'utf8');

const GUIDE = read('docs/USER-GUIDE.md');

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
  'prop-statement-kind',
  'prop-req-attrs',
  'req-attr-cell',
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

/**
 * §7 — the section that documents a vocabulary this project invented.
 *
 * Everything else in this guide describes notation somebody else specified, so
 * a reader who is misled by it can go and read the specification. Statement
 * kinds are Sysprose's own, and `docs/USER-GUIDE.md` is the only place a person
 * is told how to write one — which makes the section the definition, and a
 * stale definition worse here than anywhere else in the document.
 *
 * So the section is checked against the three things it can be wrong about: the
 * VOCABULARY (a fourth kind, or a renamed one, leaves the guide teaching three),
 * the SHIPPED TEXT it quotes (the package a reader is told to paste), and the
 * TRANSCRIPTS (two commands run over two snippets printed a few lines above
 * them, which is the guide's own promise that they were run at all).
 *
 * The transcripts are compared against the ANALYSIS FUNCTIONS rather than
 * against a re-run of the command: `scripts/sysprose.ts` calls `runMain` at
 * module scope, so importing it would run it. That splits the claim in two —
 * the figures and the rows are checked here, the rendering of them by
 * `test/campaign/cli.sysprose.test.ts` — and it is the half that goes stale,
 * since a report changes what it says about a model far more often than it
 * changes how it lays a line out.
 */
describe('§7 — the three kinds of statement', () => {
  /** The first fenced block of `lang` whose body starts with `prefix`. */
  function fenced(lang: string, prefix: string): string {
    const block = [...GUIDE.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))]
      .map((m) => m[1])
      .find((body) => body.startsWith(prefix));
    expect(block, `the guide has no \`\`\`${lang} block starting "${prefix}"`).toBeDefined();
    return block!;
  }

  // The block that teaches where the keyword goes is the FIRST thing a reader
  // types, and it was the one block here with nothing under it: `#prose prt
  // note {` would have shipped with the whole gate green. §3's action snippet
  // earned a case for exactly that reason, so this one gets the same.
  const KEYWORD_SNIPPET = () => fenced('sysml', '#prose part note {');
  const KINDS_SNIPPET = () => fenced('sysml', 'package Brakes {');
  const PROMPT_SNIPPET = () => fenced('sysml', 'package Propulsion {');
  const KINDS_TRANSCRIPT = () => fenced('console', '$ npm run sysprose -- requirements brakes.sysml');
  const PROMPT_TRANSCRIPT = () => fenced('console', '$ npm run sysprose -- prompts propulsion.sysml');

  /** One `N of M` style figure out of a transcript, by the words around it. */
  function figure(transcript: string, pattern: RegExp): number {
    const m = pattern.exec(transcript);
    expect(m, `the transcript shows no figure matching ${pattern}`).not.toBeNull();
    return Number(m![1]);
  }

  /**
   * A sentence the CLI prints, read out of the CLI's own source text.
   *
   * The figures in a transcript can be compared with the analysis functions;
   * the WORDING cannot. `reportRequirements` could rename its non-normative
   * note to anything at all and every figure in the guide would still agree,
   * leaving the guide quoting a line the tool no longer produces — which is the
   * half of a transcript a reader trusts most, because it is the half that
   * explains the rest. `scripts/sysprose.ts` cannot be IMPORTED to get at the
   * literal (it calls `runMain` at module scope, so importing it runs the CLI),
   * so it is read as text. A weaker link than an import, and a far stronger one
   * than nothing: a reword fails here instead of shipping.
   */
  const CLI_SOURCE = read('scripts/sysprose.ts');
  function cliLiteral(pattern: RegExp, what: string): string {
    const m = pattern.exec(CLI_SOURCE);
    expect(m, `scripts/sysprose.ts no longer contains ${what} matching ${pattern}`).not.toBeNull();
    return m![1];
  }
  const NON_NORMATIVE_NOTE: Record<'prose' | 'prompt', string> = {
    prose: cliLiteral(/^ {2}prose: '(.+)',$/m, 'the note printed on a prose row'),
    prompt: cliLiteral(/^ {2}prompt: '(.+)',$/m, 'the note printed on a prompt row'),
  };
  const PROMPTS_LEGEND = cliLiteral(
    /\['( {2}nearest first;[^']*)'\]/,
    'the legend printed under an applies-to listing',
  );

  it('names every kind the semantics module declares, spelled as the writer emits it', () => {
    for (const kind of STATEMENT_KINDS) {
      expect(GUIDE, `the guide names the \`${kind}\` kind`).toContain(`\`${kind}\``);
      // The keyword, not just the word: `requirement` is a hard keyword, so the
      // tag a reader has to type is `#'requirement'`, and a guide that printed
      // `#requirement` would teach a line that does not parse.
      expect(GUIDE, `the guide shows how to write the ${kind} keyword`).toContain(
        `#${STATEMENT_KIND_KEYWORD[kind]}`,
      );
    }
    // And nowhere shows the spelling that does NOT parse as though it did.
    // `toContain` alone is satisfied by the one place the guide quotes the
    // shipped package, so a sentence elsewhere teaching a reader to type
    // `#requirement` would pass every case above while teaching a line the
    // parser rejects. Naming the wrong spelling in order to warn a reader off
    // it is the one legitimate use, so a match followed by that warning is
    // allowed — the same shape as the negation window in `claims.test.ts`.
    const bare = [...GUIDE.matchAll(/#([A-Za-z]\w*)/g)]
      .filter((m) => STATEMENT_KINDS.some((k) => k === m[1] && STATEMENT_KIND_KEYWORD[k] !== m[1]))
      .filter((m) => !/^`? does not parse/.test(GUIDE.slice(m.index! + m[0].length, m.index! + m[0].length + 24)));
    expect(
      bare.map((m) => m[0]),
      'the guide writes a keyword unquoted that the notation only accepts quoted',
    ).toEqual([]);
  });

  it('counts the kinds in its own title the way the module counts them', () => {
    // The section is called "Three kinds of statement" and opens by saying
    // three. Those words are a count of `STATEMENT_KINDS`, written out, and a
    // fourth kind would leave the title of the defining section wrong — the one
    // sentence a reader is most likely to take on trust. Spelling the number
    // from the module is how the title fails with the vocabulary rather than
    // after it.
    const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'];
    const word = WORDS[STATEMENT_KINDS.length];
    expect(word, `there are now ${STATEMENT_KINDS.length} kinds — teach this case the word`).toBeDefined();
    expect(GUIDE, 'the §7 heading no longer counts the kinds the module declares').toContain(
      `## 7. ${word} kinds of statement`,
    );
    expect(GUIDE, 'the contents list and the §7 heading disagree').toContain(
      `[${word} kinds of statement](#7-${word.toLowerCase()}-kinds-of-statement)`,
    );
    // The table under it is the enumeration itself: one row per kind, in the
    // module's order, so a kind cannot be named in the prose and left out of
    // the one place a reader looks for what each is for.
    const table = [...GUIDE.matchAll(/^\| `(\w+)` \| [^|]+\| [^|]+\|$/gm)].map((m) => m[1]);
    expect(table, "the §7 table's rows are not the kinds, in the module's order").toEqual([
      ...STATEMENT_KINDS,
    ]);
  });

  it('quotes the shipped definitions exactly as the module ships them', () => {
    // Byte-for-byte, because the block is there to be pasted into a model: the
    // module's own round-trip test pins that this text saves and reparses
    // unchanged, and a hand-retyped copy in the guide inherits none of that.
    expect(
      GUIDE,
      'the guide no longer quotes STATEMENT_KIND_LIBRARY verbatim — paste the export, do not retype it',
    ).toContain(STATEMENT_KIND_LIBRARY);
  });

  it('the keyword snippet checks clean as printed', async () => {
    const report = await checkText(KEYWORD_SNIPPET(), { library: 'none' });
    expect(
      report.summary,
      `the guide's "where the keyword goes" snippet does not check clean:\n${report.diagnostics
        .map((d) => `${d.severity} ${d.code} ${d.message}`)
        .join('\n')}`,
    ).toMatchObject({ errors: 0, warnings: 0 });
  });

  it('the three-kinds snippet checks clean as printed', async () => {
    const report = await checkText(KINDS_SNIPPET(), { library: 'none' });
    expect(
      report.summary,
      `the guide's statement-kind snippet does not check clean:\n${report.diagnostics
        .map((d) => `${d.severity} ${d.code} ${d.message}`)
        .join('\n')}`,
    ).toMatchObject({ errors: 0, warnings: 0 });
  });

  it('the prompt snippet checks clean as printed', async () => {
    const report = await checkText(PROMPT_SNIPPET(), { library: 'none' });
    expect(
      report.summary,
      `the guide's prompt snippet does not check clean:\n${report.diagnostics
        .map((d) => `${d.severity} ${d.code} ${d.message}`)
        .join('\n')}`,
    ).toMatchObject({ errors: 0, warnings: 0 });
  });

  it('the coverage transcript is the report the snippet above it produces', async () => {
    const loaded = await loadModelText(KINDS_SNIPPET(), { fileName: 'brakes.sysml' });
    const model = loaded.model!;
    const sat = requirementSatisfaction(model);
    const t = KINDS_TRANSCRIPT();
    expect(figure(t, /(\d+) of \d+ requirement\(s\) satisfied/), 'requirements satisfied').toBe(
      sat.satisfied,
    );
    expect(figure(t, /\d+ of (\d+) requirement\(s\) satisfied/), 'requirements counted').toBe(
      sat.total,
    );
    expect(figure(t, /(\d+) bundled library requirement\(s\)/), 'library requirements').toBe(
      sat.libraryExcluded,
    );
    expect(
      figure(t, /(\d+) statement\(s\) tagged prose or prompt/),
      'statements the ratio leaves out',
    ).toBe(sat.nonNormativeExcluded);
    // The other half of the same exclusion line. `docs-counts.test.ts` has a
    // claim for `re-derived copy/copies`, but it `exec`s the WHOLE guide and so
    // binds to the first such line in the document — the §6 walkthrough's — and
    // never reaches this one. Two transcripts quoting the same sentence about
    // two different models is exactly the case a first-match scan cannot cover.
    expect(figure(t, /(\d+) re-derived copy\/copies/), 're-derived requirement copies').toBe(
      sat.implicitExcluded,
    );
    // The PERCENTAGE, computed the way the command computes it — including the
    // `total === 0` guard, so a future snippet with no requirements in it fails
    // on the figure rather than on a division by zero.
    expect(figure(t, /\((\d+)%\)/), 'the coverage percentage').toBe(
      sat.total === 0 ? 0 : Math.round(sat.coverage * 100),
    );
    // The point of the transcript is the MARK on each row: `[-]` is what a
    // reader is promised for a statement that binds nothing, and a figure that
    // matched while every row read `[ ]` would have taught the opposite.
    const marks = [...t.matchAll(/^ {2}\[(x| |-)\] \d+ {2}(\S+)/gm)].map((m) => [m[2], m[1]]);
    // Not vacuous: two empty lists are equal, and a transcript whose rows all
    // stopped matching would otherwise pass this case rather than fail it.
    expect(marks.length, 'the transcript shows no requirement rows at all').toBeGreaterThan(1);
    // The same two populations the command joins: the table builds the rows, the
    // coverage report says which of them anything satisfies. A re-derived copy is
    // not a row a reader can edit, so the command drops it and so does this.
    const satisfied = new Map(sat.requirements.map((r) => [r.requirement.id, r.satisfied]));
    const expected = buildRequirementsTable(model)
      .rows.filter((r) => {
        const el = model.get(r.id);
        return el !== undefined && isUserElement(model, el);
      })
      .map((r) => {
        const kind = statementKindOf(model, r.id);
        const mark = kind === 'prose' || kind === 'prompt' ? '-' : satisfied.get(r.id) ? 'x' : ' ';
        return [r.name, mark];
      });
    expect(marks, 'the rows in the transcript are not the rows the command lists').toEqual(expected);
    // And the NOTE on each `[-]` row, which is the labelling contract itself: a
    // row that is not counted has to say both what it is and that it is not
    // counted, or the reader adds it back to the divisor. The mark comparison
    // above is blind to it — a `[-]` row reading "counted like any other
    // requirement" would satisfy every assertion so far while teaching the
    // opposite of what the tool does.
    const notes = [...t.matchAll(/^ {2}\[-\] \d+ {2}(\S+)[^—]*— (.+)$/gm)].map((m) => [m[1], m[2]]);
    const expectedNotes = buildRequirementsTable(model)
      .rows.filter((r) => {
        const el = model.get(r.id);
        if (el === undefined || !isUserElement(model, el)) return false;
        const kind = statementKindOf(model, r.id);
        return kind === 'prose' || kind === 'prompt';
      })
      .map((r) => [r.name, NON_NORMATIVE_NOTE[statementKindOf(model, r.id) as 'prose' | 'prompt']]);
    expect(expectedNotes.length, 'the snippet has no non-normative statement to label').toBe(
      sat.nonNormativeExcluded,
    );
    expect(
      notes,
      'the `[-]` rows in the transcript do not say what the command says on them',
    ).toEqual(expectedNotes);
  }, 60_000);

  it('the applies-to listing is the walk the tool performs', async () => {
    const loaded = await loadModelText(PROMPT_SNIPPET(), { fileName: 'propulsion.sysml' });
    const model = loaded.model!;
    const t = PROMPT_TRANSCRIPT();
    // The element the transcript asks about, read out of the transcript's own
    // command line: a guide that showed one element and reported another's
    // guidance is exactly the failure this case is for.
    const asked = /--element (\S+)/.exec(t);
    expect(asked, 'the prompts transcript shows no `--element`').not.toBeNull();
    const el = model.all().find((e) => e.declaredName === asked![1]);
    expect(el, `the snippet has no element called ${asked![1]}`).toBeDefined();
    const report = promptsFor(model, el!.id);
    expect(
      figure(t, /— (\d+) prompt\(s\) apply/),
      'the number of prompts the heading claims',
    ).toBe(report.prompts.length);
    const rows = [...t.matchAll(/^ {2}(\d+) {2}(self|type|owner) *(\S+)(?: via (\S+))?$/gm)].map(
      (m) => ({ distance: Number(m[1]), via: m[2], prompt: m[3], attachedTo: m[4] }),
    );
    // Same reason as the coverage case: the point of the transcript is that
    // guidance written nowhere near the element still reaches it, so a listing
    // that matched nothing must fail rather than agree with an empty walk.
    expect(rows.length, 'the transcript shows no applicable prompts at all').toBeGreaterThan(1);
    expect(
      rows,
      'the transcript rows are not the prompts the walk returns, in the order it returns them',
    ).toEqual(
      report.prompts.map((p) => ({
        distance: p.distance,
        via: p.via,
        prompt: p.prompt.qualifiedName,
        // At distance 0 the command prints no `via`, because the prompt hangs
        // on the element in the heading.
        attachedTo: p.distance === 0 ? undefined : p.attachedTo.qualifiedName,
      })),
    );
    // And the words, which are the payload: a listing that found the guidance
    // and printed somebody else's sentence is the one failure `promptText`
    // exists to prevent.
    for (const p of report.prompts) {
      expect(t, `the transcript shows the words of ${p.prompt.qualifiedName}`).toContain(p.text);
    }
    // The three figures under the listing, which say what the walk did NOT
    // report. They are the guide's own evidence for "the bundled library is
    // dropped at every hop and the count is printed", and nothing in this
    // repository read them before: `docs-counts.test.ts` has no claim for
    // any of the sentences, and the strings occur only in `scripts/sysprose.ts`
    // and here. The third is the typings the walk cannot follow; its `0` here
    // is a measurement, and a transcript that kept a stale figure after the
    // snippet gained an ISQ-typed attribute must fail rather than agree.
    expect(figure(t, /(\d+) library element\(s\) dropped/), 'library elements dropped').toBe(
      report.libraryExcluded,
    );
    expect(figure(t, /(\d+) re-derived element\(s\) crossed/), 're-derived elements crossed').toBe(
      report.implicitExcluded,
    );
    expect(
      figure(t, /(\d+) declared type\(s\) this walk cannot follow/),
      'declared types the walk cannot follow',
    ).toBe(report.unresolvedTypings);
    // The legend, verbatim from the CLI. It is the sentence that tells a reader
    // the third path exists — guidance reaching an element from where its TYPE
    // sits — so a reword that dropped that clause would leave the guide
    // promising a walk the tool no longer describes.
    expect(t, 'the transcript no longer quotes the legend the command prints').toContain(
      PROMPTS_LEGEND,
    );
  }, 60_000);

  /**
   * The line ranges the section cites really bracket the rules it names.
   *
   * Every "Source of truth" block in this guide is a pointer a reader follows
   * instead of searching, and a range off by a few lines lands them inside a
   * doc comment or a neighbouring helper — which is what §7 shipped with. The
   * two rules here are the only citation in the guide whose target is a NAMED
   * declaration with a mechanical start and end, so they are the ones that can
   * be checked rather than eyeballed.
   */
  it('the line ranges §7 cites bracket the two rules it names', () => {
    const cited = /`src\/validation\/rules\.ts:(\d+)-(\d+)`, `(\d+)-(\d+)`/.exec(GUIDE);
    expect(cited, '§7 no longer cites two line ranges in src/validation/rules.ts').not.toBeNull();
    const ranges: Array<[number, number]> = [
      [Number(cited![1]), Number(cited![2])],
      [Number(cited![3]), Number(cited![4])],
    ];
    const lines = read('src/validation/rules.ts').split('\n');
    const ids = ranges.map(([from, to]) => {
      expect(
        lines[from - 1],
        `src/validation/rules.ts:${from} is not the first line of a rule`,
      ).toMatch(/^const \w+: ValidationRule = \{$/);
      expect(lines[to - 1], `src/validation/rules.ts:${to} is not the last line of a rule`).toBe(
        '};',
      );
      const id = /^ {2}id: '([\w-]+)',$/m.exec(lines.slice(from - 1, to).join('\n'));
      expect(id, `no rule id inside src/validation/rules.ts:${from}-${to}`).not.toBeNull();
      return id![1];
    });
    // And they are the two rules the section's prose actually discusses, in the
    // order it discusses them — a range that brackets *a* rule correctly while
    // pointing at the wrong one is the same dead end for the reader.
    expect(ids, 'the ranges §7 cites are not the rules §7 names').toEqual([
      'requirement-subject',
      'constraint-violation',
    ]);
    for (const id of ids) {
      expect(GUIDE, `§7 names the \`${id}\` rule it cites`).toContain(`\`${id}\``);
    }
  });
});
