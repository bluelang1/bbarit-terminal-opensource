//! Internal browser backend implemented with a Tauri child webview.
//!
//! The public command surface intentionally keeps the historical `cef_*` names
//! so the existing React browser UI can switch from CEF to native webviews without a
//! frontend rewrite.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, PageLoadEvent};

/// 프론트엔드에서 넘어오는 임포트 쿠키 한 개. 시간은 Unix epoch ms.
#[derive(Deserialize)]
pub struct ImportCookie {
    pub host: String,
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub expires: i64,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub same_site: i64,
}
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect};

static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static BROWSERS: Mutex<Option<HashMap<u32, Entry>>> = Mutex::new(None);
/// Override set via `cef_set_download_dir` (agent setDownloadBehavior); when
/// unset downloads land in the OS Downloads folder.
static DOWNLOAD_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
/// In-flight downloads keyed by source URL, so the Finished event (whose
/// `path` can be absent on some platforms) still reports the destination.
static ACTIVE_DOWNLOADS: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

struct Entry {
    webview_label: String,
    zoom_level: f64,
    last_url: String,
    last_title: String,
    nav_count: u32,
}

fn with_map<R>(f: impl FnOnce(&mut HashMap<u32, Entry>) -> R) -> R {
    let mut guard = BROWSERS.lock().unwrap();
    f(guard.get_or_insert_with(HashMap::new))
}

#[derive(Clone, Serialize)]
struct CefEvent {
    #[serde(rename = "type")]
    kind: String,
    id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_go_back: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_go_forward: Option<bool>,
}

fn emit(app: &AppHandle, event: CefEvent) {
    let _ = app.emit("cef-event", &event);
}

fn webview_of(app: &AppHandle, id: u32) -> Option<tauri::Webview> {
    let label = with_map(|m| m.get(&id).map(|e| e.webview_label.clone()))?;
    app.get_webview(&label)
}

fn note_url(id: u32, url: &str) -> u32 {
    with_map(|m| {
        let Some(e) = m.get_mut(&id) else { return 0 };
        if e.last_url != url {
            e.last_url = url.to_string();
            e.nav_count += 1;
        }
        e.nav_count
    })
}

fn emit_loading(app: &AppHandle, id: u32, url: String, loading: bool) {
    let nav_count = with_map(|m| m.get(&id).map(|e| e.nav_count).unwrap_or(0));
    emit(
        app,
        CefEvent {
            kind: "loading".into(),
            id,
            title: None,
            url: Some(url),
            message: None,
            loading: Some(loading),
            can_go_back: Some(nav_count > 0),
            can_go_forward: Some(false),
        },
    );
}

/// Filename from the download URL's last path segment (percent-decoded),
/// with a generic fallback so every download gets SOME name.
fn suggested_filename(url: &tauri::Url) -> String {
    let raw = url
        .path_segments()
        .and_then(|segments| segments.filter(|s| !s.is_empty()).next_back())
        .unwrap_or("");
    let decoded = urlencoding::decode(raw)
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| raw.to_string());
    let cleaned: String = decoded
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':') { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "download".to_string()
    } else {
        cleaned
    }
}

/// `name.ext` → `name (1).ext` … until the path is free.
fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let parent = path.parent().map(PathBuf::from).unwrap_or_default();
    for n in 1..1000 {
        let candidate = parent.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

fn download_destination(url: &tauri::Url) -> PathBuf {
    let base = DOWNLOAD_DIR
        .lock()
        .unwrap()
        .clone()
        .or_else(dirs::download_dir)
        .unwrap_or_else(std::env::temp_dir);
    let _ = std::fs::create_dir_all(&base);
    unique_path(base.join(suggested_filename(url)))
}

fn link_bridge_script() -> &'static str {
    r#"
(() => {
  if (window.__BBARIT_LINK_BRIDGE_INSTALLED__) return;
  window.__BBARIT_LINK_BRIDGE_INSTALLED__ = true;
  document.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!target) return;
    const href = target.href || target.getAttribute('href') || '';
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return;
    const targetName = String(target.getAttribute('target') || '').toLowerCase();
    const opensNew = (targetName && targetName !== '_self') || event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1;
    if (!opensNew) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    location.href = 'bbarit-popup://open?url=' + encodeURIComponent(href);
  }, true);
})()
"#
}

