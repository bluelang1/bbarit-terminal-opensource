/**
 * 균등 분할 (even split) for the terminal layout tree.
 *
 * Splitting always halves the ACTIVE pane, so pane sizes degrade as terminals are
 * added: the 3rd terminal yields 50/25/25, the 4th 50/25/12.5/12.5. Equalizing
 * keeps the split STRUCTURE (each pane stays where the user put it) but resizes
 * every split so all leaves get an equal share: a split's ratio becomes its first
 * subtree's leaf share (in percent, matching TerminalLayoutNode.ratio).
 *
 * Structurally typed so App.tsx's TerminalLayoutNode plugs in without exporting
 * its internal type here; extra fields (id, terminalId, dir) pass through intact.
 */
export type EqualizableLayoutNode =
  | { kind: 'leaf' }
  | { kind: 'split'; ratio: number; first: EqualizableLayoutNode; second: EqualizableLayoutNode };

export function layoutLeafCount(node: EqualizableLayoutNode): number {
  return node.kind === 'leaf' ? 1 : layoutLeafCount(node.first) + layoutLeafCount(node.second);
}

/** Same 5–95% bounds the layout tree enforces elsewhere for a draggable divider. */
const clampRatioPct = (value: number): number => Math.max(5, Math.min(95, value));

export function equalizeLayoutRatios<T extends EqualizableLayoutNode>(node: T): T;
export function equalizeLayoutRatios<T extends EqualizableLayoutNode>(node: T | undefined): T | undefined;
export function equalizeLayoutRatios(
  node: EqualizableLayoutNode | undefined,
): EqualizableLayoutNode | undefined {
  if (!node || node.kind === 'leaf') return node;
  const firstLeaves = layoutLeafCount(node.first);
  const secondLeaves = layoutLeafCount(node.second);
  return {
    ...node,
    ratio: clampRatioPct((firstLeaves / (firstLeaves + secondLeaves)) * 100),
    first: equalizeLayoutRatios(node.first),
    second: equalizeLayoutRatios(node.second),
  };
}
