import { describe, it, expect } from 'vitest';
import { lex } from '@text/index';

describe('lexer', () => {
  it('tokenizes identifiers, numbers and punctuation', () => {
    const toks = lex('part vehicle : Vehicle [1] ;').filter((t) => t.kind !== 'eof');
    expect(toks.map((t) => t.value)).toEqual(['part', 'vehicle', ':', 'Vehicle', '[', '1', ']', ';']);
  });

  it('greedily matches the longest specialization operators', () => {
    const ops = lex(': :> :>> ::> :: := ->')
      .filter((t) => t.kind === 'op')
      .map((t) => t.value);
    expect(ops).toEqual([':', ':>', ':>>', '::>', '::', ':=', '->']);
  });

  it('lexes decimals but treats range `..` separately', () => {
    const toks = lex('1.5 1..5').filter((t) => t.kind !== 'eof');
    expect(toks.map((t) => `${t.kind}:${t.value}`)).toEqual([
      'number:1.5',
      'number:1',
      'op:..',
      'number:5',
    ]);
  });

  it('emits block comments as tokens and skips line comments', () => {
    const toks = lex('a // line\n /* block */ b');
    const kinds = toks.filter((t) => t.kind !== 'eof').map((t) => `${t.kind}:${t.value}`);
    expect(kinds).toEqual(['ident:a', 'comment:block', 'ident:b']);
  });

  it('handles strings and single-quoted unrestricted names', () => {
    const toks = lex(`"hi there" 'a b'`).filter((t) => t.kind !== 'eof');
    expect(toks[0]).toMatchObject({ kind: 'string', value: 'hi there' });
    expect(toks[1]).toMatchObject({ kind: 'ident', value: 'a b', unrestricted: true });
  });

  it('tracks 1-based line and column', () => {
    const toks = lex('a\n  b');
    expect(toks[0]).toMatchObject({ line: 1, column: 1 });
    expect(toks[1]).toMatchObject({ line: 2, column: 3 });
  });
});
