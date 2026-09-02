/**
 * Hand-written tokenizer for the SysML v2 textual-notation subset.
 *
 * The lexer is intentionally small and allocation-light: it scans the source
 * once, tracking 1-based `line`/`column` for diagnostics, and emits a flat
 * {@link Token} stream terminated by a single `eof` token. Block comments are
 * emitted as `comment` tokens (the parser consumes them only after the `doc`
 * keyword and otherwise skips them); line comments (`//`) are discarded.
 *
 * Tokens carry their source `start`/`end` offsets so the parser can recover the
 * verbatim source slice for free-form fragments (expression bodies, guards,
 * feature values) without re-implementing an expression grammar.
 */

export type TokenKind =
  | 'ident' // identifier or unrestricted '…' name
  | 'number'
  | 'string'
  | 'comment' // block comment /* … */ (inner text in `value`)
  | 'op' // punctuation / operator (the operator text in `value`)
  | 'eof';

export interface Token {
  kind: TokenKind;
  /** For ident/number/op: the lexeme. For string/comment: the decoded inner text. */
  value: string;
  /** Source offset of the first character (inclusive). */
  start: number;
  /** Source offset just past the last character (exclusive). */
  end: number;
  /** 1-based line of `start`. */
  line: number;
  /** 1-based column of `start`. */
  column: number;
  /** True when an ident came from a single-quoted unrestricted name. */
  unrestricted?: boolean;
}

/** Multi/!single-character operators, longest first for greedy matching. */
const OPERATORS = [
  '::>',
  ':>>',
  '::',
  ':>',
  ':=',
  '->',
  '..',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  ':',
  '=',
  ';',
  ',',
  '.',
  '<',
  '>',
  '*',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  '~',
  '@',
  '#',
  '+',
  '-',
  '/',
  '?',
  '|',
  '&',
  '%',
];

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);

/** Tokenize `src` into a `Token[]` ending with an `eof` token. */
export function lex(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = src.length;

  const advance = (count = 1): void => {
    for (let k = 0; k < count; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < n) {
    const c = src[i];

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      advance();
      continue;
    }

    // Line comment
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') advance();
      continue;
    }

    // Block comment → emitted as a `comment` token (inner text).
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      const sLine = line;
      const sCol = col;
      advance(2);
      let inner = '';
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        inner += src[i];
        advance();
      }
      if (i < n) advance(2); // consume closing */
      toks.push({ kind: 'comment', value: inner.trim(), start, end: i, line: sLine, column: sCol });
      continue;
    }

    // Double-quoted string
    if (c === '"') {
      const start = i;
      const sLine = line;
      const sCol = col;
      advance();
      let val = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          advance();
          val += src[i];
          advance();
        } else {
          val += src[i];
          advance();
        }
      }
      if (i < n) advance(); // closing quote
      toks.push({ kind: 'string', value: val, start, end: i, line: sLine, column: sCol });
      continue;
    }

    // Single-quoted unrestricted name
    if (c === "'") {
      const start = i;
      const sLine = line;
      const sCol = col;
      advance();
      let val = '';
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) {
          advance();
          val += src[i];
          advance();
        } else {
          val += src[i];
          advance();
        }
      }
      if (i < n) advance();
      toks.push({
        kind: 'ident',
        value: val,
        start,
        end: i,
        line: sLine,
        column: sCol,
        unrestricted: true,
      });
      continue;
    }

    // Number (integer or decimal). `1..5` lexes as number, '..', number.
    if (isDigit(c)) {
      const start = i;
      const sLine = line;
      const sCol = col;
      while (i < n && isDigit(src[i])) advance();
      if (src[i] === '.' && isDigit(src[i + 1])) {
        advance(); // dot
        while (i < n && isDigit(src[i])) advance();
      }
      // exponent
      if ((src[i] === 'e' || src[i] === 'E') && (isDigit(src[i + 1]) || ((src[i + 1] === '+' || src[i + 1] === '-') && isDigit(src[i + 2])))) {
        advance();
        if (src[i] === '+' || src[i] === '-') advance();
        while (i < n && isDigit(src[i])) advance();
      }
      toks.push({
        kind: 'number',
        value: src.slice(start, i),
        start,
        end: i,
        line: sLine,
        column: sCol,
      });
      continue;
    }

    // Identifier / keyword
    if (isIdentStart(c)) {
      const start = i;
      const sLine = line;
      const sCol = col;
      while (i < n && isIdentPart(src[i])) advance();
      toks.push({
        kind: 'ident',
        value: src.slice(start, i),
        start,
        end: i,
        line: sLine,
        column: sCol,
      });
      continue;
    }

    // Operators / punctuation (greedy longest match)
    let matched: string | undefined;
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    const start = i;
    const sLine = line;
    const sCol = col;
    if (matched) {
      advance(matched.length);
      toks.push({ kind: 'op', value: matched, start, end: i, line: sLine, column: sCol });
    } else {
      // Unknown character — emit as a single-char op so the parser can report it.
      advance();
      toks.push({ kind: 'op', value: c, start, end: i, line: sLine, column: sCol });
    }
  }

  toks.push({ kind: 'eof', value: '', start: n, end: n, line, column: col });
  return toks;
}