// Installed at document start on every navigation so page-boot fetch/XHR are
// captured too. Resource Timing (the macOS packet source) never exposes
// headers or bodies; this hook records them into a ring buffer that the
// frontend packet poller drains via cef_eval.
fn network_capture_script() -> &'static str {
    r#"
(() => {
  if (window.__BBARIT_NETWORK_CAPTURE__) return;
  const MAX_ENTRIES = 300;
  const MAX_BODY = 262144;
  const store = {
    token: Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36),
    seq: 0,
    entries: [],
  };
  window.__BBARIT_NETWORK_CAPTURE__ = store;
  const push = (entry) => {
    entry.seq = ++store.seq;
    store.entries.push(entry);
    if (store.entries.length > MAX_ENTRIES) store.entries.splice(0, store.entries.length - MAX_ENTRIES);
  };
  const clip = (text) => {
    const value = String(text == null ? '' : text);
    return value.length > MAX_BODY ? value.slice(0, MAX_BODY) + '\n... [truncated at 256 KB]' : value;
  };
  const absolute = (url) => { try { return new URL(String(url), location.href).href; } catch (e) { return String(url); } };
  const textLike = (mime) => /json|text|xml|javascript|x-www-form-urlencoded|svg|graphql|csv/i.test(String(mime || ''));
  const headerPairs = (headers) => {
    const out = [];
    try {
      if (!headers) return out;
      if (typeof Headers !== 'undefined' && headers instanceof Headers) { headers.forEach((v, k) => out.push([k, v])); return out; }
      if (Array.isArray(headers)) { for (const p of headers) if (p) out.push([String(p[0]), String(p[1])]); return out; }
      for (const k of Object.keys(headers)) out.push([k, String(headers[k])]);
    } catch (e) {}
    return out;
  };
  const requestBody = (body) => {
    if (body == null) return { text: '', note: '' };
    if (typeof body === 'string') return { text: clip(body), note: '' };
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return { text: clip(body.toString()), note: '' };
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const parts = [];
      try { body.forEach((v, k) => parts.push(k + '=' + (typeof v === 'string' ? v : '[file ' + ((v && v.name) || 'blob') + ', ' + ((v && v.size) || 0) + ' bytes]'))); } catch (e) {}
      return { text: clip(parts.join('\n')), note: '' };
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) return { text: '', note: '[binary request body: ' + body.size + ' bytes]' };
    if (body instanceof ArrayBuffer) return { text: '', note: '[binary request body: ' + body.byteLength + ' bytes]' };
    if (ArrayBuffer.isView(body)) return { text: '', note: '[binary request body: ' + body.byteLength + ' bytes]' };
    return { text: '', note: '[stream or unsupported request body]' };
  };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      let captured = null;
      try {
        const request = (typeof Request !== 'undefined' && input instanceof Request) ? input : null;
        const method = String((init && init.method) || (request && request.method) || 'GET').toUpperCase();
        let bodyInfo = requestBody(init ? init.body : null);
        if (!bodyInfo.text && !bodyInfo.note && request && request.body && method !== 'GET' && method !== 'HEAD') {
          bodyInfo = { text: '', note: '[Request object stream body was not captured]' };
        }
        captured = {
          kind: 'fetch',
          url: absolute(request ? request.url : input),
          method,
          startedAtMs: Date.now(),
          requestHeaders: headerPairs((init && init.headers) || (request && request.headers)),
          postData: bodyInfo.text,
          postDataNote: bodyInfo.note,
        };
      } catch (e) { captured = null; }
      const promise = nativeFetch.apply(this, arguments);
      if (!captured) return promise;
      return promise.then((response) => {
        try {
          const mime = String(response.headers.get('content-type') || '');
          const base = Object.assign({}, captured, {
            finishedAtMs: Date.now(),
            status: Number(response.status) || 0,
            statusText: String(response.statusText || ''),
            responseHeaders: headerPairs(response.headers),
            mimeType: mime.split(';')[0].trim(),
            failed: false,
            errorText: '',
            body: '',
            bodyNote: '',
          });
          const length = Number(response.headers.get('content-length') || 0);
          if (/event-stream/i.test(mime)) {
            base.bodyNote = '[streaming response body was not captured]';
            push(base);
          } else if (!textLike(mime)) {
            base.bodyNote = '[non-text response body was not captured' + (mime ? ': ' + mime.split(';')[0].trim() : '') + ']';
            push(base);
          } else if (length > MAX_BODY * 4) {
            base.bodyNote = '[response body skipped: ' + length + ' bytes]';
            push(base);
          } else {
            response.clone().text().then(
              (text) => { base.body = clip(text); push(base); },
              () => { base.bodyNote = '[response body could not be read]'; push(base); },
            );
          }
        } catch (e) {}
        return response;
      }, (error) => {
        try {
          push(Object.assign({}, captured, {
            finishedAtMs: Date.now(), status: 0, statusText: '', responseHeaders: [], mimeType: '',
            failed: true, errorText: String((error && error.message) || error), body: '', bodyNote: '',
          }));
        } catch (e) {}
        throw error;
      });
    };
  }

  if (typeof XMLHttpRequest !== 'undefined') {
    const proto = XMLHttpRequest.prototype;
    const nativeOpen = proto.open;
    const nativeSetHeader = proto.setRequestHeader;
    const nativeSend = proto.send;
    proto.open = function (method, url) {
      try { this.__bbaritCapture = { kind: 'xhr', method: String(method || 'GET').toUpperCase(), url: absolute(url), requestHeaders: [] }; } catch (e) {}
      return nativeOpen.apply(this, arguments);
    };
    proto.setRequestHeader = function (name, value) {
      try { if (this.__bbaritCapture) this.__bbaritCapture.requestHeaders.push([String(name), String(value)]); } catch (e) {}
      return nativeSetHeader.apply(this, arguments);
    };
    proto.send = function (body) {
      const captured = this.__bbaritCapture;
      if (captured) {
        try {
          const bodyInfo = requestBody(body);
          captured.startedAtMs = Date.now();
          captured.postData = bodyInfo.text;
          captured.postDataNote = bodyInfo.note;
          this.addEventListener('loadend', () => {
            try {
              const headers = [];
              String(this.getAllResponseHeaders() || '').split('\r\n').forEach((line) => {
                const at = line.indexOf(': ');
                if (at > 0) headers.push([line.slice(0, at), line.slice(at + 2)]);
              });
              const mimeHeader = headers.find((p) => p[0].toLowerCase() === 'content-type');
              const mime = String((mimeHeader && mimeHeader[1]) || '').split(';')[0].trim();
              let bodyText = '';
              let bodyNote = '';
              const type = String(this.responseType || '');
              if (type === '' || type === 'text') bodyText = clip(this.responseText);
              else bodyNote = '[responseType "' + type + '" body was not captured]';
              push(Object.assign({}, captured, {
                finishedAtMs: Date.now(),
                status: Number(this.status) || 0,
                statusText: String(this.statusText || ''),
                responseHeaders: headers,
                mimeType: mime,
                failed: Number(this.status) === 0,
                errorText: Number(this.status) === 0 ? 'network error or aborted' : '',
                body: bodyText,
                bodyNote,
              }));
            } catch (e) {}
          });
        } catch (e) {}
      }
      return nativeSend.apply(this, arguments);
    };
  }
})()
"#
}

