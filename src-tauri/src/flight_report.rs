//! Post-flight reports: fixed browser adapters, validated task data, native DOCX output.
use crate::{bridge::Bridge, monitoring::database};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, FixedOffset, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use rusqlite::params;
use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

mod evidence;
use evidence::{Evidence, photo_facts};

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
    pub without_air_data: bool,
    #[serde(default)]
    pub local_event_id: Option<String>,
    pub dji_session: String,
    pub dji_tab_id: i64,
    pub sniff_session: Option<String>,
    pub sniff_tab_id: Option<i64>,
    pub mission: Mission,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    #[serde(default)]
    pub without_air_data: bool,
    #[serde(default)]
    pub local_event_id: Option<String>,
    pub id: String,
    pub created_at: i64,
    pub title: String,
    pub path: String,
    pub photo_count: usize,
    pub point_count: usize,
    pub warning: String,
    #[serde(default)]
    pub mission: Option<Mission>,
    #[serde(default)]
    pub air_url: String,
    #[serde(default)]
    pub media_url: String,
}
const REASONS: &[&str] = &["dji_scheduled", "potassium_manual", "potassium_auto", "manual_immediate"];

fn list_reasons(db: &rusqlite::Connection) -> Result<HashMap<String, String>, String> {
    let mut statement = db.prepare("SELECT mission_id, reason FROM flight_mission_reasons").map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
    rows.map(|row| row.map(|(id, reason)| (id.to_string(), reason)).map_err(|e| e.to_string())).collect()
}

