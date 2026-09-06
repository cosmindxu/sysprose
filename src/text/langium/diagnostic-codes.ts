/**
 * The diagnostic-code catalogue — the single source of truth behind
 * `docs/DIAGNOSTIC-CODES.md` and the Agent Diagnostics Contract.
 *
 * WHY THIS EXISTS. A human reading "Expecting keyword ';' but found `port`"
 * knows what to do. An AI agent repairing its own `.sysml` file needs the same
 * information in fields it can branch on: a STABLE code (messages get reworded,
 * codes do not), the token it should have written, the token it actually wrote,
 * and a one-line hint naming the fix. Chevrotain and Langium already compute
 * all of that and then throw most of it away in the string; this module keeps it.
 *
 * INVARIANT (enforced by `test/unit/diagnostic-codes.test.ts`): every code in
 * {@link DIAGNOSTIC_CODES} is documented in `docs/DIAGNOSTIC-CODES.md`, and every
 * code documented there exists here. Adding a new parser/mapper error site means
 * adding a catalogue entry — that is the point.
 */

import type { DiagnosticSource, Severity } from '@validation/types';

/** One catalogue entry. `hint` is a template; `{found}`/`{expected}` are filled in. */
export interface DiagnosticCode {
  /** Stable id, `<family>/<slug>`. Never renamed; deprecate instead. */
  code: string;
  /** Producing stage. */
  source: DiagnosticSource;
  /** Severity this code is normally emitted at. */
  severity: Severity;
  /** One line: when it fires. */
  when: string;
  /** One line an agent can act on. `{found}` / `{expected}` are substituted. */
  hint: string;
}

