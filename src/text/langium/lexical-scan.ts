/**
 * Pre-lex scan for UNTERMINATED DELIMITERS.
 *
 * WHY. Chevrotain cannot tell you that a `/*` was never closed: the comment
 * token simply fails to match, the `/` is lexed on its own, and the parser then
 * emits a cascade of errors about tokens it met inside what the author intended
 * as prose. An agent reading that cascade has no way to reach the real mistake —
 * the four messages never mention a comment. The same is true of an unterminated
 * string, which surfaces as an "illegal character" on the quote whose suggested
 * repair (delete the quote) is the opposite of the fix.
 *
 * These two mistakes are cheap to detect exactly, by scanning the source once
 * before parsing. When one is found the caller reports it INSTEAD of the
 * cascade, because every error after an unterminated delimiter is an artefact of
 * the delimiter, not an independent problem.
 */

/** An unterminated delimiter, with the position where it was opened. */
export interface UnterminatedDelimiter {
  kind: 'comment' | 'string';
  /** 1-based line of the opening delimiter. */
  line: number;
  /** 1-based column of the opening delimiter. */
  column: number;
  /** 0-based offset of the opening delimiter. */
  offset: number;
  /** The opening delimiter itself, for the `found` field. */
  found: string;
}

/**
 * Scan `text` for the first unterminated block comment or string literal.
 *
 * Single-line `//` comments end at the newline and can never be unterminated.
 * A string is considered unterminated when its closing quote does not appear
 * before the end of the line (SysML string literals do not span lines).
 * Returns `undefined` when the source is well-delimited.
 */
export function findUnterminatedDelimiter(text: string): UnterminatedDelimiter | undefined {
  let line = 1;
  let col = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '\n') {
      line++;
      col = 1;
      continue;
    }

    // Line comment: skip to end of line.
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      i--; // let the loop see the newline and advance the line counter
      continue;
    }

    // Block comment: must find a closing */.
    if (c === '/' && next === '*') {
      const openLine = line;
      const openCol = col;
      const openOffset = i;
      const close = text.indexOf('*/', i + 2);
      if (close === -1) {
        return { kind: 'comment', line: openLine, column: openCol, offset: openOffset, found: '/*' };
      }
      for (let j = i; j < close + 2; j++) {
        if (text[j] === '\n') {
          line++;
          col = 1;
        } else col++;
      }
      i = close + 1;
      continue;
    }

    // String literal: must close before end of line.
    if (c === '"' || c === "'") {
      const quote = c;
      const openLine = line;
      const openCol = col;
      const openOffset = i;
      let j = i + 1;
      let closed = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        return {
          kind: 'string',
          line: openLine,
          column: openCol,
          offset: openOffset,
          found: quote,
        };
      }
      col += j - i + 1;
      i = j;
      continue;
    }

    col++;
  }
  return undefined;
}
