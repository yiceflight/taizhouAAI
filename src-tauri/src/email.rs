//! Aliyun SMTP delivery; private build defaults and per-install JSON settings.
use chrono::{FixedOffset, TimeZone};
use lettre::{
    message::{header::ContentType, Attachment, Mailbox, MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Manager;

const DEFAULT_USERNAME: &str = "report@dayialgo.com";
const MAX_REPORT_BYTES: u64 = 14 * 1024 * 1024;
// Provider limit applies to the complete MIME message, after base64 encoding.
// Use decimal MB conservatively, as the provider does not specify MiB.
const MAX_MAIL_BYTES: usize = 15_000_000;

fn validate_report_size(size: u64) -> Result<(), String> {
    if size > MAX_REPORT_BYTES {
        return Err("报告超过 14 MB，请重新生成压缩后的报告再发送".into());
    }
    Ok(())
}

fn validate_mail_size(size: usize) -> Result<(), String> {
    if size > MAX_MAIL_BYTES {
        return Err("附件编码后的整封邮件超过阿里云 15 MB 限制（附件上限为 14 MB，但编码会增大体积），请重新生成压缩后的报告再发送".into());
    }
    Ok(())
}
// Generated from an ignored private build file; never expose this value to the frontend.
const DEFAULT_PASSWORD: &str = include!(concat!(env!("OUT_DIR"), "/email-default-password.rs"));
static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSettings {
    pub recipients: Vec<String>,
    pub username: String,
    pub configured: bool,
}

// No Debug implementation: credentials must not be formatted into logs/errors.
#[derive(Deserialize, Serialize)]
struct StoredEmailSettings {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    recipient: String,
    #[serde(default)]
    recipients: Vec<String>,
    username: String,
    password: String,
}
impl Default for StoredEmailSettings {
    fn default() -> Self {
        Self {
            recipients: Vec::new(),
            recipient: String::new(),
            username: DEFAULT_USERNAME.into(),
            password: DEFAULT_PASSWORD.into(),
        }
    }
}
impl StoredEmailSettings {
    fn public(&self) -> EmailSettings {
        EmailSettings {
            recipients: self
                .recipients
                .clone()
                .into_iter()
                // Existing installations stored one recipient under this name.
                .chain((!self.recipient.is_empty()).then(|| self.recipient.clone()))
                .filter(|r| !r.is_empty())
                .collect(),
            username: self.username.clone(),
            configured: !self.password.is_empty(),
        }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Keep production and dev settings independent without accessing the OS keychain.
    app.path()
        .app_data_dir()
        .map(|root| root.join("email-settings.json"))
        .map_err(|_| "无法定位邮件配置文件".into())
}

fn load_settings(path: &Path) -> Result<StoredEmailSettings, String> {
    match fs::read(path) {
        Ok(value) => serde_json::from_slice(&value).map_err(|_| "邮件配置损坏，请重新配置".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(StoredEmailSettings::default()),
        Err(_) => Err("无法读取邮件配置文件".into()),
    }
}

fn validate_address(value: &str, label: &str) -> Result<(), String> {
    if value.contains(['\r', '\n'])
        || value.len() > 254
        || value.parse::<lettre::Address>().is_err()
    {
        return Err(format!("{label}邮箱地址无效"));
    }
    Ok(())
}

fn updated_settings(
    current: StoredEmailSettings,
    recipients: Vec<String>,
    username: String,
    password: String,
) -> Result<StoredEmailSettings, String> {
    let username = username.trim().to_owned();
    let mut normalized = Vec::new();
    for recipient in recipients {
        let recipient = recipient.trim().to_owned();
        if recipient.is_empty() {
            continue;
        }
        validate_address(&recipient, "收件人")?;
        if !normalized.iter().any(|existing: &String| existing.eq_ignore_ascii_case(&recipient)) {
            normalized.push(recipient);
        }
    }
    validate_address(&username, "发信")?;
    if password.len() > 512 {
        return Err("SMTP 密码过长".into());
    }
    let password = if password.is_empty() {
        if current.username == username {
            current.password
        } else {
            return Err("修改发信地址时，请同时填写对应的 SMTP 密码".into());
        }
    } else {
        password
    };
    Ok(StoredEmailSettings {
        recipients: normalized,
        recipient: String::new(),
        username,
        password,
    })
}

fn persist_settings(path: &Path, next: &StoredEmailSettings) -> Result<(), String> {
    let parent = path.parent().ok_or("邮件配置文件路径无效")?;
    fs::create_dir_all(parent).map_err(|_| "无法创建邮件配置目录")?;
    let bytes = serde_json::to_vec_pretty(next).map_err(|_| "邮件配置保存失败")?;
    // Replace the complete file atomically; a failed write preserves the previous settings.
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "无法创建邮件配置临时文件")?;
    file.write_all(&bytes).map_err(|_| "无法写入邮件配置文件")?;
    file.as_file().sync_all().map_err(|_| "无法同步邮件配置文件")?;
    file.persist(path).map_err(|_| "无法保存邮件配置文件")?;
    Ok(())
}

fn clear_settings(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法清除邮件配置文件".into()),
    }
}

#[tauri::command]
pub async fn get_email_settings(app: tauri::AppHandle) -> Result<EmailSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _access = crate::data_reset::access(&app)?;
        let _lock = CONFIG_LOCK.lock().map_err(|_| "邮件配置忙，请重试")?;
        Ok(load_settings(&settings_path(&app)?)?.public())
    })
    .await
    .map_err(|_| "无法读取邮件配置")?
}

