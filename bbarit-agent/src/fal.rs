//! fal.ai media generation (fal_image / fal_video) — the Higgsfield-style
//! image & motion backend. Talks to the fal queue API (submit → poll →
//! download) with reqwest blocking, saves results into the workspace, and
//! returns local file paths. FAL_KEY comes from /login fal, the FAL_KEY /
//! FAL_API_KEY env vars, or ~/.config/octo/.env.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

use crate::config::AppConfig;

const QUEUE_BASE: &str = "https://queue.fal.run";

pub const DEFAULT_IMAGE_MODEL: &str = "fal-ai/flux/dev";
pub const DEFAULT_IMAGE_EDIT_MODEL: &str = "fal-ai/flux-kontext/dev";
pub const DEFAULT_TEXT_TO_VIDEO_MODEL: &str = "fal-ai/kling-video/v1.6/standard/text-to-video";
pub const DEFAULT_IMAGE_TO_VIDEO_MODEL: &str = "fal-ai/kling-video/v1.6/standard/image-to-video";

const IMAGE_WAIT_SECS: u64 = 300;
const VIDEO_WAIT_SECS: u64 = 900;
const RUN_WAIT_SECS: u64 = 600;
const POLL_INTERVAL_SECS: u64 = 3;
/// Files up to this size ride inline as data URIs; bigger ones go through
/// fal's storage upload and are passed by URL instead.
const MAX_INLINE_BYTES: u64 = 4 * 1024 * 1024;

