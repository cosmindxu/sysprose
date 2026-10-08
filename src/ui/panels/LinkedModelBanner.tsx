/**
 * One-line strip shown when the session was opened from a `?model=` link: which
 * file is open, that edits stay in this browser, and — when the link carries a
 * `?source=` — where to propose a change. On a failed load it says why instead.
 *
 * It gives way to the Google Drive strip (DriveStrip) while a Drive file is
 * attached or a `?drive=` link is set: the model is then the Drive file's, and
 * "edits stay in this browser" would no longer be the whole story.
 */

import { useState } from 'react';
import { useAppStore } from '../store';
import { modelFileName } from '../linked-model';

export function LinkedModelBanner(): JSX.Element | null {
  const linked = useAppStore((s) => s.linkedModel);
  const driveHolds = useAppStore((s) => s.drive.file !== null || s.drive.link !== null);
  const [dismissed, setDismissed] = useState(false);
  if (!linked || linked.status === 'loading' || dismissed || driveHolds) return null;

  const name = modelFileName(linked.url);
  const failed = linked.status === 'failed';
  return (
    <div
      className={`linked-banner${failed ? ' linked-banner-failed' : ''}`}
      data-testid="linked-banner"
      data-status={linked.status}
      role={failed ? 'alert' : 'status'}
    >
      {failed ? (
        <span>
          Could not open <code title={linked.url}>{name}</code>: {linked.error}. Showing the sample
          model instead.
        </span>
      ) : (
        <span title="Reloading the page fetches the model again and discards unsaved edits.">
          Opened <code title={linked.url}>{name}</code> from its link. Edits stay in this browser —
          Save or Export to keep them.
        </span>
      )}
      {linked.source && (
        <a
          className="linked-banner-link"
          data-testid="linked-banner-source"
          href={linked.source}
          target="_blank"
          rel="noopener noreferrer"
        >
          Propose a change
        </a>
      )}
      <button
        className="linked-banner-close"
        data-testid="linked-banner-close"
        title="Hide this message"
        aria-label="Hide this message"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  );
}
