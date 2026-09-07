/**
 * The one annotation the verification lane ships as vocabulary of its own.
 *
 * THE RULE THIS FILE OBEYS. If SysML v2 already expresses a facet, this tool
 * uses the standard construct and ships no keyword. A practitioner's
 * four-keyword vocabulary — `#precondition`, `#postcondition`, `#Exception`,
 * `#Observable` — was put to the formal-verification plan as a source of proof
 * obligations, and only one of the four survives that rule:
 *
 *  - `#precondition` is expressed three ways already — `assume constraint` in a
 *    requirement body (`RequirementKind = 'assume'`, Part 1 §8.2.2.21.1), an
 *    `objective { assume constraint { … } }` on any case, and a `guard` on the
 *    incoming transition. A keyword would be redundant syntax.
 *  - `#postcondition` is `require constraint`, and on a case the objective's
 *    subject already resolves to the case result (`Cases.sysml`:
 *    `subject subj default Case::result;`). Redundant syntax again.
 *  - `#Observable` names a real gap — "observable" occurs in Part 1 only inside
 *    a narrative sentence — but it is **HELD, not shipped**. A `metadata def`
 *    this tool writes into user files is a compatibility commitment, and
 *    withdrawing one later turns somebody's file into
 *    `verification/keyword-names-nothing`. It would discharge no obligation.
 *  - `#exceptional` is the one that earns its keep. The specification has no
 *    way to say that an outcome is a FAILURE rather than an equally valid
 *    result: `grep -oi "exception[a-z]*"` over Part 1 returns nothing,
 *    `VerdictKind::fail` is a case *result* rather than a model-authored
 *    classification, and `RiskMetadata::Risk` is probability and impact. What
 *    the standard does supply is the MECHANISM, and its own §7.27.4 example is
 *    a user-defined failure marker: `#situation occurrence def Failure;`.
 *
 * WHAT IS BORROWED IS THE MECHANISM, NOT THE VOCABULARY — the same sentence
 * that heads {@link ./statement-kind}. §7.27.1: a metadata definition with no
 * nested features "simply acts as a user-defined syntactic tag on the annotated
 * element"; §7.27.4 defines the keyword as the (short) name of such a
 * definition written after a `#`. So `#exceptional` is a tag over a shipped
 * `metadata def`, and this file says out loud that it is a Sysprose extension
 * rather than standard vocabulary.
 *
 * WHY THE SHAPE IS THE PLAIN ONE. Measured: a plain
 * `metadata def <exceptional> ExceptionalOutcome;` parses, checks clean and
 * round-trips byte-identically. The `SemanticMetadata` shape the library's own
 * `ParametersOfInterestMetadata` uses for `<moe>` / `<mop>` does not — its
 * `:>> baseType = xs meta SysML::Usage;` produces three
 * `ref/unresolved-specialization` warnings today and the serializer rewrites
 * the qualified name. `test/unit/semantics.keywords.test.ts` pins that
 * measurement so nobody ships the second shape by mistake.
 *
 * ONE PACKAGE, NOT FOUR. Later commits of the plan extend THIS package with
 * their own definitions (an evidence carrier, a fault hypothesis, a property
 * pattern) rather than declaring a package each, so a model carrying a keyword
 * and an evidence record declares one Sysprose package with one doc string.
 * {@link EVIDENCE_DEFINITION} is the first of those extensions and it is
 * written into the SAME declaration above, not into a second package beside it.
 */

/** The package the shipped verification definitions live in. */
export const SYSPROSE_VERIFICATION_PACKAGE = 'SysproseVerification';

/** How the one shipped keyword is spelled after the `#`. */
export const EXCEPTIONAL_KEYWORD = 'exceptional';

/** The metadata definition the keyword names. */
export const EXCEPTIONAL_DEFINITION = 'ExceptionalOutcome';

/** `SysproseVerification::exceptional`, the spelling every provenance line prints. */
export const EXCEPTIONAL_QUALIFIED_KEYWORD = `${SYSPROSE_VERIFICATION_PACKAGE}::${EXCEPTIONAL_KEYWORD}`;

/**
 * The metadata definition an evidence record is carried under.
 *
 * NOT A KEYWORD, and that is the whole difference between it and
 * {@link EXCEPTIONAL_DEFINITION}. `#exceptional` is a TAG — §7.27.1's
 * "metadata definition with no nested features … simply acts as a user-defined
 * syntactic tag" — so it is written after a `#` and says one thing by being
 * present. An evidence record has a body: it names a claim, an engine, a tool
 * version and a model digest, and §7.27's annotating form
 * `@Def { attribute … = "…"; }` is what carries a body onto an element that is
 * already declared. So this definition ships with no short name: there is
 * nothing to spell after a `#`, and giving it one would invite a bare
 * `#Evidence` that carries no record and claims to be one.
 *
 * Measured, and this is the reason the shape is this one: a
 * `@SysproseVerification::Evidence { attribute record = "…"; }` written into a
 * requirement body parses with zero diagnostics, lands as a `MetadataUsage`
 * with `attrs.annotation === true` and `attrs.type` naming the definition, and
 * round-trips byte-identically — quoted string values included, escapes and
 * all. That last part is what lets a whole record live in one attribute.
 */
export const EVIDENCE_DEFINITION = 'Evidence';

/** `SysproseVerification::Evidence` — the spelling a carrier line is written with. */
export const EVIDENCE_QUALIFIED_NAME = `${SYSPROSE_VERIFICATION_PACKAGE}::${EVIDENCE_DEFINITION}`;

/**
 * The shipped definition, as text.
 *
 * A model that wants `#exceptional` to name something declares this package (or
 * imports it), exactly as it would for the statement kinds. The text is written
 * in the serializer's own canonical shape so that pasting it into a file and
 * saving gives the bytes back unchanged — asserted, not asserted-by-eye, in
 * `test/unit/semantics.keywords.test.ts`.
 */
export const SYSPROSE_VERIFICATION_LIBRARY = `package ${SYSPROSE_VERIFICATION_PACKAGE} {
    doc /* Two definitions SysML v2 does not express, carried over metadata definitions (SysML v2 7.27.1, 7.27.4). #${EXCEPTIONAL_KEYWORD} says an outcome is a failure rather than an equally valid result. ${EVIDENCE_DEFINITION} carries what a verification run showed, as an annotation on the requirement it is about. Both are Sysprose extensions, not standard vocabulary. */
    metadata def <${EXCEPTIONAL_KEYWORD}> ${EXCEPTIONAL_DEFINITION};
    metadata def ${EVIDENCE_DEFINITION};
}`;
