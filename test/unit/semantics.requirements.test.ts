/**
 * Requirements-management facets — the ten attributes, how they are stored, and
 * what reading a requirement's id and statement means while two shapes coexist.
 *
 * The assertions here are the ones the paused RM branch shipped, brought
 * forward against today's tree, plus the three this recovery adds: `priority`
 * is enum-validated (it was declared and not enforced), clearing an attribute
 * REMOVES the key rather than writing an empty string, and a written attribute
 * survives a `.sysml` save — the last one being the reason the values live in
 * owned attribute children instead of the carrier's own `attrs` bag.
 */
import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { parseModel, serializeModel } from '@text/index';
import {
  PRIORITY_VALUES,
  RISK_LEVEL_VALUES,
  RM_ATTR_KEYS,
  RM_METADATA_NAME,
  STATUS_KIND_VALUES,
  VERDICT_KIND_VALUES,
  VERIFICATION_METHOD_VALUES,
  getRequirementAttr,
  getRequirementAttrs,
  getRequirementMetadata,
  hasRequirementAttr,
  carriesItsOwnText,
  reachesTheFile,
  requirementDoc,
  requirementShortId,
  requirementStatement,
  setRequirementAttr,
  setRequirementShortId,
  statementKindOf,
} from '../../src/semantics/index';

/** A requirement in the NATIVE shape: a short name plus an owned Documentation. */
function nativeFixture() {
  const m = new Model();
  const pkg = m.create('Package', { declaredName: 'P' });
  const req = m.create('RequirementUsage', {
    declaredName: 'maxMass',
    declaredShortName: 'R1',
    ownerId: pkg.id,
  });
  m.create('Documentation', { ownerId: req.id, attrs: { body: 'mass shall be < 2000 kg' } });
  return { m, pkg, req };
}

