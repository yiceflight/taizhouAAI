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

const TEMPLATE: &[u8] = include_bytes!("../assets/flight-report-template.docx");
const PROJECT: &str = "/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
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
    pub mission: Mission,
    pub air: AirData,
    pub media: Media,
    pub photos: Vec<Photo>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectRequest {
    pub dji_session: String,
    pub dji_tab_id: i64,
    pub sniff_session: String,
    pub sniff_tab_id: i64,
    pub mission: Mission,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
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
fn validate(data: &Collected, now: i64) -> Result<Stats, String> {
    source(&data.air.url, false)?;
    source(&data.media.url, true)?;
    let m = &data.mission;
    if m.mission_id == 0
        || m.mission_id != data.air.mission_id
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
    if data.air.unit != "μg/m³" || data.air.points.len() < 2 || data.air.points.len() > 20000 {
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
            return Err("司空照片与本次可飞任务时间不匹配，已停止生成。".into());
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
        return Err("司空任务文件夹时间与可飞任务不匹配或无法核对。".into());
    }
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
    Ok(Stats {
        min,
        max: peak.0,
        mean: values.iter().map(|x| x.0).sum::<f64>() / values.len() as f64,
        count: values.len(),
        missing: data.air.points.len() - values.len(),
        peak_time: peak.1,
    })
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
    crate::readiness::require_started(&app)?;
    let req = request;
    if req.mission.end_time > Utc::now().timestamp_millis() - 60000 {
        return Err("请等待飞行结束并完成上传至少 1 分钟。".into());
    }
    let air: AirData = serde_json::from_value(
        bridge
            .request(
                req.sniff_session,
                req.sniff_tab_id,
                json!({"type":"flight-airins","missionId":req.mission.mission_id}),
            )
            .await?,
    )
    .map_err(|e| format!("可飞格式错误：{e}"))?;
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
    source(&air.url, false)?;
    source(&media.url, true)?;
    let mut photos = vec![];
    for name in &media.files {
        let t = photo_time(name)?;
        if t < req.mission.start_time - 300000 || t > req.mission.end_time + 300000 {
            return Err("照片不属于本次可飞航次，已停止采集。".into());
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
fn paragraph(text: &str) -> String {
    format!("<w:p><w:pPr><w:spacing w:after=\"120\"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii=\"Times New Roman\" w:eastAsia=\"宋体\"/><w:sz w:val=\"24\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",xml(text))
}
fn table(rows: &[Vec<String>]) -> String {
    let mut out = String::from("<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>");
    for side in ["top", "left", "bottom", "right", "insideH", "insideV"] {
        out.push_str(&format!(
            "<w:{side} w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/>"
        ));
    }
    out.push_str("</w:tblBorders><w:tblCellMar><w:top w:w=\"80\" w:type=\"dxa\"/><w:left w:w=\"90\" w:type=\"dxa\"/><w:bottom w:w=\"80\" w:type=\"dxa\"/><w:right w:w=\"90\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr>");
    for (i, row) in rows.iter().enumerate() {
        out.push_str("<w:tr><w:trPr><w:cantSplit/>");
        if i == 0 {
            out.push_str("<w:tblHeader/>")
        };
        out.push_str("</w:trPr>");
        for (col, cell) in row.iter().enumerate() {
            out.push_str(&format!(
                "<w:tc><w:tcPr><w:tcW w:w=\"{}\" w:type=\"dxa\"/>{}</w:tcPr>{}</w:tc>",
                if row.len() == 3 {
                    [700, 6000, 2000][col]
                } else {
                    8700 / row.len()
                },
                if i == 0 {
                    "<w:shd w:fill=\"EDF0F2\"/>"
                } else {
                    ""
                },
                paragraph(cell)
            ));
        }
        out.push_str("</w:tr>");
    }
    out.push_str("</w:tbl>");
    out
}
fn image_xml(id: usize, width: i64, height: i64) -> String {
    format!(
        r#"<w:p><w:pPr><w:jc w:val="center"/><w:keepNext/><w:spacing w:after="80"/></w:pPr><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="{width}" cy="{height}"/><wp:docPr id="{id}" name="Report image {id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdFlight{id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{width}" cy="{height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"#
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
    let above_threshold = data.air.points.iter().filter(|point| point.pm25.is_some_and(|value| value > pm25_threshold)).count();
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
    let m = &data.mission;
    let warning = if stats.max == 0.0 {
        "本航次 PM2.5 有效数值全部为 0，请核查传感器状态；不能据此判断空气质量良好。"
    } else {
        "单航次采样结果不等同于固定站点小时均值或日均值，不能据此判定污染成因。"
    };
    let fields=[("DATE",date(m.start_time,"%Y年%m月%d日")),("ISSUED",date(issued,"%Y年%m月%d日")),("OVERVIEW",format!("本快报汇总 {} 本次巡飞的司空影像和可飞 PM2.5 数据。PM2.5 有效采样 {} 点，范围 {:.1}—{:.1} μg/m³。{} 未取得同步 K⁺、气象及站点污染过程资料，污染过程特征待复核。",date(m.start_time,"%Y年%m月%d日"),stats.count,stats.min,stats.max,warning)),("MISSION",format!("可飞任务：{}。任务时间：{} 至 {}（北京时间），时长 {:.1} 分钟。区域：{}。航线见图2。",m.mission_name,date(m.start_time,"%Y-%m-%d %H:%M:%S"),date(m.end_time,"%H:%M:%S"),(m.end_time-m.start_time) as f64/60000.0,m.geo_location)),("PHOTO_SUMMARY",format!("从本次司空 Immediate-Media 文件夹导出 {} 张照片，拍摄时间已与可飞任务核对。图片详见附录。影像内容、火点及异常数量尚未人工判读。",data.photos.len())),("PM_SUMMARY",format!("数据来源：可飞任务 {} 的完整原始序列（未应用页面筛选）。采样 {} 点，其中 PM2.5 有效 {} 点、缺测 {} 点；最小值 {:.1}、最大值 {:.1}、采样算术平均值 {:.1} μg/m³；峰值采样时间 {}。本报告 PM2.5 判定阈值为 {} μg/m³，严格大于阈值的采样点 {} 个（占有效采样 {:.1}%）。",m.mission_id,data.air.points.len(),stats.count,stats.missing,stats.min,stats.max,stats.mean,date(stats.peak_time,"%H:%M:%S"),pm25_threshold,above_threshold,above_threshold as f64 / stats.count as f64 * 100.0)),("CONCLUSION",warning.to_owned()),("NOTES","建议结合同期站点 K⁺、风向风速以及现场核查，对照片逐张判读后形成污染源结论。本快报未执行 AI 火点识别，异常数量和处理建议需复核后签发。".into())];
    for (key, value) in fields {
        doc = doc.replace(&format!("{{{{{key}}}}}"), &xml(&value));
    }
    block(
        &mut doc,
        "SUMMARY_TABLE",
        &table(&[
            vec!["资料".into(), "本次收录".into()],
            vec!["可飞任务编号".into(), m.mission_id.to_string()],
            vec!["PM2.5 采样点".into(), data.air.points.len().to_string()],
            vec!["司空照片".into(), data.photos.len().to_string()],
        ]),
    )?;
    let mut rows = vec![vec!["序号".into(), "照片文件名".into(), "拍摄时间".into()]];
    for (i, p) in data.photos.iter().enumerate() {
        rows.push(vec![
            (i + 1).to_string(),
            p.name.clone(),
            date(photo_time(&p.name)?, "%H:%M:%S"),
        ]);
    }
    block(
        &mut doc,
        "PHOTO_TABLE",
        &if data.photos.is_empty() {
            paragraph("当前任务文件夹无照片，本快报仅含可飞监测资料。")
        } else {
            table(&rows)
        },
    )?;
    let mut rels = String::from_utf8(
        parts
            .remove("word/_rels/document.xml.rels")
            .ok_or("模板关系缺失")?,
    )
    .map_err(|e| e.to_string())?;
    let mut types = String::from_utf8(parts.remove("[Content_Types].xml").ok_or("模板类型缺失")?)
        .map_err(|e| e.to_string())?;
    let mut appendix = String::new();
    for (idx, src) in charts
        .iter()
        .chain(data.photos.iter().map(|p| &p.data_url))
        .enumerate()
    {
        let id = idx + 1;
        let (bytes, ext) = decode_image(src)?;
        let name = format!("media/flight-{id}.{ext}");
        let (pixel_width, pixel_height) = image_dimensions(&bytes)?;
        parts.insert(format!("word/{name}"), bytes);
        rels=rels.replace("</Relationships>",&format!("<Relationship Id=\"rIdFlight{id}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"{name}\"/></Relationships>"));
        if !types.contains(&format!("Extension=\"{ext}\"")) {
            types = types.replace(
                "</Types>",
                &format!("<Default Extension=\"{ext}\" ContentType=\"image/{ext}\"/></Types>"),
            );
        }
        let scale = (5500000.0 / pixel_width as f64)
            .min((if idx < 2 { 2400000.0 } else { 3800000.0 }) / pixel_height as f64);
        let img = image_xml(
            id,
            (pixel_width as f64 * scale) as i64,
            (pixel_height as f64 * scale) as i64,
        );
        if idx < 2 {
            block(
                &mut doc,
                if idx == 0 { "PM_CHART" } else { "ROUTE_CHART" },
                &img,
            )?;
        } else {
            appendix.push_str(&img);
            appendix.push_str(&paragraph(&format!(
                "图{}  {}（{}）",
                id,
                data.photos[idx - 2].name,
                date(photo_time(&data.photos[idx - 2].name)?, "%H:%M:%S")
            )));
        }
    }
    block(
        &mut doc,
        "PHOTOS",
        &if appendix.is_empty() {
            paragraph("本航次无照片。")
        } else {
            appendix
        },
    )?;
    if doc.contains("{{") {
        return Err("模板存在未替换字段".into());
    }
    parts.insert("word/document.xml".into(), doc.into_bytes());
    parts.insert("word/_rels/document.xml.rels".into(), rels.into_bytes());
    parts.insert("[Content_Types].xml".into(), types.into_bytes());
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in parts {
        zip.start_file(
            name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(|e| e.to_string())?;
        zip.write_all(&data).map_err(|e| e.to_string())?;
    }
    Ok(zip.finish().map_err(|e| e.to_string())?.into_inner())
}
fn persist(root: &Path, data: &Collected, charts: &[String; 2], pm25_threshold: f64) -> Result<Summary, String> {
    // Serialize the lookup and commit so concurrent requests cannot create two reports.
    static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = SAVE_LOCK.lock().map_err(|_| "报告保存锁异常，请重试")?;
    if let Some(existing) = read_summaries(root)?.into_iter().find(|s| {
        s.mission.as_ref().is_some_and(|m| m.mission_id == data.mission.mission_id)
    }) {
        return Ok(existing);
    }
    let now = Utc::now().timestamp_millis();
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
            id: id.clone(),
            mission: Some(data.mission.clone()),
            created_at: now,
            title: data.mission.mission_name.clone(),
            path: dest.join(&name).to_string_lossy().into_owned(),
            photo_count: data.photos.len(),
            point_count: data.air.points.len(),
            warning: if stats.max == 0.0 {
                "PM2.5 全部为 0，请核查传感器".into()
            } else {
                String::new()
            },
            air_url: data.air.url.clone(),
            media_url: data.media.url.clone(),
        };
        fs::write(temp.join("report-settings.json"), serde_json::to_vec_pretty(&serde_json::json!({"pm25Threshold": pm25_threshold})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
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
    data: Collected,
    charts: [String; 2],
) -> Result<Summary, String> {
    let root = root(&app)?;
    let threshold = crate::settings::read(&crate::monitoring::database(&app)?)?.pm25_threshold;
    tauri::async_runtime::spawn_blocking(move || persist(&root, &data, &charts, threshold))
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
    items.retain(|s| s.mission.as_ref().is_none_or(|m| seen.insert(m.mission_id)));
    Ok(items)
}
#[tauri::command]
pub fn open_flight_report(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let id = Uuid::parse_str(&id).map_err(|_| "报告编号无效")?;
    let dir = root(&app)?.join(id.to_string());
    let s: Summary =
        serde_json::from_slice(&fs::read(dir.join("summary.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let filename = Path::new(&s.path).file_name().ok_or("文件名无效")?;
    let path = dir.join(filename);
    if path.extension().and_then(|s| s.to_str()) != Some("docx") {
        return Err("报告类型无效".into());
    }
    app.opener()
        .open_path(path.to_str().ok_or("路径无效")?, None::<&str>)
        .map_err(|e| e.to_string())
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
    fn sample() -> Collected {
        let start = 1790031680000;
        Collected {
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
    const PNG:&str="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=";
    #[test]
    fn rejects_wrong_flight_and_units() {
        let mut d = sample();
        assert_eq!(validate(&d, i64::MAX).unwrap().mean, 48.0);
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
    #[test]
    fn native_docx_and_atomic_history() {
        let d = sample();
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let a = persist(&root, &d, &[PNG.into(), PNG.into()], 60.0).unwrap();
        let b = persist(&root, &d, &[PNG.into(), PNG.into()], 60.0).unwrap();
        assert_eq!(a.path, b.path);
        assert_eq!(a.air_url, d.air.url);
        assert_eq!(a.media_url, d.media.url);
        assert_eq!(read_summaries(&root).unwrap().len(), 1);
        let mut another = d.clone();
        another.mission.mission_id = 2;
        another.air.mission_id = 2;
        let c = persist(&root, &another, &[PNG.into(), PNG.into()], 60.0).unwrap();
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
        assert!(xml.contains("测试任务 &lt;&amp;&gt;"));
        assert!(xml.contains("48.0"));
        assert!(root.join(&a.id).join("source.json").is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_reports_recover_missions_and_keep_only_latest_without_deleting_files() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let data = sample();
        let old = persist(&root, &data, &[PNG.into(), PNG.into()], 60.0).unwrap();
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
        assert_eq!(persist(&root, &data, &[PNG.into(), PNG.into()], 60.0).unwrap().id, id);
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
            std::thread::spawn(move || persist(&root, &sample(), &[PNG.into(), PNG.into()], 60.0).unwrap().id)
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
            let s = persist(&root, &d, &charts, 60.0).unwrap();
            println!("QA report: {}", s.path);
        }
    }
}
