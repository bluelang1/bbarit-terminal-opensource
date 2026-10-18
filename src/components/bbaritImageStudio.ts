// BBARIT Image — pure logic for the Codex image studio panel.
// Builds the per-image Codex job prompts, size presets, output paths, and the
// small concurrency runner used to fan out bulk generations.

export interface ImageSizePreset {
  key: string;
  label: string;
  w: number;
  h: number;
}

export const IMAGE_SIZE_PRESETS: ImageSizePreset[] = [
  { key: 'square', label: 'Square 1024×1024', w: 1024, h: 1024 },
  { key: 'landscape', label: 'Landscape 1536×1024', w: 1536, h: 1024 },
  { key: 'portrait', label: 'Portrait 1024×1536', w: 1024, h: 1536 },
  { key: 'thumbnail', label: 'YouTube 1280×720', w: 1280, h: 720 },
  { key: 'insta', label: 'Instagram 1080×1080', w: 1080, h: 1080 },
  { key: 'insta-feed', label: 'Insta Feed 1080×1350', w: 1080, h: 1350 },
  { key: 'story', label: 'Story 1080×1920', w: 1080, h: 1920 },
  { key: 'banner', label: 'Banner 1920×600', w: 1920, h: 600 },
];

export const CUSTOM_SIZE_KEY = 'custom';
export const MAX_IMAGE_DIM = 4096;
export const MIN_IMAGE_DIM = 64;

// "1200x630", "1200×630", "1200 * 630" → { w, h }; anything else → null.
export function parseCustomSize(input: string): { w: number; h: number } | null {
  const m = String(input || '').trim().match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w < MIN_IMAGE_DIM || h < MIN_IMAGE_DIM || w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) return null;
  return { w, h };
}

export interface ImageJobSpec {
  outPath: string;
  prompt: string;
  w: number;
  h: number;
  refPath?: string;
  variation?: { index: number; total: number };
  // Section i of a continuous multi-part artwork (e.g. a product detail page
  // stacked vertically) — mutually exclusive with variation.
  section?: { index: number; total: number };
  // Extra style/system rules from the active preset.
  system?: string;
  // User-attached reference images the worker must study first.
  refImages?: string[];
}

// Style presets — each narrows the generator into a purpose-built worker and
// suggests a canvas size / batch meaning (images vs sections).
export interface ImageStylePreset {
  key: string;
  label: string;
  desc: string;
  system: string;
  size?: { w: number; h: number };
  count?: number;
  // Batch items are sections of ONE continuous artwork, not variations.
  series?: boolean;
}

export const IMAGE_STYLE_PRESETS: ImageStylePreset[] = [
  { key: 'image', label: 'Image', desc: 'Any image', system: '' },
  {
    key: 'detail-page',
    label: 'Detail Page',
    desc: 'E-commerce product detail page, sections stacked vertically',
    system: [
      'This is one section of a long e-commerce product detail page. The sections will be stacked vertically into one continuous page, so:',
      '- Keep the SAME design system across sections: background color, palette, typography, margins.',
      '- No borders, frames, or drop shadows around the section edges — the seams must be invisible when stacked.',
      '- Section 1 is the hero (product name + key message), middle sections show features/benefits/details, the final section closes with specs, trust elements, and a call to action.',
      '- Text must be large, legible, and minimal — this is a commercial detail page, not a poster collage.',
    ].join('\n'),
    size: { w: 1024, h: 1536 },
    count: 3,
    series: true,
  },
  {
    key: 'four-cut',
    label: '4-Cut Comic',
    desc: 'Four-panel comic strip in one vertical image',
    system: [
      'Create a FOUR-PANEL comic strip as a single vertical image (4 stacked panels of equal height).',
      '- Clear gutters between panels; do not number the panels.',
      '- Setup → build-up → twist → punchline in the last panel.',
      '- Character designs must stay perfectly consistent across all four panels.',
      '- Speech bubbles with short, punchy text; keep backgrounds simple and consistent.',
    ].join('\n'),
    size: { w: 1080, h: 2160 },
    count: 1,
  },
];

function sanitizeSlug(text: string): string {
  const slug = String(text || '')
    .replace(/[\\/:*?"<>|.]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('-')
    .slice(0, 40);
  return slug || 'image';
}

// Deterministic output paths for a batch: <dir>/<slug>-<stamp>-1.png …
export function planBatchOutputs(sessionDir: string, prompt: string, count: number, stamp: number): string[] {
  const dir = sessionDir.replace(/\/$/, '');
  const slug = sanitizeSlug(prompt);
  const base = `${slug}-${stamp.toString(36)}`;
  return Array.from({ length: Math.max(1, count) }, (_, i) => `${dir}/${base}-${i + 1}.png`);
}

// Output path for an edit pass over an existing image: sibling "<name> edit N.png".
export function planEditOutput(refPath: string, existing: string[]): string {
  const dot = refPath.lastIndexOf('.');
  const base = dot > refPath.lastIndexOf('/') ? refPath.slice(0, dot) : refPath;
  const root = base.replace(/ edit \d+$/, '');
  for (let n = 1; n < 1000; n++) {
    const candidate = `${root} edit ${n}.png`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${root} edit ${Date.now().toString(36)}.png`;
}

export function resizedOutputPath(path: string, w: number, h: number): string {
  const dot = path.lastIndexOf('.');
  const base = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
  return `${base} ${w}x${h}.png`;
}

// The full prompt handed to a headless `codex exec` run for one image.
export function buildCodexImageJobPrompt(job: ImageJobSpec): string {
  const lines = [
    'You are an image generation worker. Use Codex\'s built-in image generation/editing capability.',
    '',
    '## Job',
    `- Output file (save exactly to this absolute path): ${job.outPath}`,
    `- Image size: exactly ${job.w}x${job.h} pixels (width x height), PNG format`,
  ];
  if (job.refPath) {
    lines.push(`- Edit source image: ${job.refPath} — read this image first, apply only the requested changes, and keep everything else (subject, composition, style) intact.`);
  }
  if (job.refImages && job.refImages.length > 0) {
    lines.push(`- Reference images (read and study these local files first; match their style, subject, or branding as the prompt directs): ${job.refImages.join(' ')}`);
  }
  if (job.section && job.section.total > 1) {
    lines.push(`- This is section ${job.section.index} of ${job.section.total} of ONE continuous artwork — it must line up seamlessly with the other sections.`);
  } else if (job.variation && job.variation.total > 1) {
    lines.push(`- This is variation ${job.variation.index} of ${job.variation.total} — make it clearly distinct from the other variations (different composition, angle, or palette) while following the prompt.`);
  }
  if (job.system) {
    lines.push('', '## Style rules', job.system);
  }
  lines.push(
    '',
    '## Hard rules',
    '- Do NOT use Gemini, Gemini API keys, or NanoBanana.',
    '- If the generated image size differs, resize it to the exact size above before saving (e.g. `sips -z <height> <width>` on macOS or ImageMagick).',
    '- Save only the final PNG at the output path. Do not create or modify any other files.',
    '- When finished, reply with only the saved file path.',
    '',
    '## Image prompt',
    job.prompt,
  );
  return lines.join('\n');
}

// Run tasks with a small concurrency cap, preserving result order.
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: string }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: string }> = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (e) {
        results[index] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
