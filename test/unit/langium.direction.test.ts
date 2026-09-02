/**
 * The post-keyword direction slot (`port in a : Pt;`).
 *
 * Before it existed, that spelling parsed as TWO members — a bare `port` (a
 * complete member, since name and terminator are optional) and `in a : Pt` —
 * producing a nameless phantom PortUsage per directed port with no diagnostic.
 * The tool's own hint recommended the spelling. These tests pin the fix and,
 * separately, that the new alternative introduced no ALL(*) ambiguity: Langium
 * logs "Ambiguous Alternatives Detected" to console at PARSE time and nothing
 * else captures it.
 */
import { describe, it, expect } from 'vitest';
import { parseModel } from '@text/index';

function ports(src: string): string[] {
  return parseModel(src)
    .model.all()
    .filter((e) => e.eClass === 'PortUsage')
    .map((e) => `${e.declaredName ?? '«anon»'}:${String(e.attrs.direction ?? '-')}`);
}

describe('direction after the usage keyword', () => {
  it('parses `port in a : Pt;` as exactly one directed port — no phantom', () => {
    expect(ports('package P { port def Pt; part def X { port in a : Pt; port in b : Pt; } }')).toEqual([
      'a:in',
      'b:in',
    ]);
  });

  it('keeps the canonical `in port a : Pt;` identical', () => {
    expect(ports('package P { port def Pt; part def X { in port a : Pt; } }')).toEqual(['a:in']);
  });

  it('still lets a keyword be followed by a name that is a prefix word', () => {
    const acts = parseModel('package P { action def A { action end; } }')
      .model.all()
      .filter((e) => e.eClass === 'ActionUsage')
      .map((e) => e.declaredName);
    expect(acts).toEqual(['end']);
  });

  it('reports conflicting directions instead of silently keeping the first', () => {
    const p = parseModel('package P { port def Pt; part def X { in port out x : Pt; } }');
    expect(p.diagnostics.map((d) => d.code)).toContain('parse/conflicting-direction');
    expect(ports('package P { port def Pt; part def X { in port out x : Pt; } }')).toEqual(['x:in']);
  });

  it('introduces no ALL(*) ambiguity at the decision point', () => {
    const logged: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      logged.push(a.map(String).join(' '));
    };
    try {
      for (const src of [
        'package P { port def Pt; part def X { port in a : Pt; } }',
        'package P { port def Pt; part def X { in port a : Pt; } }',
        'package P { port def Pt; part def X { port a : Pt; } }',
        'package P { part def X { ref out y : Real; } }',
      ]) {
        parseModel(src);
      }
    } finally {
      console.log = orig;
    }
    expect(logged.filter((l) => /Ambiguous Alternatives/i.test(l))).toEqual([]);
  });
});
