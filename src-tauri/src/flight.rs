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
    status_gate: tokio::sync::Mutex<()>,
    pub(crate) gate: Mutex<()>,
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
    #[serde(default)]
    status_check_error: Option<String>,
    #[serde(default)]
    status_checked_at: Option<i64>,
    #[serde(default)]
    weather_override_confirmed_at: Option<i64>,
    #[serde(default)]
    weather_checks: Vec<WeatherCheck>,
    #[serde(default)]
    resolved_at: Option<i64>,
    #[serde(default)]
    flight_time: Option<FlightTime>,
    #[serde(default)]
    flight_time_checked_at: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlightTime {
    start_time: i64,
    end_time: i64,
    duration_ms: i64,
    source: String,
    precision: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WeatherCheck {
    checked_at: i64,
    stage: String,
    weather: crate::weather::View,
}
fn creation_weather(app: &tauri::AppHandle) -> WeatherCheck {
    WeatherCheck { checked_at: chrono::Utc::now().timestamp_millis(), stage: "creation".into(), weather: crate::weather::view(app) }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    enabled: bool,
    event: Option<Event>,
    threshold: f64,
    delay_minutes: u32,
    records: Vec<Event>,
    tasks_cleared_at: Option<i64>,
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
fn terminal(event: &Event) -> bool { matches!(event.status.as_str(), "dismissed" | "canceled" | "completed" | "restricted" | "not_flown") }
fn trackable(event: &Event) -> bool {
    !event.preview && event.source != "preview"
        && matches!(event.status.as_str(), "ready" | "submitted" | "uncertain" | "flying" | "paused" | "flight_error")
}
// All replacements archive the prior receipt in the same transaction.
fn replace_current(tx: &rusqlite::Transaction<'_>, event: &Event) -> Result<(), String> {
    if let Some(previous) = current(tx)?.filter(|old| old.id != event.id) { archive(tx, &previous)?; }
    save(tx, event)
}
pub fn view(db: &Connection) -> Result<View, String> {
    reconcile_restriction(db, &crate::settings::read(db)?, now())?;
    let mut stmt = db.prepare("SELECT value FROM monitor_settings AS records WHERE (key LIKE 'flight_history:%' OR key LIKE 'flight_restricted:%') AND NOT EXISTS (SELECT 1 FROM monitor_settings AS hidden WHERE hidden.key = 'flight_task_hidden:' || json_extract(records.value, '$.id')) ORDER BY json_extract(value, '$.observedAt') DESC LIMIT 30").map_err(|e| e.to_string())?;
    let raw = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let mut records = raw.iter().map(|v| serde_json::from_str::<Event>(v).map_err(|e| e.to_string())).collect::<Result<Vec<_>,_>>()?;
    let mut ids = std::collections::HashSet::new();
    records.retain(|event| ids.insert(event.id.clone()));
    let event = match current(db)? {
        Some(event) if setting(db, &format!("flight_task_hidden:{}", event.id))?.is_none() => Some(event),
        _ => None,
    };
    let tasks_cleared_at = setting(db, "flight_tasks_cleared_at")?.map(|value| value.parse::<i64>().map_err(|e| e.to_string())).transpose()?;
    Ok(View { enabled: enabled(db)?, event, threshold: crate::settings::read(db)?.potassium_threshold, delay_minutes: delay(db)?, records, tasks_cleared_at })
}
// Keep receipts and duplicate-flight guards intact. Failed preparation can be
// archived and released: no launch request was sent (unlike uncertain/flight_error).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearTasksResult {
    preserved_current_task: bool,
}
fn clear_tasks(db: &Connection, confirmed: bool, at: i64) -> Result<ClearTasksResult, String> {
    if !confirmed { return Err("请先确认清空任务列表。".into()); }
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(mut event) = current(&tx)?.filter(|event| event.status == "failed") {
        event.resolved_at = Some(at);
        archive(&tx, &event)?;
        tx.execute("DELETE FROM monitor_settings WHERE key='flight_event'", []).map_err(|e| e.to_string())?;
        // Clearing a failure must not immediately dispatch another automatic flight.
        if !event.preview && event.source != "preview"
            && setting(&tx, "flight_episode")?.is_none_or(|episode| episode.is_empty()) {
            put(&tx, "flight_episode", &event.observed_at)?;
        }
    }
    let preserved = current(&tx)?.filter(|event| !terminal(event));
    let preserved_id = preserved.as_ref().map(|event| event.id.as_str());
    tx.execute("INSERT OR IGNORE INTO monitor_settings(key, value) SELECT 'flight_task_hidden:' || json_extract(value, '$.id'), 'true' FROM monitor_settings WHERE (key='flight_event' OR key LIKE 'flight_history:%' OR key LIKE 'flight_restricted:%') AND (?1 IS NULL OR json_extract(value, '$.id') != ?1)", [preserved_id]).map_err(|e| e.to_string())?;
    put(&tx, "flight_tasks_cleared_at", &at.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ClearTasksResult { preserved_current_task: preserved.is_some() })
}
#[tauri::command]
pub fn clear_task_list(app: tauri::AppHandle, confirmed: bool) -> Result<ClearTasksResult, String> {
    let state = app.state::<Flight>();
    let _gate = state.gate.lock().unwrap();
    clear_tasks(&database(&app)?, confirmed, chrono::Utc::now().timestamp_millis())
}
fn archive(db: &Connection, event: &Event) -> Result<(), String> {
    put(db, &format!("flight_history:{}", event.id), &serde_json::to_string(event).map_err(|e| e.to_string())?)
}
pub(crate) fn reconcile_restriction(db: &Connection, settings: &crate::settings::Settings, at: chrono::NaiveDateTime) -> Result<(), String> {
    let Some(event) = current(db)?.filter(|e| e.status == "restricted") else { return Ok(()); };
    if settings.no_fly_reason(at).is_some() || (event.source == "auto" && settings.no_fly_reason(parse(&event.observed_at)?).is_some()) { return Ok(()); }
    // A skip is historical once its restriction no longer applies. Preserve
    // the original reason and handled hour; changing settings is not a replay.
    archive(db, &event)?;
    db.execute("DELETE FROM monitor_settings WHERE key='flight_event' AND json_extract(value, '$.id')=? AND json_extract(value, '$.status')='restricted'", [&event.id]).map_err(|e| e.to_string())?;
    Ok(())
}
fn restriction_reason(db: &Connection, event: &Event, at: chrono::NaiveDateTime) -> Result<Option<String>, String> {
    let settings = crate::settings::read(db)?;
    Ok(settings.no_fly_reason(at).or(if event.source == "auto" { settings.no_fly_reason(parse(&event.observed_at)?) } else { None }))
}
fn restrict(db: &Connection, event: &mut Event, reason: String) -> Result<(), String> {
    event.status = "restricted".into(); event.error = Some(reason); event.launch_at = None;
    archive(db, event)?;
    if event.source == "auto" { put(db, "flight_episode", "")?; }
    save(db, event)
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
        status: "preparing".into(), error: None, preview, source: if preview { "preview" } else { "auto" }.into(), launch_at: None,
        status_check_error: None, status_checked_at: None, weather_override_confirmed_at: None, weather_checks: Vec::new(), resolved_at: None,
        flight_time: None, flight_time_checked_at: None }
}
#[cfg(test)]
fn observe(db: &mut Connection, at: chrono::NaiveDateTime, weather_allowed: bool) -> Result<Option<Event>, String> {
    observe_with_weather(db, at, weather_allowed, None)
}
fn observe_with_weather(db: &mut Connection, at: chrono::NaiveDateTime, weather_allowed: bool, check: Option<WeatherCheck>) -> Result<Option<Event>, String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let latest: Option<(String, Option<f64>)> = tx.query_row(
        "SELECT observed_at,potassium FROM hourly_observations WHERE city_code='321200' ORDER BY observed_at DESC LIMIT 1", [],
        |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
    let Some((time, Some(k))) = latest else { return Ok(None); };
    let age = at - parse(&time)?;
    if age < Duration::zero() || age > Duration::hours(3) { return Ok(None); }
    let settings = crate::settings::read(&tx)?;
    if k > settings.potassium_threshold {
        if let Some(reason) = settings.no_fly_reason(parse(&time)?).or_else(|| settings.no_fly_reason(at)) {
            let key = format!("flight_restricted:{time}");
            if setting(&tx, &key)?.is_none() {
                let mut record = new_event(time.clone(), Some(k), false);
                record.weather_checks.extend(check.clone());
                record.status = "restricted".into(); record.error = Some(reason);
                put(&tx, &key, &serde_json::to_string(&record).map_err(|e| e.to_string())?)?;
                if setting(&tx, &format!("flight_handled:{time}"))?.is_none() { put(&tx, &format!("flight_handled:{time}"), &record.id)?; }
                let previous = current(&tx)?;
                if previous.as_ref().is_none_or(|e| terminal(e) || (e.source == "auto" && e.status == "failed")) {
                    replace_current(&tx, &record)?;
                    put(&tx, "flight_episode", "")?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(None);
        }
    }
    // A failed preparation never sent a launch request. New valid hourly data
    // releases that automatic attempt; keep its receipt and same-hour dedup.
    // Submitted/uncertain flights and intentional cancellations stay guarded.
    if let Some(event) = current(&tx)?.filter(|e| e.source == "auto" && !e.preview && e.status == "failed") {
        if parse(&time)? > parse(&event.observed_at)? {
            put(&tx, &format!("flight_history:{}", event.id), &serde_json::to_string(&event).map_err(|e| e.to_string())?)?;
            tx.execute("DELETE FROM monitor_settings WHERE key='flight_event'", []).map_err(|e| e.to_string())?;
            put(&tx, "flight_episode", "")?;
        }
    }
    if k <= crate::settings::read(&tx)?.potassium_threshold {
        put(&tx, "flight_episode", "")?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(None);
    }
    if !weather_allowed || !enabled(&tx)? || setting(&tx, "flight_episode")?.is_some_and(|s| !s.is_empty())
        || current(&tx)?.is_some_and(|e| !terminal(&e))
        || setting(&tx, &format!("flight_handled:{time}"))?.is_some() {
        // Persist the released failure even when current weather or settings
        // prevent a new task; a later sync can reevaluate the latest reading.
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(None);
    }
    let mut event = new_event(time.clone(), Some(k), false);
    event.weather_checks.extend(check);
    event.status = "countdown".into();
    event.launch_at = Some((at - Duration::hours(8)).and_utc().timestamp_millis() + i64::from(delay(&tx)?) * 60000);
    put(&tx, "flight_episode", &time)?;
    put(&tx, &format!("flight_handled:{time}"), &event.id)?;
    replace_current(&tx, &event)?;
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
fn has_manual_weather_override(event: &Event) -> bool {
    event.source == "manual" && !event.preview && event.weather_override_confirmed_at.is_some_and(|at| at > 0)
}
async fn require_launch_weather(app: &tauri::AppHandle, event: &Event) -> Result<(), String> {
    // Recheck launch safety without replacing or appending to the creation snapshot.
    let (_, result) = crate::weather::check_launch(app, has_manual_weather_override(event)).await;
    result
}
async fn execute(app: &tauri::AppHandle, mut event: Event) -> Result<(), String> {
    if prevent_restricted_launch(app, &mut event)? { return Ok(()); }
    if let Err(error) = require_launch_weather(app, &event).await {
        event.status = "failed".into(); event.error = Some(error.clone());
        update_current(app, &event)?; return Err(error);
    }
    let auto_submit = !needs_confirmation(&database(app)?, &event)?;
    let preparation = app.state::<Bridge>().prepare_flight(&event.id, &event.name, auto_submit).await.and_then(|data| {
        if data["status"] != "ready" || data["submitted"] != false || data["name"] != event.name || data["url"] != format!("{PLAN_URL}/create-plan") {
            Err("计划填写回执不匹配；未发送起飞请求。".into())
        } else { Ok(()) }
    });
    if let Err(error) = preparation {
        event.status = "failed".into(); event.error = Some(error.clone());
        update_current(app, &event)?; return Err(error);
    }
    if !auto_submit || needs_confirmation(&database(app)?, &event)? {
        event.status = "ready".into(); update_current(app, &event)?; return Ok(());
    }
    // Keep the task cancelable throughout the review interval. The browser
    // panel starts its countdown when the verified preparation returns.
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    if prevent_restricted_launch(app, &mut event)? { return Ok(()); }
    if let Err(error) = require_launch_weather(app, &event).await {
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
        if let Some(reason) = restriction_reason(&db, &event, now())? { restrict(&db, &mut event, reason)?; return Ok(()); }
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
        Err(error) if error.contains("取消") => { event.status = "canceled".into(); event.error = None; }
        Err(error) => { event.status = "uncertain".into(); event.error = Some(format!("{error} 请到司空核查；不会自动重试。")); }
    }
    update_current(app, &event)?;
    Ok(())
}
fn prevent_restricted_launch(app: &tauri::AppHandle, event: &mut Event) -> Result<bool, String> {
    let state = app.state::<Flight>(); let _gate = state.gate.lock().unwrap();
    let db = database(app)?;
    if let Some(reason) = restriction_reason(&db, event, now())? {
        if current(&db)?.is_some_and(|e| e.id == event.id && !terminal(&e)) { restrict(&db, event, reason)?; }
        return Ok(true);
    }
    Ok(false)
}
pub async fn after_sync(app: &tauri::AppHandle) -> Result<(), String> {
    crate::weather::refresh(app, false).await;
    let check = creation_weather(app);
    let state = app.state::<Flight>();
    let _gate = state.gate.lock().unwrap();
    observe_with_weather(&mut database(app)?, now(), check.weather.allowed, Some(check))?;
    Ok(())
}
fn claim_due(db: &Connection, at: i64) -> Result<Option<Event>, String> {
    let Some(mut event) = current(db)? else { return Ok(None); };
    if event.status != "countdown" { return Ok(None); }
    let local = chrono::DateTime::from_timestamp_millis(at).ok_or("起飞检查时间无效。")?.naive_utc() + Duration::hours(8);
    if let Some(reason) = restriction_reason(db, &event, local)? { restrict(db, &mut event, reason)?; return Ok(None); }
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
fn apply_observation(db: &Connection, id: &str, name: &str, status: &str) -> Result<(), String> {
    let Some(mut event) = current(db)? else { return Ok(()); };
    if event.id != id || event.name != name || !trackable(&event) { return Ok(()); }
    event.status_checked_at = Some(chrono::Utc::now().timestamp_millis());
    event.status_check_error = None;
    match status {
        "执行中" => { event.status = "flying".into(); event.error = None; }
        "已暂停" | "已挂起" => { event.status = "paused".into(); event.error = Some(format!("司空显示任务{status}，请核查设备。")); }
        "执行成功" => { event.status = "completed".into(); event.error = None; }
        "部分执行" | "执行失败" | "执行终止" => { event.status = "flight_error".into(); event.error = Some(format!("司空显示任务{status}，请核查飞行记录。")); }
        "待执行" => { if matches!(event.status.as_str(), "ready" | "uncertain" | "flight_error") { event.status = "submitted".into(); event.error = None; } }
        _ => return Ok(()),
    }
    save(db, &event)
}
// Enrichment is independent of the flight state machine: completed flights
// remain terminal, including while an older record is being backfilled.
fn apply_flight_time(db: &Connection, id: &str, name: &str, result: &serde_json::Value) -> Result<(), String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let live = current(&tx)?;
    let is_current = live.as_ref().is_some_and(|event| event.id == id);
    let stored = if is_current { live } else {
        setting(&tx, &format!("flight_history:{id}"))?
            .map(|value| serde_json::from_str::<Event>(&value).map_err(|e| e.to_string())).transpose()?
    };
    let Some(mut event) = stored.filter(|event| event.name == name && event.status == "completed" && !event.preview) else { return Ok(()); };
    let now = chrono::Utc::now().timestamp_millis();
    event.flight_time_checked_at = Some(now);
    if result["url"] == PLAN_URL && result["name"] == name && result["status"] == "执行成功" {
        if let Ok(time) = serde_json::from_value::<FlightTime>(result["flightTime"].clone()) {
            let duration = time.end_time.checked_sub(time.start_time);
            if time.source == "dji-plan" && time.precision == "minute"
                && time.start_time > 0 && time.end_time <= now
                && time.start_time % 60000 == 0 && time.end_time % 60000 == 0
                && time.duration_ms > 0 && time.duration_ms < 86400000 && duration == Some(time.duration_ms) {
                event.flight_time = Some(time);
            }
        }
    }
    if is_current { save(&tx, &event)?; }
    if !is_current || setting(&tx, &format!("flight_history:{id}"))?.is_some() { archive(&tx, &event)?; }
    tx.commit().map_err(|e| e.to_string())
}
fn needs_flight_time(event: &Event, now: i64) -> bool {
    event.status == "completed" && !event.preview && event.flight_time.is_none()
        && event.flight_time_checked_at.is_none_or(|checked| now.saturating_sub(checked) >= 60000)
}
fn record_check_error(db: &Connection, id: &str, name: &str, message: &str) -> Result<(), String> {
    let Some(mut event) = current(db)? else { return Ok(()); };
    if event.id != id || event.name != name || !trackable(&event) { return Ok(()); }
    event.status_checked_at = Some(chrono::Utc::now().timestamp_millis());
    // The v0.7.10 adapter only emits this receipt after reading this event's
    // exact original draft. A missing row or generic error proves nothing.
    if matches!(event.status.as_str(), "ready" | "uncertain") && message.starts_with("司空平台天气阻飞：") && message.ends_with("；未继续执行") {
        event.status = "not_flown".into();
        event.status_check_error = None;
        event.error = Some(match event.error.as_deref() {
            Some(original) if original != message => format!("{original}\n司空核查：{message}"),
            _ => message.into(),
        });
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        if setting(&tx, "flight_episode")?.is_none_or(|s| s.is_empty()) {
            put(&tx, "flight_episode", &event.observed_at)?;
        }
        archive(&tx, &event)?;
        save(&tx, &event)?;
        return tx.commit().map_err(|e| e.to_string());
    }
    event.status_check_error = Some(message.chars().take(180).collect());
    save(db, &event)
}
fn handle_unmatched_status(db: &Connection, id: &str, name: &str, manual: bool) -> Result<bool, String> {
    let message = "司空列表未识别到该任务状态，请检查平台页面或日期范围。";
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    record_check_error(&tx, id, name, message)?;
    let event = current(&tx)?.filter(|e| e.id == id && e.name == name && e.status == "uncertain");
    let released = if let Some(mut event) = event.filter(|_| manual) {
        // Explicit refresh releases the local reservation only. Keep the
        // unresolved outcome in history; absence is not proof of no flight.
        event.status_check_error = Some(format!("{message} 已手动刷新并解除本地任务占用，原起飞结果仍未确认。"));
        archive(&tx, &event)?;
        tx.execute("DELETE FROM monitor_settings WHERE key='flight_event'", []).map_err(|e| e.to_string())?;
        // Restoring the launch button must not dispatch another automatic
        // flight on the next sync. A normal reading can rearm a later episode.
        if setting(&tx, "flight_episode")?.is_none_or(|s| s.is_empty()) {
            put(&tx, "flight_episode", &event.observed_at)?;
        }
        true
    } else { false };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(released)
}
async fn watch(app: &tauri::AppHandle, expected_id: Option<&str>) -> Result<(), String> {
    let state = app.state::<Flight>();
    let _status_gate = state.status_gate.lock().await;
    let event = current(&database(app)?)?;
    if expected_id.is_some_and(|id| event.as_ref().is_none_or(|e| e.id != id)) { return Err("任务已变化，请查看当前任务后重试。".into()); }
    let now = chrono::Utc::now().timestamp_millis();
    let event = event.filter(|event| trackable(event) || needs_flight_time(event, now));
    let event = if event.is_some() || expected_id.is_some() { event } else {
        // Retained completed tasks also need enrichment after upgrading. Hidden
        // records are excluded by view(); an active flight always takes priority.
        view(&database(app)?)?.records.into_iter().find(|event| needs_flight_time(event, now))
    };
    let Some(event) = event else { return Ok(()); };
    let result = app.state::<Bridge>().flight_status(&event.id, &event.name).await;
    let _gate = state.gate.lock().unwrap();
    let db = database(app)?;
    if event.status == "completed" {
        apply_flight_time(&db, &event.id, &event.name, result.as_ref().unwrap_or(&serde_json::Value::Null))?;
        return result.map(|_| ());
    }
    match result {
        Ok(result) if result["url"] == PLAN_URL && result["name"] == event.name => {
            if let Some(status) = result["status"].as_str().filter(|s| matches!(*s, "执行中" | "已暂停" | "已挂起" | "执行成功" | "部分执行" | "执行失败" | "执行终止" | "待执行")) {
                apply_observation(&db, &event.id, &event.name, status)?;
                if status == "执行成功" { apply_flight_time(&db, &event.id, &event.name, &result)?; }
                Ok(())
            } else {
                let message = "司空列表未识别到该任务状态，请检查平台页面或日期范围。";
                if handle_unmatched_status(&db, &event.id, &event.name, expected_id.is_some())? { Ok(()) } else { Err(message.into()) }
            }
        }
        Ok(_) => { record_check_error(&db, &event.id, &event.name, "司空状态回执不匹配。")?; Err("司空状态回执不匹配。".into()) }
        Err(error) => {
            record_check_error(&db, &event.id, &event.name, &error)?;
            if current(&db)?.is_some_and(|updated| updated.id == event.id && updated.status == "not_flown") { Ok(()) } else { Err(error) }
        }
    }
}
#[tauri::command]
pub async fn refresh_flight_status(app: tauri::AppHandle, event_id: String) -> Result<(), String> {
    watch(&app, Some(&event_id)).await
}
pub fn start(app: tauri::AppHandle) {
    let scheduler = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = tick(&scheduler).await { eprintln!("Flight task: {error}"); }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = watch(&app, None).await { eprintln!("Flight status: {error}"); }
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
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
// Closing is an explicit local disposition, never a platform cancellation or success.
fn close_reviewed(db: &Connection, id: &str, expected_status: &str, confirmed: bool) -> Result<(), String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut event = current(&tx)?.ok_or("任务已变化，请刷新后重试。")?;
    if event.id != id || event.status != expected_status { return Err("任务状态已变化，请刷新后重新核查。".into()); }
    if !matches!(event.status.as_str(), "failed" | "ready" | "flight_error") { return Err("当前任务不能结束处理，请继续核查司空状态。".into()); }
    if !confirmed { return Err("请先确认平台任务已结束或已取消。".into()); }
    event.resolved_at = Some(chrono::Utc::now().timestamp_millis());
    archive(&tx, &event)?;
    tx.execute("DELETE FROM monitor_settings WHERE key='flight_event'", []).map_err(|e| e.to_string())?;
    // Releasing a real draft/exception must not immediately dispatch a new flight.
    // Normal hourly data can rearm a later episode. Preview and preparation-failure
    // disposition preserve the existing episode policy.
    if !event.preview && event.source != "preview" && event.status != "failed"
        && setting(&tx, "flight_episode")?.is_none_or(|s| s.is_empty()) {
        put(&tx, "flight_episode", &event.observed_at)?;
    }
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn dismiss_flight(app: tauri::AppHandle, event_id: String) -> Result<(), String> {
    let state = app.state::<Flight>(); let _gate = state.gate.lock().unwrap();
    close_reviewed(&database(&app)?, &event_id, "failed", true)
}
#[tauri::command]
pub fn resolve_flight(app: tauri::AppHandle, event_id: String, expected_status: String, confirmed: bool) -> Result<(), String> {
    let state = app.state::<Flight>(); let _gate = state.gate.lock().unwrap();
    close_reviewed(&database(&app)?, &event_id, &expected_status, confirmed)
}
#[cfg(test)]
fn begin_manual_request(db: &Connection, preview: bool, retry_event_id: Option<&str>, weather_override_confirmed: bool) -> Result<Event, String> {
    begin_manual_with_weather(db, preview, retry_event_id, weather_override_confirmed, None)
}
fn begin_manual_with_weather(db: &Connection, preview: bool, retry_event_id: Option<&str>, weather_override_confirmed: bool, check: Option<WeatherCheck>) -> Result<Event, String> {
    if !preview { if let Some(reason) = crate::settings::read(db)?.no_fly_reason(now()) { return Err(reason); } }
    if preview && (weather_override_confirmed || retry_event_id.is_some()) { return Err("填写演练不能覆盖天气或重新发起起飞任务。".into()); }
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let previous = current(&tx)?;
    if let Some(id) = retry_event_id {
        previous.as_ref().filter(|e| e.id == id && e.status == "failed").ok_or("原失败任务已变化，请刷新后重新确认。")?;
    } else if previous.is_some_and(|e| !terminal(&e)) { return Err("请先处理当前巡飞任务。".into()); }
    let mut event = new_event(now().format("%Y-%m-%d %H:%M:%S").to_string(), None, preview);
    event.weather_checks.extend(check);
    if !preview { event.source = "manual".into(); event.name = format!("{}-{}", event.name.replace("钾离子超标巡查", "手动巡查"), &event.id[..8]); }
    if weather_override_confirmed { event.weather_override_confirmed_at = Some(chrono::Utc::now().timestamp_millis()); }
    replace_current(&tx, &event)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(event)
}
#[cfg(test)]
fn begin_manual(db: &Connection, preview: bool) -> Result<Event, String> { begin_manual_request(db, preview, None, false) }
async fn begin(app: tauri::AppHandle, preview: bool, retry_event_id: Option<String>, weather_override_confirmed: bool) -> Result<(), String> {
    crate::readiness::require_started(&app)?;
    let state = app.state::<Flight>();
    if state.busy.swap(true, Ordering::SeqCst) { return Err("巡飞任务正在处理，请稍候。".into()); }
    let event = {
        let _gate = state.gate.lock().unwrap();
        database(&app).and_then(|db| begin_manual_with_weather(&db, preview, retry_event_id.as_deref(), weather_override_confirmed, Some(creation_weather(&app))))
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
pub async fn launch_flight(app: tauri::AppHandle, retry_event_id: Option<String>, weather_override_confirmed: Option<bool>) -> Result<(), String> { begin(app, false, retry_event_id, weather_override_confirmed.unwrap_or(false)).await }
#[tauri::command]
pub async fn prepare_flight(app: tauri::AppHandle, preview: bool) -> Result<(), String> {
    if !preview { return Err("请核查并归档原任务后，重新发起手动起飞。".into()); }
    begin(app, true, None, false).await
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
    #[test]
    fn clear_task_list_preserves_receipts_guards_and_allows_new_records() {
        let db = db();
        let mut event = new_event("2026-10-09 09:00:00".into(), Some(2.), false);
        event.status = "completed".into();
        save(&db, &event).unwrap();
        archive(&db, &event).unwrap();
        put(&db, "flight_episode", &event.observed_at).unwrap();
        put(&db, "flight_last_hour", &event.observed_at).unwrap();
        assert!(!clear_tasks(&db, true, 12345).unwrap().preserved_current_task);
        let visible = view(&db).unwrap();
        assert!(visible.event.is_none());
        assert!(visible.records.is_empty());
        assert_eq!(visible.tasks_cleared_at, Some(12345));
        assert_eq!(current(&db).unwrap().unwrap().id, event.id);
        assert!(setting(&db, &format!("flight_history:{}", event.id)).unwrap().is_some());
        assert_eq!(setting(&db, "flight_episode").unwrap(), Some(event.observed_at.clone()));
        assert_eq!(setting(&db, "flight_last_hour").unwrap(), Some(event.observed_at.clone()));
        // A new task within the same observed hour must remain visible.
        event.id = uuid::Uuid::new_v4().to_string();
        save(&db, &event).unwrap();
        assert_eq!(view(&db).unwrap().event.unwrap().id, event.id);
    }
    #[test]
    fn clear_task_list_preserves_unresolved_tasks_and_clears_history() {
        for status in ["countdown", "preparing", "ready", "submitting", "submitted", "uncertain", "flying", "paused", "flight_error"] {
            let db = db();
            let mut old = new_event("2026-10-09 08:00:00".into(), None, false);
            old.status = "completed".into();
            archive(&db, &old).unwrap();
            let mut event = new_event("2026-10-09 09:00:00".into(), None, false);
            event.status = status.into();
            event.weather_checks.push(recorded_weather("creation", true, false));
            save(&db, &event).unwrap();
            archive(&db, &event).unwrap();
            let original = setting(&db, "flight_event").unwrap();
            assert!(clear_tasks(&db, false, 12345).is_err());
            assert!(setting(&db, "flight_tasks_cleared_at").unwrap().is_none());
            for at in [12345, 12346] {
                assert!(clear_tasks(&db, true, at).unwrap().preserved_current_task, "{status}");
                let visible = view(&db).unwrap();
                assert_eq!(visible.event.unwrap().id, event.id);
                assert!(visible.records.iter().all(|record| record.id == event.id));
                assert_eq!(visible.tasks_cleared_at, Some(at));
                assert_eq!(setting(&db, "flight_event").unwrap(), original);
                assert!(setting(&db, &format!("flight_task_hidden:{}", event.id)).unwrap().is_none());
                assert!(setting(&db, &format!("flight_task_hidden:{}", old.id)).unwrap().is_some());
            }
            // The preserved task can still receive completion and remain visible.
            event.status = "completed".into();
            save(&db, &event).unwrap();
            assert_eq!(view(&db).unwrap().event.unwrap().status, "completed");
        }
    }
    #[test]
    fn clearing_failed_tasks_removes_rows_and_releases_manual_launch_without_replaying() {
        for source in ["manual", "auto", "preview"] {
            let mut db = db();
            let mut event = new_event("2026-10-11 19:00:00".into(), None, source == "preview");
            event.source = source.into();
            event.status = "failed".into();
            event.error = Some("计划填写失败；未发送起飞请求".into());
            event.weather_checks.push(recorded_weather("creation", true, false));
            save(&db, &event).unwrap();
            put(&db, "flight_handled:2026-10-11 19:00:00", &event.id).unwrap();
            reading(&db, "2026-10-11 19:00:00", Some(2.));
            assert!(!clear_tasks(&db, true, 12345).unwrap().preserved_current_task);
            recover(&db).unwrap();
            let visible = view(&db).unwrap();
            assert!(visible.event.is_none());
            assert!(visible.records.is_empty());
            assert!(current(&db).unwrap().is_none());
            let receipt: Event = serde_json::from_str(&setting(&db, &format!("flight_history:{}", event.id)).unwrap().unwrap()).unwrap();
            assert_eq!(receipt.status, "failed");
            assert_eq!(receipt.error, event.error);
            assert_eq!(receipt.weather_checks.len(), 1);
            assert_eq!(receipt.resolved_at, Some(12345));
            assert_eq!(setting(&db, "flight_handled:2026-10-11 19:00:00").unwrap(), Some(event.id.clone()));
            assert!(observe_with_weather(&mut db, parse("2026-10-11 19:00:00").unwrap(), true, None).unwrap().is_none());
            if source != "preview" {
                // Even an unhandled later exceeded hour cannot replay a cleared failure.
                reading(&db, "2026-10-11 20:00:00", Some(2.));
                assert!(observe_with_weather(&mut db, parse("2026-10-11 20:00:00").unwrap(), true, None).unwrap().is_none());
            }
            let next = begin_manual(&db, false).unwrap();
            assert_ne!(next.id, event.id);
            assert_eq!(view(&db).unwrap().event.unwrap().id, next.id);
        }
    }
    #[test]
    fn clear_task_list_rolls_back_visibility_if_cutoff_write_fails() {
        for status in ["completed", "failed"] {
            let db = db();
            let mut event = new_event("2026-10-09 09:00:00".into(), None, false);
            event.status = status.into();
            save(&db, &event).unwrap();
            let original = setting(&db, "flight_event").unwrap();
            db.execute_batch("CREATE TRIGGER reject_clear BEFORE INSERT ON monitor_settings WHEN NEW.key='flight_tasks_cleared_at' BEGIN SELECT RAISE(ABORT, 'test'); END;").unwrap();
            assert!(clear_tasks(&db, true, 12345).is_err());
            assert_eq!(view(&db).unwrap().event.unwrap().id, event.id);
            assert_eq!(setting(&db, "flight_event").unwrap(), original);
            assert!(setting(&db, "flight_episode").unwrap().is_none());
            assert!(setting(&db, &format!("flight_task_hidden:{}", event.id)).unwrap().is_none());
            assert!(setting(&db, &format!("flight_history:{}", event.id)).unwrap().is_none());
        }
    }
    fn recorded_weather(stage: &str, allowed: bool, missing: bool) -> WeatherCheck {
        let weather = serde_json::from_value(serde_json::json!({
            "location": "泰州环境监测 Dock 3", "latitude": 32.434525, "longitude": 119.92992,
            "source": "Open-Meteo", "refreshing": false, "allowed": allowed,
            "level": if allowed { "ok" } else { "unknown" },
            "label": if allowed { "天气条件通过" } else { "暂无法判断" },
            "reasons": if allowed { vec!["无降水，风速及阵风均低于 7 m/s。"] } else { vec!["天气获取超时，请稍后重试。"] },
            "current": if missing { serde_json::Value::Null } else { serde_json::json!({
                "observedAt": 1791507300i64, "fetchedAt": 1791507600i64, "temperature": 23.9, "weatherCode": 2,
                "windSpeed": 2.73, "windGusts": 4.1, "windDirection": 90, "precipitation": 0
            }) }
        })).unwrap();
        WeatherCheck { checked_at: 1_791_507_600_000, stage: stage.into(), weather }
    }
    #[test]
    fn task_weather_survives_failure_archive_and_manual_retry() {
        let mut db = db();
        let at = parse("2026-10-09 09:00:00").unwrap();
        reading(&db, "2026-10-09 09:00:00", Some(2.));
        let mut event = observe_with_weather(&mut db, at, true, Some(recorded_weather("creation", true, false))).unwrap().unwrap();
        event.status = "failed".into();
        event.error = Some("等待选中航线超时".into());
        save(&db, &event).unwrap();
        let persisted = current(&db).unwrap().unwrap();
        assert_eq!(persisted.weather_checks.len(), 1);
        let raw = serde_json::to_value(&persisted).unwrap();
        assert_eq!(raw["weatherChecks"][0]["stage"], "creation");
        assert_eq!(raw["weatherChecks"][0]["weather"]["current"]["windSpeed"], 2.73);
        let manual = begin_manual_with_weather(&db, false, Some(&event.id), true, Some(recorded_weather("creation", true, false))).unwrap();
        assert_ne!(manual.id, event.id);
        assert_eq!(manual.weather_checks.len(), 1);
        let archived: Event = serde_json::from_str(&setting(&db, &format!("flight_history:{}", event.id)).unwrap().unwrap()).unwrap();
        assert_eq!(serde_json::to_value(archived).unwrap(), raw);
    }
    #[test]
    fn restricted_tasks_keep_weather_and_legacy_events_load_without_a_snapshot() {
        let mut db = db();
        morning_restriction(&db);
        reading(&db, "2026-10-09 07:00:00", Some(2.));
        observe_with_weather(&mut db, parse("2026-10-09 07:00:00").unwrap(), false, Some(recorded_weather("creation", false, true))).unwrap();
        let event = current(&db).unwrap().unwrap();
        assert_eq!(event.status, "restricted");
        assert_eq!(event.weather_checks.len(), 1);
        assert!(!event.weather_checks[0].weather.allowed);
        let mut legacy = serde_json::to_value(event).unwrap();
        legacy.as_object_mut().unwrap().remove("weatherChecks");
        let event: Event = serde_json::from_value(legacy).unwrap();
        assert!(event.weather_checks.is_empty());
    }
    fn db() -> Connection {
        let db = crate::monitoring::connect(std::path::Path::new(":memory:")).unwrap();
        put(&db, "flight_launch_enabled", "true").unwrap();
        configure(&db, 1.0, 5, true);
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
    fn time_receipt(event: &Event) -> serde_json::Value {
        let start = chrono::DateTime::parse_from_rfc3339("2026-09-22T20:19:00+08:00").unwrap().timestamp_millis();
        serde_json::json!({"url": PLAN_URL, "name": event.name, "status": "执行成功", "flightTime": {
            "startTime": start, "endTime": start + 1260000, "durationMs": 1260000, "source": "dji-plan", "precision": "minute"
        }})
    }
    #[test]
    fn completed_flight_time_backfills_without_reopening_the_state_machine() {
        let db = db();
        let mut event = new_event("2026-09-22 20:18:24".into(), None, false);
        event.status = "completed".into();
        save(&db, &event).unwrap();
        assert!(!trackable(&event));
        assert!(needs_flight_time(&event, chrono::Utc::now().timestamp_millis()));
        apply_flight_time(&db, &event.id, &event.name, &time_receipt(&event)).unwrap();
        let updated = current(&db).unwrap().unwrap();
        assert_eq!(updated.flight_time.as_ref().unwrap().duration_ms, 1260000);
        assert_eq!(updated.status, "completed");
        assert!(!needs_flight_time(&updated, chrono::Utc::now().timestamp_millis()));
        apply_observation(&db, &event.id, &event.name, "执行中").unwrap();
        apply_flight_time(&db, &event.id, &event.name, &serde_json::Value::Null).unwrap();
        assert_eq!(current(&db).unwrap().unwrap().flight_time, updated.flight_time);
        let raw = serde_json::to_value(updated).unwrap();
        assert!(raw["flightTime"]["startTime"].as_i64().is_some());
        recover(&db).unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "completed");
    }
    #[test]
    fn flight_time_late_receipt_updates_archive_not_a_new_current_task() {
        let mut db = db();
        let mut old = new_event("2026-09-22 20:18:24".into(), None, false);
        old.status = "completed".into();
        save(&db, &old).unwrap();
        let next = new_event("2026-09-23 07:00:00".into(), None, false);
        let tx = db.transaction().unwrap();
        replace_current(&tx, &next).unwrap();
        tx.commit().unwrap();
        apply_flight_time(&db, &old.id, &old.name, &time_receipt(&old)).unwrap();
        assert_eq!(current(&db).unwrap().unwrap().id, next.id);
        assert!(current(&db).unwrap().unwrap().flight_time.is_none());
        let archived: Event = serde_json::from_str(&setting(&db, &format!("flight_history:{}", old.id)).unwrap().unwrap()).unwrap();
        assert_eq!(archived.flight_time.unwrap().duration_ms, 1260000);
    }
    #[test]
    fn flight_time_rejects_wrong_task_source_and_invalid_duration() {
        let db = db();
        let mut event = new_event("2026-09-22 20:18:24".into(), None, false);
        event.status = "completed".into();
        for (field, value) in [
            ("name", serde_json::json!("other")), ("url", serde_json::json!("https://other.test")),
            ("status", serde_json::json!("执行中")), ("durationMs", serde_json::json!(1)),
            ("startTime", serde_json::json!(-1)), ("endTime", serde_json::json!(i64::MAX)),
            ("source", serde_json::json!("planned")), ("precision", serde_json::json!("second")),
        ] {
            save(&db, &event).unwrap();
            let mut receipt = time_receipt(&event);
            if matches!(field, "name" | "url" | "status") { receipt[field] = value; }
            else { receipt["flightTime"][field] = value; }
            apply_flight_time(&db, &event.id, &event.name, &receipt).unwrap();
            let updated = current(&db).unwrap().unwrap();
            assert!(updated.flight_time.is_none(), "{field}");
            assert!(!needs_flight_time(&updated, chrono::Utc::now().timestamp_millis()));
            assert_eq!(updated.status, "completed");
        }
    }
    #[test]
    fn observed_plan_status_requires_matching_event_and_explicit_completion() {
        let db = db();
        let mut event = new_event("2026-09-23 14:00:00".into(), None, false);
        event.status = "submitted".into();
        save(&db, &event).unwrap();
        recover(&db).unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "submitted");
        record_check_error(&db, &event.id, &event.name, "司空暂时不可用").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status_check_error.as_deref(), Some("司空暂时不可用"));
        apply_observation(&db, "other", &event.name, "执行成功").unwrap();
        apply_observation(&db, &event.id, &event.name, "待执行").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "submitted");
        apply_observation(&db, &event.id, &event.name, "执行中").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "flying");
        assert!(current(&db).unwrap().unwrap().status_check_error.is_none());
        apply_observation(&db, &event.id, &event.name, "执行成功").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "completed");
        apply_observation(&db, &event.id, &event.name, "执行失败").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "completed");
    }
    #[test]
    fn latest_missing_hour_blocks_fallback_to_an_older_exceeded_reading() {
        let mut db = db();
        let t = parse("2026-09-22 14:00:00").unwrap();
        reading(&db, "2026-09-22 11:00:00", Some(2.0));
        reading(&db, "2026-09-22 12:00:00", None);
        reading(&db, "2026-09-22 13:00:00", None);
        reading(&db, "2026-09-22 14:00:00", None);
        assert!(observe(&mut db, t, true).unwrap().is_none());
        assert!(current(&db).unwrap().is_none());
        reading(&db, "2026-09-22 14:00:00", Some(2.0));
        let event = observe(&mut db, t, true).unwrap().unwrap();
        assert_eq!(event.observed_at, "2026-09-22 14:00:00");
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
        put(db, "workspace_settings", &serde_json::json!({"potassiumThreshold":threshold,"pm25Threshold":60,"takeoffDelayMinutes":delay,"requireManualConfirmation":confirmation,"noFlyPeriods":[]}).to_string()).unwrap();
    }
    fn failed_automatic(db: &mut Connection) -> Event {
        configure(db, 0.5, 5, false);
        let time = "2026-10-08 19:00:00";
        reading(db, time, Some(0.54));
        let mut event = observe(db, parse(time).unwrap(), true).unwrap().unwrap();
        event.status = "failed".into();
        event.launch_at = None;
        event.error = Some("天气条件未通过：阵风 6.1 m/s，超过 6 m/s，需现场复核。".into());
        save(db, &event).unwrap();
        event
    }
    fn morning_restriction(db: &Connection) {
        let mut settings = crate::settings::read(db).unwrap();
        settings.no_fly_periods = crate::settings::Settings::default().no_fly_periods;
        put(db, "workspace_settings", &serde_json::to_string(&settings).unwrap()).unwrap();
    }
    #[test]
    fn deleting_no_fly_settings_refreshes_current_state_but_retains_the_skipped_hour() {
        let mut db = db(); morning_restriction(&db);
        let time = "2026-10-09 06:00:00";
        let at = parse("2026-10-09 07:00:00").unwrap();
        reading(&db, time, Some(1.33));
        // A previous attempt may already own this hour's deduplication receipt.
        put(&db, &format!("flight_handled:{time}"), "previous-attempt").unwrap();
        observe(&mut db, at, true).unwrap();
        let record = current(&db).unwrap().unwrap();
        let mut settings = crate::settings::read(&db).unwrap(); settings.no_fly_periods.clear();
        crate::settings::save_and_reconcile(&db, &settings, at).unwrap();
        assert!(current(&db).unwrap().is_none());
        assert!(crate::settings::read(&db).unwrap().no_fly_periods.is_empty());
        assert_eq!(setting(&db, &format!("flight_handled:{time}")).unwrap().as_deref(), Some("previous-attempt"));
        assert!(observe(&mut db, at, true).unwrap().is_none());
        crate::settings::save_and_reconcile(&db, &settings, at).unwrap();
        let records = view(&db).unwrap().records;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, record.id);
        assert_eq!(records[0].error, record.error);
        assert_eq!(records[0].status, "restricted");
    }
    #[test]
    fn edited_periods_reconcile_only_when_neither_current_nor_data_time_is_restricted() {
        let mut db = db(); morning_restriction(&db);
        reading(&db, "2026-10-09 06:00:00", Some(1.33));
        let at = parse("2026-10-09 07:00:00").unwrap(); observe(&mut db, at, true).unwrap();
        let record = current(&db).unwrap().unwrap();
        let mut settings = crate::settings::read(&db).unwrap();
        settings.no_fly_periods.push(crate::settings::NoFlyPeriod { start: "12:00".into(), end: "13:00".into() });
        crate::settings::save_and_reconcile(&db, &settings, at).unwrap();
        assert_eq!(current(&db).unwrap().unwrap().id, record.id);
        let mut invalid = settings.clone(); invalid.no_fly_periods[0].end = "05:00".into();
        assert!(crate::settings::save_and_reconcile(&db, &invalid, at).is_err());
        assert_eq!(crate::settings::read(&db).unwrap(), settings);
        assert_eq!(current(&db).unwrap().unwrap().id, record.id);
        settings.no_fly_periods.remove(0);
        crate::settings::save_and_reconcile(&db, &settings, at).unwrap();
        assert!(current(&db).unwrap().is_none());
        assert_eq!(view(&db).unwrap().records.len(), 1);
    }
    #[test]
    fn reading_state_repairs_an_already_saved_removal_without_affecting_active_flights() {
        let mut db = db(); morning_restriction(&db);
        reading(&db, "2026-10-09 06:00:00", Some(1.33));
        observe(&mut db, parse("2026-10-09 07:00:00").unwrap(), true).unwrap();
        configure(&db, 1.0, 5, false);
        assert!(view(&db).unwrap().event.is_none());
        assert_eq!(view(&db).unwrap().records.len(), 1);
        for status in ["countdown", "preparing", "submitting", "submitted", "uncertain", "flying", "failed", "canceled"] {
            let mut event = new_event("2026-10-09 06:00:00".into(), Some(1.33), false);
            event.status = status.into(); save(&db, &event).unwrap();
            let settings = crate::settings::read(&db).unwrap();
            crate::settings::save_and_reconcile(&db, &settings, now()).unwrap();
            assert_eq!(view(&db).unwrap().event.unwrap().id, event.id, "{status}");
        }
    }
    #[test]
    fn restricted_hours_are_persisted_once_and_never_replayed_after_the_window() {
        let mut db = db(); morning_restriction(&db);
        for hour in [5, 6, 7] {
            let time = format!("2026-10-09 {hour:02}:00:00");
            reading(&db, &time, Some(1.36));
            let at = parse(&time).unwrap();
            assert!(observe(&mut db, at, false).unwrap().is_none());
            let record = current(&db).unwrap().unwrap();
            assert_eq!(record.status, "restricted");
            assert!(record.error.as_deref().unwrap().contains("禁飞时间：05:00–08:00"));
            assert!(record.launch_at.is_none());
            assert!(observe(&mut db, at, true).unwrap().is_none());
            assert_eq!(current(&db).unwrap().unwrap().id, record.id);
        }
        assert_eq!(view(&db).unwrap().records.len(), 3);
        assert!(observe(&mut db, parse("2026-10-09 08:00:00").unwrap(), true).unwrap().is_none());
        assert_eq!(current(&db).unwrap().unwrap().status, "restricted");
        reading(&db, "2026-10-09 08:00:00", Some(1.36));
        let next = observe(&mut db, parse("2026-10-09 08:00:00").unwrap(), true).unwrap().unwrap();
        assert_eq!(next.status, "countdown");
        assert_eq!(next.observed_at, "2026-10-09 08:00:00");
        assert_eq!(view(&db).unwrap().records.len(), 3);
    }
    #[test]
    fn countdown_is_stopped_on_entering_a_period_even_before_its_deadline() {
        let mut db = db(); configure(&db, 1.0, 180, false);
        reading(&db, "2026-10-09 04:00:00", Some(1.36));
        let event = observe(&mut db, parse("2026-10-09 04:00:00").unwrap(), true).unwrap().unwrap();
        morning_restriction(&db);
        let at = (parse("2026-10-09 05:00:00").unwrap() - Duration::hours(8)).and_utc().timestamp_millis();
        assert!(event.launch_at.unwrap() > at);
        assert!(claim_due(&db, at).unwrap().is_none());
        assert_eq!(current(&db).unwrap().unwrap().status, "restricted");
        assert_eq!(setting(&db, "flight_episode").unwrap().as_deref(), Some(""));
        assert!(claim_due(&db, at + 3*3600000).unwrap().is_none());
        assert_eq!(view(&db).unwrap().records[0].id, event.id);
    }
    #[test]
    fn manual_weather_override_cannot_bypass_no_fly_time_but_preview_still_does_not_launch() {
        let db = db(); let at = now();
        let mut settings = crate::settings::read(&db).unwrap();
        settings.no_fly_periods = vec![crate::settings::NoFlyPeriod { start: (at - Duration::minutes(1)).format("%H:%M").to_string(), end: (at + Duration::minutes(1)).format("%H:%M").to_string() }];
        put(&db, "workspace_settings", &serde_json::to_string(&settings).unwrap()).unwrap();
        assert!(begin_manual_request(&db, false, None, true).unwrap_err().contains("禁飞时间"));
        assert!(current(&db).unwrap().is_none());
        let preview = begin_manual_request(&db, true, None, false).unwrap();
        assert!(preview.preview);
        assert!(needs_confirmation(&db, &preview).unwrap());
    }
    #[test]
    fn forbidden_observation_is_recorded_without_overwriting_an_unresolved_flight() {
        for status in ["submitted", "uncertain", "flying", "submitting", "paused"] {
            let mut db = db(); morning_restriction(&db);
            let mut event = new_event("2026-10-09 04:00:00".into(), Some(1.36), false);
            event.status = status.into(); save(&db, &event).unwrap();
            reading(&db, "2026-10-09 05:00:00", Some(1.36));
            assert!(observe(&mut db, parse("2026-10-09 05:00:00").unwrap(), true).unwrap().is_none());
            assert_eq!(current(&db).unwrap().unwrap().id, event.id);
            assert_eq!(current(&db).unwrap().unwrap().status, status);
            assert_eq!(view(&db).unwrap().records[0].status, "restricted");
        }
    }
    #[test]
    fn new_restriction_preserves_the_failed_receipt_and_does_not_claim_normal_data() {
        let mut db = db(); let failed = failed_automatic(&mut db); morning_restriction(&db);
        reading(&db, "2026-10-09 05:00:00", Some(1.36));
        observe(&mut db, parse("2026-10-09 06:00:00").unwrap(), true).unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "restricted");
        assert!(view(&db).unwrap().records.iter().any(|r| r.id == failed.id && r.error == failed.error));
        reading(&db, "2026-10-09 06:00:00", Some(0.2));
        observe(&mut db, parse("2026-10-09 07:00:00").unwrap(), true).unwrap();
        assert!(setting(&db, "flight_restricted:2026-10-09 06:00:00").unwrap().is_none());
    }
    #[test]
    fn new_normal_hour_releases_failed_automatic_task_and_night_exceedance_launches() {
        let mut db = db();
        let failed = failed_automatic(&mut db);
        configure(&db, 1.0, 5, false);
        // The failed 19:00 attempt must not block normal 20:00 data or the
        // following 22:00 exceedance, even when weather is still unsuitable.
        reading(&db, "2026-10-08 20:00:00", Some(0.74));
        assert!(observe(&mut db, parse("2026-10-08 21:00:00").unwrap(), false).unwrap().is_none());
        assert!(current(&db).unwrap().is_none());
        assert_eq!(setting(&db, "flight_episode").unwrap().as_deref(), Some(""));
        let history: Event = serde_json::from_str(&setting(&db, &format!("flight_history:{}", failed.id)).unwrap().unwrap()).unwrap();
        assert_eq!(history.id, failed.id);
        assert_eq!(history.status, "failed");
        assert_eq!(history.error, failed.error);
        recover(&db).unwrap();
        reading(&db, "2026-10-08 22:00:00", Some(1.35));
        let at = parse("2026-10-08 23:00:00").unwrap();
        let next = observe(&mut db, at, true).unwrap().unwrap();
        assert_ne!(next.id, failed.id);
        assert_eq!(next.name, "钾离子超标巡查-20261008-22");
        assert_eq!(next.status, "countdown");
        assert_eq!(next.potassium, Some(1.35));
        assert_eq!(next.launch_at, Some((at - Duration::hours(8)).and_utc().timestamp_millis() + 300000));
        assert!(observe(&mut db, at, true).unwrap().is_none());
    }
    #[test]
    fn failed_automatic_retries_only_on_new_hour_and_keeps_old_hour_handled() {
        let mut db = db();
        let failed = failed_automatic(&mut db);
        let at = parse("2026-10-08 20:00:00").unwrap();
        reading(&db, "2026-10-08 19:00:00", Some(1.36));
        assert!(observe(&mut db, at, true).unwrap().is_none());
        assert_eq!(current(&db).unwrap().unwrap().id, failed.id);
        reading(&db, "2026-10-08 20:00:00", Some(1.36));
        let next = observe(&mut db, at, true).unwrap().unwrap();
        assert_ne!(next.id, failed.id);
        assert_eq!(setting(&db, "flight_handled:2026-10-08 19:00:00").unwrap().as_deref(), Some(failed.id.as_str()));
        assert_eq!(setting(&db, "flight_handled:2026-10-08 20:00:00").unwrap().as_deref(), Some(next.id.as_str()));
        assert!(observe(&mut db, at, true).unwrap().is_none());
    }
    #[test]
    fn released_failure_waits_for_weather_and_automatic_permission_without_consuming_hour() {
        for weather_block in [true, false] {
            let mut db = db();
            failed_automatic(&mut db);
            let time = "2026-10-08 20:00:00";
            let at = parse(time).unwrap();
            reading(&db, time, Some(1.36));
            if !weather_block { put(&db, "flight_launch_enabled", "false").unwrap(); }
            assert!(observe(&mut db, at, !weather_block).unwrap().is_none());
            assert!(current(&db).unwrap().is_none());
            assert!(setting(&db, &format!("flight_handled:{time}")).unwrap().is_none());
            assert_eq!(setting(&db, "flight_episode").unwrap().as_deref(), Some(""));
            recover(&db).unwrap();
            put(&db, "flight_launch_enabled", "true").unwrap();
            assert!(observe(&mut db, at, true).unwrap().is_some());
        }
    }
    #[test]
    fn missing_expired_or_future_hours_do_not_release_a_failure() {
        for (time, k) in [("2026-10-08 20:00:00", None), ("2026-10-08 20:00:00", Some(1.36)), ("2026-10-09 06:00:00", Some(1.36))] {
            let mut db = db();
            let failed = failed_automatic(&mut db);
            reading(&db, time, k);
            assert!(observe(&mut db, parse("2026-10-09 05:00:00").unwrap(), true).unwrap().is_none());
            assert_eq!(current(&db).unwrap().unwrap().id, failed.id);
            assert!(setting(&db, &format!("flight_history:{}", failed.id)).unwrap().is_none());
        }
    }
    #[test]
    fn new_hour_does_not_replace_active_uncertain_manual_or_preview_tasks() {
        for status in ["countdown", "preparing", "ready", "submitting", "submitted", "uncertain", "flying", "paused", "flight_error", "canceled", "completed", "dismissed", "manual_failed", "preview_failed"] {
            let mut db = db();
            let mut event = failed_automatic(&mut db);
            match status {
                "manual_failed" => event.source = "manual".into(),
                "preview_failed" => event.preview = true,
                _ => event.status = status.into(),
            }
            save(&db, &event).unwrap();
            reading(&db, "2026-10-08 20:00:00", Some(1.36));
            assert!(observe(&mut db, parse("2026-10-08 20:00:00").unwrap(), true).unwrap().is_none(), "{status}");
            let actual = current(&db).unwrap().unwrap();
            assert_eq!(actual.id, event.id, "{status}");
            assert_eq!(actual.status, event.status, "{status}");
        }
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
    fn manual_and_preview_cancellation_do_not_consume_automatic_episode() {
        for preview in [false, true] {
            let mut db = db();
            let t = parse("2026-09-22 10:00:00").unwrap();
            let time = "2026-09-22 09:00:00";
            reading(&db, time, Some(2.));
            let manual = begin_manual(&db, preview).unwrap();
            // An active task prevents concurrent flights, but must not consume
            // the automatic trigger when a sync observes the same exceedance.
            assert!(observe(&mut db, t, true).unwrap().is_none());
            cancel(&db, &manual.id).unwrap();
            recover(&db).unwrap();
            assert!(setting(&db, "flight_episode").unwrap().is_none());
            assert!(setting(&db, &format!("flight_handled:{time}")).unwrap().is_none());
            let automatic = observe(&mut db, t, true).unwrap().unwrap();
            assert_eq!(automatic.source, "auto");
            assert_ne!(automatic.id, manual.id);
        }
    }
    #[test]
    fn manual_cancellation_preserves_an_already_canceled_automatic_episode() {
        let mut db = db();
        let t = parse("2026-09-22 10:00:00").unwrap();
        let time = "2026-09-22 09:00:00";
        reading(&db, time, Some(2.));
        let automatic = observe(&mut db, t, true).unwrap().unwrap();
        cancel(&db, &automatic.id).unwrap();
        let manual = begin_manual(&db, false).unwrap();
        cancel(&db, &manual.id).unwrap();
        recover(&db).unwrap();
        assert_eq!(setting(&db, "flight_episode").unwrap().as_deref(), Some(time));
        assert_eq!(setting(&db, &format!("flight_handled:{time}")).unwrap().as_deref(), Some(automatic.id.as_str()));
        assert!(observe(&mut db, t, true).unwrap().is_none());
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t, true).unwrap().is_none());
        reading(&db, "2026-09-22 10:00:00", Some(0.5));
        observe(&mut db, t, true).unwrap();
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert_eq!(observe(&mut db, t, true).unwrap().unwrap().source, "auto");
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
        configure(&db, 1.0, 5, true);
        put(&db, "flight_enabled", "true").unwrap();
        assert!(!enabled(&db).unwrap());
        let manual = begin_manual(&db, false).unwrap();
        assert_eq!(manual.source, "manual");
        assert!(manual.name.starts_with("手动巡查-"));
    }
    #[test]
    fn manual_retry_replaces_only_the_confirmed_failed_event_and_preserves_automatic_dedup() {
        let mut db = db();
        let t = parse("2026-10-08 19:00:00").unwrap();
        reading(&db, "2026-10-08 19:00:00", Some(2.));
        let mut automatic = observe(&mut db, t, true).unwrap().unwrap();
        automatic.status = "failed".into(); automatic.error = Some("天气条件未通过".into()); save(&db, &automatic).unwrap();
        assert!(begin_manual(&db, false).is_err());
        assert!(begin_manual_request(&db, false, Some("stale-id"), true).is_err());
        assert_eq!(current(&db).unwrap().unwrap().id, automatic.id);
        let manual = begin_manual_request(&db, false, Some(&automatic.id), true).unwrap();
        assert_ne!(manual.id, automatic.id);
        assert_eq!(manual.source, "manual");
        assert!(has_manual_weather_override(&manual));
        let history: Event = serde_json::from_str(&setting(&db, &format!("flight_history:{}", automatic.id)).unwrap().unwrap()).unwrap();
        assert_eq!(history.status, "failed"); assert_eq!(history.error, automatic.error);
        assert_eq!(setting(&db, "flight_episode").unwrap().as_deref(), Some("2026-10-08 19:00:00"));
        assert!(begin_manual_request(&db, false, Some(&automatic.id), true).is_err());
        cancel(&db, &manual.id).unwrap();
        let next = begin_manual(&db, false).unwrap();
        assert!(!has_manual_weather_override(&next));
        assert!(next.weather_override_confirmed_at.is_none());
    }
    #[test]
    fn manual_override_cannot_replace_a_submitted_uncertain_or_active_flight() {
        let db = db();
        for status in ["countdown", "preparing", "ready", "submitting", "submitted", "uncertain", "flying", "paused", "flight_error"] {
            let mut event = new_event("2026-10-08 19:00:00".into(), Some(2.), false);
            event.status = status.into(); save(&db, &event).unwrap();
            assert!(begin_manual_request(&db, false, Some(&event.id), true).is_err());
            assert!(begin_manual_request(&db, false, None, true).is_err());
            assert_eq!(current(&db).unwrap().unwrap().id, event.id);
        }
    }
    #[test]
    fn weather_override_is_opt_in_and_exclusive_to_real_manual_attempts() {
        let db = db();
        let normal = begin_manual(&db, false).unwrap();
        assert!(!has_manual_weather_override(&normal));
        let mut automatic = new_event("2026-10-08 19:00:00".into(), Some(2.), false);
        automatic.weather_override_confirmed_at = Some(1);
        assert!(!has_manual_weather_override(&automatic));
        let mut preview = automatic.clone(); preview.source = "manual".into(); preview.preview = true;
        assert!(!has_manual_weather_override(&preview));
        assert!(begin_manual_request(&db, true, None, true).is_err());
        // Older persisted events have no confirmation and continue to use weather gates.
        let mut legacy = serde_json::to_value(&normal).unwrap();
        legacy.as_object_mut().unwrap().remove("weatherOverrideConfirmedAt");
        assert!(!has_manual_weather_override(&serde_json::from_value(legacy).unwrap()));
    }
    #[test]
    fn checking_a_pending_platform_task_resolves_uncertainty_without_allowing_retry() {
        let db = db();
        let mut event = new_event("2026-10-11 14:00:00".into(), None, false);
        event.status = "uncertain".into(); save(&db, &event).unwrap();
        record_check_error(&db, &event.id, &event.name, "之前核查超时").unwrap();
        apply_observation(&db, &event.id, &event.name, "待执行").unwrap();
        let pending = current(&db).unwrap().unwrap();
        assert_eq!(pending.status, "submitted");
        assert!(pending.status_check_error.is_none());
        assert!(pending.status_checked_at.is_some());
        assert!(begin_manual_request(&db, false, Some(&event.id), false).is_err());
    }
    #[test]
    fn confirmed_weather_block_restores_normal_manual_launch_without_automatic_retry() {
        let mut db = db();
        let mut event = new_event("2026-10-11 14:00:00".into(), None, false);
        event.status = "uncertain".into(); event.error = Some("原提交超时回执".into());
        save(&db, &event).unwrap();
        record_check_error(&db, &event.id, &event.name, "司空列表未识别到该任务状态").unwrap();
        assert!(begin_manual(&db, false).is_err());
        let receipt = "司空平台天气阻飞：在线天气风速 12.75m/s；未继续执行";
        record_check_error(&db, "other-event", &event.name, receipt).unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "uncertain");
        record_check_error(&db, &event.id, &event.name, receipt).unwrap();
        let checked = current(&db).unwrap().unwrap();
        assert_eq!(checked.status, "not_flown");
        assert!(checked.error.as_ref().unwrap().contains("原提交超时回执"));
        assert!(checked.error.as_ref().unwrap().contains("12.75m/s"));
        assert!(checked.status_check_error.is_none());
        reading(&db, "2026-10-11 15:00:00", Some(2.));
        assert!(observe(&mut db, parse("2026-10-11 15:00:00").unwrap(), true).unwrap().is_none());
        let manual = begin_manual(&db, false).unwrap();
        assert_ne!(manual.id, event.id);
        assert_eq!(manual.source, "manual");
        assert!(view(&db).unwrap().records.iter().any(|r| r.id == event.id && r.status == "not_flown"));
    }
    #[test]
    fn weather_errors_cannot_release_a_known_submitted_or_executing_task() {
        let db = db();
        for status in ["submitted", "flying", "paused"] {
            let mut event = new_event("2026-10-11 14:00:00".into(), None, false);
            event.status = status.into(); save(&db, &event).unwrap();
            record_check_error(&db, &event.id, &event.name, "司空平台天气阻飞：在线天气风速 12.75m/s；未继续执行").unwrap();
            assert_eq!(current(&db).unwrap().unwrap().status, status);
            assert!(begin_manual(&db, false).is_err());
        }
    }
    #[test]
    fn explicit_refresh_releases_unresolved_reservation_and_preserves_history_without_auto_launch() {
        let mut db = db();
        let mut event = new_event("2026-10-11 14:00:00".into(), None, false);
        event.status = "uncertain".into(); event.source = "manual".into();
        event.error = Some("原起飞请求超时".into()); save(&db, &event).unwrap();
        assert!(!handle_unmatched_status(&db, &event.id, &event.name, false).unwrap());
        assert!(begin_manual(&db, false).is_err());
        assert!(!handle_unmatched_status(&db, "stale-id", &event.name, true).unwrap());
        assert!(handle_unmatched_status(&db, &event.id, &event.name, true).unwrap());
        assert!(current(&db).unwrap().is_none());
        let history = view(&db).unwrap().records.remove(0);
        assert_eq!(history.status, "uncertain");
        assert_eq!(history.error, event.error);
        assert!(history.status_check_error.unwrap().contains("解除本地任务占用"));
        reading(&db, "2026-10-11 15:00:00", Some(2.));
        assert!(observe(&mut db, parse("2026-10-11 15:00:00").unwrap(), true).unwrap().is_none());
        record_check_error(&db, &event.id, &event.name, "迟到的回执").unwrap();
        assert!(current(&db).unwrap().is_none());
        let next = begin_manual(&db, false).unwrap();
        assert_ne!(next.id, event.id);
        assert!(!handle_unmatched_status(&db, &event.id, &event.name, true).unwrap());
        assert_eq!(current(&db).unwrap().unwrap().id, next.id);
    }
    #[test]
    fn explicit_refresh_does_not_release_known_pending_or_active_flights() {
        let db = db();
        for status in ["submitted", "flying", "paused", "submitting"] {
            let mut event = new_event("2026-10-11 14:00:00".into(), None, false);
            event.status = status.into(); save(&db, &event).unwrap();
            assert!(!handle_unmatched_status(&db, &event.id, &event.name, true).unwrap());
            assert_eq!(current(&db).unwrap().unwrap().status, status);
            assert!(begin_manual(&db, false).is_err());
        }
    }

    #[test]
    fn review_ready_accepts_platform_completion_after_human_submit() {
        let db = db();
        let mut event = new_event("2026-10-11 10:00:00".into(), Some(2.0), false);
        event.status = "ready".into(); save(&db, &event).unwrap();
        apply_observation(&db, &event.id, &event.name, "执行成功").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "completed", "Human-confirmed flight must leave ready when platform confirms completion");
    }
    #[test]
    fn review_flight_error_can_reconcile_later_platform_success() {
        let db = db();
        let mut event = new_event("2026-10-11 10:00:00".into(), Some(2.0), false);
        event.status = "submitted".into(); save(&db, &event).unwrap();
        apply_observation(&db, &event.id, &event.name, "部分执行").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "flight_error");
        apply_observation(&db, &event.id, &event.name, "执行成功").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "completed", "Reconciled platform outcome must not be ignored forever");
    }
    #[test]
    fn review_completed_manual_task_is_retained_when_next_task_begins() {
        let db = db();
        let mut event = begin_manual(&db, false).unwrap();
        event.status = "completed".into(); save(&db, &event).unwrap();
        begin_manual(&db, false).unwrap();
        assert!(setting(&db, &format!("flight_history:{}", event.id)).unwrap().is_some(), "New manual task overwrote completed event and its weather audit trail");
    }
    #[test]
    fn review_completed_auto_task_is_retained_on_next_episode() {
        let mut db = db();
        reading(&db, "2026-10-11 10:00:00", Some(2.0));
        let mut event = observe(&mut db, parse("2026-10-11 10:00:00").unwrap(), true).unwrap().unwrap();
        event.status = "completed".into(); save(&db, &event).unwrap();
        reading(&db, "2026-10-11 11:00:00", Some(0.2));
        observe(&mut db, parse("2026-10-11 11:00:00").unwrap(), true).unwrap();
        reading(&db, "2026-10-11 12:00:00", Some(2.0));
        assert!(observe(&mut db, parse("2026-10-11 12:00:00").unwrap(), true).unwrap().is_some());
        assert!(setting(&db, &format!("flight_history:{}", event.id)).unwrap().is_some(), "Next automatic episode overwrote completed event and its weather audit trail");
    }
    #[test]
    fn review_not_flown_allows_a_new_episode_after_normal_hour() {
        let mut db = db();
        reading(&db, "2026-10-11 10:00:00", Some(2.0));
        let mut event = observe(&mut db, parse("2026-10-11 10:00:00").unwrap(), true).unwrap().unwrap();
        event.status = "uncertain".into(); save(&db, &event).unwrap();
        record_check_error(&db, &event.id, &event.name, "司空平台天气阻飞：在线天气风速 12.75m/s；未继续执行").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "not_flown");
        reading(&db, "2026-10-11 11:00:00", Some(0.2));
        observe(&mut db, parse("2026-10-11 11:00:00").unwrap(), true).unwrap();
        assert_eq!(setting(&db, "flight_episode").unwrap().as_deref(), Some(""));
        reading(&db, "2026-10-11 12:00:00", Some(2.0));
        assert!(observe(&mut db, parse("2026-10-11 12:00:00").unwrap(), true).unwrap().is_some(), "Fresh episode remains blocked by previous not_flown event");
    }

    #[test]
    fn ready_and_exception_tracking_survives_restart_but_never_polls_previews() {
        let db = db();
        for status in ["ready", "flight_error"] {
            let mut event = new_event("2026-10-11 10:00:00".into(), Some(2.), false);
            event.status = status.into(); save(&db, &event).unwrap(); recover(&db).unwrap();
            assert!(trackable(&current(&db).unwrap().unwrap()));
            assert!(!handle_unmatched_status(&db, &event.id, &event.name, true).unwrap());
            assert_eq!(current(&db).unwrap().unwrap().status, status);
            apply_observation(&db, &event.id, &event.name, "待执行").unwrap();
            assert_eq!(current(&db).unwrap().unwrap().status, "submitted");
            for (platform, expected) in [("执行中", "flying"), ("已暂停", "paused"), ("执行中", "flying"), ("执行成功", "completed")] {
                apply_observation(&db, &event.id, &event.name, platform).unwrap();
                assert_eq!(current(&db).unwrap().unwrap().status, expected);
            }
        }
        let mut preview = begin_manual(&db, true).unwrap();
        preview.status = "ready".into(); save(&db, &preview).unwrap();
        assert!(!trackable(&preview));
        apply_observation(&db, &preview.id, &preview.name, "执行成功").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "ready");
        close_reviewed(&db, &preview.id, "ready", true).unwrap();
        assert!(current(&db).unwrap().is_none());
        assert!(setting(&db, "flight_episode").unwrap().is_none());
    }
    #[test]
    fn closing_requires_current_id_state_and_confirmation_and_keeps_weather() {
        let mut db = db();
        for status in ["ready", "flight_error", "failed"] {
            let mut event = new_event("2026-10-11 10:00:00".into(), Some(2.), false);
            event.status = status.into(); event.error = Some("原始回执".into());
            event.weather_checks.push(recorded_weather("preparation", true, false));
            save(&db, &event).unwrap();
            assert!(close_reviewed(&db, &event.id, status, false).is_err());
            assert!(close_reviewed(&db, "stale-id", status, true).is_err());
            assert!(close_reviewed(&db, &event.id, "submitting", true).is_err());
            close_reviewed(&db, &event.id, status, true).unwrap();
            assert!(current(&db).unwrap().is_none());
            let archived: Event = serde_json::from_str(&setting(&db, &format!("flight_history:{}", event.id)).unwrap().unwrap()).unwrap();
            assert_eq!(archived.status, status);
            assert_eq!(archived.error, event.error);
            assert!(archived.resolved_at.is_some());
            assert_eq!(serde_json::to_value(&archived.weather_checks).unwrap(), serde_json::to_value(&event.weather_checks).unwrap());
            // A late platform result cannot restore a closed event or overwrite a replacement.
            apply_observation(&db, &event.id, &event.name, "执行中").unwrap();
            assert!(current(&db).unwrap().is_none());
            if status != "failed" {
                reading(&db, "2026-10-11 10:00:00", Some(2.));
                assert!(observe(&mut db, parse("2026-10-11 10:00:00").unwrap(), true).unwrap().is_none());
            }
        }
        reading(&db, "2026-10-11 11:00:00", Some(0.2));
        observe(&mut db, parse("2026-10-11 11:00:00").unwrap(), true).unwrap();
        reading(&db, "2026-10-11 12:00:00", Some(2.));
        assert!(observe(&mut db, parse("2026-10-11 12:00:00").unwrap(), true).unwrap().is_some());
    }
    #[test]
    fn closure_cannot_bypass_known_active_flight_or_a_changed_status() {
        let db = db();
        for status in ["countdown", "preparing", "submitting", "submitted", "uncertain", "flying", "paused"] {
            let mut event = new_event("2026-10-11 10:00:00".into(), Some(2.), false);
            event.status = status.into(); save(&db, &event).unwrap();
            assert!(close_reviewed(&db, &event.id, status, true).is_err());
            assert!(close_reviewed(&db, &event.id, "ready", true).is_err());
            assert!(close_reviewed(&db, &event.id, "failed", true).is_err());
            assert_eq!(current(&db).unwrap().unwrap().status, status);
            assert!(setting(&db, &format!("flight_history:{}", event.id)).unwrap().is_none());
        }
    }
    #[test]
    fn replacement_archive_and_new_event_commit_or_rollback_together() {
        let db = db();
        let mut previous = begin_manual(&db, false).unwrap();
        previous.status = "canceled".into();
        previous.weather_checks.push(recorded_weather("preparation", true, false));
        save(&db, &previous).unwrap();
        db.execute_batch("CREATE TRIGGER reject_replacement BEFORE UPDATE ON monitor_settings
            WHEN NEW.key='flight_event' BEGIN SELECT RAISE(ABORT, 'write failure'); END;").unwrap();
        assert!(begin_manual(&db, false).is_err());
        assert_eq!(current(&db).unwrap().unwrap().id, previous.id);
        assert!(setting(&db, &format!("flight_history:{}", previous.id)).unwrap().is_none());
        db.execute_batch("DROP TRIGGER reject_replacement").unwrap();
        let next = begin_manual(&db, false).unwrap();
        let history: Event = serde_json::from_str(&setting(&db, &format!("flight_history:{}", previous.id)).unwrap().unwrap()).unwrap();
        assert_eq!(history.status, "canceled");
        assert_eq!(history.weather_checks.len(), 1);
        apply_observation(&db, &previous.id, &previous.name, "执行成功").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().id, next.id);
    }

}