pub fn open(
    app: &AppHandle,
    window_label: &str,
    url: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<u32, String> {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let window = app
        .get_window(window_label)
        .ok_or_else(|| format!("window '{window_label}' not found"))?;
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    let label = format!("cefweb-{window_label}-{id}");

    let app_nav = app.clone();
    let app_popup = app.clone();
    let app_load = app.clone();
    let app_title = app.clone();
    let app_download = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
        .initialization_script(network_capture_script())
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let dest = download_destination(&url);
                    {
                        let mut guard = ACTIVE_DOWNLOADS.lock().unwrap();
                        guard
                            .get_or_insert_with(HashMap::new)
                            .insert(url.to_string(), dest.clone());
                    }
                    let name = dest
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "download".to_string());
                    eprintln!("[webview-browser] download start id={id} -> {}", dest.display());
                    emit(
                        &app_download,
                        CefEvent {
                            kind: "download-start".into(),
                            id,
                            title: Some(name),
                            url: Some(dest.display().to_string()),
                            message: Some(url.to_string()),
                            loading: None,
                            can_go_back: None,
                            can_go_forward: None,
                        },
                    );
                    *destination = dest;
                }
                DownloadEvent::Finished { url, path, success } => {
                    let recorded = ACTIVE_DOWNLOADS
                        .lock()
                        .unwrap()
                        .as_mut()
                        .and_then(|m| m.remove(&url.to_string()));
                    let dest = path.or(recorded).unwrap_or_default();
                    let name = dest
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "download".to_string());
                    eprintln!(
                        "[webview-browser] download done id={id} success={success} path={}",
                        dest.display()
                    );
                    emit(
                        &app_download,
                        CefEvent {
                            kind: "download-done".into(),
                            id,
                            title: Some(name),
                            url: Some(dest.display().to_string()),
                            message: Some(if success { "success" } else { "failed" }.into()),
                            loading: None,
                            can_go_back: None,
                            can_go_forward: None,
                        },
                    );
                }
                _ => {}
            }
            true
        })
        .on_navigation(move |nav_url| {
            if nav_url.scheme() == "bbarit-eval-result" {
                let mut token = String::new();
                let mut payload = String::new();
                let mut index = String::from("0");
                let mut total = String::from("1");
                for (key, value) in nav_url.query_pairs() {
                    if key == "token" {
                        token = value.into_owned();
                    } else if key == "payload" {
                        payload = value.into_owned();
                    } else if key == "index" {
                        index = value.into_owned();
                    } else if key == "total" {
                        total = value.into_owned();
                    }
                }
                let message = serde_json::json!({
                    "index": index.parse::<usize>().unwrap_or(0),
                    "total": total.parse::<usize>().unwrap_or(1).max(1),
                    "payload": payload,
                })
                .to_string();
                emit(
                    &app_nav,
                    CefEvent {
                        kind: "eval-result".into(),
                        id,
                        title: Some(token),
                        url: None,
                        message: Some(message),
                        loading: None,
                        can_go_back: None,
                        can_go_forward: None,
                    },
                );
                return false;
            }
            if nav_url.scheme() == "bbarit-popup" {
                let popup_url = nav_url
                    .query_pairs()
                    .find_map(|(key, value)| (key == "url").then(|| value.into_owned()));
                if let Some(popup_url) = popup_url {
                    emit(
                        &app_nav,
                        CefEvent {
                            kind: "popup".into(),
                            id,
                            title: None,
                            url: Some(popup_url),
                            message: None,
                            loading: Some(true),
                            can_go_back: Some(false),
                            can_go_forward: Some(false),
                        },
                    );
                }
                return false;
            }
            // WKWebView/WebView2 report subframe navigations here as well (Naver
            // ads/shopsquare iframes are a common case). Do not treat this as the
            // tab URL; main-frame load events below own visible location state.
            true
        })
        .on_new_window(move |popup_url, _features| {
            emit(
                &app_popup,
                CefEvent {
                    kind: "popup".into(),
                    id,
                    title: None,
                    url: Some(popup_url.to_string()),
                    message: None,
                    loading: Some(true),
                    can_go_back: Some(false),
                    can_go_forward: Some(false),
                },
            );
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(move |_webview, payload| {
            let url = payload.url().to_string();
            let loading = payload.event() == PageLoadEvent::Started;
            if !loading {
                note_url(id, &url);
                let _ = _webview.eval(link_bridge_script());
            }
            emit_loading(&app_load, id, url, loading);
        })
        .on_document_title_changed(move |_webview, title| {
            let (changed, url, nav_count) = with_map(|m| {
                let Some(e) = m.get_mut(&id) else {
                    return (false, None, 0);
                };
                let changed = e.last_title != title;
                if changed {
                    e.last_title = title.clone();
                }
                (changed, Some(e.last_url.clone()), e.nav_count)
            });
            if changed {
                emit(
                    &app_title,
                    CefEvent {
                        kind: "title".into(),
                        id,
                        title: Some(title),
                        url,
                        message: None,
                        loading: Some(false),
                        can_go_back: Some(nav_count > 0),
                        can_go_forward: Some(false),
                    },
                );
            }
        })
        .incognito(false);

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(w.max(1.0), h.max(1.0)),
        )
        .map_err(|e| format!("add_child failed: {e}"))?;
    let _ = webview.set_focus();

    with_map(|m| {
        m.insert(
            id,
            Entry {
                webview_label: label.clone(),
                zoom_level: 0.0,
                last_url: url.to_string(),
                last_title: String::new(),
                nav_count: 0,
            },
        );
    });

    emit(
        app,
        CefEvent {
            kind: "created".into(),
            id,
            title: None,
            url: Some(url.to_string()),
            message: None,
            loading: Some(true),
            can_go_back: Some(false),
            can_go_forward: Some(false),
        },
    );
    eprintln!("[webview-browser] open id={id} label={label} url={url}");
    Ok(id)
}

