//! XLSX editor control — drives the host BBARIT Terminal's spreadsheet editor
//! over the local editor bridge (HTTP POST `/editor` → Tauri event → XlsxEditor).
//!
//! The host app injects `BBARIT_EDITOR_BRIDGE` (full URL, authoritative) when it
//! spawns the agent; standalone runs fall back to probing the dev app (19981)
//! then the installed app (19980). Same local-trust model as the browser CLI.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::time::Duration;

const RELEASE_BRIDGE: &str = "http://127.0.0.1:19980/editor";
const DEV_BRIDGE: &str = "http://127.0.0.1:19981/editor";

fn bridge_candidates() -> Vec<String> {
    if let Ok(url) = std::env::var("BBARIT_EDITOR_BRIDGE") {
        let url = url.trim().to_string();
        if !url.is_empty() {
            return vec![url];
        }
    }
    // No host hint: prefer the dev app so testing never mutates an installed
    // app's open documents by accident.
    vec![DEV_BRIDGE.to_string(), RELEASE_BRIDGE.to_string()]
}

fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        // The bridge waits up to 30s for a heavy open/round-trip; stay above it
        // so we surface the bridge's own error message instead of a bare client
        // timeout that would abort while the file is still opening (state drift).
        .timeout(Duration::from_secs(35))
        .build()
        .context("editor bridge: building HTTP client")
}

/// POST one command; Err only on transport failure (bridge unreachable).
fn post(client: &reqwest::blocking::Client, url: &str, body: &Value) -> Result<Value> {
    let resp = client.post(url).json(body).send()?;
    let value: Value = resp.json().context("editor bridge: non-JSON response")?;
    // A bridge failure envelope is { success:false, data:null, error:"…" }: its
    // `data` is null, so return the whole envelope (keeping `error`) instead of
    // collapsing to null and losing the reason as "failed: null". Callers still
    // inspect `ok`, so the readiness retry loop keeps working.
    match value.get("data") {
        Some(data) if !data.is_null() => Ok(data.clone()),
        _ => Ok(value),
    }
}

/// Find a live bridge: first candidate that answers at all wins.
fn resolve_bridge(client: &reqwest::blocking::Client) -> Result<String> {
    let candidates = bridge_candidates();
    for url in &candidates {
        let probe = json!({"cmd": "xlsx.listSheets", "path": ""});
        if client.post(url).json(&probe).send().is_ok() {
            return Ok(url.clone());
        }
    }
    bail!(
        "editor bridge unreachable (tried {}). Is BBARIT Terminal running?",
        candidates.join(", ")
    )
}

/// Cheap read-only command per editor kind, used as the mount-readiness probe.
fn ready_cmd(kind: &str) -> &'static str {
    match kind {
        "pptx" => "pptx.listSlides",
        "docx" => "docx.getText",
        _ => "xlsx.listSheets",
    }
}

/// Option keys `office_action` forwards to the bridge verbatim. A const so the
/// unknown-key check below can't drift from what is actually forwarded.
const OFFICE_FORWARD_KEYS: &[&str] = &[
    // xlsx
    "range",
    "cells",
    "format",
    "sheet",
    "name",
    // pptx
    "title",
    "body",
    "bgColor",
    "titleColor",
    "bodyColor",
    "text",
    "x",
    "y",
    "w",
    "h",
    "fontSize",
    "color",
    "bold",
    "italic",
    "align",
    "listStyle",
    "fontFamily",
    "titleAlign",
    "bodyAlign",
    "shape",
    "fillColor",
    "slide",
    // pptx (extended: tables, images, notes, background, theme, transition, slide/element ops)
    "rows",
    "cols",
    "headerRow",
    "headerFill",
    "borderColor",
    "imagePath",
    "imageSrc",
    "bgImage",
    "notes",
    "theme",
    "applyToAll",
    "transition",
    "durationMs",
    "advanceAfterSec",
    "to",
    "elementId",
    // pptx (designed layouts)
    "layout",
    "subtitle",
    "metrics",
    "items",
    "kicker",
    "footer",
    "data",
    // docx
    "heading",
    "paragraph",
    "bullets",
    "html",
    "find",
    "replace",
    "all",
];