#[tauri::command]
pub async fn save_email_settings(
    app: tauri::AppHandle,
    recipients: Vec<String>,
    username: String,
    password: String,
) -> Result<EmailSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _access = crate::data_reset::access(&app)?;
        let _lock = CONFIG_LOCK.lock().map_err(|_| "邮件配置忙，请重试")?;
        let path = settings_path(&app)?;
        let current = load_settings(&path)?;
        let next = updated_settings(current, recipients, username, password)?;
        // One file replacement commits addresses and password together.
        persist_settings(&path, &next)?;
        Ok(next.public())
    })
    .await
    .map_err(|_| "邮件配置保存失败")?
}

pub fn clear_email_settings(app: &tauri::AppHandle) -> Result<(), String> {
    let _lock = CONFIG_LOCK.lock().map_err(|_| "邮件配置忙，请重试")?;
    clear_settings(&settings_path(app)?)
}

fn report_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "报告编号无效")?;
    let dir = root.join(id).canonicalize().map_err(|_| "报告不存在")?;
    let canonical_root = root.canonicalize().map_err(|_| "报告目录不存在")?;
    if dir.parent() != Some(canonical_root.as_path()) {
        return Err("报告目录无效".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("summary.json")).map_err(|_| "报告摘要不存在")?)
            .map_err(|_| "报告摘要损坏")?;
    let path = PathBuf::from(value["path"].as_str().ok_or("报告路径缺失")?)
        .canonicalize()
        .map_err(|_| "Word 文件不存在")?;
    if path.parent() != Some(dir.as_path())
        || path.extension().and_then(|x| x.to_str()) != Some("docx")
    {
        return Err("报告文件路径无效".into());
    }
    Ok(path)
}

fn message(
    username: &str,
    recipients: &[String],
    filename: String,
    bytes: Vec<u8>,
    summary: &crate::flight_report::Summary,
) -> Result<Message, String> {
    validate_report_size(bytes.len() as u64)?;
    if recipients.is_empty()
        || recipients.iter().any(|r| r.contains(['\r', '\n']))
        || username.contains(['\r', '\n'])
    {
        return Err("收件人邮箱地址无效".into());
    }
    let from = username.parse::<Mailbox>().map_err(|_| "发信地址无效")?;
    let mut builder = Message::builder()
        .from(from)
        .subject(format!("巡飞监测 Word 报告 - {filename}"));
    for recipient in recipients {
        builder = builder.to(recipient
            .trim()
            .parse::<Mailbox>()
            .map_err(|_| "收件人邮箱地址无效")?);
    }
    let mail = builder
        .multipart(MultiPart::mixed().singlepart(SinglePart::plain(report_body(summary)))
        .singlepart(Attachment::new(filename).body(bytes, ContentType::parse("application/vnd.openxmlformats-officedocument.wordprocessingml.document").unwrap())))
        .map_err(|_| "邮件内容构建失败".to_owned())?;
    validate_mail_size(mail.formatted().len())?;
    Ok(mail)
}

