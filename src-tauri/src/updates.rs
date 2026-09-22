#[tauri::command]
pub async fn check_update_channel() -> Result<(), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).map_err(|_| "更新配置无效")?;
    let endpoint = config["plugins"]["updater"]["endpoints"][0]
        .as_str()
        .ok_or("尚未配置更新服务")?;
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "无法初始化更新连接")?
        .head(endpoint)
        .send()
        .await
        .map_err(|_| "无法连接更新服务器，请检查网络后重试")?;
    match response.status().as_u16() {
        200..=299 => Ok(()),
        403 => Err("更新服务不可用（403）：清单尚未发布或无权访问".into()),
        404 => Err("更新清单尚未发布（404）".into()),
        code => Err(format!("更新服务器返回 HTTP {code}")),
    }
}
