# The agent text-authoring campaign

**The question this campaign exists to answer:** when an AI agent writes a
`.sysml` file and the file is wrong, does Sysprose tell the agent enough to fix
it?

Not "does the tool reject bad input" — it always did. The question is whether
the rejection is *actionable* by something that cannot see the screen, cannot
ask a colleague, and has only the tool's output to work from.

Sysprose's whole positioning is models developed as textual definitions and
exercised by agents. That makes diagnostic quality a primary feature, not a
nicety, and it makes it testable.

---

## 1. What was true before this campaign

Established by reading the code, not by assumption:

| Aspect | State |
|---|---|
| Channels an agent could use | One: drive the browser DOM (Text tab → Apply → Problems panel). No command line, no HTTP, no SDK call took text. |
| Parse diagnostic shape | `{message, line, column, severity}`. The parser's exception class, expected-token set and end position were computed and discarded. |
| What reached the UI | `line`/`column` were flattened into the message string, so an agent had to regex `(line N:C)` out of English prose. |
| Validation findings | Carried an element id but **no text position at all**. Nothing mapped an element back to its source lines. |
| Error-path tests | 8 tests fed malformed text. None asserted a message, a count, or an exact position. |
| Fixture corpus | None. No golden format for expected diagnostics. |

## 2. The solution: the Agent Diagnostics Contract

Three pieces, all shipped in Phase 1.

**A stable code on every finding.** Messages get reworded; codes do not.
Automation branches on `code`. The catalogue is
[`DIAGNOSTIC-CODES.md`](DIAGNOSTIC-CODES.md), generated from
`src/text/langium/diagnostic-codes.ts` so the two cannot drift.

**A source range on every text-derived finding.** 1-based line and column plus
0-based offsets, start and end. Parse errors get the offending token's span.
Validation findings get the span of the declaration that produced the element,
via a side table the parser now returns (`ParseResult.ranges`). The table is
deliberately *not* stored on elements: a range belongs to one source text, not
to the model, and must never reach persistence or interchange.

**Repair information.** `expected` lists what would have been legal at that
position, `found` is what was written instead, and `hint` is one line naming the
fix. These come from data the parser already had and used to throw away.

### The headless entry point

```ts
import { checkText } from '@text/index';
const report = await checkText(source, { fileName: 'model.sysml' });
if (!report.ok) { /* report.diagnostics — each with code, range, hint */ }
```

`checkText` runs the three stages that were previously wired together only
inside the UI: parse, standard-library binding, model validation. It **never
throws** — an internal failure becomes an `import/internal-error` finding with
`ok: false`, because a checker that fails silently would let a broken model
through as clean.

### The agent loop

```bash
npm run check -- model.sysml --json     # exit 0 clean · 1 findings · 2 usage/IO
```

1. Write `model.sysml`.
2. Run the check and read the JSON report.
3. For each finding: go to `range.start`, apply `hint`, using `expected` and
   `found` to decide the edit.
4. Repeat until `ok` is true.

Human-readable output is the default; `--json` is the agent format. Other
options: `--strict` (warnings fail too), `--no-library` (faster, but library
types such as `Real` then report as unresolved), `--ranges` (include the
element→span table). Read from stdin with `-`.

## 3. The campaign

Fixtures live in `test/fixtures/text-campaign/`, one directory per case:

| File | Role |
|---|---|
| `input.sysml` | The flawed file, as an agent might have written it. |
| `expected.json` | The golden: the diagnostics an agent **needs**. |
| `fixed.sysml` | The repair. Asserted to check clean, so every case proves its own fix works. |
| `meta.json` | Level, title, and any non-obvious background. |

Run with `npm run campaign`. Regenerate goldens with `CAMPAIGN_UPDATE=1
npx vitest run test/campaign` — a regenerated golden is a **draft**: it records
what the tool does today, which is not the same as what an agent needs. Every
one in this corpus was read and corrected by hand.

### Levels

| Level | Covers | Cases |
|---|---|---|
| L0 | Recognition and encoding: empty file, comments only, BOM, CRLF, tabs, non-ASCII names, JSON offered as SysML, unknown extension | 8 |
| L1 | Lexical: illegal character, unterminated string, unterminated comment | 3 |
| L2 | Syntactic: missing semicolon and brace, extra brace, unknown keyword, reversed keywords, empty type, bad multiplicity, bad expressions, `=` vs `==`, bare `->`, two independent errors | 13 |
| L3 | Referential: unresolved type, connection end, import, transition end, specialization, plus two pinned behaviours | 7 |
| L4 | Semantic rules **authored as text** rather than built programmatically: duplicate name, blank name, port direction, requirement subject, specialization cycle, value-type mismatch | 7 |
| L5 | Recovery and cascade: one bad declaration must not cost the other forty | 2 |
| L6 | **Sufficiency invariants over the whole corpus** (see below) | 12 assertions |

