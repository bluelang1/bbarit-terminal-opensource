// BBARIT Motion — pure logic for the Higgsfield-style fal.ai motion studio.
// The panel drives a bbarit-agent RPC child whose fal_image / fal_video tools
// (bbarit-agent/src/fal.rs) do the actual generation; this module builds the
// per-job agent instructions, output paths, and preset tables.

export type MotionMode = 'video' | 'image' | 'scenario' | 'speak';

export interface CameraMotionPreset {
  key: string;
  label: string;
  category: string;
  // Animated preview class for the preset gallery card (Higgsfield-style
  // motion previews without video assets) — must exist in MOTION_PREVIEW_ANIMS.
  anim: MotionPreviewAnim;
}

export type MotionPreviewAnim =
  | 'zoom-in' | 'zoom-out' | 'punch-in' | 'punch-out' | 'yoyo' | 'zoom-far'
  | 'pan-left' | 'pan-right' | 'rise' | 'fall' | 'whip' | 'orbit' | 'spin'
  | 'shake' | 'tilt' | 'pulse' | 'focus' | 'still';

export const MOTION_PREVIEW_ANIMS: MotionPreviewAnim[] = [
  'zoom-in', 'zoom-out', 'punch-in', 'punch-out', 'yoyo', 'zoom-far',
  'pan-left', 'pan-right', 'rise', 'fall', 'whip', 'orbit', 'spin',
  'shake', 'tilt', 'pulse', 'focus', 'still',
];

export const CAMERA_CATEGORIES = [
  'Zoom', 'Dolly', 'Crane', 'Pan & Tilt', 'Orbit', 'Specialty', 'Vehicle', 'Time', 'Focus & POV', 'Transition',
] as const;

