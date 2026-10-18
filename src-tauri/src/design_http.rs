//! Embedded HTTP server for the Bbarit Design conversational AI canvas.
//! Started on-demand via Tauri command.

use axum::{
    extract::{Path, State as AxumState},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;
use tower_http::{cors::CorsLayer, services::ServeDir};

use crate::claude_design;

#[cfg(debug_assertions)]
pub const DESIGN_PORT: u16 = 19982;
#[cfg(not(debug_assertions))]
pub const DESIGN_PORT: u16 = 19981;

// ── Shared state ──

pub struct DesignServerState {
    pub running: Mutex<bool>,
}

#[derive(Clone)]
struct DesignCtx {
    _app_handle: AppHandle,
}

// ── API types ──

#[derive(Debug, Deserialize)]
struct GenerateRequest {
    prompt: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    aspect_ratio: String,
    #[serde(default)]
    brand_name: String,
    #[serde(default, alias = "brand_colors")]
    brand_colors: Option<Vec<String>>,
    #[serde(default)]
    business_type: String,
    #[serde(default)]
    business_description: String,
    #[serde(default)]
    cta_text: String,
    #[serde(default)]
    design_rules: String,
    #[serde(default)]
    design_style: String,
    #[serde(default)]
    design_purpose: String,
    #[serde(default)]
    design_density: String,
    #[serde(default)]
    model: String,
    #[serde(alias = "api_key")]
    gemini_api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EditRequest {
    html: String,
    instruction: String,
    #[serde(default)]
    model: String,
    #[serde(alias = "api_key")]
    gemini_api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SaveRequest {
    html: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    aspect_ratio: String,
    #[serde(default)]
    prompt: String,
}

// ── Tauri command ──

#[tauri::command]
pub async fn start_design_server(
    app_handle: AppHandle,
    state: tauri::State<'_, Arc<DesignServerState>>,
) -> Result<u16, String> {
    let mut running = state.running.lock().await;
    if *running {
        return Ok(DESIGN_PORT);
    }

    let ctx = Arc::new(DesignCtx { _app_handle: app_handle });

    let cors = CorsLayer::permissive();

    let app = Router::new()
        .route("/api/claude-design/generate", post(handle_generate))
        .route("/api/claude-design/edit", post(handle_edit))
        .route("/api/claude-design/save", post(handle_save))
        .route("/api/claude-design/list", get(handle_list))
        .route("/api/claude-design/item/{id}", get(handle_load))
        .route("/api/health", get(handle_health))
        .nest_service(
            "/",
            ServeDir::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("design-static")),
        )
        .layer(cors)
        .with_state(ctx);

    let addr = format!("127.0.0.1:{}", DESIGN_PORT);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("port bind failed: {e}"))?;

    *running = true;

    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            crate::safe_eprintln!("[BbaritDesign] server error: {e}");
        }
    });

    // Give server a moment
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    Ok(DESIGN_PORT)
}

#[tauri::command]
pub async fn is_design_server_running(
    state: tauri::State<'_, Arc<DesignServerState>>,
) -> Result<bool, String> {
    Ok(*state.running.lock().await)
}

// ── Handlers ──

async fn handle_generate(
    AxumState(_ctx): AxumState<Arc<DesignCtx>>,
    Json(body): Json<GenerateRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let api_key = body.gemini_api_key.unwrap_or_default();
    let req = claude_design::ClaudeDesignGenerateRequest {
        prompt: body.prompt,
        kind: body.kind,
        aspect_ratio: body.aspect_ratio,
        brand_name: body.brand_name,
        brand_colors: body.brand_colors.unwrap_or_default(),
        business_type: body.business_type,
        business_description: body.business_description,
        cta_text: body.cta_text,
        design_rules: body.design_rules,
        design_style: body.design_style,
        design_purpose: body.design_purpose,
        design_density: body.design_density,
        model: body.model,
    };
    match claude_design::claude_design_generate(req, api_key).await {
        Ok(resp) => (
            StatusCode::OK,
            Json(serde_json::to_value(resp).unwrap_or_default()),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        ),
    }
}

async fn handle_edit(
    AxumState(_ctx): AxumState<Arc<DesignCtx>>,
    Json(body): Json<EditRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let api_key = body.gemini_api_key.unwrap_or_default();
    let req = claude_design::ClaudeDesignEditRequest {
        html: body.html,
        instruction: body.instruction,
        model: body.model,
    };
    match claude_design::claude_design_edit(req, api_key).await {
        Ok(resp) => (
            StatusCode::OK,
            Json(serde_json::to_value(resp).unwrap_or_default()),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        ),
    }
}

async fn handle_save(
    AxumState(_ctx): AxumState<Arc<DesignCtx>>,
    Json(body): Json<SaveRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let req = claude_design::ClaudeDesignSaveRequest {
        html: body.html,
        id: body.id,
        name: body.name,
        kind: body.kind,
        aspect_ratio: body.aspect_ratio,
        prompt: body.prompt,
    };
    match claude_design::claude_design_save(req).await {
        Ok(resp) => (
            StatusCode::OK,
            Json(serde_json::to_value(resp).unwrap_or_default()),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        ),
    }
}

async fn handle_list() -> (StatusCode, Json<serde_json::Value>) {
    match claude_design::claude_design_list().await {
        Ok(resp) => (
            StatusCode::OK,
            Json(serde_json::to_value(resp).unwrap_or_default()),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        ),
    }
}

async fn handle_load(
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match claude_design::claude_design_load(id).await {
        Ok(html) => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "ok", "html": html})),
        ),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": e})),
        ),
    }
}

async fn handle_health() -> &'static str {
    "ok"
}
