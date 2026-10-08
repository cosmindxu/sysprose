/**
 * Google Drive (optional) — the store's half of the feature: the `drive` slice
 * of {@link AppState}, the actions that open and save a model's text in the
 * user's own Google Drive, and the selectors the UI reads off them.
 *
 * WHAT IS WRITTEN is the Text view's text — `withFinalNewline(textBuffer)`, the
 * canonical serialization of the USER roots — never `exportModel(model,
 * 'sysml')`, which serializes every root, the merged standard library
 * included. Saving is explicit; the browser's own project store is untouched
 * and stays the local draft.
 *
 * A SIGN-IN NEEDS THE CLICK. A browser opens a popup only inside a user
 * gesture, so every action that may need a token calls `ensureSession` as its
 * first statement, before anything is awaited: when the hour-long token has
 * run out, the sign-in popup opens inside that very click. Only a 401 that
 * comes back later (a token revoked elsewhere, a skewed clock) has to sign in
 * after an await — and when the browser refuses that popup, the action is
 * parked in `drive.pending`, for the strip's "Sign in and continue": a fresh
 * click.
 *
 * NOTHING TOKEN-LIKE IS HERE. The token lives in the {@link DriveAuth}
 * implementation's closure, which hands it out per request; this module keeps
 * at most a note that Google refused the current one.
 *
 * This module imports only TYPES from `./store`: the store imports it, and the
 * store-side helpers it needs (opening a text, waiting for the library, the
 * recompute flush, the applied text) are handed in to
 * {@link createDriveActions} — so the two modules never wait on each other
 * while loading.
 */
import type { StoreApi } from 'zustand';
import {
  DRIVE_UPLOAD_MAX_BYTES,
  DriveAuthError,
  DriveBadResponseError,
  DriveError,
  DriveForbiddenError,
  DriveNetworkError,
  DriveNotFoundError,
  DriveRateLimitError,
  createGisPopupAuth,
  createGooglePicker,
  createRestDriveGateway,
  detectFormat,
  driveDeepLink,
  driveErrorMessage,
  type DriveAccount,
  type DriveAuth,
  type DriveConfig,
  type DriveFileMeta,
  type DriveFileRef,
  type DriveGateway,
  type DrivePicker,
  type DriveSession,
  type ModelFormat,
} from '@persistence/index';
import type { AppState } from './store';

/* ─────────────────────────────── The slice ──────────────────────────────── */

/** Where an attached Drive file came from. */
export type DriveOpenedFrom = 'link' | 'recent' | 'picker' | 'save-as' | 'paste';

/**
 * The Drive file this model is attached to: Drive's metadata, plus what the
 * app needs to tell an edit from a save.
 *
 * Two of Drive's fields double as the strip's state: `trashed` is also set
 * when a save found the file gone (deleted, or no longer shared: a 404), and
 * `canEdit` is cleared when a save found the user has view access only.
 */
export interface DriveFile extends DriveFileMeta {
  /**
   * The text last written to Drive — or, after an open, the Text view's text
   * once the library settled — with exactly one final newline. "Unsaved
   * changes" is the Text view's text differing from this. When the model
   * changed while the file was still opening, it is the text as fetched, so
   * the change reads unsaved.
   */
  savedText: string;
  /**
   * A save would rewrite the file in this app's layout: its text as fetched
   * was not that layout (hand-written, or another tool's) — or that could not
   * be told, because a syntax error kept the app from laying it out, or the
   * model changed before it had. The first save asks.
   */
  rewrites: boolean;
  /** The user said "Save anyway" to rewriting it in this app's layout. */
  rewriteAcknowledged: boolean;
  openedFrom: DriveOpenedFrom;
}

/**
 * An action the store can run again: after a sign-in it could not finish on
 * its own (`pending`), or on a notice's Retry. `arg` is the file id of an
 * open and the file name of a save-as.
 */
export type DrivePendingOp =
  | { op: 'save'; overwrite?: boolean }
  | { op: 'save-as'; arg: string; asCopy: boolean }
  | { op: 'open'; arg: string; ref: DriveFileRef; from: DriveOpenedFrom; reload?: boolean };

/** A message for the strip: an `error` (red, with the privacy link) or an `info` (`<name> closed`, a JSON open). */
export interface DriveNotice {
  kind: 'error' | 'info';
  message: string;
  /** Whether Retry may run {@link retry} again. */
  retryable: boolean;
  /** What Retry runs: present exactly when `retryable` is true. */
  retry?: DrivePendingOp;
}

/**
 * A question the strip is asking: the Save-as form (`asCopy` for a copy of
 * the attached file), whether to rewrite a hand-written file, or — before a
 * command replaces the model — what to do with unsaved Drive changes
 * (`dirty`) or with edited work no Drive file holds (`open`).
 */
export type DrivePrompt =
  | { kind: 'saveas'; suggested: string; asCopy: boolean }
  | { kind: 'rewrite' }
  | { kind: 'guard'; label: string; variant: 'dirty' | 'open' };

/**
 * The Drive slice. Nothing token-like ever lives here; the store holds what
 * the UI shows, never a credential.
 *
 * What the strip shows follows from it: a `prompt` first; then a `conflict`;
 * a `busy` action; a `notice`; `pending` (the sign-in expired, "Sign in and
 * continue"); then, for the attached `file`, `trashed` (gone), `!canEdit`
 * (view access only), offline with unsaved changes, unsaved changes, saved.
 */
export interface DriveState {
  /**
   * `loading` while `./drive.json` is fetched at boot, `ready` once it named a
   * client, `absent` otherwise — and always under unit tests, where the boot
   * does not run.
   */
  configStatus: 'loading' | 'ready' | 'absent';
  config: DriveConfig | null;
  /** `navigator.onLine`, kept current by the boot's online/offline listeners. */
  online: boolean;
  /** Who is signed in — null when signed out; an unknown email and name read "Signed in to Google". */
  account: DriveAccount | null;
  /** When the current sign-in runs out (ms since the epoch), for the "expires soon" hint. */
  expiresAt: number | null;
  /** Google's sign-in script is loaded (the "Loading Google sign-in…" labels wait for it). */
  authReady: boolean;
  /** The Drive file the model is attached to, or null. */
  file: DriveFile | null;
  /** The Drive action in progress; another waits for it to end. */
  busy: 'signing-in' | 'opening' | 'saving' | 'listing' | 'signing-out' | null;
  /** While a file opens: its name, once known (the Recent list's, or Drive's answer) — "Opening <name>…". */
  opening: string | null;
  /** The files this app can see, newest first — null until listed. */
  recent: DriveFileMeta[] | null;
  /** The file changed in Drive since it was opened or saved here: what is there now. */
  conflict: { remote: DriveFileMeta } | null;
  prompt: DrivePrompt | null;
  /** An action waiting for a sign-in only a fresh click can open (the strip's "Sign in and continue"). */
  pending: DrivePendingOp | null;
  notice: DriveNotice | null;
  /**
   * The file a `?drive=` link names. Set SYNCHRONOUSLY at boot, before the
   * first render, so the App's loading gate holds while it is `pending` or
   * `opening`; `unsupported` once the deployment turned out to have no
   * configuration, which drops the gate to the sample; `denied` when Drive
   * answered 404 (not granted to this app yet — the Picker grants it);
   * `failed`, with `error`, on any other failure — Google's sign-in script
   * not loading included; back to `pending` when a sign-out cut the open
   * short. Cleared once the file is open, or the user skips it.
   */
  link: {
    ref: DriveFileRef;
    status: 'pending' | 'opening' | 'denied' | 'failed' | 'unsupported';
    error?: string;
  } | null;
}

/** The Drive slice before the boot has run — and what unit tests reset it to. */
export const initialDriveState: DriveState = {
  configStatus: 'absent',
  config: null,
  online: true,
  account: null,
  expiresAt: null,
  authReady: false,
  file: null,
  busy: null,
  opening: null,
  recent: null,
  conflict: null,
  prompt: null,
  pending: null,
  notice: null,
  link: null,
};

