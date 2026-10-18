use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct ClaudeDesignGenerateRequest {
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub aspect_ratio: String,
    #[serde(default)]
    pub brand_name: String,
    #[serde(default)]
    pub brand_colors: Vec<String>,
    #[serde(default)]
    pub business_type: String,
    #[serde(default)]
    pub business_description: String,
    #[serde(default)]
    pub cta_text: String,
    #[serde(default)]
    pub design_rules: String,
    #[serde(default)]
    pub design_style: String,
    #[serde(default)]
    pub design_purpose: String,
    #[serde(default)]
    pub design_density: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Serialize)]
pub struct ClaudeDesignGenerateResponse {
    pub status: String,
    pub html: String,
    pub provider: String,
    pub model: String,
}

fn first_non_empty(a: &str, b: &str) -> String {
    let s = a.trim();
    if !s.is_empty() {
        s.to_string()
    } else {
        b.trim().to_string()
    }
}

fn canvas_size(aspect: &str) -> &'static str {
    match aspect {
        "9:16" => "1080x1920px (세로형)",
        "1:1" => "1080x1080px (정방형)",
        "4:3" => "1600x1200px (문서형)",
        "A4" => "1240x1754px (A4 인쇄)",
        _ => "1920x1080px (16:9 가로형)",
    }
}

pub fn build_prompt(req: &ClaudeDesignGenerateRequest) -> String {
    let size = canvas_size(req.aspect_ratio.trim());
    let kind = first_non_empty(&req.kind, "general");
    let brand_name = first_non_empty(&req.brand_name, "없음");
    let brand_colors = if req.brand_colors.is_empty() {
        "없음".to_string()
    } else {
        req.brand_colors.join(", ")
    };
    let business_type = first_non_empty(&req.business_type, "없음");
    let business_desc = first_non_empty(&req.business_description, "없음");
    let cta = first_non_empty(&req.cta_text, "없음");
    let rules = first_non_empty(&req.design_rules, "없음");
    let style = first_non_empty(&req.design_style, "auto");
    let purpose = first_non_empty(&req.design_purpose, "auto");
    let density = first_non_empty(&req.design_density, "balanced");

    format!(
        r#"[역할] 당신은 Canva급 마케팅 디자인을 HTML 하나로 만드는 시니어 프론트엔드 디자이너입니다.

[절대 출력 규칙]
- 설명, 마크다운, 코드펜스 없이 완전한 HTML 문서만 출력하세요.
- 반드시 <!DOCTYPE html>로 시작하고 </html>로 끝나야 합니다.
- CSS와 JavaScript는 HTML 안에 포함하세요.
- 로컬 파일 경로에 의존하지 마세요.
- 상대 이미지 경로, source.unsplash.com, via.placeholder.com을 쓰지 마세요.

[레이아웃 안전 규칙]
- 모든 주요 콘텐츠는 캔버스 안쪽 64px 이상 안전 여백 안에 완전히 보여야 합니다.
- 제목, 본문, CTA, 버튼 텍스트는 절대 잘리거나 캔버스 밖으로 나가면 안 됩니다.
- 한글 텍스트에는 word-break: keep-all; overflow-wrap: break-word; line-height: 1.08 이상을 적용하세요.
- 카드 내부에는 min-width: 0을 넣고, 긴 문장은 줄바꿈되게 하세요.

[요청]
{prompt}

[산출물]
- 형식: {kind}
- 캔버스: {size}
- 브랜드: {brand_name}
- 브랜드 색상: {brand_colors}
- 프로필 업종: {business_type}
- 비즈니스 설명: {business_desc}
- CTA: {cta}
- 상세 디자인 규칙: {rules}
- 스타일: {style}
- 목적: {purpose}
- 정보 밀도: {density}

[품질 기준]
- 첫 화면에서 바로 완성된 결과물이 보여야 합니다.
- 텍스트는 실제 DOM 텍스트로 유지해 사용자가 클릭 편집할 수 있게 하세요.
- 주요 블록에는 의미 있는 class 이름을 붙이세요.
- 주요 section, card, headline, paragraph, CTA, image에는 고유한 data-makeke-id를 붙이세요.
- 버튼, 카드, 이미지, 타이포 위계와 여백을 전문적으로 맞추세요.
"#,
        prompt = req.prompt
    )
}

