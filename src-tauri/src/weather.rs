use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::Manager;

const REFRESH_SECS: u64 = 300;
// A newly accepted observation may already be up to two minutes old.
const MAX_OBSERVATION_AGE: i64 = 1920;
const MAX_FETCH_AGE: i64 = 1800;
const PROJECT: &str = "c7ea6bbc-110d-4dc9-ac75-4653ebbbca49";
const DOCK: &str = "AHRXNBN00A029A";

#[derive(Default)]
pub struct Weather {
    cache: Mutex<Cache>,
    fetch_lock: tokio::sync::Mutex<()>,
    refreshing: AtomicBool,
}
#[derive(Default)]
struct Cache {
    sample: Option<Sample>,
    error: Option<String>,
    attempt: Option<Instant>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    key: String,
    label: String,
    value: String,
    level: u8,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    observed_at: i64,
    condition: String,
    temperature: f64,
    humidity: f64,
    precipitation: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    observed_at: i64,
    fetched_at: i64,
    temperature: Option<f64>,
    weather_code: Option<u64>,
    wind_speed: Option<f64>,
    wind_gusts: Option<f64>,
    wind_direction: Option<f64>,
    precipitation: Option<f64>,
    // Optional for deserializing historical Open-Meteo creation snapshots.
    #[serde(default)]
    airworthy: Option<u8>,
    #[serde(default)]
    platform_label: Option<String>,
    #[serde(default)]
    rainfall: Option<f64>,
    #[serde(default)]
    latitude: Option<f64>,
    #[serde(default)]
    longitude: Option<f64>,
    #[serde(default)]
    forecast: Option<Forecast>,
    #[serde(default)]
    items: Vec<Item>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    location: String,
    latitude: f64,
    longitude: f64,
    source: String,
    refreshing: bool,
    pub allowed: bool,
    pub(crate) level: String,
    label: String,
    pub reasons: Vec<String>,
    current: Option<Sample>,
}
fn parse_response(raw: &Value, now: i64) -> Result<Sample, String> {
    let expected_url = format!("https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/{PROJECT}#/team");
    if raw["url"] != expected_url
        || raw["projectId"] != PROJECT
        || raw["dockSn"] != DOCK
        || raw["adapterVersion"] != 1
    {
        return Err("司空气象回执身份不匹配，请更新浏览器插件。".into());
    }
    let mut value = raw.clone();
    value["platformLabel"] = raw["label"].clone();
    let sample: Sample = serde_json::from_value(value).map_err(|_| "司空气象回执不完整。")?;
    if !(-60..=120).contains(&(now - sample.observed_at))
        || !(0..=120).contains(&(now - sample.fetched_at))
        || !matches!(sample.airworthy, Some(1..=3))
        || sample
            .platform_label
            .as_ref()
            .is_none_or(|s| s.trim().is_empty())
        || sample.wind_speed.is_none_or(|v| !v.is_finite() || v < 0.)
        || sample.rainfall.is_none_or(|v| !v.is_finite() || v < 0.)
        || sample.temperature.is_none_or(|v| !v.is_finite())
        || sample
            .latitude
            .is_none_or(|v| !v.is_finite() || v.abs() > 90.)
        || sample
            .longitude
            .is_none_or(|v| !v.is_finite() || v.abs() > 180.)
        || sample
            .forecast
            .as_ref()
            .is_none_or(|f| !(0..=3600).contains(&(now - f.observed_at)) || f.condition.is_empty())
        || sample.items.is_empty()
        || sample
            .items
            .iter()
            .any(|i| !(1..=3).contains(&i.level) || i.value.trim().is_empty())
    {
        return Err("司空气象数据缺失、过期或结论无效，请刷新。".into());
    }
    Ok(sample)
}
fn assess(sample: Option<&Sample>, error: Option<&str>, now: i64) -> (&'static str, Vec<String>) {
    if let Some(error) = error {
        return ("unknown", vec![error.into()]);
    }
    let Some(s) = sample else {
        return ("unknown", vec!["等待司空气象数据和适飞结论。".into()]);
    };
    if !(0..=MAX_FETCH_AGE).contains(&(now - s.fetched_at))
        || !(-60..=MAX_OBSERVATION_AGE).contains(&(now - s.observed_at))
    {
        return ("unknown", vec!["司空气象数据已过期，请刷新。".into()]);
    }
    // Only map DJI's enum. Do not reproduce meteorological thresholds here.
    let level = match s.airworthy {
        Some(1) => "ok",
        Some(2) => "caution",
        Some(3) => "unsafe",
        _ => "unknown",
    };
    let mut reasons: Vec<String> = s
        .items
        .iter()
        .filter(|i| i.level > 1)
        .map(|i| format!("{}：{}", i.label, i.value))
        .collect();
    if reasons.is_empty() {
        reasons.push(format!(
            "司空判定：{}",
            s.platform_label.as_deref().unwrap_or("暂无法判断")
        ));
    }
    (level, reasons)
}
pub fn view(app: &tauri::AppHandle) -> View {
    let state = app.state::<Weather>();
    let cache = state.cache.lock().unwrap();
    let (level, reasons) = assess(
        cache.sample.as_ref(),
        cache.error.as_deref(),
        Utc::now().timestamp(),
    );
    let sample = cache.sample.as_ref();
    View {
        location: "泰州环境监测 Dock 3".into(),
        latitude: sample.and_then(|s| s.latitude).unwrap_or(32.434676),
        longitude: sample.and_then(|s| s.longitude).unwrap_or(119.929701),
        source: "DJI FlightHub 2".into(),
        refreshing: state.refreshing.load(Ordering::SeqCst),
        allowed: level == "ok",
        level: level.into(),
        label: if level == "unknown" {
            "暂无法判断".into()
        } else {
            sample
                .and_then(|s| s.platform_label.clone())
                .unwrap_or_else(|| "暂无法判断".into())
        },
        reasons,
        current: cache.sample.clone(),
    }
}

