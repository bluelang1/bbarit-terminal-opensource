import { describe, it, expect } from 'vitest';
import {
  CAMERA_MOTION_PRESETS,
  CAMERA_CATEGORIES,
  VFX_EFFECT_PRESETS,
  IMAGE_STYLE_PRESETS,
  VIDEO_MODEL_PRESETS,
  IMAGE_MODEL_PRESETS,
  resolveMotionModel,
  planMotionOutput,
  buildMotionAgentPrompt,
  parseFalCatalogPage,
} from './bbaritMotionStudio';

describe('preset tables', () => {
  it('should_have_unique_snake_case_keys', () => {
    for (const list of [CAMERA_MOTION_PRESETS, VFX_EFFECT_PRESETS]) {
      const keys = list.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) expect(key).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('should_cover_the_higgsfield_camera_library_with_valid_categories', () => {
    expect(CAMERA_MOTION_PRESETS.length).toBeGreaterThanOrEqual(55);
    expect(VFX_EFFECT_PRESETS.length).toBeGreaterThanOrEqual(20);
    const categories = new Set<string>(CAMERA_CATEGORIES);
    for (const p of CAMERA_MOTION_PRESETS) expect(categories.has(p.category)).toBe(true);
  });
});

describe('resolveMotionModel', () => {
  it('should_return_undefined_for_auto_so_the_tool_defaults_apply', () => {
    expect(resolveMotionModel('video', 'auto', false)).toBeUndefined();
    expect(resolveMotionModel('video', 'auto', true)).toBeUndefined();
    expect(resolveMotionModel('image', 'auto', false)).toBeUndefined();
  });

  it('should_pick_direction_specific_video_model_ids', () => {
    expect(resolveMotionModel('video', 'kling-pro', false)).toBe('fal-ai/kling-video/v1.6/pro/text-to-video');
    expect(resolveMotionModel('video', 'kling-pro', true)).toBe('fal-ai/kling-video/v1.6/pro/image-to-video');
    expect(resolveMotionModel('video', 'veo2', true)).toBe('fal-ai/veo2/image-to-video');
  });

  it('should_drop_explicit_image_model_when_editing_a_source', () => {
    expect(resolveMotionModel('image', 'flux-schnell', false)).toBe('fal-ai/flux/schnell');
    expect(resolveMotionModel('image', 'flux-schnell', true)).toBeUndefined();
  });

  it('should_have_unique_preset_keys', () => {
    for (const list of [VIDEO_MODEL_PRESETS, IMAGE_MODEL_PRESETS]) {
      const keys = list.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('should_pass_raw_fal_ids_from_the_catalog_through', () => {
    expect(resolveMotionModel('video', 'bytedance/seedance-2.0/text-to-video', false)).toBe('bytedance/seedance-2.0/text-to-video');
    expect(resolveMotionModel('image', 'fal-ai/nano-banana-2/edit', true)).toBe('fal-ai/nano-banana-2/edit');
  });
});

describe('parseFalCatalogPage', () => {
  it('should_extract_models_and_page_count', () => {
    const { models, pages } = parseFalCatalogPage({
      pages: 4,
      items: [
        { id: 'fal-ai/flux/dev', title: 'FLUX Dev', category: 'text-to-image', shortDescription: 'x', thumbnailUrl: 'https://t/1.jpg' },
        { title: 'no id — dropped' },
      ],
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'fal-ai/flux/dev', title: 'FLUX Dev', category: 'text-to-image' });
    expect(pages).toBe(4);
  });

  it('should_survive_malformed_payloads', () => {
    expect(parseFalCatalogPage(null)).toEqual({ models: [], pages: 1 });
    expect(parseFalCatalogPage({ items: 'nope' })).toEqual({ models: [], pages: 1 });
  });
});

describe('planMotionOutput', () => {
  it('should_use_mp4_for_video_and_png_for_image', () => {
    expect(planMotionOutput('/w/s', 'video', 'a red fox', 1000)).toMatch(/\/w\/s\/videos\/a-red-fox-rs\.mp4$/);
    expect(planMotionOutput('/w/s/', 'image', 'a red fox', 1000)).toMatch(/\/w\/s\/images\/a-red-fox-rs\.png$/);
  });

  it('should_fall_back_to_motion_slug_for_symbol_only_prompts', () => {
    expect(planMotionOutput('/w', 'video', '///???', 35)).toBe('/w/videos/motion-z.mp4');
  });
});

describe('buildSpeakAgentPrompt / buildUpscaleAgentPrompt', () => {
  it('should_chain_tts_then_lipsync_into_the_watched_path', async () => {
    const { buildSpeakAgentPrompt } = await import('./bbaritMotionStudio');
    const prompt = buildSpeakAgentPrompt({
      imagePath: '/w/face.png', script: 'Hello "world"', outPath: '/w/talk.mp4',
    });
    expect(prompt).toContain('fal-ai/minimax/speech-02-hd');
    expect(prompt).toContain('"text": "Hello \\"world\\""');
    expect(prompt).toContain('fal-ai/sadtalker');
    expect(prompt).toContain('"source_image_url": "/w/face.png"');
    expect(prompt).toContain('"driven_audio_url": "/w/speak-voice.mp3"');
    expect(prompt).toContain('exactly /w/talk.mp4');
  });

  it('should_upscale_with_clarity_into_the_watched_path', async () => {
    const { buildUpscaleAgentPrompt } = await import('./bbaritMotionStudio');
    const prompt = buildUpscaleAgentPrompt('/w/a.png', '/w/a-up.png');
    expect(prompt).toContain('fal-ai/clarity-upscaler');
    expect(prompt).toContain('"image":"/w/a.png"');
    expect(prompt).toContain('"output":"/w/a-up.png"');
  });

  it('should_build_inpaint_call_with_image_and_mask_files', async () => {
    const { buildInpaintAgentPrompt } = await import('./bbaritMotionStudio');
    const prompt = buildInpaintAgentPrompt({
      imagePath: '/w/a.png', maskPath: '/w/mask.png', prompt: 'a red hat', outPath: '/w/a-in.png',
    });
    expect(prompt).toContain('fal-ai/flux-general/inpainting');
    expect(prompt).toContain('"payload":{"prompt":"a red hat"}');
    expect(prompt).toContain('"files":{"image_url":"/w/a.png","mask_url":"/w/mask.png"}');
    expect(prompt).toContain('"output":"/w/a-in.png"');
  });

  it('should_build_video_upscale_and_bg_removal_calls', async () => {
    const { buildVideoUpscaleAgentPrompt, buildRemoveBgAgentPrompt } = await import('./bbaritMotionStudio');
    const up = buildVideoUpscaleAgentPrompt('/w/c.mp4', '/w/c-4k.mp4');
    expect(up).toContain('fal-ai/topaz/upscale/video');
    expect(up).toContain('"video":"/w/c.mp4"');
    expect(up).toContain('"wait":1500');
    const bg = buildRemoveBgAgentPrompt('/w/a.png', '/w/a-nobg.png');
    expect(bg).toContain('fal-ai/birefnet/v2');
    expect(bg).toContain('"output":"/w/a-nobg.png"');
  });
});

describe('buildExtendAgentPrompt', () => {
  it('should_chain_frame_extract_fal_video_and_concat_to_the_watched_path', async () => {
    const { buildExtendAgentPrompt } = await import('./bbaritMotionStudio');
    const prompt = buildExtendAgentPrompt({
      videoPath: '/w/clip.mp4', prompt: 'a "fox" runs', outPath: '/w/clip-extended.mp4', aspect: '9:16',
    });
    expect(prompt).toContain('ffmpeg -sseof -0.1 -i "/w/clip.mp4"');
    expect(prompt).toContain('"image": "/w/extend-last.png"');
    expect(prompt).toContain('a \\"fox\\" runs — continue the exact same shot');
    expect(prompt).toContain('"aspect_ratio": "9:16"');
    expect(prompt).toContain('exactly /w/clip-extended.mp4');
  });
});

describe('buildMotionAgentPrompt', () => {
  it('should_target_fal_video_with_exact_args_for_video_jobs', () => {
    const prompt = buildMotionAgentPrompt({
      mode: 'video',
      prompt: 'neon city at night',
      outPath: '/w/s/clip.mp4',
      sourceImage: '/w/s/src.png',
      cameraMotion: 'crash_zoom_in',
      duration: '10',
      aspect: '9:16',
    });
    expect(prompt).toContain('`fal_video`');
    expect(prompt).toContain('"output": "/w/s/clip.mp4"');
    expect(prompt).toContain('"image": "/w/s/src.png"');
    expect(prompt).toContain('"camera_motion": "crash_zoom_in"');
    expect(prompt).toContain('"duration": "10"');
    expect(prompt).toContain('"aspect_ratio": "9:16"');
  });

  it('should_omit_camera_motion_when_not_selected_and_default_duration', () => {
    const prompt = buildMotionAgentPrompt({ mode: 'video', prompt: 'x', outPath: '/o.mp4' });
    expect(prompt).not.toContain('camera_motion');
    expect(prompt).toContain('"duration": "5"');
    expect(prompt).toContain('"aspect_ratio": "16:9"');
  });

  it('should_pass_explicit_model_through_to_the_tool_args', () => {
    const prompt = buildMotionAgentPrompt({
      mode: 'video', prompt: 'x', outPath: '/o.mp4', model: 'fal-ai/veo2',
    });
    expect(prompt).toContain('"model": "fal-ai/veo2"');
  });

  it('should_target_fal_image_with_image_size_for_image_jobs', () => {
    const prompt = buildMotionAgentPrompt({
      mode: 'image', prompt: 'poster', outPath: '/o.png', imageSize: 'portrait_16_9',
    });
    expect(prompt).toContain('`fal_image`');
    expect(prompt).toContain('"image_size": "portrait_16_9"');
    expect(prompt).toContain('"num_images": 1');
    expect(prompt).not.toContain('duration');
  });

  it('should_pass_effects_end_image_and_style', () => {
    const video = buildMotionAgentPrompt({
      mode: 'video', prompt: 'x', outPath: '/o.mp4',
      effects: ['set_on_fire', 'thunder_god', 'glitch'],
      endImage: '/w/end.png',
    });
    expect(video).toContain('"effect": "set_on_fire,thunder_god"'); // capped at MAX_VFX_MIX
    expect(video).toContain('"end_image": "/w/end.png"');

    const image = buildMotionAgentPrompt({
      mode: 'image', prompt: 'a fox', outPath: '/o.png',
      styleSuffix: IMAGE_STYLE_PRESETS.find((s) => s.key === 'cinematic')!.suffix,
    });
    expect(image).toContain('a fox, cinematic film still');
    expect(image).not.toContain('effect');
  });

  it('should_switch_to_verbatim_rule_when_enhance_is_off', () => {
    const on = buildMotionAgentPrompt({ mode: 'video', prompt: 'x', outPath: '/o.mp4' });
    const off = buildMotionAgentPrompt({ mode: 'video', prompt: 'x', outPath: '/o.mp4', enhance: false });
    expect(on).toContain('polish ONLY');
    expect(off).toContain('verbatim');
  });
});
