use axum::{
    extract::Request,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;
use uuid::Uuid;

pub(crate) const ORIGIN: &str = if tauri::is_dev() {
    env!("BRIDGE_DEV_ORIGIN")
} else {
    env!("BRIDGE_PROD_ORIGIN")
};
pub(crate) const ADDRESS: &str = if tauri::is_dev() {
    env!("BRIDGE_DEV_ADDRESS")
} else {
    env!("BRIDGE_PROD_ADDRESS")
};
const TTL: Duration = Duration::from_secs(75);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: i64,
    pub title: String,
    pub url: String,
    pub status: String,
}
#[derive(Deserialize)]
struct Heartbeat {
    session: String,
    version: String,
    tabs: Vec<BrowserTab>,
}
struct Client {
    version: String,
    tabs: Vec<BrowserTab>,
    last_seen: Instant,
}
struct Pending {
    session: String,
    tab_id: i64,
    sent: bool,
    job: Value,
    result: oneshot::Sender<Result<Value, String>>,
}
#[derive(Default)]
struct Inner {
    clients: HashMap<String, Client>,
    pending: HashMap<String, Pending>,
    error: Option<String>,
    instance_id: String,
}
#[derive(Clone)]
pub struct Bridge(Arc<Mutex<Inner>>);
impl Default for Bridge {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Inner {
            instance_id: Uuid::new_v4().to_string(),
            ..Inner::default()
        })))
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabStatus {
    pub session: String,
    #[serde(flatten)]
    pub tab: BrowserTab,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub connected: bool,
    pub clients: usize,
    pub versions: Vec<String>,
    pub tabs: Vec<TabStatus>,
    pub error: Option<String>,
}