/// DJI hourly forecast direction (where wind comes from), not Dock OSD wind.
/// A manual override of the weather verdict must not revive a failed/stale read.
pub fn current_wind_direction(app: &tauri::AppHandle) -> Option<f64> {
    let state = app.state::<Weather>();
    let cache = state.cache.lock().unwrap();
    forecast_wind_direction(&cache, Utc::now().timestamp())
}
fn forecast_wind_direction(cache: &Cache, now: i64) -> Option<f64> {
    if cache.error.is_some() {
        return None;
    }
    let sample = cache.sample.as_ref()?;
    let forecast = sample.forecast.as_ref()?;
    if !(0..=120).contains(&(now - sample.fetched_at))
        || !(-60..=MAX_OBSERVATION_AGE).contains(&(now - sample.observed_at))
        || !(0..=3600).contains(&(now - forecast.observed_at))
    {
        return None;
    }
    sample.wind_direction
        .filter(|value| value.is_finite() && (0.0..=360.0).contains(value))
        .map(|value| value.rem_euclid(360.0))
}
async fn fetch(app: &tauri::AppHandle) -> Result<Sample, String> {
    let bridge = app.state::<crate::bridge::Bridge>();
    let session = bridge.single_session()?;
    let raw = bridge
        .request(session, -1, json!({"type":"dji-weather"}))
        .await?;
    parse_response(&raw, Utc::now().timestamp())
}
pub async fn refresh(app: &tauri::AppHandle, force: bool) {
    let state = app.state::<Weather>();
    let requested_at = Instant::now();
    let _lock = state.fetch_lock.lock().await;
    {
        let cache = state.cache.lock().unwrap();
        // Concurrent manual/automatic requests share the result of the first fetch.
        if cache.attempt.is_some_and(|t| {
            t >= requested_at
                || (!force
                    && t.elapsed()
                        < Duration::from_secs(if cache.error.is_some() {
                            30
                        } else {
                            REFRESH_SECS
                        }))
        }) {
            return;
        }
    }
    state.refreshing.store(true, Ordering::SeqCst);
    struct Guard<'a>(&'a AtomicBool);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = Guard(&state.refreshing);
    crate::runtime_log::record(
        app,
        "info",
        "weather",
        "weather.started",
        "开始获取机场天气",
        json!({"force":force}),
    );
    let result = fetch(app).await;
    crate::runtime_log::record(
        app,
        if result.is_ok() { "info" } else { "warning" },
        "weather",
        "weather.finished",
        if result.is_ok() {
            "机场天气已更新"
        } else {
            "机场天气获取失败"
        },
        match &result {
            Ok(sample) => {
                json!({"observedAt":sample.observed_at,"verdict":sample.platform_label,"airworthy":sample.airworthy,
                    "forecastWindDirection":sample.wind_direction,
                    "forecastObservedAt":sample.forecast.as_ref().map(|forecast| forecast.observed_at)})
            }
            Err(error) => json!({"error":error}),
        },
    );
    let mut cache = state.cache.lock().unwrap();
    cache.attempt = Some(Instant::now());
    match result {
        Ok(sample) => {
            cache.sample = Some(sample);
            cache.error = None;
        }
        Err(error) => cache.error = Some(error),
    }
}
// Refresh only to select a route. A missing/failed read falls back to the default
// route; the platform verdict is recorded/displayed, never a local launch gate.
pub async fn refresh_for_route(app: &tauri::AppHandle) {
    let recent = {
        let state = app.state::<Weather>();
        let cache = state.cache.lock().unwrap();
        recent_launch_sample(&cache, Utc::now().timestamp())
    };
    if !recent {
        refresh(app, true).await;
    }
}
fn recent_launch_sample(cache: &Cache, now: i64) -> bool {
    cache.error.is_none()
        && cache
            .attempt
            .is_some_and(|t| t.elapsed() < Duration::from_secs(15))
        && cache.sample.as_ref().is_some_and(|s| {
            (0..=15).contains(&(now - s.fetched_at))
                && (-60..=120).contains(&(now - s.observed_at))
                && matches!(s.airworthy, Some(1..=3))
        })
}
#[tauri::command]
pub async fn refresh_weather(app: tauri::AppHandle) {
    refresh(&app, true).await;
}
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            refresh(&app, false).await;
            // Retry startup/login/bridge failures promptly once Chrome becomes available.
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forecast_wind_direction_preserves_north_and_rejects_missing_stale_or_failed_reads() {
        let mut raw = receipt(10000);
        raw["windDirection"] = json!(66.0);
        let mut cache = Cache {
            sample: Some(parse_response(&raw, 10000).unwrap()),
            error: None,
            attempt: Some(Instant::now()),
        };
        assert_eq!(forecast_wind_direction(&cache, 10000), Some(66.0));
        for verdict in [1, 2, 3] {
            cache.sample.as_mut().unwrap().airworthy = Some(verdict);
            assert_eq!(forecast_wind_direction(&cache, 10000), Some(66.0));
        }
        for (value, expected) in [(Some(0.0), Some(0.0)), (Some(360.0), Some(0.0)), (None, None), (Some(-1.0), None), (Some(361.0), None), (Some(f64::NAN), None)] {
            cache.sample.as_mut().unwrap().wind_direction = value;
            assert_eq!(forecast_wind_direction(&cache, 10000), expected);
        }
        cache.sample.as_mut().unwrap().wind_direction = Some(66.0);
        assert_eq!(forecast_wind_direction(&cache, 9999), None);
        assert_eq!(forecast_wind_direction(&cache, 10121), None);
        cache.sample.as_mut().unwrap().forecast.as_mut().unwrap().observed_at = 6399;
        assert_eq!(forecast_wind_direction(&cache, 10000), None);
        cache.sample.as_mut().unwrap().forecast.as_mut().unwrap().observed_at = 10001;
        assert_eq!(forecast_wind_direction(&cache, 10000), None);
        cache.sample.as_mut().unwrap().forecast.as_mut().unwrap().observed_at = 10000;
        cache.error = Some("weather refresh failed".into());
        assert_eq!(forecast_wind_direction(&cache, 10000), None);
    }
    fn receipt(now: i64) -> Value {
        json!({"url":format!("https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/{PROJECT}#/team"),
            "projectId":PROJECT,"dockSn":DOCK,"adapterVersion":1,"observedAt":now,"fetchedAt":now,
            "latitude":32.434676,"longitude":119.929701,"temperature":22.,"windSpeed":20.,"rainfall":0.,
            "airworthy":1,"label":"适合飞行","items":[{"key":"windSpeed","label":"风速","value":"20 m/s","level":1}],
            "forecast":{"observedAt":now-60,"condition":"晴","temperature":19.,"humidity":80.,"precipitation":0.}})
    }
    #[test]
    fn launch_reuses_only_a_just_validated_receipt_and_never_a_failed_refresh() {
        let mut cache = Cache {
            sample: Some(parse_response(&receipt(10000), 10000).unwrap()),
            error: None,
            attempt: Some(Instant::now()),
        };
        assert!(recent_launch_sample(&cache, 10001));
        assert!(!recent_launch_sample(&cache, 10016));
        assert!(!recent_launch_sample(&cache, 11799)); // Display cache cannot bypass launch refresh.
        assert!(!recent_launch_sample(&cache, 9999));
        cache.error = Some("component unavailable".into());
        assert!(!recent_launch_sample(&cache, 10001));
        cache.error = None;
        cache.sample.as_mut().unwrap().observed_at = 9879;
        assert!(!recent_launch_sample(&cache, 10000));
        cache.sample = Some(parse_response(&receipt(10000), 10000).unwrap());
        cache.attempt = Some(Instant::now() - Duration::from_secs(16));
        assert!(!recent_launch_sample(&cache, 10000));
    }
    #[test]
    fn maps_only_platform_verdict_and_never_uses_local_wind_thresholds() {
        let mut raw = receipt(10000);
        let sample = parse_response(&raw, 10000).unwrap();
        assert_eq!(assess(Some(&sample), None, 10000).0, "ok");
        assert_eq!(assess(Some(&sample), None, 11799).0, "ok");
        raw["windSpeed"] = json!(0.);
        for (verdict, level) in [(1, "ok"), (2, "caution"), (3, "unsafe")] {
            raw["airworthy"] = json!(verdict);
            let sample = parse_response(&raw, 10000).unwrap();
            assert_eq!(assess(Some(&sample), None, 10000).0, level);
        }
        assert_eq!(assess(Some(&sample), None, 11801).0, "unknown");
        assert_eq!(assess(Some(&sample), Some("离线"), 10000).0, "unknown");
    }
    #[test]
    fn rejects_wrong_device_schema_stale_and_missing_platform_data() {
        for (key, value) in [
            ("dockSn", json!("other")),
            ("projectId", json!("other")),
            ("adapterVersion", json!(0)),
            ("airworthy", json!(0)),
            ("observedAt", json!(9879)),
            ("fetchedAt", json!(10001)),
            ("windSpeed", Value::Null),
            ("rainfall", Value::Null),
            ("forecast", Value::Null),
            ("items", json!([])),
        ] {
            let mut raw = receipt(10000);
            raw[key] = value;
            assert!(parse_response(&raw, 10000).is_err(), "{key}");
        }
    }
    #[test]
    fn old_snapshots_still_deserialize_but_cannot_establish_a_live_verdict() {
        let raw = json!({"observedAt":10000,"fetchedAt":10000,"windSpeed":0.,"weatherCode":0,"precipitation":0.});
        let sample: Sample = serde_json::from_value(raw).unwrap();
        assert_eq!(assess(Some(&sample), None, 10000).0, "unknown");
    }
}