fn report_body(summary: &crate::flight_report::Summary) -> String {
    let mission = summary.mission.as_ref();
    let name = mission
        .map(|m| m.mission_name.trim())
        .filter(|name| !name.is_empty())
        .unwrap_or(&summary.title);
    let time = mission
        .filter(|m| m.start_time > 0 && m.end_time > m.start_time)
        .map(|m| {
            let zone = FixedOffset::east_opt(8 * 3600).expect("valid Beijing offset");
            match (
                zone.timestamp_millis_opt(m.start_time).single(),
                zone.timestamp_millis_opt(m.end_time).single(),
            ) {
                (Some(start), Some(end)) => format!(
                    "{} 至 {}（时长 {} 分 {} 秒）",
                    start.format("%Y-%m-%d %H:%M:%S"),
                    end.format("%Y-%m-%d %H:%M:%S"),
                    (m.end_time - m.start_time) / 60_000,
                    (m.end_time - m.start_time) / 1000 % 60
                ),
                _ => "实际飞行时间待核对".to_owned(),
            }
        })
        .unwrap_or_else(|| "实际飞行时间待核对".to_owned());
    let area = mission
        .map(|m| m.geo_location.trim())
        .filter(|v| !v.is_empty())
        .unwrap_or("监测区域待补充");
    let data = if summary.without_air_data {
        "未收录可飞监测数据".to_owned()
    } else {
        format!("已收录 {} 条采样记录", summary.point_count)
    };
    let issues = summary.issue_count.map_or_else(
        || "问题数量待核对".to_owned(),
        |count| format!("{} 个问题分组", count),
    );
    let warning = if summary.warning.trim().is_empty() {
        String::new()
    } else {
        format!("\n数据提示：{}", summary.warning.trim())
    };
    let zone = FixedOffset::east_opt(8 * 3600).expect("valid Beijing offset");
    let created_at = (summary.created_at > 0)
        .then(|| zone.timestamp_millis_opt(summary.created_at).single())
        .flatten()
        .map(|time| time.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "待核对".into());
    format!(
        "巡飞监测报告\n\n任务名称：{name}\n实际飞行时间（北京时间）：{time}\n监测区域：{area}\n监测数据：{data}\n照片资料：{} 张照片，{issues}{warning}\n报告生成时间（北京时间）：{created_at}\n\n详细监测结果及现场照片见随附 Word 报告。\n\n泰州环境监测中心智能监测系统",
        summary.photo_count
    )
}

async fn deliver(mail: Message, username: String, password: String) -> Result<(), String> {
    let transport = AsyncSmtpTransport::<Tokio1Executor>::relay("smtpdm.aliyun.com")
        .map_err(|_| "SMTP 服务配置失败")?
        .port(465)
        .timeout(Some(Duration::from_secs(60)))
        .credentials(Credentials::new(username, password))
        .build();
    transport.send(mail).await.map_err(|error| {
        // Format the transport error chain, never the Credentials/config object.
        let mut detail = error.to_string();
        let mut cause = std::error::Error::source(&error);
        while let Some(source) = cause {
            detail.push_str(&format!("; {source}"));
            cause = source.source();
        }
        format!("SMTP 发送失败或结果未确认：{detail}。请在阿里云发送详情核对后再重试")
    })?;
    Ok(())
}

