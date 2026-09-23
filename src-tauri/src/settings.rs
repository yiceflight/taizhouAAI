use crate::monitoring::{database, put, setting};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub potassium_threshold: f64,
    pub pm25_threshold: f64,
    pub takeoff_delay_minutes: u32,
    pub require_manual_confirmation: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            potassium_threshold: 1.0,
            pm25_threshold: 60.0,
            takeoff_delay_minutes: 5,
            require_manual_confirmation: true,
        }
    }
}

impl Settings {
    fn validate(&self) -> Result<(), String> {
        if !self.potassium_threshold.is_finite() || self.potassium_threshold <= 0.0 {
            return Err("钾离子阈值必须是大于 0 的有效数值。".into());
        }
        if !self.pm25_threshold.is_finite() || self.pm25_threshold <= 0.0 {
            return Err("PM2.5 报告阈值必须是大于 0 的有效数值。".into());
        }
        if self.takeoff_delay_minutes > 1440 {
            return Err("起飞延迟须为 0 至 1440 之间的整数分钟。".into());
        }
        Ok(())
    }
}

pub fn read(db: &Connection) -> Result<Settings, String> {
    let settings: Settings = match setting(db, "workspace_settings")? {
        Some(value) => {
            serde_json::from_str(&value).map_err(|_| "设置读取失败，请检查本机配置。")?
        }
        None => Settings::default(),
    };
    settings.validate()?;
    Ok(settings)
}

fn save(db: &Connection, settings: &Settings) -> Result<(), String> {
    settings.validate()?;
    put(
        db,
        "workspace_settings",
        &serde_json::to_string(settings).map_err(|e| e.to_string())?,
    )
}

pub fn set_delay(db: &Connection, minutes: u32) -> Result<(), String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut settings = read(&tx)?;
    settings.takeoff_delay_minutes = minutes;
    save(&tx, &settings)?;
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_workspace_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    save(&database(&app)?, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_saved_settings_survive_reopening() {
        let path = std::env::temp_dir().join(format!("settings-{}.sqlite3", uuid::Uuid::new_v4()));
        let db = crate::monitoring::connect(&path).unwrap();
        assert_eq!(read(&db).unwrap(), Settings::default());
        let settings = Settings {
            potassium_threshold: 1.6,
            pm25_threshold: 80.0,
            takeoff_delay_minutes: 15,
            require_manual_confirmation: false,
        };
        save(&db, &settings).unwrap();
        drop(db);
        let db = crate::monitoring::connect(&path).unwrap();
        assert_eq!(read(&db).unwrap(), settings);
        for invalid in [
            Settings {
                potassium_threshold: 0.0,
                ..settings.clone()
            },
            Settings {
                potassium_threshold: f64::NAN,
                ..settings.clone()
            },
            Settings {
                pm25_threshold: -1.0,
                ..settings.clone()
            },
            Settings {
                pm25_threshold: f64::INFINITY,
                ..settings.clone()
            },
            Settings {
                takeoff_delay_minutes: 1441,
                ..settings.clone()
            },
        ] {
            assert!(save(&db, &invalid).is_err());
            assert_eq!(read(&db).unwrap(), settings);
        }
        set_delay(&db, 30).unwrap();
        assert_eq!(
            read(&db).unwrap(),
            Settings {
                takeoff_delay_minutes: 30,
                ..settings
            }
        );
        assert!(set_delay(&db, 1441).is_err());
        assert_eq!(read(&db).unwrap().takeoff_delay_minutes, 30);
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
}