const CODES = [
  /* ── lexer ── */
  {
    code: 'lexer/illegal-char',
    source: 'lexer',
    severity: 'error',
    when: 'A character that cannot start any token appears in the source.',
    hint: 'Remove the stray character {found}. SysML identifiers are letters, digits and underscore; quote a name containing anything else as \'like this\'. A unit with a non-ASCII symbol must be quoted the same way: `[\'m²\']`, `[\'W⋅h\']`, `[\'°C\']`.',
  },
  {
    code: 'lexer/unterminated-string',
    source: 'lexer',
    severity: 'error',
    when: 'A double-quoted string literal is not closed before end of line/file.',
    hint: 'Close the string with a matching double quote.',
  },
  {
    code: 'lexer/unterminated-comment',
    source: 'lexer',
    severity: 'error',
    when: 'A block comment opened with /* is not closed before end of file.',
    hint: 'Close the block comment with */.',
  },

  /* ── parser ── */
  {
    code: 'parse/mismatched-token',
    source: 'parser',
    severity: 'error',
    when: 'The parser required one specific token and found another. The single most common agent mistake: a missing semicolon or brace.',
    hint: 'Expected {expected} here, found {found}. Insert the expected token before {found}.',
  },
  {
    code: 'parse/no-viable-alt',
    source: 'parser',
    severity: 'error',
    when: 'No grammar alternative matches at this point — usually a misspelled or misordered keyword.',
    hint: 'No SysML declaration starts with {found} here. Check the keyword spelling and order, e.g. `part def Name {` not `def part Name {`.',
  },
  {
    code: 'parse/early-exit',
    source: 'parser',
    severity: 'error',
    when: 'A repetition that requires at least one occurrence found none.',
    hint: 'A required element is missing before {found}.',
  },
  {
    code: 'parse/not-all-input-parsed',
    source: 'parser',
    severity: 'error',
    when: 'The file parsed to completion but text remains — typically one closing brace too many.',
    hint: 'Unexpected {found} after the end of the model. Remove it, or check for an unbalanced closing brace.',
  },
  {
    code: 'parse/error',
    source: 'parser',
    severity: 'error',
    when: 'A parser error of a class this catalogue does not model specifically.',
    hint: 'Syntax error at {found}. Compare the surrounding declaration with examples/vehicle.sysml.',
  },
  {
    code: 'parse/unknown-keyword',
    source: 'parser',
    severity: 'error',
    when: 'A word that no declaration starts with leads a member, so the parser stops on the token after it.',
    hint: 'Unknown declaration keyword {found}; the declaration is kept as an unparsed element and re-emitted verbatim, so saving the file preserves this error instead of hiding it. Use a supported keyword such as part, attribute, port, action, state, requirement or connection.',
  },

  {
    code: 'parse/keyword-order',
    source: 'parser',
    severity: 'error',
    when: 'Declaration keywords appear in the wrong order, e.g. `def part X;`.',
    hint: 'Keywords are in the wrong order. A definition is written `<kind> def Name`, e.g. `part def Vehicle {`, not `def part Vehicle`.',
  },
  {
    code: 'parse/bare-transition-arrow',
    source: 'parser',
    severity: 'error',
    when: 'A bare `A -> B` transition shorthand was used. It is rejected deliberately: it cannot be told apart from a `->` function-operation expression.',
    hint: 'Write the transition with its keyword: `transition A -> B;` (a bare `A -> B` is ambiguous with an expression and is not accepted).',
  },

  /* ── mapper: declarations the grammar accepts but the metamodel does not ── */
  {
    code: 'mapper/unsupported-keyword',
    source: 'mapper',
    severity: 'error',
    when: 'A declaration keyword the grammar accepts has no metaclass in this tool — the KerML type/feature family (namespace, class, feature, step, connector, …).',
    hint: 'This KerML keyword {found} is not modelled; the declaration and its body are preserved verbatim and re-emitted unchanged on save. Rewrite it with a supported keyword such as part, attribute, item, port, action or state.',
  },

  {
    code: 'parse/dangling-then',
    source: 'mapper',
    severity: 'error',
    when: 'A bare `then X;` appears with no preceding succession in the same scope to chain from.',
    hint: 'A bare `then X;` continues the previous succession. Start the chain with `first A then B;`, or write this one in full.',
  },

  {
    code: 'parse/conflicting-direction',
    source: 'mapper',
    severity: 'warning',
    when: 'One feature declares two different directions, e.g. `in port out x`.',
    hint: 'A feature has one direction. Remove {found} or the other one; the first direction written was kept.',
  },

  /* ── mapper: unresolved references (non-fatal; the textual name is kept) ── */
  {
    code: 'ref/unresolved-type',
    source: 'mapper',
    severity: 'warning',
    when: 'A type reference after `:` names nothing in scope or in the standard library.',
    hint: 'Define the referenced type, import the package that declares it, or correct the spelling.',
  },
  {
    code: 'ref/unresolved-connection-end',
    source: 'mapper',
    severity: 'warning',
    when: 'A connect/connection endpoint names a feature that does not resolve.',
    hint: 'Check the endpoint path: each dotted segment must name a feature of the preceding one, visible from the connection owner.',
  },
  {
    code: 'ref/unresolved-transition-end',
    source: 'mapper',
    severity: 'warning',
    when: 'A transition source or target names no state in scope.',
    hint: 'Declare the state before referencing it, or correct the name.',
  },
  {
    code: 'ref/unresolved-specialization',
    source: 'mapper',
    severity: 'warning',
    when: 'A specialization/subsetting/redefinition target does not resolve.',
    hint: 'Check the specialized name is declared and visible from here.',
  },
  {
    code: 'ref/unresolved-reference',
    source: 'mapper',
    severity: 'warning',
    when: 'A reference in a relationship statement (bind, disjoint, reference…) does not resolve.',
    hint: 'Check the referenced name is declared and visible from here.',
  },
  {
    code: 'ref/unresolved-dependency-end',
    source: 'mapper',
    severity: 'warning',
    when: 'A dependency client or supplier does not resolve.',
    hint: 'Declare the client/supplier element, or correct the name.',
  },
  {
    code: 'ref/unresolved-allocation-end',
    source: 'mapper',
    severity: 'warning',
    when: 'An allocation source or target does not resolve.',
    hint: 'Declare the allocated element, or correct the name.',
  },
  {
    code: 'ref/unresolved-requirement',
    source: 'mapper',
    severity: 'warning',
    when: 'A satisfy/verify statement names a requirement or satisfier that does not resolve.',
    hint: 'Declare the requirement and the satisfying element before the satisfy statement, or correct the names.',
  },
  {
    code: 'ref/unresolved-flow-end',
    source: 'mapper',
    severity: 'warning',
    when: 'A flow source or target does not resolve.',
    hint: 'Check the flow endpoint names a visible feature.',
  },
  {
    code: 'ref/unresolved-alias-target',
    source: 'mapper',
    severity: 'warning',
    when: 'An alias names a target that does not resolve.',
    hint: 'Declare the alias target, or correct the name.',
  },
  {
    code: 'ref/unresolved-import',
    source: 'mapper',
    severity: 'warning',
    when: 'An import names a package that is not loaded.',
    hint: 'Check the imported package name; only the bundled standard library and packages declared in this file are visible.',
  },

  /* ── import / file recognition ── */
  {
    code: 'import/not-text',
    source: 'import',
    severity: 'error',
    when: 'Content offered as SysML text is actually JSON (it starts with `{`).',
    hint: 'This looks like JSON, not SysML textual notation. Import it as model JSON, or supply a .sysml source file.',
  },
  {
    code: 'import/malformed-json',
    source: 'import',
    severity: 'error',
    when: 'A file offered as model JSON does not parse as JSON.',
    hint: 'Fix the JSON syntax, or supply the model as .sysml text instead.',
  },
  {
    code: 'import/wrong-extension',
    source: 'import',
    severity: 'warning',
    when: 'The source was given a file name whose extension is neither .sysml, .kerml nor .txt; the content was parsed as SysML text anyway. Text read from a pipe or a buffer carries a display name instead and is exempt.',
    hint: 'Rename the file to .sysml so every tool recognises it.',
  },
  {
    code: 'import/bom-stripped',
    source: 'import',
    severity: 'info',
    when: 'A UTF-8 byte-order mark was removed before parsing.',
    hint: 'Write .sysml files as UTF-8 without a BOM.',
  },
  {
    code: 'import/crlf-normalized',
    source: 'import',
    severity: 'info',
    when: 'Windows line endings were normalised to LF before parsing; reported positions are in the normalised text.',
    hint: 'No action needed. Use LF line endings to keep reported positions identical to your file.',
  },
  {
    code: 'import/internal-error',
    source: 'import',
    severity: 'error',
    when: 'The checker itself failed. Reported as an error rather than a clean result so a failure is never mistaken for a valid model.',
    hint: 'This is a tool defect, not a model error. Please report it with the input that triggered it.',
  },

  /* ── validation rules (docs: src/validation/rules.ts) ── */
  {
    code: 'validation/unresolved-import',
    source: 'validation',
    severity: 'warning',
    when: 'An import names a namespace that is not loaded, so it brings nothing into scope.',
    hint: 'Check the imported namespace name. Only the bundled standard library and packages declared in this file are visible.',
  },
  {
    code: 'validation/split-declaration',
    source: 'validation',
    severity: 'warning',
    when: 'A declaration parsed to nothing but a keyword — no name, type, value, body or specialization — which happens when a misplaced word splits one declaration into two.',
    hint: 'Check the declaration for a stray or repeated keyword. A port is written `in port name : Type;` (direction first, then the keyword).',
  },
  {
    code: 'validation/unknown-unit',
    source: 'validation',
    severity: 'warning',
    when: 'A value, a constraint body, a transition guard or an expression value carries a `[unit]` the engine does not know, so no dimensional check or unit conversion can be applied to it; a constraint using it answers unknown.',
    hint: 'Use a registered unit symbol (SI units and their prefixes, the information units bit, B and o — these three also take the binary prefixes Ki..Yi — plus Sh, Hart, nat, Bd, Wh, Ah, min, h, °C, ft, lb, …), qualified or not (`[kg]`, `[SI::kg]`). The information units take the MAGNIFYING prefixes only (`[kB]`, `[Mbit]`), so `[dB]` is not one of them: the decibel is a logarithmic ratio, not a unit this engine can convert. Compound units are written as an expression — `[m/s]`, `[kg*m/s^2]`, `[Mbit/s]`, `[J/(kg*K)]`, `[1/s]` for a reciprocal — each atom taking its own qualifier (`[m/SI::s]`), or with the library spellings `⋅` and superscripts, which must be quoted because the grammar reads only ASCII names: `[\'W⋅h\']`, `[\'m²\']`. A library name resolves quoted and qualified (`[SI::\'watt hour\']`, `[SI::\'metre per second\']`); the worded forms per/squared/cubed are understood, longer ones are not — write the symbol. A symbol that is also a keyword is quoted (`[\'in\']` for the inch, in a value position). A value with an unknown unit is treated as a bare number in arithmetic, which is usually wrong; a constraint that reads one cannot be judged.',
  },
  {
    code: 'validation/derived-dimension-mismatch',
    source: 'validation',
    severity: 'warning',
    when: 'An expression-valued feature derives to a physical dimension that disagrees with its declared type — a `Real` computed from dimensioned quantities (usually a hand-rolled conversion such as `… / power * 60.0`), or an ISQ kind whose derivation has another dimension. The feature is excluded from unit-aware constraint evaluation, so a constraint reading it answers unknown.',
    hint: 'Two repairs. (1) Type the feature by the ISQ kind its derivation has and drop the hand conversion — `enduranceMin : Real = capacity / power * 60.0` becomes `endurance : ISQ::DurationValue = capacity / power`, and the comparison converts: `endurance >= 45.0 [min]`. (2) When the value really is a pure ratio, give the inlined constant its unit so the dimensions cancel: `mtow / 25.0` becomes `mtow / 25.0 [kg]`.',
  },
  {
    code: 'validation/connection-compatibility',
    source: 'validation',
    severity: 'warning',
    when: 'A connection joins two `out` (or two `in`) ports, or two ports whose port definitions share no ancestor.',
    hint: 'Wire an `out` port to an `in` port (or use `inout`), and give both ends the same port definition — or a conjugated one (`~PortDef`) on the receiving side.',
  },
  {
    code: 'validation/duplicate-name',
    source: 'validation',
    severity: 'error',
    when: 'Two sibling elements in the same namespace declare the same name.',
    hint: 'Rename one of them, or move it to a different owner. Sibling names must be unique.',
  },
  {
    code: 'validation/blank-name',
    source: 'validation',
    severity: 'error',
    when: 'A named element has an empty or whitespace-only name.',
    hint: 'Give the element a name, or remove the empty quotes to leave it anonymous.',
  },
  {
    code: 'validation/unwritable-note-body',
    source: 'validation',
    severity: 'error',
    when: 'A doc/comment/rep body, or a requirement statement, contains the two characters that end a note — which the notation gives no way to escape.',
    hint: 'Remove them from the text. Written into a note they would close it early, and everything after them would be read back as declarations instead of prose.',
  },
  {
    code: 'validation/dangling-endpoint',
    source: 'validation',
    severity: 'error',
    when: 'A relationship points at an element id that is not in the model.',
    hint: 'A referenced element is missing; declare it, or remove the relationship.',
  },
  {
    code: 'validation/unresolved-type-ref',
    source: 'validation',
    severity: 'error',
    when: 'A type reference does not resolve to any declared or library type.',
    hint: 'Declare the type, import the package that provides it, or correct the spelling.',
  },
  {
    code: 'validation/port-direction',
    source: 'validation',
    severity: 'error',
    when: 'A port has no direction, or one that is not in/out/inout.',
    hint: 'Declare the port direction, e.g. `in port fuelIn : FuelPort;`.',
  },
  {
    code: 'validation/malformed-multiplicity',
    source: 'validation',
    severity: 'error',
    when: 'A multiplicity is not `n`, `n..m`, `n..*` or `*`.',
    hint: 'Write the multiplicity as `[1]`, `[0..1]`, `[1..*]` or `[*]`.',
  },
  {
    code: 'validation/connector-endpoints',
    source: 'validation',
    severity: 'error',
    when: 'A connection or connector has fewer than two endpoints.',
    hint: 'Give the connection both ends, e.g. `connect a.p to b.q;`.',
  },
  {
    code: 'validation/requirement-subject',
    source: 'validation',
    severity: 'warning',
    when: 'A requirement has no subject: none declared, none inherited from its definition, and no `satisfy`/`verify` naming one.',
    hint: 'Add a `subject` to the requirement, or a `satisfy … by …` statement naming what satisfies it.',
  },
  {
    code: 'validation/redefinition-target-missing',
    source: 'validation',
    severity: 'error',
    when: 'A redefinition, subsetting or reference-subsetting target is missing or unresolved.',
    hint: 'Declare the redefined/subsetted feature, or correct the name after `:>>` / `:>`.',
  },
  {
    code: 'validation/containment-cycle',
    source: 'validation',
    severity: 'error',
    when: 'An element owns itself, directly or through a cycle.',
    hint: 'Break the ownership cycle: an element cannot contain one of its own ancestors.',
  },
  {
    code: 'validation/specialization-cycle',
    source: 'validation',
    severity: 'error',
    when: 'Specialization relationships form a cycle.',
    hint: 'Break the specialization cycle: a type cannot specialize itself, directly or indirectly.',
  },
  {
    code: 'validation/orphan-relationship',
    source: 'validation',
    severity: 'warning',
    when: 'A relationship element is not owned by any element.',
    hint: 'Nest the relationship inside the element it belongs to.',
  },
  {
    code: 'validation/feature-typing-non-type',
    source: 'validation',
    severity: 'error',
    when: 'A feature is typed by something that is not a type.',
    hint: 'Type the feature with a definition (`part def`, `attribute def`, `port def`…), not with a usage.',
  },
  {
    code: 'validation/connector-end-not-feature',
    source: 'validation',
    severity: 'error',
    when: 'A connector endpoint does not resolve to a feature.',
    hint: 'Connect features (parts, ports, attributes), not definitions.',
  },
  {
    code: 'validation/value-type-mismatch',
    source: 'validation',
    severity: 'warning',
    when: 'A literal value is inconsistent with the declared type.',
    hint: 'Make the literal match the declared type, e.g. a number for `Real`, `true`/`false` for `Boolean`.',
  },
  {
    code: 'validation/redefinition-conformance',
    source: 'validation',
    severity: 'warning',
    when: 'A redefining feature’s type does not conform to the redefined feature’s type.',
    hint: 'Type the redefining feature with the redefined type or a specialization of it.',
  },
  {
    code: 'validation/constraint-violation',
    source: 'validation',
    severity: 'warning',
    when: 'A constraint or requirement expression is violated, or cannot be evaluated.',
    hint: 'Check the constraint expression and the values it reads; an unevaluable constraint usually references a feature with no value, or compares two different physical dimensions — read the message, which names the actual fault.',
  },
  {
    code: 'validation/dimensional-consistency',
    source: 'validation',
    severity: 'warning',
    when: 'A value’s unit has a different physical dimension than its quantity kind.',
    hint: 'Use a unit of the declared quantity kind, e.g. a mass unit for a mass attribute.',
  },

  /* ── formal verification (docs: docs/04-formal-verification-plan.md) ── */
  // The whole lane files under ONE source and ONE prefix. These are INFO
  // because none of them is a defect in the model: they are the tool saying
  // what it will and will not undertake, and a reader who is never told infers
  // silence as agreement.
  {
    code: 'verification/unsupported-expression',
    source: 'verification',
    severity: 'info',
    when: 'A relation is outside the fragment the verification lane encodes — a name that resolves to nothing, a body that does not parse, a dimension clash, arithmetic on an offset scale, a collection-valued feature, a remainder, a variable exponent or a non-numeric operand.',
    hint: 'The relation is listed with the gate that refused it and nothing is claimed about it. Check the names it reads, then rewrite it inside quantifier-free arithmetic over single-valued scalar features, or expect it in the `obligations --missing` histogram.',
  },
  {
    code: 'verification/contract-no-guarantee',
    source: 'verification',
    severity: 'info',
    when: 'A requirement states assumptions and guarantees nothing, so its contract has nothing to show.',
    hint: 'Add a `require constraint { … }` stating what the requirement guarantees, or read the assumptions as context rather than as an obligation.',
  },
  {
    code: 'verification/nonstandard-clause-location',
    source: 'verification',
    severity: 'info',
    when: 'An `assume` or `require` clause is written in a body the standard\'s `ActionBodyItem` does not admit — an action definition, for instance. Sysprose parses it; the specification does not offer it there.',
    hint: 'The standard writes a behaviour precondition as `assert constraint precondition { … }`, as a `guard` on the incoming transition, or as a requirement whose `subject` is the behaviour; `contracts` reads all three.',
  },
  // `verification/foreign-keyword` is emitted by `contracts --keywords` and by
  // `obligations --from-keywords` (one row per obligation a keyword actually
  // filed); `verification/keyword-names-nothing` is emitted by
  // `contracts --keywords` ALONE, because a worklist reports the vocabulary it
  // acted on and a keyword naming nothing acts on nothing. Neither comes from
  // anywhere else — `npm run check` does not judge a keyword, so reading
  // somebody else's vocabulary cannot change what the checker says about their
  // file.
  {
    code: 'verification/foreign-keyword',
    source: 'verification',
    severity: 'info',
    when: 'A prefix keyword is a third-party spelling this tool recognises — `#Exception`, `#exception`, `#precondition`, `#postcondition` — read through the foreign-alias table rather than named by SysML v2 or shipped by Sysprose.',
    hint: 'The line names the spelling and what it was read as. It is neither standard vocabulary nor a Sysprose keyword, and it files nothing unless `obligations --from-keywords` asked it to; write `assume constraint` / `require constraint` and no keyword is needed at all.',
  },
  {
    code: 'verification/keyword-names-nothing',
    source: 'verification',
    severity: 'info',
    when: 'A `#keyword` resolves to no `metadata def` in scope — a misspelling, or a vocabulary the file never declares or imports.',
    hint: 'Declare or import the `metadata def` the keyword names — `import SysproseVerification::*;` for the one this tool ships — or correct the spelling. The keyword is kept in the file either way.',
  },

  // The six `verify` codes. They are what an INCONCLUSIVE run says, and the
  // exit contract is written over them rather than over prose: `verify` exits 2
  // on every one, and `--allow-inconclusive` lowers exactly two of them —
  // `verification/unsupported-construct` and (from the SMT engine)
  // `verification/timeout`. It never lowers `tool-absent`, never lowers
  // `vacuous-pass`, never lowers `design-admitted`, and never outranks a
  // refutation, which is exit 1. All six are INFO: none of them is a defect in
  // the model, and none of them is a verdict — they are the tool saying what it
  // did not decide, which is the one thing a silence could never say.
  {
    code: 'verification/vacuous-pass',
    source: 'verification',
    severity: 'info',
    when: 'A requirement is discharged by an antecedent that does not hold — its `assume` clause is false at the model’s values, or its premises are unsatisfiable. The standard reads `allTrue(assumptions) implies allTrue(constraints)`, which makes such a requirement true; this tool reports it as undecided instead. That is a declared deviation, recorded in docs/CONFORMANCE.md.',
    hint: 'Fix the assumption so it holds, or drop it: a requirement that only holds when something false is true says nothing about the design. The row exits 2 with and without `--allow-inconclusive`.',
  },
  {
    code: 'verification/not-evaluable',
    source: 'verification',
    severity: 'info',
    when: 'A relation this lane encodes could not be decided at the model’s own values — a feature it reads carries no value, a derived quantity cannot be compared as a bare number, or the expression did not evaluate to a boolean.',
    hint: 'Give the features it reads values, or compare against a unit literal of the right dimension. `--allow-inconclusive` deliberately does NOT forgive this: an obligation nobody could evaluate is not an obligation that holds.',
  },
  {
    code: 'verification/unsupported-construct',
    source: 'verification',
    severity: 'info',
    when: 'An obligation is outside the fragment this lane encodes at all — a gate refused the relation, or the requirement carries prose and no constraint body, so there is nothing to decide.',
    hint: 'Run `npm run sysprose -- obligations <file> --missing` for the histogram of what was refused and why, then rewrite the relation inside quantifier-free arithmetic over single-valued scalar features. This is one of the two codes `--allow-inconclusive` may lower to exit 0.',
  },
  {
    code: 'verification/tool-absent',
    source: 'verification',
    severity: 'info',
    when: 'The engine that was asked for could not run: `--engine smt`, or `--engine auto` with no solver backend to resolve to. Every obligation in the run is reported under this code.',
    hint: 'Install the solver, or ask for `--engine literal`, which evaluates at the model’s own values and says `holds-at-values` — a point evaluation, never a proof. `--allow-inconclusive` never lowers this: a missing solver must never be a green build.',
  },
  {
    code: 'verification/design-admitted',
    source: 'verification',
    severity: 'info',
    when: 'An obligation was refuted only after `--free` released a feature value the model states. A `=` value is a binding, so the counterexample is a design the model admits, not a violation of it.',
    hint: 'Read it as "the requirement fails if this feature is allowed to move", not as "the requirement fails". Re-run without `--free` for the verdict at the model’s values. It exits 2, never 1, and `--allow-inconclusive` does not lower it.',
  },
  {
    // Documented HERE, in the commit that names it, rather than in the commit
    // that first emits it. `--allow-inconclusive`'s scope is stated over CODES
    // and this is one of the two it lowers, so `verify --help`,
    // docs/CLI-REFERENCE.md and docs/USER-GUIDE.md all print the string today
    // and told the reader to look it up in a catalogue that did not have it.
    // A code the tool names to a person is a code the catalogue must explain,
    // whether or not an engine can reach it yet; the guard in
    // test/unit/diagnostic-codes.test.ts now enforces exactly that.
    code: 'verification/timeout',
    source: 'verification',
    severity: 'info',
    when: 'A solver was asked and did not answer inside the time it was given — it returned `unknown` after the timeout rather than sat or unsat. No engine in this build emits it; it is the SMT engine’s undecided code and the second of the two `--allow-inconclusive` may lower.',
    hint: 'Raise the timeout, narrow the obligation, or read the row as undecided — a solver that ran out of time has said nothing about whether the requirement holds. It exits 2 by default.',
  },

  /* ── round-trip oracle ── */
  {
    code: 'roundtrip/unparseable-serialization',
    source: 'import',
    severity: 'error',
    when: 'Text produced by this tool\'s own serializer does not parse back. A silent-misparse guard.',
    hint: 'Tool defect: the serializer emitted notation the grammar rejects. See docs/AGENT-AUTHORING-CAMPAIGN.md "Open defects".',
  },
] as const satisfies readonly DiagnosticCode[];

