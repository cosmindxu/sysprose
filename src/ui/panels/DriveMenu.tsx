/**
 * DriveMenu — Google Drive (optional): the toolbar's **Drive ▾** button and
 * its panel.
 *
 * It renders only on a deployment whose `drive.json` names a client
 * (`drive.configStatus === 'ready'`). Everywhere else it renders nothing at
 * all, so the toolbar is exactly the one every other spec knows.
 *
 * Shaped like Collaborate: one button with a status dot — `data-status` is
 * `signed-out` (grey), `signed-in` (green), `attention` (amber: unsaved
 * changes, a conflict, a question waiting, a sign-in to renew, a file gone
 * from Drive) or `error` (red) — with the attached file's name in
 * `data-file`, and a popover panel whose items follow the session: signed
 * out, Sign in; signed in, Save and Save as, the attached file's link and
 * Close, the Recent list, Browse, a pasted link, Sign out.
 *
 * Opening the panel starts loading Google's sign-in script, and "Sign in to
 * Google…" waits for it, disabled and saying so: the sign-in popup must open
 * inside the click, and a script fetched inside the click could outlast the
 * click's permission to open a window.
 *
 * Every command here that replaces the model or lets go of the attached file
 * — an open, Close, Sign out — goes through `driveGuard`, which asks first in
 * the Drive strip below the toolbar when it would lose unsaved Drive changes,
 * or, before an open, work no save holds. Close and Sign out keep the model,
 * so they ask about nothing else (`detach`). The panel closes for
 * whatever goes on in the strip, so its question is not hidden under it —
 * and when the clipboard refuses the file's link, which the strip then shows
 * to copy by hand.
 *
 * Every test id is a literal `data-testid="…"`: the user guide's appendix is
 * checked against exactly those spellings (`test/support/ui-testids.ts`).
 */

import { useEffect, useRef, useState } from 'react';
import { DRIVE_MESSAGES, driveDirty, driveLink, driveTime, useAppStore, type DriveState } from '../store';
import { driveWebViewLink, parseDriveFileRef, type DriveFileMeta, type DriveFileRef } from '@persistence/index';
import { Popover, isInside } from './Popover';
import { DRIVE_BUSY, driveUnavailable, showDriveLinkByHand } from './DriveStrip';

/** The button's dot. */
export type DriveMenuStatus = 'signed-out' | 'signed-in' | 'attention' | 'error';

/**
 * What the dot says: an error first (red); then signed out (grey); then
 * anything waiting for the user (amber); else signed in (green). The strip's
 * question about work no save holds is not Drive's, and leaves it as it is.
 */
export function driveMenuStatus(d: DriveState, dirty: boolean): DriveMenuStatus {
  if (d.notice?.kind === 'error') return 'error';
  if (d.account === null) return 'signed-out';
  const waiting =
    dirty ||
    d.conflict !== null ||
    d.pending !== null ||
    (d.prompt?.kind === 'guard' && d.prompt.variant !== 'browser') ||
    d.prompt?.kind === 'rewrite' ||
    d.file?.trashed === true;
  return waiting ? 'attention' : 'signed-in';
}

/** Save to Drive: whether it can run, and its title — the reason when it cannot. */
function saveState(d: DriveState, dirty: boolean): { disabled: boolean; title: string } {
  const file = d.file;
  if (file === null) return { disabled: true, title: 'No Drive file is open — Save to Drive as… writes one' };
  if (file.trashed) {
    return { disabled: true, title: `${file.name} is no longer in Drive — Save to Drive as… writes a new file` };
  }
  if (!file.canEdit) return { disabled: true, title: 'You have view access only — Save to Drive as… keeps your own copy' };
  if (!dirty) return { disabled: true, title: 'No unsaved changes' };
  const blocked = driveUnavailable(d);
  if (blocked !== null) return { disabled: true, title: blocked };
  return { disabled: false, title: `Save the model to ${file.name} in Google Drive (Ctrl+Shift+S)` };
}

/** The reference a Recent row opens: its id, and its resource key when Drive reported one. */
function refOf(f: DriveFileMeta): DriveFileRef {
  return f.resourceKey !== undefined ? { id: f.id, resourceKey: f.resourceKey } : { id: f.id };
}

