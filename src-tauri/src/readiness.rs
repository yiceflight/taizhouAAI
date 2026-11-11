use crate::bridge::Bridge;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::Manager;

pub const MIN_VERSION: &str = env!("BRIDGE_MIN_EXTENSION_VERSION");
const MAX_AGE: Duration = Duration::from_secs(120);
const SITES: [(&str, &str); 3] = [
    ("map", "http://61.155.4.60:18080"),
    ("dji", "https://fh.dji.com"),
    ("sniff", "https://aai.airins.cn"),
];
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteHealth {
    pub id: String,
    pub state: String,
    pub message: String,
    pub checked_at: Option<String>,
    pub session: Option<String>,
    pub tab_id: Option<i64>,
    pub url: Option<String>,
}
struct Cached {
    health: SiteHealth,
    at: Instant,
}
#[derive(Default)]
pub struct Readiness {
    sites: Mutex<Vec<Cached>>,
    checking: AtomicBool,
    site_open_attempted: [AtomicBool; 3],
    pub started: AtomicBool,
}
impl Readiness {
    pub(crate) fn reset_workspace(&self) {
        self.started.store(false, Ordering::SeqCst);
        self.site_open_attempted
            .iter()
            .for_each(|attempted| attempted.store(false, Ordering::SeqCst));
    }

