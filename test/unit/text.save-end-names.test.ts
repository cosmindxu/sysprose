import { describe, it, expect } from 'vitest';
import { isRelationship, type ElementRecord, type Model } from '@core/index';
import { measureTextHealth, parseModel, serializeModel } from '@text/index';
import { effectiveQualifiedName } from '@semantics/index';

/**
 * Save of a statement whose end is a lone UNNAMED redefinition (`:>> M` with no declared name of its own). The statement
 * reads its end by a name (an allocation, succession, transition, dependency, alias: `resolveFullName`), and no name
 * reaches an unnamed feature, so it was left out with a `// Not saved:` note. Save now writes the feature under the
 * name it already goes by (`state s1 :>> s1;`): the effective name does not change, the file reopens as the same model
 * (members in the same order, the statement on the same feature), and the page's own model is not touched.
 *
 * Where another member of the owner goes by the name, no text reaches the end (the name reads the first member; moving
 * members would change the order the walk and the interpreter read a state machine by), and the note stays.
 */

const real = (e: ElementRecord): boolean => e.attrs.isLibrary !== true && e.attrs.implicit !== true;
/** The model as a file reads it: members by effective path and place among the owner's members, statements by their ends' places. */
function reopen(m: Model): string {
  const place = (e: ElementRecord): string => {
    const at = e.ownerId === null ? 0 : m.children(e.ownerId).filter((c) => !isRelationship(c.eClass) && real(c)).findIndex((c) => c.id === e.id);
    return `${effectiveQualifiedName(m, e.id)}#${at}`;
  };
  const rows: string[] = [];
  for (const e of m.all()) {
    if (!real(e) || /^(FeatureTyping|Subsetting|Redefinition|Subclassification|ReferenceSubsetting|Specialization)$/.test(e.eClass)) continue;
    const ends = [...(e.source ?? []), ...(e.target ?? [])].map((id) => m.get(id));
    if (ends.some((x) => x === undefined || !real(x))) continue;
    rows.push(
      isRelationship(e.eClass) || ends.length > 0
        ? `${e.eClass}:${(e.source ?? []).map((id) => place(m.require(id))).join('|')}=>${(e.target ?? []).map((id) => place(m.require(id))).join('|')}`
        : `${e.eClass}:${place(e)}`,
    );
  }
  return rows.sort().join('\n');
}
const errors = (text: string) => parseModel(text).diagnostics.filter((d) => d.severity === 'error');
const byName = (m: Model, n: string) => m.all().find((e) => e.declaredName === n && real(e))!;

/** A feature the file reads back as the same model: saved with no note, reopened signature equal, saved again equal. */
function expectSaved(m: Model): string {
  const before = reopen(m);
  const text = serializeModel(m);
  expect(text).not.toContain('Not saved');
  expect(text).not.toContain('«');
  expect(errors(text), text).toEqual([]);
  const after = parseModel(text).model;
  expect(reopen(after), text).toBe(before);
  expect(serializeModel(after)).toBe(text);
  expect(measureTextHealth(text, () => {}).parseErrors).toBe(0);
  return text;
}
/** A feature no text reaches: the note, never a name that reads another member; the file has no such statement. */
function expectNoted(m: Model, word: string, re: RegExp): string {
  const text = serializeModel(m);
  expect(text).toMatch(new RegExp(`// Not saved: a ${word} whose end no name reaches \\(`));
  expect(text).toMatch(re);
  expect(errors(text), text).toEqual([]);
  expect(reopen(parseModel(text).model)).not.toBe(reopen(m));
  return text;
}

