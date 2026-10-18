//! Tauri commands that communicate with the Octo Bot Gateway REST API.

use serde_json::json;
use std::time::Duration;

const GATEWAY_BASE_URL: &str = "http://127.0.0.1:3848";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

// ── Status ──

#[tauri::command]
pub async fn gateway_status() -> Result<String, String> {
    let res = client()?
        .get(format!("{}/status", GATEWAY_BASE_URL))
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

// ── Bot ──

#[tauri::command]
pub async fn gateway_bot_start() -> Result<String, String> {
    let res = client()?
        .post(format!("{}/bot/start", GATEWAY_BASE_URL))
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gateway_bot_stop() -> Result<String, String> {
    let res = client()?
        .post(format!("{}/bot/stop", GATEWAY_BASE_URL))
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

// ── Channels ──

#[tauri::command]
pub async fn gateway_channels() -> Result<String, String> {
    let res = client()?
        .get(format!("{}/channels", GATEWAY_BASE_URL))
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gateway_channel_start(
    channel_type: String,
    token: String,
    mention_required: Option<bool>,
) -> Result<String, String> {
    let body = json!({
        "type": channel_type,
        "enabled": true,
        "token": token,
        "allowFrom": [],
        "mentionRequired": mention_required.unwrap_or(true),
    });

    let res = client()?
        .post(format!("{}/channels/start", GATEWAY_BASE_URL))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gateway_channel_stop(channel_type: String) -> Result<String, String> {
    let body = json!({ "type": channel_type });

    let res = client()?
        .post(format!("{}/channels/stop", GATEWAY_BASE_URL))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

// ── Cron ──

#[tauri::command]
pub async fn gateway_cron_list() -> Result<String, String> {
    let res = client()?
        .get(format!("{}/cron", GATEWAY_BASE_URL))
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gateway_cron_create(
    name: String,
    schedule_type: String,
    schedule: String,
    payload_type: String,
    payload_text: String,
    engine: Option<String>,
    target_channel_type: Option<String>,
    target_channel_id: Option<String>,
) -> Result<String, String> {
    let mut body = json!({
        "name": name,
        "scheduleType": schedule_type,
        "schedule": schedule,
        "payloadType": payload_type,
        "payloadText": payload_text,
    });

    if let Some(e) = engine {
        body.as_object_mut().unwrap().insert("engine".to_string(), json!(e));
    }
    if let (Some(ct), Some(ci)) = (target_channel_type, target_channel_id) {
        body.as_object_mut().unwrap().insert("targetChannelType".to_string(), json!(ct));
        body.as_object_mut().unwrap().insert("targetChannelId".to_string(), json!(ci));
    }

    let res = client()?
        .post(format!("{}/cron", GATEWAY_BASE_URL))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gateway_cron_delete(id: String) -> Result<String, String> {
    let res = client()?
        .delete(format!("{}/cron/{}", GATEWAY_BASE_URL, id))
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gateway_cron_toggle(id: String) -> Result<String, String> {
    let res = client()?
        .post(format!("{}/cron/{}/toggle", GATEWAY_BASE_URL, id))
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

// ── Hooks ──

#[tauri::command]
pub async fn gateway_hook_list() -> Result<String, String> {
    let res = client()?
        .get(format!("{}/hooks", GATEWAY_BASE_URL))
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gateway_hook_create(
    name: String,
    event: String,
    url: String,
    method: Option<String>,
    secret: Option<String>,
) -> Result<String, String> {
    let mut config = json!({
        "url": url,
        "method": method.unwrap_or_else(|| "POST".to_string()),
    });
    if let Some(s) = secret {
        config.as_object_mut().unwrap().insert("secret".to_string(), json!(s));
    }

    let body = json!({
        "name": name,
        "event": event,
        "config": config,
    });

    let res = client()?
        .post(format!("{}/hooks", GATEWAY_BASE_URL))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gateway_hook_delete(id: String) -> Result<String, String> {
    let res = client()?
        .delete(format!("{}/hooks/{}", GATEWAY_BASE_URL, id))
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}

// ── Chat ──

#[tauri::command]
pub async fn gateway_chat(
    message: String,
    engine: Option<String>,
    user_id: Option<String>,
) -> Result<String, String> {
    let mut body = json!({ "message": message });
    if let Some(e) = engine {
        body.as_object_mut().unwrap().insert("engine".to_string(), json!(e));
    }
    if let Some(uid) = user_id {
        body.as_object_mut().unwrap().insert("userId".to_string(), json!(uid));
    }

    let res = client()?
        .post(format!("{}/chat", GATEWAY_BASE_URL))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Gateway unreachable: {}", e))?;

    res.text().await.map_err(|e| e.to_string())
}
