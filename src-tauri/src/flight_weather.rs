use crate::{flight_report::Mission, monitoring::database, weather::conditions};
use chrono::{DateTime, Duration as ChronoDuration, FixedOffset, NaiveDate, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, time::Duration};

const LAT: &str = "32.434525";
const LNG: &str = "119.92992";
const HOURLY: &str = "temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation";
const SOURCE: &str = "Open-Meteo 历史预报";
static BACKFILL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    mission_id: u64,
    start_time: i64,
    observed_at: i64,
    fetched_at: i64,
    source: String,
    status: String,
    temperature: f64,
    weather_code: u64,
    wind_speed: f64,
    wind_gusts: f64,
    wind_direction: Option<f64>,
    precipitation: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrichment {
    weather: HashMap<String, Snapshot>,
    error: Option<String>,
}

fn saved(db: &Connection) -> Result<HashMap<String, Snapshot>, String> {
    let mut query = db.prepare("SELECT mission_id, snapshot_json FROM flight_mission_weather").map_err(|e| e.to_string())?;
    let rows = query.query_map([], |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (id, value) = row.map_err(|e| e.to_string())?;
        let snapshot = serde_json::from_str(&value).map_err(|e| e.to_string())?;
        Ok((id.to_string(), snapshot))
    }).collect()
}

fn date(millis: i64) -> Result<NaiveDate, String> {
    let at = DateTime::<Utc>::from_timestamp_millis(millis).ok_or("任务时间无效")?;
    Ok(at.with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap()).date_naive())
}

fn number(raw: &Value, key: &str, index: usize) -> Option<f64> {
    raw["hourly"][key].get(index)?.as_f64().filter(|v| v.is_finite())
}

fn parse_hour(raw: &Value, mission: &Mission, fetched_at: i64) -> Result<Snapshot, String> {
    let units = &raw["hourly_units"];
    if raw["timezone"] != "Asia/Shanghai" || units["time"] != "unixtime"
        || units["temperature_2m"] != "°C" || units["wind_speed_10m"] != "m/s"
        || units["wind_gusts_10m"] != "m/s" || units["wind_direction_10m"] != "°"
        || units["precipitation"] != "mm" {
        return Err("历史天气单位或时区不匹配。".into());
    }
    let hour = mission.start_time.div_euclid(3_600_000) * 3600;
    let times = raw["hourly"]["time"].as_array().ok_or("历史天气缺少小时数据")?;
    let index = times.iter().position(|time| time.as_i64() == Some(hour)).ok_or("历史天气尚未覆盖任务时刻")?;
    let temperature = number(raw, "temperature_2m", index).ok_or("历史气温缺测")?;
    let weather_code = raw["hourly"]["weather_code"].get(index).and_then(Value::as_u64).ok_or("历史天气现象缺测")?;
    let wind_speed = number(raw, "wind_speed_10m", index).filter(|v| *v >= 0.).ok_or("历史风速缺测")?;
    let wind_gusts = number(raw, "wind_gusts_10m", index).filter(|v| *v >= 0.).ok_or("历史阵风缺测")?;
    let precipitation = number(raw, "precipitation", index).filter(|v| *v >= 0.).ok_or("历史降水缺测")?;
    let wind_direction = number(raw, "wind_direction_10m", index).filter(|v| (0. ..=360.).contains(v));
    let (status, _) = conditions(Some(weather_code), Some(wind_speed), Some(wind_gusts), Some(precipitation));
    Ok(Snapshot { mission_id: mission.mission_id, start_time: mission.start_time, observed_at: hour,
        fetched_at, source: SOURCE.into(), status: status.into(), temperature, weather_code,
        wind_speed, wind_gusts, wind_direction, precipitation })
}

async fn fetch_days(start: NaiveDate, end: NaiveDate) -> Result<Value, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut url = tauri::Url::parse("https://historical-forecast-api.open-meteo.com/v1/forecast").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("latitude", LAT), ("longitude", LNG), ("hourly", HOURLY),
        ("start_date", &start.to_string()), ("end_date", &end.to_string()),
        ("wind_speed_unit", "ms"), ("timeformat", "unixtime"), ("timezone", "Asia/Shanghai"),
    ]);
    let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let response = client.get(url).send().await.map_err(|_| "无法连接历史天气服务")?;
    if !response.status().is_success() { return Err(format!("历史天气服务返回 HTTP {}", response.status().as_u16())); }
    let body = response.text().await.map_err(|_| "历史天气响应读取失败")?;
    serde_json::from_str(&body).map_err(|_| "历史天气响应格式无效".into())
}

