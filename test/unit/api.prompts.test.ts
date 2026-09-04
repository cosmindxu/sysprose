/**
 * `promptsFor` — the guidance that applies to an element.
 *
 * The point of the `prompt` statement kind is that an agent working on one
 * element can ask what guidance governs it without knowing where anyone chose
 * to write that guidance down. These tests pin the three things that makes the
 * answer trustworthy: it reaches guidance written on a TYPE (the reuse the
 * feature exists for), it is ordered nearest-first (so a caller can stop
 * reading), and it terminates on a model whose type graph has a cycle.
 */

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { promptsFor } from '@api/index';
import { parseModel } from '@text/index';
import { setStatementKind } from '@semantics/index';

/** The one element a snippet declares, by name. */
function byName(model: Model, name: string) {
  const el = model.all().find((e) => e.declaredName === name);
  expect(el, `no element named ${name}`).toBeDefined();
  return el!;
}

/** Parse a snippet, failing loudly on any error rather than testing wreckage. */
function parsed(src: string): Model {
  const r = parseModel(src);
  expect(r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([]);
  return r.model;
}

describe('promptsFor — guidance reached through a type', () => {
  it('a prompt on a port definition reaches every port of that type', () => {
    const model = parsed(`package M {
    port def Fuel {
        #prompt part guidance {
            doc /* Check the fuel line before changing this port. */
        }
    }
    part def Engine {
        port fuelOut : Fuel;
    }
    part def Tank {
        port fuelIn : Fuel;
    }
}`);
    const fuel = byName(model, 'Fuel');
    const guidance = byName(model, 'guidance');

    for (const portName of ['fuelOut', 'fuelIn']) {
      const report = promptsFor(model, byName(model, portName).id);
      expect(report.element.declaredName).toBe(portName);
      expect(report.prompts.map((p) => p.prompt.id)).toEqual([guidance.id]);
      const [applied] = report.prompts;
      // Where it came from: the definition, one hop away, along the typing edge.
      expect(applied.attachedTo.id).toBe(fuel.id);
      expect(applied.via).toBe('type');
      expect(applied.distance).toBe(1);
      // And the guidance itself, so a caller does not have to go and fetch it.
      expect(applied.text).toBe('Check the fuel line before changing this port.');
    }
  });

  it('follows the type chain, so guidance on a base definition reaches a derived part', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const base = f.partDef('Base', pkg.id);
    const derived = f.partDef('Derived', pkg.id);
    f.subclassification(derived.id, base.id);
    const p = f.part('p', pkg.id, derived.id);
    const onBase = f.part('baseGuidance', base.id);
    setStatementKind(model, onBase.id, 'prompt');
    f.doc(onBase.id, 'Guidance written once on the base.');

    const report = promptsFor(model, p.id);
    expect(report.prompts.map((x) => x.prompt.id)).toEqual([onBase.id]);
    // Derived is one hop, Base is two: the depth is counted, not flattened.
    expect(report.prompts[0].distance).toBe(2);
    expect(report.prompts[0].attachedTo.id).toBe(base.id);
    expect(report.prompts[0].text).toBe('Guidance written once on the base.');
  });
});

