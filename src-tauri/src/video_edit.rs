//! 영상 에디터 내보내기 — 시스템 ffmpeg 기반 클립 트림/병합.
//!
//! D1: ffmpeg는 번들하지 않고 시스템 설치본을 사용한다 (용량 +70MB / GPL 라이선스 회피).
//!     미설치 시 `video_ffmpeg_check`가 Err를 반환하고 프론트가 설치 안내를 띄운다.
//!     탈출구: 추후 tauri sidecar 번들로 전환 가능.
//! D2: 클립마다 공통 파라미터(해상도/fps/48kHz 스테레오)로 재인코딩한 뒤 concat demuxer
//!     `-c copy`로 잇는다. 서로 다른 소스(해상도/코덱)가 섞여도 안전하다.
//!     비용: 재인코딩 시간. 탈출구: 단일 소스 편집은 스트림카피 세그먼트로 최적화 가능.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Emitter;

use crate::common::{get_env_value, no_window_command};

static EXPORT_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize)]
pub struct VideoClipSpec {
    pub path: String,
    #[serde(rename = "inSec")]
    pub in_sec: f64,
    #[serde(rename = "outSec")]
    pub out_sec: f64,
}

#[derive(Debug, Clone, Serialize)]
struct ExportProgress {
    /// "clip" | "concat" | "done"
    phase: String,
    index: usize,
    total: usize,
}

/// 해당 바이너리가 우리 export 명령을 실제로 돌릴 수 있는 ffmpeg인지 기능 검사한다.
/// 존재/버전 확인만으로는 부족하다 — PATH에 2013년 pip 스텁이 걸린 실기계에서
/// `-hide_banner`·최신 scale 옵션을 몰라 export만 실패하는 사례를 실측했다.
/// 그래서 프로브는 실제 export와 동일한 옵션 조합(-hide_banner + scale/pad/fps)을 쓴다.
fn ffmpeg_works(bin: &str) -> bool {
    let version_ok = no_window_command(bin)
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !version_ok {
        return false;
    }
    no_window_command(bin)
        .args([
            "-hide_banner",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=64x64:d=0.1",
            "-vf",
            "scale=32:32:force_original_aspect_ratio=decrease,pad=32:32:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30",
            "-f",
            "null",
            "-",
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// PATH 밖에 설치된 ffmpeg 후보를 찾는다.
/// Windows: winget(Gyan.FFmpeg) 패키지 폴더. macOS: GUI 앱은 brew PATH를 못 받으므로
/// homebrew 표준 경로를 직접 확인한다.
fn find_fallback_ffmpeg() -> Option<String> {
    #[cfg(windows)]
    {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        let pkgs = std::path::Path::new(&local).join("Microsoft\\WinGet\\Packages");
        for entry in std::fs::read_dir(&pkgs).ok()?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("Gyan.FFmpeg") {
                continue;
            }
            if let Ok(subs) = std::fs::read_dir(entry.path()) {
                for sub in subs.flatten() {
                    let cand = sub.path().join("bin").join("ffmpeg.exe");
                    if cand.exists() {
                        return Some(cand.to_string_lossy().to_string());
                    }
                }
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        for cand in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"] {
            if std::path::Path::new(cand).exists() {
                return Some(cand.to_string());
            }
        }
        None
    }
}

/// ffmpeg 바이너리 해석 순서: `BBARIT_FFMPEG` env(매번 재확인) → PATH의 ffmpeg(동작 검증)
/// → winget/homebrew 폴백. 발견 결과는 프로세스 수명 동안 캐시한다.
fn ffmpeg_bin() -> String {
    if let Some(v) = get_env_value("BBARIT_FFMPEG") {
        return v;
    }
    static RESOLVED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            if ffmpeg_works("ffmpeg") {
                return "ffmpeg".to_string();
            }
            if let Some(p) = find_fallback_ffmpeg() {
                if ffmpeg_works(&p) {
                    return p;
                }
            }
            "ffmpeg".to_string()
        })
        .clone()
}

fn run_ffmpeg(args: &[String]) -> Result<(), String> {
    let output = no_window_command(ffmpeg_bin())
        .args(args)
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {}", e))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail: String = stderr
        .lines()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!("ffmpeg error (exit {:?}):\n{}", output.status.code(), tail))
}