/** Every catalogue entry, in documentation order. */
export const DIAGNOSTIC_CODES: readonly DiagnosticCode[] = CODES;

/** Union of every valid code string. */
export type KnownDiagnosticCode = (typeof CODES)[number]['code'];

const BY_CODE = new Map<string, DiagnosticCode>(CODES.map((c) => [c.code, c]));

/** Look up a catalogue entry. */
export function diagnosticCode(code: string): DiagnosticCode | undefined {
  return BY_CODE.get(code);
}

/** Is `code` in the catalogue? */
export function isKnownCode(code: string): boolean {
  return BY_CODE.has(code);
}

/**
 * Render a code's hint, substituting `{found}` and `{expected}`.
 * Unfilled placeholders are dropped rather than shown to the reader.
 */
export function renderHint(
  code: string,
  subs: { found?: string; expected?: readonly string[] } = {},
): string | undefined {
  const entry = BY_CODE.get(code);
  if (!entry) return undefined;
  const found = subs.found ? `\`${subs.found}\`` : '';
  const expected =
    subs.expected && subs.expected.length > 0
      ? subs.expected.map((e) => `\`${e}\``).join(' or ')
      : '';
  return entry.hint
    .replace(/\{found\}/g, found)
    .replace(/\{expected\}/g, expected)
    .replace(/\s{2,}/g, ' ')
    // Only tidy a space before punctuation that ENDS a clause — never inside a
    // token like ".sysml", which an earlier version of this rule mangled.
    .replace(/\s+([.,])(?=\s|$)/g, '$1')
    .trim();
}