// The full Higgsfield camera-controls library (higgsfield.ai/camera-controls).
// Keys must mirror CAMERA_MOTIONS in bbarit-agent/src/fal.rs — the agent tool
// rejects unknown keys.
export const CAMERA_MOTION_PRESETS: CameraMotionPreset[] = [
  { key: 'zoom_in', label: 'Zoom In', category: 'Zoom', anim: 'zoom-in' },
  { key: 'zoom_out', label: 'Zoom Out', category: 'Zoom', anim: 'zoom-out' },
  { key: 'crash_zoom_in', label: 'Crash Zoom In', category: 'Zoom', anim: 'punch-in' },
  { key: 'crash_zoom_out', label: 'Crash Zoom Out', category: 'Zoom', anim: 'punch-out' },
  { key: 'rapid_zoom_in', label: 'Rapid Zoom In', category: 'Zoom', anim: 'punch-in' },
  { key: 'rapid_zoom_out', label: 'Rapid Zoom Out', category: 'Zoom', anim: 'punch-out' },
  { key: 'dolly_zoom_in', label: 'Dolly Zoom In', category: 'Zoom', anim: 'focus' },
  { key: 'dolly_zoom_out', label: 'Dolly Zoom Out', category: 'Zoom', anim: 'focus' },
  { key: 'yoyo_zoom', label: 'YoYo Zoom', category: 'Zoom', anim: 'yoyo' },
  { key: 'eating_zoom', label: 'Eating Zoom', category: 'Zoom', anim: 'punch-in' },
  { key: 'earth_zoom_out', label: 'Earth Zoom Out', category: 'Zoom', anim: 'zoom-far' },
  { key: 'dolly_in', label: 'Dolly In', category: 'Dolly', anim: 'zoom-in' },
  { key: 'dolly_out', label: 'Dolly Out', category: 'Dolly', anim: 'zoom-out' },
  { key: 'dolly_left', label: 'Dolly Left', category: 'Dolly', anim: 'pan-left' },
  { key: 'dolly_right', label: 'Dolly Right', category: 'Dolly', anim: 'pan-right' },
  { key: 'double_dolly', label: 'Double Dolly', category: 'Dolly', anim: 'pan-left' },
  { key: 'super_dolly_in', label: 'Super Dolly In', category: 'Dolly', anim: 'zoom-in' },
  { key: 'super_dolly_out', label: 'Super Dolly Out', category: 'Dolly', anim: 'zoom-out' },
  { key: 'crane_up', label: 'Crane Up', category: 'Crane', anim: 'rise' },
  { key: 'crane_down', label: 'Crane Down', category: 'Crane', anim: 'fall' },
  { key: 'crane_over_the_head', label: 'Crane Over Head', category: 'Crane', anim: 'rise' },
  { key: 'jib_up', label: 'Jib Up', category: 'Crane', anim: 'rise' },
  { key: 'jib_down', label: 'Jib Down', category: 'Crane', anim: 'fall' },
  { key: 'pan_left', label: 'Pan Left', category: 'Pan & Tilt', anim: 'pan-left' },
  { key: 'pan_right', label: 'Pan Right', category: 'Pan & Tilt', anim: 'pan-right' },
  { key: 'tilt_up', label: 'Tilt Up', category: 'Pan & Tilt', anim: 'rise' },
  { key: 'tilt_down', label: 'Tilt Down', category: 'Pan & Tilt', anim: 'fall' },
  { key: 'whip_pan', label: 'Whip Pan', category: 'Pan & Tilt', anim: 'whip' },
  { key: '360_orbit', label: '360 Orbit', category: 'Orbit', anim: 'orbit' },
  { key: '3d_rotation', label: '3D Rotation', category: 'Orbit', anim: 'spin' },
  { key: 'arc_left', label: 'Arc Left', category: 'Orbit', anim: 'orbit' },
  { key: 'arc_right', label: 'Arc Right', category: 'Orbit', anim: 'orbit' },
  { key: 'orbit_left', label: 'Orbit Left', category: 'Orbit', anim: 'orbit' },
  { key: 'orbit_right', label: 'Orbit Right', category: 'Orbit', anim: 'orbit' },
  { key: 'lazy_susan', label: 'Lazy Susan', category: 'Orbit', anim: 'spin' },
  { key: 'fpv_drone', label: 'FPV Drone', category: 'Specialty', anim: 'punch-in' },
  { key: 'handheld', label: 'Handheld', category: 'Specialty', anim: 'shake' },
  { key: 'head_tracking', label: 'Head Tracking', category: 'Specialty', anim: 'pan-left' },
  { key: 'overhead', label: 'Overhead', category: 'Specialty', anim: 'fall' },
  { key: 'snorricam', label: 'Snorricam', category: 'Specialty', anim: 'shake' },
  { key: 'dutch_angle', label: 'Dutch Angle', category: 'Specialty', anim: 'tilt' },
  { key: 'incline', label: 'Incline', category: 'Specialty', anim: 'rise' },
  { key: 'robo_arm', label: 'Robo Arm', category: 'Specialty', anim: 'whip' },
  { key: 'wiggle', label: 'Wiggle', category: 'Specialty', anim: 'shake' },
  { key: 'static', label: 'Static', category: 'Specialty', anim: 'still' },
  { key: 'bts', label: 'BTS', category: 'Specialty', anim: 'still' },
  { key: 'fisheye', label: 'Fisheye', category: 'Specialty', anim: 'yoyo' },
  { key: 'glam', label: 'Glam', category: 'Specialty', anim: 'pulse' },
  { key: 'buckle_up', label: 'Buckle Up', category: 'Vehicle', anim: 'whip' },
  { key: 'car_chasing', label: 'Car Chasing', category: 'Vehicle', anim: 'whip' },
  { key: 'car_grip', label: 'Car Grip', category: 'Vehicle', anim: 'pan-right' },
  { key: 'road_rush', label: 'Road Rush', category: 'Vehicle', anim: 'punch-in' },
  { key: 'hyperlapse', label: 'Hyperlapse', category: 'Time', anim: 'punch-in' },
  { key: 'timelapse_glam', label: 'Timelapse Glam', category: 'Time', anim: 'pulse' },
  { key: 'timelapse_human', label: 'Timelapse Human', category: 'Time', anim: 'pulse' },
  { key: 'timelapse_landscape', label: 'Timelapse Landscape', category: 'Time', anim: 'pulse' },
  { key: 'bullet_time', label: 'Bullet Time', category: 'Time', anim: 'orbit' },
  { key: 'low_shutter', label: 'Low Shutter', category: 'Time', anim: 'whip' },
  { key: 'focus_change', label: 'Focus Change', category: 'Focus & POV', anim: 'focus' },
  { key: 'hero_cam', label: 'Hero Cam', category: 'Focus & POV', anim: 'orbit' },
  { key: 'eyes_in', label: 'Eyes In', category: 'Focus & POV', anim: 'punch-in' },
  { key: 'mouth_in', label: 'Mouth In', category: 'Focus & POV', anim: 'punch-in' },
  { key: 'object_pov', label: 'Object POV', category: 'Focus & POV', anim: 'shake' },
  { key: 'flying_cam_transition', label: 'Flying Cam', category: 'Transition', anim: 'rise' },
  { key: 'through_object_in', label: 'Through Object In', category: 'Transition', anim: 'punch-in' },
  { key: 'through_object_out', label: 'Through Object Out', category: 'Transition', anim: 'punch-out' },
];

