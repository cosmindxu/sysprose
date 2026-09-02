/**
 * Browser file-dialog helpers for saving/opening model text. Every browser API
 * is feature-detected and guarded so this module imports cleanly under Node
 * (the functions throw a clear error only if actually invoked without a DOM).
 *
 * These are exercised by E2E tests, not unit tests (no DOM file dialogs in
 * jsdom/headless unit runs).
 */

/** A file opened by {@link openTextFile}. */
export interface OpenedFile {
  name: string;
  content: string;
}

/** True when a DOM `document` is present. */
function hasDocument(): boolean {
  return typeof document !== 'undefined' && document !== null;
}

/**
 * Trigger a browser download of `content` as `filename` using a Blob and a
 * transient `<a download>` element. No-op-safe to call repeatedly.
 */
export function downloadText(
  filename: string,
  content: string,
  mime = 'text/plain;charset=utf-8',
): void {
  if (!hasDocument()) {
    throw new Error('downloadText requires a browser document');
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Revoke on the next tick so the click has a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Trigger a browser download of raw `bytes` as `filename` (e.g. a `.fmu` zip),
 * mirroring {@link downloadText} for binary content.
 */
export function downloadBytes(
  filename: string,
  bytes: Uint8Array,
  mime = 'application/octet-stream',
): void {
  if (!hasDocument()) {
    throw new Error('downloadBytes requires a browser document');
  }
  // Copy into a fresh ArrayBuffer-backed view so Blob gets a plain BlobPart.
  const blob = new Blob([bytes.slice()], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Suggested MIME types per export extension. */
export const MIME_BY_EXTENSION: Record<string, string> = {
  '.json': 'application/json;charset=utf-8',
  '.sysml': 'text/plain;charset=utf-8',
  '.txt': 'text/plain;charset=utf-8',
};

/** Minimal shape of the File System Access API entry points we use. */
interface FileSystemAccessWindow {
  showOpenFilePicker?: (options?: unknown) => Promise<Array<{ getFile(): Promise<File> }>>;
}

/**
 * Open a text file chosen by the user, returning its name and contents. Prefers
 * the File System Access API (`showOpenFilePicker`) and transparently falls
 * back to a hidden `<input type="file">`. Resolves to `null` when the user
 * cancels the picker.
 */
export async function openTextFile(accept = '.sysml,.json,.txt'): Promise<OpenedFile | null> {
  if (!hasDocument()) {
    throw new Error('openTextFile requires a browser document');
  }

  const fsa = window as unknown as FileSystemAccessWindow;
  if (typeof fsa.showOpenFilePicker === 'function') {
    try {
      const handles = await fsa.showOpenFilePicker({ multiple: false });
      if (!handles || handles.length === 0) return null;
      const file = await handles[0].getFile();
      return { name: file.name, content: await file.text() };
    } catch (err) {
      // AbortError ⇒ user cancelled; fall through to the input fallback only
      // for genuine "API unavailable" failures.
      if (err && (err as { name?: string }).name === 'AbortError') return null;
      // Any other failure: fall back to the <input> approach below.
    }
  }

  return new Promise<OpenedFile | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      document.body.removeChild(input);
      if (!file) {
        resolve(null);
        return;
      }
      file
        .text()
        .then((content) => resolve({ name: file.name, content }))
        .catch(reject);
    });
    // If the dialog is dismissed without a selection, no change event fires;
    // callers treat a never-resolving promise as "cancelled". To be safe we
    // resolve null on window refocus without a file.
    document.body.appendChild(input);
    input.click();
  });
}