/** The Drive commands on {@link AppState}. Every one is a no-op on a deployment without Drive. */
export interface DriveActions {
  /**
   * Start loading Google's sign-in script (once) and set `authReady` when it
   * is usable. Called when the Drive panel opens and when a `?drive=` link is
   * pending, so the later sign-in click finds the script there and opens its
   * popup inside that click.
   */
  drivePrepare(): Promise<void>;
  /** Sign in with Google's account chooser, then read who it is and the Recent list. */
  driveSignIn(): Promise<void>;
  /**
   * Revoke the app's access at Google and forget the session, the Recent list
   * and the attached file. An expired sign-in is renewed first, inside the
   * click (revoking needs a token Google still accepts); when that renewal is
   * refused nothing is revoked, and a notice says so.
   */
  driveSignOut(): Promise<void>;
  /**
   * Save the model to the attached file (with no file attached, open the
   * Save-as form). The first save of a file not written in this app's layout
   * asks first. `alsoInBrowser` also saves the project in this browser,
   * whatever becomes of the Drive save: when the Drive save goes ahead, after
   * the typed text is applied, so both hold the same model; when it does not
   * (no file attached, offline, a question standing), at once, as Save does
   * without Drive.
   */
  driveSave(opts?: { alsoInBrowser?: boolean }): Promise<void>;
  /**
   * The offline row's Save: the project in this browser, and an error notice
   * when the browser refuses it. Text typed in the Text view is applied first,
   * so the save holds what is on screen — unless the text has a parse error,
   * whose recovery would not be; then the model is saved as it stands.
   */
  driveSaveLocal(): Promise<void>;
  /**
   * Without `name`, open the Save-as form; with it, write the model to a new
   * file of that name in the root of My Drive and attach it. `asCopy` marks a
   * copy of the attached file (the form suggests `<name> (copy).sysml`).
   */
  driveSaveAs(name?: string, opts?: { asCopy?: boolean }): Promise<void>;
  /** Open a Drive file in place of the model: Undo starts over from it. */
  driveOpen(ref: DriveFileRef, from: DriveOpenedFrom): Promise<void>;
  /** Google's Picker — to browse, or on `fileIds` alone (a link Drive denied) — then open the file chosen. */
  driveBrowse(fileIds?: string[]): Promise<void>;
  /** Re-read the Recent list. */
  driveRefreshRecent(): Promise<void>;
  /**
   * Let go of the attached file (the model stays). Every command that
   * replaces the model calls this, so a save can never write a different
   * model into the file.
   */
  driveDetach(): void;
  /** Answer a conflict: write over Drive's version, save a copy, or take Drive's version (one Undo step back). */
  driveResolveConflict(how: 'overwrite' | 'copy' | 'reload'): Promise<void>;
  /** Answer "rewrite this hand-written file?": save anyway, save a copy instead, or not now. */
  driveAcknowledgeRewrite(how: 'save' | 'copy' | 'cancel'): Promise<void>;
  /**
   * Run `run` — a command that replaces the model — unless that would lose
   * something: unsaved Drive changes (any variant), or, for a Drive open
   * (`open`), edited work no Drive file holds. Then the strip asks first, and
   * {@link driveRunPending} carries out the answer.
   */
  driveGuard(label: string, variant: 'dirty' | 'open', run: () => void | Promise<void>): void;
  /** Answer the guard: save first, discard, keep editing, or open anyway. */
  driveRunPending(how: 'save' | 'discard' | 'keep' | 'open-anyway'): Promise<void>;
  /** "Sign in and continue": sign in (this click opens the window) and run the pending action. */
  driveResume(): Promise<void>;
  /** Run the action a retryable notice names again. */
  driveRetry(): Promise<void>;
  /**
   * The link gate's "Try again": load Google's sign-in script again when that
   * is what failed (the gate then offers its sign-in once more), else open
   * the linked file again.
   */
  driveLinkRetry(): Promise<void>;
  /** Copy the attached file's deep link; rejects when there is none or the clipboard refused it. */
  driveCopyLink(): Promise<string>;
  /** Close what the strip shows: a notice, the Save-as form, the "no Drive here" note of a link. */
  driveDismiss(): void;
  /** Leave a `?drive=` link unopened: the gate drops to the sample model. */
  driveLinkSkip(): void;
}

/* ──────────────────────────── Text and names ─────────────────────────────── */

/** Where the run of newlines that ends `text` starts (`text.length` when there is none). */
function trailingNewlinesAt(text: string): number {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end--;
  return end;
}

/** `text` ending in exactly one newline: the form saved to Drive and compared against it. */
export function withFinalNewline(text: string): string {
  const end = trailingNewlinesAt(text);
  return end === text.length - 1 ? text : `${text.slice(0, end)}\n`;
}

/**
 * Whether `text`, given exactly one final newline, is `saved` (which has
 * one) — without building that text: the dirty selector runs on every store
 * update, over a buffer that may be megabytes long.
 */
function equalsWithFinalNewline(text: string, saved: string): boolean {
  const end = trailingNewlinesAt(text);
  if (saved.length !== end + 1 || saved.charCodeAt(end) !== 10) return false;
  return saved.startsWith(end === text.length ? text : text.slice(0, end));
}

/**
 * Text as an editor saving it would leave it: LF line endings, no trailing
 * blanks, one final newline. A fetched file whose normalized text is not the
 * app's own layout was written by hand or by another tool.
 */
export function normalizeDriveText(text: string): string {
  return withFinalNewline(text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, ''));
}

/** The size of `text` in UTF-8, as an upload carries it. */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** The longest name a Drive file is given here. */
const DRIVE_NAME_MAX = 200;
const SYSML = '.sysml';

/**
 * A Drive file name from what the user typed: path separators and control
 * characters dropped, `.sysml` appended when missing, at most 200 characters
 * (cut between characters, never inside one). An empty name is `model.sysml`.
 */
export function driveFileName(input: string): string {
  let base = input.replace(/[/\\\u0000-\u001f\u007f]/g, '').trim();
  if (base.toLowerCase().endsWith(SYSML)) base = base.slice(0, -SYSML.length);
  if (base.trim() === '') base = 'model';
  const room = DRIVE_NAME_MAX - SYSML.length;
  if (base.length > room) {
    // Whole characters only: a pair of surrogates is kept or dropped together.
    let cut = 0;
    for (const ch of base) {
      if (cut + ch.length > room) break;
      cut += ch.length;
    }
    base = base.slice(0, cut);
  }
  return `${base}${SYSML}`;
}

/** `<name> (copy).sysml` for the copy of a file named `name`. */
function copyName(name: string): string {
  const base = name.toLowerCase().endsWith(SYSML) ? name.slice(0, -SYSML.length) : name;
  return driveFileName(`${base} (copy)`);
}

/**
 * `file` with Drive's fresh metadata IN PLACE of the old: a field the fresh
 * answer leaves out is gone, never the old value — a stale content hash would
 * make the next save's check see a change nobody made. The one exception is
 * the resource key, which Drive reports only for some files: one the file was
 * opened with (a pasted share link's) is kept.
 */
function withMeta(file: DriveFile, meta: DriveFileMeta): DriveFile {
  const { savedText, rewrites, rewriteAcknowledged, openedFrom } = file;
  const resourceKey = meta.resourceKey ?? file.resourceKey;
  return {
    ...meta,
    ...(resourceKey !== undefined ? { resourceKey } : {}),
    savedText,
    rewrites,
    rewriteAcknowledged,
    openedFrom,
  };
}

/**
 * Whether a file whose text was `fetched` is written in another layout than
 * this app's `canonical` one. Both sides are normalized: the app's own text
 * keeps trailing blanks inside a `doc` or comment body, which an editor
 * would not.
 */
function laidOutElsewhere(fetched: string, canonical: string): boolean {
  return normalizeDriveText(fetched) !== normalizeDriveText(canonical);
}

/** The reference requests about `file` carry: its id, and its resource key when it has one. */
function refOf(file: DriveFileMeta): DriveFileRef {
  return file.resourceKey !== undefined ? { id: file.id, resourceKey: file.resourceKey } : { id: file.id };
}

/* ─────────────────────────────── Selectors ───────────────────────────────── */

/**
 * The model has changes the attached Drive file does not hold. Derived, never
 * stored: the Text view's text against the text last saved, so undoing back
 * to the saved state reads as saved again. Not `textDirty` — a file opened
 * with a syntax error keeps its text as typed and reads `textDirty`, yet
 * equals what Drive holds — and not `rev`, which moves when the library
 * settles after every open. A model the serializer refuses cannot be what
 * Drive holds.
 */
export function driveDirty(s: Pick<AppState, 'drive' | 'textBuffer' | 'serializeError'>): boolean {
  const file = s.drive.file;
  return file !== null && (s.serializeError !== null || !equalsWithFinalNewline(s.textBuffer, file.savedText));
}

/**
 * The link that reopens the attached file in this app — this page with
 * `?drive=<id>`, and `&resourcekey=<key>` when the file has one — or null
 * when no file is attached.
 */
export function driveLink(s: Pick<AppState, 'drive'>, pageHref?: string): string | null {
  const file = s.drive.file;
  if (file === null) return null;
  const href = pageHref ?? (typeof window !== 'undefined' ? window.location.href : undefined);
  return href === undefined ? null : driveDeepLink(refOf(file), href);
}

/** The file name the Check panel's terminal commands name: the attached Drive file's, else the project's. */
export function checkFileName(s: { drive: { file: { name: string } | null }; projectName: string }): string {
  return s.drive.file?.name ?? `${s.projectName || 'model'}.sysml`;
}

/** The attached file as `window.sysprose.drive.file()` shows it: Drive's metadata and where it came from. */
export function driveFileView(file: DriveFile | null): (DriveFileMeta & { openedFrom: DriveOpenedFrom; rewrites: boolean }) | null {
  if (file === null) return null;
  const { savedText: _saved, rewriteAcknowledged: _ack, ...view } = file;
  return view;
}

/**
 * The page's `beforeunload` handler: asks before leaving exactly while the
 * attached file has unsaved changes. Returns whether it asked.
 */
export function driveBeforeUnload(
  s: Pick<AppState, 'drive' | 'textBuffer' | 'serializeError'>,
  e: Event,
): boolean {
  if (!driveDirty(s)) return false;
  e.preventDefault();
  // Older browsers read the prompt from `returnValue`; any value asks.
  (e as BeforeUnloadEvent).returnValue = '';
  return true;
}

/* ──────────────────────────────── Messages ───────────────────────────────── */

/** "this file" when a message has no name to give. */
const named = (name: string | undefined): string => name ?? 'this file';

