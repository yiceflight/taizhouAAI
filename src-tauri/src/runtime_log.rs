use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const MAX_ROWS: i64 = 20_000;
const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
#[derive(Clone)]
pub struct RuntimeLog(Arc<Mutex<Store>>);
struct Store {
    db: Option<Connection>,
    error: Option<String>,
    session: String,
}
impl Default for RuntimeLog {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Store {
            db: None,
            error: None,
            session: uuid::Uuid::new_v4().to_string(),
        })))
    }
}
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: i64,
    at: i64,
    session: String,
    level: String,
    category: String,
    event: String,
    message: String,
    details: Value,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    level: Option<String>,
    category: Option<String>,
    search: Option<String>,
    since: Option<i64>,
    until: Option<i64>,
    before_id: Option<i64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    entries: Vec<Entry>,
    has_more: bool,
    session: String,
}

fn connect(path: &Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS runtime_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, session TEXT NOT NULL,
          level TEXT NOT NULL, category TEXT NOT NULL, event TEXT NOT NULL,
          message TEXT NOT NULL, details TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS runtime_logs_at ON runtime_logs(at);",
    )
    .map_err(|e| e.to_string())?;
    prune(&db, Utc::now().timestamp_millis())?;
    crate::diagnostics::initialize(&db)?;
    Ok(db)
}
fn prune(db: &Connection, now: i64) -> Result<(), String> {
    db.execute("DELETE FROM runtime_logs WHERE at < ? OR id <= (SELECT id FROM runtime_logs ORDER BY id DESC LIMIT 1 OFFSET ?)", params![now - RETENTION_MS, MAX_ROWS]).map_err(|e| e.to_string())?;
    Ok(())
}

