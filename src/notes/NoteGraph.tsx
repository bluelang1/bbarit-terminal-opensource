/**
 * NoteGraph.tsx
 *
 * Obsidian-style graph view for the note system.
 * Renders notes as nodes and wikilinks/tag connections as edges
 * on a Canvas 2D with force-directed layout.
 *
 * Features:
 *   - Force simulation (repulsion, attraction, gravity, damping)
 *     with live-tunable forces (center/repel/link force, link distance)
 *   - Zoom (wheel at cursor, 0.1–5.0), pan, zoom controls (in/out/fit)
 *   - Node drag with pin/unpin
 *   - Hover highlight: connected nodes stay lit, the rest dim
 *   - Search with operators (tag:, path:, file:, -exclusion) + tag filter
 *   - Orphan toggle, tags-as-nodes, tag-edge toggle
 *   - Color groups: query-based node coloring (Obsidian Groups)
 *   - Local graph: depth-limited subgraph around the selected note
 *   - Timelapse: nodes appear in chronological order
 *   - Settings drawer persisted to localStorage
 *   - Barnes-Hut simulation for large graphs (see graphLayout.ts)
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Network, X, Search, FileText, Link2, Sparkles, Hash, Orbit, LayoutGrid,
  GitBranch, Waypoints, Settings2, Focus, ZoomIn, ZoomOut, Maximize2, Play,
  Square, Plus, Trash2, RotateCcw, Globe,
} from 'lucide-react';
import { useNoteState } from './NoteContext';
import { useTranslation } from '../i18n';
import {
  buildGraphData,
  buildTagEdges,
  buildLocalGraph,
  initializePositions,
  simulateTick,
  parseQuery,
  noteMatchesQuery,
  TAG_NODE_PREFIX,
  type GraphNode,
  type GraphData,
  type LayoutType,
} from './graphLayout';
import {
  initializePositions3D,
  simulateTick3D,
  projectNode,
} from './graphLayout3d';
import {
  DEFAULT_GRAPH_SETTINGS,
  GROUP_COLOR_PALETTE,
  loadGraphSettings,
  saveGraphSettings,
  toSimulationConfig,
  type GraphViewSettings,
} from './graphSettings';
import { buildTfIdfIndex, findSimilarNotes } from './tfidf';
import { TagsPanel } from './TagsPanel';
import { BacklinksPanel } from './BacklinksPanel';
import { SimilarNotesPanel } from './SimilarNotesPanel';

import './NoteGraph.css';

// ───────────────────────── Props ─────────────────────────

export interface NoteGraphProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  style: { bg: string; text: string; accent: string };
}

// ───────────────────────── Helpers ─────────────────────────

/** Compute node radius based on link count */
function nodeRadius(linkCount: number): number {
  return Math.min(3 + Math.sqrt(linkCount) * 2.5, 18);
}

/** Generate hue from tag name for consistent coloring */
function tagHue(tag: string): number {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ((hash % 360) + 360) % 360;
}

/** Hex to rgba */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Check if a bg color is light */
function isLightColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128;
}

