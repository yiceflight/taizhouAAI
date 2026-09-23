use crate::{
    bridge::Bridge,
    monitoring::{database, now, parse, put, setting},
};
use chrono::Duration;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use tauri::Manager;

pub const PLAN_URL: &str = "https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49#/plan";
#[derive(Default)]
pub struct Flight {
    busy: AtomicBool,
    gate: Mutex<()>,
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
    #[serde(default)]
    source: String,
    #[serde(default)]
    launch_at: Option<i64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    enabled: bool,
    event: Option<Event>,
    threshold: f64,
    delay_minutes: u32,
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
fn enabled(db: &Connection) -> Result<bool, String> {
    // Legacy permission covered form filling only. Actual automatic submission is opt-in.
    Ok(setting(db, "flight_launch_enabled")?.as_deref() == Some("true"))
}
fn delay(db: &Connection) -> Result<u32, String> {
    let settings = crate::settings::read(db)?;
    Ok(if settings.require_manual_confirmation { 0 } else { settings.takeoff_delay_minutes })
}
fn needs_confirmation(db: &Connection, event: &Event) -> Result<bool, String> {
    Ok(event.preview || (event.source == "auto" && crate::settings::read(db)?.require_manual_confirmation))
}
fn terminal(event: &Event) -> bool { matches!(event.status.as_str(), "dismissed" | "canceled") }
pub fn view(db: &Connection) -> Result<View, String> {
    Ok(View { enabled: enabled(db)?, event: current(db)?, threshold: crate::settings::read(db)?.potassium_threshold, delay_minutes: delay(db)? })
}
fn recover(db: &Connection) -> Result<(), String> {
    if let Some(mut event) = current(db)? {
        match event.status.as_str() {
            "countdown" => { event.status = "canceled".into(); event.error = Some("客户端重启，已取消原倒计时。".into()); }
            "preparing" => { event.status = "failed".into(); event.error = Some("客户端中断，未发送起飞请求；请核查原计划。".into()); }
            "submitting" => { event.status = "uncertain".into(); event.error = Some("提交期间客户端中断，请到司空核查，勿重复起飞。".into()); }
            _ => return Ok(()),
        }
        event.launch_at = None;
        save(db, &event)?;
    }
    Ok(())
}
pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> { recover(&database(app)?) }
fn new_event(time: String, potassium: Option<f64>, preview: bool) -> Event {
    let suffix: String = time.chars().filter(|c| c.is_ascii_digit()).take(10).collect();
    Event { id: uuid::Uuid::new_v4().to_string(), observed_at: time, potassium,
        name: format!("{}-{}-{}", if preview { "司空填写演练" } else { "钾离子超标巡查" }, &suffix[..8], &suffix[8..]),
        status: "preparing".into(), error: None, preview, source: if preview { "preview" } else { "auto" }.into(), launch_at: None }
}
fn observe(db: &mut Connection, at: chrono::NaiveDateTime, weather_allowed: bool) -> Result<Option<Event>, String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let latest: Option<(String, Option<f64>)> = tx.query_row(
        "SELECT observed_at,potassium FROM hourly_observations WHERE city_code='321200' ORDER BY observed_at DESC LIMIT 1", [],
        |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
    let Some((time, Some(k))) = latest else { return Ok(None); };
    let age = at - parse(&time)?;
    if age < Duration::zero() || age > Duration::hours(3) { return Ok(None); }
    if k <= crate::settings::read(&tx)?.potassium_threshold {
        put(&tx, "flight_episode", "")?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(None);
    }
    if !weather_allowed || !enabled(&tx)? || setting(&tx, "flight_episode")?.is_some_and(|s| !s.is_empty())
        || current(&tx)?.is_some_and(|e| !terminal(&e))
        || setting(&tx, &format!("flight_handled:{time}"))?.is_some() { return Ok(None); }
    let mut event = new_event(time.clone(), Some(k), false);
    event.status = "countdown".into();
    event.launch_at = Some((at - Duration::hours(8)).and_utc().timestamp_millis() + i64::from(delay(&tx)?) * 60000);
    put(&tx, "flight_episode", &time)?;
    put(&tx, &format!("flight_handled:{time}"), &event.id)?;
    save(&tx, &event)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(event))
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }
fn update_current(app: &tauri::AppHandle, event: &Event) -> Result<bool, String> {
    let state = app.state::<Flight>();
    let _gate = state.gate.lock().unwrap();
    let db = database(app)?;
    if current(&db)?.is_some_and(|e| e.id == event.id && !terminal(&e)) { save(&db, event)?; Ok(true) } else { Ok(false) }
}
async fn execute(app: &tauri::AppHandle, mut event: Event) -> Result<(), String> {
    if let Err(error) = crate::weather::require_suitable(app).await {
        event.status = "failed".into(); event.error = Some(error.clone());
        update_current(app, &event)?; return Err(error);
    }
    let preparation = app.state::<Bridge>().prepare_flight(&event.id, &event.name).await.and_then(|data| {
        if data["status"] != "ready" || data["submitted"] != false || data["name"] != event.name || data["url"] != format!("{PLAN_URL}/create-plan") {
            Err("计划填写回执不匹配；未发送起飞请求。".into())
        } else { Ok(()) }
    });
    if let Err(error) = preparation {
        event.status = "failed".into(); event.error = Some(error.clone());
        update_current(app, &event)?; return Err(error);
    }
    if needs_confirmation(&database(app)?, &event)? {
        event.status = "ready".into(); update_current(app, &event)?; return Ok(());
    }
    if let Err(error) = crate::weather::require_suitable(app).await {
        event.status = "failed".into(); event.error = Some(error.clone());
        update_current(app, &event)?; return Err(error);
    }
    // Cancel can win while preparation awaits Chrome. The short gate is held only
    // across the persisted claim, never across browser I/O.
    {
        let state = app.state::<Flight>();
        let _gate = state.gate.lock().unwrap();
        let db = database(app)?;
        if !current(&db)?.is_some_and(|e| e.id == event.id && e.status == "preparing") { return Ok(()); }
        if let Err(error) = crate::readiness::require_started(app) {
            event.status = "failed".into(); event.error = Some(error.clone()); save(&db, &event)?; return Err(error);
        }
        if needs_confirmation(&db, &event)? { event.status = "ready".into(); save(&db, &event)?; return Ok(()); }
        event.status = "submitting".into(); save(&db, &event)?;
    }
    let result = app.state::<Bridge>().submit_flight(&event.id, &event.name).await;
    match result {
        Ok(data) if data["status"] == "submitted" && data["submitted"] == true && data["name"] == event.name => {
            event.status = "submitted".into(); event.error = None;
        }
        Ok(_) => { event.status = "uncertain".into(); event.error = Some("未获得可核对的提交回执，请到司空核查；不会自动重试。".into()); }
        Err(error) => { event.status = "uncertain".into(); event.error = Some(format!("{error} 请到司空核查；不会自动重试。")); }
    }
    update_current(app, &event)?;
    Ok(())
}
pub async fn after_sync(app: &tauri::AppHandle) -> Result<(), String> {
    crate::weather::refresh(app, false).await;
    let state = app.state::<Flight>();
    let _gate = state.gate.lock().unwrap();
    observe(&mut database(app)?, now(), crate::weather::view(app).allowed)?;
    Ok(())
}
fn claim_due(db: &Connection, at: i64) -> Result<Option<Event>, String> {
    let Some(mut event) = current(db)? else { return Ok(None); };
    if event.status != "countdown" { return Ok(None); }
    // Switching to manual confirmation also releases an existing delay.
    if !needs_confirmation(db, &event)? && !event.launch_at.is_some_and(|deadline| deadline <= at) { return Ok(None); }
    if !enabled(db)? {
        event.status = "canceled".into(); event.launch_at = None; save(db, &event)?; return Ok(None);
    }
    event.status = "preparing".into(); event.launch_at = None; save(db, &event)?;
    Ok(Some(event))
}
async fn tick(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Flight>();
    if state.busy.swap(true, Ordering::SeqCst) { return Ok(()); }
    let _busy = Busy(&state.busy);
    let pending = {
        let _gate = state.gate.lock().unwrap();
        claim_due(&database(app)?, chrono::Utc::now().timestamp_millis())?
    };
    if let Some(mut event) = pending {
        if let Err(error) = crate::readiness::require_started(app) {
            event.status = "failed".into(); event.error = Some(format!("起飞前检查失败：{error}")); update_current(app, &event)?;
        } else { execute(app, event).await?; }
    }
    Ok(())
}
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = tick(&app).await { eprintln!("Flight task: {error}"); }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}
fn cancel(db: &Connection, id: &str) -> Result<(), String> {
    let mut event = current(db)?.ok_or("没有待取消的任务。")?;
    if event.id != id { return Err("任务已变化，请刷新后重试。".into()); }
    if !matches!(event.status.as_str(), "countdown" | "preparing") { return Err("任务已进入提交阶段或已结束，请在司空核查。".into()); }
    event.status = "canceled".into(); event.launch_at = None; event.error = None; save(db, &event)
}
#[tauri::command]
pub fn cancel_flight(app: tauri::AppHandle, event_id: String) -> Result<(), String> {
    let state = app.state::<Flight>(); let _gate = state.gate.lock().unwrap(); cancel(&database(&app)?, &event_id)
}
#[tauri::command]
pub fn set_flight_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if enabled { crate::readiness::require_started(&app)?; }
    let state = app.state::<Flight>(); let _gate = state.gate.lock().unwrap();
    let mut db = database(&app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    put(&tx, "flight_launch_enabled", if enabled { "true" } else { "false" })?;
    if !enabled {
        if let Some(event) = current(&tx)? {
            if event.source == "auto" && matches!(event.status.as_str(), "countdown" | "preparing") { cancel(&tx, &event.id)?; }
        }
    }
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn set_flight_delay(app: tauri::AppHandle, minutes: u32) -> Result<(), String> {
    crate::settings::set_delay(&database(&app)?, minutes)
}
#[tauri::command]
pub fn dismiss_flight(app: tauri::AppHandle, event_id: String) -> Result<(), String> {
    let state = app.state::<Flight>(); let _gate = state.gate.lock().unwrap();
    let db = database(&app)?;
    if let Some(mut event) = current(&db)? {
        if event.id != event_id { return Err("任务已变化，请刷新后重试。".into()); }
        if matches!(event.status.as_str(), "countdown" | "preparing" | "submitting") { return Err("任务尚在执行，请取消或等待提交结果。".into()); }
        event.status = "dismissed".into(); save(&db, &event)?;
    }
    Ok(())
}
fn begin_manual(db: &Connection, preview: bool) -> Result<Event, String> {
    if current(db)?.is_some_and(|e| !terminal(&e)) { return Err("请先处理当前巡飞任务。".into()); }
    let mut event = new_event(now().format("%Y-%m-%d %H:00:00").to_string(), None, preview);
    if !preview { event.source = "manual".into(); event.name = format!("{}-{}", event.name.replace("钾离子超标巡查", "手动巡查"), &event.id[..8]); }
    save(db, &event)?; Ok(event)
}
async fn begin(app: tauri::AppHandle, preview: bool) -> Result<(), String> {
    crate::readiness::require_started(&app)?;
    let state = app.state::<Flight>();
    if state.busy.swap(true, Ordering::SeqCst) { return Err("巡飞任务正在处理，请稍候。".into()); }
    let event = {
        let _gate = state.gate.lock().unwrap();
        database(&app).and_then(|db| begin_manual(&db, preview))
    };
    let event = match event { Ok(event) => event, Err(error) => { state.busy.store(false, Ordering::SeqCst); return Err(error); } };
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Flight>();
        let _busy = Busy(&state.busy);
        if let Err(error) = execute(&app, event).await { eprintln!("Flight task: {error}"); }
    });
    Ok(())
}
#[tauri::command]
pub async fn launch_flight(app: tauri::AppHandle) -> Result<(), String> { begin(app, false).await }
#[tauri::command]
pub async fn prepare_flight(app: tauri::AppHandle, preview: bool) -> Result<(), String> {
    if !preview { return Err("请核查并归档原任务后，重新发起手动起飞。".into()); }
    begin(app, true).await
}
#[tauri::command]
pub async fn open_prepared_flight(app: tauri::AppHandle) -> Result<(), String> {
    let event = current(&database(&app)?)?.ok_or("没有待查看的巡查计划。")?;
    let bridge = app.state::<Bridge>();
    let snapshot = bridge.status();
    if snapshot.error.is_some()
        || snapshot.clients != 1
        || snapshot
            .versions
            .iter()
            .any(|v| !crate::readiness::compatible(v))
    {
        return Err("请先恢复唯一的 Chrome 插件连接，再查看原计划页面。".into());
    }
    let session = snapshot
        .tabs
        .first()
        .ok_or("未找到原计划所在的 Chrome 会话。")?
        .session
        .clone();
    bridge
        .request(
            session,
            -1,
            serde_json::json!({"type":"dji-open-prepared","eventId":event.id,"submit":false}),
        )
        .await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let db = crate::monitoring::connect(std::path::Path::new(":memory:")).unwrap();
        put(&db, "flight_launch_enabled", "true").unwrap();
        db
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
        assert!(observe(&mut db, t, true).unwrap().is_none());
        reading(&db, "2026-09-22 09:00:00", Some(1.));
        assert!(observe(&mut db, t, true).unwrap().is_none());
        reading(&db, "2026-09-22 09:00:00", None);
        assert!(observe(&mut db, t, true).unwrap().is_none());
        reading(&db, "2026-09-22 09:00:00", Some(1.01));
        let event = observe(&mut db, t, true).unwrap().unwrap();
        assert_eq!(event.name, "钾离子超标巡查-20260922-09");
        assert!(observe(&mut db, t, true).unwrap().is_none());
        dismiss(&db);
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t, true).unwrap().is_none());
        reading(&db, "2026-09-22 10:00:00", None);
        assert!(observe(&mut db, t, true).unwrap().is_none());
        reading(&db, "2026-09-22 10:00:00", Some(0.5));
        observe(&mut db, t, true).unwrap();
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t, true).unwrap().is_some());
        dismiss(&db);
        reading(&db, "2026-09-22 10:00:00", Some(0.5));
        observe(&mut db, t, true).unwrap();
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t, true).unwrap().is_none());
    }
    #[test]
    fn weather_block_does_not_consume_episode_and_normal_data_rearms() {
        let mut db = db();
        let t = parse("2026-09-22 10:00:00").unwrap();
        reading(&db, "2026-09-22 09:00:00", Some(2.));
        assert!(observe(&mut db, t, false).unwrap().is_none());
        assert!(current(&db).unwrap().is_none());
        assert!(observe(&mut db, t, true).unwrap().is_some());
        dismiss(&db);
        reading(&db, "2026-09-22 10:00:00", Some(0.));
        observe(&mut db, t, false).unwrap();
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t, false).unwrap().is_none());
        assert!(observe(&mut db, t, true).unwrap().is_some());
    }
    #[test]
    fn paused_and_unresolved_plans_block_new_events() {
        let mut db = db();
        let t = parse("2026-09-22 10:00:00").unwrap();
        reading(&db, "2026-09-22 09:00:00", Some(2.));
        put(&db, "flight_launch_enabled", "false").unwrap();
        assert!(observe(&mut db, t, true).unwrap().is_none());
        put(&db, "flight_launch_enabled", "true").unwrap();
        assert!(observe(&mut db, t, true).unwrap().is_some());
        reading(&db, "2026-09-22 10:00:00", Some(0.));
        observe(&mut db, t, true).unwrap();
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t, true).unwrap().is_none());
        dismiss(&db);
        assert!(observe(&mut db, t, true).unwrap().is_some());
    }
    fn configure(db: &Connection, threshold: f64, delay: u32, confirmation: bool) {
        put(db, "workspace_settings", &serde_json::json!({"potassiumThreshold":threshold,"pm25Threshold":60,"takeoffDelayMinutes":delay,"requireManualConfirmation":confirmation}).to_string()).unwrap();
    }
    #[test]
    fn countdown_claim_cancel_and_persisted_episode() {
        let mut db = db();
        configure(&db, 1.0, 5, false);
        let t = parse("2026-09-22 10:00:00").unwrap();
        reading(&db, "2026-09-22 09:00:00", Some(2.));
        let event = observe(&mut db, t, true).unwrap().unwrap();
        let due = (t - Duration::hours(8)).and_utc().timestamp_millis() + 300000;
        assert_eq!(event.launch_at, Some(due));
        assert!(claim_due(&db, due - 1).unwrap().is_none());
        assert!(cancel(&db, "stale-id").is_err());
        cancel(&db, &event.id).unwrap();
        assert!(claim_due(&db, due + 1000).unwrap().is_none());
        assert!(observe(&mut db, t, true).unwrap().is_none());
        // Cancellation must not block an intentional manual flight even without K+.
        let manual = begin_manual(&db, false).unwrap();
        assert_eq!(manual.source, "manual"); assert!(manual.potassium.is_none());
        assert!(begin_manual(&db, false).is_err());
        cancel(&db, &manual.id).unwrap();
        assert!(terminal(&current(&db).unwrap().unwrap()));
    }
    #[test]
    fn dynamic_threshold_delay_and_latest_confirmation_gate() {
        let mut db = db();
        configure(&db, 2.5, 0, false);
        let t = parse("2026-09-22 10:00:00").unwrap();
        reading(&db, "2026-09-22 09:00:00", Some(2.5));
        assert!(observe(&mut db, t, true).unwrap().is_none());
        reading(&db, "2026-09-22 09:00:00", Some(2.6));
        let event = observe(&mut db, t, true).unwrap().unwrap();
        let due = event.launch_at.unwrap();
        let mut claimed = claim_due(&db, due).unwrap().unwrap();
        assert_eq!(claimed.status, "preparing");
        assert!(claim_due(&db, due).unwrap().is_none());
        assert!(!needs_confirmation(&db, &claimed).unwrap());
        configure(&db, 2.5, 1440, true);
        assert!(needs_confirmation(&db, &claimed).unwrap());
        claimed.source = "manual".into();
        assert!(!needs_confirmation(&db, &claimed).unwrap());
        claimed.preview = true;
        assert!(needs_confirmation(&db, &claimed).unwrap());
        claimed.status = "submitting".into(); save(&db, &claimed).unwrap();
        assert!(cancel(&db, &claimed.id).is_err());
    }
    #[test]
    fn manual_confirmation_skips_delay_and_releases_existing_countdown() {
        let mut db = db();
        configure(&db, 1.0, 1440, true);
        let t = parse("2026-09-22 10:00:00").unwrap();
        let now = (t - Duration::hours(8)).and_utc().timestamp_millis();
        reading(&db, "2026-09-22 09:00:00", Some(2.));
        let event = observe(&mut db, t, true).unwrap().unwrap();
        assert_eq!(event.launch_at, Some(now));
        assert_eq!(view(&db).unwrap().delay_minutes, 0);
        let claimed = claim_due(&db, now).unwrap().unwrap();
        assert!(needs_confirmation(&db, &claimed).unwrap());
        let mut pending = claimed;
        pending.status = "countdown".into();
        pending.launch_at = Some(now + 300000);
        save(&db, &pending).unwrap();
        configure(&db, 1.0, 5, false);
        assert!(claim_due(&db, now).unwrap().is_none());
        configure(&db, 1.0, 5, true);
        assert!(claim_due(&db, now).unwrap().is_some());
    }
    #[test]
    fn restart_never_replays_a_deadline_or_an_ambiguous_submission() {
        let db = db();
        for (before, after) in [("countdown", "canceled"), ("preparing", "failed"), ("submitting", "uncertain"), ("submitted", "submitted")] {
            let mut event = new_event("2026-09-22 09:00:00".into(), Some(2.), false);
            event.status = before.into(); event.launch_at = Some(1);
            save(&db, &event).unwrap(); recover(&db).unwrap();
            assert_eq!(current(&db).unwrap().unwrap().status, after);
            assert!(claim_due(&db, i64::MAX).unwrap().is_none());
        }
    }
    #[test]
    fn legacy_auto_fill_is_not_permission_to_submit_and_manual_ignores_missing_k() {
        let db = crate::monitoring::connect(std::path::Path::new(":memory:")).unwrap();
        put(&db, "flight_enabled", "true").unwrap();
        assert!(!enabled(&db).unwrap());
        let manual = begin_manual(&db, false).unwrap();
        assert_eq!(manual.source, "manual");
        assert!(manual.name.starts_with("手动巡查-"));
    }

}