/** `hh:mm` of an ISO time, in the user's own clock; the text itself when it is not a time. */
export function driveTime(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime())
    ? iso
    : time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Every sentence the Drive feature says to the user, in one place. None of
 * them is built from a server's answer: a name is the file's own, a status is
 * a number.
 */
export const DRIVE_MESSAGES = {
  signInCancelled:
    'Sign-in was cancelled or blocked. If Google showed an "Access blocked" page, your organisation\'s administrator has to allow this app — Privacy & data explains how and names the app\'s client ID.',
  accessDenied: 'You did not grant Sysprose access to Google Drive. Nothing was saved.',
  popupBlocked: 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.',
  scriptFailed:
    "Could not load Google's sign-in script. Check your network or a blocking extension, then reopen Drive ▾.",
  scriptFailedOnLink:
    "Could not load Google's sign-in script. Check your network or a blocking extension, then try again.",
  offline:
    'You appear to be offline. Your edits stay in this tab; Save keeps them in this browser, and Save to Drive will work when you are back online.',
  signInAgain: 'Google Drive no longer accepts this sign-in. Sign in again to continue — your model is unchanged.',
  readOnly: (name?: string) =>
    `Google Drive did not let Sysprose change ${named(name)} — you may have view-only access. Save to Drive as… keeps your own copy.`,
  refused: (status: number) => `Google Drive refused this (HTTP ${status}). Nothing was changed.`,
  driveFull: 'Your Google Drive is full, so nothing was saved. Make room in Drive, then save again.',
  openRefused: 'Google Drive did not let Sysprose open this file. Nothing was changed.',
  rateLimited: 'Google Drive is busy (rate limit). Try again in a minute.',
  notFoundOnOpen:
    'Google Drive did not let Sysprose open this file. If it was shared with you, choose it once with Browse Drive… or paste its Drive link; after that the link works. If you own it, it may have been deleted.',
  goneOnOpen: (name?: string) =>
    `${named(name)} is no longer in Drive (deleted or unshared). Your model is still here.`,
  gone: (name?: string) =>
    `${named(name)} is no longer in Drive (deleted or unshared). Your model is still here — Save to Drive as… writes a new file.`,
  badAnswer: (status: number) =>
    `Google Drive did not answer properly${status > 0 ? ` (HTTP ${status})` : ''}. Nothing was changed; try again.`,
  notText: 'That file is not a text file.',
  tooLargeToOpen: (name?: string) => `${named(name)} is larger than Sysprose opens (20 MB). Nothing was changed.`,
  downloadTimeout: 'Google Drive did not answer within 30 s. Try again.',
  uploadTimeout:
    'Google Drive did not confirm the save within 60 s. Save again — if Drive did receive it, you will be asked which version to keep.',
  saveUncertain:
    'Google Drive did not confirm the save. Save again — if Drive did receive it, you will be asked which version to keep.',
  createTimeout:
    'Google Drive did not confirm the save within 60 s. Look in Recent before saving again — Drive may have received it.',
  createUncertain:
    'Google Drive did not confirm that it created the file. Look in Recent before saving again — Drive may have received it.',
  cannotSerialize:
    'The model cannot be written as text yet — the Problems panel names the element. Nothing was saved to Drive.',
  tooLarge:
    'This model is larger than 5 MB as text; Google Drive accepts at most 5 MB in one upload from Sysprose. Export the text and upload it in Drive yourself.',
  unknownFormat: (name?: string) =>
    `${named(name)} is not a .sysml or model JSON file Sysprose can open. Nothing was changed.`,
  pickerFailed: "Google's file picker did not open. Paste the file's Drive link instead.",
  openedJson: (name: string) =>
    `Opened ${name} from Drive as JSON. Save to Drive as… writes it as a .sysml file.`,
  openStopped: (name: string) =>
    `${name} was not opened: the model changed while it downloaded. Your model is as you left it.`,
  openNotAttached: (name: string) =>
    `${name} opened, but the model changed before it was ready, so it is not attached to Drive. Save to Drive as… writes this model to a new file.`,
  closed: (name: string) => `${name} closed. Save to Drive as… writes a new file.`,
  inRoom:
    "Leave the collaboration room to open or save a file in Google Drive: in a room, the room's peers change this model too.",
  browserSaveFailed:
    'The copy in this browser was not saved: the browser refused to store the project (its storage may be full, or blocked for this site).',
  otherAccount: (now: string, before: string) =>
    `Google's sign-in window came back signed in as ${now}, not ${before}, so nothing was done: the Drive file is closed and the Recent list cleared. To go on as ${before}, sign out under Drive ▾ and sign in again.`,
  linkUnsupported: 'This link names a Google Drive file, but this deployment has no Google Drive support.',
  linkOffline: 'You are offline; this link needs Google Drive.',
  revokeUnconfirmed:
    'Signed out here, but Google did not confirm the revocation. You can remove Sysprose under Google Account › Security › Third-party access.',
  nothingRevoked:
    'Signed out here. Nothing was revoked: your Google sign-in had already expired. Remove Sysprose under Google Account › Security › Third-party access.',
  nothingRevokedRefused:
    'Signed out here. Nothing was revoked: Google no longer accepted your sign-in. Remove Sysprose under Google Account › Security › Third-party access.',
  revokedOther: (now: string, before: string) =>
    `Signed out here. Google's sign-in window came back signed in as ${now}, so the access revoked was that account's, not ${before}'s. Remove Sysprose from ${before} under Google Account › Security › Third-party access.`,
} as const;

/** The conflict row's sentence: who changed `name` in Drive, and when. */
export function driveConflictMessage(name: string, remote: DriveFileMeta): string {
  const when = driveTime(remote.modifiedTime);
  return `${name} changed in Drive since you opened it (${remote.lastModifiedBy ? `${remote.lastModifiedBy}, ${when}` : when}).`;
}

/** What a failing action was doing — which wording of a failure applies. */
export type DriveMessageOp = 'sign-in' | 'sign-out' | 'open' | 'save' | 'save-as' | 'list' | 'browse';

/** An action declined before any request, with the sentence that says why. */
class DriveRefusal extends Error {
  override name = 'DriveRefusal';
}

/**
 * Google refused the token mid-action, and the silent sign-in that would
 * renew it did not happen — its popup, opened after an await, was blocked or
 * closed. Only a fresh click can sign in now.
 */
class DriveSignInNeeded extends Error {
  override name = 'DriveSignInNeeded';
  constructor(readonly authError: unknown) {
    super('Google sign-in needed');
  }
}

/** The script loader's and the Picker loader's codes for Google code that did not load. */
const SCRIPT_REASONS = new Set(['script-refused', 'no-document', 'script-failed', 'script-timeout']);

/**
 * A Save as that failed after its request left, with no answer that says
 * whether Drive created the file: the connection dropped or timed out, the
 * server failed, or its answer did not parse (Drive certainly created that
 * one). Saving again could make a second file — which is also why the
 * gateway never repeats a create.
 */
function createMayHaveLanded(err: unknown): boolean {
  return err instanceof DriveNetworkError || writeMayHaveLanded(err);
}

/**
 * A write Drive answered without saying what became of it: an answer that
 * did not parse (it came with a 2xx: the write landed), or a server failure
 * (it may have come after the write).
 */
function writeMayHaveLanded(err: unknown): boolean {
  if (err instanceof DriveBadResponseError) return err.reason === 'not-json' || err.reason === 'bad-shape';
  return err instanceof DriveError && !(err instanceof DriveAuthError) && err.status >= 500;
}

/**
 * The sentence for a failed Drive action: every failure the Drive feature
 * reports, and its wording. `op` picks between wordings of the same failure
 * (a 404 on open is "not granted yet", on save "no longer there"); `name` is
 * the file's.
 */
export function driveMessage(err: unknown, ctx: { op?: DriveMessageOp; name?: string } = {}): string {
  const { op, name } = ctx;
  if (err instanceof DriveRefusal) return err.message;
  if (err instanceof DriveSignInNeeded) return DRIVE_MESSAGES.signInAgain;
  if (op === 'save-as' && createMayHaveLanded(err)) {
    return err instanceof DriveNetworkError && err.reason === 'timeout'
      ? DRIVE_MESSAGES.createTimeout
      : DRIVE_MESSAGES.createUncertain;
  }
  if (err instanceof DriveAuthError) {
    if (err.status === 401 || err.reason === 'no-token') return DRIVE_MESSAGES.signInAgain;
    if (err.reason === 'access_denied') return DRIVE_MESSAGES.accessDenied;
    if (err.reason === 'popup_failed_to_open') return DRIVE_MESSAGES.popupBlocked;
    // `popup_closed`, and whatever else GIS may report: the user's window
    // closed without a token — which is also all GIS says when Google showed
    // its "Access blocked" page inside it.
    return DRIVE_MESSAGES.signInCancelled;
  }
  if (err instanceof DriveRateLimitError) return DRIVE_MESSAGES.rateLimited;
  if (err instanceof DriveForbiddenError) {
    if (op === 'open' || op === 'browse') return DRIVE_MESSAGES.openRefused;
    // Only Drive's own reason says view access: a full Drive, a quota or a
    // policy is refused with a 403 too, and "keep your own copy" would send
    // the user to what was just refused.
    if (op === 'save' && err.reason === 'insufficientFilePermissions') return DRIVE_MESSAGES.readOnly(name);
    if (err.reason === 'storageQuotaExceeded') return DRIVE_MESSAGES.driveFull;
    return DRIVE_MESSAGES.refused(err.status);
  }
  if (err instanceof DriveNotFoundError) {
    return op === 'open' || op === 'browse' ? DRIVE_MESSAGES.notFoundOnOpen : DRIVE_MESSAGES.gone(name);
  }
  if (err instanceof DriveNetworkError) {
    if (err.reason !== 'timeout') return DRIVE_MESSAGES.offline;
    if (op === 'save') return DRIVE_MESSAGES.uploadTimeout;
    return DRIVE_MESSAGES.downloadTimeout;
  }
  if (err instanceof DriveBadResponseError) {
    if (err.reason === 'not-text') return DRIVE_MESSAGES.notText;
    if (err.reason === 'too-large-download') return DRIVE_MESSAGES.tooLargeToOpen(name);
    return DRIVE_MESSAGES.badAnswer(err.status);
  }
  if (err instanceof DriveError) {
    if (err.reason !== undefined && SCRIPT_REASONS.has(err.reason)) return DRIVE_MESSAGES.scriptFailed;
    if (err.reason === 'too-large') return DRIVE_MESSAGES.tooLarge;
    if (err.reason === 'picker-failed' || err.reason === 'bad-ref') return DRIVE_MESSAGES.pickerFailed;
    return DRIVE_MESSAGES.badAnswer(err.status);
  }
  return DRIVE_MESSAGES.badAnswer(0);
}

