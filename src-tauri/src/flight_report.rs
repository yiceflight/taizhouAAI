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
mod cache;
mod presentation;
mod air_chart;
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
    #[serde(default)]
    pub channels: HashMap<String, AirChannel>,
    #[serde(default)]
    pub chart: Option<air_chart::AirChart>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirChannel {
    pub source_channel: String,
    pub unit: String,
    pub values: Vec<Option<f64>>,
}

// Same mass conversion used by the Airins platform export, not an assumed
// ambient/standard-state conversion. Raw ppm arrays remain in source.json.
fn channel_spec(name: &str) -> Option<(&'static str, &'static str, f64)> {
    match name {
        "pm10" => Some(("ad_10", "μg/m³", 1.0)),
        "so2" => Some(("ad_4", "ppm", 64.06 / 25.4 * 1000.0)),
        "no2" => Some(("ad_6", "ppm", 46.01 / 25.4 * 1000.0)),
        "co" => Some(("ad_5", "ppm", 28.01 / 25.4)),
        "o3" => Some(("ad_80", "ppm", 48.0 / 25.4 * 1000.0)),
        _ => None,
    }
}
fn air_value(air: &AirData, name: &str, index: usize) -> Option<f64> {
    if name == "pm25" { return air.points.get(index)?.pm25; }
    let factor = channel_spec(name)?.2;
    air.channels.get(name)?.values.get(index)?.map(|v| v * factor)
}
fn air_cell(air: &AirData, name: &str, index: usize) -> String {
    if name != "pm25" && !air.channels.contains_key(name) { return "未取得".into(); }
    air_value(air, name, index).map(|v| if name == "co" { format!("{v:.3}") } else { format!("{v:.1}") })
        .unwrap_or_else(|| "缺测".into())
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
    #[serde(default)]
    pub root_folder_id: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    pub name: String,
    pub data_url: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<presentation::Presentation>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collected {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_generation: Option<u64>,
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
    #[serde(default)]
    pub issue_number: Option<u64>,
    pub point_count: usize,
    pub warning: String,
    #[serde(default)]
    pub mission: Option<Mission>,
    #[serde(default)]
    pub air_url: String,
    #[serde(default)]
    pub media_url: String,
}
#[cfg(test)]
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

#[cfg(test)]
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

#[derive(Debug)]
struct Stats {
    max: f64,
    mean: f64,
    count: usize,
    missing: usize,
    peak_time: i64,
}
fn during_flight(mission: &Mission, point: &Point) -> bool {
    (mission.start_time..=mission.end_time).contains(&point.time)
}

#[cfg(test)]
fn channel_stat(data: &Collected, name: &str, maximum: bool) -> String {
    if !data.air.channels.contains_key(name) { return "未取得".into(); }
    let values: Vec<_> = data.air.points.iter().enumerate()
        .filter(|(_, p)| during_flight(&data.mission, p))
        .filter_map(|(i, _)| air_value(&data.air, name, i)).collect();
    if values.is_empty() { return "缺测".into(); }
    let value = if maximum { values.iter().copied().fold(f64::NEG_INFINITY, f64::max) }
        else { values.iter().sum::<f64>() / values.len() as f64 };
    if name == "co" { format!("{value:.3}") } else { format!("{value:.1}") }
}
const AIR_METRICS: [&str; 5] = ["pm25", "pm10", "so2", "no2", "co"];
fn air_peak_indices(data: &Collected) -> [Option<usize>; 5] {
    AIR_METRICS.map(|name| {
        if data.without_air_data { return None; }
        data.air.points.iter().enumerate()
            .filter(|(_, p)| during_flight(&data.mission, p))
            .filter_map(|(i, p)| air_value(&data.air, name, i)
                .filter(|v| v.is_finite()).map(|v| (i, p.time, v)))
            .max_by(|a, b| a.2.total_cmp(&b.2).then_with(|| b.1.cmp(&a.1)).then_with(|| b.0.cmp(&a.0)))
            .map(|(i, _, _)| i)
    })
}
fn air_peak_rows(data: &Collected, peaks: &[Option<usize>; 5]) -> Vec<Vec<String>> {
    peaks.iter().enumerate().map(|(row, peak)| {
        let blank = "【 】".to_owned();
        if data.without_air_data { return vec![blank; 8]; }
        let mut cells = vec![blank.clone(); 8];
        cells[0] = (row + 1).to_string();
        if let Some(index) = peak {
            let point = &data.air.points[*index];
            cells[1] = date(point.time, "%m-%d %H:%M:%S");
            cells[2] = point.longitude.zip(point.latitude)
                .filter(|(lon, lat)| lon.is_finite() && lat.is_finite() && lon.abs() <= 180.0 && lat.abs() <= 90.0 && (*lon != 0.0 || *lat != 0.0))
                .map(|(lon, lat)| format!("{:.6}°{} / {:.6}°{}", lon.abs(), if lon < 0.0 { "W" } else { "E" }, lat.abs(), if lat < 0.0 { "S" } else { "N" }))
                .unwrap_or(blank);
            for (col, name) in AIR_METRICS.iter().enumerate() {
                cells[col + 3] = air_cell(&data.air, name, *index);
            }
        } else {
            cells[row + 3] = if row > 0 && !data.air.channels.contains_key(AIR_METRICS[row]) { "未取得" } else { "缺测" }.into();
        }
        cells
    }).collect()
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
// Highest-temperature annotations select candidate groups; raw captures alone
// (including minimum-temperature marks) do not establish an issue.
fn maximum_labels(photo: &Photo) -> Vec<String> {
    photo.presentation.as_ref().map(|p| p.labels.iter()
        .flat_map(|label| label.lines())
        .map(str::trim).filter(|label| label.starts_with("最高温度"))
        .map(str::to_owned).collect()).unwrap_or_default()
}
fn high_temperature_groups(data: &Collected) -> Result<Vec<Vec<String>>, String> {
    let names = data.photos.iter().map(|p| p.name.clone()).collect::<Vec<_>>();
    Ok(issue_groups(&names)?.into_iter().filter(|group| group.iter().any(|name|
        data.photos.iter().any(|p| &p.name == name && !maximum_labels(p).is_empty())
    )).collect())
}
// Only target coordinates from maximum-temperature photos belong on this map.
// Keep table-2 group numbers even when an earlier group has no coordinates.
fn high_temperature_points(photos: &[&Photo], facts: &[evidence::PhotoFacts], groups: &[Vec<String>]) -> Vec<(usize, f64, f64)> {
    let mut points = Vec::new();
    for (i, group) in groups.iter().enumerate() {
        for (photo, fact) in photos.iter().zip(facts) {
            if !group.contains(&photo.name) || maximum_labels(photo).is_empty() { continue; }
            if let Some((lon, lat)) = fact.laser_target {
                let point = (i + 1, lon, lat);
                if !points.contains(&point) { points.push(point); }
            }
        }
    }
    points
}
fn validate(data: &Collected, now: i64) -> Result<Option<Stats>, String> {
    if data.without_air_data {
        if !data.air.points.is_empty()
            || data.air.chart.is_some()
            || !data.air.channels.is_empty()
            || !data.air.url.is_empty()
            || data.air.mission_id != 0
            || !data.air.unit.is_empty()
        {
            return Err("无可飞数据模式不能包含可飞采样资料。".into());
        }
    } else {
        source(&data.air.url, false)?;
        air_chart::validate(&data.air)?;
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
    if (!data.media.no_media && !data.media.folder.trim_end().ends_with("Immediate-Media")
        && !data.media.root_folder_id.is_some_and(|id| id > 0 && data.media.url.split('?').nth(1).is_some_and(|q| q.split('&').any(|p| p == format!("pid={id}")))))
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
        p.validate_presentation(now, false)?;
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
    for (name, channel) in &data.air.channels {
        let (source, unit, _) = channel_spec(name).ok_or("可飞包含未知报告通道")?;
        if channel.source_channel != source || channel.unit != unit
            || channel.values.len() != data.air.points.len()
            || channel.values.iter().flatten().any(|v| !v.is_finite() || *v < 0.0 || *v > 100000.0) {
            return Err(format!("可飞 {name} 通道、单位或数据长度不符"));
        }
    }
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
            if during_flight(m, p) { values.push((v, p.time)); }
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
    if values.is_empty() {
        return Err("实际执飞时段内没有有效 PM2.5 数据，请核对飞行时间或明确选择可飞数据暂不可用。".into());
    }
    if coords < 2 {
        return Err("缺少有效航迹坐标，暂不能生成快报。".into());
    }
    let peak = values.iter().max_by(|a, b| a.0.total_cmp(&b.0).then_with(|| b.1.cmp(&a.1))).unwrap();
    Ok(Some(Stats {
        max: peak.0,
        mean: values.iter().map(|x| x.0).sum::<f64>() / values.len() as f64,
        count: values.len(),
        missing: data.air.points.iter().filter(|p| during_flight(m, p)).count() - values.len(),
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
    let _access = crate::data_reset::access(&app)?;
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
    let _access = crate::data_reset::access(&app)?;
    read_dji_tasks(&database(&app)?)
}
#[tauri::command]
pub async fn sync_dji_report_tasks(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Bridge>,
    session: String,
) -> Result<Value, String> {
    let _access = crate::data_reset::access(&app)?;
    crate::readiness::require_report_media(&app)?;
    // One cursor owner across UI requests, including while awaiting Chrome.
    static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _sync = SYNC_LOCK.lock().await;
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
// Persist the IDs seen across leases. Cursor continuity and a stable total
// are required before absence from a finished scan can remove cached rows.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DjiHistoryScan {
    total: u64,
    next_page: u64,
    keys: HashSet<String>,
}
fn scanned_task_keys(
    db: &rusqlite::Connection,
    result: &Value,
    incoming: &HashSet<String>,
) -> Result<Option<HashSet<String>>, String> {
    const KEY: &str = "dji_report_scan";
    let metadata = &result["historyScan"];
    let complete = result["cursor"].is_null()
        && result["historyComplete"] == true
        && result["historyError"].is_null();
    let total = result["total"].as_u64();
    let full_batch = complete && total == Some(incoming.len() as u64);
    if metadata.is_null() {
        // An older adapter or an interrupted/restarted scan cannot prove
        // continuity. A complete standalone snapshot remains sufficient.
        db.execute("DELETE FROM monitor_settings WHERE key=?1", [KEY])
            .map_err(|e| e.to_string())?;
        return Ok(full_batch.then(|| incoming.clone()));
    }
    let total = total.ok_or("司空历史扫描缺少总数")?;
    let start = metadata["startPage"]
        .as_u64()
        .ok_or("司空历史扫描起点无效")?;
    let next = metadata["nextPage"]
        .as_u64()
        .ok_or("司空历史扫描终点无效")?;
    let last = total.div_ceil(50).max(1);
    if metadata["total"].as_u64() != Some(total)
        || start < 2
        || start > last + 1
        || next < start
        || next > last + 1
        || next - start > 5
        || (complete && next != last + 1)
        || (!result["cursor"].is_null()
            && (result["cursor"]["page"].as_u64() != Some(next)
                || result["cursor"]["total"].as_u64() != Some(total)))
    {
        return Err("司空历史扫描进度不匹配，未更新缓存".into());
    }
    let previous: Option<DjiHistoryScan> =
        crate::monitoring::setting(db, KEY)?.and_then(|raw| serde_json::from_str(&raw).ok());
    let mut scan = if start == 2 {
        Some(DjiHistoryScan {
            total,
            next_page: next,
            keys: HashSet::new(),
        })
    } else {
        previous.filter(|scan| scan.total == total && scan.next_page == start)
    };
    if let Some(scan) = &mut scan {
        scan.keys.extend(incoming.iter().cloned());
        scan.next_page = next;
    }
    // Missing/duplicate records or a changed total never authorize pruning.
    let authoritative = if full_batch {
        Some(incoming.clone())
    } else {
        scan.as_ref()
            .filter(|scan| complete && scan.keys.len() as u64 == total)
            .map(|scan| scan.keys.clone())
    };
    if !complete {
        if let Some(scan) = scan {
            crate::monitoring::put(
                db,
                KEY,
                &serde_json::to_string(&scan).map_err(|e| e.to_string())?,
            )?;
            return Ok(authoritative);
        }
    }
    db.execute("DELETE FROM monitor_settings WHERE key=?1", [KEY])
        .map_err(|e| e.to_string())?;
    Ok(authoritative)
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
    if let Some(authoritative) = scanned_task_keys(&tx, result, &incoming_keys)? {
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
            if !authoritative.contains(&key) {
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
    crate::flight::reconcile_ended_tasks(&tx, &read_dji_tasks(&tx)?)?;
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
    let access = crate::data_reset::access(&app)?;
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
        let cache_root = root(&app)?;
        let cached_air = if req.without_air_data { None } else { cache::air(&cache_root, &req.mission, Utc::now().timestamp_millis()) };
        let reuse_air = cached_air.is_some();
        let air: AirData = if req.without_air_data {
            AirData { url: String::new(), mission_id: 0, unit: String::new(), points: vec![], channels: HashMap::new(), chart: None }
        } else if let Some(air) = cached_air { air } else { serde_json::from_value(
            bridge
                .request(
                    req.sniff_session.clone().ok_or("请选择可飞页面")?,
                    req.sniff_tab_id.ok_or("请选择可飞页面")?,
                    json!({"type":"flight-airins","missionId":req.mission.mission_id,"captureChart":true}),
                )
                .await?,
        )
        .map_err(|e| format!("可飞格式错误：{e}"))? };
        if !req.without_air_data && air.chart.is_none() {
            return Err("未取得可飞 PM2.5 图表截图，请更新并重新加载浏览器插件后重试".into());
        }
        if !req.without_air_data && !reuse_air {
            cache::store_air(&cache_root, &req.mission, &air, Utc::now().timestamp_millis())?;
        }
        let media = if req.no_media {
            // A missing media folder is not evidence of zero photos. Only an exact
            // persisted FlightHub execution receipt can authorize an empty report.
            let tasks = read_dji_tasks(&database(&app)?)?;
            if !tasks.iter().any(|task| task.no_media && task.media_ready
                && task.mission.mission_name == req.mission.mission_name
                && task.mission.start_time == req.mission.start_time && task.mission.end_time == req.mission.end_time) {
                return Err("司空尚未确认本航次无媒体文件".into());
            }
            Media { url: format!("https://fh.dji.com{PROJECT}#/plan"), folder: "司空计划：无媒体文件".into(), files: vec![], file_pages: HashMap::new(), no_media: true, root_folder_id: None }
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
            if media.root_folder_id.is_some() && media.root_folder_id != folder_id {
                return Err("司空根目录照片回执与任务目录不匹配".into());
            }
            media
        };
        if !req.without_air_data { source(&air.url, false)?; }
        let cached_photos = cache::photos(&cache_root, &req.mission, &media, Utc::now().timestamp_millis());
        let reuse_photos = cached_photos.is_some();
        if reuse_photos && !req.no_media {
            bridge.request(req.dji_session.clone(), req.dji_tab_id,
                json!({"type":"flight-dji-list", "mediaKey":media_key(&req), "closeOnly":true})).await?;
        }
        let mut photos = cached_photos.unwrap_or_default();
        let media_key = media_key(&req);
        for (index, name) in media.files.iter().enumerate().filter(|_| !reuse_photos) {
            let t = photo_time(name)?;
            if t < req.mission.start_time - 300000 || t > req.mission.end_time + 300000 {
                return Err("照片不属于本次飞行，已停止采集。".into());
            }
            let v = bridge
                .request(
                    req.dji_session.clone(),
                    req.dji_tab_id,
                    json!({"type":"flight-dji-image","name":name,"page":media.file_pages.get(name),"mediaKey":media_key,"closeAfter":index + 1 == media.files.len(),"rootFolderId":media.root_folder_id}),
                )
                .await?;
            if !same_media_folder(v["url"].as_str().unwrap_or_default(), &media.url) || v["folder"] != media.folder || v["name"] != *name {
                return Err("采集期间司空页面发生变化，请重试。".into());
            }
            let photo: Photo = serde_json::from_value(v).map_err(|e| format!("图片格式错误：{e}"))?;
            photo.validate_presentation(Utc::now().timestamp_millis(), true)?;
            photos.push(photo);
        }
        let data = Collected {
            data_generation: Some(*access),
            evidence: None,
            without_air_data: req.without_air_data,
            local_event_id: req.local_event_id,
            mission: req.mission,
            air,
            media,
            photos,
        };
        validate(&data, Utc::now().timestamp_millis())?;
        if !reuse_photos { cache::store_photos(&cache_root, &data)?; }
        crate::runtime_log::record(&app, "info", "report", "collect_flight_report.cache",
            "巡查报告本地资料复用完成",
            json!({"airReused":reuse_air,"photosReused":reuse_photos,"photoCount":data.photos.len()}));
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
// Both masthead numbers identify the actual flight minute in Beijing time.
// Never inherit a historical counter when regenerating an older report.
fn flight_issue_number(start_time: i64) -> Result<u64, String> {
    let start = DateTime::from_timestamp_millis(start_time).ok_or("实际起飞时间无效")?;
    start.with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
        .format("%Y%m%d%H%M").to_string().parse::<u64>()
        .map_err(|_| "实际起飞时间无法生成期号".into())
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
        out.push_str(&xml(&value.1).replace('\n', "</w:t><w:br/><w:t xml:space=\"preserve\">"));
        rest = &rest[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}
// Delete authored text across Word runs while retaining the XML and formatting.
// Called only on our template before any external/user text is inserted.
fn omit_high_process_details(doc: &mut String) -> Result<(), String> {
    let mut spans = Vec::new();
    let mut text = String::new();
    let mut cursor = 0;
    while let Some(relative) = doc[cursor..].find("<w:t") {
        let tag = cursor + relative;
        let boundary = doc.as_bytes().get(tag + 4).copied();
        if !matches!(boundary, Some(b'>' | b' ')) {
            cursor = tag + 4;
            continue;
        }
        let start = tag + doc[tag..].find('>').ok_or("模板文本起点缺失")? + 1;
        if doc.as_bytes()[start - 2] == b'/' {
            cursor = start;
            continue;
        }
        let end = start + doc[start..].find("</w:t>").ok_or("模板文本终点缺失")?;
        spans.push((start, end, text.len()));
        text.push_str(&doc[start..end]);
        cursor = end + 6;
    }
    let start = text.find("主要集中在").ok_or("模板高值说明缺失")?;
    let suffix = "前后高值过程最为突出，";
    let end = start + text[start..].find(suffix).ok_or("模板高值说明未结束")? + suffix.len();
    for (xml_start, xml_end, offset) in spans.into_iter().rev() {
        let left = start.max(offset);
        let right = end.min(offset + xml_end - xml_start);
        if left < right {
            doc.replace_range(xml_start + left - offset..xml_start + right - offset, "");
        }
    }
    Ok(())
}
fn fill_table(doc: &mut String, index: usize, rows: &[Vec<String>]) -> Result<(), String> {
    fill_table_emphasized(doc, index, rows, &[])
}
fn fill_table_emphasized(doc: &mut String, index: usize, rows: &[Vec<String>], bold_columns: &[Option<usize>]) -> Result<(), String> {
    let token = format!("{{{{T{index}_0}}}}");
    let pos = doc.find(&token).ok_or("模板表格行缺失")?;
    let start = doc[..pos]
        .rfind("<w:tr>")
        .max(doc[..pos].rfind("<w:tr "))
        .ok_or("模板行起点缺失")?;
    let end = pos + doc[pos..].find("</w:tr>").ok_or("模板行终点缺失")? + 7;
    let row_template = &doc[start..end];
    let mut filled = String::new();
    for (row_index, row) in rows.iter().enumerate() {
        let fields: Vec<_> = row
            .iter()
            .enumerate()
            .map(|(col, value)| (format!("T{index}_{col}"), value.clone()))
            .collect();
        let fields: Vec<_> = fields
            .iter()
            .map(|(key, value)| (key.as_str(), value.clone()))
            .collect();
        let mut row_xml = fill_slots(row_template, &fields)?;
        if let Some(Some(column)) = bold_columns.get(row_index) {
            let start = row_xml.match_indices("<w:tc>").nth(*column).ok_or("最高值单元格缺失")?.0;
            let end = start + row_xml[start..].find("</w:tc>").ok_or("最高值单元格未闭合")? + 7;
            let mut cell = row_xml[start..end].to_owned();
            for tag in ["<w:b/>", "<w:b w:val=\"0\"/>", "<w:b w:val=\"false\"/>"] { cell = cell.replace(tag, ""); }
            cell = cell.replace("<w:rPr/>", "<w:rPr></w:rPr>")
                .replace("<w:rPr>", "<w:rPr><w:b/><w:bCs/>");
            cell = cell.replace("<w:r><w:t", "<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t");
            row_xml.replace_range(start..end, &cell);
        }
        filled.push_str(&row_xml);
    }
    doc.replace_range(start..end, &filled);
    Ok(())
}
// The report tables use black text for both populated values and blanks. The
// retained reference template marks several editable cells red, so remove
// that presentation color from table XML before filling any values.
fn remove_table_red(doc: &mut String) {
    let mut cursor = 0;
    while let Some(relative_start) = doc[cursor..].find("<w:tbl") {
        let start = cursor + relative_start;
        let Some(relative_end) = doc[start..].find("</w:tbl>") else { break };
        let end = start + relative_end + "</w:tbl>".len();
        let table = doc[start..end]
            .replace("<w:color w:val=\"FF0000\"/>", "")
            .replace("<w:color w:val=\"ff0000\"/>", "");
        doc.replace_range(start..end, &table);
        cursor = start + table.len();
    }
}
fn image_xml(id: usize, width: i64, height: i64) -> String {
    format!(
        r#"<w:p><w:pPr><w:jc w:val="center"/><w:keepNext/><w:spacing w:before="200" w:after="80"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="{width}" cy="{height}"/><wp:docPr id="{id}" name="Report image {id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdFlight{id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{width}" cy="{height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"#
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
fn photo_coordinate(f: &evidence::PhotoFacts) -> Option<String> {
    match (f.longitude, f.latitude) {
        (Some(lon), Some(lat)) => Some(format!(
            "{:.6}°{} / {:.6}°{}",
            lon.abs(),
            if lon < 0.0 { "W" } else { "E" },
            lat.abs(),
            if lat < 0.0 { "S" } else { "N" }
        )),
        _ => None,
    }
}
fn photo_auto_description(p: &Photo, f: &evidence::PhotoFacts) -> String {
    let coordinate = photo_coordinate(f)
        .map(|value| format!("照片坐标{value}"))
        .unwrap_or_else(|| "照片无有效GPS坐标".into());
    let height = f
        .relative_height
        .map(|value| format!("相对高度{value:.2}米"));
    let labels = maximum_labels(p);
    let thermal = if f.image_type == "红外热成像" || !labels.is_empty() {
        if labels.is_empty() {
            "红外热成像，高温点待判读".into()
        } else {
            format!("红外高温点，司空标注{}；热源性质待核实", labels.join("，"))
        }
    } else {
        "可见光辅助影像，不单独计为问题".into()
    };
    [Some(coordinate), Some(thermal), height]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("；")
}
fn build_docx(
    data: &Collected,
    charts: &[String; 2],
    issued: i64,
) -> Result<Vec<u8>, String> {
    let stats = validate(data, issued)?;
    let issue_number = flight_issue_number(data.mission.start_time)?;
    // Chart inputs remain validated for compatibility; the report uses a
    // compact statistics table and the reference layout for field photos.
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
    remove_table_red(&mut doc);
    let caption = String::from_utf8(
        parts
            .remove("word/report-caption.xml")
            .ok_or("模板图注缺失")?,
    )
    .map_err(|e| e.to_string())?;
    let caption = &caption[caption.find("<w:p ").ok_or("图注段落缺失")?..];
    // Keep each image with its caption, but do not chain the caption to the next image.
    let caption = caption.replace("<w:keepNext/>", "<w:keepNext w:val=\"0\"/>");
    let caption_for = |text: String| fill_slots(&caption, &[("CAPTION", text)]);
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
    let visible = facts
        .iter()
        .filter(|f| f.image_type.starts_with("可见光"))
        .count();
    let infrared = facts
        .iter()
        .filter(|f| f.image_type == "红外热成像")
        .count();
    let count = photos.len().to_string();
    // Group nearby captures, then select only groups with maximum-temperature evidence.
    let groups = high_temperature_groups(data)?;
    let issue_count = groups.len();
    let target_points = high_temperature_points(&photos, &facts, &groups);
    let coverage = evidence
        .dji_task
        .as_ref()
        .map(|task| match task.status.as_str() {
            "执行成功" => "完整覆盖",
            "部分执行" | "执行终止" | "执行失败" => "部分覆盖",
            _ => "覆盖范围待核实",
        })
        .unwrap_or("覆盖范围待核实");
    let anomaly_summary = format!("高温疑似问题{issue_count}组");
    let blank = "【 】".to_owned();
    let mut fields = vec![
        ("ISSUE", issue_number.to_string()),
        ("SERIES_ISSUE", issue_number.to_string()),
        ("ISSUED", date(issued, "%Y年%-m月%-d日")),
        ("FLIGHT_DATE", date(m.start_time, "%Y年%-m月%-d日")),
        ("ANALYSIS_WINDOW", evidence.trigger_hour_label()),
        ("FLIGHT_WINDOW", flight_window.clone()),
        ("PHOTO_COUNT", count.clone()),
        ("TOTAL0_1", "本航次".into()),
        ("TOTAL0_2", table_window.clone()),
        ("TOTAL0_3", coverage.into()),
        ("TOTAL0_4", format!("{count}张")),
        (
            "TOTAL0_5",
            anomaly_summary.clone(),
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
    ];
    // The authored threshold occupies its own Word run; preserve its styling.
    let threshold_start = doc.find("高于</w:t>").ok_or("模板高值阈值缺失")?;
    let threshold_offset = doc[threshold_start..].find("<w:t>1</w:t>").ok_or("模板高值阈值数字缺失")? + threshold_start;
    doc.replace_range(threshold_offset..threshold_offset + "<w:t>1</w:t>".len(),
        &format!("<w:t>{}</w:t>", evidence.high_threshold()));
    fields.extend(evidence.city_fields());
    if fields.iter().any(|(key, value)| *key == "CITY_HIGH_HOURS" && value == "0") {
        omit_high_process_details(&mut doc)?;
    }
    fields.push((
        "TRIGGER",
        format!("由【{}】触发", m.mission_name),
    ));
    fields.push(("PHOTO_REVIEW_SUMMARY", format!("经AI智能识别，发现异常情况{issue_count}处")));

    // A flight execution is a task/route, never one row per photograph.
    let execution = vec![vec![
        "1".into(),
        evidence.dji_task.as_ref().and_then(|t| t.route_name.clone())
            .filter(|v| !v.is_empty()).unwrap_or_else(|| m.mission_name.clone()),
        table_window.clone(),
        coverage.into(),
        format!("照片{count}张"),
        anomaly_summary,
    ]];

    let route_name = evidence.dji_task.as_ref()
        .and_then(|task| task.route_name.as_deref())
        .map(str::trim).filter(|name| !name.is_empty()).unwrap_or(&blank);
    let rows: Vec<_> = groups.iter().enumerate().map(|(i, group)| {
        let selected: Vec<_> = photos.iter().zip(&facts)
            .filter(|(p, _)| group.contains(&p.name) && !maximum_labels(p).is_empty()).collect();
        let (p, f) = selected[0];
        let coordinates = target_points.iter().filter(|(group, _, _)| *group == i + 1)
            .map(|(_, lon, lat)| format!("经度{lon:.6}° / 纬度{lat:.6}°")).collect::<Vec<_>>();
        let group_facts: Vec<_> = photos.iter().zip(&facts)
            .filter(|(photo, _)| group.contains(&photo.name)).map(|(_, fact)| fact).collect();
        let mut image_types = Vec::new();
        if group_facts.iter().any(|fact| fact.image_type.starts_with("可见光")) {
            image_types.push("可见光");
        }
        if group_facts.iter().any(|fact| fact.image_type == "红外热成像") {
            image_types.push("红外");
        }
        let mut labels = selected.iter().flat_map(|(p, _)| maximum_labels(p)).collect::<Vec<_>>();
        labels.sort(); labels.dedup();
        Ok(vec![
            (i + 1).to_string(), date(photo_time(&p.name)?, "%m-%d %H:%M:%S"),
            route_name.to_owned(),
            if coordinates.is_empty() { blank.clone() } else { coordinates.join("；") },
            if image_types.is_empty() { blank.clone() } else { image_types.join(" / ") },
            format!("{}；热源性质待核实{}", labels.join("；"),
                photo_coordinate(f).map(|c| format!("；拍摄位置{c}")).unwrap_or_default()),
        ])
    }).collect::<Result<_, String>>()?;
    let air_peaks = air_peak_indices(data);
    let air_rows = air_peak_rows(data, &air_peaks);

    let warning = if stats.as_ref().is_some_and(|s| s.max == 0.0) {
        "本航次 PM2.5 有效数值全部为 0，请核查传感器状态；不能据此判断空气质量良好。"
    } else { "" };
    fields.push(("AIR_INTRO", if data.without_air_data { String::new() } else {
        let s = stats.as_ref().unwrap();
        format!("统计时段为{flight_window}（北京时间，含起止时刻），共{}条记录，其中PM2.5有效{}条、缺测{}条。表4依次列出PM2.5、PM10、SO₂、NO₂、CO最高值所在记录及同一记录的其他指标，最高值加粗；并列最高值取最早记录，缺测不补0。时段外数据不参与统计，完整采样另行归档。气体浓度按可飞平台口径换算。", s.count+s.missing, s.count, s.missing)
    }));
    let sampling_summary = stats.as_ref().map(|s| format!("实际执飞时段内PM2.5最高值{:.1} μg/m³，平均值{:.1} μg/m³；有效采样{}点、缺测{}点，最高值首次出现时间{}。{}", s.max, s.mean, s.count, s.missing, date(s.peak_time, "%m-%d %H:%M:%S"), warning)).unwrap_or_default();
    fields.push(("CONCLUSION", if !evidence.conclusion.is_empty() {
        format!("{}{}", evidence.conclusion, sampling_summary)
    } else if stats.is_some() {
        format!("本次巡航抓拍图片{count}张，影像异常及污染成因待判读、核实。{sampling_summary}")
    } else { blank.clone() }));
    // Work recommendations are the approved fixed text in the Word template.
    let mut rels = String::from_utf8(
        parts
            .remove("word/_rels/document.xml.rels")
            .ok_or("模板关系缺失")?,
    )
    .map_err(|e| e.to_string())?;
    let mut types = String::from_utf8(parts.remove("[Content_Types].xml").ok_or("模板类型缺失")?)
        .map_err(|e| e.to_string())?;
    let mut photo_xml = String::new();
    let mut photo_sizes = HashMap::new();

    for (i, p) in photos.iter().enumerate() {
        let id = i + 1000; // avoid the reference masthead drawing's ID
        let (bytes, ext) = decode_image(p.display_url())?;
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
        photo_sizes.insert(p.name.as_str(), (id, width, height));
    }
    for (group_index, group) in groups.iter().enumerate() {
        let mut group_photos: Vec<_> = group.iter().collect();
        group_photos.sort_by_key(|name| {
            let p = photos.iter().find(|p| &p.name == *name).unwrap();
            (maximum_labels(p).is_empty(), p.name.clone())
        });
        // The template has 13040 twips of usable height. Reserve space for
        // captions, 12 pt gaps and inline baselines; scale the group proportionally.
        const PHOTO_WIDTH: f64 = 5_600_000.0;
        const GROUP_HEIGHT: f64 = 7_800_000.0;
        let total_height: f64 = group_photos.iter().map(|name| {
            let (_, width, height) = photo_sizes[name.as_str()];
            PHOTO_WIDTH * height as f64 / width as f64
        }).sum();
        let scale = ((GROUP_HEIGHT - group_photos.len() as f64 * 420_000.0).max(300_000.0)
            / total_height).min(1.0);
        for (photo_index, name) in group_photos.iter().enumerate() {
            let (id, width, height) = photo_sizes[name.as_str()];
            let image = image_xml(id, (PHOTO_WIDTH * scale) as i64,
                (PHOTO_WIDTH * height as f64 / width as f64 * scale) as i64)
                .replace("name=\"image\"", &format!("name=\"{}\"", xml(name)))
                .replace("<w:spacing w:before=\"200\" w:after=\"80\"/>",
                    "<w:snapToGrid w:val=\"0\"/><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/>");
            photo_xml.push_str(&image);
            // Keep every picture and caption of a group on the same page,
            // releasing the chain at the final caption so groups can paginate.
            let keep = if photo_index + 1 < group_photos.len() { "1" } else { "0" };
            photo_xml.push_str(&format!(r#"<w:p><w:pPr><w:keepNext w:val="{keep}"/><w:snapToGrid w:val="0"/><w:spacing w:before="0" w:after="240" w:line="240" w:lineRule="exact"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:color w:val="000000"/><w:sz w:val="20"/></w:rPr><w:t>{}-{}</w:t></w:r></w:p>"#,
                group_index + 1, photo_index + 1));
        }
    }
    if photo_xml.is_empty() { photo_xml = caption_for("未筛出含最高温度标注的照片组，不列问题图片。".into())?; }

    // Fill global fields before adding user-derived table/figure content; no
    // arbitrary strings are used as XML, and absent fields keep editable blanks.
    // Tables are already filled, so user data containing braces is protected by
    // limiting this pass to the named global slots.
    let mut rest = doc.as_str();
    let mut filled = String::new();
    while let Some(start) = rest.find("{{") {
        let end = rest[start+2..].find("}}").ok_or("模板字段未闭合")? + start+4;
        filled.push_str(&rest[..start]);
        let key = &rest[start+2..end-2];
        if let Some((_, value)) = fields.iter().find(|(name,_)|*name==key) {
            filled.push_str(&xml(value));
        } else {
            filled.push_str(&rest[start..end]);
        }
        rest = &rest[end..];
    }
    filled.push_str(rest);
    doc = filled;
    fill_table(&mut doc, 0, &execution)?;
    fill_table(
        &mut doc,
        1,
        &if rows.is_empty() {
            vec![vec!["未取得".into(); 7]]
        } else {
            rows
        },
    )?;
    let bold_columns: Vec<_> = air_peaks.iter().enumerate().map(|(i, peak)| peak.map(|_| i + 3)).collect();
    fill_table_emphasized(&mut doc, 2, &air_rows, &bold_columns)?;
    // Remove the distribution image and caption, including their template paragraph.
    block(&mut doc, "SECTION_PHOTOS", "")?;
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
    let issue_number = flight_issue_number(data.mission.start_time)?;
    let bytes = build_docx(data, charts, now)?;
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
            issue_count: Some(high_temperature_groups(data)?.len()),
            issue_number: Some(issue_number),
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
            "rule": "highest-temperature-label-groups-span-at-most-3-seconds", "groups": high_temperature_groups(data)?
        })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::write(temp.join("report-settings.json"), serde_json::to_vec_pretty(&json!({
            "templateVersion": "standard-20261103-v1",
            "runtimeTemplateSha256": evidence::digest(TEMPLATE),
            "templateSha256": "25aa8b8df042c1f4577fc3ba0a19712dabd5a88543ff24abc75ec09c0c30b141",
            "generatorVersion": "flight-standard-20261109-v2", "issueNumber": issue_number, "statistics": ["maximum", "arithmetic-mean"],
            "airinsChartIncluded": data.air.chart.is_some(),
            "windowStart": data.mission.start_time, "windowEnd": data.mission.end_time,
            "windowInclusive": true, "rawPointCount": data.air.points.len(),
            "flightPointCount": data.air.points.iter().filter(|p| during_flight(&data.mission,p)).count(),
            "pm25ValidPointCount": stats.as_ref().map_or(0, |s| s.count),
            "pm25MissingPointCount": stats.as_ref().map_or(0, |s| s.missing),
            "pm25Maximum": stats.as_ref().map(|s| s.max), "pm25Mean": stats.as_ref().map(|s| s.mean),
            "pm25PeakTime": stats.as_ref().map(|s| s.peak_time),
            "gasConversion": {"source":"Airins platform", "ppmToMgM3Divisor":25.4,
                "molarMass":{"so2":64.06,"no2":46.01,"co":28.01,"o3":48.0}}
        })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
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
        presentation::archive(&data.photos, &temp)?;
        air_chart::archive(&data.air, &temp)?;
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
        let mut csv = String::from("time_beijing,longitude,latitude,pm25_ug_m3,pm10_ug_m3,so2_ug_m3,no2_ug_m3,co_mg_m3,o3_ug_m3,within_flight_window\n");
        for (i, p) in data.air.points.iter().enumerate() {
            let mut row = vec![date(p.time, "%Y-%m-%d %H:%M:%S%.3f"),
                p.longitude.map(|v|v.to_string()).unwrap_or_default(),
                p.latitude.map(|v|v.to_string()).unwrap_or_default(),
                p.pm25.map(|v|v.to_string()).unwrap_or_default()];
            row.extend(["pm10", "so2", "no2", "co", "o3"].map(|name| air_value(&data.air,name,i).map(|v|v.to_string()).unwrap_or_default()));
            row.push(during_flight(&data.mission, p).to_string());
            csv.push_str(&row.join(",")); csv.push('\n');
        }
        fs::write(temp.join("air-quality.csv"), csv).map_err(|e| e.to_string())?;
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
    let access = crate::data_reset::access(&app)?;
    crate::data_reset::require_generation(*access, data.data_generation)?;
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
        // Refresh station observations on every save, even when flight assets
        // came from cache or the preview has been open for a while.
        if let Some(snapshot) = data.evidence.as_mut() {
            if let Some(end) = snapshot.trigger_hour() {
                let (rows, url, synced_at) = crate::monitoring::report_hours(&app, &end).await
                    .map_err(|e| format!("重新读取大气站数据失败：{e}"))?;
                snapshot.city_hours = rows.into_iter().map(|row| evidence::CityHour {
                    time: row.time, potassium: row.potassium, pm25: row.pm25,
                    source_url: url.clone(), synced_at: synced_at.clone(),
                }).collect();
                snapshot.captured_at = Utc::now().timestamp_millis();
            }
        }
        tauri::async_runtime::spawn_blocking(move || {
            // Cancellation of the caller cannot release the guard while the
            // blocking writer is still committing files.
            let _access = access;
            persist(
                &root,
                &data,
                &charts,
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
    let _access = crate::data_reset::access(&app)?;
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
                            if let Ok(data) = serde_json::from_value::<Collected>(value.clone()) {
                                summary.issue_count = high_temperature_groups(&data).ok().map(|g| g.len());
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
    let _access = crate::data_reset::access(&app)?;
    let path = saved_report_path(&root(&app)?, &id)?;
    app.opener()
        .open_path(path.to_str().ok_or("路径无效")?, None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn open_flight_report_directory(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
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
    fn completed_large_sweep_prunes_deleted_tasks() {
        let mut db = crate::monitoring::connect(Path::new(":memory:")).unwrap();
        let task = |index: u128| {
            json!({
                "taskId": Uuid::from_u128(index).to_string(),
                "mission":{"missionId":0,"missionName":format!("task-{index}"),"startTime":1790031600000_i64,"endTime":1790032800000_i64,"geoLocation":""},
                "status":"执行成功","mediaReady":true
            })
        };
        let batch = |rows: Vec<Value>, cursor: Value, complete: bool, total: usize| {
            json!({
                "url":format!("https://fh.dji.com{PROJECT}#/plan"),"tasks":rows,"cursor":cursor,"historyComplete":complete,"historyError":null,"total":total,"apiVersion":1,
                "historyScan":{"total":total,"startPage":if total==301 && complete {7}else{2},"nextPage":if total==301 {if complete {8}else{7}}else{2}}
            })
        };
        persist_dji_tasks(&mut db, &batch(vec![task(999)], Value::Null, true, 1)).unwrap();
        // A completed 301-row sweep is delivered in two leases: pages 1..6,
        // followed by refreshed page 1 plus the final page. Old row 999 is gone.
        persist_dji_tasks(
            &mut db,
            &batch(
                (1..=300).map(task).collect(),
                json!({"apiVersion":1,"page":7,"total":301}),
                false,
                301,
            ),
        )
        .unwrap();
        assert_eq!(read_dji_tasks(&db).unwrap().len(), 301); // Old row retained until completion.
        assert!(crate::monitoring::setting(&db, "dji_report_scan")
            .unwrap()
            .is_some());
        let mut last: Vec<_> = (1..=50).map(task).collect();
        last.push(task(301));
        let progress_before = crate::monitoring::setting(&db, "dji_report_scan").unwrap();
        let mut bad = last.clone();
        bad.last_mut().unwrap()["mission"]["missionName"] = json!("");
        assert!(persist_dji_tasks(&mut db, &batch(bad, Value::Null, true, 301)).is_err());
        assert_eq!(read_dji_tasks(&db).unwrap().len(), 301);
        assert_eq!(crate::monitoring::setting(&db, "dji_report_scan").unwrap(), progress_before);
        persist_dji_tasks(&mut db, &batch(last, Value::Null, true, 301)).unwrap();
        assert_eq!(read_dji_tasks(&db).unwrap().len(), 301);
    }

    #[test]
    fn history_scan_retries_restart_and_missing_pages_never_prune_early() {
        let db = crate::monitoring::connect(Path::new(":memory:")).unwrap();
        let keys = |from: usize, through: usize| {
            (from..=through)
                .map(|n| format!("dji-{n}"))
                .collect::<HashSet<_>>()
        };
        let batch = |start: u64, next: u64, total: u64, complete: bool, error: Value| {
            json!({
                "total":total, "historyScan":{"startPage":start,"nextPage":next,"total":total},
                "cursor":if complete {Value::Null}else{json!({"apiVersion":1,"page":next,"total":total})},
                "historyComplete":complete, "historyError":error
            })
        };
        // A failed second lease preserves its progress and keys for retry.
        assert!(
            scanned_task_keys(&db, &batch(2, 7, 401, false, Value::Null), &keys(1, 300))
                .unwrap()
                .is_none()
        );
        assert!(scanned_task_keys(
            &db,
            &batch(7, 8, 401, false, json!("timeout")),
            &keys(301, 350)
        )
        .unwrap()
        .is_none());
        let completed =
            scanned_task_keys(&db, &batch(8, 10, 401, true, Value::Null), &keys(351, 401))
                .unwrap()
                .unwrap();
        assert_eq!(completed.len(), 401);
        // A changed total with a fresh start discards the prior scan's IDs.
        scanned_task_keys(&db, &batch(2, 7, 401, false, Value::Null), &keys(1, 300)).unwrap();
        let restarted =
            scanned_task_keys(&db, &batch(2, 3, 51, true, Value::Null), &keys(1000, 1050))
                .unwrap()
                .unwrap();
        assert!(!restarted.contains("dji-1"));
        // Upgrading or losing an intermediate page cannot establish absence.
        assert!(
            scanned_task_keys(&db, &batch(7, 8, 301, true, Value::Null), &keys(301, 301))
                .unwrap()
                .is_none()
        );
        scanned_task_keys(&db, &batch(2, 7, 401, false, Value::Null), &keys(1, 300)).unwrap();
        assert!(
            scanned_task_keys(&db, &batch(8, 10, 401, true, Value::Null), &keys(301, 401))
                .unwrap()
                .is_none()
        );
        // Even continuous pages with duplicate/missing keys do not prove completeness.
        scanned_task_keys(&db, &batch(2, 7, 301, false, Value::Null), &keys(1, 299)).unwrap();
        assert!(
            scanned_task_keys(&db, &batch(7, 8, 301, true, Value::Null), &keys(301, 301))
                .unwrap()
                .is_none()
        );
        // A count change mid-lease invalidates the persisted scan.
        scanned_task_keys(&db, &batch(2, 7, 401, false, Value::Null), &keys(1, 300)).unwrap();
        scanned_task_keys(
            &db,
            &json!({"historyError":"changed","total":401}),
            &keys(1, 50),
        )
        .unwrap();
        assert!(crate::monitoring::setting(&db, "dji_report_scan")
            .unwrap()
            .is_none());
    }
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
    fn no_photos_omit_location_section_entirely() {
        let mut data = sample();
        data.media.url = format!("https://fh.dji.com{PROJECT}#/plan");
        data.media.files.clear();
        data.media.no_media = true;
        data.photos.clear();
        let bytes = build_docx(&data, &[PNG.into(), PNG.into()], Utc::now().timestamp_millis()).unwrap();
        if let Ok(path) = std::env::var("TAIZHOU_REPORT_QA_NO_PHOTOS") {
            fs::write(path, &bytes).unwrap();
        }
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut doc = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        assert!(!doc.contains("巡航现场照片及对应位置图"));
        assert!(!doc.contains("位置图未取得"));
        assert!(!doc.contains("{{SECTION_PHOTOS}}"));
        let after_table = &doc[doc.find("</w:tbl>").unwrap() + "</w:tbl>".len()..];
        let next_paragraph = &after_table[..after_table.find("</w:p>").unwrap()];
        assert!(next_paragraph.contains("三、大疆司空平台抓拍图片信息"));
    }
    #[test]
    fn root_media_requires_matching_folder_id_and_flight_time() {
        let mut data = sample();
        data.media.folder = data.media.folder.replace(" Immediate-Media", "");
        let now = data.mission.end_time + 60001;
        assert!(validate(&data, now).is_err());
        data.media.root_folder_id = Some(1);
        assert!(validate(&data, now).is_ok());
        data.media.root_folder_id = Some(2);
        assert!(validate(&data, now).is_err());
        data.media.root_folder_id = Some(0);
        assert!(validate(&data, now).is_err());
        data.media.root_folder_id = Some(1);
        data.media.folder = data.media.folder.replace("2026-09-22", "2026-09-21");
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
            data_generation: None,
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
                chart: None,
                channels: HashMap::new(),
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
                root_folder_id: None,
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
    fn target_map_uses_only_high_temperature_targets_and_preserves_group_numbers() {
        let mut data = sample();
        let mut facts = Vec::new();
        for (second, label, target) in [
            (20, "最高温度: 80℃", None),
            (21, "", Some((119.0, 32.0))), // Auxiliary target cannot fill group 1.
            (30, "最低温度: 5℃", Some((119.1, 32.1))),
            (40, "最高温度: 90℃", Some((119.98, 32.42))),
            (41, "最高温度: 90℃", Some((119.98, 32.42))), // Same group/point once.
            (50, "最高温度: 85℃", Some((119.99, 32.43))),
        ] {
            data.photos.push(Photo {
                name: format!("DJI_202609220701{second}_0001_T.png"), kind: String::new(), data_url: PNG.into(),
                presentation: Some(presentation::Presentation {
                    method: "dji-viewer-capture-v1".into(), width: 1, height: 1, image_rect: None,
                    annotation_count: usize::from(!label.is_empty()), labels: if label.is_empty() { vec![] } else { vec![label.into()] },
                    captured_at: data.mission.end_time, data_url: None,
                }),
            });
            facts.push(evidence::PhotoFacts { longitude: Some(120.0), latitude: Some(33.0), laser_target: target, ..Default::default() });
        }
        let groups = high_temperature_groups(&data).unwrap();
        let photos = data.photos.iter().collect::<Vec<_>>();
        let points = high_temperature_points(&photos, &facts, &groups);
        assert_eq!(points, vec![(2,119.98,32.42),(3,119.99,32.43)]);
        let png = evidence::location_plot(&points).unwrap().unwrap();
        assert_eq!(image_dimensions(&png).unwrap(), (1000,650));
        for f in &mut facts { f.laser_target = None; }
        assert!(high_temperature_points(&photos, &facts, &groups).is_empty());
    }
    #[test]
    fn only_maximum_temperature_groups_are_reported_with_auxiliary_photos() {
        let mut bytes = vec![];
        {
            let mut encoder = png::Encoder::new(&mut bytes, 640, 480);
            encoder.set_color(png::ColorType::Grayscale);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(&vec![50; 640 * 480]).unwrap();
        }
        let image = format!("data:image/png;base64,{}", STANDARD.encode(bytes));
        let mut data = sample();
        for (name, labels) in [
            ("DJI_20260922070121_0001_T.png", vec!["最高温度: 76.7℃", "最低温度: -2.5℃"]),
            ("DJI_20260922070122_0001_V.png", vec![]),
            ("DJI_20260922070130_0002_T.png", vec!["最低温度: 5.3℃"]),
            ("DJI_20260922070131_0002_V.png", vec![]),
            ("DJI_20260922070140_0003_V.png", vec![]),
        ] {
            data.media.files.push(name.into());
            data.photos.push(Photo { name: name.into(), kind: "司空原始照片".into(), data_url: image.clone(),
                presentation: Some(presentation::Presentation {
                    method: "dji-viewer-capture-v1".into(), width: 640, height: 480, image_rect: None,
                    annotation_count: labels.len(), captured_at: data.mission.end_time,
                    data_url: (!labels.is_empty()).then(|| image.clone()),
                    labels: labels.into_iter().map(str::to_owned).collect(),
                }) });
        }
        let groups = high_temperature_groups(&data).unwrap();
        assert_eq!(groups, vec![data.media.files[..2].to_vec()]);
        let bytes = build_docx(&data, &[PNG.into(), PNG.into()], data.mission.end_time + 60000).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut doc = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        assert!(doc.contains("高温疑似问题1组"));
        assert!(doc.contains("发现异常情况1处"));
        assert!(!doc.contains("发现异常情况【】处"));
        assert!(doc.contains("最高温度: 76.7℃"));
        assert!(!doc.contains("最低温度:"));
        assert!(!doc.contains("同组辅助照片（不单独计为问题）"));
        assert!(!doc.contains("最高温度标注照片"));
        assert!(!doc.contains("表2第2组"));
        assert!(!doc.contains("rIdFlight1002"));
        assert!(!doc.contains("高温点坐标未取得"));
        assert!(!doc.contains("点位分布"));
        assert!(!doc.contains("rIdFlight20000"));
        assert!(doc.contains("<w:t>1-1</w:t>"));
        assert!(doc.contains("<w:t>1-2</w:t>"));
        assert!(!doc.contains("抓拍位置分布"));
        assert!(zip.by_name("word/media/high-temperature-targets.png").is_err());
    }
    #[test]
    fn auto_photo_description_uses_dji_thermal_labels_and_photo_coordinates() {
        let photo = Photo {
            name: "DJI_20260922070121_0001_T.png".into(),
            data_url: String::new(),
            kind: "司空原始照片".into(),
            presentation: Some(presentation::Presentation {
                method: "dji-viewer-capture-v1".into(),
                width: 640,
                height: 480,
                image_rect: None,
                annotation_count: 2,
                labels: vec!["最高温度: 76.7℃".into(), "最低温度: -2.5℃".into()],
                captured_at: 1,
                data_url: None,
            }),
        };
        let facts = evidence::PhotoFacts {
            longitude: Some(119.934438),
            latitude: Some(32.410257),
            image_type: "红外热成像".into(),
            relative_height: Some(105.0),
            hash: String::new(),
            laser_target: None,
        };
        let description = photo_auto_description(&photo, &facts);
        assert!(description.contains("照片坐标119.934438°E / 32.410257°N"));
        assert!(description.contains("红外高温点"));
        assert!(description.contains("最高温度: 76.7℃"));
        assert!(!description.contains("最低温度"));
        assert!(description.contains("热源性质待核实"));
    }
    #[test]
    fn template_summarizes_flight_and_analysis_uses_trigger_hour() {
        let mut data = sample();
        data.mission.mission_name = "钾离子超标巡查-20261103-10".into();
        data.evidence = Some(Evidence {
            trigger: "由人工手动发起".into(),
            event: Some(json!({"source":"auto","sourceHour":"2026-09-22 06:00:00"})),
            city_hours: vec![
                evidence::CityHour {time:"2026-09-22 04:00:00".into(),potassium:Some(0.4),pm25:Some(30.0),source_url:String::new(),synced_at:String::new()},
                evidence::CityHour {time:"2026-09-22 06:00:00".into(),potassium:None,pm25:Some(65.0),source_url:String::new(),synced_at:String::new()},
            ], ..Default::default()
        });
        let issued = data.mission.start_time + 86400000;
        let bytes = build_docx(&data, &[PNG.into(), PNG.into()], issued).unwrap();
        if let Ok(path) = std::env::var("TAIZHOU_REPORT_QA_SAMPLE") { fs::write(path, &bytes).unwrap(); }
        let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut doc = String::new();
        z.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc)
            .unwrap();
        assert_eq!(doc.matches("<w:tbl>").count(), 3);
        assert!(doc.contains("第202609220701期（泰智飞  第202609220701期）"));
        assert!(doc.contains("2026年09月22日06时"));
        assert!(doc.contains("本次任务由【钾离子超标巡查-20261103-10】触发，巡航时段为"));
        assert!(!doc.contains("由人工手动发起"));
        assert!(!doc.contains("触发原因待核实"));
        assert!(!doc.contains("00:00至"));
        let first_table = doc.split("<w:tbl>").nth(1).unwrap().split("</w:tbl>").next().unwrap();
        assert!(!first_table.contains("FF0000"));
        assert!(doc.contains("最高值"));
        assert!(doc.contains("平均值"));
        for value in [
            "最高值",
            "平均值",
            "65.0",
            "48.0",
            "未取得",
        ] {
            assert!(doc.contains(value), "missing observation: {value}");
        }
        assert!(!doc.contains("附录"));
        assert!(!doc.contains("{{"));
        assert!(doc.contains("生物质燃烧特征明显"));
        assert_eq!(
            fill_slots("{{VALUE}}", &[("VALUE", "<&> {{VALUE}}".into())]).unwrap(),
            "&lt;&amp;&gt; {{VALUE}}"
        );
    }
    #[test]
    fn docx_displays_configured_threshold_and_daily_process_fields() {
        let mut data = sample();
        data.evidence = Some(Evidence {
            flight_hour: Some("2026-11-03 02:00:00".into()),
            potassium_threshold: Some(1.5),
            city_hours: [1.4,2.0,2.1].into_iter().enumerate().map(|(h,k)| evidence::CityHour {
                time: format!("2026-11-03 {h:02}:00:00"), potassium: Some(k), pm25: Some(30.0),
                source_url: String::new(), synced_at: String::new(),
            }).collect(), ..Default::default()
        });
        let bytes = build_docx(&data, &[PNG.into(), PNG.into()], Utc::now().timestamp_millis()).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut doc = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        let mut reader = quick_xml::Reader::from_str(&doc);
        let mut text = String::new();
        loop {
            match reader.read_event().unwrap() {
                quick_xml::events::Event::Text(t) => text.push_str(t.as_ref()),
                quick_xml::events::Event::Eof => break,
                _ => (),
            }
        }
        assert!(text.contains("高于1.5微克/立方米的高值共2小时"));
        assert!(text.contains("主要集中在01点、02点时段"));
        assert!(text.contains("共出现2次明显高值过程，其中02点前后高值过程最为突出"));
    }
    #[test]
    fn zero_high_hours_omit_process_details_but_keep_fixed_ending() {
        for potassium in [Some(0.5), Some(1.2), None] {
            let mut data = sample();
            data.evidence = Some(Evidence {
                event: Some(json!({"source":"auto","sourceHour":"2026-09-22 06:00:00"})),
                city_hours: vec![evidence::CityHour {
                    time: "2026-09-22 06:00:00".into(), potassium, pm25: Some(30.0),
                    source_url: String::new(), synced_at: String::new(),
                }],
                ..Default::default()
            });
            let bytes = build_docx(&data, &[PNG.into(), PNG.into()], Utc::now().timestamp_millis()).unwrap();
            let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
            let mut doc = String::new();
            zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
            let mut reader = quick_xml::Reader::from_str(&doc);
            let mut text = String::new();
            loop {
                match reader.read_event().unwrap() {
                    quick_xml::events::Event::Text(t) => text.push_str(t.as_ref()),
                    quick_xml::events::Event::Eof => break,
                    _ => (),
                }
            }
            for clause in ["主要集中在", "次明显高值过程", "前后高值过程最为突出"] {
                assert_eq!(text.contains(clause), potassium != Some(0.5));
            }
            if potassium == Some(0.5) {
                assert!(text.contains("高值共0小时，K⁺峰值浓度达0.50"));
            }
            assert!(text.contains("生物质燃烧特征明显。为核实高值点位、锁定污染源头，依托无人机机库启动自动巡飞。"));
            assert!(!text.contains("{{"));
        }
    }
    #[test]
    fn table_one_uses_platform_coverage_and_photo_anomaly_groups() {
        let mut data = sample();
        data.evidence = Some(Evidence {
            dji_task: Some(DjiTask {
                task_id: Some("task-1".into()),
                media_folder_id: Some(1),
                planned_start_time: data.mission.start_time,
                actual_time_missing: false,
                task_type: Some("航线任务".into()),
                route_name: Some("东南侧巡查航线".into()),
                partial_reason: None,
                mission: data.mission.clone(),
                status: "执行成功".into(),
                media_ready: true,
                no_media: false,
                media_uploaded_count: 2,
                media_expected_count: 2,
            }),
            anomaly_count: Some(99), // Photo groups, rather than this legacy field, drive 表1.
            ..Default::default()
        });
        let bytes = build_docx(&data, &[PNG.into(), PNG.into()], Utc::now().timestamp_millis()).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut doc = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        assert!(doc.contains("东南侧巡查航线"));
        assert!(doc.contains("完整覆盖"));
        assert!(doc.contains("高温疑似问题0组"));
        assert!(!doc.contains("覆盖范围待核实"));
    }
    #[test]
    fn photo_review_count_matches_table_and_badge_for_seven_groups_and_zero() {
        let mut bytes = vec![];
        {
            let mut encoder = png::Encoder::new(&mut bytes, 640, 480);
            encoder.set_color(png::ColorType::Grayscale);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(&vec![50; 640 * 480]).unwrap();
        }
        let image = format!("data:image/png;base64,{}", STANDARD.encode(bytes));
        for expected in [0, 7] {
            let mut data = photo_only_sample();
            data.photos.clear();
            data.media.files.clear();
            for group in 0..7 {
                for auxiliary in 0..2 {
                    let name = format!("DJI_202609220701{:02}_0001_T.png", group * 5 + auxiliary);
                    let labels = if expected > 0 && auxiliary == 0 {
                        vec!["最高温度: 80℃".into()]
                    } else {
                        vec!["最低温度: 5℃".into()]
                    };
                    data.media.files.push(name.clone());
                    data.photos.push(Photo {
                        name, kind: String::new(), data_url: image.clone(),
                        presentation: Some(presentation::Presentation {
                            method: "dji-viewer-capture-v1".into(), width: 640, height: 480,
                            image_rect: None, annotation_count: 1, labels,
                            captured_at: data.mission.end_time, data_url: Some(image.clone()),
                        }),
                    });
                }
            }
            let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
            fs::create_dir_all(&root).unwrap();
            let summary = persist(&root, &data, &[String::new(), String::new()], false).unwrap();
            assert_eq!(summary.photo_count, 14);
            assert_eq!(summary.issue_count, Some(expected));
            let mut zip = zip::ZipArchive::new(Cursor::new(fs::read(&summary.path).unwrap())).unwrap();
            let mut doc = String::new();
            zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
            assert!(doc.contains(&format!("发现异常情况{expected}处")));
            assert!(doc.contains(&format!("高温疑似问题{expected}组")));
            assert!(!doc.contains("发现异常情况【】处"));
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn closing_keeps_fixed_signatories_and_uses_beijing_flight_date() {
        let data = sample(); // 09-21 UTC is already 09-22 in Beijing.
        let issued = data.mission.start_time + 2 * 86400000;
        let bytes = build_docx(&data, &[PNG.into(), PNG.into()], issued).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut doc = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        let closing = doc.rsplit("江苏省泰州环境监测中心").next().unwrap();
        assert!(closing.contains("2026年9月22日"));
        assert!(!closing.contains("2026年9月24日"));
        assert!(closing.contains("分送：第一专员办泰州监察室、泰州市生态环境局。"));
        assert!(closing.contains("签发：宋兴伟　审核：杨文武　编制：朱俊、彭婷、毛慧、王玉祥、赵美玲"));
        assert!(!doc.contains("{{FLIGHT_DATE}}"));
    }
    #[test]
    fn standard_template_preserves_editorial_text() {
        for without_air in [false, true] {
            let mut data = if without_air { photo_only_sample() } else { sample() };
            data.evidence = Some(Evidence { conclusion: "人工结论<&> {{CITY_PM_START}}".into(), recommendation: "人工建议".into(), ..Default::default() });
            let bytes = build_docx(&data, &[PNG.into(), PNG.into()], Utc::now().timestamp_millis()).unwrap();
            let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
            let mut doc = String::new();
            z.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
            assert!(doc.contains("人工结论&lt;&amp;&gt; {{CITY_PM_START}}"));
            assert!(!doc.contains("人工建议"));
            for text in ["（一）综合结论", "（二）工作建议", "一是强化重点区域和重点时段精准管控。", "二是深化空地一体化智能巡查。", "三是广泛宣传，深化网格源头治理。", "四是预警联动，健全长效防控体系。"] {
                assert!(doc.contains(text), "missing approved advice: {text}");
            }
            assert!(!doc.contains("2026年5月21日"));
            for required in ["近期监测显示", "为核实高值点位、锁定污染源头", "覆盖范围待核实", "高温疑似问题0组"] {
                assert!(doc.contains(required), "missing restored content: {required}");
            }
            assert_eq!(doc.contains("实际执飞时段内PM2.5最高值"), !without_air);
        }
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
            chart: None,
            channels: HashMap::new(),
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
        data.media.files.push("DJI_20260922070105_0001.JPG".into());
        assert!(validate(&data, i64::MAX).is_err()); // Missing photo export still blocks.
        data = photo_only_sample();
        assert!(validate(&data, data.mission.end_time).is_err());
    }
    #[test]
    fn photo_only_docx_keeps_blank_air_slots_and_independent_history() {
        let data = photo_only_sample();
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let first = persist(&root, &data, &[String::new(), String::new()], false).unwrap();
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
        assert!(doc.contains("空气五参数监测数据"));
        assert!(doc.contains("<w:tblGrid>"));
        assert!(!doc.contains("巡飞监测记录"));
        assert_eq!(
            persist(&root, &data, &[String::new(), String::new()], false)
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
                false
            )
            .unwrap()
            .id,
            first.id
        );
        assert_eq!(read_summaries(&root).unwrap().len(), 2);
        let mut local = data.clone();
        local.local_event_id = Some(Uuid::new_v4().to_string());
        let saved = persist(&root, &local, &[String::new(), String::new()], false).unwrap();
        local.mission.mission_name = "更新显示名称".into();
        assert_eq!(
            persist(&root, &local, &[String::new(), String::new()], false)
                .unwrap()
                .id,
            saved.id
        );
        assert_eq!(read_summaries(&root).unwrap().len(), 3);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn issue_number_uses_beijing_flight_minute() {
        let utc = DateTime::parse_from_rfc3339("2026-12-31T16:02:59Z").unwrap().timestamp_millis();
        assert_eq!(flight_issue_number(utc).unwrap(), 202701010002);
        assert_eq!(flight_issue_number(utc - 59000).unwrap(), 202701010002);
        assert!(flight_issue_number(i64::MAX).is_err());
    }
    #[test]
    fn regeneration_replaces_legacy_issue_counter() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let data = photo_only_sample();
        let charts = [String::new(), String::new()];
        let mut old = persist(&root, &data, &charts, false).unwrap();
        assert_eq!(old.issue_number, Some(202609220701));
        old.issue_number = Some(2);
        fs::write(root.join(&old.id).join("summary.json"), serde_json::to_vec(&old).unwrap()).unwrap();
        let new = persist(&root, &data, &charts, true).unwrap();
        assert_eq!(new.issue_number, Some(202609220701));
        let settings: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join(&new.id).join("report-settings.json")).unwrap()).unwrap();
        assert_eq!(settings["issueNumber"], 202609220701_u64);
        let mut archive = zip::ZipArchive::new(Cursor::new(fs::read(&new.path).unwrap())).unwrap();
        let mut doc = String::new();
        archive.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        assert!(doc.contains("第202609220701期（泰智飞  第202609220701期）"));
        assert_eq!(persist(&root, &data, &charts, true).unwrap().issue_number, new.issue_number);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn regeneration_saves_new_data_and_keeps_previous_files() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let data = sample();
        let old = persist(&root, &data, &[PNG.into(), PNG.into()], false).unwrap();
        let old_bytes = fs::read(&old.path).unwrap();
        let mut updated = data.clone();
        updated.air.points[0].pm25 = Some(99.0);
        let new = persist(&root, &updated, &[PNG.into(), PNG.into()], true).unwrap();
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
            persist(&root, &updated, &[PNG.into(), PNG.into()], false)
                .unwrap()
                .id,
            new.id
        );
        assert!(persist(&root, &updated, &[String::new(), String::new()], true).is_err());
        assert_eq!(read_summaries(&root).unwrap()[0].id, new.id);
        let mut blank = photo_only_sample();
        blank.local_event_id = Some(Uuid::new_v4().to_string());
        let before = persist(&root, &blank, &[String::new(), String::new()], false).unwrap();
        let after = persist(&root, &blank, &[String::new(), String::new()], true).unwrap();
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
            chart: None,
            channels: HashMap::new(),
            url: String::new(),
            mission_id: 0,
            unit: String::new(),
            points: vec![],
        };
        let old = persist(
            &root,
            &partial,
            &[String::new(), String::new()],
            false,
        )
        .unwrap();
        let upgrade = persist(&root, &full, &[PNG.into(), PNG.into()], true).unwrap();
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
        let revision = persist(&root, &full, &[PNG.into(), PNG.into()], true).unwrap();
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
        let a = persist(&root, &d, &[PNG.into(), PNG.into()], false).unwrap();
        let b = persist(&root, &d, &[PNG.into(), PNG.into()], false).unwrap();
        assert_eq!(a.path, b.path);
        assert_eq!(a.air_url, d.air.url);
        assert_eq!(a.media_url, d.media.url);
        assert_eq!(read_summaries(&root).unwrap().len(), 1);
        let mut another = d.clone();
        another.mission.mission_id = 2;
        another.air.mission_id = 2;
        let c = persist(&root, &another, &[PNG.into(), PNG.into()], false).unwrap();
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
        let old = persist(&root, &data, &[PNG.into(), PNG.into()], false).unwrap();
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
            persist(&root, &data, &[PNG.into(), PNG.into()], false)
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
                    persist(&root, &sample(), &[PNG.into(), PNG.into()], false)
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
    fn statistics_only_use_actual_flight_including_boundaries_zero_and_low_values() {
        let mut d = sample();
        let start = d.mission.start_time;
        let end = d.mission.end_time;
        d.air.points = [(end + 1, Some(999.0)), (start - 1, Some(888.0)),
            (end, Some(60.0)), (start, Some(0.0)), (start + 1, Some(30.0)),
            (start + 2, None), (start + 3, Some(60.0))].into_iter()
            .map(|(time, pm25)| Point { time, pm25, longitude:Some(119.0), latitude:Some(32.0) }).collect();
        let stats = validate(&d, i64::MAX).unwrap().unwrap();
        assert_eq!((stats.max, stats.mean, stats.count, stats.missing), (60.0, 37.5, 4, 1));
        assert_eq!(stats.peak_time, start + 3); // first tied peak, independent of source order
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let saved = persist(&root, &d, &[PNG.into(),PNG.into()], false).unwrap();
        let dir = root.join(&saved.id);
        let settings: Value = serde_json::from_slice(&fs::read(dir.join("report-settings.json")).unwrap()).unwrap();
        assert_eq!(settings["pm25Mean"], 37.5);
        assert_eq!(settings["flightPointCount"], 5);
        assert_eq!(settings["rawPointCount"], 7);
        assert!(settings.get("pm25Threshold").is_none());
        let csv = fs::read_to_string(dir.join("air-quality.csv")).unwrap();
        assert_eq!(csv.lines().skip(1).filter(|line| line.ends_with(",true")).count(),5);
        assert_eq!(csv.lines().count(),8);
        fs::remove_dir_all(root).unwrap();
        d.air.points.retain(|p| !during_flight(&d.mission,p));
        assert!(validate(&d,i64::MAX).unwrap_err().contains("实际执飞时段内没有有效"));
        d.air.points[0].time = start;
        d.air.points[0].pm25 = None;
        assert!(validate(&d,i64::MAX).is_err());
        d.air.points[0].pm25 = Some(0.0);
        let stats = validate(&d,i64::MAX).unwrap().unwrap();
        assert_eq!((stats.max,stats.mean),(0.0,0.0));
    }
    #[test]
    fn air_peak_records_keep_simultaneous_values_coordinates_and_bold_only_selected_metric() {
        let mut d = sample();
        let start = d.mission.start_time;
        d.air.points = (0..8).map(|i| Point {
            time: if i == 7 { d.mission.end_time + 1 } else if i == 6 { start } else { start + (i + 1) * 1000 },
            pm25: Some(if i == 7 { 999.0 } else if i == 0 || i == 6 { 100.0 } else { i as f64 }),
            longitude: Some(119.0 + i as f64 / 100.0), latitude: Some(32.0),
        }).collect();
        for (metric, name) in AIR_METRICS.iter().enumerate().skip(1) {
            let (source, unit, _) = channel_spec(name).unwrap();
            d.air.channels.insert((*name).into(), AirChannel {
                source_channel: source.into(), unit: unit.into(),
                values: (0..8).map(|i| Some(if i == 7 { 999.0 } else if i == metric { 100.0 } else { i as f64 })).collect(),
            });
        }
        // The tied PM2.5 maximum occurs earlier in time at the later array index.
        let peaks = air_peak_indices(&d);
        assert_eq!(peaks, [Some(6), Some(1), Some(2), Some(3), Some(4)]);
        let rows = air_peak_rows(&d, &peaks);
        assert_eq!(&rows[0][1..5], &[date(start, "%m-%d %H:%M:%S"), "119.060000°E / 32.000000°N".into(), "100.0".into(), "6.0".into()]);
        assert_eq!(&rows[1][3..5], &["1.0", "100.0"]);
        let bytes = build_docx(&d, &[PNG.into(), PNG.into()], d.mission.end_time + 60000).unwrap();
        if let Ok(path) = std::env::var("TAIZHOU_AIR_PEAK_QA_DOCX") { fs::write(path, &bytes).unwrap(); }
        let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut doc = String::new(); z.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        let table = doc.split("<w:tbl>").nth(3).unwrap().split("</w:tbl>").next().unwrap();
        let output_rows: Vec<_> = table.split("</w:tr>").collect();
        assert_eq!(output_rows.len(), 7); // header + five data rows + trailing text
        for row in 0..5 {
            let cells: Vec<_> = output_rows[row + 1].split("<w:tc>").skip(1).collect();
            for col in 3..8 { assert_eq!(cells[col].contains("<w:b/>"), col == row + 3); }
        }
        d.air.points[6].longitude = None;
        d.air.points[1].pm25 = None;
        d.air.channels.get_mut("no2").unwrap().values.fill(Some(0.0));
        d.air.channels.get_mut("co").unwrap().values.fill(None);
        d.air.channels.remove("so2");
        let peaks = air_peak_indices(&d);
        assert_eq!(peaks[3], Some(6)); // zero is valid, tied maxima use earliest time
        let rows = air_peak_rows(&d, &peaks);
        assert_eq!(rows[0][2], "【 】");
        assert_eq!(rows[1][3], "缺测");
        assert_eq!(rows[2][5], "未取得");
        assert_eq!(rows[4][7], "缺测");
        assert_eq!(rows[3][6], "0.0");
        d.without_air_data = true;
        assert!(air_peak_rows(&d, &air_peak_indices(&d)).iter().flatten().all(|v| v == "【 】"));
    }
    #[test]
    fn channel_alignment_units_missing_and_zero_are_preserved() {
        let mut d = sample();
        d.air.points[0].pm25 = Some(60.0);
        d.air.points.swap(0,1); // channels are in original source order
        d.air.channels.insert("no2".into(), AirChannel { source_channel:"ad_6".into(), unit:"ppm".into(), values:vec![Some(0.05), Some(0.0)] });
        d.air.channels.insert("so2".into(), AirChannel { source_channel:"ad_4".into(), unit:"ppm".into(), values:vec![None, Some(0.014)] });
        assert!(validate(&d,i64::MAX).is_ok());
        assert!((air_value(&d.air,"no2",0).unwrap()-90.5708661417).abs()<1e-8);
        assert_eq!(air_cell(&d.air,"no2",1),"0.0");
        assert_eq!(air_cell(&d.air,"so2",0),"缺测");
        assert_eq!(air_cell(&d.air,"o3",0),"未取得");
        let b=build_docx(&d,&[PNG.into(),PNG.into()],Utc::now().timestamp_millis()).unwrap();
        let mut z=zip::ZipArchive::new(Cursor::new(b)).unwrap();
        let mut xml=String::new();z.by_name("word/document.xml").unwrap().read_to_string(&mut xml).unwrap();
        let table=xml.split("<w:tbl>").nth(3).unwrap().split("</w:tbl>").next().unwrap();
        let rows:Vec<_>=table.split("</w:tr>").collect();
        assert!(rows[1].contains("65.0")&&rows[1].contains("缺测")&&rows[1].contains("90.6"));
        assert!(rows[2].contains("未取得"));
        assert!(rows[3].contains("60.0") && rows[3].contains("35.3") && rows[3].contains("0.0"));
        d.air.points[0].time = d.mission.end_time + 1;
        assert_eq!(channel_stat(&d,"no2",false),"0.0");
        assert_eq!(channel_stat(&d,"no2",true),"0.0");
        assert_eq!(channel_stat(&d,"so2",false),"35.3");
        d.air.channels.get_mut("so2").unwrap().values[1] = None;
        assert_eq!(channel_stat(&d,"so2",false),"缺测");
        assert_eq!(channel_stat(&d,"o3",false),"未取得");
        d.air.channels.get_mut("no2").unwrap().values.pop();
        assert!(validate(&d,i64::MAX).is_err());
        d.air.channels.get_mut("no2").unwrap().values.push(Some(0.0));
        d.air.channels.get_mut("no2").unwrap().unit="μg/m³".into();
        assert!(validate(&d,i64::MAX).is_err());
        d.air.channels.remove("no2");
        d.air.channels.insert("o3".into(),AirChannel{source_channel:"ad_7".into(),unit:"ppm".into(),values:vec![Some(0.0);2]});
        assert!(validate(&d,i64::MAX).is_err());
    }
    #[test]
    #[ignore = "requires an archived report source for target-map visual QA"]
    fn renders_archived_high_temperature_map() {
        let input = std::env::var("TAIZHOU_TARGET_MAP_INPUT").unwrap();
        let output = std::env::var("TAIZHOU_TARGET_MAP_OUTPUT").unwrap();
        let data: Collected = serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
        let photos = data.photos.iter().collect::<Vec<_>>();
        let facts = photos.iter().map(|p| evidence::photo_facts(&decode_image(&p.data_url).unwrap().0)).collect::<Vec<_>>();
        let groups = high_temperature_groups(&data).unwrap();
        let points = high_temperature_points(&photos, &facts, &groups);
        fs::write(output, evidence::location_plot(&points).unwrap().unwrap()).unwrap();
        println!("{} photos, {} high-temperature groups, {} target points: {:?}", photos.len(), groups.len(), points.len(), points);
    }
    #[test]
    #[ignore = "requires explicit local live-report fixture"]
    fn renders_live_fixture_when_explicitly_supplied() {
        if let Ok(path) = std::env::var("TAIZHOU_REPORT_QA_INPUT") {
            let v: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            let mut d: Collected = serde_json::from_value(v["data"].clone()).unwrap();
            if let Ok(db_path) = std::env::var("TAIZHOU_REPORT_QA_DB") {
                let db = crate::monitoring::connect(Path::new(&db_path)).unwrap();
                let review_path=PathBuf::from(std::env::var("TAIZHOU_REPORT_QA_REVIEWS").unwrap_or_default());
                d.evidence=Some(evidence::snapshot(&db,&d,&review_path,Utc::now().timestamp_millis()).unwrap());
            }
            let charts: [String; 2] = serde_json::from_value(v["charts"].clone()).unwrap();
            let root = PathBuf::from(std::env::var("TAIZHOU_REPORT_QA_DIR").unwrap());
            fs::create_dir_all(&root).unwrap();
            let s = persist(&root, &d, &charts, v["regenerate"].as_bool().unwrap_or(false)).unwrap();
            println!("QA report: {}", s.path);
        }
    }
}
