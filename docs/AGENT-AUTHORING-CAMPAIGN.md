# The agent authoring testing campaign

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

Fixtures live in `test/fixtures/agent-authoring/`, one directory per case:

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
| L7 | The command-line contract: exit codes, JSON shape, stdin, strict mode | 10 tests |
| L9 | **The measurement**: can a model repair the file from the report alone? | `npm run bench` |

### L9 — the measurement: can an agent actually repair the file?

The goldens prove the tool SAYS the right thing. L6 proves every finding is
machine-actionable in shape. Neither proves the thing that matters, so
`npm run bench` measures it directly: hand a model the flawed file and the JSON
report — no fixture identity, no `fixed.sysml`, no commentary — ask for a
corrected file, check the result, and repeat up to three rounds.

First measured run, `docs/campaign-runs/2026-09-02-repair-bench.md`:

| Metric | Value |
|---|---:|
| Fixtures with errors to repair | 22 |
| Repaired to a clean check | 22 |
| Repaired on the first round | 22 |
| Repaired with a minimal edit | 21 |

A 100% repair rate, every case on the first attempt. The one non-minimal repair
is `L3-unresolved-connection-end`, where fixing a dangling endpoint reasonably
requires adding the part it should connect to.

Read it with one caveat: the bench used the CLI's default model, which is the
same family as the assistant that built the tool, so it measures whether the
report is sufficient — not whether it is sufficient for an arbitrary third-party
model. Running it against other models is the obvious next step, and the
`--model` flag exists for exactly that.

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

## 4. Defects the campaign found

Every one of them is now fixed. Each has a fixture that is the regression test
for it, and the fixture's `note` records what the tool used to do.

**Forward references inside a package did not resolve — and silently mis-bound.**
A nested feature typed by a definition declared later in the same package
reported an unresolved type, and `examples/vehicle.sysml` reported six such
errors against its own checker. The cause was worse than the symptom: the
library binder searched the bundled standard library *before* the referencing
element's own scope, so `part e : B` bound to the library element `SI::byte`
rather than to the user's `B`, and the same name resolved to different types
depending on where it was written. KerML v1.0 §8.2.3.5.4 is explicit that a
simple name resolves outward through containing namespaces with the global
namespace last, and that declaration order is irrelevant. Resolution now follows
that order (`src/core/scope.ts`), and stale "Unresolved reference" warnings are
retracted once the binder resolves them. Fixtures:
`L3-forward-reference-in-package`, and the mis-binding is pinned by the note on
that fixture.

**An unterminated comment or string identified nothing.** Both produced a
cascade of parse errors about tokens inside the author's own prose, and the
string case hinted at *deleting* the quote, the opposite of the repair. A
pre-lex scan (`src/text/langium/lexical-scan.ts`) now finds the unclosed
delimiter and reports it instead of the cascade, because every later error is an
artefact of it. Fixtures: `L1-unterminated-comment`, `L1-unterminated-string`.

**A misspelled or misordered keyword was blamed on the next token.** The parser
stops one token past the mistake, so `blok def Vehicle;` read as "Expecting `}`
but found `def`" with a hint to insert a brace — advice that makes the file
worse. The diagnostic now inspects the surrounding tokens and names the unknown
word itself, or the ordering rule. Fixtures: `L2-unknown-keyword`,
`L2-keyword-order`.

**The bare `A -> B` shorthand never named its replacement.** Rejection is
deliberate, since it cannot be told apart from a `->` function-operation
expression, but the agent was not told to write `transition`. It is now.
Fixture: `L2-bare-transition-arrow`.

**An import of a namespace that does not exist was silent.** No finding at any
severity, so an agent could not learn that its import brought nothing into
scope. Now reported by the `unresolved-import` validation rule. Fixture:
`L3-unresolved-import`.

**The parser threw on an unterminated block comment.** Error recovery handed the
mapper a comment node with an undefined body and `stripBlockComment` called
`startsWith` on it, so `parseModel` raised a `TypeError`. An agent whose only
mistake was forgetting `*/` got a crash instead of a diagnostic.

**End-of-file errors reported `NaN:NaN`.** The parser's end-of-file token
carries NaN positions, an unnavigable position for exactly the "missing closing
brace" case. It now reports the last real position.

