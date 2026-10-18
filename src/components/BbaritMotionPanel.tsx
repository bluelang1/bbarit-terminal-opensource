import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import {
  Loader2, Trash2, X, FolderOpen, ExternalLink, Film, Clapperboard,
  ImageIcon, AlertTriangle, RefreshCw, Sparkles, Play, Star, Search,
  ImagePlus, ChevronDown, Mic, Pencil, Eraser,
} from 'lucide-react';
import { makeLook, BrandMark } from './bbaritLook';
import { useDesignAgent } from './useDesignAgent';
import { subscribePanelInject, takePanelInject } from './panelInject';
import { copyImagePathToMotionRefs as copyImagePathIntoMotionRefs } from '../harness/attachmentRuntime';
import {
  CAMERA_MOTION_PRESETS, CAMERA_CATEGORIES, VFX_EFFECT_PRESETS, MAX_VFX_MIX,
  IMAGE_STYLE_PRESETS, VIDEO_DURATIONS, VIDEO_ASPECTS, MOTION_IMAGE_SIZES,
  VIDEO_MODEL_PRESETS, IMAGE_MODEL_PRESETS, resolveMotionModel,
  planMotionOutput, buildMotionAgentPrompt, buildScenarioAgentPrompt, buildExtendAgentPrompt,
  buildSpeakAgentPrompt, buildUpscaleAgentPrompt, buildVideoUpscaleAgentPrompt, buildRemoveBgAgentPrompt,
  buildInpaintAgentPrompt,
  FAL_VIDEO_CATEGORIES, FAL_IMAGE_CATEGORIES, falCatalogPageUrl, parseFalCatalogPage,
  type MotionMode, type MotionPreviewAnim, type FalCatalogModel,
} from './bbaritMotionStudio';

// BBARIT Motion — a Higgsfield-style motion studio: settings form on the left,
// generations grid on the right, and a full-screen preset gallery with
// animated motion previews. A bbarit-agent RPC child does the work through its
// fal_image / fal_video tools; the panel pre-decides output paths and renders
// each file the moment it lands on disk.

export interface BbaritMotionPanelProps {
  projectRoot: string;
  theme: { bg: string; text: string; accent?: string };
  onOpenFile?: (path: string) => void;
}

interface MotionGen {
  id: string;
  path: string;
  kind: 'video' | 'image';
  prompt: string;
  motion?: string;
  effects?: string[];
  duration?: string;
  aspect?: string;
  scenes?: number;
  status: 'pending' | 'done' | 'failed';
  error?: string;
  createdAt: number;
}

const MAX_GENERATIONS = 120;

function gensKey(root: string) {
  return `bbarit-motion-generations:${(root || 'global').replace(/\/$/, '')}`;
}
function loadGens(root: string): MotionGen[] {
  try {
    const raw = localStorage.getItem(gensKey(root));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g): g is MotionGen =>
      typeof g?.id === 'string' && typeof g?.path === 'string' && (g?.kind === 'video' || g?.kind === 'image')
    ).slice(0, MAX_GENERATIONS);
  } catch { return []; }
}
function saveGens(root: string, items: MotionGen[]) {
  try { localStorage.setItem(gensKey(root), JSON.stringify(items.slice(0, MAX_GENERATIONS))); } catch { /* quota */ }
}

const CATALOG_KEY = 'bbarit-motion-fal-catalog-v1';
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_MAX_PAGES_PER_CATEGORY = 12;

const FAVS_KEY = 'bbarit-motion-preset-favorites';

// Composer attachments survive tab switches and app restarts.
function composerKey(root: string) {
  return `bbarit-motion-composer:${(root || 'global').replace(/\/$/, '')}`;
}
function loadFavs(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch { return []; }
}

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
function fileName(path: string) {
  return path.split('/').pop() || path;
}
function aspectCss(gen: MotionGen): string {
  if (gen.kind === 'video') return (gen.aspect || '16:9').replace(':', ' / ');
  const size = MOTION_IMAGE_SIZES.find((s) => s.key === gen.aspect);
  if (size?.key.startsWith('portrait')) return '3 / 4';
  if (size?.key.startsWith('landscape')) return '4 / 3';
  return '1 / 1';
}

// Animated preview keyframes for the preset gallery — one generic camera-move
// approximation per anim class, applied to the card's gradient "scene" layer.
const PREVIEW_CSS = `
@keyframes bmZoomIn { from { transform: scale(1); } to { transform: scale(1.55); } }
@keyframes bmZoomOut { from { transform: scale(1.55); } to { transform: scale(1); } }
@keyframes bmPunchIn { from { transform: scale(1); } to { transform: scale(2.1); } }
@keyframes bmPunchOut { from { transform: scale(2.1); } to { transform: scale(1); } }
@keyframes bmYoyo { 0%,100% { transform: scale(1.05); } 50% { transform: scale(1.5); } }
@keyframes bmZoomFar { from { transform: scale(2.6); } to { transform: scale(0.7); } }
@keyframes bmPanLeft { from { transform: translateX(9%) scale(1.35); } to { transform: translateX(-9%) scale(1.35); } }
@keyframes bmPanRight { from { transform: translateX(-9%) scale(1.35); } to { transform: translateX(9%) scale(1.35); } }
@keyframes bmRise { from { transform: translateY(10%) scale(1.3); } to { transform: translateY(-10%) scale(1.3); } }
@keyframes bmFall { from { transform: translateY(-10%) scale(1.3); } to { transform: translateY(10%) scale(1.3); } }
@keyframes bmWhip { 0%,100% { transform: translateX(-14%) scale(1.4); filter: blur(0); } 45%,55% { filter: blur(3px); } 50% { transform: translateX(14%) scale(1.4); } }
@keyframes bmOrbit { from { transform: rotate(0deg) scale(1.45); } to { transform: rotate(360deg) scale(1.45); } }
@keyframes bmSpin { from { transform: perspective(220px) rotateY(0deg) scale(1.1); } to { transform: perspective(220px) rotateY(360deg) scale(1.1); } }
@keyframes bmShake { 0%,100% { transform: translate(0,0) scale(1.3); } 25% { transform: translate(-3%,2%) scale(1.3); } 50% { transform: translate(3%,-2%) scale(1.3); } 75% { transform: translate(-2%,-3%) scale(1.3); } }
@keyframes bmTilt { 0%,100% { transform: rotate(-9deg) scale(1.35); } 50% { transform: rotate(9deg) scale(1.35); } }
@keyframes bmPulse { 0%,100% { transform: scale(1.05); opacity: 0.85; } 50% { transform: scale(1.18); opacity: 1; } }
@keyframes bmFocus { 0%,100% { filter: blur(2.5px); transform: scale(1.15); } 50% { filter: blur(0); transform: scale(1.3); } }
.bm-prev { position: absolute; inset: -22%; will-change: transform; animation-play-state: paused !important; }
/* Previews play on hover only — 90 concurrent infinite animations melt the WebView. */
button:hover > * > .bm-prev, .bm-live > .bm-prev { animation-play-state: running !important; }
.bm-anim-zoom-in { animation: bmZoomIn 2.4s ease-in-out infinite alternate; }
.bm-anim-zoom-out { animation: bmZoomOut 2.4s ease-in-out infinite alternate; }
.bm-anim-punch-in { animation: bmPunchIn 0.9s cubic-bezier(.7,0,.9,1) infinite alternate; }
.bm-anim-punch-out { animation: bmPunchOut 0.9s cubic-bezier(.7,0,.9,1) infinite alternate; }
.bm-anim-yoyo { animation: bmYoyo 1.6s ease-in-out infinite; }
.bm-anim-zoom-far { animation: bmZoomFar 2.8s ease-in infinite; }
.bm-anim-pan-left { animation: bmPanLeft 2.6s ease-in-out infinite alternate; }
.bm-anim-pan-right { animation: bmPanRight 2.6s ease-in-out infinite alternate; }
.bm-anim-rise { animation: bmRise 2.6s ease-in-out infinite alternate; }
.bm-anim-fall { animation: bmFall 2.6s ease-in-out infinite alternate; }
.bm-anim-whip { animation: bmWhip 1.7s ease-in-out infinite; }
.bm-anim-orbit { animation: bmOrbit 3.6s linear infinite; }
.bm-anim-spin { animation: bmSpin 3.2s linear infinite; }
.bm-anim-shake { animation: bmShake 0.55s linear infinite; }
.bm-anim-tilt { animation: bmTilt 2.8s ease-in-out infinite; }
.bm-anim-pulse { animation: bmPulse 2s ease-in-out infinite; }
.bm-anim-focus { animation: bmFocus 2.4s ease-in-out infinite; }
.bm-anim-still { }
@keyframes bmShimmer { from { background-position: -200% 0; } to { background-position: 200% 0; } }
.bm-shimmer { background: linear-gradient(100deg, rgba(255,255,255,0.05) 40%, rgba(255,255,255,0.16) 50%, rgba(255,255,255,0.05) 60%); background-size: 200% 100%; animation: bmShimmer 1.6s linear infinite; }
`;

