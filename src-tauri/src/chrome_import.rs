// Chrome/Chromium 계열 브라우저 데이터 임포트.
//
// BBARIT Browser를 처음 켠 사용자가 Chrome에 쌓아둔 비밀번호·북마크·방문기록·
// 자동완성·검색엔진·쿠키를 그대로 옮겨올 수 있게 한다. Chrome이 실행 중이면
// SQLite 파일이 잠기므로 항상 임시 폴더로 복사해서 읽는다(WAL/journal 동반).
//
// 비밀번호·쿠키 복호화:
// - macOS: Keychain의 "<Browser> Safe Storage" 항목 → PBKDF2-HMAC-SHA1
//   (salt "saltysalt", 1003회, 16바이트) → AES-128-CBC, IV = 0x20 × 16.
//   Keychain 접근은 OS가 사용자 승인 다이얼로그를 띄운다 — 그게 이 기능의 동의 관문이다.
// - Windows: Local State의 os_crypt.encrypted_key → DPAPI 복호화 → AES-256-GCM.
//   Chrome 127+의 App-Bound Encryption(v20)은 Chrome 프로세스 신원에 묶여 있어
//   외부에서 복호화할 수 없다. 그런 항목은 건너뛰고 경고로 개수를 알린다.
//
// 신용카드는 의도적으로 가져오지 않는다(민감도 대비 실익이 낮다).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------- 브라우저 정의

#[allow(dead_code)] // keychain_service/mac_dir/win_dir는 플랫폼별로만 읽힌다.
struct BrowserDef {
    key: &'static str,
    name: &'static str,
    /// macOS Keychain 서비스 이름 (계정은 브라우저 표시명과 같다).
    keychain_service: &'static str,
    /// ~/Library/Application Support 아래 경로 (macOS).
    mac_dir: &'static str,
    /// %LOCALAPPDATA% 아래 경로. 실제 user data dir은 여기에 "User Data"를 붙인다.
    win_dir: &'static str,
}

const BROWSERS: &[BrowserDef] = &[
    BrowserDef { key: "chrome", name: "Google Chrome", keychain_service: "Chrome Safe Storage", mac_dir: "Google/Chrome", win_dir: "Google/Chrome" },
    BrowserDef { key: "chrome-beta", name: "Chrome Beta", keychain_service: "Chrome Safe Storage", mac_dir: "Google/Chrome Beta", win_dir: "Google/Chrome Beta" },
    BrowserDef { key: "chrome-canary", name: "Chrome Canary", keychain_service: "Chromium Safe Storage", mac_dir: "Google/Chrome Canary", win_dir: "Google/Chrome SxS" },
    BrowserDef { key: "edge", name: "Microsoft Edge", keychain_service: "Microsoft Edge Safe Storage", mac_dir: "Microsoft Edge", win_dir: "Microsoft/Edge" },
    BrowserDef { key: "brave", name: "Brave", keychain_service: "Brave Safe Storage", mac_dir: "BraveSoftware/Brave-Browser", win_dir: "BraveSoftware/Brave-Browser" },
    BrowserDef { key: "whale", name: "Naver Whale", keychain_service: "Whale Safe Storage", mac_dir: "Naver/Whale", win_dir: "Naver/Naver Whale" },
    BrowserDef { key: "vivaldi", name: "Vivaldi", keychain_service: "Vivaldi Safe Storage", mac_dir: "Vivaldi", win_dir: "Vivaldi" },
    BrowserDef { key: "chromium", name: "Chromium", keychain_service: "Chromium Safe Storage", mac_dir: "Chromium", win_dir: "Chromium" },
    BrowserDef { key: "arc", name: "Arc", keychain_service: "Arc Safe Storage", mac_dir: "Arc/User Data", win_dir: "Arc/User Data" },
];

fn browser_def(key: &str) -> Option<&'static BrowserDef> {
    BROWSERS.iter().find(|b| b.key == key)
}