#[tauri::command]
pub fn video_ffmpeg_check() -> Result<String, String> {
    let output = no_window_command(ffmpeg_bin())
        .arg("-version")
        .output()
        .map_err(|e| format!("ffmpeg not found: {}", e))?;
    if !output.status.success() {
        return Err("ffmpeg not available".to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().next().unwrap_or("ffmpeg").to_string())
}

/// 클립 하나를 공통 파라미터 세그먼트로 재인코딩한다.
fn encode_segment(
    clip: &VideoClipSpec,
    dest: &PathBuf,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<(), String> {
    if !std::path::Path::new(&clip.path).exists() {
        return Err(format!("source file not found: {}", clip.path));
    }
    let dur = clip.out_sec - clip.in_sec;
    if !(dur > 0.01) {
        return Err(format!("invalid clip duration: {:.2}s", dur));
    }
    // 홀수 해상도는 yuv420p 인코딩이 거부하므로 짝수로 내림
    let w = (width.max(2) / 2) * 2;
    let h = (height.max(2) / 2) * 2;
    let vf = format!(
        "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}"
    );
    let args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        format!("{:.3}", clip.in_sec.max(0.0)),
        "-i".into(),
        clip.path.clone(),
        "-t".into(),
        format!("{:.3}", dur),
        "-vf".into(),
        vf,
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "18".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        // 구버전 ffmpeg는 내장 aac가 experimental이라 -strict -2가 없으면 거부한다.
        // 최신 빌드에서도 무해하게 허용되는 플래그.
        "-strict".into(),
        "-2".into(),
        "-b:a".into(),
        "192k".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-movflags".into(),
        "+faststart".into(),
        dest.to_string_lossy().to_string(),
    ];
    run_ffmpeg(&args)
}

/// 타임라인 클립들을 순서대로 이어 하나의 mp4로 내보낸다.
/// 진행 상황은 `video-export-progress` 이벤트로 프론트에 전달된다.
#[tauri::command]
pub async fn video_export_clips(
    app: tauri::AppHandle,
    clips: Vec<VideoClipSpec>,
    output_path: String,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<String, String> {
    if clips.is_empty() {
        return Err("no clips to export".to_string());
    }
    if output_path.trim().is_empty() {
        return Err("output path is empty".to_string());
    }

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let total = clips.len();
        let seq = EXPORT_SEQ.fetch_add(1, Ordering::SeqCst);
        let temp_dir = std::env::temp_dir().join(format!(
            "bbarit-video-export-{}-{}",
            std::process::id(),
            seq
        ));
        std::fs::create_dir_all(&temp_dir).map_err(|e| format!("failed to create temp dir: {}", e))?;

        // 실패해도 임시 폴더는 지우고 나가도록 클로저로 감싼다
        let work = || -> Result<String, String> {
            let fps = if fps == 0 { 30 } else { fps.min(120) };

            // 클립 1개면 concat 없이 바로 출력 파일로 인코딩
            if total == 1 {
                let _ = app.emit(
                    "video-export-progress",
                    ExportProgress { phase: "clip".into(), index: 0, total },
                );
                encode_segment(&clips[0], &PathBuf::from(&output_path), width, height, fps)?;
                let _ = app.emit(
                    "video-export-progress",
                    ExportProgress { phase: "done".into(), index: total, total },
                );
                return Ok(output_path.clone());
            }

            let mut list_lines: Vec<String> = Vec::with_capacity(total);
            for (i, clip) in clips.iter().enumerate() {
                let _ = app.emit(
                    "video-export-progress",
                    ExportProgress { phase: "clip".into(), index: i, total },
                );
                let seg = temp_dir.join(format!("seg_{:04}.mp4", i));
                encode_segment(clip, &seg, width, height, fps)?;
                // list.txt와 같은 폴더의 상대 파일명이라 경로 이스케이프 문제가 없다
                list_lines.push(format!("file 'seg_{:04}.mp4'", i));
            }

            let list_path = temp_dir.join("list.txt");
            std::fs::write(&list_path, list_lines.join("\n") + "\n")
                .map_err(|e| format!("failed to write concat list: {}", e))?;

            let _ = app.emit(
                "video-export-progress",
                ExportProgress { phase: "concat".into(), index: total, total },
            );
            let concat_args: Vec<String> = vec![
                "-y".into(),
                "-hide_banner".into(),
                "-loglevel".into(),
                "error".into(),
                "-f".into(),
                "concat".into(),
                "-safe".into(),
                "0".into(),
                "-i".into(),
                list_path.to_string_lossy().to_string(),
                "-c".into(),
                "copy".into(),
                "-movflags".into(),
                "+faststart".into(),
                output_path.clone(),
            ];
            run_ffmpeg(&concat_args)?;

            let _ = app.emit(
                "video-export-progress",
                ExportProgress { phase: "done".into(), index: total, total },
            );
            Ok(output_path.clone())
        };

        let result = work();
        let _ = std::fs::remove_dir_all(&temp_dir);
        result
    })
    .await
    .map_err(|e| format!("export task failed: {}", e))?;

    result
}
