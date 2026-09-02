/**
 * useContextMenuChrome — shared behavior for the canvas context menus
 * (node / edge / pane): clamp the fixed-position menu into the viewport (so
 * items never render off-screen for an element near a canvas edge) and close it
 * on an outside mousedown, Escape, or a scroll/wheel (a fixed-position menu
 * would otherwise float detached from its target once the view moves). Returns
 * the ref to attach to the menu and the clamped `{ left, top }` to position it.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export function useContextMenuChrome(
  x: number,
  y: number,
  onClose: () => void,
): { ref: React.RefObject<HTMLDivElement>; pos: { left: number; top: number } } {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Measure after layout, before paint, so there's no visible jump.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Wheeling the CANVAS zooms/pans it (a CSS transform, not a scroll event),
    // moving the view out from under the fixed-position menu → dismiss it.
    // Scoped to the React Flow canvas on purpose: an UNRELATED panel scroll
    // (notably the Explorer's selection-reveal `scrollIntoView`, which fires on
    // the very same right-click that opens the menu) must NOT close it. Canvas
    // *panning* is a pane mousedown, already handled by `onDown`.
    const onCanvasWheel = (e: WheelEvent): void => {
      const t = e.target instanceof Element ? e.target : null;
      if (ref.current?.contains(t)) return; // inside the menu — ignore
      if (t?.closest('.react-flow')) onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onCanvasWheel, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onCanvasWheel, true);
    };
  }, [onClose]);

  return { ref, pos };
}
