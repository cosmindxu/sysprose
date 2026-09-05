import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Model, type ElementRecord } from '@core/index';
import { parseModel, serializeModel } from '@text/index';
import { checkText } from '@text/check';
import {
  STATEMENT_KINDS,
  STATEMENT_KIND_KEYWORD,
  STATEMENT_KIND_DEFINITIONS,
  STATEMENT_KIND_PACKAGE,
  STATEMENT_KIND_LIBRARY,
  isStatementKind,
  canCarryStatementKind,
  statementKindOf,
  writtenStatementKind,
  isNonNormativeStatement,
  untaggedStatementKindLabel,
  setStatementKind,
  clearStatementKind,
  type StatementKind,
} from '@semantics/index';

/** The one element a snippet declares, by name. */
const byName = (model: Model, name: string) => {
  const el = model.all().find((e) => e.declaredName === name);
  expect(el, `no element named ${name}`).toBeDefined();
  return el!;
};

describe('statement kinds — the shipped vocabulary', () => {
  it('has the three values, each with a keyword spelling and a metadata definition', () => {
    expect([...STATEMENT_KINDS]).toEqual(['requirement', 'prose', 'prompt']);
    for (const kind of STATEMENT_KINDS) {
      expect(STATEMENT_KIND_KEYWORD[kind], `${kind} has no keyword spelling`).toBeTruthy();
      expect(STATEMENT_KIND_DEFINITIONS[kind], `${kind} has no definition name`).toBeTruthy();
    }
    expect(isStatementKind('prose')).toBe(true);
    expect(isStatementKind('Prose')).toBe(false);
    expect(isStatementKind('assumption')).toBe(false);
  });

  /**
   * The definitions are shipped as text a person pastes or imports, so the text
   * has to be text this tool actually accepts — checked, not asserted.
   */
  it('the shipped definitions parse, check clean and round-trip byte-identically', async () => {
    const parsed = parseModel(STATEMENT_KIND_LIBRARY);
    const errors = parsed.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    expect(serializeModel(parsed.model)).toBe(STATEMENT_KIND_LIBRARY);

    const report = await checkText(STATEMENT_KIND_LIBRARY, { library: 'full' });
    expect(
      report.summary,
      report.diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`).join('\n'),
    ).toMatchObject({ errors: 0, warnings: 0, infos: 0 });

    const pkg = parsed.model.all().find((e) => e.eClass === 'Package');
    expect(pkg?.declaredName).toBe(STATEMENT_KIND_PACKAGE);
    for (const kind of STATEMENT_KINDS) {
      const def = byName(parsed.model, STATEMENT_KIND_DEFINITIONS[kind]);
      expect(def.eClass).toBe('MetadataDefinition');
      // The short name is what a `#keyword` names — unquoted by the parser.
      expect(def.declaredShortName).toBe(kind);
    }
  });
});

