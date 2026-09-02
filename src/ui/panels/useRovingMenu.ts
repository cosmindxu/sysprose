/**
 * useRovingMenu — shared roving-tabindex keyboard behavior + focus lifecycle for
 * menus, used by BOTH the canvas context menus (node · pane) and the toolbar
 * dropdowns so keyboard handling is identical across the app.
 *
 * Given the menu container's ref, while `active` it:
 *  - moves focus to the first `[data-menuitem]` when the menu opens, so keyboard
 *    users land inside it;
 *  - keeps ONLY the focused item tab-stoppable (roving tabindex — the others get
 *    tabindex -1), and RE-APPLIES that as items mount/unmount/enable (a
 *    MutationObserver), so the single-Tab-stop invariant survives dynamic menus
 *    (clipboard-dependent Paste, context-disabled export items, …);
 *  - moves the active item with ↑/↓ (wrapping) and Home/End;
 *  - CLOSES the menu when focus Tabs out of it (APG menu behavior); and
 *  - RESTORES focus to the element that opened the menu when it closes (the
 *    toolbar trigger, or the right-clicked canvas node) — so a keyboard user's
 *    place is never dropped to `<body>`.
 *
 * `[data-menuitem]` (not `[role=menuitem]`) is the item selector so the canvas
 * context menus — which are hybrid widgets (buttons + a metaclass `<select>` + a
 * transient rename `<input>`) and are therefore NOT `role="menu"` — can share the
 * exact same hook as the all-`menuitem` toolbar dropdowns. Arrow keys are ignored
 * while a text input / native `<select>` inside the menu holds focus, so renaming
 * and option-picking keep their native handling; those controls stay Tab-reachable.
 * Escape / outside-click / wheel dismissal stays with each menu's own chrome.
 */

import { useEffect } from 'react';

export function useRovingMenu(
  ref: React.RefObject<HTMLElement>,
  onClose: () => void,
  active = true,
): void {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const itemsOf = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>('[data-menuitem]:not([disabled])')).filter(
        (el) => el.offsetParent !== null,
      );

    const setRoving = (activeEl: HTMLElement, list: HTMLElement[]): void => {
      for (const el of list) el.tabIndex = el === activeEl ? 0 : -1;
    };

    // Remember who opened the menu so focus can return there on close.
    const opener = document.activeElement as HTMLElement | null;

    const initial = itemsOf();
    if (initial.length > 0) {
      setRoving(initial[0], initial);
      initial[0].focus();
    }

    // Re-seat the roving tabindex whenever the item set changes (a Paste item
    // mounts, an export item enables, the rename button remounts) so we never
    // leave two Tab stops. Keeps the current rover if it's still present.
    const observer = new MutationObserver(() => {
      const list = itemsOf();
      if (list.length === 0) return;
      const rover = list.find((el) => el.tabIndex === 0) ?? list[0];
      setRoving(rover, list);
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });

    const onKey = (e: KeyboardEvent): void => {
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      // Let a focused text input / native select handle its own arrow keys.
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') {
        return;
      }
      const list = itemsOf();
      if (list.length === 0) return;
      e.preventDefault();
      const cur = ae ? list.indexOf(ae) : -1;
      let next: number;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = list.length - 1;
      else if (e.key === 'ArrowDown') next = cur < 0 ? 0 : (cur + 1) % list.length;
      else next = cur < 0 ? list.length - 1 : (cur - 1 + list.length) % list.length;
      setRoving(list[next], list);
      list[next].focus();
    };

    // APG: Tab out of the menu closes it. Only close when focus lands on a real
    // element OUTSIDE the container — a null relatedTarget (an internal unmount
    // dropping focus to <body>, e.g. cancelling a rename) must NOT close it.
    const onFocusOut = (e: FocusEvent): void => {
      const next = e.relatedTarget as Node | null;
      if (next && !container.contains(next)) onClose();
    };

    container.addEventListener('keydown', onKey);
    container.addEventListener('focusout', onFocusOut);
    return () => {
      observer.disconnect();
      container.removeEventListener('keydown', onKey);
      container.removeEventListener('focusout', onFocusOut);
      // Return focus to the opener IFF the menu still owned focus (or focus fell
      // to <body> on unmount). If the user moved focus elsewhere (Tab / outside
      // click landing on another control), leave it there.
      const ae = document.activeElement;
      if (
        opener &&
        opener.isConnected &&
        (ae == null || ae === document.body || container.contains(ae))
      ) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [ref, active, onClose]);
}
