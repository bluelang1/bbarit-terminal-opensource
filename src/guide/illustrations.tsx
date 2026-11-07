// Phase-1 demo media for the getting-started guide: one small CSS/SVG mock per
// step, animated in src/pages/GuidePage.css (motion stops under
// prefers-reduced-motion). Phase 2 may swap these for recorded clips.
import type { ReactNode } from 'react';
import type { GuideStepId } from './steps';

function WindowFrame({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`gi-window ${className}`}>
      <div className="gi-window-bar">
        <span className="gi-dot gi-dot-r" />
        <span className="gi-dot gi-dot-y" />
        <span className="gi-dot gi-dot-g" />
      </div>
      {children}
    </div>
  );
}

function TermLines({ count = 4, className = '' }: { count?: number; className?: string }) {
  return (
    <div className={`gi-term ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="gi-term-line" style={{ width: `${48 + ((i * 37) % 45)}%` }} />
      ))}
    </div>
  );
}

function ProjectIllustration() {
  return (
    <WindowFrame>
      <div className="gi-tabs">
        <span className="gi-tab gi-tab-a">api</span>
        <span className="gi-tab gi-tab-b">web</span>
        <span className="gi-tab gi-tab-new">my-app</span>
        <span className="gi-plus">+</span>
      </div>
      <div className="gi-folder-drop">
        <svg viewBox="0 0 48 40" width="54" height="45" aria-hidden="true">
          <path d="M2 8a4 4 0 0 1 4-4h12l5 5h19a4 4 0 0 1 4 4v21a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" fill="#f5b942" />
          <path d="M2 15h44v19a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" fill="#fcd27a" />
        </svg>
        <span className="gi-folder-name">~/my-app</span>
      </div>
      <TermLines count={3} className="gi-term-faint" />
    </WindowFrame>
  );
}

function AiTerminalIllustration() {
  return (
    <WindowFrame>
      <div className="gi-tabs">
        <span className="gi-tab gi-tab-a">zsh</span>
        <span className="gi-spark">✨<small>▾</small></span>
      </div>
      <div className="gi-menu">
        <span className="gi-menu-item">Claude</span>
        <span className="gi-menu-item">Claude (new)</span>
        <span className="gi-menu-item">Codex</span>
        <span className="gi-menu-item">Gemini</span>
      </div>
      <TermLines count={3} className="gi-term-faint" />
    </WindowFrame>
  );
}

function StatusIllustration() {
  return (
    <WindowFrame>
      <div className="gi-tabs gi-tabs-status">
        <span className="gi-tab gi-tab-status"><i className="gi-status gi-status-busy" />Claude</span>
        <span className="gi-tab gi-tab-status"><i className="gi-status gi-status-blocked" />Codex</span>
        <span className="gi-tab gi-tab-status"><i className="gi-status gi-status-done" />Gemini</span>
      </div>
      <div className="gi-approval">
        <span className="gi-approval-icon">!</span>
        <span className="gi-approval-text" />
        <span className="gi-approval-btn">Allow</span>
      </div>
      <TermLines count={3} />
    </WindowFrame>
  );
}

function KeepRunningIllustration() {
  return (
    <div className="gi-keep">
      <WindowFrame className="gi-keep-window">
        <TermLines count={4} />
      </WindowFrame>
      <div className="gi-keep-bg">
        <span className="gi-keep-badge"><i className="gi-status gi-status-busy" /> running</span>
        <div className="gi-keep-scroll">
          <TermLines count={8} className="gi-term-scroll" />
        </div>
      </div>
    </div>
  );
}

function GitKeysIllustration() {
  return (
    <div className="gi-git">
      <div className="gi-git-panel">
        <div className="gi-git-head">
          <span className="gi-git-title">Git</span>
          <span className="gi-git-ext" title="Repository page">↗</span>
        </div>
        <div className="gi-git-row"><b className="gi-add">M</b><span className="gi-git-file" /><em>+12 −3</em></div>
        <div className="gi-git-row"><b className="gi-add">A</b><span className="gi-git-file gi-short" /><em>+40</em></div>
        <div className="gi-git-row"><b className="gi-del">D</b><span className="gi-git-file gi-shorter" /><em>−18</em></div>
      </div>
      <div className="gi-keys">
        <span className="gi-key gi-key-1">Enter</span>
        <span className="gi-key gi-key-2">⇧ Enter</span>
        <span className="gi-key gi-key-3">⌘ Enter</span>
      </div>
    </div>
  );
}

// 8x8 pixel octopus, two frames for the walk cycle.
const OCTO_BODY = [
  '..oooo..',
  '.oxxxxo.',
  'oxwxxwxo',
  'oxxxxxxo',
  'oxxxxxxo',
  '.oxxxxo.',
];
const OCTO_LEGS = ['o.o..o.o', '.o.oo.o.'];

function PixelOcto({ frame }: { frame: 0 | 1 }) {
  const rows = [...OCTO_BODY, OCTO_LEGS[frame]];
  const fill: Record<string, string> = { o: '#3b1f47', x: '#ff7aa8', w: '#fff8ec' };
  return (
    <g className={`gi-octo-frame gi-octo-frame-${frame}`}>
      {rows.flatMap((row, y) =>
        row.split('').map((c, x) => (c === '.' ? null : <rect key={`${x}-${y}`} x={x} y={y} width="1.02" height="1.02" fill={fill[c]} />)),
      )}
    </g>
  );
}

function PetIllustration() {
  return (
    <div className="gi-desk">
      <div className="gi-desk-sun" />
      <div className="gi-pet-walker">
        <span className="gi-pet-bubble">done!</span>
        <svg className="gi-pet" viewBox="0 0 8 7" width="56" height="49" shapeRendering="crispEdges" aria-hidden="true">
          <PixelOcto frame={0} />
          <PixelOcto frame={1} />
        </svg>
      </div>
      <div className="gi-dock">
        <span /><span /><span className="gi-dock-app" /><span />
      </div>
    </div>
  );
}

export function StepIllustration({ id }: { id: GuideStepId }) {
  switch (id) {
    case 'project': return <ProjectIllustration />;
    case 'ai-terminal': return <AiTerminalIllustration />;
    case 'status': return <StatusIllustration />;
    case 'keep-running': return <KeepRunningIllustration />;
    case 'git-keys': return <GitKeysIllustration />;
    case 'pet': return <PetIllustration />;
  }
}
