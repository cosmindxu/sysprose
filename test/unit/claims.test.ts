/**
 * Trademark & claim guard — the machine-checkable half of the project rules in
 * `CLAUDE.md` §"Naming, trademarks and claims".
 *
 * Sysprose implements a SysML v2–style notation and an OMG-API-shaped element
 * graph, but it has never been conformance-tested or certified by the OMG or
 * anyone else. Two habits follow, and this suite enforces both across the whole
 * repository so they cannot rot back in through a stray doc edit:
 *
 *   1. The product is never called conformant / compliant / certified.
 *   2. No OMG, SysML or KerML logo or brand asset is referenced.
 *
 * What is still allowed, deliberately:
 *   - NEGATED statements ("not certified", "never conformance-tested") — those
 *     are the disclaimers we want to keep.
 *   - The bare words "conformance"/"conformance-tested" (docs/CONFORMANCE.md,
 *     test/conformance/, "conformance scorecard") — naming the topic is not a
 *     claim to have passed it.
 *   - Descriptive statements about THIRD PARTIES ("the OMG pilot", "a conformant
 *     tool must preserve X") — those describe the spec or someone else's server.
 *
 * These rules stand only while the tool is uncertified. If Sysprose is ever
 * genuinely certified, this suite is what you delete — see CLAUDE.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

/** Directories never scanned: build output, deps, third-party text, tool reports. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'test-results',
  'playwright-report',
  'release',
  '.vite',
]);

/**
 * Files exempt by path, with the reason.
 * - `src/library/std/**` — EPL-2.0 licence + notice text we may not edit.
 * - the two survey docs, and the book review — they report what OTHER tools,
 *   the standard, and the literature say, where "SysON leads OMG/SysML v2
 *   compliance" is a fact about someone else and not a claim about this tool.
 * - this file, and `CLAUDE.md` — the rule itself has to quote the banned forms
 *   verbatim in order to define them.
 */
const SKIP_FILES = (rel: string): boolean =>
  rel.startsWith(`src${sep}library${sep}std${sep}`) ||
  rel === join('docs', '01-state-of-the-art.md') ||
  rel === join('docs', '02-omg-standard-reference.md') ||
  // The verification plan quotes every banned form verbatim in order to ban it:
  // its MUST-NEVER list IS the list of sentences this guard exists to catch.
  rel === join('docs', '04-formal-verification-plan.md') ||
  // The book review quotes the literature verbatim, and two of those quotations
  // ARE reserved forms: the Handbook's "or the property is verified" (ch 13, on
  // CEGAR's termination) and Baier & Katoen's theorem title "Realizable Fairness
  // is Irrelevant for Safety Properties". Measured: those two lines, and only
  // those two, fire the guard. Rewording either would misquote a source, so the
  // file is exempt as a whole — like the two survey docs above, it reports what
  // OTHER work says rather than making a claim about this tool.
  rel === join('docs', '05-model-checking-literature.md') ||
  // The implementation plan is the third of these, and for the FIRST of the two
  // reasons rather than the second: it is not reporting what other work says, it
  // is writing the MUST-NEVER lists themselves. A list of sentences the tool may
  // never print has to print them once, in order to name them — `deadlock-free`,
  // `realizable`, and every reserved copula form — which is exactly the shape
  // this guard exists to catch. Measured before the entry was added: the file
  // fires on the forms it quotes in order to ban them, and on nothing else.
  rel === join('docs', '06-model-checking-implementation-plan.md') ||
  rel === join('test', 'unit', 'claims.test.ts') ||
  rel === 'CLAUDE.md' ||
  rel === 'package-lock.json';

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|html|css|svg|webmanifest|yml|yaml|sh|langium)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (TEXT_EXT.test(name) || name === 'Dockerfile' || name === 'LICENSE' || name === 'NOTICE') {
      const rel = relative(ROOT, abs);
      if (!SKIP_FILES(rel)) out.push(rel);
    }
  }
  return out;
}