/// Higgsfield-style camera motion presets (mirrors higgsfield.ai/camera-controls):
/// preset key → prompt phrase the video model understands. Kept model-agnostic
/// (prompt-level direction works across Kling / Minimax / WAN / Veo) instead of
/// per-model camera_control JSON.
pub const CAMERA_MOTIONS: &[(&str, &str)] = &[
    // Zoom & magnification
    ("zoom_in", "slow steady zoom in toward the subject"),
    ("zoom_out", "slow steady zoom out away from the subject"),
    (
        "crash_zoom_in",
        "aggressive rapid crash zoom in toward the subject",
    ),
    (
        "crash_zoom_out",
        "aggressive rapid crash zoom out away from the subject",
    ),
    (
        "rapid_zoom_in",
        "very fast rapid zoom snapping in onto the subject",
    ),
    (
        "rapid_zoom_out",
        "very fast rapid zoom snapping out away from the subject",
    ),
    (
        "dolly_zoom_in",
        "vertigo dolly-zoom: camera dollies in while the lens zooms out, background stretching unnervingly",
    ),
    (
        "dolly_zoom_out",
        "reverse vertigo dolly-zoom: camera dollies out while the lens zooms in, background compressing",
    ),
    (
        "yoyo_zoom",
        "playful yo-yo zoom bouncing in and out rhythmically",
    ),
    (
        "eating_zoom",
        "comedic fast zoom pushing toward the subject's face as they eat",
    ),
    (
        "earth_zoom_out",
        "camera zooms out from the subject higher and higher until the whole Earth is visible from space",
    ),
    // Dolly
    (
        "dolly_in",
        "slow smooth cinematic dolly in toward the subject",
    ),
    (
        "dolly_out",
        "slow smooth cinematic dolly out away from the subject",
    ),
    (
        "dolly_left",
        "camera dollies laterally to the left, tracking across the scene",
    ),
    (
        "dolly_right",
        "camera dollies laterally to the right, tracking across the scene",
    ),
    (
        "double_dolly",
        "double dolly move with layered parallax between subject and background",
    ),
    (
        "super_dolly_in",
        "dramatic super dolly push-in with telephoto compression toward the subject",
    ),
    (
        "super_dolly_out",
        "dramatic super dolly pull-out with telephoto compression away from the subject",
    ),
    // Crane & jib
    (
        "crane_up",
        "camera cranes up high above the subject in a rising reveal",
    ),
    (
        "crane_down",
        "camera cranes down from above toward the subject",
    ),
    (
        "crane_over_the_head",
        "camera cranes up and over the subject's head in a sweeping overhead pass",
    ),
    ("jib_up", "smooth jib arm rise lifting the framing upward"),
    ("jib_down", "smooth jib arm descent lowering the framing"),
    // Pan & tilt
    ("pan_left", "camera pans left across the scene"),
    ("pan_right", "camera pans right across the scene"),
    ("tilt_up", "camera tilts upward revealing the scene above"),
    (
        "tilt_down",
        "camera tilts downward revealing the scene below",
    ),
    ("whip_pan", "fast whip pan with motion blur"),
    // Rotation & orbit
    (
        "360_orbit",
        "full 360-degree orbit circling around the subject",
    ),
    (
        "3d_rotation",
        "the subject rotates in 3D space while the camera holds",
    ),
    ("arc_left", "camera arcs around the subject to the left"),
    ("arc_right", "camera arcs around the subject to the right"),
    (
        "orbit_left",
        "camera orbits smoothly around the subject to the left",
    ),
    (
        "orbit_right",
        "camera orbits smoothly around the subject to the right",
    ),
    (
        "lazy_susan",
        "the subject spins slowly on a turntable while the camera stays locked",
    ),
    // Specialty movement
    (
        "fpv_drone",
        "fast FPV drone shot flying through the scene with dynamic swoops",
    ),
    (
        "handheld",
        "handheld documentary-style camera with natural shake",
    ),
    (
        "head_tracking",
        "camera locked to the subject's head, tracking every movement",
    ),
    (
        "overhead",
        "top-down overhead shot looking straight down at the scene",
    ),
    (
        "snorricam",
        "snorricam rig locked to the subject's body, background swinging with their motion",
    ),
    (
        "dutch_angle",
        "tilted dutch angle framing, tense cinematic mood",
    ),
    (
        "incline",
        "camera glides upward along an incline, tilted with the slope",
    ),
    (
        "robo_arm",
        "robotic arm camera move with fast precise sweeping arcs",
    ),
    ("wiggle", "camera wiggles side to side playfully"),
    (
        "static",
        "locked-off static camera on a tripod, no camera movement",
    ),
    (
        "bts",
        "behind-the-scenes framing, film set and crew visible at the edges",
    ),
    ("fisheye", "ultra-wide fisheye lens with curved distortion"),
    (
        "glam",
        "glamour beauty shot with soft light sweeping across the subject",
    ),
    // Vehicle
    (
        "buckle_up",
        "camera mounted inside the car as the subject buckles up and the car launches forward",
    ),
    (
        "car_chasing",
        "high-speed car chase tracking shot weaving through traffic",
    ),
    (
        "car_grip",
        "car grip rig shot rolling alongside the moving car",
    ),
    (
        "road_rush",
        "camera racing low along the road surface at high speed",
    ),
    // Time
    (
        "hyperlapse",
        "hyperlapse, camera moving fast through space with time-lapse motion",
    ),
    (
        "timelapse_glam",
        "glamour timelapse, light and styling shifting across the subject",
    ),
    (
        "timelapse_human",
        "timelapse of the person while the world speeds past around them",
    ),
    (
        "timelapse_landscape",
        "landscape timelapse, clouds and light racing across the scene",
    ),
    (
        "bullet_time",
        "bullet-time effect, camera sweeping around a frozen moment",
    ),
    (
        "low_shutter",
        "low shutter speed with streaking motion blur trails",
    ),
    // Focus & POV
    (
        "focus_change",
        "rack focus shifting between foreground and background",
    ),
    (
        "hero_cam",
        "low heroic angle circling the subject like a movie hero shot",
    ),
    (
        "eyes_in",
        "camera pushes all the way in to the subject's eyes",
    ),
    ("mouth_in", "camera dives into the subject's open mouth"),
    (
        "object_pov",
        "point-of-view of an object in the scene looking back at the subject",
    ),
    // Transitions
    (
        "flying_cam_transition",
        "camera flies up and away, transitioning to a new vantage point",
    ),
    (
        "through_object_in",
        "camera passes through an object in the foreground toward the subject",
    ),
    (
        "through_object_out",
        "camera pulls back, passing through an object as it exits the scene",
    ),
];

/// Higgsfield-style VFX presets (mirrors higgsfield.ai effects): key → prompt
/// phrase describing what happens to the subject/scene. Up to two can be mixed.
pub const VFX_EFFECTS: &[(&str, &str)] = &[
    ("explosion", "a massive explosion erupts behind the subject"),
    (
        "building_explosion",
        "the building behind the subject collapses in a huge explosion",
    ),
    (
        "plasma_explosion",
        "a pulsing plasma energy explosion radiates outward",
    ),
    (
        "clone_explosion",
        "the subject splits into multiple clones bursting outward",
    ),
    (
        "disintegration",
        "the subject disintegrates into drifting particles",
    ),
    (
        "levitation",
        "the subject levitates, rising slowly off the ground",
    ),
    (
        "set_on_fire",
        "the subject catches fire, dramatic flames engulfing them",
    ),
    ("melting", "the subject melts like wax, dripping downward"),
    (
        "freezing",
        "frost spreads across the scene and the subject freezes in ice",
    ),
    (
        "thunder_god",
        "lightning strikes around the subject, electric arcs crackling over their body",
    ),
    ("invisible", "the subject gradually turns invisible"),
    (
        "turning_metal",
        "the subject's skin turns to liquid chrome metal",
    ),
    ("glitch", "digital glitch distortion tears across the frame"),
    (
        "portal",
        "a glowing portal opens and the subject steps through it",
    ),
    ("money_rain", "banknotes rain down around the subject"),
    ("firework", "fireworks burst in the sky behind the subject"),
    (
        "face_punch",
        "a fist punches toward the camera in dramatic slow motion",
    ),
    (
        "i_can_fly",
        "the subject launches into the sky and flies like a superhero",
    ),
    (
        "shadow_smoke",
        "black smoke shadows swirl around the subject",
    ),
    (
        "sakura_petals",
        "sakura petals swirl around the subject in the wind",
    ),
    (
        "northern_lights",
        "aurora northern lights ripple across the sky",
    ),
    ("color_rain", "colorful paint rain splashes over the scene"),
    ("tentacles", "dark tentacles rise and coil around the scene"),
    (
        "wind_to_face",
        "a strong wind blasts into the subject's face, hair and clothes whipping",
    ),
];

