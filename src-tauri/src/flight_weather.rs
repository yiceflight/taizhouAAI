use crate::{flight_report::Mission, monitoring::database};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

#[tauri::command]
pub fn list_flight_weather(app: tauri::AppHandle) -> Result<HashMap<String, Snapshot>, String> { saved(&database(&app)?) }

#[tauri::command]
pub async fn enrich_flight_weather(app: tauri::AppHandle, missions: Vec<Mission>) -> Result<Enrichment, String> {
    if missions.len() > 50 { return Err("单次最多读取 50 个任务的天气。".into()); }
    // DJI's current weather cannot establish conditions at a historical flight.
    // Preserve legacy snapshots; new tasks use their saved creation snapshot.
    Ok(Enrichment { weather: saved(&database(&app)?)?, error: None })
}