const FILES = walk(ROOT);

interface Hit {
  file: string;
  line: number;
  text: string;
}

const NEGATION = /\b(not|never|no|non|without|isn't|aren't|nor|neither)\b/i;

/**
 * Is this match defused by a negation? Either just before it ("we are NOT
 * conformant") or inside the matched span itself ("it is *not* a certified …",
 * where the match starts at "it is" and swallows the negation).
 */
function negated(before: string, matched: string): boolean {
  return new RegExp(`${NEGATION.source}[\\s\\S]{0,40}$`, 'i').test(before) || NEGATION.test(matched);
}

/** A document the guard reads: a path, and its lines. */
interface Doc {
  file: string;
  lines: string[];
}

/**
 * The tree, read once.
 *
 * Every scan used to re-read all 690-odd files, which was affordable while
 * there were five patterns and is not now that the verification lane adds its
 * own. Reading once also makes the guard testable: {@link scanDocs} takes a
 * document set, so a PLANTED document — a sentence written to violate the rule
 * — can be scanned with the same code that scans the repository, which is what
 * turns "the guard would catch it" from a belief into an assertion.
 */
const TREE: Doc[] = FILES.map((file) => ({
  file,
  lines: readFileSync(join(ROOT, file), 'utf8').split('\n'),
}));

/**
 * How far an allowance may sit from the match it defuses, in characters.
 *
 * An allowance is a phrase that makes THIS match innocent — "verified against
 * the corpus", the `Verified By` column identifier — so it has to sit beside
 * the match, not merely somewhere on the same line. Scoped to the whole line,
 * one honest half of a sentence defuses the other: `The exported file was
 * verified against the solver, and the model is verified.` carries a real claim
 * AND an allowance, and the allowance won.
 *
 * The window is ASYMMETRIC because a qualifier is. Every allowance here follows
 * the word it qualifies — `verified against …`, `consistent within scope`,
 * `proved: the negation is unsat` — so the reach forward is generous enough to
 * cross a line break, and the reach backwards is barely more than the subject
 * the match already swallowed. 16 back is what separates the two halves of the
 * sentence above; 80 forward is what keeps a wrapped qualifier attached.
 */
const ALLOWANCE_BEFORE = 16;
const ALLOWANCE_AFTER = 80;

/** Scan `docs` for `pattern`, returning un-negated hits. */
function scanDocs(docs: readonly Doc[], pattern: RegExp, allow: RegExp[] = []): Hit[] {
  const hits: Hit[] = [];
  for (const { file, lines } of docs) {
    lines.forEach((text, i) => {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      const prev = lines[i - 1] ?? '';
      const joined = `${prev}\n${text}\n${lines[i + 1] ?? ''}`;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        // Look back across the previous line too — claims wrap.
        const before = prev + ' ' + text.slice(0, m.index);
        if (negated(before, m[0])) continue;
        const at = prev.length + 1 + m.index;
        const window = joined.slice(
          Math.max(0, at - ALLOWANCE_BEFORE),
          at + m[0].length + ALLOWANCE_AFTER,
        );
        if (allow.some((a) => a.test(window))) continue;
        hits.push({ file, line: i + 1, text: text.trim().slice(0, 160) });
      }
    });
  }
  return hits;
}

/** Scan the whole repository. */
function scan(pattern: RegExp, allow: RegExp[] = []): Hit[] {
  return scanDocs(TREE, pattern, allow);
}

/** Scan one planted document, written here rather than committed to the tree. */
function scanText(text: string, pattern: RegExp, allow: RegExp[] = []): Hit[] {
  return scanDocs([{ file: 'planted.md', lines: text.split('\n') }], pattern, allow);
}

const show = (hits: Hit[]): string =>
  hits.map((h) => `\n  ${h.file}:${h.line}  ${h.text}`).join('');