fn normalize_key(key: &str) -> String {
    key.trim().to_ascii_lowercase().replace([' ', '-'], "_")
}

pub fn camera_motion_phrase(key: &str) -> Option<&'static str> {
    let normalized = normalize_key(key);
    CAMERA_MOTIONS
        .iter()
        .find(|(name, _)| *name == normalized)
        .map(|(_, phrase)| *phrase)
}

pub fn camera_motion_keys() -> String {
    CAMERA_MOTIONS
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn vfx_effect_phrase(key: &str) -> Option<&'static str> {
    let normalized = normalize_key(key);
    VFX_EFFECTS
        .iter()
        .find(|(name, _)| *name == normalized)
        .map(|(_, phrase)| *phrase)
}

pub fn vfx_effect_keys() -> String {
    VFX_EFFECTS
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(", ")
}

/// Final video prompt: user prompt + VFX sentences + camera direction sentence.
/// `effects` is a comma-separated list of VFX preset keys (Higgsfield mixes two).
pub fn build_video_prompt(prompt: &str, motion: Option<&str>, effects: Option<&str>) -> String {
    let mut out = format!("{}.", prompt.trim().trim_end_matches('.'));
    if let Some(effects) = effects {
        for effect in effects.split(',') {
            if let Some(phrase) = vfx_effect_phrase(effect) {
                out.push_str(&format!(" Effect: {phrase}."));
            }
        }
    }
    if let Some(phrase) = motion.and_then(camera_motion_phrase) {
        out.push_str(&format!(" Camera movement: {phrase}."));
    }
    out
}

/// Per-family video payload: fal video models disagree on duration/aspect
/// params, so only send what each family understands. Kling takes duration
/// "5"/"10" + aspect_ratio; Veo takes duration "5s".."8s" + aspect_ratio;
/// everything else (MiniMax, WAN, …) gets prompt/image only.
#[allow(clippy::too_many_arguments)]
pub fn build_video_payload(
    model: &str,
    prompt: &str,
    motion: Option<&str>,
    effects: Option<&str>,
    duration: &str,
    aspect: &str,
    negative: Option<&str>,
    image_url: Option<&str>,
    end_image_url: Option<&str>,
) -> Value {
    let mut payload = json!({ "prompt": build_video_prompt(prompt, motion, effects) });
    if model.contains("kling-video") {
        payload["duration"] = json!(duration);
        payload["aspect_ratio"] = json!(aspect);
        if let Some(negative) = negative {
            payload["negative_prompt"] = json!(negative);
        }
        // Higgsfield-style start/end frame — only the Kling family supports it.
        if let Some(url) = end_image_url {
            payload["tail_image_url"] = json!(url);
        }
    } else if model.contains("veo") {
        payload["aspect_ratio"] = json!(aspect);
        payload["duration"] = json!(if duration == "10" { "8s" } else { "5s" });
    }
    if let Some(url) = image_url {
        payload["image_url"] = json!(url);
    }
    payload
}

/// fal image_size: named preset strings pass through, "1024x768" style
/// becomes a {width,height} object, anything else falls back to square_hd.
pub fn parse_image_size(input: Option<&str>) -> Value {
    let Some(raw) = input.map(str::trim).filter(|value| !value.is_empty()) else {
        return json!("square_hd");
    };
    if let Some((w, h)) = raw
        .split_once(['x', 'X', '×'])
        .and_then(|(w, h)| Some((w.trim().parse::<u32>().ok()?, h.trim().parse::<u32>().ok()?)))
    {
        if (64..=4096).contains(&w) && (64..=4096).contains(&h) {
            return json!({"width": w, "height": h});
        }
        return json!("square_hd");
    }
    json!(raw)
}

