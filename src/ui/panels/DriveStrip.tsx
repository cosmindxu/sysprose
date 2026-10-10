/**
 * DriveStrip — Google Drive (optional): the strip under the toolbar that says
 * where the model stands with Google Drive and asks what the Drive commands
 * need to ask; and `DriveLinkGate`, the body of the loading gate a `?drive=`
 * link holds until its file is open.
 *
 * ONE ROW AT A TIME, named by `data-status`, in the order the store's slice
 * documents: a question first (the Save-as form, whether to rewrite a
 * hand-written file, a guard before the model is replaced); then a conflict;
 * an action running; a notice; a sign-in to renew; then the attached file —
 * gone from Drive, view access only, unsaved changes while offline, unsaved
 * changes, saved. With nothing to say it renders nothing at all. On a
 * deployment without Google Drive it has three rows: the question before a
 * command replaces work no save holds — asked on every deployment, in the
 * guard row — the notes that a save in this browser, or Export ▾ → SysML,
 * kept typed text back, or that an element went to the top level of the
 * model rather than into the standard library (`info` notices), and the note
 * that a `?drive=` link cannot be opened here.
 *
 * A conflict, an error and a guard are `role="alert"`; every other row is a
 * `role="status"`. The error row always carries the privacy page's link: a
 * sign-in Google blocked for a school account lands next to the page that
 * names the client ID for an administrator. A link the clipboard refused to
 * copy — from the strip or the panel — is shown read-only beside whichever
 * row is up, until it loses the focus it opens with.
 *
 * A control that may have to sign in — Save, the Save-as form's Save, Sign in
 * and continue, the guard's save, the gate's Sign in and open — calls its
 * store action synchronously inside the click, so Google's sign-in window
 * opens in the click's own user activation. One that would first have to wait
 * for Google's script is disabled instead, saying so, until the script is
 * there.
 *
 * Every test id is a literal `data-testid="…"`, or a literal `testid="…"` on
 * {@link StripButton}: the user guide's appendix is checked against exactly
 * those spellings (`test/support/ui-testids.ts`).
 */

import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { create } from 'zustand';
import {
  DRIVE_MESSAGES,
  driveConflictMessage,
  driveDirty,
  driveFileName,
  driveLink,
  driveTime,
  typedTextFaulted,
  useAppStore,
  type DrivePrompt,
  type DriveState,
} from '../store';
import { driveWebViewLink, parseDriveFileRef } from '@persistence/index';

/** What the strip is showing: its `data-status`. */
export type DriveStripStatus =
  | 'link-unsupported'
  | 'saveas'
  | 'rewrite'
  | 'guard'
  | 'conflict'
  | 'saving'
  | 'opening'
  | 'error'
  | 'closed'
  | 'info'
  | 'expired'
  | 'gone'
  | 'readonly'
  | 'offline'
  | 'dirty'
  | 'clean';

/** The Drive action in progress, as a disabled control's title names it. */
export const DRIVE_BUSY: Record<NonNullable<DriveState['busy']>, string> = {
  'signing-in': 'Signing in to Google…',
  opening: 'Opening a file from Drive…',
  saving: 'Saving to Drive…',
  listing: 'Reading your Drive…',
  'signing-out': 'Signing out…',
};

/** Why a control that needs Google Drive cannot run now — offline, or another action running — or null. */
export function driveUnavailable(d: DriveState): string | null {
  if (!d.online) return 'Offline';
  return d.busy !== null ? DRIVE_BUSY[d.busy] : null;
}

/** How long before a sign-in runs out the unsaved-changes row says so. */
export const DRIVE_EXPIRY_WARNING_MS = 2 * 60 * 1000;

/** How the "<name> closed" notice ends, whatever the name: it has a row of its own. */
const CLOSED_TAIL = DRIVE_MESSAGES.closed('');

/**
 * The row the strip shows for `d` (`dirty`: the model has changes the attached
 * file does not hold), or null for none.
 */
