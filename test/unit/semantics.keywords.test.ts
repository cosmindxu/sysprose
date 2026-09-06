/**
 * The keyword reader, the shipped verification vocabulary, and the one promise
 * that has to hold for a file this tool did not write: **somebody else's
 * `#keyword` vocabulary is read and preserved losslessly, and it changes
 * nothing unless a command asked it to.**
 *
 * Three groups of cases, and each of them is a measurement rather than a
 * restatement of the code:
 *
 *  - **The interoperability ratchet.** Six host declarations × seven keyword
 *    spellings — the shipped one, a qualified one, four third-party ones and a
 *    misspelling — parse with zero diagnostics, land in `attrs.metadata` as
 *    WRITTEN, and round-trip idempotently. It is a ratchet because nothing in
 *    the verification plan may lower it: the day a keyword this tool does not
 *    recognise costs a diagnostic, or is normalised into one it does, a model
 *    annotated for another tool stops being safe to open here.
 *  - **The line between reading and acting.** `resolveKeyword` answers what a
 *    keyword NAMES; `hasKeyword` answers whether the model used the vocabulary
 *    this tool ships; `foreignKeyword` answers what a third-party spelling
 *    would be read as. The review target of the commit that added them is
 *    exactly whether the third collapses into the second, so `#Exception` is
 *    asked of `hasKeyword` directly.
 *  - **The shape of the shipped package.** It is the plain
 *    `metadata def <exceptional> ExceptionalOutcome;` and not the
 *    `SemanticMetadata` shape the standard library uses for `<moe>`/`<mop>`,
 *    because the second is measured producing three
 *    `ref/unresolved-specialization` warnings and a body the serializer
 *    rewrites. Both shapes are pinned — the one we ship by its byte-identical
 *    round trip, the one we do not by its warnings — so nobody swaps them.
 */
import { describe, it, expect } from 'vitest';
import { parseModel, serializeModel } from '@text/index';
import { checkText } from '@text/check';
import { loadModelText } from '@text/load';
import type { Model } from '@core/index';
import {
  EXCEPTIONAL_DEFINITION,
  EXCEPTIONAL_KEYWORD,
  EXCEPTIONAL_QUALIFIED_KEYWORD,
  FOREIGN_KEYWORD_ALIASES,
  STATEMENT_KIND_PACKAGE,
  SYSPROSE_KEYWORD_PACKAGES,
  SYSPROSE_VERIFICATION_LIBRARY,
  SYSPROSE_VERIFICATION_PACKAGE,
  foreignKeyword,
  hasKeyword,
  keywordsOf,
  resolveKeyword,
  statementKindOf,
} from '@semantics/index';

/** The one element a snippet declares, by name. */
const byName = (model: Model, name: string) => {
  const el = model.all().find((e) => e.declaredName === name);
  expect(el, `no element named ${name}`).toBeDefined();
  return el!;
};

