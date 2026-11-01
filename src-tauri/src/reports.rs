use crate::bridge::{allowed_url, Bridge};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub url: String,
    pub title: String,
    pub text: String,
    pub tables: Vec<Vec<Vec<String>>>,
    pub truncated: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub created_at: u64,
    pub source: String,
    pub snapshot: Snapshot,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSummary {
    id: String,
    created_at: u64,
    source: String,
    title: String,
    truncated: bool,
}
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("reports");
    fs::create_dir_all(&path).map_err(|e| format!("无法创建报告目录：{e}"))?;
    Ok(path)
}
fn report_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    let uuid = Uuid::parse_str(id).map_err(|_| "报告编号无效。")?;
    Ok(root.join(format!("{uuid}.json")))
}
fn validate(snapshot: &Snapshot) -> Result<String, String> {
    if !allowed_url(&snapshot.url) {
        return Err("采集来源不在授权范围内。".into());
    }
    if snapshot.title.len() > 8192
        || snapshot.text.len() > 500000
        || snapshot.tables.len() > 20
        || snapshot.tables.iter().any(|table| {
            table.len() > 200
                || table
                    .iter()
                    .any(|row| row.len() > 30 || row.iter().any(|cell| cell.len() > 5000))
        })
    {
        return Err("采集数据超过限制。".into());
    }
    if snapshot.text.trim().is_empty()
        && !snapshot
            .tables
            .iter()
            .flatten()
            .flatten()
            .any(|cell| !cell.trim().is_empty())
    {
        return Err("页面没有可采集的数据。".into());
    }
    let host = tauri::Url::parse(&snapshot.url).map_err(|e| e.to_string())?;
    Ok(match host.host_str() {
        Some("fh.dji.com") => "DJI FlightHub",
        Some("aai.airins.cn") => "可飞平台",
        _ => "综合地图",
    }
    .into())
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn html(report: &Report) -> String {
    let snapshot = &report.snapshot;
    let tables: String = snapshot
        .tables
        .iter()
        .enumerate()
        .map(|(i, table)| {
            let rows: String = table
                .iter()
                .map(|row| {
                    format!(
                        "<tr>{}</tr>",
                        row.iter()
                            .map(|cell| format!("<td>{}</td>", escape(cell)))
                            .collect::<String>()
                    )
                })
                .collect();
            format!(
                "<h3>表格 {}</h3><div class='table'><table>{rows}</table></div>",
                i + 1
            )
        })
        .collect();
    format!("<!doctype html><html lang='zh-CN'><meta charset='utf-8'><meta name='viewport' content='width=device-width'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><title>{}</title><style>body{{font:15px/1.7 system-ui;margin:40px auto;padding:0 24px;max-width:1000px;color:#233b34}}pre{{white-space:pre-wrap;overflow-wrap:anywhere}}.table{{overflow:auto}}table{{border-collapse:collapse}}td{{border:1px solid #ccd8d1;padding:8px;white-space:pre-wrap}}.note{{background:#f3f6f4;padding:16px}}@media print{{body{{margin:0}}}}</style><h1>网页采集报告</h1><h2>{}</h2><p>数据来源：{}</p><p>页面：{}</p><p>采集时间：{}</p><p class='note'>本报告记录采集时当前页面可见正文及 HTML 表格，不代表完整数据库、全部分页或专业监测结论。登录页、错误提示也可能属于页面原文，请核对来源。{}</p><h2>页面正文</h2><pre>{}</pre><h2>页面表格</h2>{}</html>", escape(&snapshot.title), escape(&snapshot.title), escape(&report.source), escape(&snapshot.url), chrono::DateTime::from_timestamp_millis(report.created_at as i64).map(|time| time.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S %:z").to_string()).unwrap_or_else(|| "时间无效".into()), if snapshot.truncated { " 内容超过采集限制，已截断。" } else { "" }, escape(&snapshot.text), tables)
}
fn persist(root: &Path, report: &Report) -> Result<(), String> {
    let final_path = report_path(root, &report.id)?;
    let temp = final_path.with_extension("tmp");
    let data = serde_json::to_vec_pretty(report).map_err(|e| e.to_string())?;
    fs::write(&temp, data).map_err(|e| format!("报告写入失败：{e}"))?;
    fs::rename(&temp, &final_path).map_err(|e| format!("报告保存失败：{e}"))?;
    Ok(())
}
#[tauri::command]
pub async fn generate_report(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Bridge>,
    session: String,
    tab_id: i64,
) -> Result<ReportSummary, String> {
    let _access = crate::data_reset::access(&app)?;
    crate::runtime_log::record(
        &app,
        "info",
        "report",
        "generate_report.started",
        "网页报告生成开始",
        serde_json::json!({}),
    );
    let result = async {
        crate::readiness::require_started(&app)?;
        let data = bridge.capture(session, tab_id).await?;
        let snapshot: Snapshot =
            serde_json::from_value(data).map_err(|e| format!("插件数据格式错误：{e}"))?;
        let source = validate(&snapshot)?;
        let report = Report {
            id: Uuid::new_v4().to_string(),
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis() as u64,
            source,
            snapshot,
        };
        persist(&directory(&app)?, &report)?;
        Ok(summary(report))
    }
    .await;
    crate::runtime_log::record(
        &app,
        if result.is_ok() { "info" } else { "error" },
        "report",
        "generate_report.finished",
        if result.is_ok() {
            "网页报告生成完成"
        } else {
            "网页报告生成失败"
        },
        serde_json::json!({"error":result.as_ref().err()}),
    );
    result
}

fn summary(report: Report) -> ReportSummary {
    ReportSummary {
        id: report.id,
        created_at: report.created_at,
        source: report.source,
        title: report.snapshot.title,
        truncated: report.snapshot.truncated,
    }
}
#[tauri::command]
pub fn list_reports(app: tauri::AppHandle) -> Result<Vec<ReportSummary>, String> {
    let _access = crate::data_reset::access(&app)?;
    let mut reports = vec![];
    for item in fs::read_dir(directory(&app)?).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let report: Report = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|_| {
            format!(
                "报告文件损坏：{}。请打开报告目录检查。",
                path.file_name().unwrap_or_default().to_string_lossy()
            )
        })?;
        reports.push(summary(report));
    }
    reports.sort_by_key(|report| std::cmp::Reverse(report.created_at));
    Ok(reports)
}
#[tauri::command]
pub fn open_report(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
    let path = report_path(&directory(&app)?, &id)?;
    let report: Report =
        serde_json::from_slice(&fs::read(&path).map_err(|e| format!("无法读取报告：{e}"))?)
            .map_err(|e| e.to_string())?;
    let html_path = path.with_extension("html");
    fs::write(&html_path, html(&report)).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(html_path.to_str().ok_or("报告路径无效")?, None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn open_reports_directory(app: tauri::AppHandle) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
    app.opener()
        .open_path(
            directory(&app)?.to_str().ok_or("报告路径无效")?,
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn report_roundtrip_and_html_safety() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir(&root).unwrap();
        let report = Report {
            id: Uuid::new_v4().to_string(),
            created_at: 1,
            source: "综合地图".into(),
            snapshot: Snapshot {
                url: "http://61.155.4.60:18080/".into(),
                title: "<script>alert(1)</script>".into(),
                text: "<img src=x onerror=alert(1)>".into(),
                tables: vec![vec![vec!["<td>".into()]]],
                truncated: true,
            },
        };
        persist(&root, &report).unwrap();
        let loaded: Report =
            serde_json::from_slice(&fs::read(report_path(&root, &report.id).unwrap()).unwrap())
                .unwrap();
        assert_eq!(loaded.snapshot.text, report.snapshot.text);
        assert!(!html(&loaded).contains("<script>"));
        assert!(html(&loaded).contains("&lt;img"));
        assert!(report_path(&root, "../../secret").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
