/**
 * Phase 2.2: Split Tree View
 *
 * Recursive renderer for the SplitNode tree.
 * Each leaf renders its terminal; branches render two children
 * separated by a draggable divider.
 */

import React, { useCallback, useRef } from 'react';
import { type SplitNode, type SplitBranch } from './SplitTree';
import { SplitDivider } from './SplitDivider';

interface SplitTreeViewProps {
  node: SplitNode;
  /** Render function for a leaf terminal. */
  renderLeaf: (leafId: string) => React.ReactNode;
  /** Called when a branch's ratio changes via divider drag. */
  onRatioChange: (path: number[], newRatio: number) => void;
  /** Called on divider double-click (equalize). */
  onEqualize: (path: number[]) => void;
  /** Current path in the tree (for nested ratio updates). */
  path?: number[];
  accentColor?: string;
}

export function SplitTreeView({
  node,
  renderLeaf,
  onRatioChange,
  onEqualize,
  path = [],
  accentColor,
}: SplitTreeViewProps) {
  if (node.type === 'leaf') {
    return (
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {renderLeaf(node.id)}
      </div>
    );
  }

  return (
    <SplitBranchView
      branch={node}
      renderLeaf={renderLeaf}
      onRatioChange={onRatioChange}
      onEqualize={onEqualize}
      path={path}
      accentColor={accentColor}
    />
  );
}

interface SplitBranchViewProps {
  branch: SplitBranch;
  renderLeaf: (leafId: string) => React.ReactNode;
  onRatioChange: (path: number[], newRatio: number) => void;
  onEqualize: (path: number[]) => void;
  path: number[];
  accentColor?: string;
}

function SplitBranchView({
  branch,
  renderLeaf,
  onRatioChange,
  onEqualize,
  path,
  accentColor,
}: SplitBranchViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isHorizontal = branch.direction === 'horizontal';

  const handleDrag = useCallback((delta: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const totalSize = isHorizontal ? rect.width : rect.height;
    if (totalSize <= 0) return;
    const ratioDelta = delta / totalSize;
    const newRatio = Math.max(0.1, Math.min(0.9, branch.ratio + ratioDelta));
    onRatioChange(path, newRatio);
  }, [branch.ratio, isHorizontal, onRatioChange, path]);

  const handleEqualize = useCallback(() => {
    onEqualize(path);
  }, [onEqualize, path]);

  const firstPercent = `${branch.ratio * 100}%`;
  const secondPercent = `${(1 - branch.ratio) * 100}%`;

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: isHorizontal ? 'row' : 'column',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div style={{
        [isHorizontal ? 'width' : 'height']: firstPercent,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      }}>
        <SplitTreeView
          node={branch.first}
          renderLeaf={renderLeaf}
          onRatioChange={onRatioChange}
          onEqualize={onEqualize}
          path={[...path, 0]}
          accentColor={accentColor}
        />
      </div>

      <SplitDivider
        direction={branch.direction}
        onDrag={handleDrag}
        onDoubleClick={handleEqualize}
        accentColor={accentColor}
      />

      <div style={{
        [isHorizontal ? 'width' : 'height']: secondPercent,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      }}>
        <SplitTreeView
          node={branch.second}
          renderLeaf={renderLeaf}
          onRatioChange={onRatioChange}
          onEqualize={onEqualize}
          path={[...path, 1]}
          accentColor={accentColor}
        />
      </div>
    </div>
  );
}
