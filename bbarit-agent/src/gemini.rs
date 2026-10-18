//! Google Gemini API tools — Nano Banana image generation/editing, Veo video,
//! Lyria RealTime music, and Google-Search-grounded answers. The key comes
//! from /gemini <key> (stored via auth), the GEMINI_API_KEY / GOOGLE_API_KEY
//! env vars, or ~/.config/octo/.env.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};

use crate::config::AppConfig;

const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";
const MUSIC_WS_URL: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic";

pub const DEFAULT_IMAGE_MODEL: &str = "gemini-2.5-flash-image";
pub const DEFAULT_VIDEO_MODEL: &str = "veo-3.0-fast-generate-001";
pub const DEFAULT_SEARCH_MODEL: &str = "gemini-2.5-flash";
pub const MUSIC_MODEL: &str = "models/lyria-realtime-exp";

const VIDEO_WAIT_SECS: u64 = 600;
const VIDEO_POLL_SECS: u64 = 5;
/// Lyria RealTime output format: 16-bit PCM, 48 kHz, stereo.
const MUSIC_SAMPLE_RATE: u32 = 48_000;
const MUSIC_CHANNELS: u16 = 2;
const MUSIC_BYTES_PER_SEC: usize = 48_000 * 2 * 2;
const MUSIC_DEFAULT_SECS: u64 = 30;
const MUSIC_MAX_SECS: u64 = 120;

pub fn execute(config: &AppConfig, name: &str, args: &Value) -> Result<String> {
    match name {
        "gemini_image" => gemini_image(config, args),
        "gemini_video" => gemini_video(config, args),
        "gemini_music" => gemini_music(config, args),
        "google_search" => google_search(config, args),
        _ => bail!("unknown gemini tool: {name}"),
    }
}

/// True when a Gemini key is resolvable — used by /gemini status output.
pub fn key_available(config: &AppConfig) -> bool {
    gemini_key(config).is_ok()
}

use crate::config::octo_env_var as env_var;

fn gemini_key(config: &AppConfig) -> Result<String> {
    if let Ok(Some(key)) = crate::auth::stored_api_key(config, "gemini")
        && !key.trim().is_empty()
    {
        return Ok(key);
    }
    for var in ["GEMINI_API_KEY", "GOOGLE_API_KEY"] {
        if let Some(value) = env_var(var) {
            return Ok(value);
        }
    }
    bail!(
        "no Gemini API key found — run /gemini <key>, or set GEMINI_API_KEY in the \
         environment or ~/.config/octo/.env (get one at https://aistudio.google.com/apikey)"
    )
}

/// 카테고리별 모델 프리셋: (별칭, 모델 id, 설명). /gemini model에서 별칭으로
/// 고르거나 모델 id를 그대로 넣을 수 있다.
pub const MODEL_PRESETS: &[(&str, &str, &str, &str)] = &[
    (
        "image",
        "nanobanana",
        "gemini-2.5-flash-image",
        "Nano Banana — fast, default",
    ),
    (
        "image",
        "nanobanana-pro",
        "gemini-3-pro-image-preview",
        "Nano Banana Pro — highest quality",
    ),
    (
        "video",
        "veo3-fast",
        "veo-3.0-fast-generate-001",
        "Veo 3 Fast — default",
    ),
    (
        "video",
        "veo3",
        "veo-3.0-generate-001",
        "Veo 3 — higher quality",
    ),
    (
        "video",
        "veo31-fast",
        "veo-3.1-fast-generate-preview",
        "Veo 3.1 Fast (preview)",
    ),
    (
        "video",
        "veo31",
        "veo-3.1-generate-preview",
        "Veo 3.1 (preview)",
    ),
    (
        "search",
        "flash",
        "gemini-2.5-flash",
        "Gemini 2.5 Flash — default",
    ),
    (
        "search",
        "flash-lite",
        "gemini-2.5-flash-lite",
        "Gemini 2.5 Flash-Lite — cheapest",
    ),
    (
        "search",
        "pro",
        "gemini-2.5-pro",
        "Gemini 2.5 Pro — deepest answers",
    ),
];

fn model_env_var(category: &str) -> Option<&'static str> {
    match category {
        "image" => Some("GEMINI_IMAGE_MODEL"),
        "video" => Some("GEMINI_VIDEO_MODEL"),
        "search" => Some("GEMINI_SEARCH_MODEL"),
        _ => None,
    }
}

