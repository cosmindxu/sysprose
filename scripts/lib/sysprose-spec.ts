/**
 * What `sysprose` can be asked, declared once.
 *
 * WHY IT IS DATA. The subcommands, their flags and the one-line answer to
 * "what does this one tell me" are read by three consumers: the dispatcher
 * (which parses and dispatches on them), `--help` (which renders them), and the
 * command reference in the documentation (which is generated from them). Three
 * hand-written copies of a command table is how a tool ends up with a flag
 * nobody documents and a documented flag that no longer exists, so there is one
 * table and the other two are renderings of it.
 *
 * This module is deliberately side-effect free — no imports of the model, no
 * `main()` — so a documentation generator can import it without running a
 * command.
 */

import { renderFlag, type FlagSpec } from './args';

/**
 * The `--max-core` default, spelled here rather than imported.
 *
 * This module is imported by the documentation generator and by three doc
 * guards, and it is deliberately free of model imports so none of them pulls
 * the core graph in to render a help line — the same reason
 * {@link STATEMENT_KIND_FLAG_VALUES} is a copy. The price of the copy is
 * drift, so it is not left to good intentions: `test/unit/cli-reference.test.ts`
 * compares this against `DEFAULT_MAX_CORE` in `src/semantics/consistency.ts`
 * and fails if the two move apart.
 */
export const DEFAULT_MAX_CORE = 8;

/**
 * The `--max-configs` default, spelled here for the same reason and guarded the
 * same way: `test/unit/cli-reference.test.ts` compares it against
 * `DEFAULT_MAX_CONFIGS` in `src/semantics/mc/explore.ts`. A documented bound
 * that is not the bound the walk ran under would make every "exhaustive under
 * {…}" line this command prints a false one.
 */
export const DEFAULT_MAX_CONFIGS = 10_000;

/**
 * The `--max-order` default, spelled here for the same reason and guarded the
 * same way: `test/unit/cli-reference.test.ts` compares it against
 * `DEFAULT_MAX_ORDER` in `src/semantics/fault-tree.ts`. A documented bound that
 * is not the bound the enumeration ran to would make every "no cut set up to
 * order N" line this command prints a false one — and that line is the whole
 * discipline of the command.
 */
export const DEFAULT_MAX_ORDER = 2;

/** The exit-code contract, stated once and quoted into every help text. */
export const EXIT_CODES = `Exit codes: 0 clean · 1 the model did not load cleanly (the report is of what parsed) · 2 usage/IO error`;

/**
 * `npm run check`'s exit-code contract, which is a DIFFERENT contract.
 *
 * `sysprose` reports and does not judge, so its 1 is about whether the model
 * under the report is the whole model. `check` judges, so its 1 is about the
 * findings: a file that parsed perfectly and broke one validation rule loaded
 * cleanly and still exits 1. The two were once documented as one contract, and
 * a reader who branched on it would have treated a duplicate-name error as a
 * parse failure. Stated here, next to the other, so the difference is visible
 * to whoever edits either — `scripts/sysml-check.ts`'s `--help` and
 * `docs/CLI-REFERENCE.md` are both renderings of this string.
 */
export const CHECK_EXIT_CODES = `Exit codes: 0 clean · 1 at least one file has findings (errors, or warnings with --strict) · 2 usage/IO error`;

/**
 * The contract of the two subcommands that WRITE the model back, which has no 1.
 *
 * Under {@link EXIT_CODES} a 1 says "the model did not load cleanly — the
 * report is of what parsed", and that sentence is unreachable for a subcommand
 * that refuses a degraded model outright: `evidence-attach` and
 * `evidence-detach` both open with `refuseDegradedWrite`, which raises a usage
 * error, which is a **2**. Documenting them under the reporting contract
 * promised a partial answer they will never give — the whole point of the
 * refusal is that a lossy rewrite of somebody's source is worse than no answer
 * — so they declare their own contract and it says what actually happens.
 */
export const WRITE_EXIT_CODES = `Exit codes: 0 written · 2 usage/IO error, or a model that did not load cleanly — a degraded model is refused rather than partially rewritten, so there is no exit 1`;

/**
 * `verify`'s exit-code contract, which is a THIRD contract, and the one most
 * likely to be misread.
 *
 * The other two agree about what 1 means at least in KIND: something is wrong
 * with the file. Here **1 means the requirement was refuted** — the model
 * loaded perfectly, every value is exactly what the author wrote, and the
 * obligation is false at those values. A pipeline branching on `sysprose`'s
 * reporting contract would read that as a parse failure and a `check` reader
 * would read it as a validation finding; it is neither.
 *
 * TWO SUBCOMMANDS OBEY IT, and they judge different things. `verify` asks
 * whether each obligation HOLDS of the design the file describes;
 * `consistency` asks whether the requirements could be met by any design at
 * all. Both reach a decided negative — a refuted obligation, a requirement set
 * nothing can satisfy — and both report it as **1**, because it is a finding
 * about the model rather than a limit of the tool. A contract that named only
 * one of the two would leave the other's loudest verdict documented as
 * something else. The third judging subcommand, `refine`, does NOT obey it —
 * see {@link REFINE_EXIT_CODES} for why.
 *
 * The other half a reader must not have to infer: **every inconclusive is 2**,
 * and that includes an absent solver. A missing tool can never produce a green
 * build, because the alternative — "no solver installed, nothing to report,
 * exit 0" — is indistinguishable from a proof and is the single failure this
 * whole lane exists to make impossible. **Nor may an EMPTY run be green**, for
 * the same reason and by the same reading: exit 0 says every obligation was
 * discharged, so a model that states none has been shown nothing, and a build
 * that went green because every requirement was deleted is exactly the silence
 * this contract is written against. `--allow-inconclusive` lowers 2 → 0 for
 * exactly two codes (`verification/timeout` and
 * `verification/unsupported-construct`, the ones that are merely UNDECIDED); it
 * never lowers `verification/tool-absent`, `verification/vacuous-pass` or
 * `verification/design-admitted`, and exit 1 always beats it.
 *
 * Stated here beside the other two so the difference is visible to whoever
 * edits any of them, and quoted by `renderCommandUsage` and the reference
 * generator through {@link exitCodesFor} rather than retyped — the drift test
 * in `test/unit/cli-reference.test.ts` asserts that every `exitContract:
 * 'verify'` command quotes this string and that no `'report'` command does.
 */
