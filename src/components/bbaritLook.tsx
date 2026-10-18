import React from 'react';
import type { DesignLogEntry } from './useDesignAgent';

// Shared visual language for BBARIT Design / BBARIT Cowork. The look is
// derived from the active app theme so the panels always match the terminal,
// with the BBARIT brand red as the fixed accent.

export interface BbaritLook {
  bg: string;
  rail: string;
  card: string;
  ink: string;
  soft: string;
  muted: string;
  faint: string;
  border: string;
  borderSoft: string;
  accent: string;
  accentDeep: string;
  accentSoft: string;
  bubble: string;
  canvas: string;
  serif: string;
  sans: string;
}

export const BRAND_RED = '#DE2A44';

export function makeLook(t: { bg: string; text: string; accent?: string }): BbaritLook {
  const ink = t.text;
  return {
    bg: t.bg,
    rail: `${ink}07`,
    card: `${ink}0a`,
    ink,
    soft: `${ink}d9`,
    muted: `${ink}99`,
    faint: `${ink}59`,
    border: `${ink}22`,
    borderSoft: `${ink}14`,
    accent: BRAND_RED,
    accentDeep: '#B81F35',
    accentSoft: `${BRAND_RED}26`,
    bubble: `${ink}12`,
    canvas: `${ink}0d`,
    serif: 'inherit',
    sans: 'inherit',
  };
}

// BBARIT logomark.
export function BrandMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <img src="/icons/bbarit-logo.png" alt="" aria-hidden="true" className={className}
      style={{ width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.22)), display: 'block', flexShrink: 0 }} />
  );
}

// One chat row: user in a soft bubble, the agent as plain prose, tools as
// small red-dotted activity lines.
export function ChatRow({ entry, L }: { entry: DesignLogEntry; L: BbaritLook }) {
  if (entry.role === 'you') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '85%', background: L.bubble, color: L.ink,
        borderRadius: 14, padding: '8px 13px', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
        {entry.text}
      </div>
    );
  }
  if (entry.role === 'sys') {
    return <div style={{ fontSize: 10.5, color: L.faint, textAlign: 'center' }}>{entry.text}</div>;
  }
  if (entry.role === 'tool') {
    return (
      <div style={{ fontSize: 11, color: L.muted, display: 'flex', gap: 7, alignItems: 'baseline', minWidth: 0 }}>
        <span style={{ color: L.accent, fontSize: 9 }}>⏺</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.text}</span>
      </div>
    );
  }
  return (
    <div style={{ alignSelf: 'stretch', color: L.ink, fontSize: 13.5, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
      {entry.text}
    </div>
  );
}

// Pulsing logomark shown while the agent is working.
export function Thinking({ label, L }: { label: string; L: BbaritLook }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: L.muted, fontSize: 12 }}>
      <style>{`@keyframes bbaritPulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.72); opacity: 0.55; } }`}</style>
      <span style={{ display: 'inline-flex', animation: 'bbaritPulse 1.6s ease-in-out infinite' }}><BrandMark size={14} /></span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  );
}

// Compact pill showing the bbarit-agent model; click to cycle.
export function ModelChip({ model, onCycle, L, style }: { model: string; onCycle: () => void; L: BbaritLook; style?: React.CSSProperties }) {
  return (
    <button type="button" onClick={onCycle} title="Switch agent model"
      style={{ padding: '3px 9px', borderRadius: 999, border: `1px solid ${L.border}`, background: 'transparent',
        color: L.muted, fontSize: 10, fontWeight: 700, cursor: 'pointer', maxWidth: 130,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...style }}>
      {model || 'model: auto'}
    </button>
  );
}