pub fn extract_html(raw: &str) -> String {
    let trimmed = raw.trim();
    // Strip markdown code fences if present
    let stripped = if let Some(after) = trimmed.strip_prefix("```html") {
        after.trim_start().to_string()
    } else if let Some(after) = trimmed.strip_prefix("```") {
        after.trim_start().to_string()
    } else {
        trimmed.to_string()
    };
    let stripped = stripped
        .trim_end()
        .trim_end_matches("```")
        .trim()
        .to_string();

    let re = Regex::new(r"(?is)(<!DOCTYPE\s+html.*?</html>)").unwrap();
    if let Some(cap) = re.captures(&stripped) {
        return cap
            .get(1)
            .map(|m| m.as_str().to_string())
            .unwrap_or(stripped);
    }
    // Fallback: return as-is if it already starts with <html>
    if stripped.to_lowercase().starts_with("<!doctype")
        || stripped.to_lowercase().starts_with("<html")
    {
        return stripped;
    }
    String::new()
}

pub async fn call_gemini(prompt: &str, api_key: &str, model: &str) -> Result<String, String> {
    let model_id = if model.trim().is_empty() {
        "gemini-2.0-flash-exp"
    } else {
        model.trim()
    };
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model_id, api_key
    );
    let body = serde_json::json!({
        "contents": [{
            "role": "user",
            "parts": [{ "text": prompt }]
        }],
        "generationConfig": {
            "temperature": 0.85,
            "maxOutputTokens": 32768,
        }
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))?;
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {}", e))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Gemini body read failed: {}", e))?;
    if !status.is_success() {
        return Err(format!("Gemini API error {}: {}", status.as_u16(), text));
    }
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Gemini JSON parse failed: {}", e))?;
    let candidate_text = json
        .get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    if candidate_text.is_empty() {
        return Err(format!("Gemini empty response: {}", text));
    }
    Ok(candidate_text)
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct ClaudeDesignEditRequest {
    #[serde(default)]
    pub html: String,
    #[serde(default)]
    pub instruction: String,
    #[serde(default)]
    pub model: String,
}

pub fn build_edit_prompt(req: &ClaudeDesignEditRequest) -> String {
    format!(
        r#"[역할] HTML 디자인 편집자입니다.

[절대 출력 규칙]
- 설명 없이 수정된 완전한 HTML만 출력하세요.
- 반드시 <!DOCTYPE html>로 시작하고 </html>로 끝나야 합니다.
- 기존 HTML의 의도와 구조는 유지하되 사용자의 수정 지시를 반영하세요.
- 수정 후에도 제목/본문/CTA가 캔버스 밖으로 나가거나 잘리면 안 됩니다.
- 큰 글자는 clamp()로 제한하고, 한글은 word-break: keep-all; overflow-wrap: break-word를 유지하세요.

[수정 지시]
{instruction}

[현재 HTML]
{html}"#,
        instruction = req.instruction,
        html = req.html
    )
}

#[tauri::command]
pub async fn claude_design_edit(
    request: ClaudeDesignEditRequest,
    gemini_api_key: String,
) -> Result<ClaudeDesignGenerateResponse, String> {
    if request.html.trim().is_empty() || request.instruction.trim().is_empty() {
        return Err("수정할 HTML과 지시문이 필요합니다.".into());
    }
    let key = gemini_api_key.trim().to_string();
    if key.is_empty() {
        return Err("Gemini API 키가 설정되지 않았습니다.".into());
    }
    let prompt = build_edit_prompt(&request);
    let model = if request.model.trim().is_empty() {
        "gemini-2.0-flash-exp".to_string()
    } else {
        request.model.trim().to_string()
    };
    let raw_text = call_gemini(&prompt, &key, &model).await?;
    let html = extract_html(&raw_text);
    if html.is_empty() {
        return Err(format!(
            "모델 응답에서 HTML을 찾지 못했습니다. raw_text_len={}",
            raw_text.len()
        ));
    }
    Ok(ClaudeDesignGenerateResponse {
        status: "ok".into(),
        html,
        provider: "gemini".into(),
        model,
    })
}

