import { useCallback, useEffect, useRef, useState } from 'react';
import type { EasterEggMedia } from '../config/schema';
import { invoke } from '@tauri-apps/api/core';
import { useConfig } from '../config/ConfigContext';

interface OctoDanceProps {
  active: boolean;
  onEnd: () => void;
}

const DURATION = 25000;

// The party used to take over the whole screen — an accidental click on the
// status-bar logo button hijacked the terminal for 25s. It now lives in a
// small floating widget above the status bar instead (still click-to-close).
const BOX_W = 320;
const BOX_H = 200;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/* ── Types ── */
interface Bubble {
  x: number;
  y: number;
  r: number;
  speed: number;
  wobble: number;
  phase: number;
  opacity: number;
}

interface Fish {
  x: number;
  y: number;
  size: number;
  speed: number;
  color: string;
  phase: number;
  dir: number;
  depth: number;
}

interface Kelp {
  x: number;
  height: number;
  segments: number;
  phase: number;
  color: string;
}

interface LightRay {
  x: number;
  width: number;
  opacity: number;
  speed: number;
}

/* ── Draw helpers ── */
function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, time: number, img: HTMLImageElement | null) {
  const s = size;
  ctx.save();
  ctx.translate(x, y);

  // Gentle sway + bob
  const sway = Math.sin(time * 0.8) * 0.06;
  const bob = Math.sin(time * 0.6) * s * 0.04;
  ctx.rotate(sway);
  ctx.translate(0, bob);

  // Soft drop shadow under logo
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(0, s * 0.55, s * 0.45, s * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();

  // Glow behind logo
  ctx.shadowColor = 'rgba(122, 162, 247, 0.55)';
  ctx.shadowBlur = 24;

  if (img && img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, -s * 0.5, -s * 0.5, s, s);
  } else {
    // Fallback while image loads — simple disc with brand tint
    const g = ctx.createRadialGradient(0, 0, s * 0.05, 0, 0, s * 0.5);
    g.addColorStop(0, '#7aa2f7');
    g.addColorStop(1, '#3b4a7a');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawBubble(ctx: CanvasRenderingContext2D, b: Bubble) {
  ctx.save();
  ctx.globalAlpha = b.opacity;
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
  ctx.stroke();

  // Highlight
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.beginPath();
  ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFish(ctx: CanvasRenderingContext2D, f: Fish, time: number) {
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.scale(f.dir, 1);
  ctx.globalAlpha = 0.3 + f.depth * 0.5;

  const s = f.size;
  const tailWag = Math.sin(time * 4 + f.phase) * 0.3;

  // Body
  ctx.fillStyle = f.color;
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.5, s * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();

  // Tail
  ctx.save();
  ctx.translate(-s * 0.45, 0);
  ctx.rotate(tailWag);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-s * 0.3, -s * 0.18);
  ctx.lineTo(-s * 0.3, s * 0.18);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Eye
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(s * 0.22, -s * 0.02, s * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1a2e';
  ctx.beginPath();
  ctx.arc(s * 0.24, -s * 0.02, s * 0.03, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawKelp(ctx: CanvasRenderingContext2D, kelp: Kelp, time: number, h: number) {
  ctx.save();
  ctx.strokeStyle = kelp.color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';

  const segH = kelp.height / kelp.segments;
  let px = kelp.x;
  let py = h;

  ctx.beginPath();
  ctx.moveTo(px, py);
  for (let i = 1; i <= kelp.segments; i++) {
    const sway = Math.sin(time * 0.8 + kelp.phase + i * 0.4) * (3 + i);
    px = kelp.x + sway;
    py = h - i * segH;
    ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Leaves
  ctx.fillStyle = kelp.color;
  for (let i = 2; i < kelp.segments; i += 2) {
    const sway = Math.sin(time * 0.8 + kelp.phase + i * 0.4) * (3 + i);
    const lx = kelp.x + sway;
    const ly = h - i * segH;
    const dir = i % 4 === 0 ? 1 : -1;
    ctx.beginPath();
    ctx.ellipse(lx + dir * 5, ly, 6, 2.5, dir * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawLightRay(ctx: CanvasRenderingContext2D, ray: LightRay, h: number) {
  ctx.save();
  ctx.globalAlpha = ray.opacity;
  const grad = ctx.createLinearGradient(ray.x, 0, ray.x, h * 0.7);
  grad.addColorStop(0, 'rgba(180,220,255,0.12)');
  grad.addColorStop(0.5, 'rgba(180,220,255,0.04)');
  grad.addColorStop(1, 'rgba(180,220,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(ray.x - ray.width * 0.3, 0);
  ctx.lineTo(ray.x + ray.width * 0.3, 0);
  ctx.lineTo(ray.x + ray.width * 0.8, h * 0.7);
  ctx.lineTo(ray.x - ray.width * 0.8, h * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* ── Starfish on the seafloor ── */
function drawStarfish(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, rot: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const outer = (i * Math.PI * 2) / 5 - Math.PI / 2;
    const inner = outer + Math.PI / 5;
    if (i === 0) ctx.moveTo(Math.cos(outer) * size, Math.sin(outer) * size);
    else ctx.lineTo(Math.cos(outer) * size, Math.sin(outer) * size);
    ctx.lineTo(Math.cos(inner) * size * 0.4, Math.sin(inner) * size * 0.4);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* ── Sand particles on ocean floor ── */
function drawSeafloor(ctx: CanvasRenderingContext2D, w: number, h: number, time: number) {
  const floorY = h * 0.88;

  // Sand gradient
  const sandGrad = ctx.createLinearGradient(0, floorY, 0, h);
  sandGrad.addColorStop(0, '#3a5a6a');
  sandGrad.addColorStop(0.3, '#2e4a58');
  sandGrad.addColorStop(1, '#1e3040');
  ctx.fillStyle = sandGrad;

  // Wavy sand surface
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 20) {
    const y = floorY + Math.sin(x * 0.015 + time * 0.3) * 6 + Math.sin(x * 0.008) * 10;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();

  // Small rocks/pebbles
  ctx.fillStyle = 'rgba(60,80,90,0.5)';
  for (let i = 0; i < 12; i++) {
    const rx = (i * w / 12) + Math.sin(i * 3.7) * 30;
    const ry = floorY + 8 + Math.sin(i * 2.1) * 4;
    ctx.beginPath();
    ctx.ellipse(rx, ry, 4 + Math.sin(i) * 2, 2 + Math.cos(i) * 1, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function OctoDance({ active, onEnd }: OctoDanceProps) {
  const { config, patchConfig } = useConfig();
  const media: EasterEggMedia = config.easterEggMedia ?? { type: 'default', path: '' };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const startRef = useRef(0);
  const bubblesRef = useRef<Bubble[]>([]);
  const fishRef = useRef<Fish[]>([]);
  const kelpRef = useRef<Kelp[]>([]);
  const raysRef = useRef<LightRay[]>([]);
  const starfishRef = useRef<{ x: number; y: number; size: number; color: string; rot: number }[]>([]);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Octopus position state
  const octoRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0, nextMove: 0 });
  const logoImgRef = useRef<HTMLImageElement | null>(null);

  // Preload BBARIT logo for canvas drawing
  useEffect(() => {
    const img = new Image();
    img.src = '/icons/bbarit-logo.png';
    img.onload = () => { logoImgRef.current = img; };
  }, []);

  // Load media file as data URL
  useEffect(() => {
    if (!active || !media || media.type === 'default' || !media.path) {
      setMediaUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const base64: string = await invoke('read_file_base64', { path: media.path });
        if (cancelled) return;
        const ext = media.path.split('.').pop()?.toLowerCase() || '';
        const mimeMap: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
          mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
        };
        const mime = mimeMap[ext] || (media.type === 'video' ? 'video/mp4' : 'image/png');
        setMediaUrl(`data:${mime};base64,${base64}`);
      } catch {
        setMediaUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, [active, media]);

  const handlePickFile = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        filters: [
          { name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mov', 'm4v'] },
        ],
      });
      if (!selected) return;
      const path = typeof selected === 'string' ? selected : (selected as any).path ?? String(selected);
      if (!path) return;
      const ext = path.split('.').pop()?.toLowerCase() || '';
      const videoExts = ['mp4', 'webm', 'mov', 'm4v'];
      const type = videoExts.includes(ext) ? 'video' as const : 'image' as const;
      patchConfig({ easterEggMedia: { type, path } });
    } catch { /* dialog cancelled or unavailable */ }
  };

  const handleReset = (e: React.MouseEvent) => {
    e.stopPropagation();
    patchConfig({ easterEggMedia: { type: 'default', path: '' } });
    setMediaUrl(null);
  };

  const FISH_COLORS = ['#7ab8d4', '#e8c470', '#d4a0c8', '#88c8a0', '#d4887a', '#a0b8e8'];
  const KELP_COLORS = ['#2a6848', '#1e5a3a', '#348058', '#286040', '#1a4830'];
  const STARFISH_COLORS = ['#d4887a', '#e8a070', '#c87888', '#d4a0a0', '#e8b890'];

  const seedScene = useCallback((w: number, h: number) => {
    // Element sizes/counts are tuned for the small widget box (BOX_W×BOX_H),
    // proportional to h where it matters so the scene still reads as an ocean.
    bubblesRef.current = Array.from({ length: 16 }, () => ({
      x: Math.random() * w,
      y: h + Math.random() * h,
      r: rand(1.5, 5),
      speed: rand(0.3, 1.2),
      wobble: rand(0.5, 2),
      phase: rand(0, Math.PI * 2),
      opacity: rand(0.2, 0.6),
    }));

    fishRef.current = Array.from({ length: 6 }, () => ({
      x: Math.random() * w,
      y: rand(h * 0.2, h * 0.75),
      size: rand(8, 16),
      speed: rand(0.3, 1.0),
      color: FISH_COLORS[Math.floor(Math.random() * FISH_COLORS.length)],
      phase: rand(0, Math.PI * 2),
      dir: Math.random() > 0.5 ? 1 : -1,
      depth: rand(0.3, 1),
    }));

    kelpRef.current = Array.from({ length: 8 }, (_, i) => ({
      x: (w / 8) * i + rand(-10, 10),
      height: rand(h * 0.2, h * 0.45),
      segments: Math.floor(rand(5, 9)),
      phase: rand(0, Math.PI * 2),
      color: KELP_COLORS[Math.floor(Math.random() * KELP_COLORS.length)],
    }));

    raysRef.current = Array.from({ length: 4 }, () => ({
      x: Math.random() * w,
      width: rand(20, 60),
      opacity: rand(0.3, 0.7),
      speed: rand(0.1, 0.3),
    }));

    starfishRef.current = Array.from({ length: 3 }, () => ({
      x: rand(w * 0.1, w * 0.9),
      y: h * 0.89 + rand(0, 8),
      size: rand(5, 9),
      color: STARFISH_COLORS[Math.floor(Math.random() * STARFISH_COLORS.length)],
      rot: rand(0, Math.PI * 2),
    }));

    octoRef.current = {
      x: w * 0.5,
      y: h * 0.45,
      targetX: w * 0.5,
      targetY: h * 0.45,
      nextMove: 3,
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = BOX_W * window.devicePixelRatio;
      canvas.height = BOX_H * window.devicePixelRatio;
      canvas.style.width = `${BOX_W}px`;
      canvas.style.height = `${BOX_H}px`;
      ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    };

    resize();
    seedScene(BOX_W, BOX_H);
    startRef.current = performance.now();

    // No sound

    const animate = (now: number) => {
      const w = BOX_W;
      const h = BOX_H;
      const t = (now - startRef.current) / 1000;
      const progress = Math.min((now - startRef.current) / DURATION, 1);
      const octo = octoRef.current;

      // Ocean background gradient
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#0a2a4a');
      bg.addColorStop(0.3, '#0e3458');
      bg.addColorStop(0.6, '#0c2c48');
      bg.addColorStop(0.85, '#1a3a50');
      bg.addColorStop(1, '#1e3040');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Subtle water caustics
      ctx.save();
      ctx.globalAlpha = 0.03;
      for (let i = 0; i < 6; i++) {
        const cx = w * (0.15 + i * 0.14) + Math.sin(t * 0.4 + i * 1.2) * 40;
        const cy = h * 0.3 + Math.cos(t * 0.3 + i * 0.8) * 30;
        const r = 60 + Math.sin(t * 0.5 + i) * 20;
        const cGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        cGrad.addColorStop(0, 'rgba(120,200,255,1)');
        cGrad.addColorStop(1, 'rgba(120,200,255,0)');
        ctx.fillStyle = cGrad;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
      ctx.restore();

      // Light rays from surface
      for (const ray of raysRef.current) {
        ray.x += Math.sin(t * ray.speed) * 0.3;
        ray.opacity = 0.3 + Math.sin(t * 0.5 + ray.x * 0.01) * 0.15;
        drawLightRay(ctx, ray, h);
      }

      // Seafloor
      drawSeafloor(ctx, w, h, t);

      // Kelp
      for (const k of kelpRef.current) {
        drawKelp(ctx, k, t, h * 0.88);
      }

      // Starfish
      for (const sf of starfishRef.current) {
        drawStarfish(ctx, sf.x, sf.y, sf.size, sf.color, sf.rot);
      }

      // Fish
      for (const f of fishRef.current) {
        f.x += f.speed * f.dir;
        f.y += Math.sin(t * 0.8 + f.phase) * 0.3;
        if (f.x > w + 40) { f.x = -40; f.dir = 1; }
        if (f.x < -40) { f.x = w + 40; f.dir = -1; }
        drawFish(ctx, f, t);
      }

      // Update octopus position - gentle wandering
      if (t > octo.nextMove) {
        octo.targetX = rand(w * 0.15, w * 0.85);
        octo.targetY = rand(h * 0.2, h * 0.65);
        octo.nextMove = t + rand(3, 6);
      }
      octo.x += (octo.targetX - octo.x) * 0.008;
      octo.y += (octo.targetY - octo.y) * 0.008;

      // Draw BBARIT logo (scaled to the widget, not the screen)
      drawLogo(ctx, octo.x, octo.y, 64 + Math.sin(t * 0.5) * 4, t, logoImgRef.current);

      // Octopus trail bubbles
      if (Math.random() < 0.06) {
        bubblesRef.current.push({
          x: octo.x + rand(-15, 15),
          y: octo.y + rand(-5, 10),
          r: rand(2, 5),
          speed: rand(0.4, 0.9),
          wobble: rand(0.5, 1.5),
          phase: rand(0, Math.PI * 2),
          opacity: rand(0.3, 0.5),
        });
      }

      // Bubbles
      const nextBubbles: Bubble[] = [];
      for (const b of bubblesRef.current) {
        b.y -= b.speed;
        b.x += Math.sin(t * b.wobble + b.phase) * 0.4;
        if (b.y + b.r < -10) {
          b.y = h + 10;
          b.x = Math.random() * w;
        }
        drawBubble(ctx, b);
        if (b.y > -20) nextBubbles.push(b);
      }
      bubblesRef.current = nextBubbles;

      // Floating particles (plankton)
      ctx.save();
      ctx.fillStyle = 'rgba(180,220,240,0.15)';
      for (let i = 0; i < 20; i++) {
        const px = (i * w / 20 + t * 8 + Math.sin(i * 2.3) * 40) % w;
        const py = (i * h / 20 + Math.sin(t * 0.3 + i) * 20) % h;
        ctx.beginPath();
        ctx.arc(px, py, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // Title text - subtle
      ctx.save();
      ctx.textAlign = 'center';
      ctx.globalAlpha = Math.max(0, 0.5 - progress * 0.4);
      ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = 'rgba(180,220,255,0.7)';
      ctx.fillText('deep ocean', w / 2, h * 0.14);
      ctx.font = '400 9px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = 'rgba(180,220,255,0.4)';
      ctx.fillText('click to close', w / 2, h * 0.24);
      ctx.restore();

      // Subtle vignette
      const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,10,20,0.4)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);

      // Progress bar - subtle
      ctx.fillStyle = 'rgba(120,180,220,0.15)';
      ctx.fillRect(0, h - 2, w * progress, 2);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        onEnd();
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafRef.current);
      canvas.style.filter = '';
    };
  }, [active, onEnd, seedScene]);

  if (!active) return null;

  const isMediaMode = mediaUrl && media && media.type !== 'default';

  return (
    <div
      onClick={onEnd}
      style={{
        // Small floating widget above the status bar — never hijacks the
        // terminal. Click anywhere on it to dismiss.
        position: 'fixed',
        right: 12,
        bottom: 40,
        width: BOX_W,
        height: BOX_H,
        zIndex: 99999,
        cursor: 'pointer',
        background: '#000',
        borderRadius: 'var(--brutal-radius)',
        border: '1px solid rgba(122,162,247,0.35)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
        overflow: 'hidden',
      }}
    >
      {isMediaMode && media.type === 'image' ? (
        <img
          src={mediaUrl}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : isMediaMode && media.type === 'video' ? (
        <video
          ref={videoRef}
          src={mediaUrl}
          autoPlay
          loop
          muted
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <canvas ref={canvasRef} style={{ display: 'block' }} />
      )}

      {/* Controls */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'absolute',
          bottom: 6,
          right: 6,
          display: 'flex',
          gap: 4,
          zIndex: 100000,
        }}
      >
        <button
          onClick={handlePickFile}
          title="로컬 이미지/영상 파일로 배경을 바꿀 수 있어요 (png, jpg, gif, mp4, webm, mov)"
          style={{
            background: 'rgba(255,255,255,0.12)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.2)',
            color: 'rgba(255,255,255,0.8)',
            borderRadius: 'var(--brutal-radius)',
            padding: '3px 8px',
            fontSize: 10,
            cursor: 'pointer',
            transition: 'background 0.06s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.22)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
        >
          배경 변경
        </button>
        {media && media.type !== 'default' && (
          <button
            onClick={handleReset}
            title="기본 바다 애니메이션으로 되돌리기"
            style={{
              background: 'rgba(255,255,255,0.12)',
              backdropFilter: 'blur(8px)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: 'rgba(255,255,255,0.8)',
              borderRadius: 'var(--brutal-radius)',
              padding: '6px 14px',
              fontSize: 12,
              cursor: 'pointer',
              transition: 'background 0.06s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.22)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
          >
            기본으로
          </button>
        )}
        <button
          onClick={e => { e.stopPropagation(); onEnd(); }}
          style={{
            background: 'rgba(255,255,255,0.12)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.2)',
            color: 'rgba(255,255,255,0.8)',
            borderRadius: 'var(--brutal-radius)',
            padding: '3px 8px',
            fontSize: 10,
            cursor: 'pointer',
            transition: 'background 0.06s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.22)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
        >
          닫기
        </button>
      </div>
    </div>
  );
}
