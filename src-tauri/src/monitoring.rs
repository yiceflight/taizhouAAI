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

#[cfg(test)]
pub const SOURCE_URL: &str =
    "http://61.155.4.60:18080/#/particle-analysis/feature-analysis/time-series";
pub fn source_page(url: &str) -> bool {
    tauri::Url::parse(url).is_ok_and(|u| {
        u.origin().ascii_serialization() == "http://61.155.4.60:18080"
            && ![u.path(), u.fragment().unwrap_or("")].iter().any(|part| {
                part.split(['/', '?', '#']).any(|segment| {
                    segment.eq_ignore_ascii_case("login") || segment.eq_ignore_ascii_case("signin")
                })
            })
    })
}
const FORMAT: &str = "%Y-%m-%d %H:%M:%S";
#[derive(Default)]
pub struct Monitor {
    busy: AtomicBool,
    last_attempt: Mutex<Option<String>>,
    error: Mutex<Option<String>>,
}
impl Monitor {
    pub(crate) fn reset(&self) {
        *self.last_attempt.lock().unwrap() = None;
        *self.error.lock().unwrap() = None;
    }
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
    weather: crate::weather::View,
    settings: crate::settings::Settings,
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
        CREATE TABLE IF NOT EXISTS monitor_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS flight_mission_reasons (
            mission_id INTEGER PRIMARY KEY CHECK(mission_id > 0),
            reason TEXT NOT NULL,
            updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS flight_mission_weather (
            mission_id INTEGER PRIMARY KEY CHECK(mission_id > 0),
            start_time INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL);",
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
fn current_hour() -> NaiveDateTime {
    now()
        .with_minute(0)
        .unwrap()
        .with_second(0)
        .unwrap()
        .with_nanosecond(0)
        .unwrap()
}
fn window(db: &Connection) -> Result<(String, String), String> {
    let end_now = current_hour();
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
fn requested_window(range: &str) -> Result<(String, String), String> {
    let end = current_hour();
    let start = match range {
        "today" => end.date().and_hms_opt(0, 0, 0).unwrap(),
        "24" => end - Duration::hours(23),
        "72" => end - Duration::hours(71),
        "168" => end - Duration::hours(167),
        _ => return Err("时间范围无效，请重新选择 24 小时、3 天或 7 天。".into()),
    };
    Ok((
        start.format(FORMAT).to_string(),
        end.format(FORMAT).to_string(),
    ))
}
fn persist(db: &mut Connection, batch: Batch, start: &str, end: &str, advance_cursor: bool) -> Result<(), String> {
    if !source_page(&batch.url)
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
            potassium=COALESCE(excluded.potassium,hourly_observations.potassium),pm25=COALESCE(excluded.pm25,hourly_observations.pm25),source_url=excluded.source_url,synced_at=excluded.synced_at",
            params![row.time, row.potassium, row.pm25, batch.unit, batch.url, synced]).map_err(|e| e.to_string())?;
    }
    if advance_cursor {
        put(&tx, "query_through", end)?;
    }
    put(&tx, "last_success", &synced)?;
    tx.commit().map_err(|e| e.to_string())
}
async fn sync(
    app: &tauri::AppHandle,
    trigger_flight: bool,
    requested_range: Option<&str>,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let attempt = uuid::Uuid::new_v4().to_string();
    crate::runtime_log::record(
        app,
        "info",
        "monitoring",
        "sync.started",
        "开始同步小时监测数据",
        json!({"attemptId":attempt,"evaluateFlightAfterSync":trigger_flight}),
    );
    let result = sync_inner(app, trigger_flight, requested_range).await;
    crate::runtime_log::record(
        app,
        if result.is_ok() { "info" } else { "error" },
        "monitoring",
        "sync.finished",
        if result.is_ok() {
            "小时监测数据同步完成"
        } else {
            "小时监测数据同步失败"
        },
        json!({"attemptId":attempt,"elapsedMs":started.elapsed().as_millis() as u64,"error":result.as_ref().err()}),
    );
    result
}
async fn sync_inner(
    app: &tauri::AppHandle,
    trigger_flight: bool,
    requested_range: Option<&str>,
) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
    crate::readiness::require_monitoring(app, false)?;
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
        let db = database(app)?;
        let (start, end) = match requested_range {
            Some(range) => requested_window(range)?,
            None => window(&db)?,
        };
        let bridge = app.state::<Bridge>();
        let readiness = crate::readiness::view(app);
        let verified = readiness
            .sites
            .iter()
            .find(|site| site.id == "map" && site.state == "ready")
            .ok_or("江苏大气站尚未通过 API 验证，请重新验证登录状态。")?;
        let (session, tab) = bridge.hourly_target(verified)?;
        let raw = bridge
            .request(
                session,
                tab,
                json!({"type":"jiangsu-hourly", "startTime":start, "endTime":end}),
            )
            .await?;
        let batch: Batch =
            serde_json::from_value(raw).map_err(|_| "小时采集数据格式不正确".to_string())?;
        let count = batch.rows.len();
        persist(&mut database(app)?, batch, &start, &end, requested_range.is_none())?;
        crate::runtime_log::record(
            app,
            "info",
            "monitoring",
            "sync.persisted",
            "监测数据已写入本机",
            json!({"from":start,"through":end,"rows":count}),
        );
        Ok(())
    }
    .await;
    *monitor.error.lock().unwrap() = result.as_ref().err().cloned();
    if result.is_ok() && trigger_flight {
        // Flight preparation has its own persistent status; a failure must not
        // turn a successful measurement import into a reported sync failure.
        if let Err(error) = crate::flight::after_sync(app).await {
            crate::runtime_log::record(
                app,
                "error",
                "flight",
                "flight.prepare_error",
                "同步后巡查准备失败",
                json!({"error":error}),
            );
            eprintln!("Flight preparation: {error}");
        }
    }
    result
}
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            match database(&app).and_then(|db| setting(&db, "enabled")) {
                Ok(value) if value.as_deref() != Some("false") => {
                    if app
                        .state::<crate::readiness::Readiness>()
                        .started
                        .load(Ordering::SeqCst)
                    {
                        let _ = crate::readiness::refresh(&app).await;
                        match crate::readiness::require_monitoring(&app, true) {
                            Ok(()) => {
                                let _ = sync(&app, true, None).await;
                            }
                            Err(error) => crate::runtime_log::record(
                                &app,
                                "warning",
                                "monitoring",
                                "sync.skipped",
                                "定时同步未执行：运行条件未就绪",
                                json!({"reason":error}),
                            ),
                        }
                    } else {
                        crate::runtime_log::record(
                            &app,
                            "warning",
                            "monitoring",
                            "sync.skipped",
                            "定时同步未执行：监测尚未启动",
                            json!({}),
                        );
                    }
                }
                Err(error) => {
                    crate::runtime_log::record(
                        &app,
                        "error",
                        "monitoring",
                        "sync.settings_error",
                        "无法读取监测设置",
                        json!({"error":error}),
                    );
                    *app.state::<Monitor>().error.lock().unwrap() = Some(error);
                }
                _ => crate::runtime_log::record(
                    &app,
                    "info",
                    "monitoring",
                    "sync.skipped",
                    "定时同步未执行：监测已关闭",
                    json!({}),
                ),
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
    let _access = crate::data_reset::access(&app)?;
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
        weather: crate::weather::view(&app),
        settings: crate::settings::read(&db)?,
    })
}
pub async fn verify_first_sync(app: &tauri::AppHandle) -> Result<(), String> {
    sync(app, false, None).await
}