describe('promptsFor — ordering and provenance', () => {
  it('is ordered nearest first, and a type is nearer than an owner', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const def = f.partDef('D', pkg.id);
    const p = f.part('p', pkg.id, def.id);

    const onPackage = f.part('packageGuidance', pkg.id);
    const onType = f.part('typeGuidance', def.id);
    const onSelf = f.part('selfGuidance', p.id);
    for (const g of [onPackage, onType, onSelf]) setStatementKind(model, g.id, 'prompt');

    const report = promptsFor(model, p.id);
    // Nearest first: what is written ON the element, then what its type says,
    // then what the package it lives in says. A type is preferred to an owner
    // at the same distance because it says what the element IS, where the
    // owner only says where it sits.
    expect(report.prompts.map((x) => x.prompt.declaredName)).toEqual([
      'selfGuidance',
      'typeGuidance',
      'packageGuidance',
    ]);
    expect(report.prompts.map((x) => x.distance)).toEqual([0, 1, 1]);
    expect(report.prompts.map((x) => x.via)).toEqual(['self', 'type', 'owner']);
    expect(report.prompts.map((x) => x.attachedTo.id)).toEqual([p.id, def.id, pkg.id]);
  });

  it('prefers a type to an owner at every distance, not only the first hop', () => {
    // Two prompts exactly two hops away by different routes: `Machine` is the
    // TYPE OF cyl's owner, `Lib` is the OWNER OF cyl's type. The rule that a
    // type outranks an owner has to be decided across the whole frontier — a
    // walk that only orders each scope's own two edges gets the first hop right
    // and then reports these in whichever order it happened to queue them.
    const model = parsed(`package Lib {
    #prompt part libGuidance { doc /* Written where the type lives. */ }
    part def Cylinder;
}
package Machines {
    import Lib::*;
    part def Machine {
        #prompt part machineGuidance { doc /* Written on a supertype. */ }
    }
    part def Engine :> Machine {
        part cyl : Cylinder;
    }
}`);
    const report = promptsFor(model, byName(model, 'cyl').id);
    expect(report.prompts.map((x) => [x.prompt.declaredName, x.via, x.distance])).toEqual([
      ['machineGuidance', 'type', 2],
      ['libGuidance', 'owner', 2],
    ]);
  });

  it('reaches the owner of a type, and says so only through attachedTo', () => {
    // The consequence of taking both edges from every scope: `p` uses a
    // definition that lives in another package, so what that package says about
    // its contents is addressed to `p` as well. Pinned because it is a
    // deliberate widening — a walk narrowed to the element's own owner chain
    // would still pass every other test in this file.
    const model = parsed(`package Root {
    package Mine {
        #prompt part myOwnGuidance { doc /* From the package p lives in. */ }
        part p : Root::Theirs::D;
    }
    package Theirs {
        #prompt part foreignGuidance { doc /* From the package p's type lives in. */ }
        part def D;
    }
}`);
    const p = byName(model, 'p');
    const report = promptsFor(model, p.id);
    expect(report.prompts.map((x) => [x.prompt.declaredName, x.via, x.distance])).toEqual([
      ['myOwnGuidance', 'owner', 1],
      ['foreignGuidance', 'owner', 2],
    ]);
    expect(report.prompts[1].attachedTo.id).toBe(byName(model, 'Theirs').id);

    // And the caveat the doc comment states: `via` does not separate the two.
    // Only containment does, which is why a caller wanting its own owner chain
    // is told to intersect `attachedTo` with the ancestors.
    const ancestors = new Set(model.ancestors(p.id).map((a) => a.id));
    expect(report.prompts.filter((x) => ancestors.has(x.attachedTo.id))).toHaveLength(1);
  });

  it('reports an element that is itself a prompt, once, at distance zero', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const g = f.part('guidance', pkg.id);
    setStatementKind(model, g.id, 'prompt');
    f.doc(g.id, 'Read me.');

    const report = promptsFor(model, g.id);
    expect(report.prompts).toHaveLength(1);
    expect(report.prompts[0].prompt.id).toBe(g.id);
    expect(report.prompts[0].via).toBe('self');
    expect(report.prompts[0].distance).toBe(0);
    // Reached again as a child of its own owner, it is not reported twice.
    const sibling = f.part('other', pkg.id);
    const fromSibling = promptsFor(model, sibling.id);
    expect(fromSibling.prompts.map((x) => x.prompt.id)).toEqual([g.id]);
  });

  it('answers for an element that is not in the model without inventing one', () => {
    const model = new Model();
    const report = promptsFor(model, 'no-such-id');
    expect(report.prompts).toEqual([]);
    expect(report.element.id).toBe('no-such-id');
    expect(report.element.eClass).toBe('«unknown»');
  });

  it('reports nothing rather than a default when no guidance applies', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const p = f.part('p', pkg.id);
    // A prose statement and a requirement are statements too, and neither is
    // guidance for an agent: only `prompt` is collected.
    const prose = f.part('explanation', pkg.id);
    setStatementKind(model, prose.id, 'prose');
    f.requirement('r1', pkg.id, { text: 'shall be light' });
    expect(promptsFor(model, p.id).prompts).toEqual([]);
  });
});