describe('statement kinds — reading a kind off an element', () => {
  it.each(STATEMENT_KINDS)('%s round-trips through the text notation', (kind: StatementKind) => {
    const src = `package M {\n    #${STATEMENT_KIND_KEYWORD[kind]} part p1;\n}`;
    const first = parseModel(src);
    expect(first.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const p1 = byName(first.model, 'p1');
    expect(statementKindOf(first.model, p1.id)).toBe(kind);

    const saved = serializeModel(first.model);
    expect(saved).toBe(src);
    const second = parseModel(saved);
    expect(statementKindOf(second.model, byName(second.model, 'p1').id)).toBe(kind);
  });

  it('reads a qualified keyword, and ignores keywords that are not statement kinds', () => {
    const { model } = parseModel(
      `package M { #${STATEMENT_KIND_PACKAGE}::prose part p1; #Safety part p2; }`,
    );
    expect(statementKindOf(model, byName(model, 'p1').id)).toBe('prose');
    expect(statementKindOf(model, byName(model, 'p2').id)).toBeUndefined();
  });

  it('an explicit keyword wins over the metaclass fallback', () => {
    const { model } = parseModel(`package M { #prose requirement <R1> r1; }`);
    expect(statementKindOf(model, byName(model, 'r1').id)).toBe('prose');
  });

  /**
   * A GAP, PINNED SO IT CANNOT MOVE UNNOTICED. The same metadata mechanism has
   * a second notation — the annotating usage `@prose about p1;`, and its owned
   * form `part p1 { @prose; }`. Both parse here and both round-trip; neither is
   * read, because the reader deliberately looks at the `#keyword` alone (seeing
   * the `@` form means resolving the names in `about` against scope). The
   * module header says so; this is the assertion that keeps that sentence true,
   * and the one to delete when a later section closes the gap.
   */
  it('the `@prose` annotation form is NOT read — for the target or for itself', () => {
    const detached = `package M {\n    part p1;\n    @prose about p1;\n}`;
    const first = parseModel(detached);
    expect(first.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(serializeModel(first.model)).toBe(detached);
    const meta = first.model.all().find((e) => e.eClass === 'MetadataUsage');
    expect(meta?.attrs.type, 'the annotation names the prose definition').toBe('prose');
    expect(statementKindOf(first.model, byName(first.model, 'p1').id)).toBeUndefined();
    expect(statementKindOf(first.model, meta!.id)).toBeUndefined();

    const owned = `package M {\n    part p1 {\n        @prose;\n    }\n}`;
    const second = parseModel(owned);
    expect(second.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(statementKindOf(second.model, byName(second.model, 'p1').id)).toBeUndefined();
  });
});

describe('statement kinds — the fallbacks', () => {
  it('a requirement with no keyword is a requirement', () => {
    const { model } = parseModel(`package M { requirement <R1> r1; requirement def RD; }`);
    expect(statementKindOf(model, byName(model, 'r1').id)).toBe('requirement');
    expect(statementKindOf(model, byName(model, 'RD').id)).toBe('requirement');
  });

  it('documentation and a comment are prose', () => {
    const { model } = parseModel(`package M { part p1 { doc /* what it does */ } comment C about p1 /* why */ }`);
    const doc = model.all().find((e) => e.eClass === 'Documentation');
    const comment = model.all().find((e) => e.eClass === 'Comment');
    expect(doc, 'the snippet declares a Documentation').toBeDefined();
    expect(comment, 'the snippet declares a Comment').toBeDefined();
    expect(statementKindOf(model, doc!.id)).toBe('prose');
    expect(statementKindOf(model, comment!.id)).toBe('prose');
  });

  it('anything else has no statement kind, and an unknown id has none either', () => {
    const { model } = parseModel(`package M { part p1; attribute a : Real; }`);
    expect(statementKindOf(model, byName(model, 'p1').id)).toBeUndefined();
    expect(statementKindOf(model, byName(model, 'M').id)).toBeUndefined();
    expect(statementKindOf(model, 'no-such-element')).toBeUndefined();
  });

  it('reading a model with no keyword leaves it exactly as it was', () => {
    const src = `package M {\n    requirement <R1> r1;\n    part p1 {\n        doc /* text */\n    }\n}`;
    const { model } = parseModel(src);
    const before = JSON.stringify(model.toJSON());
    for (const el of model.all()) statementKindOf(model, el.id);
    expect(JSON.stringify(model.toJSON())).toBe(before);
    expect(serializeModel(model)).toBe(src);
  });
});

/**
 * The distinction an EDITOR lives on: what an element READS as versus what it
 * actually CARRIES.
 *
 * A Kind control driven by the effective answer shows `requirement` on an
 * untagged requirement, and both moves out of that state become unreachable —
 * clearing changes nothing, and choosing `requirement` fires no change event
 * because the browser thinks it is already selected.
 */
describe('statement kinds — written versus effective', () => {
  it('an untagged requirement reads as one but carries nothing', () => {
    const { model } = parseModel(`package M { requirement <R1> r1; }`);
    const r1 = byName(model, 'r1').id;
    expect(statementKindOf(model, r1)).toBe('requirement');
    expect(writtenStatementKind(model, r1)).toBeUndefined();
  });

  it('a keyword makes the two answers agree', () => {
    const { model } = parseModel(`package M { #prose requirement <R1> r1; }`);
    const r1 = byName(model, 'r1').id;
    expect(statementKindOf(model, r1)).toBe('prose');
    expect(writtenStatementKind(model, r1)).toBe('prose');
  });

  it('tagging a requirement explicitly is a real, readable change', () => {
    const { model } = parseModel(`package M { requirement <R1> r1; }`);
    const r1 = byName(model, 'r1').id;
    setStatementKind(model, r1, 'requirement');
    expect(writtenStatementKind(model, r1)).toBe('requirement');
    clearStatementKind(model, r1);
    expect(writtenStatementKind(model, r1)).toBeUndefined();
    expect(statementKindOf(model, r1)).toBe('requirement');
  });

  it('an unknown id carries nothing', () => {
    const { model } = parseModel(`package M { part p1; }`);
    expect(writtenStatementKind(model, 'no-such-element')).toBeUndefined();
  });

  /**
   * One label, so the Properties panel and the requirements grid cannot come to
   * describe the same state two different ways — and never the bare word
   * `requirement`, which would put two entries in a Kind list reading the same
   * word and meaning different things.
   */
  it('the blank entry of a Kind control says what the element reads as', () => {
    expect(untaggedStatementKindLabel(undefined)).toBe('(untagged)');
    expect(untaggedStatementKindLabel('requirement')).toContain('requirement');
    expect(untaggedStatementKindLabel('requirement')).not.toBe('requirement');
    for (const kind of STATEMENT_KINDS) {
      expect(untaggedStatementKindLabel(kind)).toContain('untagged');
    }
  });
});

/**
 * The exemption a rule that also judges plain constraints has to ask for.
 *
 * It is deliberately NOT the negation of "is normative": a `constraint c { … }`
 * carries no kind at all, and a rule using the negation would have stopped
 * checking every ordinary constraint in every model.
 */
describe('statement kinds — what binds nothing', () => {
  it('only an explicit prose or prompt tag is exempt', () => {
    const { model } = parseModel(
      `package M {\n    requirement <R1> r1;\n    #prose requirement <R2> note;\n    #prompt requirement <R3> hint;\n    constraint c { 1 < 2 }\n    part p1;\n}`,
    );
    expect(isNonNormativeStatement(model, byName(model, 'note').id)).toBe(true);
    expect(isNonNormativeStatement(model, byName(model, 'hint').id)).toBe(true);
    expect(isNonNormativeStatement(model, byName(model, 'r1').id)).toBe(false);
    expect(isNonNormativeStatement(model, byName(model, 'c').id)).toBe(false);
    expect(isNonNormativeStatement(model, byName(model, 'p1').id)).toBe(false);
  });

  it('a doc and a comment are prose, so they bind nothing either', () => {
    const { model } = parseModel(`package M { part p1 { doc /* what it does */ } }`);
    const doc = model.all().find((e) => e.eClass === 'Documentation')!;
    expect(isNonNormativeStatement(model, doc.id)).toBe(true);
  });
});

describe('statement kinds — writing a kind', () => {
  it('adds the keyword, and the saved text reads back as that kind', () => {
    const src = `package M { part p1; }`;
    const { model } = parseModel(src);
    const p1 = byName(model, 'p1');
    setStatementKind(model, p1.id, 'prompt');
    expect(statementKindOf(model, p1.id)).toBe('prompt');

    const saved = serializeModel(model);
    expect(saved).toContain('#prompt part p1;');
    const reparsed = parseModel(saved);
    expect(reparsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(statementKindOf(reparsed.model, byName(reparsed.model, 'p1').id)).toBe('prompt');
  });

  it('replaces the kind in place and keeps every other keyword', () => {
    const { model } = parseModel(`package M { #Safety #prose #prompt part p1; }`);
    const p1 = byName(model, 'p1');
    setStatementKind(model, p1.id, 'requirement');
    expect(model.require(p1.id).attrs.metadata).toEqual(['Safety', "'requirement'"]);
    expect(statementKindOf(model, p1.id)).toBe('requirement');
    expect(serializeModel(model)).toContain(`#Safety #'requirement' part p1;`);
  });

  /**
   * Clearing is the way back to "this element makes no statement of its own".
   *
   * A part is not a statement until somebody says it is, so the writer needs an
   * inverse — otherwise the first click in the Kind selector is one-way and the
   * only way out of it is the text editor.
   */
  it('clearing removes the kind keyword and leaves the others alone', () => {
    const { model } = parseModel(`package M { #Safety #prompt part p1; }`);
    const p1 = byName(model, 'p1');
    clearStatementKind(model, p1.id);
    expect(model.require(p1.id).attrs.metadata).toEqual(['Safety']);
    expect(statementKindOf(model, p1.id)).toBeUndefined();
    expect(serializeModel(model)).toContain('#Safety part p1;');
  });

  it('clearing the only keyword removes the attribute, not just its contents', () => {
    const { model } = parseModel(`package M { #prose part p1; }`);
    const p1 = byName(model, 'p1');
    clearStatementKind(model, p1.id);
    expect(model.require(p1.id).attrs.metadata).toBeUndefined();
    const saved = serializeModel(model);
    expect(saved).toContain('part p1;');
    expect(saved).not.toContain('#');
  });

  it('clearing a kind that was never written changes nothing', () => {
    const { model } = parseModel(`package M { part p1; }`);
    const p1 = byName(model, 'p1');
    const before = serializeModel(model);
    clearStatementKind(model, p1.id);
    expect(model.require(p1.id).attrs.metadata).toBeUndefined();
    expect(serializeModel(model)).toBe(before);
  });

  it('a requirement cleared of its keyword reads as a requirement again', () => {
    const { model } = parseModel(`package M { #prose requirement r1; }`);
    const r1 = byName(model, 'r1');
    expect(statementKindOf(model, r1.id)).toBe('prose');
    clearStatementKind(model, r1.id);
    // Not undefined: the metaclass still says what it is.
    expect(statementKindOf(model, r1.id)).toBe('requirement');
  });

  it('setting the same kind twice does not write it twice', () => {
    const { model } = parseModel(`package M { part p1; }`);
    const p1 = byName(model, 'p1');
    setStatementKind(model, p1.id, 'prose');
    setStatementKind(model, p1.id, 'prose');
    expect(model.require(p1.id).attrs.metadata).toEqual(['prose']);
  });

  it('refuses an element whose notation has nowhere to put the keyword', () => {
    const model = new Model();
    const pkg = model.create('Package', { declaredName: 'M' });
    const part = model.create('PartUsage', { declaredName: 'p1', ownerId: pkg.id });
    const doc = model.create('Documentation', { ownerId: part.id, attrs: { body: 'why' } });
    const comment = model.create('Comment', { ownerId: part.id, attrs: { body: 'why' } });
    const rep = model.create('TextualRepresentation', {
      ownerId: part.id,
      attrs: { language: 'js', body: '1' },
    });
    const annotation = model.create('MetadataUsage', {
      ownerId: part.id,
      attrs: { annotation: true, type: 'prose' },
    });
    const fork = model.create('ForkNode', { declaredName: 'fk', ownerId: pkg.id });
    const implicit = model.create('PortUsage', { ownerId: part.id, attrs: { implicit: true } });
    const faulted = model.create('PartUsage', {
      ownerId: pkg.id,
      attrs: { unparsedText: 'blok def Vehicle;' },
    });
    const edge = model.create('Dependency', {
      ownerId: pkg.id,
      source: [part.id],
      target: [part.id],
    });

    // The truth table, both halves. Every `false` row is a shape the serializer
    // routes away from `header()` — or, for the enum literal, one whose emitted
    // prefix does not parse back.
    expect(canCarryStatementKind(part)).toBe(true);
    expect(canCarryStatementKind(pkg)).toBe(true);
    expect(canCarryStatementKind(doc)).toBe(false);
    expect(canCarryStatementKind(comment)).toBe(false);
    expect(canCarryStatementKind(rep)).toBe(false);
    expect(canCarryStatementKind(annotation)).toBe(false);
    expect(canCarryStatementKind(fork)).toBe(false);
    expect(canCarryStatementKind(implicit)).toBe(false);
    expect(canCarryStatementKind(faulted)).toBe(false);
    expect(canCarryStatementKind(edge)).toBe(false);

    for (const el of [doc, comment, rep, annotation, fork, implicit, faulted, edge]) {
      expect(() => setStatementKind(model, el.id, 'prose'), el.eClass).toThrow(/cannot carry/i);
      // A refused write leaves the element alone.
      expect(model.require(el.id).attrs.metadata, el.eClass).toBeUndefined();
    }
    expect(() => setStatementKind(model, 'no-such-element', 'prose')).toThrow(/no such element/i);
    expect(() =>
      setStatementKind(model, part.id, 'assumption' as unknown as StatementKind),
    ).toThrow(/not a statement kind/i);
  });
});

/**
 * THE WRITER'S REAL CONTRACT: whatever it accepts survives a save.
 *
 * The first version of this module asked the METACLASS whether a keyword could
 * be written, and the serializer does not — it dispatches on attributes and
 * endpoints too. So `setStatementKind` said yes to `connect a to b;`, to a
 * requirement's `subject`, to a state's `entry`, to `perform`, to `return`, to
 * every transition — 32 of the 94 elements it accepted in `uav-isr.sysml` — and
 * the keyword was gone the next time the file was written, silently. On an enum
 * literal it was worse: the prefix WAS emitted, into a file that no longer
 * parsed. These tests assert the invariant that catches all of it, rather than
 * the metaclass list that missed it.
 */

/** Every declaration form the notation has, one file. */
const ALL_STATEMENT_FORMS = `package M {
    import Base::*;
    part a;
    part b;
    alias q for a;
    connect a to b;
    connection c1 : Base::C;
    flow ff from a to b;
    bind a = b;
    part def PD;
    part p2 : PD;
    enum def Level {
        low = 0.25;
    }
    requirement <R1> r1 {
        subject v : PD;
        assume constraint ac { 1 > 0 }
        require constraint rc { 2 > 1 }
    }
    satisfy r1 by a;
    state def S {
        entry action e1;
        do action d1;
        exit action x1;
        state s1;
        state s2;
        transition first s1 then s2;
    }
    action def A {
        perform action pa;
        accept ev1;
        send sig to a;
        assign av := 1;
        if 1 > 0 { action t1; }
        while 1 > 0 { action w1; }
        for i in 1..2 { action f1; }
        return r : PD;
        fork fk;
        join jn;
    }
    part p3 {
        doc /* d */
        @prose;
        rep RR language "js" /* 1 */
    }
    comment CC about a /* c */
    metadata md : Base::MD;
}`;

/** `PartUsage a`, `ConstraintUsage ac`, … — enough to read a failure by eye. */
const label = (el: ElementRecord) =>
  `${el.eClass}${el.declaredName ? ` ${el.declaredName}` : ''}`;

/**
 * Write a kind on every element the guard accepts, save, re-parse, and report
 * what came back. This is the whole invariant in one helper: nothing the writer
 * accepted may be missing afterwards, and the saved file must still parse.
 */
function writeEverywhereAndReload(src: string): {
  accepted: string[];
  lost: string[];
  errors: string[];
} {
  const { model } = parseModel(src);
  const accepted = model.all().filter(canCarryStatementKind);
  for (const el of accepted) setStatementKind(model, el.id, 'prompt');
  const saved = serializeModel(model);
  const reloaded = parseModel(saved);
  const keptLabels = reloaded.model
    .all()
    .filter((e) => statementKindOf(reloaded.model, e.id) === 'prompt')
    .map(label);
  // Count-aware difference: two elements may share a label.
  const pool = [...keptLabels];
  const lost: string[] = [];
  for (const el of accepted) {
    const at = pool.indexOf(label(el));
    if (at === -1) lost.push(label(el));
    else pool.splice(at, 1);
  }
  return {
    accepted: accepted.map(label),
    lost,
    errors: reloaded.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => `${d.code} ${d.message}`),
  };
}

describe('statement kinds — what the writer accepts, a save keeps', () => {
  it('the snippet exercising every statement form parses cleanly', () => {
    const { diagnostics } = parseModel(ALL_STATEMENT_FORMS);
    expect(diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([]);
  });

  it('refuses every statement form that has no prefix-metadata slot', () => {
    const { model } = parseModel(ALL_STATEMENT_FORMS);
    const refused = model.all().filter((el) => !canCarryStatementKind(el));
    // Named one by one: each of these once passed the metaclass guard.
    for (const expected of [
      'NamespaceImport', // import Base::*;
      'Membership q', // alias q for a;
      'ConnectionUsage', // connect a to b;   (the endpoint-bearing one)
      'Flow ff', // flow ff from a to b;
      'BindingConnectorAsUsage', // bind a = b;
      'ReferenceUsage low', // enum literal
      'ReferenceUsage v', // subject
      'ConstraintUsage ac', // assume
      'ConstraintUsage rc', // require
      'Satisfy', // satisfy r1 by a;
      'ActionUsage e1', // entry
      'ActionUsage d1', // do
      'ActionUsage x1', // exit
      'TransitionUsage', // transition first s1 then s2;
      'PerformActionUsage pa',
      'AcceptActionUsage ev1',
      'SendActionUsage sig',
      'AssignmentActionUsage av',
      'IfActionUsage',
      'WhileLoopActionUsage',
      'ForLoopActionUsage',
      'ReferenceUsage r', // return
      'ForkNode fk',
      'JoinNode jn',
      'Documentation',
      'MetadataUsage', // @prose;  (the annotating form)
      'TextualRepresentation RR',
      'Comment CC',
    ]) {
      expect(refused.map(label), `${expected} must be refused`).toContain(expected);
    }
    // …and the plain declarations are still writable, the endpoint-less
    // connection and the DECLARED metadata usage among them.
    const accepted = model.all().filter(canCarryStatementKind).map(label);
    expect(accepted).toEqual([
      'Package M',
      'PartUsage a',
      'PartUsage b',
      'ConnectionUsage c1',
      'PartDefinition PD',
      'PartUsage p2',
      'EnumerationDefinition Level',
      'RequirementUsage r1',
      'StateDefinition S',
      'StateUsage s1',
      'StateUsage s2',
      'ActionDefinition A',
      'ActionUsage t1',
      'ActionUsage w1',
      'ActionUsage f1',
      'PartUsage p3',
      'MetadataUsage md',
    ]);
  });

  it('every accepted element in that snippet still reads as its kind after a save', () => {
    const { accepted, lost, errors } = writeEverywhereAndReload(ALL_STATEMENT_FORMS);
    expect(errors, 'the saved file must still parse').toEqual([]);
    expect(lost, 'these kept no kind across the save').toEqual([]);
    expect(accepted.length).toBeGreaterThan(10);
  });

  it.each(['examples/uav-isr.sysml', 'examples/vehicle.sysml'])(
    '%s: every kind the writer accepts survives a save',
    (file: string) => {
      const src = readFileSync(resolve(__dirname, '../..', file), 'utf8');
      const { accepted, lost, errors } = writeEverywhereAndReload(src);
      expect(errors, 'the saved file must still parse').toEqual([]);
      expect(lost, 'these kept no kind across the save').toEqual([]);
      expect(accepted.length).toBeGreaterThan(20);
    },
  );

  /**
   * The one shape where the guard is not protecting against a silent loss but
   * against a corrupt save: `header()` DOES emit the prefix on a keyword-less
   * enum literal, and the file it writes no longer parses.
   */
  it('refuses an enum literal, whose emitted prefix would not parse back', () => {
    const { model } = parseModel(`package M {\n    enum def Level {\n        low = 0.25;\n    }\n}`);
    const low = byName(model, 'low');
    expect(low.attrs.keywordless).toBe(true);
    expect(canCarryStatementKind(low)).toBe(false);
    expect(() => setStatementKind(model, low.id, 'prose')).toThrow(/cannot carry/i);
    // Ground truth for the refusal: written by hand, that file is rejected.
    const byHand = parseModel(
      `package M {\n    enum def Level {\n        #prose low = 0.25;\n    }\n}`,
    );
    expect(byHand.diagnostics.filter((d) => d.severity === 'error').length).toBeGreaterThan(0);
  });
});
