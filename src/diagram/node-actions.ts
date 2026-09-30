/**
 * Actions a diagram node can ask for (expand a tree branch, say) without the
 * diagram layer importing the UI store: the canvas registers the handler, the
 * node components call {@link requestNodeAction}.
 */

export type NodeAction = { type: 'tree-toggle'; elementId: string };

let handler: ((a: NodeAction) => void) | null = null;

/** Install the handler (the diagram canvas does, on mount); returns an uninstaller. */
export function setNodeActionHandler(fn: (a: NodeAction) => void): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** Ask for an action; a no-op when no canvas is listening. */
export function requestNodeAction(a: NodeAction): void {
  handler?.(a);
}