/// Queue endpoints live under the base app id (first two path segments of the
/// model id), not the full subpath: fal-ai/kling-video/v1.6/standard/… →
/// fal-ai/kling-video/requests/<id>.
pub fn queue_urls(model: &str, request_id: &str) -> (String, String) {
    let base: Vec<&str> = model.split('/').take(2).collect();
    let base = base.join("/");
    (
        format!("{QUEUE_BASE}/{base}/requests/{request_id}/status"),
        format!("{QUEUE_BASE}/{base}/requests/{request_id}"),
    )
}

pub fn data_uri_mime(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        _ => "image/png",
    }
}

/// Collect downloadable media URLs from an arbitrary fal result: every string
/// under a key named `url` or ending in `_url` that points at http(s).
/// Depth-first, order-stable, deduped, capped at 8.
pub fn extract_media_urls(result: &Value) -> Vec<String> {
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    if (key == "url" || key.ends_with("_url"))
                        && let Some(url) = child.as_str()
                        && url.starts_with("http")
                        && !out.iter().any(|existing| existing == url)
                        && out.len() < 8
                    {
                        out.push(url.to_string());
                    }
                    walk(child, out);
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, out);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(result, &mut out);
    out
}

/// File extension for a downloaded media URL (query string stripped).
pub fn url_extension(url: &str) -> &'static str {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => ".png",
        "jpg" | "jpeg" => ".jpg",
        "webp" => ".webp",
        "gif" => ".gif",
        "mp4" => ".mp4",
        "webm" => ".webm",
        "mov" => ".mov",
        "mp3" => ".mp3",
        "wav" => ".wav",
        "m4a" => ".m4a",
        _ => ".bin",
    }
}

/// Upload a local file to fal storage and return its public file URL —
/// initiate (name + content type) then PUT the bytes.
fn storage_upload(key: &str, path: &Path) -> Result<String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload.bin");
    let mime = data_uri_mime(name);
    let init: Value = client()?
        .post("https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3")
        .header("Authorization", format!("Key {key}"))
        .json(&json!({"file_name": name, "content_type": mime}))
        .send()?
        .error_for_status()?
        .json()?;
    let upload_url = init["upload_url"]
        .as_str()
        .ok_or_else(|| anyhow!("fal storage initiate returned no upload_url: {init}"))?;
    let file_url = init["file_url"]
        .as_str()
        .ok_or_else(|| anyhow!("fal storage initiate returned no file_url: {init}"))?
        .to_string();
    let bytes = std::fs::read(path)?;
    client()?
        .put(upload_url)
        .header("Content-Type", mime)
        .body(bytes)
        .send()?
        .error_for_status()?;
    Ok(file_url)
}

/// Whether a fal.ai key is configured — the fal_* tools are only exposed to
/// the model when this is true, so keyless sessions don't pay for their specs.
pub fn key_available(config: &AppConfig) -> bool {
    fal_key(config).is_ok()
}

fn fal_key(config: &AppConfig) -> Result<String> {
    if let Ok(Some(key)) = crate::auth::stored_api_key(config, "fal")
        && !key.trim().is_empty()
    {
        return Ok(key);
    }
    for var in ["FAL_KEY", "FAL_API_KEY"] {
        if let Ok(value) = std::env::var(var)
            && !value.trim().is_empty()
        {
            return Ok(value.trim().to_string());
        }
    }
    if let Some(home) = dirs::home_dir() {
        let env_path = home.join(".config/octo/.env");
        if let Ok(content) = std::fs::read_to_string(&env_path) {
            for line in content.lines() {
                let line = line.trim();
                for var in ["FAL_KEY", "FAL_API_KEY"] {
                    if let Some(rest) = line.strip_prefix(var)
                        && let Some(value) = rest.trim_start().strip_prefix('=')
                    {
                        let value = value.trim().trim_matches('"').trim_matches('\'');
                        if !value.is_empty() {
                            return Ok(value.to_string());
                        }
                    }
                }
            }
        }
    }
    bail!(
        "no fal.ai API key found — set FAL_KEY in the environment or in ~/.config/octo/.env \
         (get one at https://fal.ai/dashboard/keys)"
    )
}

fn client() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent("bbarit-agent")
        .build()?)
}

/// Submit to the queue and return (status_url, response_url).
fn queue_submit(key: &str, model: &str, payload: &Value) -> Result<(String, String)> {
    let response = client()?
        .post(format!("{QUEUE_BASE}/{model}"))
        .header("Authorization", format!("Key {key}"))
        .json(payload)
        .send()?;
    let status = response.status();
    let body: Value = response.json()?;
    if !status.is_success() {
        bail!("fal submit failed ({status}): {body}");
    }
    let request_id = body["request_id"]
        .as_str()
        .ok_or_else(|| anyhow!("fal submit returned no request_id: {body}"))?;
    let (fallback_status, fallback_response) = queue_urls(model, request_id);
    let status_url = body["status_url"]
        .as_str()
        .unwrap_or(&fallback_status)
        .to_string();
    let response_url = body["response_url"]
        .as_str()
        .unwrap_or(&fallback_response)
        .to_string();
    Ok((status_url, response_url))
}

