/**
 * Requirement-clause bodies survive the round trip, and the writer emits a
 * DECLARATION.
 *
 * Two defects met here, and neither could be proved fixed without the other.
 *
 * D1 — `mapRequirementClause` read `kind`, `name`, `specializations` and (for
 * `require`/`assume`/`assert`) `expr`, and nothing else. Every other clause kind
 * carries its content in a `Body` (`sysml.langium`:279-287), so
 * an objective holding a doc note, an `assume constraint` and a
 * `require constraint` mapped to one `ConstraintUsage` with zero children and
 * serialised as `objective;`. The deletion was IDEMPOTENT — the second save produced the same
 * text as the first — so nothing downstream could notice that the standard's own
 * home for a behaviour's precondition and postcondition had been thrown away.
 *
 * D2 — `requirementClauseLine` dropped the `constraint` keyword, writing
 * `require bound { … }`. Under the published grammar that first alternative is
 * an owned reference subsetting: it names an EXISTING constraint rather than
 * declaring one, and `require { … }` with neither `constraint` nor a `#keyword`
 * matches no alternative at all. Sysprose re-read its own output only because
 * its own grammar makes the keyword optional.
 *
 * The nested `verify R;` is the one deliberate deviation from the grammar's
 * declared clause shape: the grammar reads `R` as the declared NAME of a new
 * clause (line 282), and this mapper reads it as a REFERENCE to the requirement
 * being verified, because that is what the notation means to a reader and what
 * the requirement-traceability surfaces need. The serializer honours the same
 * reading, so it round-trips.
 */
import { describe, it, expect } from 'vitest';
import { parseModel, serializeModel, UnwritableRequirementRefError } from '@text/index';
import { Model, ModelFactory, type ElementRecord } from '@core/index';

/** parse → serialize → parse, asserting a clean parse each way. */
function reparse(src: string): { text: string; model: Model; first: Model } {
  const first = parseModel(src);
  expect(first.diagnostics.filter((d) => d.severity === 'error'), src).toEqual([]);
  const text = serializeModel(first.model);
  const again = parseModel(text);
  expect(again.diagnostics.filter((d) => d.severity === 'error'), text).toEqual([]);
  // Idempotence: a second save is the same bytes as the first, so the assertions
  // below describe a fixed point rather than a way-station.
  expect(serializeModel(again.model), text).toBe(text);
  return { text, model: again.model, first: first.model };
}

const role = (m: Model, r: string): ElementRecord[] =>
  m.all().filter((e) => e.attrs.requirementRole === r);

describe('clause bodies survive parse → serialize → parse', () => {
  it('an objective keeps its doc, its assumption and its guarantee', () => {
    const { text, model } = reparse(`
      package P {
        requirement def R {
          objective {
            doc /* the objective */
            assume constraint { armed == true }
            require constraint { altitude > 0.0 }
          }
        }
      }
    `);
    // The measured behaviour before this commit was the single line `objective;`.
    expect(text).not.toContain('objective;');
    expect(text).toContain('doc /* the objective */');

    const objective = role(model, 'objective');
    expect(objective).toHaveLength(1);
    const children = model.children(objective[0].id);
    expect(children.filter((c) => c.eClass === 'Documentation').map((c) => c.attrs.body)).toEqual([
      'the objective',
    ]);
    expect(role(model, 'assume').map((e) => e.attrs.expression)).toEqual(['armed == true']);
    expect(role(model, 'require').map((e) => e.attrs.expression)).toEqual(['altitude > 0.0']);
    // Both nested clauses are owned by the objective, not re-homed to the
    // requirement — the containment is what makes them a contract ON it.
    for (const nested of [...role(model, 'assume'), ...role(model, 'require')]) {
      expect(nested.ownerId).toBe(objective[0].id);
    }
  });

  it('a named require clause keeps BOTH its doc and its `constraint` keyword', () => {
    const { text, model } = reparse(`
      package P {
        requirement r {
          require constraint bound {
            doc /* the bound */
            x < 10.0
          }
        }
      }
    `);
    expect(text).toContain('require constraint bound {');
    expect(text).toContain('doc /* the bound */');

    const bound = role(model, 'require');
    expect(bound).toHaveLength(1);
    expect(bound[0].declaredName).toBe('bound');
    expect(bound[0].attrs.expression).toBe('x < 10.0');
    expect(model.children(bound[0].id).map((c) => c.attrs.body)).toEqual(['the bound']);
  });

  it('the writer emits `constraint` for every declaring clause kind', () => {
    const { text } = reparse(`
      package P {
        requirement r {
          assume constraint { a > 0.0 }
          require constraint { b > 0.0 }
          assert constraint { c > 0.0 }
        }
      }
    `);
    expect(text).toContain('assume constraint {');
    expect(text).toContain('require constraint {');
    expect(text).toContain('assert constraint {');
  });

  it.each(['actor', 'stakeholder', 'frame'])('a %s body survives', (kind) => {
    const { text, model } = reparse(`
      package P {
        requirement r {
          ${kind} who {
            doc /* who cares */
          }
        }
      }
    `);
    expect(text).toContain(`${kind} who {`);
    const clause = role(model, kind);
    expect(clause).toHaveLength(1);
    expect(model.children(clause[0].id).map((c) => c.attrs.body)).toEqual(['who cares']);
  });

  it('a body-carrying clause keeps the trailing expression of its body', () => {
    // The `require`/`assume`/`assert` alternative holds its trailing expression
    // on the clause; every other kind holds it one level down, inside the
    // `Body`. Reading only the first is how `objective { … }` came back empty.
    const { text, model } = reparse(`
      package P {
        case def C {
          objective { verdict == true }
        }
      }
    `);
    expect(text).toContain('verdict == true');
    expect(role(model, 'objective')[0].attrs.expression).toBe('verdict == true');
  });

  it('a subject clause keeps its value and its multiplicity', () => {
    const { text, model } = reparse(`
      package P {
        requirement r {
          subject s : Real [1] = 5;
        }
      }
    `);
    expect(text).toContain('subject s : Real [1] = 5;');
    const subject = role(model, 'subject');
    expect(subject).toHaveLength(1);
    expect(subject[0].attrs.value).toBe(5);
    expect(subject[0].attrs.multiplicity).toBe('1');
  });
});

