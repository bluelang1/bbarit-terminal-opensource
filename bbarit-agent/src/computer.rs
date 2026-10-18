//! Computer use — 데스크톱 전체를 보고(스크린샷) 조작(마우스·키보드)하는 툴.
//! 스크린샷은 논리 해상도 기준으로 리스케일해 저장하고, 모델이 주는 좌표는
//! "스크린샷 픽셀" 기준 → 클릭 시 화면 포인트로 환산한다. 이미지는 툴 결과의
//! ATTACH_IMAGE_MARKER를 통해 다음 user 메시지에 첨부되어 모델에 전달된다.
//!
//! macOS는 손쉬운 사용(Accessibility) 권한이 없으면 CGEvent가 소리 없이
//! 버려진다 — 클릭/타이핑이 무반응이면 권한 안내를 에러로 돌려준다.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde_json::Value;

use crate::config::AppConfig;

/// 툴 결과에 이 마커가 있으면 에이전트 루프가 마커를 걷어내고 해당 이미지를
/// 다음 user 메시지에 첨부한다 (툴 결과 자체는 텍스트 전용이라서).
pub const ATTACH_IMAGE_MARKER: &str = "[[bbarit-attach-image:";
pub const ATTACH_IMAGE_MARKER_END: &str = "]]";

/// 스크린샷 최대 폭 (px) — 비전 토큰 비용과 좌표 정밀도의 절충.
const MAX_SCREENSHOT_WIDTH: u32 = 1456;

/// 마지막 스크린샷의 (이미지 px → 화면 포인트) 배율. 스크린샷 없이 클릭하면 1.0.
static LAST_SCALE: Mutex<(f64, f64)> = Mutex::new((1.0, 1.0));

pub fn computer_action_is_readonly(action: &str) -> bool {
    matches!(action, "screenshot" | "")
}

/// 컴퓨터유즈 활성 토글 변수 (~/.config/octo/.env 또는 프로세스 env).
pub const COMPUTER_USE_ENV: &str = "BBARIT_COMPUTER_USE";

/// 옵트인: /computer on을 해야 computer 툴이 모델에 노출된다. 데스크톱 전체를
/// 제어하는 강한 능력이라 기본은 꺼짐.
pub fn computer_use_enabled() -> bool {
    crate::config::octo_env_var(COMPUTER_USE_ENV)
        .and_then(|value| parse_toggle(&value))
        .unwrap_or(false)
}

/// "on"/"off"류 토글 문자열 파싱. 순수 함수 — 테스트 대상.
pub fn parse_toggle(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "on" | "true" | "yes" | "enable" | "enabled" => Some(true),
        "0" | "off" | "false" | "no" | "disable" | "disabled" => Some(false),
        _ => None,
    }
}

/// 토글을 ~/.config/octo/.env에 저장한다 (켜면 1, 끄면 라인 제거).
pub fn set_computer_use_enabled(enabled: bool) -> Result<()> {
    crate::config::set_octo_env_var(COMPUTER_USE_ENV, enabled.then_some("1"))
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn int_arg(args: &Value, key: &str) -> Option<i32> {
    args.get(key)
        .and_then(Value::as_i64)
        .map(|v| v as i32)
        .or_else(|| {
            args.get(key)
                .and_then(Value::as_f64)
                .map(|v| v.round() as i32)
        })
}

fn enigo() -> Result<enigo::Enigo> {
    enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| {
        anyhow!(
            "cannot initialize input control: {e}{}",
            accessibility_hint()
        )
    })
}

fn accessibility_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        " — on macOS grant Accessibility permission to the host app (System Settings → \
         Privacy & Security → Accessibility → enable BBARIT Terminal / your terminal), \
         then retry"
    } else {
        ""
    }
}

/// 모델 좌표(스크린샷 px) → 화면 포인트.
fn to_screen(x: i32, y: i32) -> (i32, i32) {
    let (sx, sy) = LAST_SCALE.lock().map(|g| *g).unwrap_or((1.0, 1.0));
    (
        (f64::from(x) * sx).round() as i32,
        (f64::from(y) * sy).round() as i32,
    )
}