/// Consumed by the driver/caller, never forwarded (`path` rides inside `args`
/// when called through the agent tools).
const STRUCTURAL_KEYS: &[&str] = &["action", "path"];

/// Levenshtein distance, for did-you-mean hints on typo'd option keys.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur.push((prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

fn closest_key<'a>(key: &str, allowed: &[&'a str]) -> Option<&'a str> {
    let key_lc = key.to_lowercase();
    allowed
        .iter()
        .map(|k| (edit_distance(&key_lc, &k.to_lowercase()), *k))
        // `d < key len` keeps 1-char args from "matching" everything.
        .filter(|(d, _)| *d <= 2 && *d < key.chars().count())
        .min_by_key(|(d, _)| *d)
        .map(|(_, k)| k)
}

/// Option keys in `args` that the caller would otherwise silently drop (not
/// structural, not in `allowed`), each with a did-you-mean hint when a close
/// match exists. Dropped keys make an action run with missing params and
/// confusing output, so callers reject them up front.
fn unknown_option_keys(args: &Value, allowed: &[&str]) -> Vec<String> {
    let Some(map) = args.as_object() else {
        return Vec::new();
    };
    map.keys()
        .filter(|k| !STRUCTURAL_KEYS.contains(&k.as_str()) && !allowed.contains(&k.as_str()))
        .map(|k| match closest_key(k, allowed) {
            Some(s) => format!("{k} (did you mean {s}?)"),
            None => k.clone(),
        })
        .collect()
}

/// Shared office-editor driver: ensures the document is open in the BBARIT
/// editor (open + short readiness poll — the command listener only exists
/// while the editor tab is mounted), then forwards `<kind>.<action>`.
pub fn office_action(kind: &str, args: &Value, path: &str) -> Result<String> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if action.is_empty() {
        bail!("{kind}: `action` is required");
    }
    // Fail before touching the bridge: a typo'd key would otherwise be dropped
    // and the action would run with missing params.
    let unknown = unknown_option_keys(args, OFFICE_FORWARD_KEYS);
    if !unknown.is_empty() {
        bail!(
            "unknown option(s) for {kind}.{action}: {}",
            unknown.join(", ")
        );
    }
    let client = client()?;
    let bridge = resolve_bridge(&client)?;

    let open_body = json!({"cmd": "open", "path": path});
    let opened = post(&client, &bridge, &open_body)?;
    if opened.get("ok").and_then(Value::as_bool) != Some(true) {
        bail!("{kind}: open failed for {path}: {opened}");
    }
    if action == "open" {
        return Ok(format!("opened {path} in the BBARIT editor"));
    }

    // The editor mounts asynchronously after `open`, and a request sent before
    // its listener registers burns the bridge's full 12s timeout. Give the
    // mount a moment, then confirm readiness (each failed attempt costs 12s,
    // so keep the retry count small).
    std::thread::sleep(Duration::from_millis(600));
    let ready_body = json!({"cmd": ready_cmd(kind), "path": path});
    let mut ready = false;
    // Cold-mount of a fresh office tab (especially when switching document
    // kinds, since only the active tab is mounted) can take several seconds.
    // Poll a few times with a short pause between so a slow mount isn't lost to
    // a burst of 3 immediate probes.
    for attempt in 0..6 {
        let r = post(&client, &bridge, &ready_body)?;
        if r.get("ok").and_then(Value::as_bool) == Some(true) {
            ready = true;
            break;
        }
        if attempt < 5 {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    if !ready {
        bail!("{kind}: editor did not become ready for {path} (is it a valid .{kind}?)");
    }

    let mut body = json!({"cmd": format!("{kind}.{action}"), "path": path});
    for &key in OFFICE_FORWARD_KEYS {
        if let Some(v) = args.get(key) {
            if !v.is_null() {
                body[key] = v.clone();
            }
        }
    }
    let result = post(&client, &bridge, &body)?;
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(serde_json::to_string_pretty(&result)?)
    } else {
        bail!("{kind}.{action} failed: {result}")
    }
}

