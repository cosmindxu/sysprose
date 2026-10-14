/**
 * Load health, the half that needs no store: what a text a file of the model can
 * hold is worth to a check.
 *
 * `loadHealth` (`src/ui/store.ts`) judges a model by the texts a file of it can
 * hold — what Save writes and what Export ▾ SysML writes — as a terminal loads
 * that file: the errors the parse reports, and the error findings validation puts
 * on the text's own elements with the standard library merged. It also asks
 * whether such a file holds the model on screen at all: a field written back as
 * typed that closes its owner, adds a declaration or turns the rest of its line
 * into a comment can leave a text that parses cleanly, but to another model, so a
 * terminal checks a model the page never walked ({@link MeasuredText.rewritten}). {@link measureTextHealth} is that
 * measurement. The checks worker runs it (`src/ui/checks-offthread.ts`), so a
 * check click does not hold the page for a parse — seconds on the drone-swarm
 * model the first time, while the worker builds the parser and the library, and
 * less after an edit — and the page runs the same function where it has no
 * worker. A unit test holds it to `loadModelText` (`./load.ts`,
 * the terminal's own loader) over the test corpus and a fuzz of every field the
 * serializer writes verbatim.
 *
 * THE SERIALIZER'S SIGNAL ONLY EVER SAYS "FAULTY". As it writes a text, the
 * serializer can see one kind of fault for certain ({@link serializeUserModelSignals}):
 * a line of the text that is one declaration written whole, ending in a feature
 * value written back as it was typed and the `;` that ends it, where nothing on
 * the line can pair with or close anything else (no brace, semicolon, quote,
 * comment mark, line break or unmatched bracket), the value is one the grammar
 * cannot read on its own, and the parser's own lexer reads the line's start as
 * code — not the inside of a string, a quoted name or a comment that some other
 * field opened before it. The value's tokens then reach the expression rule
 * exactly as they do alone, with the same `;` after them, so a parse fails there.
 * A text with such a line is taken as not loading cleanly WITHOUT being parsed:
 * an early answer that can only demote a check, never let one pass. A text with
 * none is NOT thereby clean, and nothing here says it is. The signal does not
 * read a guard, a trigger, an effect, an expression or a metadata name, a
 * non-string value, a name or unit holding a line break, a declaration a parse
 * could not read (`unparsedText`, whose span the mapper's fault-residue pass
 * chooses by rule of thumb, so only a parse of the text it lands in can say what
 * it does there), a value whose line holds a quote or a comment mark before it
 * (`attribute rate : Real // kg = 1 +;` reads as a line note), or a value the text
 * around it can complete or close (`2; attribute rate = 3` adds a declaration,
 * `1 +` before a `{ … }` body is read as `1 + { … }`, a unit is written after the
 * value, and a `}` closes its owner) — the parse does all of those. Nor is its
 * count a terminal's: it counts the lines it found, and a parse may report their
 * errors otherwise. The row that reports it says what was found, and that the
 * text was not parsed.
 *
 * 679a5e5 used the signal the other way, as a certificate that a text parses to
 * the live model, so that `loadHealth` could skip the parse; it said the
 * certificate "can only make loadHealth parse more, never less". Neither held
 * (review 2026-10-14, LH-1..LH-4): the app read `holds` over texts the terminal
 * rejects. The certificate and its reference tally are gone; a text is clean only
 * once a parse has said so.
 */

import { Model, type ElementId } from '@core/index';
import { resolveTypeReferences } from '@library/resolve';
import { validate } from '@validation/index';
import { astToModel, resolveConnectorFeatureChains } from './langium/map-to-model';
import { tokenStarts } from './langium/module';
import { serializeElement } from './serializer';

/** What the serializer can say about the text a file of the model holds, as it writes it. */
export interface TextSignals {
  /** The text Save/Export write for the model's user roots. */
  readonly text: string;
  /**
   * The lines of the text that a parse would find faulty wherever they stand
   * ({@link serializeUserModelSignals}): more than 0 takes the text as not loading
   * cleanly without a parse. 0 says nothing — and neither count is the number of
   * parse errors a terminal prints.
   */
  readonly faults: number;
}

