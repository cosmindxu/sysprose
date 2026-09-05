/**
 * TextEditor — the SysML v2 textual-notation editor bound to
 * {@link useAppStore.textBuffer}.
 *
 * - A monospaced `<textarea>` (`data-testid="text-editor"`) with a synced
 *   line-number gutter.
 * - "Apply text → model" (`data-testid="text-apply"`) reparses the buffer into
 *   the live model via `store.applyText`.
 * - When the model changes and the buffer is *not* dirty, the editor
 *   auto-regenerates the canonical text via `store.regenerateText`, keeping the
 *   text view in sync with diagram/tree edits (bidirectional sync, plan §5).
 * - Parse diagnostics are surfaced in an inline strip beneath the editor.
 * - When the model cannot be written as text at all (`store.serializeError`),
 *   the buffer is the LAST text that could be written: the status strip says so,
 *   an inline notice gives the reason, and "Apply text → model" is disabled,
 *   because applying a stale text would replace the model it no longer describes.
 *   Editing the buffer re-enables it — a text the user typed is their intent,
 *   and applying it is the way out of that state.
 */

import { useMemo, useRef } from 'react';
import { useAppStore } from '../store';
import type { Diagnostic } from '@validation/index';
import './panels.css';

export function TextEditor(): JSX.Element {
  const textBuffer = useAppStore((s) => s.textBuffer);
  const textDirty = useAppStore((s) => s.textDirty);
  const serializeError = useAppStore((s) => s.serializeError);
  const diagnostics = useAppStore((s) => s.diagnostics);
  const setTextBuffer = useAppStore((s) => s.setTextBuffer);
  const applyText = useAppStore((s) => s.applyText);
  const regenerateText = useAppStore((s) => s.regenerateText);

  // The buffer is not the model AND nobody has typed into it: applying it would
  // put an older model back over the live one, which is not what the button says.
  const applyRefused = serializeError !== null && !textDirty;

  const gutterRef = useRef<HTMLDivElement>(null);

  // NOTE: the model→text auto-sync (regenerate the buffer when the model changes
  // and the buffer is clean) is now owned by the store's coalesced recompute
  // (`scheduleRecompute`), which updates `textBuffer` directly — one serialize
  // per edit-burst instead of one per rev (findings C5/L6). This component just
  // renders `textBuffer`; the "Regenerate from model" button stays explicit.

  // Line-number gutter contents (kept as plain text; scroll-synced below).
  const lineCount = useMemo(() => Math.max(1, textBuffer.split('\n').length), [textBuffer]);
  const gutter = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'),
    [lineCount],
  );

  // Surface parse-stage diagnostics (the rest live in the Problems tab).
  const parseDiags = diagnostics.filter((d: Diagnostic) => d.ruleId === 'parse');

  return (
    <div className="text-editor-wrap">
      <div className="text-editor-toolbar">
        <button
          data-testid="text-apply"
          onClick={() => applyText()}
          disabled={applyRefused}
          title={
            applyRefused
              ? 'This text is not the model — applying it would put an older model back'
              : 'Reparse the text into the model'
          }
        >
          Apply text → model
        </button>
        <button onClick={() => regenerateText()} title="Discard edits and regenerate text from the model">
          Regenerate from model
        </button>
        <span
          className={`text-editor-status ${applyRefused ? 'is-refused' : textDirty ? 'is-dirty' : ''}`}
        >
          {applyRefused
            ? 'not the model — it could not be written'
            : textDirty
              ? 'modified — not yet applied'
              : 'in sync with model'}
        </span>
      </div>

      {serializeError !== null && (
        <div className="text-editor-refusal" data-testid="text-serialize-error">
          {serializeError}
        </div>
      )}

      <div className="text-editor-body">
        <div className="text-editor-gutter" ref={gutterRef} aria-hidden="true">
          {gutter}
        </div>
        <textarea
          className="text-editor"
          data-testid="text-editor"
          spellCheck={false}
          wrap="off"
          value={textBuffer}
          onChange={(e) => setTextBuffer(e.target.value)}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>

      {parseDiags.length > 0 && (
        <div className="text-editor-diags">
          {parseDiags.map((d) => (
            <div key={d.id} className={`text-editor-diag ${d.severity}`}>
              <span className="problem-sev">{d.severity}</span>
              <span>{d.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TextEditor;