    fn reserve_site_open(&self, id: &str, missing: bool) -> bool {
        SITES
            .iter()
            .position(|(site, _)| *site == id)
            .is_some_and(|index| {
                missing && !self.site_open_attempted[index].swap(true, Ordering::SeqCst)
            })
    }
    fn retry_missing_sites(&self, snapshot: &crate::bridge::BridgeStatus) {
        for (index, (_, origin)) in SITES.iter().enumerate() {
            if !snapshot
                .tabs
                .iter()
                .any(|t| same_origin(&t.tab.url, origin))
            {
                self.site_open_attempted[index].store(false, Ordering::SeqCst);
            }
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub plugin_ready: bool,
    pub plugin_message: String,
    pub plugin_update_required: bool,
    pub minimum_extension_version: &'static str,
    pub checking: bool,
    pub checks: Vec<serde_json::Value>,
    pub sites: Vec<SiteHealth>,
    pub ready: bool,
    pub monitoring_ready: bool,
    pub flight_ready: bool,
    pub report_ready: bool,
    pub started: bool,
}
pub fn compatible(version: &str) -> bool {
    fn parse(value: &str) -> Option<[u16; 4]> {
        let parts: Vec<_> = value.split('.').collect();
        if !(1..=4).contains(&parts.len()) {
            return None;
        }
        let mut result = [0; 4];
        for (i, part) in parts.iter().enumerate() {
            if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            result[i] = part.parse().ok()?;
        }
        Some(result)
    }
    matches!((parse(version), parse(MIN_VERSION)), (Some(actual), Some(required)) if actual >= required)
}
fn plugin(bridge: &crate::bridge::BridgeStatus) -> (bool, String) {
    if let Some(error) = &bridge.error {
        return (false, error.clone());
    }
    if !bridge.connected {
        return (
            false,
            "未收到插件连接，请保持 Chrome 运行，并查看本机连接诊断；此状态不代表插件未安装。"
                .into(),
        );
    }
    if bridge.versions.iter().any(|v| !compatible(v)) {
        return (false, format!("浏览器插件必须更新：当前 v{}，需要 v{MIN_VERSION} 或以上。请在 Chrome 扩展管理页重新加载插件，完成前无法采集或监测。", bridge.versions.join("、v")));
    }
    if bridge.clients != 1 {
        return (
            false,
            "检测到多个 Chrome 插件会话，请只保留一个工作浏览器配置。".into(),
        );
    }
    (true, "插件已连接，版本兼容".into())
}
fn empty(id: &str, state: &str, message: &str) -> SiteHealth {
    SiteHealth {
        id: id.into(),
        state: state.into(),
        message: message.into(),
        checked_at: None,
        session: None,
        tab_id: None,
        url: None,
    }
}
fn same_origin(url: &str, origin: &str) -> bool {
    tauri::Url::parse(url).is_ok_and(|u| u.origin().ascii_serialization() == origin)
}
fn valid_jiangsu_health(raw: &serde_json::Value) -> bool {
    raw["tabId"].as_i64().is_some_and(|id| id >= 0)
        && raw["url"].as_str().is_some_and(|url| {
            same_origin(url, SITES[0].1)
                && (raw["state"] != "ready" || crate::monitoring::source_page(url))
        })
}

pub fn view(app: &tauri::AppHandle) -> View {
    let state = app.state::<Readiness>();
    let bridge = app.state::<Bridge>().status();
    let cache = state.sites.lock().unwrap();
    let mut result = evaluate(
        &bridge,
        &cache,
        state.started.load(Ordering::SeqCst),
        state.checking.load(Ordering::SeqCst),
    );
    result.checks = app.state::<Bridge>().health_checks();
    result
}
fn evaluate(
    bridge: &crate::bridge::BridgeStatus,
    cache: &[Cached],
    started: bool,
    checking: bool,
) -> View {
    let (plugin_ready, plugin_message) = plugin(bridge);
    let sites: Vec<_> = SITES
        .iter()
        .map(|(id, origin)| {
            if !plugin_ready {
                return empty(id, "blocked", "等待插件连接后检测");
            }
            if let Some(cached) = cache.iter().find(|c| c.health.id == *id) {
                // Keep the last known result visible while a fresh pass is in
                // flight. The individual site result replaces it as soon as
                // that site's request completes, so a temporary tab reload
                // cannot make a previously verified row flash to "验证中".
                if checking {
                    return cached.health.clone();
                }
                if cached.health.state == "error"
                    && cached.health.tab_id.is_none()
                    && cached.at.elapsed() < MAX_AGE
                    && !bridge.tabs.iter().any(|t| same_origin(&t.tab.url, origin))
                {
                    return cached.health.clone();
                }
                let live = bridge.tabs.iter().any(|t| {
                    Some(&t.session) == cached.health.session.as_ref()
                        && Some(t.tab.id) == cached.health.tab_id
                        && Some(&t.tab.url) == cached.health.url.as_ref()
                        && t.tab.status == "complete"
                });
                if live && cached.at.elapsed() < MAX_AGE {
                    return cached.health.clone();
                }
            }
            if bridge.tabs.iter().any(|t| same_origin(&t.tab.url, origin)) {
                empty(id, "unchecked", "等待验证登录与业务访问")
            } else {
                empty(id, "not_open", "请打开网站并完成登录")
            }
        })
        .collect();
    View {
        ready: plugin_ready && sites.iter().all(|s| s.state == "ready"),
        monitoring_ready: plugin_ready && sites.iter().any(|s| s.id == "map" && s.state == "ready"),
        flight_ready: plugin_ready && sites.iter().any(|s| s.id == "dji" && s.state == "ready"),
        report_ready: plugin_ready
            && ["dji", "sniff"]
                .iter()
                .all(|id| sites.iter().any(|s| s.id == *id && s.state == "ready")),
        plugin_ready,
        plugin_update_required: bridge.connected && bridge.versions.iter().any(|v| !compatible(v)),
        minimum_extension_version: MIN_VERSION,
        plugin_message,
        checking,
        checks: vec![],
        started,
        sites,
    }
}
pub fn require_ready(app: &tauri::AppHandle) -> Result<(), String> {
    let state = view(app);
    if !state.plugin_ready {
        return Err(state.plugin_message);
    }
    if !state.ready {
        return Err("请先完成三个网站的登录和可用性验证，再继续操作。".into());
    }
    Ok(())
}
pub fn require_started(app: &tauri::AppHandle) -> Result<(), String> {
    require_ready(app)?;
    if !app.state::<Readiness>().started.load(Ordering::SeqCst) {
        return Err("请先完成首批数据读取并开始监测。".into());
    }
    Ok(())
}
fn check_capability(
    state: &View,
    available: bool,
    started: bool,
    message: &str,
) -> Result<(), String> {
    if !state.plugin_ready {
        return Err(state.plugin_message.clone());
    }
    if !available {
        return Err(message.into());
    }
    if started && !state.started {
        return Err("请先完成首批数据读取并开始监测。".into());
    }
    Ok(())
}
pub fn require_monitoring(app: &tauri::AppHandle, started: bool) -> Result<(), String> {
    let state = view(app);
    check_capability(
        &state,
        state.monitoring_ready,
        started,
        "请先完成江苏大气站的登录和可用性验证。",
    )
}
pub fn require_flight(app: &tauri::AppHandle) -> Result<(), String> {
    let state = view(app);
    check_capability(
        &state,
        state.flight_ready,
        true,
        "请先完成司空的登录和可用性验证。",
    )
}
pub fn require_report(app: &tauri::AppHandle) -> Result<(), String> {
    let state = view(app);
    check_capability(
        &state,
        state.report_ready,
        false,
        "请先完成司空和可飞的登录和可用性验证。",
    )
}
// Photo-only reports depend on FlightHub and the bridge, not monitoring or Airins.
pub fn require_report_media(app: &tauri::AppHandle) -> Result<(), String> {
    check_report_media(view(app))
}
fn check_report_media(state: View) -> Result<(), String> {
    if !state.plugin_ready {
        return Err(state.plugin_message);
    }
    if !state
        .sites
        .iter()
        .any(|site| site.id == "dji" && site.state == "ready")
    {
        return Err("请先登录司空媒体库并完成可用性验证。".into());
    }
    Ok(())
}
pub async fn refresh(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Readiness>();
    if state.checking.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    struct Guard<'a>(&'a AtomicBool);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = Guard(&state.checking);
    let bridge = app.state::<Bridge>();
    let snapshot = bridge.status();
    if !plugin(&snapshot).0 {
        state.sites.lock().unwrap().clear();
        return Ok(());
    }
    tokio::join!(
        check_site(app, &snapshot, SITES[0]),
        check_site(app, &snapshot, SITES[1]),
        check_site(app, &snapshot, SITES[2]),
    );
    Ok(())
}
async fn check_site(
    app: &tauri::AppHandle,
    snapshot: &crate::bridge::BridgeStatus,
    (id, origin): (&str, &str),
) {
    let state = app.state::<Readiness>();
    let bridge = app.state::<Bridge>();
    // Prefer the required business page over an unrelated/login tab.
    let mut tabs: Vec<_> = snapshot
        .tabs
        .iter()
        .filter(|t| same_origin(&t.tab.url, origin) && (t.tab.status == "complete" || t.tab.status == "unloaded"))
        .collect();
    tabs.sort_by_key(|t| {
        (
            !t.tab.url.contains(match id {
                "map" => "time-series",
                "dji" => "c7ea6bbc-110d-4dc9-ac75-4653ebbbca49",
                _ => "/sniff",
            }),
            t.tab.id,
        )
    });
    let has_tab = snapshot
        .tabs
        .iter()
        .any(|t| same_origin(&t.tab.url, origin));
    let open_missing = state.reserve_site_open(id, !has_tab);
    let target = if let Some(tab) = tabs.first() {
        Some((tab.session.clone(), tab.tab.id, Some(tab.tab.url.clone())))
    } else if open_missing {
        bridge
            .single_session()
            .ok()
            .map(|session| (session, -1, None))
    } else {
        None
    };
    let health = if let Some((session, tab_id, expected_url)) = target {
        let result = bridge
            .request(
                session.clone(),
                tab_id,
                json!({"type": match id {
                    "map" => "jiangsu-health",
                    "sniff" if open_missing => "airins-health-open",
                    "dji" if open_missing => "dji-health-open",
                    _ => "site-health",
                }}),
            )
            .await;
        let mut health = empty(
            id,
            "error",
            if open_missing {
                "无法在后台打开或验证网站，请检查网络后重新验证，或手动打开网站"
            } else {
                "检测失败，请检查网站登录或网络后重新验证"
            },
        );
        health.url = expected_url.clone();
        health.tab_id = (tab_id >= 0).then_some(tab_id);
        if let Err(error) = &result {
            health.message = error.chars().take(300).collect();
        }
        if let Ok(raw) = result {
            let actual_url = raw["url"].as_str();
            let valid_url = if id == "map" {
                valid_jiangsu_health(&raw)
            } else if let Some(expected) = &expected_url {
                actual_url == Some(expected.as_str())
            } else {
                actual_url.is_some_and(|url| same_origin(url, origin))
                    && raw["tabId"].as_i64().is_some_and(|id| id >= 0)
            };
            if valid_url {
                if let (Some(status), Some(message)) =
                    (raw["state"].as_str(), raw["message"].as_str())
                {
                    if [
                        "ready",
                        "login_required",
                        "forbidden",
                        "page_required",
                        "error",
                    ]
                    .contains(&status)
                    {
                        health.state = status.into();
                        health.message = message.chars().take(180).collect();
                    }
                }
                health.url = actual_url.map(str::to_owned);
                health.tab_id = if open_missing || id == "map" {
                    raw["tabId"].as_i64()
                } else {
                    Some(tab_id)
                };
            }
        }
        health.checked_at = Some(
            crate::monitoring::now()
                .format("%Y-%m-%d %H:%M:%S")
                .to_string(),
        );
        health.session = Some(session);
        health
    } else if has_tab {
        empty(id, "unchecked", "网站正在加载，完成后自动验证")
    } else {
        // Keep a failed background-open attempt actionable across automatic
        // rechecks; only an explicit retry or a newly opened tab replaces it.
        state
            .sites
            .lock()
            .unwrap()
            .iter()
            .find(|cached| {
                cached.health.id == id
                    && cached.health.state == "error"
                    && cached.health.tab_id.is_none()
            })
            .map(|cached| cached.health.clone())
            .unwrap_or_else(|| empty(id, "not_open", "请打开网站并完成登录，等待页面加载完成"))
    };
    let mut cache = state.sites.lock().unwrap();
    cache.retain(|c| c.health.id != id);
    cache.push(Cached {
        health,
        at: Instant::now(),
    });
}
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut next_check = Instant::now();
        loop {
            let current = view(&app);
            if !current.plugin_ready {
                app.state::<Readiness>().sites.lock().unwrap().clear();
                // Do not put a newly connected plugin behind a 45-second timer.
                next_check = Instant::now();
            } else if Instant::now() >= next_check
                    || current.sites.iter().any(|s| s.state == "unchecked")
            {
                let _ = refresh(&app).await;
                // A site check can take up to ~35 seconds while a background
                // page loads and its authenticated API is read. Retrying a
                // not-yet-ready workspace every 10 seconds needlessly starts
                // another verification pass and makes the UI oscillate.
                next_check = Instant::now()
                    + Duration::from_secs(if view(&app).ready { 45 } else { 30 });
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}
#[tauri::command]
pub fn get_readiness(app: tauri::AppHandle) -> View {
    view(&app)
}
#[tauri::command]
pub async fn check_readiness(app: tauri::AppHandle) -> Result<View, String> {
    let state = app.state::<Readiness>();
    if !state.checking.load(Ordering::SeqCst) {
        state.retry_missing_sites(&app.state::<Bridge>().status());
    }
    refresh(&app).await?;
    Ok(view(&app))
}
#[tauri::command]
pub async fn start_workspace(app: tauri::AppHandle) -> Result<(), String> {
    crate::runtime_log::record(
        &app,
        "info",
        "app",
        "workspace.start_requested",
        "开始启动监测工作台",
        serde_json::json!({}),
    );
    let result = start_workspace_inner(&app).await;
    crate::runtime_log::record(
        &app,
        if result.is_ok() { "info" } else { "error" },
        "app",
        "workspace.start_finished",
        if result.is_ok() {
            "监测工作台已启动"
        } else {
            "监测工作台启动失败"
        },
        serde_json::json!({"error":result.as_ref().err()}),
    );
    result
}
async fn start_workspace_inner(app: &tauri::AppHandle) -> Result<(), String> {
    let _access = crate::data_reset::access(&app)?;
    require_monitoring(app, false)?;
    // First read cannot trigger an automatic flight preparation.
    crate::monitoring::verify_first_sync(app).await?;
    require_monitoring(app, false)?;
    crate::monitoring::set_monitoring_enabled(app.clone(), true)?;
    app.state::<Readiness>()
        .started
        .store(true, Ordering::SeqCst);
    crate::flight::after_sync(app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jiangsu_health_accepts_authenticated_routes_and_tracks_the_verified_tab() {
        let mut raw = json!({"url": crate::monitoring::SOURCE_URL, "tabId": 17, "state": "ready"});
        assert!(valid_jiangsu_health(&raw));
        raw["url"] = json!("http://61.155.4.60:18080/#/home/map");
        assert!(valid_jiangsu_health(&raw));
        raw["url"] = json!("http://61.155.4.60:18080/#/login");
        assert!(!valid_jiangsu_health(&raw));
        raw["state"] = json!("login_required");
        raw["url"] = json!("http://61.155.4.60:18080/#/login");
        assert!(valid_jiangsu_health(&raw));
        raw["url"] = json!("http://61.155.4.60.evil.test:18080/#/login");
        assert!(!valid_jiangsu_health(&raw));
        raw["url"] = json!(crate::monitoring::SOURCE_URL);
        raw["tabId"] = json!(-1);
        assert!(!valid_jiangsu_health(&raw));
        let (mut bridge, mut cache) = fixture();
        cache[0].health.url = Some(crate::monitoring::SOURCE_URL.into());
        cache[0].health.tab_id = Some(17);
        assert!(!evaluate(&bridge, &cache, false, false).ready);
        bridge.tabs[0].tab.id = 17;
        bridge.tabs[0].tab.url = crate::monitoring::SOURCE_URL.into();
        assert!(evaluate(&bridge, &cache, false, false).ready);
    }
    #[test]
    fn version_and_origin_are_exact() {
        assert!(compatible(MIN_VERSION));
        assert!(compatible("0.10.0"));
        for v in [
            "0.6.0",
            "0.5.9",
            "invalid",
            "0.6.0-beta",
            "0.6.0.0.1",
            "0.70000.0",
        ] {
            assert!(!compatible(v));
        }
        assert!(same_origin("https://fh.dji.com/path", "https://fh.dji.com"));
        assert!(!same_origin(
            "https://fh.dji.com.evil.test/path",
            "https://fh.dji.com"
        ));
    }
    #[test]
    fn missing_sites_are_opened_once_each_and_loading_tabs_do_not_consume_attempts() {
        let state = Readiness::default();
        for (id, _) in SITES {
            assert!(!state.reserve_site_open(id, false));
            assert!(state.reserve_site_open(id, true));
            assert!(!state.reserve_site_open(id, true));
        }
        assert!(!state.reserve_site_open("unknown", true));
    }
    #[test]
    fn manual_retry_only_resets_attempts_for_missing_sites() {
        let state = Readiness::default();
        for (id, _) in SITES {
            assert!(state.reserve_site_open(id, true));
        }
        let (mut bridge, _) = fixture();
        bridge.tabs.remove(0);
        state.retry_missing_sites(&bridge);
        assert!(state.reserve_site_open("map", true));
        assert!(!state.reserve_site_open("dji", true));
        assert!(!state.reserve_site_open("sniff", true));
    }
    #[test]
    fn background_open_failure_remains_visible_until_a_tab_appears() {
        let (mut bridge, mut cache) = fixture();
        bridge.tabs.remove(2);
        cache[2].health.state = "error".into();
        cache[2].health.message = "后台打开失败".into();
        cache[2].health.tab_id = None;
        cache[2].health.url = None;
        assert_eq!(
            evaluate(&bridge, &cache, false, false).sites[2].state,
            "error"
        );
        bridge.tabs.push(crate::bridge::TabStatus {
            session: "session".into(),
            tab: crate::bridge::BrowserTab {
                id: 3,
                title: "Airins".into(),
                url: "https://aai.airins.cn/sniff/HistoryCloud".into(),
                status: "complete".into(),
            },
        });
        assert_eq!(
            evaluate(&bridge, &cache, false, false).sites[2].state,
            "unchecked"
        );
    }
    fn fixture() -> (crate::bridge::BridgeStatus, Vec<Cached>) {
        let tabs: Vec<_> = SITES
            .iter()
            .enumerate()
            .map(|(i, (_, origin))| crate::bridge::TabStatus {
                session: "session".into(),
                tab: crate::bridge::BrowserTab {
                    id: i as i64,
                    title: "page".into(),
                    url: format!("{origin}/business"),
                    status: "complete".into(),
                },
            })
            .collect();
        let cache = SITES
            .iter()
            .zip(tabs.iter())
            .map(|((id, _), tab)| {
                let mut health = empty(id, "ready", "verified");
                health.session = Some(tab.session.clone());
                health.tab_id = Some(tab.tab.id);
                health.url = Some(tab.tab.url.clone());
                Cached {
                    health,
                    at: Instant::now(),
                }
            })
            .collect();
        (
            crate::bridge::BridgeStatus {
                connected: true,
                clients: 1,
                versions: vec![MIN_VERSION.into()],
                tabs,
                error: None,
            },
            cache,
        )
    }
    #[test]
    fn photo_only_report_requires_only_verified_flight_hub_and_compatible_plugin() {
        let (mut bridge, mut cache) = fixture();
        bridge
            .tabs
            .retain(|tab| tab.tab.url.starts_with("https://fh.dji.com"));
        cache.retain(|entry| entry.health.id == "dji");
        assert!(!evaluate(&bridge, &cache, false, false).ready);
        assert!(check_report_media(evaluate(&bridge, &cache, false, false)).is_ok());
        cache[0].health.state = "login_required".into();
        assert!(check_report_media(evaluate(&bridge, &cache, false, false)).is_err());
        cache[0].health.state = "ready".into();
        bridge.versions = vec!["0.5.0".into()];
        assert!(check_report_media(evaluate(&bridge, &cache, false, false)).is_err());
    }
    #[test]
    fn site_outages_only_block_dependent_capabilities_and_recover() {
        let (bridge, mut cache) = fixture();
        for missing in ["sniff", "dji", "map"] {
            for cached in &mut cache {
                cached.health.state = if cached.health.id == missing {
                    "login_required"
                } else {
                    "ready"
                }
                .into();
            }
            let state = evaluate(&bridge, &cache, true, false);
            assert!(!state.ready);
            assert_eq!(state.monitoring_ready, missing != "map");
            assert_eq!(state.flight_ready, missing != "dji");
            assert_eq!(state.report_ready, missing == "map");
            assert_eq!(
                check_capability(&state, state.monitoring_ready, true, "map").is_ok(),
                missing != "map"
            );
            assert_eq!(
                check_capability(&state, state.flight_ready, true, "dji").is_ok(),
                missing != "dji"
            );
            assert!(state.started);
        }
        for cached in &mut cache {
            cached.health.state = "ready".into();
        }
        let state = evaluate(&bridge, &cache, false, false);
        assert!(check_capability(&state, state.monitoring_ready, false, "map").is_ok());
        assert!(check_capability(&state, state.flight_ready, true, "dji").is_err());
        let state = evaluate(&bridge, &cache, true, false);
        assert!(state.ready && state.monitoring_ready && state.flight_ready && state.report_ready);
    }
    #[test]
    fn gates_all_sites_and_preserves_started_on_loss_for_recovery() {
        let (mut bridge, mut cache) = fixture();
        assert!(evaluate(&bridge, &cache, true, false).ready);
        cache[1].health.state = "login_required".into();
        let view = evaluate(&bridge, &cache, true, false);
        assert!(!view.ready);
        assert!(view.started);
        cache[1].health.state = "ready".into();
        bridge.tabs[1].tab.url.push_str("#/login");
        assert!(!evaluate(&bridge, &cache, true, false).ready);
        bridge.tabs.remove(1);
        assert_eq!(
            evaluate(&bridge, &cache, true, false).sites[1].state,
            "not_open"
        );
    }
    #[test]
    fn rejects_stale_checks_reloads_and_browser_session_replacement() {
        let (mut bridge, mut cache) = fixture();
        // A fresh pass must not make an already verified row flash to an
        // indeterminate state while its request is still in flight.
        let checking = evaluate(&bridge, &cache, false, true);
        assert!(checking.sites.iter().all(|site| site.state == "ready"));
        cache[0].at = Instant::now() - MAX_AGE;
        assert!(!evaluate(&bridge, &cache, false, false).ready);
        cache[0].at = Instant::now();
        bridge.tabs[0].tab.status = "loading".into();
        assert!(!evaluate(&bridge, &cache, false, false).ready);
        bridge.tabs[0].tab.status = "complete".into();
        bridge.tabs[0].session = "different-profile".into();
        assert!(!evaluate(&bridge, &cache, false, false).ready);
    }
    #[test]
    fn plugin_loss_conflict_or_old_version_cannot_reuse_cached_success() {
        let (mut bridge, cache) = fixture();
        bridge.connected = false;
        assert!(!evaluate(&bridge, &cache, true, false).ready);
        bridge.connected = true;
        bridge.clients = 2;
        assert!(!evaluate(&bridge, &cache, true, false).ready);
        bridge.clients = 1;
        bridge.versions = vec!["0.5.0".into()];
        let view = evaluate(&bridge, &cache, true, false);
        assert!(!view.ready);
        assert!(view.plugin_update_required);
        assert_eq!(view.minimum_extension_version, MIN_VERSION);
        bridge.versions = vec![MIN_VERSION.into()];
        let view = evaluate(&bridge, &cache, true, false);
        assert!(view.ready);
        assert!(!view.plugin_update_required);
        bridge.error = Some("port in use".into());
        assert!(!evaluate(&bridge, &cache, true, false).ready);
    }
}
