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

pub(crate) const ORIGIN: &str = if crate::environment::IS_TEST {
    env!("BRIDGE_DEV_ORIGIN")
} else {
    env!("BRIDGE_PROD_ORIGIN")
};
pub(crate) const ADDRESS: &str = if crate::environment::IS_TEST {
    env!("BRIDGE_DEV_ADDRESS")
} else {
    env!("BRIDGE_PROD_ADDRESS")
};
const HEALTH_REQUEST_TIMEOUT_SECS: u64 = 35;
fn session_count_error(total: usize, compatible: usize) -> String {
    if crate::environment::IS_TEST {
        return test_session_error(total, compatible);
    }
    format!(
        "请连接且仅保留一个 v{} 或以上 Chrome 桥接插件会话。",
        crate::readiness::MIN_VERSION
    )
}
fn test_session_error(total: usize, compatible: usize) -> String {
    if total == 0 {
        "测试版插件未连接，请在当前 Chrome 中加载并启用开发版插件。".into()
    } else if compatible == 0 {
        format!(
            "测试版插件版本过旧，请在当前 Chrome 中重新加载 v{} 或以上开发版插件。",
            crate::readiness::MIN_VERSION
        )
    } else {
        "检测到多个测试版插件会话，请在当前 Chrome 中只保留一个开发版插件会话。"
            .into()
    }
}

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
    #[serde(default)]
    busy: bool,
    #[serde(default, rename = "singleJob")]
    single_job: bool,
    #[serde(default, rename = "parallelReports")]
    parallel_reports: bool,
    #[serde(default, rename = "parallelReads")]
    parallel_reads: bool,
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
    queued_at: Instant,
    dispatched: Option<oneshot::Sender<()>>,
    execution_timeout: u64,
    job: Value,
    result: oneshot::Sender<Result<Value, String>>,
}
#[derive(Default)]
struct Inner {
    clients: HashMap<String, Client>,
    pending: HashMap<String, Pending>,
    error: Option<String>,
    instance_id: String,
    logger: Option<crate::runtime_log::RuntimeLog>,
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
    // A worker executing a batch still renews its lease and tab inventory,
    // without claiming more work that it cannot execute yet.
    if input.busy && !input.parallel_reads {
        return Ok(Json(
            json!({ "ok": true, "jobs": [], "keepAliveSupported": true }),
        ));
    }
    let jobs = if input.parallel_reads {
        claim_parallel_reads(&mut inner, &input.session, input.busy)
    } else {
        claim_jobs(&mut inner, &input.session, input.single_job, input.parallel_reports)
    };
    if let Some(log) = &inner.logger {
        for job in &jobs {
            log.record(
                "info",
                "bridge",
                "job.delivered",
                &browser_job_message(
                    "delivered",
                    job["type"].as_str().unwrap_or_default(),
                    None,
                ),
                json!({"requestId":job["id"],"type":job["type"],"tabId":job["tabId"]}),
            );
        }
    }
    Ok(Json(
        json!({ "ok": true, "jobs": jobs, "keepAliveSupported": true, "singleJobSupported": true, "parallelReadsSupported": true }),
    ))
}

fn job_priority(job: &Value) -> u8 {
    match job["type"].as_str().unwrap_or("") {
        "dji-weather" | "dji-submit" | "dji-status" => 0,
        "dji-prepare" | "dji-open-prepared" | "jiangsu-hourly" | "airins-realtime" => 1,
        "airins-health-open" => 2,
        "site-health" | "jiangsu-health" | "dji-health-open" => 3,
        "dji-tasks" => 5,
        _ => 4,
    }
}

/// Human-readable browser work names used in the persistent runtime log.
/// Keep the wire-level `type` values unchanged; they are an implementation
/// detail for the extension, while the log is written for people diagnosing
/// what the application is doing.
fn browser_job_label(kind: &str) -> String {
    match kind {
        "capture" => "读取网页内容".into(),
        "site-health" => "检查可飞网站连接".into(),
        "jiangsu-health" => "检查江苏监测网站连接".into(),
        "dji-health-open" => "检查司空 FlightHub 连接".into(),
        "open-business-site" => "打开托管平台页面".into(),
        "airins-health-open" => "检查可飞平台连接".into(),
        "airins-realtime" => "读取可飞实时监测数据".into(),
        "jiangsu-hourly" => "同步江苏小时监测数据".into(),
        "dji-weather" => "获取司空机场天气".into(),
        "dji-routes" => "同步司空航线".into(),
        "dji-tasks" => "同步司空任务".into(),
        "dji-status" => "查询司空任务状态".into(),
        "dji-prepare" => "准备司空巡查任务".into(),
        "dji-open-prepared" => "打开已准备的司空巡查任务".into(),
        "dji-submit" => "提交司空巡查任务".into(),
        "flight-missions" => "查询巡飞任务".into(),
        "flight-airins" => "获取可飞任务数据".into(),
        "flight-dji-list" => "查询司空媒体目录".into(),
        "flight-dji-image" => "下载司空媒体".into(),
        other if other.is_empty() => "浏览器任务".into(),
        other => format!("浏览器任务（{other}）"),
    }
}