fn queue_wait(key: &str, status_url: &str, deadline_secs: u64) -> Result<()> {
    let started = Instant::now();
    let http = client()?;
    loop {
        let response = http
            .get(status_url)
            .header("Authorization", format!("Key {key}"))
            .send()?;
        let code = response.status();
        let body: Value = response.json()?;
        let status = body["status"].as_str().unwrap_or("");
        match status {
            "COMPLETED" => return Ok(()),
            "IN_QUEUE" | "IN_PROGRESS" => {}
            _ if !code.is_success() => bail!("fal status check failed ({code}): {body}"),
            other => bail!("fal request ended with status {other}: {body}"),
        }
        if started.elapsed() > Duration::from_secs(deadline_secs) {
            bail!(
                "fal request still {status} after {deadline_secs}s — try again or check \
                 https://fal.ai/dashboard/requests"
            );
        }
        std::thread::sleep(Duration::from_secs(POLL_INTERVAL_SECS));
    }
}

fn fetch_result(key: &str, response_url: &str) -> Result<Value> {
    let response = client()?
        .get(response_url)
        .header("Authorization", format!("Key {key}"))
        .send()?;
    let status = response.status();
    let body: Value = response.json()?;
    if !status.is_success() {
        bail!("fal result fetch failed ({status}): {body}");
    }
    Ok(body)
}

fn download(url: &str, out: &Path) -> Result<u64> {
    let bytes = client()?.get(url).send()?.error_for_status()?.bytes()?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(out, &bytes)?;
    Ok(bytes.len() as u64)
}

fn resolve_output(config: &AppConfig, output: &str) -> PathBuf {
    let path = Path::new(output);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        config.cwd.join(path)
    }
}

/// Local media file (or pass-through URL) → value usable as a fal *_url input.
/// Small files ride inline as data URIs; larger ones are uploaded to fal
/// storage so audio/video sources work too.
fn source_media_url(config: &AppConfig, key: &str, source: &str) -> Result<String> {
    let trimmed = source.trim();
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("data:")
    {
        return Ok(trimmed.to_string());
    }
    let path = resolve_output(config, trimmed);
    let meta = std::fs::metadata(&path)
        .map_err(|_| anyhow!("source file not found: {}", path.display()))?;
    if meta.len() > MAX_INLINE_BYTES {
        return storage_upload(key, &path);
    }
    let bytes = std::fs::read(&path)?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{b64}", data_uri_mime(trimmed)))
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn required_prompt(args: &Value) -> Result<&str> {
    str_arg(args, "prompt").ok_or_else(|| anyhow!("a non-empty 'prompt' is required"))
}

pub fn execute(config: &AppConfig, name: &str, args: &Value) -> Result<String> {
    match name {
        "fal_image" => fal_image(config, args),
        "fal_video" => fal_video(config, args),
        "fal_run" => fal_run(config, args),
        _ => bail!("unknown fal tool: {name}"),
    }
}

/// Run ANY fal.ai model: arbitrary payload passthrough, local-file inputs
/// auto-hosted, every media URL in the result downloaded next to the output
/// path. This is the escape hatch that covers the whole fal catalog —
/// lipsync, TTS, upscalers, background removal, 3D, whatever ships next.
fn fal_run(config: &AppConfig, args: &Value) -> Result<String> {
    let model = str_arg(args, "model")
        .ok_or_else(|| anyhow!("fal_run requires 'model' (a fal model id like fal-ai/esrgan)"))?;
    let key = fal_key(config)?;
    let mut payload = args.get("payload").cloned().unwrap_or_else(|| json!({}));
    if !payload.is_object() {
        bail!("fal_run 'payload' must be a JSON object matching the model's input schema");
    }
    // Convenience inputs: local paths (or URLs) for the common media slots.
    for (arg, slot) in [
        ("image", "image_url"),
        ("audio", "audio_url"),
        ("video", "video_url"),
    ] {
        if let Some(source) = str_arg(args, arg) {
            payload[slot] = json!(source_media_url(config, &key, source)?);
        }
    }
    // Arbitrary media slots: 'files' maps a payload key to a local path/URL,
    // hosted and injected — e.g. {"source_image_url": "face.png",
    // "driven_audio_url": "voice.mp3"} for sadtalker-style schemas.
    if let Some(files) = args.get("files").and_then(Value::as_object).cloned() {
        for (slot, path) in files {
            if let Some(source) = path.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                payload[&slot] = json!(source_media_url(config, &key, source)?);
            }
        }
    }
    let wait = args
        .get("wait")
        .and_then(Value::as_u64)
        .unwrap_or(RUN_WAIT_SECS)
        .clamp(30, 1800);

    let (status_url, response_url) = queue_submit(&key, model, &payload)?;
    queue_wait(&key, &status_url, wait)?;
    let result = fetch_result(&key, &response_url)?;

    let urls = extract_media_urls(&result);
    let stamp = chrono_free_stamp();
    let output = str_arg(args, "output").map(ToOwned::to_owned);
    let mut saved = Vec::new();
    for (index, url) in urls.iter().enumerate() {
        let out = match (&output, urls.len()) {
            (Some(path), 1) if path.contains('.') => resolve_output(config, path),
            (Some(dirish), _) => {
                let dir = dirish.trim_end_matches('/');
                // A single output file name with several results keeps the name
                // for the first and suffixes the rest.
                if dirish.contains('.') && index == 0 {
                    resolve_output(config, dirish)
                } else if dirish.contains('.') {
                    let dot = dirish.rfind('.').unwrap_or(dirish.len());
                    resolve_output(
                        config,
                        &format!("{}-{}{}", &dirish[..dot], index + 1, &dirish[dot..]),
                    )
                } else {
                    resolve_output(
                        config,
                        &format!("{dir}/fal-run-{stamp}-{}{}", index + 1, url_extension(url)),
                    )
                }
            }
            (None, _) => resolve_output(
                config,
                &format!(
                    "fal-media/fal-run-{stamp}-{}{}",
                    index + 1,
                    url_extension(url)
                ),
            ),
        };
        download(url, &out)?;
        saved.push(out.display().to_string());
    }
    let mut summary = result.to_string();
    if summary.len() > 800 {
        summary.truncate(800);
        summary.push_str("…");
    }
    if saved.is_empty() {
        return Ok(format!(
            "fal_run {model} finished (no media in result):\n{summary}"
        ));
    }
    Ok(format!(
        "fal_run {model} finished — saved:\n{}\nresult: {summary}",
        saved.join("\n")
    ))
}