#[cfg(target_os = "macos")]
fn user_data_dir(def: &BrowserDef) -> Option<PathBuf> {
    let base = dirs::home_dir()?.join("Library/Application Support");
    let dir = base.join(def.mac_dir);
    dir.is_dir().then_some(dir)
}

#[cfg(windows)]
fn user_data_dir(def: &BrowserDef) -> Option<PathBuf> {
    let base = dirs::data_local_dir()?;
    // Arc는 win_dir에 이미 "User Data"가 들어 있다.
    let dir = if def.win_dir.ends_with("User Data") {
        base.join(def.win_dir)
    } else {
        base.join(def.win_dir).join("User Data")
    };
    dir.is_dir().then_some(dir)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn user_data_dir(def: &BrowserDef) -> Option<PathBuf> {
    let dir = dirs::config_dir()?.join(def.mac_dir);
    dir.is_dir().then_some(dir)
}

// ---------------------------------------------------------------- 공개 타입

#[derive(Serialize, Clone)]
pub struct ImportProfile {
    pub browser_key: String,
    pub browser_name: String,
    pub profile_id: String,
    pub profile_dir: String,
    pub display_name: String,
    pub passwords: u32,
    pub bookmarks: u32,
    pub history: u32,
    pub autofill: u32,
    pub search_engines: u32,
    pub cookies: u32,
}

#[derive(Serialize)]
pub struct ImportedPassword {
    pub url: String,
    pub username: String,
    pub password: String,
    pub times_used: i64,
    pub last_used: i64,
}

#[derive(Serialize)]
pub struct ImportedBookmark {
    pub url: String,
    pub title: String,
    pub folder: String,
    pub added: i64,
}

#[derive(Serialize)]
pub struct ImportedHistory {
    pub url: String,
    pub title: String,
    pub visits: i64,
    pub last_visit: i64,
}

#[derive(Serialize)]
pub struct ImportedAutofill {
    pub name: String,
    pub value: String,
    pub count: i64,
}

#[derive(Serialize)]
pub struct ImportedSearchEngine {
    pub name: String,
    pub keyword: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct ImportedCookie {
    pub host: String,
    pub name: String,
    pub value: String,
    pub path: String,
    pub expires: i64,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: i64,
}

#[derive(Serialize, Default)]
pub struct ImportPayload {
    pub passwords: Vec<ImportedPassword>,
    pub bookmarks: Vec<ImportedBookmark>,
    pub history: Vec<ImportedHistory>,
    pub autofill: Vec<ImportedAutofill>,
    pub search_engines: Vec<ImportedSearchEngine>,
    pub cookies: Vec<ImportedCookie>,
    /// 사용자에게 보여줄 경고(복호화 실패, 잠금, App-Bound Encryption 등).
    pub warnings: Vec<String>,
    /// 복호화할 수 없어 건너뛴 비밀번호/쿠키 수.
    pub undecryptable: u32,
}

#[derive(Deserialize)]
pub struct ImportRequest {
    pub browser_key: String,
    pub profile_dir: String,
    /// "passwords" | "bookmarks" | "history" | "autofill" | "search_engines" | "cookies"
    pub items: Vec<String>,
    /// 히스토리 상한(방문 횟수 내림차순). 0이면 전체.
    #[serde(default)]
    pub history_limit: u32,
}

// ---------------------------------------------------------------- SQLite 헬퍼

/// 잠긴 DB도 복사 없이 읽는다. immutable=1이라 WAL은 반영되지 않는다 — 개수 훑기 전용.
fn open_immutable(path: &Path) -> Option<Connection> {
    if !path.is_file() {
        return None;
    }
    let escaped = path.to_string_lossy().replace('?', "%3f").replace('#', "%23");
    let uri = format!("file:{}?immutable=1", escaped);
    Connection::open_with_flags(uri, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI).ok()
}

fn count_rows(path: &Path, table: &str) -> u32 {
    let Some(conn) = open_immutable(path) else { return 0 };
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get::<_, i64>(0))
        .map(|n| n.max(0) as u32)
        .unwrap_or(0)
}

/// 실제 임포트용: WAL까지 반영되도록 파일 3종을 임시 폴더로 복사한 뒤 연다.
/// 반환된 임시 디렉터리는 Drop 시 지운다.
struct TempCopy {
    dir: PathBuf,
    db: PathBuf,
}

impl TempCopy {
    fn new(src: &Path, tag: &str) -> Option<TempCopy> {
        if !src.is_file() {
            return None;
        }
        let unique = format!(
            "bbarit-import-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).ok()?;
        let db = dir.join("data.db");
        std::fs::copy(src, &db).ok()?;
        // WAL/journal이 있으면 함께 복사해야 최근 변경이 보인다.
        for (suffix, dest) in [("-wal", "data.db-wal"), ("-shm", "data.db-shm"), ("-journal", "data.db-journal")] {
            let side = PathBuf::from(format!("{}{}", src.to_string_lossy(), suffix));
            if side.is_file() {
                let _ = std::fs::copy(&side, dir.join(dest));
            }
        }
        Some(TempCopy { dir, db })
    }

    fn open(&self) -> Option<Connection> {
        Connection::open(&self.db).ok()
    }
}

impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Chromium 시간(1601-01-01 UTC 기준 마이크로초) → Unix epoch ms. 0은 0으로 둔다.
fn chromium_time_to_unix_ms(t: i64) -> i64 {
    if t <= 0 {
        return 0;
    }
    t / 1000 - 11_644_473_600_000
}

// ---------------------------------------------------------------- 복호화

/// 플랫폼별 복호화기. 키를 한 번만 얻어 재사용한다.
#[allow(dead_code)] // Cbc는 macOS/Linux, Gcm은 Windows에서만 구성된다.
enum Decryptor {
    /// macOS: PBKDF2로 유도한 16바이트 AES-128-CBC 키.
    Cbc(Vec<u8>),
    /// Windows: DPAPI로 푼 32바이트 AES-256-GCM 키.
    Gcm(Vec<u8>),
    /// 키를 얻지 못함 — 암호화된 값은 전부 건너뛴다.
    None(String),
}

#[cfg(target_os = "macos")]
fn build_decryptor(def: &BrowserDef, _user_data: &Path) -> Decryptor {
    use std::process::Command;

    // Keychain 읽기는 OS 승인 다이얼로그를 띄운다. 사용자가 거부하면 여기서 실패한다.
    let out = Command::new("security")
        .args(["find-generic-password", "-wa", def.name, "-s", def.keychain_service])
        .output();
    let secret = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => {
            // 계정명이 다른 배포판이 있어 서비스만으로 한 번 더 시도한다.
            match Command::new("security")
                .args(["find-generic-password", "-w", "-s", def.keychain_service])
                .output()
            {
                Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
                _ => String::new(),
            }
        }
    };
    if secret.is_empty() {
        return Decryptor::None(format!(
            "{} 비밀번호를 풀 키(Keychain '{}')를 읽지 못했습니다. 키체인 접근을 허용해 주세요.",
            def.name, def.keychain_service
        ));
    }
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(secret.as_bytes(), b"saltysalt", 1003, &mut key);
    Decryptor::Cbc(key.to_vec())
}

#[cfg(windows)]
fn build_decryptor(def: &BrowserDef, user_data: &Path) -> Decryptor {
    let state_path = user_data.join("Local State");
    let Ok(raw) = std::fs::read_to_string(&state_path) else {
        return Decryptor::None(format!("{}의 Local State를 읽지 못했습니다.", def.name));
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Decryptor::None(format!("{}의 Local State를 해석하지 못했습니다.", def.name));
    };
    let Some(b64) = json.get("os_crypt").and_then(|v| v.get("encrypted_key")).and_then(|v| v.as_str()) else {
        return Decryptor::None(format!("{}에 저장된 암호화 키를 찾지 못했습니다.", def.name));
    };
    use base64::Engine as _;
    let Ok(blob) = base64::engine::general_purpose::STANDARD.decode(b64) else {
        return Decryptor::None(format!("{}의 암호화 키 형식이 올바르지 않습니다.", def.name));
    };
    if blob.len() <= 5 || &blob[..5] != b"DPAPI" {
        return Decryptor::None(format!("{}의 암호화 키 형식이 올바르지 않습니다.", def.name));
    }
    match dpapi_unprotect(&blob[5..]) {
        Some(key) if key.len() == 32 => Decryptor::Gcm(key),
        _ => Decryptor::None(format!("{}의 암호화 키를 Windows 자격증명으로 풀지 못했습니다.", def.name)),
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn build_decryptor(def: &BrowserDef, _user_data: &Path) -> Decryptor {
    // Linux는 v11(gnome-keyring/kwallet) 또는 고정 키 "peanuts"의 v10.
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"peanuts", b"saltysalt", 1, &mut key);
    let _ = def;
    Decryptor::Cbc(key.to_vec())
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    use windows_sys::Win32::Foundation::LocalFree;

    let mut input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return None;
    }
    let plain = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as *mut std::ffi::c_void) };
    Some(plain)
}