pub fn allowed_url(value: &str) -> bool {
    // Parse through the browser-compatible URL parser; reject lookalike hosts and ports.
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    matches!(
        (url.scheme(), url.host_str(), url.port_or_known_default()),
        ("http", Some("61.155.4.60"), Some(18080))
            | ("https", Some("fh.dji.com"), Some(443))
            | ("https", Some("aai.airins.cn"), Some(443))
    )
}
fn authorized(headers: &HeaderMap) -> bool {
    headers.get("origin").and_then(|h| h.to_str().ok()) == Some(ORIGIN)
        && headers.get("host").and_then(|h| h.to_str().ok()) == Some(ADDRESS)
        && headers
            .get("x-taizhou-bridge")
            .and_then(|h| h.to_str().ok())
            == Some("1")
}
async fn cors(request: Request, next: Next) -> Response {
    let trusted = request
        .headers()
        .get("origin")
        .and_then(|h| h.to_str().ok())
        == Some(ORIGIN)
        && request.headers().get("host").and_then(|h| h.to_str().ok()) == Some(ADDRESS);
    if !trusted {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = if request.method() == axum::http::Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    response
        .headers_mut()
        .insert("access-control-allow-origin", ORIGIN.parse().unwrap());
    response.headers_mut().insert(
        "access-control-allow-methods",
        "POST, OPTIONS".parse().unwrap(),
    );
    response.headers_mut().insert(
        "access-control-allow-headers",
        "content-type, x-taizhou-bridge".parse().unwrap(),
    );
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}
fn prune(inner: &mut Inner) {
    inner
        .clients
        .retain(|_, client| client.last_seen.elapsed() < TTL);
}
async fn heartbeat(
    State(bridge): State<Bridge>,
    headers: HeaderMap,
    Json(input): Json<Heartbeat>,
) -> Result<Json<Value>, StatusCode> {
    if !authorized(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    if Uuid::parse_str(&input.session).is_err()
        || input.version.len() > 32
        || input.tabs.len() > 100
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut inner = bridge.0.lock().unwrap();
    prune(&mut inner);
    if inner.clients.len() >= 8 && !inner.clients.contains_key(&input.session) {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    let tabs = input
        .tabs
        .into_iter()
        .filter(|tab| {
            tab.id >= 0 && allowed_url(&tab.url) && tab.url.len() < 8192 && tab.title.len() < 4096
        })
        .collect();
    inner.clients.insert(
        input.session.clone(),
        Client {
            version: input.version.clone(),
            tabs,
            last_seen: Instant::now(),
        },
    );
    // Keep old-version heartbeats visible so the UI can explain the required
    // upgrade, but never deliver previously queued work to that version.
    if !crate::readiness::compatible(&input.version) {
        inner
            .pending
            .retain(|_, pending| pending.session != input.session);
        return Ok(Json(
            json!({ "ok": true, "jobs": [], "updateRequired": true,
            "minimumExtensionVersion": crate::readiness::MIN_VERSION }),
        ));
    }
    let jobs: Vec<Value> = inner
        .pending
        .iter_mut()
        .filter(|(_, p)| p.session == input.session && !p.sent)
        .map(|(id, p)| {
            p.sent = true;
            {
                let mut job = p.job.clone();
                job["id"] = json!(id);
                job["tabId"] = json!(p.tab_id);
                job
            }
        })
        .collect();
    Ok(Json(json!({ "ok": true, "jobs": jobs })))
}

// Read-only probe: never register a browser session or deliver queued jobs.
async fn diagnose(
    State(bridge): State<Bridge>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    if !authorized(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(Json(json!({"instanceId": bridge.instance_id()})))
}
#[derive(Deserialize)]
struct Completion {
    session: String,
    id: String,
    data: Option<Value>,
    error: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelFlight {
    event_id: String,
}
async fn complete(
    State(bridge): State<Bridge>,
    headers: HeaderMap,
    Json(input): Json<Completion>,
) -> Result<Json<Value>, StatusCode> {
    if !authorized(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut inner = bridge.0.lock().unwrap();
    if !inner
        .pending
        .get(&input.id)
        .is_some_and(|p| p.session == input.session && p.sent)
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let pending = inner.pending.remove(&input.id).unwrap();
    let result = match (input.data, input.error) {
        (_, Some(error)) => Err(error.chars().take(500).collect()),
        (Some(data), None) => Ok(data),
        _ => Err("插件未返回采集数据。".into()),
    };
    let _ = pending.result.send(result);
    Ok(Json(json!({ "ok": true })))
}
impl Bridge {
    pub fn start(&self, app: tauri::AppHandle) {
        let bridge = self.clone();
        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::bind(ADDRESS).await {
                Ok(listener) => listener,
                Err(error) => {
                    let advice = if error.kind() == std::io::ErrorKind::AddrInUse {
                        "端口已被占用，请检查是否重复运行客户端或有其他程序占用此端口。"
                    } else {
                        "请运行本机连接诊断，检查系统权限或安全软件的拦截记录。"
                    };
                    bridge.0.lock().unwrap().error = Some(format!(
                        "本地连接端口 {ADDRESS} 无法启动：{error}。{advice}"
                    ));
                    return;
                }
            };
            let router = Router::new()
                .route("/diagnose", post(diagnose))
                .route("/heartbeat", post(heartbeat))
                .route("/complete", post(complete))
                .route("/cancel-flight", post(move |headers: HeaderMap, Json(input): Json<CancelFlight>| {
                    let app = app.clone();
                    async move {
                        if !authorized(&headers) { return Err(StatusCode::FORBIDDEN); }
                        crate::flight::cancel_flight(app, input.event_id).map_err(|_| StatusCode::CONFLICT)?;
                        Ok::<_, StatusCode>(Json(json!({"ok":true})))
                    }
                }))
                .layer(DefaultBodyLimit::max(24 * 1024 * 1024))
                .layer(middleware::from_fn(cors))
                .with_state(bridge.clone());
            if let Err(error) = axum::serve(listener, router).await {
                bridge.0.lock().unwrap().error = Some(format!("本地连接服务停止：{error}"));
            }
        });
    }
    pub fn busy(&self) -> bool {
        !self.0.lock().unwrap().pending.is_empty()
    }
    pub(crate) fn instance_id(&self) -> String {
        self.0.lock().unwrap().instance_id.clone()
    }
    pub fn status(&self) -> BridgeStatus {
        let mut inner = self.0.lock().unwrap();
        prune(&mut inner);
        BridgeStatus {
            connected: !inner.clients.is_empty(),
            clients: inner.clients.len(),
            versions: inner.clients.values().map(|c| c.version.clone()).collect(),
            tabs: inner
                .clients
                .iter()
                .flat_map(|(session, c)| {
                    c.tabs.iter().map(move |tab| TabStatus {
                        session: session.clone(),
                        tab: tab.clone(),
                    })
                })
                .collect(),
            error: inner.error.clone(),
        }
    }
    pub fn single_session(&self) -> Result<String, String> {
        let mut inner = self.0.lock().unwrap();
        prune(&mut inner);
        let sessions: Vec<_> = inner
            .clients
            .iter()
            .filter(|(_, client)| crate::readiness::compatible(&client.version))
            .map(|(session, _)| session.clone())
            .collect();
        if sessions.len() != 1 {
            return Err(format!(
                "请连接且仅保留一个 v{} 或以上 Chrome 桥接插件会话。",
                crate::readiness::MIN_VERSION
            ));
        }
        Ok(sessions[0].clone())
    }
    pub async fn capture(&self, session: String, tab_id: i64) -> Result<Value, String> {
        self.request(session, tab_id, json!({"type": "capture"}))
            .await
    }
    pub fn hourly_target(&self, verified: &crate::readiness::SiteHealth) -> Result<(String, i64), String> {
        let mut inner = self.0.lock().unwrap();
        prune(&mut inner);
        let mut targets: Vec<_> = inner
            .clients
            .iter()
            .flat_map(|(session, client)| {
                client
                    .tabs
                    .iter()
                    .filter(move |tab| {
                        crate::readiness::compatible(&client.version)
                            && tab.status == "complete"
                            && crate::monitoring::source_page(&tab.url)
                            && verified.state == "ready"
                            && verified.session.as_deref() == Some(session.as_str())
                            && verified.tab_id == Some(tab.id)
                            && verified.url.as_deref() == Some(tab.url.as_str())
                    })
                    .map(move |tab| (session.clone(), tab.id))
            })
            .collect();
        targets.sort();
        targets.into_iter().next().ok_or_else(|| {
            format!(
                "请连接 v{} 或以上插件并完成江苏大气站登录，系统会直接验证数据接口；如持续未就绪，请重新验证。",
                crate::readiness::MIN_VERSION
            )
        })
    }
    pub async fn prepare_flight(&self, event_id: &str, name: &str, auto_submit: bool) -> Result<Value, String> {
        self.flight_job(event_id, name, false, auto_submit).await
    }
    pub async fn submit_flight(&self, event_id: &str, name: &str) -> Result<Value, String> {
        self.flight_job(event_id, name, true, false).await
    }
    pub async fn flight_status(&self, event_id: &str, name: &str) -> Result<Value, String> {
        let session = {
            let mut inner = self.0.lock().unwrap();
            prune(&mut inner);
            let sessions: Vec<_> = inner.clients.iter().filter(|(_, client)| crate::readiness::compatible(&client.version)).map(|(id, _)| id.clone()).collect();
            if sessions.len() != 1 { return Err("请连接唯一的兼容 Chrome 插件以读取司空任务状态。".into()); }
            sessions[0].clone()
        };
        if event_id.is_empty() || name.is_empty() { return Err("司空任务状态参数无效。".into()); }
        self.request(session, -1, json!({"type":"dji-status","eventId":event_id,"name":name,"submit":false})).await
    }
    async fn flight_job(&self, event_id: &str, name: &str, submit: bool, auto_submit: bool) -> Result<Value, String> {
        let session = {
            let mut inner = self.0.lock().unwrap();
            prune(&mut inner);
            let mut sessions: Vec<_> = inner
                .clients
                .iter()
                .filter(|(_, client)| crate::readiness::compatible(&client.version))
                .map(|(id, _)| id.clone())
                .collect();
            sessions.sort();
            if sessions.len() != 1 {
                return Err(format!(
                    "请连接且仅保留一个 v{} 或以上 Chrome 桥接插件会话。",
                    crate::readiness::MIN_VERSION
                ));
            }
            sessions.remove(0)
        };
        self.request(
            session,
            -1,
            json!({"type": if submit { "dji-submit" } else { "dji-prepare" }, "eventId":event_id, "name":name, "submit":submit, "autoSubmit":auto_submit}),
        )
        .await
    }
    pub async fn request(&self, session: String, tab_id: i64, job: Value) -> Result<Value, String> {
        let timeout = if ["site-health", "jiangsu-health", "airins-health-open", "dji-health-open"]
            .iter()
            .any(|kind| job["type"] == *kind)
        {
            // Checks share one heartbeat and execute serially. Include both
            // background page preparation and the read-only API checks.
            120
        } else {
            100
        };
        let (tx, rx) = oneshot::channel();
        let id = Uuid::new_v4().to_string();
        {
            let mut inner = self.0.lock().unwrap();
            prune(&mut inner);
            if inner.pending.len() >= 8 {
                return Err("采集任务过多，请稍后重试。".into());
            }
            let client = inner
                .clients
                .get(&session)
                .ok_or("插件未连接，请打开 Chrome 并重新加载插件。")?;
            if !crate::readiness::compatible(&client.version) {
                return Err(format!("浏览器插件必须更新：当前 v{}，需要 v{} 或以上。请在 Chrome 扩展管理页重新加载插件。", client.version, crate::readiness::MIN_VERSION));
            }
            if job["type"] != "dji-prepare"
                && job["type"] != "dji-submit"
                && job["type"] != "dji-open-prepared"
                && job["type"] != "dji-status"
                && job["type"] != "airins-realtime"
                && job["type"] != "airins-health-open"
                && job["type"] != "dji-health-open"
                && job["type"] != "jiangsu-health"
            {
                let tab = client
                    .tabs
                    .iter()
                    .find(|tab| tab.id == tab_id)
                    .ok_or("页面已关闭，请刷新数据源列表。")?;
                if tab.status != "complete" {
                    return Err("页面尚未加载完成，请稍后重试。".into());
                }
            } else if (job["type"] == "airins-health-open" || job["type"] == "dji-health-open")
                && (tab_id != -1 || job.as_object().is_none_or(|value| value.len() != 1))
            {
                return Err("后台网站验证任务参数无效。".into());
            } else if job["type"] == "jiangsu-health"
                && (tab_id < -1 || job.as_object().is_none_or(|value| value.len() != 1))
            {
                return Err("江苏大气站验证任务参数无效。".into());
            } else if job["type"] != "airins-realtime"
                && job["type"] != "airins-health-open"
                && job["type"] != "dji-health-open"
                && job["type"] != "jiangsu-health"
                && (tab_id != -1 || job["submit"] != (job["type"] == "dji-submit"))
            {
                return Err("司空任务类型与提交标记不匹配。".into());
            }
            inner.pending.insert(
                id.clone(),
                Pending {
                    session,
                    tab_id,
                    sent: false,
                    job,
                    result: tx,
                },
            );
        }
        let result = tokio::time::timeout(Duration::from_secs(timeout), rx).await;
        self.0.lock().unwrap().pending.remove(&id);
        match result {
            Ok(Ok(value)) => value,
            Ok(Err(_)) => Err("采集连接已中断。".into()),
            Err(_) => Err("采集超时，请确认 Chrome 正在运行、插件已重新加载，并重试。".into()),
        }
    }
}
#[tauri::command]
pub fn get_bridge_status(bridge: tauri::State<'_, Bridge>) -> BridgeStatus {
    bridge.status()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_receipt_requires_authorization_and_never_creates_a_session() {
        tauri::async_runtime::block_on(async {
            let bridge = Bridge::default();
            assert_ne!(bridge.instance_id(), Bridge::default().instance_id());
            let mut headers = HeaderMap::new();
            assert_eq!(diagnose(State(bridge.clone()), headers.clone()).await.unwrap_err(), StatusCode::FORBIDDEN);
            headers.insert("origin", ORIGIN.parse().unwrap());
            headers.insert("host", ADDRESS.parse().unwrap());
            headers.insert("x-taizhou-bridge", "1".parse().unwrap());
            let result = diagnose(State(bridge.clone()), headers).await.unwrap();
            assert_eq!(result.0["instanceId"], bridge.instance_id());
            assert!(!bridge.status().connected);
            assert!(!bridge.busy());
        });
    }
    #[test]
    fn hourly_target_uses_the_api_verified_tab_and_rejects_navigation() {
        let bridge = Bridge::default();
        let url = "http://61.155.4.60:18080/#/home/map";
        bridge.0.lock().unwrap().clients.insert("session".into(), Client {
            version: crate::readiness::MIN_VERSION.into(),
            last_seen: Instant::now(),
            tabs: [1, 2].into_iter().map(|id| BrowserTab {
                id, title: "fixture".into(), url: url.into(), status: "complete".into(),
            }).collect(),
        });
        let mut verified = crate::readiness::SiteHealth {
            id: "map".into(), state: "ready".into(), message: "fixture".into(),
            checked_at: None, session: Some("session".into()), tab_id: Some(2), url: Some(url.into()),
        };
        assert_eq!(bridge.hourly_target(&verified).unwrap(), ("session".into(), 2));
        verified.url = Some("http://61.155.4.60:18080/#/login".into());
        assert!(bridge.hourly_target(&verified).is_err());
        verified.url = Some(url.into());
        verified.state = "login_required".into();
        assert!(bridge.hourly_target(&verified).is_err());
    }
    #[test]
    fn rejects_untrusted_urls() {
        assert!(allowed_url("https://fh.dji.com/project"));
        assert!(allowed_url("http://61.155.4.60:18080/#/home/map"));
        for url in [
            "https://fh.dji.com.evil.test/",
            "http://fh.dji.com/",
            "https://fh.dji.com:444/",
            "https://user@fh.dji.com/",
            "file:///etc/passwd",
        ] {
            assert!(!allowed_url(url), "{url}");
        }
    }
    #[test]
    fn requires_exact_extension_origin_and_local_host() {
        let mut headers = HeaderMap::new();
        headers.insert("origin", ORIGIN.parse().unwrap());
        headers.insert("host", ADDRESS.parse().unwrap());
        headers.insert("x-taizhou-bridge", "1".parse().unwrap());
        assert!(authorized(&headers));
        headers.insert(
            "origin",
            if tauri::is_dev() {
                env!("BRIDGE_PROD_ORIGIN")
            } else {
                env!("BRIDGE_DEV_ORIGIN")
            }
            .parse()
            .unwrap(),
        );
        assert!(!authorized(&headers));
        headers.insert("origin", ORIGIN.parse().unwrap());
        headers.insert(
            "host",
            if tauri::is_dev() {
                env!("BRIDGE_PROD_ADDRESS")
            } else {
                env!("BRIDGE_DEV_ADDRESS")
            }
            .parse()
            .unwrap(),
        );
        assert!(!authorized(&headers));
        headers.insert("host", ADDRESS.parse().unwrap());
        headers.insert("origin", "https://evil.test".parse().unwrap());
        assert!(!authorized(&headers));
        headers.insert("origin", ORIGIN.parse().unwrap());
        headers.insert("host", "evil.test:14520".parse().unwrap());
        assert!(!authorized(&headers));
    }
    #[test]
    fn stale_clients_are_removed() {
        let mut inner = Inner::default();
        inner.clients.insert(
            "old".into(),
            Client {
                version: crate::readiness::MIN_VERSION.into(),
                tabs: vec![],
                last_seen: Instant::now() - TTL,
            },
        );
        prune(&mut inner);
        assert!(inner.clients.is_empty());
    }
    #[test]
    fn background_site_health_jobs_require_fixed_parameters_and_allow_missing_tabs() {
        tauri::async_runtime::block_on(async {
            let bridge = Bridge::default();
            let session = Uuid::new_v4().to_string();
            bridge.0.lock().unwrap().clients.insert(
                session.clone(),
                Client {
                    version: crate::readiness::MIN_VERSION.into(),
                    tabs: vec![],
                    last_seen: Instant::now(),
                },
            );
            for kind in ["airins-health-open", "dji-health-open", "jiangsu-health"] {
                let invalid_tab = if kind == "jiangsu-health" { -2 } else { 1 };
                for (tab_id, job) in [
                    (invalid_tab, json!({"type":kind})),
                    (-1, json!({"type":kind,"url":"https://example.test"})),
                    (-1, json!({"type":kind,"submit":true})),
                ] {
                    assert!(bridge.request(session.clone(), tab_id, job).await.is_err());
                }
                let pending_bridge = bridge.clone();
                let pending_session = session.clone();
                let task = tauri::async_runtime::spawn(async move {
                    pending_bridge.request(pending_session, -1, json!({"type":kind})).await
                });
                for _ in 0..100 {
                    if bridge.busy() { break; }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                let pending = bridge.0.lock().unwrap().pending.drain().next().unwrap().1;
                assert_eq!(pending.tab_id, -1);
                assert_eq!(pending.job["type"], kind);
                pending.result.send(Ok(json!({"state":"ready"}))).unwrap();
                assert_eq!(task.await.unwrap().unwrap()["state"], "ready");
            }
        });
    }
    #[test]
    fn old_plugin_is_visible_but_cannot_receive_work_and_recovers_after_reload() {
        tauri::async_runtime::block_on(async {
            let bridge = Bridge::default();
            let mut headers = HeaderMap::new();
            headers.insert("origin", ORIGIN.parse().unwrap());
            headers.insert("host", ADDRESS.parse().unwrap());
            headers.insert("x-taizhou-bridge", "1".parse().unwrap());
            let session = Uuid::new_v4().to_string();
            let input = |version: &str| Heartbeat {
                session: session.clone(),
                version: version.into(),
                tabs: vec![BrowserTab {
                    id: 1,
                    title: "fixture".into(),
                    url: "https://fh.dji.com/".into(),
                    status: "complete".into(),
                }],
            };
            let response = heartbeat(State(bridge.clone()), headers.clone(), Json(input("0.1.0")))
                .await
                .unwrap();
            assert_eq!(response.0["updateRequired"], true);
            assert_eq!(response.0["jobs"], json!([]));
            assert!(bridge.status().connected);
            for kind in [
                "capture",
                "site-health",
                "jiangsu-hourly",
                "dji-prepare",
                "flight-missions",
            ] {
                let error = bridge
                    .request(session.clone(), 1, json!({"type":kind}))
                    .await
                    .unwrap_err();
                assert!(error.contains("必须更新"), "{kind}: {error}");
            }
            assert!(!bridge.busy());
            let _ = heartbeat(
                State(bridge.clone()),
                headers.clone(),
                Json(input(crate::readiness::MIN_VERSION)),
            )
            .await
            .unwrap();
            let pending_bridge = bridge.clone();
            let pending_session = session.clone();
            let pending = tauri::async_runtime::spawn(async move {
                pending_bridge.capture(pending_session, 1).await
            });
            for _ in 0..100 {
                if bridge.busy() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            assert!(bridge.busy());
            // A stale worker appearing while a task is queued must not receive it.
            let response = heartbeat(State(bridge.clone()), headers, Json(input("0.1.0")))
                .await
                .unwrap();
            assert_eq!(response.0["jobs"], json!([]));
            assert!(pending.await.unwrap().is_err());
            assert!(!bridge.busy());
        });
    }
    #[test]
    fn site_checks_share_one_heartbeat_and_keep_individual_results() {
        tauri::async_runtime::block_on(async {
            let bridge = Bridge::default();
            let mut headers = HeaderMap::new();
            headers.insert("origin", ORIGIN.parse().unwrap());
            headers.insert("host", ADDRESS.parse().unwrap());
            headers.insert("x-taizhou-bridge", "1".parse().unwrap());
            let session = Uuid::new_v4().to_string();
            let input = || Heartbeat {
                session: session.clone(),
                version: crate::readiness::MIN_VERSION.into(),
                tabs: ["http://61.155.4.60:18080/", "https://fh.dji.com/", "https://aai.airins.cn/sniff"]
                    .iter().enumerate().map(|(id, url)| BrowserTab {
                        id: id as i64, title: "fixture".into(), url: (*url).into(), status: "complete".into(),
                    }).collect(),
            };
            let _ = heartbeat(State(bridge.clone()), headers.clone(), Json(input())).await.unwrap();
            let batch_bridge = bridge.clone();
            let batch_session = session.clone();
            let batch = tauri::async_runtime::spawn(async move {
                tokio::join!(
                    batch_bridge.request(batch_session.clone(), 0, json!({"type":"jiangsu-health"})),
                    batch_bridge.request(batch_session.clone(), 1, json!({"type":"site-health"})),
                    batch_bridge.request(batch_session, 2, json!({"type":"site-health"})),
                )
            });
            for _ in 0..100 {
                if bridge.0.lock().unwrap().pending.len() == 3 { break; }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            let delivered = heartbeat(State(bridge.clone()), headers.clone(), Json(input())).await.unwrap();
            let jobs = delivered.0["jobs"].as_array().unwrap();
            assert_eq!(jobs.len(), 3, "all sites must be delivered without another heartbeat");
            for job in jobs {
                let failed = job["tabId"] == 1;
                let _ = complete(State(bridge.clone()), headers.clone(), Json(Completion {
                    session: session.clone(), id: job["id"].as_str().unwrap().into(),
                    data: (!failed).then(|| json!({"state":"ready"})),
                    error: failed.then(|| "fixture timeout".into()),
                })).await.unwrap();
            }
            let (map, dji, sniff) = batch.await.unwrap();
            assert_eq!(map.unwrap()["state"], "ready");
            assert_eq!(dji.unwrap_err(), "fixture timeout");
            assert_eq!(sniff.unwrap()["state"], "ready");
            assert!(!bridge.busy());
            let repeated = heartbeat(State(bridge.clone()), headers, Json(input())).await.unwrap();
            assert!(repeated.0["jobs"].as_array().unwrap().is_empty());
        });
    }
    #[test]
    fn capture_requires_live_client_and_matching_completion() {
        tauri::async_runtime::block_on(async {
            let bridge = Bridge::default();
            assert!(bridge.capture(Uuid::new_v4().to_string(), 1).await.is_err());
            let mut headers = HeaderMap::new();
            headers.insert("origin", ORIGIN.parse().unwrap());
            headers.insert("host", ADDRESS.parse().unwrap());
            headers.insert("x-taizhou-bridge", "1".parse().unwrap());
            let session = Uuid::new_v4().to_string();
            let _ = heartbeat(
                State(bridge.clone()),
                headers.clone(),
                Json(Heartbeat {
                    session: session.clone(),
                    version: crate::readiness::MIN_VERSION.into(),
                    tabs: vec![BrowserTab {
                        id: 1,
                        title: "page".into(),
                        url: "https://fh.dji.com/".into(),
                        status: "complete".into(),
                    }],
                }),
            )
            .await
            .unwrap();
            let captured_bridge = bridge.clone();
            let captured_session = session.clone();
            let task = tauri::async_runtime::spawn(async move {
                captured_bridge.capture(captured_session, 1).await
            });
            for _ in 0..100 {
                if !bridge.0.lock().unwrap().pending.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            let id = bridge
                .0
                .lock()
                .unwrap()
                .pending
                .keys()
                .next()
                .unwrap()
                .clone();
            // Results cannot be injected before a job has been delivered.
            assert_eq!(
                complete(
                    State(bridge.clone()),
                    headers.clone(),
                    Json(Completion {
                        session: session.clone(),
                        id: id.clone(),
                        data: Some(json!({})),
                        error: None
                    })
                )
                .await
                .unwrap_err(),
                StatusCode::NOT_FOUND
            );
            let delivered = heartbeat(
                State(bridge.clone()),
                headers.clone(),
                Json(Heartbeat {
                    session: session.clone(),
                    version: crate::readiness::MIN_VERSION.into(),
                    tabs: vec![],
                }),
            )
            .await
            .unwrap();
            assert_eq!(delivered.0["jobs"][0]["id"], id);
            let repeated = heartbeat(
                State(bridge.clone()),
                headers.clone(),
                Json(Heartbeat {
                    session: session.clone(),
                    version: crate::readiness::MIN_VERSION.into(),
                    tabs: vec![],
                }),
            )
            .await
            .unwrap();
            assert!(repeated.0["jobs"].as_array().unwrap().is_empty());
            assert_eq!(
                complete(
                    State(bridge.clone()),
                    headers.clone(),
                    Json(Completion {
                        session: Uuid::new_v4().to_string(),
                        id: id.clone(),
                        data: Some(json!({})),
                        error: None
                    })
                )
                .await
                .unwrap_err(),
                StatusCode::NOT_FOUND
            );
            let _ = complete(
                State(bridge.clone()),
                headers,
                Json(Completion {
                    session,
                    id,
                    data: Some(json!({"text":"real result"})),
                    error: None,
                }),
            )
            .await
            .unwrap();
            assert_eq!(task.await.unwrap().unwrap()["text"], "real result");
            assert!(bridge.0.lock().unwrap().pending.is_empty());
        });
    }
}
