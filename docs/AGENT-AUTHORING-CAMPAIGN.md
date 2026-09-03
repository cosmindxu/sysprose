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
| L2 | Syntactic: missing semicolon and brace, extra brace, unknown keyword, reversed keywords, empty type, bad multiplicity, unfinished unit bracket, bad expressions, `=` vs `==`, bare `->`, two independent errors | 14 |
| L3 | Referential: unresolved type, connection end, import, transition end, specialization; forward references in a package; types reached through an import, through inheritance, and through a library import written in text; plus a pinned behaviour | 10 |
| L4 | Semantic rules **authored as text** rather than built programmatically: duplicate name, blank name, port direction, requirement subject (missing and declared), specialization cycle, value-type mismatch, dangling `then`, phantom port, unknown unit (in a value and in a constraint body), connection direction and type, signed literal, unit literal in a constraint body, derived-dimension mismatch, temperature difference | 18 |
| L5 | Recovery and cascade: one bad declaration must not cost the other forty; a nested fault keeps the following declarations in their own bodies | 3 |
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

### Known limitations, recorded rather than hidden

**Re-homing cannot recover the faulty declaration itself, and can mis-home a
file that is both faulted and brace-balanced by coincidence.** It repairs
containment from the brace structure, which is all the parser leaves intact;
the residue of the bad declaration stays a keyword-less element.


**Unit spellings beyond a bare or qualified registry symbol do not resolve,
and the numeric solver still drops a unit-bearing body.** A quoted library
name (`[SI::'watt hour']`, `['°C']` written inside a body rather than as a
value) and a compound unit (`[mi / gal]`) evaluate to unknown, and
`unknown-unit` warns on them; the model-free normalisation funnel is the next
item. `checkConstraintsNumeric` parses bodies with the scalar grammar, so a
relation carrying `[unit]` is absent from the numeric Check surface rather
than judged — the validation surface is the one that answers today — and the
Solve/MoE surfaces still read a derived dimensioned value as a raw magnitude
(`endurance` solves to 0.79 on the example, 640 × 0.8 / 650 read unitless)
until the solver commit scales relations.

**Compound units and an information dimension are not representable.** The
registry is a fixed table with generic single-prefix decomposition; `W*h`,
`bit/s` and `m^2` do not resolve, and `Dimension` has no information axis, so
data rates stay `Real`.

**Forward and backward references can resolve differently when a name is both
inherited and in an outer scope.** The binder (forward references) consults
inherited members at each scope before walking outward, as the spec says; the
mapper (backward references, resolved at parse time) walks owned members only.
A name declared both in a supertype and in an enclosing package therefore binds
to the inherited one if written before its declaration and the outer one if
after. Documented in `src/core/scope.ts` until the mapper is taught to defer.


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
- **Phase 4 — done, twice.** Every defect in §4 fixed and every fixture promoted;
  no `expectFail` remains. The second pass (2026-09-02, commits A–G of the
  open-issues plan) closed the seven items the first pass had recorded as
  limitations, and found three more on the way. What is left is recorded under
  "Known limitations".
