/**
 * Google Drive (optional) — Google's Picker: how a user hands this app a file
 * it did not create.
 *
 * Under the `drive.file` scope the app sees only files it created or that the
 * user chose for it, and choosing one in Google's own Picker is what grants
 * it. So the Picker is how a file shared by a classmate becomes openable: the
 * first time its link is followed Drive answers 404, and picking it once —
 * in a Picker opened on that one file — grants it for good.
 *
 * {@link createGooglePicker} has two variants. To **browse** it shows two
 * views, My Drive and Shared with me, each listing text files and folders.
 * (The manual run against Google, plan F.4 step 5, checks that the second
 * lists what was shared with the user: the Picker reference may ignore
 * `setOwnedByMe` on a view that includes folders.) For **one file**
 * (`fileIds` given: the denied-link path) it shows a single view
 * holding just those files, and nothing else is set on that view: the Picker
 * reference says `setFileIds` "overrides any previous calls to setEnableDrives
 * or setParent", and "files that users lack access to are automatically
 * excluded". `setFileIds` and `setOwnedByMe` are `DocsView` methods, not
 * `PickerBuilder` ones, and `setFileIds` takes ONE comma-separated string.
 *
 * The Picker needs the API key and the project number (`appId`) of the
 * deployment's configuration; a deployment without them has no Picker, and
 * the paste field stands in for it. Its code comes from `api.js` and
 * `gapi.load('picker')`, loaded at the first pick — never earlier.
 */
import { DRIVE_SCRIPTS } from './hosts';
import { DRIVE_FILE_ID } from './links';
import { DRIVE_SCRIPT_TIMEOUT_MS, loadScriptOnce, type ScriptLoader } from './loader';
import { DriveError, driveErrorMessage } from './types';

/** A file the user chose in the Picker. */
export interface DrivePicked {
  id: string;
  name: string;
}

/** Google's Picker, as the app uses it. */
export interface DrivePicker {
  /**
   * Show the Picker, authorised by `token`: to browse, or — with `fileIds` —
   * on those files alone. Resolves with the chosen file, or null when the user
   * closed the Picker. Rejects with a {@link DriveError}: the Picker's code
   * could not be loaded (`script-…`, the codes a failed sign-in script load
   * has too), a `fileIds` entry or the chosen id is not a Drive file id
   * (`bad-ref`), or the Picker failed to open or reported an error
   * (`picker-failed`).
   */
  pick(opts: { token: string; fileIds?: string[] }): Promise<DrivePicked | null>;
}

/**
 * What the browse views list: text files by the types Drive gives a `.sysml`
 * upload (it has no registered type of its own), and model JSON.
 */
export const DRIVE_PICKER_MIME_TYPES = 'text/plain,application/octet-stream,application/json';

/** A Picker view, as far as the app configures one. Every method returns the view. */
export interface DocsViewLike {
  setIncludeFolders(included: boolean): unknown;
  setMimeTypes(mimeTypes: string): unknown;
  setOwnedByMe(me: boolean): unknown;
  setFileIds(fileIds: string): unknown;
}

/** The Picker's builder, as far as the app configures it. Every method but `build` returns the builder. */
export interface PickerBuilderLike {
  addView(view: DocsViewLike): unknown;
  setDeveloperKey(key: string): unknown;
  setAppId(appId: string): unknown;
  setOAuthToken(token: string): unknown;
  setOrigin(origin: string): unknown;
  setCallback(callback: (data: Record<string, unknown>) => void): unknown;
  build(): { setVisible(visible: boolean): unknown };
}

/** `google.picker`, as far as the app uses it. */
export interface GooglePickerNs {
  PickerBuilder: new () => PickerBuilderLike;
  DocsView: new (viewId?: string) => DocsViewLike;
  ViewId: { DOCS: string };
  /** `ERROR` is read only when the Picker defines it. */
  Action: { PICKED: string; CANCEL: string; ERROR?: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string; NAME: string };
}

/**
 * `gapi`, as far as the app uses it: loading the Picker module. Called with
 * the handlers object, `{ callback, onerror }` — `api.js` accepts that as well
 * as a bare callback, and the object form is the one that reports a failure —
 * so a stand-in for `api.js` must accept it and call `callback` (or
 * `onerror`).
 */
export interface GapiNs {
  load(module: 'picker', handlers: { callback: () => void; onerror: () => void }): void;
}

/** A pick that did not happen (status 0). */
function pickError(reason: string): DriveError {
  return new DriveError(driveErrorMessage(0, reason), 0, reason);
}

/** Refuse `fileIds` that are empty or hold anything but Drive file ids. */
function checkFileIds(fileIds: string[] | undefined): void {
  if (fileIds !== undefined && (fileIds.length === 0 || !fileIds.every((id) => DRIVE_FILE_ID.test(id)))) {
    throw pickError('bad-ref');
  }
}

/**
 * The Picker over Google's `api.js`, for the deployment's API key and project
 * number, shown for the page's `origin`.
 *
 * `load` replaces the script loader, and `gapi`/`picker` the lookups of the
 * page's `gapi` and `google.picker` — all three for tests. The Picker's code
 * is loaded once, at the first pick; a load that failed is forgotten so the
 * next pick tries again — without fetching `api.js` again when it is on the
 * page already (it ran, or it arrived after its time limit).
 */