/// 별칭(nanobanana-pro 등)이면 모델 id로 풀고, 아니면 입력을 그대로 쓴다.
pub fn resolve_model_alias(category: &str, input: &str) -> String {
    let needle = input.trim().to_ascii_lowercase();
    MODEL_PRESETS
        .iter()
        .find(|(cat, alias, _, _)| *cat == category && *alias == needle)
        .map(|(_, _, id, _)| (*id).to_string())
        .unwrap_or_else(|| input.trim().to_string())
}

/// /gemini model로 저장된 카테고리 기본 모델 (env → ~/.config/octo/.env).
pub fn configured_model(category: &str) -> Option<String> {
    env_var(model_env_var(category)?)
}

/// 카테고리 기본 모델을 ~/.config/octo/.env에 저장한다. 빈 값/"default"는
/// 오버라이드 삭제. 저장된(또는 기본) 모델 id를 돌려준다.
pub fn set_configured_model(category: &str, model: &str) -> Result<String> {
    let var = model_env_var(category)
        .ok_or_else(|| anyhow!("unknown category '{category}' — use image, video, or search"))?;
    let clear = model.is_empty() || model.eq_ignore_ascii_case("default");
    let resolved = resolve_model_alias(category, model);
    crate::config::set_octo_env_var(var, (!clear).then_some(resolved.as_str()))?;
    Ok(if clear {
        default_model(category).to_string()
    } else {
        resolved
    })
}

/// 카테고리의 하드코딩 기본 모델.
pub fn default_model(category: &str) -> &'static str {
    match category {
        "image" => DEFAULT_IMAGE_MODEL,
        "video" => DEFAULT_VIDEO_MODEL,
        "search" => DEFAULT_SEARCH_MODEL,
        _ => "",
    }
}

/// 현재 유효한 카테고리 모델: 저장된 오버라이드 → 기본값.
pub fn effective_model(category: &str) -> String {
    configured_model(category).unwrap_or_else(|| default_model(category).to_string())
}

fn client(timeout_secs: u64) -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .user_agent("bbarit-agent")
        .build()?)
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn required_str<'a>(args: &'a Value, key: &str, usage: &str) -> Result<&'a str> {
    str_arg(args, key).ok_or_else(|| anyhow!("{usage}"))
}

fn resolve_output(config: &AppConfig, output: &str) -> PathBuf {
    let path = Path::new(output);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        config.cwd.join(path)
    }
}

/// Output path for a generated file: an explicit file path is used as-is, a
/// directory (or the gemini-media/ default) gets a timestamped name.
fn output_file(config: &AppConfig, args: &Value, extension: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    match str_arg(args, "output") {
        Some(output) => {
            let path = resolve_output(config, output);
            let is_dir_like = output.ends_with('/') || path.is_dir() || path.extension().is_none();
            if is_dir_like {
                path.join(format!("gemini-{stamp}.{extension}"))
            } else {
                path
            }
        }
        None => config
            .cwd
            .join("gemini-media")
            .join(format!("gemini-{stamp}.{extension}")),
    }
}

fn mime_for_path(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else {
        "image/png"
    }
}

/// Local path or URL → inlineData part for generateContent.
fn inline_image_part(config: &AppConfig, source: &str) -> Result<Value> {
    let trimmed = source.trim();
    let (bytes, mime) = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let response = client(60)?.get(trimmed).send()?.error_for_status()?;
        let mime = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/png")
            .split(';')
            .next()
            .unwrap_or("image/png")
            .to_string();
        (response.bytes()?.to_vec(), mime)
    } else {
        let path = resolve_output(config, trimmed);
        let bytes = std::fs::read(&path)
            .map_err(|e| anyhow!("cannot read image {}: {e}", path.display()))?;
        (bytes, mime_for_path(trimmed).to_string())
    };
    Ok(json!({ "inlineData": { "mimeType": mime, "data": BASE64.encode(bytes) } }))
}

/// generateContent 요청 본문 (이미지 생성/편집). 순수 함수 — 테스트 대상.
pub fn build_image_request(prompt: &str, image_parts: Vec<Value>) -> Value {
    let mut parts = image_parts;
    parts.push(json!({ "text": prompt }));
    json!({
        "contents": [{ "parts": parts }],
        "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] }
    })
}