impl RuntimeLog {
    fn initialize(&self, app: &tauri::AppHandle) {
        let result = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())
            .and_then(|path| {
                std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
                connect(&path.join("runtime-logs.sqlite3"))
            });
        let mut store = self.0.lock().unwrap();
        match result {
            Ok(db) => store.db = Some(db),
            Err(error) => store.error = Some(error),
        }
    }
    pub fn record(&self, level: &str, category: &str, event: &str, message: &str, details: Value) {
        let mut store = self.0.lock().unwrap();
        let Some(db) = &store.db else {
            return;
        };
        let at = Utc::now().timestamp_millis();
        let result = db.execute("INSERT INTO runtime_logs(at,session,level,category,event,message,details) VALUES (?,?,?,?,?,?,?)",
            params![at, store.session, level, category, event, message, details.to_string()])
            .map_err(|e| e.to_string()).and_then(|_| prune(db, at));
        store.error = result.err();
    }

    pub(crate) fn with_db<T>(&self, action: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let store = self.0.lock().map_err(|_| "运行日志锁已损坏")?;
        action(store.db.as_ref().ok_or("运行日志尚未初始化")?)
    }

    pub(crate) fn clear(&self) -> Result<(), String> {
        let mut store = self.0.lock().unwrap();
        let db = store.db.as_ref().ok_or("运行日志尚未初始化")?;
        crate::diagnostics::clear(db)?;
        db.execute("DELETE FROM runtime_logs", [])
            .map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
            .map_err(|e| e.to_string())?;
        store.error = None;
        Ok(())
    }
    fn read(&self, filter: &Filter, limit: i64) -> Result<Page, String> {
        let store = self.0.lock().unwrap();
        if let Some(error) = &store.error {
            return Err(format!("运行日志写入异常：{error}"));
        }
        let db = store.db.as_ref().ok_or("运行日志尚未初始化")?;
        prune(db, Utc::now().timestamp_millis())?;
        Ok(Page {
            entries: query(db, filter, limit)?,
            has_more: false,
            session: store.session.clone(),
        })
    }
}
fn query(db: &Connection, filter: &Filter, limit: i64) -> Result<Vec<Entry>, String> {
    let mut stmt = db
        .prepare(
            "SELECT id,at,session,level,category,event,message,details FROM runtime_logs
        WHERE (?1 IS NULL OR level=?1) AND (?2 IS NULL OR category=?2)
          AND (?3 IS NULL OR instr(lower(message || details || event || session),lower(?3)) > 0)
          AND (?4 IS NULL OR at>=?4) AND (?5 IS NULL OR at<=?5) AND (?6 IS NULL OR id<?6)
        ORDER BY id DESC LIMIT ?7",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![
                filter.level,
                filter.category,
                filter.search,
                filter.since,
                filter.until,
                filter.before_id,
                limit
            ],
            |row| {
                let details: String = row.get(7)?;
                Ok(Entry {
                    id: row.get(0)?,
                    at: row.get(1)?,
                    session: row.get(2)?,
                    level: row.get(3)?,
                    category: row.get(4)?,
                    event: row.get(5)?,
                    message: row.get(6)?,
                    details: serde_json::from_str(&details)
                        .unwrap_or(json!({"error":"日志详情损坏"})),
                })
            },
        )
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
pub fn record(
    app: &tauri::AppHandle,
    level: &str,
    category: &str,
    event: &str,
    message: &str,
    details: Value,
) {
    if let Some(log) = app.try_state::<RuntimeLog>() {
        log.record(level, category, event, message, details);
    }
}
fn changed(
    log: &RuntimeLog,
    previous: &mut HashMap<String, Value>,
    key: &str,
    level: &str,
    category: &str,
    message: &str,
    value: Value,
) {
    if previous.get(key) != Some(&value) {
        log.record(
            level,
            category,
            key,
            message,
            json!({"previous":previous.get(key), "current":value}),
        );
        previous.insert(key.into(), value);
    }
}
fn window_state(app: &tauri::AppHandle) -> Value {
    app.get_webview_window("main").map(|w| json!({"visible":w.is_visible().ok(),"minimized":w.is_minimized().ok(),"focused":w.is_focused().ok()})).unwrap_or(Value::Null)
}
pub fn start(app: &tauri::AppHandle) {
    let log = app.state::<RuntimeLog>().inner().clone();
    log.initialize(app);
    log.record("info", "app", "app.started", "客户端已启动", json!({"version":app.package_info().version.to_string(),"platform":std::env::consts::OS,"channel":crate::environment::CHANNEL,"pid":std::process::id(),"commit":env!("DIAGNOSTIC_COMMIT"),"dirty":env!("DIAGNOSTIC_DIRTY"),"builtAt":env!("DIAGNOSTIC_BUILD_TIME"),"architecture":std::env::consts::ARCH}));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut previous = HashMap::new();
        let mut pulse = 0;
        let mut last = Utc::now().timestamp_millis();
        loop {
            let now = Utc::now().timestamp_millis();
            if now - last > 90_000 || now < last {
                log.record("warning", "app", "app.observation_gap", "后台观测出现时间间隔或系统时间变化", json!({"previousAt":last,"currentAt":now,"gapMs":now-last,"note":"可能与休眠、进程阻塞或系统时间调整有关，仅凭间隔无法确定原因"}));
            }
            last = now;
            let window = window_state(&app);
            changed(
                &log,
                &mut previous,
                "window.state",
                "info",
                "window",
                "窗口状态变化",
                window.clone(),
            );
            let bridge = app.state::<crate::bridge::Bridge>().status();
            let ready = crate::readiness::view(&app);
            changed(
                &log,
                &mut previous,
                "bridge.state",
                if ready.plugin_ready {
                    "info"
                } else {
                    "warning"
                },
                "bridge",
                if ready.plugin_ready {
                    "浏览器插件连接可用"
                } else {
                    "浏览器插件连接未就绪"
                },
                json!({"connected":bridge.connected,"clients":bridge.clients,"versions":bridge.versions,"error":bridge.error,"ready":ready.plugin_ready,"reason":ready.plugin_message}),
            );
            for site in &ready.sites {
                changed(
                    &log,
                    &mut previous,
                    &format!("site.{}", site.id),
                    if site.state == "ready" {
                        "info"
                    } else {
                        "warning"
                    },
                    "readiness",
                    &format!(
                        "{}网站验证状态变化",
                        match site.id.as_str() {
                            "map" => "江苏大气站",
                            "dji" => "司空",
                            "sniff" => "可飞",
                            _ => &site.id,
                        }
                    ),
                    json!({"state":site.state,"message":site.message}),
                );
            }
            changed(
                &log,
                &mut previous,
                "workspace.state",
                if ready.ready { "info" } else { "warning" },
                "readiness",
                if ready.ready {
                    "运行状态恢复正常"
                } else {
                    "运行状态未就绪"
                },
                json!({"ready":ready.ready,"started":ready.started,"monitoringReady":ready.monitoring_ready,"flightReady":ready.flight_ready,"reportReady":ready.report_ready}),
            );
            match crate::monitoring::get_monitoring(app.clone(), app.state()) {
                Ok(view) => {
                    let v = serde_json::to_value(view).unwrap_or(Value::Null);
                    changed(
                        &log,
                        &mut previous,
                        "settings.state",
                        "info",
                        "app",
                        "运行配置观测",
                        json!({"monitoringEnabled":v["enabled"],"executionMode":if v["settings"]["requireManualConfirmation"].as_bool().unwrap_or(true) { "manual" } else { "automatic" },"settings":v["settings"]}),
                    );
                    let event = &v["flight"]["event"];
                    changed(
                        &log,
                        &mut previous,
                        "flight.state",
                        if event["error"].is_string() || event["statusCheckError"].is_string() {
                            "warning"
                        } else {
                            "info"
                        },
                        "flight",
                        "巡查任务状态观测",
                        json!({"id":event["id"],"name":event["name"],"status":event["status"],"error":event["error"],"statusCheckError":event["statusCheckError"],"launchAt":event["launchAt"],"observedAt":event["observedAt"]}),
                    );
                    if now - pulse >= 60_000 {
                        log.record("info", "app", "app.pulse", "后台存活记录", json!({"window":window,"started":ready.started,"monitoringReady":ready.monitoring_ready,"flightReady":ready.flight_ready,"monitoringEnabled":v["enabled"],"syncing":v["syncing"],"lastAttempt":v["lastAttempt"],"lastSuccess":v["lastSuccess"],"latestObservation":v["rows"][0],"syncError":v["error"],"note":"仅表示后台日志观察器正在运行；业务任务结果请查看同步与巡查日志"}));
                        pulse = now;
                    }
                    previous.remove("observer.error");
                }
                Err(error) => changed(
                    &log,
                    &mut previous,
                    "observer.error",
                    "error",
                    "app",
                    "后台状态读取失败",
                    json!({"error":error}),
                ),
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}
#[tauri::command]
pub fn get_runtime_logs(log: tauri::State<'_, RuntimeLog>, filter: Filter) -> Result<Page, String> {
    let mut page = log.read(&filter, 101)?;
    page.has_more = page.entries.len() > 100;
    page.entries.truncate(100);
    Ok(page)
}
#[tauri::command]
pub fn export_runtime_logs(
    app: tauri::AppHandle,
    log: tauri::State<'_, RuntimeLog>,
    mut filter: Filter,
) -> Result<String, String> {
    let _access = crate::data_reset::access(&app)?;
    filter.before_id = None;
    let page = log.read(&filter, MAX_ROWS)?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("runtime-log-exports");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join(format!(
        "运行日志-{}-{}.jsonl",
        Utc::now().format("%Y%m%dT%H%M%SZ"),
        uuid::Uuid::new_v4()
    ));
    let mut file =
        std::io::BufWriter::new(std::fs::File::create(&path).map_err(|e| e.to_string())?);
    for entry in page.entries.iter().rev() {
        writeln!(
            file,
            "{}",
            serde_json::to_string(entry).map_err(|e| e.to_string())?
        )
        .map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
pub fn open_runtime_log_exports(app: tauri::AppHandle) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("runtime-log-exports");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn logger(db: Connection) -> RuntimeLog {
        RuntimeLog(Arc::new(Mutex::new(Store {
            db: Some(db),
            error: None,
            session: "test-session".into(),
        })))
    }
    #[test]
    fn persistence_filters_and_cursor_remain_correct_after_new_entries() {
        let path =
            std::env::temp_dir().join(format!("runtime-log-{}.sqlite3", uuid::Uuid::new_v4()));
        let log = logger(connect(&path).unwrap());
        log.record(
            "info",
            "window",
            "window.state",
            "窗口最小化",
            json!({"minimized":true}),
        );
        log.record(
            "warning",
            "bridge",
            "bridge.state",
            "插件断开",
            json!({"requestId":"request-123"}),
        );
        let first = log.read(&Filter::default(), 1).unwrap().entries.remove(0);
        log.record("info", "bridge", "bridge.state", "连接恢复", json!({}));
        let older = log
            .read(
                &Filter {
                    before_id: Some(first.id),
                    ..Filter::default()
                },
                100,
            )
            .unwrap();
        assert_eq!(older.entries.len(), 1);
        assert_eq!(older.entries[0].message, "窗口最小化");
        let matching = log
            .read(
                &Filter {
                    level: Some("warning".into()),
                    category: Some("bridge".into()),
                    search: Some("REQUEST-123".into()),
                    since: Some(first.at),
                    until: Some(first.at),
                    ..Filter::default()
                },
                100,
            )
            .unwrap();
        assert_eq!(matching.entries.len(), 1);
        assert!(log
            .read(
                &Filter {
                    search: Some("' OR 1=1 --".into()),
                    ..Filter::default()
                },
                100
            )
            .unwrap()
            .entries
            .is_empty());
        drop(log);
        let reopened = logger(connect(&path).unwrap());
        assert_eq!(
            reopened
                .read(&Filter::default(), 100)
                .unwrap()
                .entries
                .len(),
            3
        );
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn retention_bounds_both_age_and_count() {
        let db = connect(Path::new(":memory:")).unwrap();
        let now = Utc::now().timestamp_millis();
        db.execute("WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<20005)
          INSERT INTO runtime_logs(at,session,level,category,event,message,details) SELECT ?,'s','info','app','pulse','alive','{}' FROM seq", [now]).unwrap();
        prune(&db, now).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM runtime_logs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            MAX_ROWS
        );
        db.execute(
            "UPDATE runtime_logs SET at=? WHERE id=20005",
            [now - RETENTION_MS - 1],
        )
        .unwrap();
        prune(&db, now).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM runtime_logs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            MAX_ROWS - 1
        );
        assert_eq!(query(&db, &Filter::default(), 1).unwrap()[0].id, 20004);
    }
    #[test]
    fn preserves_full_error_text_and_structured_context() {
        let log = logger(connect(Path::new(":memory:")).unwrap());
        let message = format!("request failed\n{}", "stack frame\n".repeat(400));
        let details = json!({"requestId":"abc", "url":"https://example.test/path?task=123#step", "rows":(0..150).collect::<Vec<_>>()});
        log.record("error", "bridge", "job.finished", &message, details.clone());
        let entry = log.read(&Filter::default(), 1).unwrap().entries.remove(0);
        assert_eq!(entry.message, message);
        assert_eq!(entry.details, details);
    }

    #[test]
    fn unchanged_state_is_not_repeated_and_storage_failure_is_visible() {
        let log = logger(connect(Path::new(":memory:")).unwrap());
        let mut previous = HashMap::new();
        for _ in 0..3 {
            changed(
                &log,
                &mut previous,
                "bridge",
                "warning",
                "bridge",
                "断开",
                json!(false),
            );
        }
        changed(
            &log,
            &mut previous,
            "bridge",
            "info",
            "bridge",
            "恢复",
            json!(true),
        );
        assert_eq!(log.read(&Filter::default(), 100).unwrap().entries.len(), 2);
        log.0
            .lock()
            .unwrap()
            .db
            .as_ref()
            .unwrap()
            .execute("DROP TABLE runtime_logs", [])
            .unwrap();
        log.record("info", "app", "test", "写入失败不能中断业务", json!({}));
        assert!(
            matches!(log.read(&Filter::default(), 1), Err(e) if e.contains("运行日志写入异常"))
        );
    }
}
