/**
 * Phase 2.1: Split Tree data structure
 *
 * Ghostty-inspired binary tree for terminal pane splitting.
 * Each node is either a Leaf (terminal) or a Branch (split container).
 */

export type SplitDirection = 'horizontal' | 'vertical';

export interface SplitLeaf {
  type: 'leaf';
  id: string; // terminal ID
}

export interface SplitBranch {
  type: 'branch';
  direction: SplitDirection;
  ratio: number; // 0.0 to 1.0, size of first child
  first: SplitNode;
  second: SplitNode;
}

export type SplitNode = SplitLeaf | SplitBranch;

// ── Construction ──

export function createLeaf(id: string): SplitLeaf {
  return { type: 'leaf', id };
}

export function createBranch(
  direction: SplitDirection,
  first: SplitNode,
  second: SplitNode,
  ratio: number = 0.5
): SplitBranch {
  return { type: 'branch', direction, ratio: Math.max(0.1, Math.min(0.9, ratio)), first, second };
}

// ── Queries ──

/** Collect all leaf IDs in depth-first order. */
export function collectLeafIds(node: SplitNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)];
}

/** Count total leaves. */
export function countLeaves(node: SplitNode): number {
  if (node.type === 'leaf') return 1;
  return countLeaves(node.first) + countLeaves(node.second);
}

/** Find the leaf matching the given ID. */
export function findLeaf(node: SplitNode, id: string): SplitLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  return findLeaf(node.first, id) || findLeaf(node.second, id);
}

// ── Mutations (immutable) ──

/**
 * Split a leaf into two: the existing leaf and a new leaf.
 * Returns a new tree with the split applied.
 */
export function splitLeaf(
  tree: SplitNode,
  targetId: string,
  newId: string,
  direction: SplitDirection
): SplitNode {
  if (tree.type === 'leaf') {
    if (tree.id === targetId) {
      return createBranch(direction, tree, createLeaf(newId));
    }
    return tree;
  }
  const newFirst = splitLeaf(tree.first, targetId, newId, direction);
  const newSecond = splitLeaf(tree.second, targetId, newId, direction);
  if (newFirst === tree.first && newSecond === tree.second) return tree;
  return { ...tree, first: newFirst, second: newSecond };
}

/**
 * Remove a leaf from the tree.
 * Its sibling gets promoted to replace the parent branch.
 */
export function removeLeaf(tree: SplitNode, targetId: string): SplitNode | null {
  if (tree.type === 'leaf') {
    return tree.id === targetId ? null : tree;
  }

  // Check if either direct child is the target leaf
  if (tree.first.type === 'leaf' && tree.first.id === targetId) {
    return tree.second; // Sibling promotion
  }
  if (tree.second.type === 'leaf' && tree.second.id === targetId) {
    return tree.first; // Sibling promotion
  }

  // Recurse into children
  const newFirst = removeLeaf(tree.first, targetId);
  if (newFirst !== tree.first) {
    if (newFirst === null) return tree.second;
    return { ...tree, first: newFirst };
  }

  const newSecond = removeLeaf(tree.second, targetId);
  if (newSecond !== tree.second) {
    if (newSecond === null) return tree.first;
    return { ...tree, second: newSecond };
  }

  return tree;
}

/**
 * Update the ratio of a branch at a specific path.
 * The path is identified by index in depth-first traversal of branches.
 */
export function updateRatio(tree: SplitNode, branchIndex: number, newRatio: number): SplitNode {
  let idx = 0;
  function walk(node: SplitNode): SplitNode {
    if (node.type === 'leaf') return node;
    if (idx === branchIndex) {
      idx++;
      return { ...node, ratio: Math.max(0.1, Math.min(0.9, newRatio)), first: walk(node.first), second: walk(node.second) };
    }
    idx++;
    const newFirst = walk(node.first);
    const newSecond = walk(node.second);
    if (newFirst === node.first && newSecond === node.second) return node;
    return { ...node, first: newFirst, second: newSecond };
  }
  return walk(tree);
}

/** Equalize all ratios to 0.5. */
export function equalize(node: SplitNode): SplitNode {
  if (node.type === 'leaf') return node;
  return { ...node, ratio: 0.5, first: equalize(node.first), second: equalize(node.second) };
}

// ── Focus Navigation ──

export type FocusDirection = 'left' | 'right' | 'up' | 'down';

/**
 * Given the focused leaf id, find the neighboring leaf in the given direction.
 * Returns null if no neighbor exists in that direction.
 */
export function focusNeighbor(
  tree: SplitNode,
  focusedId: string,
  direction: FocusDirection
): string | null {
  // Build a flat layout of all leaves with their bounding rectangles
  const rects: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];

  function layout(node: SplitNode, x: number, y: number, w: number, h: number) {
    if (node.type === 'leaf') {
      rects.push({ id: node.id, x, y, w, h });
      return;
    }
    if (node.direction === 'horizontal') {
      const firstW = w * node.ratio;
      layout(node.first, x, y, firstW, h);
      layout(node.second, x + firstW, y, w - firstW, h);
    } else {
      const firstH = h * node.ratio;
      layout(node.first, x, y, w, firstH);
      layout(node.second, x, y + firstH, w, h - firstH);
    }
  }

  layout(tree, 0, 0, 1, 1);

  const focused = rects.find(r => r.id === focusedId);
  if (!focused) return null;

  const centerX = focused.x + focused.w / 2;
  const centerY = focused.y + focused.h / 2;

  let best: string | null = null;
  let bestDist = Infinity;

  for (const r of rects) {
    if (r.id === focusedId) continue;
    const rcx = r.x + r.w / 2;
    const rcy = r.y + r.h / 2;

    let valid = false;
    let dist = 0;

    switch (direction) {
      case 'left':
        valid = rcx < centerX;
        dist = centerX - rcx + Math.abs(centerY - rcy) * 0.5;
        break;
      case 'right':
        valid = rcx > centerX;
        dist = rcx - centerX + Math.abs(centerY - rcy) * 0.5;
        break;
      case 'up':
        valid = rcy < centerY;
        dist = centerY - rcy + Math.abs(centerX - rcx) * 0.5;
        break;
      case 'down':
        valid = rcy > centerY;
        dist = rcy - centerY + Math.abs(centerX - rcx) * 0.5;
        break;
    }

    if (valid && dist < bestDist) {
      bestDist = dist;
      best = r.id;
    }
  }

  return best;
}

/**
 * Migrate a flat terminal array to a SplitTree.
 * Creates a single leaf for each terminal, arranged vertically.
 */
export function migrateFromArray(terminalIds: string[]): SplitNode {
  if (terminalIds.length === 0) return createLeaf('');
  if (terminalIds.length === 1) return createLeaf(terminalIds[0]);

  // Build a balanced binary tree
  function buildBalanced(ids: string[]): SplitNode {
    if (ids.length === 1) return createLeaf(ids[0]);
    const mid = Math.ceil(ids.length / 2);
    return createBranch('horizontal', buildBalanced(ids.slice(0, mid)), buildBalanced(ids.slice(mid)));
  }

  return buildBalanced(terminalIds);
}
