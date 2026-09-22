use crate::bridge::Bridge;
use chrono::{Duration, FixedOffset, NaiveDateTime, Timelike, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::Manager;

pub const SOURCE_URL: &str =
    "http://61.155.4.60:18080/#/particle-analysis/feature-analysis/time-series";
const FORMAT: &str = "%Y-%m-%d %H:%M:%S";
#[derive(Default)]
pub struct Monitor {
    busy: AtomicBool,
    last_attempt: Mutex<Option<String>>,
    error: Mutex<Option<String>>,
}
#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HourRow {
    time: String,
    potassium: Option<f64>,
    pm25: Option<f64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Batch {
    url: String,
    city: String,
    city_code: String,
    unit: String,
    data_source: String,
    common_site_type: String,
    start_time: String,
    end_time: String,
    rows: Vec<HourRow>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorView {
    enabled: bool,
    syncing: bool,
    last_attempt: Option<String>,
    last_success: Option<String>,
    error: Option<String>,
    total: i64,
    rows: Vec<HourRow>,
    query_through: Option<String>,
    flight: crate::flight::View,
}
pub(crate) fn connect(path: &Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS hourly_observations (
            city_code TEXT NOT NULL, observed_at TEXT NOT NULL,
            potassium REAL CHECK(potassium >= 0), pm25 REAL CHECK(pm25 >= 0),
            unit TEXT NOT NULL, source_url TEXT NOT NULL, data_source TEXT NOT NULL,
            common_site_type TEXT NOT NULL, synced_at TEXT NOT NULL,
            PRIMARY KEY(city_code, observed_at));
        CREATE TABLE IF NOT EXISTS monitor_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )
    .map_err(|e| e.to_string())?;
    Ok(db)
}
pub(crate) fn database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    connect(&path.join("monitoring.sqlite3"))
}
pub(crate) fn setting(db: &Connection, key: &str) -> Result<Option<String>, String> {
    db.query_row(
        "SELECT value FROM monitor_settings WHERE key=?",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}
pub(crate) fn put(db: &Connection, key: &str, value: &str) -> Result<(), String> {
    db.execute("INSERT INTO monitor_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]).map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn now() -> NaiveDateTime {
    Utc::now()
        .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
        .naive_local()
}
pub(crate) fn parse(value: &str) -> Result<NaiveDateTime, String> {
    let time = NaiveDateTime::parse_from_str(value, FORMAT).map_err(|_| "小时数据时间格式错误")?;
    if time.minute() != 0 || time.second() != 0 || time.format(FORMAT).to_string() != value {
        return Err("只能保存北京时间整点数据".into());
    }
    Ok(time)
}
fn window(db: &Connection) -> Result<(String, String), String> {
    let end_now = now()
        .with_minute(0)
        .unwrap()
        .with_second(0)
        .unwrap()
        .with_nanosecond(0)
        .unwrap();
    let start = match setting(db, "query_through")? {
        Some(value) => (parse(&value)? - Duration::hours(48)).min(end_now - Duration::hours(48)),
        None => end_now - Duration::days(7),
    };
    let end = (start + Duration::days(7)).min(end_now);
    Ok((
        start.format(FORMAT).to_string(),
        end.format(FORMAT).to_string(),
    ))
}
fn persist(db: &mut Connection, batch: Batch, start: &str, end: &str) -> Result<(), String> {
    if batch.url.split('?').next() != Some(SOURCE_URL)
        || batch.city != "泰州市"
        || batch.city_code != "321200"
        || batch.unit != "μg/m³"
        || batch.data_source != "A_6"
        || batch.common_site_type != "30"
        || batch.start_time != start
        || batch.end_time != end
        || batch.rows.len() > 169
    {
        return Err("小时采集来源、口径或查询范围不匹配，未写入数据库。".into());
    }
    let lower = parse(start)?;
    let upper = parse(end)?;
    if upper < lower || upper - lower > Duration::days(7) || upper > now() {
        return Err("小时查询范围无效".into());
    }
    let mut seen = std::collections::HashSet::new();
    for row in &batch.rows {
        let time = parse(&row.time)?;
        if time < lower
            || time > upper
            || !seen.insert(&row.time)
            || [row.potassium, row.pm25]
                .iter()
                .flatten()
                .any(|v| !v.is_finite() || *v < 0.0)
        {
            return Err("小时数据包含重复时间、越界时间或非法浓度，整批未写入。".into());
        }
    }
    let synced = now().format(FORMAT).to_string();
    let tx = db.transaction().map_err(|e| e.to_string())?;
    for row in batch.rows {
        tx.execute("INSERT INTO hourly_observations(city_code,observed_at,potassium,pm25,unit,source_url,data_source,common_site_type,synced_at)
            VALUES ('321200',?,?,?,?,?,'A_6','30',?) ON CONFLICT(city_code,observed_at) DO UPDATE SET
            potassium=excluded.potassium,pm25=excluded.pm25,synced_at=excluded.synced_at",
            params![row.time, row.potassium, row.pm25, batch.unit, SOURCE_URL, synced]).map_err(|e| e.to_string())?;
    }
    put(&tx, "query_through", end)?;
    put(&tx, "last_success", &synced)?;
    tx.commit().map_err(|e| e.to_string())
}
async fn sync(app: &tauri::AppHandle) -> Result<(), String> {
    let monitor = app.state::<Monitor>();
    if monitor.busy.swap(true, Ordering::SeqCst) {
        return Err("小时同步正在进行中".into());
    }
    // A guard releases the lock even if the future is cancelled.
    struct Busy<'a>(&'a AtomicBool);
    impl Drop for Busy<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = Busy(&monitor.busy);
    *monitor.last_attempt.lock().unwrap() = Some(now().format(FORMAT).to_string());
    let result = async {
        let (start, end) = window(&database(app)?)?;
        let bridge = app.state::<Bridge>();
        let (session, tab) = bridge.hourly_target()?;
        let raw = bridge
            .request(
                session,
                tab,
                json!({"type":"jiangsu-hourly", "startTime":start, "endTime":end}),
            )
            .await?;
        let batch: Batch =
            serde_json::from_value(raw).map_err(|_| "小时采集数据格式不正确".to_string())?;
        persist(&mut database(app)?, batch, &start, &end)
    }
    .await;
    *monitor.error.lock().unwrap() = result.as_ref().err().cloned();
    if result.is_ok() {
        // Flight preparation has its own persistent status; a failure must not
        // turn a successful measurement import into a reported sync failure.
        if let Err(error) = crate::flight::after_sync(app).await {
            eprintln!("Flight preparation: {error}");
        }
    }
    result
}
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::flight::initialize(&app) {
            *app.state::<Monitor>().error.lock().unwrap() = Some(error);
            return;
        }
        loop {
            match database(&app).and_then(|db| setting(&db, "enabled")) {
                Ok(value) if value.as_deref() != Some("false") => {
                    let _ = sync(&app).await;
                }
                Err(error) => *app.state::<Monitor>().error.lock().unwrap() = Some(error),
                _ => {}
            }
            tokio::time::sleep(std::time::Duration::from_secs(300)).await;
        }
    });
}
#[tauri::command]
pub fn get_monitoring(
    app: tauri::AppHandle,
    monitor: tauri::State<'_, Monitor>,
) -> Result<MonitorView, String> {
    let db = database(&app)?;
    let mut stmt = db.prepare("SELECT observed_at,potassium,pm25 FROM hourly_observations WHERE city_code='321200' ORDER BY observed_at DESC LIMIT 168").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(HourRow {
                time: row.get(0)?,
                potassium: row.get(1)?,
                pm25: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(MonitorView {
        enabled: setting(&db, "enabled")?.as_deref() != Some("false"),
        syncing: monitor.busy.load(Ordering::SeqCst),
        last_attempt: monitor.last_attempt.lock().unwrap().clone(),
        last_success: setting(&db, "last_success")?,
        error: monitor.error.lock().unwrap().clone(),
        total: db
            .query_row(
                "SELECT COUNT(*) FROM hourly_observations WHERE city_code='321200'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?,
        rows,
        query_through: setting(&db, "query_through")?,
        flight: crate::flight::view(&db)?,
    })
}
#[tauri::command]
pub async fn sync_monitoring(app: tauri::AppHandle) -> Result<(), String> {
    sync(&app).await
}
#[tauri::command]
pub fn set_monitoring_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    put(
        &database(&app)?,
        "enabled",
        if enabled { "true" } else { "false" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn batch(rows: serde_json::Value) -> Batch {
        serde_json::from_value(json!({"url":SOURCE_URL,"city":"泰州市","cityCode":"321200","unit":"μg/m³","dataSource":"A_6","commonSiteType":"30","startTime":"2026-09-16 00:00:00","endTime":"2026-09-17 00:00:00","rows":rows})).unwrap()
    }
    fn save(db: &mut Connection, data: Batch) -> Result<(), String> {
        persist(db, data, "2026-09-16 00:00:00", "2026-09-17 00:00:00")
    }
    #[test]
    fn hourly_upsert_survives_restart_and_invalid_batch_is_atomic() {
        let path = std::env::temp_dir().join(format!("{}.sqlite3", uuid::Uuid::new_v4()));
        let mut db = connect(&path).unwrap();
        save(
            &mut db,
            batch(json!([{"time":"2026-09-16 01:00:00","potassium":0,"pm25":null}])),
        )
        .unwrap();
        save(
            &mut db,
            batch(json!([{"time":"2026-09-16 01:00:00","potassium":1.25,"pm25":25}])),
        )
        .unwrap();
        assert!(save(&mut db,batch(json!([{"time":"2026-09-16 02:00:00","potassium":2,"pm25":30},{"time":"2026-09-16 03:30:00","potassium":3,"pm25":40}]))).is_err());
        assert!(save(
            &mut db,
            batch(json!([{"time":"2026-09-18 00:00:00","potassium":1,"pm25":2}]))
        )
        .is_err());
        let mut wrong = batch(json!([]));
        wrong.city_code = "320100".into();
        assert!(save(&mut db, wrong).is_err());
        drop(db);
        let db = connect(&path).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM hourly_observations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT potassium FROM hourly_observations", [], |r| r
                .get::<_, f64>(0))
                .unwrap(),
            1.25
        );
        assert_eq!(
            setting(&db, "query_through").unwrap().unwrap(),
            "2026-09-17 00:00:00"
        );
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn catchup_advances_in_bounded_overlapping_windows() {
        let db = connect(Path::new(":memory:")).unwrap();
        put(&db, "query_through", "2026-01-01 00:00:00").unwrap();
        let (start, end) = window(&db).unwrap();
        assert_eq!(start, "2025-12-30 00:00:00");
        assert_eq!(end, "2026-01-06 00:00:00");
        for value in [
            "2026-02-30 00:00:00",
            "2026-09-22 01:30:00",
            "2026-9-2 01:00:00",
        ] {
            assert!(parse(value).is_err());
        }
    }
}
