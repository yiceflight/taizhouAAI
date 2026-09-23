use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};

fn application_icon(_app: &App) -> Result<Image<'static>, Box<dyn std::error::Error>> {
    #[cfg(dev)]
    {
        return Ok(Image::from_bytes(include_bytes!("../icons/dev/icon.png"))?);
    }

    #[cfg(not(dev))]
    {
        _app.default_window_icon()
            .cloned()
            .map(Image::to_owned)
            .ok_or_else(|| "Application icon is missing".into())
    }
}

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
    let icon = application_icon(app)?;

    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(icon.clone())?;
    }

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