export function driveStripStatus(d: DriveState, dirty: boolean): DriveStripStatus | null {
  // Before a command replaces work nothing holds, the question is asked with
  // Google Drive or without it — and after a save in this browser, or an
  // export, kept typed text back, or an element went to the top level of the
  // model rather than into the standard library, the note says so with it or
  // without it. (An error notice carries the privacy page's link, which only
  // a configuration names.)
  if (d.prompt?.kind === 'guard') return 'guard';
  if (d.configStatus !== 'ready' || d.config === null) {
    if (d.link?.status === 'unsupported') return 'link-unsupported';
    return d.notice?.kind === 'info' ? 'info' : null;
  }
  if (d.prompt !== null) return d.prompt.kind;
  if (d.conflict !== null) return 'conflict';
  if (d.busy === 'saving' || d.busy === 'opening') return d.busy;
  if (d.notice !== null) {
    if (d.notice.kind === 'error') return 'error';
    return d.notice.message.endsWith(CLOSED_TAIL) ? 'closed' : 'info';
  }
  if (d.pending !== null) return 'expired';
  const file = d.file;
  if (file === null) return null;
  if (file.trashed) return 'gone';
  if (!file.canEdit) return 'readonly';
  if (dirty) return d.online ? 'dirty' : 'offline';
  return 'clean';
}

/** Whether a `?drive=` link holds the loading gate: until its file is open, or the user skips it. */
export function driveLinkHolds(link: DriveState['link']): boolean {
  return link !== null && link.status !== 'unsupported';
}

/**
 * The link a clipboard refused, shown in the strip to copy by hand — whichever
 * control asked for the copy, the strip's own or the panel's. Module-scoped,
 * like the checks' results: transient UI state, never the store's.
 */
const useLinkByHand = create<{ link: string | null }>(() => ({ link: null }));

/** Show `link` in the strip, read-only, to copy by hand (the clipboard refused it). */
export function showDriveLinkByHand(link: string): void {
  useLinkByHand.setState({ link });
}

/** One of the strip's buttons. `testid` is a literal at every call site (see the header). */
function StripButton({ testid, ...rest }: { testid: string } & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return <button type="button" data-testid={testid} {...rest} />;
}

/**
 * The time now — and a render again when a sign-in that ends at `expiresAt`
 * comes within {@link DRIVE_EXPIRY_WARNING_MS} of its end, and when it ends,
 * so the row's note follows the clock without a timer ticking all the time.
 */
function useExpiryClock(expiresAt: number | null): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (expiresAt === null) return;
    const at = Date.now();
    const warnAt = expiresAt - DRIVE_EXPIRY_WARNING_MS;
    const next = at < warnAt ? warnAt : at < expiresAt ? expiresAt : null;
    if (next === null) return;
    const timer = setTimeout(() => setTick((t) => t + 1), next - at + 50);
    return () => clearTimeout(timer);
  }, [expiresAt, tick]);
  return Date.now();
}

const store = () => useAppStore.getState();

