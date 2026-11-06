//! Desktop pet weather (phase 4): the Mac's location and the current weather for the pet.
//!
//! Nothing here runs before the owner turns weather on (`pet.weather.enabled` in
//! ~/.config/octo/config.json); the commands refuse while it is off. Coordinates are rounded
//! to 0.1 degree (about 10 km) before they leave the machine, and location results are
//! rounded before they even reach the page. No IP geolocation.
//!
//! - `pet_location { ask }`: macOS CoreLocation. Only Settings passes `ask: true` (the
//!   permission prompt); the pet page only reads. The manager lives on the main thread
//!   (CoreLocation delivers updates on the run loop of the thread that created it).
//!   Status: ok / pending / denied / unavailable / notAsked / off. The unbundled dev binary
//!   has no Info.plist, so the prompt never shows there: still no answer 60 s after asking
//!   reports `unavailable` and the page uses the owner's city.
//! - `pet_weather_now { lat, lon }`: Open-Meteo forecast `current` (no key).
//! - `pet_weather_city_search { query, language }`: Open-Meteo geocoding (the manual city).
//!
//! Design: docs/superpowers/specs/2026-11-06-desktop-pet-design.md ("Weather").

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const FORECAST_BASE: &str = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_BASE: &str = "https://geocoding-api.open-meteo.com/v1/search";
const CURRENT_FIELDS: &str = "weather_code,precipitation,is_day,temperature_2m";
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// Asked for permission (or started looking for a fix) this long ago without an answer:
/// report `unavailable` so the page falls back to the city.
const LOCATION_ANSWER_SECS: f64 = 60.0;
/// A fix older than this is re-read (the pet follows the owner when they travel).
const FIX_MAX_AGE_SECS: f64 = 30.0 * 60.0;
const CITY_RESULTS: usize = 8;
const MAX_QUERY_CHARS: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWeatherNow {
    /// WMO weather interpretation code.
    pub code: i64,
    /// mm over the preceding interval.
    pub precipitation: f64,
    pub is_day: bool,
    pub temperature: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCity {
    pub name: String,
    pub admin1: Option<String>,
    pub country: Option<String>,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocationStatus {
    Ok,
    Pending,
    Denied,
    Unavailable,
    NotAsked,
    Off,
}

/// `pet_location` result; lat / lon (rounded) only with status `ok`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PetLocation {
    pub status: LocationStatus,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
}

impl PetLocation {
    fn only(status: LocationStatus) -> Self {
        Self { status, lat: None, lon: None }
    }
}

/// `v` rounded to one decimal; None when not finite.
pub fn round_tenth(v: f64) -> Option<f64> {
    if !v.is_finite() {
        return None;
    }
    let r = (v * 10.0).round() / 10.0;
    // -0.0 prints as "-0.0"; keep the URL clean.
    Some(if r == 0.0 { 0.0 } else { r })
}

/// Valid latitude / longitude, rounded to 0.1 degree.
pub fn rounded_coords(lat: f64, lon: f64) -> Option<(f64, f64)> {
    let (lat, lon) = (round_tenth(lat)?, round_tenth(lon)?);
    if lat.abs() > 90.0 || lon.abs() > 180.0 {
        return None;
    }
    Some((lat, lon))
}

/// Open-Meteo forecast URL for the rounded coordinates (one decimal in the query).
pub fn forecast_url(lat: f64, lon: f64) -> Option<reqwest::Url> {
    let (lat, lon) = rounded_coords(lat, lon)?;
    reqwest::Url::parse_with_params(
        FORECAST_BASE,
        &[
            ("latitude", format!("{lat:.1}")),
            ("longitude", format!("{lon:.1}")),
            ("current", CURRENT_FIELDS.to_string()),
        ],
    )
    .ok()
}

/// Open-Meteo geocoding URL; None for an empty or overlong query. `language` falls back to en.
pub fn geocode_url(query: &str, language: &str) -> Option<reqwest::Url> {
    let q = query.trim();
    if q.is_empty() || q.chars().count() > MAX_QUERY_CHARS {
        return None;
    }
    let lang = if language.len() == 2 && language.chars().all(|c| c.is_ascii_lowercase()) {
        language
    } else {
        "en"
    };
    reqwest::Url::parse_with_params(
        GEOCODE_BASE,
        &[
            ("name", q.to_string()),
            ("count", CITY_RESULTS.to_string()),
            ("language", lang.to_string()),
            ("format", "json".to_string()),
        ],
    )
    .ok()
}

/// The `current` block of a forecast response.
pub fn parse_forecast(v: &Value) -> Result<PetWeatherNow, String> {
    let cur = v.get("current").ok_or("no current weather")?;
    let code = cur
        .get("weather_code")
        .and_then(|c| c.as_f64())
        .filter(|c| c.is_finite() && *c >= 0.0)
        .ok_or("no weather_code")? as i64;
    let precipitation = cur
        .get("precipitation")
        .and_then(|p| p.as_f64())
        .filter(|p| p.is_finite() && *p >= 0.0)
        .unwrap_or(0.0);
    let is_day = cur.get("is_day").and_then(|d| d.as_f64()).map(|d| d != 0.0).unwrap_or(true);
    let temperature = cur.get("temperature_2m").and_then(|t| t.as_f64()).filter(|t| t.is_finite());
    Ok(PetWeatherNow { code, precipitation, is_day, temperature })
}

/// Cities from a geocoding response; entries without a name or valid coordinates are skipped.
pub fn parse_geocode(v: &Value) -> Vec<PetCity> {
    let text = |r: &Value, k: &str| {
        r.get(k)
            .and_then(|s| s.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    v.get("results")
        .and_then(|r| r.as_array())
        .map(|rs| {
            rs.iter()
                .filter_map(|r| {
                    let name = text(r, "name")?;
                    let lat = r.get("latitude")?.as_f64()?;
                    let lon = r.get("longitude")?.as_f64()?;
                    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
                        return None;
                    }
                    Some(PetCity { name, admin1: text(r, "admin1"), country: text(r, "country"), lat, lon })
                })
                .take(CITY_RESULTS)
                .collect()
        })
        .unwrap_or_default()
}

/// `pet.weather.enabled` from config.json: only an explicit `true` (default off).
pub fn weather_enabled(config: &Value) -> bool {
    config
        .get("pet")
        .and_then(|p| p.get("weather"))
        .and_then(|w| w.get("enabled"))
        .and_then(|e| e.as_bool())
        == Some(true)
}

fn weather_enabled_from_config() -> bool {
    crate::read_octo_config_json().map(|c| weather_enabled(&c)).unwrap_or(false)
}

/// What to report from CoreLocation state. `auth` is CLAuthorizationStatus (0 not determined,
/// 1 restricted, 2 denied, 3 always / authorized, 4 when in use); `fix` a fresh location is
/// known; `waiting_secs` how long ago we asked for permission or started looking for a fix.
pub fn location_status(services: bool, auth: i32, fix: bool, waiting_secs: Option<f64>) -> LocationStatus {
    if !services {
        return LocationStatus::Unavailable;
    }
    let waiting = |s: Option<f64>| match s {
        Some(s) if s > LOCATION_ANSWER_SECS => LocationStatus::Unavailable,
        _ => LocationStatus::Pending,
    };
    match auth {
        1 | 2 => LocationStatus::Denied,
        3 | 4 if fix => LocationStatus::Ok,
        3 | 4 => waiting(waiting_secs),
        0 => match waiting_secs {
            None => LocationStatus::NotAsked,
            s => waiting(s),
        },
        _ => LocationStatus::Unavailable,
    }
}

async fn get_json(url: reqwest::Url) -> Result<Value, String> {
    let resp = crate::shared_http_client()
        .get(url)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| format!("bad response: {e}"))
}

/// Current weather at (lat, lon), rounded to 0.1 degree before the request.
#[tauri::command(async)]
pub async fn pet_weather_now(lat: f64, lon: f64) -> Result<PetWeatherNow, String> {
    if !weather_enabled_from_config() {
        return Err("weather is off".into());
    }
    let url = forecast_url(lat, lon).ok_or("invalid coordinates")?;
    parse_forecast(&get_json(url).await?)
}

/// City search for the manual location (Settings, an explicit owner action).
#[tauri::command(async)]
pub async fn pet_weather_city_search(query: String, language: String) -> Result<Vec<PetCity>, String> {
    let Some(url) = geocode_url(&query, &language) else {
        return Ok(Vec::new());
    };
    Ok(parse_geocode(&get_json(url).await?))
}

/// The Mac's location (rounded) or why there is none. `ask` (Settings only) shows the
/// permission prompt when it was never answered.
#[tauri::command(async)]
pub fn pet_location(app: tauri::AppHandle, ask: bool) -> PetLocation {
    if !weather_enabled_from_config() {
        return PetLocation::only(LocationStatus::Off);
    }
    platform_location(&app, ask)
}

#[cfg(not(target_os = "macos"))]
fn platform_location(_app: &tauri::AppHandle, _ask: bool) -> PetLocation {
    PetLocation::only(LocationStatus::Unavailable)
}

#[cfg(target_os = "macos")]
fn platform_location(app: &tauri::AppHandle, ask: bool) -> PetLocation {
    use objc2_core_location::CLLocationManager;
    // Apple: may block, so not on the main thread. A class method, safe from any thread.
    // SAFETY: plain class method without arguments.
    let services = unsafe { CLLocationManager::locationServicesEnabled_class() };
    if !services {
        return PetLocation::only(LocationStatus::Unavailable);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    if app.run_on_main_thread(move || {
        let _ = tx.send(mac::read_on_main(ask));
    })
    .is_err()
    {
        return PetLocation::only(LocationStatus::Pending);
    }
    rx.recv_timeout(Duration::from_secs(2))
        .unwrap_or_else(|_| PetLocation::only(LocationStatus::Pending))
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{location_status, rounded_coords, LocationStatus, PetLocation, FIX_MAX_AGE_SECS, LOCATION_ANSWER_SECS};
    use objc2_core_location::{kCLLocationAccuracyThreeKilometers, CLLocationManager};
    use std::cell::{Cell, RefCell};
    use std::time::Instant;

    thread_local! {
        /// Created once on the main thread and kept for the life of the app.
        static MANAGER: Cell<Option<&'static CLLocationManager>> = const { Cell::new(None) };
        /// When we asked for permission or started updating without a fix yet.
        static WAITING_SINCE: RefCell<Option<Instant>> = const { RefCell::new(None) };
        static UPDATING: Cell<bool> = const { Cell::new(false) };
    }

    fn manager() -> &'static CLLocationManager {
        MANAGER.with(|m| {
            if let Some(existing) = m.get() {
                return existing;
            }
            // SAFETY: plain allocation on the main thread; the manager is leaked on purpose
            // (one per app) so updates keep arriving on the main run loop.
            let created: &'static CLLocationManager = unsafe {
                let mgr = CLLocationManager::new();
                // About 3 km is plenty (the coordinates are rounded to ~10 km anyway) and
                // the cheapest fix CoreLocation offers.
                mgr.setDesiredAccuracy(kCLLocationAccuracyThreeKilometers);
                &**Box::leak(Box::new(mgr))
            };
            m.set(Some(created));
            created
        })
    }

    fn waiting_secs() -> Option<f64> {
        WAITING_SINCE.with(|w| w.borrow().map(|t| t.elapsed().as_secs_f64()))
    }

    fn start_waiting(restart: bool) {
        WAITING_SINCE.with(|w| {
            let mut w = w.borrow_mut();
            if restart || w.is_none() {
                *w = Some(Instant::now());
            }
        });
    }

    /// Runs on the main thread (CLLocationManager's home).
    pub(super) fn read_on_main(ask: bool) -> PetLocation {
        let mgr = manager();
        // SAFETY: CLLocationManager instance methods on the main thread that created it.
        let auth = unsafe { mgr.authorizationStatus() }.0;
        match auth {
            0 => {
                // Asked long ago without an answer (no prompt in the unbundled dev build):
                // the retry button asks again.
                let stale = waiting_secs().is_some_and(|s| s > LOCATION_ANSWER_SECS);
                if ask && (waiting_secs().is_none() || stale) {
                    // SAFETY: as above.
                    unsafe { mgr.requestWhenInUseAuthorization() };
                    start_waiting(true);
                }
            }
            3 | 4 => {
                // SAFETY: as above; `timestamp` is the fix time (age is negative seconds).
                let fix = unsafe { mgr.location() }.and_then(|loc| unsafe {
                    let age = -loc.timestamp().timeIntervalSinceNow();
                    let c = loc.coordinate();
                    (age <= FIX_MAX_AGE_SECS).then_some((c.latitude, c.longitude))
                });
                if let Some((lat, lon)) = fix.and_then(|(la, lo)| rounded_coords(la, lo)) {
                    if UPDATING.with(|u| u.replace(false)) {
                        // SAFETY: as above. One fix is enough until the next re-read.
                        unsafe { mgr.stopUpdatingLocation() };
                    }
                    WAITING_SINCE.with(|w| *w.borrow_mut() = None);
                    return PetLocation { status: LocationStatus::Ok, lat: Some(lat), lon: Some(lon) };
                }
                // No fresh fix: look for one; after a long fruitless wait, try again.
                let stale = waiting_secs().is_some_and(|s| s > FIX_MAX_AGE_SECS);
                if !UPDATING.with(|u| u.get()) || stale {
                    // SAFETY: as above.
                    unsafe { mgr.startUpdatingLocation() };
                    UPDATING.with(|u| u.set(true));
                    start_waiting(stale || waiting_secs().is_none());
                }
            }
            _ => {}
        }
        PetLocation::only(location_status(true, auth, false, waiting_secs()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_tenth_rounds_to_one_decimal() {
        assert_eq!(round_tenth(37.5665), Some(37.6));
        assert_eq!(round_tenth(126.9784), Some(127.0));
        assert_eq!(round_tenth(-33.8688), Some(-33.9));
        assert_eq!(round_tenth(-0.04), Some(0.0));
        assert_eq!(round_tenth(f64::NAN), None);
        assert_eq!(round_tenth(f64::INFINITY), None);
    }

    #[test]
    fn rounded_coords_rejects_out_of_range() {
        assert_eq!(rounded_coords(37.5665, 126.9784), Some((37.6, 127.0)));
        assert_eq!(rounded_coords(91.0, 0.0), None);
        assert_eq!(rounded_coords(0.0, -180.5), None);
        assert_eq!(rounded_coords(f64::NAN, 0.0), None);
    }

    #[test]
    fn forecast_url_sends_only_one_decimal() {
        let url = forecast_url(37.56651234, 126.97841234).unwrap();
        assert_eq!(
            url.as_str(),
            "https://api.open-meteo.com/v1/forecast?latitude=37.6&longitude=127.0\
             &current=weather_code%2Cprecipitation%2Cis_day%2Ctemperature_2m"
        );
        let south = forecast_url(-33.8688, 151.2093).unwrap();
        assert!(south.as_str().contains("latitude=-33.9&longitude=151.2&"), "{south}");
        assert!(forecast_url(f64::NAN, 1.0).is_none());
    }

    #[test]
    fn geocode_url_encodes_the_query_and_checks_language() {
        let url = geocode_url(" 서울 ", "ko").unwrap();
        assert_eq!(
            url.as_str(),
            "https://geocoding-api.open-meteo.com/v1/search?name=%EC%84%9C%EC%9A%B8&count=8&language=ko&format=json"
        );
        assert!(geocode_url("Paris", "x&y").unwrap().as_str().contains("language=en"));
        assert!(geocode_url("   ", "en").is_none());
        assert!(geocode_url(&"a".repeat(101), "en").is_none());
    }

    #[test]
    fn parse_forecast_reads_the_current_block() {
        let v = json!({
            "latitude": 37.6, "longitude": 127.0,
            "current": {"time": "2026-11-06T16:45", "interval": 900, "weather_code": 63,
                        "precipitation": 1.2, "is_day": 0, "temperature_2m": 0.5}
        });
        assert_eq!(
            parse_forecast(&v).unwrap(),
            PetWeatherNow { code: 63, precipitation: 1.2, is_day: false, temperature: Some(0.5) }
        );
        // Missing optional fields: dry, day, no temperature.
        assert_eq!(
            parse_forecast(&json!({"current": {"weather_code": 0}})).unwrap(),
            PetWeatherNow { code: 0, precipitation: 0.0, is_day: true, temperature: None }
        );
        assert!(parse_forecast(&json!({"current": {}})).is_err());
        assert!(parse_forecast(&json!({"error": true, "reason": "x"})).is_err());
    }

    #[test]
    fn pet_weather_now_payload_is_camel_case() {
        let v = serde_json::to_value(PetWeatherNow { code: 1, precipitation: 0.0, is_day: true, temperature: None }).unwrap();
        assert_eq!(v, json!({"code": 1, "precipitation": 0.0, "isDay": true, "temperature": null}));
        let loc = serde_json::to_value(PetLocation::only(LocationStatus::NotAsked)).unwrap();
        assert_eq!(loc, json!({"status": "notAsked", "lat": null, "lon": null}));
    }

    #[test]
    fn parse_geocode_keeps_valid_cities() {
        let v = json!({"results": [
            {"name": "서울특별시", "latitude": 37.566, "longitude": 126.9784, "country": "대한민국", "admin1": "서울특별시"},
            {"name": "", "latitude": 1.0, "longitude": 1.0},
            {"name": "Nowhere", "latitude": 99.0, "longitude": 1.0},
            {"name": "Paris", "latitude": 48.85, "longitude": 2.35}
        ]});
        assert_eq!(
            parse_geocode(&v),
            vec![
                PetCity {
                    name: "서울특별시".into(),
                    admin1: Some("서울특별시".into()),
                    country: Some("대한민국".into()),
                    lat: 37.566,
                    lon: 126.9784
                },
                PetCity { name: "Paris".into(), admin1: None, country: None, lat: 48.85, lon: 2.35 },
            ]
        );
        assert!(parse_geocode(&json!({"generationtime_ms": 0.1})).is_empty());
    }

    #[test]
    fn weather_is_off_unless_explicitly_true() {
        assert!(!weather_enabled(&json!({})));
        assert!(!weather_enabled(&json!({"pet": {"enabled": true}})));
        assert!(!weather_enabled(&json!({"pet": {"weather": {"enabled": "yes"}}})));
        assert!(weather_enabled(&json!({"pet": {"weather": {"enabled": true}}})));
    }

    #[test]
    fn location_status_table() {
        use LocationStatus::*;
        assert_eq!(location_status(false, 3, true, None), Unavailable);
        assert_eq!(location_status(true, 0, false, None), NotAsked);
        assert_eq!(location_status(true, 0, false, Some(5.0)), Pending);
        assert_eq!(location_status(true, 0, false, Some(61.0)), Unavailable);
        assert_eq!(location_status(true, 1, false, None), Denied);
        assert_eq!(location_status(true, 2, false, Some(1.0)), Denied);
        assert_eq!(location_status(true, 3, true, None), Ok);
        assert_eq!(location_status(true, 4, true, Some(1.0)), Ok);
        assert_eq!(location_status(true, 4, false, Some(10.0)), Pending);
        assert_eq!(location_status(true, 4, false, Some(61.0)), Unavailable);
        assert_eq!(location_status(true, 9, false, None), Unavailable);
    }
}