describe('requirement identity and statement', () => {
  it('reads the id from the native declaredShortName', () => {
    const { m, req } = nativeFixture();
    expect(requirementShortId(m, req.id)).toBe('R1');
  });

  it('reads the statement from the owned Documentation child', () => {
    const { m, req } = nativeFixture();
    const doc = requirementDoc(m, req.id);
    expect(doc).toBeDefined();
    expect(doc!.eClass).toBe('Documentation');
    expect(doc!.ownerId).toBe(req.id);
    expect(requirementStatement(m, req.id)).toBe('mass shall be < 2000 kg');
  });

  it('a requirement carrying neither has an empty id and an empty statement', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const req = f.requirement('plain', pkg.id);
    expect(m.require(req.id).declaredShortName).toBeUndefined();
    expect(requirementShortId(m, req.id)).toBe('');
    expect(requirementStatement(m, req.id)).toBe('');
    expect(requirementDoc(m, req.id)).toBeUndefined();
  });

  /**
   * The id EDIT has to land in the slot the file keeps. The mapper writes both
   * slots from `<R1>`, every reader and the serializer prefer the native one,
   * and the app's two id controls wrote the legacy one alone — so the grid and
   * the Properties box showed the new id while the Text tab and the saved file
   * kept the old one, and reopening the file reverted the edit with nothing
   * said. This is the write path both controls go through now.
   */
  it('writes the id into the slot the file keeps — a PARSED requirement re-saves with the new id', () => {
    const { model } = parseModel(
      'package P {\n    requirement <R1> maxMass {\n        doc /* body */\n    }\n}',
    );
    const req = model.ofKind('RequirementUsage')[0]!;
    // Both slots hold the same token after a parse; the edit must move the
    // native one and leave no stale copy in the legacy one.
    expect(req.declaredShortName).toBe('R1');
    expect(req.attrs.reqId).toBe('R1');

    setRequirementShortId(model, req.id, 'R9');
    expect(model.require(req.id).declaredShortName).toBe('R9');
    expect(model.require(req.id).attrs.reqId).toBeUndefined();
    expect(requirementShortId(model, req.id)).toBe('R9');

    const saved = serializeModel(model);
    expect(saved).toContain('<R9>');
    expect(saved).not.toContain('<R1>');
    const reopened = parseModel(saved).model;
    expect(requirementShortId(reopened, reopened.ofKind('RequirementUsage')[0]!.id)).toBe('R9');
  });

  it('clears the id with an empty value, and the file then carries none', () => {
    const { model } = parseModel('package P {\n    requirement <R1> maxMass;\n}');
    const req = model.ofKind('RequirementUsage')[0]!;
    setRequirementShortId(model, req.id, '');
    expect(model.require(req.id).declaredShortName).toBeUndefined();
    expect(model.require(req.id).attrs.reqId).toBeUndefined();
    expect(requirementShortId(model, req.id)).toBe('');
    // No id, not a blank id: `<''>` is a distinct state the file can hold,
    // and an emptied box must not fabricate one.
    expect(serializeModel(model)).not.toContain('<');
  });

  it('moves a legacy-only id into the native slot on the first edit', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const req = f.requirement('maxMass', pkg.id, { reqId: 'R1' });
    setRequirementShortId(m, req.id, 'R2');
    expect(m.require(req.id).declaredShortName).toBe('R2');
    expect(m.require(req.id).attrs.reqId).toBeUndefined();
    expect(serializeModel(m)).toContain('<R2>');
  });

  it('refuses to write an id onto something that is not a requirement', () => {
    const m = new Model();
    const part = m.create('PartUsage', { declaredName: 'p' });
    expect(() => setRequirementShortId(m, part.id, 'X')).toThrow(/not a requirement/);
    expect(m.require(part.id).declaredShortName).toBeUndefined();
  });

  /**
   * The id writer asks the same question the facet writer does. It did not: a
   * requirement under `blok def Vehicle { … }` took an id, showed it in the
   * grid and in the Properties box, and the next save re-emitted the faulted
   * declaration's residue — subtree included — with the old id in it.
   */
  it('refuses an id on a requirement nested inside a declaration that could not be parsed', () => {
    const src =
      'package P {\n' +
      '    blok def Vehicle {\n' +
      '        requirement <R1> r1;\n' +
      '        part def Inner {\n' +
      '            requirement <R2> r2;\n' +
      '        }\n' +
      '    }\n' +
      '    requirement <R3> outside;\n' +
      '}';
    const { model: m } = parseModel(src);
    const byName = (n: string) => m.all().find((e) => e.declaredName === n)!;
    for (const nested of [byName('r1'), byName('r2')]) {
      expect(nested.attrs.unparsedText, nested.declaredName).toBeUndefined();
      expect(() => setRequirementShortId(m, nested.id, 'R9'), nested.declaredName).toThrow(
        /declaration, or an enclosing one, could not be parsed/,
      );
      expect(requirementShortId(m, nested.id)).not.toBe('R9');
    }
    // Nothing moved, so the file is byte-for-byte what it was.
    expect(serializeModel(m)).toBe(src);
    // The sibling outside the residue is the ordinary case.
    setRequirementShortId(m, byName('outside').id, 'R9');
    expect(serializeModel(m)).toContain('<R9> outside');
  });

  it('falls back to the legacy attrs.reqId / attrs.text', () => {
    const m = new Model();
    const pkg = m.create('Package', { declaredName: 'P' });
    const legacy = m.create('RequirementUsage', {
      declaredName: 'legacyReq',
      ownerId: pkg.id,
      attrs: { reqId: 'LR-9', text: 'legacy statement' },
    });
    expect(m.require(legacy.id).declaredShortName).toBeUndefined();
    expect(requirementShortId(m, legacy.id)).toBe('LR-9');
    expect(requirementStatement(m, legacy.id)).toBe('legacy statement');
  });

  it('prefers the native short name and Documentation when both shapes are present', () => {
    const m = new Model();
    const pkg = m.create('Package', { declaredName: 'P' });
    const req = m.create('RequirementUsage', {
      declaredName: 'r',
      declaredShortName: 'NATIVE',
      ownerId: pkg.id,
      attrs: { reqId: 'LEGACY', text: 'legacy' },
    });
    m.create('Documentation', { ownerId: req.id, attrs: { body: 'native statement' } });
    expect(requirementShortId(m, req.id)).toBe('NATIVE');
    expect(requirementStatement(m, req.id)).toBe('native statement');
  });

  it('reads what the factory writes today — the legacy shape, through the fallback', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const req = f.requirement('maxMass', pkg.id, { reqId: 'R1', text: 'mass shall be < 2000 kg' });
    // Pinned deliberately: nothing in this pass rewrites the write path, so the
    // factory still authors `attrs.reqId` / `attrs.text` and the fallbacks are
    // load-bearing rather than decorative.
    expect(m.require(req.id).attrs.reqId).toBe('R1');
    expect(requirementDoc(m, req.id)).toBeUndefined();
    expect(requirementShortId(m, req.id)).toBe('R1');
    expect(requirementStatement(m, req.id)).toBe('mass shall be < 2000 kg');
  });

  it('saves the NATIVE short name, so the id a reader sees is the id the file gets', () => {
    // The reader prefers `declaredShortName`; the writer used to prefer the
    // legacy `attrs.reqId`, so an edited id displayed as the new one, saved as
    // the old one, and reverted on the next open.
    const m = new Model();
    const pkg = m.create('Package', { declaredName: 'P' });
    const req = m.create('RequirementUsage', {
      declaredName: 'r',
      declaredShortName: 'NATIVE',
      ownerId: pkg.id,
      attrs: { reqId: 'LEGACY' },
    });
    expect(requirementShortId(m, req.id)).toBe('NATIVE');
    const text = serializeModel(m);
    expect(text).toContain('<NATIVE>');
    expect(text).not.toContain('<LEGACY>');
    const reopened = parseModel(text).model;
    const back = reopened.ofKind('RequirementUsage')[0]!;
    expect(requirementShortId(reopened, back.id)).toBe('NATIVE');
  });

  it('still saves a legacy-only id — the fallback holds for what the factory writes', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    f.requirement('maxMass', pkg.id, { reqId: 'R1', text: 'mass shall be < 2000 kg' });
    expect(serializeModel(m)).toContain('<R1>');
  });

  it('reads what a save-and-reopen actually produces — the legacy slot, again', () => {
    // Not history: the mapper's requirement special case folds a `doc` body into
    // `attrs.text` and creates no Documentation element, so a natively built
    // requirement comes back through the fallback. A second `doc` is dropped,
    // and the statement reported is the survivor.
    const { m, req } = nativeFixture();
    m.create('Documentation', { ownerId: req.id, attrs: { body: 'a second body' } });
    const reparsed = parseModel(serializeModel(m));
    const back = reparsed.model.ofKind('RequirementUsage')[0]!;
    expect(requirementDoc(reparsed.model, back.id)).toBeUndefined();
    expect(reparsed.model.require(back.id).attrs.text).toBe('a second body');
    expect(requirementStatement(reparsed.model, back.id)).toBe('a second body');
  });

  it('accepts a Comment as the statement carrier when there is no Documentation', () => {
    const m = new Model();
    const pkg = m.create('Package', { declaredName: 'P' });
    const req = m.create('RequirementUsage', { declaredName: 'r', ownerId: pkg.id });
    m.create('Comment', { ownerId: req.id, attrs: { body: 'stated as a comment' } });
    expect(requirementStatement(m, req.id)).toBe('stated as a comment');
  });
});