describe('a lone unnamed redefinition at the end of a statement is saved under the name it goes by', () => {
  const STATES = (members: string) => `package T { state def S { state s1; state s2; } state m : S { ${members} state z; transition first s2 then z; } }`;
  const retargetTransition = (m: Model, key: 'source' | 'target', pick: (kids: ElementRecord[]) => ElementRecord) => {
    const tr = m.all().find((e) => e.eClass === 'TransitionUsage' && e.attrs.implicit !== true)!;
    const kids = m.children(byName(m, 'm').id).filter((c) => /State/.test(c.eClass) && real(c));
    m.update(tr.id, { [key]: [pick(kids).id] });
  };

  for (const key of ['source', 'target'] as const) {
    it(`transition ${key}: \`state :>> s1;\` is written \`state s1 :>> s1;\` and reopens on the same state`, () => {
      const m = parseModel(STATES('state :>> s1;')).model;
      retargetTransition(m, key, (k) => k.find((c) => c.declaredName === undefined)!);
      const text = expectSaved(m);
      expect(text).toContain('state s1 :>> s1;');
      // The state machine's members keep their order, which the first-enabled tie-break reads.
      const after = parseModel(text).model;
      expect(after.children(byName(after, 'm').id).filter((c) => /State/.test(c.eClass)).map((c) => c.declaredName)).toEqual(['s1', 'z']);
      // The page's model is not touched: the redefinition is still unnamed there.
      expect(m.children(byName(m, 'm').id).some((c) => /State/.test(c.eClass) && c.declaredName === undefined)).toBe(true);
    });
  }

  it('succession: an unnamed action redefinition at either end', () => {
    for (const key of ['source', 'target'] as const) {
      const m = parseModel('package T { action def A { action a1; action b; } action m : A { action :>> a1; action z; first b then z; } }').model;
      const s = m.all().find((e) => e.eClass === 'Succession' && e.attrs.implicit !== true)!;
      const unnamed = m.children(byName(m, 'm').id).find((c) => /Action/.test(c.eClass) && c.declaredName === undefined)!;
      m.update(s.id, { [key]: [unnamed.id] });
      expect(expectSaved(m)).toContain('action a1 :>> a1;');
    }
  });

  const DEF = 'part def P { attribute load : ScalarValues::Real default = 1.0; part a { attribute load : ScalarValues::Real default = 1.0; } } ';
  const KINDS: Array<[string, string, 'source' | 'target', RegExp]> = [
    ['allocation', 'part y; allocate END to y;', 'source', /^Allocation/],
    ['allocation, the end last', 'part y; allocate y to END;', 'target', /^Allocation/],
    ['dependency', 'part y; dependency from END to y;', 'source', /^Dependency/],
    ['succession', 'part y; succession first END then y;', 'source', /^Succession/],
  ];
  for (const [kind, body, key, linkRe] of KINDS) {
    it(`${kind}: a lone unnamed redefinition, and one under an unnamed head of the path`, () => {
      for (const [members, end, depth] of [
        ['attribute :>> load = 50.0;', 'p.load', 0],
        ['part :>> a { attribute :>> load = 3.0; }', 'p.a.load', 1],
      ] as const) {
        const m = parseModel(`package T { ${DEF}part p : P { ${members} } ${body.replace('END', end)} }`).model;
        const link = m.all().find((e) => linkRe.test(e.eClass) && real(e))!;
        const p = byName(m, 'p');
        let f = m.children(p.id).find((c) => c.declaredName === undefined && !isRelationship(c.eClass))!;
        if (depth === 1) f = m.children(f.id).find((c) => c.declaredName === undefined && !isRelationship(c.eClass))!;
        m.update(link.id, { [key]: [f.id] });
        expectSaved(m);
        expect(m.get(f.id)!.declaredName).toBeUndefined();
      }
    });
  }

  it('alias: a name for a lone unnamed redefinition', () => {
    const m = parseModel(`package T { ${DEF}part p : P { attribute :>> load = 50.0; } part y; alias L for y; }`).model;
    const alias = m.all().find((e) => e.eClass === 'Membership' && e.declaredName === 'L')!;
    m.update(alias.id, { target: [m.children(byName(m, 'p').id).find((c) => c.declaredName === undefined)!.id] });
    expect(expectSaved(m)).toContain('alias L for p.load;');
  });
});

describe('where another member goes by the name, no text reaches the end: the note stays', () => {
  const STATES = (members: string) => `package T { state def S { state s1; state s2; } state m : S { ${members} state z; transition first s2 then z; } }`;
  const kids = (m: Model) => m.children(byName(m, 'm').id).filter((c) => /State/.test(c.eClass) && real(c));
  const tr = (m: Model) => m.all().find((e) => e.eClass === 'TransitionUsage' && e.attrs.implicit !== true)!;

  it('transition: the second of two unnamed redefinitions of one state', () => {
    const m = parseModel(STATES('state :>> s1; state :>> s1;')).model;
    m.update(tr(m).id, { source: [kids(m).filter((c) => c.declaredName === undefined)[1]!.id] });
    expectNoted(m, 'transition', /Name the unnamed redefinition/);
  });
  it('transition: an unnamed redefinition after a named state of its name', () => {
    const m = parseModel(STATES('state s1; state :>> s1;')).model;
    m.update(tr(m).id, { source: [kids(m).find((c) => c.declaredName === undefined)!.id] });
    expectNoted(m, 'transition', /Name the unnamed redefinition/);
  });
  it('transition: a named state after a named state of its name', () => {
    const m = parseModel(STATES('state s1; state s1;')).model;
    m.update(tr(m).id, { source: [kids(m).filter((c) => c.declaredName === 's1')[1]!.id] });
    expectNoted(m, 'transition', /Rename the earlier member of its name/);
    // The members are not reordered to reach it.
    const text = serializeModel(m);
    expect(text.slice(text.indexOf('state m')).match(/state (s1|z);/g)).toEqual(['state s1;', 'state s1;', 'state z;']);
  });
  it('succession: the same shapes', () => {
    for (const members of ['action :>> a1; action :>> a1;', 'action a1; action a1;', 'action a1; action :>> a1;']) {
      const m = parseModel(`package T { action def A { action a1; action b; } action m : A { ${members} action z; first b then z; } }`).model;
      const s = m.all().find((e) => e.eClass === 'Succession' && e.attrs.implicit !== true)!;
      const all = m.children(byName(m, 'm').id).filter((c) => /Action/.test(c.eClass) && real(c) && c.declaredName !== 'z');
      m.update(s.id, { source: [all[1]!.id] });
      expectNoted(m, 'succession', /no name reaches|Rename the earlier member|Name the unnamed redefinition/);
    }
  });
  it('allocation: a named member after a named one', () => {
    const m = parseModel('package T { part c; part c; part y; allocate y to c; }').model;
    const link = m.all().find((e) => e.eClass === 'Allocation')!;
    m.update(link.id, { target: [m.all().filter((e) => e.declaredName === 'c' && real(e))[1]!.id] });
    expectNoted(m, 'allocation', /Rename the earlier member of its name/);
  });
  it('a lone unnamed redefinition whose name another statement would read as a different member is kept out, not renamed', () => {
    // The name is the effective name, which a sibling `s1` would already share: two members of one name.
    const m = parseModel(STATES('state :>> s1; state s1;')).model;
    m.update(tr(m).id, { source: [kids(m).find((c) => c.declaredName === undefined)!.id] });
    const text = serializeModel(m);
    expect(text).not.toMatch(/state s1 :>> s1/);
    expect(errors(text), text).toEqual([]);
    expect(text).toMatch(/Not saved: a transition/);
  });
});
