/**
 * Popover — a floating panel anchored to a trigger, rendered in a layer above
 * the whole app so no ancestor can clip it.
 *
 * Why a portal: the toolbar's menus were children of `.toolbar`, whose
 * `overflow-x: auto` forced `overflow-y` to `auto` as well (CSS promotes a
 * visible axis when the other one scrolls). An open Export menu was clipped to
 * the 44 px bar, and the bar scrolled vertically to show it — every toolbar
 * button vanished behind one visible menu row. Rendering into `document.body`
 * with fixed positioning removes the ancestor from the equation entirely.
 *
 * Positioning: below the anchor, left-aligned with it, then clamped so the
 * panel stays inside the viewport with an 8 px margin; if it would run past the
 * bottom it is capped at the space left and scrolls inside itself. Re-placed on
 * resize and on any scroll (capture phase, so a scrolling ancestor counts).
 *
 * The first paint is already placed, from the anchor's rect, and never hidden:
 * `visibility: hidden` for one pass cost the menu its opening focus, because
 * `focus()` on a hidden element does nothing and the roving-menu hook had
 * already run by the time the measured style landed. The layout effect only
 * refines the placement once the panel's own width is known.
 *
 * Dismissal stays with the caller (Escape, outside click, item chosen), because
 * the caller knows what "outside" means — the anchor's wrapper is inside the
 * menu's logical extent even though it is not inside the portal. Use
 * {@link isInside} to test both.
 */

import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

const MARGIN = 8;
const GAP = 4;

export interface PopoverProps {
  /** The element the popover hangs from (usually the trigger button's wrapper). */
  anchor: RefObject<HTMLElement>;
  /** The popover's own element, so callers can hit-test and focus inside it. */
  panelRef: RefObject<HTMLDivElement>;
  className?: string;
  testid?: string;
  role?: string;
  /** `end` aligns the popover's right edge with the anchor's (for triggers near the right edge). */
  align?: 'start' | 'end';
  children: ReactNode;
}

export function Popover({ anchor, panelRef, className, testid, role, align = 'start', children }: PopoverProps): JSX.Element {
  const [style, setStyle] = useState<CSSProperties>(() => {
    const a = anchor.current?.getBoundingClientRect();
    if (!a) return { position: 'fixed', top: MARGIN, left: MARGIN };
    return { position: 'fixed', top: a.bottom + GAP, left: Math.max(MARGIN, a.left), maxHeight: Math.max(120, window.innerHeight - a.bottom - GAP - MARGIN) };
  });

  useLayoutEffect(() => {
    const place = (): void => {
      const a = anchor.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!a || !panel) return;
      const width = panel.offsetWidth;
      const wanted = align === 'end' ? a.right - width : a.left;
      const left = Math.max(MARGIN, Math.min(wanted, window.innerWidth - width - MARGIN));
      const top = a.bottom + GAP;
      setStyle({
        position: 'fixed',
        top,
        left,
        maxHeight: Math.max(120, window.innerHeight - top - MARGIN),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, panelRef, align]);

  return createPortal(
    <div ref={panelRef} className={`popover-layer ${className ?? ''}`} data-testid={testid} role={role} style={style}>
      {children}
    </div>,
    document.body,
  );
}

/** Whether an event target is inside any of the given elements (anchor wrapper, portal panel). */
export function isInside(target: EventTarget | null, ...refs: Array<RefObject<HTMLElement>>): boolean {
  const node = target as Node | null;
  return !!node && refs.some((r) => !!r.current && r.current.contains(node));
}