export interface VfxEffectPreset {
  key: string;
  label: string;
  icon: string;
}

// Higgsfield Effects library (curated) — keys mirror VFX_EFFECTS in fal.rs.
// Up to MAX_VFX_MIX can be mixed into one shot, like Higgsfield's Effects Mix.
export const VFX_EFFECT_PRESETS: VfxEffectPreset[] = [
  { key: 'explosion', label: 'Explosion', icon: '💥' },
  { key: 'building_explosion', label: 'Building Explosion', icon: '🏢' },
  { key: 'plasma_explosion', label: 'Plasma Explosion', icon: '🔮' },
  { key: 'clone_explosion', label: 'Clone Explosion', icon: '👯' },
  { key: 'disintegration', label: 'Disintegration', icon: '✨' },
  { key: 'levitation', label: 'Levitation', icon: '🪶' },
  { key: 'set_on_fire', label: 'Set on Fire', icon: '🔥' },
  { key: 'melting', label: 'Melting', icon: '🫠' },
  { key: 'freezing', label: 'Freezing', icon: '🧊' },
  { key: 'thunder_god', label: 'Thunder God', icon: '⚡' },
  { key: 'invisible', label: 'Invisible', icon: '👻' },
  { key: 'turning_metal', label: 'Turning Metal', icon: '🤖' },
  { key: 'glitch', label: 'Glitch', icon: '📺' },
  { key: 'portal', label: 'Portal', icon: '🌀' },
  { key: 'money_rain', label: 'Money Rain', icon: '💸' },
  { key: 'firework', label: 'Firework', icon: '🎆' },
  { key: 'face_punch', label: 'Face Punch', icon: '👊' },
  { key: 'i_can_fly', label: 'I Can Fly', icon: '🦸' },
  { key: 'shadow_smoke', label: 'Shadow Smoke', icon: '🌑' },
  { key: 'sakura_petals', label: 'Sakura Petals', icon: '🌸' },
  { key: 'northern_lights', label: 'Northern Lights', icon: '🌌' },
  { key: 'color_rain', label: 'Color Rain', icon: '🌈' },
  { key: 'tentacles', label: 'Tentacles', icon: '🐙' },
  { key: 'wind_to_face', label: 'Wind to Face', icon: '💨' },
];

export const MAX_VFX_MIX = 2;

export interface ImageStylePreset {
  key: string;
  label: string;
  // Style suffix appended to the image prompt (Higgsfield Soul-style looks).
  suffix: string;
}

export const IMAGE_STYLE_PRESETS: ImageStylePreset[] = [
  { key: 'none', label: 'No Style', suffix: '' },
  { key: 'cinematic', label: 'Cinematic', suffix: 'cinematic film still, dramatic lighting, shallow depth of field' },
  { key: 'realistic', label: 'Realistic', suffix: 'ultra photorealistic photography, natural light, fine detail' },
  { key: 'portrait', label: 'Portrait', suffix: 'editorial portrait photography, 85mm lens, studio lighting' },
  { key: 'fashion', label: 'Fashion', suffix: 'high-fashion editorial photography, bold styling' },
  { key: 'product', label: 'Product', suffix: 'clean studio product shot, softbox lighting, seamless background' },
  { key: 'anime', label: 'Anime', suffix: 'anime illustration style, vivid colors, clean lineart' },
  { key: 'y2k', label: 'Y2K', suffix: 'Y2K 2000s aesthetic, retro digicam flash photo' },
  { key: 'film', label: '35mm Film', suffix: '35mm analog film photo, natural grain, Kodak Portra palette' },
  { key: 'neon', label: 'Neon Night', suffix: 'neon-lit night scene, cyberpunk color palette, reflections' },
  { key: 'minimal', label: 'Minimal', suffix: 'minimalist composition, generous negative space' },
];

