---
name: bbarit-video
description: Create professional motion-graphics videos (shorts, promos, intros, slide videos, caption videos) with HyperFrames — an HTML+GSAP video framework rendered to MP4 via CLI. Also covers merging/converting existing videos with ffmpeg. Use whenever the user asks for a video deliverable.
---

# 빠릿비디오 — HyperFrames video production

HyperFrames turns an HTML file into a rendered MP4: `data-*` attributes define clip
timing, a paused GSAP timeline defines motion, CSS defines appearance. You author the
HTML, the CLI renders it frame-perfect. Requires Node ≥ 22 and FFmpeg (`npx hyperframes doctor` to check).

## CLI workflow (always this order)

```bash
npx -y hyperframes@latest init <dir> --non-interactive     # scaffold; --video clip.mp4 / --audio track.mp3 to include media
# ... edit index.html (see authoring rules below) ...
npx -y hyperframes@latest lint <dir>                       # must pass before rendering
npx -y hyperframes@latest render --quality standard --output <session>/<topic-based name>.mp4
npx -y hyperframes@latest tts "text" --voice af_nova --output narration.wav   # narration
npx -y hyperframes@latest transcribe audio.mp3             # word timings for captions
```

`--quality draft` while iterating, `standard` for delivery. Vertical shorts: set the
root composition to 1080×1920. Always read the scaffolded `index.html` first and keep
its structure.

## Before writing HTML

1. Decide the narrative arc, scene list, and pacing first.
2. Define a visual identity (3-5 colors with roles, 1-2 font families, mood). Never
   default to `#333`/`#3b82f6`/Roboto. Dark canvas → avoid full-screen linear
   gradients (H.264 banding); use radial or solid + localized glow.
3. **Layout before animation**: write each scene's hero frame as static HTML+CSS
   first (`.scene-content` fills the scene with `width:100%;height:100%;padding;
   display:flex;gap` — never absolute-position content containers). Then add
   entrances with `gsap.from()` toward that CSS ground truth, exits with `gsap.to()`.

## Composition format

Root `index.html`: a `<div data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="N">`
directly in `<body>` (NO `<template>` wrapper for the root), with scoped `<style>`,
GSAP from CDN, and:

```html
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  // tweens…
  window.__timelines["main"] = tl;
</script>
```

Clip attributes: `id` (unique), `data-start` (sec or `"otherId + 2"`), `data-duration`
(required for img/div; video/audio default to media length), `data-track-index`
(int; same-track clips must not overlap; does NOT control z-order — use CSS
`z-index`), `data-media-start` (trim), `data-volume` (0-1).

Video must be `muted playsinline`; audio is always a separate `<audio>` element (may
point at the same file). Sub-compositions live in `compositions/*.html` wrapped in
`<template>` and are loaded with `data-composition-src`.

## Non-negotiable rules

- Every timeline `{ paused: true }` and registered in `window.__timelines` — built
  synchronously (never inside async/setTimeout/Promise).
- Deterministic: no `Math.random()`/`Date.now()`; seed a PRNG if needed.
- GSAP animates visual props only (`opacity,x,y,scale,rotation,color,…`) — never
  `display`/`visibility`, never `video.play()`/`pause()`/`seek` (framework owns playback).
- No `repeat: -1` — compute finite repeats: `Math.ceil(duration / cycle) - 1`.
- Don't animate a video element's size — wrap it in a div and animate the wrapper.
- `gsap.set()` on elements from later scenes breaks — use `tl.set(sel, vars, t)` at/after
  the clip's start time.
- No `<br>` in body text — let text wrap via `max-width`.

## Scene transitions (broken video if violated)

1. ALWAYS transition between scenes — no jump cuts.
2. Every element in every scene animates IN (`gsap.from`) — nothing appears fully formed.
3. NEVER animate exits before a transition — the transition IS the exit; the outgoing
   scene must be fully visible when it fires. Only the final scene may fade out.
4. Offset the first animation 0.1-0.3s; vary eases (≥3 per scene); don't repeat the
   same entrance pattern within a scene.

## Type & pacing for rendered video

- Headlines 60px+, body 20px+, labels 16px+; `font-variant-numeric: tabular-nums` for
  number columns. Write the desired `font-family` — the compiler embeds fonts.
- Something should always be in motion (slow zoom/pan/build); hold each text/image
  beat for seconds before the next.
- Korean text: `word-break: keep-all; overflow-wrap: break-word; line-height ≥ 1.4`.

## Captions / narration

TTS with `hyperframes tts` (voices: `af_nova`, `bf_emma`, …), then `transcribe` for
word timings, then absolutely-positioned caption divs timed as clips (`data-start`/
`data-duration` per phrase). Keep captions inside a safe area (≥96px from edges on
1080×1920), 2 lines max, high contrast.

## Merging / converting existing videos (ffmpeg)

- Same codec+resolution: concat demuxer —
  `printf "file '%s'\n" a.mp4 b.mp4 > list.txt && ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp4`
- Mixed sources: normalize then concat —
  `ffmpeg -i a.mp4 -i b.mp4 -filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v0];[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v1];[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[v][a]" -map "[v]" -map "[a]" out.mp4`
- `.mov` screen recordings → mp4: `ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p -crf 20 out.mp4`
- Trim without re-encode: `ffmpeg -ss 3 -to 12 -i in.mp4 -c copy out.mp4`

## Checklist before finishing

- [ ] `npx -y hyperframes@latest lint` passes
- [ ] Rendered MP4 exists in the session folder with a topic-based filename
      ('빠릿터미널 소개 쇼츠.mp4' — never draft/output/final/video.mp4), validated
      with `ffprobe`
- [ ] Every scene has entrances + transitions; no dead zones over 1s unless intentional
- [ ] Text readable at target size; contrast ≥ 4.5:1
