use crate::bridge::{Bridge, BridgeStatus, ADDRESS, ORIGIN};
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    id: &'static str,
    label: &'static str,
    state: &'static str,
    detail: String,
    suggestion: &'static str,
}
impl Check {
    fn new(
        id: &'static str,
        label: &'static str,
        state: &'static str,
        detail: impl Into<String>,
        suggestion: &'static str,
    ) -> Self {
        Self {
            id,
            label,
            state,
            detail: detail.into(),
            suggestion,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    checked_at: String,
    app_version: String,
    platform: &'static str,
    channel: &'static str,
    address: &'static str,
    extension_id: &'static str,
    minimum_extension_version: &'static str,
    checks: Vec<Check>,
}

async fn probe(address: &str, origin: &str, instance_id: &str) -> Vec<Check> {
    let failure = match tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect(address),
    )
    .await
    {
        Ok(Ok(stream)) => {
            drop(stream);
            None
        }
        Ok(Err(error)) => Some(format!("无法连接 {address}：{error}")),
        Err(_) => Some(format!("连接 {address} 超时（2 秒）")),
    };
    if let Some(detail) = failure {
        return vec![
            Check::new("tcp", "本机端口", "fail", detail, "请查看下方客户端服务错误；若服务已启动，请检查安全软件的拦截记录。连接失败本身不能确定是防火墙导致。"),
            Check::new("service", "当前客户端服务", "skipped", "端口不通，未验证服务身份", "处理端口问题后重新诊断。"),
        ];
    }
    let tcp = Check::new(
        "tcp",
        "本机端口",
        "pass",
        format!("{address} TCP 连接成功"),
        "",
    );
    let response = async {
        // Local-only check, independent of system proxies and without redirects.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|e| format!("无法创建诊断请求：{e}"))?;
        let response = client
            .post(format!("http://{address}/diagnose"))
            .header("Origin", origin)
            .header("X-Taizhou-Bridge", "1")
            .send()
            .await
            .map_err(|e| format!("本机服务请求失败：{e}"))?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(format!(
                "端口可达，但服务返回 HTTP {}，未确认属于当前客户端",
                response.status()
            ));
        }
        // Only a small identity receipt is expected; never retain arbitrary server data.
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("服务回执读取失败：{e}"))?
        {
            if bytes.len() + chunk.len() > 1024 {
                return Err("端口可达，但服务回执格式不匹配".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| "端口可达，但服务回执格式不匹配".to_string())?;
        if value["instanceId"].as_str() != Some(instance_id) {
            return Err("端口可达，但回应的不是当前客户端实例".into());
        }
        Ok(())
    }
    .await;
    let service = match response {
        Ok(()) => Check::new("service", "当前客户端服务", "pass", "当前 App 的本机服务回应正常，身份核对通过", ""),
        Err(error) => Check::new("service", "当前客户端服务", "fail", error, "检查是否有旧版或重复客户端、其他程序占用端口；退出确认重复的客户端后，再重启需要使用的 App。"),
    };
    vec![tcp, service]
}

fn plugin_check(snapshot: &BridgeStatus, fresh_heartbeat: bool) -> Check {
    if !fresh_heartbeat || !snapshot.connected {
        return Check::new("plugin", "浏览器插件心跳", "warning", "本次诊断等待 35 秒，未收到新的插件心跳；历史心跳不作为通过依据，无法据此判断插件是否已安装", "若已删除插件，请重新安装；否则打开 Chrome 扩展管理页，确认插件已启用、ID 与下方一致，并检查插件错误和 Service Worker。App 内的端口检测不能证明 Chrome 到 App 的请求未被拦截。");
    }
    if snapshot
        .versions
        .iter()
        .any(|v| !crate::readiness::compatible(v))
    {
        return Check::new("plugin", "浏览器插件心跳", "fail", format!("已连接版本：{}；最低要求：{}", snapshot.versions.join("、"), crate::readiness::MIN_VERSION), "在 Chrome 扩展管理页重新加载当前 App 提供的插件；仍为旧版本时，按安装指引重新选择目录。");
    }
    if snapshot.clients != 1 {
        return Check::new(
            "plugin",
            "浏览器插件心跳",
            "fail",
            format!("检测到 {} 个插件会话", snapshot.clients),
            "只保留一个当前 Chrome 中的桥接插件会话；关闭多余会话后，等待约 75 秒再诊断。",
        );
    }
    Check::new(
        "plugin",
        "浏览器插件心跳",
        "pass",
        format!(
            "本次诊断开始后收到插件 v{} 的新心跳；网站登录状态请查看网站验证",
            snapshot.versions.join("、")
        ),
        "",
    )
}

#[tauri::command]
pub async fn diagnose_bridge(app: tauri::AppHandle) -> Diagnostics {
    let started = Instant::now();
    let bridge = app.state::<Bridge>().inner().clone();
    let mut checks = probe(ADDRESS, ORIGIN, &bridge.instance_id()).await;
    // The extension polls every 5 seconds, with a 30-second alarm fallback.
    // A cached 75-second lease cannot establish presence after an uninstall.
    let fresh_heartbeat = bridge
        .wait_for_heartbeat(started, Duration::from_secs(35))
        .await;
    let snapshot = bridge.status();
    if let Some(error) = &snapshot.error {
        checks.push(Check::new(
            "listener",
            "客户端服务错误",
            "fail",
            error,
            "根据系统错误处理端口占用或访问权限后，重启当前客户端；重新诊断不会自动重启服务。",
        ));
    }
    let directory = crate::extension::extension_directory(&app).and_then(|path| {
        for file in ["src/service-worker.js", "src/bridge-config.js"] {
            std::fs::File::open(path.join(file))
                .map_err(|error| format!("插件文件 {file} 无法读取：{error}"))?;
        }
        Ok(path)
    });
    checks.insert(0, match directory {
        Ok(path) => Check::new("files", "随 App 附带的插件目录", "pass", format!("目录和入口文件可读取：{}", path.display()), "此项不能确认 Chrome 实际加载的是这个目录。"),
        Err(error) => Check::new("files", "随 App 附带的插件目录", "fail", error, "检查安装目录是否被移动、删除或被安全软件隔离；必要时重新安装客户端，再按指引加载插件。"),
    });
    checks.push(plugin_check(&snapshot, fresh_heartbeat));
    Diagnostics {
        checked_at: chrono::Utc::now().to_rfc3339(),
        app_version: app.package_info().version.to_string(),
        platform: std::env::consts::OS,
        channel: if crate::environment::IS_TEST {
            "开发版"
        } else {
            "正式版"
        },
        address: ADDRESS,
        extension_id: ORIGIN.trim_start_matches("chrome-extension://"),
        minimum_extension_version: crate::readiness::MIN_VERSION,
        checks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::HeaderMap, routing::post, Json, Router};
    use serde_json::json;

    #[test]
    fn probes_real_sockets_and_rejects_wrong_services_without_following_redirects() {
        tauri::async_runtime::block_on(async {
            let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let closed_address = closed.local_addr().unwrap().to_string();
            drop(closed);
            let result = probe(&closed_address, ORIGIN, "current").await;
            assert_eq!(result[0].state, "fail");
            assert_eq!(result[1].state, "skipped");

            for (case, expected) in [
                ("current", "pass"),
                ("other", "fail"),
                ("invalid", "fail"),
                ("redirect", "fail"),
                ("forbidden", "fail"),
                ("timeout", "fail"),
            ] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap().to_string();
                let router = Router::new().route(
                    "/diagnose",
                    post(move |headers: HeaderMap| async move {
                        use axum::response::IntoResponse;
                        assert_eq!(headers["origin"], ORIGIN);
                        assert_eq!(headers["x-taizhou-bridge"], "1");
                        match case {
                            "invalid" => "not json".into_response(),
                            "redirect" => {
                                axum::response::Redirect::temporary("/unexpected").into_response()
                            }
                            "forbidden" => axum::http::StatusCode::FORBIDDEN.into_response(),
                            "timeout" => {
                                tokio::time::sleep(Duration::from_secs(5)).await;
                                Json(json!({"instanceId":"current"})).into_response()
                            }
                            _ => Json(json!({"instanceId":case})).into_response(),
                        }
                    }),
                );
                let server = tokio::spawn(async move {
                    axum::serve(listener, router).await.unwrap();
                });
                let result = probe(&address, ORIGIN, "current").await;
                server.abort();
                assert_eq!(result[0].state, "pass", "{case}");
                assert_eq!(result[1].state, expected, "{case}");
            }
        });
    }

    #[test]
    fn heartbeat_checks_do_not_equate_missing_with_uninstalled_or_tcp_with_ready() {
        let mut snapshot = BridgeStatus {
            connected: false,
            clients: 0,
            versions: vec![],
            tabs: vec![],
            error: None,
        };
        let check = plugin_check(&snapshot, false);
        assert_eq!(check.state, "warning");
        assert!(check.detail.contains("无法据此判断插件是否已安装"));
        snapshot.connected = true;
        snapshot.clients = 1;
        snapshot.versions = vec!["0.1.0".into()];
        assert_eq!(plugin_check(&snapshot, true).state, "fail");
        snapshot.versions = vec![crate::readiness::MIN_VERSION.into()];
        assert_eq!(plugin_check(&snapshot, true).state, "pass");
        assert_eq!(
            plugin_check(&snapshot, false).state,
            "warning",
            "a cached lease is not a fresh heartbeat"
        );
        snapshot.clients = 2;
        assert_eq!(plugin_check(&snapshot, true).state, "fail");
    }
}