fn fal_image(config: &AppConfig, args: &Value) -> Result<String> {
    let prompt = required_prompt(args)?;
    let key = fal_key(config)?;
    let source = str_arg(args, "image").or_else(|| str_arg(args, "image_path"));
    let model = str_arg(args, "model").unwrap_or(if source.is_some() {
        DEFAULT_IMAGE_EDIT_MODEL
    } else {
        DEFAULT_IMAGE_MODEL
    });
    let num_images = args
        .get("num_images")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, 4);

    let mut payload = json!({
        "prompt": prompt,
        "num_images": num_images,
        "image_size": parse_image_size(str_arg(args, "image_size")),
    });
    // flux defaults to jpeg output; ask for png so the bytes match the .png
    // path the caller pre-decided. Only for our default flux models — a
    // user-picked model may not know the field.
    if str_arg(args, "model").is_none() {
        payload["output_format"] = json!("png");
    }
    if let Some(seed) = args.get("seed").and_then(Value::as_u64) {
        payload["seed"] = json!(seed);
    }
    if let Some(source) = source {
        payload["image_url"] = json!(source_media_url(config, &key, source)?);
    }

    let (status_url, response_url) = queue_submit(&key, model, &payload)?;
    queue_wait(&key, &status_url, IMAGE_WAIT_SECS)?;
    let result = fetch_result(&key, &response_url)?;

    let images = result["images"]
        .as_array()
        .cloned()
        .or_else(|| {
            result["image"]
                .as_object()
                .map(|obj| vec![Value::Object(obj.clone())])
        })
        .filter(|list| !list.is_empty())
        .ok_or_else(|| anyhow!("fal returned no images: {result}"))?;

    let stamp = chrono_free_stamp();
    let output = str_arg(args, "output").map(ToOwned::to_owned);
    let mut saved = Vec::new();
    for (index, image) in images.iter().enumerate() {
        let Some(url) = image["url"].as_str() else {
            continue;
        };
        let out = match (&output, images.len()) {
            (Some(path), 1) if path.contains('.') => resolve_output(config, path),
            (Some(dirish), _) => {
                let dir = dirish.trim_end_matches('/');
                resolve_output(
                    config,
                    &format!("{dir}/fal-image-{stamp}-{}.png", index + 1),
                )
            }
            (None, _) => resolve_output(
                config,
                &format!("fal-media/fal-image-{stamp}-{}.png", index + 1),
            ),
        };
        download(url, &out)?;
        let dims = match (image["width"].as_u64(), image["height"].as_u64()) {
            (Some(w), Some(h)) => format!(" ({w}x{h})"),
            _ => String::new(),
        };
        saved.push(format!("{}{dims}", out.display()));
    }
    if saved.is_empty() {
        bail!("fal images had no downloadable url: {result}");
    }
    let seed = result["seed"]
        .as_u64()
        .map(|seed| format!("\nseed: {seed}"))
        .unwrap_or_default();
    Ok(format!(
        "Generated {} image(s) with {model}:\n{}{seed}",
        saved.len(),
        saved.join("\n")
    ))
}