fn set_reason(db: &rusqlite::Connection, mission_id: u64, reason: &str) -> Result<(), String> {
    if mission_id == 0 || mission_id > i64::MAX as u64 || (!reason.is_empty() && !REASONS.contains(&reason)) {
        return Err("任务原因或编号无效。".into());
    }
    if reason.is_empty() {
        db.execute("DELETE FROM flight_mission_reasons WHERE mission_id=?1", [mission_id]).map_err(|e| e.to_string())?;
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
pub fn set_flight_reason(app: tauri::AppHandle, mission_id: u64, reason: String) -> Result<(), String> {
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
fn photo_time(name: &str) -> Result<i64, String> {
    if !name.starts_with("DJI_") || name.len() > 200 || name.contains(['/', '\\']) {
        return Err("照片名称无效".into());
    }
    let stamp = name.get(4..18).ok_or("照片缺少拍摄时间")?;
    let t = NaiveDateTime::parse_from_str(stamp, "%Y%m%d%H%M%S").map_err(|_| "照片拍摄时间无效")?;
    Ok(t.and_utc().timestamp_millis() - 8 * 3600000)
}
fn validate(data: &Collected, now: i64) -> Result<Option<Stats>, String> {
    if data.without_air_data {
        if !data.air.points.is_empty() || !data.air.url.is_empty() || data.air.mission_id != 0 || !data.air.unit.is_empty() {
            return Err("无可飞数据模式不能包含可飞采样资料。".into());
        }
    } else {
        source(&data.air.url, false)?;
    }
    source(&data.media.url, true)?;
    let m = &data.mission;
    if (!data.without_air_data && (m.mission_id == 0 || m.mission_id != data.air.mission_id))
        || data.local_event_id.as_ref().is_some_and(|id| Uuid::parse_str(id).is_err())
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
    if !data.without_air_data && (data.air.unit != "μg/m³" || data.air.points.len() < 2 || data.air.points.len() > 20000) {
        return Err("PM2.5 单位不符或采样数据不完整。".into());
    }
    if !data.media.folder.trim_end().ends_with("Immediate-Media")
        || data.media.files.len() > 20
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
    if folder_time.is_none_or(|t| {
        (t.and_utc().timestamp_millis() - 8 * 3600000 - m.start_time).abs() > 300000
    }) {
        return Err("司空任务文件夹时间与本次飞行不匹配或无法核对。".into());
    }
    if data.without_air_data { return Ok(None); }
    let mut seen = std::collections::HashSet::new();
    let mut values = vec![];
    let mut coords = 0;
    for p in &data.air.points {
        if p.time < m.start_time - 60000 || p.time > m.end_time + 60000 || !seen.insert(p.time) {
            return Err("可飞采样时间越界或重复，无法生成可靠快报。".into());
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
    crate::readiness::require_started(&app)?;
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
#[tauri::command]
pub async fn collect_flight_report(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Bridge>,
    request: CollectRequest,
) -> Result<Collected, String> {
    if request.without_air_data {
        crate::readiness::require_report_media(&app)?;
    } else {
        crate::readiness::require_started(&app)?;
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
                req.sniff_session.ok_or("请选择可飞页面")?,
                req.sniff_tab_id.ok_or("请选择可飞页面")?,
                json!({"type":"flight-airins","missionId":req.mission.mission_id}),
            )
            .await?,
    )
    .map_err(|e| format!("可飞格式错误：{e}"))? };
    let media_value = bridge
        .request(
            req.dji_session.clone(),
            req.dji_tab_id,
            json!({"type":"flight-dji-list","startTime":req.mission.start_time,"endTime":req.mission.end_time}),
        )
        .await?;
    if media_value["matchedStartTime"].as_i64() != Some(req.mission.start_time) {
        return Err("浏览器插件尚不支持按时间自动匹配，请更新并重新加载插件后重试。".into());
    }
    let media: Media = serde_json::from_value(media_value)
        .map_err(|e| format!("司空格式错误：{e}"))?;
    if !req.without_air_data { source(&air.url, false)?; }
    source(&media.url, true)?;
    let mut photos = vec![];
    for name in &media.files {
        let t = photo_time(name)?;
        if t < req.mission.start_time - 300000 || t > req.mission.end_time + 300000 {
            return Err("照片不属于本次飞行，已停止采集。".into());
        }
        let v = bridge
            .request(
                req.dji_session.clone(),
                req.dji_tab_id,
                json!({"type":"flight-dji-image","name":name}),
            )
            .await?;
        if v["url"] != media.url || v["folder"] != media.folder || v["name"] != *name {
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
        let value = fields.iter().find(|(name, _)| *name == key).ok_or_else(|| format!("模板字段未填写：{key}"))?;
        out.push_str(&xml(&value.1));
        rest = &rest[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}
fn fill_table(doc: &mut String, index: usize, rows: &[Vec<String>]) -> Result<(), String> {
    let token = format!("{{{{T{index}_0}}}}");
    let pos = doc.find(&token).ok_or("模板表格行缺失")?;
    let start = doc[..pos].rfind("<w:tr>").max(doc[..pos].rfind("<w:tr ")).ok_or("模板行起点缺失")?;
    let end = pos + doc[pos..].find("</w:tr>").ok_or("模板行终点缺失")? + 7;
    let row_template = &doc[start..end];
    let mut filled = String::new();
    for row in rows {
        let fields: Vec<_> = row.iter().enumerate().map(|(col, value)| (format!("T{index}_{col}"), value.clone())).collect();
        let fields: Vec<_> = fields.iter().map(|(key, value)| (key.as_str(), value.clone())).collect();
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
fn build_docx(data: &Collected, charts: &[String; 2], issued: i64, pm25_threshold: f64) -> Result<Vec<u8>, String> {
    if !pm25_threshold.is_finite() || pm25_threshold <= 0.0 {
        return Err("PM2.5 报告阈值必须大于 0。".into());
    }
    let stats = validate(data, issued)?;
    // These remain collection inputs, but the reference has a nine-column
    // observation table, not extra chart sections or a photo appendix.
    if !data.without_air_data {
        for chart in charts { decode_image(chart)?; }
    }
    let mut src = zip::ZipArchive::new(Cursor::new(TEMPLATE)).map_err(|e| e.to_string())?;
    let mut parts = std::collections::BTreeMap::new();
    for i in 0..src.len() {
        let mut f = src.by_index(i).map_err(|e| e.to_string())?;
        let mut b = vec![];
        f.read_to_end(&mut b).map_err(|e| e.to_string())?;
        parts.insert(f.name().to_owned(), b);
    }
    let mut doc = String::from_utf8(parts.remove("word/document.xml").ok_or("模板正文缺失")?).map_err(|e| e.to_string())?;
    let caption = String::from_utf8(parts.remove("word/report-caption.xml").ok_or("模板图注缺失")?).map_err(|e| e.to_string())?;
    let caption = &caption[caption.find("<w:p ").ok_or("图注段落缺失")?..];
    let caption_for = |text: String| fill_slots(caption, &[("CAPTION", text)]);
    let m = &data.mission;
    let flight_window = format!("{}～{}", date(m.start_time, "%Y年%m月%d日%H时%M分"), date(m.end_time, "%Y年%m月%d日%H时%M分"));
    let table_window = if date(m.start_time, "%Y%m%d") == date(m.end_time, "%Y%m%d") {
        format!("{}～{}", date(m.start_time, "%H:%M"), date(m.end_time, "%H:%M"))
    } else {
        format!("{}～{}", date(m.start_time, "%m-%d %H:%M"), date(m.end_time, "%m-%d %H:%M"))
    };
    let mut photos: Vec<_> = data.photos.iter().collect();
    photos.sort_by_key(|p| photo_time(&p.name).unwrap_or_default());
    let facts=photos.iter().map(|p| decode_image(&p.data_url).map(|(b,_)|photo_facts(&b))).collect::<Result<Vec<_>,_>>()?;
    let fallback=Evidence {captured_at:issued,..Default::default()};
    let evidence=data.evidence.as_ref().unwrap_or(&fallback);
    let reviewed=facts.iter().filter(|f|evidence.reviews.contains_key(&f.hash)).count();
    let visible=facts.iter().filter(|f|f.image_type.starts_with("可见光")).count();
    let infrared=facts.iter().filter(|f|f.image_type=="红外热成像").count();
    let count = photos.len().to_string();
    let blank = "【 】".to_owned();
    let mut fields = vec![
        ("ISSUE", blank.clone()), ("SERIES_ISSUE", blank.clone()),
        ("ISSUED", date(issued, "%Y年%-m月%-d日")),
        ("ANALYSIS_WINDOW", format!("{}00:00至{}（北京时间）", date(issued, "%Y年%m月%d日"), date(issued, "%H:%M"))),
        ("FLIGHT_WINDOW", flight_window.clone()), ("PHOTO_COUNT", count.clone()),
        ("TOTAL0_1", "本航次".into()), ("TOTAL0_2", table_window),
        ("TOTAL0_3", "范围待核实".into()), ("TOTAL0_4", format!("{count}张")), ("TOTAL0_5", if reviewed>0 {"见表2初判".into()} else {"待判读".into()}),
        ("TOTAL1_1", match (photos.first(), photos.last()) {
            (Some(a), Some(b)) => format!("{}～{}", date(photo_time(&a.name)?, "%m-%d %H:%M"), date(photo_time(&b.name)?, "%m-%d %H:%M")),
            _ => blank.clone(),
        }),
        ("TOTAL1_2", "本航次抓拍点".into()), ("TOTAL1_3", "—".into()),
        ("TOTAL1_4", format!("可见光{visible}张，红外{infrared}张")), ("TOTAL1_5", format!("共{count}张")), ("TOTAL1_6", format!("已初判{reviewed}张，待复核")),
    ];
    fields.extend(evidence.city_fields());
    fields.push(("TRIGGER",if evidence.trigger.is_empty(){"触发原因待核实".into()}else{evidence.trigger.clone()}));
    fields.push(("PHOTO_REVIEW_SUMMARY",format!("含可见光{visible}张、红外{infrared}张；{}异常事件数量尚未经现场核实。表中坐标为照片EXIF记录的WGS-84拍摄位置，不是污染源坐标",if reviewed>0 {format!("已完成{reviewed}张影像的AI辅助初判，结果需人工复核；")}else{"尚未完成影像判读；".into()})));
    // Known capture positions are point records, not invented route segments.
    let execution=photos.iter().zip(&facts).enumerate().map(|(i,(p,f))|Ok(vec![
        (i+1).to_string(),format!("抓拍点{}",i+1),date(photo_time(&p.name)?,"%H:%M:%S"),"已抓拍；范围待核实".into(),"1张".into(),
        if evidence.reviews.contains_key(&f.hash){"见表2初判".into()}else{"待判读".into()},
    ])).collect::<Result<Vec<_>,String>>()?;
    fill_table(&mut doc,0,&if execution.is_empty(){vec![vec!["未取得".into();6]]}else{execution})?;
    let rows: Vec<_> = photos.iter().zip(&facts).enumerate().map(|(i,(p,f))| Ok(vec![
        (i+1).to_string(), date(photo_time(&p.name)?, "%m-%d %H:%M:%S"),format!("抓拍点{}",i+1),
        match(f.longitude,f.latitude){(Some(lon),Some(lat))=>format!("{:.6}°{} / {:.6}°{}",lon.abs(),if lon<0.0 {"W"}else{"E"},lat.abs(),if lat<0.0 {"S"}else{"N"}),_=>"照片无有效GPS".into()},f.image_type.clone(),
        evidence.reviews.get(&f.hash).map(|r|r.description.clone()).unwrap_or_else(||f.relative_height.map(|h|format!("相对高度{h:.2}米；场景待判读")).unwrap_or_else(||"场景待判读".into())),
        evidence.reviews.get(&f.hash).map(|r|r.result.clone()).unwrap_or_else(||"未判读".into()),
    ])).collect::<Result<_, String>>()?;
    fill_table(&mut doc, 1, &if rows.is_empty() { vec![vec!["未取得".into(); 7]] } else { rows })?;
    let mut points: Vec<_> = data.air.points.iter().collect();
    points.sort_by_key(|p| p.time);
    let air_rows: Vec<_> = points.iter().enumerate().map(|(i, p)| vec![
        (i+1).to_string(), date(p.time, "%m-%d %H:%M:%S"),
        match (p.longitude, p.latitude) { (Some(lon), Some(lat)) => format!("{lon:.6} / {lat:.6}"), _ => "缺测".into() },
        p.pm25.map(|v| format!("{v:.1}")).unwrap_or_else(|| "缺测".into()),
        "未取得".into(), "未取得".into(), "未取得".into(), "未取得".into(), "未取得".into(),
    ]).collect();
    fill_table(&mut doc, 2, &if data.without_air_data { vec![vec![blank.clone(); 9]; 4] } else { air_rows })?;
    let above = points.iter().filter(|p| p.pm25.is_some_and(|v| v > pm25_threshold)).count();
    let warning = if stats.as_ref().is_some_and(|s| s.max == 0.0) {
        "本航次 PM2.5 有效数值全部为 0，请核查传感器状态；不能据此判断空气质量良好。"
    } else { "" };
    fields.push(("AIR_INTRO", if data.without_air_data { String::new() } else {
        "本次巡航无人机搭载可飞科技“灵嗅”高精度气体传感器，空气六参数监测数据经可飞平台实时回传并生成监测成果。巡航期间六参数监测数据如下（数据来源：可飞平台）：".into()
    }));
    fields.push(("CONCLUSION", if !evidence.conclusion.is_empty() {evidence.conclusion.clone()} else if let Some(s) = &stats {
        format!("本次巡航抓拍图片{count}张，影像异常及污染成因待判读、核实。PM2.5有效采样{}点、缺测{}点，浓度范围{:.1}～{:.1} μg/m³，采样算术平均值{:.1} μg/m³，峰值时间{}。本报告PM2.5判定阈值为 {} μg/m³，严格大于阈值的采样点 {} 个。{}", s.count, s.missing, s.min, s.max, s.mean, date(s.peak_time, "%m-%d %H:%M:%S"), pm25_threshold, above, warning)
    } else { blank.clone() }));
    // Use only explicit, flight-bound editorial input for recommendations.
    fields.push(("RECOMMENDATION", if evidence.recommendation.is_empty(){blank.clone()}else{evidence.recommendation.clone()}));
    let mut rels = String::from_utf8(parts.remove("word/_rels/document.xml.rels").ok_or("模板关系缺失")?).map_err(|e| e.to_string())?;
    let mut types = String::from_utf8(parts.remove("[Content_Types].xml").ok_or("模板类型缺失")?).map_err(|e| e.to_string())?;
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
            types = types.replace("</Types>", &format!("<Default Extension=\"{ext}\" ContentType=\"image/{ext}\"/></Types>"));
        }
        let scale = (5500000.0 / width as f64).min(3200000.0 / height as f64);
        let img = image_xml(id, (width as f64 * scale) as i64, (height as f64 * scale) as i64)
            .replace("name=\"image\"", &format!("name=\"{}\"", xml(&p.name)));
        if i == 0 {
            section_xml.push_str(&image_xml(id + 10000, (width as f64 * scale) as i64, (height as f64 * scale) as i64).replace(&format!("rIdFlight{}", id + 10000), &format!("rIdFlight{id}")));
            section_xml.push_str(&caption_for("图1　巡航现场照片（抓拍点1，对应表2序号1）".into())?);

        }
        photo_xml.push_str(&img);
        photo_xml.push_str(&caption_for(format!("图{}　大疆司空平台抓拍图片（表2序号{}，{}）", i+3, i+1, date(photo_time(&p.name)?, "%m-%d %H:%M:%S")))?);
    }
    if let Some(map)=evidence::location_plot(&facts)? {
        parts.insert("word/media/capture-locations.png".into(),map);
        rels=rels.replace("</Relationships>","<Relationship Id=\"rIdFlight20000\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/capture-locations.png\"/></Relationships>");
        if !types.contains("Extension=\"png\""){types=types.replace("</Types>","<Default Extension=\"png\" ContentType=\"image/png\"/></Types>");}
        section_xml.push_str(&image_xml(20000,5500000,3575000));
        section_xml.push_str(&caption_for("图2　抓拍位置分布（WGS-84；数字对应表2序号；离散拍摄点，非完整航迹或目标位置）".into())?);
    } else if !photos.is_empty(){ section_xml.push_str(&caption_for("图2　位置图未取得（照片无有效GPS）".into())?); }
    if photos.is_empty() {
        section_xml = caption_for("巡航现场照片及对应位置图【待补】".into())?;
        photo_xml = caption_for("本航次无照片。".into())?;
    }
    // Fill global fields before adding user-derived table/figure content; no
    // arbitrary strings are used as XML, and absent fields keep editable blanks.
    // Tables are already filled, so user data containing braces is protected by
    // limiting this pass to the named global slots.
    for (key, value) in fields { doc = doc.replace(&format!("{{{{{key}}}}}"), &xml(&value)); }
    block(&mut doc, "SECTION_PHOTOS", &section_xml)?;
    block(&mut doc, "PHOTOS", &photo_xml)?;
    parts.insert("word/document.xml".into(), doc.into_bytes());
    parts.insert("word/_rels/document.xml.rels".into(), rels.into_bytes());
    parts.insert("[Content_Types].xml".into(), types.into_bytes());
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in parts {
        zip.start_file(name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).map_err(|e| e.to_string())?;
        zip.write_all(&content).map_err(|e| e.to_string())?;
    }
    Ok(zip.finish().map_err(|e| e.to_string())?.into_inner())
}
fn report_key(mission: &Mission, local_event_id: Option<&str>) -> String {
    if mission.mission_id > 0 { format!("mission-{}", mission.mission_id) }
    else if let Some(id) = local_event_id { format!("event-{id}") }
    else { format!("flight-{}-{}-{}", mission.start_time, mission.end_time, mission.mission_name) }
}
fn persist(root: &Path, data: &Collected, charts: &[String; 2], pm25_threshold: f64, regenerate: bool) -> Result<Summary, String> {
    // Serialize the lookup and commit; normal saves reuse the latest report.
    static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = SAVE_LOCK.lock().map_err(|_| "报告保存锁异常，请重试")?;
    let existing = read_summaries(root)?.into_iter().find(|s| {
        s.mission.as_ref().is_some_and(|m| report_key(m, s.local_event_id.as_deref()) == report_key(&data.mission, data.local_event_id.as_deref()))
    });
    if !regenerate {
        if let Some(existing) = existing { return Ok(existing); }
    }
    // Keep new revisions ordered even when generated within the same millisecond.
    let now = data.evidence.as_ref().map_or_else(|| Utc::now().timestamp_millis(), |e| e.captured_at).max(existing.as_ref().map_or(0, |s| s.created_at + 1));
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
            without_air_data: data.without_air_data,
            local_event_id: data.local_event_id.clone(),
            id: id.clone(),
            mission: Some(data.mission.clone()),
            created_at: now,
            title: data.mission.mission_name.clone(),
            path: dest.join(&name).to_string_lossy().into_owned(),
            photo_count: data.photos.len(),
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
    let root = root(&app)?;
    let db = crate::monitoring::database(&app)?;
    let threshold = crate::settings::read(&db)?.pm25_threshold;
    let review_path=app.path().app_data_dir().map_err(|e| e.to_string())?.join("report-photo-reviews.json");
    data.evidence=Some(evidence::snapshot(&db,&data,&review_path,Utc::now().timestamp_millis())?);
    tauri::async_runtime::spawn_blocking(move || persist(&root, &data, &charts, threshold, regenerate.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())?
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
                        if summary.mission.is_none() {
                            summary.mission = serde_json::from_value(value["mission"].clone()).ok();
                        }
                        if summary.air_url.is_empty() {
                            summary.air_url = value["air"]["url"].as_str().unwrap_or_default().to_string();
                        }
                        if summary.media_url.is_empty() {
                            summary.media_url = value["media"]["url"].as_str().unwrap_or_default().to_string();
                        }
                    }
                }
                items.push(summary);
            }
        }
    }
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.id.cmp(&b.id)));
    let mut seen = std::collections::HashSet::new();
    items.retain(|s| s.mission.as_ref().is_none_or(|m| seen.insert(report_key(m, s.local_event_id.as_deref()))));
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
        z.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        assert_eq!(doc.matches("<w:tbl>").count(), 3);
        assert!(doc.contains("2026年09月23日00:00至07:01"));
        let air_table = doc.split("<w:tbl>").nth(3).unwrap().split("</w:tbl>").next().unwrap();
        assert_eq!(air_table.matches("</w:tr>").count(), 3); // header plus BOTH raw observations
        for value in ["09-22 07:01:20", "09-22 07:01:21", "31.0", "65.0", "119.930000 / 32.430000", "未取得"] {
            assert!(air_table.contains(value), "missing observation: {value}");
        }
        assert!(!doc.contains("附录"));
        assert!(!doc.contains("{{"));
        assert!(!doc.contains("生物质燃烧特征明显"));
        assert_eq!(fill_slots("{{VALUE}}", &[("VALUE", "<&> {{VALUE}}".into())]).unwrap(), "&lt;&amp;&gt; {{VALUE}}");
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
        data.air = AirData { url: String::new(), mission_id: 0, unit: String::new(), points: vec![] };
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
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        assert!(!doc.contains("{{"));
        assert!(!doc.contains("有效采样 0"));
        assert!(!doc.contains("算术平均"));
        assert!(!doc.contains("建议逐张"));
        assert!(!doc.contains("建议优先"));
        assert!(!doc.contains("rIdFlight"));
        assert!(doc.contains("空气六参数监测数据"));
        assert!(doc.contains("<w:tblGrid>"));
        assert!(!doc.contains("巡飞监测记录"));
        assert_eq!(persist(&root, &data, &[String::new(), String::new()], 60.0, false).unwrap().id, first.id);
        let mut another = data.clone();
        another.mission.start_time += 86400000;
        another.mission.end_time += 86400000;
        another.media.folder = another.media.folder.replace("09-22", "09-23");
        assert_ne!(persist(&root, &another, &[String::new(), String::new()], 60.0, false).unwrap().id, first.id);
        assert_eq!(read_summaries(&root).unwrap().len(), 2);
        let mut local = data.clone();
        local.local_event_id = Some(Uuid::new_v4().to_string());
        let saved = persist(&root, &local, &[String::new(), String::new()], 60.0, false).unwrap();
        local.mission.mission_name = "更新显示名称".into();
        assert_eq!(persist(&root, &local, &[String::new(), String::new()], 60.0, false).unwrap().id, saved.id);
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
        let source: Collected = serde_json::from_slice(&fs::read(root.join(&new.id).join("source.json")).unwrap()).unwrap();
        assert_eq!(source.air.points[0].pm25, Some(99.0));
        let reports = read_summaries(&root).unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].id, new.id);
        assert_eq!(persist(&root, &updated, &[PNG.into(), PNG.into()], 80.0, false).unwrap().id, new.id);
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
        legacy.as_object_mut().unwrap().remove("airUrl");
        legacy.as_object_mut().unwrap().remove("mediaUrl");
        fs::write(root.join(&old.id).join("summary.json"), serde_json::to_vec(&legacy).unwrap()).unwrap();
        let id = Uuid::new_v4().to_string();
        let dir = root.join(&id);
        fs::create_dir(&dir).unwrap();
        legacy["id"] = json!(id);
        legacy["createdAt"] = json!(old.created_at + 1000);
        fs::write(dir.join("summary.json"), serde_json::to_vec(&legacy).unwrap()).unwrap();
        fs::write(dir.join("source.json"), serde_json::to_vec(&data).unwrap()).unwrap();
        let reports = read_summaries(&root).unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].id, id);
        assert_eq!(reports[0].mission.as_ref().unwrap().mission_id, 1);
        assert_eq!(reports[0].media_url, data.media.url);
        assert!(root.join(&old.id).join("summary.json").is_file());
        assert_eq!(persist(&root, &data, &[PNG.into(), PNG.into()], 60.0, false).unwrap().id, id);
        // An old report whose source is unavailable must remain accessible.
        fs::remove_file(dir.join("source.json")).unwrap();
        assert_eq!(read_summaries(&root).unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn concurrent_saves_return_the_same_report() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let jobs: Vec<_> = (0..4).map(|_| {
            let root = root.clone();
            std::thread::spawn(move || persist(&root, &sample(), &[PNG.into(), PNG.into()], 60.0, false).unwrap().id)
        }).collect();
        let ids: Vec<_> = jobs.into_iter().map(|job| job.join().unwrap()).collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        assert_eq!(read_summaries(&root).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn report_threshold_is_dynamic_and_strictly_greater() {
        let data = sample();
        for (threshold, count) in [(60.0, 1), (65.0, 0), (20.0, 2)] {
            let bytes = build_docx(&data, &[PNG.into(), PNG.into()], Utc::now().timestamp_millis(), threshold).unwrap();
            let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
            let mut text = String::new();
            zip.by_name("word/document.xml").unwrap().read_to_string(&mut text).unwrap();
            assert!(text.contains(&format!("判定阈值为 {} μg/m³", threshold)));
            assert!(text.contains(&format!("严格大于阈值的采样点 {} 个", count)));
        }
        assert!(build_docx(&data, &[PNG.into(), PNG.into()], Utc::now().timestamp_millis(), 0.0).is_err());
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