export const VIDEO_DURATIONS = ['5', '10'] as const;
export const VIDEO_ASPECTS = ['16:9', '9:16', '1:1'] as const;

export interface MotionModelPreset {
  key: string;
  label: string;
  desc: string;
  // fal model id per direction; empty string = let the agent tool pick its default.
  textToVideo?: string;
  imageToVideo?: string;
  textToImage?: string;
}

// Model ids verified against fal.ai/models — keep in sync with the hints in
// bbarit-agent/src/tools.rs (fal_image / fal_video descriptions).
export const VIDEO_MODEL_PRESETS: MotionModelPreset[] = [
  { key: 'auto', label: 'Auto', desc: 'Kling 1.6 Standard — balanced default' },
  {
    key: 'kling-pro', label: 'Kling 1.6 Pro', desc: 'Sharper motion, higher cost',
    textToVideo: 'fal-ai/kling-video/v1.6/pro/text-to-video',
    imageToVideo: 'fal-ai/kling-video/v1.6/pro/image-to-video',
  },
  {
    key: 'minimax', label: 'MiniMax 01', desc: 'Expressive characters and faces',
    textToVideo: 'fal-ai/minimax/video-01',
    imageToVideo: 'fal-ai/minimax/video-01/image-to-video',
  },
  {
    key: 'veo2', label: 'Veo 2', desc: 'Google Veo 2 — cinematic realism',
    textToVideo: 'fal-ai/veo2',
    imageToVideo: 'fal-ai/veo2/image-to-video',
  },
  {
    key: 'wan', label: 'WAN 2.1', desc: 'Open-source, fast and cheap',
    textToVideo: 'fal-ai/wan-t2v',
    imageToVideo: 'fal-ai/wan-i2v',
  },
];

export const IMAGE_MODEL_PRESETS: MotionModelPreset[] = [
  { key: 'auto', label: 'Auto', desc: 'FLUX dev; FLUX Kontext when editing a source image' },
  { key: 'flux-schnell', label: 'FLUX Schnell', desc: 'Fastest, cheapest', textToImage: 'fal-ai/flux/schnell' },
  { key: 'flux-dev', label: 'FLUX Dev', desc: 'High quality default', textToImage: 'fal-ai/flux/dev' },
  { key: 'flux-pro', label: 'FLUX Pro 1.1', desc: 'Premium quality', textToImage: 'fal-ai/flux-pro/v1.1' },
];

// The fal model id for a job, or undefined to let the agent tool default.
// A key containing '/' is a raw fal model id picked from the full catalog —
// pass it through untouched.
export function resolveMotionModel(mode: MotionMode, presetKey: string, hasSource: boolean): string | undefined {
  if (presetKey.includes('/')) return presetKey;
  if (mode === 'video') {
    const preset = VIDEO_MODEL_PRESETS.find((p) => p.key === presetKey);
    return hasSource ? preset?.imageToVideo : preset?.textToVideo;
  }
  // Editing with a source image defaults to FLUX Kontext inside the tool —
  // an explicit text-to-image model would ignore the source, so drop it.
  if (hasSource) return undefined;
  return IMAGE_MODEL_PRESETS.find((p) => p.key === presetKey)?.textToImage;
}

// ── Full fal.ai model catalog ────────────────────────────────────────────
// fal.ai exposes its public model list at fal.ai/api/models (paginated, 40 per
// page, `pages` field). The panel fetches the media categories through the
// app's http_request proxy and caches the result for a day.

export interface FalCatalogModel {
  id: string;
  title: string;
  category: string;
  desc: string;
  thumb?: string;
}

export const FAL_VIDEO_CATEGORIES = ['text-to-video', 'image-to-video'] as const;
export const FAL_IMAGE_CATEGORIES = ['text-to-image', 'image-to-image'] as const;

export function falCatalogPageUrl(category: string, page: number): string {
  return `https://fal.ai/api/models?categories=${encodeURIComponent(category)}&page=${page}`;
}