export const VERIFY_EXIT_CODES = `Exit codes: 0 every obligation discharged non-vacuously by the engine that was asked for — or every requirement set shown satisfiable — and there was at least one of them to decide · 1 at least one obligation refuted with every feature at its model value, or one requirement set nothing can satisfy · 2 usage/IO error, a degraded model, a model that states nothing to decide at all, or ANY inconclusive — a timeout, an unsupported construct, a relation not evaluable at the model's values, a vacuous obligation, an absent solver, or a refutation obtained under --free, which is a design the model admits rather than a violation of it`;

/**
 * `refine`'s exit-code contract — a FOURTH one, because three of the sentences
 * in {@link VERIFY_EXIT_CODES} name things this subcommand cannot do.
 *
 * `verify` and `consistency` both read the file's VALUES: `verify`'s 1 is "with
 * every feature at its model value", its 2 lists "a relation not evaluable at
 * the model's values", and its `--free` clause is about the flag that releases
 * a feature from the value it holds. A refinement obligation reads none of
 * them. It is a claim about EVERY implementation the contracts admit, `refine`
 * has no `--free` flag, and it has no requirement sets — so quoting that
 * paragraph under `refine` would publish, in its own `--help` and in the
 * generated reference, three promises the command cannot keep.
 *
 * Its own contract is the one the code actually implements, in
 * `refinementExitCode`: **1** is a decided negative about the architecture — an
 * obligation refuted with a confirmed counterexample — and **2** is everything
 * undecided, which here includes a VACUOUS contract set and a group stood down
 * because a gate refused a clause of it. `--allow-inconclusive`
 * lowers 2 → 0 for the two merely-undecided codes and never for a vacuity, an
 * absent solver or `verification/refinement-undecided`; a run in which nothing
 * at all was decided is 2 whatever the flag says, because exit 0 asserts that
 * every group the model states was SHOWN to refine.
 *
 * AND IT NAMES ALL THREE FAMILIES `--via` ACCEPTS, not just decompositions. A
 * `--via derive` run refutes on `verification/derivation-not-refinement` and
 * exits 2 on a file that states no CHAIN — neither of which is a decomposition
 * — so a contract that spoke only of decompositions documented an exit 1 that
 * family cannot produce and an exit 2 cause that is not the one it hits.
 */
export const REFINE_EXIT_CODES = `Exit codes: 0 every decomposition or derivation chain the --via family reads was shown to refine — for a decomposition, obligation (3) proved and every component assumption discharged; for a derive/refine chain, every derived requirement shown to assume no more than its parent and the set shown to entail the parent's guarantee — over a satisfiable contract set, and there was at least one of them to decide · 1 at least one obligation refuted, with a counterexample this tool re-read and confirmed: the component contracts admit an implementation that breaks the system contract, or the derived requirements admit one that breaks the requirement they were written from · 2 usage/IO error, a degraded model, a model that states no decomposition or derivation chain the --via family can read, or ANY undecided group — a timeout, an absent solver, a clause a gate refused, or a contract set that is vacuous, which is never laundered into a pass. A refinement obligation reads no feature value and there is no --free here`;

/**
 * `bounds`'s exit-code contract — a FIFTH one, because this subcommand answers
 * a question with no verdict in it.
 *
 * Every other contract in this file spends its **1** on a decided negative: a
 * file that did not load, a finding, a refuted obligation, an architecture that
 * does not refine. `bounds` has none to spend it on. It reports the tightest
 * value the model's axioms admit, and a number is not a violation — §2 reserves
 * exit 1 for a refuted obligation and this subcommand produces none, so a
 * contract with a 1 in it would document a state the command cannot reach.
 *
 * What it does spend is the difference between a bound that was DECIDED and one
 * that was not: an optimum whose optimality νZ established, an exact supremum or infimum, or a
 * proved unboundedness are answers about the model; a value νZ could not
 * certify as the tightest is not, and neither is a timeout, an absent solver,
 * an axiom set that cannot hold together, or a measure no relation reads. There
 * is no `--allow-inconclusive` here: the flag's scope is the two UNDECIDED
 * codes, and a run whose only answer was "optimality not established" must not read
 * as a run that answered.
 */
export const BOUNDS_EXIT_CODES = `Exit codes: 0 every bound asked for was DECIDED — an optimum whose optimality z3's νZ established, an exact supremum or infimum it proved is approached and never attained, or an unboundedness it proved under the axioms that were asserted · 2 usage/IO error, a degraded model, or any bound that was not decided — a value νZ does not certify as the tightest (nonlinear), a timeout, an absent solver, an axiom set that cannot hold together, or a measure no relation in the model reads. There is no exit 1: a bound is what the axioms admit and not a verdict, and there is no --allow-inconclusive here`;

/**
 * `check-behaviour`'s exit-code contract — a FIFTH one, and it is here for the
 * reason {@link REFINE_EXIT_CODES} is here.
 *
 * Under {@link VERIFY_EXIT_CODES} this command would publish, in its own
 * `--help` and in the generated reference, four promises it cannot keep: a
 * refutation "with every feature at its model value" (there are no obligations
 * and no `--free` here), "a relation not evaluable at the model's values", "an
 * absent solver" — §3.8 is explicit that the engine is pure TypeScript and no
 * solver is in this lane at all — and a `--timeout` it does not have. What it
 * DOES share with the other judging contracts is the shape: **1 is a decided
 * negative** — a property refuted with a witness trace of a run this semantics
 * admits — and **2 is everything undecided**, which here includes a bound the
 * walk hit, a machine construct this engine refuses to explore, a LIVENESS
 * pattern it does not decide in-process, a property it could not read, an atom
 * that names nothing, and a VACUOUS property, which no flag launders into a
 * pass. `--strict-vacuity` raises that last row from a line to an error and
 * changes nothing else, exactly as it does for `verify` (§2).
 *
 * A run with nothing to decide is **2** for {@link VERIFY_EXIT_CODES}' own
 * reason: exit 0 says every property was shown to hold, so a machine that
 * states none has been shown nothing.
 */
