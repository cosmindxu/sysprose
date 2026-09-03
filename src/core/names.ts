/**
 * Qualified-name SPLITTING — the one place a textual reference is cut into
 * segments.
 *
 * WHY THIS MODULE EXISTS. The splitter used to live inside the textual mapper
 * (`src/text/langium/map-to-model.ts`), so every other layer that had to make
 * sense of a reference string re-derived it: the semantics resolver split on
 * `::` only, core's `resolveQualifiedName` split on `::` only, and the mapper
 * treated `.` and `::` alike and understood quoting. Three splitters meant
 * `'a.b'::c` shattered differently depending on who asked, and a dotted
 * `a.p` connector end was resolvable by exactly one of them. Core owns it now
 * so the mapper, the semantics binder and the serializer share one answer.
 *
 * The notation's rules, in one place:
 *  - `::` and `.` are both segment separators (SysML writes feature chains with
 *    `.` and qualified names with `::`; a resolver has to accept both);
 *  - a single-quoted *unrestricted name* is one segment even when it contains a
 *    separator (`'a.b'::c` is two segments, not three), and `\` escapes inside
 *    it are the notation's own escape, not part of the name.
 */

/**
 * Strip a single-quoted unrestricted name's surrounding quotes and unescape it.
 * Anything not quoted is returned unchanged (`undefined` passes through, so
 * callers can pipe an optional AST field straight in).
 */
export function unquoteName(s: string | undefined): string | undefined {
  if (s == null) return s;
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return s;
}

/**
 * Split a qualified name on `::` / `.` separators that lie OUTSIDE single
 * quotes, so a quoted segment containing a dot or `::` (`'a.b'::c`) is not
 * shattered (finding F7). Each returned segment is still quoted; the caller
 * unquotes it.
 */
export function splitQualified(ref: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < ref.length; i++) {
    const c = ref[i];
    if (inQuote) {
      cur += c;
      if (c === '\\' && i + 1 < ref.length) cur += ref[++i]; // keep escaped char verbatim
      else if (c === "'") inQuote = false;
    } else if (c === "'") {
      inQuote = true;
      cur += c;
    } else if (c === ':' && ref[i + 1] === ':') {
      segs.push(cur);
      cur = '';
      i++; // consume the second ':'
    } else if (c === '.') {
      segs.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  segs.push(cur);
  return segs;
}

/** Split a (possibly quoted) qualified/dotted ref into clean name segments. */
export function refSegments(ref: string): string[] {
  return splitQualified(ref)
    .map((s) => unquoteName(s.trim()) ?? '')
    .filter(Boolean);
}