fn browser_job_message(event: &str, kind: &str, success: Option<bool>) -> String {
    let label = browser_job_label(kind);
    match (event, success) {
        ("started", _) => format!("正在请求浏览器插件执行“{label}”"),
        ("delivered", _) => format!("已将“{label}”交给浏览器插件，等待插件回执"),
        ("finished", Some(true)) => {
            format!("浏览器插件已返回“{label}”回执，业务结果请查看后续记录")
        }
        ("finished", Some(false)) => format!("浏览器插件执行“{label}”失败"),
        _ => format!("浏览器任务“{label}”状态已更新"),
    }
}

// Only operations which do not manipulate shared page UI may bypass the serial lane.
fn read_job(job: &Value) -> bool {
    matches!(job["type"].as_str(), Some("site-health" | "jiangsu-health" | "airins-health-open" | "dji-health-open" | "jiangsu-hourly" | "dji-routes" | "capture"))
}
fn claim_parallel_reads(inner: &mut Inner, session: &str, worker_busy: bool) -> Vec<Value> {
    let now = chrono::Utc::now().timestamp_millis();
    let serial_busy = worker_busy || inner.pending.values().any(|p| p.session == session && p.sent && !read_job(&p.job));
    let mut candidates: Vec<_> = inner.pending.iter()
        .filter(|(_, p)| p.session == session && !p.sent && p.job["expiresAt"].as_i64().is_none_or(|at| at > now))
        .map(|(id, p)| (id.clone(), job_priority(&p.job), p.queued_at, read_job(&p.job), report_job(&p.job)))
        .collect();
    candidates.sort_by_key(|(_, priority, queued, _, _)| (*priority, *queued));
    let mut selected: Vec<_> = candidates.iter().filter(|c| c.3).map(|c| c.0.clone()).collect();
    if !serial_busy {
        let serial: Vec<_> = candidates.iter().filter(|c| !c.3).collect();
        if let Some(first) = serial.first() {
            if first.4 { selected.extend(serial.iter().filter(|c| c.4).take(3).map(|c| c.0.clone())); }
            else { selected.push(first.0.clone()); }
        }
    }
    selected.into_iter().filter_map(|id| dispatch(inner, id)).collect()
}
fn dispatch(inner: &mut Inner, id: String) -> Option<Value> {
    let p = inner.pending.get_mut(&id)?;
    p.sent = true;
    p.job["expiresAt"] = json!(chrono::Utc::now().timestamp_millis() + p.execution_timeout as i64 * 1000);
    if let Some(started) = p.dispatched.take() { let _ = started.send(()); }
    let mut job = p.job.clone();
    job["id"] = json!(id);
    job["tabId"] = json!(p.tab_id);
    Some(job)
}

fn claim_jobs(inner: &mut Inner, session: &str, single: bool, parallel_reports: bool) -> Vec<Value> {
    // A worker reload must not claim another job while the preceding operation
    // has an outstanding receipt. Busy heartbeats likewise never claim work.
    if single && !parallel_reports && inner.pending.values().any(|p| p.session == session && p.sent) {
        return vec![];
    }
    let now = chrono::Utc::now().timestamp_millis();
    let mut candidates: Vec<_> = inner.pending.iter()
        .filter(|(_, p)| p.session == session && !p.sent
            && p.job["expiresAt"].as_i64().is_none_or(|at| at > now))
        .map(|(id, p)| (id.clone(), job_priority(&p.job), p.queued_at, report_job(&p.job)))
        .collect();
    candidates.sort_by_key(|(_, priority, queued_at, _)| (*priority, *queued_at));
    let selected_ids: Vec<String>;
    if parallel_reports {
        // Keep all side-effectful and health work serial. Only report media
        // jobs can be claimed as a batch because each job owns its own tab.
        let active_reports = inner.pending.values()
            .filter(|pending| pending.session == session && pending.sent && report_job(&pending.job))
            .count();
        let available_reports = 3usize.saturating_sub(active_reports);
        if available_reports == 0 || active_reports > 0 {
            return vec![];
        }
        if let Some((id, _, _, _)) = candidates.iter().find(|(_, _, _, is_report)| !*is_report) {
            selected_ids = vec![id.clone()];
        } else {
            selected_ids = candidates.iter().filter(|(_, _, _, is_report)| *is_report).take(available_reports).map(|(id, _, _, _)| id.clone()).collect();
        }
    } else {
        selected_ids = candidates.into_iter().take(if single { 1 } else { usize::MAX }).map(|(id, _, _, _)| id).collect();
    }
    selected_ids.into_iter().filter_map(|id| dispatch(inner, id)).collect()
}

