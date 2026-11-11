use std::process::Command;
use tauri::Manager;

mod data_reset;
mod diagnostics;

#[cfg(target_os = "windows")]
use std::path::PathBuf;

fn open_in_chrome(url: &str) -> Result<(), String> {
    open_default_chrome(url)
}

fn open_default_chrome(url: &str) -> Result<(), String> {
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

async fn refresh_after_resume(app: tauri::AppHandle) {
    runtime_log::record(
        &app,
        "info",
        "app",
        "app.resume_checks_started",
        "系统恢复后立即检查天气和运行状态",
        serde_json::json!({}),
    );

    // Refresh weather first so any monitoring sync that follows cannot make a
    // launch decision from the stale pre-lock receipt.
    weather::refresh(&app, true).await;
    let readiness_result = readiness::refresh(&app).await;
    if let Err(error) = &readiness_result {
        runtime_log::record(
            &app,
            "warning",
            "readiness",
            "resume.check_failed",
            "系统恢复后的运行状态检查失败",
            serde_json::json!({"error":error}),
        );
    }

    if readiness_result.is_ok() {
        if let Err(error) = monitoring::resume_sync(&app).await {
            runtime_log::record(
                &app,
                "warning",
                "monitoring",
                "resume.sync_failed",
                "系统恢复后的监测同步失败",
                serde_json::json!({"error":error}),
            );
        }
    }

    let weather_view = weather::view(&app);
    runtime_log::record(
        &app,
        "info",
        "app",
        "app.resume_checks_finished",
        "系统恢复后的检查完成",
        serde_json::json!({
            "weather": serde_json::to_value(weather_view).unwrap_or(serde_json::Value::Null),
            "ready": readiness::view(&app).ready,
        }),
    );
}

#[tauri::command]
fn open_chrome_extensions() -> Result<(), String> {
    open_in_chrome("chrome://extensions")
}
#[tauri::command]
async fn open_business_site(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !bridge::allowed_url(&url) {
        return Err("不支持的业务网站。".into());
    }
    let bridge = app.state::<bridge::Bridge>();
    let session = bridge.single_session()?;
    bridge
        .request(session, -1, serde_json::json!({"type":"open-business-site", "url":url}))
        .await?;
    Ok(())
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
    bridge
        .request(
            session,
            tab_id,
            serde_json::json!({"type":"airins-realtime"}),
        )
        .await
}

#[cfg(all(test_environment, target_os = "macos"))]
fn set_dev_app_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let marker = unsafe { MainThreadMarker::new_unchecked() };
    let application = NSApplication::sharedApplication(marker);
    let data = NSData::with_bytes(include_bytes!("../icons/dev/icon.icns"));
    if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe {
            application.setApplicationIconImage(Some(&icon));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    let _background_activity = background_activity::BackgroundActivity::begin();
    let mut context = tauri::generate_context!();
    environment::configure(&mut context);
    let mut builder = tauri::Builder::default();
    // Must be registered first. A second launch (e.g. double-clicking the desktop
    // icon while the app is hidden in the tray) restores the running window
    // instead of starting another process that cannot bind the bridge port.
    // The plugin keys on the app identifier, so test and release builds stay isolated.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window_lifecycle::show_main_window(app);
        }));
    }
    if !environment::IS_TEST {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .manage(runtime_log::RuntimeLog::default())
        .manage(bridge::Bridge::default())
        .manage(data_reset::DataAccess::default())
        .manage(monitoring::Monitor::default())
        .manage(flight::Flight::default())
        .manage(readiness::Readiness::default())
        .manage(weather::Weather::default())
        .setup(|app| {
            use tauri::Manager;
            runtime_log::start(app.handle());
            diagnostics::start(app.handle());
            runtime_log::record(
                app.handle(),
                "info",
                "app",
                "app.background_policy",
                "后台监测策略已启用",
                serde_json::json!({
                    "nativeScheduling": true,
                    "appNapDisabled": cfg!(target_os = "macos"),
                    "preventsSystemSleep": false,
                }),
            );
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
                    runtime_log::record(
                        window.app_handle(),
                        "info",
                        "window",
                        "window.hide_requested",
                        "关闭窗口，转入托盘后台运行",
                        serde_json::json!({}),
                    );
                    if let Err(error) = window.hide() {
                        eprintln!("Could not hide main window: {error}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            environment::is_test_environment,
            runtime_log::get_runtime_logs,
            diagnostics::record_frontend_error,
            diagnostics::report_diagnostics,
            runtime_log::export_runtime_logs,
            runtime_log::open_runtime_log_exports,
            open_chrome_extensions,
            open_business_site,
            open_airins_realtime,
            extension::get_extension_directory,
            extension::open_extension_directory,
            bridge::get_bridge_status,
            bridge_diagnostics::diagnose_bridge,
            readiness::get_readiness,
            readiness::check_readiness,
            readiness::start_workspace,
            monitoring::get_monitoring,
            weather::refresh_weather,
            settings::save_workspace_settings,
            flight::sync_flight_routes,
            flight::set_flight_route,
            flight::cancel_flight,
            flight::launch_flight,
            flight::refresh_flight_status,
            flight::prepare_flight,
            flight::resolve_flight,
            flight::clear_task_list,
            data_reset::clear_all_data,
            flight::open_prepared_flight,
            monitoring::sync_monitoring,
            monitoring::set_monitoring_enabled,
            reports::generate_report,
            flight_report::list_flight_missions,
            flight_report::list_dji_report_tasks,
            flight_report::sync_dji_report_tasks,
            flight_report::collect_flight_report,
            flight_report::save_flight_report,
            flight_report::list_flight_reports,
            flight_report::open_flight_report,
            flight_report::open_flight_report_directory,
            reports::list_reports,
            reports::open_report,
            reports::open_reports_directory,
            email::send_flight_report_email,
            email::get_email_settings,
            email::save_email_settings,
            updates::check_update_channel
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|_app, _event| {
            if matches!(&_event, tauri::RunEvent::Exit) {
                runtime_log::record(
                    _app,
                    "info",
                    "app",
                    "app.exit",
                    "客户端正常退出",
                    serde_json::json!({}),
                );
            }
            #[cfg(all(test_environment, target_os = "macos"))]
            if let tauri::RunEvent::Ready = &_event {
                set_dev_app_icon();
            }

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                window_lifecycle::show_main_window(_app);
            }

            if let tauri::RunEvent::Resumed = &_event {
                let app = _app.clone();
                tauri::async_runtime::spawn(refresh_after_resume(app));
            }
        });
}
mod extension;
mod window_lifecycle;
mod background_activity;

mod bridge;
mod bridge_diagnostics;
mod reports;
mod updates;
mod email;

mod monitoring;
mod settings;

mod flight;

mod flight_report;

mod readiness;

mod weather;

mod runtime_log;

mod environment;