#[tauri::command]
pub fn list_flight_weather(app: tauri::AppHandle) -> Result<HashMap<String, Snapshot>, String> {
    saved(&database(&app)?)
}

#[tauri::command]
pub async fn enrich_flight_weather(app: tauri::AppHandle, missions: Vec<Mission>) -> Result<Enrichment, String> {
    if missions.len() > 50 { return Err("单次最多补全 50 个任务的天气。".into()); }
    let _guard = BACKFILL_LOCK.lock().await;
    let db = database(&app)?;
    let mut weather = saved(&db)?;
    let now = Utc::now().timestamp_millis();
    let mut missing = Vec::new();
    for mission in missions {
        if mission.mission_id == 0 || mission.mission_id > i64::MAX as u64 || mission.start_time <= 0
            || mission.start_time > now || (mission.end_time != 0 && mission.end_time < mission.start_time) { return Err("待补全任务的编号或时间无效。".into()); }
        if mission.end_time == 0 || mission.end_time > now - 60_000 { continue; }
        if weather.get(&mission.mission_id.to_string()).is_some_and(|item| item.start_time == mission.start_time) { continue; }
        missing.push(mission);
    }
    missing.sort_by_key(|mission| mission.start_time);
    let mut errors = Vec::new();
    while !missing.is_empty() {
        let start = date(missing[0].start_time)?;
        let end_limit = start + ChronoDuration::days(13);
        let count = missing.iter().take_while(|mission| date(mission.start_time).is_ok_and(|day| day <= end_limit)).count();
        let group: Vec<_> = missing.drain(..count).collect();
        let end = date(group.last().unwrap().start_time)?;
        match fetch_days(start, end).await {
            Ok(raw) => for mission in group {
                match parse_hour(&raw, &mission, Utc::now().timestamp()) {
                    Ok(snapshot) => {
                        let payload = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
                        db.execute("INSERT INTO flight_mission_weather(mission_id,start_time,snapshot_json) VALUES (?1,?2,?3)
                            ON CONFLICT(mission_id) DO UPDATE SET start_time=excluded.start_time,snapshot_json=excluded.snapshot_json",
                            params![snapshot.mission_id, snapshot.start_time, payload]).map_err(|e| e.to_string())?;
                        weather.insert(mission.mission_id.to_string(), snapshot);
                    }
                    Err(error) => errors.push(error),
                }
            },
            Err(error) => errors.push(error),
        }
    }
    Ok(Enrichment { weather, error: errors.into_iter().next() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hourly_snapshot_uses_flight_start_hour_and_persists() {
        let mission = Mission { mission_id: 12, mission_name: "a".into(), start_time: 1_790_026_882_000, end_time: 1_790_028_000_000, geo_location: String::new() };
        let hour = mission.start_time.div_euclid(3_600_000) * 3600;
        let raw = serde_json::json!({"timezone":"Asia/Shanghai","hourly_units":{"time":"unixtime","temperature_2m":"°C","wind_speed_10m":"m/s","wind_gusts_10m":"m/s","wind_direction_10m":"°","precipitation":"mm"},"hourly":{"time":[hour-3600,hour],"temperature_2m":[10,21.5],"weather_code":[61,3],"wind_speed_10m":[12,1.39],"wind_gusts_10m":[15,2.6],"wind_direction_10m":[180,90],"precipitation":[5,0]}});
        let snapshot = parse_hour(&raw, &mission, 123).unwrap();
        assert_eq!(snapshot.observed_at, hour);
        assert_eq!(snapshot.status, "ok");
        assert_eq!(snapshot.wind_speed, 1.39);
        let db = crate::monitoring::connect(std::path::Path::new(":memory:")).unwrap();
        db.execute("INSERT INTO flight_mission_weather(mission_id,start_time,snapshot_json) VALUES (?1,?2,?3)", params![12, mission.start_time, serde_json::to_string(&snapshot).unwrap()]).unwrap();
        assert_eq!(saved(&db).unwrap()["12"].start_time, mission.start_time);
        let mut invalid = raw;
        invalid["hourly_units"]["wind_speed_10m"] = serde_json::json!("km/h");
        assert!(parse_hour(&invalid, &mission, 123).is_err());
    }
}