pub fn navigate(app: &AppHandle, id: u32, url: &str) -> Result<(), String> {
    let webview = webview_of(app, id).ok_or("browser not found")?;
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    webview.navigate(parsed).map_err(|e| e.to_string())
}

pub fn nav_action(app: &AppHandle, id: u32, action: &str) -> Result<(), String> {
    let webview = webview_of(app, id).ok_or("browser not found")?;
    match action {
        "back" => webview.eval("history.back()"),
        "forward" => webview.eval("history.forward()"),
        "reload" => webview.eval("location.reload()"),
        "stop" => webview.eval("window.stop()"),
        _ => Ok(()),
    }
    .map_err(|e| e.to_string())
}

pub fn set_bounds(app: &AppHandle, id: u32, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let webview = webview_of(app, id).ok_or("browser not found")?;
    webview
        .set_bounds(Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(w.max(1.0), h.max(1.0)).into(),
        })
        .map_err(|e| e.to_string())
}

pub fn set_visible(app: &AppHandle, id: u32, visible: bool) -> Result<(), String> {
    let webview = webview_of(app, id).ok_or("browser not found")?;
    if visible {
        webview.show().map_err(|e| e.to_string())?;
        let _ = webview.set_focus();
        Ok(())
    } else {
        webview.hide().map_err(|e| e.to_string())
    }
}