describe('the product is never called conformant, compliant or certified', () => {
  it('has no "<standard>-conformant" / "fully compliant" style claim', () => {
    // "OMG-conformant", "spec conformant", "SysML v2 compliant", "fully conformant",
    // "100 % conformant", "standard-compliant", …
    const hits = scan(
      /\b(omg|sysml(?:\s*v?2)?|kerml|spec(?:ification)?|standard|fully|100\s*%)[-\s]*(conformant|compliant)\b/i,
      [
        // A statement about what the SPEC requires of any tool, not about ours.
        /\bconformant (tool|server|implementation|pilot)s? (must|serves|would|may)\b/i,
        /\bto a conformant\b/i,
      ],
    );
    expect(hits, `un-negated conformance claim:${show(hits)}`).toEqual([]);
  });

  it('never says the tool itself is conformant, compliant or certified', () => {
    const hits = scan(
      /\b(sysprose|this tool|the tool|the modeler|our (own )?(server|implementation|tool)|we|it)\b[^.\n]{0,60}\b(is|are|being|remains?)\b[^.\n]{0,25}\b(conformant|compliant|certified)\b/i,
    );
    expect(hits, `first-person conformance claim:${show(hits)}`).toEqual([]);
  });

  it('never claims certification anywhere', () => {
    const hits = scan(/\bcertifi(ed|cation)\b/i, [
      // Naming the ABSENCE of certification is the disclaimer we want.
      /self-assessment, not certification/i,
      /candidate/i,
    ]);
    expect(hits, `certification claim:${show(hits)}`).toEqual([]);
  });
});

describe('no OMG / SysML / KerML brand assets are referenced', () => {
  it('references no standard-body logo or brand image', () => {
    const hits = scan(/\b(omg|sysml|kerml)[-_\s]?(logo|logotype|wordmark|brandmark|trademark[-_]?asset)\b/i);
    expect(hits, `brand asset reference:${show(hits)}`).toEqual([]);
  });

  it('embeds no image fetched from a standard body', () => {
    const hits = scan(/(src|href)\s*=\s*["'][^"']*\b(omg\.org|sysml\.org|omgsysml\.org)\b[^"']*\.(png|jpe?g|svg|gif|webp)/i);
    expect(hits, `remote brand image:${show(hits)}`).toEqual([]);
  });
});

describe('the disclaimers that make the above honest are present', () => {
  it('README carries the candidate-status + trademark + non-affiliation statement', () => {
    // Collapse wrapping — these sentences span source lines.
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
    expect(readme).toMatch(/candidate implementation/i);
    expect(readme).toMatch(/registered trademark of the Object Management Group/i);
    expect(readme).toMatch(/not affiliated with, sponsored by, or endorsed by/i);
  });

  it('the conformance scorecard opens by saying it is a self-assessment', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'CONFORMANCE.md'), 'utf8').replace(/\s+/g, ' ');
    expect(doc.slice(0, 1200)).toMatch(/self-assessment, not certification/i);
  });
});

/* ═══════════════ the verification lane: sentences, not words ═══════════════ */