describe('requirement attributes', () => {
  function fixture() {
    const m = new Model();
    const pkg = m.create('Package', { declaredName: 'P' });
    const req = m.create('RequirementUsage', {
      declaredName: 'maxMass',
      declaredShortName: 'R1',
      ownerId: pkg.id,
    });
    return { m, pkg, req };
  }

  it('round-trips values across the keys', () => {
    const { m, req } = fixture();
    setRequirementAttr(m, req.id, 'status', 'open');
    setRequirementAttr(m, req.id, 'priority', 'high');
    setRequirementAttr(m, req.id, 'risk', 'medium');
    setRequirementAttr(m, req.id, 'verificationMethod', 'test');
    setRequirementAttr(m, req.id, 'rationale', 'safety margin');

    const attrs = getRequirementAttrs(m, req.id);
    expect(attrs.status).toBe('open');
    expect(attrs.priority).toBe('high');
    expect(attrs.risk).toBe('medium');
    expect(attrs.verificationMethod).toBe('test');
    expect(attrs.rationale).toBe('safety margin');

    expect(getRequirementAttr(m, req.id, 'status')).toBe('open');
    expect(getRequirementAttr(m, req.id, 'source')).toBeUndefined();
  });

  it('stores them on one real, queryable metadata element in the graph', () => {
    const { m, req } = fixture();
    expect(getRequirementMetadata(m, req.id)).toBeUndefined();
    setRequirementAttr(m, req.id, 'status', 'closed');

    const md = getRequirementMetadata(m, req.id);
    expect(md).toBeDefined();
    expect(md!.eClass).toBe('MetadataUsage');
    expect(md!.declaredName).toBe(RM_METADATA_NAME);
    expect(md!.ownerId).toBe(req.id);
    expect(m.children(req.id).some((c) => c.id === md!.id)).toBe(true);
    expect(m.ofKind('MetadataUsage').map((e) => e.id)).toContain(md!.id);
    // The value is a child of the carrier, not a bag entry on it — that is what
    // makes it survive a save (see the round-trip test below).
    const cell = m.children(md!.id).find((c) => c.declaredName === 'status');
    expect(cell?.eClass).toBe('AttributeUsage');
  });

  it('reuses a single carrier across writes', () => {
    const { m, req } = fixture();
    setRequirementAttr(m, req.id, 'status', 'open');
    setRequirementAttr(m, req.id, 'risk', 'low');
    setRequirementAttr(m, req.id, 'status', 'done');
    expect(m.ofKind('MetadataUsage')).toHaveLength(1);
    expect(m.children(getRequirementMetadata(m, req.id)!.id)).toHaveLength(2);
    expect(getRequirementAttr(m, req.id, 'status')).toBe('done');
  });

  it('validates status against the status values and accepts every one of them', () => {
    const { m, req } = fixture();
    expect(() => setRequirementAttr(m, req.id, 'status', 'bogus')).toThrow();
    for (const v of STATUS_KIND_VALUES) {
      expect(() => setRequirementAttr(m, req.id, 'status', v)).not.toThrow();
    }
    expect(getRequirementAttr(m, req.id, 'status')).toBe(
      STATUS_KIND_VALUES[STATUS_KIND_VALUES.length - 1],
    );
  });

  it('validates the other enumerated keys', () => {
    const { m, req } = fixture();
    expect(() => setRequirementAttr(m, req.id, 'risk', 'extreme')).toThrow();
    expect(() => setRequirementAttr(m, req.id, 'verificationMethod', 'guess')).toThrow();
    expect(() => setRequirementAttr(m, req.id, 'verdict', 'maybe')).toThrow();
    for (const v of RISK_LEVEL_VALUES) {
      expect(() => setRequirementAttr(m, req.id, 'risk', v)).not.toThrow();
    }
    for (const v of VERDICT_KIND_VALUES) {
      expect(() => setRequirementAttr(m, req.id, 'verdict', v)).not.toThrow();
    }
    for (const v of VERIFICATION_METHOD_VALUES) {
      expect(() => setRequirementAttr(m, req.id, 'verificationMethod', v)).not.toThrow();
    }
  });

  it('validates priority too — the branch the paused work declared and never enforced', () => {
    const { m, req } = fixture();
    expect(() => setRequirementAttr(m, req.id, 'priority', 'urgent')).toThrow();
    for (const v of PRIORITY_VALUES) {
      expect(() => setRequirementAttr(m, req.id, 'priority', v)).not.toThrow();
    }
    expect(getRequirementAttr(m, req.id, 'priority')).toBe(
      PRIORITY_VALUES[PRIORITY_VALUES.length - 1],
    );
  });

  it('takes a free-text value on the keys that have no value list', () => {
    const { m, req } = fixture();
    for (const key of ['criticality', 'rationale', 'source', 'owner'] as const) {
      setRequirementAttr(m, req.id, key, `${key} value`);
      expect(getRequirementAttr(m, req.id, key)).toBe(`${key} value`);
    }
  });

  it('clearing removes the key rather than writing an empty string', () => {
    const { m, req } = fixture();
    setRequirementAttr(m, req.id, 'status', 'open');
    setRequirementAttr(m, req.id, 'risk', 'low');
    setRequirementAttr(m, req.id, 'status', '');
    expect(getRequirementAttr(m, req.id, 'status')).toBeUndefined();
    expect('status' in getRequirementAttrs(m, req.id)).toBe(false);
    expect(getRequirementAttr(m, req.id, 'risk')).toBe('low');
    // The carrier goes with the last key it held: an empty `metadata
    // RequirementMetadata;` line in the saved file says nothing.
    setRequirementAttr(m, req.id, 'risk', null);
    expect(getRequirementMetadata(m, req.id)).toBeUndefined();
    expect(getRequirementAttrs(m, req.id).risk).toBeUndefined();
    // Clearing what was never set is a no-op, not a throw.
    expect(() => setRequirementAttr(m, req.id, 'owner', '')).not.toThrow();
  });

  it('refuses BEFORE it writes — a rejected value leaves the model untouched', () => {
    const { m, req } = fixture();
    const sizeBefore = m.size;
    expect(() => setRequirementAttr(m, req.id, 'status', 'bogus')).toThrow();
    // No half-made carrier: this is what lets the store command drop its undo
    // snapshot instead of restoring one.
    expect(m.size).toBe(sizeBefore);
    expect(getRequirementMetadata(m, req.id)).toBeUndefined();
  });

  it('refuses a requirement whose own declaration could not be parsed', () => {
    // `blok requirement …` faults; the mapper keeps the source on the element
    // and the serializer re-emits it verbatim, subtree included. A carrier
    // written under it would read back in memory and be gone from the next
    // saved file — the same silent loss the storage shape was chosen to avoid,
    // and the refusal `setStatementKind` already makes for these elements.
    const parsed = parseModel('package P {\n    blok requirement <R1> maxMass;\n}');
    const req = parsed.model.ofKind('RequirementUsage')[0]!;
    expect(typeof req.attrs.unparsedText).toBe('string');
    const sizeBefore = parsed.model.size;
    expect(() => setRequirementAttr(parsed.model, req.id, 'status', 'open')).toThrow(
      /could not be parsed/,
    );
    expect(parsed.model.size).toBe(sizeBefore);
    expect(getRequirementMetadata(parsed.model, req.id)).toBeUndefined();
  });

  /**
   * The guard has to look UP, not only at the element. The serializer re-emits a
   * faulted declaration's original source verbatim and nothing else, its
   * subtree included — so a requirement nested inside one has no residue of its
   * own, passed the element-only test, took the facet, showed it, and lost it on
   * the next save. Depth one and deeper are both pinned.
   */
  it('refuses a requirement nested inside a declaration that could not be parsed', () => {
    const parsed = parseModel(
      'package P {\n    blok def Vehicle {\n        requirement <R1> r1;\n        part deeper {\n            requirement <R2> r2;\n        }\n    }\n    requirement <R3> outside;\n}',
    );
    const m = parsed.model;
    const byName = (n: string) => m.all().find((e) => e.declaredName === n)!;
    const r1 = byName('r1');
    const r2 = byName('r2');
    const outside = byName('outside');
    // Neither nested requirement carries residue itself — the carrier above them does.
    expect(r1.attrs.unparsedText).toBeUndefined();
    expect(r2.attrs.unparsedText).toBeUndefined();
    expect(m.ancestors(r1.id).some((a) => typeof a.attrs.unparsedText === 'string')).toBe(true);

    expect(reachesTheFile(m, r1.id)).toBe(false);
    expect(reachesTheFile(m, r2.id)).toBe(false);
    expect(reachesTheFile(m, outside.id)).toBe(true);
    expect(carriesItsOwnText(m, r1.id)).toBe(false);
    expect(carriesItsOwnText(m, r2.id)).toBe(false);
    expect(carriesItsOwnText(m, outside.id)).toBe(true);

    const sizeBefore = m.size;
    for (const nested of [r1, r2]) {
      expect(() => setRequirementAttr(m, nested.id, 'status', 'done'), nested.declaredName).toThrow(
        /could not be parsed/,
      );
    }
    expect(m.size).toBe(sizeBefore);
    // The sibling outside the residue is unaffected, and its facet reaches the file.
    setRequirementAttr(m, outside.id, 'status', 'done');
    const reopened = parseModel(serializeModel(m)).model;
    const again = reopened.all().find((e) => e.declaredName === 'outside')!;
    expect(getRequirementAttr(reopened, again.id, 'status')).toBe('done');
  });

  it('does not mistake a carrier child of another kind for a facet cell', () => {
    // A hand-written carrier may own `part status;` or a documentation named
    // `status`. Writing into one of those puts the value where the notation
    // cannot save it: it would read back in memory and be absent from the file.
    const { m, req } = fixture();
    const carrier = m.create('MetadataUsage', {
      declaredName: RM_METADATA_NAME,
      ownerId: req.id,
    });
    m.create('Documentation', {
      declaredName: 'status',
      ownerId: carrier.id,
      attrs: { body: 'a note' },
    });
    expect(getRequirementAttr(m, req.id, 'status')).toBeUndefined();

    setRequirementAttr(m, req.id, 'status', 'open');
    expect(getRequirementAttr(m, req.id, 'status')).toBe('open');
    const cells = m.children(carrier.id).filter((c) => c.declaredName === 'status');
    expect(cells.map((c) => c.eClass).sort()).toEqual(['AttributeUsage', 'Documentation']);
    // And the file says what memory says.
    expect(serializeModel(m)).toContain('attribute status = "open"');
  });

  it('reads the carrier written either way, and never an annotation', () => {
    // `@RequirementMetadata { … }` is a MetadataUsage child too, but it
    // annotates something else; reading its attributes as facets would let it
    // override the real carrier. `metadata rm : RequirementMetadata` is the
    // notation's own spelling of the same declaration, and is read as a carrier.
    const both = parseModel(`package P {
    requirement <R1> r {
        @RequirementMetadata { attribute status = "closed"; }
        metadata RequirementMetadata { attribute status = "open"; }
    }
}`);
    expect(both.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const req = both.model.ofKind('RequirementUsage')[0]!;
    expect(both.model.children(req.id).filter((c) => c.eClass === 'MetadataUsage')).toHaveLength(2);
    expect(getRequirementAttr(both.model, req.id, 'status')).toBe('open');

    const annotationOnly = parseModel(`package P {
    requirement <R2> r2 {
        @RequirementMetadata { attribute status = "closed"; }
    }
}`);
    const r2 = annotationOnly.model.ofKind('RequirementUsage')[0]!;
    expect(getRequirementMetadata(annotationOnly.model, r2.id)).toBeUndefined();
    expect(getRequirementAttrs(annotationOnly.model, r2.id)).toEqual({
      statementKind: 'requirement',
    });

    const typed = parseModel(`package P {
    requirement <R3> r3 {
        metadata rm : RequirementMetadata { attribute risk = "high"; }
    }
}`);
    const r3 = typed.model.ofKind('RequirementUsage')[0]!;
    expect(getRequirementAttr(typed.model, r3.id, 'risk')).toBe('high');
  });

  it('reports which keys are actually written, kind included', () => {
    const { m, req } = fixture();
    expect(hasRequirementAttr(m, req.id, 'status')).toBe(false);
    // `getRequirementAttr` answers a kind from the metaclass; nothing is written.
    expect(getRequirementAttr(m, req.id, 'statementKind')).toBe('requirement');
    expect(hasRequirementAttr(m, req.id, 'statementKind')).toBe(false);

    setRequirementAttr(m, req.id, 'status', 'open');
    setRequirementAttr(m, req.id, 'statementKind', 'prose');
    expect(hasRequirementAttr(m, req.id, 'status')).toBe(true);
    expect(hasRequirementAttr(m, req.id, 'statementKind')).toBe(true);

    setRequirementAttr(m, req.id, 'status', '');
    setRequirementAttr(m, req.id, 'statementKind', '');
    expect(hasRequirementAttr(m, req.id, 'status')).toBe(false);
    expect(hasRequirementAttr(m, req.id, 'statementKind')).toBe(false);
  });

  it('rejects an unknown key and a target that is not a requirement', () => {
    const { m, req, pkg } = fixture();
    // @ts-expect-error — exercising the runtime guard on an unknown key.
    expect(() => setRequirementAttr(m, req.id, 'notAnRmKey', 'x')).toThrow();
    expect(() => setRequirementAttr(m, pkg.id, 'status', 'open')).toThrow();
    expect(() => setRequirementAttr(m, 'no-such-element', 'status', 'open')).toThrow();
  });

  it('survives a save and a re-parse — every key, quotes and backslashes included', () => {
    const m = new Model();
    const pkg = m.create('Package', { declaredName: 'P' });
    const req = m.create('RequirementUsage', {
      declaredName: 'maxMass',
      declaredShortName: 'R1',
      ownerId: pkg.id,
    });
    const written: Record<string, string> = {
      status: 'open',
      verdict: 'pass',
      risk: 'high',
      priority: 'critical',
      criticality: 'DAL-B',
      rationale: 'Regulatory limit — see "Annex C", path C:\\specs',
      source: 'REG-2026/14',
      owner: 'chief engineer',
      verificationMethod: 'analyze',
    };
    for (const [key, value] of Object.entries(written)) {
      setRequirementAttr(m, req.id, key as (typeof RM_ATTR_KEYS)[number], value);
    }

    const text = serializeModel(m);
    const reparsed = parseModel(text);
    expect(reparsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const back = reparsed.model.ofKind('RequirementUsage')[0];
    expect(back).toBeDefined();
    const attrs = getRequirementAttrs(reparsed.model, back!.id);
    for (const [key, value] of Object.entries(written)) {
      expect(attrs[key as (typeof RM_ATTR_KEYS)[number]]).toBe(value);
    }
    // And a second save is byte-identical, so nothing is re-encoded each time.
    expect(serializeModel(reparsed.model)).toBe(text);
  });
});

describe('statementKind — the tenth key', () => {
  function fixture() {
    const m = new Model();
    const pkg = m.create('Package', { declaredName: 'P' });
    const req = m.create('RequirementUsage', { declaredName: 'r1', ownerId: pkg.id });
    return { m, pkg, req };
  }

  it('is one of the attribute keys', () => {
    expect(RM_ATTR_KEYS).toContain('statementKind');
    expect(RM_ATTR_KEYS).toHaveLength(10);
  });

  it('reads the kind a requirement already has, without anyone writing one', () => {
    const { m, req } = fixture();
    expect(getRequirementAttr(m, req.id, 'statementKind')).toBe('requirement');
    expect(getRequirementAttrs(m, req.id).statementKind).toBe('requirement');
    // …and it is not stored as a value on the carrier: there is no carrier.
    expect(getRequirementMetadata(m, req.id)).toBeUndefined();
  });

  it('writes through the keyword, so one place answers what kind a statement is', () => {
    const { m, req } = fixture();
    setRequirementAttr(m, req.id, 'statementKind', 'prose');
    expect(m.require(req.id).attrs.metadata).toEqual(['prose']);
    expect(statementKindOf(m, req.id)).toBe('prose');
    expect(getRequirementAttr(m, req.id, 'statementKind')).toBe('prose');
    expect(getRequirementMetadata(m, req.id)).toBeUndefined();
  });

  it('clearing the kind removes the keyword and leaves other tags alone', () => {
    const { m, req } = fixture();
    m.setAttrs(req.id, { metadata: ['Safety'] });
    setRequirementAttr(m, req.id, 'statementKind', 'prompt');
    expect(m.require(req.id).attrs.metadata).toEqual(['Safety', 'prompt']);
    setRequirementAttr(m, req.id, 'statementKind', '');
    expect(m.require(req.id).attrs.metadata).toEqual(['Safety']);
    // Back to what the metaclass says.
    expect(getRequirementAttr(m, req.id, 'statementKind')).toBe('requirement');
  });

  it('rejects a value that is not a statement kind', () => {
    const { m, req } = fixture();
    expect(() => setRequirementAttr(m, req.id, 'statementKind', 'guidance')).toThrow();
  });
});