/**
 * Text with nothing in it the text around it could pair with or close: no
 * brace, semicolon, quote, comment mark or line break. Read in place, its tokens
 * are its own, as they are read alone.
 */
const SELF_CONTAINED = /^(?![\s\S]*(?:\/\*|\*\/|\/\/))[^{};"'\r\n]*$/;

/** Whether every `(` and `[` in `text` is closed in it, in order, and nothing closes what it did not open. */
function bracketsBalanced(text: string): boolean {
  const open: string[] = [];
  for (const ch of text) {
    if (ch === '(' || ch === '[') open.push(ch);
    else if (ch === ')' || ch === ']') {
      if (open.pop() !== (ch === ')' ? '(' : '[')) return false;
    }
  }
  return open.length === 0;
}

/**
 * The declarations the serializer writes back with a verbatim value a parse
 * finds faulty wherever its line stands, each as its own written line: a
 * {@link SELF_CONTAINED} value with its brackets matched, that the grammar
 * cannot read on its own, written last on its line — after a declaration that is
 * self-contained too, and before nothing but the `;` that ends it (no unit, no
 * body).
 */
function faultyLines(model: Model): Set<string> {
  const lines = new Set<string>();
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    const v = el.attrs.value;
    if (typeof v !== 'string' || !SELF_CONTAINED.test(v) || !bracketsBalanced(v) || valueTextParses(v)) continue;
    const line = ownLine(model, el.id);
    if (line === null || !line.endsWith(` ${v};`)) continue;
    const before = line.slice(0, line.length - v.length - 2);
    if (SELF_CONTAINED.test(before) && bracketsBalanced(before)) lines.add(line);
  }
  return lines;
}

/** The element's own written text at no indent, or null for one the serializer refuses. */
function ownLine(model: Model, id: ElementId): string | null {
  try {
    return serializeElement(model, id, 0);
  } catch {
    return null; // a model the serializer refuses has no text to judge
  }
}

/**
 * The faults the serializer wrote back verbatim into `text` that a parse would
 * find wherever they stand: one per line of `text` that is one of
 * {@link faultyLines}, written whole, where the parser's own lexer starts a
 * token at the line's first character — so it reads that line as code, not as
 * the inside of a string, a quoted name or a comment another field opened.
 * From there the line's tokens are its own, and its value's reach the
 * expression rule as they do alone, followed by the same `;`. A line found
 * elsewhere (inside a comment, a string, or written within another line) is not
 * counted, and nothing else is looked for: a value that fails these tests is
 * left to the parse.
 */
function faultsOf(model: Model, text: string): number {
  const lines = faultyLines(model);
  if (lines.size === 0) return 0;
  const starts = tokenStarts(text);
  let n = 0;
  let offset = 0;
  for (const line of text.split('\n')) {
    const body = line.trimStart();
    if (lines.has(body) && starts.has(offset + line.length - body.length)) n++;
    offset += line.length + 1;
  }
  return n;
}

/** Whether a verbatim value's text reads back through the grammar on its own; memoized by text. */
const valueReadsBack = new Map<string, boolean>();

/** Read one feature value's verbatim text back through the grammar, alone; true when it has no parse error. */
function valueTextParses(value: string): boolean {
  const known = valueReadsBack.get(value);
  if (known !== undefined) return known;
  let ok: boolean;
  try {
    const { diagnostics } = astToModel(`attribute __value : Real = ${value};`);
    ok = diagnostics.every((d: { severity: string }) => d.severity !== 'error');
  } catch {
    ok = false;
  }
  if (valueReadsBack.size > 256) valueReadsBack.clear();
  valueReadsBack.set(value, ok);
  return ok;
}

/** The text Save and Export ▾ SysML write for the model: its user roots, the library left out. Throws what the serializer throws. */
function userText(model: Model): string {
  return model
    .roots()
    .filter((r) => r.attrs.isLibrary !== true)
    .map((r) => serializeElement(model, r.id, 0))
    .join('\n\n');
}

