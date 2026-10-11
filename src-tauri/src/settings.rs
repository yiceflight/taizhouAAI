use crate::monitoring::{database, put, setting};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use chrono::Timelike;
use tauri::Manager;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoFlyPeriod { pub start: String, pub end: String }
fn default_no_fly_periods() -> Vec<NoFlyPeriod> {
    vec![NoFlyPeriod { start: "05:00".into(), end: "08:00".into() }]
}
fn minute(value: &str) -> Result<u32, String> {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' || ![bytes[0],bytes[1],bytes[3],bytes[4]].iter().all(u8::is_ascii_digit) {
        return Err("禁飞时间须为 HH:mm 格式。".into());
    }
    let hour = u32::from(bytes[0]-b'0')*10 + u32::from(bytes[1]-b'0');
    let min = u32::from(bytes[3]-b'0')*10 + u32::from(bytes[4]-b'0');
    if hour > 23 || min > 59 { return Err("禁飞时间须在 00:00 至 23:59 之间。".into()); }
    Ok(hour*60 + min)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub potassium_threshold: f64,
    pub pm25_threshold: f64,
    pub takeoff_delay_minutes: u32,
    pub require_manual_confirmation: bool,
    #[serde(default = "default_no_fly_periods")]
    pub no_fly_periods: Vec<NoFlyPeriod>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            potassium_threshold: 1.0,
            pm25_threshold: 60.0,
            takeoff_delay_minutes: 5,
            require_manual_confirmation: true,
            no_fly_periods: default_no_fly_periods(),
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
        if self.no_fly_periods.len() > 24 { return Err("最多可配置 24 段禁飞时间。".into()); }
        for period in &self.no_fly_periods {
            if minute(&period.start)? == minute(&period.end)? { return Err("禁飞开始与结束时间不能相同。".into()); }
        }
        Ok(())
    }
    // Daily Beijing time intervals include the start and exclude the end.
    pub fn no_fly_reason(&self, at: chrono::NaiveDateTime) -> Option<String> {
        let now = at.hour()*60 + at.minute();
        self.no_fly_periods.iter().find(|p| {
            let (Ok(start), Ok(end)) = (minute(&p.start), minute(&p.end)) else { return false; };
            if start < end { now >= start && now < end } else { now >= start || now < end }
        }).map(|p| format!("禁飞时间：{}–{}（北京时间），超标仅记录，不执行起飞。", p.start, p.end))
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
    let state = app.state::<crate::flight::Flight>();
    let _gate = state.gate.lock().unwrap();
    save_and_reconcile(&database(&app)?, &settings, crate::monitoring::now())
}
pub(crate) fn save_and_reconcile(db: &Connection, settings: &Settings, at: chrono::NaiveDateTime) -> Result<(), String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    save(&tx, settings)?;
    crate::flight::reconcile_restriction(&tx, settings, at)?;
    tx.commit().map_err(|e| e.to_string())
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
            no_fly_periods: vec![NoFlyPeriod { start: "05:00".into(), end: "08:00".into() }, NoFlyPeriod { start: "23:00".into(), end: "01:30".into() }],
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
    #[test]
    fn legacy_settings_default_to_morning_period_but_explicit_empty_disables_it() {
        let db = crate::monitoring::connect(std::path::Path::new(":memory:")).unwrap();
        put(&db, "workspace_settings", r#"{"potassiumThreshold":1,"pm25Threshold":60,"takeoffDelayMinutes":5,"requireManualConfirmation":false}"#).unwrap();
        assert_eq!(read(&db).unwrap().no_fly_periods, default_no_fly_periods());
        let mut s = read(&db).unwrap(); s.no_fly_periods.clear(); save(&db, &s).unwrap();
        assert!(read(&db).unwrap().no_fly_periods.is_empty());
    }
    #[test]
    fn periods_support_multiple_ranges_midnight_and_exact_boundaries() {
        let mut s = Settings::default();
        s.no_fly_periods.push(NoFlyPeriod { start: "23:00".into(), end: "01:30".into() });
        for (time, blocked) in [("04:59:59",false),("05:00:00",true),("07:59:59",true),("08:00:00",false),("22:59:59",false),("23:00:00",true),("00:00:00",true),("01:29:59",true),("01:30:00",false)] {
            assert_eq!(s.no_fly_reason(chrono::NaiveDateTime::parse_from_str(&format!("2026-10-09 {time}"), "%Y-%m-%d %H:%M:%S").unwrap()).is_some(), blocked, "{time}");
        }
        for (start,end) in [("5:00","08:00"),("24:00","08:00"),("05:60","08:00"),("05:00","05:00"),("xx:00","08:00")] {
            s.no_fly_periods = vec![NoFlyPeriod { start: start.into(), end: end.into() }];
            assert!(s.validate().is_err());
        }
    }
}
