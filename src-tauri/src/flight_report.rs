//! Post-flight reports: fixed browser adapters, validated task data, native DOCX output.
use crate::{bridge::Bridge, monitoring::database};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, FixedOffset, NaiveDateTime, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

mod evidence;
use evidence::{photo_facts, Evidence};

const TEMPLATE: &[u8] = include_bytes!("../assets/flight-report-template.docx");
const PROJECT: &str = "/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
    // Zero means the user supplied flight metadata without an Airins task.
    pub mission_id: u64,
    pub mission_name: String,
    pub start_time: i64,
    pub end_time: i64,
    #[serde(default)]
    pub geo_location: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub time: i64,
    pub pm25: Option<f64>,
    pub longitude: Option<f64>,
    pub latitude: Option<f64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirData {
    pub url: String,
    pub mission_id: u64,
    pub unit: String,
    pub points: Vec<Point>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub url: String,
    pub folder: String,
    pub files: Vec<String>,
    #[serde(default)]
    pub file_pages: HashMap<String, usize>,
    #[serde(default)]
    pub no_media: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    pub name: String,
    pub data_url: String,
    pub kind: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collected {
    #[serde(default)]
    pub evidence: Option<Evidence>,
    #[serde(default)]
    pub without_air_data: bool,
    #[serde(default)]
    pub local_event_id: Option<String>,
    pub mission: Mission,
    pub air: AirData,
    pub media: Media,
    pub photos: Vec<Photo>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectRequest {
    #[serde(default)]
    pub no_media: bool,
    #[serde(default)]
    pub without_air_data: bool,
    #[serde(default)]
    pub local_event_id: Option<String>,
    #[serde(default)]
    pub media_key: Option<String>,
    pub dji_session: String,
    pub dji_tab_id: i64,
    pub sniff_session: Option<String>,
    pub sniff_tab_id: Option<i64>,
    pub mission: Mission,
}

fn media_key(request: &CollectRequest) -> String {
    request
        .media_key
        .as_deref()
        .filter(|key| !key.is_empty() && key.len() <= 240 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b':' || b == b'.' || b == b'-'))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("mission-{}-{}", request.mission.start_time, request.mission.end_time))
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    #[serde(default)]
    pub supersedes_report_id: Option<String>,
    #[serde(default)]
    pub without_air_data: bool,
    #[serde(default)]
    pub local_event_id: Option<String>,
    pub id: String,
    pub created_at: i64,
    pub title: String,
    pub path: String,
    pub photo_count: usize,
    #[serde(default)]
    pub issue_count: Option<usize>,
    pub point_count: usize,
    pub warning: String,
    #[serde(default)]
    pub mission: Option<Mission>,
    #[serde(default)]
    pub air_url: String,
    #[serde(default)]
    pub media_url: String,
}
const REASONS: &[&str] = &[
    "dji_scheduled",
    "potassium_manual",
    "potassium_auto",
    "manual_immediate",
];

fn list_reasons(db: &rusqlite::Connection) -> Result<HashMap<String, String>, String> {
    let mut statement = db
        .prepare("SELECT mission_id, reason FROM flight_mission_reasons")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        row.map(|(id, reason)| (id.to_string(), reason))
            .map_err(|e| e.to_string())
    })
    .collect()
}

