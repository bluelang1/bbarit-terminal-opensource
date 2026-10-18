/**
 * graphSettings.ts
 *
 * Persisted view settings for the Note Graph (Obsidian-style):
 * filters, color groups, display sliders, and force sliders.
 */

import type { SimulationConfig } from './graphLayout';
import { DEFAULT_CONFIG } from './graphLayout';

// ───────────────────────── Types ─────────────────────────

export interface GraphGroup {
  id: string;
  /** Obsidian-style query: tag:foo, path:bar, file:baz, plain text */
  query: string;
  color: string;
}

export interface GraphViewSettings {
  // Filters
  showTagNodes: boolean;
  showOrphans: boolean;
  showTagEdges: boolean;
  // Display
  showArrows: boolean;
  /** Zoom level below which node labels fade out */
  textFadeThreshold: number;
  nodeSizeScale: number;
  linkThickness: number;
  // Forces
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
  // Local graph
  localDepth: number;
  // Color groups (first matching group wins)
  groups: GraphGroup[];
}

export const DEFAULT_GRAPH_SETTINGS: GraphViewSettings = {
  showTagNodes: false,
  showOrphans: true,
  showTagEdges: false,
  showArrows: true,
  textFadeThreshold: 0.6,
  nodeSizeScale: 1,
  linkThickness: 1,
  centerForce: DEFAULT_CONFIG.gravity,
  repelForce: DEFAULT_CONFIG.repulsion,
  linkForce: DEFAULT_CONFIG.attraction,
  linkDistance: DEFAULT_CONFIG.linkDistance,
  localDepth: 1,
  groups: [],
};

export const GROUP_COLOR_PALETTE = [
  '#eb5757', '#f2994a', '#f2c94c', '#27ae60',
  '#2d9cdb', '#9b51e0', '#e91e8c', '#00bfa5',
];

const STORAGE_KEY = 'octo-note-graph-settings';

// ───────────────────────── Persistence ─────────────────────────

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function sanitizeGraphSettings(raw: unknown): GraphViewSettings {
  const d = DEFAULT_GRAPH_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d, groups: [] };
  const o = raw as Record<string, unknown>;

  const groups: GraphGroup[] = Array.isArray(o.groups)
    ? (o.groups as unknown[])
        .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
        .filter(g => typeof g.query === 'string' && typeof g.color === 'string')
        .map((g, i) => ({
          id: typeof g.id === 'string' && g.id ? g.id : `group-${i}`,
          query: g.query as string,
          color: g.color as string,
        }))
    : [];

  return {
    showTagNodes: typeof o.showTagNodes === 'boolean' ? o.showTagNodes : d.showTagNodes,
    showOrphans: typeof o.showOrphans === 'boolean' ? o.showOrphans : d.showOrphans,
    showTagEdges: typeof o.showTagEdges === 'boolean' ? o.showTagEdges : d.showTagEdges,
    showArrows: typeof o.showArrows === 'boolean' ? o.showArrows : d.showArrows,
    textFadeThreshold: clampNumber(o.textFadeThreshold, 0, 2, d.textFadeThreshold),
    nodeSizeScale: clampNumber(o.nodeSizeScale, 0.4, 2.5, d.nodeSizeScale),
    linkThickness: clampNumber(o.linkThickness, 0.4, 3, d.linkThickness),
    centerForce: clampNumber(o.centerForce, 0, 0.15, d.centerForce),
    repelForce: clampNumber(o.repelForce, 0, 3000, d.repelForce),
    linkForce: clampNumber(o.linkForce, 0, 0.08, d.linkForce),
    linkDistance: clampNumber(o.linkDistance, 30, 320, d.linkDistance),
    localDepth: Math.round(clampNumber(o.localDepth, 1, 3, d.localDepth)),
    groups,
  };
}

export function loadGraphSettings(): GraphViewSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GRAPH_SETTINGS, groups: [] };
    return sanitizeGraphSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_GRAPH_SETTINGS, groups: [] };
  }
}

export function saveGraphSettings(settings: GraphViewSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable — settings stay session-only
  }
}

export function toSimulationConfig(settings: GraphViewSettings): SimulationConfig {
  return {
    ...DEFAULT_CONFIG,
    gravity: settings.centerForce,
    repulsion: settings.repelForce,
    attraction: settings.linkForce,
    linkDistance: settings.linkDistance,
  };
}