describe('a nested `verify R;` is a Verify edge, not a new clause', () => {
  it('yields a Verify owned by the objective and re-emits inside its body', () => {
    const { text, model } = reparse(`
      package P {
        requirement R;
        case def C {
          objective {
            verify R;
          }
        }
      }
    `);
    expect(text).toContain('verify R;');

    const objective = role(model, 'objective');
    expect(objective).toHaveLength(1);
    const verifies = model.all().filter((e) => e.eClass === 'Verify');
    expect(verifies).toHaveLength(1);
    expect(verifies[0].ownerId).toBe(objective[0].id);
    // The requirement is the TARGET endpoint, uniform with `verify R by X;`.
    const requirement = model.all().find((e) => e.declaredName === 'R');
    expect((verifies[0].target ?? [])[0]).toBe(requirement!.id);
    expect(verifies[0].source ?? []).toHaveLength(0);
    // No clause element is left behind carrying the requirement's name.
    expect(role(model, 'verify')).toEqual([]);
  });

  it('a `verify` clause that declares more than a name stays a clause', () => {
    // `verify` with a body is not the reference form: reading `V` as a
    // requirement reference would throw the body away, which is the defect this
    // file exists to close.
    const { text, model } = reparse(`
      package P {
        case def C {
          objective {
            verify V {
              doc /* still a clause */
            }
          }
        }
      }
    `);
    expect(text).toContain('verify V {');
    expect(model.all().filter((e) => e.eClass === 'Verify')).toHaveLength(0);
    const clause = role(model, 'verify');
    expect(clause).toHaveLength(1);
    expect(model.children(clause[0].id).map((c) => c.attrs.body)).toEqual(['still a clause']);
  });
});

/** parse → serialize, asserting the writer reproduces the input byte for byte. */
function unchanged(src: string): void {
  const first = parseModel(src);
  expect(first.diagnostics.filter((d) => d.severity === 'error'), src).toEqual([]);
  expect(serializeModel(first.model)).toBe(src);
}

describe('the `constraint` keyword records which alternative the author wrote', () => {
  /**
   * The published grammar gives `RequirementConstraintUsage` two alternatives:
   * `require sat;` is an `OwnedReferenceSubsetting` NAMING an existing
   * constraint, `require constraint sat;` DECLARES a new one. Both build the
   * same element, so the first form of this fix — pushing `constraint` onto
   * every `require`/`assume`/`assert` — silently rewrote every reference into a
   * declaration, on the OMG's own published models included.
   */
  it.each(['require', 'assume', 'assert'])(
    'a `%s sat;` REFERENCE is not rewritten into a declaration',
    (kind) => {
      unchanged(
        `package P {\n` +
          `    constraint sat {\n        1 <= 2\n    }\n` +
          `    requirement R {\n        ${kind} sat;\n    }\n}`,
      );
    },
  );

  it('a reference form that carries a body keeps its shape too', () => {
    unchanged(
      'package P {\n' +
        '    constraint sat {\n        1 <= 2\n    }\n' +
        '    requirement R {\n        require sat {\n            1 <= 2\n        }\n    }\n}',
    );
  });

  it('a `require constraint sat;` DECLARATION keeps its keyword', () => {
    unchanged('package P {\n    requirement R {\n        require constraint sat;\n    }\n}');
  });

  it('an anonymous clause is written as a declaration whatever the source said', () => {
    // `require { … }` carries neither `constraint` nor a `#keyword`, so it
    // matches NO published alternative: the reference alternative has no name to
    // subset. This is the half of D2 that is a writer defect.
    const { text } = reparse('package P { requirement R { require { x > 0.0 } } }');
    expect(text).toContain('require constraint {');
  });

  it('the `requirement` spelling of the keyword survives as written', () => {
    unchanged('package P {\n    requirement R {\n        require requirement other;\n    }\n}');
  });
});

