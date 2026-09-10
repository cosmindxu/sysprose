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
  {
    // The one VALIDATION rule the verification lane adds, and it is here rather
    // than under `verification/*` because `npm run check` is what raises it: a
    // reader who never runs `verify` still has to be told that the verdict in
    // their file was reached over a different model. The lane's own prefix is
    // for what the ENGINES say; this is what the checker says about the file.
    code: 'validation/stale-evidence',
    source: 'validation',
    severity: 'warning',
    when: 'An attached evidence record names a model digest that is no longer this model\u2019s: the file was edited after the verdict was recorded. The digest is over the whole user model, so the edit may be anywhere \u2014 the message names the requirement\u2019s own slice, which is what has to be re-read.',
    hint: 'Re-run `npm run sysprose -- verify <file> --record evidence.json` and `evidence-attach`, or take the stale record off with `evidence-detach`. A stale record is never counted as discharged, and the verdict facet beside it stands on nothing until it is re-recorded.',
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
    when: 'A relation is outside the fragment the verification lane encodes — a name that resolves to nothing, a body that does not parse, a dimension clash, arithmetic on an offset scale, a collection-valued feature, a remainder, a variable exponent or a non-numeric operand. `refine` also files a CONNECTOR here when it declines to read one as a value equality: a bare `connection` states that two features are joined and nothing about their values, and an `allocate` or an interface is not a `connect` at all, so neither enters the connection assertion γ.',
    hint: 'The relation is listed with the gate that refused it and nothing is claimed about it. Check the names it reads, then rewrite it inside quantifier-free arithmetic over single-valued scalar features, or expect it in the `obligations --missing` histogram. For a connector the refusal is a modelling one rather than a fragment one: `bind` the attributes if they are one quantity, or add the item flow that carries the value — `--connections-as-equalities` opts into reading a bare `connect` as an equality, and reads only `connect`.',
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

  // The `verify` codes. The exit contract is written over them rather than over
  // prose: `verify` exits 2 on every UNDECIDED one, and `--allow-inconclusive`
  // lowers exactly two — `verification/unsupported-construct` and
  // `verification/timeout`. It never lowers `tool-absent`, never lowers either
  // vacuity code, never lowers `design-admitted`, and never outranks a
  // refutation, which is exit 1.
  //
  // SEVERITY SPLITS THEM IN TWO, and the split is the reading rule. The
  // undecided codes are INFO: none of them is a defect in the model, and none
  // of them is a verdict — they are the tool saying what it did not decide,
  // which is the one thing a silence could never say. Exactly two are ERRORS
  // because they say something about the MODEL: `verification/refuted`, the
  // violation this lane exists to find, and `verification/vacuous-property`,
  // which exists only because `--strict-vacuity` asked for a vacuity to be
  // loud. A consumer filtering on severity would otherwise read the loudest
  // verdict in a run at the same level as "this construct is outside the
  // fragment".
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
    when: 'A solver was asked and did not answer inside the time it was given — it returned `unknown` after the timeout rather than sat or unsat. It is the SMT engine’s undecided code and the second of the two `--allow-inconclusive` may lower.',
    hint: 'Raise the budget with `--timeout MS`, narrow the obligation, or read the row as undecided — a solver that ran out of time has said nothing about whether the requirement holds. It exits 2 by default, and the row was not retried with a weaker encoding.',
  },
  // The five codes the SMT engine brought with it. Four of them name a way a
  // proof can be VOID rather than absent, which is the failure mode a
  // verification lane has to be loudest about: a run that says nothing is
  // obviously useless, and a run that proves everything from a contradiction
  // looks exactly like a run that worked.
  {
    code: 'verification/refuted',
    source: 'verification',
    severity: 'error',
    when: 'A requirement does not hold with every feature at the value the model binds it to. Both engines file it: the literal one evaluates the relation and reads it as false, and the SMT one finds `A ∧ P ∧ ¬G` satisfiable and confirms the witness in process. `check-behaviour` files the same code for a behavioural property a bad-prefix search REFUTED: a run of the configuration graph that breaks the pattern, printed step by step. It is the one code on a DECIDED row, and the run exits 1.',
    hint: 'Read the row’s `detail` for the two magnitudes the comparison was made on, and the witness for the assignment that breaks the requirement in the units the file stores — or, in the behaviour lane, the witness trace: a run this semantics admits, with the atoms that hold at each observation. A bound can hide a violation and can never invent one, so a refutation stands whether or not the walk finished. Fix the design or the requirement and re-run. `--allow-inconclusive` does not forgive a violation, and exit 1 outranks every undecided row in the same run.',
  },
  {
    code: 'verification/vacuous',
    source: 'verification',
    severity: 'info',
    when: 'The SMT engine found the premises unsatisfiable under the axioms — `A ∧ P` is unsat — so the obligation was discharged by an antecedent that no assignment satisfies. `verification/vacuous-pass` is the literal engine’s weaker sibling: an assumption false AT THE MODEL’S VALUES, rather than one nothing at all can satisfy.',
    hint: 'Read the unsat core printed on the row for the facts that collide, then fix the assumption or drop it: an obligation discharged for free says nothing about the design. It is inconclusive and exits 2, no flag launders it, and `--strict-vacuity` raises it to `verification/vacuous-property` without changing the exit code.',
  },
  {
    code: 'verification/vacuous-property',
    source: 'verification',
    severity: 'error',
    when: '`--strict-vacuity` was given and an obligation was vacuous. It is the same row as `verification/vacuous` or `verification/vacuous-pass`, raised from an info line to an error so a vacuity cannot be scrolled past. `check-behaviour` raises it from a third row, which carries no code of its own: a property whose scope no run of an exhaustively walked machine opens, or a `precedence` whose P never occurs.',
    hint: 'The flag changes the code and the severity and NOTHING else: the claim stays `vacuous`, the row stays undecided, and the run exits 2 exactly as it does without the flag. Fix the antecedent so the obligation — or the behavioural property — stands on something that can hold.',
  },
  {
    code: 'verification/inconsistent-axioms',
    source: 'verification',
    severity: 'info',
    when: 'The once-per-run consistency check found the axiom set itself unsatisfiable — `check(A)` is unsat. Every obligation in the run is reported under this code, because a negation is unsat under a contradictory context whatever it says, and a proof from a contradiction is void.',
    hint: 'Read the unsat core named on the row: it is the smallest set of the model’s own facts the solver found colliding. Nothing in the run was decided until they are reconciled. `--allow-inconclusive` never lowers this — proving everything is not the same as proving anything.',
  },
  {
    // The one code `consistency` writes back, and the one code in this lane
    // that is about a requirement SET rather than about one obligation.
    code: 'verification/inconsistent-requirements',
    source: 'verification',
    severity: 'error',
    when: 'No design point satisfies all the requirements on one subject at once: `consistency` asserted each of them under a tracking literal — as `assume ⇒ require`, the reading the shipped library states — and the solver answered unsat. The row names the conflicting subset the unsat core produced, by requirement and by the qualified name of each relation in it.',
    hint: 'Removing or weakening any one member of the named subset is where a fix starts; `--minimize` reduces the subset by deletion until every member is needed, and only a loop that ran to completion may call it minimal. By default the question is asked with every feature value the file STATES released — a value expression that reads no other feature — so this is a conflict between the requirements themselves and not between a requirement and a value; `--with-values` re-pins them and asks the weaker question, and every line names the mode it was computed in. Requirements guarded by `assume` clauses that cannot both hold are NOT reported here: each requirement is read as an implication, so mode- and phase-conditional requirements never contradict each other. It is a decided finding about the model and the run exits 1; no flag forgives one.',
  },

  // The four codes `refine` writes back. They are about an ARCHITECTURE rather
  // than about one obligation or one requirement set, and they split the way
  // the rest of this lane splits: the two that say the model is wrong are
  // errors and exit 1, the two that say the tool decided nothing are info lines
  // and exit 2.
  {
    code: 'verification/refinement-failed',
    source: 'verification',
    severity: 'error',
    when: 'A refinement obligation was refuted: the component contracts, together with the equalities the model states, admit an implementation that breaks the system contract (obligation (3)) or that fails a component’s own assumption (obligation (4)). The row carries a witness, re-read through this tool’s own evaluator before it was printed.',
    hint: 'Read the witness: it is an implementation every component contract admits and the system contract forbids. The obligations are Cimatti’s Theorem 1 in NORMAL FORM (`nf(C) = ¬A ∨ G`), so a component whose assumption is false contributes nothing to the entailment — which is exactly why mutual support (A₁ = G₂, A₂ = G₁) cannot buy a verdict here. Strengthen a sibling’s guarantee, weaken the system guarantee, or state the connection that makes the two quantities one. It is a decided finding about the model and the run exits 1; no flag forgives one. Nothing in this verdict is about ordering or time.',
  },
  {
    code: 'verification/unconnected-assumption',
    source: 'verification',
    severity: 'error',
    when: 'A component assumption was not discharged, and NOTHING in the decomposition reaches the quantity it is about: no `bind` edge, no item flow, and no sibling contract mentions it. The structural half of a refuted obligation (4), separated from `verification/refinement-failed` because the fix is different — an assumption a sibling DOES constrain, just not strongly enough, is a design shortfall and is filed under that other code, since no `bind` can repair it.',
    hint: 'A bare `connection` is not a value equality — it joins two features and says nothing about their values — so an assumption over a feature only a `connect` reaches is discharged by nothing. Bind the attributes if they are one quantity (`bind a.v = b.v;`), or state the item flow that carries the value. `--connections-as-equalities` opts into the OCRA reading in which a bare `connect` IS an equality, and the fact is then printed on every verdict line. It exits 1 like any other refuted obligation.',
  },
  {
    code: 'verification/refinement-undecided',
    source: 'verification',
    severity: 'info',
    when: 'A decomposition was not decided: a gate refused a clause of the system contract (dropping a conjunct of `nf(C)` would weaken the very goal being proved), a component’s `assume` clause was refused, the system contract states no guarantee this lane encodes, or no sub-contract states one.',
    hint: 'Nothing is claimed about this decomposition — never read it as "refines". Run `npm run sysprose -- contracts <file>` to see what each contract states and `obligations <file> --missing` for what this lane cannot reach. `--allow-inconclusive` does NOT lower it: the flag is scoped to `verification/timeout` and `verification/unsupported-construct`, and this is neither.',
  },
  {
    code: 'verification/contract-set-vacuous',
    source: 'verification',
    severity: 'info',
    when: 'Step (0) of the refinement check found the antecedent unsatisfiable: the sub-contracts, the connection assertion and the system assumption cannot hold together. Every refinement obligation over them is entailed by a contradiction, so none of them is claimed.',
    hint: 'Read the unsat core named on the row for the statements that collide — two sibling contracts over one bind class whose guarantees exclude each other are the usual cause. Without this step the tool would print "obligation (3) proved" over an architecture whose components cannot coexist. It is inconclusive, exits 2, and no flag lowers it; `--strict-vacuity` is a `verify` flag and does not change this code.',
  },
  {
    // The code a DERIVATION failure files, kept apart from
    // `verification/refinement-failed` because the two send a reader to
    // different files: a composition failure is about parts that do not add up,
    // and this is about a requirement somebody wrote down from another one.
    code: 'verification/derivation-not-refinement',
    source: 'verification',
    severity: 'error',
    when: 'A `derive` or `refine` chain the file states is not a refinement: the derived requirement assumes MORE than the one it was derived from (so it applies where the parent’s guarantee is not in force), or the derived requirements together do not entail what the parent promised. Both obligations are read with the orientation the mapper stores — `derive requirement D from R` puts R on the source end and `refine requirement X by Y` puts X on the target end, uniform with `satisfy` — and the row carries a witness this tool re-read before printing.',
    hint: 'Read the witness: it satisfies every requirement written down from this one and breaks the one they were written from, or it satisfies the parent’s assumption and not the child’s. The two obligations are `A_R ⊨ ⋀ A_D` and `A_R ∧ ⋀ nf(C_D) ⊨ G_R`, in normal form (`nf(C) = ¬A ∨ G`), so mutual support cannot buy the verdict. Weaken the child’s assumption, strengthen its guarantee, add the sibling requirement that closes the gap, or correct the direction of the edge. It is a decided finding about the model and the run exits 1; no flag forgives one. Nothing in this verdict is about ordering or time.',
  },
  {
    // The one code `fault-tree` writes back that is its own. The other three it
    // can file are the refinement lane's — a vacuous contract set is the same
    // fact whichever command met it, and so is a clause a gate refused — and a
    // second spelling of any of them would let the two commands explain one
    // model in two vocabularies.
    code: 'verification/single-point-of-failure',
    source: 'verification',
    severity: 'error',
    when: 'A cut-set enumeration found a sub-contract whose failure ALONE breaks the top requirement: with that one guarantee withdrawn, the remaining sub-contracts and the connections admit an implementation the top requirement forbids. The row carries the counterexample, re-read through this tool’s own evaluator before it was printed. It is independent of whether the decomposition REFINES — an architecture whose obligation (3) is proved can have several single points of failure, and saying so is what this command is for.',
    hint: 'Read the witness: it is the design the remaining contracts admit once this one stops delivering. A fix is redundancy — a second sub-contract guaranteeing the same quantity, which makes the set order 2 — a stronger sibling guarantee, or a weaker top requirement. It is a decided finding about the model and the run exits 1; there is no `--allow-inconclusive` on this command to forgive one. Cut sets of order 2 and above are NOT filed under this code: needing two failures at once is what redundancy looks like from the failure side. Nothing in this verdict is about ordering, time, rates or probabilities, and none of it is a behavioural safety analysis.',
  },
  {
    // The one code `bounds` writes back, and the reason it is not one of the
    // two `--allow-inconclusive` lowers: forgiving it would put a bound nobody
    // established into a green build through the flag rather than through a
    // verdict line.
    code: 'verification/optimality-not-established',
    source: 'verification',
    severity: 'info',
    when: 'z3 returned a bound for a measure and this tool will not call it the optimum: the script it optimised over is nonlinear in its bytes — a product or a quotient of two features — and νZ is complete for LINEAR real arithmetic only. The value is a bound the optimiser reached, not one it established as the tightest.',
    hint: 'Read the row as the bound it is. Pinning the feature that makes the objective nonlinear (a divisor, or the second operand of a product) puts the question back inside the fragment νZ decides, and `npm run sysprose -- obligations <file>` shows which relation carries it. It exits 2 and no flag lowers it: presenting a non-optimal bound as the optimum is the one sentence this command may never write. The heuristic `optimize` in `src/semantics/solver.ts` searches for a point and proves nothing, so it is not a second opinion about optimality either.',
  },
  {
    code: 'verification/free-variable-unbounded',
    source: 'verification',
    severity: 'info',
    when: 'A feature released by `--free` is not confined on both sides by the axioms and premises the obligation stands on, so the solver may place a witness outside the physical domain. Reported instead of a refutation, never beside one.',
    hint: 'Add a two-sided premise — `assume constraint { x >= lo and x <= hi }` — before freeing the feature. This tool derives no domain axiom from a quantity kind: it does not know that a power or a mass is non-negative, so a witness at a negative power is arithmetically confirmable and physically meaningless. It exits 2 and no flag lowers it.',
  },

  // The two codes `evidence-status` raises about what is IN the file, as
  // opposed to what an engine decided. They split the way the rest of this
  // block splits: the one that says the tool knows nothing is an info line, and
  // the one that says the file claims more than it can support is an error.
  {
    code: 'verification/claimed-without-evidence',
    source: 'verification',
    severity: 'info',
    when: 'A requirement carries a `verdict` facet and no evidence record this tool can read \u2014 either none was ever attached, or the carriers present could not be parsed back.',
    hint: 'This is not a defect: a `verdict` facet is ordinary requirements management, and a verdict reached by inspection is recorded there with no tool involved. The row says only that THIS tool has nothing standing behind it. Run `verify --record` then `evidence-attach` if you want one.',
  },
  {
    code: 'verification/verdict-overstates-evidence',
    source: 'verification',
    severity: 'error',
    when: 'A requirement states `verdict = "pass"` over an evidence record whose claim is not `proved` \u2014 `holds-at-values`, `holds-within-bound`, `vacuous`, `inconclusive` or anything else the engines can reach.',
    hint: '`pass` is written for one claim only, and a point evaluation is not a proof. Run `evidence-attach --from` again with the same records: it rewrites the facet from the claim even when every record is already present, which puts the file back where this tool would have left it. `evidence-detach` is the other repair, and takes the record off with the facet. `evidence-attach` cannot produce this state \u2014 every verdict it writes is derived from the claim, and a record file that says otherwise is refused \u2014 so a file in it was written by hand or by something that did not go through this tool.',
  },

  // The three the VERIFICATION CASE layer raises. They are about the case
  // rather than about one obligation, and the first of them is the honesty rule
  // this whole lane's §2 exit table names: a verdict is never claimed for a
  // method the tool did not perform. All three are info, and for the split
  // stated above: none of them is a defect in the model. Two say what this tool
  // did NOT do, and the third says two artefacts in the file disagree — which a
  // reader resolves by re-running or re-attaching, not by repairing a fault.
  {
    code: 'verification/method-not-performed',
    source: 'verification',
    severity: 'info',
    when: 'A verification case declares a `@VerificationCases::VerificationMethod { kind = …; }` whose list contains no `analyze` — `test`, `demo`, `inspect`, or a spelling that names no `VerificationMethodKind` at all. This tool performs analysis only, so the case is not judged.',
    hint: 'Read it as "not judged", never as "does not hold": an unjudged case is not a refutation, and the run exits 2 rather than 1. `--allow-inconclusive` does NOT lower it — the flag is scoped to `verification/timeout` and `verification/unsupported-construct`, and an unperformed method is neither, so there is no flag that forgives one. A case that says `kind = (analyze, test)` IS judged, on the analyze part, and reports the rest as not performed.',
  },
  {
    code: 'verification/no-property',
    source: 'verification',
    severity: 'info',
    when: 'A verification case has nothing to check: it names no requirement at all, or its `verify` statement points at something that is not a requirement — including an `objective { verify X; }` whose `X` names a part, an action or nothing, which never becomes a verification relationship at all and is read off containment instead. Prose splits two ways here. An UNTAGGED requirement that carries prose and no constraint body does NOT land here: it still raises an obligation row of its own (`verification/unsupported-construct`) and the case is judged inconclusive on that row, because there was a property to look for and looking for it is what failed. A requirement tagged `#prose` (or `#prompt`) contributes no row at all — the tag says it is deliberately informal — so a case that verifies nothing else DOES land here.',
    hint: 'Point the case at a requirement with a formal clause — `verify R by <case>;` at member level, or `objective { verify R; }` inside the case. Both forms are read. A case with no property is inconclusive and exits 2: a case that checked nothing has not passed.',
  },
  {
    code: 'verification/verdict-changed',
    source: 'verification',
    severity: 'info',
    when: 'A requirement carries a `verdict` facet saying something other than what this run computed for the verification case that verifies it — for example `pass` in the file over a run that refuted the requirement, or `inconclusive` in the file over one that proved it.',
    hint: 'This is a disagreement rather than a defect: a `verdict` facet is ordinary requirements management and may record a verdict reached by inspection with no tool involved. Nothing is rewritten by reporting it. `verify --record` then `evidence-attach` puts the facet back in step with the claim, and `evidence-detach` takes both off; a `pass` over a run that did not prove it is named as overstating on the row.',
  },

  // The five `property-check`'s gates raise (plan §3.3). They are about a clause
  // an agent PROPOSED, never about anything in the file, so none of them can be
  // a defect in a model and all five are info lines. They are the first
  // `verification/*` codes most agents meet, because drafting comes before
  // proving, and each names the gate that refused rather than the fact that
  // something was refused.
  {
    code: 'verification/temporal-field-unencodable',
    source: 'verification',
    severity: 'info',
    when: 'A drafted clause writes a FRETish field this lane cannot read: a `scope` other than `global`, a `condition` at all, or a `timing` other than `always`. All three describe WHEN a response is owed, and no in-process engine in phases 0–3 walks an execution or discharges a liveness claim, so the clause is refused at gate 0 rather than accepted with the temporal part quietly ignored.',
    hint: 'Restate the clause as an invariant over the values the design admits and leave the three temporal fields unwritten — `property-draft` emits them as commented guidance for exactly that reason — fold a condition into the requirement as an `assume constraint`, or export the property to an engine that decides temporal logic (`export`, §3.11). "Accepted with the temporal field ignored" is not offered: nothing downstream could decide the clause that reached it.',
  },
  {
    code: 'verification/unresolved-name-in-property',
    source: 'verification',
    severity: 'info',
    when: 'A name in a drafted clause is not one the subject’s scope offers. A bare feature name is the commonest case: a property clause names its features THROUGH the subject (`uav.endurance`, never `endurance`), because a bare name in a requirement that states two subjects names whichever the walk reached first and a reader cannot see which.',
    hint: 'Run `npm run sysprose -- property-draft <file> --element REF` for the data dictionary of every legal name with its type, unit and value, and write the dotted form. The row carries the nearest names it could find in `expected`.',
  },
  {
    code: 'verification/dimension-clash-in-property',
    source: 'verification',
    severity: 'info',
    when: 'Two operands of a drafted clause must share a physical dimension and do not — `uav.endurance >= 45.0 [kg]` compares a duration with a mass. It is the same gate the numeric surface applies, asked before the clause reaches a file rather than after.',
    hint: 'Compare quantities of one dimension: read the feature’s `dimension` and `unit` in the `property-draft` dictionary and give the literal a unit of that dimension. A feature that is DERIVED and dimensioned cannot be compared as a bare number at all — it needs a unit literal on the other side.',
  },
  {
    code: 'verification/trivial-property',
    source: 'verification',
    severity: 'info',
    when: 'A drafted clause is valid on its own (`uav.mtow <= uav.mtow` — every assignment makes it true) or unsatisfiable on its own (no assignment does), checked under z3 with NO axioms asserted. Either way it says nothing about the design: proving the first is free, and the second can never be discharged.',
    hint: 'State a bound the design has to meet, or check the relation’s direction. Note the gate’s scope: it is SYNTACTIC non-triviality, so a clause the model’s own feature values already satisfy passes it — `uav.mtow <= 25.0 [kg]` is accepted over a model that pins `mtow = 18.5 [kg]`. `verify`’s tautology check and the vacuity report decide that, and the limit is in the §6 register.',
  },
  {
    code: 'verification/nontriviality-unchecked',
    source: 'verification',
    severity: 'info',
    when: 'Gate 4 did not run: no z3 backend loaded (the package is optional, or `SYSPROSE_NO_Z3` is set), or a check came back `unknown` inside its budget. The clause passed the first four gates and is `accepted-with-gap`.',
    hint: 'Install the optional solver package — the absence sentence on the row names it and prints the install command — and re-run to close the gap. It is deliberately not reported as an accepted clause: an unchecked gate that printed "accepted" would be a missing tool producing a green answer, which is the failure this lane is written against.',
  },

  // The seven the BEHAVIOUR engine raises (plan §3.8). None is an error, and the
  // split is the reading rule the block above states: five are findings about a
  // MACHINE — a state nothing reaches, a transition nothing fires, a state
  // nothing leaves, a choice the notation does not resolve, a guard nothing in
  // the model decides — and they are warnings; two say what the engine did NOT
  // do, and are info. An error in this lane is reserved for a refuted
  // obligation, and `reach` refutes nothing. The engine is pure TypeScript: no
  // solver is behind any of them.
  {
    code: 'verification/unreachable-state',
    source: 'verification',
    severity: 'warning',
    when: 'An EXHAUSTIVE walk of a machine’s configuration graph never entered a state. It is claimed only when five things hold at once: the walk finished inside its bounds, no completion-chase budget was spent, every trigger the machine names was offered, no unsupported construct was met, and every guard the walk consulted decided something. On any bound hit, and over any guard the walk could not evaluate, the row is suppressed entirely rather than qualified.',
    hint: 'Either a transition into the state is missing, or the guard on the one that is there can never hold. Read the bounds printed beside the claim: it is true under those and under no others, and `reach --max-configs N` widens them.',
  },
  {
    code: 'verification/dead-transition',
    source: 'verification',
    severity: 'warning',
    when: 'An EXHAUSTIVE walk never found a transition ENABLED in any reachable configuration — its source is unreachable, or its guard never holds where it is. Suppressed under the same five conditions as `verification/unreachable-state`. Only transitions the walk could offer are counted at all: one leaving a node no configuration’s stack can hold is outside the census, not dead — the `initial` node’s edge, which the interpreter READS to decide where the machine opens, and an edge leaving the machine root, which the walk never stands on because it opens at the root’s initial substate.',
    hint: 'Note the reading before acting on it: dead means never enabled, so a transition that an inner state’s priority always beats is enabled and is NOT reported here. Fix the guard, or the path into its source.',
  },
  {
    code: 'verification/deadlock',
    source: 'verification',
    severity: 'warning',
    when: 'A reachable configuration has no enabled outgoing transition — no completion transition, and none for any trigger the machine names — and its active leaf is neither marked final nor a `done` node. Reachable means reached by a run of this semantics: a configuration only entered by firing a transition an inner state’s priority always beats is not explored, so nothing is reported there. It is an absence claim about one configuration’s outgoing edges, so it is WITHHELD over a machine carrying a guard the walk could not evaluate (`verification/guard-undetermined`) — that guard is an edge out nothing decided. A bound does not withhold it: a bound stops the walk enqueueing successors and takes nothing away from a configuration it already dequeued and offered every input at.',
    hint: 'Give the state a way out, or end the machine there properly — `done finished;` in the notation, or `kind = "final"` through the API. It is a reading of ONE machine under the printed alphabet: it says the machine cannot progress from there, never that the system deadlocks, and this tool never writes "deadlock-free".',
  },
  {
    code: 'verification/nondeterministic-choice',
    source: 'verification',
    severity: 'warning',
    when: 'Two or more transitions leaving the SAME state are enabled at once on one event, in a configuration a run of this semantics reaches, so which of them fires is decided by declaration order. The row names the one the simulator takes and the ones it never takes. Transitions enabled at different levels of the active stack are NOT reported: innermost-first is the profile’s stated priority rule, not an ambiguity. Nor is a row reported at a level a guard the walk could not evaluate sits strictly inside: that guard may have been the transition the priority rule would have picked, and the choice above it would then be one the withholding invented rather than one the walk found.',
    hint: 'Declaration order is not a semantics. Give the transitions guards that cannot both hold, or different triggers; until then one of them is unreachable in simulation while the model admits both. A row on a trigger-less machine prints no trigger label, because there is none.',
  },
  {
    code: 'verification/guard-undetermined',
    source: 'verification',
    severity: 'warning',
    when: 'The walk consulted a transition’s guard and could not evaluate it — a name it reads has no value anywhere in scope or in the store (`transition idle if mode == 3 then hazard;` over `attribute mode : Integer;`), or the expression yielded no value for a reason that is not a missing name at all — a type error inside it, such as `not mode` over an Integer `mode`, a comparison between two different kinds of value, or arithmetic that is not finite. Raised once per transition, naming the guard text and the names that were missing, if any. It is NOT a guard that is false: the step relation does not fire an undetermined guard because it has to pick something, and that reading is right for a run and wrong for a report.',
    hint: 'Read which of the two it is off the row: if it names missing names, give those features a value the walk can read (`attribute mode : Integer = 3;`) or drive the machine from a state whose effect assigns them; if it names none, every name resolves and the guard itself is the defect — most often that it is not a predicate. Until then the machine’s unreachable, dead and no-way-out lists are WITHHELD — they are absence claims, and nothing here established the absence — and the report says `undetermined under {…}` rather than `exhaustive`. `check-behaviour` is gated on the same condition and reports the property inconclusive rather than `pass` or `vacuous`. A hidden-choice row still stands where the withheld guard is at or outside the level the choice was read at — two transitions enabled at once is an existential claim, and removing a candidate beside them can only shrink it — but not where the withheld guard is strictly inside it, because that moves which level the choice is read at.',
  },
  {
    code: 'verification/bound-exhausted',
    source: 'verification',
    severity: 'info',
    when: 'A bound stopped the walk: the configuration bound (`--max-configs`), the depth bound, or a chain of completion transitions longer than the 64-step chase budget the interpreter itself runs under. The walk is partial. `check-behaviour` files it for a property whose search found no bad prefix over a graph it did not finish — and for one whose scope no explored run opened, because “the antecedent is never met” is a claim of absence a partial walk has not established either.',
    hint: 'The unreachable and dead lists are emptied rather than shortened, and the report says so: a partial walk cannot say what it never reached. In the behaviour lane the property is inconclusive rather than `pass` or `vacuous`, for the same reason. Raise `--max-configs`, or read the run as what it is. This is not a defect in the model.',
  },
  {
    code: 'verification/behaviour-unsupported-construct',
    source: 'verification',
    severity: 'info',
    when: 'A machine uses a construct this engine does not explore: parallel regions (`attrs.parallel`), a history state (`attrs.history` or a history pseudostate) — neither of which `sysml.langium` has a keyword for, so both are reachable only through the API — a step edge missing an endpoint, or an edge under the machine that sequences behaviour and that the step relation does not hold (`edge-not-walked`): a spelling it does not read, or an edge carrying a payload it models nothing of. That last one is not an enumerated construct but whatever the edge census could not account for, so a kind nobody listed refuses the machine instead of quietly shrinking its absence lists. The machine is not walked and is never reported as exhaustively explored. `check-behaviour` also files it for a PROPERTY CLASS this engine does not decide: `existence` and `response` are liveness, violated only by an infinite run that never delivers what it promised, and a bad-prefix search finds no bad prefix for either — so a walk would answer “no violation found” on every graph and a pass drawn from that would be the strongest verdict the command has, printed for the two properties it cannot decide.',
    hint: 'Nothing under such a machine is a claim of absence: no state is reported unreachable and no transition dead, and no liveness property is reported to hold. The row names the element and says why the relation does not hold it: give a step edge both of its endpoints, take the payload off an edge that is meant to pass control rather than an item, model the behaviour with nested states and named triggers, write the safety half of what you meant (`absence`, `universality`, `bounded-existence`, `precedence`), or export the machine to an engine that decides it (§3.11). No flag lowers this row: `--allow-inconclusive` is scoped to `verification/timeout` and `verification/unsupported-construct`, and this is neither.',
  },

  // The two `check-behaviour` adds on top of them. Both are about the PROPERTY
  // somebody wrote rather than about the machine, which is why neither is a
  // warning: a property this tool cannot read is not a defect in the model, and
  // reading it as one would file the reader's typo against their design. Both
  // make the property inconclusive and exit 2 — never absent, and never false.
  {
    code: 'verification/malformed-property',
    source: 'verification',
    severity: 'info',
    when: 'A behavioural property could not be read as one: a `pattern` outside the catalogue (`absence`, `universality`, `bounded-existence`, `precedence`, `existence`, `response`), a `scope` outside its five, a field the pattern needs and did not get, a `bounded-existence` with no `n`, a `--pattern` that is not `key=value` — or an expression atom that parses and is not a predicate, so it yielded a number (or nothing) where the walk needed a boolean.',
    hint: 'Write the property as `pattern=absence, scope=globally, p=state failsafe`, which is exactly the field set the `@SysproseVerification::PropertyPattern` carrier uses. A property nobody could read is never dropped from the run: it is inconclusive and exits 2, because a typo that silently removed a claim would look like a clean sweep.',
  },
  {
    code: 'verification/unknown-atom',
    source: 'verification',
    severity: 'info',
    when: 'A name in a property names nothing the machine has: `state X` for a state it does not declare, `trigger t` for a trigger no transition names, `fires T` for a transition with no such declared name, `node N` for no such node — or an expression reading a feature that is in no scope the walk offered. A name matching several elements lands here too, rather than resolving to whichever the walk reached first.',
    hint: 'The row lists what the machine DOES offer, so a misspelling is one line from being fixed; on an ambiguous name, write the qualified one. This is never read as "the atom is false": `absence of state failsafe` would then PASS the moment `failsafe` were misspelt, which is the loudest way this lane could print a green verdict that means nothing.',
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