// One catalog page (already JSON-parsed) → models + total page count.
export function parseFalCatalogPage(payload: unknown): { models: FalCatalogModel[]; pages: number } {
  const data = payload as { items?: unknown[]; pages?: number } | null;
  const items = Array.isArray(data?.items) ? data.items : [];
  const models: FalCatalogModel[] = [];
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) continue;
    models.push({
      id,
      title: typeof item.title === 'string' && item.title ? item.title : id,
      category: typeof item.category === 'string' ? item.category : '',
      desc: typeof item.shortDescription === 'string' ? item.shortDescription.trim() : '',
      thumb: typeof item.thumbnailUrl === 'string' ? item.thumbnailUrl : undefined,
    });
  }
  return { models, pages: typeof data?.pages === 'number' && data.pages > 0 ? data.pages : 1 };
}

export interface MotionImageSize {
  key: string;
  label: string;
}

// fal named image_size presets (see bbarit-agent/src/fal.rs parse_image_size).
export const MOTION_IMAGE_SIZES: MotionImageSize[] = [
  { key: 'square_hd', label: 'Square 1024' },
  { key: 'landscape_16_9', label: 'Landscape 16:9' },
  { key: 'portrait_16_9', label: 'Portrait 9:16' },
  { key: 'landscape_4_3', label: 'Landscape 4:3' },
  { key: 'portrait_4_3', label: 'Portrait 3:4' },
];

export interface MotionJobSpec {
  mode: MotionMode;
  prompt: string;
  outPath: string;
  // Local path of the source image to animate (video) or edit (image).
  sourceImage?: string;
  // End-frame image (Kling start/end frame feature).
  endImage?: string;
  cameraMotion?: string;
  // VFX preset keys, max MAX_VFX_MIX.
  effects?: string[];
  duration?: string;
  aspect?: string;
  imageSize?: string;
  // Style preset suffix merged into the image prompt (Soul-style look).
  styleSuffix?: string;
  // Explicit fal model id; omitted = the agent tool's default.
  model?: string;
  // Let the agent polish the prompt cinematically before generating.
  enhance?: boolean;
}