/* ───────────────────── Chevrotain / Langium classification ───────────────── */

/** Keywords that introduce a definition; seeing one out of place is diagnostic. */
const DEF_KEYWORDS = new Set(['def']);

/**
 * Refine a parser error using the tokens AROUND it.
 *
 * Chevrotain reports where parsing STOPPED, which for the two commonest agent
 * mistakes is one token past the actual error: `blok def Vehicle;` is reported
 * as "expecting '}' but found 'def'", and the obvious repair suggested by that
 * message — insert a brace — makes the file worse. The previous token is what
 * the agent got wrong, so this looks at it.
 *
 * Returns a refined `{code, found, hintFound}` or `undefined` to keep the
 * default classification.
 */
export function refineParserError(
  defaultCode: string,
  found: string | undefined,
  previous: string | undefined,
  sourceLine?: string,
  /**
   * Chevrotain token-type names for the two tokens (`'ID'` for an identifier,
   * the keyword itself for a keyword). Taken from the lexer rather than guessed
   * from the spelling, so the grammar stays the single source of truth about
   * what is a keyword.
   */
  kinds?: { found?: string; previous?: string },
): { code: string; found: string } | undefined {
  // `off -> on;` — the bare transition shorthand. The parser stops at the `;`,
  // several tokens past the `->`, so the token pair alone cannot see it; the
  // line can. Checked first because it is the most specific signal.
  if (sourceLine !== undefined && sourceLine.includes('->') && !/\btransition\b/.test(sourceLine)) {
    return { code: 'parse/bare-transition-arrow', found: '->' };
  }
  if (found === undefined) return undefined;
  // `blok def Vehicle;` — an unknown word immediately before `def`. The unknown
  // word is the mistake, not the `def` the parser tripped on.
  if (DEF_KEYWORDS.has(found) && previous !== undefined && /^[A-Za-z_]\w*$/.test(previous)) {
    return { code: 'parse/unknown-keyword', found: previous };
  }
  // `def part Vehicle;` — `def` where a declaration should start, with no
  // identifier before it: the keywords are the right ones in the wrong order.
  if (DEF_KEYWORDS.has(found)) {
    return { code: 'parse/keyword-order', found };
  }
  // `blok q : T;` — an unknown word leading a declaration with no `def` after
  // it to give the game away. Both tokens must be IDENTIFIERS (a grammar
  // keyword is never the mistake here), and the unknown word must be the first
  // WHOLE word written on the line the parser stopped on. That line test is
  // what separates this from a missing semicolon (`part a` / `part b;`: the
  // line starts with `part`, not with `a`) and from the tail of a qualified
  // name (`A::B c;`: the line starts with `A::B`, not with `B`).
  //
  // "Whole word" is load-bearing, not pedantry: a raw prefix test also matched
  // `Mass::M m;` — where the tail segment `M` happens to spell the start of
  // `Mass` — and reported the author's own type name as a misspelled keyword.
  // The qualified-name case only ever looked safe because the examples were
  // alphabetically lucky.
  if (kinds?.found === 'ID' && kinds?.previous === 'ID' && previous !== undefined) {
    const line = sourceLine?.trimStart();
    const rest = line?.startsWith(previous) === true ? line.slice(previous.length) : undefined;
    if (rest !== undefined && !/^[\w:]/.test(rest)) {
      return { code: 'parse/unknown-keyword', found: previous };
    }
  }
  return defaultCode === 'parse/error' ? undefined : undefined;
}

