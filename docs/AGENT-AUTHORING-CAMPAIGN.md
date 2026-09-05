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

Those stages live in `loadModelText` (`@text/index`), which returns the bound
`model` and the element→range table alongside the same `report`; `checkText` is
the wrapper that keeps only the report. Reach for the loader when you want to
work on the model headlessly — the reporting functions in `src/api/analytics.ts`
take a model and, before it existed, could only be handed one by the browser.
`model` is absent when there is nothing to give (the input was refused, or the
pipeline itself failed), so a caller cannot mistake "did not load" for "loaded
and empty". Two separate costs, measured on `examples/uav-isr.sysml`
(2026-09-04): building the parser costs about 1.2 s **once per process**, on the
first load, whatever `library` is set to; binding the standard library costs
about 60-100 ms **per model** and is not amortised, because each model gets its
own copy of the library. So a first load runs about 1.4 s and a later one about
0.12 s, of which roughly 0.1 s is that model's own library binding.

```ts
import { loadModelText } from '@text/index';
const { model, report } = await loadModelText(source, { fileName: 'model.sysml' });
if (model) { /* modelMetrics(model), whereUsed(model, id), … */ }
```

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
| L2 | Syntactic: missing semicolon and brace, extra brace, unknown keyword (with and without a `def` after it), a grammar-legal keyword this tool models no metaclass for, reversed keywords, empty type, bad multiplicity, unfinished unit bracket, a non-ASCII unit symbol written bare, bad expressions, `=` vs `==`, bare `->`, two independent errors | 17 |
| L3 | Referential: unresolved type, connection end, import, transition end, specialization and redefinition; forward references in a package; a type, a specialization or a connector end reached through an import, through inheritance, through a transitive supertype, through an implicit library base or through a library import written in text; an alias used as a type; a name declared in both a supertype and an enclosing namespace, written both ways round; a multi-endpoint dependency naming the endpoint that is missing; plus a pinned behaviour | 23 |
| L4 | Semantic rules **authored as text** rather than built programmatically: duplicate name, blank name, port direction, requirement subject (missing and declared), specialization cycle, self-typed feature, value-type mismatch, dangling `then`, phantom port, connector with one end, unknown unit (in a value and in a constraint body), connection direction and type, signed literal, unit literal in a constraint body, derived-dimension mismatch, dimension clash, temperature difference, compound / qualified / information units | 23 |
| L5 | Recovery and cascade: one bad declaration must not cost the other forty; a nested fault keeps the following declarations in their own bodies; an escaped relationship, an alias body and a hidden multi-line note each stay where they were written | 6 |
| L6 | **Sufficiency invariants over the whole corpus** (see below) | 14 assertions |
| L7 | The command-line contract: exit codes, JSON shape, stdin, strict and `--no-library` modes | 12 tests |
| L9 | **The measurement**: can a model repair the file from the report alone? | `npm run bench` |

Every count in this table is read off the tree, not remembered — the figures
elsewhere that are NOT (the L9 bench results, and §1's account of what was true
before the campaign) are quoted from a dated run file or from history, and say
so where they appear. Measured 2026-09-05: **80 fixture directories** under
`test/fixtures/agent-authoring/` — the L0–L5 rows above sum to it — beside **56
catalogue codes** in `src/text/langium/diagnostic-codes.ts` and **24 validation
rules** in `src/validation/rules.ts`. Reproduce them with
`ls test/fixtures/agent-authoring | wc -l`, `DIAGNOSTIC_CODES.length` and
`RULES.length`.

Those three figures are themselves a test. `test/unit/docs-counts.test.ts`
reads the three figures back out of this paragraph and compares each with the
tree, so a new fixture directory, a new code or a new rule fails the gate until
the number here is updated — and it does the same for every other place a count
is written in words: the rule count in `docs/FEATURE-PARITY.md`,
`docs/TEST-REPORT.md`, the two architecture diagrams and the RECOMPUTE comment in
`src/ui/store.ts`, and the view-kind count in `docs/FEATURE-PARITY.md` against
the `ViewKind` union. It exists because prose is exactly where a measured
number goes stale unnoticed: the older guards pin the CODE, not the sentence.
`test/unit/validation.rules.test.ts` asserts `RULES.length` against a literal in
the test, so a rule cannot be added quietly — but that literal is a second thing
to hand-edit, not a reading of this document. `test/unit/diagnostic-codes.test.ts`
asserts set equality between the catalogue and `DIAGNOSTIC-CODES.md` in both
directions, which pins their AGREEMENT and not their count: a 56th code plus the
`npm run codes` that test tells you to run leaves it green. Only the drift test
above notices that.

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

Second run, after the open-issues pass grew the corpus to 50 fixtures
(`docs/campaign-runs/2026-09-02-repair-bench-2.md`):

| Metric | Value |
|---|---:|
| Fixtures with errors to repair | 24 |
| Repaired to a clean check | 24 |
| Repaired on the first round | 22 |
| Repaired with a minimal edit | 23 |

Still 100%. The two second-round cases are `L0-json-as-sysml`, where the
first attempt is a plausible but incomplete translation of the JSON, and
`L5-nested-fault-rehomes-inner`, where the model first repaired the fault and
only then noticed the declaration it had displaced. Both converge on the
second report, which is the point: the report is enough even when the first
repair is not.

Third run, on the final 80-fixture corpus, against TWO models
(`docs/campaign-runs/2026-09-03-repair-bench-sonnet.md` and
`-haiku.md`):

| Metric | Sonnet | Haiku |
|---|---:|---:|
| Fixtures with errors to repair | 32 | 32 |
| Repaired to a clean check | 31 | 31 |
| Repaired on the first round | 31 | 30 |
| Repaired with a minimal edit | 31 | 31 |

Each model missed ONE case, and a different one: Sonnet did not repair
`L3-unresolved-type`, Haiku did not repair `L2-unknown-keyword`. Both misses
are sampling variance rather than a gap in the report, which was checked rather
than assumed — re-running each missed case three times from the same report
repairs it in most samples (Haiku answers `part def Vehicle;` twice and drops
the keyword entirely once; Sonnet answers `part def Missing; part v : Missing;`
once and `part v;` twice, and BOTH of those check clean, because declaring the
type and dropping it are equally valid repairs of an unresolved reference).
That a case has two right answers is worth stating: the bench counts a repair
only when the file checks clean, never against the fixture's own `fixed.sysml`,
precisely so a model is free to choose either.

The caveat this closes: the two earlier runs used the CLI's default model,
which is the family that built the tool, so they measured whether the report is
sufficient for a near relative. Two independent models at different capability
levels now repair 31 of 32 from the report alone. What is still not measured is
a model from another vendor.

### L6 is the level that matters

The goldens check that the right diagnostic appears. L6
(`test/campaign/invariants.test.ts`) checks something harder: that every finding
the tool emits is *usable*. These are properties, so a new fixture is covered the
moment it is added, and a regression in diagnostic quality fails even when every
golden still matches.

Asserted across every fixture: each finding carries a catalogue code, a source
stage and a non-empty hint; the stage a finding is EMITTED from matches the one
its catalogue entry declares (so a code cannot quietly change hands between the
lexer, the parser and the mapper); every lexer, parser and mapper finding
carries a range; every reported position exists in the file and no range ends
before it starts; every error names a token or an element; every parser error
carries either an expected-token list or a hint; the checker never crashes; `ok`
agrees with the error count; results are deterministic; and every documented
repair checks clean.

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

**Numeric literal form was lost at parse time.** `1500.0` came back as `1500`,
`1e3` as `1000`: `terminal NUMBER returns number` converts before the mapper
runs. The number stays a number in `attrs.value` — the solver, units,
conformance and queries read it as one — and the lexeme rides beside it in
`attrs.valueText`, honoured by the serializer only while it still denotes the
same number, so a later edit cannot resurrect a stale form.

**A derived attribute referenced from a constraint was not evaluated.** The
constraint scope stored values eagerly through a scope-less evaluation, so an
expression-valued attribute evaluated to unknown and was silently omitted from
the scope — "a referenced value is unknown" while the solver computed it fine.
The scope is now lazy and cycle-guarded: values resolve on lookup through the
feature's own owner scope, and a derivation cycle answers unknown rather than
hanging.

**Unit-carrying constraints produced confident wrong verdicts.** The unit-blind
scalar evaluator ran first and compared raw magnitudes, so `640 [Wh]` at
`650 [W]` against `45 [min]` was "violated". The unit-aware evaluator now goes
first; the scalar path remains the fallback for a LITERAL-valued dimensioned
feature compared with a bare literal, which the unit-aware evaluator cannot
judge (a derived feature is never compared that way — see the I1 semantics
entry below). An unknown unit was silently exempt from every dimensional
check; `unknown-unit` now names it. `Wh` and `Ah` joined the registry
(prefixable, so kWh and mAh come free).

**Connection compatibility was unchecked.** `connect battery.powerOut to
flightComputer.motorOut` (out to out) and a PowerPort wired to a DataPort both
passed silently; the only port rule checked that a direction was declared. The
new `connection-compatibility` rule (warning: SysML v2 does not forbid it at the
language level, and `--strict` promotes it) anchors on the connector, because
connector ends are implicit per-usage port copies and `validate()` drops any
finding anchored on an implicit element. It compares PortDefinition closures
and flags only when they share nothing, so a specialised port definition still
matches its ancestor and `T` against `~T` is never flagged. Fixtures:
`L4-connection-direction`, `L4-connection-type`.

**The phantom port and the hint that taught it.** `port in a : Pt;` parsed as
two members, a bare `port` and a keyword-less `in a : Pt`, producing a nameless
PortUsage per directed port with no diagnostic, and the port-direction hint
recommended exactly that spelling. The grammar now admits a direction after the
keyword, the hint teaches the canonical `in port`, and a `split-declaration`
warning names the residual keyword-only forms. Fixture: `L4-phantom-port`.

**Recovery re-homed declarations after a fault.** Every declaration after a
syntax fault was parsed one scope out, and a fault two levels deep escaped
twice; the elements survived but their containment did not. A post-parse pass
now re-homes each ranged declaration under the element that opened its
enclosing brace, declining on an unbalanced file rather than guessing, and runs
before the deferred reference pass so references that failed only through wrong
ownership resolve normally. Fixture: `L5-nested-fault-rehomes-inner`.