export function DriveStrip(): JSX.Element | null {
  const drive = useAppStore((s) => s.drive);
  const dirty = useAppStore((s) => driveDirty(s));
  const link = useAppStore((s) => driveLink(s));
  const projectName = useAppStore((s) => s.projectName);
  // While the question about unsaved work stands: text typed in the Text view
  // that the parser cannot read is no model this browser can save. Read only
  // then — it parses the typed text, once per text.
  const typedFaulted = useAppStore(
    (s) => s.drive.prompt?.kind === 'guard' && s.drive.prompt.variant === 'browser' && s.textDirty && typedTextFaulted(),
  );
  const byHand = useLinkByHand((s) => s.link);
  const [copied, setCopied] = useState(false);
  // The name a save-as the strip started writes, for "Saving <name>…" — the
  // slice knows only that a save is running.
  const [savingAs, setSavingAs] = useState<string | null>(null);
  const now = useExpiryClock(dirty ? drive.expiresAt : null);
  // The link to copy by hand is selected and in focus as it appears, ready
  // for Ctrl/⌘+C — once, when the field mounts: it never takes the focus
  // back later, from wherever the user went since.
  const focusByHand = useCallback((field: HTMLInputElement | null) => {
    field?.focus();
    field?.select();
  }, []);

  useEffect(() => {
    if (drive.busy === null) setSavingAs(null);
  }, [drive.busy]);
  // Another file, or none: its link has not been copied, and a link left to
  // copy by hand is the other file's.
  useEffect(() => {
    setCopied(false);
    if (useLinkByHand.getState().link !== link) useLinkByHand.setState({ link: null });
  }, [link]);
  // The strip owns the link shown by hand: gone with it.
  useEffect(() => () => useLinkByHand.setState({ link: null }), []);
  const showByHand = byHand !== null && byHand === link;

  const status = driveStripStatus(drive, dirty);
  if (status === null) return null;

  /** Run a save-as and, once it is running, remember the name it writes. */
  const savingTo = (name: string, run: () => Promise<void>): void => {
    void run();
    if (store().drive.busy === 'saving') setSavingAs(driveFileName(name));
  };
  const copyLink = (): void =>
    void store()
      .driveCopyLink()
      .then(
        () => {
          setCopied(true);
          useLinkByHand.setState({ link: null });
        },
        () => {
          setCopied(false);
          if (link !== null) showDriveLinkByHand(link);
        },
      );

  const file = drive.file;
  const name = file?.name ?? 'this file';
  const blocked = driveUnavailable(drive);
  const dismiss = (
    <StripButton
      testid="drive-strip-dismiss"
      className="drive-strip-close"
      title="Hide this message"
      aria-label="Hide this message"
      onClick={() => store().driveDismiss()}
    >
      ×
    </StripButton>
  );
  const fileName = <code className="drive-strip-name">{name}</code>;

  let text: ReactNode = null;
  let actions: ReactNode = null;
  // The Save-as row is a form, with its own buttons, in place of the text.
  let form: ReactNode = null;
  switch (status) {
    case 'link-unsupported':
      text = DRIVE_MESSAGES.linkUnsupported;
      actions = dismiss;
      break;
    case 'saveas': {
      const prompt = drive.prompt as SaveAsPrompt;
      form = (
        <SaveAsForm
          key={`${prompt.suggested}|${String(prompt.asCopy)}`}
          prompt={prompt}
          drive={drive}
          onSave={(typed, asCopy) => savingTo(typed, () => store().driveSaveAs(typed, { asCopy }))}
        />
      );
      break;
    }
    case 'rewrite':
      text = (
        <>
          {fileName} was written by hand or by another tool. Sysprose writes files in its own layout and drops{' '}
          <code>//</code> comments. Save anyway? Drive keeps the previous version for about 30 days (Manage versions →
          Keep forever holds it longer).
        </>
      );
      actions = (
        <>
          <StripButton
            testid="drive-strip-rewrite-ok"
            disabled={blocked !== null}
            title={blocked ?? `Rewrite ${name} in this app's layout`}
            onClick={() => void store().driveAcknowledgeRewrite('save')}
          >
            Save anyway
          </StripButton>
          <StripButton
            testid="drive-strip-rewrite-copy"
            title={`Save the model to a new file and leave ${name} as it is`}
            onClick={() => void store().driveAcknowledgeRewrite('copy')}
          >
            Save as copy
          </StripButton>
          <StripButton
            testid="drive-strip-rewrite-cancel"
            title="Save nothing now"
            onClick={() => void store().driveAcknowledgeRewrite('cancel')}
          >
            Cancel
          </StripButton>
        </>
      );
      break;
    case 'guard': {
      const prompt = drive.prompt as Extract<DrivePrompt, { kind: 'guard' }>;
      const keep = (
        <StripButton
          testid="drive-guard-keep"
          title={`Cancel ${prompt.label} and keep editing this model`}
          onClick={() => void store().driveRunPending('keep')}
        >
          Keep editing
        </StripButton>
      );
      if (prompt.variant === 'browser') {
        // No Drive file holds the model: Save is the save in this browser.
        const cannotSave = typedFaulted
          ? 'The text typed in the Text view has a syntax error — fix it, or discard it'
          : null;
        // Joining a room drops nothing at once: the room's model merges over
        // this one, and may change or replace it.
        const joining = prompt.label === 'Join room';
        text = (
          <>
            <code className="drive-strip-name">{projectName || 'This model'}</code> has unsaved changes.
            {prompt.refused === true && ` ${DRIVE_MESSAGES.browserRefused}`}
          </>
        );
        actions = (
          <>
            <StripButton
              testid="guard-save"
              disabled={cannotSave !== null}
              title={cannotSave ?? `Save the project in this browser, then ${prompt.label}`}
              onClick={() => void store().driveRunPending('save')}
            >
              Save and continue
            </StripButton>
            <StripButton
              testid="guard-discard"
              title={
                joining
                  ? "Join the room without saving: the room's model may change or replace this one"
                  : `${prompt.label} without saving`
              }
              onClick={() => void store().driveRunPending('discard')}
            >
              {joining ? 'Join without saving' : 'Discard and continue'}
            </StripButton>
            <StripButton
              testid="guard-keep"
              title={`Cancel ${prompt.label} and keep editing this model`}
              onClick={() => void store().driveRunPending('keep')}
            >
              Keep editing
            </StripButton>
          </>
        );
        break;
      }
      if (prompt.variant === 'open') {
        text = 'Opening from Drive replaces the current model and clears Undo.';
        actions = (
          <>
            <StripButton
              testid="drive-guard-open-anyway"
              title="Open the file from Drive in place of this model"
              onClick={() => void store().driveRunPending('open-anyway')}
            >
              Open anyway
            </StripButton>
            {keep}
          </>
        );
        break;
      }
      const cannotSave =
        file === null
          ? 'No Drive file is open'
          : file.trashed
            ? `${name} is no longer in Drive`
            : !file.canEdit
              ? 'You have view access only'
              : blocked;
      text = <>{fileName} has unsaved changes to Drive.</>;
      actions = (
        <>
          <StripButton
            testid="drive-guard-save"
            disabled={cannotSave !== null}
            title={cannotSave ?? `Save to Drive first, then ${prompt.label}`}
            onClick={() => void store().driveRunPending('save')}
          >
            Save to Drive and continue
          </StripButton>
          <StripButton
            testid="drive-guard-discard"
            title={`${prompt.label} without saving to Drive`}
            onClick={() => void store().driveRunPending('discard')}
          >
            Discard and continue
          </StripButton>
          {keep}
        </>
      );
      break;
    }
    case 'conflict': {
      const remote = drive.conflict!.remote;
      text = driveConflictMessage(name, remote);
      actions = (
        <>
          <StripButton
            testid="drive-strip-copy-save"
            disabled={blocked !== null}
            title={blocked ?? `Save the model to a new file and leave ${name} as it is in Drive`}
            onClick={() => void store().driveResolveConflict('copy')}
          >
            Save as copy
          </StripButton>
          <StripButton
            testid="drive-strip-overwrite"
            disabled={blocked !== null}
            title={blocked ?? 'Write this model over the version in Drive — Drive keeps that one in Manage versions'}
            onClick={() => void store().driveResolveConflict('overwrite')}
          >
            Overwrite
          </StripButton>
          <StripButton
            testid="drive-strip-reload"
            disabled={blocked !== null}
            title={blocked ?? "Replace this model with Drive's version — Undo steps back to this one"}
            onClick={() => void store().driveResolveConflict('reload')}
          >
            Reload from Drive
          </StripButton>
        </>
      );
      break;
    }
    case 'saving':
      text =
        savingAs !== null || file !== null ? (
          <>
            Saving <code className="drive-strip-name">{savingAs ?? name}</code>…
          </>
        ) : (
          'Saving to Google Drive…'
        );
      break;
    case 'opening':
      text =
        drive.opening !== null ? (
          <>
            Opening <code className="drive-strip-name">{drive.opening}</code>…
          </>
        ) : (
          'Opening a file from Google Drive…'
        );
      break;
    case 'error': {
      const notice = drive.notice!;
      const retry = notice.retry;
      text = notice.message;
      actions = (
        <>
          {notice.retryable && (
            <StripButton
              testid="drive-strip-retry"
              disabled={blocked !== null}
              title={blocked ?? 'Try the same action again'}
              onClick={() => {
                if (retry?.op === 'save-as') savingTo(retry.arg, () => store().driveRetry());
                else void store().driveRetry();
              }}
            >
              Try again
            </StripButton>
          )}
          <a
            data-testid="drive-strip-privacy"
            className="drive-strip-link"
            href={drive.config!.privacyUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Privacy &amp; data ↗
          </a>
          {dismiss}
        </>
      );
      break;
    }
    case 'closed':
    case 'info':
      text = drive.notice!.message;
      actions = dismiss;
      break;
    case 'expired': {
      const pending = drive.pending!;
      text = 'Your Google sign-in expired.';
      actions = (
        <StripButton
          testid="drive-strip-signin"
          disabled={blocked !== null}
          title={blocked ?? 'Sign in to Google again, then finish what was interrupted'}
          onClick={() => {
            if (pending.op === 'save-as') savingTo(pending.arg, () => store().driveResume());
            else void store().driveResume();
          }}
        >
          Sign in and continue
        </StripButton>
      );
      break;
    }
    case 'gone':
      text = DRIVE_MESSAGES.goneOnOpen(name);
      actions = (
        <StripButton
          testid="drive-strip-save-as"
          title="Write the model to a new .sysml file in My Drive"
          onClick={() => void store().driveSaveAs()}
        >
          Save to Drive as…
        </StripButton>
      );
      break;
    case 'readonly':
      text = (
        <>
          {fileName} · you have view access{dirty ? ' · unsaved changes' : ''}
        </>
      );
      actions = (
        <StripButton
          testid="drive-strip-save-as"
          title="Save your own copy of the model in My Drive"
          onClick={() => void store().driveSaveAs(undefined, { asCopy: true })}
        >
          Save to Drive as…
        </StripButton>
      );
      break;
    case 'offline':
      text = (
        <>
          Offline — {fileName} has unsaved changes. They stay in this tab; <strong>Save</strong> keeps them in this
          browser; Save to Drive will work when you are back online.
        </>
      );
      actions = (
        <StripButton
          testid="drive-strip-save-local"
          title="Save the project in this browser"
          // The unsaved changes this row promises to keep are often text
          // typed in the Text view and not applied: not the model yet. It is
          // applied first, as Save and Ctrl/Cmd+S do, so the browser save
          // holds what is on screen — unless it has a parse error, when the
          // strip says the typed text was kept back — and a browser that
          // refuses the save is said so here.
          onClick={() => void store().driveSaveLocal()}
        >
          Save
        </StripButton>
      );
      break;
    case 'dirty': {
      const expiresAt = drive.expiresAt;
      const expiry =
        expiresAt === null || now < expiresAt - DRIVE_EXPIRY_WARNING_MS
          ? ''
          : now < expiresAt
            ? ' · sign-in expires soon'
            : ' · sign-in expired';
      text = (
        <>
          {fileName} · unsaved changes{expiry}
        </>
      );
      actions = (
        <StripButton
          testid="drive-strip-save"
          disabled={blocked !== null}
          title={blocked ?? `Save the model to ${name} in Google Drive (Ctrl+Shift+S)`}
          onClick={() => void store().driveSave()}
        >
          Save to Drive
        </StripButton>
      );
      break;
    }
    case 'clean': {
      const webLink = driveWebViewLink(file!.webViewLink);
      text = (
        <>
          {fileName} · saved to your Google Drive at {driveTime(file!.modifiedTime)}
        </>
      );
      actions = (
        <>
          {webLink !== null && (
            <StripButton
              testid="drive-strip-open-in-drive"
              title="Drive's own page for this file: sharing, versions, download"
              onClick={() => window.open(webLink, '_blank', 'noopener,noreferrer')}
            >
              Open in Drive ↗
            </StripButton>
          )}
          <StripButton testid="drive-strip-copy" data-link={link ?? ''} title={link ?? undefined} onClick={copyLink}>
            {copied ? 'Link copied' : 'Copy link'}
          </StripButton>
        </>
      );
      break;
    }
  }

  const alert = status === 'conflict' || status === 'error' || status === 'guard';
  const tone = status === 'conflict' ? ' drive-strip-conflict' : status === 'error' ? ' drive-strip-error' : '';
  // A link the clipboard refused stays beside whatever row is showing — a
  // copy asked for during a save, an error or a question is not lost — in
  // one place in the strip, so a row changing around it leaves it where it
  // is, focus and all.
  return (
    <div
      className={`drive-strip${tone}`}
      data-testid="drive-strip"
      data-status={status}
      role={alert ? 'alert' : 'status'}
    >
      {form ?? <span className="drive-strip-text">{text}</span>}
      {showByHand && (
        <input
          ref={focusByHand}
          data-testid="drive-link-text"
          className="drive-input drive-strip-link-text"
          readOnly
          value={byHand ?? ''}
          aria-label="The link to this file, to copy"
          title="Your browser did not let Sysprose copy the link: copy it from here"
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => useLinkByHand.setState({ link: null })}
        />
      )}
      {actions !== null && <span className="drive-strip-actions">{actions}</span>}
    </div>
  );
}