/// 값 하나를 복호화한다. 복호화할 수 없으면 None(호출부가 건너뛰기 수를 센다).
fn decrypt_value(dec: &Decryptor, blob: &[u8]) -> Option<String> {
    if blob.is_empty() {
        return None;
    }
    // 접두사가 없으면 평문(오래된 프로필 또는 OS 암호화 비활성).
    let prefix = if blob.len() >= 3 { &blob[..3] } else { &blob[..] };
    if prefix != b"v10" && prefix != b"v11" && prefix != b"v20" {
        return String::from_utf8(blob.to_vec()).ok();
    }
    if prefix == b"v20" {
        return None; // App-Bound Encryption — 외부 프로세스는 풀 수 없다.
    }
    match dec {
        Decryptor::Cbc(key) => {
            use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
            type Dec = cbc::Decryptor<aes::Aes128>;
            let iv = [0x20u8; 16];
            let ct = &blob[3..];
            if ct.is_empty() || ct.len() % 16 != 0 {
                return None;
            }
            let plain = Dec::new(key.as_slice().into(), (&iv).into())
                .decrypt_padded_vec_mut::<Pkcs7>(ct)
                .ok()?;
            Some(strip_domain_hash(plain))
        }
        Decryptor::Gcm(key) => {
            use aes_gcm::aead::Aead;
            use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
            if blob.len() < 3 + 12 + 16 {
                return None;
            }
            let cipher = Aes256Gcm::new_from_slice(key).ok()?;
            let nonce = Nonce::from_slice(&blob[3..15]);
            let plain = cipher.decrypt(nonce, &blob[15..]).ok()?;
            Some(strip_domain_hash(plain))
        }
        Decryptor::None(_) => None,
    }
}

