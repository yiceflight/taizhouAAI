pub const IS_TEST: bool = cfg!(test_environment);
pub const TEST_IDENTIFIER: &str = "com.taizhou.aai.dev";
pub const CHANNEL: &str = if IS_TEST { "dev" } else { "production" };
pub const TEST_NAME: &str = "江苏省泰州环境监测中心智能监测系统 · 测试版";

// Also protect direct `tauri dev` invocations that omit the config overlay.
pub fn configure<R: tauri::Runtime>(context: &mut tauri::Context<R>) {
    configure_config(context.config_mut());
    if IS_TEST {
        context.package_info_mut().name = TEST_NAME.into();
    }
}

fn configure_config(config: &mut tauri::Config) {
    if IS_TEST {
        config.identifier = TEST_IDENTIFIER.into();
        config.product_name = Some(TEST_NAME.into());
        config.plugins.0.remove("updater");
        for window in &mut config.app.windows {
            window.title = TEST_NAME.into();
        }
    }
}

#[tauri::command]
pub fn is_test_environment() -> bool {
    IS_TEST
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_context_is_isolated_before_app_paths_and_webviews_are_created() {
        let mut config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let original = config.clone();
        configure_config(&mut config);
        if IS_TEST {
            assert_eq!(config.identifier, TEST_IDENTIFIER);
            assert!(config.app.windows.iter().all(|w| w.title == TEST_NAME));
            assert!(!config.plugins.0.contains_key("updater"));
        } else {
            assert_eq!(config.identifier, original.identifier);
            assert_eq!(config.plugins.0, original.plugins.0);
        }
    }
}