pub fn zoom(app: &AppHandle, id: u32, action: &str) -> Result<f64, String> {
    let webview = webview_of(app, id).ok_or("browser not found")?;
    let level = with_map(|m| {
        let Some(e) = m.get_mut(&id) else { return 0.0 };
        e.zoom_level = match action {
            "in" => e.zoom_level + 0.5,
            "out" => e.zoom_level - 0.5,
            _ => 0.0,
        };
        e.zoom_level
    });
    let factor = 1.2f64.powf(level);
    webview.set_zoom(factor).map_err(|e| e.to_string())?;
    Ok(level)
}

pub fn find(
    app: &AppHandle,
    id: u32,
    query: &str,
    forward: bool,
    _find_next: bool,
) -> Result<(), String> {
    let webview = webview_of(app, id).ok_or("browser not found")?;
    if query.is_empty() {
        return webview
            .eval("window.getSelection()?.removeAllRanges()")
            .map_err(|e| e.to_string());
    }
    let q = serde_json::to_string(query).map_err(|e| e.to_string())?;
    let backwards = if forward { "false" } else { "true" };
    webview
        .eval(format!(
            "window.find({q}, false, {backwards}, true, false, true, false)"
        ))
        .map_err(|e| e.to_string())
}

pub fn eval(app: &AppHandle, id: u32, script: &str) -> Result<(), String> {
    let webview = webview_of(app, id).ok_or("browser not found")?;
    webview.eval(script).map_err(|e| e.to_string())
}