/** Parse, refusing anything the parser calls an error. */
function parsed(text: string): Model {
  const p = parseModel(text);
  const errors = p.diagnostics.filter((d) => d.severity === 'error');
  expect(errors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return p.model;
}

describe('the shipped verification vocabulary', () => {
  it('ships one keyword over one metadata definition, in one package', () => {
    expect(SYSPROSE_VERIFICATION_PACKAGE).toBe('SysproseVerification');
    expect(EXCEPTIONAL_KEYWORD).toBe('exceptional');
    expect(EXCEPTIONAL_DEFINITION).toBe('ExceptionalOutcome');
    expect(EXCEPTIONAL_QUALIFIED_KEYWORD).toBe('SysproseVerification::exceptional');
    // The gap the plan HOLDS rather than ships. A `metadata def` written into a
    // user's file is a compatibility commitment, so the absence of this one is
    // an asserted decision and not an oversight.
    expect(SYSPROSE_VERIFICATION_LIBRARY).not.toContain('observable');
    expect(SYSPROSE_VERIFICATION_LIBRARY).not.toContain('Observable');
  });

  /**
   * The package is text a person pastes into their own file, so the text has to
   * be text this tool accepts — checked, not asserted, exactly as the statement
   * kinds' own library is.
   */
  it('parses, checks clean and round-trips byte-identically', async () => {
    const model = parsed(SYSPROSE_VERIFICATION_LIBRARY);
    expect(serializeModel(model)).toBe(SYSPROSE_VERIFICATION_LIBRARY);

    const report = await checkText(SYSPROSE_VERIFICATION_LIBRARY, { library: 'full' });
    expect(
      report.summary,
      report.diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`).join('\n'),
    ).toMatchObject({ errors: 0, warnings: 0 });

    // The definition really does declare the keyword as its SHORT name, which
    // is what §7.27.4 makes a keyword out of.
    const def = byName(model, EXCEPTIONAL_DEFINITION);
    expect(def.eClass).toBe('MetadataDefinition');
    expect(def.declaredShortName).toBe(EXCEPTIONAL_KEYWORD);
  });

  /**
   * The shape we deliberately do NOT ship, pinned by what it costs.
   *
   * `ParametersOfInterestMetadata` writes `<moe>` and `<mop>` as
   * `:> SemanticMetadata` with an `annotatedElement` redefinition and a
   * `baseType` binding. Measured here: three unresolved-specialization warnings
   * on a file that is otherwise clean, and a body that does not come back the
   * way it went in. A vocabulary that cannot be pasted into a user's file
   * without three warnings is not a vocabulary that can be shipped.
   */
  it('is not the SemanticMetadata shape, which costs three warnings and a rewrite', async () => {
    const semantic = `package SysproseVerification {
    attribute exceptionalOutcomes[*] nonunique;
    metadata def <exceptional> ExceptionalOutcome :> SemanticMetadata {
        :>> annotatedElement : SysML::Usage;
        :>> baseType = exceptionalOutcomes meta SysML::Usage;
    }
}`;
    const report = await checkText(semantic, { library: 'full' });
    expect(report.summary.errors).toBe(0);
    expect(
      report.diagnostics.filter((d) => d.code === 'ref/unresolved-specialization').length,
    ).toBe(3);
    // And the round trip is not the identity: the redefinition comes back in
    // the serializer's own order.
    expect(serializeModel(parseModel(semantic).model)).not.toBe(semantic);
  });
});

/**
 * The ratchet. Every spelling below is a spelling this tool does not own, and
 * every one of them has to survive a file being opened and saved here.
 */
describe('the interoperability ratchet — anybody’s vocabulary, read and preserved', () => {
  /** The six declarations §2.1 measured the mechanism on. */
  const HOSTS = [
    'action def Launch;',
    'action launch;',
    'use case def Ditch;',
    'state failsafe;',
    'in port telemetry;',
    'attribute margin;',
  ];

  /** The shipped spelling, a qualified one, four foreign ones, one misspelling. */
  const SPELLINGS = [
    'exceptional',
    'SysproseVerification::exceptional',
    'Exception',
    'precondition',
    'postcondition',
    'Observable',
    'precondtion',
  ];

  const modelFor = (keyword: string): string =>
    `package P {\n${HOSTS.map((h) => `    #${keyword} ${h}`).join('\n')}\n}`;

  it.each(SPELLINGS)('`#%s` parses clean on all six hosts and is kept as written', async (keyword) => {
    const text = modelFor(keyword);
    const model = parsed(text);
    const report = await checkText(text, { library: 'full' });
    // ZERO diagnostics, which is what the ledger and CONFORMANCE.md §7 both
    // claim — not "zero errors and warnings". An `infos` count left unpinned is
    // how an info row about a keyword lands one day with three documents saying
    // the ratchet is at zero and a green gate agreeing with them.
    expect(
      report.summary,
      report.diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`).join('\n'),
    ).toEqual({ errors: 0, warnings: 0, infos: 0 });
    expect(report.diagnostics).toEqual([]);

    // Six hosts, six keywords, each stored VERBATIM — qualification included.
    const tagged = model.all().filter((el) => Array.isArray(el.attrs.metadata));
    expect(tagged).toHaveLength(HOSTS.length);
    for (const el of tagged) {
      expect(keywordsOf(model, el.id).map((k) => k.written)).toEqual([keyword]);
    }
  });

  it.each(SPELLINGS)('`#%s` round-trips idempotently from the first save', (keyword) => {
    const text = modelFor(keyword);
    const first = serializeModel(parsed(text));
    // This model is already in the serializer's canonical shape, so the first
    // save is the identity as well.
    expect(first).toBe(text);
    expect(serializeModel(parsed(first))).toBe(first);
  });

  /**
   * The caveat, measured rather than promised away.
   *
   * The round trip is idempotent **from the second save**, not byte-identical
   * from arbitrary input: a keyword written on its own line comes back on the
   * declaration's line. Every claim this plan makes about round-tripping is
   * written against this, and a test that asserted byte-identity from arbitrary
   * input would be asserting something the serializer has never done.
   */
  it('normalises a keyword written on its own line, then is stable', () => {
    const written = 'package P {\n    #exceptional\n    part def Abort;\n}';
    const first = serializeModel(parsed(written));
    expect(first).not.toBe(written);
    expect(first).toBe('package P {\n    #exceptional part def Abort;\n}');
    expect(serializeModel(parsed(first))).toBe(first);
  });
});

describe('keywordsOf — what is written', () => {
  const TEXT = `package P {
    #Safety #'requirement' #SysproseStatements::prose part def Mixed;
    part def Bare;
}`;

  it('reads every keyword on a declaration, in order and verbatim', () => {
    const model = parsed(TEXT);
    const mixed = keywordsOf(model, byName(model, 'Mixed').id);
    expect(mixed.map((k) => k.written)).toEqual([
      'Safety',
      "'requirement'",
      'SysproseStatements::prose',
    ]);
    // The parsed halves: the last segment unquoted is the name a `metadata def`
    // answers to, and the qualifier is kept rather than thrown away.
    expect(mixed.map((k) => k.name)).toEqual(['Safety', 'requirement', 'prose']);
    expect(mixed.map((k) => k.qualifier)).toEqual([[], [], ['SysproseStatements']]);
  });

  it('answers the empty list for an element with no keyword, and for no element', () => {
    const model = parsed(TEXT);
    expect(keywordsOf(model, byName(model, 'Bare').id)).toEqual([]);
    expect(keywordsOf(model, 'no-such-id')).toEqual([]);
  });

  /**
   * `statement-kind.ts` consumes this reader rather than reading
   * `attrs.metadata` itself. The case that proves it is the QUALIFIED spelling:
   * a reader that split on nothing would see `SysproseStatements::prose` and
   * find no kind.
   */
  it('is the reader the statement kinds go through', () => {
    const model = parsed('package P {\n    #SysproseStatements::prose part def Note;\n}');
    expect(statementKindOf(model, byName(model, 'Note').id)).toBe('prose');
  });
});

describe('resolveKeyword — what it names', () => {
  const WITH_IMPORT = `${SYSPROSE_VERIFICATION_LIBRARY}

package P {
    import SysproseVerification::*;
    #exceptional part def Abort;
    #precondtion action launch;
    #Exception part def Retry;
}`;

  it('returns the definition for `#exceptional` and undefined for `#precondtion`', () => {
    const model = parsed(WITH_IMPORT);
    const abort = keywordsOf(model, byName(model, 'Abort').id)[0];
    const def = resolveKeyword(model, abort);
    expect(def?.declaredName).toBe(EXCEPTIONAL_DEFINITION);
    expect(def?.declaredShortName).toBe(EXCEPTIONAL_KEYWORD);

    const misspelt = keywordsOf(model, byName(model, 'launch').id)[0];
    expect(resolveKeyword(model, misspelt)).toBeUndefined();
  });

  /**
   * Resolution is the notation's, not a string match. A keyword names a
   * `metadata def` IN SCOPE, so a sibling package that neither declares nor
   * imports the vocabulary resolves nothing — which is the specification's
   * answer and the reason `verification/keyword-names-nothing` exists at all.
   */
  it('needs the definition in scope: an import resolves, a sibling package does not', () => {
    const noImport = parsed(`${SYSPROSE_VERIFICATION_LIBRARY}

package P {
    #exceptional part def Abort;
}`);
    expect(resolveKeyword(noImport, keywordsOf(noImport, byName(noImport, 'Abort').id)[0])).toBeUndefined();

    // …and the qualified spelling resolves from anywhere, because it names the
    // package it is in.
    const qualified = parsed(`${SYSPROSE_VERIFICATION_LIBRARY}

package P {
    #SysproseVerification::exceptional part def Abort;
}`);
    expect(
      resolveKeyword(qualified, keywordsOf(qualified, byName(qualified, 'Abort').id)[0])
        ?.declaredName,
    ).toBe(EXCEPTIONAL_DEFINITION);
  });

  /**
   * A keyword that collides with a hard keyword of the notation must be QUOTED,
   * and the standard's own `#derive` is one of them — `#derive part def A;`
   * does not parse, exactly as a bare `#requirement` does not. The escape is
   * the notation's own unrestricted name, and the token is stored with its
   * quotes, so every reading here unquotes the last segment before comparing.
   *
   * Recorded as a case because it is the one shape of somebody else's
   * vocabulary this tool cannot read as written, and a limitation nobody has
   * measured is a limitation nobody can work around.
   */
  it('reads a quoted keyword that collides with a hard keyword of the notation', async () => {
    expect(
      parseModel('package P {\n    #derive part def A;\n}').diagnostics.some(
        (d) => d.severity === 'error',
      ),
      'a bare #derive is expected NOT to parse — if it now does, drop the quotes here',
    ).toBe(true);

    const { model } = await loadModelText("package P {\n    #'derive' part def Derived1;\n}", {
      fileName: 'quoted.sysml',
    });
    const el = model!.all().find((e) => e.declaredName === 'Derived1');
    expect(el).toBeDefined();
    const [keyword] = keywordsOf(model!, el!.id);
    expect(keyword.written).toBe("'derive'");
    expect(keyword.name).toBe('derive');
    expect(model!.qualifiedName(resolveKeyword(model!, keyword)!.id)).toBe(
      'RequirementDerivation::DerivedRequirementMetadata',
    );
  }, 60_000);

  /**
   * A quoted keyword is ONE name, separators and all.
   *
   * The escape §7.27.4 gives for a name that collides with a hard keyword is the
   * single-quoted unrestricted name, and an unrestricted name may hold anything
   * — a `.` and a `::` included. A first draft re-joined the UNQUOTED segments
   * before resolving, which shattered exactly the shape the quoting exists for:
   * `#'a.b'` was re-split into `a` then `b` and "resolved" to `a::b`, a
   * definition that answers to neither. §3.12's one MUST-NEVER for this reader
   * is reporting a keyword as resolved when no `MetadataDefinition` in scope
   * carries that name, so this is that clause with a case behind it.
   */
  it('does not shatter a quoted name that contains a separator', async () => {
    const text =
      "package a {\n    metadata def b;\n}\n\npackage P {\n    #'a.b' part def Tagged;\n}";
    const report = await checkText(text, { library: 'full' });
    expect(report.summary).toMatchObject({ errors: 0, warnings: 0 });
    const model = parsed(text);
    expect(serializeModel(model)).toBe(text);
    const [keyword] = keywordsOf(model, byName(model, 'Tagged').id);
    expect(keyword.written).toBe("'a.b'");
    expect(keyword.name).toBe('a.b');
    // `a::b` exists and is a MetadataDefinition. It is still not what `#'a.b'`
    // names, and saying it was would be this reader inventing a resolution.
    expect(byName(model, 'b').eClass).toBe('MetadataDefinition');
    expect(resolveKeyword(model, keyword)).toBeUndefined();
  }, 60_000);

  it('accepts only a MetadataDefinition as the answer', () => {
    // `Abort` is a part definition with the same name as the keyword; a
    // resolver that took the first thing answering to the name would bind the
    // keyword to it and report the file as using a vocabulary it does not have.
    const model = parsed('package P {\n    part def exceptional;\n    #exceptional part def Abort;\n}');
    expect(resolveKeyword(model, keywordsOf(model, byName(model, 'Abort').id)[0])).toBeUndefined();
  });

  /**
   * The bundled library is the namespace of last resort, exactly as it is for a
   * type reference — which is what makes the standard library's OWN keywords
   * resolve. Without it, `#moe` on an attribute would be reported as naming
   * nothing, on a file using the specification's own vocabulary.
   */
  it('falls back to the bundled library for its own keywords', async () => {
    const { model } = await loadModelText('package P {\n    #moe attribute range;\n}', {
      fileName: 'moe.sysml',
    });
    expect(model).toBeDefined();
    const el = model!.all().find((e) => e.declaredName === 'range' && e.attrs.isLibrary !== true);
    expect(el, 'no attribute named range').toBeDefined();
    const def = resolveKeyword(model!, keywordsOf(model!, el!.id)[0]);
    expect(def?.eClass).toBe('MetadataDefinition');
    expect(model!.qualifiedName(def!.id)).toBe(
      'ParametersOfInterestMetadata::MeasureOfEffectiveness',
    );
  }, 60_000);
});

describe('hasKeyword — did the model use the vocabulary this tool ships?', () => {
  const TEXT = `${SYSPROSE_VERIFICATION_LIBRARY}

package P {
    import SysproseVerification::*;
    #exceptional part def Abort;
    #Exception part def Retry;
    part def Plain;
}`;

  it('answers by resolution, under any of the definition’s three names', () => {
    const model = parsed(TEXT);
    const abort = byName(model, 'Abort').id;
    for (const name of [
      EXCEPTIONAL_DEFINITION,
      EXCEPTIONAL_KEYWORD,
      `${SYSPROSE_VERIFICATION_PACKAGE}::${EXCEPTIONAL_DEFINITION}`,
    ]) {
      expect(hasKeyword(model, abort, name), `by ${name}`).toBe(true);
    }
    expect(hasKeyword(model, byName(model, 'Plain').id, EXCEPTIONAL_DEFINITION)).toBe(false);
  });

  /**
   * THE REVIEW TARGET of this commit, asked directly: does any code path treat
   * an alias hit as if the model had used a Sysprose keyword?
   *
   * `#Exception` is in the foreign-alias table, so the inventory can say what
   * this tool thinks the file meant. It is NOT `#exceptional`, and the
   * predicate an engine asks before acting on a tag must say so — otherwise a
   * vocabulary this tool did not define changes what it decides, silently.
   */
  it('is false for a third-party spelling, however well this tool understands it', () => {
    const model = parsed(TEXT);
    const retry = byName(model, 'Retry').id;
    expect(foreignKeyword('Exception')).toBeDefined();
    expect(hasKeyword(model, retry, EXCEPTIONAL_DEFINITION)).toBe(false);
    expect(hasKeyword(model, retry, EXCEPTIONAL_KEYWORD)).toBe(false);
  });

  it('is false for a keyword that names nothing, however it is spelled', () => {
    const model = parsed('package P {\n    #exceptional part def Abort;\n}');
    expect(hasKeyword(model, byName(model, 'Abort').id, EXCEPTIONAL_DEFINITION)).toBe(false);
  });
});

describe('the foreign-alias table', () => {
  it('maps the four spellings the plan names, and nothing else', () => {
    expect([...FOREIGN_KEYWORD_ALIASES.keys()].sort()).toEqual([
      'Exception',
      'exception',
      'postcondition',
      'precondition',
    ]);
    // `#Observable` is HELD, not shipped: an alias for it would read as a
    // commitment this plan has not made.
    expect(FOREIGN_KEYWORD_ALIASES.has('Observable')).toBe(false);
  });

  it('reads Exception as the shipped keyword and the two conditions as clause roles', () => {
    expect(FOREIGN_KEYWORD_ALIASES.get('Exception')?.reads).toMatchObject({
      as: 'keyword',
      keyword: EXCEPTIONAL_QUALIFIED_KEYWORD,
    });
    expect(FOREIGN_KEYWORD_ALIASES.get('exception')?.reads).toMatchObject({ as: 'keyword' });
    expect(FOREIGN_KEYWORD_ALIASES.get('precondition')?.reads).toEqual({
      as: 'clause-role',
      role: 'assume',
    });
    expect(FOREIGN_KEYWORD_ALIASES.get('postcondition')?.reads).toEqual({
      as: 'clause-role',
      role: 'require',
    });
  });

  it('gives every entry the provenance sentence that has to be printed with it', () => {
    for (const [spelling, alias] of FOREIGN_KEYWORD_ALIASES) {
      expect(alias.spelling, `${spelling} is keyed on its own spelling`).toBe(spelling);
      expect(alias.note.length, `${spelling} has a provenance sentence`).toBeGreaterThan(20);
      // The word this lane may never use about somebody else's vocabulary.
      expect(alias.note.toLowerCase()).not.toMatch(/\bis standard\b|\bstandard vocabulary\b/);
    }
  });

  it('matches the last segment, so a qualified foreign keyword is still foreign', () => {
    expect(foreignKeyword('TheirTool::Exception')?.spelling).toBe('Exception');
    expect(foreignKeyword('exceptional')).toBeUndefined();
    expect(foreignKeyword('Safety')).toBeUndefined();
  });
});

describe('the packages this tool calls its own', () => {
  /**
   * `keywords.ts` names them as strings rather than importing the two constants
   * — importing `statement-kind.ts` back would close a cycle — so the copy is
   * checked here instead of left to good intentions.
   */
  it('are exactly the two the modules that declare them name', () => {
    expect([...SYSPROSE_KEYWORD_PACKAGES].sort()).toEqual(
      [STATEMENT_KIND_PACKAGE, SYSPROSE_VERIFICATION_PACKAGE].sort(),
    );
  });
});