/// Chrome 118+는 쿠키 평문 앞에 SHA-256(host_key) 32바이트를 덧댄다. 값이 UTF-8이
/// 아니면서 32바이트를 떼면 UTF-8이 되는 경우에만 떼어낸다(비밀번호는 영향 없음).
fn strip_domain_hash(plain: Vec<u8>) -> String {
    if let Ok(s) = String::from_utf8(plain.clone()) {
        return s;
    }
    if plain.len() > 32 {
        if let Ok(s) = String::from_utf8(plain[32..].to_vec()) {
            return s;
        }
    }
    String::from_utf8_lossy(&plain).into_owned()
}

// ---------------------------------------------------------------- 프로필 스캔

fn profile_display_names(user_data: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(raw) = std::fs::read_to_string(user_data.join("Local State")) else { return out };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else { return out };
    let Some(cache) = json.pointer("/profile/info_cache").and_then(|v| v.as_object()) else { return out };
    for (id, info) in cache {
        let name = info.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        let email = info.get("user_name").and_then(|v| v.as_str()).unwrap_or("").trim();
        let label = match (name.is_empty(), email.is_empty()) {
            (false, false) if name != email => format!("{name} ({email})"),
            (false, _) => name.to_string(),
            (true, false) => email.to_string(),
            _ => id.clone(),
        };
        out.insert(id.clone(), label);
    }
    out
}

