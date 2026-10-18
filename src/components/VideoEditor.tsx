/**
 * VideoEditor.tsx
 *
 * 타임라인 기반 영상 에디터 (Gausian native editor의 UX를 참고한 React 구현).
 * - 프리뷰 플레이어 + 단일 비디오 트랙 타임라인
 * - 클립 트림(양끝 핸들) / 분할(플레이헤드) / 삭제 / 드래그 순서변경 / 추가 임포트
 * - 내보내기: Rust `video_export_clips` (시스템 ffmpeg, D1/D2는 video_edit.rs 참조)
 *
 * 프리뷰는 <video> 한 개로 타임라인 시간 → (클립, 소스 오프셋) 매핑을 따라가며,
 * 클립 경계에서 소스를 갈아끼운다. 편집은 비파괴 — 원본 파일은 건드리지 않는다.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  Play, Pause, SkipBack, Scissors, Trash2, Plus, ZoomIn, ZoomOut, Clapperboard, X,
} from 'lucide-react';
import './VideoEditor.css';

interface TimelineClip {
  id: string;
  /** 파일시스템 절대 경로 (내보내기용) */
  path: string;
  /** asset 프로토콜 URL (프리뷰용) */
  url: string;
  name: string;
  srcDuration: number;
  in: number;
  out: number;
  width: number;
  height: number;
  thumb?: string;
}

interface ExportProgress {
  phase: 'clip' | 'concat' | 'done';
  index: number;
  total: number;
}