/// 응답에서 inlineData 이미지들(base64, mime)을 수집. 순수 함수 — 테스트 대상.
pub fn collect_inline_images(body: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let parts = body["candidates"]
        .as_array()
        .and_then(|c| c.first())
        .map(|c| &c["content"]["parts"]);
    if let Some(parts) = parts.and_then(Value::as_array) {
        for part in parts {
            let data = part["inlineData"]["data"].as_str();
            let mime = part["inlineData"]["mimeType"]
                .as_str()
                .unwrap_or("image/png");
            if let Some(data) = data {
                out.push((data.to_string(), mime.to_string()));
            }
        }
    }
    out
}

/// Nano Banana 이미지 생성/편집: 프롬프트(+선택 소스 이미지) → PNG 저장.
fn gemini_image(config: &AppConfig, args: &Value) -> Result<String> {
    let key = gemini_key(config)?;
    let prompt = required_str(args, "prompt", "gemini_image requires a 'prompt'")?;
    let model = str_arg(args, "model")
        .map(|m| resolve_model_alias("image", m))
        .unwrap_or_else(|| effective_model("image"));
    let model = model.as_str();
    let mut image_parts = Vec::new();
    if let Some(source) = str_arg(args, "image") {
        image_parts.push(inline_image_part(config, source)?);
    }
    let body = build_image_request(prompt, image_parts);
    let response = client(180)?
        .post(format!("{API_BASE}/models/{model}:generateContent"))
        .header("x-goog-api-key", &key)
        .json(&body)
        .send()?;
    let status = response.status();
    let body: Value = response.json()?;
    if !status.is_success() {
        bail!("gemini image request failed ({status}): {body}");
    }
    let images = collect_inline_images(&body);
    if images.is_empty() {
        let text = body["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .unwrap_or("(no image and no text in the response)");
        bail!("gemini returned no image: {text}");
    }
    let mut saved = Vec::new();
    for (index, (data, mime)) in images.iter().enumerate() {
        let extension = if mime.contains("jpeg") { "jpg" } else { "png" };
        let mut path = output_file(config, args, extension);
        if index > 0 {
            let stem = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            path.set_file_name(format!("{stem}-{index}.{extension}"));
        }
        let bytes = BASE64.decode(data.as_bytes())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, &bytes)?;
        saved.push(format!("{} ({} KB)", path.display(), bytes.len() / 1024));
    }
    Ok(format!(
        "Saved {} image(s) [{model}]:\n{}",
        saved.len(),
        saved.join("\n")
    ))
}

/// Veo predictLongRunning 요청 본문. 순수 함수 — 테스트 대상.
pub fn build_video_request(prompt: &str, args: &Value, image_part: Option<Value>) -> Value {
    let mut instance = json!({ "prompt": prompt });
    if let Some(image) = image_part {
        instance["image"] = image["inlineData"].clone();
    }
    let mut parameters = json!({});
    if let Some(aspect) = str_arg(args, "aspect_ratio") {
        parameters["aspectRatio"] = json!(aspect);
    }
    if let Some(negative) = str_arg(args, "negative_prompt") {
        parameters["negativePrompt"] = json!(negative);
    }
    json!({ "instances": [instance], "parameters": parameters })
}

/// 완료된 오퍼레이션 응답에서 비디오 URI들을 수집 (generatedSamples /
/// generatedVideos 등 응답 셰이프 차이를 흡수하는 재귀 walk). 순수 함수.
pub fn collect_video_uris(value: &Value) -> Vec<String> {
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (k, v) in map {
                    if k == "uri"
                        && let Some(uri) = v.as_str()
                        && uri.starts_with("http")
                        && !out.iter().any(|existing| existing == uri)
                    {
                        out.push(uri.to_string());
                    }
                    walk(v, out);
                }
            }
            Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(value, &mut out);
    out
}