/**
 * Serialize the model's user text — the text Save and Export ▾ SysML write, the
 * user roots only — and count the faults it wrote back verbatim that a parse
 * would find wherever they stand ({@link TextSignals.faults}). The count can make
 * a check say "this text does not load cleanly" early; it can never make one say
 * that it does.
 */
export function serializeUserModelSignals(model: Model): TextSignals {
  const text = userText(model);
  return { text, faults: faultsOf(model, text) };
}

/** What a text a file can hold is worth to a check: what a terminal that loads it counts, and what the text holds. */
export interface MeasuredText {
  /**
   * Errors the parse reports, the mapper's included, and the loader's own: a text
   * refused as JSON, or a parser that throws, counts as one (a terminal files
   * those under `import/*`).
   */
  readonly parseErrors: number;
  /**
   * Error findings validation puts on the elements the text declares (or on no
   * element), with the standard library merged; a validator that throws counts as
   * one. The library's own findings are not counted, as a terminal counts none.
   */
  readonly validationErrors: number;
  /**
   * The text the serializer writes for the model this text parses to — its user
   * roots, bound as a terminal binds them, written as Export ▾ SysML writes —
   * when the parse found no error; null when it found one, or when the serializer
   * refuses that model. A file holding the text holds the model on screen only if
   * this is the text the model on screen writes: a field written back as typed
   * that closes its owner, adds a declaration or turns the rest of its line into
   * a comment leaves a text that parses cleanly, but to another model, which
   * writes another text (review 2026-10-14).
   */
  readonly rewritten: string | null;
}

const UTF8_BOM = '\uFEFF';

/**
 * Parse `text` and validate the model it parses to, as `loadModelText` (`./load.ts`)
 * loads a file for a terminal: a BOM stripped and CRLF line ends made LF; a text
 * that starts with `{` refused as JSON, one error; the parse; then `mergeLibrary`
 * merges the standard library into the parsed model, its type references and
 * connector chains are bound, and validation runs. The sum of the two counts is
 * the number of errors the terminal prints for a file holding `text`, which a unit
 * test holds it to — save where a step throws: both then report a failure, and
 * this keeps the parse's errors beside it where the terminal may not. A text that
 * parses cleanly is then written back from its parse
 * ({@link MeasuredText.rewritten}), for the caller to set beside the text the
 * model on screen writes.
 *
 * The caller supplies the merge (the library is data the worker and the page each
 * load their own way); one that cannot merge has no answer to give, and must not
 * ask — without the library a type reads as unresolved and a rule that needs one
 * stays silent, so a count could read low as well as high.
 */
export function measureTextHealth(text: string, mergeLibrary: (model: Model) => void): MeasuredText {
  let src = text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text;
  if (src.includes('\r\n')) src = src.replace(/\r\n/g, '\n');
  if (src.trimStart().startsWith('{')) return { parseErrors: 1, validationErrors: 0, rewritten: null };
  let parsed: ReturnType<typeof astToModel>;
  try {
    parsed = astToModel(src);
  } catch (err) {
    console.error('parse failed', err);
    return { parseErrors: 1, validationErrors: 0, rewritten: null };
  }
  const parseErrors = parsed.diagnostics.filter((d) => d.severity === 'error').length;
  const model = parsed.model;
  const mine = new Set(model.all().map((el) => el.id)); // before the library goes in
  let validationErrors = 0;
  try {
    mergeLibrary(model);
    resolveTypeReferences(model);
    resolveConnectorFeatureChains(model);
    for (const d of validate(model)) {
      if (d.severity === 'error' && (d.elementId === undefined || mine.has(d.elementId))) validationErrors++;
    }
  } catch (err) {
    console.error('validation failed', err);
    validationErrors = 1;
  }
  let rewritten: string | null = null;
  if (parseErrors === 0) {
    try {
      rewritten = userText(model);
    } catch {
      rewritten = null; // the model this text parses to cannot be written, so it is not the one on screen
    }
  }
  return { parseErrors, validationErrors, rewritten };
}