interface VideoEditorProps {
  filePath: string;
  videoUrl: string;
  fileName: string;
  style: { bg: string; text: string; accent: string };
}

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogv'];
const MIN_CLIP_SEC = 0.1;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const fmtTime = (t: number): string => {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${cs}`;
};

const probeVideo = (url: string): Promise<{ duration: number; width: number; height: number }> =>
  new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const duration = Number.isFinite(v.duration) ? v.duration : 0;
      resolve({ duration, width: v.videoWidth || 1280, height: v.videoHeight || 720 });
      v.removeAttribute('src');
      v.load();
    };
    v.onerror = () => reject(new Error('Could not read video metadata'));
    v.src = url;
  });

// asset 프로토콜이 cross-origin이면 canvas가 오염되어 toDataURL이 던진다 → 썸네일 없이 진행
const captureThumb = async (url: string, sec: number): Promise<string | undefined> => {
  try {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.muted = true;
    v.crossOrigin = 'anonymous';
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error('load failed'));
      v.src = url;
      setTimeout(() => rej(new Error('timeout')), 4000);
    });
    v.currentTime = clamp(sec, 0, Math.max(0, (v.duration || 1) - 0.05));
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      setTimeout(res, 1500);
    });
    const w = 160;
    const h = Math.max(2, Math.round(w * ((v.videoHeight || 9) / (v.videoWidth || 16))));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(v, 0, 0, w, h);
    const data = c.toDataURL('image/jpeg', 0.6);
    v.removeAttribute('src');
    v.load();
    return data;
  } catch {
    return undefined;
  }
};

let clipSeq = 0;
const nextClipId = () => `clip-${Date.now()}-${clipSeq++}`;

const pickRulerStep = (pxPerSec: number): number => {
  for (const s of [0.5, 1, 2, 5, 10, 30, 60, 120, 300]) {
    if (s * pxPerSec >= 70) return s;
  }
  return 600;
};

const VideoEditor: React.FC<VideoEditorProps> = ({ filePath, videoUrl, fileName, style }) => {
  const [clips, setClips] = useState<TimelineClip[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [total, setTotal] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [pxPerSec, setPxPerSec] = useState(60);
  const [exporting, setExporting] = useState<ExportProgress | null>(null);
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ffmpegMissing, setFfmpegMissing] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const clipsRef = useRef<TimelineClip[]>([]);
  const startsRef = useRef<number[]>([]);
  const totalRef = useRef(0);
  const activeIdxRef = useRef(0);
  const loadedUrlRef = useRef<string | null>(null);
  const pxPerSecRef = useRef(60);
  const dragIndexRef = useRef<number | null>(null);

  pxPerSecRef.current = pxPerSec;

  // clips 파생값(시작 오프셋, 총 길이)을 refs와 state에 동기화
  useEffect(() => {
    clipsRef.current = clips;
    const starts: number[] = [];
    let acc = 0;
    for (const c of clips) {
      starts.push(acc);
      const d = c.out - c.in;
      acc += Number.isFinite(d) && d > 0 ? d : 0;
    }
    startsRef.current = starts;
    totalRef.current = acc;
    setTotal(acc);
    setCurrentTime((t) => clamp(t, 0, acc));
    if (activeIdxRef.current >= clips.length) {
      activeIdxRef.current = Math.max(0, clips.length - 1);
      setActiveIdx(activeIdxRef.current);
    }
  }, [clips]);

  const locate = useCallback((t: number): { idx: number; offset: number } => {
    const cl = clipsRef.current;
    const starts = startsRef.current;
    if (!cl.length) return { idx: 0, offset: 0 };
    const tt = clamp(t, 0, totalRef.current);
    for (let i = 0; i < cl.length; i++) {
      const dur = cl[i].out - cl[i].in;
      if (tt < starts[i] + dur - 1e-6) return { idx: i, offset: tt - starts[i] };
    }
    const last = cl.length - 1;
    return { idx: last, offset: cl[last].out - cl[last].in };
  }, []);

  const applySeek = useCallback((t: number, andPlay: boolean) => {
    const cl = clipsRef.current;
    if (!cl.length) return;
    const { idx, offset } = locate(t);
    const clip = cl[idx];
    activeIdxRef.current = idx;
    setActiveIdx(idx);
    setCurrentTime(clamp(t, 0, totalRef.current));
    const v = videoRef.current;
    if (!v) return;
    const target = clip.in + clamp(offset, 0, clip.out - clip.in);
    if (loadedUrlRef.current !== clip.url) {
      loadedUrlRef.current = clip.url;
      const onLoaded = () => {
        v.removeEventListener('loadeddata', onLoaded);
        try { v.currentTime = target; } catch { /* not seekable yet */ }
        if (andPlay) void v.play().catch(() => {});
      };
      v.addEventListener('loadeddata', onLoaded);
      v.src = clip.url;
      v.load();
    } else {
      try { v.currentTime = target; } catch { /* ignore */ }
      if (andPlay) void v.play().catch(() => {});
    }
  }, [locate]);

  // 최초 클립 로드 (열린 파일)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meta = await probeVideo(videoUrl);
        if (cancelled) return;
        if (!(meta.duration > 0)) throw new Error('Unknown video duration');
        const clip: TimelineClip = {
          id: nextClipId(),
          path: filePath,
          url: videoUrl,
          name: fileName,
          srcDuration: meta.duration,
          in: 0,
          out: meta.duration,
          width: meta.width,
          height: meta.height,
        };
        setClips([clip]);
        setSelectedId(clip.id);
        void captureThumb(videoUrl, 0.1).then((thumb) => {
          if (!cancelled && thumb) {
            setClips((prev) => prev.map((c) => (c.id === clip.id ? { ...c, thumb } : c)));
          }
        });
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
    // 파일 탭당 한 번 로드
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, videoUrl]);

  // 첫 클립이 준비되면 첫 프레임을 프리뷰에 로드한다 (재생 전 검정 화면 방지)
  useEffect(() => {
    if (clips.length && loadedUrlRef.current === null) applySeek(0, false);
  }, [clips, applySeek]);

  // 재생 루프: 타임라인 시간 갱신 + 클립 경계에서 다음 소스로 전환
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      const cl = clipsRef.current;
      const idx = activeIdxRef.current;
      const clip = cl[idx];
      if (v && clip) {
        if (!v.seeking) {
          if (v.currentTime >= clip.out - 0.03 || v.ended) {
            if (idx + 1 < cl.length) {
              applySeek(startsRef.current[idx + 1], true);
            } else {
              v.pause();
              setCurrentTime(totalRef.current);
              setPlaying(false);
              return;
            }
          } else {
            setCurrentTime(startsRef.current[idx] + Math.max(0, v.currentTime - clip.in));
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, applySeek]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || !clipsRef.current.length) return;
    if (playing) {
      v.pause();
      setPlaying(false);
    } else {
      const t = currentTime >= totalRef.current - 0.05 ? 0 : currentTime;
      setPlaying(true);
      applySeek(t, true);
    }
  }, [playing, currentTime, applySeek]);

  const stopAndSeek = useCallback((t: number) => {
    videoRef.current?.pause();
    setPlaying(false);
    applySeek(t, false);
  }, [applySeek]);

  // ── 편집 조작 ──────────────────────────────────────────────

  const splitAtPlayhead = useCallback(() => {
    const { idx, offset } = locate(currentTime);
    const clip = clipsRef.current[idx];
    if (!clip) return;
    const dur = clip.out - clip.in;
    if (offset < MIN_CLIP_SEC || dur - offset < MIN_CLIP_SEC) return;
    const cut = clip.in + offset;
    const left: TimelineClip = { ...clip, id: nextClipId(), out: cut };
    const right: TimelineClip = { ...clip, id: nextClipId(), in: cut, thumb: undefined };
    setClips((prev) => prev.flatMap((c) => (c.id === clip.id ? [left, right] : [c])));
    setSelectedId(right.id);
    void captureThumb(clip.url, cut).then((thumb) => {
      if (thumb) setClips((prev) => prev.map((c) => (c.id === right.id ? { ...c, thumb } : c)));
    });
  }, [currentTime, locate]);

  const deleteSelected = useCallback(() => {
    if (!selectedId || clipsRef.current.length <= 1) return;
    videoRef.current?.pause();
    setPlaying(false);
    setClips((prev) => prev.filter((c) => c.id !== selectedId));
    setSelectedId(null);
  }, [selectedId]);

  const addClips = useCallback(async () => {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    for (const p of paths) {
      const path = typeof p === 'string' ? p : String(p);
      try {
        const url = convertFileSrc(path);
        const meta = await probeVideo(url);
        if (!(meta.duration > 0)) continue;
        const name = path.replace(/\\/g, '/').split('/').pop() || path;
        const clip: TimelineClip = {
          id: nextClipId(),
          path,
          url,
          name,
          srcDuration: meta.duration,
          in: 0,
          out: meta.duration,
          width: meta.width,
          height: meta.height,
        };
        setClips((prev) => [...prev, clip]);
        void captureThumb(url, 0.1).then((thumb) => {
          if (thumb) setClips((prev) => prev.map((c) => (c.id === clip.id ? { ...c, thumb } : c)));
        });
      } catch (e) {
        console.error('[VideoEditor] failed to add clip:', path, e);
      }
    }
  }, []);

  const startTrim = useCallback((e: React.PointerEvent, clipId: string, side: 'l' | 'r') => {
    e.stopPropagation();
    e.preventDefault();
    const orig = clipsRef.current.find((c) => c.id === clipId);
    if (!orig) return;
    videoRef.current?.pause();
    setPlaying(false);
    setSelectedId(clipId);
    const startX = e.clientX;
    const origIn = orig.in;
    const origOut = orig.out;
    const onMove = (ev: PointerEvent) => {
      const d = (ev.clientX - startX) / pxPerSecRef.current;
      setClips((prev) => prev.map((c) => {
        if (c.id !== clipId) return c;
        if (side === 'l') return { ...c, in: clamp(origIn + d, 0, origOut - MIN_CLIP_SEC) };
        return { ...c, out: clamp(origOut + d, origIn + MIN_CLIP_SEC, c.srcDuration) };
      }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const onScrubDown = useCallback((e: React.PointerEvent) => {
    const inner = timelineRef.current;
    if (!inner) return;
    videoRef.current?.pause();
    setPlaying(false);
    const seekFromEvent = (clientX: number) => {
      const rect = inner.getBoundingClientRect();
      applySeek((clientX - rect.left) / pxPerSecRef.current, false);
    };
    seekFromEvent(e.clientX);
    const onMove = (ev: PointerEvent) => seekFromEvent(ev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [applySeek]);

  const reorderClip = useCallback((from: number, to: number) => {
    if (from === to) return;
    setClips((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  // ── 내보내기 ──────────────────────────────────────────────

  const onExport = useCallback(async () => {
    if (exporting || !clipsRef.current.length) return;
    setExportMsg(null);
    try {
      await invoke('video_ffmpeg_check');
    } catch {
      setFfmpegMissing(true);
      return;
    }
    const base = fileName.replace(/\.[^.]+$/, '');
    const out = await saveDialog({
      defaultPath: `${base}-edit.mp4`,
      filters: [{ name: 'MP4', extensions: ['mp4'] }],
    });
    if (!out) return;
    const first = clipsRef.current[0];
    setExporting({ phase: 'clip', index: 0, total: clipsRef.current.length });
    const unlisten = await listen<ExportProgress>('video-export-progress', (ev) => {
      setExporting(ev.payload);
    });
    try {
      const saved = await invoke<string>('video_export_clips', {
        clips: clipsRef.current.map((c) => ({ path: c.path, inSec: c.in, outSec: c.out })),
        outputPath: out,
        width: first.width || 1280,
        height: first.height || 720,
        fps: 30,
      });
      setExportMsg({ ok: true, text: `Exported: ${saved}` });
    } catch (e) {
      setExportMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      unlisten();
      setExporting(null);
    }
  }, [exporting, fileName]);

  // ── 키보드 단축키 ─────────────────────────────────────────

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      splitAtPlayhead();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelected();
    }
  }, [togglePlay, splitAtPlayhead, deleteSelected]);

  // ── 렌더링 ────────────────────────────────────────────────

  const rulerStep = pickRulerStep(pxPerSec);
  const rulerTicks = useMemo(() => {
    const ticks: number[] = [];
    if (!Number.isFinite(total) || rulerStep <= 0) return ticks;
    for (let t = 0; t <= total + rulerStep && ticks.length < 2000; t += rulerStep) ticks.push(t);
    return ticks;
  }, [total, rulerStep]);

  const timelineWidth = Math.max(total * pxPerSec + 160, 400);
  const starts = startsRef.current;
  const exportPercent = exporting
    ? exporting.phase === 'done'
      ? 100
      : Math.round(((exporting.index + (exporting.phase === 'concat' ? 1 : 0)) / (exporting.total + 1)) * 100)
    : 0;

  if (loadError) {
    return (
      <div className="video-editor" style={{ background: style.bg, color: style.text }}>
        <div className="ve-error">Failed to open video: {loadError}</div>
      </div>
    );
  }

  return (
    <div
      className="video-editor"
      style={{ background: style.bg, color: style.text }}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {/* 프리뷰 */}
      <div className="ve-preview">
        <video ref={videoRef} playsInline onClick={togglePlay} />
        {!clips.length && <div className="ve-loading">Loading video…</div>}
      </div>

      {/* 툴바 */}
      <div className="ve-toolbar">
        <button className="ve-btn" title="Go to start" onClick={() => stopAndSeek(0)}>
          <SkipBack size={15} />
        </button>
        <button className="ve-btn ve-btn-play" title="Play/Pause (Space)" onClick={togglePlay}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span className="ve-time">
          {fmtTime(currentTime)} <span className="ve-time-total">/ {fmtTime(total)}</span>
        </span>
        <div className="ve-toolbar-sep" />
        <button className="ve-btn" title="Split at playhead (S)" onClick={splitAtPlayhead}>
          <Scissors size={15} />
          <span>Split</span>
        </button>
        <button
          className="ve-btn"
          title="Delete selected clip (Delete)"
          onClick={deleteSelected}
          disabled={!selectedId || clips.length <= 1}
        >
          <Trash2 size={15} />
          <span>Delete</span>
        </button>
        <button className="ve-btn" title="Add clips" onClick={() => void addClips()}>
          <Plus size={15} />
          <span>Add Clip</span>
        </button>
        <div className="ve-toolbar-sep" />
        <button className="ve-btn" title="Zoom out" onClick={() => setPxPerSec((z) => clamp(z / 1.5, 4, 400))}>
          <ZoomOut size={15} />
        </button>
        <button className="ve-btn" title="Zoom in" onClick={() => setPxPerSec((z) => clamp(z * 1.5, 4, 400))}>
          <ZoomIn size={15} />
        </button>
        <div className="ve-toolbar-spacer" />
        <button
          className="ve-btn ve-btn-export"
          style={{ background: style.accent }}
          onClick={() => void onExport()}
          disabled={!!exporting || !clips.length}
        >
          <Clapperboard size={15} />
          <span>{exporting ? 'Exporting…' : 'Export MP4'}</span>
        </button>
      </div>

      {/* 내보내기 진행/결과 */}
      {exporting && (
        <div className="ve-export-bar">
          <div className="ve-export-fill" style={{ width: `${exportPercent}%`, background: style.accent }} />
          <span className="ve-export-label">
            {exporting.phase === 'concat'
              ? 'Merging clips…'
              : `Encoding clip ${Math.min(exporting.index + 1, exporting.total)}/${exporting.total}`}
          </span>
        </div>
      )}
      {exportMsg && (
        <div className={`ve-export-msg ${exportMsg.ok ? 'ok' : 'err'}`}>
          <span>{exportMsg.text}</span>
          <button className="ve-btn ve-btn-icon" onClick={() => setExportMsg(null)}><X size={13} /></button>
        </div>
      )}

      {/* 타임라인 */}
      <div className="ve-timeline-scroll">
        <div
          className="ve-timeline"
          ref={timelineRef}
          style={{ width: timelineWidth }}
          onPointerDown={onScrubDown}
        >
          {/* 눈금자 */}
          <div className="ve-ruler">
            {rulerTicks.map((t) => (
              <div key={t} className="ve-ruler-tick" style={{ left: t * pxPerSec }}>
                <span>{fmtTime(t)}</span>
              </div>
            ))}
          </div>

          {/* 비디오 트랙 */}
          <div className="ve-track">
            {clips.map((c, i) => {
              const w = (c.out - c.in) * pxPerSec;
              return (
                <div
                  key={c.id}
                  className={`ve-clip${selectedId === c.id ? ' selected' : ''}${i === activeIdx ? ' active' : ''}`}
                  style={{
                    left: (starts[i] ?? 0) * pxPerSec,
                    width: Math.max(w, 8),
                    borderColor: selectedId === c.id ? style.accent : undefined,
                    backgroundImage: c.thumb ? `url(${c.thumb})` : undefined,
                  }}
                  draggable
                  onDragStart={() => { dragIndexRef.current = i; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIndexRef.current != null) reorderClip(dragIndexRef.current, i);
                    dragIndexRef.current = null;
                  }}
                  onPointerDown={(e) => { e.stopPropagation(); setSelectedId(c.id); }}
                >
                  <div className="ve-clip-label">
                    <span className="ve-clip-name">{c.name}</span>
                    <span className="ve-clip-dur">{fmtTime(c.out - c.in)}</span>
                  </div>
                  <div className="ve-clip-handle l" onPointerDown={(e) => startTrim(e, c.id, 'l')} />
                  <div className="ve-clip-handle r" onPointerDown={(e) => startTrim(e, c.id, 'r')} />
                </div>
              );
            })}
          </div>

          {/* 플레이헤드 */}
          <div className="ve-playhead" style={{ left: currentTime * pxPerSec }}>
            <div className="ve-playhead-cap" style={{ background: style.accent }} />
            <div className="ve-playhead-line" style={{ background: style.accent }} />
          </div>
        </div>
      </div>

      {/* ffmpeg 미설치 안내 */}
      {ffmpegMissing && (
        <div className="ve-modal-backdrop" onClick={() => setFfmpegMissing(false)}>
          <div className="ve-modal" onClick={(e) => e.stopPropagation()}>
            <h3>ffmpeg is required</h3>
            <p>Video export uses the ffmpeg installed on your system. Install it with the command below, then try again.</p>
            <pre>Windows:  winget install Gyan.FFmpeg{'\n'}macOS:    brew install ffmpeg</pre>
            <p className="ve-modal-hint">You may need to restart the app for PATH changes to apply. (Custom path: BBARIT_FFMPEG env var)</p>
            <div className="ve-modal-actions">
              <button className="ve-btn" onClick={() => setFfmpegMissing(false)}>Close</button>
              <button
                className="ve-btn ve-btn-export"
                style={{ background: style.accent }}
                onClick={() => { setFfmpegMissing(false); void onExport(); }}
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VideoEditor;