function baseName(path: string): string {
  const p = String(path || '');
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

// ───────────────────────── Component ─────────────────────────

export default function NoteGraph({ isOpen, onClose, onOpenFile, style }: NoteGraphProps) {
  const { noteIndex, backlinkIndex, tagIndex } = useNoteState();
  const { t } = useTranslation();
  type SideTab = 'overview' | 'tags' | 'backlinks' | 'similar';

  // ── State ──
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [layoutType, setLayoutType] = useState<LayoutType>('force');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>('overview');
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [settings, setSettings] = useState<GraphViewSettings>(() => loadGraphSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [localMode, setLocalMode] = useState(false);
  const [groupDraft, setGroupDraft] = useState('');
  const [timelapseOn, setTimelapseOn] = useState(false);
  const [is3D, setIs3D] = useState(false);

  // ── Refs ──
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphDataRef = useRef<GraphData | null>(null);
  const rafRef = useRef<number>(0);
  const isSimulatingRef = useRef(true);
  const tickCountRef = useRef(0);
  const posCacheRef = useRef(new Map<string, { x: number; y: number }>());
  const timelapseRef = useRef({ active: false, start: 0, duration: 1 });
  const timelapseRankRef = useRef<{ ranks: Map<string, number>; total: number }>({ ranks: new Map(), total: 1 });

  // Camera
  const cameraRef = useRef({ x: 0, y: 0, zoom: 1 });

  // 3D camera + per-frame screen projections (for hit testing)
  const cam3DRef = useRef({ rotX: -0.35, rotY: 0.6, dist: 640 });
  const lastOrbitRef = useRef(0);
  const projCacheRef = useRef(new Map<string, { sx: number; sy: number; r: number; viewZ: number }>());
  const starsRef = useRef<{ fx: number; fy: number; r: number; p: number }[] | null>(null);

  // Interaction state
  const dragNodeRef = useRef<GraphNode | null>(null);
  const isPanningRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchText), 200);
    return () => clearTimeout(timer);
  }, [searchText]);

  // ── Persist settings ──
  useEffect(() => {
    saveGraphSettings(settings);
  }, [settings]);

  const updateSetting = useCallback(function <K extends keyof GraphViewSettings>(key: K, value: GraphViewSettings[K]) {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  // ── Wake up simulation ──
  const wakeSimulation = useCallback(() => {
    if (!isSimulatingRef.current) {
      isSimulatingRef.current = true;
      tickCountRef.current = 0;
    }
  }, []);

  // ── Live simulation config from force sliders ──
  const configRef = useRef(toSimulationConfig(settings));
  useEffect(() => {
    configRef.current = toSimulationConfig(settings);
    isSimulatingRef.current = is3D || layoutType === 'force';
    tickCountRef.current = 0;
  }, [settings.centerForce, settings.repelForce, settings.linkForce, settings.linkDistance, layoutType, is3D]);

  // ── Top tags for filter bar ──
  const topTags = useMemo(() => {
    return [...tagIndex]
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [tagIndex]);

  // ── Build graph data ──
  const fullGraphData = useMemo(() => {
    const data = buildGraphData(noteIndex, backlinkIndex, {
      filterTags: selectedTags.size > 0 ? [...selectedTags] : undefined,
      filterQuery: debouncedSearch || undefined,
      showOrphans: settings.showOrphans,
      showTagNodes: settings.showTagNodes,
    });

    if (settings.showTagEdges) {
      const tagEdges = buildTagEdges(tagIndex, data.edges, data.nodeMap);
      data.edges = [...data.edges, ...tagEdges];
    }

    return data;
  }, [noteIndex, backlinkIndex, tagIndex, selectedTags, debouncedSearch, settings.showOrphans, settings.showTagNodes, settings.showTagEdges]);

  const displayData = useMemo(() => {
    if (!localMode || !selectedNodeId) return fullGraphData;
    return buildLocalGraph(fullGraphData, selectedNodeId, settings.localDepth);
  }, [fullGraphData, localMode, selectedNodeId, settings.localDepth]);

  // ── Adjacency for highlight/local rank ──
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of displayData.edges) {
      let src = map.get(edge.source);
      if (!src) { src = new Set(); map.set(edge.source, src); }
      src.add(edge.target);
      let tgt = map.get(edge.target);
      if (!tgt) { tgt = new Set(); map.set(edge.target, tgt); }
      tgt.add(edge.source);
    }
    return map;
  }, [displayData]);

  // ── Group colors (first matching group wins, Obsidian-style) ──
  const nodeGroupColor = useMemo(() => {
    const map = new Map<string, string>();
    const matchers = settings.groups
      .map(g => ({ color: g.color, tokens: parseQuery(g.query) }))
      .filter(g => g.tokens.length > 0);
    if (matchers.length === 0) return map;
    for (const note of noteIndex) {
      for (const matcher of matchers) {
        if (noteMatchesQuery(note, matcher.tokens)) {
          map.set(note.path, matcher.color);
          break;
        }
      }
    }
    return map;
  }, [settings.groups, noteIndex]);

  const noteByPath = useMemo(() => {
    const map = new Map<string, (typeof noteIndex)[number]>();
    for (const note of noteIndex) map.set(note.path, note);
    return map;
  }, [noteIndex]);

  const noteAliasToPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const note of noteIndex) {
      const name = (note.name || '').trim().toLowerCase();
      const title = (note.title || '').trim().toLowerCase();
      if (name && !map.has(name)) map.set(name, note.path);
      if (title && !map.has(title)) map.set(title, note.path);
    }
    return map;
  }, [noteIndex]);

  const selectedNote = useMemo(() => {
    if (!selectedNodeId) return null;
    return noteByPath.get(selectedNodeId) || null;
  }, [noteByPath, selectedNodeId]);

  const incomingNotes = useMemo(() => {
    if (!selectedNote) return [];
    const incomingPaths = backlinkIndex[selectedNote.path] || [];
    const seen = new Set<string>();
    const list: (typeof noteIndex)[number][] = [];
    for (const path of incomingPaths) {
      if (seen.has(path)) continue;
      const note = noteByPath.get(path);
      if (!note) continue;
      seen.add(path);
      list.push(note);
    }
    return list.slice(0, 14);
  }, [backlinkIndex, noteByPath, selectedNote]);

  const outgoingNotes = useMemo(() => {
    if (!selectedNote) return [];
    const seen = new Set<string>();
    const list: (typeof noteIndex)[number][] = [];
    for (const raw of selectedNote.outgoingLinks || []) {
      const key = String(raw || '').trim().toLowerCase();
      if (!key) continue;
      const path = noteAliasToPath.get(key);
      if (!path || path === selectedNote.path || seen.has(path)) continue;
      const note = noteByPath.get(path);
      if (!note) continue;
      seen.add(path);
      list.push(note);
    }
    return list.slice(0, 14);
  }, [noteAliasToPath, noteByPath, selectedNote]);

  const tfIdfIndex = useMemo(() => {
    return buildTfIdfIndex(
      noteIndex.map((note) => ({
        path: note.path,
        title: note.title,
        excerpt: note.excerpt,
        tags: note.tags,
      })),
    );
  }, [noteIndex]);

  const similarNotes = useMemo(() => {
    if (!selectedNote) return [];
    return findSimilarNotes(tfIdfIndex, selectedNote.path, 8)
      .map((row) => {
        const entry = noteByPath.get(row.path);
        return entry ? { entry, score: row.score } : null;
      })
      .filter((row): row is { entry: (typeof noteIndex)[number]; score: number } => !!row);
  }, [noteByPath, selectedNote, tfIdfIndex]);

  // ── Chronological order for timelapse ──
  const chronoOrder = useMemo(() => {
    const sorted = [...noteIndex].sort((a, b) =>
      String(a.modifiedAt || '').localeCompare(String(b.modifiedAt || '')));
    const map = new Map<string, number>();
    sorted.forEach((note, i) => map.set(note.path, i));
    return map;
  }, [noteIndex]);

  // ── Camera reset (open / layout change only — filters keep the view) ──
  useEffect(() => {
    if (!isOpen) return;
    cameraRef.current = { x: 0, y: 0, zoom: 1 };
    cam3DRef.current = { rotX: -0.35, rotY: 0.6, dist: 640 };
    posCacheRef.current.clear();
  }, [isOpen, layoutType]);

  // ── Initialize positions when data changes ──
  useEffect(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const radius = Math.min(cx, cy) * 0.6;

    if (is3D) {
      initializePositions3D(displayData.nodes, Math.min(cx, cy) * 0.62);
    } else {
      initializePositions(displayData.nodes, cx, cy, radius, layoutType);
      if (layoutType === 'force') {
        // Seed from cache so filter/local-graph transitions keep the layout
        const cache = posCacheRef.current;
        for (const node of displayData.nodes) {
          const cached = cache.get(node.id);
          if (cached) {
            node.x = cached.x;
            node.y = cached.y;
            node.vx = 0;
            node.vy = 0;
          }
        }
      }
    }
    graphDataRef.current = displayData;
    isSimulatingRef.current = is3D || layoutType === 'force';
    tickCountRef.current = 0;
    setHoveredNode(null);

    // Timelapse ranks: note nodes in chrono order, tag nodes with first neighbor
    const ranks = new Map<string, number>();
    const noteNodes = displayData.nodes.filter(n => n.kind === 'note');
    noteNodes.sort((a, b) => (chronoOrder.get(a.id) ?? 0) - (chronoOrder.get(b.id) ?? 0));
    noteNodes.forEach((node, i) => ranks.set(node.id, i));
    for (const node of displayData.nodes) {
      if (node.kind !== 'tag') continue;
      let min = Math.max(0, noteNodes.length - 1);
      for (const neighbor of adjacency.get(node.id) ?? []) {
        const rank = ranks.get(neighbor);
        if (rank !== undefined && rank < min) min = rank;
      }
      ranks.set(node.id, min);
    }
    timelapseRankRef.current = { ranks, total: Math.max(1, noteNodes.length) };
  }, [displayData, layoutType, chronoOrder, adjacency, is3D]);

  // ── Drop selection when the node leaves the graph ──
  useEffect(() => {
    if (selectedNodeId && !fullGraphData.nodeMap.has(selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [fullGraphData, selectedNodeId]);

  // ── Screen ↔ World transforms ──
  const screenToWorld = useCallback((sx: number, sy: number): { x: number; y: number } => {
    const cam = cameraRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return { x: sx, y: sy };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (sx - rect.left - rect.width / 2) / cam.zoom - cam.x + rect.width / 2,
      y: (sy - rect.top - rect.height / 2) / cam.zoom - cam.y + rect.height / 2,
    };
  }, []);

  // ── Hit test ──
  const hitTestNode = useCallback((wx: number, wy: number): GraphNode | null => {
    const data = graphDataRef.current;
    if (!data) return null;
    // Iterate in reverse for top-most node
    for (let i = data.nodes.length - 1; i >= 0; i--) {
      const node = data.nodes[i];
      const r = nodeRadius(node.linkCount) * settings.nodeSizeScale + 4;
      const dx = wx - node.x;
      const dy = wy - node.y;
      if (dx * dx + dy * dy <= r * r) return node;
    }
    return null;
  }, [settings.nodeSizeScale]);

  // ── Hit test (3D): use the last frame's screen projections, nearest wins ──
  const hitTestNode3D = useCallback((clientX: number, clientY: number): GraphNode | null => {
    const data = graphDataRef.current;
    const canvas = canvasRef.current;
    if (!data || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    let best: GraphNode | null = null;
    let bestZ = Infinity;
    for (const node of data.nodes) {
      const p = projCacheRef.current.get(node.id);
      if (!p) continue;
      const dx = sx - p.sx;
      const dy = sy - p.sy;
      const rr = p.r + 4;
      if (dx * dx + dy * dy <= rr * rr && p.viewZ < bestZ) {
        best = node;
        bestZ = p.viewZ;
      }
    }
    return best;
  }, []);

  // ── Animation time for effects ──
  const animTimeRef = useRef(0);

  // ── Render ──
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const data = graphDataRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cam = cameraRef.current;
    const isLight = isLightColor(style.bg);
    animTimeRef.current += 0.016;
    const t = animTimeRef.current;

    // ── Timelapse progress ──
    const tl = timelapseRef.current;
    let tlVisible = Infinity;
    if (tl.active) {
      const progress = (performance.now() - tl.start) / tl.duration;
      if (progress >= 1) {
        tl.active = false;
        setTimelapseOn(false);
      } else {
        tlVisible = progress * timelapseRankRef.current.total;
      }
    }
    const ranks = timelapseRankRef.current.ranks;
    const appearOf = (id: string): number => {
      if (!Number.isFinite(tlVisible)) return 1;
      const rank = ranks.get(id) ?? 0;
      return Math.max(0, Math.min(1, tlVisible - rank));
    };

    // ── Highlight: hover wins over selection (Obsidian behavior) ──
    const activeId = hoveredNode?.id ?? selectedNodeId;
    const activeNeighbors = activeId ? (adjacency.get(activeId) ?? new Set<string>()) : new Set<string>();

    // ── Label fade by zoom threshold ──
    const fadeThreshold = settings.textFadeThreshold;
    const labelFade = fadeThreshold <= 0 ? 1 : Math.max(0, Math.min(1, (cam.zoom - fadeThreshold) / 0.25));

    // ── Background dot grid ──
    const gridSpacing = 32;
    const dotR = 0.8;
    const dotAlpha = isLight ? 0.08 : 0.06;
    ctx.fillStyle = hexToRgba(style.text, dotAlpha);
    const offsetX = ((cam.x * cam.zoom + w / 2) % (gridSpacing * cam.zoom) + gridSpacing * cam.zoom) % (gridSpacing * cam.zoom);
    const offsetY = ((cam.y * cam.zoom + h / 2) % (gridSpacing * cam.zoom) + gridSpacing * cam.zoom) % (gridSpacing * cam.zoom);
    const scaledSpacing = gridSpacing * cam.zoom;
    if (scaledSpacing > 8) {
      for (let gx = offsetX; gx < w; gx += scaledSpacing) {
        for (let gy = offsetY; gy < h; gy += scaledSpacing) {
          ctx.beginPath();
          ctx.arc(gx, gy, dotR * cam.zoom, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Apply camera transform
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(cam.x, cam.y);
    ctx.translate(-w / 2, -h / 2);

    // ── Draw edges (curved bezier) ──
    for (const edge of data.edges) {
      const src = data.nodeMap.get(edge.source);
      const tgt = data.nodeMap.get(edge.target);
      if (!src || !tgt) continue;

      const appear = Math.min(appearOf(edge.source), appearOf(edge.target));
      if (appear <= 0) continue;

      const isHighlighted = activeId &&
        (edge.source === activeId || edge.target === activeId);
      const isDimmed = activeId && !isHighlighted;

      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Curved edges: perpendicular offset for bezier control point
      const curvature = 0.15;
      const mx = (src.x + tgt.x) / 2;
      const my = (src.y + tgt.y) / 2;
      const nx = -dy / (dist || 1) * dist * curvature;
      const ny = dx / (dist || 1) * dist * curvature;
      const cpx = mx + nx;
      const cpy = my + ny;

      ctx.beginPath();
      if (edge.type === 'tag') {
        ctx.setLineDash([4, 6]);
      } else if (edge.type === 'tagnode') {
        ctx.setLineDash([2, 5]);
      } else {
        ctx.setLineDash([]);
      }

      const edgeAlpha = (isDimmed ? 0.04 : isHighlighted ? 0.7 : 0.12) * appear;

      if (isHighlighted) {
        // Gradient edge for highlighted
        const grad = ctx.createLinearGradient(src.x, src.y, tgt.x, tgt.y);
        grad.addColorStop(0, hexToRgba(style.accent, edgeAlpha * 0.6));
        grad.addColorStop(0.5, hexToRgba(style.accent, edgeAlpha));
        grad.addColorStop(1, hexToRgba(style.accent, edgeAlpha * 0.6));
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2 * settings.linkThickness;
      } else {
        ctx.strokeStyle = hexToRgba(style.text, edgeAlpha);
        ctx.lineWidth = 0.7 * settings.linkThickness;
      }

      ctx.moveTo(src.x, src.y);
      ctx.quadraticCurveTo(cpx, cpy, tgt.x, tgt.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrow for wikilinks
      if (settings.showArrows && edge.type === 'wikilink' && !isDimmed && dist > 0) {
        const r = nodeRadius(tgt.linkCount) * settings.nodeSizeScale + 3;
        // Approximate point on bezier near target
        const tParam = 1 - r / dist;
        const ax = (1 - tParam) * (1 - tParam) * src.x + 2 * (1 - tParam) * tParam * cpx + tParam * tParam * tgt.x;
        const ay = (1 - tParam) * (1 - tParam) * src.y + 2 * (1 - tParam) * tParam * cpy + tParam * tParam * tgt.y;
        const angle = Math.atan2(tgt.y - ay, tgt.x - ax);
        const arrowSize = isHighlighted ? 7 : 5;

        ctx.beginPath();
        ctx.moveTo(
          ax + arrowSize * Math.cos(angle),
          ay + arrowSize * Math.sin(angle),
        );
        ctx.lineTo(
          ax - arrowSize * 0.6 * Math.cos(angle - Math.PI / 4),
          ay - arrowSize * 0.6 * Math.sin(angle - Math.PI / 4),
        );
        ctx.lineTo(
          ax - arrowSize * 0.6 * Math.cos(angle + Math.PI / 4),
          ay - arrowSize * 0.6 * Math.sin(angle + Math.PI / 4),
        );
        ctx.closePath();
        ctx.fillStyle = hexToRgba(isHighlighted ? style.accent : style.text, (isHighlighted ? 0.5 : 0.15) * appear);
        ctx.fill();
      }
    }

    // ── Draw nodes ──
    for (const node of data.nodes) {
      const appear = appearOf(node.id);
      if (appear <= 0) continue;

      const r = nodeRadius(node.linkCount) * settings.nodeSizeScale * (0.6 + 0.4 * appear);
      const isSelected = node.id === selectedNodeId;
      const isActive = node.id === activeId;
      const isNeighbor = activeNeighbors.has(node.id);
      const isHovered = hoveredNode?.id === node.id;
      const isDimmed = activeId !== null && !isActive && !isNeighbor;

      const groupColor = node.kind === 'note' ? nodeGroupColor.get(node.id) : undefined;

      // Compute node color
      let hue: number;
      let sat: string, lum: string;
      if (node.tags.length > 0) {
        hue = tagHue(node.tags[0]);
        sat = isLight ? '55%' : '65%';
        lum = isLight ? '45%' : '60%';
      } else {
        hue = 220;
        sat = '50%';
        lum = '55%';
      }

      const alpha = (isDimmed ? 0.12 : 0.9) * appear;

      // Outer glow ring for selected/hovered
      if ((isSelected || isHovered) && !isDimmed) {
        const pulse = 1 + Math.sin(t * 3) * 0.15;
        const glowR = (r + 8) * pulse;

        const glowGrad = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, glowR);
        const glowColor = groupColor || style.accent;
        if (isSelected) {
          glowGrad.addColorStop(0, hexToRgba(glowColor, 0.3));
          glowGrad.addColorStop(0.6, hexToRgba(glowColor, 0.1));
          glowGrad.addColorStop(1, hexToRgba(glowColor, 0));
        } else if (groupColor) {
          glowGrad.addColorStop(0, hexToRgba(groupColor, 0.25));
          glowGrad.addColorStop(1, hexToRgba(groupColor, 0));
        } else {
          glowGrad.addColorStop(0, `hsla(${hue}, ${sat}, ${lum}, 0.25)`);
          glowGrad.addColorStop(1, `hsla(${hue}, ${sat}, ${lum}, 0)`);
        }
        ctx.beginPath();
        ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = glowGrad;
        ctx.fill();
      }

      if (node.kind === 'tag') {
        // Tag nodes: hollow dashed circle (visually distinct from notes)
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(style.text, (isDimmed ? 0.05 : 0.14) * appear);
        ctx.fill();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = hexToRgba(style.text, (isDimmed ? 0.15 : 0.5) * appear);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        // Node gradient fill
        const grad = ctx.createRadialGradient(
          node.x - r * 0.3, node.y - r * 0.3, r * 0.1,
          node.x, node.y, r,
        );
        if (groupColor) {
          grad.addColorStop(0, hexToRgba(groupColor, alpha));
          grad.addColorStop(1, hexToRgba(groupColor, alpha * 0.7));
        } else if (node.tags.length > 0) {
          const lumHigher = isLight ? '55%' : '72%';
          grad.addColorStop(0, `hsla(${hue}, ${sat}, ${lumHigher}, ${alpha})`);
          grad.addColorStop(1, `hsla(${hue}, ${sat}, ${lum}, ${alpha})`);
        } else {
          grad.addColorStop(0, hexToRgba(style.accent, alpha));
          grad.addColorStop(1, hexToRgba(style.accent, alpha * 0.7));
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // Selection / neighbor ring
      if (isSelected) {
        ctx.strokeStyle = style.accent;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      } else if (isNeighbor && activeId) {
        ctx.strokeStyle = hexToRgba(style.accent, 0.4);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Label
      if (labelFade > 0 || isHovered || isSelected) {
        const fontSize = Math.max(9, Math.min(12, 10 / cam.zoom));
        ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const baseAlpha = (isHovered || isSelected) ? 1 : 0.65 * labelFade;
        const labelAlpha = (isDimmed ? 0.1 * labelFade : baseAlpha) * appear;

        const label = node.label.length > 24 ? node.label.slice(0, 22) + '…' : node.label;

        // Text shadow for readability
        if (!isDimmed) {
          ctx.fillStyle = hexToRgba(style.bg, 0.7 * labelAlpha);
          ctx.fillText(label, node.x + 0.5, node.y + r + 5.5);
          ctx.fillText(label, node.x - 0.5, node.y + r + 4.5);
        }

        ctx.fillStyle = hexToRgba(style.text, labelAlpha);
        ctx.fillText(label, node.x, node.y + r + 5);
      }
    }

    ctx.restore();

    // ── Minimap (bottom-right) ──
    if (data.nodes.length > 3) {
      const mmW = 120;
      const mmH = 90;
      const mmPad = 12;
      const mmX = w - mmW - mmPad;
      const mmY = h - mmH - mmPad;

      // Bounding box of all nodes
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const node of data.nodes) {
        if (node.x < minX) minX = node.x;
        if (node.x > maxX) maxX = node.x;
        if (node.y < minY) minY = node.y;
        if (node.y > maxY) maxY = node.y;
      }
      const rangeX = (maxX - minX) || 1;
      const rangeY = (maxY - minY) || 1;
      const scale = Math.min((mmW - 16) / rangeX, (mmH - 16) / rangeY);

      // Background
      ctx.fillStyle = hexToRgba(style.bg, 0.85);
      ctx.strokeStyle = hexToRgba(style.text, 0.12);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(mmX, mmY, mmW, mmH, 8);
      ctx.fill();
      ctx.stroke();

      // Nodes as dots
      for (const node of data.nodes) {
        const nx = mmX + 8 + (node.x - minX) * scale;
        const ny = mmY + 8 + (node.y - minY) * scale;
        const isS = node.id === selectedNodeId;
        ctx.beginPath();
        ctx.arc(nx, ny, isS ? 2.5 : 1.2, 0, Math.PI * 2);
        ctx.fillStyle = isS ? style.accent : hexToRgba(style.text, 0.4);
        ctx.fill();
      }

      // Viewport indicator
      const vpLeft = (-cam.x - w / 2 / cam.zoom + w / 2);
      const vpTop = (-cam.y - h / 2 / cam.zoom + h / 2);
      const vpW = w / cam.zoom;
      const vpH = h / cam.zoom;
      const vx = mmX + 8 + (vpLeft - minX) * scale;
      const vy = mmY + 8 + (vpTop - minY) * scale;
      const vw = vpW * scale;
      const vh = vpH * scale;

      ctx.strokeStyle = hexToRgba(style.accent, 0.5);
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.max(mmX + 2, Math.min(vx, mmX + mmW - 4)),
        Math.max(mmY + 2, Math.min(vy, mmY + mmH - 4)),
        Math.min(vw, mmW - 4),
        Math.min(vh, mmH - 4),
      );
    }
  }, [style, selectedNodeId, hoveredNode, adjacency, settings, nodeGroupColor]);

  // ── 3D Render: perspective projection, depth fog, glow, idle auto-orbit ──
  const render3D = useCallback(() => {
    const canvas = canvasRef.current;
    const data = graphDataRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const isLight = isLightColor(style.bg);
    animTimeRef.current += 0.016;
    const t = animTimeRef.current;
    const cam = cam3DRef.current;

    // Idle auto-orbit + auto-framing — pause while the user interacts
    const idle = performance.now() - lastOrbitRef.current > 2500 && !isPanningRef.current && !dragNodeRef.current;
    if (idle) {
      cam.rotY += 0.0022;
    }

    // Timelapse progress
    const tl = timelapseRef.current;
    let tlVisible = Infinity;
    if (tl.active) {
      const progress = (performance.now() - tl.start) / tl.duration;
      if (progress >= 1) {
        tl.active = false;
        setTimelapseOn(false);
      } else {
        tlVisible = progress * timelapseRankRef.current.total;
      }
    }
    const ranks = timelapseRankRef.current.ranks;
    const appearOf = (id: string): number => {
      if (!Number.isFinite(tlVisible)) return 1;
      const rank = ranks.get(id) ?? 0;
      return Math.max(0, Math.min(1, tlVisible - rank));
    };

    const activeId = hoveredNode?.id ?? selectedNodeId;
    const activeNeighbors = activeId ? (adjacency.get(activeId) ?? new Set<string>()) : new Set<string>();

    // Starfield backdrop (dark themes)
    if (!isLight) {
      if (!starsRef.current) {
        const stars: { fx: number; fy: number; r: number; p: number }[] = [];
        let seed = 88675123;
        const rand = () => {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          return ((seed >>> 0) % 10000) / 10000;
        };
        for (let i = 0; i < 140; i++) {
          stars.push({ fx: rand(), fy: rand(), r: 0.4 + rand() * 1.1, p: rand() * Math.PI * 2 });
        }
        starsRef.current = stars;
      }
      for (const star of starsRef.current) {
        const twinkle = 0.10 + 0.10 * (1 + Math.sin(t * 1.2 + star.p)) / 2;
        ctx.beginPath();
        ctx.arc(star.fx * w, star.fy * h, star.r, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(style.text, twinkle);
        ctx.fill();
      }
    }

    const cx = w / 2;
    const cy = h / 2;
    const fov = 620;

    // Bounding sphere → depth fog range
    let boundR = 80;
    for (const node of data.nodes) {
      const rr = Math.sqrt(node.x * node.x + node.y * node.y + node.z * node.z);
      if (rr > boundR) boundR = rr;
    }
    // Auto-frame: gently dolly so the cloud fills the view when idle
    if (idle) {
      const targetDist = Math.max(320, Math.min(2400, boundR * 2.5));
      cam.dist += (targetDist - cam.dist) * 0.04;
    }

    const near = cam.dist - boundR;
    const range = Math.max(boundR * 2, 1);

    const proj = projCacheRef.current;
    proj.clear();
    interface DrawItem {
      node: GraphNode;
      sx: number;
      sy: number;
      r: number;
      viewZ: number;
      fog: number;
      appear: number;
    }
    const drawList: DrawItem[] = [];
    for (const node of data.nodes) {
      const appear = appearOf(node.id);
      const p = projectNode(node.x, node.y, node.z, cam.rotX, cam.rotY, cam.dist, fov, cx, cy);
      const depthT = Math.max(0, Math.min(1, (p.viewZ - near) / range));
      const fog = 1 - depthT * 0.68;
      const r = Math.max(1, nodeRadius(node.linkCount) * settings.nodeSizeScale * p.scale * (0.6 + 0.4 * appear));
      proj.set(node.id, { sx: p.sx, sy: p.sy, r, viewZ: p.viewZ });
      if (appear > 0 && p.viewZ > 60) {
        drawList.push({ node, sx: p.sx, sy: p.sy, r, viewZ: p.viewZ, fog, appear });
      }
    }

    // Edges (straight lines with depth-faded alpha)
    for (const edge of data.edges) {
      const a = proj.get(edge.source);
      const b = proj.get(edge.target);
      if (!a || !b) continue;
      const appear = Math.min(appearOf(edge.source), appearOf(edge.target));
      if (appear <= 0) continue;
      const isHighlighted = activeId && (edge.source === activeId || edge.target === activeId);
      const isDimmed = activeId && !isHighlighted;
      const avgZ = (a.viewZ + b.viewZ) / 2;
      const depthT = Math.max(0, Math.min(1, (avgZ - near) / range));
      const fog = 1 - depthT * 0.7;
      const alpha = (isDimmed ? 0.03 : isHighlighted ? 0.75 : 0.15) * fog * appear;

      ctx.beginPath();
      if (edge.type === 'tag') ctx.setLineDash([4, 6]);
      else if (edge.type === 'tagnode') ctx.setLineDash([2, 5]);
      else ctx.setLineDash([]);
      ctx.strokeStyle = isHighlighted ? hexToRgba(style.accent, alpha) : hexToRgba(style.text, alpha);
      ctx.lineWidth = (isHighlighted ? 1.8 : 0.8) * settings.linkThickness * (0.5 + fog * 0.7);
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Nodes far → near (painter's algorithm)
    drawList.sort((a, b) => b.viewZ - a.viewZ);

    for (const item of drawList) {
      const { node, sx, sy, r, fog, appear } = item;
      const isSelected = node.id === selectedNodeId;
      const isActive = node.id === activeId;
      const isNeighbor = activeNeighbors.has(node.id);
      const isHovered = hoveredNode?.id === node.id;
      const isDimmed = activeId !== null && !isActive && !isNeighbor;
      const groupColor = node.kind === 'note' ? nodeGroupColor.get(node.id) : undefined;

      let hue = 220;
      let colored = false;
      if (node.tags.length > 0) {
        hue = tagHue(node.tags[0]);
        colored = true;
      }
      const paint = (a: number): string =>
        groupColor ? hexToRgba(groupColor, a)
          : node.kind === 'tag' ? hexToRgba(style.text, a * 0.8)
            : colored ? `hsla(${hue}, ${isLight ? '58%' : '68%'}, ${isLight ? '46%' : '64%'}, ${a})`
              : hexToRgba(style.accent, a);

      const alpha = (isDimmed ? 0.14 : 0.95) * fog * appear;

      // Additive glow halo (space-nebula look on dark themes)
      if (!isDimmed) {
        if (!isLight) ctx.globalCompositeOperation = 'lighter';
        const glowR = r * ((isSelected || isHovered) ? 3.6 + Math.sin(t * 3) * 0.35 : 2.5);
        const glow = ctx.createRadialGradient(sx, sy, r * 0.15, sx, sy, glowR);
        glow.addColorStop(0, paint(((isSelected || isHovered) ? 0.55 : 0.26) * fog * appear));
        glow.addColorStop(1, paint(0));
        ctx.beginPath();
        ctx.arc(sx, sy, glowR, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }

      // Core
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      if (node.kind === 'tag') {
        ctx.fillStyle = hexToRgba(style.text, 0.15 * fog * appear * (isDimmed ? 0.4 : 1));
        ctx.fill();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = hexToRgba(style.text, (isDimmed ? 0.15 : 0.5) * fog * appear);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const core = ctx.createRadialGradient(sx - r * 0.3, sy - r * 0.3, r * 0.1, sx, sy, r);
        core.addColorStop(0, paint(Math.min(1, alpha * 1.15)));
        core.addColorStop(1, paint(alpha * 0.75));
        ctx.fillStyle = core;
        ctx.fill();
      }
      if (isSelected) {
        ctx.strokeStyle = style.accent;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (isNeighbor && activeId) {
        ctx.strokeStyle = hexToRgba(style.accent, 0.45 * fog);
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }

    // Labels: nearest nodes get names; the text-fade slider sets the budget
    const labelBudget = Math.round(30 * (1 - settings.textFadeThreshold / 2));
    const labelCandidates = drawList
      .filter(d => d.appear > 0.6)
      .sort((a, b) => a.viewZ - b.viewZ);
    let shown = 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const item of labelCandidates) {
      const isHovered = hoveredNode?.id === item.node.id;
      const isSelected = item.node.id === selectedNodeId;
      const isNeighbor = activeNeighbors.has(item.node.id);
      const isDimmed = activeId !== null && item.node.id !== activeId && !isNeighbor;
      if (!isHovered && !isSelected) {
        if (shown >= labelBudget || isDimmed) continue;
        shown++;
      }
      const baseR = nodeRadius(item.node.linkCount) * settings.nodeSizeScale || 1;
      const fontSize = Math.max(8, Math.min(14, 11 * (item.r / baseR)));
      const labelAlpha = ((isHovered || isSelected) ? 1 : 0.75) * item.fog * item.appear;
      const label = item.node.label.length > 24 ? item.node.label.slice(0, 22) + '…' : item.node.label;
      ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
      ctx.fillStyle = hexToRgba(style.bg, 0.75 * labelAlpha);
      ctx.fillText(label, item.sx + 0.5, item.sy + item.r + 4.5);
      ctx.fillStyle = hexToRgba(style.text, labelAlpha);
      ctx.fillText(label, item.sx, item.sy + item.r + 4);
    }

    // Cinematic vignette
    const vignette = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.25, cx, cy, Math.max(w, h) * 0.72);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, isLight ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.42)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }, [style, selectedNodeId, hoveredNode, adjacency, settings, nodeGroupColor]);

  // ── Animation loop ──
  useEffect(() => {
    if (!isOpen) return;

    const loop = () => {
      const data = graphDataRef.current;
      if (data && data.nodes.length > 0 && isSimulatingRef.current) {
        if (is3D) {
          const energy = simulateTick3D(data, configRef.current);
          tickCountRef.current++;
          if (energy < 0.05 || tickCountRef.current > 600) {
            isSimulatingRef.current = false;
          }
        } else {
          const container = containerRef.current;
          const cx = container ? container.getBoundingClientRect().width / 2 : 400;
          const cy = container ? container.getBoundingClientRect().height / 2 : 300;
          const energy = simulateTick(data, configRef.current, cx, cy);
          tickCountRef.current++;

          // Remember positions so filter/local-graph changes keep the layout
          const cache = posCacheRef.current;
          for (const node of data.nodes) {
            const cached = cache.get(node.id);
            if (cached) {
              cached.x = node.x;
              cached.y = node.y;
            } else {
              cache.set(node.id, { x: node.x, y: node.y });
            }
          }

          // Converge: stop after low energy or many ticks
          if (energy < 0.05 || tickCountRef.current > 500) {
            isSimulatingRef.current = false;
          }
        }
      }

      if (is3D) render3D();
      else render();
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isOpen, render, render3D, is3D]);

  // ── Mouse handlers ──
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const world = screenToWorld(e.clientX, e.clientY);
    const node = is3D
      ? hitTestNode3D(e.clientX, e.clientY)
      : hitTestNode(world.x, world.y);

    lastMouseRef.current = { x: e.clientX, y: e.clientY };
    isDraggingRef.current = false;

    if (node) {
      dragNodeRef.current = node;
      if (!is3D) {
        node.pinned = true;
        wakeSimulation();
      }
    } else {
      isPanningRef.current = true;
    }
  }, [screenToWorld, hitTestNode, hitTestNode3D, is3D, wakeSimulation]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const dx = e.clientX - lastMouseRef.current.x;
    const dy = e.clientY - lastMouseRef.current.y;

    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      isDraggingRef.current = true;
    }

    if (is3D && (isPanningRef.current || dragNodeRef.current)) {
      // Orbit — dragging anywhere rotates the 3D camera
      if (isDraggingRef.current) {
        const cam = cam3DRef.current;
        cam.rotY += dx * 0.005;
        cam.rotX = Math.max(-1.4, Math.min(1.4, cam.rotX + dy * 0.005));
        lastOrbitRef.current = performance.now();
      }
    } else if (dragNodeRef.current) {
      const world = screenToWorld(e.clientX, e.clientY);
      dragNodeRef.current.x = world.x;
      dragNodeRef.current.y = world.y;
      dragNodeRef.current.vx = 0;
      dragNodeRef.current.vy = 0;
      wakeSimulation();
    } else if (isPanningRef.current) {
      const cam = cameraRef.current;
      cam.x += dx / cam.zoom;
      cam.y += dy / cam.zoom;
    } else {
      // Hover detection
      const world = screenToWorld(e.clientX, e.clientY);
      const node = is3D
        ? hitTestNode3D(e.clientX, e.clientY)
        : hitTestNode(world.x, world.y);
      setHoveredNode(node);
      if (node) {
        const canvas = canvasRef.current;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          setTooltipPos({
            x: e.clientX - rect.left + 12,
            y: e.clientY - rect.top + 12,
          });
        }
      }
    }

    lastMouseRef.current = { x: e.clientX, y: e.clientY };
  }, [screenToWorld, hitTestNode, hitTestNode3D, is3D, wakeSimulation]);

  const handleMouseUp = useCallback(() => {
    if (dragNodeRef.current && !isDraggingRef.current) {
      // Click on node (not drag)
      const node = dragNodeRef.current;
      if (selectedNodeId === node.id) {
        // Open immediately when clicking the already-selected node.
        if (node.kind === 'note') onOpenFile(node.id);
      } else {
        setSelectedNodeId(node.id);
      }
      node.pinned = false;
    } else if (dragNodeRef.current) {
      // Drag ended — unpin after short delay for settling
      const node = dragNodeRef.current;
      setTimeout(() => { node.pinned = false; }, 1000);
    } else if (!isDraggingRef.current && isPanningRef.current) {
      // Click on empty space — deselect
      setSelectedNodeId(null);
    }

    dragNodeRef.current = null;
    isPanningRef.current = false;
    isDraggingRef.current = false;
  }, [onOpenFile, selectedNodeId]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const world = screenToWorld(e.clientX, e.clientY);
    const node = is3D
      ? hitTestNode3D(e.clientX, e.clientY)
      : hitTestNode(world.x, world.y);
    if (node && node.kind === 'note') {
      onOpenFile(node.id);
    }
  }, [screenToWorld, hitTestNode, hitTestNode3D, is3D, onOpenFile]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (is3D) {
      // Dolly the 3D camera
      const cam3d = cam3DRef.current;
      cam3d.dist = Math.max(220, Math.min(2400, cam3d.dist * (e.deltaY > 0 ? 1.08 : 0.92)));
      lastOrbitRef.current = performance.now();
      return;
    }
    const cam = cameraRef.current;
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    const nextZoom = Math.max(0.1, Math.min(5.0, cam.zoom * factor));
    const canvas = canvasRef.current;
    if (canvas) {
      // Keep the world point under the cursor fixed while zooming
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left - rect.width / 2;
      const py = e.clientY - rect.top - rect.height / 2;
      cam.x += px / nextZoom - px / cam.zoom;
      cam.y += py / nextZoom - py / cam.zoom;
    }
    cam.zoom = nextZoom;
  }, [is3D]);

  // ── Zoom controls ──
  const zoomBy = useCallback((factor: number) => {
    if (is3D) {
      const cam3d = cam3DRef.current;
      cam3d.dist = Math.max(220, Math.min(2400, cam3d.dist / factor));
      lastOrbitRef.current = performance.now();
      return;
    }
    const cam = cameraRef.current;
    cam.zoom = Math.max(0.1, Math.min(5.0, cam.zoom * factor));
  }, [is3D]);

  const zoomToFit = useCallback(() => {
    const data = graphDataRef.current;
    const canvas = canvasRef.current;
    if (!data || !canvas || data.nodes.length === 0) return;
    if (is3D) {
      let maxR = 80;
      for (const node of data.nodes) {
        const rr = Math.sqrt(node.x * node.x + node.y * node.y + node.z * node.z);
        if (rr > maxR) maxR = rr;
      }
      cam3DRef.current.dist = Math.max(260, Math.min(2400, maxR * 2.4));
      lastOrbitRef.current = performance.now();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of data.nodes) {
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.y > maxY) maxY = node.y;
    }
    const bw = Math.max(maxX - minX, 40);
    const bh = Math.max(maxY - minY, 40);
    const zoom = Math.max(0.1, Math.min(5.0, Math.min(rect.width / (bw + 120), rect.height / (bh + 120))));
    cameraRef.current = {
      x: rect.width / 2 - (minX + maxX) / 2,
      y: rect.height / 2 - (minY + maxY) / 2,
      zoom,
    };
  }, [is3D]);

  const centerOnNode = useCallback((path: string) => {
    const node = graphDataRef.current?.nodeMap.get(path);
    const canvas = canvasRef.current;
    if (!node || !canvas) return;
    if (!is3D) {
      const rect = canvas.getBoundingClientRect();
      cameraRef.current.x = rect.width / 2 - node.x;
      cameraRef.current.y = rect.height / 2 - node.y;
    }
    setSelectedNodeId(path);
    wakeSimulation();
  }, [is3D, wakeSimulation]);

  // ── Timelapse ──
  const toggleTimelapse = useCallback(() => {
    const tl = timelapseRef.current;
    if (tl.active) {
      tl.active = false;
      setTimelapseOn(false);
      return;
    }
    const total = timelapseRankRef.current.total;
    timelapseRef.current = {
      active: true,
      start: performance.now(),
      duration: Math.min(9000, Math.max(2500, total * 120)),
    };
    setTimelapseOn(true);
  }, []);

  // ── Keyboard: Escape to close ──
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showSettings) setShowSettings(false);
        else onClose();
      }
      if (e.key === 'Enter' && selectedNodeId && !selectedNodeId.startsWith(TAG_NODE_PREFIX)) {
        onOpenFile(selectedNodeId);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose, onOpenFile, selectedNodeId, showSettings]);

  // ── Tag toggle ──
  const toggleTag = useCallback((tag: string) => {
    setSelectedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  // ── Group management ──
  const addGroup = useCallback(() => {
    const query = groupDraft.trim();
    if (!query) return;
    setSettings(prev => ({
      ...prev,
      groups: [...prev.groups, {
        id: `g${Date.now().toString(36)}${prev.groups.length}`,
        query,
        color: GROUP_COLOR_PALETTE[prev.groups.length % GROUP_COLOR_PALETTE.length],
      }],
    }));
    setGroupDraft('');
  }, [groupDraft]);

  const removeGroup = useCallback((id: string) => {
    setSettings(prev => ({ ...prev, groups: prev.groups.filter(g => g.id !== id) }));
  }, []);

  const updateGroupQuery = useCallback((id: string, query: string) => {
    setSettings(prev => ({
      ...prev,
      groups: prev.groups.map(g => g.id === id ? { ...g, query } : g),
    }));
  }, []);

  const cycleGroupColor = useCallback((id: string) => {
    setSettings(prev => ({
      ...prev,
      groups: prev.groups.map(g => {
        if (g.id !== id) return g;
        const idx = GROUP_COLOR_PALETTE.indexOf(g.color);
        return { ...g, color: GROUP_COLOR_PALETTE[(idx + 1) % GROUP_COLOR_PALETTE.length] };
      }),
    }));
  }, []);

  // ── Stats ──
  const stats = useMemo(() => {
    const wikilinkCount = displayData.edges.filter(e => e.type === 'wikilink').length;
    return { nodes: displayData.nodes.length, edges: wikilinkCount };
  }, [displayData]);

  if (!isOpen) return null;

  const cssVars = {
    '--ng-bg': style.bg,
    '--ng-text': style.text,
    '--ng-accent': style.accent,
  } as React.CSSProperties;

  const stopAll = {
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onMouseMove: (e: React.MouseEvent) => e.stopPropagation(),
    onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
    onWheel: (e: React.WheelEvent) => e.stopPropagation(),
  };

  const renderToggleRow = (label: string, value: boolean, onChange: (v: boolean) => void) => (
    <button type="button" className={`note-graph-settings-toggle ${value ? 'active' : ''}`} onClick={() => onChange(!value)}>
      <span className="note-graph-settings-toggle-dot" />
      <span>{label}</span>
    </button>
  );

  const renderSliderRow = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    format?: (v: number) => string,
  ) => (
    <label className="note-graph-settings-row">
      <span className="note-graph-settings-row-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
      />
      <span className="note-graph-settings-row-value">{format ? format(value) : String(value)}</span>
    </label>
  );

  return (
    <div className="note-graph-overlay" style={cssVars} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="note-graph-modal">
        {/* Header */}
        <div className="note-graph-header">
          <Network size={15} style={{ color: style.accent, opacity: 0.8 }} />
          <span className="note-graph-header-title">{t('notes.graph.title')}</span>
          <span className="note-graph-header-stats">{t('notes.graph.stats').replace('{nodes}', String(stats.nodes)).replace('{edges}', String(stats.edges))}</span>
          <button className="modal-close-btn" onClick={onClose} title={t('notes.graph.close')} aria-label="Close"><X size={16} /></button>
        </div>

        {/* Warning for large graphs */}
        {noteIndex.length > 500 && (
          <div className="note-graph-warning">
            {noteIndex.length}{t('notes.graph.performanceWarning')}
          </div>
        )}

        {/* Filter Bar */}
        <div className="note-graph-filters">
          <Search size={13} style={{ color: hexToRgba(style.text, 0.4), flexShrink: 0 }} />
          <input
            className="note-graph-search-input"
            placeholder={t('notes.graph.searchPlaceholder')}
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
          />
          {topTags.map(t => (
            <button
              key={t.tag}
              className={`note-graph-tag-btn ${selectedTags.has(t.tag) ? 'active' : ''}`}
              onClick={() => toggleTag(t.tag)}
              title={`${t.tag} (${t.count})`}
            >
              #{t.tag}
            </button>
          ))}
          <button
            className={`note-graph-toggle-btn ${settings.showTagEdges ? 'active' : ''}`}
            onClick={() => updateSetting('showTagEdges', !settings.showTagEdges)}
            title={t('notes.graph.tagConnectionDesc')}
          >
            {t('notes.graph.tagConnection')}
          </button>

          <div className="note-graph-layout-group">
            {([
              { id: 'force' as LayoutType, icon: <Waypoints size={12} />, label: t('notes.graph.layoutForce') },
              { id: 'circle' as LayoutType, icon: <Orbit size={12} />, label: t('notes.graph.layoutCircle') },
              { id: 'grid' as LayoutType, icon: <LayoutGrid size={12} />, label: t('notes.graph.layoutGrid') },
              { id: 'hierarchical' as LayoutType, icon: <GitBranch size={12} />, label: t('notes.graph.layoutHierarchy') },
            ]).map(l => (
              <button
                key={l.id}
                className={`note-graph-layout-btn ${!is3D && layoutType === l.id ? 'active' : ''}`}
                onClick={() => { setIs3D(false); setLayoutType(l.id); }}
                title={`${l.label} ${t('notes.graph.layout')}`}
              >
                {l.icon}
              </button>
            ))}
            <button
              className={`note-graph-layout-btn ${is3D ? 'active' : ''}`}
              onClick={() => setIs3D(v => !v)}
              title={t('notes.graph.view3d')}
            >
              <Globe size={12} />
            </button>
          </div>

          <div className="note-graph-layout-group">
            <button
              className={`note-graph-layout-btn ${localMode ? 'active' : ''}`}
              onClick={() => setLocalMode(v => !v)}
              title={t('notes.graph.localGraph')}
            >
              <Focus size={12} />
            </button>
            <button
              className={`note-graph-layout-btn ${showSettings ? 'active' : ''}`}
              onClick={() => setShowSettings(v => !v)}
              title={t('notes.graph.settings')}
            >
              <Settings2 size={12} />
            </button>
          </div>
        </div>

        <div className="note-graph-main">
          {displayData.nodes.length === 0 ? (
            <div className="note-graph-empty">
              <Network size={40} className="note-graph-empty-icon" />
              <span>{t('notes.graph.noNotes')}</span>
              {(debouncedSearch || selectedTags.size > 0 || !settings.showOrphans) && (
                <span style={{ fontSize: 11 }}>{t('notes.graph.adjustFilter')}</span>
              )}
            </div>
          ) : (
            <div
              ref={containerRef}
              className={`note-graph-canvas-container ${(dragNodeRef.current || isPanningRef.current) ? 'dragging' : ''}`}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onDoubleClick={handleDoubleClick}
              onWheel={handleWheel}
            >
              <canvas ref={canvasRef} />

              {/* Settings drawer */}
              {showSettings && (
                <div className="note-graph-settings" {...stopAll}>
                  <div className="note-graph-settings-head">
                    <Settings2 size={13} />
                    <span>{t('notes.graph.settings')}</span>
                    <button
                      type="button"
                      className="note-graph-settings-reset"
                      onClick={() => setSettings({ ...DEFAULT_GRAPH_SETTINGS, groups: [] })}
                      title={t('notes.graph.resetSettings')}
                    >
                      <RotateCcw size={12} />
                    </button>
                  </div>

                  <details open className="note-graph-settings-section">
                    <summary>{t('notes.graph.filters')}</summary>
                    <div className="note-graph-settings-body">
                      {renderToggleRow(t('notes.graph.showTagNodes'), settings.showTagNodes, v => updateSetting('showTagNodes', v))}
                      {renderToggleRow(t('notes.graph.showOrphans'), settings.showOrphans, v => updateSetting('showOrphans', v))}
                      {renderToggleRow(t('notes.graph.tagConnection'), settings.showTagEdges, v => updateSetting('showTagEdges', v))}
                      {renderSliderRow(`${t('notes.graph.localGraph')} · ${t('notes.graph.localDepth')}`, settings.localDepth, 1, 3, 1, v => updateSetting('localDepth', Math.round(v)))}
                    </div>
                  </details>

                  <details open className="note-graph-settings-section">
                    <summary>{t('notes.graph.groups')}</summary>
                    <div className="note-graph-settings-body">
                      <div className="note-graph-settings-hint">{t('notes.graph.groupsHint')}</div>
                      {settings.groups.map(group => (
                        <div key={group.id} className="note-graph-group-row">
                          <button
                            type="button"
                            className="note-graph-group-color"
                            style={{ background: group.color }}
                            onClick={() => cycleGroupColor(group.id)}
                            title={group.color}
                          />
                          <input
                            value={group.query}
                            onChange={e => updateGroupQuery(group.id, e.target.value)}
                          />
                          <button
                            type="button"
                            className="note-graph-group-remove"
                            onClick={() => removeGroup(group.id)}
                            title={t('notes.graph.removeGroup')}
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      ))}
                      <div className="note-graph-group-add">
                        <input
                          placeholder={t('notes.graph.groupQueryPlaceholder')}
                          value={groupDraft}
                          onChange={e => setGroupDraft(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') addGroup(); }}
                        />
                        <button type="button" onClick={addGroup} title={t('notes.graph.addGroup')}>
                          <Plus size={12} />
                        </button>
                      </div>
                    </div>
                  </details>

                  <details open className="note-graph-settings-section">
                    <summary>{t('notes.graph.display')}</summary>
                    <div className="note-graph-settings-body">
                      {renderToggleRow(t('notes.graph.showArrows'), settings.showArrows, v => updateSetting('showArrows', v))}
                      {renderSliderRow(t('notes.graph.nodeSize'), settings.nodeSizeScale, 0.4, 2.5, 0.05, v => updateSetting('nodeSizeScale', v), v => v.toFixed(2))}
                      {renderSliderRow(t('notes.graph.linkThickness'), settings.linkThickness, 0.4, 3, 0.05, v => updateSetting('linkThickness', v), v => v.toFixed(2))}
                      {renderSliderRow(t('notes.graph.textFade'), settings.textFadeThreshold, 0, 2, 0.05, v => updateSetting('textFadeThreshold', v), v => v.toFixed(2))}
                    </div>
                  </details>

                  <details open className="note-graph-settings-section">
                    <summary>{t('notes.graph.forces')}</summary>
                    <div className="note-graph-settings-body">
                      {renderSliderRow(t('notes.graph.centerForce'), settings.centerForce, 0, 0.15, 0.005, v => updateSetting('centerForce', v), v => v.toFixed(3))}
                      {renderSliderRow(t('notes.graph.repelForce'), settings.repelForce, 0, 3000, 50, v => updateSetting('repelForce', v), v => String(Math.round(v)))}
                      {renderSliderRow(t('notes.graph.linkForce'), settings.linkForce, 0, 0.08, 0.002, v => updateSetting('linkForce', v), v => v.toFixed(3))}
                      {renderSliderRow(t('notes.graph.linkDistance'), settings.linkDistance, 30, 320, 10, v => updateSetting('linkDistance', v), v => String(Math.round(v)))}
                    </div>
                  </details>
                </div>
              )}

              {/* Canvas controls */}
              <div className="note-graph-canvas-controls" {...stopAll}>
                <button type="button" onClick={() => zoomBy(1.25)} title={t('notes.graph.zoomIn')}><ZoomIn size={13} /></button>
                <button type="button" onClick={() => zoomBy(0.8)} title={t('notes.graph.zoomOut')}><ZoomOut size={13} /></button>
                <button type="button" onClick={zoomToFit} title={t('notes.graph.zoomFit')}><Maximize2 size={13} /></button>
                <button
                  type="button"
                  className={timelapseOn ? 'active' : ''}
                  onClick={toggleTimelapse}
                  title={t('notes.graph.timelapse')}
                >
                  {timelapseOn ? <Square size={13} /> : <Play size={13} />}
                </button>
              </div>

              {/* Local graph hint */}
              {localMode && !selectedNodeId && (
                <div className="note-graph-local-hint">{t('notes.graph.localHint')}</div>
              )}

              {/* Tooltip */}
              {hoveredNode && !dragNodeRef.current && (
                <div
                  className="note-graph-tooltip"
                  style={{ left: tooltipPos.x, top: tooltipPos.y }}
                >
                  <div className="note-graph-tooltip-title">{hoveredNode.label}</div>
                  {hoveredNode.kind === 'note' && hoveredNode.tags.length > 0 && (
                    <div className="note-graph-tooltip-tags">
                      {hoveredNode.tags.slice(0, 5).map(t => (
                        <span key={t} className="note-graph-tooltip-tag">#{t}</span>
                      ))}
                    </div>
                  )}
                  {(() => {
                    const note = noteByPath.get(hoveredNode.id);
                    if (note?.excerpt) {
                      return (
                        <div className="note-graph-tooltip-excerpt">
                          {note.excerpt.slice(0, 100)}{note.excerpt.length > 100 ? '…' : ''}
                        </div>
                      );
                    }
                    return null;
                  })()}
                  <div className="note-graph-tooltip-links">
                    {hoveredNode.linkCount} {t('notes.graph.connections')}
                  </div>
                </div>
              )}
            </div>
          )}

          <aside className="note-graph-side">
            <div className="note-graph-side-tabs">
              <button
                type="button"
                className={`note-graph-side-tab ${sideTab === 'overview' ? 'active' : ''}`}
                onClick={() => setSideTab('overview')}
                title={t('notes.graph.overviewTitle')}
              >
                <Network size={12} />
                {t('notes.graph.overview')}
              </button>
              <button
                type="button"
                className={`note-graph-side-tab ${sideTab === 'tags' ? 'active' : ''}`}
                onClick={() => setSideTab('tags')}
                title={t('notes.graph.tagsTitle')}
              >
                <Hash size={12} />
                {t('notes.graph.tags')}
              </button>
              <button
                type="button"
                className={`note-graph-side-tab ${sideTab === 'backlinks' ? 'active' : ''}`}
                onClick={() => setSideTab('backlinks')}
                title={t('notes.graph.backlinksTitle')}
              >
                <Link2 size={12} />
                {t('notes.graph.backlinks')}
              </button>
              <button
                type="button"
                className={`note-graph-side-tab ${sideTab === 'similar' ? 'active' : ''}`}
                onClick={() => setSideTab('similar')}
                title={t('notes.graph.similarTitle')}
              >
                <Sparkles size={12} />
                {t('notes.graph.similar')}
              </button>
            </div>

            <div className="note-graph-side-body">
              {sideTab === 'overview' && (
                !selectedNote ? (
                  <div className="note-graph-side-empty">
                    {t('notes.graph.selectHint1')}
                    <br />
                    {t('notes.graph.selectHint2')}
                  </div>
                ) : (
                  <>
                    <div className="note-graph-side-head">
                      <div className="note-graph-side-title">{selectedNote.title || baseName(selectedNote.path)}</div>
                      <div className="note-graph-side-path" title={selectedNote.path}>{selectedNote.path}</div>
                      <div className="note-graph-side-actions">
                        <button type="button" className="note-graph-side-btn primary" onClick={() => onOpenFile(selectedNote.path)}>
                          {t('notes.graph.open')}
                        </button>
                        <button type="button" className="note-graph-side-btn" onClick={() => centerOnNode(selectedNote.path)}>
                          {t('notes.graph.center')}
                        </button>
                        <button
                          type="button"
                          className={`note-graph-side-btn ${localMode ? 'primary' : ''}`}
                          onClick={() => setLocalMode(v => !v)}
                        >
                          {t('notes.graph.localGraph')}
                        </button>
                      </div>
                    </div>

                    {selectedNote.tags.length > 0 && (
                      <div className="note-graph-side-section">
                        <div className="note-graph-side-label">{t('notes.graph.tags')}</div>
                        <div className="note-graph-side-tags">
                          {selectedNote.tags.slice(0, 16).map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              className={`note-graph-side-tag ${selectedTags.has(tag) ? 'active' : ''}`}
                              onClick={() => toggleTag(tag)}
                            >
                              #{tag}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="note-graph-side-section">
                      <div className="note-graph-side-label"><Link2 size={12} /> {t('notes.graph.outlinks')}</div>
                      {outgoingNotes.length === 0 ? (
                        <div className="note-graph-side-empty-line">{t('notes.graph.noOutlinks')}</div>
                      ) : (
                        outgoingNotes.map((note) => (
                          <button key={note.path} type="button" className="note-graph-side-item" onClick={() => onOpenFile(note.path)} title={note.path}>
                            <FileText size={12} />
                            <span>{note.title || baseName(note.path)}</span>
                          </button>
                        ))
                      )}
                    </div>

                    <div className="note-graph-side-section">
                      <div className="note-graph-side-label"><Link2 size={12} /> {t('notes.graph.backlinks')}</div>
                      {incomingNotes.length === 0 ? (
                        <div className="note-graph-side-empty-line">{t('notes.graph.noBacklinks')}</div>
                      ) : (
                        incomingNotes.map((note) => (
                          <button key={note.path} type="button" className="note-graph-side-item" onClick={() => onOpenFile(note.path)} title={note.path}>
                            <FileText size={12} />
                            <span>{note.title || baseName(note.path)}</span>
                          </button>
                        ))
                      )}
                    </div>

                    <div className="note-graph-side-section">
                      <div className="note-graph-side-label"><Sparkles size={12} /> {t('notes.graph.similarNotes')}</div>
                      {similarNotes.length === 0 ? (
                        <div className="note-graph-side-empty-line">{t('notes.graph.noSimilar')}</div>
                      ) : (
                        similarNotes.map(({ entry, score }) => (
                          <button key={entry.path} type="button" className="note-graph-side-item" onClick={() => onOpenFile(entry.path)} title={entry.path}>
                            <FileText size={12} />
                            <span>{entry.title || baseName(entry.path)}</span>
                            <span className="note-graph-side-score">{Math.round(score * 100)}%</span>
                          </button>
                        ))
                      )}
                    </div>
                  </>
                )
              )}

              {sideTab === 'tags' && (
                <div className="note-graph-side-embedded">
                  <TagsPanel onOpenFile={onOpenFile} style={style} />
                </div>
              )}

              {sideTab === 'backlinks' && (
                <div className="note-graph-side-embedded">
                  <BacklinksPanel
                    currentFilePath={selectedNote?.path || null}
                    onOpenFile={onOpenFile}
                    style={style}
                  />
                </div>
              )}

              {sideTab === 'similar' && (
                <div className="note-graph-side-embedded">
                  <SimilarNotesPanel
                    currentFilePath={selectedNote?.path || null}
                    onOpenFile={onOpenFile}
                    style={style}
                    noteIndex={noteIndex}
                  />
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
