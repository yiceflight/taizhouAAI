use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};

pub fn show_main_window(app: &AppHandle) {
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
        "打开 泰州市监测中心智能监测系统",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        "tray-quit",
        "退出 泰州市监测中心智能监测系统",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;
    let icon = app
        .default_window_icon()
        .ok_or("Application icon is missing")?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon.clone())
        .tooltip("泰州市监测中心智能监测系统 · 后台运行")
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
