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

const ORIGIN: &str = "chrome-extension://knpgppgofegbnimjoahnifpmhgmgnicf";
const ADDRESS: &str = "127.0.0.1:14520";
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
}
#[derive(Clone, Default)]
pub struct Bridge(Arc<Mutex<Inner>>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabStatus {
    session: String,
    #[serde(flatten)]
    tab: BrowserTab,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    connected: bool,
    clients: usize,
    versions: Vec<String>,
    tabs: Vec<TabStatus>,
    error: Option<String>,
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
            version: input.version,
            tabs,
            last_seen: Instant::now(),
        },
    );
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
#[derive(Deserialize)]
struct Completion {
    session: String,
    id: String,
    data: Option<Value>,
    error: Option<String>,
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
    pub fn start(&self) {
        let bridge = self.clone();
        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::bind(ADDRESS).await {
                Ok(listener) => listener,
                Err(error) => {
                    bridge.0.lock().unwrap().error = Some(format!(
                        "本地连接端口 14520 无法启动：{error}。请退出重复运行的客户端后重启。"
                    ));
                    return;
                }
            };
            let router = Router::new()
                .route("/heartbeat", post(heartbeat))
                .route("/complete", post(complete))
                .layer(DefaultBodyLimit::max(24 * 1024 * 1024))
                .layer(middleware::from_fn(cors))
                .with_state(bridge.clone());
            if let Err(error) = axum::serve(listener, router).await {
                bridge.0.lock().unwrap().error = Some(format!("本地连接服务停止：{error}"));
            }
        });
    }
    pub async fn capture(&self, session: String, tab_id: i64) -> Result<Value, String> {
        self.request(session, tab_id, json!({"type": "capture"}))
            .await
    }
    pub fn hourly_target(&self) -> Result<(String, i64), String> {
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
                        client
                            .version
                            .split('.')
                            .map(str::parse::<u32>)
                            .collect::<Result<Vec<_>, _>>()
                            .is_ok_and(|parts| {
                                parts.len() == 3 && parts.as_slice() >= [0, 3, 0].as_slice()
                            })
                            && tab.status == "complete"
                            && tab.url.split('?').next() == Some(crate::monitoring::SOURCE_URL)
                    })
                    .map(move |tab| (session.clone(), tab.id))
            })
            .collect();
        targets.sort();
        targets
            .into_iter()
            .next()
            .ok_or_else(|| "请连接 v0.3.0 插件，登录江苏大气站并保持时间序列页面打开。".into())
    }
    pub async fn prepare_flight(&self, event_id: &str, name: &str) -> Result<Value, String> {
        let session = {
            let mut inner = self.0.lock().unwrap();
            prune(&mut inner);
            let mut sessions: Vec<_> = inner
                .clients
                .iter()
                .filter(|(_, client)| {
                    client
                        .version
                        .split('.')
                        .map(str::parse::<u32>)
                        .collect::<Result<Vec<_>, _>>()
                        .is_ok_and(|parts| {
                            parts.len() == 3 && parts.as_slice() >= [0, 4, 0].as_slice()
                        })
                })
                .map(|(id, _)| id.clone())
                .collect();
            sessions.sort();
            if sessions.len() != 1 {
                return Err("请连接且仅保留一个 v0.4.0 或以上 Chrome 桥接插件会话。".into());
            }
            sessions.remove(0)
        };
        self.request(
            session,
            -1,
            json!({"type":"dji-prepare", "eventId":event_id, "name":name, "submit":false}),
        )
        .await
    }
    pub async fn request(&self, session: String, tab_id: i64, job: Value) -> Result<Value, String> {
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
            if job["type"]
                .as_str()
                .is_some_and(|kind| kind.starts_with("flight-"))
                && !client
                    .version
                    .split('.')
                    .map(str::parse::<u32>)
                    .collect::<Result<Vec<_>, _>>()
                    .is_ok_and(|parts| parts.len() == 3 && parts.as_slice() >= [0, 5, 0].as_slice())
            {
                return Err("请在 Chrome 扩展管理页重新加载 v0.5.0 或以上插件。".into());
            }
            if job["type"] != "dji-prepare" {
                let tab = client
                    .tabs
                    .iter()
                    .find(|tab| tab.id == tab_id)
                    .ok_or("页面已关闭，请刷新数据源列表。")?;
                if tab.status != "complete" {
                    return Err("页面尚未加载完成，请稍后重试。".into());
                }
            } else if tab_id != -1 || job["submit"] != false {
                return Err("司空任务只允许新页面填写。".into());
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
        let result = tokio::time::timeout(Duration::from_secs(100), rx).await;
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
    let mut inner = bridge.0.lock().unwrap();
    prune(&mut inner);
    BridgeStatus {
        connected: !inner.clients.is_empty(),
        clients: inner.clients.len(),
        versions: inner
            .clients
            .values()
            .map(|client| client.version.clone())
            .collect(),
        tabs: inner
            .clients
            .iter()
            .flat_map(|(session, client)| {
                client.tabs.iter().map(move |tab| TabStatus {
                    session: session.clone(),
                    tab: tab.clone(),
                })
            })
            .collect(),
        error: inner.error.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
                version: "0.2.0".into(),
                tabs: vec![],
                last_seen: Instant::now() - TTL,
            },
        );
        prune(&mut inner);
        assert!(inner.clients.is_empty());
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
                    version: "0.2.0".into(),
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
                    version: "0.2.0".into(),
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
                    version: "0.2.0".into(),
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