fn set_reason(db: &rusqlite::Connection, mission_id: u64, reason: &str) -> Result<(), String> {
    if mission_id == 0
        || mission_id > i64::MAX as u64
        || (!reason.is_empty() && !REASONS.contains(&reason))
    {
        return Err("任务原因或编号无效。".into());
    }
    if reason.is_empty() {
        db.execute(
            "DELETE FROM flight_mission_reasons WHERE mission_id=?1",
            [mission_id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        db.execute(
            "INSERT INTO flight_mission_reasons(mission_id,reason,updated_at) VALUES (?1,?2,?3)
             ON CONFLICT(mission_id) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at",
            params![mission_id, reason, chrono::Utc::now().to_rfc3339()],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_flight_reasons(app: tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    list_reasons(&database(&app)?)
}

#[tauri::command]
pub fn set_flight_reason(
    app: tauri::AppHandle,
    mission_id: u64,
    reason: String,
) -> Result<(), String> {
    set_reason(&database(&app)?, mission_id, &reason)
}
#[derive(Debug)]
struct Stats {
    min: f64,
    max: f64,
    mean: f64,
    count: usize,
    missing: usize,
    peak_time: i64,
}
fn source(url: &str, dji: bool) -> Result<(), String> {
    let u = tauri::Url::parse(url).map_err(|_| "资料来源地址无效")?;
    if !crate::bridge::allowed_url(url)
        || if dji {
            u.host_str() != Some("fh.dji.com")
                || u.path().trim_end_matches('/') != PROJECT
                || !u.fragment().unwrap_or_default().starts_with("/media?")
        } else {
            u.host_str() != Some("aai.airins.cn") || !u.path().starts_with("/sniff")
        }
    {
        return Err("资料来自错误的平台或司空项目。".into());
    }
    Ok(())
}
fn same_media_folder(a: &str, b: &str) -> bool {
    let normalized = |value: &str| -> Option<String> {
        source(value, true).ok()?;
        let url = tauri::Url::parse(value).ok()?;
        let (_, query) = url.fragment()?.split_once('?')?;
        let query_url = tauri::Url::parse(&format!("https://media.invalid/?{query}")).ok()?;
        let mut params: Vec<_> = query_url
            .query_pairs()
            .filter(|(key, _)| key != "page")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        params.sort();
        Some(format!(
            "{}{}{:?}{params:?}",
            url.origin().ascii_serialization(),
            url.path(),
            url.query()
        ))
    };
    normalized(a).is_some_and(|a| normalized(b).is_some_and(|b| a == b))
}
fn photo_time(name: &str) -> Result<i64, String> {
    if !name.starts_with("DJI_") || name.len() > 200 || name.contains(['/', '\\']) {
        return Err("照片名称无效".into());
    }
    let stamp = name.get(4..18).ok_or("照片缺少拍摄时间")?;
    let t = NaiveDateTime::parse_from_str(stamp, "%Y%m%d%H%M%S").map_err(|_| "照片拍摄时间无效")?;
    Ok(t.and_utc().timestamp_millis() - 8 * 3600000)
}
// A group's entire time span is <= 3 seconds, so a 0/3/6-second
// chain cannot merge distinct observations. Preserve every original filename.
fn issue_groups(files: &[String]) -> Result<Vec<Vec<String>>, String> {
    let mut timed = files
        .iter()
        .map(|name| Ok((photo_time(name)?, name.clone())))
        .collect::<Result<Vec<_>, String>>()?;
    timed.sort();
    timed.dedup();
    let mut groups: Vec<Vec<String>> = vec![];
    let mut anchor = None;
    for (time, name) in timed {
        if anchor.is_none_or(|start| time - start > 3000) {
            anchor = Some(time);
            groups.push(vec![]);
        }
        groups.last_mut().unwrap().push(name);
    }
    Ok(groups)
}
fn validate(data: &Collected, now: i64) -> Result<Option<Stats>, String> {
    if data.without_air_data {
        if !data.air.points.is_empty()
            || !data.air.url.is_empty()
            || data.air.mission_id != 0
            || !data.air.unit.is_empty()
        {
            return Err("无可飞数据模式不能包含可飞采样资料。".into());
        }
    } else {
        source(&data.air.url, false)?;
    }
    if data.media.no_media {
        if data.media.url != format!("https://fh.dji.com{PROJECT}#/plan")
            || !data.media.files.is_empty()
            || !data.photos.is_empty()
        {
            return Err("无媒体回执与照片资料不一致".into());
        }
    } else {
        source(&data.media.url, true)?;
    }
    let m = &data.mission;
    if (!data.without_air_data && (m.mission_id == 0 || m.mission_id != data.air.mission_id))
        || data
            .local_event_id
            .as_ref()
            .is_some_and(|id| Uuid::parse_str(id).is_err())
        || m.mission_name.trim().is_empty()
        || m.mission_name.len() > 500
        || m.geo_location.len() > 500
        || m.start_time <= 0
        || m.end_time <= m.start_time
        || m.end_time > now - 60000
        || m.end_time - m.start_time > 24 * 3600000
    {
        return Err("任务编号或时间无效；请等待飞行结束且数据上传完成至少 1 分钟。".into());
    }
    if !data.without_air_data
        && (data.air.unit != "μg/m³" || data.air.points.len() < 2 || data.air.points.len() > 20000)
    {
        return Err("PM2.5 单位不符或采样数据不完整。".into());
    }
    if (!data.media.no_media && !data.media.folder.trim_end().ends_with("Immediate-Media"))
        || data.media.files.len() > 200
        || data.photos.len() != data.media.files.len()
    {
        return Err("Immediate-Media 照片未完整导出。".into());
    }
    let mut names = std::collections::HashSet::new();
    for (name, p) in data.media.files.iter().zip(&data.photos) {
        if !names.insert(name) || &p.name != name {
            return Err("照片重复或与文件列表不一致".into());
        }
        let t = photo_time(name)?;
        if t < m.start_time - 300000 || t > m.end_time + 300000 {
            return Err("司空照片与本次飞行时间不匹配，已停止生成。".into());
        }
        let (bytes, _) = decode_image(&p.data_url)?;
        let (width, height) = image_dimensions(&bytes)?;
        if width < 600 || height < 400 {
            return Err("照片仅为缩略图，无法生成正式快报。".into());
        }
    }
    // The task folder carries the FlightHub start time even when no photos exist.
    let folder_time = data
        .media
        .folder
        .split(|c: char| !c.is_ascii_digit() && c != '-' && c != ' ' && c != ':')
        .find_map(|part| {
            part.as_bytes()
                .windows(19)
                .filter_map(|b| std::str::from_utf8(b).ok())
                .find_map(|s| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok())
        });
    if !data.media.no_media
        && folder_time.is_none_or(|t| {
            (t.and_utc().timestamp_millis() - 8 * 3600000 - m.start_time).abs() > 300000
        })
    {
        return Err("司空任务文件夹时间与本次飞行不匹配或无法核对。".into());
    }
    if data.without_air_data {
        return Ok(None);
    }
    // Airins records may run beyond the DJI flight clock. In the live data,
    // for example, sampling starts about one minute after takeoff and the
    // sensor keeps recording after FlightHub marks the aircraft landed. The
    // Airins mission is already associated by its unique start time and id;
    // use that source window for point validation instead of rejecting the
    // same flight merely because the two platforms stop their clocks at
    // different moments.
    let source_start = data.air.points.iter().map(|p| p.time).min().unwrap_or(0);
    let source_end = data.air.points.iter().map(|p| p.time).max().unwrap_or(0);
    if source_start < m.start_time.saturating_sub(300000)
        || source_start > m.start_time.saturating_add(300000)
        || source_end < source_start
        || source_end - source_start > 24 * 3600000
        || source_end > now.saturating_add(60000)
    {
        return Err("可飞采样时间与本次飞行无法可靠关联，已停止生成快报。".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut values = vec![];
    let mut coords = 0;
    for p in &data.air.points {
        if !seen.insert(p.time) {
            return Err("可飞采样时间重复，无法生成可靠快报。".into());
        }
        if let Some(v) = p.pm25 {
            if !v.is_finite() || !(0.0..=100000.0).contains(&v) {
                return Err("PM2.5 包含无效数值".into());
            }
            values.push((v, p.time));
        }
        if let (Some(lon), Some(lat)) = (p.longitude, p.latitude) {
            if lon.is_finite()
                && lat.is_finite()
                && (-180.0..=180.0).contains(&lon)
                && (-90.0..=90.0).contains(&lat)
                && (lon != 0.0 || lat != 0.0)
            {
                coords += 1;
            } else {
                return Err("航迹坐标无效".into());
            }
        }
    }
    if values.is_empty() || coords < 2 {
        return Err("缺少有效 PM2.5 或航迹坐标，暂不能生成快报。".into());
    }
    let min = values.iter().map(|x| x.0).fold(f64::INFINITY, f64::min);
    let peak = values.iter().max_by(|a, b| a.0.total_cmp(&b.0)).unwrap();
    Ok(Some(Stats {
        min,
        max: peak.0,
        mean: values.iter().map(|x| x.0).sum::<f64>() / values.len() as f64,
        count: values.len(),
        missing: data.air.points.len() - values.len(),
        peak_time: peak.1,
    }))
}
fn decode_image(url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let (value, ext) = if let Some(v) = url.strip_prefix("data:image/png;base64,") {
        (v, "png")
    } else if let Some(v) = url.strip_prefix("data:image/jpeg;base64,") {
        (v, "jpeg")
    } else {
        return Err("仅接受 PNG 或 JPEG 图片".into());
    };
    if value.len() > 16000000 {
        return Err("图片超过 12 MB 限制".into());
    }
    let bytes = STANDARD.decode(value).map_err(|_| "图片编码错误")?;
    if (ext == "png" && !bytes.starts_with(b"\x89PNG\r\n\x1a\n"))
        || (ext == "jpeg" && !bytes.starts_with(&[255, 216, 255]))
    {
        return Err("图片内容与类型不符".into());
    }
    image_dimensions(&bytes)?;
    Ok((bytes, ext))
}
fn image_dimensions(bytes: &[u8]) -> Result<(i64, i64), String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 {
        let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap()) as i64;
        let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap()) as i64;
        if w > 0 && h > 0 && w * h <= 100_000_000 {
            return Ok((w, h));
        }
    } else if bytes.starts_with(&[255, 216]) {
        let mut pos = 2;
        while pos + 4 <= bytes.len() {
            if bytes[pos] != 255 {
                break;
            }
            let marker = bytes[pos + 1];
            pos += 2;
            if marker == 255 {
                pos -= 1;
                continue;
            }
            if marker == 0xd9 || marker == 0xda {
                break;
            }
            let len = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]) as usize;
            if len < 2 || pos + len > bytes.len() {
                break;
            }
            if [
                0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
            ]
            .contains(&marker)
                && len >= 7
            {
                let h = u16::from_be_bytes([bytes[pos + 3], bytes[pos + 4]]) as i64;
                let w = u16::from_be_bytes([bytes[pos + 5], bytes[pos + 6]]) as i64;
                if w > 0 && h > 0 && w * h <= 100_000_000 {
                    return Ok((w, h));
                }
                break;
            }
            pos += len;
        }
    }
    Err("无法识别照片尺寸或图片损坏".into())
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let p = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("reports/flight");
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}
#[tauri::command]
pub async fn list_flight_missions(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Bridge>,
    session: String,
    tab_id: i64,
    cursor_id: Option<u64>,
    cursor_time: Option<i64>,
) -> Result<Value, String> {
    crate::readiness::require_report(&app)?;
    let v = bridge
        .request(
            session,
            tab_id,
            json!({"type":"flight-missions","cursorId":cursor_id,"cursorTime":cursor_time}),
        )
        .await?;
    source(v["url"].as_str().ok_or("可飞未返回来源")?, false)?;
    Ok(v)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DjiTask {
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub media_folder_id: Option<u64>,
    #[serde(default)]
    pub planned_start_time: i64,
    #[serde(default)]
    pub actual_time_missing: bool,
    #[serde(default)]
    pub task_type: Option<String>,
    #[serde(default)]
    pub route_name: Option<String>,
    #[serde(default)]
    pub partial_reason: Option<String>,
    pub mission: Mission,
    pub status: String,
    pub media_ready: bool,
    #[serde(default)]
    pub no_media: bool,
    #[serde(default)]
    pub media_uploaded_count: u64,
    #[serde(default)]
    pub media_expected_count: u64,
}
fn read_dji_tasks(db: &rusqlite::Connection) -> Result<Vec<DjiTask>, String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS dji_report_tasks (task_key TEXT PRIMARY KEY, payload TEXT NOT NULL)").map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT payload FROM dji_report_tasks")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    })
    .collect()
}
#[tauri::command]
pub fn list_dji_report_tasks(app: tauri::AppHandle) -> Result<Vec<DjiTask>, String> {
    read_dji_tasks(&database(&app)?)
}
#[tauri::command]
pub async fn sync_dji_report_tasks(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Bridge>,
    session: String,
) -> Result<Value, String> {
    crate::readiness::require_report_media(&app)?;
    let cursor: Value = crate::monitoring::setting(&database(&app)?, "dji_report_cursor")?
        .map(|raw| serde_json::from_str(&raw).map_err(|e| format!("司空同步进度损坏：{e}")))
        .transpose()?
        .unwrap_or(Value::Null);
    let completed =
        crate::monitoring::setting(&database(&app)?, "dji_report_history_completed_at")?
            .and_then(|raw| raw.parse::<i64>().ok());
    let api_migrated = crate::monitoring::setting(&database(&app)?, "dji_report_api_version")?
        .as_deref()
        == Some("1");
    let include_history =
        !api_migrated || history_scan_due(&cursor, completed, Utc::now().timestamp());
    let response = bridge
        .request(
            session,
            -1,
            json!({"type":"dji-tasks", "cursor":cursor, "includeHistory":include_history}),
        )
        .await;
    // Retain the latest read-only sync outcome for support without browser
    // credentials or raw platform data. A failed sync must remain diagnosable.
    if let Ok(directory) = root(&app) {
        let _ = fs::write(directory.join("dji-sync-status.json"), json!({
            "checkedAt": Utc::now().timestamp_millis(),
            "error": response.as_ref().err(),
            "receivedTasks": response.as_ref().ok().and_then(|v| v["tasks"].as_array()).map(Vec::len)
        }).to_string());
    }
    let result = response?;
    persist_dji_tasks(&mut database(&app)?, &result)
}
// Latest executions still refresh each minute. A completed historical sweep
// does not immediately start over; resume incomplete sweeps across restarts.
fn history_scan_due(cursor: &Value, completed: Option<i64>, now: i64) -> bool {
    !cursor.is_null() || completed.is_none_or(|at| !(0..21600).contains(&(now - at)))
}
fn persist_dji_tasks(db: &mut rusqlite::Connection, result: &Value) -> Result<Value, String> {
    if result["url"].as_str() != Some(&format!("https://fh.dji.com{PROJECT}#/plan")) {
        return Err("司空任务同步来源不匹配".into());
    }
    let incoming: Vec<DjiTask> = serde_json::from_value(result["tasks"].clone())
        .map_err(|e| format!("司空任务格式错误：{e}"))?;
    let cursor = result
        .get("cursor")
        .ok_or("司空同步缺少历史进度，请重新加载插件")?;
    let api_cursor = cursor["apiVersion"] == 1
        && cursor["page"]
            .as_u64()
            .is_some_and(|page| (2..=1000000).contains(&page));
    if !cursor.is_null()
        && !api_cursor
        && cursor["after"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 200000)
    {
        return Err("司空历史同步进度无效".into());
    }
    // For a complete single-page response, the platform's list is a full
    // snapshot. Remove cached executions that 司空 no longer returns so a
    // deleted/expired platform row cannot remain visible in the app forever.
    // Larger history sweeps are committed page by page and are reconciled
    // only when a later full snapshot can prove the complete key set.
    let full_snapshot = cursor.is_null()
        && result["historyComplete"] == true
        && result["historyError"].is_null()
        && result["total"].as_u64() == Some(incoming.len() as u64);
    let incoming_keys: HashSet<String> = incoming
        .iter()
        .map(|task| {
            task.task_id
                .as_ref()
                .map(|id| format!("dji-{id}"))
                .unwrap_or_else(|| report_key(&task.mission, None))
        })
        .collect();
    read_dji_tasks(db)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    if full_snapshot {
        let mut statement = tx
            .prepare("SELECT task_key FROM dji_report_tasks")
            .map_err(|e| e.to_string())?;
        let existing = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(statement);
        for key in existing {
            if !incoming_keys.contains(&key) {
                tx.execute("DELETE FROM dji_report_tasks WHERE task_key=?1", [key])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    for task in incoming {
        let m = &task.mission;
        if m.mission_id != 0
            || m.mission_name.trim().is_empty()
            || m.mission_name.len() > 500
            || task.task_type.as_ref().is_some_and(|value| value.len() > 100)
            || task.route_name.as_ref().is_some_and(|value| value.len() > 500)
            || task
                .partial_reason
                .as_ref()
                .is_some_and(|value| value.len() > 2000)
            || (task.actual_time_missing
                && (task.task_id.is_none() || task.planned_start_time <= 0 || task.media_ready))
            || (!task.actual_time_missing
                && (m.start_time <= 0
                    || m.end_time <= m.start_time
                    || m.end_time - m.start_time >= 86400000))
            || m.start_time < 0
            || m.end_time < 0
            || m.end_time > Utc::now().timestamp_millis()
            || task
                .task_id
                .as_ref()
                .is_some_and(|id| Uuid::parse_str(id).is_err())
            || !["执行成功", "部分执行", "执行终止", "执行失败"].contains(&task.status.as_str())
        {
            return Err("司空实际飞行记录无效，未保存".into());
        }
        let key = task
            .task_id
            .as_ref()
            .map(|id| format!("dji-{id}"))
            .unwrap_or_else(|| report_key(m, None));
        // Replace the old minute-based receipt when upgrading to API identity.
        // Existing generated reports remain untouched.
        if task.task_id.is_some() {
            tx.execute(
                "DELETE FROM dji_report_tasks WHERE task_key=?1",
                [report_key(m, None)],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute("INSERT INTO dji_report_tasks(task_key,payload) VALUES (?1,?2) ON CONFLICT(task_key) DO UPDATE SET payload=excluded.payload",
            params![key, serde_json::to_string(&task).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
    }
    // Commit the progress with the records; failed writes replay the same page.
    crate::monitoring::put(&tx, "dji_report_cursor", &cursor.to_string())?;
    if cursor.is_null() && result["historyComplete"] == true && result["historyError"].is_null() {
        crate::monitoring::put(
            &tx,
            "dji_report_history_completed_at",
            &Utc::now().timestamp().to_string(),
        )?;
        if result["apiVersion"] == 1 {
            crate::monitoring::put(&tx, "dji_report_api_version", "1")?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(
        json!({"tasks":read_dji_tasks(db)?, "skipped":result["skipped"], "mediaTabId":result["mediaTabId"], "historyPending": !cursor.is_null(), "historyError":result["historyError"], "platformTotal":result["total"]}),
    )
}
#[tauri::command]
pub async fn collect_flight_report(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Bridge>,
    request: CollectRequest,
) -> Result<Collected, String> {
    crate::runtime_log::record(
        &app,
        "info",
        "report",
        "collect_flight_report.started",
        "巡查报告采集开始",
        serde_json::json!({}),
    );
    let result = async {
        if request.without_air_data {
            crate::readiness::require_report_media(&app)?;
        } else {
            crate::readiness::require_report(&app)?;
        }
        let req = request;
        if req.mission.end_time > Utc::now().timestamp_millis() - 60000 {
            return Err("请等待飞行结束并完成上传至少 1 分钟。".into());
        }
        let air: AirData = if req.without_air_data {
            AirData { url: String::new(), mission_id: 0, unit: String::new(), points: vec![] }
        } else { serde_json::from_value(
            bridge
                .request(
                    req.sniff_session.clone().ok_or("请选择可飞页面")?,
                    req.sniff_tab_id.ok_or("请选择可飞页面")?,
                    json!({"type":"flight-airins","missionId":req.mission.mission_id}),
                )
                .await?,
        )
        .map_err(|e| format!("可飞格式错误：{e}"))? };
        let media = if req.no_media {
            // A missing media folder is not evidence of zero photos. Only an exact
            // persisted FlightHub execution receipt can authorize an empty report.
            let tasks = read_dji_tasks(&database(&app)?)?;
            if !tasks.iter().any(|task| task.no_media && task.media_ready
                && task.mission.mission_name == req.mission.mission_name
                && task.mission.start_time == req.mission.start_time && task.mission.end_time == req.mission.end_time) {
                return Err("司空尚未确认本航次无媒体文件".into());
            }
            Media { url: format!("https://fh.dji.com{PROJECT}#/plan"), folder: "司空计划：无媒体文件".into(), files: vec![], file_pages: HashMap::new(), no_media: true }
        } else {
            let media_key = media_key(&req);
            let known = read_dji_tasks(&database(&app)?)?;
            let matches: Vec<_> = known.iter().filter(|task| !task.actual_time_missing && task.media_ready
                && task.mission.mission_name == req.mission.mission_name
                && task.mission.start_time == req.mission.start_time && task.mission.end_time == req.mission.end_time).collect();
            let folder_id = if matches.len() == 1 { matches[0].media_folder_id } else { None };
            let media_value = bridge
                .request(
                    req.dji_session.clone(),
                    req.dji_tab_id,
                    json!({"type":"flight-dji-list","startTime":req.mission.start_time,"endTime":req.mission.end_time,"folderId":folder_id,"mediaKey":media_key}),
                )
                .await?;
            if media_value["matchedStartTime"].as_i64() != Some(req.mission.start_time) {
                return Err("浏览器插件尚不支持按时间自动匹配，请更新并重新加载插件后重试。".into());
            }
            if folder_id.is_some() && media_value["matchedTaskFolderId"].as_u64() != folder_id {
                return Err("司空媒体目录回执不匹配，未采集照片".into());
            }
            let media: Media = serde_json::from_value(media_value)
                .map_err(|e| format!("司空格式错误：{e}"))?;
            source(&media.url, true)?;
            media
        };
        if !req.without_air_data { source(&air.url, false)?; }
        let mut photos = vec![];
        let media_key = media_key(&req);
        for (index, name) in media.files.iter().enumerate() {
            let t = photo_time(name)?;
            if t < req.mission.start_time - 300000 || t > req.mission.end_time + 300000 {
                return Err("照片不属于本次飞行，已停止采集。".into());
            }
            let v = bridge
                .request(
                    req.dji_session.clone(),
                    req.dji_tab_id,
                    json!({"type":"flight-dji-image","name":name,"page":media.file_pages.get(name),"mediaKey":media_key,"closeAfter":index + 1 == media.files.len()}),
                )
                .await?;
            if !same_media_folder(v["url"].as_str().unwrap_or_default(), &media.url) || v["folder"] != media.folder || v["name"] != *name {
                return Err("采集期间司空页面发生变化，请重试。".into());
            }
            photos.push(serde_json::from_value(v).map_err(|e| format!("图片格式错误：{e}"))?);
        }
        let data = Collected {
            evidence: None,
            without_air_data: req.without_air_data,
            local_event_id: req.local_event_id,
            mission: req.mission,
            air,
            media,
            photos,
        };
        validate(&data, Utc::now().timestamp_millis())?;
        Ok(data)
    }.await;
    crate::runtime_log::record(
        &app,
        if result.is_ok() { "info" } else { "error" },
        "report",
        "collect_flight_report.finished",
        if result.is_ok() {
            "巡查报告采集完成"
        } else {
            "巡查报告采集失败"
        },
        serde_json::json!({"error":result.as_ref().err()}),
    );
    result
}
fn xml(s: &str) -> String {
    s.chars()
        .filter(|c| *c == '\n' || *c == '\r' || *c == '\t' || *c >= ' ')
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn date(t: i64, pattern: &str) -> String {
    DateTime::from_timestamp_millis(t)
        .unwrap()
        .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
        .format(pattern)
        .to_string()
}
// Fill only known slots; inserted user text is never interpreted as a slot.
fn fill_slots(template: &str, fields: &[(&str, String)]) -> Result<String, String> {
    let mut rest = template;
    let mut out = String::new();
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let end = rest[start + 2..].find("}}").ok_or("模板字段未闭合")? + start + 2;
        let key = &rest[start + 2..end];
        let value = fields
            .iter()
            .find(|(name, _)| *name == key)
            .ok_or_else(|| format!("模板字段未填写：{key}"))?;
        out.push_str(&xml(&value.1));
        rest = &rest[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}
fn fill_table(doc: &mut String, index: usize, rows: &[Vec<String>]) -> Result<(), String> {
    let token = format!("{{{{T{index}_0}}}}");
    let pos = doc.find(&token).ok_or("模板表格行缺失")?;
    let start = doc[..pos]
        .rfind("<w:tr>")
        .max(doc[..pos].rfind("<w:tr "))
        .ok_or("模板行起点缺失")?;
    let end = pos + doc[pos..].find("</w:tr>").ok_or("模板行终点缺失")? + 7;
    let row_template = &doc[start..end];
    let mut filled = String::new();
    for row in rows {
        let fields: Vec<_> = row
            .iter()
            .enumerate()
            .map(|(col, value)| (format!("T{index}_{col}"), value.clone()))
            .collect();
        let fields: Vec<_> = fields
            .iter()
            .map(|(key, value)| (key.as_str(), value.clone()))
            .collect();
        filled.push_str(&fill_slots(row_template, &fields)?);
    }
    doc.replace_range(start..end, &filled);
    Ok(())
}
fn image_xml(id: usize, width: i64, height: i64) -> String {
    format!(
        r#"<w:p><w:pPr><w:jc w:val="center"/><w:keepNext/><w:spacing w:before="200" w:after="80"/></w:pPr><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="{width}" cy="{height}"/><wp:docPr id="{id}" name="Report image {id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdFlight{id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{width}" cy="{height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"#
    )
}
fn block(doc: &mut String, key: &str, value: &str) -> Result<(), String> {
    let pos = doc
        .find(&format!("{{{{{key}}}}}"))
        .ok_or("模板占位符缺失")?;
    let start = doc[..pos]
        .rfind("<w:p>")
        .max(doc[..pos].rfind("<w:p "))
        .ok_or("模板段落缺失")?;
    let end = pos + doc[pos..].find("</w:p>").ok_or("模板段落未结束")? + 6;
    doc.replace_range(start..end, value);
    Ok(())
}
fn build_docx(
    data: &Collected,
    charts: &[String; 2],
    issued: i64,
    pm25_threshold: f64,
) -> Result<Vec<u8>, String> {
    if !pm25_threshold.is_finite() || pm25_threshold <= 0.0 {
        return Err("PM2.5 报告阈值必须大于 0。".into());
    }
    let stats = validate(data, issued)?;
    // These remain collection inputs, but the reference has a nine-column
    // observation table, not extra chart sections or a photo appendix.
    if !data.without_air_data {
        for chart in charts {
            decode_image(chart)?;
        }
    }
    let mut src = zip::ZipArchive::new(Cursor::new(TEMPLATE)).map_err(|e| e.to_string())?;
    let mut parts = std::collections::BTreeMap::new();
    for i in 0..src.len() {
        let mut f = src.by_index(i).map_err(|e| e.to_string())?;
        let mut b = vec![];
        f.read_to_end(&mut b).map_err(|e| e.to_string())?;
        parts.insert(f.name().to_owned(), b);
    }
    let mut doc = String::from_utf8(parts.remove("word/document.xml").ok_or("模板正文缺失")?)
        .map_err(|e| e.to_string())?;
    let caption = String::from_utf8(
        parts
            .remove("word/report-caption.xml")
            .ok_or("模板图注缺失")?,
    )
    .map_err(|e| e.to_string())?;
    let caption = &caption[caption.find("<w:p ").ok_or("图注段落缺失")?..];
    let caption_for = |text: String| fill_slots(caption, &[("CAPTION", text)]);
    let m = &data.mission;
    let flight_window = format!(
        "{}～{}",
        date(m.start_time, "%Y年%m月%d日%H时%M分"),
        date(m.end_time, "%Y年%m月%d日%H时%M分")
    );
    let table_window = if date(m.start_time, "%Y%m%d") == date(m.end_time, "%Y%m%d") {
        format!(
            "{}～{}",
            date(m.start_time, "%H:%M"),
            date(m.end_time, "%H:%M")
        )
    } else {
        format!(
            "{}～{}",
            date(m.start_time, "%m-%d %H:%M"),
            date(m.end_time, "%m-%d %H:%M")
        )
    };
    let mut photos: Vec<_> = data.photos.iter().collect();
    photos.sort_by_key(|p| photo_time(&p.name).unwrap_or_default());
    let facts = photos
        .iter()
        .map(|p| decode_image(&p.data_url).map(|(b, _)| photo_facts(&b)))
        .collect::<Result<Vec<_>, _>>()?;
    let fallback = Evidence {
        captured_at: issued,
        ..Default::default()
    };
    let evidence = data.evidence.as_ref().unwrap_or(&fallback);
    let reviewed = facts
        .iter()
        .filter(|f| evidence.reviews.contains_key(&f.hash))
        .count();
    let visible = facts
        .iter()
        .filter(|f| f.image_type.starts_with("可见光"))
        .count();
    let infrared = facts
        .iter()
        .filter(|f| f.image_type == "红外热成像")
        .count();
    let count = photos.len().to_string();
    let blank = "【 】".to_owned();
    let mut fields = vec![
        ("ISSUE", blank.clone()),
        ("SERIES_ISSUE", blank.clone()),
        ("ISSUED", date(issued, "%Y年%-m月%-d日")),
        (
            "ANALYSIS_WINDOW",
            format!(
                "{}00:00至{}（北京时间）",
                date(issued, "%Y年%m月%d日"),
                date(issued, "%H:%M")
            ),
        ),
        ("FLIGHT_WINDOW", flight_window.clone()),
        ("PHOTO_COUNT", count.clone()),
        ("TOTAL0_1", "本航次".into()),
        ("TOTAL0_2", table_window),
        ("TOTAL0_3", "范围待核实".into()),
        ("TOTAL0_4", format!("{count}张")),
        (
            "TOTAL0_5",
            if reviewed > 0 {
                "见表2初判".into()
            } else {
                "待判读".into()
            },
        ),
        (
            "TOTAL1_1",
            match (photos.first(), photos.last()) {
                (Some(a), Some(b)) => format!(
                    "{}～{}",
                    date(photo_time(&a.name)?, "%m-%d %H:%M"),
                    date(photo_time(&b.name)?, "%m-%d %H:%M")
                ),
                _ => blank.clone(),
            },
        ),
        ("TOTAL1_2", "本航次抓拍点".into()),
        ("TOTAL1_3", "—".into()),
        ("TOTAL1_4", format!("可见光{visible}张，红外{infrared}张")),
        ("TOTAL1_5", format!("共{count}张")),
        ("TOTAL1_6", format!("已初判{reviewed}张，待复核")),
    ];
    fields.extend(evidence.city_fields());
    fields.push((
        "TRIGGER",
        if evidence.trigger.is_empty() {
            "触发原因待核实".into()
        } else {
            evidence.trigger.clone()
        },
    ));
    fields.push(("PHOTO_REVIEW_SUMMARY",format!("含可见光{visible}张、红外{infrared}张；{}异常事件数量尚未经现场核实。表中坐标为照片EXIF记录的WGS-84拍摄位置，不是污染源坐标",if reviewed>0 {format!("已完成{reviewed}张影像的AI辅助初判，结果需人工复核；")}else{"尚未完成影像判读；".into()})));
    // Known capture positions are point records, not invented route segments.
    let execution = photos
        .iter()
        .zip(&facts)
        .enumerate()
        .map(|(i, (p, f))| {
            Ok(vec![
                (i + 1).to_string(),
                format!("抓拍点{}", i + 1),
                date(photo_time(&p.name)?, "%H:%M:%S"),
                "已抓拍；范围待核实".into(),
                "1张".into(),
                if evidence.reviews.contains_key(&f.hash) {
                    "见表2初判".into()
                } else {
                    "待判读".into()
                },
            ])
        })
        .collect::<Result<Vec<_>, String>>()?;
    fill_table(
        &mut doc,
        0,
        &if execution.is_empty() {
            vec![vec!["未取得".into(); 6]]
        } else {
            execution
        },
    )?;
    let rows: Vec<_> = photos
        .iter()
        .zip(&facts)
        .enumerate()
        .map(|(i, (p, f))| {
            Ok(vec![
                (i + 1).to_string(),
                date(photo_time(&p.name)?, "%m-%d %H:%M:%S"),
                format!("抓拍点{}", i + 1),
                match (f.longitude, f.latitude) {
                    (Some(lon), Some(lat)) => format!(
                        "{:.6}°{} / {:.6}°{}",
                        lon.abs(),
                        if lon < 0.0 { "W" } else { "E" },
                        lat.abs(),
                        if lat < 0.0 { "S" } else { "N" }
                    ),
                    _ => "照片无有效GPS".into(),
                },
                f.image_type.clone(),
                evidence
                    .reviews
                    .get(&f.hash)
                    .map(|r| r.description.clone())
                    .unwrap_or_else(|| {
                        f.relative_height
                            .map(|h| format!("相对高度{h:.2}米；场景待判读"))
                            .unwrap_or_else(|| "场景待判读".into())
                    }),
                evidence
                    .reviews
                    .get(&f.hash)
                    .map(|r| r.result.clone())
                    .unwrap_or_else(|| "未判读".into()),
            ])
        })
        .collect::<Result<_, String>>()?;
    fill_table(
        &mut doc,
        1,
        &if rows.is_empty() {
            vec![vec!["未取得".into(); 7]]
        } else {
            rows
        },
    )?;
    let mut points: Vec<_> = data.air.points.iter().collect();
    points.sort_by_key(|p| p.time);
    let air_rows: Vec<_> = points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            vec![
                (i + 1).to_string(),
                date(p.time, "%m-%d %H:%M:%S"),
                match (p.longitude, p.latitude) {
                    (Some(lon), Some(lat)) => format!("{lon:.6} / {lat:.6}"),
                    _ => "缺测".into(),
                },
                p.pm25
                    .map(|v| format!("{v:.1}"))
                    .unwrap_or_else(|| "缺测".into()),
                "未取得".into(),
                "未取得".into(),
                "未取得".into(),
                "未取得".into(),
                "未取得".into(),
            ]
        })
        .collect();
    fill_table(
        &mut doc,
        2,
        &if data.without_air_data {
            vec![vec![blank.clone(); 9]; 4]
        } else {
            air_rows
        },
    )?;
    let above = points
        .iter()
        .filter(|p| p.pm25.is_some_and(|v| v > pm25_threshold))
        .count();
    let warning = if stats.as_ref().is_some_and(|s| s.max == 0.0) {
        "本航次 PM2.5 有效数值全部为 0，请核查传感器状态；不能据此判断空气质量良好。"
    } else {
        ""
    };
    fields.push(("AIR_INTRO", if data.without_air_data { String::new() } else {
        "本次巡航无人机搭载可飞科技“灵嗅”高精度气体传感器，空气六参数监测数据经可飞平台实时回传并生成监测成果。巡航期间六参数监测数据如下（数据来源：可飞平台）：".into()
    }));
    fields.push(("CONCLUSION", if !evidence.conclusion.is_empty() {evidence.conclusion.clone()} else if let Some(s) = &stats {
        format!("本次巡航抓拍图片{count}张，影像异常及污染成因待判读、核实。PM2.5有效采样{}点、缺测{}点，浓度范围{:.1}～{:.1} μg/m³，采样算术平均值{:.1} μg/m³，峰值时间{}。本报告PM2.5判定阈值为 {} μg/m³，严格大于阈值的采样点 {} 个。{}", s.count, s.missing, s.min, s.max, s.mean, date(s.peak_time, "%m-%d %H:%M:%S"), pm25_threshold, above, warning)
    } else { blank.clone() }));
    // Use only explicit, flight-bound editorial input for recommendations.
    fields.push((
        "RECOMMENDATION",
        if evidence.recommendation.is_empty() {
            blank.clone()
        } else {
            evidence.recommendation.clone()
        },
    ));
    let mut rels = String::from_utf8(
        parts
            .remove("word/_rels/document.xml.rels")
            .ok_or("模板关系缺失")?,
    )
    .map_err(|e| e.to_string())?;
    let mut types = String::from_utf8(parts.remove("[Content_Types].xml").ok_or("模板类型缺失")?)
        .map_err(|e| e.to_string())?;
    let mut photo_xml = String::new();
    let mut section_xml = String::new();
    for (i, p) in photos.iter().enumerate() {
        let id = i + 1000; // avoid the reference masthead drawing's ID
        let (bytes, ext) = decode_image(&p.data_url)?;
        let (width, height) = image_dimensions(&bytes)?;
        let name = format!("media/flight-{id}.{ext}");
        parts.insert(format!("word/{name}"), bytes);
        rels = rels.replace("</Relationships>", &format!("<Relationship Id=\"rIdFlight{id}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"{name}\"/></Relationships>"));
        if !types.contains(&format!("Extension=\"{ext}\"")) {
            types = types.replace(
                "</Types>",
                &format!("<Default Extension=\"{ext}\" ContentType=\"image/{ext}\"/></Types>"),
            );
        }
        let scale = (5500000.0 / width as f64).min(3200000.0 / height as f64);
        let img = image_xml(
            id,
            (width as f64 * scale) as i64,
            (height as f64 * scale) as i64,
        )
        .replace("name=\"image\"", &format!("name=\"{}\"", xml(&p.name)));
        if i == 0 {
            section_xml.push_str(
                &image_xml(
                    id + 10000,
                    (width as f64 * scale) as i64,
                    (height as f64 * scale) as i64,
                )
                .replace(
                    &format!("rIdFlight{}", id + 10000),
                    &format!("rIdFlight{id}"),
                ),
            );
            section_xml.push_str(&caption_for(
                "图1　巡航现场照片（抓拍点1，对应表2序号1）".into(),
            )?);
        }
        photo_xml.push_str(&img);
        photo_xml.push_str(&caption_for(format!(
            "图{}　大疆司空平台抓拍图片（表2序号{}，{}）",
            i + 3,
            i + 1,
            date(photo_time(&p.name)?, "%m-%d %H:%M:%S")
        ))?);
    }
    if let Some(map) = evidence::location_plot(&facts)? {
        parts.insert("word/media/capture-locations.png".into(), map);
        rels=rels.replace("</Relationships>","<Relationship Id=\"rIdFlight20000\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/capture-locations.png\"/></Relationships>");
        if !types.contains("Extension=\"png\"") {
            types = types.replace(
                "</Types>",
                "<Default Extension=\"png\" ContentType=\"image/png\"/></Types>",
            );
        }
        section_xml.push_str(&image_xml(20000, 5500000, 3575000));
        section_xml.push_str(&caption_for(
            "图2　抓拍位置分布（WGS-84；数字对应表2序号；离散拍摄点，非完整航迹或目标位置）".into(),
        )?);
    } else if !photos.is_empty() {
        section_xml.push_str(&caption_for("图2　位置图未取得（照片无有效GPS）".into())?);
    }
    if photos.is_empty() {
        section_xml = caption_for("巡航现场照片及对应位置图【待补】".into())?;
        photo_xml = caption_for("本航次无照片。".into())?;
    }
    // Fill global fields before adding user-derived table/figure content; no
    // arbitrary strings are used as XML, and absent fields keep editable blanks.
    // Tables are already filled, so user data containing braces is protected by
    // limiting this pass to the named global slots.
    for (key, value) in fields {
        doc = doc.replace(&format!("{{{{{key}}}}}"), &xml(&value));
    }
    block(&mut doc, "SECTION_PHOTOS", &section_xml)?;
    block(&mut doc, "PHOTOS", &photo_xml)?;
    parts.insert("word/document.xml".into(), doc.into_bytes());
    parts.insert("word/_rels/document.xml.rels".into(), rels.into_bytes());
    parts.insert("[Content_Types].xml".into(), types.into_bytes());
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in parts {
        zip.start_file(
            name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(|e| e.to_string())?;
        zip.write_all(&content).map_err(|e| e.to_string())?;
    }
    Ok(zip.finish().map_err(|e| e.to_string())?.into_inner())
}
fn report_key(mission: &Mission, local_event_id: Option<&str>) -> String {
    if mission.mission_id > 0 {
        format!("mission-{}", mission.mission_id)
    } else if let Some(id) = local_event_id {
        format!("event-{id}")
    } else {
        format!(
            "flight-{}-{}-{}",
            mission.start_time, mission.end_time, mission.mission_name
        )
    }
}
fn persist(
    root: &Path,
    data: &Collected,
    charts: &[String; 2],
    pm25_threshold: f64,
    regenerate: bool,
) -> Result<Summary, String> {
    // Serialize the lookup and commit; normal saves reuse the latest report.
    static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = SAVE_LOCK.lock().map_err(|_| "报告保存锁异常，请重试")?;
    let summaries = read_summaries(root)?;
    let existing = summaries.iter().find(|s| {
        s.mission.as_ref().is_some_and(|m| {
            report_key(m, s.local_event_id.as_deref())
                == report_key(&data.mission, data.local_event_id.as_deref())
        })
    });
    if !regenerate {
        if let Some(existing) = existing {
            return Ok(existing.clone());
        }
    }
    // Upgrading a photo-only report changes its Airins identity. Persist the
    // exact predecessor so offline/restarted clients never show both versions.
    let upgrade_candidates: Vec<_> = summaries
        .iter()
        .filter(|s| {
            !data.without_air_data
                && s.without_air_data
                && s.local_event_id == data.local_event_id
                && s.mission.as_ref().is_some_and(|m| {
                    m.mission_id == 0
                        && m.mission_name == data.mission.mission_name
                        && m.start_time == data.mission.start_time
                        && m.end_time == data.mission.end_time
                })
        })
        .collect();
    let predecessor =
        existing.or_else(|| (upgrade_candidates.len() == 1).then(|| upgrade_candidates[0]));
    // Keep new revisions ordered even when generated within the same millisecond.
    let now = data
        .evidence
        .as_ref()
        .map_or_else(|| Utc::now().timestamp_millis(), |e| e.captured_at)
        .max(predecessor.map_or(0, |s| s.created_at + 1));
    let stats = validate(data, now)?;
    let bytes = build_docx(data, charts, now, pm25_threshold)?;
    let id = Uuid::new_v4().to_string();
    let temp = root.join(format!(".{id}.tmp"));
    let dest = root.join(&id);
    fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    let result = (|| {
        let name = format!(
            "周山河街区巡飞监测快报-{}.docx",
            date(data.mission.start_time, "%Y%m%d-%H%M%S")
        );
        let summary = Summary {
            supersedes_report_id: predecessor.map(|s| s.id.clone()),
            without_air_data: data.without_air_data,
            local_event_id: data.local_event_id.clone(),
            id: id.clone(),
            mission: Some(data.mission.clone()),
            created_at: now,
            title: data.mission.mission_name.clone(),
            path: dest.join(&name).to_string_lossy().into_owned(),
            photo_count: data.photos.len(),
            issue_count: Some(issue_groups(&data.media.files)?.len()),
            point_count: data.air.points.len(),
            warning: if data.without_air_data {
                "未收录可飞数据，报告对应位置留空".into()
            } else if stats.as_ref().is_some_and(|s| s.max == 0.0) {
                "PM2.5 全部为 0，请核查传感器".into()
            } else {
                String::new()
            },
            air_url: data.air.url.clone(),
            media_url: data.media.url.clone(),
        };
        fs::write(temp.join("issues.json"), serde_json::to_vec_pretty(&json!({
            "rule": "capture-time-span-at-most-3-seconds", "groups": issue_groups(&data.media.files)?
        })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::write(temp.join("report-settings.json"), serde_json::to_vec_pretty(&serde_json::json!({"pm25Threshold": pm25_threshold, "templateSha256": "e30bc73f8f720df2c150e36a41a10080a3ff871be0be7cd3e9466f09c16c0a32", "generatorVersion": "template-fill-v3"})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::write(temp.join(&name), bytes).map_err(|e| e.to_string())?;
        fs::write(
            temp.join("source.json"),
            serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::write(
            temp.join("summary.json"),
            serde_json::to_vec_pretty(&summary).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        for (i, p) in data.photos.iter().enumerate() {
            let (b, ext) = decode_image(&p.data_url)?;
            fs::write(temp.join(format!("photo-{}.{ext}", i + 1)), b).map_err(|e| e.to_string())?;
        }
        let mut csv = String::from("time_beijing,pm25_ug_m3,longitude,latitude\n");
        for p in &data.air.points {
            csv.push_str(&format!(
                "{},{},{},{}\n",
                date(p.time, "%Y-%m-%d %H:%M:%S"),
                p.pm25.map(|v| v.to_string()).unwrap_or_default(),
                p.longitude.map(|v| v.to_string()).unwrap_or_default(),
                p.latitude.map(|v| v.to_string()).unwrap_or_default()
            ));
        }
        fs::write(temp.join("pm25-route.csv"), csv).map_err(|e| e.to_string())?;
        fs::rename(&temp, &dest).map_err(|e| e.to_string())?;
        Ok(summary)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    }
    result
}
#[tauri::command]
pub async fn save_flight_report(
    app: tauri::AppHandle,
    mut data: Collected,
    charts: [String; 2],
    regenerate: Option<bool>,
) -> Result<Summary, String> {
    crate::runtime_log::record(
        &app,
        "info",
        "report",
        "save_flight_report.started",
        "巡查报告保存开始",
        serde_json::json!({}),
    );
    let result = async {
        let root = root(&app)?;
        let db = crate::monitoring::database(&app)?;
        let threshold = crate::settings::read(&db)?.pm25_threshold;
        let review_path = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("report-photo-reviews.json");
        data.evidence = Some(evidence::snapshot(
            &db,
            &data,
            &review_path,
            Utc::now().timestamp_millis(),
        )?);
        tauri::async_runtime::spawn_blocking(move || {
            persist(
                &root,
                &data,
                &charts,
                threshold,
                regenerate.unwrap_or(false),
            )
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    crate::runtime_log::record(
        &app,
        if result.is_ok() { "info" } else { "error" },
        "report",
        "save_flight_report.finished",
        if result.is_ok() {
            "巡查报告保存完成"
        } else {
            "巡查报告保存失败"
        },
        serde_json::json!({"error":result.as_ref().err()}),
    );
    result
}
#[tauri::command]
pub fn list_flight_reports(app: tauri::AppHandle) -> Result<Vec<Summary>, String> {
    read_summaries(&root(&app)?)
}
fn read_summaries(root: &Path) -> Result<Vec<Summary>, String> {
    let mut items = vec![];
    for item in fs::read_dir(root).map_err(|e| e.to_string())? {
        let p = item.map_err(|e| e.to_string())?.path();
        if Uuid::parse_str(p.file_name().unwrap_or_default().to_string_lossy().as_ref()).is_err() {
            continue;
        }
        if let Ok(b) = fs::read(p.join("summary.json")) {
            if let Ok(mut summary) = serde_json::from_slice::<Summary>(&b) {
                // Older reports stored the mission only in source.json. Recover the
                // association and platform URLs without rewriting or deleting files.
                if let Ok(bytes) = fs::read(p.join("source.json")) {
                    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                        if summary.issue_count.is_none() {
                            if let Ok(files) = serde_json::from_value::<Vec<String>>(
                                value["media"]["files"].clone(),
                            ) {
                                summary.issue_count =
                                    issue_groups(&files).ok().map(|groups| groups.len());
                            }
                        }
                        if summary.mission.is_none() {
                            summary.mission = serde_json::from_value(value["mission"].clone()).ok();
                        }
                        if summary.air_url.is_empty() {
                            summary.air_url =
                                value["air"]["url"].as_str().unwrap_or_default().to_string();
                        }
                        if summary.media_url.is_empty() {
                            summary.media_url = value["media"]["url"]
                                .as_str()
                                .unwrap_or_default()
                                .to_string();
                        }
                    }
                }
                items.push(summary);
            }
        }
    }
    let superseded: std::collections::HashSet<_> = items
        .iter()
        .filter_map(|s| s.supersedes_report_id.clone())
        .collect();
    items.retain(|s| !superseded.contains(&s.id));
    items.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut seen = std::collections::HashSet::new();
    items.retain(|s| {
        s.mission
            .as_ref()
            .is_none_or(|m| seen.insert(report_key(m, s.local_event_id.as_deref())))
    });
    Ok(items)
}
#[tauri::command]
pub fn open_flight_report(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = saved_report_path(&root(&app)?, &id)?;
    app.opener()
        .open_path(path.to_str().ok_or("路径无效")?, None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn open_flight_report_directory(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = saved_report_path(&root(&app)?, &id)?;
    if !path.is_file() {
        return Err("Word 报告文件不存在，可能已被移动或删除".into());
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| format!("无法打开报告所在文件夹：{e}"))
}
fn saved_report_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    let id = Uuid::parse_str(id).map_err(|_| "报告编号无效")?;
    let dir = root.join(id.to_string());
    let s: Summary =
        serde_json::from_slice(&fs::read(dir.join("summary.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let filename = Path::new(&s.path).file_name().ok_or("文件名无效")?;
    let path = dir.join(filename);
    if path.extension().and_then(|s| s.to_str()) != Some("docx") {
        return Err("报告类型无效".into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn historical_sweep_is_throttled_only_after_a_committed_completion() {
        assert!(history_scan_due(&Value::Null, None, 30000));
        assert!(!history_scan_due(&Value::Null, Some(30000), 30001));
        assert!(history_scan_due(
            &json!({"after":"page-2"}),
            Some(30000),
            30001
        ));
        assert!(history_scan_due(&Value::Null, Some(30000), 51600));
        assert!(history_scan_due(&Value::Null, Some(30000), 29999));
        let mut db = crate::monitoring::connect(Path::new(":memory:")).unwrap();
        let mut batch = json!({"url":format!("https://fh.dji.com{PROJECT}#/plan"),"tasks":[],"cursor":null,"historyComplete":true,"historyError":"timeout"});
        persist_dji_tasks(&mut db, &batch).unwrap();
        assert!(
            crate::monitoring::setting(&db, "dji_report_history_completed_at")
                .unwrap()
                .is_none()
        );
        batch["historyError"] = Value::Null;
        persist_dji_tasks(&mut db, &batch).unwrap();
        assert!(
            crate::monitoring::setting(&db, "dji_report_history_completed_at")
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn api_sync_preserves_incomplete_flights_and_replaces_legacy_receipts() {
        let mut db = crate::monitoring::connect(Path::new(":memory:")).unwrap();
        let mut task = json!({"mission":{"missionId":0,"missionName":"flight","startTime":1790031600000_i64,"endTime":1790032800000_i64,"geoLocation":""},"status":"执行成功","mediaReady":true});
        let mut batch = json!({"url":format!("https://fh.dji.com{PROJECT}#/plan"),"tasks":[task.clone()],"cursor":null});
        persist_dji_tasks(&mut db, &batch).unwrap();
        task["taskId"] = json!(Uuid::new_v4().to_string());
        task["mediaFolderId"] = json!(350521756);
        task["plannedStartTime"] = json!(1790031600000_i64);
        batch["tasks"] = json!([task.clone()]);
        batch["cursor"] = json!({"apiVersion":1,"page":7});
        persist_dji_tasks(&mut db, &batch).unwrap();
        assert_eq!(read_dji_tasks(&db).unwrap().len(), 1);
        assert_eq!(
            read_dji_tasks(&db).unwrap()[0].media_folder_id,
            Some(350521756)
        );
        task["taskId"] = json!(Uuid::new_v4().to_string());
        task["mission"]["endTime"] = json!(0);
        task["actualTimeMissing"] = json!(true);
        task["mediaReady"] = json!(false);
        task["status"] = json!("执行失败");
        batch["tasks"] = json!([task.clone()]);
        persist_dji_tasks(&mut db, &batch).unwrap();
        persist_dji_tasks(&mut db, &batch).unwrap();
        assert_eq!(read_dji_tasks(&db).unwrap().len(), 2);
        task["mediaReady"] = json!(true);
        batch["tasks"] = json!([task]);
        assert!(persist_dji_tasks(&mut db, &batch).is_err());
        assert_eq!(read_dji_tasks(&db).unwrap().len(), 2);
    }
    #[test]
    fn dji_sync_commits_cursor_with_records_and_rolls_back_bad_batches() {
        let mut db = crate::monitoring::connect(Path::new(":memory:")).unwrap();
        let task = |name: &str| json!({"mission":{"missionId":0,"missionName":name,"startTime":1790031600000_i64,"endTime":1790032800000_i64,"geoLocation":""},"status":"执行成功","mediaReady":true});
        let mut batch = json!({"url":format!("https://fh.dji.com{PROJECT}#/plan"),"tasks":[task("first")],"cursor":{"after":"page-5"},"skipped":0,"mediaTabId":7});
        persist_dji_tasks(&mut db, &batch).unwrap();
        batch["cursor"] = json!({"after":"page-10"});
        batch["tasks"] = json!([task("second"), task("")]);
        assert!(persist_dji_tasks(&mut db, &batch).is_err());
        assert_eq!(read_dji_tasks(&db).unwrap().len(), 1);
        assert_eq!(
            crate::monitoring::setting(&db, "dji_report_cursor")
                .unwrap()
                .unwrap(),
            r#"{"after":"page-5"}"#
        );
        batch["tasks"] = json!([task("first"), task("second")]);
        batch["cursor"] = Value::Null;
        let result = persist_dji_tasks(&mut db, &batch).unwrap();
        assert_eq!(result["tasks"].as_array().unwrap().len(), 2);
        assert_eq!(result["historyPending"], false);
    }
    #[test]
    fn complete_single_page_snapshot_prunes_cached_platform_rows() {
        let mut db = crate::monitoring::connect(Path::new(":memory:")).unwrap();
        let task = |id: &str, name: &str| {
            json!({
                "taskId": id,
                "mission": {"missionId":0,"missionName":name,"startTime":1790031600000_i64,"endTime":1790032800000_i64,"geoLocation":""},
                "status":"执行成功","mediaReady":true
            })
        };
        let stale_id = Uuid::new_v4().to_string();
        let fresh_id = Uuid::new_v4().to_string();
        let mut stale = json!({
            "url":format!("https://fh.dji.com{PROJECT}#/plan"),
            "tasks":[task(&stale_id, "旧司空任务")], "cursor":null,
            "historyComplete":true, "historyError":null, "total":1
        });
        persist_dji_tasks(&mut db, &stale).unwrap();
        stale["tasks"] = json!([task(&fresh_id, "当前司空任务")]);
        persist_dji_tasks(&mut db, &stale).unwrap();
        let rows = read_dji_tasks(&db).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].task_id.as_deref(), Some(fresh_id.as_str()));
        assert_eq!(rows[0].mission.mission_name, "当前司空任务");
    }
    #[test]
    fn groups_photo_formats_within_three_seconds_without_chaining() {
        let names = [
            "DJI_20261013071746_0006_T.jpeg",
            "DJI_20261013070653_0002_T.jpeg",
            "DJI_20261013070652_0002_V.jpeg",
            "DJI_20261013071746_0006_V.jpeg",
            "DJI_20261013071749_0007_T.jpeg",
            "DJI_20261013071752_0008_V.jpeg",
        ];
        let groups = issue_groups(&names.map(String::from)).unwrap();
        assert_eq!(groups.len(), 3);
        assert_eq!(
            groups.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![2, 3, 1]
        );
        assert!(issue_groups(&[]).unwrap().is_empty());
        assert!(issue_groups(&["unknown.jpeg".into()]).is_err());
    }
    #[test]
    fn media_page_changes_are_allowed_but_folder_changes_are_not() {
        let base = format!("https://fh.dji.com{PROJECT}#/media?page=1&size=50&pid=123");
        assert!(same_media_folder(&base, &base.replace("page=1", "page=2")));
        assert!(!same_media_folder(
            &base,
            &base.replace("pid=123", "pid=456")
        ));
        assert!(!same_media_folder(
            &base,
            &base.replace("fh.dji.com", "evil.test")
        ));
    }
    #[test]
    fn explicit_no_media_receipt_is_distinct_from_a_missing_folder() {
        let mut data = sample();
        data.media.url = format!("https://fh.dji.com{PROJECT}#/plan");
        data.media.folder = "司空计划：无媒体文件".into();
        data.media.files.clear();
        data.photos.clear();
        let now = data.mission.end_time + 60001;
        assert!(validate(&data, now).is_err());
        data.media.no_media = true;
        assert!(validate(&data, now).is_ok());
        assert_eq!(issue_groups(&data.media.files).unwrap().len(), 0);
        data.media
            .files
            .push("DJI_20260922070120_0001_V.jpeg".into());
        assert!(validate(&data, now).is_err());
    }
    #[test]
    fn mission_reasons_are_validated_and_persisted_by_airins_id() {
        let db = crate::monitoring::connect(Path::new(":memory:")).unwrap();
        assert!(list_reasons(&db).unwrap().is_empty());
        set_reason(&db, 12, "dji_scheduled").unwrap();
        set_reason(&db, 13, "potassium_manual").unwrap();
        assert_eq!(list_reasons(&db).unwrap()["12"], "dji_scheduled");
        assert_eq!(list_reasons(&db).unwrap()["13"], "potassium_manual");
        assert!(set_reason(&db, 12, "unknown").is_err());
        assert!(set_reason(&db, 0, "dji_scheduled").is_err());
        assert_eq!(list_reasons(&db).unwrap()["12"], "dji_scheduled");
        set_reason(&db, 12, "").unwrap();
        assert!(!list_reasons(&db).unwrap().contains_key("12"));
    }
    pub(super) fn sample() -> Collected {
        let start = 1790031680000;
        Collected {
            evidence: None,
            without_air_data: false,
            local_event_id: None,
            mission: Mission {
                mission_id: 1,
                mission_name: "测试任务 <&>".into(),
                start_time: start,
                end_time: start + 200000,
                geo_location: "周山河".into(),
            },
            air: AirData {
                url: "https://aai.airins.cn/sniff/HistoryCloud".into(),
                mission_id: 1,
                unit: "μg/m³".into(),
                points: vec![
                    Point {
                        time: start,
                        pm25: Some(31.0),
                        longitude: Some(119.93),
                        latitude: Some(32.43),
                    },
                    Point {
                        time: start + 1000,
                        pm25: Some(65.0),
                        longitude: Some(119.94),
                        latitude: Some(32.42),
                    },
                ],
            },
            media: Media {
                file_pages: HashMap::new(),
                no_media: false,
                url: format!("https://fh.dji.com{PROJECT}#/media?page=1&pid=1"),
                folder: "媒体文件 每日7时南侧火点巡飞 2026-09-22 07:00:05 (UTC+08) Immediate-Media"
                    .into(),
                files: vec![],
            },
            photos: vec![],
        }
    }
    pub(super) const PNG:&str="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=";
    #[test]
    fn template_tables_preserve_samples_and_analysis_uses_issue_day() {
        let data = sample();
        let issued = data.mission.start_time + 86400000;
        let bytes = build_docx(&data, &[PNG.into(), PNG.into()], issued, 60.0).unwrap();
        let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut doc = String::new();
        z.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc)
            .unwrap();
        assert_eq!(doc.matches("<w:tbl>").count(), 3);
        assert!(doc.contains("2026年09月23日00:00至07:01"));
        let air_table = doc
            .split("<w:tbl>")
            .nth(3)
            .unwrap()
            .split("</w:tbl>")
            .next()
            .unwrap();
        assert_eq!(air_table.matches("</w:tr>").count(), 3); // header plus BOTH raw observations
        for value in [
            "09-22 07:01:20",
            "09-22 07:01:21",
            "31.0",
            "65.0",
            "119.930000 / 32.430000",
            "未取得",
        ] {
            assert!(air_table.contains(value), "missing observation: {value}");
        }
        assert!(!doc.contains("附录"));
        assert!(!doc.contains("{{"));
        assert!(!doc.contains("生物质燃烧特征明显"));
        assert_eq!(
            fill_slots("{{VALUE}}", &[("VALUE", "<&> {{VALUE}}".into())]).unwrap(),
            "&lt;&amp;&gt; {{VALUE}}"
        );
    }
    #[test]
    fn rejects_wrong_flight_and_units() {
        let mut d = sample();
        assert_eq!(validate(&d, i64::MAX).unwrap().unwrap().mean, 48.0);
        d.air.unit = "ppm".into();
        assert!(validate(&d, i64::MAX).is_err());
        d = sample();
        d.air.points[1].time = d.air.points[0].time;
        assert!(validate(&d, i64::MAX).is_err());
        d = sample();
        d.air.points[1].time = d.mission.end_time + 5 * 60 * 1000;
        assert!(validate(&d, i64::MAX).is_ok());
        d = sample();
        d.air.points[0].time = d.mission.start_time - 6 * 60 * 1000;
        assert!(validate(&d, i64::MAX).is_err());
        d = sample();
        d.media.folder = d.media.folder.replace("09-22", "09-21");
        assert!(validate(&d, i64::MAX).is_err());
        d = sample();
        assert!(validate(&d, d.mission.start_time).is_err());
        d.air.url = d.media.url.clone();
        assert!(validate(&d, i64::MAX).is_err());
    }
    fn photo_only_sample() -> Collected {
        let mut data = sample();
        data.without_air_data = true;
        data.mission.mission_id = 0;
        data.air = AirData {
            url: String::new(),
            mission_id: 0,
            unit: String::new(),
            points: vec![],
        };
        data
    }
    #[test]
    fn missing_air_data_requires_explicit_mode_and_preserves_media_validation() {
        let mut data = sample();
        data.air.points.clear();
        assert!(validate(&data, i64::MAX).is_err());
        data.without_air_data = true;
        assert!(validate(&data, i64::MAX).is_err()); // Never relabel real data as absent.
        data = photo_only_sample();
        assert!(validate(&data, i64::MAX).unwrap().is_none());
        data.media.url = data.media.url.replace("c7ea6bbc", "other");
        assert!(validate(&data, i64::MAX).is_err());
        data = photo_only_sample();
        data.media.folder = data.media.folder.replace("09-22", "09-21");
        assert!(validate(&data, i64::MAX).is_err());
        data = photo_only_sample();
        data.media.files.push("DJI_20260922070005_0001.JPG".into());
        assert!(validate(&data, i64::MAX).is_err()); // Missing photo export still blocks.
        data = photo_only_sample();
        assert!(validate(&data, data.mission.end_time).is_err());
    }
    #[test]
    fn photo_only_docx_keeps_blank_air_slots_and_independent_history() {
        let data = photo_only_sample();
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let first = persist(&root, &data, &[String::new(), String::new()], 60.0, false).unwrap();
        assert!(first.without_air_data);
        assert_eq!(first.point_count, 0);
        assert!(!first.warning.contains("全部为 0"));
        let mut zip = zip::ZipArchive::new(Cursor::new(fs::read(&first.path).unwrap())).unwrap();
        let mut doc = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc)
            .unwrap();
        assert!(!doc.contains("{{"));
        assert!(!doc.contains("有效采样 0"));
        assert!(!doc.contains("算术平均"));
        assert!(!doc.contains("建议逐张"));
        assert!(!doc.contains("建议优先"));
        assert!(!doc.contains("rIdFlight"));
        assert!(doc.contains("空气六参数监测数据"));
        assert!(doc.contains("<w:tblGrid>"));
        assert!(!doc.contains("巡飞监测记录"));
        assert_eq!(
            persist(&root, &data, &[String::new(), String::new()], 60.0, false)
                .unwrap()
                .id,
            first.id
        );
        let mut another = data.clone();
        another.mission.start_time += 86400000;
        another.mission.end_time += 86400000;
        another.media.folder = another.media.folder.replace("09-22", "09-23");
        assert_ne!(
            persist(
                &root,
                &another,
                &[String::new(), String::new()],
                60.0,
                false
            )
            .unwrap()
            .id,
            first.id
        );
        assert_eq!(read_summaries(&root).unwrap().len(), 2);
        let mut local = data.clone();
        local.local_event_id = Some(Uuid::new_v4().to_string());
        let saved = persist(&root, &local, &[String::new(), String::new()], 60.0, false).unwrap();
        local.mission.mission_name = "更新显示名称".into();
        assert_eq!(
            persist(&root, &local, &[String::new(), String::new()], 60.0, false)
                .unwrap()
                .id,
            saved.id
        );
        assert_eq!(read_summaries(&root).unwrap().len(), 3);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn regeneration_saves_new_data_and_keeps_previous_files() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let data = sample();
        let old = persist(&root, &data, &[PNG.into(), PNG.into()], 60.0, false).unwrap();
        let old_bytes = fs::read(&old.path).unwrap();
        let mut updated = data.clone();
        updated.air.points[0].pm25 = Some(99.0);
        let new = persist(&root, &updated, &[PNG.into(), PNG.into()], 80.0, true).unwrap();
        assert_ne!(new.id, old.id);
        assert!(new.created_at > old.created_at);
        assert_eq!(fs::read(&old.path).unwrap(), old_bytes);
        let source: Collected =
            serde_json::from_slice(&fs::read(root.join(&new.id).join("source.json")).unwrap())
                .unwrap();
        assert_eq!(source.air.points[0].pm25, Some(99.0));
        let reports = read_summaries(&root).unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].id, new.id);
        assert_eq!(
            persist(&root, &updated, &[PNG.into(), PNG.into()], 80.0, false)
                .unwrap()
                .id,
            new.id
        );
        assert!(persist(&root, &updated, &[String::new(), String::new()], 80.0, true).is_err());
        assert_eq!(read_summaries(&root).unwrap()[0].id, new.id);
        let mut blank = photo_only_sample();
        blank.local_event_id = Some(Uuid::new_v4().to_string());
        let before = persist(&root, &blank, &[String::new(), String::new()], 60.0, false).unwrap();
        let after = persist(&root, &blank, &[String::new(), String::new()], 60.0, true).unwrap();
        assert_ne!(before.id, after.id);
        assert!(Path::new(&before.path).is_file());
        assert!(after.without_air_data);
        assert_eq!(read_summaries(&root).unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn sampling_upgrade_persists_one_visible_report_across_reload_and_revisions() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let full = sample();
        let mut partial = full.clone();
        partial.without_air_data = true;
        partial.mission.mission_id = 0;
        partial.air = AirData {
            url: String::new(),
            mission_id: 0,
            unit: String::new(),
            points: vec![],
        };
        let old = persist(
            &root,
            &partial,
            &[String::new(), String::new()],
            60.0,
            false,
        )
        .unwrap();
        let upgrade = persist(&root, &full, &[PNG.into(), PNG.into()], 60.0, true).unwrap();
        assert_eq!(
            upgrade.supersedes_report_id.as_deref(),
            Some(old.id.as_str())
        );
        assert!(upgrade.created_at > old.created_at);
        let reports = read_summaries(&root).unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].id, upgrade.id);
        assert!(!reports[0].without_air_data);
        assert!(reports[0].point_count > 0);
        let revision = persist(&root, &full, &[PNG.into(), PNG.into()], 60.0, true).unwrap();
        assert_eq!(read_summaries(&root).unwrap().len(), 1);
        assert_eq!(read_summaries(&root).unwrap()[0].id, revision.id);
        assert!(Path::new(&old.path).is_file());
        assert!(Path::new(&upgrade.path).is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_docx_and_atomic_history() {
        let d = sample();
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let a = persist(&root, &d, &[PNG.into(), PNG.into()], 60.0, false).unwrap();
        let b = persist(&root, &d, &[PNG.into(), PNG.into()], 60.0, false).unwrap();
        assert_eq!(a.path, b.path);
        assert_eq!(a.air_url, d.air.url);
        assert_eq!(a.media_url, d.media.url);
        assert_eq!(read_summaries(&root).unwrap().len(), 1);
        let mut another = d.clone();
        another.mission.mission_id = 2;
        another.air.mission_id = 2;
        let c = persist(&root, &another, &[PNG.into(), PNG.into()], 60.0, false).unwrap();
        assert_ne!(a.id, c.id);
        assert_eq!(read_summaries(&root).unwrap().len(), 2);
        let mut z = zip::ZipArchive::new(Cursor::new(fs::read(&a.path).unwrap())).unwrap();
        let mut xml = String::new();
        z.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(!xml.contains("{{"));
        assert!(!xml.contains("2026年5月21日"));
        assert!(xml.contains("大疆司空平台抓拍图片信息"));
        assert!(xml.contains("48.0"));
        assert!(root.join(&a.id).join("source.json").is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_reports_recover_missions_and_keep_only_latest_without_deleting_files() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let data = sample();
        let old = persist(&root, &data, &[PNG.into(), PNG.into()], 60.0, false).unwrap();
        let mut legacy = serde_json::to_value(&old).unwrap();
        legacy.as_object_mut().unwrap().remove("mission");
        legacy.as_object_mut().unwrap().remove("issueCount");
        legacy.as_object_mut().unwrap().remove("airUrl");
        legacy.as_object_mut().unwrap().remove("mediaUrl");
        fs::write(
            root.join(&old.id).join("summary.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        let id = Uuid::new_v4().to_string();
        let dir = root.join(&id);
        fs::create_dir(&dir).unwrap();
        legacy["id"] = json!(id);
        legacy["createdAt"] = json!(old.created_at + 1000);
        fs::write(
            dir.join("summary.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        fs::write(dir.join("source.json"), serde_json::to_vec(&data).unwrap()).unwrap();
        let reports = read_summaries(&root).unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].id, id);
        assert_eq!(reports[0].mission.as_ref().unwrap().mission_id, 1);
        assert_eq!(reports[0].media_url, data.media.url);
        assert_eq!(
            reports[0].issue_count,
            Some(issue_groups(&data.media.files).unwrap().len())
        );
        assert!(root.join(&old.id).join("summary.json").is_file());
        assert_eq!(
            persist(&root, &data, &[PNG.into(), PNG.into()], 60.0, false)
                .unwrap()
                .id,
            id
        );
        // An old report whose source is unavailable must remain accessible.
        fs::remove_file(dir.join("source.json")).unwrap();
        assert_eq!(read_summaries(&root).unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn concurrent_saves_return_the_same_report() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let jobs: Vec<_> = (0..4)
            .map(|_| {
                let root = root.clone();
                std::thread::spawn(move || {
                    persist(&root, &sample(), &[PNG.into(), PNG.into()], 60.0, false)
                        .unwrap()
                        .id
                })
            })
            .collect();
        let ids: Vec<_> = jobs.into_iter().map(|job| job.join().unwrap()).collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        assert_eq!(read_summaries(&root).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn report_threshold_is_dynamic_and_strictly_greater() {
        let data = sample();
        for (threshold, count) in [(60.0, 1), (65.0, 0), (20.0, 2)] {
            let bytes = build_docx(
                &data,
                &[PNG.into(), PNG.into()],
                Utc::now().timestamp_millis(),
                threshold,
            )
            .unwrap();
            let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
            let mut text = String::new();
            zip.by_name("word/document.xml")
                .unwrap()
                .read_to_string(&mut text)
                .unwrap();
            assert!(text.contains(&format!("判定阈值为 {} μg/m³", threshold)));
            assert!(text.contains(&format!("严格大于阈值的采样点 {} 个", count)));
        }
        assert!(build_docx(
            &data,
            &[PNG.into(), PNG.into()],
            Utc::now().timestamp_millis(),
            0.0
        )
        .is_err());
    }
    #[test]
    #[ignore = "requires explicit local live-report fixture"]
    fn renders_live_fixture_when_explicitly_supplied() {
        if let Ok(path) = std::env::var("TAIZHOU_REPORT_QA_INPUT") {
            let v: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            let d: Collected = serde_json::from_value(v["data"].clone()).unwrap();
            let charts: [String; 2] = serde_json::from_value(v["charts"].clone()).unwrap();
            let root = PathBuf::from(std::env::var("TAIZHOU_REPORT_QA_DIR").unwrap());
            fs::create_dir_all(&root).unwrap();
            let s = persist(&root, &d, &charts, 60.0, false).unwrap();
            println!("QA report: {}", s.path);
        }
    }
}