/** A failure worth trying again as it was: the network, a busy or failing server, an answer that did not parse. */
function retryable(err: unknown): boolean {
  if (err instanceof DriveRateLimitError || err instanceof DriveNetworkError) return true;
  if (err instanceof DriveBadResponseError) return err.reason === 'not-json' || err.reason === 'bad-shape';
  return err instanceof DriveError && !(err instanceof DriveAuthError) && err.status >= 500;
}

/** A failure that means Google no longer takes the token: a 401, or no token to send. */
function tokenRefused(err: unknown): boolean {
  return err instanceof DriveAuthError && (err.status === 401 || err.reason === 'no-token');
}

/** How an action a sign-out cut short ends — the same code the sign-in reports, and reported as nothing. */
function signedOutError(): DriveAuthError {
  return new DriveAuthError(driveErrorMessage(0, 'signed-out'), 0, 'signed-out');
}

/* ─────────────────────────────── Services ────────────────────────────────── */

/** The Google side, behind its three boundaries. */
export interface DriveServices {
  auth: DriveAuth;
  gateway: DriveGateway;
  /** Absent on a deployment whose configuration has no Picker key. */
  picker: DrivePicker | null;
}

/**
 * The real Google side for `config`: GIS's popup sign-in, the REST gateway
 * (asking that sign-in for a token per request) and — when the configuration
 * carries a Picker key and project number — the Picker. Creating them fetches
 * nothing; Google's scripts load at `auth.ready()` and at the first pick.
 * `given` replaces any of the three.
 */
export function createDriveServices(config: DriveConfig, given: Partial<DriveServices> = {}): DriveServices {
  const auth = given.auth ?? createGisPopupAuth(config.clientId);
  const gateway = given.gateway ?? createRestDriveGateway({ token: () => auth.token() });
  const picker =
    given.picker !== undefined
      ? given.picker
      : config.apiKey !== undefined && config.appId !== undefined && typeof window !== 'undefined'
        ? createGooglePicker({ apiKey: config.apiKey, appId: config.appId, origin: window.location.origin })
        : null;
  return { auth, gateway, picker };
}

let serviceOverrides: Partial<DriveServices> = {};
let madeServices: { config: DriveConfig; services: DriveServices } | null = null;

/**
 * Replace the Google side — the test seam. The services are made afresh for
 * the next action, with these in place of the real ones; null goes back to
 * the real ones.
 */
export function setDriveServices(services: Partial<DriveServices> | null): void {
  serviceOverrides = services ? { ...services } : {};
  madeServices = null;
}

/** The services for `config`, made once (and again when the configuration or the overrides change). */
function servicesFor(config: DriveConfig): DriveServices {
  if (madeServices === null || madeServices.config !== config) {
    madeServices = { config, services: createDriveServices(config, serviceOverrides) };
  }
  return madeServices.services;
}

/* ──────────────────────────────── Actions ────────────────────────────────── */

/** How many files the Recent list shows. */
export const DRIVE_RECENT_LIMIT = 20;

/** The store-side helpers the actions stand on, handed in by `store.ts`. */
export interface DriveInternals {
  /** Replace the model with a file's text and resolve once the library has settled. */
  openText(text: string, fmt: ModelFormat): Promise<void>;
  /** Resolve once the boot-time library load has settled. */
  whenLibraryReady(): Promise<void>;
  /** Resolve once no library load is running. */
  whenLibrarySettled(): Promise<void>;
  /** Fire a pending recompute now (and nothing when none is pending). */
  flushRecompute(): void;
  /** A recompute a local model edit forced is pending: it will replace the text buffer, typed or not. */
  forcedRecomputePending(): boolean;
  /** The text the live model was last applied from, or null. */
  lastAppliedText(): string | null;
  /** Text typed in the Text view and not applied yet has a parse error: applying it would make the parser's recovery the model. */
  typedTextFaulted(): boolean;
}

/** What a failing action was about: the wording, and where the failure lands. */
interface Attempt {
  op: DriveMessageOp;
  name?: string;
  /** What Retry, or "Sign in and continue", runs again. */
  again?: DrivePendingOp;
  /** A `?drive=` link's open: its failures land on the link (the gate), not in a notice. */
  link?: boolean;
}

/** One action's gateway calls, each renewing a refused token once (see `caller`). */
type Call = <T>(request: () => Promise<T>) => Promise<T>;

/**
 * The Drive actions over the store's `set`/`get`, spread into `useAppStore`.
 */