function PresetPreview({ anim, seed }: { anim: MotionPreviewAnim; seed: number }) {
  const hue = (seed * 47) % 360;
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 'inherit', background: '#0a0a14' }}>
      <div className={`bm-prev bm-anim-${anim}`} style={{
        background: `radial-gradient(circle at 62% 40%, hsl(${hue} 65% 62%) 0%, hsl(${hue} 55% 38%) 26%, hsl(${(hue + 40) % 360} 45% 16%) 62%, #0a0a14 100%)`,
      }}>
        <div style={{ position: 'absolute', left: '56%', top: '34%', width: '13%', aspectRatio: '1',
          borderRadius: 999, background: 'rgba(255,255,255,0.92)', boxShadow: '0 0 14px rgba(255,255,255,0.65)' }} />
        <div style={{ position: 'absolute', left: '20%', top: '58%', width: '34%', height: '7%',
          borderRadius: 999, background: 'rgba(255,255,255,0.28)' }} />
      </div>
    </div>
  );
}

export function BbaritMotionPanel({ projectRoot, theme, onOpenFile }: BbaritMotionPanelProps) {
  // Higgsfield studios are always-dark regardless of app theme — pin the look
  // to a near-black studio and keep only the brand accent from the theme.
  const L = useMemo(() => makeLook({ bg: '#0b0b10', text: '#f4f4f7', accent: theme.accent || '#ff3b4e' }), [theme.accent]);
  const motionBase = projectRoot
    ? `${projectRoot.replace(/\\/g, '/').replace(/\/$/, '')}/bbarit-motion`
    : '';
  const agent = useDesignAgent(motionBase || projectRoot, 'motion');

  const [gens, setGens] = useState<MotionGen[]>(() => loadGens(projectRoot));
  const [input, setInput] = useState('');
  // Dream-Machine-style queue: submissions stack up and render one after
  // another through the single agent child — the UI never blocks on a render.
  const [queue, setQueue] = useState<Array<{ genId: string; instruction: string; outPath: string }>>([]);
  const [running, setRunning] = useState(false);
  const busy = running || queue.length > 0;
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<MotionMode>('video');
  const [motionKey, setMotionKey] = useState<string>('');
  const [vfxKeys, setVfxKeys] = useState<string[]>([]);
  const [favs, setFavs] = useState<string[]>(() => loadFavs());
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryTab, setGalleryTab] = useState<string>('All');
  const [gallerySearch, setGallerySearch] = useState('');
  const [duration, setDuration] = useState<string>('5');
  const [aspect, setAspect] = useState<string>('16:9');
  const [sceneCount, setSceneCount] = useState(3);
  const [imageSize, setImageSize] = useState<string>('landscape_16_9');
  const [imageStyle, setImageStyle] = useState<string>('none');
  const [videoModel, setVideoModel] = useState<string>('auto');
  const [imageModel, setImageModel] = useState<string>('auto');
  const [enhance, setEnhance] = useState(true);
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [endImage, setEndImage] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<FalCatalogModel[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [modelTab, setModelTab] = useState<string>('All');

  // Prepare the persistent Motion reference folder as soon as the studio opens.
  // Every user attachment is copied here before it can become a start/end frame.
  useEffect(() => {
    if (!motionBase) return;
    void Promise.all([
      invoke('create_directory', { path: motionBase }),
      invoke('create_directory', { path: `${motionBase}/refs` }),
      invoke('create_directory', { path: `${motionBase}/images` }),
      invoke('create_directory', { path: `${motionBase}/videos` }),
    ]).catch((error) => {
      setError(`Could not prepare the BBARIT Motion reference folder: ${String(error)}`);
    });
  }, [motionBase]);

  // Full fal.ai model catalog (every public model in the media categories),
  // fetched through the app's http_request proxy and cached for a day.
  const loadCatalog = useCallback(async (force = false) => {
    if (catalogLoading) return;
    if (!force) {
      try {
        const cached = JSON.parse(localStorage.getItem(CATALOG_KEY) || 'null');
        if (cached && Date.now() - cached.at < CATALOG_TTL_MS && Array.isArray(cached.models) && cached.models.length > 0) {
          setCatalog(cached.models);
          return;
        }
      } catch { /* refetch */ }
    }
    setCatalogLoading(true);
    try {
      const all: FalCatalogModel[] = [];
      for (const category of [...FAL_VIDEO_CATEGORIES, ...FAL_IMAGE_CATEGORIES]) {
        let pages = 1;
        for (let page = 1; page <= Math.min(pages, CATALOG_MAX_PAGES_PER_CATEGORY); page++) {
          const res = await invoke<{ status: number; body: string }>('http_request', {
            input: { method: 'GET', url: falCatalogPageUrl(category, page), headers: {}, body: null, timeout_ms: 20000 },
          }).catch(() => null);
          if (!res || res.status >= 400) break;
          let parsed;
          try { parsed = parseFalCatalogPage(JSON.parse(res.body || '{}')); } catch { break; }
          pages = parsed.pages;
          all.push(...parsed.models);
        }
      }
      const seen = new Set<string>();
      const models = all.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
      if (models.length > 0) {
        setCatalog(models);
        try { localStorage.setItem(CATALOG_KEY, JSON.stringify({ at: Date.now(), models })); } catch { /* quota */ }
      } else {
        setError('Could not load the fal.ai model catalog — check your network and retry.');
      }
    } finally {
      setCatalogLoading(false);
    }
  }, [catalogLoading]);

  // FAL key availability — the whole studio runs on fal.ai, so surface a
  // setup banner instead of failing on the first job.
  const [falReady, setFalReady] = useState<boolean | null>(null);
  const checkFalKey = useCallback(async () => {
    setFalReady(null);
    try {
      const home = await invoke<string>('get_home_dir');
      const readText = (path: string) => invoke<string>('read_file', { path }).catch(() => '');
      // /login fal stores the key under the "fal" provider in the agent's auth.json.
      const hasFalLogin = (raw: string) => {
        try {
          const fal = JSON.parse(raw)?.fal;
          return Boolean(fal && (fal.key || Object.keys(fal.env ?? {}).length > 0));
        } catch { return false; }
      };
      const [agentAuth, legacyAuth, env] = await Promise.all([
        readText(`${home}/.bbarit/agent/auth.json`),
        readText(`${home}/.bbarit-agent/auth.json`),
        readText(`${home}/.config/octo/.env`),
      ]);
      setFalReady(hasFalLogin(agentAuth) || hasFalLogin(legacyAuth) || /^\s*FAL(_API)?_KEY\s*=\s*\S/m.test(env));
    } catch {
      setFalReady(false);
    }
  }, []);
  useEffect(() => { void checkFalKey(); }, [checkFalKey]);
  // The full catalog IS the model list — load it up front (24h cache).
  useEffect(() => { void loadCatalog(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore the attached frames for this project — verify the files still
  // exist so a deleted ref never leaves a broken thumbnail.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = JSON.parse(localStorage.getItem(composerKey(projectRoot)) || 'null');
        for (const [key, set] of [['sourceImage', setSourceImage], ['endImage', setEndImage]] as const) {
          const path = typeof saved?.[key] === 'string' ? saved[key] : '';
          if (!path) continue;
          const exists = await invoke<boolean>('path_exists', { path }).catch(() => false);
          if (!cancelled && exists) set(path);
        }
      } catch { /* fresh start */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);
  useEffect(() => {
    try { localStorage.setItem(composerKey(projectRoot), JSON.stringify({ sourceImage, endImage })); } catch { /* quota */ }
  }, [projectRoot, sourceImage, endImage]);

  // Guard: never save one root's generations under another root's key.
  const [gensRoot, setGensRoot] = useState(projectRoot);
  useEffect(() => {
    setGens(loadGens(projectRoot));
    setGensRoot(projectRoot);
  }, [projectRoot]);
  useEffect(() => {
    if (gensRoot !== projectRoot) return;
    saveGens(projectRoot, gens);
  }, [projectRoot, gensRoot, gens]);

  useEffect(() => {
    try { localStorage.setItem(FAVS_KEY, JSON.stringify(favs.slice(0, 40))); } catch { /* quota */ }
  }, [favs]);

  const patchGen = useCallback((id: string, patch: Partial<MotionGen>) => {
    setGens((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }, []);

  // Poll every pending card's target file — across tab switches and remounts,
  // not just while this mount is busy: the detached agent keeps rendering
  // while the panel is away, so the file can land at any time. A card only
  // flips to interrupted once its render budget is clearly blown.
  const gensRef = useRef(gens);
  gensRef.current = gens;
  const hasPending = gens.some((g) => g.status === 'pending');
  useEffect(() => {
    if (!hasPending) return;
    const budgetMs = (kind: MotionGen['kind']) => (kind === 'video' ? 20 * 60_000 : 6 * 60_000);
    const t = setInterval(() => {
      void (async () => {
        for (const gen of gensRef.current.filter((g) => g.status === 'pending')) {
          const exists = await invoke<boolean>('path_exists', { path: gen.path }).catch(() => false);
          if (exists) patchGen(gen.id, { status: 'done' });
          else if (Date.now() - gen.createdAt > budgetMs(gen.kind)) {
            patchGen(gen.id, { status: 'failed', error: 'interrupted' });
          }
        }
      })();
    }, 2500);
    return () => clearInterval(t);
  }, [hasPending, patchGen]);

  const copyImagePathToMotionRefs = useCallback(async (sourcePath: string): Promise<string> => {
    if (!projectRoot) throw new Error('Open a project first.');
    return copyImagePathIntoMotionRefs(sourcePath, projectRoot);
  }, [projectRoot]);

  const pickImageFile = useCallback(async (title: string): Promise<string | null> => {
    try {
      const picked = await invoke<string | null>('open_file_dialog', {
        defaultPath: projectRoot || undefined,
        title,
      });
      if (picked && /\.(png|jpe?g|webp|gif)$/i.test(picked)) {
        return await copyImagePathToMotionRefs(picked);
      }
      if (picked) setError('Pick an image file (png / jpg / webp / gif).');
    } catch (error) {
      setError(`Could not copy the selected image into BBARIT Motion: ${String(error)}`);
    }
    return null;
  }, [copyImagePathToMotionRefs, projectRoot]);

  // Pasted or dropped image files land in the workspace refs folder so the
  // agent tool can read them by path.
  const importImageBlob = useCallback(async (file: File, slot: 'start' | 'end' = 'start') => {
    if (!file.type.startsWith('image/') || !motionBase) return false;
    const b64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(new Error('cannot read image'));
      reader.readAsDataURL(file);
    }).catch(() => '');
    if (!b64) return false;
    const safe = (file.name || 'pasted.png').replace(/[\\/:*?"<>|]/g, '_');
    const path = `${motionBase}/refs/${Date.now().toString(36)}-${safe}`;
    try {
      await invoke('create_directory', { path: `${motionBase}/refs` });
      await invoke('write_file_base64', { path, base64Data: b64 });
      const exists = await invoke<boolean>('path_exists', { path });
      if (!exists) throw new Error(`The copied image was not created: ${path}`);
      if (slot === 'end') setEndImage(path); else setSourceImage(path);
      return true;
    } catch (error) {
      setError(`Could not copy the attached image into BBARIT Motion: ${String(error)}`);
      return false;
    }
  }, [motionBase]);

  // End frame rides on Kling's start/end-frame support only.
  const endFrameSupported = mode === 'video' && (videoModel === 'auto' || videoModel.startsWith('kling'));

  // ── Draw canvas: Draw-to-Video sketches AND brush inpainting ──
  // Sketch mode paints a scene (optionally over the start frame) and uses it
  // as the start frame. Inpaint mode paints a mask over a generated image; the
  // white mask area is regenerated by fal (flux-general/inpainting).
  const [drawOpen, setDrawOpen] = useState(false);
  const [drawMode, setDrawMode] = useState<'sketch' | 'inpaint'>('sketch');
  const [inpaintTarget, setInpaintTarget] = useState<string | null>(null);
  const [inpaintPrompt, setInpaintPrompt] = useState('');
  const [drawColor, setDrawColor] = useState('#ff3b4e');
  const [drawSize, setDrawSize] = useState(6);
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawPtrRef = useRef({ down: false, x: 0, y: 0 });

  const loadImageData = useCallback(async (path: string): Promise<HTMLImageElement | null> => {
    // read_file_base64 → data URI keeps the canvas untainted (asset: URLs
    // would block toDataURL in WebKit).
    const b64 = await invoke<string>('read_file_base64', { path }).catch(() => '');
    if (!b64) return null;
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = `data:image/png;base64,${b64}`;
    });
  }, []);

  const paintDrawBackground = useCallback(async () => {
    const canvas = drawCanvasRef.current;
    const mask = maskCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    if (drawMode === 'inpaint' && inpaintTarget) {
      const img = await loadImageData(inpaintTarget);
      if (!img) return;
      // The mask must align 1:1 with the image, so both canvases take the
      // image's own dimensions (capped to keep the payload sane).
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      canvas.width = w; canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
      if (mask) {
        mask.width = w; mask.height = h;
        const mctx = mask.getContext('2d');
        if (mctx) { mctx.fillStyle = '#000'; mctx.fillRect(0, 0, w, h); }
      }
      return;
    }
    canvas.width = 1280; canvas.height = 720;
    ctx.fillStyle = '#101018';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!sourceImage) return;
    const img = await loadImageData(sourceImage);
    if (!img) return;
    const scale = Math.max(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }, [drawMode, inpaintTarget, sourceImage, loadImageData]);

  useEffect(() => {
    if (drawOpen) void paintDrawBackground();
  }, [drawOpen, paintDrawBackground]);

  const drawPoint = useCallback((e: React.PointerEvent<HTMLCanvasElement>, start: boolean) => {
    const canvas = drawCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    if (!start && drawPtrRef.current.down) {
      const stroke = (target: CanvasRenderingContext2D, style: string, width: number) => {
        target.strokeStyle = style;
        target.lineWidth = width;
        target.lineCap = 'round';
        target.lineJoin = 'round';
        target.beginPath();
        target.moveTo(drawPtrRef.current.x, drawPtrRef.current.y);
        target.lineTo(x, y);
        target.stroke();
      };
      if (drawMode === 'inpaint') {
        // Visible: translucent brand red; hidden mask: solid white (= inpaint).
        stroke(ctx, 'rgba(255,59,78,0.55)', drawSize * 3);
        const mctx = maskCanvasRef.current?.getContext('2d');
        if (mctx) stroke(mctx, '#ffffff', drawSize * 3);
      } else {
        stroke(ctx, drawColor, drawSize);
      }
    }
    drawPtrRef.current = { down: true, x, y };
  }, [drawColor, drawSize, drawMode]);

  const saveSketch = useCallback(async () => {
    const canvas = drawCanvasRef.current;
    if (!canvas || !motionBase) return;
    const b64 = canvas.toDataURL('image/png').split(',')[1] || '';
    if (!b64) return;
    const path = `${motionBase}/refs/sketch-${Date.now().toString(36)}.png`;
    try {
      await invoke('create_directory', { path: `${motionBase}/refs` }).catch(() => {});
      await invoke('write_file_base64', { path, base64Data: b64 });
      setSourceImage(path);
      setDrawOpen(false);
      if (mode !== 'video') setMode('video');
    } catch (e) {
      setError(`sketch save failed: ${e}`);
    }
  }, [motionBase, mode]);

  const runInpaint = useCallback(async () => {
    const mask = maskCanvasRef.current;
    const target = inpaintTarget;
    const req = inpaintPrompt.trim();
    if (!mask || !target || !motionBase) return;
    if (!req) { setError('Describe what should appear in the painted area.'); return; }
    const b64 = mask.toDataURL('image/png').split(',')[1] || '';
    if (!b64) return;
    const stamp = Date.now().toString(36);
    const maskPath = `${motionBase}/refs/mask-${stamp}.png`;
    try {
      await invoke('create_directory', { path: `${motionBase}/refs` }).catch(() => {});
      await invoke('write_file_base64', { path: maskPath, base64Data: b64 });
    } catch (e) {
      setError(`mask save failed: ${e}`);
      return;
    }
    const dot = target.lastIndexOf('.');
    const outPath = `${dot > 0 ? target.slice(0, dot) : target}-inpaint-${stamp}.png`;
    const next: MotionGen = {
      id: genId(), path: outPath, kind: 'image', prompt: `Inpaint: ${req}`,
      status: 'pending', createdAt: Date.now(),
    };
    setGens((prev) => [next, ...prev].slice(0, MAX_GENERATIONS));
    setQueue((q) => [...q, {
      genId: next.id, outPath,
      instruction: buildInpaintAgentPrompt({ imagePath: target, maskPath, prompt: req, outPath }),
    }]);
    setInpaintPrompt('');
    setDrawOpen(false);
  }, [inpaintTarget, inpaintPrompt, motionBase]);

  // Serial queue runner: one agent turn at a time, next job auto-starts.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  useEffect(() => {
    if (running || queue.length === 0) return;
    const job = queue[0];
    setRunning(true);
    void (async () => {
      try {
        const result = await agentRef.current.run(job.instruction);
        const exists = await invoke<boolean>('path_exists', { path: job.outPath }).catch(() => false);
        if (exists) {
          patchGen(job.genId, { status: 'done' });
        } else {
          const why = result.error || agentRef.current.log.filter((l) => l.role === 'agent').pop()?.text || 'generation failed';
          patchGen(job.genId, { status: 'failed', error: why.slice(0, 500) });
        }
      } finally {
        setQueue((q) => q.slice(1));
        setRunning(false);
      }
    })();
  }, [queue, running, patchGen]);

  // Elapsed-time ticker for pending cards.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!gens.some((g) => g.status === 'pending')) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [gens]);

  const generate = useCallback(async () => {
    let req = input.trim();
    // Higgsfield-style: the prompt is optional when an image is attached —
    // the preset alone can drive the shot.
    if (!req) {
      if (mode === 'video' && sourceImage) req = 'Bring this image to life with natural, cinematic motion';
      else {
        setError(mode === 'image' ? 'Describe the image to generate.'
          : mode === 'scenario' ? 'Write the story for the scenario.'
            : mode === 'speak' ? 'Write the script the avatar should speak.'
              : 'Type a prompt or attach a start image.');
        return;
      }
    }
    if (mode === 'speak' && !sourceImage) { setError('Attach a face photo to animate.'); return; }
    if (!projectRoot) { setError('Open a project first — media is saved into the project folder.'); return; }
    if (sourceImage) {
      const exists = await invoke<boolean>('path_exists', { path: sourceImage }).catch(() => false);
      if (!exists) {
        setSourceImage(null);
        setError('The attached start image is missing. Attach it again so it can be copied into bbarit-motion/refs.');
        return;
      }
    }
    if (mode === 'video' && endFrameSupported && endImage) {
      const exists = await invoke<boolean>('path_exists', { path: endImage }).catch(() => false);
      if (!exists) {
        setEndImage(null);
        setError('The attached end image is missing. Attach it again so it can be copied into bbarit-motion/refs.');
        return;
      }
    }
    setError(null);
    try {
      await Promise.all([
        invoke('create_directory', { path: motionBase }),
        invoke('create_directory', { path: `${motionBase}/refs` }),
        invoke('create_directory', { path: `${motionBase}/images` }),
        invoke('create_directory', { path: `${motionBase}/videos` }),
      ]);
    } catch (error) {
      setError(`Could not prepare the BBARIT Motion folder: ${String(error)}`);
      return;
    }

    const outPath = planMotionOutput(motionBase, mode, req, Date.now());
    const usesPresets = mode === 'video' || mode === 'scenario';
    const gen: MotionGen = {
      id: genId(), path: outPath, kind: mode === 'image' ? 'image' : 'video', prompt: req,
      status: 'pending', createdAt: Date.now(),
      motion: usesPresets ? (motionKey || undefined) : undefined,
      effects: usesPresets && vfxKeys.length ? [...vfxKeys] : undefined,
      duration: mode === 'video' ? duration : undefined,
      aspect: mode === 'image' ? imageSize : aspect,
      scenes: mode === 'scenario' ? sceneCount : undefined,
    };
    setGens((prev) => [gen, ...prev].slice(0, MAX_GENERATIONS));
    setInput('');
    // The attached frames stay after generating (Higgsfield keeps them) so
    // variations can be fired back-to-back — only the X button removes them.
    const jobSource = sourceImage || undefined;
    const jobEnd = (mode === 'video' && endFrameSupported && endImage) ? endImage : undefined;
    const instruction = mode === 'speak'
      ? buildSpeakAgentPrompt({ imagePath: jobSource!, script: req, outPath })
      : mode === 'scenario'
      ? buildScenarioAgentPrompt({
        story: req, outPath, sceneCount, aspect,
        cameraMotion: motionKey || undefined,
        effects: vfxKeys.length ? vfxKeys : undefined,
        model: resolveMotionModel('video', videoModel, false),
      })
      : buildMotionAgentPrompt({
        mode, prompt: req, outPath, sourceImage: jobSource, endImage: jobEnd, enhance,
        cameraMotion: mode === 'video' ? (motionKey || undefined) : undefined,
        effects: mode === 'video' ? vfxKeys : undefined,
        duration, aspect, imageSize,
        styleSuffix: mode === 'image' ? IMAGE_STYLE_PRESETS.find((p) => p.key === imageStyle)?.suffix || undefined : undefined,
        model: resolveMotionModel(mode === 'image' ? 'image' : 'video', mode === 'image' ? imageModel : videoModel, !!jobSource),
      });
    setQueue((q) => [...q, { genId: gen.id, instruction, outPath }]);
  }, [input, projectRoot, motionBase, mode, motionKey, vfxKeys, duration, aspect, sceneCount,
    imageSize, imageStyle, videoModel, imageModel, enhance, sourceImage, endImage, endFrameSupported]);

  // Card actions that are one fal_run call: image upscale, video 4K, bg removal.
  const enqueueCardAction = useCallback((
    gen: MotionGen, suffix: string, ext: 'png' | 'mp4', label: string,
    build: (src: string, out: string) => string,
  ) => {
    const dot = gen.path.lastIndexOf('.');
    const outPath = `${dot > 0 ? gen.path.slice(0, dot) : gen.path}-${suffix}.${ext}`;
    const next: MotionGen = {
      id: genId(), path: outPath, kind: ext === 'mp4' ? 'video' : 'image',
      prompt: `${label}: ${gen.prompt}`,
      status: 'pending', createdAt: Date.now(), aspect: gen.aspect, duration: gen.duration,
    };
    setGens((prev) => [next, ...prev].slice(0, MAX_GENERATIONS));
    setQueue((q) => [...q, { genId: next.id, outPath, instruction: build(gen.path, outPath) }]);
  }, []);
  const upscaleImage = useCallback((gen: MotionGen) => enqueueCardAction(gen, 'up', 'png', 'Upscaled', buildUpscaleAgentPrompt), [enqueueCardAction]);
  const upscaleVideo = useCallback((gen: MotionGen) => enqueueCardAction(gen, '4k', 'mp4', '4K', buildVideoUpscaleAgentPrompt), [enqueueCardAction]);
  const removeBg = useCallback((gen: MotionGen) => enqueueCardAction(gen, 'nobg', 'png', 'No background', buildRemoveBgAgentPrompt), [enqueueCardAction]);

  // Dream-Machine-style extend: continue a finished clip by one more shot.
  const extendVideo = useCallback((gen: MotionGen) => {
    const dot = gen.path.lastIndexOf('.');
    const outPath = `${dot > 0 ? gen.path.slice(0, dot) : gen.path}-ext-${Date.now().toString(36)}.mp4`;
    const next: MotionGen = {
      id: genId(), path: outPath, kind: 'video', prompt: `Extended: ${gen.prompt}`,
      status: 'pending', createdAt: Date.now(), motion: gen.motion, effects: gen.effects,
      duration: gen.duration, aspect: gen.aspect,
    };
    setGens((prev) => [next, ...prev].slice(0, MAX_GENERATIONS));
    setQueue((q) => [...q, {
      genId: next.id,
      outPath,
      instruction: buildExtendAgentPrompt({
        videoPath: gen.path, prompt: gen.prompt, outPath,
        aspect: gen.aspect && gen.aspect.includes(':') ? gen.aspect : '16:9',
        model: resolveMotionModel('video', videoModel, true),
      }),
    }]);
  }, [videoModel]);

  // Gateway hand-off (motion.generate): queue → open panel → auto-submit.
  const pendingSendRef = useRef(false);
  useEffect(() => subscribePanelInject('motion', () => {
    const p = takePanelInject('motion');
    if (p && p.trim()) { setInput(p); pendingSendRef.current = true; }
  }), []);
  useEffect(() => {
    if (pendingSendRef.current && input.trim()) {
      pendingSendRef.current = false;
      void generate();
    }
  }, [input, generate]);

  const deleteGen = useCallback(async (gen: MotionGen) => {
    await invoke('delete_path', { path: gen.path }).catch(() => {});
    setGens((prev) => prev.filter((g) => g.id !== gen.id));
  }, []);

  const toggleFav = useCallback((key: string) => {
    setFavs((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  // Queueing while another job renders is allowed — only an empty form blocks.
  const canGenerate = !!input.trim() || (mode === 'video' && !!sourceImage);
  const selectedMotion = CAMERA_MOTION_PRESETS.find((p) => p.key === motionKey) || null;

  // Every catalog model of the current mode's categories, grouped for the
  // <select> — the dropdown carries the FULL fal.ai roster, not just presets.
  const catalogGroups = useMemo(() => {
    const categories = mode === 'image' ? FAL_IMAGE_CATEGORIES : FAL_VIDEO_CATEGORIES;
    return categories.map((category) => ({
      category,
      models: (catalog || []).filter((m) => m.category === category),
    })).filter((g) => g.models.length > 0);
  }, [catalog, mode]);

  const galleryItems = useMemo(() => {
    const q = gallerySearch.trim().toLowerCase();
    const matches = (label: string) => !q || label.toLowerCase().includes(q);
    const cams = CAMERA_MOTION_PRESETS
      .filter((p) => galleryTab === 'All' || galleryTab === p.category || (galleryTab === '⭐' && favs.includes(p.key)))
      .filter((p) => galleryTab !== 'FX' && matches(p.label));
    const fx = VFX_EFFECT_PRESETS
      .filter((p) => galleryTab === 'All' || galleryTab === 'FX' || (galleryTab === '⭐' && favs.includes(p.key)))
      .filter((p) => matches(p.label));
    return { cams: galleryTab === 'FX' ? [] : cams, fx: (galleryTab === 'All' || galleryTab === 'FX' || galleryTab === '⭐') ? fx : [] };
  }, [galleryTab, gallerySearch, favs]);

  const selectStyle: React.CSSProperties = {
    border: `1px solid ${L.border}`, background: L.card, color: L.ink, borderRadius: 9,
    fontSize: 11.5, padding: '6px 8px', cursor: 'pointer', width: '100%',
  };
  const fieldLabel: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: L.faint, letterSpacing: '0.06em' };
  const dropzoneStyle = (active: boolean): React.CSSProperties => ({
    flex: 1, minWidth: 0, height: 74, borderRadius: 11, position: 'relative', overflow: 'hidden',
    border: `1.5px dashed ${active ? L.accent : L.border}`, background: L.card, cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
  });

  const renderCard = (gen: MotionGen) => (
    <div key={gen.id} style={{ borderRadius: 12, overflow: 'hidden', border: `1px solid ${L.border}`,
      background: L.card, display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative', aspectRatio: aspectCss(gen), minHeight: 130, background: '#000' }}>
        {gen.status === 'done' ? (
          gen.kind === 'video' ? (
            <video src={convertFileSrc(gen.path)} controls loop
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }} />
          ) : (
            <img src={convertFileSrc(gen.path)} alt={gen.prompt}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          )
        ) : gen.status === 'pending' ? (
          <div className="bm-shimmer" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 7, color: 'rgba(255,255,255,0.85)' }}>
            <Loader2 size={20} className="spin" />
            <span style={{ fontSize: 10.5 }}>
              {gen.scenes ? `Rendering ${gen.scenes} scenes — several minutes` : gen.kind === 'video' ? 'Rendering — a few minutes' : 'Generating…'}
            </span>
            <span style={{ fontSize: 9.5, opacity: 0.75 }}>{Math.max(0, Math.floor((now - gen.createdAt) / 1000))}s</span>
          </div>
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 6, color: '#ff7b8a', padding: 12, textAlign: 'center' }}>
            <X size={18} />
            <span style={{ fontSize: 10, lineHeight: 1.5, maxHeight: 60, overflow: 'hidden' }}>{gen.error || 'failed'}</span>
          </div>
        )}
        {gen.status === 'done' && (
          <div style={{ position: 'absolute', right: 6, top: 6, display: 'flex', gap: 4 }}>
            {gen.kind === 'image' && (
              <button type="button" title="Animate this image" onClick={() => { setSourceImage(gen.path); setMode('video'); }}
                style={{ width: 24, height: 24, borderRadius: 7, border: 0, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer' }}>
                <Play size={12} />
              </button>
            )}
            {gen.kind === 'video' && (
              <button type="button" title="Extend +5s (continue this shot)" onClick={() => extendVideo(gen)}
                style={{ height: 24, padding: '0 7px', borderRadius: 7, border: 0, display: 'flex', alignItems: 'center',
                  gap: 3, background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer', fontSize: 9.5, fontWeight: 700 }}>
                +5s
              </button>
            )}
            {gen.kind === 'video' && (
              <button type="button" title="Upscale to 4K (Topaz)" onClick={() => upscaleVideo(gen)}
                style={{ height: 24, padding: '0 7px', borderRadius: 7, border: 0, display: 'flex', alignItems: 'center',
                  gap: 3, background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer', fontSize: 9.5, fontWeight: 700 }}>
                4K
              </button>
            )}
            {gen.kind === 'image' && (
              <>
                <button type="button" title="Upscale (Clarity)" onClick={() => upscaleImage(gen)}
                  style={{ height: 24, padding: '0 7px', borderRadius: 7, border: 0, display: 'flex', alignItems: 'center',
                    gap: 3, background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer', fontSize: 9.5, fontWeight: 700 }}>
                  HD
                </button>
                <button type="button" title="Remove background (transparent PNG)" onClick={() => removeBg(gen)}
                  style={{ height: 24, padding: '0 7px', borderRadius: 7, border: 0, display: 'flex', alignItems: 'center',
                    gap: 3, background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer', fontSize: 9.5, fontWeight: 700 }}>
                  BG
                </button>
              </>
            )}
            <button type="button" title="Reveal in folder" onClick={() => void invoke('reveal_in_explorer', { path: gen.path }).catch(() => {})}
              style={{ width: 24, height: 24, borderRadius: 7, border: 0, display: 'flex', alignItems: 'center',
                justifyContent: 'center', background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer' }}>
              <FolderOpen size={12} />
            </button>
            {onOpenFile && gen.kind === 'image' && (
              <button type="button" title="Open in editor" onClick={() => onOpenFile(gen.path)}
                style={{ width: 24, height: 24, borderRadius: 7, border: 0, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer' }}>
                <ExternalLink size={12} />
              </button>
            )}
          </div>
        )}
        <button type="button" title="Delete" onClick={() => void deleteGen(gen)}
          style={{ position: 'absolute', left: 6, top: 6, width: 24, height: 24, borderRadius: 7, border: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#B81F35'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.6)'; }}>
          <Trash2 size={12} />
        </button>
      </div>
      <div style={{ padding: '7px 10px 9px', display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 11, color: L.ink, lineHeight: 1.45, display: '-webkit-box',
          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={gen.prompt}>
          {gen.prompt}
        </span>
        <span style={{ fontSize: 9.5, color: L.faint, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          {gen.scenes ? <span>🎬 {gen.scenes} scenes</span> : null}
          {gen.motion ? <span>{CAMERA_MOTION_PRESETS.find((p) => p.key === gen.motion)?.label}</span> : null}
          {(gen.effects || []).map((fx) => {
            const preset = VFX_EFFECT_PRESETS.find((p) => p.key === fx);
            return preset ? <span key={fx}>{preset.icon} {preset.label}</span> : null;
          })}
          {gen.kind === 'video' && gen.duration ? <span>{gen.duration}s</span> : null}
        </span>
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, background: L.bg, color: L.ink, fontFamily: L.sans, position: 'relative' }}
      onDragOver={(e) => { e.preventDefault(); }}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file) void importImageBlob(file);
      }}>
      <style>{PREVIEW_CSS}</style>

      {/* ── Left: settings form ── */}
      <div style={{ width: 330, flexShrink: 0, borderRight: `1px solid ${L.border}`, background: L.rail,
        display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: '13px 14px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <BrandMark size={17} />
          <span style={{ fontFamily: L.serif, fontSize: 15, fontWeight: 600 }}>BBARIT Motion</span>
          {agent.model && (
            <button type="button" onClick={agent.cycleModel} title="Agent model — click to cycle"
              style={{ marginLeft: 'auto', border: `1px solid ${L.border}`, background: L.card, color: L.muted,
                borderRadius: 999, fontSize: 9.5, padding: '3px 8px', cursor: 'pointer', maxWidth: 110,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {agent.model}
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '2px 14px 14px',
          display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Mode */}
          <div style={{ display: 'flex', border: `1px solid ${L.border}`, borderRadius: 11, overflow: 'hidden' }}>
            {([['video', 'Video', Film], ['image', 'Image', ImageIcon], ['scenario', 'Scenario', Clapperboard], ['speak', 'Speak', Mic]] as const).map(([m, label, Icon]) => (
              <button key={m} type="button" onClick={() => setMode(m)}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  padding: '8px 0', border: 0, fontSize: 11, fontWeight: mode === m ? 700 : 500, cursor: 'pointer',
                  background: mode === m ? L.accentSoft : L.card, color: mode === m ? L.accentDeep : L.soft }}>
                <Icon size={12} />{label}
              </button>
            ))}
          </div>

          {/* Frames / upload */}
          {mode !== 'scenario' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ ...fieldLabel, display: 'flex', alignItems: 'center' }}>
                {mode === 'video' ? 'FRAMES' : mode === 'speak' ? 'FACE PHOTO' : 'SOURCE IMAGE'}
                {mode === 'video' && (
                  <button type="button" onClick={() => setDrawOpen(true)}
                    title="Draw-to-Video — sketch a scene (over the start frame if attached) and animate it"
                    style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, padding: '3px 9px',
                      borderRadius: 999, border: `1px solid ${L.border}`, background: L.card, color: L.soft,
                      fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>
                    <Pencil size={10} /> Draw
                  </button>
                )}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={dropzoneStyle(!!sourceImage)} title="Click to choose, or paste / drop an image"
                  onClick={() => void pickImageFile(mode === 'video' ? 'Choose the start frame' : mode === 'speak' ? 'Choose the face photo' : 'Choose a source image').then((p) => { if (p) setSourceImage(p); })}>
                  {sourceImage ? (
                    <>
                      <img src={convertFileSrc(sourceImage)} alt="start"
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                      <button type="button" title="Remove"
                        onClick={(e) => { e.stopPropagation(); setSourceImage(null); }}
                        style={{ position: 'absolute', right: 4, top: 4, width: 20, height: 20, borderRadius: 6, border: 0,
                          background: 'rgba(0,0,0,0.65)', color: '#fff', cursor: 'pointer', display: 'flex',
                          alignItems: 'center', justifyContent: 'center' }}>
                        <X size={11} />
                      </button>
                      <span style={{ position: 'absolute', left: 5, bottom: 4, fontSize: 8.5, fontWeight: 700,
                        background: 'rgba(0,0,0,0.65)', color: '#fff', borderRadius: 5, padding: '2px 6px' }}>
                        {mode === 'video' ? 'START' : mode === 'speak' ? 'FACE' : 'SOURCE'}
                      </span>
                    </>
                  ) : (
                    <>
                      <ImagePlus size={16} color={L.faint} />
                      <span style={{ fontSize: 9.5, color: L.faint, textAlign: 'center', lineHeight: 1.4 }}>
                        {mode === 'video' ? 'Start frame' : mode === 'speak' ? 'Face photo' : 'Image to edit'}<br />click · paste · drop
                      </span>
                    </>
                  )}
                </div>
                {endFrameSupported && (
                  <div style={dropzoneStyle(!!endImage)} title="End frame (Kling start→end) — click to choose"
                    onClick={() => void pickImageFile('Choose the end frame').then((p) => { if (p) setEndImage(p); })}>
                    {endImage ? (
                      <>
                        <img src={convertFileSrc(endImage)} alt="end"
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                        <button type="button" title="Remove"
                          onClick={(e) => { e.stopPropagation(); setEndImage(null); }}
                          style={{ position: 'absolute', right: 4, top: 4, width: 20, height: 20, borderRadius: 6, border: 0,
                            background: 'rgba(0,0,0,0.65)', color: '#fff', cursor: 'pointer', display: 'flex',
                            alignItems: 'center', justifyContent: 'center' }}>
                          <X size={11} />
                        </button>
                        <span style={{ position: 'absolute', left: 5, bottom: 4, fontSize: 8.5, fontWeight: 700,
                          background: 'rgba(0,0,0,0.65)', color: '#fff', borderRadius: 5, padding: '2px 6px' }}>END</span>
                      </>
                    ) : (
                      <>
                        <ImagePlus size={16} color={L.faint} />
                        <span style={{ fontSize: 9.5, color: L.faint, textAlign: 'center', lineHeight: 1.4 }}>End frame<br />(optional)</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Motion & FX picker */}
          {(mode === 'video' || mode === 'scenario') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={fieldLabel}>MOTION & FX</span>
              <button type="button" onClick={() => setGalleryOpen(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${motionKey || vfxKeys.length ? L.accent : L.border}`,
                  background: L.card, borderRadius: 11, padding: '8px 10px', cursor: 'pointer', color: L.ink, textAlign: 'left' }}>
                <span style={{ position: 'relative', width: 52, height: 32, borderRadius: 7, overflow: 'hidden', flexShrink: 0 }}>
                  <PresetPreview anim={selectedMotion?.anim || 'orbit'} seed={selectedMotion ? CAMERA_MOTION_PRESETS.indexOf(selectedMotion) : 7} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 12, fontWeight: 700 }}>
                    {selectedMotion ? selectedMotion.label : 'Auto camera'}
                  </span>
                  <span style={{ display: 'block', fontSize: 10, color: L.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {vfxKeys.length
                      ? vfxKeys.map((k) => VFX_EFFECT_PRESETS.find((p) => p.key === k)?.label).filter(Boolean).join(' + ')
                      : `${CAMERA_MOTION_PRESETS.length} camera moves · ${VFX_EFFECT_PRESETS.length} effects`}
                  </span>
                </span>
                <ChevronDown size={14} color={L.faint} />
              </button>
              {favs.length > 0 && (
                <div style={{ display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 2 }}>
                  {favs.map((key) => {
                    const cam = CAMERA_MOTION_PRESETS.find((p) => p.key === key);
                    const fx = VFX_EFFECT_PRESETS.find((p) => p.key === key);
                    if (!cam && !fx) return null;
                    const active = cam ? motionKey === key : vfxKeys.includes(key);
                    return (
                      <button key={key} type="button" title={cam ? 'Favorite camera move' : 'Favorite effect'}
                        onClick={() => {
                          if (cam) setMotionKey((cur) => (cur === key ? '' : key));
                          else setVfxKeys((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : (cur.length >= MAX_VFX_MIX ? cur : [...cur, key])));
                        }}
                        style={{ padding: '4px 9px', borderRadius: 999, border: `1px solid ${active ? L.accent : L.border}`,
                          background: active ? L.accentSoft : L.card, color: active ? L.accentDeep : L.soft,
                          fontSize: 10, fontWeight: active ? 700 : 500, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                        ⭐ {cam?.label || `${fx!.icon} ${fx!.label}`}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Prompt */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={fieldLabel}>{mode === 'scenario' ? 'STORY' : mode === 'speak' ? 'SCRIPT' : 'PROMPT'}</span>
            <textarea value={input} rows={mode === 'scenario' || mode === 'speak' ? 5 : 3}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void generate(); }
              }}
              onPaste={(e) => {
                const file = e.clipboardData?.files?.[0];
                if (file && file.type.startsWith('image/')) { e.preventDefault(); void importImageBlob(file); }
              }}
              placeholder={mode === 'scenario'
                ? 'Write the story — the agent splits it into scenes, renders each, and stitches the final cut…'
                : mode === 'speak'
                  ? 'Write what the avatar should say — a voice is generated and lip-synced to the photo…'
                  : mode === 'video'
                    ? (sourceImage ? 'Optional — describe the motion, or just hit Generate' : 'Describe the shot — subject, scene, mood…')
                    : 'Describe the image to generate…'}
              style={{ resize: 'none', border: `1px solid ${L.border}`, borderRadius: 11,
                background: L.card, color: L.ink, fontSize: 12, lineHeight: 1.55, padding: '9px 11px',
                fontFamily: L.sans, outline: 'none' }} />
          </div>

          {/* Settings */}
          {mode !== 'speak' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={fieldLabel}>SETTINGS</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {mode === 'image' ? (
                <>
                  <select value={imageModel}
                    onChange={(e) => {
                      if (e.target.value === '__browse') { setModelTab('All'); setModelPickerOpen(true); void loadCatalog(); }
                      else setImageModel(e.target.value);
                    }}
                    style={selectStyle}
                    title={IMAGE_MODEL_PRESETS.find((p) => p.key === imageModel)?.desc || imageModel}>
                    {IMAGE_MODEL_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                    {imageModel.includes('/') && !(catalog || []).some((m) => m.id === imageModel)
                      && <option value={imageModel}>{imageModel.replace(/^fal-ai\//, '')}</option>}
                    <option value="__browse">🔍 Search all models…</option>
                    {catalogGroups.map((g) => (
                      <optgroup key={g.category} label={`${g.category} (${g.models.length})`}>
                        {g.models.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  <select value={imageSize} onChange={(e) => setImageSize(e.target.value)} style={selectStyle} title="Image size">
                    {MOTION_IMAGE_SIZES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                  <select value={imageStyle} onChange={(e) => setImageStyle(e.target.value)} style={{ ...selectStyle, gridColumn: '1 / -1' }} title="Style preset">
                    {IMAGE_STYLE_PRESETS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </>
              ) : (
                <>
                  <select value={videoModel}
                    onChange={(e) => {
                      if (e.target.value === '__browse') { setModelTab('All'); setModelPickerOpen(true); void loadCatalog(); }
                      else setVideoModel(e.target.value);
                    }}
                    style={selectStyle}
                    title={VIDEO_MODEL_PRESETS.find((p) => p.key === videoModel)?.desc || videoModel}>
                    {VIDEO_MODEL_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                    {videoModel.includes('/') && !(catalog || []).some((m) => m.id === videoModel)
                      && <option value={videoModel}>{videoModel.replace(/^fal-ai\//, '')}</option>}
                    <option value="__browse">🔍 Search all models…</option>
                    {catalogGroups.map((g) => (
                      <optgroup key={g.category} label={`${g.category} (${g.models.length})`}>
                        {g.models.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  <select value={aspect} onChange={(e) => setAspect(e.target.value)} style={selectStyle} title="Aspect ratio">
                    {VIDEO_ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                  {mode === 'video' ? (
                    <select value={duration} onChange={(e) => setDuration(e.target.value)} style={selectStyle} title="Clip length">
                      {VIDEO_DURATIONS.map((d) => <option key={d} value={d}>{d}s</option>)}
                    </select>
                  ) : (
                    <select value={sceneCount} onChange={(e) => setSceneCount(Number(e.target.value))} style={selectStyle} title="Number of scenes">
                      {[2, 3, 4].map((n) => <option key={n} value={n}>{n} scenes</option>)}
                    </select>
                  )}
                  <button type="button" onClick={() => setEnhance((v) => !v)}
                    title="Let the agent polish your prompt into cinematic language"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 9,
                      border: `1px solid ${enhance ? L.accent : L.border}`, background: enhance ? L.accentSoft : L.card,
                      color: enhance ? L.accentDeep : L.soft, fontSize: 11, fontWeight: enhance ? 700 : 500, cursor: 'pointer' }}>
                    <Sparkles size={11} /> Enhance
                  </button>
                </>
              )}
            </div>
          </div>
          )}

          {/* Generate */}
          <button type="button" onClick={() => void generate()} disabled={!canGenerate}
            style={{ height: 42, borderRadius: 12, border: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 7, fontSize: 13.5, fontWeight: 800, cursor: canGenerate ? 'pointer' : 'not-allowed',
              background: canGenerate ? L.accent : L.border, color: '#fff' }}>
            {busy ? <Loader2 size={16} className="spin" /> : <Play size={15} />}
            {mode === 'scenario' ? 'Generate Scenario' : mode === 'image' ? 'Generate Image' : mode === 'speak' ? 'Generate Avatar' : 'Generate Video'}
            {busy && ` (${queue.length} in queue)`}
          </button>
          {busy && agent.activity && (
            <span style={{ fontSize: 10, color: L.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {agent.activity}
            </span>
          )}
          {error && (
            <span style={{ fontSize: 11, color: '#B81F35', display: 'flex', alignItems: 'flex-start', gap: 5 }}>
              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} /> {error}
            </span>
          )}
        </div>
      </div>

      {/* ── Right: generations ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {falReady === false && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px',
            background: '#e0a80020', borderBottom: `1px solid ${L.borderSoft}`, color: L.soft, fontSize: 11.5 }}>
            <AlertTriangle size={14} color="#e0a800" style={{ flexShrink: 0 }} />
            <span style={{ lineHeight: 1.5 }}>
              <b>fal.ai key not found.</b> Run <code>/login fal</code> in the BBARIT Agent
              {' '}(get a key at <code>fal.ai/dashboard/keys</code>), then retry.
            </span>
            <button type="button" onClick={() => void checkFalKey()} title="Check again"
              style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 999,
                border: `1px solid ${L.border}`, background: L.card, color: L.soft, fontSize: 10.5, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
              <RefreshCw size={11} /> Retry
            </button>
          </div>
        )}
        <div style={{ padding: '12px 16px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Film size={13} color={L.accent} />
          <span style={{ fontSize: 12, fontWeight: 700, color: L.soft }}>Generations</span>
          <span style={{ fontSize: 10.5, color: L.muted }}>{gens.length > 0 ? gens.length : ''}</span>
          {motionBase && (
            <button type="button" title={`Open output folder\n${motionBase}`}
              onClick={() => void (async () => {
                await invoke('create_directory', { path: motionBase }).catch(() => {});
                await invoke('reveal_in_explorer', { path: motionBase }).catch(() => {});
              })()}
              style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, border: 0, background: 'transparent',
                color: L.faint, fontSize: 10.5, cursor: 'pointer' }}>
              <FolderOpen size={11} /> Output folder
            </button>
          )}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '4px 16px 16px' }}>
          {gens.length === 0 ? (
            <div style={{ marginTop: 64, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <BrandMark size={26} />
              <div style={{ fontFamily: L.serif, fontSize: 17, color: L.soft }}>What should we set in motion?</div>
              <div style={{ fontSize: 12, color: L.muted, lineHeight: 1.7, maxWidth: 380 }}>
                Pick a camera move or effect, drop in an image, and fal.ai renders it —
                no prompt needed. Scenario mode turns a whole story into a stitched multi-scene cut.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', maxWidth: 480, marginTop: 4 }}>
                {([
                  { p: 'Neon-lit street racer drifting in the rain', m: 'car_chasing', fx: [] as string[], tag: 'Car Chasing' },
                  { p: 'Warrior standing on a cliff at sunset', m: 'crash_zoom_in', fx: ['thunder_god'], tag: 'Crash Zoom + Thunder' },
                  { p: 'Astronaut walking through a cyberpunk market', m: 'fpv_drone', fx: [], tag: 'FPV Drone' },
                  { p: 'Dancer frozen mid-leap in a warehouse', m: 'bullet_time', fx: [], tag: 'Bullet Time' },
                ]).map(({ p, m, fx, tag }) => (
                  <button key={p} type="button" title={p}
                    onClick={() => { setInput(p); setMotionKey(m); setVfxKeys(fx); setMode('video'); }}
                    style={{ padding: '6px 11px', borderRadius: 999, border: `1px solid ${L.border}`, background: L.card,
                      color: L.soft, fontSize: 11, cursor: 'pointer' }}>
                    🎬 {tag}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
              {gens.map(renderCard)}
            </div>
          )}
        </div>
      </div>

      {/* ── Preset gallery modal ── */}
      {galleryOpen && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'rgba(8,8,14,0.72)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 26 }}
          onClick={() => setGalleryOpen(false)}>
          <div style={{ width: 'min(880px, 100%)', maxHeight: '100%', background: L.bg, borderRadius: 16,
            border: `1px solid ${L.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${L.borderSoft}` }}>
              <Clapperboard size={15} color={L.accent} />
              <span style={{ fontFamily: L.serif, fontSize: 14.5, fontWeight: 600 }}>Motion & FX presets</span>
              <span style={{ fontSize: 10.5, color: L.faint }}>1 camera move + up to {MAX_VFX_MIX} effects</span>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${L.border}`,
                  background: L.card, borderRadius: 999, padding: '4px 10px' }}>
                  <Search size={11} color={L.faint} />
                  <input value={gallerySearch} onChange={(e) => setGallerySearch(e.target.value)} placeholder="Search…"
                    style={{ border: 0, background: 'transparent', color: L.ink, fontSize: 11, outline: 'none', width: 110 }} />
                </span>
                <button type="button" onClick={() => setGalleryOpen(false)} title="Done"
                  style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 999,
                    border: 0, background: L.accent, color: '#fff', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>
                  Done
                </button>
              </div>
            </div>
            <div style={{ padding: '9px 16px 0', display: 'flex', gap: 5, overflowX: 'auto' }}>
              {['All', '⭐', ...CAMERA_CATEGORIES, 'FX'].map((cat) => (
                <button key={cat} type="button" onClick={() => setGalleryTab(cat)}
                  style={{ padding: '5px 11px', borderRadius: 999, border: `1px solid ${galleryTab === cat ? L.accent : L.border}`,
                    background: galleryTab === cat ? L.accentSoft : L.card, color: galleryTab === cat ? L.accentDeep : L.soft,
                    fontSize: 10.5, fontWeight: galleryTab === cat ? 700 : 500, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {cat === 'FX' ? '⚡ FX' : cat}
                </button>
              ))}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: 16,
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))', gap: 10 }}>
              {galleryItems.cams.map((p) => {
                const active = motionKey === p.key;
                const fav = favs.includes(p.key);
                return (
                  <button key={p.key} type="button"
                    onClick={() => setMotionKey((cur) => (cur === p.key ? '' : p.key))}
                    title={`${p.category} — click to ${active ? 'clear' : 'select'}`}
                    style={{ position: 'relative', borderRadius: 11, overflow: 'hidden', cursor: 'pointer', padding: 0,
                      border: `2px solid ${active ? L.accent : L.border}`, background: '#000', height: 96, textAlign: 'left' }}>
                    <PresetPreview anim={p.anim} seed={CAMERA_MOTION_PRESETS.indexOf(p)} />
                    <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '14px 8px 6px',
                      background: 'linear-gradient(transparent, rgba(0,0,0,0.85))', color: '#fff', fontSize: 10.5, fontWeight: 700 }}>
                      {p.label}
                      <span style={{ display: 'block', fontSize: 8.5, fontWeight: 500, color: 'rgba(255,255,255,0.65)' }}>{p.category}</span>
                    </span>
                    {active && (
                      <span style={{ position: 'absolute', left: 6, top: 6, background: L.accent, color: '#fff',
                        borderRadius: 999, fontSize: 8.5, fontWeight: 800, padding: '2px 7px' }}>SELECTED</span>
                    )}
                    <span role="button" title={fav ? 'Remove from favorites' : 'Add to favorites'}
                      onClick={(e) => { e.stopPropagation(); toggleFav(p.key); }}
                      style={{ position: 'absolute', right: 5, top: 5, width: 22, height: 22, borderRadius: 7,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                        background: 'rgba(0,0,0,0.55)', color: fav ? '#ffd257' : 'rgba(255,255,255,0.75)' }}>
                      <Star size={12} fill={fav ? '#ffd257' : 'none'} />
                    </span>
                  </button>
                );
              })}
              {galleryItems.fx.map((p) => {
                const active = vfxKeys.includes(p.key);
                const fav = favs.includes(p.key);
                return (
                  <button key={p.key} type="button"
                    onClick={() => setVfxKeys((cur) => (
                      active ? cur.filter((k) => k !== p.key) : (cur.length >= MAX_VFX_MIX ? cur : [...cur, p.key])
                    ))}
                    title={active ? 'Click to remove' : `VFX — mix up to ${MAX_VFX_MIX}`}
                    style={{ position: 'relative', borderRadius: 11, overflow: 'hidden', cursor: 'pointer', padding: 0,
                      border: `2px solid ${active ? L.accent : L.border}`, background: '#0a0a14', height: 96, textAlign: 'left' }}>
                    <span className="bm-anim-pulse" style={{ position: 'absolute', inset: 0, display: 'flex',
                      alignItems: 'center', justifyContent: 'center', fontSize: 34 }}>
                      {p.icon}
                    </span>
                    <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '14px 8px 6px',
                      background: 'linear-gradient(transparent, rgba(0,0,0,0.85))', color: '#fff', fontSize: 10.5, fontWeight: 700 }}>
                      {p.label}
                      <span style={{ display: 'block', fontSize: 8.5, fontWeight: 500, color: 'rgba(255,255,255,0.65)' }}>Effect</span>
                    </span>
                    {active && (
                      <span style={{ position: 'absolute', left: 6, top: 6, background: L.accent, color: '#fff',
                        borderRadius: 999, fontSize: 8.5, fontWeight: 800, padding: '2px 7px' }}>MIXED</span>
                    )}
                    <span role="button" title={fav ? 'Remove from favorites' : 'Add to favorites'}
                      onClick={(e) => { e.stopPropagation(); toggleFav(p.key); }}
                      style={{ position: 'absolute', right: 5, top: 5, width: 22, height: 22, borderRadius: 7,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                        background: 'rgba(0,0,0,0.55)', color: fav ? '#ffd257' : 'rgba(255,255,255,0.75)' }}>
                      <Star size={12} fill={fav ? '#ffd257' : 'none'} />
                    </span>
                  </button>
                );
              })}
              {galleryItems.cams.length === 0 && galleryItems.fx.length === 0 && (
                <span style={{ fontSize: 11.5, color: L.faint, gridColumn: '1 / -1', textAlign: 'center', padding: 30 }}>
                  No presets match — clear the search or pick another tab.
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Draw-to-Video sketch modal ── */}
      {drawOpen && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 42, background: 'rgba(8,8,14,0.78)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 26 }}
          onClick={() => setDrawOpen(false)}>
          <div style={{ background: L.bg, borderRadius: 16, border: `1px solid ${L.border}`,
            display: 'flex', flexDirection: 'column', overflow: 'hidden', maxWidth: '100%' }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${L.borderSoft}` }}>
              <Pencil size={14} color={L.accent} />
              <span style={{ fontFamily: L.serif, fontSize: 14, fontWeight: 600 }}>Draw to Video</span>
              <span style={{ fontSize: 10.5, color: L.faint }}>
                {sourceImage ? 'Sketch motion over the start frame' : 'Sketch the scene, then animate it'}
              </span>
              <button type="button" onClick={() => setDrawOpen(false)} title="Close"
                style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: L.faint, cursor: 'pointer', display: 'flex' }}>
                <X size={15} />
              </button>
            </div>
            <canvas ref={drawCanvasRef} width={1280} height={720}
              style={{ width: 'min(860px, 82vw)', aspectRatio: '16 / 9', display: 'block', cursor: 'crosshair', touchAction: 'none' }}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawPoint(e, true); }}
              onPointerMove={(e) => { if (drawPtrRef.current.down) drawPoint(e, false); }}
              onPointerUp={() => { drawPtrRef.current.down = false; }}
              onPointerLeave={() => { drawPtrRef.current.down = false; }} />
            <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, borderTop: `1px solid ${L.borderSoft}` }}>
              {['#ff3b4e', '#ffffff', '#3b82f6', '#22c55e', '#f59e0b', '#101018'].map((c) => (
                <button key={c} type="button" onClick={() => setDrawColor(c)}
                  title={c === '#101018' ? 'Background color (eraser)' : 'Brush color'}
                  style={{ width: 20, height: 20, borderRadius: 999, cursor: 'pointer', background: c,
                    border: `2px solid ${drawColor === c ? L.accent : L.border}` }} />
              ))}
              <input type="range" min={2} max={28} value={drawSize} title="Brush size"
                onChange={(e) => setDrawSize(Number(e.target.value))} style={{ width: 110 }} />
              <button type="button" onClick={() => void paintDrawBackground()} title="Clear the sketch"
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 11px', borderRadius: 999,
                  border: `1px solid ${L.border}`, background: L.card, color: L.soft, fontSize: 10.5, cursor: 'pointer' }}>
                <Eraser size={11} /> Clear
              </button>
              <button type="button" onClick={() => void saveSketch()}
                style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px',
                  borderRadius: 999, border: 0, background: L.accent, color: '#fff', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>
                <Play size={12} /> Use as start frame
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── fal.ai model catalog modal ── */}
      {modelPickerOpen && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 41, background: 'rgba(8,8,14,0.72)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 26 }}
          onClick={() => setModelPickerOpen(false)}>
          <div style={{ width: 'min(760px, 100%)', height: '100%', maxHeight: 620, background: L.bg, borderRadius: 16,
            border: `1px solid ${L.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${L.borderSoft}` }}>
              <Film size={15} color={L.accent} />
              <span style={{ fontFamily: L.serif, fontSize: 14.5, fontWeight: 600 }}>All fal.ai models</span>
              <span style={{ fontSize: 10.5, color: L.faint }}>
                {catalogLoading ? 'loading catalog…' : catalog ? `${catalog.length} models` : ''}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${L.border}`,
                  background: L.card, borderRadius: 999, padding: '4px 10px' }}>
                  <Search size={11} color={L.faint} />
                  <input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} placeholder="Search models…"
                    style={{ border: 0, background: 'transparent', color: L.ink, fontSize: 11, outline: 'none', width: 130 }} />
                </span>
                <button type="button" onClick={() => void loadCatalog(true)} title="Refresh the catalog"
                  style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 999,
                    border: `1px solid ${L.border}`, background: L.card, color: L.soft, fontSize: 10.5, cursor: 'pointer' }}>
                  <RefreshCw size={11} className={catalogLoading ? 'spin' : undefined} />
                </button>
                <button type="button" onClick={() => setModelPickerOpen(false)} title="Close"
                  style={{ display: 'flex', alignItems: 'center', padding: '5px 12px', borderRadius: 999,
                    border: 0, background: L.accent, color: '#fff', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>
                  Close
                </button>
              </div>
            </div>
            <div style={{ padding: '9px 16px 0', display: 'flex', gap: 5, overflowX: 'auto' }}>
              {['All', ...(mode === 'image' ? FAL_IMAGE_CATEGORIES : FAL_VIDEO_CATEGORIES)].map((cat) => (
                <button key={cat} type="button" onClick={() => setModelTab(cat)}
                  style={{ padding: '5px 11px', borderRadius: 999, border: `1px solid ${modelTab === cat ? L.accent : L.border}`,
                    background: modelTab === cat ? L.accentSoft : L.card, color: modelTab === cat ? L.accentDeep : L.soft,
                    fontSize: 10.5, fontWeight: modelTab === cat ? 700 : 500, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {cat}
                </button>
              ))}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '10px 16px 16px',
              display: 'flex', flexDirection: 'column', gap: 6 }}>
              {catalogLoading && !catalog && (
                <span style={{ fontSize: 11.5, color: L.faint, textAlign: 'center', padding: 30, display: 'flex',
                  alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <Loader2 size={14} className="spin" /> Loading the full fal.ai catalog…
                </span>
              )}
              {(catalog || [])
                .filter((m) => (mode === 'image' ? (FAL_IMAGE_CATEGORIES as readonly string[]) : (FAL_VIDEO_CATEGORIES as readonly string[])).includes(m.category))
                .filter((m) => modelTab === 'All' || m.category === modelTab)
                .filter((m) => {
                  const q = modelSearch.trim().toLowerCase();
                  return !q || m.id.toLowerCase().includes(q) || m.title.toLowerCase().includes(q) || m.desc.toLowerCase().includes(q);
                })
                .map((m) => {
                  const active = (mode === 'image' ? imageModel : videoModel) === m.id;
                  return (
                    <button key={m.id} type="button"
                      onClick={() => {
                        if (mode === 'image') setImageModel(m.id); else setVideoModel(m.id);
                        setModelPickerOpen(false);
                      }}
                      title={m.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 9px', borderRadius: 11,
                        border: `1.5px solid ${active ? L.accent : L.border}`, background: active ? L.accentSoft : L.card,
                        cursor: 'pointer', textAlign: 'left' }}>
                      {m.thumb ? (
                        <img src={m.thumb} alt="" loading="lazy"
                          onError={(e) => { e.currentTarget.style.display = 'none'; }}
                          style={{ width: 46, height: 30, objectFit: 'cover', borderRadius: 6, flexShrink: 0, background: '#000' }} />
                      ) : (
                        <span style={{ width: 46, height: 30, borderRadius: 6, flexShrink: 0, background: '#0a0a14' }} />
                      )}
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 11.5, fontWeight: 700, color: L.ink }}>{m.title}</span>
                          <span style={{ fontSize: 9, color: L.faint, border: `1px solid ${L.borderSoft}`,
                            borderRadius: 999, padding: '1px 6px', flexShrink: 0 }}>{m.category}</span>
                        </span>
                        <span style={{ display: 'block', fontSize: 9.5, color: L.faint, overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.id}{m.desc ? ` — ${m.desc}` : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