fn count_bookmarks(path: &Path) -> u32 {
    let Ok(raw) = std::fs::read_to_string(path) else { return 0 };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else { return 0 };
    let mut n = 0u32;
    if let Some(roots) = json.get("roots").and_then(|v| v.as_object()) {
        for node in roots.values() {
            count_bookmark_node(node, &mut n);
        }
    }
    n
}

fn count_bookmark_node(node: &serde_json::Value, n: &mut u32) {
    match node.get("type").and_then(|v| v.as_str()) {
        Some("url") => *n += 1,
        Some("folder") | None => {
            if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
                for child in children {
                    count_bookmark_node(child, n);
                }
            }
        }
        _ => {}
    }
}

fn scan_profile(def: &BrowserDef, user_data: &Path, id: &str, names: &HashMap<String, String>) -> Option<ImportProfile> {
    let dir = user_data.join(id);
    if !dir.is_dir() {
        return None;
    }
    let web_data = dir.join("Web Data");
    let profile = ImportProfile {
        browser_key: def.key.to_string(),
        browser_name: def.name.to_string(),
        profile_id: id.to_string(),
        profile_dir: dir.to_string_lossy().into_owned(),
        display_name: names.get(id).cloned().unwrap_or_else(|| id.to_string()),
        passwords: count_rows(&dir.join("Login Data"), "logins"),
        bookmarks: count_bookmarks(&dir.join("Bookmarks")),
        history: count_rows(&dir.join("History"), "urls"),
        autofill: count_rows(&web_data, "autofill"),
        search_engines: count_rows(&web_data, "keywords"),
        cookies: count_rows(&dir.join("Cookies"), "cookies"),
    };
    let empty = profile.passwords == 0
        && profile.bookmarks == 0
        && profile.history == 0
        && profile.autofill == 0
        && profile.cookies == 0;
    (!empty).then_some(profile)
}

/// 설치된 Chromium 계열 브라우저의 프로필을 전부 훑는다. 빈 프로필은 뺀다.
#[tauri::command]
pub async fn chrome_list_profiles() -> Result<Vec<ImportProfile>, String> {
    tokio::task::spawn_blocking(|| {
        let mut out = Vec::new();
        for def in BROWSERS {
            let Some(user_data) = user_data_dir(def) else { continue };
            let names = profile_display_names(&user_data);
            let mut ids: Vec<String> = Vec::new();
            if user_data.join("Default").is_dir() {
                ids.push("Default".to_string());
            }
            if let Ok(entries) = std::fs::read_dir(&user_data) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with("Profile ") && entry.path().is_dir() {
                        ids.push(name);
                    }
                }
            }
            ids.sort_by_key(|id| {
                // "Profile 2"가 "Profile 10"보다 앞에 오도록 숫자로 정렬한다.
                let n = id.strip_prefix("Profile ").and_then(|s| s.parse::<u32>().ok());
                (id != "Default", n.unwrap_or(u32::MAX), id.clone())
            });
            for id in ids {
                if let Some(p) = scan_profile(def, &user_data, &id, &names) {
                    out.push(p);
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- 항목별 읽기

fn read_passwords(dir: &Path, dec: &Decryptor, payload: &mut ImportPayload) {
    let Some(copy) = TempCopy::new(&dir.join("Login Data"), "logins") else {
        payload.warnings.push("Login Data 파일을 열지 못했습니다.".into());
        return;
    };
    let Some(conn) = copy.open() else {
        payload.warnings.push("Login Data 파일을 열지 못했습니다.".into());
        return;
    };
    let sql = "SELECT origin_url, username_value, password_value, times_used, date_last_used \
               FROM logins WHERE blacklisted_by_user = 0";
    let Ok(mut stmt) = conn.prepare(sql) else { return };
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0).unwrap_or_default(),
            row.get::<_, String>(1).unwrap_or_default(),
            row.get::<_, Vec<u8>>(2).unwrap_or_default(),
            row.get::<_, i64>(3).unwrap_or(0),
            row.get::<_, i64>(4).unwrap_or(0),
        ))
    });
    let Ok(rows) = rows else { return };
    for row in rows.flatten() {
        let (url, username, blob, times_used, last_used) = row;
        if url.is_empty() || blob.is_empty() {
            continue;
        }
        match decrypt_value(dec, &blob) {
            Some(password) if !password.is_empty() => payload.passwords.push(ImportedPassword {
                url,
                username,
                password,
                times_used,
                last_used: chromium_time_to_unix_ms(last_used),
            }),
            _ => payload.undecryptable += 1,
        }
    }
}

