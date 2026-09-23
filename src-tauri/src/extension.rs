use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[derive(serde::Serialize)]
pub struct ExtensionDirectory {
    path: String,
    platform: &'static str,
}

fn extension_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Tauri's dev flag also distinguishes a packaged debug build from tauri dev.
    // Join native paths instead of constructing platform-specific path strings in JS.
    let directory = if tauri::is_dev() {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("无法定位项目目录。")?
            .join("extension-dev")
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| format!("无法定位客户端资源目录：{error}"))?
            .join("extension")
    };
    if !directory.is_absolute() || !directory.join("manifest.json").is_file() {
        return Err("未找到完整的 Chrome 插件目录，请重新安装客户端。".into());
    }
    // Resolve symlinks and normalize separators, keeping ordinary Windows paths
    // usable in Chrome's folder picker (without a verbatim \\?\ prefix).
    dunce::canonicalize(directory).map_err(|error| format!("无法读取插件目录：{error}"))
}

#[tauri::command]
pub fn get_extension_directory(app: tauri::AppHandle) -> Result<ExtensionDirectory, String> {
    let directory = extension_directory(&app)?;
    Ok(ExtensionDirectory {
        path: directory
            .to_str()
            .ok_or("插件目录包含无法显示的字符。")?
            .to_owned(),
        platform: std::env::consts::OS,
    })
}

#[tauri::command]
pub fn open_extension_directory(app: tauri::AppHandle) -> Result<(), String> {
    let directory = extension_directory(&app)?;
    let parent = directory.parent().ok_or("无法定位插件的上一级目录。")?;
    app.opener()
        .open_path(
            parent.to_str().ok_or("插件目录包含无法显示的字符。")?,
            None::<&str>,
        )
        .map_err(|error| format!("无法打开插件的上一级目录：{error}"))
}