/// Veo 영상 생성: predictLongRunning → 폴링 → 다운로드.
fn gemini_video(config: &AppConfig, args: &Value) -> Result<String> {
    let key = gemini_key(config)?;
    let prompt = required_str(args, "prompt", "gemini_video requires a 'prompt'")?;
    let model = str_arg(args, "model")
        .map(|m| resolve_model_alias("video", m))
        .unwrap_or_else(|| effective_model("video"));
    let model = model.as_str();
    let image_part = match str_arg(args, "image") {
        Some(source) => Some(inline_image_part(config, source)?),
        None => None,
    };
    let body = build_video_request(prompt, args, image_part);
    let response = client(120)?
        .post(format!("{API_BASE}/models/{model}:predictLongRunning"))
        .header("x-goog-api-key", &key)
        .json(&body)
        .send()?;
    let status = response.status();
    let submitted: Value = response.json()?;
    if !status.is_success() {
        bail!("gemini video submit failed ({status}): {submitted}");
    }
    let operation = submitted["name"]
        .as_str()
        .ok_or_else(|| anyhow!("gemini video submit returned no operation name: {submitted}"))?
        .to_string();

    crate::llm::emit_activity(&format!("\n⚙ gemini_video: rendering with {model}…\n"));
    let started = Instant::now();
    let done = loop {
        std::thread::sleep(Duration::from_secs(VIDEO_POLL_SECS));
        let poll = client(60)?
            .get(format!("{API_BASE}/{operation}"))
            .header("x-goog-api-key", &key)
            .send()?;
        let poll_status = poll.status();
        let body: Value = poll.json()?;
        if !poll_status.is_success() {
            bail!("gemini video poll failed ({poll_status}): {body}");
        }
        if let Some(error) = body.get("error").filter(|e| !e.is_null()) {
            bail!("gemini video generation failed: {error}");
        }
        if body["done"].as_bool() == Some(true) {
            break body;
        }
        if started.elapsed() > Duration::from_secs(VIDEO_WAIT_SECS) {
            bail!("gemini video still rendering after {VIDEO_WAIT_SECS}s — try again later");
        }
    };
    let uris = collect_video_uris(&done);
    if uris.is_empty() {
        bail!("gemini video finished but returned no downloadable uri: {done}");
    }
    let mut saved = Vec::new();
    for (index, uri) in uris.iter().enumerate() {
        let mut path = output_file(config, args, "mp4");
        if index > 0 {
            let stem = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            path.set_file_name(format!("{stem}-{index}.mp4"));
        }
        // 반환 URI는 API 키가 있어야 받아진다 — 헤더와 쿼리 둘 다 지원.
        let bytes = client(300)?
            .get(uri)
            .header("x-goog-api-key", &key)
            .send()?
            .error_for_status()?
            .bytes()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, &bytes)?;
        saved.push(format!(
            "{} ({:.1} MB)",
            path.display(),
            bytes.len() as f64 / 1_048_576.0
        ));
    }
    Ok(format!(
        "Saved {} video(s) [{model}]:\n{}",
        saved.len(),
        saved.join("\n")
    ))
}