export function createDriveActions(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  internals: DriveInternals,
): DriveActions {
  /** Merge `fields` into the drive slice. */
  const patch = (fields: Partial<DriveState>): void => set((s) => ({ drive: { ...s.drive, ...fields } }));

  // Moves whenever the model stops being the attached file's — a command
  // replaced it (every detach, attached file or not), another file was
  // attached, or the user signed out. An action that awaited compares it
  // before writing to, or attaching, a file: the model it read may be gone.
  let attachment = 0;
  // Moves at every sign-out. An action begun before one does not renew a
  // token (its popup would sign the user back in) or show what it read.
  let signOutCount = 0;
  // The sign-in whose current token Google refused (a 401): that token is
  // not used again, and the next action signs in afresh. A note about the
  // token, never the token.
  let refusedBy: DriveAuth | null = null;
  // What a standing guard prompt runs once the user goes on.
  let guarded: { prompt: DrivePrompt; run: () => void | Promise<void> } | null = null;

  const configured = (): boolean => get().drive.configStatus === 'ready' && get().drive.config !== null;
  const services = (): DriveServices => servicesFor(get().drive.config as DriveConfig);
  const hasSession = (auth: DriveAuth): boolean => refusedBy !== auth && auth.token() !== null;

  /** Sign in without the account chooser (a brief window), as the account already signed in. */
  const signInAgain = (auth: DriveAuth): Promise<DriveSession> => {
    const email = get().drive.account?.email;
    return auth.signIn(email ? { prompt: '', hint: email } : { prompt: '' });
  };

  const signedIn = (auth: DriveAuth, session: DriveSession): void => {
    if (refusedBy === auth) refusedBy = null;
    patch({ expiresAt: session.expiresAt, authReady: true });
  };

  /** Who is signed in, from Drive's `about` — or an unknown account when Drive will not say. */
  const loadAccount = async (svc: DriveServices): Promise<void> => {
    const epoch = signOutCount;
    let account: DriveAccount;
    try {
      account = await svc.gateway.about();
    } catch (err) {
      console.warn('Google Drive: could not read the signed-in account', errorText(err));
      account = { email: null, name: null };
    }
    // Signed out meanwhile: nobody is signed in to name.
    if (signOutCount === epoch) patch({ account });
  };

  /**
   * Whose the current token is, when Drive says so and it is not `shown`'s
   * (case aside); else null — the same account, or Drive would not say.
   */
  const otherAccount = async (svc: DriveServices, shown: string | null): Promise<DriveAccount | null> => {
    if (shown === null) return null;
    let now: DriveAccount;
    try {
      now = await svc.gateway.about();
    } catch (err) {
      console.warn('Google Drive: could not read the account of the renewed sign-in', errorText(err));
      return null;
    }
    return now.email !== null && now.email.toLowerCase() !== shown.toLowerCase() ? now : null;
  };

  /**
   * After a renewal, before the action that asked for it goes on: the brief
   * window's `login_hint` is only a hint, and when the account shown here is
   * no longer signed in to Google, the user can pick another in it. Another
   * account's token is a new session — the attached file and the Recent list
   * were the other account's — so the slice says whose it is now, and the
   * action stops, saying why. An action begun before a sign-out (`begun`)
   * stops without a word.
   */
  const sameAccount = async (svc: DriveServices, begun: number): Promise<void> => {
    const shown = get().drive.account?.email ?? null;
    const now = await otherAccount(svc, shown);
    if (signOutCount !== begun) throw signedOutError();
    if (now === null || shown === null) return;
    attachment++;
    guarded = null;
    patch({ account: now, recent: null, file: null, conflict: null, prompt: null, pending: null });
    throw new DriveRefusal(DRIVE_MESSAGES.otherAccount(now.email ?? '', shown));
  };

  /**
   * Make sure a token is there for the action calling this — its FIRST
   * statement, before anything is awaited, so that when a sign-in is needed
   * its popup opens inside the click's own user activation. Null when the
   * session is live and shown; otherwise the sign-in, which the action
   * awaits. Signed out, that is the first sign-in, with Google's account
   * chooser; a renewal is checked for being the same account.
   */
  const ensureSession = (svc: DriveServices): Promise<void> | null => {
    if (hasSession(svc.auth)) {
      // A token while nobody is shown signed in: Google's window answered
      // after it had reported closing (`createGisPopupAuth` keeps that late
      // token). The session is real, so it is shown — whose it is, and Sign
      // out with it — before anything is done with it.
      return get().drive.account === null ? loadAccount(svc) : null;
    }
    const first = get().drive.account === null;
    const begun = signOutCount;
    const signingIn = first ? svc.auth.signIn({ prompt: 'select_account' }) : signInAgain(svc.auth);
    return signingIn.then(async (session) => {
      signedIn(svc.auth, session);
      if (first) await loadAccount(svc);
      else await sameAccount(svc, begun);
    });
  };

  /**
   * One action's gateway calls, for an action begun at sign-out count
   * `begun`. A call Google answers 401 renews the token once — a silent
   * sign-in, necessarily after an await — and is made again; when that
   * sign-in does not happen, the action is to be resumed by a click
   * ({@link DriveSignInNeeded}). A second refusal is a failure.
   */
  const caller = (svc: DriveServices, begun: number): Call => {
    let renewed = false;
    return async <T>(request: () => Promise<T>): Promise<T> => {
      try {
        return await request();
      } catch (err) {
        if (!tokenRefused(err)) throw err;
        // No token because the user signed out since: not one to renew.
        if (signOutCount !== begun) throw signedOutError();
        refusedBy = svc.auth;
        if (renewed) throw err;
        renewed = true;
        let session: DriveSession;
        try {
          session = await signInAgain(svc.auth);
        } catch (authErr) {
          // Ended by a sign-out meanwhile: nothing to resume.
          if (authErr instanceof DriveAuthError && authErr.reason === 'signed-out') throw authErr;
          throw new DriveSignInNeeded(authErr);
        }
        signedIn(svc.auth, session);
        await sameAccount(svc, begun);
        try {
          return await request();
        } catch (again) {
          if (tokenRefused(again)) refusedBy = svc.auth;
          throw again;
        }
      }
    };
  };

  /** A `?drive=` link whose open was cut short by a sign-out waits for a sign-in again (the gate offers one). */
  const linkWaits = (): void => {
    const link = get().drive.link;
    if (link !== null && link.status === 'opening') patch({ link: { ref: link.ref, status: 'pending' } });
  };

  /**
   * Put a failure where the user sees it: the link's gate, `pending`, or a
   * notice — for an action begun at sign-out count `begun`.
   */
  const fail = (err: unknown, what: Attempt, begun: number): void => {
    // A sign-in, or an action, ended by a sign-out: nothing went wrong. Nor
    // is anything said of one that failed after the user signed out since it
    // began — the session it would land in may be somebody else's by now,
    // and a failure may name the file.
    if (signOutCount !== begun || (err instanceof DriveAuthError && err.reason === 'signed-out')) {
      if (what.link) linkWaits();
      return;
    }
    if (err instanceof DriveSignInNeeded && what.again !== undefined && !what.link) {
      patch({ pending: what.again });
      return;
    }
    const message = driveMessage(err, what);
    console.warn(`Google Drive: ${what.op} did not complete —`, errorText(err));
    if (what.link) {
      const link = get().drive.link;
      if (link !== null) patch({ link: { ref: link.ref, status: 'failed', error: message } });
      return;
    }
    // A new file Drive may have created already is not created again on a
    // click: it could make a second one.
    const uncertainCreate = what.op === 'save-as' && createMayHaveLanded(err);
    const retry = what.again !== undefined && retryable(err) && !uncertainCreate ? what.again : undefined;
    patch({
      notice: { kind: 'error', message, retryable: retry !== undefined, ...(retry !== undefined ? { retry } : {}) },
    });
  };

  /**
   * Run a Drive action that needs a session: `ensureSession` first — before
   * any await, see there — then `body`, with the action marked `busy`; a
   * failure lands where {@link fail} puts it. `start` is merged into the
   * slice as the action begins. `body` gets the sign-out count the action
   * began at: what it learns after a sign-out is not the slice's to keep.
   * Never rejects.
   */
  const attempt = (
    busy: NonNullable<DriveState['busy']>,
    what: Attempt,
    body: (svc: DriveServices, call: Call, begun: number) => Promise<void>,
    start: Partial<DriveState> = {},
  ): Promise<void> => {
    const svc = services();
    // Taken now, at the click: a sign-out from here on ends the action.
    const begun = signOutCount;
    const session = ensureSession(svc);
    const call = caller(svc, begun);
    // A parked action stays parked — "Sign in and continue" still runs it —
    // unless this is the same action run again.
    const parked = get().drive.pending;
    const supersedes = parked !== null && what.again !== undefined && what.again.op === parked.op;
    patch({ busy, notice: null, ...(supersedes ? { pending: null } : {}), ...start });
    return (async () => {
      try {
        if (session) await session;
        await body(svc, call, begun);
      } catch (err) {
        fail(err, what, begun);
      } finally {
        // After a sign-out, `busy` is the sign-out's, or a later action's.
        if (signOutCount === begun) patch({ busy: null, opening: null });
      }
    })();
  };

  const refuseOffline = (): void =>
    patch({ notice: { kind: 'error', message: DRIVE_MESSAGES.offline, retryable: false } });

  /**
   * Connected to a collaboration room: its peers change the model, so no Drive
   * file is opened or attached meanwhile — joining (and every reconnection)
   * lets go of the attached one, see `connectCollab` — or Save to Drive would
   * write whatever a peer put in the model into the student's own file.
   */
  const inRoom = (): boolean => get().collab.connected;
  const refuseInRoom = (): void =>
    patch({ notice: { kind: 'info', message: DRIVE_MESSAGES.inRoom, retryable: false }, prompt: null });

  /** The name of the file `id`, when the Recent list or the attached file knows it — for "Opening <name>…". */
  const knownName = (id: string): string | null => {
    const d = get().drive;
    return d.recent?.find((f) => f.id === id)?.name ?? (d.file?.id === id ? d.file.name : null);
  };

  /**
   * The Save-as form, prefilled from the project name — or, for a copy, from
   * the attached file's. Signed out (Ctrl/Cmd+Shift+S with the panel never
   * opened), Google's sign-in script starts loading now: the form's Save
   * signs in, and its popup must open inside that click.
   */
  const openSaveAs = (asCopy: boolean): void => {
    const s = get();
    const file = s.drive.file;
    const suggested = asCopy && file ? copyName(file.name) : driveFileName(s.projectName || 'model');
    patch({ prompt: { kind: 'saveas', suggested, asCopy }, notice: null });
    if (s.drive.account === null && !s.drive.authReady) void get().drivePrepare();
  };

  /**
   * Save the project in this browser too (Save / Ctrl+S with a Drive file
   * attached, the offline row's Save). Resolves with whether the browser kept
   * it — see {@link browserSaveFailed} for when it did not.
   */
  const browserSave = async (): Promise<boolean> => {
    try {
      await get().saveProject();
      return true;
    } catch (err) {
      console.warn('Saving in this browser did not complete', errorText(err));
      return false;
    }
  };

  /**
   * Say that the browser refused its copy (full, or its storage blocked): the
   * copy Save promises beside the Drive one is not there. Beside a failure
   * the strip already shows, in the same row.
   */
  const browserSaveFailed = (): void => {
    const notice = get().drive.notice;
    patch({
      notice:
        notice?.kind === 'error'
          ? { ...notice, message: `${notice.message} ${DRIVE_MESSAGES.browserSaveFailed}` }
          : { kind: 'error', message: DRIVE_MESSAGES.browserSaveFailed, retryable: false },
    });
  };

  /** {@link browserSave}, saying so when the browser refused it. */
  const saveInBrowser = async (): Promise<void> => {
    if (!(await browserSave())) browserSaveFailed();
  };

  /**
   * Keep the Recent list current with a file just written by an action begun
   * at sign-out count `begun` — not after a sign-out: the list is somebody
   * else's then, or nobody's.
   */
  const remember = (meta: DriveFileMeta, begun: number): void => {
    const recent = get().drive.recent;
    if (recent !== null && signOutCount === begun) patch({ recent: [meta, ...recent.filter((f) => f.id !== meta.id)] });
  };

  /**
   * The text to upload, steps 1–4 of a save: what the user typed is made the
   * model first (unless that very text was applied already — a faulted file
   * reads `textDirty` without anyone typing, and every apply is an undo
   * step); an edit's pending recompute is fired, never a fresh one (that
   * would erase a faulted file's parse rows); a model the serializer refuses,
   * or one larger than an upload carries, is not sent at all.
   *
   * One recompute goes FIRST: one a local model edit forced. It replaces the
   * text buffer whatever was typed there — that is what an edit does to text
   * nobody applied — so applying that buffer before it would put the older
   * text back over the edit, and the edit would be neither in the model nor
   * in the upload. Typing after the edit takes the force off, and the typed
   * text wins, as it does without Drive.
   */
  const payloadNow = async (): Promise<string> => {
    if (internals.forcedRecomputePending()) internals.flushRecompute();
    const s = get();
    if (s.textDirty && s.textBuffer !== internals.lastAppliedText()) s.applyText();
    // An apply merges the library again, and the refresh after it lays the
    // text out as this app writes it: that is the text to upload. The apply
    // is this one, or one made just before the save — Ctrl/Cmd+S typed in
    // the Text view applies the text first, so the browser save holds it too.
    await internals.whenLibrarySettled();
    internals.flushRecompute();
    const { serializeError, textBuffer } = get();
    if (serializeError !== null) throw new DriveRefusal(DRIVE_MESSAGES.cannotSerialize);
    const payload = withFinalNewline(textBuffer);
    if (utf8Length(payload) > DRIVE_UPLOAD_MAX_BYTES) throw new DriveRefusal(DRIVE_MESSAGES.tooLarge);
    return payload;
  };

  /** Update the attached file — still attachment `gen` — with `fields`. */
  const markFile = (gen: number, fields: Partial<DriveFile>): void => {
    const file = get().drive.file;
    if (file !== null && attachment === gen) patch({ file: { ...file, ...fields } });
  };

  /**
   * Whether Drive's copy changed since this app last read or wrote it — by
   * CONTENT. The content hash first: it moves with the content and with
   * nothing else. Then the head revision, then the modified time. Never
   * `version`, which a rename or a share moves too.
   */
  const contentMoved = (known: DriveFileMeta, remote: DriveFileMeta): boolean => {
    if (known.md5Checksum !== undefined && remote.md5Checksum !== undefined) {
      return known.md5Checksum !== remote.md5Checksum;
    }
    if (known.headRevisionId !== undefined && remote.headRevisionId !== undefined) {
      return known.headRevisionId !== remote.headRevisionId;
    }
    return known.modifiedTime !== remote.modifiedTime;
  };

  /**
   * Step 5 of a save: write `payload` over the attached file — after checking
   * Drive's copy is still the one this app knows, unless the user chose to
   * overwrite. A file gone, or no longer editable, is marked so; one changed
   * in Drive becomes a conflict, and nothing is written.
   */
  const writeAttached = async (
    svc: DriveServices,
    call: Call,
    gen: number,
    payload: string,
    check: boolean,
    begun: number,
  ): Promise<void> => {
    const known = get().drive.file;
    if (known === null || attachment !== gen) return; // the model is no longer the file's
    const ref = refOf(known);
    try {
      if (check) {
        const remote = await call(() => svc.gateway.get(ref));
        if (attachment !== gen) return;
        if (remote.trashed) return markFile(gen, { trashed: true });
        if (!remote.canEdit) return markFile(gen, { canEdit: false });
        if (contentMoved(known, remote)) {
          patch({ conflict: { remote } });
          return;
        }
      }
      let meta: DriveFileMeta;
      try {
        meta = await call(() => svc.gateway.update(ref, payload));
      } catch (err) {
        // Drive answered the upload without saying what became of it: an
        // answer that did not parse came with a 2xx (the text is there), a
        // server failure may have come after the write. Not "nothing was
        // changed", and no Retry as if it were: the next save's content check
        // asks which version to keep if Drive did take it.
        if (!writeMayHaveLanded(err)) throw err;
        console.warn('Google Drive: the save may have landed —', errorText(err));
        throw new DriveRefusal(DRIVE_MESSAGES.saveUncertain);
      }
      remember(meta, begun);
      // Replaced while the upload was in flight: the file now holds the model
      // it was attached to, and the new model stays unattached.
      const file = get().drive.file;
      if (file === null || attachment !== gen) return;
      patch({ file: { ...withMeta(file, meta), savedText: payload, rewrites: false }, conflict: null });
    } catch (err) {
      if (err instanceof DriveNotFoundError) return markFile(gen, { trashed: true });
      if (err instanceof DriveForbiddenError && err.reason === 'insufficientFilePermissions') {
        return markFile(gen, { canEdit: false });
      }
      throw err;
    }
  };

  /**
   * Save the attached file: checked against Drive's copy, or — `overwrite` —
   * not. `inBrowser` saves the project in this browser too: the model the
   * upload is made from — or, when typed text with a parse error is about to
   * be applied for the upload, the model as it stood before: the parser's
   * recovery of that text is not what is on screen, and would overwrite the
   * last good copy in this browser.
   */
  const saveAttached = (opts: { overwrite: boolean; inBrowser: boolean }): Promise<void> => {
    const file = get().drive.file;
    if (file === null) return opts.inBrowser ? saveInBrowser() : Promise.resolve();
    const gen = attachment;
    let savedInBrowser = !opts.inBrowser;
    let browserRefused = false;
    const inBrowser = async (): Promise<void> => {
      savedInBrowser = true;
      if (!(await browserSave())) browserRefused = true;
    };
    const saving = attempt(
      'saving',
      { op: 'save', name: file.name, again: opts.overwrite ? { op: 'save', overwrite: true } : { op: 'save' } },
      async (svc, call, begun) => {
        if (!savedInBrowser && !internals.forcedRecomputePending() && internals.typedTextFaulted()) await inBrowser();
        const payload = await payloadNow();
        if (!savedInBrowser) await inBrowser();
        await writeAttached(svc, call, gen, payload, !opts.overwrite, begun);
      },
    );
    // Whatever became of the Drive save — no session, a refusal — the browser
    // save the user asked for still happens; and a browser that refused it
    // is said so once the Drive save has said its own.
    const done = savedInBrowser ? saving : saving.then(() => (savedInBrowser ? undefined : inBrowser()));
    return done.then(() => {
      if (browserRefused) browserSaveFailed();
    });
  };

  /** Reload the attached file from Drive over the model: one Undo step back to it. */
  const reloadAttached = (): Promise<void> => {
    const file = get().drive.file;
    if (file === null) return Promise.resolve();
    const ref = refOf(file);
    const gen = attachment;
    return attempt(
      'opening',
      { op: 'open', name: file.name, again: { op: 'open', arg: ref.id, ref, from: file.openedFrom, reload: true } },
      async (svc, call) => {
        const meta = await call(() => svc.gateway.get(ref));
        if (meta.trashed) {
          markFile(gen, { trashed: true });
          patch({ conflict: null });
          return;
        }
        const text = await call(() => svc.gateway.download(ref));
        if (attachment !== gen) return;
        if (detectFormat(meta.name, text) !== 'sysml') throw new DriveRefusal(DRIVE_MESSAGES.unknownFormat(meta.name));
        // No pushUndo here: applying the text pushes its one step itself, and
        // a second would snapshot the same model twice. An edit made while
        // the file downloaded is in that step too.
        await internals.openText(text, 'sysml');
        const current = get().drive.file;
        if (current === null || attachment !== gen) return;
        patch({ file: { ...withMeta(current, meta), ...asOpened(text) }, conflict: null });
      },
      { opening: file.name },
    );
  };

  /**
   * What an attached file knows of the text it was just opened (or reloaded)
   * from, once the library settled over it. Saved is the Text view's text —
   * the app's layout of what Drive holds — unless the model changed since the
   * text was applied (an edit, an Undo while the library merged): then it is
   * the text as fetched, so the change reads unsaved, and whether a save
   * rewrites the file cannot be told. Nor can it when a syntax error kept the
   * text as fetched: the app never laid it out.
   */
  const asOpened = (text: string): Pick<DriveFile, 'savedText' | 'rewrites'> => {
    if (internals.lastAppliedText() !== text) return { savedText: withFinalNewline(text), rewrites: true };
    const savedText = withFinalNewline(get().textBuffer);
    return { savedText, rewrites: get().textDirty || laidOutElsewhere(text, savedText) };
  };

  /**
   * What stays parked when the model stops being the attached file's: an
   * open of a file, which replaces the model anyway — not a save, an
   * overwrite or a reload, which were about the file let go.
   */
  const parkedAcrossSwitch = (pending: DrivePendingOp | null): DrivePendingOp | null =>
    pending?.op === 'open' && !pending.reload ? pending : null;

  /**
   * Run `run` — a command that replaces the model — unless that would lose
   * something; then the strip asks first (see `driveGuard`). Resolves with
   * `run` when it ran at once.
   */
  const guard = (label: string, variant: 'dirty' | 'open', run: () => void | Promise<void>): Promise<void> => {
    const s = get();
    let prompt: DrivePrompt | null = null;
    if (driveDirty(s)) prompt = { kind: 'guard', label, variant: 'dirty' };
    else if (variant === 'open' && s.drive.file === null && s.undoStack.length > 0) {
      prompt = { kind: 'guard', label, variant: 'open' };
    }
    if (prompt === null) return Promise.resolve(run());
    guarded = { prompt, run };
    patch({ prompt, notice: null });
    return Promise.resolve();
  };

  /**
   * Run a parked action again. Each one starts with its own `ensureSession`,
   * inside the caller's click. An open goes through the guard again: the
   * model may have been edited since it was parked.
   */
  const runAgain = (op: DrivePendingOp): Promise<void> => {
    switch (op.op) {
      case 'save':
        return op.overwrite ? get().driveResolveConflict('overwrite') : get().driveSave();
      case 'save-as':
        return get().driveSaveAs(op.arg, { asCopy: op.asCopy });
      case 'open':
        return op.reload
          ? get().driveResolveConflict('reload')
          : guard('Open from Drive', 'open', () => get().driveOpen(op.ref, op.from));
    }
  };

  return {
    drivePrepare() {
      if (!configured()) return Promise.resolve();
      let ready: Promise<void>;
      try {
        ready = services().auth.ready();
      } catch (err) {
        ready = Promise.reject(err);
      }
      return ready.then(
        () => {
          if (!get().drive.authReady) patch({ authReady: true });
          // Loaded this time, after an earlier load failed: the notice of that
          // failure — whose advice was to try again — no longer holds.
          if (get().drive.notice?.message === DRIVE_MESSAGES.scriptFailed) patch({ notice: null });
        },
        (err: unknown) => {
          console.warn("Google Drive: Google's sign-in script did not load", errorText(err));
          const link = get().drive.link;
          // A `?drive=` link's gate is the one place a sign-in is offered
          // then, and it shows no notice: the failure goes on the link, whose
          // "Try again" loads the script again (`driveLinkRetry`).
          if (link?.status === 'pending') {
            patch({
              authReady: false,
              link: { ref: link.ref, status: 'failed', error: DRIVE_MESSAGES.scriptFailedOnLink },
            });
            return;
          }
          patch({
            authReady: false,
            notice: { kind: 'error', message: driveMessage(err, { op: 'sign-in' }), retryable: false },
          });
        },
      );
    },

    driveSignIn() {
      const d = get().drive;
      if (!configured() || d.busy !== null) return Promise.resolve();
      if (!d.online) {
        refuseOffline();
        return Promise.resolve();
      }
      const svc = services();
      // FIRST, inside the click: the account chooser's popup.
      const signingIn = svc.auth.signIn({ prompt: 'select_account' });
      const epoch = signOutCount;
      patch({ busy: 'signing-in', notice: null });
      return (async () => {
        try {
          signedIn(svc.auth, await signingIn);
          await loadAccount(svc);
          try {
            const recent = await svc.gateway.list(DRIVE_RECENT_LIMIT);
            if (signOutCount === epoch) patch({ recent });
          } catch (err) {
            console.warn('Google Drive: could not list recent files', errorText(err));
          }
        } catch (err) {
          fail(err, { op: 'sign-in' }, epoch);
        } finally {
          // After a sign-out, `busy` is the sign-out's, or a later action's.
          if (signOutCount === epoch) patch({ busy: null });
        }
      })();
    },

    driveSignOut() {
      const d = get().drive;
      // A second click while the first is revoking: one sign-out is enough
      // (and a second would open a sign-in window to revoke nothing).
      if (!configured() || d.busy === 'signing-out') return Promise.resolve();
      const svc = services();
      const live = hasSession(svc.auth);
      // Google answered the current token with a 401: it takes it no more.
      const refused = refusedBy === svc.auth;
      // FIRST, inside the click: revoking needs a token Google still accepts,
      // and after the hour there is none — so sign in again (a brief window)
      // before anything else, while the click still allows a window.
      const renewing = !live && d.account !== null ? signInAgain(svc.auth) : null;
      const shown = d.account?.email ?? null;
      // From here on, nothing begun before writes to or attaches a file,
      // renews a token, or shows what it read: the user signed out.
      signOutCount++;
      attachment++;
      guarded = null;
      patch({ busy: 'signing-out', notice: null });
      return (async () => {
        let notice: DriveNotice | null = null;
        // The account the renewal's window came back as, when not the one
        // signed in here: its token is the one revoked (the only one held),
        // and the account shown here keeps its access — which the user is told.
        let other: DriveAccount | null = null;
        try {
          if (renewing !== null) {
            try {
              signedIn(svc.auth, await renewing);
              other = await otherAccount(svc, shown);
            } catch (err) {
              // No token Google would take, so nothing is revoked. Signed out
              // all the same: the sign-in forgets the token it holds (one
              // Google refused is still held while its hour lasts), ends any
              // sign-in still waiting, and drops a late answer to one.
              console.warn('Google Drive: sign-out could not renew the sign-in to revoke it', errorText(err));
              const outcome = await svc.auth.signOut();
              if (!outcome.revoked) {
                const message = refused ? DRIVE_MESSAGES.nothingRevokedRefused : DRIVE_MESSAGES.nothingRevoked;
                notice = { kind: 'error', message, retryable: false };
              }
              return;
            }
          } else if (!live) {
            // Never signed in here: nothing to revoke, and nothing to say.
            await svc.auth.signOut();
            return;
          }
          const outcome = await svc.auth.signOut();
          if (other !== null && shown !== null) {
            notice = { kind: 'error', message: DRIVE_MESSAGES.revokedOther(other.email ?? '', shown), retryable: false };
          } else if (!outcome.revoked) {
            const message = outcome.hadToken ? DRIVE_MESSAGES.revokeUnconfirmed : DRIVE_MESSAGES.nothingRevoked;
            notice = { kind: 'error', message, retryable: false };
          }
        } finally {
          patch({
            account: null,
            expiresAt: null,
            recent: null,
            file: null,
            conflict: null,
            prompt: null,
            pending: null,
            busy: null,
            opening: null,
            notice,
          });
        }
      })();
    },

    driveSave(opts = {}) {
      const inBrowser = opts.alsoInBrowser === true;
      const asked = (): Promise<void> => (inBrowser ? saveInBrowser() : Promise.resolve());
      const d = get().drive;
      if (!configured() || d.busy !== null) return asked();
      if (d.file === null) {
        openSaveAs(false);
        return asked();
      }
      if (!d.online) {
        refuseOffline();
        return asked();
      }
      // The first save of a file this app did not write asks before rewriting
      // it in this app's layout (and dropping its `//` comments).
      if (d.file.rewrites && !d.file.rewriteAcknowledged) {
        patch({ prompt: { kind: 'rewrite' }, notice: null });
        return asked();
      }
      return saveAttached({ overwrite: false, inBrowser });
    },

    driveSaveLocal() {
      // Typed text is the model only once applied — unless it has a parse
      // error: the parser's recovery of it is not what is on screen, and the
      // model is kept as it stands (the editor still reads "not yet applied").
      const s = get();
      if (s.textDirty && s.textBuffer !== internals.lastAppliedText() && !internals.typedTextFaulted()) s.applyText();
      return saveInBrowser();
    },

    driveSaveAs(name, opts = {}) {
      const asCopy = opts.asCopy === true;
      const d = get().drive;
      if (!configured()) return Promise.resolve();
      if (inRoom()) {
        refuseInRoom();
        return Promise.resolve();
      }
      if (name === undefined) {
        openSaveAs(asCopy);
        return Promise.resolve();
      }
      if (d.busy !== null) return Promise.resolve();
      if (!d.online) {
        refuseOffline();
        return Promise.resolve();
      }
      const target = driveFileName(name);
      const gen = attachment;
      return attempt(
        'saving',
        { op: 'save-as', name: target, again: { op: 'save-as', arg: target, asCopy } },
        async (svc, call, begun) => {
          const payload = await payloadNow();
          if (attachment !== gen) return; // the model was replaced meanwhile
          const meta = await call(() => svc.gateway.create(target, payload));
          remember(meta, begun);
          if (attachment !== gen) return;
          attachment++;
          set((s) => ({
            linkedModel: null,
            drive: {
              ...s.drive,
              file: { ...meta, savedText: payload, rewrites: false, rewriteAcknowledged: false, openedFrom: 'save-as' },
              conflict: null,
              prompt: null,
              pending: parkedAcrossSwitch(s.drive.pending),
            },
          }));
        },
        { prompt: null },
      );
    },

    driveOpen(ref, from) {
      const d = get().drive;
      if (!configured() || d.busy !== null) return Promise.resolve();
      const link = from === 'link';
      if (!d.online) {
        if (link) patch({ link: { ref, status: 'failed', error: DRIVE_MESSAGES.linkOffline } });
        else refuseOffline();
        return Promise.resolve();
      }
      if (inRoom()) {
        if (link) patch({ link: { ref, status: 'failed', error: DRIVE_MESSAGES.inRoom } });
        else refuseInRoom();
        return Promise.resolve();
      }
      // The model the open replaces, as it stood when the user asked for it.
      // A download takes a while, and the model stays editable meanwhile: a
      // command that replaces it moves `attachment` (New, Open, Import, a
      // room, a sign-out), an edit or an Undo replaces the undo stack, and
      // typing changes the text not yet applied. Any of them since, and the
      // open no longer replaces what the user agreed to replace.
      const gen = attachment;
      const asked = { undo: get().undoStack, text: get().textBuffer };
      const changedSinceAsked = (): boolean => {
        const s = get();
        return attachment !== gen || s.undoStack !== asked.undo || (s.textDirty && s.textBuffer !== asked.text);
      };
      /** Leave the model as it is: the gate or a notice says why — nothing at all after a sign-out, which said its own. */
      const giveUp = (message: string): void => {
        if (get().drive.account === null) {
          if (link) linkWaits();
          return;
        }
        if (link) patch({ link: { ref, status: 'failed', error: message } });
        else patch({ notice: { kind: 'info', message, retryable: false } });
      };
      return attempt(
        'opening',
        { op: 'open', link, again: { op: 'open', arg: ref.id, ref, from } },
        async (svc, call) => {
          await internals.whenLibraryReady();
          let meta: DriveFileMeta;
          try {
            meta = await call(() => svc.gateway.get(ref));
          } catch (err) {
            // Not granted to this app yet (or gone): the gate offers the Picker.
            if (link && err instanceof DriveNotFoundError) {
              patch({ link: { ref, status: 'denied' } });
              return;
            }
            throw err;
          }
          if (meta.trashed) throw new DriveRefusal(DRIVE_MESSAGES.goneOnOpen(meta.name));
          patch({ opening: meta.name });
          const text = await call(() => svc.gateway.download(ref));
          const fmt = detectFormat(meta.name, text);
          if (fmt !== 'sysml' && fmt !== 'model-json') {
            throw new DriveRefusal(DRIVE_MESSAGES.unknownFormat(meta.name));
          }
          // Replacing the model now would lose what changed while the file
          // downloaded — and clearing Undo, the way back to it.
          if (changedSinceAsked()) return giveUp(DRIVE_MESSAGES.openStopped(meta.name));
          let applying: Promise<void>;
          try {
            applying = internals.openText(text, fmt);
          } catch (err) {
            applying = Promise.reject(err);
          }
          // The open's own replacement, made synchronously by that call: the
          // JSON import's detach, and the undo step back to the model it
          // replaced. Whatever moves either after this was someone else.
          const applied = { gen: attachment, undo: get().undoStack };
          const replaced = applied.undo[applied.undo.length - 1];
          try {
            await applying;
          } catch (err) {
            // An import refuses before it touches the model.
            console.warn('Google Drive: the file did not open', errorText(err));
            throw new DriveRefusal(DRIVE_MESSAGES.unknownFormat(meta.name));
          }
          // A command replaced the opened model while the library settled
          // over it (New, Import, a room, a sign-out): the file holds neither
          // that model nor this one, and the command's Undo stays as it is.
          if (attachment !== applied.gen) return giveUp(DRIVE_MESSAGES.openNotAttached(meta.name));
          // The opened file is where this session starts: Undo must not step
          // back into the model it replaced. An edit made while the library
          // settled is kept, with its undo step.
          const untouched =
            get().undoStack === applied.undo && (fmt !== 'sysml' || internals.lastAppliedText() === text);
          if (untouched) set({ undoStack: [], redoStack: [], linkedModel: null });
          else {
            const at = replaced === undefined ? -1 : get().undoStack.lastIndexOf(replaced);
            if (at >= 0) set((s) => ({ undoStack: s.undoStack.slice(at + 1), linkedModel: null }));
            // Undone back past the open (or pushed out of Undo): the model no
            // longer descends from the file, and Undo stays as it is.
            else if (fmt === 'sysml') return giveUp(DRIVE_MESSAGES.openNotAttached(meta.name));
          }
          if (fmt === 'model-json') {
            // Opened, not attached: saving JSON back would be another format.
            patch({
              notice: { kind: 'info', message: DRIVE_MESSAGES.openedJson(meta.name), retryable: false },
              ...(link ? { link: null } : {}),
            });
            return;
          }
          const resourceKey = meta.resourceKey ?? ref.resourceKey;
          const opened = asOpened(text);
          attachment++;
          guarded = null;
          set((s) => ({
            drive: {
              ...s.drive,
              file: {
                ...meta,
                ...(resourceKey !== undefined ? { resourceKey } : {}),
                ...opened,
                rewriteAcknowledged: false,
                openedFrom: from,
              },
              conflict: null,
              prompt: null,
              pending: parkedAcrossSwitch(s.drive.pending),
              ...(link ? { link: null } : {}),
            },
          }));
        },
        { opening: knownName(ref.id), ...(link ? { link: { ref, status: 'opening' } } : {}) },
      );
    },

    driveBrowse(fileIds) {
      const d = get().drive;
      if (!configured() || d.busy !== null) return Promise.resolve();
      if (!d.online) {
        refuseOffline();
        return Promise.resolve();
      }
      const forLink = fileIds !== undefined && get().drive.link !== null;
      if (inRoom()) {
        const link = get().drive.link;
        if (forLink && link !== null) patch({ link: { ref: link.ref, status: 'failed', error: DRIVE_MESSAGES.inRoom } });
        else refuseInRoom();
        return Promise.resolve();
      }
      const svc = services();
      const picker = svc.picker;
      if (picker === null) return Promise.resolve();
      const begun = signOutCount;
      const session = ensureSession(svc);
      patch({ notice: null });
      return (async () => {
        try {
          if (session) await session;
          const token = svc.auth.token();
          if (token === null) throw new DriveAuthError(driveErrorMessage(0, 'no-token'), 0, 'no-token');
          const picked = await picker.pick({ token, ...(fileIds !== undefined ? { fileIds } : {}) });
          if (picked === null) return;
          const link = get().drive.link;
          // The file a denied link names, now granted: opened as that link
          // (its resource key with it).
          if (fileIds !== undefined && link !== null && link.ref.id === picked.id) {
            await get().driveOpen(link.ref, 'link');
            return;
          }
          await get().driveOpen({ id: picked.id }, 'picker');
        } catch (err) {
          fail(err, { op: 'browse', link: forLink }, begun);
        }
      })();
    },

    driveRefreshRecent() {
      const d = get().drive;
      if (!configured() || d.busy !== null || d.account === null) return Promise.resolve();
      if (!d.online) {
        refuseOffline();
        return Promise.resolve();
      }
      const epoch = signOutCount;
      return attempt('listing', { op: 'list' }, async (svc, call) => {
        const recent = await call(() => svc.gateway.list(DRIVE_RECENT_LIMIT));
        // Signed out meanwhile: the list is not this user's to show.
        if (signOutCount === epoch) patch({ recent });
      });
    },

    driveDetach() {
      attachment++;
      const d = get().drive;
      if (d.file === null) return;
      guarded = null;
      patch({
        file: null,
        conflict: null,
        // What was about the file goes with it; an open of another stays.
        pending: parkedAcrossSwitch(d.pending),
        prompt: d.prompt?.kind === 'saveas' && !d.prompt.asCopy ? d.prompt : null,
        notice: { kind: 'info', message: DRIVE_MESSAGES.closed(d.file.name), retryable: false },
      });
    },

    driveResolveConflict(how) {
      const d = get().drive;
      if (!configured() || d.file === null) return Promise.resolve();
      // A form only: its Save is the click that may need a session.
      if (how === 'copy') {
        openSaveAs(true);
        return Promise.resolve();
      }
      if (d.busy !== null) return Promise.resolve();
      if (!d.online) {
        refuseOffline();
        return Promise.resolve();
      }
      return how === 'overwrite' ? saveAttached({ overwrite: true, inBrowser: false }) : reloadAttached();
    },

    driveAcknowledgeRewrite(how) {
      const file = get().drive.file;
      if (how === 'copy') {
        openSaveAs(true);
        return Promise.resolve();
      }
      patch({ prompt: null });
      if (how === 'cancel' || file === null) return Promise.resolve();
      patch({ file: { ...file, rewriteAcknowledged: true } });
      return get().driveSave();
    },

    driveGuard(label, variant, run) {
      void guard(label, variant, run);
    },

    async driveRunPending(how) {
      const standing = guarded;
      const prompt = get().drive.prompt;
      guarded = null;
      if (prompt?.kind === 'guard') patch({ prompt: null });
      if (standing === null || standing.prompt !== prompt || how === 'keep') return;
      if (how === 'save') {
        const parkedBefore = get().drive.pending;
        // Called at once, so its sign-in (if any) opens inside this click.
        await get().driveSave();
        const after = get();
        const d = after.drive;
        // Not saved — a conflict, a question, the save parked for a sign-in,
        // a failure: the command waits, and the model stays.
        const parked = d.pending !== null && d.pending !== parkedBefore;
        if (driveDirty(after) || d.conflict !== null || d.prompt !== null || parked || d.notice?.kind === 'error') {
          return;
        }
      }
      await standing.run();
    },

    driveResume() {
      const pending = get().drive.pending;
      if (pending === null) return Promise.resolve();
      patch({ pending: null });
      return runAgain(pending);
    },

    driveRetry() {
      const notice = get().drive.notice;
      if (notice?.retry === undefined) return Promise.resolve();
      patch({ notice: null });
      return runAgain(notice.retry);
    },

    driveLinkRetry() {
      const link = get().drive.link;
      if (!configured() || link === null || (link.status !== 'failed' && link.status !== 'denied')) {
        return Promise.resolve();
      }
      if (!get().drive.authReady) {
        // Google's sign-in script is what failed: the gate offers its sign-in
        // again once the script is there.
        patch({ link: { ref: link.ref, status: 'pending' } });
        return get().drivePrepare();
      }
      return get().driveOpen(link.ref, 'link');
    },

    async driveCopyLink() {
      const link = driveLink(get());
      if (link === null) throw new Error('no Google Drive file is open');
      await navigator.clipboard.writeText(link);
      return link;
    },

    driveDismiss() {
      const d = get().drive;
      patch({
        notice: null,
        ...(d.prompt?.kind === 'saveas' ? { prompt: null } : {}),
        ...(d.link?.status === 'unsupported' ? { link: null } : {}),
      });
    },

    driveLinkSkip() {
      patch({ link: null });
    },
  };
}

/** What a log line may say of an error: a DriveError's message is its status and code, nothing more. */
function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