**The serializer emitted a doubled type.** After library binding an attribute
carried both the display string and a resolved relationship, so the Text tab
showed `attribute mass : Real : ScalarValues::Real`. The authored display string
now wins, references are emitted in their shortest resolving form, and anonymous
or dangling targets are never printed.

**A bare `then X;` was silently dropped.** SysML chains successions — `first a
then b; then c;` means a→b→c, a bare `then` continuing from the previous target
— but the mapper required both endpoints and discarded the rest with no
diagnostic. `examples/uav-isr.sysml` writes three and got one; the shipped
`examples/vehicle.sysml` action flow was two links short of what it says. Bare
`then` now chains, and a `then` with nothing before it in its scope is an error
rather than a silent no-op. Fixture: `L4-dangling-then`.

**A declared requirement subject was reported missing.** `subject v : Vehicle;`
maps to a child tagged `attrs.requirementRole = 'subject'`, a form the rule never
checked, so the idiomatic way to write a subject produced a false positive. For
an agent that is worse than silence: it invites a repair that breaks a correct
model. Fixture: `L4-requirement-subject-declared`, mutation-tested — removing the
fix makes it fail with exactly that warning.

**The scripting interface answered with the standard library.** `window.sysml`
is exposed only after the ~38,700-element library is merged, so every count an
agent read was taken in that state and included it: an 8-element model reported
38,770 elements, 189 roots and 1,011 attribute definitions. Nothing crashed and
no data was wrong — the numbers answered a different question than the one
asked. `modelMetrics`, `roots()`, `elementsOfType()` and `toModelJSON()` now
report the user's model, with `{ includeLibrary: true }` to search the library
deliberately and a `libraryElements` figure so its presence stays visible. The
raw `model.all()` is deliberately unfiltered: the browser suite polls it to
prove the async merge landed.

**Imported and inherited type references did not resolve — and imports were dead
on parsed text.** The scope walk covered owned members only, and the full
resolver could not be reached from the binder without a dependency cycle. Worse:
the textual mapper created every `import` with no `target`, so the import walk
was a no-op on any parsed model — `import Lib::*;` bound nothing, silently.
`findLibraryType` moved into core to break the cycle; the binder now gives each
import its target (`resolveImportTargets`), composes the per-scope resolver with
the outward walk (KerML v1.0 §8.2.3.5.4), and loops its pure/apply phases to a
fixpoint because one binding can enable another. Fixtures:
`L3-type-via-import`, `L3-type-via-inheritance`, `L3-library-import-from-text`.

### Known limitations, recorded rather than hidden

**Forward and backward references can resolve differently when a name is both
inherited and in an outer scope.** The binder (forward references) consults
inherited members at each scope before walking outward, as the spec says; the
mapper (backward references, resolved at parse time) walks owned members only.
A name declared both in a supertype and in an enclosing package therefore binds
to the inherited one if written before its declaration and the outer one if
after. Documented in `src/core/scope.ts` until the mapper is taught to defer.


**Numeric literal form is lost at parse time.** `1500.0` becomes `1500` because
the mapper stores the parsed number, not the source text. Fixing it means
changing what `attrs.value` holds, which the solver, unit evaluation and
conformance checks all read, so it is not a serializer change and is not worth
its blast radius today.

**Error recovery re-homes declarations to the root namespace.** After a bad
declaration, the ones that follow survive but escape their enclosing package.
Recorded on `L2-two-independent-errors` and `L5-recovery-keeps-siblings`.

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
- **Correctness pass — done.** Every defect in §4 fixed; no fixture carries
  `expectFail` any more, so every level passes on merit rather than by recording
  a shortfall.
- **Phase 2 — channels and UI.** A `window.sysprose.text` hook beside
  `window.sysml`; `POST /api/text/check`; line and column in the Problems panel
  with click-to-line; a strict apply mode that refuses to replace the model when
  the text has errors; surfacing the silently swallowed JSON import failure.
- **Phase 3 — done.** `scripts/agent-repair-bench.ts` and the first measured
  run under `docs/campaign-runs/`. See L9 above.
- **Phase 4 — done.** Every defect in §4 fixed and every fixture promoted; no
  `expectFail` remains. What is left is recorded under "Known limitations".