type SaveAsPrompt = Extract<DrivePrompt, { kind: 'saveas' }>;

/**
 * The Save-as form: a name, prefilled, then Save or Cancel. Signed out, its
 * Save is the sign-in — so, like every sign-in control, it waits for Google's
 * script, disabled and saying so, and then opens the sign-in window inside
 * its own click.
 */
function SaveAsForm({
  prompt,
  drive,
  onSave,
}: {
  prompt: SaveAsPrompt;
  drive: DriveState;
  onSave: (name: string, asCopy: boolean) => void;
}): JSX.Element {
  const [name, setName] = useState(prompt.suggested);
  const inputRef = useRef<HTMLInputElement>(null);
  // The form opens to type a name in: in focus, the suggestion selected.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const signedOut = drive.account === null;
  let label = signedOut ? 'Sign in and save' : 'Save';
  let reason: string | null;
  if (signedOut && !drive.authReady) {
    // An error while signed out and without the script: the script did not load.
    const failed = drive.notice?.kind === 'error' ? drive.notice.message : null;
    label = failed !== null ? 'Google sign-in did not load' : 'Loading Google sign-in…';
    reason = failed ?? 'Loading Google sign-in…';
  } else {
    reason = driveUnavailable(drive) ?? (name.trim() === '' ? 'Type a name for the file' : null);
  }
  const save = (): void => {
    if (reason === null) onSave(name, prompt.asCopy);
  };

  return (
    <form
      className="drive-strip-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="drive-strip-text drive-strip-field">
        <span>{prompt.asCopy ? 'Save a copy to Google Drive as' : 'Save to Google Drive as'}</span>
        <input
          ref={inputRef}
          data-testid="drive-saveas-name"
          className="drive-input"
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') store().driveDismiss();
          }}
        />
      </label>
      <span className="drive-strip-actions">
        <StripButton
          testid="drive-saveas-confirm"
          type="submit"
          disabled={reason !== null}
          title={
            reason ??
            (signedOut
              ? 'Sign in to Google, then write the model to a new .sysml file in My Drive'
              : 'Write the model to a new .sysml file in My Drive')
          }
        >
          {label}
        </StripButton>
        <StripButton testid="drive-saveas-cancel" title="Save nothing" onClick={() => store().driveDismiss()}>
          Cancel
        </StripButton>
      </span>
    </form>
  );
}