fn fal_video(config: &AppConfig, args: &Value) -> Result<String> {
    let prompt = required_prompt(args)?;
    let key = fal_key(config)?;
    let source = str_arg(args, "image").or_else(|| str_arg(args, "image_path"));
    let model = str_arg(args, "model").unwrap_or(if source.is_some() {
        DEFAULT_IMAGE_TO_VIDEO_MODEL
    } else {
        DEFAULT_TEXT_TO_VIDEO_MODEL
    });
    let motion = str_arg(args, "camera_motion");
    if let Some(motion) = motion
        && camera_motion_phrase(motion).is_none()
    {
        bail!(
            "unknown camera_motion '{motion}' — use one of: {}",
            camera_motion_keys()
        );
    }
    let effects = str_arg(args, "effect").or_else(|| str_arg(args, "effects"));
    if let Some(effects) = effects {
        for effect in effects.split(',') {
            if vfx_effect_phrase(effect).is_none() {
                bail!(
                    "unknown effect '{}' — use one of: {}",
                    effect.trim(),
                    vfx_effect_keys()
                );
            }
        }
    }
    let duration = str_arg(args, "duration").unwrap_or("5");
    if !matches!(duration, "5" | "10") {
        bail!("duration must be \"5\" or \"10\" (seconds)");
    }
    let aspect = str_arg(args, "aspect_ratio").unwrap_or("16:9");

    let image_url = source
        .map(|source| source_media_url(config, &key, source))
        .transpose()?;
    let end_source = str_arg(args, "end_image").or_else(|| str_arg(args, "end_image_path"));
    if end_source.is_some() && !model.contains("kling-video") {
        bail!(
            "end_image (start/end frame) is only supported by Kling models — drop it or use a kling-video model"
        );
    }
    let end_image_url = end_source
        .map(|source| source_media_url(config, &key, source))
        .transpose()?;
    let payload = build_video_payload(
        model,
        prompt,
        motion,
        effects,
        duration,
        aspect,
        str_arg(args, "negative_prompt"),
        image_url.as_deref(),
        end_image_url.as_deref(),
    );

    let (status_url, response_url) = queue_submit(&key, model, &payload)?;
    queue_wait(&key, &status_url, VIDEO_WAIT_SECS)?;
    let result = fetch_result(&key, &response_url)?;

    let url = result["video"]["url"]
        .as_str()
        .or_else(|| result["videos"][0]["url"].as_str())
        .or_else(|| result["url"].as_str())
        .ok_or_else(|| anyhow!("fal returned no video url: {result}"))?;

    let out = match str_arg(args, "output") {
        Some(path) if path.contains('.') => resolve_output(config, path),
        Some(dirish) => resolve_output(
            config,
            &format!(
                "{}/fal-video-{}.mp4",
                dirish.trim_end_matches('/'),
                chrono_free_stamp()
            ),
        ),
        None => resolve_output(
            config,
            &format!("fal-media/fal-video-{}.mp4", chrono_free_stamp()),
        ),
    };
    let bytes = download(url, &out)?;
    Ok(format!(
        "Generated video with {model} ({duration}s, {aspect}{}):\n{} ({:.1}MB)",
        motion.map(|m| format!(", camera: {m}")).unwrap_or_default(),
        out.display(),
        bytes as f64 / (1024.0 * 1024.0)
    ))
}

