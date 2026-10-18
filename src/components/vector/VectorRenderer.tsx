import React from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  resolveInstance, vNodeBBox,
  type VFrameNode, type VNode, type VScene, type VSizingMode,
} from './VectorDoc';

// P1 read-only renderer: each scene node becomes real DOM and the browser's
// flexbox does the auto-layout (no bespoke layout solver — see
// docs/DESIGN-VECTOR-ENGINE.md). Rendering is pure; editing overlays arrive
// in P2 and will measure these elements instead of re-computing layout.

const FONT_STACK = "-apple-system, 'Pretendard', 'Noto Sans KR', sans-serif";

function sizeStyle(mode: VSizingMode, px: number | undefined, axis: 'w' | 'h'): React.CSSProperties {
  const prop = axis === 'w' ? 'width' : 'height';
  if (mode === 'fill') return { flex: 1, alignSelf: 'stretch', minWidth: 0, minHeight: 0 };
  if (mode === 'hug' || px === undefined) return { [prop]: 'fit-content' } as React.CSSProperties;
  return { [prop]: px } as React.CSSProperties;
}

function placement(n: VNode, insideFree: boolean): React.CSSProperties {
  // free-frame children (and roots) are absolutely positioned; flex children flow.
  if (!insideFree) return {};
  return { position: 'absolute', left: n.x ?? 0, top: n.y ?? 0 };
}

const MAIN: Record<VFrameNode['alignMain'], string> = {
  start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between',
};
const CROSS: Record<VFrameNode['alignCross'], string> = {
  start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch',
};

export function VectorNodeView({ node, scene, assetBase, insideFree }: {
  node: VNode;
  scene: VScene;
  assetBase: string;
  insideFree: boolean;
}) {
  if (node.visible === false) return null;

  if (node.type === 'vinstance') {
    const resolved = resolveInstance(scene, node);
    if (!resolved) return null;
    return <VectorNodeView node={resolved} scene={scene} assetBase={assetBase} insideFree={insideFree} />;
  }

  if (node.type === 'vframe') {
    const [pt, pr, pb, pl] = node.padding;
    const flex: React.CSSProperties = node.layout === 'free'
      ? { position: 'relative' }
      : { display: 'flex', flexDirection: node.layout, gap: node.gap,
          justifyContent: MAIN[node.alignMain], alignItems: CROSS[node.alignCross] };
    return (
      <div data-vid={node.id} style={{
        ...placement(node, insideFree),
        ...sizeStyle(node.sizing.w, node.w, 'w'),
        ...sizeStyle(node.sizing.h, node.h, 'h'),
        ...flex,
        padding: `${pt}px ${pr}px ${pb}px ${pl}px`,
        background: node.fill,
        borderRadius: node.radius,
        overflow: node.clip ? 'hidden' : 'visible',
        boxSizing: 'border-box',
        ...(node.stroke ? { border: `${node.strokeW ?? 1}px solid ${node.stroke}` } : {}),
      }}>
        {node.children.map((c) => (
          <VectorNodeView key={c.id} node={c} scene={scene} assetBase={assetBase} insideFree={node.layout === 'free'} />
        ))}
      </div>
    );
  }

  if (node.type === 'vtext') {
    return (
      <div data-vid={node.id} style={{
        ...placement(node, insideFree),
        ...sizeStyle(node.sizing.w, node.w, 'w'),
        ...sizeStyle(node.sizing.h, node.h, 'h'),
        fontFamily: node.font || FONT_STACK,
        fontSize: node.size,
        fontWeight: node.weight,
        color: node.color,
        lineHeight: node.lineHeight,
        textAlign: node.align,
        whiteSpace: 'pre-wrap',
        wordBreak: 'keep-all',
        boxSizing: 'border-box',
      }}>
        {node.text}
      </div>
    );
  }

  if (node.type === 'vbox') {
    return (
      <div data-vid={node.id} style={{
        ...placement(node, insideFree),
        ...sizeStyle(node.sizing.w, node.w, 'w'),
        ...sizeStyle(node.sizing.h, node.h, 'h'),
        background: node.fill,
        borderRadius: node.radius,
        boxSizing: 'border-box',
        ...(node.stroke ? { border: `${node.strokeW ?? 1}px solid ${node.stroke}` } : {}),
      }} />
    );
  }

  if (node.type === 'vimage') {
    return (
      <img data-vid={node.id} alt={node.name || node.file} draggable={false}
        src={convertFileSrc(`${assetBase}/${node.file}`)}
        style={{
          ...placement(node, insideFree),
          ...sizeStyle(node.sizing.w, node.w, 'w'),
          ...sizeStyle(node.sizing.h, node.h, 'h'),
          objectFit: node.fit,
          borderRadius: node.radius,
          display: 'block',
          boxSizing: 'border-box',
        }} />
    );
  }

  // vpath
  const b = vNodeBBox(node);
  const pad = Math.max(2, node.strokeW);
  const rel = node.points.map(([px, py]) => `${px - b.x + pad},${py - b.y + pad}`).join(' ');
  return (
    <svg data-vid={node.id} width={b.w + pad * 2} height={b.h + pad * 2}
      style={{ ...placement(node, insideFree), overflow: 'visible', display: 'block' }}>
      {node.closed
        ? <polygon points={rel} fill={node.fill} stroke={node.stroke} strokeWidth={node.strokeW} strokeLinejoin="round" />
        : <polyline points={rel} fill={node.fill === 'none' ? 'none' : node.fill} stroke={node.stroke}
            strokeWidth={node.strokeW} strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

// A scene root placed on the pan/zoom canvas layer, styled like the HTML
// frames (name label + white sheet) so both kinds live side by side.
export function VectorRootView({ node, scene, assetBase, label, muted }: {
  node: VNode;
  scene: VScene;
  assetBase: string;
  label: string;
  muted: string;
}) {
  const b = vNodeBBox(node);
  return (
    <div style={{ position: 'absolute', left: b.x, top: b.y, width: b.w }}>
      <div style={{ fontSize: 30, color: muted, marginBottom: 12, fontWeight: 600, userSelect: 'none',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        ◆ {label}
      </div>
      <div style={{ width: b.w, height: b.h, position: 'relative', background: '#fff', borderRadius: 4,
        overflow: 'hidden', boxShadow: '0 2px 14px rgba(0,0,0,.12)', pointerEvents: 'none' }}>
        <VectorNodeView node={{ ...node, x: 0, y: 0 }} scene={scene} assetBase={assetBase} insideFree={true} />
      </div>
    </div>
  );
}
