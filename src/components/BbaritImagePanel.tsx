import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import {
  Loader2, ArrowUp, Plus, Trash2, X, FolderOpen, ExternalLink,
  ZoomIn, ImageIcon, Scaling, Check, Copy, AlertTriangle, RefreshCw, Paperclip,
} from 'lucide-react';
import { makeLook, BrandMark, Thinking } from './bbaritLook';
import { subscribePanelInject, takePanelInject } from './panelInject';
import { runCliPrompt } from '../harness/cliRuntime';
import {
  IMAGE_SIZE_PRESETS, IMAGE_STYLE_PRESETS, CUSTOM_SIZE_KEY, parseCustomSize,
  planBatchOutputs, planEditOutput, resizedOutputPath,
  buildCodexImageJobPrompt, runWithConcurrency, type ImageJobSpec,
} from './bbaritImageStudio';

// BBARIT Image — a chat-style bulk image studio driven by the Codex CLI's
// image generation. Each request fans out into headless `codex exec` jobs
// (one per image), results stream into the chat as they land on disk, and
// generated images can be selected for follow-up edit passes or resized
// locally without another generation round-trip.

export interface BbaritImagePanelProps {
  projectRoot: string;
  theme: { bg: string; text: string; accent?: string };
  onOpenFile?: (path: string) => void;
}

interface GenImage {
  id: string;
  path: string;
  prompt: string;
  w: number;
  h: number;
  status: 'pending' | 'done' | 'failed';
  error?: string;
}

interface ImageMsg {
  id: string;
  role: 'you' | 'agent' | 'sys';
  text: string;
  images?: GenImage[];
}

interface ImageSession {
  id: string;
  title: string;
  dir: string;
  createdAt: number;
  messages: ImageMsg[];
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface PendingAttachment {
  id: number;
  name: string;
  b64: string;
  preview: string;
}

const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

const MAX_SESSIONS = 40;
const MAX_MESSAGES = 80;
const JOB_CONCURRENCY = 3;
const JOB_TIMEOUT_SECS = 420;
const COUNT_OPTIONS = [1, 2, 3, 4, 6, 8];

function sessionsKey(root: string) {
  return `bbarit-image-sessions:${(root || 'global').replace(/\/$/, '')}`;
}
function loadSessions(root: string): ImageSession[] {
  try {
    const raw = localStorage.getItem(sessionsKey(root));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is ImageSession =>
      typeof s?.id === 'string' && typeof s?.dir === 'string' && Array.isArray(s?.messages)
    ).slice(0, MAX_SESSIONS);
  } catch { return []; }
}
function saveSessions(root: string, items: ImageSession[]) {
  try { localStorage.setItem(sessionsKey(root), JSON.stringify(items.slice(0, MAX_SESSIONS))); } catch { /* quota */ }
}

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function fileName(path: string) {
  return path.split('/').pop() || path;
}