function sanitizeSlug(text: string): string {
  const slug = String(text || '')
    .replace(/[\\/:*?"<>|.]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('-')
    .slice(0, 40);
  return slug || 'motion';
}

// Deterministic output path the panel can poll while the agent works.
export function planMotionOutput(sessionDir: string, mode: MotionMode, prompt: string, stamp: number): string {
  const dir = sessionDir.replace(/\/$/, '');
  const ext = mode === 'image' ? 'png' : 'mp4';
  const mediaDir = mode === 'image' ? 'images' : 'videos';
  return `${dir}/${mediaDir}/${sanitizeSlug(prompt)}-${stamp.toString(36)}.${ext}`;
}

// Speak (Higgsfield Speak-style talking avatar): TTS the script, then drive
// the face image with the audio through a lipsync model. Model ids verified
// against fal.ai/models.
export const SPEAK_TTS_MODEL = 'fal-ai/minimax/speech-02-hd';
export const SPEAK_LIPSYNC_MODEL = 'fal-ai/sadtalker';

export interface SpeakJobSpec {
  imagePath: string;
  script: string;
  outPath: string;
}

export function buildSpeakAgentPrompt(job: SpeakJobSpec): string {
  const dir = job.outPath.slice(0, job.outPath.lastIndexOf('/'));
  return [
    'You are the BBARIT Motion speak director. Turn a face photo + script into a talking-avatar video.',
    '',
    '## Steps',
    '1. Generate the voice with `fal_run`:',
    '```json',
    `{"model": "${SPEAK_TTS_MODEL}", "payload": {"text": ${JSON.stringify(job.script)}}, "output": "${dir}/speak-voice.mp3"}`,
    '```',
    '2. Lip-sync the photo to that audio with `fal_run`:',
    '```json',
    `{"model": "${SPEAK_LIPSYNC_MODEL}", "files": {"source_image_url": "${job.imagePath}", "driven_audio_url": "${dir}/speak-voice.mp3"}, "output": "${job.outPath}", "wait": 900}`,
    '```',
    '',
    '## Rules',
    `- Keep the final output path exactly ${job.outPath} — the UI is watching it.`,
    '- If a step fails, retry it once with the error taken into account (e.g. adjust payload keys per the error message).',
    '- When finished, reply with only the final file path.',
  ].join('\n');
}

// Upscale a generated image (Higgsfield's Topaz-style enhance) via fal.
export const UPSCALE_MODEL = 'fal-ai/clarity-upscaler';
export const VIDEO_UPSCALE_MODEL = 'fal-ai/topaz/upscale/video';
export const REMOVE_BG_MODEL = 'fal-ai/birefnet/v2';

// Shared shape for the one-call fal_run card actions (upscale / 4K / bg).
function buildSingleFalRunPrompt(job: string, args: Record<string, unknown>): string {
  return [
    `You are the BBARIT Motion editor. ${job}`,
    '',
    'Call `fal_run` exactly once:',
    '```json',
    JSON.stringify(args),
    '```',
    '',
    '- Keep "output" exactly as given — the UI is watching that path.',
    '- Do not touch any other files. When finished, reply with only the saved file path.',
  ].join('\n');
}

export function buildUpscaleAgentPrompt(imagePath: string, outPath: string): string {
  return buildSingleFalRunPrompt('Upscale ONE image.', {
    model: UPSCALE_MODEL, image: imagePath, output: outPath,
  });
}

export function buildVideoUpscaleAgentPrompt(videoPath: string, outPath: string): string {
  return buildSingleFalRunPrompt('Upscale ONE video to 4K (Topaz).', {
    model: VIDEO_UPSCALE_MODEL, video: videoPath, output: outPath, wait: 1500,
  });
}

export function buildRemoveBgAgentPrompt(imagePath: string, outPath: string): string {
  return buildSingleFalRunPrompt('Remove the background from ONE image (transparent PNG).', {
    model: REMOVE_BG_MODEL, image: imagePath, output: outPath,
  });
}

// Brush inpaint (Higgsfield Edit-style): white mask area gets regenerated per
// the prompt. Schema verified via fal OpenAPI: prompt + image_url + mask_url.
export const INPAINT_MODEL = 'fal-ai/flux-general/inpainting';

export interface InpaintJobSpec {
  imagePath: string;
  maskPath: string;
  prompt: string;
  outPath: string;
}

export function buildInpaintAgentPrompt(job: InpaintJobSpec): string {
  return buildSingleFalRunPrompt('Inpaint ONE image — regenerate the white mask area as prompted.', {
    model: INPAINT_MODEL,
    payload: { prompt: job.prompt },
    files: { image_url: job.imagePath, mask_url: job.maskPath },
    output: job.outPath,
  });
}

// Extend an existing clip by one more shot (Dream Machine-style "extend"):
// the agent grabs the final frame with ffmpeg, animates it as a seamless
// continuation via fal_video, then concats original + new clip into outPath.
export interface ExtendJobSpec {
  videoPath: string;
  prompt: string;
  outPath: string;
  aspect?: string;
  model?: string;
}

export function buildExtendAgentPrompt(job: ExtendJobSpec): string {
  const dir = job.outPath.slice(0, job.outPath.lastIndexOf('/'));
  const modelArg = job.model ? `, "model": "${job.model}"` : '';
  return [
    'You are the BBARIT Motion editor. EXTEND an existing video with one seamless continuation shot.',
    '',
    `## Source video`,
    job.videoPath,
    '',
    '## Steps',
    `1. Extract its final frame with bash: ffmpeg -sseof -0.1 -i "${job.videoPath}" -frames:v 1 -q:v 2 "${dir}/extend-last.png" -y`,
    '2. Call `fal_video` exactly once:',
    '```json',
    `{"prompt": "${job.prompt.replace(/"/g, '\\"')} — continue the exact same shot seamlessly from this frame", "image": "${dir}/extend-last.png", "duration": "5", "aspect_ratio": "${job.aspect || '16:9'}"${modelArg}, "output": "${dir}/extend-clip.mp4"}`,
    '```',
    `3. Concat source + new clip into exactly: ${job.outPath}`,
    '   (concat demuxer with a list file; re-encode with -c:v libx264 -pix_fmt yuv420p if stream copy fails).',
    '',
    '## Rules',
    `- Keep the final output path exactly ${job.outPath} — the UI is watching it.`,
    '- Do not modify the source video. Clean up nothing else.',
    '- When finished, reply with only the final file path.',
  ].join('\n');
}

// Scenario (multi-scene storyboard, Higgsfield Popcorn-style): the agent plans
// the scenes, renders one clip per scene with fal_video, then stitches them
// with ffmpeg into the final output path the panel is polling.
export interface ScenarioJobSpec {
  story: string;
  outPath: string;
  sceneCount: number;
  aspect?: string;
  cameraMotion?: string;
  effects?: string[];
  model?: string;
}

export function buildScenarioAgentPrompt(job: ScenarioJobSpec): string {
  const scenes = Math.min(Math.max(job.sceneCount, 2), 4);
  const dir = job.outPath.slice(0, job.outPath.lastIndexOf('/'));
  const extras: string[] = [];
  if (job.cameraMotion) extras.push(`"camera_motion": "${job.cameraMotion}"`);
  if (job.effects && job.effects.length > 0) extras.push(`"effect": "${job.effects.slice(0, MAX_VFX_MIX).join(',')}"`);
  if (job.model) extras.push(`"model": "${job.model}"`);
  return [
    'You are the BBARIT Motion scenario director. Turn ONE story into a multi-scene video.',
    '',
    '## Story',
    job.story,
    '',
    '## Steps',
    `1. Break the story into exactly ${scenes} consecutive scenes. Write one vivid cinematic`,
    '   prompt per scene. Keep characters, setting, and visual style IDENTICAL across scenes',
    '   (repeat the same character/style description in every prompt).',
    `2. For each scene i (1..${scenes}), call \`fal_video\` once with:`,
    '```json',
    `{"prompt": "<scene i prompt>", "output": "${dir}/scene-<i>.mp4", "duration": "5", "aspect_ratio": "${job.aspect || '16:9'}"${extras.length ? ', ' + extras.join(', ') : ''}}`,
    '```',
    '   Wait for each call to finish before the next (they are expensive — never call in parallel).',
    `3. Stitch the scenes with ffmpeg into exactly: ${job.outPath}`,
    '   Use the concat demuxer (write a list file, then `ffmpeg -f concat -safe 0 -i list.txt -c copy`;',
    '   if stream copy fails, re-encode with `-c:v libx264 -pix_fmt yuv420p`).',
    '',
    '## Rules',
    `- Keep the final output path exactly ${job.outPath} — the UI is watching it.`,
    '- If a scene fails, retry it once; if it fails again, stitch the scenes you have.',
    '- When finished, reply with only the final file path.',
  ].join('\n');
}

// The full instruction handed to the bbarit-agent RPC child for one job. The
// output path is pre-decided so the panel needs no tool-output parsing — it
// polls the file and renders it the moment it lands.
export function buildMotionAgentPrompt(job: MotionJobSpec): string {
  const tool = job.mode === 'video' ? 'fal_video' : 'fal_image';
  const prompt = job.mode === 'image' && job.styleSuffix
    ? `${job.prompt.trim().replace(/[.,]$/, '')}, ${job.styleSuffix}`
    : job.prompt;
  const args: Record<string, unknown> = { prompt, output: job.outPath };
  if (job.sourceImage) args.image = job.sourceImage;
  if (job.model) args.model = job.model;
  if (job.mode === 'video') {
    if (job.cameraMotion) args.camera_motion = job.cameraMotion;
    if (job.effects && job.effects.length > 0) args.effect = job.effects.slice(0, MAX_VFX_MIX).join(',');
    if (job.endImage) args.end_image = job.endImage;
    args.duration = job.duration || '5';
    args.aspect_ratio = job.aspect || '16:9';
  } else {
    args.image_size = job.imageSize || 'landscape_16_9';
    args.num_images = 1;
  }
  const lines = [
    'You are the BBARIT Motion studio worker. Generate ONE media file with the fal.ai tool.',
    '',
    `Call the \`${tool}\` tool exactly once with these arguments:`,
    '```json',
    JSON.stringify(args, null, 2),
    '```',
    '',
    '## Rules',
    job.enhance === false
      ? '- Use the prompt verbatim — do not rewrite it.'
      : '- You may polish ONLY the "prompt" value into one or two vivid cinematic sentences (keep the subject, style, and language intent identical). Every other argument must be passed through EXACTLY as given.',
    '- Keep "output" exactly as given — the UI is watching that path.',
    '- Do not create, move, or edit any other files.',
    '- If the tool fails, reply with the error message; do not retry more than once.',
    '- When finished, reply with only the saved file path.',
  ];
  return lines.join('\n');
}
