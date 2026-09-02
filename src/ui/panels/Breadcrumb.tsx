/**
 * Breadcrumb — the containment path of the current selection, from root to the
 * selected element, as clickable segments. A quiet, always-visible location
 * indicator above the center view; clicking a segment selects that ancestor
 * (which the Explorer then reveals). Reads the live model + `rev` like the
 * Explorer, so it tracks renames and moves.
 */

import { useAppStore } from '../store';
import type { ElementRecord } from '@core/index';
import './panels.css';

function label(el: ElementRecord): string {
  return el.declaredName || el.declaredShortName || `«${el.eClass}»`;
}

export function Breadcrumb(): JSX.Element {
  const rev = useAppStore((s) => s.rev);
  void rev;
  const model = useAppStore((s) => s.model);
  const selectionId = useAppStore((s) => s.selectionId);
  const select = useAppStore((s) => s.select);
  const setHover = useAppStore((s) => s.setHover);

  const el = selectionId ? model.get(selectionId) : undefined;
  if (!el) {
    return (
      <nav className="breadcrumb breadcrumb-empty" data-testid="breadcrumb" aria-label="Selection path">
        No selection
      </nav>
    );
  }
  // ancestors() is nearest-first; reverse to root→…→owner, then append self.
  const path = [...model.ancestors(el.id)].reverse();
  path.push(el);

  return (
    <nav
      className="breadcrumb"
      data-testid="breadcrumb"
      aria-label="Selection path"
      onMouseLeave={() => setHover(null)}
    >
      {path.map((p, i) => (
        <span key={p.id} className="breadcrumb-seg">
          {i > 0 && (
            <span className="breadcrumb-sep" aria-hidden>
              ›
            </span>
          )}
          <button
            className={`breadcrumb-item${p.id === selectionId ? ' is-current' : ''}`}
            data-testid="breadcrumb-item"
            data-element-id={p.id}
            title={`«${p.eClass}» ${label(p)}`}
            onClick={() => select(p.id)}
            onMouseEnter={() => setHover(p.id)}
          >
            {label(p)}
          </button>
        </span>
      ))}
    </nav>
  );
}

export default Breadcrumb;
