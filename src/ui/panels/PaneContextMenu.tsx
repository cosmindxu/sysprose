/**
 * PaneContextMenu — the right-click menu on EMPTY diagram canvas. Completes the
 * context-menu family (node · edge · pane): create a new top-level element (a
 * metaclass picker) or fit the whole diagram in view. Shares the dismiss/clamp
 * chrome with the node/edge menu.
 */

import { useAppStore } from '../store';
import { useContextMenuChrome } from './useContextMenuChrome';
import { useRovingMenu } from './useRovingMenu';
import { PICKER_GROUPS, keywordFor } from './NodeContextMenu';

export function PaneContextMenu(props: {
  x: number;
  y: number;
  onClose: () => void;
  onFitAll: () => void;
}): JSX.Element {
  const { x, y, onClose, onFitAll } = props;
  const createElement = useAppStore((s) => s.createElement);
  const { ref, pos } = useContextMenuChrome(x, y, onClose);
  useRovingMenu(ref, onClose);

  return (
    <div
      ref={ref}
      className="node-ctx-menu"
      data-testid="pane-ctx-menu"
      role="group"
      aria-label="Canvas actions"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="node-ctx-title">Canvas</div>
      {/* Fit view first so the roving focus (first item) lands at the top, above
          the non-menuitem Add-element <select>. */}
      <button
        className="node-ctx-item"
        data-menuitem=""
        data-testid="pane-ctx-fit"
        onClick={() => {
          onFitAll();
          onClose();
        }}
      >
        <span className="node-ctx-ico" aria-hidden="true">⊡</span>Fit view
      </button>
      <label className="node-ctx-add">
        <span>
          <span className="node-ctx-ico" aria-hidden="true">＋</span>Add element
        </span>
        <select
          className="node-ctx-add-select"
          data-testid="pane-ctx-add"
          defaultValue=""
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const k = e.currentTarget.value;
            // ownerId = null → create at the ROOT (top-level), matching the
            // "empty canvas" gesture; NOT under the current selection (which is
            // what an undefined owner would fall back to).
            if (k) createElement(k, null);
            onClose();
          }}
        >
          <option value="" disabled>
            Kind…
          </option>
          {PICKER_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.kinds.map((k) => (
                <option key={k} value={k}>
                  {keywordFor(k)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
    </div>
  );
}

export default PaneContextMenu;
