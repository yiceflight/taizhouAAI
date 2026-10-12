use std::process::Command;
use tauri::Manager;

#[cfg(target_os = "windows")]
use std::path::PathBuf;

fn open_in_chrome(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        for app in ["Google Chrome", "Google Chrome Canary", "Chromium"] {
            let result = Command::new("open").args(["-a", app, "--", url]).status();
            if result.is_ok_and(|status| status.success()) {
                return Ok(());
            }
        }
        return Err("未找到 Google Chrome 或 Chromium。".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let mut candidates = Vec::new();
        for variable in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Ok(root) = std::env::var(variable) {
                candidates.push(PathBuf::from(root).join("Google/Chrome/Application/chrome.exe"));
            }
        }
        for candidate in candidates {
            if candidate.exists() && Command::new(&candidate).arg(url).spawn().is_ok() {
                return Ok(());
            }
        }
        for executable in ["chrome.exe", "chrome"] {
            if Command::new(executable).arg(url).spawn().is_ok() {
                return Ok(());
            }
        }
        return Err("未找到 Chrome，请确认已安装 Google Chrome。".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        for executable in [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ] {
            if Command::new(executable).arg(url).spawn().is_ok() {
                return Ok(());
            }
        }
        return Err("未找到 Chrome 或 Chromium。".to_string());
    }

    #[allow(unreachable_code)]
    Err("当前系统暂不支持自动打开 Chrome 扩展管理页。".to_string())
}

#[tauri::command]
fn open_chrome_extensions() -> Result<(), String> {
    open_in_chrome("chrome://extensions")
}
#[tauri::command]
fn open_business_site(url: String) -> Result<(), String> {
    if !bridge::allowed_url(&url) {
        return Err("不支持的业务网站。".into());
    }
    open_in_chrome(&url)
}

#[tauri::command]
async fn open_airins_realtime(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let bridge = app.state::<bridge::Bridge>();
    let snapshot = bridge.status();
    let session = snapshot
        .tabs
        .iter()
        .find(|tab| tab.tab.url.starts_with("https://aai.airins.cn/sniff"))
        .map(|tab| (tab.session.clone(), tab.tab.id));
    let (session, tab_id) = match session {
        Some(target) => target,
        None => (bridge.single_session()?, -1),
    };
    bridge.request(session, tab_id, serde_json::json!({"type":"airins-realtime"})).await
}

#[cfg(all(dev, target_os = "macos"))]
fn set_dev_app_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let marker = unsafe { MainThreadMarker::new_unchecked() };
    let application = NSApplication::sharedApplication(marker);
    let data = NSData::with_bytes(include_bytes!("../icons/dev/icon.icns"));
    if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { application.setApplicationIconImage(Some(&icon)); }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(bridge::Bridge::default())
        .manage(monitoring::Monitor::default())
        .manage(flight::Flight::default())
        .manage(readiness::Readiness::default())
        .manage(weather::Weather::default())
        .setup(|app| {
            use tauri::Manager;
            app.state::<bridge::Bridge>().start(app.handle().clone());
            readiness::start(app.handle().clone());
            flight::initialize(app.handle()).map_err(std::io::Error::other)?;
            monitoring::start(app.handle().clone());
            weather::start(app.handle().clone());
            flight::start(app.handle().clone());
            window_lifecycle::setup_tray(app)
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Keep the webview and background work alive. Explicit quit and
                    // updater restarts still use the normal application exit path.
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("Could not hide main window: {error}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_chrome_extensions,
            open_business_site,
            open_airins_realtime,
            extension::get_extension_directory,
            extension::open_extension_directory,
            bridge::get_bridge_status,
            readiness::get_readiness,
            readiness::check_readiness,
            readiness::start_workspace,
            monitoring::get_monitoring,
            weather::refresh_weather,
            settings::save_workspace_settings,
            flight::set_flight_enabled,
            flight::set_flight_delay,
            flight::cancel_flight,
            flight::launch_flight,
            flight::refresh_flight_status,
            flight::prepare_flight,
            flight::dismiss_flight,
            flight::resolve_flight,
            flight::clear_task_list,
            flight::open_prepared_flight,
            monitoring::sync_monitoring,
            monitoring::set_monitoring_enabled,
            reports::generate_report,
            flight_report::list_flight_missions,
            flight_report::list_flight_reasons,
            flight_report::set_flight_reason,
            flight_weather::list_flight_weather,
            flight_weather::enrich_flight_weather,
            flight_report::collect_flight_report,
            flight_report::save_flight_report,
            flight_report::list_flight_reports,
            flight_report::open_flight_report,
            flight_report::open_flight_report_directory,
            reports::list_reports,
            reports::open_report,
            reports::open_reports_directory,
            updates::check_update_channel
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(all(dev, target_os = "macos"))]
            if let tauri::RunEvent::Ready = &_event {
                set_dev_app_icon();
            }

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                window_lifecycle::show_main_window(_app);
            }
        });
}
mod extension;
mod window_lifecycle;

mod bridge;
mod reports;
mod updates;

mod monitoring;
mod settings;
mod flight_weather;

mod flight;

mod flight_report;

mod readiness;

mod weather;
