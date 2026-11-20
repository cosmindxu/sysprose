/**
 * SysML v2 §7.18.2: `entry X;` / `do X;` / `exit X;` (no `action` keyword, no typing, no body) is a REFERENCE to an
 * existing action X. With no such action visible it keeps the declaration reading, with a warning that says so.
 * `entry action X;` / `entry action X { … }` always declare.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { serializeElement } from '@text/serializer';

const load = async (text: string): Promise<any> => loadModelText(text, { fileName: 'er.sysml' });
const codes = (r: any) => r.diagnostics.map((d: any) => d.code);
const behaviours = (model: any, phase: string) =>
  model.all().filter((e: any) => e.attrs.stateSubaction === phase);
const wrap = (body: string, pre = 'action def Warm; action a;\n') =>
  `package P {\n${pre}  state def M {\n${body}\n  }\n}\n`;

describe('a bare `entry X;` names an existing action', () => {
  it('reads as a reference: nameless, subsetting the action, no duplicate-name finding', async () => {
    const { model, report } = await load(wrap('    entry a;\n    do a;\n    exit a;\n    state s;'));
    expect(report.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
    expect(codes(report)).not.toContain('mapper/state-ref-unresolved');
    const a = model.all().find((e: any) => model.qualifiedName(e.id) === 'P::a');
    for (const phase of ['entry', 'do', 'exit']) {
      const [b] = behaviours(model, phase);
      expect(b.declaredName).toBeUndefined();
      expect(b.attrs.stateSubactionRef).toBe(true);
      const rel = model.children(b.id).find((c: any) => c.eClass === 'Subsetting');
      expect(rel.target).toEqual([a.id]);
    }
  });
  it('an action definition is a valid referent', async () => {
    const { model, report } = await load(wrap('    entry Warm;\n    state s;'));
    expect(codes(report)).not.toContain('mapper/state-ref-unresolved');
    expect(behaviours(model, 'entry')[0].attrs.stateSubactionRef).toBe(true);
  });
  it('round-trips as `entry P::a;`, still a reference', async () => {
    const { model } = await load(wrap('    entry a;\n    state s;'));
    const out = serializeElement(model, model.all().find((e: any) => e.eClass === 'Package').id);
    expect(out).toContain('entry P::a;');
    expect(out).not.toContain('entry action');
    const again = await load(out);
    expect(behaviours(again.model, 'entry')[0].attrs.stateSubactionRef).toBe(true);
    expect(codes(again.report)).not.toContain('mapper/state-ref-unresolved');
  });
  it('`entry a; then s;` still reads the succession from the entry', async () => {
    const { model, report } = await load(wrap('    entry a;\n    then s;\n    state s;'));
    expect(report.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
    expect(model.all().some((e: any) => e.eClass === 'Succession' && e.attrs.entryTransition)).toBe(true);
  });
});

describe('a name that is no visible action keeps the declaration reading, loudly', () => {
  it('warns `mapper/state-ref-unresolved` and declares the action', async () => {
    const { model, report } = await load(wrap('    entry init;\n    state s;', ''));
    const w = report.diagnostics.find((d: any) => d.code === 'mapper/state-ref-unresolved');
    expect(w?.severity).toBe('warning');
    const [b] = behaviours(model, 'entry');
    expect(b.declaredName).toBe('init');
    expect(b.attrs.stateSubactionRef).toBeUndefined();
  });
  it('a name that is not an action (a part) is not a reference either', async () => {
    const { model, report } = await load(wrap('    entry p;\n    state s;', 'part p;\n'));
    expect(codes(report)).toContain('mapper/state-ref-unresolved');
    expect(behaviours(model, 'entry')[0].declaredName).toBe('p');
  });
  it('one bare behaviour is not the referent of another of the same name', async () => {
    const { report } = await load(wrap('    entry x;\n    exit x;\n    state s;', ''));
    expect(codes(report).filter((c: string) => c === 'mapper/state-ref-unresolved')).toHaveLength(2);
  });
  it('writes back as `entry action init;`, which reloads with no warning', async () => {
    const { model } = await load(wrap('    entry init;\n    state s;', ''));
    const out = serializeElement(model, model.all().find((e: any) => e.eClass === 'Package').id);
    expect(out).toContain('entry action init;');
    expect(codes((await load(out)).report)).not.toContain('mapper/state-ref-unresolved');
  });
});

describe('a qualified name is only ever a reference', () => {
  it('`entry P::a;` resolves like `entry a;`', async () => {
    const { model, report } = await load(wrap('    entry P::a;\n    state s;'));
    expect(report.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
    expect(behaviours(model, 'entry')[0].attrs.stateSubactionRef).toBe(true);
  });
  it('one that names no action is refused, not declared', async () => {
    const { model, report } = await load(wrap('    entry P::nope;\n    state s;'));
    expect(codes(report)).toContain('mapper/state-form-unread');
    expect(behaviours(model, 'entry')).toEqual([]);
  });
});

describe('the declaring spellings declare, even when the name exists', () => {
  it.each([
    ['entry action a;'],
    ['entry action a { }'],
    ['entry a : Warm;'],
    ['entry a { }'],
  ])('`%s`', async (line) => {
    const { model, report } = await load(wrap(`    ${line}\n    state s;`));
    expect(codes(report)).not.toContain('mapper/state-ref-unresolved');
    const [b] = behaviours(model, 'entry');
    expect(b.declaredName).toBe('a');
    expect(b.attrs.stateSubactionRef).toBeUndefined();
  });
});

describe('triggers and guards after a name still parse', () => {
  it('`accept E if n < 0 then s` and `accept after 5[min] then s` in transitions', async () => {
    const { report } = await load(
      wrap('    state s;\n    state t;\n    transition t1 first s accept E if 1 < 0 then t;\n    transition t2 first s accept after 5[min] then t;'),
    );
    expect(report.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
  });
});