/**
 * WHY THIS HALF RESERVES SENTENCES AND NOT WORDS, measured rather than assumed.
 *
 * The obvious guard is a word list — ban `verified`, `correct`, `safe`, `proved`,
 * `consistent` — and it is unusable here. Replicating the walk above over its own
 * scan set, case-sensitively and whole-word, the tree already contains 104 `safe`,
 * 61 `correct` and 42 `verified` in ordinary prose, plus 301 `proved` and 131
 * `consistent` that are identifiers, verdict vocabulary, or sentences ABOUT the
 * vocabulary ("`pass` is written for `proved` alone"). A bare-word gate would open
 * red on several hundred pre-existing lines that claim nothing, and the only way
 * to get it green would be to stop writing about the words — which is the opposite
 * of the honesty this file exists to keep.
 *
 * So each form is SUBJECT-SCOPED: it fires on the sentence a reader would quote
 * against us — "the model is verified", "the requirement is proved" — and not on
 * the word. The unscoped copula form (`is|are|was|were|has been|have been` +
 * `verified|correct|safe`) was measured over the same scan set and fires on 21
 * pre-existing lines, none of them a claim about this tool; the subject-scoped
 * form fires on 0 of them. All five forms below measure 0 across the tree, which
 * is the budget this commit was written to.
 *
 * EVERY ONE OF THOSE FIGURES WAS RE-MEASURED IN THIS COMMIT, over this tree's own
 * 696-file scan set, not carried forward from the plan document's count at
 * `f1cd587` — the tree grew by a fifth between the two, and a measurement quoted
 * from an older tree is exactly the kind of number this project's docs guard
 * exists to catch. No assertion depends on them — they are here so the next
 * person can tell whether the subject-scoping is still buying what it cost, and
 * re-measure with the same walk if it looks as though it is not.
 *
 * THE PRICE, RECORDED RATHER THAN HIDDEN — the complete list of what still slips
 * through, each one measured by planting the sentence and watching nothing fire:
 *
 *   1. **A pronoun subject.** "It is safe" is not caught, and `it` is
 *      deliberately absent from the subject list — that one alternative alone
 *      puts `test/conformance/corpus.test.ts`:9 back.
 *   2. **A subject this list does not name.** The nouns are enumerated
 *      ({@link SUBJECT}), so "the encoding is correct" or "the export is safe"
 *      walk past. Adding a noun is cheap and costs 0 hits until it collides with
 *      ordinary prose; the list is meant to grow when a real sentence escapes.
 *   3. **A clause that is not a copula sentence.** "We verified the model",
 *      "a verified model", "proves the requirement" — the forms reserve the
 *      predicate a reader would quote, not every grammatical route to it.
 *   4. **An allowance beside a claim.** The reach forward
 *      ({@link ALLOWANCE_AFTER}) is 80 characters, so an honest "verified
 *      against the corpus" within 80
 *      characters after a real claim still defuses it. Narrowing the reach trades
 *      this against splitting qualifiers that wrap.
 *
 * What does NOT slip through any more, and used to: an adverb or `proven` between
 * the copula and the adjective ("the requirement is formally verified", "the tool
 * is proven safe"), a plural or demonstrative subject ("these models are
 * verified", "this model is verified"), and an allowance sitting anywhere else on
 * a long line. Each is asserted below, on a planted sentence.
 *
 * This guard catches the sentence, not every English sentence containing the
 * word; the MUST-NEVER list in `docs/04-formal-verification-plan.md` is the rule,
 * and this is its machine-checkable half.
 */
const SUBJECT = String.raw`(?:sysprose|(?:the|this|that|these|those|our)\s+(?:tools?|models?|propert(?:y|ies)|requirements?|obligations?|proofs?|clauses?|verdicts?|results?|architectures?|systems?))`;

/** The copulas a claim is made with. */
const COPULA = String.raw`(?:is|are|was|were|has been|have been)`;

/**
 * What may stand between the copula and the adjective, and still be the claim.
 *
 * "The requirement is FORMALLY verified" and "the model has been PROVEN correct"
 * are the sentences a reader would actually quote, and a form that stopped at
 * the bare copula missed both — an adverb or the participle `proven` in the gap
 * was all it took to walk past the guard. `proven` lives here rather than in
 * {@link COPULA} because it is an adjective: "is proven safe" is one claim, and
 * "is proven" on its own is a different sentence the `proved` form owns.
 * Measured over this tree's 696-file scan set, widening the gap costs **0**
 * additional hits — the reach was free.
 */
const GAP = String.raw`(?:(?:\w+ly|proven)\s+)?`;

/**
 * The reserved sentence forms, each with the allowances that keep it usable.
 *
 * `what` is the sentence a reader would have written; it is printed on failure so
 * the message names the rule rather than the regex.
 */