/// Second-resolution unique-enough stamp without pulling in chrono.
fn chrono_free_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camera_motion_lookup_normalizes_and_rejects_unknown() {
        assert!(camera_motion_phrase("crash_zoom_in").is_some());
        assert!(camera_motion_phrase("Crash Zoom-In").is_some());
        assert!(camera_motion_phrase("360 Orbit").is_some());
        assert!(camera_motion_phrase("snorricam").is_some());
        assert!(camera_motion_phrase("does_not_exist").is_none());
    }

    #[test]
    fn preset_tables_have_unique_keys() {
        for table in [CAMERA_MOTIONS, VFX_EFFECTS] {
            let mut keys: Vec<&str> = table.iter().map(|(k, _)| *k).collect();
            let total = keys.len();
            keys.sort_unstable();
            keys.dedup();
            assert_eq!(keys.len(), total);
        }
    }

    #[test]
    fn video_prompt_appends_effects_then_camera_direction() {
        let out = build_video_prompt(
            "a red fox running.",
            Some("dolly_in"),
            Some("set_on_fire, thunder_god"),
        );
        assert!(out.starts_with("a red fox running."));
        let effect_pos = out.find("Effect:").unwrap();
        let camera_pos = out.find("Camera movement:").unwrap();
        assert!(effect_pos < camera_pos);
        assert!(out.contains("lightning strikes"));
        assert_eq!(build_video_prompt("a red fox", None, None), "a red fox.");
    }

    #[test]
    fn image_size_parses_dimensions_and_passes_presets() {
        assert_eq!(
            parse_image_size(Some("1024x768")),
            json!({"width": 1024, "height": 768})
        );
        assert_eq!(
            parse_image_size(Some("landscape_16_9")),
            json!("landscape_16_9")
        );
        assert_eq!(parse_image_size(None), json!("square_hd"));
        assert_eq!(parse_image_size(Some("99999x2")), json!("square_hd"));
    }

    #[test]
    fn queue_urls_use_base_app_id_for_subpath_models() {
        let (status, response) =
            queue_urls("fal-ai/kling-video/v1.6/standard/image-to-video", "abc123");
        assert_eq!(
            status,
            "https://queue.fal.run/fal-ai/kling-video/requests/abc123/status"
        );
        assert_eq!(
            response,
            "https://queue.fal.run/fal-ai/kling-video/requests/abc123"
        );
    }

    #[test]
    fn video_payload_shapes_params_per_model_family() {
        let kling = build_video_payload(
            "fal-ai/kling-video/v1.6/pro/text-to-video",
            "a fox",
            Some("dolly_in"),
            None,
            "10",
            "9:16",
            Some("blurry"),
            None,
            Some("data:image/png;base64,end"),
        );
        assert_eq!(kling["duration"], json!("10"));
        assert_eq!(kling["aspect_ratio"], json!("9:16"));
        assert_eq!(kling["negative_prompt"], json!("blurry"));
        assert_eq!(kling["tail_image_url"], json!("data:image/png;base64,end"));

        let veo = build_video_payload(
            "fal-ai/veo2",
            "a fox",
            None,
            None,
            "10",
            "16:9",
            None,
            None,
            None,
        );
        assert_eq!(veo["duration"], json!("8s"));
        assert_eq!(veo["aspect_ratio"], json!("16:9"));
        assert!(veo.get("negative_prompt").is_none());

        let minimax = build_video_payload(
            "fal-ai/minimax/video-01/image-to-video",
            "a fox",
            None,
            None,
            "5",
            "16:9",
            None,
            Some("data:image/png;base64,xx"),
            None,
        );
        assert!(minimax.get("duration").is_none());
        assert!(minimax.get("aspect_ratio").is_none());
        assert_eq!(minimax["image_url"], json!("data:image/png;base64,xx"));
        assert!(minimax.get("tail_image_url").is_none());
    }

    #[test]
    fn data_uri_mime_matches_extension() {
        assert_eq!(data_uri_mime("photo.JPG"), "image/jpeg");
        assert_eq!(data_uri_mime("frame.webp"), "image/webp");
        assert_eq!(data_uri_mime("shot.png"), "image/png");
        assert_eq!(data_uri_mime("speech.mp3"), "audio/mpeg");
        assert_eq!(data_uri_mime("clip.mp4"), "video/mp4");
        assert_eq!(data_uri_mime("noext"), "image/png");
    }

    #[test]
    fn media_urls_are_collected_from_nested_results_in_order() {
        let result = json!({
            "video": {"url": "https://x/clip.mp4"},
            "images": [{"url": "https://x/a.png"}, {"url": "https://x/a.png"}],
            "audio_url": "https://x/voice.mp3",
            "meta": {"page_url": "not-http-key-ok", "nested": {"url": "https://x/b.webp"}},
            "id": "https://x/ignored-not-url-key"
        });
        let urls = extract_media_urls(&result);
        assert!(urls.contains(&"https://x/clip.mp4".to_string()));
        assert!(urls.contains(&"https://x/a.png".to_string()));
        assert!(urls.contains(&"https://x/voice.mp3".to_string()));
        assert!(urls.contains(&"https://x/b.webp".to_string()));
        assert_eq!(
            urls.iter()
                .filter(|u| u.as_str() == "https://x/a.png")
                .count(),
            1
        );
        assert!(!urls.iter().any(|u| u.contains("ignored")));
    }

    #[test]
    fn url_extension_strips_queries_and_falls_back() {
        assert_eq!(url_extension("https://x/a.mp4?token=1"), ".mp4");
        assert_eq!(url_extension("https://x/voice.MP3"), ".mp3");
        assert_eq!(url_extension("https://x/blob"), ".bin");
    }
}