/// 16-bit PCM → WAV 파일 바이트 (44바이트 표준 헤더). 순수 함수 — 테스트 대상.
pub fn wav_from_pcm(pcm: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
    let byte_rate = sample_rate * u32::from(channels) * 2;
    let block_align = channels * 2;
    let data_len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// Lyria RealTime 음악 생성 (실험적): WebSocket으로 프롬프트를 보내고 원하는
/// 길이만큼 PCM 청크를 모아 WAV로 저장한다.
fn gemini_music(config: &AppConfig, args: &Value) -> Result<String> {
    use tungstenite::Message;
    let key = gemini_key(config)?;
    let prompt = required_str(args, "prompt", "gemini_music requires a 'prompt'")?;
    let duration_secs = args
        .get("duration_secs")
        .and_then(Value::as_u64)
        .unwrap_or(MUSIC_DEFAULT_SECS)
        .clamp(5, MUSIC_MAX_SECS);
    let target_bytes = duration_secs as usize * MUSIC_BYTES_PER_SEC;

    let url = format!("{MUSIC_WS_URL}?key={key}");
    let (mut socket, _response) =
        tungstenite::connect(&url).map_err(|e| anyhow!("gemini music connect failed: {e}"))?;

    socket.send(Message::Text(
        json!({ "setup": { "model": MUSIC_MODEL } }).to_string(),
    ))?;
    let mut prompts = vec![json!({ "text": prompt, "weight": 1.0 })];
    if let Some(extra) = args.get("prompts").and_then(Value::as_array) {
        for item in extra {
            if let Some(text) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                prompts.push(json!({ "text": text, "weight": 1.0 }));
            }
        }
    }
    socket.send(Message::Text(
        json!({ "clientContent": { "weightedPrompts": prompts } }).to_string(),
    ))?;
    let mut generation_config = json!({});
    if let Some(bpm) = args.get("bpm").and_then(Value::as_u64) {
        generation_config["bpm"] = json!(bpm.clamp(60, 200));
    }
    if generation_config.as_object().is_some_and(|m| !m.is_empty()) {
        socket.send(Message::Text(
            json!({ "musicGenerationConfig": generation_config }).to_string(),
        ))?;
    }
    socket.send(Message::Text(
        json!({ "playbackControl": "PLAY" }).to_string(),
    ))?;

    crate::llm::emit_activity(&format!(
        "\n⚙ gemini_music: streaming {duration_secs}s of audio…\n"
    ));
    let mut pcm: Vec<u8> = Vec::with_capacity(target_bytes);
    let started = Instant::now();
    while pcm.len() < target_bytes {
        if started.elapsed() > Duration::from_secs(duration_secs + 90) {
            bail!(
                "gemini music timed out with {:.1}s of audio collected",
                pcm.len() as f64 / MUSIC_BYTES_PER_SEC as f64
            );
        }
        let message = socket.read()?;
        let text = match message {
            Message::Text(text) => text,
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).to_string(),
            Message::Close(frame) => bail!("gemini music stream closed early: {frame:?}"),
            _ => continue,
        };
        let frame: Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if let Some(error) = frame.get("error").filter(|e| !e.is_null()) {
            bail!("gemini music error: {error}");
        }
        if let Some(chunks) = frame["serverContent"]["audioChunks"].as_array() {
            for chunk in chunks {
                if let Some(data) = chunk["data"].as_str()
                    && let Ok(bytes) = BASE64.decode(data.as_bytes())
                {
                    pcm.extend_from_slice(&bytes);
                }
            }
        }
    }
    pcm.truncate(target_bytes);
    let _ = socket.send(Message::Text(
        json!({ "playbackControl": "STOP" }).to_string(),
    ));
    let _ = socket.close(None);

    let path = output_file(config, args, "wav");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let wav = wav_from_pcm(&pcm, MUSIC_SAMPLE_RATE, MUSIC_CHANNELS);
    let mut file = std::fs::File::create(&path)?;
    file.write_all(&wav)?;
    Ok(format!(
        "Saved {duration_secs}s of music to {} ({:.1} MB, 48kHz stereo WAV)",
        path.display(),
        wav.len() as f64 / 1_048_576.0
    ))
}

/// 검색 응답에서 (답변 텍스트, 출처 목록)을 추출. 순수 함수 — 테스트 대상.
pub fn parse_search_response(body: &Value) -> (String, Vec<String>) {
    let mut text = String::new();
    if let Some(parts) = body["candidates"][0]["content"]["parts"].as_array() {
        for part in parts {
            if let Some(chunk) = part["text"].as_str() {
                text.push_str(chunk);
            }
        }
    }
    let mut sources = Vec::new();
    if let Some(chunks) = body["candidates"][0]["groundingMetadata"]["groundingChunks"].as_array() {
        for chunk in chunks {
            let uri = chunk["web"]["uri"].as_str().unwrap_or("");
            if uri.is_empty() {
                continue;
            }
            let title = chunk["web"]["title"].as_str().unwrap_or(uri);
            let line = format!("{title} — {uri}");
            if !sources.contains(&line) {
                sources.push(line);
            }
        }
    }
    (text, sources)
}

