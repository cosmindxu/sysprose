/**
 * Serializer-side load health: what a file of the live model holds, without
 * re-parsing it.
 *
 * {@link loadHealth} judges a model by the texts a file of it can hold — the
 * parse errors each text carries and the validation findings on the model it
 * parses to. Measuring that by parsing every text, merging the library and
 * validating is ~0.5-1.3 s per text on a model the size of the drone swarm. The
 * serializer can say most of it as it writes, and this module collects the two
 * halves:
 *
 *  - {@link TextSignals.parseErrors}: the words the serializer writes back that
 *    the grammar cannot read (a feature value the parser stored as verbatim
 *    expression text, and an `unparsedText` residue that reproduces a fault).
 *    These are known without parsing the file;
 *  - {@link TextSignals.referenceFaithful}: whether every reference the text
 *    writes re-resolves to the element it denotes on a FRESH parse. When it
 *    does, and nothing is left as unresolved text, the model the text parses to
 *    is the live model, so the text's validation is the live model's and
 *    `loadHealth` need not parse it. When it does not (a connector end left
 *    behind by a rename, the case `test/unit/store.reducers.test.ts` pins), the
 *    text is only a sample and `loadHealth` falls back to a parse for the exact
 *    count.
 *
 * The reference check is the serializer's {@link serializeUserModelRefs} tally;
 * the unresolved-text and import checks live here because they need the model,
 * not the emitted string.
 */

import { Model } from '@core/index';
import { resolveFullName } from '@semantics/bind';
import { astToModel } from './langium/map-to-model';
import { serializeUserModelRefs } from './serializer';

/** What the serializer can say about the text a file of the model holds. */
export interface TextSignals {
  /** The text Save/Export write for the model's user roots. */
  readonly text: string;
  /** Parse errors the text will carry, counted without parsing the whole text. */
  readonly parseErrors: number;
  /**
   * Every reference the text writes re-resolves to its element on a fresh
   * parse, and no reference is left as unresolved text. Then the text parses to
   * the live model, so its validation does not have to be measured separately.
   */
  readonly referenceFaithful: boolean;
}

/** The specialization-family attributes the mapper leaves behind as TEXT. */
const TEXTUAL_REF_KEYS = ['typeRef', 'specializes', 'redefines', 'references', 'aliasFor'] as const;
/** Endpoint attributes the mapper leaves behind as TEXT when an end does not resolve. */
const ENDPOINT_REF_KEYS = ['sourceRef', 'targetRef'] as const;
/** Names a note/annotation carries about elements; emitted verbatim, so a rename can stale them. */
const ABOUT_KEYS = ['about'] as const;

/** A bare double-quoted string literal the grammar reads back as written. */
const QUOTED_STRING = /^"(?:\\.|[^"\\])*"$/;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** True when any user element carries a still-textual reference the parser could not bind. */
function hasTextualResidue(model: Model): boolean {
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    for (const key of [...TEXTUAL_REF_KEYS, ...ENDPOINT_REF_KEYS, ...ABOUT_KEYS]) {
      const v = el.attrs[key];
      if (typeof v === 'string') {
        if (v.trim() !== '') return true;
      } else if (Array.isArray(v) && v.some((x) => typeof x === 'string' && x.trim() !== '')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The number of parse errors the emitted text will carry, counted without
 * parsing the file: one per `unparsedText` residue (emitted verbatim, so it
 * reproduces its fault) and one per feature value written as verbatim
 * expression text the grammar cannot read back. A value the grammar reads
 * (`2 * 3`, a quoted string) is not an error; the value is re-read on its own,
 * which is a fraction of the file's parse.
 */
function parseErrorsOf(model: Model): number {
  let n = 0;
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    if (str(el.attrs.unparsedText) !== undefined) {
      n++;
      continue;
    }
    const v = el.attrs.value;
    if (typeof v !== 'string' || QUOTED_STRING.test(v)) continue;
    if (!valueTextParses(v)) n++;
  }
  return n;
}

/** Whether a verbatim value's text reads back through the grammar; memoized by text. */
const valueReadsBack = new Map<string, boolean>();

/** Read one feature value's verbatim text back through the grammar; true when it has no parse error. */
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

/**
 * True when every import the user wrote still names the namespace it was bound
 * to — a namespace renamed after the import would leave the text's `import`
 * naming nothing, which a fresh parse would report and the live model would not.
 */
function importsFaithful(model: Model): boolean {
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    if (el.eClass !== 'NamespaceImport' && el.eClass !== 'MembershipImport') continue;
    const targetId = (el.target ?? [])[0];
    const name = str(el.attrs.importedName);
    if (targetId === undefined || name === undefined) continue;
    const ref = name.replace(/::\*\s*$/, '').replace(/\*\s*$/, '').trim();
    if (ref === '') continue;
    const found = resolveFullName(model, ref, el.ownerId, { accept: (e) => e.attrs.implicit !== true });
    if (found === undefined || found.id !== targetId) return false;
  }
  return true;
}

/**
 * True when every display type the serializer writes from `attrs.type` (an
 * attribute's authored `: T`, an annotation's `@T`) still resolves — the one
 * reference the serializer writes from an attribute rather than through
 * {@link refTo}, so the tally above cannot see it.
 */
function displayTypesFaithful(model: Model): boolean {
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    const t = str(el.attrs.type);
    if (t === undefined || t.startsWith('«')) continue;
    const found = resolveFullName(model, t, el.ownerId, { accept: (e) => e.attrs.implicit !== true });
    if (found === undefined) return false;
  }
  return true;
}

/**
 * Serialize the model's user text and report what a file of it holds without
 * parsing it: the parse errors the serializer may write, and whether its
 * references all re-resolve so validation can be read off the live model.
 */
export function serializeUserModelSignals(model: Model): TextSignals {
  const { text, unresolvedRefs } = serializeUserModelRefs(model);
  return {
    text,
    parseErrors: parseErrorsOf(model),
    referenceFaithful:
      unresolvedRefs === 0 &&
      !hasTextualResidue(model) &&
      importsFaithful(model) &&
      displayTypesFaithful(model),
  };
}