fn read_bookmarks(dir: &Path, payload: &mut ImportPayload) {
    let path = dir.join("Bookmarks");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        payload.warnings.push("이 프로필에는 북마크 파일이 없습니다.".into());
        return;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        payload.warnings.push("북마크 파일을 해석하지 못했습니다.".into());
        return;
    };
    let Some(roots) = json.get("roots").and_then(|v| v.as_object()) else { return };
    for (root_key, node) in roots {
        let root_label = match root_key.as_str() {
            "bookmark_bar" => "Bookmarks bar",
            "other" => "Other bookmarks",
            "synced" => "Mobile bookmarks",
            other => other,
        };
        collect_bookmarks(node, root_label, &mut payload.bookmarks);
    }
}

fn collect_bookmarks(node: &serde_json::Value, folder: &str, out: &mut Vec<ImportedBookmark>) {
    match node.get("type").and_then(|v| v.as_str()) {
        Some("url") => {
            let url = node.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if url.is_empty() {
                return;
            }
            let title = node.get("name").and_then(|v| v.as_str()).unwrap_or(url);
            let added = node
                .get("date_added")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0);
            out.push(ImportedBookmark {
                url: url.to_string(),
                title: title.to_string(),
                folder: folder.to_string(),
                added: chromium_time_to_unix_ms(added),
            });
        }
        _ => {
            let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let next = if name.is_empty() || folder.is_empty() {
                folder.to_string()
            } else if node.get("children").is_some() && !folder.ends_with(name) {
                format!("{folder}/{name}")
            } else {
                folder.to_string()
            };
            if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
                for child in children {
                    collect_bookmarks(child, &next, out);
                }
            }
        }
    }
}

fn read_history(dir: &Path, limit: u32, payload: &mut ImportPayload) {
    let Some(copy) = TempCopy::new(&dir.join("History"), "history") else {
        payload.warnings.push("방문 기록 파일을 열지 못했습니다.".into());
        return;
    };
    let Some(conn) = copy.open() else { return };
    let sql = if limit > 0 {
        format!(
            "SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 \
             ORDER BY visit_count DESC, last_visit_time DESC LIMIT {limit}"
        )
    } else {
        "SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 \
         ORDER BY visit_count DESC, last_visit_time DESC"
            .to_string()
    };
    let Ok(mut stmt) = conn.prepare(&sql) else { return };
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0).unwrap_or_default(),
            row.get::<_, String>(1).unwrap_or_default(),
            row.get::<_, i64>(2).unwrap_or(0),
            row.get::<_, i64>(3).unwrap_or(0),
        ))
    });
    let Ok(rows) = rows else { return };
    for (url, title, visits, last) in rows.flatten() {
        if url.is_empty() {
            continue;
        }
        payload.history.push(ImportedHistory {
            url,
            title,
            visits,
            last_visit: chromium_time_to_unix_ms(last),
        });
    }
}

