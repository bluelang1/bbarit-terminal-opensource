use std::path::PathBuf;
use std::process::Command;

/// 내장 Shannon 경로를 탐색하여 반환
fn resolve_shannon_path(shannon_path: &str) -> Result<PathBuf, String> {
    // 1. 명시적으로 전달된 경로
    if !shannon_path.is_empty() {
        let p = PathBuf::from(shannon_path);
        if p.join("shannon").exists() {
            return Ok(p);
        }
        return Err(format!("Shannon 실행 파일을 찾을 수 없습니다: {}/shannon", shannon_path));
    }

    // 2. 환경변수 SHANNON_PATH
    if let Ok(env_path) = std::env::var("SHANNON_PATH") {
        let p = PathBuf::from(&env_path);
        if p.join("shannon").exists() {
            return Ok(p);
        }
    }

    // 3. 실행 파일 기준 내장 shannon/ 디렉토리 탐색
    if let Ok(exe_path) = std::env::current_exe() {
        // Tauri 앱: exe → *.app/Contents/MacOS/app → 프로젝트 루트/shannon
        let mut search = exe_path.parent().map(|p| p.to_path_buf());
        for _ in 0..6 {
            if let Some(ref dir) = search {
                let candidate = dir.join("shannon").join("shannon");
                if candidate.exists() {
                    return Ok(dir.join("shannon"));
                }
                search = dir.parent().map(|p| p.to_path_buf());
            } else {
                break;
            }
        }
    }

    // 4. CWD 기준 탐색
    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join("shannon").join("shannon");
        if candidate.exists() {
            return Ok(cwd.join("shannon"));
        }
    }

    Err("Shannon 설치 경로를 찾을 수 없습니다. Settings에서 경로를 설정해주세요.".to_string())
}

/// Shannon 보안 스캔 시작
#[tauri::command]
pub async fn shannon_start(
    shannon_path: String,
    url: String,
    repo: String,
    config: Option<String>,
    output: Option<String>,
    pipeline_testing: Option<bool>,
) -> Result<String, String> {
    let resolved = resolve_shannon_path(&shannon_path)?;

    let mut args = vec![
        "start".to_string(),
        format!("URL={}", url),
        format!("REPO={}", repo),
    ];

    if let Some(cfg) = config {
        args.push(format!("CONFIG={}", cfg));
    }
    if let Some(out) = output {
        args.push(format!("OUTPUT={}", out));
    }
    if pipeline_testing.unwrap_or(false) {
        args.push("PIPELINE_TESTING=true".to_string());
    }

    let output = crate::common::no_window_command("./shannon")
        .args(&args)
        .current_dir(&resolved)
        .output()
        .map_err(|e| format!("Shannon 실행 실패: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(format!("{}\n{}", stdout, stderr).trim().to_string())
    } else {
        Err(format!("Shannon 시작 실패:\nstdout: {}\nstderr: {}", stdout, stderr))
    }
}

/// Shannon 워크플로우 상태 조회
#[tauri::command]
pub async fn shannon_query(
    shannon_path: String,
    workflow_id: String,
) -> Result<String, String> {
    let resolved = resolve_shannon_path(&shannon_path)?;

    let output = crate::common::no_window_command("./shannon")
        .args(&["query", &format!("ID={}", workflow_id)])
        .current_dir(&resolved)
        .output()
        .map_err(|e| format!("Shannon query 실패: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(format!("{}\n{}", stdout, stderr).trim().to_string())
    } else {
        Err(format!("Shannon query 실패:\n{}\n{}", stdout, stderr))
    }
}

/// Shannon 워크플로우 로그 조회
#[tauri::command]
pub async fn shannon_logs(
    shannon_path: String,
    workflow_id: String,
) -> Result<String, String> {
    let resolved = resolve_shannon_path(&shannon_path)?;

    let output = crate::common::no_window_command("./shannon")
        .args(&["logs", &format!("ID={}", workflow_id)])
        .current_dir(&resolved)
        .output()
        .map_err(|e| format!("Shannon logs 실패: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(format!("{}\n{}", stdout, stderr).trim().to_string())
    } else {
        Err(format!("Shannon logs 실패:\n{}\n{}", stdout, stderr))
    }
}

/// Shannon 컨테이너 중지
#[tauri::command]
pub async fn shannon_stop(
    shannon_path: String,
    clean: Option<bool>,
) -> Result<String, String> {
    let resolved = resolve_shannon_path(&shannon_path)?;

    let mut args = vec!["stop".to_string()];
    if clean.unwrap_or(false) {
        args.push("--clean".to_string());
    }

    let output = crate::common::no_window_command("./shannon")
        .args(&args)
        .current_dir(&resolved)
        .output()
        .map_err(|e| format!("Shannon stop 실패: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(format!("{}\n{}", stdout, stderr).trim().to_string())
    } else {
        Err(format!("Shannon stop 실패:\n{}\n{}", stdout, stderr))
    }
}
