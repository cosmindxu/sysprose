/**
 * The text an edge shows, known to both the layout (which reserves room for it)
 * and the renderer (which draws it). Pure, React-free, so the layout can use it
 * headlessly.
 */

import type { DiagramEdge } from './types';

/** The «keyword» the dependency family shows when an edge has no label of its own. */
const EDGE_KEYWORD: Readonly<Record<string, string>> = {
  include: 'include',
  satisfy: 'satisfy',
  verify: 'verify',
  refine: 'refine',
  derive: 'derive',
  trace: 'trace',
  allocate: 'allocate',
  dependency: 'dependency',
};

/** The keyword an edge of `kind` is labelled with by default, if any. */
export function edgeKeywordFor(kind: string): string | undefined {
  return EDGE_KEYWORD[kind];
}

/** The text drawn on an edge: its own label, else its kind's «keyword» (unless hidden). */
export function edgeLabelText(edge: Pick<DiagramEdge, 'kind' | 'label' | 'hideKeyword'>): string | undefined {
  if (edge.label) return edge.label;
  if (edge.hideKeyword) return undefined;
  const k = edgeKeywordFor(edge.kind);
  return k ? `«${k}»` : undefined;
}

/** How many edges of one keyword kind make its label repetition, not information. */
export const REPEATED_KEYWORD_MIN = 8;

/**
 * Whether a diagram should drop its «keyword» labels: when every keyword-
 * labelled edge in it is of ONE kind and there are at least
 * {@link REPEATED_KEYWORD_MIN} of them. Then the label says nothing the line
 * style and the legend do not — the requirement view's 98 «satisfy» labels, say
 * — and leaving it off lets the layout join the lines (Sun & Wong C1, C3). A
 * diagram that mixes kinds (satisfy beside allocate beside trace) keeps them:
 * there the label is what tells the lines apart.
 */
export function keywordLabelsAreRepetition(edges: Pick<DiagramEdge, 'kind' | 'label'>[]): boolean {
  const kinds = new Map<string, number>();
  for (const e of edges) {
    if (e.label) continue;
    const k = edgeKeywordFor(e.kind);
    if (k) kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  return kinds.size === 1 && [...kinds.values()][0]! >= REPEATED_KEYWORD_MIN;
}