export const BEHAVIOUR_EXIT_CODES = `Exit codes: 0 every property stated on this machine was shown to hold on every reachable configuration, over a graph this walk saw whole, and there was at least one of them to decide · 1 at least one property refuted, with a witness trace of a run this semantics admits · 2 usage/IO error, a degraded model, a machine that states no property at all, or ANY undecided property — a bound the walk hit, a construct this engine does not explore, a liveness pattern no bad-prefix search decides, a property that could not be read, an atom that names nothing, or a vacuous one, which is never laundered into a pass. There is no solver in this lane and no --free: the walk reads the model’s own values`

/**
 * `fault-tree`'s exit-code contract — a SIXTH one, because its 1 is about a
 * COMBINATION of failures rather than about an obligation, and its 0 is a
 * bounded absence rather than a discharge.
 *
 * Under {@link REFINE_EXIT_CODES} this command would publish three promises it
 * cannot keep. Its 0 is not "every decomposition was shown to refine" — a
 * decomposition whose obligation (3) is proved can still have four single
 * points of failure, which is the whole reason this command exists — and its 1
 * is not "an obligation refuted" but a sub-contract whose failure ALONE breaks
 * the top requirement. Nor does it have a `--via`: there is one family of edges
 * here, the `satisfy` decomposition, and a contract set that cannot hold
 * together is reported as vacuous rather than as "no cut set" (§3.9), which is
 * the sentence the whole command turns on.
 *
 * WHAT IT DOES NOT SPEND THE 1 ON, stated because it is a judgement: a cut set
 * of order 2 or above. Two sub-contracts that must fail TOGETHER to break the
 * top requirement is what redundancy looks like from the failure side, and a
 * contract that exited 1 over it would teach a reader to delete the redundancy
 * that produced it.
 *
 * AND THERE IS NO `--allow-inconclusive`, for a sharper reason than `bounds`':
 * the flag's scope is the two UNDECIDED codes, and an undecided order-1 check
 * is exactly the state §3.9 forbids reading as "no single point of failure". A
 * flag that lowered it to 0 would launder the one sentence this command may
 * never write.
 */
export const FAULT_TREE_EXIT_CODES = `Exit codes: 0 every fault tree the model states was enumerated to its order bound and none of them has a single point of failure — every order-1 check decided and none of them broken — and there was at least one tree to enumerate · 1 at least one sub-contract whose failure ALONE breaks the top requirement, with a counterexample this tool re-read and confirmed, or a top event that is already open with every sub-contract honoured · 2 usage/IO error, a degraded model, a model that states no decomposition to inject a failure into, a state machine passed as --element (contract-level fault trees do not cover behaviour), or ANY undecided check — a timeout, an absent solver, a clause a gate refused, or a contract set that is vacuous, which is reported as vacuous and never as "no cut set". A cut set of order 2 or above is what redundancy looks like from the failure side, so it does not spend the 1; every absence is bounded by the order it was checked to and higher orders are not explored. A cut set reads no feature value: there is no --free here, and no --allow-inconclusive either, because an undecided order-1 check is exactly the state a "no single point of failure" sentence may never be written over`;

/** Flags every subcommand accepts. */
export const COMMON_FLAGS: readonly FlagSpec[] = [
  {
    name: 'json',
    kind: 'boolean',
    doc: 'Machine-readable report on stdout: {ok, file, <report>}',
  },
  {
    name: 'out',
    kind: 'value',
    metavar: 'PATH',
    doc: 'Write the report to PATH instead of printing it',
  },
  {
    name: 'no-library',
    kind: 'boolean',
    doc: 'Skip standard-library BINDING (faster; library types report as unresolved)',
  },
  { name: 'help', short: 'h', kind: 'boolean', doc: 'Help for this subcommand' },
];

/**
 * The relationship families `trace` can tabulate.
 *
 * A preset names the RELATIONSHIP kinds only. The row and column metaclasses
 * are read off the model — see the axis derivation in `scripts/sysprose.ts` —
 * because a hard-coded pair would be wrong for half the models that use it:
 * `satisfy` links a `PartUsage` to a `RequirementDefinition` in the shipped UAV
 * example and a `PartUsage` to a `RequirementUsage` in a model that declares
 * its requirements as usages, and a matrix that silently reports zero rows for
 * the second shape is worse than no command at all.
 */
export const TRACE_PRESETS: ReadonlyMap<string, readonly string[]> = new Map([
  ['satisfy', ['Satisfy', 'SatisfyRequirementUsage']],
  ['allocate', ['Allocation', 'AllocationUsage']],
  ['verify', ['Verify']],
  ['refine', ['Refine']],
  ['derive', ['Derive']],
  ['trace', ['Trace']],
]);

/**
 * The statement kinds `requirements --kind` accepts.
 *
 * Spelled out here rather than imported from `@semantics/statement-kind`,
 * because this module is imported by a documentation generator and by three
 * doc-guard tests, and pulling the model in to render a help line would give
 * every one of them the whole core graph. The price of the copy is drift, so it
 * is not left to good intentions: `test/unit/cli-reference.test.ts` compares
 * this list against `STATEMENT_KINDS` and fails if a fourth kind is added to
 * the vocabulary and not offered here.
 */
export const STATEMENT_KIND_FLAG_VALUES: readonly string[] = ['requirement', 'prose', 'prompt'];

/**
 * The property patterns and scopes `check-behaviour --pattern` accepts.
 *
 * Copied here rather than imported from `@semantics/mc/patterns`, for
 * {@link STATEMENT_KIND_FLAG_VALUES}'s reason and no other: this module is read
 * by a documentation generator and three doc guards, and pulling the model
 * graph in to render a help line would give every one of them the whole
 * semantics layer. The price of a copy is drift, so it is not left to good
 * intentions — `test/unit/cli-reference.test.ts` compares both lists against
 * `PATTERNS` and `SCOPES` and fails if a pattern is added to the catalogue and
 * not offered here, or offered here and not implemented.
 */