fn report_job(job: &Value) -> bool {
    matches!(job["type"].as_str(), Some("flight-dji-list") | Some("flight-dji-image"))
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
#[derive(Deserialize)]
struct HealthProgressInput { session: String, id: String, stage: String }
fn health_job(job: &Value) -> bool {
    matches!(job["type"].as_str(), Some("site-health" | "jiangsu-health" | "airins-health-open" | "dji-health-open"))
}
fn health_stage(stage: &str) -> Option<&'static str> {
    match stage {
        "loading" => Some("正在等待网站页面加载"),
        "waking" => Some("正在唤醒休眠页面，并等待页面恢复"),
        "focus_wait" => Some("等待其他网站完成唤醒，即将激活此页面"),
        "activating" => Some("正在短暂激活页面，恢复后台渲染"),
        "reading" => Some("正在验证登录与业务访问"),
        _ => None,
    }
}
async fn health_progress(State(bridge): State<Bridge>, headers: HeaderMap, Json(input): Json<HealthProgressInput>) -> Result<Json<Value>, StatusCode> {
    if !authorized(&headers) { return Err(StatusCode::FORBIDDEN); }
    let message = health_stage(&input.stage).ok_or(StatusCode::BAD_REQUEST)?;
    let mut inner = bridge.0.lock().unwrap();
    let pending = inner.pending.get_mut(&input.id)
        .filter(|p| p.session == input.session && p.sent && health_job(&p.job))
        .ok_or(StatusCode::NOT_FOUND)?;
    pending.job["healthProgress"] = json!(message);
    Ok(Json(json!({"ok":true})))
}

