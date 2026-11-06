//! Desktop pet weather (phase 4): the Mac's location and the current weather for the pet.
//!
//! Nothing here runs before the owner turns weather on (`pet.weather.enabled` in
//! ~/.config/octo/config.json); the commands refuse while it is off. Coordinates are rounded
//! to 0.1 degree (about 10 km) before they leave the machine, and location results are
//! rounded before they even reach the page. No IP geolocation.
//!
//! - `pet_location { ask }`: macOS CoreLocation. Only Settings passes `ask: true` (the
//!   permission prompt); the pet page only reads. One CLLocationManager with a delegate is
//!   created on the main thread and kept for the life of the app (CoreLocation calls the
//!   delegate on the run loop of the thread that created the manager). When authorized it
//!   asks for one fix (`requestLocation`, ~3 km accuracy); each `pet_location` call re-asks
//!   once the fix is older than 25 min, so the page's 30-min poll keeps it current. Results
//!   land in [`LocationTracker`] (rounded to 0.1 degree) and the command reports from there.
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
/// Asked for permission (or for a fix) this long ago without an answer: report
/// `unavailable` so the page falls back to the city, and allow asking again.
const LOCATION_ANSWER_SECS: f64 = 60.0;
/// A fix older than this is re-requested (the pet follows the owner when they travel). Below
/// the page's 30-min poll so every poll refreshes it.
const FIX_REFRESH_SECS: f64 = 25.0 * 60.0;
/// A fix older than this is no longer reported (the refresh kept failing).
const FIX_KEEP_SECS: f64 = 2.0 * 60.0 * 60.0;
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

/// CLAuthorizationStatus values.
const AUTH_NOT_DETERMINED: i32 = 0;
const AUTH_RESTRICTED: i32 = 1;
const AUTH_DENIED: i32 = 2;
const AUTH_ALWAYS: i32 = 3;
const AUTH_WHEN_IN_USE: i32 = 4;
/// CLError.Code `kCLErrorDenied` (the other codes, e.g. 0 locationUnknown, are transient).
const CL_ERROR_DENIED: i64 = 1;

/// What the main thread should ask CoreLocation for next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum LocationAction {
    Nothing,
    /// `requestWhenInUseAuthorization` (shows the prompt; Settings only).
    AskPermission,
    /// `requestLocation` (one fix, answered through the delegate).
    RequestFix,
}

