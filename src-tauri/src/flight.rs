use crate::{
    bridge::Bridge,
    monitoring::{database, now, parse, put, setting},
};
use chrono::Duration;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

pub const PLAN_URL: &str = "https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49#/plan";
#[derive(Default)]
pub struct Flight {
    busy: AtomicBool,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    id: String,
    observed_at: String,
    potassium: Option<f64>,
    name: String,
    status: String,
    error: Option<String>,
    preview: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    enabled: bool,
    event: Option<Event>,
    threshold: f64,
}
fn current(db: &Connection) -> Result<Option<Event>, String> {
    setting(db, "flight_event")?
        .map(|s| serde_json::from_str(&s).map_err(|e| format!("计划状态损坏：{e}")))
        .transpose()
}
fn save(db: &Connection, event: &Event) -> Result<(), String> {
    put(
        db,
        "flight_event",
        &serde_json::to_string(event).map_err(|e| e.to_string())?,
    )
}
pub fn view(db: &Connection) -> Result<View, String> {
    Ok(View {
        enabled: setting(db, "flight_enabled")?.as_deref() != Some("false"),
        event: current(db)?,
        threshold: 1.0,
    })
}
pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let db = database(app)?;
    if let Some(mut event) = current(&db)? {
        if event.status == "preparing" {
            event.status = "failed".into();
            event.error = Some("客户端曾中断，请检查原页面后重试；未自动提交。".into());
            save(&db, &event)?;
        }
    }
    Ok(())
}
fn new_event(time: String, potassium: Option<f64>, preview: bool) -> Event {
    let suffix: String = time
        .chars()
        .filter(|c| c.is_ascii_digit())
        .take(10)
        .collect();
    Event {
        id: uuid::Uuid::new_v4().to_string(),
        observed_at: time,
        potassium,
        name: format!(
            "{}-{}-{}",
            if preview {
                "司空填写演练"
            } else {
                "钾离子超标巡查"
            },
            &suffix[..8],
            &suffix[8..]
        ),
        status: "preparing".into(),
        error: None,
        preview,
    }
}
// Called only after a successful, validated hourly import. Normal readings re-arm
// an episode; missing/stale readings cannot reset it or generate historical plans.
fn observe(db: &mut Connection, at: chrono::NaiveDateTime) -> Result<Option<Event>, String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let latest: Option<(String, Option<f64>)> = tx.query_row(
        "SELECT observed_at,potassium FROM hourly_observations WHERE city_code='321200' ORDER BY observed_at DESC LIMIT 1", [],
        |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
    let Some((time, Some(k))) = latest else {
        return Ok(None);
    };
    let age = at - parse(&time)?;
    if age < Duration::zero() || age > Duration::hours(3) {
        return Ok(None);
    }
    if k <= 1.0 {
        put(&tx, "flight_episode", "")?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(None);
    }
    if setting(&tx, "flight_enabled")?.as_deref() == Some("false")
        || setting(&tx, "flight_episode")?.is_some_and(|s| !s.is_empty())
        || current(&tx)?.is_some_and(|e| e.status != "dismissed")
    {
        return Ok(None);
    }
    // Durable hour deduplication survives normal/high revisions to the same hour.
    if setting(&tx, &format!("flight_handled:{time}"))?.is_some() {
        return Ok(None);
    }
    let event = new_event(time.clone(), Some(k), false);
    put(&tx, "flight_episode", &time)?;
    put(&tx, &format!("flight_handled:{time}"), &event.id)?;
    save(&tx, &event)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(event))
}
async fn execute(app: &tauri::AppHandle, mut event: Event) -> Result<(), String> {
    let result = app
        .state::<Bridge>()
        .prepare_flight(&event.id, &event.name)
        .await
        .and_then(|data| {
            if data["status"] != "ready"
                || data["submitted"] != false
                || data["name"] != event.name
                || data["url"] != format!("{PLAN_URL}/create-plan")
            {
                return Err("计划填写回执不匹配；请检查页面。".into());
            }
            Ok(())
        });
    event.status = if result.is_ok() { "ready" } else { "failed" }.into();
    event.error = result.as_ref().err().cloned();
    save(&database(app)?, &event)?;
    result
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
pub async fn after_sync(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Flight>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let _guard = Busy(&state.busy);
    let event = observe(&mut database(app)?, now())?;
    if let Some(event) = event {
        execute(app, event).await?;
    }
    Ok(())
}
#[tauri::command]
pub fn set_flight_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    put(
        &database(&app)?,
        "flight_enabled",
        if enabled { "true" } else { "false" },
    )
}
#[tauri::command]
pub fn dismiss_flight(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Flight>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("计划正在填写，请稍候。".into());
    }
    let _guard = Busy(&state.busy);
    let db = database(&app)?;
    if let Some(mut event) = current(&db)? {
        event.status = "dismissed".into();
        save(&db, &event)?;
    }
    Ok(())
}
#[tauri::command]
pub async fn prepare_flight(app: tauri::AppHandle, preview: bool) -> Result<(), String> {
    let state = app.state::<Flight>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("计划正在填写，请稍候。".into());
    }
    let _guard = Busy(&state.busy);
    let event = {
        let db = database(&app)?;
        let existing = current(&db)?;
        let mut event = if preview {
            if existing.is_some_and(|e| e.status != "dismissed") {
                return Err("请先处理当前计划，再开始填写演练。".into());
            }
            new_event(now().format("%Y-%m-%d %H:00:00").to_string(), None, true)
        } else {
            let event = existing.ok_or("没有可重试的计划。")?;
            if event.status != "failed" {
                return Err("仅允许重试未完成的填写任务。".into());
            }
            event
        };
        event.status = "preparing".into();
        event.error = None;
        save(&db, &event)?;
        event
    };
    execute(&app, event).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        crate::monitoring::connect(std::path::Path::new(":memory:")).unwrap()
    }
    fn reading(db: &Connection, time: &str, k: Option<f64>) {
        db.execute("INSERT OR REPLACE INTO hourly_observations VALUES ('321200',?,?,100,'μg/m³','source','A_6','30','sync')", rusqlite::params![time,k]).unwrap();
    }
    fn dismiss(db: &Connection) {
        let mut e = current(db).unwrap().unwrap();
        e.status = "dismissed".into();
        save(db, &e).unwrap();
    }
    #[test]
    fn threshold_missing_history_and_episodes() {
        let mut db = db();
        let t = parse("2026-09-22 10:00:00").unwrap();
        reading(&db, "2026-09-21 10:00:00", Some(8.));
        assert!(observe(&mut db, t).unwrap().is_none());
        reading(&db, "2026-09-22 09:00:00", Some(1.));
        assert!(observe(&mut db, t).unwrap().is_none());
        reading(&db, "2026-09-22 09:00:00", None);
        assert!(observe(&mut db, t).unwrap().is_none());
        reading(&db, "2026-09-22 09:00:00", Some(1.01));
        let event = observe(&mut db, t).unwrap().unwrap();
        assert_eq!(event.name, "钾离子超标巡查-20260922-09");
        assert!(observe(&mut db, t).unwrap().is_none());
        dismiss(&db);
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t).unwrap().is_none());
        reading(&db, "2026-09-22 10:00:00", None);
        assert!(observe(&mut db, t).unwrap().is_none());
        reading(&db, "2026-09-22 10:00:00", Some(0.5));
        observe(&mut db, t).unwrap();
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t).unwrap().is_some());
        dismiss(&db);
        reading(&db, "2026-09-22 10:00:00", Some(0.5));
        observe(&mut db, t).unwrap();
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t).unwrap().is_none());
    }
    #[test]
    fn paused_and_unresolved_plans_block_new_events() {
        let mut db = db();
        let t = parse("2026-09-22 10:00:00").unwrap();
        reading(&db, "2026-09-22 09:00:00", Some(2.));
        put(&db, "flight_enabled", "false").unwrap();
        assert!(observe(&mut db, t).unwrap().is_none());
        put(&db, "flight_enabled", "true").unwrap();
        assert!(observe(&mut db, t).unwrap().is_some());
        reading(&db, "2026-09-22 10:00:00", Some(0.));
        observe(&mut db, t).unwrap();
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t).unwrap().is_none());
        dismiss(&db);
        assert!(observe(&mut db, t).unwrap().is_some());
    }
}