impl Bridge {
    pub fn start(&self, app: tauri::AppHandle) {
        use tauri::Manager;
        self.0.lock().unwrap().logger = Some(
            app.state::<crate::runtime_log::RuntimeLog>()
                .inner()
                .clone(),
        );
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
                .route("/health-progress", post(health_progress))
                .route("/cancel-flight", post(move |headers: HeaderMap, Json(input): Json<CancelFlight>| {
                    let app = app.clone();
                    async move {
                        if !authorized(&headers) { return Err(StatusCode::FORBIDDEN); }
                        crate::flight::cancel_flight(app, input.event_id).map_err(|_| StatusCode::CONFLICT)?;
                        Ok::<_, StatusCode>(Json(json!({"ok":true})))
                    }
                }))
                // One source image (16 MB base64) plus annotated PNG (48 MB), with metadata.
                .layer(DefaultBodyLimit::max(68 * 1024 * 1024))
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
    pub(crate) async fn wait_for_heartbeat(&self, since: Instant, timeout: Duration) -> bool {
        let deadline = since + timeout;
        loop {
            // Observe real incoming heartbeats without clearing leases or claiming jobs.
            if self.0.lock().unwrap().clients.values().any(|client| {
                client.last_seen >= since
                    && client.last_seen <= deadline
                    && client.last_seen.elapsed() < TTL
            }) {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            tokio::time::sleep(remaining.min(Duration::from_millis(100))).await;
        }
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
            return Err(session_count_error(inner.clients.len(), sessions.len()));
        }
        Ok(sessions[0].clone())
    }
    pub async fn capture(&self, session: String, tab_id: i64) -> Result<Value, String> {
        self.request(session, tab_id, json!({"type": "capture"}))
            .await
    }
    pub fn hourly_target(
        &self,
        verified: &crate::readiness::SiteHealth,
    ) -> Result<(String, i64), String> {
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
    pub async fn prepare_flight(
        &self,
        event_id: &str,
        name: &str,
        route: &crate::flight::FlightRoute,
        auto_submit: bool,
    ) -> Result<Value, String> {
        self.flight_job(event_id, name, route, false, auto_submit).await
    }
    pub async fn submit_flight(&self, event_id: &str, name: &str, route: &crate::flight::FlightRoute) -> Result<Value, String> {
        self.flight_job(event_id, name, route, true, false).await
    }
    pub async fn sync_flight_routes(&self) -> Result<Value, String> {
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
                return Err(session_count_error(inner.clients.len(), sessions.len()));
            }
            sessions.remove(0)
        };
        self.request(session, -1, json!({"type":"dji-routes"})).await
    }
    pub async fn flight_status(&self, event_id: &str, name: &str) -> Result<Value, String> {
        let session = {
            let mut inner = self.0.lock().unwrap();
            prune(&mut inner);
            let sessions: Vec<_> = inner
                .clients
                .iter()
                .filter(|(_, client)| crate::readiness::compatible(&client.version))
                .map(|(id, _)| id.clone())
                .collect();
            if sessions.len() != 1 {
                return Err("请连接唯一的兼容 Chrome 插件以读取司空任务状态。".into());
            }
            sessions[0].clone()
        };
        if event_id.is_empty() || name.is_empty() {
            return Err("司空任务状态参数无效。".into());
        }
        self.request(
            session,
            -1,
            json!({"type":"dji-status","eventId":event_id,"name":name,"submit":false}),
        )
        .await
    }
    async fn flight_job(
        &self,
        event_id: &str,
        name: &str,
        route: &crate::flight::FlightRoute,
        submit: bool,
        auto_submit: bool,
    ) -> Result<Value, String> {
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
                return Err(session_count_error(inner.clients.len(), sessions.len()));
            }
            sessions.remove(0)
        };
        self.request(
            session,
            -1,
            json!({"type": if submit { "dji-submit" } else { "dji-prepare" }, "eventId":event_id, "name":name, "route":route.name, "routeId":route.route_id, "folderPath":route.folder_path, "submit":submit, "autoSubmit":auto_submit}),
        )
        .await
    }
    pub fn health_checks(&self) -> Vec<Value> {
        let inner = self.0.lock().unwrap();
        inner.pending.values().filter(|p| health_job(&p.job)).filter_map(|p| {
            let site = match p.job["type"].as_str()? {
                "jiangsu-health" => "map",
                "airins-health-open" => "sniff",
                "dji-health-open" => "dji",
                _ => {
                    let tab = inner.clients.get(&p.session)?.tabs.iter().find(|t| t.id == p.tab_id)?;
                    match tauri::Url::parse(&tab.url).ok()?.host_str()? {
                        "aai.airins.cn" => "sniff", "fh.dji.com" => "dji", "61.155.4.60" => "map", _ => return None,
                    }
                }
            };
            Some(json!({"id":site,"message":if p.sent { p.job["healthProgress"].as_str().unwrap_or("插件已接收，等待网站验证结果") } else { "等待浏览器插件接收验证任务" },
                "elapsedSeconds":p.queued_at.elapsed().as_secs(),
                "remainingSeconds":((p.job["expiresAt"].as_i64().unwrap_or(0) - chrono::Utc::now().timestamp_millis()).max(0) + 999) / 1000,
                "dispatched":p.sent}))
        }).collect()
    }
    pub async fn request(&self, session: String, tab_id: i64, job: Value) -> Result<Value, String> {
        let logger = self.0.lock().unwrap().logger.clone();
        let id = Uuid::new_v4().to_string();
        let started = Instant::now();
        let metadata = json!({"requestId":id,"type":job["type"],"tabId":tab_id,"eventId":job["eventId"],"parameters":job});
        if let Some(log) = &logger {
            log.record(
                "info",
                "bridge",
                "job.started",
                &browser_job_message("started", job["type"].as_str().unwrap_or_default(), None),
                metadata.clone(),
            );
        }
        let result = self.request_inner(session, tab_id, job, id).await;
        if let Some(log) = &logger {
            let mut details = metadata;
            details["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
            details["error"] = json!(result.as_ref().err());
            log.record(
                if result.is_ok() { "info" } else { "error" },
                "bridge",
                "job.finished",
                &browser_job_message(
                    "finished",
                    details["type"].as_str().unwrap_or_default(),
                    Some(result.is_ok()),
                ),
                details,
            );
        }
        result
    }
    async fn request_inner(&self, session: String, tab_id: i64, job: Value, id: String) -> Result<Value, String> {
        let timeout = if health_job(&job) {
            120
        } else if job["type"] == "dji-weather" {
            // 25s navigation + 50s page read + focus cleanup and bridge delivery.
            85
        } else if ["dji-tasks", "dji-routes", "site-health", "jiangsu-health", "airins-health-open", "dji-health-open"]
            .iter()
            .any(|kind| job["type"] == *kind)
        {
            // This budget starts at delivery, separately from queue waiting.
            // Read-only checks run independently of the serial browser lane.
            HEALTH_REQUEST_TIMEOUT_SECS
        } else {
            100
        };
        let (tx, rx) = oneshot::channel();
        let (started_tx, started_rx) = oneshot::channel();
        {
            let mut inner = self.0.lock().unwrap();
            prune(&mut inner);
            if !read_job(&job) && inner.pending.values().filter(|p| !read_job(&p.job)).count() >= 8 {
                return Err("采集任务过多，请稍后重试。".into());
            }
            let client = inner
                .clients
                .get(&session)
                .ok_or("插件未连接，请打开 Chrome 并重新加载插件。")?;
            if !crate::readiness::compatible(&client.version) {
                return Err(format!("浏览器插件必须更新：当前 v{}，需要 v{} 或以上。请在 Chrome 扩展管理页重新加载插件。", client.version, crate::readiness::MIN_VERSION));
            }
            if job["type"] != "open-business-site"
                && job["type"] != "dji-prepare"
                && job["type"] != "dji-submit"
                && job["type"] != "dji-open-prepared"
                && job["type"] != "dji-status"
                && job["type"] != "dji-tasks"
                && job["type"] != "dji-routes"
                && job["type"] != "airins-realtime"
                && job["type"] != "airins-health-open"
                && job["type"] != "dji-health-open"
                && job["type"] != "dji-weather"
                && job["type"] != "jiangsu-health"
            {
                let tab = client
                    .tabs
                    .iter()
                    .find(|tab| tab.id == tab_id)
                    .ok_or("页面已关闭，请刷新数据源列表。")?;
                if tab.status != "complete" && !(job["type"] == "site-health" && tab.status == "unloaded") {
                    return Err("页面尚未加载完成，请稍后重试。".into());
                }
            } else if job["type"] == "open-business-site"
                && (tab_id != -1
                    || !job["url"].as_str().is_some_and(allowed_url)
                    || job.as_object().is_none_or(|value| value.len() != 2))
            {
                return Err("托管平台页面参数无效。".into());
            } else if (job["type"] == "dji-tasks" || job["type"] == "dji-routes")
                && (tab_id != -1
                    || job.as_object().is_none_or(|value| {
                        value.keys().any(|key| {
                            if job["type"] == "dji-routes" { key != "type" } else { !matches!(key.as_str(), "type" | "cursor" | "includeHistory") }
                        })
                    })
                    || (job["type"] == "dji-tasks" && job
                        .get("includeHistory")
                        .is_some_and(|value| !value.is_boolean()))
                )
            {
                return Err(if job["type"] == "dji-routes" { "司空航线同步参数无效。" } else { "司空任务同步参数无效。" }.into());
            } else if (job["type"] == "airins-health-open"
                || job["type"] == "dji-health-open"
                || job["type"] == "dji-weather")
                && (tab_id != -1 || job.as_object().is_none_or(|value| value.len() != 1))
            {
                return Err("后台网站验证任务参数无效。".into());
            } else if job["type"] == "jiangsu-health"
                && (tab_id < -1 || job.as_object().is_none_or(|value| value.len() != 1))
            {
                return Err("江苏大气站验证任务参数无效。".into());
            } else if job["type"] != "open-business-site"
                && job["type"] != "dji-tasks"
                && job["type"] != "dji-routes"
                && job["type"] != "airins-realtime"
                && job["type"] != "airins-health-open"
                && job["type"] != "dji-health-open"
                && job["type"] != "dji-weather"
                && job["type"] != "jiangsu-health"
                && (tab_id != -1 || job["submit"] != (job["type"] == "dji-submit"))
            {
                return Err("司空任务类型与提交标记不匹配。".into());
            }
            let mut job = job;
            job["expiresAt"] = json!(chrono::Utc::now().timestamp_millis() + 120_000);
            inner.pending.insert(
                id.clone(),
                Pending {
                    session,
                    tab_id,
                    sent: false,
                    queued_at: Instant::now(),
                    dispatched: Some(started_tx),
                    execution_timeout: timeout,
                    job,
                    result: tx,
                },
            );
        }
        // Queue waiting and actual execution have separate deadlines.
        match tokio::time::timeout(Duration::from_secs(120), started_rx).await {
            Ok(Ok(())) => {},
            other => {
                self.0.lock().unwrap().pending.remove(&id);
                return Err(if other.is_err() { "浏览器任务排队超时，尚未执行网站检查，请稍后重试。" } else { "采集连接已中断。" }.into());
            }
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
    fn health_progress_tracks_delivery_and_rejects_unrelated_receipts() {
        tauri::async_runtime::block_on(async {
            let bridge = Bridge::default();
            let (tx, _rx) = oneshot::channel();
            bridge.0.lock().unwrap().pending.insert("check".into(), Pending {
                session:"session".into(), tab_id:-1, sent:false,
                queued_at:Instant::now() - Duration::from_secs(16), dispatched:None,
                execution_timeout:120,
                job:json!({"type":"airins-health-open","expiresAt":chrono::Utc::now().timestamp_millis()+120_000}), result:tx,
            });
            let checks = bridge.health_checks();
            assert_eq!(checks[0]["id"], "sniff");
            assert_eq!(checks[0]["dispatched"], false);
            assert_eq!(checks[0]["elapsedSeconds"], 16);
            let mut headers = HeaderMap::new();
            headers.insert("origin", ORIGIN.parse().unwrap());
            headers.insert("host", ADDRESS.parse().unwrap());
            headers.insert("x-taizhou-bridge", "1".parse().unwrap());
            let input = |session:&str, stage:&str| Json(HealthProgressInput {session:session.into(), id:"check".into(), stage:stage.into()});
            assert!(matches!(health_progress(State(bridge.clone()), headers.clone(), input("session","reading")).await, Err(StatusCode::NOT_FOUND)));
            dispatch(&mut bridge.0.lock().unwrap(), "check".into());
            assert!(matches!(health_progress(State(bridge.clone()), headers.clone(), input("wrong","reading")).await, Err(StatusCode::NOT_FOUND)));
            assert!(matches!(health_progress(State(bridge.clone()), headers.clone(), input("session","arbitrary text")).await, Err(StatusCode::BAD_REQUEST)));
            assert!(health_progress(State(bridge.clone()), headers, input("session","activating")).await.is_ok());
            let checks = bridge.health_checks();
            assert_eq!(checks[0]["dispatched"], true);
            assert_eq!(checks[0]["message"], "正在短暂激活页面，恢复后台渲染");
            assert!(checks[0]["remainingSeconds"].as_i64().unwrap() <= 120);
            bridge.0.lock().unwrap().pending.clear();
            assert!(bridge.health_checks().is_empty());
        });
    }

    #[test]
    fn reads_bypass_busy_serial_work_without_a_batch_limit_and_get_fresh_deadlines() {
        let mut inner = Inner::default();
        let mut receivers = Vec::new();
        for i in 0..42 {
            let (tx, _rx) = oneshot::channel();
            let (started, receiver) = oneshot::channel();
            receivers.push(receiver);
            inner.pending.insert(i.to_string(), Pending {
                session: "a".into(), tab_id: i, sent: i == 0,
                queued_at: Instant::now(), dispatched: Some(started), execution_timeout: 35,
                job: json!({"type": if i < 2 { "dji-submit" } else { "site-health" }, "expiresAt": chrono::Utc::now().timestamp_millis() + 1_000}), result: tx,
            });
        }
        let reads = claim_parallel_reads(&mut inner, "a", true);
        assert_eq!(reads.len(), 40);
        assert!(reads.iter().all(|job| read_job(job) && job["expiresAt"].as_i64().unwrap() > chrono::Utc::now().timestamp_millis() + 30_000));
        assert!(!inner.pending["1"].sent, "a second submit must wait");
        assert!(receivers[2].try_recv().is_ok(), "execution timer starts on delivery");
        assert!(claim_parallel_reads(&mut inner, "a", false).is_empty());
        inner.pending.remove("0");
        assert_eq!(claim_parallel_reads(&mut inner, "a", false)[0]["type"], "dji-submit");
    }

    #[test]
    fn single_job_dispatch_prioritizes_new_weather_between_background_jobs() {
        let mut inner = Inner::default();
        let mut insert = |id: &str, kind: &str, session: &str, expires: i64| {
            let (tx, _) = oneshot::channel();
            inner.pending.insert(
                id.into(),
                Pending {
                    session: session.into(),
                    tab_id: -1,
                    sent: false,
                    queued_at: Instant::now(), dispatched: None, execution_timeout: 35,
                    job: json!({"type":kind,"expiresAt":expires}),
                    result: tx,
                },
            );
        };
        let future = chrono::Utc::now().timestamp_millis() + 100000;
        insert("history", "dji-tasks", "a", future);
        insert("media", "flight-dji-image", "a", future);
        insert("other-weather", "dji-weather", "b", future);
        insert("expired-weather", "dji-weather", "a", 1);
        let first = claim_jobs(&mut inner, "a", true, false);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["id"], "media");
        assert!(claim_jobs(&mut inner, "a", true, false).is_empty());
        inner.pending.remove("media");
        let (tx, _) = oneshot::channel();
        inner.pending.insert(
            "new-weather".into(),
            Pending {
                session: "a".into(),
                tab_id: -1,
                sent: false,
                queued_at: Instant::now(), dispatched: None, execution_timeout: 35,
                job: json!({"type":"dji-weather","expiresAt":future}),
                result: tx,
            },
        );
        assert_eq!(claim_jobs(&mut inner, "a", true, false)[0]["id"], "new-weather");
        inner.pending.remove("new-weather");
        assert_eq!(claim_jobs(&mut inner, "a", true, false)[0]["id"], "history");
        assert!(!inner.pending["other-weather"].sent);
        assert!(!inner.pending["expired-weather"].sent);
    }
    #[test]
    fn parallel_report_dispatch_claims_three_media_jobs_only_after_serial_work() {
        let mut inner = Inner::default();
        let future = chrono::Utc::now().timestamp_millis() + 100000;
        for (id, kind) in [("one", "flight-dji-list"), ("two", "flight-dji-image"), ("three", "flight-dji-image"), ("four", "flight-dji-image"), ("history", "dji-tasks")] {
            let (tx, _) = oneshot::channel();
            inner.pending.insert(id.into(), Pending {
                session: "a".into(), tab_id: 2, sent: false, queued_at: Instant::now(), dispatched: None, execution_timeout: 35,
                job: json!({"type": kind, "expiresAt": future}), result: tx,
            });
        }
        let serial = claim_jobs(&mut inner, "a", true, true);
        assert_eq!(serial.len(), 1);
        assert_eq!(serial[0]["type"], "dji-tasks");
        inner.pending.remove("history");
        let batch = claim_jobs(&mut inner, "a", true, true);
        assert_eq!(batch.len(), 3);
        assert!(batch.iter().all(|job| report_job(job)));
        assert!(claim_jobs(&mut inner, "a", true, true).is_empty());
    }

    #[test]
    fn diagnostic_receipt_requires_authorization_and_never_creates_a_session() {
        tauri::async_runtime::block_on(async {
            let bridge = Bridge::default();
            assert_ne!(bridge.instance_id(), Bridge::default().instance_id());
            let mut headers = HeaderMap::new();
            assert_eq!(
                diagnose(State(bridge.clone()), headers.clone())
                    .await
                    .unwrap_err(),
                StatusCode::FORBIDDEN
            );
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
            if crate::environment::IS_TEST {
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
            if crate::environment::IS_TEST {
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
    fn managed_site_open_validates_url_and_does_not_require_existing_tabs() {
        tauri::async_runtime::block_on(async {
            let bridge = Bridge::default();
            let session = Uuid::new_v4().to_string();
            bridge.0.lock().unwrap().clients.insert(session.clone(), Client {
                version: crate::readiness::MIN_VERSION.into(),
                tabs: vec![], last_seen: Instant::now(),
            });
            for (tab, job) in [
                (-1, json!({"type":"open-business-site","url":"https://example.test"})),
                (1, json!({"type":"open-business-site","url":"https://fh.dji.com/"})),
                (-1, json!({"type":"open-business-site","url":"https://fh.dji.com/","submit":true})),
            ] {
                assert!(bridge.request(session.clone(), tab, job).await.is_err());
            }
            let worker = bridge.clone();
            let task = tauri::async_runtime::spawn(async move {
                worker.request(session, -1, json!({"type":"open-business-site","url":"https://fh.dji.com/"})).await
            });
            for _ in 0..100 {
                if bridge.busy() { break; }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            let pending = bridge.0.lock().unwrap().pending.drain().next().unwrap().1;
            assert_eq!(pending.tab_id, -1);
            pending.dispatched.unwrap().send(()).unwrap();
            pending.result.send(Ok(json!({"opened":true}))).unwrap();
            assert_eq!(task.await.unwrap().unwrap()["opened"], true);
        });
    }
    #[test]
    fn background_read_only_jobs_require_fixed_parameters_and_allow_missing_tabs() {
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
            for kind in [
                "airins-health-open",
                "dji-health-open",
                "jiangsu-health",
                "dji-weather",
                "dji-tasks",
                "dji-routes",
            ] {
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
                    pending_bridge
                        .request(pending_session, -1, json!({"type":kind}))
                        .await
                });
                for _ in 0..100 {
                    if bridge.busy() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                let pending = bridge.0.lock().unwrap().pending.drain().next().unwrap().1;
                assert_eq!(pending.tab_id, -1);
                assert_eq!(pending.job["type"], kind);
                pending.dispatched.unwrap().send(()).unwrap();
                pending.result.send(Ok(json!({"state":"ready"}))).unwrap();
                assert_eq!(task.await.unwrap().unwrap()["state"], "ready");
            }
        });
    }
    #[test]
    fn dji_task_sync_accepts_history_options_and_rejects_invalid_parameters() {
        tauri::async_runtime::block_on(async {
            let bridge = Bridge::default();
            let session = Uuid::new_v4().to_string();
            bridge.0.lock().unwrap().clients.insert(session.clone(), Client {
                version: crate::readiness::MIN_VERSION.into(),
                tabs: vec![],
                last_seen: Instant::now(),
            });
            for job in [
                json!({"type":"dji-tasks", "cursor":null, "includeHistory":true}),
                json!({"type":"dji-tasks", "cursor":null, "includeHistory":false}),
                json!({"type":"dji-tasks", "cursor":{"after":"committed-page"}, "includeHistory":true}),
            ] {
                let request = bridge.request(session.clone(), -1, job.clone());
                // Poll once to register the request, without waiting for a browser.
                let mut request = Box::pin(request);
                assert!(
                    tokio::time::timeout(Duration::from_millis(10), &mut request)
                        .await
                        .is_err(),
                    "valid sync parameters must be queued instead of rejected: {job}"
                );
                let pending = bridge.0.lock().unwrap().pending.drain().next().unwrap().1;
                assert_eq!(pending.tab_id, -1);
                assert_eq!(pending.job["cursor"], job["cursor"]);
                assert_eq!(pending.job["includeHistory"], job["includeHistory"]);
                pending.dispatched.unwrap().send(()).unwrap();
                pending.result.send(Ok(json!({"tasks":[]}))).unwrap();
                assert_eq!(request.await.unwrap(), json!({"tasks":[]}));
            }
            for job in [
                json!({"type":"dji-tasks", "includeHistory":"false"}),
                json!({"type":"dji-tasks", "includeHistory":null}),
                json!({"type":"dji-tasks", "includeHistory":true, "submit":true}),
                json!({"type":"dji-tasks", "includeHistory":true, "url":"https://example.test"}),
                json!({"type":"dji-routes", "cursor":null}),
            ] {
                let expected = if job["type"] == "dji-routes" { "司空航线同步参数无效。" } else { "司空任务同步参数无效。" };
                assert_eq!(
                    bridge.request(session.clone(), -1, job).await.unwrap_err(),
                    expected
                );
                assert!(!bridge.busy());
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
                busy: false,
                single_job: false,
                parallel_reports: false, parallel_reads: false,
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
                busy: false,
                single_job: false,
                parallel_reports: false, parallel_reads: false,
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
            let mut keepalive = input();
            keepalive.busy = true;
            bridge.0.lock().unwrap().clients.get_mut(&session).unwrap().last_seen = Instant::now() - TTL + Duration::from_secs(1);
            let renewed = heartbeat(State(bridge.clone()), headers.clone(), Json(keepalive)).await.unwrap();
            assert_eq!(renewed.0["jobs"], json!([]));
            assert!(bridge.0.lock().unwrap().pending.values().all(|pending| !pending.sent));
            assert!(bridge.0.lock().unwrap().clients[&session].last_seen.elapsed() < Duration::from_secs(1));
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
                    busy: false,
                    single_job: false,
                    parallel_reports: false, parallel_reads: false,
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
                    busy: false,
                    single_job: false,
                    parallel_reports: false, parallel_reads: false,
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
                    busy: false,
                    single_job: false,
                    parallel_reports: false, parallel_reads: false,
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

#[cfg(test)]
mod environment_message_tests {
    #[test]
    fn browser_job_messages_name_the_actual_action() {
        assert_eq!(
            super::browser_job_message("started", "dji-tasks", None),
            "正在请求浏览器插件执行“同步司空任务”"
        );
        assert_eq!(
            super::browser_job_message("delivered", "dji-weather", None),
            "已将“获取司空机场天气”交给浏览器插件，等待插件回执"
        );
        assert_eq!(
            super::browser_job_message("finished", "flight-dji-image", Some(true)),
            "浏览器插件已返回“下载司空媒体”回执，业务结果请查看后续记录"
        );
        assert_eq!(
            super::browser_job_message("finished", "dji-submit", Some(false)),
            "浏览器插件执行“提交司空巡查任务”失败"
        );
    }

    #[test]
    fn disconnected_old_and_duplicate_test_sessions_have_distinct_actions() {
        assert!(super::test_session_error(0, 0).contains("未连接"));
        assert!(super::test_session_error(1, 0).contains("版本过旧"));
        assert!(super::test_session_error(2, 2).contains("只保留一个开发版插件会话"));
    }
}