### L6 is the level that matters

The goldens check that the right diagnostic appears. L6
(`test/campaign/invariants.test.ts`) checks something harder: that every finding
the tool emits is *usable*. These are properties, so a new fixture is covered the
moment it is added, and a regression in diagnostic quality fails even when every
golden still matches.

Asserted across every fixture: each finding carries a catalogue code, a source
stage and a non-empty hint; every lexer, parser and mapper finding carries a
range; every reported position exists in the file and no range ends before it
starts; every error names a token or an element; every parser error carries
either an expected-token list or a hint; the checker never crashes; `ok` agrees
with the error count; results are deterministic; and every documented repair
checks clean.

### Known-failing cases are the point

A case whose golden carries `expectFail` states what an agent **needs** and
records that the tool does not yet provide it. The runner asserts the shortfall
still exists and **fails loudly if it disappears**, so an improvement is noticed
and the fixture promoted rather than silently drifting.

## 4. Open defects

Found by this campaign. Each has a fixture pinning it.

**Forward references inside a package do not resolve.** A nested feature typed
by a definition declared later in the same package stays unresolved, so a valid
model is reported as having unresolved types. Declaration order is not
significant in SysML v2, so this is wrong. The project's own
`examples/vehicle.sysml` is written in that order and reports six such errors.
Moving definitions above their use is the workaround, not the fix. The mapper
delegates type references to `resolveTypeReferences`
(`src/library/resolve.ts`), whose fallback resolves only *qualified* names from
the model root, so an unqualified name in a nested scope never binds. Fixture:
`L3-forward-reference-in-package`. This is a semantic change and deserves its
own review, so it was not fixed in Phase 1.

**An unterminated block comment identifies nothing.** The agent gets a cascade
of parse errors starting at the `/` character, none of which says "close your
comment". Fixture: `L1-unterminated-comment`.

**An unterminated string is reported as an illegal character**, and its hint
tells the agent to *remove* the quote — the opposite of the repair. Fixture:
`L1-unterminated-string`.

**A misspelled or misordered declaration keyword is blamed on the next token.**
`blok def Vehicle;` produces "Expecting `}` but found `def`" and a hint to
insert a brace, which does not repair the file. Fixtures:
`L2-unknown-keyword`, `L2-keyword-order`.

**The bare `A -> B` transition shorthand is rejected without naming the fix.**
Rejection is deliberate — it is ambiguous with a function-operation expression —
but the diagnostic never mentions the `transition` keyword the agent must write.
Fixture: `L2-bare-transition-arrow`.

**An import of a package that does not exist is entirely silent.** No finding at
any severity. The `ref/unresolved-import` code exists but nothing emits it.
Fixture: `L3-unresolved-import`.

### Fixed during this work

**The parser threw on an unterminated block comment.** Error recovery handed the
mapper a comment node with an undefined body and `stripBlockComment` called
`startsWith` on it, so `parseModel` raised a `TypeError`. An agent whose only
mistake was forgetting `*/` got a crash instead of a diagnostic. Now guarded.

**End-of-file errors reported `NaN:NaN`.** The parser's end-of-file token
carries NaN positions, which reached agents as an unnavigable position and broke
any consumer doing arithmetic on it. An error at end of file is exactly the
"missing closing brace" case, so it now reports the last real position.

### Pinned behaviours (decisions, not defects)

**An unresolved attribute value type is not reported.** `attribute a : NotAType;`
is silent by design, because value types usually live outside the loaded scope.
Fixture `L3-unresolved-attribute-type-is-silent` pins it, so if it ever starts
warning that is a deliberate decision rather than a drift.

**A missing semicolon is accepted.** Verified: the parser recovers and builds a
model *identical* to the one the corrected file produces. Friendly for an agent,
but the file stays non-portable to stricter tools. Fixtures
`L2-missing-semicolon` and `L2-missing-semicolon-simple` assert the equivalence.

**`validation/connector-endpoints` is unreachable from text.** The grammar
requires both ends of a connect statement, so the rule fires only on
programmatically built models. Recorded in `L4-connector-one-end` so the gap is
known rather than hidden.

## 5. Phase status

- **Phase 1 — done.** The contract, `checkText`, the CLI, the fixture corpus,
  the runner and the L6 invariants.
- **Phase 2 — channels and UI.** A `window.sysprose.text` hook beside
  `window.sysml`; `POST /api/text/check`; line and column in the Problems panel
  with click-to-line; a strict apply mode that refuses to replace the model when
  the text has errors; surfacing the silently swallowed JSON import failure.
- **Phase 3 — the measurement.** `scripts/agent-repair-bench.ts`: give a real
  model the flawed file plus the JSON report, ask for a corrected file, iterate,
  and record how many rounds each case takes. Phase 1's L6 invariants are the
  static proxy for this.
- **Phase 4 — fix the ledger** above, promoting each `expectFail` fixture as it
  is fixed.