pub fn execute(config: &AppConfig, args: &Value) -> Result<String> {
    if !computer_use_enabled() {
        bail!("computer use is disabled — the user can enable it with /computer on");
    }
    let action = str_arg(args, "action")
        .ok_or_else(|| anyhow!(
            "computer: 'action' is required (screenshot|click|double_click|right_click|move|drag|type|key|scroll)"
        ))?;
    match action {
        "screenshot" => screenshot(config),
        "click" | "double_click" | "right_click" | "middle_click" => click(args, action),
        "move" => mouse_move(args),
        "drag" => drag(args),
        "type" => type_text(args),
        "key" => key_combo(args),
        "scroll" => scroll(args),
        other => bail!("computer: unknown action '{other}'"),
    }
}

fn screenshot_path(config: &AppConfig) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    config
        .cwd
        .join("computer-use")
        .join(format!("screen-{stamp}.png"))
}

#[cfg(target_os = "macos")]
fn capture_screen(path: &std::path::Path) -> Result<()> {
    // -x 무음, -m 메인 디스플레이만 (멀티 모니터에서 좌표계가 메인 기준이라).
    let status = std::process::Command::new("screencapture")
        .args(["-x", "-m"])
        .arg(path)
        .status()?;
    if !status.success() {
        bail!(
            "screencapture failed ({status}) — grant Screen Recording permission to the host app (System Settings → Privacy & Security → Screen Recording)"
        );
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn capture_screen(path: &std::path::Path) -> Result<()> {
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \
         $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; \
         $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; \
         $g=[System.Drawing.Graphics]::FromImage($bmp); \
         $g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size); \
         $bmp.Save('{}',[System.Drawing.Imaging.ImageFormat]::Png)",
        path.display()
    );
    let status = crate::spawn::no_window_command("powershell")
        .args(["-NoProfile", "-Command", &script])
        .status()?;
    if !status.success() {
        bail!("powershell screenshot failed ({status})");
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn capture_screen(_path: &std::path::Path) -> Result<()> {
    bail!("computer screenshot is not supported on this platform yet")
}

#[cfg(target_os = "macos")]
fn image_pixel_size(path: &std::path::Path) -> Result<(u32, u32)> {
    let output = std::process::Command::new("sips")
        .args(["-g", "pixelWidth", "-g", "pixelHeight"])
        .arg(path)
        .output()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let get = |key: &str| -> Option<u32> {
        text.lines()
            .find(|line| line.contains(key))
            .and_then(|line| line.split(':').nth(1))
            .and_then(|v| v.trim().parse().ok())
    };
    match (get("pixelWidth"), get("pixelHeight")) {
        (Some(w), Some(h)) => Ok((w, h)),
        _ => bail!("cannot read screenshot dimensions"),
    }
}

#[cfg(target_os = "macos")]
fn resize_image_width(path: &std::path::Path, width: u32) -> Result<()> {
    let status = std::process::Command::new("sips")
        .args(["--resampleWidth", &width.to_string()])
        .arg(path)
        .stdout(std::process::Stdio::null())
        .status()?;
    if !status.success() {
        bail!("sips resize failed ({status})");
    }
    Ok(())
}

/// 메인 디스플레이의 논리 크기(포인트). macOS는 권한이 필요 없는 CoreGraphics로
/// 직접 읽는다 — enigo 초기화는 Accessibility 권한을 요구해 스크린샷(관찰)까지
/// 막아버린다.
fn main_display_size() -> Result<(i32, i32)> {
    #[cfg(target_os = "macos")]
    {
        let bounds = core_graphics::display::CGDisplay::main().bounds();
        return Ok((bounds.size.width as i32, bounds.size.height as i32));
    }
    #[cfg(not(target_os = "macos"))]
    {
        use enigo::Mouse as _;
        let e = enigo()?;
        e.main_display().map_err(|err| anyhow!("{err}"))
    }
}

fn screenshot(config: &AppConfig) -> Result<String> {
    let path = screenshot_path(config);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    capture_screen(&path)?;

    // 화면 논리 크기 (마우스 좌표계).
    let (logical_w, logical_h) = main_display_size()?;

    #[cfg(target_os = "macos")]
    {
        // 레티나(2x) 픽셀 → 목표 폭으로 리샘플. 좌표계는 스크린샷 px 기준으로
        // 통일하고 배율만 기억해 클릭 시 포인트로 환산한다.
        let target_w = u32::try_from(logical_w.max(1))
            .unwrap_or(MAX_SCREENSHOT_WIDTH)
            .min(MAX_SCREENSHOT_WIDTH);
        resize_image_width(&path, target_w)?;
        let (img_w, img_h) = image_pixel_size(&path)?;
        if let Ok(mut guard) = LAST_SCALE.lock() {
            *guard = (
                f64::from(logical_w) / f64::from(img_w.max(1)),
                f64::from(logical_h) / f64::from(img_h.max(1)),
            );
        }
        return Ok(format!(
            "Screenshot of the main display ({logical_w}x{logical_h} points) saved to {} \
             as {img_w}x{img_h}px.\nGive all computer coordinates in SCREENSHOT pixels \
             (0,0 = top-left) — they are mapped to the screen automatically.\n\
             {ATTACH_IMAGE_MARKER}{}{ATTACH_IMAGE_MARKER_END}",
            path.display(),
            path.display(),
        ));
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(mut guard) = LAST_SCALE.lock() {
            *guard = (1.0, 1.0);
        }
        Ok(format!(
            "Screenshot of the screen ({logical_w}x{logical_h}) saved to {}.\nGive all \
             computer coordinates in screenshot pixels (0,0 = top-left).\n\
             {ATTACH_IMAGE_MARKER}{}{ATTACH_IMAGE_MARKER_END}",
            path.display(),
            path.display(),
        ))
    }
}

fn require_xy(args: &Value) -> Result<(i32, i32)> {
    match (int_arg(args, "x"), int_arg(args, "y")) {
        (Some(x), Some(y)) => Ok((x, y)),
        _ => bail!("computer: 'x' and 'y' (screenshot pixels) are required"),
    }
}

fn click(args: &Value, action: &str) -> Result<String> {
    use enigo::{Button, Direction, Mouse as _};
    let (x, y) = require_xy(args)?;
    let (sx, sy) = to_screen(x, y);
    let mut e = enigo()?;
    e.move_mouse(sx, sy, enigo::Coordinate::Abs)
        .map_err(|err| anyhow!("{err}{}", accessibility_hint()))?;
    std::thread::sleep(Duration::from_millis(60));
    let button = match action {
        "right_click" => Button::Right,
        "middle_click" => Button::Middle,
        _ => Button::Left,
    };
    let clicks = if action == "double_click" { 2 } else { 1 };
    for i in 0..clicks {
        if i > 0 {
            std::thread::sleep(Duration::from_millis(80));
        }
        e.button(button, Direction::Click)
            .map_err(|err| anyhow!("{err}{}", accessibility_hint()))?;
    }
    Ok(format!(
        "{action} at ({x}, {y}) [screen point ({sx}, {sy})]. Take a screenshot to verify the result."
    ))
}

fn mouse_move(args: &Value) -> Result<String> {
    use enigo::Mouse as _;
    let (x, y) = require_xy(args)?;
    let (sx, sy) = to_screen(x, y);
    enigo()?
        .move_mouse(sx, sy, enigo::Coordinate::Abs)
        .map_err(|err| anyhow!("{err}{}", accessibility_hint()))?;
    Ok(format!("Moved the mouse to ({x}, {y})."))
}

fn drag(args: &Value) -> Result<String> {
    use enigo::{Button, Direction, Mouse as _};
    let (x, y) = require_xy(args)?;
    let (x2, y2) = match (int_arg(args, "x2"), int_arg(args, "y2")) {
        (Some(x2), Some(y2)) => (x2, y2),
        _ => bail!("computer drag: 'x2' and 'y2' are required"),
    };
    let (sx, sy) = to_screen(x, y);
    let (sx2, sy2) = to_screen(x2, y2);
    let mut e = enigo()?;
    e.move_mouse(sx, sy, enigo::Coordinate::Abs)
        .map_err(|err| anyhow!("{err}{}", accessibility_hint()))?;
    std::thread::sleep(Duration::from_millis(80));
    e.button(Button::Left, Direction::Press)
        .map_err(|err| anyhow!("{err}"))?;
    // 중간 지점을 거쳐 이동해야 드래그로 인식하는 앱이 많다.
    let steps = 8;
    for i in 1..=steps {
        let ix = sx + (sx2 - sx) * i / steps;
        let iy = sy + (sy2 - sy) * i / steps;
        e.move_mouse(ix, iy, enigo::Coordinate::Abs)
            .map_err(|err| anyhow!("{err}"))?;
        std::thread::sleep(Duration::from_millis(25));
    }
    e.button(Button::Left, Direction::Release)
        .map_err(|err| anyhow!("{err}"))?;
    Ok(format!("Dragged from ({x}, {y}) to ({x2}, {y2})."))
}

fn type_text(args: &Value) -> Result<String> {
    use enigo::Keyboard as _;
    let text = str_arg(args, "text").ok_or_else(|| anyhow!("computer type: 'text' is required"))?;
    enigo()?
        .text(text)
        .map_err(|err| anyhow!("{err}{}", accessibility_hint()))?;
    Ok(format!("Typed {} character(s).", text.chars().count()))
}

/// "cmd+shift+t", "enter", "ctrl+c" 같은 콤보 파싱. 순수 함수 — 테스트 대상.
pub fn parse_key_combo(combo: &str) -> Result<(Vec<enigo::Key>, enigo::Key)> {
    use enigo::Key;
    let parts: Vec<String> = combo
        .split('+')
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        bail!("computer key: 'key' is required (e.g. \"enter\", \"cmd+c\", \"ctrl+shift+t\")");
    }
    let mut modifiers = Vec::new();
    let mut main: Option<Key> = None;
    let count = parts.len();
    for (index, part) in parts.iter().enumerate() {
        let is_last = index + 1 == count;
        let as_modifier = match part.as_str() {
            "cmd" | "command" | "meta" | "super" | "win" => Some(Key::Meta),
            "ctrl" | "control" => Some(Key::Control),
            "alt" | "option" | "opt" => Some(Key::Alt),
            "shift" => Some(Key::Shift),
            _ => None,
        };
        if let Some(modifier) = as_modifier
            && !is_last
        {
            modifiers.push(modifier);
            continue;
        }
        let key = match part.as_str() {
            "enter" | "return" => Key::Return,
            "tab" => Key::Tab,
            "esc" | "escape" => Key::Escape,
            "space" => Key::Space,
            "backspace" => Key::Backspace,
            "delete" | "del" => Key::Delete,
            "up" => Key::UpArrow,
            "down" => Key::DownArrow,
            "left" => Key::LeftArrow,
            "right" => Key::RightArrow,
            "home" => Key::Home,
            "end" => Key::End,
            "pageup" => Key::PageUp,
            "pagedown" => Key::PageDown,
            "f1" => Key::F1,
            "f2" => Key::F2,
            "f3" => Key::F3,
            "f4" => Key::F4,
            "f5" => Key::F5,
            "f6" => Key::F6,
            "f7" => Key::F7,
            "f8" => Key::F8,
            "f9" => Key::F9,
            "f10" => Key::F10,
            "f11" => Key::F11,
            "f12" => Key::F12,
            "cmd" | "command" | "meta" | "super" | "win" => Key::Meta,
            "ctrl" | "control" => Key::Control,
            "alt" | "option" | "opt" => Key::Alt,
            "shift" => Key::Shift,
            single if single.chars().count() == 1 => Key::Unicode(single.chars().next().unwrap()),
            other => bail!("computer key: unknown key '{other}'"),
        };
        main = Some(key);
    }
    let main = main.ok_or_else(|| anyhow!("computer key: no main key in '{combo}'"))?;
    Ok((modifiers, main))
}

fn key_combo(args: &Value) -> Result<String> {
    use enigo::{Direction, Keyboard as _};
    let combo = str_arg(args, "key").ok_or_else(|| {
        anyhow!("computer key: 'key' is required (e.g. \"enter\", \"cmd+c\", \"ctrl+shift+t\")")
    })?;
    let (modifiers, main) = parse_key_combo(combo)?;
    let mut e = enigo()?;
    for modifier in &modifiers {
        e.key(*modifier, Direction::Press)
            .map_err(|err| anyhow!("{err}{}", accessibility_hint()))?;
    }
    let result = e.key(main, Direction::Click);
    for modifier in modifiers.iter().rev() {
        let _ = e.key(*modifier, Direction::Release);
    }
    result.map_err(|err| anyhow!("{err}{}", accessibility_hint()))?;
    Ok(format!("Pressed {combo}."))
}

fn scroll(args: &Value) -> Result<String> {
    use enigo::{Axis, Mouse as _};
    let mut e = enigo()?;
    if let (Some(x), Some(y)) = (int_arg(args, "x"), int_arg(args, "y")) {
        let (sx, sy) = to_screen(x, y);
        e.move_mouse(sx, sy, enigo::Coordinate::Abs)
            .map_err(|err| anyhow!("{err}{}", accessibility_hint()))?;
        std::thread::sleep(Duration::from_millis(50));
    }
    let amount = int_arg(args, "amount").unwrap_or(3).clamp(1, 30);
    let direction = str_arg(args, "direction").unwrap_or("down");
    let (axis, delta) = match direction {
        "up" => (Axis::Vertical, -amount),
        "down" => (Axis::Vertical, amount),
        "left" => (Axis::Horizontal, -amount),
        "right" => (Axis::Horizontal, amount),
        other => bail!("computer scroll: direction must be up|down|left|right (got '{other}')"),
    };
    e.scroll(delta, axis)
        .map_err(|err| anyhow!("{err}{}", accessibility_hint()))?;
    Ok(format!("Scrolled {direction} by {amount}."))
}

/// 툴 결과에서 첨부 마커를 걷어내고 (정리된 텍스트, 이미지 경로들)을 돌려준다.
/// 순수 함수 — 에이전트 루프가 사용.
pub fn extract_image_attachments(result: &str) -> (String, Vec<String>) {
    let mut cleaned = String::with_capacity(result.len());
    let mut paths = Vec::new();
    let mut rest = result;
    while let Some(start) = rest.find(ATTACH_IMAGE_MARKER) {
        cleaned.push_str(&rest[..start]);
        let after = &rest[start + ATTACH_IMAGE_MARKER.len()..];
        match after.find(ATTACH_IMAGE_MARKER_END) {
            Some(end) => {
                let path = after[..end].trim();
                if !path.is_empty() {
                    paths.push(path.to_string());
                }
                rest = &after[end + ATTACH_IMAGE_MARKER_END.len()..];
            }
            None => {
                rest = after;
                break;
            }
        }
    }
    cleaned.push_str(rest);
    (cleaned.trim_end().to_string(), paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_image_attachments_strips_markers_and_collects_paths() {
        let input = format!(
            "Screenshot saved.\n{ATTACH_IMAGE_MARKER}/tmp/a.png{ATTACH_IMAGE_MARKER_END}\nmore\n{ATTACH_IMAGE_MARKER}/tmp/b.png{ATTACH_IMAGE_MARKER_END}"
        );
        let (cleaned, paths) = extract_image_attachments(&input);
        assert_eq!(paths, vec!["/tmp/a.png", "/tmp/b.png"]);
        assert!(!cleaned.contains("bbarit-attach-image"));
        assert!(cleaned.contains("Screenshot saved."));
        assert!(cleaned.contains("more"));
    }

    #[test]
    fn extract_image_attachments_passes_plain_text_through() {
        let (cleaned, paths) = extract_image_attachments("no markers here");
        assert_eq!(cleaned, "no markers here");
        assert!(paths.is_empty());
    }

    #[test]
    fn parse_key_combo_handles_modifiers_and_aliases() {
        use enigo::Key;
        let (mods, main) = parse_key_combo("cmd+shift+t").unwrap();
        assert_eq!(mods, vec![Key::Meta, Key::Shift]);
        assert_eq!(main, Key::Unicode('t'));
        let (mods, main) = parse_key_combo("enter").unwrap();
        assert!(mods.is_empty());
        assert_eq!(main, Key::Return);
        // 수식키 단독 입력도 허용 (예: "cmd")
        let (mods, main) = parse_key_combo("cmd").unwrap();
        assert!(mods.is_empty());
        assert_eq!(main, Key::Meta);
        assert!(parse_key_combo("cmd+definitely-not-a-key").is_err());
    }

    #[test]
    fn computer_readonly_actions() {
        assert!(computer_action_is_readonly("screenshot"));
        assert!(!computer_action_is_readonly("click"));
        assert!(!computer_action_is_readonly("type"));
    }

    #[test]
    fn parse_toggle_accepts_common_forms() {
        assert_eq!(parse_toggle("on"), Some(true));
        assert_eq!(parse_toggle("1"), Some(true));
        assert_eq!(parse_toggle("TRUE"), Some(true));
        assert_eq!(parse_toggle("off"), Some(false));
        assert_eq!(parse_toggle("0"), Some(false));
        assert_eq!(parse_toggle("maybe"), None);
    }
}
