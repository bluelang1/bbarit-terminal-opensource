# Desktop Pet — Phase 4 Implementation Plan (weather)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox steps.

**Goal:** When the owner turns weather on, the pet shows the real weather where the Mac is: rain with an umbrella,
ripples, splashes and a puddle; snow with heavy flakes and footprints; thunder flashes; drifting fog; a small sun,
cloud or moon now and then.

**Spec:** `docs/superpowers/specs/2026-11-06-desktop-pet-design.md` — Goal 7, Anti-goals (no calls before the owner
turns weather on, ~0.1° only, no IP geolocation), "Weather".

## Global Constraints

- Default OFF (`pet.weather.enabled` false). Nothing location- or weather-related runs before the owner turns it on:
  the page never calls the weather commands while it is off, and the Rust commands also refuse when config.json
  says off (defense in depth; the settings panel retries for the 300 ms config save debounce).
- Location: macOS CoreLocation (`objc2-core-location` 0.2.2, the version already in Cargo.lock; only Cargo.lock's
  octo-ui dependency list changes). The permission prompt is requested only from Settings (turning weather on, or the
  retry button there); the pet page only reads. Re-read every 30 min while the pet is visible.
  Status: `ok` / `pending` (asked, waiting for the answer or the first fix) / `denied` (denied or restricted) /
  `unavailable` (services off, not macOS, or still no answer / fix 60 s after asking — the unbundled dev binary)
  / `notAsked` / `off`. Anything but `ok` uses the manual city; no city → no weather layer.
- Coordinates are rounded to 0.1° in Rust before they leave the machine (location results are rounded before they
  even reach JS; the forecast URL is built from rounded values). No IP geolocation.
- Provider: Open-Meteo forecast `current=weather_code,precipitation,is_day,temperature_2m`, no key, from Rust
  (`reqwest`, shared client, 15 s timeout, `#[tauri::command(async)]`), so the CSP is unchanged. City search:
  Open-Meteo geocoding (`count=8`, app language). Credit "Weather data by Open-Meteo.com" in the settings section.
- Poll every 30 min while the pet is visible (and on show when the last result is older than that). Last result
  cached in memory and localStorage (`bbarit.pet.weather`); a result older than 2 h (offline) = no weather layer.
- WMO code → `clear | cloudy | fog | drizzle | rain | thunder | snow`, `heavy` from the code (55/57/65/67/75/82/86/99)
  or precipitation >= 2.5 mm, `night` from `is_day = 0`. Unknown codes → no weather layer.
- Real weather wins when weather is on and known: winter seasonal snow is off (snow weather draws its own heavier
  flakes, never both); rain / drizzle / thunder / snow also stop petals, leaves and heat shimmer. Breath puffs stay.
  Weather on but unknown (offline, no city) → season particles as before.
- Visuals in the pet window only, pixel style (2 CSS px per art pixel), cheap: weather particles in their own pool
  (cap 28), stepped on the existing tick; ground marks (ripples, footprints, puddle) are anchored to screen x like
  the ice patch so they stay put while the pet walks on. Thunder flash: <= 120 ms, alpha <= 0.22, every 6–16 s.
- Umbrella: shared accessory at `hand` (drawn behind the body, canopy tilted over the head) while it rains / drizzles /
  thunders and the pet is awake and not held / falling / slipping / eating / typing; it replaces any other hand item.
  Bubble placement accounts for the canopy height.
- Tour: one step per weather type (+ a clear night) with fake weather, so it works without location or network.
- Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push.

## Review Focus

1. Weather OFF: zero calls to `pet_location` / `pet_weather_now` (page and Rust) — unit-tested on the feed and on the
   Rust config gate.
2. Coordinates leaving the machine have one decimal (URL test); location results are rounded in Rust.
3. Denied / unbundled dev binary: settings shows the status and the city is used; no hang (main-thread call has a
   2 s timeout).
4. No doubled snow (season + weather) and no seasonal snow in clear winter weather while weather is on.
5. Hidden pet: no polling (feed only runs from the visible loop); offline: stale cache dropped after 2 h.

---