/// Google 검색 그라운딩 답변: gemini에 google_search 툴을 붙여 질의.
fn google_search(config: &AppConfig, args: &Value) -> Result<String> {
    let key = gemini_key(config)?;
    let query = str_arg(args, "query")
        .or_else(|| str_arg(args, "prompt"))
        .ok_or_else(|| anyhow!("google_search requires a 'query'"))?;
    let model = str_arg(args, "model")
        .map(|m| resolve_model_alias("search", m))
        .unwrap_or_else(|| effective_model("search"));
    let body = json!({
        "contents": [{ "parts": [{ "text": query }] }],
        "tools": [{ "google_search": {} }]
    });
    let response = client(90)?
        .post(format!("{API_BASE}/models/{model}:generateContent"))
        .header("x-goog-api-key", &key)
        .json(&body)
        .send()?;
    let status = response.status();
    let body: Value = response.json()?;
    if !status.is_success() {
        bail!("google_search failed ({status}): {body}");
    }
    let (text, sources) = parse_search_response(&body);
    if text.is_empty() {
        bail!("google_search returned no answer: {body}");
    }
    if sources.is_empty() {
        Ok(text)
    } else {
        Ok(format!("{text}\n\nSources:\n- {}", sources.join("\n- ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_image_request_puts_source_image_before_prompt() {
        let part = json!({ "inlineData": { "mimeType": "image/png", "data": "QUJD" } });
        let body = build_image_request("고양이", vec![part]);
        let parts = body["contents"][0]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["inlineData"]["mimeType"], "image/png");
        assert_eq!(parts[1]["text"], "고양이");
        assert_eq!(body["generationConfig"]["responseModalities"][1], "IMAGE");
    }

    #[test]
    fn collect_inline_images_reads_candidate_parts() {
        let body = json!({
            "candidates": [{ "content": { "parts": [
                { "text": "here you go" },
                { "inlineData": { "mimeType": "image/png", "data": "QUJD" } }
            ]}}]
        });
        assert_eq!(
            collect_inline_images(&body),
            vec![("QUJD".to_string(), "image/png".to_string())]
        );
    }

    #[test]
    fn collect_video_uris_handles_both_operation_shapes() {
        let samples = json!({ "response": { "generateVideoResponse": { "generatedSamples": [
            { "video": { "uri": "https://example.com/a.mp4" } }
        ]}}});
        let videos = json!({ "response": { "generatedVideos": [
            { "video": { "uri": "https://example.com/b.mp4" } }
        ]}});
        assert_eq!(
            collect_video_uris(&samples),
            vec!["https://example.com/a.mp4"]
        );
        assert_eq!(
            collect_video_uris(&videos),
            vec!["https://example.com/b.mp4"]
        );
    }

    #[test]
    fn wav_header_encodes_rate_channels_and_length() {
        let pcm = vec![0u8; 192_000]; // 0.5s of 48kHz stereo 16-bit
        let wav = wav_from_pcm(&pcm, 48_000, 2);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 48_000);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 2);
        assert_eq!(
            u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize,
            pcm.len()
        );
        assert_eq!(wav.len(), 44 + pcm.len());
    }

    #[test]
    fn resolve_model_alias_maps_presets_and_passes_raw_ids() {
        assert_eq!(
            resolve_model_alias("image", "nanobanana-pro"),
            "gemini-3-pro-image-preview"
        );
        assert_eq!(resolve_model_alias("video", "VEO3"), "veo-3.0-generate-001");
        assert_eq!(resolve_model_alias("search", "pro"), "gemini-2.5-pro");
        // 다른 카테고리의 별칭·미지의 입력은 그대로 통과
        assert_eq!(resolve_model_alias("image", "veo3"), "veo3");
        assert_eq!(
            resolve_model_alias("image", "gemini-9-custom"),
            "gemini-9-custom"
        );
    }

    #[test]
    fn default_model_per_category() {
        assert_eq!(default_model("image"), DEFAULT_IMAGE_MODEL);
        assert_eq!(default_model("video"), DEFAULT_VIDEO_MODEL);
        assert_eq!(default_model("search"), DEFAULT_SEARCH_MODEL);
    }

    #[test]
    fn parse_search_response_extracts_text_and_dedupes_sources() {
        let body = json!({ "candidates": [{
            "content": { "parts": [{ "text": "답변 " }, { "text": "본문" }] },
            "groundingMetadata": { "groundingChunks": [
                { "web": { "uri": "https://a.com", "title": "A" } },
                { "web": { "uri": "https://a.com", "title": "A" } },
                { "web": { "uri": "https://b.com", "title": "B" } }
            ]}
        }]});
        let (text, sources) = parse_search_response(&body);
        assert_eq!(text, "답변 본문");
        assert_eq!(sources, vec!["A — https://a.com", "B — https://b.com"]);
    }
}
