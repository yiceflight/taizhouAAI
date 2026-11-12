use crate::{
    bridge::Bridge,
    monitoring::{database, now, parse, put, setting},
};
use chrono::Duration;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::Manager;

pub const PLAN_URL: &str = "https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49#/plan";
// When this client process started, in Unix milliseconds. A countdown armed
// before it cannot have been kept by a running scheduler.
static STARTED_AT: std::sync::LazyLock<i64> =
    std::sync::LazyLock::new(|| chrono::Utc::now().timestamp_millis());
#[derive(Default)]
pub struct Flight {
    busy: Arc<AtomicBool>,
    status_gate: tokio::sync::Mutex<()>,
    pub(crate) gate: Mutex<()>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    id: String,
    observed_at: String,
    #[serde(default)]
    source_hour: Option<String>,
    potassium: Option<f64>,
    #[serde(default)]
    pm25: Option<f64>,
    #[serde(default)]
    route: Option<String>,
    name: String,
    status: String,
    error: Option<String>,
    preview: bool,
    #[serde(default)]
    source: String,
    #[serde(default)]
    launch_at: Option<i64>,
    // Automatic attempts for one source hour keep their own receipt. The count
    // is persisted on the event so a client restart cannot refund attempts and
    // the operator can see why the same hour stopped retrying.
    #[serde(default)]
    pub(crate) attempt: u32,
    #[serde(default)]
    pub(crate) retry_at: Option<i64>,
    // The failed receipt this attempt superseded; released when this attempt
    // actually starts, so the operator cannot retry the same failure again.
    #[serde(default)]
    retried_event_id: Option<String>,
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
    WeatherCheck {
        checked_at: chrono::Utc::now().timestamp_millis(),
        stage: "creation".into(),
        weather: crate::weather::view(app),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    event: Option<Event>,
    threshold: f64,
    delay_minutes: u32,
    records: Vec<Event>,
    tasks_cleared_at: Option<i64>,
    routes: Vec<FlightRoute>,
    selected_route: Option<String>,
    routes_synced_at: Option<i64>,
    // The client shows how much automatic recovery is left; it must not
    // hard-code a limit that the scheduler owns.
    attempt_limit: u32,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlightRoute {
    pub route_id: String,
    pub name: String,
    #[serde(default)]
    pub update_time: i64,
    #[serde(default)]
    pub folder_path: Vec<RouteFolder>,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct RouteFolder { pub id: String, pub name: String }
impl FlightRoute {
    fn selection(&self) -> String {
        self.folder_path.iter().map(|f| f.name.as_str()).chain(std::iter::once(self.name.as_str())).collect::<Vec<_>>().join(" / ")
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutesView {
    pub routes: Vec<FlightRoute>,
    pub selected: Option<String>,
    pub synced_at: Option<i64>,
}
fn route_name(value: &str) -> String { value.split_whitespace().collect::<String>().trim().to_string() }
fn read_routes(db: &Connection) -> Result<Vec<FlightRoute>, String> {
    setting(db, "flight_routes")?.map(|raw| serde_json::from_str(&raw).map_err(|e| format!("航线列表读取失败：{e}"))).transpose().map(|v| v.unwrap_or_default())
}
fn selected_route(db: &Connection) -> Result<Option<String>, String> {
    let Some(stored) = setting(db, "flight_route")?.filter(|v| !route_name(v).is_empty()) else {
        return Ok(None);
    };
    let routes = read_routes(db)?;
    // An ambiguous saved name is not a valid selection, but the catalog must
    // remain readable so the operator can choose another route or sync again.
    Ok(exact_route_match(&routes, &stored).unwrap_or(None))
}
fn exact_route_match(routes: &[FlightRoute], requested: &str) -> Result<Option<String>, String> {
    let exact: Vec<_> = routes.iter()
        .filter(|route| (route_name(&route.selection()) == route_name(requested) || route_name(&route.name) == route_name(requested)))
        .cloned().collect();
    best_route_match(&exact, requested)
}
fn route_view(db: &Connection) -> Result<RoutesView, String> {
    Ok(RoutesView { routes: read_routes(db)?, selected: selected_route(db)?, synced_at: setting(db, "flight_routes_synced_at")?.and_then(|v| v.parse().ok()) })
}
// For prefix-related names, edit distance is exactly the difference in
// Unicode character counts. Exact matches score zero. Never break a tie by
// list order, update time or route name: those do not identify the intended route.
fn best_route_match(routes: &[FlightRoute], requested: &str) -> Result<Option<String>, String> {
    let wanted = route_name(requested);
    if wanted.is_empty() { return Ok(None); }
    let mut candidates: Vec<_> = routes.iter().filter_map(|route| {
        let name = if requested.contains(" / ") { route_name(&route.selection()) } else { route_name(&route.name) };
        (!name.is_empty() && (name.starts_with(&wanted) || wanted.starts_with(&name)))
            .then(|| (name.chars().count().abs_diff(wanted.chars().count()), route))
    }).collect();
    candidates.sort_by_key(|(distance, _)| *distance);
    let Some((distance, route)) = candidates.first() else { return Ok(None); };
    if candidates.get(1).is_some_and(|(next, _)| next == distance) {
        return Err(format!("航线“{requested}”有多个差异相同的匹配，请重新选择唯一航线。"));
    }
    Ok(Some(route.selection()))
}
fn direction_in_rule(direction: f64, start: f64, end: f64) -> bool {
    if start < end {
        direction >= start && direction < end
    } else {
        direction >= start || direction < end
    }
}
fn configured_route(
    settings: &crate::settings::Settings,
    routes: &[FlightRoute],
    default_route: Option<String>,
    wind_direction: Option<f64>,
) -> Result<String, String> {
    let default_route = default_route
        .as_deref().map(|selected| exact_route_match(routes, selected))
        .transpose()?.flatten();
    if settings.wind_route_rules.is_empty() {
        return default_route.ok_or_else(|| "请先在监测设置中同步并选择有效的默认航线。".into());
    }
    let Some(direction) = wind_direction
        .filter(|value| value.is_finite() && (0.0..360.0).contains(value)) else {
        return default_route
            .ok_or_else(|| "缺少有效预报风向，请先同步并选择有效的默认航线。".to_string());
    };
    let rule = settings
        .wind_route_rules
        .iter()
        .find(|rule| direction_in_rule(direction, rule.start_degrees, rule.end_degrees));
    let Some(rule) = rule else {
        return default_route
            .ok_or_else(|| format!("当前风向 {:.0}° 未匹配到航线规则，请先同步并选择有效的默认航线。", direction));
    };
    best_route_match(routes, &rule.route)?
        .ok_or_else(|| format!("风向 {:.0}° 对应的航线“{}”不在已同步航线列表中，请重新同步。", direction, rule.route))
}
fn route_configuration_ready(db: &Connection) -> Result<(), String> {
    if selected_route(db)?.is_none() {
        return Err("请先在监测设置中同步并选择有效的默认航线。".into());
    }
    Ok(())
}
fn launch_route(app: &tauri::AppHandle) -> Result<String, String> {
    let db = database(app)?;
    route_configuration_ready(&db)?;
    let settings = crate::settings::read(&db)?;
    configured_route(
        &settings,
        &read_routes(&db)?,
        selected_route(&db)?,
        (!settings.wind_route_rules.is_empty())
            .then(|| crate::weather::current_wind_direction(app))
            .flatten(),
    )
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
fn delay(db: &Connection) -> Result<u32, String> {
    let settings = crate::settings::read(db)?;
    Ok(if settings.require_manual_confirmation {
        0
    } else {
        settings.takeoff_delay_minutes
    })
}
fn needs_confirmation(db: &Connection, event: &Event) -> Result<bool, String> {
    Ok(event.preview
        || (event.source == "auto" && crate::settings::read(db)?.require_manual_confirmation))
}
pub(crate) fn require_clearable(db: &Connection) -> Result<(), String> {
    if current(db)?.is_some_and(|event| {
        !matches!(event.status.as_str(), "failed" | "completed" | "canceled" | "dismissed" | "restricted" | "not_flown")
            || trackable(&event)
    }) {
        return Err("仍有待执行、执飞中或结果待核查的巡查任务，请先在司空核实并结束处理后再清空数据。".into());
    }
    Ok(())
}
fn terminal(event: &Event) -> bool {
    matches!(
        event.status.as_str(),
        "dismissed" | "canceled" | "completed" | "restricted" | "not_flown"
    )
}
fn trackable(event: &Event) -> bool {
    !event.preview
        && event.source != "preview"
        && matches!(
            event.status.as_str(),
            "ready" | "submitted" | "uncertain" | "flying" | "paused" | "flight_error"
        )
        || (!event.preview
            && event.source != "preview"
            && event.status == "not_flown"
            && event
                .error
                .as_deref()
                .is_some_and(|message| {
                    message.contains("司空平台天气阻飞：") && message.ends_with("；未继续执行")
                }))
}
// All replacements archive the prior receipt in the same transaction.
fn replace_current(tx: &rusqlite::Transaction<'_>, event: &Event) -> Result<(), String> {
    if let Some(previous) = current(tx)?.filter(|old| old.id != event.id) {
        archive(tx, &previous)?;
    }
    save(tx, event)
}
pub fn view(db: &Connection) -> Result<View, String> {
    reconcile_restriction(db, &crate::settings::read(db)?, now())?;
    let mut stmt = db.prepare("SELECT value FROM monitor_settings AS records WHERE (key LIKE 'flight_history:%' OR key LIKE 'flight_restricted:%') AND NOT EXISTS (SELECT 1 FROM monitor_settings AS hidden WHERE hidden.key = 'flight_task_hidden:' || json_extract(records.value, '$.id')) ORDER BY json_extract(value, '$.observedAt') DESC LIMIT 30").map_err(|e| e.to_string())?;
    let raw = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut records = raw
        .iter()
        .map(|v| serde_json::from_str::<Event>(v).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut ids = std::collections::HashSet::new();
    records.retain(|event| ids.insert(event.id.clone()));
    let event = match current(db)? {
        Some(event) if setting(db, &format!("flight_task_hidden:{}", event.id))?.is_none() => {
            Some(event)
        }
        _ => None,
    };
    let tasks_cleared_at = setting(db, "flight_tasks_cleared_at")?
        .map(|value| value.parse::<i64>().map_err(|e| e.to_string()))
        .transpose()?;
    Ok(View {
        event,
        threshold: crate::settings::read(db)?.potassium_threshold,
        delay_minutes: delay(db)?,
        records,
        tasks_cleared_at,
        routes: read_routes(db)?,
        selected_route: selected_route(db)?,
        routes_synced_at: setting(db, "flight_routes_synced_at")?.and_then(|value| value.parse().ok()),
        attempt_limit: AUTOMATIC_ATTEMPTS,
    })
}
// Keep receipts and duplicate-flight guards intact. Failed preparation can be
// archived and released: no launch request was sent (unlike uncertain/flight_error).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearTasksResult {
    preserved_current_task: bool,
}
fn clear_tasks(db: &Connection, confirmed: bool, at: i64) -> Result<ClearTasksResult, String> {
    if !confirmed {
        return Err("请先确认清空任务列表。".into());
    }
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(mut event) = current(&tx)?.filter(|event| event.status == "failed") {
        event.resolved_at = Some(at);
        archive(&tx, &event)?;
        tx.execute("DELETE FROM monitor_settings WHERE key='flight_event'", [])
            .map_err(|e| e.to_string())?;
        // Clearing a failure must not immediately dispatch another automatic flight.
        if !event.preview
            && event.source != "preview"
            && setting(&tx, "flight_episode")?.is_none_or(|episode| episode.is_empty())
        {
            put(&tx, "flight_episode", &event.observed_at)?;
        }
    }
    let preserved = current(&tx)?.filter(|event| !terminal(event));
    let preserved_id = preserved.as_ref().map(|event| event.id.as_str());
    tx.execute("INSERT OR IGNORE INTO monitor_settings(key, value) SELECT 'flight_task_hidden:' || json_extract(value, '$.id'), 'true' FROM monitor_settings WHERE (key='flight_event' OR key LIKE 'flight_history:%' OR key LIKE 'flight_restricted:%') AND (?1 IS NULL OR json_extract(value, '$.id') != ?1)", [preserved_id]).map_err(|e| e.to_string())?;
    put(&tx, "flight_tasks_cleared_at", &at.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ClearTasksResult {
        preserved_current_task: preserved.is_some(),
    })
}
#[tauri::command]
pub fn clear_task_list(app: tauri::AppHandle, confirmed: bool) -> Result<ClearTasksResult, String> {
    let _access = crate::data_reset::access(&app)?;
    let state = app.state::<Flight>();
    let _gate = state.gate.lock().unwrap();
    clear_tasks(
        &database(&app)?,
        confirmed,
        chrono::Utc::now().timestamp_millis(),
    )
}
fn archive(db: &Connection, event: &Event) -> Result<(), String> {
    put(
        db,
        &format!("flight_history:{}", event.id),
        &serde_json::to_string(event).map_err(|e| e.to_string())?,
    )
}
pub(crate) fn reconcile_restriction(
    db: &Connection,
    settings: &crate::settings::Settings,
    at: chrono::NaiveDateTime,
) -> Result<(), String> {
    let Some(event) = current(db)?.filter(|e| e.status == "restricted") else {
        return Ok(());
    };
    if settings.no_fly_reason(at).is_some()
        || (event.source == "auto" && settings.no_fly_reason(parse(&event.observed_at)?).is_some())
    {
        return Ok(());
    }
    // A skip is historical once its restriction no longer applies. Preserve
    // the original reason and handled hour; changing settings is not a replay.
    archive(db, &event)?;
    db.execute("DELETE FROM monitor_settings WHERE key='flight_event' AND json_extract(value, '$.id')=? AND json_extract(value, '$.status')='restricted'", [&event.id]).map_err(|e| e.to_string())?;
    Ok(())
}
fn restriction_reason(
    db: &Connection,
    event: &Event,
    at: chrono::NaiveDateTime,
) -> Result<Option<String>, String> {
    let settings = crate::settings::read(db)?;
    Ok(settings.no_fly_reason(at).or(if event.source == "auto" {
        settings.no_fly_reason(parse(&event.observed_at)?)
    } else {
        None
    }))
}
fn restrict(db: &Connection, event: &mut Event, reason: String) -> Result<(), String> {
    event.status = "restricted".into();
    event.error = Some(reason);
    event.launch_at = None;
    archive(db, event)?;
    if event.source == "auto" {
        put(db, "flight_episode", "")?;
    }
    save(db, event)
}
fn auto_handled_for_hour(db: &Connection, hour: &str) -> Result<bool, String> {
    if setting(db, &format!("flight_retry_allowed:{hour}"))?.is_some() {
        return Ok(false);
    }
    if setting(db, &format!("flight_handled:{hour}"))?.is_some() {
        return Ok(true);
    }
    let current_match = current(db)?.is_some_and(|event| {
        event.source == "auto"
            && (event
                .source_hour
                .as_deref()
                .is_some_and(|source_hour| source_hour == hour)
                || (event.source_hour.is_none() && event.observed_at == hour))
    });
    if current_match {
        return Ok(true);
    }
    db.query_row(
        "SELECT 1 FROM monitor_settings WHERE key LIKE 'flight_history:%' AND json_extract(value, '$.source')='auto' AND (json_extract(value, '$.sourceHour')=?1 OR (json_extract(value, '$.sourceHour') IS NULL AND json_extract(value, '$.observedAt')=?1)) LIMIT 1",
        [hour],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|e| e.to_string())
}
fn recover(db: &Connection) -> Result<(), String> {
    // Repair the ended-manual-task release regression: observed_at is the request
    // time, not the monitoring hour. Only repair our confirmed archived receipt.
    if current(db)?.is_none() {
        if let Some(marker) = setting(db, "flight_episode")?.filter(|s| !s.is_empty()) {
            let raw: Option<String> = db.query_row(
                "SELECT value FROM monitor_settings WHERE key LIKE 'flight_history:%' AND json_extract(value, '$.source')='manual' AND json_extract(value, '$.status')='flight_error' AND json_extract(value, '$.observedAt')=?1 AND json_extract(value, '$.error') LIKE '司空任务已结束：%' ORDER BY rowid DESC LIMIT 1",
                [&marker], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
            if let Some(raw) = raw {
                let event: Event = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                if let Some(hour) = event.source_hour.filter(|h| parse(h).is_ok() && h < &marker) {
                    put(db, "flight_episode", &hour)?;
                }
            }
        }
    }
    // Older clients released an uncertain task on explicit refresh and guarded
    // it only with flight_episode. Restore that reservation before interpreting
    // the legacy timestamp as an hourly marker.
    if current(db)?.is_none() {
        if let Some(hour) = setting(db, "flight_episode")?.filter(|s| !s.is_empty()) {
            let legacy: Option<String> = db.query_row(
                "SELECT value FROM monitor_settings WHERE key LIKE 'flight_history:%' AND json_extract(value, '$.status')='uncertain' AND json_extract(value, '$.observedAt')=?1 AND json_extract(value, '$.resolvedAt') IS NULL ORDER BY rowid DESC LIMIT 1",
                [&hour], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
            if let Some(raw) = legacy {
                let event: Event = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                save(db, &event)?;
            }
        }
    }
    if let Some(mut event) = current(db)? {
        match event.status.as_str() {
            "countdown" => {
                event.status = "canceled".into();
                event.error = Some("客户端重启，已取消原倒计时。".into());
            }
            "preparing" => {
                event.status = "failed".into();
                event.error = Some("客户端中断，未发送起飞请求；请核查原计划。".into());
            }
            "submitting" => {
                event.status = "uncertain".into();
                event.error = Some("提交期间客户端中断，请到司空核查，勿重复起飞。".into());
            }
            _ => return Ok(()),
        }
        event.launch_at = None;
        save(db, &event)?;
    }
    Ok(())
}
pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    recover(&database(app)?)
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
        source_hour: None,
        potassium,
        pm25: None,
        route: None,
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
        source: if preview { "preview" } else { "auto" }.into(),
        launch_at: None,
        attempt: 1,
        retry_at: None,
        retried_event_id: None,
        status_check_error: None,
        status_checked_at: None,
        weather_override_confirmed_at: None,
        weather_checks: Vec::new(),
        resolved_at: None,
        flight_time: None,
        flight_time_checked_at: None,
    }
}
#[cfg(test)]
fn observe(
    db: &mut Connection,
    at: chrono::NaiveDateTime,
    weather_available: bool,
) -> Result<Option<Event>, String> {
    let check = if weather_available {
        None
    } else {
        Some(tests::recorded_weather("creation", false, true))
    };
    observe_with_weather(db, at, check)
}
// The newest fresh reading across every configured metric, plus whether it
// exceeds its own threshold. Automatic retries re-evaluate this so a retry can
// never launch for data that has since expired, turned normal or moved on.
struct TriggerReading {
    time: String,
    k: Option<f64>,
    pm25: Option<f64>,
    exceeded: bool,
}
fn latest_trigger(
    db: &Connection,
    settings: &crate::settings::Settings,
    at: chrono::NaiveDateTime,
) -> Result<Option<TriggerReading>, String> {
    let mut readings = Vec::new();
    for (field, enabled, threshold) in [
        ("potassium", settings.potassium_enabled, settings.potassium_threshold),
        ("pm25", settings.pm25_enabled, settings.pm25_threshold),
    ] {
        if !enabled { continue; }
        let row: Option<(String, f64)> = db.query_row(
            &format!("SELECT observed_at,{field} FROM hourly_observations WHERE city_code='321200' AND {field} IS NOT NULL ORDER BY observed_at DESC LIMIT 1"), [],
            |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
        if let Some((time, value)) = row {
            let age = at - parse(&time)?;
            if value.is_finite() && age >= Duration::zero() && age <= Duration::hours(3) {
                readings.push((time, field, value, value > threshold));
            }
        }
    }
    readings.sort_by(|a, b| b.0.cmp(&a.0));
    let Some(selected) = readings.iter().find(|r| r.3).or_else(|| readings.first()) else {
        return Ok(None);
    };
    Ok(Some(TriggerReading {
        time: selected.0.clone(),
        k: readings.iter().find(|r| r.1 == "potassium" && r.0 == selected.0).map(|r| r.2),
        pm25: readings.iter().find(|r| r.1 == "pm25" && r.0 == selected.0).map(|r| r.2),
        exceeded: selected.3,
    }))
}
fn observe_with_weather(
    db: &mut Connection,
    at: chrono::NaiveDateTime,
    check: Option<WeatherCheck>,
) -> Result<Option<Event>, String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let settings = crate::settings::read(&tx)?;
    // Each configured metric has its own reporting clock. Never let a newer
    // normal PM2.5 row hide a delayed, still-fresh potassium exceedance.
    // The task binds to the newest exceeding source hour, not the other
    // metric's newer normal hour. Normal readings never consume an hour.
    let Some(reading) = latest_trigger(&tx, &settings, at)? else { return Ok(None); };
    // Event values belong to the bound hour; do not mislabel mixed-hour data.
    let (time, k, pm25) = (reading.time.clone(), reading.k, reading.pm25);
    // Failed means no launch request was sent. All sources, including manual
    // and preview attempts, release their slot on the next valid source hour.
    // Keep the original receipt and handled-hour guards in the same transaction.
    // Older extension workers could leave an automatic event failed solely
    // because their review overlay was missing after an update. The form was
    // never submitted in that case, so a compatible automatic configuration
    // can safely release that same hour once and let the current worker retry.
    if let Some(event) = current(&tx)?.filter(|e| {
        !settings.require_manual_confirmation
            && e.status == "failed"
            && e.source == "auto"
            && e.source_hour.as_deref() == Some(time.as_str())
            && (e.potassium.is_some_and(|value| value > settings.potassium_threshold)
                || e.pm25.is_some_and(|value| value > settings.pm25_threshold))
            && e.error.as_deref().is_some_and(|message| message.contains("核对面板"))
    }) {
        archive(&tx, &event)?;
        tx.execute("DELETE FROM monitor_settings WHERE key='flight_event'", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM monitor_settings WHERE key=?1", [format!("flight_handled:{time}")])
            .map_err(|e| e.to_string())?;
        put(&tx, &format!("flight_retry_allowed:{time}"), "true")?;
        put(&tx, "flight_episode", "")?;
    }
    if let Some(event) = current(&tx)?.filter(|e| e.status == "failed") {
        // Manual creation timestamps include minutes/seconds; monitoring::parse
        // deliberately accepts only whole-hour observation timestamps.
        let failed_at =
            chrono::NaiveDateTime::parse_from_str(&event.observed_at, "%Y-%m-%d %H:%M:%S")
                .map_err(|_| "失败任务时间格式错误")?;
        if parse(&time)?.and_utc().timestamp().div_euclid(3600)
            > failed_at.and_utc().timestamp().div_euclid(3600)
        {
            archive(&tx, &event)?;
            tx.execute("DELETE FROM monitor_settings WHERE key='flight_event'", [])
                .map_err(|e| e.to_string())?;
            put(&tx, "flight_episode", "")?;
        }
    }
    let potassium_exceeded = k.is_some_and(|value| value > settings.potassium_threshold);
    let pm25_exceeded = pm25.is_some_and(|value| value > settings.pm25_threshold);
    if potassium_exceeded || pm25_exceeded {
        if let Some(reason) = settings
            .no_fly_reason(parse(&time)?)
            .or_else(|| settings.no_fly_reason(at))
        {
            let key = format!("flight_restricted:{time}");
            if setting(&tx, &key)?.is_none() {
                let mut record = new_event(time.clone(), k, false);
                record.pm25 = pm25;
                if !potassium_exceeded && pm25_exceeded {
                    record.name = record.name.replace("钾离子超标", "PM2.5超标");
                }
                record.source_hour = Some(time.clone());
                record.weather_checks.extend(check.clone());
                record.status = "restricted".into();
                record.error = Some(reason);
                put(
                    &tx,
                    &key,
                    &serde_json::to_string(&record).map_err(|e| e.to_string())?,
                )?;
                if setting(&tx, &format!("flight_handled:{time}"))?.is_none() {
                    put(&tx, &format!("flight_handled:{time}"), &record.id)?;
                }
                let previous = current(&tx)?;
                if previous.as_ref().is_none_or(terminal) {
                    replace_current(&tx, &record)?;
                    put(&tx, "flight_episode", "")?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(None);
        }
    }
    if !potassium_exceeded && !pm25_exceeded {
        put(&tx, "flight_episode", "")?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(None);
    }
    // Legacy episode timestamps now suppress only that hour (and older data).
    // Persistent handled-hour receipts remain authoritative across restarts.
    if setting(&tx, "flight_episode")?.is_some_and(|hour| !hour.is_empty() && hour >= time)
        || current(&tx)?.is_some_and(|e| !terminal(&e))
        || auto_handled_for_hour(&tx, &time)?
    {
        // Persist the released failure even when settings
        // prevent a new task; a later sync can reevaluate the latest reading.
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(None);
    }
    let mut event = new_event(time.clone(), k, false);
    event.pm25 = pm25;
    if !potassium_exceeded && pm25_exceeded {
        event.name = event.name.replace("钾离子超标", "PM2.5超标");
    }
    event.source_hour = Some(time.clone());
    event.weather_checks.extend(check);
    event.status = "countdown".into();
    event.launch_at = Some(
        (at - Duration::hours(8)).and_utc().timestamp_millis() + i64::from(delay(&tx)?) * 60000,
    );
    put(&tx, "flight_episode", &time)?;
    put(&tx, &format!("flight_handled:{time}"), &event.id)?;
    tx.execute("DELETE FROM monitor_settings WHERE key=?1", [format!("flight_retry_allowed:{time}")])
        .map_err(|e| e.to_string())?;
    replace_current(&tx, &event)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(event))
}
struct Busy(Arc<AtomicBool>);
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn update_current(app: &tauri::AppHandle, event: &Event) -> Result<bool, String> {
    let state = app.state::<Flight>();
    let _gate = state.gate.lock().unwrap();
    let db = database(app)?;
    if current(&db)?.is_some_and(|e| e.id == event.id && !terminal(&e)) {
        save(&db, event)?;
        Ok(true)
    } else {
        Ok(false)
    }
}
async fn execute(app: &tauri::AppHandle, mut event: Event) -> Result<(), String> {
    if prevent_restricted_launch(app, &mut event)? {
        return Ok(());
    }
    crate::weather::refresh_for_route(app).await;
    let route = match launch_route(app).and_then(|route| {
        let routes = read_routes(&database(app)?)?;
        if routes.iter().any(|r| r.selection() == route && !r.folder_path.is_empty()) { Ok(route) }
        else { Err("航线缺少文件夹信息，请重新同步航线".into()) }
    }) {
        Ok(route) => route,
        Err(error) => {
            // A missing route or folder needs the operator, not another attempt.
            fail(app, &mut event, error.clone(), false)?;
            return Err(error);
        }
    };
    let route_detail = read_routes(&database(app)?)?.into_iter().find(|r| r.selection() == route)
        .ok_or("航线已变化，请重新同步并选择")?;
    if route_detail.folder_path.is_empty() { return Err("航线缺少文件夹信息，请重新同步航线".into()); }
    event.route = Some(route.clone());
    update_current(app, &event)?;
    let auto_submit = !needs_confirmation(&database(app)?, &event)?;
    let preparation = app
        .state::<Bridge>()
        .prepare_flight(&event.id, &event.name, &route_detail, auto_submit)
        .await
        .and_then(|data| {
            if data["status"] != "ready"
                || data["submitted"] != false
                || data["name"] != event.name
                || data["url"] != format!("{PLAN_URL}/create-plan")
            {
                Err("计划填写回执不匹配；未发送起飞请求。".into())
            } else {
                Ok(())
            }
        });
    if let Err(error) = preparation {
        // Preparation failures happen before any launch request exists, so a
        // bounded retry with a fresh draft is safe and needs no platform check.
        fail(app, &mut event, error.clone(), true)?;
        return Err(error);
    }
    if !auto_submit || needs_confirmation(&database(app)?, &event)? {
        event.status = "ready".into();
        update_current(app, &event)?;
        return Ok(());
    }
    // Keep the task cancelable throughout the review interval. The browser
    // panel starts its countdown when the verified preparation returns.
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    if prevent_restricted_launch(app, &mut event)? {
        return Ok(());
    }
    // Nothing has been clicked yet, so a readiness loss still ends this attempt
    // before any launch request exists.
    if let Err(error) = crate::readiness::require_flight(app) {
        fail(app, &mut event, error.clone(), true)?;
        return Err(error);
    }
    // FlightHub decides whether to allow takeoff when the request is submitted.
    // Cancel can win while preparation awaits Chrome. The short gate is held only
    // across the persisted claim, never across browser I/O.
    {
        let state = app.state::<Flight>();
        let _gate = state.gate.lock().unwrap();
        let db = database(app)?;
        if !current(&db)?.is_some_and(|e| e.id == event.id && e.status == "preparing") {
            return Ok(());
        }
        if let Some(reason) = restriction_reason(&db, &event, now())? {
            restrict(&db, &mut event, reason)?;
            return Ok(());
        }
        if needs_confirmation(&db, &event)? {
            event.status = "ready".into();
            save(&db, &event)?;
            return Ok(());
        }
        event.status = "submitting".into();
        save(&db, &event)?;
    }
    let result = app
        .state::<Bridge>()
        .submit_flight(&event.id, &event.name, &route_detail)
        .await;
    let state = app.state::<Flight>();
    let _gate = state.gate.lock().unwrap();
    apply_submission_result(&database(app)?, &event.id, &event.name, result)
}
fn apply_submission_result(
    db: &Connection,
    id: &str,
    name: &str,
    result: Result<serde_json::Value, String>,
) -> Result<(), String> {
    let Some(mut event) = current(db)? else {
        return Ok(());
    };
    if event.id != id || event.name != name || event.status != "submitting" {
        return Ok(());
    }
    match result {
        Ok(data)
            if data["status"] == "submitted"
                && data["submitted"] == true
                && data["name"] == event.name =>
        {
            event.status = "submitted".into();
            event.error = None;
        }
        Ok(_) => {
            event.status = "uncertain".into();
            event.error = Some("未获得可核对的提交回执，请到司空核查；不会自动重试。".into());
        }
        // Persist the definitive first receipt before the draft can disappear.
        Err(error) if is_confirmed_weather_block(&error) => {
            return record_weather_block(db, &mut event, &error)
        }
        Err(error) if error.contains("取消") => {
            event.status = "canceled".into();
            event.error = None;
        }
        Err(error) => {
            event.status = "uncertain".into();
            event.error = Some(format!("{error} 请到司空核查；不会自动重试。"));
        }
    }
    save(db, &event)
}
fn prevent_restricted_launch(app: &tauri::AppHandle, event: &mut Event) -> Result<bool, String> {
    let state = app.state::<Flight>();
    let _gate = state.gate.lock().unwrap();
    let db = database(app)?;
    if let Some(reason) = restriction_reason(&db, event, now())? {
        if current(&db)?.is_some_and(|e| e.id == event.id && !terminal(&e)) {
            restrict(&db, event, reason)?;
        }
        return Ok(true);
    }
    Ok(false)
}
pub async fn after_sync(app: &tauri::AppHandle) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
    if let Err(error) = crate::readiness::require_flight(app) {
        crate::runtime_log::record(
            app,
            "warning",
            "flight",
            "flight.evaluate_skipped",
            "同步后未评估巡查：运行条件未就绪",
            serde_json::json!({"reason":error}),
        );
        return Ok(());
    }
    crate::weather::refresh(app, false).await;
    let check = creation_weather(app);
    let state = app.state::<Flight>();
    let _gate = state.gate.lock().unwrap();
    let event = observe_with_weather(
        &mut database(app)?,
        now(),
        Some(check),
    )?;
    crate::runtime_log::record(
        app,
        "info",
        "flight",
        "flight.evaluated",
        if event.is_some() {
            "巡查触发评估产生任务"
        } else {
            "巡查触发评估完成，本轮未产生新任务"
        },
        serde_json::json!({"event":event.as_ref().map(|e| serde_json::json!({"id":e.id,"name":e.name,"status":e.status,"observedAt":e.observed_at,"sourceHour":e.source_hour,"potassium":e.potassium,"pm25":e.pm25,"route":e.route,"error":e.error})),"note":"未产生新任务可能由阈值、数据时效、已有任务或运行设置决定"}),
    );
    Ok(())
}
fn claim_due(db: &Connection, at: i64, started_at: i64) -> Result<Option<Event>, String> {
    let Some(mut event) = current(db)? else {
        return Ok(None);
    };
    if event.status != "countdown" {
        // An automatic attempt that failed before any launch request can be
        // retried for the same source hour. Nothing here can submit a flight:
        // the retry only re-prepares a draft and passes the same readiness,
        // no-fly and data-freshness gates the first attempt had to pass.
        return claim_retry(db, event, at);
    }
    // A deadline armed before this process started was never kept by a running
    // scheduler: the client was stopped, updated or suspended during the
    // countdown. Submit only after a fresh preparation instead of taking off
    // from a timer nobody was watching, and never silently lose the hour.
    // Only automatic tasks are affected: a manual task is never armed by this
    // process alone, so its countdown may legitimately predate the start.
    if event.launch_at.is_some_and(|deadline| deadline < started_at) {
        let settings = crate::settings::read(db)?;
        if event.source == "auto" && !event.preview && automatic_retry_allowed(&settings, &event) {
            event.launch_at = None;
            event.retry_at = Some(at);
            event.error = Some("客户端在起飞倒计时期间关闭或更新，已改为重新核对后执行。".into());
            event.status = "failed".into();
            eprintln!(
                "Flight countdown interrupted during restart: {} ({}/{})",
                event.name, event.attempt, AUTOMATIC_ATTEMPTS
            );
            return claim_retry(db, event, at);
        }
        return Ok(None);
    }
    let local = chrono::DateTime::from_timestamp_millis(at)
        .ok_or("起飞检查时间无效。")?
        .naive_utc()
        + Duration::hours(8);
    if let Some(reason) = restriction_reason(db, &event, local)? {
        restrict(db, &mut event, reason)?;
        return Ok(None);
    }
    // Switching to manual confirmation also releases an existing delay.
    if !needs_confirmation(db, &event)? && event.launch_at.is_none_or(|deadline| deadline > at) {
        return Ok(None);
    }
    event.status = "preparing".into();
    event.launch_at = None;
    event.retry_at = None;
    // A retry supersedes the archived receipt that scheduled it, so the
    // operator's "retry the failed task" action ends with this attempt.
    event.retried_event_id = None;
    save(db, &event)?;
    Ok(Some(event))
}
// Bounded automatic recovery for one source hour. The limit is persisted on
// the event, so restarts cannot refill it, and a cancelled or confirmed task
// never reaches this path. It is also published to the client so the overview
// and the runtime log can say how much recovery is left instead of guessing.
pub(crate) const AUTOMATIC_ATTEMPTS: u32 = 3;
const RETRY_DELAY_MS: i64 = 90_000;
// A page that only needs to load is worth re-checking sooner than a failed
// preparation, and it does not consume the bounded attempt count.
const TRANSIENT_RETRY_MS: i64 = 60_000;
fn automatic_retry_allowed(settings: &crate::settings::Settings, event: &Event) -> bool {
    event.source == "auto"
        && !event.preview
        && !settings.require_manual_confirmation
        && event.source_hour.is_some()
        && event.attempt < AUTOMATIC_ATTEMPTS
}
fn claim_retry(
    db: &Connection,
    mut event: Event,
    at: i64,
) -> Result<Option<Event>, String> {
    if event.status != "failed" || event.attempt == 0 || event.retry_at.is_none_or(|due| due > at) {
        return Ok(None);
    }
    let local = chrono::DateTime::from_timestamp_millis(at)
        .ok_or("起飞检查时间无效。")?
        .naive_utc()
        + Duration::hours(8);
    let settings = crate::settings::read(db)?;
    if let Some(reason) = restriction_reason(db, &event, local)? {
        // The hour may have entered a no-fly window after the first attempt.
        // Record it as skipped so the operator still sees why nothing flew.
        restrict(db, &mut event, reason)?;
        return Ok(None);
    }
    // A waiting retry is scheduled by the transient page state, so the
    // bounded count of the source hour must not cancel it here.
    let waiting = crate::readiness::transient_reason(
        event.error.as_deref().unwrap_or_default(),
    );
    if !automatic_retry_allowed(&settings, &event)
        && !(waiting && event.source == "auto" && !event.preview)
    {
        // A config change during the delay must not launch on the old intent.
        if event.retry_at.is_some() {
            event.retry_at = None;
            save(db, &event)?;
        }
        return Ok(None);
    }
    let Some(reading) = latest_trigger(db, &settings, local)? else {
        event.retry_at = None;
        save(db, &event)?;
        return Ok(None);
    };
    // The hour that triggered the task must still be the newest exceeding one.
    // A newer normal hour, an expired window or an edited threshold all end it.
    if !reading.exceeded || event.source_hour.as_deref() != Some(reading.time.as_str()) {
        event.retry_at = None;
        save(db, &event)?;
        return Ok(None);
    }
    let mut retry = new_event(reading.time.clone(), reading.k, false);
    retry.pm25 = reading.pm25;
    // Keep one name per source hour so a second draft cannot be mistaken for
    // the first one in the platform list.
    retry.name = event.name.clone();
    retry.source_hour = event.source_hour.clone();
    retry.attempt = event.attempt + 1;
    retry.retried_event_id = Some(event.id.clone());
    retry.weather_checks.extend(event.weather_checks.iter().cloned());
    retry.weather_override_confirmed_at = event.weather_override_confirmed_at;
    retry.status = "preparing".into();
    // Releasing the failed receipt, archiving it and installing the retry are
    // one commit: a crash must not leave the hour neither handled nor retried.
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    archive(&tx, &event)?;
    replace_current(&tx, &retry)?;
    put(&tx, &format!("flight_handled:{}", reading.time), &retry.id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(retry))
}
async fn tick(app: &tauri::AppHandle) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
    let state = app.state::<Flight>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let _busy = Busy(state.busy.clone());
    let pending = {
        let _gate = state.gate.lock().unwrap();
        claim_due(&database(app)?, chrono::Utc::now().timestamp_millis(), *STARTED_AT)?
    };
    if let Some(mut event) = pending {
        // Waiting for a page to load is not a flight failure, so the log must
        // not present it as one to the operator reading it later.
        let waiting = event.retried_event_id.is_some()
            && crate::readiness::transient_reason(event.error.as_deref().unwrap_or_default());
        if event.retried_event_id.is_some() {
            let interrupted = event.error.as_deref().is_some_and(|error| error.contains("倒计时期间关闭"));
            let event_name = event.name.clone();
            let source_hour = event.source_hour.clone();
            let previous = event.retried_event_id.clone();
            let attempt = event.attempt;
            crate::runtime_log::record(
                app,
                if interrupted { "warning" } else { "info" },
                "flight",
                if interrupted { "flight.countdown_interrupted" } else { "flight.retry_started" },
                if interrupted {
                    "起飞倒计时因客户端关闭或更新中断，重新核对后执行"
                } else if waiting {
                    "司空页面尚未可用，等待页面恢复后重新核对"
                } else {
                    "同一超标小时未发送起飞请求，开始自动重试"
                },
                serde_json::json!({"name":event_name,"sourceHour":source_hour,"attempt":attempt,"previousId":previous,"limit":AUTOMATIC_ATTEMPTS}),
            );
        }
        if let Err(error) = crate::readiness::verify_flight(app).await {
            fail(&*app, &mut event, format!("起飞前检查失败：{error}"), true)?;
        } else {
            let attempt = event.attempt;
            let name = event.name.clone();
            let source_hour = event.source_hour.clone();
            if let Err(error) = execute(app, event).await {
                // A failed attempt used to live only in the task receipt. Keep
                // one line per attempt so the log shows why an hour stopped
                // after three tries instead of only the final state.
                crate::runtime_log::record(
                    app,
                    if attempt >= AUTOMATIC_ATTEMPTS { "warning" } else { "info" },
                    "flight",
                    "flight.attempt_failed",
                    if attempt >= AUTOMATIC_ATTEMPTS {
                        "巡查任务起飞失败，自动重试次数已用完，等待人工核验"
                    } else {
                        "巡查任务起飞失败，将自动重试"
                    },
                    serde_json::json!({"name":name,"sourceHour":source_hour,"attempt":attempt,"limit":AUTOMATIC_ATTEMPTS,"error":error}),
                );
                return Err(error);
            }
        }
    }
    Ok(())
}
// One place decides whether a failed pre-submission attempt may be retried.
// Only automatic tasks retry, only before any launch request was sent, and
// only for the still-current exceeding hour. Everything else keeps the
// existing operator-driven flow.
fn fail(
    app: &tauri::AppHandle,
    event: &mut Event,
    message: String,
    retryable: bool,
) -> Result<(), String> {
    let state = app.state::<Flight>();
    let _gate = state.gate.lock().unwrap();
    let db = database(app)?;
    // The event may have been cancelled or replaced while waiting.
    if !current(&db)?.is_some_and(|e| e.id == event.id && e.status == event.status) {
        return Ok(());
    }
    event.status = "failed".into();
    event.launch_at = None;
    event.retry_at = None;
    let mut receipt = message;
    let settings = crate::settings::read(&db)?;
    let retrying = retryable && automatic_retry_allowed(&settings, event);
    if retrying {
        // Saying whether another attempt exists is the difference between
        // waiting a minute and sending the operator to the drone.
        receipt = format!(
            "{}；{} 秒后自动重试（第 {}/{} 次）。",
            receipt,
            RETRY_DELAY_MS / 1000,
            event.attempt + 1,
            AUTOMATIC_ATTEMPTS
        );
        event.retry_at = Some(chrono::Utc::now().timestamp_millis() + RETRY_DELAY_MS);
    } else if retryable && event.source == "auto" && !event.preview && event.attempt >= AUTOMATIC_ATTEMPTS {
        receipt = format!("{}；已达自动重试上限（{} 次），请人工核验。", receipt, AUTOMATIC_ATTEMPTS);
    } else if retryable && event.source == "auto" && !event.preview && crate::readiness::transient_reason(&receipt) {
        // Not a business refusal: the plugin or its business page is not
        // usable yet. Waiting is the fix, so keep the automatic attempt alive
        // instead of consuming the source hour. It never submits anything
        // either: the retry still passes the same readiness and no-fly gates.
        receipt = format!("{}；司空页面尚未可用，暂不占用自动重试次数。", receipt);
        event.retry_at = Some(chrono::Utc::now().timestamp_millis() + TRANSIENT_RETRY_MS);
    }
    event.error = Some(receipt);
    save(&db, event)
}
fn apply_observation(db: &Connection, id: &str, name: &str, status: &str) -> Result<(), String> {
    let Some(mut event) = current(db)? else {
        return Ok(());
    };
    if event.id != id || event.name != name || !trackable(&event) {
        return Ok(());
    }
    event.status_checked_at = Some(chrono::Utc::now().timestamp_millis());
    event.status_check_error = None;
    match status {
        "执行中" => {
            event.status = "flying".into();
            event.error = None;
        }
        "已暂停" | "已挂起" => {
            event.status = "paused".into();
            event.error = Some(format!("司空显示任务{status}，请核查设备。"));
        }
        "执行成功" => {
            event.status = "completed".into();
            event.error = None;
        }
        "部分执行" | "执行失败" | "执行终止" => {
            event.status = "flight_error".into();
            event.error = Some(format!("司空显示任务{status}，请核查飞行记录。"));
        }
        "待执行" => {
            if matches!(
                event.status.as_str(),
                "ready" | "uncertain" | "flight_error" | "not_flown"
            ) {
                event.status = "submitted".into();
                event.error = None;
            }
        }
        _ => return Ok(()),
    }
    save(db, &event)
}
// A validated, uniquely matched actual end receipt releases the local slot.
// Media uploads and a partial outcome remain in history; neither keeps a flight active.
pub(crate) fn reconcile_ended_tasks(db: &Connection, tasks: &[crate::flight_report::DjiTask]) -> Result<(), String> {
    let Some(mut event) = current(db)?.filter(|e| trackable(e)) else { return Ok(()); };
    let matches: Vec<_> = tasks.iter().filter(|task| task.mission.mission_name == event.name).collect();
    if matches.len() != 1 { return Ok(()); }
    let task = matches[0];
    if task.actual_time_missing || task.mission.start_time <= 0
        || task.mission.end_time <= task.mission.start_time
        || task.mission.end_time > chrono::Utc::now().timestamp_millis()
        || !matches!(task.status.as_str(), "执行成功" | "部分执行" | "执行失败" | "执行终止") {
        return Ok(());
    }
    event.status = if task.status == "执行成功" { "completed" } else { "flight_error" }.into();
    event.error = if task.status == "执行成功" { None } else {
        Some(format!("司空任务已结束：{}{}", task.status,
            task.partial_reason.as_deref().filter(|s| !s.trim().is_empty()).map(|s| format!("；{s}")).unwrap_or_default()))
    };
    event.status_checked_at = Some(chrono::Utc::now().timestamp_millis());
    event.status_check_error = None;
    archive(db, &event)?;
    // Preserve the handled episode so releasing the slot cannot replay this alert.
    if setting(db, "flight_episode")?.is_none_or(|s| s.is_empty()) {
        put(db, "flight_episode", event.source_hour.as_deref().unwrap_or(&event.observed_at))?;
    }
    db.execute("DELETE FROM monitor_settings WHERE key='flight_event'", []).map_err(|e| e.to_string())?;
    Ok(())
}

// Enrichment is independent of the flight state machine: completed flights
// remain terminal, including while an older record is being backfilled.
fn apply_flight_time(
    db: &Connection,
    id: &str,
    name: &str,
    result: &serde_json::Value,
) -> Result<(), String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let live = current(&tx)?;
    let is_current = live.as_ref().is_some_and(|event| event.id == id);
    let stored = if is_current {
        live
    } else {
        setting(&tx, &format!("flight_history:{id}"))?
            .map(|value| serde_json::from_str::<Event>(&value).map_err(|e| e.to_string()))
            .transpose()?
    };
    let Some(mut event) =
        stored.filter(|event| event.name == name && event.status == "completed" && !event.preview)
    else {
        return Ok(());
    };
    let now = chrono::Utc::now().timestamp_millis();
    event.flight_time_checked_at = Some(now);
    if result["url"] == PLAN_URL && result["name"] == name && result["status"] == "执行成功" {
        if let Ok(time) = serde_json::from_value::<FlightTime>(result["flightTime"].clone()) {
            let duration = time.end_time.checked_sub(time.start_time);
            if time.source == "dji-plan"
                && time.precision == "minute"
                && time.start_time > 0
                && time.end_time <= now
                && time.start_time % 60000 == 0
                && time.end_time % 60000 == 0
                && time.duration_ms > 0
                && time.duration_ms < 86400000
                && duration == Some(time.duration_ms)
            {
                event.flight_time = Some(time);
            }
        }
    }
    if is_current {
        save(&tx, &event)?;
    }
    if !is_current || setting(&tx, &format!("flight_history:{id}"))?.is_some() {
        archive(&tx, &event)?;
    }
    tx.commit().map_err(|e| e.to_string())
}
fn needs_flight_time(event: &Event, now: i64) -> bool {
    event.status == "completed"
        && !event.preview
        && event.flight_time.is_none()
        && event
            .flight_time_checked_at
            .is_none_or(|checked| now.saturating_sub(checked) >= 60000)
}
fn is_confirmed_weather_block(message: &str) -> bool {
    // The adapter emits this receipt only for the exact event's original draft.
    // A missing row, truncated receipt or generic error cannot prove no flight.
    message.starts_with("司空平台天气阻飞：") && message.ends_with("；未继续执行")
}
fn record_weather_block(db: &Connection, event: &mut Event, message: &str) -> Result<(), String> {
    // Keep the definitive platform receipt as a no-flight record. The event
    // remains watchable while the operator decides whether to continue in the
    // still-open FlightHub dialog.
    event.status = "not_flown".into();
    event.status_checked_at = Some(chrono::Utc::now().timestamp_millis());
    event.status_check_error = None;
    event.error = Some(match event.error.as_deref() {
        Some(original) if original != message => format!("{original}\n司空核查：{message}"),
        _ => message.into(),
    });
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    if setting(&tx, "flight_episode")?.is_none_or(|s| s.is_empty()) {
        put(&tx, "flight_episode", &event.observed_at)?;
    }
    archive(&tx, event)?;
    save(&tx, event)?;
    tx.commit().map_err(|e| e.to_string())
}
fn record_check_error(db: &Connection, id: &str, name: &str, message: &str) -> Result<(), String> {
    let Some(mut event) = current(db)? else {
        return Ok(());
    };
    if event.id != id || event.name != name || !trackable(&event) {
        return Ok(());
    }
    event.status_checked_at = Some(chrono::Utc::now().timestamp_millis());
    if matches!(event.status.as_str(), "ready" | "uncertain") && is_confirmed_weather_block(message)
    {
        return record_weather_block(db, &mut event, message);
    }
    event.status_check_error = Some(message.chars().take(180).collect());
    save(db, &event)
}
fn handle_unmatched_status(db: &Connection, id: &str, name: &str) -> Result<(), String> {
    record_check_error(db, id, name, "司空列表未识别到该任务状态，请检查平台页面或日期范围；结果未确认，继续核查以避免重复起飞。")
}
async fn watch(app: &tauri::AppHandle, expected_id: Option<&str>) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
    let state = app.state::<Flight>();
    let _status_gate = state.status_gate.lock().await;
    let event = current(&database(app)?)?;
    if expected_id.is_some_and(|id| event.as_ref().is_none_or(|e| e.id != id)) {
        return Err("任务已变化，请查看当前任务后重试。".into());
    }
    let now = chrono::Utc::now().timestamp_millis();
    let event = event.filter(|event| trackable(event) || needs_flight_time(event, now));
    let event = if event.is_some() || expected_id.is_some() {
        event
    } else {
        // Retained completed tasks also need enrichment after upgrading. Hidden
        // records are excluded by view(); an active flight always takes priority.
        view(&database(app)?)?
            .records
            .into_iter()
            .find(|event| needs_flight_time(event, now))
    };
    let Some(event) = event else {
        return Ok(());
    };
    let result = app
        .state::<Bridge>()
        .flight_status(&event.id, &event.name)
        .await;
    let _gate = state.gate.lock().unwrap();
    let db = database(app)?;
    if event.status == "completed" {
        apply_flight_time(
            &db,
            &event.id,
            &event.name,
            result.as_ref().unwrap_or(&serde_json::Value::Null),
        )?;
        return result.map(|_| ());
    }
    match result {
        Ok(result) if result["url"] == PLAN_URL && result["name"] == event.name => {
            if let Some(status) = result["status"].as_str().filter(|s| {
                matches!(
                    *s,
                    "执行中"
                        | "已暂停"
                        | "已挂起"
                        | "执行成功"
                        | "部分执行"
                        | "执行失败"
                        | "执行终止"
                        | "待执行"
                )
            }) {
                apply_observation(&db, &event.id, &event.name, status)?;
                if status == "执行成功" {
                    apply_flight_time(&db, &event.id, &event.name, &result)?;
                }
                Ok(())
            } else {
                let message = "司空列表未识别到该任务状态，请检查平台页面或日期范围。";
                handle_unmatched_status(&db, &event.id, &event.name)?;
                Err(message.into())
            }
        }
        Ok(_) => {
            record_check_error(&db, &event.id, &event.name, "司空状态回执不匹配。")?;
            Err("司空状态回执不匹配。".into())
        }
        Err(error) => {
            record_check_error(&db, &event.id, &event.name, &error)?;
            if current(&db)?.is_some_and(|updated| {
                updated.id == event.id
                    && updated.status == "not_flown"
                    && updated
                        .error
                        .as_deref()
                        .is_some_and(|message| {
                            message.contains("司空平台天气阻飞：")
                                && message.ends_with("；未继续执行")
                        })
            })
            {
                Ok(())
            } else {
                Err(error)
            }
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
        let mut last_error = None;
        loop {
            let error = tick(&scheduler).await.err();
            if error != last_error {
                crate::runtime_log::record(
                    &scheduler,
                    if error.is_some() { "error" } else { "info" },
                    "flight",
                    "flight.scheduler",
                    if error.is_some() {
                        "巡查调度出现错误"
                    } else {
                        "巡查调度错误已恢复"
                    },
                    serde_json::json!({"error":error}),
                );
                last_error = error;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        let mut last_error = None;
        loop {
            let error = watch(&app, None).await.err();
            if error != last_error {
                crate::runtime_log::record(
                    &app,
                    if error.is_some() { "error" } else { "info" },
                    "flight",
                    "flight.watcher",
                    if error.is_some() {
                        "巡查状态同步出现错误"
                    } else {
                        "巡查状态同步错误已恢复"
                    },
                    serde_json::json!({"error":error}),
                );
                last_error = error;
            }
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        }
    });
}
fn cancel(db: &Connection, id: &str) -> Result<(), String> {
    let mut event = current(db)?.ok_or("没有待取消的任务。")?;
    if event.id != id {
        return Err("任务已变化，请刷新后重试。".into());
    }
    if !matches!(event.status.as_str(), "countdown" | "preparing") {
        return Err("任务已进入提交阶段或已结束，请在司空核查。".into());
    }
    event.status = "canceled".into();
    event.launch_at = None;
    event.error = None;
    save(db, &event)
}
#[tauri::command]
pub fn cancel_flight(app: tauri::AppHandle, event_id: String) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
    let state = app.state::<Flight>();
    let _gate = state.gate.lock().unwrap();
    cancel(&database(&app)?, &event_id)
}
#[tauri::command]
pub async fn sync_flight_routes(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Bridge>,
) -> Result<RoutesView, String> {
    let _access = crate::data_reset::access(&app)?;
    crate::readiness::require_flight(&app)?;
    let result = bridge.sync_flight_routes().await?;
    if result["url"].as_str() != Some(PLAN_URL) {
        return Err("司空航线同步来源不匹配。".into());
    }
    let mut routes: Vec<FlightRoute> = serde_json::from_value(result["routes"].clone())
        .map_err(|e| format!("司空航线格式错误：{e}"))?;
    routes.retain(|route| !route_name(&route.name).is_empty());
    routes.sort_by(|a, b| route_name(&b.name).len().cmp(&route_name(&a.name).len()).then_with(|| b.update_time.cmp(&a.update_time)).then_with(|| a.name.cmp(&b.name)));
    if routes.is_empty() { return Err("司空航线列表为空。".into()); }
    let mut db = database(&app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let previous = selected_route(&tx)?;
    // Keep the catalog available even if a legacy unqualified name becomes ambiguous.
    // Clear that selection so the operator can explicitly choose a folder.
    let selected = previous.as_deref()
        .map(|previous| best_route_match(&routes, previous))
        .transpose().unwrap_or(None).flatten();
    put(&tx, "flight_routes", &serde_json::to_string(&routes).map_err(|e| e.to_string())?)?;
    put(&tx, "flight_route", selected.as_deref().unwrap_or(""))?;
    put(&tx, "flight_routes_synced_at", &chrono::Utc::now().timestamp_millis().to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    route_view(&db)
}
#[tauri::command]
pub fn set_flight_route(app: tauri::AppHandle, route: String) -> Result<RoutesView, String> {
    let _access = crate::data_reset::access(&app)?;
    let normalized = route_name(&route);
    if normalized.is_empty() || normalized.len() > 2000 { return Err("航线名称无效。".into()); }
    let db = database(&app)?;
    let routes = read_routes(&db)?;
    let chosen = exact_route_match(&routes, &route)?
        .ok_or("请先同步司空航线列表，再选择航线。")?;
    put(&db, "flight_route", &chosen)?;
    route_view(&db)
}
// Closing is an explicit local disposition, never a platform cancellation or success.
fn close_reviewed(
    db: &Connection,
    id: &str,
    expected_status: &str,
    confirmed: bool,
) -> Result<(), String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut event = current(&tx)?.ok_or("任务已变化，请刷新后重试。")?;
    if event.id != id || event.status != expected_status {
        return Err("任务状态已变化，请刷新后重新核查。".into());
    }
    if !matches!(event.status.as_str(), "failed" | "ready" | "flight_error")
        && !(event.status == "not_flown" && trackable(&event))
    {
        return Err("当前任务不能结束处理，请继续核查司空状态。".into());
    }
    if !confirmed {
        return Err("请先确认平台任务已结束或已取消。".into());
    }
    event.resolved_at = Some(chrono::Utc::now().timestamp_millis());
    archive(&tx, &event)?;
    tx.execute("DELETE FROM monitor_settings WHERE key='flight_event'", [])
        .map_err(|e| e.to_string())?;
    // Releasing a real draft/exception must not immediately dispatch a new flight.
    // A newer source hour may dispatch after explicit resolution; the reviewed
    // hour must not replay. Preview and preparation failures keep existing receipts.
    if !event.preview
        && event.source != "preview"
        && event.status != "failed"
        && setting(&tx, "flight_episode")?.is_none_or(|s| s.is_empty())
    {
        put(&tx, "flight_episode", &event.observed_at)?;
    }
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn resolve_flight(
    app: tauri::AppHandle,
    event_id: String,
    expected_status: String,
    confirmed: bool,
) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
    let state = app.state::<Flight>();
    let _gate = state.gate.lock().unwrap();
    close_reviewed(&database(&app)?, &event_id, &expected_status, confirmed)
}
#[cfg(test)]
fn begin_manual_request(
    db: &Connection,
    preview: bool,
    retry_event_id: Option<&str>,
    weather_override_confirmed: bool,
) -> Result<Event, String> {
    begin_manual_with_weather(
        db,
        preview,
        retry_event_id,
        weather_override_confirmed,
        None,
    )
}
fn begin_manual_with_weather(
    db: &Connection,
    preview: bool,
    retry_event_id: Option<&str>,
    weather_override_confirmed: bool,
    check: Option<WeatherCheck>,
) -> Result<Event, String> {
    if !preview {
        if let Some(reason) = crate::settings::read(db)?.no_fly_reason(now()) {
            return Err(reason);
        }
    }
    if preview && (weather_override_confirmed || retry_event_id.is_some()) {
        return Err("填写演练不能覆盖天气或重新发起起飞任务。".into());
    }
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let previous = current(&tx)?;
    if let Some(id) = retry_event_id {
        previous
            .as_ref()
            .filter(|e| e.id == id && e.status == "failed")
            .ok_or("原失败任务已变化，请刷新后重新确认。")?;
    } else if previous.is_some_and(|e| !terminal(&e)) {
        return Err("请先处理当前巡飞任务。".into());
    }
    let mut event = new_event(now().format("%Y-%m-%d %H:%M:%S").to_string(), None, preview);
    // A manual (re)launch supersedes any scheduled automatic retry.
    event.attempt = 0;
    event.retry_at = None;
    event.source_hour = tx.query_row(
        "SELECT observed_at FROM hourly_observations WHERE city_code='321200' AND (potassium IS NOT NULL OR pm25 IS NOT NULL) ORDER BY observed_at DESC LIMIT 1",
        [], |row| row.get(0),
    ).optional().map_err(|e| e.to_string())?;
    event.weather_checks.extend(check);
    if !preview {
        event.source = "manual".into();
        event.name = format!(
            "{}-{}",
            event.name.replace("钾离子超标巡查", "手动巡查"),
            &event.id[..8]
        );
    }
    if weather_override_confirmed {
        event.weather_override_confirmed_at = Some(chrono::Utc::now().timestamp_millis());
    }
    replace_current(&tx, &event)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(event)
}
#[cfg(test)]
fn begin_manual(db: &Connection, preview: bool) -> Result<Event, String> {
    begin_manual_request(db, preview, None, false)
}
async fn begin(
    app: tauri::AppHandle,
    preview: bool,
    retry_event_id: Option<String>,
    weather_override_confirmed: bool,
) -> Result<(), String> {
    let access = crate::data_reset::access(&app)?;
    crate::readiness::require_flight(&app)?;
    route_configuration_ready(&database(&app)?)?;
    let state = app.state::<Flight>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("巡飞任务正在处理，请稍候。".into());
    }
    let busy = Busy(state.busy.clone());
    crate::weather::refresh(&app, true).await;
    let event = {
        let _gate = state.gate.lock().unwrap();
        database(&app).and_then(|db| {
            begin_manual_with_weather(
                &db,
                preview,
                retry_event_id.as_deref(),
                weather_override_confirmed,
                Some(creation_weather(&app)),
            )
        })
    };
    let event = event?;
    tauri::async_runtime::spawn(async move {
        let _access = access;
        let _busy = busy;
        if let Err(error) = execute(&app, event).await {
            eprintln!("Flight task: {error}");
        }
    });
    Ok(())
}
#[tauri::command]
pub async fn launch_flight(
    app: tauri::AppHandle,
    retry_event_id: Option<String>,
    weather_override_confirmed: Option<bool>,
) -> Result<(), String> {
    begin(
        app,
        false,
        retry_event_id,
        weather_override_confirmed.unwrap_or(false),
    )
    .await
}
#[tauri::command]
pub async fn prepare_flight(app: tauri::AppHandle, preview: bool) -> Result<(), String> {
    if !preview {
        return Err("请核查并归档原任务后，重新发起手动起飞。".into());
    }
    begin(app, true, None, false).await
}
#[tauri::command]
pub async fn open_prepared_flight(app: tauri::AppHandle) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
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
    fn manual_binds_latest_valid_source_hour() {
        let db = db();
        reading(&db, "2026-10-11 10:00:00", Some(0.1));
        reading_pm25(&db, "2026-10-11 11:00:00", Some(80.0));
        let event = begin_manual(&db, false).unwrap();
        assert_eq!(event.source_hour.as_deref(), Some("2026-10-11 11:00:00"));
    }

    #[test]
    fn route_matching_prefers_the_smallest_difference_and_keeps_copy_names() {
        let routes = vec![
            FlightRoute { route_id: "1".into(), name: "东南火点巡查航线".into(), update_time: 1, ..Default::default() },
            FlightRoute { route_id: "2".into(), name: "东南火点巡查航线-改".into(), update_time: 2, ..Default::default() },
            FlightRoute { route_id: "3".into(), name: "东南火点巡查航线-改-副本(6)".into(), update_time: 3, ..Default::default() },
        ];
        assert_eq!(best_route_match(&routes, "东南火点巡查航线").unwrap(), Some("东南火点巡查航线".into()));
        assert_eq!(best_route_match(&routes[1..], "东南火点巡查航线").unwrap(), Some("东南火点巡查航线-改".into()));
        assert_eq!(route_name(" 东南火点巡查航线-改 - 副本(6) "), "东南火点巡查航线-改-副本(6)");
    }
    #[test]
    fn route_selection_has_no_builtin_fallback_and_requires_a_synced_route() {
        let db = db();
        put(&db, "flight_route", "旧的内置航线").unwrap();
        assert_eq!(selected_route(&db).unwrap(), None);
        let routes = vec![FlightRoute { route_id: "1".into(), name: "现场巡查航线".into(), update_time: 1, ..Default::default() }];
        put(&db, "flight_routes", &serde_json::to_string(&routes).unwrap()).unwrap();
        assert_eq!(selected_route(&db).unwrap(), None);
        put(&db, "flight_route", "现场巡查航线").unwrap();
        assert_eq!(selected_route(&db).unwrap(), Some("现场巡查航线".into()));
    }
    #[test]
    fn eight_wind_sectors_match_exact_boundaries_clockwise() {
        let sectors = [
            ("北风", 337.5, 22.5), ("东北风", 22.5, 67.5),
            ("东风", 67.5, 112.5), ("东南风", 112.5, 157.5),
            ("南风", 157.5, 202.5), ("西南风", 202.5, 247.5),
            ("西风", 247.5, 292.5), ("西北风", 292.5, 337.5),
        ];
        let routes: Vec<_> = sectors.iter().enumerate().map(|(i, (name, _, _))| FlightRoute {
            route_id: i.to_string(), name: name.to_string(), update_time: 1, ..Default::default()
        }).collect();
        let mut settings = crate::settings::Settings::default();
        settings.route_selection_mode = "wind".into();
        settings.wind_route_rules = sectors.iter().map(|(name, start, end)| crate::settings::WindRouteRule {
            start_degrees: *start, end_degrees: *end, route: name.to_string(),
        }).collect();
        for (i, (name, start, _)) in sectors.iter().enumerate() {
            assert_eq!(configured_route(&settings, &routes, None, Some(*start)).unwrap(), *name);
            assert_eq!(configured_route(&settings, &routes, None, Some(start - 0.000001)).unwrap(), sectors[(i + 7) % 8].0);
            assert_eq!(configured_route(&settings, &routes, None, Some(start + 0.000001)).unwrap(), *name);
        }
        for direction in [0.0, 359.999999] {
            assert_eq!(configured_route(&settings, &routes, None, Some(direction)).unwrap(), "北风");
        }
        assert_eq!(configured_route(&settings, &routes, None, Some(66.0)).unwrap(), "东北风");
        settings.wind_route_rules.remove(1);
        assert_eq!(configured_route(&settings, &routes, Some("北风".into()), Some(66.0)).unwrap(), "北风");
    }
    #[test]
    fn wind_route_rules_match_normal_and_cross_zero_ranges() {
        let routes = vec![
            FlightRoute { route_id: "1".into(), name: "东南航线".into(), update_time: 1, ..Default::default() },
            FlightRoute { route_id: "2".into(), name: "西北航线".into(), update_time: 1, ..Default::default() },
        ];
        let mut settings = crate::settings::Settings::default();
        settings.route_selection_mode = "wind".into();
        settings.wind_route_rules = vec![
            crate::settings::WindRouteRule { start_degrees: 0.0, end_degrees: 135.0, route: "东南航线".into() },
            crate::settings::WindRouteRule { start_degrees: 315.0, end_degrees: 45.0, route: "西北航线".into() },
        ];
        assert_eq!(configured_route(&settings, &routes, None, Some(90.0)).unwrap(), "东南航线");
        assert_eq!(configured_route(&settings, &routes, None, Some(350.0)).unwrap(), "西北航线");
        assert!(configured_route(&settings, &routes, None, Some(200.0)).unwrap_err().contains("未匹配"));
        assert!(configured_route(&settings, &routes, None, None).unwrap_err().contains("默认航线"));
    }
    #[test]
    fn wind_route_fallback_handles_missing_invalid_and_unconfigured_directions() {
        let routes = vec![
            FlightRoute { route_id: "1".into(), name: "默认航线".into(), update_time: 1, ..Default::default() },
            FlightRoute { route_id: "2".into(), name: "北侧航线".into(), update_time: 1, ..Default::default() },
        ];
        let mut settings = crate::settings::Settings::default();
        settings.route_selection_mode = "wind".into();
        settings.wind_route_rules = vec![crate::settings::WindRouteRule {
            start_degrees: 337.5, end_degrees: 22.5, route: "北侧航线".into(),
        }];
        settings.route_selection_mode = "fixed".into();
        let fallback = Some("默认航线".into());
        assert_eq!(configured_route(&settings, &routes, fallback.clone(), Some(0.0)).unwrap(), "北侧航线");
        for direction in [22.5, 66.0, 337.499999] {
            assert_eq!(configured_route(&settings, &routes, fallback.clone(), Some(direction)).unwrap(), "默认航线");
        }
        for missing in [None, Some("已删除航线".into()), Some("默认".into())] {
            assert!(configured_route(&settings, &routes, missing, Some(66.0)).unwrap_err().contains("默认航线"));
        }
        settings.wind_route_rules[0].route = "已删除航线".into();
        assert!(configured_route(&settings, &routes, fallback.clone(), Some(0.0)).unwrap_err().contains("不在已同步航线列表"));
        for invalid in [None, Some(f64::NAN), Some(f64::INFINITY), Some(-1.0), Some(360.0)] {
            assert_eq!(configured_route(&settings, &routes, fallback.clone(), invalid).unwrap(), "默认航线");
            for missing in [None, Some("已删除航线".into()), Some("默认".into())] {
                assert!(configured_route(&settings, &routes, missing, invalid).unwrap_err().contains("默认航线"));
            }
        }
        settings.wind_route_rules.clear();
        for direction in [None, Some(66.0), Some(f64::NAN)] {
            assert_eq!(configured_route(&settings, &routes, fallback.clone(), direction).unwrap(), "默认航线");
        }
        assert!(configured_route(&settings, &routes, Some("已删除航线".into()), None).is_err());
    }
    #[test]
    fn wind_route_configuration_requires_synced_default_but_allows_no_rules() {
        let db = db();
        let mut settings = crate::settings::Settings::default();
        settings.route_selection_mode = "wind".into();
        crate::settings::save_and_reconcile(&db, &settings, now()).unwrap();
        assert!(route_configuration_ready(&db).unwrap_err().contains("默认航线"));
        let routes = vec![FlightRoute { route_id: "1".into(), name: "默认航线".into(), update_time: 1, ..Default::default() }];
        put(&db, "flight_routes", &serde_json::to_string(&routes).unwrap()).unwrap();
        put(&db, "flight_route", "已删除航线").unwrap();
        assert!(route_configuration_ready(&db).is_err());
        put(&db, "flight_route", "默认航线").unwrap();
        assert!(route_configuration_ready(&db).is_ok());
    }
    #[test]
    fn wind_route_rules_support_platform_copy_names() {
        let routes = vec![FlightRoute { route_id: "1".into(), name: "东南航线-副本(2)".into(), update_time: 1, ..Default::default() }];
        let mut settings = crate::settings::Settings::default();
        settings.route_selection_mode = "wind".into();
        settings.wind_route_rules = vec![crate::settings::WindRouteRule { start_degrees: 0.0, end_degrees: 90.0, route: "东南航线".into() }];
        assert_eq!(configured_route(&settings, &routes, None, Some(45.0)).unwrap(), "东南航线-副本(2)");
    }
    #[test]
    fn clear_task_list_preserves_receipts_guards_and_allows_new_records() {
        let db = db();
        let mut event = new_event("2026-10-09 09:00:00".into(), Some(2.), false);
        event.status = "completed".into();
        save(&db, &event).unwrap();
        archive(&db, &event).unwrap();
        put(&db, "flight_episode", &event.observed_at).unwrap();
        put(&db, "flight_last_hour", &event.observed_at).unwrap();
        assert!(
            !clear_tasks(&db, true, 12345)
                .unwrap()
                .preserved_current_task
        );
        let visible = view(&db).unwrap();
        assert!(visible.event.is_none());
        assert!(visible.records.is_empty());
        assert_eq!(visible.tasks_cleared_at, Some(12345));
        assert_eq!(current(&db).unwrap().unwrap().id, event.id);
        assert!(setting(&db, &format!("flight_history:{}", event.id))
            .unwrap()
            .is_some());
        assert_eq!(
            setting(&db, "flight_episode").unwrap(),
            Some(event.observed_at.clone())
        );
        assert_eq!(
            setting(&db, "flight_last_hour").unwrap(),
            Some(event.observed_at.clone())
        );
        // A new task within the same observed hour must remain visible.
        event.id = uuid::Uuid::new_v4().to_string();
        save(&db, &event).unwrap();
        assert_eq!(view(&db).unwrap().event.unwrap().id, event.id);
    }
    #[test]
    fn clear_task_list_preserves_unresolved_tasks_and_clears_history() {
        for status in [
            "countdown",
            "preparing",
            "ready",
            "submitting",
            "submitted",
            "uncertain",
            "flying",
            "paused",
            "flight_error",
        ] {
            let db = db();
            let mut old = new_event("2026-10-09 08:00:00".into(), None, false);
            old.status = "completed".into();
            archive(&db, &old).unwrap();
            let mut event = new_event("2026-10-09 09:00:00".into(), None, false);
            event.status = status.into();
            event
                .weather_checks
                .push(recorded_weather("creation", true, false));
            save(&db, &event).unwrap();
            archive(&db, &event).unwrap();
            let original = setting(&db, "flight_event").unwrap();
            assert!(clear_tasks(&db, false, 12345).is_err());
            assert!(setting(&db, "flight_tasks_cleared_at").unwrap().is_none());
            for at in [12345, 12346] {
                assert!(
                    clear_tasks(&db, true, at).unwrap().preserved_current_task,
                    "{status}"
                );
                let visible = view(&db).unwrap();
                assert_eq!(visible.event.unwrap().id, event.id);
                assert!(visible.records.iter().all(|record| record.id == event.id));
                assert_eq!(visible.tasks_cleared_at, Some(at));
                assert_eq!(setting(&db, "flight_event").unwrap(), original);
                assert!(setting(&db, &format!("flight_task_hidden:{}", event.id))
                    .unwrap()
                    .is_none());
                assert!(setting(&db, &format!("flight_task_hidden:{}", old.id))
                    .unwrap()
                    .is_some());
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
            event
                .weather_checks
                .push(recorded_weather("creation", true, false));
            save(&db, &event).unwrap();
            put(&db, "flight_handled:2026-10-11 19:00:00", &event.id).unwrap();
            reading(&db, "2026-10-11 19:00:00", Some(2.));
            assert!(
                !clear_tasks(&db, true, 12345)
                    .unwrap()
                    .preserved_current_task
            );
            recover(&db).unwrap();
            let visible = view(&db).unwrap();
            assert!(visible.event.is_none());
            assert!(visible.records.is_empty());
            assert!(current(&db).unwrap().is_none());
            let receipt: Event = serde_json::from_str(
                &setting(&db, &format!("flight_history:{}", event.id))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(receipt.status, "failed");
            assert_eq!(receipt.error, event.error);
            assert_eq!(receipt.weather_checks.len(), 1);
            assert_eq!(receipt.resolved_at, Some(12345));
            assert_eq!(
                setting(&db, "flight_handled:2026-10-11 19:00:00").unwrap(),
                Some(event.id.clone())
            );
            assert!(observe_with_weather(
                &mut db,
                parse("2026-10-11 19:00:00").unwrap(),
                None
            )
            .unwrap()
            .is_none());
            if source != "preview" {
                // Clearing keeps same-hour dedup, but does not suppress a new hour.
                reading(&db, "2026-10-11 20:00:00", Some(2.));
                let next = observe_with_weather(
                    &mut db,
                    parse("2026-10-11 20:00:00").unwrap(),
                    None,
                )
                .unwrap()
                .unwrap();
                cancel(&db, &next.id).unwrap();
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
            assert!(setting(&db, &format!("flight_task_hidden:{}", event.id))
                .unwrap()
                .is_none());
            assert!(setting(&db, &format!("flight_history:{}", event.id))
                .unwrap()
                .is_none());
        }
    }
    pub(super) fn recorded_weather(stage: &str, allowed: bool, missing: bool) -> WeatherCheck {
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
        WeatherCheck {
            checked_at: 1_791_507_600_000,
            stage: stage.into(),
            weather,
        }
    }
    #[test]
    fn task_weather_survives_failure_archive_and_manual_retry() {
        let mut db = db();
        let at = parse("2026-10-09 09:00:00").unwrap();
        reading(&db, "2026-10-09 09:00:00", Some(2.));
        let mut event = observe_with_weather(
            &mut db,
            at,
            Some(recorded_weather("creation", true, false)),
        )
        .unwrap()
        .unwrap();
        event.status = "failed".into();
        event.error = Some("等待选中航线超时".into());
        save(&db, &event).unwrap();
        let persisted = current(&db).unwrap().unwrap();
        assert_eq!(persisted.weather_checks.len(), 1);
        let raw = serde_json::to_value(&persisted).unwrap();
        assert_eq!(raw["weatherChecks"][0]["stage"], "creation");
        assert_eq!(
            raw["weatherChecks"][0]["weather"]["current"]["windSpeed"],
            2.73
        );
        let manual = begin_manual_with_weather(
            &db,
            false,
            Some(&event.id),
            false,
            Some(recorded_weather("creation", true, false)),
        )
        .unwrap();
        assert_ne!(manual.id, event.id);
        assert_eq!(manual.weather_checks.len(), 1);
        let archived: Event = serde_json::from_str(
            &setting(&db, &format!("flight_history:{}", event.id))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(archived).unwrap(), raw);
    }
    #[test]
    fn restricted_tasks_keep_weather_and_legacy_events_load_without_a_snapshot() {
        let mut db = db();
        morning_restriction(&db);
        reading(&db, "2026-10-09 07:00:00", Some(2.));
        observe_with_weather(
            &mut db,
            parse("2026-10-09 07:00:00").unwrap(),
            Some(recorded_weather("creation", false, true)),
        )
        .unwrap();
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
        configure(&db, 1.0, 5, true);
        db
    }
    fn reading(db: &Connection, time: &str, k: Option<f64>) {
        db.execute("INSERT OR REPLACE INTO hourly_observations VALUES ('321200',?,?,NULL,'μg/m³','source','A_6','30','sync')", rusqlite::params![time,k]).unwrap();
    }
    fn reading_pm25(db: &Connection, time: &str, pm25: Option<f64>) {
        db.execute("INSERT OR REPLACE INTO hourly_observations VALUES ('321200',?,NULL,?,'μg/m³','source','A_6','30','sync')", rusqlite::params![time,pm25]).unwrap();
    }
    fn dismiss(db: &Connection) {
        let mut e = current(db).unwrap().unwrap();
        e.status = "dismissed".into();
        save(db, &e).unwrap();
    }
    fn time_receipt(event: &Event) -> serde_json::Value {
        let start = chrono::DateTime::parse_from_rfc3339("2026-09-22T20:19:00+08:00")
            .unwrap()
            .timestamp_millis();
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
        assert!(needs_flight_time(
            &event,
            chrono::Utc::now().timestamp_millis()
        ));
        apply_flight_time(&db, &event.id, &event.name, &time_receipt(&event)).unwrap();
        let updated = current(&db).unwrap().unwrap();
        assert_eq!(updated.flight_time.as_ref().unwrap().duration_ms, 1260000);
        assert_eq!(updated.status, "completed");
        assert!(!needs_flight_time(
            &updated,
            chrono::Utc::now().timestamp_millis()
        ));
        apply_observation(&db, &event.id, &event.name, "执行中").unwrap();
        apply_flight_time(&db, &event.id, &event.name, &serde_json::Value::Null).unwrap();
        assert_eq!(
            current(&db).unwrap().unwrap().flight_time,
            updated.flight_time
        );
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
        let archived: Event = serde_json::from_str(
            &setting(&db, &format!("flight_history:{}", old.id))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(archived.flight_time.unwrap().duration_ms, 1260000);
    }
    #[test]
    fn flight_time_rejects_wrong_task_source_and_invalid_duration() {
        let db = db();
        let mut event = new_event("2026-09-22 20:18:24".into(), None, false);
        event.status = "completed".into();
        for (field, value) in [
            ("name", serde_json::json!("other")),
            ("url", serde_json::json!("https://other.test")),
            ("status", serde_json::json!("执行中")),
            ("durationMs", serde_json::json!(1)),
            ("startTime", serde_json::json!(-1)),
            ("endTime", serde_json::json!(i64::MAX)),
            ("source", serde_json::json!("planned")),
            ("precision", serde_json::json!("second")),
        ] {
            save(&db, &event).unwrap();
            let mut receipt = time_receipt(&event);
            if matches!(field, "name" | "url" | "status") {
                receipt[field] = value;
            } else {
                receipt["flightTime"][field] = value;
            }
            apply_flight_time(&db, &event.id, &event.name, &receipt).unwrap();
            let updated = current(&db).unwrap().unwrap();
            assert!(updated.flight_time.is_none(), "{field}");
            assert!(!needs_flight_time(
                &updated,
                chrono::Utc::now().timestamp_millis()
            ));
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
        assert_eq!(
            current(&db).unwrap().unwrap().status_check_error.as_deref(),
            Some("司空暂时不可用")
        );
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
    fn latest_missing_hour_uses_the_latest_valid_exceeded_reading() {
        let mut db = db();
        let t = parse("2026-09-22 14:00:00").unwrap();
        reading(&db, "2026-09-22 11:00:00", Some(2.0));
        reading(&db, "2026-09-22 12:00:00", None);
        reading(&db, "2026-09-22 13:00:00", None);
        reading(&db, "2026-09-22 14:00:00", None);
        let event = observe(&mut db, t, true).unwrap().unwrap();
        assert_eq!(event.observed_at, "2026-09-22 11:00:00");
        assert_eq!(event.source_hour.as_deref(), Some("2026-09-22 11:00:00"));
        dismiss(&db);
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
        let next = observe(&mut db, t, true).unwrap().unwrap();
        assert_ne!(event.id, next.id);
        dismiss(&db);
        reading(&db, "2026-09-22 10:00:00", None);
        assert!(observe(&mut db, t, true).unwrap().is_none());
        reading(&db, "2026-09-22 10:00:00", Some(0.5));
        observe(&mut db, t, true).unwrap();
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t, true).unwrap().is_none());
        dismiss(&db);
        reading(&db, "2026-09-22 10:00:00", Some(0.5));
        observe(&mut db, t, true).unwrap();
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t, true).unwrap().is_none());
    }
    #[test]
    fn delayed_potassium_triggers_after_normal_newer_pm25() {
        for same_hour in [true, false] {
            let mut db = db();
            configure(&db, 1.0, 5, false);
            let at = parse("2026-09-22 15:00:00").unwrap();
            reading_pm25(&db, "2026-09-22 15:00:00", Some(20.0));
            assert!(observe(&mut db, at, true).unwrap().is_none());
            let hour = if same_hour { "2026-09-22 15:00:00" } else { "2026-09-22 14:00:00" };
            if same_hour {
                db.execute("UPDATE hourly_observations SET potassium=2", []).unwrap();
            } else { reading(&db, hour, Some(2.0)); }
            let event = observe(&mut db, at, true).unwrap().unwrap();
            assert_eq!(event.source_hour.as_deref(), Some(hour));
            assert_eq!(event.potassium, Some(2.0));
            assert!(observe(&mut db, at, true).unwrap().is_none());
            dismiss(&db);
            assert!(observe(&mut db, at, true).unwrap().is_none());
        }
    }
    #[test]
    fn only_configured_metrics_trigger_and_each_has_own_freshness() {
        for potassium_enabled in [true, false] {
            let mut db = db();
            configure(&db, 1.0, 5, false);
            let mut settings = crate::settings::read(&db).unwrap();
            settings.potassium_enabled = potassium_enabled;
            settings.pm25_enabled = !potassium_enabled;
            put(&db, "workspace_settings", &serde_json::to_string(&settings).unwrap()).unwrap();
            let at = parse("2026-09-22 15:00:00").unwrap();
            reading(&db, "2026-09-22 14:00:00", Some(if potassium_enabled { 0.2 } else { 2.0 }));
            reading_pm25(&db, "2026-09-22 15:00:00", Some(if potassium_enabled { 80.0 } else { 20.0 }));
            assert!(observe(&mut db, at, true).unwrap().is_none());
            if potassium_enabled { reading(&db, "2026-09-22 14:00:00", Some(2.0)); }
            else { reading_pm25(&db, "2026-09-22 15:00:00", Some(80.0)); }
            assert!(observe(&mut db, at, true).unwrap().is_some());
        }
        let mut db = db();
        configure(&db, 1.0, 5, false);
        reading(&db, "2026-09-22 11:00:00", Some(2.0));
        reading_pm25(&db, "2026-09-22 15:00:00", Some(20.0));
        assert!(observe(&mut db, parse("2026-09-22 15:00:00").unwrap(), true).unwrap().is_none());
    }
    #[test]
    fn pm25_threshold_uses_or_rule_and_strict_boundary() {
        let mut db = db();
        configure(&db, 1.0, 5, true);
        let mut settings = crate::settings::read(&db).unwrap();
        settings.pm25_threshold = 30.0;
        put(&db, "workspace_settings", &serde_json::to_string(&settings).unwrap()).unwrap();
        let time = "2026-09-22 09:00:00";
        let at = parse("2026-09-22 10:00:00").unwrap();
        reading_pm25(&db, time, Some(30.0));
        assert!(observe(&mut db, at, true).unwrap().is_none());
        reading_pm25(&db, time, Some(30.1));
        let event = observe(&mut db, at, true).unwrap().unwrap();
        assert_eq!(event.potassium, None);
        assert_eq!(event.pm25, Some(30.1));
        assert_eq!(event.source_hour.as_deref(), Some(time));
    }
    #[test]
    fn platform_weather_verdicts_never_block_creation_and_snapshots_are_preserved() {
        for level in ["ok", "caution", "unsafe", "unknown"] {
            let mut db = db();
            let at = parse("2026-09-22 10:00:00").unwrap();
            reading(&db, "2026-09-22 09:00:00", Some(2.));
            let mut check = recorded_weather("creation", level == "ok", level == "unknown");
            check.weather.level = level.into();
            let snapshot = serde_json::to_value(&check).unwrap();
            let event = observe_with_weather(&mut db, at, Some(check)).unwrap().unwrap();
            assert_eq!(event.status, "countdown");
            assert_eq!(serde_json::to_value(&event.weather_checks[0]).unwrap(), snapshot);
            assert!(observe(&mut db, at, false).unwrap().is_none());
        }
    }
    #[test]
    fn exceedances_always_create_tasks_and_unresolved_plans_block_new_events() {
        let mut db = db();
        let t = parse("2026-09-22 10:00:00").unwrap();
        reading(&db, "2026-09-22 09:00:00", Some(2.));
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
        put(
            db,
            "workspace_settings",
            &serde_json::to_string(&settings).unwrap(),
        )
        .unwrap();
    }
    #[test]
    fn deleting_no_fly_settings_refreshes_current_state_but_retains_the_skipped_hour() {
        let mut db = db();
        morning_restriction(&db);
        let time = "2026-10-09 06:00:00";
        let at = parse("2026-10-09 07:00:00").unwrap();
        reading(&db, time, Some(1.33));
        // A previous attempt may already own this hour's deduplication receipt.
        put(&db, &format!("flight_handled:{time}"), "previous-attempt").unwrap();
        observe(&mut db, at, true).unwrap();
        let record = current(&db).unwrap().unwrap();
        let mut settings = crate::settings::read(&db).unwrap();
        settings.no_fly_periods.clear();
        crate::settings::save_and_reconcile(&db, &settings, at).unwrap();
        assert!(current(&db).unwrap().is_none());
        assert!(crate::settings::read(&db)
            .unwrap()
            .no_fly_periods
            .is_empty());
        assert_eq!(
            setting(&db, &format!("flight_handled:{time}"))
                .unwrap()
                .as_deref(),
            Some("previous-attempt")
        );
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
        let mut db = db();
        morning_restriction(&db);
        reading(&db, "2026-10-09 06:00:00", Some(1.33));
        let at = parse("2026-10-09 07:00:00").unwrap();
        observe(&mut db, at, true).unwrap();
        let record = current(&db).unwrap().unwrap();
        let mut settings = crate::settings::read(&db).unwrap();
        settings.no_fly_periods.push(crate::settings::NoFlyPeriod {
            start: "12:00".into(),
            end: "13:00".into(),
        });
        crate::settings::save_and_reconcile(&db, &settings, at).unwrap();
        assert_eq!(current(&db).unwrap().unwrap().id, record.id);
        let mut invalid = settings.clone();
        invalid.no_fly_periods[0].end = "05:00".into();
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
        let mut db = db();
        morning_restriction(&db);
        reading(&db, "2026-10-09 06:00:00", Some(1.33));
        observe(&mut db, parse("2026-10-09 07:00:00").unwrap(), true).unwrap();
        configure(&db, 1.0, 5, false);
        assert!(view(&db).unwrap().event.is_none());
        assert_eq!(view(&db).unwrap().records.len(), 1);
        for status in [
            "countdown",
            "preparing",
            "submitting",
            "submitted",
            "uncertain",
            "flying",
            "failed",
            "canceled",
        ] {
            let mut event = new_event("2026-10-09 06:00:00".into(), Some(1.33), false);
            event.status = status.into();
            save(&db, &event).unwrap();
            let settings = crate::settings::read(&db).unwrap();
            crate::settings::save_and_reconcile(&db, &settings, now()).unwrap();
            assert_eq!(view(&db).unwrap().event.unwrap().id, event.id, "{status}");
        }
    }
    #[test]
    fn restricted_hours_are_persisted_once_and_never_replayed_after_the_window() {
        let mut db = db();
        morning_restriction(&db);
        for hour in [5, 6, 7] {
            let time = format!("2026-10-09 {hour:02}:00:00");
            reading(&db, &time, Some(1.36));
            let at = parse(&time).unwrap();
            assert!(observe(&mut db, at, false).unwrap().is_none());
            let record = current(&db).unwrap().unwrap();
            assert_eq!(record.status, "restricted");
            assert!(record
                .error
                .as_deref()
                .unwrap()
                .contains("禁飞时间：05:00–08:00"));
            assert!(record.launch_at.is_none());
            assert!(observe(&mut db, at, true).unwrap().is_none());
            assert_eq!(current(&db).unwrap().unwrap().id, record.id);
        }
        assert_eq!(view(&db).unwrap().records.len(), 3);
        assert!(
            observe(&mut db, parse("2026-10-09 08:00:00").unwrap(), true)
                .unwrap()
                .is_none()
        );
        assert_eq!(current(&db).unwrap().unwrap().status, "restricted");
        reading(&db, "2026-10-09 08:00:00", Some(1.36));
        let next = observe(&mut db, parse("2026-10-09 08:00:00").unwrap(), true)
            .unwrap()
            .unwrap();
        assert_eq!(next.status, "countdown");
        assert_eq!(next.observed_at, "2026-10-09 08:00:00");
        assert_eq!(view(&db).unwrap().records.len(), 3);
    }
    #[test]
    fn countdown_is_stopped_on_entering_a_period_even_before_its_deadline() {
        let mut db = db();
        configure(&db, 1.0, 180, false);
        reading(&db, "2026-10-09 04:00:00", Some(1.36));
        let event = observe(&mut db, parse("2026-10-09 04:00:00").unwrap(), true)
            .unwrap()
            .unwrap();
        morning_restriction(&db);
        let at = (parse("2026-10-09 05:00:00").unwrap() - Duration::hours(8))
            .and_utc()
            .timestamp_millis();
        assert!(event.launch_at.unwrap() > at);
        assert!(claim_due(&db, at, 0).unwrap().is_none());
        assert_eq!(current(&db).unwrap().unwrap().status, "restricted");
        assert_eq!(setting(&db, "flight_episode").unwrap().as_deref(), Some(""));
        assert!(claim_due(&db, at + 3 * 3600000, 0).unwrap().is_none());
        assert_eq!(view(&db).unwrap().records[0].id, event.id);
    }
    #[test]
    fn manual_weather_override_cannot_bypass_no_fly_time_but_preview_still_does_not_launch() {
        let db = db();
        let at = now();
        let mut settings = crate::settings::read(&db).unwrap();
        settings.no_fly_periods = vec![crate::settings::NoFlyPeriod {
            start: (at - Duration::minutes(1)).format("%H:%M").to_string(),
            end: (at + Duration::minutes(1)).format("%H:%M").to_string(),
        }];
        put(
            &db,
            "workspace_settings",
            &serde_json::to_string(&settings).unwrap(),
        )
        .unwrap();
        assert!(begin_manual_request(&db, false, None, true)
            .unwrap_err()
            .contains("禁飞时间"));
        assert!(current(&db).unwrap().is_none());
        let preview = begin_manual_request(&db, true, None, false).unwrap();
        assert!(preview.preview);
        assert!(needs_confirmation(&db, &preview).unwrap());
    }
    #[test]
    fn forbidden_observation_is_recorded_without_overwriting_an_unresolved_flight() {
        for status in ["submitted", "uncertain", "flying", "submitting", "paused"] {
            let mut db = db();
            morning_restriction(&db);
            let mut event = new_event("2026-10-09 04:00:00".into(), Some(1.36), false);
            event.status = status.into();
            save(&db, &event).unwrap();
            reading(&db, "2026-10-09 05:00:00", Some(1.36));
            assert!(
                observe(&mut db, parse("2026-10-09 05:00:00").unwrap(), true)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(current(&db).unwrap().unwrap().id, event.id);
            assert_eq!(current(&db).unwrap().unwrap().status, status);
            assert_eq!(view(&db).unwrap().records[0].status, "restricted");
        }
    }
    #[test]
    fn new_restriction_preserves_the_failed_receipt_and_does_not_claim_normal_data() {
        let mut db = db();
        let failed = failed_automatic(&mut db);
        morning_restriction(&db);
        reading(&db, "2026-10-09 05:00:00", Some(1.36));
        observe(&mut db, parse("2026-10-09 06:00:00").unwrap(), true).unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "restricted");
        assert!(view(&db)
            .unwrap()
            .records
            .iter()
            .any(|r| r.id == failed.id && r.error == failed.error));
        reading(&db, "2026-10-09 06:00:00", Some(0.2));
        observe(&mut db, parse("2026-10-09 07:00:00").unwrap(), true).unwrap();
        assert!(setting(&db, "flight_restricted:2026-10-09 06:00:00")
            .unwrap()
            .is_none());
    }
    #[test]
    fn new_normal_hour_releases_failed_automatic_task_and_night_exceedance_launches() {
        let mut db = db();
        let failed = failed_automatic(&mut db);
        configure(&db, 1.0, 5, false);
        // The failed 19:00 attempt must not block normal 20:00 data or the
        // following 22:00 exceedance, even when weather is still unsuitable.
        reading(&db, "2026-10-08 20:00:00", Some(0.74));
        assert!(
            observe(&mut db, parse("2026-10-08 21:00:00").unwrap(), false)
                .unwrap()
                .is_none()
        );
        assert!(current(&db).unwrap().is_none());
        assert_eq!(setting(&db, "flight_episode").unwrap().as_deref(), Some(""));
        let history: Event = serde_json::from_str(
            &setting(&db, &format!("flight_history:{}", failed.id))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
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
        assert_eq!(
            next.launch_at,
            Some((at - Duration::hours(8)).and_utc().timestamp_millis() + 300000)
        );
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
        assert_eq!(
            setting(&db, "flight_handled:2026-10-08 19:00:00")
                .unwrap()
                .as_deref(),
            Some(failed.id.as_str())
        );
        assert_eq!(
            setting(&db, "flight_handled:2026-10-08 20:00:00")
                .unwrap()
                .as_deref(),
            Some(next.id.as_str())
        );
        assert!(observe(&mut db, at, true).unwrap().is_none());
    }
    fn retryable_failure(db: &mut Connection) -> Event {
        let failed = failed_automatic(db);
        let mut event = failed;
        event.error = Some("司空填写超时；计划填写回执不匹配；未发送起飞请求。".into());
        // The first automatic attempt is number one; failures keep the count.
        event.attempt = 1;
        // Every retry re-reads the trigger, so the source hour must look fresh
        // in the same local format the monitor stores it in.
        use chrono::Timelike;
        let fresh = (now() - Duration::minutes(now().minute() as i64 + 1))
            .with_minute(0).unwrap().with_second(0).unwrap()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        reading(db, &fresh, Some(0.54));
        event.source_hour = Some(fresh.clone());
        event.error = Some("司空填写超时；计划填写回执不匹配；未发送起飞请求。".into());
        event.retry_at = Some(chrono::Utc::now().timestamp_millis());
        save(db, &event).unwrap();
        event
    }
    #[test]
    fn automatic_failure_before_sending_retries_the_same_hour_with_a_bounded_count() {
        let mut db = db();
        let failed = retryable_failure(&mut db);
        let at = chrono::Utc::now().timestamp_millis();
        let first = claim_due(&db, at, 0).unwrap().unwrap();
        assert_ne!(first.id, failed.id);
        assert_eq!(first.status, "preparing");
        assert_eq!(first.attempt, 2);
        assert_eq!(first.source_hour, failed.source_hour);
        assert_eq!(first.name, failed.name);
        assert_eq!(first.retried_event_id.as_deref(), Some(failed.id.as_str()));
        // The released attempt keeps its receipt, the hour keeps one owner.
        assert!(setting(&db, &format!("flight_history:{}", failed.id)).unwrap().is_some());
        assert!(current(&db).unwrap().is_none_or(|e| e.id == first.id));
        // The retry is a new attempt, not a new hour: it must not re-trigger a
        // second evaluation for the same source hour.
        assert!(observe(&mut db, now(), true).unwrap().is_none());

        // A second failure within the same hour retries again...
        let mut second = current(&db).unwrap().unwrap();
        second.status = "failed".into();
        second.retry_at = Some(at);
        save(&db, &second).unwrap();
        let third = claim_due(&db, at, 0).unwrap().unwrap();
        assert_eq!(third.attempt, 3);
        // ...until the persisted limit is reached.
        let mut third = third;
        third.status = "failed".into();
        third.retry_at = Some(at);
        save(&db, &third).unwrap();
        assert!(claim_due(&db, at, 0).unwrap().is_none());
        assert_eq!(current(&db).unwrap().unwrap().attempt, 3);
    }
    #[test]
    fn retries_stop_when_the_hour_is_no_longer_the_exceeding_one() {
        // A newer, normal hour ends the same-hour retry: the trigger no longer
        // applies and the operator must see the failure instead.
        let mut db = db();
        let failed = retryable_failure(&mut db);
        let at = chrono::Utc::now().timestamp_millis();
        // Raising the threshold makes the same stored hour no longer exceed it.
        let mut settings = crate::settings::read(&db).unwrap();
        settings.potassium_threshold = 0.9;
        crate::settings::save_and_reconcile(&db, &settings, now()).unwrap();
        assert!(claim_due(&db, at, 0).unwrap().is_none());
        assert_eq!(current(&db).unwrap().unwrap().id, failed.id);
        assert!(current(&db).unwrap().unwrap().retry_at.is_none());
    }
    #[test]
    fn a_failure_that_may_have_been_sent_is_never_automatically_retried() {
        let mut db = db();
        let mut event = failed_automatic(&mut db);
        event.error = Some("提交回执不确定，请到司空核查；不会自动重试。".into());
        event.status = "uncertain".into();
        save(&db, &event).unwrap();
        let at = chrono::Utc::now().timestamp_millis();
        assert!(claim_due(&db, at, 0).unwrap().is_none());
        // Manual mode never retries automatically either.
        let mut manual = super::tests::db();
        let mut failed = retryable_failure(&mut manual);
        configure(&manual, 0.5, 5, true);
        failed.attempt = 1;
        save(&manual, &failed).unwrap();
        assert!(claim_due(&manual, at, 0).unwrap().is_none());
    }
    #[test]
    fn a_countdown_interrupted_by_a_restart_is_rechecked_instead_of_fired_or_lost() {
        let mut db = db();
        configure(&db, 0.5, 5, false);
        let time = "2026-10-08 19:00:00";
        reading(&db, time, Some(0.54));
        let mut event = observe(&mut db, parse(time).unwrap(), true).unwrap().unwrap();
        let deadline = event.launch_at.unwrap();
        // Claimed by a process that started after the deadline was armed.
        let claimed = claim_due(&db, deadline, deadline + 30 * 60 * 1000).unwrap().unwrap();
        assert_ne!(claimed.id, event.id);
        assert_eq!(claimed.source_hour, event.source_hour);
        assert_eq!(claimed.status, "preparing");
        assert_eq!(claimed.attempt, 2);
    }
    #[test]
    fn automatic_mode_recovers_same_hour_failure_from_old_review_overlay() {
        let mut db = db();
        let mut failed = failed_automatic(&mut db);
        failed.error = Some("司空核对面板状态缺失，未自动确认".into());
        save(&db, &failed).unwrap();
        let at = parse("2026-10-08 19:00:00").unwrap();
        let next = observe(&mut db, at, true).unwrap().unwrap();
        assert_ne!(next.id, failed.id);
        assert_eq!(next.status, "countdown");
        assert!(setting(&db, &format!("flight_history:{}", failed.id)).unwrap().is_some());
        assert_eq!(setting(&db, "flight_episode").unwrap().as_deref(), Some(next.source_hour.as_deref().unwrap()));
    }
    #[test]
    fn released_failure_creates_next_hour_even_when_weather_is_unavailable() {
        let mut db = db();
        failed_automatic(&mut db);
        let time = "2026-10-08 20:00:00";
        let at = parse(time).unwrap();
        reading(&db, time, Some(1.36));
        let next = observe(&mut db, at, false).unwrap().unwrap();
        assert_eq!(next.weather_checks[0].weather.level, "unknown");
        assert!(serde_json::to_value(&next.weather_checks[0]).unwrap()["weather"]["current"].is_null());
        assert!(observe(&mut db, at, true).unwrap().is_none());
    }
    #[test]
    fn missing_expired_or_future_hours_do_not_release_a_failure() {
        for (time, k) in [
            ("2026-10-08 20:00:00", None),
            ("2026-10-08 20:00:00", Some(1.36)),
            ("2026-10-09 06:00:00", Some(1.36)),
        ] {
            let mut db = db();
            let failed = failed_automatic(&mut db);
            reading(&db, time, k);
            assert!(
                observe(&mut db, parse("2026-10-09 05:00:00").unwrap(), true)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(current(&db).unwrap().unwrap().id, failed.id);
            assert!(setting(&db, &format!("flight_history:{}", failed.id))
                .unwrap()
                .is_none());
        }
    }
    #[test]
    fn new_hour_does_not_replace_active_or_uncertain_tasks_of_any_source() {
        for source in ["auto", "manual", "preview"] {
            for status in [
                "countdown",
                "preparing",
                "ready",
                "submitting",
                "submitted",
                "uncertain",
                "flying",
                "paused",
                "flight_error",
            ] {
                let mut db = db();
                let mut event = failed_automatic(&mut db);
                event.source = source.into();
                event.preview = source == "preview";
                event.status = status.into();
                save(&db, &event).unwrap();
                reading(&db, "2026-10-08 20:00:00", Some(1.36));
                assert!(
                    observe(&mut db, parse("2026-10-08 20:00:00").unwrap(), true)
                        .unwrap()
                        .is_none(),
                    "{source}/{status}"
                );
                let actual = current(&db).unwrap().unwrap();
                assert_eq!(actual.id, event.id, "{source}/{status}");
                assert_eq!(actual.status, event.status, "{source}/{status}");
            }
        }
    }
    fn failed_at(db: &Connection, source: &str, time: &str) -> Event {
        let mut event = new_event(time.into(), None, source == "preview");
        event.source = source.into();
        event.status = "failed".into();
        event.error = Some("客户端中断，未发送起飞请求；请核查原计划。".into());
        event
            .weather_checks
            .push(recorded_weather("creation", true, false));
        save(db, &event).unwrap();
        event
    }
    #[test]
    fn next_valid_hour_releases_all_pre_submission_failures_and_preserves_receipts() {
        for source in ["auto", "manual", "preview", ""] {
            let mut db = db();
            configure(&db, 1.0, 5, false);
            let failed = failed_at(
                &db,
                source,
                if source == "auto" {
                    "2026-10-13 23:00:00"
                } else {
                    "2026-10-13 23:27:11"
                },
            );
            let original = serde_json::to_value(&failed).unwrap();
            put(
                &db,
                "flight_handled:2026-10-13 23:00:00",
                "prior-auto-attempt",
            )
            .unwrap();
            // Advancing wall time alone, or receiving late values in the same
            // source hour, must not replay that hour.
            {
                let time = "2026-10-13 23:00:00";
                reading(&db, time, Some(2.));
                assert!(
                    observe(&mut db, parse("2026-10-14 01:00:00").unwrap(), true)
                        .unwrap()
                        .is_none(),
                    "{source}"
                );
                assert_eq!(current(&db).unwrap().unwrap().id, failed.id);
            }
            recover(&db).unwrap();
            reading(&db, "2026-10-14 00:00:00", Some(2.));
            // The new hour can proceed with a recorded weather failure.
            let next = observe(&mut db, parse("2026-10-14 01:00:00").unwrap(), false)
                .unwrap().unwrap();
            let archived: serde_json::Value = serde_json::from_str(
                &setting(&db, &format!("flight_history:{}", failed.id))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(archived, original);
            assert_eq!(
                setting(&db, "flight_handled:2026-10-13 23:00:00")
                    .unwrap()
                    .as_deref(),
                Some("prior-auto-attempt")
            );
            assert_eq!(next.source, "auto");
            assert_eq!(next.status, "countdown");
            assert_ne!(next.id, failed.id);
            assert!(
                observe(&mut db, parse("2026-10-14 01:00:00").unwrap(), true)
                    .unwrap()
                    .is_none()
            );
        }
    }
    #[test]
    fn manual_failure_rollover_honors_missing_data_normal_values_and_no_fly_hours() {
        for (time, value, restricted) in [
            ("2026-10-14 00:00:00", Some(0.5), false),
            ("2026-10-14 00:00:00", None, false),
            ("2026-10-14 05:00:00", Some(2.), true),
        ] {
            let mut db = db();
            morning_restriction(&db);
            let failed = failed_at(&db, "manual", "2026-10-13 23:27:11");
            reading(&db, time, value);
            assert!(observe(&mut db, parse(time).unwrap(), true)
                .unwrap()
                .is_none());
            let event = current(&db).unwrap();
            if value.is_none() {
                assert_eq!(event.unwrap().id, failed.id);
            } else {
                assert!(setting(&db, &format!("flight_history:{}", failed.id))
                    .unwrap()
                    .is_some());
                if restricted {
                    assert_eq!(event.unwrap().status, "restricted");
                } else {
                    assert!(event.is_none());
                }
            }
        }
    }
    #[test]
    fn failed_task_rollover_is_atomic_when_archival_fails() {
        let mut db = db();
        let failed = failed_at(&db, "manual", "2026-10-13 23:27:11");
        reading(&db, "2026-10-14 00:00:00", Some(2.));
        db.execute_batch("CREATE TRIGGER reject_archive BEFORE INSERT ON monitor_settings WHEN NEW.key LIKE 'flight_history:%' BEGIN SELECT RAISE(ABORT, 'fixture archive failure'); END;").unwrap();
        assert!(observe(&mut db, parse("2026-10-14 00:00:00").unwrap(), true).is_err());
        assert_eq!(current(&db).unwrap().unwrap().id, failed.id);
        assert!(setting(&db, "flight_handled:2026-10-14 00:00:00")
            .unwrap()
            .is_none());
    }
    #[test]
    fn consecutive_hours_survive_restart_weather_failure_and_completion() {
        let path =
            std::env::temp_dir().join(format!("hourly-flights-{}.sqlite3", uuid::Uuid::new_v4()));
        let mut db = crate::monitoring::connect(&path).unwrap();
        let mut settings = crate::settings::Settings::default();
        settings.no_fly_periods.clear();
        settings.require_manual_confirmation = false;
        put(
            &db,
            "workspace_settings",
            &serde_json::to_string(&settings).unwrap(),
        )
        .unwrap();
        for hour in 0..24 {
            let time = format!("2026-10-11 {hour:02}:00:00");
            let at = parse(&time).unwrap();
            reading(&db, &time, Some(2.));
            // A failed weather read is recorded and does not suppress this hour.
            let event = observe(&mut db, at, false).unwrap().unwrap();
            assert_eq!(event.observed_at, time);
            assert!(observe(&mut db, at, true).unwrap().is_none());
            let mut finished = event.clone();
            match hour % 4 {
                0 => {
                    finished.status = "submitted".into();
                    save(&db, &finished).unwrap();
                    apply_observation(&db, &event.id, &event.name, "执行成功").unwrap();
                }
                1 => {
                    finished.status = "uncertain".into();
                    save(&db, &finished).unwrap();
                    record_check_error(
                        &db,
                        &event.id,
                        &event.name,
                        "司空平台天气阻飞：风速过高；未继续执行",
                    )
                    .unwrap();
                }
                2 => {
                    finished.status = "failed".into();
                    save(&db, &finished).unwrap();
                }
                _ => {
                    cancel(&db, &event.id).unwrap();
                }
            }
            drop(db);
            db = crate::monitoring::connect(&path).unwrap();
            recover(&db).unwrap();
            assert!(observe(&mut db, at, true).unwrap().is_none());
        }
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM monitor_settings WHERE key LIKE 'flight_handled:%'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            24
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM monitor_settings WHERE key LIKE 'flight_history:%'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            23
        );
        drop(db);
        std::fs::remove_file(path).unwrap();
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
        assert!(claim_due(&db, due - 1, 0).unwrap().is_none());
        assert!(cancel(&db, "stale-id").is_err());
        cancel(&db, &event.id).unwrap();
        assert!(claim_due(&db, due + 1000, 0).unwrap().is_none());
        assert!(observe(&mut db, t, true).unwrap().is_none());
        // Cancellation must not block an intentional manual flight even without K+.
        let manual = begin_manual(&db, false).unwrap();
        assert_eq!(manual.source, "manual");
        assert!(manual.potassium.is_none());
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
            assert!(setting(&db, &format!("flight_handled:{time}"))
                .unwrap()
                .is_none());
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
        assert_eq!(
            setting(&db, "flight_episode").unwrap().as_deref(),
            Some(time)
        );
        assert_eq!(
            setting(&db, &format!("flight_handled:{time}"))
                .unwrap()
                .as_deref(),
            Some(automatic.id.as_str())
        );
        assert!(observe(&mut db, t, true).unwrap().is_none());
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        let next = observe(&mut db, t, true).unwrap().unwrap();
        assert_eq!(next.source, "auto");
        cancel(&db, &next.id).unwrap();
        reading(&db, "2026-09-22 10:00:00", Some(0.5));
        observe(&mut db, t, true).unwrap();
        reading(&db, "2026-09-22 10:00:00", Some(2.));
        assert!(observe(&mut db, t, true).unwrap().is_none());
    }
    #[test]
    fn manual_flights_can_share_the_same_latest_hourly_observation() {
        let db = db();
        let hour = "2026-09-22 15:00:00";
        reading(&db, "2026-09-22 14:00:00", Some(2.0));
        db.execute(
            "INSERT OR REPLACE INTO hourly_observations VALUES ('321200',?,?,?,'μg/m³','source','A_6','30','sync')",
            rusqlite::params!["2026-09-22 15:00:00", Option::<f64>::None, Some(15.0_f64)],
        )
        .unwrap();
        let first = begin_manual(&db, false).unwrap();
        assert_eq!(first.source_hour.as_deref(), Some(hour));
        cancel(&db, &first.id).unwrap();
        let second = begin_manual(&db, false).unwrap();
        assert_eq!(second.source_hour.as_deref(), Some(hour));
        assert_ne!(first.id, second.id);
        let archived: Event = serde_json::from_str(
            &setting(&db, &format!("flight_history:{}", first.id))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(archived.source_hour.as_deref(), Some(hour));
    }
    #[test]
    fn automatic_history_binding_prevents_replay_when_legacy_marker_is_missing() {
        let mut db = db();
        let hour = "2026-09-22 14:00:00";
        reading(&db, hour, Some(2.0));
        let automatic = observe(&mut db, parse(hour).unwrap(), true).unwrap().unwrap();
        cancel(&db, &automatic.id).unwrap();
        let manual = begin_manual(&db, false).unwrap();
        cancel(&db, &manual.id).unwrap();
        db.execute("DELETE FROM monitor_settings WHERE key=?", [format!("flight_handled:{hour}")]).unwrap();
        assert!(observe(&mut db, parse(hour).unwrap(), true).unwrap().is_none());
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
        let mut claimed = claim_due(&db, due, 0).unwrap().unwrap();
        assert_eq!(claimed.status, "preparing");
        assert!(claim_due(&db, due, 0).unwrap().is_none());
        assert!(!needs_confirmation(&db, &claimed).unwrap());
        configure(&db, 2.5, 1440, true);
        assert!(needs_confirmation(&db, &claimed).unwrap());
        claimed.source = "manual".into();
        assert!(!needs_confirmation(&db, &claimed).unwrap());
        claimed.preview = true;
        assert!(needs_confirmation(&db, &claimed).unwrap());
        claimed.status = "submitting".into();
        save(&db, &claimed).unwrap();
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
        let claimed = claim_due(&db, now, 0).unwrap().unwrap();
        assert!(needs_confirmation(&db, &claimed).unwrap());
        let mut pending = claimed;
        pending.status = "countdown".into();
        pending.launch_at = Some(now + 300000);
        save(&db, &pending).unwrap();
        configure(&db, 1.0, 5, false);
        assert!(claim_due(&db, now, 0).unwrap().is_none());
        configure(&db, 1.0, 5, true);
        assert!(claim_due(&db, now, 0).unwrap().is_some());
    }
    #[test]
    fn restart_never_replays_a_deadline_or_an_ambiguous_submission() {
        let db = db();
        for (before, after) in [
            ("countdown", "canceled"),
            ("preparing", "failed"),
            ("submitting", "uncertain"),
            ("submitted", "submitted"),
        ] {
            let mut event = new_event("2026-09-22 09:00:00".into(), Some(2.), false);
            event.status = before.into();
            event.launch_at = Some(1);
            save(&db, &event).unwrap();
            recover(&db).unwrap();
            assert_eq!(current(&db).unwrap().unwrap().status, after);
            assert!(claim_due(&db, i64::MAX, 0).unwrap().is_none());
        }
    }
    #[test]
    fn legacy_auto_fill_is_not_permission_to_submit_and_manual_ignores_missing_k() {
        let db = crate::monitoring::connect(std::path::Path::new(":memory:")).unwrap();
        configure(&db, 1.0, 5, true);
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
        automatic.status = "failed".into();
        automatic.error = Some("天气条件未通过".into());
        save(&db, &automatic).unwrap();
        assert!(begin_manual(&db, false).is_err());
        assert!(begin_manual_request(&db, false, Some("stale-id"), true).is_err());
        assert_eq!(current(&db).unwrap().unwrap().id, automatic.id);
        let manual = begin_manual_request(&db, false, Some(&automatic.id), true).unwrap();
        assert_ne!(manual.id, automatic.id);
        assert_eq!(manual.source, "manual");
        assert!(manual.weather_override_confirmed_at.is_some());
        let history: Event = serde_json::from_str(
            &setting(&db, &format!("flight_history:{}", automatic.id))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(history.status, "failed");
        assert_eq!(history.error, automatic.error);
        assert_eq!(
            setting(&db, "flight_episode").unwrap().as_deref(),
            Some("2026-10-08 19:00:00")
        );
        assert!(begin_manual_request(&db, false, Some(&automatic.id), true).is_err());
        cancel(&db, &manual.id).unwrap();
        let next = begin_manual(&db, false).unwrap();
        assert!(!next.weather_override_confirmed_at.is_some());
        assert!(next.weather_override_confirmed_at.is_none());
    }
    #[test]
    fn manual_override_cannot_replace_a_submitted_uncertain_or_active_flight() {
        let db = db();
        for status in [
            "countdown",
            "preparing",
            "ready",
            "submitting",
            "submitted",
            "uncertain",
            "flying",
            "paused",
            "flight_error",
        ] {
            let mut event = new_event("2026-10-08 19:00:00".into(), Some(2.), false);
            event.status = status.into();
            save(&db, &event).unwrap();
            assert!(begin_manual_request(&db, false, Some(&event.id), true).is_err());
            assert!(begin_manual_request(&db, false, None, true).is_err());
            assert_eq!(current(&db).unwrap().unwrap().id, event.id);
        }
    }
    #[test]
    fn checking_a_pending_platform_task_resolves_uncertainty_without_allowing_retry() {
        let db = db();
        let mut event = new_event("2026-10-11 14:00:00".into(), None, false);
        event.status = "uncertain".into();
        save(&db, &event).unwrap();
        record_check_error(&db, &event.id, &event.name, "之前核查超时").unwrap();
        apply_observation(&db, &event.id, &event.name, "待执行").unwrap();
        let pending = current(&db).unwrap().unwrap();
        assert_eq!(pending.status, "submitted");
        assert!(pending.status_check_error.is_none());
        assert!(pending.status_checked_at.is_some());
        assert!(begin_manual_request(&db, false, Some(&event.id), false).is_err());
    }
    #[test]
    fn first_submission_weather_receipt_releases_next_hour_without_draft_recheck() {
        let mut db = db();
        let hour = "2026-10-13 14:00:00";
        reading(&db, hour, Some(2.));
        let mut event = observe(&mut db, parse(hour).unwrap(), true)
            .unwrap()
            .unwrap();
        event.status = "submitting".into();
        event
            .weather_checks
            .push(recorded_weather("creation", true, false));
        save(&db, &event).unwrap();
        // The draft may be closed immediately after this first, definitive receipt.
        let receipt = "司空平台天气阻飞：在线天气风速过高；未继续执行";
        apply_submission_result(&db, &event.id, &event.name, Err(receipt.into())).unwrap();
        let blocked = current(&db).unwrap().unwrap();
        assert_eq!(blocked.status, "not_flown");
        assert_eq!(blocked.error.as_deref(), Some(receipt));
        assert_eq!(blocked.weather_checks.len(), 1);
        assert!(blocked.status_check_error.is_none());
        assert!(setting(&db, &format!("flight_history:{}", event.id))
            .unwrap()
            .is_some());
        handle_unmatched_status(&db, &event.id, &event.name).unwrap();
        recover(&db).unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "not_flown");
        assert!(observe(&mut db, parse(hour).unwrap(), true)
            .unwrap()
            .is_none());
        assert_eq!(
            setting(&db, &format!("flight_handled:{hour}"))
                .unwrap()
                .as_deref(),
            Some(event.id.as_str())
        );
        let next_hour = "2026-10-13 15:00:00";
        reading(&db, next_hour, Some(2.));
        let next = observe(&mut db, parse(next_hour).unwrap(), false).unwrap().unwrap();
        assert_ne!(next.id, event.id);
        assert_eq!(next.observed_at, next_hour);
    }
    #[test]
    fn submission_weather_receipt_takes_precedence_over_cancel_wording() {
        let db = db();
        for (error, expected) in [
            (
                "司空平台天气阻飞：请取消任务后等待天气恢复；未继续执行",
                "not_flown",
            ),
            ("用户已取消本次作业", "canceled"),
        ] {
            let mut event = new_event("2026-10-13 14:00:00".into(), Some(2.), false);
            event.status = "submitting".into();
            save(&db, &event).unwrap();
            apply_submission_result(&db, &event.id, &event.name, Err(error.into())).unwrap();
            assert_eq!(current(&db).unwrap().unwrap().status, expected);
        }
        let mut event = new_event("2026-10-13 15:00:00".into(), Some(2.), false);
        event.status = "submitting".into();
        save(&db, &event).unwrap();
        apply_submission_result(
            &db,
            &event.id,
            &event.name,
            Ok(serde_json::json!({"status":"submitted", "submitted":true, "name":event.name})),
        )
        .unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "submitted");
    }
    #[test]
    fn submission_without_definitive_weather_receipt_keeps_next_hour_blocked() {
        for result in [
            Err("请求超时".into()),
            Err("司空平台天气阻飞：风速过高".into()),
            Err("司空平台要求人工确认：风速过高；未继续执行".into()),
            Ok(serde_json::json!({"status":"submitted", "submitted":true, "name":"other-plan"})),
        ] {
            let mut db = db();
            let mut event = new_event("2026-10-13 14:00:00".into(), Some(2.), false);
            event.status = "submitting".into();
            save(&db, &event).unwrap();
            apply_submission_result(&db, &event.id, &event.name, result).unwrap();
            assert_eq!(current(&db).unwrap().unwrap().status, "uncertain");
            recover(&db).unwrap();
            reading(&db, "2026-10-13 15:00:00", Some(2.));
            assert!(
                observe(&mut db, parse("2026-10-13 15:00:00").unwrap(), true)
                    .unwrap()
                    .is_none()
            );
        }
    }
    #[test]
    fn late_submission_weather_receipt_cannot_replace_another_task_or_known_flight() {
        let db = db();
        for status in ["submitting", "submitted", "flying", "paused", "completed"] {
            let mut event = new_event("2026-10-13 14:00:00".into(), Some(2.), false);
            event.status = status.into();
            save(&db, &event).unwrap();
            let receipt = || Err("司空平台天气阻飞：风速过高；未继续执行".into());
            apply_submission_result(&db, "other-id", &event.name, receipt()).unwrap();
            apply_submission_result(&db, &event.id, "other-name", receipt()).unwrap();
            if status != "submitting" {
                apply_submission_result(&db, &event.id, &event.name, receipt()).unwrap();
            }
            assert_eq!(
                serde_json::to_value(current(&db).unwrap().unwrap()).unwrap(),
                serde_json::to_value(event).unwrap()
            );
        }
    }
    #[test]
    fn confirmed_weather_block_retries_only_on_a_new_hour() {
        let mut db = db();
        let mut event = new_event("2026-10-11 14:00:00".into(), None, false);
        event.status = "uncertain".into();
        event.error = Some("原提交超时回执".into());
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
        reading(&db, "2026-10-11 14:00:00", Some(2.));
        assert!(
            observe(&mut db, parse("2026-10-11 14:00:00").unwrap(), true)
                .unwrap()
                .is_none()
        );
        recover(&db).unwrap();
        reading(&db, "2026-10-11 15:00:00", Some(2.));
        let next = observe(&mut db, parse("2026-10-11 15:00:00").unwrap(), false)
            .unwrap().unwrap();
        assert_ne!(next.id, event.id);
        assert_eq!(next.source, "auto");
        assert!(view(&db)
            .unwrap()
            .records
            .iter()
            .any(|r| r.id == event.id && r.status == "not_flown"));
    }
    #[test]
    fn weather_errors_cannot_release_a_known_submitted_or_executing_task() {
        let db = db();
        for status in ["submitted", "flying", "paused"] {
            let mut event = new_event("2026-10-11 14:00:00".into(), None, false);
            event.status = status.into();
            save(&db, &event).unwrap();
            record_check_error(
                &db,
                &event.id,
                &event.name,
                "司空平台天气阻飞：在线天气风速 12.75m/s；未继续执行",
            )
            .unwrap();
            assert_eq!(current(&db).unwrap().unwrap().status, status);
            assert!(begin_manual(&db, false).is_err());
        }
    }
    #[test]
    fn explicit_refresh_preserves_unknown_submission_until_platform_confirms_outcome() {
        let mut db = db();
        let mut event = new_event("2026-10-11 14:00:00".into(), None, false);
        event.status = "uncertain".into();
        event.error = Some("原起飞请求超时".into());
        save(&db, &event).unwrap();
        for _ in 0..2 {
            handle_unmatched_status(&db, &event.id, &event.name).unwrap();
            assert_eq!(current(&db).unwrap().unwrap().id, event.id);
            assert!(begin_manual(&db, false).is_err());
        }
        recover(&db).unwrap();
        reading(&db, "2026-10-11 15:00:00", Some(2.));
        assert!(
            observe(&mut db, parse("2026-10-11 15:00:00").unwrap(), true)
                .unwrap()
                .is_none()
        );
        apply_observation(&db, &event.id, &event.name, "执行成功").unwrap();
        assert!(
            observe(&mut db, parse("2026-10-11 15:00:00").unwrap(), true)
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn upgrade_restores_legacy_unknown_reservation_but_not_completed_history() {
        for status in ["uncertain", "completed"] {
            let mut db = db();
            let mut event = new_event("2026-10-11 14:00:00".into(), Some(2.), false);
            event.status = status.into();
            archive(&db, &event).unwrap();
            put(&db, "flight_episode", &event.observed_at).unwrap();
            recover(&db).unwrap();
            reading(&db, "2026-10-11 15:00:00", Some(2.));
            let next = observe(&mut db, parse("2026-10-11 15:00:00").unwrap(), true).unwrap();
            assert_eq!(next.is_none(), status == "uncertain");
            if status == "uncertain" {
                assert_eq!(current(&db).unwrap().unwrap().id, event.id);
            }
        }
    }
    #[test]
    fn explicit_refresh_does_not_release_known_pending_or_active_flights() {
        let db = db();
        for status in ["submitted", "flying", "paused", "submitting"] {
            let mut event = new_event("2026-10-11 14:00:00".into(), None, false);
            event.status = status.into();
            save(&db, &event).unwrap();
            handle_unmatched_status(&db, &event.id, &event.name).unwrap();
            assert_eq!(current(&db).unwrap().unwrap().status, status);
            assert!(begin_manual(&db, false).is_err());
        }
    }

    #[test]
    fn review_ready_accepts_platform_completion_after_human_submit() {
        let db = db();
        let mut event = new_event("2026-10-11 10:00:00".into(), Some(2.0), false);
        event.status = "ready".into();
        save(&db, &event).unwrap();
        apply_observation(&db, &event.id, &event.name, "执行成功").unwrap();
        assert_eq!(
            current(&db).unwrap().unwrap().status,
            "completed",
            "Human-confirmed flight must leave ready when platform confirms completion"
        );
    }
    #[test]
    fn ended_partial_task_releases_slot_but_keeps_receipt_and_episode() {
        let db = db();
        let mut event = begin_manual(&db, false).unwrap();
        event.status = "flight_error".into();
        save(&db, &event).unwrap();
        let end = chrono::Utc::now().timestamp_millis() - 1000;
        let mut task: crate::flight_report::DjiTask = serde_json::from_value(serde_json::json!({
            "mission": {"missionId":0,"missionName":event.name,"startTime":end-60000,"endTime":end,"geoLocation":""},
            "status":"部分执行","mediaReady":false,"partialReason":"操作员终止任务"
        })).unwrap();
        task.actual_time_missing = true;
        reconcile_ended_tasks(&db, &[task.clone()]).unwrap();
        assert!(current(&db).unwrap().is_some());
        task.actual_time_missing = false;
        reconcile_ended_tasks(&db, &[task.clone(), task.clone()]).unwrap();
        assert!(current(&db).unwrap().is_some());
        let mut unrelated = task.clone();
        unrelated.mission.mission_name = "other".into();
        reconcile_ended_tasks(&db, &[unrelated]).unwrap();
        assert!(current(&db).unwrap().is_some());
        reconcile_ended_tasks(&db, &[task]).unwrap();
        assert!(current(&db).unwrap().is_none());
        let saved: Event = serde_json::from_str(&setting(&db, &format!("flight_history:{}",event.id)).unwrap().unwrap()).unwrap();
        assert_eq!(saved.status, "flight_error");
        assert!(saved.error.unwrap().contains("操作员终止任务"));
        assert_eq!(setting(&db, "flight_episode").unwrap().unwrap(), event.observed_at);
        assert!(begin_manual(&db, false).is_ok());
    }

    #[test]
    fn ended_manual_task_does_not_consume_newer_pm25_hour() {
        for legacy in [false, true] {
            let mut db = db();
            configure(&db, 1.0, 5, false);
            let mut event = new_event("2026-10-31 21:52:39".into(), None, false);
            event.source = "manual".into();
            event.source_hour = Some("2026-10-31 20:00:00".into());
            event.status = "flight_error".into();
            save(&db, &event).unwrap();
            let task: crate::flight_report::DjiTask = serde_json::from_value(serde_json::json!({
                "mission":{"missionId":0,"missionName":event.name,"startTime":1793454780000_i64,"endTime":1793455920000_i64,"geoLocation":""},
                "status":"部分执行","mediaReady":false
            })).unwrap();
            reconcile_ended_tasks(&db, &[task]).unwrap();
            if legacy { put(&db, "flight_episode", &event.observed_at).unwrap(); }
            recover(&db).unwrap();
            assert_eq!(setting(&db, "flight_episode").unwrap().as_deref(), Some("2026-10-31 20:00:00"));
            reading(&db, "2026-10-31 20:00:00", Some(0.94));
            db.execute("UPDATE hourly_observations SET pm25=63", []).unwrap();
            assert!(observe(&mut db, parse("2026-10-31 21:00:00").unwrap(), true).unwrap().is_none());
            reading(&db, "2026-10-31 21:00:00", Some(0.94));
            db.execute("UPDATE hourly_observations SET pm25=63 WHERE observed_at='2026-10-31 21:00:00'", []).unwrap();
            let at = parse("2026-10-31 22:00:00").unwrap();
            let next = observe(&mut db, at, true).unwrap().unwrap();
            assert_eq!(next.status, "countdown");
            assert_eq!(next.source_hour.as_deref(), Some("2026-10-31 21:00:00"));
            assert!(next.name.starts_with("PM2.5超标巡查"));
            assert_eq!(next.launch_at, Some((at-Duration::hours(8)).and_utc().timestamp_millis()+300000));
            assert!(observe(&mut db, at, true).unwrap().is_none());
            assert!(setting(&db, &format!("flight_history:{}",event.id)).unwrap().is_some());
        }
    }

    #[test]
    fn review_flight_error_can_reconcile_later_platform_success() {
        let db = db();
        let mut event = new_event("2026-10-11 10:00:00".into(), Some(2.0), false);
        event.status = "submitted".into();
        save(&db, &event).unwrap();
        apply_observation(&db, &event.id, &event.name, "部分执行").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "flight_error");
        apply_observation(&db, &event.id, &event.name, "执行成功").unwrap();
        assert_eq!(
            current(&db).unwrap().unwrap().status,
            "completed",
            "Reconciled platform outcome must not be ignored forever"
        );
    }
    #[test]
    fn review_completed_manual_task_is_retained_when_next_task_begins() {
        let db = db();
        let mut event = begin_manual(&db, false).unwrap();
        event.status = "completed".into();
        save(&db, &event).unwrap();
        begin_manual(&db, false).unwrap();
        assert!(
            setting(&db, &format!("flight_history:{}", event.id))
                .unwrap()
                .is_some(),
            "New manual task overwrote completed event and its weather audit trail"
        );
    }
    #[test]
    fn review_completed_auto_task_is_retained_on_next_episode() {
        let mut db = db();
        reading(&db, "2026-10-11 10:00:00", Some(2.0));
        let mut event = observe(&mut db, parse("2026-10-11 10:00:00").unwrap(), true)
            .unwrap()
            .unwrap();
        event.status = "completed".into();
        save(&db, &event).unwrap();
        reading(&db, "2026-10-11 11:00:00", Some(0.2));
        observe(&mut db, parse("2026-10-11 11:00:00").unwrap(), true).unwrap();
        reading(&db, "2026-10-11 12:00:00", Some(2.0));
        assert!(
            observe(&mut db, parse("2026-10-11 12:00:00").unwrap(), true)
                .unwrap()
                .is_some()
        );
        assert!(
            setting(&db, &format!("flight_history:{}", event.id))
                .unwrap()
                .is_some(),
            "Next automatic episode overwrote completed event and its weather audit trail"
        );
    }
    #[test]
    fn review_not_flown_allows_a_new_episode_after_normal_hour() {
        let mut db = db();
        reading(&db, "2026-10-11 10:00:00", Some(2.0));
        let mut event = observe(&mut db, parse("2026-10-11 10:00:00").unwrap(), true)
            .unwrap()
            .unwrap();
        event.status = "uncertain".into();
        save(&db, &event).unwrap();
        record_check_error(
            &db,
            &event.id,
            &event.name,
            "司空平台天气阻飞：在线天气风速 12.75m/s；未继续执行",
        )
        .unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "not_flown");
        reading(&db, "2026-10-11 11:00:00", Some(0.2));
        observe(&mut db, parse("2026-10-11 11:00:00").unwrap(), true).unwrap();
        assert_eq!(setting(&db, "flight_episode").unwrap().as_deref(), Some(""));
        reading(&db, "2026-10-11 12:00:00", Some(2.0));
        assert!(
            observe(&mut db, parse("2026-10-11 12:00:00").unwrap(), true)
                .unwrap()
                .is_some(),
            "Fresh episode remains blocked by previous not_flown event"
        );
    }

    #[test]
    fn weather_blocked_task_can_follow_manual_platform_confirmation() {
        let db = db();
        let mut event = new_event("2026-10-11 14:00:00".into(), Some(2.), false);
        event.status = "submitting".into();
        save(&db, &event).unwrap();
        let receipt = "司空平台天气阻飞：在线天气风速 12.75m/s；未继续执行";
        apply_submission_result(&db, &event.id, &event.name, Err(receipt.into())).unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "not_flown");
        apply_observation(&db, &event.id, &event.name, "待执行").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().status, "submitted");
        assert!(current(&db).unwrap().unwrap().status_check_error.is_none());
    }

    #[test]
    fn ready_and_exception_tracking_survives_restart_but_never_polls_previews() {
        let db = db();
        for status in ["ready", "flight_error"] {
            let mut event = new_event("2026-10-11 10:00:00".into(), Some(2.), false);
            event.status = status.into();
            save(&db, &event).unwrap();
            recover(&db).unwrap();
            assert!(trackable(&current(&db).unwrap().unwrap()));
            handle_unmatched_status(&db, &event.id, &event.name).unwrap();
            assert_eq!(current(&db).unwrap().unwrap().status, status);
            apply_observation(&db, &event.id, &event.name, "待执行").unwrap();
            assert_eq!(current(&db).unwrap().unwrap().status, "submitted");
            for (platform, expected) in [
                ("执行中", "flying"),
                ("已暂停", "paused"),
                ("执行中", "flying"),
                ("执行成功", "completed"),
            ] {
                apply_observation(&db, &event.id, &event.name, platform).unwrap();
                assert_eq!(current(&db).unwrap().unwrap().status, expected);
            }
        }
        let mut preview = begin_manual(&db, true).unwrap();
        preview.status = "ready".into();
        save(&db, &preview).unwrap();
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
            event.status = status.into();
            event.error = Some("原始回执".into());
            event
                .weather_checks
                .push(recorded_weather("preparation", true, false));
            save(&db, &event).unwrap();
            assert!(close_reviewed(&db, &event.id, status, false).is_err());
            assert!(close_reviewed(&db, "stale-id", status, true).is_err());
            assert!(close_reviewed(&db, &event.id, "submitting", true).is_err());
            close_reviewed(&db, &event.id, status, true).unwrap();
            assert!(current(&db).unwrap().is_none());
            let archived: Event = serde_json::from_str(
                &setting(&db, &format!("flight_history:{}", event.id))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(archived.status, status);
            assert_eq!(archived.error, event.error);
            assert!(archived.resolved_at.is_some());
            assert_eq!(
                serde_json::to_value(&archived.weather_checks).unwrap(),
                serde_json::to_value(&event.weather_checks).unwrap()
            );
            // A late platform result cannot restore a closed event or overwrite a replacement.
            apply_observation(&db, &event.id, &event.name, "执行中").unwrap();
            assert!(current(&db).unwrap().is_none());
            if status != "failed" {
                reading(&db, "2026-10-11 10:00:00", Some(2.));
                assert!(
                    observe(&mut db, parse("2026-10-11 10:00:00").unwrap(), true)
                        .unwrap()
                        .is_none()
                );
            }
        }
        reading(&db, "2026-10-11 11:00:00", Some(0.2));
        observe(&mut db, parse("2026-10-11 11:00:00").unwrap(), true).unwrap();
        reading(&db, "2026-10-11 12:00:00", Some(2.));
        assert!(
            observe(&mut db, parse("2026-10-11 12:00:00").unwrap(), true)
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn closure_cannot_bypass_known_active_flight_or_a_changed_status() {
        let db = db();
        for status in [
            "countdown",
            "preparing",
            "submitting",
            "submitted",
            "uncertain",
            "flying",
            "paused",
        ] {
            let mut event = new_event("2026-10-11 10:00:00".into(), Some(2.), false);
            event.status = status.into();
            save(&db, &event).unwrap();
            assert!(close_reviewed(&db, &event.id, status, true).is_err());
            assert!(close_reviewed(&db, &event.id, "ready", true).is_err());
            assert!(close_reviewed(&db, &event.id, "failed", true).is_err());
            assert_eq!(current(&db).unwrap().unwrap().status, status);
            assert!(setting(&db, &format!("flight_history:{}", event.id))
                .unwrap()
                .is_none());
        }
    }
    #[test]
    fn replacement_archive_and_new_event_commit_or_rollback_together() {
        let db = db();
        let mut previous = begin_manual(&db, false).unwrap();
        previous.status = "canceled".into();
        previous
            .weather_checks
            .push(recorded_weather("preparation", true, false));
        save(&db, &previous).unwrap();
        db.execute_batch(
            "CREATE TRIGGER reject_replacement BEFORE UPDATE ON monitor_settings
            WHEN NEW.key='flight_event' BEGIN SELECT RAISE(ABORT, 'write failure'); END;",
        )
        .unwrap();
        assert!(begin_manual(&db, false).is_err());
        assert_eq!(current(&db).unwrap().unwrap().id, previous.id);
        assert!(setting(&db, &format!("flight_history:{}", previous.id))
            .unwrap()
            .is_none());
        db.execute_batch("DROP TRIGGER reject_replacement").unwrap();
        let next = begin_manual(&db, false).unwrap();
        let history: Event = serde_json::from_str(
            &setting(&db, &format!("flight_history:{}", previous.id))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(history.status, "canceled");
        assert_eq!(history.weather_checks.len(), 1);
        apply_observation(&db, &previous.id, &previous.name, "执行成功").unwrap();
        assert_eq!(current(&db).unwrap().unwrap().id, next.id);
    }

    #[test]
    fn prefix_route_distance_handles_unicode_exact_matches_and_ambiguity() {
        let route = |name: &str, id: &str| FlightRoute {name:name.into(), route_id:id.into(), update_time:0, ..Default::default() };
        let routes = vec![route("北侧航线-副本(123)", "1"), route("北侧航线-副本(1)", "2")];
        assert_eq!(best_route_match(&routes, " 北侧 航线 ").unwrap().as_deref(), Some("北侧航线-副本(1)"));
        assert_eq!(best_route_match(&routes, "北侧航线-副本(123)").unwrap().as_deref(), Some("北侧航线-副本(123)"));
        assert!(best_route_match(&routes, "南侧航线").unwrap().is_none());
        assert!(best_route_match(&routes, "").unwrap().is_none());
        let tied = vec![route("北侧航线-副本(1)", "1"),route("北侧航线-副本(2)", "2")];
        assert!(best_route_match(&tied, "北侧航线").unwrap_err().contains("差异相同"));
        let duplicate = vec![route("北侧航线", "1"),route("北侧航线", "2")];
        assert!(best_route_match(&duplicate, "北侧航线").is_err());
        assert!(exact_route_match(&duplicate, "北侧航线").is_err());
        let db = db();
        put(&db, "flight_routes", &serde_json::to_string(&duplicate).unwrap()).unwrap();
        put(&db, "flight_route", "北侧航线").unwrap();
        assert!(selected_route(&db).unwrap().is_none());
        assert!(route_view(&db).unwrap().selected.is_none());
        assert!(route_configuration_ready(&db).is_err());
        assert!(exact_route_match(&routes, "北侧航线").unwrap().is_none());
        let shorter = vec![route("北侧", "1"),route("北侧航线", "2")];
        assert_eq!(best_route_match(&shorter, "北侧航线-副本(1)").unwrap().as_deref(), Some("北侧航线"));
        // Count Unicode characters, not UTF-8 bytes (both suffixes add one).
        assert!(best_route_match(&[route("北侧航线甲", "1"),route("北侧航线A", "2")], "北侧航线").is_err());
        let mut settings = crate::settings::Settings::default();
        settings.wind_route_rules = vec![crate::settings::WindRouteRule {start_degrees:0.,end_degrees:90.,route:"北侧航线".into()}];
        assert!(configured_route(&settings, &tied, Some(tied[0].name.clone()), Some(45.)).is_err());
        assert_eq!(configured_route(&settings, &routes, Some(routes[0].name.clone()), Some(45.)).unwrap(), "北侧航线-副本(1)");
    }
    #[test]
    fn pm25_only_exceedance_names_both_missing_and_normal_potassium_correctly() {
        for k in [None, Some(0.5), Some(1.0)] {
            let mut db = db(); configure(&db,1.0,5,false);
            let time = "2026-10-27 10:00:00";
            reading(&db,time,k); reading_pm25(&db,time,Some(61.0));
            let event = observe(&mut db,parse(time).unwrap(),true).unwrap().unwrap();
            assert_eq!(event.name,"PM2.5超标巡查-20261027-10");
            assert_eq!(event.source_hour.as_deref(),Some(time));
        }
    }
    #[test]
    fn clearing_preserves_unresolved_flights_even_when_no_operation_is_busy() {
        let db = db();
        let mut event = new_event("2026-10-27 10:00:00".into(),Some(2.),false);
        for status in ["countdown","preparing","ready","submitting","submitted","uncertain","flying","paused","flight_error","unknown"] {
            event.status = status.into(); save(&db,&event).unwrap();
            let before = setting(&db,"flight_event").unwrap();
            assert!(require_clearable(&db).is_err(),"{status}");
            assert_eq!(setting(&db,"flight_event").unwrap(),before);
        }
        for status in ["failed","completed","canceled","dismissed","restricted","not_flown"] {
            event.status = status.into(); save(&db,&event).unwrap();
            assert!(require_clearable(&db).is_ok(),"{status}");
        }
        event.status="not_flown".into();
        event.error=Some("司空平台天气阻飞：风速过高；未继续执行".into());
        save(&db,&event).unwrap();
        assert!(require_clearable(&db).is_err(),"operator can still confirm this platform draft");
        assert!(close_reviewed(&db, &event.id, "not_flown", false).is_err());
        assert!(require_clearable(&db).is_err());
        close_reviewed(&db, &event.id, "not_flown", true).unwrap();
        assert!(require_clearable(&db).is_ok());
        let archived: Event = serde_json::from_str(&setting(&db, &format!("flight_history:{}", event.id)).unwrap().unwrap()).unwrap();
        assert_eq!(archived.error, event.error);
        assert!(archived.resolved_at.is_some());
    }
    #[test]
    fn countdown_is_kept_when_new_data_returns_to_normal() {
        let mut db=db(); configure(&db,1.,120,false);
        reading(&db,"2026-10-27 10:00:00",Some(2.));
        let event=observe(&mut db,parse("2026-10-27 10:00:00").unwrap(),true).unwrap().unwrap();
        reading(&db,"2026-10-27 11:00:00",Some(0.5));
        assert!(observe(&mut db,parse("2026-10-27 11:00:00").unwrap(),true).unwrap().is_none());
        assert_eq!(current(&db).unwrap().unwrap().launch_at,event.launch_at);
        assert_eq!(claim_due(&db,event.launch_at.unwrap(),0).unwrap().unwrap().id,event.id);
    }

}

#[cfg(test)]
mod folder_route_tests {
    use super::*;
    #[test]
    fn folder_names_disambiguate_routes_and_legacy_names_fail_closed() {
        let routes = vec![
            FlightRoute { route_id: "one".into(), name: "巡查航线".into(), folder_path: vec![RouteFolder{id:"a".into(),name:"日常巡逻".into()}], ..Default::default() },
            FlightRoute { route_id: "two".into(), name: "巡查航线".into(), folder_path: vec![RouteFolder{id:"b".into(),name:"油烟巡查".into()}], ..Default::default() },
        ];
        assert!(exact_route_match(&routes,"巡查航线").is_err());
        assert_eq!(exact_route_match(&routes,"日常巡逻 / 巡查航线").unwrap(),Some("日常巡逻 / 巡查航线".into()));
        let restored: Vec<FlightRoute> = serde_json::from_str(&serde_json::to_string(&routes).unwrap()).unwrap();
        assert_eq!(restored,routes);
    }
}
