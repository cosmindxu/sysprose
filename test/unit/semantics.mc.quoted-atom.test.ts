/** A check-behaviour atom naming a state by a quoted name reads the state it quotes (TODO "Abstentions left in quoted names in expressions" (c)). */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { readAtom } from '../../src/semantics/mc/atoms';

const src = `package P { state def M { entry; then 'deg A'; state 'deg A'; state ok; transition t first 'deg A' accept e then ok; } }`;

describe('a quoted state name in a property atom', () => {
  it("reads `state 'deg A'` as the state `deg A`, as `state deg A` does", async () => {
    const { model } = await loadModelText(src, { fileName: 'q.sysml' });
    const m = model!.all().find((e) => model!.qualifiedName(e.id) === 'P::M')!;
    const quoted: any = readAtom(model!, m.id, "state 'deg A'");
    const bare: any = readAtom(model!, m.id, 'state deg A');
    const qualified: any = readAtom(model!, m.id, "state P::M::'deg A'");
    expect(quoted.ok).toBe(true);
    expect(bare.ok).toBe(true);
    expect(qualified.ok).toBe(true);
    expect(quoted.atom.elementId).toBe(bare.atom.elementId);
    expect(qualified.atom.elementId).toBe(bare.atom.elementId);
    expect((readAtom(model!, m.id, "state 'nope'") as any).ok).toBe(false);
  });
});
