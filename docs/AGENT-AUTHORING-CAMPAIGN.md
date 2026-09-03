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
| L2 | Syntactic: missing semicolon and brace, extra brace, unknown keyword (with and without a `def` after it), a grammar-legal keyword this tool models no metaclass for, reversed keywords, empty type, bad multiplicity, unfinished unit bracket, a non-ASCII unit symbol written bare, bad expressions, `=` vs `==`, bare `->`, two independent errors | 17 |
| L3 | Referential: unresolved type, connection end, import, transition end, specialization and redefinition; forward references in a package; a type, a specialization or a connector end reached through an import, through inheritance, through a transitive supertype, through an implicit library base or through a library import written in text; an alias used as a type; a name declared in both a supertype and an enclosing namespace, written both ways round; a multi-endpoint dependency naming the endpoint that is missing; plus a pinned behaviour | 23 |
| L4 | Semantic rules **authored as text** rather than built programmatically: duplicate name, blank name, port direction, requirement subject (missing and declared), specialization cycle, self-typed feature, value-type mismatch, dangling `then`, phantom port, connector with one end, unknown unit (in a value and in a constraint body), connection direction and type, signed literal, unit literal in a constraint body, derived-dimension mismatch, dimension clash, temperature difference, compound / qualified / information units | 23 |
| L5 | Recovery and cascade: one bad declaration must not cost the other forty; a nested fault keeps the following declarations in their own bodies; an escaped relationship, an alias body and a hidden multi-line note each stay where they were written | 6 |
| L6 | **Sufficiency invariants over the whole corpus** (see below) | 13 assertions |
| L7 | The command-line contract: exit codes, JSON shape, stdin, strict and `--no-library` modes | 12 tests |
| L9 | **The measurement**: can a model repair the file from the report alone? | `npm run bench` |

Every count in this table is read off the tree, not remembered — the figures
elsewhere that are NOT (the L9 bench results, and §1's account of what was true
before the campaign) are quoted from a dated run file or from history, and say
so where they appear. Measured 2026-09-03: **80 fixture directories** under
`test/fixtures/agent-authoring/` — the L0–L5 rows above sum to it — beside **55
catalogue codes** in `src/text/langium/diagnostic-codes.ts` and **23 validation
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
`0.9999999999 < 1.0` holds, `a != b` at 1e-10 apart is violated, exactly as
the numeric surface judges its residual (`violated = g > tol`), so the two
surfaces cannot disagree on float noise. °C and °F are affine scales, and the
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
a derived dimension); none may sit on an offset scale (°C differences are not
offset-invariant, and the unit-aware evaluator already refuses them); the two
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
copies verbatim, mirroring the solver's own refusal to scale one, so 20 °C does
not arrive as 293.15 K in an equation still read in degrees.

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

### Known limitations, recorded rather than hidden

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
The gates are conservative on purpose: an unresolvable unit, an offset scale, or
operands whose dimensions do not match under a comparison, `+` or `-` leaves the
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
- **Phase 3 — done.** `scripts/agent-repair-bench.ts` and two measured runs
  under `docs/campaign-runs/` (22/22, then 24/24 on the 50-fixture corpus).
  See L9 above.
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