export const PATTERN_NAMES: readonly string[] = [
  'absence',
  'universality',
  'bounded-existence',
  'precedence',
  'existence',
  'response',
];

/** The five scopes, copied for the same reason and guarded the same way. */
export const SCOPE_NAMES: readonly string[] = [
  'globally',
  'before',
  'after',
  'between',
  'after-until',
];

/**
 * Which exit-code contract a subcommand obeys.
 *
 * `report` is {@link EXIT_CODES}: the subcommand reports and does not judge, so
 * its 1 is about whether the model under the report is the whole model.
 * `verify` is {@link VERIFY_EXIT_CODES}: the subcommand judges, so its 1 means
 * REFUTED. Declared per row rather than assumed for the section, because the
 * generated reference used to print one paragraph for the whole `sysprose`
 * section — and under it `verify` would have been documented with 1 meaning the
 * exact opposite of what it means.
 */
export type ExitContract =
  | 'report'
  | 'verify'
  | 'refine'
  | 'bounds'
  | 'write'
  | 'behaviour'
  | 'fault-tree';

/** One subcommand. */
export interface CommandSpec {
  name: string;
  /** The reader's question, not the function's name. */
  question: string;
  /** What computes the answer, so the guide and the code cite one source. */
  backedBy: string;
  /** Key the `--json` payload is published under, beside `ok` and `file`. */
  payloadKey: string;
  /** Which of the two exit-code contracts this subcommand obeys. */
  exitContract: ExitContract;
  /** Flags beyond {@link COMMON_FLAGS}. */
  flags: readonly FlagSpec[];
}