/**
 * The loading gate's body while a `?drive=` link waits for its file: sign in
 * and open it, or skip to the sample model; Drive's refusal to open a file not
 * yet granted to this app, with the one way to grant it — Google's Picker on
 * that one file, where the site has a Picker; where it has none, the gate says
 * so — the field for its Drive link (which carries the resource key an older
 * link-shared file needs) and the account it refused; any other failure, with
 * Try again and — as beside every error in the strip — the privacy page.
 *
 * Signing in needs a click, so the gate asks for exactly one. Google's script
 * started loading the moment the deployment's configuration was read; until
 * it is there, Sign in and open is disabled and says so, so its click finds
 * the script and opens the sign-in window inside itself.
 */
export function DriveLinkGate(): JSX.Element | null {
  const drive = useAppStore((s) => s.drive);
  const [pasted, setPasted] = useState('');
  const link = drive.link;
  if (link === null || !driveLinkHolds(link)) return null;

  const blocked = driveUnavailable(drive);
  const hasPicker = drive.config?.apiKey !== undefined && drive.config?.appId !== undefined;
  const pastedRef = parseDriveFileRef(pasted);
  const openPasted = (): void => {
    if (pastedRef === null || blocked !== null) return;
    void store().driveOpen(pastedRef, 'link');
  };
  const skip = (
    <button data-testid="drive-link-skip" title="Open the sample model instead" onClick={() => store().driveLinkSkip()}>
      Skip
    </button>
  );

  let body: ReactNode;
  if (!drive.online && link.status !== 'opening') {
    body = (
      <>
        <p className="app-loading-msg">{DRIVE_MESSAGES.linkOffline}</p>
        <div className="drive-gate-actions">{skip}</div>
      </>
    );
  } else if (link.status === 'opening') {
    body = <p className="app-loading-msg">Opening the file from Google Drive…</p>;
  } else if (link.status === 'denied') {
    const email = drive.account?.email ?? null;
    body = (
      <>
        <div data-testid="drive-link-denied" className="drive-gate-denied">
          <p className="app-loading-msg">
            {hasPicker
              ? 'Google Drive did not let Sysprose open this file. If it was shared with you, choose it once:'
              : "Google Drive did not let Sysprose open this file. A file shared with you opens here only once it has been chosen in Google's file picker, on a site that offers it — this one does not."}
          </p>
          {drive.account !== null && (
            // A common cause: the account chooser picked another of the
            // user's accounts — a personal one for the school one. Which one
            // is signed in, and the way to the other.
            <p className="drive-gate-note">
              {email !== null && (
                <>
                  Signed in as <strong>{email}</strong>.{' '}
                </>
              )}
              Shared with another of your Google accounts? Skip, choose Sign out under Drive ▾, then open this link
              again.
            </p>
          )}
          {hasPicker && (
            <button
              data-testid="drive-link-browse"
              disabled={blocked !== null}
              title={blocked ?? "Choose this file in Google's picker — that lets Sysprose open it"}
              onClick={() => void store().driveBrowse([link.ref.id])}
            >
              Browse Drive…
            </button>
          )}
          <div className="drive-paste">
            <input
              data-testid="drive-link-id"
              className="drive-input"
              value={pasted}
              placeholder="Paste the file's Drive link"
              aria-label="Paste the file's Drive link"
              spellCheck={false}
              onChange={(e) => setPasted(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') openPasted();
              }}
            />
            <button
              data-testid="drive-link-id-go"
              disabled={pastedRef === null || blocked !== null}
              title={pastedRef === null ? 'Paste a Google Drive share link or a file id' : (blocked ?? 'Open this file')}
              onClick={openPasted}
            >
              Open
            </button>
          </div>
        </div>
        <div className="drive-gate-actions">{skip}</div>
      </>
    );
  } else if (link.status === 'failed') {
    body = (
      <>
        <p className="app-loading-msg">{link.error ?? DRIVE_MESSAGES.badAnswer(0)}</p>
        <div className="drive-gate-actions">
          <button
            data-testid="drive-link-retry"
            disabled={blocked !== null}
            title={blocked ?? 'Try to open the file again'}
            onClick={() => void store().driveLinkRetry()}
          >
            Try again
          </button>
          {skip}
        </div>
        {drive.config !== null && (
          // As beside every error in the strip: a sign-in Google blocked —
          // a school account, an app still in testing — reads "cancelled or
          // blocked" here, and the page that names the client ID for an
          // administrator is the way on. Nothing else is on screen to reach
          // it from while the gate holds.
          <a
            data-testid="drive-link-privacy"
            className="drive-strip-link"
            href={drive.config.privacyUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Privacy &amp; data ↗
          </a>
        )}
      </>
    );
  } else {
    // Pending: waiting for the one click a sign-in needs — or, signed in
    // already (a sign-out cut an open short, and the user signed in again),
    // just the click to open.
    const signIn = !drive.authReady
      ? { label: 'Loading Google sign-in…', title: 'Loading Google sign-in…' }
      : drive.account === null
        ? { label: 'Sign in and open', title: blocked ?? 'Choose your Google account, then open the file' }
        : { label: 'Open', title: blocked ?? 'Open the file from Google Drive' };
    body = (
      <>
        <p className="app-loading-msg">This link opens a file from Google Drive.</p>
        <div className="drive-gate-actions">
          <button
            data-testid="drive-link-signin"
            disabled={!drive.authReady || blocked !== null}
            title={signIn.title}
            onClick={() => void store().driveOpen(link.ref, 'link')}
          >
            {signIn.label}
          </button>
          {skip}
        </div>
      </>
    );
  }

  return (
    <div className="drive-gate" data-testid="drive-link-gate" data-status={link.status}>
      {body}
    </div>
  );
}

export default DriveStrip;