pub fn devtools(app: &AppHandle, id: u32, show: bool) -> Result<(), String> {
    let _webview = webview_of(app, id).ok_or("browser not found")?;
    #[cfg(debug_assertions)]
    {
        if show {
            _webview.open_devtools();
        } else {
            _webview.close_devtools();
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = show;
    }
    Ok(())
}

pub fn close(app: &AppHandle, id: u32) -> Result<(), String> {
    let webview = webview_of(app, id);
    with_map(|m| {
        m.remove(&id);
    });
    if let Some(webview) = webview {
        let _ = webview.close();
    }
    emit(
        app,
        CefEvent {
            kind: "closed".into(),
            id,
            title: None,
            url: None,
            message: None,
            loading: None,
            can_go_back: None,
            can_go_forward: None,
        },
    );
    Ok(())
}

/// 임포트한 쿠키 한 벌을 이 webview의 네이티브 쿠키 스토어에 넣는다.
///
/// document.cookie로는 HttpOnly 로그인 쿠키를 넣지 못하므로, wry가 노출하는
/// 네이티브 API(WKHTTPCookieStore / WebView2 CookieManager)를 쓰는 set_cookie로
/// 주입한다. 도메인 스코프라 지금 열린 탭이 어느 사이트든 상관없이 저장된다.
/// 반환값은 (성공 수, 실패 수).
pub fn set_cookies(app: &AppHandle, id: u32, cookies: Vec<ImportCookie>) -> Result<(u32, u32), String> {
    use tauri::webview::cookie::{time::OffsetDateTime, Cookie, Expiration, SameSite};

    let webview = webview_of(app, id).ok_or_else(|| "browser tab not found".to_string())?;
    let mut ok = 0u32;
    let mut failed = 0u32;
    for c in cookies {
        if c.name.is_empty() || c.host.is_empty() {
            failed += 1;
            continue;
        }
        let mut builder = Cookie::build((c.name, c.value))
            .domain(c.host)
            .path(if c.path.is_empty() { "/".to_string() } else { c.path })
            .secure(c.secure)
            .http_only(c.http_only);
        builder = match c.same_site {
            2 => builder.same_site(SameSite::Strict),
            1 => builder.same_site(SameSite::Lax),
            _ => builder.same_site(SameSite::None),
        };
        let mut cookie: Cookie = builder.build();
        // expires는 Unix epoch ms. 0/과거는 세션 쿠키로 둔다.
        if c.expires > 0 {
            if let Ok(when) = OffsetDateTime::from_unix_timestamp(c.expires / 1000) {
                cookie.set_expires(Expiration::DateTime(when));
            }
        }
        match webview.set_cookie(cookie) {
            Ok(()) => ok += 1,
            Err(_) => failed += 1,
        }
    }
    Ok((ok, failed))
}

pub fn set_download_dir(dir: String) {
    let mut guard = DOWNLOAD_DIR.lock().unwrap();
    *guard = if dir.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(dir))
    };
}

pub fn list(app: &AppHandle) -> Vec<(u32, String, String)> {
    with_map(|m| {
        let dead: Vec<u32> = m
            .iter()
            .filter_map(|(id, e)| app.get_webview(&e.webview_label).is_none().then_some(*id))
            .collect();
        for id in dead {
            m.remove(&id);
        }
        m.iter()
            .map(|(id, e)| (*id, e.last_url.clone(), e.last_title.clone()))
            .collect()
    })
}