/**
 * Map a Chevrotain recognition-exception class to a catalogue code.
 * `name` values come from chevrotain's exception constructors.
 */
export function codeForParserError(name: string | undefined): string {
  switch (name) {
    case 'MismatchedTokenException':
      return 'parse/mismatched-token';
    case 'NoViableAltException':
      return 'parse/no-viable-alt';
    case 'EarlyExitException':
      return 'parse/early-exit';
    case 'NotAllInputParsedException':
      return 'parse/not-all-input-parsed';
    default:
      return 'parse/error';
  }
}

/**
 * Recover the expected-token list from a Langium/Chevrotain error message.
 *
 * Langium's `LangiumParserErrorMessageProvider` formats mismatches as
 * ``Expecting keyword ';' but found `port`.`` / ``Expecting token of type 'ID' …``
 * / ``Expecting end of file but found `}`.`` — the structured `expected` token
 * type is not on the exception, so this is the only place it survives. Returns
 * `[]` when the message does not follow the pattern (never throws).
 */
export function expectedFromMessage(message: string): string[] {
  const kw = /Expecting keyword '([^']+)'/.exec(message);
  if (kw) return [kw[1]];
  const label = /Expecting `([^`]+)`/.exec(message);
  if (label) return [label[1]];
  const tokenType = /Expecting token of type '([^']+)'/.exec(message);
  if (tokenType) return [tokenType[1]];
  if (/Expecting end of file/.test(message)) return ['<end of file>'];
  // `NoViableAltException` lists alternatives as: expecting one of these possible Token sequences:
  const alts = [...message.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim()).filter(Boolean);
  return alts.length > 0 ? [...new Set(alts)] : [];
}

/** The token text a parser error points at, if the message carries one. */
export function foundFromMessage(message: string): string | undefined {
  const m = /but found `([^`]*)`/.exec(message);
  return m ? m[1] : undefined;
}
