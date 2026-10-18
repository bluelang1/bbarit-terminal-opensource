//! App control — drives the host BBARIT Terminal's whole-app UI (projects,
//! views, terminals, settings, image/design/cowork panels) over the local
//! gateway bridge (HTTP POST `/gateway/ui` → Tauri event → App.tsx).
//!
//! The host app injects `BBARIT_GATEWAY_BRIDGE` (full URL, authoritative) when
//! it spawns the secretary agent; standalone runs fall back to probing the dev
//! app (19981) then the installed app (19980). Same local-trust model as the
//! editor/browser CLIs.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::time::Duration;

const RELEASE_BRIDGE: &str = "http://127.0.0.1:19980/gateway/ui";
const DEV_BRIDGE: &str = "http://127.0.0.1:19981/gateway/ui";

fn bridge_candidates() -> Vec<String> {
    if let Ok(url) = std::env::var("BBARIT_GATEWAY_BRIDGE") {
        let url = url.trim().to_string();
        if !url.is_empty() {
            return vec![url];
        }
    }
    // No host hint: prefer the dev app so testing never mutates an installed
    // app's projects/panels by accident.
    vec![DEV_BRIDGE.to_string(), RELEASE_BRIDGE.to_string()]
}

fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        // The bridge waits up to 30s for App.tsx to handle a UI command; stay
        // above it so we surface the bridge's own error instead of a bare
        // client timeout that aborts mid-command.
        .timeout(Duration::from_secs(35))
        .build()
        .context("gateway bridge: building HTTP client")
}

/// The host injects this so app_control can authenticate to POST /gateway/ui.
/// Without it the bridge rejects the request (401) — the UI bus is not open to
/// unauthenticated local callers (e.g. a malicious web page).
fn ui_token() -> Option<String> {
    std::env::var("BBARIT_GATEWAY_UI_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// POST one command; Err only on transport failure (bridge unreachable).
fn post(client: &reqwest::blocking::Client, url: &str, body: &Value) -> Result<Value> {
    let mut req = client.post(url).json(body);
    if let Some(token) = ui_token() {
        req = req.bearer_auth(token);
    }
    let resp = req.send()?;
    let value: Value = resp.json().context("gateway bridge: non-JSON response")?;
    // A bridge failure envelope keeps its reason under `error`; return the
    // whole envelope so callers can inspect `ok` and surface the message.
    match value.get("data") {
        Some(data) if !data.is_null() => Ok(data.clone()),
        _ => Ok(value),
    }
}

/// Find a live bridge: first candidate that answers at all wins.
fn resolve_bridge(client: &reqwest::blocking::Client) -> Result<String> {
    let candidates = bridge_candidates();
    for url in &candidates {
        let probe = json!({"cmd": "status"});
        if client.post(url).json(&probe).send().is_ok() {
            return Ok(url.clone());
        }
    }
    bail!(
        "gateway bridge unreachable (tried {}). Is BBARIT Terminal running?",
        candidates.join(", ")
    )
}

/// `app_control` tool entry: drive the host app's UI. `args.action` maps 1:1 to
/// the bridge `cmd`; every other key is merged into the request body verbatim.
pub fn app_control(args: &Value) -> Result<String> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if action.is_empty() {
        bail!("app_control: `action` is required");
    }

    let mut body = json!({ "cmd": action });
    if let Some(obj) = args.as_object() {
        for (key, value) in obj {
            if key == "action" {
                continue;
            }
            body[key] = value.clone();
        }
    }

    let client = client()?;
    let bridge = resolve_bridge(&client)?;
    let result = post(&client, &bridge, &body)?;
    if result.get("ok").and_then(Value::as_bool) == Some(false) {
        bail!("app_control {action} failed: {result}");
    }
    Ok(serde_json::to_string_pretty(&result)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `BBARIT_GATEWAY_BRIDGE` overrides the dev/release probe order.
    #[test]
    fn env_bridge_takes_priority() {
        // Guard against parallel tests touching the same env var.
        let saved = std::env::var("BBARIT_GATEWAY_BRIDGE").ok();
        unsafe {
            std::env::set_var("BBARIT_GATEWAY_BRIDGE", "http://127.0.0.1:12345/gateway/ui");
        }
        let candidates = bridge_candidates();
        assert_eq!(
            candidates,
            vec!["http://127.0.0.1:12345/gateway/ui".to_string()]
        );

        // Empty env falls back to dev-then-release probing.
        unsafe {
            std::env::set_var("BBARIT_GATEWAY_BRIDGE", "   ");
        }
        assert_eq!(
            bridge_candidates(),
            vec![DEV_BRIDGE.to_string(), RELEASE_BRIDGE.to_string()]
        );

        unsafe {
            match saved {
                Some(v) => std::env::set_var("BBARIT_GATEWAY_BRIDGE", v),
                None => std::env::remove_var("BBARIT_GATEWAY_BRIDGE"),
            }
        }
    }
}