// ─── History (save / list / load) ───

fn history_dir() -> Result<PathBuf, String> {
    let home = crate::common::resolve_home_dir()
        .ok_or_else(|| "HOME 디렉토리를 찾을 수 없습니다.".to_string())?;
    let dir = PathBuf::from(home)
        .join(".config")
        .join("octo")
        .join("designs");
    fs::create_dir_all(&dir).map_err(|e| format!("history dir create failed: {}", e))?;
    Ok(dir)
}

fn sanitize_name(s: &str) -> String {
    let cleaned: String = s
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "makeke-design".into()
    } else {
        cleaned
    }
}

fn unique_history_id(dir: &PathBuf, base: &str) -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut id = format!("{}-{}.html", base, ts);
    let mut suffix = 1;
    while dir.join(&id).exists() {
        id = format!("{}-{}-{}.html", base, ts, suffix);
        suffix += 1;
    }
    id
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct ClaudeDesignSaveRequest {
    #[serde(default)]
    pub html: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub aspect_ratio: String,
    #[serde(default)]
    pub prompt: String,
}

#[derive(Debug, Serialize)]
pub struct ClaudeDesignSaveResponse {
    pub status: String,
    pub id: String,
    pub name: String,
    pub file: String,
}

#[derive(Debug, Serialize)]
pub struct ClaudeDesignListItem {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub aspect_ratio: String,
    pub prompt: String,
    pub mtime: String,
    pub updated_at: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct ClaudeDesignListResponse {
    pub status: String,
    pub items: Vec<ClaudeDesignListItem>,
    pub folder: String,
}

#[tauri::command]
pub async fn claude_design_save(
    request: ClaudeDesignSaveRequest,
) -> Result<ClaudeDesignSaveResponse, String> {
    let html = request.html.trim().to_string();
    if html.is_empty() {
        return Err("html is required".into());
    }
    let dir = history_dir()?;
    let base = sanitize_name(if !request.name.trim().is_empty() {
        &request.name
    } else if !request.kind.trim().is_empty() {
        &request.kind
    } else {
        "makeke-design"
    });
    let id = if request.id.trim().is_empty() {
        unique_history_id(&dir, &base)
    } else {
        let raw = request.id.trim();
        if raw.ends_with(".html") {
            raw.to_string()
        } else {
            format!("{}.html", raw)
        }
    };
    let path = dir.join(&id);
    fs::write(&path, html.as_bytes()).map_err(|e| format!("write html failed: {}", e))?;

    let meta_path = dir.join(id.trim_end_matches(".html").to_string() + ".json");
    let now = chrono::Utc::now().to_rfc3339();
    let mut meta = if meta_path.exists() {
        fs::read_to_string(&meta_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    if !meta.contains_key("created_at") {
        meta.insert("created_at".into(), serde_json::Value::String(now.clone()));
    }
    meta.insert("updated_at".into(), serde_json::Value::String(now));
    meta.insert("id".into(), serde_json::Value::String(id.clone()));
    let display_name = if request.name.trim().is_empty() {
        id.trim_end_matches(".html").to_string()
    } else {
        request.name.trim().to_string()
    };
    meta.insert(
        "name".into(),
        serde_json::Value::String(display_name.clone()),
    );
    meta.insert(
        "kind".into(),
        serde_json::Value::String(request.kind.clone()),
    );
    meta.insert(
        "aspect_ratio".into(),
        serde_json::Value::String(request.aspect_ratio.clone()),
    );
    meta.insert(
        "prompt".into(),
        serde_json::Value::String(request.prompt.clone()),
    );
    meta.insert(
        "file".into(),
        serde_json::Value::String(path.to_string_lossy().to_string()),
    );
    let meta_json =
        serde_json::to_string_pretty(&meta).map_err(|e| format!("meta serialize failed: {}", e))?;
    fs::write(&meta_path, meta_json).map_err(|e| format!("write meta failed: {}", e))?;

    Ok(ClaudeDesignSaveResponse {
        status: "ok".into(),
        id,
        name: display_name,
        file: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn claude_design_list() -> Result<ClaudeDesignListResponse, String> {
    let dir = history_dir()?;
    let mut items: Vec<ClaudeDesignListItem> = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => {
            return Ok(ClaudeDesignListResponse {
                status: "ok".into(),
                items,
                folder: dir.to_string_lossy().to_string(),
            })
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let id = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) if n.to_lowercase().ends_with(".html") => n.to_string(),
            _ => continue,
        };
        let metadata = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = metadata.len();
        let mtime_secs = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mtime_str = chrono::DateTime::<chrono::Utc>::from_timestamp(mtime_secs as i64, 0)
            .map(|dt| {
                dt.with_timezone(&chrono::Local)
                    .format("%Y-%m-%d %H:%M")
                    .to_string()
            })
            .unwrap_or_default();
        let updated_at = chrono::DateTime::<chrono::Utc>::from_timestamp(mtime_secs as i64, 0)
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_default();

        let meta_path = dir.join(id.trim_end_matches(".html").to_string() + ".json");
        let meta: serde_json::Value = fs::read_to_string(&meta_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::Value::Null);
        let get_str = |key: &str| {
            meta.get(key)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };

        items.push(ClaudeDesignListItem {
            id: id.clone(),
            name: {
                let n = get_str("name");
                if n.is_empty() {
                    id.trim_end_matches(".html").to_string()
                } else {
                    n
                }
            },
            kind: get_str("kind"),
            aspect_ratio: get_str("aspect_ratio"),
            prompt: get_str("prompt"),
            mtime: mtime_str,
            updated_at,
            size,
        });
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(ClaudeDesignListResponse {
        status: "ok".into(),
        items,
        folder: dir.to_string_lossy().to_string(),
    })
}

// ─── Generic Gemini text generation (for blog/cardnews/SNS/etc.) ───

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct MakekeTextRequest {
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Serialize)]
pub struct MakekeTextResponse {
    pub status: String,
    pub text: String,
    pub provider: String,
    pub model: String,
}

#[tauri::command]
pub async fn makeke_text_generate(
    request: MakekeTextRequest,
    gemini_api_key: String,
) -> Result<MakekeTextResponse, String> {
    if request.prompt.trim().is_empty() {
        return Err("프롬프트가 필요합니다.".into());
    }
    let key = gemini_api_key.trim().to_string();
    if key.is_empty() {
        return Err("Gemini API 키가 설정되지 않았습니다.".into());
    }
    let model = if request.model.trim().is_empty() {
        "gemini-2.0-flash-exp".to_string()
    } else {
        request.model.trim().to_string()
    };
    let raw = call_gemini(&request.prompt, &key, &model).await?;
    Ok(MakekeTextResponse {
        status: "ok".into(),
        text: raw.trim().to_string(),
        provider: "gemini".into(),
        model,
    })
}

#[tauri::command]
pub async fn claude_design_load(id: String) -> Result<String, String> {
    let dir = history_dir()?;
    let safe_id: String = id
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | '\0'))
        .collect();
    let path = dir.join(&safe_id);
    fs::read_to_string(&path).map_err(|e| format!("load failed: {}", e))
}

#[tauri::command]
pub async fn claude_design_generate(
    request: ClaudeDesignGenerateRequest,
    gemini_api_key: String,
) -> Result<ClaudeDesignGenerateResponse, String> {
    if request.prompt.trim().is_empty() {
        return Err("요청 내용을 입력하세요.".into());
    }
    let key = gemini_api_key.trim().to_string();
    if key.is_empty() {
        return Err("Gemini API 키가 설정되지 않았습니다.".into());
    }
    let prompt = build_prompt(&request);
    let model = if request.model.trim().is_empty() {
        "gemini-2.0-flash-exp".to_string()
    } else {
        request.model.trim().to_string()
    };
    let raw_text = call_gemini(&prompt, &key, &model).await?;
    let html = extract_html(&raw_text);
    if html.is_empty() {
        return Err(format!(
            "모델 응답에서 HTML을 찾지 못했습니다. raw_text_len={}",
            raw_text.len()
        ));
    }
    Ok(ClaudeDesignGenerateResponse {
        status: "ok".into(),
        html,
        provider: "gemini".into(),
        model,
    })
}