const RESERVED_FORMS: Array<{ what: string; pattern: RegExp; allow: RegExp[] }> = [
  {
    what: 'a subject of ours is verified / correct / safe',
    pattern: new RegExp(String.raw`\b${SUBJECT}\s+${COPULA}\s+${GAP}(verified|correct|safe)\b`, 'i'),
    allow: [
      // Hyphenated compounds are properties of an algorithm, not claims about
      // the tool: a `cycle-safe` walk is one that terminates on a cycle.
      /\b(cycle|no-op|type|NCName)-safe\b/i,
      // The requirement-table column and its field name are identifiers.
      /\bVerified By\b/,
      /\bverifiedBy\b/,
      // "verified against the corpus", "verified: 3 rows" — a probe or a test
      // reporting what IT did, which is the word's honest use.
      /\bverified (against|by a probe|by a test)\b/i,
      /\bverified:/i,
    ],
  },
  {
    what: 'anything is deadlock-free or realizable',
    // Neither word is earned anywhere in this tool: liveness is not decided
    // in-process (plan §6, non-goal 4) and reactive realizability is a different
    // question from the satisfiability `consistency` decides (non-goal 5).
    pattern: /\b(deadlock[- ]free|realizable)\b/i,
    allow: [],
  },
  {
    what: 'a subject of ours is proved, with no warrant beside it',
    // `proved` is earned by exactly one thing — the negation being unsat under a
    // satisfiable axiom set — so the word is admissible where the warrant is in
    // reach: `unsat`, `negation`, `z3` or `kernel` on the line or the one above.
    pattern: new RegExp(String.raw`\b${SUBJECT}\s+${COPULA}\s+${GAP}proved\b`, 'i'),
    allow: [/\b(unsat|negation|z3|kernel)\b/i],
  },
  {
    what: 'a subject of ours is consistent, without saying over what',
    // `consistency` decides satisfiability of the relations it ENCODED. A set
    // called consistent without the ones it refused may be excluded by the very
    // relation that was refused, so the scope travels with the word.
    pattern: new RegExp(String.raw`\b${SUBJECT}\s+${COPULA}\s+${GAP}consistent\b`, 'i'),
    allow: [/\bconsistent\s+(within scope|over the \d+ encoded)\b/i],
  },
  {
    what: 'a Sysprose keyword is called standard vocabulary',
    // The four verification keywords are TOOL-LOCAL tags over a `metadata def`,
    // written with the specification's own extension point (§7.27.1, §7.27.4).
    // Calling one of them standard, in either word order, is the sentence that
    // would make this tool the author of vocabulary it merely spells.
    pattern:
      /(#'?(Exception|Observable|precondition|postcondition)'?\b[^.\n]{0,40}\b(standard|SysML ?v2|conformant)\b|\b(standard|SysML ?v2|conformant)\b[^.\n]{0,40}#'?(Exception|Observable|precondition|postcondition)'?\b)/i,
    allow: [],
  },
];

describe('the verification lane reserves sentence forms, not words', () => {
  for (const form of RESERVED_FORMS) {
    it(`no file says ${form.what}`, () => {
      const hits = scan(form.pattern, form.allow);
      expect(hits, `reserved sentence form — ${form.what}:${show(hits)}`).toEqual([]);
    });
  }
});

describe('the guard itself, verified against planted sentences', () => {
  const fires = (text: string): boolean =>
    RESERVED_FORMS.some((f) => scanText(text, f.pattern, f.allow).length > 0);

  it('fires on a planted claim and not on its negation', () => {
    expect(fires('The model is verified by z3.'), 'a planted claim slipped through').toBe(true);
    expect(fires('The model is not verified by z3.'), 'a negated sentence is the disclaimer').toBe(
      false,
    );
  });

  it('fires on a keyword called standard, and not on one called not standard', () => {
    expect(fires('We read the standard #Exception keyword.')).toBe(true);
    expect(fires('`#Exception` is not standard vocabulary.')).toBe(false);
  });

  it('fires on `proved` with no warrant, and not on `proved` with one', () => {
    expect(fires('The requirement is proved.'), 'a bare proof claim slipped through').toBe(true);
    expect(
      fires('The requirement is proved: the negation is unsat under a satisfiable axiom set.'),
      'the warranted sentence is the one this lane is allowed to print',
    ).toBe(false);
  });

  it('fires on an unqualified `consistent`, and not on a scoped one', () => {
    expect(fires('The model is consistent.'), 'an unscoped consistency claim slipped through').toBe(
      true,
    );
    expect(fires('The model is consistent within scope.')).toBe(false);
    expect(fires('The model is consistent over the 4 encoded relations.')).toBe(false);
  });

  it('fires on the two words nothing in this tool earns', () => {
    expect(fires('The state machine is deadlock-free.')).toBe(true);
    expect(fires('The contract set is realizable.')).toBe(true);
    // …and the disclaimers that say so are what the negation window keeps.
    expect(fires('No run of this engine can show a machine deadlock-free.')).toBe(false);
  });

  it('fires through an adverb or a `proven` in the gap', () => {
    // The sentence a reader would quote is almost never the bare copula form —
    // it is this one, and the form used to walk straight past it.
    expect(fires('The requirement is formally verified.')).toBe(true);
    expect(fires('The requirement is fully verified.')).toBe(true);
    expect(fires('The tool is proven safe.')).toBe(true);
    expect(fires('The model has been proven correct.')).toBe(true);
    // And the negation is still the disclaimer, adverb or not.
    expect(fires('The requirement is not formally verified.')).toBe(false);
  });

  it('fires on a plural or demonstrative subject', () => {
    expect(fires('The models are verified.')).toBe(true);
    expect(fires('This model is verified.')).toBe(true);
    expect(fires('Our model is verified.')).toBe(true);
    expect(fires('These requirements are proved.')).toBe(true);
  });

  it('is not defused by an allowance sitting elsewhere on the line', () => {
    // Both halves are real: the first is the word's honest use, the second is a
    // claim. A line-wide allowance let the first pay for the second.
    expect(
      fires('The exported file was verified against the solver, and the model is verified.'),
      'an allowance earlier in the line defused a real claim',
    ).toBe(true);
    // …while an allowance that really is about THIS match still defuses it.
    expect(fires('The model was verified against the in-process solver.')).toBe(false);
  });

  it('does not fire on the ordinary prose the tree is full of', () => {
    // The three sentences the unscoped form fired on, in the shapes they occur
    // in: a subject that is not ours, a hyphenated compound, an identifier.
    expect(fires('The walk is cycle-safe, so a cycle costs one revisit.')).toBe(false);
    expect(fires('The Verified By column lists what verifies the requirement.')).toBe(false);
    expect(fires('The exported file was verified against the in-process solver.')).toBe(false);
  });
});

/**
 * The plan document is exempt, and the exemption states its reason.
 *
 * `docs/04-formal-verification-plan.md` has to quote every banned form verbatim
 * in order to ban it — its MUST-NEVER list IS the list of sentences this guard
 * exists to catch — which is the same reason `CLAUDE.md` and this file are
 * exempt. Commit 0 added the entry; this asserts it is still there and still
 * carries its reason, because an exemption whose reason was deleted is the kind
 * that later gets deleted itself, and then the whole plan reads as a violation.
 */
describe('the one document allowed to quote the banned forms', () => {
  it('is skipped, and the skip says why', () => {
    const self = readFileSync(join(ROOT, 'test', 'unit', 'claims.test.ts'), 'utf8');
    expect(self, 'the plan document is no longer in SKIP_FILES').toContain(
      "rel === join('docs', '04-formal-verification-plan.md')",
    );
    expect(self, 'the plan document is skipped with no reason beside it').toMatch(
      /quotes every banned form verbatim in order to ban it/i,
    );
    // And it is really excluded from the walk, not merely mentioned.
    expect(FILES).not.toContain(join('docs', '04-formal-verification-plan.md'));
  });
});