/// CoreLocation state as seen through the delegate, and the decisions on it. Pure: `now` is
/// seconds on any monotonic clock, so the transitions are unit tested.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct LocationTracker {
    /// Last CLAuthorizationStatus seen; None before the manager exists.
    auth: Option<i32>,
    /// Rounded lat, lon and when it arrived.
    fix: Option<(f64, f64, f64)>,
    /// When the permission prompt was last requested.
    asked_at: Option<f64>,
    /// When a fix was last requested.
    requested_at: Option<f64>,
    /// That request has not been answered yet.
    in_flight: bool,
    /// The last request ended in an error.
    failed: bool,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl LocationTracker {
    pub const fn new() -> Self {
        Self { auth: None, fix: None, asked_at: None, requested_at: None, in_flight: false, failed: false }
    }

    pub fn on_auth(&mut self, auth: i32) {
        self.auth = Some(auth);
        if !matches!(auth, AUTH_ALWAYS | AUTH_WHEN_IN_USE) {
            // Revoked (or reset): forget the old position.
            self.fix = None;
            self.in_flight = false;
        }
    }

    /// A fix from `locationManager:didUpdateLocations:`; invalid coordinates count as a failure.
    pub fn on_fix(&mut self, lat: f64, lon: f64, now: f64) {
        self.in_flight = false;
        match rounded_coords(lat, lon) {
            Some((lat, lon)) => {
                self.fix = Some((lat, lon, now));
                self.failed = false;
            }
            None => self.failed = true,
        }
    }

    /// `locationManager:didFailWithError:` with the CLError code.
    pub fn on_error(&mut self, code: i64) {
        self.in_flight = false;
        self.failed = true;
        if code == CL_ERROR_DENIED {
            self.fix = None;
        }
    }

    /// What to do now. Asks permission only when `ask` (Settings) and not asked within the
    /// answer window; requests a fix when authorized and the fix is missing or older than
    /// [`FIX_REFRESH_SECS`], unless a request is still in flight or failed within the window.
    pub fn next_action(&self, ask: bool, now: f64) -> LocationAction {
        let within = |at: Option<f64>| at.is_some_and(|t| now - t <= LOCATION_ANSWER_SECS);
        match self.auth {
            Some(AUTH_NOT_DETERMINED) if ask && !within(self.asked_at) => LocationAction::AskPermission,
            Some(AUTH_ALWAYS | AUTH_WHEN_IN_USE) => {
                let fresh = self.fix.is_some_and(|(_, _, at)| now - at < FIX_REFRESH_SECS);
                let waiting = (self.in_flight || self.failed) && within(self.requested_at);
                if !fresh && !waiting {
                    LocationAction::RequestFix
                } else {
                    LocationAction::Nothing
                }
            }
            _ => LocationAction::Nothing,
        }
    }

    /// Record that `action` was sent to CoreLocation.
    pub fn did(&mut self, action: LocationAction, now: f64) {
        match action {
            LocationAction::AskPermission => self.asked_at = Some(now),
            LocationAction::RequestFix => {
                self.requested_at = Some(now);
                self.in_flight = true;
            }
            LocationAction::Nothing => {}
        }
    }

    /// The `pet_location` answer. `services`: location services are on for the Mac.
    pub fn report(&self, services: bool, now: f64) -> PetLocation {
        use LocationStatus::*;
        let within = |at: Option<f64>| at.is_some_and(|t| now - t <= LOCATION_ANSWER_SECS);
        if !services {
            return PetLocation::only(Unavailable);
        }
        let status = match self.auth {
            None => Pending,
            Some(AUTH_RESTRICTED | AUTH_DENIED) => Denied,
            Some(AUTH_ALWAYS | AUTH_WHEN_IN_USE) => {
                if let Some((lat, lon, at)) = self.fix {
                    if now - at <= FIX_KEEP_SECS {
                        return PetLocation { status: Ok, lat: Some(lat), lon: Some(lon) };
                    }
                }
                if self.in_flight && within(self.requested_at) {
                    Pending
                } else if self.failed || self.in_flight {
                    // Failed, or no answer within the window.
                    Unavailable
                } else {
                    // Authorized; the first request is about to go out.
                    Pending
                }
            }
            Some(AUTH_NOT_DETERMINED) => match self.asked_at {
                None => NotAsked,
                at if within(at) => Pending,
                // No answer (the unbundled dev binary never shows the prompt).
                _ => Unavailable,
            },
            Some(_) => Unavailable,
        };
        PetLocation::only(status)
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
    if services {
        // Create the manager / send the next request on the main thread; the answers arrive
        // later through the delegate, so this only waits for the step itself.
        let (tx, rx) = std::sync::mpsc::channel();
        if app
            .run_on_main_thread(move || {
                mac::step_on_main(ask);
                let _ = tx.send(());
            })
            .is_ok()
        {
            let _ = rx.recv_timeout(Duration::from_secs(2));
        }
    }
    mac::report(services)
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{LocationAction, LocationTracker, PetLocation};
    use objc2_05::rc::Retained;
    use objc2_05::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2_05::{declare_class, msg_send, msg_send_id, mutability, sel, ClassType, DeclaredClass};
    use objc2_core_location::{
        kCLLocationAccuracyThreeKilometers, CLLocation, CLLocationManager, CLLocationManagerDelegate,
    };
    use objc2_foundation_02::{NSArray, NSError};
    use std::cell::Cell;
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use std::time::Instant;

    /// Written by the delegate (main thread), read by `pet_location` (any thread).
    static TRACKER: Mutex<LocationTracker> = Mutex::new(LocationTracker::new());

    thread_local! {
        /// Created once on the main thread and kept for the life of the app (with its delegate,
        /// which the manager only holds weakly).
        static MANAGER: Cell<Option<&'static CLLocationManager>> = const { Cell::new(None) };
    }

    fn tracker() -> MutexGuard<'static, LocationTracker> {
        TRACKER.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn now() -> f64 {
        static ORIGIN: OnceLock<Instant> = OnceLock::new();
        ORIGIN.get_or_init(Instant::now).elapsed().as_secs_f64()
    }

    pub(super) fn report(services: bool) -> PetLocation {
        tracker().report(services, now())
    }

    declare_class!(
        struct PetLocationDelegate;

        // SAFETY: NSObject has no subclassing requirements; no ivars, no Drop. Only used on
        // the main thread (CoreLocation calls it on the creating thread's run loop).
        unsafe impl ClassType for PetLocationDelegate {
            type Super = NSObject;
            type Mutability = mutability::InteriorMutable;
            const NAME: &'static str = "BbaritPetLocationDelegate";
        }

        impl DeclaredClass for PetLocationDelegate {}

        unsafe impl NSObjectProtocol for PetLocationDelegate {}

        // SAFETY: the signatures match CLLocationManagerDelegate.
        unsafe impl CLLocationManagerDelegate for PetLocationDelegate {
            /// macOS 11+; also called right after the delegate is set.
            #[method(locationManagerDidChangeAuthorization:)]
            fn did_change_authorization(&self, manager: &CLLocationManager) {
                step(manager, false);
            }

            /// Before macOS 11 (newer systems call only the method above when both exist).
            #[method(locationManager:didChangeAuthorizationStatus:)]
            fn did_change_authorization_status(
                &self,
                manager: &CLLocationManager,
                _status: objc2_core_location::CLAuthorizationStatus,
            ) {
                step(manager, false);
            }

            #[method(locationManager:didUpdateLocations:)]
            fn did_update_locations(&self, _manager: &CLLocationManager, locations: &NSArray<CLLocation>) {
                // SAFETY: CLLocation getters on a delivered location.
                let coord = unsafe { locations.lastObject() }.map(|loc| unsafe { loc.coordinate() });
                let mut t = tracker();
                match coord {
                    Some(c) => t.on_fix(c.latitude, c.longitude, now()),
                    None => t.on_fix(f64::NAN, f64::NAN, now()),
                }
            }

            #[method(locationManager:didFailWithError:)]
            fn did_fail_with_error(&self, _manager: &CLLocationManager, error: &NSError) {
                tracker().on_error(error.code() as i64);
            }
        }
    );

    impl PetLocationDelegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            // SAFETY: NSObject's designated initializer.
            unsafe { msg_send_id![super(this), init] }
        }
    }

    fn responds(mgr: &CLLocationManager, selector: objc2_05::runtime::Sel) -> bool {
        // SAFETY: -[NSObject respondsToSelector:] with a valid selector.
        unsafe { msg_send![mgr, respondsToSelector: selector] }
    }

    fn authorization(mgr: &CLLocationManager) -> i32 {
        // SAFETY: CLLocationManager getters on the main thread that created it. The instance
        // getter is macOS 11+; older systems only have the (deprecated) class method.
        unsafe {
            if responds(mgr, sel!(authorizationStatus)) {
                mgr.authorizationStatus().0
            } else {
                #[allow(deprecated)]
                CLLocationManager::authorizationStatus_class().0
            }
        }
    }

    fn manager() -> &'static CLLocationManager {
        MANAGER.with(|m| {
            if let Some(existing) = m.get() {
                return existing;
            }
            // SAFETY: allocation and setters on the main thread. Both objects are leaked on
            // purpose (one per app) so the delegate keeps receiving answers.
            let created: &'static CLLocationManager = unsafe {
                let mgr: &'static CLLocationManager = Box::leak(Box::new(CLLocationManager::new()));
                // About 3 km is plenty (the coordinates are rounded to ~10 km anyway) and the
                // cheapest fix CoreLocation offers.
                mgr.setDesiredAccuracy(kCLLocationAccuracyThreeKilometers);
                let delegate: &'static PetLocationDelegate = Box::leak(Box::new(PetLocationDelegate::new()));
                m.set(Some(mgr));
                mgr.setDelegate(Some(ProtocolObject::from_ref(delegate)));
                mgr
            };
            created
        })
    }

    /// Main thread: refresh the authorization and send the next request, if any.
    fn step(mgr: &CLLocationManager, ask: bool) {
        let auth = authorization(mgr);
        let t = now();
        let action = {
            let mut tr = tracker();
            tr.on_auth(auth);
            let action = tr.next_action(ask, t);
            tr.did(action, t);
            action
        };
        // Outside the lock: CoreLocation may call the delegate back synchronously.
        // SAFETY: CLLocationManager methods on the main thread that created it; both selectors
        // are checked first (requestWhenInUseAuthorization is macOS 10.15+, requestLocation 10.14+).
        unsafe {
            match action {
                LocationAction::AskPermission if responds(mgr, sel!(requestWhenInUseAuthorization)) => {
                    mgr.requestWhenInUseAuthorization()
                }
                LocationAction::RequestFix if responds(mgr, sel!(requestLocation)) => mgr.requestLocation(),
                _ => {}
            }
        }
    }

    /// Runs on the main thread (CLLocationManager's home).
    pub(super) fn step_on_main(ask: bool) {
        step(manager(), ask);
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use objc2_05::ProtocolType;

        /// The class registers (debug builds check each method's type encoding against the
        /// protocol) and conforms, so CoreLocation will call it. No manager, no TCC.
        #[test]
        fn delegate_class_registers_and_conforms() {
            let d = PetLocationDelegate::new();
            let proto = <dyn CLLocationManagerDelegate>::protocol().expect("CLLocationManagerDelegate");
            assert!(PetLocationDelegate::class().conforms_to(proto));
            for name in [
                "locationManagerDidChangeAuthorization:",
                "locationManager:didChangeAuthorizationStatus:",
                "locationManager:didUpdateLocations:",
                "locationManager:didFailWithError:",
            ] {
                let sel = objc2_05::runtime::Sel::register(name);
                // SAFETY: -[NSObject respondsToSelector:].
                let ok: bool = unsafe { msg_send![&*d, respondsToSelector: sel] };
                assert!(ok, "{name}");
            }
        }
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

    fn status(t: &LocationTracker, now: f64) -> LocationStatus {
        t.report(true, now).status
    }

    fn authorized(auth: i32) -> LocationTracker {
        let mut t = LocationTracker::new();
        t.on_auth(auth);
        t
    }

    #[test]
    fn tracker_maps_authorization_to_status() {
        use LocationStatus::*;
        let fresh = LocationTracker::new();
        assert_eq!(status(&fresh, 0.0), Pending, "manager not created yet");
        assert_eq!(fresh.report(false, 0.0).status, Unavailable, "location services off");
        assert_eq!(status(&authorized(0), 0.0), NotAsked);
        assert_eq!(status(&authorized(1), 0.0), Denied, "restricted");
        assert_eq!(status(&authorized(2), 0.0), Denied);
        assert_eq!(status(&authorized(3), 0.0), Pending, "authorized, request not sent yet");
        assert_eq!(status(&authorized(4), 0.0), Pending);
        assert_eq!(status(&authorized(9), 0.0), Unavailable, "unknown status");
    }

    #[test]
    fn tracker_asks_permission_only_when_settings_asks() {
        use LocationAction::*;
        let mut t = authorized(0);
        assert_eq!(t.next_action(false, 0.0), Nothing, "the pet page never prompts");
        assert_eq!(t.next_action(true, 0.0), AskPermission);
        t.did(AskPermission, 0.0);
        assert_eq!(status(&t, 30.0), LocationStatus::Pending);
        assert_eq!(t.next_action(true, 30.0), Nothing, "no second prompt while waiting");
        // No answer (unbundled dev binary): city fallback, and the retry button may ask again.
        assert_eq!(status(&t, 61.0), LocationStatus::Unavailable);
        assert_eq!(t.next_action(true, 61.0), AskPermission);
        // The owner allows: a fix is requested right away (from the delegate, ask = false).
        t.on_auth(4);
        assert_eq!(t.next_action(false, 62.0), RequestFix);
    }

    #[test]
    fn tracker_requests_one_fix_and_reports_it_rounded() {
        use LocationAction::*;
        let mut t = authorized(4);
        assert_eq!(t.next_action(false, 0.0), RequestFix);
        t.did(RequestFix, 0.0);
        assert_eq!(t.next_action(false, 5.0), Nothing, "request in flight");
        assert_eq!(status(&t, 5.0), LocationStatus::Pending);
        t.on_fix(37.56651234, 126.97841234, 8.0);
        assert_eq!(
            t.report(true, 9.0),
            PetLocation { status: LocationStatus::Ok, lat: Some(37.6), lon: Some(127.0) }
        );
        assert_eq!(t.next_action(false, 9.0), Nothing, "fresh fix");
    }

    #[test]
    fn tracker_refreshes_on_the_page_poll() {
        use LocationAction::*;
        let mut t = authorized(3);
        t.did(RequestFix, 0.0);
        t.on_fix(-33.8688, 151.2093, 1.0);
        // The page polls every 30 min: the fix is due by then, the old one stays meanwhile.
        let poll = 1.0 + 30.0 * 60.0;
        assert_eq!(t.next_action(false, 1.0 + 24.0 * 60.0), Nothing);
        assert_eq!(t.next_action(false, poll), RequestFix);
        t.did(RequestFix, poll);
        assert_eq!(t.report(true, poll).lat, Some(-33.9), "old fix kept while refreshing");
        t.on_error(0);
        assert_eq!(status(&t, poll + 5.0), LocationStatus::Ok, "a transient error keeps the fix");
        // Refresh keeps failing for over 2 hours: the old fix is dropped.
        assert_eq!(status(&t, 1.0 + 2.0 * 3600.0 + 1.0), LocationStatus::Unavailable);
    }

    #[test]
    fn tracker_failures_and_timeouts_fall_back_to_the_city() {
        use LocationAction::*;
        let mut t = authorized(4);
        t.did(RequestFix, 0.0);
        t.on_error(0);
        assert_eq!(status(&t, 1.0), LocationStatus::Unavailable);
        assert_eq!(t.next_action(false, 30.0), Nothing, "no retry storm");
        assert_eq!(t.next_action(false, 61.0), RequestFix);
        t.did(RequestFix, 61.0);
        assert_eq!(status(&t, 100.0), LocationStatus::Pending);
        assert_eq!(status(&t, 122.0), LocationStatus::Unavailable, "no answer within 60 s");
        t.on_fix(f64::NAN, 0.0, 123.0);
        assert_eq!(status(&t, 124.0), LocationStatus::Unavailable, "invalid fix");
        t.on_fix(91.0, 0.0, 125.0);
        assert_eq!(status(&t, 126.0), LocationStatus::Unavailable, "out of range");
    }

    #[test]
    fn tracker_forgets_the_fix_when_permission_is_revoked() {
        let mut t = authorized(4);
        t.did(LocationAction::RequestFix, 0.0);
        t.on_fix(37.5, 127.0, 1.0);
        t.on_auth(2);
        assert_eq!(t.report(true, 2.0), PetLocation::only(LocationStatus::Denied));
        assert_eq!(t.next_action(true, 2.0), LocationAction::Nothing);
        // Granted again: the old fix is gone, a new one is requested.
        t.on_auth(4);
        assert_eq!(status(&t, 3.0), LocationStatus::Pending);
        assert_eq!(t.next_action(false, 3.0), LocationAction::RequestFix);
        // kCLErrorDenied also drops it.
        let mut d = authorized(4);
        d.on_fix(37.5, 127.0, 0.0);
        d.on_error(1);
        assert_eq!(status(&d, 1.0), LocationStatus::Unavailable);
    }
}