describe('a requirement clause keeps its visibility', () => {
  it.each(['public', 'private', 'protected'])('%s on a clause survives', (vis) => {
    const { text } = reparse(`package P { requirement r { ${vis} objective { doc /* d */ } } }`);
    expect(text).toContain(`${vis} objective {`);
  });

  it('the standard library\u2019s own `private assert constraint` survives', () => {
    unchanged(
      'package P {\n    requirement R {\n        private assert constraint c {\n' +
        '            1 <= 2\n        }\n    }\n}',
    );
  });
});

describe('the bare `verify` reference is written into a slot that holds ONE name', () => {
  /**
   * The clause slot is `name=Name` (`sysml.langium`:282). Unquoting the author's
   * lexeme wrote `verify 'A::B';` back as `verify A::B;`, which re-parsed as TWO
   * statements naming two different elements — and for a name that happens to be
   * a keyword (`verify 'end';` \u2192 `verify end;`) the re-parse was CLEAN, which is
   * the laundering the L6 ratchet exists to catch.
   */
  it.each(["'A::B'", "'has space'", "'end'"])(
    'an unresolved quoted target %s round-trips byte for byte',
    (name) => {
      unchanged(
        `package P {\n    case def C {\n        objective {\n            verify ${name};\n` +
          '        }\n    }\n}',
      );
    },
  );

  it('a resolved quoted target round-trips byte for byte', () => {
    unchanged(
      "package P {\n    requirement 'has space';\n    case def C {\n        objective {\n" +
        "            verify 'has space';\n        }\n    }\n}",
    );
  });

  it('refuses to write a target that is not one name', () => {
    // Unreachable from parsed text — the mapper keeps the author's lexeme — so
    // this is an assertion, the sibling of `UnwritableNoteBodyError`: no file
    // beats a file that parses cleanly and means something else.
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    m.create('Verify', { ownerId: pkg.id, source: [], target: [], attrs: { targetRef: 'A::B' } });
    expect(() => serializeModel(m)).toThrow(UnwritableRequirementRefError);
  });
});

describe('the bare `verify` reference binds only to a requirement', () => {
  /**
   * `verify Deep::far;` does not parse — the clause slot holds one name — and
   * what error recovery leaves behind is `verify Deep;` plus a stray `far;`.
   * Read as a reference, that bound a traceability edge from the case to the
   * PACKAGE `Deep`: an assertion the file never made, written back out as a
   * stable fixed point. Only a requirement can be verified, so anything else
   * keeps the grammar's own clause reading.
   */
  it('a target that is not a requirement stays a clause', () => {
    const { text, model } = reparse('package P { part def X; case def C { objective { verify X; } } }');
    expect(text).toContain('verify X;');
    expect(model.all().filter((e) => e.eClass === 'Verify')).toEqual([]);
    const clause = role(model, 'verify');
    expect(clause).toHaveLength(1);
    expect(clause[0].declaredName).toBe('X');
  });

  it('binds no traceability edge to the package left behind by a faulted qualified target', () => {
    const src =
      'package P { package Deep { requirement <R1> far; }' +
      ' verification def VC { objective { verify Deep::far; } } }';
    const first = parseModel(src);
    // The input does NOT parse: the clause slot holds one `Name`.
    expect(first.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(first.model.all().filter((e) => e.eClass === 'Verify')).toEqual([]);
    // And the save is a fixed point that still invents nothing.
    const saved = serializeModel(first.model);
    const again = parseModel(saved);
    expect(again.model.all().filter((e) => e.eClass === 'Verify')).toEqual([]);
    expect(serializeModel(again.model)).toBe(saved);
  });

  it('an UNRESOLVED target is left alone, with its warning', () => {
    const { diagnostics, model } = parseModel(
      'package P { case def C { objective { verify Nope; } } }',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(['ref/unresolved-requirement']);
    const verifies = model.all().filter((e) => e.eClass === 'Verify');
    expect(verifies).toHaveLength(1);
    expect(verifies[0].attrs.targetRef).toBe('Nope');
  });
});