/** The exit-code sentence a subcommand's own help and reference must quote. */
export function exitCodesFor(cmd: CommandSpec): string {
  if (cmd.exitContract === 'verify') return VERIFY_EXIT_CODES;
  if (cmd.exitContract === 'refine') return REFINE_EXIT_CODES;
  if (cmd.exitContract === 'bounds') return BOUNDS_EXIT_CODES;
  if (cmd.exitContract === 'fault-tree') return FAULT_TREE_EXIT_CODES;
  if (cmd.exitContract === 'write') return WRITE_EXIT_CODES;
  if (cmd.exitContract === 'behaviour') return BEHAVIOUR_EXIT_CODES;
  return EXIT_CODES;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'stats',
    question: 'How big is this model, and what shape is it?',
    backedBy: 'modelMetrics + countByMetaclass (src/api/analytics.ts)',
    payloadKey: 'stats',
    exitContract: 'report',
    flags: [],
  },
  {
    name: 'elements',
    question: 'What is in it?',
    backedBy: 'buildGrid (src/diagram/grid.ts)',
    payloadKey: 'elements',
    exitContract: 'report',
    flags: [
      {
        name: 'include-library',
        kind: 'boolean',
        doc: 'List bundled standard-library elements too (tens of thousands of rows)',
      },
    ],
  },
  {
    name: 'requirements',
    question: 'Are my requirements covered, and by what?',
    backedBy:
      'requirementSatisfaction (src/api/analytics.ts) + buildRequirementsTable (src/diagram/requirements-table.ts)',
    payloadKey: 'requirements',
    exitContract: 'report',
    flags: [
      {
        name: 'kind',
        kind: 'value',
        metavar: 'KIND',
        fallback: 'every kind, each non-normative row labelled',
        doc: `Show only statements of this kind: ${STATEMENT_KIND_FLAG_VALUES.join(' | ')}`,
      },
    ],
  },
  {
    name: 'trace',
    question: 'What satisfies, allocates, verifies, refines, derives or traces what?',
    backedBy: 'traceabilityMatrix (src/api/analytics.ts)',
    payloadKey: 'trace',
    exitContract: 'report',
    flags: [
      {
        name: 'relation',
        kind: 'value',
        metavar: 'NAME',
        fallback: 'satisfy',
        doc: `Relationship family: ${[...TRACE_PRESETS.keys()].join(' | ')}`,
      },
      {
        name: 'from',
        kind: 'value',
        metavar: 'KIND',
        doc: 'Row metaclass (default: the kinds this relation actually links from)',
      },
      {
        name: 'to',
        kind: 'value',
        metavar: 'KIND',
        doc: 'Column metaclass (default: the kinds this relation actually links to)',
      },
    ],
  },
  {
    name: 'connectivity',
    question: 'Which ports are wired, and which are left dangling?',
    // Two functions, because `--signature` adds a MEASUREMENT to the report
    // rather than a second report: the census is computed on the very
    // inventory the command printed, and the README credits both.
    backedBy: 'connectivityReport + signatureCensus (src/api/analytics.ts)',
    payloadKey: 'connectivity',
    exitContract: 'report',
    flags: [
      {
        name: 'signature',
        kind: 'boolean',
        doc: 'Also measure what a signature reading could be built from — structural facts only, never a verdict',
      },
    ],
  },
  {
    name: 'where-used',
    question: 'What breaks if I change this element?',
    backedBy: 'impactClosure (src/api/analytics.ts)',
    payloadKey: 'whereUsed',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        doc: 'The element: an id, a qualified name, or a name unique in the model',
      },
      {
        name: 'depth',
        kind: 'value',
        metavar: 'N',
        fallback: '1',
        doc: 'How many reference hops to walk',
      },
    ],
  },
  {
    name: 'orphans',
    question: 'What did I declare and never use?',
    backedBy: 'orphanReport (src/api/analytics.ts)',
    payloadKey: 'orphans',
    exitContract: 'report',
    flags: [],
  },
  {
    name: 'prompts',
    question: 'What guidance applies to the element I am working on?',
    backedBy: 'promptsFor (src/api/analytics.ts)',
    payloadKey: 'prompts',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        // Deliberately the same words as `where-used`'s: it is the same
        // resolution, and two spellings of one grammar is how a reader learns
        // that the second command wants something else.
        doc: 'The element: an id, a qualified name, or a name unique in the model',
      },
    ],
  },
  {
    name: 'contracts',
    question: 'What does each requirement assume and guarantee, on which subject, honoured by which part?',
    backedBy: 'contractReport (src/api/verification.ts)',
    payloadKey: 'contracts',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        fallback: 'every contract in the model',
        // The same words as `where-used`'s and `prompts`': it is the same
        // resolution, and two spellings of one grammar is how a reader learns
        // that the second command wants something else.
        doc: 'The element: an id, a qualified name, or a name unique in the model',
      },
      {
        name: 'keywords',
        kind: 'boolean',
        doc: 'Also inventory every `#keyword` in the file with what it resolves to — an inventory, which changes no obligation',
      },
    ],
  },
  {
    name: 'obligations',
    question: 'What must be shown, over which axioms, and what do the unit gates refuse?',
    backedBy: 'obligationsReport (src/api/verification.ts)',
    payloadKey: 'obligations',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        fallback: 'the whole model',
        doc: 'The element: an id, a qualified name, or a name unique in the model',
      },
      {
        name: 'missing',
        kind: 'boolean',
        doc: 'Only the rows this lane would not decide: no formal clause, and not encodable',
      },
      {
        name: 'from-keywords',
        kind: 'boolean',
        fallback: 'a keyword files nothing',
        doc: "Let a third-party `#precondition` / `#postcondition` file a premise or an obligation; each such row prints the spelling that filed it",
      },
    ],
  },
  // The two that stand BEFORE the engines rather than behind them: an agent
  // writes a clause with the first and has it refused by the second, and neither
  // of them decides anything about the model. They report — a refused clause is
  // an answer about a string the caller passed, not a finding about the file —
  // so both carry `exitContract: 'report'` and the verdict is in the payload's
  // `outcome` and `refusedAt`, never in the exit code. Under the reporting
  // contract 1 means "the model did not load cleanly", and §2 reserves the
  // judging contract's 1 for a refuted obligation and nothing else.
  {
    name: 'property-draft',
    question: 'How do I write a clause this tool will accept, over which names?',
    backedBy: 'propertyDraft (src/api/property.ts)',
    payloadKey: 'propertyDraft',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        // The same words as `where-used`'s, `prompts`' and `contracts`': it is
        // the same resolution, and two spellings of one grammar is how a reader
        // learns that the second command wants something else.
        doc: 'The element: an id, a qualified name, or a name unique in the model',
      },
    ],
  },
  {
    name: 'property-check',
    question: 'Would this clause pass the gates, and what does it actually say?',
    backedBy: 'propertyCheck (src/api/property.ts)',
    payloadKey: 'propertyCheck',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        doc: 'The requirement the clause is for: an id, a qualified name, or a name unique in the model',
      },
      {
        name: 'clause',
        kind: 'value',
        metavar: 'TEXT',
        doc: "The clause to judge: a constraint body (`uav.mtow <= 25.0 [kg]`), optionally preceded by FRETish fields written `field: value;` or `field = value;` — the spelling `property-draft`'s skeleton emits, and the other one. A `scope` other than global, a `condition`, or a `timing` other than always is refused at gate 0 — no in-process engine here decides a temporal claim",
      },
    ],
  },
  // The first subcommand in this table that JUDGES. Everything above reports,
  // and every one of them carries `exitContract: 'report'` for that reason; this
  // one carries `'verify'`, and its 1 means refuted.
  {
    name: 'verify',
    question: 'Does each obligation hold, by which engine, and under what bound?',
    backedBy: 'verifyModel (src/api/verification.ts)',
    payloadKey: 'verify',
    exitContract: 'verify',
    flags: [
      {
        name: 'case',
        kind: 'value',
        metavar: 'REF',
        fallback: 'every obligation in the model, with every verification case reported beside them',
        doc: 'Judge ONE verification case: the report is narrowed to the obligations of the requirements it verifies, and its verdict decides the run. The model is still judged whole, so the axioms those obligations stand on are all still in force. A case whose `@VerificationMethod { kind = …; }` has no `analyze` in it is NOT judged — `verification/method-not-performed`, exit 2, never exit 1',
      },
      {
        name: 'engine',
        kind: 'value',
        metavar: 'NAME',
        fallback: 'auto',
        doc: "Which engine decides: auto | literal | smt. `auto` resolves to `smt` when a solver backend loads and otherwise reports every obligation as `verification/tool-absent` — it never falls back to `literal`, because a point evaluation is green only when asked for by name",
      },
      {
        name: 'free',
        kind: 'value',
        metavar: 'F',
        fallback: 'none — every feature value is a binding the proof carries',
        doc: 'Release a feature value (qualified name) so the engine may vary it; a refutation obtained this way is `design-admitted`, not a violation. An SMT-engine option: the literal engine evaluates AT the values and refuses it',
      },
      {
        name: 'record',
        kind: 'value',
        metavar: 'PATH',
        doc: 'Write the evidence records to PATH: one per obligation, each naming the claim, the engine, the tool version, the bound and the canonical model digest',
      },
      {
        name: 'allow-inconclusive',
        kind: 'boolean',
        doc: 'Lower exit 2 to 0 for the UNDECIDED codes only — verification/timeout and verification/unsupported-construct. Never for an absent solver, a vacuous obligation or a design-admitted one, and never over a refutation',
      },
      {
        name: 'timeout',
        kind: 'value',
        metavar: 'MS',
        fallback: '5000 ms per check',
        doc: 'The per-check budget in milliseconds — an SMT-engine option. No check is unbounded and there is no spelling for "no timeout"; a solver that runs out of time reports verification/timeout, which says nothing about whether the requirement holds',
      },
      {
        name: 'strict-vacuity',
        kind: 'boolean',
        doc: 'Raise a vacuous obligation from an info line to verification/vacuous-property, an error. It does NOT change the exit code: vacuity is inconclusive and exits 2 with the flag and without it',
      },
      {
        name: 'why',
        kind: 'boolean',
        doc: 'Name the members of the unsat core the solver returned for each `proved` row — the axioms, the goal, and the side conditions the encoding added, sorted. The set is SUFFICIENT and not minimal: an axiom listed may not have been needed, and an axiom NOT listed may still carry the claim, so it is not "the axioms this proof depends on". It decides nothing and moves no exit code. Only a proof has a core this flag prints; the cores shown under verification/inconsistent-axioms and verification/vacuous answer other questions and print inside their own sentences with or without it',
      },
    ],
  },
  // The second subcommand that judges, and it judges a DIFFERENT question:
  // `verify` asks whether the requirements hold of the design in the file,
  // this asks whether they could be met by any design at all. The two disagree
  // by construction on a file whose values break a requirement — that one is
  // refuted and its requirement set is perfectly satisfiable — so they are two
  // commands rather than a flag on one.
  {
    name: 'consistency',
    question: 'Can all the requirements on this subject hold at once — and if not, which conflict?',
    backedBy: 'consistencyReport (src/api/verification.ts)',
    payloadKey: 'consistency',
    exitContract: 'verify',
    flags: [
      {
        name: 'subject',
        kind: 'value',
        metavar: 'REF',
        fallback: 'every subject the model states a requirement about',
        doc: 'The subject: an id, a qualified name, or a name unique in the model — a type, or the part usage the file writes after `subject`, which is narrowed through its declared type. A type answers for its subtypes, because a requirement on a `Vehicle` is a requirement on every air vehicle. A REF that is the subject of nothing is refused by name rather than reported as a file with no requirements',
      },
      {
        name: 'with-values',
        kind: 'boolean',
        doc: 'Ask the weaker question: can the requirements hold together AT THE VALUES THE FILE STATES? By default every feature carrying a literal value is released and only the structural axioms are kept, because a consistency question about a requirement set must not be answered by the values that happen to be in the file. Every verdict line names the mode it was computed in',
      },
      {
        name: 'minimize',
        kind: 'boolean',
        doc: 'Reduce the conflicting subset by deletion, one member per check, until every member is needed. Only a loop that RAN TO COMPLETION earns the word "minimal"; without it, and after any timeout, the report says "a conflicting subset"',
      },
      {
        name: 'max-core',
        kind: 'value',
        metavar: 'N',
        fallback: `${DEFAULT_MAX_CORE} members`,
        doc: 'The deletion loop\u2019s budget, in core members — minimising costs one solver check per member. A core larger than N is reported in full and left unreduced, and the line says the budget was why',
      },
      {
        name: 'allow-inconclusive',
        kind: 'boolean',
        doc: 'Lower exit 2 to 0 for the UNDECIDED codes only — verification/timeout and verification/unsupported-construct. Never for an absent solver, never over an inconsistency, and never over a run in which nothing at all was decided',
      },
    ],
  },
  // The third subcommand that judges, and the one whose question is about an
  // ARCHITECTURE. `verify` asks whether a requirement holds of the design in
  // the file and `consistency` whether the requirements could be met at all;
  // this asks whether the contracts on the parts, together with the equalities
  // the model states, entail the contract on the whole. The three cannot be
  // flags on one command because their exit 1 is a finding about three
  // different things.
  {
    name: 'refine',
    question:
      'Do the component contracts entail the system contract, and is every component assumption discharged?',
    backedBy: 'refinementReport (src/api/verification.ts)',
    payloadKey: 'refinement',
    exitContract: 'refine',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        fallback: 'every decomposition the model states',
        doc: 'The decomposition: an id, a qualified name, or a name unique in the model, naming a system contract, the part that satisfies it, or any contract or part under it. A REF that names no decomposition is refused by name rather than reported as a file with no architecture in it',
      },
      {
        name: 'via',
        kind: 'value',
        metavar: 'KIND',
        fallback: 'composition',
        doc: 'Which family of edges to read: `composition` — the contracts on the parts a `satisfy` attaches under the part the system contract is satisfied by; `derive` — the requirements a `derive requirement D from R` writes down from another, checked with the orientation the mapper stores (the parent is the SOURCE of the edge); `refine` — the same question over `refine requirement X by Y`, which stores its ends the other way round (the parent is the TARGET, uniform with `satisfy`); `all` — every family in one run, each row naming the one it came from',
      },
      {
        name: 'connections-as-equalities',
        kind: 'boolean',
        doc: 'Read a bare `connect` as a value equality — the OCRA reading. OFF by default: a connection joins two features and states nothing about their values, so it is listed under `notEncoded` with the hint "bind the attributes if they are one quantity". It reads `connect` and nothing else: an `allocate` is a traceability mapping and an interface joins ports through connections of its own, so both stay listed under the flag with a hint naming what they are. When the flag is used the fact is printed on EVERY verdict line, because it changes what the verdict claims. Counter-evidence, recorded rather than buried: the one published SysML v2 → OCRA path translates `connect` and `bind` alike, so the default here is a stricter reading than that path takes',
      },
      {
        name: 'allow-inconclusive',
        kind: 'boolean',
        doc: 'Lower exit 2 to 0 for the UNDECIDED codes only — verification/timeout and verification/unsupported-construct. Never for an absent solver, never for a vacuous contract set, never for verification/refinement-undecided, never over a refuted obligation, and never over a run in which nothing at all was decided',
      },
    ],
  },
  // The fourth subcommand with an exit contract of its own, and the only one in
  // this table that DECIDES something without judging anything: `verify`,
  // `consistency` and `refine` all spend an exit 1 on a decided negative about
  // the model, and a bound is not one — it is what the axioms admit. Its own
  // contract is what says so; `verify`'s would document an exit 1 it cannot
  // reach, exactly as it would have for `refine`.
  {
    name: 'bounds',
    question: 'What is the tightest value this measure can take under the model’s axioms?',
    backedBy: 'boundsReport (src/api/verification.ts)',
    payloadKey: 'bounds',
    exitContract: 'bounds',
    flags: [
      {
        name: 'measure',
        kind: 'value',
        metavar: 'REF',
        doc: 'The feature to bound: a qualified name, the dotted path a constraint body writes (`uav.endurance`), or a feature name unique in the model. A REF that resolves to something no relation in the model reads is reported as such rather than as an unbounded quantity — "unbounded" is arithmetically true of a feature nothing constrains and would read as a finding about the design',
      },
      {
        name: 'sense',
        kind: 'value',
        metavar: 'DIR',
        fallback: 'max',
        doc: 'Which direction to push the measure in: min | max | both. Two directions are two solver runs, deliberately — z3 optimises several objectives lexicographically, so one script carrying both would answer the second one under the first already fixed',
      },
      {
        name: 'free',
        kind: 'value',
        metavar: 'F',
        fallback: 'none — every value the file states is an axiom of the bound',
        doc: 'Release a feature value (qualified name, dotted path, or `all`) so the bound may range over it. With nothing released every value is pinned and the bound is the value in the file; `all` releases every value the file STATES and keeps every equation that says how a quantity is COMPUTED, which is the same rule `consistency` releases under',
      },
      {
        name: 'with-requirements',
        kind: 'boolean',
        doc: 'Fold the `require` bodies into the axiom set, each as the implication `assume ⇒ require` the shipped library states a requirement to be, and say so on every verdict line. OFF by default: a requirement is what is being checked, not a fact about the design, which is why `--measure uav.mtow --free all` answers "unbounded above" over a file that plainly states a 25 kg limit',
      },
    ],
  },
  // The safety half of the composition work, and the sixth exit contract. It
  // asks the same obligation (3) `refine` asks and asks it again with the
  // guarantees of a fault set withdrawn — so a decomposition that REFINES can
  // still have four single points of failure, and this is the command that says
  // so. It is not a flag on `refine` for that reason: the two exit 1 on
  // different findings about the same model.
  {
    name: 'fault-tree',
    question: 'Which combinations of contract failures break the top requirement?',
    backedBy: 'faultTreeReport (src/api/verification.ts)',
    payloadKey: 'faultTree',
    exitContract: 'fault-tree',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        fallback: 'every decomposition the model states',
        doc: 'The top event: an id, a qualified name, or a name unique in the model, naming a system contract, the part that satisfies it, or any contract or part under it. A state machine is REFUSED here rather than answered with an empty cut-set list — a fault tree over contracts says nothing about behaviour, and "no combination of failures breaks this" about a machine nothing looked at is the loudest false statement this command could make',
      },
      {
        name: 'max-order',
        kind: 'value',
        metavar: 'N',
        fallback: `order ${DEFAULT_MAX_ORDER}, or the FaultHypothesis carrier the model states`,
        doc: 'How many sub-contracts may fail together. The enumeration costs the sum of C(n,k) solver checks and the count is reported, so the bound is a budget as well as a hypothesis; every absence is printed with it and nothing above it is explored. A `@SysproseVerification::FaultHypothesis { maxOrder = 2; }` carrier on the top requirement or its part pins the same number IN THE MODEL, where a reviewer can argue with it, and this flag overrides one; both cell spellings are read, with or without the `attribute` keyword, and a cell this tool cannot read is reported as such rather than passed off as the default',
      },
    ],
  },
  // The three that read and write the FILE rather than reporting on it. None of
  // them JUDGES — the judging was done by `verify`, once, and a verdict is not
  // re-decided by being written down — but the two that write the file back
  // obey a contract of their own: they refuse a degraded model outright, so
  // their exit 1 ("the report is of what parsed") does not exist.
  {
    name: 'evidence-status',
    question: 'What was shown, by which tool, over which model — and is it still valid?',
    backedBy: 'evidenceStatus (src/api/evidence.ts)',
    payloadKey: 'evidenceStatus',
    exitContract: 'report',
    flags: [],
  },
  {
    name: 'evidence-attach',
    question: 'Write the records of a verify run into the file, as annotations on what they are about',
    backedBy: 'attachEvidence (src/api/evidence.ts)',
    payloadKey: 'evidenceAttach',
    exitContract: 'write',
    flags: [
      {
        name: 'from',
        kind: 'value',
        metavar: 'PATH',
        doc: 'The records to attach: the JSON array `verify --record PATH` wrote. Each is validated against docs/schemas/evidence-record.schema.json before anything is written, so a hand-edited file is refused rather than half-attached',
      },
    ],
  },
  {
    name: 'evidence-detach',
    question: 'Take every evidence record back off the file, and the verdict facets with them',
    backedBy: 'detachEvidence (src/api/evidence.ts)',
    payloadKey: 'evidenceDetach',
    exitContract: 'write',
    flags: [],
  },
  // The behaviour lane's first command, and the only one in this file with no
  // solver behind it at all: an explicit walk of a state machine's
  // configuration graph, exploring every enabled transition where the
  // interpreter takes the first (plan §3.8). It REPORTS — a state nothing
  // reaches is a fact about a machine, not a violated requirement — so it
  // carries the reporting contract and its findings live in the payload, never
  // in the exit code. What it may never do is let a bound read as a finding,
  // which is why the absence lists are emptied rather than shortened when a
  // walk is cut off, and why every figure prints the bounds it holds under.
  {
    name: 'reach',
    question:
      'Which states are reachable, which transitions are dead, where did the simulator hide a choice?',
    backedBy: 'reachReport (src/semantics/mc/explore.ts)',
    payloadKey: 'reach',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        fallback: 'every state machine in the model',
        // The same words as `where-used`'s, `prompts`' and `contracts`': it is
        // the same resolution, and two spellings of one grammar is how a reader
        // learns that the second command wants something else.
        doc: 'The element: an id, a qualified name, or a name unique in the model',
      },
      {
        name: 'max-configs',
        kind: 'value',
        metavar: 'N',
        fallback: `${DEFAULT_MAX_CONFIGS} configurations`,
        doc: 'Configurations to explore before the walk gives up. A walk that hits it is PARTIAL: the unreachable and dead lists are emptied rather than shortened, the report says the bound was hit, and no absence is claimed from a walk that did not finish',
      },
    ],
  },
  // The behaviour lane's judging half. `reach` reports on a machine; this one
  // decides a CLAIM somebody wrote about it, which is why it carries an exit
  // code of its own (see BEHAVIOUR_EXIT_CODES) where `reach` carries the
  // reporting contract. The engine behind both is the same pure-TypeScript
  // walk: there is no solver in this lane, and the row's `backedBy` says which
  // function a reader can call to get the same answer in process.
  {
    name: 'check-behaviour',
    question: 'Does this safety pattern hold on every reachable configuration?',
    backedBy: 'behaviourReport (src/semantics/mc/patterns.ts)',
    payloadKey: 'behaviour',
    exitContract: 'behaviour',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        // No `fallback`, because there is no default: a property is a claim
        // about ONE machine, and a run that checked every machine in the file
        // against every property in it would answer a question nobody asked.
        doc: 'The state machine to check: an id, a qualified name, or a name unique in the model. Required',
      },
      {
        name: 'pattern',
        kind: 'value',
        metavar: 'SPEC',
        fallback: 'the properties the machine itself carries',
        doc: `One property, in the same field names the @SysproseVerification::PropertyPattern carrier uses: \`pattern=absence, scope=globally, p=state failsafe\`. Patterns: ${PATTERN_NAMES.join(' | ')} — the last two are LIVENESS and report inconclusive, because a bad-prefix search decides neither. Scopes: ${SCOPE_NAMES.join(' | ')}. Atoms: \`state X\`, \`trigger t\`, \`fires T\`, \`node N\`, or an expression. It is checked BESIDE the carriers, never instead of them, and a field value may hold no comma or semicolon (the carrier form has no such limit)`,
      },
      {
        name: 'max-configs',
        kind: 'value',
        metavar: 'N',
        fallback: `${DEFAULT_MAX_CONFIGS} configurations`,
        doc: 'Configurations to explore before the walk gives up. A walk that hits it can still REFUTE a property — a witness is a real run — and can never pass one: no bad prefix in part of a graph is not the absence of one, so the row is inconclusive and the run exits 2',
      },
      {
        name: 'strict-vacuity',
        kind: 'boolean',
        doc: 'Raise a vacuous property from a row to verification/vacuous-property, an error. It does NOT change the exit code: a vacuity is inconclusive and exits 2 with the flag and without it',
      },
    ],
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Every flag a subcommand accepts: its own, then the shared ones. */
export function flagsFor(cmd: CommandSpec): FlagSpec[] {
  return [...cmd.flags, ...COMMON_FLAGS];
}