export function createGooglePicker(
  cfg: { apiKey: string; appId: string; origin: string },
  deps: {
    load?: ScriptLoader;
    gapi?: () => GapiNs | undefined;
    picker?: () => GooglePickerNs | undefined;
  } = {},
): DrivePicker {
  const load = deps.load ?? loadScriptOnce;
  const gapi = deps.gapi ?? (() => (globalThis as { gapi?: GapiNs }).gapi);
  const picker =
    deps.picker ?? (() => (globalThis as { google?: { picker?: GooglePickerNs } }).google?.picker);

  let loading: Promise<GooglePickerNs> | null = null;

  /** `gapi`, once `api.js` has defined it. */
  const gapiOnPage = (): GapiNs | undefined => {
    const g = gapi();
    return g && typeof g.load === 'function' ? g : undefined;
  };

  /** `api.js`, then its `picker` module — once. */
  const loaded = (): Promise<GooglePickerNs> =>
    (loading ??= (async () => {
      if (!gapiOnPage()) await load(DRIVE_SCRIPTS.gapi, () => gapiOnPage() !== undefined);
      const g = gapiOnPage();
      if (!g) throw pickError('script-failed');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(pickError('script-timeout')), DRIVE_SCRIPT_TIMEOUT_MS);
        const settle = (error?: DriveError): void => {
          clearTimeout(timer);
          if (error === undefined) resolve();
          else reject(error);
        };
        try {
          g.load('picker', { callback: () => settle(), onerror: () => settle(pickError('script-failed')) });
        } catch {
          settle(pickError('script-failed'));
        }
      });
      const ns = picker();
      if (!ns) throw pickError('script-failed');
      return ns;
    })().catch((error: unknown) => {
      loading = null;
      throw error instanceof DriveError ? error : pickError('script-failed');
    }));

  return {
    pick: async ({ token, fileIds }) => {
      checkFileIds(fileIds);
      const ns = await loaded();
      return new Promise<DrivePicked | null>((resolve, reject) => {
        const onAnswer = (data: Record<string, unknown>): void => {
          const action = data?.[ns.Response.ACTION];
          if (action === ns.Action.CANCEL) {
            resolve(null);
            return;
          }
          if (ns.Action.ERROR !== undefined && action === ns.Action.ERROR) {
            reject(pickError('picker-failed'));
            return;
          }
          // Any other action (`loaded`, when the dialog has opened) is not an answer.
          if (action !== ns.Action.PICKED) return;
          const docs = data[ns.Response.DOCUMENTS];
          const first: unknown = Array.isArray(docs) ? docs[0] : undefined;
          const doc = typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {};
          const id = doc[ns.Document.ID];
          const name = doc[ns.Document.NAME];
          // The id is about to enter a request path: Drive's alphabet or nothing.
          if (typeof id !== 'string' || !DRIVE_FILE_ID.test(id)) {
            reject(pickError('bad-ref'));
            return;
          }
          resolve({ id, name: typeof name === 'string' ? name : '' });
        };
        try {
          const builder = new ns.PickerBuilder();
          if (fileIds !== undefined) {
            const one = new ns.DocsView(ns.ViewId.DOCS);
            one.setFileIds(fileIds.join(','));
            builder.addView(one);
          } else {
            const mine = new ns.DocsView(ns.ViewId.DOCS);
            mine.setIncludeFolders(true);
            mine.setMimeTypes(DRIVE_PICKER_MIME_TYPES);
            builder.addView(mine);
            const shared = new ns.DocsView(ns.ViewId.DOCS);
            shared.setOwnedByMe(false);
            shared.setIncludeFolders(true);
            shared.setMimeTypes(DRIVE_PICKER_MIME_TYPES);
            builder.addView(shared);
          }
          builder.setDeveloperKey(cfg.apiKey);
          builder.setAppId(cfg.appId);
          builder.setOAuthToken(token);
          builder.setOrigin(cfg.origin);
          builder.setCallback(onAnswer);
          builder.build().setVisible(true);
        } catch {
          reject(pickError('picker-failed'));
        }
      });
    },
  };
}

/** One pick {@link FakeDrivePicker} was asked for. */
export interface FakeDrivePickerCall {
  token: string;
  fileIds?: string[];
}

/**
 * A {@link DrivePicker} for tests of everything above it. Each pick takes the
 * next queued answer ({@link answerNext}): a file (the user chose it), null
 * (closed) or a {@link DriveError}; with none queued the user closes the
 * Picker. Choosing a file grants it to the app in Drive, so `onPicked` — wired
 * to `InMemoryDriveGateway.grant` — is told the id. Opened on `fileIds`, the
 * Picker shows only those files, so answering another is a mistake in the test
 * and throws. Every call is appended to {@link calls}.
 */
export class FakeDrivePicker implements DrivePicker {
  /** Every pick asked for, in order. */
  readonly calls: FakeDrivePickerCall[] = [];
  private readonly answers: Array<DrivePicked | null | DriveError> = [];
  private readonly onPicked?: (id: string) => void;

  constructor(opts: { onPicked?: (id: string) => void } = {}) {
    this.onPicked = opts.onPicked;
  }

  /** What the next picks answer, in order. */
  answerNext(...answers: Array<DrivePicked | null | DriveError>): void {
    this.answers.push(...answers);
  }

  async pick(opts: { token: string; fileIds?: string[] }): Promise<DrivePicked | null> {
    this.calls.push({ token: opts.token, ...(opts.fileIds !== undefined ? { fileIds: [...opts.fileIds] } : {}) });
    checkFileIds(opts.fileIds);
    const answer = this.answers.length > 0 ? this.answers.shift()! : null;
    if (answer instanceof DriveError) throw answer;
    if (answer === null) return null;
    if (opts.fileIds !== undefined && !opts.fileIds.includes(answer.id)) {
      throw new Error(`FakeDrivePicker: ${answer.id} is not among the files the Picker was opened on`);
    }
    this.onPicked?.(answer.id);
    return { ...answer };
  }
}
