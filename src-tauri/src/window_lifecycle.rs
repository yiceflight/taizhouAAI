use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};

fn application_icon(_app: &App) -> Result<Image<'static>, Box<dyn std::error::Error>> {
    #[cfg(test_environment)]
    {
        return Ok(Image::from_bytes(include_bytes!("../icons/dev/icon.png"))?);
    }

    #[cfg(not(test_environment))]
    {
        _app.default_window_icon()
            .cloned()
            .map(Image::to_owned)
            .ok_or_else(|| "Application icon is missing".into())
    }
}

pub fn show_main_window(app: &AppHandle) {
    crate::runtime_log::record(
        app,
        "info",
        "window",
        "window.show_requested",
        "请求恢复主窗口",
        serde_json::json!({}),
    );
    if let Some(window) = app.get_webview_window("main") {
        let result = window
            .unminimize()
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus());
        if let Err(error) = result {
            eprintln!("Could not restore main window: {error}");
        }
    }
}

pub fn setup_tray(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(
        app,
        "tray-show",
        if crate::environment::IS_TEST {
            "打开 测试版智能监测系统"
        } else {
            "打开 江苏省泰州环境监测中心智能监测系统"
        },
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        "tray-quit",
        if crate::environment::IS_TEST {
            "退出 测试版智能监测系统"
        } else {
            "退出 江苏省泰州环境监测中心智能监测系统"
        },
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;
    let icon = application_icon(app)?;

    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(icon.clone())?;
    }

    TrayIconBuilder::with_id("main-tray")
        .icon(icon.clone())
        .tooltip(if crate::environment::IS_TEST {
            "测试版智能监测系统 · 后台运行"
        } else {
            "江苏省泰州环境监测中心智能监测系统 · 后台运行"
        })
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => show_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