/** `--help` with no subcommand: what the tool is and what it can be asked. */
export function renderTopUsage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  // EVERY judging contract, in one list: `refine` and `check-behaviour` each
  // carry their own text (a refinement obligation reads no feature value and a
  // behavioural property has no solver behind it, so `verify`'s wording fits
  // neither) but both judge just the same, and a reader told only about
  // `verify`'s two would take their exit 1 for a load failure — which is its
  // exact opposite. Filtered by what the contract SAYS rather than by a list of
  // names, so a sixth contract cannot be added and quietly left out:
  // `check-behaviour` was, and its exit 1 (a property refuted, with a witness)
  // read as "the model did not load cleanly" in the one place a reader who has
  // not run the tool yet meets the contract.
  const judging = COMMANDS.filter((c) => {
    const contract = exitCodesFor(c);
    // The two that do not judge: `report`'s 1 is about the load, and the
    // writing commands have no 1 at all.
    return contract !== EXIT_CODES && contract !== WRITE_EXIT_CODES;
  });
  return [
    'sysprose — report on a SysML v2–style model from the command line',
    '',
    'Usage:',
    '  npm run sysprose -- <subcommand> <file.sysml|-> [options]',
    '  cat model.sysml | npm run sysprose -- stats -',
    '',
    'Subcommands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.question}`),
    '',
    'Options (every subcommand):',
    ...COMMON_FLAGS.map((f) => renderFlag(f)),
    '',
    'Run `npm run sysprose -- <subcommand> --help` for the flags of one subcommand.',
    '',
    // The top-level text names the contract MOST subcommands obey and then says
    // which ones do not, rather than printing one contract over a table that
    // holds two. Under a single blanket sentence, `verify`'s exit 1 — refuted —
    // would be documented as "the model did not load cleanly", its exact
    // opposite.
    EXIT_CODES,
    ...(judging.length > 0
      ? [
          // Written as a sentence rather than as a joined list, because there
          // is more than one such subcommand now and "`verify`, `consistency`
          // judges" is not English. The VERB is deliberately not "judge" any
          // more either: `bounds` carries a contract of its own and judges
          // nothing — it reports what the axioms admit — so a line that called
          // it a judging subcommand would tell a reader to look for an exit 1
          // it cannot produce.
          `  …for every subcommand that REPORTS. ${listOf(judging.map((c) => `\`${c.name}\``))} ` +
            (judging.length === 1
              ? 'carries a contract of its own: run its `--help`.'
              : 'each carry a contract of their own: run their `--help`.'),
        ]
      : []),
  ].join('\n');
}

/**
 * `a`, `a and b`, `a, b and c` — a list a person reads inside a sentence.
 *
 * EXPORTED so `scripts/gen-cli-reference.ts` renders the same sentence the
 * same way. It had its own comma-joined copy, which read "`verify`,
 * `consistency` judges" the day a second judging subcommand shipped — the one
 * place a reader who has not run the tool yet meets the exit contract.
 */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** `--help` for one subcommand. */
export function renderCommandUsage(cmd: CommandSpec): string {
  const flags = flagsFor(cmd);
  const width = Math.max(...flags.map((f) => f.name.length + (f.short ? 4 : 0) + (f.kind === 'value' ? (f.metavar ?? 'VALUE').length + 1 : 0))) + 2;
  return [
    `sysprose ${cmd.name} — ${cmd.question}`,
    '',
    'Usage:',
    `  npm run sysprose -- ${cmd.name} <file.sysml|-> [options]`,
    '',
    'Options:',
    ...flags.map((f) => renderFlag(f, width)),
    '',
    `Computed by: ${cmd.backedBy}`,
    `JSON payload key: ${cmd.payloadKey}`,
    '',
    // Per SUBCOMMAND, from its own declared contract. A single interpolation of
    // `EXIT_CODES` here would tell a `verify` reader that exit 1 means the model
    // did not load cleanly, when it means the requirement was refuted.
    exitCodesFor(cmd),
  ].join('\n');
}