fn read_autofill(dir: &Path, payload: &mut ImportPayload) {
    let Some(copy) = TempCopy::new(&dir.join("Web Data"), "webdata") else { return };
    let Some(conn) = copy.open() else { return };
    let Ok(mut stmt) = conn.prepare("SELECT name, value, count FROM autofill ORDER BY count DESC") else { return };
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0).unwrap_or_default(),
            row.get::<_, String>(1).unwrap_or_default(),
            row.get::<_, i64>(2).unwrap_or(0),
        ))
    });
    let Ok(rows) = rows else { return };
    for (name, value, count) in rows.flatten() {
        if name.is_empty() || value.is_empty() {
            continue;
        }
        payload.autofill.push(ImportedAutofill { name, value, count });
    }
}

fn read_search_engines(dir: &Path, payload: &mut ImportPayload) {
    let Some(copy) = TempCopy::new(&dir.join("Web Data"), "keywords") else { return };
    let Some(conn) = copy.open() else { return };
    let Ok(mut stmt) = conn.prepare("SELECT short_name, keyword, url FROM keywords") else { return };
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0).unwrap_or_default(),
            row.get::<_, String>(1).unwrap_or_default(),
            row.get::<_, String>(2).unwrap_or_default(),
        ))
    });
    let Ok(rows) = rows else { return };
    for (name, keyword, url) in rows.flatten() {
        // 치환 토큰이 없는 항목은 검색 엔진으로 쓸 수 없다.
        if url.is_empty() || !url.contains("{searchTerms}") {
            continue;
        }
        payload.search_engines.push(ImportedSearchEngine { name, keyword, url });
    }
}

fn read_cookies(dir: &Path, dec: &Decryptor, payload: &mut ImportPayload) {
    let Some(copy) = TempCopy::new(&dir.join("Cookies"), "cookies") else { return };
    let Some(conn) = copy.open() else { return };
    let sql = "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite \
               FROM cookies";
    let Ok(mut stmt) = conn.prepare(sql) else { return };
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0).unwrap_or_default(),
            row.get::<_, String>(1).unwrap_or_default(),
            row.get::<_, String>(2).unwrap_or_default(),
            row.get::<_, Vec<u8>>(3).unwrap_or_default(),
            row.get::<_, String>(4).unwrap_or_default(),
            row.get::<_, i64>(5).unwrap_or(0),
            row.get::<_, i64>(6).unwrap_or(0),
            row.get::<_, i64>(7).unwrap_or(0),
            row.get::<_, i64>(8).unwrap_or(0),
        ))
    });
    let Ok(rows) = rows else { return };
    for (host, name, plain, blob, path, expires, secure, http_only, same_site) in rows.flatten() {
        let value = if !blob.is_empty() {
            match decrypt_value(dec, &blob) {
                Some(v) => v,
                None => {
                    payload.undecryptable += 1;
                    continue;
                }
            }
        } else {
            plain
        };
        if host.is_empty() || name.is_empty() {
            continue;
        }
        payload.cookies.push(ImportedCookie {
            host,
            name,
            value,
            path,
            expires: chromium_time_to_unix_ms(expires),
            secure: secure != 0,
            http_only: http_only != 0,
            same_site,
        });
    }
}

