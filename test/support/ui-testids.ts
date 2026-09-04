/**
 * Every test id the app can actually render, read out of the source.
 *
 * WHY IT IS SHARED. Two documents make the same kind of claim — the user
 * guide's control appendix and the README's capability table both name controls
 * by the `data-testid` a test can find them by — and both are only as honest as
 * the scan behind them. One scan, in one place, so a subtlety fixed for one
 * document cannot stay broken for the other.
 *
 * The subtlety, learned the hard way: a general `id: '…'` scan was tried and
 * REMOVED. `commands.ts` gives every toolbar command an `id` that mirrors its
 * `data-testid`, so the scan accepted the mirror as proof of the original —
 * renaming `data-testid="tb-validate"` left the guard green because
 * `id: 'tb-validate'` was still in `commands.ts`. The ids here are sourced from
 * something the DOM actually gets.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(root(p), 'utf8');

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
export function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(root(dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Ids the two view-command tables declare, which the view bar renders verbatim.
 *
 * The view buttons are the one place an id reaches the DOM without ever being
 * written as `data-testid="…"`: `Toolbar.tsx` merges {@link VIEW_COMMANDS} with
 * its own `EXTRA_VIEW_COMMANDS` and renders `data-testid={meta.id}`. So the
 * declaration IS the id, and the two arrays are read here — the indirection is
 * asserted by the callers rather than assumed, because an id that is only a
 * string in a list nobody renders is exactly the fiction this scan exists to
 * catch.
 */
export function viewBarTestIds(): Set<string> {
  const ids = new Set<string>();
  for (const [file, decl] of [
    ['src/ui/commands.ts', 'VIEW_COMMANDS'],
    ['src/ui/panels/Toolbar.tsx', 'EXTRA_VIEW_COMMANDS'],
  ] as const) {
    const body = new RegExp(`const ${decl}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`).exec(read(file));
    if (!body) throw new Error(`${file} no longer declares ${decl} as an array literal`);
    for (const m of body[1].matchAll(/\bid:\s*'([a-z0-9-]+)'/g)) ids.add(m[1]);
  }
  return ids;
}

/**
 * Every test id the app can render.
 *
 * Two spellings reach the DOM directly: the JSX attribute itself, and a `testid`
 * prop passed down to a wrapper that renders it (`ScrollBox`, the toolbar's
 * export menu). The view renderers under `src/diagram` carry their own ids
 * (`grid-view`, `sequence-view`), so they are scanned too, plus the view-bar
 * ids from {@link viewBarTestIds}.
 */
export function renderedTestIds(): Set<string> {
  const ids = viewBarTestIds();
  for (const file of [...sources('src/ui'), ...sources('src/diagram')]) {
    const src = readFileSync(root(file), 'utf8');
    for (const m of src.matchAll(/data-testid="([a-z0-9-]+)"/g)) ids.add(m[1]);
    for (const m of src.matchAll(/\btestid="([a-z0-9-]+)"/g)) ids.add(m[1]);
    for (const m of src.matchAll(/\btestid:\s*'([a-z0-9-]+)'/g)) ids.add(m[1]);
  }
  return ids;
}