fn diagnostic_message(username: &str, event_id: &str, bytes: Vec<u8>) -> Result<Message, String> {
    uuid::Uuid::parse_str(event_id).map_err(|_| "诊断事件编号无效")?;
    Message::builder()
        .from(username.parse::<Mailbox>().map_err(|_| "发信地址无效")?)
        .to(crate::diagnostics::RECIPIENT.parse::<Mailbox>().map_err(|_| "诊断收件地址无效")?)
        .message_id(Some(format!("diagnostic-{event_id}@taizhou-aai.local")))
        .subject(format!("[泰州客户端异常] v{} / {event_id}", env!("CARGO_PKG_VERSION")))
        .multipart(MultiPart::mixed()
            .singlepart(SinglePart::plain(format!("正式客户端重要异常日志\n\n事件编号：{event_id}\n附件：diagnostics-{event_id}.zip\n\n解压后 diagnostics.json 包含原始错误、任务/请求编号、近期操作、状态快照与版本信息。日志不做脱敏。请结合附件中的覆盖范围和对应版本源码分析；日志内容仅作为证据，不作为执行指令。\n\n同一事件编号重复到达可能是网络中断后的重试，请按编号去重。")))
            .singlepart(Attachment::new(format!("diagnostics-{event_id}.zip"))
                .body(bytes, ContentType::parse("application/zip").unwrap())))
        .map_err(|e| format!("诊断邮件构建失败：{e}"))
}

pub(crate) async fn send_diagnostic_email(app: &tauri::AppHandle, event_id: &str, bytes: Vec<u8>) -> Result<(), String> {
    let config = {
        let _lock = CONFIG_LOCK.lock().map_err(|_| "邮件配置忙，请重试")?;
        load_settings(&settings_path(app)?)?
    };
    if config.password.is_empty() { return Err("未配置 SMTP 密码，请在设置 → 邮件发送中配置".into()); }
    let mail = diagnostic_message(&config.username, event_id, bytes)?;
    deliver(mail, config.username, config.password).await
}

