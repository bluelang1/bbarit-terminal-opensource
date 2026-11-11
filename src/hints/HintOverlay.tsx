import { createPortal } from 'react-dom';
import type { HintDataKind, HintPlacement } from './hintTargets';

export interface HintBadge {
  label: string;
  x: number;
  y: number;
  placement: HintPlacement;
  dataKind: HintDataKind;
}

/**
 * One fixed, click-through layer over the whole window with a badge per hint.
 * Every visual value lives in CSS custom properties on `.hint-overlay` (App.css).
 * Badges whose label does not start with the typed prefix are hidden; the typed
 * part of the others is marked so it can be styled.
 */
export function HintOverlay({ badges, typed }: { badges: readonly HintBadge[]; typed: string }) {
  if (badges.length === 0 || typeof document === 'undefined') return null;
  return createPortal(
    <div className="hint-overlay" data-hint-overlay="" aria-hidden="true">
      {badges.map((badge) => {
        const matches = badge.label.startsWith(typed);
        return (
          <span
            key={badge.label}
            className="hint-badge"
            data-kind={badge.dataKind}
            data-placement={badge.placement}
            data-hidden={matches ? undefined : 'true'}
            style={{ left: badge.x, top: badge.y }}
          >
            {typed && matches ? <span className="hint-badge-typed">{typed}</span> : null}
            {matches ? badge.label.slice(typed.length) : badge.label}
          </span>
        );
      })}
    </div>,
    document.body,
  );
}