// Load a PNG from disk, redraw it at exactly w×h (cover fit, centered), and
// save the result as a sibling file. No Codex round-trip needed.
async function resizeImageFile(srcPath: string, w: number, h: number): Promise<string> {
  const b64 = await invoke<string>('read_file_base64', { path: srcPath });
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('cannot decode image'));
    img.src = `data:image/png;base64,${b64}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const out = resizedOutputPath(srcPath, w, h);
  await invoke('write_file_base64', { path: out, base64Data: canvas.toDataURL('image/png').split(',')[1] || '' });
  return out;
}

export function BbaritImagePanel({ projectRoot, theme, onOpenFile }: BbaritImagePanelProps) {
  const L = useMemo(() => makeLook(theme), [theme]);
  const [sessions, setSessions] = useState<ImageSession[]>(() => loadSessions(projectRoot));
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => loadSessions(projectRoot)[0]?.id ?? null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(2);
  const [sizeKey, setSizeKey] = useState(IMAGE_SIZE_PRESETS[0].key);
  const [customSize, setCustomSize] = useState('1200x630');
  const [presetKey, setPresetKey] = useState(IMAGE_STYLE_PRESETS[0].key);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachIdRef = useRef(1);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [lightbox, setLightbox] = useState<GenImage | null>(null);
  const [lightboxCustom, setLightboxCustom] = useState('1200x630');
  const [imgVer, setImgVer] = useState<Record<string, number>>({});
  const logRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;
  const messages = activeSession?.messages || [];

  // Esc returns from the enlarged image to the chat.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // Codex CLI availability — the whole panel is driven by `codex exec`, so
  // surface a warning instead of failing quietly when it is not installed.
  const [codexReady, setCodexReady] = useState<boolean | null>(null);
  const checkCodex = useCallback(async () => {
    setCodexReady(null);
    try {
      const out = await invoke<string>('run_cli_oneshot', { command: 'codex --version', timeoutSecs: 20 });
      setCodexReady(/\d/.test(out));
    } catch {
      setCodexReady(false);
    }
  }, []);
  useEffect(() => { void checkCodex(); }, [checkCodex]);

  // Output location — inside the current codebase (user decision 2026-07-08),
  // directly under the project root since the makeke layer was dropped
  // (user decision 2026-07-10). The old makeke path stays scanned as legacy.
  const newBase = projectRoot ? `${projectRoot.replace(/\\/g, '/').replace(/\/$/, '')}/bbarit-image` : null;
  const legacyBase = projectRoot ? `${projectRoot.replace(/\\/g, '/').replace(/\/$/, '')}/makeke/bbarit-image` : null;
  const [outputBase, setOutputBase] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) setOutputBase(newBase);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  // sessionsRoot travels with the sessions state so the save effect can tell
  // whether `sessions` was actually loaded for the current projectRoot. Saving
  // without this guard clobbers the new root's storage with the previous
  // root's (often empty) session list whenever projectRoot changes.
  const [sessionsRoot, setSessionsRoot] = useState(projectRoot);
  useEffect(() => {
    const items = loadSessions(projectRoot);
    setSessions(items);
    setSessionsRoot(projectRoot);
    setActiveSessionId(items[0]?.id ?? null);
    setSelected([]);
  }, [projectRoot]);

  useEffect(() => {
    if (sessionsRoot !== projectRoot) return;
    saveSessions(projectRoot, sessions);
  }, [projectRoot, sessionsRoot, sessions]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages.length, busy]);

  const patchSession = useCallback((sessionId: string, fn: (s: ImageSession) => ImageSession) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? fn(s) : s)));
  }, []);

  const appendMsg = useCallback((sessionId: string, msg: ImageMsg) => {
    patchSession(sessionId, (s) => ({ ...s, messages: [...s.messages, msg].slice(-MAX_MESSAGES) }));
  }, [patchSession]);

  const patchImage = useCallback((sessionId: string, imageId: string, patch: Partial<GenImage>) => {
    patchSession(sessionId, (s) => ({
      ...s,
      messages: s.messages.map((m) => (
        m.images?.some((i) => i.id === imageId)
          ? { ...m, images: m.images.map((i) => (i.id === imageId ? { ...i, ...patch } : i)) }
          : m
      )),
    }));
  }, [patchSession]);

  // Reconcile stale "pending" images (e.g. after an app restart) against disk.
  useEffect(() => {
    if (!activeSession || busy) return;
    const pending = activeSession.messages.flatMap((m) => (m.images || []).filter((i) => i.status === 'pending'));
    if (pending.length === 0) return;
    void (async () => {
      for (const img of pending) {
        const exists = await invoke<boolean>('path_exists', { path: img.path }).catch(() => false);
        patchImage(activeSession.id, img.id, { status: exists ? 'done' : 'failed', error: exists ? undefined : 'interrupted' });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // The poll interval needs the latest sessions without re-subscribing.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // While jobs run, poll the target files so thumbnails appear the moment
  // Codex writes them, even before the job's final reply comes back.
  useEffect(() => {
    if (!busy || !activeSessionId) return;
    const sessionId = activeSessionId;
    const t = setInterval(() => {
      void (async () => {
        const current = sessionsRef.current.find((s) => s.id === sessionId);
        const pending = (current?.messages || []).flatMap((m) => (m.images || []).filter((i) => i.status === 'pending'));
        for (const img of pending) {
          const exists = await invoke<boolean>('path_exists', { path: img.path }).catch(() => false);
          if (exists) {
            patchImage(sessionId, img.id, { status: 'done' });
            setImgVer((prev) => ({ ...prev, [img.path]: Date.now() }));
          }
        }
      })();
    }, 2500);
    return () => clearInterval(t);
  }, [busy, activeSessionId, patchImage]);

  const resolveSize = useCallback((): { w: number; h: number } | null => {
    if (sizeKey === CUSTOM_SIZE_KEY) return parseCustomSize(customSize);
    const preset = IMAGE_SIZE_PRESETS.find((p) => p.key === sizeKey);
    return preset ? { w: preset.w, h: preset.h } : null;
  }, [sizeKey, customSize]);

  // Switching the style preset applies its recommended canvas size and count.
  const applyPreset = useCallback((key: string) => {
    setPresetKey(key);
    const preset = IMAGE_STYLE_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    if (preset.count) setCount(preset.count);
    if (preset.size) {
      const match = IMAGE_SIZE_PRESETS.find((s) => s.w === preset.size!.w && s.h === preset.size!.h);
      if (match) setSizeKey(match.key);
      else { setSizeKey(CUSTOM_SIZE_KEY); setCustomSize(`${preset.size.w}x${preset.size.h}`); }
    }
  }, []);

  const addAttachmentFiles = useCallback((incoming: FileList | File[]) => {
    for (const f of Array.from(incoming)) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > ATTACH_MAX_BYTES) {
        setError(`${f.name}: too large (max 25 MB).`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || '');
        const b64 = url.split(',')[1];
        if (!b64) return;
        setAttachments((prev) => prev.length >= 6 ? prev : [...prev, {
          id: attachIdRef.current++,
          name: f.name || `pasted-${Date.now()}.png`,
          b64,
          preview: url,
        }]);
      };
      reader.readAsDataURL(f);
    }
  }, []);

  const knownPaths = useMemo(
    () => messages.flatMap((m) => (m.images || []).map((i) => i.path)),
    [messages],
  );

  const send = useCallback(async () => {
    const req = input.trim();
    if (!req || busy) return;
    if (!projectRoot) { setError('Open a project first — images are saved into the project folder.'); return; }
    if (codexReady === false) { setError('Codex CLI is not installed — install it first (npm i -g @openai/codex).'); return; }
    const size = resolveSize();
    if (!size) { setError('Custom size must look like 1200x630 (64–4096).'); return; }
    setError(null);

    let session = activeSession;
    if (!session) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const base = outputBase ?? legacyBase;
      if (!base) { setError('Output folder is not ready yet — try again in a second.'); return; }
      const dir = `${base}/${ts}`;
      await invoke('create_directory', { path: dir }).catch(() => {});
      session = { id: `bi-${Date.now()}`, title: req.slice(0, 60), dir, createdAt: Date.now(), messages: [] };
      setSessions((prev) => [session!, ...prev].slice(0, MAX_SESSIONS));
      setActiveSessionId(session.id);
    }
    const sessionId = session.id;
    const editing = selected.length > 0;
    const stylePreset = IMAGE_STYLE_PRESETS.find((p) => p.key === presetKey) ?? IMAGE_STYLE_PRESETS[0];
    const system = stylePreset.system || undefined;

    // Persist pending attachments into the session as reference images.
    const refImages: string[] = [];
    if (attachments.length > 0) {
      const refsDir = `${session.dir}/refs`;
      await invoke('create_directory', { path: refsDir }).catch(() => {});
      for (const a of attachments) {
        const safe = a.name.replace(/[\\/:*?"<>|]/g, '_') || 'ref.png';
        const p = `${refsDir}/${a.id}-${safe}`;
        try { await invoke('write_file_base64', { path: p, base64Data: a.b64 }); refImages.push(p); } catch { /* skip */ }
      }
      setAttachments([]);
    }
    const refs = refImages.length > 0 ? refImages : undefined;

    // Plan one Codex job per output image.
    const jobs: ImageJobSpec[] = [];
    if (editing) {
      const taken = [...knownPaths];
      for (const ref of selected) {
        const outPath = planEditOutput(ref, taken);
        taken.push(outPath);
        jobs.push({ outPath, prompt: req, w: size.w, h: size.h, refPath: ref, system, refImages: refs });
      }
    } else {
      const outputs = planBatchOutputs(session.dir, req, count, Date.now());
      outputs.forEach((outPath, i) => {
        const part = { index: i + 1, total: outputs.length };
        jobs.push({
          outPath, prompt: req, w: size.w, h: size.h, system, refImages: refs,
          ...(stylePreset.series ? { section: part } : { variation: part }),
        });
      });
    }

    const unit = stylePreset.series ? 'section' : 'image';
    const images: GenImage[] = jobs.map((job) => ({
      id: genId(), path: job.outPath, prompt: req, w: job.w, h: job.h, status: 'pending',
    }));
    appendMsg(sessionId, {
      id: genId(), role: 'you',
      text: [
        req,
        ' ',
        editing
          ? ` (edit ${selected.length} image${selected.length > 1 ? 's' : ''}, ${size.w}×${size.h})`
          : ` (${stylePreset.key !== 'image' ? `${stylePreset.label}, ` : ''}${count} ${unit}${count > 1 ? 's' : ''}, ${size.w}×${size.h})`,
        refImages.length > 0 ? ` (📎 ${refImages.length})` : '',
      ].join(''),
    });
    appendMsg(sessionId, { id: genId(), role: 'agent', text: editing ? 'Editing with Codex…' : 'Generating with Codex…', images });

    setInput('');
    setSelected([]);
    setBusy(true);
    try {
      const results = await runWithConcurrency(jobs, JOB_CONCURRENCY, async (job, i) => {
        await runCliPrompt('codex-cli', buildCodexImageJobPrompt(job), session!.dir, JOB_TIMEOUT_SECS);
        const exists = await invoke<boolean>('path_exists', { path: job.outPath }).catch(() => false);
        if (!exists) throw new Error('Codex finished but the image file was not saved.');
        patchImage(sessionId, images[i].id, { status: 'done' });
        setImgVer((prev) => ({ ...prev, [job.outPath]: Date.now() }));
      });
      let done = 0;
      results.forEach((r, i) => {
        if (r.ok) { done++; return; }
        patchImage(sessionId, images[i].id, { status: 'failed', error: r.error });
      });
      appendMsg(sessionId, {
        id: genId(), role: 'sys',
        text: done === jobs.length
          ? `✓ ${done} image${done > 1 ? 's' : ''} saved`
          : `✓ ${done}/${jobs.length} saved — ${jobs.length - done} failed`,
      });
      if (done < jobs.length) {
        const firstError = results.find((r) => !r.ok);
        if (firstError && !firstError.ok) setError(firstError.error.slice(0, 200));
      }
    } finally {
      setBusy(false);
    }
  }, [input, busy, projectRoot, codexReady, outputBase, legacyBase, resolveSize, activeSession, selected, knownPaths, count, presetKey, attachments, appendMsg, patchImage]);

  // Prompt hand-off from the gateway UI command bus (image.generate): fill the
  // input, then auto-generate once React has flushed the new input into `send`.
  const pendingSendRef = useRef(false);
  useEffect(() => subscribePanelInject('image', () => {
    const p = takePanelInject('image');
    if (p && p.trim()) { setInput(p); pendingSendRef.current = true; }
  }), []);
  useEffect(() => {
    if (pendingSendRef.current && input.trim() && !busy) {
      pendingSendRef.current = false;
      void send();
    }
  }, [input, busy, send]);

  // Works without an active session too (disk-only images from the history
  // rail) — the resized file still lands next to the source; a silent no-op
  // here reads as a dead button.
  const resizeAndPost = useCallback(async (img: GenImage, w: number, h: number) => {
    try {
      const out = await resizeImageFile(img.path, w, h);
      if (activeSession) {
        appendMsg(activeSession.id, {
          id: genId(), role: 'agent', text: `Resized ${fileName(img.path)} → ${w}×${h}`,
          images: [{ id: genId(), path: out, prompt: img.prompt, w, h, status: 'done' }],
        });
      } else {
        setFsImages((prev) => [{ id: `fs-${out}`, path: out, prompt: fileName(out), w, h, status: 'done' as const }, ...prev]);
      }
      setImgVer((prev) => ({ ...prev, [out]: Date.now() }));
      setLightbox(null);
    } catch (e) {
      setError(`Resize failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [activeSession, appendMsg]);

  const toggleSelect = useCallback((path: string) => {
    setSelected((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
  }, []);

  // Images found on disk in the output folder (and the legacy in-project
  // folder) — keeps the history rail populated even if the localStorage
  // session cache is lost.
  const [fsImages, setFsImages] = useState<GenImage[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!projectRoot) { setFsImages([]); return; }
      const bases = [outputBase, legacyBase].filter((b): b is string => !!b);
      let dirs: FileEntry[] = [];
      for (const base of bases) {
        try { dirs = dirs.concat(await invoke<FileEntry[]>('read_directory', { path: base })); } catch { /* not created yet */ }
      }
      const out: GenImage[] = [];
      for (const d of dirs.filter((e) => e.is_dir).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 30)) {
        try {
          const files = await invoke<FileEntry[]>('read_directory', { path: d.path });
          for (const f of files) {
            if (!f.is_dir && /\.(png|jpe?g|webp)$/i.test(f.name)) {
              out.push({ id: `fs-${f.path}`, path: f.path, prompt: f.name, w: 1, h: 1, status: 'done' });
            }
          }
        } catch { /* unreadable session dir */ }
        if (cancelled) return;
      }
      if (!cancelled) setFsImages(out);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, outputBase]);

  // Copy the PNG binary to the system clipboard; fall back to the file path.
  const copyImage = useCallback(async (img: GenImage) => {
    try {
      const b64 = await invoke<string>('read_file_base64', { path: img.path });
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      if (activeSession) appendMsg(activeSession.id, { id: genId(), role: 'sys', text: `Copied ${fileName(img.path)} to clipboard` });
    } catch {
      try {
        await navigator.clipboard.writeText(img.path);
        if (activeSession) appendMsg(activeSession.id, { id: genId(), role: 'sys', text: `Copied file path to clipboard` });
      } catch (e) {
        setError(`Copy failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }, [activeSession, appendMsg]);

  // Delete the file from disk and drop it from every message and rail.
  const deleteImage = useCallback(async (img: GenImage) => {
    try {
      await invoke('delete_path', { path: img.path });
    } catch (e) {
      setError(`Delete failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    setSessions((prev) => prev.map((s) => ({
      ...s,
      messages: s.messages.map((m) => (
        m.images?.some((i) => i.path === img.path)
          ? { ...m, images: m.images.filter((i) => i.path !== img.path) }
          : m
      )),
    })));
    setFsImages((prev) => prev.filter((i) => i.path !== img.path));
    setSelected((prev) => prev.filter((p) => p !== img.path));
    setLightbox((cur) => (cur && cur.path === img.path ? null : cur));
    if (activeSession) appendMsg(activeSession.id, { id: genId(), role: 'sys', text: `Deleted ${fileName(img.path)}` });
  }, [activeSession, appendMsg]);

  const newSession = useCallback(() => {
    if (busy) return;
    setActiveSessionId(null);
    setSelected([]);
  }, [busy]);

  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeSessionId === id) { setActiveSessionId(null); setSelected([]); }
  }, [activeSessionId]);

  const imgSrc = useCallback((path: string) => {
    const v = imgVer[path];
    return v ? `${convertFileSrc(path)}?v=${v}` : convertFileSrc(path);
  }, [imgVer]);

  const editing = selected.length > 0;

  // Every finished image across all sessions, newest first — the persistent
  // history rail on the left. Disk-only images (no session metadata) follow.
  const allImages = useMemo(() => {
    const out: { img: GenImage; sessionId: string; sessionTitle: string }[] = [];
    for (const s of sessions) {
      for (let i = s.messages.length - 1; i >= 0; i--) {
        for (const img of s.messages[i].images || []) {
          if (img.status === 'done') out.push({ img, sessionId: s.id, sessionTitle: s.title });
        }
      }
    }
    const known = new Set(out.map((e) => e.img.path));
    for (const img of fsImages) {
      if (!known.has(img.path)) out.push({ img, sessionId: '', sessionTitle: 'On disk' });
    }
    return out;
  }, [sessions, fsImages]);

  const thumbBtnStyle: React.CSSProperties = {
    width: 24, height: 24, borderRadius: 7, border: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.55)', color: '#fff', cursor: 'pointer',
  };

  const renderThumb = (img: GenImage) => {
    const isSelected = selected.includes(img.path);
    return (
      <div key={img.id} style={{ position: 'relative', borderRadius: 10, overflow: 'hidden',
        border: `2px solid ${isSelected ? L.accent : L.border}`, background: L.canvas,
        aspectRatio: `${img.w} / ${img.h}`, cursor: img.status === 'done' ? 'pointer' : 'default' }}
        title={img.status === 'failed' ? (img.error || 'failed') : `${fileName(img.path)} — click to select for editing`}
        onClick={() => { if (img.status === 'done') toggleSelect(img.path); }}>
        {img.status === 'done' ? (
          <img src={imgSrc(img.path)} alt={img.prompt}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 6, color: img.status === 'failed' ? L.accentDeep : L.faint }}>
            {img.status === 'pending'
              ? <Loader2 size={18} className="spin" />
              : <X size={18} />}
            <span style={{ fontSize: 10 }}>{img.status === 'pending' ? `${img.w}×${img.h}` : 'failed'}</span>
          </div>
        )}
        {isSelected && (
          <span style={{ position: 'absolute', top: 6, left: 6, background: L.accent, color: '#fff',
            borderRadius: 999, fontSize: 9, fontWeight: 700, padding: '2px 7px', display: 'flex', alignItems: 'center', gap: 3 }}>
            <Check size={9} /> EDIT
          </span>
        )}
        {img.status === 'done' && (
          <div style={{ position: 'absolute', right: 5, bottom: 5, display: 'flex', gap: 4 }}
            onClick={(e) => e.stopPropagation()}>
            <button type="button" title="Preview & resize" onClick={() => { setLightbox(img); setLightboxCustom(`${img.w}x${img.h}`); }}
              style={thumbBtnStyle}><ZoomIn size={12} /></button>
            <button type="button" title="Copy image" onClick={() => void copyImage(img)}
              style={thumbBtnStyle}><Copy size={12} /></button>
            <button type="button" title="Reveal in folder" onClick={() => void invoke('reveal_in_explorer', { path: img.path }).catch(() => {})}
              style={thumbBtnStyle}><FolderOpen size={12} /></button>
            {onOpenFile && (
              <button type="button" title="Open in editor" onClick={() => onOpenFile(img.path)}
                style={thumbBtnStyle}><ExternalLink size={12} /></button>
            )}
          </div>
        )}
        {img.status === 'done' && (
          <button type="button" title="Delete image" onClick={(e) => { e.stopPropagation(); void deleteImage(img); }}
            style={{ ...thumbBtnStyle, position: 'absolute', right: 5, top: 5 }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#B81F35'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.55)'; }}>
            <Trash2 size={12} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, background: L.bg, color: L.ink, fontFamily: L.sans }}>
      {/* ── History rail: every generated image, always visible ── */}
      <div style={{ width: 148, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0,
        background: L.rail, borderRight: `1px solid ${L.border}` }}>
        <div style={{ padding: '13px 12px 9px', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <ImageIcon size={13} color={L.accent} />
          <span style={{ fontSize: 11.5, fontWeight: 700, color: L.soft, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>History</span>
          <span style={{ fontSize: 10.5, color: L.muted, whiteSpace: 'nowrap' }}>{allImages.length > 0 ? allImages.length : ''}</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '0 10px 10px',
          display: 'flex', flexDirection: 'column', gap: 8 }}>
          {allImages.length === 0 && (
            <div style={{ fontSize: 11, color: L.faint, textAlign: 'center', marginTop: 20, lineHeight: 1.7 }}>
              Generated images<br />stack up here
            </div>
          )}
          {allImages.map(({ img, sessionId, sessionTitle }) => (
            <button key={img.id} type="button" title={`${img.prompt}\n(${sessionTitle || 'Images'})`}
              onClick={() => {
                if (sessionId && sessionId !== activeSessionId) { setActiveSessionId(sessionId); setSelected([]); }
                setLightbox(img);
                setLightboxCustom(`${img.w}x${img.h}`);
              }}
              style={{ position: 'relative', padding: 0, borderRadius: 8, overflow: 'hidden', cursor: 'pointer',
                border: `1px solid ${sessionId === activeSessionId ? L.accentSoft : L.border}`, background: L.canvas,
                aspectRatio: `${img.w} / ${img.h}`, width: '100%', flexShrink: 0, display: 'block' }}>
              <img src={imgSrc(img.path)} alt={img.prompt} loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </button>
          ))}
        </div>
      </div>

      {/* ── Main column ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
      {/* ── Header ── */}
      <div style={{ padding: '13px 18px', display: 'flex', alignItems: 'center', gap: 9, borderBottom: `1px solid ${L.borderSoft}` }}>
        <BrandMark size={17} />
        <span style={{ fontFamily: L.serif, fontSize: 15.5, fontWeight: 600, letterSpacing: '-0.01em' }}>BBARIT Image</span>
        <span style={{ fontSize: 10.5, color: L.faint }}>Codex image studio</span>
        {outputBase && (
          <button type="button" title={`Open output folder\n${outputBase}`}
            onClick={() => void (async () => {
              await invoke('create_directory', { path: outputBase }).catch(() => {});
              await invoke('reveal_in_explorer', { path: outputBase }).catch(() => {});
            })()}
            style={{ display: 'flex', alignItems: 'center', gap: 4, border: 0, background: 'transparent',
              color: L.faint, fontSize: 10.5, cursor: 'pointer', padding: 2, minWidth: 0, maxWidth: 260 }}>
            <FolderOpen size={11} style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {outputBase.replace(/^.*\/Pictures\//, '~/Pictures/')}
            </span>
          </button>
        )}
        <button type="button" onClick={newSession} disabled={busy} title="New image session"
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 999,
            border: `1px solid ${L.border}`, background: L.card, color: L.soft, fontSize: 11.5, fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer' }}>
          <Plus size={12} /> New
        </button>
      </div>

      {/* ── Codex CLI missing warning ── */}
      {codexReady === false && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 18px',
          background: '#e0a80020', borderBottom: `1px solid ${L.borderSoft}`, color: L.soft, fontSize: 11.5 }}>
          <AlertTriangle size={14} color="#e0a800" style={{ flexShrink: 0 }} />
          <span style={{ lineHeight: 1.5 }}>
            <b>Codex CLI not found.</b> This studio generates images with the <code>codex</code> command.
            Install it with <code>npm i -g @openai/codex</code> and sign in with <code>codex login</code>.
          </span>
          <button type="button" onClick={() => void checkCodex()} title="Check again"
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 999,
              border: `1px solid ${L.border}`, background: L.card, color: L.soft, fontSize: 10.5, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
            <RefreshCw size={11} /> Retry
          </button>
        </div>
      )}

      {/* ── Chat feed ── */}
      <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 13, minHeight: 0 }}>
        {messages.length === 0 && (
          <div style={{ marginTop: 48, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <BrandMark size={26} />
            <div style={{ fontFamily: L.serif, fontSize: 17, color: L.soft }}>What should we picture?</div>
            <div style={{ fontSize: 12, color: L.muted, lineHeight: 1.7, maxWidth: 320 }}>
              Describe an image, pick how many and what size — Codex generates them in parallel.
              Click a result to select it, then type to edit the selected images in bulk.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', maxWidth: 420, marginTop: 4 }}>
              {['Watercolor ocean travel poster', 'Flat vector app icon, orange fox', 'Retro pixel-art game background', 'Minimal product hero photo, white studio'].map((p) => (
                <button key={p} type="button" onClick={() => setInput(p)}
                  style={{ padding: '6px 11px', borderRadius: 999, border: `1px solid ${L.border}`, background: L.card,
                    color: L.soft, fontSize: 11, cursor: 'pointer' }}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => {
          if (m.role === 'you') {
            return (
              <div key={m.id} style={{ alignSelf: 'flex-end', maxWidth: '78%', background: L.bubble, color: L.ink,
                borderRadius: 14, padding: '8px 13px', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                {m.text}
              </div>
            );
          }
          if (m.role === 'sys') {
            return <div key={m.id} style={{ fontSize: 10.5, color: L.faint, textAlign: 'center' }}>{m.text}</div>;
          }
          return (
            <div key={m.id} style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {m.text && <div style={{ fontSize: 12, color: L.muted }}>{m.text}</div>}
              {m.images && m.images.length > 0 && (
                <div style={{ display: 'grid', gap: 8,
                  gridTemplateColumns: `repeat(${Math.min(m.images.length, m.images.length <= 2 ? 2 : 4)}, minmax(120px, 240px))` }}>
                  {m.images.map(renderThumb)}
                </div>
              )}
            </div>
          );
        })}
        {busy && <Thinking L={L} label="Codex is drawing…" />}
      </div>

      {/* ── Composer ── */}
      <div style={{ padding: '10px 18px 14px' }}>
        {error && (
          <div style={{ fontSize: 11, color: L.accentDeep, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
            <X size={12} /> {error}
          </div>
        )}
        {editing && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 7 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: L.accentDeep }}>Editing {selected.length}:</span>
            {selected.map((p) => (
              <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 4, border: `1px solid ${L.accentSoft}`,
                background: L.accentSoft, borderRadius: 8, padding: '2px 7px', fontSize: 10.5, color: L.ink }}>
                <ImageIcon size={10} /> {fileName(p).slice(0, 24)}
                <button type="button" title="Deselect" onClick={() => toggleSelect(p)}
                  style={{ border: 0, background: 'transparent', color: L.muted, cursor: 'pointer', display: 'flex', padding: 0 }}>
                  <X size={10} />
                </button>
              </span>
            ))}
            <button type="button" onClick={() => setSelected([])}
              style={{ border: 0, background: 'transparent', color: L.faint, fontSize: 10.5, cursor: 'pointer' }}>
              clear
            </button>
          </div>
        )}
        <div
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) addAttachmentFiles(e.dataTransfer.files); }}
          style={{ background: L.card, border: `1px solid ${L.border}`, borderRadius: 16, boxShadow: '0 1px 3px rgba(0,0,0,.06)', padding: '10px 12px 8px' }}>
          {attachments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {attachments.map((a) => (
                <div key={a.id} title={a.name}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, border: `1px solid ${L.border}`, borderRadius: 8, padding: '3px 6px 3px 3px', background: L.bg }}>
                  <img src={a.preview} alt={a.name} style={{ width: 26, height: 26, objectFit: 'cover', borderRadius: 5, display: 'block' }} />
                  <span style={{ fontSize: 10.5, color: L.soft, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <button type="button" title="Remove"
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                    style={{ border: 0, background: 'transparent', color: L.faint, cursor: 'pointer', display: 'flex', padding: 0 }}>
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2}
            placeholder={editing ? 'Describe the change for the selected images…' : 'Describe the images to generate… (paste or drop reference images)'}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData?.items || [])
                .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
                .map((i) => i.getAsFile())
                .filter((f): f is File => !!f);
              if (imgs.length > 0) { e.preventDefault(); addAttachmentFiles(imgs); }
            }}
            style={{ width: '100%', border: 0, outline: 'none', resize: 'none', background: 'transparent',
              fontSize: 13, lineHeight: 1.5, fontFamily: L.sans, color: L.ink, boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 4, gap: 6, flexWrap: 'wrap' }}>
            <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files?.length) addAttachmentFiles(e.target.files); e.target.value = ''; }} />
            <button type="button" onClick={() => fileInputRef.current?.click()} title="Attach reference images"
              style={{ width: 26, height: 26, borderRadius: 999, border: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'transparent', color: attachments.length > 0 ? L.accent : L.faint, cursor: 'pointer' }}>
              <Paperclip size={14} />
            </button>
            {!editing && (
              <select value={presetKey} onChange={(e) => applyPreset(e.target.value)} title="Style preset"
                style={{ border: `1px solid ${L.border}`, borderRadius: 999, background: L.bg,
                  color: presetKey !== 'image' ? L.accentDeep : L.soft,
                  fontSize: 10.5, fontWeight: 600, padding: '3px 6px', outline: 'none', maxWidth: 118 }}>
                {IMAGE_STYLE_PRESETS.map((p) => <option key={p.key} value={p.key} title={p.desc}>{p.label}</option>)}
              </select>
            )}
            {!editing && (
              <select value={count} onChange={(e) => setCount(Number(e.target.value))} title="How many images"
                style={{ border: `1px solid ${L.border}`, borderRadius: 999, background: L.bg, color: L.soft,
                  fontSize: 10.5, fontWeight: 600, padding: '3px 6px', outline: 'none' }}>
                {COUNT_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} {IMAGE_STYLE_PRESETS.find((p) => p.key === presetKey)?.series ? 'sec' : 'img'}
                  </option>
                ))}
              </select>
            )}
            <select value={sizeKey} onChange={(e) => setSizeKey(e.target.value)} title="Image size"
              style={{ border: `1px solid ${L.border}`, borderRadius: 999, background: L.bg, color: L.soft,
                fontSize: 10.5, fontWeight: 600, padding: '3px 6px', outline: 'none', maxWidth: 160 }}>
              {IMAGE_SIZE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              <option value={CUSTOM_SIZE_KEY}>Custom…</option>
            </select>
            {sizeKey === CUSTOM_SIZE_KEY && (
              <input value={customSize} onChange={(e) => setCustomSize(e.target.value)} placeholder="1200x630"
                style={{ border: `1px solid ${parseCustomSize(customSize) ? L.border : L.accent}`, borderRadius: 999,
                  background: L.bg, color: L.ink, fontSize: 10.5, padding: '3px 8px', outline: 'none', width: 76 }} />
            )}
            <span style={{ fontSize: 10.5, color: L.faint }}>
              {editing ? 'One edit per selected image' : activeSession ? 'Continues this session' : 'Starts a new session'}
            </span>
            <button type="button" onClick={() => void send()} disabled={!input.trim() || busy} title="Send"
              style={{ marginLeft: 'auto', width: 28, height: 28, borderRadius: 999, border: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: !input.trim() || busy ? L.borderSoft : L.accent, color: !input.trim() || busy ? L.faint : '#fff',
                cursor: !input.trim() || busy ? 'not-allowed' : 'pointer' }}>
              {busy ? <Loader2 size={14} className="spin" /> : <ArrowUp size={15} />}
            </button>
          </div>
        </div>
      </div>

      {/* ── Recent sessions ── */}
      {sessions.length > 0 && (
        <div style={{ borderTop: `1px solid ${L.borderSoft}`, padding: '9px 14px', maxHeight: 110, overflowY: 'auto' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: L.faint, marginBottom: 6, letterSpacing: '0.05em' }}>Recent sessions</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {sessions.map((s) => (
              <span key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <button type="button" title={s.title}
                  onClick={() => { setActiveSessionId(s.id); setSelected([]); }}
                  style={{ maxWidth: 180, textAlign: 'left', padding: '4px 9px', borderRadius: 8, cursor: 'pointer', fontSize: 11,
                    border: 0, background: activeSessionId === s.id ? L.bubble : 'transparent',
                    color: activeSessionId === s.id ? L.ink : L.muted,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.title || 'Images'}
                </button>
                <button type="button" onClick={() => deleteSession(s.id)} title="Delete session"
                  style={{ border: 0, background: 'transparent', color: L.faint, cursor: 'pointer', display: 'flex', padding: 2 }}>
                  <Trash2 size={10} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      </div>

      {/* ── Lightbox: preview + local resize ──
          Rendered into document.body via portal, above every app layer
          (toolbar 12000, context menus 99999) — clicks on the menu row must
          never be shadowed by another stacking context. */}
      {lightbox && createPortal(
        <div onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000000, background: 'rgba(0,0,0,0.72)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 28 }}>
          <button type="button" onClick={() => setLightbox(null)}
            style={{ position: 'absolute', top: 16, left: 16, display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.25)',
              background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            ← Back to chat
          </button>
          <img src={imgSrc(lightbox.path)} alt={lightbox.prompt} onClick={(e) => e.stopPropagation()}
            onLoad={(e) => {
              // Disk-only history images carry no size metadata (1×1
              // placeholder) — read the real dimensions once decoded.
              const el = e.currentTarget;
              if ((lightbox.w <= 1 || lightbox.h <= 1) && el.naturalWidth > 1) {
                setLightbox((cur) => (cur && cur.path === lightbox.path ? { ...cur, w: el.naturalWidth, h: el.naturalHeight } : cur));
                setLightboxCustom(`${el.naturalWidth}x${el.naturalHeight}`);
              }
            }}
            style={{ maxWidth: '86vw', maxHeight: '66vh', borderRadius: 10, boxShadow: '0 8px 40px rgba(0,0,0,.5)' }} />
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: L.bg, border: `1px solid ${L.border}`, borderRadius: 14, padding: '10px 14px',
              display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '86vw' }}>
            <div style={{ fontSize: 11, color: L.muted, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 380 }}>{fileName(lightbox.path)}</span>
              <span style={{ color: L.faint }}>{lightbox.w}×{lightbox.h}</span>
              <button type="button" title="Copy image" onClick={() => void copyImage(lightbox)}
                style={{ border: 0, background: 'transparent', color: L.soft, cursor: 'pointer', display: 'flex', padding: 2 }}>
                <Copy size={13} />
              </button>
              <button type="button" title="Reveal in folder" onClick={() => void invoke('reveal_in_explorer', { path: lightbox.path }).catch(() => {})}
                style={{ border: 0, background: 'transparent', color: L.soft, cursor: 'pointer', display: 'flex', padding: 2 }}>
                <FolderOpen size={13} />
              </button>
              {onOpenFile && (
                <button type="button" title="Open in editor" onClick={() => { onOpenFile(lightbox.path); setLightbox(null); }}
                  style={{ border: 0, background: 'transparent', color: L.soft, cursor: 'pointer', display: 'flex', padding: 2 }}>
                  <ExternalLink size={13} />
                </button>
              )}
              <button type="button" title="Delete image" onClick={() => void deleteImage(lightbox)}
                style={{ border: 0, background: 'transparent', color: L.accentDeep, cursor: 'pointer', display: 'flex', padding: 2 }}>
                <Trash2 size={13} />
              </button>
              <button type="button" title="Close" onClick={() => setLightbox(null)}
                style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: L.soft, cursor: 'pointer', display: 'flex', padding: 2 }}>
                <X size={14} />
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Scaling size={12} style={{ color: L.faint }} />
              <span style={{ fontSize: 10.5, color: L.faint, fontWeight: 700 }}>Resize (no re-generation):</span>
              {IMAGE_SIZE_PRESETS.slice(0, 6).map((p) => (
                <button key={p.key} type="button" onClick={() => void resizeAndPost(lightbox, p.w, p.h)}
                  style={{ padding: '3px 8px', borderRadius: 999, border: `1px solid ${L.border}`, background: L.card,
                    color: L.soft, fontSize: 10.5, cursor: 'pointer' }}>
                  {p.w}×{p.h}
                </button>
              ))}
              <input value={lightboxCustom} onChange={(e) => setLightboxCustom(e.target.value)} placeholder="1200x630"
                style={{ border: `1px solid ${parseCustomSize(lightboxCustom) ? L.border : L.accent}`, borderRadius: 999,
                  background: L.bg, color: L.ink, fontSize: 10.5, padding: '3px 8px', outline: 'none', width: 76 }} />
              <button type="button" disabled={!parseCustomSize(lightboxCustom)}
                onClick={() => { const s = parseCustomSize(lightboxCustom); if (s) void resizeAndPost(lightbox, s.w, s.h); }}
                style={{ padding: '3px 10px', borderRadius: 999, border: 0, fontSize: 10.5, fontWeight: 700, cursor: 'pointer',
                  background: parseCustomSize(lightboxCustom) ? L.accent : L.borderSoft,
                  color: parseCustomSize(lightboxCustom) ? '#fff' : L.faint }}>
                Resize
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
