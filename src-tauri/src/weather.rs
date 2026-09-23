use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::Manager;

const LAT: &str = "32.434525";
const LNG: &str = "119.92992";
const REFRESH_SECS: u64 = 300;
const MAX_OBSERVATION_AGE: i64 = 1800;
const MAX_FETCH_AGE: i64 = 600;

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
pub struct Sample {
    observed_at: i64,
    fetched_at: i64,
    temperature: Option<f64>,
    weather_code: Option<u64>,
    wind_speed: Option<f64>,
    wind_gusts: Option<f64>,
    wind_direction: Option<f64>,
    precipitation: Option<f64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    location: &'static str,
    latitude: f64,
    longitude: f64,
    source: &'static str,
    refreshing: bool,
    pub allowed: bool,
    level: &'static str,
    label: &'static str,
    pub reasons: Vec<String>,
    current: Option<Sample>,
}
fn nonnegative(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite() && *v >= 0.)
}
fn parse_response(raw: &Value, now: i64) -> Result<Sample, String> {
    let c = &raw["current"];
    let units = &raw["current_units"];
    if units["wind_speed_10m"] != "m/s"
        || units["wind_gusts_10m"] != "m/s"
        || units["precipitation"] != "mm"
        || units["time"] != "unixtime"
    {
        return Err("天气接口返回的单位不匹配，暂不能判断飞行条件。".into());
    }
    let observed_at = c["time"]
        .as_i64()
        .filter(|t| DateTime::from_timestamp(*t, 0).is_some())
        .ok_or("天气数据缺少有效时间。")?;
    Ok(Sample {
        observed_at,
        fetched_at: now,
        temperature: c["temperature_2m"].as_f64().filter(|v| v.is_finite()),
        weather_code: c["weather_code"].as_u64(),
        wind_speed: nonnegative(&c["wind_speed_10m"]),
        wind_gusts: nonnegative(&c["wind_gusts_10m"]),
        wind_direction: nonnegative(&c["wind_direction_10m"]).filter(|v| *v <= 360.),
        precipitation: nonnegative(&c["precipitation"]),
    })
}
fn assess(sample: Option<&Sample>, error: Option<&str>, now: i64) -> (&'static str, Vec<String>) {
    if let Some(error) = error {
        return ("unknown", vec![error.into()]);
    }
    let Some(s) = sample else {
        return (
            "unknown",
            vec!["等待获取机场天气，暂不能判断飞行条件。".into()],
        );
    };
    if !(0..=MAX_FETCH_AGE).contains(&(now - s.fetched_at))
        || !(-60..=MAX_OBSERVATION_AGE).contains(&(now - s.observed_at))
    {
        return (
            "unknown",
            vec!["天气数据已过期或时间异常，请刷新后再判断。".into()],
        );
    }
    let mut reasons = Vec::new();
    let mut level = "ok";
    match s.weather_code {
        Some(0..=3) => {}
        Some(45 | 48) => {
            level = "caution";
            reasons.push("有雾，能见度不足，暂停准备计划。".into());
        }
        Some(
            51 | 53 | 55 | 56 | 57 | 61 | 63 | 65 | 66 | 67 | 71 | 73 | 75 | 77 | 80 | 81 | 82 | 85
            | 86 | 95 | 96 | 99,
        ) => {
            level = "unsafe";
            reasons.push("存在降水、降雪或雷暴，不满足无降水起飞条件。".into());
        }
        _ => {
            level = "unknown";
            reasons.push("天气现象数据缺失或无法识别。".into());
        }
    }
    if s.precipitation.is_some_and(|v| v > 0.) {
        level = "unsafe";
        reasons.push(format!("当前时段降水量 {} mm。", s.precipitation.unwrap()));
    }
    for (name, value) in [("风速", s.wind_speed), ("阵风", s.wind_gusts)] {
        if let Some(v) = value {
            if v > 10. {
                level = "unsafe";
                reasons.push(format!("{name} {v:.1} m/s，超过 10 m/s。"));
            } else if v > 6. {
                if level == "ok" {
                    level = "caution";
                }
                reasons.push(format!("{name} {v:.1} m/s，超过 6 m/s，需现场复核。"));
            }
        }
    }
    if [s.wind_speed, s.wind_gusts, s.precipitation]
        .iter()
        .any(Option::is_none)
    {
        if level != "unsafe" {
            level = "unknown";
        }
        reasons.push("风速、阵风或降水数据不完整，暂停准备计划。".into());
    }
    if reasons.is_empty() {
        reasons.push("无降水，风速及阵风均不超过 6 m/s。".into());
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
    View {
        location: "泰州环境监测 Dock 3",
        latitude: LAT.parse().unwrap(),
        longitude: LNG.parse().unwrap(),
        source: "Open-Meteo",
        refreshing: state.refreshing.load(Ordering::SeqCst),
        allowed: level == "ok",
        level,
        label: match level {
            "ok" => "天气条件通过",
            "unsafe" => "不宜起飞",
            "caution" => "需现场复核",
            _ => "暂无法判断",
        },
        reasons,
        current: cache.sample.clone(),
    }
}
async fn fetch() -> Result<Sample, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "天气连接初始化失败。")?;
    let mut url = tauri::Url::parse("https://api.open-meteo.com/v1/forecast").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("latitude", LAT), ("longitude", LNG),
        ("current", "temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation"),
        ("wind_speed_unit", "ms"), ("timeformat", "unixtime"), ("timezone", "Asia/Shanghai"), ("forecast_days", "1"),
    ]);
    let response = client.get(url).send().await.map_err(|e| {
        if e.is_timeout() {
            "天气获取超时，请稍后重试。"
        } else {
            "无法连接天气服务，请检查网络。"
        }
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "天气服务返回 HTTP {}，请稍后重试。",
            response.status().as_u16()
        ));
    }
    let body = response.text().await.map_err(|_| "天气响应读取失败。")?;
    let raw: Value = serde_json::from_str(&body).map_err(|_| "天气响应格式无效。")?;
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
            t >= requested_at || (!force && t.elapsed() < Duration::from_secs(REFRESH_SECS))
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
    let result = fetch().await;
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
pub async fn require_suitable(app: &tauri::AppHandle) -> Result<(), String> {
    refresh(app, true).await;
    let weather = view(app);
    if weather.allowed {
        Ok(())
    } else {
        Err(format!("天气条件未通过：{}", weather.reasons.join(" ")))
    }
}
#[tauri::command]
pub async fn refresh_weather(app: tauri::AppHandle) {
    refresh(&app, true).await;
}
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            refresh(&app, false).await;
            tokio::time::sleep(Duration::from_secs(REFRESH_SECS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Sample {
        Sample {
            observed_at: 10000,
            fetched_at: 10000,
            temperature: Some(0.),
            weather_code: Some(0),
            wind_speed: Some(0.),
            wind_gusts: Some(0.),
            wind_direction: Some(0.),
            precipitation: Some(0.),
        }
    }
    #[test]
    fn rain_wind_missing_and_stale_never_pass() {
        let s = sample();
        assert_eq!(assess(Some(&s), None, 10000).0, "ok");
        for code in [51, 56, 57, 61, 66, 67, 71, 77, 80, 85, 95, 99] {
            assert_eq!(
                assess(
                    Some(&Sample {
                        weather_code: Some(code),
                        ..s.clone()
                    }),
                    None,
                    10000
                )
                .0,
                "unsafe"
            );
        }
        for changed in [
            Sample {
                precipitation: Some(0.01),
                ..s.clone()
            },
            Sample {
                wind_speed: Some(10.1),
                ..s.clone()
            },
            Sample {
                wind_gusts: Some(10.1),
                ..s.clone()
            },
            Sample {
                wind_gusts: Some(6.1),
                ..s.clone()
            },
            Sample {
                wind_speed: None,
                ..s.clone()
            },
            Sample {
                precipitation: None,
                ..s.clone()
            },
            Sample {
                wind_gusts: None,
                ..s.clone()
            },
            Sample {
                weather_code: Some(100),
                ..s.clone()
            },
            Sample {
                weather_code: Some(45),
                ..s.clone()
            },
            Sample {
                observed_at: 8000,
                ..s.clone()
            },
            Sample {
                observed_at: 10100,
                ..s.clone()
            },
        ] {
            assert_ne!(assess(Some(&changed), None, 10000).0, "ok");
        }
        assert_ne!(assess(Some(&s), None, 10601).0, "ok");
        assert_ne!(assess(Some(&s), Some("离线"), 10000).0, "ok");
        assert_ne!(assess(None, None, 10000).0, "ok");
        assert_eq!(
            assess(
                Some(&Sample {
                    wind_speed: Some(6.),
                    wind_gusts: Some(6.),
                    ..s
                }),
                None,
                10000
            )
            .0,
            "ok"
        );
    }
    #[test]
    fn parser_rejects_units_and_preserves_missing_values() {
        let mut raw = serde_json::json!({"current":{"time":10000,"wind_speed_10m":-1,"precipitation":null,"weather_code":0},"current_units":{"time":"unixtime","wind_speed_10m":"m/s","wind_gusts_10m":"m/s","precipitation":"mm"}});
        let s = parse_response(&raw, 10000).unwrap();
        assert!(s.precipitation.is_none());
        assert!(s.wind_speed.is_none());
        assert!(s.wind_gusts.is_none());
        assert_eq!(assess(Some(&s), None, 10000).0, "unknown");
        raw["current_units"]["wind_speed_10m"] = "km/h".into();
        assert!(parse_response(&raw, 10000).is_err());
    }
    #[tokio::test]
    #[ignore = "live Open-Meteo network check"]
    async fn live_weather() {
        let sample = fetch().await.expect("live weather request");
        println!("{}", serde_json::to_string(&sample).unwrap());
        assert!(
            sample.wind_speed.is_some()
                && sample.wind_gusts.is_some()
                && sample.precipitation.is_some()
        );
        assert!(
            (-60..=MAX_OBSERVATION_AGE).contains(&(Utc::now().timestamp() - sample.observed_at))
        );
    }
}