**Re-homing moved the wrong things, and a faulted save laundered itself clean.**
Three defects, all in the same pass, all invisible from the diagnostics. (a)
The candidate filter dropped every RELATIONSHIP, so an `import`, `alias`,
`dependency` or forward-source `subset` that recovery pushed out of its package
was never brought back: it became a root and the file serialized with
`import Q::*;` AFTER the closing brace of the package it scopes, silently
changing name resolution for everything inside. The same filter left an
`alias b for a { … }` body — mapped under a Membership — with no eligible
opener, so its members were re-homed onto the previous SIBLING. Relationships
are candidates and openers now, except one owned by its own source (an inline
`part def X :> Y { … }`), which shares its owner's start offset and would
otherwise steal the body it is written on. (b) The brace scan read the hidden
note terminal (slash-slash-star … star-slash, which spans LINES) as a plain
line comment, so it swallowed only the note's first line and counted braces on
the rest as real: two notes contributing one brace each made a faulted file
balanced BY COINCIDENCE and produced a phantom body. Both scanners now follow
the lexer on notes and comments, including its rule that an UNTERMINATED opener
is just a line comment on valid text — which matters twice over for the
pre-lex scan, because its finding REPLACES the whole parse, so a false
"unterminated string" on an apostrophe in the author's prose suppressed every
real diagnostic in the file. (c) `blok def Vehicle;` round-tripped to
`Vehicle;` plus a dangling `blok` — a file that re-parses CLEAN, so the
corruption was undetectable afterwards. The `Body` rule swallows an unknown
keyword as its trailing expression; the faulty declaration now keeps its own
source text (`attrs.unparsedText`), which the serializer re-emits verbatim and
alone, and the swallowed word is taken off the parent at the same moment. A
faulted save now reproduces its fault. Four guards keep that from costing more
than it saves: the file must be brace-balanced, the carrier must sit in the
same brace body as the fault with no `;` or `}` between them (otherwise the
mark swallowed the healthy declaration that merely came next, and froze its
whole subtree behind a verbatim string), the carrier must be something the
serializer writes as a statement of its own (a specialization is rendered
INLINE on its source's line, so marking one dropped the text silently), and the
slice must itself be brace-balanced. The same treatment keeps the twenty-one grammar-legal KerML keywords
this tool models no metaclass for (`namespace`, `class`, `feature`, `step`, …),
which used to be DROPPED with their whole body under a code the parser also
emitted — they have their own code now, `mapper/unsupported-keyword`, and an
L6 property asserts every emitted `source` matches its catalogue entry. An
element carrying its own unparsed source is exempt from
`validation/split-declaration`: an anonymous one (`namespace { … }`) has no
name, type, value or body of its own, which is exactly that rule's shape, and
the second finding pointed at a completely different repair.
Fixtures: `L5-relationship-after-fault`, `L5-alias-body-after-fault`,
`L5-note-braces-after-fault`, `L2-unknown-keyword-no-def`,
`L2-unsupported-kerml-keyword`.

**A misspelled keyword with no `def` after it was reported as a missing brace.**
`blok def Vehicle;` named the unknown word (the parser stops on the `def`), but
`blok q : Real;` fell back to "Expecting `}` but found `q`", whose repair makes
the file worse. The refinement now asks the LEXER what it read: two identifier
tokens in a row, the first of them being the whole first WORD of the line, is
an unknown declaration keyword. Taking the token KINDS from the lexer rather
than guessing from the spelling is what keeps a keyword out of the rule; the
line test is what keeps a missing semicolon (`part a` / `part b;`) and the tail
of a qualified name (`A::B c;`) out. "Whole word" is load-bearing: a raw prefix
test also matched `Mass::M m;`, where the tail segment `M` happens to spell the
start of `Mass`, and reported the author's own type name as a misspelled
keyword — the qualified-name case only looked safe because the first examples
were alphabetically lucky. Two bare words with nothing else to go on (`x y;`)
ARE reported as an unknown keyword naming the first: the tool cannot tell a
misspelled keyword from a stray identifier, and the alternative reading
("expecting `}`, insert a brace") is the advice this refinement exists to stop
giving. Fixture: `L2-unknown-keyword-no-def`.

**A failed apply overwrote the user's text a few hundred milliseconds later.**
`refreshAfterLibraryLoad` re-serialized the model into the Text tab after the
standard-library merge settled. For a file with a syntax error that replaced
what the user typed with the partial model recovery made of it, in a refresh
with no undo of its own. It now leaves the buffer alone (and marks it dirty,
because the model genuinely was not regenerated from it) whenever a parse
finding of severity `error` is standing; warnings do not count, or a forward
reference would freeze the buffer forever.

**`-2.50` was stored as a string.** The NUMBER terminal is unsigned and the
sign is a unary operator, so a signed literal reached the mapper as an
expression and stayed the verbatim text `"-2.50"` while `2.50` became the
number 2.5. The earlier record claimed every consumer handled both forms; the
numeric ones did (they re-parse strings), but the query engine did not —
`attrs.value = -2.5` found nothing — and the exported JSON carried a string
where the unsigned case carried a number. The mapper now folds a sign written
directly on a bare number to the number and keeps the author's lexeme beside
it in `valueText`, exactly as for `1500.0`; the export type therefore flips
from string to number for signed literals, which is the intended contract.
Query equality also accepts two operands that denote the same number, so a
query persisted as `'-2.50'` keeps matching. Fixture: `L4-signed-literal`.

**A `[unit]` literal could not be written inside a constraint body.**
`require constraint { uav.mtow <= 25.0 [kg] }` was a parse error. The grammar
had no bracket production inside expressions: the only unit it read was a
pseudo-multiplicity trailing a feature value, a local device that does not
exist in the standard (KerML's ValuePart carries no multiplicity). `[` is now
what the KerML textual BNF says it is — the BracketExpression postfix, an
invocation of `BaseFunctions::'['` whose quantity overload
`QuantityCalculations::'['` is how SysML v2 spells a quantity literal — so
`25.0 [kg]`, `48 [h]`, `5 [SI::kg]`, `18 ['in']`, `max(1 [m], 2 [m])` parse
wherever an expression may appear, and units on `assign`, `return` and `entry`
values become readable (the serializer already wrote them; `entry e = 5` had
also been losing its value in the mapper). The model contract is unchanged: a
bracket at the top of a feature value still folds to a numeric `attrs.value`
plus `attrs.unit`, a signed magnitude (`-5 [m]`) folds under the same bare-number
guard as a signed literal, and a bracket deeper in the expression
(`229835/900 [K]`) stays verbatim text — it binds tighter than `/`, the
grouping the pilot's own XMI records. Two consequences that were hidden before:
the serializer now quotes a unit the grammar cannot read bare (`[SI::'watt hour']`,
`['m²']`, `['in']` — the raw `[SI::watt hour]` it used to emit did not parse
back), and a bracket holding a character the lexer skips (`[m²]`, previously
read as `[m]`) keeps its source spelling in `attrs.unit` beside the lexer
error, rather than persisting a silently different dimension. `derive` became a
soft keyword in the same grammar pass, which closes the one library file
(`RequirementDerivation.sysml`) the corpus harness had been failing on: 94 of
94 library files parse, and the wider release corpus went from 265 to 279 of
405 files. Parser construction measured 0.8 s before and 1.2 s after. The
recovery edge came with it: an unfinished bracket (`= 5 []`, `= 5 [;`,
`= 5 [initial]`) leaves the parser's operand unset, and a first cut of the
mapper dereferenced it — the checker turned that into `import/internal-error`
with zero elements, the whole file lost for one mid-edit unit. It is one
positioned parse error now, the value is kept without a unit, and the
neighbouring declarations survive. Fixtures: `L4-unit-literal-in-constraint`,
`L2-empty-unit-bracket`; the grammar shapes and the round-trips are pinned by
`langium.grammar.test.ts` and `text.bracket-expr.test.ts`.

**A derived feature was invisible to the unit-aware evaluator, and making it
visible would have produced a confident wrong answer.** The quantity scope only
read literal magnitudes, so `uav.endurance >= 45.0 [min]` on an
expression-valued `endurance` answered unknown with the scalar parser's
"Unexpected character '['" — the intended syntax reported as illegal. The
quantity scope is now lazy, like the scalar one: a feature whose value is an
expression is evaluated on demand in its owner's quantity scope, carrying its
dimension (640 Wh × 0.8 / 650 W = 2835.7 s, T), with a cycle answering unknown.
The trap this opens was measured before it was closed: the old example's
`enduranceMin : Real = … / cruisePower * 60.0` derives to 170 141 s — the
hand-rolled minutes read as seconds — and against `100.0 [min]` (6000 s) the
engine answers SATISFIED while the author's 47.3 min is violated; the false
band runs from 47.3 to ~2836 min. So a derived feature carries a *dimension
claim*: when its derived dimension disagrees with its declared type — a
`Real`/`Integer` derived from dimensioned quantities, or an ISQ kind whose
derivation has another dimension (a user `attribute def :> ISQ::MassValue`
walks to its kind first) — it is EXCLUDED from every quantity scope, the
constraint answers unknown naming the feature, and the new
`derived-dimension-mismatch` warning says why and how to repair it (retype to
the kind and drop the conversion, or give the inlined constant its unit:
`mtow / 25.0 [kg]`). Three smaller honesty fixes came with it. The unit-aware
engine compared SI values exactly, so `1 [ft] == 12 [in]` was violated by float
noise in the registry factors and a Newton-solved `x * x == 2` would have
flipped; comparisons now use `|a − b| ≤ max(absTol, 1e-9·max(|a|, |b|))` with
the absolute part supplied by the caller — and two values within that
tolerance are EQUAL for every relational operator, the strict ones included:
`0.9999999999 < 1.0` holds, `a != b` at 1e-10 apart is violated. The numeric
surface shares that reading (`violated = g > tol`) for `<=`, `>=` and the
equalities, so the two surfaces cannot disagree on float noise; where this
evaluator DECLINES and both fall back to raw magnitudes, a strict `<`/`>` is
read exactly on both instead (see the known limitation on that tie below).
°C and °F are affine scales, and the
affine map turned a 15 °C *interval* into 288.15 K, so `t2 - t1 <= 5.0 [°C]`
answered SATISFIED (10 K ≤ 278.15 K); any `+ − == !=` touching an offset unit,
or a derived feature computed from one, now answers unknown with the reason,
while ordering two absolutes (`t2 >= 300 [K]`) still converts — a plain
reference (`t3 : TemperatureValue = t1`) is the same point on the scale and
keeps ordering — and the scalar path is refused for those relations too, since
raw °C magnitudes are right only while every value shares the scale. And
`unknown-unit` read only `attrs.unit`, so `{ m <= 25 [furlong] }` warned
nothing; it now scans constraint bodies, transition guards and expression
values (KerML's note 2 on BracketExpression asks a tool to warn when `[` has
no concrete definition) — outside string literals, whose brackets are text
(`"R-UAV-001 [rev A]"` is not a unit) — a qualified unit (`[SI::kg]`)
resolves by its last segment, and a unit beside an expression value
(`(1 + 2) [m]`) attaches to a dimensionless result instead of being
misreported as unknown. A fault INSIDE a derivation names both the feature
and the fault (`"uav.total" cannot be derived: M and 1 are different physical
dimensions`), a boolean feature is a boolean in a body (`armed and mtow <=
25.0 [kg]`), and a body that mixes a unit literal with a call or a string says
so instead of blaming the bracket. `examples/uav-isr.sysml` states its units:
`endurance : ISQ::DurationValue = capacity * fraction / power` against
`>= 45.0 [min]`, and `mtow <= 25.0 [kg]`; the old shape trips the new warning,
which is why the example moved. Fixtures: `L4-unknown-unit-in-constraint`,
`L4-derived-dimension-mismatch`, `L4-temperature-difference`; the trap, the
tolerance and the offset cases are pinned by `semantics.units-eval.test.ts`
and `semantics.derived-scope.test.ts`.

Two behaviours pinned with it. A **derived dimensioned feature is never
compared as a raw magnitude**: the bare-literal contract (`mtow <= 25.0` reads
the literal in the feature's declared unit) holds for literal-valued features
only; `endurance >= 45.0` on the derived duration answers unknown with the
repair (a unit literal of dimension T — `45.0 [s]` or `45.0 [min]`; an
untyped ratio such as `r2 = mtow / 25.0` is pointed at `mtow / 25.0 [kg]`
instead), because 640 × 0.8 / 650 = 0.7877 read raw is a confident wrong
"violated" on both surfaces. And **offset-unit arithmetic answers
unknown**: temperature-interval (delta) semantics — a difference of two
absolutes being an interval that converts as 1 °C = 1 K — are recorded as
future work rather than approximated.

**A comparison of two different physical dimensions was judged by its raw
magnitudes.** `require constraint { d >= t }` with `d : ISQ::LengthValue =
5.0 [m]` and `t : ISQ::DurationValue = 2.0 [s]` answered SATISFIED — and
`m >= d` (a mass against a length) answered violated — on BOTH surfaces, so the
cross-surface agreement built above agreed on a wrong answer. The unit-aware
evaluator refused each of them correctly, but its refusal carried the same
reason tag as the bare-literal contract (`mtow [kg] <= 25.0` refuses with
`M and 1 are different physical dimensions`), which the scalar path is entitled
to fill — so it filled this one too and compared 5 with 2. The two differ in
exactly one way: in the contract, one operand is DIMENSIONLESS. A dimensional
fault with NO dimensionless side is now its own reason — `dimension-clash` for
two different dimensions where they had to match, `dimension-fault` for a
dimensioned exponent (`d ^ t`) or a `[unit]` applied to an operand that already
carries one (`(mtow * 2.0) [kg]`) — and `isRefusalReason` in
`src/semantics/units-eval.ts` is the single place that says which reasons a
unit-blind evaluator may NOT fill. The message names both dimensions: `M and L
are different physical dimensions — no conversion relates them, so the
comparison cannot be judged`.

Every surface honours it, because a refusal on three surfaces out of four is
just a different disagreement:

- `checkConstraints` and `checkConstraintsNumeric` answer `unknown`;
- the SIMULATOR (`SimSample.constraints`) answers `unknown` too — it evaluated
  scalar-only and reported `satisfied` for exactly what the other two refused,
  so it now asks the unit-aware evaluator first, handing it the live value
  store and the parametric solve as quantities (a state machine's constraint
  reaches its context's attributes no other way);
- the SOLVER drops such a relation from the equation/inequality sets entirely,
  rather than merely leaving it unscaled. Gate (c) already declined to SI-scale
  it, but `solveFeasible` and `optimize` read the residual with no unit-aware
  verdict in front of them, so they published `feasible: false` with a
  violation of 2995 (5 km − 3000 s) for a model `analysisReport` calls
  feasible, and drove a free LENGTH to satisfy a bound in SECONDS.

The refusal also wins from either side of an `and`/`or`: returning the leftmost
unknown made the verdict turn on operand ORDER, so `mass <= 25.0 and mass <=
massLimit` was answered SATISFIED from raw magnitudes with no diagnostic while
the same two conjuncts swapped were refused. `==` and `!=` are refused as well;
they were the last comparison operators still answering the question (`d == t`
confidently violated, `d != t` confidently satisfied, and a zero-amount
"violation" on the analysis report).

The bare-literal contract is unchanged — it is the ONLY dimensional reason a
scalar fallback may still fill — and a comparison of the same dimension in
different units (`d >= 4000.0 [mm]`) still converts and answers, as does
`n : Real = 5.0` against `5.0 [km]` (violated, definitively, on both surfaces).
Fixture: `L4-dimension-clash`; pinned by `semantics.derived-scope.test.ts`,
`semantics.units-eval.test.ts` and `semantics.solver-units.test.ts`.

**Only a bare or prefixed registry symbol resolved as a unit.** `[m/s]`,
`['W⋅h']`, `[m^2]`, `[SI::metre]` and `[SI::'watt hour']` each warned
`unknown-unit` and left the value read as a bare number, and no information
unit existed at all. `resolveUnit` in `src/semantics/units.ts` is now the
single **model-free** funnel every unit string in the tool goes through — value
units, `[unit]` literals in bodies, FMI `unit=` attributes, the SDK. In order:
unquote each `::` segment and look the whole name up in the INVERTED
library-name map (`SI::'watt hour'` → Wh), else carry the last segment; a
registry name or symbol with one prefix (exact symbols still win, so `min` is
the minute and `Wh` the watt hour); the worded forms the library uses
(`per` → `/`, `squared` → `^2`, `cubed` → `^3`, adjacent words a
product, so `metre per second` resolves); then a unit EXPRESSION over `*`,
`⋅` (U+22C5, the library's own separator), `·`, `/`, `^`, integer and
superscript exponents and parentheses — `kg*m/s^2`, `J/(kg⋅K)`,
`kg⋅m²⋅s⁻³⋅A⁻¹`. A qualifier belongs to the ATOM it
prefixes, not to the whole string, so `[m/SI::s]` and `[km/SI::h]` are speeds
(cutting the whole reference at its last `::` would read them as `s` and `h`);
the identity is the one number an expression may name, so `[1/s]` is the ASCII
`s⁻¹` while `[2/s]` is not a unit. An affine atom is
refused (`°C⋅m` has no meaning without an origin), and a bare number resolves
to nothing — `= 5.0 [2]` and `= 5.0 [1..2]` are reported as unknown units
rather than read as a quantity or silently taken for a count.
`units-eval.ts` lost its private
copy of the resolver and imports the funnel, so validation, analytics, the
solver, FMI and the UI all answer the same way.

A **library-backed** fallback was considered and rejected: the bundled
library's short-name index is first-writer-wins across every element, so `h`
there is a `height` feature and `J`/`N`/`T`/`L` are ISQ quantity letters — a
post-hoc filter can only turn a wrong hit into nothing, never recover the
masked unit. Resolving from the registry alone gives the same answer under the
full bundle, the curated fallback and `library: 'none'`. The honest cost is
recorded: a long library name beyond per/squared/cubed (`kilogram metre squared
second to the power minus 3 ampere to the power minus 1`) does not resolve, and
the `unknown-unit` hint teaches the symbol form.

**Information had no units and no quantity kinds.** `bit`, `byte` `<B>`,
`octet` `<o>`, `shannon` `<Sh>`, `hartley` `<Hart>`, `nat`, `baud` `<Bd>` and
`erlang` `<E>` joined the registry with factors authored from the ISO 80000-13
definitions (1 B ≡ 8 bit, 1 Hart ≡ log₂10 Sh, 1 nat ≡ 1/ln2
Sh), and the binary prefixes Ki..Yi joined as a SEPARATE family that attaches
only to bit, byte and octet — `MiB` is 2²⁰ bytes, `Mim` and `KiSh` are
nothing, and the twenty decimal prefixes are untouched. Of those twenty, an
information unit takes the MAGNIFYING ones only: `kB` and `Gbit` resolve,
`mbit` does not, and — the reason the policy exists — `dB` does not either.
The decibel is a logarithmic ratio, not a linear unit; deci + byte would have
exported 20 dB as `<BaseUnit factor="0.8"/>` and told an importer it was 16,
so `[dB]` stays an honest `unknown-unit`. The ISQInformation
quantity kinds joined the kind table **as the bundled library types them**,
read off its own unit definitions rather than invented: nine rate kinds whose
unit is a `DerivedUnit` with a duration power factor (T⁻¹), nineteen
content/entropy/traffic kinds whose unit subclasses `DimensionOneUnit`
(dimension one), and seven kinds the bundle gives no unit definition at all,
dimensionless by a choice that is documented as a choice. The nine
`ISQInformation` alias `…Value` names (`BitRateValue`, `StorageSizeValue`,
`LineDigitRateValue`, …) are keys in their own right, because under
`library: 'none'` there is no alias membership to dereference.

The **visible cost of being faithful**: information content is dimension one,
so `bit/s` and `Hz` are the same dimension (T⁻¹) and a bit rate
compared with a frequency is dimensionally consistent. An eighth axis would
separate them, at the price of diverging from the standard we bundle and from
FMI's `<BaseUnit>`, which has no information exponent. The kind, not the
dimension, carries the meaning; `dimensional-consistency` still catches
`5.0 [kg]` on a bit rate. `examples/uav-isr.sysml` now writes
`dataRate : ISQ::BinaryDigitRateValue = 100.0 [Mbit/s]` where it carried a
plain `rateMbps : Real`. Fixtures: `L4-compound-unit`, `L4-information-rate`,
`L4-qualified-unit`, `L2-unicode-unit-symbol`; the table, the inverted-map
round-trip and the refusals are pinned by `semantics.units.test.ts`.

**FMI exported a non-coherent unit as if it were coherent.** `<BaseUnit>`
carried only the SI base exponents, so `640 [Wh]` was written as a
kg·m²·s⁻² unit with no factor — an importer read
640 joules — and `km`, `min` and `°C` were wrong the same way. The
export now emits the `factor` and `offset` of the unit's affine map to SI, and
a dimension-one information unit exports with no base exponents but with its
factor (`<BaseUnit factor="8"/>` for the byte). Pinned by
`fmi-export.test.ts`.

**The numeric surface judged without units — three ways at once.** `solve()`
was a scalar fixpoint over raw magnitudes, so one model had two contradictory
verdicts and one wrong set of numbers. Three probes, each reproduced from
parsed text against the full library: (1) `640 [Wh]` at `650 [W]` against
`45 [min]` — the Problems panel said satisfied, the Solve button said violated
by 44.0; likewise `640 [Wh]` vs `3 [MJ]` (by 637) and `5 [km]` vs `4000 [m]`
(by 3995), each with `analysisReport.feasible` false on the bogus amount.
(2) `total == leg1 + leg2` with 5 km and 400 m solved to **405**, `converged:
true`, and `evaluateMoEs` reported 405 with no unit — the solved VALUE was
wrong, not merely its verdict, and the Simulation tab plotted it. (3) a body
carrying a `[unit]` literal — `mass <= 2000 [kg]` — threw in the scalar parser
and was **silently absent** from `checkConstraintsNumeric` and from
feasibility: a constraint that disappears reads as one that holds.

A relation is now judged in SI, per relation, behind four gates — each of which
exists because scaling past it produces a confident WRONG number: every
variable must resolve to a storage scale (a known unit, a declared ISQ kind, or
a derived dimension); a variable on an offset scale is scaled like any other,
because the affine map is MONOTONE and an ORDERING may therefore be judged in
kelvin — arithmetic on one may not, and that is a refusal that drops the whole
relation (below); the two
operands of every comparison, `==`, `+` and `-` must carry the SAME DIMENSION —
which refuses two distinct wrongs with one predicate, the declared-unit contract
(`range = 5.0 [km]` against `<= 10.0` still reads the literal in kilometres, on
both surfaces — SI-scaling it would turn a satisfied constraint into
`5000 <= 10`) and the mismatch (`v.d >= v.t`, a length against a duration, is a
question no scaling can answer: SI-scaling it reported `5000 >= 3000` satisfied
where the declared magnitudes read `5 >= 3000` — since the `dimension-clash`
finding above, such a relation is not merely left unscaled but dropped from the
relation set, and every surface refuses it); and no variable
may carry a `mismatch`
dimension claim, which is what keeps the factor-60 hand conversion out of the
solver (`Real = capacity * fraction / power * 60.0` would otherwise solve to
170 141 s). `[unit]` literals in a body — and in an assignment value, `= 2 * 3
[kg]` — are lowered to SI magnitudes before parsing, so the body is judged
instead of dropped; a unit the registry cannot resolve makes the relation
`unknown`, never absent.

**Values stay in storage units.** `SolveResult.values`, `SolveOptions.fixed`
and `OptimizeOptions.bounds` keep their published meaning — plain numbers in
each feature's declared unit — and the SI conversion happens at the point of
use, with the result of solving FOR an unknown converted back (5 km + 400 m is
5400 in a unit-less `LengthValue`, 5.4 in one declaring `[km]`). SI by
convention is the rule for a feature that declares a quantity kind but no unit,
which is the same reading the unit-aware evaluator gives it; `evaluateMoEs`
now labels such a value with the coherent SI symbol (`siSymbolOf`), so the
number and the unit cannot contradict each other, and `bind a = b` converts
into the target's storage unit instead of copying the magnitude. Both labels
are claimed only where they are true: a measure computed by a relation the
gates REFUSED to scale stays unlabelled (its 405 is neither metres nor
furlongs), and a dimension the registry gives several coherent units — T⁻¹ is
`Hz`, `Bd`, and every bit rate — is labelled in composed base units (`s⁻¹`)
rather than by whichever row comes first. A binding across an OFFSET scale
CONVERTS, like every other binding: `bind a = measureT` with `a = 20 ['°C']`
fills a kelvin-storage `measureT` with 293.15, and the equation it stands for is
read in SI on both sides, so it still converges at a residual of zero.

**Tolerance is the part that had to be decided twice.** The numeric verdict now
comes FIRST from the unit-aware evaluator (with the solved values as a
last-resort scope, so an unknown an equality pins down still resolves); the
residual supplies slack and amount, in SI with a `slackUnit`, and is the verdict
only where the unit-aware answer is ignorance rather than refusal — an offset
scale or a dimension mismatch stays `unknown` on both surfaces. Every relation
yields a row, including one whose body carries no residual at all (`a > 1.0 and
b > 2.0`, reported with `kind: 'boolean'`): a constraint that disappears from
the list reads as one that holds.

The caller's absolute tolerance is passed only for a relation judged in raw
magnitudes: in SI, `1e-6` is a metre-or-second-sized constant with no relation
to the model, and it made `5 [ns] == 3 [ns]` satisfied. A SCALED relation is
judged, and SOLVED, relative to its own SI magnitude throughout — the
convergence gate, the Newton/bisection acceptance and step tests, the
finite-difference probe, the row/column equilibration of the coupled Newton
system, and the feasibility gate (the historical `1e-6` made relative). Each
absolute constant left in place broke the seam from one side or the other: a
nanosecond system converged vacuously on a 2e-9 residual, a millisecond system
stopped four decimal places short of its root and was then flagged violated by
the (relative) unit-aware verdict, a nanometre system stalled 25× away from its
root, and an ordinary second-scale model was called INFEASIBLE over a 4e-7
overshoot it had always tolerated. Pinned by `semantics.solver-units.test.ts`
(numbers, not verdicts: solved values, slack + unit, convergence, feasibility)
and `uav-example.test.ts`, which runs the shipped example through both
surfaces.

**Five ways a unit was still dropped between the two surfaces.** Each was
reproduced twice from parsed text before it was touched. (1) An OFFSET-scale
feature was refused a scaling and then LEFT in the relation set, so
`checkConstraintsNumeric` read its verdict from the unit-aware evaluator and
answered right while `solveFeasible` and `optimize` read the same residual raw
and answered `100 >= 350` — infeasible for 100 °C against 350 K, which holds,
and feasible for 30 °C against 300 K, which does not. The affine map is
monotone, so an ORDERING is now SCALED and judged in kelvin (its slack reads
23.15 K, not −250); arithmetic on an absolute — `+`, `-`, `==`, `!=`, a product,
an exponent — is a REFUSAL that drops the relation from the equation and
inequality sets, the way a dimension clash does, so nothing may drive a value
from a question the unit-aware evaluator declines. (2) A BINDING across an
offset scale copied the raw magnitude into a kelvin-storage feature, and the
numeric surface then answered `measureT <= 273.15 [K]` "satisfied, 253.15 K of
slack" while validation said `unknown` — no second opinion anywhere. A binding
is an identity of physical values and publishes no verdict, so it converts:
20 °C arrives as 293.15 K, the constraint reads violated by 20 K, and the
binding equation, being SI on both sides, still converges at zero.
(3) DIMENSION ONE is not "unitless". The ISO 80000-13 information units are
dimension one and still carry a factor (a byte is 8 bit, a KiB 8192), so a gate
asking "is this DIMENSIONED?" skipped them: `constraint { need == cap }`, with
`cap = 2.0 [B]` and a `need` declaring `[bit]`, solved `need` to 2 and published
"violated by 0". The gate asks whether there is anything to CONVERT — a
dimension, a factor, or an origin — and the binding path, which had the same
predicate, converts with it.
(4) The numeric surface applied its ±1e-6 to `<` exactly as to `<=`, so
`mass < 25.0` at 25 kg — a bare literal, where both surfaces fall back to the
declared magnitudes — was `satisfied` here and `violated` there. A strict
ordering has no slack at its boundary, and the fallback now reads the operator
as `evaluate` in `src/semantics/expr.ts` reads it; `<=`, `>=` and equalities keep
the tolerance that absorbs a solved value's float noise. (5) `expr [unit]`
guarded re-dimensioning on the operand's DIMENSION, one predicate weaker than
the property it names, so `cap [bit]` on a byte value passed, was rebuilt from
the raw magnitude 2, and answered `cap [bit] <= 8.0 [bit]` a confident
SATISFIED where 2 B is 16 bit. The guard is the operand's UNIT, with its own
sentence for the dimension-one case. Pinned by
`semantics.solver-units.test.ts` and `semantics.units-eval.test.ts`.

**Each of those five fixes had a SECOND site that had to move with it.** A
refused relation is dropped from the equation set, which is also how it leaves
the sight of the set that tracks unit-blind values — so a measure of
effectiveness took its number from the raw-magnitude fallback and was stamped
with the coherent SI unit anyway, publishing a 20 °C magnitude as `20 [K]`. The
label is now claimed only for a value the SOLVER produced, which is what its
own doc always said. A feature value that is a BARE REFERENCE
(`attribute t3 : TemperatureValue = t1`) states an identity exactly as a `bind`
does and publishes no verdict, so it converts too (293.15 K) instead of
vanishing from the solved values with nothing saying why; arithmetic on an
absolute stays refused. Widening the scaling gate to count a FACTOR made the
solver scale a `[B]` feature against a kind-less `Real` while the binding
propagation still copied its magnitude, and the two writing 16 and 2 into one
variable reported a converged model as NOT CONVERGED — both sites now read a
kind-less feature as dimension one with a factor of 1, which is how the
unit-aware evaluator reads it (`r : Real = 2.0` against `2 [B]` is violated on
both surfaces, and `= 16.0` satisfied). And strictness could not live on the
check surface alone: `solveFeasible` and `optimize` read the same residuals with
no verdict in front of them, so one predicate now owns the rule for all three,
consulting the unit-aware evaluator to know which reading a relation is under.

**One resolver, and declaration order stopped deciding what a name means.**
Two resolvers used to own different halves of reference binding. The textual
mapper resolved BACKWARD references while it walked the AST, with an owned-only
scope walk; the library binder resolved the FORWARD ones afterwards with the
spec's rule (per namespace: owned, inherited, imported members, then outward).
Whichever ran first won, and they disagreed — so in `part def Car :> Base { part
w1 : W; }` with a `W` in both `Base` and the enclosing package, `w1` was typed
by the OUTER `W` when that was declared first and by the inherited one when it
was declared last. The same text, two models. KerML v1.0 §8.2.3.5.3 settles it:
an inherited Membership IS the local resolution, so the inherited answer is
right in both orders.

`parseModel` now records every reference as a NAME and resolves them all at one
point, after the whole file is mapped, with the shared `resolveFullName`
(`src/semantics/bind.ts`). Eight things follow, each with a fixture:

1. `L3-inherited-shadows-outer-backward` / `-forward` — the witness itself,
   written both ways round, answering `P::Base::W` in both.
2. `L3-transitive-supertype-shadow` — the specialization family is bound to a
   FIXPOINT before any typing is decided, and a reference whose scope chain
   gains a general in a later round is re-decided, so `Car :> Base :> Grand`
   reaches `Grand`'s member even though `Base :> Grand` was itself forward.
3. `L3-specialize-via-inheritance` and `L3-specialize-via-import` — only `:`
   typings were ever re-resolved after the parse, so a `:>` whose target was
   inherited or imported reported an error on a valid model, forever.
4. `L3-redefine-inherited` — KerML §8.2.3.5.1 gives a redefinition its own rule
   (the generals of the owning type first). `part w :>> w;` used to build a
   Redefinition from a feature to ITSELF.
5. `L3-unresolved-redefinition` — the mirror of (4): `unresolved-type-ref`
   resolves from the element's own scope now, and no longer accepts a library
   FEATURE matched by last segment, so a dangling `:>> w` stops being masked by
   the library's `VectorFunctions::+::w`.
6. `L3-alias-as-type` — aliases are bound before anything resolves through them,
   so `part p : A;` reaches what `alias A for Real2;` names instead of the alias
   relationship itself.
7. `L3-forward-specialization-strict` — warnings are emitted AFTER resolution,
   so a forward `:>` or `alias` no longer leaves a stale "Unresolved reference"
   that made `--strict` fail a valid file. `L3-unresolved-specialization` is the
   negative control: an absent target still warns.
8. `L3-connect-inherited-end` — a connector end takes the inherited feature over
   an outer one of the same name. `L3-connect-imported-end` is its counterpart:
   an end reached through `import Lib::*;` binds to the imported feature
   DIRECTLY. Mirroring exists to stop every usage of one definition sharing a
   type-owned endpoint; a package inherits nothing, so there is no prototype to
   mirror there, and mirroring one fabricated an implicit feature and bound the
   connector to the tool's own invention.
9. `L3-dependency-end-missing` — a multi-endpoint `dependency a, MissingX to b;`
   names the endpoint that is actually missing. The warning is deferred until
   the fixpoint has run, and several endpoint names share one `sourceRef` slot,
   so deciding survival from the slot reported the endpoint that RESOLVED.
10. `L4-self-typed-feature` — `timeslice asPresident : Person;` inside `Person`
   is ordinary input once a `:>> p` binds, and the value-scope name collectors
   walked its unbounded `asPresident.asPresident…` tower until the stack died,
   losing every validation finding behind an `import/internal-error`.

Fixture goldens compare diagnostics, `ok` and the element/root invariants; they
do not assert WHICH element a name bound to, so the shadowing cases above are
pinned at that level by `text.resolution.test.ts` rather than by the campaign.

In-file `import Lib::*;` is bound inside the parse, library-free, so
`--no-library` stopped being a second-class mode (pinned in `cli.test.ts`), and
the serializer's `refTo` asks the same resolver — under the SAME rule the
re-parse will use, which for a `:>>` is §8.2.3.5.1 and not full resolution, or
the shorter spelling would silently retarget the Redefinition on the next load.
So a binding reached by import or inheritance re-emits as the simple name the
author wrote (`part w : Widget;`, not `part w : Lib::Widget;`; `part w :>> w;`,
not `part w :>> P::Base::w;`). The UI keeps the last parse result and retracts
the warnings the library binder resolved, so the Problems panel and `checkText`
finally agree — and forgets it on every path that replaces the model without
parsing text, or a load or branch switch resurrected the previous document's
rows. Pinned by `semantics.bind.test.ts`, `text.resolution.test.ts` and
`store.library-refresh.test.ts`. The performance cases in
`text.resolution.test.ts` are gross-blowup canaries only: they do not isolate
the re-decision gate, and say so.

Two consequences at corpus scale, both recorded rather than discovered later.
Refusing a library FEATURE as the answer to `unresolved-type-ref` (item 5) is
what unmasks a dangling `:>> w`, and on its own it also turned every
redefinition of an inherited feature into an error whenever the owning type's
own supertype was unresolvable — 2 155 → 4 882 errors over a 309-file corpus,
348 of them in one library file. The rule is silent now when a scope the
reference resolves through still carries a general nobody could bind: with an
incomplete supertype the tool has no basis for calling the redefinition
dangling, and the unresolved GENERAL is the finding worth reading. And a
connector end may now name a feature of an IMPLICIT library base
(`L3-connect-implicit-library-base`): a bare `part def` specialises
`Parts::Part` and friends, so `self`, `start`, `done`, `shape`, `subparts` are
inherited members that the one resolver finds like any other. That is pinned,
not fixed — it does mean a typo colliding with one of those names is no longer
caught by `--strict`, but making the connector resolver alone ignore implicit
bases would put it back out of step with every other resolver, which is the
split this commit exists to end.

**Piping a model into the checker warned about a file it never came from.**
`cat model.sysml | npm run check -- -` passed `<stdin>` as the FILE NAME, so it
failed the extension test and every piped run emitted `import/wrong-extension`:
a warning naming a file that does not exist, carrying a hint (rename it to
`.sysml`) that cannot be followed, and under `--strict` a failing exit code on a
model with nothing wrong with it. A name and a label are now separate arguments
— `fileName` is a file and is extension-checked, `displayName` is only what the
report is labelled with — and piped input carries the label alone. Pinned in
`test/campaign/cli.test.ts` (a clean model piped in exits 0, with no warning and
still labelled `<stdin>`) and in `test/unit/text.load.test.ts`, where a real
`model.txt.bak` must still warn, so the fix cannot decay into deleting the
check.

**Three reports counted the bundled library as the author's model.** The metrics
have always excluded the library and the tool's own implicit features, and
report the library separately so its presence is visible; requirement
satisfaction, the traceability matrix and the connectivity report simply never
got that filter. On the shipped UAV example — whose two requirements are both
satisfied — the app's Requirement-satisfaction button therefore read 2 of 26,
7.7% covered, because the divisor was 24 library requirements; the matrix built
an 18-row parts axis for the 7 parts the file declares; and connectivity counted
37 ports where 15 are written down. The predicate is now one exported function
(`isUserElement`) that all of them call, and each report says how many
candidates it left out rather than shrinking in silence.

Connectivity needed a second half, and the filter alone would have been worse
than the bug. Of those 37 ports, 8 are the library's and 14 are the
usage-scoped copies `connect a.p to b.p` materialises under the part — and the
9 connections reference ONLY the copies. Filtering without lifting gives 15
ports and 0 connected: still wrong, no longer obviously wrong. Every endpoint is
now followed through its `Redefinition` to the port it redefines, which is 18
resolved references, 14 connected ports, and one genuinely unconnected
`DataLink::antenna` — the finding the report exists to surface.

The lift is reported as a mapping, not as a substitution, because two usages of
one `part def` lift onto the SAME declared port: `connect n1.p to n2.p` would
read as a self-edge on the definition's port, which is precisely the collapse
the usage-scoped endpoints exist to prevent. Each connection therefore carries
its endpoints twice — as the model records them, and lifted onto the ports the
inventory counts — so an id in the list is joinable without any identity being
thrown away. The same reuse shape is why `unconnectedPorts` is not the whole
answer: connect one usage's port and the DECLARATION is connected, so
`part n1 : Node; part n2 : Node; connect n1.b to n2.a;` leaves `n1.a` and
`n2.b` wired to nothing while a declaration-level report says the model is
fully wired. Ports occur once per usage, so the dangling ends are now reported
per usage as well, in `unconnectedPortUsages` — one entry on the UAV example
(`AirVehicle::radio.antenna`), two on the reuse shape.

Every figure quoted above is pinned, not remembered: on the real model in
`test/integration/uav-example.test.ts` (2 of 2 requirements with 24 library ones
excluded, 15/9/14 ports, 18 resolved endpoints, 7 matrix rows, 11 library parts
excluded once rather than once per axis) and on small hand-built models in
`test/unit/api.analytics.test.ts` (the library-and-implicit fixture, and the
reused-definition one the UAV example cannot express because each of its part
definitions is used exactly once). Removing either half of the connectivity fix
moves `connectedPortCount`; hard-coding any exclusion count to zero, dropping
the de-duplication, or rewriting the recorded endpoints to the lifted ones each
move an assertion too, which is what makes them tripwires rather than
comments.

**Two questions the reporting surface could not answer: what is unused, and what
a change reaches.** Every report so far counts or tabulates the model. Neither
"what did I declare and never use" nor "what breaks if I change this" had an
implementation: `whereUsed` walks the edges of one element exactly once, so it
answers the second question one hop deep and then stops, and nothing at all
answered the first.

The orphan reading is a threshold, and the threshold is the work. "An element
with no edges" is the obvious rule and it is useless: it is true of 67 of the
113 elements of the shipped UAV example, because attributes, documentation
comments and untyped parts legitimately have none, and a finding that fires on
59% of a clean model is noise with a name. "A DEFINITION with no incoming and no
outgoing edge" returns `FlyMission` and `FlightModes` on that model and `Drive`
and `VehicleStates` on the vehicle example — in both files, the behaviour the
author wrote out in full and then never performed. Packages are skipped rather
than examined, and not because they have no edges — `import` makes a package an
endpoint like anything else, and in a model loaded with the bundled library
almost every package carries one. They are skipped because "declared and never
used" is not a judgement that means anything about a container: a package is
where the model lives, not a thing the model uses, and the only package the
rule would ever catch is the reader's own root, which is a finding that is never
a finding. "Used" also means used HERE: an edge whose far end is a library
element or one of the tool's own implicit copies is not the reader using
anything, so a definition kept alive only by content the reader cannot see is
still reported — otherwise this report and the impact closure would disagree
about whose model it is. It is an inventory and not a diagnostic, which
is the difference between it and the two validation rules that sound like it:
`dangling-endpoint` and `orphan-relationship` fail a check over relationships
that are BROKEN, while an unused definition parses, binds and validates clean
and may be a deliberate spare.

`impactClosure` is `whereUsed` walked to a depth, and the second hop is where
the answer lives. Ask what uses `AirVehicle` and today's report names the part
usage `uav` and the two `ReferenceUsage` subjects the requirements declare; the
requirements THEMSELVES — `EnduranceRequirement` and `MassRequirement`, the
things a change to that part has to be re-checked against — are one further hop
away through the `Satisfy` edges, and no depth-1 report can reach them. The
closure closes at the second hop with five elements, so the report also says the
impact of that change is five elements and not the rest of the model. It says it
in two numbers that had to be earned: the depth reported is the deepest element
in the answer rather than the number of passes made, and `truncated` is a
lookahead for something still to report rather than "the frontier is non-empty"
— which is a different question, and answered it wrong on 45 of the 84 truncated
results over the shipped model, labelling complete answers as prefixes of
themselves.

The frontier is filtered to the author's own elements at every hop, with no flag
to turn it off, because a closure is not a lookup. Being told that a library
type uses your element is an answer; WALKING into the bundled library does not
come back, since it is ~38,700 elements that reference each other, and one
unfiltered hop through `Real` would turn "what does my change reach" into the
standard library. The tool's own implicit copies are treated differently from
the library, because dropping them is the trap the connectivity report fell into
one commit earlier: `connect a.p to b.q` wires the connection to usage-scoped
COPIES of the two ports, so a walk that stops at a copy cannot cross a wire at
all, and "what breaks if I change this port" answers with the port's own type
and nothing on the far end. They are conduits, not destinations: the walk
crosses them at the cost of one hop, counts them, and never reports an id the
reader cannot find in their own file. The hop it reports is named by the CABLE
and not by the tie at its far end — a copy is bound to the port it stands for by
a `Redefinition` the tool materialised, so the literal last edge of
`port → copy → copy → far port` is bookkeeping, and labelling a wire crossing
with it was the one edge on the path the reader never wrote. The one cable a
crossing went across is carried to the landing instead — one, and only a cable:
a crossing that meets no wire keeps its literal last edge, which is then the
truth, and so does a crossing that runs through a hub copy on TWO wires, because
naming the first cable there says two ports on different wires are wired to each
other. Depth defaults to 1 — exactly today's behaviour, so raising it is opt-in
— and a depth that is not a usable number is read as 1, because
`Number.parseInt` on a mistyped flag yields `NaN`, `Math.max(1, NaN)` is `NaN`,
and the answer that clamp produced was a confident "nothing uses this". A
visited set guards the walk: `a → b → c → a` is a legal dependency ring and
every typing edge is walkable from both ends, so without one it does not
terminate at all.

Both readings are pinned on real files rather than only on fixtures, because a
threshold is only honest against a model somebody wrote for its own sake: the
two orphans of `examples/uav-isr.sysml` in `test/integration/uav-example.test.ts`
and the two of `examples/vehicle.sysml` in
`test/integration/pipeline.api.test.ts`, alongside the hop-by-hop closure and
the hand-built chain, cycle and library-shadowed models in
`test/unit/api.analytics.test.ts`. Widening the orphan rule to any element, to
any definition including packages, or to "no incoming OR no outgoing" moves one
of those calibrated lists, and so does counting an edge whose far end is the
library or an implicit copy; dropping the library filter, the depth limit, the
crossing of implicit copies, the carry that labels a crossing by the cable
rather than by the copy's tie, the deepest-element depth or the truncation
lookahead each move the closure. Removing the visited set fails the UAV closure
assertion outright and then fails to TERMINATE on the cycle case — the walk is a
synchronous loop, so a per-test timer cannot reclaim it — which is why that case
is asserted at a bounded depth first, where a ring of three either reports two
elements or hangs the run.

**Every one of those reports was reachable only from a browser.** `npm run
check` could say a file was valid; nothing could say what was IN it. The
reporting functions are pure, exported and tested, so the gap was never the
analysis — it was that a person at a terminal had no way to call one. `npm run
sysprose -- <subcommand> <file>` is that call: one command with one subcommand
per question — how big, what is in it, are the requirements covered, what traces
to what, which ports are wired, what a change reaches, what nothing uses —
each a thin shell over the same function the app calls, so a figure read in a
terminal and the same figure read in the app cannot disagree.

The contract is `sysml-check`'s, adopted rather than re-invented: 0 clean, 1
findings, 2 usage or I/O, `-` for stdin, `--json` for the agent-facing form,
stdout for data and stderr for everything about the run. One word of it had to
be redefined, because these subcommands REPORT and do not judge: `orphans`
finding four unused definitions is an answer, not a failure, so exit 1 is
reserved for a model that did not load cleanly — the report is then of what
error recovery salvaged, and a `degraded` banner on stderr says so while the
partial report still goes to stdout. The two refusals are the other half of
that: a model that PARSED and produced no elements exits 2 rather than reporting
an empty success, because a mistyped path and an empty model must not look
alike, and an element reference that matches several elements exits 2 with the
candidates rather than reporting on the first one. The word *parsed* is doing
work there. Checking the empty case first made a file of pure garbage report
`no elements … nothing to report` and exit 2, which says the reader's command
line was wrong about a file that is unreadable, and it discarded every
diagnostic that would have said so. A file that did not parse is broken, not
empty: it is exit 1, with the parse errors above the report.

Findings go to stderr for every exit code, not only the two that fail. They used
to be printed on the "nothing loaded" and "degraded" branches alone, so anything
that left the report *ok* — a warning — never reached the reader at all:
analysing `model.notsysml` printed a clean, confident set of figures and never
mentioned that the loader did not recognise the file, while `npm run check` on
the same file said so plainly. The report is of a file, and what is wrong with
the file belongs beside it.

The one defect that could have shipped silently was in how the command ENDS.
Both CLIs here closed with `main().then((code) => process.exit(code))`, and
`process.exit` does not drain a pending `process.stdout.write` — a write past
the pipe buffer is asynchronous, so a report piped into `jq`, into `$( … )`, or
into an agent harness was cut at the buffer's edge and the run still exited 0.
Redirecting the same command to a file was whole, because a file write is
synchronous, which is why every test passed: they all captured a payload small
enough to fit. `elements --include-library` delivered 143,788 bytes of an
8,194,617-byte answer as valid-looking, unparseable JSON. Setting
`process.exitCode` and returning lets the event loop finish the write first;
`scripts/lib/exit.ts` now owns that ending for both commands, together with the
broken-pipe guard the change makes necessary, because the defect arrived by
copying the idiom and the idiom is what had to change.

The element listing needed a filter the app's Grid view does not. `buildGrid`
excludes the bundled library and stops there, which is right for a view of
everything the tool holds and wrong for a command answering "what is in it":
fourteen of its ninety-four rows for the UAV example are the usage-scoped
connector endpoints the feature-chain resolver materialises, so the listing
reported twenty-nine `PortUsage`s for a model whose `stats` — and every other
subcommand, all of which go through `isUserElement` — says has fifteen. Eighty
is the answer, and the two subcommands now agree about whose model it is.

There are two library flags and they are two different knobs, which is the kind
of thing that is obvious once written down and invisible in a flag list.
`--no-library` skips BINDING: it changes the model, and it is the same flag with
the same meaning as the checker's. `--include-library` changes REPORTING: the
library is bound and then listed alongside the model. Only the element listing
can honour the second one — the analysis reports exclude the library by
construction and each states its own excluded count — so it is rejected on the
others rather than accepted and quietly ignored, which is the one behaviour that
would let a reader believe they had asked for something.

Naming an element is a cascade — an id, then the language's own name resolution,
then a unique suffix of a qualified name — and only the last step is filtered to
the reader's own elements. It has to be: `powerIn` matches ten elements in the
shipped UAV example and five of them are the tool's usage-scoped copies, so an
unfiltered candidate list asks the reader to choose between ids that are not in
their file. The first two steps are deliberately left unfiltered, since an exact
id or a fully-resolved name is unambiguous and asking where a library type is
used is a fair question.

The traceability axes are read off the model rather than fixed per relationship.
A `satisfy` view joins a part usage to a requirement DEFINITION in the shipped
UAV example and to a requirement USAGE in a model that declares its requirements
as usages; either pair, hard-coded, reports an empty matrix for the other shape,
and an empty matrix is indistinguishable from "nothing is traced". So the row
and column metaclasses are the ones the model's own relationships of that family
actually connect, printed above the matrix, with `--from` / `--to` to override
them for the axis a reader wants to see whether anything reaches at all — and
an override naming a metaclass the model has none of is REFUSED, because
honouring it produces exactly the empty matrix the derivation exists to
prevent, and a typo would then read as a finding about the model.

One argument grammar, in `scripts/lib/args.ts`, because there were three and no
two agreed: the checker switches on whole tokens and cannot express a flag with
a value at all, the repair bench reads one with `argv[++i]` and never checks that
there was one — a trailing `--rounds` becomes `NaN` and the run reports a number
nobody asked for — and the corpus runner scans for literals. The new one takes
`--flag`, `--flag value` and `--flag=value`, rejects an unknown `-`-prefixed
token instead of reading it as a file name, and rejects a missing value instead
of inventing one. It is declarative because the help text is rendered from the
same specs the parser reads, which is what keeps a flag from existing without
being documented.

`test/campaign/cli.sysprose.test.ts` spawns the real script the way the
checker's contract test does and pins the exit code, the JSON key set and the
figures. The figures are the point: `requirements` reporting 2 of 2 rather than
2 of 26, and `connectivity` reporting 14 connected ports rather than 0, are the
two defects the previous commits removed, pinned again at the surface a person
actually uses — routing either subcommand back at an unfiltered population fails
here, as does unfiltering the ambiguity candidates, accepting the reporting flag
where it cannot be honoured, letting a degraded model exit 0, or reporting an
empty model as a success. Three of its cases pin things a report is worth
nothing without, and each replaced a run that looked clean: a payload larger
than the pipe buffer arriving whole and parsing; a file the loader does not
recognise saying so on stderr, with `-` as the control that must not; and a
file that failed to parse exiting 1 with its diagnostics rather than 2 as "no
elements". Every one of the six `--relation` presets is exercised over a
fixture that declares all six relationships, since five of them appear nowhere
else in the repo and a preset string that stopped matching would otherwise ship
as a silent empty matrix.

**Nothing in six thousand lines of documentation told a person what the tool
does.** Every document here was written for an implementer, an auditor or an
agent: a competitor survey, a standard reference, an architecture plan, a
conformance scorecard, a parity matrix, a test report, a code catalogue, this
ledger. A search of the whole repository for "getting started", "tutorial" or
"user guide" returned nothing, and the sixteen views — the thing a person
actually meets — were enumerated in one table as parity rows with test
citations. `docs/USER-GUIDE.md` is the missing half: what each view answers,
what the toolbar does, what the notation looks like, and what the tool will and
will not keep for you. It is written from the source rather than from
`FEATURE-PARITY.md`, because that matrix was already wrong in the one place a
guide would have copied it from.

The guide leads with the hazards, since every one of them is something a person
finds out by losing work. *Apply text → model* replaces the WHOLE model with the
parse result — a syntax error included, since error recovery produces a partial
reading and that reading becomes the model — and one undo is the entire safety
net. The Problems panel is one list that Validate, Check, Simulate, Solve and
the parser all overwrite, so clicking Solve after Validate discards the
validation findings. A reload discards unsaved work by design. Versions-tab
commits and branches never leave memory. The diagram scope has no on-screen
indicator and can only be cleared from the same right-click menu that set it.
The standard library is an 8.2 MB load before the first paint, and it is
re-merged after every apply, import, open and branch switch — which is why the
Problems panel refreshes a second time. The *Simulate* button and the
*Simulation* tab are different things. And `feasible` means "no KNOWN
violation": an unjudged relation leaves the flag true and is reported
separately.

Two doc-drift defects were closed while writing it, both found by reading the
source the guide had to cite. `FEATURE-PARITY.md` §3 called keyboard shortcuts
"Partial — undo/redo/save wired, no rich accelerator set" and `TEST-REPORT.md`
§6.7 said the same; `src/ui/commands.ts:111-213` has wired Delete, Ctrl+D,
Ctrl+C, Ctrl+V, the digits and `/` for some time, and `UI-ROADMAP.md` said so.
Three documents, two answers. The other went the opposite way: the New command
declared a `Ctrl+N` shortcut that `handleShortcut` never handled, so the app's
own command table advertised a key that did nothing. The label is gone, and a
test now fails on any shortcut that is declared and not handled — a label is a
claim about behaviour, and this repository tests those.

Both new documents are guarded, because a user guide is the document with the
strongest incentive to drift and the least chance of anyone noticing.
`docs/CLI-REFERENCE.md` is GENERATED from the command table
(`scripts/lib/sysprose-spec.ts`) by `npm run commands`, exactly as
`DIAGNOSTIC-CODES.md` is generated from the code catalogue, and
`test/unit/cli-reference.test.ts` compares the committed file against a fresh
render — the generator's write is guarded by an entry-point check so that
importing it to run the comparison cannot rewrite the evidence. The hand-written
guide cannot be generated, so what is checkable in it is checked:
`test/unit/user-guide.test.ts` reads the `data-testid` of every control the
guide names out of its own appendix and fails if the app no longer renders it,
fails if a toolbar control or a view kind is missing from the guide, and fails
if the guide stops showing a subcommand the command has. Every figure the guide
quotes is registered in `test/unit/docs-counts.test.ts` — the tree-derived ones
against the tree, and the transcripts of the shipped example against the same
reports run over the same file, so a pasted number that stops being true fails
with the command to re-run.

An adversarial review of that first draft found four ways a guarded document was
still wrong, and each fix came with the assertion that would have caught it.
**The flagship walkthrough was followable to the wrong picture:** it told the
reader to scope the interconnection diagram to `uav`, which is `part uav :
AirVehicle;` — a usage that owns nothing. Scoping is containment-only, so the
promised assembly came out as one box and no edges; the guide now names
`AirVehicle`, says scope follows containment, and the diagram is BUILT in the
test from the element name read back out of the guide. **It credited the wrong
button with a number:** `Check` reports satisfied/violated per constraint and no
margin — the shortfall in seconds is `Solve`'s. **It promised an id column the
example leaves empty:** `reqId` comes from a declared short name, and the
example writes `attribute id = "R-UAV-001";`, which is an ordinary attribute;
the guide explains that now, and a case asserts the rows really have no id.
**And the `npm run check` section of the GENERATED reference was hand-written
prose inside the generator**, so the whole-document comparison compared it
against itself — while it claimed `check` shared `sysprose`'s exit-code
contract. It does not: `sysprose` reports, so its 1 means the model did not
load; `check` judges, so a file that parsed perfectly and broke one validation
rule exits 1. That sentence now lives once, as `CHECK_EXIT_CODES`, rendered into
both the command's `--help` and the reference, and the drift test reads
`scripts/sysml-check.ts`'s `USAGE` and fails on a flag or a synopsis line the
reference does not show.

Two of the guards were themselves weaker than they read. The test-id scan
accepted `commands.ts`'s `id: 'tb-validate'` as proof that the app renders
`data-testid="tb-validate"`, so renaming the attribute left the suite green; the
scan now takes ids only from what reaches the DOM, plus the two view-command
tables whose ids the view bar renders verbatim — and asserts that it does. And
the appendix's completeness case covered only the `tb-*` half, so the Panels
table could have been deleted whole; a named list now pins the panel and
bottom-panel controls that table must keep documenting.

**The front page named the tool's parts and never said where to reach one.** It
listed analytics as a Highlights bullet, the reporting command as one line of a
code block and the guide not at all, so the claim this pass was built on — that
a question has one answer and several doors onto it — was nowhere a reader
could check it. `README.md` now carries a capability table with a row per
question and a column per door: the control (by the `data-testid` a test can
find it by, and the function that control runs), the subcommand, and the
function with the file that exports it. The guide is linked from the top of the
page and from the reference list, which now indexes every document under
`docs/`, and `npm run commands` joined the script list it had been missing since
the reference started being generated.

**Writing the doors down disproved the claim about them.** The table was first
drafted saying what this ledger, the guide and the generated command reference
all said before it: that the app, the terminal and an import are three doors
onto ONE function, so the same figure cannot differ between them. Naming a
function per row made that falsifiable, and it is false for three rows. The
Allocation view runs `buildAllocationMatrix`, whose rows are the elements that
take part in a link, where `trace` runs `traceabilityMatrix`, whose rows are
every element of the row kind — one row against seven on `examples/uav-isr.sysml`.
Properties → *Used by* runs `whereUsed`, which keeps re-derived copies, where
`where-used` runs `impactClosure`, which drops them, so the panel counts two
where the command reports one. And no control in the app calls
`connectivityReport` at all: the Interconnection view *draws* the ports. The
identity that does hold is narrower and still worth having — each subcommand is
a thin shell over the exported function beside it — so that is what the page now
claims, with a dagger on every row where the app computes its own projection and
a paragraph saying how the two differ. The same correction was made to the
guide, to `scripts/sysprose.ts`'s header and to the generator behind
`docs/CLI-REFERENCE.md`, because a sentence that is wrong on the front page is
no better one click away.

A table of several claims per row is the fastest-rotting documentation in a
repository, so each column is checked against its own source
(`test/unit/readme.test.ts`). Controls are checked against the ids the app can
actually render — the same scan the guide's appendix uses, now shared from
`test/support/ui-testids.ts` rather than copied, because one weak scan behind
two documents is one bug behind two green guards. Set membership is not enough
there and the first draft of the guard proved it: asking only "does this id
exist somewhere in `src/ui`" passes when two rows' controls are swapped, when a
row points at a `<code>` span that is no control, and when a cell is emptied
outright. Rows are pinned in order instead, each with the control it names and
the app-side function that control runs, and both are verified against the
sources — the id must be one the app renders, and the function must really be
called in the file named. Whether a row deserves its dagger is then DERIVED,
not asserted: a row goes undaggered only when the control runs one of the
functions the command and the import share. The terminal column is compared
with the command table in BOTH directions, so neither a new subcommand left
undocumented nor an invented one survives. The in-process column is checked
three ways: the file it cites must really export the function, every function
named must be one the command table credits (all of them — one right name beside
a real-but-wrong one used to pass), and the file must be the file that table
puts it in. A dozen mutations were run against the finished guard, including
each of the four that had slipped past the first draft; every one failed the
case that names it, and the tree was restored after each.

**A comment came back without what it was about.** `comment C about Engine,
Wheel locale "en-GB" /* … */` parsed clean and saved as a bare `comment
/* … */`: the mapper kept the body and dropped the name, the `about` targets
and the locale. A save deleted most of the statement, and re-parsing that save
reported nothing, because what came back was still valid text — the same
laundering the faulted-save work above refused, arriving through a statement
that never faulted. Prose written for a human reader rides on this statement, so
the loss was not cosmetic: a note saying which parts it explains came back
explaining nothing.

All three parts are kept on the element now and written back in grammar order.
The targets are stored as the raw qualified names, the shape `@Meta about X`
already stores, because a comment may point at something declared later in the
file or in another one; nothing resolves them to elements, and nothing here
pretends they are resolved. The name goes through the same quoting rule as every
other declared name, because the grammar's `Name` admits only an identifier, a
quoted name or a soft keyword: a comment named `part` or `my note` written bare
does not come back as a name at all — it is a mismatched token, and the rest of
the line goes to recovery. The locale is escaped rather than wrapped in bare
quotes, because it came out of a string literal and may contain that literal's
own delimiters; the same escaping was applied to the `rep … language "…"` tag
beside it, which had the unwritten version of the same fault and turned
`language "a\"b"` into a file that no longer lexes.

Two guards were written for presence rather than truth, which is the same
distinction in miniature: `locale ""` is a tag the author wrote, and `comment ''`
is a name the validator reports as blank. Testing either for truthiness would
have deleted it on save — and for the blank name, deleted its own error report
along with it.

Keeping the name has one consequence worth stating: a comment now occupies a
slot in its namespace, exactly as `doc` and `rep` already do. Text that checked
clean before can therefore report an error now — two comments named `N` in one
package are a duplicate-name error, and a comment named `Real` shadows the
library type of that name. That is the correct reading of a declared name, and
it is pinned by a test rather than left to be discovered. One golden moved with
the fix, and it moved for the right reason — the unterminated-comment fixture's
recovery residue reads `comment never ends`, so its `comment` element now
carries the name `never` where the golden used to record an anonymous one.

**Every statement can now say what kind of thing it is.** A model mixes three
things that read alike and mean nothing alike: a normative statement that
carries contractual value, an explanation written for a human reader that binds
nothing, and guidance written for an AI agent working on the model. Nothing in
the notation separated them, so a note about why a mass budget was chosen sat in
the same shape as the budget itself, and an agent reading the file had no way to
tell the rule from the commentary about it.

`statementKind` is the answer, and it is Sysprose's own vocabulary —
`requirement`, `prose`, `prompt`. The published specification has no
enumeration of statement kinds: its one requirement-related `kind` classifies a
membership inside a requirement body (`assume` / `require`), and the shipped
library classifies requirements by what they specialize, not by an attribute.
What the specification does give is the mechanism, and that is what is borrowed:
a metadata usage exists to add tool-specific information to a model, and a
metadata definition with no nested features acts as a user-defined syntactic tag
written after a `#` (7.27.1 and 7.27.4; the library's own `<derive>` is exactly
this shape). So a kind is a keyword — `#prose`, `#prompt`, `#'requirement'` —
over three shipped metadata definitions, and no notation was invented: prefix
metadata already parsed and round-tripped here, and the definitions are text
that checks clean and saves back byte for byte.

The `requirement` keyword is quoted because the bare word is a hard keyword and
`#requirement` does not parse; `#'requirement'` is the notation's own escape for
a name that collides with one, and the parser keeps the quotes, so reading a
keyword unquotes its last segment and a qualified `#SysproseStatements::prose`
reads the same as a bare one. Where no keyword is written the metaclass answers
for itself — a requirement is a requirement, a documentation or a comment is
prose — and everything else gets no kind at all rather than a default, so a
caller can tell an unclassified part from a statement classified as normative.
Reading never writes; writing replaces the keyword in place and leaves every
other tag on the declaration alone.

The write side refuses what the read side cannot promise, and working out what
that meant took a second pass. A keyword only survives a save if the serializer
writes the element through its generic declaration header, and which elements
those are is not a question a metaclass can answer: the serializer dispatches on
attributes and endpoints as well, so the same `ConnectionUsage` keeps a keyword
as `connection c : C;` and has nowhere to put one as `connect a to b;`, and a
plain action becomes `perform a;` the moment it carries an action kind. The
first guard asked the metaclass alone and so accepted `connect`, every
transition, a requirement's `subject` and `assume` and `require` clauses, a
state's `entry`/`do`/`exit`, `perform`/`accept`/`send`/`assign`, `return`, the
loops and `if` — 32 of the 94 elements it accepted in `uav-isr.sysml`, whose
keyword then vanished on the next save without a word. Worse, on an enum
literal (`low = 0.25;`, a keyword-less reference usage) the prefix *was* written
out, into a file this tool could no longer parse. The guard now takes the
element rather than its metaclass and mirrors that dispatch branch for branch,
and the mirror is pinned by the only assertion that could have caught the
original: write a kind on every element the guard accepts in both shipped
examples, save, re-parse, and fail unless every one of them still reads back.

Two honest gaps come with the mechanism. Nothing binds a keyword to the
definition it names, because metadata is unchecked in this tool: a misspelt
`#prosee` is not an error — it is simply no kind, and falls back to what the
metaclass says. And only the `#keyword` prefix is read. The same mechanism has a
second notation, the annotating usage `@prose about p1;`, which this tool parses
and round-trips faithfully; a kind written that way is invisible to the reader,
for the annotated element and for the annotation itself, because seeing it means
resolving the names in `about` against scope. That is a resolver pass this
module does not run, so the behaviour is asserted as a fact in the tests rather
than left as an accident.

**An agent can now ask what guidance applies to the element it is holding.**
Marking a statement as a `prompt` is only half of the idea; the half that pays
is being able to collect the prompts that govern one element without knowing
where anybody chose to write them down. `promptsFor(model, id)` answers that,
and the reason it is worth having is reuse: guidance written once on a port
definition — check the fuel line before changing this port — is guidance about
every port of that type, and an agent handed one port should not have to know
that someone wrote it up a level.

Three sources count as applying, because they are the three ways one element is
about another here: the element itself, its types, and its owners. The walk
takes both edges from every place it reaches, so a supertype's guidance reaches
a derived part and a package's guidance reaches everything inside it, and it
collects from a scope and its direct children only — guidance nested two levels
down was written about the thing that owns it, and hoovering up a subtree would
make every package-level question return the whole file. The answer is ordered
nearest first, and at equal distance a type comes before an owner: a type says
what the element IS, where an owner only says where it sits. That preference is
decided across a whole ring of the walk rather than inside one element's own two
edges, so it still holds two hops out, where the type of an owner and the owner
of a type meet. Each prompt appears once, at the nearest place it was found, so
a caller can read down the list and stop. The words come with it, from whichever
of the three channels an author can write them in, because a prompt reported
without its words is worse than one not reported at all — the caller acts as
though nothing had been asked of it. A comment that names a different element is
not one of those channels: since the previous commit that target survives, and
reporting Engine's documentation as the instruction addressed to this element is
the exact failure carrying the words was meant to prevent.

One consequence is stated rather than discovered: taking both edges uniformly
also reaches the owners of types, so a part typed by a definition from another
package inherits that package's guidance. That is the rule carried to its
conclusion — you used a definition from there — and it is why the walk is one
rule and not two. It also means the attachment label alone does not separate the
two kinds of owner: a caller who wants only its own containment chain has to
intersect what the prompt is attached to with the element's ancestors, and the
test says so rather than leaving it for that caller to discover.

The walk obeys the rules the impact closure already follows, for the reasons
that report learned them. The bundled library is dropped at every hop and the
drop is counted: the library is tens of thousands of elements that all reference
each other, and one unfiltered hop through a library type turns "what guidance
applies to my part" into a walk of the whole standard library. The tool's own
implicit copies go the other way — crossed, counted, never reported — because a
connection through a feature chain materialises a usage-scoped copy of each port
tied to its declaration, and a walk that stopped at the copy could not reach the
definition where the guidance was written. Neither counter includes the element
asked about; that is the question, not an exclusion. And a visited set, not the
shape of the data, is what makes it terminate: `part def A :> B` with `part def
B :> A` is an illegal model that parses, and a walk that assumed a tree away
would hang on it rather than answer — which is what the test named "terminates
on a cycle in the type graph" holds the walk to.

**A requirement carries its management facets again, and they survive a save.**
A requirement in a real programme is not only a sentence: it has a status, a
verification verdict and method, a risk, a priority, a criticality, a rationale,
the source it came from and an owner who answers for it. A branch that modelled
all nine was paused in July and never landed, and its base commit did not
survive the restart of this history, so it could not be replayed — it was
reimplemented against today's tree, with the statement kind as a tenth facet and
three deliberate departures from what it did.

The first is where a value lives. The paused work put the nine keys in the
`attrs` bag of one owned metadata usage. That reads back perfectly through the
JSON layers and vanishes entirely through the textual one: the notation has no
form for an arbitrary bag, so the carrier saves as `metadata
RequirementMetadata;` and every facet is gone the next time the file is opened.
Each key is now an owned attribute under that same carrier — `metadata
RequirementMetadata { attribute status = "open"; }` — which is ordinary
notation that saves, re-parses and re-saves byte for byte. The value is written
as a quoted string literal, the same lexeme-with-quotes shape the parser hands
back for `= "open"`, so a rationale containing a space, a quote or a backslash
cannot break the file it is saved into. The assertion that pins the decision
writes all nine facets, saves, re-parses and reads every one of them back.

The second is `priority`. It had a value list and an editing column, and it was
missing from the validated set, so it was the one facet that accepted anything
a caller typed. It is validated now, like the four the standard library names.
The third is clearing: writing an empty value used to store an empty string, so
a cleared status read back as a value that was not a status and every consumer
had to know that `''` and "unset" meant the same thing. Clearing removes the key
now, and the carrier goes with the last key it held rather than leaving an empty
`metadata RequirementMetadata;` line behind in the saved file.

The tenth facet is not stored beside the other nine. `statementKind` is carried
by the keyword on the declaration, and reads and writes of it are forwarded to
that module rather than copied, because two places holding the same answer is
how they come to disagree. So `getRequirementAttrs` reports a kind for a
requirement nobody has tagged — the metaclass settles it — while every stored
facet is absent until someone sets it.

Reading knows both shapes and writing only makes one. The identity is the
element's own short name and the statement is an owned documentation child, but
models saved before this — and everything the factory still authors today —
keep them in `attrs.reqId` and `attrs.text`, so the two read helpers prefer the
native slot and fall back to the legacy one. Nothing migrates a saved model
behind the author's back, and nothing writes those two keys again from here.
The legacy slot is not only history, either: a save and a reopen produce it,
because the mapper folds a requirement's `doc` body into `attrs.text` and
creates no documentation element at all, and re-derives the legacy id from the
short name it just read. So the same requirement reads through its documentation
child in memory and through the fallback once it has been round-tripped, and a
requirement written with two `doc` bodies keeps only the last.

The writer had to be made to agree with those readers. The serializer emitted
the legacy `attrs.reqId` in preference to the element's own short name, which is
the opposite of what every reader here does: with both present the tool showed
one id and saved the other, and reopening the file reverted the edit. It emits
the short name now and falls back to the legacy key, which changes nothing for
the two shapes that exist — the mapper writes both from the same token, the
factory writes only the legacy one — and a test saves a natively named
requirement and reads its id back to keep it that way. The one store command
that edits a facet validates before it mutates, so a refused value leaves the
model untouched and its undo snapshot comes straight back off the stack instead
of standing there as a step that changed nothing; a clear of a key that was
never set, and any write onto a standard-library requirement, are refused before
that snapshot is taken at all — the second because undo restores a snapshot
while keeping library elements verbatim, so the edit would have outlived the
step meant to take it back.

Two gaps come with the facets, and one deliberate refusal. Nothing rules on a
carrier a person wrote by hand: a misspelt `attribute stauts = "open";` is
simply not a facet, a value outside the list reads back although no writer here
would have accepted it, and a file carrying two `RequirementMetadata` carriers
has one that answers every read and takes every write while the other's values
sit in the file saying something else. `RequirementMetadata` itself names no
definition this tool declares — metadata is unbound here exactly as the
statement-kind keywords are — so the carrier line is a tag whose meaning lives
in the module, and the reader accepts both the bare and the typed
`: RequirementMetadata` spelling for it while refusing the annotating
`@RequirementMetadata` form, which points elsewhere. And
a requirement whose own declaration could not be parsed is refused a facet
outright: the serializer re-emits a faulted declaration's source verbatim and
nothing else, so a carrier underneath would read back in memory and be gone from
the next saved file — the very loss the storage shape was chosen to avoid.

**A kind changes what the rest of the tool does with a statement.** A
vocabulary nothing reads is decoration, so the five surfaces that treat a
requirement AS a requirement now ask what kind of statement it is first.

Coverage is the one that mattered most. `requirementSatisfaction` counted every
requirement-shaped element the user owned, so an explanation written in
requirement shape entered the divisor, had nothing satisfying it — nothing is
supposed to satisfy an explanation — and pulled a fully covered model below
100% with a gap that could never be closed. That is the bundled library's old
failure at a smaller scale and harder to spot, so it gets the same answer:
non-normative statements leave the divisor and are COUNTED, as
`nonNormativeExcluded` beside `libraryExcluded` and `implicitExcluded`. A
ratio the reader cannot reconcile with the rows in front of them is worth less
than no ratio. The terminal report prints that count only when there is one —
the library line is on every report because the library is always there to
exclude, while a permanent `0 prose or prompt` line would teach every reader of
every model a vocabulary most of them never use.

The `requirement-subject` rule asked the same question the wrong way round. A
subject is what a requirement constrains, which is a fair thing to demand of a
rule and a meaningless thing to demand of a paragraph of commentary, so before
this the tool spent one warning per paragraph arguing with its own feature. It
skips prose and prompt now, through one predicate rather than an inline test,
so the next requirement rule asks it the same way. Nothing else moved: an
UNTAGGED requirement is normative, because the kind falls back to what the
metaclass says, and a model written before any of this is counted and checked
exactly as it was.

`constraint-violation` is the second rule that judges requirements, and it was
missed on the first pass — it enumerates RequirementUsage by name, so a `#prose`
paragraph carrying an expression was reported violated by the checker while
`requirement-subject` was correctly silent about the same element. It asks a
DIFFERENT question, though, because it also judges plain constraints: a
`constraint c { … }` carries no statement kind at all and would have failed a
"is this normative?" test and gone unchecked. So the exemption is worded the
other way round — a statement is skipped only when an author explicitly tagged
it `#prose` or `#prompt`.

Three places evaluate those expressions, and fixing one of them would have been
worse than fixing none. The rule is the checker's answer; the Simulate panel
runs its own loop over the same two metaclasses against live values; and
`constraintReport` is what the Problems panel's "check constraints" command
lists INSTEAD of the rule's rows, which it drops on purpose to avoid
double-listing. Suppress the rule alone and the same warning walks back into the
same panel through the other door. All three now read one predicate, so they
cannot come to disagree about one statement again.

The two places a person reads and edits statements show the kind rather than
inferring it. The requirements table gains ten columns — the kind first, then
the nine management facets — and a non-normative row STAYS in the grid, labelled
by its Kind cell. Hiding it would have made the one editable grid in the app the
one place a prose statement cannot be edited; coverage is the number that
excludes them, and it says so. Each column carries the closed list its key
accepts, copied from the table the writer validates against, so a cell cannot
offer a value the write would refuse.

Two things about those controls are worth writing down, because both were live
controls that silently did nothing. A Kind selector is driven by the kind
WRITTEN on the element, never by the kind it reads as: those differ on an
untagged requirement, which reads `requirement` and carries no keyword, and a
selector showing the effective answer makes both moves unreachable — clearing is
a no-op the store returns from without a re-render, and tagging `#'requirement'`
on purpose fires no change event because the browser already shows the word. The
blank entry is therefore a real current state and is labelled with what the
element reads as, from one function both panels call. And a facet control asks
BEFORE it offers: the writer refuses a requirement whose declaration could not be
parsed, because the file re-emits that source verbatim and the value would be
gone on the next save, so a row like that gets disabled cells carrying the reason
rather than a drop-down that accepts a value, snaps back, and logs to a console
nobody has open. The Properties panel gains the same two
things, and the Kind selector is offered on far more than requirements: guidance
is most useful written on a definition or a package, where everything typed by
it or inside it inherits it, and a selector confined to requirement rows would
have hidden the control from the elements a `prompt` is most useful on. It is
offered wherever the notation has somewhere to put the keyword — the same
predicate the writer refuses on — so the control is absent exactly where the
write would have thrown. Reading a requirement into either surface creates
nothing: the facet reader answers from the carrier if there is one and never
makes it.

That selector needed a store command of its own, because the kind is the one
facet that is not about requirements and the facet command refuses anything
else. It clears as well as sets — a part is not a statement until somebody says
it is, so a one-way control would have been a trap — which is why the private
keyword-clearing helper moved next to the writer and became part of the module's
surface. Both commands spend exactly one undo step, refuse a library element
before taking a snapshot, and put the redo stack back if the write throws.

**The two questions a kind makes worth asking, from a terminal.** A vocabulary
that only the browser can read is a vocabulary an agent cannot use, and an agent
driving a model is who `prompt` exists for. So `requirements` gains `--kind` and
there is a new `prompts` subcommand, both rows in the one command table the
dispatcher parses, `--help` renders and `docs/CLI-REFERENCE.md` is generated
from.

The listing changed before the flag did. `requirements` used to print the rows
the RATIO counts, which since coverage started excluding prose and prompts meant
it printed a line saying "N statement(s) tagged prose or prompt are not counted"
and then gave the reader no way to find out which ones. Every requirement-shaped
statement is listed now, whatever kind it is, with the non-normative ones
labelled by what they are and why they are not counted; `--kind` narrows that
listing to one kind and leaves the headline ratio alone, because coverage is a
fact about the model rather than about what was asked to be shown, and the
filtered report says how many of how many rows are in front of the reader. Two
smaller decisions are the same instinct: a re-derived copy is filtered out of the
listing rather than shown as a row nobody can edit, and a non-normative row
reports `satisfied: null` rather than `false`, because `false` is a claim about a
requirement — that it has a gap — and a consumer counting gaps would have counted
every explanation in the model.

`--kind` is checked against the closed vocabulary before the file is read, so an
empty listing under it is an answer rather than a typo, which is why it is NOT
one of the command's refusals — unlike `--from`, where an unknown metaclass and
an honestly empty matrix are indistinguishable. What the listing cannot answer,
it says: the population is what a requirements table holds, so guidance written
on a part or a package is not in it, and the line under a filtered listing names
the subcommand that does find it.

That subcommand is `prompts --element REF`, a shell over `promptsFor` — the
guidance written on an element, on what it is, on where it sits, and on where
what it is sits, nearest first, each with its provenance and the words it
carries. That fourth clause is not padding: the walk reaches the owners of
TYPES, so a part typed from another package is handed that package's guidance
without sitting in it, and the legend under the listing has to describe the walk
that produced the rows above it rather than a tidier one. It carries no view in
the app: the Properties panel WRITES a kind, but nothing there collects what
applies to a selection, and the capability table says "no view yet" rather than
crediting the selector with an answer it does not compute. The one value list the
command table copies rather than imports is the three kinds — the spec module is
kept free of model imports so the documentation generator does not pull the core
graph in to render a help line — and a unit test compares that copy against
`STATEMENT_KINDS`, so a fourth kind cannot become a kind `--kind` silently
refuses.

**Documenting a vocabulary this project invented, and saying whose it is.** The
rest of the guide describes notation somebody else specified, so a reader misled
by it can go and read the specification. Statement kinds have no such backstop:
`docs/USER-GUIDE.md` §7 is the only place a person is told how to write one,
which makes the section the definition rather than a description of one.

It is written to be checkable for that reason, and three doc guards now stand
under it. The VOCABULARY is compared with `STATEMENT_KINDS` — every kind named,
and named with the keyword the writer actually emits, so the guide cannot print
`#requirement` where a reader has to type `#'requirement'` to get a file that
parses. The package a reader is told to paste is compared byte for byte with
`STATEMENT_KIND_LIBRARY`, because the module's own round-trip test pins that
text and a hand-retyped copy in a document inherits none of it. Every `sysml`
block in the section is parsed and checked as printed, the two-line one that
shows where the keyword goes included — an unchecked snippet is how §3 came to
teach an action line that did not parse. And both TRANSCRIPTS are compared with
the analysis functions over the snippets printed above them: EVERY figure in
them — the ratio, the percentage, and all four exclusion counts — against
`requirementSatisfaction` and `promptsFor`, the mark on every row against
`buildRequirementsTable`, the applies-to listing row for row, in order, with the
words each prompt carries.

Two of those figures had been left unregistered on the first pass, and the way
they escaped is worth recording: `docs-counts.test.ts` matches a claim with a
single `exec` over the whole document, so its `re-derived copy/copies` claim
binds to the FIRST transcript quoting that sentence — §6's — and a second
transcript of the same command over a different model is invisible to it. A
per-section guard that extracts its own fenced block is the shape that scales to
two transcripts of one command; a document-wide first-match scan is not.

The transcripts' WORDING is pinned too, and separately. Comparing figures cannot
see it: the note on a `[-]` row could be reworded to say the row IS counted and
every figure would still agree. `scripts/sysprose.ts` cannot be imported to get
at those sentences — it calls `runMain` at module scope, so importing it would
run the CLI — so the guard reads the literals out of the file as text and
requires the guide to quote them. That still splits the claim in two: what a
report says about a model, and the words it says it in, are checked here; how it
lays a line out, by the L7 CLI suite.

The honesty basis is stated in the guide itself rather than left in a commit
message. The published specification has no enumeration of statement kinds: its
one requirement-related kind classifies a membership inside a requirement body,
and its library classifies requirements by subclassification. So the three
values are this project's own and the guide says so. What is borrowed is the
mechanism, and the guide says that too, with the two clauses it rests on —
§7.27.1, that a metadata usage exists to add tool-specific information to a
model and that a metadata USAGE whose definition has no nested features acts as
a user-defined syntactic tag on the annotated element (the actor in that clause
is the usage, not the definition, and the guide had it the other way round until
review caught it), and §7.27.4, the `#name` keyword, which the standard library
itself uses for `<derive>`. The claim being made is that no notation was invented, and that
is a claim about a file: it parses, it round-trips, and the section shows the
model that proves it. Nothing here is a claim about the tool having been
measured against a standard, which is what `docs/CONFORMANCE.md` is for.

One stale inventory turned up while the front page was being edited. The README
Develop block lists the subcommands as a quick reference, and it had named
every one of them except `prompts` since that subcommand shipped — a second
copy of the command table that nothing compared with the first, so it degraded
from an inventory into a sample with every guard green. It is compared with
`COMMANDS` both ways now, so an invented name fails as loudly as a missing one.

Its new link into the guide exposed a second gap of the same shape: the
README's dead-link guard stripped the `#fragment` and checked only that the file
existed, which is precisely the half that cannot rot on its own. A link by
section number is a link into a document that renumbers its sections — this
commit renumbered three of them — so the fragment is now resolved against the
target's own headings, slugged the way a Markdown host slugs them. And the
guide's own "source of truth" line numbers, which no guard had ever read, are
checked for the two validation rules §7 names: the cited range has to start on a
rule's declaration, end on its closing brace, and contain that rule's id. Both
ranges were off — one started on the line after the declaration and ran into a
helper below the rule.

**A note body could inject model structure, silently, and cleanly on the second
save.** A note body is written with no
escaping at all, and the delimiter that ends it has no escape sequence: unlike a
name or a string literal, there is no spelling of it that survives inside a
note. The serializer assumed every body had come back out of a note token and so
could not contain that sequence — but three UI paths write free text straight
into one (the Properties documentation box, the Properties requirement-statement
box, the Text column of the requirements grid), as does the element-graph API. A
statement ending in a close-note followed by `satisfy R1 by Vehicle;` was written
out verbatim: the note closed early, the tail was re-read as declarations, the
model came back with a `Satisfy` nobody had written, the saved file re-parsed
with ZERO diagnostics, and the second save promoted the mis-parse into the
canonical form, at which point nothing could tell it had happened. A body that
cannot be written back is now a loud failure rather than a save: the panels ask
before they write and put the reason under the box, the store command refuses
the same value for every other caller, `validation/unwritable-note-body` reports
a model that already carries one, and the serializer itself throws rather than
produce a file that means something other than the model. There is no fixture —
the input for one cannot be written, which is the whole point — so it is pinned
by unit tests over the serializer, the rule and both panels. The claim is narrow
on purpose: a note body has no escape sequence AT ALL, unlike a name or a string
literal. It is not the only authored string written verbatim — a value
expression is too, and is recorded below rather than closed here.

**A faulted multiplicity saved as the literal token `[undefined]`, and that file
then checked OK.** `part a : A [];` and `part a : A [;` both parse (with an
error) into a multiplicity whose lower bound is absent, and `String(m.lower)`
turned that absence into the seven letters `undefined`, which went into the
user's file as if they were notation. `undefined` is a legal `MultTerm` — the
grammar admits a qualified name as a bound — so the saved file re-parsed clean,
one error in and zero errors out, with a phantom feature standing in for the
bound the author had lost. The mapper now stores no multiplicity it could not
read — nor half a range, since `part a : A [0..];` read its lower bound and not
its upper one, and writing the lower alone invented `[0]`, a well-formed bound
the author never wrote. An unreadable bound is now simply ABSENT, so the save
invents neither a phantom feature nor a bound nobody asked for. What it still
does not do is reproduce the fault: no residue is recorded for a bracket, so the
saved file re-parses clean — the same error-recovery laundering listed under
Known limitations below, one input at a time rather than one fixture.

The serializer's own guard asks a different question, and a first attempt at it
asked the wrong one. Written as a SHAPE check — write a bracket only when its
content looks like the grammar's `Multiplicity` — it made the defect worse in
both directions: it dropped `['max count']`, `[1.5]` and `[0..'up to']`, which
`validation/malformed-multiplicity` reports, so the saved file no longer carried
the error the checker had just given (one error in, zero out, the very shape
this commit exists to close); and it dropped `['my bound']` and `['größe']`,
which parse with no error at all, because a `MultTerm` may be a qualified name
and a name may be written unrestricted. Whether a multiplicity is well FORMED is
the validator's question. The serializer's is only whether it can be written
BACK, so a malformed bound is now written out, error and all, and the one thing
refused is a value that would close its own bracket — loudly
(`UnwritableMultiplicityError`), because dropping it would produce a file that
parses cleanly and says something else, and because every such value is reported
by `malformed-multiplicity` too, so the Problems panel names the element.

**A blank declared name was laundered away by every serializer path except
`comment`.** `part def '';` is `validation/blank-name`, an error; saving it wrote
`part def;`, which checks OK — and left behind a `split-declaration` warning
telling the reader that a misplaced keyword had split the declaration, which is
not what the author did. The blank-name fix had been applied to the Comment
branch alone, while `header()` and the twelve dedicated statement forms kept a
truthiness guard that cannot tell `''` from "no name at all". Those are distinct,
validator-visible states, and collapsing them on save destroyed the evidence for
the very error the checker had just reported. Every site now tests for
PRESENCE — the rule the Comment branch already stated — for the short name as
well as the name, so a blank requirement id survives too. The one guard that
still tests truthiness is the LEGACY `attrs.reqId` fallback, because the
Properties panel clears that field to `''` and an emptied box means "no id",
not "a blank id". Fixture: `L4-blank-name`, now also covered by the L6 invariant
below.

**The campaign gained a save-and-recheck invariant.** Both defects above turned
one error on the way in into zero on the way out, and nothing in the corpus was
watching for that shape. `test/campaign/invariants.test.ts` now round-trips a
named list of nineteen fixtures — every case whose fault survives parse →
serialize → check today — and fails if any of them starts saving clean.
`L0-json-as-sysml` is on the list too: its first save keeps an error even though
that save is not idempotent (see below).

### Known limitations, recorded rather than hidden

**Thirteen fixtures still re-parse clean after a save.** The save-and-recheck
invariant above is a named list, not a corpus-wide property, because for these
thirteen it is error RECOVERY rather than the serializer that drops the fault:
`L0-non-ascii-names`, `L1-unterminated-comment`, `L1-unterminated-string`,
`L2-bad-multiplicity`, `L2-bare-transition-arrow`, `L2-empty-type`,
`L2-empty-unit-bracket`, `L2-equals-in-constraint`, `L2-extra-closing-brace`,
`L2-keyword-order`, `L2-missing-closing-brace`, `L2-unicode-unit-symbol`,
`L4-dangling-then`. Recovery keeps what it could parse and the unparsed residue
is re-emitted only where the mapper marked one (see "a faulted save reproduces
its fault"); where it did not, the saved file is the honest content of the model
but no longer reproduces the fault. The list is measured, and the invariant is
the ratchet that stops it growing.

**`L0-json-as-sysml` is the one file in the corpus a save does not settle.**
JSON offered as `.sysml` is refused by the loader before a model exists; parsed
directly it now serializes to a bare `;` (it used to be `[undefined];`), which
still re-checks as an error — so it is on the invariant's list — but a SECOND
save yields the empty string. The phantom element is gone; the residue is not.

**A value expression is written verbatim, and can inject the same way a note
body could.** `attrs.value` holds an expression as the author wrote it, and the
Properties panel's Value box takes free text into it, so a value of
`1; part def Injected; attribute q = 2` saves as exactly that: two declarations
nobody wrote, in a file that re-parses with zero diagnostics. It is not covered
by the note-body refusal above and is not the same fix — a note body has a
delimiter to close and no escape for it, whereas a value is notation, so closing
this one means checking that the value PARSES as an expression before it is
stored. The scope is pinned by a test in `text.roundtrip.test.ts`, which fails
the day the Value box is closed.

**`doc … locale "…"` still drops its language tag.** The `doc` statement takes
the same `locale` tag as `comment`, and the mapper still ignores it: `doc D
locale "fr-FR" /* … */` saves as `doc D /* … */`. The name it already kept;
the tag it does not. It was left alone with the comment fix above because a
`doc` body has a second owner — on a requirement it is folded into that
element's own text attribute instead of becoming a `Documentation` element — so
keeping the tag means first deciding where it lives in that case. `doc ''` also
still loses its blank name on save, and with it the blank-name error — the
laundering the comment fix above closed, left standing one statement away for
the same reason.

**The impact closure loses a wire to a shorter detour whenever a connection's
ends were copied.** It crosses a connection — that is what the conduit is for,
and the crossing is pinned on parsed text in
`test/integration/pipeline.api.test.ts` — but only where the crossing is the
SHORTEST way to the far end, and on the shape most models are written in it is
not. The discriminator is the shape of the connection's ENDS, not the ports'
types. A connection written on the declarations it joins — `connect a to b`
inside the `part def` that owns both — binds to those declarations, so the wire
is one hop and always labels the far end, shared port definition or not. A
connection written under a part usage, or through a feature chain, binds to
usage-scoped COPIES instead, and then the wire costs three hops: out to the near
copy, across, back down to the far declaration. Two ports of the same `port def`
are two hops apart up and down that definition, and the walk is undirected, so
on that shape the typing detour arrives first and the visited set closes the far
port before the cable reaches it. That combination is not a corner case. It is
every connection in both shipped examples — each is written under a part usage
and joins two ports of one definition — so on the models the docs point at, NO
reported element is reached across a wire at any depth:
`test/integration/uav-example.test.ts` pins that over `examples/uav-isr.sysml`
and `test/integration/pipeline.api.test.ts` over `examples/vehicle.sysml`, both
swept to the complete closure rather than to a depth deep enough to look
convincing. What a reader gets from `impactClosure(BatteryPack::powerOut)` is
the five `powerIn` ports at depth 2 `via: 'FeatureTyping'` — the right elements,
labelled by the type they share instead of by the cable between them, and
indistinguishable from ports of that definition that are wired to nothing.
Making the wire win would mean either crossing a copy for free, which breaks
"depth 1 is exactly `whereUsed`", or walking typing edges in one direction only,
which is the pinned undirected behaviour the sibling results depend on; neither
is a change this reading is worth. Ask the closure what a change REACHES; ask
`connectivityReport`, which lifts every endpoint to the port it stands for, what
is wired to what.

**Re-homing cannot recover the faulty declaration itself.** It repairs
containment from the brace structure, which is all the parser leaves intact —
the skipped tokens are unreachable (`resyncedTokens` on a Chevrotain recovery
is always empty), so the residue of the bad declaration stays a keyword-less
element. What it now keeps is the TEXT: the residue carries its own source and
is re-emitted verbatim, so the loss is visible in the saved file instead of
being laundered away. Two consequences of the same limit: `def part X;` still
maps to a part USAGE (the deleted `def` cannot be recovered, only the reported
`parse/keyword-order` says so — `L2-keyword-order`), and a residue whose text
would not be brace-balanced is left unmarked rather than emitted as a
different fault.

**What "a faulted save stays honest" does NOT cover.** The guarantee is
deliberately narrow, and everything outside it saves to a file that checks
clean. Precisely: only a bare REFERENCE swallowed as a body's trailing
expression is recognised as residue, and only when the tail of the same
statement parsed into an element of its own that the serializer writes as a
statement. Everything else keeps the pre-existing behaviour — the swallowed
word stays welded onto the enclosing body as a trailing expression — because
losing the text BOTH ways is the one outcome worse than laundering. The known
shapes:

* **A residue with no element of its own.** `blok 5;` leaves nothing named (a
  number cannot be a name), so there is nowhere to put the text; a stray `5`
  or `blok` stays on the enclosing package and the file re-parses clean. The
  next declaration is deliberately NOT used as the carrier: it is a healthy
  statement of its own, and swallowing it into a verbatim string also froze it
  against every later model edit.
* **Only the FIRST fault in a body.** After it, recovery escapes to the
  namespace level, where there is no trailing-expression site to catch the
  next one. Two `blok …;` lines in one package are both REPORTED, and the save
  reproduces one of them.
* **A fault at FILE level.** There is no body to be swallowed by at all
  (`blok def Vehicle;` written outside any package leaves an element named
  `blok`), so it is reported but not marked.
* **Recovery that happens IN PLACE.** `part broken : ;` (`L2-empty-type`), a
  dangling `then` (`L4-dangling-then`), a bad multiplicity, a bare transition
  arrow and `=` in a constraint are all repaired by the parser or the mapper
  without leaving a residue, so their round trip goes from one error to zero.
  The report names them; the saved file does not.

A constraint or calculation body is a trailing expression too, and parses
IDENTICALLY to a residue (`constraint c { a x }` is the same shape as
`blok def Vehicle;`), so the strip happens only when the mark lands: the two
are halves of one signal, and a real expression is never deleted on offsets
alone.

**Re-homing is a proximity heuristic, and declines rather than guess.** The
owner of a declaration is "the latest-starting element before its enclosing
`{`", which is a fact about the TEXT, not about the parse. An unbalanced file
is genuinely ambiguous about where anything belongs, so the pass returns
without moving anything — `L2-missing-closing-brace` and
`L2-extra-closing-brace` pin that, and the residue mark declines on the same
signal. Measured over the 140 `.sysml` files under `examples/` and
`test/fixtures/` on 2026-09-03: 19 report a parser error, so the pass runs on
them; 2 of those are brace-unbalanced and are declined.

**The brace scan follows the lexer for comments and notes, not for names.**
`UNRESTRICTED_NAME` and `STRING` are newline-tolerant in the grammar, while the
scan's quote skip stops at the end of the line. A brace hidden inside a
MULTI-LINE quoted name (`part 'a` … `{ name';`) is therefore still counted as
real, which is the remaining way a faulted file can look balanced by
coincidence. Notes no longer do this.


**A relation the solver cannot scale is judged in raw magnitudes, not refused.**
The gates are conservative on purpose: an unresolvable unit, or operands whose
dimensions do not match under a comparison, `+` or `-`, leaves the
relation unscaled, where the residual — and so `slack`, `amount` and the penalty
an optimizer descends — is still a difference of magnitudes in different units.
The VERDICT is then taken from the unit-aware evaluator where it has one, and
from the residual where the unit-aware answer is IGNORANCE (`unresolved`,
`dimension`, `parse`) rather than a refusal; only a refusal (`offset`,
`mismatch`) is preserved as `unknown`. That distinction is exactly what keeps
the declared-unit contract: `range = 5 [km]` against a bare `<= 10.0` is
unscaled, the unit-aware evaluator declines the comparison, and the residual
answers `satisfied` in kilometres — the reading the author wrote. A relation
whose body mixes a `[unit]` literal with an unscalable variable is reported
`unknown` rather than guessed.

**An EQUALITY between a bare number and a dimensioned value is `violated`, not
`satisfied`.** The declared-unit contract holds for ORDERING comparisons, where
the unit-aware evaluator answers `unknown` on a dimension clash and the residual
reads the literal in the feature's own unit. For `==` it has always answered
`false` instead — a dimensionless number is not a duration — so `target == 90.0`
on a `DurationValue` reads `violated` on the validation surface, and now reads
the same on the numeric one (it used to answer `satisfied` from the residual).
The two surfaces agree; the model should say `== 90.0 [s]`.

**`AnalysisReport.feasible` means "no KNOWN violated inequality".** A relation
neither engine could judge is reported in `unknowns`, not folded into the flag —
an unjudged constraint is not a violated one. The Solve header prints both, so
"no violated inequality constraint" is never read as "all of them hold".

**Feasibility REPAIR at extreme scales is still absolute.** The gate that judges
an inequality is relative to its SI magnitude, but the penalty descent that
produces the values it judges (`solveFeasible`'s line search, its `feasTol²`
target) works to an absolute `tol`. A nanosecond-scale model whose constraints
are satisfiable can therefore be reported infeasible because the search cannot
move that precisely, where before the same model was reported feasible without
either engine having looked. The verdict surfaces are unaffected: they read the
unit-aware evaluator.

**A requirement `subject` clause drops its value AND its multiplicity.**
`subject s : Real [1] = 5;` parses — the grammar carries both parts — and
re-emits as `subject s : Real;`. `mapRequirementClause` reads the name and the
specializations and nothing else, so only the type survives. An earlier
revision of this entry said the multiplicity survived; it does not, and the
round trip above is what says so.

**A `->` after a transition guard is absorbed into the guard.** In
`transition first a if g -> b then b;` the guard expression is `g -> b`: the
arrow is a legal function-operation operator, so the guard swallows it and no
diagnostic follows. SysML v2 has only the `if` guard form, so there is nothing
to disambiguate against — but an author who meant the arrow as the transition
target gets a guard that reads as one and a target taken from the `then`.

**The Properties panel writes a value as raw text.** The Value field calls
`setAttr(id, 'value', <the typed string>)` (`src/ui/panels/Properties.tsx`), so
hand-typing `-2.5` there re-creates exactly the string form the textual path
stopped producing (`L4-signed-literal`): the panel is the one INTERACTIVE
surface on which `attrs.value` can still arrive as a string rather than a
number. It is not the only one — `applyChange` in `src/api/rest.ts` writes a
commit's `attrs` into the model verbatim on both the create and the update path,
so an API client can post the same string — but that surface is a caller's own
payload, where the textual and panel paths are ours. Coercing it is
a separate UI decision rather than an oversight — a value is legitimately
textual sometimes (an expression, an FMI `INF`) and `setAttr` has one signature
for every attribute, so the coercion rule has to be written per field, with the
same care the mapper's bare-number guard needed.

**A strict `<` is exact on the fallback path and tolerant on the dimensional
one.** Where both surfaces read raw magnitudes (a bare literal beside a
dimensioned value) `mass < 25.0` at 25 kg is violated on both — the boundary is
the boundary — and `solveFeasible`/`optimize` say infeasible, all three reading
the one rule that owns strictness. Where the unit-aware evaluator judges,
`compareQ` counts operands within its relative tolerance as EQUAL for every
operator, so `mass < 25.0 [kg]` at the same 25 kg is satisfied and feasible.
Every surface agrees with every other on each path; what differs is the two
PATHS' readings of a tie. Closing that means giving `compareQ` a
strictness-aware tolerance, after which the shared rule would follow it — until
then, the same tie reads two ways depending on whether the relation carries a
unit the evaluator can use. One consequence to know about: a strict ordering
violated exactly at its boundary reports a violation `amount` of 0, because the
violation is the tie itself, so a row's verdict — not its amount — is what says
whether it holds.

**Offset-unit differences answer unknown rather than converting as intervals.**
The difference of two absolute temperatures IS a well-defined quantity — a
temperature interval, in which 1 °C = 1 K — but the engine has no interval type
to carry one, so `t2 - t1 <= 5.0 [°C]` is refused instead of judged
(`L4-temperature-difference`). Refusal is the fail-safe half; what is missing is
the delta semantics, not the refusal, and the same gap makes the solver drop
such a relation rather than scale it.

**A library long name beyond per/squared/cubed does not resolve.**
`resolveUnit` reads the worded forms the bundled library actually uses — `per`,
`squared`, `cubed`, and adjacent words as a product — so `metre per second`
resolves while `kilogram metre squared second to the power minus 3 ampere to
the power minus 1` does not. The general "to the power minus N" form is a small
grammar of its own that nothing in the corpus writes; the `unknown-unit` hint
teaches the symbol spelling (`kg⋅m²⋅s⁻³⋅A⁻¹`), which the funnel does resolve.

**A standard library that fails to load degrades to a curated subset, and only
the console says so.** `loadStandardLibraryAsync` (`src/ui/store.ts`) falls back
to `loadCuratedLibrary` when the 38.8k-element bundle cannot be fetched or
parsed. That keeps the app usable, but it changes what resolves: a name the
full bundle carries then reports as an unresolved type, with nothing in the
Problems panel to say the library behind the finding is a smaller one. The
fallback is a `console.error` and no more. Unit resolution is deliberately
exempt — the registry answers identically under the full bundle, the curated
fallback and `library: 'none'` — so a degraded library changes names, never
dimensions.

**Two evaluators, and two parsers, over one expression language.** The scalar
path (`parseExpr` / `evaluate`, `src/semantics/expr.ts`) and the quantity path
(`QParser` / `evalQ`, `src/semantics/units-eval.ts`) each lex and parse the same
constraint text into their own AST. Strings, `null`, `if`-`then`-`else`, `xor`
and `implies` exist only in the scalar one; `[unit]` literals, dimensions and
the refusal reasons only in the quantity one. What keeps them from disagreeing
is the ordering rule described above — unit-aware first, scalar only where the
unit-aware answer is ignorance rather than refusal (`isRefusalReason`) — plus
the cross-surface tests, not construction. Merging them is the one duplicate
mechanism this pass left standing, and it is recorded rather than hidden
because every unit defect in §4 above began as the two paths answering
differently.

**The library-binding sequence is still written out twice.** `loadModelText`
removed the copy that lived in `check.ts`, but the app's
`loadStandardLibraryAsync` (`src/ui/store.ts`) still spells the same four steps
out itself, and it cannot call the loader: it binds an ALREADY-LIVE model —
re-reading it from the store *after* the library asset is awaited, deliberately —
rather than parsing text, and it falls back to the curated subset when the full
bundle will not load. Nor can the three synchronous steps move to a shared
helper under `src/library` without inverting the layering, because
`resolveConnectorFeatureChains` lives in `src/text`. So the duplication stands,
and a test pins the two copies to the same steps in the same order
(`test/unit/text.load.test.ts`) instead — drift between them would be a silent
correctness bug, with the app and the command line disagreeing about what a
model means. A later commit that gives the loader a text-side
`bindStandardLibrary` owns removing it.

### Pinned behaviours (decisions, not defects)

**An inherited connector end materialises a per-usage implicit feature.** When
`connect a to x;` names an `x` the enclosing type INHERITS, the endpoint binds
to a usage-scoped implicit mirror (`P::Car::x`, `attrs.implicit`), not to the
supertype's `x`. A type-owned feature is shared by every usage of that type, so
binding it directly would collapse two connectors on the same definition into
one edge and move the diagram edge onto the definition. The chain resolver owns
every segment of a connector end for the same reason — `connect a.p to b.p`
keeps `a::p` and `b::p` distinct.

**A bare library definition is accepted in `:>` without an import.**
`unresolved-type-ref` accepts a name that only the bundled library matches, as
long as the match is not a library FEATURE — so `part def X :> Part;` passes
with no `import Parts::*;`. It is leniency, not the spec: the standard would
have the name imported. Restricting it to non-features is what removes the
harmful half (short names hitting function parameters and unit symbols) while
keeping the convenient one.

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

**Only a sign directly on a bare number is a literal.** `-x`, `--2`, `not true`,
`~x`, `5 - 2` and `-(2)` stay expression strings: the language treats a sign as
an operator, and folding anything beyond a signed literal would erase what the
author wrote. `-(2)` is the deliberate edge — its operand is a number in the
AST because parentheses are transparent, and the mapper looks at the operand's
own text to keep it out. `(-2)` does fold, because there the parentheses wrap
the whole signed literal and the operand's own text is `2`; it re-emits as
`-2`, as `(2.50)` already re-emits as `2.5`. `- 2` (interior space) folds to
`-2` and re-emits without the space, because a lexeme `Number()` cannot read is
never stored. A dangling sign (`= -;`) is a positioned parse error, never a
mapper crash.
`-0` folds to the number -0, which JSON cannot carry; it survives a save only
through `valueText`. Pinned by `text.literal-form.test.ts`.

**No multiplicity follows a feature value.** `= 1500 [0..*]` used to be accepted
(the range landed in `attrs.unit`); a bracket after the value is an expression
now, because the standard puts the multiplicity before the value. So `[0..*]`
and `[*]` are parse errors (`*` is not an expression) — their hint still
speaks of a declaration starting with `*`, a follow-up — while a numeric range
`[1..2]` parses as a bracket operand, is stored verbatim in `attrs.unit` and
re-emits quoted (`['1..2']`) so it reads back. Two neighbours of the same
rule: `transition t first a if x > 0 [y > 0] then b` is ONE guard whose
expression ends in a bracket, not an `if` guard followed by a bracket guard —
the standard has only the `if` form — and `a/b [u]` groups as `a/(b [u])`. No
corpus or in-tree file spelled any of the four. Pinned by
`langium.grammar.test.ts` and `text.bracket-expr.test.ts`.

**A non-ASCII unit symbol must be quoted.** A SysML `BASIC_NAME` is ASCII, so
`²`, `⋅` and `°` cannot appear bare inside a bracket: `[m²]` is a lexer error,
`['m²']` and `[m^2]` are not. The character is not lost when it is written bare
— the mapper slices the unit out of the SOURCE between the bracket offsets, so
`1.5 [m²]` keeps the dimension L² (persisting the parser's truncated `m` would
silently turn 1.5 m² into 1.5 m) and no `dimensional-consistency` warning
follows the lexer error. The serializer re-emits any unit the grammar cannot
read bare in quotes (`['W⋅h']`, `[SI::'watt hour']`), so the file reads back.
Fixture `L2-unicode-unit-symbol`; the round-trip is pinned by
`text.bracket-expr.test.ts` and `text.roundtrip.test.ts`.

**The unit picker offers registry symbols only.** `api.compatibleUnits(u)`
enumerates `UNIT_REGISTRY` filtered by dimension, so the Properties dropdown
offers `t` and `g` beside `kg` but has never offered `km`, and does not offer a
compound or prefixed unit now that the funnel RESOLVES one. Enumerating every
spelling the funnel accepts is unbounded; enumerating the library's 400-odd
short names would make the dropdown unusable. Typing a unit is the way to reach
one, and the resolver accepts it. The enumeration is filtered by DIMENSION, so
the information units now meet their dimensional twins there: a bit rate (T⁻¹,
as the bundle types it) is offered `Hz` and `Bd`, and a storage size (dimension
one) is offered `bit`, `B`, `o`, `Sh`, `Hart`, `nat` and `E`. Converting
100 Mbit/s to 1e8 Hz is arithmetically right and semantically odd; it is the
same cost as `bit/s ≡ Hz` above, recorded rather than papered over with an
eighth dimension axis.

**A soft keyword is a short name, not a declaration name.** `derive` joined
`var`/`filter`/`about`/`locale`/`multiplicity`/`done` as a soft keyword so the
library's `metadata def <derive> …` parses; the same rule makes `part def
derive;` (and `part def filter;`, `attribute var = 1;`) parse with no
diagnostic into a nameless definition plus a keyword-less `'derive'`, because
the name after a consumed keyword is `RefName`, which excludes soft keywords.
Before this pass `derive` there was a loud parse error; the silent split is the
pre-existing shape of every soft keyword, and widening `RefName` means
re-checking the parser's ambiguity set. Pinned by `langium.grammar.test.ts` so
that widening is a decision, not a drift.

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
- **Phase 3 — done, and no longer single-model.** `scripts/agent-repair-bench.ts`
  and four measured runs under `docs/campaign-runs/`: 22/22, then 24/24 on the
  50-fixture corpus, then 31/32 by each of two independent models on the
  80-fixture corpus. See L9 above.
- **Phase 4 — done, three times.** Every defect in §4 fixed and every fixture
  promoted; no `expectFail` remains. The second pass (2026-09-02, commits A–G of
  the open-issues plan) closed the seven items the first pass had recorded as
  limitations, and found three more on the way. The third pass (2026-09-02/03,
  the spec-fidelity plan) took the issues that survived it: the spec
  `BracketExpression` in place of a local pseudo-multiplicity, signed literals
  stored as numbers, derived features as quantities behind a dimension guard,
  compound / quoted / qualified unit spellings and the ISQ information kinds, a
  unit-aware numeric surface, a refused dimension clash, one name resolver where
  there had been two, and a faulted save that reproduces its fault instead of
  laundering it. Measured across it: the corpus grew from 50 fixtures to 80, the
  catalogue from 53 codes to 55, and the rule set from 22 to 23. What is left is
  recorded under "Known limitations", and every count in this document is now
  read off the tree (see §3).