### Task 1: Rust weather host
**Files:** Create `src-tauri/src/pet/weather.rs` (`pet::weather`); modify `src-tauri/src/main.rs` (3 commands), `src-tauri/src/pet.rs` (`pub mod weather`), `src-tauri/Entitlements.plist` (location entitlement for the hardened runtime),
`src-tauri/Cargo.toml` (+ `objc2-core-location`), `src-tauri/Cargo.lock`, `src-tauri/Info.plist`.
**Produces:** `round_tenth(f64) -> f64`; `forecast_url(lat, lon) -> Url`; `geocode_url(query, lang) -> Url`;
`parse_forecast(&Value) -> Result<PetWeatherNow, String>` (`{ code, precipitation, isDay, temperature }`);
`parse_geocode(&Value) -> Vec<PetCity>` (`{ name, admin1, country, lat, lon }`); `weather_enabled(&Value) -> bool`;
`location_status(services, auth, fix_fresh, asked_secs, ask) -> LocationStatus`.
Commands: `pet_weather_now(lat, lon)`, `pet_weather_city_search(query, language)`, `pet_location(ask) -> { status, lat, lon }`.
- [ ] Tests: rounding (incl. negatives, NaN rejected), URL has exactly one decimal and the four `current` fields,
  geocode URL encodes Hangul, parse of the real response shape, missing fields → Err, config gate (only `true`),
  status table. FAIL → implement → PASS (`cargo test ... pet::`). `cargo check --locked`. Commit.

### Task 2: Weather model + config
**Files:** Create `src/pet/weather.ts`, `src/pet/weather.test.ts`; modify `src/config/schema.ts`, `src/config/schema.test.ts`.
**Produces:** `type WeatherKind`; `type PetWeather = { kind; heavy: boolean; night: boolean }`; `weatherFromWmo(code, precip, isDay)`;
`seasonGate(weatherOn, weather) -> { seasonSnow: boolean; seasonFalling: boolean }`; `rainy(w)`; cache `loadWeatherCache` /
`saveWeatherCache`; `PetConfig.weather = { enabled: false, city: PetWeatherCity | null }` sanitized in `normalizePetConfig`.
- [ ] Tests: every WMO group, heavy by code and by precipitation, night, unknown → null; gate table; cache round trip + staleness;
  schema defaults, bad city dropped, `enabled` only `true`. FAIL → implement → PASS. Commit.

### Task 3: Weather feed (pet page controller)
**Files:** Create `src/pet/weatherFeed.ts`, `src/pet/weatherFeed.test.ts`.
**Produces:** `createWeatherFeed(deps)` with `tick(now, cfg)` (fire-and-forget, at most one request in flight) and `current(now)`;
deps `{ locate(): Promise<PetLocation>; fetchNow(lat, lon): Promise<PetWeatherNow>; storage? }`.
- [ ] Tests: disabled → no deps called; location ok → its coords; denied → city; no city → null; polls once per 30 min;
  pending location retried after 20 s; failure keeps the cache until 2 h old. FAIL → implement → PASS. Commit.

### Task 4: Weather effects + umbrella
**Files:** Create `src/pet/weatherFx.ts`, `src/pet/weatherFx.test.ts`; modify `src/pet/accessories.ts` (+ test),
`src/pet/particles.ts` (+ test).
**Produces:** `type WeatherFx` (drops, splashes, flakes, ripples, prints, puddle, flash, fog, sky);
`stepWeather(fx, w, ctx)`, `drawWeatherBack / drawWeatherFront`; `umbrella` accessory + `accessoriesFor(cal, anim, weather?)`;
`riseAbove(frame, ids)` for the bubble; `spawnFor(..., gate)`.
- [ ] Tests: caps; a drop reaching the ground becomes a splash; walking in rain spawns ripples / splash at the feet,
  in snow footprints that fade; flash short and rare; umbrella only while rainy + allowed anims, replaces pumpkin;
  season gate removes winter snow. FAIL → implement → PASS.
- [ ] Previews (throwaway script outside repo) of rain/umbrella/splash/puddle, snow/footprints, thunder, fog, clear/cloudy/night
  to `.../scratchpad/weather-preview/`, look, iterate. Commit.

### Task 5: Page wiring + tour
**Files:** Modify `src/pages/PetPage.tsx`, `src/pet/showcase.ts`, `src/pet/showcase.test.ts`, `src/i18n/*.ts`.
- [ ] Tour steps `clear, night, cloudy, fog, drizzle, rain, thunder, snow` (fake weather; ko/en captions, others English);
  `ShowcaseStep.weather` / `ShowcaseView.weather`. PetPage: feed ticks while visible, fx stepped/drawn, umbrella,
  bubble clears the canopy, season gate. Tests FAIL → implement → PASS. Commit.

### Task 6: Settings
**Files:** Modify `src/components/PetSettings.tsx`, `src/i18n/*.ts`.
- [ ] Weather toggle (asks for location ~600 ms after turning on), status line (polled every 2 s while open and not settled),
  retry button, city search + results + chosen city / clear, Open-Meteo credit. tsc + vitest + build. Commit.

### Task 7: Checks on the installed (signed) app — owner
- [ ] Permission prompt text, "위치 사용 중" after allowing, travel/re-read after 30 min, denied → city.