/// 선택한 프로필에서 선택한 항목만 읽어 반환한다. 저장은 프론트엔드가 한다.
#[tauri::command]
pub async fn chrome_import_data(request: ImportRequest) -> Result<ImportPayload, String> {
    tokio::task::spawn_blocking(move || {
        let def = browser_def(&request.browser_key).ok_or_else(|| "알 수 없는 브라우저입니다.".to_string())?;
        let dir = PathBuf::from(&request.profile_dir);
        if !dir.is_dir() {
            return Err("프로필 폴더를 찾을 수 없습니다.".to_string());
        }
        let user_data = dir.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| dir.clone());

        let want = |name: &str| request.items.iter().any(|i| i == name);
        let needs_key = want("passwords") || want("cookies");
        let dec = if needs_key { build_decryptor(def, &user_data) } else { Decryptor::None(String::new()) };

        let mut payload = ImportPayload::default();
        if let Decryptor::None(msg) = &dec {
            if needs_key && !msg.is_empty() {
                payload.warnings.push(msg.clone());
            }
        }

        if want("passwords") {
            read_passwords(&dir, &dec, &mut payload);
        }
        if want("bookmarks") {
            read_bookmarks(&dir, &mut payload);
        }
        if want("history") {
            read_history(&dir, request.history_limit, &mut payload);
        }
        if want("autofill") {
            read_autofill(&dir, &mut payload);
        }
        if want("search_engines") {
            read_search_engines(&dir, &mut payload);
        }
        if want("cookies") {
            read_cookies(&dir, &dec, &mut payload);
        }
        if payload.undecryptable > 0 {
            payload.warnings.push(format!(
                "{}개 항목은 이 컴퓨터에서 복호화할 수 없어 건너뛰었습니다(브라우저 자체 암호화).",
                payload.undecryptable
            ));
        }
        Ok(payload)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_epoch_converts_to_unix_ms() {
        // 2021-01-01T00:00:00Z = 13253932800000000 마이크로초 (1601 기준)
        assert_eq!(chromium_time_to_unix_ms(13_253_932_800_000_000), 1_609_459_200_000);
    }

    #[test]
    fn chromium_epoch_keeps_zero_for_never_used() {
        assert_eq!(chromium_time_to_unix_ms(0), 0);
        assert_eq!(chromium_time_to_unix_ms(-5), 0);
    }

    #[test]
    fn plaintext_values_pass_through_without_a_key() {
        let dec = Decryptor::None(String::new());
        assert_eq!(decrypt_value(&dec, b"hunter2").as_deref(), Some("hunter2"));
    }

    #[test]
    fn app_bound_encrypted_values_are_skipped() {
        let dec = Decryptor::Cbc(vec![0u8; 16]);
        let mut blob = b"v20".to_vec();
        blob.extend_from_slice(&[1u8; 32]);
        assert!(decrypt_value(&dec, &blob).is_none());
    }

    #[test]
    fn cbc_roundtrip_recovers_the_password() {
        use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        type Enc = cbc::Encryptor<aes::Aes128>;
        let key = [7u8; 16];
        let iv = [0x20u8; 16];
        let ct = Enc::new(&key.into(), &iv.into()).encrypt_padded_vec_mut::<Pkcs7>(b"s3cret-pass");
        let mut blob = b"v10".to_vec();
        blob.extend_from_slice(&ct);
        let dec = Decryptor::Cbc(key.to_vec());
        assert_eq!(decrypt_value(&dec, &blob).as_deref(), Some("s3cret-pass"));
    }

    #[test]
    fn cookie_values_shed_the_domain_hash_prefix() {
        // Chrome 118+ 쿠키 평문 = SHA-256(host) 32바이트 + 실제 값.
        let mut plain = vec![0xffu8; 32]; // UTF-8이 아닌 해시
        plain.extend_from_slice(b"session-token");
        assert_eq!(strip_domain_hash(plain), "session-token");
    }

    #[test]
    fn plain_utf8_cookie_values_are_left_alone() {
        assert_eq!(strip_domain_hash(b"short".to_vec()), "short");
    }

    #[test]
    fn bookmark_tree_flattens_with_folder_paths() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{"type":"folder","name":"Work","children":[
                 {"type":"url","name":"Docs","url":"https://docs.example","date_added":"13253932800000000"},
                 {"type":"folder","name":"Deep","children":[
                   {"type":"url","name":"Inner","url":"https://inner.example","date_added":"0"}]}]}"#,
        )
        .unwrap();
        let mut out = Vec::new();
        collect_bookmarks(&json, "Bookmarks bar", &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].folder, "Bookmarks bar/Work");
        assert_eq!(out[0].added, 1_609_459_200_000);
        assert_eq!(out[1].folder, "Bookmarks bar/Work/Deep");
    }
}
