/**
 * What a note body may contain, and why anything else is refused.
 *
 * A note body — the `body` of a `doc`, a `comment` or a `rep`, and the
 * requirement statement the serializer writes as a `doc` line — is delimited by
 * the grammar's `ML_COMMENT`, and that terminal has NO escape sequence at all:
 * unlike a name (`quoteName`) or a string (`quoteString`), there is no spelling
 * of the closing delimiter that survives inside a note. A body carrying it
 * therefore has NO textual representation at all.
 *
 * It is not the only authored string the serializer writes verbatim. A value
 * expression (`attrs.value`, which the Properties Value box also takes as free
 * text) is emitted as written, and injects the same way — it is notation rather
 * than prose, with no delimiter of its own to close, and closing it needs a
 * check that the value parses as an expression. That is a separate defect,
 * recorded in the campaign ledger under Known limitations, not fixed here.
 *
 * Written out verbatim, such a body closes its note early and everything after
 * it is re-read as declarations — silently, because the result parses. A
 * requirement statement ending in a close-note followed by
 * `satisfy R1 by Vehicle;` grew a Satisfy nobody wrote, and the second save
 * promoted the mis-parse into the canonical form, so the corruption became
 * undetectable.
 *
 * Every note body reaches the model through a UI write path or the element-graph
 * API, so the constraint has to live where all of them can ask it — below `text`
 * (which enforces it as an invariant of what it writes), below `validation`
 * (which reports a model that already carries one) and below `ui` (which refuses
 * the keystroke and says why). Hence: here, in the semantics layer, with the
 * refusal wording beside the predicate so the panels cannot come to give two
 * different accounts of the same refusal — the shape
 * `FAULTED_DECLARATION_REFUSAL` already set.
 */

/** The two characters that end a note body. The grammar gives no escape for them. */
export const NOTE_BODY_TERMINATOR = '*/';

/**
 * True when `value` can be written back into a note and read out unchanged.
 *
 * Non-string values are writable as far as this predicate is concerned: they
 * are not note bodies, and the callers that hold one (an `attrs.text` on
 * something that is not a requirement) must not be refused by a rule that does
 * not apply to them.
 */
export function isWritableNoteBody(value: unknown): boolean {
  return typeof value !== 'string' || !value.includes(NOTE_BODY_TERMINATOR);
}

/**
 * Why a note write is refused, in words for the person holding the keyboard.
 *
 * The developer-facing half is {@link UnwritableNoteBodyError}; this is the
 * sentence a panel puts on the control, and it names both the sequence and the
 * consequence, because "invalid input" would leave the author guessing which of
 * their characters the tool objected to.
 */
export const UNWRITABLE_NOTE_BODY_REFUSAL =
  `A note cannot contain the characters \u201c${NOTE_BODY_TERMINATOR}\u201d: they close the note ` +
  'in the saved file, and everything after them would be read back as model structure. Remove ' +
  'them, or write the text without the slash.';

/**
 * Thrown by the serializer when a body it was handed cannot be written.
 *
 * It is an assertion, not a user path: the write boundaries refuse such a value
 * and `validation/unwritable-note-body` reports a model that already carries
 * one, so reaching this means something bypassed both (the element-graph API, a
 * hand-written model JSON). Refusing to produce the file is the honest answer —
 * the alternative is a file that parses cleanly and means something else.
 */
export class UnwritableNoteBodyError extends Error {
  constructor(
    /** Element whose note body could not be written. */
    readonly elementId: string,
    /** Which attribute held it (`body`, or a requirement's `text`). */
    readonly attribute: string,
  ) {
    super(
      `Cannot serialize ${elementId}: its ${attribute} contains ` +
        `"${NOTE_BODY_TERMINATOR}", which closes the note it would be written into. ` +
        UNWRITABLE_NOTE_BODY_REFUSAL,
    );
    this.name = 'UnwritableNoteBodyError';
  }
}