/// `xlsx` tool entry (kept for the live regression test).
pub fn xlsx_action(args: &Value, path: &str) -> Result<String> {
    office_action("xlsx", args, path)
}

/// `editor` tool: drive the app's plain-text editor tab for ANY text-like file
/// (txt / md / mermaid / html / code). Unlike the office tools there is no
/// per-kind namespace — the app bridge exposes open/getContent/setContent/save
/// directly, and the tab must be open before get/set/save.
pub fn editor_action(args: &Value, path: &str) -> Result<String> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let cmd = match action {
        "open" => "open",
        "get" | "getContent" => "getContent",
        "set" | "setContent" => "setContent",
        "save" => "save",
        _ => bail!("editor: `action` must be open/get/set/save"),
    };
    // Same fail-fast as office_action: a typo'd `content` would otherwise
    // surface only as a downstream "content is required".
    let unknown = unknown_option_keys(args, &["content"]);
    if !unknown.is_empty() {
        bail!(
            "unknown option(s) for editor.{action}: {}",
            unknown.join(", ")
        );
    }
    let client = client()?;
    let bridge = resolve_bridge(&client)?;

    // get/set/save need the tab open first; `open` is idempotent and cheap.
    if cmd != "open" {
        let opened = post(&client, &bridge, &json!({"cmd": "open", "path": path}))?;
        if opened.get("ok").and_then(Value::as_bool) != Some(true) {
            bail!("editor: open failed for {path}: {opened}");
        }
        std::thread::sleep(Duration::from_millis(300));
    }

    let mut body = json!({"cmd": cmd, "path": path});
    if cmd == "setContent" {
        let content = args
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("editor: `content` is required for set"))?;
        body["content"] = json!(content);
    }
    let result = post(&client, &bridge, &body)?;
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(serde_json::to_string_pretty(&result)?)
    } else {
        bail!("editor.{action} failed: {result}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_path(rel: &str) -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repo root")
            .join(rel)
            .to_string_lossy()
            .replace('\\', "/")
    }

    /// Typo'd option keys are flagged with a hint; known + structural keys
    /// (`action`, `path`) pass. Pure key-validation — no bridge needed.
    #[test]
    fn unknown_option_keys_flags_typos_and_passes_known_keys() {
        let unknown = unknown_option_keys(
            &json!({"action": "getCells", "path": "a.xlsx", "rang": "A1:C3"}),
            OFFICE_FORWARD_KEYS,
        );
        assert_eq!(unknown, vec!["rang (did you mean range?)".to_string()]);

        let ok = unknown_option_keys(
            &json!({"action": "getCells", "path": "a.xlsx", "range": "A1:C3", "sheet": "S1"}),
            OFFICE_FORWARD_KEYS,
        );
        assert!(ok.is_empty(), "false positives: {ok:?}");
    }

    /// The office driver rejects a bogus key BEFORE any bridge traffic, so the
    /// action can't run with silently-missing params.
    #[test]
    fn office_action_rejects_unknown_option_key() {
        let err = office_action(
            "xlsx",
            &json!({"action": "getCells", "rang": "A1:C3"}),
            "a.xlsx",
        )
        .expect_err("bogus key must error");
        let msg = err.to_string();
        assert!(
            msg.contains("unknown option(s) for xlsx.getCells"),
            "msg: {msg}"
        );
        assert!(msg.contains("rang (did you mean range?)"), "msg: {msg}");
    }

    /// Same guard on the plain-text editor: a typo'd `content` errors with a
    /// hint instead of the downstream "content is required".
    #[test]
    fn editor_action_rejects_unknown_option_key() {
        let err = editor_action(&json!({"action": "set", "contnet": "x"}), "a.md")
            .expect_err("bogus key must error");
        let msg = err.to_string();
        assert!(
            msg.contains("contnet (did you mean content?)"),
            "msg: {msg}"
        );
    }

    /// Live round-trip against a RUNNING BBARIT app (dev bridge 19981) and the
    /// repo sample workbook. Ignored by default; run explicitly with:
    /// `cargo test live_ -- --ignored --test-threads=1`
    /// (single-threaded is REQUIRED: only the active editor tab is mounted, so
    /// parallel live tests steal each other's tab and fail readiness).
    #[test]
    #[ignore]
    fn live_xlsx_getcells_roundtrip() {
        let path = sample_path("samples/11-xlsx/sample.xlsx");

        let sheets = xlsx_action(&json!({"action": "listSheets"}), &path).expect("listSheets");
        println!("listSheets → {sheets}");
        assert!(sheets.contains("sheets"), "sheet list missing: {sheets}");

        let cells =
            xlsx_action(&json!({"action": "getCells", "range": "A1:C3"}), &path).expect("getCells");
        println!("getCells → {cells}");
        assert!(cells.contains("\"ref\": \"A1\""), "A1 missing: {cells}");
    }

    /// Live: slide listing + add + text/shape on the sample deck (no save, so
    /// the sample file on disk stays untouched).
    #[test]
    #[ignore]
    fn live_pptx_roundtrip() {
        let path = sample_path("samples/10-pptx/sample.pptx");

        let slides =
            office_action("pptx", &json!({"action": "listSlides"}), &path).expect("listSlides");
        println!("listSlides → {slides}");
        assert!(
            slides.contains("\"count\""),
            "slide count missing: {slides}"
        );

        let added = office_action(
            "pptx",
            &json!({"action": "addSlide", "title": "Live Test Slide", "body": "a\nb"}),
            &path,
        )
        .expect("addSlide");
        println!("addSlide → {added}");
        assert!(added.contains("\"index\""), "new index missing: {added}");

        let shape = office_action(
            "pptx",
            &json!({"action": "addShape", "shape": "rect", "fillColor": "#0ea5e9", "text": "OK"}),
            &path,
        )
        .expect("addShape");
        assert!(shape.contains("\"id\""), "shape id missing: {shape}");
    }

    /// Live: generic text editor round-trip on a scratch markdown file.
    #[test]
    #[ignore]
    fn live_editor_roundtrip() {
        let scratch = sample_path(".octo-tmp/live-editor-test.md");
        std::fs::write(scratch.replace('/', "\\"), "# before\n").expect("seed scratch file");

        let set = editor_action(
            &json!({"action": "set", "content": "# after\n\nedited via the editor tool\n"}),
            &scratch,
        )
        .expect("set");
        assert!(set.contains("\"ok\": true"), "set failed: {set}");

        let got = editor_action(&json!({"action": "get"}), &scratch).expect("get");
        assert!(
            got.contains("edited via the editor tool"),
            "content mismatch: {got}"
        );

        let saved = editor_action(&json!({"action": "save"}), &scratch).expect("save");
        assert!(saved.contains("\"ok\": true"), "save failed: {saved}");
        let disk = std::fs::read_to_string(scratch.replace('/', "\\")).expect("read back");
        assert!(disk.contains("# after"), "disk not updated: {disk}");
    }

    /// Live: read + append on the sample document (no save).
    #[test]
    #[ignore]
    fn live_docx_roundtrip() {
        let path = sample_path("samples/09-docx/sample.docx");

        let text = office_action("docx", &json!({"action": "getText"}), &path).expect("getText");
        println!("getText → {} chars", text.len());
        assert!(text.contains("\"text\""), "text missing: {text}");

        let appended = office_action(
            "docx",
            &json!({"action": "append", "heading": "Live Test", "paragraph": "From the live test."}),
            &path,
        )
        .expect("append");
        assert!(
            appended.contains("\"appended\""),
            "append failed: {appended}"
        );
    }
}
