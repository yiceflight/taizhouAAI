use crate::{flight::Flight, monitoring, readiness::Readiness, runtime_log::RuntimeLog};
use std::path::Path;
use tauri::Manager;

const MONITORING_DB: &str = "monitoring.sqlite3";
const REPORTS_DIR: &str = "reports";
const RUNTIME_LOG_EXPORTS_DIR: &str = "runtime-log-exports";
const PHOTO_REVIEWS: &str = "report-photo-reviews.json";

fn remove_child(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => {
            std::fs::remove_dir_all(path).map_err(|e| format!("删除 {} 失败：{e}", path.display()))?;
            Ok(true)
        }
        Ok(_) => {
            std::fs::remove_file(path).map_err(|e| format!("删除 {} 失败：{e}", path.display()))?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("读取 {} 失败：{error}", path.display())),
    }
}

fn clear_known_files(app_data: &Path) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();
    for name in [REPORTS_DIR, RUNTIME_LOG_EXPORTS_DIR, PHOTO_REVIEWS] {
        let path = app_data.join(name);
        if remove_child(&path)? {
            removed.push(name.to_owned());
        }
    }
    Ok(removed)
}

fn clear_monitoring_database(path: &Path) -> Result<(), String> {
    let mut db = monitoring::connect(path)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS dji_report_tasks (
            task_key TEXT PRIMARY KEY, payload TEXT NOT NULL
        );
        DELETE FROM hourly_observations;
        DELETE FROM monitor_settings;
        DELETE FROM flight_mission_reasons;
        DELETE FROM flight_mission_weather;
        DELETE FROM dji_report_tasks;",
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
        .map_err(|e| e.to_string())
}

fn clear_data_at(app_data: &Path, runtime_log: &RuntimeLog) -> Result<(), String> {
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    clear_monitoring_database(&app_data.join(MONITORING_DB))?;
    runtime_log.clear()?;
    clear_known_files(app_data)?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearDataResult {
    pub cleared: bool,
}

#[tauri::command]
pub fn clear_all_data(
    app: tauri::AppHandle,
    confirmed: bool,
) -> Result<ClearDataResult, String> {
    if !confirmed {
        return Err("请先确认清空数据。".into());
    }
    let monitor = app.state::<monitoring::Monitor>();
    let flight = app.state::<Flight>();
    if monitor.is_busy() || flight.is_busy() {
        return Err("当前仍有同步或巡查操作正在进行，请稍后再清空数据。".into());
    }
    let _gate = flight.gate.lock().map_err(|_| "无法锁定巡查状态")?;
    if monitor.is_busy() || flight.is_busy() {
        return Err("当前仍有同步或巡查操作正在进行，请稍后再清空数据。".into());
    }

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let runtime_log = app.state::<RuntimeLog>();
    clear_data_at(&app_data, &runtime_log)?;
    monitor.reset();
    app.state::<Readiness>().reset_workspace();
    Ok(ClearDataResult { cleared: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};
    use std::path::PathBuf;

    const RUNTIME_LOG_DB: &str = "runtime-logs.sqlite3";

    fn temp_app_data() -> PathBuf {
        let path = std::env::temp_dir().join(format!("taizhou-aai-reset-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn clears_database_and_known_downloads_but_preserves_unrelated_files() {
        let root = temp_app_data();
        let db_path = root.join(MONITORING_DB);
        let db = monitoring::connect(&db_path).unwrap();
        db.execute("INSERT INTO hourly_observations(city_code,observed_at,potassium,pm25,unit,source_url,data_source,common_site_type,synced_at) VALUES ('321200','2026-10-16 10:00:00',1.0,20.0,'μg/m³','http://61.155.4.60:18080/','A_6','30','2026-10-16 10:00:00')", []).unwrap();
        monitoring::put(&db, "query_through", "2026-10-16 10:00:00").unwrap();
        drop(db);
        std::fs::create_dir_all(root.join(REPORTS_DIR).join("flight")).unwrap();
        std::fs::write(root.join(REPORTS_DIR).join("flight/source.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join(RUNTIME_LOG_EXPORTS_DIR)).unwrap();
        std::fs::write(root.join(PHOTO_REVIEWS), "{}").unwrap();
        std::fs::write(root.join("keep-me.txt"), "keep").unwrap();

        // The runtime log DB is initialized separately by the running app. This
        // fixture verifies the same table cleanup primitive without an AppHandle.
        let runtime_path = root.join(RUNTIME_LOG_DB);
        let runtime = Connection::open(&runtime_path).unwrap();
        runtime.execute_batch("CREATE TABLE runtime_logs (id INTEGER PRIMARY KEY, at INTEGER, session TEXT, level TEXT, category TEXT, event TEXT, message TEXT, details TEXT);").unwrap();
        runtime.execute("INSERT INTO runtime_logs VALUES (1,?,?,?,?,?,?,?)", params![1_i64, "s", "info", "test", "event", "message", "{}"]).unwrap();
        drop(runtime);

        clear_monitoring_database(&db_path).unwrap();
        let db = monitoring::connect(&db_path).unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM hourly_observations", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(monitoring::setting(&db, "query_through").unwrap(), None);
        drop(db);
        clear_known_files(&root).unwrap();
        assert!(!root.join(REPORTS_DIR).exists());
        assert!(!root.join(RUNTIME_LOG_EXPORTS_DIR).exists());
        assert!(!root.join(PHOTO_REVIEWS).exists());
        assert!(root.join("keep-me.txt").exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