/// Recheck the current monitoring window after the operating system wakes up.
/// Tokio's timer is not a reliable wake-up signal across sleep/lock, so use
/// the same sync path as the regular background loop when the workspace is on.
pub async fn resume_sync(app: &tauri::AppHandle) -> Result<(), String> {
    let enabled = database(app).and_then(|db| setting(&db, "enabled"))?;
    if enabled.as_deref() == Some("false")
        || !app
            .state::<crate::readiness::Readiness>()
            .started
            .load(Ordering::SeqCst)
    {
        return Ok(());
    }
    sync(app, true, None).await
}
#[tauri::command]
pub async fn sync_monitoring(
    app: tauri::AppHandle,
    range: Option<String>,
) -> Result<(), String> {
    crate::readiness::require_monitoring(&app, false)?;
    let trigger_flight = app
        .state::<crate::readiness::Readiness>()
        .started
        .load(Ordering::SeqCst);
    sync(&app, trigger_flight, range.as_deref()).await
}
#[tauri::command]
pub fn set_monitoring_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
    if enabled {
        crate::readiness::require_monitoring(&app, false)?;
    }
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
        persist(db, data, "2026-09-16 00:00:00", "2026-09-17 00:00:00", true)
    }
    #[test]
    fn api_batches_accept_map_and_reject_login_and_foreign_origins() {
        let mut db = connect(Path::new(":memory:")).unwrap();
        let mut data = batch(json!([{ "time": "2026-09-16 01:00:00", "potassium": 0.38 }]));
        data.url = "http://61.155.4.60:18080/#/home/map".into();
        save(&mut db, data).unwrap();
        assert_eq!(
            db.query_row("SELECT source_url FROM hourly_observations", [], |r| r
                .get::<_, String>(
                0
            ))
            .unwrap(),
            "http://61.155.4.60:18080/#/home/map"
        );
        for url in [
            "http://61.155.4.60:18080/#/login",
            "http://61.155.4.60:18080/login",
            "http://61.155.4.60.evil.test:18080/#/home/map",
            "https://61.155.4.60:18080/#/home/map",
        ] {
            let mut data = batch(json!([]));
            data.url = url.into();
            assert!(save(&mut db, data).is_err());
        }
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
        assert_eq!(
            db.query_row("SELECT pm25 FROM hourly_observations", [], |r| r
                .get::<_, Option<f64>>(0))
                .unwrap(),
            Some(25.0)
        );
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
    fn latest_missing_hours_are_persisted_and_later_backfilled_without_duplicates() {
        let mut db = connect(Path::new(":memory:")).unwrap();
        save(
            &mut db,
            batch(json!([
                {"time":"2026-09-16 11:00:00","potassium":0.03},
                {"time":"2026-09-16 12:00:00","potassium":null},
                {"time":"2026-09-16 13:00:00","potassium":null},
                {"time":"2026-09-16 14:00:00","potassium":null}
            ])),
        )
        .unwrap();
        let latest = |db: &Connection| {
            db.query_row(
            "SELECT observed_at,potassium FROM hourly_observations ORDER BY observed_at DESC LIMIT 1",
            [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<f64>>(1)?))
        ).unwrap()
        };
        assert_eq!(latest(&db), ("2026-09-16 14:00:00".into(), None));
        assert!(setting(&db, "last_success").unwrap().is_some());
        assert_eq!(
            setting(&db, "query_through").unwrap().as_deref(),
            Some("2026-09-17 00:00:00")
        );
        save(
            &mut db,
            batch(json!([
                {"time":"2026-09-16 12:00:00","potassium":null},
                {"time":"2026-09-16 13:00:00","potassium":null},
                {"time":"2026-09-16 14:00:00","potassium":null}
            ])),
        )
        .unwrap();
        assert_eq!(latest(&db), ("2026-09-16 14:00:00".into(), None));
        save(
            &mut db,
            batch(json!([{"time":"2026-09-16 14:00:00","potassium":0.0}])),
        )
        .unwrap();
        assert_eq!(latest(&db), ("2026-09-16 14:00:00".into(), Some(0.0)));
        save(
            &mut db,
            batch(json!([{"time":"2026-09-16 14:00:00","potassium":null}])),
        )
        .unwrap();
        assert_eq!(latest(&db), ("2026-09-16 14:00:00".into(), Some(0.0)));
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM hourly_observations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            4
        );
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

    #[test]
    fn initial_window_is_dynamic_seven_days_ending_at_current_hour() {
        let db = connect(Path::new(":memory:")).unwrap();
        let (start, end) = window(&db).unwrap();
        let start = parse(&start).unwrap();
        let end = parse(&end).unwrap();
        let current = now();
        assert_eq!(end - start, Duration::days(7));
        assert!(end <= current);
        assert!(current - end <= Duration::hours(1));
    }

    #[test]
    fn requested_window_uses_the_selected_range_and_current_hour() {
        for (range, expected_hours) in [("24", 23), ("72", 71), ("168", 167)] {
            let (start, end) = requested_window(range).unwrap();
            let start = parse(&start).unwrap();
            let end = parse(&end).unwrap();
            assert_eq!(end - start, Duration::hours(expected_hours));
            assert!(end <= now());
        }
        let (start, end) = requested_window("today").unwrap();
        let start = parse(&start).unwrap();
        let end = parse(&end).unwrap();
        assert_eq!(start.date(), end.date());
        assert_eq!(start.time().hour(), 0);
        assert!(end >= start);
        assert!(requested_window("12").is_err());
    }

    #[test]
    fn manual_ranges_preserve_backfill_cursor_and_initial_seven_day_window() {
        for range in ["today","24","72","168"] {
            let mut db=connect(Path::new(":memory:")).unwrap();
            let old=(current_hour()-Duration::days(20)).format(FORMAT).to_string();
            let (start,end)=requested_window(range).unwrap();
            let make=|| Batch {url:SOURCE_URL.into(),city:"泰州市".into(),city_code:"321200".into(),unit:"μg/m³".into(),data_source:"A_6".into(),common_site_type:"30".into(),start_time:start.clone(),end_time:end.clone(),rows:vec![HourRow{time:end.clone(),potassium:Some(1.5),pm25:None}]};
            persist(&mut db,make(),&start,&end,false).unwrap();
            assert_eq!(setting(&db,"query_through").unwrap(),None);
            assert_eq!(parse(&window(&db).unwrap().1).unwrap()-parse(&window(&db).unwrap().0).unwrap(),Duration::days(7));
            put(&db,"query_through",&old).unwrap();
            let before=window(&db).unwrap();
            persist(&mut db,make(),&start,&end,false).unwrap();
            assert_eq!(setting(&db,"query_through").unwrap().as_deref(),Some(old.as_str()));
            assert_eq!(window(&db).unwrap(),before);
            assert!(setting(&db,"last_success").unwrap().is_some());
            assert_eq!(db.query_row("SELECT COUNT(*) FROM hourly_observations",[],|r|r.get::<_,i64>(0)).unwrap(),1);
            let (a,b)=before;
            let mut automatic=make(); automatic.start_time=a.clone();automatic.end_time=b.clone();automatic.rows.clear();
            persist(&mut db,automatic,&a,&b,true).unwrap();
            assert_eq!(setting(&db,"query_through").unwrap().as_deref(),Some(b.as_str()));
        }
    }

}