describe('promptsFor — the rules the impact closure follows', () => {
  it('terminates on a cycle in the type graph', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const a = f.partDef('A', pkg.id);
    const b = f.partDef('B', pkg.id);
    // A specialises B and B specialises A: illegal as a model, and a graph the
    // walk must survive rather than a shape it may assume away.
    f.subclassification(a.id, b.id);
    f.subclassification(b.id, a.id);
    const onB = f.part('bGuidance', b.id);
    setStatementKind(model, onB.id, 'prompt');
    const p = f.part('p', pkg.id, a.id);

    const report = promptsFor(model, p.id);
    expect(report.prompts.map((x) => x.prompt.id)).toEqual([onB.id]);
    expect(report.prompts[0].distance).toBe(2);
  });

  it('drops the bundled library from the walk and counts what it dropped', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const libPkg = model.create('Package', {
      declaredName: 'LibPkg',
      ownerId: null,
      attrs: { isLibrary: true },
    });
    const libDef = model.create('PartDefinition', {
      declaredName: 'LibType',
      ownerId: libPkg.id,
      attrs: { isLibrary: true },
    });
    const libPrompt = model.create('PartUsage', {
      declaredName: 'libGuidance',
      ownerId: libDef.id,
      attrs: { isLibrary: true, metadata: ['prompt'] },
    });
    expect(libPrompt.attrs.metadata).toEqual(['prompt']);
    const p = f.part('p', pkg.id, libDef.id);

    const report = promptsFor(model, p.id);
    // Walking into the library does not come back: it is dropped at the hop,
    // and the drop is reported rather than hidden.
    expect(report.prompts).toEqual([]);
    expect(report.libraryExcluded).toBe(1);
  });

  it('walks through the tool’s own implicit copies instead of stopping at them', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const portDef = f.portDef('Fuel', pkg.id);
    const onPortDef = f.part('portGuidance', portDef.id);
    setStatementKind(model, onPortDef.id, 'prompt');
    const declared = f.port('fuelOut', pkg.id, { typeId: portDef.id });
    // What `connect a.p to b.q` materialises: a usage-scoped copy tied to the
    // declaration with a Redefinition.
    const copy = model.create('PortUsage', {
      declaredName: 'fuelOut',
      ownerId: pkg.id,
      attrs: { implicit: true },
    });
    f.redefinition(copy.id, declared.id);

    // Asked about the copy itself, the walk crosses it to the declaration and
    // on to the definition rather than stopping at a dead end. The element
    // asked about is never an exclusion, so nothing is counted here.
    const report = promptsFor(model, copy.id);
    expect(report.prompts.map((x) => x.prompt.id)).toEqual([onPortDef.id]);
    expect(report.prompts[0].distance).toBe(2);
    expect(report.implicitExcluded).toBe(0);

    // Met in the middle of a walk, the copy is a conduit: it costs the hop it
    // takes, is counted, and never appears as somewhere guidance came from.
    const inner = model.create('AttributeUsage', { declaredName: 'inner', ownerId: copy.id });
    const deeper = promptsFor(model, inner.id);
    expect(deeper.prompts.map((x) => x.prompt.id)).toEqual([onPortDef.id]);
    expect(deeper.prompts[0].distance).toBe(3);
    expect(deeper.prompts[0].attachedTo.id).toBe(portDef.id);
    expect(deeper.implicitExcluded).toBe(1);
  });

  it('never reports an implicit or library element as a prompt', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const p = f.part('p', pkg.id);
    model.create('PartUsage', {
      declaredName: 'implicitGuidance',
      ownerId: pkg.id,
      attrs: { implicit: true, metadata: ['prompt'] },
    });
    model.create('PartUsage', {
      declaredName: 'libraryGuidance',
      ownerId: pkg.id,
      attrs: { isLibrary: true, metadata: ['prompt'] },
    });
    expect(promptsFor(model, p.id).prompts).toEqual([]);
  });
});

describe('promptsFor — the guidance text', () => {
  it('reads the first documentation or comment child, and falls back to the element', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');

    const withDoc = f.part('withDoc', pkg.id);
    setStatementKind(model, withDoc.id, 'prompt');
    f.doc(withDoc.id, 'From a documentation child.');

    const withComment = f.part('withComment', pkg.id);
    setStatementKind(model, withComment.id, 'prompt');
    model.create('Comment', { ownerId: withComment.id, attrs: { body: 'From a comment child.' } });

    // A requirement folds its `doc` body into its own `text` attribute rather
    // than making a child, so the fallback is not hypothetical.
    const asRequirement = f.requirement('asRequirement', pkg.id, { text: 'From attrs.text.' });
    setStatementKind(model, asRequirement.id, 'prompt');

    const silent = f.part('silent', pkg.id);
    setStatementKind(model, silent.id, 'prompt');

    // Not authorable — no parsed text puts a `body` on anything but a Comment
    // or a TextualRepresentation, and neither can carry `#prompt` — but a model
    // built through the API can, so the last fallback is exercised rather than
    // assumed.
    const built = model.create('PartUsage', {
      declaredName: 'built',
      ownerId: pkg.id,
      attrs: { metadata: ['prompt'], body: 'From attrs.body.' },
    });
    expect(built.attrs.body).toBe('From attrs.body.');

    const texts = promptsFor(model, pkg.id).prompts.map((x) => [x.prompt.declaredName, x.text]);
    expect(texts).toEqual([
      ['withDoc', 'From a documentation child.'],
      ['withComment', 'From a comment child.'],
      ['asRequirement', 'From attrs.text.'],
      ['silent', ''],
      ['built', 'From attrs.body.'],
    ]);
  });

  it('never reads a comment written about a different element as the guidance', () => {
    // `comment about Engine` inside a prompt is documentation for Engine that
    // happens to be stored there; handing it to an agent as the instruction
    // addressed to IT is the failure this text field exists to prevent. The
    // previous commit is what makes the target visible: before it, `about` was
    // dropped on the way in and this was unknowable.
    const model = parsed(`package P {
    part def Engine;
    #prompt part guidance {
        comment about Engine /* Engine is the third revision. */
        doc /* Re-run the mass rollup after touching this. */
    }
    part x;
}`);
    const [applied] = promptsFor(model, byName(model, 'x').id).prompts;
    expect(applied.prompt.declaredName).toBe('guidance');
    expect(applied.text).toBe('Re-run the mass rollup after touching this.');

    // A comment that names its own owner is still that owner's words.
    const own = parsed(`package Q {
    #prompt part guidance {
        comment about guidance /* Aimed at itself, redundantly. */
    }
    part y;
}`);
    expect(promptsFor(own, byName(own, 'y').id).prompts[0].text).toBe(
      'Aimed at itself, redundantly.',
    );
  });
});