export function DriveMenu(): JSX.Element | null {
  const drive = useAppStore((s) => s.drive);
  const dirty = useAppStore((s) => driveDirty(s));

  const [open, setOpen] = useState(false);
  // How the sign-in script's load went since the panel last opened: `failed`
  // once it ended without the script (the strip's notice says why), so the
  // button stops claiming it is still loading. Reopening the panel tries again.
  const [script, setScript] = useState<'loading' | 'failed'>('loading');
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close the panel on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!isInside(e.target, wrapRef, panelRef)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (drive.configStatus !== 'ready' || drive.config === null) return null;

  const store = () => useAppStore.getState();

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setCopied(false);
    // Google's sign-in script starts loading now, so the sign-in click finds
    // it there and opens its popup inside that click.
    setScript('loading');
    void store()
      .drivePrepare()
      .then(() => {
        if (!store().drive.authReady) setScript('failed');
      });
  };

  /**
   * A command that replaces the model, or lets go of the attached file,
   * through the guard. The panel closes when `close` says so — the command
   * goes on in the strip — and whenever the guard asks first, so its question
   * is in view.
   */
  const guarded = (
    label: string,
    variant: 'open' | 'detach',
    run: () => void | Promise<void>,
    close: boolean,
  ): void => {
    store().driveGuard(label, variant, run);
    if (close || store().drive.prompt?.kind === 'guard') setOpen(false);
  };

  const openFile = (ref: DriveFileRef, from: 'recent' | 'paste'): void =>
    guarded('Open from Drive', 'open', () => store().driveOpen(ref, from), true);

  const pastedRef = parseDriveFileRef(pasted);
  const openPasted = (): void => {
    if (pastedRef === null || driveUnavailable(drive) !== null) return;
    setPasted('');
    openFile(pastedRef, 'paste');
  };

  const blocked = driveUnavailable(drive);
  const status = driveMenuStatus(drive, dirty);
  const file = drive.file;
  const account = drive.account;
  const who = account === null ? null : account.email ?? account.name;
  const hasPicker = drive.config.apiKey !== undefined && drive.config.appId !== undefined;
  const save = saveState(drive, dirty);
  const webLink = file === null ? null : driveWebViewLink(file.webViewLink);
  // The deep link follows the attached file, which this component re-renders on.
  const link = open && file !== null ? driveLink(useAppStore.getState()) : null;

  let signIn: { label: string; title: string };
  if (drive.authReady) {
    signIn = { label: 'Sign in to Google…', title: blocked ?? 'Choose your Google account' };
  } else if (script === 'failed') {
    signIn = { label: 'Google sign-in did not load', title: DRIVE_MESSAGES.scriptFailed };
  } else {
    signIn = { label: 'Loading Google sign-in…', title: 'Loading Google sign-in…' };
  }

  return (
    <div className="toolbar-drive" ref={wrapRef} style={{ position: 'relative' }}>
      <button
        data-testid="tb-drive"
        data-status={status}
        data-file={file?.name ?? ''}
        onClick={toggle}
        aria-expanded={open}
        title={file !== null ? `Google Drive: ${file.name}` : 'Google Drive'}
      >
        <span className="drive-indicator" data-status={status} />
        Drive ▾
      </button>

      {open && (
        <Popover anchor={wrapRef} panelRef={panelRef} className="drive-panel" testid="drive-panel" align="end">
          <div className="drive-panel-title">Google Drive</div>
          <div className="drive-account" data-testid="drive-account">
            {account === null ? 'Not signed in' : who ? `Signed in as ${who}` : 'Signed in to Google'}
          </div>
          {drive.busy !== null && <div className="drive-panel-note">{DRIVE_BUSY[drive.busy]}</div>}

          {account === null ? (
            <>
              <button
                data-testid="tb-drive-signin"
                className="drive-panel-item"
                disabled={!drive.authReady || blocked !== null}
                title={signIn.title}
                onClick={() => void store().driveSignIn()}
              >
                {signIn.label}
              </button>
              <div className="drive-panel-note">
                Keep this model as a .sysml file in your own Google Drive. Sysprose sees only the files you save
                or choose here.
              </div>
            </>
          ) : (
            <>
              <div className="drive-panel-section">
                <button
                  data-testid="tb-drive-save"
                  className="drive-panel-item"
                  disabled={save.disabled}
                  title={save.title}
                  onClick={() => {
                    void store().driveSave();
                    setOpen(false);
                  }}
                >
                  Save to Drive <kbd className="drive-kbd">Ctrl+Shift+S</kbd>
                </button>
                <button
                  data-testid="tb-drive-save-as"
                  className="drive-panel-item"
                  disabled={blocked !== null}
                  title={blocked ?? 'Write the model to a new .sysml file in My Drive'}
                  onClick={() => {
                    void store().driveSaveAs();
                    setOpen(false);
                  }}
                >
                  Save to Drive as…
                </button>
              </div>

              {file !== null && (
                <div className="drive-panel-section">
                  <div className="drive-panel-file" title={file.name}>
                    {file.name}
                  </div>
                  <button
                    data-testid="drive-copy-link"
                    className="drive-panel-item"
                    data-link={link ?? ''}
                    title={link ?? undefined}
                    onClick={() =>
                      void store()
                        .driveCopyLink()
                        .then(
                          () => setCopied(true),
                          () => {
                            // The clipboard said no: the strip shows the link
                            // to copy by hand, out from under the panel.
                            if (link !== null) showDriveLinkByHand(link);
                            setOpen(false);
                          },
                        )
                    }
                  >
                    {copied ? 'Link copied' : 'Copy link to this file'}
                  </button>
                  {webLink !== null && (
                    <button
                      data-testid="drive-open-in-drive"
                      className="drive-panel-item"
                      title="Drive's own page for this file: sharing, versions, download"
                      onClick={() => {
                        window.open(webLink, '_blank', 'noopener,noreferrer');
                        setOpen(false);
                      }}
                    >
                      Open in Google Drive ↗
                    </button>
                  )}
                  <button
                    data-testid="drive-close"
                    className="drive-panel-item"
                    title="Let go of the Drive file; the model stays"
                    onClick={() => guarded('Close Drive file', 'detach', () => store().driveDetach(), true)}
                  >
                    Close Drive file
                  </button>
                </div>
              )}

              <div className="drive-panel-section">
                <div className="drive-panel-heading">
                  <span>Recent</span>
                  <button
                    data-testid="drive-recent-refresh"
                    className="drive-panel-link"
                    disabled={blocked !== null}
                    title={blocked ?? 'Read the list again'}
                    onClick={() => void store().driveRefreshRecent()}
                  >
                    Refresh
                  </button>
                </div>
                {drive.recent !== null && drive.recent.length === 0 && (
                  <div className="drive-panel-note" data-testid="drive-recent-empty">
                    No models saved from this app yet.
                    {/* Browse Drive… is there only on a site with Google's Picker. */}
                    {hasPicker && ' Browse Drive… finds files shared with you.'}
                  </div>
                )}
                {drive.recent !== null && drive.recent.length > 0 && (
                  <div className="drive-recent">
                    {drive.recent.map((f) => (
                      <button
                        key={f.id}
                        data-testid="drive-recent-item"
                        className="drive-panel-item"
                        data-id={f.id}
                        data-name={f.name}
                        disabled={blocked !== null}
                        title={blocked ?? `Open ${f.name}`}
                        onClick={() => openFile(refOf(f), 'recent')}
                      >
                        <span className="drive-recent-name">{f.name}</span>
                        <span className="drive-recent-time">{` · ${driveTime(f.modifiedTime)}`}</span>
                      </button>
                    ))}
                  </div>
                )}
                {hasPicker && (
                  <button
                    data-testid="tb-drive-browse"
                    className="drive-panel-item"
                    disabled={blocked !== null}
                    title={blocked ?? "Choose a file in Google's picker — yours, or one shared with you"}
                    onClick={() => guarded('Open from Drive', 'open', () => store().driveBrowse(), true)}
                  >
                    Browse Drive…
                  </button>
                )}
                <div className="drive-paste">
                  <input
                    data-testid="drive-open-id"
                    className="drive-input"
                    value={pasted}
                    placeholder="Paste a Drive link or file id"
                    aria-label="Paste a Drive link or file id"
                    spellCheck={false}
                    onChange={(e) => setPasted(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') openPasted();
                    }}
                  />
                  <button
                    data-testid="drive-open-id-go"
                    disabled={pastedRef === null || blocked !== null}
                    title={
                      pastedRef === null
                        ? 'Paste a Google Drive share link, a link to this app with ?drive=, or a file id'
                        : (blocked ?? 'Open this file')
                    }
                    onClick={openPasted}
                  >
                    Open
                  </button>
                </div>
              </div>

              <button
                data-testid="tb-drive-signout"
                className="drive-panel-item"
                title="Ask Google to revoke this app's access, and forget the session here"
                onClick={() => guarded('Sign out', 'detach', () => store().driveSignOut(), false)}
              >
                Sign out
              </button>
            </>
          )}

          <div className="drive-panel-footer">
            <a data-testid="drive-privacy" href={drive.config.privacyUrl} target="_blank" rel="noopener noreferrer">
              Privacy &amp; data ↗
            </a>
          </div>
        </Popover>
      )}
    </div>
  );
}

export default DriveMenu;