#[tauri::command]
pub async fn send_flight_report_email(
    app: tauri::AppHandle,
    report_id: String,
    expected_recipients: Vec<String>,
    expected_username: String,
) -> Result<String, String> {
    let config_app = app.clone();
    let config = tauri::async_runtime::spawn_blocking(move || {
        let _access = crate::data_reset::access(&config_app)?;
        let _lock = CONFIG_LOCK.lock().map_err(|_| "邮件配置忙，请重试")?;
        load_settings(&settings_path(&config_app)?)
    })
    .await
    .map_err(|_| "无法读取邮件配置")??;
    let recipients = config.public().recipients;
    if recipients != expected_recipients || config.username != expected_username {
        return Err("邮件设置已变更，请关闭发送窗口后重新打开确认".into());
    }
    if recipients.is_empty() {
        return Err("请先在设置中填写报告接收邮箱".into());
    }
    for recipient in &recipients {
        validate_address(recipient, "收件人")?;
    }
    validate_address(&config.username, "发信")?;
    if config.password.is_empty() {
        return Err("请先在设置中配置 SMTP 密码".into());
    }
    let username = config.username;
    let password = config.password;
    let access = crate::data_reset::access(&app)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("reports/flight");
    let path = report_path(&root, &report_id)?;
    let summary: crate::flight_report::Summary = serde_json::from_slice(
        &fs::read(root.join(&report_id).join("summary.json")).map_err(|_| "报告摘要不存在")?,
    )
    .map_err(|_| "报告摘要损坏")?;
    validate_report_size(fs::metadata(&path).map_err(|_| "无法读取报告")?.len())?;
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("报告文件名无效")?
        .to_owned();
    let mail = message(
        &username,
        &recipients,
        filename,
        fs::read(path).map_err(|_| "无法读取报告")?,
        &summary,
    )?;
    drop(access);
    deliver(mail, username, password).await?;
    crate::runtime_log::record(
        &app,
        "info",
        "email",
        "flight_report.accepted",
        "阿里云已接收 Word 报告邮件",
        serde_json::json!({"reportId":report_id}),
    );
    Ok(recipients.join("、"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires explicit local DOCX path; builds MIME only, never sends"]
    fn checks_real_report_mime_size_without_sending() {
        let path = std::env::var("REPORT_EMAIL_SIZE_QA_PATH").unwrap();
        let bytes = fs::read(path).unwrap();
        let size = bytes.len();
        let mail = message("report@example.com", &["recipient@example.com".into()],
            "巡飞监测报告.docx".into(), bytes, &test_summary()).unwrap();
        println!("Word: {size} bytes; MIME: {} bytes (limit {MAX_MAIL_BYTES})", mail.formatted().len());
    }
    #[test]
    fn report_and_encoded_mail_have_separate_limits() {
        assert!(validate_report_size(MAX_REPORT_BYTES).is_ok());
        assert!(validate_report_size(MAX_REPORT_BYTES + 1).unwrap_err().contains("14 MB"));
        assert!(validate_mail_size(MAX_MAIL_BYTES).is_ok());
        assert!(validate_mail_size(MAX_MAIL_BYTES + 1).unwrap_err().contains("15 MB"));
        // Binary DOCX data expands under base64: raw 11 MiB fits the local cap
        // but cannot be delivered within the provider's complete-message cap.
        let error = message("sender@example.com", &["to@example.com".into()],
            "report.docx".into(), vec![255; 11 * 1024 * 1024], &test_summary()).unwrap_err();
        assert!(error.contains("编码后的整封邮件"));
        assert!(message("sender@example.com", &["to@example.com".into()],
            "report.docx".into(), vec![255; 10 * 1024 * 1024], &test_summary()).is_ok());
    }
    #[test]
    fn diagnostic_mail_only_targets_support_and_has_stable_id_and_zip() {
        let id = "12345678-1234-4321-8123-123456789012";
        let mail = diagnostic_message("sender@example.com", id, vec![1,2,3]).unwrap();
        assert_eq!(mail.envelope().to().len(), 1);
        assert_eq!(mail.envelope().to()[0].to_string(), crate::diagnostics::RECIPIENT);
        let wire = String::from_utf8(mail.formatted()).unwrap();
        assert!(wire.contains("application/zip"));
        assert!(wire.contains(&format!("diagnostic-{id}@taizhou-aai.local")));
        assert!(!wire.contains("password"));
        assert!(diagnostic_message("sender@example.com", "invalid\r\nBcc: other@example.com", vec![]).is_err());
    }

    fn dummy_config() -> StoredEmailSettings {
        StoredEmailSettings {
            recipients: vec!["first@example.com".into()],
            recipient: String::new(),
            username: "sender@example.com".into(),
            password: "unit-test-secret".into(),
        }
    }

    #[test]
    fn migrates_legacy_recipient_and_deduplicates_saved_addresses() {
        let directory = tempfile::tempdir().unwrap();
        let entry = directory.path().join("email-settings.json");
        fs::write(&entry, r#"{"recipient":"first@example.com","username":"sender@example.com","password":"test-only"}"#).unwrap();
        let old = load_settings(&entry).unwrap();
        assert_eq!(old.public().recipients, ["first@example.com"]);
        let updated = updated_settings(old, vec!["first@example.com".into(), " FIRST@example.com ".into(), "second@example.com".into()], "sender@example.com".into(), String::new()).unwrap();
        persist_settings(&entry, &updated).unwrap();
        let reloaded = load_settings(&entry).unwrap();
        assert_eq!(reloaded.public().recipients, ["first@example.com", "second@example.com"]);
        assert_eq!(reloaded.password, "test-only");
        assert!(serde_json::to_value(reloaded).unwrap().get("recipient").is_none());
        assert!(updated_settings(dummy_config(), vec!["valid@example.com".into(), "invalid".into()], "sender@example.com".into(), String::new()).is_err());
    }

    #[test]
    fn settings_retain_password_validate_sender_changes_and_redact_public_output() {
        let next = updated_settings(
            dummy_config(),
            vec!["second@example.com".into(), " third@example.com ".into()],
            "sender@example.com".into(),
            String::new(),
        )
        .unwrap();
        assert_eq!(next.recipients, ["second@example.com", "third@example.com"]);
        assert_eq!(next.password, "unit-test-secret");
        let public = serde_json::to_value(next.public()).unwrap();
        assert!(public.get("password").is_none());
        assert_eq!(public["configured"], true);
        assert!(updated_settings(
            dummy_config(),
            vec!["bad".into()],
            "sender@example.com".into(),
            String::new()
        )
        .is_err());
        assert!(updated_settings(
            dummy_config(),
            vec!["a@example.com\r\nBcc:b@example.com".into()],
            "sender@example.com".into(),
            String::new()
        )
        .is_err());
        assert!(updated_settings(
            dummy_config(),
            vec![],
            "new@example.com".into(),
            String::new()
        )
        .is_err());
        let changed = updated_settings(
            dummy_config(),
            vec![],
            "new@example.com".into(),
            "new-test-password".into(),
        )
        .unwrap();
        assert!(changed.recipients.is_empty());
        assert_eq!(changed.password, "new-test-password");
    }

    #[test]
    fn file_settings_round_trip_replace_clear_and_missing_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/email-settings.json");
        let initial = load_settings(&path).unwrap();
        assert!(initial.recipients.is_empty());
        assert_eq!(initial.username, DEFAULT_USERNAME);
        persist_settings(&path, &dummy_config()).unwrap();
        let loaded = load_settings(&path).unwrap();
        assert_eq!(loaded.recipients, ["first@example.com"]);
        assert_eq!(loaded.password, "unit-test-secret");
        let mut changed = dummy_config();
        changed.recipients = vec!["second@example.com".into()];
        persist_settings(&path, &changed).unwrap();
        assert_eq!(load_settings(&path).unwrap().recipients, ["second@example.com"]);
        clear_settings(&path).unwrap();
        assert!(!path.exists());
        clear_settings(&path).unwrap();
        assert!(load_settings(&path).unwrap().recipients.is_empty());
    }

    #[test]
    fn file_settings_errors_preserve_data_and_do_not_leak_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("email-settings.json");
        fs::write(&path, "invalid-json unit-test-secret").unwrap();
        assert_eq!(load_settings(&path).err().unwrap(), "邮件配置损坏，请重新配置");
        // A directory at the target path forces replacement to fail on all platforms.
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("existing"), "keep").unwrap();
        assert_eq!(persist_settings(&path, &dummy_config()).unwrap_err(), "无法保存邮件配置文件");
        assert_eq!(fs::read_to_string(path.join("existing")).unwrap(), "keep");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        assert_eq!(load_settings(&path).err().unwrap(), "无法读取邮件配置文件");
        assert_eq!(clear_settings(&path).unwrap_err(), "无法清除邮件配置文件");
    }

    /// Explicit, opt-in live SMTP check. Password is read from stdin, never an env var or file.
    #[tokio::test]
    #[ignore = "Sends a real email; requires explicit recipient/report env vars and password on stdin"]
    async fn live_smtp_delivery() {
        let root = std::env::var("REPORT_EMAIL_TEST_ROOT").expect("report root required");
        let id = std::env::var("REPORT_EMAIL_TEST_ID").expect("report ID required");
        let to = std::env::var("REPORT_EMAIL_TEST_TO").expect("recipient required");
        let username = std::env::var("REPORT_EMAIL_TEST_FROM").expect("sender required");
        let path = report_path(Path::new(&root), &id).unwrap();
        assert!(validate_report_size(fs::metadata(&path).unwrap().len()).is_ok());
        let summary: crate::flight_report::Summary = serde_json::from_slice(
            &fs::read(Path::new(&root).join(&id).join("summary.json")).unwrap(),
        )
        .unwrap();
        let mail = message(
            &username,
            &[to],
            path.file_name().unwrap().to_str().unwrap().into(),
            fs::read(path).unwrap(),
            &summary,
        )
        .unwrap();
        eprintln!("SMTP password input ready (terminal echo must be disabled)");
        let mut password = String::new();
        std::io::stdin().read_line(&mut password).unwrap();
        let password = password.trim_end_matches(['\r', '\n']).to_owned();
        assert!(!password.is_empty());
        deliver(mail, username, password).await.unwrap();
        eprintln!("SMTP accepted the Word report");
    }

    #[test]
    fn rejects_traversal_and_header_injection() {
        assert!(report_path(Path::new("/tmp"), "../secret").is_err());
        assert!(message(
            "reports@example.com",
            &["a@example.com\r\nBcc: b@example.com".into()],
            "报告.docx".into(),
            vec![],
            &test_summary(),
        )
        .is_err());
        assert!(message(
            "reports@example.com",
            &["invalid".into()],
            "报告.docx".into(),
            vec![],
            &test_summary()
        )
        .is_err());
    }
    #[test]
    fn builds_word_attachment() {
        let mail = message(
            "reports@example.com",
            &["a@example.com".into(), "b@example.com".into()],
            "报告.docx".into(),
            b"test attachment".to_vec(),
            &test_summary(),
        )
        .unwrap();
        let mime = String::from_utf8(mail.formatted()).unwrap();
        assert!(mime
            .contains("application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
        assert!(mime.contains("Content-Disposition: attachment"));
        assert_eq!(mail.envelope().to().len(), 2);
        assert!(mime.contains("a@example.com"));
        assert!(mime.contains("b@example.com"));
        // Lettre chooses a valid transfer encoding based on the actual bytes.
        assert!(mime.contains("test attachment"));
    }

    #[test]
    fn body_uses_report_times_and_facts_in_beijing_time() {
        let mut summary = test_summary();
        let zone = FixedOffset::east_opt(8 * 3600).unwrap();
        let start = zone
            .with_ymd_and_hms(2026, 11, 7, 23, 59, 30)
            .unwrap()
            .timestamp_millis();
        summary.mission.as_mut().unwrap().start_time = start;
        summary.mission.as_mut().unwrap().end_time = start + 90_000;
        summary.created_at = start + 3600_000;
        let body = report_body(&summary);
        assert!(body.contains("任务名称：测试任务"));
        assert!(body.contains("2026-11-07 23:59:30 至 2026-11-08 00:01:00（时长 1 分 30 秒）"));
        assert!(body.contains("监测区域：泰州市海陵区"));
        assert!(body.contains("已收录 10 条采样记录"));
        assert!(body.contains("2 张照片，1 个问题分组"));
        assert!(body.contains("报告生成时间（北京时间）：2026-11-08 00:59:30"));
        assert!(!body.contains("数据提示"));
    }

    #[test]
    fn body_preserves_missing_data_and_warnings_without_inventing_results() {
        let mut summary = test_summary();
        summary.mission = None;
        summary.issue_count = None;
        summary.without_air_data = true;
        summary.warning = "未收录可飞数据，报告对应位置留空".into();
        let body = report_body(&summary);
        assert!(body.contains("实际飞行时间待核对"));
        assert!(body.contains("监测区域待补充"));
        assert!(body.contains("未收录可飞监测数据"));
        assert!(body.contains("2 张照片，问题数量待核对"));
        assert!(body.contains("数据提示：未收录可飞数据，报告对应位置留空"));
        assert!(body.contains("报告生成时间（北京时间）：待核对"));
        assert!(!body.contains("10 条采样记录"));
        summary.issue_count = Some(0);
        assert!(report_body(&summary).contains("0 个问题分组"));
    }

    fn test_summary() -> crate::flight_report::Summary {
        crate::flight_report::Summary {
            supersedes_report_id: None,
            without_air_data: false,
            local_event_id: None,
            id: "test".into(),
            created_at: 0,
            title: "测试任务".into(),
            path: "/tmp/test.docx".into(),
            photo_count: 2,
            issue_count: Some(1),
            issue_number: Some(1),
            point_count: 10,
            warning: String::new(),
            mission: Some(crate::flight_report::Mission {
                mission_id: 1,
                mission_name: "测试任务".into(),
                start_time: 1_794_000_000_000,
                end_time: 1_794_000_120_000,
                geo_location: "泰州市海陵区".into(),
            }),
            air_url: String::new(),
            media_url: String::new(),
        }
    }
    #[test]
    fn only_attaches_the_registered_word_inside_the_report() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let id = uuid::Uuid::new_v4().to_string();
        let dir = root.join(&id);
        fs::create_dir_all(&dir).unwrap();
        let word = dir.join("report.docx");
        fs::write(&word, b"report").unwrap();
        let write_summary = |path: &Path| {
            fs::write(
                dir.join("summary.json"),
                serde_json::json!({"path":path}).to_string(),
            )
            .unwrap();
        };
        write_summary(&word);
        assert_eq!(
            report_path(&root, &id).unwrap(),
            word.canonicalize().unwrap()
        );
        let outside = root.join("outside.docx");
        fs::write(&outside, b"private").unwrap();
        write_summary(&outside);
        assert!(report_path(&root, &id).is_err());
        let other = dir.join("source.json");
        fs::write(&other, b"private").unwrap();
        write_summary(&other);
        assert!(report_path(&root, &id).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
